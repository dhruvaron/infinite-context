import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  aggregateCompetitorCaptures,
  competitorComparisonMarkdown,
  parseCompetitorCapture,
  validateCompetitorCapture
} from "./competitor-capture.js";
import { DurableEvaluationBudgetGuard } from "./durable-budget.js";
import { assertPinnedEvaluationModel, PortableEvaluationRetriever } from "./live-evaluation.js";
import { runLatencyHarness, validateLatencyHarnessResult } from "./latency-harness.js";
import {
  HALUMEM_ADAPTER,
  LONGMEMEVAL_ADAPTER,
  PUBLIC_DATASET_REGISTRY,
  readPublicDatasetRecords,
  validatePublicDatasetOutputPaths,
  verifyPublicDatasetImportManifest,
  verifyPublicDatasetSource,
  type PublicDatasetAdapterContext,
  type VerifiedPublicDatasetSource
} from "./public-datasets.js";

const context: PublicDatasetAdapterContext = {
  sourceUrl: "https://publisher.example/fixture",
  sourceSha256: "a".repeat(64),
  sourceVariant: "synthetic-test",
  licenseSpdx: "MIT",
  verifiedAgainstRegistry: false
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public benchmark adapter boundaries", () => {
  it("keeps each LongMemEval question in its own timeline and maps session evidence", () => {
    const adapted = LONGMEMEVAL_ADAPTER.adaptRecord({
      question_id: "question-1",
      question_type: "knowledge-update",
      question: "Which database is current?",
      answer: "PostgreSQL",
      haystack_session_ids: ["old", "new"],
      haystack_dates: ["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"],
      haystack_sessions: [
        [{ role: "user", content: "We first chose MongoDB." }],
        [{ role: "user", content: "Correction: PostgreSQL replaces it.", has_answer: true }]
      ],
      answer_session_ids: ["new"]
    }, 0, context);
    expect(adapted.messages).toHaveLength(2);
    expect(adapted.probes).toHaveLength(1);
    expect(adapted.probes[0]).toMatchObject({
      category: "decision_supersession",
      expectedCurrentValue: "PostgreSQL",
      expectedEvidenceIds: ["longmemeval-question-1-s2-t1"]
    });
    expect(adapted.provenance).toContain("verified=false");
  });

  it("maps HaluMem users, session checkpoints, questions, and memory evidence", () => {
    const adapted = HALUMEM_ADAPTER.adaptRecord({
      uuid: "user-1",
      sessions: [{
        start_time: "2026-01-01T00:00:00Z",
        dialogue: [
          { role: "user", content: "I now prefer green.", timestamp: "2026-01-01T00:00:00Z" },
          { role: "assistant", content: "Green is current.", timestamp: "2026-01-01T00:00:01Z" }
        ],
        memory_points: [{ memory_content: "The user currently prefers green." }],
        questions: [{
          question: "What is the current preference?",
          answer: "green",
          question_type: "Memory Update",
          evidence: [{ memory_content: "The user currently prefers green." }]
        }]
      }]
    }, 0, { ...context, licenseSpdx: "CC-BY-NC-ND-4.0" });
    expect(adapted.messages).toHaveLength(2);
    expect(adapted.probes[0]?.checkpoint).toBe(2);
    expect(adapted.probes[0]?.expectedEvidenceIds).toEqual([
      "halumem-user-1-s1-t1",
      "halumem-user-1-s1-t2"
    ]);
    expect(adapted.license).toBe("CC-BY-NC-ND-4.0");
  });

  it("pins primary-source variants and rejects unrecognized bytes", async () => {
    expect(PUBLIC_DATASET_REGISTRY.longmemeval.license.spdx).toBe("MIT");
    expect(PUBLIC_DATASET_REGISTRY.halumem.license).toMatchObject({
      spdx: "CC-BY-NC-ND-4.0",
      adaptedRedistributionAllowed: false,
      commercialUseAllowed: false
    });
    for (const descriptor of Object.values(PUBLIC_DATASET_REGISTRY)) {
      for (const variant of descriptor.variants) expect(variant.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    const directory = await mkdtemp(join(tmpdir(), "continuum-source-"));
    const path = join(directory, "longmemeval_oracle.json");
    await writeFile(path, "[]\n", "utf8");
    await expect(verifyPublicDatasetSource({
      dataset: "longmemeval",
      variant: "oracle",
      inputPath: path,
      acknowledgedLicense: "MIT"
    })).rejects.toThrow(/hash mismatch/i);
  });

  it("streams top-level JSON array records without loading a monolithic input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuum-stream-"));
    const path = join(directory, "records.json");
    await writeFile(path, '[{"value":"brace } and quote \\" stay inside"},{"nested":[{"x":1}]}]\n', "utf8");
    const descriptor = PUBLIC_DATASET_REGISTRY.longmemeval;
    const variant = { ...descriptor.variants[0]!, format: "json-array" as const };
    const source: VerifiedPublicDatasetSource = {
      descriptor,
      variant,
      inputPath: path,
      byteLength: (await readFile(path)).byteLength,
      sha256: createHash("sha256").update(await readFile(path)).digest("hex"),
      verifiedAt: "2026-01-01T00:00:00.000Z"
    };
    const records: unknown[] = [];
    for await (const record of readPublicDatasetRecords(source)) records.push(record);
    expect(records).toEqual([
      { value: 'brace } and quote " stay inside' },
      { nested: [{ x: 1 }] }
    ]);
  });

  it("rehashes the exact parsed bytes and rejects a source changed after initial verification", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuum-source-toctou-"));
    const path = join(directory, "records.json");
    const original = '[{"value":"verified"}]\n';
    await writeFile(path, original, "utf8");
    const descriptor = PUBLIC_DATASET_REGISTRY.longmemeval;
    const source: VerifiedPublicDatasetSource = {
      descriptor,
      variant: { ...descriptor.variants[0]!, format: "json-array" },
      inputPath: path,
      byteLength: Buffer.byteLength(original),
      sha256: createHash("sha256").update(original).digest("hex"),
      verifiedAt: "2026-01-01T00:00:00.000Z"
    };
    await writeFile(path, '[{"value":"swapped"}]\n', "utf8");
    await expect((async () => {
      for await (const record of readPublicDatasetRecords(source)) void record;
    })()).rejects.toThrow(/changed after verification/i);
  });

  it("cross-checks manifest registry fields and prevents output overwrite or path aliasing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuum-manifest-"));
    const inputPath = join(directory, "datasets.jsonl");
    const outputBytes = '{"fixture":true}\n';
    await writeFile(inputPath, outputBytes, "utf8");
    const descriptor = PUBLIC_DATASET_REGISTRY.longmemeval;
    const variant = descriptor.variants.find((candidate) => candidate.key === "oracle")!;
    const manifestPath = join(directory, "import-manifest.json");
    const manifest = {
      schemaVersion: 1,
      conversion: "continuum-public-dataset-adapter/2.0.0",
      generatedAt: "2026-01-01T00:00:00.000Z",
      dataset: descriptor.displayName,
      variant: variant.key,
      source: {
        publisherUrl: variant.sourceUrl,
        upstreamRevision: variant.upstreamRevision,
        byteLength: variant.sizeBytesApproximate,
        sha256: "f".repeat(64),
        hashVerifiedAgainstRegistry: true
      },
      license: {
        spdx: descriptor.license.spdx,
        textUrl: descriptor.license.sourceUrl,
        acknowledgedByOperator: true,
        adaptedRedistributionAllowed: descriptor.license.adaptedRedistributionAllowed,
        commercialUseAllowed: descriptor.license.commercialUseAllowed
      },
      output: {
        file: "datasets.jsonl",
        sha256: createHash("sha256").update(outputBytes).digest("hex"),
        records: 1,
        messages: 1,
        probes: 1,
        completeSource: false
      }
    };
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    await expect(verifyPublicDatasetImportManifest(inputPath, manifestPath)).rejects.toThrow(/source SHA-256/i);
    manifest.source.sha256 = variant.sha256;
    await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    await expect(verifyPublicDatasetImportManifest(inputPath, manifestPath)).resolves.toMatchObject({ variant: { key: "oracle" } });

    await expect(validatePublicDatasetOutputPaths({ inputPath, outputDirectory: directory, overwrite: true })).rejects.toThrow(/overwrite its input/i);
    const safeOutput = join(directory, "output");
    await mkdir(safeOutput);
    await writeFile(join(safeOutput, "datasets.jsonl"), "existing", "utf8");
    await expect(validatePublicDatasetOutputPaths({ inputPath, outputDirectory: safeOutput, overwrite: false })).rejects.toThrow(/already exists/i);
    const linkedOutput = join(directory, "linked-output");
    await mkdir(linkedOutput);
    await symlink(inputPath, join(linkedOutput, "import-manifest.json"));
    await expect(validatePublicDatasetOutputPaths({ inputPath, outputDirectory: linkedOutput, overwrite: true })).rejects.toThrow(/aliases|links/i);
  });
});

