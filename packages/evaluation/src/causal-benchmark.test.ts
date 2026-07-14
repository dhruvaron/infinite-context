import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RollingSummaryBaseline } from "./baselines.js";
import {
  buildCausalBenchmarkPlan,
  finalizeCausalBenchmarkAudit,
  NoCostContextAnswerProvider,
  runProductionCausalBenchmark,
  SharedCausalBudgetPlan,
  validateCausalBenchmarkArtifact,
  type CausalBenchmarkArtifact,
  type ManualAuditFile
} from "./causal-benchmark.js";
import { NoCostSummaryDiagnostic } from "./causal-providers.js";
import { generateCausalBenchmarkReport } from "./causal-report.js";
import {
  PRODUCTION_CAUSAL_ABLATIONS,
  ProductionBudgetBridge,
  ProductionCausalRetriever,
  productionCausalFeatureFlags
} from "./causal-runtime.js";
import {
  customNormalizedSourceEvidence,
  infiniteBuild10kSource,
  verifyCustomNormalizedDatasetManifest
} from "./custom-datasets.js";
import { DurableEvaluationBudgetGuard } from "./durable-budget.js";
import { readNormalizedEvaluationDatasets } from "./normalized-datasets.js";
import type {
  ControlledModelSettings,
  EvaluationDataset,
  EvaluationRunRecord
} from "./types.js";

const settings: ControlledModelSettings = {
  provider: "openai-responses",
  model: "gpt-5.4-mini",
  reasoning: "low",
  totalInputTokens: 32,
  outputTokens: 32,
  temperature: 0
};

function dataset(): EvaluationDataset {
  const messages = [
    "Remember that the launch color is red.",
    "The deployment region is Prague.",
    "The release checklist has twelve items.",
    "Correction: the current launch color is blue, replacing red."
  ].map((content, index) => ({
    id: `causal-message-${index + 1}`,
    sequence: index + 1,
    role: "user" as const,
    content,
    tokenCount: Math.max(1, Math.ceil(content.length / 4)),
    topic: "launch",
    createdAt: `2026-01-0${index + 1}T00:00:00.000Z`
  }));
  return {
    id: "causal-dataset-1",
    name: "Causal test",
    version: "1",
    seed: 1,
    generatorHash: "causal-test-generator",
    checkpoints: [4],
    messages,
    probes: [{
      id: "current-color",
      checkpoint: 4,
      category: "decision_supersession",
      question: "What is the current launch color?",
      acceptableAnswers: ["blue"],
      expectedEvidenceIds: ["causal-message-4"],
      expectedCurrentValue: "blue",
      shouldRefuseForMissingEvidence: false,
      deterministic: false,
      notes: "Fixture for production-path integration"
    }],
    license: "MIT",
    provenance: "local-test"
  };
}

function hashArtifact(value: Record<string, unknown>): string {
  const core = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "resultHash"));
  return createHash("sha256").update(JSON.stringify(core)).digest("hex");
}

function completeAudit(artifact: CausalBenchmarkArtifact, template: ManualAuditFile): ManualAuditFile {
  const byId = new Map([...artifact.runs, ...artifact.ablations.runs].map((run) => [run.runId, run]));
  return {
    ...template,
    reviewer: "Independent Reviewer A",
    reviewedAt: "2026-02-01T00:00:00.000Z",
    reviews: template.runIds.map((runId) => {
      const run = byId.get(runId)!;
      return {
        runId,
        answerCorrect: (run.semanticAccuracy ?? Math.max(run.exactAccuracy, run.fuzzyAccuracy)) >= 0.5,
        answerGrounded: !run.unsupportedMemory && !run.contradictedEvidence,
        contradictedEvidence: run.contradictedEvidence,
        rationale: "Compared the answer against the visible context and acceptable-answer rubric."
      };
    })
  };
}

