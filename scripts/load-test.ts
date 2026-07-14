import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import { cpus, freemem, platform, arch, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { ContinuumDatabase } from "../packages/database/src/index.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
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

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1]! : fallback;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

function measureMany(iterations: number, operation: (index: number) => void): {
  medianMs: number;
  p95Ms: number;
  maximumMs: number;
} {
  for (let index = 0; index < 10; index += 1) operation(index);
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    operation(index);
    samples.push(performance.now() - started);
  }
  return {
    medianMs: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    maximumMs: Math.max(...samples)
  };
}

function timestamp(sequence: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString();
}

const quick = process.argv.includes("--quick");
const keepDatabase = process.argv.includes("--keep-db");
const outputPath = resolve(argument("--output", quick
  ? "artifacts/evaluation/load-quick.json"
  : "artifacts/evaluation/load-full.json"));
const eventCount = quick ? 10_000 : 100_000;
const topicCount = quick ? 1_000 : 10_000;
const attachmentLogicalBytes = quick ? 512 * MIB : 5 * GIB;
const checkpointCount = Math.min(10_000, eventCount);
const temporaryDirectory = await mkdtemp(join(tmpdir(), "continuum-load-"));
const databasePath = join(temporaryDirectory, "load.sqlite3");
const attachmentsDirectory = join(temporaryDirectory, "attachments");
await mkdir(attachmentsDirectory, { recursive: true, mode: 0o700 });

const database = ContinuumDatabase.open(databasePath);
const eventInsert = database.connection.prepare(`
  INSERT INTO events(id, sequence, role, kind, status, parent_event_id, run_id, active, created_at, completed_at)
  VALUES (?, ?, ?, 'message', 'complete', NULL, NULL, 1, ?, ?)
`);
const contentInsert = database.connection.prepare(`
  INSERT INTO event_content(id, event_id, ordinal, content_type, text_content, metadata_json)
  VALUES (?, ?, 0, 'text', ?, '{}')
`);
const insertEvents = database.connection.transaction((from: number, to: number) => {
  for (let sequence = from; sequence <= to; sequence += 1) {
    const id = `load-event-${String(sequence).padStart(6, "0")}`;
    const createdAt = timestamp(sequence);
    const marker = sequence % 997;
    const topic = sequence % 71;
    const content = `Load fixture message ${sequence}. Project marker${marker}. Topic family${topic}. This retained event is deterministic searchable evidence.`;
    eventInsert.run(id, sequence, sequence % 2 === 0 ? "assistant" : "user", createdAt, createdAt);
    contentInsert.run(`load-content-${String(sequence).padStart(6, "0")}`, id, content);
  }
});

const startedAt = new Date().toISOString();
const revision = await workspaceRevision();
const firstInsertStarted = performance.now();
insertEvents(1, checkpointCount);
const insert10kMs = performance.now() - firstInsertStarted;
const search10k = measureMany(100, (index) => {
  const results = database.search(`marker${(index * 37) % 997}`, 30);
  if (results.length === 0) throw new Error("10k search fixture unexpectedly returned no results");
});

let insertRemainingMs = 0;
if (eventCount > checkpointCount) {
  const remainingStarted = performance.now();
  insertEvents(checkpointCount + 1, eventCount);
  insertRemainingMs = performance.now() - remainingStarted;
}

const topicInsert = database.connection.prepare(`
  INSERT INTO topic_pages(id, core_type, slug, title, active_revision, scope_id, tags_json, lifecycle_status, created_at, updated_at)
  VALUES (?, 'project', ?, ?, 1, 'global', '[]', 'active', ?, ?)
`);
const revisionInsert = database.connection.prepare(`
  INSERT INTO topic_page_revisions(id, topic_id, revision_number, markdown, summary, current_state, history,
    open_questions_json, generation_inputs_json, author_type, prompt_version, created_at)
  VALUES (?, ?, 1, ?, ?, ?, '', '[]', '[]', 'system', 'load-fixture-v1', ?)
`);
const insertTopics = database.connection.transaction(() => {
  for (let index = 1; index <= topicCount; index += 1) {
    const id = `load-topic-${String(index).padStart(5, "0")}`;
    const createdAt = timestamp(eventCount + index);
    const title = `Load topic ${index} marker${index % 997}`;
    const summary = `Deterministic topic summary for family${index % 71}.`;
    const markdown = `# ${title}\n\n## Summary\n\n${summary}\n\n## Current state\n\nCurrent load-test topic ${index}.`;
    topicInsert.run(id, `load-topic-${index}`, title, createdAt, createdAt);
    revisionInsert.run(`load-revision-${String(index).padStart(5, "0")}`, id, markdown, summary, `Current load-test topic ${index}.`, createdAt);
  }
});
const topicStarted = performance.now();
insertTopics();
const insertTopicsMs = performance.now() - topicStarted;

