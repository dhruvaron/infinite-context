import { z, type ZodTypeAny } from "zod";

import {
  AttachmentSchema,
  ClaimSchema,
  ConversationEventSchema,
  CreateMessageRequestSchema,
  CreateMessageResponseSchema,
  GraphResponseSchema,
  IdSchema,
  QualityPresetSchema,
  RetrievalTraceSchema,
  RunStreamEventSchema,
  SearchResponseSchema,
  TopicPageSchema,
  TopicSlugSchema,
  TopicTypeSchema
} from "./index.js";

/**
 * The public HTTP boundary lives here rather than in either the server or the
 * browser.  Schemas intentionally describe the JSON projection returned over
 * the wire; private database columns and implementation-only fields do not
 * belong in this module.
 */

export const ApiVersionSchema = z.literal("v1");
export const IdempotencyKeySchema = z.string().min(8).max(200);
export const ConfirmationTokenSchema = z.string().length(64).regex(/^[a-f0-9]{64}$/);
export const CursorSchema = z.string().min(1).max(500).nullable();
export const PaginationQuerySchema = z.object({
  cursor: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});
export const IdParamsSchema = z.object({ id: IdSchema });
export const TopicIdentitySchema = z.string().max(200).refine(
  (value) => IdSchema.safeParse(value).success || TopicSlugSchema.safeParse(value).success,
  "Topic identity must be an exact UUID or a lowercase URL-safe slug."
);
export const TopicIdentityParamsSchema = z.object({ identity: TopicIdentitySchema });
export const EmptyMutationRequestSchema = z.object({ idempotencyKey: IdempotencyKeySchema });
export const UnknownRecordSchema = z.object({}).catchall(z.unknown());

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
    traceId: z.string().min(1),
    details: z.record(z.unknown()).optional()
  }).strict()
}).strict();

const DatabaseHealthSchema = z.object({
  integrity: z.string(),
  integrityCheckedAt: z.string().datetime(),
  schemaVersion: z.number().int().nonnegative(),
  vectorAvailable: z.boolean(),
  vectorMode: z.string(),
  vectorStrategy: z.enum(["native-exact-cosine", "bounded-json-cosine"]),
  vectorVersion: z.string().nullable(),
  vectorFallbackLimit: z.number().int().nonnegative(),
  vectorLoadStatus: z.enum(["ready", "degraded"])
}).passthrough();

export const HealthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  database: DatabaseHealthSchema,
  providerConfigured: z.boolean(),
  worker: z.object({ status: z.string(), queuedJobs: z.number().int().nonnegative() }).passthrough(),
  ingestion: UnknownRecordSchema,
  localOnly: z.literal(true),
  version: z.string()
}).passthrough();

export const RuntimeStateSchema = z.object({
  mode: z.enum(["connected", "offline", "degraded", "demo"]),
  apiReachable: z.boolean(),
  providerReachable: z.boolean(),
  vectorSearch: z.enum(["ready", "fallback", "unavailable"]),
  vectorStrategy: z.enum(["native-exact-cosine", "bounded-json-cosine"]).optional(),
  vectorVersion: z.string().nullable().optional(),
  vectorFallbackLimit: z.number().int().nonnegative().optional(),
  vectorLoadStatus: z.enum(["ready", "degraded"]).optional(),
  memoryQueue: z.enum(["idle", "working", "failed", "paused"]),
  activePort: z.number().int().positive().optional(),
  version: z.string().optional(),
  lastMemoryUpdate: z.string().datetime().optional(),
  message: z.string().optional(),
  apiVersion: ApiVersionSchema.optional(),
  vaultId: IdSchema.nullable().optional(),
  storageDirectory: z.string().optional(),
  mockProvider: z.boolean().optional(),
  vectorMode: z.string().optional(),
  ingestion: UnknownRecordSchema.optional(),
  privacy: z.object({ storedLocally: z.boolean(), providerStorageDisabled: z.boolean(), analytics: z.boolean() }).optional()
}).passthrough();

export const ThemePreferenceSchema = z.enum(["light", "dark", "system"]);
export const ResponseModelIdsSchema = z.object({
  fast: z.string().min(1).max(200),
  balanced: z.string().min(1).max(200),
  deep: z.string().min(1).max(200)
}).strict();
export const AppSettingsSchema = z.object({
  theme: ThemePreferenceSchema,
  quality: QualityPresetSchema,
  memoryPaused: z.boolean(),
  webSearchEnabled: z.boolean(),
  onboardingComplete: z.boolean(),
  systemInstructions: z.string().max(20_000),
  showSourceChips: z.boolean(),
  developerOverrides: z.boolean(),
  promptTracingEnabled: z.boolean(),
  responseModelIds: ResponseModelIdsSchema,
  extractionModelId: z.string().min(1).max(200),
  embeddingModelId: z.string().min(1).max(200)
}).strict();
export const SettingsResponseSchema = z.object({ settings: AppSettingsSchema, raw: z.record(z.unknown()) });
export const SettingKeySchema = z.enum([
  "theme", "quality.default", "memory.enabled", "webSearch.enabled", "onboarding.complete",
  "system.instructions", "ui.showSourceChips", "developer.traceMode", "models.response",
  "models.extraction", "models.embedding", "promptTracing.enabled", "quality", "memoryPaused",
  "webSearchEnabled", "onboardingComplete", "systemInstructions", "showSourceChips",
  "developerOverrides", "promptTracingEnabled", "responseModelIds", "extractionModelId", "embeddingModelId"
]);
export const SettingMutationRequestSchema = z.object({
  key: SettingKeySchema,
  value: z.unknown(),
  idempotencyKey: IdempotencyKeySchema
});
export const SettingMutationResponseSchema = z.object({
  key: z.string(),
  value: z.unknown(),
  settings: AppSettingsSchema,
  raw: z.record(z.unknown())
});

export const ProviderSchema = z.object({ id: z.string(), name: z.string(), configured: z.boolean() });
export const ProviderPresetSchema = z.object({
  name: z.string(),
  provider: z.string(),
  modelId: z.string(),
  reasoningEffort: z.string().nullable().optional(),
  active: z.union([z.boolean(), z.number().int()])
}).passthrough();
export const ProvidersResponseSchema = z.object({
  providers: z.array(ProviderSchema),
  presets: z.array(ProviderPresetSchema),
  keyStorage: z.string()
});
export const SetProviderKeyRequestSchema = z.object({ apiKey: z.string().min(20).max(300), idempotencyKey: IdempotencyKeySchema });
export const ProviderConfiguredResponseSchema = z.object({ configured: z.boolean() });

