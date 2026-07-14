import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Transform, type Readable } from "node:stream";
import { finished } from "node:stream/promises";

import type {
  EvaluationDataset,
  EvaluationMessage,
  EvaluationProbe,
  ProbeCategory
} from "./types.js";

export type PublicDatasetId = "longmemeval" | "halumem";
export type PublicDatasetFormat = "json-array" | "jsonl";

export interface PublicDatasetLicense {
  name: string;
  sourceUrl: string;
  redistributable: boolean;
}

export interface PublicDatasetSourceVariant {
  key: string;
  fileName: string;
  sourceUrl: string;
  upstreamRevision: string;
  sha256: string;
  format: PublicDatasetFormat;
  sizeBytesApproximate: number;
}

export interface PublicDatasetDescriptor {
  id: PublicDatasetId;
  displayName: "LongMemEval" | "HaluMem";
  license: PublicDatasetLicense & {
    spdx: "MIT" | "CC-BY-NC-ND-4.0";
    adaptedRedistributionAllowed: boolean;
    commercialUseAllowed: boolean;
  };
  primaryRepositoryUrl: string;
  datasetCardUrl: string;
  schemaDocumentationUrl: string;
  variants: readonly PublicDatasetSourceVariant[];
}

export interface VerifiedPublicDatasetSource {
  descriptor: PublicDatasetDescriptor;
  variant: PublicDatasetSourceVariant;
  inputPath: string;
  byteLength: number;
  sha256: string;
  verifiedAt: string;
}

export interface VerifiedPublicDatasetImportManifest {
  manifest: Record<string, unknown>;
  descriptor: PublicDatasetDescriptor;
  variant: PublicDatasetSourceVariant;
  outputSha256: string;
}

export interface PublicDatasetAdapterContext {
  sourceUrl: string;
  sourceSha256: string;
  sourceVariant: string;
  licenseSpdx: string;
  verifiedAgainstRegistry: boolean;
}

export interface PublicDatasetAdapter {
  readonly id: PublicDatasetId;
  readonly format: PublicDatasetFormat;
  adaptRecord(
    record: unknown,
    recordIndex: number,
    context: PublicDatasetAdapterContext
  ): EvaluationDataset;
}

/**
 * Hashes and revision labels below were read from the publishers' own Hugging Face
 * file pages on 2026-07-13. The import command refuses bytes that do not match.
 * Updating an upstream revision therefore requires an explicit registry change.
 */
