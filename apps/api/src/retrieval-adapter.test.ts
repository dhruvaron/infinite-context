import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@continuum/config";
import {
  ContinuumDatabase,
  VECTOR_FALLBACK_MAX_ROWS
} from "@continuum/database";
import type { CandidateGenerationRequest } from "@continuum/retrieval";
import {
  SQLITE_GRAPH_ADJACENCY_MAX,
  SqliteCandidateIndex
} from "./retrieval-adapter.js";

const fixtures: Array<{ root: string; database: ContinuumDatabase }> = [];

async function fixture(): Promise<ContinuumDatabase> {
  const root = await mkdtemp(join(tmpdir(), "continuum-retrieval-adapter-"));
  const database = ContinuumDatabase.open(loadConfig({
    NODE_ENV: "test",
    CONTINUUM_DATA_DIR: root,
    CONTINUUM_MOCK_PROVIDER: "true",
    CONTINUUM_SESSION_TOKEN: "retrieval-adapter-test-token-000000000000"
  }));
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

function request(queryEmbedding: number[], queryEmbeddingModelId = "fixture"): CandidateGenerationRequest {
  return {
    query: "remember the old target",
    queryEmbedding,
    queryEmbeddingModelId,
    classification: {
      classes: ["factual_recall"],
      timeIntent: "unspecified",
      dateRange: null,
      entities: [],
      requestedSourceTypes: [],
      relationshipQuestion: false,
      confidence: 1,
      usedModelFallback: false
    },
    now: "2030-01-01T00:00:00.000Z",
    scopeId: "global",
    activeTopicIds: [],
    limitPerChannel: 10
  };
}

describe("SQLite retrieval adapter at long-session scale", () => {
  it("retrieves a real old document through native vector search beyond 5,000 newer vectors", async () => {
    const database = await fixture();
    const target = database.appendEvent({ role: "user", content: "The old target fact is heliotrope." });
    database.connection.prepare(`
      INSERT INTO vectors(
        id, source_id, source_type, model_id, dimensions, content_hash,
        embedding_version, embedding_json, created_at
      ) VALUES ('old-target-vector', ?, 'event', 'fixture', 2, 'target-hash', 'fixture-v1', '[1,0]', '2000-01-01T00:00:00.000Z')
    `).run(target.id);
    const insert = database.connection.prepare(`
      INSERT INTO vectors(
        id, source_id, source_type, model_id, dimensions, content_hash,
        embedding_version, embedding_json, created_at
      ) VALUES (?, ?, 'event', 'fixture', 2, ?, 'fixture-v1', '[0,1]', '2030-01-01T00:00:00.000Z')
    `);
    database.connection.transaction(() => {
      for (let index = 0; index < VECTOR_FALLBACK_MAX_ROWS + 1; index += 1) {
        const suffix = index.toString().padStart(5, "0");
        insert.run(`filler-vector-${suffix}`, `missing-source-${suffix}`, `filler-hash-${suffix}`);
      }
    })();

    const signals = await new SqliteCandidateIndex(database).vector(request([1, 0]));
    expect(signals[0]).toMatchObject({
      channel: "vector",
      score: 1,
      document: { id: target.id },
      reason: expect.stringContaining(`examined ${VECTOR_FALLBACK_MAX_ROWS + 2}/${VECTOR_FALLBACK_MAX_ROWS + 2} vectors`)
    });
    expect(signals[0]?.reason).toContain("native sqlite-vec cosine");
  });

  it("does not retrieve a better-scoring vector produced by another embedding model", async () => {
    const database = await fixture();
    const selected = database.appendEvent({ role: "user", content: "The selected-model fact." });
    const incompatible = database.appendEvent({ role: "user", content: "The incompatible-model fact." });
    const insert = database.connection.prepare(`
      INSERT INTO vectors(
        id, source_id, source_type, model_id, dimensions, content_hash,
        embedding_version, embedding_json, created_at
      ) VALUES (?, ?, 'event', ?, 2, ?, 'fixture-v1', ?, ?)
    `);
    insert.run("selected-model-vector", selected.id, "selected-model", "selected-hash", "[0.8,0.2]", "2026-01-01T00:00:00.000Z");
    insert.run("other-model-vector", incompatible.id, "other-model", "other-hash", "[1,0]", "2026-01-02T00:00:00.000Z");

    const signals = await new SqliteCandidateIndex(database).vector(request([1, 0], "selected-model"));

    expect(signals.map((signal) => signal.document.id)).toEqual([selected.id]);
  });

  it("finds an old adjacent edge after more than 5,000 unrelated newer edges", async () => {
    const database = await fixture();
    const source = database.appendEvent({ role: "user", content: "Source node" });
    const target = database.appendEvent({ role: "user", content: "Old graph neighbor" });
    database.connection.prepare(`
      INSERT INTO edges(id, source_id, target_id, edge_type, status, evidence_json, created_at)
      VALUES ('old-adjacent-edge', ?, ?, 'references', 'current', '[]', '2000-01-01T00:00:00.000Z')
    `).run(source.id, target.id);
    const insert = database.connection.prepare(`
      INSERT INTO edges(id, source_id, target_id, edge_type, status, evidence_json, created_at)
      VALUES (?, ?, ?, 'unrelated', 'current', '[]', '2030-01-01T00:00:00.000Z')
    `);
    database.connection.transaction(() => {
      for (let index = 0; index < 5_001; index += 1) {
        const suffix = index.toString().padStart(5, "0");
        insert.run(`filler-edge-${suffix}`, `filler-source-${suffix}`, `filler-target-${suffix}`);
      }
    })();

    const adapter = new SqliteCandidateIndex(database);
    expect(adapter.getAdjacent(source.id, 10)).toEqual([
      expect.objectContaining({
        id: "old-adjacent-edge",
        source: source.id,
        target: target.id
      })
    ]);
    expect(adapter.getDocument(target.id)).toMatchObject({ id: target.id, content: "Old graph neighbor" });
  });

  it("uses both adjacency indexes and applies an explicit per-node safety bound", async () => {
    const database = await fixture();
    const sourceDetails = (database.connection.prepare(`
      EXPLAIN QUERY PLAN
      SELECT * FROM edges INDEXED BY edges_source_created_idx
      WHERE source_id = ? ORDER BY created_at DESC, id ASC LIMIT ?
    `).all("node", 10) as Array<{ detail: string }>).map((row) => row.detail).join("\n");
    const targetDetails = (database.connection.prepare(`
      EXPLAIN QUERY PLAN
      SELECT * FROM edges INDEXED BY edges_target_created_idx
      WHERE target_id = ? AND source_id <> ? ORDER BY created_at DESC, id ASC LIMIT ?
    `).all("node", "node", 10) as Array<{ detail: string }>).map((row) => row.detail).join("\n");
    expect(sourceDetails).toContain("edges_source_created_idx");
    expect(targetDetails).toContain("edges_target_created_idx");

    const source = database.appendEvent({ role: "user", content: "high-degree node" });
    const insert = database.connection.prepare(`
      INSERT INTO edges(id, source_id, target_id, edge_type, status, evidence_json, created_at)
      VALUES (?, ?, ?, 'references', 'current', '[]', ?)
    `);
    database.connection.transaction(() => {
      for (let index = 0; index < SQLITE_GRAPH_ADJACENCY_MAX + 20; index += 1) {
        const suffix = index.toString().padStart(5, "0");
        insert.run(`bounded-edge-${suffix}`, source.id, `target-${suffix}`, `2026-01-01T00:00:${(index % 60).toString().padStart(2, "0")}.000Z`);
      }
    })();
    const adapter = new SqliteCandidateIndex(database);
    const first = adapter.getAdjacent(source.id, Number.MAX_SAFE_INTEGER);
    const second = adapter.getAdjacent(source.id, Number.MAX_SAFE_INTEGER);
    expect(first).toHaveLength(SQLITE_GRAPH_ADJACENCY_MAX);
    expect(second).toEqual(first);
  });

  it("deduplicates topic provenance before applying retrieval fusion", async () => {
    const database = await fixture();
    const first = database.appendEvent({ role: "user", content: "First independent source" });
    const second = database.appendEvent({ role: "user", content: "Second independent source" });
    const topic = database.upsertTopicRevision({
      type: "project",
      title: "Deduplicated topic",
      slug: "deduplicated-topic",
      markdown: "# Deduplicated topic",
      summary: "Two independent sources",
      currentState: "active",
      history: "",
      sourceIds: [first.id, first.id, second.id, first.id],
      promptVersion: "fixture-v1"
    });

    expect(new SqliteCandidateIndex(database).getDocument(topic.id)?.sourceIds).toEqual([
      first.id,
      second.id
    ]);
  });

  it("loads an exact old claim and its topic edge without scanning the capped claim list", async () => {
    const database = await fixture();
    const topic = database.upsertTopicRevision({
      type: "project",
      title: "Long project",
      slug: "long-project",
      markdown: "# Long project",
      summary: "A long-running project",
      currentState: "active",
      history: "",
      authorType: "user",
      promptVersion: "fixture-v1"
    });
    const evidence = database.appendEvent({ role: "user", content: "The launch color is heliotrope." });
    const target = database.upsertClaim({
      topicId: topic.id,
      subject: "Launch",
      predicate: "color",
      value: "heliotrope",
      confidence: 1,
      status: "current",
      sourceRole: "user",
      sourceIds: [evidence.id],
      validFrom: null,
      validTo: null,
      observedAt: "2000-01-01T00:00:00.000Z",
      freshnessExpiresAt: null
    });
    const insertClaim = database.connection.prepare(`
      INSERT INTO claims(
        id, topic_id, subject, predicate, value, confidence, status, source_role,
        valid_from, valid_to, observed_at, freshness_expires_at, extraction_version
      ) VALUES (?, NULL, 'Filler', 'index', ?, 1, 'current', 'user', NULL, NULL,
        '2030-01-01T00:00:00.000Z', NULL, 'fixture-v1')
    `);
    const insertSource = database.connection.prepare(`
      INSERT INTO claim_sources(claim_id, source_id, source_type) VALUES (?, ?, 'event')
    `);
    database.connection.transaction(() => {
      for (let index = 0; index < 1_001; index += 1) {
        const id = `filler-claim-${index.toString().padStart(5, "0")}`;
        insertClaim.run(id, String(index));
        insertSource.run(id, evidence.id);
      }
    })();

    const adapter = new SqliteCandidateIndex(database);
    expect(adapter.getDocument(target.id)).toMatchObject({
      id: target.id,
      type: "claim",
      content: "Launch color: heliotrope"
    });
    expect(adapter.getAdjacent(target.id, 10)).toContainEqual(expect.objectContaining({
      source: topic.id,
      target: target.id,
      type: "contains"
    }));
  });
});
