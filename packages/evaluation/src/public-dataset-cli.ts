import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { once } from "node:events";

import {
  adaptVerifiedPublicDataset,
  PUBLIC_DATASET_REGISTRY,
  validatePublicDatasetOutputPaths,
  verifyPublicDatasetSource,
  type PublicDatasetId
} from "./public-datasets.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function required(name: string): string {
  const value = argument(name);
  if (!value) throw new Error(`Missing required ${name}`);
  return value;
}

function datasetId(value: string): PublicDatasetId {
  if (value !== "longmemeval" && value !== "halumem") {
    throw new Error("--dataset must be longmemeval or halumem");
  }
  return value;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

async function writeChunk(stream: ReturnType<typeof createWriteStream>, value: string): Promise<void> {
  if (!stream.write(value)) await once(stream, "drain");
}

const dataset = datasetId(required("--dataset"));
const variant = required("--variant");
const inputPath = resolve(required("--input"));
const outputDirectory = resolve(required("--output"));
const acknowledgedLicense = required("--acknowledge-license");
const limitValue = argument("--limit-records");
const limitRecords = limitValue === undefined ? undefined : Number(limitValue);
if (limitRecords !== undefined && (!Number.isInteger(limitRecords) || limitRecords <= 0)) {
  throw new Error("--limit-records must be a positive integer");
}

await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const { finalPath, manifestPath } = await validatePublicDatasetOutputPaths({
  inputPath,
  outputDirectory,
  overwrite: flag("--overwrite")
});
const source = await verifyPublicDatasetSource({
  dataset,
  variant,
  inputPath,
  acknowledgedLicense
});
const canonicalOutputDirectory = dirname(finalPath);
const tempPath = resolve(canonicalOutputDirectory, `datasets.jsonl.tmp-${process.pid}`);
const stream = createWriteStream(tempPath, { encoding: "utf8", flags: "wx" });
const outputHash = createHash("sha256");
let records = 0;
let messages = 0;
let probes = 0;
try {
  for await (const adapted of adaptVerifiedPublicDataset(
    source,
    limitRecords === undefined ? {} : { limitRecords }
  )) {
    const line = `${JSON.stringify(adapted)}\n`;
    await writeChunk(stream, line);
    outputHash.update(line);
    records += 1;
    messages += adapted.messages.length;
    probes += adapted.probes.length;
  }
  stream.end();
  await once(stream, "close");
  if (records === 0) throw new Error("The verified source contained no adaptable records");
  await rename(tempPath, finalPath);
} catch (error) {
  stream.destroy();
  await rm(tempPath, { force: true });
  throw error;
}

const descriptor = PUBLIC_DATASET_REGISTRY[dataset];
const outputSha256 = outputHash.digest("hex");
const manifest = {
  schemaVersion: 1,
  conversion: "continuum-public-dataset-adapter/2.0.0",
  generatedAt: new Date().toISOString(),
  dataset: descriptor.displayName,
  variant: source.variant.key,
  source: {
    userSuppliedPathBasename: basename(source.inputPath),
    publisherUrl: source.variant.sourceUrl,
    upstreamRevision: source.variant.upstreamRevision,
    byteLength: source.byteLength,
    sha256: source.sha256,
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
    sha256: outputSha256,
    records,
    messages,
    probes,
    completeSource: limitRecords === undefined
  },
  warning: descriptor.license.adaptedRedistributionAllowed
    ? "Retain upstream attribution and license when sharing adapted output."
    : "Local noncommercial evaluation only. Do not redistribute this adapted output; review the upstream CC-BY-NC-ND-4.0 terms."
};
const manifestTempPath = resolve(canonicalOutputDirectory, `import-manifest.json.tmp-${process.pid}`);
try {
  await writeFile(manifestTempPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(manifestTempPath, manifestPath);
} catch (error) {
  await rm(manifestTempPath, { force: true });
  throw error;
}
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