export const BudgetSummarySchema = z.object({
  hardLimitUsd: z.number().nonnegative(),
  spentUsd: z.number().nonnegative(),
  reservedUsd: z.number().nonnegative(),
  allocatedUsd: z.number().nonnegative(),
  availableUsd: z.number().nonnegative(),
  activeReservations: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalUsd: z.number().nonnegative(),
  capUsd: z.number().positive(),
  warningThresholdUsd: z.number().nonnegative(),
  extractionTokens: z.number().int().nonnegative(),
  embeddingTokens: z.number().int().nonnegative(),
  ledgerCreatedAt: z.string().datetime().nullable().optional(),
  warningThresholdsReached: z.array(z.union([z.literal(20), z.literal(50), z.literal(75), z.literal(90)])).default([])
}).passthrough();

export const EventsListQuerySchema = PaginationQuerySchema.extend({ after: z.coerce.number().int().nonnegative().optional() });
export const EventsListResponseSchema = z.object({ events: z.array(ConversationEventSchema), items: z.array(ConversationEventSchema), nextCursor: CursorSchema });
export const AssistantRevisionSchema = z.object({ event: ConversationEventSchema, revisionNumber: z.number().int().positive(), active: z.boolean(), quality: QualityPresetSchema });
export const EventRevisionsListResponseSchema = z.object({ revisions: z.array(AssistantRevisionSchema), items: z.array(AssistantRevisionSchema), nextCursor: CursorSchema });
export const ActivateEventRevisionResponseSchema = z.object({ event: ConversationEventSchema });
export const RegenerateEventRequestSchema = z.object({ idempotencyKey: IdempotencyKeySchema.optional(), quality: QualityPresetSchema.optional() });
export const RegenerateEventResponseSchema = z.object({ runId: IdSchema, quality: QualityPresetSchema });

export const RunStatusSchema = z.enum(["pending", "retrieving", "streaming", "complete", "failed", "cancelled"]);
export const RunRecordSchema = z.object({
  id: IdSchema,
  status: RunStatusSchema,
  quality: QualityPresetSchema.optional(),
  userEventId: IdSchema.nullable().optional(),
  assistantEventId: IdSchema.nullable().optional(),
  errorCode: z.string().nullable().optional(),
  createdAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().nullable().optional(),
  cancellationRequested: z.boolean().optional()
}).passthrough();
export const RunsListQuerySchema = PaginationQuerySchema.extend({
  status: z.union([z.literal("active"), RunStatusSchema]).optional()
});
export const RunsListResponseSchema = z.object({ runs: z.array(RunRecordSchema), items: z.array(RunRecordSchema), nextCursor: CursorSchema });
export const CancelRunResponseSchema = z.object({ cancelled: z.boolean() });

/** A version is present in every JSON SSE data frame, in addition to event:v1. */
export const RunStreamWireEventSchema = z.intersection(
  z.object({ version: ApiVersionSchema }),
  RunStreamEventSchema
);

export const AttachmentListItemSchema = AttachmentSchema.extend({ errorCode: z.string().nullable().optional() });
export const AttachmentsListResponseSchema = z.object({ attachments: z.array(AttachmentListItemSchema), items: z.array(AttachmentListItemSchema), nextCursor: CursorSchema });
export const AttachmentUploadHeadersSchema = z.object({ "idempotency-key": IdempotencyKeySchema });
export const AttachmentContentResponseSchema = z.instanceof(Uint8Array).or(z.instanceof(ArrayBuffer));

export const RecoverableMutationOperationSchema = z.enum(["messages.create", "attachments.upload", "events.regenerate"]);
export const MutationRecoveryQuerySchema = z.object({
  operation: RecoverableMutationOperationSchema,
  key: IdempotencyKeySchema
}).strict();
export const MutationRecoveryResponseSchema = z.union([
  z.object({ found: z.literal(false), operation: RecoverableMutationOperationSchema }).strict(),
  z.object({ found: z.literal(true), operation: z.literal("messages.create"), result: CreateMessageResponseSchema }).strict(),
  z.object({ found: z.literal(true), operation: z.literal("attachments.upload"), result: AttachmentSchema }).strict(),
  z.object({ found: z.literal(true), operation: z.literal("events.regenerate"), result: RegenerateEventResponseSchema }).strict()
]);

export const SourceSchema = z.object({
  id: IdSchema,
  type: z.string(),
  title: z.string(),
  uri: z.string().nullable().optional(),
  contentHash: z.string(),
  freshnessClass: z.string(),
  createdAt: z.string().datetime(),
  retrievedAt: z.string().datetime().nullable().optional()
}).passthrough();
export const SourceChunkSchema = z.object({
  id: IdSchema,
  ordinal: z.number().int().nonnegative(),
  content: z.string(),
  location: z.unknown(),
  tokenCount: z.number().int().nonnegative(),
  contentHash: z.string(),
  createdAt: z.string().datetime()
}).passthrough();
export const SourcesListResponseSchema = z.object({ sources: z.array(SourceSchema), items: z.array(SourceSchema), nextCursor: CursorSchema });
export const SourceDetailQuerySchema = z.object({ chunkCursor: z.coerce.number().int().nonnegative().default(0), chunkLimit: z.coerce.number().int().min(1).max(500).default(200) });
export const SourceDetailResponseSchema = z.object({ source: SourceSchema.extend({ provenance: z.unknown() }), chunks: z.array(SourceChunkSchema), chunksTruncated: z.boolean(), chunkNextCursor: CursorSchema });

export const EvidenceKindSchema = z.enum(["event", "claim", "topic", "entity", "source", "source_chunk", "attachment", "tool_result"]);
export const EvidenceResponseSchema = z.object({ type: EvidenceKindSchema, id: IdSchema, record: UnknownRecordSchema });

