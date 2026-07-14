import { createHash, randomUUID } from "node:crypto";

import { estimateCostUsd, stableHash } from "@continuum/config";

import {
  createControlledBaselines,
  type RollingSummaryProvider
} from "./baselines.js";
import { DurableEvaluationBudgetGuard } from "./durable-budget.js";
import {
  EVALUATION_RESERVATION_SAFETY_MULTIPLIER,
  assertPinnedEvaluationModel,
  estimateLiveEvaluationReservation
} from "./live-evaluation.js";
import { aggregateRuns, relativeImprovement } from "./metrics.js";
import { generateInfiniteBuild } from "./infinite-build.js";
import {
  evaluatePreparedContext,
  runControlledEvaluation,
  type EvaluationAnswerProvider,
  type EvaluationAnswerRequest,
  type EvaluationAnswerResult,
  type EvaluationBudgetController,
  type SemanticJudge
} from "./runner.js";
import type {
  AggregateMetrics,
  BaselineContext,
  ControlledBaselineMode,
  ControlledModelSettings,
  EvaluationDataset,
  EvaluationMessage,
  EvaluationRunRecord,
  EvaluationUsage
} from "./types.js";
import {
  PRODUCTION_CAUSAL_ABLATIONS,
  productionCausalFeatureFlags,
  type ProductionCausalAblation,
  type ProductionCausalRetriever
} from "./causal-runtime.js";

const ALL_MODES: ControlledBaselineMode[] = ["recent_window", "rolling_summary", "flat_hybrid", "continuum"];
const MANUAL_AUDIT_SEED = "continuum-causal-manual-audit-v2";

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function zeroUsage(inputTokens = 0, outputTokens = 0): EvaluationUsage {
  return {
    inputTokens,
    cachedInputTokens: 0,
    outputTokens,
    extractionTokens: 0,
    embeddingTokens: 0,
    rerankingTokens: 0,
    estimatedCostUsd: 0
  };
}

function olderMessagesForSummary(history: readonly EvaluationMessage[], totalInputTokens: number): EvaluationMessage[] {
  const summaryBudget = Math.floor(totalInputTokens * 0.25);
  const recentBudget = totalInputTokens - summaryBudget;
  let recentTokens = 0;
  let firstRecent = history.length;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    if (recentTokens + message.tokenCount > recentBudget) break;
    recentTokens += message.tokenCount;
    firstRecent = index;
  }
  return history.slice(0, firstRecent);
}

function summaryPlanCost(input: {
  datasets: readonly EvaluationDataset[];
  repetitions: number;
  settings: ControlledModelSettings;
  model: string;
}): { calls: number; maximumUsd: number } {
  assertPinnedEvaluationModel(input.model);
  const summaryBudget = Math.floor(input.settings.totalInputTokens * 0.25);
  let calls = 0;
  let maximumUsd = 0;
  for (const dataset of input.datasets) {
    let priorOlder: EvaluationMessage[] = [];
    const probes = [...dataset.probes].sort((left, right) => left.checkpoint - right.checkpoint || left.id.localeCompare(right.id));
    for (const probe of probes) {
      const older = olderMessagesForSummary(dataset.messages.slice(0, probe.checkpoint), input.settings.totalInputTokens);
      const compatible = priorOlder.length <= older.length
        && priorOlder.every((message, index) => older[index]?.id === message.id);
      const additions = compatible ? older.slice(priorOlder.length) : older;
      for (let offset = 0; offset < additions.length; offset += 100) {
        const chunk = additions.slice(offset, offset + 100);
        const maximumInput = 1_000 + summaryBudget + chunk.reduce((sum, message) => sum + message.tokenCount + 8, 0);
        maximumUsd += Math.max(
          0.001,
          estimateCostUsd(input.model, maximumInput, summaryBudget) * EVALUATION_RESERVATION_SAFETY_MULTIPLIER
        ) * input.repetitions;
        calls += input.repetitions;
      }
      priorOlder = [...older];
    }
  }
  return { calls, maximumUsd };
}

export interface CausalBenchmarkPlan {
  schemaVersion: 2;
  paidExecution: boolean;
  datasets: number;
  messages: number;
  probes: number;
  modes: ControlledBaselineMode[];
  repetitions: number;
  ablationConfigurations: ProductionCausalAblation[];
  controlledAnswerCalls: number;
  ablationAnswerCalls: number;
  answerCalls: number;
  learnedSummaryCalls: number;
  independentJudgeCalls: number;
  answerModel: string;
  summaryModel: string;
  judgeModel: string;
  answerMaximumUsd: number;
  summaryMaximumUsd: number;
  judgeMaximumUsd: number;
  externalMaximumUsd: number;
  productionWorkerMaximumUsd: number;
  combinedMaximumUsd: number;
  pricingSafetyMultiplier: number;
}

export function buildCausalBenchmarkPlan(input: {
  datasets: readonly EvaluationDataset[];
  modes?: readonly ControlledBaselineMode[];
  repetitions: number;
  settings: ControlledModelSettings;
  summaryModel: string;
  judgeModel: string;
  workerMaximumUsd: number;
  paidExecution: boolean;
}): CausalBenchmarkPlan {
  if (input.datasets.length === 0) throw new Error("Causal benchmark requires at least one dataset");
  const modes = [...new Set(input.modes ?? ALL_MODES)];
  if (modes.some((mode) => !ALL_MODES.includes(mode))) throw new Error("Causal benchmark mode set is invalid");
  if (!Number.isInteger(input.repetitions) || input.repetitions < 1) throw new Error("Causal benchmark repetitions must be positive");
  if (!Number.isFinite(input.workerMaximumUsd) || input.workerMaximumUsd < 0) throw new Error("Worker maximum must be finite and non-negative");
  assertPinnedEvaluationModel(input.settings.model);
  assertPinnedEvaluationModel(input.summaryModel);
  assertPinnedEvaluationModel(input.judgeModel);
  const probes = input.datasets.reduce((sum, dataset) => sum + dataset.probes.length, 0);
  const messages = input.datasets.reduce((sum, dataset) => sum + dataset.messages.length, 0);
  if (!Number.isSafeInteger(probes) || probes < 1 || !Number.isSafeInteger(messages) || messages < 1) {
    throw new Error("Causal benchmark dataset size is invalid or unsafe");
  }
  const controlledAnswerCalls = probes * modes.length * input.repetitions;
  const ablationAnswerCalls = probes * PRODUCTION_CAUSAL_ABLATIONS.length * input.repetitions;
  const answerCalls = controlledAnswerCalls + ablationAnswerCalls;
  if (![controlledAnswerCalls, ablationAnswerCalls, answerCalls].every(Number.isSafeInteger)) {
    throw new Error("Causal benchmark call count exceeds safe integer limits");
  }
  const answerMaximumUsd = input.paidExecution
    ? answerCalls * estimateLiveEvaluationReservation(input.settings)
    : 0;
  const summary = modes.includes("rolling_summary") && input.paidExecution
    ? summaryPlanCost({ datasets: input.datasets, repetitions: input.repetitions, settings: input.settings, model: input.summaryModel })
    : { calls: 0, maximumUsd: 0 };
  const nondeterministicProbes = input.datasets.reduce(
    (sum, dataset) => sum + dataset.probes.filter((probe) => !probe.deterministic).length,
    0
  );
  const independentJudgeCalls = input.paidExecution
    ? nondeterministicProbes * (modes.length + PRODUCTION_CAUSAL_ABLATIONS.length) * input.repetitions
    : 0;
  const judgePerCall = input.paidExecution
    ? Math.max(
        0.001,
        estimateCostUsd(
          input.judgeModel,
          input.settings.totalInputTokens + input.settings.outputTokens + 4_000,
          600
        ) * EVALUATION_RESERVATION_SAFETY_MULTIPLIER
      )
    : 0;
  const judgeMaximumUsd = independentJudgeCalls * judgePerCall;
  const externalMaximumUsd = answerMaximumUsd + summary.maximumUsd + judgeMaximumUsd;
  const productionWorkerMaximumUsd = input.paidExecution ? input.workerMaximumUsd : 0;
  const combinedMaximumUsd = externalMaximumUsd + productionWorkerMaximumUsd;
  if (![answerMaximumUsd, summary.maximumUsd, judgeMaximumUsd, externalMaximumUsd, productionWorkerMaximumUsd, combinedMaximumUsd]
    .every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error("Causal benchmark reservation estimate is invalid");
  }
  return {
    schemaVersion: 2,
    paidExecution: input.paidExecution,
    datasets: input.datasets.length,
    messages,
    probes,
    modes,
    repetitions: input.repetitions,
    ablationConfigurations: [...PRODUCTION_CAUSAL_ABLATIONS],
    controlledAnswerCalls,
    ablationAnswerCalls,
    answerCalls,
    learnedSummaryCalls: summary.calls,
    independentJudgeCalls,
    answerModel: input.settings.model,
    summaryModel: input.summaryModel,
    judgeModel: input.judgeModel,
    answerMaximumUsd,
    summaryMaximumUsd: summary.maximumUsd,
    judgeMaximumUsd,
    externalMaximumUsd,
    productionWorkerMaximumUsd,
    combinedMaximumUsd,
    pricingSafetyMultiplier: EVALUATION_RESERVATION_SAFETY_MULTIPLIER
  };
}

