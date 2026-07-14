import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@continuum/config";
import { uuidv7 } from "./index.js";
import { ContinuumDatabase } from "./index.js";

const fixtures: Array<{ root: string; database: ContinuumDatabase }> = [];

async function fixture(): Promise<ContinuumDatabase> {
  const root = await mkdtemp(join(tmpdir(), "continuum-memory-controls-"));
  const database = ContinuumDatabase.open(loadConfig({ NODE_ENV: "test", CONTINUUM_DATA_DIR: root, CONTINUUM_SESSION_TOKEN: "test-session-token-that-is-at-least-32-characters" }));
  fixtures.push({ root, database });
  return database;
}

afterEach(async () => {
  while (fixtures.length) {
    const value = fixtures.pop()!;
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

function insertEntity(database: ContinuumDatabase, displayName: string, normalizedName: string): string {
  const id = uuidv7();
  const timestamp = new Date().toISOString();
  database.connection.prepare("INSERT INTO entities(id, core_type, display_name, normalized_name, status, canonical_description, created_at, updated_at) VALUES (?, 'organization', ?, ?, 'active', '', ?, ?)").run(id, displayName, normalizedName, timestamp, timestamp);
  database.connection.prepare("INSERT INTO entity_aliases(id, entity_id, alias, normalized_alias, confidence, source_id, active, created_at) VALUES (?, ?, ?, ?, 0.9, NULL, 1, ?)").run(uuidv7(), id, displayName, normalizedName, timestamp);
  return id;
}

describe("inspectable memory controls", () => {
  it("indexes temporal claim slots with the reconciler's exact Unicode and whitespace normalization", async () => {
    const database = await fixture();
    const source = database.appendEvent({ role: "user", content: "Remember the normalized project name." });
    const topicId = uuidv7();
    const claim = database.upsertClaim({
      topicId,
      subject: "ＰＲＯＪＥＣＴ\u3000Name",
      predicate: "IS\t  NAMED",
      value: "Continuum",
      confidence: 1,
      status: "current",
      sourceRole: "user",
      sourceIds: [source.id],
      validFrom: null,
      validTo: null,
      observedAt: source.createdAt,
      freshnessExpiresAt: null
    });

    expect(database.listActiveClaimsForSlot("project name", "is named", topicId)).toEqual([expect.objectContaining({ id: claim.id })]);
    expect(database.claimTopicIdsForSlot("project   name", "is named")).toEqual([topicId]);
    expect(database.connection.prepare("EXPLAIN QUERY PLAN SELECT claim_id FROM claim_slot_index WHERE subject_key = ? AND predicate_key = ?").all("project name", "is named"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ detail: expect.stringContaining("claim_slot_lookup_idx") })]));
  });

  it("does not let historical-only topics hide the current topic in the bounded slot summary", async () => {
    const database = await fixture();
    const source = database.appendEvent({ role: "user", content: "The current project color is blue." });
    const historicalTopics = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
    for (const [index, topicId] of historicalTopics.entries()) {
      database.upsertClaim({
        topicId,
        subject: "Project",
        predicate: "color",
        value: `old-${index}`,
        confidence: 1,
        status: "historical",
        sourceRole: "user",
        sourceIds: [source.id],
        validFrom: null,
        validTo: source.createdAt,
        observedAt: source.createdAt,
        freshnessExpiresAt: null
      });
    }
    const currentTopic = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    database.upsertClaim({
      topicId: currentTopic,
      subject: "Project",
      predicate: "color",
      value: "blue",
      confidence: 1,
      status: "current",
      sourceRole: "user",
      sourceIds: [source.id],
      validFrom: source.createdAt,
      validTo: null,
      observedAt: source.createdAt,
      freshnessExpiresAt: null
    });

    expect(database.claimTopicIdsForSlot("project", "color")).toEqual([currentTopic]);
  });

  it("reconstructs derived section-shard metadata from portable topic revisions and provenance", async () => {
    const database = await fixture();
    const source = database.appendEvent({ role: "user", content: "The archived phase ended yesterday." });
    const parent = database.upsertTopicRevision({
      type: "project",
      title: "Portable project",
      slug: "portable-project",
      markdown: "# Portable project",
      summary: "Portable project",
      currentState: "",
      history: "",
      sourceIds: [],
      promptVersion: "test"
    });
    const claim = database.upsertClaim({
      topicId: parent.id,
      subject: "Project phase",
      predicate: "ended",
      value: "yesterday",
      confidence: 1,
      status: "historical",
      sourceRole: "user",
      sourceIds: [source.id],
      validFrom: null,
      validTo: source.createdAt,
      observedAt: source.createdAt,
      freshnessExpiresAt: null
    });
    const child = database.upsertTopicRevision({
      type: "project",
      title: "Portable project — History 1",
      slug: `${parent.id}-history-part-1`,
      markdown: "# Portable project — History 1\n\nThe phase ended yesterday.",
      summary: "",
      currentState: "",
      history: "The phase ended yesterday.",
      tags: ["auto-split", `parent:${parent.id}`],
      sourceIds: [source.id],
      promptVersion: "test"
    });
    database.connection.prepare(`
      UPDATE page_section_sources SET claim_id = ?
      WHERE revision_id = (SELECT id FROM topic_page_revisions WHERE topic_id = ? AND revision_number = ?)
    `).run(claim.id, child.id, child.revision);
    database.connection.prepare("DELETE FROM topic_section_shards").run();
    database.connection.prepare("DELETE FROM topic_projection_state").run();

    database.rebuildTopicProjectionIndex();

    expect(database.connection.prepare("SELECT mode FROM topic_projection_state WHERE parent_topic_id = ?").get(parent.id)).toEqual({ mode: "sharded" });
    expect(database.connection.prepare(`
      SELECT parent_topic_id, section_key, ordinal, min_sort_key, max_sort_key
      FROM topic_section_shards WHERE child_topic_id = ?
    `).get(child.id)).toEqual({
      parent_topic_id: parent.id,
      section_key: "history",
      ordinal: 1,
      min_sort_key: `${source.createdAt}\u0000${claim.id}`,
      max_sort_key: `${source.createdAt}\u0000${claim.id}`
    });
  });

  it("de-duplicates identical parent tags and ignores ambiguous layouts without making startup fatal", async () => {
    const database = await fixture();
    const parent = database.upsertTopicRevision({
      type: "project",
      title: "Ambiguous project",
      slug: "ambiguous-project",
      markdown: "# Ambiguous project",
      summary: "Ambiguous project",
      currentState: "",
      history: "",
      sourceIds: [],
      promptVersion: "test"
    });
    const first = database.upsertTopicRevision({
      type: "project",
      title: "First child",
      slug: `${parent.id}-history-part-1`,
      markdown: "# First child",
      summary: "",
      currentState: "",
      history: "First",
      tags: [`parent:${parent.id}`, `parent:${parent.id}`],
      sourceIds: [],
      promptVersion: "test"
    });
    const otherParent = database.upsertTopicRevision({
      type: "project",
      title: "Other project",
      slug: "other-project",
      markdown: "# Other project",
      summary: "Other project",
      currentState: "",
      history: "",
      sourceIds: [],
      promptVersion: "test"
    });

    expect(() => database.rebuildTopicProjectionIndex()).not.toThrow();
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM topic_section_shards WHERE parent_topic_id = ?").get(parent.id))
      .toEqual({ count: 1 });

    database.connection.prepare("UPDATE topic_pages SET tags_json = ? WHERE id = ?")
      .run(JSON.stringify([`parent:${parent.id}`, `parent:${otherParent.id}`]), first.id);
    expect(() => database.rebuildTopicProjectionIndex()).not.toThrow();
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM topic_section_shards WHERE parent_topic_id = ?").get(parent.id))
      .toEqual({ count: 0 });
    expect(database.connection.prepare("SELECT mode FROM topic_projection_state WHERE parent_topic_id = ?").get(parent.id)).toBeUndefined();
    expect(database.getTopic(first.id)?.lifecycleStatus).toBe("active");

    for (const malformedTags of ["{", JSON.stringify(`parent:${parent.id}`), JSON.stringify({ parent: parent.id })]) {
      database.connection.prepare("UPDATE topic_pages SET tags_json = ? WHERE id = ?").run(malformedTags, first.id);
      expect(() => database.rebuildTopicProjectionIndex()).not.toThrow();
      expect(database.connection.prepare("SELECT COUNT(*) AS count FROM topic_section_shards WHERE parent_topic_id = ?").get(parent.id))
        .toEqual({ count: 0 });
    }
  });

  it("records a claim correction as new user evidence and preserves superseded history", async () => {
    const database = await fixture();
    const originalEvent = database.appendEvent({ role: "user", content: "The launch is on Monday." });
    const observedAt = new Date().toISOString();
    const original = database.upsertClaim({ topicId: null, subject: "Launch", predicate: "date", value: "Monday", confidence: 1, status: "current", sourceRole: "user", sourceIds: [originalEvent.id], validFrom: null, validTo: null, observedAt, freshnessExpiresAt: null });

    const corrected = database.correctClaim(original.id, "Tuesday", "The calendar changed.");
    expect(corrected.event).toMatchObject({ role: "user", kind: "revision", status: "complete" });
    expect(corrected.event.content).toContain("Tuesday");
    expect(corrected.claim).toMatchObject({ value: "Tuesday", status: "current", sourceRole: "user", sourceIds: [corrected.event.id] });
    expect(database.listClaims(20, true).find((claim) => claim.id === original.id)).toMatchObject({ status: "superseded" });
    expect(database.connection.prepare("SELECT relation_type FROM claim_relations WHERE source_claim_id = ? AND target_claim_id = ?").get(corrected.claim.id, original.id)).toMatchObject({ relation_type: "supersedes" });
  });

  it("merges duplicate entities with an evidence-preserving reversible snapshot", async () => {
    const database = await fixture();
    const sourceId = insertEntity(database, "Open AI", "open ai");
    const targetId = insertEntity(database, "OpenAI", "openai");
    const otherId = insertEntity(database, "Continuum", "continuum");
    database.connection.prepare("INSERT INTO edges(id, source_id, target_id, edge_type, status, evidence_json, created_at) VALUES (?, ?, ?, 'uses', 'current', '[]', ?)").run(uuidv7(), sourceId, otherId, new Date().toISOString());

    const merged = database.mergeEntities(sourceId, targetId);
    expect(database.entityDetail(sourceId)).toMatchObject({ entity: { status: "merged" } });
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM entity_aliases WHERE entity_id = ?").get(sourceId)).toMatchObject({ count: 0 });
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM entity_aliases WHERE entity_id = ?").get(targetId)).toMatchObject({ count: 2 });
    expect(database.connection.prepare("SELECT source_id, target_id FROM edges WHERE edge_type = 'uses'").get()).toMatchObject({ source_id: targetId, target_id: otherId });

    const reversed = database.reverseEntityMerge(merged.mergeId);
    expect(reversed).toMatchObject({ sourceId, targetId });
    expect(database.entityDetail(sourceId)).toMatchObject({ entity: { status: "active" } });
    expect(database.connection.prepare("SELECT source_id, target_id FROM edges WHERE edge_type = 'uses'").get()).toMatchObject({ source_id: sourceId, target_id: otherId });
    expect(database.connection.prepare("SELECT reversed_at FROM merge_history WHERE id = ?").get(merged.mergeId)).toMatchObject({ reversed_at: expect.any(String) });
  });

  it("refuses to reverse a merge after its canonical target has changed", async () => {
    const database = await fixture();
    const sourceId = insertEntity(database, "Acme Incorporated", "acme incorporated");
    const targetId = insertEntity(database, "Acme Inc", "acme inc");
    const merged = database.mergeEntities(sourceId, targetId);
    database.connection.prepare("UPDATE entities SET canonical_description = 'new evidence', updated_at = ? WHERE id = ?").run(new Date(Date.now() + 1_000).toISOString(), targetId);
    expect(() => database.reverseEntityMerge(merged.mergeId)).toThrowError(expect.objectContaining({ code: "ENTITY_MERGE_CHANGED" }));
  });
});