export const PUBLIC_DATASET_REGISTRY: Readonly<Record<PublicDatasetId, PublicDatasetDescriptor>> = {
  longmemeval: {
    id: "longmemeval",
    displayName: "LongMemEval",
    license: {
      name: "MIT License",
      spdx: "MIT",
      sourceUrl: "https://github.com/xiaowu0162/LongMemEval/blob/main/LICENSE",
      redistributable: true,
      adaptedRedistributionAllowed: true,
      commercialUseAllowed: true
    },
    primaryRepositoryUrl: "https://github.com/xiaowu0162/LongMemEval",
    datasetCardUrl: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned",
    schemaDocumentationUrl: "https://github.com/xiaowu0162/LongMemEval#-dataset-format",
    variants: [
      {
        key: "s-cleaned",
        fileName: "longmemeval_s_cleaned.json",
        sourceUrl: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416/longmemeval_s_cleaned.json",
        upstreamRevision: "98d7416",
        sha256: "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442",
        format: "json-array",
        sizeBytesApproximate: 277_000_000
      },
      {
        key: "oracle",
        fileName: "longmemeval_oracle.json",
        sourceUrl: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416/longmemeval_oracle.json",
        upstreamRevision: "98d7416",
        sha256: "821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c",
        format: "json-array",
        sizeBytesApproximate: 15_400_000
      },
      {
        key: "m-cleaned",
        fileName: "longmemeval_m_cleaned.json",
        sourceUrl: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/98d7416/longmemeval_m_cleaned.json",
        upstreamRevision: "98d7416",
        sha256: "9d79e5524794a2e6900a3aa9cb7d9152c5a3e8319c9a87c25494ba1eacee495f",
        format: "json-array",
        sizeBytesApproximate: 2_740_000_000
      }
    ]
  },
  halumem: {
    id: "halumem",
    displayName: "HaluMem",
    license: {
      name: "Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International",
      spdx: "CC-BY-NC-ND-4.0",
      sourceUrl: "https://spdx.org/licenses/CC-BY-NC-ND-4.0.html",
      redistributable: false,
      adaptedRedistributionAllowed: false,
      commercialUseAllowed: false
    },
    primaryRepositoryUrl: "https://github.com/MemTensor/HaluMem",
    datasetCardUrl: "https://huggingface.co/datasets/IAAR-Shanghai/HaluMem",
    schemaDocumentationUrl: "https://huggingface.co/datasets/IAAR-Shanghai/HaluMem#dataset-structure",
    variants: [
      {
        key: "medium",
        fileName: "HaluMem-Medium.jsonl",
        sourceUrl: "https://huggingface.co/datasets/IAAR-Shanghai/HaluMem/resolve/6c4dbab/HaluMem-Medium.jsonl",
        upstreamRevision: "6c4dbab",
        sha256: "486fbc130a5c8781a2af27ffa508a1d7855245137aa449c193ac4d29c45634e7",
        format: "jsonl",
        sizeBytesApproximate: 33_500_000
      },
      {
        key: "long",
        fileName: "HaluMem-Long.jsonl",
        sourceUrl: "https://huggingface.co/datasets/IAAR-Shanghai/HaluMem/resolve/6c4dbab/HaluMem-Long.jsonl",
        upstreamRevision: "6c4dbab",
        sha256: "dfdbed570b402b7b8c17e0d7808fc6f3ae7a53b6144f18feb16bbdd3f55cb0c9",
        format: "jsonl",
        sizeBytesApproximate: 107_000_000
      }
    ]
  }
};

function object(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, description: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${description} must be an array`);
  return value;
}

function optionalArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, description: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${description} must be a non-empty string`);
  }
  return value;
}

function answerStrings(value: unknown, description: string): string[] {
  if (Array.isArray(value)) {
    const answers = value.map(String).filter((item) => item.trim().length > 0);
    if (answers.length === 0) throw new Error(`${description} cannot be empty`);
    return answers;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  throw new Error(`${description} must be a scalar or array of scalars`);
}

function safeId(value: string): string {
  return value.normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "record";
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isoTimestamp(value: unknown, sequence: number): string {
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.valueOf())) return parsed.toISOString();
  }
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0, sequence)).toISOString();
}

function longMemEvalCategory(questionType: string, abstention: boolean): ProbeCategory {
  if (abstention) return "absent_evidence";
  if (/preference/i.test(questionType)) return "preference";
  if (/assistant/i.test(questionType)) return "assistant_conclusion";
  if (/temporal/i.test(questionType)) return "temporal_ordering";
  if (/knowledge-update/i.test(questionType)) return "decision_supersession";
  if (/multi-session/i.test(questionType)) return "multi_hop";
  return "single_fact";
}

function haluMemCategory(questionType: string): ProbeCategory {
  if (/update|change|latest|current/i.test(questionType)) return "decision_supersession";
  if (/temporal|chronolog|time/i.test(questionType)) return "temporal_ordering";
  if (/multi|reason|generalization|application|relationship/i.test(questionType)) return "multi_hop";
  if (/preference/i.test(questionType)) return "preference";
  return "single_fact";
}

function datasetProvenance(name: string, context: PublicDatasetAdapterContext): string {
  return `${name}; source=${context.sourceUrl}; sha256=${context.sourceSha256}; license=${context.licenseSpdx}; verified=${String(context.verifiedAgainstRegistry)}`;
}

