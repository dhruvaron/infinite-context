import type {
  Attachment,
  Claim,
  ConversationEvent,
  GraphResponse,
  QualityPreset,
  RetrievalTrace,
  SearchResult,
  TopicPage
} from "@continuum/contracts";
import type {
  AppSettings as ContractAppSettings,
  AssistantRevision as ContractAssistantRevision,
  Backup as ContractBackup,
  BudgetSummary as ContractBudgetSummary,
  DeletionImpact as ContractDeletionImpact,
  EntityMergeCandidate as ContractEntityMergeCandidate,
  EntityMergeEnvelope as ContractEntityMergeEnvelope,
  EntityMergeResult as ContractEntityMergeResult,
  EvidenceRecord as ContractEvidenceRecord,
  RuntimeState as ContractRuntimeState,
  SecretApproval as ContractSecretApproval,
  ThemePreference as ContractThemePreference,
  TopicDetail as ContractTopicDetail,
  VaultSnapshotBoundary as ContractVaultSnapshotBoundary,
  VaultDeletionImpact as ContractVaultDeletionImpact,
  Workspace as ContractWorkspace
} from "@continuum/contracts/api";

export type ThemePreference = ContractThemePreference;

export type RuntimeState = ContractRuntimeState;

export type AppSettings = ContractAppSettings;

export type BudgetSummary = Pick<ContractBudgetSummary,
  /** Committed provider cost. Kept as totalUsd for existing UI callers. */
  "totalUsd" | "reservedUsd" | "allocatedUsd" | "availableUsd" | "activeReservations" |
  "capUsd" | "warningThresholdUsd" | "inputTokens" | "outputTokens" | "extractionTokens" | "embeddingTokens" |
  "ledgerCreatedAt" | "warningThresholdsReached"
>;

export type MemoryReference = {
  id: string;
  type: "event" | "topic" | "claim" | "source" | "attachment";
  title: string;
  excerpt: string;
  sourceEventId?: string;
  topicId?: string;
  status?: "current" | "historical" | "conflicted" | "expired";
  pinned?: boolean;
  pinId?: string;
  reason?: string;
};

export type BackupRecord = ContractBackup;

export type AuthorizedWorkspace = Pick<ContractWorkspace, "id" | "path" | "displayName" | "readOnly">;

export type SecretFileApproval = Required<Pick<ContractSecretApproval, "id" | "workspaceId" | "relativePath" | "expiresAt" | "oneUse" | "remainingUses" | "status">>;

export type TopicProposal = {
  id: string;
  kind: "topic_update" | "topic_split" | "topic_patch";
  topicId: string | null;
  title: string;
  description: string;
  reason: string;
  proposedAt: string;
  proposedRevision: Record<string, unknown> | null;
  affectedTopicIds: string[];
  canAccept?: boolean;
  acceptanceBlockedReason?: string;
};

export type TopicPageDetail = Omit<ContractTopicDetail, "markdown"> & { markdown?: ContractTopicDetail["markdown"] };

export type AttentionItem = {
  id: string;
  kind: "conflict" | "stale" | "merge" | "job";
  title: string;
  description: string;
  actionLabel?: string;
};

export type DebugSnapshot = {
  trace: RetrievalTrace | null;
  contextPacket: {
    id: string;
    runId: string;
    orderedSourceIds: string[];
    hash: string;
    renderedContent: string;
    reconstructionIntegrity: "verified" | "unavailable" | "mismatch" | "legacy";
    unavailableReferenceIds: string[];
    promptVersion: string;
    tokenBudget: {
      instructions: number;
      recentTurns: number;
      evidence: number;
      reservedOutput: number;
      maximumInput?: number;
    };
  } | null;
  modelCalls: Array<{
    id: string;
    runId?: string;
    label: string;
    model: string;
    latencyMs: number;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    status: "complete" | "failed" | "running";
    promptVersion?: string;
    schemaVersion?: string;
    retrievalVersion?: string;
    modelVersion?: string;
  }>;
  toolCalls: Array<{
    id: string;
    runId: string;
    name: string;
    arguments: unknown;
    output: unknown;
    status: "queued" | "running" | "complete" | "failed" | "cancelled";
    startedAt: string | null;
    completedAt: string | null;
    durationMs: number;
    sandbox: Record<string, unknown> | null;
  }>;
  jobs: Array<{
    id: string;
    name: string;
    status: "queued" | "running" | "complete" | "failed" | "cancelled";
    attempts: number;
    updatedAt: string;
    runId?: string;
    lastErrorCode?: string | null;
  }>;
  promptVersion: string;
  schemaVersion: string;
  versions: {
    prompt: string;
    schema: string;
    retrieval: string;
    reranker: string;
    contextBuilder: string;
    vector: string;
    parser: string;
    chunker: string;
    responseModel: string;
    embeddingModel: string;
  };
};

