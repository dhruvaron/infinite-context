import type {
  CandidateSignal,
  QueryClassification,
  RankedCandidate,
  RetrievalGraph
} from "./types.js";
import { tokenize } from "./candidates.js";

export interface GraphExpansionOptions {
  maxSeeds: number;
  maxExpanded: number;
  maxAdjacentPerNode: number;
  minimumSemanticSimilarity: number;
}

function lexicalSimilarity(query: string, content: string): number {
  const queryTokens = new Set(tokenize(query));
  const contentTokens = new Set(tokenize(content));
  if (queryTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of queryTokens) if (contentTokens.has(token)) overlap += 1;
  return overlap / queryTokens.size;
}

export function expandGraphCandidates(
  query: string,
  seeds: readonly RankedCandidate[],
  graph: RetrievalGraph,
  classification: QueryClassification,
  options: Partial<GraphExpansionOptions> = {}
): CandidateSignal[] {
  const maxSeeds = options.maxSeeds ?? 8;
  const maxExpanded = options.maxExpanded ?? 30;
  const maxAdjacentPerNode = options.maxAdjacentPerNode ?? 256;
  const minimumSimilarity = options.minimumSemanticSimilarity ?? 0.08;
  const maxHops = classification.relationshipQuestion ? 2 : 1;
  const seedIds = new Set(seeds.map((candidate) => candidate.id));
  const visited = new Set(seedIds);
  const queue = seeds.slice(0, maxSeeds).map((candidate) => ({
    id: candidate.id,
    hop: 0,
    seedScore: candidate.fusedScore
  }));
  const expanded = new Map<string, CandidateSignal>();
  while (queue.length > 0 && expanded.size < maxExpanded) {
    const item = queue.shift()!;
    if (item.hop >= maxHops) continue;
    const adjacent = graph.getAdjacent(item.id, maxAdjacentPerNode);
    for (const edge of adjacent) {
      const nextId = edge.source === item.id ? edge.target : edge.source;
      if (visited.has(nextId)) continue;
      visited.add(nextId);
      const document = graph.getDocument(nextId);
      if (!document) continue;
      const similarity = lexicalSimilarity(query, `${document.title} ${document.content}`);
      const hop = item.hop + 1;
      const isRelationshipBridge =
        classification.relationshipQuestion && hop < maxHops;
      const requiredSimilarity = classification.relationshipQuestion
        ? minimumSimilarity / 2
        : minimumSimilarity;
      if (similarity < requiredSimilarity && !isRelationshipBridge) continue;
      const score =
        item.seedScore * Math.pow(0.65, hop) * Math.max(similarity, 0.15) *
        (edge.status === "current" ? 1 : 0.8);
      expanded.set(nextId, {
        document,
        channel: "graph",
        score,
        reason: `${hop}-hop ${edge.type} edge; semantic similarity ${similarity.toFixed(3)}`
      });
      queue.push({ id: nextId, hop, seedScore: item.seedScore });
      if (expanded.size >= maxExpanded) break;
    }
  }
  return [...expanded.values()].sort(
    (a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id)
  );
}
