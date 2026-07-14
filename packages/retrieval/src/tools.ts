import { z } from "zod";

const IdSchema = z.string().uuid();
const CursorSchema = z.string().nullable().default(null);

export const MemoryToolSchemas = {
  search_memory: z.object({
    query: z.string().min(1).max(20_000),
    filters: z.record(z.unknown()).default({}),
    limit: z.number().int().min(1).max(100).default(10)
  }),
  open_event: z.object({
    event_id: IdSchema,
    cursor: CursorSchema,
    limit: z.number().int().min(1).max(100_000).default(10_000)
  }),
  open_source: z.object({
    source_id: IdSchema,
    location: z.string().nullable().default(null),
    limit: z.number().int().min(1).max(100_000).default(10_000)
  }),
  get_topic_page: z.object({
    topic_id: IdSchema,
    revision: z.number().int().positive().nullable().default(null)
  }),
  trace_claim: z.object({ claim_id: IdSchema }),
  search_timeline: z.object({
    date_range: z.object({ from: z.string().datetime().nullable(), to: z.string().datetime().nullable() }),
    roles: z.array(z.enum(["user", "assistant", "system", "tool"])).default([]),
    text: z.string().default(""),
    limit: z.number().int().min(1).max(100).default(20)
  })
} as const;

export type MemoryToolName = keyof typeof MemoryToolSchemas;
export type MemoryToolInput<K extends MemoryToolName> = z.infer<(typeof MemoryToolSchemas)[K]>;

export interface MemoryToolItem {
  id: string;
  type: string;
  content: string;
  sourceIds: string[];
  location: string | null;
  metadata: Record<string, unknown>;
}
export interface MemoryToolResult {
  items: MemoryToolItem[];
  nextCursor: string | null;
  exhausted: boolean;
  warning: string | null;
}

export type MemoryToolHandlers = {
  [K in MemoryToolName]: (input: MemoryToolInput<K>) => Promise<MemoryToolResult>;
};

export class MemoryToolRoundLimitError extends Error {
  constructor() {
    super("Memory lookup round limit reached; answer cautiously or request clarification");
    this.name = "MemoryToolRoundLimitError";
  }
}

export class MemoryToolRouter {
  private rounds = 0;

  constructor(
    private readonly handlers: MemoryToolHandlers,
    private readonly maxRounds = 3
  ) {}

  async call<K extends MemoryToolName>(
    name: K,
    untrustedInput: unknown
  ): Promise<MemoryToolResult> {
    if (this.rounds >= this.maxRounds) throw new MemoryToolRoundLimitError();
    this.rounds += 1;
    const input = MemoryToolSchemas[name].parse(untrustedInput) as MemoryToolInput<K>;
    const handler = this.handlers[name] as (
      value: MemoryToolInput<K>
    ) => Promise<MemoryToolResult>;
    return handler(input);
  }

  get roundsUsed(): number {
    return this.rounds;
  }

  get roundsRemaining(): number {
    return Math.max(0, this.maxRounds - this.rounds);
  }
}