export const WorkspaceSchema = z.object({
  id: IdSchema,
  path: z.string(),
  displayName: z.string(),
  readOnly: z.union([z.boolean(), z.number().int()]).transform(Boolean),
  authorized: z.union([z.boolean(), z.number().int()]).optional(),
  authorizedAt: z.string().datetime().nullable().optional(),
  createdAt: z.string().datetime().optional()
}).passthrough();
export const WorkspacesListResponseSchema = z.object({ workspaces: z.array(WorkspaceSchema), items: z.array(WorkspaceSchema), nextCursor: CursorSchema });
export const AuthorizeWorkspaceRequestSchema = z.object({ path: z.string().min(1).max(4096), displayName: z.string().min(1).max(200), idempotencyKey: IdempotencyKeySchema });
export const SecretApprovalRequestSchema = z.object({ relativePath: z.string().min(1).max(4096), acknowledgement: z.literal(true), idempotencyKey: IdempotencyKeySchema });
export const SecretApprovalResponseSchema = z.object({
  id: z.string().min(1),
  workspaceId: IdSchema,
  relativePath: z.string(),
  expiresAt: z.string().datetime(),
  oneUse: z.literal(true),
  remainingUses: z.union([z.literal(0), z.literal(1)]).optional(),
  status: z.enum(["ready", "used", "expired"]).optional()
}).passthrough();
export const RevokeWorkspaceResponseSchema = z.object({ revoked: z.boolean() });

export const ToolExecutionSchema = z.object({ id: IdSchema, runId: IdSchema, toolName: z.string(), status: z.string() }).passthrough();
export const RunFilterListQuerySchema = PaginationQuerySchema.extend({ runId: IdSchema.optional() });
export const ToolsListResponseSchema = z.object({ tools: z.array(ToolExecutionSchema), items: z.array(ToolExecutionSchema), nextCursor: CursorSchema });

export const SearchQuerySchema = z.object({
  q: z.string().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(99).default(30),
  cursor: z.coerce.number().int().nonnegative().default(0),
  types: z.string().max(200).optional(),
  role: z.enum(["all", "user", "assistant", "tool"]).default("all"),
  status: z.enum(["all", "current", "superseded"]).default("all"),
  date: z.enum(["all", "today", "week", "month", "year"]).default("all"),
  source: z.string().max(200).default(""),
  tag: z.string().max(100).default("")
});

export const TopicsListResponseSchema = z.object({ topics: z.array(TopicPageSchema), items: z.array(TopicPageSchema), nextCursor: CursorSchema });
export const TopicDetailSchema = TopicPageSchema.extend({ markdown: z.string() });
export const TopicDetailQuerySchema = z.object({ revision: z.coerce.number().int().positive().optional() });
export const UpdateTopicRequestSchema = z.object({
  expectedRevision: z.number().int().positive(),
  title: z.string().min(1).max(200).optional(),
  summary: z.string().max(10_000).optional(),
  currentState: z.string().max(20_000).optional(),
  history: z.string().max(40_000).optional(),
  openQuestions: z.array(z.string()).max(100).optional(),
  tags: z.array(z.string()).max(50).optional(),
  markdown: z.string().max(200_000).optional(),
  idempotencyKey: IdempotencyKeySchema
});
export const CreateTopicRequestSchema = z.object({
  type: TopicTypeSchema,
  title: z.string().min(1).max(200),
  slug: TopicSlugSchema,
  markdown: z.string().max(200_000),
  summary: z.string().max(10_000),
  currentState: z.string().max(20_000),
  history: z.string().max(40_000),
  openQuestions: z.array(z.string()).max(100).default([]),
  tags: z.array(z.string()).max(50).default([]),
  idempotencyKey: IdempotencyKeySchema
});

const TopicProposalFields = {
  id: z.string().min(16).max(128),
  groupId: z.string().min(16).max(128),
  topicId: IdSchema,
  title: z.string().min(1).max(500),
  claimIds: z.array(IdSchema).max(10_000),
  sourceIds: z.array(IdSchema).max(10_000),
  parentRevisionId: IdSchema,
  parentRevision: z.number().int().positive(),
  baseRevision: z.number().int().nonnegative().optional(),
  children: z.array(z.object({
    topicId: IdSchema,
    revisionId: IdSchema,
    revision: z.number().int().positive(),
    baseRevision: z.number().int().nonnegative().nullable().optional(),
    title: z.string().min(1).max(500),
    slug: TopicSlugSchema,
    evidenceIds: z.array(IdSchema).max(10_000)
  })).max(1_000),
  links: z.array(z.object({
    sourceTopicId: IdSchema,
    targetTopicId: IdSchema,
    relationType: z.string().min(1).max(100),
    evidenceIds: z.array(IdSchema).max(10_000)
  })).max(5_000),
  requiresConfirmation: z.literal(true),
  status: z.literal("pending"),
  createdAt: z.string().datetime()
} as const;
export const TopicUpdateProposalSchema = z.object({ ...TopicProposalFields, kind: z.literal("topic_update") });
export const TopicRestructureProposalSchema = z.object({ ...TopicProposalFields, kind: z.literal("topic_restructure") });
export const TopicProposalSchema = z.discriminatedUnion("kind", [TopicUpdateProposalSchema, TopicRestructureProposalSchema]);

const TopicProposalFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const TopicShardProposalSectionSchema = z.enum(["current_state", "history", "evidence"]);
export const TopicShardProposalBaseSchema = z.object({
  topicId: IdSchema,
  revisionId: IdSchema,
  revision: z.number().int().positive(),
  ordinal: z.number().int().positive(),
  minSortKey: z.string().max(1_024),
  maxSortKey: z.string().max(1_024),
  fingerprint: TopicProposalFingerprintSchema
});
export const TopicShardProposalRouteGuardSchema = z.object({
  claimId: IdSchema,
  sortKey: z.string().max(1_024),
  expectedBaseTopicId: IdSchema.nullable()
});
export const TopicShardProposalOutputSchema = z.object({
  topicId: IdSchema,
  revisionId: IdSchema,
  revision: z.number().int().positive(),
  baseRevision: z.number().int().positive().nullable(),
  title: z.string().min(1).max(500),
  slug: TopicSlugSchema,
  ordinal: z.number().int().positive(),
  minSortKey: z.string().max(1_024),
  maxSortKey: z.string().max(1_024),
  claimIds: z.array(IdSchema).max(10_000),
  sourceIds: z.array(IdSchema).max(10_000),
  evidenceIds: z.array(IdSchema).max(20_000),
  contentHash: TopicProposalFingerprintSchema
});
export const TopicShardProposalPatchSchema = z.object({
  section: TopicShardProposalSectionSchema,
  base: TopicShardProposalBaseSchema.nullable(),
  routeGuards: z.array(TopicShardProposalRouteGuardSchema).max(10_000),
  outputs: z.array(TopicShardProposalOutputSchema).max(1_000)
});
export const TopicShardProposalClaimGuardSchema = z.object({
  claimId: IdSchema,
  expectedTopicId: IdSchema.nullable(),
  stateHash: TopicProposalFingerprintSchema,
  projectedTopicId: IdSchema.nullable(),
  assignToTopicId: IdSchema.nullable()
});
export const TopicShardProposalSchema = z.object({
  schemaVersion: z.literal(2),
  id: TopicProposalFingerprintSchema,
  groupId: TopicProposalFingerprintSchema,
  kind: z.literal("topic_shard_patch"),
  topicId: IdSchema,
  title: z.string().min(1).max(500),
  parentBase: z.object({
    revisionId: IdSchema,
    revision: z.number().int().positive(),
    fingerprint: TopicProposalFingerprintSchema
  }),
  patches: z.array(TopicShardProposalPatchSchema).min(1).max(100),
  claimGuards: z.array(TopicShardProposalClaimGuardSchema).min(1).max(10_000),
  claimIds: z.array(IdSchema).max(10_000),
  sourceIds: z.array(IdSchema).max(10_000),
  requiresConfirmation: z.literal(true),
  status: z.literal("pending"),
  createdAt: z.string().datetime()
});
export const TopicProposalRecordSchema = z.discriminatedUnion("kind", [
  TopicUpdateProposalSchema,
  TopicRestructureProposalSchema,
  TopicShardProposalSchema
]);
export const TopicProposalsListResponseSchema = z.object({ proposals: z.array(TopicProposalRecordSchema), items: z.array(TopicProposalRecordSchema), nextCursor: CursorSchema });
export const TopicProposalIdParamsSchema = z.object({ id: z.string().min(16).max(128) });
export const ResolveTopicProposalRequestSchema = z.object({ action: z.enum(["accept", "reject"]), idempotencyKey: IdempotencyKeySchema });
export const ResolveTopicProposalResponseSchema = z.object({ resolved: z.literal(true), action: z.enum(["accept", "reject"]), proposalId: z.string(), topicIds: z.array(IdSchema) });

export const ClaimsListResponseSchema = z.object({ claims: z.array(ClaimSchema), items: z.array(ClaimSchema), nextCursor: CursorSchema });
export const ClaimDetailResponseSchema = z.object({ claim: ClaimSchema, evidence: z.array(UnknownRecordSchema), relations: z.array(UnknownRecordSchema) });
export const CorrectClaimRequestSchema = z.object({ value: z.string().trim().min(1).max(50_000), reason: z.string().trim().max(5_000).default(""), idempotencyKey: IdempotencyKeySchema });
export const CorrectClaimResponseSchema = z.object({ event: ConversationEventSchema, claim: ClaimSchema, supersededClaimId: IdSchema });

export const EntitySchema = z.object({ id: IdSchema, type: z.string(), displayName: z.string(), status: z.string(), description: z.string(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() }).passthrough();
export const EntitiesListResponseSchema = z.object({ entities: z.array(EntitySchema), items: z.array(EntitySchema), nextCursor: CursorSchema });
export const EntityDetailResponseSchema = z.object({ entity: EntitySchema, aliases: z.array(UnknownRecordSchema), edges: z.array(UnknownRecordSchema), mergeHistory: z.array(UnknownRecordSchema) });
export const EntityMergeCandidateSchema = z.object({ sourceId: IdSchema, targetId: IdSchema, score: z.number().min(0).max(1), sourceName: z.string(), targetName: z.string(), type: z.string(), reason: z.string() });
export const EntityMergeCandidatesListResponseSchema = z.object({ candidates: z.array(EntityMergeCandidateSchema), items: z.array(EntityMergeCandidateSchema), nextCursor: CursorSchema });
export const EntityMergeCandidatesQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.coerce.number().int().nonnegative().default(0) });
export const EntityMergeImpactRequestSchema = z.object({ sourceId: IdSchema, targetId: IdSchema, idempotencyKey: IdempotencyKeySchema });
export const EntityMergeImpactSchema = z.object({ sourceId: IdSchema, targetId: IdSchema, sourceName: z.string(), targetName: z.string(), type: z.string(), aliasesMoved: z.number().int().nonnegative(), edgesRewritten: z.number().int().nonnegative(), reversible: z.boolean() });
export const EntityMergeImpactResponseSchema = z.object({ impact: EntityMergeImpactSchema, confirmationToken: ConfirmationTokenSchema });
export const EntityMergeRequestSchema = EntityMergeImpactRequestSchema.extend({ confirmationToken: ConfirmationTokenSchema });
export const EntityMergeResultSchema = z.object({ mergeId: IdSchema, sourceId: IdSchema, targetId: IdSchema, reversedAt: z.string().datetime().optional() });

export const GraphQuerySchema = z.object({ focusId: IdSchema.optional(), limit: z.coerce.number().int().min(10).max(1000).default(300), hops: z.coerce.number().int().min(1).max(2).default(2), history: z.enum(["true", "false"]).default("true") });

export const MemoryPinSchema = z.object({ id: IdSchema, object_type: z.enum(["event", "topic", "claim", "source"]), object_id: IdSchema, label: z.string(), created_at: z.string().datetime() }).passthrough();
export const MemoryPinsListResponseSchema = z.object({ pins: z.array(MemoryPinSchema), items: z.array(MemoryPinSchema), nextCursor: CursorSchema });
export const CreateMemoryPinRequestSchema = z.object({ objectType: z.enum(["event", "topic", "claim", "source"]), objectId: IdSchema, label: z.string().min(1).max(200), idempotencyKey: IdempotencyKeySchema });
export const CreateMemoryPinResponseSchema = z.object({ id: IdSchema });
export const DeleteMemoryPinResponseSchema = z.object({ deleted: z.boolean() });

export const MemoryLintIssueSchema = z.object({ severity: z.enum(["warning", "error"]), type: z.string(), objectId: IdSchema, message: z.string() });
export const MemoryLintListResponseSchema = z.object({ issues: z.array(MemoryLintIssueSchema), items: z.array(MemoryLintIssueSchema), nextCursor: CursorSchema });
export const StartMemoryLintRequestSchema = z.object({ idempotencyKey: IdempotencyKeySchema.optional() });
export const StartMemoryLintResponseSchema = z.object({ jobId: IdSchema });

