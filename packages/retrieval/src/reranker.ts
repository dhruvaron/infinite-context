import type { QueryClassification, RankedCandidate } from "./types.js";
import { tokenize } from "./candidates.js";

export interface RerankerRequest {
  query: string;
  classification: QueryClassification;
  candidates: Array<{
    id: string;
    title: string;
    excerpt: string;
    fusedScore: number;
    status: string;
  }>;
}
export interface StructuredReranker {
  rerank(request: RerankerRequest): Promise<Array<{ id: string; score: number; reason: string }>>;
}

export async function rerankCandidates(
  query: string,
  classification: QueryClassification,
  candidates: readonly RankedCandidate[],
  reranker: StructuredReranker,
  limit = 30
): Promise<RankedCandidate[]> {
  const head = candidates.slice(0, Math.min(30, limit));
  const scores = await reranker.rerank({
    query,
    classification,
    candidates: head.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      excerpt: candidate.excerpt,
      fusedScore: candidate.fusedScore,
      status: candidate.document.status
    }))
  });
  const byId = new Map(scores.map((score) => [score.id, score]));
  const reranked = head
    .map((candidate) => {
      const score = byId.get(candidate.id);
      return {
        ...candidate,
        rerankScore: score?.score ?? 0,
        reason: score ? `${candidate.reason}; reranker: ${score.reason}` : candidate.reason
      };
    })
    .sort(
      (a, b) =>
        (b.rerankScore ?? 0) - (a.rerankScore ?? 0) ||
        b.fusedScore - a.fusedScore ||
        a.id.localeCompare(b.id)
    );
  return [...reranked, ...candidates.slice(head.length)].map((candidate, index) => ({
    ...candidate,
    rank: index + 1
  }));
}

/** Deterministic fake: useful for fixtures and no-cost regression tests. */
export class LexicalFixtureReranker implements StructuredReranker {
  async rerank(request: RerankerRequest): Promise<Array<{ id: string; score: number; reason: string }>> {
    const query = new Set(tokenize(request.query));
    return request.candidates.map((candidate) => {
      const tokens = new Set(tokenize(`${candidate.title} ${candidate.excerpt}`));
      let overlap = 0;
      for (const token of query) if (tokens.has(token)) overlap += 1;
      return {
        id: candidate.id,
        score: query.size === 0 ? 0 : overlap / query.size,
        reason: "deterministic lexical fixture score"
      };
    });
  }
}
