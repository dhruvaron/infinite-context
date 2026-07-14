import { randomUUID } from "node:crypto";

import type { ControlledBaseline } from "./baselines.js";
import type { BudgetCategory } from "./budget.js";
import { scoreAnswer } from "./metrics.js";
import type {
  BaselineContext,
  ControlledModelSettings,
  EvaluationDataset,
  EvaluationLatency,
  EvaluationProbe,
  EvaluationRunRecord,
  EvaluationUsage
} from "./types.js";

export interface EvaluationAnswerRequest {
  query: string;
  context: string;
  settings: ControlledModelSettings;
  expectedEvidenceIds: string[];
}

export interface EvaluationAnswerResult {
  answer: string;
  usage: EvaluationUsage;
  latency: EvaluationLatency;
  unsupportedMemory: boolean;
  contradictedEvidence: boolean;
}

export interface EvaluationAnswerProvider {
  estimateCost(request: EvaluationAnswerRequest): number;
  answer(request: EvaluationAnswerRequest): Promise<EvaluationAnswerResult>;
}

export interface EvaluationBudgetController {
  reserve(input: {
    callId: string;
    category: BudgetCategory;
    estimatedCostUsd: number;
    essential: boolean;
    createdAt?: string;
  }): unknown;
  commit(callId: string, actualCostUsd: number): unknown;
  release(callId: string): void;
}

export interface SemanticJudge {
  estimateCost?(input: SemanticJudgeInput): number;
  score(input: SemanticJudgeInput): Promise<number | SemanticJudgeResult>;
}

export interface SemanticJudgeInput {
  question: string;
  answer: string;
  acceptableAnswers: string[];
  hiddenEvidenceIds: string[];
  selectedEvidenceIds: string[];
  renderedContext: string;
}

export interface SemanticJudgeResult {
  score: number;
  usage: EvaluationUsage;
  unsupportedMemory?: boolean;
  contradictedEvidence?: boolean;
  rationale?: string;
  judgeModel?: string;
}

export interface EvaluationRunOptions {
  settings: ControlledModelSettings;
  repetitions?: number;
  checkpoint?: number;
  judge?: SemanticJudge | null;
  now?: () => string;
  runId?: (input: {
    datasetId: string;
    probeId: string;
    mode: ControlledBaseline["mode"];
    repetition: number;
  }) => string;
}

function preparationUsage(metadata: Record<string, unknown>): EvaluationUsage | null {
  const value = metadata.preparationUsage;
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Baseline preparation usage must be an object");
  }
  const record = value as Record<keyof EvaluationUsage, unknown>;
  const keys: Array<keyof EvaluationUsage> = [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "extractionTokens",
    "embeddingTokens",
    "rerankingTokens",
    "estimatedCostUsd"
  ];
  for (const key of keys) {
    if (typeof record[key] !== "number" || !Number.isFinite(record[key]) || record[key] < 0) {
      throw new Error(`Baseline preparation usage ${key} must be finite and non-negative`);
    }
  }
  return record as EvaluationUsage;
}

function combineUsage(...values: Array<EvaluationUsage | null>): EvaluationUsage {
  const present = values.filter((value): value is EvaluationUsage => value !== null);
  return {
    inputTokens: present.reduce((sum, value) => sum + value.inputTokens, 0),
    cachedInputTokens: present.reduce((sum, value) => sum + value.cachedInputTokens, 0),
    outputTokens: present.reduce((sum, value) => sum + value.outputTokens, 0),
    extractionTokens: present.reduce((sum, value) => sum + value.extractionTokens, 0),
    embeddingTokens: present.reduce((sum, value) => sum + value.embeddingTokens, 0),
    rerankingTokens: present.reduce((sum, value) => sum + value.rerankingTokens, 0),
    estimatedCostUsd: present.reduce((sum, value) => sum + value.estimatedCostUsd, 0)
  };
}

