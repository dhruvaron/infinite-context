import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ContinuumDatabase } from "./index.js";

const fixtures: Array<{ root: string; database: ContinuumDatabase }> = [];

async function fixture(): Promise<ContinuumDatabase> {
  const root = await mkdtemp(join(tmpdir(), "continuum-job-queue-"));
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

describe("durable job leasing", () => {
  it("makes the maintenance lock part of lease admission", async () => {
    const database = await fixture();
    const queued = database.enqueueJob("memory.compile", "maintenance-lease-test", { sourceEventIds: [] });
    database.setSetting("maintenance.locked", true);

    expect(database.leaseJob("worker-1", 30_000, ["memory.compile"])).toBeNull();
    expect(database.listJobs(10)).toContainEqual(expect.objectContaining({ id: queued.id, status: "queued", attempts: 0 }));

    database.setSetting("maintenance.locked", false);
    expect(database.leaseJob("worker-1", 30_000, ["memory.compile"])).toMatchObject({ id: queued.id, status: "running", attempts: 1 });
  });
});
