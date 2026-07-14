import { createHash, randomUUID } from "node:crypto";

export interface LatencyBudgetSnapshot {
  spentUsd: number;
  hardLimitUsd: number;
  reservedUsd: number;
}

export interface LatencyHarnessSample {
  sample: number;
  marker: string;
  markerSha256: string;
  runId: string | null;
  userEventId: string | null;
  assistantEventId: string | null;
  firstTokenMs: number | null;
  responseCompleteMs: number | null;
  postTurnSearchabilityMs: number | null;
  messageToSearchabilityMs: number | null;
  searchAttempts: number;
  finalSearchServerMs: number | null;
  compiledSearchResultType: "claim" | "topic" | null;
  budgetBeforeUsd: number;
  budgetAfterUsd: number;
  recordedCostDeltaUsd: number;
  error: string | null;
}

export interface DistributionSummary {
  samples: number;
  measured: number;
  medianMs: number | null;
  p95Ms: number | null;
  minimumMs: number | null;
  maximumMs: number | null;
}

export interface LatencyHarnessResult {
  schemaVersion: 1;
  evidenceClass: "local-mock-diagnostic" | "live-controlled-latency";
  generatedAt: string;
  runtime: {
    apiOrigin: string;
    version: string;
    mockProvider: boolean;
    providerReachable: boolean;
    vectorMode: string;
  };
  protocol: {
    samplesRequested: number;
    quality: "fast" | "balanced" | "deep";
    firstTokenStart: "immediately-before-message-post";
    searchableStart: "run-completed";
    searchableObjectTypes: readonly ["claim", "topic"];
    pollIntervalMs: number;
    searchTimeoutMs: number;
  };
  normalProviderConditionsAttested: boolean;
  paidApiAcknowledged: boolean;
  eligibility: {
    firstTokenReleaseGate: boolean;
    postTurnSearchabilityReleaseGate: boolean;
    reasons: string[];
  };
  budget: {
    before: LatencyBudgetSnapshot;
    after: LatencyBudgetSnapshot;
    recordedDeltaUsd: number;
    capAtOrBelow100: boolean;
  };
  firstToken: DistributionSummary;
  responseComplete: DistributionSummary;
  postTurnSearchability: DistributionSummary;
  messageToSearchability: DistributionSummary;
  samples: LatencyHarnessSample[];
  limitations: string[];
  resultHash: string;
}

interface ApiRuntime {
  mockProvider?: unknown;
  providerReachable?: unknown;
  version?: unknown;
  vectorMode?: unknown;
}

interface ApiSearchResponse {
  results?: Array<{ type?: unknown; title?: unknown; snippet?: unknown }>;
  tookMs?: unknown;
}

export interface LatencyHarnessOptions {
  apiOrigin: string;
  sessionToken: string;
  samples?: number;
  quality?: "fast" | "balanced" | "deep";
  pollIntervalMs?: number;
  searchTimeoutMs?: number;
  responseTimeoutMs?: number;
  allowLive?: boolean;
  liveTestsEnabled?: boolean;
  normalProviderConditions?: boolean;
  paidApiAcknowledged?: boolean;
  now?: () => string;
  markerFactory?: (sample: number) => string;
}

function percentile(values: readonly number[], position: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(position * sorted.length) - 1);
  return sorted[index] ?? null;
}

function distribution(values: Array<number | null>): DistributionSummary {
  const measured = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return {
    samples: values.length,
    measured: measured.length,
    medianMs: percentile(measured, 0.5),
    p95Ms: percentile(measured, 0.95),
    minimumMs: measured.length > 0 ? Math.min(...measured) : null,
    maximumMs: measured.length > 0 ? Math.max(...measured) : null
  };
}

function asBudget(value: unknown): LatencyBudgetSnapshot {
  const record = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const spentUsd = record.spentUsd ?? record.totalUsd;
  const hardLimitUsd = record.hardLimitUsd ?? record.capUsd;
  const reservedUsd = record.reservedUsd;
  if (typeof spentUsd !== "number" || typeof hardLimitUsd !== "number" || typeof reservedUsd !== "number"
    || !Number.isFinite(spentUsd) || !Number.isFinite(hardLimitUsd) || !Number.isFinite(reservedUsd)
    || spentUsd < 0 || reservedUsd < 0 || hardLimitUsd <= 0) {
    throw new Error("The application budget endpoint returned an unsafe or incomplete snapshot");
  }
  return { spentUsd, hardLimitUsd, reservedUsd };
}

