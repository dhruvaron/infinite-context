import type {
  AggregateMetrics,
  ControlledBaselineMode,
  EvaluationRunRecord
} from "./types.js";

export function normalizeAnswer(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function levenshtein(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  let previous = right.map((_, index) => index + 1);
  previous.unshift(0);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1]! + 1,
        previous[column]! + 1,
        previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length] ?? left.length;
}

export function scoreAnswer(
  answer: string,
  acceptableAnswers: readonly string[]
): { exact: number; fuzzy: number } {
  const actual = normalizeAnswer(answer);
  let exact = 0;
  let fuzzy = 0;
  for (const expectedValue of acceptableAnswers) {
    const expected = normalizeAnswer(expectedValue);
    if (actual === expected || actual.includes(expected)) exact = 1;
    const maxLength = Math.max(actual.length, expected.length, 1);
    fuzzy = Math.max(fuzzy, 1 - levenshtein(actual, expected) / maxLength);
  }
  return { exact, fuzzy: Math.max(0, fuzzy) };
}

export function retrievalMetrics(
  selected: readonly string[],
  relevant: readonly string[],
  k = 10,
  candidateEvidenceGroups?: readonly (readonly string[])[]
): { precision: number; recall: number; ndcg: number } {
  const expected = new Set(relevant);
  if (candidateEvidenceGroups !== undefined) {
    const topGroups = candidateEvidenceGroups.slice(0, k);
    if (expected.size === 0) {
      return {
        precision: topGroups.length === 0 ? 1 : 0,
        recall: 1,
        ndcg: topGroups.length === 0 ? 1 : 0
      };
    }
    const relevantCandidates = candidateEvidenceGroups.map((group) =>
      group.some((id) => expected.has(id))
    );
    const topRelevance = relevantCandidates.slice(0, k);
    const relevantTopCandidates = topRelevance.filter(Boolean).length;
    const coveredExpected = new Set(
      topGroups.flat().filter((id) => expected.has(id))
    );
    const dcg = topRelevance.reduce((sum, isRelevant, index) =>
      sum + (isRelevant ? 1 / Math.log2(index + 2) : 0), 0);
    const idealRelevantCandidates = Math.min(
      k,
      relevantCandidates.filter(Boolean).length
    );
    let ideal = 0;
    for (let index = 0; index < idealRelevantCandidates; index += 1) {
      ideal += 1 / Math.log2(index + 2);
    }
    return {
      precision: topGroups.length === 0 ? 0 : relevantTopCandidates / topGroups.length,
      recall: coveredExpected.size / expected.size,
      ndcg: ideal === 0 ? 0 : dcg / ideal
    };
  }

  const top = selected.slice(0, k);
  if (expected.size === 0) {
    return { precision: top.length === 0 ? 1 : 0, recall: 1, ndcg: top.length === 0 ? 1 : 0 };
  }
  const hits = top.filter((id) => expected.has(id)).length;
  let dcg = 0;
  top.forEach((id, index) => {
    if (expected.has(id)) dcg += 1 / Math.log2(index + 2);
  });
  let ideal = 0;
  for (let index = 0; index < Math.min(k, expected.size); index += 1) {
    ideal += 1 / Math.log2(index + 2);
  }
  return {
    precision: top.length === 0 ? 0 : hits / top.length,
    recall: hits / expected.size,
    ndcg: ideal === 0 ? 0 : dcg / ideal
  };
}

function candidateEvidenceGroups(value: unknown): string[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const groups: string[][] = [];
  for (const group of value) {
    if (!Array.isArray(group) || group.some((id) => typeof id !== "string")) return undefined;
    groups.push([...new Set(group as string[])]);
  }
  return groups;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * Math.max(0, Math.min(1, p));
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

function confidence95(values: readonly number[]): [number, number] {
  if (values.length === 0) return [0, 0];
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length === 1) return [mean, mean];
  const variance =
    values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) /
    (values.length - 1);
  const margin = 1.96 * Math.sqrt(variance / values.length);
  return [Math.max(0, mean - margin), Math.min(1, mean + margin)];
}

export function aggregateRuns(
  mode: ControlledBaselineMode,
  runs: readonly EvaluationRunRecord[]
): AggregateMetrics {
  const selected = runs.filter((run) => run.mode === mode && run.error === null);
  const accuracy = selected.map((run) => run.semanticAccuracy ?? Math.max(run.exactAccuracy, run.fuzzyAccuracy));
  const retrieval = selected.map((run) =>
    retrievalMetrics(
      run.selectedEvidenceIds,
      run.expectedEvidenceIds,
      10,
      candidateEvidenceGroups(run.contextMetadata?.selectedCandidateEvidenceIds)
    )
  );
  const temporal = selected.filter((run) => run.temporalCorrect !== null);
  const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
  const average = (values: readonly number[]): number =>
    values.length === 0 ? 0 : sum(values) / values.length;
  return {
    mode,
    runs: selected.length,
    answerAccuracy: average(accuracy),
    retrievalPrecisionAt10: average(retrieval.map((value) => value.precision)),
    retrievalRecallAt10: average(retrieval.map((value) => value.recall)),
    ndcgAt10: average(retrieval.map((value) => value.ndcg)),
    temporalAccuracy: average(temporal.map((run) => Number(run.temporalCorrect))),
    unsupportedMemoryRate: average(selected.map((run) => Number(run.unsupportedMemory))),
    contradictionRate: average(selected.map((run) => Number(run.contradictedEvidence))),
    cumulativeInputTokens: sum(selected.map((run) => run.usage.inputTokens)),
    cumulativeAllTokens: sum(
      selected.map(
        (run) =>
          run.usage.inputTokens +
          run.usage.outputTokens +
          run.usage.extractionTokens +
          run.usage.embeddingTokens +
          run.usage.rerankingTokens
      )
    ),
    cumulativeCostUsd: sum(selected.map((run) => run.usage.estimatedCostUsd)),
    medianResponseLatencyMs: percentile(selected.map((run) => run.latency.totalResponseMs), 0.5),
    p95RetrievalLatencyMs: percentile(selected.map((run) => run.latency.retrievalMs), 0.95),
    accuracyConfidence95: confidence95(accuracy)
  };
}

export function relativeImprovement(value: number, baseline: number): number {
  if (baseline === 0) return value > 0 ? Number.POSITIVE_INFINITY : 0;
  return (value - baseline) / baseline;
}
