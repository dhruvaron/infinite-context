import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { v5 as uuidv5, v7 as uuidv7 } from "uuid";
import type {
  Attachment,
  Claim,
  ConversationEvent,
  GraphResponse,
  QualityPreset,
  RunStreamEvent,
  SearchResult,
  TopicPage,
  TopicSourceReference
} from "@continuum/contracts";
import type { TopicShardProposal } from "@continuum/contracts/api";
import {
  InstallationBudgetGuard,
  stableHash,
  type AppConfig,
  type LegacyInstallationBudgetEntry
} from "@continuum/config";
import { migrations } from "./migrations.js";

type SqliteDatabase = InstanceType<typeof Database>;

type EventInput = {
  id?: string;
  role: ConversationEvent["role"];
  kind?: ConversationEvent["kind"];
  status?: ConversationEvent["status"];
  content: string;
  parentEventId?: string | null;
  runId?: string | null;
  active?: boolean;
  attachmentIds?: string[];
};

export type DeletionApiRecovery = {
  idempotencyKey: string;
  operation: string;
};

export interface JobRecord {
  id: string;
  type: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  status: "queued" | "running" | "complete" | "failed" | "cancelled";
  attempts: number;
  maximumAttempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SourceChunkWriteResult {
  chunkIds: string[];
  exactReplay: boolean;
  invalidatedClaimIds: string[];
  invalidatedTopicIds: string[];
}

export interface DatabaseHealth {
  integrity: "ok" | "error";
  integrityCheckedAt: string;
  vectorAvailable: boolean;
  vectorMode: "sqlite-vec" | "bounded-cosine-fallback";
  vectorStrategy: "native-exact-cosine" | "bounded-json-cosine";
  vectorVersion: string | null;
  vectorFallbackLimit: number;
  vectorLoadStatus: "ready" | "degraded";
  schemaVersion: number;
  journalMode: string;
}

export interface TopicShardClaimGuardSnapshot {
  claimId: string;
  topicId: string | null;
  stateHash: string;
}

export interface TopicShardParentBaseSnapshot {
  revisionId: string;
  revision: number;
  fingerprint: string;
}

export interface TopicShardBaseSnapshot extends TopicShardParentBaseSnapshot {
  topicId: string;
  section: TopicShardProposal["patches"][number]["section"];
  ordinal: number;
  minSortKey: string;
  maxSortKey: string;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJsonValue(item)]));
  }
  return value;
}

/** Canonical bytes shared by the planner and proposal resolver CAS checks. */
export function topicShardFingerprint(value: unknown): string {
  return stableHash(JSON.stringify(canonicalJsonValue(value)));
}

export interface TopicShardRevisionContent {
  topicId: string;
  revisionId: string;
  revision: number;
  markdown: string;
  summary: string;
  currentState: string;
  history: string;
  openQuestionsJson: string;
  generationInputsJson: string;
  authorType: string;
  promptVersion: string;
  provenance: Array<{
    section: string;
    start: number;
    end: number;
    claimId: string;
    sourceId: string;
  }>;
}

export function topicShardRevisionContentHash(content: TopicShardRevisionContent): string {
  const { topicId: _topicId, revisionId: _revisionId, revision: _revision, ...revisionContent } = content;
  return topicShardFingerprint({
    schemaVersion: 1,
    kind: "candidate-revision",
    ...revisionContent,
    provenance: [...content.provenance].sort((left, right) =>
      left.section.localeCompare(right.section)
      || left.start - right.start
      || left.end - right.end
      || left.claimId.localeCompare(right.claimId)
      || left.sourceId.localeCompare(right.sourceId))
  });
}

function canonicalProposalMaterial(proposal: TopicShardProposal): unknown {
  return {
    ...proposal,
    // Creation time is durable metadata, not part of the stable proposal
    // identity. A queue replay at a later wall-clock time must remain a no-op.
    createdAt: undefined,
    claimIds: [...new Set(proposal.claimIds)].sort(),
    sourceIds: [...new Set(proposal.sourceIds)].sort(),
    claimGuards: [...proposal.claimGuards]
      .sort((left, right) => left.claimId.localeCompare(right.claimId)),
    patches: proposal.patches.map((patch) => ({
      ...patch,
      routeGuards: [...patch.routeGuards].sort((left, right) =>
        left.claimId.localeCompare(right.claimId) || left.sortKey.localeCompare(right.sortKey)),
      outputs: patch.outputs.map((output) => ({
        ...output,
        claimIds: [...new Set(output.claimIds)].sort(),
        sourceIds: [...new Set(output.sourceIds)].sort(),
        evidenceIds: [...new Set(output.evidenceIds)].sort()
      }))
    }))
  };
}

export function topicShardProposalMaterialHash(proposal: TopicShardProposal): string {
  return topicShardFingerprint(canonicalProposalMaterial(proposal));
}

const TOPIC_SHARD_ID_NAMESPACE = "4956f460-f522-5c4a-9d04-6c3f4283bd1f";

/** Deterministic UUIDs keep stable-ID proposal replays canonically identical. */
export function topicShardStableUuid(value: string): string {
  return uuidv5(value, TOPIC_SHARD_ID_NAMESPACE);
}

export const VECTOR_FALLBACK_MAX_ROWS = 5_000;
export const VECTOR_SEARCH_MAX_RESULTS = 1_000;

export interface VectorSearchMatch {
  vectorId: string;
  sourceId: string;
  score: number;
}

export interface VectorSearchResult {
  mode: "sqlite-vec" | "bounded-cosine-fallback";
  strategy: "native-exact-cosine" | "bounded-json-cosine";
  corpusRows: number;
  rowsExamined: number;
  corpusTruncated: boolean;
  fallbackLimit: number;
  resultLimit: number;
  durationMs: number;
  matches: VectorSearchMatch[];
}

type CanonicalTopicProjectionShard = {
  childTopicId: string;
  parentTopicId: string;
  sectionKey: "overview" | "current_state" | "history" | "evidence";
  ordinal: number;
  minSortKey: string;
  maxSortKey: string;
  updatedAt: string;
};

function now(): string {
  return new Date().toISOString();
}

export function effectiveClaimStatus(
  status: Claim["status"],
  freshnessExpiresAt: string | null | undefined,
  referenceTime = Date.now()
): Claim["status"] {
  if ((status === "current" || status === "conflicted") && freshnessExpiresAt) {
    const expiry = Date.parse(freshnessExpiresAt);
    if (Number.isFinite(expiry) && expiry <= referenceTime) return "expired";
  }
  return status;
}

