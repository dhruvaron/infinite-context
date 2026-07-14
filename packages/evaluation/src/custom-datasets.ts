import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { CausalDatasetSourceEvidence } from "./causal-benchmark.js";
import { generateInfiniteBuild } from "./infinite-build.js";
import { sha256File } from "./public-datasets.js";
import type { EvaluationDataset } from "./types.js";

export interface CustomNormalizedDatasetManifest {
  schemaVersion: 1;
  evidenceClass: "custom-normalized-evaluation-dataset";
  generatedAt: string;
  generator: string;
  protocol: string;
  normalizedSha256: string;
  records: number;
  messages: number;
  probes: number;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Custom dataset manifest must be an object");
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`Custom dataset manifest ${field} is invalid`);
  return Number(value);
}

export async function verifyCustomNormalizedDatasetManifest(input: {
  normalizedPath: string;
  manifestPath: string;
}): Promise<{ manifest: CustomNormalizedDatasetManifest; manifestHash: string }> {
  const bytes = await readFile(input.manifestPath);
  if (bytes.length > 256_000) throw new Error("Custom dataset manifest is unexpectedly large");
  const value = record(JSON.parse(bytes.toString("utf8")) as unknown);
  const generatedAt = typeof value.generatedAt === "string" ? value.generatedAt : "";
  const generator = typeof value.generator === "string" ? value.generator.trim() : "";
  const protocol = typeof value.protocol === "string" ? value.protocol.trim() : "";
  const normalizedSha256 = typeof value.normalizedSha256 === "string" ? value.normalizedSha256 : "";
  if (value.schemaVersion !== 1 || value.evidenceClass !== "custom-normalized-evaluation-dataset"
    || !Number.isFinite(new Date(generatedAt).valueOf()) || !generator || !protocol
    || !/^[a-f0-9]{64}$/.test(normalizedSha256)) {
    throw new Error("Custom dataset manifest schema or integrity fields are invalid");
  }
  const manifest: CustomNormalizedDatasetManifest = {
    schemaVersion: 1,
    evidenceClass: "custom-normalized-evaluation-dataset",
    generatedAt,
    generator,
    protocol,
    normalizedSha256,
    records: positiveInteger(value.records, "records"),
    messages: positiveInteger(value.messages, "messages"),
    probes: positiveInteger(value.probes, "probes")
  };
  if (await sha256File(input.normalizedPath) !== manifest.normalizedSha256) {
    throw new Error("Custom normalized dataset does not match its manifest hash");
  }
  return {
    manifest,
    manifestHash: createHash("sha256").update(bytes).digest("hex")
  };
}

export function customNormalizedSourceEvidence(input: {
  manifest: CustomNormalizedDatasetManifest;
  manifestHash: string;
  parsedSha256: string;
  datasets: readonly EvaluationDataset[];
}): CausalDatasetSourceEvidence {
  const messages = input.datasets.reduce((sum, dataset) => sum + dataset.messages.length, 0);
  const probes = input.datasets.reduce((sum, dataset) => sum + dataset.probes.length, 0);
  if (input.parsedSha256 !== input.manifest.normalizedSha256
    || input.datasets.length !== input.manifest.records
    || messages !== input.manifest.messages || probes !== input.manifest.probes) {
    throw new Error("Custom normalized selection is incomplete or does not match its manifest counts");
  }
  return {
    id: `custom:${input.manifest.protocol}:${input.parsedSha256.slice(0, 12)}`,
    kind: "custom-normalized",
    datasetIds: input.datasets.map((dataset) => dataset.id),
    messages,
    probes,
    datasetHash: input.parsedSha256,
    generatorHash: null,
    manifestHash: input.manifestHash,
    registryVerified: false,
    completeSource: true,
    fullRecordAndProbeCoverage: true,
    reproducible: true,
    protocol: input.manifest.protocol,
    licenses: [...new Set(input.datasets.map((dataset) => dataset.license))].sort(),
    adaptedRedistributionAllowed: false
  };
}

/** Exact built-in 10k custom corpus used by the causal runner. */
export function infiniteBuild10kSource(): {
  dataset: EvaluationDataset;
  evidence: CausalDatasetSourceEvidence;
} {
  const dataset = generateInfiniteBuild({ messages: 10_000 });
  const datasetHash = createHash("sha256").update(JSON.stringify(dataset)).digest("hex");
  return {
    dataset,
    evidence: {
      id: `infinite-build:${dataset.generatorHash}`,
      kind: "infinite-build-10k",
      datasetIds: [dataset.id],
      messages: dataset.messages.length,
      probes: dataset.probes.length,
      datasetHash,
      generatorHash: dataset.generatorHash,
      manifestHash: null,
      registryVerified: false,
      completeSource: true,
      fullRecordAndProbeCoverage: true,
      reproducible: true,
      protocol: "infinite-build-v1",
      licenses: ["MIT"],
      adaptedRedistributionAllowed: true
    }
  };
}
