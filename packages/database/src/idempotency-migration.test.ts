import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ContinuumDatabase } from "./index.js";
import { migrations } from "./migrations.js";

describe("operation-scoped idempotency migration", () => {
  it("applies the contiguous raw migration ledger through generation-CAS schema 17", async () => {
    const root = await mkdtemp(join(tmpdir(), "continuum-schema17-migration-"));
    const path = join(root, "continuum.sqlite3");
    let database: ContinuumDatabase | undefined;
    try {
      expect(migrations.map((migration) => migration.version)).toEqual(Array.from({ length: 17 }, (_, index) => index + 1));
      database = ContinuumDatabase.open(path);
      expect(database.connection.prepare("SELECT version FROM schema_migrations ORDER BY version").all())
        .toEqual(Array.from({ length: 17 }, (_, index) => ({ version: index + 1 })));
      const generation = (database.connection.prepare("PRAGMA table_info(topic_projection_dirty)").all() as Array<{ name: string; dflt_value: string | null; notnull: number }>)
        .find((column) => column.name === "generation");
      expect(generation).toMatchObject({ dflt_value: "1", notnull: 1 });
      const repairToken = (database.connection.prepare("PRAGMA table_info(topic_projection_dirty)").all() as Array<{ name: string; dflt_value: string | null; notnull: number }>)
        .find((column) => column.name === "repair_token");
      expect(repairToken).toMatchObject({ dflt_value: "''", notnull: 1 });
    } finally {
      database?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves existing responses while allowing the same key in another operation namespace", async () => {
    const root = await mkdtemp(join(tmpdir(), "continuum-idempotency-migration-"));
    const path = join(root, "continuum.sqlite3");
    let reopened: ContinuumDatabase | undefined;
    try {
      const initialized = ContinuumDatabase.open(path);
      initialized.close();

      // Recreate the version-5 table shape with a real stored response, then
      // make the production migrator perform the version-6 upgrade while the
      // independent installation-budget migration remains at version 7.
      const legacy = new Database(path);
      legacy.exec(`
        DROP TABLE idempotency_keys;
        CREATE TABLE idempotency_keys (
          key TEXT PRIMARY KEY,
          operation TEXT NOT NULL,
          response_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO idempotency_keys(key, operation, response_json, created_at)
          VALUES ('shared-key', 'topics.create', '{"id":"preserved"}', '2026-07-13T00:00:00.000Z');
        DELETE FROM schema_migrations WHERE version = 6;
      `);
      legacy.close();

      reopened = ContinuumDatabase.open(path);
      expect(reopened.health().schemaVersion).toBe(migrations.at(-1)?.version);
      expect(reopened.idempotentResponse("shared-key", "topics.create")).toEqual({ id: "preserved" });
      reopened.rememberIdempotentResponse("shared-key", "topics.patch", { revision: 2 });
      expect(reopened.idempotentResponse("shared-key", "topics.patch")).toEqual({ revision: 2 });
      expect(reopened.connection.prepare("SELECT COUNT(*) AS count FROM idempotency_keys WHERE key = 'shared-key'").get()).toEqual({ count: 2 });
    } finally {
      reopened?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
