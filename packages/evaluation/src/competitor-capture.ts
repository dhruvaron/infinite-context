import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export type CompetitorProduct = "ChatGPT" | "Codex";
export type CompetitorMetric =
  | "answerAccuracy"
  | "memoryRecall"
  | "temporalCorrectness"
  | "unsupportedMemoryResistance";

export interface CompetitorProtocolScenario {
  id: string;
  title: string;
  checkpoint: number;
  promptPurpose: string;
}

export interface CompetitorProtocol {
  schemaVersion: 1;
  protocolId: string;
  protocolVersion: string;
  title: string;
  startingState: string;
  interactionRules: string[];
  stopRule: string;
  scenarios: CompetitorProtocolScenario[];
}

export interface CompetitorCaptureScore {
  scenarioId: string;
  checkpoint: number;
  turnLocator: string;
  metrics: Record<CompetitorMetric, number | null>;
  evaluator: string;
  rationale: string;
}

export interface CompetitorCaptureFile {
  schemaVersion: 1;
  status: "template" | "complete";
  captureId: string;
  product: CompetitorProduct;
  capturedAt: string;
  productSurface: string;
  visibleModelSetting: string;
  protocolPath: string;
  transcript: {
    path: string;
    sha256: string | null;
    handling: "manual-export" | "manual-copy" | "screen-transcription";
    redactions: string;
  };
  scores: CompetitorCaptureScore[];
  attestation: {
    capturedManually: boolean;
    noAutomatedProductInteraction: boolean;
    transcriptUneditedExceptDeclaredRedactions: boolean;
    internalPromptsAndRetrievalUnobserved: boolean;
    attestedBy: string;
  };
  notes: string;
}

export interface ValidatedCompetitorCapture {
  captureId: string;
  product: CompetitorProduct;
  capturedAt: string;
  productSurface: string;
  visibleModelSetting: string;
  transcriptFile: string;
  transcriptSha256: string;
  transcriptBytes: number;
  transcriptHandling: string;
  transcriptRedactions: string;
  protocolId: string;
  protocolVersion: string;
  protocolSha256: string;
  protocolScenarios: CompetitorProtocolScenario[];
  scores: CompetitorCaptureScore[];
  attestedBy: string;
  notes: string;
}

export interface CompetitorComparisonResult {
  schemaVersion: 1;
  evidenceClass: "manual-black-box-product-comparison";
  generatedAt: string;
  captures: ValidatedCompetitorCapture[];
  aggregates: Array<{
    product: CompetitorProduct;
    captures: number;
    scoredScenarios: number;
    metrics: Record<CompetitorMetric, { mean: number | null; measured: number }>;
  }>;
  caveats: string[];
  resultHash: string;
}

const METRICS: CompetitorMetric[] = [
  "answerAccuracy",
  "memoryRecall",
  "temporalCorrectness",
  "unsupportedMemoryResistance"
];

function record(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${description} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, description: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${description} must be a non-empty string`);
  return value;
}

function date(value: unknown, description: string): string {
  const text = string(value, description);
  if (!Number.isFinite(new Date(text).valueOf())) throw new Error(`${description} must be an ISO-compatible date`);
  return text;
}

function metricValue(value: unknown, description: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${description} must be null or a number from 0 to 1`);
  }
  return value;
}

