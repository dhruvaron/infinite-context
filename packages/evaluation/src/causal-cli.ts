import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { canonicalInstallationBudgetLedgerPath } from "@continuum/config";

import {
  buildCausalBenchmarkPlan,
  finalizeCausalBenchmarkAudit,
  NoCostContextAnswerProvider,
  runProductionCausalBenchmark,
  SharedCausalBudgetPlan
} from "./causal-benchmark.js";
import type { CausalDatasetSourceEvidence } from "./causal-benchmark.js";
import {
  NoCostSummaryDiagnostic,
  OpenAiIndependentGroundingJudge,
  OpenAiLearnedRollingSummaryProvider
} from "./causal-providers.js";
import {
  ProductionBudgetBridge,
  ProductionCausalRetriever
} from "./causal-runtime.js";
import { DurableEvaluationBudgetGuard } from "./durable-budget.js";
import {
  EVALUATION_API_KEY_ENVIRONMENT_VARIABLE,
  takeEphemeralEvaluationApiKeyAfterAdmission
} from "./evaluation-secret.js";
import {
  customNormalizedSourceEvidence,
  infiniteBuild10kSource,
  verifyCustomNormalizedDatasetManifest
} from "./custom-datasets.js";
import { OpenAiEvaluationAnswerProvider } from "./live-evaluation.js";
import { generateCausalBenchmarkReport } from "./causal-report.js";
import { readNormalizedEvaluationDatasets } from "./normalized-datasets.js";
import {
  sha256File,
  verifyPublicDatasetImportManifest
} from "./public-datasets.js";
import type { ControlledBaselineMode, ControlledModelSettings, EvaluationDataset } from "./types.js";

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function flag(name: string): boolean { return process.argv.includes(name); }

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

function nonnegativeNumber(name: string, fallback: string): number {
  const value = Number(argument(name, fallback));
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
  return value;
}

