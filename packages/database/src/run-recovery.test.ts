import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ContinuumDatabase } from "./index.js";

const fixtures: Array<{ root: string; database: ContinuumDatabase }> = [];
const recoveryCases: Array<[label: string, deltas: string[], checkpoint: string]> = [
  ["a response shorter than the periodic checkpoint", ["small ", "exact tail"], ""],
  ["a tail after a periodic checkpoint", ["x".repeat(180), " and the exact non-boundary tail"], "x".repeat(180)]
];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "continuum-run-recovery-"));
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

describe("interrupted run recovery", () => {
  it.each(recoveryCases)("reconstructs %s from durable deltas and keeps it exact across repeated reloads", async (_label, deltas, checkpoint) => {
    const value = await fixture();
    const user = value.database.appendEvent({ role: "user", content: "start" });
    const run = value.database.createRun(user.id, "balanced");
    expect(value.database.claimRunForExecution(run.id)).toBe(true);
    const assistant = value.database.appendEvent({ role: "assistant", status: "streaming", content: "", parentEventId: user.id, runId: run.id });
    value.database.setRunStatus(run.id, "streaming", { assistantEventId: assistant.id });
    for (const delta of deltas) value.database.appendRunStreamEvent(run.id, { type: "response.delta", runId: run.id, eventId: assistant.id, delta });
    // Simulate the production batching behavior: the canonical event can lag
    // the durable stream by a non-boundary tail when the process dies.
    if (checkpoint) value.database.updateStreamingEvent(assistant.id, checkpoint);

    expect(value.database.recoverInterruptedRuns()).toEqual([run.id]);
    expect(value.database.getEvent(assistant.id)?.content).toBe(deltas.join(""));
    expect(value.database.getEvent(assistant.id)?.status).toBe("incomplete");
    expect(value.database.getEvent(assistant.id)?.active).toBe(true);
    expect(value.database.listEvents({ limit: 10 }).map((event) => event.id)).toContain(assistant.id);

    value.database.close();
    value.database = ContinuumDatabase.open(join(value.root, "continuum.sqlite3"));
    expect(value.database.recoverInterruptedRuns()).toEqual([]);
    expect(value.database.getEvent(assistant.id)?.content).toBe(deltas.join(""));

    value.database.close();
    value.database = ContinuumDatabase.open(join(value.root, "continuum.sqlite3"));
    expect(value.database.getEvent(assistant.id)?.content).toBe(deltas.join(""));
  });
});
