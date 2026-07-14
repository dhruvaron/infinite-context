import { describe, expect, it } from "vitest";

import { MutationAdmissionDrainError, MutationAdmissionGate } from "./mutation-admission.js";

describe("mutation admission gate", () => {
  it("atomically closes admission and waits for older mutations", async () => {
    const gate = new MutationAdmissionGate<object>();
    const maintenance = {};
    const olderMutation = {};
    const lateMutation = {};
    expect(gate.admit(maintenance)).toBe(true);
    expect(gate.admit(olderMutation)).toBe(true);

    let entered = false;
    const exclusive = gate.beginExclusive(maintenance).then((value) => { entered = value; });
    expect(gate.admit(lateMutation)).toBe(false);
    await Promise.resolve();
    expect(entered).toBe(false);

    gate.release(olderMutation);
    await exclusive;
    expect(entered).toBe(true);
    expect(gate.maintenanceActive).toBe(true);
    expect(gate.endExclusive(maintenance)).toBe(true);
    expect(gate.admit(lateMutation)).toBe(true);
  });

  it("rejects a second maintenance upgrade until the owner reopens admission", async () => {
    const gate = new MutationAdmissionGate<object>();
    const first = {};
    const second = {};
    expect(gate.admit(first)).toBe(true);
    expect(gate.admit(second)).toBe(true);
    const firstExclusive = gate.beginExclusive(first);
    expect(await gate.beginExclusive(second)).toBe(false);
    gate.release(second);
    expect(await firstExclusive).toBe(true);
    expect(gate.endExclusive(first)).toBe(true);
  });

  it("bounds a stalled drain and reopens admission", async () => {
    const gate = new MutationAdmissionGate<object>();
    const maintenance = {};
    const stalled = {};
    const later = {};
    expect(gate.admit(maintenance)).toBe(true);
    expect(gate.admit(stalled)).toBe(true);
    await expect(gate.beginExclusive(maintenance, { timeoutMs: 1 })).rejects.toBeInstanceOf(MutationAdmissionDrainError);
    expect(gate.maintenanceActive).toBe(false);
    expect(gate.admit(later)).toBe(true);
    gate.release(stalled);
    gate.release(later);
  });
});
