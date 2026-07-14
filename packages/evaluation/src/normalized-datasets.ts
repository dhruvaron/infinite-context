import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { Transform } from "node:stream";
import { finished } from "node:stream/promises";

import {
  expectedPublicDatasetProvenance,
  type VerifiedPublicDatasetImportManifest
} from "./public-datasets.js";
import type { EvaluationDataset, EvaluationMessage, EvaluationProbe, ProbeCategory } from "./types.js";

const PROBE_CATEGORIES = new Set<ProbeCategory>([
  "single_fact", "preference", "assistant_conclusion", "exact_quote", "topic_return",
  "temporal_ordering", "decision_supersession", "contradiction", "multi_hop",
  "absent_evidence", "interference"
]);

function record(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${description} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, description: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()) || value.length > 2_000_000) {
    throw new Error(`${description} must be ${allowEmpty ? "a" : "a non-empty"} bounded string`);
  }
  return value;
}

function timestamp(value: unknown, description: string): string {
  const parsed = text(value, description);
  if (!Number.isFinite(new Date(parsed).valueOf())) throw new Error(`${description} must be a valid timestamp`);
  return parsed;
}

function stringArray(value: unknown, description: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw new Error(`${description} must be an array`);
  const values = value.map((item, index) => text(item, `${description}[${index}]`));
  if (new Set(values).size !== values.length) throw new Error(`${description} cannot contain duplicates`);
  return values;
}

function messageRecord(value: unknown, index: number): EvaluationMessage {
  const item = record(value, `Normalized message ${index + 1}`);
  const sequence = Number(item.sequence);
  const tokenCount = Number(item.tokenCount);
  const content = text(item.content, `Normalized message ${index + 1} content`, true);
  if (!Number.isInteger(sequence) || sequence !== index + 1) throw new Error("Normalized message sequences must be consecutive and one-based");
  if (!Number.isInteger(tokenCount) || tokenCount !== Math.max(1, Math.ceil(content.length / 4))) {
    throw new Error("Normalized message tokenCount must match the frozen adapter's character-based estimate");
  }
  if (item.role !== "user" && item.role !== "assistant") throw new Error("Normalized message role is invalid");
  return {
    id: text(item.id, `Normalized message ${index + 1} id`),
    sequence,
    role: item.role,
    content,
    tokenCount,
    topic: text(item.topic, `Normalized message ${index + 1} topic`, true),
    createdAt: timestamp(item.createdAt, `Normalized message ${index + 1} createdAt`)
  };
}

function probeRecord(value: unknown, index: number, messages: readonly EvaluationMessage[]): EvaluationProbe {
  const item = record(value, `Normalized probe ${index + 1}`);
  const checkpoint = Number(item.checkpoint);
  if (!Number.isInteger(checkpoint) || checkpoint < 0 || checkpoint > messages.length) throw new Error("Normalized probe checkpoint is outside its message timeline");
  if (!PROBE_CATEGORIES.has(item.category as ProbeCategory)) throw new Error("Normalized probe category is invalid");
  if (typeof item.shouldRefuseForMissingEvidence !== "boolean" || typeof item.deterministic !== "boolean") {
    throw new Error("Normalized probe decision fields must be boolean");
  }
  const expectedEvidenceIds = stringArray(item.expectedEvidenceIds, `Normalized probe ${index + 1} expectedEvidenceIds`, true);
  const knownMessageIds = new Set(messages.slice(0, checkpoint).map((message) => message.id));
  if (expectedEvidenceIds.some((id) => !knownMessageIds.has(id))) {
    throw new Error("Normalized probe evidence must identify a message visible at its checkpoint");
  }
  const expectedCurrentValue = item.expectedCurrentValue === null
    ? null
    : text(item.expectedCurrentValue, `Normalized probe ${index + 1} expectedCurrentValue`, true);
  return {
    id: text(item.id, `Normalized probe ${index + 1} id`),
    checkpoint,
    category: item.category as ProbeCategory,
    question: text(item.question, `Normalized probe ${index + 1} question`),
    acceptableAnswers: stringArray(item.acceptableAnswers, `Normalized probe ${index + 1} acceptableAnswers`, false),
    expectedEvidenceIds,
    expectedCurrentValue,
    shouldRefuseForMissingEvidence: item.shouldRefuseForMissingEvidence,
    deterministic: item.deterministic,
    notes: text(item.notes, `Normalized probe ${index + 1} notes`, true)
  };
}

