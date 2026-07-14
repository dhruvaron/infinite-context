import OpenAI from "openai";
import type { QualityPreset } from "@continuum/contracts";
import type { AppConfig } from "@continuum/config";
import {
  MAX_BUILT_IN_WEB_SEARCH_CALLS,
  MAX_PROVIDER_TOOL_RESULT_BYTES,
  UnknownModelPricingError,
  assertKnownEmbeddingModel,
  assertKnownResponseModel,
  estimateCostUsd
} from "@continuum/config";
import type { z } from "zod";
import { MacKeychain, isRecognizedOpenAiApiKey } from "./keychain.js";

export type ProviderImage = {
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  base64: string;
  detail?: "low" | "high" | "auto";
};

export type ProviderMessage = {
  role: "user" | "assistant";
  content: string;
  /** Images are accepted only on user messages and are never retained by OpenAI. */
  images?: readonly ProviderImage[];
};

export interface ProviderToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderToolCall {
  callId: string;
  name: string;
  arguments: unknown;
}

export interface ResponseRequest {
  model: string;
  instructions: string;
  messages: ProviderMessage[];
  memoryContext: string;
  maxOutputTokens: number;
  reasoningEffort: "low" | "medium" | "high";
  enableWebSearch?: boolean;
  maximumWebSearchCalls?: number;
  customTools?: readonly ProviderToolDefinition[];
  executeTool?: (call: ProviderToolCall) => Promise<string>;
  maximumToolRounds?: number;
  signal?: AbortSignal;
}

export type ProviderStreamEvent =
  | { type: "delta"; delta: string }
  | { type: "web-search"; status: "started" | "complete" }
  | { type: "web-citation"; title: string; url: string; startIndex: number | null; endIndex: number | null }
  | { type: "completed"; responseId: string | null; inputTokens: number; cachedInputTokens: number; outputTokens: number; estimatedCostUsd: number; webSearchCalls: number }
  | { type: "failed"; code: string; message: string; retryable: boolean };

