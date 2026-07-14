import { MAX_BUILT_IN_WEB_SEARCH_CALLS, MAX_PROVIDER_TOOL_RESULT_BYTES, loadConfig } from "@continuum/config";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  OpenAiResponsesProvider,
  ProviderFactory,
  boundProviderToolOutput,
  cachedInputTokensFromUsage,
  providerMessagesToResponseInput,
  responseToolPolicy
} from "./index.js";
import { MacKeychain } from "./keychain.js";

describe("provider credential boundary", () => {
  const key = "sk-evaluation_override_fake_key_123456789";
  const unavailableKeychain = () => new MacKeychain(async () => ({ stdout: "", stderr: "not found", code: 44 }));

  it("uses Keychain only for the normal application even when the legacy env name is present", async () => {
    const config = loadConfig({
      NODE_ENV: "production",
      CONTINUUM_OPENAI_API_KEY: key
    });
    const factory = new ProviderFactory(config, { keychain: unavailableKeychain() });
    expect(await factory.hasOpenAiKey()).toBe(false);
    await expect(factory.create()).rejects.toMatchObject({ name: "ProviderNotConfiguredError" });
  });

  it("accepts an explicit in-memory override only for a live test evaluation runtime", async () => {
    const evaluation = loadConfig({ NODE_ENV: "test", CONTINUUM_LIVE_TESTS: "true" });
    const factory = new ProviderFactory(evaluation, {
      keychain: unavailableKeychain(),
      ephemeralEvaluationApiKey: key
    });
    expect(await factory.hasOpenAiKey()).toBe(true);
    expect(await factory.create()).toBeInstanceOf(OpenAiResponsesProvider);

    const application = loadConfig({ NODE_ENV: "production", CONTINUUM_LIVE_TESTS: "true" });
    expect(() => new ProviderFactory(application, { ephemeralEvaluationApiKey: key })).toThrow("only be supplied to a live evaluation runtime");
  });
});

describe("provider image inputs", () => {
  it("sends current user images as stateless data URLs and never attaches them to assistant history", () => {
    const input = providerMessagesToResponseInput([
      { role: "user", content: "What is in this?", images: [{ mediaType: "image/png", base64: "YWJj", detail: "high" }] },
      { role: "assistant", content: "Earlier answer", images: [{ mediaType: "image/jpeg", base64: "ZGVm" }] }
    ]);
    expect(input[0]).toMatchObject({
      role: "user",
      content: [
        { type: "input_text", text: "What is in this?" },
        { type: "input_image", detail: "high", image_url: "data:image/png;base64,YWJj" }
      ]
    });
    expect(input[1]).toEqual({ role: "assistant", content: "Earlier answer" });
  });
});

