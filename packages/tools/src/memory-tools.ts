import { IdSchema, TimestampSchema } from "@continuum/contracts";
import { z } from "zod";
import { createToolEvidence, ToolError, ToolEvidenceSchema, type ToolEvidence, type ToolExecutionContext, type TypedTool } from "./core.js";

const LimitSchema = z.number().int().min(1).max(100).default(20);
const CursorSchema = z.string().min(1).max(1_024).optional();

export const MemoryFiltersSchema = z.object({
  types: z.array(z.enum(["event", "source", "topic", "claim", "entity", "attachment", "tool_result"])).max(10).optional(),
  roles: z.array(z.enum(["user", "assistant", "system", "tool"])).max(4).optional(),
  tags: z.array(z.string().min(1).max(100)).max(20).optional(),
  statuses: z.array(z.enum(["current", "superseded", "conflicted", "historical", "expired"])).max(5).optional(),
  from: TimestampSchema.optional(),
  to: TimestampSchema.optional(),
  scopeId: IdSchema.optional()
});

export const MemoryHitSchema = z.object({
  id: IdSchema,
  type: z.enum(["event", "source", "topic", "claim", "entity", "attachment", "tool_result"]),
  title: z.string().max(1_000),
  excerpt: z.string().max(100_000),
  score: z.number(),
  sourceIds: z.array(IdSchema).min(1).max(100),
  location: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  observedAt: TimestampSchema.optional(),
  status: z.string().optional()
});

export const MemoryPageSchema = z.object({
  items: z.array(MemoryHitSchema).max(100),
  nextCursor: z.string().nullable(),
  totalKnown: z.number().int().nonnegative().optional()
});

export type MemoryFilters = z.infer<typeof MemoryFiltersSchema>;
export type MemoryHit = z.infer<typeof MemoryHitSchema>;
export type MemoryPage = z.infer<typeof MemoryPageSchema>;

export const SearchMemoryInputSchema = z.object({
  query: z.string().min(1).max(20_000),
  filters: MemoryFiltersSchema.default({}),
  limit: LimitSchema,
  cursor: CursorSchema
});
export const OpenEventInputSchema = z.object({ eventId: IdSchema, cursor: CursorSchema, limit: z.number().int().min(1).max(50).default(50) });
export const OpenSourceInputSchema = z.object({
  sourceId: IdSchema,
  location: z.object({ page: z.number().int().positive().optional(), line: z.number().int().positive().optional(), row: z.number().int().positive().optional() }).optional(),
  cursor: CursorSchema,
  limit: z.number().int().min(1).max(200).default(50)
});
export const GetTopicPageInputSchema = z.object({ topicId: IdSchema, revision: z.number().int().positive().optional() });
export const TraceClaimInputSchema = z.object({ claimId: IdSchema });
export const SearchTimelineInputSchema = z.object({
  dateRange: z.object({ from: TimestampSchema.optional(), to: TimestampSchema.optional() }).refine((value) => !value.from || !value.to || value.from <= value.to, "from must not be after to"),
  roles: z.array(z.enum(["user", "assistant", "system", "tool"])).max(4).default([]),
  text: z.string().max(20_000).default(""),
  limit: LimitSchema,
  cursor: CursorSchema
});

export interface MemoryToolRepository {
  searchMemory(input: z.infer<typeof SearchMemoryInputSchema>, signal?: AbortSignal): Promise<MemoryPage>;
  openEvent(input: z.infer<typeof OpenEventInputSchema>, signal?: AbortSignal): Promise<MemoryPage>;
  openSource(input: z.infer<typeof OpenSourceInputSchema>, signal?: AbortSignal): Promise<MemoryPage>;
  getTopicPage(input: z.infer<typeof GetTopicPageInputSchema>, signal?: AbortSignal): Promise<MemoryPage>;
  traceClaim(input: z.infer<typeof TraceClaimInputSchema>, signal?: AbortSignal): Promise<MemoryPage>;
  searchTimeline(input: z.infer<typeof SearchTimelineInputSchema>, signal?: AbortSignal): Promise<MemoryPage>;
}

type MemoryToolName =
  | "search_memory"
  | "open_event"
  | "open_source"
  | "get_topic_page"
  | "trace_claim"
  | "search_timeline";

const DESCRIPTIONS: Record<MemoryToolName, string> = {
  search_memory: "Search source-linked long-term memory.",
  open_event: "Open exact raw conversation evidence by stable event ID.",
  open_source: "Open exact source chunks near a cited location.",
  get_topic_page: "Read a compiled topic page revision.",
  trace_claim: "Trace a claim through exact supporting and contradicting evidence.",
  search_timeline: "Search chronologically ordered raw evidence."
};

export class MemoryToolSession {
  readonly #repository: MemoryToolRepository;
  readonly #maximumRounds: number;
  #rounds = 0;

  constructor(repository: MemoryToolRepository, maximumRounds = 3) {
    if (!Number.isInteger(maximumRounds) || maximumRounds < 1 || maximumRounds > 10) {
      throw new ToolError("INVALID_ARGUMENT", "Memory tool round budget is invalid.");
    }
    this.#repository = repository;
    this.#maximumRounds = maximumRounds;
  }

  get remainingRounds(): number {
    return this.#maximumRounds - this.#rounds;
  }

  tools(): readonly TypedTool<unknown, ToolEvidence>[] {
    return [
      this.#tool("search_memory", SearchMemoryInputSchema, (input, signal) => this.#repository.searchMemory(input, signal)),
      this.#tool("open_event", OpenEventInputSchema, (input, signal) => this.#repository.openEvent(input, signal)),
      this.#tool("open_source", OpenSourceInputSchema, (input, signal) => this.#repository.openSource(input, signal)),
      this.#tool("get_topic_page", GetTopicPageInputSchema, (input, signal) => this.#repository.getTopicPage(input, signal)),
      this.#tool("trace_claim", TraceClaimInputSchema, (input, signal) => this.#repository.traceClaim(input, signal)),
      this.#tool("search_timeline", SearchTimelineInputSchema, (input, signal) => this.#repository.searchTimeline(input, signal))
    ];
  }

  #tool<S extends z.ZodTypeAny>(
    name: MemoryToolName,
    schema: S,
    invoke: (input: z.output<S>, signal?: AbortSignal) => Promise<MemoryPage>
  ): TypedTool<unknown, ToolEvidence> {
    return {
      name,
      description: DESCRIPTIONS[name],
      inputSchema: schema as z.ZodType<unknown>,
      outputSchema: ToolEvidenceSchema,
      execute: async (raw: unknown, context: ToolExecutionContext): Promise<ToolEvidence> => {
        if (this.#rounds >= this.#maximumRounds) {
          throw new ToolError("LIMIT_EXCEEDED", "Memory lookup budget exhausted; answer cautiously or ask for clarification.");
        }
        const input = schema.parse(raw) as z.output<S>;
        this.#rounds += 1;
        const page = MemoryPageSchema.parse(await invoke(input, context.signal));
        return createToolEvidence({
          content: JSON.stringify(page.items),
          provenance: page.items.flatMap((item) => item.sourceIds.map((sourceId) => ({ sourceId, sourceType: item.type === "attachment" ? "source" as const : item.type }))),
          truncated: page.nextCursor !== null,
          nextCursor: page.nextCursor,
          metadata: { tool: name, resultCount: page.items.length, remainingRounds: this.remainingRounds }
        });
      }
    };
  }
}
