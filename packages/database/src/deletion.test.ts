import { access, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, stableHash, type AppConfig } from "@continuum/config";
import { ContinuumDatabase, uuidv7 } from "./index.js";

type Fixture = { root: string; config: AppConfig; database: ContinuumDatabase };
const fixtures: Fixture[] = [];

async function fixture(label: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `continuum-deletion-${label}-`));
  const config = loadConfig({ NODE_ENV: "test", CONTINUUM_DATA_DIR: root, CONTINUUM_SESSION_TOKEN: "test-session-token-that-is-at-least-32-characters" });
  const database = ContinuumDatabase.open(config);
  const value = { root, config, database };
  fixtures.push(value);
  return value;
}

function count(database: ContinuumDatabase, sql: string, ...values: unknown[]): number {
  return Number((database.connection.prepare(sql).get(...values) as { count: number }).count);
}

function getClaim(database: ContinuumDatabase, id: string) {
  return database.listClaims(1_000, true).find((claim) => claim.id === id) ?? null;
}

afterEach(async () => {
  while (fixtures.length) {
    const value = fixtures.pop()!;
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

describe("hard deletion provenance and derived-state closure", () => {
  it("hard-deletes a selected claim and immediately rebuilds its topic from independently supported claims", async () => {
    const { database } = await fixture("claim-cascade");
    const removedEvidence = database.appendEvent({ role: "user", content: "The release codename is Canary." });
    const retainedEvidence = database.appendEvent({ role: "user", content: "The release owner is Priya." });
    const topic = database.upsertTopicRevision({
      type: "project", title: "Canary Release", slug: "canary-release", markdown: "# Canary Release\n\nCodename Canary. Owner Priya.",
      summary: "Canary release", currentState: "Owner Priya", history: "", sourceIds: [removedEvidence.id, retainedEvidence.id], promptVersion: "fixture-v1"
    });
    const removed = database.upsertClaim({
      topicId: topic.id, subject: "Release", predicate: "codename", value: "Canary", confidence: 1, status: "current",
      sourceRole: "user", sourceIds: [removedEvidence.id], validFrom: null, validTo: null, observedAt: removedEvidence.createdAt, freshnessExpiresAt: null
    });
    const retained = database.upsertClaim({
      topicId: topic.id, subject: "Release", predicate: "owner", value: "Priya", confidence: 1, status: "current",
      sourceRole: "user", sourceIds: [retainedEvidence.id], validFrom: null, validTo: null, observedAt: retainedEvidence.createdAt, freshnessExpiresAt: null
    });
    database.connection.prepare("INSERT INTO claim_relations(id, source_claim_id, target_claim_id, relation_type, confidence, created_at) VALUES (?, ?, ?, 'supports', 1, ?)").run(uuidv7(), retained.id, removed.id, new Date().toISOString());
    database.connection.prepare("INSERT INTO edges(id, source_id, target_id, edge_type, status, evidence_json, created_at) VALUES (?, ?, ?, 'related', 'current', '[]', ?)").run(uuidv7(), removed.id, retained.id, new Date().toISOString());
    database.pinMemory("claim", removed.id, "Pinned codename");
    database.connection.prepare("INSERT INTO vectors(id, source_id, source_type, model_id, dimensions, content_hash, embedding_version, embedding_json, created_at) VALUES (?, ?, 'claim', 'fixture', 2, ?, 'v1', '[1,0]', ?)").run(uuidv7(), removed.id, stableHash(removed.id), new Date().toISOString());

    const result = database.hardDeleteClaim(removed.id);

    expect(result.counts).toMatchObject({ claimsRemoved: 1, provenanceLinks: 1, relationsRemoved: 1, edgesRemoved: 1, topicsRebuilt: 1, synthesizedRevision: 1 });
    expect(getClaim(database, removed.id)).toBeNull();
    expect(getClaim(database, retained.id)?.value).toBe("Priya");
    const repairedTopic = database.getTopic(topic.id);
    expect(repairedTopic?.markdown).toContain("Priya");
    expect(repairedTopic?.markdown).not.toContain("Canary");
    expect(repairedTopic?.title).not.toContain("Canary");
    expect(repairedTopic?.slug).not.toContain("canary");
    expect(count(database, "SELECT COUNT(*) AS count FROM memory_pins WHERE object_id = ?", removed.id)).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM vectors WHERE source_id = ?", removed.id)).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM claim_fts WHERE claim_id = ?", removed.id)).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM topic_fts WHERE topic_id = ? AND topic_fts MATCH 'Canary'", topic.id)).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM topic_revision_fts WHERE content MATCH 'Canary'")).toBe(0);
    const operation = database.connection.prepare("SELECT object_hash, phase, payload_json FROM deletion_operations WHERE id = ?").get(result.operationId) as { object_hash: string; phase: string; payload_json: string };
    expect(operation.object_hash).toBe(stableHash(removed.id));
    expect(operation.phase).toBe("database_complete");
    expect(JSON.parse(operation.payload_json)).toEqual({ affectedTopicIds: [topic.id], nestedOperationIds: [] });
    const receipt = database.connection.prepare("SELECT object_hash, counts_json FROM deletion_receipts WHERE id = ?").get(result.receiptId) as { object_hash: string; counts_json: string };
    expect(receipt.object_hash).toBe(stableHash(removed.id));
    expect(receipt.counts_json).not.toContain(removed.id);
    expect(receipt.counts_json).not.toContain("Canary");
    expect(database.connection.pragma("foreign_key_check")).toEqual([]);
  });

  it("purges indirect claim references while retaining relationships with independent evidence", async () => {
    const { database } = await fixture("claim-indirect-references");
    const timestamp = new Date().toISOString();
    const removedEvidence = database.appendEvent({ role: "user", content: "The private launch token is Kestrel." });
    const retainedEvidence = database.appendEvent({ role: "user", content: "The launch remains scheduled." });
    const topic = database.upsertTopicRevision({
      type: "project", title: "Launch", slug: "launch-indirect", markdown: "# Launch\n\nToken Kestrel.",
      summary: "Launch", currentState: "Scheduled", history: "", sourceIds: [removedEvidence.id], promptVersion: "fixture-v1"
    });
    const targetTopic = database.upsertTopicRevision({
      type: "concept", title: "Schedule", slug: "schedule-indirect", markdown: "# Schedule\n\nIndependent schedule.",
      summary: "Schedule", currentState: "Independent", history: "", sourceIds: [retainedEvidence.id], authorType: "user", promptVersion: "fixture-v1"
    });
    const removed = database.upsertClaim({
      topicId: topic.id, subject: "Launch", predicate: "token", value: "Kestrel", confidence: 1, status: "current",
      sourceRole: "user", sourceIds: [removedEvidence.id], validFrom: null, validTo: null, observedAt: timestamp, freshnessExpiresAt: null
    });
    database.upsertClaim({
      topicId: topic.id, subject: "Launch", predicate: "schedule", value: "confirmed", confidence: 1, status: "current",
      sourceRole: "user", sourceIds: [retainedEvidence.id], validFrom: null, validTo: null, observedAt: timestamp, freshnessExpiresAt: null
    });
    const retainedEdgeId = uuidv7();
    const removedEdgeId = uuidv7();
    database.connection.prepare("INSERT INTO edges(id, source_id, target_id, edge_type, status, evidence_json, created_at) VALUES (?, 'entity-left', 'entity-right', 'supports', 'current', ?, ?)").run(retainedEdgeId, JSON.stringify([removed.id, retainedEvidence.id]), timestamp);
    database.connection.prepare("INSERT INTO edges(id, source_id, target_id, edge_type, status, evidence_json, created_at) VALUES (?, 'entity-left', 'entity-right', 'contradicts', 'current', ?, ?)").run(removedEdgeId, JSON.stringify([removed.id]), timestamp);
    const retainedLinkId = uuidv7();
    const removedLinkId = uuidv7();
    database.connection.prepare("INSERT INTO page_links(id, source_topic_id, target_topic_id, relation_type, evidence_json, created_at) VALUES (?, ?, ?, 'related', ?, ?)").run(retainedLinkId, topic.id, targetTopic.id, JSON.stringify([removed.id, retainedEvidence.id]), timestamp);
    database.connection.prepare("INSERT INTO page_links(id, source_topic_id, target_topic_id, relation_type, evidence_json, created_at) VALUES (?, ?, ?, 'depends_on', ?, ?)").run(removedLinkId, topic.id, targetTopic.id, JSON.stringify([removed.id]), timestamp);
    database.enqueueJob("memory.compile", `claim-payload-${removed.id}`, { claimId: removed.id });
    const resultJob = database.enqueueJob("memory.compile", `claim-result-${removed.id}`, { topicId: targetTopic.id });
    database.connection.prepare("UPDATE jobs SET status = 'complete', result_json = ? WHERE id = ?").run(JSON.stringify({ claimId: removed.id }), resultJob.id);
    database.connection.prepare(`
      INSERT INTO retrieval_traces(id, run_id, query_text, classifications_json, candidates_json, selected_ids_json, token_budget_json, latency_ms, created_at)
      VALUES (?, 'claim-run', 'lookup', '[]', ?, ?, '{}', 1, ?)
    `).run(uuidv7(), JSON.stringify([{ id: removed.id, text: "Kestrel" }]), JSON.stringify([removed.id]), timestamp);
    database.connection.prepare(`
      INSERT INTO context_packets(id, run_id, budget_json, source_ids_json, prompt_version, content_hash, created_at)
      VALUES (?, 'claim-run', '{}', ?, 'v1', ?, ?)
    `).run(uuidv7(), JSON.stringify([removed.id]), stableHash(removed.id), timestamp);
    database.connection.prepare(`
      INSERT INTO tool_executions(id, run_id, tool_name, arguments_json, output_text, citations_json, status, sandbox_json, started_at, completed_at)
      VALUES (?, 'claim-run', 'get_memory', ?, 'Kestrel', ?, 'complete', ?, ?, ?)
    `).run(uuidv7(), JSON.stringify({ claimId: removed.id }), JSON.stringify([removed.id]), JSON.stringify({ sourceId: removed.id }), timestamp, timestamp);
    database.connection.prepare("INSERT INTO context_refs(id, event_id, ref_type, ref_value, metadata_json) VALUES (?, ?, 'claim', 'indirect', ?)").run(uuidv7(), retainedEvidence.id, JSON.stringify({ claimId: removed.id }));
    database.rememberIdempotentResponse(`claim-response-${removed.id}`, "fixture", { claimId: removed.id });
    database.connection.prepare("INSERT INTO merge_history(id, object_type, source_id, target_id, snapshot_json, created_at) VALUES (?, 'entity', 'left', 'right', ?, ?)").run(uuidv7(), JSON.stringify({ edgesBefore: [{ evidence_json: JSON.stringify([removed.id]) }] }), timestamp);
    database.connection.prepare("INSERT INTO merge_history(id, object_type, source_id, target_id, snapshot_json, created_at) VALUES (?, 'entity', 'safe-left', 'safe-right', '{\"safe\":true}', ?)").run(uuidv7(), timestamp);
    const entityId = uuidv7();
    database.connection.prepare("INSERT INTO entities(id, core_type, display_name, normalized_name, status, canonical_description, created_at, updated_at) VALUES (?, 'person', 'Alias owner', 'alias owner', 'active', '', ?, ?)").run(entityId, timestamp, timestamp);
    database.connection.prepare("INSERT INTO entity_aliases(id, entity_id, alias, normalized_alias, confidence, source_id, active, created_at) VALUES (?, ?, 'Kestrel', 'kestrel', 1, ?, 1, ?)").run(uuidv7(), entityId, removed.id, timestamp);

    const result = database.hardDeleteClaim(removed.id);

    expect(result.counts).toMatchObject({
      edgesRemoved: 1, edgeEvidenceLinksRemoved: 2, pageLinksRemoved: 1, pageLinkEvidenceLinksRemoved: 2,
      jobsRemoved: 2, retrievalTracesRemoved: 1, contextPacketsRemoved: 1, toolExecutionsRemoved: 1,
      contextRefsRemoved: 1, idempotencyRecordsRemoved: 1, mergeHistoryRemoved: 1, entityAliasesRemoved: 1
    });
    expect(database.connection.prepare("SELECT evidence_json FROM edges WHERE id = ?").get(retainedEdgeId)).toEqual({ evidence_json: JSON.stringify([retainedEvidence.id]) });
    expect(database.connection.prepare("SELECT 1 FROM edges WHERE id = ?").get(removedEdgeId)).toBeUndefined();
    expect(database.connection.prepare("SELECT evidence_json FROM page_links WHERE id = ?").get(retainedLinkId)).toEqual({ evidence_json: JSON.stringify([retainedEvidence.id]) });
    expect(database.connection.prepare("SELECT 1 FROM page_links WHERE id = ?").get(removedLinkId)).toBeUndefined();
    for (const [table, fields] of [
      ["jobs", "payload_json || COALESCE(result_json, '')"], ["retrieval_traces", "candidates_json || selected_ids_json"],
      ["context_packets", "source_ids_json"], ["tool_executions", "arguments_json || output_text || citations_json || sandbox_json"],
      ["context_refs", "ref_value || metadata_json"], ["idempotency_keys", "response_json"], ["merge_history", "snapshot_json"],
      ["entity_aliases", "COALESCE(source_id, '')"]
    ] as const) expect(count(database, `SELECT COUNT(*) AS count FROM ${table} WHERE ${fields} LIKE ?`, `%${removed.id}%`), table).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM merge_history")).toBe(1);
    expect(database.connection.pragma("foreign_key_check")).toEqual([]);
  });

  it("preserves an independently sourced user revision and invalidates stale topic identity and vectors", async () => {
    const { database } = await fixture("claim-user-revision");
    const removedEvidence = database.appendEvent({ role: "user", content: "The workspace codename is Canary." });
    const independentEvidence = database.appendEvent({ role: "user", content: "Keep the manually curated workspace note." });
    const initial = database.upsertTopicRevision({
      type: "project", title: "Canary Workspace", slug: "canary-workspace", markdown: "# Canary Workspace\n\nGenerated codename Canary.",
      summary: "Canary", currentState: "Generated", history: "", sourceIds: [removedEvidence.id], promptVersion: "fixture-v1"
    });
    const userRevision = database.upsertTopicRevision({
      type: "project", title: "Canary Workspace", slug: "canary-workspace", markdown: "# Workspace\n\nA manually curated independent note.",
      summary: "Manual note", currentState: "Independent", history: "", sourceIds: [independentEvidence.id], authorType: "user", promptVersion: "fixture-user-v1"
    });
    const userRevisionId = String((database.connection.prepare("SELECT id FROM topic_page_revisions WHERE topic_id = ? AND revision_number = 2").get(initial.id) as { id: string }).id);
    const generatedRevisionId = String((database.connection.prepare("SELECT id FROM topic_page_revisions WHERE topic_id = ? AND revision_number = 1").get(initial.id) as { id: string }).id);
    const claim = database.upsertClaim({
      topicId: initial.id, subject: "Workspace", predicate: "codename", value: "Canary", confidence: 1, status: "current",
      sourceRole: "user", sourceIds: [removedEvidence.id], validFrom: null, validTo: null, observedAt: removedEvidence.createdAt, freshnessExpiresAt: null
    });
    for (const sourceId of [initial.id, generatedRevisionId, userRevisionId]) {
      database.connection.prepare("INSERT INTO vectors(id, source_id, source_type, model_id, dimensions, content_hash, embedding_version, embedding_json, created_at) VALUES (?, ?, 'topic', 'fixture', 2, ?, 'v1', '[1,0]', ?)").run(uuidv7(), sourceId, stableHash(sourceId), new Date().toISOString());
    }

    const result = database.hardDeleteClaim(claim.id);

    expect(result.counts).toMatchObject({ topicRevisionsRemoved: 1, topicsRebuilt: 1, synthesizedRevision: 0, topicRemoved: 0 });
    const repaired = database.getTopic(userRevision.id);
    expect(repaired).toMatchObject({ revision: 2, userAuthored: true });
    expect(repaired?.markdown).toContain("manually curated independent note");
    expect(repaired?.title).not.toContain("Canary");
    expect(repaired?.slug).not.toContain("canary");
    expect(count(database, "SELECT COUNT(*) AS count FROM topic_page_revisions WHERE topic_id = ?", initial.id)).toBe(1);
    expect(count(database, "SELECT COUNT(*) AS count FROM vectors WHERE source_id IN (?, ?)", initial.id, generatedRevisionId)).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM vectors WHERE source_id = ?", userRevisionId)).toBe(1);
    expect(count(database, "SELECT COUNT(*) AS count FROM topic_fts WHERE topic_id = ? AND topic_fts MATCH 'Canary'", initial.id)).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM topic_revision_fts WHERE topic_id = ? AND topic_revision_fts MATCH 'Canary'", initial.id)).toBe(0);
    expect(database.connection.pragma("foreign_key_check")).toEqual([]);
  });

  it("repairs cross-topic citations and completely removes an unsupported cited topic", async () => {
    const { database } = await fixture("claim-cross-topic");
    const timestamp = new Date().toISOString();
    const claimEvidence = database.appendEvent({ role: "user", content: "Cross-topic private fact: Kestrel." });
    const inactiveEvidence = database.appendEvent({ role: "user", content: "Inactive historical evidence." });
    database.connection.prepare("UPDATE events SET active = 0 WHERE id = ?").run(inactiveEvidence.id);
    const citedTopic = database.upsertTopicRevision({
      type: "concept", title: "Kestrel Reference", slug: "kestrel-reference", markdown: "# Kestrel Reference\n\nKestrel appears here.",
      summary: "Kestrel", currentState: "Referenced", history: "", sourceIds: [claimEvidence.id], authorType: "user", promptVersion: "fixture-v1"
    });
    const targetTopic = database.upsertTopicRevision({
      type: "concept", title: "Independent Target", slug: "independent-target", markdown: "# Independent Target",
      summary: "Independent", currentState: "", history: "", sourceIds: [claimEvidence.id], authorType: "user", promptVersion: "fixture-v1"
    });
    const revisionId = String((database.connection.prepare("SELECT id FROM topic_page_revisions WHERE topic_id = ?").get(citedTopic.id) as { id: string }).id);
    const removed = database.upsertClaim({
      topicId: null, subject: "Reference", predicate: "fact", value: "Kestrel", confidence: 1, status: "current",
      sourceRole: "user", sourceIds: [claimEvidence.id], validFrom: null, validTo: null, observedAt: timestamp, freshnessExpiresAt: null
    });
    const inactiveClaim = database.upsertClaim({
      topicId: citedTopic.id, subject: "Reference", predicate: "history", value: "Dormant", confidence: 1, status: "historical",
      sourceRole: "user", sourceIds: [inactiveEvidence.id], validFrom: null, validTo: null, observedAt: timestamp, freshnessExpiresAt: null
    });
    database.connection.prepare("INSERT INTO page_section_sources(id, revision_id, section_key, start_offset, end_offset, claim_id, source_id) VALUES (?, ?, 'evidence', 0, 1, ?, ?)").run(uuidv7(), revisionId, removed.id, claimEvidence.id);
    database.pinMemory("topic", citedTopic.id, "Pinned cited topic");
    database.connection.prepare("INSERT INTO vectors(id, source_id, source_type, model_id, dimensions, content_hash, embedding_version, embedding_json, created_at) VALUES (?, ?, 'topic', 'fixture', 2, ?, 'v1', '[1,0]', ?)").run(uuidv7(), citedTopic.id, stableHash(citedTopic.id), timestamp);
    database.connection.prepare("INSERT INTO vectors(id, source_id, source_type, model_id, dimensions, content_hash, embedding_version, embedding_json, created_at) VALUES (?, ?, 'revision', 'fixture', 2, ?, 'v1', '[1,0]', ?)").run(uuidv7(), revisionId, stableHash(revisionId), timestamp);
    database.connection.prepare("INSERT INTO edges(id, source_id, target_id, edge_type, status, evidence_json, created_at) VALUES (?, ?, 'entity-other', 'related', 'current', '[]', ?)").run(uuidv7(), citedTopic.id, timestamp);
    database.connection.prepare("INSERT INTO page_links(id, source_topic_id, target_topic_id, relation_type, evidence_json, created_at) VALUES (?, ?, ?, 'related', '[]', ?)").run(uuidv7(), citedTopic.id, targetTopic.id, timestamp);

    const result = database.hardDeleteClaim(removed.id);

    expect(result.affectedTopicIds).toEqual([citedTopic.id]);
    expect(result.counts).toMatchObject({ topicRevisionsRemoved: 1, topicsRebuilt: 1, topicRemoved: 1 });
    expect(database.getTopic(citedTopic.id)).toBeNull();
    expect(database.getTopic(targetTopic.id)).not.toBeNull();
    expect(getClaim(database, inactiveClaim.id)?.topicId).toBeNull();
    for (const table of ["topic_page_revisions", "topic_fts", "topic_revision_fts"])
      expect(count(database, `SELECT COUNT(*) AS count FROM ${table} WHERE topic_id = ?`, citedTopic.id), table).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM vectors WHERE source_id IN (?, ?)", citedTopic.id, revisionId)).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM memory_pins WHERE object_id = ?", citedTopic.id)).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM edges WHERE source_id = ? OR target_id = ?", citedTopic.id, citedTopic.id)).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM page_links WHERE source_topic_id = ? OR target_topic_id = ?", citedTopic.id, citedTopic.id)).toBe(0);
    expect(database.connection.pragma("foreign_key_check")).toEqual([]);
  });

  it("retains a claim supported by another source and removes only unsupported claims", async () => {
    const { database } = await fixture("multi-source");
    const removed = database.appendEvent({ role: "user", content: "The launch color is blue." });
    const retained = database.appendEvent({ role: "user", content: "Confirming that the launch color is blue." });
    const observedAt = new Date().toISOString();
    const shared = database.upsertClaim({
      topicId: null, subject: "Launch", predicate: "color", value: "blue", confidence: 1, status: "current",
      sourceRole: "user", sourceIds: [removed.id, retained.id], validFrom: null, validTo: null, observedAt, freshnessExpiresAt: null
    });
    const unsupported = database.upsertClaim({
      topicId: null, subject: "Launch", predicate: "venue", value: "Atrium", confidence: 1, status: "current",
      sourceRole: "user", sourceIds: [removed.id], validFrom: null, validTo: null, observedAt, freshnessExpiresAt: null
    });

    const result = database.hardDeleteEvent(removed.id);

    expect(result.counts).toMatchObject({ provenanceLinks: 2, claimsRemoved: 1 });
    expect(getClaim(database, shared.id)?.value).toBe("blue");
    expect(getClaim(database, unsupported.id)).toBeNull();
    expect(database.connection.prepare("SELECT source_id FROM claim_sources WHERE claim_id = ?").all(shared.id)).toEqual([{ source_id: retained.id }]);
    expect(count(database, "SELECT COUNT(*) AS count FROM claim_fts WHERE claim_id = ?", shared.id)).toBe(1);
    expect(count(database, "SELECT COUNT(*) AS count FROM claim_fts WHERE claim_id = ?", unsupported.id)).toBe(0);
  });

  it("removes only deleted event evidence from shared edges and page links", async () => {
    const { database } = await fixture("event-shared-graph-evidence");
    const timestamp = new Date().toISOString();
    const removed = database.appendEvent({ role: "user", content: "Private event evidence." });
    const retained = database.appendEvent({ role: "user", content: "Independent event evidence." });
    const sourceTopic = database.upsertTopicRevision({
      type: "concept", title: "Source topic", slug: "event-source-topic", markdown: "# Source topic",
      summary: "Independent", currentState: "Current", history: "", sourceIds: [retained.id], authorType: "user", promptVersion: "fixture-v1"
    });
    const targetTopic = database.upsertTopicRevision({
      type: "concept", title: "Target topic", slug: "event-target-topic", markdown: "# Target topic",
      summary: "Independent", currentState: "Current", history: "", sourceIds: [retained.id], authorType: "user", promptVersion: "fixture-v1"
    });
    const unsupported = database.upsertClaim({
      topicId: null, subject: "Private", predicate: "event", value: "deleted", confidence: 1, status: "current",
      sourceRole: "user", sourceIds: [removed.id], validFrom: null, validTo: null, observedAt: timestamp, freshnessExpiresAt: null
    });
    const retainedEdgeId = uuidv7();
    const removedEdgeId = uuidv7();
    const directEdgeId = uuidv7();
    database.connection.prepare("INSERT INTO edges(id, source_id, target_id, edge_type, status, evidence_json, created_at) VALUES (?, 'entity-a', 'entity-b', 'related', 'current', ?, ?)").run(retainedEdgeId, JSON.stringify([removed.id, retained.id]), timestamp);
    database.connection.prepare("INSERT INTO edges(id, source_id, target_id, edge_type, status, evidence_json, created_at) VALUES (?, 'entity-a', 'entity-b', 'supports', 'current', ?, ?)").run(removedEdgeId, JSON.stringify([unsupported.id]), timestamp);
    database.connection.prepare("INSERT INTO edges(id, source_id, target_id, edge_type, status, evidence_json, created_at) VALUES (?, ?, 'entity-b', 'derived_from', 'current', '[]', ?)").run(directEdgeId, removed.id, timestamp);
    const retainedLinkId = uuidv7();
    const removedLinkId = uuidv7();
    database.connection.prepare("INSERT INTO page_links(id, source_topic_id, target_topic_id, relation_type, evidence_json, created_at) VALUES (?, ?, ?, 'related', ?, ?)").run(retainedLinkId, sourceTopic.id, targetTopic.id, JSON.stringify([removed.id, retained.id]), timestamp);
    database.connection.prepare("INSERT INTO page_links(id, source_topic_id, target_topic_id, relation_type, evidence_json, created_at) VALUES (?, ?, ?, 'supports', ?, ?)").run(removedLinkId, sourceTopic.id, targetTopic.id, JSON.stringify([unsupported.id]), timestamp);

    const result = database.hardDeleteEvent(removed.id);

    expect(result.counts).toMatchObject({
      claimsRemoved: 1,
      edgesRemoved: 2,
      edgeEvidenceLinksRemoved: 2,
      pageLinksRemoved: 1,
      pageLinkEvidenceLinksRemoved: 2
    });
    expect(database.connection.prepare("SELECT evidence_json FROM edges WHERE id = ?").get(retainedEdgeId)).toEqual({ evidence_json: JSON.stringify([retained.id]) });
    expect(database.connection.prepare("SELECT 1 FROM edges WHERE id IN (?, ?)").all(removedEdgeId, directEdgeId)).toEqual([]);
    expect(database.connection.prepare("SELECT evidence_json FROM page_links WHERE id = ?").get(retainedLinkId)).toEqual({ evidence_json: JSON.stringify([retained.id]) });
    expect(database.connection.prepare("SELECT 1 FROM page_links WHERE id = ?").get(removedLinkId)).toBeUndefined();
    expect(database.getTopic(sourceTopic.id)).not.toBeNull();
    expect(database.getTopic(targetTopic.id)).not.toBeNull();
    expect(database.connection.pragma("foreign_key_check")).toEqual([]);
  });

  it("deletes direct and evidence-dependent responses with every run-scoped derivative", async () => {
    const { database } = await fixture("event-cascade");
    const timestamp = new Date().toISOString();
    const user = database.appendEvent({ role: "user", content: "Private cascade canary." });
    const directRun = database.createRun(user.id, "balanced");
    const directAssistant = database.appendEvent({ role: "assistant", content: "Direct private response.", parentEventId: user.id, runId: directRun.id });
    database.connection.prepare("UPDATE runs SET assistant_event_id = ?, status = 'complete', completed_at = ? WHERE id = ?").run(directAssistant.id, timestamp, directRun.id);
    database.appendRunStreamEvent(directRun.id, { type: "run.started", runId: directRun.id });

    const independentUser = database.appendEvent({ role: "user", content: "Independent prompt that must remain." });
    const dependentRun = database.createRun(independentUser.id, "balanced");
    const dependentAssistant = database.appendEvent({ role: "assistant", content: "Response derived from the private canary.", parentEventId: independentUser.id, runId: dependentRun.id });
    database.connection.prepare("UPDATE runs SET assistant_event_id = ?, status = 'complete', completed_at = ? WHERE id = ?").run(dependentAssistant.id, timestamp, dependentRun.id);
    database.appendRunStreamEvent(dependentRun.id, { type: "run.started", runId: dependentRun.id });

    for (const runId of [directRun.id, dependentRun.id]) {
      database.connection.prepare(`
        INSERT INTO model_calls(id, run_id, provider, model, purpose, prompt_version, input_tokens, output_tokens, latency_ms, status, trace_metadata_json, created_at)
        VALUES (?, ?, 'fixture', 'fixture', 'response', 'v1', 1, 1, 1, 'complete', '{}', ?)
      `).run(`model-${runId}`, runId, timestamp);
      database.connection.prepare(`
        INSERT INTO retrieval_traces(id, run_id, query_text, classifications_json, candidates_json, selected_ids_json, token_budget_json, latency_ms, created_at)
        VALUES (?, ?, 'query', '[]', ?, ?, '{}', 1, ?)
      `).run(`trace-${runId}`, runId, JSON.stringify([{ id: user.id }]), JSON.stringify([user.id]), timestamp);
      database.connection.prepare(`
        INSERT INTO context_packets(id, run_id, budget_json, source_ids_json, prompt_version, content_hash, created_at)
        VALUES (?, ?, '{}', ?, 'v1', ?, ?)
      `).run(`context-${runId}`, runId, JSON.stringify([user.id]), stableHash(`context-${runId}`), timestamp);
      database.connection.prepare(`
        INSERT INTO tool_executions(id, run_id, tool_name, arguments_json, output_text, citations_json, status, sandbox_json, started_at, completed_at)
        VALUES (?, ?, 'search_memory', '{}', 'private', '[]', 'complete', '{}', ?, ?)
      `).run(`tool-${runId}`, runId, timestamp, timestamp);
      database.connection.prepare(`
        INSERT INTO budget_ledger(id, model_call_id, category, provider, model, input_tokens, output_tokens, estimated_cost_usd, created_at)
        VALUES (?, ?, 'development', 'fixture', 'fixture', 1, 1, 0, ?)
      `).run(`budget-${runId}`, `model-${runId}`, timestamp);
    }
    database.connection.prepare("INSERT INTO context_refs(id, event_id, ref_type, ref_value, metadata_json) VALUES (?, ?, 'event', ?, '{}')").run(uuidv7(), user.id, user.id);
    database.rememberIdempotentResponse("delete-cascade-key", "fixture", { eventId: user.id });
    database.enqueueJob("memory.compile", "delete-cascade-job", { sourceEventIds: [user.id] });
    database.connection.prepare("INSERT INTO vectors(id, source_id, source_type, model_id, dimensions, content_hash, embedding_version, embedding_json, created_at) VALUES (?, ?, 'event', 'fixture', 2, ?, 'v1', '[1,0]', ?)").run(uuidv7(), user.id, stableHash(user.id), timestamp);
    const claim = database.upsertClaim({
      topicId: null, subject: "Private", predicate: "canary", value: "cascade", confidence: 1, status: "current",
      sourceRole: "user", sourceIds: [user.id], validFrom: null, validTo: null, observedAt: timestamp, freshnessExpiresAt: null
    });

    const result = database.hardDeleteEvent(user.id);

    expect(result.counts).toMatchObject({ events: 3, dependentRuns: 2, claimsRemoved: 1 });
    expect(result.nestedOperationIds).toHaveLength(1);
    const operation = database.connection.prepare("SELECT payload_json FROM deletion_operations WHERE id = ?").get(result.operationId) as { payload_json: string };
    expect((JSON.parse(operation.payload_json) as { nestedOperationIds: string[] }).nestedOperationIds).toEqual(result.nestedOperationIds);
    for (const id of [user.id, directAssistant.id, dependentAssistant.id]) expect(database.getEvent(id)).toBeNull();
    expect(database.getEvent(independentUser.id)?.content).toContain("Independent prompt");
    for (const table of ["runs", "run_stream_events", "model_calls", "retrieval_traces", "context_packets", "tool_executions", "context_refs", "vectors"])
      expect(count(database, `SELECT COUNT(*) AS count FROM ${table}`), table).toBe(0);
    expect(getClaim(database, claim.id)).toBeNull();
    expect(count(database, "SELECT COUNT(*) AS count FROM event_fts WHERE event_id IN (?, ?, ?)", user.id, directAssistant.id, dependentAssistant.id)).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM claim_fts WHERE claim_id = ?", claim.id)).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM jobs WHERE payload_json LIKE ?", `%${user.id}%`)).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM idempotency_keys WHERE response_json LIKE ?", `%${user.id}%`)).toBe(0);
    // The portable ledger must not become a metadata shadow of a hard-deleted
    // run. Any positive installation-wide cost survives separately in the
    // non-portable, metadata-scrubbed hard-cap ledger.
    expect(database.connection.prepare("SELECT model_call_id FROM budget_ledger ORDER BY id").all()).toEqual([]);
    expect(database.connection.pragma("foreign_key_check")).toEqual([]);
  });

  it("removes unsupported generated shard pages and their compiler parent shell when source evidence is deleted", async () => {
    const { database } = await fixture("event-generated-shards");
    const timestamp = new Date().toISOString();
    const evidence = database.appendEvent({ role: "user", content: "Private sharded marker: Chartreuse." });
    const parent = database.upsertTopicRevision({
      type: "project", title: "Generated shell", slug: "generated-shell", markdown: "# Generated shell\n\nChartreuse index.",
      summary: "Chartreuse", currentState: "", history: "", sourceIds: [evidence.id], promptVersion: "compiler-v1"
    });
    const child = database.upsertTopicRevision({
      type: "project", title: "Generated shard", slug: `${parent.id}-current-state-part-1`, markdown: "# Generated shard\n\nChartreuse detail.",
      summary: "Chartreuse", currentState: "Chartreuse", history: "", tags: ["auto-split", `parent:${parent.id}`], sourceIds: [evidence.id], promptVersion: "compiler-v1"
    });
    database.rebuildTopicProjectionIndex();
    database.connection.prepare("INSERT INTO page_links(id, source_topic_id, target_topic_id, relation_type, evidence_json, created_at) VALUES (?, ?, ?, 'contains', ?, ?)")
      .run(uuidv7(), parent.id, child.id, JSON.stringify([evidence.id]), timestamp);
    const claim = database.upsertClaim({
      topicId: parent.id, subject: "Shard", predicate: "marker", value: "Chartreuse", confidence: 1, status: "current",
      sourceRole: "user", sourceIds: [evidence.id], validFrom: null, validTo: null, observedAt: timestamp, freshnessExpiresAt: null
    });

    const result = database.hardDeleteEvent(evidence.id);

    expect(result.counts).toMatchObject({ claimsRemoved: 1, topicRevisionsRemoved: 2, topicsRebuilt: 2 });
    expect(new Set(result.affectedTopicIds)).toEqual(new Set([parent.id, child.id]));
    expect(getClaim(database, claim.id)).toBeNull();
    expect(database.getTopic(parent.id)).toBeNull();
    expect(database.getTopic(child.id)).toBeNull();
    expect(count(database, "SELECT COUNT(*) AS count FROM topic_section_shards WHERE parent_topic_id = ? OR child_topic_id = ?", parent.id, child.id)).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM topic_fts WHERE topic_id IN (?, ?)", parent.id, child.id)).toBe(0);
    expect(database.connection.pragma("foreign_key_check")).toEqual([]);
  });

  it("cascades claim deletion through the answer that used it and later answers that used that answer", async () => {
    const { database } = await fixture("claim-answer-chain");
    const timestamp = new Date().toISOString();
    const evidence = database.appendEvent({ role: "user", content: "The temporary codename is Saffron." });
    const claim = database.upsertClaim({
      topicId: null,
      subject: "Project",
      predicate: "codename",
      value: "Saffron",
      confidence: 1,
      status: "current",
      sourceRole: "user",
      sourceIds: [evidence.id],
      validFrom: null,
      validTo: null,
      observedAt: timestamp,
      freshnessExpiresAt: null
    });
    const firstPrompt = database.appendEvent({ role: "user", content: "What is the codename?" });
    const firstRun = database.createRun(firstPrompt.id, "balanced");
    const firstAnswer = database.appendEvent({ role: "assistant", content: "It is Saffron.", parentEventId: firstPrompt.id, runId: firstRun.id });
    database.connection.prepare("UPDATE runs SET assistant_event_id = ?, status = 'complete' WHERE id = ?").run(firstAnswer.id, firstRun.id);
    database.saveContextPacket({ runId: firstRun.id, budget: {}, sourceIds: [claim.id], promptVersion: "v1", renderedContent: "claim" });

    const secondPrompt = database.appendEvent({ role: "user", content: "Repeat your prior answer." });
    const secondRun = database.createRun(secondPrompt.id, "balanced");
    const secondAnswer = database.appendEvent({ role: "assistant", content: "My prior answer said Saffron.", parentEventId: secondPrompt.id, runId: secondRun.id });
    database.connection.prepare("UPDATE runs SET assistant_event_id = ?, status = 'complete' WHERE id = ?").run(secondAnswer.id, secondRun.id);
    database.saveContextPacket({ runId: secondRun.id, budget: {}, sourceIds: [firstAnswer.id], promptVersion: "v1", renderedContent: "recent turn" });

    const result = database.hardDeleteClaim(claim.id);

    expect(result.counts).toMatchObject({ dependentRuns: 2, dependentResponses: 2 });
    expect(database.getEvent(evidence.id)).not.toBeNull();
    expect(database.getEvent(firstPrompt.id)).not.toBeNull();
    expect(database.getEvent(secondPrompt.id)).not.toBeNull();
    expect(database.getEvent(firstAnswer.id)).toBeNull();
    expect(database.getEvent(secondAnswer.id)).toBeNull();
    expect(database.getRun(firstRun.id)).toBeNull();
    expect(database.getRun(secondRun.id)).toBeNull();
    expect(getClaim(database, claim.id)).toBeNull();
    expect(result.nestedOperationIds).toHaveLength(2);
    for (const nestedOperationId of result.nestedOperationIds) database.completeDeletionOperation(nestedOperationId);
    database.completeDeletionOperation(result.operationId);
    expect(database.listIncompleteDeletionOperations()).toEqual([]);
    expect(database.connection.pragma("foreign_key_check")).toEqual([]);
  });

  it("precomputes and reports answers reached through claims learned from an earlier answer", async () => {
    const { database } = await fixture("claim-answer-derived-claim-chain");
    const timestamp = new Date().toISOString();
    const evidence = database.appendEvent({ role: "user", content: "The disposable codename is Ochre." });
    const originalClaim = database.upsertClaim({
      topicId: null, subject: "Project", predicate: "codename", value: "Ochre", confidence: 1, status: "current",
      sourceRole: "user", sourceIds: [evidence.id], validFrom: null, validTo: null,
      observedAt: timestamp, freshnessExpiresAt: null
    });
    const firstPrompt = database.appendEvent({ role: "user", content: "What is the codename?" });
    const firstRun = database.createRun(firstPrompt.id, "balanced");
    const firstAnswer = database.appendEvent({ role: "assistant", content: "It is Ochre.", parentEventId: firstPrompt.id, runId: firstRun.id });
    database.connection.prepare("UPDATE runs SET assistant_event_id = ?, status = 'complete' WHERE id = ?").run(firstAnswer.id, firstRun.id);
    database.saveContextPacket({ runId: firstRun.id, budget: {}, sourceIds: [originalClaim.id], promptVersion: "v1", renderedContent: "claim" });
    const learnedClaim = database.upsertClaim({
      topicId: null, subject: "Prior answer", predicate: "codename", value: "Ochre", confidence: 0.8, status: "current",
      sourceRole: "assistant", sourceIds: [firstAnswer.id], validFrom: null, validTo: null,
      observedAt: timestamp, freshnessExpiresAt: null
    });
    const secondPrompt = database.appendEvent({ role: "user", content: "What did the prior answer establish?" });
    const secondRun = database.createRun(secondPrompt.id, "balanced");
    const secondAnswer = database.appendEvent({ role: "assistant", content: "It established Ochre.", parentEventId: secondPrompt.id, runId: secondRun.id });
    database.connection.prepare("UPDATE runs SET assistant_event_id = ?, status = 'complete' WHERE id = ?").run(secondAnswer.id, secondRun.id);
    database.saveContextPacket({ runId: secondRun.id, budget: {}, sourceIds: [learnedClaim.id], promptVersion: "v1", renderedContent: "learned claim" });

    const result = database.hardDeleteClaim(originalClaim.id);

    expect(result.counts).toMatchObject({
      claimsRemoved: 2, dependentRuns: 2, dependentResponses: 2, derivedEventsRemoved: 2
    });
    expect(result.nestedOperationIds).toHaveLength(2);
    expect(database.getRun(firstRun.id)).toBeNull();
    expect(database.getRun(secondRun.id)).toBeNull();
    expect(database.getEvent(firstAnswer.id)).toBeNull();
    expect(database.getEvent(secondAnswer.id)).toBeNull();
    expect(database.getEvent(firstPrompt.id)).not.toBeNull();
    expect(database.getEvent(secondPrompt.id)).not.toBeNull();
    expect(getClaim(database, learnedClaim.id)).toBeNull();
    expect(database.connection.pragma("foreign_key_check")).toEqual([]);
  });

  it("finds production-shaped answer dependencies that cite a topic revision instead of the claim", async () => {
    const { database } = await fixture("claim-revision-packet");
    const timestamp = new Date().toISOString();
    const evidence = database.appendEvent({ role: "user", content: "The temporary launch key is Marigold." });
    const topic = database.upsertTopicRevision({
      type: "project", title: "Launch key", slug: "launch-key-revision-packet", markdown: "# Launch key\n\nMarigold.",
      summary: "Launch key", currentState: "Marigold", history: "", sourceIds: [evidence.id], promptVersion: "v1"
    });
    const revisionId = String((database.connection.prepare("SELECT id FROM topic_page_revisions WHERE topic_id = ?").get(topic.id) as { id: string }).id);
    const claim = database.upsertClaim({
      topicId: topic.id, subject: "Launch", predicate: "key", value: "Marigold", confidence: 1, status: "current",
      sourceRole: "user", sourceIds: [evidence.id], validFrom: null, validTo: null, observedAt: timestamp, freshnessExpiresAt: null
    });
    const prompt = database.appendEvent({ role: "user", content: "What is the launch key?" });
    const run = database.createRun(prompt.id, "balanced");
    const answer = database.appendEvent({ role: "assistant", content: "The launch key is Marigold.", parentEventId: prompt.id, runId: run.id });
    database.connection.prepare("UPDATE runs SET assistant_event_id = ?, status = 'complete' WHERE id = ?").run(answer.id, run.id);
    // Real packets cite the exact rendered page/revision selected by retrieval;
    // they do not necessarily duplicate every underlying claim id.
    database.saveContextPacket({ runId: run.id, budget: {}, sourceIds: [topic.id, revisionId], promptVersion: "v1", renderedContent: "rendered topic revision" });

    const result = database.hardDeleteClaim(claim.id);

    expect(result.counts).toMatchObject({ dependentRuns: 1, dependentResponses: 1 });
    expect(result.nestedOperationIds).toHaveLength(1);
    expect(database.getRun(run.id)).toBeNull();
    expect(database.getEvent(answer.id)).toBeNull();
    expect(database.getEvent(prompt.id)).not.toBeNull();
    expect(database.connection.pragma("foreign_key_check")).toEqual([]);
  });

  it("fails closed when a malformed context-packet reference contains a deleted claim", async () => {
    const { database } = await fixture("claim-malformed-packet");
    const timestamp = new Date().toISOString();
    const evidence = database.appendEvent({ role: "user", content: "The disposable phrase is Umber." });
    const claim = database.upsertClaim({
      topicId: null, subject: "Phrase", predicate: "value", value: "Umber", confidence: 1, status: "current",
      sourceRole: "user", sourceIds: [evidence.id], validFrom: null, validTo: null,
      observedAt: timestamp, freshnessExpiresAt: null
    });
    const prompt = database.appendEvent({ role: "user", content: "What is the disposable phrase?" });
    const run = database.createRun(prompt.id, "balanced");
    const answer = database.appendEvent({ role: "assistant", content: "It is Umber.", parentEventId: prompt.id, runId: run.id });
    database.connection.prepare("UPDATE runs SET assistant_event_id = ?, status = 'complete' WHERE id = ?").run(answer.id, run.id);
    database.connection.prepare(`
      INSERT INTO context_packets(id, run_id, budget_json, source_ids_json, prompt_version, content_hash, created_at)
      VALUES (?, ?, '{}', ?, 'v1', ?, ?)
    `).run(uuidv7(), run.id, `["${claim.id}"`, stableHash("malformed-packet"), timestamp);

    const result = database.hardDeleteClaim(claim.id);

    expect(result.counts).toMatchObject({ dependentRuns: 1, dependentResponses: 1 });
    expect(database.getRun(run.id)).toBeNull();
    expect(database.getEvent(answer.id)).toBeNull();
    expect(database.getEvent(prompt.id)).not.toBeNull();
    expect(database.connection.pragma("foreign_key_check")).toEqual([]);
  });

  it("purges normalized and legacy proposal snapshots plus their isolated candidate pages", async () => {
    const { database } = await fixture("claim-proposal-shadows");
    const timestamp = new Date().toISOString();
    const independent = database.appendEvent({ role: "user", content: "Keep the trusted parent page." });
    const evidence = database.appendEvent({ role: "user", content: "Private proposal marker: Vermilion." });
    const parent = database.upsertTopicRevision({
      type: "project", title: "Trusted parent", slug: "trusted-proposal-parent", markdown: "# Trusted parent\n\nIndependent.",
      summary: "Independent", currentState: "Independent", history: "", sourceIds: [independent.id], authorType: "user", promptVersion: "user-v1"
    });
    const parentRevisionId = String((database.connection.prepare("SELECT id FROM topic_page_revisions WHERE topic_id = ?").get(parent.id) as { id: string }).id);
    const claim = database.upsertClaim({
      topicId: null, subject: "Proposal", predicate: "marker", value: "Vermilion", confidence: 1, status: "current",
      sourceRole: "user", sourceIds: [evidence.id], validFrom: null, validTo: null, observedAt: timestamp, freshnessExpiresAt: null
    });

    const candidateTopicId = uuidv7();
    const candidateRevisionId = uuidv7();
    database.connection.prepare(`
      INSERT INTO topic_pages(id, core_type, slug, title, active_revision, scope_id, tags_json, lifecycle_status, created_at, updated_at, update_policy)
      VALUES (?, 'project', ?, 'Vermilion candidate', 1, 'global', '[]', 'proposal', ?, ?, 'automatic')
    `).run(candidateTopicId, `proposal-${candidateTopicId}`, timestamp, timestamp);
    database.connection.prepare(`
      INSERT INTO topic_page_revisions(id, topic_id, revision_number, markdown, summary, current_state, history,
        open_questions_json, generation_inputs_json, author_type, prompt_version, created_at)
      VALUES (?, ?, 1, '# Vermilion candidate', 'Vermilion', 'Private', '', '[]', '{}', 'model', 'topic-shard-proposal-v1', ?)
    `).run(candidateRevisionId, candidateTopicId, timestamp);
    const proposalId = uuidv7();
    database.persistTopicShardProposal({
      schemaVersion: 2,
      id: proposalId,
      groupId: uuidv7(),
      kind: "topic_shard_patch",
      topicId: parent.id,
      title: "Vermilion normalized proposal",
      parentBase: { revisionId: parentRevisionId, revision: 1, fingerprint: "parent-fingerprint" },
      patches: [{
        section: "current_state",
        base: null,
        routeGuards: [{ claimId: claim.id, sortKey: `${timestamp}\u0000${claim.id}`, expectedBaseTopicId: null }],
        outputs: [{
          topicId: candidateTopicId,
          revisionId: candidateRevisionId,
          revision: 1,
          baseRevision: null,
          title: "Vermilion candidate",
          slug: `proposal-${candidateTopicId}`,
          ordinal: 1,
          minSortKey: `${timestamp}\u0000${claim.id}`,
          maxSortKey: `${timestamp}\u0000${claim.id}`,
          claimIds: [claim.id],
          sourceIds: [evidence.id],
          evidenceIds: [evidence.id],
          contentHash: stableHash("Vermilion candidate")
        }]
      }],
      claimGuards: [{ claimId: claim.id, expectedTopicId: null, stateHash: "claim-state", projectedTopicId: parent.id, assignToTopicId: parent.id }],
      claimIds: [claim.id],
      sourceIds: [evidence.id],
      requiresConfirmation: true,
      status: "pending",
      createdAt: timestamp
    } as Parameters<ContinuumDatabase["persistTopicShardProposal"]>[0]);
    const legacyRevisionId = uuidv7();
    database.connection.prepare(`
      INSERT INTO topic_page_revisions(id, topic_id, revision_number, markdown, summary, current_state, history,
        open_questions_json, generation_inputs_json, author_type, prompt_version, created_at)
      VALUES (?, ?, 2, '# Vermilion legacy proposal', 'Vermilion', 'Private', '', '[]', '{}', 'model', 'topic-proposal-v1', ?)
    `).run(legacyRevisionId, parent.id, timestamp);
    database.setSetting("memory.resolvedTopicProposals", [{
      id: uuidv7(), topicId: parent.id, title: "Vermilion legacy proposal", parentRevisionId: legacyRevisionId,
      parentRevision: 2, claimIds: [claim.id], sourceIds: [evidence.id], children: [], status: "rejected"
    }]);

    const result = database.hardDeleteClaim(claim.id);

    expect(result.counts).toMatchObject({ proposalsRemoved: 2, proposalRevisionsRemoved: 2, proposalTopicsRemoved: 1 });
    expect(database.getTopic(parent.id)?.markdown).toContain("Independent");
    expect(database.getTopic(candidateTopicId)).toBeNull();
    expect(count(database, "SELECT COUNT(*) AS count FROM topic_page_revisions WHERE id IN (?, ?)", candidateRevisionId, legacyRevisionId)).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM topic_shard_proposals WHERE id = ?", proposalId)).toBe(0);
    expect(database.getSetting("memory.resolvedTopicProposals", [])).toEqual([]);
    expect(count(database, "SELECT COUNT(*) AS count FROM settings WHERE value_json LIKE ?", `%${claim.id}%`)).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM topic_revision_fts WHERE content MATCH 'Vermilion'")).toBe(0);
    expect(database.connection.pragma("foreign_key_check")).toEqual([]);
  });

  it("keeps shared CAS bytes until the final logical attachment reference is deleted", async () => {
    const { database, config } = await fixture("logical-attachments");
    const bytes = Buffer.from("deduplicated attachment bytes");
    const hash = stableHash(bytes);
    const storagePath = join(config.attachmentsDir, hash.slice(0, 2), hash);
    await mkdir(join(config.attachmentsDir, hash.slice(0, 2)), { recursive: true, mode: 0o700 });
    await writeFile(storagePath, bytes, { mode: 0o600 });
    const hasBytes = async () => access(storagePath).then(() => true, () => false);
    const makeAttachment = (suffix: string) => {
      const sourceId = database.createSource({ type: "attachment", title: `Copy ${suffix}`, contentHash: hash });
      return database.createAttachment({ sourceId, filename: `${suffix}.txt`, mediaType: "text/plain", size: bytes.byteLength, storagePath, contentHash: hash, status: "ready" });
    };
    const first = makeAttachment("first");
    const second = makeAttachment("second");
    const observedAt = new Date().toISOString();
    const claim = database.upsertClaim({
      topicId: null, subject: "Document", predicate: "hash", value: hash, confidence: 1, status: "current",
      sourceRole: "user", sourceIds: [first.sourceId, second.sourceId], validFrom: null, validTo: null, observedAt, freshnessExpiresAt: null
    });

    const firstDeletion = database.hardDeleteAttachment(first.id);
    if (firstDeletion.sharedByteReferences === 0) await unlink(storagePath).catch(() => undefined);
    expect(firstDeletion.sharedByteReferences).toBe(1);
    await expect(hasBytes()).resolves.toBe(true);
    expect(database.getAttachment(second.id)).not.toBeNull();
    expect(getClaim(database, claim.id)).not.toBeNull();

    const secondDeletion = database.hardDeleteAttachment(second.id);
    if (secondDeletion.sharedByteReferences === 0) await unlink(storagePath).catch(() => undefined);
    expect(secondDeletion.sharedByteReferences).toBe(0);
    await expect(hasBytes()).resolves.toBe(false);
    expect(getClaim(database, claim.id)).toBeNull();
  });

  it("preserves a source, its chunks, and its claims while a sibling attachment still owns it", async () => {
    const { database, config } = await fixture("shared-attachment-source");
    const contentHash = stableHash("shared attachment source");
    const sourceId = database.createSource({ type: "attachment", title: "Shared logical source", contentHash });
    const [chunkId] = database.addSourceChunks(sourceId, [{ text: "Shared source evidence." }]);
    const storagePath = join(config.attachmentsDir, "shared-source.txt");
    const first = database.createAttachment({
      sourceId, filename: "first.txt", mediaType: "text/plain", size: 22, storagePath, contentHash, status: "ready"
    });
    const second = database.createAttachment({
      sourceId, filename: "second.txt", mediaType: "text/plain", size: 22, storagePath, contentHash, status: "ready"
    });
    const claim = database.upsertClaim({
      topicId: null, subject: "Shared source", predicate: "state", value: "retained", confidence: 1, status: "current",
      sourceRole: "user", sourceIds: [sourceId], validFrom: null, validTo: null,
      observedAt: new Date().toISOString(), freshnessExpiresAt: null
    });

    const firstDeletion = database.hardDeleteAttachment(first.id);

    expect(firstDeletion.sharedByteReferences).toBe(1);
    expect(firstDeletion.counts).toMatchObject({ attachments: 1, chunks: 0, provenanceLinks: 0, claimsRemoved: 0 });
    expect(database.getAttachment(first.id)).toBeNull();
    expect(database.getAttachment(second.id)).not.toBeNull();
    expect(database.connection.prepare("SELECT 1 FROM sources WHERE id = ?").get(sourceId)).toBeDefined();
    expect(database.connection.prepare("SELECT 1 FROM source_chunks WHERE id = ?").get(chunkId)).toBeDefined();
    expect(getClaim(database, claim.id)).not.toBeNull();

    const secondDeletion = database.hardDeleteAttachment(second.id);

    expect(secondDeletion.sharedByteReferences).toBe(0);
    expect(secondDeletion.counts).toMatchObject({ attachments: 1, chunks: 1, provenanceLinks: 1, claimsRemoved: 1 });
    expect(database.connection.prepare("SELECT 1 FROM sources WHERE id = ?").get(sourceId)).toBeUndefined();
    expect(database.connection.prepare("SELECT 1 FROM source_chunks WHERE id = ?").get(chunkId)).toBeUndefined();
    expect(getClaim(database, claim.id)).toBeNull();
    expect(database.connection.pragma("foreign_key_check")).toEqual([]);
  });

  it("removes an answer and compiled memory derived from a hard-deleted attachment while retaining the prompt", async () => {
    const { database, config } = await fixture("attachment-derived-response");
    const timestamp = new Date().toISOString();
    const contentHash = stableHash("private attachment body");
    const sourceId = database.createSource({ type: "attachment", title: "Private notes", contentHash });
    const attachment = database.createAttachment({
      sourceId,
      filename: "private.txt",
      mediaType: "text/plain",
      size: 23,
      storagePath: join(config.attachmentsDir, "private.txt"),
      contentHash,
      status: "ready"
    });
    database.addSourceChunks(sourceId, [{ text: "Private launch word: heliotrope." }]);
    const user = database.appendEvent({ role: "user", content: "What does my attachment say?", attachmentIds: [attachment.id] });
    const run = database.createRun(user.id, "balanced");
    const assistant = database.appendEvent({
      role: "assistant",
      content: "The private launch word is heliotrope.",
      parentEventId: user.id,
      runId: run.id
    });
    database.connection.prepare("UPDATE runs SET assistant_event_id = ?, status = 'complete', completed_at = ? WHERE id = ?").run(assistant.id, timestamp, run.id);
    database.saveContextPacket({
      runId: run.id,
      budget: {},
      sourceIds: [attachment.id, sourceId],
      promptVersion: "response-v1",
      renderedContent: "private attachment evidence"
    });
    const derivedClaim = database.upsertClaim({
      topicId: null,
      subject: "Launch",
      predicate: "word",
      value: "heliotrope",
      confidence: 0.8,
      status: "current",
      sourceRole: "assistant",
      sourceIds: [assistant.id],
      validFrom: null,
      validTo: null,
      observedAt: timestamp,
      freshnessExpiresAt: null
    });
    const followup = database.appendEvent({ role: "user", content: "Repeat that answer without reopening the file." });
    const followupRun = database.createRun(followup.id, "balanced");
    const followupAnswer = database.appendEvent({
      role: "assistant",
      content: "The prior answer said heliotrope.",
      parentEventId: followup.id,
      runId: followupRun.id
    });
    database.connection.prepare("UPDATE runs SET assistant_event_id = ?, status = 'complete', completed_at = ? WHERE id = ?").run(followupAnswer.id, timestamp, followupRun.id);
    database.saveContextPacket({ runId: followupRun.id, budget: {}, sourceIds: [assistant.id], promptVersion: "response-v1", renderedContent: "recent answer" });

    const derivedTopic = database.upsertTopicRevision({
      type: "project", title: "Attachment-derived memory", slug: "attachment-derived-memory", markdown: "# Attachment-derived memory\n\nHeliotrope.",
      summary: "Heliotrope", currentState: "Heliotrope", history: "", sourceIds: [assistant.id], promptVersion: "compiler-v1"
    });
    database.connection.prepare("UPDATE claims SET topic_id = ? WHERE id = ?").run(derivedTopic.id, derivedClaim.id);

    const result = database.hardDeleteAttachment(attachment.id, { idempotencyKey: "attachment-private-path", operation: "deletion.attachments" });

    expect(result.counts).toMatchObject({ dependentRuns: 2, dependentResponses: 2, claimsRemoved: 1 });
    expect(result.nestedOperationIds).toHaveLength(2);
    expect(result.affectedTopicIds).toContain(derivedTopic.id);
    expect(result).not.toHaveProperty("storagePath");
    expect(database.getEvent(user.id)?.content).toBe("What does my attachment say?");
    expect(database.getEvent(followup.id)?.content).toContain("Repeat that answer");
    expect(database.getEvent(assistant.id)).toBeNull();
    expect(database.getEvent(followupAnswer.id)).toBeNull();
    expect(database.getRun(run.id)).toBeNull();
    expect(database.getRun(followupRun.id)).toBeNull();
    expect(getClaim(database, derivedClaim.id)).toBeNull();
    expect(database.getTopic(derivedTopic.id)).toBeNull();
    expect(database.getAttachment(attachment.id)).toBeNull();
    expect(count(database, "SELECT COUNT(*) AS count FROM context_packets WHERE run_id = ?", run.id)).toBe(0);
    const operation = database.connection.prepare("SELECT payload_json FROM deletion_operations WHERE id = ?").get(result.operationId) as { payload_json: string };
    const recoveryPayload = JSON.parse(operation.payload_json) as { nestedOperationIds: string[]; affectedTopicIds: string[]; apiRecovery: { response: Record<string, unknown> } };
    expect(recoveryPayload.nestedOperationIds).toHaveLength(2);
    expect(recoveryPayload.affectedTopicIds).toContain(derivedTopic.id);
    expect(recoveryPayload.apiRecovery.response).not.toHaveProperty("storagePath");
    expect(operation.payload_json).not.toContain(config.attachmentsDir);
    expect(database.connection.pragma("foreign_key_check")).toEqual([]);
  });

  it("removes only deleted attachment evidence from shared edges and page links", async () => {
    const { database, config } = await fixture("attachment-shared-graph-evidence");
    const timestamp = new Date().toISOString();
    const retained = database.appendEvent({ role: "user", content: "Independent graph evidence." });
    const sourceId = database.createSource({ type: "attachment", title: "Private attachment", contentHash: stableHash("private-attachment") });
    const attachment = database.createAttachment({
      sourceId,
      filename: "private.txt",
      mediaType: "text/plain",
      size: 7,
      storagePath: join(config.attachmentsDir, "private.txt"),
      contentHash: stableHash("private-attachment"),
      status: "ready"
    });
    const [chunkId] = database.addSourceChunks(sourceId, [{ text: "private chunk" }]);
    const sourceTopic = database.upsertTopicRevision({
      type: "concept", title: "Source topic", slug: "attachment-source-topic", markdown: "# Source topic",
      summary: "Independent", currentState: "Current", history: "", sourceIds: [retained.id], authorType: "user", promptVersion: "fixture-v1"
    });
    const targetTopic = database.upsertTopicRevision({
      type: "concept", title: "Target topic", slug: "attachment-target-topic", markdown: "# Target topic",
      summary: "Independent", currentState: "Current", history: "", sourceIds: [retained.id], authorType: "user", promptVersion: "fixture-v1"
    });
    const unsupported = database.upsertClaim({
      topicId: null, subject: "Private", predicate: "attachment", value: "deleted", confidence: 1, status: "current",
      sourceRole: "user", sourceIds: [sourceId], validFrom: null, validTo: null, observedAt: timestamp, freshnessExpiresAt: null
    });
    const retainedEdgeId = uuidv7();
    const chunkEdgeId = uuidv7();
    const claimEdgeId = uuidv7();
    const directEdgeId = uuidv7();
    database.connection.prepare("INSERT INTO edges(id, source_id, target_id, edge_type, status, evidence_json, created_at) VALUES (?, 'entity-a', 'entity-b', 'related', 'current', ?, ?)").run(retainedEdgeId, JSON.stringify([sourceId, retained.id]), timestamp);
    database.connection.prepare("INSERT INTO edges(id, source_id, target_id, edge_type, status, evidence_json, created_at) VALUES (?, 'entity-a', 'entity-b', 'supports', 'current', ?, ?)").run(chunkEdgeId, JSON.stringify([chunkId]), timestamp);
    database.connection.prepare("INSERT INTO edges(id, source_id, target_id, edge_type, status, evidence_json, created_at) VALUES (?, 'entity-a', 'entity-b', 'contradicts', 'current', ?, ?)").run(claimEdgeId, JSON.stringify([unsupported.id]), timestamp);
    database.connection.prepare("INSERT INTO edges(id, source_id, target_id, edge_type, status, evidence_json, created_at) VALUES (?, ?, 'entity-b', 'derived_from', 'current', '[]', ?)").run(directEdgeId, sourceId, timestamp);
    const retainedLinkId = uuidv7();
    const removedLinkId = uuidv7();
    database.connection.prepare("INSERT INTO page_links(id, source_topic_id, target_topic_id, relation_type, evidence_json, created_at) VALUES (?, ?, ?, 'related', ?, ?)").run(retainedLinkId, sourceTopic.id, targetTopic.id, JSON.stringify([chunkId, retained.id]), timestamp);
    database.connection.prepare("INSERT INTO page_links(id, source_topic_id, target_topic_id, relation_type, evidence_json, created_at) VALUES (?, ?, ?, 'supports', ?, ?)").run(removedLinkId, sourceTopic.id, targetTopic.id, JSON.stringify([unsupported.id]), timestamp);

    const result = database.hardDeleteAttachment(attachment.id);

    expect(result.counts).toMatchObject({
      claimsRemoved: 1,
      edgesRemoved: 3,
      edgeEvidenceLinksRemoved: 3,
      pageLinksRemoved: 1,
      pageLinkEvidenceLinksRemoved: 2
    });
    expect(database.connection.prepare("SELECT evidence_json FROM edges WHERE id = ?").get(retainedEdgeId)).toEqual({ evidence_json: JSON.stringify([retained.id]) });
    expect(database.connection.prepare("SELECT id FROM edges WHERE id IN (?, ?, ?) ORDER BY id").all(chunkEdgeId, claimEdgeId, directEdgeId)).toEqual([]);
    expect(database.connection.prepare("SELECT evidence_json FROM page_links WHERE id = ?").get(retainedLinkId)).toEqual({ evidence_json: JSON.stringify([retained.id]) });
    expect(database.connection.prepare("SELECT 1 FROM page_links WHERE id = ?").get(removedLinkId)).toBeUndefined();
    expect(database.getTopic(sourceTopic.id)).not.toBeNull();
    expect(database.getTopic(targetTopic.id)).not.toBeNull();
    expect(database.connection.pragma("foreign_key_check")).toEqual([]);
  });

  it("purges active and historical topic search state while retaining detached claims", async () => {
    const { database } = await fixture("topic-history");
    const event = database.appendEvent({ role: "user", content: "Topic evidence." });
    const first = database.upsertTopicRevision({
      type: "project", title: "Secret Project", slug: "secret-project", markdown: "# Secret Project\n\nHistorical canary.",
      summary: "Historical", currentState: "Old", history: "", sourceIds: [event.id], promptVersion: "v1"
    });
    const firstRevision = String((database.connection.prepare("SELECT id FROM topic_page_revisions WHERE topic_id = ? AND revision_number = 1").get(first.id) as { id: string }).id);
    const current = database.upsertTopicRevision({
      type: "project", title: "Secret Project", slug: "secret-project", markdown: "# Secret Project\n\nCurrent canary.",
      summary: "Current", currentState: "New", history: "Historical canary.", sourceIds: [event.id], promptVersion: "v2"
    });
    const revisions = database.connection.prepare("SELECT id FROM topic_page_revisions WHERE topic_id = ? ORDER BY revision_number").all(current.id) as Array<{ id: string }>;
    const other = database.upsertTopicRevision({
      type: "concept", title: "Other Topic", slug: "other-topic", markdown: "# Other Topic", summary: "Other", currentState: "", history: "", sourceIds: [event.id], promptVersion: "v1"
    });
    const claim = database.upsertClaim({
      topicId: current.id, subject: "Project", predicate: "state", value: "secret", confidence: 1, status: "current",
      sourceRole: "user", sourceIds: [event.id], validFrom: null, validTo: null, observedAt: event.createdAt, freshnessExpiresAt: null
    });
    database.pinMemory("topic", current.id, "Pinned secret");
    database.connection.prepare("INSERT INTO edges(id, source_id, target_id, edge_type, status, evidence_json, created_at) VALUES (?, ?, ?, 'related', 'current', '[]', ?)").run(uuidv7(), current.id, claim.id, new Date().toISOString());
    database.connection.prepare("INSERT INTO page_links(id, source_topic_id, target_topic_id, relation_type, evidence_json, created_at) VALUES (?, ?, ?, 'related', '[]', ?)").run(uuidv7(), current.id, other.id, new Date().toISOString());
    for (const sourceId of [current.id, ...revisions.map((row) => row.id)]) {
      database.connection.prepare("INSERT INTO vectors(id, source_id, source_type, model_id, dimensions, content_hash, embedding_version, embedding_json, created_at) VALUES (?, ?, 'topic', 'fixture', 2, ?, 'v1', '[1,0]', ?)").run(uuidv7(), sourceId, stableHash(sourceId), new Date().toISOString());
    }
    expect(count(database, "SELECT COUNT(*) AS count FROM topic_fts WHERE topic_id = ?", current.id)).toBe(1);
    expect(count(database, "SELECT COUNT(*) AS count FROM topic_revision_fts WHERE topic_id = ?", current.id)).toBe(2);

    const result = database.hardDeleteTopic(current.id);

    expect(result.counts).toMatchObject({ topics: 1, revisions: 2, claimsRetained: 1, edgesRemoved: 1 });
    expect(database.getTopic(current.id)).toBeNull();
    expect(getClaim(database, claim.id)?.topicId).toBeNull();
    expect(count(database, "SELECT COUNT(*) AS count FROM topic_page_revisions WHERE topic_id = ?", current.id)).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM topic_fts WHERE topic_id = ?", current.id)).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM topic_revision_fts WHERE topic_id = ?", current.id)).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM vectors WHERE source_id = ? OR source_id IN (?, ?)", current.id, firstRevision, revisions.at(-1)!.id)).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM memory_pins WHERE object_id = ?", current.id)).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM page_links WHERE source_topic_id = ? OR target_topic_id = ?", current.id, current.id)).toBe(0);
    const operation = database.listIncompleteDeletionOperations().find((row) => row.id === result.operationId);
    expect(JSON.parse(String(operation?.payload_json))).toEqual({ deletedTopicIds: [current.id], affectedTopicIds: [current.id], nestedOperationIds: [] });
    expect(database.connection.pragma("foreign_key_check")).toEqual([]);
  });

  it("keeps a compiler parent while reporting it as an affected projection when only one child is deleted", async () => {
    const { database } = await fixture("topic-child-projection");
    const evidence = database.appendEvent({ role: "user", content: "Bounded child projection evidence." });
    const parent = database.upsertTopicRevision({
      type: "project", title: "Projection parent", slug: "projection-parent", markdown: "# Projection parent",
      summary: "Parent", currentState: "", history: "", sourceIds: [evidence.id], authorType: "user", promptVersion: "v1"
    });
    const child = database.upsertTopicRevision({
      type: "project", title: "Projection child", slug: `${parent.id}-history-part-1`, markdown: "# Projection child",
      summary: "Child", currentState: "", history: "History", tags: ["auto-split", `parent:${parent.id}`], sourceIds: [evidence.id], promptVersion: "v1"
    });
    database.rebuildTopicProjectionIndex();

    const result = database.hardDeleteTopic(child.id);

    expect(result.deletedTopicIds).toEqual([child.id]);
    expect(new Set(result.affectedTopicIds)).toEqual(new Set([child.id, parent.id]));
    expect(result.counts).toMatchObject({ topics: 1, descendants: 0 });
    expect(database.getTopic(child.id)).toBeNull();
    expect(database.getTopic(parent.id)).not.toBeNull();
    const operation = database.connection.prepare("SELECT payload_json FROM deletion_operations WHERE id = ?").get(result.operationId) as { payload_json: string };
    expect(JSON.parse(operation.payload_json)).toMatchObject({ deletedTopicIds: [child.id], nestedOperationIds: [] });
    expect(new Set((JSON.parse(operation.payload_json) as { affectedTopicIds: string[] }).affectedTopicIds)).toEqual(new Set([child.id, parent.id]));
    expect(database.connection.pragma("foreign_key_check")).toEqual([]);
  });

  it("does not treat an arbitrary user-authored parent tag as deletion authority", async () => {
    const { database } = await fixture("topic-malicious-parent-tag");
    const evidence = database.appendEvent({ role: "user", content: "Independent user pages." });
    const parent = database.upsertTopicRevision({
      type: "project", title: "Tag target", slug: "tag-target", markdown: "# Tag target",
      summary: "Parent", currentState: "", history: "", sourceIds: [evidence.id], authorType: "user", promptVersion: "v1"
    });
    const malicious = database.upsertTopicRevision({
      type: "artifact", title: "User note", slug: "unrelated-user-note", markdown: "# User note\n\nMust survive.",
      summary: "Independent", currentState: "", history: "", tags: [`parent:${parent.id}`], sourceIds: [evidence.id], authorType: "user", promptVersion: "v1"
    });
    const compilerChild = database.upsertTopicRevision({
      type: "artifact", title: "Compiler child", slug: "compiler-linked-child", markdown: "# Compiler child",
      summary: "Compiler-owned", currentState: "", history: "", sourceIds: [evidence.id], authorType: "user", promptVersion: "v1"
    });
    const timestamp = new Date().toISOString();
    database.connection.prepare("INSERT INTO page_links(id, source_topic_id, target_topic_id, relation_type, evidence_json, created_at) VALUES (?, ?, ?, 'contains', '[]', ?)")
      .run(uuidv7(), parent.id, compilerChild.id, timestamp);
    database.connection.prepare("INSERT INTO page_links(id, source_topic_id, target_topic_id, relation_type, evidence_json, created_at) VALUES (?, ?, ?, 'part_of', '[]', ?)")
      .run(uuidv7(), compilerChild.id, parent.id, timestamp);
    // An unpaired user-created lookalike remains non-authoritative.
    database.connection.prepare("INSERT INTO page_links(id, source_topic_id, target_topic_id, relation_type, evidence_json, created_at) VALUES (?, ?, ?, 'contains', '[]', ?)")
      .run(uuidv7(), parent.id, malicious.id, timestamp);

    expect(new Set(database.topicDeletionClosureIds(parent.id))).toEqual(new Set([parent.id, compilerChild.id]));
    const result = database.hardDeleteTopic(parent.id);

    expect(new Set(result.deletedTopicIds)).toEqual(new Set([parent.id, compilerChild.id]));
    expect(database.getTopic(parent.id)).toBeNull();
    expect(database.getTopic(compilerChild.id)).toBeNull();
    expect(database.getTopic(malicious.id)?.markdown).toContain("Must survive");
    expect(database.connection.pragma("foreign_key_check")).toEqual([]);
  });

  it("deletes the full auto-split descendant tree and every derived shard artifact", async () => {
    const { database } = await fixture("topic-shard-descendants");
    const evidence = database.appendEvent({ role: "user", content: "Private sharded project evidence." });
    const parent = database.upsertTopicRevision({
      type: "project", title: "Sharded project", slug: "sharded-project", markdown: "# Sharded project",
      summary: "Parent", currentState: "", history: "", sourceIds: [evidence.id], promptVersion: "v1"
    });
    const child = database.upsertTopicRevision({
      type: "project", title: "History shard", slug: `${parent.id}-history-part-1`, markdown: "# History shard",
      summary: "", currentState: "", history: "Private history", tags: ["auto-split", `parent:${parent.id}`], sourceIds: [evidence.id], promptVersion: "v1"
    });
    const grandchild = database.upsertTopicRevision({
      type: "project", title: "Evidence shard", slug: `${child.id}-evidence-part-1`, markdown: "# Evidence shard",
      summary: "", currentState: "", history: "Private evidence", tags: ["auto-split", `parent:${child.id}`], sourceIds: [evidence.id], promptVersion: "v1"
    });
    const unrelated = database.upsertTopicRevision({
      type: "concept", title: "Unrelated", slug: "unrelated-topic", markdown: "# Unrelated",
      summary: "Safe", currentState: "", history: "", sourceIds: [evidence.id], promptVersion: "v1"
    });
    database.rebuildTopicProjectionIndex();
    const claim = database.upsertClaim({
      topicId: child.id, subject: "Shard", predicate: "contains", value: "private", confidence: 1, status: "current",
      sourceRole: "user", sourceIds: [evidence.id], validFrom: null, validTo: null, observedAt: evidence.createdAt, freshnessExpiresAt: null
    });
    const timestamp = new Date().toISOString();
    database.pinMemory("topic", grandchild.id, "Pinned descendant");
    database.connection.prepare("INSERT INTO page_links(id, source_topic_id, target_topic_id, relation_type, evidence_json, created_at) VALUES (?, ?, ?, 'contains', '[]', ?)").run(uuidv7(), parent.id, child.id, timestamp);
    database.connection.prepare("INSERT INTO page_links(id, source_topic_id, target_topic_id, relation_type, evidence_json, created_at) VALUES (?, ?, ?, 'related', '[]', ?)").run(uuidv7(), grandchild.id, unrelated.id, timestamp);
    const revisionIds = (database.connection.prepare("SELECT id FROM topic_page_revisions WHERE topic_id IN (?, ?, ?)").all(parent.id, child.id, grandchild.id) as Array<{ id: string }>).map((row) => row.id);
    for (const sourceId of [parent.id, child.id, grandchild.id, ...revisionIds]) {
      database.connection.prepare("INSERT INTO vectors(id, source_id, source_type, model_id, dimensions, content_hash, embedding_version, embedding_json, created_at) VALUES (?, ?, 'topic', 'fixture', 2, ?, 'v1', '[1,0]', ?)").run(uuidv7(), sourceId, stableHash(sourceId), timestamp);
    }

    const result = database.hardDeleteTopic(parent.id);
    const removedIds = new Set([parent.id, child.id, grandchild.id]);

    expect(new Set(result.affectedTopicIds)).toEqual(removedIds);
    expect(result.counts).toMatchObject({ topics: 3, descendants: 2, revisions: 3, claimsRetained: 1, pageLinksRemoved: 2, shardRowsRemoved: 2 });
    for (const id of removedIds) expect(database.getTopic(id)).toBeNull();
    expect(database.getTopic(unrelated.id)).not.toBeNull();
    expect(getClaim(database, claim.id)?.topicId).toBeNull();
    expect(count(database, "SELECT COUNT(*) AS count FROM topic_page_revisions WHERE topic_id IN (?, ?, ?)", parent.id, child.id, grandchild.id)).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM topic_fts WHERE topic_id IN (?, ?, ?)", parent.id, child.id, grandchild.id)).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM topic_revision_fts WHERE topic_id IN (?, ?, ?)", parent.id, child.id, grandchild.id)).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM vectors WHERE source_id IN (?, ?, ?)", parent.id, child.id, grandchild.id)).toBe(0);
    expect(count(database, `SELECT COUNT(*) AS count FROM vectors WHERE source_id IN (${revisionIds.map(() => "?").join(",")})`, ...revisionIds)).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM page_links WHERE source_topic_id IN (?, ?, ?) OR target_topic_id IN (?, ?, ?)", parent.id, child.id, grandchild.id, parent.id, child.id, grandchild.id)).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM topic_section_shards WHERE parent_topic_id IN (?, ?, ?) OR child_topic_id IN (?, ?, ?)", parent.id, child.id, grandchild.id, parent.id, child.id, grandchild.id)).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM topic_projection_state WHERE parent_topic_id IN (?, ?, ?)", parent.id, child.id, grandchild.id)).toBe(0);
    expect(count(database, "SELECT COUNT(*) AS count FROM memory_pins WHERE object_id = ?", grandchild.id)).toBe(0);
    const operation = database.listIncompleteDeletionOperations().find((row) => row.id === result.operationId);
    expect(new Set((JSON.parse(String(operation?.payload_json)) as { affectedTopicIds: string[] }).affectedTopicIds)).toEqual(removedIds);
    expect(database.connection.pragma("foreign_key_check")).toEqual([]);
  });

  it("tracks and completes nested answer-deletion journals when a topic is deleted", async () => {
    const { database } = await fixture("topic-answer-journals");
    const evidence = database.appendEvent({ role: "user", content: "Topic evidence" });
    const topic = database.upsertTopicRevision({
      type: "project", title: "Journal topic", slug: "journal-topic", markdown: "# Journal topic",
      summary: "Journal", currentState: "active", history: "", sourceIds: [evidence.id], promptVersion: "v1"
    });
    const prompt = database.appendEvent({ role: "user", content: "Summarize the topic" });
    const run = database.createRun(prompt.id, "balanced");
    const answer = database.appendEvent({ role: "assistant", content: "Topic summary", parentEventId: prompt.id, runId: run.id });
    database.connection.prepare("UPDATE runs SET assistant_event_id = ?, status = 'complete' WHERE id = ?").run(answer.id, run.id);
    database.saveContextPacket({ runId: run.id, budget: {}, sourceIds: [topic.id], promptVersion: "v1", renderedContent: "topic" });
    const derivedTopic = database.upsertTopicRevision({
      type: "concept", title: "Answer-derived topic", slug: "answer-derived-topic", markdown: "# Answer-derived topic\n\nDerived from the answer.",
      summary: "Derived", currentState: "Derived", history: "", sourceIds: [answer.id], promptVersion: "v1"
    });
    database.upsertClaim({
      topicId: derivedTopic.id, subject: "Answer", predicate: "summary", value: "derived", confidence: 1, status: "current",
      sourceRole: "assistant", sourceIds: [answer.id], validFrom: null, validTo: null, observedAt: new Date().toISOString(), freshnessExpiresAt: null
    });

    const result = database.hardDeleteTopic(topic.id);
    expect(result.nestedOperationIds).toHaveLength(1);
    expect(new Set(result.affectedTopicIds)).toEqual(new Set([topic.id, derivedTopic.id]));
    expect(database.getTopic(derivedTopic.id)).toBeNull();
    const operation = database.connection.prepare("SELECT payload_json FROM deletion_operations WHERE id = ?").get(result.operationId) as { payload_json: string };
    expect(new Set((JSON.parse(operation.payload_json) as { affectedTopicIds: string[] }).affectedTopicIds)).toEqual(new Set([topic.id, derivedTopic.id]));
    for (const nestedOperationId of result.nestedOperationIds) database.completeDeletionOperation(nestedOperationId);
    database.completeDeletionOperation(result.operationId);
    expect(database.listIncompleteDeletionOperations()).toEqual([]);
  });
});
