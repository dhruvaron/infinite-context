import type {
  BaselineContext,
  ControlledBaselineMode,
  EvaluationMessage,
  EvaluationProbe,
  EvaluationUsage
} from "./types.js";

export interface BaselineBuildInput {
  history: EvaluationMessage[];
  probe: EvaluationProbe;
  inputTokenBudget: number;
  /** Stable identity for one independent benchmark repetition. */
  runId?: string;
  /** Shared memory state for all probes in one dataset repetition. */
  stateId?: string;
}

export interface ControlledBaseline {
  readonly mode: ControlledBaselineMode;
  build(input: BaselineBuildInput): Promise<BaselineContext>;
}

export interface RollingSummaryProvider {
  summarize(
    messages: readonly EvaluationMessage[],
    maxTokens: number,
    previousSummary?: string
  ): Promise<string>;
  /** Returns and clears provider usage accumulated by the preceding build. */
  takeUsage?(): EvaluationUsage;
  /** Returns and clears wall time accumulated by the preceding build. */
  takeLatencyMs?(): number;
}

export interface EvaluationMemoryRetriever {
  retrieve(input: {
    query: string;
    history: readonly EvaluationMessage[];
    tokenBudget: number;
    mode: "flat_hybrid" | "continuum";
    runId?: string;
    stateId?: string;
  }): Promise<{ text: string; evidenceIds: string[]; tokenCount: number; metadata: Record<string, unknown> }>;
}

function fitRecent(
  history: readonly EvaluationMessage[],
  budget: number
): { messages: EvaluationMessage[]; tokens: number } {
  const selected: EvaluationMessage[] = [];
  let tokens = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    if (tokens + message.tokenCount > budget) break;
    selected.unshift(message);
    tokens += message.tokenCount;
  }
  return { messages: selected, tokens };
}

function renderMessages(messages: readonly EvaluationMessage[]): string {
  return messages.map((message) => `${message.role}: ${message.content}`).join("\n");
}

export class RecentWindowBaseline implements ControlledBaseline {
  readonly mode = "recent_window" as const;

  async build(input: BaselineBuildInput): Promise<BaselineContext> {
    const recent = fitRecent(input.history, input.inputTokenBudget);
    return {
      mode: this.mode,
      renderedContext: renderMessages(recent.messages),
      selectedMessageIds: recent.messages.map((message) => message.id),
      selectedEvidenceIds: recent.messages.map((message) => message.id),
      inputTokens: recent.tokens,
      metadata: { strategy: "newest verbatim messages" }
    };
  }
}

export class RollingSummaryBaseline implements ControlledBaseline {
  readonly mode = "rolling_summary" as const;
  #stateId: string | null = null;
  #summary = "";
  #summarized: EvaluationMessage[] = [];

  constructor(private readonly summarizer: RollingSummaryProvider) {}

  async build(input: BaselineBuildInput): Promise<BaselineContext> {
    // Discard any stale usage left by a previously interrupted build. A paid
    // failure is still charged by the budget guard, but cannot be attributed
    // to a successful run record.
    this.summarizer.takeUsage?.();
    this.summarizer.takeLatencyMs?.();
    const summaryBudget = Math.floor(input.inputTokenBudget * 0.25);
    const recent = fitRecent(input.history, input.inputTokenBudget - summaryBudget);
    const recentIds = new Set(recent.messages.map((message) => message.id));
    const older = input.history.filter((message) => !recentIds.has(message.id));
    const stateId = input.stateId ?? null;
    const compatible = stateId !== null && stateId === this.#stateId
      && this.#summarized.length <= older.length
      && this.#summarized.every((message, index) => older[index]?.id === message.id);
    if (!compatible) {
      this.#stateId = stateId;
      this.#summary = "";
      this.#summarized = [];
    }
    let summaryUpdates = 0;
    const additions = older.slice(this.#summarized.length);
    for (let index = 0; index < additions.length; index += 100) {
      this.#summary = await this.summarizer.summarize(
        additions.slice(index, index + 100),
        summaryBudget,
        this.#summary
      );
      summaryUpdates += 1;
    }
    this.#summarized = [...older];
    const summaryTokens = Math.min(summaryBudget, Math.ceil(this.#summary.length / 4));
    const preparationUsage = this.summarizer.takeUsage?.();
    const preparationLatencyMs = this.summarizer.takeLatencyMs?.();
    return {
      mode: this.mode,
      renderedContext: `${this.#summary ? `Rolling summary:\n${this.#summary}\n\n` : ""}${renderMessages(recent.messages)}`,
      selectedMessageIds: recent.messages.map((message) => message.id),
      selectedEvidenceIds: recent.messages.map((message) => message.id),
      inputTokens: recent.tokens + summaryTokens,
      metadata: {
        strategy: "recursive summary plus recent verbatim",
        summarizedMessages: older.length,
        newlySummarizedMessages: additions.length,
        summaryUpdates,
        ...(preparationUsage ? { preparationUsage } : {}),
        ...(preparationLatencyMs === undefined ? {} : { compilationMs: preparationLatencyMs })
      }
    };
  }
}

class MemoryBaseline implements ControlledBaseline {
  constructor(
    readonly mode: "flat_hybrid" | "continuum",
    private readonly retriever: EvaluationMemoryRetriever
  ) {}

  async build(input: BaselineBuildInput): Promise<BaselineContext> {
    const memoryBudget = Math.floor(input.inputTokenBudget * 0.45);
    const recent = fitRecent(input.history, input.inputTokenBudget - memoryBudget);
    const retrieval = await this.retriever.retrieve({
      query: input.probe.question,
      history: input.history,
      tokenBudget: memoryBudget,
      mode: this.mode,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.stateId ? { stateId: input.stateId } : {})
    });
    if (retrieval.tokenCount > memoryBudget) {
      throw new Error(`${this.mode} retriever exceeded its controlled token budget`);
    }
    return {
      mode: this.mode,
      renderedContext: `Retrieved evidence:\n${retrieval.text}\n\nRecent turns:\n${renderMessages(recent.messages)}`,
      selectedMessageIds: recent.messages.map((message) => message.id),
      selectedEvidenceIds: retrieval.evidenceIds,
      inputTokens: recent.tokens + retrieval.tokenCount,
      metadata: retrieval.metadata
    };
  }
}

export function createControlledBaselines(input: {
  summarizer: RollingSummaryProvider;
  retriever: EvaluationMemoryRetriever;
}): ControlledBaseline[] {
  return [
    new RecentWindowBaseline(),
    new RollingSummaryBaseline(input.summarizer),
    new MemoryBaseline("flat_hybrid", input.retriever),
    new MemoryBaseline("continuum", input.retriever)
  ];
}

/** No-cost deterministic summary fixture; not intended as the final learned baseline. */
export class DeterministicSummaryFixture implements RollingSummaryProvider {
  async summarize(
    messages: readonly EvaluationMessage[],
    maxTokens: number,
    previousSummary = ""
  ): Promise<string> {
    const limit = maxTokens * 4;
    return [
      previousSummary,
      ...messages
        .filter((message) => /\b(remember|decid|correction|preference|current|record)\b/i.test(message.content))
        .map((message) => `${message.role}: ${message.content}`)
    ]
      .filter(Boolean)
      .join("\n")
      .slice(-limit);
  }
}