export interface StructuredRequest<T> {
  model: string;
  instructions: string;
  input: string;
  schemaName: string;
  schema: z.ZodType<T>;
  jsonSchema: Record<string, unknown>;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface StructuredResult<T> {
  value: T;
  responseId: string | null;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

export interface EmbeddingResult {
  vectors: number[][];
  model: string;
  inputTokens: number;
  estimatedCostUsd: number;
}

export interface ModelProvider {
  readonly name: string;
  streamResponse(request: ResponseRequest): AsyncGenerator<ProviderStreamEvent>;
  generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>;
  embed(inputs: string[], model?: string, signal?: AbortSignal): Promise<EmbeddingResult>;
  validateConnection(): Promise<boolean>;
}

function normalizeProviderError(error: unknown): ProviderStreamEvent & { type: "failed" } {
  if (error instanceof UnknownModelPricingError) {
    return { type: "failed", code: error.code, message: error.message, retryable: false };
  }
  if (error instanceof OpenAI.APIError) {
    return {
      type: "failed",
      code: error.code ?? `OPENAI_${error.status ?? "ERROR"}`,
      message: error.status === 401 ? "The OpenAI API key was rejected." : error.status === 429 ? "OpenAI is temporarily rate limiting requests." : "OpenAI could not complete the request.",
      retryable: error.status === 408 || error.status === 409 || error.status === 429 || (error.status ?? 0) >= 500
    };
  }
  if (error instanceof Error && error.name === "AbortError") return { type: "failed", code: "CANCELLED", message: "The response was stopped.", retryable: false };
  return { type: "failed", code: "PROVIDER_ERROR", message: "The model provider could not complete the request.", retryable: true };
}

export function providerMessagesToResponseInput(messages: readonly ProviderMessage[]): OpenAI.Responses.ResponseInput {
  return messages.map((message) => {
    const images = message.role === "user" ? (message.images ?? []) : [];
    if (images.length === 0) return { role: message.role, content: message.content };
    const content: OpenAI.Responses.ResponseInputMessageContentList = [
      ...(message.content ? [{ type: "input_text" as const, text: message.content }] : []),
      ...images.map((image) => ({
        type: "input_image" as const,
        detail: image.detail ?? "auto",
        image_url: `data:${image.mediaType};base64,${image.base64}`
      }))
    ];
    return { role: message.role, content };
  }) as OpenAI.Responses.ResponseInput;
}

export function responseToolPolicy(request: Pick<ResponseRequest, "enableWebSearch" | "maximumWebSearchCalls" | "customTools" | "executeTool" | "maximumToolRounds">, completedToolRounds: number): {
  offerWebSearch: boolean;
  maximumWebSearchCalls: number;
  offerCustomTools: boolean;
} {
  const maximumToolRounds = Math.max(0, Math.min(3, request.maximumToolRounds ?? 3));
  const requestedWebCalls = Math.max(0, Math.floor(request.maximumWebSearchCalls ?? MAX_BUILT_IN_WEB_SEARCH_CALLS));
  const maximumWebSearchCalls = Math.min(MAX_BUILT_IN_WEB_SEARCH_CALLS, requestedWebCalls);
  return {
    // A web lookup is offered only on the first provider request. Continuation
    // requests are reserved for bounded local-memory tool results.
    offerWebSearch: completedToolRounds === 0 && Boolean(request.enableWebSearch) && maximumWebSearchCalls > 0,
    maximumWebSearchCalls,
    offerCustomTools: completedToolRounds < maximumToolRounds && Boolean(request.executeTool) && (request.customTools?.length ?? 0) > 0
  };
}

export function boundProviderToolOutput(output: string): string {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(output);
  if (encoded.byteLength <= MAX_PROVIDER_TOOL_RESULT_BYTES) return output;
  const suffix = "\n...[tool result truncated at provider boundary]";
  const suffixBytes = encoder.encode(suffix).byteLength;
  // Leave room for a possible Unicode replacement sequence when the byte cut
  // lands inside a multi-byte code point.
  const prefixBytes = encoded.slice(0, Math.max(0, MAX_PROVIDER_TOOL_RESULT_BYTES - suffixBytes - 8));
  return new TextDecoder("utf-8", { fatal: false }).decode(prefixBytes) + suffix;
}

export function cachedInputTokensFromUsage(usage: { input_tokens_details?: { cached_tokens?: number } | null } | null | undefined): number {
  const value = usage?.input_tokens_details?.cached_tokens ?? 0;
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export interface OpenAiResponsesProviderOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export class OpenAiResponsesProvider implements ModelProvider {
  readonly name = "openai";
  readonly #client: OpenAI;
  readonly #embeddingModel: string;

  constructor(apiKey: string, embeddingModel: string, options: OpenAiResponsesProviderOptions = {}) {
    // A timed-out generation may already have been accepted and billed. The
    // durable reservation is conservatively charged on ambiguity, while SDK
    // retries are disabled so one application call cannot create extra charges.
    this.#client = new OpenAI({
      apiKey,
      maxRetries: 0,
      timeout: options.timeoutMs ?? 120_000,
      ...(options.fetch ? { fetch: options.fetch } : {})
    });
    this.#embeddingModel = embeddingModel;
  }

  async *streamResponse(request: ResponseRequest): AsyncGenerator<ProviderStreamEvent> {
    try {
      assertKnownResponseModel(request.model);
      let input = providerMessagesToResponseInput(request.messages);
      const instructions = request.memoryContext
        ? `${request.instructions}\n\n<continuum_memory_context>\n${request.memoryContext}\n</continuum_memory_context>`
        : request.instructions;
      let completedToolRounds = 0;
      let totalInputTokens = 0;
      let totalCachedInputTokens = 0;
      let totalOutputTokens = 0;
      let totalEstimatedCostUsd = 0;
      let totalWebSearchCalls = 0;
      let finalResponseId: string | null = null;
      while (true) {
        const policy = responseToolPolicy(request, completedToolRounds);
        const tools: OpenAI.Responses.Tool[] = [
          ...(policy.offerWebSearch ? [{ type: "web_search" as const, search_context_size: "low" as const }] : []),
          ...(policy.offerCustomTools ? (request.customTools ?? []).map((tool) => ({
            type: "function" as const,
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            strict: false
          })) : [])
        ];
        const body = {
          model: request.model,
          instructions,
          input,
          max_output_tokens: request.maxOutputTokens,
          reasoning: { effort: request.reasoningEffort },
          service_tier: "default" as const,
          parallel_tool_calls: false,
          store: false,
          stream: true,
          ...(policy.offerCustomTools ? { include: ["reasoning.encrypted_content" as const] } : {}),
          // Supported by the current Responses API. The installed SDK predates
          // this field, but forwards documented additional request properties.
          ...(policy.offerWebSearch ? { max_tool_calls: policy.maximumWebSearchCalls } : {}),
          ...(tools.length ? { tools } : {})
        } as OpenAI.Responses.ResponseCreateParamsStreaming & { max_tool_calls?: number };
        const stream = await this.#client.responses.create(body, { signal: request.signal });
        let completedResponse: OpenAI.Responses.Response | null = null;
        for await (const event of stream) {
          if (event.type === "response.output_text.delta") {
            yield { type: "delta", delta: event.delta };
          } else if (event.type === "response.web_search_call.in_progress") {
            yield { type: "web-search", status: "started" };
          } else if (event.type === "response.web_search_call.completed") {
            yield { type: "web-search", status: "complete" };
          } else if (event.type === "response.output_text.annotation.added") {
            const annotation = event.annotation as { type?: unknown; title?: unknown; url?: unknown; start_index?: unknown; end_index?: unknown };
            if (annotation.type === "url_citation" && typeof annotation.url === "string") {
              yield {
                type: "web-citation",
                title: typeof annotation.title === "string" ? annotation.title : annotation.url,
                url: annotation.url,
                startIndex: typeof annotation.start_index === "number" ? annotation.start_index : null,
                endIndex: typeof annotation.end_index === "number" ? annotation.end_index : null
              };
            }
          } else if (event.type === "response.output_item.done") {
            const item = event.item as unknown as { type?: unknown; action?: { sources?: Array<{ url?: unknown }> } };
            if (item.type === "web_search_call") {
              for (const source of item.action?.sources ?? []) {
                if (typeof source.url === "string") yield { type: "web-citation", title: source.url, url: source.url, startIndex: null, endIndex: null };
              }
            }
          } else if (event.type === "response.completed") {
            completedResponse = event.response;
          } else if (event.type === "error") {
            yield { type: "failed", code: event.code ?? "OPENAI_STREAM_ERROR", message: "OpenAI interrupted the response stream.", retryable: true };
            return;
          }
        }
        if (!completedResponse) {
          yield { type: "failed", code: "INCOMPLETE_PROVIDER_STREAM", message: "OpenAI ended the stream without a completed response.", retryable: true };
          return;
        }
        finalResponseId = completedResponse.id;
        const inputTokens = completedResponse.usage?.input_tokens ?? 0;
        const outputTokens = completedResponse.usage?.output_tokens ?? 0;
        const cachedInputTokens = cachedInputTokensFromUsage(completedResponse.usage);
        totalInputTokens += inputTokens;
        totalCachedInputTokens += cachedInputTokens;
        totalOutputTokens += outputTokens;
        totalEstimatedCostUsd += estimateCostUsd(request.model, inputTokens, outputTokens, {
          cachedInputTokens,
          includeCacheWritePremium: true
        });
        totalWebSearchCalls += completedResponse.output.filter((item) => item.type === "web_search_call").length;
        const calls = completedResponse.output.filter((item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === "function_call");
        if (!policy.offerCustomTools || calls.length === 0 || !request.executeTool) {
          yield { type: "completed", responseId: finalResponseId, inputTokens: totalInputTokens, cachedInputTokens: totalCachedInputTokens, outputTokens: totalOutputTokens, estimatedCostUsd: totalEstimatedCostUsd, webSearchCalls: totalWebSearchCalls };
          return;
        }
        const outputs: Array<{ type: "function_call_output"; call_id: string; output: string }> = [];
        for (const [callIndex, call] of calls.entries()) {
          let parsedArguments: unknown;
          try { parsedArguments = JSON.parse(call.arguments); }
          catch { parsedArguments = {}; }
          let output: string;
          if (callIndex > 0) {
            output = JSON.stringify({ error: { code: "TOOL_ROUND_LIMIT", message: "Only one local tool call is allowed per response round." } });
          } else {
            try { output = await request.executeTool({ callId: call.call_id, name: call.name, arguments: parsedArguments }); }
            catch (error) { output = JSON.stringify({ error: { code: "TOOL_FAILED", message: error instanceof Error ? error.message : "The local tool failed." } }); }
          }
          outputs.push({ type: "function_call_output", call_id: call.call_id, output: boundProviderToolOutput(output) });
        }
        completedToolRounds += 1;
        input = [...input, ...completedResponse.output, ...outputs] as OpenAI.Responses.ResponseInput;
      }
    } catch (error) {
      yield normalizeProviderError(error);
    }
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    assertKnownResponseModel(request.model);
    const response = await this.#client.responses.create({
      model: request.model,
      instructions: request.instructions,
      input: request.input,
      max_output_tokens: request.maxOutputTokens ?? 4_000,
      service_tier: "default",
      store: false,
      text: {
        format: {
          type: "json_schema",
          name: request.schemaName,
          strict: true,
          schema: request.jsonSchema
        }
      }
    }, { signal: request.signal });
    const value = request.schema.parse(JSON.parse(response.output_text));
    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    const cachedInputTokens = cachedInputTokensFromUsage(response.usage);
    return {
      value,
      responseId: response.id,
      inputTokens,
      outputTokens,
      estimatedCostUsd: estimateCostUsd(request.model, inputTokens, outputTokens, { cachedInputTokens, includeCacheWritePremium: true })
    };
  }

