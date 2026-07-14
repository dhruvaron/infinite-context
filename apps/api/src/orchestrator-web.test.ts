import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@continuum/config";
import { ContinuumDatabase } from "@continuum/database";
import { LocalLogger } from "@continuum/observability";
import type { ModelProvider, ProviderFactory, ProviderStreamEvent, ResponseRequest, StructuredRequest, StructuredResult } from "@continuum/providers";
import { ResponseOrchestrator, RunEventHub } from "./orchestrator.js";

const fixtures: Array<{ root: string; database: ContinuumDatabase; logger: LocalLogger }> = [];

afterEach(async () => {
  while (fixtures.length) {
    const value = fixtures.pop()!;
    await value.logger.flush();
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

describe("production web-search persistence path", () => {
  it("retains safe citation spans, freshness, and provenance without representing them as page text", async () => {
    const root = await mkdtemp(join(tmpdir(), "continuum-orchestrator-web-"));
    const config = loadConfig({
      NODE_ENV: "test",
      CONTINUUM_DATA_DIR: root,
      CONTINUUM_MOCK_PROVIDER: "true",
      CONTINUUM_SESSION_TOKEN: "orchestrator-web-test-token-000000000000"
    });
    const database = ContinuumDatabase.open(config);
    const answer = "Prague has a cited fact.";
    const provider: ModelProvider = {
      name: "recorded-web-fixture",
      async *streamResponse(request: ResponseRequest): AsyncGenerator<ProviderStreamEvent> {
        expect(request.enableWebSearch).toBe(true);
        expect(request.maximumWebSearchCalls).toBe(2);
        yield { type: "web-search", status: "started" };
        yield { type: "delta", delta: answer };
        yield { type: "web-citation", title: "Example source", url: "https://example.com/current", startIndex: 0, endIndex: 6 };
        yield { type: "web-search", status: "complete" };
        yield { type: "completed", responseId: "fixture-response", inputTokens: 10, cachedInputTokens: 4, outputTokens: 7, estimatedCostUsd: 0, webSearchCalls: 1 };
      },
      async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
        return { value: request.schema.parse({}), responseId: "unused", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
      },
      async embed() { return { vectors: [], model: "mock-embedding-v1", inputTokens: 0, estimatedCostUsd: 0 }; },
      async validateConnection() { return true; }
    };
    const providers = { create: async () => provider, hasOpenAiKey: async () => true } as unknown as ProviderFactory;
    const logger = new LocalLogger(config.logsDir);
    fixtures.push({ root, database, logger });
    const orchestrator = new ResponseOrchestrator(database, providers, config, logger, new RunEventHub());
    const user = database.appendEvent({ role: "user", content: "What is the weather in Prague?" });
    const run = database.createRun(user.id, "balanced");
    expect(orchestrator.start(run.id, user, "balanced")).toBe(true);
    const deadline = Date.now() + 3_000;
    while (database.getRun(run.id)?.status !== "complete" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(database.getRun(run.id)?.status).toBe("complete");

    const source = database.connection.prepare("SELECT * FROM sources WHERE type = 'web'").get() as Record<string, unknown>;
    expect(source.uri).toBe("https://example.com/current");
    expect(source.freshness_class).toBe("news");
    expect(source.retrieved_at).toEqual(expect.any(String));
    const provenance = JSON.parse(String(source.provenance_json)) as Record<string, unknown>;
    expect(provenance).toMatchObject({ providerStorage: false, freshnessClass: "news", excerptPolicy: expect.stringMatching(/not represented as verbatim page text/i) });
    expect(Date.parse(String(provenance.freshnessExpiresAt))).toBeGreaterThan(Date.parse(String(source.retrieved_at)));

    const chunk = database.connection.prepare("SELECT * FROM source_chunks WHERE source_id = ?").get(source.id) as Record<string, unknown>;
    expect(chunk.text_content).toBe("Prague");
    expect(chunk.parser_version).toBe("openai-web-citation-v1");
    expect(chunk.chunker_version).toBe("provider-index-span-v1");
    expect(JSON.parse(String(chunk.metadata_json))).toMatchObject({ notPageText: true, kind: "provider_answer_citation_span" });

    const tool = database.connection.prepare("SELECT * FROM tool_executions WHERE run_id = ? AND tool_name = 'web_search'").get(run.id) as Record<string, unknown>;
    expect(tool.status).toBe("complete");
    const citations = JSON.parse(String(tool.citations_json)) as Array<Record<string, unknown>>;
    expect(citations[0]).toMatchObject({ sourceId: source.id, chunkId: chunk.id, freshnessClass: "news", excerptKind: "provider_answer_citation_span" });
    const toolEvents = database.connection.prepare("SELECT COUNT(*) AS count FROM events WHERE run_id = ? AND kind = 'tool_result'").get(run.id) as { count: number };
    expect(toolEvents.count).toBe(1);
  });

  it("keeps an exact failed partial response active for reload and retry without admitting it to retrieval", async () => {
    const root = await mkdtemp(join(tmpdir(), "continuum-orchestrator-partial-"));
    const config = loadConfig({
      NODE_ENV: "test",
      CONTINUUM_DATA_DIR: root,
      CONTINUUM_MOCK_PROVIDER: "true",
      CONTINUUM_SESSION_TOKEN: "orchestrator-partial-test-token-00000000"
    });
    const database = ContinuumDatabase.open(config);
    const provider: ModelProvider = {
      name: "failing-partial-fixture",
      async *streamResponse(): AsyncGenerator<ProviderStreamEvent> {
        yield { type: "delta", delta: "Exact retained prefix." };
        throw Object.assign(new Error("fixture provider disconnected"), { code: "FIXTURE_DISCONNECTED" });
      },
      async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
        return { value: request.schema.parse({}), responseId: "unused", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
      },
      async embed() { return { vectors: [], model: "mock-embedding-v1", inputTokens: 0, estimatedCostUsd: 0 }; },
      async validateConnection() { return true; }
    };
    const providers = { create: async () => provider, hasOpenAiKey: async () => true } as unknown as ProviderFactory;
    const logger = new LocalLogger(config.logsDir);
    fixtures.push({ root, database, logger });
    const orchestrator = new ResponseOrchestrator(database, providers, config, logger, new RunEventHub());
    const user = database.appendEvent({ role: "user", content: "Produce a partial response." });
    const run = database.createRun(user.id, "balanced");

    expect(orchestrator.start(run.id, user, "balanced")).toBe(true);
    const deadline = Date.now() + 3_000;
    while (database.getRun(run.id)?.status !== "failed" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));

    const assistant = database.listEvents({ limit: 10 }).find((event) => event.runId === run.id && event.role === "assistant");
    expect(assistant).toMatchObject({ content: "Exact retained prefix.", status: "failed", active: true });
    expect(database.listEvents({ limit: 10 }).map((event) => event.id)).toContain(assistant!.id);
    expect(database.connection.prepare("SELECT id FROM events WHERE id = ? AND status = 'complete'").get(assistant!.id)).toBeUndefined();
  });

  it("aborts an in-flight structured retrieval call when the user stops the run", async () => {
    const root = await mkdtemp(join(tmpdir(), "continuum-orchestrator-retrieval-cancel-"));
    const config = loadConfig({
      NODE_ENV: "test",
      CONTINUUM_DATA_DIR: root,
      CONTINUUM_MOCK_PROVIDER: "false",
      CONTINUUM_SESSION_TOKEN: "orchestrator-cancel-test-token-000000000"
    });
    const database = ContinuumDatabase.open(config);
    let structuredSignal: AbortSignal | undefined;
    let markStructuredStarted: (() => void) | undefined;
    const structuredStarted = new Promise<void>((resolve) => { markStructuredStarted = resolve; });
    const provider: ModelProvider = {
      name: "cancellable-retrieval-fixture",
      async *streamResponse(): AsyncGenerator<ProviderStreamEvent> {
        throw new Error("response streaming must not start after retrieval cancellation");
      },
      async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
        structuredSignal = request.signal;
        markStructuredStarted?.();
        return await new Promise<StructuredResult<T>>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(new DOMException("stopped", "AbortError")), { once: true });
        });
      },
      async embed() { throw new Error("no vectors exist, so query embedding should not run"); },
      async validateConnection() { return true; }
    };
    const providers = { create: async () => provider, hasOpenAiKey: async () => true } as unknown as ProviderFactory;
    const logger = new LocalLogger(config.logsDir);
    fixtures.push({ root, database, logger });
    const orchestrator = new ResponseOrchestrator(database, providers, config, logger, new RunEventHub());
    const user = database.appendEvent({ role: "user", content: "hello there" });
    const run = database.createRun(user.id, "balanced");

    expect(orchestrator.start(run.id, user, "balanced")).toBe(true);
    await structuredStarted;
    expect(orchestrator.cancel(run.id)).toBe(true);
    const deadline = Date.now() + 3_000;
    while (database.getRun(run.id)?.status !== "cancelled" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));

    expect(structuredSignal?.aborted).toBe(true);
    expect(database.getRun(run.id)?.status).toBe("cancelled");
    expect(database.listEvents({ limit: 10 }).filter((event) => event.runId === run.id && event.role === "assistant")).toEqual([]);
  });

  it("queues cleanup for topic projections backed by an automatically superseded answer revision", async () => {
    const root = await mkdtemp(join(tmpdir(), "continuum-orchestrator-revision-cleanup-"));
    const config = loadConfig({
      NODE_ENV: "test",
      CONTINUUM_DATA_DIR: root,
      CONTINUUM_MOCK_PROVIDER: "true",
      CONTINUUM_SESSION_TOKEN: "orchestrator-revision-cleanup-token-0000"
    });
    const database = ContinuumDatabase.open(config);
    const provider: ModelProvider = {
      name: "revision-cleanup-fixture",
      async *streamResponse(): AsyncGenerator<ProviderStreamEvent> {
        yield { type: "delta", delta: "Replacement answer." };
        yield { type: "completed", responseId: "replacement", inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, estimatedCostUsd: 0, webSearchCalls: 0 };
      },
      async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
        return { value: request.schema.parse({}), responseId: "unused", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
      },
      async embed() { return { vectors: [], model: "mock-embedding-v1", inputTokens: 0, estimatedCostUsd: 0 }; },
      async validateConnection() { return true; }
    };
    const providers = { create: async () => provider, hasOpenAiKey: async () => true } as unknown as ProviderFactory;
    const logger = new LocalLogger(config.logsDir);
    fixtures.push({ root, database, logger });
    const orchestrator = new ResponseOrchestrator(database, providers, config, logger, new RunEventHub());
    const user = database.appendEvent({ role: "user", content: "Give me the answer." });
    const original = database.appendEvent({ role: "assistant", content: "Original answer.", parentEventId: user.id });
    database.registerAssistantRevision(user.id, original.id);
    const topic = database.upsertTopicRevision({
      type: "concept",
      title: "Revision cleanup",
      slug: "revision-cleanup",
      markdown: "# Revision cleanup\n\nOriginal answer.",
      summary: "Original answer.",
      currentState: "Original answer.",
      history: "",
      sourceIds: [original.id],
      promptVersion: "fixture"
    });
    database.upsertClaim({
      topicId: topic.id,
      subject: "Answer",
      predicate: "states",
      value: "original",
      confidence: 1,
      status: "current",
      sourceRole: "assistant",
      sourceIds: [original.id],
      validFrom: null,
      validTo: null,
      observedAt: original.createdAt,
      freshnessExpiresAt: null
    });
    const run = database.createRun(user.id, "balanced");

    expect(orchestrator.start(run.id, user, "balanced")).toBe(true);
    const deadline = Date.now() + 3_000;
    while (database.getRun(run.id)?.status !== "complete" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));

    expect(database.getEvent(original.id)?.active).toBe(false);
    expect(database.listJobs(20)).toContainEqual(expect.objectContaining({
      type: "memory.rebuild",
      payload: expect.objectContaining({ topicIds: [topic.id], reason: "assistant_revision_superseded" })
    }));
  });
});