function datasetRecord(value: unknown, line: number): EvaluationDataset {
  const item = record(value, `Normalized dataset line ${line}`);
  if (!Array.isArray(item.messages) || !Array.isArray(item.probes)) throw new Error(`Normalized dataset line ${line} lacks messages/probes`);
  const messages = item.messages.map(messageRecord);
  const messageIds = messages.map((message) => message.id);
  if (new Set(messageIds).size !== messageIds.length) throw new Error(`Normalized dataset line ${line} contains duplicate message IDs`);
  const probes = item.probes.map((probe, index) => probeRecord(probe, index, messages));
  const probeIds = probes.map((probe) => probe.id);
  if (new Set(probeIds).size !== probeIds.length) throw new Error(`Normalized dataset line ${line} contains duplicate probe IDs`);
  const seed = Number(item.seed);
  if (!Number.isSafeInteger(seed)) throw new Error(`Normalized dataset line ${line} seed is invalid`);
  return {
    id: text(item.id, `Normalized dataset line ${line} id`),
    name: text(item.name, `Normalized dataset line ${line} name`),
    version: text(item.version, `Normalized dataset line ${line} version`),
    seed,
    generatorHash: text(item.generatorHash, `Normalized dataset line ${line} generatorHash`),
    checkpoints: [...new Set(probes.map((probe) => probe.checkpoint))],
    messages,
    probes,
    license: text(item.license, `Normalized dataset line ${line} license`),
    provenance: text(item.provenance, `Normalized dataset line ${line} provenance`)
  };
}

function manifestCount(
  verified: VerifiedPublicDatasetImportManifest | null,
  field: "records" | "probes"
): number | null {
  const output = verified?.manifest.output;
  if (typeof output !== "object" || output === null || Array.isArray(output)) return null;
  const value = (output as Record<string, unknown>)[field];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export async function readNormalizedEvaluationDatasets(input: {
  path: string;
  maxRecords: number;
  maxProbes: number;
  verifiedImport: VerifiedPublicDatasetImportManifest | null;
}): Promise<{
  datasets: EvaluationDataset[];
  parsedSha256: string;
  selectedRecords: number;
  selectedProbes: number;
  availableRecords: number | null;
  availableProbes: number | null;
  fullRecordAndProbeCoverage: boolean;
}> {
  if (!Number.isInteger(input.maxRecords) || input.maxRecords <= 0 || !Number.isInteger(input.maxProbes) || input.maxProbes <= 0) {
    throw new Error("Normalized dataset record and probe limits must be positive integers");
  }
  const digest = createHash("sha256");
  const raw = createReadStream(input.path);
  const hashed = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      digest.update(chunk);
      callback(null, chunk);
    }
  });
  raw.on("error", (error) => hashed.destroy(error));
  raw.pipe(hashed);
  const lines = createInterface({ input: hashed, crlfDelay: Infinity });
  const datasets: EvaluationDataset[] = [];
  const datasetIds = new Set<string>();
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim() || datasets.length >= input.maxRecords) continue;
      const parsed = datasetRecord(JSON.parse(line) as unknown, lineNumber);
      if (input.verifiedImport) {
        const expectedProvenance = expectedPublicDatasetProvenance(input.verifiedImport.descriptor, input.verifiedImport.variant);
        if (parsed.name !== input.verifiedImport.descriptor.displayName
          || parsed.license !== input.verifiedImport.descriptor.license.spdx
          || parsed.provenance !== expectedProvenance
          || parsed.version !== `adapter-2.0.0/${input.verifiedImport.variant.key}`) {
          throw new Error(`Normalized dataset line ${lineNumber} does not match its registry-verified manifest`);
        }
      }
      const probes = parsed.probes.slice(0, input.maxProbes);
      if (probes.length === 0) continue;
      if (datasetIds.has(parsed.id)) throw new Error(`Normalized dataset line ${lineNumber} duplicates dataset ID ${parsed.id}`);
      datasetIds.add(parsed.id);
      datasets.push({
        ...parsed,
        probes,
        checkpoints: [...new Set(probes.map((probe) => probe.checkpoint))]
      });
    }
    await finished(hashed);
  } finally {
    raw.destroy();
    hashed.destroy();
  }
  const parsedSha256 = digest.digest("hex");
  if (input.verifiedImport && parsedSha256 !== input.verifiedImport.outputSha256) {
    throw new Error("Normalized dataset changed after its import manifest was verified");
  }
  if (datasets.length === 0) throw new Error("The normalized input contains no selected evaluation datasets");
  const selectedProbes = datasets.reduce((sum, dataset) => sum + dataset.probes.length, 0);
  const availableRecords = manifestCount(input.verifiedImport, "records");
  const availableProbes = manifestCount(input.verifiedImport, "probes");
  return {
    datasets,
    parsedSha256,
    selectedRecords: datasets.length,
    selectedProbes,
    availableRecords,
    availableProbes,
    fullRecordAndProbeCoverage: availableRecords !== null && availableProbes !== null
      && datasets.length === availableRecords && selectedProbes === availableProbes
  };
}