export function effectiveSourceStatus(
  source: { freshness_class?: unknown; provenance_json?: unknown },
  referenceTime = Date.now()
): "current" | "expired" {
  if (String(source.freshness_class ?? "") === "expired") return "expired";
  let provenance: unknown = source.provenance_json;
  if (typeof provenance === "string") {
    try { provenance = JSON.parse(provenance) as unknown; } catch { provenance = null; }
  }
  if (provenance && typeof provenance === "object" && !Array.isArray(provenance)) {
    const expiryValue = (provenance as Record<string, unknown>).freshnessExpiresAt;
    if (typeof expiryValue === "string") {
      const expiry = Date.parse(expiryValue);
      if (Number.isFinite(expiry) && expiry <= referenceTime) return "expired";
    }
  }
  return "current";
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function evidenceReferencesAny(value: unknown, removedIds: ReadonlySet<string>): boolean {
  if (typeof value === "string") return removedIds.has(value);
  if (Array.isArray(value)) return value.some((entry) => evidenceReferencesAny(entry, removedIds));
  if (typeof value === "object" && value !== null) {
    return Object.values(value as Record<string, unknown>).some((entry) => evidenceReferencesAny(entry, removedIds));
  }
  return false;
}

function safeFtsQuery(query: string): string {
  const tokens = query.normalize("NFKC").match(/[\p{L}\p{N}_-]+/gu)?.slice(0, 24) ?? [];
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(" OR ");
}

function normalizeClaimSlotValue(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function claimFromRow(row: Record<string, unknown>): Claim {
  return {
    id: String(row.id), topicId: row.topic_id ? String(row.topic_id) : null, subject: String(row.subject), predicate: String(row.predicate),
    value: String(row.value), confidence: Number(row.confidence), status: effectiveClaimStatus(row.status as Claim["status"], row.freshness_expires_at ? String(row.freshness_expires_at) : null),
    sourceRole: row.source_role as Claim["sourceRole"], sourceIds: parseJson<string[]>(row.source_ids, []),
    validFrom: row.valid_from ? String(row.valid_from) : null, validTo: row.valid_to ? String(row.valid_to) : null,
    observedAt: String(row.observed_at), freshnessExpiresAt: row.freshness_expires_at ? String(row.freshness_expires_at) : null
  };
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

const GRAPH_ID_NAMESPACE = "d88fd2d4-ef9d-4f17-9cd0-2f6d51359bb1";
function graphId(source: string, target: string, type: string): string {
  return uuidv5(`${source}:${target}:${type}`, GRAPH_ID_NAMESPACE);
}

function eventFromRow(row: Record<string, unknown>): ConversationEvent {
  return {
    id: String(row.id),
    sequence: Number(row.sequence),
    role: row.role as ConversationEvent["role"],
    kind: row.kind as ConversationEvent["kind"],
    status: row.status as ConversationEvent["status"],
    content: String(row.content ?? ""),
    parentEventId: row.parent_event_id ? String(row.parent_event_id) : null,
    runId: row.run_id ? String(row.run_id) : null,
    active: Boolean(row.active),
    createdAt: String(row.created_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
    attachments: parseJson<Attachment[]>(row.attachments_json, [])
  };
}

function jobFromRow(row: Record<string, unknown>): JobRecord {
  return {
    id: String(row.id),
    type: String(row.type),
    idempotencyKey: String(row.idempotency_key),
    payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    status: row.status as JobRecord["status"],
    attempts: Number(row.attempts),
    maximumAttempts: Number(row.maximum_attempts),
    leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
    leaseExpiresAt: row.lease_expires_at ? String(row.lease_expires_at) : null,
    lastErrorCode: row.last_error_code ? String(row.last_error_code) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

const EVENT_SELECT = `
  SELECT e.*,
    COALESCE((SELECT group_concat(ec.text_content, '') FROM event_content ec WHERE ec.event_id = e.id ORDER BY ec.ordinal), '') AS content,
    COALESCE((
      SELECT json_group_array(json_object(
        'id', a.id, 'sourceId', a.source_id, 'filename', a.filename, 'mediaType', a.media_type,
        'size', a.size, 'status', a.status, 'createdAt', a.created_at
      ))
      FROM event_attachments ea JOIN attachments a ON a.id = ea.attachment_id WHERE ea.event_id = e.id
    ), '[]') AS attachments_json
  FROM events e`;

export class ContinuumDatabase {
  readonly connection: SqliteDatabase;
  vectorAvailable = false;
  vectorVersion: string | null = null;
  vectorLoadStatus: "ready" | "degraded" = "degraded";
  readonly path: string;
  readonly #installationBudget: InstallationBudgetGuard | null;
  readonly #installationBudgetOwnerScope: string | null;
  #integrity: "ok" | "error" = "error";
  #integrityCheckedAt = new Date(0).toISOString();
  #schemaVersion = 0;
  #journalMode = "unknown";

  private constructor(path: string, installationBudgetLedgerPath?: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.path = path;
    this.connection = new Database(path);
    this.connection.pragma("journal_mode = WAL");
    this.connection.pragma("foreign_keys = ON");
    this.connection.pragma("busy_timeout = 5000");
    this.connection.pragma("synchronous = FULL");
    this.connection.pragma("secure_delete = ON");
    this.connection.pragma("auto_vacuum = FULL");
    this.connection.pragma("trusted_schema = OFF");
    this.connection.pragma("temp_store = MEMORY");
    this.#installationBudget = installationBudgetLedgerPath
      ? new InstallationBudgetGuard(installationBudgetLedgerPath, { conservativeFailures: true })
      : null;
    this.#installationBudgetOwnerScope = installationBudgetLedgerPath ? stableHash(`continuum-vault:${path}`) : null;
  }

  static open(configOrPath: AppConfig | string): ContinuumDatabase {
    const path = typeof configOrPath === "string" ? configOrPath : configOrPath.databasePath;
    const store = new ContinuumDatabase(
      path,
      typeof configOrPath === "string" ? undefined : configOrPath.installationBudgetLedgerPath
    );
    store.migrate();
    store.#synchronizeClaimSlotIndex();
    store.#synchronizeTopicProjectionIndex();
    store.#releaseOrphanedInstallationReservations();
    store.seed(typeof configOrPath === "string" ? undefined : configOrPath);
    store.#synchronizeInstallationBudget();
    store.tryLoadVectorExtension();
    store.refreshIntegrityCheck();
    return store;
  }

  close(): void {
    this.connection.close();
  }

  migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    const applied = new Set(
      (this.connection.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((row) => row.version)
    );
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      this.connection.transaction(() => {
        this.connection.exec(migration.sql);
        this.connection.prepare(
          "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)"
        ).run(migration.version, migration.name, stableHash(migration.sql), now());
      })();
    }
  }

  /**
   * Migration 14 can only seed SQL-compatible lower/trim keys. Normalize the
   * legacy ledger exactly once in JavaScript, then keep all product writes
   * exact in upsertClaim. This avoids a full-ledger startup scan thereafter.
   */
  #synchronizeClaimSlotIndex(): void {
    const state = this.connection.prepare("SELECT normalization_version FROM claim_slot_index_state WHERE id = 1").get() as { normalization_version: number } | undefined;
    if (!state || state.normalization_version >= 2) return;
    this.rebuildClaimSlotIndex();
  }

  /** Rebuild exact slot keys after legacy migration or a raw portable import. */
  rebuildClaimSlotIndex(): void {
    const rows = this.connection.prepare(`
      SELECT c.id, c.subject, c.predicate, c.topic_id, c.status,
        CASE WHEN EXISTS (
          SELECT 1 FROM claim_sources cs LEFT JOIN events e ON e.id = cs.source_id
          WHERE cs.claim_id = c.id AND (e.id IS NULL OR e.active = 1)
        ) THEN 1 ELSE 0 END AS active_evidence
      FROM claims c ORDER BY c.id
    `).all() as Array<{ id: string; subject: string; predicate: string; topic_id: string | null; status: Claim["status"]; active_evidence: number }>;
    const upsert = this.connection.prepare(`
      INSERT INTO claim_slot_index(claim_id, subject_key, predicate_key, topic_id, status, active_evidence) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(claim_id) DO UPDATE SET
        subject_key = excluded.subject_key,
        predicate_key = excluded.predicate_key,
        topic_id = excluded.topic_id,
        status = excluded.status,
        active_evidence = excluded.active_evidence
    `);
    this.connection.transaction(() => {
      this.connection.prepare("DELETE FROM claim_slot_index").run();
      this.connection.prepare("DELETE FROM claim_slot_topics").run();
      for (const row of rows) upsert.run(
        row.id,
        normalizeClaimSlotValue(row.subject),
        normalizeClaimSlotValue(row.predicate),
        row.topic_id,
        row.status,
        row.active_evidence
      );
      this.connection.prepare("UPDATE claim_slot_index_state SET normalization_version = 2 WHERE id = 1").run();
    })();
  }

  #canonicalTopicProjectionShards(): CanonicalTopicProjectionShard[] {
    const activeTopicIds = new Set((this.connection.prepare(`
      SELECT id FROM topic_pages WHERE lifecycle_status = 'active'
    `).all() as Array<{ id: string }>).map((row) => row.id));
    const rows = this.connection.prepare(`
      SELECT child.id, child.slug, child.tags_json, child.updated_at
      FROM topic_pages child
      WHERE child.lifecycle_status = 'active'
      ORDER BY child.id
    `).all() as Array<{ id: string; slug: string; tags_json: string; updated_at: string }>;
    const candidates: CanonicalTopicProjectionShard[] = [];
    for (const row of rows) {
      // Identical duplicate tags are harmless after de-duplication. Multiple
      // distinct parents are ambiguous and must never be guessed at startup.
      const parsedTags = parseJson<unknown>(row.tags_json, null);
      if (!Array.isArray(parsedTags)) continue;
      const parentIds = [...new Set(parsedTags
        .filter((tag): tag is string => typeof tag === "string" && tag.startsWith("parent:"))
        .map((tag) => tag.slice("parent:".length))
        .filter(Boolean))];
      if (parentIds.length !== 1) continue;
      const parentTopicId = parentIds[0]!;
      if (parentTopicId === row.id || !activeTopicIds.has(parentTopicId)) continue;
      const prefix = `${parentTopicId}-`;
      if (!row.slug.startsWith(prefix)) continue;
      const match = row.slug.slice(prefix.length).match(/^(overview|current-state|history|evidence)-part-([1-9]\d*)$/);
      if (!match) continue;
      const ordinal = Number.parseInt(match[2]!, 10);
      // Reject leading zeroes, unsafe integers, and other non-canonical
      // lookalikes without making a local vault impossible to open.
      if (!Number.isSafeInteger(ordinal) || String(ordinal) !== match[2]) continue;
      candidates.push({
        childTopicId: row.id,
        parentTopicId,
        sectionKey: match[1] === "current-state" ? "current_state" : match[1] as CanonicalTopicProjectionShard["sectionKey"],
        ordinal,
        minSortKey: "",
        maxSortKey: "",
        updatedAt: row.updated_at
      });
    }

    // Ordinals are stable sparse identities: rejected or partially accepted
    // proposal outputs can deliberately leave gaps. Only a duplicate canonical
    // position is ambiguous; a positive unique sparse sequence remains fully
    // ordered by section/range and must survive restart reconstruction.
    const invalidParents = new Set<string>();
    const positions = new Set<string>();
    for (const shard of candidates) {
      const position = `${shard.parentTopicId}\u0000${shard.sectionKey}\u0000${shard.ordinal}`;
      if (positions.has(position)) invalidParents.add(shard.parentTopicId);
      positions.add(position);
    }
    const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
    const canonical = candidates
      .filter((shard) => !invalidParents.has(shard.parentTopicId))
      .sort((left, right) => compareText(left.parentTopicId, right.parentTopicId)
        || compareText(left.sectionKey, right.sectionKey)
        || left.ordinal - right.ordinal
        || compareText(left.childTopicId, right.childTopicId));
    const claimRows = this.connection.prepare(`
      SELECT DISTINCT c.id, c.status, c.observed_at, c.valid_to, c.freshness_expires_at
      FROM topic_pages child
      JOIN topic_page_revisions revision ON revision.topic_id = child.id AND revision.revision_number = child.active_revision
      JOIN page_section_sources pss ON pss.revision_id = revision.id
      JOIN claims c ON c.id = pss.claim_id AND c.topic_id = ?
      WHERE child.id = ?
        AND EXISTS (
          SELECT 1 FROM claim_sources cs LEFT JOIN events e ON e.id = cs.source_id
          WHERE cs.claim_id = c.id AND (e.id IS NULL OR e.active = 1)
        )
      ORDER BY c.id
    `);
    const referenceTime = Date.now();
    for (const shard of canonical) {
      const keys = (claimRows.all(shard.parentTopicId, shard.childTopicId) as Array<{
        id: string;
        status: Claim["status"];
        observed_at: string;
        valid_to: string | null;
        freshness_expires_at: string | null;
      }>).flatMap((claim) => {
        const status = effectiveClaimStatus(claim.status, claim.freshness_expires_at, referenceTime);
        const isCurrent = status === "current" || status === "conflicted";
        if (shard.sectionKey === "current_state" && !isCurrent) return [];
        if (shard.sectionKey === "history" && isCurrent) return [];
        const timestamp = shard.sectionKey === "history" ? claim.valid_to ?? claim.observed_at : claim.observed_at;
        return [`${timestamp}\u0000${claim.id}`];
      }).sort();
      shard.minSortKey = keys[0] ?? "";
      shard.maxSortKey = keys.at(-1) ?? "";
    }
    return canonical;
  }

  #synchronizeTopicProjectionIndex(): void {
    const expected = this.#canonicalTopicProjectionShards();
    const actual = this.connection.prepare(`
      SELECT child_topic_id, parent_topic_id, section_key, ordinal, min_sort_key, max_sort_key
      FROM topic_section_shards
      ORDER BY parent_topic_id, section_key, ordinal, child_topic_id
    `).all() as Array<{ child_topic_id: string; parent_topic_id: string; section_key: string; ordinal: number; min_sort_key: string; max_sort_key: string }>;
    const expectedIdentity = expected.map((shard) => JSON.stringify([shard.childTopicId, shard.parentTopicId, shard.sectionKey, shard.ordinal, shard.minSortKey, shard.maxSortKey])).sort();
    const actualIdentity = actual.map((shard) => JSON.stringify([shard.child_topic_id, shard.parent_topic_id, shard.section_key, shard.ordinal, shard.min_sort_key, shard.max_sort_key])).sort();
    const expectedParents = [...new Set(expected.map((shard) => shard.parentTopicId))].sort();
    const actualParents = (this.connection.prepare(`
      SELECT parent_topic_id FROM topic_projection_state
      WHERE mode = 'sharded' AND layout_version = 1 ORDER BY parent_topic_id
    `).all() as Array<{ parent_topic_id: string }>).map((row) => row.parent_topic_id).sort();
    const invalidShardedState = Number((this.connection.prepare(`
      SELECT COUNT(*) AS count FROM topic_projection_state
      WHERE mode = 'sharded' AND layout_version <> 1
    `).get() as { count: number }).count) > 0;
    if (!invalidShardedState
      && JSON.stringify(expectedIdentity) === JSON.stringify(actualIdentity)
      && JSON.stringify(expectedParents) === JSON.stringify(actualParents)) return;
    this.rebuildTopicProjectionIndex();
  }

  /** Reconstruct derived section-shard metadata after migration or import. */
  rebuildTopicProjectionIndex(): void {
    const children = this.#canonicalTopicProjectionShards();
    const insertState = this.connection.prepare(`
      INSERT INTO topic_projection_state(parent_topic_id, layout_version, mode, updated_at)
      VALUES (?, 1, 'sharded', ?)
      ON CONFLICT(parent_topic_id) DO UPDATE SET mode = 'sharded', layout_version = 1, updated_at = excluded.updated_at
    `);
    const insertShard = this.connection.prepare(`
      INSERT INTO topic_section_shards(child_topic_id, parent_topic_id, section_key, ordinal, min_sort_key, max_sort_key)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.connection.transaction(() => {
      this.connection.prepare("DELETE FROM topic_section_shards").run();
      this.connection.prepare("DELETE FROM topic_projection_state WHERE mode = 'sharded'").run();
      for (const child of children) {
        insertState.run(child.parentTopicId, child.updatedAt);
        insertShard.run(child.childTopicId, child.parentTopicId, child.sectionKey, child.ordinal, child.minSortKey, child.maxSortKey);
      }
    })();
  }

  private seed(config?: AppConfig): void {
    const timestamp = now();
    this.connection.prepare(`
      INSERT OR IGNORE INTO vaults(id, scope_id, name, created_at, schema_version) VALUES (?, 'global', 'Personal vault', ?, ?)
    `).run(uuidv7(), timestamp, migrations.at(-1)?.version ?? 1);
    this.connection.prepare(`
      INSERT OR IGNORE INTO settings(key, value_json, updated_at) VALUES ('onboarding.complete', 'false', ?)
    `).run(timestamp);
    this.connection.prepare(`
      INSERT OR IGNORE INTO settings(key, value_json, updated_at) VALUES ('theme', '"system"', ?)
    `).run(timestamp);
    this.connection.prepare(`
      INSERT OR IGNORE INTO settings(key, value_json, updated_at) VALUES ('memory.enabled', 'true', ?)
    `).run(timestamp);
    if (config) {
      const presets = [
        ["fast", config.models.fast, "low"],
        ["balanced", config.models.balanced, "medium"],
        ["deep", config.models.deep, "high"]
      ] as const;
      for (const [name, model, effort] of presets) {
        this.connection.prepare(`
          INSERT INTO provider_presets(id, name, provider, model_id, reasoning_effort, parameters_json, active, updated_at)
          VALUES (?, ?, 'openai', ?, ?, '{}', 1, ?)
          ON CONFLICT(name) DO UPDATE SET model_id = excluded.model_id, reasoning_effort = excluded.reasoning_effort, updated_at = excluded.updated_at
        `).run(uuidv7(), name, model, effort, timestamp);
      }
    }
  }

  private tryLoadVectorExtension(): void {
    try {
      const extension = process.env.CONTINUUM_SQLITE_VEC_EXTENSION;
      if (extension) this.connection.loadExtension(extension);
      else loadSqliteVec(this.connection);
      const version = this.connection.prepare("SELECT vec_version() AS version").get() as { version: string };
      this.vectorVersion = version.version;
      this.vectorAvailable = true;
      this.vectorLoadStatus = "ready";
    } catch {
      this.vectorAvailable = false;
      this.vectorVersion = null;
      this.vectorLoadStatus = "degraded";
    }
  }

  /** Expensive full-file validation; call on startup or scheduled maintenance, not per request. */
  refreshIntegrityCheck(): DatabaseHealth {
    const integrityRow = this.connection.pragma("quick_check", { simple: true });
    this.#integrity = integrityRow === "ok" ? "ok" : "error";
    this.#integrityCheckedAt = now();
    this.#journalMode = String(this.connection.pragma("journal_mode", { simple: true }));
    this.#schemaVersion = Number(
      (this.connection.prepare("SELECT COALESCE(MAX(version), 0) AS value FROM schema_migrations").get() as { value: number }).value
    );
    return this.health();
  }

  /** Constant-time cached health snapshot for loopback request paths. */
  health(): DatabaseHealth {
    return {
      integrity: this.#integrity,
      integrityCheckedAt: this.#integrityCheckedAt,
      vectorAvailable: this.vectorAvailable,
      vectorMode: this.vectorAvailable ? "sqlite-vec" : "bounded-cosine-fallback",
      vectorStrategy: this.vectorAvailable ? "native-exact-cosine" : "bounded-json-cosine",
      vectorVersion: this.vectorVersion,
      vectorFallbackLimit: VECTOR_FALLBACK_MAX_ROWS,
      vectorLoadStatus: this.vectorLoadStatus,
      schemaVersion: this.#schemaVersion,
      journalMode: this.#journalMode
    };
  }

  searchVectors(queryEmbedding: readonly number[], modelId: string, limit: number): VectorSearchResult {
    if (queryEmbedding.length === 0 || queryEmbedding.length > 65_536 || queryEmbedding.some((value) => !Number.isFinite(value))) {
      throw Object.assign(new Error("Vector query must contain finite dimensions."), { code: "VECTOR_QUERY_INVALID" });
    }
    if (modelId.length === 0 || modelId.length > 200 || modelId.trim() !== modelId) {
      throw Object.assign(new Error("Vector query must identify the exact embedding model."), { code: "VECTOR_QUERY_INVALID" });
    }
    const resultLimit = Math.max(1, Math.min(VECTOR_SEARCH_MAX_RESULTS, Math.floor(limit)));
    const dimensions = queryEmbedding.length;
    const corpusRows = Number((this.connection.prepare("SELECT COUNT(*) AS count FROM vectors WHERE dimensions = ? AND model_id = ?").get(dimensions, modelId) as { count: number }).count);
    const started = performance.now();
    if (this.vectorAvailable) {
      const queryBlob = Buffer.from(Float32Array.from(queryEmbedding).buffer);
      const rows = this.connection.prepare(`
        WITH scored AS (
          SELECT id AS vector_id, source_id,
            vec_distance_cosine(vec_f32(embedding_json), ?) AS distance
          FROM vectors INDEXED BY vectors_dimensions_created_idx
          WHERE dimensions = ? AND model_id = ?
        ), ranked AS (
          SELECT vector_id, source_id, distance,
            ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY distance ASC, vector_id ASC) AS source_rank
          FROM scored WHERE distance IS NOT NULL
        )
        SELECT vector_id, source_id, distance FROM ranked
        WHERE source_rank = 1
        ORDER BY distance ASC, vector_id ASC
        LIMIT ?
      `).all(queryBlob, dimensions, modelId, resultLimit) as Array<{ vector_id: string; source_id: string; distance: number }>;
      return {
        mode: "sqlite-vec",
        strategy: "native-exact-cosine",
        corpusRows,
        rowsExamined: corpusRows,
        corpusTruncated: false,
        fallbackLimit: VECTOR_FALLBACK_MAX_ROWS,
        resultLimit,
        durationMs: performance.now() - started,
        matches: rows.map((row) => ({
          vectorId: row.vector_id,
          sourceId: row.source_id,
          score: Math.max(-1, Math.min(1, 1 - row.distance))
        }))
      };
    }

    const rows = this.connection.prepare(`
      SELECT id, source_id, embedding_json FROM vectors
      WHERE dimensions = ? AND model_id = ?
      ORDER BY created_at DESC, id ASC
      LIMIT ?
    `).all(dimensions, modelId, VECTOR_FALLBACK_MAX_ROWS) as Array<{ id: string; source_id: string; embedding_json: string }>;
    const bySource = new Map<string, VectorSearchMatch>();
    for (const row of rows) {
      let embedding: number[];
      try { embedding = JSON.parse(row.embedding_json) as number[]; }
      catch { continue; }
      const score = cosineSimilarity(queryEmbedding, embedding);
      if (!Number.isFinite(score)) continue;
      const match = { vectorId: row.id, sourceId: row.source_id, score };
      const existing = bySource.get(row.source_id);
      if (!existing || match.score > existing.score || (match.score === existing.score && match.vectorId.localeCompare(existing.vectorId) < 0)) {
        bySource.set(row.source_id, match);
      }
    }
    return {
      mode: "bounded-cosine-fallback",
      strategy: "bounded-json-cosine",
      corpusRows,
      rowsExamined: rows.length,
      corpusTruncated: corpusRows > rows.length,
      fallbackLimit: VECTOR_FALLBACK_MAX_ROWS,
      resultLimit,
      durationMs: performance.now() - started,
      matches: [...bySource.values()]
        .sort((left, right) => right.score - left.score || left.vectorId.localeCompare(right.vectorId))
        .slice(0, resultLimit)
    };
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.connection.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as { value_json: string } | undefined;
    return row ? parseJson<T>(row.value_json, fallback) : fallback;
  }

  listSettings(): Record<string, unknown> {
    return Object.fromEntries(
      (this.connection.prepare("SELECT key, value_json FROM settings ORDER BY key").all() as Array<{ key: string; value_json: string }>).
        map((row) => [row.key, parseJson(row.value_json, null)])
    );
  }

  setSetting(key: string, value: unknown): void {
    this.connection.prepare(`
      INSERT INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), now());
  }

  idempotentResponse<T>(key: string, operation: string): T | null {
    const row = this.connection.prepare(
      "SELECT response_json FROM idempotency_keys WHERE key = ? AND operation = ?"
    ).get(key, operation) as { response_json: string } | undefined;
    return row ? parseJson<T>(row.response_json, null as T) : null;
  }

  rememberIdempotentResponse(key: string, operation: string, response: unknown): void {
    this.connection.prepare(
      "INSERT OR IGNORE INTO idempotency_keys(key, operation, response_json, created_at) VALUES (?, ?, ?, ?)"
    ).run(key, operation, JSON.stringify(response), now());
  }

  appendEvent(input: EventInput): ConversationEvent {
    return this.connection.transaction(() => {
      const id = input.id ?? uuidv7();
      const createdAt = now();
      const sequence = Number(
        (this.connection.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM events").get() as { value: number }).value
      );
      const status = input.status ?? "complete";
      this.connection.prepare(`
        INSERT INTO events(id, sequence, role, kind, status, parent_event_id, run_id, active, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, sequence, input.role, input.kind ?? "message", status, input.parentEventId ?? null,
        input.runId ?? null, input.active === false ? 0 : 1, createdAt,
        status === "complete" || status === "failed" || status === "incomplete" ? createdAt : null
      );
      this.connection.prepare(`
        INSERT INTO event_content(id, event_id, ordinal, content_type, text_content, metadata_json)
        VALUES (?, ?, 0, 'text', ?, '{}')
      `).run(uuidv7(), id, input.content);
      for (const attachmentId of input.attachmentIds ?? []) {
        this.connection.prepare(
          "INSERT OR IGNORE INTO event_attachments(event_id, attachment_id) VALUES (?, ?)"
        ).run(id, attachmentId);
      }
      return this.getEvent(id)!;
    })();
  }

  updateStreamingEvent(eventId: string, content: string): ConversationEvent {
    this.connection.prepare(
      "UPDATE event_content SET text_content = ? WHERE event_id = ? AND ordinal = 0"
    ).run(content, eventId);
    return this.getEvent(eventId)!;
  }

  finalizeEvent(eventId: string, status: ConversationEvent["status"], content?: string): ConversationEvent {
    return this.connection.transaction(() => {
      if (content !== undefined) {
        this.connection.prepare(
          "UPDATE event_content SET text_content = ? WHERE event_id = ? AND ordinal = 0"
        ).run(content, eventId);
      }
      this.connection.prepare(
        "UPDATE events SET status = ?, completed_at = ? WHERE id = ?"
      ).run(status, now(), eventId);
      return this.getEvent(eventId)!;
    })();
  }

  getEvent(id: string): ConversationEvent | null {
    const row = this.connection.prepare(`${EVENT_SELECT} WHERE e.id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? eventFromRow(row) : null;
  }

  listEvents(options: { beforeSequence?: number; afterSequence?: number; limit?: number; includeInactive?: boolean } = {}): ConversationEvent[] {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 501));
    const clauses = [options.includeInactive ? "1 = 1" : "e.active = 1"];
    const values: Array<number> = [];
    if (options.beforeSequence !== undefined) { clauses.push("e.sequence < ?"); values.push(options.beforeSequence); }
    if (options.afterSequence !== undefined) { clauses.push("e.sequence > ?"); values.push(options.afterSequence); }
    const order = options.afterSequence !== undefined ? "ASC" : "DESC";
    const rows = this.connection.prepare(
      `${EVENT_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY e.sequence ${order} LIMIT ?`
    ).all(...values, limit) as Array<Record<string, unknown>>;
    const events = rows.map(eventFromRow);
    return order === "DESC" ? events.reverse() : events;
  }

  recentEvents(limit = 24): ConversationEvent[] {
    return this.listEvents({ limit });
  }

  createRun(userEventId: string, quality: string): { id: string; createdAt: string } {
    const id = uuidv7();
    const createdAt = now();
    this.connection.prepare(`
      INSERT INTO runs(id, user_event_id, quality, status, created_at) VALUES (?, ?, ?, 'pending', ?)
    `).run(id, userEventId, quality, createdAt);
    return { id, createdAt };
  }

  createMessageAndRun(input: { content: string; attachmentIds: string[]; quality: string; idempotencyKey: string }): { event: ConversationEvent; runId: string } {
    return this.connection.transaction(() => {
      const prior = this.idempotentResponse<{ eventId: string; runId: string }>(input.idempotencyKey, "messages.create");
      if (prior) {
        const event = this.getEvent(prior.eventId);
        if (event && this.getRun(prior.runId)) return { event, runId: prior.runId };
        this.connection.prepare("DELETE FROM idempotency_keys WHERE key = ? AND operation = 'messages.create'").run(input.idempotencyKey);
      }
      const event = this.appendEvent({ role: "user", kind: "message", status: "complete", content: input.content, attachmentIds: input.attachmentIds });
      const run = this.createRun(event.id, input.quality);
      this.rememberIdempotentResponse(input.idempotencyKey, "messages.create", { eventId: event.id, runId: run.id });
      return { event, runId: run.id };
    })();
  }

  createRegenerationRun(userEventId: string, quality: string, idempotencyKey: string): { runId: string } {
    return this.connection.transaction(() => {
      const prior = this.idempotentResponse<{ runId: string }>(idempotencyKey, "events.regenerate");
      if (prior && this.getRun(prior.runId)) return prior;
      if (prior) this.connection.prepare("DELETE FROM idempotency_keys WHERE key = ? AND operation = 'events.regenerate'").run(idempotencyKey);
      const run = this.createRun(userEventId, quality);
      const response = { runId: run.id };
      this.rememberIdempotentResponse(idempotencyKey, "events.regenerate", response);
      return response;
    })();
  }

  registerAssistantRevision(userEventId: string, assistantEventId: string): number {
    return this.connection.transaction(() => {
      const existing = this.connection.prepare(
        "SELECT revision_number FROM assistant_revisions WHERE assistant_event_id = ?"
      ).get(assistantEventId) as { revision_number: number } | undefined;
      if (existing) return existing.revision_number;
      const revision = Number((this.connection.prepare(
        "SELECT COALESCE(MAX(revision_number), 0) + 1 AS value FROM assistant_revisions WHERE user_event_id = ?"
      ).get(userEventId) as { value: number }).value);
      const olderIds = (this.connection.prepare(`
        SELECT id FROM events
        WHERE parent_event_id = ? AND role = 'assistant' AND active = 1 AND id <> ?
      `).all(userEventId, assistantEventId) as Array<{ id: string }>).map((row) => row.id);
      this.connection.prepare("UPDATE assistant_revisions SET active = 0 WHERE user_event_id = ?").run(userEventId);
      for (const id of olderIds) {
        this.connection.prepare("UPDATE events SET active = 0 WHERE id = ?").run(id);
        this.connection.prepare("DELETE FROM vectors WHERE source_id = ? AND source_type = 'event'").run(id);
      }
      this.connection.prepare(
        "INSERT INTO assistant_revisions(id, user_event_id, assistant_event_id, revision_number, active, created_at) VALUES (?, ?, ?, ?, 1, ?)"
      ).run(uuidv7(), userEventId, assistantEventId, revision, now());
      this.connection.prepare("UPDATE events SET active = 1 WHERE id = ?").run(assistantEventId);
      return revision;
    })();
  }

  listAssistantRevisions(eventId: string): Array<{ event: ConversationEvent; revisionNumber: number; active: boolean; quality: QualityPreset }> {
    const selected = this.getEvent(eventId);
    if (!selected) return [];
    const userEventId = selected.role === "assistant" ? selected.parentEventId : selected.role === "user" ? selected.id : null;
    if (!userEventId) return [];
    const rows = this.connection.prepare(`
      SELECT ar.assistant_event_id AS event_id, ar.revision_number, ar.active, COALESCE(r.quality, 'balanced') AS quality
      FROM assistant_revisions ar
      LEFT JOIN events e ON e.id = ar.assistant_event_id
      LEFT JOIN runs r ON r.id = e.run_id
      WHERE ar.user_event_id = ? ORDER BY ar.revision_number ASC
    `).all(userEventId) as Array<{ event_id: string; revision_number: number; active: number; quality: QualityPreset }>;
    return rows.flatMap((row) => {
      const event = this.getEvent(row.event_id);
      return event ? [{ event, revisionNumber: row.revision_number, active: row.active === 1, quality: row.quality }] : [];
    });
  }

  activateAssistantRevision(assistantEventId: string): ConversationEvent | null {
    return this.connection.transaction(() => {
      const selected = this.connection.prepare(`
        SELECT user_event_id FROM assistant_revisions ar
        JOIN events e ON e.id = ar.assistant_event_id
        WHERE ar.assistant_event_id = ? AND e.role = 'assistant' AND e.status = 'complete'
      `).get(assistantEventId) as { user_event_id: string } | undefined;
      if (!selected) return null;
      const siblingIds = (this.connection.prepare(
        "SELECT assistant_event_id AS id FROM assistant_revisions WHERE user_event_id = ?"
      ).all(selected.user_event_id) as Array<{ id: string }>).map((row) => row.id);
      this.connection.prepare("UPDATE assistant_revisions SET active = CASE WHEN assistant_event_id = ? THEN 1 ELSE 0 END WHERE user_event_id = ?").run(assistantEventId, selected.user_event_id);
      if (siblingIds.length) {
        const marks = siblingIds.map(() => "?").join(",");
        this.connection.prepare(`UPDATE events SET active = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE id IN (${marks})`).run(assistantEventId, ...siblingIds);
        this.connection.prepare(`
          DELETE FROM vectors WHERE source_type = 'event' AND source_id IN (${marks}) AND source_id <> ?
        `).run(...siblingIds, assistantEventId);
      }
      return this.getEvent(assistantEventId);
    })();
  }

  excludeEvent(eventId: string): void {
    this.connection.transaction(() => {
      this.connection.prepare("UPDATE events SET active = 0 WHERE id = ?").run(eventId);
      this.connection.prepare("DELETE FROM vectors WHERE source_id = ? AND source_type = 'event'").run(eventId);
    })();
  }

  recoverInterruptedRuns(): string[] {
    return this.connection.transaction(() => {
      const interrupted = this.connection.prepare(
        "SELECT id, assistant_event_id FROM runs WHERE status IN ('retrieving','streaming')"
      ).all() as Array<{ id: string; assistant_event_id: string | null }>;
      const timestamp = now();
      for (const run of interrupted) {
        if (run.assistant_event_id) {
          const storedEvents = this.connection.prepare(
            "SELECT event_json FROM run_stream_events WHERE run_id = ? ORDER BY id ASC"
          ).all(run.id) as Array<{ event_json: string }>;
          const reconstructedDeltas: string[] = [];
          for (const stored of storedEvents) {
            const event = parseJson<RunStreamEvent | null>(stored.event_json, null);
            if (event?.type !== "response.delta" || event.eventId !== run.assistant_event_id || typeof event.delta !== "string") continue;
            reconstructedDeltas.push(event.delta);
          }
          if (reconstructedDeltas.length) {
            this.connection.prepare(
              "UPDATE event_content SET text_content = ? WHERE event_id = ? AND ordinal = 0"
            ).run(reconstructedDeltas.join(""), run.assistant_event_id);
          }
          // The partial answer remains part of the verbatim transcript and is
          // visibly retryable. Retrieval excludes non-complete events, so this
          // does not promote an interrupted answer into model memory.
          this.connection.prepare("UPDATE events SET status = 'incomplete', active = 1, completed_at = ? WHERE id = ?").run(timestamp, run.assistant_event_id);
          this.connection.prepare("DELETE FROM vectors WHERE source_id = ? AND source_type = 'event'").run(run.assistant_event_id);
        }
        this.connection.prepare("UPDATE runs SET status = 'failed', error_code = 'API_RESTARTED', completed_at = ? WHERE id = ?").run(timestamp, run.id);
        this.connection.prepare("INSERT INTO run_stream_events(run_id, event_json, created_at) VALUES (?, ?, ?)").run(
          run.id,
          JSON.stringify({ type: "run.failed", runId: run.id, code: "API_RESTARTED", message: "The local service restarted before this response completed. Regenerate it to continue." }),
          timestamp
        );
      }
      return interrupted.map((run) => run.id);
    })();
  }

  getRun(id: string): Record<string, unknown> | null {
    const row = this.connection.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ?? null;
  }

  pendingRuns(): Array<{ id: string; userEventId: string; quality: string }> {
    return (this.connection.prepare(
      "SELECT id, user_event_id, quality FROM runs WHERE status = 'pending' ORDER BY created_at"
    ).all() as Array<{ id: string; user_event_id: string; quality: string }>).map((row) => ({ id: row.id, userEventId: row.user_event_id, quality: row.quality }));
  }

  claimRunForExecution(id: string): boolean {
    return this.connection.prepare("UPDATE runs SET status = 'retrieving' WHERE id = ? AND status = 'pending'").run(id).changes === 1;
  }

  setRunStatus(id: string, status: string, options: { assistantEventId?: string; errorCode?: string } = {}): void {
    const terminal = ["complete", "cancelled", "failed"].includes(status);
    this.connection.prepare(`
      UPDATE runs SET status = ?, assistant_event_id = COALESCE(?, assistant_event_id), error_code = ?, completed_at = ? WHERE id = ?
    `).run(status, options.assistantEventId ?? null, options.errorCode ?? null, terminal ? now() : null, id);
  }

  requestRunCancellation(id: string): boolean {
    return this.connection.transaction(() => {
      const timestamp = now();
      const result = this.connection.prepare(
        "UPDATE runs SET cancellation_requested = 1 WHERE id = ? AND status NOT IN ('complete','failed','cancelled')"
      ).run(id);
      this.connection.prepare("UPDATE runs SET status = 'cancelled', error_code = 'CANCELLED', completed_at = ? WHERE id = ? AND status = 'pending'").run(timestamp, id);
      return result.changes > 0;
    })();
  }

  isRunCancellationRequested(id: string): boolean {
    const row = this.connection.prepare("SELECT cancellation_requested FROM runs WHERE id = ?").get(id) as { cancellation_requested: number } | undefined;
    return Boolean(row?.cancellation_requested);
  }

  appendRunStreamEvent(runId: string, event: RunStreamEvent): number {
    const result = this.connection.prepare(
      "INSERT INTO run_stream_events(run_id, event_json, created_at) VALUES (?, ?, ?)"
    ).run(runId, JSON.stringify(event), now());
    return Number(result.lastInsertRowid);
  }

  listRunStreamEvents(runId: string, afterId = 0): Array<{ id: number; event: RunStreamEvent }> {
    const rows = this.connection.prepare(
      "SELECT id, event_json FROM run_stream_events WHERE run_id = ? AND id > ? ORDER BY id ASC LIMIT 1000"
    ).all(runId, afterId) as Array<{ id: number; event_json: string }>;
    return rows.map((row) => ({ id: row.id, event: parseJson<RunStreamEvent>(row.event_json, { type: "run.failed", runId, code: "CORRUPT_EVENT", message: "A stored stream event was invalid." }) }));
  }

  enqueueJob(type: string, idempotencyKey: string, payload: Record<string, unknown>, priority = 0): JobRecord {
    return this.enqueueJobAt(type, idempotencyKey, payload, now(), priority);
  }

  enqueueJobAt(type: string, idempotencyKey: string, payload: Record<string, unknown>, availableAt: string, priority = 0): JobRecord {
    const existing = this.connection.prepare("SELECT * FROM jobs WHERE idempotency_key = ?").get(idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) return jobFromRow(existing);
    const id = uuidv7();
    const timestamp = now();
    this.connection.prepare(`
      INSERT INTO jobs(id, type, idempotency_key, payload_json, status, priority, available_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)
    `).run(id, type, idempotencyKey, JSON.stringify(payload), priority, availableAt, timestamp, timestamp);
    return jobFromRow(this.connection.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown>);
  }

  leaseJob(workerId: string, leaseMs = 30_000, acceptedTypes?: string[]): JobRecord | null {
    const lease = this.connection.transaction(() => {
      // Maintenance lock admission and job leasing share this write
      // transaction. This closes the check/lease race where import or vault
      // reset could observe zero running jobs after a worker's stale unlocked
      // read but before that worker changed a queued job to running.
      const maintenance = this.connection.prepare("SELECT value_json FROM settings WHERE key = 'maintenance.locked'")
        .get() as { value_json: string } | undefined;
      if (maintenance && parseJson<boolean>(maintenance.value_json, false)) return null;
      const timestamp = now();
      const expiration = new Date(Date.now() + leaseMs).toISOString();
      const typeFilter = acceptedTypes?.length ? `AND type IN (${acceptedTypes.map(() => "?").join(",")})` : "";
      const values = acceptedTypes ?? [];
      const row = this.connection.prepare(`
        SELECT * FROM jobs
        WHERE attempts < maximum_attempts
          AND available_at <= ?
          AND (status = 'queued' OR (status = 'running' AND lease_expires_at < ?))
          ${typeFilter}
        ORDER BY priority DESC, created_at ASC LIMIT 1
      `).get(timestamp, timestamp, ...values) as Record<string, unknown> | undefined;
      if (!row) return null;
      const nextAttempt = Number(row.attempts) + 1;
      const update = this.connection.prepare(`
        UPDATE jobs SET status = 'running', attempts = ?, lease_owner = ?, lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
        WHERE id = ? AND (status = 'queued' OR lease_expires_at < ?)
      `).run(nextAttempt, workerId, expiration, timestamp, timestamp, row.id, timestamp);
      if (update.changes === 0) return null;
      this.connection.prepare(`
        INSERT INTO job_attempts(id, job_id, attempt_number, worker_id, started_at, status)
        VALUES (?, ?, ?, ?, ?, 'running')
      `).run(uuidv7(), row.id, nextAttempt, workerId, timestamp);
      return jobFromRow(this.connection.prepare("SELECT * FROM jobs WHERE id = ?").get(row.id) as Record<string, unknown>);
    });
    // IMMEDIATE acquires the writer reservation before the lock read, so a
    // concurrent maintenance writer cannot commit between admission and lease.
    return lease.immediate();
  }

  heartbeatJob(id: string, workerId: string, leaseMs = 30_000): boolean {
    const timestamp = now();
    const result = this.connection.prepare(`
      UPDATE jobs SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND lease_owner = ? AND status = 'running'
    `).run(timestamp, new Date(Date.now() + leaseMs).toISOString(), timestamp, id, workerId);
    return result.changes > 0;
  }

  completeJob(id: string, workerId: string, result: unknown = {}): boolean {
    return this.connection.transaction(() => {
      const timestamp = now();
      const job = this.connection.prepare("SELECT attempts FROM jobs WHERE id = ? AND lease_owner = ?").get(id, workerId) as { attempts: number } | undefined;
      if (!job) return false;
      this.connection.prepare(`
        UPDATE jobs SET status = 'complete', result_json = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?
      `).run(JSON.stringify(result), timestamp, id);
      this.connection.prepare(`
        UPDATE job_attempts SET status = 'complete', completed_at = ? WHERE job_id = ? AND attempt_number = ?
      `).run(timestamp, id, job.attempts);
      return true;
    })();
  }

  failJob(id: string, workerId: string, errorCode: string): boolean {
    return this.connection.transaction(() => {
      const timestamp = now();
      const job = this.connection.prepare(
        "SELECT attempts, maximum_attempts FROM jobs WHERE id = ? AND lease_owner = ?"
      ).get(id, workerId) as { attempts: number; maximum_attempts: number } | undefined;
      if (!job) return false;
      const terminal = job.attempts >= job.maximum_attempts;
      const backoffMs = Math.min(60_000, 1_000 * 2 ** Math.max(0, job.attempts - 1));
      this.connection.prepare(`
        UPDATE jobs SET status = ?, available_at = ?, last_error_code = ?, lease_owner = NULL,
          lease_expires_at = NULL, updated_at = ? WHERE id = ?
      `).run(terminal ? "failed" : "queued", new Date(Date.now() + backoffMs).toISOString(), errorCode, timestamp, id);
      this.connection.prepare(`
        UPDATE job_attempts SET status = 'failed', error_code = ?, completed_at = ? WHERE job_id = ? AND attempt_number = ?
      `).run(errorCode, timestamp, id, job.attempts);
      return true;
    })();
  }

  retryJob(id: string): boolean {
    const result = this.connection.prepare(`
      UPDATE jobs SET status = 'queued', attempts = 0, available_at = ?, last_error_code = NULL, updated_at = ? WHERE id = ? AND status = 'failed'
    `).run(now(), now(), id);
    return result.changes > 0;
  }

  listJobs(limit = 100, offset = 0): JobRecord[] {
    return (this.connection.prepare("SELECT * FROM jobs ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?").all(Math.min(limit, 501), Math.max(0, offset)) as Array<Record<string, unknown>>).map(jobFromRow);
  }

  listJobsByTypePrefix(prefix: string, limit = 100, offset = 0): JobRecord[] {
    const escaped = prefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    return (this.connection.prepare("SELECT * FROM jobs WHERE type LIKE ? ESCAPE '\\' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?")
      .all(`${escaped}%`, Math.min(limit, 501), Math.max(0, offset)) as Array<Record<string, unknown>>).map(jobFromRow);
  }

  createSource(input: { type: string; title: string; uri?: string | null; contentHash: string; provenance?: unknown; freshnessClass?: string }): string {
    const id = uuidv7();
    this.connection.prepare(`
      INSERT INTO sources(id, type, title, uri, content_hash, provenance_json, freshness_class, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.type, input.title, input.uri ?? null, input.contentHash, JSON.stringify(input.provenance ?? {}), input.freshnessClass ?? "stable", now());
    return id;
  }

  createAttachment(input: { sourceId: string; filename: string; mediaType: string; size: number; storagePath: string; contentHash: string; status?: Attachment["status"] }): Attachment {
    const id = uuidv7();
    const createdAt = now();
    this.connection.prepare(`
      INSERT INTO attachments(id, source_id, filename, media_type, size, storage_path, content_hash, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.sourceId, input.filename, input.mediaType, input.size, input.storagePath, input.contentHash, input.status ?? "queued", createdAt);
    return { id, sourceId: input.sourceId, filename: input.filename, mediaType: input.mediaType, size: input.size, status: input.status ?? "queued", createdAt };
  }

  getAttachment(id: string): (Attachment & { storagePath: string; contentHash: string }) | null {
    const row = this.connection.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id), sourceId: String(row.source_id), filename: String(row.filename), mediaType: String(row.media_type),
      size: Number(row.size), status: row.status as Attachment["status"], createdAt: String(row.created_at),
      storagePath: String(row.storage_path), contentHash: String(row.content_hash)
    };
  }

  updateAttachmentStatus(id: string, status: Attachment["status"], errorCode?: string): void {
    this.connection.prepare("UPDATE attachments SET status = ?, error_code = ? WHERE id = ?").run(status, errorCode ?? null, id);
  }

  addSourceChunks(sourceId: string, chunks: Array<{
    text: string;
    location?: unknown;
    tokenCount?: number;
    parserVersion?: string;
    chunkerVersion?: string;
    metadata?: unknown;
  }>): string[] {
    return this.addSourceChunksDetailed(sourceId, chunks).chunkIds;
  }

  addSourceChunksDetailed(sourceId: string, chunks: Array<{
    text: string;
    location?: unknown;
    tokenCount?: number;
    parserVersion?: string;
    chunkerVersion?: string;
    metadata?: unknown;
  }>): SourceChunkWriteResult {
    const desired = chunks.map((chunk, ordinal) => ({
      ...chunk,
      ordinal,
      contentHash: stableHash(chunk.text)
    }));
    return this.connection.transaction(() => {
      const existing = this.connection.prepare(`
        SELECT id, ordinal, content_hash FROM source_chunks
        WHERE source_id = ? ORDER BY ordinal
      `).all(sourceId) as Array<{ id: string; ordinal: number; content_hash: string }>;
      const exactReplay = existing.length === desired.length && existing.every((row, index) =>
        row.ordinal === desired[index]!.ordinal && row.content_hash === desired[index]!.contentHash
      );
      if (exactReplay) {
        // Preserve stable chunk identities while refreshing non-identity
        // derivation metadata. A worker may restart after a parser/chunker
        // upgrade; equal text must not leave the source-level provenance on a
        // new version while its reusable chunk rows still claim the old one.
        const refresh = this.connection.prepare(`
          UPDATE source_chunks SET text_content = ?, location_json = ?, token_count = ?,
            parser_version = ?, chunker_version = ?, metadata_json = ?
          WHERE id = ?
        `);
        for (let index = 0; index < existing.length; index += 1) {
          const row = existing[index]!;
          const chunk = desired[index]!;
          refresh.run(
            chunk.text,
            JSON.stringify(chunk.location ?? {}),
            chunk.tokenCount ?? Math.ceil(chunk.text.length / 4),
            chunk.parserVersion ?? "unknown",
            chunk.chunkerVersion ?? "unknown",
            JSON.stringify(chunk.metadata ?? {}),
            row.id
          );
        }
        return { chunkIds: existing.map((row) => row.id), exactReplay: true, invalidatedClaimIds: [], invalidatedTopicIds: [] };
      }

      let invalidatedClaimIds: string[] = [];
      let invalidatedTopicIds: string[] = [];
      if (existing.length > 0) {
        // A prior attempt committed a different or partial chunk set. Remove
        // every structured derivative of the superseded IDs before replacing
        // the UNIQUE(source_id, ordinal) rows, so retry cannot leave dangling
        // vectors or provenance pointing at data no longer in the source.
        const oldIds = existing.map((row) => row.id);
        const marks = oldIds.map(() => "?").join(",");
        const affectedClaims = this.connection.prepare(`
          SELECT DISTINCT claim.id, claim.topic_id FROM claim_sources source
          JOIN claims claim ON claim.id = source.claim_id
          WHERE source.source_id IN (${marks})
        `).all(...oldIds) as Array<{ id: string; topic_id: string | null }>;
        const affectedClaimIds = affectedClaims.map((row) => row.id);
        const claimPredicate = affectedClaimIds.length > 0
          ? ` OR provenance.claim_id IN (${affectedClaimIds.map(() => "?").join(",")})`
          : "";
        const revisionTopics = this.connection.prepare(`
          SELECT DISTINCT revision.topic_id FROM topic_page_revisions revision
          JOIN page_section_sources provenance ON provenance.revision_id = revision.id
          WHERE provenance.source_id IN (${marks})${claimPredicate}
        `).all(...oldIds, ...affectedClaimIds) as Array<{ topic_id: string }>;
        const affectedTopics = new Set<string>([
          ...affectedClaims.flatMap((row) => row.topic_id ? [row.topic_id] : []),
          ...revisionTopics.map((row) => row.topic_id)
        ]);
        this.#addCompiledParentTopics(affectedTopics);
        invalidatedClaimIds = [...new Set(affectedClaimIds)].sort();
        invalidatedTopicIds = [...affectedTopics].sort();

        if (invalidatedTopicIds.length > 0) {
          const topicMarks = invalidatedTopicIds.map(() => "?").join(",");
          const generatedTopicIds = (this.connection.prepare(`
            SELECT page.id FROM topic_pages page
            JOIN topic_page_revisions revision
              ON revision.topic_id = page.id AND revision.revision_number = page.active_revision
            WHERE page.id IN (${topicMarks}) AND revision.author_type <> 'user'
          `).all(...invalidatedTopicIds) as Array<{ id: string }>).map((row) => row.id);
          if (generatedTopicIds.length > 0) {
            const generatedMarks = generatedTopicIds.map(() => "?").join(",");
            // Hide invalid generated material immediately. The worker consumes
            // invalidatedTopicIds synchronously before reporting the source as
            // ready and recreates only evidence-supported search/vector rows.
            this.connection.prepare(`DELETE FROM topic_fts WHERE topic_id IN (${generatedMarks})`).run(...generatedTopicIds);
            this.connection.prepare(`DELETE FROM vectors WHERE source_type = 'topic' AND source_id IN (${generatedMarks})`).run(...generatedTopicIds);
          }
        }
        this.connection.prepare(`DELETE FROM vectors WHERE source_id IN (${marks})`).run(...oldIds);
        this.connection.prepare(`DELETE FROM page_section_sources WHERE source_id IN (${marks})`).run(...oldIds);
        this.connection.prepare(`DELETE FROM claim_sources WHERE source_id IN (${marks})`).run(...oldIds);
        this.connection.prepare(`DELETE FROM entity_aliases WHERE source_id IN (${marks})`).run(...oldIds);
        this.connection.prepare(`DELETE FROM memory_pins WHERE object_id IN (${marks})`).run(...oldIds);
        this.connection.prepare(`DELETE FROM context_refs WHERE ref_value IN (${marks})`).run(...oldIds);
        this.connection.prepare(`DELETE FROM edges WHERE source_id IN (${marks}) OR target_id IN (${marks})`).run(...oldIds, ...oldIds);
        this.#scrubEvidenceReferences("edges", oldIds);
        this.#scrubEvidenceReferences("page_links", oldIds);

        if (affectedClaimIds.length > 0) {
          const claimMarks = affectedClaimIds.map(() => "?").join(",");
          const unsupported = (this.connection.prepare(`
            SELECT claim.id FROM claims claim LEFT JOIN claim_sources source ON source.claim_id = claim.id
            WHERE claim.id IN (${claimMarks}) GROUP BY claim.id HAVING COUNT(source.source_id) = 0
          `).all(...affectedClaimIds) as Array<{ id: string }>).map((row) => row.id);
          if (unsupported.length > 0) {
            const unsupportedMarks = unsupported.map(() => "?").join(",");
            this.connection.prepare(`DELETE FROM page_section_sources WHERE claim_id IN (${unsupportedMarks})`).run(...unsupported);
            this.connection.prepare(`DELETE FROM vectors WHERE source_id IN (${unsupportedMarks})`).run(...unsupported);
            this.connection.prepare(`DELETE FROM memory_pins WHERE object_id IN (${unsupportedMarks})`).run(...unsupported);
            this.connection.prepare(`DELETE FROM edges WHERE source_id IN (${unsupportedMarks}) OR target_id IN (${unsupportedMarks})`).run(...unsupported, ...unsupported);
            this.#scrubEvidenceReferences("edges", unsupported);
            this.#scrubEvidenceReferences("page_links", unsupported);
            this.connection.prepare(`DELETE FROM claims WHERE id IN (${unsupportedMarks})`).run(...unsupported);
          }
        }
        this.connection.prepare("DELETE FROM source_chunks WHERE source_id = ?").run(sourceId);
      }

      const insert = this.connection.prepare(`
        INSERT INTO source_chunks(
          id, source_id, ordinal, text_content, location_json, token_count,
          content_hash, parser_version, chunker_version, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const chunkIds = desired.map((chunk) => {
        const id = uuidv7();
        insert.run(
          id,
          sourceId,
          chunk.ordinal,
          chunk.text,
          JSON.stringify(chunk.location ?? {}),
          chunk.tokenCount ?? Math.ceil(chunk.text.length / 4),
          chunk.contentHash,
          chunk.parserVersion ?? "unknown",
          chunk.chunkerVersion ?? "unknown",
          JSON.stringify(chunk.metadata ?? {}),
          now()
        );
        return id;
      });
      return { chunkIds, exactReplay: false, invalidatedClaimIds, invalidatedTopicIds };
    })();
  }

  registerPromptVersion(input: { name: string; semanticVersion: string; content: string; schemaVersion: string }): string {
    const existing = this.connection.prepare("SELECT id FROM prompt_versions WHERE name = ? AND semantic_version = ?")
      .get(input.name, input.semanticVersion) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = uuidv7();
    this.connection.prepare(`
      INSERT INTO prompt_versions(id, name, semantic_version, content_hash, schema_version, activated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, input.name, input.semanticVersion, stableHash(input.content), input.schemaVersion, now());
    return id;
  }

  addContextRef(eventId: string, refType: string, refValue: string, metadata: unknown = {}): string {
    const existing = this.connection.prepare("SELECT id FROM context_refs WHERE event_id = ? AND ref_type = ? AND ref_value = ? LIMIT 1")
      .get(eventId, refType, refValue) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = uuidv7();
    this.connection.prepare("INSERT INTO context_refs(id, event_id, ref_type, ref_value, metadata_json) VALUES (?, ?, ?, ?, ?)")
      .run(id, eventId, refType, refValue, JSON.stringify(metadata));
    return id;
  }

  listSourceChunks(sourceId: string, limit = 10_000, offset = 0): Array<Record<string, unknown>> {
    return this.connection.prepare("SELECT * FROM source_chunks WHERE source_id = ? ORDER BY ordinal LIMIT ? OFFSET ?").all(sourceId, Math.min(limit, 10_000), Math.max(0, offset)) as Array<Record<string, unknown>>;
  }

  authorizeWorkspace(path: string, displayName: string): string {
    const id = uuidv7();
    const timestamp = now();
    this.connection.prepare(`
      INSERT INTO workspace_roots(id, path, display_name, authorized, read_only, authorized_at, created_at)
      VALUES (?, ?, ?, 1, 1, ?, ?)
      ON CONFLICT(path) DO UPDATE SET display_name = excluded.display_name, authorized = 1, authorized_at = excluded.authorized_at
    `).run(id, path, displayName, timestamp, timestamp);
    const row = this.connection.prepare("SELECT id FROM workspace_roots WHERE path = ?").get(path) as { id: string };
    return row.id;
  }

  listWorkspaces(limit = 100, offset = 0): Array<Record<string, unknown>> {
    return this.connection.prepare("SELECT * FROM workspace_roots ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?").all(Math.min(limit, 501), Math.max(0, offset)) as Array<Record<string, unknown>>;
  }

  search(query: string, limit = 30, options: {
    offset?: number;
    types?: SearchResult["type"][];
    role?: "all" | "user" | "assistant" | "tool";
    status?: "all" | "current" | "superseded";
    from?: string | null;
  } = {}): SearchResult[] {
    const fts = safeFtsQuery(query);
    if (!fts) return [];
    const offset = Math.max(0, options.offset ?? 0);
    const requested = new Set(options.types ?? []);
    const wants = (type: SearchResult["type"]) => requested.size === 0 || requested.has(type);
    // Offset pagination has to materialize enough candidates from every search
    // channel to rank the requested global page. The former 500-row cap made
    // every cursor at or beyond 500 silently return an incomplete/empty page.
    // SQLite LIMIT does not preallocate this value; it only bounds rows that
    // actually match, so deep pages remain correct without a hidden cutoff.
    const fetchLimit = Math.max(100, offset + Math.max(1, Math.min(limit, 100)) + 50);
    const results: SearchResult[] = [];
    const addRows = (found: Array<Record<string, unknown>>, fallbackTags: string[] = []) => {
      for (const row of found) {
        const rawTags = parseJson<string[]>(row.tags_json, fallbackTags);
        const rawScore = Number(row.raw_score ?? 1);
        // FTS5 bm25() ranks better matches with smaller (normally negative)
        // values. Keep the public score in [0, 1] while preserving that order;
        // the old absolute-value transform inverted relevance during the final
        // cross-channel sort and destabilized offset pages as the pool grew.
        const score = rawScore <= 0
          ? 0.5 + (0.5 * Math.abs(rawScore)) / (1 + Math.abs(rawScore))
          : 1 / (1 + rawScore);
        results.push({
          id: String(row.id), type: row.type as SearchResult["type"], title: String(row.title), snippet: String(row.snippet),
          score, timestamp: row.timestamp ? String(row.timestamp) : null,
          sourceEventId: row.source_event_id ? String(row.source_event_id) : null,
          evidenceId: row.evidence_id ? String(row.evidence_id) : null,
          topicRevisionId: row.topic_revision_id ? String(row.topic_revision_id) : null,
          topicRevision: row.topic_revision === undefined || row.topic_revision === null ? null : Number(row.topic_revision),
          tags: [...new Set([...rawTags, ...(row.state ? [String(row.state)] : []), ...(row.role ? [String(row.role)] : [])])]
        });
      }
    };

    if (wants("event")) {
      const clauses = ["event_fts MATCH ?"];
      const parameters: unknown[] = [fts];
      if (options.role && options.role !== "all") { clauses.push("e.role = ?"); parameters.push(options.role); }
      if (options.status === "current") clauses.push("e.active = 1");
      if (options.status === "superseded") clauses.push("e.active = 0");
      if (options.from) { clauses.push("e.created_at >= ?"); parameters.push(options.from); }
      parameters.push(fetchLimit);
      addRows(this.connection.prepare(`
        SELECT e.id, 'event' AS type, CASE e.role WHEN 'user' THEN 'You' WHEN 'assistant' THEN 'Continuum' ELSE 'Tool' END AS title,
          snippet(event_fts, 1, '<mark>', '</mark>', '…', 18) AS snippet, bm25(event_fts) AS raw_score,
          e.id AS source_event_id, e.created_at AS timestamp, e.role, CASE e.active WHEN 1 THEN 'current' ELSE 'superseded' END AS state
        FROM event_fts JOIN events e ON e.id = event_fts.event_id WHERE ${clauses.join(" AND ")}
        ORDER BY raw_score, e.created_at DESC, e.id DESC LIMIT ?
      `).all(...parameters) as Array<Record<string, unknown>>);
    }

    if ((!options.role || options.role === "all") && wants("topic") && options.status !== "superseded") {
      const clauses = ["topic_fts MATCH ?"];
      const parameters: unknown[] = [fts];
      if (options.from) { clauses.push("tp.updated_at >= ?"); parameters.push(options.from); }
      parameters.push(fetchLimit);
      addRows(this.connection.prepare(`
        SELECT tp.id, 'topic' AS type, tp.title, snippet(topic_fts, 2, '<mark>', '</mark>', '…', 18) AS snippet,
          bm25(topic_fts) AS raw_score, NULL AS source_event_id, NULL AS evidence_id,
          tpr.id AS topic_revision_id, tpr.revision_number AS topic_revision,
          tp.updated_at AS timestamp, tp.tags_json, 'current' AS state
        FROM topic_fts JOIN topic_pages tp ON tp.id = topic_fts.topic_id
        JOIN topic_page_revisions tpr ON tpr.topic_id = tp.id AND tpr.revision_number = tp.active_revision
        WHERE ${clauses.join(" AND ")}
          AND (tpr.author_type = 'user' OR NOT EXISTS (
            SELECT 1 FROM page_section_sources stale
            JOIN events evidence_event ON evidence_event.id = stale.source_id
            WHERE stale.revision_id = tpr.id AND evidence_event.role = 'assistant' AND evidence_event.active = 0
          ))
        ORDER BY raw_score, tp.updated_at DESC, tp.id DESC LIMIT ?
      `).all(...parameters) as Array<Record<string, unknown>>);
    }
    if ((!options.role || options.role === "all") && wants("topic") && options.status !== "current") {
      const clauses = ["topic_revision_fts MATCH ?", "tpr.revision_number <> tp.active_revision"];
      const parameters: unknown[] = [fts];
      if (options.from) { clauses.push("tpr.created_at >= ?"); parameters.push(options.from); }
      parameters.push(fetchLimit);
      addRows(this.connection.prepare(`
        SELECT tp.id, 'topic' AS type, tp.title,
          snippet(topic_revision_fts, 3, '<mark>', '</mark>', '…', 18) AS snippet,
          bm25(topic_revision_fts) AS raw_score, NULL AS source_event_id, NULL AS evidence_id,
          tpr.id AS topic_revision_id, tpr.revision_number AS topic_revision, tpr.created_at AS timestamp,
          tp.tags_json, 'superseded' AS state
        FROM topic_revision_fts JOIN topic_pages tp ON tp.id = topic_revision_fts.topic_id
        JOIN topic_page_revisions tpr ON tpr.id = topic_revision_fts.revision_id
        WHERE ${clauses.join(" AND ")} ORDER BY raw_score, tpr.created_at DESC, tpr.id DESC LIMIT ?
      `).all(...parameters) as Array<Record<string, unknown>>);
    }

    if ((!options.role || options.role === "all") && wants("claim")) {
      const clauses = ["claim_fts MATCH ?"];
      const parameters: unknown[] = [fts];
      const freshnessExpired = "c.freshness_expires_at IS NOT NULL AND c.freshness_expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AND c.status IN ('current','conflicted')";
      const hasActiveEvidence = `EXISTS (
        SELECT 1 FROM claim_sources active_source
        LEFT JOIN events active_event ON active_event.id = active_source.source_id
        WHERE active_source.claim_id = c.id AND (active_event.id IS NULL OR active_event.active = 1)
      )`;
      if (options.status === "current") clauses.push(`c.status IN ('current','conflicted') AND NOT (${freshnessExpired}) AND ${hasActiveEvidence}`);
      if (options.status === "superseded") clauses.push(`(c.status IN ('superseded','historical','expired') OR (${freshnessExpired}) OR NOT ${hasActiveEvidence})`);
      if (options.from) { clauses.push("c.observed_at >= ?"); parameters.push(options.from); }
      parameters.push(fetchLimit);
      addRows(this.connection.prepare(`
        SELECT c.id, 'claim' AS type, c.subject || ' ' || c.predicate AS title,
          snippet(claim_fts, 3, '<mark>', '</mark>', '…', 18) AS snippet, bm25(claim_fts) AS raw_score,
          (SELECT source_id FROM claim_sources WHERE claim_id = c.id AND source_type = 'event' LIMIT 1) AS source_event_id,
          c.observed_at AS timestamp,
          CASE WHEN ${freshnessExpired} THEN 'expired' ELSE c.status END AS state
        FROM claim_fts JOIN claims c ON c.id = claim_fts.claim_id
        WHERE ${clauses.join(" AND ")} ORDER BY raw_score, c.observed_at DESC, c.id DESC LIMIT ?
      `).all(...parameters) as Array<Record<string, unknown>>);
    }

    if ((!options.role || options.role === "all") && (wants("source") || wants("attachment"))) {
      const clauses = ["chunk_fts MATCH ?"];
      const parameters: unknown[] = [fts];
      const sourceStatus = `CASE WHEN s.freshness_class = 'expired' OR (
        json_valid(s.provenance_json) AND
        json_extract(s.provenance_json, '$.freshnessExpiresAt') IS NOT NULL AND
        json_extract(s.provenance_json, '$.freshnessExpiresAt') <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      ) THEN 'expired' ELSE 'current' END`;
      if (options.from) { clauses.push("sc.created_at >= ?"); parameters.push(options.from); }
      if (options.status === "current") clauses.push(`(${sourceStatus}) = 'current'`);
      if (options.status === "superseded") clauses.push(`(${sourceStatus}) = 'expired'`);
      if (requested.size) {
        if (wants("attachment") && !wants("source")) clauses.push("a.id IS NOT NULL");
        if (wants("source") && !wants("attachment")) clauses.push("a.id IS NULL");
      }
      parameters.push(fetchLimit);
      addRows(this.connection.prepare(`
        SELECT COALESCE(a.id, s.id) AS id, CASE WHEN a.id IS NULL THEN 'source' ELSE 'attachment' END AS type,
          COALESCE(a.filename, s.title) AS title, snippet(chunk_fts, 2, '<mark>', '</mark>', '…', 18) AS snippet,
          bm25(chunk_fts) AS raw_score, NULL AS source_event_id, sc.id AS evidence_id, sc.created_at AS timestamp,
          json_array(s.type, s.freshness_class) AS tags_json, ${sourceStatus} AS state
        FROM chunk_fts JOIN source_chunks sc ON sc.id = chunk_fts.chunk_id JOIN sources s ON s.id = sc.source_id
        LEFT JOIN attachments a ON a.source_id = s.id WHERE ${clauses.join(" AND ")}
        ORDER BY raw_score, sc.created_at DESC, sc.id DESC LIMIT ?
      `).all(...parameters) as Array<Record<string, unknown>>);
    }

    if ((!options.role || options.role === "all") && wants("entity")) {
      const pattern = `%${(query.normalize("NFKC").match(/[\p{L}\p{N}_-]+/u)?.[0] ?? "").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      const entityClauses = ["(display_name LIKE ? ESCAPE '\\' OR canonical_description LIKE ? ESCAPE '\\')"];
      const entityParameters: unknown[] = [pattern, pattern];
      if (options.status === "current") entityClauses.push("status = 'active'");
      if (options.status === "superseded") entityClauses.push("status <> 'active'");
      if (options.from) { entityClauses.push("updated_at >= ?"); entityParameters.push(options.from); }
      entityParameters.push(fetchLimit);
      addRows(this.connection.prepare(`
        SELECT id, 'entity' AS type, display_name AS title, canonical_description AS snippet, 2 AS raw_score,
          NULL AS source_event_id, updated_at AS timestamp, json_array('entity', core_type) AS tags_json, 'current' AS state
        FROM entities WHERE ${entityClauses.join(" AND ")} ORDER BY updated_at DESC, id DESC LIMIT ?
      `).all(...entityParameters) as Array<Record<string, unknown>>);
    }

    if ((!options.role || options.role === "all" || options.role === "tool") && wants("tool_result") && options.status !== "superseded") {
      const pattern = `%${(query.normalize("NFKC").match(/[\p{L}\p{N}_-]+/u)?.[0] ?? "").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      const toolClauses = ["(tool_name LIKE ? ESCAPE '\\' OR output_text LIKE ? ESCAPE '\\')"];
      const toolParameters: unknown[] = [pattern, pattern];
      if (options.from) { toolClauses.push("started_at >= ?"); toolParameters.push(options.from); }
      toolParameters.push(fetchLimit);
      addRows(this.connection.prepare(`
        SELECT id, 'tool_result' AS type, tool_name AS title, substr(output_text, 1, 500) AS snippet, 2 AS raw_score,
          (SELECT user_event_id FROM runs WHERE runs.id = tool_executions.run_id) AS source_event_id,
          started_at AS timestamp, json_array('tool') AS tags_json, 'current' AS state
        FROM tool_executions WHERE ${toolClauses.join(" AND ")} ORDER BY started_at DESC, id DESC LIMIT ?
      `).all(...toolParameters) as Array<Record<string, unknown>>);
    }

    const deduplicated = new Map<string, SearchResult>();
    for (const result of results) {
      const key = `${result.type}:${result.id}:${result.topicRevisionId ?? result.evidenceId ?? ""}`;
      const existing = deduplicated.get(key);
      if (!existing || result.score > existing.score) deduplicated.set(key, result);
    }
    return [...deduplicated.values()]
      .sort((left, right) => right.score - left.score
        || String(right.timestamp ?? "").localeCompare(String(left.timestamp ?? ""))
        || left.type.localeCompare(right.type)
        || right.id.localeCompare(left.id)
        || String(right.topicRevisionId ?? right.evidenceId ?? "").localeCompare(String(left.topicRevisionId ?? left.evidenceId ?? "")))
      .slice(offset, offset + Math.max(1, Math.min(limit, 100)));
  }

  #synchronizeInstallationBudget(): void {
    if (!this.#installationBudget) return;
    const committed = this.connection.prepare(`
      SELECT id, reservation_id, estimated_cost_usd, created_at
      FROM installation_budget_ledger ORDER BY created_at, id
    `).all() as Array<{
      id: string;
      reservation_id: string | null;
      estimated_cost_usd: number;
      created_at: string;
    }>;
    const reserved = this.connection.prepare(`
      SELECT id, estimated_cost_usd, created_at
      FROM budget_reservations WHERE status = 'reserved' ORDER BY created_at, id
    `).all() as Array<{ id: string; estimated_cost_usd: number; created_at: string }>;
    const entries: LegacyInstallationBudgetEntry[] = [
      ...committed.map((row) => ({
        callId: row.reservation_id ?? `legacy-application:${row.id}`,
        category: "application" as const,
        estimatedCostUsd: row.estimated_cost_usd,
        actualCostUsd: row.estimated_cost_usd,
        status: "committed" as const,
        createdAt: row.created_at
      })),
      ...reserved.map((row) => ({
        callId: row.id,
        category: "application" as const,
        estimatedCostUsd: row.estimated_cost_usd,
        actualCostUsd: null,
        status: "reserved" as const,
        createdAt: row.created_at
      }))
    ];
    if (entries.length > 0) this.#installationBudget.reconcileLegacyEntries(entries);
  }

  #releaseOrphanedInstallationReservations(): void {
    if (!this.#installationBudget || !this.#installationBudgetOwnerScope) return;
    const admittedCallIds = new Set((this.connection.prepare("SELECT id FROM budget_reservations").all() as Array<{ id: string }>).map((row) => row.id));
    this.#installationBudget.releaseOrphanedBeforeCall({ ownerScope: this.#installationBudgetOwnerScope, admittedCallIds });
  }

  #reconcileCanonicalReservations(conservativeOnlyIfExpired: boolean): void {
    if (!this.#installationBudget) return;
    const predicate = conservativeOnlyIfExpired ? "AND expires_at <= ?" : "";
    const parameters = conservativeOnlyIfExpired ? [now()] : [];
    const reservations = this.connection.prepare(`
      SELECT id, estimated_cost_usd FROM budget_reservations
      WHERE status = 'reserved' ${predicate} ORDER BY created_at, id
    `).all(...parameters) as Array<{ id: string; estimated_cost_usd: number }>;
    for (const reservation of reservations) {
      this.#commitCanonicalConservatively(reservation.id, reservation.estimated_cost_usd);
    }
  }

  #commitCanonicalConservatively(id: string, estimatedCostUsd: number): void {
    if (!this.#installationBudget) return;
    try {
      this.#installationBudget.commitConservatively(id, estimatedCostUsd);
    } catch (error) {
      if (!(error instanceof Error) || !/No active reservation/.test(error.message)) throw error;
      this.#installationBudget.reconcileCommitted(id, estimatedCostUsd);
    }
  }

  recordModelCall(input: {
    id?: string; runId?: string | null; provider: string; model: string; purpose: string; promptVersion: string;
    responseId?: string | null; inputTokens: number; outputTokens: number; latencyMs: number; status: string;
    estimatedCostUsd: number; category?: string; traceMetadata?: unknown; reservationId?: string | null;
  }): string {
    this.#assertUsage(input.inputTokens, input.outputTokens, input.estimatedCostUsd);
    if (input.provider !== "mock" && !input.reservationId) {
      const error = new Error("Paid provider accounting requires a durable budget reservation.");
      error.name = "BudgetReservationRequiredError";
      throw error;
    }
    let installationBudgetOverrun: Error | null = null;
    if (input.reservationId && this.#installationBudget) {
      const reservation = this.connection.prepare(
        "SELECT status FROM budget_reservations WHERE id = ?"
      ).get(input.reservationId) as { status: "reserved" | "settled" | "released" } | undefined;
      if (!reservation) {
        const error = new Error("The provider call has no matching durable budget reservation.");
        error.name = "BudgetReservationMissingError";
        throw error;
      }
      if (reservation.status === "released") {
        const error = new Error("A released budget reservation cannot be charged.");
        error.name = "BudgetReservationReleasedError";
        throw error;
      }
      try {
        this.#installationBudget.reconcileCommitted(input.reservationId, input.estimatedCostUsd);
      } catch (error) {
        if (error instanceof Error && error.name === "BudgetExceededError") installationBudgetOverrun = error;
        else throw error;
      }
    }
    const transaction = this.connection.transaction(() => {
      const timestamp = now();
      const reservation = input.reservationId ? this.connection.prepare(`
        SELECT id, estimated_cost_usd, status FROM budget_reservations WHERE id = ?
      `).get(input.reservationId) as { id: string; estimated_cost_usd: number; status: "reserved" | "settled" | "released" } | undefined : undefined;
      if (input.reservationId && !reservation) {
        const error = new Error("The provider call has no matching durable budget reservation.");
        error.name = "BudgetReservationMissingError";
        throw error;
      }
      if (reservation?.status === "released") {
        const error = new Error("A released budget reservation cannot be charged.");
        error.name = "BudgetReservationReleasedError";
        throw error;
      }

      const existing = input.reservationId ? this.connection.prepare(`
        SELECT id, model_call_id, estimated_cost_usd, accounting_status
        FROM installation_budget_ledger WHERE reservation_id = ?
      `).get(input.reservationId) as { id: string; model_call_id: string | null; estimated_cost_usd: number; accounting_status: "actual" | "conservative" } | undefined : undefined;
      if (existing?.model_call_id) return existing.model_call_id;

      const id = input.id ?? uuidv7();
      this.connection.prepare(`
        INSERT INTO model_calls(id, run_id, provider, model, purpose, prompt_version, response_id, input_tokens, output_tokens,
          latency_ms, status, trace_metadata_json, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, input.runId ?? null, input.provider, input.model, input.purpose, input.promptVersion, input.responseId ?? null,
        input.inputTokens, input.outputTokens, input.latencyMs, input.status, JSON.stringify(input.traceMetadata ?? {}), timestamp, timestamp);

      if (existing && reservation?.status === "settled") {
        // An expired/uncertain call was already charged conservatively. Attach
        // the late completion to that one accounting row and keep only the
        // larger of the conservative reserve and provider-reported actual cost.
        const reconciledCost = Math.max(existing.estimated_cost_usd, input.estimatedCostUsd);
        const accountingStatus = input.estimatedCostUsd > existing.estimated_cost_usd ? "actual" : existing.accounting_status;
        this.connection.prepare(`
          UPDATE installation_budget_ledger
          SET model_call_id = ?, provider = ?, model = ?, input_tokens = ?, output_tokens = ?,
            estimated_cost_usd = ?, accounting_status = ? WHERE id = ?
        `).run(id, input.provider, input.model, input.inputTokens, input.outputTokens, reconciledCost, accountingStatus, existing.id);
        this.connection.prepare(`
          UPDATE budget_ledger
          SET model_call_id = ?, provider = ?, model = ?, input_tokens = ?, output_tokens = ?, estimated_cost_usd = ?
          WHERE id = ?
        `).run(id, input.provider, input.model, input.inputTokens, input.outputTokens, reconciledCost, existing.id);
      } else {
        if (reservation) {
          const changed = this.connection.prepare(`
            UPDATE budget_reservations SET status = 'settled', settled_at = ? WHERE id = ? AND status = 'reserved'
          `).run(timestamp, reservation.id).changes;
          if (changed !== 1) throw new Error("The budget reservation was concurrently settled.");
        }
        const ledgerId = uuidv7();
        const category = input.category ?? input.purpose;
        this.connection.prepare(`
          INSERT INTO budget_ledger(id, model_call_id, category, provider, model, input_tokens, output_tokens, estimated_cost_usd, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(ledgerId, id, category, input.provider, input.model, input.inputTokens, input.outputTokens, input.estimatedCostUsd, timestamp);
        this.connection.prepare(`
          INSERT INTO installation_budget_ledger(
            id, reservation_id, model_call_id, category, provider, model, input_tokens, output_tokens,
            estimated_cost_usd, accounting_status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'actual', ?)
        `).run(ledgerId, input.reservationId ?? null, id, category, input.provider, input.model, input.inputTokens, input.outputTokens, input.estimatedCostUsd, timestamp);
      }
      this.recordBudgetThresholds(timestamp);
      return id;
    });
    const modelCallId = transaction.immediate();
    if (installationBudgetOverrun) throw installationBudgetOverrun;
    return modelCallId;
  }

  recordExternalCost(input: { category: string; provider: string; model: string; estimatedCostUsd: number; reservationId?: string | null }): string {
    return this.recordModelCall({
      provider: input.provider,
      model: input.model,
      purpose: input.category,
      promptVersion: "external-cost-v1",
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      status: "complete",
      estimatedCostUsd: input.estimatedCostUsd,
      reservationId: input.reservationId ?? null
    });
  }

  private recordBudgetThresholds(timestamp: string): void {
    const state = this.connection.prepare(`
      SELECT
        (SELECT COALESCE(SUM(estimated_cost_usd), 0) FROM installation_budget_ledger) AS spent,
        (SELECT COALESCE(SUM(estimated_cost_usd), 0) FROM budget_reservations WHERE status = 'reserved' AND expires_at > ?) AS reserved
    `).get(timestamp) as { spent: number; reserved: number };
    const total = state.spent + state.reserved;
    for (const threshold of [20, 50, 75, 90]) {
      if (total < threshold) continue;
      this.connection.prepare("INSERT OR IGNORE INTO settings(key, value_json, updated_at) VALUES (?, ?, ?)").run(
        `budget.warning.${threshold}`, JSON.stringify({ thresholdUsd: threshold, firstReachedAt: timestamp }), timestamp
      );
    }
  }

  budgetSummary(hardLimitUsd: number): Record<string, unknown> {
    this.#assertBudgetInputs(hardLimitUsd, 0, 1);
    this.#reconcileCanonicalReservations(true);
    this.#reconcileExpiredBudgetReservations();
    const installation = this.#installationBudget?.snapshot();
    const localTotal = this.connection.prepare(`
      SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total,
        COALESCE(SUM(input_tokens), 0) AS input_tokens,
        COALESCE(SUM(output_tokens), 0) AS output_tokens, COUNT(*) AS calls
      FROM installation_budget_ledger
    `).get() as { total: number; input_tokens: number; output_tokens: number; calls: number };
    const byCategory = this.connection.prepare(`
      SELECT category, SUM(estimated_cost_usd) AS cost, COUNT(*) AS calls
      FROM installation_budget_ledger GROUP BY category ORDER BY cost DESC
    `).all() as Array<Record<string, unknown>>;
    const timestamp = now();
    const localReservations = this.connection.prepare(`
      SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total, COUNT(*) AS count
      FROM budget_reservations WHERE status = 'reserved' AND expires_at > ?
    `).get(timestamp) as { total: number; count: number };
    const spentUsd = installation?.committedUsd ?? localTotal.total;
    const reservedUsd = installation?.reservedUsd ?? localReservations.total;
    const activeReservations = installation
      ? installation.entries.filter((entry) => entry.status === "reserved").length
      : localReservations.count;
    const allocatedUsd = spentUsd + reservedUsd;
    const availableUsd = installation?.breached ? 0 : Math.max(0, hardLimitUsd - allocatedUsd);
    return {
      hardLimitUsd,
      spentUsd,
      reservedUsd,
      activeReservations,
      allocatedUsd,
      availableUsd,
      remainingUsd: availableUsd,
      percentUsed: Math.min(100, allocatedUsd / hardLimitUsd * 100),
      spentPercentUsed: Math.min(100, spentUsd / hardLimitUsd * 100),
      inputTokens: localTotal.input_tokens,
      outputTokens: localTotal.output_tokens,
      calls: localTotal.calls,
      byCategory,
      installationBudgetLedgerPath: installation?.ledgerPath ?? null,
      installationBudgetBreached: installation?.breached ?? false,
      ledgerCreatedAt: installation?.ledgerCreatedAt ?? null,
      warningThresholdsReached: installation?.warningThresholdsReached ?? [20, 50, 75, 90].filter((threshold) => allocatedUsd >= threshold)
    };
  }

  assertBudgetAvailable(hardLimitUsd: number, estimatedNextCostUsd = 0): void {
    this.#assertBudgetInputs(hardLimitUsd, estimatedNextCostUsd, 1);
    const summary = this.budgetSummary(hardLimitUsd) as { allocatedUsd: number; installationBudgetBreached: boolean };
    if (summary.installationBudgetBreached || summary.allocatedUsd + estimatedNextCostUsd > hardLimitUsd) {
      const error = new Error(`The $${hardLimitUsd.toFixed(2)} API budget limit has been reached.`);
      error.name = "BudgetExceededError";
      throw error;
    }
  }

  reserveBudget(hardLimitUsd: number, estimatedCostUsd: number, category: string, runId?: string | null, ttlMs = 15 * 60_000): string {
    this.#assertBudgetInputs(hardLimitUsd, estimatedCostUsd, ttlMs);
    if (!category.trim() || category.length > 200) throw new RangeError("Budget reservation categories must be 1-200 characters.");
    this.#reconcileCanonicalReservations(true);
    const id = uuidv7();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    if (this.#installationBudget) {
      this.#installationBudget.reserve({
        callId: id,
        category: "application",
        estimatedCostUsd,
        essential: category === "response" || category === "query_embedding" || category === "web_search",
        hardLimitUsd,
        ownerPid: process.pid,
        ownerScope: this.#installationBudgetOwnerScope!,
        expiresAt
      });
    }
    const transaction = this.connection.transaction(() => {
      const timestamp = now();
      this.#settleExpiredBudgetReservations(timestamp);
      const state = this.connection.prepare(`
        SELECT
          (SELECT COALESCE(SUM(estimated_cost_usd), 0) FROM installation_budget_ledger) AS spent,
          (SELECT COALESCE(SUM(estimated_cost_usd), 0) FROM budget_reservations WHERE status = 'reserved') AS reserved
      `).get() as { spent: number; reserved: number };
      if (state.spent + state.reserved + estimatedCostUsd > hardLimitUsd) {
        const error = new Error(`The $${hardLimitUsd.toFixed(2)} API budget limit has been reached.`);
        error.name = "BudgetExceededError";
        throw error;
      }
      this.connection.prepare(`
        INSERT INTO budget_reservations(id, run_id, category, estimated_cost_usd, status, created_at, expires_at, hard_limit_usd)
        VALUES (?, ?, ?, ?, 'reserved', ?, ?, ?)
      `).run(id, runId ?? null, category, estimatedCostUsd, timestamp, expiresAt, hardLimitUsd);
      this.recordBudgetThresholds(timestamp);
      return id;
    });
    try {
      return transaction.immediate();
    } catch (error) {
      this.#installationBudget?.releaseBeforeCall(id);
      throw error;
    }
  }

  releaseBudgetReservation(id: string): void {
    const transaction = this.connection.transaction(() => {
      this.connection.prepare("UPDATE budget_reservations SET status = 'released', settled_at = ? WHERE id = ? AND status = 'reserved'").run(now(), id);
    });
    transaction.immediate();
    this.#installationBudget?.releaseBeforeCall(id);
  }

  chargeFailedReservation(id: string, input: { runId?: string | null; provider: string; model: string; purpose: string; promptVersion: string }): void {
    const reservation = this.connection.prepare(
      "SELECT estimated_cost_usd FROM budget_reservations WHERE id = ? AND status = 'reserved'"
    ).get(id) as { estimated_cost_usd: number } | undefined;
    if (!reservation) return;
    this.recordModelCall({
      runId: input.runId ?? null,
      provider: input.provider,
      model: input.model,
      purpose: input.purpose,
      promptVersion: input.promptVersion,
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
      status: "failed_estimated",
      estimatedCostUsd: reservation.estimated_cost_usd,
      category: `${input.purpose}_failed_reserve`,
      traceMetadata: { conservativeCharge: true },
      reservationId: id
    });
  }

  /** Conservatively posts every orphaned reservation before an import/reset. */
  reconcileOutstandingBudgetReservations(reason = "maintenance"): number {
    this.#reconcileCanonicalReservations(false);
    const transaction = this.connection.transaction(() => {
      const timestamp = now();
      const reservations = this.connection.prepare(`
        SELECT id, category, estimated_cost_usd FROM budget_reservations WHERE status = 'reserved' ORDER BY created_at
      `).all() as Array<{ id: string; category: string; estimated_cost_usd: number }>;
      for (const reservation of reservations) this.#settleReservationConservatively(reservation, timestamp, reason);
      this.recordBudgetThresholds(timestamp);
      return reservations.length;
    });
    return transaction.immediate();
  }

  /**
   * Keep the installation-wide dollar total while removing vault-linked usage
   * metadata. The hard cap must survive destructive maintenance, but provider,
   * model, token, reservation, call, category, and timestamp fields must not
   * become a shadow copy of deleted or replaced vault activity.
   */
  scrubInstallationBudgetMetadata(scope?: { modelCallIds?: string[]; reservationIds?: string[] }): { redacted: number; removed: number } {
    const modelCallIds = [...new Set(scope?.modelCallIds ?? [])];
    const reservationIds = [...new Set(scope?.reservationIds ?? [])];
    const scoped = scope !== undefined;
    if (scoped && modelCallIds.length === 0 && reservationIds.length === 0) return { redacted: 0, removed: 0 };

    const predicates: string[] = [];
    const parameters: string[] = [];
    if (modelCallIds.length) {
      predicates.push(`model_call_id IN (${modelCallIds.map(() => "?").join(",")})`);
      parameters.push(...modelCallIds);
    }
    if (reservationIds.length) {
      predicates.push(`reservation_id IN (${reservationIds.map(() => "?").join(",")})`);
      parameters.push(...reservationIds);
    }
    const where = scoped ? ` AND (${predicates.join(" OR ")})` : "";
    const scrub = () => {
      const removed = this.connection.prepare(`DELETE FROM installation_budget_ledger WHERE estimated_cost_usd = 0${where}`).run(...parameters).changes;
      const redacted = this.connection.prepare(`
        UPDATE installation_budget_ledger
        SET reservation_id = NULL,
          model_call_id = NULL,
          category = 'redacted',
          provider = 'redacted',
          model = 'redacted',
          input_tokens = 0,
          output_tokens = 0,
          created_at = '1970-01-01T00:00:00.000Z'
        WHERE estimated_cost_usd > 0${where}
      `).run(...parameters).changes;
      return { redacted, removed };
    };
    return this.connection.inTransaction ? scrub() : this.connection.transaction(scrub).immediate();
  }

  #assertUsage(inputTokens: number, outputTokens: number, estimatedCostUsd: number): void {
    if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 0) {
      throw new RangeError("Provider token usage must be non-negative safe integers.");
    }
    if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) throw new RangeError("Provider cost must be finite and non-negative.");
  }

  #assertBudgetInputs(hardLimitUsd: number, estimatedCostUsd: number, ttlMs: number): void {
    if (!Number.isFinite(hardLimitUsd) || hardLimitUsd <= 0 || hardLimitUsd > 100) throw new RangeError("The API hard limit must be greater than zero and at most USD 100.");
    if (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0) throw new RangeError("The reserved cost must be finite and non-negative.");
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 24 * 60 * 60_000) throw new RangeError("Budget reservation TTL must be between one millisecond and 24 hours.");
  }

  #reconcileExpiredBudgetReservations(): void {
    const transaction = this.connection.transaction(() => {
      const timestamp = now();
      this.#settleExpiredBudgetReservations(timestamp);
      this.recordBudgetThresholds(timestamp);
    });
    transaction.immediate();
  }

  #settleExpiredBudgetReservations(timestamp: string): void {
    const expired = this.connection.prepare(`
      SELECT id, category, estimated_cost_usd FROM budget_reservations
      WHERE status = 'reserved' AND expires_at <= ? ORDER BY expires_at
    `).all(timestamp) as Array<{ id: string; category: string; estimated_cost_usd: number }>;
    for (const reservation of expired) this.#settleReservationConservatively(reservation, timestamp, "expired");
  }

  #settleReservationConservatively(reservation: { id: string; category: string; estimated_cost_usd: number }, timestamp: string, reason: string): void {
    this.#commitCanonicalConservatively(reservation.id, reservation.estimated_cost_usd);
    const changed = this.connection.prepare(`
      UPDATE budget_reservations SET status = 'settled', settled_at = ? WHERE id = ? AND status = 'reserved'
    `).run(timestamp, reservation.id).changes;
    if (changed !== 1) return;
    const ledgerId = uuidv7();
    const category = `${reservation.category}_${reason}_reserve`.slice(0, 200);
    this.connection.prepare(`
      INSERT INTO budget_ledger(id, model_call_id, category, provider, model, input_tokens, output_tokens, estimated_cost_usd, created_at)
      VALUES (?, NULL, ?, 'unknown', 'unknown', 0, 0, ?, ?)
    `).run(ledgerId, category, reservation.estimated_cost_usd, timestamp);
    this.connection.prepare(`
      INSERT INTO installation_budget_ledger(
        id, reservation_id, model_call_id, category, provider, model, input_tokens, output_tokens,
        estimated_cost_usd, accounting_status, created_at
      ) VALUES (?, ?, NULL, ?, 'unknown', 'unknown', 0, 0, ?, 'conservative', ?)
    `).run(ledgerId, reservation.id, category, reservation.estimated_cost_usd, timestamp);
  }

  #dependentRunIdsForReferences(referenceIds: readonly string[]): string[] {
    const runIds = new Set<string>();
    const visitedReferences = new Set<string>();
    const pendingReferences = [...new Set(referenceIds)];
    const statement = this.connection.prepare(
      "SELECT DISTINCT run_id AS id, source_ids_json FROM context_packets WHERE source_ids_json LIKE ? ESCAPE '\\'"
    );
    const assistantForRun = this.connection.prepare("SELECT assistant_event_id AS id FROM runs WHERE id = ? AND assistant_event_id IS NOT NULL");
    while (pendingReferences.length > 0) {
      const referenceId = pendingReferences.shift()!;
      if (visitedReferences.has(referenceId)) continue;
      visitedReferences.add(referenceId);
      const escaped = referenceId.replaceAll("%", "\\%").replaceAll("_", "\\_");
      const reference = new Set([referenceId]);
      for (const row of statement.all(`%${escaped}%`) as Array<{ id: string; source_ids_json: string }>) {
        let sourceIds: unknown;
        let malformed = false;
        try { sourceIds = JSON.parse(row.source_ids_json) as unknown; }
        catch { malformed = true; sourceIds = null; }
        // Valid JSON is matched structurally to avoid UUID substring false
        // positives. A malformed audit row cannot be interpreted safely; if
        // the deleted identifier is present, fail closed and remove its run.
        if (!evidenceReferencesAny(sourceIds, reference)
          && !(malformed && row.source_ids_json.includes(referenceId))) continue;
        if (runIds.has(row.id)) continue;
        runIds.add(row.id);
        const assistant = assistantForRun.get(row.id) as { id: string } | undefined;
        if (assistant && !visitedReferences.has(assistant.id)) pendingReferences.push(assistant.id);
      }
    }
    return [...runIds];
  }

  /**
   * Remove every run-scoped trace while preserving only a content-free dollar
   * total in the installation hard-cap ledger. Callers delete any assistant
   * events after first using them to repair compiled memory provenance.
   */
  #deleteRunDerivatives(runIdsInput: readonly string[], timestamp: string, reason: string): { runIds: string[]; assistantEventIds: string[] } {
    const runIds = [...new Set(runIdsInput)];
    if (runIds.length === 0) return { runIds: [], assistantEventIds: [] };
    const marks = runIds.map(() => "?").join(",");
    const assistantEventIds = (this.connection.prepare(`
      SELECT assistant_event_id AS id FROM runs
      WHERE id IN (${marks}) AND assistant_event_id IS NOT NULL
    `).all(...runIds) as Array<{ id: string }>).map((row) => row.id);
    const modelCallIds = (this.connection.prepare(`SELECT id FROM model_calls WHERE run_id IN (${marks})`).all(...runIds) as Array<{ id: string }>).map((row) => row.id);
    const reservationIds = (this.connection.prepare(`SELECT id FROM budget_reservations WHERE run_id IN (${marks})`).all(...runIds) as Array<{ id: string }>).map((row) => row.id);
    const outstandingReservations = this.connection.prepare(`
      SELECT id, category, estimated_cost_usd FROM budget_reservations
      WHERE run_id IN (${marks}) AND status = 'reserved'
    `).all(...runIds) as Array<{ id: string; category: string; estimated_cost_usd: number }>;
    for (const reservation of outstandingReservations) this.#settleReservationConservatively(reservation, timestamp, reason);
    const installationRows = (modelCallIds.length || reservationIds.length) ? this.connection.prepare(`
      SELECT id FROM installation_budget_ledger WHERE
        ${modelCallIds.length ? `model_call_id IN (${modelCallIds.map(() => "?").join(",")})` : "0"}
        OR ${reservationIds.length ? `reservation_id IN (${reservationIds.map(() => "?").join(",")})` : "0"}
    `).all(...modelCallIds, ...reservationIds) as Array<{ id: string }> : [];
    if (modelCallIds.length) {
      this.connection.prepare(`DELETE FROM budget_ledger WHERE model_call_id IN (${modelCallIds.map(() => "?").join(",")})`).run(...modelCallIds);
    }
    if (installationRows.length) {
      this.connection.prepare(`DELETE FROM budget_ledger WHERE id IN (${installationRows.map(() => "?").join(",")})`).run(...installationRows.map((row) => row.id));
    }
    this.scrubInstallationBudgetMetadata({ modelCallIds, reservationIds });
    this.connection.prepare(`DELETE FROM model_calls WHERE run_id IN (${marks})`).run(...runIds);
    this.connection.prepare(`DELETE FROM retrieval_traces WHERE run_id IN (${marks})`).run(...runIds);
    this.connection.prepare(`DELETE FROM context_packets WHERE run_id IN (${marks})`).run(...runIds);
    this.connection.prepare(`DELETE FROM tool_executions WHERE run_id IN (${marks})`).run(...runIds);
    this.connection.prepare(`DELETE FROM budget_reservations WHERE run_id IN (${marks})`).run(...runIds);
    this.connection.prepare(`DELETE FROM runs WHERE id IN (${marks})`).run(...runIds);
    return { runIds, assistantEventIds };
  }

  saveRetrievalTrace(trace: {
    id?: string; runId: string; query: string; classifications: string[]; candidates: unknown[];
    selectedIds: string[]; tokenBudget: unknown; latencyMs: number;
  }): string {
    const id = trace.id ?? uuidv7();
    this.connection.prepare(`
      INSERT INTO retrieval_traces(id, run_id, query_text, classifications_json, candidates_json, selected_ids_json, token_budget_json, latency_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, trace.runId, trace.query, JSON.stringify(trace.classifications), JSON.stringify(trace.candidates), JSON.stringify(trace.selectedIds), JSON.stringify(trace.tokenBudget), trace.latencyMs, now());
    return id;
  }

  getRetrievalTrace(idOrRunId: string): Record<string, unknown> | null {
    const row = this.connection.prepare(`
      SELECT * FROM retrieval_traces WHERE id = ? OR run_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(idOrRunId, idOrRunId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id, runId: row.run_id, query: row.query_text,
      classifications: parseJson(row.classifications_json, []), candidates: parseJson(row.candidates_json, []),
      selectedIds: parseJson(row.selected_ids_json, []), tokenBudget: parseJson(row.token_budget_json, {}),
      latencyMs: row.latency_ms, createdAt: row.created_at
    };
  }

  latestRetrievalTrace(): Record<string, unknown> | null {
    const row = this.connection.prepare("SELECT id FROM retrieval_traces ORDER BY created_at DESC LIMIT 1").get() as { id: string } | undefined;
    return row ? this.getRetrievalTrace(row.id) : null;
  }

  saveContextPacket(input: {
    runId: string;
    budget: unknown;
    sourceIds: string[];
    promptVersion: string;
    renderedContent: string;
    composition?: unknown;
  }): string {
    const id = uuidv7();
    this.connection.prepare(`
      INSERT INTO context_packets(
        id, run_id, budget_json, source_ids_json, prompt_version,
        content_hash, rendered_content, composition_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, '', ?, ?)
    `).run(
      id,
      input.runId,
      JSON.stringify(input.budget),
      JSON.stringify([...new Set(input.sourceIds)]),
      input.promptVersion,
      stableHash(input.renderedContent),
      JSON.stringify(input.composition ?? { version: 0, reconstructable: false }),
      now()
    );
    return id;
  }

  listTopics(limit = 100, includeInactiveEvidence = false, offset = 0): TopicPage[] {
    const rows = this.connection.prepare(`
      SELECT tp.*, tpr.summary, tpr.current_state, tpr.history, tpr.open_questions_json, tpr.author_type,
        COALESCE((SELECT json_group_array(source_id) FROM page_section_sources pss WHERE pss.revision_id = tpr.id), '[]') AS source_ids
      FROM topic_pages tp JOIN topic_page_revisions tpr ON tpr.topic_id = tp.id AND tpr.revision_number = tp.active_revision
      WHERE tp.lifecycle_status = 'active'
        AND (? = 1 OR tpr.author_type = 'user' OR NOT EXISTS (
          SELECT 1 FROM page_section_sources stale
          JOIN events evidence_event ON evidence_event.id = stale.source_id
          WHERE stale.revision_id = tpr.id AND evidence_event.role = 'assistant' AND evidence_event.active = 0
        ))
      ORDER BY tp.updated_at DESC, tp.id DESC LIMIT ? OFFSET ?
    `).all(includeInactiveEvidence ? 1 : 0, Math.min(501, limit), Math.max(0, offset)) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const sourceIds = [...new Set(parseJson<string[]>(row.source_ids, []))];
      return {
        id: String(row.id), type: row.core_type as TopicPage["type"], title: String(row.title), slug: String(row.slug),
        summary: String(row.summary), currentState: String(row.current_state), history: String(row.history),
        openQuestions: parseJson<string[]>(row.open_questions_json, []), tags: parseJson<string[]>(row.tags_json, []),
        sourceIds, sourceReferences: this.#topicSourceReferences(sourceIds), revision: Number(row.active_revision),
        activeRevision: Number(row.active_revision), revisionState: "current" as const,
        userAuthored: row.author_type === "user", updatePolicy: row.update_policy === "confirm" ? "confirm" : "automatic",
        updatedAt: String(row.updated_at)
      };
    });
  }

  #topicSourceReferences(sourceIds: readonly string[]): TopicSourceReference[] {
    const classify = this.connection.prepare(`
      SELECT CASE
        WHEN EXISTS (SELECT 1 FROM events WHERE id = ?) THEN 'event'
        WHEN EXISTS (SELECT 1 FROM source_chunks WHERE id = ?) THEN 'source_chunk'
        WHEN EXISTS (SELECT 1 FROM sources WHERE id = ?) THEN 'source'
        WHEN EXISTS (SELECT 1 FROM attachments WHERE id = ?) THEN 'attachment'
        WHEN EXISTS (SELECT 1 FROM tool_executions WHERE id = ?) THEN 'tool_result'
        WHEN EXISTS (SELECT 1 FROM claims WHERE id = ?) THEN 'claim'
        WHEN EXISTS (SELECT 1 FROM entities WHERE id = ?) THEN 'entity'
        WHEN EXISTS (SELECT 1 FROM topic_pages WHERE id = ?) THEN 'topic'
        ELSE 'unknown'
      END AS type
    `);
    return [...new Set(sourceIds)].map((id) => ({
      id,
      type: String((classify.get(id, id, id, id, id, id, id, id) as { type: string }).type) as TopicSourceReference["type"]
    }));
  }

  #topicFromRow(row: Record<string, unknown>): TopicPage & { markdown: string } {
    const sourceIds = [...new Set(parseJson<string[]>(row.source_ids, []))];
    return {
      id: String(row.id), type: row.core_type as TopicPage["type"], title: String(row.title), slug: String(row.slug),
      summary: String(row.summary), currentState: String(row.current_state), history: String(row.history),
      openQuestions: parseJson<string[]>(row.open_questions_json, []), tags: parseJson<string[]>(row.tags_json, []),
      sourceIds, sourceReferences: this.#topicSourceReferences(sourceIds), revision: Number(row.revision_number),
      activeRevision: Number(row.active_revision),
      revisionState: Number(row.revision_number) === Number(row.active_revision) ? "current" : "superseded",
      userAuthored: row.author_type === "user", updatePolicy: row.update_policy === "confirm" ? "confirm" : "automatic",
      updatedAt: String(row.revision_created_at), markdown: String(row.markdown)
    };
  }

  getTopic(id: string): (TopicPage & { markdown: string }) | null {
    const row = this.connection.prepare(`
      SELECT tp.*, tpr.id AS revision_id, tpr.revision_number, tpr.created_at AS revision_created_at,
        tpr.markdown, tpr.summary, tpr.current_state, tpr.history, tpr.open_questions_json, tpr.author_type,
        COALESCE((SELECT json_group_array(source_id) FROM page_section_sources pss WHERE pss.revision_id = tpr.id), '[]') AS source_ids
      FROM topic_pages tp JOIN topic_page_revisions tpr ON tpr.topic_id = tp.id AND tpr.revision_number = tp.active_revision WHERE tp.id = ?
    `).get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.#topicFromRow(row);
  }

  getTopicRevision(id: string, revision: number): (TopicPage & { markdown: string }) | null {
    const row = this.connection.prepare(`
      SELECT tp.*, tpr.id AS revision_id, tpr.revision_number, tpr.created_at AS revision_created_at,
        tpr.markdown, tpr.summary, tpr.current_state, tpr.history, tpr.open_questions_json, tpr.author_type,
        COALESCE((SELECT json_group_array(source_id) FROM page_section_sources pss WHERE pss.revision_id = tpr.id), '[]') AS source_ids
      FROM topic_pages tp JOIN topic_page_revisions tpr ON tpr.topic_id = tp.id
      WHERE tp.id = ? AND tpr.revision_number = ?
    `).get(id, revision) as Record<string, unknown> | undefined;
    return row ? this.#topicFromRow(row) : null;
  }

  upsertTopicRevision(input: {
    id?: string; type: TopicPage["type"]; title: string; slug: string; tags?: string[]; markdown: string;
    summary: string; currentState: string; history: string; openQuestions?: string[]; sourceIds?: string[];
    authorType?: "model" | "user" | "system"; updatePolicy?: "automatic" | "confirm"; promptVersion: string;
  }): TopicPage {
    return this.connection.transaction(() => {
      const timestamp = now();
      const existing = this.connection.prepare("SELECT id, active_revision, update_policy FROM topic_pages WHERE scope_id = 'global' AND slug = ?").get(input.slug) as { id: string; active_revision: number; update_policy: "automatic" | "confirm" } | undefined;
      const topicId = existing?.id ?? input.id ?? uuidv7();
      const revision = (existing?.active_revision ?? 0) + 1;
      const updatePolicy = input.updatePolicy ?? (input.authorType === "user" ? "confirm" : existing?.update_policy ?? "automatic");
      if (!existing) {
        this.connection.prepare(`
          INSERT INTO topic_pages(id, core_type, slug, title, active_revision, scope_id, tags_json, lifecycle_status, created_at, updated_at, update_policy)
          VALUES (?, ?, ?, ?, ?, 'global', ?, 'active', ?, ?, ?)
        `).run(topicId, input.type, input.slug, input.title, revision, JSON.stringify(input.tags ?? []), timestamp, timestamp, updatePolicy);
      } else {
        this.connection.prepare(`
          UPDATE topic_pages SET core_type = ?, title = ?, active_revision = ?, tags_json = ?, updated_at = ?, update_policy = ? WHERE id = ?
        `).run(input.type, input.title, revision, JSON.stringify(input.tags ?? []), timestamp, updatePolicy, topicId);
      }
      const revisionId = uuidv7();
      this.connection.prepare(`
        INSERT INTO topic_page_revisions(id, topic_id, revision_number, markdown, summary, current_state, history,
          open_questions_json, generation_inputs_json, author_type, prompt_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(revisionId, topicId, revision, input.markdown, input.summary, input.currentState, input.history,
        JSON.stringify(input.openQuestions ?? []), JSON.stringify(input.sourceIds ?? []), input.authorType ?? "model", input.promptVersion, timestamp);
      for (const sourceId of input.sourceIds ?? []) {
        this.connection.prepare(`
          INSERT INTO page_section_sources(id, revision_id, section_key, start_offset, end_offset, source_id)
          VALUES (?, ?, 'evidence', 0, ?, ?)
        `).run(uuidv7(), revisionId, input.markdown.length, sourceId);
      }
      return this.getTopic(topicId)!;
    })();
  }

  getTopicShardClaimGuardSnapshot(claimId: string): TopicShardClaimGuardSnapshot | null {
    const claim = this.connection.prepare(`
      SELECT id, topic_id, subject, predicate, value, confidence, status, source_role,
        valid_from, valid_to, observed_at, freshness_expires_at, extraction_version
      FROM claims WHERE id = ?
    `).get(claimId) as Record<string, unknown> | undefined;
    if (!claim) return null;
    // The proposal CAS must cover evidence availability, not only the stable
    // claim_sources edge. Event exclusion and source deletion can otherwise
    // leave that edge unchanged while making an isolated candidate unsafe to
    // activate. Join every supported source namespace because source_type is a
    // provenance classification and older rows may still carry an event id for
    // a tool/user-edit claim.
    const sources = this.connection.prepare(`
      SELECT claim_source.source_id, claim_source.source_type, claim_source.excerpt_hash,
        CASE WHEN event.id IS NULL THEN 0 ELSE 1 END AS event_exists,
        event.active AS event_active, event.status AS event_status, event.completed_at AS event_completed_at,
        event_part.ordinal AS event_content_ordinal, event_part.content_type AS event_content_type,
        event_part.text_content AS event_text_content, event_part.metadata_json AS event_metadata_json,
        CASE WHEN chunk.id IS NULL THEN 0 ELSE 1 END AS chunk_exists,
        chunk.source_id AS chunk_parent_source_id, chunk.ordinal AS chunk_ordinal,
        chunk.text_content AS chunk_text_content, chunk.location_json AS chunk_location_json,
        chunk.token_count AS chunk_token_count, chunk.content_hash AS chunk_content_hash,
        CASE WHEN document.id IS NULL THEN 0 ELSE 1 END AS document_exists,
        document.type AS document_type, document.title AS document_title, document.uri AS document_uri,
        document.content_hash AS document_content_hash, document.provenance_json AS document_provenance_json,
        document.freshness_class AS document_freshness_class, document.retrieved_at AS document_retrieved_at,
        CASE WHEN attachment.id IS NULL THEN 0 ELSE 1 END AS attachment_exists,
        attachment.source_id AS attachment_source_id, attachment.filename AS attachment_filename,
        attachment.media_type AS attachment_media_type, attachment.size AS attachment_size,
        attachment.content_hash AS attachment_content_hash, attachment.status AS attachment_status,
        attachment.error_code AS attachment_error_code,
        CASE WHEN tool.id IS NULL THEN 0 ELSE 1 END AS tool_exists,
        tool.run_id AS tool_run_id, tool.tool_name AS tool_name, tool.arguments_json AS tool_arguments_json,
        tool.output_text AS tool_output_text, tool.citations_json AS tool_citations_json,
        tool.status AS tool_status, tool.sandbox_json AS tool_sandbox_json,
        tool.completed_at AS tool_completed_at
      FROM claim_sources claim_source
      LEFT JOIN events event ON event.id = claim_source.source_id
      LEFT JOIN event_content event_part ON event_part.event_id = event.id
      LEFT JOIN source_chunks chunk ON chunk.id = claim_source.source_id
      LEFT JOIN sources document ON document.id = claim_source.source_id OR document.id = chunk.source_id
      LEFT JOIN attachments attachment ON attachment.id = claim_source.source_id
      LEFT JOIN tool_executions tool ON tool.id = claim_source.source_id
      WHERE claim_source.claim_id = ?
      ORDER BY claim_source.source_id, claim_source.source_type, claim_source.excerpt_hash, event_part.ordinal
    `).all(claimId) as Array<Record<string, unknown>>;
    return {
      claimId,
      topicId: claim.topic_id === null ? null : String(claim.topic_id),
      stateHash: topicShardFingerprint({ schemaVersion: 1, kind: "claim", claim, sources })
    };
  }

  getTopicShardParentBaseSnapshot(topicId: string): TopicShardParentBaseSnapshot | null {
    const row = this.connection.prepare(`
      SELECT page.id, page.core_type, page.slug, page.title, page.active_revision, page.scope_id,
        page.tags_json, page.lifecycle_status, page.created_at, page.updated_at, page.update_policy,
        revision.id AS revision_id, revision.revision_number, revision.markdown, revision.summary,
        revision.current_state, revision.history, revision.open_questions_json,
        revision.generation_inputs_json, revision.author_type, revision.prompt_version,
        revision.created_at AS revision_created_at
      FROM topic_pages page JOIN topic_page_revisions revision
        ON revision.topic_id = page.id AND revision.revision_number = page.active_revision
      WHERE page.id = ?
    `).get(topicId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const provenance = this.connection.prepare(`
      SELECT id, section_key, start_offset, end_offset, claim_id, source_id
      FROM page_section_sources WHERE revision_id = ?
      ORDER BY section_key, start_offset, end_offset, claim_id, source_id, id
    `).all(String(row.revision_id)) as Array<Record<string, unknown>>;
    return {
      revisionId: String(row.revision_id),
      revision: Number(row.revision_number),
      fingerprint: topicShardFingerprint({ schemaVersion: 1, kind: "parent", row, provenance })
    };
  }

  getTopicShardBaseSnapshot(topicId: string): TopicShardBaseSnapshot | null {
    const row = this.connection.prepare(`
      SELECT shard.parent_topic_id, shard.section_key, shard.ordinal, shard.min_sort_key, shard.max_sort_key,
        page.id, page.core_type, page.slug, page.title, page.active_revision, page.scope_id,
        page.tags_json, page.lifecycle_status, page.created_at, page.updated_at, page.update_policy,
        revision.id AS revision_id, revision.revision_number, revision.markdown, revision.summary,
        revision.current_state, revision.history, revision.open_questions_json,
        revision.generation_inputs_json, revision.author_type, revision.prompt_version,
        revision.created_at AS revision_created_at
      FROM topic_section_shards shard
      JOIN topic_pages page ON page.id = shard.child_topic_id
      JOIN topic_page_revisions revision
        ON revision.topic_id = page.id AND revision.revision_number = page.active_revision
      WHERE shard.child_topic_id = ? AND page.lifecycle_status = 'active'
    `).get(topicId) as Record<string, unknown> | undefined;
    if (!row || row.section_key === "overview") return null;
    const provenance = this.connection.prepare(`
      SELECT id, section_key, start_offset, end_offset, claim_id, source_id
      FROM page_section_sources WHERE revision_id = ?
      ORDER BY section_key, start_offset, end_offset, claim_id, source_id, id
    `).all(String(row.revision_id)) as Array<Record<string, unknown>>;
    return {
      topicId,
      revisionId: String(row.revision_id),
      revision: Number(row.revision_number),
      section: String(row.section_key) as TopicShardBaseSnapshot["section"],
      ordinal: Number(row.ordinal),
      minSortKey: String(row.min_sort_key),
      maxSortKey: String(row.max_sort_key),
      fingerprint: topicShardFingerprint({ schemaVersion: 1, kind: "shard", row, provenance })
    };
  }

  getTopicShardRevisionContentHash(revisionId: string): string | null {
    const revision = this.connection.prepare(`
      SELECT topic_id, id, revision_number, markdown, summary, current_state, history,
        open_questions_json, generation_inputs_json, author_type, prompt_version
      FROM topic_page_revisions WHERE id = ?
    `).get(revisionId) as Record<string, unknown> | undefined;
    if (!revision) return null;
    const provenance = this.connection.prepare(`
      SELECT section_key, start_offset, end_offset, claim_id, source_id
      FROM page_section_sources WHERE revision_id = ? AND claim_id IS NOT NULL
      ORDER BY section_key, start_offset, end_offset, claim_id, source_id
    `).all(revisionId) as Array<Record<string, unknown>>;
    return topicShardRevisionContentHash({
      topicId: String(revision.topic_id),
      revisionId: String(revision.id),
      revision: Number(revision.revision_number),
      markdown: String(revision.markdown),
      summary: String(revision.summary),
      currentState: String(revision.current_state),
      history: String(revision.history),
      openQuestionsJson: String(revision.open_questions_json),
      generationInputsJson: String(revision.generation_inputs_json),
      authorType: String(revision.author_type),
      promptVersion: String(revision.prompt_version),
      provenance: provenance.map((row) => ({
        section: String(row.section_key),
        start: Number(row.start_offset),
        end: Number(row.end_offset),
        claimId: String(row.claim_id),
        sourceId: String(row.source_id)
      }))
    });
  }

  getTopicUpdatePolicy(topicId: string): "automatic" | "confirm" | null {
    const row = this.connection.prepare("SELECT update_policy FROM topic_pages WHERE id = ?").get(topicId) as { update_policy: string } | undefined;
    if (!row) return null;
    return row.update_policy === "confirm" ? "confirm" : "automatic";
  }

  setTopicUpdatePolicy(topicId: string, policy: "automatic" | "confirm"): boolean {
    return this.connection.prepare("UPDATE topic_pages SET update_policy = ?, updated_at = ? WHERE id = ?")
      .run(policy, now(), topicId).changes > 0;
  }

  hasTopicShardProposal(id: string): boolean {
    return Boolean(this.connection.prepare("SELECT 1 FROM topic_shard_proposals WHERE id = ?").get(id));
  }

  persistTopicShardProposal(proposal: TopicShardProposal): boolean {
    return this.connection.transaction(() => {
      const inserted = this.connection.prepare(`
        INSERT OR IGNORE INTO topic_shard_proposals(
          id, group_id, parent_topic_id, title, parent_revision_id, parent_revision,
          parent_fingerprint, claim_ids_json, source_ids_json, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        proposal.id,
        proposal.groupId,
        proposal.topicId,
        proposal.title,
        proposal.parentBase.revisionId,
        proposal.parentBase.revision,
        proposal.parentBase.fingerprint,
        JSON.stringify([...new Set(proposal.claimIds)].sort()),
        JSON.stringify([...new Set(proposal.sourceIds)].sort()),
        proposal.createdAt
      ).changes;
      if (inserted === 0) {
        const existing = this.getTopicShardProposal(proposal.id, true);
        if (!existing || topicShardProposalMaterialHash(existing) !== topicShardProposalMaterialHash(proposal)) {
          throw Object.assign(new Error(`Stable proposal id ${proposal.id} is already bound to different material.`), {
            code: "TOPIC_SHARD_PROPOSAL_COLLISION"
          });
        }
        return false;
      }

      const insertPatch = this.connection.prepare(`
        INSERT INTO topic_shard_proposal_patches(
          proposal_id, patch_index, section_key, base_topic_id, base_revision_id,
          base_revision, base_ordinal, base_min_sort_key, base_max_sort_key, base_fingerprint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertRoute = this.connection.prepare(`
        INSERT INTO topic_shard_proposal_routes(
          proposal_id, patch_index, route_index, claim_id, sort_key, expected_base_topic_id
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      const insertOutput = this.connection.prepare(`
        INSERT INTO topic_shard_proposal_outputs(
          proposal_id, patch_index, output_index, topic_id, revision_id, revision_number,
          base_revision, title, slug, ordinal, min_sort_key, max_sort_key,
          claim_ids_json, source_ids_json, evidence_ids_json, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (let patchIndex = 0; patchIndex < proposal.patches.length; patchIndex += 1) {
        const patch = proposal.patches[patchIndex]!;
        insertPatch.run(
          proposal.id,
          patchIndex,
          patch.section,
          patch.base?.topicId ?? null,
          patch.base?.revisionId ?? null,
          patch.base?.revision ?? null,
          patch.base?.ordinal ?? null,
          patch.base?.minSortKey ?? null,
          patch.base?.maxSortKey ?? null,
          patch.base?.fingerprint ?? null
        );
        for (let routeIndex = 0; routeIndex < patch.routeGuards.length; routeIndex += 1) {
          const route = patch.routeGuards[routeIndex]!;
          insertRoute.run(proposal.id, patchIndex, routeIndex, route.claimId, route.sortKey, route.expectedBaseTopicId);
        }
        for (let outputIndex = 0; outputIndex < patch.outputs.length; outputIndex += 1) {
          const output = patch.outputs[outputIndex]!;
          insertOutput.run(
            proposal.id,
            patchIndex,
            outputIndex,
            output.topicId,
            output.revisionId,
            output.revision,
            output.baseRevision,
            output.title,
            output.slug,
            output.ordinal,
            output.minSortKey,
            output.maxSortKey,
            JSON.stringify([...new Set(output.claimIds)].sort()),
            JSON.stringify([...new Set(output.sourceIds)].sort()),
            JSON.stringify([...new Set(output.evidenceIds)].sort()),
            output.contentHash
          );
        }
      }

      const insertGuard = this.connection.prepare(`
        INSERT INTO topic_shard_proposal_claim_guards(
          proposal_id, guard_index, claim_id, expected_topic_id, state_hash,
          projected_topic_id, assign_to_topic_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (let guardIndex = 0; guardIndex < proposal.claimGuards.length; guardIndex += 1) {
        const guard = proposal.claimGuards[guardIndex]!;
        insertGuard.run(
          proposal.id,
          guardIndex,
          guard.claimId,
          guard.expectedTopicId,
          guard.stateHash,
          guard.projectedTopicId,
          guard.assignToTopicId
        );
      }
      return true;
    })();
  }

  getTopicShardProposal(id: string, includeResolved = false): TopicShardProposal | null {
    const header = this.connection.prepare(`
      SELECT * FROM topic_shard_proposals WHERE id = ? ${includeResolved ? "" : "AND status = 'pending'"}
    `).get(id) as Record<string, unknown> | undefined;
    if (!header) return null;
    const patchRows = this.connection.prepare(`
      SELECT * FROM topic_shard_proposal_patches WHERE proposal_id = ? ORDER BY patch_index
    `).all(id) as Array<Record<string, unknown>>;
    const routeRows = this.connection.prepare(`
      SELECT * FROM topic_shard_proposal_routes WHERE proposal_id = ? ORDER BY patch_index, route_index
    `).all(id) as Array<Record<string, unknown>>;
    const outputRows = this.connection.prepare(`
      SELECT * FROM topic_shard_proposal_outputs WHERE proposal_id = ? ORDER BY patch_index, output_index
    `).all(id) as Array<Record<string, unknown>>;
    const guardRows = this.connection.prepare(`
      SELECT * FROM topic_shard_proposal_claim_guards WHERE proposal_id = ? ORDER BY guard_index
    `).all(id) as Array<Record<string, unknown>>;
    const patches = patchRows.map((patch) => {
      const patchIndex = Number(patch.patch_index);
      return {
        section: String(patch.section_key) as TopicShardProposal["patches"][number]["section"],
        base: patch.base_topic_id === null ? null : {
          topicId: String(patch.base_topic_id),
          revisionId: String(patch.base_revision_id),
          revision: Number(patch.base_revision),
          ordinal: Number(patch.base_ordinal),
          minSortKey: String(patch.base_min_sort_key),
          maxSortKey: String(patch.base_max_sort_key),
          fingerprint: String(patch.base_fingerprint)
        },
        routeGuards: routeRows.filter((route) => Number(route.patch_index) === patchIndex).map((route) => ({
          claimId: String(route.claim_id),
          sortKey: String(route.sort_key),
          expectedBaseTopicId: route.expected_base_topic_id === null ? null : String(route.expected_base_topic_id)
        })),
        outputs: outputRows.filter((output) => Number(output.patch_index) === patchIndex).map((output) => ({
          topicId: String(output.topic_id),
          revisionId: String(output.revision_id),
          revision: Number(output.revision_number),
          baseRevision: output.base_revision === null ? null : Number(output.base_revision),
          title: String(output.title),
          slug: String(output.slug),
          ordinal: Number(output.ordinal),
          minSortKey: String(output.min_sort_key),
          maxSortKey: String(output.max_sort_key),
          claimIds: parseJson<string[]>(output.claim_ids_json, []),
          sourceIds: parseJson<string[]>(output.source_ids_json, []),
          evidenceIds: parseJson<string[]>(output.evidence_ids_json, []),
          contentHash: String(output.content_hash)
        }))
      };
    });
    return {
      schemaVersion: 2,
      id: String(header.id),
      groupId: String(header.group_id),
      kind: "topic_shard_patch",
      topicId: String(header.parent_topic_id),
      title: String(header.title),
      parentBase: {
        revisionId: String(header.parent_revision_id),
        revision: Number(header.parent_revision),
        fingerprint: String(header.parent_fingerprint)
      },
      patches,
      claimGuards: guardRows.map((guard) => ({
        claimId: String(guard.claim_id),
        expectedTopicId: guard.expected_topic_id === null ? null : String(guard.expected_topic_id),
        stateHash: String(guard.state_hash),
        projectedTopicId: guard.projected_topic_id === null ? null : String(guard.projected_topic_id),
        assignToTopicId: guard.assign_to_topic_id === null ? null : String(guard.assign_to_topic_id)
      })),
      claimIds: parseJson<string[]>(header.claim_ids_json, []),
      sourceIds: parseJson<string[]>(header.source_ids_json, []),
      requiresConfirmation: true,
      status: "pending",
      createdAt: String(header.created_at)
    };
  }

  getTopicShardProposalByGroupId(groupId: string): TopicShardProposal | null {
    const row = this.connection.prepare(`
      SELECT id FROM topic_shard_proposals WHERE group_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(groupId) as { id: string } | undefined;
    return row ? this.getTopicShardProposal(row.id, true) : null;
  }

  /**
   * Atomically terminalize obsolete normalized proposals and destroy only
   * their unshared, inactive candidate material. The proposal header/manifest
   * remains a compact deterministic audit record until bounded retention
   * prunes the oldest terminal rows.
   */
  terminalizeTopicShardProposals(
    proposalIds: readonly string[],
    status: "stale" | "superseded",
    resolvedAt = now(),
    retainedTerminalHeaders = 5_000
  ): string[] {
    const ids = [...new Set(proposalIds)].sort();
    if (ids.length === 0) return [];
    if (ids.length > 500) throw new Error("At most 500 normalized proposals may be terminalized in one transaction.");
    return this.connection.transaction(() => {
      const marks = ids.map(() => "?").join(",");
      const eligible = (this.connection.prepare(`
        SELECT id FROM topic_shard_proposals
        WHERE status = 'pending' AND id IN (${marks}) ORDER BY id
      `).all(...ids) as Array<{ id: string }>).map((row) => row.id);
      if (eligible.length === 0) return [];
      const eligibleMarks = eligible.map(() => "?").join(",");
      const outputs = this.connection.prepare(`
        SELECT output.proposal_id, output.topic_id, output.revision_id,
          output.revision_number, output.base_revision
        FROM topic_shard_proposal_outputs output
        WHERE output.proposal_id IN (${eligibleMarks})
        ORDER BY output.proposal_id, output.patch_index, output.output_index
      `).all(...eligible) as Array<{
        proposal_id: string;
        topic_id: string;
        revision_id: string;
        revision_number: number;
        base_revision: number | null;
      }>;
      this.connection.prepare(`
        UPDATE topic_shard_proposals SET status = ?, resolved_at = ?
        WHERE status = 'pending' AND id IN (${eligibleMarks})
      `).run(status, resolvedAt, ...eligible);

      const pendingSharesRevision = this.connection.prepare(`
        SELECT 1 FROM topic_shard_proposal_outputs output
        JOIN topic_shard_proposals proposal ON proposal.id = output.proposal_id
        WHERE output.revision_id = ? AND proposal.status = 'pending' LIMIT 1
      `);
      const pendingSharesTopic = this.connection.prepare(`
        SELECT 1 FROM topic_shard_proposal_outputs output
        JOIN topic_shard_proposals proposal ON proposal.id = output.proposal_id
        WHERE output.topic_id = ? AND proposal.status = 'pending' LIMIT 1
      `);
      for (const output of outputs) {
        if (pendingSharesRevision.get(output.revision_id)) continue;
        const revision = this.connection.prepare(`
          SELECT topic_id, revision_number, author_type, prompt_version
          FROM topic_page_revisions WHERE id = ?
        `).get(output.revision_id) as {
          topic_id: string;
          revision_number: number;
          author_type: string;
          prompt_version: string;
        } | undefined;
        const page = this.connection.prepare(`
          SELECT active_revision, lifecycle_status FROM topic_pages WHERE id = ?
        `).get(output.topic_id) as { active_revision: number; lifecycle_status: string } | undefined;
        if (!revision
          || revision.topic_id !== output.topic_id
          || revision.revision_number !== output.revision_number
          || revision.author_type !== "model"
          || revision.prompt_version !== "topic-shard-proposal-v1"
          || (page?.lifecycle_status === "active" && page.active_revision === output.revision_number)) continue;
        // Candidate revisions are deliberately absent from retrieval indexes,
        // but cleanup is defensive against a corrupt/partial older build.
        this.connection.prepare("DELETE FROM vectors WHERE source_id = ?").run(output.revision_id);
        this.connection.prepare("DELETE FROM topic_revision_fts WHERE revision_id = ?").run(output.revision_id);
        this.connection.prepare("DELETE FROM topic_page_revisions WHERE id = ? AND topic_id = ?")
          .run(output.revision_id, output.topic_id);
      }

      for (const topicId of [...new Set(outputs.filter((output) => output.base_revision === null).map((output) => output.topic_id))]) {
        if (pendingSharesTopic.get(topicId)) continue;
        const page = this.connection.prepare(`
          SELECT lifecycle_status FROM topic_pages WHERE id = ?
        `).get(topicId) as { lifecycle_status: string } | undefined;
        if (page?.lifecycle_status !== "proposal") continue;
        this.connection.prepare("DELETE FROM vectors WHERE source_id = ?").run(topicId);
        this.connection.prepare("DELETE FROM page_links WHERE source_topic_id = ? OR target_topic_id = ?").run(topicId, topicId);
        this.connection.prepare("DELETE FROM topic_fts WHERE topic_id = ?").run(topicId);
        this.connection.prepare("DELETE FROM topic_revision_fts WHERE topic_id = ?").run(topicId);
        this.connection.prepare("DELETE FROM topic_pages WHERE id = ? AND lifecycle_status = 'proposal'").run(topicId);
      }

      const retain = Math.max(0, Math.min(50_000, Math.trunc(retainedTerminalHeaders)));
      const expiredHeaders = this.connection.prepare(`
        SELECT id FROM topic_shard_proposals WHERE status <> 'pending'
        ORDER BY COALESCE(resolved_at, created_at) DESC, id DESC
        LIMIT -1 OFFSET ?
      `).all(retain) as Array<{ id: string }>;
      if (expiredHeaders.length > 0) {
        for (let offset = 0; offset < expiredHeaders.length; offset += 500) {
          const batch = expiredHeaders.slice(offset, offset + 500).map((row) => row.id);
          this.connection.prepare(`DELETE FROM topic_shard_proposals WHERE id IN (${batch.map(() => "?").join(",")})`).run(...batch);
        }
      }
      return eligible;
    })();
  }

  /** Keep normalized terminal proposal audit metadata bounded on long vaults. */
  pruneTerminalTopicShardProposalHeaders(retainedTerminalHeaders = 5_000): number {
    const retain = Math.max(0, Math.min(50_000, Math.trunc(retainedTerminalHeaders)));
    return this.connection.transaction(() => {
      const expiredHeaders = this.connection.prepare(`
        SELECT id FROM topic_shard_proposals WHERE status <> 'pending'
        ORDER BY COALESCE(resolved_at, created_at) DESC, id DESC
        LIMIT -1 OFFSET ?
      `).all(retain) as Array<{ id: string }>;
      let removed = 0;
      for (let offset = 0; offset < expiredHeaders.length; offset += 500) {
        const batch = expiredHeaders.slice(offset, offset + 500).map((row) => row.id);
        removed += this.connection.prepare(`
          DELETE FROM topic_shard_proposals WHERE id IN (${batch.map(() => "?").join(",")})
        `).run(...batch).changes;
      }
      return removed;
    })();
  }

  listPendingTopicShardProposals(limit = 100, offset = 0): TopicShardProposal[] {
    const ids = this.connection.prepare(`
      SELECT id FROM topic_shard_proposals WHERE status = 'pending'
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(Math.min(500, Math.max(1, limit)), Math.max(0, offset)) as Array<{ id: string }>;
    return ids.flatMap(({ id }) => {
      const proposal = this.getTopicShardProposal(id);
      return proposal ? [proposal] : [];
    });
  }

  listClaims(limit = 200, includeInactiveEvidence = false, offset = 0): Claim[] {
    const rows = this.connection.prepare(`
      SELECT c.*, COALESCE((
        SELECT json_group_array(cs.source_id) FROM claim_sources cs
        LEFT JOIN events source_event ON source_event.id = cs.source_id
        WHERE cs.claim_id = c.id AND (? = 1 OR source_event.id IS NULL OR source_event.active = 1)
      ), '[]') AS source_ids
      FROM claims c
      WHERE ? = 1 OR EXISTS (
        SELECT 1 FROM claim_sources active_source
        LEFT JOIN events active_event ON active_event.id = active_source.source_id
        WHERE active_source.claim_id = c.id AND (active_event.id IS NULL OR active_event.active = 1)
      )
      ORDER BY observed_at DESC LIMIT ? OFFSET ?
    `).all(includeInactiveEvidence ? 1 : 0, includeInactiveEvidence ? 1 : 0, Math.min(limit, 1000), Math.max(0, offset)) as Array<Record<string, unknown>>;
    return rows.map(claimFromRow);
  }

  getClaim(id: string, includeInactiveEvidence = true): Claim | null {
    const row = this.connection.prepare(`
      SELECT c.*, COALESCE((
        SELECT json_group_array(cs.source_id) FROM claim_sources cs
        LEFT JOIN events source_event ON source_event.id = cs.source_id
        WHERE cs.claim_id = c.id AND (? = 1 OR source_event.id IS NULL OR source_event.active = 1)
      ), '[]') AS source_ids
      FROM claims c
      WHERE c.id = ? AND (
        ? = 1 OR EXISTS (
          SELECT 1 FROM claim_sources active_source
          LEFT JOIN events active_event ON active_event.id = active_source.source_id
          WHERE active_source.claim_id = c.id AND (active_event.id IS NULL OR active_event.active = 1)
        )
      )
    `).get(includeInactiveEvidence ? 1 : 0, id, includeInactiveEvidence ? 1 : 0) as Record<string, unknown> | undefined;
    return row ? claimFromRow(row) : null;
  }

  /** Indexed exact-slot lookup used by post-turn temporal reconciliation. */
  listActiveClaimsForSlot(subject: string, predicate: string, topicId: string | null, includeInactiveEvidence = false): Claim[] {
    const rows = this.connection.prepare(`
      SELECT c.*, COALESCE((
        SELECT json_group_array(cs.source_id) FROM claim_sources cs
        LEFT JOIN events source_event ON source_event.id = cs.source_id
        WHERE cs.claim_id = c.id AND (? = 1 OR source_event.id IS NULL OR source_event.active = 1)
      ), '[]') AS source_ids
      FROM claim_slot_index slot JOIN claims c ON c.id = slot.claim_id
      WHERE slot.subject_key = ? AND slot.predicate_key = ?
        AND slot.topic_id IS ?
        AND slot.status IN ('current', 'conflicted')
        AND (? = 1 OR slot.active_evidence = 1)
      ORDER BY c.observed_at DESC, c.id ASC
    `).all(
      includeInactiveEvidence ? 1 : 0,
      normalizeClaimSlotValue(subject),
      normalizeClaimSlotValue(predicate),
      topicId,
      includeInactiveEvidence ? 1 : 0
    ) as Array<Record<string, unknown>>;
    return rows.map(claimFromRow);
  }

  /** At most two IDs are sufficient to distinguish an unambiguous slot. */
  claimTopicIdsForSlot(subject: string, predicate: string): string[] {
    const rows = this.connection.prepare(`
      SELECT topic_id FROM claim_slot_topics
      WHERE subject_key = ? AND predicate_key = ? AND active_claim_count > 0
      ORDER BY topic_id LIMIT 2
    `).all(normalizeClaimSlotValue(subject), normalizeClaimSlotValue(predicate)) as Array<{ topic_id: string }>;
    return rows.map((row) => row.topic_id);
  }

  /** Topic-local ledger paging keeps compilation independent of other topics. */
  listClaimsForTopic(topicId: string, limit = 1_000, includeInactiveEvidence = false, offset = 0): Claim[] {
    const rows = this.connection.prepare(`
      SELECT c.*, COALESCE((
        SELECT json_group_array(cs.source_id) FROM claim_sources cs
        LEFT JOIN events source_event ON source_event.id = cs.source_id
        WHERE cs.claim_id = c.id AND (? = 1 OR source_event.id IS NULL OR source_event.active = 1)
      ), '[]') AS source_ids
      FROM claims c
      WHERE c.topic_id = ? AND (? = 1 OR EXISTS (
        SELECT 1 FROM claim_sources active_source
        LEFT JOIN events active_event ON active_event.id = active_source.source_id
        WHERE active_source.claim_id = c.id AND (active_event.id IS NULL OR active_event.active = 1)
      ))
      ORDER BY c.observed_at DESC, c.id ASC LIMIT ? OFFSET ?
    `).all(includeInactiveEvidence ? 1 : 0, topicId, includeInactiveEvidence ? 1 : 0, Math.min(limit, 1_000), Math.max(0, offset)) as Array<Record<string, unknown>>;
    return rows.map(claimFromRow);
  }

  upsertClaim(input: Omit<Claim, "id"> & { id?: string; extractionVersion?: string }): Claim {
    const id = input.id ?? uuidv7();
    this.connection.transaction(() => {
      this.connection.prepare(`
        INSERT INTO claims(id, topic_id, subject, predicate, value, confidence, status, source_role, valid_from, valid_to,
          observed_at, freshness_expires_at, extraction_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET topic_id = excluded.topic_id, subject = excluded.subject, predicate = excluded.predicate,
          value = excluded.value, confidence = excluded.confidence, status = excluded.status, valid_from = excluded.valid_from,
          valid_to = excluded.valid_to, freshness_expires_at = excluded.freshness_expires_at
      `).run(id, input.topicId, input.subject, input.predicate, input.value, input.confidence, input.status, input.sourceRole,
        input.validFrom, input.validTo, input.observedAt, input.freshnessExpiresAt, input.extractionVersion ?? "claims-v1");
      this.connection.prepare(`
        INSERT INTO claim_slot_index(claim_id, subject_key, predicate_key, topic_id, status, active_evidence)
        VALUES (?, ?, ?, ?, ?, COALESCE((SELECT active_evidence FROM claim_slot_index WHERE claim_id = ?), 0))
        ON CONFLICT(claim_id) DO UPDATE SET
          subject_key = excluded.subject_key,
          predicate_key = excluded.predicate_key,
          topic_id = excluded.topic_id,
          status = excluded.status
      `).run(id, normalizeClaimSlotValue(input.subject), normalizeClaimSlotValue(input.predicate), input.topicId, input.status, id);
      for (const sourceId of input.sourceIds) {
        this.connection.prepare(`
          INSERT OR IGNORE INTO claim_sources(claim_id, source_id, source_type) VALUES (?, ?, 'event')
        `).run(id, sourceId);
      }
    })();
    return { ...input, id };
  }

  correctClaim(claimId: string, value: string, reason = ""): { event: ConversationEvent; claim: Claim; supersededClaimId: string } {
    return this.connection.transaction(() => {
      const existing = this.getClaim(claimId, true);
      if (!existing) throw Object.assign(new Error("Claim not found."), { code: "CLAIM_NOT_FOUND" });
      const timestamp = now();
      const event = this.appendEvent({
        role: "user",
        kind: "revision",
        status: "complete",
        content: [`Memory correction: ${existing.subject} ${existing.predicate}: ${value}`, ...(reason.trim() ? [`Reason: ${reason.trim()}`] : [])].join("\n")
      });
      this.connection.prepare("UPDATE claims SET status = 'superseded', valid_to = COALESCE(valid_to, ?) WHERE id = ?").run(timestamp, claimId);
      const claim = this.upsertClaim({
        topicId: existing.topicId,
        subject: existing.subject,
        predicate: existing.predicate,
        value,
        confidence: 1,
        status: "current",
        sourceRole: "user",
        sourceIds: [event.id],
        validFrom: timestamp,
        validTo: null,
        observedAt: timestamp,
        freshnessExpiresAt: null,
        extractionVersion: "user-correction-v1"
      });
      this.connection.prepare(`
        INSERT INTO claim_relations(id, source_claim_id, target_claim_id, relation_type, confidence, created_at)
        VALUES (?, ?, ?, 'supersedes', 1, ?)
      `).run(uuidv7(), claim.id, claimId, timestamp);
      return { event, claim, supersededClaimId: claimId };
    })();
  }

  entityDetail(entityId: string): Record<string, unknown> | null {
    const entity = this.connection.prepare("SELECT * FROM entities WHERE id = ?").get(entityId) as Record<string, unknown> | undefined;
    if (!entity) return null;
    const aliases = this.connection.prepare("SELECT id, alias, normalized_alias AS normalizedAlias, confidence, source_id AS sourceId, active, created_at AS createdAt FROM entity_aliases WHERE entity_id = ? ORDER BY confidence DESC, alias").all(entityId);
    const edges = this.connection.prepare("SELECT * FROM edges WHERE source_id = ? OR target_id = ? ORDER BY created_at DESC").all(entityId, entityId);
    const mergeHistory = this.connection.prepare("SELECT id, source_id AS sourceId, target_id AS targetId, reversed_at AS reversedAt, created_at AS createdAt FROM merge_history WHERE object_type = 'entity' AND (source_id = ? OR target_id = ?) ORDER BY created_at DESC").all(entityId, entityId);
    return {
      entity: {
        id: String(entity.id), type: String(entity.core_type), displayName: String(entity.display_name),
        status: String(entity.status), description: String(entity.canonical_description),
        createdAt: String(entity.created_at), updatedAt: String(entity.updated_at)
      },
      aliases,
      edges,
      mergeHistory
    };
  }

  listEntityMergeCandidates(limit = 50, offset = 0): Array<Record<string, unknown>> {
    const entities = this.connection.prepare("SELECT * FROM entities WHERE status = 'active' ORDER BY updated_at DESC LIMIT 300").all() as Array<Record<string, unknown>>;
    const aliases = this.connection.prepare("SELECT entity_id, normalized_alias FROM entity_aliases WHERE active = 1").all() as Array<{ entity_id: string; normalized_alias: string }>;
    const aliasSets = new Map<string, Set<string>>();
    for (const alias of aliases) {
      const values = aliasSets.get(alias.entity_id) ?? new Set<string>();
      values.add(alias.normalized_alias);
      aliasSets.set(alias.entity_id, values);
    }
    const similarity = (left: string, right: string): number => {
      if (left === right) return 1;
      if (!left || !right) return 0;
      const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
      for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
        const current = [leftIndex];
        for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
          current[rightIndex] = Math.min(
            (current[rightIndex - 1] ?? 0) + 1,
            (previous[rightIndex] ?? 0) + 1,
            (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
          );
        }
        previous.splice(0, previous.length, ...current);
      }
      return 1 - (previous[right.length] ?? Math.max(left.length, right.length)) / Math.max(left.length, right.length);
    };
    const candidates: Array<Record<string, unknown>> = [];
    for (let leftIndex = 0; leftIndex < entities.length; leftIndex += 1) {
      const left = entities[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < entities.length; rightIndex += 1) {
        const right = entities[rightIndex]!;
        if (left.core_type !== right.core_type) continue;
        const leftName = String(left.normalized_name);
        const rightName = String(right.normalized_name);
        const sharedAlias = [...(aliasSets.get(String(left.id)) ?? [])].some((alias) => aliasSets.get(String(right.id))?.has(alias));
        const score = sharedAlias ? 0.98 : leftName.includes(rightName) || rightName.includes(leftName) ? 0.82 : similarity(leftName, rightName);
        if (score < 0.72 || score >= 0.999) continue;
        candidates.push({
          sourceId: String(left.id), targetId: String(right.id), score,
          sourceName: String(left.display_name), targetName: String(right.display_name), type: String(left.core_type),
          reason: sharedAlias ? "shared normalized alias" : "similar normalized names"
        });
      }
    }
    const start = Math.max(0, offset);
    return candidates.sort((left, right) => Number(right.score) - Number(left.score)).slice(start, start + Math.max(1, Math.min(limit, 101)));
  }

  entityMergeImpact(sourceId: string, targetId: string): Record<string, unknown> | null {
    if (sourceId === targetId) return null;
    const source = this.connection.prepare("SELECT * FROM entities WHERE id = ? AND status = 'active'").get(sourceId) as Record<string, unknown> | undefined;
    const target = this.connection.prepare("SELECT * FROM entities WHERE id = ? AND status = 'active'").get(targetId) as Record<string, unknown> | undefined;
    if (!source || !target || source.core_type !== target.core_type) return null;
    return {
      sourceId, targetId,
      sourceName: String(source.display_name), targetName: String(target.display_name), type: String(source.core_type),
      aliasesMoved: Number((this.connection.prepare("SELECT COUNT(*) AS count FROM entity_aliases WHERE entity_id = ?").get(sourceId) as { count: number }).count),
      edgesRewritten: Number((this.connection.prepare("SELECT COUNT(*) AS count FROM edges WHERE source_id = ? OR target_id = ?").get(sourceId, sourceId) as { count: number }).count),
      reversible: true
    };
  }

  mergeEntities(sourceId: string, targetId: string): { mergeId: string; sourceId: string; targetId: string } {
    return this.connection.transaction(() => {
      const impact = this.entityMergeImpact(sourceId, targetId);
      if (!impact) throw Object.assign(new Error("Entities cannot be merged."), { code: "ENTITY_MERGE_INVALID" });
      const source = this.connection.prepare("SELECT * FROM entities WHERE id = ?").get(sourceId) as Record<string, unknown>;
      const target = this.connection.prepare("SELECT * FROM entities WHERE id = ?").get(targetId) as Record<string, unknown>;
      const sourceAliases = this.connection.prepare("SELECT * FROM entity_aliases WHERE entity_id = ? ORDER BY id").all(sourceId) as Array<Record<string, unknown>>;
      const targetAliases = this.connection.prepare("SELECT * FROM entity_aliases WHERE entity_id = ? ORDER BY id").all(targetId) as Array<Record<string, unknown>>;
      const edgesBefore = this.connection.prepare("SELECT * FROM edges WHERE source_id IN (?, ?) OR target_id IN (?, ?) ORDER BY id").all(sourceId, targetId, sourceId, targetId) as Array<Record<string, unknown>>;
      const mergeId = uuidv7();
      const timestamp = now();
      const snapshot: Record<string, unknown> = { source, target, sourceAliases, targetAliases, edgesBefore };
      this.connection.prepare("INSERT INTO merge_history(id, object_type, source_id, target_id, snapshot_json, created_at) VALUES (?, 'entity', ?, ?, ?, ?)").run(mergeId, sourceId, targetId, "{}", timestamp);
      const insertAlias = this.connection.prepare(`
        INSERT OR IGNORE INTO entity_aliases(id, entity_id, alias, normalized_alias, confidence, source_id, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const alias of sourceAliases) insertAlias.run(uuidv7(), targetId, alias.alias, alias.normalized_alias, alias.confidence, alias.source_id, alias.active, alias.created_at);
      this.connection.prepare("DELETE FROM entity_aliases WHERE entity_id = ?").run(sourceId);
      const sourceEdges = edgesBefore.filter((edge) => edge.source_id === sourceId || edge.target_id === sourceId);
      this.connection.prepare("DELETE FROM edges WHERE source_id = ? OR target_id = ?").run(sourceId, sourceId);
      for (const edge of sourceEdges) {
        const mappedSource = edge.source_id === sourceId ? targetId : String(edge.source_id);
        const mappedTarget = edge.target_id === sourceId ? targetId : String(edge.target_id);
        if (mappedSource === mappedTarget) continue;
        const existing = this.connection.prepare("SELECT * FROM edges WHERE source_id = ? AND target_id = ? AND edge_type = ?").get(mappedSource, mappedTarget, edge.edge_type) as Record<string, unknown> | undefined;
        if (existing) {
          const evidence = [...new Set([...parseJson<string[]>(existing.evidence_json, []), ...parseJson<string[]>(edge.evidence_json, [])])];
          this.connection.prepare("UPDATE edges SET evidence_json = ?, status = CASE WHEN status = 'conflicted' OR ? = 'conflicted' THEN 'conflicted' ELSE status END WHERE id = ?").run(JSON.stringify(evidence), edge.status, existing.id);
        } else {
          this.connection.prepare(`
            INSERT INTO edges(id, source_id, target_id, edge_type, label, status, evidence_json, valid_from, valid_to, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(uuidv7(), mappedSource, mappedTarget, edge.edge_type, edge.label, edge.status, edge.evidence_json, edge.valid_from, edge.valid_to, edge.created_at);
        }
      }
      this.connection.prepare("UPDATE entities SET status = 'merged', updated_at = ? WHERE id = ?").run(timestamp, sourceId);
      this.connection.prepare("UPDATE entities SET updated_at = ? WHERE id = ?").run(timestamp, targetId);
      snapshot.postFingerprint = this.#entityMergeFingerprint(sourceId, targetId);
      this.connection.prepare("UPDATE merge_history SET snapshot_json = ? WHERE id = ?").run(JSON.stringify(snapshot), mergeId);
      return { mergeId, sourceId, targetId };
    })();
  }

  reverseEntityMerge(mergeId: string): { mergeId: string; sourceId: string; targetId: string; reversedAt: string } {
    return this.connection.transaction(() => {
      const merge = this.connection.prepare("SELECT * FROM merge_history WHERE id = ? AND object_type = 'entity' AND reversed_at IS NULL").get(mergeId) as Record<string, unknown> | undefined;
      if (!merge) throw Object.assign(new Error("Active entity merge not found."), { code: "ENTITY_MERGE_NOT_FOUND" });
      const snapshot = parseJson<Record<string, unknown>>(merge.snapshot_json, {});
      const sourceId = String(merge.source_id);
      const targetId = String(merge.target_id);
      if (snapshot.postFingerprint !== this.#entityMergeFingerprint(sourceId, targetId)) {
        throw Object.assign(new Error("The merged entity changed; reverse newer changes first or review it manually."), { code: "ENTITY_MERGE_CHANGED" });
      }
      const source = snapshot.source as Record<string, unknown>;
      const target = snapshot.target as Record<string, unknown>;
      const sourceAliases = snapshot.sourceAliases as Array<Record<string, unknown>>;
      const targetAliases = snapshot.targetAliases as Array<Record<string, unknown>>;
      const edgesBefore = snapshot.edgesBefore as Array<Record<string, unknown>>;
      this.connection.prepare("DELETE FROM entity_aliases WHERE entity_id IN (?, ?)").run(sourceId, targetId);
      const insertAlias = this.connection.prepare(`INSERT INTO entity_aliases(id, entity_id, alias, normalized_alias, confidence, source_id, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const alias of [...sourceAliases, ...targetAliases]) insertAlias.run(alias.id, alias.entity_id, alias.alias, alias.normalized_alias, alias.confidence, alias.source_id, alias.active, alias.created_at);
      this.connection.prepare("DELETE FROM edges WHERE source_id IN (?, ?) OR target_id IN (?, ?)").run(sourceId, targetId, sourceId, targetId);
      const insertEdge = this.connection.prepare(`INSERT INTO edges(id, source_id, target_id, edge_type, label, status, evidence_json, valid_from, valid_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const edge of edgesBefore) insertEdge.run(edge.id, edge.source_id, edge.target_id, edge.edge_type, edge.label, edge.status, edge.evidence_json, edge.valid_from, edge.valid_to, edge.created_at);
      const restoreEntity = this.connection.prepare("UPDATE entities SET core_type = ?, display_name = ?, normalized_name = ?, status = ?, canonical_description = ?, created_at = ?, updated_at = ? WHERE id = ?");
      restoreEntity.run(source.core_type, source.display_name, source.normalized_name, source.status, source.canonical_description, source.created_at, source.updated_at, source.id);
      restoreEntity.run(target.core_type, target.display_name, target.normalized_name, target.status, target.canonical_description, target.created_at, target.updated_at, target.id);
      const reversedAt = now();
      this.connection.prepare("UPDATE merge_history SET reversed_at = ? WHERE id = ?").run(reversedAt, mergeId);
      return { mergeId, sourceId, targetId, reversedAt };
    })();
  }

  #entityMergeFingerprint(sourceId: string, targetId: string): string {
    return stableHash(JSON.stringify({
      entities: this.connection.prepare("SELECT * FROM entities WHERE id IN (?, ?) ORDER BY id").all(sourceId, targetId),
      aliases: this.connection.prepare("SELECT * FROM entity_aliases WHERE entity_id IN (?, ?) ORDER BY id").all(sourceId, targetId),
      edges: this.connection.prepare("SELECT * FROM edges WHERE source_id IN (?, ?) OR target_id IN (?, ?) ORDER BY id").all(sourceId, targetId, sourceId, targetId)
    }));
  }

  graph(focusId?: string, limit = 300, hops: 1 | 2 = 2, includeHistory = true): GraphResponse {
    if (focusId) return this.#focusedGraph(focusId, limit, hops, includeHistory);
    const nodeMap = new Map<string, GraphResponse["nodes"][number]>();
    const edgeMap = new Map<string, GraphResponse["edges"][number]>();
    const addNode = (node: GraphResponse["nodes"][number]) => { if (!nodeMap.has(node.id)) nodeMap.set(node.id, node); };
    const addEdge = (edge: GraphResponse["edges"][number]) => { if (!edgeMap.has(edge.id)) edgeMap.set(edge.id, edge); };

    const topics = this.listTopics(Math.min(500, limit));
    for (const topic of topics) addNode({ id: topic.id, type: "topic", label: topic.title, subtitle: topic.type, status: "current", weight: 2 });
    const entities = this.connection.prepare("SELECT * FROM entities WHERE status = 'active' ORDER BY updated_at DESC LIMIT ?").all(Math.min(500, limit)) as Array<Record<string, unknown>>;
    for (const entity of entities) addNode({ id: String(entity.id), type: "entity", label: String(entity.display_name), subtitle: String(entity.core_type), status: String(entity.status), weight: 1.8 });
    const claims = this.listClaims(Math.min(1_000, Math.max(limit * 2, 200))).filter((claim) => includeHistory || (claim.status !== "historical" && claim.status !== "superseded" && claim.status !== "expired"));
    for (const claim of claims) {
      addNode({ id: claim.id, type: "claim", label: `${claim.subject} ${claim.predicate}`, subtitle: claim.value, status: claim.status, weight: claim.confidence });
      if (claim.topicId) addEdge({
        id: graphId(claim.topicId, claim.id, "contains"), source: claim.topicId, target: claim.id, type: "contains",
        status: claim.status === "conflicted" ? "conflicted" : ["historical", "superseded", "expired"].includes(claim.status) ? "historical" : "current",
        evidenceIds: claim.sourceIds
      });
      const subject = claim.subject.normalize("NFKC").toLocaleLowerCase();
      const matchedEntity = entities.find((entity) => String(entity.normalized_name) === subject)
        ?? entities.find((entity) => subject.includes(String(entity.normalized_name)) || String(entity.normalized_name).includes(subject));
      if (matchedEntity) addEdge({
        id: graphId(String(matchedEntity.id), claim.id, "asserts"), source: String(matchedEntity.id), target: claim.id,
        type: "asserts", status: claim.status === "conflicted" ? "conflicted" : ["historical", "superseded", "expired"].includes(claim.status) ? "historical" : "current",
        evidenceIds: claim.sourceIds
      });
      for (const sourceId of claim.sourceIds) {
        const event = this.getEvent(sourceId);
        if (event) {
          addNode({ id: event.id, type: "event", label: `${event.role === "user" ? "User" : "Assistant"} · turn ${event.sequence}`, subtitle: event.content.slice(0, 90), status: event.active ? "current" : "historical", weight: 0.9 });
          addEdge({ id: graphId(claim.id, event.id, "supported_by"), source: claim.id, target: event.id, type: "supported_by", status: event.active ? "current" : "historical", evidenceIds: [event.id] });
          continue;
        }
        const chunk = this.connection.prepare(`
          SELECT sc.id, sc.source_id, sc.ordinal, s.title, s.type AS source_type, s.freshness_class, s.provenance_json,
            a.id AS attachment_id, a.filename
          FROM source_chunks sc JOIN sources s ON s.id = sc.source_id LEFT JOIN attachments a ON a.source_id = s.id
          WHERE sc.id = ?
        `).get(sourceId) as Record<string, unknown> | undefined;
        if (chunk) {
          const sourceStatus = effectiveSourceStatus(chunk);
          addNode({ id: sourceId, type: "source", label: String(chunk.filename ?? chunk.title), subtitle: `Evidence chunk ${Number(chunk.ordinal) + 1}`, status: sourceStatus, weight: 0.8 });
          addEdge({ id: graphId(claim.id, sourceId, "supported_by"), source: claim.id, target: sourceId, type: "supported_by", status: sourceStatus === "expired" ? "historical" : "current", evidenceIds: [sourceId] });
          if (chunk.attachment_id) {
            const artifactId = String(chunk.attachment_id);
            addNode({ id: artifactId, type: "artifact", label: String(chunk.filename), subtitle: "attachment", status: "current", weight: 1 });
            addEdge({ id: graphId(sourceId, artifactId, "from_artifact"), source: sourceId, target: artifactId, type: "from_artifact", status: "current", evidenceIds: [sourceId] });
          }
          continue;
        }
        const source = this.connection.prepare("SELECT id, title, type, freshness_class, provenance_json FROM sources WHERE id = ?").get(sourceId) as Record<string, unknown> | undefined;
        if (source) {
          const sourceStatus = effectiveSourceStatus(source);
          addNode({ id: sourceId, type: "source", label: String(source.title), subtitle: String(source.type), status: sourceStatus, weight: 0.9 });
          addEdge({ id: graphId(claim.id, sourceId, "supported_by"), source: claim.id, target: sourceId, type: "supported_by", status: sourceStatus === "expired" ? "historical" : "current", evidenceIds: [sourceId] });
        }
      }
    }

    const edgeRows = this.connection.prepare("SELECT * FROM edges ORDER BY created_at DESC LIMIT ?").all(Math.min(2_000, limit * 5)) as Array<Record<string, unknown>>;
    for (const row of edgeRows) {
      const status = ["historical", "conflicted"].includes(String(row.status)) ? String(row.status) as "historical" | "conflicted" : "current";
      if (!includeHistory && status === "historical") continue;
      addEdge({ id: String(row.id), source: String(row.source_id), target: String(row.target_id), type: String(row.edge_type), ...(row.label ? { label: String(row.label) } : {}), status, evidenceIds: parseJson<string[]>(row.evidence_json, []) });
    }
    const links = this.connection.prepare("SELECT * FROM page_links ORDER BY created_at DESC LIMIT ?").all(Math.min(1_000, limit * 3)) as Array<Record<string, unknown>>;
    for (const link of links) addEdge({
      id: String(link.id), source: String(link.source_topic_id), target: String(link.target_topic_id), type: String(link.relation_type),
      status: "current", evidenceIds: parseJson<string[]>(link.evidence_json, [])
    });

    // Relationships whose endpoints are not in this bounded materialization are
    // intentionally omitted. Focus traversal then caps what reaches the browser.
    for (const [id, edge] of edgeMap) if (!nodeMap.has(edge.source) || !nodeMap.has(edge.target)) edgeMap.delete(id);
    const allEdges = [...edgeMap.values()];
    const defaultFocus = topics[0]?.id ?? (entities[0]?.id ? String(entities[0].id) : claims[0]?.id ?? null);
    const requestedFocus = focusId && nodeMap.has(focusId) ? focusId : defaultFocus;
    if (!requestedFocus) return { nodes: [], edges: [], focusId: null, truncated: false };
    const reachable = new Set<string>([requestedFocus]);
    let frontier = new Set<string>([requestedFocus]);
    for (let depth = 0; depth < hops; depth += 1) {
      const next = new Set<string>();
      for (const edge of allEdges) {
        if (frontier.has(edge.source) && !reachable.has(edge.target)) next.add(edge.target);
        if (frontier.has(edge.target) && !reachable.has(edge.source)) next.add(edge.source);
      }
      for (const id of next) reachable.add(id);
      frontier = next;
    }
    const orderedIds = [requestedFocus, ...[...reachable].filter((id) => id !== requestedFocus)];
    const selectedIds = new Set(orderedIds.slice(0, limit));
    const nodes = orderedIds.slice(0, limit).map((id) => nodeMap.get(id)).filter((node): node is GraphResponse["nodes"][number] => Boolean(node));
    const graphEdges = allEdges.filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target));
    return { nodes, edges: graphEdges, focusId: requestedFocus, truncated: reachable.size > limit };
  }

  /**
   * Materialize an exact, bounded neighborhood around a user-selected record.
   *
   * The general graph above intentionally samples recent records for the
   * initial overview. A focused request has different semantics: the selected
   * object must never disappear merely because it is older than a recency cap,
   * and an unknown identifier must never turn into an unrelated graph. Every
   * expansion below starts from an indexed adjacency lookup and retains at most
   * `limit + 1` nodes so the caller receives an honest truncation signal.
   */
  #focusedGraph(focusId: string, limit: number, hops: 1 | 2, includeHistory: boolean): GraphResponse {
    type Node = GraphResponse["nodes"][number];
    type Edge = GraphResponse["edges"][number];
    const historicalStatuses = new Set(["expired", "historical", "superseded", "merged", "inactive", "failed", "incomplete", "excluded"]);
    const isHistorical = (status: string | undefined) => Boolean(status && historicalStatuses.has(status));
    const nodeCache = new Map<string, Node | null>();
    const nodeMap = new Map<string, Node>();
    const edgeMap = new Map<string, Edge>();
    const materializationLimit = Math.max(1, limit) + 1;
    const adjacencyLimit = Math.min(1_001, Math.max(32, limit + 1));
    let truncated = false;

    const loadNode = (id: string): Node | null => {
      if (nodeCache.has(id)) return nodeCache.get(id) ?? null;

      const topic = this.getTopic(id);
      if (topic) {
        const lifecycle = this.connection.prepare("SELECT lifecycle_status FROM topic_pages WHERE id = ?").get(id) as { lifecycle_status: string } | undefined;
        const node: Node = { id, type: "topic", label: topic.title, subtitle: topic.type, status: lifecycle?.lifecycle_status ?? "current", weight: 2 };
        nodeCache.set(id, node);
        return node;
      }

      const entity = this.connection.prepare("SELECT * FROM entities WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      if (entity) {
        const node: Node = { id, type: "entity", label: String(entity.display_name), subtitle: String(entity.core_type), status: String(entity.status), weight: 1.8 };
        nodeCache.set(id, node);
        return node;
      }

      const claim = this.getClaim(id, true);
      if (claim) {
        const node: Node = { id, type: "claim", label: `${claim.subject} ${claim.predicate}`, subtitle: claim.value, status: claim.status, weight: claim.confidence };
        nodeCache.set(id, node);
        return node;
      }

      const event = this.getEvent(id);
      if (event) {
        const status = event.status === "complete" ? (event.active ? "current" : "historical") : event.status;
        const node: Node = { id, type: "event", label: `${event.role === "user" ? "User" : event.role === "assistant" ? "Assistant" : "Tool"} · turn ${event.sequence}`, subtitle: event.content.slice(0, 90), status, weight: 0.9 };
        nodeCache.set(id, node);
        return node;
      }

      const chunk = this.connection.prepare(`
        SELECT sc.id, sc.source_id, sc.ordinal, s.title, s.freshness_class, s.provenance_json
        FROM source_chunks sc JOIN sources s ON s.id = sc.source_id WHERE sc.id = ?
      `).get(id) as Record<string, unknown> | undefined;
      if (chunk) {
        const node: Node = { id, type: "source", label: String(chunk.title), subtitle: `Evidence chunk ${Number(chunk.ordinal) + 1}`, status: effectiveSourceStatus(chunk), weight: 0.8 };
        nodeCache.set(id, node);
        return node;
      }

      const source = this.connection.prepare("SELECT id, title, type, freshness_class, provenance_json FROM sources WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      if (source) {
        const node: Node = { id, type: "source", label: String(source.title), subtitle: String(source.type), status: effectiveSourceStatus(source), weight: 0.9 };
        nodeCache.set(id, node);
        return node;
      }

      const attachment = this.connection.prepare("SELECT id, filename, media_type, status FROM attachments WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      if (attachment) {
        const node: Node = { id, type: "artifact", label: String(attachment.filename), subtitle: String(attachment.media_type), status: String(attachment.status), weight: 1 };
        nodeCache.set(id, node);
        return node;
      }

      const tool = this.connection.prepare("SELECT id, tool_name, status FROM tool_executions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      if (tool) {
        const node: Node = { id, type: "artifact", label: String(tool.tool_name).replaceAll("_", " "), subtitle: "tool execution", status: String(tool.status), weight: 0.8 };
        nodeCache.set(id, node);
        return node;
      }

      nodeCache.set(id, null);
      return null;
    };

    const focus = loadNode(focusId);
    if (!focus) {
      const error = new Error("That graph record was not found.") as Error & { code: string };
      error.code = "GRAPH_FOCUS_NOT_FOUND";
      throw error;
    }
    nodeMap.set(focusId, focus);

    const normalizeEdgeStatus = (requested: unknown, source: Node, target: Node): Edge["status"] => {
      if (String(requested) === "conflicted" || source.status === "conflicted" || target.status === "conflicted") return "conflicted";
      if (String(requested) === "historical" || isHistorical(source.status) || isHistorical(target.status)) return "historical";
      return "current";
    };

    const connect = (edge: Omit<Edge, "status"> & { status?: Edge["status"] }, expandedId: string, next: Set<string>) => {
      if (edge.source !== expandedId && edge.target !== expandedId) return;
      const source = loadNode(edge.source);
      const target = loadNode(edge.target);
      if (!source || !target) return;
      const neighborId = edge.source === expandedId ? edge.target : edge.source;
      const neighbor = neighborId === edge.source ? source : target;
      if (!includeHistory && isHistorical(neighbor.status) && neighborId !== focusId) return;
      const status = normalizeEdgeStatus(edge.status, source, target);
      if (!includeHistory && status === "historical" && edge.source !== focusId && edge.target !== focusId) return;
      if (!nodeMap.has(neighborId)) {
        if (nodeMap.size >= materializationLimit) {
          truncated = true;
          return;
        }
        nodeMap.set(neighborId, neighbor);
        next.add(neighborId);
      }
      if (!nodeMap.has(edge.source)) nodeMap.set(edge.source, source);
      if (!nodeMap.has(edge.target)) nodeMap.set(edge.target, target);
      edgeMap.set(edge.id, { ...edge, status });
    };

    const expand = (id: string, next: Set<string>) => {
      const current = loadNode(id);
      if (!current) return;

      const genericEdges = this.connection.prepare(`
        SELECT * FROM edges WHERE source_id = ? OR target_id = ?
        ORDER BY created_at DESC, id ASC LIMIT ?
      `).all(id, id, adjacencyLimit) as Array<Record<string, unknown>>;
      for (const row of genericEdges) connect({
        id: String(row.id), source: String(row.source_id), target: String(row.target_id), type: String(row.edge_type),
        ...(row.label ? { label: String(row.label) } : {}),
        status: String(row.status) === "conflicted" ? "conflicted" : String(row.status) === "historical" ? "historical" : "current",
        evidenceIds: parseJson<string[]>(row.evidence_json, [])
      }, id, next);

      const pageLinks = this.connection.prepare(`
        SELECT * FROM page_links WHERE source_topic_id = ? OR target_topic_id = ?
        ORDER BY created_at DESC, id ASC LIMIT ?
      `).all(id, id, adjacencyLimit) as Array<Record<string, unknown>>;
      for (const row of pageLinks) connect({
        id: String(row.id), source: String(row.source_topic_id), target: String(row.target_topic_id), type: String(row.relation_type),
        evidenceIds: parseJson<string[]>(row.evidence_json, [])
      }, id, next);

      const claimRelations = this.connection.prepare(`
        SELECT * FROM claim_relations WHERE source_claim_id = ? OR target_claim_id = ?
        ORDER BY created_at DESC, id ASC LIMIT ?
      `).all(id, id, adjacencyLimit) as Array<Record<string, unknown>>;
      for (const row of claimRelations) connect({
        id: String(row.id), source: String(row.source_claim_id), target: String(row.target_claim_id), type: String(row.relation_type),
        status: String(row.relation_type) === "contradicts" ? "conflicted" : "current", evidenceIds: []
      }, id, next);

      const directClaimSources = this.connection.prepare(`
        SELECT claim_id, source_id FROM claim_sources WHERE claim_id = ?
        ORDER BY source_id ASC LIMIT ?
      `).all(id, adjacencyLimit) as Array<{ claim_id: string; source_id: string }>;
      for (const row of directClaimSources) connect({
        id: graphId(row.claim_id, row.source_id, "supported_by"), source: row.claim_id, target: row.source_id,
        type: "supported_by", evidenceIds: [row.source_id]
      }, id, next);
      const reverseClaimSources = this.connection.prepare(`
        SELECT claim_id, source_id FROM claim_sources WHERE source_id = ?
        ORDER BY claim_id ASC LIMIT ?
      `).all(id, adjacencyLimit) as Array<{ claim_id: string; source_id: string }>;
      for (const row of reverseClaimSources) connect({
        id: graphId(row.claim_id, row.source_id, "supported_by"), source: row.claim_id, target: row.source_id,
        type: "supported_by", evidenceIds: [row.source_id]
      }, id, next);

      const topicClaims = this.connection.prepare(`
        SELECT id FROM claims WHERE topic_id = ? ORDER BY observed_at DESC, id ASC LIMIT ?
      `).all(id, adjacencyLimit) as Array<{ id: string }>;
      for (const row of topicClaims) connect({
        id: graphId(id, row.id, "contains"), source: id, target: row.id, type: "contains", evidenceIds: this.getClaim(row.id, true)?.sourceIds ?? []
      }, id, next);
      const claimTopic = this.connection.prepare("SELECT topic_id FROM claims WHERE id = ?").get(id) as { topic_id: string | null } | undefined;
      if (claimTopic?.topic_id) connect({
        id: graphId(claimTopic.topic_id, id, "contains"), source: claimTopic.topic_id, target: id, type: "contains", evidenceIds: this.getClaim(id, true)?.sourceIds ?? []
      }, id, next);

      const parentChunk = this.connection.prepare("SELECT source_id FROM source_chunks WHERE id = ?").get(id) as { source_id: string } | undefined;
      if (parentChunk) connect({
        id: graphId(parentChunk.source_id, id, "contains_chunk"), source: parentChunk.source_id, target: id, type: "contains_chunk", evidenceIds: [id]
      }, id, next);
      const childChunks = this.connection.prepare(`
        SELECT id, source_id FROM source_chunks WHERE source_id = ? ORDER BY ordinal ASC LIMIT ?
      `).all(id, adjacencyLimit) as Array<{ id: string; source_id: string }>;
      for (const row of childChunks) connect({
        id: graphId(row.source_id, row.id, "contains_chunk"), source: row.source_id, target: row.id, type: "contains_chunk", evidenceIds: [row.id]
      }, id, next);

      const attachmentParent = this.connection.prepare("SELECT source_id FROM attachments WHERE id = ?").get(id) as { source_id: string } | undefined;
      if (attachmentParent) connect({
        id: graphId(attachmentParent.source_id, id, "has_artifact"), source: attachmentParent.source_id, target: id, type: "has_artifact", evidenceIds: [id]
      }, id, next);
      const sourceAttachments = this.connection.prepare(`
        SELECT id, source_id FROM attachments WHERE source_id = ? ORDER BY created_at DESC, id ASC LIMIT ?
      `).all(id, adjacencyLimit) as Array<{ id: string; source_id: string }>;
      for (const row of sourceAttachments) connect({
        id: graphId(row.source_id, row.id, "has_artifact"), source: row.source_id, target: row.id, type: "has_artifact", evidenceIds: [row.id]
      }, id, next);

      const eventAttachments = this.connection.prepare(`
        SELECT event_id, attachment_id FROM event_attachments
        WHERE event_id = ? OR attachment_id = ? ORDER BY event_id, attachment_id LIMIT ?
      `).all(id, id, adjacencyLimit) as Array<{ event_id: string; attachment_id: string }>;
      for (const row of eventAttachments) connect({
        id: graphId(row.event_id, row.attachment_id, "attached"), source: row.event_id, target: row.attachment_id, type: "attached", evidenceIds: [row.attachment_id]
      }, id, next);

      // Conversation adjacency and exact context-packet references are graph
      // edges. Context refs are recorded on the user turn before its assistant
      // event exists; inherit them when an answer is focused so "Show in
      // graph" reveals the evidence that actually grounded that answer.
      const eventRow = this.connection.prepare("SELECT role, parent_event_id FROM events WHERE id = ?")
        .get(id) as { role: string; parent_event_id: string | null } | undefined;
      if (eventRow?.parent_event_id) connect({
        id: graphId(id, eventRow.parent_event_id, "response_to"), source: id, target: eventRow.parent_event_id,
        type: "response_to", evidenceIds: []
      }, id, next);
      const childEvents = this.connection.prepare(`
        SELECT id FROM events WHERE parent_event_id = ? ORDER BY sequence ASC LIMIT ?
      `).all(id, adjacencyLimit) as Array<{ id: string }>;
      for (const child of childEvents) connect({
        id: graphId(child.id, id, "response_to"), source: child.id, target: id, type: "response_to", evidenceIds: []
      }, id, next);

      const contextOwnerIds = eventRow?.role === "assistant" && eventRow.parent_event_id
        ? [id, eventRow.parent_event_id]
        : [id];
      const contextMarks = contextOwnerIds.map(() => "?").join(",");
      const contextReferences = this.connection.prepare(`
        SELECT ref_type, ref_value FROM context_refs
        WHERE event_id IN (${contextMarks})
        ORDER BY CASE WHEN event_id = ? THEN 0 ELSE 1 END, id ASC LIMIT ?
      `).all(...contextOwnerIds, id, adjacencyLimit) as Array<{ ref_type: string; ref_value: string }>;
      for (const reference of contextReferences) {
        if (reference.ref_value === id) continue;
        connect({
          id: graphId(id, reference.ref_value, `grounded_by:${reference.ref_type}`),
          source: id,
          target: reference.ref_value,
          type: "grounded_by",
          label: reference.ref_type.replaceAll("_", " "),
          evidenceIds: [reference.ref_value]
        }, id, next);
      }

      const topicRevision = this.connection.prepare(`
        SELECT tpr.id FROM topic_pages tp JOIN topic_page_revisions tpr
          ON tpr.topic_id = tp.id AND tpr.revision_number = tp.active_revision WHERE tp.id = ?
      `).get(id) as { id: string } | undefined;
      if (topicRevision) {
        const cited = this.connection.prepare(`
          SELECT DISTINCT source_id FROM page_section_sources WHERE revision_id = ? ORDER BY source_id LIMIT ?
        `).all(topicRevision.id, adjacencyLimit) as Array<{ source_id: string }>;
        for (const row of cited) connect({
          id: graphId(id, row.source_id, "cites"), source: id, target: row.source_id, type: "cites", evidenceIds: [row.source_id]
        }, id, next);
      }

      if (current.type === "entity") {
        const entity = this.connection.prepare("SELECT display_name FROM entities WHERE id = ?").get(id) as { display_name: string } | undefined;
        const aliases = this.connection.prepare("SELECT alias FROM entity_aliases WHERE entity_id = ? AND active = 1 ORDER BY confidence DESC LIMIT 24").all(id) as Array<{ alias: string }>;
        const subjects = [...new Set([entity?.display_name, ...aliases.map((row) => row.alias)].filter((value): value is string => Boolean(value)))];
        if (subjects.length) {
          const marks = subjects.map(() => "?").join(",");
          const asserted = this.connection.prepare(`SELECT id FROM claims WHERE subject IN (${marks}) ORDER BY observed_at DESC, id ASC LIMIT ?`).all(...subjects, adjacencyLimit) as Array<{ id: string }>;
          for (const row of asserted) connect({
            id: graphId(id, row.id, "asserts"), source: id, target: row.id, type: "asserts", evidenceIds: this.getClaim(row.id, true)?.sourceIds ?? []
          }, id, next);
        }
      } else if (current.type === "claim") {
        const claim = this.getClaim(id, true);
        if (claim) {
          const normalized = claim.subject.normalize("NFKC").toLocaleLowerCase();
          const asserted = this.connection.prepare(`
            SELECT DISTINCT e.id FROM entities e LEFT JOIN entity_aliases ea ON ea.entity_id = e.id AND ea.active = 1
            WHERE e.normalized_name = ? OR ea.normalized_alias = ? ORDER BY e.updated_at DESC, e.id ASC LIMIT ?
          `).all(normalized, normalized, adjacencyLimit) as Array<{ id: string }>;
          for (const row of asserted) connect({
            id: graphId(row.id, id, "asserts"), source: row.id, target: id, type: "asserts", evidenceIds: claim.sourceIds
          }, id, next);
        }
      }

      const tool = this.connection.prepare("SELECT run_id FROM tool_executions WHERE id = ?").get(id) as { run_id: string } | undefined;
      const eventRun = this.connection.prepare("SELECT run_id FROM events WHERE id = ?").get(id) as { run_id: string | null } | undefined;
      const runId = tool?.run_id ?? eventRun?.run_id;
      if (runId) {
        if (tool) {
          const runEvents = this.connection.prepare("SELECT id FROM events WHERE run_id = ? ORDER BY sequence ASC LIMIT ?").all(runId, adjacencyLimit) as Array<{ id: string }>;
          for (const row of runEvents) connect({
            id: graphId(id, row.id, "used_in"), source: id, target: row.id, type: "used_in", evidenceIds: [id]
          }, id, next);
        } else {
          const tools = this.connection.prepare("SELECT id FROM tool_executions WHERE run_id = ? ORDER BY started_at ASC LIMIT ?").all(runId, adjacencyLimit) as Array<{ id: string }>;
          for (const row of tools) connect({
            id: graphId(row.id, id, "used_in"), source: row.id, target: id, type: "used_in", evidenceIds: [row.id]
          }, id, next);
        }
      }
    };

    let frontier = new Set<string>([focusId]);
    for (let depth = 0; depth < hops && frontier.size > 0; depth += 1) {
      const next = new Set<string>();
      for (const id of frontier) expand(id, next);
      frontier = next;
    }

    const orderedNodes = [...nodeMap.values()];
    if (orderedNodes.length > limit) truncated = true;
    const nodes = orderedNodes.slice(0, limit);
    const selected = new Set(nodes.map((node) => node.id));
    const edges = [...edgeMap.values()].filter((edge) => selected.has(edge.source) && selected.has(edge.target));
    return { nodes, edges, focusId, truncated };
  }

  pinMemory(objectType: string, objectId: string, label: string): string {
    const existing = this.connection.prepare("SELECT id FROM memory_pins WHERE object_type = ? AND object_id = ?").get(objectType, objectId) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = uuidv7();
    this.connection.prepare("INSERT INTO memory_pins(id, object_type, object_id, label, created_at) VALUES (?, ?, ?, ?, ?)").run(id, objectType, objectId, label, now());
    return id;
  }

  unpinMemory(id: string): boolean {
    return this.connection.prepare("DELETE FROM memory_pins WHERE id = ?").run(id).changes > 0;
  }

  listPins(limit = 100, offset = 0): Array<Record<string, unknown>> {
    return this.connection.prepare("SELECT * FROM memory_pins ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?").all(Math.min(limit, 501), Math.max(0, offset)) as Array<Record<string, unknown>>;
  }

  #scrubEvidenceReferences(
    table: "edges" | "page_links",
    removed: readonly string[]
  ): { rowsRemoved: number; referencesRemoved: number } {
    const removedIds = new Set(removed);
    if (removedIds.size === 0) return { rowsRemoved: 0, referencesRemoved: 0 };
    const rows = this.connection.prepare(`SELECT id, evidence_json FROM ${table}`).all() as Array<{ id: string; evidence_json: string }>;
    let rowsRemoved = 0;
    let referencesRemoved = 0;
    for (const row of rows) {
      let evidence: unknown;
      try { evidence = JSON.parse(row.evidence_json); }
      catch {
        // Malformed evidence cannot be safely rewritten. If it contains a
        // deleted identifier, remove the relationship rather than retain a
        // privacy-bearing orphan.
        if (removed.some((id) => row.evidence_json.includes(id))) {
          rowsRemoved += this.connection.prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.id).changes;
          referencesRemoved += 1;
        }
        continue;
      }
      if (!Array.isArray(evidence)) {
        if (evidenceReferencesAny(evidence, removedIds)) {
          rowsRemoved += this.connection.prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.id).changes;
          referencesRemoved += 1;
        }
        continue;
      }
      const retained = evidence.filter((entry) => !evidenceReferencesAny(entry, removedIds));
      const removedCount = evidence.length - retained.length;
      if (removedCount === 0) continue;
      referencesRemoved += removedCount;
      if (retained.length === 0) rowsRemoved += this.connection.prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.id).changes;
      else this.connection.prepare(`UPDATE ${table} SET evidence_json = ? WHERE id = ?`).run(JSON.stringify(retained), row.id);
    }
    return { rowsRemoved, referencesRemoved };
  }

  /**
   * Remove content-bearing secondary records that mention a hard-deleted
   * identifier. These tables are deliberately denormalized for diagnostics and
   * replay, so foreign keys cannot provide the privacy closure for us.
   */
  #scrubIdentifierShadows(removed: readonly string[]): Record<string, number> {
    const removedIds = [...new Set(removed.filter(Boolean))];
    const counts = {
      jobsRemoved: 0,
      retrievalTracesRemoved: 0,
      contextPacketsRemoved: 0,
      toolExecutionsRemoved: 0,
      contextRefsRemoved: 0,
      idempotencyRecordsRemoved: 0,
      mergeHistoryRemoved: 0,
      entityAliasesRemoved: 0
    };
    for (const id of removedIds) {
      const needle = `%${id.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      counts.jobsRemoved += this.connection.prepare(
        "DELETE FROM jobs WHERE payload_json LIKE ? ESCAPE '\\' OR result_json LIKE ? ESCAPE '\\'"
      ).run(needle, needle).changes;
      counts.retrievalTracesRemoved += this.connection.prepare(`
        DELETE FROM retrieval_traces
        WHERE query_text LIKE ? ESCAPE '\\'
           OR classifications_json LIKE ? ESCAPE '\\'
           OR candidates_json LIKE ? ESCAPE '\\'
           OR selected_ids_json LIKE ? ESCAPE '\\'
           OR token_budget_json LIKE ? ESCAPE '\\'
      `).run(needle, needle, needle, needle, needle).changes;
      counts.contextPacketsRemoved += this.connection.prepare(`
        DELETE FROM context_packets
        WHERE budget_json LIKE ? ESCAPE '\\' OR source_ids_json LIKE ? ESCAPE '\\'
      `).run(needle, needle).changes;
      counts.toolExecutionsRemoved += this.connection.prepare(`
        DELETE FROM tool_executions
        WHERE arguments_json LIKE ? ESCAPE '\\'
           OR output_text LIKE ? ESCAPE '\\'
           OR citations_json LIKE ? ESCAPE '\\'
           OR sandbox_json LIKE ? ESCAPE '\\'
      `).run(needle, needle, needle, needle).changes;
      counts.contextRefsRemoved += this.connection.prepare(`
        DELETE FROM context_refs
        WHERE ref_value LIKE ? ESCAPE '\\' OR metadata_json LIKE ? ESCAPE '\\'
      `).run(needle, needle).changes;
      counts.idempotencyRecordsRemoved += this.connection.prepare(
        "DELETE FROM idempotency_keys WHERE response_json LIKE ? ESCAPE '\\'"
      ).run(needle).changes;
      counts.mergeHistoryRemoved += this.connection.prepare(`
        DELETE FROM merge_history
        WHERE source_id = ? OR target_id = ? OR snapshot_json LIKE ? ESCAPE '\\'
      `).run(id, id, needle).changes;
      counts.entityAliasesRemoved += this.connection.prepare(
        "DELETE FROM entity_aliases WHERE source_id = ?"
      ).run(id).changes;
    }
    return counts;
  }

  #topicProposalArtifactsReferencing(removed: ReadonlySet<string>): {
    normalizedProposalIds: string[];
    legacyEntries: Array<{ key: string; retained: unknown[]; removed: unknown[] }>;
    topicIds: string[];
    revisionIds: string[];
    candidateRevisionIds: string[];
  } {
    if (removed.size === 0) return { normalizedProposalIds: [], legacyEntries: [], topicIds: [], revisionIds: [], candidateRevisionIds: [] };
    const normalizedProposalIds: string[] = [];
    const topicIds = new Set<string>();
    const revisionIds = new Set<string>();
    const candidateRevisionIds = new Set<string>();
    const removedValues = [...removed];
    const rawReferencesRemoved = (value: unknown) => typeof value === "string" && removedValues.some((id) => value.includes(id));
    for (const header of this.connection.prepare("SELECT * FROM topic_shard_proposals ORDER BY id").all() as Array<Record<string, unknown>>) {
      const proposalId = String(header.id);
      const patches = this.connection.prepare("SELECT * FROM topic_shard_proposal_patches WHERE proposal_id = ?").all(proposalId) as Array<Record<string, unknown>>;
      const routes = this.connection.prepare("SELECT * FROM topic_shard_proposal_routes WHERE proposal_id = ?").all(proposalId) as Array<Record<string, unknown>>;
      const outputs = this.connection.prepare("SELECT * FROM topic_shard_proposal_outputs WHERE proposal_id = ?").all(proposalId) as Array<Record<string, unknown>>;
      const guards = this.connection.prepare("SELECT * FROM topic_shard_proposal_claim_guards WHERE proposal_id = ?").all(proposalId) as Array<Record<string, unknown>>;
      const proposal = this.getTopicShardProposal(proposalId, true);
      const rawMatch = [header, ...patches, ...routes, ...outputs, ...guards]
        .some((row) => Object.values(row).some(rawReferencesRemoved));
      if (!rawMatch && (!proposal || !evidenceReferencesAny(proposal, removed))) continue;
      normalizedProposalIds.push(proposalId);
      if (typeof header.parent_topic_id === "string") topicIds.add(header.parent_topic_id);
      if (typeof header.parent_revision_id === "string") revisionIds.add(header.parent_revision_id);
      for (const patch of patches) {
        if (typeof patch.base_topic_id === "string") topicIds.add(patch.base_topic_id);
        if (typeof patch.base_revision_id === "string") revisionIds.add(patch.base_revision_id);
      }
      for (const output of outputs) {
        if (typeof output.topic_id === "string") topicIds.add(output.topic_id);
        if (typeof output.revision_id === "string") {
          revisionIds.add(output.revision_id);
          candidateRevisionIds.add(output.revision_id);
        }
      }
      if (!proposal) continue;
      topicIds.add(proposal.topicId);
      revisionIds.add(proposal.parentBase.revisionId);
      for (const patch of proposal.patches) {
        if (patch.base) {
          topicIds.add(patch.base.topicId);
          revisionIds.add(patch.base.revisionId);
        }
        for (const output of patch.outputs) {
          topicIds.add(output.topicId);
          revisionIds.add(output.revisionId);
          candidateRevisionIds.add(output.revisionId);
        }
      }
    }

    const legacyEntries: Array<{ key: string; retained: unknown[]; removed: unknown[] }> = [];
    for (const key of ["memory.pendingTopicProposals", "memory.resolvedTopicProposals"]) {
      const setting = this.connection.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as { value_json: string } | undefined;
      if (!setting) continue;
      const value = parseJson<unknown>(setting.value_json, null);
      if (!Array.isArray(value)) {
        if (rawReferencesRemoved(setting.value_json)) legacyEntries.push({ key, retained: [], removed: [setting.value_json] });
        continue;
      }
      const matching = value.filter((entry) => evidenceReferencesAny(entry, removed));
      if (matching.length === 0) continue;
      const retained = value.filter((entry) => !evidenceReferencesAny(entry, removed));
      legacyEntries.push({ key, retained, removed: matching });
      for (const entry of matching) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const proposal = entry as Record<string, unknown>;
        if (typeof proposal.topicId === "string") topicIds.add(proposal.topicId);
        if (typeof proposal.parentRevisionId === "string") {
          revisionIds.add(proposal.parentRevisionId);
          candidateRevisionIds.add(proposal.parentRevisionId);
        }
        if (!Array.isArray(proposal.children)) continue;
        for (const child of proposal.children) {
          if (!child || typeof child !== "object" || Array.isArray(child)) continue;
          const record = child as Record<string, unknown>;
          if (typeof record.topicId === "string") topicIds.add(record.topicId);
          if (typeof record.revisionId === "string") {
            revisionIds.add(record.revisionId);
            candidateRevisionIds.add(record.revisionId);
          }
        }
      }
    }
    return {
      normalizedProposalIds,
      legacyEntries,
      topicIds: [...topicIds],
      revisionIds: [...revisionIds],
      candidateRevisionIds: [...candidateRevisionIds]
    };
  }

  /**
   * Topic proposals are immutable snapshots and can retain deleted source text
   * even though their candidate pages are not active. Remove the whole atomic
   * proposal, then remove only the isolated revisions/pages it owned.
   */
  #purgeTopicProposalsReferencing(removed: readonly string[]): {
    affectedTopicIds: string[];
    removedRevisionIds: string[];
    removedTopicIds: string[];
    proposalsRemoved: number;
    proposalRevisionsRemoved: number;
    proposalTopicsRemoved: number;
  } {
    const removedSet = new Set(removed.filter(Boolean));
    const artifacts = this.#topicProposalArtifactsReferencing(removedSet);
    let proposalsRemoved = 0;
    for (const proposalId of artifacts.normalizedProposalIds) {
      proposalsRemoved += this.connection.prepare("DELETE FROM topic_shard_proposals WHERE id = ?").run(proposalId).changes;
    }
    for (const legacy of artifacts.legacyEntries) {
      proposalsRemoved += legacy.removed.length;
      this.setSetting(legacy.key, legacy.retained);
    }

    const affectedTopicIds = new Set(artifacts.topicIds);
    const removedRevisionIds: string[] = [];
    for (const revisionId of artifacts.candidateRevisionIds) {
      const row = this.connection.prepare(`
        SELECT revision.topic_id, page.lifecycle_status
        FROM topic_page_revisions revision JOIN topic_pages page ON page.id = revision.topic_id
        WHERE revision.id = ?
      `).get(revisionId) as { topic_id: string; lifecycle_status: string } | undefined;
      if (!row) continue;
      // A candidate revision belongs to the proposal snapshot even when an
      // accepted proposal made it active. Deleting the exact immutable revision
      // lets the normal repair path rebuild from surviving evidence.
      this.connection.prepare("DELETE FROM vectors WHERE source_id = ?").run(revisionId);
      if (this.connection.prepare("DELETE FROM topic_page_revisions WHERE id = ?").run(revisionId).changes === 1) {
        removedRevisionIds.push(revisionId);
        affectedTopicIds.add(row.topic_id);
      }
    }

    const removedTopicIds: string[] = [];
    for (const topicId of artifacts.topicIds) {
      const page = this.connection.prepare("SELECT lifecycle_status FROM topic_pages WHERE id = ?").get(topicId) as { lifecycle_status: string } | undefined;
      if (!page || page.lifecycle_status !== "proposal") continue;
      const stillNormalized = this.connection.prepare(`
        SELECT 1 FROM topic_shard_proposal_outputs WHERE topic_id = ? LIMIT 1
      `).get(topicId);
      const stillLegacy = ["memory.pendingTopicProposals", "memory.resolvedTopicProposals"].some((key) =>
        evidenceReferencesAny(this.getSetting<unknown>(key, []), new Set([topicId])));
      if (stillNormalized || stillLegacy) continue;
      this.connection.prepare("UPDATE claims SET topic_id = NULL WHERE topic_id = ?").run(topicId);
      this.connection.prepare("DELETE FROM edges WHERE source_id = ? OR target_id = ?").run(topicId, topicId);
      this.connection.prepare("DELETE FROM memory_pins WHERE object_id = ?").run(topicId);
      this.connection.prepare("DELETE FROM vectors WHERE source_id = ?").run(topicId);
      if (this.connection.prepare("DELETE FROM topic_pages WHERE id = ? AND lifecycle_status = 'proposal'").run(topicId).changes === 1) {
        removedTopicIds.push(topicId);
      }
    }
    return {
      affectedTopicIds: [...affectedTopicIds],
      removedRevisionIds,
      removedTopicIds,
      proposalsRemoved,
      proposalRevisionsRemoved: removedRevisionIds.length,
      proposalTopicsRemoved: removedTopicIds.length
    };
  }

  /**
   * Discover the privacy dependency closure before mutating any provenance.
   * Runs can cite a claim, topic, or exact revision without citing the original
   * event/chunk, and a generated answer can in turn become evidence for more
   * claims. Iterate until those two graphs reach a fixed point.
   */
  #collectEvidenceDeletionClosure(
    initialSourceIds: readonly string[],
    initialClaimIds: readonly string[] = [],
    initialTopicIds: readonly string[] = [],
    initialRevisionRows: readonly Array<{ id: string; topic_id: string }> = []
  ): {
    sourceIds: string[];
    claimIds: string[];
    topicIds: string[];
    revisionRows: Array<{ id: string; topic_id: string }>;
    runIds: string[];
    assistantEventIds: string[];
  } {
    const sourceIds = new Set(initialSourceIds.filter(Boolean));
    const claimIds = new Set(initialClaimIds.filter(Boolean));
    const topicIds = new Set(initialTopicIds.filter(Boolean));
    const revisionRows = new Map<string, { id: string; topic_id: string }>(
      initialRevisionRows.filter((row) => row.id && row.topic_id)
        .map((row): [string, { id: string; topic_id: string }] => [row.id, row])
    );
    const runIds = new Set<string>();
    const assistantEventIds = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      const sourceValues = [...sourceIds];
      if (sourceValues.length) {
        const marks = sourceValues.map(() => "?").join(",");
        const claims = this.connection.prepare(`
          SELECT DISTINCT c.id, c.topic_id FROM claims c
          JOIN claim_sources cs ON cs.claim_id = c.id
          WHERE cs.source_id IN (${marks})
        `).all(...sourceValues) as Array<{ id: string; topic_id: string | null }>;
        for (const claim of claims) {
          if (!claimIds.has(claim.id)) { claimIds.add(claim.id); changed = true; }
          if (claim.topic_id && !topicIds.has(claim.topic_id)) { topicIds.add(claim.topic_id); changed = true; }
        }
      }

      const claimValues = [...claimIds];
      if (claimValues.length) {
        const rows = this.connection.prepare(`
          SELECT id, topic_id FROM claims
          WHERE id IN (${claimValues.map(() => "?").join(",")}) AND topic_id IS NOT NULL
        `).all(...claimValues) as Array<{ id: string; topic_id: string }>;
        for (const row of rows) {
          if (!topicIds.has(row.topic_id)) { topicIds.add(row.topic_id); changed = true; }
        }
      }
      if (sourceValues.length || claimValues.length) {
        const sourceClause = sourceValues.length
          ? `pss.source_id IN (${sourceValues.map(() => "?").join(",")})`
          : "0";
        const claimClause = claimValues.length
          ? `pss.claim_id IN (${claimValues.map(() => "?").join(",")})`
          : "0";
        const rows = this.connection.prepare(`
          SELECT DISTINCT revision.id, revision.topic_id
          FROM topic_page_revisions revision
          JOIN page_section_sources pss ON pss.revision_id = revision.id
          WHERE ${sourceClause} OR ${claimClause}
        `).all(...sourceValues, ...claimValues) as Array<{ id: string; topic_id: string }>;
        for (const row of rows) {
          if (!revisionRows.has(row.id)) { revisionRows.set(row.id, row); changed = true; }
          if (!topicIds.has(row.topic_id)) { topicIds.add(row.topic_id); changed = true; }
        }
      }

      const topicsBeforeParents = topicIds.size;
      this.#addCompiledParentTopics(topicIds);
      if (topicIds.size !== topicsBeforeParents) changed = true;
      const topicValues = [...topicIds];
      if (topicValues.length) {
        // Primary generated pages and compiler parent shells may summarize the
        // deleted evidence without carrying a complete PSS row themselves.
        const rows = this.connection.prepare(`
          SELECT id, topic_id FROM topic_page_revisions
          WHERE topic_id IN (${topicValues.map(() => "?").join(",")})
            AND author_type <> 'user'
        `).all(...topicValues) as Array<{ id: string; topic_id: string }>;
        for (const row of rows) {
          if (!revisionRows.has(row.id)) { revisionRows.set(row.id, row); changed = true; }
        }
      }

      const references = [...new Set([
        ...sourceIds,
        ...claimIds,
        ...topicIds,
        ...revisionRows.keys()
      ])];
      for (const runId of this.#dependentRunIdsForReferences(references)) {
        if (!runIds.has(runId)) { runIds.add(runId); changed = true; }
        const row = this.connection.prepare("SELECT assistant_event_id AS id FROM runs WHERE id = ? AND assistant_event_id IS NOT NULL")
          .get(runId) as { id: string } | undefined;
        if (!row) continue;
        if (!assistantEventIds.has(row.id)) { assistantEventIds.add(row.id); changed = true; }
        if (!sourceIds.has(row.id)) { sourceIds.add(row.id); changed = true; }
      }
    }
    return {
      sourceIds: [...sourceIds],
      claimIds: [...claimIds],
      topicIds: [...topicIds],
      revisionRows: [...revisionRows.values()],
      runIds: [...runIds],
      assistantEventIds: [...assistantEventIds]
    };
  }

  /**
   * Point an affected topic at the newest surviving revision. If every compiled
   * revision was evidence-dependent but independently supported claims remain,
   * create a conservative system revision immediately so hard deletion never
   * leaves a dangling topic or stale deleted text while the richer async rebuild
   * is queued.
   */
  #repairTopicAfterEvidenceDeletion(topicId: string, timestamp: string, deletedValue = ""): { removed: boolean; synthesized: boolean } {
    const topic = this.connection.prepare("SELECT * FROM topic_pages WHERE id = ?").get(topicId) as Record<string, unknown> | undefined;
    if (!topic) return { removed: true, synthesized: false };
    let repairedTitle = String(topic.title);
    let repairedSlug = String(topic.slug);
    const value = deletedValue.trim().normalize("NFKC");
    if (value && (value.length >= 3 || repairedTitle.toLocaleLowerCase() === value.toLocaleLowerCase())) {
      const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      repairedTitle = repairedTitle.replace(new RegExp(escapedValue, "giu"), "").replace(/[\s:_-]+/g, " ").trim();
      if (!repairedTitle) repairedTitle = `${String(topic.core_type)} memory`;
      const slugValue = value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      if (slugValue && repairedSlug.includes(slugValue)) {
        const titleSlug = repairedTitle.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "memory";
        repairedSlug = `${titleSlug}-${topicId.slice(0, 8)}`;
      }
      if (repairedTitle !== topic.title || repairedSlug !== topic.slug) {
        this.connection.prepare("UPDATE topic_pages SET title = ?, slug = ? WHERE id = ?").run(repairedTitle, repairedSlug, topicId);
      }
    }
    const stillActive = this.connection.prepare(`
      SELECT revision_number AS revision FROM topic_page_revisions
      WHERE topic_id = ? AND revision_number = ?
    `).get(topicId, topic.active_revision) as { revision: number } | undefined;
    // Pending proposal revisions are immutable review artifacts, not fallback
    // candidates. Selecting MAX() across all history could silently activate an
    // unrelated pending proposal after deletion removed the active revision.
    let latest = stillActive ?? this.connection.prepare(`
      SELECT MAX(revision_number) AS revision FROM topic_page_revisions
      WHERE topic_id = ? AND (
        author_type = 'user'
        OR prompt_version NOT IN ('topic-proposal-v1', 'topic-split-proposal-v2', 'topic-shard-proposal-v1')
      )
    `).get(topicId) as { revision: number | null };
    let synthesized = false;
    if (latest.revision === null) {
      const claims = this.connection.prepare(`
        SELECT c.* FROM claims c
        WHERE c.topic_id = ? AND EXISTS (
          SELECT 1 FROM claim_sources cs LEFT JOIN events e ON e.id = cs.source_id
          WHERE cs.claim_id = c.id AND (e.id IS NULL OR e.active = 1)
        )
        ORDER BY CASE c.status WHEN 'current' THEN 0 WHEN 'conflicted' THEN 1 ELSE 2 END, c.observed_at DESC
        LIMIT 1000
      `).all(topicId) as Array<Record<string, unknown>>;
      if (claims.length === 0) {
        this.connection.prepare("UPDATE claims SET topic_id = NULL WHERE topic_id = ?").run(topicId);
        this.connection.prepare("DELETE FROM edges WHERE source_id = ? OR target_id = ?").run(topicId, topicId);
        this.connection.prepare("DELETE FROM memory_pins WHERE object_id = ?").run(topicId);
        this.connection.prepare("DELETE FROM vectors WHERE source_id = ?").run(topicId);
        this.connection.prepare("DELETE FROM topic_pages WHERE id = ?").run(topicId);
        return { removed: true, synthesized: false };
      }
      const current = claims.filter((claim) => claim.status === "current" || claim.status === "conflicted");
      const historical = claims.filter((claim) => claim.status !== "current" && claim.status !== "conflicted");
      const line = (claim: Record<string, unknown>) => `- **${String(claim.subject)} ${String(claim.predicate)}:** ${String(claim.value)}`;
      const summary = `${claims.length} independently supported memory ${claims.length === 1 ? "claim remains" : "claims remain"} after hard deletion.`;
      const currentState = current.length ? current.map(line).join("\n") : "No current claims remain.";
      const history = historical.length ? historical.map(line).join("\n") : "No historical claims remain.";
      const markdown = [`# ${repairedTitle}`, "## Summary", summary, "## Current state", currentState, "## History", history, "## Related pages", "None recorded.", "## Open questions", "- Review this automatically repaired page if additional context is needed.", "## Evidence", "Every statement above is linked to the surviving claim evidence in the local vault."].join("\n\n");
      const revisionId = uuidv7();
      // Proposal revisions can remain as immutable review artifacts even when
      // none is eligible to become the active page. Continue the topic's
      // monotonic revision sequence instead of colliding with one of them.
      const revisionNumber = Number((this.connection.prepare(`
        SELECT COALESCE(MAX(revision_number), 0) + 1 AS revision
        FROM topic_page_revisions WHERE topic_id = ?
      `).get(topicId) as { revision: number }).revision);
      const sourceRows = this.connection.prepare(`
        SELECT cs.claim_id, cs.source_id FROM claim_sources cs JOIN claims c ON c.id = cs.claim_id
        LEFT JOIN events e ON e.id = cs.source_id
        WHERE c.topic_id = ? AND (e.id IS NULL OR e.active = 1)
        ORDER BY cs.claim_id, cs.source_id
      `).all(topicId) as Array<{ claim_id: string; source_id: string }>;
      this.connection.prepare(`
        INSERT INTO topic_page_revisions(id, topic_id, revision_number, markdown, summary, current_state, history,
          open_questions_json, generation_inputs_json, author_type, prompt_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, '["Review the repaired page."]', ?, 'system', 'hard-deletion-repair-v1', ?)
      `).run(revisionId, topicId, revisionNumber, markdown, summary, currentState, history, JSON.stringify([...new Set(sourceRows.map((row) => row.source_id))]), timestamp);
      const insertEvidence = this.connection.prepare(`
        INSERT INTO page_section_sources(id, revision_id, section_key, start_offset, end_offset, claim_id, source_id)
        VALUES (?, ?, 'evidence', 0, ?, ?, ?)
      `);
      for (const source of sourceRows) insertEvidence.run(uuidv7(), revisionId, markdown.length, source.claim_id, source.source_id);
      latest = { revision: revisionNumber };
      synthesized = true;
    }
    this.connection.prepare("UPDATE topic_pages SET active_revision = ?, updated_at = ? WHERE id = ?").run(latest.revision, timestamp, topicId);
    this.connection.prepare("DELETE FROM topic_fts WHERE topic_id = ?").run(topicId);
    this.connection.prepare(`INSERT INTO topic_fts(topic_id, title, content)
      SELECT tp.id, tp.title, tpr.markdown FROM topic_pages tp JOIN topic_page_revisions tpr
      ON tpr.topic_id = tp.id AND tpr.revision_number = tp.active_revision WHERE tp.id = ?`).run(topicId);
    this.connection.prepare("DELETE FROM vectors WHERE source_id = ?").run(topicId);
    return { removed: false, synthesized };
  }

  /** Include compiler-owned projection ancestors without trusting user tags. */
  #addCompiledParentTopics(topicIds: Set<string>): void {
    const queue = [...topicIds];
    const visited = new Set<string>();
    const parents = this.connection.prepare(`
      SELECT parent_topic_id AS id FROM topic_section_shards WHERE child_topic_id = ?
      UNION
      SELECT contains_link.source_topic_id AS id FROM page_links contains_link
      WHERE contains_link.target_topic_id = ? AND contains_link.relation_type = 'contains'
        AND EXISTS (
          SELECT 1 FROM page_links part_link
          WHERE part_link.source_topic_id = contains_link.target_topic_id
            AND part_link.target_topic_id = contains_link.source_topic_id
            AND part_link.relation_type = 'part_of'
        )
    `);
    while (queue.length > 0) {
      const topicId = queue.shift()!;
      if (visited.has(topicId)) continue;
      visited.add(topicId);
      for (const row of parents.all(topicId, topicId) as Array<{ id: string }>) {
        const parentId = row.id;
        if (!parentId || topicIds.has(parentId)) continue;
        if (!this.connection.prepare("SELECT 1 FROM topic_pages WHERE id = ?").get(parentId)) continue;
        topicIds.add(parentId);
        queue.push(parentId);
      }
    }
  }

  hardDeleteClaim(claimId: string, apiRecovery?: DeletionApiRecovery): { receiptId: string; operationId: string; nestedOperationIds: string[]; affectedTopicIds: string[]; counts: Record<string, number> } {
    const claim = this.connection.prepare("SELECT * FROM claims WHERE id = ?").get(claimId) as Record<string, unknown> | undefined;
    if (!claim) throw new Error("Claim not found.");
    const operationId = uuidv7();
    const timestamp = now();
    this.connection.prepare(`INSERT INTO deletion_operations(id, object_type, object_hash, phase, payload_json, created_at, updated_at)
      VALUES (?, 'claim', ?, 'prepared', ?, ?, ?)`).run(operationId, stableHash(claimId), JSON.stringify({ claimId, ...(apiRecovery ? { apiRecovery } : {}) }), timestamp, timestamp);
    try {
      return this.connection.transaction(() => {
        const topicId = claim.topic_id ? String(claim.topic_id) : null;
        const sourceIds = (this.connection.prepare("SELECT source_id FROM claim_sources WHERE claim_id = ?").all(claimId) as Array<{ source_id: string }>).map((row) => row.source_id);
        const nestedOperationIds: string[] = [];
        const relationsRemoved = Number((this.connection.prepare("SELECT COUNT(*) AS count FROM claim_relations WHERE source_claim_id = ? OR target_claim_id = ?").get(claimId, claimId) as { count: number }).count);
        const directEdgesRemoved = this.connection.prepare("DELETE FROM edges WHERE source_id = ? OR target_id = ?").run(claimId, claimId).changes;
        const edgeEvidence = this.#scrubEvidenceReferences("edges", [claimId]);
        const revisionRowsById = new Map<string, { id: string; topic_id: string }>();
        const directlyCitingRows = this.connection.prepare(`
          SELECT DISTINCT tpr.id, tpr.topic_id FROM topic_page_revisions tpr
          JOIN page_section_sources pss ON pss.revision_id = tpr.id
          WHERE pss.claim_id = ? OR pss.source_id = ?
        `).all(claimId, claimId) as Array<{ id: string; topic_id: string }>;
        for (const row of directlyCitingRows) revisionRowsById.set(row.id, row);
        if (topicId) {
          const primaryTopicRows = this.connection.prepare(`
            SELECT DISTINCT tpr.id, tpr.topic_id FROM topic_page_revisions tpr
            LEFT JOIN page_section_sources pss ON pss.revision_id = tpr.id
            WHERE tpr.topic_id = ? AND (
              tpr.author_type <> 'user' OR pss.claim_id = ? OR pss.source_id = ?
              ${sourceIds.length ? `OR pss.source_id IN (${sourceIds.map(() => "?").join(",")})` : ""}
            )
          `).all(topicId, claimId, claimId, ...sourceIds) as Array<{ id: string; topic_id: string }>;
          for (const row of primaryTopicRows) revisionRowsById.set(row.id, row);
        }
        const proposalArtifacts = this.#topicProposalArtifactsReferencing(new Set([claimId]));
        for (const revisionId of proposalArtifacts.candidateRevisionIds) {
          const row = this.connection.prepare("SELECT id, topic_id FROM topic_page_revisions WHERE id = ?").get(revisionId) as { id: string; topic_id: string } | undefined;
          if (row) revisionRowsById.set(row.id, row);
        }
        const affectedTopicIds = new Set([...revisionRowsById.values()].map((row) => row.topic_id));
        for (const proposalTopicId of proposalArtifacts.topicIds) affectedTopicIds.add(proposalTopicId);
        if (topicId) affectedTopicIds.add(topicId);
        this.#addCompiledParentTopics(affectedTopicIds);
        if (affectedTopicIds.size) {
          const topicMarks = [...affectedTopicIds].map(() => "?").join(",");
          const parentRows = this.connection.prepare(`
            SELECT id, topic_id FROM topic_page_revisions
            WHERE topic_id IN (${topicMarks}) AND author_type <> 'user'
          `).all(...affectedTopicIds) as Array<{ id: string; topic_id: string }>;
          for (const row of parentRows) revisionRowsById.set(row.id, row);
        }
        const revisionRows = [...revisionRowsById.values()];
        const revisionIds = revisionRows.map((row) => row.id);
        // Dependency discovery must happen after claim, page, and exact
        // revision references are known. Production context packets commonly
        // cite the rendered revision rather than the underlying claim. Seed the
        // fixed point with proposal guard revisions too, then follow answers
        // that became evidence for more claims/pages/runs.
        const dependencyRevisionRows = new Map<string, { id: string; topic_id: string }>(
          revisionRows.map((row): [string, { id: string; topic_id: string }] => [row.id, row])
        );
        for (const proposalRevisionId of proposalArtifacts.revisionIds) {
          const row = this.connection.prepare("SELECT id, topic_id FROM topic_page_revisions WHERE id = ?").get(proposalRevisionId) as { id: string; topic_id: string } | undefined;
          if (row) dependencyRevisionRows.set(row.id, row);
        }
        const dependencyClosure = this.#collectEvidenceDeletionClosure(
          [], [claimId], [...affectedTopicIds], [...dependencyRevisionRows.values()]
        );
        const dependentRunIds = dependencyClosure.runIds;
        const dependentAssistantEventIds = dependencyClosure.assistantEventIds;
        const proposalCleanup = this.#purgeTopicProposalsReferencing([claimId, ...revisionIds]);
        if (revisionIds.length) {
          const marks = revisionIds.map(() => "?").join(",");
          this.connection.prepare(`DELETE FROM vectors WHERE source_id IN (${marks})`).run(...revisionIds);
          this.connection.prepare(`DELETE FROM topic_page_revisions WHERE id IN (${marks})`).run(...revisionIds);
        }
        this.connection.prepare("DELETE FROM vectors WHERE source_id = ?").run(claimId);
        this.connection.prepare("DELETE FROM memory_pins WHERE object_id = ?").run(claimId);
        this.connection.prepare("DELETE FROM page_section_sources WHERE claim_id = ? OR source_id = ?").run(claimId, claimId);
        this.connection.prepare("DELETE FROM claims WHERE id = ?").run(claimId);
        const removedTopicIds = new Set(proposalCleanup.removedTopicIds);
        let topicRemoved = 0;
        let synthesizedRevision = 0;
        for (const affectedTopicId of affectedTopicIds) {
          const repaired = this.#repairTopicAfterEvidenceDeletion(affectedTopicId, timestamp, String(claim.value));
          if (repaired.removed) { topicRemoved += 1; removedTopicIds.add(affectedTopicId); }
          if (repaired.synthesized) synthesizedRevision += 1;
        }
        const removedObjectIds = [claimId, ...revisionIds, ...removedTopicIds];
        const removedEdgeEvidence = this.#scrubEvidenceReferences("edges", removedObjectIds);
        const pageLinkEvidence = this.#scrubEvidenceReferences("page_links", removedObjectIds);
        const shadowCounts = this.#scrubIdentifierShadows(removedObjectIds);
        // A generated answer is itself derived content. Reuse the event
        // deletion cascade so claims/pages learned from that answer and later
        // answers that included it as recent context are removed atomically.
        const nestedCounts: Record<string, number> = {};
        for (const assistantEventId of dependentAssistantEventIds) {
          if (!this.getEvent(assistantEventId)) continue;
          const derived = this.hardDeleteEvent(assistantEventId);
          nestedOperationIds.push(derived.operationId, ...derived.nestedOperationIds);
          for (const affectedTopicId of derived.affectedTopicIds) affectedTopicIds.add(affectedTopicId);
          for (const [key, value] of Object.entries(derived.counts)) nestedCounts[key] = (nestedCounts[key] ?? 0) + value;
        }
        const remainingRunIds = dependentRunIds.filter((runId) => this.getRun(runId) !== null);
        this.#deleteRunDerivatives(remainingRunIds, timestamp, "claim_delete");
        const nestedCount = (key: string) => nestedCounts[key] ?? 0;
        const counts = {
          claimsRemoved: 1 + nestedCount("claimsRemoved"),
          provenanceLinks: sourceIds.length + nestedCount("provenanceLinks"),
          relationsRemoved: relationsRemoved + nestedCount("relationsRemoved"),
          edgesRemoved: directEdgesRemoved + edgeEvidence.rowsRemoved + removedEdgeEvidence.rowsRemoved + nestedCount("edgesRemoved"),
          edgeEvidenceLinksRemoved: edgeEvidence.referencesRemoved + removedEdgeEvidence.referencesRemoved + nestedCount("edgeEvidenceLinksRemoved"),
          pageLinksRemoved: pageLinkEvidence.rowsRemoved + nestedCount("pageLinksRemoved"),
          pageLinkEvidenceLinksRemoved: pageLinkEvidence.referencesRemoved + nestedCount("pageLinkEvidenceLinksRemoved"),
          jobsRemoved: shadowCounts.jobsRemoved + nestedCount("jobsRemoved"),
          retrievalTracesRemoved: shadowCounts.retrievalTracesRemoved + nestedCount("retrievalTracesRemoved"),
          contextPacketsRemoved: shadowCounts.contextPacketsRemoved + nestedCount("contextPacketsRemoved"),
          toolExecutionsRemoved: shadowCounts.toolExecutionsRemoved + nestedCount("toolExecutionsRemoved"),
          contextRefsRemoved: shadowCounts.contextRefsRemoved + nestedCount("contextRefsRemoved"),
          idempotencyRecordsRemoved: shadowCounts.idempotencyRecordsRemoved + nestedCount("idempotencyRecordsRemoved"),
          mergeHistoryRemoved: shadowCounts.mergeHistoryRemoved + nestedCount("mergeHistoryRemoved"),
          entityAliasesRemoved: shadowCounts.entityAliasesRemoved + nestedCount("entityAliasesRemoved"),
          proposalsRemoved: proposalCleanup.proposalsRemoved + nestedCount("proposalsRemoved"),
          proposalRevisionsRemoved: proposalCleanup.proposalRevisionsRemoved + nestedCount("proposalRevisionsRemoved"),
          proposalTopicsRemoved: proposalCleanup.proposalTopicsRemoved + nestedCount("proposalTopicsRemoved"),
          topicRevisionsRemoved: revisionIds.length + nestedCount("topicRevisionsRemoved"),
          topicsRebuilt: affectedTopicIds.size,
          topicRemoved,
          synthesizedRevision,
          dependentRuns: dependentRunIds.length,
          dependentResponses: dependentAssistantEventIds.length,
          derivedEventsRemoved: nestedCount("events")
        };
        const receiptId = uuidv7();
        this.connection.prepare(`INSERT INTO deletion_receipts(id, request_hash, object_type, object_hash, counts_json, deleted_at)
          VALUES (?, ?, 'claim', ?, ?, ?)`).run(receiptId, stableHash(`claim:${claimId}`), stableHash(claimId), JSON.stringify(counts), timestamp);
        const affectedTopics = [...affectedTopicIds];
        const response = { receiptId, operationId, affectedTopicIds: affectedTopics, counts };
        const reportedNestedOperationIds = [...new Set(nestedOperationIds)];
        this.connection.prepare("UPDATE deletion_operations SET phase = 'database_complete', payload_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify({
          affectedTopicIds: affectedTopics,
          nestedOperationIds: reportedNestedOperationIds,
          ...(apiRecovery ? { apiRecovery: { ...apiRecovery, response } } : {})
        }), timestamp, operationId);
        return { ...response, nestedOperationIds: reportedNestedOperationIds };
      })();
    } catch (error) {
      this.connection.prepare("UPDATE deletion_operations SET phase = 'failed', last_error_code = ?, updated_at = ? WHERE id = ?").run(error instanceof Error ? error.name : "DELETE_FAILED", now(), operationId);
      throw error;
    }
  }

  hardDeleteAttachment(attachmentId: string, apiRecovery?: DeletionApiRecovery): {
    receiptId: string; operationId: string; contentHash: string; nestedOperationIds: string[];
    sharedByteReferences: number; affectedTopicIds: string[]; counts: Record<string, number>;
  } {
    const attachment = this.getAttachment(attachmentId);
    if (!attachment) throw new Error("Attachment not found.");
    const operationId = uuidv7();
    const timestamp = now();
    this.connection.prepare(`
      INSERT INTO deletion_operations(id, object_type, object_hash, phase, payload_json, created_at, updated_at)
      VALUES (?, 'attachment', ?, 'prepared', ?, ?, ?)
    `).run(operationId, stableHash(attachmentId), JSON.stringify({ attachmentId, contentHash: attachment.contentHash, ...(apiRecovery ? { apiRecovery } : {}) }), timestamp, timestamp);
    try {
      return this.connection.transaction(() => {
        const chunkIds = (this.connection.prepare("SELECT id FROM source_chunks WHERE source_id = ?").all(attachment.sourceId) as Array<{ id: string }>).map((row) => row.id);
        const sharedSourceReferences = Number((this.connection.prepare(`
          SELECT COUNT(*) AS count FROM attachments WHERE source_id = ? AND id <> ?
        `).get(attachment.sourceId, attachmentId) as { count: number }).count);
        // The normal ingestion path creates one source per logical attachment,
        // but the schema intentionally permits a source to be shared. In that
        // case only the attachment identity is being deleted: the sibling still
        // owns the source, its chunks, and every claim derived from them.
        const deleteSource = sharedSourceReferences === 0;
        const deletedChunkIds = deleteSource ? chunkIds : [];
        const attachmentReferenceIds = deleteSource
          ? [attachmentId, attachment.sourceId, ...deletedChunkIds]
          : [attachmentId];
        const dependentEvents = Number((this.connection.prepare("SELECT COUNT(*) AS count FROM event_attachments WHERE attachment_id = ?").get(attachmentId) as { count: number }).count);
        const initialClosure = this.#collectEvidenceDeletionClosure(attachmentReferenceIds);
        const dependentRunIds = initialClosure.runIds;
        const dependentAssistantEventIds = initialClosure.assistantEventIds;
        const affectedTopics = new Set(initialClosure.topicIds);
        const nestedOperationIds: string[] = [];
        const nestedCounts: Record<string, number> = {};
        for (const assistantEventId of dependentAssistantEventIds) {
          if (!this.getEvent(assistantEventId)) continue;
          const nested = this.hardDeleteEvent(assistantEventId);
          nestedOperationIds.push(nested.operationId, ...nested.nestedOperationIds);
          for (const nestedTopicId of nested.affectedTopicIds) affectedTopics.add(nestedTopicId);
          for (const [key, value] of Object.entries(nested.counts)) nestedCounts[key] = (nestedCounts[key] ?? 0) + value;
        }

        // Nested answer deletion removes assistant-sourced claims first. Re-read
        // the direct attachment closure so counts and shared-source decisions are
        // based only on rows this operation still owns.
        const directClosure = this.#collectEvidenceDeletionClosure(attachmentReferenceIds);
        const claimIds = directClosure.claimIds;
        const directAffectedTopics = new Set(directClosure.topicIds);
        const affectedRevisions = new Set(directClosure.revisionRows.map((row) => row.id));
        for (const directTopicId of directAffectedTopics) affectedTopics.add(directTopicId);
        const marks = attachmentReferenceIds.map(() => "?").join(",");
        const provenanceLinks = this.connection.prepare(`DELETE FROM claim_sources WHERE source_id IN (${marks})`).run(...attachmentReferenceIds).changes;
        const unsupportedClaims = claimIds.length ? (this.connection.prepare(`
          SELECT c.id FROM claims c LEFT JOIN claim_sources cs ON cs.claim_id = c.id
          WHERE c.id IN (${claimIds.map(() => "?").join(",")}) GROUP BY c.id HAVING COUNT(cs.source_id) = 0
        `).all(...claimIds) as Array<{ id: string }>).map((row) => row.id) : [];
        const claimRelationsRemoved = unsupportedClaims.length ? Number((this.connection.prepare(`
          SELECT COUNT(*) AS count FROM claim_relations
          WHERE source_claim_id IN (${unsupportedClaims.map(() => "?").join(",")})
             OR target_claim_id IN (${unsupportedClaims.map(() => "?").join(",")})
        `).get(...unsupportedClaims, ...unsupportedClaims) as { count: number }).count) : 0;
        const proposalCleanup = this.#purgeTopicProposalsReferencing([
          ...attachmentReferenceIds,
          ...unsupportedClaims,
          ...affectedRevisions
        ]);
        for (const proposalTopicId of proposalCleanup.affectedTopicIds) {
          affectedTopics.add(proposalTopicId);
          directAffectedTopics.add(proposalTopicId);
        }
        for (const revisionId of proposalCleanup.removedRevisionIds) affectedRevisions.add(revisionId);
        this.#addCompiledParentTopics(directAffectedTopics);
        for (const parentTopicId of directAffectedTopics) affectedTopics.add(parentTopicId);
        if (unsupportedClaims.length) {
          const claimMarks = unsupportedClaims.map(() => "?").join(",");
          this.connection.prepare(`DELETE FROM vectors WHERE source_id IN (${claimMarks})`).run(...unsupportedClaims);
          this.connection.prepare(`DELETE FROM memory_pins WHERE object_id IN (${claimMarks})`).run(...unsupportedClaims);
          this.connection.prepare(`DELETE FROM claims WHERE id IN (${claimMarks})`).run(...unsupportedClaims);
        }
        if (affectedRevisions.size) {
          const revisionIds = [...affectedRevisions];
          const revisionMarks = revisionIds.map(() => "?").join(",");
          this.connection.prepare(`DELETE FROM vectors WHERE source_id IN (${revisionMarks})`).run(...revisionIds);
          this.connection.prepare(`DELETE FROM topic_page_revisions WHERE id IN (${revisionMarks})`).run(...revisionIds);
        }
        const removedTopicIds = new Set(proposalCleanup.removedTopicIds);
        for (const topicId of directAffectedTopics) {
          if (this.#repairTopicAfterEvidenceDeletion(topicId, timestamp).removed) removedTopicIds.add(topicId);
        }
        this.connection.prepare(`DELETE FROM vectors WHERE source_id IN (${marks})`).run(...attachmentReferenceIds);
        const removedObjectIds = [...attachmentReferenceIds, ...unsupportedClaims, ...affectedRevisions, ...removedTopicIds];
        const removedObjectMarks = removedObjectIds.map(() => "?").join(",");
        const directEdgesRemoved = this.connection.prepare(`DELETE FROM edges WHERE source_id IN (${removedObjectMarks}) OR target_id IN (${removedObjectMarks})`).run(...removedObjectIds, ...removedObjectIds).changes;
        const edgeEvidence = this.#scrubEvidenceReferences("edges", removedObjectIds);
        const pageLinkEvidence = this.#scrubEvidenceReferences("page_links", removedObjectIds);
        const shadowCounts = this.#scrubIdentifierShadows(removedObjectIds);
        const remainingRunIds = dependentRunIds.filter((runId) => this.getRun(runId) !== null);
        this.#deleteRunDerivatives(remainingRunIds, timestamp, "attachment_delete");
        if (deleteSource) this.connection.prepare("DELETE FROM sources WHERE id = ?").run(attachment.sourceId);
        else this.connection.prepare("DELETE FROM attachments WHERE id = ?").run(attachmentId);
        const sharedByteReferences = Number((this.connection.prepare("SELECT COUNT(*) AS count FROM attachments WHERE content_hash = ?").get(attachment.contentHash) as { count: number }).count);
        const nestedCount = (key: string) => nestedCounts[key] ?? 0;
        const counts = {
          attachments: 1,
          dependentEvents,
          chunks: deletedChunkIds.length,
          provenanceLinks: provenanceLinks + nestedCount("provenanceLinks"),
          claimsRemoved: unsupportedClaims.length + nestedCount("claimsRemoved"),
          relationsRemoved: claimRelationsRemoved + nestedCount("relationsRemoved"),
          edgesRemoved: directEdgesRemoved + edgeEvidence.rowsRemoved + nestedCount("edgesRemoved"),
          edgeEvidenceLinksRemoved: edgeEvidence.referencesRemoved + nestedCount("edgeEvidenceLinksRemoved"),
          pageLinksRemoved: pageLinkEvidence.rowsRemoved + nestedCount("pageLinksRemoved"),
          pageLinkEvidenceLinksRemoved: pageLinkEvidence.referencesRemoved + nestedCount("pageLinkEvidenceLinksRemoved"),
          topicRevisionsRemoved: affectedRevisions.size + nestedCount("topicRevisionsRemoved"),
          topicsRebuilt: affectedTopics.size,
          dependentRuns: dependentRunIds.length,
          dependentResponses: dependentAssistantEventIds.length,
          derivedEventsRemoved: nestedCount("events"),
          jobsRemoved: shadowCounts.jobsRemoved + nestedCount("jobsRemoved"),
          retrievalTracesRemoved: shadowCounts.retrievalTracesRemoved + nestedCount("retrievalTracesRemoved"),
          contextPacketsRemoved: shadowCounts.contextPacketsRemoved + nestedCount("contextPacketsRemoved"),
          toolExecutionsRemoved: shadowCounts.toolExecutionsRemoved + nestedCount("toolExecutionsRemoved"),
          contextRefsRemoved: shadowCounts.contextRefsRemoved + nestedCount("contextRefsRemoved"),
          idempotencyRecordsRemoved: shadowCounts.idempotencyRecordsRemoved + nestedCount("idempotencyRecordsRemoved"),
          mergeHistoryRemoved: shadowCounts.mergeHistoryRemoved + nestedCount("mergeHistoryRemoved"),
          entityAliasesRemoved: shadowCounts.entityAliasesRemoved + nestedCount("entityAliasesRemoved"),
          proposalsRemoved: proposalCleanup.proposalsRemoved + nestedCount("proposalsRemoved"),
          proposalRevisionsRemoved: proposalCleanup.proposalRevisionsRemoved + nestedCount("proposalRevisionsRemoved"),
          proposalTopicsRemoved: proposalCleanup.proposalTopicsRemoved + nestedCount("proposalTopicsRemoved")
        };
        const receiptId = uuidv7();
        this.connection.prepare(`INSERT INTO deletion_receipts(id, request_hash, object_type, object_hash, counts_json, deleted_at)
          VALUES (?, ?, 'attachment', ?, ?, ?)`).run(receiptId, stableHash(`attachment:${attachmentId}`), stableHash(attachmentId), JSON.stringify(counts), timestamp);
        const response = { receiptId, operationId, contentHash: attachment.contentHash, sharedByteReferences, affectedTopicIds: [...affectedTopics], counts };
        this.connection.prepare("UPDATE deletion_operations SET phase = 'database_complete', payload_json = ?, updated_at = ? WHERE id = ?").run(
          JSON.stringify({
            contentHash: attachment.contentHash,
            affectedTopicIds: [...affectedTopics],
            sharedByteReferences,
            nestedOperationIds: [...new Set(nestedOperationIds)],
            ...(apiRecovery ? { apiRecovery: { ...apiRecovery, response } } : {})
          }), timestamp, operationId
        );
        return { ...response, nestedOperationIds: [...new Set(nestedOperationIds)] };
      })();
    } catch (error) {
      this.connection.prepare("UPDATE deletion_operations SET phase = 'failed', last_error_code = ?, updated_at = ? WHERE id = ?").run(error instanceof Error ? error.name : "DELETE_FAILED", now(), operationId);
      throw error;
    }
  }

  topicDeletionClosureIds(topicId: string): string[] {
    const childrenByParent = new Map<string, Set<string>>();
    const addChild = (parentId: string, childId: string) => {
      if (!parentId || parentId === childId) return;
      const children = childrenByParent.get(parentId) ?? new Set<string>();
      children.add(childId);
      childrenByParent.set(parentId, children);
    };
    for (const shard of this.connection.prepare("SELECT child_topic_id, parent_topic_id FROM topic_section_shards").all() as Array<{ child_topic_id: string; parent_topic_id: string }>) {
      addChild(shard.parent_topic_id, shard.child_topic_id);
    }
    for (const link of this.connection.prepare(`
      SELECT contains_link.source_topic_id, contains_link.target_topic_id
      FROM page_links contains_link
      WHERE contains_link.relation_type = 'contains'
        AND EXISTS (
          SELECT 1 FROM page_links part_link
          WHERE part_link.source_topic_id = contains_link.target_topic_id
            AND part_link.target_topic_id = contains_link.source_topic_id
            AND part_link.relation_type = 'part_of'
        )
    `).all() as Array<{ source_topic_id: string; target_topic_id: string }>) {
      addChild(link.source_topic_id, link.target_topic_id);
    }
    const closure = new Set<string>([topicId]);
    const queue = [topicId];
    while (queue.length) {
      const parentId = queue.shift()!;
      for (const childId of childrenByParent.get(parentId) ?? []) {
        if (closure.has(childId)) continue;
        closure.add(childId);
        queue.push(childId);
      }
    }
    return [...closure];
  }

  hardDeleteTopic(topicId: string, apiRecovery?: DeletionApiRecovery): {
    receiptId: string;
    operationId: string;
    nestedOperationIds: string[];
    deletedTopicIds: string[];
    affectedTopicIds: string[];
    counts: Record<string, number>;
  } {
    const topic = this.getTopic(topicId);
    if (!topic) throw new Error("Topic not found.");
    const operationId = uuidv7();
    const timestamp = now();
    this.connection.prepare(`INSERT INTO deletion_operations(id, object_type, object_hash, phase, payload_json, created_at, updated_at)
      VALUES (?, 'topic', ?, 'prepared', ?, ?, ?)`).run(operationId, stableHash(topicId), JSON.stringify({ topicId, ...(apiRecovery ? { apiRecovery } : {}) }), timestamp, timestamp);
    try {
      return this.connection.transaction(() => {
        const deletedTopicIds = this.topicDeletionClosureIds(topicId);
        const topicMarks = deletedTopicIds.map(() => "?").join(",");
        const revisionIds = (this.connection.prepare(`SELECT id FROM topic_page_revisions WHERE topic_id IN (${topicMarks})`).all(...deletedTopicIds) as Array<{ id: string }>).map((row) => row.id);
        const affectedTopicIds = new Set(deletedTopicIds);
        // A child-only deletion must not delete its compiler parent, but the
        // parent projection/file is stale and must be included in recovery.
        this.#addCompiledParentTopics(affectedTopicIds);
        const proposalArtifacts = this.#topicProposalArtifactsReferencing(new Set([...deletedTopicIds, ...revisionIds]));
        for (const proposalTopicId of proposalArtifacts.topicIds) affectedTopicIds.add(proposalTopicId);
        const dependencyRevisionIds = [...new Set([...revisionIds, ...proposalArtifacts.revisionIds])];
        const dependencyRevisionRows = dependencyRevisionIds.length
          ? this.connection.prepare(`
              SELECT id, topic_id FROM topic_page_revisions
              WHERE id IN (${dependencyRevisionIds.map(() => "?").join(",")})
            `).all(...dependencyRevisionIds) as Array<{ id: string; topic_id: string }>
          : [];
        const dependencyClosure = this.#collectEvidenceDeletionClosure(
          [], [], [...affectedTopicIds], dependencyRevisionRows
        );
        const dependentRunIds = dependencyClosure.runIds;
        const dependentAssistantEventIds = dependencyClosure.assistantEventIds;
        const nestedOperationIds: string[] = [];
        const nestedCounts: Record<string, number> = {};
        const proposalCleanup = this.#purgeTopicProposalsReferencing([...deletedTopicIds, ...revisionIds]);
        for (const proposalTopicId of proposalCleanup.affectedTopicIds) affectedTopicIds.add(proposalTopicId);
        const edgesRemoved = this.connection.prepare(`DELETE FROM edges WHERE source_id IN (${topicMarks}) OR target_id IN (${topicMarks})`).run(...deletedTopicIds, ...deletedTopicIds).changes;
        const claimsRetained = this.connection.prepare(`UPDATE claims SET topic_id = NULL WHERE topic_id IN (${topicMarks})`).run(...deletedTopicIds).changes;
        const pageLinksRemoved = this.connection.prepare(`DELETE FROM page_links WHERE source_topic_id IN (${topicMarks}) OR target_topic_id IN (${topicMarks})`).run(...deletedTopicIds, ...deletedTopicIds).changes;
        this.connection.prepare(`DELETE FROM memory_pins WHERE object_id IN (${topicMarks})`).run(...deletedTopicIds);
        this.connection.prepare(`DELETE FROM vectors WHERE source_id IN (${topicMarks})`).run(...deletedTopicIds);
        if (revisionIds.length) this.connection.prepare(`DELETE FROM vectors WHERE source_id IN (${revisionIds.map(() => "?").join(",")})`).run(...revisionIds);
        this.connection.prepare(`DELETE FROM topic_projection_dirty WHERE parent_topic_id IN (${topicMarks})`).run(...deletedTopicIds);
        const shardRowsRemoved = this.connection.prepare(`DELETE FROM topic_section_shards WHERE parent_topic_id IN (${topicMarks}) OR child_topic_id IN (${topicMarks})`).run(...deletedTopicIds, ...deletedTopicIds).changes;
        this.connection.prepare(`DELETE FROM topic_projection_state WHERE parent_topic_id IN (${topicMarks})`).run(...deletedTopicIds);
        this.connection.prepare(`DELETE FROM topic_fts WHERE topic_id IN (${topicMarks})`).run(...deletedTopicIds);
        this.connection.prepare(`DELETE FROM topic_pages WHERE id IN (${topicMarks})`).run(...deletedTopicIds);
        const deletedTopicSet = new Set(deletedTopicIds);
        const additionallyRemovedTopicIds = new Set(proposalCleanup.removedTopicIds);
        for (const proposalTopicId of proposalCleanup.affectedTopicIds) {
          if (!deletedTopicSet.has(proposalTopicId)
            && this.#repairTopicAfterEvidenceDeletion(proposalTopicId, timestamp).removed) additionallyRemovedTopicIds.add(proposalTopicId);
        }
        const removedEvidenceIds = [...new Set([
          ...deletedTopicIds,
          ...revisionIds,
          ...proposalCleanup.removedRevisionIds,
          ...additionallyRemovedTopicIds
        ])];
        const edgeEvidence = this.#scrubEvidenceReferences("edges", removedEvidenceIds);
        const pageLinkEvidence = this.#scrubEvidenceReferences("page_links", removedEvidenceIds);
        const shadowCounts = this.#scrubIdentifierShadows(removedEvidenceIds);
        for (const assistantEventId of dependentAssistantEventIds) {
          if (!this.getEvent(assistantEventId)) continue;
          const nested = this.hardDeleteEvent(assistantEventId);
          nestedOperationIds.push(nested.operationId, ...nested.nestedOperationIds);
          for (const nestedTopicId of nested.affectedTopicIds) affectedTopicIds.add(nestedTopicId);
          for (const [key, value] of Object.entries(nested.counts)) nestedCounts[key] = (nestedCounts[key] ?? 0) + value;
        }
        const remainingRunIds = dependentRunIds.filter((runId) => this.getRun(runId) !== null);
        this.#deleteRunDerivatives(remainingRunIds, timestamp, "topic_delete");
        const nestedCount = (key: string) => nestedCounts[key] ?? 0;
        const counts = {
          topics: deletedTopicIds.length,
          descendants: deletedTopicIds.length - 1,
          revisions: revisionIds.length,
          claimsRetained,
          edgesRemoved: edgesRemoved + edgeEvidence.rowsRemoved + nestedCount("edgesRemoved"),
          pageLinksRemoved: pageLinksRemoved + pageLinkEvidence.rowsRemoved + nestedCount("pageLinksRemoved"),
          shardRowsRemoved,
          dependentRuns: dependentRunIds.length,
          dependentResponses: dependentAssistantEventIds.length,
          derivedEventsRemoved: nestedCount("events"),
          claimsRemoved: nestedCount("claimsRemoved"),
          provenanceLinks: nestedCount("provenanceLinks"),
          relationsRemoved: nestedCount("relationsRemoved"),
          edgeEvidenceLinksRemoved: edgeEvidence.referencesRemoved + nestedCount("edgeEvidenceLinksRemoved"),
          pageLinkEvidenceLinksRemoved: pageLinkEvidence.referencesRemoved + nestedCount("pageLinkEvidenceLinksRemoved"),
          jobsRemoved: shadowCounts.jobsRemoved + nestedCount("jobsRemoved"),
          retrievalTracesRemoved: shadowCounts.retrievalTracesRemoved + nestedCount("retrievalTracesRemoved"),
          contextPacketsRemoved: shadowCounts.contextPacketsRemoved + nestedCount("contextPacketsRemoved"),
          toolExecutionsRemoved: shadowCounts.toolExecutionsRemoved + nestedCount("toolExecutionsRemoved"),
          contextRefsRemoved: shadowCounts.contextRefsRemoved + nestedCount("contextRefsRemoved"),
          idempotencyRecordsRemoved: shadowCounts.idempotencyRecordsRemoved + nestedCount("idempotencyRecordsRemoved"),
          mergeHistoryRemoved: shadowCounts.mergeHistoryRemoved + nestedCount("mergeHistoryRemoved"),
          entityAliasesRemoved: shadowCounts.entityAliasesRemoved + nestedCount("entityAliasesRemoved"),
          proposalsRemoved: proposalCleanup.proposalsRemoved + nestedCount("proposalsRemoved"),
          proposalRevisionsRemoved: proposalCleanup.proposalRevisionsRemoved + nestedCount("proposalRevisionsRemoved"),
          proposalTopicsRemoved: proposalCleanup.proposalTopicsRemoved + nestedCount("proposalTopicsRemoved")
        };
        const receiptId = uuidv7();
        this.connection.prepare(`INSERT INTO deletion_receipts(id, request_hash, object_type, object_hash, counts_json, deleted_at)
          VALUES (?, ?, 'topic', ?, ?, ?)`).run(receiptId, stableHash(`topic:${topicId}`), stableHash(topicId), JSON.stringify(counts), timestamp);
        const response = { receiptId, operationId, deletedTopicIds, affectedTopicIds: [...affectedTopicIds], counts };
        this.connection.prepare("UPDATE deletion_operations SET phase = 'database_complete', payload_json = ?, updated_at = ? WHERE id = ?").run(
          JSON.stringify({
            deletedTopicIds,
            affectedTopicIds: [...affectedTopicIds],
            nestedOperationIds: [...new Set(nestedOperationIds)],
            ...(apiRecovery ? { apiRecovery: { ...apiRecovery, response } } : {})
          }), timestamp, operationId
        );
        return { ...response, nestedOperationIds: [...new Set(nestedOperationIds)] };
      })();
    } catch (error) {
      this.connection.prepare("UPDATE deletion_operations SET phase = 'failed', last_error_code = ?, updated_at = ? WHERE id = ?").run(error instanceof Error ? error.name : "DELETE_FAILED", now(), operationId);
      throw error;
    }
  }

  hardDeleteEvent(eventId: string, apiRecovery?: DeletionApiRecovery): {
    receiptId: string;
    operationId: string;
    nestedOperationIds: string[];
    counts: Record<string, number>;
    affectedTopicIds: string[];
  } {
    const operationId = uuidv7();
    const timestamp = now();
    this.connection.prepare(`
      INSERT INTO deletion_operations(id, object_type, object_hash, phase, payload_json, created_at, updated_at)
      VALUES (?, 'event', ?, 'prepared', ?, ?, ?)
    `).run(operationId, stableHash(eventId), JSON.stringify({ eventId, ...(apiRecovery ? { apiRecovery } : {}) }), timestamp, timestamp);
    try {
      return this.connection.transaction(() => {
        const event = this.getEvent(eventId);
        if (!event) throw new Error("Event not found.");

        const directEventIds = new Set<string>([eventId]);
        if (event.role === "user") {
          const children = this.connection.prepare("SELECT id FROM events WHERE parent_event_id = ?").all(eventId) as Array<{ id: string }>;
          for (const child of children) directEventIds.add(child.id);
        }

        const eventIds = [...directEventIds];
        const eventMarks = eventIds.map(() => "?").join(",");
        const initialClosure = this.#collectEvidenceDeletionClosure(eventIds);
        const associatedRunRows = this.connection.prepare(`
          SELECT DISTINCT id FROM runs
          WHERE user_event_id IN (${eventMarks}) OR assistant_event_id IN (${eventMarks})
             OR id IN (SELECT run_id FROM events WHERE id IN (${eventMarks}) AND run_id IS NOT NULL)
        `).all(...eventIds, ...eventIds, ...eventIds) as Array<{ id: string }>;
        const runIds = [...new Set([...associatedRunRows.map((row) => row.id), ...initialClosure.runIds])];
        const dependentAssistantEventIds = new Set(initialClosure.assistantEventIds);
        if (runIds.length) {
          const rows = this.connection.prepare(`
            SELECT assistant_event_id AS id FROM runs
            WHERE id IN (${runIds.map(() => "?").join(",")}) AND assistant_event_id IS NOT NULL
          `).all(...runIds) as Array<{ id: string }>;
          for (const row of rows) dependentAssistantEventIds.add(row.id);
        }

        const affectedTopics = new Set(initialClosure.topicIds);
        const nestedOperationIds: string[] = [];
        const nestedCounts: Record<string, number> = {};
        for (const assistantEventId of initialClosure.assistantEventIds) {
          if (directEventIds.has(assistantEventId) || !this.getEvent(assistantEventId)) continue;
          const nested = this.hardDeleteEvent(assistantEventId);
          nestedOperationIds.push(nested.operationId, ...nested.nestedOperationIds);
          for (const nestedTopicId of nested.affectedTopicIds) affectedTopics.add(nestedTopicId);
          for (const [key, value] of Object.entries(nested.counts)) nestedCounts[key] = (nestedCounts[key] ?? 0) + value;
        }

        // Recompute after nested cascades so this operation owns only the
        // original event and its direct response/revision rows.
        const directClosure = this.#collectEvidenceDeletionClosure(eventIds);
        const affectedClaimIds = directClosure.claimIds;
        const directAffectedTopics = new Set(directClosure.topicIds);
        const affectedRevisions = new Set(directClosure.revisionRows.map((row) => row.id));
        for (const directTopicId of directAffectedTopics) affectedTopics.add(directTopicId);
        const provenanceLinks = this.connection.prepare(`DELETE FROM claim_sources WHERE source_id IN (${eventMarks})`).run(...eventIds).changes;
        const unsupportedClaims = (this.connection.prepare(`
          SELECT c.id FROM claims c LEFT JOIN claim_sources cs ON cs.claim_id = c.id
          WHERE c.id IN (${affectedClaimIds.length ? affectedClaimIds.map(() => "?").join(",") : "NULL"})
          GROUP BY c.id HAVING COUNT(cs.source_id) = 0
        `).all(...affectedClaimIds) as Array<{ id: string }>).map((row) => row.id);
        const claimRelationsRemoved = unsupportedClaims.length ? Number((this.connection.prepare(`
          SELECT COUNT(*) AS count FROM claim_relations
          WHERE source_claim_id IN (${unsupportedClaims.map(() => "?").join(",")})
             OR target_claim_id IN (${unsupportedClaims.map(() => "?").join(",")})
        `).get(...unsupportedClaims, ...unsupportedClaims) as { count: number }).count) : 0;
        const proposalCleanup = this.#purgeTopicProposalsReferencing([
          ...eventIds,
          ...unsupportedClaims,
          ...affectedRevisions
        ]);
        for (const proposalTopicId of proposalCleanup.affectedTopicIds) {
          affectedTopics.add(proposalTopicId);
          directAffectedTopics.add(proposalTopicId);
        }
        for (const revisionId of proposalCleanup.removedRevisionIds) affectedRevisions.add(revisionId);
        this.#addCompiledParentTopics(directAffectedTopics);
        for (const parentTopicId of directAffectedTopics) affectedTopics.add(parentTopicId);
        if (unsupportedClaims.length) {
          const marks = unsupportedClaims.map(() => "?").join(",");
          this.connection.prepare(`DELETE FROM vectors WHERE source_id IN (${marks})`).run(...unsupportedClaims);
          this.connection.prepare(`DELETE FROM memory_pins WHERE object_id IN (${marks})`).run(...unsupportedClaims);
          this.connection.prepare(`DELETE FROM claims WHERE id IN (${marks})`).run(...unsupportedClaims);
        }

        if (affectedRevisions.size) {
          const ids = [...affectedRevisions];
          const marks = ids.map(() => "?").join(",");
          this.connection.prepare(`DELETE FROM vectors WHERE source_id IN (${marks})`).run(...ids);
          this.connection.prepare(`DELETE FROM topic_page_revisions WHERE id IN (${marks})`).run(...ids);
        }
        const removedTopicIds = new Set(proposalCleanup.removedTopicIds);
        for (const topicId of directAffectedTopics) {
          if (this.#repairTopicAfterEvidenceDeletion(topicId, timestamp).removed) removedTopicIds.add(topicId);
        }

        this.connection.prepare(`DELETE FROM memory_pins WHERE object_id IN (${eventMarks})`).run(...eventIds);
        this.connection.prepare(`DELETE FROM vectors WHERE source_id IN (${eventMarks})`).run(...eventIds);
        const removedObjectIds = [...eventIds, ...unsupportedClaims, ...affectedRevisions, ...removedTopicIds];
        const removedObjectMarks = removedObjectIds.map(() => "?").join(",");
        const directEdgesRemoved = this.connection.prepare(`DELETE FROM edges WHERE source_id IN (${removedObjectMarks}) OR target_id IN (${removedObjectMarks})`).run(...removedObjectIds, ...removedObjectIds).changes;
        const edgeEvidence = this.#scrubEvidenceReferences("edges", removedObjectIds);
        const pageLinkEvidence = this.#scrubEvidenceReferences("page_links", removedObjectIds);
        const shadowCounts = this.#scrubIdentifierShadows(removedObjectIds);
        const remainingRunIds = runIds.filter((runId) => this.getRun(runId) !== null);
        this.#deleteRunDerivatives(remainingRunIds, timestamp, "event_delete");
        this.connection.prepare(`DELETE FROM events WHERE id IN (${eventMarks})`).run(...eventIds);

        const nestedCount = (key: string) => nestedCounts[key] ?? 0;
        const counts = {
          events: eventIds.length + nestedCount("events"),
          dependentRuns: runIds.length,
          dependentResponses: dependentAssistantEventIds.size,
          provenanceLinks: provenanceLinks + nestedCount("provenanceLinks"),
          claimsRemoved: unsupportedClaims.length + nestedCount("claimsRemoved"),
          relationsRemoved: claimRelationsRemoved + nestedCount("relationsRemoved"),
          edgesRemoved: directEdgesRemoved + edgeEvidence.rowsRemoved + nestedCount("edgesRemoved"),
          edgeEvidenceLinksRemoved: edgeEvidence.referencesRemoved + nestedCount("edgeEvidenceLinksRemoved"),
          pageLinksRemoved: pageLinkEvidence.rowsRemoved + nestedCount("pageLinksRemoved"),
          pageLinkEvidenceLinksRemoved: pageLinkEvidence.referencesRemoved + nestedCount("pageLinkEvidenceLinksRemoved"),
          topicRevisionsRemoved: affectedRevisions.size + nestedCount("topicRevisionsRemoved"),
          topicsRebuilt: affectedTopics.size,
          jobsRemoved: shadowCounts.jobsRemoved + nestedCount("jobsRemoved"),
          retrievalTracesRemoved: shadowCounts.retrievalTracesRemoved + nestedCount("retrievalTracesRemoved"),
          contextPacketsRemoved: shadowCounts.contextPacketsRemoved + nestedCount("contextPacketsRemoved"),
          toolExecutionsRemoved: shadowCounts.toolExecutionsRemoved + nestedCount("toolExecutionsRemoved"),
          contextRefsRemoved: shadowCounts.contextRefsRemoved + nestedCount("contextRefsRemoved"),
          idempotencyRecordsRemoved: shadowCounts.idempotencyRecordsRemoved + nestedCount("idempotencyRecordsRemoved"),
          mergeHistoryRemoved: shadowCounts.mergeHistoryRemoved + nestedCount("mergeHistoryRemoved"),
          entityAliasesRemoved: shadowCounts.entityAliasesRemoved + nestedCount("entityAliasesRemoved"),
          proposalsRemoved: proposalCleanup.proposalsRemoved + nestedCount("proposalsRemoved"),
          proposalRevisionsRemoved: proposalCleanup.proposalRevisionsRemoved + nestedCount("proposalRevisionsRemoved"),
          proposalTopicsRemoved: proposalCleanup.proposalTopicsRemoved + nestedCount("proposalTopicsRemoved")
        };
        const receiptId = uuidv7();
        this.connection.prepare(`
          INSERT INTO deletion_receipts(id, request_hash, object_type, object_hash, counts_json, deleted_at)
          VALUES (?, ?, 'event', ?, ?, ?)
        `).run(receiptId, stableHash(`event:${eventId}`), stableHash(eventId), JSON.stringify(counts), timestamp);
        const response = { receiptId, operationId, counts, affectedTopicIds: [...affectedTopics] };
        this.connection.prepare("UPDATE deletion_operations SET phase = 'database_complete', payload_json = ?, updated_at = ? WHERE id = ?").run(
          JSON.stringify({
            affectedTopicIds: [...affectedTopics],
            nestedOperationIds: [...new Set(nestedOperationIds)],
            ...(apiRecovery ? { apiRecovery: { ...apiRecovery, response } } : {})
          }), timestamp, operationId
        );
        return { ...response, nestedOperationIds: [...new Set(nestedOperationIds)] };
      })();
    } catch (error) {
      this.connection.prepare("UPDATE deletion_operations SET phase = 'failed', last_error_code = ?, updated_at = ? WHERE id = ?").run(
        error instanceof Error ? error.name : "DELETE_FAILED", now(), operationId
      );
      throw error;
    }
  }

  completeDeletionOperation(id: string): void {
    this.connection.prepare("UPDATE deletion_operations SET phase = 'complete', payload_json = '{}', updated_at = ? WHERE id = ?").run(now(), id);
  }

  listIncompleteDeletionOperations(): Array<Record<string, unknown>> {
    return this.connection.prepare("SELECT * FROM deletion_operations WHERE phase <> 'complete' ORDER BY created_at").all() as Array<Record<string, unknown>>;
  }

  checkpoint(): void {
    this.connection.pragma("wal_checkpoint(TRUNCATE)");
  }

  vacuum(): void {
    this.connection.exec("VACUUM");
  }

  securePurge(): void {
    this.connection.pragma("wal_checkpoint(TRUNCATE)");
    this.connection.exec("VACUUM");
    this.connection.pragma("wal_checkpoint(TRUNCATE)");
  }
}

export { uuidv7 };
