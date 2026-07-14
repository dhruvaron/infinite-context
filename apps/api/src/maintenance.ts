import { createHash } from "node:crypto";
import { closeSync, constants, createReadStream, createWriteStream, fsyncSync, openSync, unlinkSync, writeSync, type Stats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  unlink,
  writeFile
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { createInflateRaw } from "node:zlib";
import { createInterface } from "node:readline";
import JSZip, { type JSZipObject } from "jszip";
import { z } from "zod";
import { isKnownEmbeddingModel, isKnownResponseModel, stableHash, type AppConfig } from "@continuum/config";
import { ContinuumDatabase, uuidv7 } from "@continuum/database";
import { FileSystemContentAddressedStore } from "@continuum/ingestion";

/**
 * A full local load profile represents roughly 5 GiB of sparse logical data.
 * Keep the transport cap explicit and just above that profile while retaining
 * much smaller per-entry and per-attachment limits below.
 */
export const MAX_VAULT_BUNDLE_BYTES = 6 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = MAX_VAULT_BUNDLE_BYTES;
const MAX_EXPANDED_BYTES = 6 * 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_JSONL_SHARD_BYTES = 32 * 1024 * 1024;
const MAX_JSONL_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_ROWS_PER_TABLE = 250_000;
const MAX_TOTAL_ROWS = 1_000_000;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 100_000;
const MAX_CENTRAL_DIRECTORY_BYTES = 32 * 1024 * 1024;
const EXPORT_RETRY_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MAX_RETAINED_EXPORTS = 3;
const MAX_RETAINED_EXPORT_BYTES = 12 * 1024 * 1024 * 1024;
const MIN_EXPORT_FREE_SPACE_BYTES = 128 * 1024 * 1024;
const MIN_IMPORT_FREE_SPACE_BYTES = 256 * 1024 * 1024;
const MAX_ACTIVE_BACKUP_STAGING_AGE_MS = 24 * 60 * 60 * 1_000;
const BACKUP_STAGING_MARKER = ".continuum-owned-backup-staging.json";
const VERIFIED_IMPORT_TTL_MS = 60 * 60 * 1_000;
const MAX_VERIFIED_IMPORTS = 2;
const MAX_VERIFIED_IMPORT_BYTES = 12 * 1024 * 1024 * 1024;
const README_CONTENT = "Continuum portable vault export. Import this ZIP through Continuum; do not edit its contents unless you intend checksum verification to fail.\n";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PORTABLE_SETTING_KEYS = new Set([
  "onboarding.complete",
  "theme",
  "quality.default",
  "memory.enabled",
  "webSearch.enabled",
  "system.instructions",
  "ui.showSourceChips",
  "models.response",
  "models.extraction",
  "models.embedding"
]);

export class VaultBundleValidationError extends Error {
  constructor(cause: unknown) {
    super("The uploaded vault bundle is invalid or corrupted.", { cause });
    this.name = "VaultBundleValidationError";
  }
}

export class VaultExportStorageError extends Error {
  readonly requiredBytes: number;
  readonly availableBytes: number;
  constructor(requiredBytes: number, availableBytes: number) {
    super("There is not enough free disk space to create this vault export safely.");
    this.name = "VaultExportStorageError";
    this.requiredBytes = requiredBytes;
    this.availableBytes = availableBytes;
  }
}

export class VaultImportStorageError extends Error {
  readonly requiredBytes: number;
  readonly availableBytes: number;
  constructor(requiredBytes: number, availableBytes: number) {
    super("There is not enough free disk space to verify and import this vault safely.");
    this.name = "VaultImportStorageError";
    this.requiredBytes = requiredBytes;
    this.availableBytes = availableBytes;
  }
}

const RETRYABLE_IMPORT_IO_CODES = new Set(["EBUSY", "EDQUOT", "EIO", "EMFILE", "ENFILE", "ENOSPC", "EROFS", "ETIMEDOUT"]);

/** Returns the first filesystem error code in an error/cause chain. */
export function vaultImportIoErrorCode(error: unknown): string | null {
  let current: unknown = error;
  const visited = new Set<unknown>();
  for (let depth = 0; depth < 8 && current && !visited.has(current); depth += 1) {
    visited.add(current);
    if (typeof current === "object" && "code" in current && typeof current.code === "string") return current.code;
    current = current instanceof Error ? current.cause : null;
  }
  return null;
}

export function isRetryableVaultImportIoError(error: unknown): boolean {
  const code = vaultImportIoErrorCode(error);
  return code !== null && RETRYABLE_IMPORT_IO_CODES.has(code);
}

export function isVaultImportCapacityError(error: unknown): boolean {
  const code = vaultImportIoErrorCode(error);
  return code === "ENOSPC" || code === "EDQUOT";
}

type VaultVerificationTokenErrorCode = "INVALID" | "NOT_FOUND" | "EXPIRED" | "IN_USE";

export class VaultVerificationTokenError extends Error {
  readonly code: VaultVerificationTokenErrorCode;
  constructor(code: VaultVerificationTokenErrorCode, message: string) {
    super(message);
    this.name = "VaultVerificationTokenError";
    this.code = code;
  }
}
const ModelIdSchema = z.string().min(1).max(200);
const ResponseModelIdSchema = ModelIdSchema.refine(isKnownResponseModel, "Imported response model has no approved hard-budget pricing.");
const EmbeddingModelIdSchema = ModelIdSchema.refine(isKnownEmbeddingModel, "Imported embedding model has no approved hard-budget pricing.");
const PORTABLE_SETTING_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = {
  "onboarding.complete": z.boolean(),
  theme: z.enum(["light", "dark", "system"]),
  "quality.default": z.enum(["fast", "balanced", "deep"]),
  "memory.enabled": z.boolean(),
  "webSearch.enabled": z.boolean(),
  "system.instructions": z.string().max(20_000),
  "ui.showSourceChips": z.boolean(),
  "models.response": z.object({ fast: ResponseModelIdSchema, balanced: ResponseModelIdSchema, deep: ResponseModelIdSchema }).strict(),
  "models.extraction": ResponseModelIdSchema,
  "models.embedding": EmbeddingModelIdSchema
};

/**
 * Portable content only. In particular, an archive never carries an authorization,
 * an executable/leased job, an active response, a session replay record, or a
 * machine-local retrieval cache into another installation.
 */
const PORTABLE_TABLES = [
  "vaults",
  "settings",
  "prompt_versions",
  "provider_presets",
  "budget_ledger",
  "events",
  "event_content",
  "assistant_revisions",
  "context_refs",
  "sources",
  "attachments",
  "event_attachments",
  "source_chunks",
  "tool_executions",
  "entities",
  "entity_aliases",
  "claims",
  "claim_sources",
  "claim_relations",
  "edges",
  "merge_history",
  "topic_pages",
  "topic_page_revisions",
  "page_section_sources",
  "page_links",
  "memory_pins",
  "deletion_receipts"
] as const;

type PortableTable = typeof PORTABLE_TABLES[number];
type ImportMode = "verify" | "replace" | "fresh";

const FRESH_TABLES = new Set<PortableTable>([
  "vaults",
  "settings",
  "prompt_versions",
  "provider_presets",
  "events",
  "event_content",
  "assistant_revisions",
  "context_refs",
  "sources",
  "attachments",
  "event_attachments",
  "source_chunks",
  "tool_executions"
]);

/** All mutable vault tables, in parent-before-child schema order. */
const RESET_TABLES = [
  "vaults",
  "settings",
  "prompt_versions",
  "provider_presets",
  "budget_ledger",
  "events",
  "event_content",
  "assistant_revisions",
  "context_refs",
  "sources",
  "attachments",
  "event_attachments",
  "source_chunks",
  "workspace_roots",
  "tool_executions",
  "entities",
  "entity_aliases",
  "claims",
  "claim_sources",
  "claim_relations",
  "edges",
  "merge_history",
  "topic_pages",
  "topic_page_revisions",
  "page_section_sources",
  "page_links",
  "vectors",
  "jobs",
  "job_attempts",
  "runs",
  "run_stream_events",
  "model_calls",
  "retrieval_traces",
  "context_packets",
  "memory_pins",
  "idempotency_keys",
  "deletion_receipts",
  "budget_reservations",
  "deletion_operations"
] as const;

const HashSchema = z.string().regex(SHA256_PATTERN);
const BundleManifestSchema = z.object({
  format: z.literal("continuum-vault"),
  version: z.union([z.literal(1), z.literal(2)]),
  createdAt: z.string().datetime(),
  schemaVersion: z.number().int().positive(),
  includesAttachments: z.boolean(),
  sensitiveToolOutputIncluded: z.boolean(),
  expandedBytes: z.number().int().nonnegative().max(MAX_EXPANDED_BYTES),
  checksums: z.record(HashSchema),
  sizes: z.record(z.number().int().nonnegative().max(MAX_ENTRY_BYTES)),
  counts: z.record(z.number().int().nonnegative().max(MAX_ROWS_PER_TABLE)),
  tableShards: z.record(z.array(z.string()).max(10_000)).optional(),
  eventShards: z.array(z.string()).max(10_000).optional()
}).strict();

type BundleManifest = z.infer<typeof BundleManifestSchema>;
type StructuredData = Record<PortableTable, Array<Record<string, unknown>>>;
type VerifiedBundle = {
  manifest: BundleManifest;
  structured?: StructuredData;
  portableDatabase?: ContinuumDatabase;
  files: Map<string, Uint8Array | VerifiedFile>;
  archiveChecksum: string;
  cleanup?: () => Promise<void>;
};
type VerifiedFile = { path: string; size: number; checksum: string };
type ColumnInfo = { name: string; type: string; notnull: number };
type CentralEntry = { name: string; compressedSize: number; uncompressedSize: number; directory: boolean };
type FileCentralEntry = CentralEntry & {
  flags: number;
  compression: number;
  crc32: number;
  localHeaderOffset: number;
};
type ImportOperationRow = {
  id: string;
  mode: Exclude<ImportMode, "verify">;
  archive_checksum: string;
  archive_filename: string;
  phase: "prepared" | "database_complete" | "files_complete" | "complete" | "failed";
  payload_json: string;
};

const ImportJournalPayloadSchema = z.object({
  oldHashes: z.array(HashSchema).max(MAX_ROWS_PER_TABLE),
  newlyCreatedHashes: z.array(HashSchema).max(MAX_ROWS_PER_TABLE),
  retainedHashes: z.array(HashSchema).max(MAX_ROWS_PER_TABLE)
}).strict();

type ImportJournalPayload = z.infer<typeof ImportJournalPayloadSchema>;

const BackupStagingMarkerSchema = z.object({
  format: z.literal("continuum-backup-staging"),
  snapshotId: z.string().uuid(),
  ownerHash: HashSchema,
  instanceId: z.string().uuid(),
  processId: z.number().int().positive(),
  createdAt: z.string().datetime()
}).strict();

type BackupStagingMarker = z.infer<typeof BackupStagingMarkerSchema>;

const VerifiedImportMarkerSchema = z.object({
  format: z.literal("continuum-verified-import"),
  token: z.string().uuid(),
  ownerHash: HashSchema,
  sessionHash: HashSchema,
  archiveChecksum: HashSchema,
  size: z.number().int().positive().max(MAX_ARCHIVE_BYTES),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime()
}).strict();

type VerifiedImportMarker = z.infer<typeof VerifiedImportMarkerSchema>;

function safeExportName(filename: string): string {
  const clean = filename.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/-+/g, "-");
  if (!/^continuum-[a-zA-Z0-9._-]+\.zip$/.test(clean)) throw new Error("Invalid export filename.");
  return clean;
}

function safeImportArchiveName(filename: string): string {
  if (!/^continuum-import-[0-9a-f-]{36}\.zip$/.test(filename) || basename(filename) !== filename) throw new Error("Invalid import journal filename.");
  return filename;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    // Some filesystems cannot fsync a directory handle. Any other error means
    // the archive/marker transition cannot be represented as durable.
    if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(code)) throw error;
  } finally {
    await directory.close();
  }
}

type DirectorySync = (path: string) => Promise<void>;

async function writeDurableFile(path: string, bytes: Uint8Array, sync = syncDirectory): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlinkIfExists(path);
    throw error;
  }
  try { await handle.close(); }
  catch (error) { await unlinkIfExists(path); throw error; }
  await sync(dirname(path));
}

async function writeDurableStream(path: string, source: Readable, sync = syncDirectory): Promise<void> {
  try {
    await pipeline(source, createWriteStream(path, { flags: "wx", mode: 0o600 }));
    const handle = await open(path, "r+");
    try { await handle.sync(); }
    finally { await handle.close(); }
    await sync(dirname(path));
  } catch (error) {
    await unlinkIfExists(path);
    throw error;
  }
}