describe("production causal benchmark planning and fencing", () => {
  it("maintains one incremental learned-summary state per independent repetition", async () => {
    let calls = 0;
    const baseline = new RollingSummaryBaseline({
      async summarize(messages, _maxTokens, previousSummary = "") {
        calls += 1;
        return `${previousSummary}${messages.map((message) => message.content).join(" ")}`;
      }
    });
    const fixture = dataset();
    const build = (stateId: string) => baseline.build({
      history: fixture.messages,
      probe: fixture.probes[0]!,
      inputTokenBudget: settings.totalInputTokens,
      stateId
    });
    await build("repetition-1");
    await build("repetition-1");
    expect(calls).toBe(1);
    await build("repetition-2");
    expect(calls).toBe(2);
  });

  it("projects every paid answer, recursive summary, judge, and worker reservation", () => {
    const plan = buildCausalBenchmarkPlan({
      datasets: [dataset()],
      repetitions: 3,
      settings,
      summaryModel: "gpt-5.4-mini",
      judgeModel: "gpt-5.4-nano",
      workerMaximumUsd: 2,
      paidExecution: true
    });
    expect(plan).toMatchObject({
      controlledAnswerCalls: 12,
      ablationAnswerCalls: 21,
      answerCalls: 33,
      independentJudgeCalls: 33,
      learnedSummaryCalls: 3,
      productionWorkerMaximumUsd: 2,
      paidExecution: true
    });
    expect(plan.externalMaximumUsd).toBeGreaterThan(0);
    expect(plan.combinedMaximumUsd).toBe(plan.externalMaximumUsd + 2);
    expect(() => buildCausalBenchmarkPlan({
      datasets: [dataset()],
      repetitions: 3,
      settings: { ...settings, model: "moving-model-alias" },
      summaryModel: "gpt-5.4-mini",
      judgeModel: "gpt-5.4-nano",
      workerMaximumUsd: 2,
      paidExecution: true
    })).toThrow(/pinned price/i);
  });

  it("uses one atomic durable fence and records an external overrun before failing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuum-causal-fence-"));
    const durable = new DurableEvaluationBudgetGuard(join(directory, "ledger.json"));
    const shared = new SharedCausalBudgetPlan({
      durable,
      externalCeilingUsd: 0.4,
      workerCeilingUsd: 0.6,
      executionId: "atomic-test"
    });
    expect(durable.snapshot().entries).toHaveLength(1);
    expect(durable.snapshot()).toMatchObject({ reservedUsd: 1, committedUsd: 0 });
    shared.external.reserve({
      callId: "answer-1",
      category: "final_evaluation",
      estimatedCostUsd: 0.4,
      essential: true
    });
    expect(() => shared.external.commit("answer-1", 0.5)).toThrow(/fence/i);
    expect(durable.snapshot()).toMatchObject({ reservedUsd: 0, committedUsd: 1.1 });
    shared.abort();
    expect(durable.snapshot().committedUsd).toBe(1.1);
  });
});

describe("normalized causal input validation", () => {
  it("hashes the exact parsed stream and rejects evidence outside the frozen checkpoint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuum-causal-normalized-"));
    const path = join(directory, "datasets.jsonl");
    const bytes = `${JSON.stringify(dataset())}\n`;
    await writeFile(path, bytes, "utf8");
    const loaded = await readNormalizedEvaluationDatasets({
      path,
      maxRecords: 1,
      maxProbes: 1,
      verifiedImport: null
    });
    expect(loaded.parsedSha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(loaded).toMatchObject({ selectedRecords: 1, selectedProbes: 1, fullRecordAndProbeCoverage: false });

    const invalid = dataset();
    invalid.probes[0]!.expectedEvidenceIds = ["not-a-visible-message"];
    await writeFile(path, `${JSON.stringify(invalid)}\n`, "utf8");
    await expect(readNormalizedEvaluationDatasets({
      path,
      maxRecords: 1,
      maxProbes: 1,
      verifiedImport: null
    })).rejects.toThrow(/evidence.*checkpoint/i);
  });
});

