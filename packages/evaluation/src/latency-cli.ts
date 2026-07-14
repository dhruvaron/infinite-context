import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { runLatencyHarness } from "./latency-harness.js";

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

const apiOrigin = argument("--api-origin", "http://127.0.0.1:4317")!;
const sessionToken = argument("--session-token", process.env.CONTINUUM_SESSION_TOKEN);
if (!sessionToken) throw new Error("Pass --session-token or set CONTINUUM_SESSION_TOKEN; it will not be written to the output");
const samples = Number(argument("--samples", "3"));
const output = resolve(argument("--output", "artifacts/evaluation/latency/latest.json")!);
const searchTimeoutMs = Number(argument("--search-timeout-ms", "15000"));
const qualityValue = argument("--quality", "fast");
if (qualityValue !== "fast" && qualityValue !== "balanced" && qualityValue !== "deep") {
  throw new Error("--quality must be fast, balanced, or deep");
}

const result = await runLatencyHarness({
  apiOrigin,
  sessionToken,
  samples,
  quality: qualityValue,
  searchTimeoutMs,
  allowLive: flag("--allow-live"),
  paidApiAcknowledged: flag("--acknowledge-paid-api"),
  liveTestsEnabled: process.env.CONTINUUM_LIVE_TESTS === "true",
  normalProviderConditions: flag("--normal-provider-conditions")
});
await mkdir(resolve(output, ".."), { recursive: true });
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  output,
  evidenceClass: result.evidenceClass,
  firstTokenMedianMs: result.firstToken.medianMs,
  postTurnSearchabilityP95Ms: result.postTurnSearchability.p95Ms,
  firstTokenReleaseEligible: result.eligibility.firstTokenReleaseGate,
  postTurnSearchabilityReleaseEligible: result.eligibility.postTurnSearchabilityReleaseGate,
  recordedCostUsd: result.budget.recordedDeltaUsd,
  resultHash: result.resultHash,
  reasons: result.eligibility.reasons
}, null, 2)}\n`);
