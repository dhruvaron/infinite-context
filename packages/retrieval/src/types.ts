import type {
  GraphEdge,
  RetrievalTrace
} from "@continuum/contracts";

type ContractRetrievalCandidate = RetrievalTrace["candidates"][number];

export type QueryClass =
  | "conversational"
  | "factual_recall"
  | "temporal_recall"
  | "exact_lookup"
  | "document_question"
  | "web_question"
  | "tool_task";

export type TimeIntent = "current" | "historical" | "range" | "unspecified";

export type CandidateChannel =
  | "lexical"
  | "vector"
  | "recency"
  | "entity"
  | "active_topic"
  | "pinned"
  | "temporal"
  | "graph";

export interface QueryClassification {
  classes: QueryClass[];
  timeIntent: TimeIntent;
  dateRange: { from: string | null; to: string | null } | null;
  entities: string[];
  requestedSourceTypes: string[];
  relationshipQuestion: boolean;
  confidence: number;
  usedModelFallback: boolean;
}

export interface CandidateDocument {
  id: string;
  type: "event" | "chunk" | "claim" | "topic" | "source" | "artifact";
  sourceKind:
    | "conversation"
    | "attachment"
    | "workspace"
    | "web"
    | "tool"
    | "wiki";
  title: string;
  content: string;
  sourceIds: string[];
  observedAt: string;
  validFrom: string | null;
  validTo: string | null;
  status: "current" | "historical" | "superseded" | "conflicted" | "expired";
  confidence: number;
  authority: number;
  freshnessExpiresAt: string | null;
  scopeId: string;
  topicId: string | null;
  entityNames: string[];
  pinned: boolean;
  embedding: number[] | null;
  tokenCount: number;
  rawSource: boolean;
  /** Direct content from an explicitly approved likely-secret read. */
  sensitiveContent?: boolean;
}

export interface CandidateSignal {
  document: CandidateDocument;
  channel: CandidateChannel;
  score: number;
  reason: string;
}

export type CandidateRankings = Partial<
  Record<CandidateChannel, CandidateSignal[]>
>;

export interface RankedCandidate extends ContractRetrievalCandidate {
  document: CandidateDocument;
  componentScores: Partial<Record<CandidateChannel, number>>;
  componentReasons: string[];
  rank: number;
}

export interface RetrievalFeatureFlags {
  lexical: boolean;
  vector: boolean;
  recency: boolean;
  entity: boolean;
  activeTopic: boolean;
  pinned: boolean;
  temporal: boolean;
  graph: boolean;
  reranking: boolean;
  topicPages: boolean;
}

export const FULL_RETRIEVAL_FEATURES: RetrievalFeatureFlags = {
  lexical: true,
  vector: true,
  recency: true,
  entity: true,
  activeTopic: true,
  pinned: true,
  temporal: true,
  graph: true,
  reranking: true,
  topicPages: true
};

export const RETRIEVAL_ABLATIONS: Readonly<
  Record<
    | "no_lexical"
    | "no_vector"
    | "no_reranking"
    | "no_temporal"
    | "no_topic_pages"
    | "no_graph",
    RetrievalFeatureFlags
  >
> = {
  no_lexical: { ...FULL_RETRIEVAL_FEATURES, lexical: false },
  no_vector: { ...FULL_RETRIEVAL_FEATURES, vector: false },
  no_reranking: { ...FULL_RETRIEVAL_FEATURES, reranking: false },
  no_temporal: { ...FULL_RETRIEVAL_FEATURES, temporal: false },
  no_topic_pages: { ...FULL_RETRIEVAL_FEATURES, topicPages: false },
  no_graph: { ...FULL_RETRIEVAL_FEATURES, graph: false }
};

export interface RetrievalGraph {
  /** Returns a deterministic, bounded adjacency page for one node. */
  getAdjacent(id: string, limit: number): GraphEdge[];
  getDocument(id: string): CandidateDocument | null;
}

export interface RetrievalResult {
  classification: QueryClassification;
  candidates: RankedCandidate[];
  trace: RetrievalTrace;
}
