import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContinuumDatabase,
  VECTOR_FALLBACK_MAX_ROWS
} from "./index.js";

const fixtures: Array<{ root: string; database: ContinuumDatabase }> = [];

async function fixture(): Promise<ContinuumDatabase> {
  const root = await mkdtemp(join(tmpdir(), "continuum-vector-search-"));
  const database = ContinuumDatabase.open(join(root, "continuum.sqlite3"));
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

function insertVector(
  database: ContinuumDatabase,
  input: { id: string; sourceId: string; embedding: readonly number[]; createdAt: string; modelId?: string }
): void {
  database.connection.prepare(`
    INSERT INTO vectors(
      id, source_id, source_type, model_id, dimensions, content_hash,
      embedding_version, embedding_json, created_at
    ) VALUES (?, ?, 'event', ?, ?, ?, 'fixture-v1', ?, ?)
  `).run(
    input.id,
    input.sourceId,
    input.modelId ?? "fixture",
    input.embedding.length,
    `hash-${input.id}`,
    JSON.stringify(input.embedding),
    input.createdAt
  );
}

describe("native and degraded vector search", () => {
  it("auto-loads the installed sqlite-vec binary and exposes its measured strategy", async () => {
    const database = await fixture();
    expect(database.health()).toMatchObject({
      vectorAvailable: true,
      vectorMode: "sqlite-vec",
      vectorStrategy: "native-exact-cosine",
      vectorLoadStatus: "ready",
      vectorFallbackLimit: VECTOR_FALLBACK_MAX_ROWS,
      vectorVersion: expect.any(String)
    });
  });

  it("finds an old matching vector beyond 5,000 newer rows without truncating the native corpus", async () => {
    const database = await fixture();
    insertVector(database, {
      id: "00000000-old-target-vector",
      sourceId: "old-target-source",
      embedding: [1, 0],
      createdAt: "2000-01-01T00:00:00.000Z"
    });
    const insert = database.connection.prepare(`
      INSERT INTO vectors(
        id, source_id, source_type, model_id, dimensions, content_hash,
        embedding_version, embedding_json, created_at
      ) VALUES (?, ?, 'event', 'fixture', 2, ?, 'fixture-v1', '[0,1]', '2030-01-01T00:00:00.000Z')
    `);
    database.connection.transaction(() => {
      for (let index = 0; index < VECTOR_FALLBACK_MAX_ROWS + 1; index += 1) {
        const suffix = index.toString().padStart(5, "0");
        insert.run(`filler-vector-${suffix}`, `filler-source-${suffix}`, `filler-hash-${suffix}`);
      }
    })();

    const result = database.searchVectors([1, 0], "fixture", 10);
    expect(result).toMatchObject({
      mode: "sqlite-vec",
      strategy: "native-exact-cosine",
      corpusRows: VECTOR_FALLBACK_MAX_ROWS + 2,
      rowsExamined: VECTOR_FALLBACK_MAX_ROWS + 2,
      corpusTruncated: false,
      resultLimit: 10
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.matches[0]).toMatchObject({
      vectorId: "00000000-old-target-vector",
      sourceId: "old-target-source",
      score: 1
    });
  });

  it("makes the bounded degraded fallback and its deterministic truncation explicit", async () => {
    const database = await fixture();
    insertVector(database, {
      id: "00000000-old-target-vector",
      sourceId: "old-target-source",
      embedding: [1, 0],
      createdAt: "2000-01-01T00:00:00.000Z"
    });
    const insert = database.connection.prepare(`
      INSERT INTO vectors(
        id, source_id, source_type, model_id, dimensions, content_hash,
        embedding_version, embedding_json, created_at
      ) VALUES (?, ?, 'event', 'fixture', 2, ?, 'fixture-v1', '[0,1]', '2030-01-01T00:00:00.000Z')
    `);
    database.connection.transaction(() => {
      for (let index = 0; index < VECTOR_FALLBACK_MAX_ROWS + 1; index += 1) {
        const suffix = index.toString().padStart(5, "0");
        insert.run(`filler-vector-${suffix}`, `filler-source-${suffix}`, `filler-hash-${suffix}`);
      }
    })();
    database.vectorAvailable = false;

    const result = database.searchVectors([1, 0], "fixture", 10);
    expect(result).toMatchObject({
      mode: "bounded-cosine-fallback",
      strategy: "bounded-json-cosine",
      corpusRows: VECTOR_FALLBACK_MAX_ROWS + 2,
      rowsExamined: VECTOR_FALLBACK_MAX_ROWS,
      corpusTruncated: true,
      fallbackLimit: VECTOR_FALLBACK_MAX_ROWS,
      resultLimit: 10
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.matches).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceId: "old-target-source" })])
    );
  });

  it("deduplicates a source and resolves equal-distance ties by vector id", async () => {
    const database = await fixture();
    insertVector(database, {
      id: "z-vector",
      sourceId: "shared-source",
      embedding: [1, 0],
      createdAt: "2026-01-01T00:00:00.000Z"
    });
    insertVector(database, {
      id: "a-vector",
      sourceId: "shared-source",
      embedding: [1, 0],
      createdAt: "2026-01-02T00:00:00.000Z"
    });

    const result = database.searchVectors([1, 0], "fixture", 10);
    expect(result.matches).toEqual([
      { vectorId: "a-vector", sourceId: "shared-source", score: 1 }
    ]);
  });

  it.each([true, false])("isolates the corpus and matches to the exact embedding model (native=%s)", async (native) => {
    const database = await fixture();
    insertVector(database, {
      id: "selected-model-vector",
      sourceId: "selected-model-source",
      embedding: [0.8, 0.2],
      createdAt: "2026-01-01T00:00:00.000Z",
      modelId: "selected-model"
    });
    insertVector(database, {
      id: "other-model-perfect-vector",
      sourceId: "other-model-source",
      embedding: [1, 0],
      createdAt: "2026-01-02T00:00:00.000Z",
      modelId: "other-model"
    });
    database.vectorAvailable = native;

    const result = database.searchVectors([1, 0], "selected-model", 10);

    expect(result).toMatchObject({ corpusRows: 1, rowsExamined: 1, corpusTruncated: false });
    expect(result.matches).toEqual([
      expect.objectContaining({ vectorId: "selected-model-vector", sourceId: "selected-model-source" })
    ]);
  });

  it("rejects a vector query without an exact nonblank model id", async () => {
    const database = await fixture();
    expect(() => database.searchVectors([1, 0], "", 10)).toThrow(/exact embedding model/i);
    expect(() => database.searchVectors([1, 0], " fixture ", 10)).toThrow(/exact embedding model/i);
  });
});