export const LONGMEMEVAL_ADAPTER: PublicDatasetAdapter = {
  id: "longmemeval",
  format: "json-array",
  adaptRecord(record, recordIndex, context) {
    const value = object(record, `LongMemEval record ${recordIndex}`);
    const upstreamId = text(value.question_id ?? value.id ?? `case-${recordIndex + 1}`, "LongMemEval question_id");
    const caseId = safeId(upstreamId);
    const sessions = array(value.haystack_sessions ?? value.sessions, `LongMemEval ${upstreamId} haystack_sessions`);
    const sessionIds = optionalArray(value.haystack_session_ids).map(String);
    const sessionDates = optionalArray(value.haystack_dates);
    const answerSessionIds = new Set(optionalArray(value.answer_session_ids).map(String));
    const messages: EvaluationMessage[] = [];
    const evidenceBySession = new Map<string, string[]>();
    const turnEvidenceIds: string[] = [];
    let sequence = 1;
    sessions.forEach((sessionValue, sessionIndex) => {
      const turns = array(sessionValue, `LongMemEval ${upstreamId} session ${sessionIndex}`);
      const sourceSessionId = sessionIds[sessionIndex] ?? `session-${sessionIndex + 1}`;
      const localIds: string[] = [];
      turns.forEach((turnValue, turnIndex) => {
        const turn = object(turnValue, `LongMemEval ${upstreamId} turn ${turnIndex}`);
        const content = text(turn.content ?? turn.text, `LongMemEval ${upstreamId} turn content`);
        const id = `longmemeval-${caseId}-s${sessionIndex + 1}-t${turnIndex + 1}`;
        messages.push({
          id,
          sequence,
          role: turn.role === "assistant" ? "assistant" : "user",
          content,
          tokenCount: Math.max(1, Math.ceil(content.length / 4)),
          topic: typeof value.question_type === "string" ? value.question_type : "public-dataset",
          createdAt: isoTimestamp(turn.timestamp ?? sessionDates[sessionIndex], sequence)
        });
        localIds.push(id);
        if (turn.has_answer === true) turnEvidenceIds.push(id);
        sequence += 1;
      });
      evidenceBySession.set(sourceSessionId, localIds);
    });
    const answerEvidenceIds = [...answerSessionIds].flatMap((id) => evidenceBySession.get(id) ?? []);
    const expectedEvidenceIds = answerEvidenceIds.length > 0
      ? answerEvidenceIds
      : turnEvidenceIds.length > 0
        ? turnEvidenceIds
        : messages.map((message) => message.id);
    const questionType = typeof value.question_type === "string" ? value.question_type : "single-session-user";
    const abstention = /_abs$/i.test(upstreamId) || /abstention/i.test(questionType);
    const question = text(value.question ?? value.query, `LongMemEval ${upstreamId} question`);
    const acceptableAnswers = answerStrings(value.answer ?? value.expected_answer, `LongMemEval ${upstreamId} answer`);
    const probe: EvaluationProbe = {
      id: `longmemeval-${caseId}`,
      checkpoint: messages.length,
      category: longMemEvalCategory(questionType, abstention),
      question,
      acceptableAnswers,
      expectedEvidenceIds: abstention ? [] : expectedEvidenceIds,
      expectedCurrentValue: /knowledge-update/i.test(questionType) ? acceptableAnswers[0] ?? null : null,
      shouldRefuseForMissingEvidence: abstention,
      deterministic: false,
      notes: `LongMemEval ${context.sourceVariant}; upstream question_id=${upstreamId}.`
    };
    const recordHash = sha256Json(record);
    return {
      id: `longmemeval-${caseId}-${recordHash.slice(0, 12)}`,
      name: "LongMemEval",
      version: `adapter-2.0.0/${context.sourceVariant}`,
      seed: 0,
      generatorHash: recordHash,
      checkpoints: [messages.length],
      messages,
      probes: [probe],
      license: context.licenseSpdx,
      provenance: datasetProvenance("LongMemEval", context)
    };
  }
};