export function parseCompetitorProtocol(value: unknown): CompetitorProtocol {
  const input = record(value, "Competitor protocol");
  if (input.schemaVersion !== 1) throw new Error("Competitor protocol schemaVersion must be 1");
  const scenarios = Array.isArray(input.scenarios) ? input.scenarios.map((scenarioValue, index) => {
    const scenario = record(scenarioValue, `Protocol scenario ${index + 1}`);
    const checkpoint = Number(scenario.checkpoint);
    if (!Number.isInteger(checkpoint) || checkpoint < 1) throw new Error(`Protocol scenario ${index + 1} checkpoint must be positive`);
    return {
      id: string(scenario.id, `Protocol scenario ${index + 1} id`),
      title: string(scenario.title, `Protocol scenario ${index + 1} title`),
      checkpoint,
      promptPurpose: string(scenario.promptPurpose, `Protocol scenario ${index + 1} promptPurpose`)
    };
  }) : [];
  if (scenarios.length === 0) throw new Error("Competitor protocol must define scenarios");
  if (new Set(scenarios.map((scenario) => scenario.id)).size !== scenarios.length) throw new Error("Competitor scenario IDs must be unique");
  return {
    schemaVersion: 1,
    protocolId: string(input.protocolId, "protocolId"),
    protocolVersion: string(input.protocolVersion, "protocolVersion"),
    title: string(input.title, "protocol title"),
    startingState: string(input.startingState, "protocol startingState"),
    interactionRules: Array.isArray(input.interactionRules) ? input.interactionRules.map((item, index) => string(item, `interactionRules[${index}]`)) : [],
    stopRule: string(input.stopRule, "protocol stopRule"),
    scenarios
  };
}

export function parseCompetitorCapture(value: unknown, allowTemplate = false): CompetitorCaptureFile {
  const input = record(value, "Competitor capture");
  if (input.schemaVersion !== 1) throw new Error("Competitor capture schemaVersion must be 1");
  if (input.status !== "template" && input.status !== "complete") throw new Error("Capture status must be template or complete");
  if (input.status === "template" && !allowTemplate) throw new Error("Template captures cannot produce comparison results");
  if (input.product !== "ChatGPT" && input.product !== "Codex") throw new Error("Capture product must be ChatGPT or Codex");
  const transcript = record(input.transcript, "capture transcript");
  const attestation = record(input.attestation, "capture attestation");
  const scores = Array.isArray(input.scores) ? input.scores.map((scoreValue, index) => {
    const score = record(scoreValue, `Capture score ${index + 1}`);
    const metrics = record(score.metrics, `Capture score ${index + 1} metrics`);
    const checkpoint = Number(score.checkpoint);
    if (!Number.isInteger(checkpoint) || checkpoint < 1) throw new Error(`Capture score ${index + 1} checkpoint must be positive`);
    return {
      scenarioId: string(score.scenarioId, `Capture score ${index + 1} scenarioId`),
      checkpoint,
      turnLocator: string(score.turnLocator, `Capture score ${index + 1} turnLocator`),
      metrics: Object.fromEntries(METRICS.map((metric) => [metric, metricValue(metrics[metric], `${metric} score`)])) as Record<CompetitorMetric, number | null>,
      evaluator: string(score.evaluator, `Capture score ${index + 1} evaluator`),
      rationale: string(score.rationale, `Capture score ${index + 1} rationale`)
    };
  }) : [];
  if (input.status === "complete" && scores.length === 0) throw new Error("Complete captures require at least one manually scored scenario");
  if (new Set(scores.map((score) => score.scenarioId)).size !== scores.length) throw new Error("A competitor capture may score each protocol scenario only once");
  const handling = transcript.handling;
  if (handling !== "manual-export" && handling !== "manual-copy" && handling !== "screen-transcription") {
    throw new Error("Transcript handling must document a manual capture method");
  }
  return {
    schemaVersion: 1,
    status: input.status,
    captureId: string(input.captureId, "captureId"),
    product: input.product,
    capturedAt: date(input.capturedAt, "capturedAt"),
    productSurface: string(input.productSurface, "productSurface"),
    visibleModelSetting: string(input.visibleModelSetting, "visibleModelSetting"),
    protocolPath: string(input.protocolPath, "protocolPath"),
    transcript: {
      path: string(transcript.path, "transcript path"),
      sha256: transcript.sha256 === null ? null : (() => {
        const value = string(transcript.sha256, "transcript sha256");
        if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Transcript sha256 must be a lowercase SHA-256 digest");
        return value;
      })(),
      handling,
      redactions: string(transcript.redactions, "transcript redactions")
    },
    scores,
    attestation: {
      capturedManually: attestation.capturedManually === true,
      noAutomatedProductInteraction: attestation.noAutomatedProductInteraction === true,
      transcriptUneditedExceptDeclaredRedactions: attestation.transcriptUneditedExceptDeclaredRedactions === true,
      internalPromptsAndRetrievalUnobserved: attestation.internalPromptsAndRetrievalUnobserved === true,
      attestedBy: string(attestation.attestedBy, "attestedBy")
    },
    notes: string(input.notes, "capture notes")
  };
}