interface InternalCall {
  callId: string;
  estimatedCostUsd: number;
  chargedCostUsd: number;
  status: "reserved" | "committed" | "uncertain";
}

class PlanFenceController implements EvaluationBudgetController {
  readonly #ceilingUsd: number;
  readonly #calls = new Map<string, InternalCall>();
  readonly #onOverrun: (chargedUsd: number) => void;

  constructor(ceilingUsd: number, onOverrun: (chargedUsd: number) => void) {
    this.#ceilingUsd = ceilingUsd;
    this.#onOverrun = onOverrun;
  }

  reserve(input: { callId: string; estimatedCostUsd: number }): void {
    if (this.#calls.has(input.callId)) throw new Error(`Duplicate causal budget call ID: ${input.callId}`);
    if (!Number.isFinite(input.estimatedCostUsd) || input.estimatedCostUsd < 0) throw new Error("Causal call estimate is invalid");
    const projected = [...this.#calls.values()].reduce((sum, call) => sum + call.chargedCostUsd, 0) + input.estimatedCostUsd;
    if (projected > this.#ceilingUsd + 1e-9) throw new Error("A causal API call exceeds the atomically reserved external-plan fence");
    this.#calls.set(input.callId, {
      callId: input.callId,
      estimatedCostUsd: input.estimatedCostUsd,
      chargedCostUsd: input.estimatedCostUsd,
      status: "reserved"
    });
  }

  commit(callId: string, actualCostUsd: number): void {
    if (!Number.isFinite(actualCostUsd) || actualCostUsd < 0) throw new Error("Causal call cost is invalid");
    const call = this.#calls.get(callId);
    if (!call || call.status !== "reserved") throw new Error(`No active causal call reservation: ${callId}`);
    call.chargedCostUsd = Math.max(call.estimatedCostUsd, actualCostUsd);
    call.status = "committed";
    if (this.chargedUsd > this.#ceilingUsd + 1e-9) {
      this.#onOverrun(this.chargedUsd);
      throw new Error("Causal calls exceeded the atomically reserved external-plan fence");
    }
  }

  release(callId: string): void {
    const call = this.#calls.get(callId);
    if (!call || call.status !== "reserved") return;
    call.status = "uncertain";
    call.chargedCostUsd = call.estimatedCostUsd;
  }

  get chargedUsd(): number { return [...this.#calls.values()].reduce((sum, call) => sum + call.chargedCostUsd, 0); }
  get calls(): InternalCall[] { return [...this.#calls.values()].map((call) => ({ ...call })); }
}

export class SharedCausalBudgetPlan {
  readonly external: EvaluationBudgetController;
  readonly initialAllocatedUsd: number;
  readonly #durable: DurableEvaluationBudgetGuard;
  readonly #externalController: PlanFenceController;
  readonly #planFenceId: string | null;
  readonly #externalCeilingUsd: number;
  readonly #workerCeilingUsd: number;
  readonly #combinedCeilingUsd: number;
  #settled = false;

  constructor(input: {
    durable: DurableEvaluationBudgetGuard;
    externalCeilingUsd: number;
    workerCeilingUsd: number;
    executionId?: string;
  }) {
    if (!Number.isFinite(input.externalCeilingUsd) || input.externalCeilingUsd < 0
      || !Number.isFinite(input.workerCeilingUsd) || input.workerCeilingUsd < 0) {
      throw new Error("Causal plan ceilings must be finite and non-negative");
    }
    this.#durable = input.durable;
    this.#externalCeilingUsd = input.externalCeilingUsd;
    this.#workerCeilingUsd = input.workerCeilingUsd;
    this.#combinedCeilingUsd = input.externalCeilingUsd + input.workerCeilingUsd;
    const before = input.durable.snapshot();
    this.initialAllocatedUsd = before.committedUsd + before.reservedUsd;
    input.durable.assertCanReserveTotal({
      category: "final_evaluation",
      estimatedCostUsd: this.#combinedCeilingUsd,
      essential: true
    });
    const executionId = input.executionId ?? randomUUID();
    this.#planFenceId = this.#combinedCeilingUsd > 0 ? `${executionId}:causal-plan` : null;
    if (this.#planFenceId) {
      input.durable.reserve({
        callId: this.#planFenceId,
        category: "final_evaluation",
        estimatedCostUsd: this.#combinedCeilingUsd,
        essential: true
      });
    }
    this.#externalController = new PlanFenceController(input.externalCeilingUsd, (chargedUsd) => {
      this.#settleOverrun(chargedUsd + this.#workerCeilingUsd);
    });
    this.external = this.#externalController;
  }

  #settleOverrun(actualOrConservativeUsd: number): void {
    if (this.#settled) return;
    this.#settled = true;
    if (this.#planFenceId) {
      this.#durable.commit(this.#planFenceId, Math.max(this.#combinedCeilingUsd, actualOrConservativeUsd));
    }
  }

  finalize(workerActualUsd: number): { externalChargedUsd: number; workerActualUsd: number; durableChargedUsd: number; calls: InternalCall[] } {
    if (this.#settled) throw new Error("Causal budget plan was already settled");
    if (!Number.isFinite(workerActualUsd) || workerActualUsd < 0) {
      throw new Error("Production worker spend is outside its shared-plan fence");
    }
    if (workerActualUsd > this.#workerCeilingUsd + 1e-9) {
      this.#settleOverrun(this.#externalController.chargedUsd + workerActualUsd);
      throw new Error("Production worker spend is outside its shared-plan fence");
    }
    if (this.#externalController.chargedUsd > this.#externalCeilingUsd + 1e-9) {
      throw new Error("External causal calls exceeded their shared-plan fence");
    }
    if (this.#planFenceId) this.#durable.commit(this.#planFenceId, this.#combinedCeilingUsd);
    this.#settled = true;
    return {
      externalChargedUsd: this.#externalController.chargedUsd,
      workerActualUsd,
      durableChargedUsd: this.#combinedCeilingUsd,
      calls: this.#externalController.calls
    };
  }

  abort(workerActualUsd = 0): void {
    if (this.#settled) return;
    const knownWorkerUsd = Number.isFinite(workerActualUsd) && workerActualUsd >= 0 ? workerActualUsd : this.#workerCeilingUsd;
    this.#settleOverrun(
      this.#externalController.chargedUsd + Math.max(knownWorkerUsd, this.#workerCeilingUsd)
    );
  }
}

export interface ManualAuditReview {
  runId: string;
  answerCorrect: boolean | null;
  answerGrounded: boolean | null;
  contradictedEvidence: boolean | null;
  rationale: string;
}

export interface ManualAuditFile {
  schemaVersion: 2;
  evidenceClass: "human-manual-audit";
  runsHash: string;
  selectionSeed: string;
  selectionAlgorithm: "stratified-context-configuration-sha256-v2";
  reviewer: string;
  reviewedAt: string | null;
  runIds: string[];
  reviews: ManualAuditReview[];
}

export interface ManualAuditSummary {
  required: number;
  reviewed: number;
  complete: boolean;
  agreementRate: number | null;
  groundedRate: number | null;
  reviewer: string | null;
  reviewedAt: string | null;
}

function selectManualAuditRuns(runs: readonly EvaluationRunRecord[], requested = 20): EvaluationRunRecord[] {
  const wanted = Math.min(Math.max(1, requested), runs.length);
  const score = (run: EvaluationRunRecord): string => stableHash(`${MANUAL_AUDIT_SEED}:${run.runId}`);
  const stratum = (run: EvaluationRunRecord): string => typeof run.contextMetadata?.configurationId === "string"
    ? `ablation:${run.contextMetadata.configurationId}`
    : `controlled:${run.mode}`;
  const strata = [...new Set(runs.map(stratum))].sort();
  const byStratum = new Map<string, EvaluationRunRecord[]>();
  for (const key of strata) {
    byStratum.set(key, runs.filter((run) => stratum(run) === key).sort((left, right) => score(left).localeCompare(score(right))));
  }
  const selected: EvaluationRunRecord[] = [];
  let offset = 0;
  while (selected.length < wanted) {
    let added = false;
    for (const key of strata) {
      const run = byStratum.get(key)?.[offset];
      if (run && selected.length < wanted) { selected.push(run); added = true; }
    }
    if (!added) break;
    offset += 1;
  }
  return selected;
}

export function createManualAuditTemplate(runs: readonly EvaluationRunRecord[], requested = 20): ManualAuditFile {
  const runIds = selectManualAuditRuns(runs, requested).map((run) => run.runId);
  return {
    schemaVersion: 2,
    evidenceClass: "human-manual-audit",
    runsHash: hashJson(runs),
    selectionSeed: MANUAL_AUDIT_SEED,
    selectionAlgorithm: "stratified-context-configuration-sha256-v2",
    reviewer: "replace-with-independent-human-reviewer",
    reviewedAt: null,
    runIds,
    reviews: runIds.map((runId) => ({
      runId,
      answerCorrect: null,
      answerGrounded: null,
      contradictedEvidence: null,
      rationale: ""
    }))
  };
}

function manualAuditRecord(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${description} must be an object`);
  return value as Record<string, unknown>;
}

export function validateManualAudit(
  value: unknown,
  runs: readonly EvaluationRunRecord[],
  requested = 20
): ManualAuditSummary {
  const expected = createManualAuditTemplate(runs, requested);
  const file = manualAuditRecord(value, "Manual audit");
  if (file.schemaVersion !== 2 || file.evidenceClass !== "human-manual-audit"
    || file.runsHash !== expected.runsHash || file.selectionSeed !== expected.selectionSeed
    || file.selectionAlgorithm !== expected.selectionAlgorithm) {
    throw new Error("Manual audit is not bound to this exact causal run set and selection protocol");
  }
  if (!Array.isArray(file.runIds) || JSON.stringify(file.runIds) !== JSON.stringify(expected.runIds)) {
    throw new Error("Manual audit run IDs do not match the deterministic stratified sample");
  }
  if (typeof file.reviewer !== "string" || !file.reviewer.trim() || /replace-with/i.test(file.reviewer)) {
    throw new Error("Manual audit requires an identified independent reviewer");
  }
  if (typeof file.reviewedAt !== "string" || !Number.isFinite(new Date(file.reviewedAt).valueOf())) {
    throw new Error("Manual audit reviewedAt is invalid");
  }
  if (!Array.isArray(file.reviews) || file.reviews.length !== expected.runIds.length) {
    throw new Error("Manual audit must review every sampled run exactly once");
  }
  const runById = new Map(runs.map((run) => [run.runId, run]));
  const seen = new Set<string>();
  let agreements = 0;
  let comparisons = 0;
  let grounded = 0;
  for (const [index, reviewValue] of file.reviews.entries()) {
    const review = manualAuditRecord(reviewValue, `Manual audit review ${index + 1}`);
    const runId = typeof review.runId === "string" ? review.runId : "";
    if (!expected.runIds.includes(runId) || seen.has(runId)) throw new Error("Manual audit contains an unknown or duplicate run review");
    seen.add(runId);
    if (typeof review.answerCorrect !== "boolean" || typeof review.answerGrounded !== "boolean" || typeof review.contradictedEvidence !== "boolean") {
      throw new Error("Manual audit decisions must all be boolean");
    }
    if (typeof review.rationale !== "string" || !review.rationale.trim() || review.rationale.length > 2_000) {
      throw new Error("Every manual audit decision requires a concise evidence-based rationale");
    }
    const run = runById.get(runId)!;
    const judgedCorrect = (run.semanticAccuracy ?? Math.max(run.exactAccuracy, run.fuzzyAccuracy)) >= 0.5;
    const judgedGrounded = !run.unsupportedMemory && !run.contradictedEvidence;
    agreements += Number(review.answerCorrect === judgedCorrect);
    agreements += Number(review.answerGrounded === judgedGrounded);
    agreements += Number(review.contradictedEvidence === run.contradictedEvidence);
    comparisons += 3;
    grounded += Number(review.answerGrounded);
  }
  return {
    required: expected.runIds.length,
    reviewed: seen.size,
    complete: seen.size === expected.runIds.length,
    agreementRate: comparisons ? agreements / comparisons : null,
    groundedRate: seen.size ? grounded / seen.size : null,
    reviewer: file.reviewer,
    reviewedAt: file.reviewedAt
  };
}

export interface CausalEligibilityGate {
  id: string;
  passed: boolean;
  detail: string;
}

export interface CausalDatasetSourceEvidence {
  id: string;
  kind: "registry-public" | "infinite-build-10k" | "custom-normalized";
  datasetIds: string[];
  messages: number;
  probes: number;
  datasetHash: string;
  generatorHash: string | null;
  manifestHash: string | null;
  registryVerified: boolean;
  completeSource: boolean;
  fullRecordAndProbeCoverage: boolean;
  reproducible: boolean;
  protocol: string | null;
  licenses: string[];
  adaptedRedistributionAllowed: boolean;
}

export interface CausalAblationAggregate {
  configuration: ProductionCausalAblation;
  disabledFeature: string | null;
  metrics: AggregateMetrics;
  deltasVsFull: {
    answerAccuracyDrop: number;
    retrievalRecallAt10Drop: number;
    temporalAccuracyDrop: number;
    unsupportedMemoryRateIncrease: number;
    inputTokenDelta: number;
  };
}

export interface CausalBenchmarkArtifact {
  schemaVersion: 2;
  evidenceClass: "production-causal-live" | "production-path-no-cost-diagnostic";
  generatedAt: string;
  plan: CausalBenchmarkPlan;
  datasetEvidence: {
    registryVerified: boolean;
    completeSource: boolean;
    fullRecordAndProbeCoverage: boolean;
    importManifestHash: string | null;
    sources: CausalDatasetSourceEvidence[];
  };
  implementation: {
    workerCompiler: "JobProcessor.process(memory.compile)";
    candidateIndex: "SqliteCandidateIndex";
    retrievalEngine: "RetrievalEngine";
    rollingSummary: string;
    answerProvider: string;
    groundingJudge: string;
    rerankerControl: string;
  };
  runsHash: string;
  runs: EvaluationRunRecord[];
  metrics: AggregateMetrics[];
  ablations: {
    configurations: ProductionCausalAblation[];
    runsHash: string;
    runs: EvaluationRunRecord[];
    metrics: CausalAblationAggregate[];
  };
  budget: {
    initialAllocatedUsd: number;
    externalActualOrConservativeUsd: number;
    externalBreakdownUsd: {
      answers: number;
      rollingSummaries: number;
      groundingJudge: number;
    };
    productionActualUsd: number;
    durablePlanChargedUsd: number;
    hardCapUsd: 100;
    safe: boolean;
  };
  /** Raw, run-bound reviewer decisions; null until the no-call finalization step. */
  manualAuditEvidence: ManualAuditFile | null;
  manualAudit: ManualAuditSummary;
  eligibility: {
    causalArchitectureClaim: boolean;
    gates: CausalEligibilityGate[];
    productSuperiorityClaim: false;
    liveLatencyClaim: false;
  };
  claimBoundaries: string[];
  limitations: string[];
  resultHash: string;
}

function ablationAggregates(runs: readonly EvaluationRunRecord[]): CausalAblationAggregate[] {
  const byConfiguration = new Map<ProductionCausalAblation, AggregateMetrics>();
  for (const configuration of PRODUCTION_CAUSAL_ABLATIONS) {
    const selected = runs.filter((run) => run.contextMetadata?.configurationId === configuration);
    byConfiguration.set(configuration, aggregateRuns("continuum", selected));
  }
  const full = byConfiguration.get("full")!;
  return PRODUCTION_CAUSAL_ABLATIONS.map((configuration) => {
    const metrics = byConfiguration.get(configuration)!;
    return {
      configuration,
      disabledFeature: configuration === "full" ? null : configuration.replace(/^no_/, ""),
      metrics,
      deltasVsFull: {
        answerAccuracyDrop: full.answerAccuracy - metrics.answerAccuracy,
        retrievalRecallAt10Drop: full.retrievalRecallAt10 - metrics.retrievalRecallAt10,
        temporalAccuracyDrop: full.temporalAccuracy - metrics.temporalAccuracy,
        unsupportedMemoryRateIncrease: metrics.unsupportedMemoryRate - full.unsupportedMemoryRate,
        inputTokenDelta: metrics.cumulativeInputTokens - full.cumulativeInputTokens
      }
    };
  });
}

function exactAblationRuntimeSwitches(
  runs: readonly EvaluationRunRecord[],
  requireVectorExercise: boolean
): boolean {
  return runs.length > 0 && runs.every((run) => {
    const configuration = run.contextMetadata?.configurationId;
    if (typeof configuration !== "string" || !PRODUCTION_CAUSAL_ABLATIONS.includes(configuration as ProductionCausalAblation)) return false;
    const flags = run.contextMetadata?.retrievalFeatureFlags;
    if (typeof flags !== "object" || flags === null || Array.isArray(flags)) return false;
    const vectorEnabledByConfiguration = configuration !== "no_vector";
    return run.contextMetadata?.productionContinuumRetriever === true
      && run.contextMetadata?.workerCompiler === "JobProcessor.process(memory.compile)"
      && run.contextMetadata?.candidateIndex === "SqliteCandidateIndex"
      && run.contextMetadata?.retrievalEngine === "RetrievalEngine"
      && typeof run.contextMetadata?.retrievalNow === "string"
      && Number.isFinite(new Date(run.contextMetadata.retrievalNow).valueOf())
      && sameJson(flags, productionCausalFeatureFlags(configuration as ProductionCausalAblation))
      && run.contextMetadata?.ablationConfiguration === configuration
      && typeof run.contextMetadata?.queryEmbedding === "boolean"
      && run.contextMetadata?.queryEmbeddingSkippedByAblation === !vectorEnabledByConfiguration
      && (!requireVectorExercise || !vectorEnabledByConfiguration || run.contextMetadata.queryEmbedding === true)
      && (vectorEnabledByConfiguration || run.contextMetadata.queryEmbedding === false);
  });
}

function eligibilityGates(input: {
  plan: CausalBenchmarkPlan;
  runs: readonly EvaluationRunRecord[];
  ablationRuns: readonly EvaluationRunRecord[];
  datasetSources: readonly CausalDatasetSourceEvidence[];
  registryVerified: boolean;
  completeSource: boolean;
  fullCoverage: boolean;
  manualAudit: ManualAuditSummary;
  budgetSafe: boolean;
}): CausalEligibilityGate[] {
  const allRuns = [...input.runs, ...input.ablationRuns];
  const memoryRuns = input.runs.filter((run) => run.mode === "flat_hybrid" || run.mode === "continuum");
  const continuumRuns = input.runs.filter((run) => run.mode === "continuum");
  const judgedRuns = allRuns.filter((run) => run.semanticAccuracy !== null);
  const productionPath = memoryRuns.length > 0 && memoryRuns.every((run) => run.contextMetadata?.productionContinuumRetriever === true)
    && continuumRuns.length > 0
    && continuumRuns.every((run) => Number(run.contextMetadata?.compilerInvocations ?? 0) > 0);
  const liveWorker = continuumRuns.length > 0 && continuumRuns.every((run) => run.contextMetadata?.mockProvider === false);
  const vectors = memoryRuns.length > 0 && memoryRuns.every((run) => run.contextMetadata?.queryEmbedding === true && Number(run.contextMetadata?.vectorCount ?? 0) > 0);
  const independentJudge = input.plan.independentJudgeCalls > 0
    && judgedRuns.length === input.plan.independentJudgeCalls
    && judgedRuns.every((run) => run.judgeMetadata?.model === input.plan.judgeModel)
    && input.plan.judgeModel !== input.plan.answerModel;
  const graphBuiltEveryRun = continuumRuns.length > 0 && continuumRuns.every((run) =>
    Number(run.contextMetadata?.claimCount ?? 0) > 0
    && Number(run.contextMetadata?.topicCount ?? 0) > 0
  );
  const continuumDatasets = new Set(continuumRuns.map((run) => run.datasetId));
  const compiledMemoryUsedByEveryDataset = continuumDatasets.size > 0 && [...continuumDatasets].every((datasetId) =>
    continuumRuns.some((run) => run.datasetId === datasetId && Number(run.contextMetadata?.selectedCompiledCandidateCount ?? 0) > 0)
  );
  const expectedRuns = input.plan.probes * input.plan.modes.length * input.plan.repetitions;
  const aggregates = new Map(input.plan.modes.map((mode) => [mode, aggregateRuns(mode, input.runs)]));
  const rolling = aggregates.get("rolling_summary");
  const continuum = aggregates.get("continuum");
  const accuracyLift = rolling && continuum
    ? relativeImprovement(continuum.answerAccuracy, rolling.answerAccuracy)
    : Number.NEGATIVE_INFINITY;
  const temporalRuns = continuumRuns.filter((run) => run.error === null && run.temporalCorrect !== null);
  const tenThousandRuns = continuumRuns.filter((run) => run.error === null && run.checkpoint >= 10_000);
  const tenThousandReductions = tenThousandRuns.map((run) => {
    const selected = Number(run.contextMetadata?.contextInputTokens ?? Number.NaN);
    const full = Number(run.contextMetadata?.fullReplayInputTokens ?? Number.NaN);
    return Number.isFinite(selected) && Number.isFinite(full) && full > 0 ? 1 - selected / full : Number.NaN;
  });
  const averageTenThousandReduction = tenThousandReductions.length > 0 && tenThousandReductions.every(Number.isFinite)
    ? tenThousandReductions.reduce((sum, value) => sum + value, 0) / tenThousandReductions.length
    : Number.NEGATIVE_INFINITY;
  const strongestNonGraph = ["recent_window", "rolling_summary", "flat_hybrid"]
    .map((mode) => aggregates.get(mode as ControlledBaselineMode))
    .filter((metric): metric is AggregateMetrics => metric !== undefined)
    .sort((left, right) => right.answerAccuracy - left.answerAccuracy || left.medianResponseLatencyMs - right.medianResponseLatencyMs)[0];
  const responseOverheadPassed = Boolean(continuum && strongestNonGraph
    && continuum.medianResponseLatencyMs <= strongestNonGraph.medianResponseLatencyMs * 1.25 + 1e-9);
  const expectedAblationRuns = input.plan.probes * PRODUCTION_CAUSAL_ABLATIONS.length * input.plan.repetitions;
  const ablationCoverage = input.ablationRuns.length === expectedAblationRuns
    && PRODUCTION_CAUSAL_ABLATIONS.every((configuration) => input.ablationRuns.filter((run) =>
      run.contextMetadata?.configurationId === configuration
    ).length === input.plan.probes * input.plan.repetitions);
  const ablationSwitches = ablationCoverage && exactAblationRuntimeSwitches(input.ablationRuns, true);
  const ablationMetrics = ablationAggregates(input.ablationRuns);
  const graphOrWikiEffect = ablationMetrics.filter((entry) => entry.configuration === "no_graph" || entry.configuration === "no_topic_pages")
    .some((entry) => entry.deltasVsFull.answerAccuracyDrop > 0
      || entry.deltasVsFull.retrievalRecallAt10Drop > 0
      || entry.deltasVsFull.temporalAccuracyDrop > 0);
  const publicSource = input.datasetSources.some((source) => source.kind === "registry-public"
    && source.registryVerified && source.completeSource && source.fullRecordAndProbeCoverage);
  const expectedInfiniteBuild = generateInfiniteBuild({ messages: 10_000 });
  const custom10k = input.datasetSources.some((source) => source.kind === "infinite-build-10k"
    && source.messages === 10_000 && source.reproducible && source.protocol === "infinite-build-v1"
    && source.generatorHash === expectedInfiniteBuild.generatorHash
    && source.datasetHash === hashJson(expectedInfiniteBuild)
    && source.probes === expectedInfiniteBuild.probes.length
    && source.completeSource && source.fullRecordAndProbeCoverage
    && sameJson(source.datasetIds, [expectedInfiniteBuild.id]));
  return [
    { id: "paid-live-execution", passed: input.plan.paidExecution, detail: "No-cost and dry-run artifacts are diagnostic only." },
    { id: "registry-verified-complete-dataset", passed: input.registryVerified && input.completeSource && input.fullCoverage, detail: "Requires registry pins, complete import, and every normalized record/probe." },
    { id: "registry-public-source-evidence", passed: publicSource, detail: "At least one complete registry-verified public source must be represented in the exact run set." },
    { id: "reproducible-infinite-build-10k", passed: custom10k, detail: "The exact seeded 10,000-message InfiniteBuild protocol must run alongside public evidence." },
    { id: "all-controlled-modes", passed: ALL_MODES.every((mode) => input.plan.modes.includes(mode)), detail: "Recent, learned rolling, raw flat hybrid, and Continuum modes must all run." },
    { id: "three-repetitions", passed: input.plan.repetitions >= 3 && input.runs.length === expectedRuns, detail: "Requires at least three complete repetitions of every planned run." },
    { id: "actual-production-memory-path", passed: productionPath && liveWorker, detail: "Requires live JobProcessor compilation plus SqliteCandidateIndex/RetrievalEngine metadata on every memory run." },
    { id: "knowledge-graph-built-and-used", passed: graphBuiltEveryRun && compiledMemoryUsedByEveryDataset, detail: "Every Continuum repetition must build claims and a wiki page, and each dataset must select compiled rather than only raw memory at least once." },
    { id: "learned-rolling-summary", passed: input.plan.paidExecution && input.plan.learnedSummaryCalls > 0, detail: "The rolling baseline must use paid recursive model summaries, never expected answers or an oracle fixture." },
    { id: "vector-retrieval-exercised", passed: vectors, detail: "Both memory modes require indexed vectors and query embeddings in addition to lexical retrieval." },
    { id: "independent-grounding-judge", passed: independentJudge, detail: "Every non-deterministic run must be judged by a separately configured model." },
    { id: "production-feature-removal-ablations", passed: ablationSwitches, detail: "Full plus lexical, vector, reranker, temporal, topic-page, and graph removals must exercise exact production RetrievalEngine flags." },
    { id: "graph-or-wiki-ablation-effect", passed: graphOrWikiEffect, detail: "Full retrieval must outperform no-graph or no-topic-pages on accuracy, Recall@10, or temporal accuracy; unchanged results remain an honest miss." },
    { id: "human-audit-complete", passed: input.manualAudit.complete && (input.manualAudit.agreementRate ?? 0) >= 0.8, detail: "The deterministic context-configuration-stratified human sample must be complete with at least 80% judge agreement." },
    { id: "no-run-errors", passed: allRuns.every((run) => run.error === null), detail: "Every controlled and ablation run must finish without an error." },
    { id: "shared-budget-safe", passed: input.budgetSafe, detail: "Worker, retrieval, summarization, answer, and judge calls must fit the atomic shared USD 100 plan." },
    { id: "accuracy-lift-over-rolling", passed: accuracyLift >= 0.15, detail: "Continuum answer accuracy must improve by at least 15% relative to learned rolling summary." },
    { id: "retrieval-recall-at-10", passed: (continuum?.retrievalRecallAt10 ?? 0) >= 0.9, detail: "Continuum Retrieval Recall@10 must be at least 90%." },
    { id: "current-state-temporal-accuracy", passed: temporalRuns.length > 0 && (continuum?.temporalAccuracy ?? 0) >= 0.9, detail: "At least one temporal probe is required and current/superseded accuracy must be at least 90%." },
    { id: "unsupported-memory-rate", passed: (continuum?.unsupportedMemoryRate ?? 1) < 0.02, detail: "Unsupported personal-memory assertions must remain below 2%." },
    { id: "prompt-reduction-at-10k", passed: averageTenThousandReduction >= 0.6, detail: "At least one 10,000-message Continuum checkpoint is required and average selected context must be at least 60% smaller than full replay." },
    { id: "response-overhead", passed: responseOverheadPassed, detail: "Median end-to-end controlled response latency must be no more than 25% above the highest-accuracy non-graph baseline (fastest wins ties)." }
  ];
}

function artifactCore(artifact: Omit<CausalBenchmarkArtifact, "resultHash">): CausalBenchmarkArtifact {
  return { ...artifact, resultHash: hashJson(artifact) };
}

export class NoCostContextAnswerProvider implements EvaluationAnswerProvider {
  estimateCost(): number { return 0; }

  async answer(request: EvaluationAnswerRequest): Promise<EvaluationAnswerResult> {
    const queryTokens = new Set(request.query.toLocaleLowerCase().match(/[a-z0-9]+/g) ?? []);
    const lines = request.context.split("\n").filter((line) => line.trim());
    const ranked = lines.map((line) => ({
      line,
      score: (line.toLocaleLowerCase().match(/[a-z0-9]+/g) ?? []).filter((token) => queryTokens.has(token)).length
    })).sort((left, right) => right.score - left.score);
    const answer = ranked[0]?.line ?? "I do not know from the supplied context.";
    const inputTokens = Math.ceil((request.query.length + request.context.length) / 4);
    return {
      answer,
      usage: zeroUsage(inputTokens, Math.ceil(answer.length / 4)),
      latency: { firstTokenMs: 0, totalResponseMs: 0, retrievalMs: 0, rerankingMs: 0, compilationMs: 0 },
      unsupportedMemory: false,
      contradictedEvidence: false
    };
  }
}

function recentForAblation(history: readonly EvaluationMessage[], budget: number): EvaluationMessage[] {
  const selected: EvaluationMessage[] = [];
  let tokens = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    if (tokens + message.tokenCount > budget) break;
    selected.unshift(message);
    tokens += message.tokenCount;
  }
  return selected;
}

async function runProductionCausalAblations(input: {
  datasets: readonly EvaluationDataset[];
  repetitions: number;
  settings: ControlledModelSettings;
  retriever: ProductionCausalRetriever;
  provider: EvaluationAnswerProvider;
  judge: SemanticJudge | null;
  budget: EvaluationBudgetController;
  now: () => string;
}): Promise<EvaluationRunRecord[]> {
  const records: EvaluationRunRecord[] = [];
  for (const dataset of input.datasets) {
    const probes = [...dataset.probes].sort((left, right) => left.checkpoint - right.checkpoint || left.id.localeCompare(right.id));
    for (let repetition = 1; repetition <= input.repetitions; repetition += 1) {
      const stateId = `${dataset.id}:production-ablation:repetition-${repetition}`;
      for (const probe of probes) {
        const history = dataset.messages.slice(0, probe.checkpoint);
        const memoryBudget = Math.floor(input.settings.totalInputTokens * 0.45);
        const recent = recentForAblation(history, input.settings.totalInputTokens - memoryBudget);
        const recentTokens = recent.reduce((sum, message) => sum + message.tokenCount, 0);
        for (const configuration of PRODUCTION_CAUSAL_ABLATIONS) {
          const runId = stableHash(`${dataset.id}:${probe.id}:ablation:${configuration}:${repetition}`);
          const retrieval = await input.retriever.retrieveAblation({
            query: probe.question,
            history,
            tokenBudget: memoryBudget,
            configuration,
            runId,
            stateId
          });
          if (retrieval.tokenCount > memoryBudget) throw new Error(`${configuration} retriever exceeded its controlled token budget`);
          const context: BaselineContext = {
            mode: "continuum",
            renderedContext: `Retrieved evidence:\n${retrieval.text}\n\nRecent turns:\n${recent.map((message) => `${message.role}: ${message.content}`).join("\n")}`,
            selectedMessageIds: recent.map((message) => message.id),
            selectedEvidenceIds: retrieval.evidenceIds,
            inputTokens: recentTokens + retrieval.tokenCount,
            metadata: retrieval.metadata
          };
          records.push(await evaluatePreparedContext({
            datasetId: dataset.id,
            probe,
            repetition,
            mode: "continuum",
            runId,
            history,
            context,
            provider: input.provider,
            budget: input.budget,
            settings: input.settings,
            judge: input.judge,
            now: input.now
          }));
        }
      }
    }
  }
  return records;
}

export async function runProductionCausalBenchmark(input: {
  datasets: EvaluationDataset[];
  plan: CausalBenchmarkPlan;
  settings: ControlledModelSettings;
  summarizer: RollingSummaryProvider & { kind?: string; model?: string };
  retriever: ProductionCausalRetriever;
  provider: EvaluationAnswerProvider;
  judge: SemanticJudge | null;
  budget: SharedCausalBudgetPlan;
  datasetEvidence: CausalBenchmarkArtifact["datasetEvidence"];
  manualAudit?: unknown;
  now?: () => string;
}): Promise<{ artifact: CausalBenchmarkArtifact; auditTemplate: ManualAuditFile }> {
  const now = input.now ?? (() => new Date().toISOString());
  const baselines = createControlledBaselines({ summarizer: input.summarizer, retriever: input.retriever })
    .filter((baseline) => input.plan.modes.includes(baseline.mode));
  const runs: EvaluationRunRecord[] = [];
  const ablationRuns: EvaluationRunRecord[] = [];
  try {
    for (const dataset of input.datasets) {
      runs.push(...await runControlledEvaluation({
        dataset,
        baselines,
        provider: input.provider,
        budget: input.budget.external,
        options: {
          repetitions: input.plan.repetitions,
          settings: input.settings,
          judge: input.judge,
          now,
          runId: ({ datasetId, probeId, mode, repetition }) => stableHash(`${datasetId}:${probeId}:${mode}:${repetition}`)
        }
      }));
    }
    ablationRuns.push(...await runProductionCausalAblations({
      datasets: input.datasets,
      repetitions: input.plan.repetitions,
      settings: input.settings,
      retriever: input.retriever,
      provider: input.provider,
      judge: input.judge,
      budget: input.budget.external,
      now
    }));
    await input.retriever.close();
    const budget = input.budget.finalize(input.retriever.cumulativeProductionSpendUsd);
    const externalBreakdownUsd = budget.calls.reduce((totals, call) => {
      if (call.callId.startsWith("causal-summary:")) totals.rollingSummaries += call.chargedCostUsd;
      else if (call.callId.endsWith(":judge")) totals.groundingJudge += call.chargedCostUsd;
      else totals.answers += call.chargedCostUsd;
      return totals;
    }, { answers: 0, rollingSummaries: 0, groundingJudge: 0 });
    const auditedRuns = [...runs, ...ablationRuns];
    const auditTemplate = createManualAuditTemplate(auditedRuns);
    const manualAudit = input.manualAudit === undefined
      ? { required: auditTemplate.runIds.length, reviewed: 0, complete: false, agreementRate: null, groundedRate: null, reviewer: null, reviewedAt: null }
      : validateManualAudit(input.manualAudit, auditedRuns);
    const manualAuditEvidence = input.manualAudit === undefined
      ? null
      : structuredClone(input.manualAudit) as ManualAuditFile;
    const budgetSafe = input.budget.initialAllocatedUsd + budget.durableChargedUsd <= 100 + 1e-9
      && budget.workerActualUsd <= input.plan.productionWorkerMaximumUsd + 1e-9;
    const gates = eligibilityGates({
      plan: input.plan,
      runs,
      ablationRuns,
      datasetSources: input.datasetEvidence.sources,
      registryVerified: input.datasetEvidence.registryVerified,
      completeSource: input.datasetEvidence.completeSource,
      fullCoverage: input.datasetEvidence.fullRecordAndProbeCoverage,
      manualAudit,
      budgetSafe
    });
    const core: Omit<CausalBenchmarkArtifact, "resultHash"> = {
      schemaVersion: 2,
      evidenceClass: input.plan.paidExecution ? "production-causal-live" : "production-path-no-cost-diagnostic",
      generatedAt: now(),
      plan: input.plan,
      datasetEvidence: input.datasetEvidence,
      implementation: {
        workerCompiler: "JobProcessor.process(memory.compile)",
        candidateIndex: "SqliteCandidateIndex",
        retrievalEngine: "RetrievalEngine",
        rollingSummary: input.summarizer.kind ?? "unclassified",
        answerProvider: input.plan.paidExecution ? "OpenAiEvaluationAnswerProvider" : "NoCostContextAnswerProvider",
        groundingJudge: input.judge ? "OpenAiIndependentGroundingJudge" : "none",
        rerankerControl: "LexicalFixtureReranker held constant across controlled modes and explicitly disabled only for no_reranking"
      },
      runsHash: hashJson(runs),
      runs,
      metrics: input.plan.modes.map((mode) => aggregateRuns(mode, runs)),
      ablations: {
        configurations: [...PRODUCTION_CAUSAL_ABLATIONS],
        runsHash: hashJson(ablationRuns),
        runs: ablationRuns,
        metrics: ablationAggregates(ablationRuns)
      },
      budget: {
        initialAllocatedUsd: input.budget.initialAllocatedUsd,
        externalActualOrConservativeUsd: budget.externalChargedUsd,
        externalBreakdownUsd,
        productionActualUsd: budget.workerActualUsd,
        durablePlanChargedUsd: budget.durableChargedUsd,
        hardCapUsd: 100,
        safe: budgetSafe
      },
      manualAuditEvidence,
      manualAudit,
      eligibility: {
        causalArchitectureClaim: gates.every((gate) => gate.passed),
        gates,
        productSuperiorityClaim: false,
        liveLatencyClaim: false
      },
      claimBoundaries: [
        "This artifact compares controlled context strategies; it does not establish superiority to ChatGPT or Codex without separate frozen manual black-box captures.",
        "Interactive first-token and post-turn-searchability claims require a separately validated live latency artifact and are never inferred from this offline runner.",
        "Controlled-mode comparisons hold the lexical fixture reranker constant; the no-reranking ablation isolates only that fixture's removal and is not evidence for the production provider reranker itself."
      ],
      limitations: [
        "A completed independent human audit is attached only after the run; the initial artifact remains ineligible until finalized without new API calls.",
        "Controlled response latency includes synchronous retrieval before answering; learned-summary and memory-compilation maintenance is reported separately and cannot replace the interactive live-latency harness.",
        "Public dataset licenses and registry pins remain separate from Continuum's MIT license.",
        "Provider and model behavior can change even when visible model names are pinned; preserve raw runs and dates."
      ]
    };
    return { artifact: artifactCore(core), auditTemplate };
  } catch (error) {
    await input.retriever.close().catch(() => undefined);
    input.budget.abort(input.retriever.cumulativeProductionSpendUsd);
    throw error;
  }
}

function nonnegativeNumber(value: unknown, description: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${description} must be finite and non-negative`);
  }
  return value;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertPlanInvariants(
  plan: CausalBenchmarkPlan,
  runs: readonly EvaluationRunRecord[],
  ablationRuns: readonly EvaluationRunRecord[]
): void {
  if (plan.schemaVersion !== 2 || typeof plan.paidExecution !== "boolean") throw new Error("Causal benchmark plan schema is invalid");
  if (!Array.isArray(plan.modes) || plan.modes.length === 0
    || new Set(plan.modes).size !== plan.modes.length
    || plan.modes.some((mode) => !ALL_MODES.includes(mode))) {
    throw new Error("Causal benchmark plan modes are invalid");
  }
  for (const [description, value] of [
    ["datasets", plan.datasets], ["messages", plan.messages], ["probes", plan.probes],
    ["repetitions", plan.repetitions], ["controlledAnswerCalls", plan.controlledAnswerCalls],
    ["ablationAnswerCalls", plan.ablationAnswerCalls], ["answerCalls", plan.answerCalls],
    ["learnedSummaryCalls", plan.learnedSummaryCalls], ["independentJudgeCalls", plan.independentJudgeCalls]
  ] as const) {
    if (!Number.isInteger(value) || value < (description === "learnedSummaryCalls" || description === "independentJudgeCalls" ? 0 : 1)) {
      throw new Error(`Causal benchmark plan ${description} is invalid`);
    }
  }
  assertPinnedEvaluationModel(plan.answerModel);
  assertPinnedEvaluationModel(plan.summaryModel);
  assertPinnedEvaluationModel(plan.judgeModel);
  const answerMaximumUsd = nonnegativeNumber(plan.answerMaximumUsd, "Causal answer maximum");
  const summaryMaximumUsd = nonnegativeNumber(plan.summaryMaximumUsd, "Causal summary maximum");
  const judgeMaximumUsd = nonnegativeNumber(plan.judgeMaximumUsd, "Causal judge maximum");
  const externalMaximumUsd = nonnegativeNumber(plan.externalMaximumUsd, "Causal external maximum");
  const productionMaximumUsd = nonnegativeNumber(plan.productionWorkerMaximumUsd, "Causal worker maximum");
  const combinedMaximumUsd = nonnegativeNumber(plan.combinedMaximumUsd, "Causal combined maximum");
  if (!sameJson(plan.ablationConfigurations, [...PRODUCTION_CAUSAL_ABLATIONS])
    || plan.controlledAnswerCalls !== plan.probes * plan.modes.length * plan.repetitions
    || plan.ablationAnswerCalls !== plan.probes * PRODUCTION_CAUSAL_ABLATIONS.length * plan.repetitions
    || plan.answerCalls !== plan.controlledAnswerCalls + plan.ablationAnswerCalls
    || Math.abs(externalMaximumUsd - (answerMaximumUsd + summaryMaximumUsd + judgeMaximumUsd)) > 1e-9
    || Math.abs(combinedMaximumUsd - (externalMaximumUsd + productionMaximumUsd)) > 1e-9
    || plan.pricingSafetyMultiplier !== EVALUATION_RESERVATION_SAFETY_MULTIPLIER) {
    throw new Error("Causal benchmark plan arithmetic is inconsistent");
  }
  if (!plan.paidExecution && (answerMaximumUsd !== 0 || summaryMaximumUsd !== 0 || judgeMaximumUsd !== 0
    || productionMaximumUsd !== 0 || plan.learnedSummaryCalls !== 0 || plan.independentJudgeCalls !== 0)) {
    throw new Error("No-cost causal plans cannot contain paid calls or reservations");
  }
  if (runs.length !== plan.controlledAnswerCalls || ablationRuns.length !== plan.ablationAnswerCalls) {
    throw new Error("Causal benchmark controlled or ablation run count does not match the plan");
  }
  const firstSettings = runs[0]?.settings ?? ablationRuns[0]?.settings;
  if (!firstSettings || firstSettings.model !== plan.answerModel) throw new Error("Causal answer model does not match the run settings");
  const expectedAnswerMaximum = plan.paidExecution
    ? plan.answerCalls * estimateLiveEvaluationReservation(firstSettings)
    : 0;
  if (Math.abs(expectedAnswerMaximum - plan.answerMaximumUsd) > 1e-9) {
    throw new Error("Causal answer reservation maximum is inconsistent with the pinned settings");
  }
  const runIds = new Set<string>();
  const datasetIds = new Set<string>();
  const probeKeys = new Set<string>();
  const cells = new Set<string>();
  for (const run of runs) {
    if (!run.runId || runIds.has(run.runId)) throw new Error("Causal benchmark run IDs must be unique and non-empty");
    runIds.add(run.runId);
    if (!run.datasetId || !run.probeId || !plan.modes.includes(run.mode)
      || !Number.isInteger(run.repetition) || run.repetition < 1 || run.repetition > plan.repetitions
      || !sameJson(run.settings, firstSettings)) {
      throw new Error("Causal benchmark run identity or controlled settings are invalid");
    }
    const probeKey = `${run.datasetId}\u0000${run.probeId}`;
    const cell = `${probeKey}\u0000${run.mode}\u0000${run.repetition}`;
    if (cells.has(cell)) throw new Error("Causal benchmark contains a duplicate dataset/probe/mode/repetition cell");
    cells.add(cell);
    datasetIds.add(run.datasetId);
    probeKeys.add(probeKey);
  }
  if (datasetIds.size !== plan.datasets || probeKeys.size !== plan.probes) {
    throw new Error("Causal benchmark dataset/probe coverage does not match the plan");
  }
  for (const mode of plan.modes) {
    if (runs.filter((run) => run.mode === mode).length !== plan.probes * plan.repetitions) {
      throw new Error("Causal benchmark mode coverage does not match the plan");
    }
  }
  const ablationIds = new Set<string>();
  const ablationCells = new Set<string>();
  const ablationTimes = new Map<string, string>();
  for (const run of ablationRuns) {
    const configuration = run.contextMetadata?.configurationId;
    if (!run.runId || ablationIds.has(run.runId) || runIds.has(run.runId)
      || run.mode !== "continuum" || typeof configuration !== "string"
      || !PRODUCTION_CAUSAL_ABLATIONS.includes(configuration as ProductionCausalAblation)
      || !Number.isInteger(run.repetition) || run.repetition < 1 || run.repetition > plan.repetitions
      || !sameJson(run.settings, firstSettings)) {
      throw new Error("Causal ablation run identity or controlled settings are invalid");
    }
    ablationIds.add(run.runId);
    const probeRepetition = `${run.datasetId}\u0000${run.probeId}\u0000${run.repetition}`;
    const retrievalNow = String(run.contextMetadata?.retrievalNow ?? "");
    const priorTime = ablationTimes.get(probeRepetition);
    if (priorTime !== undefined && priorTime !== retrievalNow) {
      throw new Error("Causal feature configurations did not share one frozen retrieval timestamp");
    }
    ablationTimes.set(probeRepetition, retrievalNow);
    const cell = `${run.datasetId}\u0000${run.probeId}\u0000${configuration}\u0000${run.repetition}`;
    if (ablationCells.has(cell)) throw new Error("Causal benchmark contains a duplicate ablation cell");
    ablationCells.add(cell);
  }
  for (const configuration of PRODUCTION_CAUSAL_ABLATIONS) {
    if (ablationRuns.filter((run) => run.contextMetadata?.configurationId === configuration).length !== plan.probes * plan.repetitions) {
      throw new Error("Causal benchmark ablation coverage does not match the plan");
    }
  }
  const controlledProbeKeys = [...probeKeys].sort();
  const ablationProbeKeys = [...new Set(ablationRuns.map((run) => `${run.datasetId}\u0000${run.probeId}`))].sort();
  if (!sameJson(controlledProbeKeys, ablationProbeKeys)) {
    throw new Error("Causal benchmark ablations do not cover the exact controlled dataset/probe set");
  }
}

export function validateCausalBenchmarkArtifact(value: unknown): CausalBenchmarkArtifact {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Causal benchmark artifact must be an object");
  const artifact = value as Record<string, unknown>;
  if (artifact.schemaVersion !== 2 || typeof artifact.resultHash !== "string" || !/^[a-f0-9]{64}$/.test(artifact.resultHash)) {
    throw new Error("Causal benchmark artifact schema or result hash is invalid");
  }
  const core = Object.fromEntries(Object.entries(artifact).filter(([key]) => key !== "resultHash"));
  if (hashJson(core) !== artifact.resultHash) throw new Error("Causal benchmark artifact hash does not match its content");
  if (!Array.isArray(artifact.runs) || hashJson(artifact.runs) !== artifact.runsHash) throw new Error("Causal benchmark run hash is invalid");
  const parsed = artifact as unknown as CausalBenchmarkArtifact;
  if (!Array.isArray(parsed.ablations?.runs)
    || hashJson(parsed.ablations.runs) !== parsed.ablations.runsHash
    || !sameJson(parsed.ablations.configurations, [...PRODUCTION_CAUSAL_ABLATIONS])) {
    throw new Error("Causal benchmark ablation run hash or configuration set is invalid");
  }
  if (!Number.isFinite(new Date(parsed.generatedAt).valueOf())) throw new Error("Causal benchmark generatedAt is invalid");
  if (parsed.evidenceClass !== (parsed.plan.paidExecution ? "production-causal-live" : "production-path-no-cost-diagnostic")) {
    throw new Error("Causal benchmark evidence class does not match its execution class");
  }
  assertPlanInvariants(parsed.plan, parsed.runs, parsed.ablations.runs);
  if (parsed.implementation.workerCompiler !== "JobProcessor.process(memory.compile)"
    || parsed.implementation.candidateIndex !== "SqliteCandidateIndex"
    || parsed.implementation.retrievalEngine !== "RetrievalEngine") {
    throw new Error("Causal benchmark implementation identity is invalid");
  }
  if (typeof parsed.datasetEvidence?.registryVerified !== "boolean"
    || typeof parsed.datasetEvidence.completeSource !== "boolean"
    || typeof parsed.datasetEvidence.fullRecordAndProbeCoverage !== "boolean"
    || (parsed.datasetEvidence.importManifestHash !== null && !/^[a-f0-9]{64}$/.test(parsed.datasetEvidence.importManifestHash))
    || !Array.isArray(parsed.datasetEvidence.sources) || parsed.datasetEvidence.sources.length === 0) {
    throw new Error("Causal benchmark dataset evidence is invalid");
  }
  const sourceIds = new Set<string>();
  const sourceDatasetIds = new Set<string>();
  for (const source of parsed.datasetEvidence.sources) {
    if (!source || typeof source.id !== "string" || !source.id.trim() || sourceIds.has(source.id)
      || !["registry-public", "infinite-build-10k", "custom-normalized"].includes(source.kind)
      || !Array.isArray(source.datasetIds) || source.datasetIds.length === 0
      || !Number.isInteger(source.messages) || source.messages < 1
      || !Number.isInteger(source.probes) || source.probes < 1
      || !/^[a-f0-9]{64}$/.test(source.datasetHash)
      || (source.generatorHash !== null && (typeof source.generatorHash !== "string" || !source.generatorHash.trim()))
      || (source.manifestHash !== null && !/^[a-f0-9]{64}$/.test(source.manifestHash))
      || typeof source.registryVerified !== "boolean" || typeof source.completeSource !== "boolean"
      || typeof source.fullRecordAndProbeCoverage !== "boolean" || typeof source.reproducible !== "boolean"
      || (source.protocol !== null && (typeof source.protocol !== "string" || !source.protocol.trim()))
      || !Array.isArray(source.licenses) || source.licenses.length === 0
      || source.licenses.some((license) => typeof license !== "string" || !license.trim())
      || new Set(source.licenses).size !== source.licenses.length
      || typeof source.adaptedRedistributionAllowed !== "boolean") {
      throw new Error("Causal benchmark dataset source evidence is invalid");
    }
    sourceIds.add(source.id);
    for (const datasetId of source.datasetIds) {
      if (typeof datasetId !== "string" || !datasetId.trim() || sourceDatasetIds.has(datasetId)) {
        throw new Error("Causal benchmark dataset source IDs must be non-empty and uniquely owned");
      }
      sourceDatasetIds.add(datasetId);
    }
  }
  const runDatasetIds = [...new Set(parsed.runs.map((run) => run.datasetId))].sort();
  if (!sameJson([...sourceDatasetIds].sort(), runDatasetIds)
    || parsed.datasetEvidence.sources.reduce((sum, source) => sum + source.messages, 0) !== parsed.plan.messages
    || parsed.datasetEvidence.sources.reduce((sum, source) => sum + source.probes, 0) !== parsed.plan.probes) {
    throw new Error("Causal benchmark dataset source evidence does not cover the exact planned run set");
  }
  const publicSources = parsed.datasetEvidence.sources.filter((source) => source.kind === "registry-public");
  const expectedRegistryVerified = publicSources.some((source) => source.registryVerified);
  const expectedCompleteSource = publicSources.some((source) => source.completeSource);
  const expectedFullCoverage = publicSources.some((source) => source.fullRecordAndProbeCoverage);
  if (parsed.datasetEvidence.registryVerified !== expectedRegistryVerified
    || parsed.datasetEvidence.completeSource !== expectedCompleteSource
    || parsed.datasetEvidence.fullRecordAndProbeCoverage !== expectedFullCoverage
    || parsed.datasetEvidence.importManifestHash !== (publicSources[0]?.manifestHash ?? null)) {
    throw new Error("Causal benchmark legacy dataset evidence summary disagrees with its bound source records");
  }
  const expectedMetrics = parsed.plan.modes.map((mode) => aggregateRuns(mode, parsed.runs));
  if (!sameJson(parsed.metrics, expectedMetrics)) throw new Error("Causal benchmark aggregate metrics do not match the raw runs");
  const expectedAblationMetrics = ablationAggregates(parsed.ablations.runs);
  if (!sameJson(parsed.ablations.metrics, expectedAblationMetrics)
    || !exactAblationRuntimeSwitches(parsed.ablations.runs, false)) {
    throw new Error("Causal benchmark ablation metrics or production feature switches are invalid");
  }
  const initialAllocatedUsd = nonnegativeNumber(parsed.budget?.initialAllocatedUsd, "Causal initial allocation");
  const externalUsd = nonnegativeNumber(parsed.budget.externalActualOrConservativeUsd, "Causal external spend");
  const answerUsd = nonnegativeNumber(parsed.budget.externalBreakdownUsd?.answers, "Causal answer spend");
  const summaryUsd = nonnegativeNumber(parsed.budget.externalBreakdownUsd?.rollingSummaries, "Causal rolling-summary spend");
  const judgeUsd = nonnegativeNumber(parsed.budget.externalBreakdownUsd?.groundingJudge, "Causal grounding-judge spend");
  const productionUsd = nonnegativeNumber(parsed.budget.productionActualUsd, "Causal production spend");
  const durableUsd = nonnegativeNumber(parsed.budget.durablePlanChargedUsd, "Causal durable charge");
  if (parsed.budget.hardCapUsd !== 100 || externalUsd > parsed.plan.externalMaximumUsd + 1e-9
    || Math.abs(externalUsd - (answerUsd + summaryUsd + judgeUsd)) > 1e-9
    || productionUsd > parsed.plan.productionWorkerMaximumUsd + 1e-9
    || Math.abs(durableUsd - parsed.plan.combinedMaximumUsd) > 1e-9) {
    throw new Error("Causal benchmark budget accounting is inconsistent with the shared plan");
  }
  const budgetSafe = initialAllocatedUsd + durableUsd <= 100 + 1e-9
    && productionUsd <= parsed.plan.productionWorkerMaximumUsd + 1e-9;
  if (parsed.budget.safe !== budgetSafe) throw new Error("Causal benchmark budget safety flag is invalid");
  let expectedAudit: ManualAuditSummary;
  const auditedRuns = [...parsed.runs, ...parsed.ablations.runs];
  if (parsed.manualAuditEvidence === null) {
    const template = createManualAuditTemplate(auditedRuns);
    expectedAudit = {
      required: template.runIds.length,
      reviewed: 0,
      complete: false,
      agreementRate: null,
      groundedRate: null,
      reviewer: null,
      reviewedAt: null
    };
  } else {
    expectedAudit = validateManualAudit(parsed.manualAuditEvidence, auditedRuns);
  }
  if (!sameJson(parsed.manualAudit, expectedAudit)) throw new Error("Causal benchmark manual-audit summary does not match its raw review evidence");
  const expectedGates = eligibilityGates({
    plan: parsed.plan,
    runs: parsed.runs,
    ablationRuns: parsed.ablations.runs,
    datasetSources: parsed.datasetEvidence.sources,
    registryVerified: parsed.datasetEvidence.registryVerified,
    completeSource: parsed.datasetEvidence.completeSource,
    fullCoverage: parsed.datasetEvidence.fullRecordAndProbeCoverage,
    manualAudit: expectedAudit,
    budgetSafe
  });
  if (!sameJson(parsed.eligibility?.gates, expectedGates)
    || parsed.eligibility.causalArchitectureClaim !== expectedGates.every((gate) => gate.passed)
    || parsed.eligibility.productSuperiorityClaim !== false
    || parsed.eligibility.liveLatencyClaim !== false) {
    throw new Error("Causal benchmark eligibility does not match recomputed strict gates");
  }
  if (!Array.isArray(parsed.claimBoundaries) || parsed.claimBoundaries.length < 3
    || !Array.isArray(parsed.limitations) || parsed.limitations.length < 3) {
    throw new Error("Causal benchmark claim boundaries or limitations are incomplete");
  }
  return parsed;
}

export function finalizeCausalBenchmarkAudit(
  artifactValue: unknown,
  manualAuditValue: unknown
): CausalBenchmarkArtifact {
  const artifact = validateCausalBenchmarkArtifact(artifactValue);
  const manualAudit = validateManualAudit(manualAuditValue, [...artifact.runs, ...artifact.ablations.runs]);
  const gates = artifact.eligibility.gates.map((gate) => gate.id === "human-audit-complete"
    ? { ...gate, passed: manualAudit.complete && (manualAudit.agreementRate ?? 0) >= 0.8 }
    : gate);
  const core: Omit<CausalBenchmarkArtifact, "resultHash"> = {
    ...artifact,
    manualAuditEvidence: structuredClone(manualAuditValue) as ManualAuditFile,
    manualAudit,
    eligibility: {
      ...artifact.eligibility,
      causalArchitectureClaim: gates.every((gate) => gate.passed),
      gates
    }
  };
  delete (core as Partial<CausalBenchmarkArtifact>).resultHash;
  return artifactCore(core);
}