export const HALUMEM_ADAPTER: PublicDatasetAdapter = {
  id: "halumem",
  format: "jsonl",
  adaptRecord(record, recordIndex, context) {
    const value = object(record, `HaluMem user ${recordIndex}`);
    const upstreamId = text(value.uuid ?? value.id ?? `user-${recordIndex + 1}`, "HaluMem uuid");
    const userId = safeId(upstreamId);
    const sessions = array(value.sessions, `HaluMem ${upstreamId} sessions`);
    const messages: EvaluationMessage[] = [];
    const probes: EvaluationProbe[] = [];
    const evidenceMemoryToMessageIds = new Map<string, string[]>();
    let sequence = 1;
    sessions.forEach((sessionValue, sessionIndex) => {
      const session = object(sessionValue, `HaluMem ${upstreamId} session ${sessionIndex}`);
      const dialogue = array(session.dialogue, `HaluMem ${upstreamId} session ${sessionIndex} dialogue`);
      const localMessageIds: string[] = [];
      dialogue.forEach((turnValue, turnIndex) => {
        const turn = object(turnValue, `HaluMem ${upstreamId} dialogue turn ${turnIndex}`);
        const content = text(turn.content ?? turn.text, `HaluMem ${upstreamId} dialogue content`);
        const id = `halumem-${userId}-s${sessionIndex + 1}-t${turnIndex + 1}`;
        messages.push({
          id,
          sequence,
          role: turn.role === "assistant" ? "assistant" : "user",
          content,
          tokenCount: Math.max(1, Math.ceil(content.length / 4)),
          topic: "halumem-dialogue",
          createdAt: isoTimestamp(turn.timestamp ?? session.start_time, sequence)
        });
        localMessageIds.push(id);
        sequence += 1;
      });
      for (const memoryValue of optionalArray(session.memory_points)) {
        const memory = object(memoryValue, `HaluMem ${upstreamId} memory point`);
        if (typeof memory.memory_content === "string") {
          evidenceMemoryToMessageIds.set(memory.memory_content.trim(), localMessageIds);
        }
      }
      optionalArray(session.questions).forEach((questionValue, questionIndex) => {
        const questionRecord = object(questionValue, `HaluMem ${upstreamId} question ${questionIndex}`);
        const question = text(questionRecord.question ?? questionRecord.query, `HaluMem ${upstreamId} question text`);
        const acceptableAnswers = answerStrings(questionRecord.answer ?? questionRecord.expected_answer, `HaluMem ${upstreamId} answer`);
        const upstreamEvidence = optionalArray(questionRecord.evidence);
        const mappedEvidence = upstreamEvidence.flatMap((evidenceValue) => {
          if (typeof evidenceValue === "string") return evidenceMemoryToMessageIds.get(evidenceValue.trim()) ?? [];
          const evidence = object(evidenceValue, `HaluMem ${upstreamId} question evidence`);
          return typeof evidence.memory_content === "string"
            ? evidenceMemoryToMessageIds.get(evidence.memory_content.trim()) ?? []
            : [];
        });
        const expectedEvidenceIds = [...new Set(mappedEvidence.length > 0 ? mappedEvidence : localMessageIds)];
        const questionType = typeof questionRecord.question_type === "string" ? questionRecord.question_type : "memory-qa";
        probes.push({
          id: `halumem-${userId}-s${sessionIndex + 1}-q${questionIndex + 1}`,
          checkpoint: messages.length,
          category: haluMemCategory(questionType),
          question,
          acceptableAnswers,
          expectedEvidenceIds,
          expectedCurrentValue: /update|latest|current/i.test(questionType) ? acceptableAnswers[0] ?? null : null,
          shouldRefuseForMissingEvidence: false,
          deterministic: false,
          notes: `HaluMem ${context.sourceVariant}; upstream user=${upstreamId}; difficulty=${String(questionRecord.difficulty ?? "not supplied")}.`
        });
      });
    });
    if (probes.length === 0) throw new Error(`HaluMem ${upstreamId} contains no questions`);
    const recordHash = sha256Json(record);
    return {
      id: `halumem-${userId}-${recordHash.slice(0, 12)}`,
      name: "HaluMem",
      version: `adapter-2.0.0/${context.sourceVariant}`,
      seed: 0,
      generatorHash: recordHash,
      checkpoints: [...new Set(probes.map((probe) => probe.checkpoint))],
      messages,
      probes,
      license: context.licenseSpdx,
      provenance: datasetProvenance("HaluMem", context)
    };
  }
};

export function publicDatasetAdapter(id: PublicDatasetId): PublicDatasetAdapter {
  return id === "longmemeval" ? LONGMEMEVAL_ADAPTER : HALUMEM_ADAPTER;
}

export async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