export const MemoryJobSchema = z.object({
  id: IdSchema,
  type: z.string(),
  status: z.string(),
  attempts: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
  payload: z.record(z.string(), z.unknown()).optional(),
  lastErrorCode: z.string().nullable().optional()
}).passthrough();
export const MemoryJobsListResponseSchema = z.object({ jobs: z.array(MemoryJobSchema), items: z.array(MemoryJobSchema), nextCursor: CursorSchema });
export const RetryMemoryJobResponseSchema = z.object({ queued: z.boolean() });

export const RetrievalTracesListResponseSchema = z.object({ traces: z.array(RetrievalTraceSchema), items: z.array(RetrievalTraceSchema), nextCursor: CursorSchema });
export const LatestRetrievalTraceResponseSchema = z.object({ trace: RetrievalTraceSchema.nullable() });

export const ContextPacketSchema = z.object({ id: IdSchema, runId: IdSchema, budget: z.union([z.string(), UnknownRecordSchema]), sourceIds: z.union([z.string(), z.array(IdSchema)]), promptVersion: z.string(), contentHash: z.string(), renderedContent: z.string().optional(), createdAt: z.string().datetime() }).passthrough();
export const ContextPacketsListResponseSchema = z.object({ packets: z.array(ContextPacketSchema), items: z.array(ContextPacketSchema), nextCursor: CursorSchema });
export const ModelCallSchema = z.object({ id: IdSchema, runId: IdSchema.nullable().optional(), provider: z.string(), model: z.string(), purpose: z.string(), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), latencyMs: z.number().nonnegative(), status: z.string(), estimatedCostUsd: z.number().nonnegative(), createdAt: z.string().datetime() }).passthrough();
export const ModelCallsListResponseSchema = z.object({ calls: z.array(ModelCallSchema), items: z.array(ModelCallSchema), nextCursor: CursorSchema });
export const RunDebugResponseSchema = z.object({ runId: IdSchema, trace: RetrievalTraceSchema.nullable(), contextPacket: UnknownRecordSchema.nullable(), modelCalls: z.array(UnknownRecordSchema), toolCalls: z.array(UnknownRecordSchema), versions: UnknownRecordSchema });

export const ExportVaultRequestSchema = z.object({ includeAttachments: z.boolean().default(true), includeSensitiveToolOutput: z.boolean().default(false), idempotencyKey: IdempotencyKeySchema });
export const ExportVaultResponseSchema = z.object({ filename: z.string(), size: z.number().int().nonnegative(), checksum: z.string(), downloadUrl: z.string() }).passthrough();
export const ExportFilenameParamsSchema = z.object({ filename: z.string().min(1).max(255) });
export const ImportVaultHeadersSchema = z.object({ "idempotency-key": IdempotencyKeySchema });
export const ImportVaultModeSchema = z.enum(["verify", "replace", "fresh"]);
export const ImportVerifiedVaultRequestSchema = z.object({
  verificationToken: z.string().uuid(),
  mode: z.enum(["replace", "fresh"]),
  idempotencyKey: IdempotencyKeySchema
}).strict();
export const VerifiedImportVaultResponseSchema = z.object({
  valid: z.literal(true),
  replaced: z.literal(false),
  manifest: UnknownRecordSchema,
  verificationToken: IdSchema,
  archiveChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
  expiresAt: z.string().datetime()
}).passthrough();
export const CommittedImportVaultResponseSchema = z.object({
  valid: z.literal(true),
  replaced: z.literal(true),
  mode: z.enum(["replace", "fresh"]),
  manifest: UnknownRecordSchema,
  attachmentsRestored: z.number().int().nonnegative(),
  rebuildJobs: z.number().int().nonnegative(),
  warnings: z.array(z.string())
}).passthrough();
export const ImportVaultResponseSchema = z.discriminatedUnion("replaced", [
  VerifiedImportVaultResponseSchema,
  CommittedImportVaultResponseSchema
]);

export const BackupSchema = z.object({ id: IdSchema, filename: z.string(), kind: z.enum(["daily", "weekly", "manual"]), size: z.number().int().nonnegative(), checksum: z.string(), createdAt: z.string().datetime() }).passthrough();
export const BackupsListResponseSchema = z.object({ backups: z.array(BackupSchema), items: z.array(BackupSchema), nextCursor: CursorSchema });

export const VaultStatusResponseSchema = z.object({ vault: UnknownRecordSchema, counts: z.object({ events: z.number().int().nonnegative(), topics: z.number().int().nonnegative(), claims: z.number().int().nonnegative(), sources: z.number().int().nonnegative() }), databaseBytes: z.number().int().nonnegative() });
export const DeletionImpactSchema = z.object({ confirmationToken: ConfirmationTokenSchema, events: z.number().int().nonnegative(), attachments: z.number().int().nonnegative(), claimsRemoved: z.number().int().nonnegative(), claimsRetained: z.number().int().nonnegative(), topicsRebuilt: z.number().int().nonnegative(), edgesRemoved: z.number().int().nonnegative(), managedBackupsAffected: z.number().int().nonnegative() }).passthrough();
export const DeletionImpactRequestSchema = z.object({ idempotencyKey: IdempotencyKeySchema.optional() });
export const LegacyEventDeletionImpactSchema = DeletionImpactSchema.extend({
  impact: z.object({
    objectType: z.literal("event"),
    objectId: IdSchema,
    counts: UnknownRecordSchema,
    warning: z.string()
  })
});
export const DeleteResourceRequestSchema = z.object({ confirmationToken: ConfirmationTokenSchema, idempotencyKey: IdempotencyKeySchema });
export const VaultDeletionImpactSchema = DeletionImpactSchema.extend({ requiredPhrase: z.literal("DELETE MY CONTINUUM VAULT") });
export const DeleteVaultRequestSchema = z.object({ confirmation: z.literal("DELETE MY CONTINUUM VAULT"), confirmationToken: ConfirmationTokenSchema, idempotencyKey: IdempotencyKeySchema });
export const DeleteVaultResponseSchema = z.object({ destroyed: z.boolean(), keyRetainedInKeychain: z.boolean() });
export const GenericDeletionResponseSchema = UnknownRecordSchema;