async function readdirIfExists(path: string): Promise<string[]> {
  try { return await readdir(path); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function pathExistsStrict(path: string): Promise<boolean> {
  try { await stat(path); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function requireImportFreeSpace(path: string, requiredBytes: number): Promise<void> {
  const disk = await statfs(path);
  const availableBytes = Number(disk.bavail) * Number(disk.bsize);
  if (!Number.isFinite(availableBytes) || availableBytes < requiredBytes) {
    throw new VaultImportStorageError(requiredBytes, availableBytes);
  }
}

function assertManifestVersionLayout(manifest: BundleManifest): void {
  if (manifest.version === 2) {
    if (!manifest.tableShards || !manifest.eventShards) throw new Error("A version-2 bundle must declare table and event shards.");
    manifest.eventShards.forEach((path, index) => {
      if (path !== `data/events/${String(index).padStart(6, "0")}.jsonl`) throw new Error("The bundle has non-canonical event shards.");
    });
    return;
  }
  if (manifest.tableShards !== undefined || manifest.eventShards !== undefined) throw new Error("A version-1 bundle may not declare streamed shards.");
}

function processIsAlive(processId: number): boolean {
  if (processId === process.pid) return true;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

async function copyDurableFile(source: string, destination: string, expectedSize: number, expectedChecksum: string): Promise<void> {
  await writeDurableStream(destination, createReadStream(source));
  try {
    const info = await stat(destination);
    if (info.size !== expectedSize || await hashFile(destination) !== expectedChecksum) {
      throw new Error("The durable import archive failed its post-write integrity check.");
    }
  } catch (error) {
    await unlinkIfExists(destination);
    throw error;
  }
}

async function unlinkIfExists(path: string): Promise<void> {
  try { await unlink(path); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
}

/**
 * A successful unlink is not a durable privacy boundary until its parent
 * directory is synced. Sync even after ENOENT so a retry can durably fence an
 * earlier unlink whose directory sync failed before the process restarted.
 */
async function unlinkDurablyIfExists(path: string, sync: DirectorySync): Promise<boolean> {
  let removed = false;
  try {
    await unlink(path);
    removed = true;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  await sync(dirname(path));
  return removed;
}

async function removeTreeDurably(path: string, sync: DirectorySync): Promise<void> {
  await rm(path, { recursive: true, force: true });
  await sync(dirname(path));
}

async function renameDurably(source: string, destination: string, sync: DirectorySync): Promise<void> {
  await rename(source, destination);
  const destinationParent = dirname(destination);
  const sourceParent = dirname(source);
  // Publish the destination before acknowledging removal from a different
  // directory. Same-directory renames need one directory barrier only.
  await sync(destinationParent);
  if (sourceParent !== destinationParent) await sync(sourceParent);
}

function portableBasename(filename: string): string {
  const value = filename.split(/[\\/]/).at(-1)?.split("").filter((character) => {
    const code = character.charCodeAt(0);
    return code > 31 && code !== 127;
  }).join("").trim().normalize("NFC") ?? "";
  return [...(!value || value === "." || value === ".." ? "attachment" : value)].slice(0, 255).join("");
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function assertSafeArchivePath(path: string): void {
  if (
    path.length === 0 || path.length > 512 || path.includes("\\") || path.includes("\0") ||
    path.startsWith("/") || path.startsWith("./") || path.endsWith("/") ||
    path.split("/").some((part) => part.length === 0 || part === "." || part === "..") ||
    hasControlCharacters(path) || path.normalize("NFC") !== path
  ) {
    throw new Error("The bundle contains an unsafe path.");
  }
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function assertExactKeys(actual: Iterable<string>, expected: Iterable<string>, label: string): void {
  const actualKeys = sorted(actual);
  const expectedKeys = sorted(expected);
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((value, index) => value !== expectedKeys[index])) {
    throw new Error(`The bundle ${label} does not exactly match the portable format.`);
  }
}

function readCentralDirectory(buffer: Buffer): CentralEntry[] {
  const minimumEocdSize = 22;
  const searchStart = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let offset = buffer.length - minimumEocdSize; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error("The import bundle is not a supported ZIP archive.");
  const archiveCommentLength = buffer.readUInt16LE(eocd + 20);
  if (eocd + minimumEocdSize + archiveCommentLength !== buffer.length) throw new Error("The ZIP archive has trailing or truncated data.");
  if (buffer.readUInt16LE(eocd + 4) !== 0 || buffer.readUInt16LE(eocd + 6) !== 0) throw new Error("Multi-disk ZIP archives are not supported.");
  const entriesOnDisk = buffer.readUInt16LE(eocd + 8);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported.");
  if (entriesOnDisk !== entryCount || entryCount === 0 || entryCount > MAX_ENTRIES) throw new Error("The bundle has an invalid number of entries.");
  if (centralOffset + centralSize > eocd || centralOffset < 0) throw new Error("The ZIP central directory is invalid.");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const names = new Set<string>();
  const entries: CentralEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocd || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error("The ZIP central directory is malformed.");
    const flags = buffer.readUInt16LE(cursor + 8);
    const compression = buffer.readUInt16LE(cursor + 10);
    if ((flags & 0x1) !== 0) throw new Error("Encrypted ZIP entries are not supported.");
    if (compression !== 0 && compression !== 8) throw new Error("The bundle uses an unsupported compression method.");
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (nameLength === 0 || next > eocd) throw new Error("The ZIP central directory is malformed.");
    const name = decoder.decode(buffer.subarray(cursor + 46, cursor + 46 + nameLength));
    const directory = name.endsWith("/");
    const canonicalName = directory ? name.slice(0, -1) : name;
    assertSafeArchivePath(canonicalName);
    if (names.has(name)) throw new Error(`The bundle contains a duplicate entry: ${name}.`);
    names.add(name);
    if (!directory && uncompressedSize > MAX_ENTRY_BYTES) throw new Error(`The bundle entry ${name} exceeds the expanded-size limit.`);
    entries.push({ name, compressedSize, uncompressedSize, directory });
    cursor = next;
  }
  if (cursor !== centralOffset + centralSize) throw new Error("The ZIP central directory has trailing or missing records.");
  return entries;
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[index] = value >>> 0;
  }
  return table;
})();

function updateCrc32(crc: number, bytes: Uint8Array): number {
  let value = crc;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return value >>> 0;
}

function safeZipNumber(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`The ZIP ${label} is outside the supported range.`);
  return Number(value);
}

async function readExactly(handle: Awaited<ReturnType<typeof open>>, position: number, length: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const result = await handle.read(bytes, offset, length - offset, position + offset);
    if (result.bytesRead === 0) throw new Error("The ZIP archive is truncated.");
    offset += result.bytesRead;
  }
  return bytes;
}

function zip64Values(extra: Buffer, needs: { uncompressed: boolean; compressed: boolean; offset: boolean }): Partial<Pick<FileCentralEntry, "uncompressedSize" | "compressedSize" | "localHeaderOffset">> {
  let cursor = 0;
  while (cursor + 4 <= extra.length) {
    const id = extra.readUInt16LE(cursor);
    const length = extra.readUInt16LE(cursor + 2);
    const end = cursor + 4 + length;
    if (end > extra.length) throw new Error("The ZIP central-directory extra data is malformed.");
    if (id === 0x0001) {
      let valueOffset = cursor + 4;
      const readValue = (label: string): number => {
        if (valueOffset + 8 > end) throw new Error("The ZIP64 central-directory data is incomplete.");
        const value = safeZipNumber(extra.readBigUInt64LE(valueOffset), label);
        valueOffset += 8;
        return value;
      };
      const result: Partial<Pick<FileCentralEntry, "uncompressedSize" | "compressedSize" | "localHeaderOffset">> = {};
      if (needs.uncompressed) result.uncompressedSize = readValue("entry size");
      if (needs.compressed) result.compressedSize = readValue("compressed entry size");
      if (needs.offset) result.localHeaderOffset = readValue("local-header offset");
      return result;
    }
    cursor = end;
  }
  if (needs.uncompressed || needs.compressed || needs.offset) throw new Error("The ZIP64 entry is missing its extended sizes.");
  return {};
}

async function readCentralDirectoryFile(path: string): Promise<{ entries: FileCentralEntry[]; centralOffset: number }> {
  const info = await stat(path);
  if (!info.isFile() || info.size === 0 || info.size > MAX_ARCHIVE_BYTES) throw new Error("The import bundle exceeds the 6 GiB compressed safety limit.");
  const handle = await open(path, "r");
  try {
    const tailLength = Math.min(info.size, 65_557 + 20);
    const tailOffset = info.size - tailLength;
    const tail = await readExactly(handle, tailOffset, tailLength);
    let eocdInTail = -1;
    for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) !== 0x06054b50) continue;
      const commentLength = tail.readUInt16LE(offset + 20);
      if (tailOffset + offset + 22 + commentLength === info.size) { eocdInTail = offset; break; }
    }
    if (eocdInTail < 0) throw new Error("The import bundle is not a supported ZIP archive.");
    const eocdOffset = tailOffset + eocdInTail;
    if (tail.readUInt16LE(eocdInTail + 4) !== 0 || tail.readUInt16LE(eocdInTail + 6) !== 0) throw new Error("Multi-disk ZIP archives are not supported.");
    let entryCount = tail.readUInt16LE(eocdInTail + 10);
    let centralSize = tail.readUInt32LE(eocdInTail + 12);
    let centralOffset = tail.readUInt32LE(eocdInTail + 16);
    if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      if (eocdOffset < 20) throw new Error("The ZIP64 locator is missing.");
      const locator = await readExactly(handle, eocdOffset - 20, 20);
      if (locator.readUInt32LE(0) !== 0x07064b50 || locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1) throw new Error("The ZIP64 locator is invalid.");
      const zip64Offset = safeZipNumber(locator.readBigUInt64LE(8), "central-directory offset");
      const zip64 = await readExactly(handle, zip64Offset, 56);
      if (zip64.readUInt32LE(0) !== 0x06064b50 || zip64.readUInt32LE(16) !== 0 || zip64.readUInt32LE(20) !== 0) throw new Error("The ZIP64 end record is invalid.");
      const entriesOnDisk = safeZipNumber(zip64.readBigUInt64LE(24), "entry count");
      entryCount = safeZipNumber(zip64.readBigUInt64LE(32), "entry count");
      if (entriesOnDisk !== entryCount) throw new Error("Multi-disk ZIP archives are not supported.");
      centralSize = safeZipNumber(zip64.readBigUInt64LE(40), "central-directory size");
      centralOffset = safeZipNumber(zip64.readBigUInt64LE(48), "central-directory offset");
    } else if (tail.readUInt16LE(eocdInTail + 8) !== entryCount) {
      throw new Error("Multi-disk ZIP archives are not supported.");
    }
    if (entryCount === 0 || entryCount > MAX_ENTRIES) throw new Error("The bundle has an invalid number of entries.");
    if (centralSize <= 0 || centralSize > MAX_CENTRAL_DIRECTORY_BYTES || centralOffset + centralSize > eocdOffset) throw new Error("The ZIP central directory is invalid.");

    const central = await readExactly(handle, centralOffset, centralSize);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const names = new Set<string>();
    const entries: FileCentralEntry[] = [];
    let cursor = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== 0x02014b50) throw new Error("The ZIP central directory is malformed.");
      const flags = central.readUInt16LE(cursor + 8);
      const compression = central.readUInt16LE(cursor + 10);
      if ((flags & 0x1) !== 0) throw new Error("Encrypted ZIP entries are not supported.");
      if ((flags & 0x8) !== 0) throw new Error("ZIP data descriptors are not supported in portable bundles.");
      if (compression !== 0 && compression !== 8) throw new Error("The bundle uses an unsupported compression method.");
      let compressedSize = central.readUInt32LE(cursor + 20);
      let uncompressedSize = central.readUInt32LE(cursor + 24);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      let localHeaderOffset = central.readUInt32LE(cursor + 42);
      const next = cursor + 46 + nameLength + extraLength + commentLength;
      if (nameLength === 0 || next > central.length) throw new Error("The ZIP central directory is malformed.");
      const name = decoder.decode(central.subarray(cursor + 46, cursor + 46 + nameLength));
      const directory = name.endsWith("/");
      const canonicalName = directory ? name.slice(0, -1) : name;
      assertSafeArchivePath(canonicalName);
      if (names.has(name)) throw new Error(`The bundle contains a duplicate entry: ${name}.`);
      names.add(name);
      const extended = zip64Values(central.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength), {
        uncompressed: uncompressedSize === 0xffffffff,
        compressed: compressedSize === 0xffffffff,
        offset: localHeaderOffset === 0xffffffff
      });
      compressedSize = extended.compressedSize ?? compressedSize;
      uncompressedSize = extended.uncompressedSize ?? uncompressedSize;
      localHeaderOffset = extended.localHeaderOffset ?? localHeaderOffset;
      if (!directory && uncompressedSize > MAX_ENTRY_BYTES) throw new Error(`The bundle entry ${name} exceeds the expanded-size limit.`);
      if (compressedSize < 0 || localHeaderOffset < 0 || localHeaderOffset >= centralOffset) throw new Error("The ZIP entry location is invalid.");
      entries.push({ name, compressedSize, uncompressedSize, directory, flags, compression, crc32: central.readUInt32LE(cursor + 16), localHeaderOffset });
      cursor = next;
    }
    if (cursor !== central.length) throw new Error("The ZIP central directory has trailing or missing records.");
    return { entries, centralOffset };
  } finally {
    await handle.close();
  }
}

async function extractZipEntry(archivePath: string, entry: FileCentralEntry, centralOffset: number, destination: string): Promise<VerifiedFile> {
  const handle = await open(archivePath, "r");
  let dataStart: number;
  try {
    const local = await readExactly(handle, entry.localHeaderOffset, 30);
    if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== entry.flags || local.readUInt16LE(8) !== entry.compression) throw new Error(`The ZIP local header for ${entry.name} is inconsistent.`);
    if (
      local.readUInt32LE(14) !== entry.crc32 ||
      local.readUInt32LE(18) !== entry.compressedSize ||
      local.readUInt32LE(22) !== entry.uncompressedSize
    ) throw new Error(`The ZIP local sizes or checksum for ${entry.name} are inconsistent.`);
    const nameLength = local.readUInt16LE(26);
    const extraLength = local.readUInt16LE(28);
    const nameBytes = await readExactly(handle, entry.localHeaderOffset + 30, nameLength);
    const name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
    if (name !== entry.name) throw new Error("The ZIP local and central filenames differ.");
    dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
    if (dataStart + entry.compressedSize > centralOffset) throw new Error(`The ZIP data for ${entry.name} overlaps its central directory.`);
  } finally {
    await handle.close();
  }

  let size = 0;
  let crc = 0xffffffff;
  const hash = createHash("sha256");
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.byteLength;
      if (size > entry.uncompressedSize || size > MAX_ENTRY_BYTES) { callback(new Error(`The ZIP entry ${entry.name} expanded beyond its declared limit.`)); return; }
      crc = updateCrc32(crc, chunk);
      hash.update(chunk);
      callback(null, chunk);
    }
  });
  try {
    if (entry.compressedSize === 0) {
      await writeFile(destination, new Uint8Array(), { flag: "wx", mode: 0o600 });
    } else {
      const source = createReadStream(archivePath, { start: dataStart, end: dataStart + entry.compressedSize - 1 });
      if (entry.compression === 8) await pipeline(source, createInflateRaw(), verifier, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
      else await pipeline(source, verifier, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
    }
    if (size !== entry.uncompressedSize || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) throw new Error(`The ZIP entry ${entry.name} failed its size or CRC check.`);
    return { path: destination, size, checksum: hash.digest("hex") };
  } catch (error) {
    await unlinkIfExists(destination);
    throw error;
  }
}

type StoredZipEntry = {
  name: string;
  size: number;
  checksum: string;
  crc32: number;
  content: Uint8Array | string | { sourcePath: string };
};

function crc32Bytes(bytes: Uint8Array | string): number {
  const value = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
  return (updateCrc32(0xffffffff, value) ^ 0xffffffff) >>> 0;
}

async function hashAndCrcFile(path: string, signal?: AbortSignal): Promise<{ checksum: string; crc32: number; size: number }> {
  const hash = createHash("sha256");
  let crc = 0xffffffff;
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    signal?.throwIfAborted();
    const bytes = chunk as Buffer;
    size += bytes.byteLength;
    hash.update(bytes);
    crc = updateCrc32(crc, bytes);
  }
  return { checksum: hash.digest("hex"), crc32: (crc ^ 0xffffffff) >>> 0, size };
}

function zipDateTime(reference = new Date()): { date: number; time: number } {
  const year = Math.max(1980, Math.min(2107, reference.getUTCFullYear()));
  return {
    date: ((year - 1980) << 9) | ((reference.getUTCMonth() + 1) << 5) | reference.getUTCDate(),
    time: (reference.getUTCHours() << 11) | (reference.getUTCMinutes() << 5) | Math.floor(reference.getUTCSeconds() / 2)
  };
}

/** A bounded ZIP/ZIP64 STORE writer whose payload is never assembled in RAM. */
function storedZipStream(entries: readonly StoredZipEntry[], signal?: AbortSignal): Readable {
  return Readable.from((async function* () {
    const centralRecords: Buffer[] = [];
    const timestamp = zipDateTime();
    let offset = 0;
    for (const entry of entries) {
      signal?.throwIfAborted();
      const name = Buffer.from(entry.name, "utf8");
      if (entry.size > 0xffffffff) throw new Error(`The ZIP entry ${entry.name} is too large.`);
      const localOffset = offset;
      const local = Buffer.alloc(30 + name.length);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt16LE(0, 8);
      local.writeUInt16LE(timestamp.time, 10);
      local.writeUInt16LE(timestamp.date, 12);
      local.writeUInt32LE(entry.crc32, 14);
      local.writeUInt32LE(entry.size, 18);
      local.writeUInt32LE(entry.size, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      name.copy(local, 30);
      yield local;
      offset += local.length;

      if (typeof entry.content === "string" || entry.content instanceof Uint8Array) {
        const bytes = typeof entry.content === "string" ? Buffer.from(entry.content) : entry.content;
        if (bytes.byteLength !== entry.size || stableHash(bytes) !== entry.checksum || crc32Bytes(bytes) !== entry.crc32) throw new Error(`The export entry ${entry.name} changed during serialization.`);
        yield bytes;
      } else {
        const hash = createHash("sha256");
        let crc = 0xffffffff;
        let size = 0;
        for await (const chunk of createReadStream(entry.content.sourcePath)) {
          signal?.throwIfAborted();
          const bytes = chunk as Buffer;
          size += bytes.byteLength;
          hash.update(bytes);
          crc = updateCrc32(crc, bytes);
          yield bytes;
        }
        if (size !== entry.size || hash.digest("hex") !== entry.checksum || ((crc ^ 0xffffffff) >>> 0) !== entry.crc32) throw new Error(`The export entry ${entry.name} changed during serialization.`);
      }
      offset += entry.size;

      const needsZip64Offset = localOffset >= 0xffffffff;
      const extra = needsZip64Offset ? Buffer.alloc(12) : Buffer.alloc(0);
      if (needsZip64Offset) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(8, 2);
        extra.writeBigUInt64LE(BigInt(localOffset), 4);
      }
      const central = Buffer.alloc(46 + name.length + extra.length);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(0x031e, 4);
      central.writeUInt16LE(needsZip64Offset ? 45 : 20, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(0, 10);
      central.writeUInt16LE(timestamp.time, 12);
      central.writeUInt16LE(timestamp.date, 14);
      central.writeUInt32LE(entry.crc32, 16);
      central.writeUInt32LE(entry.size, 20);
      central.writeUInt32LE(entry.size, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt16LE(extra.length, 30);
      central.writeUInt16LE(0, 32);
      central.writeUInt16LE(0, 34);
      central.writeUInt16LE(0, 36);
      central.writeUInt32LE((0o100600 << 16) >>> 0, 38);
      central.writeUInt32LE(needsZip64Offset ? 0xffffffff : localOffset, 42);
      name.copy(central, 46);
      extra.copy(central, 46 + name.length);
      centralRecords.push(central);
    }

    const centralOffset = offset;
    const centralSize = centralRecords.reduce((sum, record) => sum + record.length, 0);
    for (const record of centralRecords) yield record;
    offset += centralSize;
    const zip64 = centralOffset >= 0xffffffff || centralSize >= 0xffffffff || entries.length >= 0xffff;
    if (zip64) {
      const end = Buffer.alloc(56);
      end.writeUInt32LE(0x06064b50, 0);
      end.writeBigUInt64LE(44n, 4);
      end.writeUInt16LE(45, 12);
      end.writeUInt16LE(45, 14);
      end.writeUInt32LE(0, 16);
      end.writeUInt32LE(0, 20);
      end.writeBigUInt64LE(BigInt(entries.length), 24);
      end.writeBigUInt64LE(BigInt(entries.length), 32);
      end.writeBigUInt64LE(BigInt(centralSize), 40);
      end.writeBigUInt64LE(BigInt(centralOffset), 48);
      yield end;
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(BigInt(offset), 8);
      locator.writeUInt32LE(1, 16);
      yield locator;
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
    eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
    eocd.writeUInt32LE(zip64 ? 0xffffffff : centralSize, 12);
    eocd.writeUInt32LE(zip64 ? 0xffffffff : centralOffset, 16);
    eocd.writeUInt16LE(0, 20);
    yield eocd;
  })());
}

function boundedArchiveStream(source: Readable, onProgress?: (bytes: number) => void, signal?: AbortSignal): Readable {
  let bytes = 0;
  let lastReported = 0;
  return source.pipe(new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try { signal?.throwIfAborted(); }
      catch (error) { callback(error as Error); return; }
      bytes += chunk.byteLength;
      if (bytes > MAX_ARCHIVE_BYTES) { callback(new Error("The compressed export exceeds the 6 GiB transport safety limit.")); return; }
      if (onProgress && bytes - lastReported >= 8 * 1024 * 1024) {
        lastReported = bytes;
        onProgress(bytes);
      }
      callback(null, chunk);
    },
    flush(callback) {
      onProgress?.(bytes);
      callback();
    }
  }));
}

