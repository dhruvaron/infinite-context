import { describe, expect, it } from "vitest";

import {
  createControlledBaselines,
  DeterministicSummaryFixture
} from "./baselines.js";
import {
  BudgetExceededError,
  EvaluationBudgetGuard
} from "./budget.js";
import {
  createManualBuildScenario,
  generateInfiniteBuild
} from "./infinite-build.js";
import {
  aggregateRuns,
  retrievalMetrics,
  scoreAnswer
} from "./metrics.js";
import { runNoCostFixtureEvaluation } from "./no-cost-fixture.js";
import { adaptLongMemEval } from "./public-datasets.js";
import {
  evaluateReleaseGates,
  generateEvaluationReport
} from "./report.js";
import { runControlledEvaluation } from "./runner.js";
import type {
  AggregateMetrics,
  ControlledBaselineMode,
  EvaluationRunRecord
} from "./types.js";

describe("InfiniteBuild dataset", () => {
  it("generates an exact, reproducible 10,000-message single-session fixture", () => {
    const first = generateInfiniteBuild();
    const second = generateInfiniteBuild();
    expect(first.messages).toHaveLength(10_000);
    expect(first.generatorHash).toBe(second.generatorHash);
    expect(first.messages[2]?.content).toContain("Northstar");
    expect(first.checkpoints).toEqual([100, 1_000, 5_000, 10_000]);
    expect(first.probes.map((probe) => probe.category)).toEqual(
      expect.arrayContaining([
        "single_fact",
        "exact_quote",
        "decision_supersession",
        "contradiction",
        "multi_hop",
        "absent_evidence",
        "interference"
      ])
    );
  });

  it("ships a manually authored scenario and public-dataset adapters", () => {
    expect(createManualBuildScenario().probes[0]?.acceptableAnswers).toContain("SQLite");
    const adapted = adaptLongMemEval(
      [
        {
          question_id: "x",
          question_type: "single-session-user",
          haystack_session_ids: ["session-x"],
          haystack_sessions: [
            [{ role: "user", content: "My color is blue.", has_answer: true }]
          ],
          answer_session_ids: ["session-x"],
          question: "What is my color?",
          answer: "blue"
        }
      ],
      { name: "upstream-license", sourceUrl: "https://example.test/dataset", redistributable: false }
    );
    expect(adapted.probes).toHaveLength(1);
    expect(adapted.messages[0]?.content).toBe("My color is blue.");
    expect(adapted.provenance).toContain("source=https://example.test/dataset");
    expect(adapted.provenance).toContain("verified=false");
  });
});

describe("controlled baselines and metrics", () => {
  it("gives all four baselines the same hard input ceiling", async () => {
    const dataset = generateInfiniteBuild({ messages: 100 });
    const baselines = createControlledBaselines({
      summarizer: new DeterministicSummaryFixture(),
      retriever: {
        async retrieve(input) {
          return {
            text: input.history[2]?.content ?? "",
            evidenceIds: [input.history[2]?.id ?? ""],
            tokenCount: Math.min(20, input.tokenBudget),
            metadata: { mode: input.mode }
          };
        }
      }
    });
    const probe = dataset.probes[0]!;
    for (const baseline of baselines) {
      const context = await baseline.build({
        history: dataset.messages,
        probe,
        inputTokenBudget: 200
      });
      expect(context.inputTokens).toBeLessThanOrEqual(200);
    }
    expect(baselines.map((item) => item.mode)).toEqual([
      "recent_window",
      "rolling_summary",
      "flat_hybrid",
      "continuum"
    ]);
  });

  it("scores answers and ranked evidence deterministically", () => {
    expect(scoreAnswer("The answer is PostgreSQL.", ["PostgreSQL"]).exact).toBe(1);
    expect(retrievalMetrics(["a", "x", "b"], ["a", "b"], 10)).toMatchObject({
      precision: 2 / 3,
      recall: 1
    });
  });

  it("scores retrieval by candidate rank without letting one topic's provenance consume k", () => {
    const topicSources = [
      ...Array.from({ length: 10 }, (_, index) => `topic-source-${index + 1}`),
      "topic-expected"
    ];
    const candidateEvidenceGroups = [
      topicSources,
      ["raw-expected"],
      ...Array.from({ length: 8 }, (_, index) => [`filler-rank-${index + 3}`]),
      ["late-expected"]
    ];
    const flattened = [...new Set(candidateEvidenceGroups.flat())];
    const metrics = retrievalMetrics(
      flattened,
      ["topic-expected", "raw-expected", "late-expected"],
      10,
      candidateEvidenceGroups
    );
    const idealDcg = 1 + 1 / Math.log2(3) + 1 / Math.log2(4);

    expect(flattened.indexOf("raw-expected")).toBe(11);
    expect(metrics.precision).toBe(0.2);
    expect(metrics.recall).toBe(2 / 3);
    expect(metrics.ndcg).toBeCloseTo((1 + 1 / Math.log2(3)) / idealDcg);
  });
});