export async function validateCompetitorCapture(path: string): Promise<ValidatedCompetitorCapture> {
  const absolute = resolve(path);
  const capture = parseCompetitorCapture(JSON.parse(await readFile(absolute, "utf8")) as unknown);
  if (!Object.entries(capture.attestation).every(([key, value]) => key === "attestedBy" || value === true)) {
    throw new Error(`${capture.captureId} is missing a required manual black-box attestation`);
  }
  const protocolPath = resolve(dirname(absolute), capture.protocolPath);
  const transcriptPath = resolve(dirname(absolute), capture.transcript.path);
  const [protocolBytes, transcriptBytes] = await Promise.all([
    readFile(protocolPath),
    readFile(transcriptPath)
  ]);
  const protocolSha256 = createHash("sha256").update(protocolBytes).digest("hex");
  const transcriptSha256 = createHash("sha256").update(transcriptBytes).digest("hex");
  const transcriptText = transcriptBytes.toString("utf8");
  if (!transcriptText.trim()) throw new Error(`${capture.captureId} transcript is empty`);
  if (capture.transcript.sha256 !== null && capture.transcript.sha256 !== transcriptSha256) {
    throw new Error(`${capture.captureId} transcript hash does not match the capture file`);
  }
  const protocol = parseCompetitorProtocol(JSON.parse(protocolBytes.toString("utf8")) as unknown);
  const scenarioById = new Map(protocol.scenarios.map((scenario) => [scenario.id, scenario]));
  for (const score of capture.scores) {
    const scenario = scenarioById.get(score.scenarioId);
    if (!scenario) throw new Error(`${capture.captureId} scores unknown scenario ${score.scenarioId}`);
    if (scenario.checkpoint !== score.checkpoint) throw new Error(`${capture.captureId}/${score.scenarioId} checkpoint differs from protocol`);
  }
  const missingScenarios = protocol.scenarios.filter((scenario) => !capture.scores.some((score) => score.scenarioId === scenario.id));
  if (missingScenarios.length) {
    throw new Error(`${capture.captureId} omits protocol scenarios: ${missingScenarios.map((scenario) => scenario.id).join(", ")}; include each with null metrics if it was not measurable`);
  }
  return {
    captureId: capture.captureId,
    product: capture.product,
    capturedAt: capture.capturedAt,
    productSurface: capture.productSurface,
    visibleModelSetting: capture.visibleModelSetting,
    transcriptFile: basename(transcriptPath),
    transcriptSha256,
    transcriptBytes: transcriptBytes.byteLength,
    transcriptHandling: capture.transcript.handling,
    transcriptRedactions: capture.transcript.redactions,
    protocolId: protocol.protocolId,
    protocolVersion: protocol.protocolVersion,
    protocolSha256,
    protocolScenarios: protocol.scenarios,
    scores: capture.scores,
    attestedBy: capture.attestation.attestedBy,
    notes: capture.notes
  };
}

