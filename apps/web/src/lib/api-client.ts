import {
  AttachmentSchema,
  ConversationEventSchema,
  CreateMessageResponseSchema,
  GraphResponseSchema,
  RetrievalTraceSchema,
  SearchResponseSchema,
  TopicPageSchema,
  type Attachment,
  type CreateMessageRequest,
  type RunStreamEvent
} from "@continuum/contracts";
import {
  ActivateEventRevisionResponseSchema,
  ApiErrorSchema,
  BackupsListResponseSchema,
  BackupSchema,
  BudgetSummarySchema,
  CancelRunResponseSchema,
  ClaimDetailResponseSchema,
  ClaimsListResponseSchema,
  CorrectClaimResponseSchema,
  CreateMemoryPinResponseSchema,
  DeleteMemoryPinResponseSchema,
  DeleteVaultResponseSchema,
  DeletionImpactSchema,
  EntityDetailResponseSchema,
  EntityMergeCandidatesListResponseSchema,
  EntityMergeImpactResponseSchema,
  EntityMergeResultSchema,
  EvidenceResponseSchema,
  EventRevisionsListResponseSchema,
  EventsListResponseSchema,
  ExportVaultResponseSchema,
  ImportVaultResponseSchema,
  MemoryJobsListResponseSchema,
  MutationRecoveryResponseSchema,
  ProviderConfiguredResponseSchema,
  RegenerateEventResponseSchema,
  RevokeWorkspaceResponseSchema,
  RetryMemoryJobResponseSchema,
  RunsListResponseSchema,
  RunStreamWireEventSchema,
  SourceDetailResponseSchema,
  StartMemoryLintResponseSchema,
  TopicDetailSchema,
  TopicsListResponseSchema,
  VaultDeletionImpactSchema,
  WorkspacesListResponseSchema,
  WorkspaceSchema
} from "@continuum/contracts/api";
import type { MutationRecoveryResponse, RecoverableMutationOperation } from "@continuum/contracts/api";
import type { BudgetSummary as ContractBudgetSummary } from "@continuum/contracts/api";

import { demoBootstrap, demoSearchResults } from "./demo-data";
import type {
  AppSettings,
  AssistantRevision,
  AuthorizedWorkspace,
  BackupRecord,
  BootstrapData,
  DebugSnapshot,
  EntityMergeCandidate,
  EntityMergeEnvelope,
  EntityMergeResult,
  EvidenceRecord,
  GraphResponse,
  ImpactSummary,
  PendingAttachment,
  QualityPreset,
  SecretFileApproval,
  SearchFilters,
  SearchResult,
  TopicPage,
  TopicPageDetail,
  TopicProposal,
  VaultDeletionImpact
} from "./types";
import { DEFAULT_SETTINGS } from "./types";

export class ApiRequestError extends Error {
  constructor(message: string, readonly code = "REQUEST_FAILED", readonly retryable = false, readonly status = 0) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export type StreamHandlers = {
  onEvent: (event: RunStreamEvent, metadata: { id: string }) => void;
  onMalformed?: (data: string) => void;
  onCursor?: (id: string) => void;
  onReconnect?: (details: { attempt: number; lastEventId: string | null }) => void;
};

export type StreamRunOptions = {
  lastEventId?: string | null;
  maxReconnectAttempts?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaximumDelayMs?: number;
};

export type SseFrame = { id: string | null; data: string | null };

const TERMINAL_RUN_EVENTS = new Set<RunStreamEvent["type"]>(["run.completed", "run.failed", "run.cancelled"]);

type RuntimeSchema = { parse(value: unknown): unknown };

export function parseSseFrame(block: string): SseFrame {
  const lines = block.replace(/\r/g, "").split("\n");
  const data: string[] = [];
  let id: string | null = null;
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    if (field === "id" && !value.includes("\0")) id = value;
  }
  return { id, data: data.length ? data.join("\n") : null };
}

export function parseSseBlock(block: string) {
  return parseSseFrame(block).data;
}

function cursorIsAtOrBefore(candidate: string, cursor: string): boolean {
  if (/^\d+$/.test(candidate) && /^\d+$/.test(cursor)) return BigInt(candidate) <= BigInt(cursor);
  return candidate === cursor;
}

function isDurableSseEventId(value: string | null): value is string {
  return value !== null && /^\d+$/.test(value) && Number.isSafeInteger(Number(value));
}

export async function consumeSseStream(
  response: Response,
  handlers: StreamHandlers,
  options: { afterEventId?: string | null; seenEventIds?: Set<string> } = {}
): Promise<{ lastEventId: string | null; terminal: boolean }> {
  if (!response.body) throw new ApiRequestError("The streaming response had no body.", "EMPTY_STREAM", true, response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const seenEventIds = options.seenEventIds ?? new Set<string>();
  let buffer = "";
  let lastEventId = options.afterEventId ?? null;
  let terminal = false;
  const advanceCursor = (id: string) => {
    seenEventIds.add(id);
    lastEventId = id;
    handlers.onCursor?.(id);
  };
  const dispatch = (frame: SseFrame) => {
    const { data, id } = frame;
    if (!data || data === "[DONE]") return;
    if (!isDurableSseEventId(id)) { handlers.onMalformed?.(data); return; }
    if (seenEventIds.has(id) || (lastEventId !== null && cursorIsAtOrBefore(id, lastEventId))) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      handlers.onMalformed?.(data);
      advanceCursor(id);
      return;
    }
    const event = RunStreamWireEventSchema.safeParse(parsed);
    if (!event.success) { handlers.onMalformed?.(data); advanceCursor(id); return; }
    handlers.onEvent(event.data, { id });
    advanceCursor(id);
    terminal = TERMINAL_RUN_EVENTS.has(event.data.type);
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let boundary = buffer.search(/\r?\n\r?\n/);
    while (boundary >= 0) {
      const separator = buffer.slice(boundary).startsWith("\r\n\r\n") ? 4 : 2;
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + separator);
      dispatch(parseSseFrame(block));
      if (terminal) break;
      boundary = buffer.search(/\r?\n\r?\n/);
    }
    if (terminal) {
      await reader.cancel().catch(() => undefined);
      break;
    }
    if (done) break;
  }
  if (!terminal && buffer.trim()) dispatch(parseSseFrame(buffer));
  return { lastEventId, terminal };
}