describe("actual production memory adapter", () => {
  it("requires live credentials through the explicit evaluation-only override", () => {
    expect(() => new ProductionCausalRetriever({ mockProvider: false })).toThrow("requires an explicit ephemeral evaluation API key");
    expect(() => new ProductionCausalRetriever({
      mockProvider: true,
      ephemeralEvaluationApiKey: "sk-unused_mock_key_123456789"
    })).toThrow("must not receive an evaluation API key");
  });

  it("runs the worker, SQLite candidate index, vectors, retrieval engine, and independent fresh repetitions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuum-causal-runtime-"));
    const bridge = new ProductionBudgetBridge({ existingAllocatedUsd: 0, externalPlanUsd: 0, workerCeilingUsd: 0 });
    const retriever = new ProductionCausalRetriever({
      mockProvider: true,
      bridge,
      compileBatchSize: 2,
      rootParent: directory
    });
    const first = await retriever.retrieve({
      query: "current launch color",
      history: dataset().messages,
      tokenBudget: 64,
      mode: "continuum",
      runId: "answer-run-1",
      stateId: "independent-state-1"
    });
    const reused = await retriever.retrieve({
      query: "current launch color",
      history: dataset().messages,
      tokenBudget: 64,
      mode: "continuum",
      runId: "answer-run-2",
      stateId: "independent-state-1"
    });
    const second = await retriever.retrieve({
      query: "current launch color",
      history: dataset().messages,
      tokenBudget: 64,
      mode: "continuum",
      runId: "answer-run-3",
      stateId: "independent-state-2"
    });
    for (const result of [first, second]) {
      expect(result.metadata).toMatchObject({
        productionContinuumRetriever: true,
        workerCompiler: "JobProcessor.process(memory.compile)",
        candidateIndex: "SqliteCandidateIndex",
        retrievalEngine: "RetrievalEngine",
        mockProvider: true,
        compilerInvocations: 2,
        queryEmbedding: true
      });
      expect(Number(result.metadata.vectorCount)).toBeGreaterThan(0);
      expect((result.metadata.preparationUsage as EvaluationRunRecord["usage"]).embeddingTokens).toBeGreaterThan(0);
      expect(result.evidenceIds).toContain("causal-message-4");
      const candidateIds = result.metadata.selectedCandidateIds as string[];
      const evidenceGroups = result.metadata.selectedCandidateEvidenceIds as string[][];
      expect(evidenceGroups).toHaveLength(candidateIds.length);
      expect(result.evidenceIds).toEqual([...new Set(evidenceGroups.flat())]);
    }
    expect(reused.metadata.compilerInvocations).toBe(2);
    expect((reused.metadata.preparationUsage as EvaluationRunRecord["usage"]).embeddingTokens)
      .toBeLessThan((first.metadata.preparationUsage as EvaluationRunRecord["usage"]).embeddingTokens);
    for (const configuration of PRODUCTION_CAUSAL_ABLATIONS) {
      const ablated = await retriever.retrieveAblation({
        query: "current launch color",
        history: dataset().messages,
        tokenBudget: 64,
        configuration,
        stateId: "ablation-state"
      });
      expect(ablated.metadata).toMatchObject({
        configurationId: configuration,
        ablationConfiguration: configuration,
        retrievalFeatureFlags: productionCausalFeatureFlags(configuration),
        productionContinuumRetriever: true
      });
      if (configuration === "no_vector") {
        expect(ablated.metadata).toMatchObject({ queryEmbedding: false, queryEmbeddingSkippedByAblation: true });
      }
    }
    await retriever.close();
    expect(retriever.cumulativeProductionSpendUsd).toBe(0);
  });
});