  async embed(inputs: string[], model = this.#embeddingModel, signal?: AbortSignal): Promise<EmbeddingResult> {
    assertKnownEmbeddingModel(model);
    if (inputs.length === 0) return { vectors: [], model, inputTokens: 0, estimatedCostUsd: 0 };
    const response = await this.#client.embeddings.create({ model, input: inputs, encoding_format: "float" }, { signal });
    const inputTokens = response.usage.prompt_tokens;
    return {
      vectors: response.data.sort((a, b) => a.index - b.index).map((item) => item.embedding),
      model,
      inputTokens,
      estimatedCostUsd: estimateCostUsd(model, inputTokens, 0)
    };
  }

  async validateConnection(): Promise<boolean> {
    await this.#client.models.list({ query: { limit: 1 } });
    return true;
  }
}

export class MockProvider implements ModelProvider {
  readonly name = "mock";

  async *streamResponse(request: ResponseRequest): AsyncGenerator<ProviderStreamEvent> {
    const last = request.messages.at(-1)?.content ?? "";
    const memorySignal = request.memoryContext ? " I checked the relevant local memory and kept the supporting evidence linked." : " There was no older memory selected for this turn.";
    const answer = `This is Continuum’s local test response to: “${last.slice(0, 180)}”.${memorySignal}`;
    for (const token of answer.match(/.{1,18}/g) ?? [answer]) {
      if (request.signal?.aborted) {
        yield { type: "failed", code: "CANCELLED", message: "The response was stopped.", retryable: false };
        return;
      }
      yield { type: "delta", delta: token };
    }
    const inputTokens = Math.ceil((last.length + request.memoryContext.length) / 4);
    const outputTokens = Math.ceil(answer.length / 4);
    yield { type: "completed", responseId: "mock-response", inputTokens, cachedInputTokens: 0, outputTokens, estimatedCostUsd: 0, webSearchCalls: 0 };
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const value = request.schema.parse({ topics: [], claims: [], relations: [] });
    return { value, responseId: "mock-structured", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  }

  async embed(inputs: string[], model = "mock-embedding-v1", signal?: AbortSignal): Promise<EmbeddingResult> {
    if (signal?.aborted) throw Object.assign(new Error("The embedding request was stopped."), { name: "AbortError" });
    const vectors = inputs.map((input) => {
      const vector = Array.from({ length: 64 }, () => 0);
      for (let index = 0; index < input.length; index += 1) vector[input.charCodeAt(index) % vector.length]! += 1;
      const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
      return vector.map((value) => value / magnitude);
    });
    return { vectors, model, inputTokens: inputs.reduce((sum, input) => sum + Math.ceil(input.length / 4), 0), estimatedCostUsd: 0 };
  }

  async validateConnection(): Promise<boolean> { return true; }
}

export function qualityConfiguration(config: AppConfig, quality: QualityPreset): { model: string; reasoningEffort: ResponseRequest["reasoningEffort"]; maxOutputTokens: number } {
  if (quality === "fast") return { model: config.models.fast, reasoningEffort: "low", maxOutputTokens: 2_000 };
  if (quality === "deep") return { model: config.models.deep, reasoningEffort: "high", maxOutputTokens: 8_000 };
  return { model: config.models.balanced, reasoningEffort: "medium", maxOutputTokens: 4_000 };
}

export class ProviderFactory {
  readonly #config: AppConfig;
  readonly #keychain: MacKeychain;
  readonly #ephemeralEvaluationApiKey: string | undefined;

