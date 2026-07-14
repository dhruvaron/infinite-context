import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { ContinuumDatabase } from "./index.js";
import { migrations } from "./migrations.js";

describe("schema migrations", () => {
  it("applies the contiguous raw migration ledger through exact-slot schema 18", async () => {
    const root = await mkdtemp(join(tmpdir(), "continuum-schema18-migration-"));
    const path = join(root, "continuum.sqlite3");
    let database: ContinuumDatabase | undefined;
    try {
      expect(migrations.map((migration) => migration.version)).toEqual(Array.from({ length: 18 }, (_, index) => index + 1));
      database = ContinuumDatabase.open(path);
      expect(database.connection.prepare("SELECT version FROM schema_migrations ORDER BY version").all())
        .toEqual(Array.from({ length: 18 }, (_, index) => ({ version: index + 1 })));
      const generation = (database.connection.prepare("PRAGMA table_info(topic_projection_dirty)").all() as Array<{ name: string; dflt_value: string | null; notnull: number }>)
        .find((column) => column.name === "generation");
      expect(generation).toMatchObject({ dflt_value: "1", notnull: 1 });
      const repairToken = (database.connection.prepare("PRAGMA table_info(topic_projection_dirty)").all() as Array<{ name: string; dflt_value: string | null; notnull: number }>)
        .find((column) => column.name === "repair_token");
      expect(repairToken).toMatchObject({ dflt_value: "''", notnull: 1 });
      expect(database.connection.prepare("SELECT normalization_version FROM claim_slot_index_state WHERE id = 1").get())
        .toEqual({ normalization_version: 3 });
    } finally {
      database?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs keys downgraded by the schema-14 UPDATE trigger during a schema-18 upgrade", async () => {
    const root = await mkdtemp(join(tmpdir(), "continuum-slot-index-migration-"));
    const path = join(root, "continuum.sqlite3");
    let initialized: ContinuumDatabase | undefined;
    let reopened: ContinuumDatabase | undefined;
    try {
      initialized = ContinuumDatabase.open(path);
      const source = initialized.appendEvent({ role: "user", content: "Remember the Unicode slot." });
      const topicId = "00000000-0000-4000-8000-000000000018";
      const claim = initialized.upsertClaim({
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

      // Recreate migration 14's UPDATE trigger, then exercise the real v17
      // failure mode: a metadata-only change overwrites both exact keys with
      // SQLite's lower(trim()) approximation.
      initialized.connection.exec(`
        DROP TRIGGER claims_slot_index_au;
        CREATE TRIGGER claims_slot_index_au AFTER UPDATE OF subject, predicate, topic_id, status ON claims BEGIN
          INSERT INTO claim_slot_index(claim_id, subject_key, predicate_key, topic_id, status, active_evidence)
          VALUES (new.id, lower(trim(new.subject)), lower(trim(new.predicate)), new.topic_id, new.status,
            COALESCE((SELECT active_evidence FROM claim_slot_index WHERE claim_id = new.id), 0))
          ON CONFLICT(claim_id) DO UPDATE SET
            subject_key = excluded.subject_key,
            predicate_key = excluded.predicate_key,
            topic_id = excluded.topic_id,
            status = excluded.status;
        END;
        UPDATE claim_slot_index_state SET normalization_version = 2 WHERE id = 1;
        DELETE FROM schema_migrations WHERE version = 18;
      `);
      initialized.connection.prepare("UPDATE claims SET status = 'conflicted' WHERE id = ?").run(claim.id);
      expect(initialized.listActiveClaimsForSlot("project name", "is named", topicId)).toEqual([]);
      initialized.close();
      initialized = undefined;

      reopened = ContinuumDatabase.open(path);
      expect(reopened.health().schemaVersion).toBe(18);
      expect(reopened.connection.prepare("SELECT subject_key, predicate_key FROM claim_slot_index WHERE claim_id = ?").get(claim.id)).toEqual({
        subject_key: "project name",
        predicate_key: "is named"
      });
      expect(reopened.connection.prepare("SELECT normalization_version FROM claim_slot_index_state WHERE id = 1").get())
        .toEqual({ normalization_version: 3 });
      expect(reopened.listActiveClaimsForSlot("project name", "is named", topicId)).toEqual([expect.objectContaining({ id: claim.id })]);
    } finally {
      initialized?.close();
      reopened?.close();
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
