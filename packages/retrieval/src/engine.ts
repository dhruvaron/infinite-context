import { randomUUID } from "node:crypto";

import type { RetrievalTrace } from "@continuum/contracts";

import { generateCandidateRankings, type CandidateGenerationRequest, type CandidateIndex } from "./candidates.js";
import { classifyQuery, type QueryClassifierFallback } from "./classification.js";
import { reciprocalRankFusion } from "./fusion.js";
import { expandGraphCandidates } from "./graph.js";
import { rerankCandidates, type StructuredReranker } from "./reranker.js";
import type {
  RetrievalFeatureFlags,
  RetrievalGraph,
  RetrievalResult
} from "./types.js";

export interface RetrievalEngineRequest {
  runId: string;
  query: string;
  queryEmbedding: number[] | null;
  queryEmbeddingModelId: string | null;
  now: string;
  scopeId: string;
  activeTopicIds: string[];
  limit: number;
  modelContextTokens: number;
  reservedOutputTokens: number;
  instructionTokens: number;
  recentTurnTokens: number;
  evidenceTokenBudget: number;
}

export class RetrievalEngine {
  constructor(
    private readonly index: CandidateIndex,
    private readonly graph: RetrievalGraph,
    private readonly reranker: StructuredReranker,
    private readonly classifierFallback: QueryClassifierFallback | null,
    private readonly flags: RetrievalFeatureFlags
  ) {}

  async retrieve(request: RetrievalEngineRequest): Promise<RetrievalResult> {
    const started = performance.now();
    const classification = await classifyQuery(request.query, this.classifierFallback);
    const candidateRequest: CandidateGenerationRequest = {
      query: request.query,
      queryEmbedding: request.queryEmbedding,
      queryEmbeddingModelId: request.queryEmbeddingModelId,
      classification,
      now: request.now,
      scopeId: request.scopeId,
      activeTopicIds: request.activeTopicIds,
      limitPerChannel: Math.max(request.limit * 3, 30)
    };
    const rankings = await generateCandidateRankings(this.index, candidateRequest, this.flags);
    let candidates = reciprocalRankFusion(rankings, classification, {
      now: request.now,
      maxResults: Math.max(request.limit * 3, 30),
      applyTemporalFeatures: this.flags.temporal
    });
    if (this.flags.graph) {
      const graph = expandGraphCandidates(
        request.query,
        candidates,
        this.graph,
        classification
      ).filter(
        (candidate) =>
          this.flags.topicPages || candidate.document.type !== "topic"
      );
      if (graph.length > 0) {
        rankings.graph = graph;
        candidates = reciprocalRankFusion(rankings, classification, {
          now: request.now,
          maxResults: Math.max(request.limit * 3, 30),
          applyTemporalFeatures: this.flags.temporal
        });
      }
    }
    if (this.flags.reranking && candidates.length > 0) {
      candidates = await rerankCandidates(
        request.query,
        classification,
        candidates,
        this.reranker,
        30
      );
    }
    const selected = candidates.slice(0, request.limit).map((candidate) => ({
      ...candidate,
      selected: true
    }));
    const selectedIds = new Set(selected.map((candidate) => candidate.id));
    const traced = candidates.map((candidate) => ({
      ...candidate,
      selected: selectedIds.has(candidate.id)
    }));
    const trace: RetrievalTrace = {
      id: randomUUID(),
      runId: request.runId,
      query: request.query,
      classifications: classification.classes,
      candidates: traced.map((candidate) => ({
        id: candidate.id,
        type: candidate.type,
        title: candidate.title,
        excerpt: candidate.excerpt,
        lexicalScore: candidate.lexicalScore,
        vectorScore: candidate.vectorScore,
        graphScore: candidate.graphScore,
        temporalScore: candidate.temporalScore,
        fusedScore: candidate.fusedScore,
        rerankScore: candidate.rerankScore,
        selected: candidate.selected,
        reason: candidate.reason,
        sourceIds: candidate.sourceIds
      })),
      selectedIds: selected.map((candidate) => candidate.id),
      tokenBudget: {
        modelContext: request.modelContextTokens,
        reservedOutput: request.reservedOutputTokens,
        instructions: request.instructionTokens,
        recentTurns: request.recentTurnTokens,
        evidence: request.evidenceTokenBudget
      },
      latencyMs: performance.now() - started,
      createdAt: request.now
    };
    return { classification, candidates: traced, trace };
  }
}
