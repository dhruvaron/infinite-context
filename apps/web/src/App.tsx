import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BrainCircuit } from "lucide-react";

import { ChatTimeline } from "./components/ChatTimeline";
import { Composer } from "./components/Composer";
import { KnowledgeGraph } from "./components/KnowledgeGraph";
import { DeleteImpactDialog, EntityMergeDialog, EvidenceDialog, ResetVaultDialog, ResponseRevisionsDialog, TopicDetailDialog } from "./components/MemoryDialogs";
import { MemoryInspector, TopicEditor } from "./components/MemoryInspector";
import { Onboarding } from "./components/Onboarding";
import { ToastRegion, type ToastItem } from "./components/Primitives";
import { SearchDialog } from "./components/SearchDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { TopBar } from "./components/TopBar";
import { ApiRequestError, continuumApi } from "./lib/api-client";
import { demoBootstrap } from "./lib/demo-data";
import {
  DRAFT_REVISION_KEY,
  clearAllMutationIntents,
  clearMessageIntent,
  clearRegenerationIntent,
  messageIntentMatches,
  persistMessageIntent,
  persistRegenerationIntent,
  readMessageIntent,
  readRegenerationIntent,
  type PersistedMessageIntent,
  type PersistedUploadIntent
} from "./lib/mutation-intents";
import { touchRunCache } from "./lib/run-cache";
import { DEFAULT_SETTINGS } from "./lib/types";
import type {
  AppSettings,
  AssistantRevision,
  BootstrapData,
  ConversationEvent,
  DebugSnapshot,
  EntityMergeCandidate,
  EntityMergeEnvelope,
  EntityMergeResult,
  EvidenceRecord,
  GraphResponse,
  ImpactSummary,
  MemoryReference,
  PendingAttachment,
  QualityPreset,
  RetrievalTrace,
  SearchResult,
  StreamProgress,
  TopicPage,
  TopicPageDetail,
  TopicProposal,
  VaultDeletionImpact
} from "./lib/types";

const DRAFT_KEY = "continuum.unsent-draft";
const ATTACHMENT_DEFAULT_CONTENT = "Please analyze the attached sources.";
const RUN_STREAM_CHECKPOINT_PREFIX = "continuum.run-stream.";
const IDLE_PROGRESS: StreamProgress = { runId: null, stage: "idle", label: "" };
const ACCEPTED_TYPES = new Set(["text/plain", "text/markdown", "application/json", "text/csv", "application/pdf", "image/png", "image/jpeg", "image/webp", "text/javascript", "application/javascript", "text/typescript", "application/typescript", "text/css", "text/html", "text/x-python", "text/x-c", "text/x-c++", "text/x-java-source", "text/x-go", "text/x-rust", "text/x-shellscript", "text/yaml", "application/x-yaml"]);
const INITIAL_BOOTSTRAP: BootstrapData = {
  runtime: { mode: "offline", apiReachable: false, providerReachable: false, vectorSearch: "unavailable", memoryQueue: "paused", message: "Connecting to the local Continuum service…" },
  settings: DEFAULT_SETTINGS,
  budget: { totalUsd: 0, reservedUsd: 0, allocatedUsd: 0, availableUsd: 100, activeReservations: 0, capUsd: 100, warningThresholdUsd: 20, inputTokens: 0, outputTokens: 0, extractionTokens: 0, embeddingTokens: 0, ledgerCreatedAt: null, warningThresholdsReached: [] },
  events: [], eventsNextCursor: null, activeRuns: [], topics: [], claims: [], graph: { nodes: [], edges: [], focusId: null, truncated: false }, activeMemories: [], attention: [], memoryProposals: [],
  debug: { trace: null, contextPacket: null, modelCalls: [], toolCalls: [], jobs: [], promptVersion: "—", schemaVersion: "—", versions: { prompt: "—", schema: "—", retrieval: "—", reranker: "—", contextBuilder: "—", vector: "—", parser: "—", chunker: "—", responseModel: "—", embeddingModel: "—" } }
};

type RunStreamCheckpoint = { cursor: string; assistantEventId: string | null; contentLength: number; checksum: number };

function readLocalStorage(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function pendingUploadIntent(attachment: PendingAttachment): PersistedUploadIntent {
  return {
    idempotencyKey: attachment.idempotencyKey,
    localId: attachment.localId,
    filename: attachment.file.name,
    mediaType: attachment.file.type || "application/octet-stream",
    size: attachment.remote?.size ?? attachment.file.size,
    lastModified: attachment.file.lastModified
  };
}

function recoveredPendingAttachment(intent: PersistedUploadIntent, remote: NonNullable<PendingAttachment["remote"]>): PendingAttachment {
  return {
    localId: intent.localId,
    idempotencyKey: intent.idempotencyKey,
    file: new File([], intent.filename, { type: intent.mediaType, lastModified: intent.lastModified }),
    fileUnavailable: true,
    status: remote.status === "ready" ? "ready" : "pending",
    remote
  };
}

function unavailablePendingAttachment(intent: PersistedUploadIntent): PendingAttachment {
  return {
    localId: intent.localId,
    idempotencyKey: intent.idempotencyKey,
    file: new File([], intent.filename, { type: intent.mediaType, lastModified: intent.lastModified }),
    fileUnavailable: true,
    status: "failed",
    error: "Original file bytes were lost on reload. Remove and reattach this file before sending."
  };
}

function updateStreamChecksum(checksum: number, value: string): number {
  let result = checksum >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16_777_619) >>> 0;
  }
  return result;
}

function streamChecksum(value: string): number {
  return updateStreamChecksum(2_166_136_261, value);
}

function readRunStreamCheckpoint(runId: string): RunStreamCheckpoint | null {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(`${RUN_STREAM_CHECKPOINT_PREFIX}${runId}`) ?? "null");
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as Partial<RunStreamCheckpoint>;
    if (typeof candidate.cursor !== "string" || !/^\d+$/.test(candidate.cursor) || !Number.isSafeInteger(Number(candidate.cursor))) return null;
    if (candidate.assistantEventId !== null && typeof candidate.assistantEventId !== "string") return null;
    if (!Number.isSafeInteger(candidate.contentLength) || Number(candidate.contentLength) < 0 || !Number.isSafeInteger(candidate.checksum)) return null;
    return candidate as RunStreamCheckpoint;
  } catch { return null; }
}

function writeRunStreamCheckpoint(runId: string, checkpoint: RunStreamCheckpoint): void {
  try { sessionStorage.setItem(`${RUN_STREAM_CHECKPOINT_PREFIX}${runId}`, JSON.stringify(checkpoint)); } catch { /* The in-memory cursor still protects this live connection. */ }
}

function clearRunStreamCheckpoint(runId: string): void {
  try { sessionStorage.removeItem(`${RUN_STREAM_CHECKPOINT_PREFIX}${runId}`); } catch { /* Nothing else is required for a terminal run. */ }
}

function clearAllRunStreamCheckpoints(): void {
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(RUN_STREAM_CHECKPOINT_PREFIX)) sessionStorage.removeItem(key);
    }
  } catch { /* In-memory stream state is cleared by the caller too. */ }
}

