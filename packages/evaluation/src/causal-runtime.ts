import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { estimateCostUsd, loadConfig, stableHash, type AppConfig } from "@continuum/config";
import type { ConversationEvent } from "@continuum/contracts";
import { ProviderFactory, type ModelProvider } from "@continuum/providers";
import {
  FULL_RETRIEVAL_FEATURES,
  LexicalFixtureReranker,
  RETRIEVAL_ABLATIONS,
  RetrievalEngine,
  type CandidateGenerationRequest,
  type CandidateIndex,
  type CandidateSignal,
  type RetrievalFeatureFlags,
  type RetrievalGraph
} from "@continuum/retrieval";

import type { EvaluationMemoryRetriever } from "./baselines.js";
import type { EvaluationMessage, EvaluationUsage } from "./types.js";

export const PRODUCTION_CAUSAL_ABLATIONS = [
  "full",
  "no_lexical",
  "no_vector",
  "no_reranking",
  "no_temporal",
  "no_topic_pages",
  "no_graph"
] as const;

export type ProductionCausalAblation = typeof PRODUCTION_CAUSAL_ABLATIONS[number];

export function productionCausalFeatureFlags(
  configuration: ProductionCausalAblation
): RetrievalFeatureFlags {
  if (!PRODUCTION_CAUSAL_ABLATIONS.includes(configuration)) {
    throw new Error("Unknown production causal ablation configuration");
  }
  return configuration === "full"
    ? { ...FULL_RETRIEVAL_FEATURES }
    : { ...RETRIEVAL_ABLATIONS[configuration] };
}

