import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Transform } from "node:stream";
import { finished } from "node:stream/promises";

import { createControlledBaselines, DeterministicSummaryFixture } from "./baselines.js";
import { canonicalInstallationBudgetLedgerPath, MODEL_PRICING_USD_PER_MILLION } from "@continuum/config";
import { DurableEvaluationBudgetGuard } from "./durable-budget.js";
import {
  takeEphemeralEvaluationApiKeyAfterAdmission
} from "./evaluation-secret.js";
import {
  EVALUATION_PRICING_REVISION,
  EVALUATION_RESERVATION_SAFETY_MULTIPLIER,
  assertPinnedEvaluationModel,
  estimateLiveEvaluationReservation,
  OpenAiEvaluationAnswerProvider,
  PortableEvaluationRetriever
} from "./live-evaluation.js";
import { aggregateRuns } from "./metrics.js";
import {
  expectedPublicDatasetProvenance,
  verifyPublicDatasetImportManifest,
  type VerifiedPublicDatasetImportManifest
} from "./public-datasets.js";
import { runControlledEvaluation } from "./runner.js";
import type {
  ControlledBaselineMode,
  ControlledModelSettings,
  EvaluationDataset,
  EvaluationRunRecord
} from "./types.js";

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function required(name: string): string {
  const value = argument(name);
  if (!value) throw new Error(`Missing required ${name}`);
  return value;
}

