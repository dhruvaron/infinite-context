import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { InstallationBudgetGuard, loadConfig, stableHash } from "@continuum/config";
import { ContinuumDatabase } from "./index.js";

type BudgetSummary = {
  hardLimitUsd: number;
  spentUsd: number;
  reservedUsd: number;
  allocatedUsd: number;
  availableUsd: number;
  remainingUsd: number;
  activeReservations: number;
};

const roots: string[] = [];

async function temporaryDatabase(): Promise<{ root: string; path: string; database: ContinuumDatabase }> {
  const root = await mkdtemp(join(tmpdir(), "continuum-budget-"));
  roots.push(root);
  const path = join(root, "continuum.sqlite3");
  return { root, path, database: ContinuumDatabase.open(path) };
}

async function temporaryConfiguredDatabase(): Promise<{
  root: string;
  database: ContinuumDatabase;
  ledger: InstallationBudgetGuard;
}> {
  const root = await mkdtemp(join(tmpdir(), "continuum-shared-budget-"));
  roots.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    CONTINUUM_DATA_DIR: root,
    CONTINUUM_SESSION_TOKEN: "shared-budget-test-session-token-32-characters"
  });
  return {
    root,
    database: ContinuumDatabase.open(config),
    ledger: new InstallationBudgetGuard(config.installationBudgetLedgerPath)
  };
}

function summary(database: ContinuumDatabase, cap = 100): BudgetSummary {
  return database.budgetSummary(cap) as unknown as BudgetSummary;
}

function successfulCall(database: ContinuumDatabase, reservationId: string, cost: number): string {
  return database.recordModelCall({
    provider: "openai",
    model: "gpt-5.6-luna",
    purpose: "response",
    promptVersion: "response-v1",
    inputTokens: 10,
    outputTokens: 5,
    latencyMs: 10,
    status: "complete",
    estimatedCostUsd: cost,
    reservationId
  });
}

function runReservationProcess(databasePath: string): Promise<number> {
  const databaseModule = pathToFileURL(join(import.meta.dirname, "index.ts")).href;
  const script = `
    import { ContinuumDatabase } from ${JSON.stringify(databaseModule)};
    const database = ContinuumDatabase.open(process.env.CONTINUUM_TEST_DATABASE_PATH);
    try {
      database.reserveBudget(100, 20, "cross-process");
      process.exitCode = 0;
    } catch (error) {
      process.exitCode = error instanceof Error && error.name === "BudgetExceededError" ? 2 : 3;
    } finally {
      database.close();
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: join(import.meta.dirname, "../../.."),
      env: { ...process.env, CONTINUUM_TEST_DATABASE_PATH: databasePath },
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 3 || code === null) reject(new Error(`Reservation subprocess failed: ${stderr}`));
      else resolve(code);
    });
  });
}

function runSettlementProcess(databasePath: string, reservationId: string): Promise<number> {
  const databaseModule = pathToFileURL(join(import.meta.dirname, "index.ts")).href;
  const script = `
    import { ContinuumDatabase } from ${JSON.stringify(databaseModule)};
    const database = ContinuumDatabase.open(process.env.CONTINUUM_TEST_DATABASE_PATH);
    try {
      database.recordModelCall({
        provider: "openai", model: "gpt-5.6-luna", purpose: "response", promptVersion: "response-v1",
        inputTokens: 10, outputTokens: 5, latencyMs: 10, status: "complete", estimatedCostUsd: 0.2,
        reservationId: process.env.CONTINUUM_TEST_RESERVATION_ID
      });
      process.exitCode = 0;
    } catch {
      process.exitCode = 3;
    } finally {
      database.close();
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: join(import.meta.dirname, "../../.."),
      env: { ...process.env, CONTINUUM_TEST_DATABASE_PATH: databasePath, CONTINUUM_TEST_RESERVATION_ID: reservationId },
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(code) : reject(new Error(`Settlement subprocess failed: ${stderr}`)));
  });
}