function redactPathsInText(value: string): string {
  return value
    .replace(/file:\/\/\/[^\s"'<>]+/gi, "[local path redacted]")
    .replace(/(?:\/Users|\/home|\/private|\/var|\/tmp|\/etc|\/opt|\/Volumes)\/[^\s"'<>]+/g, "[local path redacted]")
    .replace(/\b[a-zA-Z]:\\[^\r\n"'<>]+/g, "[local path redacted]")
    .replace(/\bsk-[a-zA-Z0-9_-]{20,}\b/g, "[secret redacted]")
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/-]{16,}={0,2}/gi, "Bearer [secret redacted]");
}

function isPathMetadataKey(key: string): boolean {
  const normalized = key.replace(/([a-z])([A-Z])/g, "$1_$2").toLocaleLowerCase();
  return /(?:^|_)(?:path|cwd|root|directory|workspace|home|storage|file_uri|local_uri)(?:$|_)/.test(normalized);
}

function isSecretMetadataKey(key: string): boolean {
  const normalized = key.replace(/([a-z])([A-Z])/g, "$1_$2").toLocaleLowerCase();
  return /(?:^|_)(?:api_key|authorization|cookie|credential|password|private_key|secret|session|token)(?:$|_)/.test(normalized);
}

function sanitizeSourceUri(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) if (isSecretMetadataKey(key)) url.searchParams.set(key, "[redacted]");
    return url.toString();
  } catch {
    return null;
  }
}

function sanitizeJson(value: unknown, key = "", depth = 0, budget = { remaining: MAX_JSON_NODES }): unknown {
  budget.remaining -= 1;
  if (budget.remaining < 0 || depth > MAX_JSON_DEPTH) throw new Error("Structured JSON exceeds the safety complexity limit.");
  if (typeof value === "string") {
    if (isSecretMetadataKey(key)) return "[secret redacted]";
    if (isPathMetadataKey(key) && !/^https?:\/\//i.test(value)) return "[local path redacted]";
    return redactPathsInText(value);
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeJson(entry, key, depth + 1, budget));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, sanitizeJson(child, childKey, depth + 1, budget)]));
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  throw new Error("Structured JSON contains an unsupported value.");
}

function sanitizeJsonText(raw: unknown): string {
  const parsed = JSON.parse(String(raw)) as unknown;
  return JSON.stringify(sanitizeJson(parsed));
}

function sanitizeExportRow(table: PortableTable, input: Record<string, unknown>, includeSensitiveToolOutput: boolean): Record<string, unknown> {
  const row = { ...input };
  if (table === "attachments") {
    const hash = String(row.content_hash ?? "");
    if (!SHA256_PATTERN.test(hash)) throw new Error("An attachment has an invalid content hash.");
    row.filename = portableBasename(String(row.filename ?? "attachment"));
    row.storage_path = `cas:${hash}`;
  }
  if (table === "sources") {
    row.title = redactPathsInText(String(row.title ?? ""));
    if (typeof row.uri === "string") row.uri = sanitizeSourceUri(row.uri);
  }
  if (table === "context_refs") row.ref_value = redactPathsInText(String(row.ref_value ?? ""));
  if (table === "events") row.run_id = null;
  if (table === "budget_ledger") row.model_call_id = null;
  if (table === "tool_executions") {
    if (!includeSensitiveToolOutput) {
      row.arguments_json = JSON.stringify({ excludedFromExport: true });
      row.output_text = "[excluded from export]";
      row.citations_json = "[]";
      row.sandbox_json = "{}";
    } else {
      row.output_text = redactPathsInText(String(row.output_text ?? ""));
    }
  }
  for (const [column, value] of Object.entries(row)) {
    if ((column.endsWith("_json") || column === "value_json") && value !== null) row[column] = sanitizeJsonText(value);
  }
  return row;
}

function jsonReferencesAny(value: unknown, ids: ReadonlySet<string>): boolean {
  if (ids.size === 0) return false;
  try {
    const visit = (candidate: unknown): boolean => {
      if (typeof candidate === "string") return ids.has(candidate);
      if (Array.isArray(candidate)) return candidate.some(visit);
      return candidate !== null && typeof candidate === "object" && Object.values(candidate as Record<string, unknown>).some(visit);
    };
    return visit(typeof value === "string" ? JSON.parse(value) as unknown : value);
  } catch {
    return false;
  }
}

type ExportPrivacy = {
  toolEventIds: Set<string>;
  toolEvidenceIds: Set<string>;
  taintedClaimIds: Set<string>;
  taintedRevisionIds: Set<string>;
  taintedTopicIds: Set<string>;
  taintedEntityIds: Set<string>;
  taintedObjectIds: Set<string>;
};

function exportPrivacy(database: ContinuumDatabase, includeSensitiveToolOutput: boolean): ExportPrivacy {
  const empty = (): ExportPrivacy => ({
    toolEventIds: new Set(), toolEvidenceIds: new Set(), taintedClaimIds: new Set(), taintedRevisionIds: new Set(),
    taintedTopicIds: new Set(), taintedEntityIds: new Set(), taintedObjectIds: new Set()
  });
  if (includeSensitiveToolOutput) return empty();
  const toolEventIds = new Set((database.connection.prepare("SELECT id FROM events WHERE role = 'tool' OR kind IN ('tool_call','tool_result')").all() as Array<{ id: string }>).map((row) => row.id));
  const toolExecutionIds = new Set((database.connection.prepare("SELECT id FROM tool_executions").all() as Array<{ id: string }>).map((row) => row.id));
  const toolEvidenceIds = new Set([...toolEventIds, ...toolExecutionIds]);
  if (toolEvidenceIds.size === 0) return empty();
  const taintedClaimIds = new Set<string>();
  for (const row of database.connection.prepare("SELECT claim_id, source_id, source_type FROM claim_sources").iterate() as Iterable<Record<string, unknown>>) {
    if (row.source_type === "tool_result" || toolEvidenceIds.has(String(row.source_id))) taintedClaimIds.add(String(row.claim_id));
  }
  const taintedRevisionIds = new Set<string>();
  for (const row of database.connection.prepare("SELECT revision_id, claim_id, source_id FROM page_section_sources").iterate() as Iterable<Record<string, unknown>>) {
    if (toolEvidenceIds.has(String(row.source_id)) || (row.claim_id !== null && taintedClaimIds.has(String(row.claim_id)))) taintedRevisionIds.add(String(row.revision_id));
  }
  const directTaint = new Set([...toolEvidenceIds, ...taintedClaimIds]);
  for (const row of database.connection.prepare("SELECT id, generation_inputs_json FROM topic_page_revisions").iterate() as Iterable<Record<string, unknown>>) {
    if (jsonReferencesAny(row.generation_inputs_json, directTaint)) taintedRevisionIds.add(String(row.id));
  }
  const taintedTopicIds = new Set<string>();
  for (const row of database.connection.prepare("SELECT id, topic_id FROM topic_page_revisions").iterate() as Iterable<Record<string, unknown>>) {
    if (taintedRevisionIds.has(String(row.id))) taintedTopicIds.add(String(row.topic_id));
  }
  for (const row of database.connection.prepare("SELECT id, topic_id FROM claims").iterate() as Iterable<Record<string, unknown>>) {
    if (taintedClaimIds.has(String(row.id)) && row.topic_id !== null) taintedTopicIds.add(String(row.topic_id));
  }
  for (const row of database.connection.prepare("SELECT id, topic_id FROM claims").iterate() as Iterable<Record<string, unknown>>) {
    if (row.topic_id !== null && taintedTopicIds.has(String(row.topic_id))) taintedClaimIds.add(String(row.id));
  }
  const taintedEntityIds = new Set<string>();
  for (const row of database.connection.prepare("SELECT entity_id, source_id FROM entity_aliases WHERE source_id IS NOT NULL").iterate() as Iterable<Record<string, unknown>>) {
    if (toolEvidenceIds.has(String(row.source_id)) || taintedClaimIds.has(String(row.source_id))) taintedEntityIds.add(String(row.entity_id));
  }
  return {
    toolEventIds, toolEvidenceIds, taintedClaimIds, taintedRevisionIds, taintedTopicIds, taintedEntityIds,
    taintedObjectIds: new Set([...taintedClaimIds, ...taintedTopicIds, ...taintedEntityIds])
  };
}

function includePortableRow(table: PortableTable, row: Record<string, unknown>, privacy: ExportPrivacy): boolean {
  if (table === "settings" && !PORTABLE_SETTING_KEYS.has(String(row.key))) return false;
  if (table === "context_refs" && privacy.toolEventIds.has(String(row.event_id))) return false;
  if (table === "claims") return !privacy.taintedClaimIds.has(String(row.id));
  if (table === "claim_sources") return !privacy.taintedClaimIds.has(String(row.claim_id)) && row.source_type !== "tool_result" && !privacy.toolEvidenceIds.has(String(row.source_id));
  if (table === "claim_relations") return !privacy.taintedClaimIds.has(String(row.source_claim_id)) && !privacy.taintedClaimIds.has(String(row.target_claim_id));
  if (table === "entities") return !privacy.taintedEntityIds.has(String(row.id));
  if (table === "entity_aliases") return !privacy.taintedEntityIds.has(String(row.entity_id)) && (row.source_id === null || !privacy.toolEvidenceIds.has(String(row.source_id)));
  if (table === "edges") return !privacy.taintedObjectIds.has(String(row.source_id)) && !privacy.taintedObjectIds.has(String(row.target_id)) && !jsonReferencesAny(row.evidence_json, new Set([...privacy.toolEvidenceIds, ...privacy.taintedClaimIds]));
  if (table === "merge_history") return !privacy.taintedObjectIds.has(String(row.source_id)) && !privacy.taintedObjectIds.has(String(row.target_id));
  if (table === "topic_pages") return !privacy.taintedTopicIds.has(String(row.id));
  if (table === "topic_page_revisions") return !privacy.taintedTopicIds.has(String(row.topic_id));
  if (table === "page_section_sources") return !privacy.taintedRevisionIds.has(String(row.revision_id)) && !privacy.toolEvidenceIds.has(String(row.source_id)) && (row.claim_id === null || !privacy.taintedClaimIds.has(String(row.claim_id)));
  if (table === "page_links") return !privacy.taintedTopicIds.has(String(row.source_topic_id)) && !privacy.taintedTopicIds.has(String(row.target_topic_id));
  if (table === "memory_pins") return !privacy.taintedObjectIds.has(String(row.object_id));
  return true;
}

function exportRow(table: PortableTable, row: Record<string, unknown>, includeSensitiveToolOutput: boolean, privacy: ExportPrivacy): Record<string, unknown> {
  const sanitized = sanitizeExportRow(table, row, includeSensitiveToolOutput);
  if (table === "event_content" && privacy.toolEventIds.has(String(row.event_id))) {
    sanitized.text_content = "[excluded from export]";
    sanitized.metadata_json = JSON.stringify({ excludedFromExport: true });
  }
  return sanitized;
}

function* exportedRows(database: ContinuumDatabase, table: PortableTable, includeSensitiveToolOutput: boolean, privacy: ExportPrivacy): Generator<Record<string, unknown>> {
  for (const row of database.connection.prepare(`SELECT * FROM "${table}"`).iterate() as Iterable<Record<string, unknown>>) {
    if (includePortableRow(table, row, privacy)) yield exportRow(table, row, includeSensitiveToolOutput, privacy);
  }
}

type JsonlShard = { archivePath: string; sourcePath: string; size: number; checksum: string; crc32: number; records: number };

function writeJsonlShards(staging: string, archivePrefix: string, rows: Iterable<Record<string, unknown>>, signal?: AbortSignal): JsonlShard[] {
  const shards: JsonlShard[] = [];
  let descriptor: number | null = null;
  let localPath = "";
  let archivePath = "";
  let size = 0;
  let records = 0;
  let hash = createHash("sha256");
  let crc = 0xffffffff;
  const begin = (): void => {
    archivePath = `${archivePrefix}/${String(shards.length).padStart(6, "0")}.jsonl`;
    localPath = join(staging, `shard-${String(shards.length).padStart(6, "0")}-${uuidv7()}`);
    descriptor = openSync(localPath, "wx", 0o600);
    size = 0;
    records = 0;
    hash = createHash("sha256");
    crc = 0xffffffff;
  };
  const finish = (): void => {
    if (descriptor === null) return;
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    shards.push({ archivePath, sourcePath: localPath, size, records, checksum: hash.digest("hex"), crc32: (crc ^ 0xffffffff) >>> 0 });
  };
  try {
    for (const row of rows) {
      signal?.throwIfAborted();
      const line = Buffer.from(`${JSON.stringify(row)}\n`);
      if (line.byteLength > MAX_JSONL_RECORD_BYTES) throw new Error(`A ${archivePrefix} record exceeds the 4 MiB portable-record limit.`);
      if (descriptor === null) begin();
      if (size > 0 && size + line.byteLength > MAX_JSONL_SHARD_BYTES) { finish(); begin(); }
      writeSync(descriptor!, line);
      size += line.byteLength;
      records += 1;
      hash.update(line);
      crc = updateCrc32(crc, line);
    }
    finish();
    return shards;
  } catch (error) {
    if (descriptor !== null) { closeSync(descriptor); descriptor = null; }
    for (const shard of shards) try { unlinkSyncCompat(shard.sourcePath); } catch { /* staging cleanup is authoritative */ }
    throw error;
  }
}

function writeStagedBytes(staging: string, bytes: Uint8Array | string): Omit<JsonlShard, "archivePath" | "records"> {
  const content = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
  const sourcePath = join(staging, `entry-${uuidv7()}`);
  const descriptor = openSync(sourcePath, "wx", 0o600);
  try {
    writeSync(descriptor, content);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return { sourcePath, size: content.byteLength, checksum: stableHash(content), crc32: crc32Bytes(content) };
}

function* exportedEventProjectionRows(database: ContinuumDatabase, includeSensitiveToolOutput: boolean, privacy: ExportPrivacy): Generator<Record<string, unknown>> {
  const contents = database.connection.prepare("SELECT * FROM event_content WHERE event_id = ? ORDER BY ordinal");
  for (const raw of database.connection.prepare("SELECT * FROM events ORDER BY sequence").iterate() as Iterable<Record<string, unknown>>) {
    const event = exportRow("events", raw, includeSensitiveToolOutput, privacy);
    const projectedContents = [...(contents.iterate(raw.id) as Iterable<Record<string, unknown>>)]
      .map((row) => exportRow("event_content", row, includeSensitiveToolOutput, privacy))
      .map((row) => ({ ordinal: row.ordinal, contentType: row.content_type, text: row.text_content, metadata: JSON.parse(String(row.metadata_json)) }));
    yield { ...event, contents: projectedContents };
  }
}

function unlinkSyncCompat(path: string): void {
  try { unlinkSync(path); }
  catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error; }
}

function eventsJsonl(structured: StructuredData): string {
  const contents = new Map<string, Array<Record<string, unknown>>>();
  for (const row of structured.event_content) {
    const id = String(row.event_id);
    const values = contents.get(id) ?? [];
    values.push({ ordinal: row.ordinal, contentType: row.content_type, text: row.text_content, metadata: JSON.parse(String(row.metadata_json)) });
    contents.set(id, values);
  }
  return structured.events.map((row) => JSON.stringify({ ...row, contents: (contents.get(String(row.id)) ?? []).sort((left, right) => Number(left.ordinal) - Number(right.ordinal)) })).join("\n") + "\n";
}