interface RuntimeJob {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

interface SqlStatement {
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
  run(...values: unknown[]): unknown;
}

interface ProductionDatabase {
  connection: { prepare(sql: string): SqlStatement };
  appendEvent(input: {
    id?: string;
    role: ConversationEvent["role"];
    kind?: ConversationEvent["kind"];
    status?: ConversationEvent["status"];
    content: string;
    active?: boolean;
  }): ConversationEvent;
  enqueueJob(type: string, idempotencyKey: string, payload: Record<string, unknown>, priority?: number): RuntimeJob;
  leaseJob(workerId: string, leaseMs?: number, acceptedTypes?: string[]): RuntimeJob | null;
  completeJob(id: string, workerId: string, result?: unknown): boolean;
  failJob(id: string, workerId: string, errorCode: string): boolean;
  reserveBudget(hardLimitUsd: number, estimatedCostUsd: number, category: string, runId?: string | null, ttlMs?: number): string;
  releaseBudgetReservation(id: string): void;
  chargeFailedReservation(id: string, input: { provider: string; model: string; purpose: string; promptVersion: string }): void;
  recordModelCall(input: {
    runId?: string | null;
    provider: string;
    model: string;
    purpose: string;
    promptVersion: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    status: string;
    estimatedCostUsd: number;
    reservationId?: string | null;
  }): string;
  budgetSummary(hardLimitUsd: number): Record<string, unknown>;
  close(): void;
}

interface ProductionRuntimeModules {
  Database: { open(config: AppConfig): ProductionDatabase };
  JobProcessor: new (database: ProductionDatabase, config: AppConfig, providers: ProviderFactory, logger: unknown) => {
    process(job: RuntimeJob): Promise<Record<string, unknown>>;
  };
  CandidateIndex: new (database: ProductionDatabase) => CandidateIndex & RetrievalGraph;
  Logger: new (directory: string) => unknown;
}

let productionModules: Promise<ProductionRuntimeModules> | null = null;

function evaluationEventUuid(id: string): string {
  const hex = stableHash(`continuum-causal-event:${id}`).slice(0, 32);
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`;
}

/**
 * Loads the exact application worker and API candidate-index implementations.
 * The imports are URL-based so the evaluation package need not duplicate or
 * fork those production classes merely to expose them as a library API.
 */
export function loadProductionRuntimeModules(): Promise<ProductionRuntimeModules> {
  productionModules ??= (async () => {
    const [databaseModule, workerModule, adapterModule, loggerModule] = await Promise.all([
      import(new URL("../../database/src/index.ts", import.meta.url).href),
      import(new URL("../../../apps/worker/src/processor.ts", import.meta.url).href),
      import(new URL("../../../apps/api/src/retrieval-adapter.ts", import.meta.url).href),
      import(new URL("../../observability/src/index.ts", import.meta.url).href)
    ]);
    return {
      Database: (databaseModule as unknown as { ContinuumDatabase: ProductionRuntimeModules["Database"] }).ContinuumDatabase,
      JobProcessor: (workerModule as unknown as { JobProcessor: ProductionRuntimeModules["JobProcessor"] }).JobProcessor,
      CandidateIndex: (adapterModule as unknown as { SqliteCandidateIndex: ProductionRuntimeModules["CandidateIndex"] }).SqliteCandidateIndex,
      Logger: (loggerModule as unknown as { LocalLogger: ProductionRuntimeModules["Logger"] }).LocalLogger
    };
  })();
  return productionModules;
}

export interface ProductionBudgetBridgeOptions {
  existingAllocatedUsd: number;
  externalPlanUsd: number;
  workerCeilingUsd: number;
}

/** Coordinates fresh benchmark databases against one external durable plan. */
export class ProductionBudgetBridge {
  readonly #options: ProductionBudgetBridgeOptions;
  #priorInternalSpentUsd = 0;

  constructor(options: ProductionBudgetBridgeOptions) {
    for (const [name, value] of Object.entries(options)) {
      if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
    }
    if (options.existingAllocatedUsd + options.externalPlanUsd + options.workerCeilingUsd > 100 + 1e-9) {
      throw new Error("The combined causal benchmark plan exceeds the project-wide USD 100 cap");
    }
    this.#options = options;
  }

  get hardLimitUsd(): number {
    return Math.max(0.01, this.#options.existingAllocatedUsd + this.#options.externalPlanUsd + this.#options.workerCeilingUsd);
  }

  get cumulativeInternalSpentUsd(): number { return this.#priorInternalSpentUsd; }
  get externalMirrorUsd(): number {
    return this.#options.existingAllocatedUsd + this.#options.externalPlanUsd + this.#priorInternalSpentUsd;
  }

  recordClosedDatabase(spentUsd: number): void {
    if (!Number.isFinite(spentUsd) || spentUsd < 0) throw new Error("Production database reported an invalid spend");
    this.#priorInternalSpentUsd += spentUsd;
    if (this.#priorInternalSpentUsd > this.#options.workerCeilingUsd + 1e-9) {
      throw new Error("Production worker/retrieval spend exceeded its shared durable-plan ceiling");
    }
  }
}

interface ProductionEnvironmentOptions {
  mode: "flat_hybrid" | "continuum";
  mockProvider: boolean;
  ephemeralEvaluationApiKey?: string;
  rootParent?: string;
  compileBatchSize?: number;
  processEmbeddings?: boolean;
  bridge: ProductionBudgetBridge;
}

class RawOnlyCandidateIndex implements CandidateIndex {
  constructor(private readonly delegate: CandidateIndex) {}

  async #raw(values: Promise<CandidateSignal[]>): Promise<CandidateSignal[]> {
    return (await values).filter((signal) => signal.document.rawSource);
  }

  lexical(request: CandidateGenerationRequest): Promise<CandidateSignal[]> { return this.#raw(this.delegate.lexical(request)); }
  vector(request: CandidateGenerationRequest): Promise<CandidateSignal[]> { return this.#raw(this.delegate.vector(request)); }
  recency(request: CandidateGenerationRequest): Promise<CandidateSignal[]> { return this.#raw(this.delegate.recency(request)); }
  entity(request: CandidateGenerationRequest): Promise<CandidateSignal[]> { return this.#raw(this.delegate.entity(request)); }
  activeTopic(request: CandidateGenerationRequest): Promise<CandidateSignal[]> { return this.#raw(this.delegate.activeTopic(request)); }
  pinned(request: CandidateGenerationRequest): Promise<CandidateSignal[]> { return this.#raw(this.delegate.pinned(request)); }
  temporal(request: CandidateGenerationRequest): Promise<CandidateSignal[]> { return this.#raw(this.delegate.temporal(request)); }
}

class ProductionEnvironment {
  readonly #options: ProductionEnvironmentOptions;
  readonly #workerId = `causal-eval-${randomUUID()}`;
  #root: string | null = null;
  #database: ProductionDatabase | null = null;
  #processor: { process(job: RuntimeJob): Promise<Record<string, unknown>> } | null = null;
  #provider: ModelProvider | null = null;
  #adapter: (CandidateIndex & RetrievalGraph) | null = null;
  #config: AppConfig | null = null;
  #externalMirrorReservationId: string | null = null;
  #loaded: EvaluationMessage[] = [];
  #runId: string | null = null;
  readonly #runtimeEventIds = new Map<string, string>();
  readonly #evaluationEventIds = new Map<string, string>();
  #compilerInvocations = 0;
  #embeddingJobs = 0;
  #reportedUsage: EvaluationUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    extractionTokens: 0,
    embeddingTokens: 0,
    rerankingTokens: 0,
    estimatedCostUsd: 0
  };

  constructor(options: ProductionEnvironmentOptions) { this.#options = options; }

  get compilerInvocations(): number { return this.#compilerInvocations; }
  get embeddingJobs(): number { return this.#embeddingJobs; }

  async #initialize(): Promise<void> {
    if (this.#database) return;
    const modules = await loadProductionRuntimeModules();
    const parent = this.#options.rootParent ?? tmpdir();
    await mkdir(parent, { recursive: true, mode: 0o700 });
    this.#root = await mkdtemp(join(parent, `continuum-causal-${this.#options.mode}-`));
    this.#config = loadConfig({
      NODE_ENV: "test",
      CONTINUUM_DATA_DIR: this.#root,
      CONTINUUM_MOCK_PROVIDER: this.#options.mockProvider ? "true" : "false",
      CONTINUUM_LIVE_TESTS: this.#options.mockProvider ? "false" : "true",
      CONTINUUM_BUDGET_USD: String(this.#options.bridge.hardLimitUsd),
      CONTINUUM_SESSION_TOKEN: "causal-evaluation-session-token-at-least-32-characters"
    });
    this.#database = modules.Database.open(this.#config);
    const mirror = this.#options.bridge.externalMirrorUsd;
    if (!this.#options.mockProvider && mirror > 0) {
      this.#externalMirrorReservationId = this.#database.reserveBudget(
        this.#config.budgetUsd,
        mirror,
        "causal-external-plan-mirror",
        null,
        24 * 60 * 60_000
      );
    }
    const providers = new ProviderFactory(this.#config, this.#options.ephemeralEvaluationApiKey === undefined
      ? {}
      : { ephemeralEvaluationApiKey: this.#options.ephemeralEvaluationApiKey });
    this.#provider = await providers.create();
    this.#processor = new modules.JobProcessor(
      this.#database,
      this.#config,
      providers,
      new modules.Logger(this.#config.logsDir)
    );
    this.#adapter = new modules.CandidateIndex(this.#database);
  }

  async #closeCurrent(): Promise<void> {
    const database = this.#database;
    const config = this.#config;
    const root = this.#root;
    let firstError: unknown = null;
    let spentUsd: number | null = null;
    if (database && config) {
      try {
        if (this.#externalMirrorReservationId) database.releaseBudgetReservation(this.#externalMirrorReservationId);
        const summary = database.budgetSummary(config.budgetUsd);
        spentUsd = Number(summary.spentUsd ?? Number.NaN);
      } catch (error) { firstError = error; }
      try { database.close(); }
      catch (error) { firstError ??= error; }
    }
    this.#database = null;
    this.#processor = null;
    this.#provider = null;
    this.#adapter = null;
    this.#config = null;
    this.#externalMirrorReservationId = null;
    this.#root = null;
    this.#loaded = [];
    this.#runId = null;
    this.#runtimeEventIds.clear();
    this.#evaluationEventIds.clear();
    this.#reportedUsage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      extractionTokens: 0,
      embeddingTokens: 0,
      rerankingTokens: 0,
      estimatedCostUsd: 0
    };
    if (spentUsd !== null) {
      try { this.#options.bridge.recordClosedDatabase(spentUsd); }
      catch (error) { firstError ??= error; }
    }
    if (root) {
      try { await rm(root, { recursive: true, force: true }); }
      catch (error) { firstError ??= error; }
    }
    if (firstError) throw firstError;
  }

  async close(): Promise<void> { await this.#closeCurrent(); }

  async #reset(): Promise<void> {
    await this.#closeCurrent();
    this.#compilerInvocations = 0;
    this.#embeddingJobs = 0;
    await this.#initialize();
  }

  async #processJobs(types: string[]): Promise<void> {
    if (!this.#database || !this.#processor) throw new Error("Production environment is not initialized");
    while (true) {
      const job = this.#database.leaseJob(this.#workerId, 5 * 60_000, types);
      if (!job) break;
      try {
        const result = await this.#processor.process(job);
        if (!this.#database.completeJob(job.id, this.#workerId, result)) throw new Error(`Could not complete production ${job.type} job`);
        if (job.type === "memory.compile") this.#compilerInvocations += 1;
        if (job.type === "embedding.index") this.#embeddingJobs += 1;
      } catch (error) {
        this.#database.failJob(job.id, this.#workerId, error instanceof Error ? error.name : "CAUSAL_JOB_FAILED");
        throw error;
      }
    }
  }

  async ensureHistory(history: readonly EvaluationMessage[], runId?: string): Promise<void> {
    await this.#initialize();
    if (runId && this.#runId && runId !== this.#runId) await this.#reset();
    if (runId) this.#runId = runId;
    const compatiblePrefix = this.#loaded.length <= history.length
      && this.#loaded.every((message, index) => history[index]?.id === message.id);
    if (!compatiblePrefix) await this.#reset();
    if (!this.#database || !this.#config) throw new Error("Production environment is not initialized");
    const additions = history.slice(this.#loaded.length);
    for (const message of additions) {
      const runtimeId = evaluationEventUuid(message.id);
      const priorEvaluationId = this.#evaluationEventIds.get(runtimeId);
      if (priorEvaluationId && priorEvaluationId !== message.id) {
        throw new Error("Evaluation event ID mapping collision");
      }
      this.#runtimeEventIds.set(message.id, runtimeId);
      this.#evaluationEventIds.set(runtimeId, message.id);
      this.#database.appendEvent({
        id: runtimeId,
        role: message.role,
        kind: "message",
        status: "complete",
        content: message.content,
        active: true
      });
      // The application API deliberately owns production timestamps. A frozen
      // benchmark timeline must preserve its source dates, so fixture loading
      // adjusts only the newly inserted event before the real worker reads it.
      this.#database.connection.prepare(`
        UPDATE events SET created_at = ?, completed_at = ? WHERE id = ?
      `).run(message.createdAt, message.createdAt, runtimeId);
      if (this.#options.mode === "flat_hybrid" && this.#options.processEmbeddings !== false) {
        const contentHash = stableHash(message.content);
        this.#database.enqueueJob("embedding.index", stableHash(`causal-flat-event:${message.id}:${contentHash}:${this.#config.models.embedding}`), {
          sourceId: runtimeId,
          sourceType: "event",
          model: this.#config.models.embedding,
          contentHash
        }, 2);
      }
    }
    if (this.#options.mode === "continuum" && additions.length > 0) {
      const batchSize = this.#options.compileBatchSize ?? 32;
      for (let offset = 0; offset < additions.length; offset += batchSize) {
        const sourceEventIds = additions.slice(offset, offset + batchSize).map((message) => this.#runtimeEventIds.get(message.id)!);
        this.#database.enqueueJob("memory.compile", stableHash(`causal-compile:${sourceEventIds.join(":")}`), {
          sourceEventIds,
          promptVersion: "memory-extraction-v1"
        }, 10);
        await this.#processJobs(["memory.compile"]);
      }
    }
    if (this.#options.processEmbeddings !== false) await this.#processJobs(["embedding.index"]);
    this.#loaded = [...history];
  }

  async queryEmbedding(query: string): Promise<{ vector: number[]; modelId: string } | null> {
    if (this.#options.processEmbeddings === false) return null;
    if (!this.#database || !this.#provider || !this.#config) throw new Error("Production environment is not initialized");
    const model = this.#config.models.embedding;
    const tokens = Math.max(1, Math.ceil(query.length / 4));
    const estimate = Math.max(0.001, estimateCostUsd(model, tokens, 0) * 1.1);
    const reservationId = this.#database.reserveBudget(this.#config.budgetUsd, estimate, "query_embedding", null);
    try {
      const started = performance.now();
      const result = await this.#provider.embed([query], model);
      this.#database.recordModelCall({
        runId: null,
        provider: this.#options.mockProvider ? "mock" : "openai",
        model: result.model,
        purpose: "query_embedding",
        promptVersion: "embedding-v1",
        inputTokens: result.inputTokens,
        outputTokens: 0,
        latencyMs: performance.now() - started,
        status: "complete",
        estimatedCostUsd: result.estimatedCostUsd,
        reservationId
      });
      const vector = result.vectors[0];
      return vector?.length ? { vector, modelId: result.model } : null;
    } catch (error) {
      this.#database.chargeFailedReservation(reservationId, {
        provider: this.#options.mockProvider ? "mock" : "openai",
        model,
        purpose: "query_embedding",
        promptVersion: "embedding-v1"
      });
      throw error;
    }
  }

  #preparationUsage(): EvaluationUsage {
    if (!this.#database) throw new Error("Production environment is not initialized");
    const rows = this.#database.connection.prepare(`
      SELECT mc.purpose,
        COALESCE(SUM(mc.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(mc.output_tokens), 0) AS output_tokens,
        COALESCE(SUM(bl.estimated_cost_usd), 0) AS estimated_cost_usd
      FROM model_calls mc
      LEFT JOIN budget_ledger bl ON bl.model_call_id = mc.id
      GROUP BY mc.purpose
    `).all() as Array<Record<string, unknown>>;
    const usage: EvaluationUsage = {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      extractionTokens: 0,
      embeddingTokens: 0,
      rerankingTokens: 0,
      estimatedCostUsd: 0
    };
    for (const row of rows) {
      const inputTokens = Number(row.input_tokens ?? 0);
      const outputTokens = Number(row.output_tokens ?? 0);
      const cost = Number(row.estimated_cost_usd ?? 0);
      if (![inputTokens, outputTokens, cost].every((value) => Number.isFinite(value) && value >= 0)) {
        throw new Error("Production model-call usage is invalid");
      }
      const purpose = String(row.purpose ?? "");
      if (purpose === "embedding" || purpose === "query_embedding") {
        usage.embeddingTokens += inputTokens + outputTokens;
      } else if (purpose === "memory") {
        usage.extractionTokens += inputTokens + outputTokens;
      } else {
        usage.inputTokens += inputTokens;
        usage.outputTokens += outputTokens;
      }
      usage.estimatedCostUsd += cost;
    }
    return usage;
  }

  #takePreparationUsage(): EvaluationUsage {
    const cumulative = this.#preparationUsage();
    const incremental: EvaluationUsage = {
      inputTokens: cumulative.inputTokens - this.#reportedUsage.inputTokens,
      cachedInputTokens: cumulative.cachedInputTokens - this.#reportedUsage.cachedInputTokens,
      outputTokens: cumulative.outputTokens - this.#reportedUsage.outputTokens,
      extractionTokens: cumulative.extractionTokens - this.#reportedUsage.extractionTokens,
      embeddingTokens: cumulative.embeddingTokens - this.#reportedUsage.embeddingTokens,
      rerankingTokens: cumulative.rerankingTokens - this.#reportedUsage.rerankingTokens,
      estimatedCostUsd: cumulative.estimatedCostUsd - this.#reportedUsage.estimatedCostUsd
    };
    if (Object.values(incremental).some((value) => value < -1e-9)) {
      throw new Error("Production preparation usage moved backwards within one benchmark state");
    }
    for (const key of Object.keys(incremental) as Array<keyof EvaluationUsage>) {
      incremental[key] = Math.max(0, incremental[key]);
    }
    this.#reportedUsage = cumulative;
    return incremental;
  }

  async retrieve(
    query: string,
    tokenBudget: number,
    configuration: ProductionCausalAblation = "full",
    retrievalNow = new Date(0).toISOString()
  ): Promise<{
    text: string;
    evidenceIds: string[];
    tokenCount: number;
    metadata: Record<string, unknown>;
  }> {
    if (!this.#adapter || !this.#database) throw new Error("Production environment is not initialized");
    const rawOnly = this.#options.mode === "flat_hybrid";
    const index = rawOnly ? new RawOnlyCandidateIndex(this.#adapter) : this.#adapter;
    const flags: RetrievalFeatureFlags = rawOnly
      ? { ...FULL_RETRIEVAL_FEATURES, graph: false, topicPages: false }
      : productionCausalFeatureFlags(configuration);
    const engine = new RetrievalEngine(index, this.#adapter, new LexicalFixtureReranker(), null, flags);
    // Turning vector retrieval off also suppresses the query-embedding call.
    // This makes the ablation causal in both behavior and measured cost.
    const queryEmbeddingResult = flags.vector ? await this.queryEmbedding(query) : null;
    const result = await engine.retrieve({
      runId: `causal-retrieval-${randomUUID()}`,
      query,
      queryEmbedding: queryEmbeddingResult?.vector ?? null,
      queryEmbeddingModelId: queryEmbeddingResult?.modelId ?? null,
      now: retrievalNow,
      scopeId: "global",
      activeTopicIds: [],
      limit: 30,
      modelContextTokens: Math.max(8_000, tokenBudget * 3),
      reservedOutputTokens: 2_000,
      instructionTokens: 1_000,
      recentTurnTokens: 0,
      evidenceTokenBudget: tokenBudget
    });
    const selected = result.candidates
      .filter((candidate) => candidate.selected)
      .sort((left, right) => left.rank - right.rank);
    const included: typeof selected = [];
    const rendered: string[] = [];
    let tokenCount = 0;
    for (const candidate of selected) {
      if (tokenCount + candidate.document.tokenCount > tokenBudget) continue;
      included.push(candidate);
      rendered.push(`[${candidate.id}] ${candidate.type} ${candidate.title}\n${candidate.excerpt}`);
      tokenCount += candidate.document.tokenCount;
    }
    // Preserve candidate boundaries for rank-based evaluation. Flattening a
    // multi-source topic before applying @10 lets one page consume every rank
    // slot and can hide a raw source that was itself ranked second or third.
    const selectedCandidateEvidenceIds = included.map((candidate) => [
      ...new Set((candidate.sourceIds.length > 0 ? candidate.sourceIds : [candidate.id])
        .map((id) => this.#evaluationEventIds.get(id) ?? id))
    ]);
    // Retain the legacy flattened list for context traces and artifact readers.
    const evidenceIds = [...new Set(selectedCandidateEvidenceIds.flat())];
    const vectorCount = Number((this.#database.connection.prepare("SELECT COUNT(*) AS count FROM vectors").get() as { count?: unknown } | undefined)?.count ?? 0);
    const claimCount = Number((this.#database.connection.prepare("SELECT COUNT(*) AS count FROM claims").get() as { count?: unknown } | undefined)?.count ?? 0);
    const topicCount = Number((this.#database.connection.prepare("SELECT COUNT(*) AS count FROM topic_pages").get() as { count?: unknown } | undefined)?.count ?? 0);
    const edgeCount = Number((this.#database.connection.prepare("SELECT COUNT(*) AS count FROM edges").get() as { count?: unknown } | undefined)?.count ?? 0);
    const compiledCandidates = included.filter((candidate) => !candidate.document.rawSource);
    return {
      text: rendered.join("\n\n"),
      evidenceIds,
      tokenCount,
      metadata: {
        implementation: "production-worker-sqlite-candidate-index-retrieval-engine-v1",
        productionContinuumRetriever: true,
        mockProvider: this.#options.mockProvider,
        mode: this.#options.mode,
        ablationConfiguration: configuration,
        retrievalFeatureFlags: { ...flags },
        retrievalNow,
        workerCompiler: "JobProcessor.process(memory.compile)",
        candidateIndex: "SqliteCandidateIndex",
        retrievalEngine: "RetrievalEngine",
        reranker: "LexicalFixtureReranker (controlled; production provider reranker not exercised)",
        vectorCount,
        claimCount,
        topicCount,
        edgeCount,
        queryEmbedding: queryEmbeddingResult !== null,
        queryEmbeddingSkippedByAblation: !flags.vector,
        compilerInvocations: this.#compilerInvocations,
        embeddingJobs: this.#embeddingJobs,
        selectedCandidateIds: included.map((candidate) => candidate.id),
        selectedCandidateEvidenceIds,
        selectedCompiledCandidateIds: compiledCandidates.map((candidate) => candidate.id),
        selectedCompiledCandidateCount: compiledCandidates.length,
        preparationUsage: this.#takePreparationUsage(),
        engineRetrievalMs: result.trace.latencyMs
      }
    };
  }
}

export interface ProductionCausalRetrieverOptions {
  mockProvider: boolean;
  ephemeralEvaluationApiKey?: string;
  rootParent?: string;
  compileBatchSize?: number;
  processEmbeddings?: boolean;
  bridge?: ProductionBudgetBridge;
}

/** Evaluation adapter over the actual worker/compiler, SQLite index, and engine. */
export class ProductionCausalRetriever implements EvaluationMemoryRetriever {
  readonly #bridge: ProductionBudgetBridge;
  readonly #environments = new Map<"flat_hybrid" | "continuum", ProductionEnvironment>();
  readonly #options: ProductionCausalRetrieverOptions;
  #activeMode: "flat_hybrid" | "continuum" | null = null;

  constructor(options: ProductionCausalRetrieverOptions) {
    if (options.mockProvider && options.ephemeralEvaluationApiKey !== undefined) {
      throw new Error("A no-cost causal retriever must not receive an evaluation API key");
    }
    if (!options.mockProvider && options.ephemeralEvaluationApiKey === undefined) {
      throw new Error("A live causal retriever requires an explicit ephemeral evaluation API key");
    }
    this.#options = options;
    this.#bridge = options.bridge ?? new ProductionBudgetBridge({
      existingAllocatedUsd: 0,
      externalPlanUsd: 0,
      workerCeilingUsd: options.mockProvider ? 0 : 100
    });
  }

  get cumulativeProductionSpendUsd(): number { return this.#bridge.cumulativeInternalSpentUsd; }

  #environment(mode: "flat_hybrid" | "continuum"): ProductionEnvironment {
    let environment = this.#environments.get(mode);
    if (!environment) {
      environment = new ProductionEnvironment({
        mode,
        mockProvider: this.#options.mockProvider,
        bridge: this.#bridge,
        ...(this.#options.ephemeralEvaluationApiKey === undefined
          ? {}
          : { ephemeralEvaluationApiKey: this.#options.ephemeralEvaluationApiKey }),
        ...(this.#options.rootParent ? { rootParent: this.#options.rootParent } : {}),
        ...(this.#options.compileBatchSize ? { compileBatchSize: this.#options.compileBatchSize } : {}),
        ...(this.#options.processEmbeddings === undefined ? {} : { processEmbeddings: this.#options.processEmbeddings })
      });
      this.#environments.set(mode, environment);
    }
    return environment;
  }

  async retrieve(input: {
    query: string;
    history: readonly EvaluationMessage[];
    tokenBudget: number;
    mode: "flat_hybrid" | "continuum";
    runId?: string;
    stateId?: string;
  }): Promise<{ text: string; evidenceIds: string[]; tokenCount: number; metadata: Record<string, unknown> }> {
    if (this.#activeMode && this.#activeMode !== input.mode) {
      const previous = this.#environments.get(this.#activeMode);
      if (previous) await previous.close();
      this.#environments.delete(this.#activeMode);
    }
    this.#activeMode = input.mode;
    const environment = this.#environment(input.mode);
    const compilationStarted = performance.now();
    await environment.ensureHistory(input.history, input.stateId ?? input.runId);
    const compilationMs = performance.now() - compilationStarted;
    const retrievalStarted = performance.now();
    const retrievalNow = input.history.at(-1)?.createdAt ?? new Date(0).toISOString();
    const result = await environment.retrieve(input.query, input.tokenBudget, "full", retrievalNow);
    const retrievalMs = performance.now() - retrievalStarted;
    return {
      ...result,
      metadata: {
        ...result.metadata,
        compilationMs,
        retrievalMs,
        rerankingMs: 0,
        interactivePreparationLatencyMs: retrievalMs
      }
    };
  }

  /** Runs one real production Continuum retrieval with an explicit feature-removal switch. */
  async retrieveAblation(input: {
    query: string;
    history: readonly EvaluationMessage[];
    tokenBudget: number;
    configuration: ProductionCausalAblation;
    runId?: string;
    stateId?: string;
  }): Promise<{ text: string; evidenceIds: string[]; tokenCount: number; metadata: Record<string, unknown> }> {
    if (!PRODUCTION_CAUSAL_ABLATIONS.includes(input.configuration)) {
      throw new Error("Unknown production causal ablation configuration");
    }
    if (this.#activeMode && this.#activeMode !== "continuum") {
      const previous = this.#environments.get(this.#activeMode);
      if (previous) await previous.close();
      this.#environments.delete(this.#activeMode);
    }
    this.#activeMode = "continuum";
    const environment = this.#environment("continuum");
    const compilationStarted = performance.now();
    await environment.ensureHistory(input.history, input.stateId ?? input.runId);
    const compilationMs = performance.now() - compilationStarted;
    const retrievalStarted = performance.now();
    const retrievalNow = input.history.at(-1)?.createdAt ?? new Date(0).toISOString();
    const result = await environment.retrieve(input.query, input.tokenBudget, input.configuration, retrievalNow);
    const retrievalMs = performance.now() - retrievalStarted;
    return {
      ...result,
      metadata: {
        ...result.metadata,
        configurationId: input.configuration,
        compilationMs,
        retrievalMs,
        rerankingMs: 0,
        interactivePreparationLatencyMs: retrievalMs
      }
    };
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled([...this.#environments.values()].map((environment) => environment.close()));
    this.#environments.clear();
    this.#activeMode = null;
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
  }
}