function requireRecord(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${description} must be an object`);
  return value as Record<string, unknown>;
}

function requireInteger(value: unknown, description: string, minimum = 0): number {
  if (!Number.isInteger(value) || Number(value) < minimum) throw new Error(`${description} must be an integer of at least ${minimum}`);
  return Number(value);
}

function requireExact(value: unknown, expected: unknown, description: string): void {
  if (value !== expected) throw new Error(`${description} does not match the registry-pinned value`);
}

export function expectedPublicDatasetProvenance(
  descriptor: PublicDatasetDescriptor,
  variant: PublicDatasetSourceVariant
): string {
  return `${descriptor.displayName}; source=${variant.sourceUrl}; sha256=${variant.sha256}; license=${descriptor.license.spdx}; verified=true`;
}

/**
 * Verifies both the normalized output bytes and every upstream field that is
 * supposed to be pinned by code. A boolean assertion in a mutable manifest is
 * never sufficient evidence of registry verification on its own.
 */
export async function verifyPublicDatasetImportManifest(
  inputPath: string,
  manifestPath: string
): Promise<VerifiedPublicDatasetImportManifest> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown; }
  catch (error) { throw new Error(`Could not read public-dataset import manifest: ${error instanceof Error ? error.message : String(error)}`); }
  const manifest = requireRecord(parsed, "Public-dataset import manifest");
  requireExact(manifest.schemaVersion, 1, "Import-manifest schemaVersion");
  requireExact(manifest.conversion, "continuum-public-dataset-adapter/2.0.0", "Import-manifest conversion");
  if (typeof manifest.generatedAt !== "string" || !Number.isFinite(new Date(manifest.generatedAt).valueOf())) throw new Error("Import-manifest generatedAt is invalid");
  const descriptor = Object.values(PUBLIC_DATASET_REGISTRY).find((candidate) => candidate.displayName === manifest.dataset);
  if (!descriptor) throw new Error("Import-manifest dataset is not present in the public-dataset registry");
  const variant = descriptor.variants.find((candidate) => candidate.key === manifest.variant);
  if (!variant) throw new Error("Import-manifest variant is not present in the public-dataset registry");
  const source = requireRecord(manifest.source, "Import-manifest source");
  requireExact(source.publisherUrl, variant.sourceUrl, "Import-manifest publisher URL");
  requireExact(source.upstreamRevision, variant.upstreamRevision, "Import-manifest upstream revision");
  requireExact(source.sha256, variant.sha256, "Import-manifest source SHA-256");
  requireExact(source.hashVerifiedAgainstRegistry, true, "Import-manifest registry verification");
  requireInteger(source.byteLength, "Import-manifest source byteLength", 1);
  const license = requireRecord(manifest.license, "Import-manifest license");
  requireExact(license.spdx, descriptor.license.spdx, "Import-manifest license SPDX identifier");
  requireExact(license.textUrl, descriptor.license.sourceUrl, "Import-manifest license URL");
  requireExact(license.acknowledgedByOperator, true, "Import-manifest license acknowledgement");
  requireExact(license.adaptedRedistributionAllowed, descriptor.license.adaptedRedistributionAllowed, "Import-manifest redistribution policy");
  requireExact(license.commercialUseAllowed, descriptor.license.commercialUseAllowed, "Import-manifest commercial-use policy");
  const output = requireRecord(manifest.output, "Import-manifest output");
  requireExact(output.file, "datasets.jsonl", "Import-manifest output filename");
  if (basename(resolve(inputPath)) !== output.file) throw new Error("Normalized dataset path does not match the import-manifest output filename");
  if (typeof output.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(output.sha256)) throw new Error("Import-manifest output SHA-256 is invalid");
  requireInteger(output.records, "Import-manifest output records", 1);
  requireInteger(output.messages, "Import-manifest output messages", 1);
  requireInteger(output.probes, "Import-manifest output probes", 1);
  if (typeof output.completeSource !== "boolean") throw new Error("Import-manifest completeSource must be boolean");
  const actual = await sha256File(inputPath);
  if (actual !== output.sha256) throw new Error("Normalized dataset hash does not match its import manifest");
  return { manifest, descriptor, variant, outputSha256: actual };
}

export async function validatePublicDatasetOutputPaths(input: {
  inputPath: string;
  outputDirectory: string;
  overwrite: boolean;
}): Promise<{ finalPath: string; manifestPath: string }> {
  const canonicalInput = await realpath(input.inputPath);
  const canonicalOutputDirectory = await realpath(input.outputDirectory);
  const finalPath = join(canonicalOutputDirectory, "datasets.jsonl");
  const manifestPath = join(canonicalOutputDirectory, "import-manifest.json");
  if (canonicalInput === finalPath || canonicalInput === manifestPath) {
    throw new Error("The public-dataset output would overwrite its input source");
  }
  const existingFinal = await realpath(finalPath).catch(() => null);
  const existingManifest = await realpath(manifestPath).catch(() => null);
  if (existingFinal === canonicalInput || existingManifest === canonicalInput) {
    throw new Error("The public-dataset output aliases its input source");
  }
  for (const path of [finalPath, manifestPath]) {
    const details = await lstat(path).catch(() => null);
    if (details?.isSymbolicLink() || (details && !details.isFile())) {
      throw new Error("Public-dataset output paths must be absent or regular files, never links or special files");
    }
  }
  if (!input.overwrite) {
    const occupied = await Promise.all([finalPath, manifestPath].map((path) => access(path).then(() => true, () => false)));
    if (occupied.some(Boolean)) throw new Error("Public-dataset output already exists; pass --overwrite to replace it explicitly");
  }
  return { finalPath, manifestPath };
}

export async function verifyPublicDatasetSource(input: {
  dataset: PublicDatasetId;
  variant: string;
  inputPath: string;
  acknowledgedLicense: string;
  now?: () => string;
}): Promise<VerifiedPublicDatasetSource> {
  const descriptor = PUBLIC_DATASET_REGISTRY[input.dataset];
  const variant = descriptor.variants.find((item) => item.key === input.variant);
  if (!variant) {
    throw new Error(`Unknown ${input.dataset} variant ${JSON.stringify(input.variant)}; choose ${descriptor.variants.map((item) => item.key).join(", ")}`);
  }
  if (input.acknowledgedLicense !== descriptor.license.spdx) {
    throw new Error(`Import requires --acknowledge-license ${descriptor.license.spdx}`);
  }
  const [actualHash, details] = await Promise.all([sha256File(input.inputPath), stat(input.inputPath)]);
  if (actualHash !== variant.sha256) {
    throw new Error(
      `Source hash mismatch for ${variant.fileName}: expected ${variant.sha256}, received ${actualHash}. ` +
      "The file is not the registry-pinned publisher artifact; do not use it for official results."
    );
  }
  return {
    descriptor,
    variant,
    inputPath: input.inputPath,
    byteLength: details.size,
    sha256: actualHash,
    verifiedAt: input.now?.() ?? new Date().toISOString()
  };
}

async function* jsonLines(stream: Readable): AsyncGenerator<unknown> {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`Invalid JSONL at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Streams a top-level JSON array one object at a time. This avoids loading the
 * multi-gigabyte LongMemEval-M file into a Node string or heap.
 */
async function* jsonArrayObjects(stream: Readable): AsyncGenerator<unknown> {
  let startedArray = false;
  let endedArray = false;
  let collecting = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let buffer = "";
  for await (const chunkValue of stream) {
    const chunk = String(chunkValue);
    for (const character of chunk) {
      if (!startedArray) {
        if (/\s/.test(character)) continue;
        if (character !== "[") throw new Error("Expected a top-level JSON array");
        startedArray = true;
        continue;
      }
      if (!collecting) {
        if (/\s|,/.test(character)) continue;
        if (character === "]") {
          endedArray = true;
          continue;
        }
        if (endedArray) throw new Error("Unexpected content after the top-level JSON array");
        if (character !== "{") throw new Error("Every top-level dataset entry must be an object");
        collecting = true;
        depth = 1;
        buffer = "{";
        continue;
      }
      buffer += character;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === "\"") inString = false;
        continue;
      }
      if (character === "\"") {
        inString = true;
      } else if (character === "{" || character === "[") {
        depth += 1;
      } else if (character === "}" || character === "]") {
        depth -= 1;
        if (depth === 0) {
          try {
            yield JSON.parse(buffer) as unknown;
          } catch (error) {
            throw new Error(`Invalid JSON array entry: ${error instanceof Error ? error.message : String(error)}`);
          }
          collecting = false;
          buffer = "";
        }
      }
    }
  }
  if (!startedArray || !endedArray || collecting || inString) throw new Error("Incomplete top-level JSON array");
}