  constructor(config: AppConfig, options: {
    keychain?: MacKeychain;
    ephemeralEvaluationApiKey?: string;
  } = {}) {
    this.#config = config;
    this.#keychain = options.keychain ?? new MacKeychain();
    this.#ephemeralEvaluationApiKey = options.ephemeralEvaluationApiKey;
    if (this.#ephemeralEvaluationApiKey !== undefined) {
      if (config.env !== "test" || !config.liveTests || config.mockProvider) {
        throw new Error("An ephemeral provider key may only be supplied to a live evaluation runtime.");
      }
      if (!isRecognizedOpenAiApiKey(this.#ephemeralEvaluationApiKey)) {
        throw new Error("The ephemeral evaluation API key format is not recognized.");
      }
    }
  }

  get keychain(): MacKeychain { return this.#keychain; }

  async hasOpenAiKey(): Promise<boolean> {
    if (this.#config.mockProvider || this.#ephemeralEvaluationApiKey) return true;
    return Boolean(await this.#keychain.getOpenAiApiKey());
  }

  async create(): Promise<ModelProvider> {
    if (this.#config.mockProvider) return new MockProvider();
    const apiKey = this.#ephemeralEvaluationApiKey ?? await this.#keychain.getOpenAiApiKey();
    if (!apiKey) {
      const error = new Error("Add an OpenAI API key in Settings before sending a message.");
      error.name = "ProviderNotConfiguredError";
      throw error;
    }
    return new OpenAiResponsesProvider(apiKey, this.#config.models.embedding);
  }
}

export { MacKeychain, isRecognizedOpenAiApiKey } from "./keychain.js";
