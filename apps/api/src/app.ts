import { createHash, timingSafeEqual } from "node:crypto";
import { createWriteStream, type Dirent } from "node:fs";
import { access, chmod, mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import fastify, { LogController, type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  DEFAULT_SYSTEM_PROMPT,
  isKnownEmbeddingModel,
  isKnownResponseModel,
  loadConfig,
  stableHash,
  type AppConfig
} from "@continuum/config";
import { AttachmentSchema, CreateMessageRequestSchema, IdSchema, QualityPresetSchema, type Attachment, type Claim } from "@continuum/contracts";
import {
  ApiErrorSchema,
  AuthorizeWorkspaceRequestSchema,
  CorrectClaimRequestSchema,
  CreateMemoryPinRequestSchema,
  CreateTopicRequestSchema,
  DeletionImpactRequestSchema,
  DeleteResourceRequestSchema,
  DeleteVaultRequestSchema,
  EmptyMutationRequestSchema,
  EntityMergeImpactRequestSchema,
  EntityMergeCandidatesQuerySchema,
  EntityMergeRequestSchema,
  EventsListQuerySchema,
  ExportFilenameParamsSchema,
  ExportVaultRequestSchema,
  GraphQuerySchema,
  IdParamsSchema,
  IdempotencyKeySchema,
  ImportVerifiedVaultRequestSchema,
  MutationRecoveryQuerySchema,
  PaginationQuerySchema,
  RegenerateEventRequestSchema,
  ResolveTopicProposalRequestSchema,
  RunFilterListQuerySchema,
  RunsListQuerySchema,
  SearchQuerySchema,
  SecretApprovalRequestSchema,
  SetProviderKeyRequestSchema,
  SettingMutationRequestSchema,
  SourceDetailQuerySchema,
  StartMemoryLintRequestSchema,
  TopicDetailQuerySchema,
  TopicIdentityParamsSchema,
  TopicProposalIdParamsSchema,
  TopicProposalRecordSchema,
  TopicProposalSchema,
  UpdateTopicRequestSchema,
  type TopicProposalRecord,
  type TopicShardProposal,
  publicApiContractFor
} from "@continuum/contracts/api";
import { ContinuumDatabase, uuidv7, type DeletionApiRecovery } from "@continuum/database";
import {
  ALLOWED_MEDIA_TYPES,
  FileSystemContentAddressedStore,
  MAX_ATTACHMENT_BYTES,
  macNativeIngestionStatus,
  mediaTypeForFilename,
  normalizeMediaType,
  validateAttachmentPolicy
} from "@continuum/ingestion";
import { LocalLogger } from "@continuum/observability";
import { ProviderFactory } from "@continuum/providers";
import { AppError, installErrorHandler } from "./errors.js";
import { reconstructStoredContextPacket } from "./context-packets.js";
import {
  MAX_VAULT_BUNDLE_BYTES,
  VaultBundleValidationError,
  VaultExportStorageError,
  VaultImportStorageError,
  VaultMaintenance,
  VaultVerificationTokenError,
  isRetryableVaultImportIoError,
  isVaultImportCapacityError,
  vaultImportIoErrorCode
} from "./maintenance.js";
import { ResponseOrchestrator, RunEventHub } from "./orchestrator.js";
import { MutationAdmissionDrainError, MutationAdmissionGate } from "./mutation-admission.js";
import { installSecurityHooks, SESSION_COOKIE } from "./security.js";
import { normalizeWorkspaceGrantPath, OneUseWorkspaceSecretGrants } from "./tool-runtime.js";
import { isLikelySecretPath } from "@continuum/tools";

const IdempotencySchema = IdempotencyKeySchema;
const PaginationSchema = PaginationQuerySchema;
const ModelIdSchema = z.string().trim().min(1).max(200).regex(/^[\w./:-]+$/, "Model IDs may only contain letters, numbers, and . / : _ - characters.");
const ResponseModelIdSchema = ModelIdSchema.refine(isKnownResponseModel, "That response model has no approved hard-budget pricing.");
const EmbeddingModelIdSchema = ModelIdSchema.refine(isKnownEmbeddingModel, "That embedding model has no approved hard-budget pricing.");
const ResponseModelsSchema = z.object({
  fast: ResponseModelIdSchema,
  balanced: ResponseModelIdSchema,
  deep: ResponseModelIdSchema
}).strict();
const SettingMutationSchema = SettingMutationRequestSchema;
const VaultDestroyMarkerSchema = z.object({
  format: z.literal("continuum-vault-destroy-v1"),
  idempotencyKey: IdempotencyKeySchema,
  startedAt: z.string().datetime()
}).strict();

function rows<T extends Record<string, unknown>>(database: ContinuumDatabase, sql: string, ...parameters: unknown[]): T[] {
  return database.connection.prepare(sql).all(...parameters) as T[];
}

function deletionApiRecovery(payload: Record<string, unknown>): (DeletionApiRecovery & { response?: Record<string, unknown> }) | null {
  const value = payload.apiRecovery;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.idempotencyKey !== "string" || typeof record.operation !== "string") return null;
  const response = record.response;
  return {
    idempotencyKey: record.idempotencyKey,
    operation: record.operation,
    ...(response && typeof response === "object" && !Array.isArray(response) ? { response: response as Record<string, unknown> } : {})
  };
}

function runProjection(run: Record<string, unknown>): Record<string, unknown> {
  return {
    id: run.id,
    status: run.status,
    quality: run.quality,
    userEventId: run.user_event_id ?? null,
    assistantEventId: run.assistant_event_id ?? null,
    errorCode: run.error_code ?? null,
    createdAt: run.created_at,
    completedAt: run.completed_at ?? null,
    cancellationRequested: Boolean(run.cancellation_requested)
  };
}

function parseQuery<Schema extends z.ZodTypeAny>(schema: Schema, query: unknown): z.output<Schema> { return schema.parse(query) as z.output<Schema>; }
function parseBody<Schema extends z.ZodTypeAny>(schema: Schema, body: unknown): z.output<Schema> { return schema.parse(body) as z.output<Schema>; }

function offsetPage<T>(fetched: T[], limit: number, offset = 0): { items: T[]; nextCursor: string | null } {
  const hasMore = fetched.length > limit;
  return { items: fetched.slice(0, limit), nextCursor: hasMore ? String(offset + limit) : null };
}

type MaterializedShardSection = "overview" | "current_state" | "history" | "evidence";
type MaterializedShardRow = {
  child_topic_id: string;
  section_key: MaterializedShardSection;
  ordinal: number;
  min_sort_key: string;
  max_sort_key: string;
};

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function currentShardRouteTarget(
  database: ContinuumDatabase,
  parentTopicId: string,
  section: Exclude<MaterializedShardSection, "overview">,
  sortKey: string
): string | null {
  const containing = database.connection.prepare(`
    SELECT shard.child_topic_id FROM topic_section_shards shard
    JOIN topic_pages page ON page.id = shard.child_topic_id AND page.lifecycle_status = 'active'
    WHERE shard.parent_topic_id = ? AND shard.section_key = ? AND shard.max_sort_key >= ?
    ORDER BY shard.max_sort_key ASC, shard.ordinal ASC LIMIT 1
  `).get(parentTopicId, section, sortKey) as { child_topic_id: string } | undefined;
  if (containing) return containing.child_topic_id;
  const tail = database.connection.prepare(`
    SELECT shard.child_topic_id FROM topic_section_shards shard
    JOIN topic_pages page ON page.id = shard.child_topic_id AND page.lifecycle_status = 'active'
    WHERE shard.parent_topic_id = ? AND shard.section_key = ?
    ORDER BY shard.max_sort_key DESC, shard.ordinal DESC LIMIT 1
  `).get(parentTopicId, section) as { child_topic_id: string } | undefined;
  return tail?.child_topic_id ?? null;
}

function proposalClaimSortKey(claim: Claim, section: Exclude<MaterializedShardSection, "overview">): string {
  const timestamp = section === "history" ? claim.validTo ?? claim.observedAt : claim.observedAt;
  return `${timestamp}\u0000${claim.id}`;
}

function refreshTopicSearch(database: ContinuumDatabase, topicId: string, revisionId?: string): void {
  database.connection.prepare("DELETE FROM topic_fts WHERE topic_id = ?").run(topicId);
  database.connection.prepare(`
    INSERT INTO topic_fts(topic_id, title, content)
    SELECT page.id, page.title, revision.markdown FROM topic_pages page
    JOIN topic_page_revisions revision
      ON revision.topic_id = page.id AND revision.revision_number = page.active_revision
    WHERE page.id = ? AND page.lifecycle_status = 'active'
  `).run(topicId);
  if (!revisionId) return;
  database.connection.prepare("DELETE FROM topic_revision_fts WHERE revision_id = ?").run(revisionId);
  database.connection.prepare(`
    INSERT INTO topic_revision_fts(revision_id, topic_id, title, content)
    SELECT revision.id, revision.topic_id, page.title, revision.markdown
    FROM topic_page_revisions revision JOIN topic_pages page ON page.id = revision.topic_id
    WHERE revision.id = ?
  `).run(revisionId);
}

function exactRevisionEvidence(database: ContinuumDatabase, revisionId: string): {
  claimIds: string[];
  sourceIds: string[];
  evidenceIds: string[];
} {
  const values = rows<{ claim_id: string | null; source_id: string }>(database, `
    SELECT claim_id, source_id FROM page_section_sources
    WHERE revision_id = ? ORDER BY claim_id, source_id
  `, revisionId);
  const claimIds = [...new Set(values.flatMap((value) => value.claim_id ? [value.claim_id] : []))].sort();
  const sourceIds = [...new Set(values.map((value) => value.source_id))].sort();
  return { claimIds, sourceIds, evidenceIds: [...new Set([...claimIds, ...sourceIds])].sort() };
}

function exactLink(
  database: ContinuumDatabase,
  sourceTopicId: string,
  targetTopicId: string,
  relationType: string,
  evidenceIds: readonly string[],
  timestamp: string
): void {
  if (sourceTopicId === targetTopicId) return;
  database.connection.prepare(`
    INSERT INTO page_links(id, source_topic_id, target_topic_id, relation_type, evidence_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_topic_id, target_topic_id, relation_type)
    DO UPDATE SET evidence_json = excluded.evidence_json
  `).run(uuidv7(), sourceTopicId, targetTopicId, relationType, JSON.stringify([...new Set(evidenceIds)].sort()), timestamp);
}

function boundedClaimLine(claim: Claim): string {
  const bounded = (value: string, maximum: number) => value.length <= maximum ? value : `${value.slice(0, maximum - 20)} … [truncated]`;
  return `- **${bounded(claim.subject, 240)} ${bounded(claim.predicate, 160)}:** ${bounded(claim.value, 4_000)}`;
}

function activeClaimSources(database: ContinuumDatabase, claimId: string): string[] {
  return rows<{ source_id: string }>(database, `
    SELECT source.source_id FROM claim_sources source
    LEFT JOIN events event ON event.id = source.source_id
    WHERE source.claim_id = ? AND (event.id IS NULL OR event.active = 1)
    ORDER BY source.source_id
  `, claimId).map((row) => row.source_id);
}

function nextTopicRevision(database: ContinuumDatabase, topicId: string): number {
  return Number((database.connection.prepare(`
    SELECT COALESCE(MAX(revision_number), 0) + 1 AS revision
    FROM topic_page_revisions WHERE topic_id = ?
  `).get(topicId) as { revision: number }).revision);
}