function finiteMetadataNumber(metadata: Record<string, unknown>, key: string): number {
  const value = metadata[key];
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Baseline metadata ${key} must be finite and non-negative`);
  }
  return value;
}

/**
 * Scores one already-built context with the exact same answer, judge, usage,
 * latency, and failure accounting used by the controlled baseline runner.
 * Production ablations use this primitive so feature removal cannot silently
 * drift onto a different evaluator implementation.
 */
export async function evaluatePreparedContext(input: {
  datasetId: string;
  probe: EvaluationProbe;
  repetition: number;
  mode: ControlledBaseline["mode"];
  runId: string;
  history: readonly EvaluationDataset["messages"][number][];
  context: BaselineContext;
  provider: EvaluationAnswerProvider;
  budget: EvaluationBudgetController;
  settings: ControlledModelSettings;
  judge?: SemanticJudge | null;
  now?: () => string;
}): Promise<EvaluationRunRecord> {
  const now = input.now ?? (() => new Date().toISOString());
  const { context, probe } = input;
  if (context.inputTokens > input.settings.totalInputTokens) {
    throw new Error(`${input.mode} exceeded the controlled total input budget`);
  }
  const contextMetadata: Record<string, unknown> = {
    ...context.metadata,
    contextInputTokens: context.inputTokens,
    fullReplayInputTokens: input.history.reduce((sum, message) => sum + message.tokenCount, 0)
  };
  const request: EvaluationAnswerRequest = {
    query: probe.question,
    context: context.renderedContext,
    settings: input.settings,
    expectedEvidenceIds: probe.expectedEvidenceIds
  };
  const estimate = input.provider.estimateCost(request);
  input.budget.reserve({
    callId: input.runId,
    category: "final_evaluation",
    estimatedCostUsd: estimate,
    essential: true,
    createdAt: now()
  });
  try {
    const response = await input.provider.answer(request);
    // Token usage is not an authoritative provider debit. Preserve the full
    // pre-call pricing margin so controlled and ablation calls cannot reclaim
    // uncertain credit from the shared hard-cap fence.
    input.budget.commit(input.runId, Math.max(response.usage.estimatedCostUsd, estimate));
    const accuracy = scoreAnswer(response.answer, probe.acceptableAnswers);
    let semanticAccuracy: number | null = null;
    let judgeUsage: EvaluationUsage | null = null;
    let judgeMetadata: EvaluationRunRecord["judgeMetadata"] = null;
    if (!probe.deterministic && input.judge) {
      const judgeInput: SemanticJudgeInput = {
        question: probe.question,
        answer: response.answer,
        acceptableAnswers: probe.acceptableAnswers,
        hiddenEvidenceIds: probe.expectedEvidenceIds,
        selectedEvidenceIds: context.selectedEvidenceIds,
        renderedContext: context.renderedContext
      };
      const judgeCallId = `${input.runId}:judge`;
      const judgeEstimate = input.judge.estimateCost?.(judgeInput) ?? 0;
      input.budget.reserve({
        callId: judgeCallId,
        category: "final_evaluation",
        estimatedCostUsd: judgeEstimate,
        essential: true,
        createdAt: now()
      });
      try {
        const judged = await input.judge.score(judgeInput);
        if (typeof judged === "number") {
          semanticAccuracy = judged;
          input.budget.commit(judgeCallId, judgeEstimate);
        } else {
          semanticAccuracy = judged.score;
          judgeUsage = judged.usage;
          if (judged.unsupportedMemory !== undefined) response.unsupportedMemory = judged.unsupportedMemory;
          if (judged.contradictedEvidence !== undefined) response.contradictedEvidence = judged.contradictedEvidence;
          judgeMetadata = { model: judged.judgeModel ?? null, rationale: judged.rationale ?? null };
          input.budget.commit(judgeCallId, Math.max(judged.usage.estimatedCostUsd, judgeEstimate));
        }
      } catch (error) {
        input.budget.release(judgeCallId);
        throw error;
      }
    }
    const combinedUsage = combineUsage(response.usage, preparationUsage(contextMetadata));
    const interactivePreparationLatencyMs = finiteMetadataNumber(contextMetadata, "interactivePreparationLatencyMs");
    const retrievalMs = finiteMetadataNumber(contextMetadata, "retrievalMs");
    const rerankingMs = finiteMetadataNumber(contextMetadata, "rerankingMs");
    const compilationMs = finiteMetadataNumber(contextMetadata, "compilationMs");
    const temporalCorrect = probe.expectedCurrentValue === null
      ? null
      : response.answer.toLocaleLowerCase().includes(probe.expectedCurrentValue.toLocaleLowerCase());
    return {
      runId: input.runId,
      datasetId: input.datasetId,
      probeId: probe.id,
      checkpoint: probe.checkpoint,
      repetition: input.repetition,
      mode: input.mode,
      settings: input.settings,
      answer: response.answer,
      expectedAnswers: probe.acceptableAnswers,
      selectedEvidenceIds: context.selectedEvidenceIds,
      expectedEvidenceIds: probe.expectedEvidenceIds,
      exactAccuracy: accuracy.exact,
      fuzzyAccuracy: accuracy.fuzzy,
      semanticAccuracy,
      temporalCorrect,
      unsupportedMemory: response.unsupportedMemory,
      contradictedEvidence: response.contradictedEvidence,
      usage: combinedUsage,
      ...(judgeUsage ? { evaluationOverheadUsage: judgeUsage } : {}),
      latency: {
        firstTokenMs: response.latency.firstTokenMs + interactivePreparationLatencyMs,
        totalResponseMs: response.latency.totalResponseMs + interactivePreparationLatencyMs,
        retrievalMs: response.latency.retrievalMs + retrievalMs,
        rerankingMs: response.latency.rerankingMs + rerankingMs,
        compilationMs: response.latency.compilationMs + compilationMs
      },
      contextMetadata,
      judgeMetadata,
      error: null,
      createdAt: now()
    };
  } catch (error) {
    input.budget.release(input.runId);
    return {
      runId: input.runId,
      datasetId: input.datasetId,
      probeId: probe.id,
      checkpoint: probe.checkpoint,
      repetition: input.repetition,
      mode: input.mode,
      settings: input.settings,
      answer: "",
      expectedAnswers: probe.acceptableAnswers,
      selectedEvidenceIds: context.selectedEvidenceIds,
      expectedEvidenceIds: probe.expectedEvidenceIds,
      exactAccuracy: 0,
      fuzzyAccuracy: 0,
      semanticAccuracy: null,
      temporalCorrect: null,
      unsupportedMemory: false,
      contradictedEvidence: false,
      usage: {
        inputTokens: context.inputTokens,
        cachedInputTokens: 0,
        outputTokens: 0,
        extractionTokens: 0,
        embeddingTokens: 0,
        rerankingTokens: 0,
        estimatedCostUsd: 0
      },
      latency: { firstTokenMs: 0, totalResponseMs: 0, retrievalMs: 0, rerankingMs: 0, compilationMs: 0 },
      contextMetadata,
      judgeMetadata: null,
      error: error instanceof Error ? error.message : String(error),
      createdAt: now()
    };
  }
}

export async function runControlledEvaluation(input: {
  dataset: EvaluationDataset;
  baselines: ControlledBaseline[];
  provider: EvaluationAnswerProvider;
  budget: EvaluationBudgetController;
  options: EvaluationRunOptions;
}): Promise<EvaluationRunRecord[]> {
  const repetitions = input.options.repetitions ?? 3;
  const now = input.options.now ?? (() => new Date().toISOString());
  const probes = input.dataset.probes.filter(
    (probe) => input.options.checkpoint === undefined || probe.checkpoint === input.options.checkpoint
  ).sort((left, right) => left.checkpoint - right.checkpoint || left.id.localeCompare(right.id));
  const records: EvaluationRunRecord[] = [];
  for (const baseline of input.baselines) {
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      const stateId = `${input.dataset.id}:${baseline.mode}:repetition-${repetition}`;
      for (const probe of probes) {
        const history = input.dataset.messages.slice(0, probe.checkpoint);
        const runId = input.options.runId?.({
          datasetId: input.dataset.id,
          probeId: probe.id,
          mode: baseline.mode,
          repetition
        }) ?? randomUUID();
        const context = await baseline.build({
          history,
          probe,
          inputTokenBudget: input.options.settings.totalInputTokens,
          runId,
          stateId
        });
        records.push(await evaluatePreparedContext({
          datasetId: input.dataset.id,
          probe,
          repetition,
          mode: baseline.mode,
          runId,
          history,
          context,
          provider: input.provider,
          budget: input.budget,
          settings: input.options.settings,
          ...(input.options.judge === undefined ? {} : { judge: input.options.judge }),
          now
        }));
      }
    }
  }
  return records;
}