export function aggregateCompetitorCaptures(
  captures: ValidatedCompetitorCapture[],
  generatedAt = new Date().toISOString()
): CompetitorComparisonResult {
  if (captures.length === 0) throw new Error("At least one completed manual capture is required");
  if (new Set(captures.map((capture) => capture.captureId)).size !== captures.length) throw new Error("Competitor capture IDs must be unique");
  if (new Set(captures.map((capture) => capture.transcriptSha256)).size !== captures.length) throw new Error("A frozen competitor transcript may be aggregated only once");
  const protocolHashes = new Set(captures.map((capture) => capture.protocolSha256));
  if (protocolHashes.size !== 1) throw new Error("Competitor captures must use the exact same hashed protocol");
  const aggregates = (["ChatGPT", "Codex"] as const).flatMap((product) => {
    const productCaptures = captures.filter((capture) => capture.product === product);
    if (productCaptures.length === 0) return [];
    const scores = productCaptures.flatMap((capture) => capture.scores);
    const metrics = Object.fromEntries(METRICS.map((metric) => {
      const values = scores.map((score) => score.metrics[metric]).filter((value): value is number => value !== null);
      return [metric, { mean: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null, measured: values.length }];
    })) as Record<CompetitorMetric, { mean: number | null; measured: number }>;
    const measuredScenarios = scores.filter((score) => METRICS.some((metric) => score.metrics[metric] !== null)).length;
    return [{ product, captures: productCaptures.length, scoredScenarios: measuredScenarios, metrics }];
  });
  const core = {
    schemaVersion: 1 as const,
    evidenceClass: "manual-black-box-product-comparison" as const,
    generatedAt,
    captures,
    aggregates,
    caveats: [
      "Captures describe visible product behavior only; internal prompts, compaction, retrieval, model routing, and token accounting are uncontrolled and unobserved.",
      "Scores and rationales are human supplied. This runner validates, hashes, and aggregates them but does not invent, infer, or LLM-grade missing results.",
      "A comparison is descriptive, not causal, even when the visible model setting and prompt protocol match."
    ]
  };
  return { ...core, resultHash: createHash("sha256").update(JSON.stringify(core)).digest("hex") };
}

export function competitorComparisonMarkdown(result: CompetitorComparisonResult): string {
  const escapeMarkdown = (value: unknown): string => String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")
    .replace(/[|[\]()*_~#]/g, "\\$&")
    .replace(/`/g, "&#96;")
    .replace(/[\r\n]+/g, " ");
  const percent = (value: number | null): string => value === null ? "not scored" : `${(value * 100).toFixed(1)}%`;
  const aggregateRows = result.aggregates.map((aggregate) =>
    `| ${escapeMarkdown(aggregate.product)} | ${aggregate.captures} | ${aggregate.scoredScenarios} | ${percent(aggregate.metrics.answerAccuracy.mean)} (${aggregate.metrics.answerAccuracy.measured}) | ${percent(aggregate.metrics.memoryRecall.mean)} (${aggregate.metrics.memoryRecall.measured}) | ${percent(aggregate.metrics.temporalCorrectness.mean)} (${aggregate.metrics.temporalCorrectness.measured}) | ${percent(aggregate.metrics.unsupportedMemoryResistance.mean)} (${aggregate.metrics.unsupportedMemoryResistance.measured}) |`
  );
  return `# Manual black-box product comparison

Generated: ${escapeMarkdown(result.generatedAt)}<br>
Evidence class: ${result.evidenceClass}<br>
Result hash: \`${result.resultHash}\`

No product interaction was automated by this runner. It processed only manually supplied transcript files, capture metadata, attestations, and human scores.

| Product | Captures | Scenarios | Answer accuracy (n) | Memory recall (n) | Temporal (n) | Unsupported-memory resistance (n) |
|---|---:|---:|---:|---:|---:|---:|
${aggregateRows.join("\n")}

## Capture provenance

${result.captures.map((capture) => `- ${escapeMarkdown(capture.captureId)}: ${escapeMarkdown(capture.product)}, ${escapeMarkdown(capture.productSurface)}, visible setting ${escapeMarkdown(capture.visibleModelSetting)}, captured ${escapeMarkdown(capture.capturedAt)}; transcript \`${escapeMarkdown(capture.transcriptFile)}\` SHA-256 \`${capture.transcriptSha256}\`; protocol ${escapeMarkdown(capture.protocolId)}/${escapeMarkdown(capture.protocolVersion)} SHA-256 \`${capture.protocolSha256}\`.`).join("\n")}

## Caveats

${result.caveats.map((caveat) => `- ${escapeMarkdown(caveat)}`).join("\n")}
`;
}
