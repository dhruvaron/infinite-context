import type {
  CandidateChannel,
  CandidateRankings,
  QueryClassification,
  RankedCandidate
} from "./types.js";

export interface FusionOptions {
  rrfK: number;
  channelWeights: Partial<Record<CandidateChannel, number>>;
  now: string;
  maxResults: number;
  applyTemporalFeatures: boolean;
}

const DEFAULT_WEIGHTS: Record<CandidateChannel, number> = {
  lexical: 1,
  vector: 1,
  recency: 0.35,
  entity: 0.8,
  active_topic: 0.55,
  pinned: 1.2,
  temporal: 1,
  graph: 0.7
};

function featureMultiplier(
  candidate: RankedCandidate["document"],
  classification: QueryClassification,
  now: string,
  applyTemporalFeatures: boolean
): { multiplier: number; reasons: string[] } {
  let multiplier = 1;
  const reasons: string[] = [];
  const authority = Math.max(0, Math.min(1, candidate.authority));
  const confidence = Math.max(0, Math.min(1, candidate.confidence));
  multiplier *= 0.75 + authority * 0.25;
  multiplier *= 0.75 + confidence * 0.25;
  if (candidate.sourceIds.length > 1) {
    multiplier *= Math.min(1.15, 1 + candidate.sourceIds.length * 0.025);
    reasons.push("multiple evidence sources");
  }
  const isExpired =
    candidate.freshnessExpiresAt !== null &&
    Date.parse(candidate.freshnessExpiresAt) <= Date.parse(now);
  if (applyTemporalFeatures && classification.timeIntent === "current") {
    if (candidate.status === "current") multiplier *= 1.25;
    if (candidate.status === "superseded" || candidate.status === "historical") {
      multiplier *= 0.2;
      reasons.push("historical evidence demoted for current query");
    }
    if (candidate.status === "expired" || isExpired) {
      multiplier *= 0.1;
      reasons.push("stale evidence demoted for current query");
    }
  }
  if (applyTemporalFeatures && classification.timeIntent === "historical") {
    if (candidate.status === "historical" || candidate.status === "superseded") {
      multiplier *= 1.35;
      reasons.push("historical evidence matches query intent");
    }
    if (candidate.status === "current") multiplier *= 0.8;
  }
  if (applyTemporalFeatures && candidate.status === "conflicted") {
    multiplier *= 1.05;
    reasons.push("conflict retained for cautious response");
  }
  return { multiplier, reasons };
}

export function reciprocalRankFusion(
  rankings: CandidateRankings,
  classification: QueryClassification,
  options: Partial<FusionOptions> & Pick<FusionOptions, "now">
): RankedCandidate[] {
  const rrfK = options.rrfK ?? 60;
  const maxResults = options.maxResults ?? 100;
  const channelWeights = { ...DEFAULT_WEIGHTS, ...options.channelWeights };
  const aggregates = new Map<
    string,
    {
      document: RankedCandidate["document"];
      score: number;
      componentScores: RankedCandidate["componentScores"];
      reasons: string[];
    }
  >();
  for (const [channel, values] of Object.entries(rankings) as Array<
    [CandidateChannel, NonNullable<CandidateRankings[CandidateChannel]>]
  >) {
    values.forEach((signal, index) => {
      const aggregate = aggregates.get(signal.document.id) ?? {
        document: signal.document,
        score: 0,
        componentScores: {},
        reasons: []
      };
      const contribution = (channelWeights[channel] ?? 1) / (rrfK + index + 1);
      aggregate.score += contribution;
      aggregate.componentScores[channel] = signal.score;
      aggregate.reasons.push(`${channel}: ${signal.reason}`);
      aggregates.set(signal.document.id, aggregate);
    });
  }
  const sorted = [...aggregates.values()]
    .map((aggregate) => {
      const features = featureMultiplier(
        aggregate.document,
        classification,
        options.now,
        options.applyTemporalFeatures ?? true
      );
      return {
        ...aggregate,
        score: aggregate.score * features.multiplier,
        reasons: [...aggregate.reasons, ...features.reasons]
      };
    })
    .sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id))
    .slice(0, maxResults);
  return sorted.map((aggregate, index) => ({
    id: aggregate.document.id,
    type: aggregate.document.type,
    title: aggregate.document.title,
    excerpt: aggregate.document.content,
    lexicalScore: aggregate.componentScores.lexical ?? null,
    vectorScore: aggregate.componentScores.vector ?? null,
    graphScore: aggregate.componentScores.graph ?? null,
    temporalScore: aggregate.componentScores.temporal ?? null,
    fusedScore: aggregate.score,
    rerankScore: null,
    selected: false,
    reason: aggregate.reasons.join("; "),
    sourceIds: aggregate.document.sourceIds,
    document: aggregate.document,
    componentScores: aggregate.componentScores,
    componentReasons: aggregate.reasons,
    rank: index + 1
  }));
}