function waitForReconnect(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
  return new Promise((resolve, reject) => {
    let timeout = 0;
    const onAbort = () => { window.clearTimeout(timeout); reject(new DOMException("The operation was aborted.", "AbortError")); };
    timeout = window.setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

type RequestOptions = RequestInit & { timeoutMs?: number | null };

export class ContinuumApi {
  private readonly baseUrl: string;
  private connected = false;
  private settingsCache: AppSettings = { ...DEFAULT_SETTINGS };
  private readonly settingsStorageKey = "continuum.ui-settings";
  private vaultReadController = new AbortController();

  constructor(baseUrl = "/api/v1") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  resetVaultReadScope(): void {
    this.vaultReadController.abort();
    this.vaultReadController = new AbortController();
  }

  private headers(extra?: HeadersInit) {
    const headers = new Headers(extra);
    headers.set("Accept", "application/json");
    return headers;
  }

  private mutationHeaders(extra?: HeadersInit, idempotencyKey?: string) {
    const headers = this.headers(extra);
    headers.set("X-Continuum-Request", "1");
    if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
    return headers;
  }

  private async request<T>(path: string, options: RequestOptions = {}, schema?: RuntimeSchema): Promise<T> {
    const controller = new AbortController();
    const timeout = options.timeoutMs === null ? null : window.setTimeout(() => controller.abort(), options.timeoutMs ?? 12_000);
    const method = (options.method ?? "GET").toUpperCase();
    const upstreamSignals = [options.signal, method === "GET" || method === "HEAD" ? this.vaultReadController.signal : undefined].filter((signal): signal is AbortSignal => Boolean(signal));
    const abortFromUpstream = () => controller.abort();
    for (const signal of upstreamSignals) {
      if (signal.aborted) controller.abort(); else signal.addEventListener("abort", abortFromUpstream, { once: true });
    }
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        headers: options.headers instanceof Headers ? options.headers : this.headers(options.headers),
        credentials: "include",
        signal: controller.signal
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const envelope = ApiErrorSchema.safeParse(payload);
        throw new ApiRequestError(envelope.success ? envelope.data.error.message : `Request failed with status ${response.status}.`, envelope.success ? envelope.data.error.code : "REQUEST_FAILED", envelope.success ? envelope.data.error.retryable : false, response.status);
      }
      return (schema ? schema.parse(payload) : payload) as T;
    } catch (error) {
      if (error instanceof ApiRequestError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") throw new ApiRequestError("The local service did not respond in time.", "TIMEOUT", true);
      throw new ApiRequestError("Continuum’s local service is unavailable.", "OFFLINE", true);
    } finally {
      if (timeout !== null) window.clearTimeout(timeout);
      for (const signal of upstreamSignals) signal.removeEventListener("abort", abortFromUpstream);
    }
  }

  private readLocalSettings(): Partial<AppSettings> {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(this.settingsStorageKey) ?? "{}");
      return value && typeof value === "object" && !Array.isArray(value) ? value as Partial<AppSettings> : {};
    } catch {
      return {};
    }
  }

  private writeLocalSettings(settings: AppSettings) {
    try { localStorage.setItem(this.settingsStorageKey, JSON.stringify(settings)); } catch { /* Preferences remain in memory if storage is unavailable. */ }
  }

  async getBudgetSummary(): Promise<ContractBudgetSummary> {
    return this.request<ContractBudgetSummary>("/budget", {}, BudgetSummarySchema);
  }

  async bootstrap(): Promise<BootstrapData> {
    try {
      const health = await this.request<{
        status?: string;
        providerConfigured?: boolean;
        worker?: { queuedJobs?: number };
        database?: {
          vectorMode?: string;
          vectorStrategy?: BootstrapData["runtime"]["vectorStrategy"];
          vectorVersion?: string | null;
          vectorFallbackLimit?: number;
          vectorLoadStatus?: BootstrapData["runtime"]["vectorLoadStatus"];
          schemaVersion?: number;
        };
        version?: string;
      }>("/health", { timeoutMs: 1800 });
      const [runtimeResult, settingsResult, budgetResult, eventsResult, runsResult, topicsResult, claimsResult, graphResult, traceResult, callsResult, jobsResult, lintResult, pinsResult, proposalsResult] = await Promise.allSettled([
        this.request<Partial<BootstrapData["runtime"]> & { mockProvider?: boolean; vectorMode?: string }>("/runtime"),
        this.request<{ settings: Partial<AppSettings>; raw?: Record<string, unknown> }>("/settings"),
        this.request<{
          hardLimitUsd?: number;
          spentUsd?: number;
          reservedUsd?: number;
          allocatedUsd?: number;
          availableUsd?: number;
          activeReservations?: number;
          inputTokens?: number;
          outputTokens?: number;
          extractionTokens?: number;
          embeddingTokens?: number;
          warningThresholdUsd?: number;
          ledgerCreatedAt?: string | null;
          warningThresholdsReached?: Array<20 | 50 | 75 | 90>;
        }>("/budget"),
        this.request<{ events: BootstrapData["events"]; nextCursor: string | null }>("/events?limit=100"),
        this.request<{ runs: Array<Record<string, unknown>>; nextCursor: string | null }>("/runs?status=active&limit=100", {}, RunsListResponseSchema),
        this.request<{ topics: BootstrapData["topics"]; nextCursor: string | null }>("/topics?limit=50"),
        this.request<{ claims: BootstrapData["claims"]; nextCursor: string | null }>("/claims?limit=100"),
        this.request<GraphResponse>("/graph?limit=300"),
        this.request<{ trace: unknown }>("/retrieval-traces/latest"),
        this.request<{ calls: Array<Record<string, unknown>> }>("/model-calls?limit=20"),
        this.request<{ jobs: Array<Record<string, unknown>> }>("/memory-jobs"),
        this.request<{ issues: Array<Record<string, unknown>> }>("/memories/lint"),
        this.request<{ pins: Array<Record<string, unknown>> }>("/memories/pins"),
        this.request<{ proposals: Array<Record<string, unknown>> }>("/memory-proposals?limit=50")
      ]);
      const settled = <T,>(result: PromiseSettledResult<T>, fallback: T) => result.status === "fulfilled" ? result.value : fallback;
      const runtime = settled(runtimeResult, {});
      const settingsPayload = settled(settingsResult, { settings: {}, raw: {} });
      const serverSettings = settingsPayload.settings;
      const rawSettings = settingsPayload.raw ?? serverSettings as Record<string, unknown>;
      const localSettings = this.readLocalSettings();
      const theme = serverSettings.theme ?? rawSettings.theme;
      const quality = serverSettings.quality ?? rawSettings["quality.default"];
      const resolvedSettings: AppSettings = {
        ...demoBootstrap.settings,
        ...localSettings,
        ...serverSettings,
        ...(theme === "light" || theme === "dark" || theme === "system" ? { theme } : {}),
        ...(quality === "fast" || quality === "balanced" || quality === "deep" ? { quality } : {}),
        ...(typeof rawSettings["memory.enabled"] === "boolean" ? { memoryPaused: !rawSettings["memory.enabled"] } : {}),
        ...(typeof rawSettings["webSearch.enabled"] === "boolean" ? { webSearchEnabled: rawSettings["webSearch.enabled"] } : {}),
        ...(typeof rawSettings["onboarding.complete"] === "boolean" ? { onboardingComplete: rawSettings["onboarding.complete"] } : {}),
        ...(typeof rawSettings["promptTracing.enabled"] === "boolean" ? { promptTracingEnabled: rawSettings["promptTracing.enabled"] } : {})
      };
      const budget = settled(budgetResult, {});
      const vectorMode = runtime.vectorMode ?? health.database?.vectorMode;
      const vectorStrategy = runtime.vectorStrategy ?? health.database?.vectorStrategy;
      const vectorVersion = runtime.vectorVersion ?? health.database?.vectorVersion;
      const vectorFallbackLimit = runtime.vectorFallbackLimit ?? health.database?.vectorFallbackLimit;
      const vectorLoadStatus = runtime.vectorLoadStatus ?? health.database?.vectorLoadStatus;
      const providerConfigured = health.providerConfigured === true || runtime.mockProvider === true;
      this.connected = true;
      this.settingsCache = resolvedSettings;
      this.writeLocalSettings(resolvedSettings);
      const callRows = settled(callsResult, { calls: [] }).calls;
      const latestRunId = callRows.find((call) => typeof call.runId === "string")?.runId;
      const latestTrace = settled(traceResult, { trace: null }).trace;
      const fallbackTracePayload = latestTrace === null && typeof latestRunId === "string"
        ? await this.request<unknown>(`/retrieval-traces/${encodeURIComponent(latestRunId)}`).catch(() => null)
        : null;
      const fallbackTrace = fallbackTracePayload && typeof fallbackTracePayload === "object" && "trace" in fallbackTracePayload
        ? (fallbackTracePayload as { trace: unknown }).trace
        : fallbackTracePayload;
      const traceCandidate = latestTrace ?? fallbackTrace;
      const parsedTrace = RetrievalTraceSchema.safeParse(traceCandidate);
      const trace = parsedTrace.success ? parsedTrace.data : null;
      const pins = settled(pinsResult, { pins: [] }).pins;
      const pinByObjectId = new Map(pins.map((pin) => [String(pin.object_id ?? pin.objectId), String(pin.id)]));
      const memories = (trace?.candidates ?? []).filter((candidate) => candidate.selected).map((candidate) => {
        const allowedTypes = new Set(["event", "topic", "claim", "source", "attachment"]);
        const type = allowedTypes.has(candidate.type) ? candidate.type as "event" | "topic" | "claim" | "source" | "attachment" : "source";
        const pinId = pinByObjectId.get(candidate.id);
        return {
          id: candidate.id,
          type,
          title: candidate.title,
          excerpt: candidate.excerpt,
          ...(type === "event" ? { sourceEventId: candidate.id } : candidate.sourceIds[0] ? { sourceEventId: candidate.sourceIds[0] } : {}),
          ...(type === "topic" ? { topicId: candidate.id } : {}),
          ...(pinId ? { pinned: true, pinId } : {}),
          reason: candidate.reason
        };
      });
      const calls = callRows.map((call) => ({
        id: String(call.id),
        ...(typeof call.runId === "string" ? { runId: call.runId } : {}),
        label: String(call.purpose ?? "Model call").replaceAll("_", " "),
        model: String(call.model ?? "unknown"),
        latencyMs: Number(call.latencyMs ?? 0),
        inputTokens: Number(call.inputTokens ?? 0),
        cachedInputTokens: Number(call.cachedInputTokens ?? call.cached_input_tokens ?? 0),
        outputTokens: Number(call.outputTokens ?? 0),
        estimatedCostUsd: Number(call.estimatedCostUsd ?? 0),
        status: (call.status === "failed" || call.status === "running" ? call.status : "complete") as BootstrapData["debug"]["modelCalls"][number]["status"],
        ...(typeof call.promptVersion === "string" ? { promptVersion: call.promptVersion } : {}),
        ...(typeof call.schemaVersion === "string" ? { schemaVersion: call.schemaVersion } : {}),
        ...(typeof call.retrievalVersion === "string" ? { retrievalVersion: call.retrievalVersion } : {}),
        ...(typeof call.modelVersion === "string" ? { modelVersion: call.modelVersion } : {})
      }));
      const jobs = settled(jobsResult, { jobs: [] }).jobs.map((job) => ({
        id: String(job.id),
        name: String(job.type ?? "memory job").replaceAll(".", " "),
        status: (job.status === "queued" || job.status === "running" || job.status === "failed" ? job.status : "complete") as BootstrapData["debug"]["jobs"][number]["status"],
        attempts: Number(job.attempts ?? 0),
        updatedAt: String(job.updatedAt ?? new Date(0).toISOString())
      }));
      const attention = settled(lintResult, { issues: [] }).issues.map((issue) => {
        const rawType = String(issue.type ?? "stale");
        const kind = rawType.includes("conflict") ? "conflict" : rawType.includes("merge") || rawType.includes("duplicate") ? "merge" : "stale";
        return { id: String(issue.objectId ?? crypto.randomUUID()), kind, title: rawType.replaceAll("-", " "), description: String(issue.message ?? "Memory needs review.") } as const;
      });
      const version = runtime.version ?? health.version;
      const lastMemoryUpdate = runtime.lastMemoryUpdate ?? jobs[0]?.updatedAt;
      const eventsPage = settled(eventsResult, { events: [], nextCursor: null });
      const activeRuns = settled(runsResult, { runs: [], nextCursor: null }).runs.flatMap((run) => {
        const status = String(run.status);
        if (status !== "pending" && status !== "retrieving" && status !== "streaming") return [];
        return [{
          id: String(run.id),
          status,
          userEventId: typeof run.userEventId === "string" ? run.userEventId : null,
          assistantEventId: typeof run.assistantEventId === "string" ? run.assistantEventId : null,
          ...(typeof run.createdAt === "string" ? { createdAt: run.createdAt } : {})
        }];
      });
      return {
        runtime: {
          ...demoBootstrap.runtime,
          mode: runtime.mode === "degraded" ? "degraded" : "connected",
          apiReachable: true,
          providerReachable: providerConfigured,
          vectorSearch: runtime.vectorSearch ?? (vectorMode === "sqlite-vec" ? "ready" : vectorMode === "bounded-cosine-fallback" ? "fallback" : "unavailable"),
          ...(vectorStrategy !== undefined ? { vectorStrategy } : {}),
          ...(vectorVersion !== undefined ? { vectorVersion } : {}),
          ...(vectorFallbackLimit !== undefined ? { vectorFallbackLimit } : {}),
          ...(vectorLoadStatus !== undefined ? { vectorLoadStatus } : {}),
          memoryQueue: runtime.memoryQueue ?? ((health.worker?.queuedJobs ?? 0) > 0 ? "working" : "idle"),
          ...(runtime.activePort !== undefined ? { activePort: runtime.activePort } : {}),
          ...(version !== undefined ? { version } : {}),
          ...(lastMemoryUpdate !== undefined ? { lastMemoryUpdate } : {}),
          message: runtime.message ?? (providerConfigured
            ? (vectorMode === "bounded-cosine-fallback"
                ? `Degraded vector fallback: searches the newest ${(vectorFallbackLimit ?? 5_000).toLocaleString()} vectors per embedding size; text and graph search remain available.`
                : "Local vault connected")
            : "Add an OpenAI API key to send messages")
        },
        settings: resolvedSettings,
        budget: {
          ...demoBootstrap.budget,
          totalUsd: budget.spentUsd ?? 0,
          reservedUsd: budget.reservedUsd ?? 0,
          allocatedUsd: budget.allocatedUsd ?? ((budget.spentUsd ?? 0) + (budget.reservedUsd ?? 0)),
          availableUsd: budget.availableUsd ?? Math.max(0, (budget.hardLimitUsd ?? 100) - (budget.allocatedUsd ?? ((budget.spentUsd ?? 0) + (budget.reservedUsd ?? 0)))),
          activeReservations: budget.activeReservations ?? 0,
          capUsd: budget.hardLimitUsd ?? 100,
          warningThresholdUsd: budget.warningThresholdUsd ?? demoBootstrap.budget.warningThresholdUsd,
          inputTokens: budget.inputTokens ?? 0,
          outputTokens: budget.outputTokens ?? 0,
          extractionTokens: budget.extractionTokens ?? 0,
          embeddingTokens: budget.embeddingTokens ?? 0,
          ledgerCreatedAt: budget.ledgerCreatedAt ?? null,
          warningThresholdsReached: budget.warningThresholdsReached ?? []
        },
        events: eventsPage.events,
        eventsNextCursor: eventsPage.nextCursor,
        activeRuns,
        topics: settled(topicsResult, { topics: [], nextCursor: null }).topics,
        claims: settled(claimsResult, { claims: [], nextCursor: null }).claims,
        graph: settled(graphResult, { nodes: [], edges: [], focusId: null, truncated: false }),
        activeMemories: memories,
        attention,
        memoryProposals: settled(proposalsResult, { proposals: [] }).proposals.map(normalizeTopicProposal),
        debug: {
          trace,
          contextPacket: null,
          modelCalls: calls,
          toolCalls: [],
          jobs,
          promptVersion: String(settled(callsResult, { calls: [] }).calls[0]?.promptVersion ?? "—"),
          schemaVersion: health.database?.schemaVersion === undefined ? "—" : String(health.database.schemaVersion),
          versions: {
            prompt: String(settled(callsResult, { calls: [] }).calls[0]?.promptVersion ?? "—"),
            schema: health.database?.schemaVersion === undefined ? "—" : String(health.database.schemaVersion),
            retrieval: String(settled(callsResult, { calls: [] }).calls[0]?.retrievalVersion ?? "—"),
            reranker: "—",
            contextBuilder: "—",
            vector: vectorVersion ?? "—",
            parser: "—",
            chunker: "—",
            responseModel: String(settled(callsResult, { calls: [] }).calls[0]?.model ?? "—"),
            embeddingModel: resolvedSettings.embeddingModelId
          }
        }
      };
    } catch {
      this.connected = false;
      const settings = { ...DEFAULT_SETTINGS, ...this.readLocalSettings() };
      this.settingsCache = settings;
      return {
        runtime: {
          mode: "offline",
          apiReachable: false,
          providerReachable: false,
          vectorSearch: "unavailable",
          memoryQueue: "paused",
          message: "The local Continuum service is unavailable. No vault data was substituted."
        },
        settings,
        budget: { totalUsd: 0, reservedUsd: 0, allocatedUsd: 0, availableUsd: 100, activeReservations: 0, capUsd: 100, warningThresholdUsd: 20, inputTokens: 0, outputTokens: 0, extractionTokens: 0, embeddingTokens: 0, ledgerCreatedAt: null, warningThresholdsReached: [] },
        events: [],
        eventsNextCursor: null,
        activeRuns: [],
        topics: [],
        claims: [],
        graph: { nodes: [], edges: [], focusId: null, truncated: false },
        activeMemories: [],
        attention: [],
        memoryProposals: [],
        debug: { trace: null, contextPacket: null, modelCalls: [], toolCalls: [], jobs: [], promptVersion: "—", schemaVersion: "—", versions: emptyVersions() }
      };
    }
  }

  async saveSettings(settings: Partial<AppSettings>) {
    const latest = { ...this.settingsCache, ...settings };
    const mutations: Array<{ key: string; value: unknown }> = [];
    const changed = <Key extends keyof AppSettings>(key: Key) => settings[key] !== undefined && JSON.stringify(settings[key]) !== JSON.stringify(this.settingsCache[key]);
    if (changed("theme")) mutations.push({ key: "theme", value: settings.theme });
    if (changed("quality")) mutations.push({ key: "quality.default", value: settings.quality });
    if (changed("memoryPaused")) mutations.push({ key: "memory.enabled", value: !settings.memoryPaused });
    if (changed("webSearchEnabled")) mutations.push({ key: "webSearch.enabled", value: settings.webSearchEnabled });
    if (changed("onboardingComplete")) mutations.push({ key: "onboarding.complete", value: settings.onboardingComplete });
    if (changed("systemInstructions")) mutations.push({ key: "system.instructions", value: settings.systemInstructions });
    if (changed("showSourceChips")) mutations.push({ key: "ui.showSourceChips", value: settings.showSourceChips });
    if (changed("developerOverrides")) mutations.push({ key: "developer.traceMode", value: settings.developerOverrides });
    if (changed("promptTracingEnabled")) mutations.push({ key: "promptTracing.enabled", value: settings.promptTracingEnabled });
    if (changed("responseModelIds")) mutations.push({ key: "models.response", value: settings.responseModelIds });
    if (changed("extractionModelId")) mutations.push({ key: "models.extraction", value: settings.extractionModelId });
    if (changed("embeddingModelId")) mutations.push({ key: "models.embedding", value: settings.embeddingModelId });
    for (const mutation of mutations) {
      const idempotencyKey = crypto.randomUUID();
      await this.request<{ key: string; value: unknown }>("/settings", {
        method: "PUT",
        headers: this.mutationHeaders({ "Content-Type": "application/json" }, idempotencyKey),
        body: JSON.stringify({ ...mutation, idempotencyKey })
      });
    }
    this.settingsCache = latest;
    this.writeLocalSettings(latest);
    return latest;
  }

  async configureApiKey(apiKey: string) {
    const idempotencyKey = crypto.randomUUID();
    const result = await this.request<{ configured: boolean }>("/providers/openai-key", {
      method: "POST",
      headers: this.mutationHeaders({ "Content-Type": "application/json" }, idempotencyKey),
      body: JSON.stringify({ apiKey, idempotencyKey })
    }, ProviderConfiguredResponseSchema);
    if (!result.configured) throw new ApiRequestError("OpenAI did not accept that API key.", "PROVIDER_KEY_INVALID", false);
    return result;
  }

  async removeApiKey() {
    const idempotencyKey = crypto.randomUUID();
    return this.request<{ configured: false }>("/providers/openai-key", {
      method: "DELETE",
      headers: this.mutationHeaders({ "Content-Type": "application/json" }, idempotencyKey),
      body: JSON.stringify({ idempotencyKey })
    }, ProviderConfiguredResponseSchema);
  }

  async createMessage(request: CreateMessageRequest) {
    try {
      const payload = await this.request<unknown>("/messages", {
        method: "POST",
        headers: this.mutationHeaders({ "Content-Type": "application/json" }, request.idempotencyKey),
        body: JSON.stringify(request)
      });
      return CreateMessageResponseSchema.parse(payload);
    } catch (error) {
      const recovered = await this.recoverMutation("messages.create", request.idempotencyKey).catch(() => null);
      if (recovered?.found && recovered.operation === "messages.create") return recovered.result;
      throw error;
    }
  }

  async recoverMutation(operation: RecoverableMutationOperation, key: string): Promise<MutationRecoveryResponse> {
    const params = new URLSearchParams({ operation, key });
    return this.request<MutationRecoveryResponse>(`/idempotency-recovery?${params.toString()}`, {}, MutationRecoveryResponseSchema);
  }

  async listEvents(cursor: string | null, limit = 100) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
    return this.request<{ events: BootstrapData["events"]; nextCursor: string | null }>(`/events?${params.toString()}`, {}, EventsListResponseSchema);
  }

  async getEvent(eventId: string) {
    return this.request<BootstrapData["events"][number]>(`/events/${encodeURIComponent(eventId)}`, {}, ConversationEventSchema);
  }

  async getEventRevisions(eventId: string) {
    return this.request<{ revisions: AssistantRevision[] }>(`/events/${encodeURIComponent(eventId)}/revisions`, {}, EventRevisionsListResponseSchema);
  }

  async activateEventRevision(eventId: string) {
    const idempotencyKey = crypto.randomUUID();
    return this.request<{ event: BootstrapData["events"][number] }>(`/events/${encodeURIComponent(eventId)}/activate`, {
      method: "PATCH",
      headers: this.mutationHeaders({ "Content-Type": "application/json" }, idempotencyKey),
      body: JSON.stringify({ idempotencyKey })
    }, ActivateEventRevisionResponseSchema);
  }

  async getTopic(topicId: string, revision?: number) {
    const parameters = new URLSearchParams();
    if (revision !== undefined) parameters.set("revision", String(revision));
    const query = parameters.size ? `?${parameters.toString()}` : "";
    return this.request<TopicPageDetail>(`/topics/${encodeURIComponent(topicId)}${query}`, {}, TopicDetailSchema);
  }

  async getEvidence(id: string) {
    return this.request<EvidenceRecord>(`/evidence/${encodeURIComponent(id)}`, {}, EvidenceResponseSchema);
  }

  async getClaimDetail(id: string) {
    return this.request<{ claim: BootstrapData["claims"][number]; evidence: Array<Record<string, unknown>>; relations: Array<Record<string, unknown>> }>(`/claims/${encodeURIComponent(id)}`, {}, ClaimDetailResponseSchema);
  }

  async correctClaim(id: string, value: string, reason: string) {
    const idempotencyKey = crypto.randomUUID();
    return this.request<{ event: BootstrapData["events"][number]; claim: BootstrapData["claims"][number]; supersededClaimId: string }>(`/claims/${encodeURIComponent(id)}/correct`, {
      method: "POST",
      headers: this.mutationHeaders({ "Content-Type": "application/json" }, idempotencyKey),
      body: JSON.stringify({ value, reason, idempotencyKey })
    }, CorrectClaimResponseSchema);
  }

  async getEntityDetail(id: string) {
    return this.request<Record<string, unknown>>(`/entities/${encodeURIComponent(id)}`, {}, EntityDetailResponseSchema);
  }

  async getSourceDetail(id: string) {
    return this.request<Record<string, unknown>>(`/sources/${encodeURIComponent(id)}`, {}, SourceDetailResponseSchema);
  }

  async listEntityMergeCandidates() {
    return (await this.request<{ candidates: EntityMergeCandidate[] }>("/entities/merge-candidates?limit=50", {}, EntityMergeCandidatesListResponseSchema)).candidates;
  }

  async entityMergeImpact(sourceId: string, targetId: string) {
    const idempotencyKey = crypto.randomUUID();
    return this.request<EntityMergeEnvelope>("/entities/merge-impact", {
      method: "POST", headers: this.mutationHeaders({ "Content-Type": "application/json" }, idempotencyKey),
      body: JSON.stringify({ sourceId, targetId, idempotencyKey })
    }, EntityMergeImpactResponseSchema);
  }

  async mergeEntities(envelope: EntityMergeEnvelope) {
    const idempotencyKey = crypto.randomUUID();
    return this.request<EntityMergeResult>("/entities/merge", {
      method: "POST", headers: this.mutationHeaders({ "Content-Type": "application/json" }, idempotencyKey),
      body: JSON.stringify({ sourceId: envelope.impact.sourceId, targetId: envelope.impact.targetId, confirmationToken: envelope.confirmationToken, idempotencyKey })
    }, EntityMergeResultSchema);
  }

  async reverseEntityMerge(mergeId: string) {
    const idempotencyKey = crypto.randomUUID();
    return this.request<EntityMergeResult & { reversedAt: string }>(`/entities/merges/${encodeURIComponent(mergeId)}/reverse`, {
      method: "POST", headers: this.mutationHeaders({ "Content-Type": "application/json" }, idempotencyKey),
      body: JSON.stringify({ idempotencyKey })
    }, EntityMergeResultSchema);
  }

  async streamRun(runId: string, handlers: StreamHandlers, signal?: AbortSignal, options: StreamRunOptions = {}) {
    const seenEventIds = new Set<string>();
    let lastEventId = options.lastEventId ?? null;
    if (lastEventId !== null && !isDurableSseEventId(lastEventId)) throw new ApiRequestError("The saved response cursor is invalid.", "INVALID_STREAM_CURSOR", false);
    const maximumAttempts = options.maxReconnectAttempts ?? 20;
    const baseDelay = options.reconnectBaseDelayMs ?? 200;
    const maximumDelay = options.reconnectMaximumDelayMs ?? 5_000;
    let reconnectAttempt = 0;
    while (true) {
      if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
      const cursorBeforeAttempt = lastEventId;
      try {
        const headers = this.headers();
        headers.set("Accept", "text/event-stream");
        if (lastEventId !== null) headers.set("Last-Event-ID", lastEventId);
        const response = await fetch(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/stream`, { headers, credentials: "include", signal: signal ?? null });
        if (!response.ok) {
          const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
          throw new ApiRequestError(`Unable to stream response (${response.status}).`, "STREAM_FAILED", retryable, response.status);
        }
        const result = await consumeSseStream(response, {
          ...handlers,
          onCursor: (id) => { lastEventId = id; handlers.onCursor?.(id); }
        }, { afterEventId: lastEventId, seenEventIds });
        lastEventId = result.lastEventId;
        if (result.terminal) return result;
      } catch (error) {
        if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        if (error instanceof ApiRequestError && !error.retryable) throw error;
      }
      if (lastEventId !== cursorBeforeAttempt) reconnectAttempt = 0;
      reconnectAttempt += 1;
      if (reconnectAttempt > maximumAttempts) throw new ApiRequestError("The response stream stayed unavailable after repeated reconnect attempts.", "STREAM_INTERRUPTED", true);
      handlers.onReconnect?.({ attempt: reconnectAttempt, lastEventId });
      const delay = Math.min(maximumDelay, baseDelay * 2 ** Math.min(reconnectAttempt - 1, 6));
      await waitForReconnect(delay, signal);
    }
  }

  async cancelRun(runId: string) {
    const idempotencyKey = crypto.randomUUID();
    return this.request<{ cancelled: boolean }>(`/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST", headers: this.mutationHeaders({ "Content-Type": "application/json" }, idempotencyKey), body: JSON.stringify({ idempotencyKey }) }, CancelRunResponseSchema);
  }

  async getRetrievalTrace(runId: string) {
    const payload = await this.request<unknown>(`/retrieval-traces/${encodeURIComponent(runId)}`);
    const candidate = payload && typeof payload === "object" && "trace" in payload ? (payload as { trace: unknown }).trace : payload;
    return RetrievalTraceSchema.parse(candidate);
  }

  async getRunDebug(runId: string) {
    const payload = await this.request<unknown>(`/runs/${encodeURIComponent(runId)}/debug`);
    return normalizeRunDebug(runId, payload);
  }

  async getMemoryJobs(runId?: string) {
    const query = runId ? `?limit=20&runId=${encodeURIComponent(runId)}` : "?limit=100";
    const jobs = await this.request<{ jobs: Array<Record<string, unknown>> }>(`/memory-jobs${query}`, {}, MemoryJobsListResponseSchema);
    return jobs.jobs.map((job) => {
      const payload = job.payload && typeof job.payload === "object" && !Array.isArray(job.payload) ? job.payload as Record<string, unknown> : null;
      const payloadRunId = typeof payload?.runId === "string" ? payload.runId : undefined;
      const status = job.status === "queued" || job.status === "running" || job.status === "failed" || job.status === "cancelled" ? job.status : "complete";
      return {
        id: String(job.id),
        name: String(job.type ?? "memory job").replaceAll(".", " "),
        status: status as BootstrapData["debug"]["jobs"][number]["status"],
        attempts: Number(job.attempts ?? 0),
        updatedAt: String(job.updatedAt ?? new Date(0).toISOString()),
        ...(payloadRunId ? { runId: payloadRunId } : {}),
        lastErrorCode: typeof job.lastErrorCode === "string" ? job.lastErrorCode : null
      };
    });
  }

  async refreshMemoryState() {
    const [topics, claims, graph, jobs] = await Promise.all([
      this.request<{ topics: BootstrapData["topics"]; nextCursor: string | null }>("/topics?limit=50", {}, TopicsListResponseSchema),
      this.request<{ claims: BootstrapData["claims"]; nextCursor: string | null }>("/claims?limit=100", {}, ClaimsListResponseSchema),
      this.request<GraphResponse>("/graph?limit=300", {}, GraphResponseSchema),
      this.getMemoryJobs()
    ]);
    return {
      topics: topics.topics,
      claims: claims.claims,
      graph,
      jobs
    };
  }

  async regenerate(eventId: string, idempotencyKey: string = crypto.randomUUID()) {
    try {
      return await this.request<{ runId: string; quality: QualityPreset }>(`/events/${encodeURIComponent(eventId)}/regenerate`, { method: "POST", headers: this.mutationHeaders({ "Content-Type": "application/json" }, idempotencyKey), body: JSON.stringify({ idempotencyKey }) }, RegenerateEventResponseSchema);
    } catch (error) {
      const recovered = await this.recoverMutation("events.regenerate", idempotencyKey).catch(() => null);
      if (recovered?.found && recovered.operation === "events.regenerate") return recovered.result;
      throw error;
    }
  }

  async uploadAttachment(pending: PendingAttachment) {
    if (pending.fileUnavailable) throw new ApiRequestError(`${pending.file.name} must be reattached because its original browser file bytes are no longer available.`, "ATTACHMENT_FILE_UNAVAILABLE", false);
    const idempotencyKey = pending.idempotencyKey || crypto.randomUUID();
    pending.idempotencyKey = idempotencyKey;
    const body = new FormData();
    body.append("file", pending.file, pending.file.name);
    try {
      const payload = await this.request<unknown>("/attachments", { method: "POST", headers: this.mutationHeaders(undefined, idempotencyKey), body, timeoutMs: 60_000 });
      return AttachmentSchema.parse(payload);
    } catch (error) {
      const recovered = await this.recoverMutation("attachments.upload", idempotencyKey).catch(() => null);
      if (recovered?.found && recovered.operation === "attachments.upload") return recovered.result;
      throw error;
    }
  }

  async getAttachment(id: string) {
    return AttachmentSchema.parse(await this.request<unknown>(`/attachments/${encodeURIComponent(id)}`, {}, AttachmentSchema));
  }

  attachmentContentUrl(id: string) {
    return `${this.baseUrl}/attachments/${encodeURIComponent(id)}/content`;
  }

  async waitForAttachmentReady(attachment: Attachment, timeoutMs = 10 * 60_000) {
    if (attachment.status === "ready") return attachment;
    const startedAt = Date.now();
    let current = attachment;
    while (current.status === "queued" || current.status === "processing") {
      if (Date.now() - startedAt >= timeoutMs) throw new ApiRequestError(`${attachment.filename} is still processing. Try sending again in a moment.`, "ATTACHMENT_TIMEOUT", true);
      await new Promise((resolve) => window.setTimeout(resolve, 1_000));
      current = await this.getAttachment(attachment.id);
    }
    if (current.status === "failed") throw new ApiRequestError(`${attachment.filename} could not be processed.`, "ATTACHMENT_FAILED", false);
    return current;
  }

  async uploadAndPrepareAttachment(pending: PendingAttachment) {
    // Retrying a draft after slow extraction must resume the already uploaded
    // durable attachment ID instead of creating an orphaned duplicate source.
    // A terminal extraction result is different: replaying its completed upload
    // key can only return the same failed attachment forever. Require the person
    // to remove and reattach the file, which creates an explicit new upload
    // intent instead of silently duplicating durable attachment records.
    if (pending.remote?.status === "failed") {
      throw new ApiRequestError(`${pending.file.name} could not be processed. Remove and reattach it before retrying.`, pending.fileUnavailable ? "ATTACHMENT_FILE_UNAVAILABLE" : "ATTACHMENT_REATTACH_REQUIRED", false);
    }
    const uploaded = pending.remote && pending.remote.status !== "failed" ? pending.remote : await this.uploadAttachment(pending);
    pending.remote = uploaded;
    try {
      const ready = await this.waitForAttachmentReady(uploaded);
      pending.remote = ready;
      return ready;
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "ATTACHMENT_FAILED") {
        pending.remote = { ...uploaded, status: "failed" };
        throw new ApiRequestError(`${pending.file.name} could not be processed. Remove and reattach it before retrying.`, pending.fileUnavailable ? "ATTACHMENT_FILE_UNAVAILABLE" : "ATTACHMENT_REATTACH_REQUIRED", false);
      }
      throw error;
    }
  }

  async search(query: string, filters: SearchFilters, cursor?: string, allowDemoFallback = false) {
    if (!query.trim()) return { results: [] as SearchResult[], nextCursor: null, tookMs: 0 };
    if (allowDemoFallback) {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const results = demoSearchResults.filter((item) => {
        const haystack = `${item.title} ${item.snippet} ${item.tags.join(" ")}`.toLowerCase();
        return (!filters.types.length || filters.types.includes(item.type)) && (!filters.tag.trim() || item.tags.some((tag) => tag.toLowerCase().includes(filters.tag.trim().toLowerCase()))) && (!filters.source.trim() || haystack.includes(filters.source.trim().toLowerCase())) && terms.every((term) => haystack.includes(term));
      });
      return { results, nextCursor: null, tookMs: 4 };
    }
    const params = new URLSearchParams({ q: query, role: filters.role, status: filters.status, date: filters.date });
    if (filters.types.length) params.set("types", filters.types.join(","));
    if (filters.source.trim()) params.set("source", filters.source.trim());
    if (filters.tag.trim()) params.set("tag", filters.tag.trim());
    if (cursor) params.set("cursor", cursor);
    const response = await this.request<{ results: SearchResult[]; nextCursor: string | null; tookMs: number }>(`/search?${params.toString()}`, {}, SearchResponseSchema);
    const cutoff = dateCutoff(filters.date);
    return {
      ...response,
      results: response.results.filter((item) => {
        if (filters.types.length && !filters.types.includes(item.type)) return false;
        if (cutoff && item.timestamp && new Date(item.timestamp).getTime() < cutoff) return false;
        if (filters.tag.trim() && !item.tags.some((tag) => tag.toLowerCase().includes(filters.tag.trim().toLowerCase()))) return false;
        if (filters.source.trim() && !`${item.title} ${item.tags.join(" ")}`.toLowerCase().includes(filters.source.trim().toLowerCase())) return false;
        return true;
      })
    };
  }

  async getGraph(focusId: string | null, hops: 1 | 2, includeHistory: boolean): Promise<GraphResponse> {
    const params = new URLSearchParams({ hops: String(hops), history: String(includeHistory) });
    if (focusId) params.set("focusId", focusId);
    return this.request<GraphResponse>(`/graph?${params.toString()}`, {}, GraphResponseSchema);
  }

  async updateTopic(topicId: string, patch: Partial<TopicPage>, expectedRevision: number) {
    const idempotencyKey = crypto.randomUUID();
    return this.request<TopicPage>(`/topics/${encodeURIComponent(topicId)}`, { method: "PATCH", headers: this.mutationHeaders({ "Content-Type": "application/json" }, idempotencyKey), body: JSON.stringify({ ...patch, expectedRevision, idempotencyKey }) }, TopicPageSchema);
  }

  async setPinned(memory: { id: string; type: "event" | "topic" | "claim" | "source" | "attachment"; title: string; pinId?: string }, pinned: boolean) {
    const idempotencyKey = crypto.randomUUID();
    if (pinned) {
      if (memory.type === "attachment") throw new ApiRequestError("Pin the attachment’s source instead.", "PIN_TYPE_UNSUPPORTED", false);
      return this.request<{ id: string }>("/memories/pins", { method: "POST", headers: this.mutationHeaders({ "Content-Type": "application/json" }, idempotencyKey), body: JSON.stringify({ objectType: memory.type, objectId: memory.id, label: memory.title, idempotencyKey }) }, CreateMemoryPinResponseSchema);
    }
    if (!memory.pinId) throw new ApiRequestError("This pin needs to be refreshed before it can be removed.", "PIN_ID_MISSING", true);
    await this.request(`/memories/pins/${encodeURIComponent(memory.pinId)}`, { method: "DELETE", headers: this.mutationHeaders({ "Content-Type": "application/json" }, idempotencyKey), body: JSON.stringify({ idempotencyKey }) }, DeleteMemoryPinResponseSchema);
    return { id: memory.pinId };
  }

  async runMemoryLint() {
    const idempotencyKey = crypto.randomUUID();
    return this.request<{ jobId: string }>("/memories/lint", { method: "POST", headers: this.mutationHeaders({ "Content-Type": "application/json" }, idempotencyKey), body: JSON.stringify({ idempotencyKey }) }, StartMemoryLintResponseSchema);
  }

  async listMemoryProposals() {
    const payload = await this.request<{ proposals?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>("/memory-proposals?limit=50");
    const rows = Array.isArray(payload) ? payload : payload.proposals ?? [];
    return rows.map(normalizeTopicProposal);
  }

  async resolveMemoryProposal(id: string, action: "accept" | "reject") {
    const idempotencyKey = crypto.randomUUID();
    return this.request<{ proposal?: Record<string, unknown>; resolved?: boolean; topics?: TopicPage[] }>(`/memory-proposals/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
      headers: this.mutationHeaders({ "Content-Type": "application/json" }, idempotencyKey),
      body: JSON.stringify({ action, idempotencyKey })
    });
  }

  async retryJob(jobId: string) {
    const idempotencyKey = crypto.randomUUID();
    await this.request(`/memory-jobs/${encodeURIComponent(jobId)}/retry`, { method: "POST", headers: this.mutationHeaders({ "Content-Type": "application/json" }, idempotencyKey), body: JSON.stringify({ idempotencyKey }) }, RetryMemoryJobResponseSchema);
  }

  async deletionImpact(resource: "events" | "attachments" | "claims" | "topics", id: string): Promise<ImpactSummary> {
    const idempotencyKey = crypto.randomUUID();
    return this.request<ImpactSummary>(`/${resource}/${encodeURIComponent(id)}/deletion-impact`, { method: "POST", headers: this.mutationHeaders({ "Content-Type": "application/json" }, idempotencyKey), body: JSON.stringify({ idempotencyKey }) }, DeletionImpactSchema);
  }

  async confirmDeletion(resource: "events" | "attachments" | "claims" | "topics", id: string, confirmationToken: string) {
    const idempotencyKey = crypto.randomUUID();
    await this.request(`/${resource}/${encodeURIComponent(id)}`, { method: "DELETE", headers: this.mutationHeaders({ "Content-Type": "application/json" }, idempotencyKey), body: JSON.stringify({ confirmationToken, idempotencyKey }) });
  }

  async vaultDeletionImpact() {
    return this.request<VaultDeletionImpact>("/vault/deletion-impact", { method: "POST", headers: this.mutationHeaders() }, VaultDeletionImpactSchema);
  }

  async destroyVault(confirmation: VaultDeletionImpact["requiredPhrase"], confirmationToken: string) {
    const idempotencyKey = crypto.randomUUID();
    await this.request("/vault", { method: "DELETE", headers: this.mutationHeaders({ "Content-Type": "application/json" }, idempotencyKey), body: JSON.stringify({ confirmation, confirmationToken, idempotencyKey }) }, DeleteVaultResponseSchema);
  }

  async verifyVaultImport(file: File) {
    const idempotencyKey = crypto.randomUUID();
    const body = new FormData();
    body.append("mode", "verify");
    body.append("file", file, file.name);
    return this.request<{ valid: boolean; verificationToken: string; archiveChecksum: string; size: number; expiresAt: string; manifest?: { createdAt?: string; counts?: Record<string, number> } }>("/import", { method: "POST", headers: this.mutationHeaders(undefined, idempotencyKey), body, timeoutMs: null }, ImportVaultResponseSchema);
  }

  async commitVerifiedVaultImport(verificationToken: string, mode: "replace" | "fresh") {
    const idempotencyKey = crypto.randomUUID();
    return this.request<{ valid: boolean; replaced?: boolean; manifest?: { createdAt?: string; counts?: Record<string, number> } }>("/import/commit", {
      method: "POST",
      headers: this.mutationHeaders({ "Content-Type": "application/json" }, idempotencyKey),
      body: JSON.stringify({ verificationToken, mode, idempotencyKey }),
      timeoutMs: null
    }, ImportVaultResponseSchema);
  }

  async listBackups() {
    return (await this.request<{ backups: Array<Record<string, unknown>> }>("/backups", {}, BackupsListResponseSchema)).backups.map((record): BackupRecord => ({
      id: String(record.id),
      filename: String(record.filename),
      kind: record.kind === "daily" || record.kind === "weekly" ? record.kind : "manual",
      size: Number(record.size ?? 0),
      checksum: String(record.checksum ?? ""),
      createdAt: String(record.created_at ?? record.createdAt ?? new Date(0).toISOString())
    }));
  }

  async createBackup() {
    const idempotencyKey = crypto.randomUUID();
    return this.request<Record<string, unknown>>("/backups", { method: "POST", headers: this.mutationHeaders({ "Content-Type": "application/json" }, idempotencyKey), body: JSON.stringify({ idempotencyKey }), timeoutMs: null }, BackupSchema);
  }

  async listWorkspaces() {
    const payload = await this.request<{ workspaces: Array<Record<string, unknown>> }>("/workspaces", {}, WorkspacesListResponseSchema);
    return payload.workspaces.map((workspace): AuthorizedWorkspace => ({
      id: String(workspace.id),
      path: String(workspace.canonicalRoot ?? workspace.path ?? ""),
      displayName: String(workspace.displayName ?? workspace.display_name ?? workspace.canonicalRoot ?? workspace.path ?? "Workspace"),
      readOnly: true
    }));
  }

  async authorizeWorkspace(path: string, displayName: string) {
    const idempotencyKey = crypto.randomUUID();
    return this.request<AuthorizedWorkspace>("/workspaces", { method: "POST", headers: this.mutationHeaders({ "Content-Type": "application/json" }, idempotencyKey), body: JSON.stringify({ path, displayName, idempotencyKey }) }, WorkspaceSchema);
  }

  async revokeWorkspace(id: string) {
    const idempotencyKey = crypto.randomUUID();
    return this.request<{ revoked: boolean }>(`/workspaces/${encodeURIComponent(id)}`, { method: "DELETE", headers: this.mutationHeaders({ "Content-Type": "application/json" }, idempotencyKey), body: JSON.stringify({ idempotencyKey }) }, RevokeWorkspaceResponseSchema);
  }

  async approveWorkspaceSecretFile(workspaceId: string, relativePath: string): Promise<SecretFileApproval> {
    const idempotencyKey = crypto.randomUUID();
    const payload = await this.request<Record<string, unknown>>(`/workspaces/${encodeURIComponent(workspaceId)}/secret-approvals`, {
      method: "POST",
      headers: this.mutationHeaders({ "Content-Type": "application/json" }, idempotencyKey),
      body: JSON.stringify({ relativePath, acknowledgement: true, idempotencyKey })
    });
    const approval = asRecord(payload.approval) ?? payload;
    const rawStatus = readString(approval, "status") ?? "ready";
    return {
      id: readString(approval, "id", "approvalId", "approval_id") ?? idempotencyKey,
      workspaceId: readString(approval, "workspaceId", "workspace_id") ?? workspaceId,
      relativePath: readString(approval, "relativePath", "relative_path") ?? relativePath,
      expiresAt: readString(approval, "expiresAt", "expires_at") ?? new Date(Date.now() + 5 * 60_000).toISOString(),
      oneUse: true,
      remainingUses: readNumber(approval, "remainingUses", "remaining_uses") === 0 ? 0 : 1,
      status: rawStatus === "used" || rawStatus === "expired" ? rawStatus : "ready"
    };
  }

  async exportVault(options: { attachments: boolean; toolOutputs: boolean }) {
    const idempotencyKey = crypto.randomUUID();
    const exported = await this.request<{ filename: string; size: number; checksum: string; downloadUrl: string }>("/export", {
      method: "POST",
      headers: this.mutationHeaders({ "Content-Type": "application/json" }, idempotencyKey),
      body: JSON.stringify({ includeAttachments: options.attachments, includeSensitiveToolOutput: options.toolOutputs, idempotencyKey }),
      timeoutMs: null
    }, ExportVaultResponseSchema);
    const download = new URL(exported.downloadUrl, window.location.origin);
    if (download.origin !== window.location.origin) throw new ApiRequestError("The export download URL was not local.", "UNSAFE_DOWNLOAD_URL", false);
    const anchor = document.createElement("a");
    anchor.href = download.href;
    anchor.download = exported.filename;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    return exported;
  }
}

export const continuumApi = new ContinuumApi();

function dateCutoff(date: SearchFilters["date"]) {
  if (date === "all") return null;
  const now = new Date();
  if (date === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const days = date === "week" ? 7 : date === "month" ? 31 : 365;
  return now.getTime() - days * 86_400_000;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readString(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) if (typeof record[key] === "string") return record[key] as string;
  return undefined;
}

function readNumber(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function parseJsonValue(value: unknown) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function emptyVersions(): DebugSnapshot["versions"] {
  return { prompt: "—", schema: "—", retrieval: "—", reranker: "—", contextBuilder: "—", vector: "—", parser: "—", chunker: "—", responseModel: "—", embeddingModel: "—" };
}

function normalizeTopicProposal(record: Record<string, unknown>): TopicProposal {
  const explicitPayload = asRecord(record.proposedRevision ?? record.proposed_revision ?? record.payload);
  const rawKind = readString(record, "kind", "type", "proposalType", "proposal_type") ?? "topic_update";
  const rawAffected = record.affectedTopicIds ?? record.affected_topic_ids ?? record.topicIds ?? record.topic_ids;
  const shardPatches = Array.isArray(record.patches) ? record.patches.flatMap((value) => {
    const patch = asRecord(value);
    return patch ? [patch] : [];
  }) : [];
  const children = Array.isArray(record.children) ? record.children.flatMap((value) => {
    const child = asRecord(value);
    const id = child ? readString(child, "topicId", "topic_id") : undefined;
    return id ? [id] : [];
  }) : [];
  const patchedTopicIds = shardPatches.flatMap((patch) => {
    const base = asRecord(patch.base);
    const baseId = base ? readString(base, "topicId", "topic_id") : undefined;
    const outputIds = Array.isArray(patch.outputs) ? patch.outputs.flatMap((value) => {
      const output = asRecord(value);
      const id = output ? readString(output, "topicId", "topic_id") : undefined;
      return id ? [id] : [];
    }) : [];
    return [...(baseId ? [baseId] : []), ...outputIds];
  });
  const affectedTopicIds = [...new Set(Array.isArray(rawAffected)
    ? rawAffected.filter((id): id is string => typeof id === "string")
    : [...children, ...patchedTopicIds])];
  const topicId = readString(record, "topicId", "topic_id", "parentTopicId", "parent_topic_id") ?? null;
  if (topicId && !affectedTopicIds.includes(topicId)) affectedTopicIds.unshift(topicId);
  const boundedPatch = rawKind === "topic_shard_patch";
  const canAccept = boundedPatch && record.schemaVersion === 2;
  const restructure = rawKind.includes("split") || rawKind.includes("restructure");
  const archivedRanges = shardPatches.filter((patch) => Array.isArray(patch.outputs) && patch.outputs.length === 0).length;
  const outputCount = shardPatches.reduce((count, patch) => count + (Array.isArray(patch.outputs) ? patch.outputs.length : 0), 0);
  const payload = explicitPayload ?? (boundedPatch ? {
    parentBase: record.parentBase ?? record.parent_base,
    patches: shardPatches,
    claimCount: Array.isArray(record.claimIds) ? record.claimIds.length : 0,
    sourceCount: Array.isArray(record.sourceIds) ? record.sourceIds.length : 0
  } : restructure ? {
    parentRevisionId: record.parentRevisionId ?? record.parent_revision_id,
    parentRevision: record.parentRevision ?? record.parent_revision,
    children: record.children ?? [],
    links: record.links ?? [],
    claimIds: record.claimIds ?? record.claim_ids ?? [],
    sourceIds: record.sourceIds ?? record.source_ids ?? []
  } : null);
  return {
    id: readString(record, "id", "proposalId", "proposal_id") ?? crypto.randomUUID(),
    kind: boundedPatch ? "topic_patch" : restructure ? "topic_split" : "topic_update",
    topicId,
    title: readString(record, "title") ?? readString(payload ?? {}, "title") ?? (boundedPatch ? "Review bounded topic changes" : restructure ? "Review proposed topic restructure" : "Review proposed topic update"),
    description: readString(record, "description", "summary") ?? readString(payload ?? {}, "summary", "description") ?? (boundedPatch
      ? `Atomically update ${shardPatches.length} evidence-linked ${shardPatches.length === 1 ? "range" : "ranges"} with ${outputCount} proposed ${outputCount === 1 ? "page" : "pages"}${archivedRanges ? ` and archive ${archivedRanges} emptied ${archivedRanges === 1 ? "range" : "ranges"}` : ""}.`
      : restructure ? `Replace the active page with a bounded parent index and ${children.length} proposed child ${children.length === 1 ? "page" : "pages"}.` : "Continuum has prepared a durable-memory change that needs explicit review."),
    reason: readString(record, "reason") ?? (boundedPatch
      ? "A trusted page is in confirmation-only mode. Its active revision and evidence routes remain unchanged unless you accept this exact patch."
      : record.requiresConfirmation === true ? "This durable-memory change requires explicit confirmation before any proposed revision becomes active." : "The current page is user-authored or the proposed change could alter retained meaning."),
    proposedAt: readString(record, "proposedAt", "proposed_at", "createdAt", "created_at") ?? new Date(0).toISOString(),
    proposedRevision: payload,
    affectedTopicIds,
    canAccept,
    ...(!canAccept ? {
      acceptanceBlockedReason: "This older proposal lacks exact claim, evidence, content, and route guards. Reject it so Continuum can compile a safe replacement."
    } : {})
  };
}

function normalizeRunDebug(runId: string, payload: unknown): DebugSnapshot {
  const envelope = asRecord(payload) ?? {};
  const record = asRecord(envelope.debug) ?? envelope;
  const traceCandidate = record.trace ?? record.retrievalTrace ?? record.retrieval_trace;
  const parsedTrace = RetrievalTraceSchema.safeParse(traceCandidate);
  const trace = parsedTrace.success ? parsedTrace.data : null;
  const context = asRecord(record.contextPacket ?? record.context_packet);
  const contextBudget = asRecord(context?.tokenBudget ?? context?.token_budget ?? context?.budget);
  const rawRefs = context?.orderedSourceIds ?? context?.ordered_source_ids ?? context?.sourceIds ?? context?.source_ids ?? context?.contextRefs ?? context?.context_refs;
  const orderedSourceIds = Array.isArray(rawRefs) ? rawRefs.flatMap((item) => {
    if (typeof item === "string") return [item];
    const ref = asRecord(item);
    const id = ref ? readString(ref, "sourceId", "source_id", "objectId", "object_id", "id") : undefined;
    return id ? [id] : [];
  }) : [];
  const maximumInput = readNumber(contextBudget ?? {}, "maximumInput", "maximum_input", "modelContext", "model_context") ?? trace?.tokenBudget.modelContext;
  const contextPacket: DebugSnapshot["contextPacket"] = context ? {
    id: readString(context, "id", "packetId", "packet_id") ?? `${runId}:context`,
    runId: readString(context, "runId", "run_id") ?? runId,
    orderedSourceIds,
    hash: readString(context, "hash", "contentHash", "content_hash", "packetHash", "packet_hash") ?? "—",
    renderedContent: readString(context, "renderedContent", "rendered_content", "content") ?? "",
    reconstructionIntegrity: (() => {
      const value = readString(context, "reconstructionIntegrity", "reconstruction_integrity");
      return value === "verified" || value === "unavailable" || value === "mismatch" || value === "legacy" ? value : "legacy";
    })(),
    unavailableReferenceIds: (() => {
      const value = context.unavailableReferenceIds ?? context.unavailable_reference_ids;
      return Array.isArray(value) ? value.map(String) : [];
    })(),
    promptVersion: readString(context, "promptVersion", "prompt_version") ?? "—",
    tokenBudget: {
      instructions: readNumber(contextBudget ?? {}, "instructions", "instructionTokens", "instruction_tokens") ?? trace?.tokenBudget.instructions ?? 0,
      recentTurns: readNumber(contextBudget ?? {}, "recentTurns", "recent_turns", "recentTurnTokens", "recent_turn_tokens") ?? trace?.tokenBudget.recentTurns ?? 0,
      evidence: readNumber(contextBudget ?? {}, "evidence", "evidenceTokens", "evidence_tokens") ?? trace?.tokenBudget.evidence ?? 0,
      reservedOutput: readNumber(contextBudget ?? {}, "reservedOutput", "reserved_output", "reservedOutputTokens", "reserved_output_tokens") ?? trace?.tokenBudget.reservedOutput ?? 0,
      ...(maximumInput !== undefined ? { maximumInput } : {})
    }
  } : null;

  const rawCalls = record.modelCalls ?? record.model_calls ?? record.calls;
  const modelCalls: DebugSnapshot["modelCalls"] = (Array.isArray(rawCalls) ? rawCalls : []).flatMap((value) => {
    const call = asRecord(value);
    if (!call) return [];
    const metadata = asRecord(parseJsonValue(call.traceMetadata ?? call.trace_metadata));
    const rawStatus = readString(call, "status");
    const promptVersion = readString(call, "promptVersion", "prompt_version") ?? readString(metadata ?? {}, "promptVersion", "prompt_version");
    const schemaVersion = readString(call, "schemaVersion", "schema_version") ?? readString(metadata ?? {}, "schemaVersion", "schema_version");
    const retrievalVersion = readString(call, "retrievalVersion", "retrieval_version") ?? readString(metadata ?? {}, "retrievalVersion", "retrieval_version");
    const modelVersion = readString(call, "modelVersion", "model_version") ?? readString(metadata ?? {}, "modelVersion", "model_version");
    const normalized: DebugSnapshot["modelCalls"][number] = {
      id: readString(call, "id") ?? crypto.randomUUID(),
      runId: readString(call, "runId", "run_id") ?? runId,
      label: (readString(call, "label", "purpose") ?? "Model call").replaceAll("_", " "),
      model: readString(call, "model", "modelId", "model_id") ?? "unknown",
      latencyMs: readNumber(call, "latencyMs", "latency_ms", "durationMs", "duration_ms") ?? 0,
      inputTokens: readNumber(call, "inputTokens", "input_tokens") ?? 0,
      cachedInputTokens: readNumber(call, "cachedInputTokens", "cached_input_tokens") ?? readNumber(metadata ?? {}, "cachedInputTokens", "cached_input_tokens") ?? 0,
      outputTokens: readNumber(call, "outputTokens", "output_tokens") ?? 0,
      estimatedCostUsd: readNumber(call, "estimatedCostUsd", "estimated_cost_usd", "costUsd", "cost_usd") ?? 0,
      status: rawStatus === "failed" || rawStatus === "running" ? rawStatus : "complete"
    };
    if (promptVersion) normalized.promptVersion = promptVersion;
    if (schemaVersion) normalized.schemaVersion = schemaVersion;
    if (retrievalVersion) normalized.retrievalVersion = retrievalVersion;
    if (modelVersion) normalized.modelVersion = modelVersion;
    return [normalized];
  });

  const rawTools = record.toolCalls ?? record.tool_calls ?? record.toolExecutions ?? record.tool_executions;
  const toolCalls: DebugSnapshot["toolCalls"] = (Array.isArray(rawTools) ? rawTools : []).flatMap((value) => {
    const call = asRecord(value);
    if (!call) return [];
    const rawStatus = readString(call, "status") ?? "complete";
    const status: DebugSnapshot["toolCalls"][number]["status"] = rawStatus === "queued" || rawStatus === "running" || rawStatus === "failed" || rawStatus === "cancelled" ? rawStatus : "complete";
    const sandbox = asRecord(parseJsonValue(call.sandbox ?? call.sandboxJson ?? call.sandbox_json));
    const startedAt = readString(call, "startedAt", "started_at") ?? null;
    const completedAt = readString(call, "completedAt", "completed_at") ?? null;
    const derivedDuration = startedAt && completedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) : 0;
    return [{
      id: readString(call, "id") ?? crypto.randomUUID(),
      runId: readString(call, "runId", "run_id") ?? runId,
      name: readString(call, "name", "toolName", "tool_name") ?? "tool",
      arguments: parseJsonValue(call.arguments ?? call.argumentsJson ?? call.arguments_json ?? call.input),
      output: parseJsonValue(call.output ?? call.outputJson ?? call.output_json ?? call.result),
      status,
      startedAt,
      completedAt,
      durationMs: readNumber(call, "durationMs", "duration_ms", "latencyMs", "latency_ms") ?? (Number.isFinite(derivedDuration) ? derivedDuration : 0),
      sandbox
    }];
  });

  const versionRecord = asRecord(record.versions ?? record.versionIdentifiers ?? record.version_identifiers) ?? {};
  const promptVersions = Array.isArray(versionRecord.promptVersions ?? versionRecord.prompt_versions) ? (versionRecord.promptVersions ?? versionRecord.prompt_versions) as unknown[] : [];
  const namedPromptVersion = (pattern: RegExp) => promptVersions.flatMap((value) => {
    const version = asRecord(value);
    if (!version || !pattern.test(readString(version, "name") ?? "")) return [];
    const semantic = readString(version, "semanticVersion", "semantic_version");
    const hash = readString(version, "contentHash", "content_hash");
    return semantic || hash ? [`${semantic ?? "version unknown"}${hash ? ` · ${hash}` : ""}`] : [];
  })[0];
  const sourceDerivations = Array.isArray(versionRecord.sourceDerivations ?? versionRecord.source_derivations) ? (versionRecord.sourceDerivations ?? versionRecord.source_derivations) as unknown[] : [];
  const derivationVersions = (camel: string, snake: string) => [...new Set(sourceDerivations.flatMap((value) => {
    const derivation = asRecord(value);
    const version = derivation ? readString(derivation, camel, snake) : undefined;
    return version ? [version] : [];
  }))].join(", ") || "—";
  const modelIds = Array.isArray(versionRecord.modelIds ?? versionRecord.model_ids) ? (versionRecord.modelIds ?? versionRecord.model_ids) as unknown[] : [];
  const embeddingModel = modelIds.find((value): value is string => typeof value === "string" && value.toLowerCase().includes("embedding"));
  const versions: DebugSnapshot["versions"] = {
    prompt: readString(versionRecord, "prompt", "promptVersion", "prompt_version") ?? contextPacket?.promptVersion ?? modelCalls[0]?.promptVersion ?? "—",
    schema: readString(versionRecord, "schema", "schemaVersion", "schema_version") ?? modelCalls[0]?.schemaVersion ?? "—",
    retrieval: readString(versionRecord, "retrieval", "retrievalVersion", "retrieval_version") ?? modelCalls[0]?.retrievalVersion ?? "—",
    reranker: readString(versionRecord, "reranker", "rerankerVersion", "reranker_version") ?? namedPromptVersion(/rerank/i) ?? "—",
    contextBuilder: readString(versionRecord, "contextBuilder", "context_builder", "contextBuilderVersion", "context_builder_version") ?? namedPromptVersion(/context/i) ?? "—",
    vector: readString(versionRecord, "vector", "vectorVersion", "vector_version", "vectorStrategy", "vector_strategy") ?? "—",
    parser: derivationVersions("parserVersion", "parser_version"),
    chunker: derivationVersions("chunkerVersion", "chunker_version"),
    responseModel: readString(versionRecord, "responseModel", "response_model", "responseModelVersion", "response_model_version") ?? modelCalls.find((call) => call.label.toLowerCase().includes("response"))?.model ?? "—",
    embeddingModel: readString(versionRecord, "embeddingModel", "embedding_model", "embeddingModelVersion", "embedding_model_version") ?? embeddingModel ?? "—"
  };
  return {
    trace,
    contextPacket,
    modelCalls,
    toolCalls,
    jobs: [],
    promptVersion: versions.prompt,
    schemaVersion: versions.schema,
    versions
  };
}
