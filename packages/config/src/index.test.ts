import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  LONG_CONTEXT_PREMIUM_THRESHOLD_TOKENS,
  InstallationBudgetGuard,
  UnknownModelPricingError,
  estimateCostUsd,
  loadConfig
} from "./index.js";

describe("fail-closed provider pricing", () => {
  it("uses Luna for memory extraction and one non-portable installation ledger by default", () => {
    const customVault = resolve("/tmp/continuum-config-test-vault");
    const production = loadConfig({ NODE_ENV: "production", CONTINUUM_DATA_DIR: customVault });
    expect(production.models.memory).toBe("gpt-5.6-luna");
    expect(production.installationBudgetLedgerPath).toBe(
      join(homedir(), "Library", "Application Support", "Continuum", "installation-budget-ledger.json")
    );
    expect(production.installationBudgetLedgerPath.startsWith(customVault)).toBe(false);

    const isolatedTest = loadConfig({ NODE_ENV: "test", CONTINUUM_DATA_DIR: customVault });
    expect(isolatedTest.installationBudgetLedgerPath).toBe(join(customVault, "installation-budget-ledger.json"));
  });

  it("rejects unknown response models during configuration before any provider can be created", () => {
    expect(() => loadConfig({ NODE_ENV: "test", CONTINUUM_FAST_MODEL: "gpt-future-unknown" })).toThrow(UnknownModelPricingError);
  });

  it("rejects role-incompatible response and embedding models", () => {
    expect(() => loadConfig({ NODE_ENV: "test", CONTINUUM_FAST_MODEL: "text-embedding-3-small" })).toThrow(UnknownModelPricingError);
    expect(() => loadConfig({ NODE_ENV: "test", CONTINUUM_EMBEDDING_MODEL: "gpt-5.6-luna" })).toThrow(UnknownModelPricingError);
  });

  it("does not admit a general application API-key environment fallback", () => {
    const config = loadConfig({
      NODE_ENV: "production",
      CONTINUUM_OPENAI_API_KEY: "sk-legacy_environment_key_123456789"
    });
    expect(config).not.toHaveProperty("openAiApiKeyFromEnvironment");
    expect(JSON.stringify(config)).not.toContain("sk-legacy_environment_key_123456789");
  });

  it("never guesses a price for an unknown model", () => {
    expect(() => estimateCostUsd("unknown-model", 1, 1)).toThrow(UnknownModelPricingError);
  });

  it("rejects malformed token estimates", () => {
    expect(() => estimateCostUsd("gpt-5.6-luna", -1, 0)).toThrow(RangeError);
    expect(() => estimateCostUsd("gpt-5.6-luna", 1.5, 0)).toThrow(RangeError);
    expect(() => estimateCostUsd("gpt-5.6-luna", Number.MAX_VALUE, 0)).toThrow(RangeError);
    expect(() => estimateCostUsd("gpt-5.6-luna", 10, 0, { cachedInputTokens: 11 })).toThrow(RangeError);
  });

  it("uses the standard rate through 272K and the long-context rate above it per request", () => {
    expect(estimateCostUsd("gpt-5.6-luna", LONG_CONTEXT_PREMIUM_THRESHOLD_TOKENS, 100_000)).toBeCloseTo(0.872, 9);
    expect(estimateCostUsd("gpt-5.6-luna", LONG_CONTEXT_PREMIUM_THRESHOLD_TOKENS + 1, 100_000)).toBeCloseTo(1.444_002, 9);
  });

  it("does not apply flagship long-context premiums to mini or embedding models", () => {
    expect(estimateCostUsd("gpt-5.4-mini", 300_000, 100_000)).toBeCloseTo(0.675, 9);
    expect(estimateCostUsd("text-embedding-3-small", 1_000_000, 0)).toBeCloseTo(0.02, 9);
  });

  it("accounts for cached reads and the conservative GPT-5.6 cache-write premium from actual usage", () => {
    expect(estimateCostUsd("gpt-5.6-luna", 1_000, 0, {
      cachedInputTokens: 800,
      includeCacheWritePremium: true
    })).toBeCloseTo(0.000_33, 12);
  });
});

describe("non-renewable installation API budget", () => {
  it("retains lifetime spend across reopen and rejects legacy renewable-cycle ledgers", async () => {
    const root = await mkdtemp(join(tmpdir(), "continuum-lifetime-budget-"));
    try {
      const path = join(root, "installation-budget-ledger.json");
      const guard = new InstallationBudgetGuard(path);
      guard.reserve({ callId: "settled-call", category: "application", estimatedCostUsd: 2, essential: true });
      guard.commit("settled-call", 1.5);
      const snapshot = new InstallationBudgetGuard(path).snapshot();
      expect(snapshot).toMatchObject({ committedUsd: 1.5, reservedUsd: 0, remainingUsd: 98.5 });
      expect(() => new InstallationBudgetGuard(path).reserve({ callId: "fresh-cycle-attempt", category: "application", estimatedCostUsd: 99, essential: true })).toThrow(/USD 100/i);

      const legacyRenewable = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      legacyRenewable.cycleNumber = 1;
      await writeFile(path, `${JSON.stringify(legacyRenewable, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      expect(() => new InstallationBudgetGuard(path)).toThrow(/renewable credit cycle|installation-lifetime/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
