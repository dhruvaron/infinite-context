import { z } from "zod";

export const IdSchema = z.string().uuid();
export const TimestampSchema = z.string().datetime();

export const EventRoleSchema = z.enum([
  "user",
  "assistant",
  "system",
  "tool"
]);

export const EventKindSchema = z.enum([
  "message",
  "tool_call",
  "tool_result",
  "attachment",
  "cancellation",
  "error",
  "revision"
]);

export const EventStatusSchema = z.enum([
  "pending",
  "streaming",
  "complete",
  "incomplete",
  "failed",
  "excluded"
]);

export const AttachmentSchema = z.object({
  id: IdSchema,
  sourceId: IdSchema,
  filename: z.string().min(1).max(255),
  mediaType: z.string().min(1).max(127),
  size: z.number().int().nonnegative(),
  status: z.enum(["queued", "processing", "ready", "failed"]),
  createdAt: TimestampSchema
});

export const ConversationEventSchema = z.object({
  id: IdSchema,
  sequence: z.number().int().positive(),
  role: EventRoleSchema,
  kind: EventKindSchema,
  status: EventStatusSchema,
  content: z.string(),
  parentEventId: IdSchema.nullable(),
  runId: IdSchema.nullable(),
  active: z.boolean(),
  createdAt: TimestampSchema,
  completedAt: TimestampSchema.nullable(),
  attachments: z.array(AttachmentSchema).default([])
});

export const TopicTypeSchema = z.enum([
  "person",
  "organization",
  "project",
  "concept",
  "preference",
  "decision",
  "goal",
  "event",
  "artifact",
  "source"
]);

export const TopicSourceKindSchema = z.enum([
  "event",
  "claim",
  "topic",
  "entity",
  "source",
  "source_chunk",
  "attachment",
  "tool_result",
  "unknown"
]);

export const TopicSourceReferenceSchema = z.object({
  id: IdSchema,
  type: TopicSourceKindSchema
});

export const TopicUpdatePolicySchema = z.enum(["automatic", "confirm"]);
export const TopicSlugSchema = z.string().min(1).max(200).regex(
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  "Topic slugs must be lowercase, URL-safe, and hyphen-separated."
);

export const TopicPageSchema = z.object({
  id: IdSchema,
  type: TopicTypeSchema,
  title: z.string().min(1).max(200),
  slug: TopicSlugSchema,
  summary: z.string(),
  currentState: z.string(),
  history: z.string(),
  openQuestions: z.array(z.string()),
  tags: z.array(z.string()),
  sourceIds: z.array(IdSchema),
  sourceReferences: z.array(TopicSourceReferenceSchema).optional(),
  revision: z.number().int().positive(),
  activeRevision: z.number().int().positive().optional(),
  revisionState: z.enum(["current", "superseded"]).optional(),
  userAuthored: z.boolean(),
  updatePolicy: TopicUpdatePolicySchema.optional(),
  updatedAt: TimestampSchema
});

export const ClaimStatusSchema = z.enum([
  "current",
  "superseded",
  "conflicted",
  "historical",
  "expired"
]);

export const ClaimSchema = z.object({
  id: IdSchema,
  topicId: IdSchema.nullable(),
  subject: z.string().min(1),
  predicate: z.string().min(1),
  value: z.string().min(1),
  confidence: z.number().min(0).max(1),
  status: ClaimStatusSchema,
  sourceRole: EventRoleSchema,
  sourceIds: z.array(IdSchema).min(1),
  validFrom: TimestampSchema.nullable(),
  validTo: TimestampSchema.nullable(),
  observedAt: TimestampSchema,
  freshnessExpiresAt: TimestampSchema.nullable()
});

export const GraphNodeSchema = z.object({
  id: IdSchema,
  type: z.enum(["topic", "entity", "claim", "source", "event", "artifact"]),
  label: z.string(),
  subtitle: z.string().optional(),
  status: z.string().optional(),
  weight: z.number().nonnegative().default(1)
});

export const GraphEdgeSchema = z.object({
  id: IdSchema,
  source: IdSchema,
  target: IdSchema,
  type: z.string().min(1),
  label: z.string().optional(),
  status: z.enum(["current", "historical", "conflicted"]).default("current"),
  evidenceIds: z.array(IdSchema).default([])
});

export const GraphResponseSchema = z.object({
  nodes: z.array(GraphNodeSchema),
  edges: z.array(GraphEdgeSchema),
  focusId: IdSchema.nullable(),
  truncated: z.boolean()
});