describe("reproducible custom causal sources", () => {
  it("keeps the checked-in no-cost CLI fixture bound to its exact manifest", async () => {
    const normalizedPath = fileURLToPath(new URL("../../../fixtures/evaluation/custom-normalized.synthetic.jsonl", import.meta.url));
    const manifestPath = fileURLToPath(new URL("../../../fixtures/evaluation/custom-normalized-manifest.synthetic.json", import.meta.url));
    const verified = await verifyCustomNormalizedDatasetManifest({ normalizedPath, manifestPath });
    const normalized = await readNormalizedEvaluationDatasets({ path: normalizedPath, maxRecords: 1, maxProbes: 1, verifiedImport: null });
    expect(customNormalizedSourceEvidence({
      manifest: verified.manifest,
      manifestHash: verified.manifestHash,
      parsedSha256: normalized.parsedSha256,
      datasets: normalized.datasets
    })).toMatchObject({
      kind: "custom-normalized",
      messages: 2,
      probes: 1,
      datasetIds: ["custom-synthetic-causal-v1"]
    });
  });

  it("provides the exact seeded 10,000-message InfiniteBuild source", () => {
    const source = infiniteBuild10kSource();
    expect(source.dataset.messages).toHaveLength(10_000);
    expect(source.dataset.checkpoints).toContain(10_000);
    expect(source.evidence).toMatchObject({
      kind: "infinite-build-10k",
      messages: 10_000,
      completeSource: true,
      fullRecordAndProbeCoverage: true,
      reproducible: true,
      protocol: "infinite-build-v1"
    });
    expect(source.evidence.datasetHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("requires an exact custom manifest hash and complete normalized counts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuum-custom-causal-"));
    const normalizedPath = join(directory, "datasets.jsonl");
    const manifestPath = join(directory, "manifest.json");
    const bytes = `${JSON.stringify(dataset())}\n`;
    await writeFile(normalizedPath, bytes, "utf8");
    const manifest = {
      schemaVersion: 1,
      evidenceClass: "custom-normalized-evaluation-dataset",
      generatedAt: "2026-02-01T00:00:00.000Z",
      generator: "test-generator-v1",
      protocol: "test-custom-v1",
      normalizedSha256: createHash("sha256").update(bytes).digest("hex"),
      records: 1,
      messages: dataset().messages.length,
      probes: dataset().probes.length
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");
    const verified = await verifyCustomNormalizedDatasetManifest({ normalizedPath, manifestPath });
    const normalized = await readNormalizedEvaluationDatasets({ path: normalizedPath, maxRecords: 1, maxProbes: 1, verifiedImport: null });
    expect(customNormalizedSourceEvidence({
      manifest: verified.manifest,
      manifestHash: verified.manifestHash,
      parsedSha256: normalized.parsedSha256,
      datasets: normalized.datasets
    })).toMatchObject({ kind: "custom-normalized", completeSource: true, fullRecordAndProbeCoverage: true });
    await writeFile(normalizedPath, `${bytes} `, "utf8");
    await expect(verifyCustomNormalizedDatasetManifest({ normalizedPath, manifestPath })).rejects.toThrow(/manifest hash/i);
  });
});

describe("causal artifact auditability and strict recomputation", () => {
  it("runs a no-cost production-path diagnostic and finalizes a bound human audit without new calls", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuum-causal-artifact-"));
    const plan = buildCausalBenchmarkPlan({
      datasets: [dataset()],
      repetitions: 1,
      settings,
      summaryModel: "gpt-5.4-mini",
      judgeModel: "gpt-5.4-nano",
      workerMaximumUsd: 0,
      paidExecution: false
    });
    const durable = new DurableEvaluationBudgetGuard(join(directory, "ledger.json"));
    const budget = new SharedCausalBudgetPlan({ durable, externalCeilingUsd: 0, workerCeilingUsd: 0 });
    const retriever = new ProductionCausalRetriever({
      mockProvider: true,
      bridge: new ProductionBudgetBridge({ existingAllocatedUsd: 0, externalPlanUsd: 0, workerCeilingUsd: 0 }),
      compileBatchSize: 2,
      rootParent: join(directory, "runtime")
    });
    const { artifact, auditTemplate } = await runProductionCausalBenchmark({
      datasets: [dataset()],
      plan,
      settings,
      summarizer: new NoCostSummaryDiagnostic(),
      retriever,
      provider: new NoCostContextAnswerProvider(),
      judge: null,
      budget,
      datasetEvidence: {
        registryVerified: false,
        completeSource: false,
        fullRecordAndProbeCoverage: false,
        importManifestHash: null,
        sources: [{
          id: "test-source",
          kind: "custom-normalized",
          datasetIds: [dataset().id],
          messages: dataset().messages.length,
          probes: dataset().probes.length,
          datasetHash: "a".repeat(64),
          generatorHash: null,
          manifestHash: null,
          registryVerified: false,
          completeSource: true,
          fullRecordAndProbeCoverage: true,
          reproducible: true,
          protocol: "test-v1",
          licenses: ["MIT"],
          adaptedRedistributionAllowed: true
        }]
      },
      now: () => "2026-02-01T00:00:00.000Z"
    });
    expect(() => validateCausalBenchmarkArtifact(artifact)).not.toThrow();
    expect(artifact).toMatchObject({
      evidenceClass: "production-path-no-cost-diagnostic",
      manualAuditEvidence: null,
      budget: { safe: true, durablePlanChargedUsd: 0 },
      eligibility: {
        causalArchitectureClaim: false,
        productSuperiorityClaim: false,
        liveLatencyClaim: false
      }
    });
    expect(artifact.runs).toHaveLength(4);
    expect(artifact.ablations.runs).toHaveLength(7);
    expect(artifact.runs.find((run) => run.mode === "rolling_summary")?.contextMetadata).toHaveProperty("preparationUsage");
    const continuumRun = artifact.runs.find((run) => run.mode === "continuum");
    expect(continuumRun?.usage.embeddingTokens).toBeGreaterThan(0);
    const selectedCompiledCandidateCount = Number(continuumRun?.contextMetadata?.selectedCompiledCandidateCount ?? 0);
    expect(artifact.eligibility.gates.find((gate) => gate.id === "knowledge-graph-built-and-used")?.passed).toBe(selectedCompiledCandidateCount > 0);
    expect(artifact.eligibility.gates.find((gate) => gate.id === "production-feature-removal-ablations")?.passed).toBe(true);

    const report = generateCausalBenchmarkReport(artifact);
    expect(report.markdown).toContain("INELIGIBLE NO-COST PRODUCTION-PATH DIAGNOSTIC");
    expect(report.markdown).toContain("Production feature-removal ablations");
    expect(report.html).toContain("Product-superiority and live-latency claims remain false");
    expect(report.ablationRunsJsonl.trim().split("\n")).toHaveLength(7);

    const escapedArtifact = structuredClone(artifact) as unknown as Record<string, unknown>;
    const evidence = escapedArtifact.datasetEvidence as { sources: Array<{ id: string }> };
    evidence.sources[0]!.id = "<script>alert('x')</script>";
    escapedArtifact.resultHash = hashArtifact(escapedArtifact);
    const escapedReport = generateCausalBenchmarkReport(escapedArtifact);
    expect(escapedReport.html).not.toContain("<script>alert('x')</script>");
    expect(escapedReport.html).toContain("&lt;script&gt;");

    const audit = completeAudit(artifact, auditTemplate);
    const finalized = finalizeCausalBenchmarkAudit(artifact, audit);
    expect(finalized.manualAudit).toMatchObject({ complete: true, agreementRate: 1, reviewer: "Independent Reviewer A" });
    expect(finalized.manualAuditEvidence?.reviews).toHaveLength(11);
    expect(finalized.runsHash).toBe(artifact.runsHash);
    expect(() => validateCausalBenchmarkArtifact(finalized)).not.toThrow();

    const forged = structuredClone(finalized) as unknown as Record<string, unknown>;
    const eligibility = forged.eligibility as Record<string, unknown>;
    eligibility.causalArchitectureClaim = true;
    forged.resultHash = hashArtifact(forged);
    expect(() => validateCausalBenchmarkArtifact(forged)).toThrow(/eligibility/i);

    const detached = structuredClone(finalized) as unknown as Record<string, unknown>;
    detached.manualAuditEvidence = null;
    detached.resultHash = hashArtifact(detached);
    expect(() => validateCausalBenchmarkArtifact(detached)).toThrow(/manual-audit/i);
  }, 30_000);
});