function selectedModes(value: string): ControlledBaselineMode[] {
  const allowed = new Set<ControlledBaselineMode>(["recent_window", "rolling_summary", "flat_hybrid", "continuum"]);
  const raw = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (!raw.length || raw.some((item) => !allowed.has(item as ControlledBaselineMode))) throw new Error("--modes contains an invalid causal baseline");
  return [...new Set(raw as ControlledBaselineMode[])];
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(path: string, value: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(value, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    const directoryHandle = await open(directory, "r");
    try { await directoryHandle.sync(); }
    finally { await directoryHandle.close(); }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function assertOutputFile(path: string, overwrite: boolean): Promise<void> {
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) throw new Error(`Causal output ${path} is not a regular file`);
    if (!overwrite) throw new Error(`Causal output ${path} already exists; pass --overwrite to replace it intentionally`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function assertRegularInput(path: string, description: string): Promise<void> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error(`${description} must be a regular file, not a link or special file`);
}

const finalizePath = argument("--finalize-artifact");
if (finalizePath) {
  const manualAuditPath = resolve(required("--manual-audit"));
  const sourcePath = resolve(finalizePath);
  const outputPath = resolve(argument("--output-artifact", sourcePath)!);
  await Promise.all([
    assertRegularInput(sourcePath, "Causal artifact"),
    assertRegularInput(manualAuditPath, "Manual audit")
  ]);
  if (outputPath !== sourcePath) await assertOutputFile(outputPath, flag("--overwrite"));
  const finalized = finalizeCausalBenchmarkAudit(
    JSON.parse(await readFile(sourcePath, "utf8")) as unknown,
    JSON.parse(await readFile(manualAuditPath, "utf8")) as unknown
  );
  await writeJson(outputPath, finalized);
  process.stdout.write(`${JSON.stringify({
    status: "manual audit attached; no API calls made",
    output: outputPath,
    resultHash: finalized.resultHash,
    causalArchitectureClaimEligible: finalized.eligibility.causalArchitectureClaim,
    gates: finalized.eligibility.gates
  }, null, 2)}\n`);
  process.exit(0);
}

const reportArtifactPath = argument("--report-artifact");
if (reportArtifactPath) {
  const sourcePath = resolve(reportArtifactPath);
  const reportOutput = resolve(argument("--output", dirname(sourcePath))!);
  await assertRegularInput(sourcePath, "Causal report artifact");
  await mkdir(reportOutput, { recursive: true, mode: 0o700 });
  const reportOutputDetails = await lstat(reportOutput);
  if (!reportOutputDetails.isDirectory() || reportOutputDetails.isSymbolicLink()) {
    throw new Error("Causal report output must be a real directory, not a link or special file");
  }
  const report = generateCausalBenchmarkReport(JSON.parse(await readFile(sourcePath, "utf8")) as unknown);
  const outputs = ["report.md", "report.html", "runs.jsonl", "ablation-runs.jsonl"].map((name) => resolve(reportOutput, name));
  await Promise.all(outputs.map((path) => assertOutputFile(path, flag("--overwrite"))));
  await Promise.all([
    writeTextAtomic(outputs[0]!, report.markdown),
    writeTextAtomic(outputs[1]!, report.html),
    writeTextAtomic(outputs[2]!, report.controlledRunsJsonl),
    writeTextAtomic(outputs[3]!, report.ablationRunsJsonl)
  ]);
  process.stdout.write(`${JSON.stringify({
    status: "causal report generated; no API calls made",
    outputDirectory: reportOutput,
    reportHash: report.reportHash
  }, null, 2)}\n`);
  process.exit(0);
}

const outputDirectory = resolve(argument("--output", "artifacts/evaluation/causal/latest")!);
if (argument("--ledger")) {
  throw new Error("--ledger is no longer configurable; paid app and evaluation traffic must share the canonical installation ledger");
}
const ledgerPath = canonicalInstallationBudgetLedgerPath();
const maxRecords = positiveInteger("--max-records", "1");
const maxProbes = positiveInteger("--max-probes", "5");
const repetitions = positiveInteger("--repetitions", "3");
const modes = selectedModes(argument("--modes", "recent_window,rolling_summary,flat_hybrid,continuum")!);
const compileBatchSize = positiveInteger("--compile-batch-size", "32");
const workerMaximumUsd = nonnegativeNumber("--worker-reservation-usd", "10");
const settings: ControlledModelSettings = {
  provider: "openai-responses",
  model: argument("--model", "gpt-5.4-mini")!,
  reasoning: argument("--reasoning", "low")!,
  totalInputTokens: positiveInteger("--input-tokens", "4096"),
  outputTokens: positiveInteger("--output-tokens", "256"),
  temperature: 0
};
const summaryModel = argument("--summary-model", settings.model)!;
const judgeModel = argument("--judge-model", "gpt-5.4-nano")!;
const datasets: EvaluationDataset[] = [];
const datasetSources: CausalDatasetSourceEvidence[] = [];
const datasetSelection: Array<Record<string, unknown>> = [];
const publicInputArgument = argument("--input-datasets");
if (publicInputArgument) {
  const inputPath = resolve(publicInputArgument);
  const manifestPath = resolve(argument("--import-manifest", resolve(dirname(inputPath), "import-manifest.json"))!);
  await Promise.all([
    assertRegularInput(inputPath, "Normalized public dataset input"),
    assertRegularInput(manifestPath, "Public dataset import manifest")
  ]);
  const verifiedImport = await verifyPublicDatasetImportManifest(inputPath, manifestPath);
  const normalized = await readNormalizedEvaluationDatasets({ path: inputPath, maxRecords, maxProbes, verifiedImport });
  const manifestHash = await sha256File(manifestPath);
  datasets.push(...normalized.datasets);
  datasetSources.push({
    id: `public:${verifiedImport.descriptor.id}:${verifiedImport.variant.key}:${normalized.parsedSha256.slice(0, 12)}`,
    kind: "registry-public",
    datasetIds: normalized.datasets.map((dataset) => dataset.id),
    messages: normalized.datasets.reduce((sum, dataset) => sum + dataset.messages.length, 0),
    probes: normalized.selectedProbes,
    datasetHash: normalized.parsedSha256,
    generatorHash: null,
    manifestHash,
    registryVerified: true,
    completeSource: (verifiedImport.manifest.output as Record<string, unknown>).completeSource === true,
    fullRecordAndProbeCoverage: normalized.fullRecordAndProbeCoverage,
    reproducible: true,
    protocol: `public-adapter-2.0.0/${verifiedImport.variant.key}`,
    licenses: [verifiedImport.descriptor.license.spdx],
    adaptedRedistributionAllowed: verifiedImport.descriptor.license.adaptedRedistributionAllowed
  });
  datasetSelection.push({
    source: "registry-public",
    path: inputPath,
    selectedRecords: normalized.selectedRecords,
    availableRecords: normalized.availableRecords,
    selectedProbes: normalized.selectedProbes,
    availableProbes: normalized.availableProbes,
    fullRecordAndProbeCoverage: normalized.fullRecordAndProbeCoverage,
    parsedSha256: normalized.parsedSha256
  });
}
const customInputArgument = argument("--custom-datasets");
if (customInputArgument) {
  const inputPath = resolve(customInputArgument);
  const manifestPath = resolve(required("--custom-manifest"));
  await Promise.all([
    assertRegularInput(inputPath, "Custom normalized dataset input"),
    assertRegularInput(manifestPath, "Custom normalized dataset manifest")
  ]);
  const verified = await verifyCustomNormalizedDatasetManifest({ normalizedPath: inputPath, manifestPath });
  const normalized = await readNormalizedEvaluationDatasets({ path: inputPath, maxRecords, maxProbes, verifiedImport: null });
  datasets.push(...normalized.datasets);
  datasetSources.push(customNormalizedSourceEvidence({
    manifest: verified.manifest,
    manifestHash: verified.manifestHash,
    parsedSha256: normalized.parsedSha256,
    datasets: normalized.datasets
  }));
  datasetSelection.push({
    source: "custom-normalized",
    path: inputPath,
    selectedRecords: normalized.selectedRecords,
    selectedProbes: normalized.selectedProbes,
    fullRecordAndProbeCoverage: true,
    parsedSha256: normalized.parsedSha256
  });
}
if (flag("--include-infinite-build")) {
  const builtIn = infiniteBuild10kSource();
  datasets.push(builtIn.dataset);
  datasetSources.push(builtIn.evidence);
  datasetSelection.push({
    source: "infinite-build-10k",
    selectedRecords: 1,
    selectedProbes: builtIn.dataset.probes.length,
    messages: builtIn.dataset.messages.length,
    datasetHash: builtIn.evidence.datasetHash
  });
}
if (datasets.length === 0) {
  throw new Error("Select at least one source with --input-datasets, --custom-datasets, or --include-infinite-build");
}
if (new Set(datasets.map((dataset) => dataset.id)).size !== datasets.length) {
  throw new Error("Selected causal dataset sources contain duplicate dataset IDs");
}
const executePaid = flag("--execute");
const executeNoCost = flag("--execute-no-cost");
if (executePaid && executeNoCost) throw new Error("Choose either --execute or --execute-no-cost, not both");
const projectedPlan = buildCausalBenchmarkPlan({
  datasets,
  modes,
  repetitions,
  settings,
  summaryModel,
  judgeModel,
  workerMaximumUsd,
  paidExecution: true
});
if (!executePaid && !executeNoCost) {
  process.stdout.write(`${JSON.stringify({
    status: "dry-run; no API call made and no budget reservation created",
    projectedPlan,
    planFitsEmptyUsd100Cap: projectedPlan.combinedMaximumUsd <= 100 + 1e-9,
    hardCapNote: projectedPlan.combinedMaximumUsd <= 100 + 1e-9
      ? "The projected plan fits an otherwise unused USD 100 ledger; existing durable allocation is checked before execution."
      : "The projected plan cannot execute under the USD 100 cap; reduce selected evidence or reservations before using paid flags.",
    datasetSelection,
    requiredPaidFlags: ["--execute", "--allow-live", "--acknowledge-paid-api", "CONTINUUM_LIVE_TESTS=true", EVALUATION_API_KEY_ENVIRONMENT_VARIABLE]
  }, null, 2)}\n`);
  process.exit(0);
}

if (executePaid && (!flag("--allow-live") || !flag("--acknowledge-paid-api") || process.env.CONTINUUM_LIVE_TESTS !== "true")) {
  throw new Error("Paid causal execution requires --execute --allow-live --acknowledge-paid-api and CONTINUUM_LIVE_TESTS=true");
}
if (executePaid && judgeModel === settings.model) throw new Error("The independent grounding judge must use a model different from the answering model");
const plan = executePaid ? projectedPlan : buildCausalBenchmarkPlan({
  datasets,
  modes,
  repetitions,
  settings,
  summaryModel,
  judgeModel,
  workerMaximumUsd: 0,
  paidExecution: false
});
const manualAuditPath = argument("--manual-audit");
if (manualAuditPath) await assertRegularInput(resolve(manualAuditPath), "Manual audit");
const manualAudit = manualAuditPath ? JSON.parse(await readFile(resolve(manualAuditPath), "utf8")) as unknown : undefined;
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const outputDirectoryDetails = await lstat(outputDirectory);
if (!outputDirectoryDetails.isDirectory() || outputDirectoryDetails.isSymbolicLink()) throw new Error("Causal output must be a real directory, not a link or special file");
await Promise.all([
  assertOutputFile(resolve(outputDirectory, "causal-result.json"), flag("--overwrite")),
  assertOutputFile(resolve(outputDirectory, "manual-audit.template.json"), flag("--overwrite")),
  assertOutputFile(resolve(outputDirectory, "runs.jsonl"), flag("--overwrite")),
  assertOutputFile(resolve(outputDirectory, "ablation-runs.jsonl"), flag("--overwrite")),
  assertOutputFile(resolve(outputDirectory, "report.md"), flag("--overwrite")),
  assertOutputFile(resolve(outputDirectory, "report.html"), flag("--overwrite"))
]);
const durable = new DurableEvaluationBudgetGuard(ledgerPath, { conservativeFailures: true });
let sharedBudget: SharedCausalBudgetPlan | null = null;
let retriever: ProductionCausalRetriever | null = null;
let causalResult: Awaited<ReturnType<typeof runProductionCausalBenchmark>>;
try {
  const createBudgetPlan = () => new SharedCausalBudgetPlan({
    durable,
    externalCeilingUsd: plan.externalMaximumUsd,
    workerCeilingUsd: plan.productionWorkerMaximumUsd,
    executionId: `causal-${Date.now()}`
  });
  let apiKey: string | null = null;
  if (executePaid) {
    const admitted = takeEphemeralEvaluationApiKeyAfterAdmission(createBudgetPlan);
    sharedBudget = admitted.admission;
    apiKey = admitted.apiKey;
  } else {
    sharedBudget = createBudgetPlan();
  }
  const bridge = new ProductionBudgetBridge({
    existingAllocatedUsd: sharedBudget.initialAllocatedUsd,
    externalPlanUsd: plan.externalMaximumUsd,
    workerCeilingUsd: plan.productionWorkerMaximumUsd
  });
  retriever = new ProductionCausalRetriever({
    mockProvider: !executePaid,
    ...(apiKey ? { ephemeralEvaluationApiKey: apiKey } : {}),
    bridge,
    compileBatchSize,
    processEmbeddings: !flag("--skip-embeddings"),
    rootParent: resolve(outputDirectory, ".runtime")
  });
  const summarizer = executePaid
    ? new OpenAiLearnedRollingSummaryProvider({ apiKey: apiKey!, model: summaryModel, budget: sharedBudget.external, reasoning: settings.reasoning })
    : new NoCostSummaryDiagnostic();
  const provider = executePaid ? new OpenAiEvaluationAnswerProvider(apiKey!) : new NoCostContextAnswerProvider();
  const judge = executePaid ? new OpenAiIndependentGroundingJudge({ apiKey: apiKey!, model: judgeModel }) : null;
  causalResult = await runProductionCausalBenchmark({
    datasets,
    plan,
    settings,
    summarizer,
    retriever,
    provider,
    judge,
    budget: sharedBudget,
    datasetEvidence: {
      registryVerified: datasetSources.some((source) => source.kind === "registry-public" && source.registryVerified),
      completeSource: datasetSources.some((source) => source.kind === "registry-public" && source.completeSource),
      fullRecordAndProbeCoverage: datasetSources.some((source) => source.kind === "registry-public" && source.fullRecordAndProbeCoverage),
      importManifestHash: datasetSources.find((source) => source.kind === "registry-public")?.manifestHash ?? null,
      sources: datasetSources
    },
    ...(manualAudit === undefined ? {} : { manualAudit })
  });
} catch (error) {
  await retriever?.close().catch(() => undefined);
  sharedBudget?.abort(retriever?.cumulativeProductionSpendUsd ?? 0);
  throw error;
}
const { artifact, auditTemplate } = causalResult;
const report = generateCausalBenchmarkReport(artifact);
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
await Promise.all([
  writeJson(resolve(outputDirectory, "causal-result.json"), artifact),
  writeJson(resolve(outputDirectory, "manual-audit.template.json"), auditTemplate),
  writeTextAtomic(resolve(outputDirectory, "runs.jsonl"), report.controlledRunsJsonl),
  writeTextAtomic(resolve(outputDirectory, "ablation-runs.jsonl"), report.ablationRunsJsonl),
  writeTextAtomic(resolve(outputDirectory, "report.md"), report.markdown),
  writeTextAtomic(resolve(outputDirectory, "report.html"), report.html)
]);
process.stdout.write(`${JSON.stringify({
  status: executePaid ? "live causal run complete" : "no-cost production-path diagnostic complete",
  outputDirectory,
  resultHash: artifact.resultHash,
  reportHash: report.reportHash,
  runs: artifact.runs.length,
  ablationRuns: artifact.ablations.runs.length,
  budget: artifact.budget,
  causalArchitectureClaimEligible: artifact.eligibility.causalArchitectureClaim,
  gates: artifact.eligibility.gates,
  nextStep: "Complete manual-audit.template.json, then use --finalize-artifact with --manual-audit; finalization makes no API calls."
}, null, 2)}\n`);