describe("durable paid-evaluation ledger", () => {
  it("persists reservations atomically and conservatively accounts uncertain failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuum-ledger-"));
    const path = join(directory, "ledger.json");
    const first = new DurableEvaluationBudgetGuard(path, { now: () => "2026-01-01T00:00:00.000Z" });
    first.reserve({ callId: "successful", category: "final_evaluation", estimatedCostUsd: 0.5, essential: true });
    first.commit("successful", 0.3);
    first.reserve({ callId: "uncertain", category: "final_evaluation", estimatedCostUsd: 0.4, essential: true });
    first.release("uncertain");
    const second = new DurableEvaluationBudgetGuard(path);
    expect(second.snapshot()).toMatchObject({ committedUsd: 0.7, reservedUsd: 0, hardCapUsd: 100, durable: true });
    expect(() => second.reserve({ callId: "successful", category: "final_evaluation", estimatedCostUsd: 0.1, essential: true })).toThrow(/duplicate/i);
    const raw = await readFile(path, "utf8");
    expect(raw).toContain("conservative-uncertain-failure");
    expect(raw).not.toContain("apiKey");
  });

  it("preflights the entire plan against category allocation and global cap", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuum-ledger-plan-"));
    const guard = new DurableEvaluationBudgetGuard(join(directory, "ledger.json"));
    expect(() => guard.assertCanReserveTotal({ category: "final_evaluation", estimatedCostUsd: 60.01, essential: true })).toThrow(/allocation/i);
    expect(() => guard.assertCanReserveTotal({ category: "final_evaluation", estimatedCostUsd: 60, essential: true })).not.toThrow();
  });

  it("fails closed on malformed or duplicate ledger accounting records", async () => {
    const corrupt = async (mutate: (ledger: Record<string, unknown>) => void): Promise<void> => {
      const directory = await mkdtemp(join(tmpdir(), "continuum-ledger-corrupt-"));
      const path = join(directory, "ledger.json");
      const guard = new DurableEvaluationBudgetGuard(path);
      guard.reserve({ callId: "call-1", category: "final_evaluation", estimatedCostUsd: 0.5, essential: true });
      const ledger = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      mutate(ledger);
      await writeFile(path, JSON.stringify(ledger), "utf8");
      expect(() => new DurableEvaluationBudgetGuard(path)).toThrow(/ledger|entry|duplicate|cost/i);
    };

    await corrupt((ledger) => {
      (ledger.entries as Array<Record<string, unknown>>)[0]!.status = "forged";
    });
    await corrupt((ledger) => {
      const entries = ledger.entries as Array<Record<string, unknown>>;
      entries.push({ ...entries[0] });
    });
    await corrupt((ledger) => {
      (ledger.entries as Array<Record<string, unknown>>)[0]!.estimatedCostUsd = "0.01";
    });
  });

  it("recovers only an old lock whose recorded process is no longer alive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuum-ledger-abandoned-"));
    const path = join(directory, "ledger.json");
    const first = new DurableEvaluationBudgetGuard(path);
    expect(first.snapshot().committedUsd).toBe(0);
    const lockPath = `${path}.lock`;
    await writeFile(lockPath, JSON.stringify({
      pid: 2_147_483_647,
      token: "abandoned-test-lock",
      createdAt: "2000-01-01T00:00:00.000Z"
    }), "utf8");
    const old = new Date("2000-01-01T00:00:00.000Z");
    await utimes(lockPath, old, old);
    const recovered = new DurableEvaluationBudgetGuard(path);
    expect(recovered.snapshot()).toMatchObject({ committedUsd: 0, reservedUsd: 0, breached: false });
  });
});