export function App() {
  const queryClient = useQueryClient();
  const bootstrapQuery = useQuery({ queryKey: ["bootstrap"], queryFn: () => continuumApi.bootstrap() });
  const budgetQuery = useQuery({ queryKey: ["budget"], queryFn: () => continuumApi.getBudgetSummary(), retry: false, refetchInterval: 15_000 });
  const data = bootstrapQuery.data ?? INITIAL_BOOTSTRAP;
  const [events, setEvents] = useState<ConversationEvent[]>(data.events);
  const [eventsCursor, setEventsCursor] = useState<string | null>(data.eventsNextCursor);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [topics, setTopics] = useState<TopicPage[]>(data.topics);
  const [, setClaims] = useState(data.claims);
  const [graph, setGraph] = useState<GraphResponse>(data.graph);
  const [graphRequest, setGraphRequest] = useState<{ hops: 1 | 2; includeHistory: boolean }>({ hops: 1, includeHistory: false });
  const [debugSnapshot, setDebugSnapshot] = useState<DebugSnapshot>(data.debug);
  const [memoryProposals, setMemoryProposals] = useState<TopicProposal[]>(data.memoryProposals);
  const [settings, setSettings] = useState<AppSettings>(data.settings);
  const [memories, setMemories] = useState(data.activeMemories);
  const [draft, setDraftState] = useState(() => readLocalStorage(DRAFT_KEY) ?? "");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [progress, setProgress] = useState<StreamProgress>(IDLE_PROGRESS);
  const [drawer, setDrawer] = useState<"memory" | "graph" | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [topicDetail, setTopicDetail] = useState<TopicPageDetail | null>(null);
  const [topicEditor, setTopicEditor] = useState<TopicPage | null>(null);
  const [highlightedEventId, setHighlightedEventId] = useState<string | null>(null);
  const [revealedEventIds, setRevealedEventIds] = useState<Set<string>>(() => new Set());
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<{ resource: "events" | "attachments" | "claims" | "topics"; id: string; title: string } | null>(null);
  const [deleteImpact, setDeleteImpact] = useState<ImpactSummary | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [vaultImpact, setVaultImpact] = useState<VaultDeletionImpact | null>(null);
  const [vaultImpactLoading, setVaultImpactLoading] = useState(false);
  const [vaultImpactError, setVaultImpactError] = useState<string | null>(null);
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [evidenceRecord, setEvidenceRecord] = useState<EvidenceRecord | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeCandidates, setMergeCandidates] = useState<EntityMergeCandidate[]>([]);
  const [mergeLoading, setMergeLoading] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<"memory" | "debug">("memory");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(data.debug.trace?.runId ?? null);
  const [tracesByRunId, setTracesByRunId] = useState<Record<string, RetrievalTrace>>(() => data.debug.trace ? { [data.debug.trace.runId]: data.debug.trace } : {});
  const [referencesByRunId, setReferencesByRunId] = useState<Record<string, MemoryReference[]>>(() => data.debug.trace ? { [data.debug.trace.runId]: data.activeMemories } : {});
  const [debugByRunId, setDebugByRunId] = useState<Record<string, DebugSnapshot>>(() => data.debug.trace ? { [data.debug.trace.runId]: data.debug } : {});
  const [loadingTraceRunIds, setLoadingTraceRunIds] = useState<Set<string>>(() => new Set());
  const [revisionEventId, setRevisionEventId] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<AssistantRevision[]>([]);
  const [revisionsLoading, setRevisionsLoading] = useState(false);
  const [revisionsError, setRevisionsError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const streamingEventRef = useRef<string | null>(null);
  const retryParentRef = useRef<string | null>(null);
  const cancellationAcknowledgedRef = useRef(false);
  const hydratedRealRef = useRef(false);
  const selectedRunIdRef = useRef<string | null>(data.debug.trace?.runId ?? null);
  const activeStreamRunIdsRef = useRef<Set<string>>(new Set());
  const terminalStreamRunIdsRef = useRef<Set<string>>(new Set());
  const draftRevisionRef = useRef<string | null>(readLocalStorage(DRAFT_REVISION_KEY));
  const mutationRecoveryAttemptedRef = useRef<Set<string>>(new Set());
  const memoryPollRunIdsRef = useRef<Set<string>>(new Set());
  const vaultUiGenerationRef = useRef(0);

  useEffect(() => { selectedRunIdRef.current = selectedRunId; }, [selectedRunId]);

  useEffect(() => {
    if (!bootstrapQuery.data || bootstrapQuery.isPlaceholderData || previewMode) return;
    const resolved = bootstrapQuery.data;
    const firstRealHydration = !hydratedRealRef.current;
    hydratedRealRef.current = true;
    setEvents((current) => {
      if (firstRealHydration) return resolved.events;
      const liveAssistantIds = new Set(resolved.activeRuns
        .filter((run) => activeStreamRunIdsRef.current.has(run.id) && run.assistantEventId)
        .map((run) => run.assistantEventId as string));
      if (!liveAssistantIds.size) return resolved.events;
      const currentById = new Map(current.map((event) => [event.id, event]));
      const resolvedIds = new Set(resolved.events.map((event) => event.id));
      return [
        ...resolved.events.map((event) => liveAssistantIds.has(event.id) ? currentById.get(event.id) ?? event : event),
        ...current.filter((event) => liveAssistantIds.has(event.id) && !resolvedIds.has(event.id))
      ].sort((left, right) => left.sequence - right.sequence);
    });
    setEventsCursor(resolved.eventsNextCursor);
    setTopics(resolved.topics);
    setClaims(resolved.claims);
    setGraph(resolved.graph);
    setDebugSnapshot(resolved.debug);
    setMemoryProposals(resolved.memoryProposals);
    setSettings(resolved.settings);
    setMemories(resolved.activeMemories);
    const trace = resolved.debug.trace;
    if (resolved.runtime.mode === "offline") {
      setTracesByRunId({});
      setReferencesByRunId({});
      setDebugByRunId({});
      setSelectedRunId(null);
    } else if (trace) {
      setTracesByRunId((current) => firstRealHydration ? { [trace.runId]: trace } : touchRunCache(current, trace.runId, trace));
      setReferencesByRunId((current) => firstRealHydration ? { [trace.runId]: resolved.activeMemories } : touchRunCache(current, trace.runId, resolved.activeMemories));
      setDebugByRunId((current) => firstRealHydration
        ? { [trace.runId]: resolved.debug }
        : touchRunCache(current, trace.runId, current[trace.runId] ?? resolved.debug));
      setSelectedRunId((current) => firstRealHydration ? trace.runId : current ?? trace.runId);
    } else if (firstRealHydration) {
      setTracesByRunId({});
      setReferencesByRunId({});
      setDebugByRunId({});
      setSelectedRunId(null);
    }
    const canOnboard = resolved.runtime.mode === "connected" || resolved.runtime.mode === "degraded";
    setOnboardingOpen(!resolved.settings.onboardingComplete && canOnboard);
  }, [bootstrapQuery.data, bootstrapQuery.isPlaceholderData, previewMode]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.dataset.theme = settings.theme === "system" ? (media.matches ? "dark" : "light") : settings.theme;
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [settings.theme]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (!document.querySelector('[aria-modal="true"]')) setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const addToast = useCallback((tone: ToastItem["tone"], title: string, message?: string) => {
    const id = crypto.randomUUID();
    const toast: ToastItem = message === undefined ? { id, tone, title } : { id, tone, title, message };
    setToasts((items) => [...items, toast]);
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 5000);
  }, []);

  const ensureDraftRevision = (exactContent: string): string | null => {
    const revision = draftRevisionRef.current ?? crypto.randomUUID();
    draftRevisionRef.current = revision;
    try {
      if (exactContent) localStorage.setItem(DRAFT_KEY, exactContent); else localStorage.removeItem(DRAFT_KEY);
      localStorage.setItem(DRAFT_REVISION_KEY, revision);
      if (localStorage.getItem(DRAFT_REVISION_KEY) !== revision) return null;
      if ((localStorage.getItem(DRAFT_KEY) ?? "") !== exactContent) return null;
      return revision;
    } catch {
      return null;
    }
  };

  const setDraft = (value: string) => {
    setDraftState(value);
    const revision = crypto.randomUUID();
    draftRevisionRef.current = revision;
    try {
      localStorage.setItem(DRAFT_REVISION_KEY, revision);
      if (value) localStorage.setItem(DRAFT_KEY, value); else localStorage.removeItem(DRAFT_KEY);
    } catch {
      // Sending is refused below if the exact retry identity cannot be stored.
    }
  };

  const resetVaultScopedUiState = useCallback(() => {
    vaultUiGenerationRef.current += 1;
    continuumApi.resetVaultReadScope();
    void queryClient.cancelQueries({ queryKey: ["bootstrap"] });
    void queryClient.cancelQueries({ queryKey: ["budget"] });
    abortRef.current?.abort();
    abortRef.current = null;
    for (const attachment of attachments) if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    setAttachments([]);
    clearAllMutationIntents();
    clearAllRunStreamCheckpoints();
    streamingEventRef.current = null;
    retryParentRef.current = null;
    cancellationAcknowledgedRef.current = false;
    activeStreamRunIdsRef.current.clear();
    terminalStreamRunIdsRef.current.clear();
    memoryPollRunIdsRef.current.clear();
    mutationRecoveryAttemptedRef.current.clear();
    const nextDraftRevision = crypto.randomUUID();
    try {
      draftRevisionRef.current = nextDraftRevision;
      localStorage.setItem(DRAFT_REVISION_KEY, nextDraftRevision);
      if (draft) localStorage.setItem(DRAFT_KEY, draft); else localStorage.removeItem(DRAFT_KEY);
    } catch {
      draftRevisionRef.current = null;
      setDraftState("");
      try { localStorage.removeItem(DRAFT_KEY); localStorage.removeItem(DRAFT_REVISION_KEY); } catch { /* Browser storage is unavailable; no old mutation identity remains in memory. */ }
    }
    selectedRunIdRef.current = null;
    setProgress(IDLE_PROGRESS);
    setEvents([]);
    setEventsCursor(null);
    setTopics([]);
    setClaims([]);
    setMemories([]);
    setMemoryProposals([]);
    setGraph({ nodes: [], edges: [], focusId: null, truncated: false });
    setGraphRequest({ hops: 1, includeHistory: false });
    setDebugSnapshot(INITIAL_BOOTSTRAP.debug);
    setTracesByRunId({});
    setReferencesByRunId({});
    setDebugByRunId({});
    setLoadingTraceRunIds(new Set());
    setSelectedRunId(null);
    setDrawer(null);
    setSearchOpen(false);
    setHighlightedEventId(null);
    setRevealedEventIds(new Set());
    setTopicDetail(null);
    setTopicEditor(null);
    setDeleteTarget(null);
    setDeleteImpact(null);
    setDeleteLoading(false);
    setRevisionEventId(null);
    setRevisions([]);
    setRevisionsLoading(false);
    setRevisionsError(null);
    setEvidenceOpen(false);
    setEvidenceRecord(null);
    setEvidenceLoading(false);
    setEvidenceError(null);
    setMergeOpen(false);
    setMergeCandidates([]);
    setMergeLoading(false);
    setMergeError(null);
    setPreviewMode(false);
    setOnboardingOpen(false);
  }, [attachments, draft, queryClient]);

  const clearCommittedDraft = useCallback((intent: PersistedMessageIntent) => {
    if (readLocalStorage(DRAFT_REVISION_KEY) !== intent.draftRevisionId) return;
    const committedDraft = readLocalStorage(DRAFT_KEY) ?? "";
    try {
      localStorage.removeItem(DRAFT_KEY);
      localStorage.removeItem(DRAFT_REVISION_KEY);
    } catch { /* The durable event is already safe; stale browser draft cleanup can be retried manually. */ }
    if (draftRevisionRef.current === intent.draftRevisionId) draftRevisionRef.current = null;
    setDraftState((current) => current === committedDraft ? "" : current);
  }, []);

  const isDemo = previewMode || data.runtime.mode === "demo";
  const runtime = previewMode ? { ...demoBootstrap.runtime, message: "Temporary immutable preview — your vault is unchanged" } : data.runtime;
  const offline = runtime.mode === "offline";
  const currentBudget = previewMode ? demoBootstrap.budget : budgetQuery.data ?? data.budget;

  useEffect(() => {
    if (previewMode || offline) return;
    const latest = currentBudget.warningThresholdsReached.at(-1);
    if (!latest) return;
    const key = `continuum.lifetime-budget-warning.${latest}`;
    try {
      if (localStorage.getItem(key) === "shown") return;
      localStorage.setItem(key, "shown");
    } catch { /* A visible toast is still safer than suppressing the warning. */ }
    addToast("warning", `$${latest} lifetime API-credit threshold reached`, `$${currentBudget.allocatedUsd.toFixed(2)} is spent or reserved for this installation; $${currentBudget.availableUsd.toFixed(2)} remains before the hard stop.`);
  }, [addToast, currentBudget.allocatedUsd, currentBudget.availableUsd, currentBudget.warningThresholdsReached, offline, previewMode]);

  const loadRunTrace = useCallback(async (runId: string, openInspector = false) => {
    const generation = vaultUiGenerationRef.current;
    const cachedTrace = tracesByRunId[runId];
    const cachedReferences = referencesByRunId[runId];
    const cachedDebug = debugByRunId[runId];
    if (cachedTrace) setTracesByRunId((current) => touchRunCache(current, runId, cachedTrace));
    if (cachedReferences) setReferencesByRunId((current) => touchRunCache(current, runId, cachedReferences));
    if (cachedDebug) setDebugByRunId((current) => touchRunCache(current, runId, cachedDebug));
    if (openInspector) {
      selectedRunIdRef.current = runId;
      setSelectedRunId(runId);
      setInspectorTab("debug");
      setDrawer("memory");
      if (cachedReferences) setMemories(cachedReferences);
    }
    // Retrieval completion may cache a deliberately partial run snapshot before
    // response/model/job records have reached their terminal state. Opening the
    // inspector is an explicit request for the complete, run-bound audit record,
    // so refresh debug data even when trace/reference data is already cached.
    if (cachedTrace && cachedReferences && cachedDebug && !openInspector) return;
    if (isDemo) {
      const source = demoBootstrap.debug.trace;
      if (!source) return;
      const trace = { ...source, id: crypto.randomUUID(), runId };
      const references = demoBootstrap.activeMemories;
      setTracesByRunId((current) => touchRunCache(current, runId, trace));
      setReferencesByRunId((current) => touchRunCache(current, runId, references));
      setDebugByRunId((current) => touchRunCache(current, runId, { ...demoBootstrap.debug, trace, contextPacket: demoBootstrap.debug.contextPacket ? { ...demoBootstrap.debug.contextPacket, runId } : null, modelCalls: demoBootstrap.debug.modelCalls.map((call) => ({ ...call, runId })), toolCalls: demoBootstrap.debug.toolCalls.map((call) => ({ ...call, runId })) }));
      if (openInspector && selectedRunIdRef.current === runId) setMemories(references);
      return;
    }
    setLoadingTraceRunIds((current) => new Set(current).add(runId));
    try {
      const [debugResult, traceResult] = await Promise.allSettled([
        cachedDebug && !openInspector ? Promise.resolve(cachedDebug) : continuumApi.getRunDebug(runId),
        cachedTrace ? Promise.resolve(cachedTrace) : continuumApi.getRetrievalTrace(runId)
      ]);
      if (vaultUiGenerationRef.current !== generation) return;
      const runDebug = debugResult.status === "fulfilled" ? debugResult.value : null;
      const trace = traceResult.status === "fulfilled" ? traceResult.value : runDebug?.trace;
      if (!trace) throw traceResult.status === "rejected" ? traceResult.reason : new Error("The answer has no retrieval trace.");
      const references = traceToMemoryReferences(trace, memories);
      setTracesByRunId((current) => touchRunCache(current, runId, trace));
      setReferencesByRunId((current) => touchRunCache(current, runId, references));
      if (runDebug) setDebugByRunId((current) => touchRunCache(current, runId, { ...runDebug, trace }));
      if (debugResult.status === "rejected" && openInspector) addToast("warning", "Some answer diagnostics are unavailable", debugResult.reason instanceof Error ? debugResult.reason.message : "The exact context packet and tool calls could not be loaded.");
      if (openInspector && selectedRunIdRef.current === runId) setMemories(references);
    } catch (error) {
      if (vaultUiGenerationRef.current !== generation) return;
      if (openInspector) addToast("danger", "Provenance could not be loaded", error instanceof Error ? error.message : undefined);
    } finally {
      if (vaultUiGenerationRef.current === generation) setLoadingTraceRunIds((current) => { const next = new Set(current); next.delete(runId); return next; });
    }
  }, [addToast, debugByRunId, isDemo, memories, referencesByRunId, tracesByRunId]);

  const refreshDurableMemory = useCallback(async () => {
    const generation = vaultUiGenerationRef.current;
    try {
      const refreshed = await continuumApi.refreshMemoryState();
      if (vaultUiGenerationRef.current !== generation) return null;
      setTopics(refreshed.topics);
      setClaims(refreshed.claims);
      setGraph(refreshed.graph);
      setDebugSnapshot((current) => ({ ...current, jobs: refreshed.jobs }));
      return refreshed;
    } catch (error) {
      if (vaultUiGenerationRef.current !== generation) return null;
      addToast("warning", "Memory finished, but its status could not be refreshed", error instanceof Error ? error.message : undefined);
      return null;
    }
  }, [addToast]);

  const refreshMemoryProposals = useCallback(async () => {
    if (isDemo) { setMemoryProposals(demoBootstrap.memoryProposals); return demoBootstrap.memoryProposals; }
    const generation = vaultUiGenerationRef.current;
    try {
      const proposals = await continuumApi.listMemoryProposals();
      if (vaultUiGenerationRef.current !== generation) return null;
      setMemoryProposals(proposals);
      return proposals;
    } catch (error) {
      if (vaultUiGenerationRef.current !== generation) return null;
      addToast("warning", "Memory proposals could not be refreshed", error instanceof Error ? error.message : undefined);
      return null;
    }
  }, [addToast, isDemo]);

  const resolveMemoryProposal = useCallback(async (proposal: TopicProposal, action: "accept" | "reject") => {
    if (isDemo) { setMemoryProposals((current) => current.filter((item) => item.id !== proposal.id)); return; }
    const generation = vaultUiGenerationRef.current;
    try {
      await continuumApi.resolveMemoryProposal(proposal.id, action);
      if (vaultUiGenerationRef.current !== generation) return;
      setMemoryProposals((current) => current.filter((item) => item.id !== proposal.id));
      await Promise.all([refreshDurableMemory(), refreshMemoryProposals()]);
      if (vaultUiGenerationRef.current !== generation) return;
      addToast("success", action === "accept" ? "Memory proposal accepted" : "Memory proposal rejected", proposal.title);
    } catch (error) {
      if (vaultUiGenerationRef.current !== generation) return;
      addToast("danger", "Memory proposal was not changed", error instanceof Error ? error.message : undefined);
      throw error;
    }
  }, [addToast, isDemo, refreshDurableMemory, refreshMemoryProposals]);

  const pollDurableMemory = useCallback(async (runId?: string) => {
    if (isDemo) return;
    if (runId && settings.memoryPaused) { await refreshDurableMemory(); return; }
    const generation = vaultUiGenerationRef.current;
    const pollKey = `${generation}:${runId ?? "__general__"}`;
    if (memoryPollRunIdsRef.current.has(pollKey)) return;
    memoryPollRunIdsRef.current.add(pollKey);
    let observedWork = false;
    let lastPollError: unknown = null;
    try {
      await wait(350);
      for (let attempt = 0; attempt < 15; attempt += 1) {
        if (vaultUiGenerationRef.current !== generation) return;
        try {
          const jobs = await continuumApi.getMemoryJobs(runId);
          if (vaultUiGenerationRef.current !== generation) return;
          setDebugSnapshot((current) => ({
            ...current,
            jobs: runId
              ? [...jobs, ...current.jobs.filter((existing) => !jobs.some((job) => job.id === existing.id))].slice(0, 100)
              : jobs
          }));
          lastPollError = null;
          if (runId) {
            const job = jobs.find((candidate) => candidate.runId === runId && candidate.name === "memory compile");
            if (job) {
              observedWork = true;
              if (job.status === "complete") { await refreshDurableMemory(); return; }
              if (job.status === "failed" || job.status === "cancelled") {
                await refreshDurableMemory();
                addToast("danger", "Long-term memory update failed", job.lastErrorCode ? `Run ${runId.slice(0, 8)} failed with ${job.lastErrorCode}. Retry it from Memory debug.` : `Run ${runId.slice(0, 8)} reached ${job.status} state. Retry it from Memory debug.`);
                return;
              }
            }
          } else {
            const working = jobs.some((job) => job.status === "queued" || job.status === "running");
            observedWork ||= working;
            if ((observedWork && !working) || (!observedWork && attempt >= 3)) { await refreshDurableMemory(); return; }
          }
        } catch (error) {
          lastPollError = error;
        }
        if (attempt < 14) await wait(Math.min(8_000, Math.round(500 * 1.7 ** attempt)));
      }
      if (vaultUiGenerationRef.current !== generation) return;
      await refreshDurableMemory();
      addToast(
        "warning",
        runId ? "Long-term memory update timed out" : "Memory refresh timed out",
        lastPollError instanceof Error
          ? lastPollError.message
          : runId
            ? observedWork
              ? `The memory job for run ${runId.slice(0, 8)} is still non-terminal. Its status remains available in Memory debug.`
              : `No memory job for run ${runId.slice(0, 8)} appeared before the bounded polling window ended.`
            : "Background memory work did not reach a terminal state before the bounded polling window ended."
      );
    } finally {
      memoryPollRunIdsRef.current.delete(pollKey);
    }
  }, [addToast, isDemo, refreshDurableMemory, settings.memoryPaused]);

  const openRevisions = async (eventId: string) => {
    const generation = vaultUiGenerationRef.current;
    setRevisionEventId(eventId);
    setRevisions([]);
    setRevisionsError(null);
    setRevisionsLoading(true);
    try {
      if (isDemo) {
        const event = events.find((candidate) => candidate.id === eventId);
        setRevisions(event ? [{ event, revisionNumber: 1, active: event.active, quality: settings.quality }] : []);
      } else {
        const loaded = await continuumApi.getEventRevisions(eventId);
        if (vaultUiGenerationRef.current !== generation) return;
        setRevisions(loaded.revisions);
      }
    } catch (error) {
      if (vaultUiGenerationRef.current !== generation) return;
      setRevisionsError(error instanceof Error ? error.message : "Revision history could not be loaded.");
    } finally {
      if (vaultUiGenerationRef.current === generation) setRevisionsLoading(false);
    }
  };

  const activateRevision = async (eventId: string) => {
    if (isDemo) {
      setRevisions((items) => items.map((revision) => ({ ...revision, active: revision.event.id === eventId, event: { ...revision.event, active: revision.event.id === eventId } })));
      return;
    }
    const generation = vaultUiGenerationRef.current;
    const { event } = await continuumApi.activateEventRevision(eventId);
    if (vaultUiGenerationRef.current !== generation) return;
    const groupIds = new Set(revisions.map((revision) => revision.event.id));
    setEvents((items) => items.map((item) => groupIds.has(item.id) ? { ...item, active: item.id === event.id } : item).map((item) => item.id === event.id ? event : item));
    const refreshed = await continuumApi.getEventRevisions(event.id);
    if (vaultUiGenerationRef.current !== generation) return;
    setRevisions(refreshed.revisions);
    addToast("success", "Active response revision changed", "Retrieval will use the selected answer revision.");
  };

  const updateSettings = async (patch: Partial<AppSettings>, quiet = false) => {
    const generation = vaultUiGenerationRef.current;
    const previous = settings;
    setSettings((value) => ({ ...value, ...patch }));
    if (isDemo) { setSettings((value) => ({ ...value, ...patch })); if (!quiet) addToast("success", "Settings saved for this preview"); return; }
    try { const saved = await continuumApi.saveSettings(patch); if (vaultUiGenerationRef.current !== generation) return; setSettings(saved); if (!quiet) addToast("success", "Settings saved"); }
    catch (error) { if (vaultUiGenerationRef.current !== generation) return; setSettings(previous); addToast("danger", "Settings could not be saved", error instanceof Error ? error.message : undefined); throw error; }
  };

  const addFiles = (files: File[]) => {
    const currentTotal = attachments.reduce((sum, item) => sum + item.file.size, 0);
    const next: PendingAttachment[] = [];
    let total = currentTotal;
    for (const file of files) {
      const extensionAllowed = /\.(txt|md|markdown|mdx|json|csv|pdf|png|jpe?g|webp|[cm]?js|jsx|[cm]?ts|tsx|py|c|h|cc|cpp|hpp|go|rs|java|sh|bash|ya?ml|css|html?)$/i.test(file.name);
      if ((!ACCEPTED_TYPES.has(file.type) && !extensionAllowed) || file.size > 25 * 1024 * 1024) { addToast("warning", `Could not attach ${file.name}`, file.size > 25 * 1024 * 1024 ? "Each file must be 25 MB or smaller." : "That file type is not supported in v1."); continue; }
      if (total + file.size > 100 * 1024 * 1024) { addToast("warning", "Attachment limit reached", "A message can contain at most 100 MB of files."); break; }
      if (attachments.length + next.length >= 20) { addToast("warning", "Attachment limit reached", "A message can contain at most 20 files."); break; }
      total += file.size;
      const base = { localId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID(), file, status: "pending" as const };
      next.push(file.type.startsWith("image/") ? { ...base, previewUrl: URL.createObjectURL(file) } : base);
    }
    setAttachments((items) => [...items, ...next]);
  };

  const removeAttachment = (localId: string) => {
    setAttachments((items) => {
      const item = items.find((candidate) => candidate.localId === localId);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return items.filter((candidate) => candidate.localId !== localId);
    });
  };

  const nextSequence = () => Math.max(0, ...events.map((event) => event.sequence)) + 1;
  const provisionalAttachment = (attachment: PendingAttachment) => attachment.remote ?? ({ id: crypto.randomUUID(), sourceId: crypto.randomUUID(), filename: attachment.file.name, mediaType: attachment.file.type || "application/octet-stream", size: attachment.file.size, status: "queued" as const, createdAt: new Date().toISOString() });

  const handleStreamEvent = useCallback((streamEvent: Parameters<NonNullable<Parameters<typeof continuumApi.streamRun>[1]["onEvent"]>>[0]) => {
    switch (streamEvent.type) {
      case "run.started": setProgress({ runId: streamEvent.runId, stage: "retrieving", label: "Looking through relevant history…" }); break;
      case "retrieval.started": setProgress({ runId: streamEvent.runId, stage: "retrieving", label: "Selecting exact evidence…" }); break;
      case "retrieval.completed":
        setProgress({ runId: streamEvent.runId, stage: "responding", label: `Grounded in ${streamEvent.selectedCount} memory sources…` });
        void loadRunTrace(streamEvent.runId);
        break;
      case "tool.started": setProgress({ runId: streamEvent.runId, stage: "tool", label: `Using ${streamEvent.name}…`, activeTool: streamEvent.name }); break;
      case "tool.completed": setProgress({ runId: streamEvent.runId, stage: "responding", label: "Writing a grounded answer…" }); break;
      case "response.delta": {
        streamingEventRef.current ??= streamEvent.eventId;
        setProgress({ runId: streamEvent.runId, stage: "responding", label: "Writing a grounded answer…" });
        setEvents((items) => {
          const existing = items.find((item) => item.id === streamEvent.eventId || item.id === streamingEventRef.current);
          if (existing) return items.map((item) => item.id === existing.id ? { ...item, id: streamEvent.eventId, content: item.content + streamEvent.delta, status: "streaming" } : item);
          return [...items, { id: streamEvent.eventId, sequence: Math.max(0, ...items.map((item) => item.sequence)) + 1, role: "assistant", kind: "message", status: "streaming", content: streamEvent.delta, parentEventId: items.at(-1)?.id ?? null, runId: streamEvent.runId, active: true, createdAt: new Date().toISOString(), completedAt: null, attachments: [] }];
        });
        break;
      }
      case "run.completed":
        setEvents((items) => [...items.filter((item) => item.id !== streamEvent.event.id && item.id !== streamingEventRef.current), streamEvent.event].sort((a, b) => a.sequence - b.sequence));
        streamingEventRef.current = null;
        retryParentRef.current = null;
        setProgress(IDLE_PROGRESS);
        addToast("success", "Answer complete", `$${streamEvent.usage.estimatedCostUsd.toFixed(3)} · ${streamEvent.usage.inputTokens.toLocaleString()} input tokens`);
        void bootstrapQuery.refetch();
        void budgetQuery.refetch();
        void pollDurableMemory(streamEvent.runId);
        break;
      case "run.cancelled":
        {
        const generation = vaultUiGenerationRef.current;
        cancellationAcknowledgedRef.current = true;
        setEvents((items) => items.map((item) => item.id === streamingEventRef.current ? { ...item, status: "incomplete", completedAt: new Date().toISOString() } : item));
        streamingEventRef.current = null;
        setProgress({ runId: null, stage: "cancelled", label: "Response stopped" });
        window.setTimeout(() => { if (vaultUiGenerationRef.current === generation) setProgress(IDLE_PROGRESS); }, 1200);
        break;
        }
      case "run.failed":
        setEvents((items) => items.map((item) => item.id === streamingEventRef.current ? { ...item, status: "failed", completedAt: new Date().toISOString() } : item));
        streamingEventRef.current = null;
        setProgress({ runId: streamEvent.runId, stage: "failed", label: streamEvent.message });
        addToast("danger", "Response failed", streamEvent.message);
        break;
      case "memory.updated":
        addToast("info", "Long-term memory updated", `${streamEvent.topicIds.length} topic page${streamEvent.topicIds.length === 1 ? "" : "s"} refreshed.`);
        void refreshDurableMemory();
        break;
    }
  }, [addToast, bootstrapQuery, budgetQuery, loadRunTrace, pollDurableMemory, refreshDurableMemory]);

  const streamExistingRun = useCallback(async (runId: string, resume: { lastEventId?: string | null; assistantEventId?: string | null; initialContent?: string } = {}) => {
    if (activeStreamRunIdsRef.current.has(runId) || terminalStreamRunIdsRef.current.has(runId)) return;
    const generation = vaultUiGenerationRef.current;
    activeStreamRunIdsRef.current.add(runId);
    const controller = new AbortController();
    abortRef.current = controller;
    setProgress({ runId, stage: "retrieving", label: "Looking through relevant history…" });
    let terminal = false;
    let assistantEventId = resume.assistantEventId ?? null;
    const initialContent = resume.initialContent ?? "";
    let contentLength = initialContent.length;
    let checksum = streamChecksum(initialContent);
    try {
      const result = await continuumApi.streamRun(runId, {
        onEvent: (event) => {
          if (vaultUiGenerationRef.current !== generation) return;
          if (event.type === "response.delta") {
            if (assistantEventId !== null && assistantEventId !== event.eventId) {
              contentLength = 0;
              checksum = streamChecksum("");
            }
            assistantEventId = event.eventId;
            contentLength += event.delta.length;
            checksum = updateStreamChecksum(checksum, event.delta);
          }
          terminal = ["run.completed", "run.failed", "run.cancelled"].includes(event.type);
          handleStreamEvent(event);
        },
        onCursor: (cursor) => { if (vaultUiGenerationRef.current === generation) writeRunStreamCheckpoint(runId, { cursor, assistantEventId, contentLength, checksum }); },
        onMalformed: () => { if (vaultUiGenerationRef.current === generation) addToast("warning", "A malformed stream event was ignored"); },
        onReconnect: () => { if (vaultUiGenerationRef.current === generation) setProgress((current) => current.runId === runId ? { ...current, label: "Connection interrupted — reconnecting to this response…" } : current); }
      }, controller.signal, { lastEventId: resume.lastEventId ?? null });
      if (vaultUiGenerationRef.current !== generation) return;
      terminal ||= result.terminal;
      if (!terminal && !controller.signal.aborted) throw new ApiRequestError("The response stream closed before completion.", "STREAM_INTERRUPTED", true);
      if (terminal) {
        terminalStreamRunIdsRef.current.add(runId);
        clearRunStreamCheckpoint(runId);
      }
    } finally {
      if (vaultUiGenerationRef.current === generation) activeStreamRunIdsRef.current.delete(runId);
    }
  }, [addToast, handleStreamEvent]);

  const markRunConnectionLost = useCallback((runId: string, error: unknown) => {
    setProgress({ runId, stage: "connection_lost", label: "Connection lost. This response may still be running; resume it or stop it before sending another message." });
    addToast("warning", "Response connection lost", error instanceof Error ? `${error.message} The saved stream cursor will be used when you resume.` : "The saved stream cursor will be used when you resume.");
  }, [addToast]);

  useEffect(() => {
    if (!bootstrapQuery.data || bootstrapQuery.isPlaceholderData || previewMode || offline) return;
    const activeRun = bootstrapQuery.data.activeRuns.find((run) => !activeStreamRunIdsRef.current.has(run.id) && !terminalStreamRunIdsRef.current.has(run.id));
    if (!activeRun) return;
    const assistantEvent = activeRun.assistantEventId
      ? bootstrapQuery.data.events.find((event) => event.id === activeRun.assistantEventId)
      : undefined;
    const checkpoint = readRunStreamCheckpoint(activeRun.id);
    const checkpointMatches = checkpoint !== null
      && checkpoint.assistantEventId === (activeRun.assistantEventId ?? null)
      && checkpoint.contentLength === (assistantEvent?.content.length ?? 0)
      && checkpoint.checksum === streamChecksum(assistantEvent?.content ?? "");
    if (activeRun.assistantEventId) {
      streamingEventRef.current = activeRun.assistantEventId;
      if (!checkpointMatches) {
        clearRunStreamCheckpoint(activeRun.id);
        setEvents((items) => items.map((event) => event.id === activeRun.assistantEventId ? { ...event, content: "", status: "streaming" } : event));
      }
    }
    const generation = vaultUiGenerationRef.current;
    void streamExistingRun(activeRun.id, {
      lastEventId: checkpointMatches ? checkpoint.cursor : null,
      assistantEventId: activeRun.assistantEventId,
      initialContent: checkpointMatches ? assistantEvent?.content ?? "" : ""
    }).catch((error) => {
      if (vaultUiGenerationRef.current !== generation) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      markRunConnectionLost(activeRun.id, error);
    });
  }, [bootstrapQuery.data, bootstrapQuery.isPlaceholderData, markRunConnectionLost, offline, previewMode, streamExistingRun]);

  useEffect(() => {
    if (!bootstrapQuery.data || bootstrapQuery.isPlaceholderData || previewMode || offline) return;
    const messageIntent = readMessageIntent();
    const regenerationIntent = readRegenerationIntent();
    if (!messageIntent && !regenerationIntent) return;
    let cancelled = false;
    const generation = vaultUiGenerationRef.current;
    const stale = () => cancelled || vaultUiGenerationRef.current !== generation;

    const recoverPersistedIntents = async () => {
      if (messageIntent && !mutationRecoveryAttemptedRef.current.has(messageIntent.idempotencyKey)) {
        mutationRecoveryAttemptedRef.current.add(messageIntent.idempotencyKey);
        try {
          const recoveredMessage = await continuumApi.recoverMutation("messages.create", messageIntent.idempotencyKey);
          if (stale()) return;
          if (recoveredMessage.found && recoveredMessage.operation === "messages.create") {
            clearMessageIntent(messageIntent.idempotencyKey);
            clearCommittedDraft(messageIntent);
            setAttachments([]);
            setEvents((items) => [...items.filter((item) => item.id !== recoveredMessage.result.event.id), recoveredMessage.result.event].sort((left, right) => left.sequence - right.sequence));
            retryParentRef.current = recoveredMessage.result.event.id;
            addToast("info", "Recovered a safely saved message", "The original request was committed before the connection was lost; no duplicate was created.");
            void streamExistingRun(recoveredMessage.result.runId).catch((error) => {
              if (stale()) return;
              if (error instanceof DOMException && error.name === "AbortError") return;
              markRunConnectionLost(recoveredMessage.result.runId, error);
            });
            return;
          }

          const storedRevision = readLocalStorage(DRAFT_REVISION_KEY);
          const storedDraft = readLocalStorage(DRAFT_KEY) ?? "";
          const draftAvailable = storedRevision === messageIntent.draftRevisionId
            && (messageIntent.contentKind === "attachment-default" || storedDraft.length > 0);
          if (!draftAvailable) {
            clearMessageIntent(messageIntent.idempotencyKey);
            setProgress({ runId: null, stage: "failed", label: "The prior message was not committed, and its exact browser draft is no longer available." });
            addToast("warning", "An uncommitted message could not be restored", "No durable message was created. Your current draft, if any, was left unchanged.");
            return;
          }

          const uploadResults = await Promise.allSettled(messageIntent.attachments.map((attachment) => continuumApi.recoverMutation("attachments.upload", attachment.idempotencyKey)));
          if (stale()) return;
          if (uploadResults.some((result) => result.status === "rejected")) {
            mutationRecoveryAttemptedRef.current.delete(messageIntent.idempotencyKey);
            setProgress({ runId: null, stage: "failed", label: "Continuum could not yet verify the interrupted upload. Reconnect before retrying." });
            addToast("warning", "Interrupted delivery is still being checked", "The original retry keys remain stored; Continuum will not create a second message or upload while the result is uncertain.");
            return;
          }
          const recoveredAttachments: PendingAttachment[] = [];
          const unavailableFiles: string[] = [];
          uploadResults.forEach((settled, index) => {
            const intent = messageIntent.attachments[index]!;
            const result = settled.status === "fulfilled" ? settled.value : null;
            if (result?.found && result.operation === "attachments.upload" && result.result.status !== "failed") {
              recoveredAttachments.push(recoveredPendingAttachment(intent, result.result));
            } else if (result?.found && result.operation === "attachments.upload") {
              recoveredAttachments.push({
                ...recoveredPendingAttachment(intent, result.result),
                status: "failed",
                error: "The recovered upload failed processing. Remove and reattach the original file."
              });
              unavailableFiles.push(intent.filename);
            } else {
              unavailableFiles.push(intent.filename);
              recoveredAttachments.push(unavailablePendingAttachment(intent));
            }
          });
          // The recovery reads above are asynchronous. Do not overwrite text the
          // person typed while they were running; only restore the old draft if
          // its revision is still the active browser revision.
          if (readLocalStorage(DRAFT_REVISION_KEY) === messageIntent.draftRevisionId) {
            setDraftState(messageIntent.contentKind === "draft" ? storedDraft : "");
          }
          setAttachments((current) => {
            const recoveredKeys = new Set(recoveredAttachments.map((attachment) => attachment.idempotencyKey));
            return [...recoveredAttachments, ...current.filter((attachment) => !recoveredKeys.has(attachment.idempotencyKey))];
          });
          if (unavailableFiles.length) {
            // A missing upload has no durable bytes, while a terminally failed
            // upload cannot be retried with its completed receipt. In both cases
            // reload discarded the only browser File object, so require an
            // explicit reattachment and keep the failed chip visible.
            setProgress({ runId: null, stage: "failed", label: `Reattach ${unavailableFiles.join(", ")} before sending. The original browser file cannot be replayed after reload.` });
            addToast("warning", "Some files must be reattached", `${unavailableFiles.join(", ")} could not be restored as usable uploads. Remove each failed chip and reattach it; the text draft, completed uploads, and retry identity remain retained.`);
          } else {
            setProgress({ runId: null, stage: "failed", label: "Interrupted message restored. Send again to reuse its exact retry identity." });
            addToast("info", "Interrupted message restored", "No message was committed. Uploaded files and the exact retry key are ready for a safe retry.");
          }
          return;
        } catch (error) {
          if (stale()) return;
          mutationRecoveryAttemptedRef.current.delete(messageIntent.idempotencyKey);
          if (!stale()) {
            setProgress({ runId: null, stage: "failed", label: "Continuum could not verify whether the interrupted message was saved. Reconnect before changing it." });
            addToast("warning", "Message recovery is waiting for the local service", error instanceof Error ? error.message : undefined);
          }
          return;
        }
      }

      if (regenerationIntent && !mutationRecoveryAttemptedRef.current.has(regenerationIntent.idempotencyKey)) {
        mutationRecoveryAttemptedRef.current.add(regenerationIntent.idempotencyKey);
        try {
          const recoveredRegeneration = await continuumApi.recoverMutation("events.regenerate", regenerationIntent.idempotencyKey);
          if (stale()) return;
          if (recoveredRegeneration.found && recoveredRegeneration.operation === "events.regenerate") {
            clearRegenerationIntent(regenerationIntent.idempotencyKey);
            addToast("info", "Recovered the response retry", "The regeneration run was already committed; no second run was created.");
            void streamExistingRun(recoveredRegeneration.result.runId).catch((error) => {
              if (stale()) return;
              if (error instanceof DOMException && error.name === "AbortError") return;
              markRunConnectionLost(recoveredRegeneration.result.runId, error);
            });
          } else {
            retryParentRef.current = regenerationIntent.eventId;
            setProgress({ runId: null, stage: "failed", label: "The interrupted response retry was not committed. Retry again to reuse its exact identity." });
          }
        } catch (error) {
          if (stale()) return;
          mutationRecoveryAttemptedRef.current.delete(regenerationIntent.idempotencyKey);
          if (!stale()) addToast("warning", "Response retry recovery is waiting for the local service", error instanceof Error ? error.message : undefined);
        }
      }
    };

    void recoverPersistedIntents();
    return () => { cancelled = true; };
  }, [addToast, bootstrapQuery.data, bootstrapQuery.isPlaceholderData, clearCommittedDraft, markRunConnectionLost, offline, previewMode, streamExistingRun]);

  useEffect(() => () => { abortRef.current?.abort(); }, []);

  const simulateDemo = async (parentId: string) => {
    const generation = vaultUiGenerationRef.current;
    const runId = crypto.randomUUID(); const assistantId = crypto.randomUUID(); streamingEventRef.current = assistantId;
    if (demoBootstrap.debug.trace) {
      const trace = { ...demoBootstrap.debug.trace, id: crypto.randomUUID(), runId };
      setTracesByRunId((current) => touchRunCache(current, runId, trace));
      setReferencesByRunId((current) => touchRunCache(current, runId, demoBootstrap.activeMemories));
    }
    setProgress({ runId, stage: "retrieving", label: "Looking through relevant history…" });
    await wait(420);
    if (vaultUiGenerationRef.current !== generation) return;
    const answer = "This preview is using the immutable demo vault, so no API credit was spent. In a connected vault, Continuum would now retrieve exact transcript evidence, relevant topic pages, and current claims before streaming this answer.\n\nOpen the **memory inspector** to see the selected sources, or the **knowledge graph** to explore how they connect.";
    setEvents((items) => [...items, { id: assistantId, sequence: Math.max(0, ...items.map((item) => item.sequence)) + 1, role: "assistant", kind: "message", status: "streaming", content: "", parentEventId: parentId, runId, active: true, createdAt: new Date().toISOString(), completedAt: null, attachments: [] }]);
    setProgress({ runId, stage: "responding", label: "Writing a grounded answer…" });
    for (const chunk of answer.match(/.{1,12}/gs) ?? []) { if (vaultUiGenerationRef.current !== generation || abortRef.current?.signal.aborted) return; await wait(18); if (vaultUiGenerationRef.current !== generation) return; setEvents((items) => items.map((item) => item.id === assistantId ? { ...item, content: item.content + chunk } : item)); }
    if (vaultUiGenerationRef.current !== generation) return;
    setEvents((items) => items.map((item) => item.id === assistantId ? { ...item, status: "complete", completedAt: new Date().toISOString() } : item));
    streamingEventRef.current = null; setProgress(IDLE_PROGRESS);
  };

  const sendMessage = async (omitFailedEventId?: string) => {
    const content = draft.trim();
    if ((!content && !attachments.length) || !["idle", "cancelled", "failed"].includes(progress.stage)) return;
    if (offline) { addToast("warning", "The local service is offline", "Your draft remains in this browser. Retry the connection before sending."); return; }
    const outgoingFiles = attachments;
    if (isDemo) {
      const eventId = crypto.randomUUID();
      const parentEventId = events.filter((event) => event.id !== omitFailedEventId).at(-1)?.id ?? null;
      const optimistic: ConversationEvent = { id: eventId, sequence: nextSequence(), role: "user", kind: "message", status: "complete", content, parentEventId, runId: null, active: true, createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), attachments: outgoingFiles.map(provisionalAttachment) };
      setEvents((items) => [...items, optimistic]);
      setDraft("");
      setAttachments([]);
      abortRef.current = new AbortController();
      await simulateDemo(eventId);
      return;
    }

    for (const attachment of outgoingFiles) attachment.idempotencyKey ||= crypto.randomUUID();
    const draftRevisionId = ensureDraftRevision(content);
    if (!draftRevisionId) {
      addToast("danger", "Safe retry storage is unavailable", "Continuum did not send anything because this browser could not retain the mutation identity needed to prevent duplicates.");
      return;
    }
    const contentKind: PersistedMessageIntent["contentKind"] = content ? "draft" : "attachment-default";
    const attachmentKeys = outgoingFiles.map((attachment) => attachment.idempotencyKey);
    let messageIntent = readMessageIntent();
    if (messageIntent && !messageIntentMatches(messageIntent, { draftRevisionId, contentKind, quality: settings.quality, attachmentKeys })) {
      setProgress({ runId: null, stage: "saving", label: "Checking the previous delivery before sending this edited draft…" });
      try {
        const previous = await continuumApi.recoverMutation("messages.create", messageIntent.idempotencyKey);
        if (previous.found && previous.operation === "messages.create") {
          clearMessageIntent(messageIntent.idempotencyKey);
          clearCommittedDraft(messageIntent);
          setEvents((items) => [...items.filter((item) => item.id !== previous.result.event.id), previous.result.event].sort((left, right) => left.sequence - right.sequence));
          retryParentRef.current = previous.result.event.id;
          addToast("info", "The previous message was already saved", "Your edited draft remains in the composer. Continuum recovered the original run instead of creating a duplicate.");
          try { await streamExistingRun(previous.result.runId); }
          catch (error) { if (!(error instanceof DOMException && error.name === "AbortError")) markRunConnectionLost(previous.result.runId, error); }
          return;
        }
        clearMessageIntent(messageIntent.idempotencyKey);
        messageIntent = null;
      } catch (error) {
        setProgress({ runId: null, stage: "failed", label: "The previous delivery is still uncertain. Reconnect before sending an edited message." });
        addToast("warning", "Edited draft was not sent", error instanceof Error ? `${error.message} The prior retry identity is still retained.` : "The prior retry identity is still retained.");
        return;
      }
    }
    messageIntent ??= {
      operation: "messages.create",
      idempotencyKey: crypto.randomUUID(),
      draftRevisionId,
      contentKind,
      quality: settings.quality,
      attachments: outgoingFiles.map(pendingUploadIntent),
      createdAt: new Date().toISOString()
    };
    if (!persistMessageIntent(messageIntent)) {
      addToast("danger", "Safe retry storage is unavailable", "Continuum did not upload or send anything because it could not durably retain the retry identity.");
      return;
    }

    retryParentRef.current = null;
    const eventId = crypto.randomUUID();
    const parentEventId = events.filter((event) => event.id !== omitFailedEventId).at(-1)?.id ?? null;
    const optimisticAttachments = outgoingFiles.map(provisionalAttachment);
    const optimistic: ConversationEvent = { id: eventId, sequence: nextSequence(), role: "user", kind: "message", status: "pending", content, parentEventId, runId: null, active: true, createdAt: new Date().toISOString(), completedAt: null, attachments: optimisticAttachments };
    setEvents((items) => [...items, optimistic]);
    // Keep the exact browser draft in localStorage until the message mutation is
    // acknowledged or recovered. Only the visible composer is cleared here.
    setDraftState("");
    setAttachments([]);
    setProgress({ runId: null, stage: "saving", label: outgoingFiles.length ? `Preparing ${outgoingFiles.length} attachment${outgoingFiles.length === 1 ? "" : "s"}…` : "Saving message…" });
    let messageSaved = false;
    let savedRunId: string | null = null;
    try {
      const uploadResults = await Promise.allSettled(outgoingFiles.map(async (item, index) => {
        const placeholderId = optimisticAttachments[index]!.id;
        item.status = "uploading";
        setEvents((items) => items.map((event) => event.id === eventId ? { ...event, attachments: event.attachments.map((attachment) => attachment.id === placeholderId ? { ...attachment, status: "processing" } : attachment) } : event));
        try {
          const ready = await continuumApi.uploadAndPrepareAttachment(item);
          item.remote = ready;
          item.status = "ready";
          setEvents((items) => items.map((event) => event.id === eventId ? { ...event, attachments: event.attachments.map((attachment) => attachment.id === placeholderId ? ready : attachment) } : event));
          return ready;
        } catch (error) {
          item.status = item.remote?.status === "ready" ? "ready" : item.remote && item.remote.status !== "failed" ? "pending" : "failed";
          item.error = error instanceof Error ? error.message : "This file could not be prepared.";
          setEvents((items) => items.map((event) => event.id === eventId ? { ...event, attachments: event.attachments.map((attachment) => attachment.id === placeholderId ? { ...attachment, status: "failed" } : attachment) } : event));
          throw error;
        }
      }));
      const failedUpload = uploadResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failedUpload) throw failedUpload.reason;
      const uploaded = uploadResults.map((result) => {
        if (result.status !== "fulfilled") throw result.reason;
        return result.value;
      });
      const response = await continuumApi.createMessage({ content: content || ATTACHMENT_DEFAULT_CONTENT, attachmentIds: uploaded.map((item) => item.id), quality: settings.quality, idempotencyKey: messageIntent.idempotencyKey });
      messageSaved = true;
      savedRunId = response.runId;
      clearMessageIntent(messageIntent.idempotencyKey);
      clearCommittedDraft(messageIntent);
      for (const attachment of outgoingFiles) if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      retryParentRef.current = response.event.id;
      setEvents((items) => items.map((item) => item.id === eventId ? response.event : item));
      await streamExistingRun(response.runId);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (messageSaved && savedRunId) {
        markRunConnectionLost(savedRunId, error);
        return;
      }
      setEvents((items) => items.map((item) => item.id === eventId ? { ...item, status: "failed" } : item));
      if (readLocalStorage(DRAFT_REVISION_KEY) === messageIntent.draftRevisionId) setDraftState(contentKind === "draft" ? content : "");
      setAttachments(outgoingFiles.map((item) => ({
        ...item,
        status: item.remote?.status === "ready" ? "ready" : item.remote?.status === "failed" ? "failed" : "pending"
      })));
      const requiresReattachment = error instanceof ApiRequestError && (error.code === "ATTACHMENT_REATTACH_REQUIRED" || error.code === "ATTACHMENT_FILE_UNAVAILABLE");
      setProgress({ runId: null, stage: "failed", label: requiresReattachment ? "Message kept as a draft. Remove and reattach each failed file before retrying." : "Message kept as a draft with its safe retry identity" });
      addToast("danger", "Message could not be confirmed", error instanceof ApiRequestError
        ? requiresReattachment ? error.message : `${error.message} Retry without editing to reuse the same durable identity.`
        : "Your draft and exact retry identity were retained.");
    }
  };

  const resumeActiveResponse = async () => {
    const runId = progress.runId;
    if (!runId || progress.stage !== "connection_lost") return;
    const assistantEventId = streamingEventRef.current
      ?? events.find((event) => event.runId === runId && event.role === "assistant" && event.status === "streaming")?.id
      ?? null;
    const assistantEvent = assistantEventId ? events.find((event) => event.id === assistantEventId) : undefined;
    const checkpoint = readRunStreamCheckpoint(runId);
    const checkpointMatches = checkpoint !== null
      && checkpoint.assistantEventId === assistantEventId
      && checkpoint.contentLength === (assistantEvent?.content.length ?? 0)
      && checkpoint.checksum === streamChecksum(assistantEvent?.content ?? "");
    if (assistantEventId && !checkpointMatches) {
      clearRunStreamCheckpoint(runId);
      setEvents((items) => items.map((event) => event.id === assistantEventId ? { ...event, content: "", status: "streaming", completedAt: null } : event));
    }
    try {
      await streamExistingRun(runId, {
        lastEventId: checkpointMatches ? checkpoint.cursor : null,
        assistantEventId,
        initialContent: checkpointMatches ? assistantEvent?.content ?? "" : ""
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      markRunConnectionLost(runId, error);
    }
  };

  const stopResponse = async () => {
    const runId = progress.runId;
    const markStopped = () => {
      if (runId) {
        terminalStreamRunIdsRef.current.add(runId);
        clearRunStreamCheckpoint(runId);
      }
      setEvents((items) => items.map((item) => item.id === streamingEventRef.current ? { ...item, status: "incomplete", completedAt: new Date().toISOString() } : item));
      streamingEventRef.current = null;
      setProgress({ runId: null, stage: "cancelled", label: "Response stopped" });
      window.setTimeout(() => setProgress(IDLE_PROGRESS), 1200);
    };
    if (isDemo) { abortRef.current?.abort(); markStopped(); return; }
    if (!runId) return;
    const previous = progress;
    cancellationAcknowledgedRef.current = false;
    setProgress({ runId, stage: "cancelling", label: "Stopping safely…" });
    try {
      const acknowledgement = await continuumApi.cancelRun(runId);
      if (!acknowledgement.cancelled) throw new ApiRequestError("The run had already reached a terminal state.", "CANCEL_NOT_ACKNOWLEDGED", false);
      cancellationAcknowledgedRef.current = true;
      abortRef.current?.abort();
      markStopped();
    } catch (error) {
      if (cancellationAcknowledgedRef.current) return;
      setProgress(previous);
      addToast("danger", "Stop was not confirmed", error instanceof Error ? `${error.message} The response remains active.` : "The response remains active.");
    }
  };

  const regenerate = async (eventId: string) => {
    if (!["idle", "cancelled", "failed"].includes(progress.stage)) {
      addToast("warning", "Another response is still active", "Resume or stop it before regenerating a response.");
      return;
    }
    if (isDemo) { const source = events.find((event) => event.id === eventId); if (source?.parentEventId) await simulateDemo(source.parentEventId); return; }
    let regenerationIntent = readRegenerationIntent();
    if (regenerationIntent && regenerationIntent.eventId !== eventId) {
      try {
        const previous = await continuumApi.recoverMutation("events.regenerate", regenerationIntent.idempotencyKey);
        if (previous.found && previous.operation === "events.regenerate") {
          clearRegenerationIntent(regenerationIntent.idempotencyKey);
          addToast("info", "Recovered the earlier response retry", "Continuum resumed that committed run instead of starting another regeneration.");
          try { await streamExistingRun(previous.result.runId); }
          catch (error) { if (!(error instanceof DOMException && error.name === "AbortError")) markRunConnectionLost(previous.result.runId, error); }
          return;
        }
        clearRegenerationIntent(regenerationIntent.idempotencyKey);
        regenerationIntent = null;
      } catch (error) {
        addToast("warning", "A different response retry is still uncertain", error instanceof Error ? `${error.message} No new run was created.` : "No new run was created.");
        return;
      }
    }
    regenerationIntent ??= { operation: "events.regenerate", eventId, idempotencyKey: crypto.randomUUID(), createdAt: new Date().toISOString() };
    if (!persistRegenerationIntent(regenerationIntent)) {
      addToast("danger", "Safe retry storage is unavailable", "Continuum did not start a regeneration because its exact retry identity could not be retained.");
      return;
    }
    let runId: string | null = null;
    try {
      const response = await continuumApi.regenerate(eventId, regenerationIntent.idempotencyKey);
      runId = response.runId;
      clearRegenerationIntent(regenerationIntent.idempotencyKey);
      await streamExistingRun(runId);
    }
    catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (runId) markRunConnectionLost(runId, error);
      else {
        retryParentRef.current = eventId;
        setProgress({ runId: null, stage: "failed", label: "Response retry was not confirmed. Retry again to reuse the same durable identity." });
        addToast("danger", "Could not confirm the response retry", error instanceof Error ? error.message : undefined);
      }
    }
  };

  const jumpToEvent = async (eventId: string) => {
    const generation = vaultUiGenerationRef.current;
    if (!events.some((event) => event.id === eventId) && !isDemo) {
      try {
        const event = await continuumApi.getEvent(eventId);
        if (vaultUiGenerationRef.current !== generation) return;
        setEvents((items) => [...items.filter((item) => item.id !== event.id), event].sort((left, right) => left.sequence - right.sequence));
      } catch (error) {
        if (vaultUiGenerationRef.current !== generation) return;
        addToast("danger", "Exact evidence could not be opened", error instanceof Error ? error.message : undefined);
        return;
      }
    }
    if (vaultUiGenerationRef.current !== generation) return;
    setRevealedEventIds((ids) => new Set(ids).add(eventId));
    setTopicDetail(null); setSearchOpen(false); setDrawer(null); setHighlightedEventId(eventId);
    window.setTimeout(() => document.getElementById(`event-${eventId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 40);
    window.setTimeout(() => setHighlightedEventId(null), 2600);
  };

  const openEvidence = async (id: string) => {
    const generation = vaultUiGenerationRef.current;
    if (isDemo) {
      const demoEvent = events.find((event) => event.id === id);
      if (demoEvent) { await jumpToEvent(id); return; }
      const memory = demoBootstrap.activeMemories.find((item) => item.id === id || item.sourceEventId === id);
      if (memory?.sourceEventId && events.some((event) => event.id === memory.sourceEventId)) { await jumpToEvent(memory.sourceEventId); return; }
      addToast("info", memory?.title ?? "Preview evidence", memory?.excerpt ?? "This explicit preview does not contain a separate retained record for that evidence ID.");
      return;
    }
    setEvidenceOpen(true); setEvidenceRecord(null); setEvidenceError(null); setEvidenceLoading(true);
    try {
      const resolved = await continuumApi.getEvidence(id);
      if (vaultUiGenerationRef.current !== generation) return;
      if (resolved.type === "event") { setEvidenceOpen(false); await jumpToEvent(resolved.id); return; }
      if (resolved.type === "topic") {
        const topic = topics.find((item) => item.id === resolved.id) ?? await continuumApi.getTopic(resolved.id);
        if (vaultUiGenerationRef.current !== generation) return;
        setTopics((items) => items.some((item) => item.id === topic.id) ? items : [...items, topic]);
        setEvidenceOpen(false); setTopicDetail(topic); return;
      }
      const record = resolved.type === "claim" ? await continuumApi.getClaimDetail(resolved.id)
        : resolved.type === "entity" ? await continuumApi.getEntityDetail(resolved.id)
          : resolved.type === "source" ? await continuumApi.getSourceDetail(resolved.id)
            : resolved.record;
      if (vaultUiGenerationRef.current !== generation) return;
      setEvidenceRecord({ ...resolved, record });
    } catch (error) {
      if (vaultUiGenerationRef.current !== generation) return;
      setEvidenceError(error instanceof Error ? error.message : "That exact evidence record could not be loaded.");
    } finally { if (vaultUiGenerationRef.current === generation) setEvidenceLoading(false); }
  };

  const openTopicIdentity = async (identity: string) => {
    const generation = vaultUiGenerationRef.current;
    const known = topics.find((item) => item.id === identity || item.slug === identity);
    if (isDemo) {
      if (known) setTopicDetail(known);
      else addToast("info", "Related preview page is not included", identity);
      return;
    }
    try {
      const topic = await continuumApi.getTopic(known?.id ?? identity);
      if (vaultUiGenerationRef.current !== generation) return;
      setTopics((items) => items.some((item) => item.id === topic.id) ? items.map((item) => item.id === topic.id ? topic : item) : [...items, topic]);
      setTopicDetail(topic);
      setSearchOpen(false);
    } catch (error) {
      if (vaultUiGenerationRef.current !== generation) return;
      addToast("danger", "Related memory page could not be opened", error instanceof Error ? error.message : undefined);
    }
  };

  const navigateMemory = (memory: MemoryReference) => {
    if (memory.topicId || memory.type === "topic") {
      void openTopicIdentity(memory.topicId ?? memory.id);
      return;
    }
    void openEvidence(memory.type === "event" ? memory.sourceEventId ?? memory.id : memory.id);
  };

  const loadOlderEvents = async () => {
    if (!eventsCursor || loadingOlder || isDemo) return;
    setLoadingOlder(true);
    const generation = vaultUiGenerationRef.current;
    try {
      const page = await continuumApi.listEvents(eventsCursor);
      if (vaultUiGenerationRef.current !== generation) return;
      setEvents((current) => {
        const ids = new Set(current.map((event) => event.id));
        return [...page.events.filter((event) => !ids.has(event.id)), ...current].sort((left, right) => left.sequence - right.sequence);
      });
      setEventsCursor(page.nextCursor);
    } catch (error) {
      if (vaultUiGenerationRef.current !== generation) return;
      addToast("danger", "Earlier history could not be loaded", error instanceof Error ? error.message : undefined);
    } finally {
      if (vaultUiGenerationRef.current === generation) setLoadingOlder(false);
    }
  };

  const selectSearchResult = async (result: SearchResult) => {
    const generation = vaultUiGenerationRef.current;
    if (result.type === "event") await jumpToEvent(result.id);
    else if (result.type === "topic") {
      try {
        const cached = result.topicRevision === undefined || result.topicRevision === null
          ? topics.find((item) => item.id === result.id)
          : topics.find((item) => item.id === result.id && item.revision === result.topicRevision);
        const topic = cached ?? (isDemo ? null : await continuumApi.getTopic(result.id, result.topicRevision ?? undefined));
        if (vaultUiGenerationRef.current !== generation) return;
        if (topic) { setTopics((items) => items.some((item) => item.id === topic.id) ? items : [...items, topic]); setTopicDetail(topic); setSearchOpen(false); }
      } catch (error) { if (vaultUiGenerationRef.current !== generation) return; addToast("danger", "Memory page could not be opened", error instanceof Error ? error.message : undefined); }
    }
    else { setSearchOpen(false); await openEvidence(result.evidenceId ?? result.id); }
  };

  const requestDelete = async (resource: "events" | "attachments" | "claims" | "topics", id: string, title: string) => {
    const generation = vaultUiGenerationRef.current;
    setDeleteTarget({ resource, id, title }); setDeleteImpact(null); setDeleteLoading(true);
    try {
      const impact = isDemo
        ? { confirmationToken: `preview-${id}`, events: resource === "events" ? 1 : 0, attachments: resource === "attachments" ? 1 : 0, claimsRemoved: resource === "claims" ? 1 : 0, claimsRetained: 0, topicsRebuilt: resource === "topics" || resource === "claims" ? 1 : 0, edgesRemoved: resource === "claims" ? 1 : 0, managedBackupsAffected: 0 }
        : await continuumApi.deletionImpact(resource, id);
      if (vaultUiGenerationRef.current !== generation) return;
      setDeleteImpact(impact);
    }
    catch (error) {
      if (vaultUiGenerationRef.current !== generation) return;
      setDeleteTarget(null); addToast("danger", "Deletion impact could not be calculated", error instanceof Error ? error.message : undefined);
    }
    finally { if (vaultUiGenerationRef.current === generation) setDeleteLoading(false); }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || !deleteImpact) return;
    const generation = vaultUiGenerationRef.current;
    try {
      if (!isDemo) await continuumApi.confirmDeletion(deleteTarget.resource, deleteTarget.id, deleteImpact.confirmationToken);
      if (vaultUiGenerationRef.current !== generation) return;
      if (deleteTarget.resource === "events") setEvents((items) => items.filter((item) => item.id !== deleteTarget.id));
      else if (deleteTarget.resource === "attachments") { setEvents((items) => items.map((event) => ({ ...event, attachments: event.attachments.filter((attachment) => attachment.id !== deleteTarget.id) }))); setMemories((items) => items.filter((item) => item.id !== deleteTarget.id)); }
      else if (deleteTarget.resource === "claims") {
        setClaims((items) => items.filter((item) => item.id !== deleteTarget.id));
        setMemories((items) => items.filter((item) => item.id !== deleteTarget.id));
        setReferencesByRunId((groups) => Object.fromEntries(Object.entries(groups).map(([runId, items]) => [runId, items.filter((item) => item.id !== deleteTarget.id)])));
        setEvidenceOpen(false); setEvidenceRecord(null); setEvidenceError(null);
      } else { setTopics((items) => items.filter((item) => item.id !== deleteTarget.id)); setMemories((items) => items.filter((item) => item.id !== deleteTarget.id)); }
      setDeleteTarget(null); setDeleteImpact(null); addToast("success", "Deleted permanently", "Derived memory without independent support was removed.");
      if (!isDemo) void pollDurableMemory();
    } catch (error) {
      if (vaultUiGenerationRef.current !== generation) return;
      addToast("danger", "Nothing was deleted", error instanceof Error ? error.message : "The impact may have changed; review it again.");
      if (!isDemo) {
        setDeleteLoading(true);
        try {
          const impact = await continuumApi.deletionImpact(deleteTarget.resource, deleteTarget.id);
          if (vaultUiGenerationRef.current !== generation) return;
          setDeleteImpact(impact);
        }
        catch {
          if (vaultUiGenerationRef.current !== generation) return;
          setDeleteTarget(null); setDeleteImpact(null);
        }
        finally { if (vaultUiGenerationRef.current === generation) setDeleteLoading(false); }
      }
    }
  };

  const saveTopic = async (topic: TopicPage, patch: Partial<TopicPage>) => {
    const generation = vaultUiGenerationRef.current;
    const updated = isDemo ? { ...topic, ...patch, revision: topic.revision + 1, updatedAt: new Date().toISOString() } : await continuumApi.updateTopic(topic.id, patch, topic.revision);
    if (vaultUiGenerationRef.current !== generation) return;
    setTopics((items) => items.map((item) => item.id === topic.id ? updated : item)); setTopicEditor(null); setTopicDetail(updated); addToast("success", "Trusted revision saved");
  };

  const togglePin = async (memory: MemoryReference, pinned: boolean) => {
    const updatePin = (items: MemoryReference[], pinId?: string) => items.map((item) => {
      if (item.id !== memory.id) return item;
      if (pinned) return { ...item, pinned: true, ...(pinId ? { pinId } : {}) };
      const withoutPin = { ...item };
      delete withoutPin.pinId;
      return { ...withoutPin, pinned: false };
    });
    if (isDemo) {
      setMemories((items) => updatePin(items));
      setReferencesByRunId((groups) => Object.fromEntries(Object.entries(groups).map(([runId, items]) => [runId, updatePin(items)])));
      addToast("info", pinned ? "Pinned in this preview" : "Removed from preview pins", memory.title);
      return;
    }
    try {
      const generation = vaultUiGenerationRef.current;
      const result = await continuumApi.setPinned(memory, pinned);
      if (vaultUiGenerationRef.current !== generation) return;
      setMemories((items) => updatePin(items, result.id));
      setReferencesByRunId((groups) => Object.fromEntries(Object.entries(groups).map(([runId, items]) => [runId, updatePin(items, result.id)])));
      addToast("success", pinned ? "Pinned to context" : "Removed from pinned context", memory.title);
    } catch (error) {
      addToast("danger", pinned ? "Memory could not be pinned" : "Pin could not be removed", error instanceof Error ? error.message : undefined);
    }
  };

  const correctClaim = async (claimId: string, value: string, reason: string) => {
    if (isDemo) throw new ApiRequestError("Claim corrections are disabled in the immutable preview.", "PREVIEW_READ_ONLY", false);
    const generation = vaultUiGenerationRef.current;
    const corrected = await continuumApi.correctClaim(claimId, value, reason);
    if (vaultUiGenerationRef.current !== generation) return;
    setClaims((items) => [...items.filter((claim) => claim.id !== claimId && claim.id !== corrected.claim.id), corrected.claim]);
    addToast("success", "Claim corrected", "The original remains historical and the user-authored correction is now current.");
    await openEvidence(corrected.claim.id);
    void pollDurableMemory();
  };

  const openMergeReview = async () => {
    const generation = vaultUiGenerationRef.current;
    setDrawer(null);
    setMergeOpen(true);
    setMergeCandidates([]);
    setMergeError(null);
    if (isDemo) return;
    setMergeLoading(true);
    try {
      const candidates = await continuumApi.listEntityMergeCandidates();
      if (vaultUiGenerationRef.current !== generation) return;
      setMergeCandidates(candidates);
    }
    catch (error) {
      if (vaultUiGenerationRef.current !== generation) return;
      setMergeError(error instanceof Error ? error.message : "Possible duplicate entities could not be loaded.");
    }
    finally { if (vaultUiGenerationRef.current === generation) setMergeLoading(false); }
  };

  const reviewEntityMerge = async (sourceId: string, targetId: string): Promise<EntityMergeEnvelope> => {
    if (isDemo) throw new ApiRequestError("Entity merging is disabled in the immutable preview.", "PREVIEW_READ_ONLY", false);
    const generation = vaultUiGenerationRef.current;
    const envelope = await continuumApi.entityMergeImpact(sourceId, targetId);
    if (vaultUiGenerationRef.current !== generation) throw new ApiRequestError("The vault changed while the merge was being reviewed.", "VAULT_CHANGED", true);
    return envelope;
  };

  const mergeEntities = async (envelope: EntityMergeEnvelope): Promise<EntityMergeResult> => {
    const generation = vaultUiGenerationRef.current;
    const result = await continuumApi.mergeEntities(envelope);
    if (vaultUiGenerationRef.current !== generation) throw new ApiRequestError("The vault changed while the merge was being applied.", "VAULT_CHANGED", true);
    addToast("success", "Entities merged", `${envelope.impact.sourceName} now resolves to ${envelope.impact.targetName}.`);
    await refreshDurableMemory();
    return result;
  };

  const reverseEntityMerge = async (mergeId: string, entityId?: string) => {
    const generation = vaultUiGenerationRef.current;
    await continuumApi.reverseEntityMerge(mergeId);
    if (vaultUiGenerationRef.current !== generation) return;
    addToast("success", "Entity merge reversed", "Aliases and graph edges were restored from the recorded snapshot.");
    await refreshDurableMemory();
    if (entityId && evidenceOpen) await openEvidence(entityId);
  };

  const appClass = drawer ? `app-shell drawer-open drawer-${drawer}-open` : "app-shell";
  const timelineReferences = settings.showSourceChips ? referencesByRunId : {};
  const selectedTrace = selectedRunId ? tracesByRunId[selectedRunId] ?? null : null;
  const callsAreRunKeyed = debugSnapshot.modelCalls.some((call) => Boolean(call.runId));
  const answerDebug = selectedRunId ? debugByRunId[selectedRunId] : undefined;
  const selectedDebug: DebugSnapshot = {
    ...debugSnapshot,
    ...answerDebug,
    trace: selectedTrace,
    jobs: debugSnapshot.jobs,
    modelCalls: answerDebug?.modelCalls ?? (selectedRunId && callsAreRunKeyed ? debugSnapshot.modelCalls.filter((call) => call.runId === selectedRunId) : debugSnapshot.modelCalls),
    toolCalls: answerDebug?.toolCalls ?? []
  };
  const inspectedMemories = selectedRunId ? referencesByRunId[selectedRunId] ?? [] : memories;
  const activeTopicIds = useMemo(() => new Set(inspectedMemories.flatMap((memory) => [memory.topicId, memory.type === "topic" ? memory.id : undefined].filter((id): id is string => Boolean(id)))), [inspectedMemories]);
  const activeTopics = selectedRunId
    ? topics.filter((topic) => activeTopicIds.has(topic.id)).slice(0, 8)
    : topics.slice(0, 8);
  const openMemoryInspector = () => {
    const latest = [...events].reverse().find((event) => event.role === "assistant" && event.active && event.runId);
    setInspectorTab("memory");
    setDrawer("memory");
    void refreshMemoryProposals();
    if (latest?.runId) { void loadRunTrace(latest.runId, true); setInspectorTab("memory"); }
  };
  const showInGraph = async (focusId: string) => {
    const generation = vaultUiGenerationRef.current;
    try {
      setGraphRequest({ hops: 2, includeHistory: true });
      const focused = isDemo
        ? (graph.nodes.some((node) => node.id === focusId) ? { ...graph, focusId } : graph)
        : await continuumApi.getGraph(focusId, 2, true);
      if (vaultUiGenerationRef.current !== generation) return;
      setGraph(focused);
      setTopicDetail(null);
      setDrawer("graph");
      if (isDemo && focused.focusId !== focusId) addToast("warning", "This preview record has no graph neighborhood", "Live retained answers and topic pages can always be focused by exact ID.");
    } catch (error) {
      if (vaultUiGenerationRef.current !== generation) return;
      addToast("danger", "Graph neighborhood could not be opened", error instanceof Error ? error.message : undefined);
    }
  };

  const loadVaultImpact = async () => {
    const generation = vaultUiGenerationRef.current;
    setVaultImpactLoading(true);
    setVaultImpactError(null);
    setVaultImpact(null);
    try {
      const impact = isDemo ? {
        confirmationToken: "preview-vault",
        requiredPhrase: "DELETE MY CONTINUUM VAULT",
        events: events.length,
        attachments: events.reduce((total, event) => total + event.attachments.length, 0),
        claimsRemoved: previewMode ? demoBootstrap.claims.length : 0,
        claimsRetained: 0,
        topicsRebuilt: 0,
        edgesRemoved: graph.edges.length,
        managedBackupsAffected: 0
      } : await continuumApi.vaultDeletionImpact();
      if (vaultUiGenerationRef.current !== generation) return;
      setVaultImpact(impact);
    } catch (error) {
      if (vaultUiGenerationRef.current !== generation) return;
      setVaultImpactError(error instanceof Error ? error.message : "The deletion impact could not be calculated.");
    } finally {
      if (vaultUiGenerationRef.current === generation) setVaultImpactLoading(false);
    }
  };

  const openVaultReset = () => {
    setSettingsOpen(false);
    setResetOpen(true);
    void loadVaultImpact();
  };

  return <div className={appClass}>
    <TopBar runtime={runtime} quality={settings.quality} memoryPaused={settings.memoryPaused} drawer={drawer} onQuality={(quality: QualityPreset) => void updateSettings({ quality }, true).catch(() => undefined)} onSearch={() => setSearchOpen(true)} onDrawer={(next) => { if (next === "memory") openMemoryInspector(); else { if (next === "graph") setGraphRequest({ hops: 1, includeHistory: false }); setDrawer(next); } }} onSettings={() => setSettingsOpen(true)} onToggleMemory={() => void updateSettings({ memoryPaused: !settings.memoryPaused }, true).catch(() => undefined)} />
    <main className="chat-shell">
      <section className="chat-column" aria-label="Conversation">
        <div className={`timeline-intro ${previewMode ? "preview-intro" : offline ? "offline-intro" : ""}`}><div className="memory-orbit"><BrainCircuit size={22} /></div><div><span>{previewMode ? "Temporary demo preview" : offline ? "Local service offline" : "One continuous conversation"}</span><p>{previewMode ? "Nothing you do here changes your personal vault or spends API credit." : offline ? "No vault content was loaded or replaced. Restart the local service, then reconnect." : "Every retained turn is stored locally. Only selected context is sent to the configured model."}</p></div>{previewMode ? <button type="button" className="secondary-button" onClick={() => { setTracesByRunId({}); setReferencesByRunId({}); setSelectedRunId(null); setPreviewMode(false); addToast("info", "Returned to your personal vault"); }}>Leave preview</button> : offline ? <button type="button" className="secondary-button" disabled={bootstrapQuery.isFetching} onClick={() => void bootstrapQuery.refetch()}>{bootstrapQuery.isFetching ? "Connecting…" : "Retry connection"}</button> : <div className="timeline-count"><strong>{events.length.toLocaleString()}</strong><span>events loaded</span></div>}</div>
        <ChatTimeline events={events} offline={offline} hasOlder={Boolean(eventsCursor) && !isDemo} loadingOlder={loadingOlder} onLoadOlder={() => void loadOlderEvents()} referencesByRunId={timelineReferences} loadingTraceRunIds={loadingTraceRunIds} highlightedEventId={highlightedEventId} revealedEventIds={revealedEventIds} onSource={navigateMemory} onInspectAnswer={(event) => { if (event.runId) void loadRunTrace(event.runId, true); }} onShowInGraph={(event) => void showInGraph(event.id)} onOpenRevisions={(id) => void openRevisions(id)} onRegenerate={(id) => void regenerate(id)} onDelete={(id) => { const event = events.find((item) => item.id === id); void requestDelete("events", id, event?.content.slice(0, 50) || "message"); }} onDeleteAttachment={(id, title) => void requestDelete("attachments", id, title)} onRetry={(id) => { const failed = events.find((event) => event.id === id); if (failed?.role === "user") { setEvents((items) => items.filter((event) => event.id !== id)); void sendMessage(id); } else void regenerate(id); }} />
        <Composer draft={draft} attachments={attachments} progress={progress} memoryPaused={settings.memoryPaused} webSearchEnabled={settings.webSearchEnabled} retryAvailable={Boolean(retryParentRef.current)} disabled={offline} onDraft={setDraft} onFiles={addFiles} onRemoveAttachment={removeAttachment} onSubmit={() => void sendMessage()} onStop={() => void stopResponse()} onResumeResponse={() => void resumeActiveResponse()} onRetryResponse={() => { if (retryParentRef.current) void regenerate(retryParentRef.current); }} onToggleMemory={() => void updateSettings({ memoryPaused: !settings.memoryPaused }, true).catch(() => undefined)} onToggleWeb={() => void updateSettings({ webSearchEnabled: !settings.webSearchEnabled }, true).catch(() => undefined)} />
      </section>
    </main>
    <MemoryInspector open={drawer === "memory"} requestedTab={inspectorTab} answerRunId={selectedRunId} traceLoading={Boolean(selectedRunId && loadingTraceRunIds.has(selectedRunId))} memories={memories} topics={activeTopics} attention={previewMode ? demoBootstrap.attention : data.attention} proposals={memoryProposals} debug={selectedDebug} runtime={runtime} budget={currentBudget} onClose={() => setDrawer(null)} onNavigate={navigateMemory} onPin={(memory, pinned) => void togglePin(memory, pinned)} onEditTopic={setTopicEditor} onDeleteMemory={(memory) => { if (memory.type === "topic") void requestDelete("topics", memory.id, memory.title); else if (memory.type === "claim") void requestDelete("claims", memory.id, memory.title); else if (memory.type === "attachment") void requestDelete("attachments", memory.id, memory.title); else if (memory.type === "event") void requestDelete("events", memory.id, memory.title); }} onResolveProposal={resolveMemoryProposal} onReviewEntityMerges={() => void openMergeReview()} onRetryJob={(id) => { void continuumApi.retryJob(id).then(() => addToast("success", "Job queued for retry")).catch((error: unknown) => addToast("danger", "Job could not be retried", error instanceof Error ? error.message : undefined)); }} onLint={() => { if (isDemo) addToast("success", "Memory lint complete", "The preview vault has no destructive issues."); else void continuumApi.runMemoryLint().then(() => addToast("info", "Deep memory lint queued")).catch((error: unknown) => addToast("danger", "Memory lint could not start", error instanceof Error ? error.message : undefined)); }} />
    {drawer === "graph" && <KnowledgeGraph graph={graph} topics={topics} initialHops={graphRequest.hops} initialIncludeHistory={graphRequest.includeHistory} onClose={() => setDrawer(null)} onRequestGraph={(focusId, hops, history) => {
      const generation = vaultUiGenerationRef.current;
      setGraphRequest({ hops, includeHistory: history });
      if (isDemo) { setGraph((current) => ({ ...current, focusId: focusId ?? current.focusId })); return; }
      void continuumApi.getGraph(focusId, hops, history).then((nextGraph) => {
        if (vaultUiGenerationRef.current === generation) setGraph(nextGraph);
      }).catch((error: unknown) => {
        if (vaultUiGenerationRef.current === generation) addToast("danger", "Graph could not be refreshed", error instanceof Error ? error.message : undefined);
      });
    }} onNavigate={navigateMemory} onEvidence={(id) => void openEvidence(id)} onEditTopic={setTopicEditor} />}
    <SearchDialog open={searchOpen} demo={isDemo} onClose={() => setSearchOpen(false)} onSelect={selectSearchResult} />
    <SettingsDialog open={settingsOpen} settings={settings} runtime={runtime} budget={currentBudget} pinnedCount={memories.filter((memory) => memory.pinned).length} onClose={() => setSettingsOpen(false)} onSave={updateSettings} onReset={openVaultReset} onOpenMemory={() => { setSettingsOpen(false); openMemoryInspector(); }} onProviderChanged={async () => { await Promise.all([bootstrapQuery.refetch(), budgetQuery.refetch()]); }} onVaultReplaced={async () => {
      resetVaultScopedUiState();
      const generation = vaultUiGenerationRef.current;
      const refreshed = await bootstrapQuery.refetch();
      if (vaultUiGenerationRef.current !== generation) return;
      await budgetQuery.refetch();
      if (vaultUiGenerationRef.current !== generation) return;
      if (refreshed.data) {
        const next = refreshed.data;
        const trace = next.debug.trace;
        setEvents(next.events);
        setEventsCursor(next.eventsNextCursor);
        setTopics(next.topics);
        setClaims(next.claims);
        setMemories(next.activeMemories);
        setMemoryProposals(next.memoryProposals);
        setGraph(next.graph);
        setDebugSnapshot(next.debug);
        setSettings(next.settings);
        setTracesByRunId(trace ? { [trace.runId]: trace } : {});
        setReferencesByRunId(trace ? { [trace.runId]: next.activeMemories } : {});
        setDebugByRunId(trace ? { [trace.runId]: next.debug } : {});
        selectedRunIdRef.current = trace?.runId ?? null;
        setSelectedRunId(trace?.runId ?? null);
        const canOnboard = next.runtime.mode === "connected" || next.runtime.mode === "degraded";
        setOnboardingOpen(!next.settings.onboardingComplete && canOnboard);
      }
      addToast("success", "Imported vault is ready");
    }} />
    <Onboarding open={onboardingOpen} onComplete={async (useDemo) => {
      const generation = vaultUiGenerationRef.current;
      await updateSettings({ onboardingComplete: true }, true);
      if (vaultUiGenerationRef.current !== generation) return;
      setOnboardingOpen(false);
      if (useDemo) { const trace = demoBootstrap.debug.trace; setPreviewMode(true); setEvents(demoBootstrap.events); setEventsCursor(null); setTopics(demoBootstrap.topics); setClaims(demoBootstrap.claims); setMemories(demoBootstrap.activeMemories); setMemoryProposals(demoBootstrap.memoryProposals); setGraph(demoBootstrap.graph); setDebugSnapshot(demoBootstrap.debug); setTracesByRunId(trace ? { [trace.runId]: trace } : {}); setReferencesByRunId(trace ? { [trace.runId]: demoBootstrap.activeMemories } : {}); setDebugByRunId(trace ? { [trace.runId]: demoBootstrap.debug } : {}); setSelectedRunId(trace?.runId ?? null); }
      addToast("success", useDemo ? "Demo preview opened" : "Continuum is ready");
    }} />
    <TopicDetailDialog topic={topicDetail} open={Boolean(topicDetail)} onClose={() => setTopicDetail(null)} onEdit={(topic) => { setTopicDetail(null); setTopicEditor(topic); }} onOpenEvidence={(id) => void openEvidence(id)} onOpenTopic={(identity) => void openTopicIdentity(identity)} onShowInGraph={(id) => void showInGraph(id)} />
    <TopicEditor topic={topicEditor} open={Boolean(topicEditor)} onClose={() => setTopicEditor(null)} onSave={saveTopic} />
    <DeleteImpactDialog open={Boolean(deleteTarget)} title={deleteTarget?.title ?? "memory"} impact={deleteImpact} loading={deleteLoading} onClose={() => { setDeleteTarget(null); setDeleteImpact(null); }} onConfirm={confirmDelete} />
    <ResponseRevisionsDialog open={Boolean(revisionEventId)} revisions={revisions} loading={revisionsLoading} error={revisionsError} onClose={() => setRevisionEventId(null)} onActivate={activateRevision} />
    <EvidenceDialog open={evidenceOpen} evidence={evidenceRecord} loading={evidenceLoading} error={evidenceError} onClose={() => { setEvidenceOpen(false); setEvidenceRecord(null); setEvidenceError(null); }} onOpenEvidence={openEvidence} onCorrectClaim={correctClaim} onDeleteClaim={(id, title) => { setEvidenceOpen(false); setEvidenceRecord(null); setEvidenceError(null); void requestDelete("claims", id, title); }} onReverseMerge={reverseEntityMerge} />
    <EntityMergeDialog open={mergeOpen} candidates={mergeCandidates} loading={mergeLoading} error={mergeError} onClose={() => setMergeOpen(false)} onReview={reviewEntityMerge} onMerge={mergeEntities} onReverse={(mergeId) => reverseEntityMerge(mergeId)} />
    <ResetVaultDialog open={resetOpen} impact={vaultImpact} loading={vaultImpactLoading} error={vaultImpactError} onRetryImpact={loadVaultImpact} onClose={() => { setResetOpen(false); setVaultImpact(null); setVaultImpactError(null); }} onConfirm={async (impact) => { try { if (!isDemo) await continuumApi.destroyVault(impact.requiredPhrase, impact.confirmationToken); resetVaultScopedUiState(); setResetOpen(false); setVaultImpact(null); setOnboardingOpen(true); addToast("success", isDemo ? "Preview cleared" : "Vault destroyed"); } catch (error) { setVaultImpact(null); setVaultImpactError(error instanceof Error ? error.message : "The vault changed; calculate the impact again."); addToast("danger", "Vault was not destroyed", error instanceof Error ? error.message : undefined); } }} />
    <ToastRegion items={toasts} onDismiss={(id) => setToasts((items) => items.filter((item) => item.id !== id))} />
    {bootstrapQuery.isFetching && <div className="bootstrap-status" role="status"><span className="loading-ring" /> Connecting to the local vault…</div>}
  </div>;
}

function wait(milliseconds: number) { return new Promise((resolve) => window.setTimeout(resolve, milliseconds)); }

function traceToMemoryReferences(trace: RetrievalTrace, existing: MemoryReference[]): MemoryReference[] {
  const allowedTypes = new Set<MemoryReference["type"]>(["event", "topic", "claim", "source", "attachment"]);
  return trace.candidates.filter((candidate) => candidate.selected).map((candidate) => {
    const type = allowedTypes.has(candidate.type as MemoryReference["type"]) ? candidate.type as MemoryReference["type"] : "source";
    const prior = existing.find((memory) => memory.id === candidate.id);
    return {
      id: candidate.id,
      type,
      title: candidate.title,
      excerpt: candidate.excerpt,
      ...(type === "event" ? { sourceEventId: candidate.id } : candidate.sourceIds[0] ? { sourceEventId: candidate.sourceIds[0] } : {}),
      ...(type === "topic" ? { topicId: candidate.id } : {}),
      ...(prior?.pinned ? { pinned: true, ...(prior.pinId ? { pinId: prior.pinId } : {}) } : {}),
      reason: candidate.reason
    };
  });
}
