import { createHash } from "node:crypto";

import {
  createControlledBaselines,
  DeterministicSummaryFixture,
  type EvaluationMemoryRetriever
} from "./baselines.js";
import { EvaluationBudgetGuard } from "./budget.js";
import { createManualBuildScenario, generateInfiniteBuild } from "./infinite-build.js";
import { aggregateRuns } from "./metrics.js";
import {
  runControlledEvaluation,
  type EvaluationAnswerProvider,
  type EvaluationAnswerRequest
} from "./runner.js";
import type {
  AggregateMetrics,
  ControlledBaselineMode,
  EvaluationDataset,
  EvaluationMessage,
  EvaluationRunRecord
} from "./types.js";

export interface FixtureRetrievalFeatures {
  lexical: boolean;
  vector: boolean;
  reranking: boolean;
  temporal: boolean;
  topicPages: boolean;
  graph: boolean;
}

export interface FixtureAblationResult {
  name: string;
  disabledFeature: keyof FixtureRetrievalFeatures | null;
  answerAccuracy: number;
  retrievalRecallAt10: number;
  temporalAccuracy: number;
  cumulativeInputTokens: number;
  runs: number;
}

export interface NoCostFixtureResult {
  dataset: EvaluationDataset;
  runs: EvaluationRunRecord[];
  metrics: AggregateMetrics[];
  ablations: FixtureAblationResult[];
  fullHistoryReplayTokens: number;
  budgetTotalUsd: number;
  resultHash: string;
  accuracyGateDiagnosis: FixtureAccuracyGateDiagnosis;
}

export interface FixtureAccuracyGateDiagnosis {
  targetRelativeImprovement: number;
  actualRelativeImprovement: number;
  rollingAccuracy: number;
  continuumAccuracy: number;
  requiredContinuumAccuracy: number;
  maximumPossibleRelativeImprovement: number;
  mathematicallyReachableOnThisRun: boolean;
  continuumAtCeiling: boolean;
  flatContinuumParity: boolean;
  unchangedAblations: string[];
  rollingMisses: Array<{
    datasetId: string;
    probeId: string;
    checkpoint: number;
    answer: string;
    score: number;
  }>;
  conclusion: "gate-met" | "fixture-saturated" | "gate-missed";
  explanation: string;
}

export const FULL_FIXTURE_FEATURES: FixtureRetrievalFeatures = {
  lexical: true,
  vector: true,
  reranking: true,
  temporal: true,
  topicPages: true,
  graph: true
};

const FLAT_FIXTURE_FEATURES: FixtureRetrievalFeatures = {
  lexical: true,
  vector: true,
  reranking: false,
  temporal: false,
  topicPages: false,
  graph: false
};

const STOPWORDS = new Set([
  "a", "all", "and", "at", "be", "did", "do", "for", "from", "how", "i", "in", "is", "it",
  "me", "my", "of", "on", "or", "the", "to", "was", "we", "what", "when", "which", "who", "why"
]);

const CONCEPTS: Array<{ name: string; pattern: RegExp }> = [
  { name: "codename", pattern: /\b(codename|northstar)\b/i },
  { name: "visual-preference", pattern: /\b(visual|ui preference|dark mode|blue accents?)\b/i },
  { name: "launch-principle", pattern: /\b(launch principle|one timeline|context tax|exact launch)\b/i },
  { name: "database", pattern: /\b(database|mongodb|postgresql)\b/i },
  { name: "atlas-chain", pattern: /\b(alice|atlas|rust|service owned|language is the service)\b/i },
  { name: "launch-window", pattern: /\b(launch (?:window|month)|september|october)\b/i },
  { name: "authentication", pattern: /\b(authentication|passkeys?|signed server sessions?)\b/i },
  { name: "warning-color", pattern: /\b(warning color|amber|coral)\b/i },
  { name: "backup-retention", pattern: /\b(backup retention|managed backups?|seven daily|four weekly|7 daily|4 weekly)\b/i },
  { name: "graph-bounds", pattern: /\b(graph expansion|semantic drift|token growth|bounded)\b/i },
  { name: "lantern-database", pattern: /\b(lantern|sqlite|postgresql export)\b/i }
];