function assertDatasetSourceUnchanged(expected: string, actual: string): void {
  if (actual !== expected) {
    throw new Error(`Public-dataset source changed after verification: expected ${expected}, received ${actual}`);
  }
}

export async function* readPublicDatasetRecords(source: VerifiedPublicDatasetSource): AsyncGenerator<unknown> {
  const digest = createHash("sha256");
  const raw = createReadStream(source.inputPath);
  const verifiedBytes = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      digest.update(chunk);
      callback(null, chunk);
    }
  });
  raw.on("error", (error) => verifiedBytes.destroy(error));
  raw.pipe(verifiedBytes);
  let parsingFailed = false;
  try {
    const records = source.variant.format === "jsonl" ? jsonLines(verifiedBytes) : jsonArrayObjects(verifiedBytes);
    yield* records;
  } catch (error) {
    parsingFailed = true;
    throw error;
  } finally {
    // If a caller stops adapting after a record limit, continue hashing the
    // unopened tail. No normalized output is finalized until this check passes.
    verifiedBytes.resume();
    try {
      if (parsingFailed) await finished(verifiedBytes).catch(() => undefined);
      else {
        await finished(verifiedBytes);
        assertDatasetSourceUnchanged(source.sha256, digest.digest("hex"));
      }
    } finally {
      raw.destroy();
    }
  }
}