describe("budget enforcement", () => {
  it("warns at thresholds, stops nonessential work at 95, and never reserves beyond 100", () => {
    const guard = new EvaluationBudgetGuard();
    guard.reserve({ callId: "development", category: "development", estimatedCostUsd: 25, essential: true });
    guard.commit("development", 25);
    guard.reserve({ callId: "final", category: "final_evaluation", estimatedCostUsd: 60, essential: true });
    guard.commit("final", 60);
    guard.reserve({ callId: "first-contingency", category: "contingency", estimatedCostUsd: 5, essential: true });
    guard.commit("first-contingency", 5);
    expect(guard.snapshot().warningThresholdsReached).toEqual([20, 50, 75, 90]);
    expect(() =>
      guard.reserve({ callId: "nonessential", category: "contingency", estimatedCostUsd: 5, essential: false })
    ).toThrow(BudgetExceededError);
    guard.reserve({ callId: "diagnosis", category: "contingency", estimatedCostUsd: 5, essential: true });
    guard.commit("diagnosis", 5);
    expect(() =>
      guard.reserve({ callId: "overflow", category: "contingency", estimatedCostUsd: 6, essential: true })
    ).toThrow(/100/);
    const allocationGuard = new EvaluationBudgetGuard();
    expect(() =>
      allocationGuard.reserve({
        callId: "dev-over-allocation",
        category: "development",
        estimatedCostUsd: 25.01,
        essential: true
      })
    ).toThrow(/development allocation/i);
  });
});

function aggregate(mode: ControlledBaselineMode, overrides: Partial<AggregateMetrics> = {}): AggregateMetrics {
  return {
    mode,
    runs: 10,
    answerAccuracy: 0.8,
    retrievalPrecisionAt10: 0.8,
    retrievalRecallAt10: 0.9,
    ndcgAt10: 0.9,
    temporalAccuracy: 0.9,
    unsupportedMemoryRate: 0.01,
    contradictionRate: 0.01,
    cumulativeInputTokens: 4_000,
    cumulativeAllTokens: 5_000,
    cumulativeCostUsd: 1,
    medianResponseLatencyMs: 1_000,
    p95RetrievalLatencyMs: 300,
    accuracyConfidence95: [0.75, 0.85],
    ...overrides
  };
}

