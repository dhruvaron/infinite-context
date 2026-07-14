import type { Claim, ConversationEvent, GraphEdge, TopicPage } from "@continuum/contracts";
import { ContinuumDatabase } from "@continuum/database";
import { serializedToolEvidenceContainsSensitiveContent } from "@continuum/tools";
import {
  InMemoryCandidateIndex,
  type CandidateDocument,
  type CandidateGenerationRequest,
  type CandidateIndex,
  type CandidateSignal,
  type RetrievalGraph
} from "@continuum/retrieval";

function approximateTokens(value: string): number { return Math.max(1, Math.ceil(value.length / 4)); }

function sourceKind(type: unknown): CandidateDocument["sourceKind"] {
  if (type === "workspace") return "workspace";
  if (type === "web") return "web";
  if (type === "tool") return "tool";
  return "attachment";
}

function eventDocument(event: ConversationEvent, pinned: boolean): CandidateDocument {
  return {
    id: event.id,
    type: "event",
    sourceKind: event.role === "tool" ? "tool" : "conversation",
    title: `${event.role === "user" ? "User" : event.role === "assistant" ? "Assistant" : event.role} · turn ${event.sequence}`,
    content: event.content,
    sourceIds: [event.id],
    observedAt: event.createdAt,
    validFrom: event.createdAt,
    validTo: null,
    status: event.status === "complete" ? "current" : "historical",
    confidence: event.role === "user" ? 1 : event.role === "assistant" ? 0.72 : 0.8,
    authority: event.role === "user" ? 1 : event.role === "assistant" ? 0.6 : 0.8,
    freshnessExpiresAt: null,
    scopeId: "global",
    topicId: null,
    entityNames: [],
    pinned,
    embedding: null,
    tokenCount: approximateTokens(event.content),
    rawSource: true,
    sensitiveContent: event.role === "tool" && serializedToolEvidenceContainsSensitiveContent(event.content)
  };
}

function claimDocument(claim: Claim, pinned: boolean): CandidateDocument {
  const content = `${claim.subject} ${claim.predicate}: ${claim.value}`;
  return {
    id: claim.id,
    type: "claim",
    sourceKind: "conversation",
    title: `${claim.subject} ${claim.predicate}`,
    content,
    sourceIds: claim.sourceIds,
    observedAt: claim.observedAt,
    validFrom: claim.validFrom,
    validTo: claim.validTo,
    status: claim.status,
    confidence: claim.confidence,
    authority: claim.sourceRole === "user" ? 1 : claim.sourceRole === "tool" ? 0.85 : 0.65,
    freshnessExpiresAt: claim.freshnessExpiresAt,
    scopeId: "global",
    topicId: claim.topicId,
    entityNames: [claim.subject],
    pinned,
    embedding: null,
    tokenCount: approximateTokens(content),
    rawSource: false
  };
}

function topicDocument(topic: TopicPage & { markdown?: string }, pinned: boolean): CandidateDocument {
  const content = topic.markdown ?? `${topic.summary}\n${topic.currentState}\n${topic.history}`;
  return {
    id: topic.id,
    type: "topic",
    sourceKind: "wiki",
    title: topic.title,
    content,
    // One source can support several compiled sections. Candidate authority is
    // based on independent sources, not repeated provenance rows.
    sourceIds: [...new Set(topic.sourceIds)],
    observedAt: topic.updatedAt,
    validFrom: null,
    validTo: null,
    status: "current",
    confidence: topic.userAuthored ? 1 : 0.82,
    authority: topic.userAuthored ? 1 : 0.75,
    freshnessExpiresAt: null,
    scopeId: "global",
    topicId: topic.id,
    entityNames: [topic.title],
    pinned,
    embedding: null,
    tokenCount: approximateTokens(content),
    rawSource: false
  };
}

function ftsQuery(query: string): string {
  return (query.normalize("NFKC").match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 24) ?? []).map((token) => `"${token.replaceAll('"', '""')}"*`).join(" OR ");
}

