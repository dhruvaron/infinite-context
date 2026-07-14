import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v7 as uuidv7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";

import { ContinuumDatabase } from "./index.js";

const fixtures: Array<{ root: string; database: ContinuumDatabase }> = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "continuum-focused-graph-"));
  const database = ContinuumDatabase.open(join(root, "continuum.sqlite3"));
  const value = { root, database };
  fixtures.push(value);
  return value;
}

afterEach(async () => {
  while (fixtures.length) {
    const value = fixtures.pop()!;
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

describe("exact focused graph materialization", () => {
  it("finds selected records beyond the overview's topic and claim recency caps", async () => {
    const { database } = await fixture();
    const oldTopicId = uuidv7();
    const linkedTopicId = uuidv7();
    const oldClaimId = uuidv7();
    const relatedClaimId = uuidv7();
    const evidence = database.appendEvent({ role: "user", content: "Exact old evidence" });
    const topicInsert = database.connection.prepare(`
      INSERT INTO topic_pages(id, core_type, slug, title, active_revision, scope_id, tags_json, lifecycle_status, created_at, updated_at)
      VALUES (?, 'project', ?, ?, 1, 'global', '[]', 'active', ?, ?)
    `);
    const revisionInsert = database.connection.prepare(`
      INSERT INTO topic_page_revisions(id, topic_id, revision_number, markdown, summary, current_state, history,
        open_questions_json, generation_inputs_json, author_type, prompt_version, created_at)
      VALUES (?, ?, 1, ?, ?, 'active', '', '[]', '[]', 'model', 'graph-test-v1', ?)
    `);
    const claimInsert = database.connection.prepare(`
      INSERT INTO claims(id, topic_id, subject, predicate, value, confidence, status, source_role, valid_from, valid_to,
        observed_at, freshness_expires_at, extraction_version)
      VALUES (?, NULL, ?, 'records', ?, 0.9, ?, 'user', NULL, NULL, ?, NULL, 'graph-test-v1')
    `);
    const claimSourceInsert = database.connection.prepare("INSERT INTO claim_sources(claim_id, source_id, source_type) VALUES (?, ?, 'event')");

    database.connection.transaction(() => {
      const oldTime = "2020-01-01T00:00:00.000Z";
      topicInsert.run(oldTopicId, "old-focus", "Old focus", oldTime, oldTime);
      revisionInsert.run(uuidv7(), oldTopicId, "# Old focus", "The exact selected old topic.", oldTime);
      topicInsert.run(linkedTopicId, "linked-focus", "Linked focus", oldTime, oldTime);
      revisionInsert.run(uuidv7(), linkedTopicId, "# Linked focus", "A directly linked topic.", oldTime);
      database.connection.prepare(`
        INSERT INTO page_links(id, source_topic_id, target_topic_id, relation_type, evidence_json, created_at)
        VALUES (?, ?, ?, 'related', ?, ?)
      `).run(uuidv7(), oldTopicId, linkedTopicId, JSON.stringify([evidence.id]), oldTime);

      for (let index = 0; index < 550; index += 1) {
        const id = uuidv7();
        const timestamp = new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString();
        topicInsert.run(id, `recent-topic-${index}`, `Recent topic ${index}`, timestamp, timestamp);
        revisionInsert.run(uuidv7(), id, `# Recent topic ${index}`, `Recent topic ${index}`, timestamp);
      }

      claimInsert.run(oldClaimId, "Old subject", "old value", "expired", oldTime);
      claimSourceInsert.run(oldClaimId, evidence.id);
      claimInsert.run(relatedClaimId, "Related subject", "related value", "current", oldTime);
      claimSourceInsert.run(relatedClaimId, evidence.id);
      database.connection.prepare(`
        INSERT INTO claim_relations(id, source_claim_id, target_claim_id, relation_type, confidence, created_at)
        VALUES (?, ?, ?, 'refines', 1, ?)
      `).run(uuidv7(), oldClaimId, relatedClaimId, oldTime);
      for (let index = 0; index < 1_050; index += 1) {
        const id = uuidv7();
        const timestamp = new Date(Date.UTC(2025, 1, 1, 0, 0, index)).toISOString();
        claimInsert.run(id, `Recent subject ${index}`, `recent value ${index}`, "current", timestamp);
        claimSourceInsert.run(id, evidence.id);
      }
    })();

    const topicGraph = database.graph(oldTopicId, 50, 1, true);
    expect(topicGraph.focusId).toBe(oldTopicId);
    expect(topicGraph.nodes).toContainEqual(expect.objectContaining({ id: oldTopicId, label: "Old focus" }));
    expect(topicGraph.nodes).toContainEqual(expect.objectContaining({ id: linkedTopicId }));
    expect(topicGraph.edges).toContainEqual(expect.objectContaining({ source: oldTopicId, target: linkedTopicId, type: "related" }));

    const claimGraph = database.graph(oldClaimId, 50, 1, false);
    expect(claimGraph.focusId).toBe(oldClaimId);
    expect(claimGraph.nodes).toContainEqual(expect.objectContaining({ id: oldClaimId, status: "expired" }));
    expect(claimGraph.nodes).toContainEqual(expect.objectContaining({ id: relatedClaimId }));
    expect(claimGraph.edges).toContainEqual(expect.objectContaining({ source: oldClaimId, target: relatedClaimId, type: "refines" }));
  });

  it("reports an unknown focus instead of silently showing unrelated recent memory", async () => {
    const { database } = await fixture();
    const unknownId = uuidv7();
    expect(() => database.graph(unknownId, 50, 2, true)).toThrowError(expect.objectContaining({
      message: "That graph record was not found.",
      code: "GRAPH_FOCUS_NOT_FOUND"
    }));
  });

  it("grounds a focused assistant answer in its parent turn and exact selected evidence", async () => {
    const { database } = await fixture();
    const evidence = database.appendEvent({ role: "user", content: "The retained source says alpha." });
    const user = database.appendEvent({ role: "user", content: "What did the source say?" });
    const run = database.createRun(user.id, "balanced");
    const assistant = database.appendEvent({
      role: "assistant",
      content: "It said alpha.",
      parentEventId: user.id,
      runId: run.id
    });
    database.addContextRef(user.id, "retrieval_source", evidence.id, { runId: run.id });

    const graph = database.graph(assistant.id, 50, 1, false);
    expect(graph.focusId).toBe(assistant.id);
    expect(graph.nodes).toContainEqual(expect.objectContaining({ id: user.id, type: "event" }));
    expect(graph.nodes).toContainEqual(expect.objectContaining({ id: evidence.id, type: "event" }));
    expect(graph.edges).toContainEqual(expect.objectContaining({
      source: assistant.id,
      target: user.id,
      type: "response_to"
    }));
    expect(graph.edges).toContainEqual(expect.objectContaining({
      source: assistant.id,
      target: evidence.id,
      type: "grounded_by",
      evidenceIds: [evidence.id]
    }));
  });
});