function tokens(value: string): string[] {
  return (value.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function concepts(value: string): Set<string> {
  return new Set(CONCEPTS.filter((concept) => concept.pattern.test(value)).map((concept) => concept.name));
}

function intersectionScore(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let matches = 0;
  for (const value of left) if (right.has(value)) matches += 1;
  return matches / Math.max(1, left.size);
}

function isCorrection(message: EvaluationMessage): boolean {
  return /\b(correction|corrected|replace|supersed|change|now current|remains authoritative)\b/i.test(message.content);
}

function isDurable(message: EvaluationMessage): boolean {
  return /\b(remember|record|decid|correction|preference|current|conclusion|retain)\b/i.test(message.content);
}

export class DeterministicFixtureRetriever implements EvaluationMemoryRetriever {
  constructor(private readonly continuumFeatures: FixtureRetrievalFeatures = FULL_FIXTURE_FEATURES) {}

  async retrieve(input: {
    query: string;
    history: readonly EvaluationMessage[];
    tokenBudget: number;
    mode: "flat_hybrid" | "continuum";
  }): Promise<{ text: string; evidenceIds: string[]; tokenCount: number; metadata: Record<string, unknown> }> {
    const features = input.mode === "flat_hybrid" ? FLAT_FIXTURE_FEATURES : this.continuumFeatures;
    const queryTokens = new Set(tokens(input.query));
    const queryConcepts = concepts(input.query);
    const currentIntent = /\b(current|currently|now|established|replace)\b/i.test(input.query);
    const historicalIntent = /\b(original|originally|previous|earlier|at first)\b/i.test(input.query);
    const relationshipIntent = /\b(service owned by|language|why.*graph|relationship|connect)\b/i.test(input.query);
    const scored = input.history.map((message) => {
      const messageTokens = new Set(tokens(message.content));
      const messageConcepts = concepts(message.content);
      let score = 0;
      if (features.lexical) score += intersectionScore(queryTokens, messageTokens) * 2;
      if (features.vector) score += intersectionScore(queryConcepts, messageConcepts) * 3;
      if (features.topicPages && isDurable(message) && intersectionScore(queryConcepts, messageConcepts) > 0) score += 1.25;
      if (features.temporal && currentIntent && isCorrection(message)) score += 1.5;
      if (features.temporal && historicalIntent && !isCorrection(message) && intersectionScore(queryConcepts, messageConcepts) > 0) score += 1;
      if (features.graph && relationshipIntent && messageConcepts.has("atlas-chain")) score += 2;
      if (features.graph && relationshipIntent && messageConcepts.has("graph-bounds")) score += 2;
      if (features.reranking && message.role === "user" && intersectionScore(queryConcepts, messageConcepts) > 0) score += 0.4;
      return { message, score };
    }).filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || right.message.sequence - left.message.sequence);

    const selected: EvaluationMessage[] = [];
    let tokenCount = 0;
    for (const candidate of scored) {
      if (selected.length >= 10 || tokenCount + candidate.message.tokenCount > input.tokenBudget) continue;
      selected.push(candidate.message);
      tokenCount += candidate.message.tokenCount;
    }
    return {
      text: selected.map((message) => `[${message.id}] ${message.role}: ${message.content}`).join("\n"),
      evidenceIds: selected.map((message) => message.id),
      tokenCount,
      metadata: {
        fixture: true,
        features,
        candidatesScored: scored.length,
        selected: selected.length
      }
    };
  }
}

function answerFromContext(request: EvaluationAnswerRequest): string {
  const query = request.query.toLocaleLowerCase();
  const context = request.context;
  const has = (pattern: RegExp): boolean => pattern.test(context);
  if (/pet'?s? name|pet name/.test(query)) return "I don't know; no retained evidence provides a pet's name.";
  if (/codename/.test(query)) return has(/Northstar/i) ? "Northstar" : "I don't know; no codename evidence was selected.";
  if (/visual preference/.test(query)) return has(/dark mode with restrained blue accents/i) ? "dark mode with restrained blue accents" : "I don't know.";
  if (/exact launch principle|quote my/.test(query)) return has(/One timeline, no context tax/i) ? "One timeline, no context tax." : "I don't know the exact wording.";
  if (/originally choose|original database/.test(query)) return has(/MongoDB/i) ? "MongoDB" : "I don't know.";
  if (/production database/.test(query)) {
    if (has(/PostgreSQL/i)) return has(/MongoDB/i) ? "PostgreSQL replaced MongoDB." : "PostgreSQL";
    return has(/MongoDB/i) ? "MongoDB" : "I don't know.";
  }
  if (/service owned by alice|owned by alice written/.test(query)) return has(/Alice owns (?:the )?Atlas/i) && has(/Atlas.*Rust/i) ? "Rust" : "I don't know.";
  if (/launch month/.test(query)) return has(/September/i) && has(/October/i) ? "The launch month is unresolved between September and October." : "I don't know; it is not established.";
  if (/authentication approach/.test(query)) return has(/passkeys/i) ? "passkeys" : has(/signed server sessions/i) ? "signed server sessions" : "I don't know.";
  if (/warning color/.test(query)) return has(/coral/i) ? "coral" : has(/amber/i) ? "amber" : "I don't know.";
  if (/backup retention/.test(query)) return has(/seven daily and four weekly/i) ? "seven daily and four weekly" : "I don't know.";
  if (/graph expansion/.test(query)) return has(/semantic drift and uncontrolled token growth/i) ? "to prevent semantic drift and uncontrolled token growth" : "I don't know.";
  if (/lantern.*database|database decision/.test(query)) return has(/SQLite/i) ? "SQLite" : "I don't know.";
  return "I don't know; the deterministic fixture has no answer rule for this question.";
}

class DeterministicFixtureAnswerProvider implements EvaluationAnswerProvider {
  estimateCost(): number { return 0; }

  async answer(request: EvaluationAnswerRequest) {
    const answer = answerFromContext(request);
    return {
      answer,
      usage: {
        inputTokens: Math.max(1, Math.ceil(request.context.length / 4)),
        cachedInputTokens: 0,
        outputTokens: Math.max(1, Math.ceil(answer.length / 4)),
        extractionTokens: 0,
        embeddingTokens: 0,
        rerankingTokens: 0,
        estimatedCostUsd: 0
      },
      latency: {
        firstTokenMs: 0,
        totalResponseMs: 0,
        retrievalMs: 0,
        rerankingMs: 0,
        compilationMs: 0
      },
      unsupportedMemory: false,
      contradictedEvidence: false
    };
  }
}

const settings = {
  provider: "deterministic-fixture",
  model: "no-model-called",
  reasoning: "none",
  totalInputTokens: 4_096,
  outputTokens: 256,
  temperature: 0
};

function stableRunId(input: {
  datasetId: string;
  probeId: string;
  mode: ControlledBaselineMode;
  repetition: number;
}): string {
  return createHash("sha256")
    .update(`${input.datasetId}:${input.probeId}:${input.mode}:${input.repetition}`)
    .digest("hex")
    .slice(0, 32);
}

function fullReplayTokens(dataset: EvaluationDataset): number {
  const prefix: number[] = [0];
  for (const message of dataset.messages) prefix.push(prefix.at(-1)! + message.tokenCount);
  return dataset.probes.reduce((sum, probe) => sum + (prefix[probe.checkpoint] ?? 0), 0);
}

async function executeDataset(
  dataset: EvaluationDataset,
  retriever: EvaluationMemoryRetriever,
  modes: ControlledBaselineMode[]
): Promise<EvaluationRunRecord[]> {
  const baselines = createControlledBaselines({
    summarizer: new DeterministicSummaryFixture(),
    retriever
  }).filter((baseline) => modes.includes(baseline.mode));
  return runControlledEvaluation({
    dataset,
    baselines,
    provider: new DeterministicFixtureAnswerProvider(),
    budget: new EvaluationBudgetGuard(),
    options: {
      repetitions: 1,
      settings,
      now: () => "2026-07-13T00:00:00.000Z",
      runId: stableRunId
    }
  });
}

export async function runNoCostFixtureEvaluation(options: { messages?: number } = {}): Promise<NoCostFixtureResult> {
  const dataset = generateInfiniteBuild({ messages: options.messages ?? 10_000 });
  const manual = createManualBuildScenario();
  const mainRuns = await executeDataset(
    dataset,
    new DeterministicFixtureRetriever(),
    ["recent_window", "rolling_summary", "flat_hybrid", "continuum"]
  );
  const manualRuns = await executeDataset(
    manual,
    new DeterministicFixtureRetriever(),
    ["recent_window", "rolling_summary", "flat_hybrid", "continuum"]
  );
  const runs = [...mainRuns, ...manualRuns];
  const modes: ControlledBaselineMode[] = ["recent_window", "rolling_summary", "flat_hybrid", "continuum"];
  const metrics = modes.map((mode) => aggregateRuns(mode, runs));

  const ablationEntries: Array<{ name: string; feature: keyof FixtureRetrievalFeatures | null }> = [
    { name: "Full deterministic Continuum fixture", feature: null },
    { name: "Without lexical retrieval", feature: "lexical" },
    { name: "Without vector-like semantic concepts", feature: "vector" },
    { name: "Without deterministic reranking", feature: "reranking" },
    { name: "Without temporal policy", feature: "temporal" },
    { name: "Without durable topic-page signal", feature: "topicPages" },
    { name: "Without graph relation expansion", feature: "graph" }
  ];
  const ablations: FixtureAblationResult[] = [];
  for (const entry of ablationEntries) {
    const features = { ...FULL_FIXTURE_FEATURES };
    if (entry.feature) features[entry.feature] = false;
    const ablationRuns = await executeDataset(
      dataset,
      new DeterministicFixtureRetriever(features),
      ["continuum"]
    );
    const aggregate = aggregateRuns("continuum", ablationRuns);
    ablations.push({
      name: entry.name,
      disabledFeature: entry.feature,
      answerAccuracy: aggregate.answerAccuracy,
      retrievalRecallAt10: aggregate.retrievalRecallAt10,
      temporalAccuracy: aggregate.temporalAccuracy,
      cumulativeInputTokens: aggregate.cumulativeInputTokens,
      runs: aggregate.runs
    });
  }

  const resultHash = createHash("sha256").update(JSON.stringify({
    generatorHash: dataset.generatorHash,
    metrics,
    ablations,
    runs: runs.map((run) => ({
      datasetId: run.datasetId,
      probeId: run.probeId,
      mode: run.mode,
      answer: run.answer,
      selectedEvidenceIds: run.selectedEvidenceIds,
      exactAccuracy: run.exactAccuracy,
      fuzzyAccuracy: run.fuzzyAccuracy
    }))
  })).digest("hex");

  const rolling = metrics.find((item) => item.mode === "rolling_summary")!;
  const continuum = metrics.find((item) => item.mode === "continuum")!;
  const flat = metrics.find((item) => item.mode === "flat_hybrid")!;
  const targetRelativeImprovement = 0.15;
  const actualRelativeImprovement = rolling.answerAccuracy === 0
    ? continuum.answerAccuracy > 0 ? Number.POSITIVE_INFINITY : 0
    : (continuum.answerAccuracy - rolling.answerAccuracy) / rolling.answerAccuracy;
  const maximumPossibleRelativeImprovement = rolling.answerAccuracy === 0
    ? Number.POSITIVE_INFINITY
    : (1 - rolling.answerAccuracy) / rolling.answerAccuracy;
  const requiredContinuumAccuracy = rolling.answerAccuracy * (1 + targetRelativeImprovement);
  const continuumAtCeiling = Math.abs(continuum.answerAccuracy - 1) < 1e-12;
  const flatContinuumParity = Math.abs(flat.answerAccuracy - continuum.answerAccuracy) < 1e-12;
  const fullAblation = ablations[0]!;
  const unchangedAblations = ablations.slice(1)
    .filter((entry) =>
      Math.abs(entry.answerAccuracy - fullAblation.answerAccuracy) < 1e-12 &&
      Math.abs(entry.retrievalRecallAt10 - fullAblation.retrievalRecallAt10) < 1e-12 &&
      Math.abs(entry.temporalAccuracy - fullAblation.temporalAccuracy) < 1e-12
    )
    .map((entry) => entry.name);
  const rollingMisses = runs
    .filter((run) => run.mode === "rolling_summary")
    .map((run) => ({
      datasetId: run.datasetId,
      probeId: run.probeId,
      checkpoint: run.checkpoint,
      answer: run.answer,
      score: run.semanticAccuracy ?? Math.max(run.exactAccuracy, run.fuzzyAccuracy)
    }))
    .filter((run) => run.score < 0.8);
  const mathematicallyReachableOnThisRun = requiredContinuumAccuracy <= 1 + 1e-12;
  const conclusion = actualRelativeImprovement >= targetRelativeImprovement
    ? "gate-met"
    : continuumAtCeiling && !mathematicallyReachableOnThisRun
      ? "fixture-saturated"
      : "gate-missed";
  const accuracyGateDiagnosis: FixtureAccuracyGateDiagnosis = {
    targetRelativeImprovement,
    actualRelativeImprovement,
    rollingAccuracy: rolling.answerAccuracy,
    continuumAccuracy: continuum.answerAccuracy,
    requiredContinuumAccuracy,
    maximumPossibleRelativeImprovement,
    mathematicallyReachableOnThisRun,
    continuumAtCeiling,
    flatContinuumParity,
    unchangedAblations,
    rollingMisses,
    conclusion,
    explanation: conclusion === "fixture-saturated"
      ? `The deterministic Continuum fixture is already at 100% while rolling summary is ${(rolling.answerAccuracy * 100).toFixed(1)}%. A 15% relative lift would require ${(requiredContinuumAccuracy * 100).toFixed(1)}% accuracy, which is impossible. Flat/Continuum parity and ${unchangedAblations.length} unchanged ablations show that this small rule-backed fact set is saturated; it cannot substantiate the release effect-size claim.`
      : conclusion === "gate-met"
        ? "The diagnostic run reaches the numeric threshold, but deterministic fixture evidence still cannot establish a live-model release claim."
        : "The gate is numerically reachable but was not met; inspect rolling misses and component ablations before any release claim."
  };

  return {
    dataset,
    runs,
    metrics,
    ablations,
    fullHistoryReplayTokens: fullReplayTokens(dataset) + fullReplayTokens(manual),
    budgetTotalUsd: 0,
    resultHash,
    accuracyGateDiagnosis
  };
}