function assertLoopbackOrigin(origin: string): void {
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new Error("Latency apiOrigin must be a valid loopback URL"); }
  const hostname = parsed.hostname.toLocaleLowerCase();
  const loopback = hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (!loopback || (parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    throw new Error("Latency apiOrigin must be an HTTP(S) loopback URL so the local session token is never sent remotely");
  }
}

function parseSseData(block: string): unknown | null {
  const data = block.replace(/\r/g, "").split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return null;
  return JSON.parse(data) as unknown;
}

class LocalApiClient {
  readonly baseUrl: string;
  readonly #token: string;

  constructor(apiOrigin: string, token: string) {
    this.baseUrl = `${apiOrigin.replace(/\/$/, "")}/api/v1`;
    this.#token = token;
  }

  #headers(mutation = false): Headers {
    const headers = new Headers({ Accept: "application/json", Authorization: `Bearer ${this.#token}` });
    if (mutation) headers.set("X-Continuum-Request", "1");
    return headers;
  }

  async json(path: string, options: RequestInit & { timeoutMs?: number } = {}): Promise<unknown> {
    const headers = this.#headers(options.method !== undefined && !["GET", "HEAD"].includes(options.method));
    for (const [key, value] of new Headers(options.headers)) headers.set(key, value);
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 15_000)
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = typeof payload === "object" && payload !== null
        ? String((payload as { error?: { message?: unknown } }).error?.message ?? `HTTP ${response.status}`)
        : `HTTP ${response.status}`;
      throw new Error(`${path}: ${message}`);
    }
    return payload;
  }

  async stream(runId: string, timeoutMs: number, onEvent: (value: Record<string, unknown>) => void): Promise<void> {
    const response = await fetch(`${this.baseUrl}/runs/${encodeURIComponent(runId)}/stream`, {
      headers: this.#headers(),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!response.ok || !response.body) throw new Error(`Run stream failed with HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const dispatch = (block: string): void => {
      const parsed = parseSseData(block);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) onEvent(parsed as Record<string, unknown>);
    };
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary >= 0) {
        const separator = buffer.slice(boundary).startsWith("\r\n\r\n") ? 4 : 2;
        dispatch(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + separator);
        boundary = buffer.search(/\r?\n\r?\n/);
      }
      if (done) break;
    }
    if (buffer.trim()) dispatch(buffer);
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export async function runLatencyHarness(options: LatencyHarnessOptions): Promise<LatencyHarnessResult> {
  const samples = options.samples ?? 3;
  if (!Number.isInteger(samples) || samples < 1 || samples > 10) throw new Error("samples must be an integer from 1 to 10");
  if (!options.sessionToken) throw new Error("A Continuum session token is required and is never written to the artifact");
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const searchTimeoutMs = options.searchTimeoutMs ?? 15_000;
  const responseTimeoutMs = options.responseTimeoutMs ?? 180_000;
  const quality = options.quality ?? "fast";
  const now = options.now ?? (() => new Date().toISOString());
  assertLoopbackOrigin(options.apiOrigin);
  const api = new LocalApiClient(options.apiOrigin, options.sessionToken);
  const runtimeValue = await api.json("/runtime") as ApiRuntime;
  const mockProvider = runtimeValue.mockProvider === true;
  const providerReachable = runtimeValue.providerReachable === true;
  if (!mockProvider && (!options.allowLive || !options.liveTestsEnabled || !options.paidApiAcknowledged)) {
    throw new Error("Live latency measurement requires --allow-live, --acknowledge-paid-api, and CONTINUUM_LIVE_TESTS=true");
  }
  if (!providerReachable) throw new Error("The configured provider is not reachable");
  const budgetBefore = asBudget(await api.json("/budget"));
  if (budgetBefore.hardLimitUsd > 100) throw new Error("The application budget cap exceeds the project-wide USD 100 limit");
  if (!mockProvider && budgetBefore.spentUsd + budgetBefore.reservedUsd >= Math.min(95, budgetBefore.hardLimitUsd)) {
    throw new Error("Live latency measurement is blocked at the USD 95 diagnostic-reserve threshold");
  }

  const sampleResults: LatencyHarnessSample[] = [];
  for (let sample = 1; sample <= samples; sample += 1) {
    const marker = options.markerFactory?.(sample) ?? `continuum_latency_${sample}_${randomUUID().replaceAll("-", "")}`;
    const markerSha256 = createHash("sha256").update(marker).digest("hex");
    const before = asBudget(await api.json("/budget"));
    if (before.hardLimitUsd > 100) throw new Error("The application budget cap exceeds the project-wide USD 100 limit");
    if (!mockProvider && before.spentUsd + before.reservedUsd >= Math.min(95, before.hardLimitUsd)) {
      sampleResults.push({
        sample,
        marker,
        markerSha256,
        runId: null,
        userEventId: null,
        assistantEventId: null,
        firstTokenMs: null,
        responseCompleteMs: null,
        postTurnSearchabilityMs: null,
        messageToSearchabilityMs: null,
        searchAttempts: 0,
        finalSearchServerMs: null,
        compiledSearchResultType: null,
        budgetBeforeUsd: before.spentUsd,
        budgetAfterUsd: before.spentUsd,
        recordedCostDeltaUsd: 0,
        error: "Live latency sampling stopped at the USD 95 diagnostic-reserve threshold before this message was sent"
      });
      break;
    }
    const started = performance.now();
    let firstTokenMs: number | null = null;
    let responseCompleteMs: number | null = null;
    let postTurnSearchabilityMs: number | null = null;
    let messageToSearchabilityMs: number | null = null;
    let runId: string | null = null;
    let userEventId: string | null = null;
    let assistantEventId: string | null = null;
    let searchAttempts = 0;
    let finalSearchServerMs: number | null = null;
    let compiledSearchResultType: "claim" | "topic" | null = null;
    let error: string | null = null;
    try {
      const message = await api.json("/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `Benchmark-only memory instruction. Remember that the unique calibration label is ${marker}. Reply briefly that it was recorded.`,
          attachmentIds: [],
          quality,
          idempotencyKey: `latency-${randomUUID()}`
        }),
        timeoutMs: 30_000
      }) as { runId?: unknown; event?: { id?: unknown } };
      runId = typeof message.runId === "string" ? message.runId : null;
      userEventId = typeof message.event?.id === "string" ? message.event.id : null;
      if (!runId) throw new Error("Message response did not contain a run ID");
      await api.stream(runId, responseTimeoutMs, (event) => {
        if (event.type === "response.delta" && firstTokenMs === null && typeof event.delta === "string" && event.delta.length > 0) {
          firstTokenMs = performance.now() - started;
        }
        if (event.type === "run.completed") {
          responseCompleteMs = performance.now() - started;
          const completedEvent = event.event;
          if (typeof completedEvent === "object" && completedEvent !== null && typeof (completedEvent as { id?: unknown }).id === "string") {
            assistantEventId = (completedEvent as { id: string }).id;
          }
        }
        if (event.type === "run.failed") throw new Error(`Run failed: ${String(event.message ?? event.code ?? "unknown error")}`);
        if (event.type === "run.cancelled") throw new Error("Run was cancelled");
      });
      if (responseCompleteMs === null) throw new Error("The stream ended without run.completed");
      const completedAt = performance.now();
      const searchDeadline = completedAt + searchTimeoutMs;
      while (performance.now() <= searchDeadline) {
        searchAttempts += 1;
        const search = await api.json(`/search?q=${encodeURIComponent(marker)}&types=claim,topic&limit=30`) as ApiSearchResponse;
        finalSearchServerMs = typeof search.tookMs === "number" ? search.tookMs : null;
        const match = (search.results ?? []).find((result) => {
          const haystack = `${String(result.title ?? "")} ${String(result.snippet ?? "")}`.toLocaleLowerCase();
          return (result.type === "claim" || result.type === "topic") && haystack.includes(marker.toLocaleLowerCase());
        });
        if (match?.type === "claim" || match?.type === "topic") {
          compiledSearchResultType = match.type;
          postTurnSearchabilityMs = performance.now() - completedAt;
          messageToSearchabilityMs = performance.now() - started;
          break;
        }
        await delay(pollIntervalMs);
      }
      if (postTurnSearchabilityMs === null) {
        error = `No compiled claim/topic containing the marker became searchable within ${searchTimeoutMs} ms`;
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const after = asBudget(await api.json("/budget"));
    sampleResults.push({
      sample,
      marker,
      markerSha256,
      runId,
      userEventId,
      assistantEventId,
      firstTokenMs,
      responseCompleteMs,
      postTurnSearchabilityMs,
      messageToSearchabilityMs,
      searchAttempts,
      finalSearchServerMs,
      compiledSearchResultType,
      budgetBeforeUsd: before.spentUsd,
      budgetAfterUsd: after.spentUsd,
      recordedCostDeltaUsd: Math.max(0, after.spentUsd - before.spentUsd),
      error
    });
  }
  const budgetAfter = asBudget(await api.json("/budget"));
  const budgetCapSafe = budgetAfter.hardLimitUsd <= 100 && budgetAfter.spentUsd + budgetAfter.reservedUsd <= budgetAfter.hardLimitUsd;
  const completeSampleSet = sampleResults.length === samples && samples >= 3;
  const liveAndAttested = !mockProvider && options.normalProviderConditions === true && options.paidApiAcknowledged === true && budgetCapSafe;
  const allErrorFree = sampleResults.every((sample) => sample.error === null);
  const allFirstTokens = completeSampleSet && allErrorFree && sampleResults.every((sample) => sample.firstTokenMs !== null && sample.responseCompleteMs !== null);
  const allSearchable = completeSampleSet && allErrorFree && sampleResults.every((sample) => sample.postTurnSearchabilityMs !== null);
  const reasons: string[] = [];
  if (mockProvider) reasons.push("Mock-provider timings are local diagnostics, not normal-provider release evidence.");
  if (!options.normalProviderConditions) reasons.push("Normal provider conditions were not explicitly attested.");
  if (!mockProvider && !options.paidApiAcknowledged) reasons.push("Paid API execution was not explicitly acknowledged.");
  if (!completeSampleSet) reasons.push("Release evidence requires all requested samples and at least three completed samples.");
  if (!allErrorFree) reasons.push("At least one latency sample ended with an error.");
  if (!budgetCapSafe) reasons.push("The final application budget snapshot was not safely within the USD 100 cap.");
  if (!allFirstTokens) reasons.push("At least one sample lacked a streamed response token or completion event.");
  if (!allSearchable) reasons.push("At least one marker did not become searchable as a compiled claim/topic before timeout.");
  const core: Omit<LatencyHarnessResult, "resultHash"> = {
    schemaVersion: 1,
    evidenceClass: mockProvider ? "local-mock-diagnostic" : "live-controlled-latency",
    generatedAt: now(),
    runtime: {
      apiOrigin: options.apiOrigin,
      version: String(runtimeValue.version ?? "unknown"),
      mockProvider,
      providerReachable,
      vectorMode: String(runtimeValue.vectorMode ?? "unknown")
    },
    protocol: {
      samplesRequested: samples,
      quality,
      firstTokenStart: "immediately-before-message-post",
      searchableStart: "run-completed",
      searchableObjectTypes: ["claim", "topic"],
      pollIntervalMs,
      searchTimeoutMs
    },
    normalProviderConditionsAttested: options.normalProviderConditions === true,
    paidApiAcknowledged: options.paidApiAcknowledged === true,
    eligibility: {
      firstTokenReleaseGate: liveAndAttested && allFirstTokens,
      postTurnSearchabilityReleaseGate: liveAndAttested && allSearchable,
      reasons
    },
    budget: {
      before: budgetBefore,
      after: budgetAfter,
      recordedDeltaUsd: Math.max(0, budgetAfter.spentUsd - budgetBefore.spentUsd),
      capAtOrBelow100: budgetCapSafe
    },
    firstToken: distribution(sampleResults.map((sample) => sample.firstTokenMs)),
    responseComplete: distribution(sampleResults.map((sample) => sample.responseCompleteMs)),
    postTurnSearchability: distribution(sampleResults.map((sample) => sample.postTurnSearchabilityMs)),
    messageToSearchability: distribution(sampleResults.map((sample) => sample.messageToSearchabilityMs)),
    samples: sampleResults,
    limitations: [
      "The marker is a synthetic calibration fact written into the measured vault; use an isolated evaluation data directory.",
      "Searchability requires a derived claim or topic. A raw timeline event match does not count.",
      "This harness measures the complete local API path, retrieval, provider stream, asynchronous memory compilation, and search polling; it does not isolate network latency.",
      "The harness records application-ledger deltas but never stores the session token or provider credential."
    ]
  };
  return { ...core, resultHash: createHash("sha256").update(JSON.stringify(core)).digest("hex") };
}

