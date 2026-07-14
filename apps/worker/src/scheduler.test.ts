import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@continuum/config";
import { ContinuumDatabase } from "@continuum/database";
import { enqueueIdleLintIfDue } from "./scheduler.js";

const fixtures: Array<{ root: string; database: ContinuumDatabase }> = [];

afterEach(async () => {
  while (fixtures.length) {
    const value = fixtures.pop()!;
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

async function fixture(): Promise<ContinuumDatabase> {
  const root = await mkdtemp(join(tmpdir(), "continuum-idle-lint-"));
  const database = ContinuumDatabase.open(loadConfig({ NODE_ENV: "test", CONTINUUM_DATA_DIR: root, CONTINUUM_SESSION_TOKEN: "test-session-token-that-is-at-least-32-characters" }));
  fixtures.push({ root, database });
  return database;
}

describe("idle memory lint scheduler", () => {
  it("enqueues once per UTC day only after five idle minutes", async () => {
    const database = await fixture();
    const current = Date.parse("2026-07-13T12:10:00.000Z");
    const event = database.appendEvent({ role: "user", content: "old activity" });
    database.connection.prepare("UPDATE events SET created_at = ? WHERE id = ?").run("2026-07-13T12:04:59.000Z", event.id);

    expect(enqueueIdleLintIfDue(database, current)).toBe(true);
    expect(database.listJobs()).toEqual([expect.objectContaining({ type: "memory.lint", status: "queued" })]);
    expect(enqueueIdleLintIfDue(database, current + 60_000)).toBe(false);
  });

  it("waits while work is active or conversation activity is recent", async () => {
    const database = await fixture();
    const current = Date.now();
    const event = database.appendEvent({ role: "user", content: "recent activity" });
    expect(enqueueIdleLintIfDue(database, current)).toBe(false);
    database.connection.prepare("UPDATE events SET created_at = ? WHERE id = ?").run(new Date(current - 10 * 60_000).toISOString(), event.id);
    database.enqueueJob("embedding.index", "active-job", { sourceId: event.id });
    expect(enqueueIdleLintIfDue(database, current)).toBe(false);
  });
});
