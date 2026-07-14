import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";

export type EvaluationBudgetCategory = "development" | "final_evaluation" | "contingency";
export type InstallationBudgetCategory = EvaluationBudgetCategory | "application";

export interface InstallationBudgetEntry {
  callId: string;
  category: InstallationBudgetCategory;
  estimatedCostUsd: number;
  actualCostUsd: number | null;
  essential: boolean;
  status: "reserved" | "committed" | "released";
  createdAt: string;
}

export interface InstallationBudgetSnapshot {
  hardCapUsd: 100;
  committedUsd: number;
  reservedUsd: number;
  remainingUsd: number;
  warningThresholdsReached: number[];
  entries: InstallationBudgetEntry[];
  durable: true;
  ledgerPath: string;
  breached: boolean;
  ledgerCreatedAt: string;
}

export class InstallationBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export const INSTALLATION_BUDGET_HARD_CAP_USD = 100 as const;
export const INSTALLATION_BUDGET_ALLOCATIONS_USD: Readonly<Record<EvaluationBudgetCategory, number>> = Object.freeze({
  development: 25,
  final_evaluation: 60,
  contingency: 15
});

type AccountingBasis =
  | "reservation"
  | "usage-priced-locally"
  | "provider-reported"
  | "conservative-uncertain-failure"
  | "released-before-call";

interface DurableInstallationBudgetEntry extends InstallationBudgetEntry {
  updatedAt: string;
  overrun: boolean;
  accountingBasis: AccountingBasis;
  ownerPid: number | null;
  ownerScope: string | null;
  expiresAt: string | null;
}

interface DurableInstallationBudgetLedger {
  schemaVersion: 1;
  hardCapUsd: 100;
  allocationsUsd: Record<EvaluationBudgetCategory, number>;
  createdAt: string;
  updatedAt: string;
  breached: boolean;
  entries: DurableInstallationBudgetEntry[];
}

export interface LegacyInstallationBudgetEntry {
  callId: string;
  category: InstallationBudgetCategory;
  estimatedCostUsd: number;
  actualCostUsd: number | null;
  status: "reserved" | "committed";
  createdAt: string;
}

const NONESSENTIAL_STOP_USD = 95;
const WARNING_THRESHOLDS_USD = [20, 50, 75, 90] as const;
const CATEGORIES = new Set<InstallationBudgetCategory>([
  "application",
  "development",
  "final_evaluation",
  "contingency"
]);
const ALLOCATED_CATEGORIES = new Set<EvaluationBudgetCategory>([
  "development",
  "final_evaluation",
  "contingency"
]);
const STATUSES = new Set<InstallationBudgetEntry["status"]>(["reserved", "committed", "released"]);
const ACCOUNTING_BASES = new Set<AccountingBasis>([
  "reservation",
  "usage-priced-locally",
  "provider-reported",
  "conservative-uncertain-failure",
  "released-before-call"
]);