function runSharedAuthorityProcess(root: string, kind: "application" | "evaluation", amount: number): Promise<number> {
  const databaseModule = pathToFileURL(join(import.meta.dirname, "index.ts")).href;
  const configModule = pathToFileURL(join(import.meta.dirname, "../../config/src/index.ts")).href;
  const script = `
    import { InstallationBudgetGuard, loadConfig } from ${JSON.stringify(configModule)};
    import { ContinuumDatabase } from ${JSON.stringify(databaseModule)};
    const config = loadConfig({
      NODE_ENV: "test",
      CONTINUUM_DATA_DIR: process.env.CONTINUUM_TEST_SHARED_ROOT,
      CONTINUUM_SESSION_TOKEN: "cross-process-shared-budget-session-token"
    });
    let database = null;
    try {
      if (process.env.CONTINUUM_TEST_SHARED_KIND === "application") {
        database = ContinuumDatabase.open(config);
        database.reserveBudget(100, Number(process.env.CONTINUUM_TEST_SHARED_AMOUNT), "response");
      } else {
        const budget = new InstallationBudgetGuard(config.installationBudgetLedgerPath);
        budget.reserve({
          callId: "cross-process-evaluation",
          category: "final_evaluation",
          estimatedCostUsd: Number(process.env.CONTINUUM_TEST_SHARED_AMOUNT),
          essential: true
        });
      }
      process.exitCode = 0;
    } catch (error) {
      process.exitCode = error instanceof Error && error.name === "BudgetExceededError" ? 2 : 3;
    } finally {
      database?.close();
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd: join(import.meta.dirname, "../../.."),
      env: {
        ...process.env,
        CONTINUUM_TEST_SHARED_ROOT: root,
        CONTINUUM_TEST_SHARED_KIND: kind,
        CONTINUUM_TEST_SHARED_AMOUNT: String(amount)
      },
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 3 || code === null) reject(new Error(`Shared-authority subprocess failed: ${stderr}`));
      else resolve(code);
    });
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("installation-wide hard budget", () => {
  it("counts the complete SQLite mirror after reopen and never grants a fresh cycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "continuum-shared-lifetime-budget-"));
    roots.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      CONTINUUM_DATA_DIR: root,
      CONTINUUM_SESSION_TOKEN: "lifetime-budget-mirror-test-session-token"
    });
    const first = ContinuumDatabase.open(config);
    const reservation = first.reserveBudget(100, 1, "response");
    successfulCall(first, reservation, 1);
    first.close();

    const reopened = ContinuumDatabase.open(config);
    try {
      expect(summary(reopened)).toMatchObject({ spentUsd: 1, reservedUsd: 0, allocatedUsd: 1, availableUsd: 99 });
      expect(() => reopened.reserveBudget(100, 100, "response")).toThrow(/100|budget limit/i);
      expect(summary(reopened)).toMatchObject({ spentUsd: 1, reservedUsd: 0, allocatedUsd: 1, availableUsd: 99 });
    } finally {
      reopened.close();
    }
  });

  it("repairs a dead pre-provider reservation stranded between canonical and SQLite admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "continuum-shared-budget-orphan-"));
    roots.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      CONTINUUM_DATA_DIR: root,
      CONTINUUM_SESSION_TOKEN: "orphan-budget-test-session-token-32-characters"
    });
    const guard = new InstallationBudgetGuard(config.installationBudgetLedgerPath);
    guard.reserve({
      callId: "stranded-before-sqlite",
      category: "application",
      estimatedCostUsd: 3,
      essential: true,
      ownerPid: 2_147_483_647,
      ownerScope: stableHash(`continuum-vault:${config.databasePath}`),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    });
    const database = ContinuumDatabase.open(config);
    try {
      expect(guard.snapshot().entries.find((entry) => entry.callId === "stranded-before-sqlite")?.status).toBe("released");
      expect(summary(database)).toMatchObject({ allocatedUsd: 0, availableUsd: 100 });
    } finally {
      database.close();
    }
  });

  it("rejects evaluation credit above the aggregate cap after application credit is reserved", async () => {
    const { database, ledger } = await temporaryConfiguredDatabase();
    try {
      const applicationReservation = database.reserveBudget(100, 90, "response");
      expect(() => ledger.reserve({
        callId: "evaluation-after-application",
        category: "final_evaluation",
        estimatedCostUsd: 11,
        essential: true
      })).toThrow(/100/);
      expect(summary(database)).toMatchObject({ allocatedUsd: 90, availableUsd: 10 });
      database.releaseBudgetReservation(applicationReservation);
    } finally {
      database.close();
    }
  });

  it("rejects application credit above the aggregate cap after evaluation allocations are reserved", async () => {
    const { database, ledger } = await temporaryConfiguredDatabase();
    try {
      ledger.reserve({ callId: "evaluation-development", category: "development", estimatedCostUsd: 25, essential: true });
      ledger.reserve({ callId: "evaluation-final", category: "final_evaluation", estimatedCostUsd: 60, essential: true });
      ledger.reserve({ callId: "evaluation-contingency", category: "contingency", estimatedCostUsd: 5, essential: true });
      expect(() => database.reserveBudget(100, 11, "response")).toThrow(/100/);
      expect(summary(database)).toMatchObject({ allocatedUsd: 90, availableUsd: 10 });
    } finally {
      database.close();
    }
  });

  it("atomically admits only one side of a racing application USD 90 and evaluation USD 11 plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "continuum-shared-budget-race-"));
    roots.push(root);
    const exitCodes = await Promise.all([
      runSharedAuthorityProcess(root, "application", 90),
      runSharedAuthorityProcess(root, "evaluation", 11)
    ]);
    expect(exitCodes.sort()).toEqual([0, 2]);
    const guard = new InstallationBudgetGuard(join(root, "installation-budget-ledger.json"));
    const snapshot = guard.snapshot();
    expect(snapshot.committedUsd + snapshot.reservedUsd).toBeLessThanOrEqual(100);
    expect([11, 90]).toContain(snapshot.committedUsd + snapshot.reservedUsd);
  }, 30_000);

  it("reports spent, reserved, allocated, and available amounts explicitly", async () => {
    const { database } = await temporaryDatabase();
    try {
      const reservationId = database.reserveBudget(1, 0.4, "response");
      expect(summary(database, 1)).toMatchObject({
        hardLimitUsd: 1,
        spentUsd: 0,
        reservedUsd: 0.4,
        allocatedUsd: 0.4,
        availableUsd: 0.6,
        remainingUsd: 0.6,
        activeReservations: 1
      });
      database.releaseBudgetReservation(reservationId);
      expect(summary(database, 1)).toMatchObject({ spentUsd: 0, reservedUsd: 0, allocatedUsd: 0, availableUsd: 1 });
    } finally {
      database.close();
    }
  });

  it("uses spent plus reserved for both admission and warning thresholds", async () => {
    const { database } = await temporaryDatabase();
    try {
      database.reserveBudget(100, 21, "response");
      expect(() => database.reserveBudget(100, 80, "response")).toThrowError(/budget limit/i);
      const warning = database.connection.prepare("SELECT value_json FROM settings WHERE key = 'budget.warning.20'").get() as { value_json: string } | undefined;
      expect(warning).toBeDefined();
      expect(summary(database)).toMatchObject({ spentUsd: 0, reservedUsd: 21, allocatedUsd: 21, availableUsd: 79 });
    } finally {
      database.close();
    }
  });

  it("serializes adversarial reservations across independent OS processes", async () => {
    const { path, database } = await temporaryDatabase();
    database.close();
    const exitCodes = await Promise.all(Array.from({ length: 8 }, () => runReservationProcess(path)));
    expect(exitCodes.filter((code) => code === 0)).toHaveLength(5);
    expect(exitCodes.filter((code) => code === 2)).toHaveLength(3);
    const reopened = ContinuumDatabase.open(path);
    try {
      expect(summary(reopened)).toMatchObject({ spentUsd: 0, reservedUsd: 100, allocatedUsd: 100, availableUsd: 0, activeReservations: 5 });
    } finally {
      reopened.close();
    }
  }, 30_000);

  it("settles one reservation exactly once across racing OS processes", async () => {
    const { path, database } = await temporaryDatabase();
    const reservationId = database.reserveBudget(1, 0.3, "response");
    database.close();
    await Promise.all([runSettlementProcess(path, reservationId), runSettlementProcess(path, reservationId)]);
    const reopened = ContinuumDatabase.open(path);
    try {
      expect(summary(reopened, 1)).toMatchObject({ spentUsd: 0.2, reservedUsd: 0, allocatedUsd: 0.2 });
      expect(reopened.connection.prepare("SELECT COUNT(*) AS count FROM model_calls").get()).toEqual({ count: 1 });
      expect(reopened.connection.prepare("SELECT COUNT(*) AS count FROM installation_budget_ledger WHERE reservation_id = ?").get(reservationId)).toEqual({ count: 1 });
    } finally {
      reopened.close();
    }
  }, 30_000);

  it("conservatively settles expiry and reconciles a late success exactly once", async () => {
    const { database } = await temporaryDatabase();
    try {
      const reservationId = database.reserveBudget(1, 0.4, "response");
      database.connection.prepare("UPDATE budget_reservations SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(reservationId);
      expect(summary(database, 1)).toMatchObject({ spentUsd: 0.4, reservedUsd: 0, allocatedUsd: 0.4 });

      const firstModelCallId = successfulCall(database, reservationId, 0.6);
      const repeatedModelCallId = successfulCall(database, reservationId, 0.5);
      expect(repeatedModelCallId).toBe(firstModelCallId);
      expect(summary(database, 1)).toMatchObject({ spentUsd: 0.6, reservedUsd: 0, allocatedUsd: 0.6, availableUsd: 0.4 });
      expect(database.connection.prepare("SELECT COUNT(*) AS count FROM model_calls").get()).toEqual({ count: 1 });
      expect(database.connection.prepare("SELECT COUNT(*) AS count FROM installation_budget_ledger WHERE reservation_id = ?").get(reservationId)).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("charges all outstanding uncertainty before maintenance clears portable rows", async () => {
    const { path, database } = await temporaryDatabase();
    database.reserveBudget(1, 0.3, "memory");
    expect(database.reconcileOutstandingBudgetReservations("test_reset")).toBe(1);
    database.connection.transaction(() => {
      database.connection.prepare("DELETE FROM budget_ledger").run();
      database.connection.prepare("DELETE FROM budget_reservations").run();
    })();
    expect(summary(database, 1)).toMatchObject({ spentUsd: 0.3, reservedUsd: 0, allocatedUsd: 0.3 });
    database.close();

    const reopened = ContinuumDatabase.open(path);
    try {
      expect(summary(reopened, 1)).toMatchObject({ spentUsd: 0.3, availableUsd: 0.7 });
    } finally {
      reopened.close();
    }
  });

  it("preserves uncertain spend when hard deletion removes a run and its portable reservation", async () => {
    const { database } = await temporaryDatabase();
    try {
      const event = database.appendEvent({ role: "user", kind: "message", status: "complete", content: "delete this run" });
      const run = database.createRun(event.id, "fast");
      database.reserveBudget(1, 0.25, "response", run.id);
      database.hardDeleteEvent(event.id);
      expect(summary(database, 1)).toMatchObject({ spentUsd: 0.25, reservedUsd: 0, allocatedUsd: 0.25, availableUsd: 0.75 });
      expect(database.connection.prepare("SELECT COUNT(*) AS count FROM installation_budget_ledger").get()).toEqual({ count: 1 });
      expect(database.connection.prepare("SELECT COUNT(*) AS count FROM budget_reservations").get()).toEqual({ count: 0 });
      expect(database.connection.prepare(`
        SELECT reservation_id, model_call_id, category, provider, model, input_tokens, output_tokens, created_at
        FROM installation_budget_ledger
      `).get()).toEqual({
        reservation_id: null,
        model_call_id: null,
        category: "redacted",
        provider: "redacted",
        model: "redacted",
        input_tokens: 0,
        output_tokens: 0,
        created_at: "1970-01-01T00:00:00.000Z"
      });
      expect(database.connection.prepare("SELECT COUNT(*) AS count FROM budget_ledger").get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("retains only positive installation cost when destructive maintenance scrubs metadata", async () => {
    const { database } = await temporaryDatabase();
    try {
      const freeReservation = database.reserveBudget(1, 0, "free-diagnostic");
      successfulCall(database, freeReservation, 0);
      const paidReservation = database.reserveBudget(1, 0.2, "private-project-response");
      successfulCall(database, paidReservation, 0.2);

      expect(database.scrubInstallationBudgetMetadata()).toEqual({ redacted: 1, removed: 1 });
      expect(summary(database, 1)).toMatchObject({ spentUsd: 0.2, inputTokens: 0, outputTokens: 0, calls: 1 });
      expect(database.connection.prepare("SELECT category, provider, model, reservation_id, model_call_id FROM installation_budget_ledger").get()).toEqual({
        category: "redacted",
        provider: "redacted",
        model: "redacted",
        reservation_id: null,
        model_call_id: null
      });
    } finally {
      database.close();
    }
  });

  it("rejects paid accounting without a matching reservation", async () => {
    const { database } = await temporaryDatabase();
    try {
      let name = "";
      try {
        database.recordModelCall({
          provider: "openai",
          model: "gpt-5.6-luna",
          purpose: "response",
          promptVersion: "response-v1",
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 1,
          status: "complete",
          estimatedCostUsd: 0.01
        });
      } catch (error) {
        name = error instanceof Error ? error.name : "";
      }
      expect(name).toBe("BudgetReservationRequiredError");
      expect(summary(database)).toMatchObject({ spentUsd: 0, reservedUsd: 0 });
    } finally {
      database.close();
    }
  });
});