describe("runner and reproducible reports", () => {
  it("runs four modes and feature ablations with a stable zero-cost fixture result", async () => {
    const first = await runNoCostFixtureEvaluation({ messages: 100 });
    const second = await runNoCostFixtureEvaluation({ messages: 100 });
    expect(first.metrics.map((metric) => metric.mode)).toEqual([
      "recent_window",
      "rolling_summary",
      "flat_hybrid",
      "continuum"
    ]);
    expect(first.ablations).toHaveLength(7);
    expect(first.budgetTotalUsd).toBe(0);
    expect(first.resultHash).toBe(second.resultHash);
  });

  it("executes repeated fixture runs with no hidden live calls", async () => {
    const dataset = createManualBuildScenario();
    const baselines = createControlledBaselines({
      summarizer: new DeterministicSummaryFixture(),
      retriever: {
        async retrieve(input) {
          return {
            text: input.history.map((message) => message.content).join("\n"),
            evidenceIds: input.history.map((message) => message.id),
            tokenCount: Math.min(input.tokenBudget, 100),
            metadata: {}
          };
        }
      }
    });
    const guard = new EvaluationBudgetGuard();
    const records = await runControlledEvaluation({
      dataset,
      baselines,
      budget: guard,
      provider: {
        estimateCost: () => 0,
        async answer(request) {
          return {
            answer: request.context.includes("SQLite") ? "SQLite" : "I do not know",
            usage: {
              inputTokens: 100,
              cachedInputTokens: 0,
              outputTokens: 2,
              extractionTokens: 0,
              embeddingTokens: 0,
              rerankingTokens: 0,
              estimatedCostUsd: 0
            },
            latency: {
              firstTokenMs: 1,
              totalResponseMs: 2,
              retrievalMs: 1,
              rerankingMs: 0,
              compilationMs: 0
            },
            unsupportedMemory: false,
            contradictedEvidence: false
          };
        }
      },
      options: {
        repetitions: 3,
        settings: {
          provider: "fixture",
          model: "fixture",
          reasoning: "none",
          totalInputTokens: 1_000,
          outputTokens: 100,
          temperature: 0
        },
        now: () => "2026-01-01T00:00:00.000Z"
      }
    });
    expect(records).toHaveLength(12);
    expect(guard.snapshot().committedUsd).toBe(0);
    expect(aggregateRuns("continuum", records).runs).toBe(3);
  });

  it("emits Markdown, HTML, raw JSONL, config hashes, and honest release gates", () => {
    const metrics = [
      aggregate("recent_window", { answerAccuracy: 0.5 }),
      aggregate("rolling_summary", { answerAccuracy: 0.6 }),
      aggregate("flat_hybrid", { answerAccuracy: 0.75, medianResponseLatencyMs: 1_000 }),
      aggregate("continuum", {
        answerAccuracy: 0.8,
        cumulativeInputTokens: 4_000,
        medianResponseLatencyMs: 1_200
      })
    ];
    const input = {
      title: "Continuum evaluation",
      generatedAt: "2026-01-01T00:00:00.000Z",
      config: { seed: 1, model: "fixture" },
      metrics,
      runs: [] as EvaluationRunRecord[],
      competitors: [],
      budgetTotalUsd: 0,
      fullHistoryPromptTokensAt10k: 10_000,
      representativeSuccesses: ["Retrieved a superseded decision."],
      representativeFailures: []
    };
    const gates = evaluateReleaseGates(input);
    expect(gates.find((gate) => gate.name.includes("Accuracy"))?.passed).toBe(true);
    const unmeasuredLatency = evaluateReleaseGates({
      ...input,
      metrics: metrics.map((item) => ({ ...item, medianResponseLatencyMs: 0 }))
    }).find((gate) => gate.name === "Median latency overhead");
    expect(unmeasuredLatency).toMatchObject({ passed: false });
    expect(unmeasuredLatency?.actual).toBeNaN();
    const report = generateEvaluationReport(input);
    expect(report.markdown).toContain("Configuration hash");
    expect(report.markdown).toContain("Accuracy 95% CI");
    expect(report.html).toContain("<svg");
    expect(report.html).toContain("Representative successes");
    expect(report.html).toContain("Performance measurements");
    expect(report.configHash).toHaveLength(64);
  });

  it("escapes untrusted artifact text in Markdown and HTML reports", () => {
    const payload = '</h1><img src=x onerror="alert(1)">\n# injected | [click](javascript:alert(1)) `fence`';
    const report = generateEvaluationReport({
      title: payload,
      generatedAt: payload,
      config: { attackerControlled: payload },
      metrics: [
        aggregate("recent_window"),
        aggregate("rolling_summary"),
        aggregate("flat_hybrid"),
        aggregate("continuum")
      ],
      runs: [],
      competitors: [{
        product: payload,
        date: payload,
        visibleModelSetting: payload,
        promptProtocol: payload,
        transcriptHandling: payload,
        score: 0,
        notes: payload
      }],
      budgetTotalUsd: 0,
      fullHistoryPromptTokensAt10k: null,
      representativeSuccesses: [payload],
      representativeFailures: [payload],
      limitations: [payload],
      provenance: { revision: payload, environment: payload },
      performance: {
        searchP95Ms: null,
        firstTokenMedianMs: null,
        memorySearchableP95Ms: null,
        firstTokenReleaseEligible: false,
        memorySearchableReleaseEligible: false,
        eligibilityNotes: [payload],
        source: payload
      },
      diagnostics: [{ title: payload, status: "warning", summary: payload, details: { payload } }]
    });
    const markdownOutsideCodeFences = report.markdown.replace(/```[\s\S]*?```/g, "");
    expect(report.markdown).not.toContain("\n# injected");
    expect(markdownOutsideCodeFences).not.toContain("[click](javascript:");
    expect(report.markdown).toContain("\\# injected \\| \\[click\\]\\(javascript:alert\\(1\\)\\)");
    expect(report.html).not.toContain("<img src=x");
    expect(report.html).not.toContain("</h1><img");
    expect(report.html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });
});