function insertResolverRevision(input: {
  database: ContinuumDatabase;
  topicId: string;
  revision: number;
  markdown: string;
  summary: string;
  currentState: string;
  history: string;
  openQuestions: string[];
  generationInputs: Record<string, unknown>;
  promptVersion: string;
  timestamp: string;
  provenance?: Array<{ section: string; start: number; end: number; claimId: string; sourceId: string }>;
}): string {
  const revisionId = uuidv7();
  input.database.connection.prepare(`
    INSERT INTO topic_page_revisions(
      id, topic_id, revision_number, markdown, summary, current_state, history,
      open_questions_json, generation_inputs_json, author_type, prompt_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'model', ?, ?)
  `).run(
    revisionId,
    input.topicId,
    input.revision,
    input.markdown,
    input.summary,
    input.currentState,
    input.history,
    JSON.stringify(input.openQuestions),
    JSON.stringify(input.generationInputs),
    input.promptVersion,
    input.timestamp
  );
  const insert = input.database.connection.prepare(`
    INSERT INTO page_section_sources(
      id, revision_id, section_key, start_offset, end_offset, claim_id, source_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of input.provenance ?? []) {
    insert.run(uuidv7(), revisionId, row.section, row.start, row.end, row.claimId, row.sourceId);
  }
  return revisionId;
}

function recomputeProtectedOverviewAndParent(
  database: ContinuumDatabase,
  parentTopicId: string,
  timestamp: string
): { overviewTopicId: string; parentTopicId: string; overviewEvidenceIds: string[] } {
  const parent = database.getTopic(parentTopicId);
  if (!parent) throw new AppError("MEMORY_PROPOSAL_STALE", "The protected parent page disappeared.", 409, true);
  const claimIds = rows<{ id: string }>(database, `
    SELECT id FROM claims
    WHERE topic_id = ? AND status IN ('current','conflicted')
      AND (freshness_expires_at IS NULL OR freshness_expires_at > ?)
      AND EXISTS (
        SELECT 1 FROM claim_sources source LEFT JOIN events event ON event.id = source.source_id
        WHERE source.claim_id = claims.id AND (event.id IS NULL OR event.active = 1)
      )
    ORDER BY observed_at DESC, id ASC LIMIT 3
  `, parentTopicId, timestamp).map((row) => row.id).reverse();
  const claims = claimIds.flatMap((claimId) => {
    const claim = database.getClaim(claimId, false);
    return claim ? [claim] : [];
  });
  const overviewRow = database.connection.prepare(`
    SELECT shard.child_topic_id, shard.ordinal FROM topic_section_shards shard
    JOIN topic_pages page ON page.id = shard.child_topic_id AND page.lifecycle_status = 'active'
    WHERE shard.parent_topic_id = ? AND shard.section_key = 'overview'
    ORDER BY shard.ordinal LIMIT 1
  `).get(parentTopicId) as { child_topic_id: string; ordinal: number } | undefined;
  const overviewTopicId = overviewRow?.child_topic_id ?? uuidv7();
  const overviewOrdinal = overviewRow?.ordinal ?? 1;
  const overviewTitle = `${parent.title.slice(0, 160)} — Overview ${overviewOrdinal}`;
  const overviewSlug = overviewRow
    ? String((database.connection.prepare("SELECT slug FROM topic_pages WHERE id = ?").get(overviewTopicId) as { slug: string }).slug)
    : `${parent.id}-overview-part-${overviewOrdinal}`;
  if (!overviewRow) {
    database.connection.prepare(`
      INSERT INTO topic_pages(
        id, core_type, slug, title, active_revision, scope_id, tags_json,
        lifecycle_status, created_at, updated_at, update_policy
      ) VALUES (?, ?, ?, ?, 1, 'global', ?, 'active', ?, ?, 'automatic')
    `).run(overviewTopicId, parent.type, overviewSlug, overviewTitle, JSON.stringify(["auto-split", `parent:${parent.id}`]), timestamp, timestamp);
  }
  const claimLines = claims.map(boundedClaimLine);
  const currentState = claimLines.join("\n") || "No current facts are available.";
  const openQuestions = claims.some((claim) => claim.status === "conflicted") ? ["Which conflicting statement is current?"] : [];
  const parentLink = `- Parent: [${parent.title.replaceAll("[", "\\[").replaceAll("]", "\\]")}](continuum://topic/${encodeURIComponent(parent.id)})`;
  const markdown = [
    `# ${overviewTitle}`,
    "## Summary",
    currentState,
    "## Current state",
    currentState,
    "## History",
    "No historical facts are summarized in this overview.",
    "## Open questions",
    openQuestions.length ? openQuestions.map((question) => `- ${question}`).join("\n") : "No unresolved questions.",
    "## Related pages",
    parentLink
  ].join("\n\n");
  const provenance: Array<{ section: string; start: number; end: number; claimId: string; sourceId: string }> = [];
  for (const claim of claims) {
    const line = boundedClaimLine(claim);
    let offset = 0;
    while ((offset = markdown.indexOf(line, offset)) >= 0) {
      for (const sourceId of activeClaimSources(database, claim.id)) {
        provenance.push({ section: offset < markdown.indexOf("## Current state") ? "summary" : "current_state", start: offset, end: offset + line.length, claimId: claim.id, sourceId });
      }
      offset += line.length;
    }
  }
  const overviewRevision = nextTopicRevision(database, overviewTopicId);
  const overviewRevisionId = insertResolverRevision({
    database,
    topicId: overviewTopicId,
    revision: overviewRevision,
    markdown,
    summary: currentState,
    currentState,
    history: "",
    openQuestions,
    generationInputs: { parentTopicId, claimIds },
    promptVersion: "topic-shard-accept-overview-v1",
    timestamp,
    provenance
  });
  database.connection.prepare(`
    UPDATE topic_pages SET title = ?, slug = ?, active_revision = ?, lifecycle_status = 'active',
      tags_json = ?, updated_at = ? WHERE id = ?
  `).run(overviewTitle, overviewSlug, overviewRevision, JSON.stringify(["auto-split", `parent:${parent.id}`]), timestamp, overviewTopicId);
  const overviewKeys = claims.map((claim) => `${claim.observedAt}\u0000${claim.id}`).sort();
  database.connection.prepare(`
    INSERT INTO topic_section_shards(
      child_topic_id, parent_topic_id, section_key, ordinal, min_sort_key, max_sort_key
    ) VALUES (?, ?, 'overview', ?, ?, ?)
    ON CONFLICT(child_topic_id) DO UPDATE SET parent_topic_id = excluded.parent_topic_id,
      section_key = 'overview', ordinal = excluded.ordinal,
      min_sort_key = excluded.min_sort_key, max_sort_key = excluded.max_sort_key
  `).run(overviewTopicId, parentTopicId, overviewOrdinal, overviewKeys[0] ?? "", overviewKeys.at(-1) ?? "");
  refreshTopicSearch(database, overviewTopicId, overviewRevisionId);

  const visible = rows<{ child_topic_id: string; title: string; section_key: string; ordinal: number }>(database, `
    SELECT shard.child_topic_id, page.title, shard.section_key, shard.ordinal
    FROM topic_section_shards shard JOIN topic_pages page
      ON page.id = shard.child_topic_id AND page.lifecycle_status = 'active'
    WHERE shard.parent_topic_id = ?
    ORDER BY CASE shard.section_key WHEN 'overview' THEN 0 WHEN 'current_state' THEN 1 WHEN 'history' THEN 2 ELSE 3 END,
      shard.max_sort_key, shard.ordinal LIMIT 8
  `, parentTopicId);
  const count = Number((database.connection.prepare(`
    SELECT COUNT(*) AS count FROM topic_section_shards shard
    JOIN topic_pages page ON page.id = shard.child_topic_id AND page.lifecycle_status = 'active'
    WHERE shard.parent_topic_id = ?
  `).get(parentTopicId) as { count: number }).count);
  const related = visible.map((child) => `- [${child.title.replaceAll("[", "\\[").replaceAll("]", "\\]")}](continuum://topic/${encodeURIComponent(child.child_topic_id)})`);
  if (count > visible.length) related.push(`- Continue through Next links for ${count - visible.length} additional parts.`);
  const parentSummary = `This topic is organized into ${count} bounded, evidence-linked parts.`;
  const parentState = "Open the linked parts for current facts, history, and exact evidence.";
  const parentMarkdown = [
    `# ${parent.title}`,
    "## Summary",
    parentSummary,
    "## Current state",
    parentState,
    "## History",
    "See the linked history parts.",
    "## Open questions",
    "No unresolved questions.",
    "## Related pages",
    related.join("\n")
  ].join("\n\n");
  const parentRevision = nextTopicRevision(database, parentTopicId);
  const parentRevisionId = insertResolverRevision({
    database,
    topicId: parentTopicId,
    revision: parentRevision,
    markdown: parentMarkdown,
    summary: parentSummary,
    currentState: parentState,
    history: "",
    openQuestions: [],
    generationInputs: { shardCount: count, childTopicIds: visible.map((child) => child.child_topic_id) },
    promptVersion: "topic-shard-accept-parent-v1",
    timestamp
  });
  database.connection.prepare(`
    UPDATE topic_pages SET active_revision = ?, lifecycle_status = 'active', updated_at = ?
    WHERE id = ?
  `).run(parentRevision, timestamp, parentTopicId);
  database.connection.prepare(`
    INSERT INTO topic_projection_state(parent_topic_id, layout_version, mode, updated_at)
    VALUES (?, 1, 'sharded', ?)
    ON CONFLICT(parent_topic_id) DO UPDATE SET mode = 'sharded', updated_at = excluded.updated_at
  `).run(parentTopicId, timestamp);
  refreshTopicSearch(database, parentTopicId, parentRevisionId);
  return {
    overviewTopicId,
    parentTopicId,
    overviewEvidenceIds: [...new Set([...claimIds, ...claims.flatMap((claim) => claim.sourceIds)])].sort()
  };
}

function rebuildProtectedShardLinks(input: {
  database: ContinuumDatabase;
  parentTopicId: string;
  touchedTopicIds: readonly string[];
  archivedTopicIds: readonly string[];
  exactEvidenceByTopic: ReadonlyMap<string, readonly string[]>;
  timestamp: string;
}): string[] {
  const cleanupIds = [...new Set([...input.touchedTopicIds, ...input.archivedTopicIds])];
  for (const childTopicId of cleanupIds) {
    input.database.connection.prepare(`
      DELETE FROM page_links
      WHERE relation_type IN ('contains','part_of')
        AND ((source_topic_id = ? AND target_topic_id = ?)
          OR (source_topic_id = ? AND target_topic_id = ?))
    `).run(input.parentTopicId, childTopicId, childTopicId, input.parentTopicId);
  }
  for (const childTopicId of input.touchedTopicIds) {
    const evidenceIds = input.exactEvidenceByTopic.get(childTopicId) ?? [];
    exactLink(input.database, input.parentTopicId, childTopicId, "contains", evidenceIds, input.timestamp);
    exactLink(input.database, childTopicId, input.parentTopicId, "part_of", evidenceIds, input.timestamp);
  }
  const ordered = rows<{ child_topic_id: string }>(input.database, `
    SELECT shard.child_topic_id FROM topic_section_shards shard
    JOIN topic_pages page ON page.id = shard.child_topic_id AND page.lifecycle_status = 'active'
    WHERE shard.parent_topic_id = ?
    ORDER BY CASE shard.section_key WHEN 'overview' THEN 0 WHEN 'current_state' THEN 1 WHEN 'history' THEN 2 ELSE 3 END,
      shard.max_sort_key, shard.ordinal
  `, input.parentTopicId).map((row) => row.child_topic_id);
  const chainIds = [...new Set([...ordered, ...input.archivedTopicIds])];
  if (chainIds.length > 0) {
    const marks = chainIds.map(() => "?").join(",");
    input.database.connection.prepare(`
      DELETE FROM page_links WHERE relation_type IN ('next','previous')
        AND (source_topic_id IN (${marks}) OR target_topic_id IN (${marks}))
    `).run(...chainIds, ...chainIds);
  }
  for (let index = 0; index + 1 < ordered.length; index += 1) {
    const left = ordered[index]!;
    const right = ordered[index + 1]!;
    const evidence = rows<{ claim_id: string | null; source_id: string }>(input.database, `
      SELECT source.claim_id, source.source_id FROM topic_pages page
      JOIN topic_page_revisions revision
        ON revision.topic_id = page.id AND revision.revision_number = page.active_revision
      JOIN page_section_sources source ON source.revision_id = revision.id
      WHERE page.id IN (?, ?) AND page.lifecycle_status = 'active'
    `, left, right);
    const evidenceIds = [...new Set(evidence.flatMap((row) => [row.source_id, ...(row.claim_id ? [row.claim_id] : [])]))].sort();
    exactLink(input.database, left, right, "next", evidenceIds, input.timestamp);
    exactLink(input.database, right, left, "previous", evidenceIds, input.timestamp);
  }
  return ordered;
}

async function pathExists(path: string): Promise<boolean> {
  try { await access(path); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function unlinkIfExists(path: string): Promise<void> {
  try { await unlink(path); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
}

async function readdirNamesIfExists(path: string): Promise<string[]> {
  try { return await readdir(path); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function readdirEntriesIfExists(path: string): Promise<Dirent[]> {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    // Directory fsync is unsupported on a few otherwise usable filesystems.
    // Every other failure (including I/O, capacity, and permission failures)
    // means we cannot truthfully claim that the marker transition is durable.
    if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(code)) throw error;
  } finally {
    await directory.close();
  }
}

async function writeDurableJsonMarker(path: string, value: unknown): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(path, "wx", 0o600);
    created = true;
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await syncDirectory(dirname(path));
  } catch (error) {
    const errors = [error];
    if (handle) {
      try { await handle.close(); }
      catch (closeError) { errors.push(closeError); }
    }
    // A failed exclusive create means another process owns the marker. Never
    // unlink a recovery intent that this call did not create.
    if (created) {
      try { await unlinkIfExists(path); }
      catch (unlinkError) { errors.push(unlinkError); }
      // Without this fsync a successfully unlinked failed marker can resurrect
      // after crash and trigger an unintended whole-vault destruction.
      try { await syncDirectory(dirname(path)); }
      catch (syncError) { errors.push(syncError); }
    }
    if (errors.length > 1) throw new AggregateError(errors, "A vault-destruction marker failed and could not be durably removed.");
    throw error;
  }
}

async function removeDurableMarker(path: string): Promise<void> {
  await unlinkIfExists(path);
  await syncDirectory(dirname(path));
}

async function readVaultDestroyMarker(path: string): Promise<z.infer<typeof VaultDestroyMarkerSchema> | null> {
  try { return VaultDestroyMarkerSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function streamVaultBundleUpload(request: FastifyRequest, config: AppConfig): Promise<{ path: string; mode: "verify" | "replace" | "fresh" }> {
  const stagingDirectory = join(config.dataDir, "import-staging");
  const uploadPath = join(stagingDirectory, `upload-${uuidv7()}.zip`);
  let mode: "verify" | "replace" | "fresh" = "verify";
  let receivedFile = false;
  let bytes = 0;
  try {
    await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
    await chmod(stagingDirectory, 0o700);
    const parts = request.parts({ limits: { files: 1, fields: 2, parts: 3, fileSize: MAX_VAULT_BUNDLE_BYTES } });
    for await (const part of parts) {
      if (part.type === "field") {
        if (part.fieldname === "mode") {
          const value = String(part.value);
          mode = value === "replace" ? "replace" : value === "fresh" ? "fresh" : "verify";
        }
        continue;
      }
      if (receivedFile) throw new AppError("TOO_MANY_FILES", "Choose exactly one Continuum ZIP to import.", 400);
      receivedFile = true;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.byteLength;
          if (bytes > MAX_VAULT_BUNDLE_BYTES) { callback(new AppError("VAULT_BUNDLE_TOO_LARGE", "Vault bundles may be at most 6 GiB.", 413, false, { maximumBytes: MAX_VAULT_BUNDLE_BYTES })); return; }
          callback(null, chunk);
        }
      });
      await pipeline(part.file, counter, createWriteStream(uploadPath, { flags: "wx", mode: 0o600 }));
      if (part.file.truncated) throw new AppError("VAULT_BUNDLE_TOO_LARGE", "Vault bundles may be at most 6 GiB.", 413, false, { maximumBytes: MAX_VAULT_BUNDLE_BYTES });
    }
    if (!receivedFile || bytes === 0) throw new AppError("FILE_REQUIRED", "Choose a Continuum ZIP to import.");
    return { path: uploadPath, mode };
  } catch (error) {
    await unlinkIfExists(uploadPath);
    if (error instanceof AppError) throw error;
    if (isVaultImportCapacityError(error)) {
      throw new AppError("INSUFFICIENT_IMPORT_STORAGE", "There is not enough free disk space to receive this vault safely.", 507, true, { filesystemCode: vaultImportIoErrorCode(error) });
    }
    if (error instanceof Error && (error.name.includes("FileTooLarge") || error.message.toLowerCase().includes("file too large"))) {
      throw new AppError("VAULT_BUNDLE_TOO_LARGE", "Vault bundles may be at most 6 GiB.", 413, false, { maximumBytes: MAX_VAULT_BUNDLE_BYTES });
    }
    throw error;
  }
}

export interface AppServices {
  config: AppConfig;
  database: ContinuumDatabase;
  logger: LocalLogger;
  providers: ProviderFactory;
  orchestrator: ResponseOrchestrator;
  hub: RunEventHub;
  maintenance: VaultMaintenance;
  secretGrants: OneUseWorkspaceSecretGrants;
}

export async function buildApp(overrides: Partial<Pick<AppServices, "config" | "database">> = {}): Promise<{ app: FastifyInstance; services: AppServices }> {
  const config = overrides.config ?? loadConfig();
  await Promise.all([
    mkdir(config.dataDir, { recursive: true, mode: 0o700 }),
    mkdir(config.attachmentsDir, { recursive: true, mode: 0o700 }),
    mkdir(config.projectionsDir, { recursive: true, mode: 0o700 }),
    mkdir(config.backupsDir, { recursive: true, mode: 0o700 }),
    mkdir(config.exportsDir, { recursive: true, mode: 0o700 }),
    mkdir(config.logsDir, { recursive: true, mode: 0o700 })
  ]);
  // Topic markdown can be sensitive. A crash before atomic rename must not
  // leave anonymous staged content outside the topic lifecycle cleanup path.
  for (const entry of await readdirNamesIfExists(config.projectionsDir)) {
    if (entry.startsWith(".projection-") && entry.endsWith(".tmp")) {
      await unlinkIfExists(join(config.projectionsDir, entry));
    }
  }
  await syncDirectory(config.projectionsDir);
  const database = overrides.database ?? ContinuumDatabase.open(config);
  // Startup reconciliation owns the persistent lock until import/deletion
  // journals and managed files are consistent; no provider run resumes early.
  database.setSetting("maintenance.locked", true);
  const schemaVersion = String(database.health().schemaVersion);
  const registerPromptVersions = () => {
    for (const version of [
      { name: "response", semanticVersion: "response-v1", content: DEFAULT_SYSTEM_PROMPT },
      { name: "reranker", semanticVersion: "rerank-v1", content: "Grounded evidence reranking contract: direct support, current authority, exact quotation sources, relationship relevance." },
      { name: "query-classifier", semanticVersion: "query-classifier-v1", content: "Structured local-memory query classification contract." },
      { name: "memory-extraction", semanticVersion: "claims-v1", content: "Evidence-bounded temporal claim and entity extraction contract." },
      { name: "embedding", semanticVersion: "embedding-v1", content: "Content-hash-addressed embedding derivation contract." },
      { name: "topic-compiler", semanticVersion: "topic-page-v1", content: "Bounded evidence-linked topic-page compilation contract." },
      { name: "source-parser", semanticVersion: "parser-v1", content: "Native-first deterministic source parsing contract." },
      { name: "source-chunker", semanticVersion: "chunker-v1", content: "Stable location-aware bounded source chunking contract." }
    ]) database.registerPromptVersion({ ...version, schemaVersion });
  };
  registerPromptVersions();
  const logger = new LocalLogger(config.logsDir, database.getSetting("promptTracing.enabled", false));
  await logger.prune();
  const maintenance = new VaultMaintenance(database, config);
  await maintenance.pruneExports();
  const providers = new ProviderFactory(config);
  const hub = new RunEventHub();
  const secretGrants = new OneUseWorkspaceSecretGrants();
  const orchestrator = new ResponseOrchestrator(database, providers, config, logger, hub, secretGrants);
  const app = fastify({
    logger: config.env === "test" ? false : { level: "info", redact: ["req.headers.authorization", "req.headers.cookie", "req.body.apiKey", "req.body.content"] },
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 2_000_000,
    requestIdHeader: false,
    genReqId: () => crypto.randomUUID()
  });
  // A completed idempotency row protects retries after commit. This short-lived
  // lock also protects the earlier multipart interval, when a duplicate request
  // can arrive while the first request is still reading or persisting bytes.
  const inFlightAttachmentUploads = new Map<string, Promise<Attachment>>();
  const attachmentHashQueues = new Map<string, Promise<void>>();
  const withAttachmentHashUpload = async <T>(hash: string, operation: () => Promise<T>): Promise<T> => {
    const previous = attachmentHashQueues.get(hash) ?? Promise.resolve();
    let release!: () => void;
    const hold = new Promise<void>((resolveHold) => { release = resolveHold; });
    const queued = previous.catch(() => undefined).then(() => hold);
    attachmentHashQueues.set(hash, queued);
    await previous.catch(() => undefined);
    try { return await operation(); }
    finally {
      release();
      if (attachmentHashQueues.get(hash) === queued) attachmentHashQueues.delete(hash);
    }
  };
  const attachmentStore = new FileSystemContentAddressedStore(config.attachmentsDir);
  await attachmentStore.initialize();
  const nativeIngestion = macNativeIngestionStatus();
  const enqueueProjectionSync = (idempotencyKey: string, payload: Record<string, unknown>) => {
    const job = database.enqueueJob("projection.sync", idempotencyKey, payload, 9);
    database.connection.prepare(`
      UPDATE jobs SET maximum_attempts = MAX(maximum_attempts, 8) WHERE id = ?
    `).run(job.id);
    return job;
  };
  const enqueueTopicEmbedding = (topic: { id: string; revision: number; markdown: string }, priority = 3) => {
    const write = () => {
      const model = database.getSetting("models.embedding", config.models.embedding);
      const contentHash = stableHash(topic.markdown);
      // Retrieval must never retain a semantic vector for content that is no
      // longer active, even when the replacement later stops at the cost cap.
      const exact = database.connection.prepare(`
        SELECT 1 FROM vectors
        WHERE source_id = ? AND source_type = 'topic' AND model_id = ? AND content_hash = ?
        LIMIT 1
      `).get(topic.id, model, contentHash);
      database.connection.prepare(`
        DELETE FROM vectors WHERE source_id = ? AND source_type = 'topic'
          AND NOT (model_id = ? AND content_hash = ?)
      `).run(topic.id, model, contentHash);
      if (exact) return null;
      return database.enqueueJob(
        "embedding.index",
        stableHash(`embedding.index:topic:${topic.id}:${topic.revision}:${contentHash}:${model}`),
        { sourceId: topic.id, sourceType: "topic", model, contentHash },
        priority
      );
    };
    return database.connection.inTransaction ? write() : database.connection.transaction(write).immediate();
  };
  const enqueueEventEmbedding = (event: { id: string; content: string }, priority = 2) => {
    const write = () => {
      const model = database.getSetting("models.embedding", config.models.embedding);
      const contentHash = stableHash(event.content);
      const exact = database.connection.prepare(`
        SELECT 1 FROM vectors
        WHERE source_id = ? AND source_type = 'event' AND model_id = ? AND content_hash = ?
        LIMIT 1
      `).get(event.id, model, contentHash);
      database.connection.prepare(`
        DELETE FROM vectors WHERE source_id = ? AND source_type = 'event'
          AND NOT (model_id = ? AND content_hash = ?)
      `).run(event.id, model, contentHash);
      if (exact) return null;
      return database.enqueueJob(
        "embedding.index",
        stableHash(`embedding.index:event:${event.id}:${contentHash}:${model}`),
        { sourceId: event.id, sourceType: "event", model, contentHash },
        priority
      );
    };
    return database.connection.inTransaction ? write() : database.connection.transaction(write).immediate();
  };
  const projectionSyncs = new Map<string, Promise<void>>();
  const projectionEntry = (topicId: string, slug: string): string => {
    if (!IdSchema.safeParse(topicId).success || slug.length > 200 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      throw new AppError("PROJECTION_PATH_UNSAFE", "A topic has an invalid projection identifier.", 500, false);
    }
    return `${topicId}-${slug}.md`;
  };
  const discardProjectionTemporary = async (temporary: string, primaryError?: unknown): Promise<void> => {
    const errors: unknown[] = primaryError === undefined ? [] : [primaryError];
    try { await unlinkIfExists(temporary); }
    catch (error) { errors.push(error); }
    try { await syncDirectory(config.projectionsDir); }
    catch (error) { errors.push(error); }
    if (errors.length > (primaryError === undefined ? 0 : 1)) {
      throw new AggregateError(errors, "A topic projection failed and its temporary entry could not be durably cleaned up.");
    }
    if (primaryError !== undefined) throw primaryError;
  };
  const syncOneTopicProjection = async (topicId: string) => {
    if (!IdSchema.safeParse(topicId).success) {
      throw new AppError("PROJECTION_PATH_UNSAFE", "A topic has an invalid projection identifier.", 500, false);
    }
    for (;;) {
      const topic = database.getTopic(topicId);
      const page = database.connection.prepare(`
        SELECT lifecycle_status, active_revision, slug FROM topic_pages WHERE id = ?
      `).get(topicId) as { lifecycle_status: string; active_revision: number; slug: string } | undefined;
      if (!topic || !page || page.lifecycle_status !== "active") {
        for (const entry of await readdirNamesIfExists(config.projectionsDir)) {
          if ((entry.startsWith(`${topicId}-`) && entry.endsWith(".md"))
            || (entry.startsWith(`.projection-${topicId}-`) && entry.endsWith(".tmp"))) {
            await unlinkIfExists(join(config.projectionsDir, entry));
          }
        }
        await syncDirectory(config.projectionsDir);
        const afterCleanup = database.connection.prepare(`
          SELECT lifecycle_status FROM topic_pages WHERE id = ?
        `).get(topicId) as { lifecycle_status: string } | undefined;
        if (!afterCleanup || afterCleanup.lifecycle_status !== "active") return;
        continue;
      }
      const retainedEntry = projectionEntry(topic.id, topic.slug);
      const target = join(config.projectionsDir, retainedEntry);
      const temporary = join(config.projectionsDir, `.projection-${topicId}-${uuidv7()}.tmp`);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(temporary, "wx", 0o600);
        await handle.writeFile(topic.markdown);
        await handle.sync();
        await handle.close();
        handle = undefined;
      } catch (error) {
        const errors = [error];
        if (handle) {
          try { await handle.close(); }
          catch (closeError) { errors.push(closeError); }
        }
        try { await discardProjectionTemporary(temporary); }
        catch (cleanupError) { errors.push(cleanupError); }
        if (errors.length > 1) throw new AggregateError(errors, "A topic projection could not be staged or durably cleaned up.");
        throw error;
      }

      // Do not publish a snapshot that became stale while its bytes were being
      // written. The per-topic queue covers this process; this recheck covers
      // writers in other processes and direct database maintenance.
      const beforePublish = database.connection.prepare(`
        SELECT lifecycle_status, active_revision, slug FROM topic_pages WHERE id = ?
      `).get(topicId) as { lifecycle_status: string; active_revision: number; slug: string } | undefined;
      if (!beforePublish || beforePublish.lifecycle_status !== "active"
        || beforePublish.active_revision !== topic.activeRevision || beforePublish.slug !== topic.slug) {
        await discardProjectionTemporary(temporary);
        continue;
      }
      try {
        await rename(temporary, target);
        await syncDirectory(config.projectionsDir);
      } catch (error) {
        await discardProjectionTemporary(temporary, error);
      }
      const afterPublish = database.connection.prepare(`
        SELECT lifecycle_status, active_revision, slug FROM topic_pages WHERE id = ?
      `).get(topicId) as { lifecycle_status: string; active_revision: number; slug: string } | undefined;
      if (afterPublish?.lifecycle_status !== "active"
        || afterPublish.active_revision !== topic.activeRevision || afterPublish.slug !== topic.slug) {
        continue;
      }

      for (const entry of await readdirNamesIfExists(config.projectionsDir)) {
        if (entry !== retainedEntry && entry.startsWith(`${topicId}-`) && entry.endsWith(".md")) {
          await unlinkIfExists(join(config.projectionsDir, entry));
        }
      }
      await syncDirectory(config.projectionsDir);
      const afterCleanup = database.connection.prepare(`
        SELECT lifecycle_status, active_revision, slug FROM topic_pages WHERE id = ?
      `).get(topicId) as { lifecycle_status: string; active_revision: number; slug: string } | undefined;
      if (afterCleanup?.lifecycle_status === "active"
        && afterCleanup.active_revision === topic.activeRevision && afterCleanup.slug === topic.slug) return;
      // A writer won the race during superseded-file cleanup. Re-publish the
      // newest committed snapshot before reporting success.
    }
  };
  const syncTopicProjections = async (topicIds: string[]) => {
    const uniqueIds = [...new Set(topicIds)];
    const queued = uniqueIds.map((topicId) => {
      const previous = projectionSyncs.get(topicId) ?? Promise.resolve();
      const current = previous.catch(() => undefined).then(() => syncOneTopicProjection(topicId));
      projectionSyncs.set(topicId, current);
      void current.finally(() => {
        if (projectionSyncs.get(topicId) === current) projectionSyncs.delete(topicId);
      }).catch(() => undefined);
      return current;
    });
    try {
      await Promise.all(queued);
    } catch (error) {
      const enqueueErrors: unknown[] = [];
      for (const topicId of uniqueIds) {
        const state = database.connection.prepare(`
          SELECT active_revision, lifecycle_status, updated_at FROM topic_pages WHERE id = ?
        `).get(topicId) as { active_revision: number; lifecycle_status: string; updated_at: string } | undefined;
        try {
          enqueueProjectionSync(
            stableHash(`projection.sync:repair:${topicId}:${state?.active_revision ?? "missing"}:${state?.lifecycle_status ?? "missing"}:${state?.updated_at ?? "missing"}`),
            { topicIds: [topicId], reason: "api_projection_repair" }
          );
        } catch (enqueueError) { enqueueErrors.push(enqueueError); }
      }
      if (enqueueErrors.length) throw new AggregateError([error, ...enqueueErrors], "Topic projection failed and its durable repair job could not be recorded.");
      throw error;
    }
  };
  const enqueueDeletionMemoryRebuild = (operationId: string, objectType: string, topicIds: string[]): void => {
    const uniqueTopicIds = [...new Set(topicIds)].sort();
    if (objectType === "topic" || uniqueTopicIds.length === 0) return;
    database.enqueueJob(
      "memory.rebuild",
      stableHash(`memory.rebuild:deletion:${operationId}`),
      { topicIds: uniqueTopicIds, reason: `user_${objectType}_deletion`, deletionOperationId: operationId },
      9
    );
  };
  const vaultDestroyMarkerPath = join(config.dataDir, "vault-destroy.pending.json");
  const clearVaultTables = ["memory_pins", "context_packets", "retrieval_traces", "model_calls", "budget_ledger", "budget_reservations", "job_attempts", "jobs", "tool_executions", "workspace_roots", "page_links", "page_section_sources", "topic_page_revisions", "topic_pages", "merge_history", "edges", "claim_relations", "claim_sources", "claims", "entity_aliases", "entities", "vectors", "event_attachments", "attachments", "source_chunks", "sources", "assistant_revisions", "context_refs", "event_content", "run_stream_events", "runs", "events", "idempotency_keys", "deletion_receipts", "deletion_operations", "import_operations", "prompt_versions", "provider_presets", "settings", "vaults", "backup_records"];
  const completeVaultDestroy = async (idempotencyKey: string): Promise<{ destroyed: boolean; keyRetainedInKeychain: boolean }> => {
    secretGrants.clear();
    logger.setPromptTracing(false);
    await logger.flush();
    database.reconcileOutstandingBudgetReservations("vault_reset");
    database.scrubInstallationBudgetMetadata();
    database.connection.transaction(() => {
      database.connection.pragma("defer_foreign_keys = ON");
      for (const table of clearVaultTables) database.connection.prepare(`DELETE FROM ${table}`).run();
      const timestamp = new Date().toISOString();
      database.connection.prepare("INSERT INTO vaults(id, scope_id, name, created_at, schema_version) VALUES (?, 'global', 'Personal vault', ?, ?)").run(uuidv7(), timestamp, database.health().schemaVersion);
      // The process-local gate is still exclusive. Keep the persistent worker
      // lock true until every managed byte, backup, and purge is complete.
      database.connection.prepare("INSERT INTO settings(key, value_json, updated_at) VALUES ('onboarding.complete', 'false', ?), ('theme', '\"system\"', ?), ('memory.enabled', 'true', ?), ('maintenance.locked', 'true', ?)").run(timestamp, timestamp, timestamp, timestamp);
    })();
    registerPromptVersions();
    const managedDirectories = [
      config.attachmentsDir,
      config.projectionsDir,
      config.backupsDir,
      config.exportsDir,
      config.logsDir,
      join(config.dataDir, "import-journal"),
      join(config.dataDir, "verified-imports"),
      join(config.dataDir, "import-staging"),
      join(config.dataDir, "backup-staging")
    ];
    for (const directory of managedDirectories) {
      for (const entry of await readdirEntriesIfExists(directory)) {
        await rm(join(directory, entry.name), { recursive: entry.isDirectory(), force: true });
      }
      // Persist removal of every top-level managed entry. Recursive rm alone
      // does not make the containing directory updates crash-durable.
      if (await pathExists(directory)) await syncDirectory(directory);
    }
    // Purge old free pages before the replacement backup snapshots SQLite.
    database.securePurge();
    await maintenance.scrubManagedBackupsAfterDeletion();
    database.securePurge();
    const response = { destroyed: true, keyRetainedInKeychain: true };
    database.rememberIdempotentResponse(idempotencyKey, "vault.destroy", response);
    return response;
  };

  const pendingVaultDestroy = await readVaultDestroyMarker(vaultDestroyMarkerPath);
  if (pendingVaultDestroy) {
    await completeVaultDestroy(pendingVaultDestroy.idempotencyKey);
    await removeDurableMarker(vaultDestroyMarkerPath);
    logger.warn("interrupted whole-vault destruction completed before startup unlock");
  }
  const recoveredImports = await maintenance.resumeIncompleteImports();
  if (recoveredImports.resumed || recoveredImports.abandoned) logger.warn("interrupted vault imports reconciled after restart", recoveredImports);
  const recoveredRuns = database.recoverInterruptedRuns();
  if (recoveredRuns.length) logger.warn("interrupted response runs reconciled after restart", { count: recoveredRuns.length });
  const processedDeletionOperations = new Set<string>();
  for (const pendingOperation of database.listIncompleteDeletionOperations()) {
    if (processedDeletionOperations.has(String(pendingOperation.id))) continue;
    let operation = database.connection.prepare("SELECT * FROM deletion_operations WHERE id = ?").get(pendingOperation.id) as Record<string, unknown> | undefined;
    if (!operation || operation.phase === "complete" || operation.phase === "failed") continue;
    if (operation.phase === "prepared") {
      const duplicate = database.connection.prepare(`
        SELECT * FROM deletion_operations
        WHERE id <> ? AND object_type = ? AND object_hash = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(operation.id, operation.object_type, operation.object_hash) as Record<string, unknown> | undefined;
      if (duplicate?.phase === "complete") {
        database.completeDeletionOperation(String(operation.id));
        continue;
      }
      if (duplicate?.phase === "database_complete") {
        database.completeDeletionOperation(String(operation.id));
        operation = duplicate;
      } else {
        let preparedPayload: Record<string, unknown> = {};
        try { preparedPayload = JSON.parse(String(operation.payload_json)) as Record<string, unknown>; } catch { throw new Error("A prepared deletion operation has invalid recovery data."); }
        const preparedRecovery = deletionApiRecovery(preparedPayload);
        const recoveryInput = preparedRecovery ? { idempotencyKey: preparedRecovery.idempotencyKey, operation: preparedRecovery.operation } : undefined;
        let resumedOperationId: string;
        if (operation.object_type === "event" && typeof preparedPayload.eventId === "string" && database.getEvent(preparedPayload.eventId)) {
          resumedOperationId = database.hardDeleteEvent(preparedPayload.eventId, recoveryInput).operationId;
        } else if (operation.object_type === "attachment" && typeof preparedPayload.attachmentId === "string" && database.getAttachment(preparedPayload.attachmentId)) {
          resumedOperationId = database.hardDeleteAttachment(preparedPayload.attachmentId, recoveryInput).operationId;
        } else if (operation.object_type === "claim" && typeof preparedPayload.claimId === "string" && database.connection.prepare("SELECT 1 FROM claims WHERE id = ?").get(preparedPayload.claimId)) {
          resumedOperationId = database.hardDeleteClaim(preparedPayload.claimId, recoveryInput).operationId;
        } else if (operation.object_type === "topic" && typeof preparedPayload.topicId === "string" && database.getTopic(preparedPayload.topicId)) {
          resumedOperationId = database.hardDeleteTopic(preparedPayload.topicId, recoveryInput).operationId;
        } else {
          throw new Error("A prepared deletion operation cannot be safely resumed.");
        }
        database.completeDeletionOperation(String(operation.id));
        operation = database.connection.prepare("SELECT * FROM deletion_operations WHERE id = ?").get(resumedOperationId) as Record<string, unknown>;
      }
    }
    if (operation.phase !== "database_complete") continue;
    processedDeletionOperations.add(String(operation.id));
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(String(operation.payload_json)) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      payload = parsed as Record<string, unknown>;
    } catch { throw new Error("A committed deletion operation has invalid recovery data."); }
    if (typeof payload.contentHash === "string" && Number(payload.sharedByteReferences ?? 0) === 0) await attachmentStore.delete(payload.contentHash);
    const affectedTopicIds = Array.isArray(payload.affectedTopicIds) ? payload.affectedTopicIds.map(String) : [];
    if (affectedTopicIds.length) await syncTopicProjections(affectedTopicIds);
    enqueueDeletionMemoryRebuild(String(operation.id), String(operation.object_type), affectedTopicIds);
    await maintenance.scrubManagedBackupsAfterDeletion();
    database.securePurge();
    if (Array.isArray(payload.nestedOperationIds)) {
      for (const nestedOperationId of payload.nestedOperationIds) database.completeDeletionOperation(String(nestedOperationId));
    }
    const apiRecovery = deletionApiRecovery(payload);
    if (apiRecovery) {
      if (!apiRecovery.response) throw new Error("A committed API deletion operation is missing its idempotent recovery response.");
      database.rememberIdempotentResponse(apiRecovery.idempotencyKey, apiRecovery.operation, apiRecovery.response);
    }
    database.completeDeletionOperation(String(operation.id));
  }
  // A crash can occur after a canonical blob is durably linked but before its
  // source/attachment transaction commits. Imports and deletion journals must
  // be reconciled first; while maintenance remains locked, remove only hashes
  // with no authoritative logical reference.
  for (const hash of await attachmentStore.listHashes()) {
    const referenced = database.connection.prepare(`
      SELECT 1 FROM attachments WHERE content_hash = ? LIMIT 1
    `).get(hash);
    if (!referenced) await attachmentStore.delete(hash);
  }
  database.setSetting("maintenance.locked", false);
  for (const pending of database.pendingRuns()) {
    const event = database.getEvent(pending.userEventId);
    if (event && (pending.quality === "fast" || pending.quality === "balanced" || pending.quality === "deep")) {
      orchestrator.start(pending.id, event, pending.quality);
    }
  }

  const mutationAdmission = new MutationAdmissionGate<FastifyRequest>();

  const beginMaintenance = async (request: FastifyRequest, options: { cancelRuns?: boolean } = {}): Promise<void> => {
    const deadline = Date.now() + 30_000;
    const requestAbort = new AbortController();
    const abortDrain = () => requestAbort.abort();
    request.raw.once("aborted", abortDrain);
    let exclusive: boolean;
    try {
      exclusive = await mutationAdmission.beginExclusive(request, { timeoutMs: Math.max(1, deadline - Date.now()), signal: requestAbort.signal });
    } catch (error) {
      if (error instanceof MutationAdmissionDrainError) throw new AppError("MAINTENANCE_BUSY", error.message, 409, true);
      throw error;
    } finally {
      request.raw.off("aborted", abortDrain);
    }
    if (!exclusive) throw new AppError("MAINTENANCE_BUSY", "Another local maintenance operation is already running.", 409, true);
    let ownsPersistentLock = false;
    try {
      if (database.getSetting("maintenance.locked", false)) {
        throw new AppError("MAINTENANCE_BUSY", "Another local maintenance operation is already running.", 409, true);
      }
      database.setSetting("maintenance.locked", true);
      ownsPersistentLock = true;
      if (options.cancelRuns ?? true) orchestrator.cancelAll();
      let backupsIdle = false;
      const backupBarrier = maintenance.waitForBackupIdle().then(() => { backupsIdle = true; });
      while (Date.now() < deadline) {
        const activeRuns = Number(rows<Record<string, unknown>>(database, "SELECT COUNT(*) AS count FROM runs WHERE status IN ('pending','retrieving','streaming')")[0]?.count ?? 0);
        const activeJobs = Number(rows<Record<string, unknown>>(database, "SELECT COUNT(*) AS count FROM jobs WHERE status = 'running'")[0]?.count ?? 0);
        if (activeRuns === 0 && activeJobs === 0 && backupsIdle) return;
        await Promise.race([backupBarrier, new Promise((resolveDelay) => setTimeout(resolveDelay, 100))]);
      }
      throw new AppError("MAINTENANCE_BUSY", "Continuum is still finishing active requests, runs, jobs, or backups. Try the operation again in a moment.", 409, true);
    } catch (error) {
      if (ownsPersistentLock) database.setSetting("maintenance.locked", false);
      mutationAdmission.endExclusive(request);
      throw error;
    }
  };
  const endMaintenance = (request: FastifyRequest): void => {
    database.setSetting("maintenance.locked", false);
    mutationAdmission.endExclusive(request);
  };
  let backupTimer: NodeJS.Timeout | undefined;
  let backupLaunch: NodeJS.Immediate | undefined;
  let backupCatchUpInFlight: Promise<void> | null = null;
  let backgroundClosing = false;
  let backupStatus: {
    status: "disabled" | "scheduled" | "running" | "idle" | "failed";
    lastStartedAt?: string;
    lastCompletedAt?: string;
    lastErrorType?: string;
  } = { status: config.env === "test" ? "disabled" : "scheduled" };
  if (config.env !== "test") {
    const runBackupCatchUp = (): Promise<void> => {
      if (backupCatchUpInFlight) return backupCatchUpInFlight;
      const { lastErrorType: _priorError, ...priorStatus } = backupStatus;
      void _priorError;
      backupStatus = { ...priorStatus, status: "running", lastStartedAt: new Date().toISOString() };
      const task = maintenance.pruneStaleBackupStaging()
        .then(() => maintenance.pruneVerifiedImports())
        .then(() => maintenance.pruneExports())
        .then(() => maintenance.createDueBackups()).then(() => {
        const { lastErrorType: _completedError, ...completedStatus } = backupStatus;
        void _completedError;
        backupStatus = { ...completedStatus, status: "idle", lastCompletedAt: new Date().toISOString() };
      }).catch((error: unknown) => {
        const errorType = error instanceof Error ? error.name : "UnknownError";
        backupStatus = { ...backupStatus, status: "failed", lastCompletedAt: new Date().toISOString(), lastErrorType: errorType };
        if (!backgroundClosing) logger.warn("scheduled backup check failed", { errorType });
      }).finally(() => {
        if (backupCatchUpInFlight === task) backupCatchUpInFlight = null;
      });
      backupCatchUpInFlight = task;
      return task;
    };
    app.addHook("onListen", async () => {
      // The socket is already accepting local requests when this hook runs.
      // Defer another event-loop turn so even a multi-gigabyte catch-up cannot
      // delay the listen promise or runtime-descriptor publication.
      backupLaunch = setImmediate(() => { backupLaunch = undefined; void runBackupCatchUp(); });
      backupLaunch.unref();
      backupTimer = setInterval(() => { void runBackupCatchUp(); }, 60 * 60 * 1_000);
      backupTimer.unref();
    });
  }
  const services: AppServices = { config, database, logger, providers, orchestrator, hub, maintenance, secretGrants };
  const uiSettings = () => ({
    theme: database.getSetting<"light" | "dark" | "system">("theme", "system"),
    quality: database.getSetting<"fast" | "balanced" | "deep">("quality.default", "balanced"),
    memoryPaused: !database.getSetting("memory.enabled", true),
    webSearchEnabled: database.getSetting("webSearch.enabled", true),
    onboardingComplete: database.getSetting("onboarding.complete", false),
    systemInstructions: database.getSetting("system.instructions", "Be clear, grounded, and use historical evidence when it is relevant."),
    showSourceChips: database.getSetting("ui.showSourceChips", true),
    developerOverrides: database.getSetting("developer.traceMode", false),
    promptTracingEnabled: database.getSetting("promptTracing.enabled", false),
    responseModelIds: database.getSetting("models.response", {
      fast: config.models.fast,
      balanced: config.models.balanced,
      deep: config.models.deep
    }),
    extractionModelId: database.getSetting("models.extraction", config.models.memory),
    embeddingModelId: database.getSetting("models.embedding", config.models.embedding)
  });

  const normalizeSetting = (key: z.infer<typeof SettingMutationSchema>["key"], value: unknown): { key: string; value: unknown } => {
    switch (key) {
      case "theme": return { key, value: z.enum(["light", "dark", "system"]).parse(value) };
      case "quality":
      case "quality.default": return { key: "quality.default", value: z.enum(["fast", "balanced", "deep"]).parse(value) };
      case "memoryPaused": return { key: "memory.enabled", value: !z.boolean().parse(value) };
      case "memory.enabled": return { key, value: z.boolean().parse(value) };
      case "webSearchEnabled":
      case "webSearch.enabled": return { key: "webSearch.enabled", value: z.boolean().parse(value) };
      case "onboardingComplete":
      case "onboarding.complete": return { key: "onboarding.complete", value: z.boolean().parse(value) };
      case "systemInstructions":
      case "system.instructions": return { key: "system.instructions", value: z.string().max(20_000).parse(value) };
      case "showSourceChips":
      case "ui.showSourceChips": return { key: "ui.showSourceChips", value: z.boolean().parse(value) };
      case "developerOverrides":
      case "developer.traceMode": return { key: "developer.traceMode", value: z.boolean().parse(value) };
      case "promptTracingEnabled":
      case "promptTracing.enabled": return { key: "promptTracing.enabled", value: z.boolean().parse(value) };
      case "responseModelIds":
      case "models.response": return { key: "models.response", value: ResponseModelsSchema.parse(value) };
      case "extractionModelId":
      case "models.extraction": return { key: "models.extraction", value: ResponseModelIdSchema.parse(value) };
      case "embeddingModelId":
      case "models.embedding": return { key: "models.embedding", value: EmbeddingModelIdSchema.parse(value) };
    }
  };
  await app.register(cookie);
  await app.register(cors, {
    origin(origin, callback) {
      if (!origin || config.allowedOrigins.has(origin)) callback(null, true);
      else callback(new Error("Origin rejected"), false);
    },
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "X-Continuum-Request", "Idempotency-Key", "Last-Event-ID"],
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
  });
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        imgSrc: ["'self'", "data:", "blob:"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'", ...config.allowedOrigins]
      }
    },
    crossOriginEmbedderPolicy: false
  });
  await app.register(rateLimit, { max: 240, timeWindow: "1 minute", ban: 3, keyGenerator: () => "local-user" });
  await app.register(multipart, {
    // Ordinary uploads stay tightly bounded. The vault-import route explicitly
    // overrides this with its dedicated streamed 6 GiB transport limit.
    limits: { files: 20, fileSize: 50 * 1024 * 1024, fields: 20, parts: 40 },
    throwFileSizeLimit: true
  });
  await installSecurityHooks(app, config);
  installErrorHandler(app);
  app.addHook("preSerialization", async (request, reply, payload) => {
    if (!request.url.startsWith("/api/v1")) return payload;
    if (reply.statusCode >= 400) return ApiErrorSchema.parse(payload);
    const routePath = request.routeOptions.url;
    if (!routePath) return payload;
    const contract = publicApiContractFor(request.method, routePath);
    if (!contract || contract.sse) return payload;
    const result = contract.response.safeParse(payload);
    if (!result.success) {
      logger.error("public API response violated its shared contract", {
        method: request.method,
        route: request.routeOptions.url,
        issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code }))
      });
      throw new AppError("CONTRACT_RESPONSE_INVALID", "Continuum produced an invalid local API response.", 500, true);
    }
    return result.data;
  });
  const isApiMutation = (request: FastifyRequest) => request.url.startsWith("/api/v1") && !["GET", "HEAD", "OPTIONS"].includes(request.method);
  app.addHook("preHandler", async (request, reply) => {
    if (!isApiMutation(request)) return;
    if (database.getSetting("maintenance.locked", false) || !mutationAdmission.admit(request)) {
      await reply.code(423).send({ error: { code: "MAINTENANCE_LOCKED", message: "Continuum is completing a local maintenance operation.", retryable: true, traceId: request.id } });
    }
  });
  app.addHook("onError", async (request) => { mutationAdmission.release(request); });
  app.addHook("onResponse", async (request) => { mutationAdmission.release(request); });
  app.addHook("onRequestAbort", async (request) => { mutationAdmission.release(request); });

  let bootstrapAvailable = true;
  app.get("/bootstrap", async (request, reply) => {
    const query = z.object({ token: z.string(), returnTo: z.string().optional() }).parse(request.query);
    const supplied = Buffer.from(query.token);
    const expected = Buffer.from(config.sessionToken);
    if (!bootstrapAvailable || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new AppError("INVALID_BOOTSTRAP", "This launch link has expired.", 401, true);
    bootstrapAvailable = false;
    // Keep authentication for the lifetime of this browser session. A fixed
    // two-hour expiry stranded an otherwise healthy long-running local session
    // because the one-use bootstrap link is deliberately consumed above.
    // Restarting the backend rotates the token, so an old session cookie still
    // cannot authenticate to a later process.
    reply.setCookie(SESSION_COOKIE, config.sessionToken, { path: "/", httpOnly: true, sameSite: "strict", secure: false });
    const returnTo = query.returnTo && config.allowedOrigins.has(query.returnTo) ? query.returnTo : config.apiOrigin;
    await reply.redirect(`${returnTo}/?connected=1`);
  });

  app.get("/api/v1/health", async () => ({
    status: database.health().integrity === "ok" ? "ok" : "degraded",
    database: database.health(),
    providerConfigured: await providers.hasOpenAiKey(),
    worker: { status: "independent", queuedJobs: database.listJobs(500).filter((job) => job.status === "queued").length },
    backup: backupStatus,
    export: maintenance.exportStatus(),
    ingestion: nativeIngestion,
    localOnly: true,
    version: "0.1.0"
  }));
  app.get("/api/v1/runtime", async () => {
    const health = database.health();
    const jobs = database.listJobs(500).filter((job) => job.type.startsWith("memory."));
    const latestMemory = rows<Record<string, unknown>>(database, "SELECT MAX(updated_at) AS value FROM topic_pages")[0]?.value;
    const paused = !database.getSetting("memory.enabled", true);
    const memoryQueue = paused ? "paused" : jobs.some((job) => job.status === "failed") ? "failed" : jobs.some((job) => job.status === "queued" || job.status === "running") ? "working" : "idle";
    const providerReachable = await providers.hasOpenAiKey();
    return {
      mode: health.integrity === "ok" ? "connected" : "degraded",
      apiReachable: true,
      providerReachable,
      vectorSearch: health.vectorAvailable ? "ready" : "fallback",
      memoryQueue,
      activePort: config.port,
      version: "0.1.0",
      ...(latestMemory ? { lastMemoryUpdate: String(latestMemory) } : {}),
      ...(!providerReachable && !config.mockProvider ? { message: "Add an OpenAI API key to send live messages." } : {}),
      apiVersion: "v1",
      vaultId: (rows(database, "SELECT id FROM vaults LIMIT 1")[0]?.id ?? null),
      storageDirectory: config.dataDir,
      mockProvider: config.mockProvider,
      vectorMode: health.vectorMode,
      vectorStrategy: health.vectorStrategy,
      vectorVersion: health.vectorVersion,
      vectorFallbackLimit: health.vectorFallbackLimit,
      vectorLoadStatus: health.vectorLoadStatus,
      ingestion: database.getSetting("runtime.ingestion", nativeIngestion),
      privacy: { storedLocally: true, providerStorageDisabled: true, analytics: false }
    };
  });

  app.get("/api/v1/settings", async () => ({ settings: uiSettings(), raw: database.listSettings() }));
  app.put("/api/v1/settings", async (request) => {
    const body = parseBody(SettingMutationSchema, request.body);
    const setting = normalizeSetting(body.key, body.value);
    const result = database.connection.transaction(() => {
      const prior = database.idempotentResponse<Record<string, unknown>>(body.idempotencyKey, "settings.put");
      if (prior) return { response: prior, changed: false };
      if (setting.key === "models.embedding") {
        const currentModel = database.getSetting("models.embedding", config.models.embedding);
        if (setting.value !== currentModel) {
          const corpus = database.connection.prepare(`
            SELECT
              (SELECT COUNT(*) FROM vectors) AS vectors,
              (SELECT COUNT(*) FROM events WHERE active = 1) AS events,
              (SELECT COUNT(*) FROM claims) AS claims,
              (SELECT COUNT(*) FROM topic_pages WHERE lifecycle_status = 'active') AS topics,
              (SELECT COUNT(*) FROM source_chunks) AS chunks,
              (SELECT COUNT(*) FROM jobs WHERE type = 'embedding.index' AND status IN ('queued','running')) AS jobs
          `).get() as Record<"vectors" | "events" | "claims" | "topics" | "chunks" | "jobs", number>;
          if (Object.values(corpus).some((count) => Number(count) > 0)) {
            throw new AppError(
              "EMBEDDING_MODEL_REINDEX_REQUIRED",
              "The embedding model can only change before the vault has embeddable content or embedding jobs. A later migration requires a cost preview and a resumable, validated corpus rebuild.",
              409,
              false,
              { currentModel, requestedModel: setting.value, corpus }
            );
          }
        }
      }
      database.setSetting(setting.key, setting.value);
      if (setting.key === "models.response") {
        const models = ResponseModelsSchema.parse(setting.value);
        const update = database.connection.prepare("UPDATE provider_presets SET model_id = ?, updated_at = ? WHERE name = ?");
        const timestamp = new Date().toISOString();
        for (const name of ["fast", "balanced", "deep"] as const) update.run(models[name], timestamp, name);
      }
      const response = { key: setting.key, value: setting.value, settings: uiSettings(), raw: database.listSettings() };
      database.rememberIdempotentResponse(body.idempotencyKey, "settings.put", response);
      return { response, changed: true };
    }).immediate();
    if (result.changed && setting.key === "promptTracing.enabled") logger.setPromptTracing(Boolean(setting.value));
    return result.response;
  });

  app.get("/api/v1/providers", async () => ({
    providers: [{ id: config.mockProvider ? "mock" : "openai", name: config.mockProvider ? "Local test provider" : "OpenAI", configured: await providers.hasOpenAiKey() }],
    presets: rows(database, "SELECT name, provider, model_id AS modelId, reasoning_effort AS reasoningEffort, active FROM provider_presets ORDER BY name"),
    keyStorage: "macOS Keychain"
  }));
  app.post("/api/v1/providers/openai-key", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request) => {
    const body = parseBody(SetProviderKeyRequestSchema, request.body);
    const prior = database.idempotentResponse<{ configured: boolean }>(body.idempotencyKey, "providers.openai-key.set");
    if (prior) return prior;
    const previous = await providers.keychain.getOpenAiApiKey();
    try {
      await providers.keychain.setOpenAiApiKey(body.apiKey);
      const provider = await providers.create();
      const valid = await provider.validateConnection();
      if (!valid) throw new Error("The OpenAI API key could not be validated.");
      const response = { configured: true };
      database.rememberIdempotentResponse(body.idempotencyKey, "providers.openai-key.set", response);
      return response;
    } catch (error) {
      if (previous) await providers.keychain.setOpenAiApiKey(previous);
      else await providers.keychain.deleteOpenAiApiKey().catch(() => undefined);
      throw error;
    }
  });
  app.delete("/api/v1/providers/openai-key", async (request) => {
    const body = parseBody(EmptyMutationRequestSchema, request.body);
    const prior = database.idempotentResponse<{ configured: boolean }>(body.idempotencyKey, "providers.openai-key.delete");
    if (prior) return prior;
    await providers.keychain.deleteOpenAiApiKey();
    const response = { configured: false };
    database.rememberIdempotentResponse(body.idempotencyKey, "providers.openai-key.delete", response);
    return response;
  });
  app.get("/api/v1/budget", async () => {
    const summary = database.budgetSummary(config.budgetUsd) as Record<string, unknown>;
    const tokenRows = rows<Record<string, unknown>>(database, `
      SELECT
        COALESCE(SUM(CASE WHEN purpose = 'memory' THEN input_tokens + output_tokens ELSE 0 END), 0) AS extraction,
        COALESCE(SUM(CASE WHEN purpose IN ('embedding','query_embedding') THEN input_tokens ELSE 0 END), 0) AS embedding
      FROM model_calls
    `)[0] ?? {};
    return {
      ...summary,
      totalUsd: Number(summary.spentUsd ?? 0),
      capUsd: Number(summary.hardLimitUsd ?? config.budgetUsd),
      warningThresholdUsd: config.budgetUsd * 0.8,
      extractionTokens: Number(tokenRows.extraction ?? 0),
      embeddingTokens: Number(tokenRows.embedding ?? 0)
    };
  });

  app.get("/api/v1/events", async (request) => {
    const query = parseQuery(EventsListQuerySchema, request.query);
    const fetched = database.listEvents({
      ...(query.cursor !== undefined ? { beforeSequence: query.cursor } : {}),
      ...(query.after !== undefined ? { afterSequence: query.after } : {}),
      limit: query.limit + 1
    });
    const hasMore = fetched.length > query.limit;
    const events = query.after !== undefined ? fetched.slice(0, query.limit) : hasMore ? fetched.slice(1) : fetched;
    return { events, items: events, nextCursor: hasMore && query.after === undefined ? String(events[0]?.sequence ?? "") : null };
  });
  app.get("/api/v1/events/:id", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const event = database.getEvent(id);
    if (!event) throw new AppError("EVENT_NOT_FOUND", "That conversation event no longer exists.", 404);
    return event;
  });
  app.get("/api/v1/events/:id/revisions", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const query = parseQuery(PaginationSchema, request.query);
    if (!database.getEvent(id)) throw new AppError("EVENT_NOT_FOUND", "That conversation event no longer exists.", 404);
    const page = offsetPage(database.listAssistantRevisions(id).slice(query.cursor ?? 0, (query.cursor ?? 0) + query.limit + 1), query.limit, query.cursor ?? 0);
    return { revisions: page.items, items: page.items, nextCursor: page.nextCursor };
  });
  app.patch("/api/v1/events/:id/activate", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const body = parseBody(EmptyMutationRequestSchema, request.body);
    return database.connection.transaction(() => {
      const prior = database.idempotentResponse<{ event: ReturnType<ContinuumDatabase["getEvent"]> }>(body.idempotencyKey, "events.activate");
      if (prior) return prior;
      const group = database.listAssistantRevisions(id);
      if (!group.some((revision) => revision.event.id === id)) throw new AppError("REVISION_NOT_FOUND", "That completed response revision was not found.", 404);
      const groupIds = group.map((revision) => revision.event.id);
      const marks = groupIds.map(() => "?").join(",");
      const affectedTopicIds = groupIds.length ? (rows<Record<string, unknown>>(database, `
        SELECT DISTINCT c.topic_id AS id FROM claims c
        JOIN claim_sources cs ON cs.claim_id = c.id
        WHERE c.topic_id IS NOT NULL AND cs.source_id IN (${marks})
        UNION
        SELECT DISTINCT tpr.topic_id AS id FROM topic_page_revisions tpr
        JOIN page_section_sources pss ON pss.revision_id = tpr.id
        WHERE pss.source_id IN (${marks})
      `, ...groupIds, ...groupIds).map((row) => String(row.id))) : [];
      const event = database.activateAssistantRevision(id);
      if (!event) throw new AppError("REVISION_NOT_FOUND", "Only a completed response revision can be activated.", 404);
      // A response can be regenerated while its background memory job is still
      // queued. Cancel queued compilation for now-inactive siblings so a stale
      // answer cannot be promoted after the user explicitly chose another one.
      database.connection.prepare(`
        UPDATE jobs SET status = 'cancelled', updated_at = ?
        WHERE type = 'memory.compile' AND status = 'queued'
          AND EXISTS (
            SELECT 1 FROM json_each(jobs.payload_json, '$.sourceEventIds') source
            WHERE source.value IN (${marks}) AND source.value <> ?
          )
      `).run(new Date().toISOString(), ...groupIds, id);
      if (affectedTopicIds.length) {
        database.enqueueJob("memory.rebuild", stableHash(`memory.rebuild:revision:${id}:${affectedTopicIds.sort().join(":")}`), { topicIds: affectedTopicIds, reason: "assistant_revision_activated" }, 15);
      }
      enqueueEventEmbedding(event);
      const response = { event };
      database.rememberIdempotentResponse(body.idempotencyKey, "events.activate", response);
      return response;
    }).immediate();
  });
  app.post("/api/v1/events/:id/regenerate", async (request, reply) => {
    const { id } = IdParamsSchema.parse(request.params);
    const body = parseBody(RegenerateEventRequestSchema, request.body ?? {});
    const key = body.idempotencyKey ?? z.string().min(8).parse(request.headers["idempotency-key"]);
    const selected = database.getEvent(id);
    const userEvent = selected?.role === "assistant" && selected.parentEventId ? database.getEvent(selected.parentEventId) : selected;
    if (!userEvent || userEvent.role !== "user") throw new AppError("USER_EVENT_NOT_FOUND", "The original user message could not be found.", 404);
    const priorRun = selected?.runId
      ? database.getRun(selected.runId)
      : rows<Record<string, unknown>>(database, "SELECT * FROM runs WHERE user_event_id = ? ORDER BY created_at DESC, id DESC LIMIT 1", userEvent.id)[0] ?? null;
    const quality = body.quality ?? QualityPresetSchema.parse(priorRun?.quality ?? "balanced");
    const response = database.createRegenerationRun(userEvent.id, quality, key);
    orchestrator.start(response.runId, userEvent, quality);
    await reply.code(202).send({ ...response, quality });
  });

  app.post("/api/v1/messages", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (request, reply) => {
    const body = parseBody(CreateMessageRequestSchema, request.body);
    const attachmentIds = body.attachmentIds ?? [];
    const quality = body.quality ?? "balanced";
    let aggregateAttachmentBytes = 0;
    for (const attachmentId of attachmentIds) {
      const attachment = database.getAttachment(attachmentId);
      if (!attachment || attachment.status !== "ready") throw new AppError("ATTACHMENT_NOT_READY", "Wait for every attachment to finish processing before sending.", 409, true);
      aggregateAttachmentBytes += attachment.size;
    }
    if (aggregateAttachmentBytes > 100 * 1024 * 1024) throw new AppError("ATTACHMENTS_TOO_LARGE", "A message may reference at most 100 MB of attachments.", 413);
    const response = database.createMessageAndRun({ content: body.content, attachmentIds, quality, idempotencyKey: body.idempotencyKey });
    for (const attachmentId of attachmentIds) {
      const attachment = database.getAttachment(attachmentId);
      if (attachment) database.addContextRef(response.event.id, "attachment", attachmentId, { sourceId: attachment.sourceId, contentHash: attachment.contentHash });
    }
    orchestrator.start(response.runId, response.event, quality);
    await reply.code(202).send(response);
  });

  app.get("/api/v1/runs", async (request) => {
    const query = parseQuery(RunsListQuerySchema, request.query);
    const offset = query.cursor ?? 0;
    const ids = query.status === "active"
      ? rows<{ id: string }>(database, "SELECT id FROM runs WHERE status IN ('pending','retrieving','streaming') ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?", query.limit + 1, offset)
      : query.status
        ? rows<{ id: string }>(database, "SELECT id FROM runs WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?", query.status, query.limit + 1, offset)
        : rows<{ id: string }>(database, "SELECT id FROM runs ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?", query.limit + 1, offset);
    const page = offsetPage(ids.map((row) => database.getRun(row.id)).filter((run): run is NonNullable<typeof run> => Boolean(run)).map(runProjection), query.limit, offset);
    return { runs: page.items, items: page.items, nextCursor: page.nextCursor };
  });
  app.get("/api/v1/idempotency-recovery", async (request) => {
    const query = parseQuery(MutationRecoveryQuerySchema, request.query);
    if (query.operation === "messages.create") {
      const prior = database.idempotentResponse<{ eventId: string; runId: string }>(query.key, query.operation);
      if (!prior) return { found: false as const, operation: query.operation };
      const event = database.getEvent(prior.eventId);
      const run = database.getRun(prior.runId);
      if (!event || !run) return { found: false as const, operation: query.operation };
      return { found: true as const, operation: query.operation, result: { event, runId: prior.runId } };
    }
    if (query.operation === "events.regenerate") {
      const prior = database.idempotentResponse<{ runId: string }>(query.key, query.operation);
      if (!prior) return { found: false as const, operation: query.operation };
      const run = database.getRun(prior.runId);
      if (!run) return { found: false as const, operation: query.operation };
      return {
        found: true as const,
        operation: query.operation,
        result: { runId: prior.runId, quality: QualityPresetSchema.parse(run.quality) }
      };
    }

    // If the original multipart request is still running, wait on that exact
    // operation rather than reporting a false miss that could race a retry.
    const inFlight = inFlightAttachmentUploads.get(query.key);
    if (inFlight) {
      try {
        return { found: true as const, operation: query.operation, result: await inFlight };
      } catch {
        // Fall through to the durable row. A failed upload has no committed
        // public result and is therefore honestly reported as not found.
      }
    }
    const prior = database.idempotentResponse<{ id?: unknown }>(query.key, query.operation);
    if (!prior || typeof prior.id !== "string") return { found: false as const, operation: query.operation };
    const attachment = database.getAttachment(prior.id);
    if (!attachment) return { found: false as const, operation: query.operation };
    return { found: true as const, operation: query.operation, result: AttachmentSchema.parse(attachment) };
  });
  app.get("/api/v1/runs/:id", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const run = database.getRun(id);
    if (!run) throw new AppError("RUN_NOT_FOUND", "That response run was not found.", 404);
    return runProjection(run);
  });
  app.post("/api/v1/runs/:id/cancel", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const body = parseBody(EmptyMutationRequestSchema, request.body);
    const prior = database.idempotentResponse<{ cancelled: boolean }>(body.idempotencyKey, "runs.cancel");
    if (prior) return prior;
    const result = { cancelled: orchestrator.cancel(id) };
    database.rememberIdempotentResponse(body.idempotencyKey, "runs.cancel", result);
    return result;
  });
  app.get("/api/v1/runs/:id/stream", async (request, reply) => {
    const { id } = IdParamsSchema.parse(request.params);
    if (!database.getRun(id)) throw new AppError("RUN_NOT_FOUND", "That response run was not found.", 404);
    const headerId = request.headers["last-event-id"];
    if (headerId !== undefined && (typeof headerId !== "string" || !/^\d+$/.test(headerId))) throw new AppError("INVALID_STREAM_CURSOR", "Last-Event-ID must be a non-negative integer.", 400);
    let lastId = typeof headerId === "string" ? Number.parseInt(headerId, 10) : 0;
    if (!Number.isSafeInteger(lastId)) throw new AppError("INVALID_STREAM_CURSOR", "Last-Event-ID is outside the supported integer range.", 400);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    let ended = false;
    let flushing = false;
    let flushRequested = false;
    const flush = () => {
      if (ended) return;
      if (flushing) { flushRequested = true; return; }
      flushing = true;
      try {
        do {
          flushRequested = false;
          while (!ended) {
            const storedEvents = database.listRunStreamEvents(id, lastId);
            for (const stored of storedEvents) {
              lastId = stored.id;
              reply.raw.write(`id: ${stored.id}\nevent: v1\ndata: ${JSON.stringify({ version: "v1", ...stored.event })}\n\n`);
              if (["run.completed", "run.failed", "run.cancelled"].includes(stored.event.type)) {
                ended = true;
                reply.raw.end();
                break;
              }
            }
            if (storedEvents.length < 1_000) break;
          }
        } while (flushRequested && !ended);
      } finally { flushing = false; }
    };
    const unsubscribe = hub.subscribe(id, flush);
    const heartbeat = setInterval(() => { if (!ended) reply.raw.write(": keep-alive\n\n"); }, 15_000);
    const cleanup = () => { ended = true; clearInterval(heartbeat); unsubscribe(); };
    request.raw.on("close", cleanup);
    reply.raw.on("close", cleanup);
    flush();
  });

  app.post("/api/v1/attachments", async (request, reply) => {
    const idempotencyKey = IdempotencySchema.parse(request.headers["idempotency-key"]);
    const prior = database.idempotentResponse<Record<string, unknown>>(idempotencyKey, "attachments.upload");
    if (prior) return reply.code(202).send(prior);
    const existingUpload = inFlightAttachmentUploads.get(idempotencyKey);
    if (existingUpload) return reply.code(202).send(await existingUpload);
    const upload = (async (): Promise<Attachment> => {
      const part = await request.file();
      if (!part) throw new AppError("FILE_REQUIRED", "Choose a file to attach.");
      const filename = basename(part.filename).slice(0, 255);
      const inferredMediaType = mediaTypeForFilename(filename);
      const browserMediaType = normalizeMediaType(part.mimetype);
      if (!inferredMediaType && !ALLOWED_MEDIA_TYPES.has(browserMediaType)) throw new AppError("FILE_TYPE_UNSUPPORTED", "That file type is not supported yet.", 415);
      const activeSourceJobs = database.listJobs(500).filter((job) => job.type === "source.extract" && (job.status === "queued" || job.status === "running")).length;
      if (activeSourceJobs >= 200) throw new AppError("INGESTION_QUEUE_FULL", "Too many files are already being processed. Try again after the queue clears.", 429, true);
      const buffer = await part.toBuffer();
      if (buffer.byteLength > MAX_ATTACHMENT_BYTES) throw new AppError("FILE_TOO_LARGE", "Attachments may be at most 25 MB.", 413, false, { maximumBytes: MAX_ATTACHMENT_BYTES });
      // Browsers frequently label source files as application/octet-stream or
      // video/mp2t. The normalized filename mapping is canonical, while byte
      // signatures still have to agree before anything is persisted.
      const mediaType = validateAttachmentPolicy({ filename, declaredMediaType: inferredMediaType ?? browserMediaType, bytes: buffer });
      const hash = createHash("sha256").update(buffer).digest("hex");
      return withAttachmentHashUpload(hash, async () => {
        const stored = await attachmentStore.put(buffer);
        const storagePath = join(config.attachmentsDir, stored.storageKey);
        try {
          return database.connection.transaction(() => {
            const sourceId = database.createSource({ type: "attachment", title: filename, contentHash: hash, provenance: { kind: "user-upload" } });
            const attachment = database.createAttachment({ sourceId, filename, mediaType, size: buffer.byteLength, storagePath, contentHash: hash, status: "queued" });
            database.enqueueJob("source.extract", stableHash(`source.extract:${attachment.id}:${hash}:v1`), { attachmentId: attachment.id, sourceId, mediaType, storagePath }, 20);
            const publicAttachment = AttachmentSchema.parse(attachment);
            database.rememberIdempotentResponse(idempotencyKey, "attachments.upload", publicAttachment);
            return publicAttachment;
          })();
        } catch (error) {
          const referenced = database.connection.prepare(`
            SELECT 1 FROM attachments WHERE content_hash = ? LIMIT 1
          `).get(hash);
          if (!referenced) {
            try { await attachmentStore.delete(hash); }
            catch (cleanupError) {
              throw new AggregateError([error, cleanupError], "Attachment metadata failed and its unreferenced canonical bytes could not be removed.");
            }
          }
          throw error;
        }
      });
    })();
    inFlightAttachmentUploads.set(idempotencyKey, upload);
    try {
      await reply.code(202).send(await upload);
    } finally {
      if (inFlightAttachmentUploads.get(idempotencyKey) === upload) inFlightAttachmentUploads.delete(idempotencyKey);
    }
  });
  app.get("/api/v1/attachments", async (request) => {
    const query = parseQuery(PaginationSchema, request.query);
    const offset = query.cursor ?? 0;
    const attachments = rows<Record<string, unknown>>(database, "SELECT id, source_id AS sourceId, filename, media_type AS mediaType, size, status, error_code AS errorCode, created_at AS createdAt FROM attachments ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?", query.limit + 1, offset);
    const page = offsetPage(attachments, query.limit, offset);
    return { attachments: page.items, items: page.items, nextCursor: page.nextCursor };
  });
  app.get("/api/v1/attachments/:id", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const attachment = database.getAttachment(id);
    if (!attachment) throw new AppError("ATTACHMENT_NOT_FOUND", "That attachment was not found.", 404);
    return Object.fromEntries(Object.entries(attachment).filter(([key]) => key !== "storagePath"));
  });
  app.get("/api/v1/attachments/:id/content", async (request, reply) => {
    const { id } = IdParamsSchema.parse(request.params);
    const attachment = database.getAttachment(id);
    if (!attachment || attachment.status !== "ready" || !["image/png", "image/jpeg", "image/webp"].includes(attachment.mediaType)) {
      throw new AppError("ATTACHMENT_PREVIEW_NOT_FOUND", "That image preview is not available.", 404);
    }
    const bytes = await attachmentStore.get(attachment.contentHash).catch(() => null);
    if (!bytes) throw new AppError("ATTACHMENT_PREVIEW_NOT_FOUND", "That image preview is not available.", 404);
    reply.header("Content-Type", attachment.mediaType);
    reply.header("Content-Length", String(bytes.byteLength));
    reply.header("Cache-Control", "private, no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(basename(attachment.filename))}`);
    return reply.send(Buffer.from(bytes));
  });
  app.get("/api/v1/sources", async (request) => {
    const query = parseQuery(PaginationSchema, request.query);
    const offset = query.cursor ?? 0;
    const sources = rows(database, "SELECT id, type, title, uri, content_hash AS contentHash, freshness_class AS freshnessClass, created_at AS createdAt, retrieved_at AS retrievedAt FROM sources ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?", query.limit + 1, offset);
    const page = offsetPage(sources, query.limit, offset);
    return { sources: page.items, items: page.items, nextCursor: page.nextCursor };
  });
  app.get("/api/v1/sources/:id", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const query = parseQuery(SourceDetailQuerySchema, request.query);
    const source = rows<Record<string, unknown>>(database, "SELECT id, type, title, uri, content_hash AS contentHash, provenance_json AS provenance, freshness_class AS freshnessClass, created_at AS createdAt, retrieved_at AS retrievedAt FROM sources WHERE id = ?", id)[0];
    if (!source) throw new AppError("SOURCE_NOT_FOUND", "That retained source was not found.", 404);
    const chunks = rows<Record<string, unknown>>(database, "SELECT id, ordinal, text_content AS content, location_json AS location, token_count AS tokenCount, content_hash AS contentHash, created_at AS createdAt FROM source_chunks WHERE source_id = ? ORDER BY ordinal LIMIT ? OFFSET ?", id, query.chunkLimit + 1, query.chunkCursor).map((chunk) => ({
      ...chunk,
      location: (() => { try { return JSON.parse(String(chunk.location)) as unknown; } catch { return {}; } })()
    }));
    const page = offsetPage(chunks, query.chunkLimit, query.chunkCursor);
    return { source: { ...source, provenance: (() => { try { return JSON.parse(String(source.provenance)) as unknown; } catch { return {}; } })() }, chunks: page.items, chunksTruncated: page.nextCursor !== null, chunkNextCursor: page.nextCursor };
  });
  app.get("/api/v1/evidence/:id", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const event = database.getEvent(id);
    if (event) return { type: "event", id, record: event };
    const claim = database.getClaim(id, true);
    if (claim) return { type: "claim", id, record: claim };
    const topic = database.getTopic(id);
    if (topic) return { type: "topic", id, record: topic };
    const entity = database.entityDetail(id);
    if (entity) return { type: "entity", id, record: entity };
    const source = rows<Record<string, unknown>>(database, "SELECT id, type, title, uri, freshness_class AS freshnessClass, created_at AS createdAt, retrieved_at AS retrievedAt FROM sources WHERE id = ?", id)[0];
    if (source) return { type: "source", id, record: source };
    const chunk = rows<Record<string, unknown>>(database, "SELECT sc.id, sc.source_id AS sourceId, sc.ordinal, sc.text_content AS content, sc.location_json AS location, sc.created_at AS createdAt, s.title AS sourceTitle, s.type AS sourceType FROM source_chunks sc JOIN sources s ON s.id = sc.source_id WHERE sc.id = ?", id)[0];
    if (chunk) return { type: "source_chunk", id, record: { ...chunk, location: (() => { try { return JSON.parse(String(chunk.location)) as unknown; } catch { return {}; } })() } };
    const attachment = database.getAttachment(id);
    if (attachment) {
      const { storagePath: _privatePath, ...safeAttachment } = attachment;
      void _privatePath;
      return { type: "attachment", id, record: safeAttachment };
    }
    const tool = rows<Record<string, unknown>>(database, "SELECT id, run_id AS runId, tool_name AS toolName, output_text AS output, citations_json AS citations, status, sandbox_json AS sandbox, started_at AS startedAt, completed_at AS completedAt FROM tool_executions WHERE id = ?", id)[0];
    if (tool) return { type: "tool_result", id, record: tool };
    throw new AppError("EVIDENCE_NOT_FOUND", "That exact evidence record was not found.", 404);
  });

  app.get("/api/v1/workspaces", async (request) => {
    const query = parseQuery(PaginationSchema, request.query);
    const offset = query.cursor ?? 0;
    const workspaces = rows<Record<string, unknown>>(database, "SELECT id, path, display_name AS displayName, read_only AS readOnly, authorized, authorized_at AS authorizedAt, created_at AS createdAt FROM workspace_roots WHERE authorized = 1 ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?", query.limit + 1, offset);
    const page = offsetPage(workspaces, query.limit, offset);
    return { workspaces: page.items, items: page.items, nextCursor: page.nextCursor };
  });
  app.post("/api/v1/workspaces", async (request) => {
    const body = parseBody(AuthorizeWorkspaceRequestSchema, request.body);
    const prior = database.idempotentResponse<Record<string, unknown>>(body.idempotencyKey, "workspaces.authorize");
    if (prior) return prior;
    const requested = resolve(body.path);
    if (!await pathExists(requested)) throw new AppError("WORKSPACE_NOT_FOUND", "That folder does not exist.", 404);
    const candidate = await realpath(requested).catch(() => null);
    if (!candidate || !(await stat(candidate)).isDirectory()) throw new AppError("WORKSPACE_NOT_DIRECTORY", "Choose a folder rather than a file.", 400);
    const id = database.authorizeWorkspace(candidate, body.displayName);
    const response = { id, path: candidate, displayName: body.displayName, readOnly: true };
    database.rememberIdempotentResponse(body.idempotencyKey, "workspaces.authorize", response);
    return response;
  });
  app.post("/api/v1/workspaces/:id/secret-approvals", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const body = parseBody(SecretApprovalRequestSchema, request.body);
    const operation = `workspaces.secret-approval.${id}`;
    const prior = database.idempotentResponse<Record<string, unknown>>(body.idempotencyKey, operation);
    if (prior) return prior;
    const workspace = rows<Record<string, unknown>>(database, "SELECT id FROM workspace_roots WHERE id = ? AND authorized = 1 AND read_only = 1", id)[0];
    if (!workspace) throw new AppError("WORKSPACE_NOT_AUTHORIZED", "Authorize that read-only workspace before approving a file.", 404);
    let relativePath: string;
    try { relativePath = normalizeWorkspaceGrantPath(body.relativePath); }
    catch { throw new AppError("WORKSPACE_PATH_INVALID", "Use an exact relative file path inside the authorized workspace.", 400); }
    if (!isLikelySecretPath(relativePath)) throw new AppError("SECRET_APPROVAL_NOT_REQUIRED", "That path is not classified as secret-like and does not need this approval.", 400);
    const grant = secretGrants.grant(id, relativePath);
    const response = { ...grant, workspaceId: id, oneUse: true as const, remainingUses: 1 as const, status: "ready" as const };
    database.rememberIdempotentResponse(body.idempotencyKey, operation, response);
    return response;
  });
  app.delete("/api/v1/workspaces/:id", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const body = parseBody(EmptyMutationRequestSchema, request.body);
    const prior = database.idempotentResponse<{ revoked: boolean }>(body.idempotencyKey, "workspaces.revoke");
    if (prior) return prior;
    const response = { revoked: database.connection.prepare("UPDATE workspace_roots SET authorized = 0 WHERE id = ? AND authorized = 1").run(id).changes === 1 };
    secretGrants.revokeRoot(id);
    database.rememberIdempotentResponse(body.idempotencyKey, "workspaces.revoke", response);
    return response;
  });
  app.get("/api/v1/tools", async (request) => {
    const query = parseQuery(RunFilterListQuerySchema, request.query);
    const offset = query.cursor ?? 0;
    const tools = rows(database, `
      SELECT id, run_id AS runId, tool_name AS toolName, arguments_json AS arguments,
        output_text AS output, status, citations_json AS citations, sandbox_json AS sandbox,
        started_at AS startedAt, completed_at AS completedAt
      FROM tool_executions WHERE (? IS NULL OR run_id = ?)
      ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?
    `, query.runId ?? null, query.runId ?? null, query.limit + 1, offset);
    const page = offsetPage(tools, query.limit, offset);
    return { tools: page.items, items: page.items, nextCursor: page.nextCursor };
  });

  app.get("/api/v1/search", async (request) => {
    const started = performance.now();
    const query = parseQuery(SearchQuerySchema, request.query);
    const allowedTypes = new Set(["event", "topic", "claim", "entity", "source", "attachment", "tool_result"] as const);
    const types = (query.types?.split(",").filter((value): value is "event" | "topic" | "claim" | "entity" | "source" | "attachment" | "tool_result" => allowedTypes.has(value as "event")) ?? []);
    const searchLimit = query.limit ?? 30;
    const searchOffset = query.cursor ?? 0;
    const searchRole = query.role ?? "all";
    const searchStatus = query.status ?? "all";
    const searchDate = query.date ?? "all";
    const source = query.source ?? "";
    const tag = query.tag ?? "";
    const dayMs = 24 * 60 * 60 * 1_000;
    const from = searchDate === "all" ? null : new Date(Date.now() - (searchDate === "today" ? dayMs : searchDate === "week" ? 7 * dayMs : searchDate === "month" ? 30 * dayMs : 365 * dayMs)).toISOString();
    const sourceFilter = source.trim().toLocaleLowerCase();
    const tagFilter = tag.trim().toLocaleLowerCase();
    if (!sourceFilter && !tagFilter) {
      const results = database.search(query.q, searchLimit + 1, { offset: searchOffset, types, role: searchRole, status: searchStatus, from });
      const hasMore = results.length > searchLimit;
      return { results: results.slice(0, searchLimit), nextCursor: hasMore ? String(searchOffset + searchLimit) : null, tookMs: performance.now() - started };
    }
    // Source/tag filters apply after cross-channel rank fusion. Treat the
    // cursor as a scan position and keep paging ranked candidates until the UI
    // page is full or the corpus is exhausted; filtering only the first N rows
    // silently hid valid older matches in long sessions.
    const results: ReturnType<ContinuumDatabase["search"]> = [];
    const batchSize = 100;
    let scanOffset = searchOffset;
    let hasMore = false;
    search: while (results.length < searchLimit) {
      const batch = database.search(query.q, batchSize, { offset: scanOffset, types, role: searchRole, status: searchStatus, from });
      if (batch.length === 0) break;
      for (let index = 0; index < batch.length; index += 1) {
        const result = batch[index]!;
        scanOffset += 1;
        const sourceMatches = !sourceFilter || `${result.title} ${result.snippet} ${result.tags.join(" ")}`.toLocaleLowerCase().includes(sourceFilter);
        const tagMatches = !tagFilter || result.tags.some((candidate) => candidate.toLocaleLowerCase().includes(tagFilter));
        if (!sourceMatches || !tagMatches) continue;
        results.push(result);
        if (results.length >= searchLimit) {
          hasMore = index + 1 < batch.length || batch.length === batchSize;
          break search;
        }
      }
      if (batch.length < batchSize) break;
    }
    return { results, nextCursor: hasMore ? String(scanOffset) : null, tookMs: performance.now() - started };
  });
  app.get("/api/v1/topics", async (request) => {
    const query = parseQuery(PaginationSchema, request.query);
    const offset = query.cursor ?? 0;
    const page = offsetPage(database.listTopics(query.limit + 1, false, offset), query.limit, offset);
    return { topics: page.items, items: page.items, nextCursor: page.nextCursor };
  });
  app.get("/api/v1/topics/:identity", async (request) => {
    const { identity } = TopicIdentityParamsSchema.parse(request.params);
    const query = parseQuery(TopicDetailQuerySchema, request.query);
    const topicId = IdSchema.safeParse(identity).success
      ? identity
      : (rows<{ id: string }>(database, "SELECT id FROM topic_pages WHERE slug = ? AND lifecycle_status = 'active' LIMIT 1", identity)[0]?.id ?? null);
    const topic = topicId ? (query.revision ? database.getTopicRevision(topicId, query.revision) : database.getTopic(topicId)) : null;
    if (!topic) throw new AppError("TOPIC_NOT_FOUND", "That memory page was not found.", 404);
    return topic;
  });
  app.patch("/api/v1/topics/:id", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const patch = parseBody(UpdateTopicRequestSchema, request.body);
    const prior = database.idempotentResponse<ReturnType<ContinuumDatabase["upsertTopicRevision"]>>(patch.idempotencyKey, "topics.patch");
    if (prior) return prior;
    const existing = database.getTopic(id);
    if (!existing) throw new AppError("TOPIC_NOT_FOUND", "That memory page was not found.", 404);
    if (existing.revision !== patch.expectedRevision) throw new AppError("REVISION_CONFLICT", "This page changed while you were editing it. Review the latest revision.", 409, true, { currentRevision: existing.revision });
    const title = patch.title ?? existing.title;
    const summary = patch.summary ?? existing.summary;
    const currentState = patch.currentState ?? existing.currentState;
    const history = patch.history ?? existing.history;
    const openQuestions = patch.openQuestions ?? existing.openQuestions;
    const markdown = patch.markdown ?? [`# ${title}`, "## Summary", summary, "## Current state", currentState, "## History", history, "## Open questions", ...openQuestions.map((question) => `- ${question}`)].join("\n\n");
    const response = database.connection.transaction(() => {
      const updated = database.upsertTopicRevision({ id, type: existing.type, title, slug: existing.slug, tags: patch.tags ?? existing.tags, markdown, summary, currentState, history, openQuestions, sourceIds: existing.sourceIds, authorType: "user", promptVersion: "user-edit-v1" });
      enqueueProjectionSync(
        stableHash(`projection.sync:user-topic:${updated.id}:${updated.revision}:${stableHash(markdown)}`),
        { topicIds: [updated.id], reason: "user_topic_edit" }
      );
      enqueueTopicEmbedding(updated);
      database.rememberIdempotentResponse(patch.idempotencyKey, "topics.patch", updated);
      return updated;
    })();
    await syncTopicProjections([response.id]);
    return response;
  });
  app.post("/api/v1/topics", async (request) => {
    const body = parseBody(CreateTopicRequestSchema, request.body);
    const prior = database.idempotentResponse<ReturnType<ContinuumDatabase["upsertTopicRevision"]>>(body.idempotencyKey, "topics.create");
    if (prior) return prior;
    const response = database.connection.transaction(() => {
      const created = database.upsertTopicRevision({ ...body, openQuestions: body.openQuestions ?? [], tags: body.tags ?? [], authorType: "user", promptVersion: "user-edit-v1" });
      enqueueProjectionSync(
        stableHash(`projection.sync:user-topic:${created.id}:${created.revision}:${stableHash(created.markdown)}`),
        { topicIds: [created.id], reason: "user_topic_create" }
      );
      enqueueTopicEmbedding(created);
      database.rememberIdempotentResponse(body.idempotencyKey, "topics.create", created);
      return created;
    })();
    await syncTopicProjections([response.id]);
    return response;
  });
  type OrderedProposalKey = { id: string; createdAt: string };
  const compareProposalKeys = (left: OrderedProposalKey, right: OrderedProposalKey) =>
    right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id);
  const normalizedProposalHeader = (offset: number): OrderedProposalKey | null => {
    const row = database.connection.prepare(`
      SELECT id, created_at FROM topic_shard_proposals
      WHERE status = 'pending' ORDER BY created_at DESC, id ASC LIMIT 1 OFFSET ?
    `).get(offset) as { id: string; created_at: string } | undefined;
    return row ? { id: row.id, createdAt: row.created_at } : null;
  };
  const normalizedProposalHeaders = (limit: number, offset: number): OrderedProposalKey[] => rows<{ id: string; created_at: string }>(database, `
    SELECT id, created_at FROM topic_shard_proposals
    WHERE status = 'pending' ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?
  `, limit, offset).map((row) => ({ id: row.id, createdAt: row.created_at }));
  const mergedPendingProposalPage = (offset: number, limit: number): { items: TopicProposalRecord[]; nextCursor: string | null } => {
    const storedLegacy = z.array(TopicProposalSchema).max(5_000).parse(database.getSetting<unknown[]>("memory.pendingTopicProposals", []));
    const legacyById = new Map(storedLegacy.map((proposal) => [proposal.id, proposal]));
    const normalizedIds = new Set<string>();
    const legacyIds = [...legacyById.keys()];
    for (let start = 0; start < legacyIds.length; start += 500) {
      const batch = legacyIds.slice(start, start + 500);
      if (batch.length === 0) continue;
      const marks = batch.map(() => "?").join(",");
      for (const row of rows<{ id: string }>(database, `SELECT id FROM topic_shard_proposals WHERE id IN (${marks})`, ...batch)) {
        normalizedIds.add(row.id);
      }
    }
    // A normalized row owns its ID even after resolution; otherwise the list
    // could expose a legacy duplicate that the resolve route can never reach.
    const legacy = [...legacyById.values()].filter((proposal) => !normalizedIds.has(proposal.id)).sort(compareProposalKeys);
    const normalizedCount = Number((database.connection.prepare(`
      SELECT COUNT(*) AS count FROM topic_shard_proposals WHERE status = 'pending'
    `).get() as { count: number }).count);
    const total = normalizedCount + legacy.length;
    if (offset >= total) return { items: [], nextCursor: null };

    // Find the exact merge partition at the numeric cursor without loading the
    // preceding normalized proposals or any of their child rows. Legacy is
    // bounded at 5k, so this takes at most ~13 indexed OFFSET probes.
    const headerCache = new Map<number, OrderedProposalKey | null>();
    const headerAt = (index: number) => {
      if (!headerCache.has(index)) headerCache.set(index, normalizedProposalHeader(index));
      return headerCache.get(index) ?? null;
    };
    let low = Math.max(0, offset - legacy.length);
    let high = Math.min(offset, normalizedCount);
    let normalizedOffset = low;
    let legacyOffset = offset - low;
    let partitioned = false;
    while (low <= high) {
      const normalizedConsumed = Math.floor((low + high) / 2);
      const legacyConsumed = offset - normalizedConsumed;
      const normalizedPrevious = normalizedConsumed > 0 ? headerAt(normalizedConsumed - 1) : null;
      const normalizedNext = normalizedConsumed < normalizedCount ? headerAt(normalizedConsumed) : null;
      const legacyPrevious = legacyConsumed > 0 ? legacy[legacyConsumed - 1]! : null;
      const legacyNext = legacyConsumed < legacy.length ? legacy[legacyConsumed]! : null;
      if (normalizedPrevious && legacyNext && compareProposalKeys(normalizedPrevious, legacyNext) > 0) {
        high = normalizedConsumed - 1;
      } else if (legacyPrevious && normalizedNext && compareProposalKeys(legacyPrevious, normalizedNext) > 0) {
        low = normalizedConsumed + 1;
      } else {
        normalizedOffset = normalizedConsumed;
        legacyOffset = legacyConsumed;
        partitioned = true;
        break;
      }
    }
    if (!partitioned) throw new Error("Pending proposal pagination could not find a stable merge partition.");

    const normalized = normalizedProposalHeaders(limit + 1, normalizedOffset);
    const legacyWindow = legacy.slice(legacyOffset, legacyOffset + limit + 1);
    const selected: TopicProposalRecord[] = [];
    let normalizedIndex = 0;
    let legacyIndex = 0;
    while (selected.length < limit + 1 && (normalizedIndex < normalized.length || legacyIndex < legacyWindow.length)) {
      const normalizedHeader = normalized[normalizedIndex];
      const legacyProposal = legacyWindow[legacyIndex];
      if (normalizedHeader && (!legacyProposal || compareProposalKeys(normalizedHeader, legacyProposal) <= 0)) {
        const proposal = database.getTopicShardProposal(normalizedHeader.id);
        if (!proposal) throw new Error(`Pending proposal ${normalizedHeader.id} disappeared inside a read snapshot.`);
        selected.push(TopicProposalRecordSchema.parse(proposal));
        normalizedIndex += 1;
      } else if (legacyProposal) {
        selected.push(TopicProposalRecordSchema.parse(legacyProposal));
        legacyIndex += 1;
      }
    }
    return offsetPage(selected, limit, offset);
  };
  const staleProposal = (message: string): never => {
    throw new AppError("MEMORY_PROPOSAL_STALE", message, 409, true);
  };
  const resolveNormalizedProposal = (
    proposal: TopicShardProposal,
    action: "accept" | "reject",
    idempotencyKey: string,
    operation: string
  ): Record<string, unknown> => {
    const storedStatus = database.connection.prepare(`
      SELECT status FROM topic_shard_proposals WHERE id = ?
    `).get(proposal.id) as { status: string } | undefined;
    if (!storedStatus) throw new AppError("MEMORY_PROPOSAL_NOT_FOUND", "That memory proposal does not exist.", 404);
    if (storedStatus.status !== "pending") {
      if (storedStatus.status === (action === "accept" ? "accepted" : "rejected")) {
        const response = {
          resolved: true,
          action,
          proposalId: proposal.id,
          topicIds: action === "accept"
            ? [...new Set([proposal.topicId, ...proposal.patches.flatMap((patch) => patch.outputs.map((output) => output.topicId))])]
            : []
        };
        database.rememberIdempotentResponse(idempotencyKey, operation, response);
        return response;
      }
      staleProposal(`This proposal is already ${storedStatus.status}.`);
    }
    const timestamp = new Date().toISOString();
    if (action === "reject") {
      return database.connection.transaction(() => {
        const newPageIds = new Set<string>();
        for (const patch of proposal.patches) {
          for (const output of patch.outputs) {
            const page = database.connection.prepare(`
              SELECT active_revision, lifecycle_status FROM topic_pages WHERE id = ?
            `).get(output.topicId) as { active_revision: number; lifecycle_status: string } | undefined;
            const revision = database.connection.prepare(`
              SELECT topic_id, revision_number, author_type, prompt_version, generation_inputs_json
              FROM topic_page_revisions WHERE id = ?
            `).get(output.revisionId) as {
              topic_id: string;
              revision_number: number;
              author_type: string;
              prompt_version: string;
              generation_inputs_json: string;
            } | undefined;
            let generationInputs: Record<string, unknown> | null = null;
            try {
              const parsed = revision ? JSON.parse(revision.generation_inputs_json) as unknown : null;
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) generationInputs = parsed as Record<string, unknown>;
            } catch { generationInputs = null; }
            if (revision && (
              revision.topic_id !== output.topicId
              || revision.revision_number !== output.revision
              || revision.author_type !== "model"
              || revision.prompt_version !== "topic-shard-proposal-v1"
              || generationInputs?.activation !== "proposal"
              || generationInputs?.parentTopicId !== proposal.topicId
              || generationInputs?.section !== patch.section
              || generationInputs?.ordinal !== output.ordinal
            )) {
              staleProposal("A candidate revision identity changed before rejection.");
            }
            if (output.baseRevision !== null && page?.active_revision === output.revision) {
              staleProposal("A candidate revision is already active and cannot be rejected safely.");
            }
            if (output.baseRevision === null) {
              if (page && (page.lifecycle_status !== "proposal" || page.active_revision !== output.revision)) {
                staleProposal("A proposal-only page changed before rejection.");
              }
              newPageIds.add(output.topicId);
            }
          }
        }
        for (const patch of proposal.patches) {
          for (const output of patch.outputs) {
            const sharedRevision = database.connection.prepare(`
              SELECT 1 FROM topic_shard_proposal_outputs candidate
              JOIN topic_shard_proposals pending ON pending.id = candidate.proposal_id
              WHERE candidate.revision_id = ? AND pending.status = 'pending' AND pending.id <> ? LIMIT 1
            `).get(output.revisionId, proposal.id);
            if (sharedRevision) continue;
            database.connection.prepare("DELETE FROM vectors WHERE source_id = ?").run(output.revisionId);
            database.connection.prepare("DELETE FROM topic_revision_fts WHERE revision_id = ?").run(output.revisionId);
            database.connection.prepare(`
              DELETE FROM topic_page_revisions WHERE id = ? AND topic_id = ?
            `).run(output.revisionId, output.topicId);
          }
        }
        for (const topicId of newPageIds) {
          const shared = database.connection.prepare(`
            SELECT 1 FROM topic_shard_proposal_outputs output
            JOIN topic_shard_proposals pending ON pending.id = output.proposal_id
            WHERE output.topic_id = ? AND pending.status = 'pending' AND pending.id <> ? LIMIT 1
          `).get(topicId, proposal.id);
          if (shared) continue;
          database.connection.prepare("DELETE FROM vectors WHERE source_id = ?").run(topicId);
          database.connection.prepare("DELETE FROM page_links WHERE source_topic_id = ? OR target_topic_id = ?").run(topicId, topicId);
          database.connection.prepare("DELETE FROM topic_fts WHERE topic_id = ?").run(topicId);
          database.connection.prepare("DELETE FROM topic_revision_fts WHERE topic_id = ?").run(topicId);
          database.connection.prepare("DELETE FROM topic_pages WHERE id = ? AND lifecycle_status = 'proposal'").run(topicId);
        }
        database.connection.prepare(`
          UPDATE topic_shard_proposals SET status = 'rejected', resolved_at = ?
          WHERE id = ? AND status = 'pending'
        `).run(timestamp, proposal.id);
        database.pruneTerminalTopicShardProposalHeaders();
        // Proposal planning already consumed the exact dirty generations when
        // it durably committed the guarded candidate. Rejection records the
        // explicit decision to retain the current projection and refreshes its
        // repair outboxes; it must not delete any newer dirty generation that
        // may have arrived after the proposal was created.
        const retainedTopicIds = [
          proposal.topicId,
          ...rows<{ child_topic_id: string }>(database, `
            SELECT child_topic_id FROM topic_section_shards
            WHERE parent_topic_id = ? ORDER BY section_key, ordinal, child_topic_id
          `, proposal.topicId).map((row) => row.child_topic_id)
        ];
        database.connection.prepare("UPDATE topic_projection_state SET updated_at = ? WHERE parent_topic_id = ?")
          .run(timestamp, proposal.topicId);
        enqueueProjectionSync(
          stableHash(`projection.sync:proposal-reject:${proposal.id}:${timestamp}`),
          { topicIds: retainedTopicIds, reason: "topic_shard_proposal_reject", proposalId: proposal.id }
        );
        for (const topicId of retainedTopicIds) {
          const topic = database.getTopic(topicId);
          if (topic) enqueueTopicEmbedding(topic);
        }
        const response = { resolved: true, action, proposalId: proposal.id, topicIds: [] as string[] };
        database.rememberIdempotentResponse(idempotencyKey, operation, response);
        return response;
      })();
    }

    return database.connection.transaction(() => {
      // Every check in this block precedes the first mutation. Any stale 409 is
      // therefore a true zero-write failure, rather than a transaction rollback
      // that briefly depended on mutation ordering.
      const policy = database.getTopicUpdatePolicy(proposal.topicId);
      if (policy !== "confirm") staleProposal("The protected parent no longer requires confirmation.");
      const parentBase = database.getTopicShardParentBaseSnapshot(proposal.topicId);
      if (!parentBase
        || parentBase.revisionId !== proposal.parentBase.revisionId
        || parentBase.revision !== proposal.parentBase.revision
        || parentBase.fingerprint !== proposal.parentBase.fingerprint) {
        staleProposal("The protected parent revision changed after this proposal was planned.");
      }
      const changedClaimIds = new Set(proposal.claimIds);
      const guardedClaimIds = new Set(proposal.claimGuards.map((guard) => guard.claimId));
      if (guardedClaimIds.size !== proposal.claimGuards.length) staleProposal("A claim has more than one proposal guard.");
      for (const claimId of changedClaimIds) {
        if (!guardedClaimIds.has(claimId)) staleProposal("A changed claim is missing its exact state guard.");
      }
      const guardedClaims = new Map<string, Claim>();
      for (const guard of proposal.claimGuards) {
        const snapshot = database.getTopicShardClaimGuardSnapshot(guard.claimId);
        if (!snapshot || snapshot.topicId !== guard.expectedTopicId || snapshot.stateHash !== guard.stateHash) {
          staleProposal("A claim rendered by this proposal changed after planning.");
        }
        const claim = database.getClaim(guard.claimId, true);
        if (!claim) staleProposal("A guarded claim disappeared after planning.");
        guardedClaims.set(guard.claimId, claim);
        if (guard.assignToTopicId !== null && (
          !changedClaimIds.has(guard.claimId)
          || guard.expectedTopicId !== null
          || guard.projectedTopicId !== proposal.topicId
          || guard.assignToTopicId !== proposal.topicId
        )) staleProposal("A proposal contains an invalid claim-assignment instruction.");
      }
      const removedBaseIds = new Set<string>();
      const acceptedSections = new Set<string>();
      const exactEvidenceByTopic = new Map<string, string[]>();
      const outputTopicIds = new Set<string>();
      const outputRevisionIds = new Set<string>();
      const outputOrdinalKeys = new Set<string>();
      const candidateRanges: Array<{ section: string; topicId: string; minSortKey: string; maxSortKey: string }> = [];
      for (const patch of proposal.patches) {
        acceptedSections.add(patch.section);
        if (!patch.base && patch.outputs.length === 0) staleProposal("A new shard patch has no candidate output.");
        if (patch.base) {
          if (removedBaseIds.has(patch.base.topicId)) staleProposal("The same base shard is patched more than once.");
          removedBaseIds.add(patch.base.topicId);
          const base = database.getTopicShardBaseSnapshot(patch.base.topicId);
          if (!base
            || base.revisionId !== patch.base.revisionId
            || base.revision !== patch.base.revision
            || base.section !== patch.section
            || base.ordinal !== patch.base.ordinal
            || base.minSortKey !== patch.base.minSortKey
            || base.maxSortKey !== patch.base.maxSortKey
            || base.fingerprint !== patch.base.fingerprint) {
            staleProposal("A touched shard changed after this proposal was planned.");
          }
          if (patch.outputs.length > 0 && patch.outputs[0]!.topicId !== patch.base.topicId) {
            staleProposal("A replacement patch no longer reuses its guarded base shard.");
          }
        }
        for (const route of patch.routeGuards) {
          const claim = guardedClaims.get(route.claimId);
          if (!claim || !changedClaimIds.has(route.claimId)
            || route.sortKey !== proposalClaimSortKey(claim, patch.section)
            || route.expectedBaseTopicId !== (patch.base?.topicId ?? null)) {
            staleProposal("A candidate route is no longer bound to its guarded claim and base shard.");
          }
          if (currentShardRouteTarget(database, proposal.topicId, patch.section, route.sortKey) !== route.expectedBaseTopicId) {
            staleProposal("A claim now routes to a different shard range.");
          }
        }
        for (let outputIndex = 0; outputIndex < patch.outputs.length; outputIndex += 1) {
          const output = patch.outputs[outputIndex]!;
          const ordinalKey = `${patch.section}\u0000${output.ordinal}`;
          if (outputOrdinalKeys.has(ordinalKey)) staleProposal("Two candidate outputs claim the same sparse ordinal.");
          outputOrdinalKeys.add(ordinalKey);
          if (outputTopicIds.has(output.topicId) || outputRevisionIds.has(output.revisionId)) {
            staleProposal("A candidate topic or revision is reused by more than one output.");
          }
          outputTopicIds.add(output.topicId);
          outputRevisionIds.add(output.revisionId);
          const page = database.connection.prepare(`
            SELECT title, slug, active_revision, lifecycle_status FROM topic_pages WHERE id = ?
          `).get(output.topicId) as { title: string; slug: string; active_revision: number; lifecycle_status: string } | undefined;
          const revision = database.connection.prepare(`
            SELECT topic_id, revision_number, author_type, prompt_version, generation_inputs_json
            FROM topic_page_revisions WHERE id = ?
          `).get(output.revisionId) as { topic_id: string; revision_number: number; author_type: string; prompt_version: string; generation_inputs_json: string } | undefined;
          if (!page || !revision
            || revision.topic_id !== output.topicId
            || revision.revision_number !== output.revision
            || revision.author_type !== "model"
            || revision.prompt_version !== "topic-shard-proposal-v1"
            || page.title !== output.title
            || page.slug !== output.slug) {
            staleProposal("A candidate page or revision identity changed after planning.");
          }
          const reusesGuardedBase = Boolean(patch.base && outputIndex === 0 && output.topicId === patch.base.topicId);
          if (output.baseRevision === null) {
            if (reusesGuardedBase) staleProposal("A replacement candidate lost its guarded base revision.");
            if (page.lifecycle_status !== "proposal" || page.active_revision !== output.revision) {
              staleProposal("A proposal-only output is no longer inactive and isolated.");
            }
          } else {
            if (!reusesGuardedBase || output.baseRevision !== patch.base!.revision) {
              staleProposal("An existing candidate output is not backed by the patch's exact base snapshot.");
            }
            if (page.lifecycle_status !== "active" || page.active_revision !== output.baseRevision || output.revision === output.baseRevision) {
              staleProposal("An existing shard changed before its candidate revision could be activated.");
            }
          }
          const candidateIndexed = database.connection.prepare(`
            SELECT 1 WHERE EXISTS (SELECT 1 FROM topic_revision_fts WHERE revision_id = ?)
              OR EXISTS (SELECT 1 FROM vectors WHERE source_id = ?)
          `).get(output.revisionId, output.revisionId);
          if (candidateIndexed) staleProposal("An inactive candidate revision leaked into a retrieval index.");
          if (output.baseRevision === null) {
            const candidatePageLeaked = database.connection.prepare(`
              SELECT 1 WHERE EXISTS (SELECT 1 FROM topic_fts WHERE topic_id = ?)
                OR EXISTS (SELECT 1 FROM topic_section_shards WHERE child_topic_id = ?)
                OR EXISTS (SELECT 1 FROM page_links WHERE source_topic_id = ? OR target_topic_id = ?)
                OR EXISTS (SELECT 1 FROM vectors WHERE source_id = ?)
            `).get(output.topicId, output.topicId, output.topicId, output.topicId, output.topicId);
            if (candidatePageLeaked) staleProposal("A proposal-only candidate page is no longer isolated.");
          } else {
            const activeSearch = database.connection.prepare(`
              SELECT fts.title, fts.content FROM topic_fts fts WHERE fts.topic_id = ?
            `).all(output.topicId) as Array<{ title: string; content: string }>;
            const activeRevision = database.connection.prepare(`
              SELECT page.title, revision.markdown FROM topic_pages page JOIN topic_page_revisions revision
                ON revision.topic_id = page.id AND revision.revision_number = page.active_revision
              WHERE page.id = ?
            `).get(output.topicId) as { title: string; markdown: string };
            if (activeSearch.length !== 1 || activeSearch[0]!.title !== activeRevision.title || activeSearch[0]!.content !== activeRevision.markdown) {
              staleProposal("An existing candidate page no longer exposes only its guarded active revision.");
            }
          }
          if (database.getTopicShardRevisionContentHash(output.revisionId) !== output.contentHash) {
            staleProposal("Candidate revision content or provenance changed after planning.");
          }
          const evidence = exactRevisionEvidence(database, output.revisionId);
          if (!sameStrings(evidence.claimIds, output.claimIds)
            || !sameStrings(evidence.sourceIds, output.sourceIds)
            || !sameStrings(evidence.evidenceIds, output.evidenceIds)) {
            staleProposal("Candidate output evidence no longer matches its normalized manifest.");
          }
          if (output.claimIds.some((claimId) => !guardedClaimIds.has(claimId))) {
            staleProposal("A rendered output claim is missing an exact state guard.");
          }
          const outputClaims = output.claimIds.map((claimId) => guardedClaims.get(claimId)).filter((claim): claim is Claim => Boolean(claim));
          const activeOutputClaims = output.claimIds.flatMap((claimId) => {
            const claim = database.getClaim(claimId, false);
            return claim ? [claim] : [];
          });
          if (activeOutputClaims.length !== output.claimIds.length
            || !sameStrings(activeOutputClaims.flatMap((claim) => claim.sourceIds), output.sourceIds)) {
            staleProposal("Candidate evidence is no longer active and complete.");
          }
          if (patch.section === "current_state" && activeOutputClaims.some((claim) => claim.status !== "current" && claim.status !== "conflicted")) {
            staleProposal("A current-state candidate now contains a non-current claim.");
          }
          if (patch.section === "history" && activeOutputClaims.some((claim) => claim.status === "current" || claim.status === "conflicted")) {
            staleProposal("A history candidate now contains a current claim.");
          }
          const sortKeys = outputClaims.map((claim) => proposalClaimSortKey(claim, patch.section)).sort();
          if (sortKeys.length !== output.claimIds.length || sortKeys.length === 0
            || output.minSortKey !== sortKeys[0] || output.maxSortKey !== sortKeys.at(-1)) {
            staleProposal("A candidate shard range no longer exactly matches its guarded claims.");
          }
          let generationInputs: Record<string, unknown> | null = null;
          try {
            const parsed = JSON.parse(revision.generation_inputs_json) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) generationInputs = parsed as Record<string, unknown>;
          } catch { generationInputs = null; }
          if (!generationInputs
            || generationInputs.activation !== "proposal"
            || generationInputs.parentTopicId !== proposal.topicId
            || generationInputs.section !== patch.section
            || generationInputs.ordinal !== output.ordinal
            || !Array.isArray(generationInputs.claimIds)
            || !generationInputs.claimIds.every((value): value is string => typeof value === "string")
            || !sameStrings(generationInputs.claimIds, output.claimIds)
            || !Array.isArray(generationInputs.sourceIds)
            || !generationInputs.sourceIds.every((value): value is string => typeof value === "string")
            || !sameStrings(generationInputs.sourceIds, output.sourceIds)) {
            staleProposal("Candidate generation inputs no longer match the normalized output manifest.");
          }
          candidateRanges.push({ section: patch.section, topicId: output.topicId, minSortKey: output.minSortKey, maxSortKey: output.maxSortKey });
          exactEvidenceByTopic.set(output.topicId, evidence.evidenceIds);
        }
      }
      const untouchedOrdinals = rows<{ section_key: string; ordinal: number; child_topic_id: string; min_sort_key: string; max_sort_key: string }>(database, `
        SELECT shard.section_key, shard.ordinal, shard.child_topic_id, shard.min_sort_key, shard.max_sort_key
        FROM topic_section_shards shard JOIN topic_pages page
          ON page.id = shard.child_topic_id AND page.lifecycle_status = 'active'
        WHERE shard.parent_topic_id = ?
      `, proposal.topicId).filter((row) => !removedBaseIds.has(row.child_topic_id));
      for (const row of untouchedOrdinals) {
        if (outputOrdinalKeys.has(`${row.section_key}\u0000${row.ordinal}`)) {
          staleProposal("A candidate ordinal now collides with an untouched active shard.");
        }
      }
      const finalRanges = [
        ...candidateRanges,
        ...untouchedOrdinals.flatMap((row) => row.section_key === "overview" ? [] : [{
          section: row.section_key,
          topicId: row.child_topic_id,
          minSortKey: row.min_sort_key,
          maxSortKey: row.max_sort_key
        }])
      ];
      for (const section of ["current_state", "history", "evidence"] as const) {
        const ordered = finalRanges.filter((range) => range.section === section)
          .sort((left, right) => left.minSortKey.localeCompare(right.minSortKey) || left.maxSortKey.localeCompare(right.maxSortKey) || left.topicId.localeCompare(right.topicId));
        for (let index = 0; index < ordered.length; index += 1) {
          const range = ordered[index]!;
          if (range.minSortKey > range.maxSortKey || (index > 0 && ordered[index - 1]!.maxSortKey >= range.minSortKey)) {
            staleProposal("Candidate shard ranges overlap or are internally inconsistent.");
          }
        }
      }

      for (const guard of proposal.claimGuards) {
        if (!changedClaimIds.has(guard.claimId) || guard.assignToTopicId === null) continue;
        database.connection.prepare("UPDATE claims SET topic_id = ? WHERE id = ?").run(guard.assignToTopicId, guard.claimId);
      }
      const archivedTopicIds: string[] = [];
      const activatedTopicIds: string[] = [];
      for (const patch of proposal.patches) {
        if (patch.base) database.connection.prepare("DELETE FROM topic_section_shards WHERE child_topic_id = ?").run(patch.base.topicId);
        if (patch.base && patch.outputs.length === 0) {
          database.connection.prepare("UPDATE topic_pages SET lifecycle_status = 'archived', updated_at = ? WHERE id = ?").run(timestamp, patch.base.topicId);
          database.connection.prepare("DELETE FROM topic_fts WHERE topic_id = ?").run(patch.base.topicId);
          database.connection.prepare("DELETE FROM vectors WHERE source_id = ?").run(patch.base.topicId);
          archivedTopicIds.push(patch.base.topicId);
        }
        for (const output of patch.outputs) {
          database.connection.prepare(`
            UPDATE topic_pages SET title = ?, slug = ?, active_revision = ?, lifecycle_status = 'active',
              tags_json = ?, updated_at = ? WHERE id = ?
          `).run(
            output.title,
            output.slug,
            output.revision,
            JSON.stringify(["auto-split", `parent:${proposal.topicId}`]),
            timestamp,
            output.topicId
          );
          database.connection.prepare(`
            INSERT INTO topic_section_shards(
              child_topic_id, parent_topic_id, section_key, ordinal, min_sort_key, max_sort_key
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(child_topic_id) DO UPDATE SET parent_topic_id = excluded.parent_topic_id,
              section_key = excluded.section_key, ordinal = excluded.ordinal,
              min_sort_key = excluded.min_sort_key, max_sort_key = excluded.max_sort_key
          `).run(output.topicId, proposal.topicId, patch.section, output.ordinal, output.minSortKey, output.maxSortKey);
          refreshTopicSearch(database, output.topicId, output.revisionId);
          activatedTopicIds.push(output.topicId);
        }
      }
      const regenerated = recomputeProtectedOverviewAndParent(database, proposal.topicId, timestamp);
      exactEvidenceByTopic.set(regenerated.overviewTopicId, regenerated.overviewEvidenceIds);
      const orderedShardIds = rebuildProtectedShardLinks({
        database,
        parentTopicId: proposal.topicId,
        touchedTopicIds: [...activatedTopicIds, regenerated.overviewTopicId],
        archivedTopicIds,
        exactEvidenceByTopic,
        timestamp
      });
      const newParentBase = database.getTopicShardParentBaseSnapshot(proposal.topicId);
      if (!newParentBase) throw new Error("Accepted protected parent failed to produce a new CAS snapshot.");
      const acceptedClaimIds = new Set(proposal.claimIds);
      const acceptedHasNewSection = new Set(proposal.patches.filter((patch) => patch.base === null).map((patch) => patch.section));
      const pendingIds = rows<{ id: string }>(database, `
        SELECT id FROM topic_shard_proposals
        WHERE parent_topic_id = ? AND status = 'pending' AND id <> ?
        ORDER BY created_at, id
      `, proposal.topicId, proposal.id);
      const stalePendingIds: string[] = [];
      for (const { id } of pendingIds) {
        const pending = database.getTopicShardProposal(id);
        if (!pending) continue;
        const overlaps = pending.claimIds.some((claimId) => acceptedClaimIds.has(claimId))
          || pending.patches.some((patch) =>
            (patch.base ? removedBaseIds.has(patch.base.topicId) : acceptedSections.has(patch.section) || acceptedHasNewSection.has(patch.section))
            || patch.routeGuards.some((route) => route.expectedBaseTopicId !== null && removedBaseIds.has(route.expectedBaseTopicId)));
        if (overlaps) {
          stalePendingIds.push(id);
        } else {
          database.connection.prepare(`
            UPDATE topic_shard_proposals SET parent_revision_id = ?, parent_revision = ?, parent_fingerprint = ?
            WHERE id = ? AND status = 'pending'
          `).run(newParentBase.revisionId, newParentBase.revision, newParentBase.fingerprint, id);
        }
      }
      database.terminalizeTopicShardProposals(stalePendingIds, "stale", timestamp);
      database.connection.prepare(`
        UPDATE topic_shard_proposals SET status = 'accepted', resolved_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(timestamp, proposal.id);
      database.pruneTerminalTopicShardProposalHeaders();
      const affectedTopicIds = [...new Set([
        proposal.topicId,
        regenerated.overviewTopicId,
        ...orderedShardIds,
        ...archivedTopicIds
      ])];
      enqueueProjectionSync(
        stableHash(`projection.sync:proposal:${proposal.id}`),
        { topicIds: affectedTopicIds, reason: "topic_shard_proposal_accept", proposalId: proposal.id }
      );
      for (const topicId of affectedTopicIds) {
        const topic = database.getTopic(topicId);
        const lifecycle = database.connection.prepare("SELECT lifecycle_status FROM topic_pages WHERE id = ?").get(topicId) as { lifecycle_status: string } | undefined;
        if (!topic || lifecycle?.lifecycle_status !== "active") continue;
        enqueueTopicEmbedding(topic);
      }
      const response = { resolved: true, action, proposalId: proposal.id, topicIds: affectedTopicIds };
      database.rememberIdempotentResponse(idempotencyKey, operation, response);
      return response;
    })();
  };
  app.get("/api/v1/memory-proposals", async (request) => {
    const query = parseQuery(PaginationSchema, request.query);
    const offset = query.cursor ?? 0;
    const page = database.connection.transaction(() => mergedPendingProposalPage(offset, query.limit))();
    return { proposals: page.items, items: page.items, nextCursor: page.nextCursor };
  });
  app.post("/api/v1/memory-proposals/:id/resolve", async (request) => {
    const { id } = TopicProposalIdParamsSchema.parse(request.params);
    const body = parseBody(ResolveTopicProposalRequestSchema, request.body);
    const operation = `memory-proposals.resolve.${id}`;
    const prior = database.idempotentResponse<Record<string, unknown>>(body.idempotencyKey, operation);
    if (prior) return prior;
    const normalizedProposal = database.getTopicShardProposal(id, true);
    if (normalizedProposal) {
      try {
        return resolveNormalizedProposal(normalizedProposal, body.action, body.idempotencyKey, operation);
      } catch (error) {
        // Exact-guard failures roll their read transaction back before landing
        // here. Terminalize in a fresh commit so a permanently dead pending
        // row cannot leak candidate revisions forever or be retried as live.
        if (error instanceof AppError && error.code === "MEMORY_PROPOSAL_STALE") {
          database.terminalizeTopicShardProposals([normalizedProposal.id], "stale", new Date().toISOString());
        }
        throw error;
      }
    }
    const pending = z.array(TopicProposalSchema).max(5_000).parse(database.getSetting<unknown[]>("memory.pendingTopicProposals", []));
    const proposal = pending.find((item) => item.id === id);
    if (!proposal) throw new AppError("MEMORY_PROPOSAL_NOT_FOUND", "That memory proposal is no longer pending.", 404);
    const legacyAcceptRequested: boolean = body.action === "accept";
    if (legacyAcceptRequested) {
      throw new AppError(
        "MEMORY_PROPOSAL_STALE",
        "This pre-v2 proposal does not contain exact claim, evidence, content, and route guards. Reject it and let Continuum compile a normalized replacement.",
        409,
        true
      );
    }
    const timestamp = new Date().toISOString();
    const response = legacyAcceptRequested ? database.connection.transaction(() => {
      const parentRevision = database.connection.prepare("SELECT topic_id, revision_number FROM topic_page_revisions WHERE id = ?")
        .get(proposal.parentRevisionId) as { topic_id: string; revision_number: number } | undefined;
      const parentPage = database.connection.prepare("SELECT active_revision FROM topic_pages WHERE id = ? AND lifecycle_status = 'active'")
        .get(proposal.topicId) as { active_revision: number } | undefined;
      if (!parentRevision || parentRevision.topic_id !== proposal.topicId || parentRevision.revision_number !== proposal.parentRevision || !parentPage) {
        throw new AppError("MEMORY_PROPOSAL_STALE", "The proposed parent revision no longer matches its memory page.", 409, true);
      }
      const expectedBase = proposal.baseRevision ?? proposal.parentRevision - 1;
      if (parentPage.active_revision !== expectedBase) throw new AppError("MEMORY_PROPOSAL_STALE", "This memory page changed after the proposal was created. Review a newly compiled proposal instead.", 409, true);
      for (const child of proposal.children) {
        const revision = database.connection.prepare("SELECT topic_id, revision_number FROM topic_page_revisions WHERE id = ?")
          .get(child.revisionId) as { topic_id: string; revision_number: number } | undefined;
        const page = database.connection.prepare("SELECT active_revision, lifecycle_status FROM topic_pages WHERE id = ?").get(child.topicId) as { active_revision: number; lifecycle_status: string } | undefined;
        if (!revision || revision.topic_id !== child.topicId || revision.revision_number !== child.revision || !page) {
          throw new AppError("MEMORY_PROPOSAL_STALE", "A proposed child revision no longer matches its memory page.", 409, true);
        }
        if (child.baseRevision !== undefined && child.baseRevision !== null && page.active_revision !== child.baseRevision) {
          throw new AppError("MEMORY_PROPOSAL_STALE", "A child memory page changed after the proposal was created.", 409, true);
        }
      }
      const topicIds = [proposal.topicId, ...proposal.children.map((child) => child.topicId)];
      const staleChildren = rows<{ id: string }>(database, `
        SELECT DISTINCT tp.id FROM topic_pages tp
        JOIN topic_page_revisions active_revision
          ON active_revision.topic_id = tp.id AND active_revision.revision_number = tp.active_revision
        WHERE tp.lifecycle_status = 'active'
          AND active_revision.author_type <> 'user'
          AND (
            EXISTS (
              SELECT 1 FROM topic_section_shards shard
              WHERE shard.parent_topic_id = ? AND shard.child_topic_id = tp.id
            )
            OR (
              EXISTS (
                SELECT 1 FROM page_links contains_link
                WHERE contains_link.source_topic_id = ? AND contains_link.target_topic_id = tp.id
                  AND contains_link.relation_type = 'contains'
              )
              AND EXISTS (
                SELECT 1 FROM page_links part_link
                WHERE part_link.source_topic_id = tp.id AND part_link.target_topic_id = ?
                  AND part_link.relation_type = 'part_of'
              )
            )
          )
          AND tp.id NOT IN (${proposal.children.length ? proposal.children.map(() => "?").join(",") : "''"})
      `, proposal.topicId, proposal.topicId, proposal.topicId, ...proposal.children.map((child) => child.topicId)).map((row) => row.id);
      for (const staleId of staleChildren) {
        database.connection.prepare("UPDATE topic_pages SET lifecycle_status = 'archived', updated_at = ? WHERE id = ?").run(timestamp, staleId);
        database.connection.prepare("DELETE FROM topic_fts WHERE topic_id = ?").run(staleId);
        database.connection.prepare("DELETE FROM vectors WHERE source_id = ? AND source_type = 'topic'").run(staleId);
        database.connection.prepare("DELETE FROM page_links WHERE source_topic_id = ? OR target_topic_id = ?").run(staleId, staleId);
      }
      database.connection.prepare("UPDATE topic_pages SET active_revision = ?, lifecycle_status = 'active', updated_at = ? WHERE id = ?")
        .run(proposal.parentRevision, timestamp, proposal.topicId);
      for (const child of proposal.children) database.connection.prepare(`
        UPDATE topic_pages SET title = ?, slug = ?, active_revision = ?, lifecycle_status = 'active',
          tags_json = ?, updated_at = ? WHERE id = ?
      `).run(child.title, child.slug, child.revision, JSON.stringify(["auto-split", `parent:${proposal.topicId}`]), timestamp, child.topicId);
      const childIds = proposal.children.map((child) => child.topicId);
      const compilerFamilyIds = [...new Set([proposal.topicId, ...childIds, ...staleChildren])];
      const familyMarks = compilerFamilyIds.map(() => "?").join(",");
      database.connection.prepare(`
        DELETE FROM page_links WHERE
          (relation_type = 'contains' AND source_topic_id = ? AND target_topic_id IN (${familyMarks}))
          OR (relation_type = 'part_of' AND target_topic_id = ? AND source_topic_id IN (${familyMarks}))
          OR (relation_type IN ('next','previous','related')
            AND source_topic_id IN (${familyMarks}) AND target_topic_id IN (${familyMarks}))
      `).run(
        proposal.topicId, ...compilerFamilyIds,
        proposal.topicId, ...compilerFamilyIds,
        ...compilerFamilyIds, ...compilerFamilyIds
      );
      for (const link of proposal.links) {
        if (link.sourceTopicId === link.targetTopicId) continue;
        const endpoints = Number((database.connection.prepare("SELECT COUNT(*) AS count FROM topic_pages WHERE id IN (?, ?)").get(link.sourceTopicId, link.targetTopicId) as { count: number }).count);
        if (endpoints !== 2) throw new AppError("MEMORY_PROPOSAL_STALE", "A related memory page no longer exists.", 409, true);
        database.connection.prepare(`
          INSERT INTO page_links(id, source_topic_id, target_topic_id, relation_type, evidence_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_topic_id, target_topic_id, relation_type)
          DO UPDATE SET evidence_json = excluded.evidence_json
        `).run(uuidv7(), link.sourceTopicId, link.targetTopicId, link.relationType, JSON.stringify([...new Set(link.evidenceIds)].sort()), timestamp);
      }
      for (const claimId of proposal.claimIds) database.connection.prepare("UPDATE claims SET topic_id = ? WHERE id = ?").run(proposal.topicId, claimId);
      for (const topicId of topicIds) {
        database.connection.prepare("DELETE FROM topic_fts WHERE topic_id = ?").run(topicId);
        database.connection.prepare(`
          INSERT INTO topic_fts(topic_id, title, content)
          SELECT tp.id, tp.title, tpr.markdown FROM topic_pages tp
          JOIN topic_page_revisions tpr ON tpr.topic_id = tp.id AND tpr.revision_number = tp.active_revision
          WHERE tp.id = ? AND tp.lifecycle_status = 'active'
        `).run(topicId);
        const revisionId = topicId === proposal.topicId ? proposal.parentRevisionId : proposal.children.find((child) => child.topicId === topicId)!.revisionId;
        database.connection.prepare("DELETE FROM topic_revision_fts WHERE revision_id = ?").run(revisionId);
        database.connection.prepare(`
          INSERT INTO topic_revision_fts(revision_id, topic_id, title, content)
          SELECT tpr.id, tpr.topic_id, tp.title, tpr.markdown FROM topic_page_revisions tpr
          JOIN topic_pages tp ON tp.id = tpr.topic_id WHERE tpr.id = ?
        `).run(revisionId);
      }
      database.setSetting("memory.pendingTopicProposals", pending.filter((item) => item.id !== proposal.id));
      const resolved = database.getSetting<Array<Record<string, unknown>>>("memory.resolvedTopicProposals", []);
      database.setSetting("memory.resolvedTopicProposals", [...resolved, { ...proposal, status: "accepted", resolvedAt: timestamp }].slice(-5_000));
      const affectedTopicIds = [...new Set([...topicIds, ...staleChildren])];
      enqueueProjectionSync(
        stableHash(`projection.sync:legacy-proposal:${proposal.id}`),
        { topicIds: affectedTopicIds, reason: "legacy_topic_proposal_accept", proposalId: proposal.id }
      );
      for (const topicId of affectedTopicIds) {
        const lifecycle = database.connection.prepare(`
          SELECT lifecycle_status FROM topic_pages WHERE id = ?
        `).get(topicId) as { lifecycle_status: string } | undefined;
        const topic = lifecycle?.lifecycle_status === "active" ? database.getTopic(topicId) : null;
        if (!topic) continue;
        enqueueTopicEmbedding(topic);
      }
      const acceptedResponse = { resolved: true as const, action: body.action, proposalId: proposal.id, topicIds: affectedTopicIds };
      database.rememberIdempotentResponse(body.idempotencyKey, operation, acceptedResponse);
      return acceptedResponse;
    })() : database.connection.transaction(() => {
      const remaining = pending.filter((item) => item.id !== proposal.id);
      const candidateRevisions = [
        { topicId: proposal.topicId, revisionId: proposal.parentRevisionId, revision: proposal.parentRevision },
        ...proposal.children.map((child) => ({ topicId: child.topicId, revisionId: child.revisionId, revision: child.revision }))
      ];
      for (const candidate of candidateRevisions) {
        const shared = remaining.some((item) => item.parentRevisionId === candidate.revisionId
          || item.children.some((child) => child.revisionId === candidate.revisionId));
        if (shared) continue;
        const page = database.connection.prepare("SELECT active_revision, lifecycle_status FROM topic_pages WHERE id = ?")
          .get(candidate.topicId) as { active_revision: number; lifecycle_status: string } | undefined;
        if (page?.lifecycle_status === "active" && page.active_revision === candidate.revision) continue;
        database.connection.prepare("DELETE FROM vectors WHERE source_id = ?").run(candidate.revisionId);
        database.connection.prepare("DELETE FROM topic_revision_fts WHERE revision_id = ?").run(candidate.revisionId);
        database.connection.prepare("DELETE FROM topic_page_revisions WHERE id = ? AND topic_id = ?")
          .run(candidate.revisionId, candidate.topicId);
      }
      for (const child of proposal.children) {
        if (child.baseRevision !== null && child.baseRevision !== undefined) continue;
        if (remaining.some((item) => item.children.some((candidate) => candidate.topicId === child.topicId))) continue;
        database.connection.prepare("DELETE FROM topic_pages WHERE id = ? AND lifecycle_status = 'proposal'").run(child.topicId);
        database.connection.prepare("DELETE FROM topic_fts WHERE topic_id = ?").run(child.topicId);
      }
      database.setSetting("memory.pendingTopicProposals", remaining);
      const resolved = database.getSetting<Array<Record<string, unknown>>>("memory.resolvedTopicProposals", []);
      database.setSetting("memory.resolvedTopicProposals", [...resolved, { ...proposal, status: "rejected", resolvedAt: timestamp }].slice(-5_000));
      const rejectedResponse = { resolved: true as const, action: body.action, proposalId: proposal.id, topicIds: [] as string[] };
      database.rememberIdempotentResponse(body.idempotencyKey, operation, rejectedResponse);
      return rejectedResponse;
    })();
    return response;
  });
  app.get("/api/v1/claims", async (request) => {
    const query = parseQuery(PaginationSchema, request.query);
    const offset = query.cursor ?? 0;
    const page = offsetPage(database.listClaims(query.limit + 1, false, offset), query.limit, offset);
    return { claims: page.items, items: page.items, nextCursor: page.nextCursor };
  });
  app.get("/api/v1/claims/:id", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const claim = database.getClaim(id, true);
    if (!claim) throw new AppError("CLAIM_NOT_FOUND", "That memory claim was not found.", 404);
    const evidence = rows<Record<string, unknown>>(database, "SELECT source_id AS sourceId, source_type AS sourceType, excerpt_hash AS excerptHash FROM claim_sources WHERE claim_id = ? ORDER BY source_id", id);
    const relations = rows<Record<string, unknown>>(database, "SELECT id, source_claim_id AS sourceClaimId, target_claim_id AS targetClaimId, relation_type AS type, confidence, created_at AS createdAt FROM claim_relations WHERE source_claim_id = ? OR target_claim_id = ? ORDER BY created_at DESC", id, id);
    return { claim, evidence, relations };
  });
  app.post("/api/v1/claims/:id/correct", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const body = parseBody(CorrectClaimRequestSchema, request.body);
    const prior = database.idempotentResponse<ReturnType<ContinuumDatabase["correctClaim"]>>(body.idempotencyKey, "claims.correct");
    if (prior) return prior;
    const existing = database.getClaim(id, true);
    if (!existing) throw new AppError("CLAIM_NOT_FOUND", "That memory claim was not found.", 404);
    const response = database.correctClaim(id, body.value, body.reason ?? "");
    if (existing.topicId) database.enqueueJob("memory.rebuild", stableHash(`memory.rebuild:claim-correction:${response.claim.id}:${existing.topicId}`), { topicIds: [existing.topicId], reason: "user_claim_correction" }, 20);
    database.rememberIdempotentResponse(body.idempotencyKey, "claims.correct", response);
    return response;
  });
  app.get("/api/v1/entities", async (request) => {
    const query = parseQuery(PaginationSchema, request.query);
    const offset = query.cursor ?? 0;
    const page = offsetPage(rows(database, "SELECT id, core_type AS type, display_name AS displayName, status, canonical_description AS description, created_at AS createdAt, updated_at AS updatedAt FROM entities ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?", query.limit + 1, offset), query.limit, offset);
    return { entities: page.items, items: page.items, nextCursor: page.nextCursor };
  });
  app.get("/api/v1/entities/merge-candidates", async (request) => {
    const query = parseQuery(EntityMergeCandidatesQuerySchema, request.query);
    const page = offsetPage(database.listEntityMergeCandidates(query.limit + 1, query.cursor), query.limit, query.cursor);
    return { candidates: page.items, items: page.items, nextCursor: page.nextCursor };
  });
  app.get("/api/v1/entities/:id", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const detail = database.entityDetail(id);
    if (!detail) throw new AppError("ENTITY_NOT_FOUND", "That memory entity was not found.", 404);
    return detail;
  });
  const entityMergeEnvelope = (sourceId: string, targetId: string) => {
    const impact = database.entityMergeImpact(sourceId, targetId);
    if (!impact) throw new AppError("ENTITY_MERGE_INVALID", "Choose two active entities of the same type.", 409);
    return { impact, confirmationToken: stableHash(`${config.sessionToken}:entity-merge:${sourceId}:${targetId}:${JSON.stringify(impact)}`) };
  };
  app.post("/api/v1/entities/merge-impact", async (request) => {
    const body = parseBody(EntityMergeImpactRequestSchema, request.body);
    return entityMergeEnvelope(body.sourceId, body.targetId);
  });
  app.post("/api/v1/entities/merge", async (request) => {
    const body = parseBody(EntityMergeRequestSchema, request.body);
    const prior = database.idempotentResponse<ReturnType<ContinuumDatabase["mergeEntities"]>>(body.idempotencyKey, "entities.merge");
    if (prior) return prior;
    const expected = entityMergeEnvelope(body.sourceId, body.targetId);
    if (body.confirmationToken !== expected.confirmationToken) throw new AppError("CONFIRMATION_MISMATCH", "The merge impact changed; review it again.", 409);
    const response = database.mergeEntities(body.sourceId, body.targetId);
    database.rememberIdempotentResponse(body.idempotencyKey, "entities.merge", response);
    return response;
  });
  app.post("/api/v1/entities/merges/:id/reverse", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const body = parseBody(EmptyMutationRequestSchema, request.body);
    const prior = database.idempotentResponse<ReturnType<ContinuumDatabase["reverseEntityMerge"]>>(body.idempotencyKey, "entities.merge.reverse");
    if (prior) return prior;
    let response: ReturnType<ContinuumDatabase["reverseEntityMerge"]>;
    try { response = database.reverseEntityMerge(id); }
    catch (error) {
      const code = String((error as { code?: unknown }).code ?? "ENTITY_MERGE_REVERSE_FAILED");
      throw new AppError(code, error instanceof Error ? error.message : "The entity merge could not be reversed.", code === "ENTITY_MERGE_CHANGED" ? 409 : 404);
    }
    database.rememberIdempotentResponse(body.idempotencyKey, "entities.merge.reverse", response);
    return response;
  });
  app.get("/api/v1/graph", async (request) => {
    const query = parseQuery(GraphQuerySchema, request.query);
    try {
      return database.graph(query.focusId, query.limit, query.hops as 1 | 2, query.history === "true");
    } catch (error) {
      if (String((error as { code?: unknown }).code) === "GRAPH_FOCUS_NOT_FOUND") {
        throw new AppError("GRAPH_FOCUS_NOT_FOUND", "That graph record was not found.", 404);
      }
      throw error;
    }
  });

  app.get("/api/v1/memories/pins", async (request) => {
    const query = parseQuery(PaginationSchema, request.query);
    const offset = query.cursor ?? 0;
    const page = offsetPage(database.listPins(query.limit + 1, offset), query.limit, offset);
    return { pins: page.items, items: page.items, nextCursor: page.nextCursor };
  });
  app.post("/api/v1/memories/pins", async (request) => {
    const body = parseBody(CreateMemoryPinRequestSchema, request.body);
    const prior = database.idempotentResponse<{ id: string }>(body.idempotencyKey, "memories.pin");
    if (prior) return prior;
    const response = { id: database.pinMemory(body.objectType, body.objectId, body.label) };
    database.rememberIdempotentResponse(body.idempotencyKey, "memories.pin", response);
    return response;
  });
  app.delete("/api/v1/memories/pins/:id", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const body = parseBody(EmptyMutationRequestSchema, request.body);
    const prior = database.idempotentResponse<{ deleted: boolean }>(body.idempotencyKey, "memories.unpin");
    if (prior) return prior;
    const response = { deleted: database.unpinMemory(id) };
    database.rememberIdempotentResponse(body.idempotencyKey, "memories.unpin", response);
    return response;
  });
  app.get("/api/v1/memories/lint", async (request) => {
    const query = parseQuery(PaginationSchema, request.query);
    const offset = query.cursor ?? 0;
    const issues = rows<{ severity: "warning" | "error"; type: string; objectId: string; subject: string }>(database, `
      SELECT 'warning' AS severity, 'conflict' AS type, c.id AS objectId, c.subject
      FROM claims c
      WHERE c.status = 'conflicted' AND EXISTS (
        SELECT 1 FROM claim_sources cs LEFT JOIN events e ON e.id = cs.source_id
        WHERE cs.claim_id = c.id AND (e.id IS NULL OR e.active = 1)
      )
      UNION ALL
      SELECT 'error' AS severity, 'missing-provenance' AS type, c.id AS objectId, c.subject
      FROM claims c LEFT JOIN claim_sources cs ON cs.claim_id = c.id
      GROUP BY c.id HAVING COUNT(cs.source_id) = 0
      ORDER BY severity, objectId
      LIMIT ? OFFSET ?
    `, query.limit + 1, offset).map((issue) => ({
      severity: issue.severity,
      type: issue.type,
      objectId: issue.objectId,
      message: issue.type === "conflict" ? `${issue.subject} has conflicting evidence.` : `${issue.subject} has no supporting source.`
    }));
    const page = offsetPage(issues, query.limit, offset);
    return { issues: page.items, items: page.items, nextCursor: page.nextCursor };
  });
  app.post("/api/v1/memories/lint", async (request) => {
    const body = parseBody(StartMemoryLintRequestSchema, request.body ?? {});
    const key = body.idempotencyKey ?? z.string().min(8).parse(request.headers["idempotency-key"]);
    const job = database.enqueueJob("memory.lint", stableHash(`memory.lint:${key}`), { manual: true }, 1);
    return { jobId: job.id };
  });
  app.get("/api/v1/memory-jobs", async (request) => {
    const query = parseQuery(RunFilterListQuerySchema, request.query);
    const offset = query.cursor ?? 0;
    const jobs = query.runId
      ? database.listJobsByTypePrefix("memory.", 501).filter((job) => job.payload.runId === query.runId).slice(offset, offset + query.limit + 1)
      : database.listJobsByTypePrefix("memory.", query.limit + 1, offset);
    const page = offsetPage(jobs, query.limit, offset);
    return { jobs: page.items, items: page.items, nextCursor: page.nextCursor };
  });
  app.post("/api/v1/memory-jobs/:id/retry", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const body = parseBody(EmptyMutationRequestSchema, request.body);
    const prior = database.idempotentResponse<{ queued: boolean }>(body.idempotencyKey, "memory-jobs.retry");
    if (prior) return prior;
    const response = { queued: database.retryJob(id) };
    database.rememberIdempotentResponse(body.idempotencyKey, "memory-jobs.retry", response);
    return response;
  });

  app.get("/api/v1/retrieval-traces", async (request) => {
    const query = parseQuery(RunFilterListQuerySchema, request.query);
    const offset = query.cursor ?? 0;
    const traceRows = query.runId
      ? rows<{ id: string }>(database, "SELECT id FROM retrieval_traces WHERE run_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?", query.runId, query.limit + 1, offset)
      : rows<{ id: string }>(database, "SELECT id FROM retrieval_traces ORDER BY created_at DESC LIMIT ? OFFSET ?", query.limit + 1, offset);
    const page = offsetPage(traceRows.map((row) => database.getRetrievalTrace(row.id)).filter((trace): trace is NonNullable<typeof trace> => Boolean(trace)), query.limit, offset);
    return { traces: page.items, items: page.items, nextCursor: page.nextCursor };
  });
  app.get("/api/v1/retrieval-traces/latest", async () => ({ trace: database.latestRetrievalTrace() }));
  app.get("/api/v1/retrieval-traces/:id", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const trace = database.getRetrievalTrace(id);
    if (!trace) throw new AppError("TRACE_NOT_FOUND", "That retrieval trace was not found.", 404);
    return trace;
  });
  app.get("/api/v1/context-packets", async (request) => {
    const query = parseQuery(RunFilterListQuerySchema, request.query);
    const offset = query.cursor ?? 0;
    const packets = query.runId
      ? rows(database, "SELECT id, run_id AS runId, budget_json AS budget, source_ids_json AS sourceIds, prompt_version AS promptVersion, content_hash AS contentHash, created_at AS createdAt FROM context_packets WHERE run_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?", query.runId, query.limit + 1, offset)
      : rows(database, "SELECT id, run_id AS runId, budget_json AS budget, source_ids_json AS sourceIds, prompt_version AS promptVersion, content_hash AS contentHash, created_at AS createdAt FROM context_packets ORDER BY created_at DESC LIMIT ? OFFSET ?", query.limit + 1, offset);
    const page = offsetPage(packets, query.limit, offset);
    return { packets: page.items, items: page.items, nextCursor: page.nextCursor };
  });
  app.get("/api/v1/model-calls", async (request) => {
    const query = parseQuery(RunFilterListQuerySchema, request.query);
    const offset = query.cursor ?? 0;
    const calls = rows(database, `
      SELECT mc.id, mc.run_id AS runId, mc.provider, mc.model, mc.purpose, mc.prompt_version AS promptVersion,
        mc.input_tokens AS inputTokens, mc.output_tokens AS outputTokens, mc.latency_ms AS latencyMs, mc.status,
        mc.trace_metadata_json AS traceMetadata, mc.created_at AS createdAt,
        COALESCE((SELECT estimated_cost_usd FROM installation_budget_ledger ibl WHERE ibl.model_call_id = mc.id LIMIT 1), bl.estimated_cost_usd, 0) AS estimatedCostUsd
      FROM model_calls mc LEFT JOIN budget_ledger bl ON bl.model_call_id = mc.id
      WHERE (? IS NULL OR mc.run_id = ?)
      ORDER BY mc.created_at DESC LIMIT ? OFFSET ?
    `, query.runId ?? null, query.runId ?? null, query.limit + 1, offset);
    const page = offsetPage(calls, query.limit, offset);
    return { calls: page.items, items: page.items, nextCursor: page.nextCursor };
  });

  app.get("/api/v1/runs/:id/debug", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    if (!database.getRun(id)) throw new AppError("RUN_NOT_FOUND", "That response run was not found.", 404);
    const decode = <T,>(value: unknown, fallback: T): T => {
      try { return JSON.parse(String(value)) as T; } catch { return fallback; }
    };
    const contextRow = rows<Record<string, unknown>>(database, `
      SELECT id, run_id AS runId, budget_json AS budget, source_ids_json AS sourceIds,
        prompt_version AS promptVersion, content_hash AS contentHash,
        composition_json AS composition, created_at AS createdAt
      FROM context_packets WHERE run_id = ? ORDER BY created_at DESC LIMIT 1
    `, id)[0];
    const contextPacket = contextRow ? (() => {
      const reconstruction = reconstructStoredContextPacket(
        database,
        decode(contextRow.composition, null),
        String(contextRow.contentHash)
      );
      const { composition: _composition, ...publicRow } = contextRow;
      void _composition;
      return {
        ...publicRow,
        budget: decode(contextRow.budget, {}),
        sourceIds: decode<string[]>(contextRow.sourceIds, []),
        renderedContent: reconstruction.renderedContent ?? "",
        reconstructionIntegrity: reconstruction.integrity,
        unavailableReferenceIds: reconstruction.unavailableReferenceIds,
        actualContentHash: reconstruction.actualContentHash
      };
    })() : null;
    const modelCalls = rows<Record<string, unknown>>(database, `
      SELECT mc.id, mc.run_id AS runId, mc.provider, mc.model, mc.purpose,
        mc.prompt_version AS promptVersion, mc.input_tokens AS inputTokens,
        mc.output_tokens AS outputTokens, mc.latency_ms AS latencyMs, mc.status,
        mc.trace_metadata_json AS traceMetadata, mc.created_at AS createdAt,
        COALESCE((SELECT estimated_cost_usd FROM installation_budget_ledger ibl WHERE ibl.model_call_id = mc.id LIMIT 1),
          (SELECT estimated_cost_usd FROM budget_ledger bl WHERE bl.model_call_id = mc.id LIMIT 1), 0) AS estimatedCostUsd
      FROM model_calls mc WHERE mc.run_id = ? ORDER BY mc.created_at ASC, mc.id ASC
    `, id).map((call) => {
      const traceMetadata = decode<Record<string, unknown>>(call.traceMetadata, {});
      return { ...call, traceMetadata, cachedInputTokens: Number(traceMetadata.cachedInputTokens ?? 0) };
    });
    const toolCalls = rows<Record<string, unknown>>(database, `
      SELECT id, run_id AS runId, tool_name AS toolName, arguments_json AS arguments,
        output_text AS output, citations_json AS citations, status,
        sandbox_json AS sandbox, started_at AS startedAt, completed_at AS completedAt
      FROM tool_executions WHERE run_id = ? ORDER BY started_at ASC, id ASC
    `, id).map((tool) => ({
      ...tool,
      arguments: decode(tool.arguments, {}),
      citations: decode(tool.citations, []),
      sandbox: decode(tool.sandbox, {})
    }));
    const promptVersions = rows<Record<string, unknown>>(database, `
      SELECT name, semantic_version AS semanticVersion, content_hash AS contentHash,
        schema_version AS schemaVersion, activated_at AS activatedAt
      FROM prompt_versions ORDER BY name ASC, semantic_version ASC
    `);
    const sourceIds = contextPacket?.sourceIds ?? [];
    const sourceDerivations = sourceIds.length ? rows<Record<string, unknown>>(database, `
      SELECT DISTINCT sc.source_id AS sourceId, sc.parser_version AS parserVersion,
        sc.chunker_version AS chunkerVersion
      FROM source_chunks sc WHERE sc.source_id IN (${sourceIds.map(() => "?").join(",")})
      ORDER BY sc.source_id, sc.parser_version, sc.chunker_version
    `, ...sourceIds) : [];
    const health = database.health();
    return {
      runId: id,
      trace: database.getRetrievalTrace(id),
      contextPacket,
      modelCalls,
      toolCalls,
      versions: {
        schemaVersion: String(health.schemaVersion),
        retrievalVersion: "retrieval-v1",
        vectorStrategy: health.vectorStrategy,
        vectorVersion: health.vectorVersion,
        promptVersions,
        modelIds: [...new Set(modelCalls.map((call) => String((call as Record<string, unknown>).model)))],
        sourceDerivations
      }
    };
  });

  app.post("/api/v1/export", async (request) => {
    const body = parseBody(ExportVaultRequestSchema, request.body);
    const prior = database.idempotentResponse<Record<string, unknown>>(body.idempotencyKey, "vault.export");
    if (prior) return prior;
    // Export is read-only. It waits for a stable run/job boundary but must not
    // silently cancel an answer the user already started.
    await beginMaintenance(request, { cancelRuns: false });
    let exported: Awaited<ReturnType<VaultMaintenance["exportBundle"]>>;
    try {
      try { exported = await maintenance.exportBundle({ includeAttachments: body.includeAttachments ?? true, includeSensitiveToolOutput: body.includeSensitiveToolOutput ?? false }, true); }
      catch (error) {
        if (error instanceof VaultExportStorageError) throw new AppError("INSUFFICIENT_EXPORT_STORAGE", error.message, 507, false, { requiredBytes: error.requiredBytes, availableBytes: error.availableBytes });
        throw error;
      }
      const response = { ...exported, downloadUrl: `/api/v1/export/${encodeURIComponent(exported.filename)}` };
      database.rememberIdempotentResponse(body.idempotencyKey, "vault.export", response);
      return response;
    } finally {
      endMaintenance(request);
    }
  });
  app.get("/api/v1/export/:filename", async (request, reply) => {
    const { filename } = ExportFilenameParamsSchema.parse(request.params);
    const opened = await maintenance.openExportDownload(filename).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (!opened) throw new AppError("EXPORT_NOT_FOUND", "That export is no longer available.", 404);
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", `attachment; filename="${basename(filename)}"`);
    reply.header("Content-Length", String(opened.size));
    try { return reply.send(opened.stream); }
    catch (error) { opened.close(); throw error; }
  });
  app.post("/api/v1/import", async (request) => {
    const idempotencyKey = IdempotencySchema.parse(request.headers["idempotency-key"]);
    const prior = database.idempotentResponse<Record<string, unknown>>(idempotencyKey, "vault.import.verify");
    if (prior) return prior;
    const uploaded = await streamVaultBundleUpload(request, config);
    try {
      if (uploaded.mode !== "verify") throw new AppError("IMPORT_VERIFICATION_REQUIRED", "Verify the selected vault once, then commit it with the returned local verification token.", 400);
      const response = await maintenance.stageVerifiedImportFile(uploaded.path);
      database.rememberIdempotentResponse(idempotencyKey, "vault.import.verify", response);
      return response;
    }
    catch (error) {
      if (error instanceof VaultBundleValidationError) throw new AppError("VAULT_BUNDLE_INVALID", error.message, 400);
      if (error instanceof VaultImportStorageError) throw new AppError("INSUFFICIENT_IMPORT_STORAGE", error.message, 507, true, { requiredBytes: error.requiredBytes, availableBytes: error.availableBytes });
      if (isRetryableVaultImportIoError(error)) {
        const capacity = isVaultImportCapacityError(error);
        throw new AppError(capacity ? "INSUFFICIENT_IMPORT_STORAGE" : "VAULT_IMPORT_IO_RETRYABLE", capacity ? "There is not enough free disk space to stage this vault safely." : "The vault could not be staged because local storage is temporarily unavailable.", capacity ? 507 : 503, true, { filesystemCode: vaultImportIoErrorCode(error) });
      }
      throw error;
    }
    finally { await unlinkIfExists(uploaded.path); }
  });
  app.post("/api/v1/import/commit", async (request) => {
    const body = parseBody(ImportVerifiedVaultRequestSchema, request.body);
    const prior = database.idempotentResponse<Record<string, unknown>>(body.idempotencyKey, "vault.import.commit");
    if (prior) return prior;
    let maintenanceStarted = false;
    try {
      await beginMaintenance(request);
      maintenanceStarted = true;
      secretGrants.clear();
      const response = await maintenance.importVerifiedToken(body.verificationToken, body.mode);
      // Machine-local authorization and raw prompt traces never cross a vault
      // replacement. Drain old trace writes before removing their files, then
      // follow the newly imported (non-portable, therefore false) consent.
      logger.setPromptTracing(database.getSetting("promptTracing.enabled", false));
      await logger.flush();
      for (const entry of await readdirNamesIfExists(config.logsDir)) {
        if (entry.endsWith(".jsonl")) await unlinkIfExists(join(config.logsDir, entry));
      }
      database.rememberIdempotentResponse(body.idempotencyKey, "vault.import.commit", response);
      return response;
    } catch (error) {
      if (error instanceof VaultBundleValidationError) throw new AppError("VAULT_BUNDLE_INVALID", error.message, 400);
      if (error instanceof VaultImportStorageError) throw new AppError("INSUFFICIENT_IMPORT_STORAGE", error.message, 507, true, { requiredBytes: error.requiredBytes, availableBytes: error.availableBytes });
      if (error instanceof VaultVerificationTokenError) {
        const status = error.code === "IN_USE" ? 409 : error.code === "INVALID" ? 400 : 410;
        throw new AppError(`VERIFIED_IMPORT_${error.code}`, error.message, status, error.code === "IN_USE");
      }
      if (isRetryableVaultImportIoError(error)) {
        const capacity = isVaultImportCapacityError(error);
        throw new AppError(capacity ? "INSUFFICIENT_IMPORT_STORAGE" : "VAULT_IMPORT_IO_RETRYABLE", capacity ? "There is not enough free disk space to commit this vault safely." : "The vault could not be committed because local storage is temporarily unavailable.", capacity ? 507 : 503, true, { filesystemCode: vaultImportIoErrorCode(error) });
      }
      throw error;
    } finally {
      if (maintenanceStarted) endMaintenance(request);
    }
  });
  const publicBackup = (record: Record<string, unknown>) => {
    const id = String(record.id ?? "");
    const persisted = id ? rows<Record<string, unknown>>(database, "SELECT created_at AS createdAt FROM backup_records WHERE id = ?", id)[0] : undefined;
    return {
      ...record,
      id,
      filename: String(record.filename ?? ""),
      kind: record.kind,
      size: Number(record.size ?? 0),
      checksum: String(record.checksum ?? ""),
      createdAt: String(record.createdAt ?? record.created_at ?? persisted?.createdAt ?? "")
    };
  };
  app.get("/api/v1/backups", async (request) => {
    const query = parseQuery(PaginationSchema, request.query);
    const offset = query.cursor ?? 0;
    const page = offsetPage(maintenance.listBackups().slice(offset, offset + query.limit + 1), query.limit, offset);
    const backups = page.items.map(publicBackup);
    return { backups, items: backups, nextCursor: page.nextCursor };
  });
  app.post("/api/v1/backups", async (request) => {
    const body = parseBody(EmptyMutationRequestSchema, request.body);
    const prior = database.idempotentResponse<Record<string, unknown>>(body.idempotencyKey, "backups.create");
    if (prior) return prior;
    const response = publicBackup(await maintenance.createBackup("manual"));
    database.rememberIdempotentResponse(body.idempotencyKey, "backups.create", response);
    return response;
  });
  app.get("/api/v1/vault", async () => ({
    vault: rows(database, "SELECT * FROM vaults LIMIT 1")[0],
    counts: {
      events: rows<Record<string, unknown>>(database, "SELECT COUNT(*) AS count FROM events")[0]?.count ?? 0,
      topics: rows<Record<string, unknown>>(database, "SELECT COUNT(*) AS count FROM topic_pages")[0]?.count ?? 0,
      claims: rows<Record<string, unknown>>(database, "SELECT COUNT(*) AS count FROM claims")[0]?.count ?? 0,
      sources: rows<Record<string, unknown>>(database, "SELECT COUNT(*) AS count FROM sources")[0]?.count ?? 0
    },
    databaseBytes: (await database.connection.pragma("page_count", { simple: true }) as number) * (await database.connection.pragma("page_size", { simple: true }) as number)
  }));

  type DeletionResource = "events" | "attachments" | "claims" | "topics";
  const dependentRunClosure = (referenceIds: readonly string[]) => {
    const runIds = new Set<string>();
    const assistantEventIds = new Set<string>();
    const visited = new Set<string>();
    const queue = [...new Set(referenceIds)];
    while (queue.length) {
      const referenceId = queue.shift()!;
      if (visited.has(referenceId)) continue;
      visited.add(referenceId);
      const escaped = referenceId.replaceAll("%", "\\%").replaceAll("_", "\\_");
      const matches = rows<{ id: string }>(database, "SELECT DISTINCT run_id AS id FROM context_packets WHERE source_ids_json LIKE ? ESCAPE '\\'", `%${escaped}%`);
      for (const match of matches) {
        if (runIds.has(match.id)) continue;
        runIds.add(match.id);
        const assistant = rows<{ id: string }>(database, "SELECT assistant_event_id AS id FROM runs WHERE id = ? AND assistant_event_id IS NOT NULL", match.id)[0];
        if (assistant) {
          assistantEventIds.add(assistant.id);
          queue.push(assistant.id);
        }
      }
    }
    return { runIds: [...runIds], assistantEventIds: [...assistantEventIds] };
  };
  const deletionImpact = (resource: DeletionResource, id: string) => {
    if (resource === "events") {
      const event = database.getEvent(id);
      if (!event) throw new AppError("EVENT_NOT_FOUND", "That event was not found.", 404);
      const directResponseIds = event.role === "user" ? rows<{ id: string }>(database, "SELECT id FROM events WHERE parent_event_id = ?", id).map((row) => row.id) : [];
      const dependent = dependentRunClosure([id]);
      const eventIds = [...new Set([id, ...directResponseIds, ...dependent.assistantEventIds])];
      const marks = eventIds.map(() => "?").join(",");
      const provenanceLinks = Number(rows<Record<string, unknown>>(database, `SELECT COUNT(*) AS count FROM claim_sources WHERE source_id IN (${marks})`, ...eventIds)[0]?.count ?? 0);
      const claimsRemoved = Number(rows<Record<string, unknown>>(database, `SELECT COUNT(*) AS count FROM claims c WHERE EXISTS (SELECT 1 FROM claim_sources own WHERE own.claim_id = c.id AND own.source_id IN (${marks})) AND NOT EXISTS (SELECT 1 FROM claim_sources other WHERE other.claim_id = c.id AND other.source_id NOT IN (${marks}))`, ...eventIds, ...eventIds)[0]?.count ?? 0);
      const claimsRetained = Math.max(0, provenanceLinks - claimsRemoved);
      const topicsRebuilt = Number(rows<Record<string, unknown>>(database, `SELECT COUNT(DISTINCT tpr.topic_id) AS count FROM page_section_sources pss JOIN topic_page_revisions tpr ON tpr.id = pss.revision_id WHERE pss.source_id IN (${marks})`, ...eventIds)[0]?.count ?? 0);
      return { events: eventIds.length, dependentRuns: dependent.runIds.length, dependentResponses: dependent.assistantEventIds.length, attachments: 0, claimsRemoved, claimsRetained, topicsRebuilt, edgesRemoved: 0, managedBackupsAffected: maintenance.listBackups().length };
    }
    if (resource === "attachments") {
      const attachment = database.getAttachment(id);
      if (!attachment) throw new AppError("ATTACHMENT_NOT_FOUND", "That attachment was not found.", 404);
      const sourceHasSibling = Boolean(database.connection.prepare(`
        SELECT 1 FROM attachments WHERE source_id = ? AND id <> ? LIMIT 1
      `).get(attachment.sourceId, id));
      const chunkIds = sourceHasSibling
        ? []
        : rows<Record<string, unknown>>(database, "SELECT id FROM source_chunks WHERE source_id = ?", attachment.sourceId).map((row) => String(row.id));
      const ownedSourceIds = sourceHasSibling ? [] : [attachment.sourceId, ...chunkIds];
      const dependent = dependentRunClosure([id, ...ownedSourceIds]);
      const evidenceIds = [...ownedSourceIds, ...dependent.assistantEventIds];
      const attachmentLinksRemoved = Number(rows<Record<string, unknown>>(database, "SELECT COUNT(*) AS count FROM event_attachments WHERE attachment_id = ?", id)[0]?.count ?? 0);
      const marks = evidenceIds.map(() => "?").join(",");
      const claimsRemoved = evidenceIds.length === 0 ? 0 : Number(rows<Record<string, unknown>>(database, `SELECT COUNT(*) AS count FROM claims c WHERE EXISTS (SELECT 1 FROM claim_sources own WHERE own.claim_id = c.id AND own.source_id IN (${marks})) AND NOT EXISTS (SELECT 1 FROM claim_sources other WHERE other.claim_id = c.id AND other.source_id NOT IN (${marks}))`, ...evidenceIds, ...evidenceIds)[0]?.count ?? 0);
      const claimsLinked = evidenceIds.length === 0 ? 0 : Number(rows<Record<string, unknown>>(database, `SELECT COUNT(DISTINCT claim_id) AS count FROM claim_sources WHERE source_id IN (${marks})`, ...evidenceIds)[0]?.count ?? 0);
      const topicsRebuilt = evidenceIds.length === 0 ? 0 : Number(rows<Record<string, unknown>>(database, `SELECT COUNT(DISTINCT tpr.topic_id) AS count FROM page_section_sources pss JOIN topic_page_revisions tpr ON tpr.id = pss.revision_id WHERE pss.source_id IN (${marks})`, ...evidenceIds)[0]?.count ?? 0);
      return { events: dependent.assistantEventIds.length, dependentRuns: dependent.runIds.length, dependentResponses: dependent.assistantEventIds.length, attachmentLinksRemoved, attachments: 1, claimsRemoved, claimsRetained: Math.max(0, claimsLinked - claimsRemoved), topicsRebuilt, edgesRemoved: 0, managedBackupsAffected: maintenance.listBackups().length };
    }
    if (resource === "claims") {
      const claim = database.getClaim(id, true);
      if (!claim) throw new AppError("CLAIM_NOT_FOUND", "That memory claim was not found.", 404);
      const evidenceImpact = (table: "edges" | "page_links") => {
        const escaped = id.replaceAll("%", "\\%").replaceAll("_", "\\_");
        const matched = rows<{ id: string; evidenceJson: string }>(database, `SELECT id, evidence_json AS evidenceJson FROM ${table} WHERE evidence_json LIKE ? ESCAPE '\\'`, `%${escaped}%`);
        const rowsRemoved = new Set<string>();
        let linksRemoved = 0;
        for (const row of matched) {
          let evidence: unknown;
          try { evidence = JSON.parse(row.evidenceJson); } catch { evidence = null; }
          if (!Array.isArray(evidence)) {
            rowsRemoved.add(row.id);
            linksRemoved += 1;
            continue;
          }
          const removed = evidence.filter((entry) => JSON.stringify(entry).includes(id)).length;
          linksRemoved += removed;
          if (removed > 0 && removed === evidence.length) rowsRemoved.add(row.id);
        }
        return { rowsRemoved, linksRemoved };
      };
      const edgeEvidence = evidenceImpact("edges");
      const directEdgeIds = rows<{ id: string }>(database, "SELECT id FROM edges WHERE source_id = ? OR target_id = ?", id, id).map((row) => row.id);
      for (const edgeId of directEdgeIds) edgeEvidence.rowsRemoved.add(edgeId);
      const pageLinkEvidence = evidenceImpact("page_links");
      const relationsRemoved = Number(rows<Record<string, unknown>>(database, "SELECT COUNT(*) AS count FROM claim_relations WHERE source_claim_id = ? OR target_claim_id = ?", id, id)[0]?.count ?? 0);
      const revisionRows = new Map<string, string>();
      for (const row of rows<{ id: string; topicId: string }>(database, `
        SELECT DISTINCT tpr.id, tpr.topic_id AS topicId FROM topic_page_revisions tpr
        JOIN page_section_sources pss ON pss.revision_id = tpr.id
        WHERE pss.claim_id = ? OR pss.source_id = ?
      `, id, id)) revisionRows.set(row.id, row.topicId);
      if (claim.topicId) {
        for (const row of rows<{ id: string; topicId: string }>(database, `
          SELECT DISTINCT tpr.id, tpr.topic_id AS topicId FROM topic_page_revisions tpr
          LEFT JOIN page_section_sources pss ON pss.revision_id = tpr.id
          WHERE tpr.topic_id = ? AND (
            tpr.author_type <> 'user' OR pss.claim_id = ? OR pss.source_id = ?
            ${claim.sourceIds.length ? `OR pss.source_id IN (${claim.sourceIds.map(() => "?").join(",")})` : ""}
          )
        `, claim.topicId, id, id, ...claim.sourceIds)) revisionRows.set(row.id, row.topicId);
      }
      const affectedTopicIds = new Set(revisionRows.values());
      if (claim.topicId) affectedTopicIds.add(claim.topicId);
      const dependent = dependentRunClosure([id]);
      return {
        events: dependent.assistantEventIds.length,
        dependentRuns: dependent.runIds.length,
        dependentResponses: dependent.assistantEventIds.length,
        attachments: 0,
        claimsRemoved: 1,
        claimsRetained: 0,
        topicsRebuilt: affectedTopicIds.size,
        edgesRemoved: edgeEvidence.rowsRemoved.size,
        edgeEvidenceLinksRemoved: edgeEvidence.linksRemoved,
        pageLinksRemoved: pageLinkEvidence.rowsRemoved.size,
        pageLinkEvidenceLinksRemoved: pageLinkEvidence.linksRemoved,
        relationsRemoved,
        pageRevisionsRemoved: revisionRows.size,
        managedBackupsAffected: maintenance.listBackups().length
      };
    }
    if (!database.getTopic(id)) throw new AppError("TOPIC_NOT_FOUND", "That topic was not found.", 404);
    const affectedTopicIds = database.topicDeletionClosureIds(id);
    const marks = affectedTopicIds.map(() => "?").join(",");
    const revisionIds = rows<{ id: string }>(database, `SELECT id FROM topic_page_revisions WHERE topic_id IN (${marks})`, ...affectedTopicIds).map((row) => row.id);
    const dependent = dependentRunClosure([...affectedTopicIds, ...revisionIds]);
    const claimsRetained = Number(rows<Record<string, unknown>>(database, `SELECT COUNT(*) AS count FROM claims WHERE topic_id IN (${marks})`, ...affectedTopicIds)[0]?.count ?? 0);
    const edgesRemoved = Number(rows<Record<string, unknown>>(database, `SELECT COUNT(*) AS count FROM edges WHERE source_id IN (${marks}) OR target_id IN (${marks})`, ...affectedTopicIds, ...affectedTopicIds)[0]?.count ?? 0);
    return { events: dependent.assistantEventIds.length, dependentRuns: dependent.runIds.length, dependentResponses: dependent.assistantEventIds.length, attachments: 0, claimsRemoved: 0, claimsRetained, topicsRebuilt: 0, topicsRemoved: affectedTopicIds.length, descendantTopicsRemoved: affectedTopicIds.length - 1, edgesRemoved, managedBackupsAffected: maintenance.listBackups().length };
  };
  const impactEnvelope = (resource: DeletionResource, id: string) => {
    const impact = deletionImpact(resource, id);
    return { ...impact, confirmationToken: stableHash(`${config.sessionToken}:${resource}:${id}:${JSON.stringify(impact)}`) };
  };

  app.get("/api/v1/events/:id/delete-impact", async (request) => {
    const { id } = IdParamsSchema.parse(request.params);
    const envelope = impactEnvelope("events", id);
    return { ...envelope, impact: { objectType: "event", objectId: id, counts: envelope, warning: "This permanently removes the original event and rebuilds any derived memory." } };
  });
  for (const resource of ["events", "attachments", "claims", "topics"] as const) {
    app.post(`/api/v1/${resource}/:id/deletion-impact`, async (request) => {
      const { id } = IdParamsSchema.parse(request.params);
      parseBody(DeletionImpactRequestSchema, request.body ?? {});
      return impactEnvelope(resource, id);
    });
    app.delete(`/api/v1/${resource}/:id`, async (request) => {
      const { id } = IdParamsSchema.parse(request.params);
      const body = parseBody(DeleteResourceRequestSchema, request.body);
      const idempotencyOperation = `deletion.${resource}`;
      const prior = database.idempotentResponse<Record<string, unknown>>(body.idempotencyKey, idempotencyOperation);
      if (prior) return prior;
      const expected = impactEnvelope(resource, id);
      if (body.confirmationToken !== expected.confirmationToken) throw new AppError("CONFIRMATION_MISMATCH", "The deletion impact changed; review it again.", 409);
      await beginMaintenance(request);
      let databaseCommitted = false;
      let recoveryComplete = false;
      try {
        let result: Record<string, unknown>;
        let operationId: string;
        let affectedTopicIds: string[] = [];
        let deletedContentHash: string | null = null;
        let deleteContentBytes = false;
        const nestedOperationIds: string[] = [];
        const apiRecovery: DeletionApiRecovery = { idempotencyKey: body.idempotencyKey, operation: idempotencyOperation };
        if (resource === "events") {
          const deleted = database.hardDeleteEvent(id, apiRecovery);
          databaseCommitted = true;
          operationId = deleted.operationId;
          nestedOperationIds.push(...deleted.nestedOperationIds);
          const { nestedOperationIds: _nested, ...publicResult } = deleted;
          void _nested;
          result = publicResult;
          affectedTopicIds = deleted.affectedTopicIds;
        } else if (resource === "attachments") {
          const deleted = database.hardDeleteAttachment(id, apiRecovery);
          databaseCommitted = true;
          operationId = deleted.operationId;
          nestedOperationIds.push(...deleted.nestedOperationIds);
          const { nestedOperationIds: _nested, ...publicResult } = deleted;
          void _nested;
          result = publicResult;
          affectedTopicIds = deleted.affectedTopicIds;
          deletedContentHash = deleted.contentHash;
          deleteContentBytes = deleted.sharedByteReferences === 0;
        } else if (resource === "claims") {
          const deleted = database.hardDeleteClaim(id, apiRecovery);
          databaseCommitted = true;
          operationId = deleted.operationId;
          nestedOperationIds.push(...deleted.nestedOperationIds);
          affectedTopicIds = deleted.affectedTopicIds;
          const { nestedOperationIds: _nested, ...publicResult } = deleted;
          void _nested;
          result = publicResult;
        } else {
          const deleted = database.hardDeleteTopic(id, apiRecovery);
          databaseCommitted = true;
          operationId = deleted.operationId;
          nestedOperationIds.push(...deleted.nestedOperationIds);
          affectedTopicIds = deleted.affectedTopicIds;
          const { nestedOperationIds: _nested, ...publicResult } = deleted;
          void _nested;
          result = publicResult;
        }
        if (deleteContentBytes && deletedContentHash) await attachmentStore.delete(deletedContentHash);
        if (affectedTopicIds.length) await syncTopicProjections(affectedTopicIds);
        enqueueDeletionMemoryRebuild(operationId, resource.slice(0, -1), affectedTopicIds);
        await maintenance.scrubManagedBackupsAfterDeletion();
        database.securePurge();
        for (const nestedOperationId of nestedOperationIds) database.completeDeletionOperation(nestedOperationId);
        database.rememberIdempotentResponse(body.idempotencyKey, idempotencyOperation, result);
        database.completeDeletionOperation(operationId);
        recoveryComplete = true;
        return result;
      } catch (error) {
        if (databaseCommitted) {
          logger.error("hard deletion requires restart recovery", { resource, objectHash: stableHash(id), error: error instanceof Error ? error.message : String(error) });
          throw new AppError("DELETION_RECOVERY_REQUIRED", "The database deletion committed, but private-file cleanup did not finish. Continuum is locked to prevent inconsistent use; restart the local app to resume cleanup safely.", 503, true);
        }
        throw error;
      } finally {
        if (!databaseCommitted || recoveryComplete) endMaintenance(request);
      }
    });
  }

  const vaultDeletionImpact = () => {
    const counts = {
      events: Number(rows<Record<string, unknown>>(database, "SELECT COUNT(*) AS count FROM events")[0]?.count ?? 0),
      attachments: Number(rows<Record<string, unknown>>(database, "SELECT COUNT(*) AS count FROM attachments")[0]?.count ?? 0),
      claimsRemoved: Number(rows<Record<string, unknown>>(database, "SELECT COUNT(*) AS count FROM claims")[0]?.count ?? 0),
      claimsRetained: 0,
      topicsRebuilt: 0,
      edgesRemoved: Number(rows<Record<string, unknown>>(database, "SELECT COUNT(*) AS count FROM edges")[0]?.count ?? 0),
      managedBackupsAffected: maintenance.listBackups().length
    };
    return { ...counts, confirmationToken: stableHash(`${config.sessionToken}:vault:${JSON.stringify(counts)}`), requiredPhrase: "DELETE MY CONTINUUM VAULT" };
  };
  app.post("/api/v1/vault/deletion-impact", async () => vaultDeletionImpact());
  app.delete("/api/v1/vault", async (request) => {
    const body = parseBody(DeleteVaultRequestSchema, request.body);
    const prior = database.idempotentResponse<{ destroyed: boolean; keyRetainedInKeychain: boolean }>(body.idempotencyKey, "vault.destroy");
    if (prior) return prior;
    const expected = vaultDeletionImpact();
    if (body.confirmationToken !== expected.confirmationToken) throw new AppError("CONFIRMATION_MISMATCH", "The vault contents changed; review the deletion impact again.", 409);
    await beginMaintenance(request);
    let recoveryRequired = false;
    let destructionComplete = false;
    try {
      await writeDurableJsonMarker(vaultDestroyMarkerPath, { format: "continuum-vault-destroy-v1", idempotencyKey: body.idempotencyKey, startedAt: new Date().toISOString() });
      recoveryRequired = true;
      const response = await completeVaultDestroy(body.idempotencyKey);
      await removeDurableMarker(vaultDestroyMarkerPath);
      recoveryRequired = false;
      destructionComplete = true;
      return response;
    } catch (error) {
      if (!recoveryRequired) {
        try { recoveryRequired = await readVaultDestroyMarker(vaultDestroyMarkerPath) !== null; }
        catch { recoveryRequired = true; }
      }
      if (recoveryRequired) {
        logger.error("whole-vault destruction requires restart recovery", { error: error instanceof Error ? error.message : String(error) });
        throw new AppError("VAULT_DESTROY_RECOVERY_REQUIRED", "Vault destruction started but could not finish every durable cleanup step. Continuum remains locked; restart the local app to resume destruction safely.", 503, true);
      }
      throw error;
    } finally {
      if (!recoveryRequired || destructionComplete) endMaintenance(request);
    }
  });

  const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url));
  if (await pathExists(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, prefix: "/", wildcard: false });
  }

  app.addHook("onClose", async () => {
    backgroundClosing = true;
    if (backupTimer) clearInterval(backupTimer);
    if (backupLaunch) clearImmediate(backupLaunch);
    maintenance.requestBackupShutdown();
    await Promise.allSettled([
      maintenance.waitForBackupShutdown(),
      ...(backupCatchUpInFlight ? [backupCatchUpInFlight] : [])
    ]);
    await logger.flush();
    database.close();
  });
  return { app, services };
}