type ContractRequest = { params?: ZodTypeAny; query?: ZodTypeAny; headers?: ZodTypeAny; body?: ZodTypeAny };
export type PublicApiContract = {
  id: string;
  group: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  request?: ContractRequest;
  response: ZodTypeAny;
  list?: boolean;
  mutation?: boolean;
  destructive?: boolean;
  sse?: ZodTypeAny;
};

const route = <const Contract extends PublicApiContract>(contract: Contract) => contract;

/**
 * CI treats this as the canonical coverage inventory for the section-11 API.
 * Every JSON endpoint has request and response schemas here; binary endpoints
 * explicitly declare their byte response. Dynamic `:id` paths use Fastify's
 * route spelling so source/runtime drift can be detected mechanically.
 */
export const PUBLIC_API_CONTRACTS = [
  route({ id: "health.get", group: "health", method: "GET", path: "/api/v1/health", response: HealthResponseSchema }),
  route({ id: "runtime.get", group: "runtime", method: "GET", path: "/api/v1/runtime", response: RuntimeStateSchema }),
  route({ id: "settings.get", group: "settings", method: "GET", path: "/api/v1/settings", response: SettingsResponseSchema }),
  route({ id: "settings.put", group: "settings", method: "PUT", path: "/api/v1/settings", request: { body: SettingMutationRequestSchema }, response: SettingMutationResponseSchema, mutation: true }),
  route({ id: "providers.list", group: "providers", method: "GET", path: "/api/v1/providers", response: ProvidersResponseSchema }),
  route({ id: "providers.key.set", group: "providers", method: "POST", path: "/api/v1/providers/openai-key", request: { body: SetProviderKeyRequestSchema }, response: ProviderConfiguredResponseSchema, mutation: true }),
  route({ id: "providers.key.delete", group: "providers", method: "DELETE", path: "/api/v1/providers/openai-key", request: { body: EmptyMutationRequestSchema }, response: ProviderConfiguredResponseSchema, mutation: true }),
  route({ id: "budget.get", group: "budget", method: "GET", path: "/api/v1/budget", response: BudgetSummarySchema }),
  route({ id: "events.list", group: "events", method: "GET", path: "/api/v1/events", request: { query: EventsListQuerySchema }, response: EventsListResponseSchema, list: true }),
  route({ id: "events.get", group: "events", method: "GET", path: "/api/v1/events/:id", request: { params: IdParamsSchema }, response: ConversationEventSchema }),
  route({ id: "events.revisions", group: "events", method: "GET", path: "/api/v1/events/:id/revisions", request: { params: IdParamsSchema, query: PaginationQuerySchema }, response: EventRevisionsListResponseSchema, list: true }),
  route({ id: "events.activate", group: "events", method: "PATCH", path: "/api/v1/events/:id/activate", request: { params: IdParamsSchema, body: EmptyMutationRequestSchema }, response: ActivateEventRevisionResponseSchema, mutation: true }),
  route({ id: "events.regenerate", group: "events", method: "POST", path: "/api/v1/events/:id/regenerate", request: { params: IdParamsSchema, body: RegenerateEventRequestSchema }, response: RegenerateEventResponseSchema, mutation: true }),
  route({ id: "messages.create", group: "messages", method: "POST", path: "/api/v1/messages", request: { body: CreateMessageRequestSchema }, response: CreateMessageResponseSchema, mutation: true }),
  route({ id: "runs.list", group: "runs", method: "GET", path: "/api/v1/runs", request: { query: RunsListQuerySchema }, response: RunsListResponseSchema, list: true }),
  route({ id: "runs.get", group: "runs", method: "GET", path: "/api/v1/runs/:id", request: { params: IdParamsSchema }, response: RunRecordSchema }),
  route({ id: "runs.cancel", group: "runs", method: "POST", path: "/api/v1/runs/:id/cancel", request: { params: IdParamsSchema, body: EmptyMutationRequestSchema }, response: CancelRunResponseSchema, mutation: true }),
  route({ id: "runs.stream", group: "runs", method: "GET", path: "/api/v1/runs/:id/stream", request: { params: IdParamsSchema }, response: RunStreamWireEventSchema, sse: RunStreamWireEventSchema }),
  route({ id: "runs.debug", group: "runs", method: "GET", path: "/api/v1/runs/:id/debug", request: { params: IdParamsSchema }, response: RunDebugResponseSchema }),
  route({ id: "mutations.recover", group: "runs", method: "GET", path: "/api/v1/idempotency-recovery", request: { query: MutationRecoveryQuerySchema }, response: MutationRecoveryResponseSchema }),
  route({ id: "attachments.create", group: "attachments", method: "POST", path: "/api/v1/attachments", request: { headers: AttachmentUploadHeadersSchema }, response: AttachmentSchema, mutation: true }),
  route({ id: "attachments.list", group: "attachments", method: "GET", path: "/api/v1/attachments", request: { query: PaginationQuerySchema }, response: AttachmentsListResponseSchema, list: true }),
  route({ id: "attachments.get", group: "attachments", method: "GET", path: "/api/v1/attachments/:id", request: { params: IdParamsSchema }, response: AttachmentSchema }),
  route({ id: "attachments.content", group: "attachments", method: "GET", path: "/api/v1/attachments/:id/content", request: { params: IdParamsSchema }, response: AttachmentContentResponseSchema }),
  route({ id: "sources.list", group: "sources", method: "GET", path: "/api/v1/sources", request: { query: PaginationQuerySchema }, response: SourcesListResponseSchema, list: true }),
  route({ id: "sources.get", group: "sources", method: "GET", path: "/api/v1/sources/:id", request: { params: IdParamsSchema, query: SourceDetailQuerySchema }, response: SourceDetailResponseSchema }),
  route({ id: "evidence.get", group: "sources", method: "GET", path: "/api/v1/evidence/:id", request: { params: IdParamsSchema }, response: EvidenceResponseSchema }),
  route({ id: "workspaces.list", group: "workspaces", method: "GET", path: "/api/v1/workspaces", request: { query: PaginationQuerySchema }, response: WorkspacesListResponseSchema, list: true }),
  route({ id: "workspaces.create", group: "workspaces", method: "POST", path: "/api/v1/workspaces", request: { body: AuthorizeWorkspaceRequestSchema }, response: WorkspaceSchema, mutation: true }),
  route({ id: "workspaces.secret", group: "workspaces", method: "POST", path: "/api/v1/workspaces/:id/secret-approvals", request: { params: IdParamsSchema, body: SecretApprovalRequestSchema }, response: SecretApprovalResponseSchema, mutation: true }),
  route({ id: "workspaces.delete", group: "workspaces", method: "DELETE", path: "/api/v1/workspaces/:id", request: { params: IdParamsSchema, body: EmptyMutationRequestSchema }, response: RevokeWorkspaceResponseSchema, mutation: true }),
  route({ id: "tools.list", group: "tools", method: "GET", path: "/api/v1/tools", request: { query: RunFilterListQuerySchema }, response: ToolsListResponseSchema, list: true }),
  route({ id: "search.get", group: "search", method: "GET", path: "/api/v1/search", request: { query: SearchQuerySchema }, response: SearchResponseSchema, list: true }),
  route({ id: "topics.list", group: "topics", method: "GET", path: "/api/v1/topics", request: { query: PaginationQuerySchema }, response: TopicsListResponseSchema, list: true }),
  route({ id: "topics.get", group: "topics", method: "GET", path: "/api/v1/topics/:identity", request: { params: TopicIdentityParamsSchema, query: TopicDetailQuerySchema }, response: TopicDetailSchema }),
  route({ id: "topics.update", group: "topics", method: "PATCH", path: "/api/v1/topics/:id", request: { params: IdParamsSchema, body: UpdateTopicRequestSchema }, response: TopicPageSchema, mutation: true }),
  route({ id: "topics.create", group: "topics", method: "POST", path: "/api/v1/topics", request: { body: CreateTopicRequestSchema }, response: TopicPageSchema, mutation: true }),
  route({ id: "proposals.list", group: "topics", method: "GET", path: "/api/v1/memory-proposals", request: { query: PaginationQuerySchema }, response: TopicProposalsListResponseSchema, list: true }),
  route({ id: "proposals.resolve", group: "topics", method: "POST", path: "/api/v1/memory-proposals/:id/resolve", request: { params: TopicProposalIdParamsSchema, body: ResolveTopicProposalRequestSchema }, response: ResolveTopicProposalResponseSchema, mutation: true }),
  route({ id: "claims.list", group: "claims", method: "GET", path: "/api/v1/claims", request: { query: PaginationQuerySchema }, response: ClaimsListResponseSchema, list: true }),
  route({ id: "claims.get", group: "claims", method: "GET", path: "/api/v1/claims/:id", request: { params: IdParamsSchema }, response: ClaimDetailResponseSchema }),
  route({ id: "claims.correct", group: "claims", method: "POST", path: "/api/v1/claims/:id/correct", request: { params: IdParamsSchema, body: CorrectClaimRequestSchema }, response: CorrectClaimResponseSchema, mutation: true }),
  route({ id: "entities.list", group: "entities", method: "GET", path: "/api/v1/entities", request: { query: PaginationQuerySchema }, response: EntitiesListResponseSchema, list: true }),
  route({ id: "entities.candidates", group: "entities", method: "GET", path: "/api/v1/entities/merge-candidates", request: { query: EntityMergeCandidatesQuerySchema }, response: EntityMergeCandidatesListResponseSchema, list: true }),
  route({ id: "entities.get", group: "entities", method: "GET", path: "/api/v1/entities/:id", request: { params: IdParamsSchema }, response: EntityDetailResponseSchema }),
  route({ id: "entities.impact", group: "entities", method: "POST", path: "/api/v1/entities/merge-impact", request: { body: EntityMergeImpactRequestSchema }, response: EntityMergeImpactResponseSchema }),
  route({ id: "entities.merge", group: "entities", method: "POST", path: "/api/v1/entities/merge", request: { body: EntityMergeRequestSchema }, response: EntityMergeResultSchema, mutation: true, destructive: true }),
  route({ id: "entities.reverse", group: "entities", method: "POST", path: "/api/v1/entities/merges/:id/reverse", request: { params: IdParamsSchema, body: EmptyMutationRequestSchema }, response: EntityMergeResultSchema, mutation: true }),
  route({ id: "graph.get", group: "graph", method: "GET", path: "/api/v1/graph", request: { query: GraphQuerySchema }, response: GraphResponseSchema }),
  route({ id: "pins.list", group: "memories", method: "GET", path: "/api/v1/memories/pins", request: { query: PaginationQuerySchema }, response: MemoryPinsListResponseSchema, list: true }),
  route({ id: "pins.create", group: "memories", method: "POST", path: "/api/v1/memories/pins", request: { body: CreateMemoryPinRequestSchema }, response: CreateMemoryPinResponseSchema, mutation: true }),
  route({ id: "pins.delete", group: "memories", method: "DELETE", path: "/api/v1/memories/pins/:id", request: { params: IdParamsSchema, body: EmptyMutationRequestSchema }, response: DeleteMemoryPinResponseSchema, mutation: true }),
  route({ id: "lint.list", group: "memories", method: "GET", path: "/api/v1/memories/lint", request: { query: PaginationQuerySchema }, response: MemoryLintListResponseSchema, list: true }),
  route({ id: "lint.start", group: "memories", method: "POST", path: "/api/v1/memories/lint", request: { body: StartMemoryLintRequestSchema }, response: StartMemoryLintResponseSchema, mutation: true }),
  route({ id: "jobs.list", group: "memory-jobs", method: "GET", path: "/api/v1/memory-jobs", request: { query: RunFilterListQuerySchema }, response: MemoryJobsListResponseSchema, list: true }),
  route({ id: "jobs.retry", group: "memory-jobs", method: "POST", path: "/api/v1/memory-jobs/:id/retry", request: { params: IdParamsSchema, body: EmptyMutationRequestSchema }, response: RetryMemoryJobResponseSchema, mutation: true }),
  route({ id: "traces.list", group: "retrieval-traces", method: "GET", path: "/api/v1/retrieval-traces", request: { query: RunFilterListQuerySchema }, response: RetrievalTracesListResponseSchema, list: true }),
  route({ id: "traces.latest", group: "retrieval-traces", method: "GET", path: "/api/v1/retrieval-traces/latest", response: LatestRetrievalTraceResponseSchema }),
  route({ id: "traces.get", group: "retrieval-traces", method: "GET", path: "/api/v1/retrieval-traces/:id", request: { params: IdParamsSchema }, response: RetrievalTraceSchema }),
  route({ id: "packets.list", group: "context-packets", method: "GET", path: "/api/v1/context-packets", request: { query: RunFilterListQuerySchema }, response: ContextPacketsListResponseSchema, list: true }),
  route({ id: "calls.list", group: "model-calls", method: "GET", path: "/api/v1/model-calls", request: { query: RunFilterListQuerySchema }, response: ModelCallsListResponseSchema, list: true }),
  route({ id: "export.create", group: "export", method: "POST", path: "/api/v1/export", request: { body: ExportVaultRequestSchema }, response: ExportVaultResponseSchema, mutation: true }),
  route({ id: "export.download", group: "export", method: "GET", path: "/api/v1/export/:filename", request: { params: ExportFilenameParamsSchema }, response: AttachmentContentResponseSchema }),
  route({ id: "import.create", group: "import", method: "POST", path: "/api/v1/import", request: { headers: ImportVaultHeadersSchema }, response: ImportVaultResponseSchema, mutation: true, destructive: true }),
  route({ id: "import.commit", group: "import", method: "POST", path: "/api/v1/import/commit", request: { body: ImportVerifiedVaultRequestSchema }, response: ImportVaultResponseSchema, mutation: true, destructive: true }),
  route({ id: "backups.list", group: "backups", method: "GET", path: "/api/v1/backups", request: { query: PaginationQuerySchema }, response: BackupsListResponseSchema, list: true }),
  route({ id: "backups.create", group: "backups", method: "POST", path: "/api/v1/backups", request: { body: EmptyMutationRequestSchema }, response: BackupSchema, mutation: true }),
  route({ id: "vault.get", group: "vault", method: "GET", path: "/api/v1/vault", response: VaultStatusResponseSchema }),
  ...(["events", "attachments", "claims", "topics"] as const).flatMap((resource) => [
    route({ id: `${resource}.deletion-impact`, group: resource, method: "POST", path: `/api/v1/${resource}/:id/deletion-impact`, request: { params: IdParamsSchema, body: DeletionImpactRequestSchema }, response: DeletionImpactSchema }),
    route({ id: `${resource}.delete`, group: resource, method: "DELETE", path: `/api/v1/${resource}/:id`, request: { params: IdParamsSchema, body: DeleteResourceRequestSchema }, response: GenericDeletionResponseSchema, mutation: true, destructive: true })
  ]),
  route({ id: "events.legacy-delete-impact", group: "events", method: "GET", path: "/api/v1/events/:id/delete-impact", request: { params: IdParamsSchema }, response: LegacyEventDeletionImpactSchema }),
  route({ id: "vault.deletion-impact", group: "vault", method: "POST", path: "/api/v1/vault/deletion-impact", response: VaultDeletionImpactSchema }),
  route({ id: "vault.delete", group: "vault", method: "DELETE", path: "/api/v1/vault", request: { body: DeleteVaultRequestSchema }, response: DeleteVaultResponseSchema, mutation: true, destructive: true })
] as const satisfies readonly PublicApiContract[];

