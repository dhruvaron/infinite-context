export type ProbeCategory =
  | "single_fact"
  | "preference"
  | "assistant_conclusion"
  | "exact_quote"
  | "topic_return"
  | "temporal_ordering"
  | "decision_supersession"
  | "contradiction"
  | "multi_hop"
  | "absent_evidence"
  | "interference";

export interface EvaluationMessage {
  id: string;
  sequence: number;
  role: "user" | "assistant";
  content: string;
  tokenCount: number;
  topic: string;
  createdAt: string;
}

export interface EvaluationProbe {
  id: string;
  checkpoint: number;
  category: ProbeCategory;
  question: string;
  acceptableAnswers: string[];
  expectedEvidenceIds: string[];
  expectedCurrentValue: string | null;
  shouldRefuseForMissingEvidence: boolean;
  deterministic: boolean;
  notes: string;
}

export interface EvaluationDataset {
  id: string;
  name: string;
  version: string;
  seed: number;
  generatorHash: string;
  checkpoints: number[];
  messages: EvaluationMessage[];
  probes: EvaluationProbe[];
  license: string;
  provenance: string;
}

export type ControlledBaselineMode =
  | "recent_window"
  | "rolling_summary"
  | "flat_hybrid"
  | "continuum";

export interface BaselineContext {
  mode: ControlledBaselineMode;
  renderedContext: string;
  selectedMessageIds: string[];
  selectedEvidenceIds: string[];
  inputTokens: number;
  metadata: Record<string, unknown>;
}

export interface ControlledModelSettings {
  provider: string;
  model: string;
  reasoning: string;
  totalInputTokens: number;
  outputTokens: number;
  temperature: number;
}

export interface EvaluationUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  extractionTokens: number;
  embeddingTokens: number;
  rerankingTokens: number;
  estimatedCostUsd: number;
}

export interface EvaluationLatency {
  firstTokenMs: number;
  totalResponseMs: number;
  retrievalMs: number;
  rerankingMs: number;
  compilationMs: number;
}

export interface EvaluationRunRecord {
  runId: string;
  datasetId: string;
  probeId: string;
  checkpoint: number;
  repetition: number;
  mode: ControlledBaselineMode;
  settings: ControlledModelSettings;
  answer: string;
  expectedAnswers: string[];
  selectedEvidenceIds: string[];
  expectedEvidenceIds: string[];
  exactAccuracy: number;
  fuzzyAccuracy: number;
  semanticAccuracy: number | null;
  temporalCorrect: boolean | null;
  unsupportedMemory: boolean;
  contradictedEvidence: boolean;
  usage: EvaluationUsage;
  /** Judge tokens/cost are evaluation overhead, not product-operating usage. */
  evaluationOverheadUsage?: EvaluationUsage;
  latency: EvaluationLatency;
  contextMetadata?: Record<string, unknown>;
  judgeMetadata?: { model: string | null; rationale: string | null } | null;
  error: string | null;
  createdAt: string;
}

export interface AggregateMetrics {
  mode: ControlledBaselineMode;
  runs: number;
  answerAccuracy: number;
  retrievalPrecisionAt10: number;
  retrievalRecallAt10: number;
  ndcgAt10: number;
  temporalAccuracy: number;
  unsupportedMemoryRate: number;
  contradictionRate: number;
  cumulativeInputTokens: number;
  cumulativeAllTokens: number;
  cumulativeCostUsd: number;
  medianResponseLatencyMs: number;
  p95RetrievalLatencyMs: number;
  accuracyConfidence95: [number, number];
}