function stringArray(value: unknown): string[] {
  try {
    const parsed: unknown = Array.isArray(value) ? value : JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  }
  catch { return []; }
}

export const SQLITE_GRAPH_ADJACENCY_MAX = 1_000;

export class SqliteCandidateIndex implements CandidateIndex, RetrievalGraph {
  readonly #database: ContinuumDatabase;

  constructor(database: ContinuumDatabase) { this.#database = database; }

  getAdjacent(id: string, requestedLimit: number): GraphEdge[] {
    const limit = Math.max(1, Math.min(SQLITE_GRAPH_ADJACENCY_MAX, Math.floor(requestedLimit)));
    const sourceRows = this.#database.connection.prepare(`
      SELECT * FROM edges INDEXED BY edges_source_created_idx
      WHERE source_id = ? ORDER BY created_at DESC, id ASC LIMIT ?
    `).all(id, limit) as Array<Record<string, unknown>>;
    const targetRows = this.#database.connection.prepare(`
      SELECT * FROM edges INDEXED BY edges_target_created_idx
      WHERE target_id = ? AND source_id <> ? ORDER BY created_at DESC, id ASC LIMIT ?
    `).all(id, id, limit) as Array<Record<string, unknown>>;
    const stored = [...sourceRows, ...targetRows].map((row) => {
      const status: "current" | "historical" | "conflicted" = row.status === "historical" ? "historical" : row.status === "conflicted" ? "conflicted" : "current";
      return {
        edge: {
          id: String(row.id), source: String(row.source_id), target: String(row.target_id), type: String(row.edge_type),
          ...(row.label ? { label: String(row.label) } : {}), status,
          evidenceIds: stringArray(row.evidence_json)
        } satisfies GraphEdge,
        sortAt: String(row.created_at)
      };
    });
    const topicClaims = (this.#database.connection.prepare(`
      SELECT c.id, c.status, c.observed_at,
        COALESCE((SELECT json_group_array(cs.source_id) FROM claim_sources cs
          LEFT JOIN events source_event ON source_event.id = cs.source_id
          WHERE cs.claim_id = c.id AND (source_event.id IS NULL OR source_event.active = 1)), '[]') AS source_ids
      FROM claims c INDEXED BY claims_topic_observed_idx
      WHERE c.topic_id = ? AND EXISTS (
        SELECT 1 FROM claim_sources active_source
        LEFT JOIN events active_event ON active_event.id = active_source.source_id
        WHERE active_source.claim_id = c.id AND (active_event.id IS NULL OR active_event.active = 1)
      )
      ORDER BY c.observed_at DESC, c.id ASC LIMIT ?
    `).all(id, limit) as Array<Record<string, unknown>>).map((row) => ({
      edge: {
        id: String(row.id), source: id, target: String(row.id), type: "contains",
        status: row.status === "conflicted" ? "conflicted" as const : ["historical", "superseded", "expired"].includes(String(row.status)) ? "historical" as const : "current" as const,
        evidenceIds: stringArray(row.source_ids)
      } satisfies GraphEdge,
      sortAt: String(row.observed_at)
    }));
    const claim = this.#database.getClaim(id, false);
    const claimTopic = claim?.topicId ? [{
      edge: {
        id: claim.id,
        source: claim.topicId,
        target: claim.id,
        type: "contains",
        status: claim.status === "conflicted" ? "conflicted" as const : ["historical", "superseded", "expired"].includes(claim.status) ? "historical" as const : "current" as const,
        evidenceIds: claim.sourceIds
      } satisfies GraphEdge,
      sortAt: claim.observedAt
    }] : [];
    const deduplicated = new Map<string, { edge: GraphEdge; sortAt: string }>();
    for (const candidate of [...stored, ...topicClaims, ...claimTopic]) {
      const existing = deduplicated.get(candidate.edge.id);
      if (!existing || candidate.sortAt > existing.sortAt) deduplicated.set(candidate.edge.id, candidate);
    }
    return [...deduplicated.values()]
      .sort((left, right) => right.sortAt.localeCompare(left.sortAt) || left.edge.id.localeCompare(right.edge.id))
      .slice(0, limit)
      .map((candidate) => candidate.edge);
  }

  private pinnedIds(): Set<string> {
    return new Set(this.#database.listPins().map((pin) => String(pin.object_id)));
  }

  getDocument(id: string): CandidateDocument | null {
    const pinned = this.pinnedIds().has(id);
    const event = this.#database.getEvent(id);
    if (event) return event.active && event.status === "complete" ? eventDocument(event, pinned) : null;
    const claim = this.#database.getClaim(id, false);
    if (claim) return claimDocument(claim, pinned);
    const topic = this.#database.getTopic(id);
    if (topic) {
      const stale = this.#database.connection.prepare(`
        SELECT 1 FROM topic_pages tp
        JOIN topic_page_revisions tpr ON tpr.topic_id = tp.id AND tpr.revision_number = tp.active_revision
        JOIN page_section_sources pss ON pss.revision_id = tpr.id
        JOIN events e ON e.id = pss.source_id
        WHERE tp.id = ? AND tpr.author_type <> 'user' AND e.role = 'assistant' AND e.active = 0 LIMIT 1
      `).get(id);
      if (stale) return null;
      return topicDocument(topic, pinned);
    }
    const chunk = this.#database.connection.prepare(`
      SELECT sc.*, s.type AS source_type, s.title, s.created_at AS source_created_at,
        s.retrieved_at, s.freshness_class, s.provenance_json
      FROM source_chunks sc JOIN sources s ON s.id = sc.source_id WHERE sc.id = ?
    `).get(id) as Record<string, unknown> | undefined;
    if (!chunk) return null;
    const content = String(chunk.text_content);
    let freshnessExpiresAt: string | null = null;
    try {
      const provenance = JSON.parse(String(chunk.provenance_json)) as Record<string, unknown>;
      if (typeof provenance.freshnessExpiresAt === "string" && Number.isFinite(Date.parse(provenance.freshnessExpiresAt))) freshnessExpiresAt = provenance.freshnessExpiresAt;
    } catch { /* historical source provenance may not be JSON */ }
    return {
      id,
      type: "chunk",
      sourceKind: sourceKind(chunk.source_type),
      title: String(chunk.title),
      content,
      sourceIds: [id, String(chunk.source_id)],
      observedAt: String(chunk.retrieved_at ?? chunk.source_created_at),
      validFrom: null,
      validTo: null,
      status: "current",
      confidence: 0.9,
      authority: chunk.source_type === "workspace" ? 0.95 : 0.85,
      freshnessExpiresAt,
      scopeId: "global",
      topicId: null,
      entityNames: [],
      pinned,
      embedding: null,
      tokenCount: Number(chunk.token_count) || approximateTokens(content),
      rawSource: true
    };
  }

  private documents(ids: Iterable<string>): CandidateDocument[] {
    const documents: CandidateDocument[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const document = this.getDocument(id);
      if (document) documents.push(document);
    }
    return documents;
  }

  async lexical(request: CandidateGenerationRequest): Promise<CandidateSignal[]> {
    const ids = this.#database.search(request.query, request.limitPerChannel * 2, { status: "current" }).map((result) => result.id);
    const query = ftsQuery(request.query);
    if (query) {
      const chunks = this.#database.connection.prepare("SELECT chunk_id FROM chunk_fts WHERE chunk_fts MATCH ? ORDER BY bm25(chunk_fts) LIMIT ?").all(query, request.limitPerChannel * 2) as Array<{ chunk_id: string }>;
      ids.push(...chunks.map((chunk) => chunk.chunk_id));
    }
    return new InMemoryCandidateIndex(this.documents(ids)).lexical(request);
  }

  async vector(request: CandidateGenerationRequest): Promise<CandidateSignal[]> {
    if (!request.queryEmbedding || !request.queryEmbeddingModelId) return [];
    const search = this.#database.searchVectors(
      request.queryEmbedding,
      request.queryEmbeddingModelId,
      Math.min(1_000, request.limitPerChannel * 8)
    );
    const requestedTypes = new Set(request.classification.requestedSourceTypes);
    const signals: CandidateSignal[] = [];
    const seen = new Set<string>();
    for (const match of search.matches) {
      if (match.score <= 0 || seen.has(match.sourceId)) continue;
      const document = this.getDocument(match.sourceId);
      if (!document || document.scopeId !== request.scopeId) continue;
      if (requestedTypes.size > 0 && !requestedTypes.has(document.type) && !requestedTypes.has(document.sourceKind)) continue;
      seen.add(match.sourceId);
      signals.push({
        document,
        channel: "vector",
        score: match.score,
        reason: search.mode === "sqlite-vec"
          ? `native sqlite-vec cosine; examined ${search.rowsExamined}/${search.corpusRows} vectors`
          : `degraded bounded cosine; examined ${search.rowsExamined}/${search.corpusRows} vectors (limit ${search.fallbackLimit}${search.corpusTruncated ? ", truncated" : ""})`
      });
      if (signals.length >= request.limitPerChannel) break;
    }
    return signals.sort((left, right) => right.score - left.score || left.document.id.localeCompare(right.document.id));
  }

  async recency(request: CandidateGenerationRequest): Promise<CandidateSignal[]> {
    const eventIds = (this.#database.connection.prepare("SELECT id FROM events WHERE active = 1 AND status = 'complete' ORDER BY created_at DESC LIMIT ?").all(request.limitPerChannel * 3) as Array<{ id: string }>).map((row) => row.id);
    const claimIds = (this.#database.connection.prepare("SELECT id FROM claims ORDER BY observed_at DESC LIMIT ?").all(request.limitPerChannel * 2) as Array<{ id: string }>).map((row) => row.id);
    const topicIds = (this.#database.connection.prepare("SELECT id FROM topic_pages ORDER BY updated_at DESC LIMIT ?").all(request.limitPerChannel) as Array<{ id: string }>).map((row) => row.id);
    return new InMemoryCandidateIndex(this.documents([...eventIds, ...claimIds, ...topicIds])).recency(request);
  }

  async entity(request: CandidateGenerationRequest): Promise<CandidateSignal[]> {
    if (!request.classification.entities.length) return [];
    const ids: string[] = [];
    for (const entity of request.classification.entities.slice(0, 10)) {
      const pattern = `%${entity.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      ids.push(...(this.#database.connection.prepare("SELECT id FROM claims WHERE subject LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\' LIMIT ?").all(pattern, pattern, request.limitPerChannel) as Array<{ id: string }>).map((row) => row.id));
      ids.push(...(this.#database.connection.prepare("SELECT id FROM topic_pages WHERE title LIKE ? ESCAPE '\\' LIMIT ?").all(pattern, request.limitPerChannel) as Array<{ id: string }>).map((row) => row.id));
    }
    return new InMemoryCandidateIndex(this.documents(ids)).entity(request);
  }

  async activeTopic(request: CandidateGenerationRequest): Promise<CandidateSignal[]> {
    return new InMemoryCandidateIndex(this.documents(request.activeTopicIds)).activeTopic(request);
  }

  async pinned(request: CandidateGenerationRequest): Promise<CandidateSignal[]> {
    return new InMemoryCandidateIndex(this.documents(this.pinnedIds())).pinned(request);
  }

  async temporal(request: CandidateGenerationRequest): Promise<CandidateSignal[]> {
    const ids = (this.#database.connection.prepare("SELECT id FROM claims WHERE valid_from IS NOT NULL OR valid_to IS NOT NULL OR status != 'current' ORDER BY observed_at DESC LIMIT ?").all(request.limitPerChannel * 3) as Array<{ id: string }>).map((row) => row.id);
    return new InMemoryCandidateIndex(this.documents(ids)).temporal(request);
  }
}