export type PublicApiContractEntry = (typeof PUBLIC_API_CONTRACTS)[number];
export type PublicApiContractId = PublicApiContractEntry["id"];
export type PublicApiResponse<Id extends PublicApiContractId> = z.output<Extract<PublicApiContractEntry, { id: Id }>["response"]>;
export type PublicApiRequestBody<Id extends PublicApiContractId> = Extract<PublicApiContractEntry, { id: Id }> extends { request: { body: infer Schema extends ZodTypeAny } }
  ? z.input<Schema>
  : never;

const PUBLIC_API_CONTRACT_BY_ROUTE = new Map<string, PublicApiContract>(
  PUBLIC_API_CONTRACTS.map((contract) => [`${contract.method} ${contract.path}`, contract])
);

export function publicApiContractFor(method: string, routePath: string): PublicApiContract | undefined {
  return PUBLIC_API_CONTRACT_BY_ROUTE.get(`${method.toUpperCase()} ${routePath}`);
}

export const PUBLIC_API_RESOURCE_GROUPS = [
  "health", "runtime", "settings", "providers", "budget", "events", "messages", "runs",
  "attachments", "sources", "workspaces", "tools", "search", "topics", "claims", "entities",
  "graph", "memories", "memory-jobs", "retrieval-traces", "context-packets", "model-calls",
  "export", "import", "backups", "vault"
] as const;