export async function* adaptVerifiedPublicDataset(
  source: VerifiedPublicDatasetSource,
  options: { limitRecords?: number } = {}
): AsyncGenerator<EvaluationDataset> {
  const limit = options.limitRecords ?? Number.POSITIVE_INFINITY;
  if (!(Number.isInteger(limit) || limit === Number.POSITIVE_INFINITY) || limit <= 0) {
    throw new Error("limitRecords must be a positive integer when supplied");
  }
  const adapter = publicDatasetAdapter(source.descriptor.id);
  const context: PublicDatasetAdapterContext = {
    sourceUrl: source.variant.sourceUrl,
    sourceSha256: source.sha256,
    sourceVariant: source.variant.key,
    licenseSpdx: source.descriptor.license.spdx,
    verifiedAgainstRegistry: true
  };
  let recordIndex = 0;
  for await (const record of readPublicDatasetRecords(source)) {
    if (recordIndex < limit) yield adapter.adaptRecord(record, recordIndex, context);
    recordIndex += 1;
  }
}

function syntheticContext(name: "LongMemEval" | "HaluMem", license: PublicDatasetLicense): PublicDatasetAdapterContext {
  if (!license.name || !license.sourceUrl) throw new Error("Dataset license and source URL are required");
  return {
    sourceUrl: license.sourceUrl,
    sourceSha256: createHash("sha256").update(`${name}:${license.sourceUrl}`).digest("hex"),
    sourceVariant: "caller-supplied-unverified",
    licenseSpdx: license.name,
    verifiedAgainstRegistry: false
  };
}

/** Backward-compatible single-record helper. Official imports must use verifyPublicDatasetSource. */
export function adaptLongMemEval(input: unknown, license: PublicDatasetLicense): EvaluationDataset {
  const record = Array.isArray(input) ? input[0] : input;
  if (record === undefined) throw new Error("LongMemEval input contains no records");
  return LONGMEMEVAL_ADAPTER.adaptRecord(record, 0, syntheticContext("LongMemEval", license));
}

/** Backward-compatible single-user helper. Official imports must use verifyPublicDatasetSource. */
export function adaptHaluMem(input: unknown, license: PublicDatasetLicense): EvaluationDataset {
  const record = Array.isArray(input) ? input[0] : input;
  if (record === undefined) throw new Error("HaluMem input contains no records");
  return HALUMEM_ADAPTER.adaptRecord(record, 0, syntheticContext("HaluMem", license));
}