function wikiFiles(structured: StructuredData): Map<string, string> {
  const files = new Map<string, string>();
  const revisions = new Map(structured.topic_page_revisions.map((row) => [`${String(row.topic_id)}:${Number(row.revision_number)}`, row]));
  for (const topic of structured.topic_pages) {
    const id = String(topic.id);
    const revision = revisions.get(`${id}:${Number(topic.active_revision)}`);
    if (!revision) throw new Error(`Topic ${id} has no active revision.`);
    files.set(`wiki/${id}.md`, String(revision.markdown));
  }
  return files;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function verifiedBytes(bundle: VerifiedBundle, path: string): Promise<Uint8Array | undefined> {
  const value = bundle.files.get(path);
  if (!value) return undefined;
  return value instanceof Uint8Array ? value : readFile(value.path);
}

async function verifiedText(bundle: VerifiedBundle, path: string): Promise<string | undefined> {
  const bytes = await verifiedBytes(bundle, path);
  return bytes ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateJsonComplexity(value: unknown): void {
  sanitizeJson(value);
}

function validateSqliteValue(table: string, column: ColumnInfo, value: unknown): void {
  if (value === null) {
    if (column.notnull === 1) throw new Error(`${table}.${column.name} may not be null.`);
    return;
  }
  const type = column.type.toUpperCase();
  if (type === "TEXT" && typeof value !== "string") throw new Error(`${table}.${column.name} must be text.`);
  if (type === "INTEGER" && (typeof value !== "number" || !Number.isSafeInteger(value))) throw new Error(`${table}.${column.name} must be a safe integer.`);
  if (type === "REAL" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`${table}.${column.name} must be a finite number.`);
  if ((column.name.endsWith("_json") || column.name === "value_json") && typeof value === "string") {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { throw new Error(`${table}.${column.name} contains invalid JSON.`); }
    validateJsonComplexity(parsed);
  }
}

function attachmentRows(structured: StructuredData): Array<Record<string, unknown>> {
  return structured.attachments;
}

function tableColumns(database: ContinuumDatabase, table: PortableTable): ColumnInfo[] {
  return database.connection.prepare(`PRAGMA table_info("${table}")`).all() as ColumnInfo[];
}

function assertRelationalIntegrity(structured: StructuredData): void {
  const scratch = ContinuumDatabase.open(":memory:");
  try {
    scratch.connection.transaction(() => {
      scratch.connection.pragma("defer_foreign_keys = ON");
      for (const table of [...RESET_TABLES].reverse()) scratch.connection.prepare(`DELETE FROM "${table}"`).run();
      for (const fts of ["event_fts", "chunk_fts", "claim_fts", "topic_fts", "topic_revision_fts"]) scratch.connection.prepare(`DELETE FROM "${fts}"`).run();
      for (const table of PORTABLE_TABLES) {
        const names = tableColumns(scratch, table).map((column) => column.name);
        const statement = scratch.connection.prepare(`INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(",")}) VALUES (${names.map(() => "?").join(",")})`);
        for (const row of structured[table]) statement.run(...names.map((name) => row[name]));
      }
    })();
    const foreignKeyFailures = scratch.connection.pragma("foreign_key_check") as unknown[];
    if (foreignKeyFailures.length > 0) throw new Error("The portable bundle has invalid relational references.");
  } catch (error) {
    throw new Error("The portable bundle cannot be loaded into a clean vault.", { cause: error });
  } finally {
    scratch.close();
  }
}

function validateStructuredData(database: ContinuumDatabase, value: unknown, manifest: BundleManifest): StructuredData {
  if (!isPlainRecord(value)) throw new Error("The bundle's structured data must be an object.");
  assertExactKeys(Object.keys(value), PORTABLE_TABLES, "structured table set");
  assertExactKeys(Object.keys(manifest.counts), PORTABLE_TABLES, "count table set");
  if (Object.values(manifest.counts).reduce((sum, count) => sum + count, 0) > MAX_TOTAL_ROWS) throw new Error("The bundle contains too many structured rows.");
  const structured = {} as StructuredData;
  for (const table of PORTABLE_TABLES) {
    const rows = value[table];
    if (!Array.isArray(rows) || rows.length > MAX_ROWS_PER_TABLE) throw new Error(`The bundle table ${table} is not a bounded array.`);
    if (manifest.counts[table] !== rows.length) throw new Error(`The bundle count for ${table} is incorrect.`);
    const columns = tableColumns(database, table);
    if (columns.length === 0) throw new Error(`The current database does not support ${table}.`);
    const names = columns.map((column) => column.name);
    structured[table] = rows.map((row, index) => {
      if (!isPlainRecord(row)) throw new Error(`${table}[${index}] must be an object.`);
      assertExactKeys(Object.keys(row), names, `${table}[${index}] columns`);
      for (const column of columns) validateSqliteValue(table, column, row[column.name]);
      return { ...row };
    });
  }

  for (const table of ["prompt_versions", "sources", "attachments", "source_chunks"] as const) {
    for (const row of structured[table]) {
      if (!SHA256_PATTERN.test(String(row.content_hash))) throw new Error(`${table} contains an invalid content hash.`);
    }
  }
  for (const row of structured.settings) {
    const key = String(row.key);
    if (!PORTABLE_SETTING_KEYS.has(key)) throw new Error(`Setting ${key} is not portable.`);
    const schema = PORTABLE_SETTING_SCHEMAS[key];
    if (!schema) throw new Error(`Setting ${key} has no portable schema.`);
    schema.parse(JSON.parse(String(row.value_json)) as unknown);
  }
  if (structured.vaults.length !== 1 || structured.vaults[0]?.scope_id !== "global") throw new Error("A portable bundle must contain exactly one global vault.");

  const attachmentIds = new Set<string>();
  const hashSizes = new Map<string, number>();
  for (const row of attachmentRows(structured)) {
    const id = String(row.id);
    const hash = String(row.content_hash);
    if (attachmentIds.has(id) || !SHA256_PATTERN.test(hash)) throw new Error("Attachment identifiers must be unique and content hashes must be valid.");
    if (Number(row.size) > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment ${id} exceeds the 25 MB import policy.`);
    const priorSize = hashSizes.get(hash);
    if (priorSize !== undefined && priorSize !== Number(row.size)) throw new Error("Logical attachments sharing content must declare the same byte size.");
    if (row.storage_path !== `cas:${hash}`) throw new Error("Attachment storage paths must use portable content addresses.");
    if (portableBasename(String(row.filename)) !== row.filename) throw new Error("Attachment filenames must be portable basenames.");
    attachmentIds.add(id);
    hashSizes.set(hash, Number(row.size));
  }
  for (const row of structured.topic_pages) {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(String(row.id))) throw new Error("Topic identifiers must be portable and path-safe.");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(row.slug))) throw new Error("Topic slugs must be portable and path-safe.");
  }
  return structured;
}

function portableRows(bundle: VerifiedBundle, table: PortableTable): Iterable<Record<string, unknown>> {
  if (bundle.structured) return bundle.structured[table];
  if (bundle.portableDatabase) return bundle.portableDatabase.connection.prepare(`SELECT * FROM "${table}"`).iterate() as Iterable<Record<string, unknown>>;
  throw new Error("The verified bundle has no structured row source.");
}

function sourceChunkSourceIds(bundle: VerifiedBundle): string[] {
  if (bundle.portableDatabase) return (bundle.portableDatabase.connection.prepare("SELECT DISTINCT source_id FROM source_chunks").all() as Array<{ source_id: string }>).map((row) => row.source_id);
  return [...new Set((bundle.structured?.source_chunks ?? []).map((row) => String(row.source_id)))];
}

function* wikiEntriesFromBundle(bundle: VerifiedBundle): Generator<[string, string]> {
  if (bundle.portableDatabase) {
    const statement = bundle.portableDatabase.connection.prepare(`
      SELECT tp.id, tpr.markdown
      FROM topic_pages tp JOIN topic_page_revisions tpr
        ON tpr.topic_id = tp.id AND tpr.revision_number = tp.active_revision
      ORDER BY tp.id
    `);
    for (const row of statement.iterate() as Iterable<Record<string, unknown>>) yield [`wiki/${String(row.id)}.md`, String(row.markdown)];
    return;
  }
  if (!bundle.structured) throw new Error("The verified bundle has no wiki row source.");
  yield* wikiFiles(bundle.structured);
}

async function* jsonlRecords(bundle: VerifiedBundle, paths: readonly string[]): AsyncGenerator<Record<string, unknown>> {
  for (const path of paths) {
    const file = bundle.files.get(path);
    if (!file || file instanceof Uint8Array) throw new Error(`The streamed bundle entry ${path} is unavailable.`);
    const lines = createInterface({ input: createReadStream(file.path), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line || Buffer.byteLength(line) + 1 > MAX_JSONL_RECORD_BYTES) throw new Error(`The JSONL entry ${path} contains an invalid record.`);
      let parsed: unknown;
      try { parsed = JSON.parse(line) as unknown; }
      catch { throw new Error(`The JSONL entry ${path} contains invalid JSON.`); }
      if (!isPlainRecord(parsed)) throw new Error(`The JSONL entry ${path} must contain objects.`);
      yield parsed;
    }
  }
}

async function loadStreamedStructuredDatabase(
  current: ContinuumDatabase,
  bundle: VerifiedBundle,
  budgetUsd: number,
  scratchPath: string
): Promise<ContinuumDatabase> {
  const shards = bundle.manifest.tableShards;
  if (bundle.manifest.version !== 2 || !shards) throw new Error("The streamed table manifest is missing.");
  assertExactKeys(Object.keys(shards), PORTABLE_TABLES, "streamed table set");
  // A file-backed validation database keeps 100k-message / multi-gigabyte
  // metadata imports bounded by disk rather than process memory.
  const scratch = ContinuumDatabase.open(scratchPath);
  try {
    scratch.connection.pragma("foreign_keys = OFF");
    for (const table of [...RESET_TABLES].reverse()) scratch.connection.prepare(`DELETE FROM "${table}"`).run();
    for (const fts of ["event_fts", "chunk_fts", "claim_fts", "topic_fts", "topic_revision_fts"]) scratch.connection.prepare(`DELETE FROM "${fts}"`).run();
    let totalRows = 0;
    for (const table of PORTABLE_TABLES) {
      const paths = shards[table] ?? [];
      paths.forEach((path, index) => {
        if (path !== `data/tables/${table}/${String(index).padStart(6, "0")}.jsonl`) throw new Error(`The bundle table ${table} has non-canonical shards.`);
      });
      const columns = tableColumns(current, table);
      const names = columns.map((column) => column.name);
      const statement = scratch.connection.prepare(`INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(",")}) VALUES (${names.map(() => "?").join(",")})`);
      let count = 0;
      scratch.connection.exec("BEGIN IMMEDIATE");
      let transactionOpen = true;
      try {
        for await (const row of jsonlRecords(bundle, paths)) {
          assertExactKeys(Object.keys(row), names, `${table}[${count}] columns`);
          for (const column of columns) validateSqliteValue(table, column, row[column.name]);
          statement.run(...names.map((name) => row[name]));
          count += 1;
          totalRows += 1;
          if (count > MAX_ROWS_PER_TABLE || totalRows > MAX_TOTAL_ROWS) throw new Error("The bundle contains too many structured rows.");
          if (count % 512 === 0) {
            scratch.connection.exec("COMMIT");
            transactionOpen = false;
            scratch.connection.exec("BEGIN IMMEDIATE");
            transactionOpen = true;
          }
        }
        scratch.connection.exec("COMMIT");
        transactionOpen = false;
      } catch (error) {
        if (transactionOpen) {
          try { scratch.connection.exec("ROLLBACK"); } catch { /* Preserve the validation failure. */ }
        }
        throw error;
      }
      if (bundle.manifest.counts[table] !== count) throw new Error(`The bundle count for ${table} is incorrect.`);
    }
    scratch.connection.pragma("foreign_keys = ON");
    if ((scratch.connection.pragma("foreign_key_check") as unknown[]).length > 0) throw new Error("The portable bundle has invalid relational references.");

    for (const table of ["prompt_versions", "sources", "attachments", "source_chunks"] as const) {
      for (const row of scratch.connection.prepare(`SELECT content_hash FROM "${table}"`).iterate() as Iterable<Record<string, unknown>>) {
        if (!SHA256_PATTERN.test(String(row.content_hash))) throw new Error(`${table} contains an invalid content hash.`);
      }
    }
    for (const row of scratch.connection.prepare("SELECT key, value_json FROM settings").iterate() as Iterable<Record<string, unknown>>) {
      const key = String(row.key);
      if (!PORTABLE_SETTING_KEYS.has(key)) throw new Error(`Setting ${key} is not portable.`);
      const schema = PORTABLE_SETTING_SCHEMAS[key];
      if (!schema) throw new Error(`Setting ${key} has no portable schema.`);
      schema.parse(JSON.parse(String(row.value_json)) as unknown);
    }
    const vaults = scratch.connection.prepare("SELECT scope_id FROM vaults").all() as Array<{ scope_id: string }>;
    if (vaults.length !== 1 || vaults[0]?.scope_id !== "global") throw new Error("A portable bundle must contain exactly one global vault.");
    const hashSizes = new Map<string, number>();
    for (const row of scratch.connection.prepare("SELECT id, content_hash, size, storage_path, filename FROM attachments").iterate() as Iterable<Record<string, unknown>>) {
      const id = String(row.id); const hash = String(row.content_hash); const size = Number(row.size);
      if (size > MAX_ATTACHMENT_BYTES || row.storage_path !== `cas:${hash}` || portableBasename(String(row.filename)) !== row.filename) throw new Error(`Attachment ${id} violates the portable attachment policy.`);
      const prior = hashSizes.get(hash);
      if (prior !== undefined && prior !== size) throw new Error("Logical attachments sharing content must declare the same byte size.");
      hashSizes.set(hash, size);
    }
    for (const row of scratch.connection.prepare("SELECT id, slug FROM topic_pages").iterate() as Iterable<Record<string, unknown>>) {
      if (!/^[a-zA-Z0-9_-]{1,200}$/.test(String(row.id)) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(row.slug))) throw new Error("Topic identifiers must be portable and path-safe.");
    }
    const invalidUsage = Number((scratch.connection.prepare(`
      SELECT COUNT(*) AS count FROM budget_ledger
      WHERE input_tokens < 0 OR output_tokens < 0 OR estimated_cost_usd < 0
    `).get() as { count: number }).count);
    if (invalidUsage > 0) throw new Error("The imported budget ledger contains negative usage.");
    const spend = Number((scratch.connection.prepare("SELECT COALESCE(SUM(estimated_cost_usd), 0) AS value FROM budget_ledger").get() as { value: number }).value);
    if (!Number.isFinite(spend) || spend < 0 || spend > budgetUsd) throw new Error("The imported budget ledger exceeds this installation's hard budget.");
    return scratch;
  } catch (error) {
    scratch.close();
    throw error;
  }
}

function expectedFiles(structured: StructuredData, includesAttachments: boolean): Set<string> {
  const files = new Set<string>(["README.txt", "data/structured.json", "data/events.jsonl", ...wikiFiles(structured).keys()]);
  if (includesAttachments) for (const row of attachmentRows(structured)) files.add(`attachments/${String(row.content_hash)}`);
  return files;
}

function expectedStreamedFiles(bundle: VerifiedBundle): Set<string> {
  const files = new Set<string>(["README.txt"]);
  for (const paths of Object.values(bundle.manifest.tableShards ?? {})) for (const path of paths) files.add(path);
  for (const path of bundle.manifest.eventShards ?? []) files.add(path);
  for (const [path] of wikiEntriesFromBundle(bundle)) files.add(path);
  if (bundle.manifest.includesAttachments) for (const row of portableRows(bundle, "attachments")) files.add(`attachments/${String(row.content_hash)}`);
  return files;
}

function centralSize(entry: JSZipObject): number | null {
  const data = (entry as JSZipObject & { _data?: { uncompressedSize?: unknown } })._data;
  return typeof data?.uncompressedSize === "number" ? data.uncompressedSize : null;
}

export class VaultMaintenance {
  readonly #database: ContinuumDatabase;
  readonly #config: AppConfig;
  readonly #syncDirectory: DirectorySync;
  #backupQueue: Promise<void> = Promise.resolve();
  #exportQueue: Promise<void> = Promise.resolve();
  #exportFileLifecycleQueue: Promise<void> = Promise.resolve();
  #verifiedImportLifecycleQueue: Promise<void> = Promise.resolve();
  #scheduleInFlight: Promise<Array<Record<string, unknown>>> | null = null;
  #activeExportDownloads = new Set<string>();
  #instanceId = uuidv7();
  #backupShutdown = new AbortController();
  #verifiedImportsInFlight = new Set<string>();
  #exportState: {
    status: "idle" | "snapshotting" | "archiving" | "failed";
    startedAt?: string;
    completedAt?: string;
    expandedBytes?: number;
    archiveBytes?: number;
    errorType?: string;
  } = { status: "idle" };

  constructor(database: ContinuumDatabase, config: AppConfig, filesystem: { syncDirectory?: DirectorySync } = {}) {
    this.#database = database;
    this.#config = config;
    this.#syncDirectory = filesystem.syncDirectory ?? syncDirectory;
  }

  exportStatus(): Record<string, unknown> { return { ...this.#exportState }; }

  requestBackupShutdown(): void {
    this.#backupShutdown.abort(new Error("Vault maintenance is shutting down."));
  }

  async waitForBackupShutdown(): Promise<void> {
    await this.#backupQueue;
    if (this.#scheduleInFlight) await this.#scheduleInFlight;
  }

  /** Barrier for all backup work admitted before maintenance closed writes. */
  async waitForBackupIdle(): Promise<void> {
    for (;;) {
      const queued = this.#backupQueue;
      const scheduled = this.#scheduleInFlight;
      await Promise.allSettled([queued, ...(scheduled ? [scheduled] : [])]);
      if (queued === this.#backupQueue && scheduled === this.#scheduleInFlight) return;
    }
  }

  #backupStagingParent(): string {
    return join(this.#config.dataDir, "backup-staging");
  }

  #backupStagingOwnerHash(): string {
    return stableHash(`continuum-backup-staging:${resolve(this.#config.dataDir)}`);
  }

  async pruneStaleBackupStaging(reference = new Date()): Promise<{ removed: number; retained: number }> {
    const parent = this.#backupStagingParent();
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700);
    const parentInfo = await lstat(parent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error("The backup staging root is unsafe.");
    let removed = 0;
    let retained = 0;
    for (const name of await readdir(parent)) {
      const match = /^snapshot-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(name);
      if (!match) continue;
      const root = join(parent, name);
      let rootInfo: Stats;
      let markerInfo: Stats;
      try {
        rootInfo = await lstat(root);
        markerInfo = await lstat(join(root, BACKUP_STAGING_MARKER));
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") { retained += 1; continue; }
        throw error;
      }
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 4_096) {
        retained += 1;
        continue;
      }
      let marker: BackupStagingMarker;
      try {
        marker = BackupStagingMarkerSchema.parse(JSON.parse(await readFile(join(root, BACKUP_STAGING_MARKER), "utf8")) as unknown);
      } catch {
        retained += 1;
        continue;
      }
      if (marker.snapshotId !== match[1] || marker.ownerHash !== this.#backupStagingOwnerHash()) {
        retained += 1;
        continue;
      }
      const age = reference.getTime() - Date.parse(marker.createdAt);
      const belongsToThisInstance = marker.instanceId === this.#instanceId;
      const plausiblyActive = processIsAlive(marker.processId) && age <= MAX_ACTIVE_BACKUP_STAGING_AGE_MS;
      if (belongsToThisInstance || plausiblyActive) {
        retained += 1;
        continue;
      }
      await removeTreeDurably(root, this.#syncDirectory);
      removed += 1;
    }
    // Fence an earlier cleanup whose unlink/rmdir succeeded but whose directory
    // sync failed. This also makes an empty scan a valid recovery retry.
    await this.#syncDirectory(parent);
    return { removed, retained };
  }

  #verifiedImportDirectory(): string {
    return join(this.#config.dataDir, "verified-imports");
  }

  #verifiedImportOwnerHash(): string {
    return stableHash(`continuum-verified-imports:${resolve(this.#config.dataDir)}`);
  }

  #verifiedImportSessionHash(): string {
    return stableHash(`continuum-session:${this.#config.sessionToken}`);
  }

  #verifiedImportPaths(rawToken: string): { token: string; archivePath: string; markerPath: string } {
    const parsed = z.string().uuid().safeParse(rawToken);
    if (!parsed.success || parsed.data !== parsed.data.toLocaleLowerCase()) {
      throw new VaultVerificationTokenError("INVALID", "That verified-import token is invalid.");
    }
    const token = parsed.data;
    const directory = this.#verifiedImportDirectory();
    return {
      token,
      archivePath: join(directory, `${token}.zip`),
      markerPath: join(directory, `${token}.json`)
    };
  }

  #withVerifiedImportLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.#verifiedImportLifecycleQueue.then(operation);
    this.#verifiedImportLifecycleQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  async pruneVerifiedImports(
    preserve: ReadonlySet<string> = new Set(),
    reference = new Date()
  ): Promise<{ removed: number; retained: number }> {
    return this.#withVerifiedImportLifecycle(async () => {
      const directory = this.#verifiedImportDirectory();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      const directoryInfo = await lstat(directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error("The verified-import staging root is unsafe.");
      const candidates: Array<{ marker: VerifiedImportMarker; archivePath: string; markerPath: string; createdAtMs: number }> = [];
      let removed = 0;
      let retained = 0;
      for (const name of await readdir(directory)) {
        const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/.exec(name);
        if (!match) continue;
        const paths = this.#verifiedImportPaths(match[1]!);
        let markerInfo: Stats;
        try { markerInfo = await lstat(paths.markerPath); }
        catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
          throw error;
        }
        if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 4_096) { retained += 1; continue; }
        let marker: VerifiedImportMarker;
        try { marker = VerifiedImportMarkerSchema.parse(JSON.parse(await readFile(paths.markerPath, "utf8")) as unknown); }
        catch { retained += 1; continue; }
        if (marker.token !== paths.token || marker.ownerHash !== this.#verifiedImportOwnerHash()) { retained += 1; continue; }
        let archiveInfo: Stats | undefined;
        try { archiveInfo = await lstat(paths.archivePath); }
        catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        }
        if (!archiveInfo) {
          await unlinkIfExists(paths.markerPath);
          removed += 1;
          continue;
        }
        if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.size !== marker.size) {
          await unlinkIfExists(paths.archivePath);
          await unlinkIfExists(paths.markerPath);
          removed += 1;
          continue;
        }
        if (marker.sessionHash !== this.#verifiedImportSessionHash()) {
          await unlinkIfExists(paths.archivePath);
          await unlinkIfExists(paths.markerPath);
          removed += 1;
          continue;
        }
        candidates.push({ marker, archivePath: paths.archivePath, markerPath: paths.markerPath, createdAtMs: Date.parse(marker.createdAt) });
      }
      candidates.sort((left, right) => right.createdAtMs - left.createdAtMs || right.marker.token.localeCompare(left.marker.token));
      let retainedCount = 0;
      let retainedBytes = 0;
      for (const candidate of candidates) {
        const protectedNow = preserve.has(candidate.marker.token) || this.#verifiedImportsInFlight.has(candidate.marker.token);
        const unexpired = Date.parse(candidate.marker.expiresAt) > reference.getTime();
        const fits = retainedCount < MAX_VERIFIED_IMPORTS && retainedBytes + candidate.marker.size <= MAX_VERIFIED_IMPORT_BYTES;
        if (protectedNow || (unexpired && fits)) {
          retainedCount += 1;
          retainedBytes += candidate.marker.size;
          retained += 1;
          continue;
        }
        await unlinkIfExists(candidate.archivePath);
        await unlinkIfExists(candidate.markerPath);
        removed += 1;
      }
      return { removed, retained };
    });
  }

  async stageVerifiedImportFile(archivePath: string): Promise<Record<string, unknown>> {
    await this.pruneVerifiedImports();
    let verified: VerifiedBundle;
    try { verified = await this.verifyBundleFile(archivePath); }
    catch (error) {
      if (error instanceof VaultImportStorageError || isRetryableVaultImportIoError(error)) throw error;
      throw new VaultBundleValidationError(error);
    }
    const token = uuidv7();
    const paths = this.#verifiedImportPaths(token);
    const createdAt = new Date();
    const marker: VerifiedImportMarker = {
      format: "continuum-verified-import",
      token,
      ownerHash: this.#verifiedImportOwnerHash(),
      sessionHash: this.#verifiedImportSessionHash(),
      archiveChecksum: verified.archiveChecksum,
      size: (await stat(archivePath)).size,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + VERIFIED_IMPORT_TTL_MS).toISOString()
    };
    try {
      await this.#withVerifiedImportLifecycle(async () => {
        await mkdir(this.#verifiedImportDirectory(), { recursive: true, mode: 0o700 });
        await writeDurableFile(paths.markerPath, Buffer.from(JSON.stringify(marker)));
        let linked = false;
        try {
          await link(archivePath, paths.archivePath);
          linked = true;
          await chmod(paths.archivePath, 0o600);
          await unlinkIfExists(archivePath);
        } catch (error) {
          if (linked) await unlinkIfExists(paths.archivePath);
          await unlinkIfExists(paths.markerPath);
          throw error;
        }
      });
    } finally {
      await verified.cleanup?.();
    }
    await this.pruneVerifiedImports(new Set([token]));
    return {
      valid: true,
      replaced: false,
      manifest: verified.manifest,
      verificationToken: token,
      archiveChecksum: marker.archiveChecksum,
      size: marker.size,
      expiresAt: marker.expiresAt
    };
  }

  async importVerifiedToken(tokenValue: string, mode: Exclude<ImportMode, "verify">): Promise<Record<string, unknown>> {
    const paths = this.#verifiedImportPaths(tokenValue);
    if (this.#verifiedImportsInFlight.has(paths.token)) throw new VaultVerificationTokenError("IN_USE", "That verified import is already being committed.");
    this.#verifiedImportsInFlight.add(paths.token);
    let verified: VerifiedBundle | undefined;
    let consumeStagedImport = false;
    try {
      let marker: VerifiedImportMarker;
      try {
        const markerInfo = await lstat(paths.markerPath);
        const archiveInfo = await lstat(paths.archivePath);
        if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.size > 4_096 || !archiveInfo.isFile() || archiveInfo.isSymbolicLink()) throw new Error("Unsafe verified-import files.");
        marker = VerifiedImportMarkerSchema.parse(JSON.parse(await readFile(paths.markerPath, "utf8")) as unknown);
        if (
          marker.token !== paths.token || marker.ownerHash !== this.#verifiedImportOwnerHash() ||
          marker.sessionHash !== this.#verifiedImportSessionHash() || archiveInfo.size !== marker.size
        ) throw new Error("Verified-import metadata is inconsistent.");
      } catch (error) {
        if (isRetryableVaultImportIoError(error)) throw error;
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          throw new VaultVerificationTokenError("NOT_FOUND", "That verified import is no longer available.");
        }
        if (error instanceof VaultVerificationTokenError) throw error;
        throw new VaultVerificationTokenError("INVALID", "That verified import is invalid or corrupted.");
      }
      if (Date.parse(marker.expiresAt) <= Date.now()) throw new VaultVerificationTokenError("EXPIRED", "That verified import has expired; verify the file again.");
      try { verified = await this.verifyBundleFile(paths.archivePath); }
      catch (error) {
        if (error instanceof VaultImportStorageError || isRetryableVaultImportIoError(error)) throw error;
        throw new VaultBundleValidationError(error);
      }
      if (verified.archiveChecksum !== marker.archiveChecksum) throw new VaultBundleValidationError(new Error("The staged archive changed after verification."));
      const imported = await this.#importVerified(
        verified,
        mode,
        marker.size,
        (destination) => copyDurableFile(paths.archivePath, destination, marker.size, marker.archiveChecksum)
      );
      consumeStagedImport = true;
      return imported;
    } catch (error) {
      // A verified archive is a retry handle. Consume it only after success or
      // when retrying cannot help; operational/storage failures keep it staged.
      consumeStagedImport = error instanceof VaultBundleValidationError ||
        (error instanceof VaultVerificationTokenError && ["INVALID", "NOT_FOUND", "EXPIRED"].includes(error.code));
      throw error;
    } finally {
      try { await verified?.cleanup?.(); }
      finally {
        try {
          if (consumeStagedImport) {
            await this.#withVerifiedImportLifecycle(async () => {
              await unlinkIfExists(paths.archivePath);
              await unlinkIfExists(paths.markerPath);
            });
          }
        } finally {
          this.#verifiedImportsInFlight.delete(paths.token);
        }
      }
    }
  }

  #withExportFileLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.#exportFileLifecycleQueue.then(operation);
    this.#exportFileLifecycleQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  async pruneExports(preserve: ReadonlySet<string> = new Set(), reserveBytes = 0): Promise<void> {
    await this.#withExportFileLifecycle(async () => {
    await mkdir(this.#config.exportsDir, { recursive: true, mode: 0o700 });
    const now = Date.now();
    const candidates: Array<{ name: string; path: string; size: number; mtimeMs: number }> = [];
    for (const name of await readdir(this.#config.exportsDir)) {
      if (!/^continuum-[a-zA-Z0-9._-]+\.zip$/.test(name)) continue;
      const path = join(this.#config.exportsDir, name);
      try {
        const info = await stat(path);
        if (info.isFile()) candidates.push({ name, path, size: info.size, mtimeMs: info.mtimeMs });
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
    }
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs || right.name.localeCompare(left.name));
    let retainedCount = 0;
    let retainedBytes = 0;
    for (const candidate of candidates) {
      const protectedNow = preserve.has(candidate.name) || this.#activeExportDownloads.has(candidate.name);
      const withinWindow = now - candidate.mtimeMs <= EXPORT_RETRY_WINDOW_MS;
      const fits = retainedCount < MAX_RETAINED_EXPORTS && retainedBytes + candidate.size + reserveBytes <= MAX_RETAINED_EXPORT_BYTES;
      if (protectedNow || (withinWindow && fits)) {
        retainedCount += 1;
        retainedBytes += candidate.size;
      } else {
        await unlinkIfExists(candidate.path);
      }
    }
    });
  }

  async openExportDownload(filename: string): Promise<{ stream: Readable; size: number; close: () => void }> {
    return this.#withExportFileLifecycle(async () => {
    const safe = safeExportName(filename);
    const path = join(this.#config.exportsDir, safe);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let info: Stats;
    try {
      info = await handle.stat();
      if (!info.isFile()) throw new Error("Export not found.");
    } catch (error) {
      await handle.close();
      throw error;
    }
    // Opening the descriptor first means a prune decision racing this request
    // cannot truncate or substitute the bytes being downloaded.
    this.#activeExportDownloads.add(safe);
    const stream = handle.createReadStream({ autoClose: true });
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.#activeExportDownloads.delete(safe);
      void this.pruneExports().catch(() => undefined);
    };
    const close = (): void => {
      if (!stream.destroyed) stream.destroy();
      release();
    };
    stream.once("close", release);
    stream.once("error", release);
    stream.once("end", release);
    return { stream, size: info.size, close };
    });
  }

  #activeWorkCount(): number {
    return Number((this.#database.connection.prepare(`
      SELECT
        (SELECT COUNT(*) FROM runs WHERE status IN ('pending','retrieving','streaming')) +
        (SELECT COUNT(*) FROM jobs WHERE status = 'running') AS count
    `).get() as { count: number }).count);
  }

  createBackup(kind: "daily" | "weekly" | "manual" = "manual"): Promise<Record<string, unknown>> {
    return this.#queueBackup(kind, false);
  }

  #queueBackup(kind: "daily" | "weekly" | "manual", allowExistingMaintenance: boolean): Promise<Record<string, unknown>> {
    const task = this.#backupQueue.then(() => this.#createBackup(kind, allowExistingMaintenance));
    this.#backupQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  async #createBackup(kind: "daily" | "weekly" | "manual", allowExistingMaintenance: boolean): Promise<Record<string, unknown>> {
    const signal = this.#backupShutdown.signal;
    signal.throwIfAborted();
    await mkdir(this.#config.backupsDir, { recursive: true, mode: 0o700 });
    if (!allowExistingMaintenance && this.#database.getSetting("maintenance.locked", false)) throw new Error("Another maintenance operation is already in progress.");
    const snapshotId = uuidv7();
    const snapshotRoot = join(this.#backupStagingParent(), `snapshot-${snapshotId}`);
    const snapshotDatabasePath = join(snapshotRoot, "continuum.sqlite3");
    const snapshotAttachments = join(snapshotRoot, "attachments");
    const snapshotExports = join(snapshotRoot, "exports");
    let snapshotDatabase: ContinuumDatabase | undefined;
    let unfinishedDestination: string | undefined;
    await mkdir(this.#backupStagingParent(), { recursive: true, mode: 0o700 });
    const stagingParentInfo = await lstat(this.#backupStagingParent());
    if (!stagingParentInfo.isDirectory() || stagingParentInfo.isSymbolicLink()) throw new Error("The backup staging root is unsafe.");
    await mkdir(snapshotRoot, { mode: 0o700 });
    try {
      const marker: BackupStagingMarker = {
        format: "continuum-backup-staging",
        snapshotId,
        ownerHash: this.#backupStagingOwnerHash(),
        instanceId: this.#instanceId,
        processId: process.pid,
        createdAt: new Date().toISOString()
      };
      await writeDurableFile(join(snapshotRoot, BACKUP_STAGING_MARKER), Buffer.from(JSON.stringify(marker)), this.#syncDirectory);
      await mkdir(snapshotAttachments, { mode: 0o700 });
      await mkdir(snapshotExports, { mode: 0o700 });
      // better-sqlite3's online backup API takes a transactionally consistent
      // snapshot without holding Continuum's global maintenance flag. Normal
      // chat writes therefore remain available while a large archive is built.
      await this.#database.connection.backup(snapshotDatabasePath);
      signal.throwIfAborted();
      snapshotDatabase = ContinuumDatabase.open(snapshotDatabasePath);
      snapshotDatabase.setSetting("maintenance.locked", false);
      const linked = new Set<string>();
      for (const row of snapshotDatabase.connection.prepare("SELECT content_hash, size FROM attachments").iterate() as Iterable<Record<string, unknown>>) {
        signal.throwIfAborted();
        const hash = String(row.content_hash);
        if (linked.has(hash)) continue;
        const source = join(this.#config.attachmentsDir, hash.slice(0, 2), hash);
        const targetDirectory = join(snapshotAttachments, hash.slice(0, 2));
        const target = join(targetDirectory, hash);
        await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
        const info = await lstat(source);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== Number(row.size)) throw new Error("An attachment changed while the backup snapshot was being prepared.");
        await link(source, target);
        linked.add(hash);
      }
      const snapshotConfig = {
        ...this.#config,
        dataDir: snapshotRoot,
        databasePath: snapshotDatabasePath,
        attachmentsDir: snapshotAttachments,
        projectionsDir: join(snapshotRoot, "wiki"),
        backupsDir: join(snapshotRoot, "backups"),
        exportsDir: snapshotExports,
        logsDir: join(snapshotRoot, "logs"),
        runtimeDescriptorPath: join(snapshotRoot, "runtime.json")
      } as AppConfig;
      const snapshotMaintenance = new VaultMaintenance(snapshotDatabase, snapshotConfig, { syncDirectory: this.#syncDirectory });
      const timestamp = new Date().toISOString().replaceAll(":", "-");
      const filename = `continuum-${kind}-${timestamp}-${uuidv7()}.zip`;
      const destination = join(this.#config.backupsDir, filename);
      unfinishedDestination = destination;
      const exported = await snapshotMaintenance.#queueExport(
        { includeAttachments: true, includeSensitiveToolOutput: false },
        false,
        signal
      );
      signal.throwIfAborted();
      const source = snapshotMaintenance.exportPath(exported.filename);
      if (await hashFile(source) !== exported.checksum) throw new Error("The managed backup changed before verification.");
      const verified = await this.verifyBundleFile(source);
      await verified.cleanup?.();
      await renameDurably(source, destination, this.#syncDirectory);
      await chmod(destination, 0o600);
      const info = await stat(destination);
      const checksum = await hashFile(destination);
      if (checksum !== exported.checksum || info.size !== exported.size) throw new Error("The managed backup failed its post-write integrity check.");
      const id = uuidv7();
      try {
        this.#database.connection.prepare(`
          INSERT INTO backup_records(id, filename, kind, checksum, size, created_at) VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, filename, kind, checksum, info.size, new Date().toISOString());
        unfinishedDestination = undefined;
      } catch (error) {
        await unlinkDurablyIfExists(destination, this.#syncDirectory);
        throw error;
      }
      await this.pruneBackups();
      return { id, filename, kind, format: "continuum-vault", includesAttachments: true, size: info.size, checksum };
    } finally {
      try {
        if (unfinishedDestination) await unlinkDurablyIfExists(unfinishedDestination, this.#syncDirectory);
      } finally {
        try { snapshotDatabase?.close(); }
        finally { await removeTreeDurably(snapshotRoot, this.#syncDirectory); }
      }
    }
  }

  listBackups(): Array<Record<string, unknown>> {
    return this.#database.connection.prepare("SELECT * FROM backup_records ORDER BY created_at DESC").all() as Array<Record<string, unknown>>;
  }

  async pruneBackups(): Promise<void> {
    const rows = this.listBackups();
    const daily = rows.filter((row) => row.kind === "daily").slice(7);
    const weekly = rows.filter((row) => row.kind === "weekly").slice(4);
    for (const row of [...daily, ...weekly]) {
      await unlinkDurablyIfExists(join(this.#config.backupsDir, basename(String(row.filename))), this.#syncDirectory);
      this.#database.connection.prepare("DELETE FROM backup_records WHERE id = ?").run(row.id);
    }
  }

  createDueBackups(reference = new Date()): Promise<Array<Record<string, unknown>>> {
    if (this.#scheduleInFlight) return this.#scheduleInFlight;
    const task = this.#createDueBackups(reference);
    this.#scheduleInFlight = task;
    void task.finally(() => {
      if (this.#scheduleInFlight === task) this.#scheduleInFlight = null;
    }).catch(() => undefined);
    return task;
  }

  async #createDueBackups(reference: Date): Promise<Array<Record<string, unknown>>> {
    if (this.#database.getSetting("maintenance.locked", false)) return [];
    if (this.#activeWorkCount() > 0) return [];
    const today = reference.toISOString().slice(0, 10);
    const monday = new Date(reference);
    const day = (monday.getUTCDay() + 6) % 7;
    monday.setUTCDate(monday.getUTCDate() - day);
    monday.setUTCHours(0, 0, 0, 0);
    const records = this.listBackups();
    const dueDaily = !records.some((row) => row.kind === "daily" && String(row.created_at).startsWith(today));
    const dueWeekly = !records.some((row) => row.kind === "weekly" && Date.parse(String(row.created_at)) >= monday.getTime());
    const created: Array<Record<string, unknown>> = [];
    if (dueDaily) created.push(await this.createBackup("daily"));
    if (dueWeekly) created.push(await this.createBackup("weekly"));
    return created;
  }

  async scrubManagedBackupsAfterDeletion(): Promise<void> {
    // Append one indivisible queue operation: wait for every older snapshot,
    // scrub every stale archive/row, then publish the post-deletion safety copy.
    // Later backups cannot start between those phases.
    const task = this.#backupQueue.then(async () => {
      const entries = await readdirIfExists(this.#config.backupsDir);
      for (const entry of entries) {
        if (/^continuum-(daily|weekly|manual)-.+\.(?:zip|sqlite3)$/.test(entry)) {
          await unlinkDurablyIfExists(join(this.#config.backupsDir, entry), this.#syncDirectory);
        }
      }
      // A retry after a failed directory sync may observe no filename even
      // though the prior unlink was not durably ordered. Fence that transition
      // before dropping the records or publishing the post-deletion snapshot.
      await this.#syncDirectory(this.#config.backupsDir);
      this.#database.connection.prepare("DELETE FROM backup_records").run();
      await this.#createBackup("manual", true);
    });
    this.#backupQueue = task.then(() => undefined, () => undefined);
    await task;
  }

  async #physicalDatabaseBytes(): Promise<number> {
    const databaseInfo = await stat(this.#database.path);
    const walSize = await stat(`${this.#database.path}-wal`).then((value) => value.size).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0;
      throw error;
    });
    return databaseInfo.size + walSize;
  }

  #uniqueAttachmentBytes(): number {
    return Number((this.#database.connection.prepare(`
      SELECT COALESCE(SUM(size), 0) AS size
      FROM (SELECT content_hash, MAX(size) AS size FROM attachments GROUP BY content_hash)
    `).get() as { size: number }).size);
  }

  async #preflightExportStaging(includeAttachments: boolean): Promise<void> {
    // Metadata appears once in table/projection staging and once in the final
    // STORE archive. Three physical database sizes conservatively cover JSON
    // expansion and index/WAL variance before exact expanded bytes are known.
    const requiredBytes = (await this.#physicalDatabaseBytes()) * 3
      + (includeAttachments ? this.#uniqueAttachmentBytes() : 0)
      + MIN_EXPORT_FREE_SPACE_BYTES;
    await this.pruneExports(new Set(), requiredBytes);
    const disk = await statfs(this.#config.exportsDir);
    const availableBytes = Number(disk.bavail) * Number(disk.bsize);
    if (!Number.isFinite(availableBytes) || availableBytes < requiredBytes) {
      throw new VaultExportStorageError(requiredBytes, availableBytes);
    }
  }

  exportBundle(options: { includeAttachments: boolean; includeSensitiveToolOutput: boolean }, allowExistingMaintenance = false): Promise<{ filename: string; size: number; checksum: string }> {
    return this.#queueExport(options, allowExistingMaintenance);
  }

  #queueExport(
    options: { includeAttachments: boolean; includeSensitiveToolOutput: boolean },
    allowExistingMaintenance: boolean,
    signal?: AbortSignal
  ): Promise<{ filename: string; size: number; checksum: string }> {
    const task = this.#exportQueue.then(() => this.#exportBundle(options, allowExistingMaintenance, signal));
    this.#exportQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  async #exportBundle(
    options: { includeAttachments: boolean; includeSensitiveToolOutput: boolean },
    allowExistingMaintenance: boolean,
    signal?: AbortSignal
  ): Promise<{ filename: string; size: number; checksum: string }> {
    signal?.throwIfAborted();
    const maintenanceWasLocked = this.#database.getSetting("maintenance.locked", false);
    if (maintenanceWasLocked && !allowExistingMaintenance) throw new Error("Another maintenance operation is already in progress.");
    this.#database.setSetting("maintenance.locked", true);
    let unfinishedDestination: string | undefined;
    try {
      if (this.#activeWorkCount() > 0) throw new Error("Exports require active response runs and worker jobs to finish first.");
    this.#exportState = { status: "snapshotting", startedAt: new Date().toISOString() };
    await mkdir(this.#config.exportsDir, { recursive: true, mode: 0o700 });
    await this.#preflightExportStaging(options.includeAttachments);
    type ExportFile =
      | { kind: "memory"; content: Uint8Array | string; size: number; checksum: string; crc32: number }
      | { kind: "path"; sourcePath: string; size: number; checksum: string; crc32: number };
    const staging = join(this.#config.exportsDir, `.staging-${uuidv7()}`);
    await mkdir(staging, { mode: 0o700 });
    try {
    const privacy = exportPrivacy(this.#database, options.includeSensitiveToolOutput);
    const files = new Map<string, ExportFile>();
    let expandedBytes = 0;
    const reserveFile = (path: string, size: number, limit = MAX_ENTRY_BYTES): void => {
      assertSafeArchivePath(path);
      if (files.has(path)) throw new Error(`Duplicate export path ${path}.`);
      if (size > limit || expandedBytes + size > MAX_EXPANDED_BYTES || files.size + 1 > MAX_ENTRIES - 1) throw new Error("The export exceeds the portable bundle safety limits.");
      expandedBytes += size;
      this.#exportState = { ...this.#exportState, expandedBytes };
    };
    const addFile = (path: string, content: Uint8Array | string, limit = MAX_ENTRY_BYTES): void => {
      const size = typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
      reserveFile(path, size, limit);
      files.set(path, { kind: "memory", content, size, checksum: stableHash(content), crc32: crc32Bytes(content) });
    };
    const addPathFile = (path: string, file: { sourcePath: string; size: number; checksum: string; crc32: number }, limit = MAX_ENTRY_BYTES): void => {
      reserveFile(path, file.size, limit);
      files.set(path, { kind: "path", ...file });
    };

    const tableShards: Record<string, string[]> = {};
    const counts: Record<string, number> = {};
    let totalRows = 0;
    for (const table of PORTABLE_TABLES) {
      signal?.throwIfAborted();
      const shards = writeJsonlShards(staging, `data/tables/${table}`, exportedRows(this.#database, table, options.includeSensitiveToolOutput, privacy), signal);
      tableShards[table] = shards.map((shard) => shard.archivePath);
      counts[table] = shards.reduce((sum, shard) => sum + shard.records, 0);
      totalRows += counts[table]!;
      if (counts[table]! > MAX_ROWS_PER_TABLE || totalRows > MAX_TOTAL_ROWS) throw new Error("The export contains too many structured rows.");
      for (const shard of shards) addPathFile(shard.archivePath, shard);
    }
    const eventShards = writeJsonlShards(staging, "data/events", exportedEventProjectionRows(this.#database, options.includeSensitiveToolOutput, privacy), signal);
    for (const shard of eventShards) addPathFile(shard.archivePath, shard);

    for (const topic of this.#database.connection.prepare("SELECT id, active_revision FROM topic_pages ORDER BY id").iterate() as Iterable<Record<string, unknown>>) {
      signal?.throwIfAborted();
      const id = String(topic.id);
      if (privacy.taintedTopicIds.has(id)) continue;
      const revision = this.#database.connection.prepare("SELECT markdown FROM topic_page_revisions WHERE topic_id = ? AND revision_number = ?").get(id, topic.active_revision) as { markdown: string } | undefined;
      if (!revision) throw new Error(`Topic ${id} has no active revision.`);
      const path = `wiki/${id}.md`;
      addPathFile(path, writeStagedBytes(staging, revision.markdown));
    }
    if (options.includeAttachments) {
      const exportedHashes = new Map<string, number>();
      for (const attachment of exportedRows(this.#database, "attachments", options.includeSensitiveToolOutput, privacy)) {
        signal?.throwIfAborted();
        const hash = String(attachment.content_hash);
        const declaredSize = Number(attachment.size);
        const priorSize = exportedHashes.get(hash);
        if (priorSize !== undefined) {
          if (priorSize !== declaredSize) throw new Error("Logical attachments sharing content declare inconsistent byte sizes.");
          continue;
        }
        const sourcePath = join(this.#config.attachmentsDir, hash.slice(0, 2), hash);
        const info = await lstat(sourcePath);
        const integrity = !info.isFile() || info.isSymbolicLink() ? null : await hashAndCrcFile(sourcePath, signal);
        if (!integrity || info.size !== declaredSize || integrity.size !== declaredSize || integrity.checksum !== hash) throw new Error(`Attachment ${attachment.id} has an inconsistent size or checksum.`);
        const path = `attachments/${hash}`;
        reserveFile(path, declaredSize, MAX_ATTACHMENT_BYTES);
        files.set(path, { kind: "path", sourcePath, size: declaredSize, checksum: hash, crc32: integrity.crc32 });
        exportedHashes.set(hash, declaredSize);
      }
    }
    addFile("README.txt", README_CONTENT);

    const checksums: Record<string, string> = {};
    const sizes: Record<string, number> = {};
    for (const [path, file] of files) {
      checksums[path] = file.checksum;
      sizes[path] = file.size;
    }
    const manifest: BundleManifest = {
      format: "continuum-vault",
      version: 2,
      createdAt: new Date().toISOString(),
      schemaVersion: this.#database.health().schemaVersion,
      includesAttachments: options.includeAttachments,
      sensitiveToolOutputIncluded: options.includeSensitiveToolOutput,
      expandedBytes,
      checksums,
      sizes,
      counts,
      tableShards,
      eventShards: eventShards.map((shard) => shard.archivePath)
    };
    const manifestText = JSON.stringify(manifest, null, 2);
    if (Buffer.byteLength(manifestText) > MAX_MANIFEST_BYTES) throw new Error("The export manifest exceeds its safety limit.");
    await this.pruneExports(new Set(), expandedBytes + Buffer.byteLength(manifestText));
    const disk = await statfs(this.#config.exportsDir);
    const availableBytes = Number(disk.bavail) * Number(disk.bsize);
    const requiredBytes = expandedBytes + Buffer.byteLength(manifestText) + MIN_EXPORT_FREE_SPACE_BYTES;
    if (!Number.isFinite(availableBytes) || availableBytes < requiredBytes) throw new VaultExportStorageError(requiredBytes, availableBytes);
    this.#exportState = { ...this.#exportState, status: "archiving", expandedBytes, archiveBytes: 0 };

    const manifestEntry: StoredZipEntry = {
      name: "manifest.json",
      size: Buffer.byteLength(manifestText),
      checksum: stableHash(manifestText),
      crc32: crc32Bytes(manifestText),
      content: manifestText
    };
    const entries: StoredZipEntry[] = [manifestEntry, ...[...files].map(([name, file]) => ({
      name,
      size: file.size,
      checksum: file.checksum,
      crc32: file.crc32,
      content: file.kind === "path" ? { sourcePath: file.sourcePath } : file.content
    }))];
    const filename = safeExportName(`continuum-${new Date().toISOString().replaceAll(":", "-")}-${uuidv7()}.zip`);
    const destination = join(this.#config.exportsDir, filename);
    unfinishedDestination = destination;
    await writeDurableStream(destination, boundedArchiveStream(storedZipStream(entries, signal), (archiveBytes) => {
      this.#exportState = { ...this.#exportState, status: "archiving", archiveBytes };
    }, signal), this.#syncDirectory);
    const info = await stat(destination);
    if (info.size > MAX_ARCHIVE_BYTES) {
      await unlinkIfExists(destination);
      throw new Error("The compressed export exceeds the 6 GiB transport safety limit.");
    }
    const result = { filename, size: info.size, checksum: await hashFile(destination) };
    const startedAt = this.#exportState.startedAt;
    this.#exportState = {
      status: "idle",
      ...(startedAt === undefined ? {} : { startedAt }),
      completedAt: new Date().toISOString(),
      expandedBytes,
      archiveBytes: info.size
    };
    await this.pruneExports(new Set([filename]));
    unfinishedDestination = undefined;
    return result;
    } finally {
      await removeTreeDurably(staging, this.#syncDirectory);
    }
    } catch (error) {
      if (unfinishedDestination) await unlinkDurablyIfExists(unfinishedDestination, this.#syncDirectory);
      this.#exportState = { ...this.#exportState, status: "failed", completedAt: new Date().toISOString(), errorType: error instanceof Error ? error.name : "UnknownError" };
      throw error;
    } finally {
      this.#database.setSetting("maintenance.locked", maintenanceWasLocked);
    }
  }

  exportPath(filename: string): string {
    return join(this.#config.exportsDir, safeExportName(filename));
  }

  async verifyBundle(buffer: Buffer): Promise<VerifiedBundle> {
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_ARCHIVE_BYTES) throw new Error("The import bundle exceeds the 6 GiB compressed safety limit.");
    const preview = await JSZip.loadAsync(buffer, { createFolders: false });
    const previewManifest = preview.file("manifest.json");
    if (previewManifest) {
      const version = (JSON.parse(await previewManifest.async("string")) as { version?: unknown }).version;
      if (version === 2) {
        const staging = join(this.#config.dataDir, "import-staging");
        await mkdir(staging, { recursive: true, mode: 0o700 });
        await chmod(staging, 0o700);
        const path = join(staging, `buffer-${uuidv7()}.zip`);
        await writeDurableFile(path, buffer);
        try {
          const verified = await this.verifyBundleFile(path);
          const priorCleanup = verified.cleanup;
          verified.cleanup = async () => { await priorCleanup?.(); await unlinkIfExists(path); };
          return verified;
        } catch (error) {
          await unlinkIfExists(path);
          throw error;
        }
      }
    }
    const centralEntries = readCentralDirectory(buffer);
    const fileEntries = centralEntries.filter((entry) => !entry.directory);
    if (centralEntries.some((entry) => entry.directory)) throw new Error("Directory entries are not permitted in portable bundles.");
    const manifestCentral = fileEntries.find((entry) => entry.name === "manifest.json");
    if (!manifestCentral || manifestCentral.uncompressedSize > MAX_MANIFEST_BYTES) throw new Error("The bundle has no bounded manifest.");
    const totalExpanded = fileEntries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
    if (totalExpanded > MAX_EXPANDED_BYTES + MAX_MANIFEST_BYTES) throw new Error("The bundle exceeds the aggregate expanded-size limit.");

    const zip = await JSZip.loadAsync(buffer, { checkCRC32: true, createFolders: false });
    const manifestFile = zip.file("manifest.json");
    if (!manifestFile || centralSize(manifestFile) !== manifestCentral.uncompressedSize) throw new Error("The bundle manifest metadata is inconsistent.");
    const manifest = BundleManifestSchema.parse(JSON.parse(await manifestFile.async("string")) as unknown);
    assertManifestVersionLayout(manifest);
    if (manifest.schemaVersion !== this.#database.health().schemaVersion) throw new Error("This bundle uses a different database schema version.");
    assertExactKeys(Object.keys(manifest.checksums), Object.keys(manifest.sizes), "checksum and size entries");
    assertExactKeys(fileEntries.map((entry) => entry.name), ["manifest.json", ...Object.keys(manifest.checksums)], "ZIP entries");
    const manifestExpanded = Object.values(manifest.sizes).reduce((sum, size) => sum + size, 0);
    if (manifestExpanded !== manifest.expandedBytes || manifestExpanded > MAX_EXPANDED_BYTES) throw new Error("The bundle expanded-size declaration is incorrect.");

    const centralByName = new Map(fileEntries.map((entry) => [entry.name, entry]));
    const files = new Map<string, Uint8Array>();
    for (const [path, checksum] of Object.entries(manifest.checksums)) {
      assertSafeArchivePath(path);
      const entry = zip.file(path);
      const central = centralByName.get(path);
      if (!entry || !central || central.uncompressedSize !== manifest.sizes[path] || centralSize(entry) !== central.uncompressedSize) throw new Error(`The bundle size metadata for ${path} is inconsistent.`);
      const bytes = await entry.async("uint8array");
      if (bytes.byteLength !== manifest.sizes[path] || stableHash(bytes) !== checksum) throw new Error(`Checksum or size verification failed for ${path}.`);
      files.set(path, bytes);
    }

    const structuredBytes = files.get("data/structured.json");
    if (!structuredBytes) throw new Error("The bundle has no structured data.");
    let rawStructured: unknown;
    try { rawStructured = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(structuredBytes)) as unknown; }
    catch { throw new Error("The bundle structured data is not valid UTF-8 JSON."); }
    const structured = validateStructuredData(this.#database, rawStructured, manifest);
    const importedSpend = structured.budget_ledger.reduce((sum, row) => {
      const inputTokens = Number(row.input_tokens);
      const outputTokens = Number(row.output_tokens);
      const cost = Number(row.estimated_cost_usd);
      if (inputTokens < 0 || outputTokens < 0 || cost < 0) throw new Error("The imported budget ledger contains negative usage.");
      return sum + cost;
    }, 0);
    if (!Number.isFinite(importedSpend) || importedSpend > this.#config.budgetUsd) throw new Error("The imported budget ledger exceeds this installation's hard budget.");
    assertRelationalIntegrity(structured);
    const expected = expectedFiles(structured, manifest.includesAttachments);
    assertExactKeys(Object.keys(manifest.checksums), expected, "portable file set");

    const eventsBytes = files.get("data/events.jsonl");
    const readmeBytes = files.get("README.txt");
    if (!eventsBytes || new TextDecoder().decode(eventsBytes) !== eventsJsonl(structured)) throw new Error("The human-readable event export is inconsistent with structured data.");
    if (!readmeBytes || new TextDecoder().decode(readmeBytes) !== README_CONTENT) throw new Error("The bundle README is invalid.");
    for (const [path, markdown] of wikiFiles(structured)) {
      const bytes = files.get(path);
      if (!bytes || new TextDecoder().decode(bytes) !== markdown) throw new Error(`The wiki projection ${path} is inconsistent.`);
    }

    const expectedAttachmentFiles = new Set<string>();
    for (const attachment of attachmentRows(structured)) {
      const hash = String(attachment.content_hash);
      const path = `attachments/${hash}`;
      if (manifest.includesAttachments) {
        const bytes = files.get(path);
        if (!bytes || bytes.byteLength !== Number(attachment.size) || stableHash(bytes) !== hash) throw new Error(`Attachment ${attachment.id} failed content-address verification.`);
        expectedAttachmentFiles.add(path);
      }
    }
    const actualAttachmentFiles = [...files.keys()].filter((path) => path.startsWith("attachments/"));
    assertExactKeys(actualAttachmentFiles, expectedAttachmentFiles, "attachment file set");
    return { manifest, structured, files, archiveChecksum: stableHash(buffer) };
  }

  /**
   * Verifies a bundle from disk while expanding each member into a private
   * staging directory. Only individually bounded JSON/text members are read
   * into memory; attachment and archive bytes remain file-backed.
   */
  async verifyBundleFile(archivePath: string): Promise<VerifiedBundle> {
    const stagingParent = join(this.#config.dataDir, "import-staging");
    const staging = join(stagingParent, `verify-${uuidv7()}`);
    await mkdir(stagingParent, { recursive: true, mode: 0o700 });
    await chmod(stagingParent, 0o700);
    await mkdir(staging, { mode: 0o700 });
    const cleanup = async (): Promise<void> => { await rm(staging, { recursive: true, force: true }); };
    try {
      const archiveInfo = await lstat(archivePath);
      if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.size === 0 || archiveInfo.size > MAX_ARCHIVE_BYTES) throw new Error("The import bundle exceeds the 6 GiB compressed safety limit.");
      const { entries: centralEntries, centralOffset } = await readCentralDirectoryFile(archivePath);
      if (centralEntries.some((entry) => entry.directory)) throw new Error("Directory entries are not permitted in portable bundles.");
      const manifestCentral = centralEntries.find((entry) => entry.name === "manifest.json");
      if (!manifestCentral || manifestCentral.uncompressedSize > MAX_MANIFEST_BYTES) throw new Error("The bundle has no bounded manifest.");
      const totalExpanded = centralEntries.reduce((sum, entry) => sum + entry.uncompressedSize, 0);
      if (totalExpanded > MAX_EXPANDED_BYTES + MAX_MANIFEST_BYTES) throw new Error("The bundle exceeds the aggregate expanded-size limit.");
      const streamedTableBytes = centralEntries
        .filter((entry) => entry.name.startsWith("data/tables/"))
        .reduce((sum, entry) => sum + entry.uncompressedSize, 0);
      // Expansion and the file-backed SQLite database coexist until the
      // import finishes. FTS/index pages can exceed raw JSONL size, so reserve
      // three additional metadata copies plus a fixed recovery margin.
      await requireImportFreeSpace(
        stagingParent,
        totalExpanded + streamedTableBytes * 3 + MIN_IMPORT_FREE_SPACE_BYTES
      );

      const manifestFile = await extractZipEntry(archivePath, manifestCentral, centralOffset, join(staging, "entry-manifest"));
      const manifest = BundleManifestSchema.parse(JSON.parse(await readFile(manifestFile.path, "utf8")) as unknown);
      assertManifestVersionLayout(manifest);
      if (manifest.schemaVersion !== this.#database.health().schemaVersion) throw new Error("This bundle uses a different database schema version.");
      assertExactKeys(Object.keys(manifest.checksums), Object.keys(manifest.sizes), "checksum and size entries");
      assertExactKeys(centralEntries.map((entry) => entry.name), ["manifest.json", ...Object.keys(manifest.checksums)], "ZIP entries");
      const manifestExpanded = Object.values(manifest.sizes).reduce((sum, size) => sum + size, 0);
      if (manifestExpanded !== manifest.expandedBytes || manifestExpanded > MAX_EXPANDED_BYTES) throw new Error("The bundle expanded-size declaration is incorrect.");

      const centralByName = new Map(centralEntries.map((entry) => [entry.name, entry]));
      const files = new Map<string, Uint8Array | VerifiedFile>();
      let fileIndex = 0;
      for (const [path, checksum] of Object.entries(manifest.checksums)) {
        assertSafeArchivePath(path);
        const central = centralByName.get(path);
        if (!central || central.uncompressedSize !== manifest.sizes[path]) throw new Error(`The bundle size metadata for ${path} is inconsistent.`);
        const extracted = await extractZipEntry(archivePath, central, centralOffset, join(staging, `entry-${fileIndex++}`));
        if (extracted.size !== manifest.sizes[path] || extracted.checksum !== checksum) throw new Error(`Checksum or size verification failed for ${path}.`);
        files.set(path, extracted);
      }

      if (manifest.version === 2) {
        const bundle: VerifiedBundle = { manifest, files, archiveChecksum: await hashFile(archivePath) };
        const scratch = await loadStreamedStructuredDatabase(
          this.#database,
          bundle,
          this.#config.budgetUsd,
          join(staging, "structured-validation.sqlite3")
        );
        bundle.portableDatabase = scratch;
        bundle.cleanup = async () => { scratch.close(); await cleanup(); };
        try {
          assertExactKeys(Object.keys(manifest.checksums), expectedStreamedFiles(bundle), "portable file set");
          if (await verifiedText(bundle, "README.txt") !== README_CONTENT) throw new Error("The bundle README is invalid.");
          for (const [path, markdown] of wikiEntriesFromBundle(bundle)) if (await verifiedText(bundle, path) !== markdown) throw new Error(`The wiki projection ${path} is inconsistent.`);
          const actualEvents = jsonlRecords(bundle, manifest.eventShards ?? [])[Symbol.asyncIterator]();
          const privacy = exportPrivacy(scratch, true);
          for (const expected of exportedEventProjectionRows(scratch, true, privacy)) {
            const actual = await actualEvents.next();
            if (actual.done || JSON.stringify(actual.value) !== JSON.stringify(expected)) throw new Error("The human-readable event export is inconsistent with structured data.");
          }
          if (!(await actualEvents.next()).done) throw new Error("The human-readable event export has unexpected records.");
          for (const attachment of portableRows(bundle, "attachments")) {
            const hash = String(attachment.content_hash);
            if (!manifest.includesAttachments) continue;
            const file = files.get(`attachments/${hash}`);
            if (!file || file instanceof Uint8Array || file.size !== Number(attachment.size) || file.checksum !== hash) throw new Error(`Attachment ${attachment.id} failed content-address verification.`);
          }
          return bundle;
        } catch (error) {
          await bundle.cleanup?.();
          throw error;
        }
      }

      const structuredText = await verifiedText({ manifest, structured: {} as StructuredData, files, archiveChecksum: "" }, "data/structured.json");
      if (structuredText === undefined) throw new Error("The bundle has no structured data.");
      let rawStructured: unknown;
      try { rawStructured = JSON.parse(structuredText) as unknown; }
      catch { throw new Error("The bundle structured data is not valid UTF-8 JSON."); }
      const structured = validateStructuredData(this.#database, rawStructured, manifest);
      const importedSpend = structured.budget_ledger.reduce((sum, row) => {
        const inputTokens = Number(row.input_tokens);
        const outputTokens = Number(row.output_tokens);
        const cost = Number(row.estimated_cost_usd);
        if (inputTokens < 0 || outputTokens < 0 || cost < 0) throw new Error("The imported budget ledger contains negative usage.");
        return sum + cost;
      }, 0);
      if (!Number.isFinite(importedSpend) || importedSpend > this.#config.budgetUsd) throw new Error("The imported budget ledger exceeds this installation's hard budget.");
      assertRelationalIntegrity(structured);
      assertExactKeys(Object.keys(manifest.checksums), expectedFiles(structured, manifest.includesAttachments), "portable file set");

      const bundle: VerifiedBundle = { manifest, structured, files, archiveChecksum: await hashFile(archivePath), cleanup };
      if (await verifiedText(bundle, "data/events.jsonl") !== eventsJsonl(structured)) throw new Error("The human-readable event export is inconsistent with structured data.");
      if (await verifiedText(bundle, "README.txt") !== README_CONTENT) throw new Error("The bundle README is invalid.");
      for (const [path, markdown] of wikiFiles(structured)) if (await verifiedText(bundle, path) !== markdown) throw new Error(`The wiki projection ${path} is inconsistent.`);

      const expectedAttachmentFiles = new Set<string>();
      for (const attachment of attachmentRows(structured)) {
        const hash = String(attachment.content_hash);
        const path = `attachments/${hash}`;
        if (manifest.includesAttachments) {
          const file = files.get(path);
          if (!file || file instanceof Uint8Array || file.size !== Number(attachment.size) || file.checksum !== hash) throw new Error(`Attachment ${attachment.id} failed content-address verification.`);
          expectedAttachmentFiles.add(path);
        }
      }
      assertExactKeys([...files.keys()].filter((path) => path.startsWith("attachments/")), expectedAttachmentFiles, "attachment file set");
      return bundle;
    } catch (error) {
      await cleanup();
      throw error;
    }
  }

  async importBundle(buffer: Buffer, mode: ImportMode): Promise<Record<string, unknown>> {
    const verified = await this.verifyBundle(buffer);
    try { return await this.#importVerified(verified, mode, buffer.byteLength, (destination) => writeDurableFile(destination, buffer)); }
    finally { await verified.cleanup?.(); }
  }

  async importBundleFile(archivePath: string, mode: ImportMode): Promise<Record<string, unknown>> {
    let verified: VerifiedBundle;
    try { verified = await this.verifyBundleFile(archivePath); }
    catch (error) {
      if (error instanceof VaultImportStorageError) throw error;
      throw new VaultBundleValidationError(error);
    }
    try {
      const info = await stat(archivePath);
      return await this.#importVerified(verified, mode, info.size, (destination) => copyDurableFile(archivePath, destination, info.size, verified.archiveChecksum));
    } finally {
      await verified.cleanup?.();
    }
  }

  async #requiredImportMutationBytes(verified: VerifiedBundle, archiveSize: number): Promise<number> {
    const databaseBytes = await this.#physicalDatabaseBytes();
    const currentAttachmentBytes = this.#uniqueAttachmentBytes();
    const incomingHashes = new Set<string>();
    let incomingAttachmentBytes = 0;
    if (verified.manifest.includesAttachments) {
      for (const row of portableRows(verified, "attachments")) {
        const hash = String(row.content_hash);
        if (incomingHashes.has(hash)) continue;
        incomingHashes.add(hash);
        incomingAttachmentBytes += Number(row.size);
      }
    }
    // The pre-import safety backup needs a SQLite snapshot, streamed metadata
    // staging, and its final archive. The durable journal then coexists with
    // restored CAS bytes until commit. Existing upload/extraction files are
    // already reflected in statfs's available-byte figure.
    return databaseBytes * 3
      + currentAttachmentBytes
      + archiveSize
      + incomingAttachmentBytes
      + MIN_IMPORT_FREE_SPACE_BYTES;
  }

  async #importVerified(
    verified: VerifiedBundle,
    mode: ImportMode,
    archiveSize: number,
    persistArchive: (destination: string) => Promise<void>
  ): Promise<Record<string, unknown>> {
    if (mode === "verify") return { valid: true, manifest: verified.manifest };
    if (mode !== "replace" && mode !== "fresh") throw new Error("Unsupported import mode.");

    const maintenanceWasLocked = this.#database.getSetting("maintenance.locked", false);
    this.#database.setSetting("maintenance.locked", true);
    try {
      const activeWork = this.#database.connection.prepare(`
        SELECT
          (SELECT COUNT(*) FROM runs WHERE status IN ('pending','retrieving','streaming')) +
          (SELECT COUNT(*) FROM jobs WHERE status = 'running') AS count
      `).get() as { count: number };
      if (activeWork.count > 0) throw new Error("Import requires all active runs and worker jobs to be drained first.");
      await requireImportFreeSpace(this.#config.dataDir, await this.#requiredImportMutationBytes(verified, archiveSize));
      this.#database.reconcileOutstandingBudgetReservations("vault_import");
      this.#database.scrubInstallationBudgetMetadata();
      await this.#queueBackup("manual", true);

      const operationId = uuidv7();
      const journalDirectory = join(this.#config.dataDir, "import-journal");
      const archiveFilename = safeImportArchiveName(`continuum-import-${operationId}.zip`);
      const archivePath = join(journalDirectory, archiveFilename);
      await mkdir(journalDirectory, { recursive: true, mode: 0o700 });
      await persistArchive(archivePath);
      const timestamp = new Date().toISOString();
      try {
        this.#database.connection.prepare(`
          INSERT INTO import_operations(id, mode, archive_checksum, archive_filename, phase, payload_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'prepared', ?, ?, ?)
        `).run(operationId, mode, verified.archiveChecksum, archiveFilename, JSON.stringify({ oldHashes: [], newlyCreatedHashes: [], retainedHashes: [] }), timestamp, timestamp);
      } catch (error) {
        await unlinkDurablyIfExists(archivePath, this.#syncDirectory);
        throw error;
      }

      const store = new FileSystemContentAddressedStore(this.#config.attachmentsDir);
      await store.initialize();
      const oldHashes = [...new Set((this.#database.connection.prepare("SELECT content_hash FROM attachments").all() as Array<{ content_hash: string }>).map((row) => row.content_hash).filter((hash) => SHA256_PATTERN.test(hash)))];
      const importedPaths = new Map<string, string>();
      const newlyCreatedHashes = new Set<string>();
      const retainedHashes = new Set<string>(verified.manifest.includesAttachments
        ? [...portableRows(verified, "attachments")].map((row) => String(row.content_hash))
        : []);
      const chunkSourceIds = new Set(sourceChunkSourceIds(verified));
      for (const hash of retainedHashes) if (!(await store.has(hash))) newlyCreatedHashes.add(hash);
      const journalPayload: ImportJournalPayload = {
        oldHashes,
        newlyCreatedHashes: [...newlyCreatedHashes],
        retainedHashes: [...retainedHashes]
      };
      this.#database.connection.prepare("UPDATE import_operations SET payload_json = ?, updated_at = ? WHERE id = ?").run(
        JSON.stringify(journalPayload), new Date().toISOString(), operationId
      );
      let databaseComplete = false;
      try {
        for (const hash of retainedHashes) {
          const bytes = await verifiedBytes(verified, `attachments/${hash}`);
          if (!bytes) throw new Error(`Attachment ${hash} is missing from the verified import.`);
          const stored = await store.put(bytes);
          importedPaths.set(hash, join(this.#config.attachmentsDir, stored.storageKey));
        }

        const tablesToImport = PORTABLE_TABLES.filter((table) => mode === "replace" || FRESH_TABLES.has(table));
        this.#database.connection.transaction(() => {
          this.#database.connection.pragma("defer_foreign_keys = ON");
          for (const table of [...RESET_TABLES].reverse()) this.#database.connection.prepare(`DELETE FROM "${table}"`).run();
          for (const fts of ["event_fts", "chunk_fts", "claim_fts", "topic_fts", "topic_revision_fts"]) this.#database.connection.prepare(`DELETE FROM "${fts}"`).run();

          for (const table of tablesToImport) {
            const columns = tableColumns(this.#database, table);
            const names = columns.map((column) => column.name);
            const placeholders = names.map(() => "?").join(",");
            const statement = this.#database.connection.prepare(`INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(",")}) VALUES (${placeholders})`);
            for (const original of portableRows(verified, table)) {
              const row = sanitizeExportRow(table, original, verified.manifest.sensitiveToolOutputIncluded);
              if (table === "attachments") {
                const hash = String(row.content_hash);
                const restored = importedPaths.get(hash);
                row.storage_path = restored ?? "";
                if (!restored) {
                  row.status = "failed";
                  row.error_code = "ATTACHMENT_BYTES_NOT_EXPORTED";
                } else if (chunkSourceIds.has(String(row.source_id))) {
                  row.status = "ready";
                  row.error_code = null;
                } else {
                  row.status = "queued";
                  row.error_code = null;
                }
              }
              statement.run(...names.map((name) => row[name]));
            }
          }
          // Portable tables intentionally exclude derived compiler indexes.
          // Raw SQL insert triggers provide only lower/trim keys, so rebuild
          // the exact NFKC + collapsed-whitespace slot index before the vault
          // becomes available to post-turn reconciliation.
          this.#database.rebuildClaimSlotIndex();
          this.#database.rebuildTopicProjectionIndex();
          this.#database.setSetting("maintenance.locked", true);

          const importedAt = new Date().toISOString();
          const enqueue = (type: string, key: string, payload: Record<string, unknown>, priority: number, availableAt = importedAt): void => {
            this.#database.connection.prepare(`
              INSERT INTO jobs(id, type, idempotency_key, payload_json, status, priority, available_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)
            `).run(uuidv7(), type, key, JSON.stringify(payload), priority, availableAt, importedAt, importedAt);
          };
          const embeddingModel = this.#database.getSetting("models.embedding", this.#config.models.embedding);
          const sourceHashes = new Map(portableRows(verified, "sources").map((source) => [String(source.id), String(source.content_hash)]));
          for (const attachment of portableRows(verified, "attachments")) {
            const sourceId = String(attachment.source_id);
            const hasChunks = chunkSourceIds.has(sourceId);
            if (verified.manifest.includesAttachments && !hasChunks) {
              enqueue("source.extract", stableHash(`import:${verified.archiveChecksum}:extract:${attachment.id}`), {
                attachmentId: attachment.id,
                sourceId,
                mediaType: attachment.media_type,
                storagePath: importedPaths.get(String(attachment.content_hash))
              }, 20);
            }
          }
          const sourceIds = sourceChunkSourceIds(verified);
          for (const sourceId of sourceIds) {
            const contentHash = sourceHashes.get(sourceId);
            if (!contentHash) throw new Error(`Imported chunk source ${sourceId} has no content hash.`);
            enqueue(
              "embedding.index",
              stableHash(`import:${verified.archiveChecksum}:embedding:source:${sourceId}:${contentHash}:${embeddingModel}`),
              { sourceId, sourceType: "chunk", model: embeddingModel, sourceGenerationHash: contentHash },
              5
            );
          }
          if (mode === "replace") {
            for (const topicRow of portableRows(verified, "topic_pages")) {
              if (topicRow.lifecycle_status !== "active") continue;
              const topic = this.#database.getTopic(String(topicRow.id));
              if (!topic) throw new Error(`Imported active topic ${String(topicRow.id)} could not be read for embedding.`);
              const contentHash = stableHash(topic.markdown);
              enqueue(
                "embedding.index",
                stableHash(`import:${verified.archiveChecksum}:embedding:topic:${topic.id}:${topic.revision}:${contentHash}:${embeddingModel}`),
                { sourceId: topic.id, sourceType: "topic", model: embeddingModel, contentHash },
                3
              );
            }
            for (const eventRow of portableRows(verified, "events")) {
              if (eventRow.active !== 1 && eventRow.active !== true) continue;
              const event = this.#database.getEvent(String(eventRow.id));
              if (!event || event.status !== "complete") continue;
              const contentHash = stableHash(event.content);
              enqueue(
                "embedding.index",
                stableHash(`import:${verified.archiveChecksum}:embedding:event:${event.id}:${contentHash}:${embeddingModel}`),
                { sourceId: event.id, sourceType: "event", model: embeddingModel, contentHash },
                2
              );
            }
            for (const claimRow of portableRows(verified, "claims")) {
              if (claimRow.status !== "current" && claimRow.status !== "conflicted") continue;
              const claim = this.#database.getClaim(String(claimRow.id), false);
              if (!claim) continue;
              const contentHash = stableHash(`${claim.subject} ${claim.predicate}: ${claim.value}`);
              enqueue(
                "embedding.index",
                stableHash(`import:${verified.archiveChecksum}:embedding:claim:${claim.id}:${contentHash}:${embeddingModel}`),
                { sourceId: claim.id, sourceType: "claim", model: embeddingModel, contentHash },
                2
              );
            }
            const importedAtMs = Date.parse(importedAt);
            for (const claim of portableRows(verified, "claims")) {
              if (claim.status !== "current" && claim.status !== "conflicted") continue;
              const freshnessExpiresAt = typeof claim.freshness_expires_at === "string" ? claim.freshness_expires_at : null;
              const expiry = freshnessExpiresAt ? Date.parse(freshnessExpiresAt) : Number.NaN;
              if (!freshnessExpiresAt || !Number.isFinite(expiry)) continue;
              enqueue(
                "memory.expire",
                stableHash(`memory.expire:${claim.id}:${freshnessExpiresAt}`),
                { claimId: claim.id, freshnessExpiresAt },
                8,
                expiry <= importedAtMs ? importedAt : freshnessExpiresAt
              );
            }
          } else {
            const events = [...portableRows(verified, "events")].filter((row) =>
              row.status === "complete" &&
              (row.role === "user" || (row.role === "assistant" && (row.active === 1 || row.active === true)))
            );
            for (let offset = 0; offset < events.length; offset += 32) {
              const sourceEventIds = events.slice(offset, offset + 32).map((row) => String(row.id));
              if (sourceEventIds.length) enqueue("memory.compile", stableHash(`import:${verified.archiveChecksum}:memory:${offset / 32}`), { sourceEventIds, promptVersion: "memory-extraction-v1" }, 10);
            }
          }
          enqueue("memory.lint", stableHash(`import:${verified.archiveChecksum}:memory.lint`), { imported: true, mode }, 1);
          this.#database.connection.prepare("UPDATE import_operations SET phase = 'database_complete', updated_at = ? WHERE id = ?").run(importedAt, operationId);
        })();
        databaseComplete = true;
        await this.#finishImportOperation(operationId, verified);
      } catch (error) {
        if (!databaseComplete) {
          try {
            for (const hash of newlyCreatedHashes) await store.delete(hash);
            await unlinkDurablyIfExists(archivePath, this.#syncDirectory);
            this.#database.connection.prepare("UPDATE import_operations SET phase = 'failed', last_error_code = ?, updated_at = ? WHERE id = ?").run(
              error instanceof Error ? error.name : "IMPORT_FAILED", new Date().toISOString(), operationId
            );
          } catch (cleanupError) {
            this.#database.connection.prepare("UPDATE import_operations SET last_error_code = 'ROLLBACK_CLEANUP_PENDING', updated_at = ? WHERE id = ?").run(
              new Date().toISOString(), operationId
            );
            throw new Error("The failed import left cleanup work for startup recovery.", { cause: cleanupError });
          }
        }
        throw error;
      }
      return {
        valid: true,
        replaced: true,
        mode,
        manifest: verified.manifest,
        attachmentsRestored: retainedHashes.size,
        rebuildJobs: Number((this.#database.connection.prepare("SELECT COUNT(*) AS count FROM jobs").get() as { count: number }).count),
        warnings: []
      };
    } finally {
      this.#database.setSetting("maintenance.locked", maintenanceWasLocked);
    }
  }

  async resumeIncompleteImports(): Promise<{ resumed: number; abandoned: number }> {
    const maintenanceWasLocked = this.#database.getSetting("maintenance.locked", false);
    this.#database.setSetting("maintenance.locked", true);
    const journalDirectory = join(this.#config.dataDir, "import-journal");
    await mkdir(journalDirectory, { recursive: true, mode: 0o700 });
    let resumed = 0;
    let abandoned = 0;
    try {
      const operations = this.#database.connection.prepare(`
        SELECT * FROM import_operations WHERE phase IN ('prepared','database_complete','files_complete') ORDER BY created_at
      `).all() as ImportOperationRow[];
      for (const operation of operations) {
        if (operation.phase === "prepared") {
          const payload = ImportJournalPayloadSchema.parse(JSON.parse(operation.payload_json) as unknown);
          const store = new FileSystemContentAddressedStore(this.#config.attachmentsDir);
          await store.initialize();
          for (const hash of payload.newlyCreatedHashes) await store.delete(hash);
          await unlinkDurablyIfExists(this.#importArchivePath(operation.archive_filename), this.#syncDirectory);
          this.#database.connection.prepare(`
            UPDATE import_operations SET phase = 'failed', last_error_code = 'IMPORT_INTERRUPTED_BEFORE_COMMIT', updated_at = ? WHERE id = ?
          `).run(new Date().toISOString(), operation.id);
          abandoned += 1;
          continue;
        }
        await this.#finishImportOperation(operation.id);
        resumed += 1;
      }

      const referenced = new Set((this.#database.connection.prepare(`
        SELECT archive_filename FROM import_operations WHERE phase IN ('prepared','database_complete','files_complete')
      `).all() as Array<{ archive_filename: string }>).map((row) => row.archive_filename));
      for (const entry of await readdirIfExists(journalDirectory)) {
        if (/^continuum-import-[0-9a-f-]{36}\.zip$/.test(entry) && !referenced.has(entry)) {
          await unlinkDurablyIfExists(join(journalDirectory, entry), this.#syncDirectory);
        }
      }
      await this.#syncDirectory(journalDirectory);
      return { resumed, abandoned };
    } finally {
      this.#database.setSetting("maintenance.locked", maintenanceWasLocked);
    }
  }

  async #finishImportOperation(operationId: string, suppliedBundle?: VerifiedBundle): Promise<void> {
    let operation = this.#database.connection.prepare("SELECT * FROM import_operations WHERE id = ?").get(operationId) as ImportOperationRow | undefined;
    if (!operation) throw new Error("The import journal entry is missing.");
    const payload = ImportJournalPayloadSchema.parse(JSON.parse(operation.payload_json) as unknown);
    const archivePath = this.#importArchivePath(operation.archive_filename);
    if (operation.phase === "database_complete") {
      const verified = suppliedBundle ?? await this.verifyBundleFile(archivePath);
      try {
        if (verified.archiveChecksum !== operation.archive_checksum) throw new Error("The durable import archive failed checksum verification.");
        await this.#cleanupProjectionImportArtifacts();
        await this.#replaceProjectionFiles(verified, operation.mode);
        await this.#cleanupProjectionImportArtifacts();
        this.#database.connection.prepare("UPDATE import_operations SET phase = 'files_complete', updated_at = ? WHERE id = ?").run(new Date().toISOString(), operationId);
        operation = { ...operation, phase: "files_complete" };
      } finally {
        if (!suppliedBundle) await verified.cleanup?.();
      }
    }
    if (operation.phase === "files_complete") {
      const store = new FileSystemContentAddressedStore(this.#config.attachmentsDir);
      await store.initialize();
      const retained = new Set(payload.retainedHashes);
      for (const hash of payload.oldHashes) if (!retained.has(hash)) await store.delete(hash);
      await unlinkDurablyIfExists(archivePath, this.#syncDirectory);
      this.#database.connection.prepare(`
        UPDATE import_operations SET phase = 'complete', payload_json = '{}', last_error_code = NULL, updated_at = ? WHERE id = ?
      `).run(new Date().toISOString(), operationId);
    }
  }

  #importArchivePath(filename: string): string {
    return join(this.#config.dataDir, "import-journal", safeImportArchiveName(filename));
  }

  async #cleanupProjectionImportArtifacts(): Promise<void> {
    const parent = dirname(this.#config.projectionsDir);
    const name = basename(this.#config.projectionsDir);
    let entries: string[];
    try { entries = await readdir(parent); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    const pattern = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.(?:import|previous)-[0-9a-f-]{36}$`);
    const artifacts = entries.filter((entry) => pattern.test(entry));
    const previous = artifacts.filter((entry) => entry.startsWith(`${name}.previous-`));
    let liveProjectionExists = await pathExistsStrict(this.#config.projectionsDir);
    if (!liveProjectionExists && previous.length) {
      // A failed stage->live rename may itself have been followed by a failed
      // rollback rename. Preserve and restore the single last-good directory;
      // never delete it as if it were ordinary staging garbage.
      if (previous.length !== 1) throw new Error("Multiple prior projection directories require manual recovery before import can resume safely.");
      await renameDurably(join(parent, previous[0]!), this.#config.projectionsDir, this.#syncDirectory);
      liveProjectionExists = true;
    }
    for (const entry of artifacts) {
      const artifactPath = join(parent, entry);
      const isDisposableStage = entry.startsWith(`${name}.import-`);
      if ((isDisposableStage || liveProjectionExists) && await pathExistsStrict(artifactPath)) {
        await removeTreeDurably(artifactPath, this.#syncDirectory);
      }
    }
    // Also fence an artifact removal from an earlier attempt that returned
    // ENOENT on this retry after its original directory sync failed.
    await this.#syncDirectory(parent);
  }

  async #replaceProjectionFiles(verified: VerifiedBundle, mode: Exclude<ImportMode, "verify">): Promise<string[]> {
    const stage = `${this.#config.projectionsDir}.import-${uuidv7()}`;
    const previous = `${this.#config.projectionsDir}.previous-${uuidv7()}`;
    let preserveRecoveryArtifacts = false;
    await mkdir(stage, { recursive: false, mode: 0o700 });
    try {
      if (mode === "replace") {
        const topics = new Map([...portableRows(verified, "topic_pages")].map((row) => [String(row.id), String(row.slug)]));
        for (const [path, markdown] of wikiEntriesFromBundle(verified)) {
          const topicId = basename(path, ".md");
          const slug = topics.get(topicId);
          if (!slug) throw new Error(`Projection ${path} has no topic.`);
          await writeDurableFile(join(stage, `${topicId}-${slug}.md`), Buffer.from(markdown), this.#syncDirectory);
        }
      }
      let hadPrevious = false;
      try {
        await rename(this.#config.projectionsDir, previous);
        hadPrevious = true;
        await this.#syncDirectory(dirname(this.#config.projectionsDir));
      } catch (error) {
        if (hadPrevious) {
          preserveRecoveryArtifacts = true;
          throw error;
        }
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
      let stageInstalled = false;
      try {
        await rename(stage, this.#config.projectionsDir);
        stageInstalled = true;
        await this.#syncDirectory(dirname(this.#config.projectionsDir));
      } catch (error) {
        // A directory-sync failure after rename means the namespace transition
        // is uncertain across power loss. Keep both live/previous artifacts and
        // the database_complete journal for startup reconciliation; attempting
        // a blind rollback can overwrite the successfully installed tree.
        if (stageInstalled) {
          preserveRecoveryArtifacts = true;
          throw error;
        }
        if (hadPrevious) {
          try { await renameDurably(previous, this.#config.projectionsDir, this.#syncDirectory); }
          catch (restoreError) {
            preserveRecoveryArtifacts = true;
            throw new AggregateError([error, restoreError], "The imported projection directory could not be installed and the prior projection directory could not be restored. Recovery artifacts were retained.");
          }
        }
        throw error;
      }
      if (hadPrevious) await removeTreeDurably(previous, this.#syncDirectory);
      return [];
    } finally {
      if (!preserveRecoveryArtifacts) await removeTreeDurably(stage, this.#syncDirectory);
    }
  }

  async exportInfo(filename: string): Promise<{ size: number }> {
    const info = await stat(this.exportPath(filename));
    return { size: info.size };
  }
}