export const QualityPresetSchema = z.enum(["fast", "balanced", "deep"]);

export const CreateMessageRequestSchema = z.object({
  content: z.string().min(1).max(200_000),
  attachmentIds: z.array(IdSchema).max(20).default([]),
  quality: QualityPresetSchema.default("balanced"),
  idempotencyKey: z.string().min(8).max(200)
});

export const CreateMessageResponseSchema = z.object({
  event: ConversationEventSchema,
  runId: IdSchema
});

export const SearchResultSchema = z.object({
  id: IdSchema,
  type: z.enum(["event", "topic", "claim", "entity", "source", "attachment", "tool_result"]),
  title: z.string(),
  snippet: z.string(),
  score: z.number(),
  timestamp: TimestampSchema.nullable(),
  sourceEventId: IdSchema.nullable(),
  evidenceId: IdSchema.nullable().optional(),
  topicRevisionId: IdSchema.nullable().optional(),
  topicRevision: z.number().int().positive().nullable().optional(),
  tags: z.array(z.string()).default([])
});

export const SearchResponseSchema = z.object({
  results: z.array(SearchResultSchema),
  nextCursor: z.string().nullable(),
  tookMs: z.number().nonnegative()
});

export const RetrievalCandidateSchema = z.object({
  id: IdSchema,
  type: z.string(),
  title: z.string(),
  excerpt: z.string(),
  lexicalScore: z.number().nullable(),
  vectorScore: z.number().nullable(),
  graphScore: z.number().nullable(),
  temporalScore: z.number().nullable(),
  fusedScore: z.number(),
  rerankScore: z.number().nullable(),
  selected: z.boolean(),
  reason: z.string(),
  sourceIds: z.array(IdSchema)
});

export const RetrievalTraceSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  query: z.string(),
  classifications: z.array(z.string()),
  candidates: z.array(RetrievalCandidateSchema),
  selectedIds: z.array(IdSchema),
  tokenBudget: z.object({
    modelContext: z.number().int().positive(),
    reservedOutput: z.number().int().nonnegative(),
    instructions: z.number().int().nonnegative(),
    recentTurns: z.number().int().nonnegative(),
    evidence: z.number().int().nonnegative()
  }),
  latencyMs: z.number().nonnegative(),
  createdAt: TimestampSchema
});

export const RunStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run.started"), runId: IdSchema }),
  z.object({ type: z.literal("retrieval.started"), runId: IdSchema }),
  z.object({
    type: z.literal("retrieval.completed"),
    runId: IdSchema,
    traceId: IdSchema,
    selectedCount: z.number().int().nonnegative()
  }),
  z.object({
    type: z.literal("response.delta"),
    runId: IdSchema,
    eventId: IdSchema,
    delta: z.string()
  }),
  z.object({
    type: z.literal("tool.started"),
    runId: IdSchema,
    toolCallId: z.string(),
    name: z.string()
  }),
  z.object({
    type: z.literal("tool.completed"),
    runId: IdSchema,
    toolCallId: z.string(),
    name: z.string()
  }),
  z.object({
    type: z.literal("run.completed"),
    runId: IdSchema,
    event: ConversationEventSchema,
    usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), estimatedCostUsd: z.number() })
  }),
  z.object({ type: z.literal("run.cancelled"), runId: IdSchema }),
  z.object({
    type: z.literal("run.failed"),
    runId: IdSchema,
    code: z.string(),
    message: z.string()
  }),
  z.object({
    type: z.literal("memory.updated"),
    runId: IdSchema,
    topicIds: z.array(IdSchema)
  })
]);

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    traceId: z.string(),
    details: z.record(z.unknown()).optional()
  })
});

export type Attachment = z.infer<typeof AttachmentSchema>;
export type ConversationEvent = z.infer<typeof ConversationEventSchema>;
export type TopicPage = z.infer<typeof TopicPageSchema>;
export type TopicSourceReference = z.infer<typeof TopicSourceReferenceSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;
export type GraphResponse = z.infer<typeof GraphResponseSchema>;
export type QualityPreset = z.infer<typeof QualityPresetSchema>;
export type CreateMessageRequest = z.infer<typeof CreateMessageRequestSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
export type RetrievalTrace = z.infer<typeof RetrievalTraceSchema>;
export type RunStreamEvent = z.infer<typeof RunStreamEventSchema>;