describe("bounded provider execution", () => {
  it("offers built-in web search only on the first request and clamps every tool bound", () => {
    const request = {
      enableWebSearch: true,
      maximumWebSearchCalls: 99,
      customTools: [{ name: "memory_search", description: "Search", parameters: {} }],
      executeTool: async () => "ok",
      maximumToolRounds: 99
    };
    expect(responseToolPolicy(request, 0)).toEqual({ offerWebSearch: true, maximumWebSearchCalls: MAX_BUILT_IN_WEB_SEARCH_CALLS, offerCustomTools: true });
    expect(responseToolPolicy(request, 1)).toEqual({ offerWebSearch: false, maximumWebSearchCalls: MAX_BUILT_IN_WEB_SEARCH_CALLS, offerCustomTools: true });
    expect(responseToolPolicy(request, 3)).toEqual({ offerWebSearch: false, maximumWebSearchCalls: MAX_BUILT_IN_WEB_SEARCH_CALLS, offerCustomTools: false });
  });

  it("enforces the local-tool result byte ceiling again at the provider boundary", () => {
    const output = "🧠".repeat(MAX_PROVIDER_TOOL_RESULT_BYTES);
    const bounded = boundProviderToolOutput(output);
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(MAX_PROVIDER_TOOL_RESULT_BYTES);
    expect(bounded).toContain("tool result truncated");
    expect(boundProviderToolOutput("small result")).toBe("small result");
  });

  it("extracts cached input usage safely for accumulation across continuation calls", () => {
    const calls = [
      { input_tokens_details: { cached_tokens: 120 } },
      { input_tokens_details: { cached_tokens: 80 } },
      undefined
    ];
    expect(calls.reduce((total, usage) => total + cachedInputTokensFromUsage(usage), 0)).toBe(200);
    expect(cachedInputTokensFromUsage({ input_tokens_details: { cached_tokens: -1 } })).toBe(0);
  });

  it("accumulates cached input usage across every local-tool continuation", async () => {
    const completedEvent = (id: string, inputTokens: number, cachedTokens: number, outputTokens: number, output: unknown[]) => {
      const event = {
        type: "response.completed",
        sequence_number: 0,
        response: {
          id,
          object: "response",
          created_at: 0,
          status: "completed",
          error: null,
          incomplete_details: null,
          instructions: null,
          max_output_tokens: 10,
          model: "gpt-5.6-luna",
          output,
          parallel_tool_calls: false,
          previous_response_id: null,
          reasoning: { effort: "low", summary: null },
          store: false,
          temperature: null,
          text: { format: { type: "text" }, verbosity: "medium" },
          tool_choice: "auto",
          tools: [],
          top_p: null,
          truncation: "disabled",
          usage: {
            input_tokens: inputTokens,
            input_tokens_details: { cached_tokens: cachedTokens },
            output_tokens: outputTokens,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: inputTokens + outputTokens
          },
          user: null,
          metadata: {}
        }
      };
      return new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    };
    const responses = [
      completedEvent("response-1", 100, 40, 10, [{ type: "function_call", call_id: "call-1", name: "memory_search", arguments: "{}" }]),
      completedEvent("response-2", 150, 90, 20, [])
    ];
    let requests = 0;
    const fakeFetch = (async () => responses[requests++]!) as typeof fetch;
    const provider = new OpenAiResponsesProvider("sk-test-not-a-real-key", "text-embedding-3-small", { fetch: fakeFetch });
    const events = [];
    for await (const event of provider.streamResponse({
      model: "gpt-5.6-luna",
      instructions: "Answer.",
      messages: [{ role: "user", content: "remember this" }],
      memoryContext: "",
      maxOutputTokens: 10,
      reasoningEffort: "low",
      customTools: [{ name: "memory_search", description: "Search memory", parameters: { type: "object" } }],
      executeTool: async () => "bounded result",
      maximumToolRounds: 3
    })) events.push(event);
    expect(requests).toBe(2);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      responseId: "response-2",
      inputTokens: 250,
      cachedInputTokens: 130,
      outputTokens: 30,
      webSearchCalls: 0,
      estimatedCostUsd: 0.000_343
    });
  });

  it("fails unknown models before making a network request on every provider method", async () => {
    let requests = 0;
    const fakeFetch = (async () => {
      requests += 1;
      return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const provider = new OpenAiResponsesProvider("sk-test-not-a-real-key", "text-embedding-3-small", { fetch: fakeFetch });

    await expect(provider.embed(["hello"], "unknown-embedding")).rejects.toMatchObject({ code: "UNKNOWN_MODEL_PRICING" });
    await expect(provider.generateStructured({
      model: "unknown-response",
      instructions: "Return JSON.",
      input: "hello",
      schemaName: "test",
      schema: z.object({ ok: z.boolean() }),
      jsonSchema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } }, required: ["ok"] }
    })).rejects.toMatchObject({ code: "UNKNOWN_MODEL_PRICING" });
    const streamEvents = [];
    for await (const event of provider.streamResponse({
      model: "unknown-response",
      instructions: "Answer.",
      messages: [{ role: "user", content: "hello" }],
      memoryContext: "",
      maxOutputTokens: 10,
      reasoningEffort: "low"
    })) streamEvents.push(event);
    expect(streamEvents).toEqual([expect.objectContaining({ type: "failed", code: "UNKNOWN_MODEL_PRICING", retryable: false })]);
    expect(requests).toBe(0);
  });

  it("disables SDK retries and sends bounded default-tier web-search parameters", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ error: { message: "temporary", type: "server_error", code: "server_error" } }), {
        status: 500,
        headers: { "content-type": "application/json", "x-request-id": "request-test" }
      });
    }) as typeof fetch;
    const provider = new OpenAiResponsesProvider("sk-test-not-a-real-key", "text-embedding-3-small", { fetch: fakeFetch, timeoutMs: 5_000 });
    const events = [];
    for await (const event of provider.streamResponse({
      model: "gpt-5.6-luna",
      instructions: "Answer.",
      messages: [{ role: "user", content: "latest news" }],
      memoryContext: "",
      maxOutputTokens: 10,
      reasoningEffort: "low",
      enableWebSearch: true,
      maximumWebSearchCalls: 99
    })) events.push(event);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      service_tier: "default",
      parallel_tool_calls: false,
      max_tool_calls: MAX_BUILT_IN_WEB_SEARCH_CALLS,
      store: false,
      stream: true,
      tools: [{ type: "web_search", search_context_size: "low" }]
    });
    expect(events.at(-1)).toMatchObject({ type: "failed", retryable: true });
  });

  it("does not retry a failed embedding request", async () => {
    let requests = 0;
    const fakeFetch = (async () => {
      requests += 1;
      return new Response(JSON.stringify({ error: { message: "temporary", type: "server_error", code: "server_error" } }), {
        status: 500,
        headers: { "content-type": "application/json", "x-request-id": "request-test" }
      });
    }) as typeof fetch;
    const provider = new OpenAiResponsesProvider("sk-test-not-a-real-key", "text-embedding-3-small", { fetch: fakeFetch });
    await expect(provider.embed(["hello"], "text-embedding-3-small")).rejects.toBeDefined();
    expect(requests).toBe(1);
  });
});