function latencyRecord(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${description} must be an object`);
  return value as Record<string, unknown>;
}

function latencyNumber(value: unknown, description: string, nullable = false): number | null {
  if (nullable && value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${description} must be a finite non-negative number${nullable ? " or null" : ""}`);
  return value;
}

/** Strictly validates a persisted latency artifact and recomputes every field
 * that can make a release gate eligible. */
export function validateLatencyHarnessResult(value: unknown): LatencyHarnessResult {
  const result = latencyRecord(value, "Latency artifact");
  if (result.schemaVersion !== 1) throw new Error("Latency artifact schemaVersion must be 1");
  if (result.evidenceClass !== "local-mock-diagnostic" && result.evidenceClass !== "live-controlled-latency") throw new Error("Latency artifact evidenceClass is invalid");
  if (typeof result.resultHash !== "string" || !/^[a-f0-9]{64}$/.test(result.resultHash)) throw new Error("Latency artifact resultHash is invalid");
  const core = Object.fromEntries(Object.entries(result).filter(([key]) => key !== "resultHash"));
  const expectedHash = createHash("sha256").update(JSON.stringify(core)).digest("hex");
  if (result.resultHash !== expectedHash) throw new Error("Latency artifact resultHash does not match its content");
  if (typeof result.generatedAt !== "string" || !Number.isFinite(new Date(result.generatedAt).valueOf())) throw new Error("Latency artifact generatedAt is invalid");
  const runtime = latencyRecord(result.runtime, "Latency runtime");
  if (typeof runtime.apiOrigin !== "string") throw new Error("Latency runtime apiOrigin is invalid");
  assertLoopbackOrigin(runtime.apiOrigin);
  if (typeof runtime.mockProvider !== "boolean" || runtime.providerReachable !== true) throw new Error("Latency runtime provider state is incomplete");
  if ((result.evidenceClass === "local-mock-diagnostic") !== runtime.mockProvider) throw new Error("Latency evidenceClass does not match the runtime provider");
  if (typeof result.normalProviderConditionsAttested !== "boolean" || typeof result.paidApiAcknowledged !== "boolean") throw new Error("Latency artifact attestations are invalid");
  if (!runtime.mockProvider && result.paidApiAcknowledged !== true) throw new Error("Live latency evidence lacks paid-API acknowledgement");
  const protocol = latencyRecord(result.protocol, "Latency protocol");
  const requested = Number(protocol.samplesRequested);
  if (!Number.isInteger(requested) || requested < 1 || requested > 10) throw new Error("Latency protocol sample count is invalid");
  const samples = Array.isArray(result.samples) ? result.samples : null;
  if (!samples) throw new Error("Latency artifact samples must be an array");
  const parsedSamples = samples.map((sampleValue, index) => {
    const sample = latencyRecord(sampleValue, `Latency sample ${index + 1}`);
    if (sample.sample !== index + 1 || typeof sample.marker !== "string" || sample.marker.length === 0) throw new Error(`Latency sample ${index + 1} identity is invalid`);
    const markerHash = createHash("sha256").update(sample.marker).digest("hex");
    if (sample.markerSha256 !== markerHash) throw new Error(`Latency sample ${index + 1} marker hash is invalid`);
    const firstTokenMs = latencyNumber(sample.firstTokenMs, `Latency sample ${index + 1} firstTokenMs`, true);
    const responseCompleteMs = latencyNumber(sample.responseCompleteMs, `Latency sample ${index + 1} responseCompleteMs`, true);
    const postTurnSearchabilityMs = latencyNumber(sample.postTurnSearchabilityMs, `Latency sample ${index + 1} postTurnSearchabilityMs`, true);
    const messageToSearchabilityMs = latencyNumber(sample.messageToSearchabilityMs, `Latency sample ${index + 1} messageToSearchabilityMs`, true);
    if (firstTokenMs !== null && responseCompleteMs !== null && firstTokenMs > responseCompleteMs) throw new Error(`Latency sample ${index + 1} completes before its first token`);
    if ((sample.error !== null && typeof sample.error !== "string") || (sample.compiledSearchResultType !== null && sample.compiledSearchResultType !== "claim" && sample.compiledSearchResultType !== "topic")) throw new Error(`Latency sample ${index + 1} status is invalid`);
    const budgetBeforeUsd = latencyNumber(sample.budgetBeforeUsd, `Latency sample ${index + 1} budgetBeforeUsd`) as number;
    const budgetAfterUsd = latencyNumber(sample.budgetAfterUsd, `Latency sample ${index + 1} budgetAfterUsd`) as number;
    const recordedCostDeltaUsd = latencyNumber(sample.recordedCostDeltaUsd, `Latency sample ${index + 1} recordedCostDeltaUsd`) as number;
    if (budgetAfterUsd < budgetBeforeUsd || Math.abs(recordedCostDeltaUsd - (budgetAfterUsd - budgetBeforeUsd)) > 1e-9) throw new Error(`Latency sample ${index + 1} budget delta is inconsistent`);
    return { firstTokenMs, responseCompleteMs, postTurnSearchabilityMs, messageToSearchabilityMs, error: sample.error };
  });
  const before = asBudget(latencyRecord(result.budget, "Latency budget").before);
  const budgetRecord = latencyRecord(result.budget, "Latency budget");
  const after = asBudget(budgetRecord.after);
  const recordedDelta = latencyNumber(budgetRecord.recordedDeltaUsd, "Latency budget recordedDeltaUsd") as number;
  if (after.spentUsd < before.spentUsd || Math.abs(recordedDelta - (after.spentUsd - before.spentUsd)) > 1e-9) throw new Error("Latency artifact budget delta is inconsistent");
  const capSafe = after.hardLimitUsd <= 100 && after.spentUsd + after.reservedUsd <= after.hardLimitUsd;
  if (budgetRecord.capAtOrBelow100 !== capSafe) throw new Error("Latency artifact budget-cap assertion is inconsistent");
  const complete = parsedSamples.length === requested && requested >= 3;
  const errorFree = parsedSamples.every((sample) => sample.error === null);
  const liveEligible = result.evidenceClass === "live-controlled-latency"
    && runtime.mockProvider === false
    && result.normalProviderConditionsAttested === true
    && result.paidApiAcknowledged === true
    && complete
    && errorFree
    && capSafe;
  const expectedFirstGate = liveEligible && parsedSamples.every((sample) => sample.firstTokenMs !== null && sample.responseCompleteMs !== null);
  const expectedSearchGate = liveEligible && parsedSamples.every((sample) => sample.postTurnSearchabilityMs !== null);
  const eligibility = latencyRecord(result.eligibility, "Latency eligibility");
  if (eligibility.firstTokenReleaseGate !== expectedFirstGate || eligibility.postTurnSearchabilityReleaseGate !== expectedSearchGate) {
    throw new Error("Latency artifact release eligibility is inconsistent with its raw samples");
  }
  const expectedDistributions = {
    firstToken: distribution(parsedSamples.map((sample) => sample.firstTokenMs)),
    responseComplete: distribution(parsedSamples.map((sample) => sample.responseCompleteMs)),
    postTurnSearchability: distribution(parsedSamples.map((sample) => sample.postTurnSearchabilityMs)),
    messageToSearchability: distribution(parsedSamples.map((sample) => sample.messageToSearchabilityMs))
  };
  for (const [key, expected] of Object.entries(expectedDistributions)) {
    if (JSON.stringify(result[key]) !== JSON.stringify(expected)) throw new Error(`Latency artifact ${key} distribution does not match raw samples`);
  }
  return result as unknown as LatencyHarnessResult;
}
