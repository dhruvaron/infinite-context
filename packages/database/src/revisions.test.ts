import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@continuum/config";
import { ContinuumDatabase, uuidv7 } from "./index.js";

const fixtures: Array<{ root: string; database: ContinuumDatabase }> = [];

async function fixture(): Promise<ContinuumDatabase> {
  const root = await mkdtemp(join(tmpdir(), "continuum-revisions-"));
  const config = loadConfig({ NODE_ENV: "test", CONTINUUM_DATA_DIR: root, CONTINUUM_SESSION_TOKEN: "test-session-token-that-is-at-least-32-characters" });
  const database = ContinuumDatabase.open(config);
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

describe("assistant response revisions", () => {
  it("atomically switches the active response and active-evidence claim projection", async () => {
    const database = await fixture();
    const user = database.appendEvent({ role: "user", content: "Choose a launch color." });
    const first = database.appendEvent({ role: "assistant", content: "First answer: ultramarine.", parentEventId: user.id });
    database.registerAssistantRevision(user.id, first.id);
    const insertVector = database.connection.prepare(`
      INSERT INTO vectors(id, source_id, source_type, model_id, dimensions, content_hash, embedding_version, embedding_json, created_at)
      VALUES (?, ?, 'event', 'fixture', 2, ?, 'v1', '[1,0]', ?)
    `);
    insertVector.run(uuidv7(), first.id, `hash-${first.id}`, new Date().toISOString());
    const second = database.appendEvent({ role: "assistant", content: "Second answer: vermilion.", parentEventId: user.id });
    database.registerAssistantRevision(user.id, second.id);
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM vectors WHERE source_id = ?").get(first.id)).toEqual({ count: 0 });
    insertVector.run(uuidv7(), first.id, `hash-reactivated-${first.id}`, new Date().toISOString());
    insertVector.run(uuidv7(), second.id, `hash-${second.id}`, new Date().toISOString());
    const observedAt = new Date().toISOString();
    database.upsertClaim({ topicId: null, subject: "Launch", predicate: "first color", value: "ultramarine", confidence: 0.8, status: "current", sourceRole: "assistant", sourceIds: [first.id], validFrom: null, validTo: null, observedAt, freshnessExpiresAt: null });
    database.upsertClaim({ topicId: null, subject: "Launch", predicate: "second color", value: "vermilion", confidence: 0.8, status: "current", sourceRole: "assistant", sourceIds: [second.id], validFrom: null, validTo: null, observedAt, freshnessExpiresAt: null });
    database.upsertClaim({ topicId: null, subject: "User", predicate: "requested", value: "a launch color", confidence: 1, status: "current", sourceRole: "user", sourceIds: [user.id], validFrom: null, validTo: null, observedAt, freshnessExpiresAt: null });

    expect(database.listAssistantRevisions(second.id).map((revision) => ({ number: revision.revisionNumber, active: revision.active }))).toEqual([
      { number: 1, active: false }, { number: 2, active: true }
    ]);
    expect(database.listClaims(20).map((claim) => claim.value)).toEqual(expect.arrayContaining(["vermilion", "a launch color"]));
    expect(database.listClaims(20).map((claim) => claim.value)).not.toContain("ultramarine");

    expect(database.activateAssistantRevision(first.id)?.id).toBe(first.id);
    expect(database.getEvent(first.id)?.active).toBe(true);
    expect(database.getEvent(second.id)?.active).toBe(false);
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM vectors WHERE source_id = ?").get(first.id)).toEqual({ count: 1 });
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM vectors WHERE source_id = ?").get(second.id)).toEqual({ count: 0 });
    expect(database.listClaims(20).map((claim) => claim.value)).toEqual(expect.arrayContaining(["ultramarine", "a launch color"]));
    expect(database.listClaims(20).map((claim) => claim.value)).not.toContain("vermilion");
    expect(database.search("ultramarine", 20, { status: "current" }).map((result) => result.id)).toContain(first.id);
    expect(database.search("vermilion", 20, { status: "current" }).map((result) => result.id)).not.toContain(second.id);
    expect(database.search("vermilion", 20, { status: "superseded" }).map((result) => result.id)).toContain(second.id);
  });

  it("withholds a compiled page that cites an inactive assistant revision", async () => {
    const database = await fixture();
    const user = database.appendEvent({ role: "user", content: "Plan the launch." });
    const first = database.appendEvent({ role: "assistant", content: "Use the first plan.", parentEventId: user.id });
    database.registerAssistantRevision(user.id, first.id);
    database.upsertTopicRevision({ type: "project", title: "Launch", slug: "launch", markdown: "# Launch\n\nUse the first plan.", summary: "First plan", currentState: "First", history: "", sourceIds: [user.id, first.id], promptVersion: "test-v1" });
    expect(database.listTopics()).toHaveLength(1);

    const second = database.appendEvent({ role: "assistant", content: "Use the revised plan.", parentEventId: user.id });
    database.registerAssistantRevision(user.id, second.id);
    expect(database.listTopics()).toHaveLength(0);
    expect(database.listTopics(100, true)).toHaveLength(1);
  });

  it("keeps an interrupted partial visible until a successful retry supersedes it", async () => {
    const database = await fixture();
    const user = database.appendEvent({ role: "user", content: "Explain the plan." });
    const partial = database.appendEvent({
      role: "assistant",
      status: "incomplete",
      content: "Exact interrupted prefix",
      parentEventId: user.id
    });
    expect(database.listEvents({ limit: 10 }).map((event) => event.id)).toContain(partial.id);

    const replacement = database.appendEvent({ role: "assistant", content: "Complete replacement.", parentEventId: user.id });
    database.registerAssistantRevision(user.id, replacement.id);

    expect(database.getEvent(partial.id)).toMatchObject({ status: "incomplete", active: false, content: "Exact interrupted prefix" });
    expect(database.getEvent(replacement.id)?.active).toBe(true);
    expect(database.search("interrupted prefix", 10, { types: ["event"], status: "superseded" }).map((item) => item.id)).toContain(partial.id);
  });

  it("returns entities and tool evidence as distinct searchable result types", async () => {
    const database = await fixture();
    const timestamp = new Date().toISOString();
    const entityId = "11111111-1111-4111-8111-111111111111";
    const toolId = "22222222-2222-4222-8222-222222222222";
    database.connection.prepare(`
      INSERT INTO entities(id, core_type, display_name, normalized_name, status, canonical_description, created_at, updated_at)
      VALUES (?, 'project', 'Orchid launch', 'orchid launch', 'active', 'The Orchid release project.', ?, ?)
    `).run(entityId, timestamp, timestamp);
    database.connection.prepare(`
      INSERT INTO tool_executions(id, run_id, tool_name, arguments_json, output_text, citations_json, status, sandbox_json, started_at, completed_at)
      VALUES (?, 'fixture-run', 'search_memory', '{}', 'Orchid deployment evidence', '[]', 'complete', '{}', ?, ?)
    `).run(toolId, timestamp, timestamp);

    expect(database.search("Orchid", 20, { types: ["entity"] })).toEqual([
      expect.objectContaining({ id: entityId, type: "entity" })
    ]);
    expect(database.search("Orchid", 20, { types: ["tool_result"] })).toEqual([
      expect.objectContaining({ id: toolId, type: "tool_result" })
    ]);
    expect(database.search("Orchid", 20, { types: ["source"] })).toEqual([]);
  });
});
