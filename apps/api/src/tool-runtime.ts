import { realpath, stat } from "node:fs/promises";
import { MAX_PROVIDER_TOOL_RESULT_BYTES } from "@continuum/config";
import { IdSchema, type ConversationEvent, type SearchResult } from "@continuum/contracts";
import { ContinuumDatabase, effectiveClaimStatus, effectiveSourceStatus, uuidv7 } from "@continuum/database";
import type { ProviderToolCall, ProviderToolDefinition } from "@continuum/providers";
import {
  ExecuteCodeTool,
  IsolatedSandbox,
  MemoryToolSession,
  ToolError,
  WorkspaceReader,
  createToolEvidence,
  isLikelySecretPath,
  serializeUntrustedEvidence,
  type MemoryPage,
  type MemoryToolRepository,
  type ToolEvidence,
  type TypedTool,
  type WorkspaceAuthorization,
  type WorkspaceAuthorizationRegistry
} from "@continuum/tools";

const MAX_PERSISTED_TOOL_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PERSISTED_ARGUMENT_BYTES = 128 * 1024;
const DEFAULT_SECRET_GRANT_TTL_MS = 5 * 60_000;

type MemoryResultStatus = "current" | "superseded" | "conflicted" | "historical" | "expired";

interface WorkspaceOverrideIntent {
  hidden: boolean;
  ignored: boolean;
  dependencies: boolean;
  largeFile: boolean;
}