describe("latency and post-turn searchability harness", () => {
  it("measures first token and compiled-memory search while excluding mock timings from release gates", async () => {
    let budgetReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("/runtime")) {
        return new Response(JSON.stringify({ mockProvider: true, providerReachable: true, version: "test", vectorMode: "fallback" }), { status: 200 });
      }
      if (url.pathname.endsWith("/budget")) {
        budgetReads += 1;
        return new Response(JSON.stringify({ spentUsd: 0, hardLimitUsd: 100, reservedUsd: 0, read: budgetReads }), { status: 200 });
      }
      if (url.pathname.endsWith("/messages")) {
        return new Response(JSON.stringify({ runId: "run-1", event: { id: "user-1" } }), { status: 202 });
      }
      if (url.pathname.endsWith("/stream")) {
        const body = [
          'data: {"type":"response.delta","delta":"recorded"}',
          '',
          'data: {"type":"run.completed","event":{"id":"assistant-1"}}',
          '',
          ''
        ].join("\n");
        return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      if (url.pathname.endsWith("/search")) {
        return new Response(JSON.stringify({
          results: [{ type: "claim", title: "continuum_latency_1_fixed", snippet: "compiled claim" }],
          tookMs: 1.5
        }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }));
    const result = await runLatencyHarness({
      apiOrigin: "http://127.0.0.1:4317",
      sessionToken: "x".repeat(32),
      samples: 1,
      markerFactory: () => "continuum_latency_1_fixed",
      normalProviderConditions: true
    });
    expect(result.firstToken.measured).toBe(1);
    expect(result.postTurnSearchability.measured).toBe(1);
    expect(result.samples[0]).toMatchObject({ compiledSearchResultType: "claim", error: null });
    expect(result.eligibility).toMatchObject({
      firstTokenReleaseGate: false,
      postTurnSearchabilityReleaseGate: false
    });
    expect(result.eligibility.reasons.join(" ")).toMatch(/mock-provider/i);
    expect(() => validateLatencyHarnessResult(result)).not.toThrow();

    const tampered = structuredClone(result) as unknown as Record<string, unknown>;
    (tampered.eligibility as Record<string, unknown>).firstTokenReleaseGate = true;
    const core = Object.fromEntries(Object.entries(tampered).filter(([key]) => key !== "resultHash"));
    tampered.resultHash = createHash("sha256").update(JSON.stringify(core)).digest("hex");
    expect(() => validateLatencyHarnessResult(tampered)).toThrow(/eligibility/i);
  });

  it("stops before another paid message when the application reaches USD 95", async () => {
    let budgetReads = 0;
    let messagePosts = 0;
    const spentByRead = [94, 94, 95, 95, 95];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("/runtime")) {
        return new Response(JSON.stringify({ mockProvider: false, providerReachable: true, version: "test", vectorMode: "sqlite-vector" }), { status: 200 });
      }
      if (url.pathname.endsWith("/budget")) {
        const spentUsd = spentByRead[Math.min(budgetReads, spentByRead.length - 1)]!;
        budgetReads += 1;
        return new Response(JSON.stringify({ spentUsd, hardLimitUsd: 100, reservedUsd: 0 }), { status: 200 });
      }
      if (url.pathname.endsWith("/messages")) {
        messagePosts += 1;
        return new Response(JSON.stringify({ runId: "run-1", event: { id: "user-1" } }), { status: 202 });
      }
      if (url.pathname.endsWith("/stream")) {
        return new Response([
          'data: {"type":"response.delta","delta":"recorded"}',
          "",
          'data: {"type":"run.completed","event":{"id":"assistant-1"}}',
          "",
          ""
        ].join("\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      if (url.pathname.endsWith("/search")) {
        const marker = url.searchParams.get("q") ?? "";
        return new Response(JSON.stringify({ results: [{ type: "claim", title: marker, snippet: "compiled" }], tookMs: 1 }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }));
    const result = await runLatencyHarness({
      apiOrigin: "http://127.0.0.1:4317",
      sessionToken: "x".repeat(32),
      samples: 3,
      allowLive: true,
      liveTestsEnabled: true,
      normalProviderConditions: true,
      paidApiAcknowledged: true
    });
    expect(messagePosts).toBe(1);
    expect(result.samples).toHaveLength(2);
    expect(result.samples[1]?.error).toMatch(/USD 95/i);
    expect(result.eligibility).toMatchObject({ firstTokenReleaseGate: false, postTurnSearchabilityReleaseGate: false });
    expect(() => validateLatencyHarnessResult(result)).not.toThrow();
  });

  it("requires explicit paid execution acknowledgement and refuses remote token destinations", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      mockProvider: false,
      providerReachable: true,
      version: "test",
      vectorMode: "sqlite-vector"
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(runLatencyHarness({
      apiOrigin: "http://127.0.0.1:4317",
      sessionToken: "secret",
      allowLive: true,
      liveTestsEnabled: true
    })).rejects.toThrow(/acknowledge-paid-api/i);
    await expect(runLatencyHarness({
      apiOrigin: "https://example.com",
      sessionToken: "secret"
    })).rejects.toThrow(/loopback/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("manual competitor capture", () => {
  it("accepts the checked-in blank template only as a template, never as a result", async () => {
    const templatePath = resolve("fixtures/competitors/capture.template.json");
    const parsed = parseCompetitorCapture(JSON.parse(await readFile(templatePath, "utf8")) as unknown, true);
    expect(parsed.status).toBe("template");
    expect(() => parseCompetitorCapture(parsed)).toThrow(/cannot produce comparison results/i);
  });

  it("hashes manual transcripts and aggregates only explicitly supplied numeric scores", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuum-competitor-"));
    const protocol = {
      schemaVersion: 1,
      protocolId: "test-protocol",
      protocolVersion: "1.0.0",
      title: "Test protocol",
      startingState: "Start a fresh chat.",
      interactionRules: ["Use identical turns."],
      stopRule: "Stop after the probe.",
      scenarios: [{ id: "recall", title: "Recall", checkpoint: 1000, promptPurpose: "Test recall." }]
    };
    await writeFile(join(directory, "protocol.json"), JSON.stringify(protocol), "utf8");
    await writeFile(join(directory, "transcript.txt"), "User: probe\nAssistant: observed answer\n", "utf8");
    const capture = {
      schemaVersion: 1,
      status: "complete",
      captureId: "chatgpt-manual-1",
      product: "ChatGPT",
      capturedAt: "2026-01-01T00:00:00.000Z",
      productSurface: "web",
      visibleModelSetting: "visible-setting",
      protocolPath: "protocol.json",
      transcript: { path: "transcript.txt", sha256: null, handling: "manual-copy", redactions: "none" },
      scores: [{
        scenarioId: "recall",
        checkpoint: 1000,
        turnLocator: "lines 1-2",
        metrics: { answerAccuracy: 0.75, memoryRecall: null, temporalCorrectness: null, unsupportedMemoryResistance: null },
        evaluator: "human",
        rationale: "The visible answer contained three of four required facts."
      }],
      attestation: {
        capturedManually: true,
        noAutomatedProductInteraction: true,
        transcriptUneditedExceptDeclaredRedactions: true,
        internalPromptsAndRetrievalUnobserved: true,
        attestedBy: "human"
      },
      notes: "Manual test capture."
    };
    const capturePath = join(directory, "capture.json");
    await writeFile(capturePath, JSON.stringify(capture), "utf8");
    const validated = await validateCompetitorCapture(capturePath);
    const result = aggregateCompetitorCaptures([validated], "2026-01-02T00:00:00.000Z");
    expect(validated.transcriptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.aggregates[0]?.metrics.answerAccuracy).toEqual({ mean: 0.75, measured: 1 });
    expect(result.aggregates[0]?.metrics.memoryRecall).toEqual({ mean: null, measured: 0 });
  });

  it("rejects duplicate weighting, protocol drift, and incomplete scenario coverage", async () => {
    const base = {
      captureId: "capture-1",
      product: "ChatGPT" as const,
      capturedAt: "2026-01-01T00:00:00.000Z",
      productSurface: "web",
      visibleModelSetting: "visible",
      transcriptFile: "transcript.txt",
      transcriptSha256: "a".repeat(64),
      transcriptBytes: 10,
      transcriptHandling: "manual-copy",
      transcriptRedactions: "none",
      protocolId: "protocol",
      protocolVersion: "1",
      protocolSha256: "b".repeat(64),
      protocolScenarios: [{ id: "recall", title: "Recall", checkpoint: 1000, promptPurpose: "Recall." }],
      scores: [{
        scenarioId: "recall",
        checkpoint: 1000,
        turnLocator: "line 1",
        metrics: { answerAccuracy: 1, memoryRecall: null, temporalCorrectness: null, unsupportedMemoryResistance: null },
        evaluator: "human",
        rationale: "Observed."
      }],
      attestedBy: "human",
      notes: "note"
    };
    expect(() => aggregateCompetitorCaptures([base, { ...base }])).toThrow(/capture IDs/i);
    expect(() => aggregateCompetitorCaptures([base, {
      ...base,
      captureId: "capture-2"
    }])).toThrow(/transcript/i);
    expect(() => aggregateCompetitorCaptures([base, {
      ...base,
      captureId: "capture-2",
      transcriptSha256: "c".repeat(64),
      protocolSha256: "d".repeat(64)
    }])).toThrow(/protocol/i);

    expect(() => parseCompetitorCapture({
      schemaVersion: 1,
      status: "complete",
      captureId: "duplicate-score",
      product: "ChatGPT",
      capturedAt: "2026-01-01T00:00:00.000Z",
      productSurface: "web",
      visibleModelSetting: "visible",
      protocolPath: "protocol.json",
      transcript: { path: "transcript.txt", sha256: null, handling: "manual-copy", redactions: "none" },
      scores: [base.scores[0], base.scores[0]],
      attestation: {
        capturedManually: true,
        noAutomatedProductInteraction: true,
        transcriptUneditedExceptDeclaredRedactions: true,
        internalPromptsAndRetrievalUnobserved: true,
        attestedBy: "human"
      },
      notes: "note"
    })).toThrow(/only once/i);

    const directory = await mkdtemp(join(tmpdir(), "continuum-competitor-coverage-"));
    await writeFile(join(directory, "protocol.json"), JSON.stringify({
      schemaVersion: 1,
      protocolId: "coverage",
      protocolVersion: "1",
      title: "Coverage",
      startingState: "Fresh chat.",
      interactionRules: ["Follow every scenario."],
      stopRule: "Stop after both scenarios.",
      scenarios: [
        { id: "recall", title: "Recall", checkpoint: 1, promptPurpose: "Recall." },
        { id: "supersession", title: "Supersession", checkpoint: 2, promptPurpose: "Use current value." }
      ]
    }), "utf8");
    await writeFile(join(directory, "transcript.txt"), "Visible transcript", "utf8");
    await writeFile(join(directory, "capture.json"), JSON.stringify({
      schemaVersion: 1,
      status: "complete",
      captureId: "incomplete",
      product: "ChatGPT",
      capturedAt: "2026-01-01T00:00:00.000Z",
      productSurface: "web",
      visibleModelSetting: "visible",
      protocolPath: "protocol.json",
      transcript: { path: "transcript.txt", sha256: null, handling: "manual-copy", redactions: "none" },
      scores: [{ ...base.scores[0], checkpoint: 1 }],
      attestation: {
        capturedManually: true,
        noAutomatedProductInteraction: true,
        transcriptUneditedExceptDeclaredRedactions: true,
        internalPromptsAndRetrievalUnobserved: true,
        attestedBy: "human"
      },
      notes: "One scenario omitted."
    }), "utf8");
    await expect(validateCompetitorCapture(join(directory, "capture.json"))).rejects.toThrow(/omits protocol scenarios/i);
  });

  it("neutralizes Markdown control characters in comparison provenance", () => {
    const result = aggregateCompetitorCaptures([{
      captureId: "capture\n## injected",
      product: "ChatGPT",
      capturedAt: "2026-01-01T00:00:00.000Z",
      productSurface: "web | [link](javascript:alert(1))",
      visibleModelSetting: "`break`\n# heading",
      transcriptFile: "transcript`file.md",
      transcriptSha256: "a".repeat(64),
      transcriptBytes: 10,
      transcriptHandling: "manual-copy",
      transcriptRedactions: "none",
      protocolId: "proto|col",
      protocolVersion: "1",
      protocolSha256: "b".repeat(64),
      protocolScenarios: [{ id: "recall", title: "Recall", checkpoint: 1, promptPurpose: "Recall." }],
      scores: [{
        scenarioId: "recall",
        checkpoint: 1,
        turnLocator: "line 1",
        metrics: { answerAccuracy: 1, memoryRecall: null, temporalCorrectness: null, unsupportedMemoryResistance: null },
        evaluator: "human",
        rationale: "Observed."
      }],
      attestedBy: "human",
      notes: "note"
    }], "2026-01-02T00:00:00.000Z");
    const markdown = competitorComparisonMarkdown(result);
    expect(markdown).not.toContain("\n## injected");
    expect(markdown).not.toContain("[link](javascript:");
    expect(markdown).toContain("\\| \\[link\\]\\(javascript:alert\\(1\\)\\)");
  });
});

describe("pinned paid-evaluation pricing", () => {
  it("fails closed for unknown or embedding models", () => {
    expect(() => assertPinnedEvaluationModel("gpt-5.4-mini")).not.toThrow();
    expect(() => assertPinnedEvaluationModel("future-unpriced-model")).toThrow(/no pinned price/i);
    expect(() => assertPinnedEvaluationModel("text-embedding-3-small")).toThrow(/embedding model/i);
  });
});

describe("portable live-evaluation retrieval", () => {
  it("retrieves by visible query text and never consults hidden expected evidence IDs", async () => {
    const retriever = new PortableEvaluationRetriever();
    const result = await retriever.retrieve({
      query: "Which database is current?",
      history: [
        { id: "irrelevant", sequence: 1, role: "user", content: "The logo is blue.", tokenCount: 5, topic: "ui", createdAt: "2026-01-01T00:00:00Z" },
        { id: "database", sequence: 2, role: "user", content: "Correction: the current database is PostgreSQL.", tokenCount: 9, topic: "architecture", createdAt: "2026-01-02T00:00:00Z" }
      ],
      tokenBudget: 100,
      mode: "continuum"
    });
    expect(result.evidenceIds[0]).toBe("database");
    expect(result.metadata).toMatchObject({ productionContinuumRetriever: false });
  });
});