export type AssistantRevision = ContractAssistantRevision;

export type ActiveRun = {
  id: string;
  status: "pending" | "retrieving" | "streaming";
  userEventId: string | null;
  assistantEventId: string | null;
  createdAt?: string;
};

export type FailedRun = {
  id: string;
  status: "failed";
  userEventId: string | null;
  assistantEventId: string | null;
  errorCode: string | null;
  createdAt?: string;
  completedAt?: string | null;
};

export type BootstrapData = {
  /** Exact server fence used to prove that every bootstrap read came from one vault maintenance generation. */
  vaultBoundary: ContractVaultSnapshotBoundary;
  runtime: RuntimeState;
  settings: AppSettings;
  budget: BudgetSummary;
  events: ConversationEvent[];
  eventsNextCursor: string | null;
  activeRuns: ActiveRun[];
  latestFailedRun: FailedRun | null;
  topics: TopicPage[];
  claims: Claim[];
  graph: GraphResponse;
  activeMemories: MemoryReference[];
  attention: AttentionItem[];
  memoryProposals: TopicProposal[];
  debug: DebugSnapshot;
};

export type SearchFilters = {
  types: SearchResult["type"][];
  role: "all" | "user" | "assistant" | "tool";
  status: "all" | "current" | "superseded";
  date: "all" | "today" | "week" | "month" | "year";
  source: string;
  tag: string;
};

export type PendingAttachment = {
  localId: string;
  /** Stable across retries so an acknowledged upload can be recovered exactly once. */
  idempotencyKey: string;
  file: File;
  previewUrl?: string;
  status: "pending" | "uploading" | "ready" | "failed";
  remote?: Attachment;
  /** The durable remote upload exists, but browser reload discarded the original bytes. */
  fileUnavailable?: boolean;
  error?: string;
};

export type StreamProgress = {
  runId: string | null;
  stage: "idle" | "saving" | "retrieving" | "tool" | "responding" | "connection_lost" | "cancelling" | "cancelled" | "failed";
  label: string;
  activeTool?: string;
};

export type ImpactSummary = ContractDeletionImpact;

export type VaultDeletionImpact = ContractVaultDeletionImpact;

export type EvidenceKind = ContractEvidenceRecord["type"];
export type EvidenceRecord = ContractEvidenceRecord;

export type EntityMergeCandidate = ContractEntityMergeCandidate;
export type EntityMergeEnvelope = ContractEntityMergeEnvelope;
export type EntityMergeResult = ContractEntityMergeResult;

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  quality: "balanced",
  memoryPaused: false,
  webSearchEnabled: true,
  onboardingComplete: false,
  systemInstructions: "Be clear, grounded, and use historical evidence when it is relevant.",
  showSourceChips: true,
  developerOverrides: false,
  promptTracingEnabled: false,
  responseModelIds: {
    fast: "gpt-5.6-luna",
    balanced: "gpt-5.6-terra",
    deep: "gpt-5.6-sol"
  },
  extractionModelId: "gpt-5.6-luna",
  embeddingModelId: "text-embedding-3-small"
};

export type { Claim, ConversationEvent, GraphResponse, QualityPreset, RetrievalTrace, SearchResult, TopicPage };
