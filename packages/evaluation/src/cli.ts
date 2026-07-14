import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { validateLatencyHarnessResult } from "./latency-harness.js";
import { runNoCostFixtureEvaluation } from "./no-cost-fixture.js";
import { generateEvaluationReport } from "./report.js";

const execFileAsync = promisify(execFile);

async function workspaceRevision(): Promise<string> {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], { cwd: process.cwd() });
    return stdout.trim() || "unresolved";
  } catch {
    return "uncommitted workspace (HEAD unresolved)";
  }
}

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function readLoadReport(path: string | undefined): Promise<{
  searchP95Ms: number | null;
  source: string;
  summary: Record<string, unknown> | null;
}> {
  if (!path) return { searchP95Ms: null, source: "not attached", summary: null };
  const absolute = resolve(path);
  try {
    const parsed = JSON.parse(await readFile(absolute, "utf8")) as Record<string, unknown>;
    const profile = parsed.profile;
    const measurements = parsed.measurements as Record<string, unknown> | undefined;
    const finalSearch = measurements?.searchAtFinalSize as Record<string, unknown> | undefined;
    const p95 = finalSearch?.p95Ms;
    return {
      searchP95Ms: profile === "full" && typeof p95 === "number" ? p95 : null,
      source: profile === "full" ? path : `${path} (quick profile; not eligible for the 100k search gate)`,
      summary: parsed
    };
  } catch (error) {
    throw new Error(`Could not read load report ${absolute}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readLatencyReport(path: string | undefined): Promise<{
  firstTokenMedianMs: number | null;
  memorySearchableP95Ms: number | null;
  firstTokenReleaseEligible: boolean;
  memorySearchableReleaseEligible: boolean;
  eligibilityNotes: string[];
  source: string;
  summary: Record<string, unknown> | null;
}> {
  if (!path) return {
    firstTokenMedianMs: null,
    memorySearchableP95Ms: null,
    firstTokenReleaseEligible: false,
    memorySearchableReleaseEligible: false,
    eligibilityNotes: ["No latency/searchability artifact attached."],
    source: "not attached",
    summary: null
  };
  const absolute = resolve(path);
  try {
    const parsed = validateLatencyHarnessResult(JSON.parse(await readFile(absolute, "utf8")) as unknown);
    const firstToken = parsed.firstToken;
    const searchable = parsed.postTurnSearchability;
    const eligibility = parsed.eligibility;
    return {
      firstTokenMedianMs: typeof firstToken?.medianMs === "number" ? firstToken.medianMs : null,
      memorySearchableP95Ms: typeof searchable?.p95Ms === "number" ? searchable.p95Ms : null,
      firstTokenReleaseEligible: eligibility?.firstTokenReleaseGate === true,
      memorySearchableReleaseEligible: eligibility?.postTurnSearchabilityReleaseGate === true,
      eligibilityNotes: Array.isArray(eligibility?.reasons) ? eligibility.reasons.map(String) : [],
      source: path,
      summary: parsed as unknown as Record<string, unknown>
    };
  } catch (error) {
    throw new Error(`Could not read latency report ${absolute}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const outputDirectory = resolve(argument("--output", "artifacts/evaluation/no-cost")!);
const requestedMessages = Number(argument("--messages", "10000"));
if (!Number.isInteger(requestedMessages) || requestedMessages < 100) {
  throw new Error("--messages must be an integer of at least 100");
}
const load = await readLoadReport(argument("--load-report"));
const latency = await readLatencyReport(argument("--latency-report"));
const result = await runNoCostFixtureEvaluation({ messages: requestedMessages });
const revision = await workspaceRevision();
const environment = `${process.platform}/${process.arch}; Node ${process.version}`;
if (result.budgetTotalUsd !== 0) throw new Error("The no-cost fixture unexpectedly recorded provider spend");

const failures = result.runs
  .filter((run) => run.error !== null || Math.max(run.exactAccuracy, run.fuzzyAccuracy) < 0.8)
  .slice(0, 8)
  .map((run) => `${run.mode}/${run.probeId}: ${run.error ?? `answer was ${JSON.stringify(run.answer)}`}`);
const successes = result.runs
  .filter((run) => run.error === null && run.exactAccuracy === 1 && run.mode === "continuum")
  .slice(0, 8)
  .map((run) => `${run.probeId}: selected ${run.selectedEvidenceIds.length} evidence item(s) and produced ${JSON.stringify(run.answer)}`);

const evaluationConfig = {
  evaluationClass: "deterministic-no-cost-fixture",
  dataset: result.dataset.name,
  datasetVersion: result.dataset.version,
  generatorHash: result.dataset.generatorHash,
  seed: result.dataset.seed,
  messages: result.dataset.messages.length,
  checkpoints: result.dataset.checkpoints,
  responseProvider: "deterministic rule fixture; no model",
  repetitions: 1,
  stochastic: false,
  inputBudgetPerProbe: 4_096,
  outputBudgetPerProbe: 256
};

const report = generateEvaluationReport({
  title: "Continuum deterministic no-cost evaluation",
  generatedAt: new Date().toISOString(),
  evidenceClass: "no-cost-fixture",
  provenance: { revision, environment },
  resultHash: result.resultHash,
  config: evaluationConfig,
  metrics: result.metrics,
  runs: result.runs,
  competitors: [],
  budgetTotalUsd: 0,
  fullHistoryPromptTokensAt10k: result.fullHistoryReplayTokens,
  representativeSuccesses: successes,
  representativeFailures: failures,
  ablations: result.ablations,
  performance: {
    searchP95Ms: load.searchP95Ms,
    firstTokenMedianMs: latency.firstTokenMedianMs,
    memorySearchableP95Ms: latency.memorySearchableP95Ms,
    firstTokenReleaseEligible: latency.firstTokenReleaseEligible,
    memorySearchableReleaseEligible: latency.memorySearchableReleaseEligible,
    eligibilityNotes: latency.eligibilityNotes,
    source: `load=${load.source}; latency=${latency.source}`
  },
  diagnostics: [
    {
      title: "15% relative accuracy gate feasibility",
      status: result.accuracyGateDiagnosis.conclusion === "gate-met" ? "pass" : "blocked",
      summary: result.accuracyGateDiagnosis.explanation,
      details: { ...result.accuracyGateDiagnosis }
    }
  ],
  limitations: [
    "No OpenAI, ChatGPT, Codex, embedding, reranking, or judge call was made.",
    "Answers and semantic concepts come from deterministic rules. Accuracy values validate evaluation wiring and fixture sensitivity, not general model quality.",
    "Latency values in answer runs are fixture placeholders. Only an attached full local-load report may contribute a measured 100k SQLite search p95.",
    "Ablations disable deterministic fixture signals and do not prove the effect size of production lexical, vector, temporal, wiki, reranking, or graph components.",
    "Public LongMemEval/HaluMem inputs and black-box competitor runs are not included in this no-cost command.",
    "Live controlled evaluation, three stochastic repetitions, first-token latency, and post-turn memory-searchability remain required before release claims can be made."
  ]
});

await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  writeFile(resolve(outputDirectory, "report.md"), report.markdown, "utf8"),
  writeFile(resolve(outputDirectory, "report.html"), report.html, "utf8"),
  writeFile(resolve(outputDirectory, "runs.jsonl"), `${report.rawJsonl}${report.rawJsonl ? "\n" : ""}`, "utf8"),
  writeFile(resolve(outputDirectory, "summary.json"), `${JSON.stringify({
    evidenceClass: "no-cost-fixture",
    generatedAt: new Date().toISOString(),
    revision,
    environment,
    liveApiCalls: 0,
    recordedCostUsd: 0,
    config: evaluationConfig,
    configHash: report.configHash,
    resultHash: result.resultHash,
    dataset: {
      id: result.dataset.id,
      version: result.dataset.version,
      generatorHash: result.dataset.generatorHash,
      messages: result.dataset.messages.length,
      probes: result.dataset.probes.length,
      checkpoints: result.dataset.checkpoints
    },
    metrics: result.metrics,
    ablations: result.ablations,
    diagnostics: {
      accuracyGate: result.accuracyGateDiagnosis
    },
    diagnosticGates: report.gates,
    attachedLoadReport: load.summary,
    attachedLatencyReport: latency.summary
  }, null, 2)}\n`, "utf8")
]);

process.stdout.write(`${JSON.stringify({
  outputDirectory,
  evidenceClass: "no-cost-fixture",
  messages: result.dataset.messages.length,
  probes: result.dataset.probes.length,
  runs: result.runs.length,
  ablations: result.ablations.length,
  configHash: report.configHash,
  resultHash: result.resultHash,
  liveApiCalls: 0,
  recordedCostUsd: 0,
  warning: "Diagnostic fixture only; not live benchmark evidence."
}, null, 2)}\n`);