export type RuntimeState = z.infer<typeof RuntimeStateSchema>;
export type ThemePreference = z.infer<typeof ThemePreferenceSchema>;
export type AppSettings = z.infer<typeof AppSettingsSchema>;
export type BudgetSummary = z.infer<typeof BudgetSummarySchema>;
export type AssistantRevision = z.infer<typeof AssistantRevisionSchema>;
export type Workspace = z.output<typeof WorkspaceSchema>;
export type SecretApproval = z.infer<typeof SecretApprovalResponseSchema>;
export type Backup = z.infer<typeof BackupSchema>;
export type EvidenceRecord = z.infer<typeof EvidenceResponseSchema>;
export type TopicDetail = z.infer<typeof TopicDetailSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
export type RunRecord = z.infer<typeof RunRecordSchema>;
export type RecoverableMutationOperation = z.infer<typeof RecoverableMutationOperationSchema>;
export type MutationRecoveryResponse = z.infer<typeof MutationRecoveryResponseSchema>;
export type Source = z.infer<typeof SourceSchema>;
export type MemoryJob = z.infer<typeof MemoryJobSchema>;
export type TopicProposal = z.infer<typeof TopicProposalSchema>;
export type TopicShardProposal = z.infer<typeof TopicShardProposalSchema>;
export type TopicProposalRecord = z.infer<typeof TopicProposalRecordSchema>;
export type EntityMergeCandidate = z.infer<typeof EntityMergeCandidateSchema>;
export type EntityMergeImpact = z.infer<typeof EntityMergeImpactSchema>;
export type EntityMergeEnvelope = z.infer<typeof EntityMergeImpactResponseSchema>;
export type EntityMergeResult = z.infer<typeof EntityMergeResultSchema>;
export type DeletionImpact = z.infer<typeof DeletionImpactSchema>;
export type VaultDeletionImpact = z.infer<typeof VaultDeletionImpactSchema>;
export type RunStreamWireEvent = z.infer<typeof RunStreamWireEventSchema>;