const sourceInsert = database.connection.prepare(`
  INSERT INTO sources(id, type, title, uri, content_hash, provenance_json, freshness_class, created_at, retrieved_at)
  VALUES (?, 'attachment', ?, NULL, ?, ?, 'stable', ?, NULL)
`);
const attachmentInsert = database.connection.prepare(`
  INSERT INTO attachments(id, source_id, filename, media_type, size, storage_path, content_hash, status, error_code, created_at)
  VALUES (?, ?, ?, 'application/octet-stream', ?, ?, ?, 'ready', NULL, ?)
`);
const attachmentRows: Array<{
  index: number;
  size: number;
  path: string;
  hash: string;
}> = [];
let remainingAttachmentBytes = attachmentLogicalBytes;
let attachmentIndex = 1;
while (remainingAttachmentBytes > 0) {
  const size = Math.min(25 * MIB, remainingAttachmentBytes);
  const path = join(attachmentsDirectory, `load-${String(attachmentIndex).padStart(4, "0")}.bin`);
  const handle = await open(path, "w", 0o600);
  await handle.truncate(size);
  await handle.close();
  attachmentRows.push({
    index: attachmentIndex,
    size,
    path,
    hash: createHash("sha256").update(`continuum-sparse-load-${attachmentIndex}-${size}`).digest("hex")
  });
  remainingAttachmentBytes -= size;
  attachmentIndex += 1;
}
const attachmentStarted = performance.now();
database.connection.transaction(() => {
  for (const row of attachmentRows) {
    const sourceId = `load-source-${String(row.index).padStart(4, "0")}`;
    const attachmentId = `load-attachment-${String(row.index).padStart(4, "0")}`;
    const filename = `load-${String(row.index).padStart(4, "0")}.bin`;
    const createdAt = timestamp(eventCount + topicCount + row.index);
    sourceInsert.run(sourceId, filename, row.hash, JSON.stringify({
      fixture: true,
      sparse: true,
      contentHashVerified: false
    }), createdAt);
    attachmentInsert.run(attachmentId, sourceId, filename, row.size, row.path, row.hash, createdAt);
  }
})();
const insertAttachmentsMs = performance.now() - attachmentStarted;

const searchFinal = measureMany(250, (index) => {
  const results = database.search(`marker${(index * 53) % 997}`, 30);
  if (results.length === 0) throw new Error("final search fixture unexpectedly returned no results");
});
const timelinePage = measureMany(250, (index) => {
  const beforeSequence = eventCount - (index % Math.max(1, eventCount - 500));
  const events = database.listEvents({ beforeSequence, limit: 100 });
  if (events.length === 0) throw new Error("timeline page fixture unexpectedly returned no events");
});

database.checkpoint();
const health = database.refreshIntegrityCheck();
const pageCount = Number(database.connection.pragma("page_count", { simple: true }));
const pageSize = Number(database.connection.pragma("page_size", { simple: true }));
const databaseFile = await stat(databasePath);
let sparsePhysicalBytes: number | null = 0;
for (const row of attachmentRows) {
  const info = await stat(row.path);
  const blocks = (info as typeof info & { blocks?: number }).blocks;
  if (typeof blocks !== "number") {
    sparsePhysicalBytes = null;
    break;
  }
  sparsePhysicalBytes += blocks * 512;
}

const report = {
  evidenceClass: "local-load-measurement",
  profile: quick ? "quick" : "full",
  revision,
  startedAt,
  completedAt: new Date().toISOString(),
  liveApiCalls: 0,
  environment: {
    platform: platform(),
    architecture: arch(),
    node: process.version,
    cpuModel: cpus()[0]?.model ?? "unknown",
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtCompletion: freemem()
  },
  fixture: {
    events: eventCount,
    topics: topicCount,
    attachmentFiles: attachmentRows.length,
    attachmentLogicalBytes,
    attachmentLogicalGiB: attachmentLogicalBytes / GIB,
    attachmentRepresentation: "sparse files plus real source/attachment metadata; no parsing or content-hash verification"
  },
  measurements: {
    insertFirst10kEventsMs: insert10kMs,
    insertRemainingEventsMs: insertRemainingMs,
    insertTopicsMs,
    insertAttachmentMetadataMs: insertAttachmentsMs,
    searchAt10k: search10k,
    searchAtFinalSize: searchFinal,
    timelinePageAtFinalSize: timelinePage,
    databaseLogicalBytes: pageCount * pageSize,
    databaseFileBytes: databaseFile.size,
    sparseAttachmentPhysicalBytes: sparsePhysicalBytes,
    processResidentBytesAtCompletion: process.memoryUsage().rss
  },
  gates: {
    searchP95Below500Ms: searchFinal.p95Ms < 500,
    databaseIntegrityOk: health.integrity === "ok"
  },
  database: health,
  limitations: [
    "This is local storage/search evidence, not a model-quality benchmark.",
    "Attachments are sparse logical files with metadata; extraction, OCR, hashing throughput, and five GiB of allocated physical disk are not measured.",
    "Bulk fixture insertion uses transactions and does not represent interactive per-turn ingestion latency.",
    "Results are machine-specific and must be regenerated on the release machine and macOS CI."
  ],
  retainedDatabasePath: keepDatabase ? databasePath : null
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8" });
database.close();
if (!keepDatabase) await rm(temporaryDirectory, { recursive: true, force: true });

process.stdout.write(`${JSON.stringify({
  output: outputPath,
  profile: report.profile,
  events: eventCount,
  topics: topicCount,
  attachmentLogicalGiB: report.fixture.attachmentLogicalGiB,
  searchP95Ms: searchFinal.p95Ms,
  searchGatePassed: report.gates.searchP95Below500Ms,
  liveApiCalls: 0
}, null, 2)}\n`);