function workspaceOverrideIntent(userRequest: string): WorkspaceOverrideIntent {
  return {
    hidden: /\b(?:hidden|dotfiles?)\b|(?:^|[\s"'`/])\.[A-Za-z0-9_-]+/i.test(userRequest),
    ignored: /\b(?:git[- ]?ignored|ignored files?|ignore rules?)\b/i.test(userRequest),
    dependencies: /\b(?:node_modules|dependencies|dependency files?|vendor directory|build output|dist(?:ribution)? files?)\b/i.test(userRequest),
    largeFile: /\b(?:large|oversized|entire|whole|full)\s+(?:file|document|source)|\b(?:read|open)\s+(?:it\s+)?(?:all|entirely|in full)\b|\b(?:over|larger than)\s+2\s*(?:mb|mib|megabytes?)\b/i.test(userRequest)
  };
}

export function normalizeWorkspaceGrantPath(path: string): string {
  if (!path || path.length > 4_096 || path.includes("\0") || path.includes("\\") || path.startsWith("/")) {
    throw new ToolError("BOUNDARY_VIOLATION", "Secret approval paths must be relative and portable.");
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "..")) throw new ToolError("BOUNDARY_VIOLATION", "Workspace path traversal is not allowed.");
  return segments.filter((segment) => segment && segment !== ".").join("/") || ".";
}

/**
 * Process-local by design: approvals disappear on restart and are atomically
 * consumed before any secret-like file bytes are read.
 */
export class OneUseWorkspaceSecretGrants {
  readonly #grants = new Map<string, { id: string; rootId: string; relativePath: string; expiresAt: string }>();

  grant(rootId: string, rawRelativePath: string, ttlMs = DEFAULT_SECRET_GRANT_TTL_MS) {
    const relativePath = normalizeWorkspaceGrantPath(rawRelativePath);
    if (!isLikelySecretPath(relativePath)) throw new ToolError("INVALID_ARGUMENT", "Only secret-like file paths use this approval flow.");
    this.#prune();
    const grant = { id: uuidv7(), rootId, relativePath, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
    this.#grants.set(this.#key(rootId, relativePath), grant);
    return { ...grant, oneUse: true as const };
  }

  async approve(input: { rootId: string; relativePath: string }): Promise<boolean> {
    this.#prune();
    let relativePath: string;
    try { relativePath = normalizeWorkspaceGrantPath(input.relativePath); }
    catch { return false; }
    const key = this.#key(input.rootId, relativePath);
    const grant = this.#grants.get(key);
    if (!grant) return false;
    // Consume synchronously before returning; concurrent tool calls cannot both
    // observe the same capability.
    this.#grants.delete(key);
    return Date.parse(grant.expiresAt) > Date.now();
  }

  revokeRoot(rootId: string): void {
    for (const [key, grant] of this.#grants) if (grant.rootId === rootId) this.#grants.delete(key);
  }

  clear(): void { this.#grants.clear(); }

  #key(rootId: string, relativePath: string): string { return `${rootId}\0${relativePath}`; }
  #prune(): void {
    const timestamp = Date.now();
    for (const [key, grant] of this.#grants) if (Date.parse(grant.expiresAt) <= timestamp) this.#grants.delete(key);
  }
}

function boundedJson(value: unknown, maximumBytes: number): string {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) <= maximumBytes) return serialized;
  return JSON.stringify({ truncated: true, preview: serialized.slice(0, maximumBytes) });
}

function boundedProviderEvidence(evidence: ToolEvidence, serialized: string): string {
  if (Buffer.byteLength(serialized) <= MAX_PROVIDER_TOOL_RESULT_BYTES) return serialized;
  let contentCharacters = Math.min(evidence.content.length, MAX_PROVIDER_TOOL_RESULT_BYTES);
  while (contentCharacters > 0) {
    const bounded = serializeUntrustedEvidence(createToolEvidence({
      content: evidence.content.slice(0, contentCharacters),
      provenance: evidence.provenance.slice(0, 20),
      truncated: true,
      nextCursor: evidence.nextCursor,
      metadata: { ...evidence.metadata, providerResultLimitReached: true }
    }));
    if (Buffer.byteLength(bounded) <= MAX_PROVIDER_TOOL_RESULT_BYTES) return bounded;
    contentCharacters = Math.floor(contentCharacters / 2);
  }
  return serializeUntrustedEvidence(createToolEvidence({
    content: "The local result exceeded the provider continuation limit. Request a smaller page using the returned cursor.",
    provenance: [],
    truncated: true,
    nextCursor: evidence.nextCursor,
    metadata: { ...evidence.metadata, providerResultLimitReached: true }
  }));
}

function cursorOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number.parseInt(cursor, 10);
  if (!Number.isSafeInteger(value) || value < 0) throw new ToolError("INVALID_ARGUMENT", "The memory cursor is invalid.");
  return value;
}

function nextCursor(offset: number, returned: number, requested: number, total?: number): string | null {
  if (returned < requested || (total !== undefined && offset + returned >= total)) return null;
  return String(offset + returned);
}

function titleForEvent(event: ConversationEvent): string {
  const role = event.role[0]?.toLocaleUpperCase() + event.role.slice(1);
  return `${role} message · turn ${event.sequence}`;
}

class SqliteMemoryToolRepository implements MemoryToolRepository {
  readonly #database: ContinuumDatabase;

  constructor(database: ContinuumDatabase) {
    this.#database = database;
  }

  async searchMemory(input: Parameters<MemoryToolRepository["searchMemory"]>[0], signal?: AbortSignal): Promise<MemoryPage> {
    signal?.throwIfAborted();
    // V1 has exactly one global vault. Preserve the scoped contract now so a
    // provider can never ask for one scope and silently receive another. The
    // scope identifier exposed to tools is the stable vault UUID; future
    // project scopes can narrow this branch without changing the tool shape.
    if (input.filters.scopeId) {
      const vault = this.#database.connection.prepare("SELECT id FROM vaults WHERE scope_id = 'global' LIMIT 1").get() as { id: string } | undefined;
      if (!vault || vault.id !== input.filters.scopeId) return { items: [], nextCursor: null, totalKnown: 0 };
    }
    const offset = cursorOffset(input.cursor);
    const requested = input.limit;
    const onlyRole = input.filters.roles?.length === 1 ? input.filters.roles[0] : undefined;
    const role = onlyRole === "user" || onlyRole === "assistant" || onlyRole === "tool" ? onlyRole : "all";
    const results: SearchResult[] = [];
    const batchSize = 100;
    let scanOffset = offset;
    let hasMore = false;
    search: while (results.length < requested) {
      signal?.throwIfAborted();
      const batch = this.#database.search(input.query, batchSize, {
        offset: scanOffset,
        ...(input.filters.types ? { types: input.filters.types } : {}),
        role: role ?? "all",
        // Claims, topic revisions, raw events, sources, and entities have
        // different exact status vocabularies. Broad SQL buckets cannot
        // represent a request such as `conflicted` or `expired`, so scan the
        // ranked union and apply the exact status below.
        status: "all",
        from: input.filters.from ?? null
      });
      if (batch.length === 0) break;
      for (let index = 0; index < batch.length; index += 1) {
        const result = batch[index]!;
        scanOffset += 1;
        if (input.filters.to && result.timestamp && result.timestamp > input.filters.to) continue;
        if (input.filters.tags?.length && !input.filters.tags.every((tag) => result.tags.some((candidate) => candidate.toLocaleLowerCase() === tag.toLocaleLowerCase()))) continue;
        if (input.filters.roles?.length && result.type === "event") {
          const event = this.#database.getEvent(result.id);
          if (!event || !input.filters.roles.includes(event.role)) continue;
        }
        const exactStatus = this.#statusForResult(result);
        if (input.filters.statuses?.length && !input.filters.statuses.includes(exactStatus)) continue;
        results.push(result);
        if (results.length >= requested) {
          hasMore = index + 1 < batch.length || batch.length === batchSize;
          break search;
        }
      }
      if (batch.length < batchSize) break;
    }
    const items = results.map((result) => {
      const sourceLocation = (result.type === "source" || result.type === "attachment")
        ? this.#openableSourceLocation(result)
        : null;
      return {
        id: result.id,
        type: result.type,
        title: result.title.slice(0, 1_000),
        excerpt: result.snippet.slice(0, 100_000),
        score: result.score,
        sourceIds: this.#sourceIdsForResult(result),
        ...(result.type === "topic" && result.topicRevision
          ? { location: { topicId: result.id, revision: result.topicRevision, ...(result.topicRevisionId ? { revisionId: result.topicRevisionId } : {}) } }
          : sourceLocation
            ? { location: sourceLocation }
            : result.evidenceId
              ? { location: { evidenceId: result.evidenceId } }
              : {}),
        ...(result.timestamp ? { observedAt: result.timestamp } : {}),
        status: this.#statusForResult(result)
      };
    });
    return { items, nextCursor: hasMore ? String(scanOffset) : null };
  }

  async openEvent(input: Parameters<MemoryToolRepository["openEvent"]>[0], signal?: AbortSignal): Promise<MemoryPage> {
    signal?.throwIfAborted();
    const event = this.#database.getEvent(input.eventId);
    if (!event) throw new ToolError("NOT_FOUND", "That conversation event does not exist.");
    const offset = cursorOffset(input.cursor);
    if (offset >= event.content.length) return { items: [], nextCursor: null, totalKnown: event.content.length };
    const maximumCharacters = input.limit * 2_000;
    let end = Math.min(event.content.length, offset + maximumCharacters);
    // Never split a UTF-16 surrogate pair between pages.
    if (end < event.content.length && /[\uD800-\uDBFF]/.test(event.content[end - 1] ?? "") && /[\uDC00-\uDFFF]/.test(event.content[end] ?? "")) end -= 1;
    return {
      items: [{
        id: event.id,
        type: "event",
        title: titleForEvent(event),
        excerpt: event.content.slice(offset, end),
        score: 1,
        sourceIds: [event.id],
        location: { sequence: event.sequence, role: event.role, characterStart: offset, characterEnd: end, totalCharacters: event.content.length },
        observedAt: event.createdAt,
        status: event.active ? "current" : "historical"
      }],
      nextCursor: end < event.content.length ? String(end) : null,
      totalKnown: event.content.length
    };
  }

  async openSource(input: Parameters<MemoryToolRepository["openSource"]>[0], signal?: AbortSignal): Promise<MemoryPage> {
    signal?.throwIfAborted();
    // Accept every stable identifier that search_memory can naturally hand
    // back: the canonical source, its attachment record, or an exact chunk.
    // The response always normalizes provenance to the parent source UUID.
    const resolved = this.#database.connection.prepare(`
      SELECT s.* FROM sources s WHERE s.id = ?
      UNION ALL
      SELECT s.* FROM attachments a JOIN sources s ON s.id = a.source_id WHERE a.id = ?
      UNION ALL
      SELECT s.* FROM source_chunks sc JOIN sources s ON s.id = sc.source_id WHERE sc.id = ?
      LIMIT 1
    `).get(input.sourceId, input.sourceId, input.sourceId) as Record<string, unknown> | undefined;
    const source = resolved;
    if (!source) throw new ToolError("NOT_FOUND", "That source does not exist.");
    const canonicalSourceId = String(source.id);
    const sourceStatus = effectiveSourceStatus(source);
    const offset = cursorOffset(input.cursor);
    const clauses = ["source_id = ?"];
    const parameters: Array<string | number> = [canonicalSourceId];
    for (const key of ["page", "line", "row"] as const) {
      const value = input.location?.[key];
      if (value === undefined) continue;
      // The JSON path is selected from a fixed allowlist above; values remain
      // bound parameters. This keeps exact-source paging inside SQLite and
      // avoids materializing or silently truncating sources over 10k chunks.
      clauses.push(`CAST(json_extract(location_json, '$.${key}') AS INTEGER) = ?`);
      parameters.push(value);
    }
    const where = clauses.join(" AND ");
    const total = Number((this.#database.connection.prepare(`SELECT COUNT(*) AS count FROM source_chunks WHERE ${where}`).get(...parameters) as { count: number }).count);
    const selected = this.#database.connection.prepare(`
      SELECT * FROM source_chunks WHERE ${where}
      ORDER BY ordinal ASC, id ASC LIMIT ? OFFSET ?
    `).all(...parameters, input.limit, offset) as Array<Record<string, unknown>>;
    const type = String(source.type) === "attachment" ? "attachment" as const : "source" as const;
    const items = selected.map((chunk) => {
      let location: Record<string, string | number | boolean> = {};
      try { location = JSON.parse(String(chunk.location_json)) as Record<string, string | number | boolean>; } catch { location = {}; }
      return {
        id: String(chunk.id),
        type,
        title: `${String(source.title).slice(0, 900)} · chunk ${Number(chunk.ordinal) + 1}`,
        excerpt: String(chunk.text_content).slice(0, 100_000),
        score: 1,
        sourceIds: [canonicalSourceId],
        location: { sourceId: canonicalSourceId, chunkId: String(chunk.id), ...location },
        observedAt: String(chunk.created_at),
        status: sourceStatus
      };
    });
    return { items, nextCursor: nextCursor(offset, items.length, input.limit, total), totalKnown: total };
  }

  async getTopicPage(input: Parameters<MemoryToolRepository["getTopicPage"]>[0], signal?: AbortSignal): Promise<MemoryPage> {
    signal?.throwIfAborted();
    const row = this.#database.connection.prepare(`
      SELECT tp.title, tp.active_revision, tpr.id, tpr.revision_number, tpr.markdown, tpr.created_at
      FROM topic_pages tp JOIN topic_page_revisions tpr ON tpr.topic_id = tp.id
      WHERE tp.id = ? AND tpr.revision_number = COALESCE(?, tp.active_revision)
      LIMIT 1
    `).get(input.topicId, input.revision ?? null) as Record<string, unknown> | undefined;
    if (!row) throw new ToolError("NOT_FOUND", "That topic revision does not exist.");
    const sourceIds = (this.#database.connection.prepare("SELECT source_id AS id FROM page_section_sources WHERE revision_id = ? ORDER BY start_offset").all(String(row.id)) as Array<{ id: string }>).map((source) => source.id);
    return {
      items: [{
        id: String(row.id),
        type: "topic",
        title: `${String(row.title).slice(0, 900)} · revision ${Number(row.revision_number)}`,
        excerpt: String(row.markdown).slice(0, 100_000),
        score: 1,
        sourceIds: sourceIds.length ? sourceIds : [input.topicId],
        location: { topicId: input.topicId, revision: Number(row.revision_number) },
        observedAt: String(row.created_at),
        status: Number(row.revision_number) === Number(row.active_revision) ? "current" : "superseded"
      }],
      nextCursor: null,
      totalKnown: 1
    };
  }

  async traceClaim(input: Parameters<MemoryToolRepository["traceClaim"]>[0], signal?: AbortSignal): Promise<MemoryPage> {
    signal?.throwIfAborted();
    const claim = this.#database.connection.prepare("SELECT * FROM claims WHERE id = ?").get(input.claimId) as Record<string, unknown> | undefined;
    if (!claim) throw new ToolError("NOT_FOUND", "That claim does not exist.");
    const links = this.#database.connection.prepare("SELECT source_id, source_type FROM claim_sources WHERE claim_id = ? ORDER BY source_id").all(input.claimId) as Array<{ source_id: string; source_type: string }>;
    const sourceIds = links.map((link) => link.source_id);
    const items: MemoryPage["items"] = [{
      id: input.claimId,
      type: "claim",
      title: `${String(claim.subject)} ${String(claim.predicate)}`.slice(0, 1_000),
      excerpt: String(claim.value).slice(0, 100_000),
      score: Number(claim.confidence),
      sourceIds: sourceIds.length ? sourceIds : [input.claimId],
      observedAt: String(claim.observed_at),
      status: effectiveClaimStatus(String(claim.status) as "current" | "superseded" | "conflicted" | "historical" | "expired", claim.freshness_expires_at ? String(claim.freshness_expires_at) : null)
    }];
    const seen = new Set([`claim:${input.claimId}`]);
    const appendEvidence = (sourceId: string, relation?: { type: string; direction: "incoming" | "outgoing"; claimId: string }): void => {
      if (items.length >= 100 || seen.has(`evidence:${sourceId}`)) return;
      const event = this.#database.getEvent(sourceId);
      if (event) {
        seen.add(`evidence:${sourceId}`);
        items.push({ id: event.id, type: "event", title: titleForEvent(event), excerpt: event.content.slice(0, 100_000), score: 1, sourceIds: [event.id], location: { sequence: event.sequence, ...(relation ? { relationType: relation.type, relationDirection: relation.direction, relatedClaimId: relation.claimId } : {}) }, observedAt: event.createdAt, status: event.active ? "current" : "historical" });
        return;
      }
      const source = this.#database.connection.prepare("SELECT id, title, type, created_at, freshness_class, provenance_json FROM sources WHERE id = ?").get(sourceId) as Record<string, unknown> | undefined;
      if (source) {
        seen.add(`evidence:${sourceId}`);
        items.push({ id: String(source.id), type: String(source.type) === "attachment" ? "attachment" : "source", title: String(source.title).slice(0, 1_000), excerpt: "Exact source record; use open_source to inspect its chunks.", score: 1, sourceIds: [String(source.id)], location: { sourceId: String(source.id), ...(relation ? { relationType: relation.type, relationDirection: relation.direction, relatedClaimId: relation.claimId } : {}) }, observedAt: String(source.created_at), status: effectiveSourceStatus(source) });
        return;
      }
      const chunk = this.#database.connection.prepare("SELECT sc.*, s.title, s.freshness_class, s.provenance_json FROM source_chunks sc JOIN sources s ON s.id = sc.source_id WHERE sc.id = ?").get(sourceId) as Record<string, unknown> | undefined;
      if (chunk) {
        seen.add(`evidence:${sourceId}`);
        items.push({ id: String(chunk.id), type: "source", title: String(chunk.title).slice(0, 1_000), excerpt: String(chunk.text_content).slice(0, 100_000), score: 1, sourceIds: [String(chunk.id), String(chunk.source_id)], location: { sourceId: String(chunk.source_id), chunkId: String(chunk.id), evidenceId: String(chunk.id), ...(relation ? { relationType: relation.type, relationDirection: relation.direction, relatedClaimId: relation.claimId } : {}) }, observedAt: String(chunk.created_at), status: effectiveSourceStatus(chunk) });
        return;
      }
      const tool = this.#database.connection.prepare("SELECT id, tool_name, output_text, started_at FROM tool_executions WHERE id = ?").get(sourceId) as Record<string, unknown> | undefined;
      if (tool) {
        seen.add(`evidence:${sourceId}`);
        items.push({ id: String(tool.id), type: "tool_result", title: String(tool.tool_name).slice(0, 1_000), excerpt: String(tool.output_text).slice(0, 100_000), score: 1, sourceIds: [String(tool.id)], ...(relation ? { location: { relationType: relation.type, relationDirection: relation.direction, relatedClaimId: relation.claimId } } : {}), observedAt: String(tool.started_at), status: "current" });
      }
    };
    for (const link of links) appendEvidence(link.source_id);

    const relations = this.#database.connection.prepare(`
      SELECT source_claim_id, target_claim_id, relation_type, confidence
      FROM claim_relations WHERE source_claim_id = ? OR target_claim_id = ?
      ORDER BY CASE relation_type WHEN 'contradicts' THEN 0 WHEN 'supports' THEN 1 ELSE 2 END,
        confidence DESC, created_at, id
    `).all(input.claimId, input.claimId) as Array<{ source_claim_id: string; target_claim_id: string; relation_type: string; confidence: number }>;
    for (const relation of relations) {
      if (items.length >= 100) break;
      const outgoing = relation.source_claim_id === input.claimId;
      const relatedId = outgoing ? relation.target_claim_id : relation.source_claim_id;
      const related = this.#database.getClaim(relatedId, true);
      if (!related) continue;
      if (!seen.has(`claim:${related.id}`)) {
        seen.add(`claim:${related.id}`);
        items.push({
          id: related.id,
          type: "claim",
          title: `${relation.relation_type}: ${related.subject} ${related.predicate}`.slice(0, 1_000),
          excerpt: related.value.slice(0, 100_000),
          score: Number(relation.confidence),
          sourceIds: related.sourceIds.length ? related.sourceIds : [related.id],
          location: { relationType: relation.relation_type, relationDirection: outgoing ? "outgoing" : "incoming", relatedClaimId: related.id },
          observedAt: related.observedAt,
          status: related.status
        });
      }
      for (const relatedSourceId of related.sourceIds) appendEvidence(relatedSourceId, { type: relation.relation_type, direction: outgoing ? "outgoing" : "incoming", claimId: related.id });
    }
    return { items, nextCursor: null, totalKnown: items.length };
  }

  async searchTimeline(input: Parameters<MemoryToolRepository["searchTimeline"]>[0], signal?: AbortSignal): Promise<MemoryPage> {
    signal?.throwIfAborted();
    const offset = cursorOffset(input.cursor);
    const clauses = ["1 = 1"];
    const parameters: unknown[] = [];
    if (input.dateRange.from) { clauses.push("e.created_at >= ?"); parameters.push(input.dateRange.from); }
    if (input.dateRange.to) { clauses.push("e.created_at <= ?"); parameters.push(input.dateRange.to); }
    if (input.roles.length) {
      clauses.push(`e.role IN (${input.roles.map(() => "?").join(",")})`);
      parameters.push(...input.roles);
    }
    if (input.text.trim()) {
      const escaped = input.text.trim().replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
      clauses.push("ec.text_content LIKE ? ESCAPE '\\'");
      parameters.push(`%${escaped}%`);
    }
    const total = Number((this.#database.connection.prepare(`SELECT COUNT(*) AS count FROM events e JOIN event_content ec ON ec.event_id = e.id AND ec.ordinal = 0 WHERE ${clauses.join(" AND ")}`).get(...parameters) as { count: number }).count);
    const found = this.#database.connection.prepare(`
      SELECT e.id FROM events e JOIN event_content ec ON ec.event_id = e.id AND ec.ordinal = 0
      WHERE ${clauses.join(" AND ")} ORDER BY e.sequence ASC LIMIT ? OFFSET ?
    `).all(...parameters, input.limit, offset) as Array<{ id: string }>;
    const items = found.flatMap(({ id }) => {
      const event = this.#database.getEvent(id);
      return event ? [{ id: event.id, type: "event" as const, title: titleForEvent(event), excerpt: event.content.slice(0, 100_000), score: 1, sourceIds: [event.id], location: { sequence: event.sequence, role: event.role }, observedAt: event.createdAt, status: event.active ? "current" : "historical" }] : [];
    });
    return { items, nextCursor: nextCursor(offset, items.length, input.limit, total), totalKnown: total };
  }

  #sourceIdsForResult(result: SearchResult): string[] {
    const { id, type } = result;
    if (type === "event") return [id];
    if (type === "topic") {
      const ids = result.topicRevisionId
        ? (this.#database.connection.prepare("SELECT source_id AS id FROM page_section_sources WHERE revision_id = ? ORDER BY start_offset, id").all(result.topicRevisionId) as Array<{ id: string }>).map((row) => row.id)
        : this.#database.getTopic(id)?.sourceIds ?? [];
      return ids.length ? [...new Set(ids)].slice(0, 100) : [id];
    }
    if ((type === "source" || type === "attachment") && result.evidenceId) {
      const chunk = this.#database.connection.prepare("SELECT source_id FROM source_chunks WHERE id = ?").get(result.evidenceId) as { source_id: string } | undefined;
      return [...new Set([result.evidenceId, ...(chunk ? [chunk.source_id] : []), id])].slice(0, 100);
    }
    if (type === "source") return [id];
    if (type === "claim") {
      const ids = (this.#database.connection.prepare("SELECT source_id AS id FROM claim_sources WHERE claim_id = ?").all(id) as Array<{ id: string }>).map((row) => row.id);
      return ids.length ? ids : [id];
    }
    if (type === "entity") {
      const ids = (this.#database.connection.prepare("SELECT source_id AS id FROM entity_aliases WHERE entity_id = ? AND active = 1 AND source_id IS NOT NULL ORDER BY confidence DESC").all(id) as Array<{ id: string }>).map((row) => row.id).filter((sourceId) => IdSchema.safeParse(sourceId).success);
      return ids.length ? [...new Set(ids)].slice(0, 100) : [id];
    }
    if (type === "tool_result") {
      const row = this.#database.connection.prepare(`
        SELECT te.citations_json, r.user_event_id FROM tool_executions te
        LEFT JOIN runs r ON r.id = te.run_id WHERE te.id = ?
      `).get(id) as { citations_json: string; user_event_id: string | null } | undefined;
      const sourceIds = new Set<string>();
      if (row?.user_event_id && IdSchema.safeParse(row.user_event_id).success) sourceIds.add(row.user_event_id);
      if (row) {
        try {
          const citations = JSON.parse(row.citations_json) as unknown;
          if (Array.isArray(citations)) for (const citation of citations) {
            if (typeof citation === "string" && IdSchema.safeParse(citation).success) sourceIds.add(citation);
            else if (citation && typeof citation === "object" && typeof (citation as Record<string, unknown>).sourceId === "string") {
              const sourceId = String((citation as Record<string, unknown>).sourceId);
              if (IdSchema.safeParse(sourceId).success) sourceIds.add(sourceId);
            }
          }
        } catch { /* malformed historical tool metadata is not trusted */ }
      }
      return sourceIds.size ? [...sourceIds].slice(0, 100) : [id];
    }
    const attachment = this.#database.getAttachment(id);
    return attachment ? [attachment.sourceId] : [id];
  }

  #openableSourceLocation(result: SearchResult): Record<string, string> | null {
    if (result.type !== "source" && result.type !== "attachment") return null;
    const chunk = result.evidenceId
      ? this.#database.connection.prepare("SELECT id, source_id FROM source_chunks WHERE id = ?").get(result.evidenceId) as { id: string; source_id: string } | undefined
      : undefined;
    const canonicalSourceId = result.type === "attachment"
      ? this.#database.getAttachment(result.id)?.sourceId
      : (chunk?.source_id ?? result.id);
    if (!canonicalSourceId) return result.evidenceId ? { evidenceId: result.evidenceId } : null;
    return {
      sourceId: canonicalSourceId,
      ...(result.evidenceId ? { evidenceId: result.evidenceId, chunkId: result.evidenceId } : {})
    };
  }

  #statusForResult(result: SearchResult): MemoryResultStatus {
    if (result.type === "event") return this.#database.getEvent(result.id)?.active ? "current" : "historical";
    if (result.type === "topic") return result.topicRevisionId && result.tags.includes("superseded") ? "superseded" : "current";
    if (result.type === "claim") {
      const status = this.#database.getClaim(result.id, true)?.status;
      return status ?? "historical";
    }
    if (result.type === "entity") {
      const row = this.#database.connection.prepare("SELECT status FROM entities WHERE id = ?").get(result.id) as { status: string } | undefined;
      return row?.status === "active" ? "current" : "historical";
    }
    if (result.type === "source" || result.type === "attachment") {
      const sourceId = result.type === "attachment" ? this.#database.getAttachment(result.id)?.sourceId : result.id;
      const row = sourceId ? this.#database.connection.prepare("SELECT freshness_class, provenance_json FROM sources WHERE id = ?").get(sourceId) as { freshness_class: string; provenance_json: string } | undefined : undefined;
      return row ? effectiveSourceStatus(row) : "historical";
    }
    return "current";
  }
}

class SqliteWorkspaceRegistry implements WorkspaceAuthorizationRegistry {
  readonly #database: ContinuumDatabase;

  constructor(database: ContinuumDatabase) {
    this.#database = database;
  }

  async get(id: string): Promise<WorkspaceAuthorization | undefined> {
    const row = this.#database.connection.prepare("SELECT * FROM workspace_roots WHERE id = ? AND authorized = 1 AND read_only = 1").get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const requestedRoot = String(row.path);
    let canonicalRoot = requestedRoot;
    let status: WorkspaceAuthorization["status"] = "authorized";
    try {
      canonicalRoot = await realpath(requestedRoot);
      if (!(await stat(canonicalRoot)).isDirectory()) status = "reauthorization_required";
      else if (canonicalRoot !== requestedRoot) status = "reauthorization_required";
    } catch {
      status = "missing";
    }
    return { id, requestedRoot, canonicalRoot, authorizedAt: String(row.authorized_at), status };
  }
}

const MEMORY_DEFINITIONS: readonly ProviderToolDefinition[] = [
  {
    name: "search_memory",
    description: "Search source-linked long-term memory before answering questions about earlier conversations, preferences, decisions, people, projects, or facts. Source and attachment hits include location.sourceId, which is directly accepted by open_source.",
    parameters: { type: "object", additionalProperties: false, properties: { query: { type: "string" }, filters: { type: "object", additionalProperties: false, properties: { types: { type: "array", items: { type: "string", enum: ["event", "source", "topic", "claim", "entity", "attachment", "tool_result"] } }, roles: { type: "array", items: { type: "string", enum: ["user", "assistant", "system", "tool"] } }, tags: { type: "array", items: { type: "string" } }, statuses: { type: "array", items: { type: "string", enum: ["current", "superseded", "conflicted", "historical", "expired"] } }, from: { type: "string" }, to: { type: "string" }, scopeId: { type: "string" } } }, limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "string" } }, required: ["query"] }
  },
  { name: "open_event", description: "Page through an exact raw conversation event by stable ID. Cursor is the returned character offset; each limit unit permits 2,000 characters.", parameters: { type: "object", additionalProperties: false, properties: { eventId: { type: "string" }, cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } }, required: ["eventId"] } },
  { name: "open_source", description: "Open exact source chunks, optionally near a page, line, or row. sourceId may be the canonical location.sourceId, or a source, attachment, or chunk ID returned by search_memory.", parameters: { type: "object", additionalProperties: false, properties: { sourceId: { type: "string" }, location: { type: "object", additionalProperties: false, properties: { page: { type: "integer", minimum: 1 }, line: { type: "integer", minimum: 1 }, row: { type: "integer", minimum: 1 } } }, cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 200 } }, required: ["sourceId"] } },
  { name: "get_topic_page", description: "Read the active or a historical revision of a compiled wiki topic page.", parameters: { type: "object", additionalProperties: false, properties: { topicId: { type: "string" }, revision: { type: "integer", minimum: 1 } }, required: ["topicId"] } },
  { name: "trace_claim", description: "Trace a memory claim through exact supporting, contradicting, and otherwise related claims and evidence.", parameters: { type: "object", additionalProperties: false, properties: { claimId: { type: "string" } }, required: ["claimId"] } },
  { name: "search_timeline", description: "Search raw conversation evidence in chronological order.", parameters: { type: "object", additionalProperties: false, properties: { dateRange: { type: "object", additionalProperties: false, properties: { from: { type: "string" }, to: { type: "string" } } }, roles: { type: "array", items: { type: "string", enum: ["user", "assistant", "system", "tool"] } }, text: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "string" } }, required: ["dateRange"] } }
];

const WORKSPACE_DEFINITIONS: readonly ProviderToolDefinition[] = [
  { name: "workspace_list", description: "List files beneath an explicitly authorized read-only workspace root. Override exclusions only when the current user request explicitly asks for that file class.", parameters: { type: "object", additionalProperties: false, properties: { rootId: { type: "string" }, path: { type: "string" }, includeHidden: { type: "boolean" }, includeIgnored: { type: "boolean" }, includeDependencies: { type: "boolean" }, recursive: { type: "boolean" }, maxDepth: { type: "integer", minimum: 0, maximum: 10 }, limit: { type: "integer", minimum: 1, maximum: 5000 } }, required: ["rootId"] } },
  { name: "workspace_read", description: "Read a bounded UTF-8 range from an explicitly authorized workspace file. Exclusion and large-file overrides require explicit current-user intent. Secret-like paths also require an exact, unexpired, one-use approval; only then set allowLikelySecret=true.", parameters: { type: "object", additionalProperties: false, properties: { rootId: { type: "string" }, path: { type: "string" }, includeHidden: { type: "boolean" }, includeIgnored: { type: "boolean" }, includeDependencies: { type: "boolean" }, allowLikelySecret: { type: "boolean" }, allowLargeFile: { type: "boolean" }, byteOffset: { type: "integer", minimum: 0 }, byteLength: { type: "integer", minimum: 1, maximum: 2097152 } }, required: ["rootId", "path"] } },
  { name: "workspace_search", description: "Search bounded UTF-8 files beneath an explicitly authorized read-only workspace root. Override exclusions only when the current user request explicitly asks for that file class.", parameters: { type: "object", additionalProperties: false, properties: { rootId: { type: "string" }, path: { type: "string" }, query: { type: "string" }, includeHidden: { type: "boolean" }, includeIgnored: { type: "boolean" }, includeDependencies: { type: "boolean" }, caseSensitive: { type: "boolean" }, maxDepth: { type: "integer", minimum: 0, maximum: 20 }, maxFiles: { type: "integer", minimum: 1, maximum: 5000 }, limit: { type: "integer", minimum: 1, maximum: 1000 } }, required: ["rootId", "query"] } }
];

const SANDBOX_DEFINITION: ProviderToolDefinition = {
  name: "execute_code",
  description: "Execute JavaScript, TypeScript, or Python in a disposable, network-denied OS sandbox with no host workspace mounted.",
  parameters: { type: "object", additionalProperties: false, properties: { language: { type: "string", enum: ["javascript", "typescript", "python"] }, code: { type: "string" }, args: { type: "array", items: { type: "string" } }, stdin: { type: "string" }, wallTimeMs: { type: "integer", minimum: 100, maximum: 10000 }, memoryBytes: { type: "integer", minimum: 33554432, maximum: 268435456 }, outputBytes: { type: "integer", minimum: 1024, maximum: 20971520 } }, required: ["language", "code"] }
};

export interface ToolLifecycle {
  started(executionId: string, name: string): void;
  completed(executionId: string, name: string): void;
}

export class LocalToolRuntime {
  readonly definitions: readonly ProviderToolDefinition[];
  readonly #database: ContinuumDatabase;
  readonly #tools: Map<string, TypedTool<unknown, ToolEvidence>>;
  readonly #workspaceOverrideIntent: WorkspaceOverrideIntent;

  constructor(database: ContinuumDatabase, userRequest: string, secretGrants = new OneUseWorkspaceSecretGrants()) {
    this.#database = database;
    this.#workspaceOverrideIntent = workspaceOverrideIntent(userRequest);
    const memoryTools = new MemoryToolSession(new SqliteMemoryToolRepository(database), 3).tools();
    const tools: TypedTool<unknown, ToolEvidence>[] = [...memoryTools];
    const definitions: ProviderToolDefinition[] = [...MEMORY_DEFINITIONS];
    const authorizedWorkspaces = database.listWorkspaces()
      .filter((row) => Number(row.authorized) === 1 && Number(row.read_only) === 1)
      .slice(0, 100);
    const hasWorkspace = authorizedWorkspaces.length > 0;
    const workspaceIntent = /\b(files?|folder|workspace|repository|repo|codebase|source code|project files?|directory|path|readme|package\.json)\b|(?:^|\s)(?:\.?\.?\/)?[\w.@-]+(?:\/[\w.@-]+)+|\b[\w@-]+\.(?:md|txt|json|ya?ml|toml|ini|ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|c|cc|cpp|h|hpp|css|scss|html|sql|sh|zsh|fish)\b/i.test(userRequest);
    if (hasWorkspace && workspaceIntent) {
      tools.push(...new WorkspaceReader(new SqliteWorkspaceRegistry(database), secretGrants).tools());
      const rootCatalog = JSON.stringify(authorizedWorkspaces.map((row) => ({
        rootId: String(row.id),
        // The user-chosen label helps the model select among roots, but the
        // absolute host path (often containing a username) stays local.
        displayName: String(row.display_name)
      })));
      definitions.push(...WORKSPACE_DEFINITIONS.map((definition) => ({
        ...definition,
        description: `${definition.description} Authorized read-only roots for this turn: ${rootCatalog}`
      })));
    }
    const executionIntent = /(?:\b(?:run|execute|test|evaluate|calculate|compute|plot|simulate)\b.{0,80}\b(?:code|script|python|javascript|typescript|node)\b)|(?:\b(?:code|script|python|javascript|typescript|node)\b.{0,80}\b(?:run|execute|test|evaluate|calculate|compute|plot|simulate|use)\b)|(?:\buse\s+(?:python|javascript|typescript|node)\b)/is.test(userRequest);
    if (executionIntent) {
      tools.push(new ExecuteCodeTool(new IsolatedSandbox()) as TypedTool<unknown, ToolEvidence>);
      definitions.push(SANDBOX_DEFINITION);
    }
    this.definitions = definitions;
    this.#tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  async execute(call: ProviderToolCall, runId: string, parentEventId: string, signal: AbortSignal, lifecycle: ToolLifecycle): Promise<string> {
    const executionId = uuidv7();
    const startedAt = new Date().toISOString();
    const safeArguments = boundedJson(call.arguments, MAX_PERSISTED_ARGUMENT_BYTES);
    this.#database.connection.prepare(`
      INSERT INTO tool_executions(id, run_id, tool_name, arguments_json, output_text, citations_json, status, sandbox_json, started_at)
      VALUES (?, ?, ?, ?, '', '[]', 'running', '{}', ?)
    `).run(executionId, runId, call.name, safeArguments, startedAt);
    this.#database.appendEvent({ role: "tool", kind: "tool_call", status: "complete", content: boundedJson({ executionId, providerCallId: call.callId, name: call.name, arguments: call.arguments }, MAX_PERSISTED_ARGUMENT_BYTES), parentEventId, runId });
    lifecycle.started(executionId, call.name);
    const tool = this.#tools.get(call.name);
    if (!tool) return this.#finishFailure(executionId, call.name, parentEventId, runId, new ToolError("NOT_AUTHORIZED", "That local tool was not offered for this request."), lifecycle);
    try {
      signal.throwIfAborted();
      this.#assertWorkspaceOverrides(call);
      let evidence = await tool.execute(call.arguments, { runId, toolCallId: executionId, signal });
      let output = serializeUntrustedEvidence(evidence);
      if (Buffer.byteLength(output) > MAX_PERSISTED_TOOL_OUTPUT_BYTES) {
        evidence = createToolEvidence({
          content: evidence.content.slice(0, MAX_PERSISTED_TOOL_OUTPUT_BYTES / 2),
          provenance: evidence.provenance.slice(0, 100),
          truncated: true,
          metadata: { ...evidence.metadata, persistenceLimitReached: true }
        });
        output = serializeUntrustedEvidence(evidence);
      }
      const sandbox = call.name === "execute_code" ? evidence.metadata : {};
      this.#database.connection.prepare("UPDATE tool_executions SET output_text = ?, citations_json = ?, status = 'complete', sandbox_json = ?, completed_at = ? WHERE id = ?").run(output, JSON.stringify(evidence.provenance), JSON.stringify(sandbox), new Date().toISOString(), executionId);
      this.#database.appendEvent({ role: "tool", kind: "tool_result", status: "complete", content: output, parentEventId, runId });
      lifecycle.completed(executionId, call.name);
      return boundedProviderEvidence(evidence, output);
    } catch (error) {
      return this.#finishFailure(executionId, call.name, parentEventId, runId, error, lifecycle);
    }
  }

  #assertWorkspaceOverrides(call: ProviderToolCall): void {
    if (!call.name.startsWith("workspace_")) return;
    const argumentsRecord = call.arguments && typeof call.arguments === "object" ? call.arguments as Record<string, unknown> : {};
    const checks: Array<[keyof WorkspaceOverrideIntent, string, string]> = [
      ["hidden", "includeHidden", "hidden or dotfiles"],
      ["ignored", "includeIgnored", "gitignored files"],
      ["dependencies", "includeDependencies", "dependency or build-output directories"],
      ["largeFile", "allowLargeFile", "a bounded large-file read"]
    ];
    for (const [intent, argument, description] of checks) {
      if (argumentsRecord[argument] === true && !this.#workspaceOverrideIntent[intent]) {
        throw new ToolError("NOT_AUTHORIZED", `The model cannot enable ${argument} unless the current user request explicitly asks for ${description}.`);
      }
    }
  }

  #finishFailure(executionId: string, name: string, parentEventId: string, runId: string, error: unknown, lifecycle: ToolLifecycle): string {
    const code = error instanceof ToolError ? error.code : error instanceof Error && error.name === "AbortError" ? "CANCELLED" : "TOOL_FAILED";
    const message = error instanceof Error ? error.message.slice(0, 1_000) : "The local tool failed.";
    const output = JSON.stringify({ type: "continuum.tool_error", error: { code, message } });
    this.#database.connection.prepare("UPDATE tool_executions SET output_text = ?, status = 'failed', completed_at = ? WHERE id = ?").run(output, new Date().toISOString(), executionId);
    this.#database.appendEvent({ role: "tool", kind: "tool_result", status: "failed", content: output, parentEventId, runId });
    lifecycle.completed(executionId, name);
    return output;
  }
}