function positiveInteger(name: string, fallback: string): number {
  const value = Number(argument(name, fallback));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function modes(value: string): ControlledBaselineMode[] {
  const allowed = new Set<ControlledBaselineMode>(["recent_window", "rolling_summary", "flat_hybrid", "continuum"]);
  const parsed = value.split(",").map((item) => item.trim()).filter((item): item is ControlledBaselineMode => allowed.has(item as ControlledBaselineMode));
  if (parsed.length === 0 || parsed.length !== value.split(",").filter(Boolean).length) {
    throw new Error("--modes must contain recent_window, rolling_summary, flat_hybrid, and/or continuum");
  }
  return [...new Set(parsed)];
}

function evaluationDataset(value: unknown, line: number): EvaluationDataset {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Normalized dataset line ${line} is not an object`);
  const record = value as Partial<EvaluationDataset>;
  if (typeof record.id !== "string" || !Array.isArray(record.messages) || !Array.isArray(record.probes)) {
    throw new Error(`Normalized dataset line ${line} lacks id/messages/probes`);
  }
  return record as EvaluationDataset;
}

async function readDatasets(
  path: string,
  maxRecords: number,
  maxProbes: number,
  verifiedImport: VerifiedPublicDatasetImportManifest | null
): Promise<EvaluationDataset[]> {
  const digest = createHash("sha256");
  const raw = createReadStream(path);
  const hashedBytes = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      digest.update(chunk);
      callback(null, chunk);
    }
  });
  raw.on("error", (error) => hashedBytes.destroy(error));
  raw.pipe(hashedBytes);
  const lines = createInterface({ input: hashedBytes, crlfDelay: Infinity });
  const datasets: EvaluationDataset[] = [];
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim() || datasets.length >= maxRecords) continue;
      const parsed = evaluationDataset(JSON.parse(line) as unknown, lineNumber);
      if (verifiedImport) {
        const expectedProvenance = expectedPublicDatasetProvenance(verifiedImport.descriptor, verifiedImport.variant);
        if (parsed.name !== verifiedImport.descriptor.displayName
          || parsed.license !== verifiedImport.descriptor.license.spdx
          || parsed.provenance !== expectedProvenance
          || parsed.version !== `adapter-2.0.0/${verifiedImport.variant.key}`) {
          throw new Error(`Normalized dataset line ${lineNumber} does not match its registry-verified import manifest`);
        }
      }
      const selectedProbes = parsed.probes.slice(0, maxProbes);
      if (selectedProbes.length === 0) continue;
      datasets.push({
        ...parsed,
        probes: selectedProbes,
        checkpoints: [...new Set(selectedProbes.map((probe) => probe.checkpoint))]
      });
    }
    await finished(hashedBytes);
  } finally {
    raw.destroy();
  }
  const parsedHash = digest.digest("hex");
  if (verifiedImport && parsedHash !== verifiedImport.outputSha256) {
    throw new Error("Normalized dataset changed after import-manifest verification");
  }
  if (datasets.length === 0) throw new Error("The normalized input contains no evaluation datasets");
  return datasets;
}

const inputPath = resolve(required("--input-datasets"));
const outputDirectory = resolve(argument("--output", "artifacts/evaluation/live/latest")!);
const manifestPath = resolve(argument("--import-manifest", resolve(dirname(inputPath), "import-manifest.json"))!);
if (argument("--ledger")) {
  throw new Error("--ledger is no longer configurable; paid app and evaluation traffic must share the canonical installation ledger");
}
const ledgerPath = canonicalInstallationBudgetLedgerPath();
const maxRecords = positiveInteger("--max-records", "1");
const maxProbes = positiveInteger("--max-probes", "5");
const repetitions = positiveInteger("--repetitions", "3");
const selectedModes = modes(argument("--modes", "recent_window,rolling_summary,flat_hybrid,continuum")!);
const settings: ControlledModelSettings = {
  provider: "openai-responses",
  model: argument("--model", "gpt-5.4-mini")!,
  reasoning: argument("--reasoning", "low")!,
  totalInputTokens: positiveInteger("--input-tokens", "4096"),
  outputTokens: positiveInteger("--output-tokens", "256"),
  temperature: 0
};
const unverifiedAllowed = flag("--allow-unverified-dataset");
let verifiedImport: VerifiedPublicDatasetImportManifest | null = null;
try {
  verifiedImport = await verifyPublicDatasetImportManifest(inputPath, manifestPath);
} catch (error) {
  if (!unverifiedAllowed) throw error;
}
const datasets = await readDatasets(inputPath, maxRecords, maxProbes, verifiedImport);
const importManifest = verifiedImport?.manifest ?? null;
const totalProbes = datasets.reduce((sum, dataset) => sum + dataset.probes.length, 0);
const plannedCalls = totalProbes * repetitions * selectedModes.length;
assertPinnedEvaluationModel(settings.model);
const reservationPerCallUsd = estimateLiveEvaluationReservation(settings);
const plannedMaximumUsd = plannedCalls * reservationPerCallUsd;
const plan = {
  evidenceClass: importManifest ? "live-controlled-preliminary" : "live-unverified-diagnostic",
  inputPath,
  importManifestPath: importManifest ? manifestPath : null,
  records: datasets.length,
  probes: totalProbes,
  modes: selectedModes,
  repetitions,
  plannedCalls,
  model: settings.model,
  reasoning: settings.reasoning,
  inputTokensPerCall: settings.totalInputTokens,
  outputTokensPerCall: settings.outputTokens,
  reservationPerCallUsd,
  pricingRevision: EVALUATION_PRICING_REVISION,
  pinnedPriceUsdPerMillionTokens: MODEL_PRICING_USD_PER_MILLION[settings.model],
  reservationSafetyMultiplier: EVALUATION_RESERVATION_SAFETY_MULTIPLIER,
  plannedMaximumUsd,
  ledgerPath,
  execute: flag("--execute")
};
if (!flag("--execute")) {
  process.stdout.write(`${JSON.stringify({ ...plan, status: "dry-run; no API call made" }, null, 2)}\n`);
  process.exit(0);
}
if (!flag("--allow-live") || process.env.CONTINUUM_LIVE_TESTS !== "true" || !flag("--acknowledge-paid-api")) {
  throw new Error("Paid execution requires --execute --allow-live --acknowledge-paid-api and CONTINUUM_LIVE_TESTS=true");
}
const { admission: { budget, budgetBefore }, apiKey } = takeEphemeralEvaluationApiKeyAfterAdmission(() => {
  const budget = new DurableEvaluationBudgetGuard(ledgerPath, { conservativeFailures: true });
  budget.assertCanReserveTotal({ category: "final_evaluation", estimatedCostUsd: plannedMaximumUsd, essential: true });
  return { budget, budgetBefore: budget.snapshot() };
});
const provider = new OpenAiEvaluationAnswerProvider(apiKey);
const baselines = createControlledBaselines({
  summarizer: new DeterministicSummaryFixture(),
  retriever: new PortableEvaluationRetriever()
}).filter((baseline) => selectedModes.includes(baseline.mode));
const runs: EvaluationRunRecord[] = [];
for (const dataset of datasets) {
  runs.push(...await runControlledEvaluation({
    dataset,
    baselines,
    provider,
    budget,
    options: { repetitions, settings }
  }));
}
const metrics = selectedModes.map((mode) => aggregateRuns(mode, runs));
const budgetAfter = budget.snapshot();
const resultHash = createHash("sha256").update(JSON.stringify({ plan, runs, metrics })).digest("hex");
const summary = {
  ...plan,
  generatedAt: new Date().toISOString(),
  resultHash,
  budgetBefore,
  budgetAfter,
  metrics,
  completedRuns: runs.filter((run) => run.error === null).length,
  failedRuns: runs.filter((run) => run.error !== null).length,
  releaseClaimEligible: false,
  limitations: [
    "This runner keeps model, reasoning, token ceilings, repetitions, and question set controlled across modes.",
    "The public-data retriever is a transparent portable smoke retriever, not the production Continuum lexical/vector/wiki/graph stack.",
    "The rolling summary is deterministic for cost control; a final causal benchmark must use the same live summarization policy planned for release.",
    "Semantic correctness and unsupported/contradicted-memory flags do not have an independent live judge in this runner, so its aggregate metrics are preliminary and release gates are intentionally not generated.",
    "Failed provider calls conservatively consume their full reservation in the durable ledger because their billable status may be uncertain."
  ]
};
await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(resolve(outputDirectory, "runs.jsonl"), `${runs.map((run) => JSON.stringify(run)).join("\n")}\n`, { encoding: "utf8", mode: 0o600 }),
  writeFile(resolve(outputDirectory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
]);
process.stdout.write(`${JSON.stringify({
  outputDirectory,
  resultHash,
  completedRuns: summary.completedRuns,
  failedRuns: summary.failedRuns,
  ledgerCommittedUsd: budgetAfter.committedUsd,
  ledgerReservedUsd: budgetAfter.reservedUsd,
  releaseClaimEligible: false
}, null, 2)}\n`);
if (summary.failedRuns > 0) process.exitCode = 1;