function finiteMoney(value: number, description: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${description} must be finite and non-negative`);
  return value;
}

function wait(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function timestamp(value: unknown, description: string): string {
  if (typeof value !== "string" || !Number.isFinite(new Date(value).valueOf())) {
    throw new Error(`${description} must be an ISO-compatible timestamp`);
  }
  return value;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * One machine-local accounting authority shared by application and evaluation
 * processes. Its file lock covers read, admission, mutation, fsync, and atomic
 * replacement, so a SQLite transaction in another vault can never create a
 * second independent USD 100 allowance.
 */
export class InstallationBudgetGuard {
  readonly ledgerPath: string;
  readonly lockPath: string;
  readonly #now: () => string;
  readonly #conservativeFailures: boolean;
  #activeLock: { token: string; device: number | bigint; inode: number | bigint } | null = null;

  constructor(path: string, options: { now?: () => string; conservativeFailures?: boolean } = {}) {
    this.ledgerPath = resolve(path);
    this.lockPath = `${this.ledgerPath}.lock`;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#conservativeFailures = options.conservativeFailures ?? true;
    mkdirSync(dirname(this.ledgerPath), { recursive: true, mode: 0o700 });
    this.#withLock(() => {
      if (!existsSync(this.ledgerPath)) this.#write(this.#empty());
      else this.#read();
    });
  }

  reserve(input: {
    callId: string;
    category: InstallationBudgetCategory;
    estimatedCostUsd: number;
    essential: boolean;
    createdAt?: string;
    hardLimitUsd?: number;
    ownerPid?: number;
    ownerScope?: string;
    expiresAt?: string;
  }): InstallationBudgetEntry {
    finiteMoney(input.estimatedCostUsd, "Estimated cost");
    if (!CATEGORIES.has(input.category)) throw new Error(`Unknown installation budget category: ${input.category}`);
    const effectiveCap = input.hardLimitUsd ?? INSTALLATION_BUDGET_HARD_CAP_USD;
    if (!Number.isFinite(effectiveCap) || effectiveCap <= 0 || effectiveCap > INSTALLATION_BUDGET_HARD_CAP_USD) {
      throw new RangeError("The API hard limit must be greater than zero and at most USD 100.");
    }
    return this.#withLock(() => {
      const ledger = this.#read();
      if (ledger.entries.some((entry) => entry.callId === input.callId)) {
        throw new Error(`Duplicate budget call ID: ${input.callId}`);
      }
      const snapshot = this.#snapshot(ledger);
      const projected = snapshot.committedUsd + snapshot.reservedUsd + input.estimatedCostUsd;
      if (ledger.breached || projected > effectiveCap) {
        throw new InstallationBudgetExceededError(
          `The durable USD ${effectiveCap.toFixed(2)} API-credit hard cap would be exceeded`
        );
      }
      if (!input.essential && projected >= NONESSENTIAL_STOP_USD) {
        throw new InstallationBudgetExceededError("Nonessential live runs stop at USD 95 to preserve diagnosis credit");
      }
      this.#assertAllocationAvailable(ledger, input.category, input.estimatedCostUsd);
      const createdAt = input.createdAt ?? this.#now();
      if ((input.ownerPid === undefined) !== (input.ownerScope === undefined)) throw new Error("Reservation owner PID and scope must be supplied together.");
      if (input.ownerPid !== undefined && (!Number.isSafeInteger(input.ownerPid) || input.ownerPid <= 0)) throw new Error("Reservation owner PID is invalid.");
      if (input.ownerScope !== undefined && (!input.ownerScope.trim() || input.ownerScope.length > 500)) throw new Error("Reservation owner scope is invalid.");
      const expiresAt = input.expiresAt === undefined ? null : timestamp(input.expiresAt, `Reservation expiry ${input.callId}`);
      const entry: DurableInstallationBudgetEntry = {
        callId: input.callId,
        category: input.category,
        estimatedCostUsd: input.estimatedCostUsd,
        actualCostUsd: null,
        essential: input.essential,
        status: "reserved",
        createdAt,
        updatedAt: createdAt,
        overrun: false,
        accountingBasis: "reservation",
        ownerPid: input.ownerPid ?? null,
        ownerScope: input.ownerScope ?? null,
        expiresAt
      };
      ledger.entries.push(entry);
      ledger.updatedAt = this.#now();
      this.#write(ledger);
      return this.#publicEntry(entry);
    });
  }

  /**
   * Releases only application reservations that provably died before their
   * vault-local admission row was created. A provider call cannot begin before
   * that row exists, so this repairs the cross-store crash gap without
   * forgiving an uncertain or billable call.
   */
  releaseOrphanedBeforeCall(input: { ownerScope: string; admittedCallIds: ReadonlySet<string> }): string[] {
    if (!input.ownerScope.trim()) throw new Error("Reservation owner scope is required.");
    return this.#withLock(() => {
      const ledger = this.#read();
      const released: string[] = [];
      for (let index = 0; index < ledger.entries.length; index += 1) {
        const entry = ledger.entries[index]!;
        if (entry.status !== "reserved" || entry.category !== "application" || entry.ownerScope !== input.ownerScope) continue;
        if (input.admittedCallIds.has(entry.callId) || entry.ownerPid === null || processIsAlive(entry.ownerPid)) continue;
        ledger.entries[index] = {
          ...entry,
          status: "released",
          actualCostUsd: null,
          updatedAt: this.#now(),
          accountingBasis: "released-before-call"
        };
        released.push(entry.callId);
      }
      if (released.length) {
        ledger.updatedAt = this.#now();
        this.#write(ledger);
      }
      return released;
    });
  }

  commit(callId: string, actualCostUsd: number): InstallationBudgetEntry {
    return this.#commit(callId, actualCostUsd, "usage-priced-locally");
  }

  commitConservatively(callId: string, actualCostUsd: number): InstallationBudgetEntry {
    return this.#commit(callId, actualCostUsd, "conservative-uncertain-failure");
  }

  /** Reconciles a late or racing completion without ever lowering a charge. */
  reconcileCommitted(callId: string, actualCostUsd: number): InstallationBudgetEntry {
    finiteMoney(actualCostUsd, "Actual cost");
    return this.#withLock(() => {
      const ledger = this.#read();
      const index = ledger.entries.findIndex((entry) => entry.callId === callId);
      const entry = ledger.entries[index];
      if (!entry) throw new Error(`No installation budget reservation: ${callId}`);
      if (entry.status === "released") throw new Error(`Released installation budget reservation: ${callId}`);
      if (entry.status === "reserved") {
        const result = this.#commitEntry(ledger, index, actualCostUsd, "usage-priced-locally");
        this.#write(ledger);
        if (result.violation) throw this.#overrunError();
        return this.#publicEntry(result.entry);
      }
      const reconciledCost = Math.max(entry.actualCostUsd ?? 0, actualCostUsd);
      if (reconciledCost === entry.actualCostUsd) return this.#publicEntry(entry);
      const priorCost = entry.actualCostUsd ?? 0;
      const capOverrun = this.#snapshot(ledger).committedUsd - priorCost + reconciledCost > INSTALLATION_BUDGET_HARD_CAP_USD;
      const allocationOverrun = this.#allocationWouldOverrun(ledger, entry.category, reconciledCost - priorCost);
      const reconciled: DurableInstallationBudgetEntry = {
        ...entry,
        actualCostUsd: reconciledCost,
        updatedAt: this.#now(),
        overrun: entry.overrun || capOverrun || allocationOverrun || reconciledCost > entry.estimatedCostUsd
      };
      ledger.entries[index] = reconciled;
      ledger.breached ||= capOverrun || allocationOverrun;
      ledger.updatedAt = this.#now();
      this.#write(ledger);
      if (capOverrun || allocationOverrun) throw this.#overrunError();
      return this.#publicEntry(reconciled);
    });
  }

  /** Evaluation failures are conservatively billable unless configured otherwise. */
  release(callId: string): void {
    this.#withLock(() => {
      const ledger = this.#read();
      const index = ledger.entries.findIndex((entry) => entry.callId === callId);
      const entry = ledger.entries[index];
      if (!entry || entry.status !== "reserved") return;
      ledger.entries[index] = this.#conservativeFailures
        ? {
            ...entry,
            status: "committed",
            actualCostUsd: entry.estimatedCostUsd,
            updatedAt: this.#now(),
            accountingBasis: "conservative-uncertain-failure"
          }
        : { ...entry, status: "released", updatedAt: this.#now(), accountingBasis: "released-before-call" };
      ledger.updatedAt = this.#now();
      this.#write(ledger);
    });
  }

  /** Known pre-call cancellation releases credit; no provider request occurred. */
  releaseBeforeCall(callId: string): void {
    this.#withLock(() => {
      const ledger = this.#read();
      const index = ledger.entries.findIndex((entry) => entry.callId === callId);
      const entry = ledger.entries[index];
      if (!entry || entry.status !== "reserved") return;
      ledger.entries[index] = {
        ...entry,
        status: "released",
        actualCostUsd: null,
        updatedAt: this.#now(),
        accountingBasis: "released-before-call"
      };
      ledger.updatedAt = this.#now();
      this.#write(ledger);
    });
  }

  snapshot(): InstallationBudgetSnapshot {
    return this.#withLock(() => {
      const ledger = this.#read();
      return {
        ...this.#snapshot(ledger),
        durable: true,
        ledgerPath: this.ledgerPath,
        breached: ledger.breached,
        ledgerCreatedAt: ledger.createdAt
      };
    });
  }

  assertCanReserveTotal(input: {
    category: InstallationBudgetCategory;
    estimatedCostUsd: number;
    essential: boolean;
  }): void {
    finiteMoney(input.estimatedCostUsd, "Planned cost");
    if (!CATEGORIES.has(input.category)) throw new Error(`Unknown installation budget category: ${input.category}`);
    this.#withLock(() => {
      const ledger = this.#read();
      const snapshot = this.#snapshot(ledger);
      const projected = snapshot.committedUsd + snapshot.reservedUsd + input.estimatedCostUsd;
      if (ledger.breached || projected > INSTALLATION_BUDGET_HARD_CAP_USD) {
        throw new InstallationBudgetExceededError("The complete live plan does not fit beneath the durable USD 100 hard cap");
      }
      if (!input.essential && projected >= NONESSENTIAL_STOP_USD) {
        throw new InstallationBudgetExceededError("The complete nonessential live plan reaches the USD 95 reserve threshold");
      }
      this.#assertAllocationAvailable(ledger, input.category, input.estimatedCostUsd, "The complete live plan exceeds");
    });
  }

  /**
   * Imports pre-canonical application accounting exactly once. Charges are
   * added to, never substituted for, existing evaluation spend; any historical
   * overflow marks the authority breached and blocks new paid calls.
   */
  reconcileLegacyEntries(entries: readonly LegacyInstallationBudgetEntry[]): InstallationBudgetSnapshot {
    return this.#withLock(() => {
      const ledger = this.#read();
      let changed = false;
      for (const imported of entries) {
        finiteMoney(imported.estimatedCostUsd, `Legacy reservation ${imported.callId}`);
        if (imported.actualCostUsd !== null) finiteMoney(imported.actualCostUsd, `Legacy actual cost ${imported.callId}`);
        if (!CATEGORIES.has(imported.category)) throw new Error(`Unknown legacy budget category: ${imported.category}`);
        timestamp(imported.createdAt, `Legacy created time ${imported.callId}`);
        const index = ledger.entries.findIndex((entry) => entry.callId === imported.callId);
        const existing = ledger.entries[index];
        if (!existing) {
          const committed = imported.status === "committed";
          ledger.entries.push({
            callId: imported.callId,
            category: imported.category,
            estimatedCostUsd: imported.estimatedCostUsd,
            actualCostUsd: committed ? (imported.actualCostUsd ?? imported.estimatedCostUsd) : null,
            essential: true,
            status: imported.status,
            createdAt: imported.createdAt,
            updatedAt: this.#now(),
            overrun: false,
            accountingBasis: committed ? "provider-reported" : "reservation",
            ownerPid: null,
            ownerScope: null,
            expiresAt: null
          });
          changed = true;
          continue;
        }
        if (imported.status !== "committed") continue;
        const importedCost = imported.actualCostUsd ?? imported.estimatedCostUsd;
        const existingCost = existing.status === "committed" ? (existing.actualCostUsd ?? 0) : 0;
        if (existing.status === "committed" && existingCost >= importedCost) continue;
        ledger.entries[index] = {
          ...existing,
          category: imported.category,
          estimatedCostUsd: Math.max(existing.estimatedCostUsd, imported.estimatedCostUsd),
          actualCostUsd: Math.max(existingCost, importedCost),
          status: "committed",
          updatedAt: this.#now(),
          accountingBasis: "provider-reported"
        };
        changed = true;
      }
      if (changed) {
        const snapshot = this.#snapshot(ledger);
        const allocationBreach = [...ALLOCATED_CATEGORIES].some(
          (category) => this.#categoryUsed(ledger, category) > INSTALLATION_BUDGET_ALLOCATIONS_USD[category]
        );
        ledger.breached ||= snapshot.committedUsd + snapshot.reservedUsd > INSTALLATION_BUDGET_HARD_CAP_USD || allocationBreach;
        ledger.updatedAt = this.#now();
        this.#write(ledger);
      }
      return {
        ...this.#snapshot(ledger),
        durable: true,
        ledgerPath: this.ledgerPath,
        breached: ledger.breached,
        ledgerCreatedAt: ledger.createdAt
      };
    });
  }

  #commit(callId: string, actualCostUsd: number, basis: AccountingBasis): InstallationBudgetEntry {
    finiteMoney(actualCostUsd, "Actual cost");
    return this.#withLock(() => {
      const ledger = this.#read();
      const index = ledger.entries.findIndex((entry) => entry.callId === callId);
      const entry = ledger.entries[index];
      if (!entry || entry.status !== "reserved") throw new Error(`No active reservation: ${callId}`);
      const result = this.#commitEntry(ledger, index, actualCostUsd, basis);
      this.#write(ledger);
      if (result.violation) throw this.#overrunError();
      return this.#publicEntry(result.entry);
    });
  }

  #commitEntry(
    ledger: DurableInstallationBudgetLedger,
    index: number,
    actualCostUsd: number,
    basis: AccountingBasis
  ): { entry: DurableInstallationBudgetEntry; violation: boolean } {
    const entry = ledger.entries[index]!;
    const snapshot = this.#snapshot(ledger);
    const otherReservations = Math.max(0, snapshot.reservedUsd - entry.estimatedCostUsd);
    const capOverrun = snapshot.committedUsd + otherReservations + actualCostUsd > INSTALLATION_BUDGET_HARD_CAP_USD;
    const allocationOverrun = this.#allocationWouldOverrun(
      ledger,
      entry.category,
      actualCostUsd - entry.estimatedCostUsd
    );
    const committed: DurableInstallationBudgetEntry = {
      ...entry,
      actualCostUsd,
      status: "committed",
      updatedAt: this.#now(),
      overrun: capOverrun || allocationOverrun || actualCostUsd > entry.estimatedCostUsd,
      accountingBasis: basis
    };
    ledger.entries[index] = committed;
    ledger.breached ||= capOverrun || allocationOverrun;
    ledger.updatedAt = this.#now();
    return { entry: committed, violation: capOverrun || allocationOverrun };
  }

  #overrunError(): InstallationBudgetExceededError {
    return new InstallationBudgetExceededError(
      "Recorded usage cost exceeded its worst-case reservation; the overrun was durably recorded and further live calls are blocked"
    );
  }

  #assertAllocationAvailable(
    ledger: DurableInstallationBudgetLedger,
    category: InstallationBudgetCategory,
    additionalUsd: number,
    prefix = "The"
  ): void {
    if (!ALLOCATED_CATEGORIES.has(category as EvaluationBudgetCategory)) return;
    const allocated = category as EvaluationBudgetCategory;
    if (this.#categoryUsed(ledger, allocated) + additionalUsd > INSTALLATION_BUDGET_ALLOCATIONS_USD[allocated]) {
      throw new InstallationBudgetExceededError(
        `${prefix} ${allocated} allocation of USD ${INSTALLATION_BUDGET_ALLOCATIONS_USD[allocated]} would be exceeded`
      );
    }
  }

  #allocationWouldOverrun(
    ledger: DurableInstallationBudgetLedger,
    category: InstallationBudgetCategory,
    deltaUsd: number
  ): boolean {
    if (!ALLOCATED_CATEGORIES.has(category as EvaluationBudgetCategory)) return false;
    const allocated = category as EvaluationBudgetCategory;
    return this.#categoryUsed(ledger, allocated) + deltaUsd > INSTALLATION_BUDGET_ALLOCATIONS_USD[allocated];
  }

  #empty(): DurableInstallationBudgetLedger {
    const current = this.#now();
    return {
      schemaVersion: 1,
      hardCapUsd: INSTALLATION_BUDGET_HARD_CAP_USD,
      allocationsUsd: { ...INSTALLATION_BUDGET_ALLOCATIONS_USD },
      createdAt: current,
      updatedAt: current,
      breached: false,
      entries: []
    };
  }

  #read(): DurableInstallationBudgetLedger {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.ledgerPath, "utf8")) as unknown;
    } catch (error) {
      throw new Error(`Could not read durable installation budget ledger: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Durable installation budget ledger is not an object");
    }
    const raw = value as Record<string, unknown>;
    if (raw.schemaVersion !== 1 || raw.hardCapUsd !== INSTALLATION_BUDGET_HARD_CAP_USD || !Array.isArray(raw.entries)) {
      throw new Error("Durable installation budget ledger has an unsupported or unsafe schema");
    }
    if (typeof raw.breached !== "boolean") throw new Error("Durable installation budget ledger breached flag must be boolean");
    if (raw.cycleNumber !== undefined && raw.cycleNumber !== 0) {
      throw new Error("Durable installation budget ledger contains a renewable credit cycle; paid calls are blocked because the USD 100 cap is installation-lifetime");
    }
    const allocations = raw.allocationsUsd;
    if (typeof allocations !== "object" || allocations === null || Array.isArray(allocations)) {
      throw new Error("Durable installation budget ledger allocations are invalid");
    }
    for (const category of ALLOCATED_CATEGORIES) {
      if ((allocations as Record<string, unknown>)[category] !== INSTALLATION_BUDGET_ALLOCATIONS_USD[category]) {
        throw new Error(`Durable installation budget ledger ${category} allocation does not match the safe schema`);
      }
    }
    const entries: DurableInstallationBudgetEntry[] = [];
    const callIds = new Set<string>();
    for (const [index, entryValue] of raw.entries.entries()) {
      if (typeof entryValue !== "object" || entryValue === null || Array.isArray(entryValue)) {
        throw new Error(`Durable installation budget ledger entry ${index + 1} is invalid`);
      }
      const entry = entryValue as Record<string, unknown>;
      if (typeof entry.callId !== "string" || entry.callId.trim().length === 0 || entry.callId.length > 500) {
        throw new Error(`Durable installation budget ledger entry ${index + 1} has an invalid callId`);
      }
      if (callIds.has(entry.callId)) throw new Error(`Durable installation budget ledger contains duplicate call ID: ${entry.callId}`);
      callIds.add(entry.callId);
      if (!CATEGORIES.has(entry.category as InstallationBudgetCategory)) {
        throw new Error(`Durable installation budget ledger entry ${entry.callId} has an invalid category`);
      }
      if (!STATUSES.has(entry.status as InstallationBudgetEntry["status"])) {
        throw new Error(`Durable installation budget ledger entry ${entry.callId} has an invalid status`);
      }
      if (!ACCOUNTING_BASES.has(entry.accountingBasis as AccountingBasis)) {
        throw new Error(`Durable installation budget ledger entry ${entry.callId} has an invalid accounting basis`);
      }
      if (typeof entry.essential !== "boolean" || typeof entry.overrun !== "boolean") {
        throw new Error(`Durable installation budget ledger entry ${entry.callId} has invalid boolean fields`);
      }
      if (typeof entry.estimatedCostUsd !== "number" || (entry.actualCostUsd !== null && typeof entry.actualCostUsd !== "number")) {
        throw new Error(`Durable installation budget ledger entry ${entry.callId} has non-numeric cost fields`);
      }
      const estimatedCostUsd = finiteMoney(entry.estimatedCostUsd, `Reservation ${entry.callId}`);
      const actualCostUsd = entry.actualCostUsd === null ? null : finiteMoney(entry.actualCostUsd, `Actual cost ${entry.callId}`);
      const status = entry.status as InstallationBudgetEntry["status"];
      const accountingBasis = entry.accountingBasis as AccountingBasis;
      const rawOwnerPid: unknown = entry.ownerPid === undefined ? null : entry.ownerPid;
      const rawOwnerScope: unknown = entry.ownerScope === undefined ? null : entry.ownerScope;
      const expiresAt = entry.expiresAt === undefined || entry.expiresAt === null ? null : timestamp(entry.expiresAt, `Expiry ${entry.callId}`);
      if (rawOwnerPid !== null && (typeof rawOwnerPid !== "number" || !Number.isSafeInteger(rawOwnerPid) || rawOwnerPid <= 0)) throw new Error(`Durable installation budget ledger entry ${entry.callId} has an invalid owner PID`);
      if (rawOwnerScope !== null && (typeof rawOwnerScope !== "string" || !rawOwnerScope.trim() || rawOwnerScope.length > 500)) throw new Error(`Durable installation budget ledger entry ${entry.callId} has an invalid owner scope`);
      const ownerPid = rawOwnerPid as number | null;
      const ownerScope = rawOwnerScope as string | null;
      if ((ownerPid === null) !== (ownerScope === null)) throw new Error(`Durable installation budget ledger entry ${entry.callId} has incomplete owner metadata`);
      if (status === "reserved" && (actualCostUsd !== null || accountingBasis !== "reservation")) {
        throw new Error(`Reserved ledger entry ${entry.callId} has inconsistent accounting state`);
      }
      if (status === "released" && (actualCostUsd !== null || accountingBasis !== "released-before-call")) {
        throw new Error(`Released ledger entry ${entry.callId} has inconsistent accounting state`);
      }
      if (status === "committed" && (
        actualCostUsd === null
        || !["usage-priced-locally", "provider-reported", "conservative-uncertain-failure"].includes(accountingBasis)
      )) {
        throw new Error(`Committed ledger entry ${entry.callId} has inconsistent accounting state`);
      }
      entries.push({
        callId: entry.callId,
        category: entry.category as InstallationBudgetCategory,
        estimatedCostUsd,
        actualCostUsd,
        essential: entry.essential,
        status,
        createdAt: timestamp(entry.createdAt, `Created time ${entry.callId}`),
        updatedAt: timestamp(entry.updatedAt, `Updated time ${entry.callId}`),
        overrun: entry.overrun,
        accountingBasis,
        ownerPid: ownerPid === null ? null : Number(ownerPid),
        ownerScope: ownerScope === null ? null : String(ownerScope),
        expiresAt
      });
    }
    const ledger: DurableInstallationBudgetLedger = {
      schemaVersion: 1,
      hardCapUsd: INSTALLATION_BUDGET_HARD_CAP_USD,
      allocationsUsd: { ...INSTALLATION_BUDGET_ALLOCATIONS_USD },
      createdAt: timestamp(raw.createdAt, "Durable installation budget ledger createdAt"),
      updatedAt: timestamp(raw.updatedAt, "Durable installation budget ledger updatedAt"),
      breached: raw.breached,
      entries
    };
    const snapshot = this.#snapshot(ledger);
    if (!ledger.breached && snapshot.committedUsd + snapshot.reservedUsd > INSTALLATION_BUDGET_HARD_CAP_USD) {
      throw new Error("Durable installation budget ledger exceeds the hard cap without a recorded breach");
    }
    for (const category of ALLOCATED_CATEGORIES) {
      if (!ledger.breached && this.#categoryUsed(ledger, category) > INSTALLATION_BUDGET_ALLOCATIONS_USD[category]) {
        throw new Error(`Durable installation budget ledger exceeds the ${category} allocation without a recorded breach`);
      }
    }
    return ledger;
  }

  #write(ledger: DurableInstallationBudgetLedger): void {
    this.#assertOwnsLock();
    const temporary = `${this.ledgerPath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
    let descriptor: number | null = null;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      this.#assertOwnsLock();
      renameSync(temporary, this.ledgerPath);
      const directory = openSync(dirname(this.ledgerPath), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor);
      try {
        unlinkSync(temporary);
      } catch {
        // The atomic rename may already have consumed it.
      }
      throw error;
    }
  }

  #snapshot(ledger: DurableInstallationBudgetLedger): Omit<InstallationBudgetSnapshot, "durable" | "ledgerPath" | "breached" | "ledgerCreatedAt"> {
    const committedUsd = ledger.entries.reduce(
      (sum, entry) => sum + (entry.status === "committed" ? (entry.actualCostUsd ?? 0) : 0),
      0
    );
    const reservedUsd = ledger.entries.reduce(
      (sum, entry) => sum + (entry.status === "reserved" ? entry.estimatedCostUsd : 0),
      0
    );
    return {
      hardCapUsd: INSTALLATION_BUDGET_HARD_CAP_USD,
      committedUsd,
      reservedUsd,
      remainingUsd: Math.max(0, INSTALLATION_BUDGET_HARD_CAP_USD - committedUsd - reservedUsd),
      warningThresholdsReached: WARNING_THRESHOLDS_USD.filter((threshold) => committedUsd >= threshold),
      entries: ledger.entries.map((entry) => this.#publicEntry(entry))
    };
  }

  #categoryUsed(ledger: DurableInstallationBudgetLedger, category: EvaluationBudgetCategory): number {
    return ledger.entries.reduce((sum, entry) => {
      if (entry.category !== category || entry.status === "released") return sum;
      return sum + (entry.status === "committed" ? (entry.actualCostUsd ?? 0) : entry.estimatedCostUsd);
    }, 0);
  }

  #publicEntry(entry: DurableInstallationBudgetEntry): InstallationBudgetEntry {
    return {
      callId: entry.callId,
      category: entry.category,
      estimatedCostUsd: entry.estimatedCostUsd,
      actualCostUsd: entry.actualCostUsd,
      essential: entry.essential,
      status: entry.status,
      createdAt: entry.createdAt
    };
  }

  #withLock<T>(operation: () => T): T {
    const deadline = Date.now() + 5_000;
    let descriptor: number | null = null;
    let identity: { token: string; device: number | bigint; inode: number | bigint } | null = null;
    while (descriptor === null) {
      let createdLock = false;
      try {
        descriptor = openSync(this.lockPath, "wx", 0o600);
        createdLock = true;
        const token = randomUUID();
        writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, token, createdAt: this.#now() })}\n`, "utf8");
        fsyncSync(descriptor);
        const details = fstatSync(descriptor, { bigint: true });
        identity = { token, device: details.dev, inode: details.ino };
        this.#activeLock = identity;
      } catch (error) {
        if (descriptor !== null) {
          closeSync(descriptor);
          descriptor = null;
        }
        if (createdLock) {
          try {
            unlinkSync(this.lockPath);
          } catch {
            // The partially-created lock may already be absent.
          }
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        this.#removeAbandonedLock();
        if (Date.now() >= deadline) throw new Error("Timed out waiting for the durable installation-budget lock");
        wait(25);
      }
    }
    try {
      return operation();
    } finally {
      closeSync(descriptor);
      if (identity && this.#lockAtPathMatches(identity)) {
        try {
          unlinkSync(this.lockPath);
        } catch {
          // Another owner may already have recovered the lock.
        }
      }
      this.#activeLock = null;
    }
  }

  #assertOwnsLock(): void {
    if (!this.#activeLock || !this.#lockAtPathMatches(this.#activeLock)) {
      throw new Error("Lost ownership of the durable installation-budget lock; refusing to write the ledger");
    }
  }

  #lockAtPathMatches(identity: { token: string; device: number | bigint; inode: number | bigint }): boolean {
    try {
      const details = lstatSync(this.lockPath, { bigint: true });
      if (details.dev !== identity.device || details.ino !== identity.inode) return false;
      const parsed = JSON.parse(readFileSync(this.lockPath, "utf8")) as { token?: unknown };
      return parsed.token === identity.token;
    } catch {
      return false;
    }
  }

  #removeAbandonedLock(): void {
    let descriptor: number | null = null;
    try {
      descriptor = openSync(this.lockPath, "r");
      const details = fstatSync(descriptor, { bigint: true });
      const ageMs = Date.now() - Number(details.mtimeMs);
      const parsed = JSON.parse(readFileSync(descriptor, "utf8")) as { pid?: unknown; token?: unknown };
      const pid = Number(parsed.pid);
      if (ageMs < 1_000 || !Number.isInteger(pid) || pid <= 0 || typeof parsed.token !== "string" || processIsAlive(pid)) return;
      const atPath = lstatSync(this.lockPath, { bigint: true });
      if (atPath.dev !== details.dev || atPath.ino !== details.ino) return;
      const quarantine = `${this.lockPath}.abandoned-${randomUUID()}`;
      renameSync(this.lockPath, quarantine);
      try {
        unlinkSync(quarantine);
      } catch {
        // A later retry can clean an abandoned quarantine file.
      }
    } catch {
      // Missing, new, malformed, or concurrently replaced locks fail closed.
    } finally {
      if (descriptor !== null) closeSync(descriptor);
    }
  }
}
