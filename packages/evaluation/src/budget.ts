export type BudgetCategory = "development" | "final_evaluation" | "contingency";

export interface BudgetEntry {
  callId: string;
  category: BudgetCategory;
  estimatedCostUsd: number;
  actualCostUsd: number | null;
  essential: boolean;
  status: "reserved" | "committed" | "released";
  createdAt: string;
}

export interface BudgetSnapshot {
  hardCapUsd: number;
  committedUsd: number;
  reservedUsd: number;
  remainingUsd: number;
  warningThresholdsReached: number[];
  entries: BudgetEntry[];
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

const HARD_CAP = 100;
const NONESSENTIAL_STOP = 95;
const WARNINGS = [20, 50, 75, 90] as const;

export class EvaluationBudgetGuard {
  private readonly entries = new Map<string, BudgetEntry>();

  reserve(input: {
    callId: string;
    category: BudgetCategory;
    estimatedCostUsd: number;
    essential: boolean;
    createdAt?: string;
  }): BudgetEntry {
    if (this.entries.has(input.callId)) throw new Error(`Duplicate budget call ID: ${input.callId}`);
    if (!Number.isFinite(input.estimatedCostUsd) || input.estimatedCostUsd < 0) {
      throw new Error("Estimated cost must be finite and non-negative");
    }
    const snapshot = this.snapshot();
    const projected = snapshot.committedUsd + snapshot.reservedUsd + input.estimatedCostUsd;
    if (snapshot.committedUsd >= HARD_CAP || projected > HARD_CAP) {
      throw new BudgetExceededError("The USD 100 API-credit hard cap would be exceeded");
    }
    if (!input.essential && projected >= NONESSENTIAL_STOP) {
      throw new BudgetExceededError(
        "Nonessential live runs stop at USD 95 to preserve diagnosis credit"
      );
    }
    const categoryUsed = snapshot.entries.reduce(
      (sum, entry) =>
        entry.category !== input.category || entry.status === "released"
          ? sum
          : sum +
            (entry.status === "committed"
              ? (entry.actualCostUsd ?? 0)
              : entry.estimatedCostUsd),
      0
    );
    if (categoryUsed + input.estimatedCostUsd > BUDGET_ALLOCATIONS_USD[input.category]) {
      throw new BudgetExceededError(
        `${input.category} allocation of USD ${BUDGET_ALLOCATIONS_USD[input.category]} would be exceeded`
      );
    }
    const entry: BudgetEntry = {
      callId: input.callId,
      category: input.category,
      estimatedCostUsd: input.estimatedCostUsd,
      actualCostUsd: null,
      essential: input.essential,
      status: "reserved",
      createdAt: input.createdAt ?? new Date().toISOString()
    };
    this.entries.set(entry.callId, entry);
    return { ...entry };
  }

  commit(callId: string, actualCostUsd: number): BudgetEntry {
    const entry = this.entries.get(callId);
    if (!entry || entry.status !== "reserved") throw new Error(`No active reservation: ${callId}`);
    if (!Number.isFinite(actualCostUsd) || actualCostUsd < 0) {
      throw new Error("Actual cost must be finite and non-negative");
    }
    const snapshot = this.snapshot();
    const otherReservations = Math.max(0, snapshot.reservedUsd - entry.estimatedCostUsd);
    if (snapshot.committedUsd + otherReservations + actualCostUsd > HARD_CAP) {
      throw new BudgetExceededError(
        "Provider cost exceeded reservation and would breach the USD 100 hard cap"
      );
    }
    const categoryUsedWithoutEntry = snapshot.entries.reduce(
      (sum, item) =>
        item.callId === callId || item.category !== entry.category || item.status === "released"
          ? sum
          : sum +
            (item.status === "committed"
              ? (item.actualCostUsd ?? 0)
              : item.estimatedCostUsd),
      0
    );
    if (categoryUsedWithoutEntry + actualCostUsd > BUDGET_ALLOCATIONS_USD[entry.category]) {
      throw new BudgetExceededError(
        `Actual provider cost would exceed the ${entry.category} allocation`
      );
    }
    const committed: BudgetEntry = {
      ...entry,
      actualCostUsd,
      status: "committed"
    };
    this.entries.set(callId, committed);
    return { ...committed };
  }

  release(callId: string): void {
    const entry = this.entries.get(callId);
    if (!entry || entry.status !== "reserved") return;
    this.entries.set(callId, { ...entry, status: "released" });
  }

  snapshot(): BudgetSnapshot {
    const entries = [...this.entries.values()];
    const committedUsd = entries.reduce(
      (sum, entry) => sum + (entry.status === "committed" ? (entry.actualCostUsd ?? 0) : 0),
      0
    );
    const reservedUsd = entries.reduce(
      (sum, entry) => sum + (entry.status === "reserved" ? entry.estimatedCostUsd : 0),
      0
    );
    return {
      hardCapUsd: HARD_CAP,
      committedUsd,
      reservedUsd,
      remainingUsd: Math.max(0, HARD_CAP - committedUsd - reservedUsd),
      warningThresholdsReached: WARNINGS.filter((threshold) => committedUsd >= threshold),
      entries: entries.map((entry) => ({ ...entry }))
    };
  }
}

export const BUDGET_ALLOCATIONS_USD: Readonly<Record<BudgetCategory, number>> = {
  development: 25,
  final_evaluation: 60,
  contingency: 15
};
