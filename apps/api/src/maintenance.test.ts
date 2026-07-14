import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { loadConfig, stableHash, type AppConfig } from "@continuum/config";
import { ContinuumDatabase, uuidv7 } from "@continuum/database";
import { FileSystemContentAddressedStore } from "@continuum/ingestion";
import { buildApp } from "./app.js";
import { VaultMaintenance } from "./maintenance.js";
import { LocalToolRuntime } from "./tool-runtime.js";

type Fixture = {
  root: string;
  config: AppConfig;
  database: ContinuumDatabase;
  maintenance: VaultMaintenance;
  store: FileSystemContentAddressedStore;
  closed: boolean;
};

const fixtures: Fixture[] = [];

async function fixture(label: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `continuum-${label}-`));
  const config = loadConfig({
    NODE_ENV: "test",
    CONTINUUM_DATA_DIR: root,
    CONTINUUM_SESSION_TOKEN: "test-session-token-that-is-at-least-32-characters"
  });
  const database = ContinuumDatabase.open(config);
  const store = new FileSystemContentAddressedStore(config.attachmentsDir);
  await store.initialize();
  const value = { root, config, database, maintenance: new VaultMaintenance(database, config), store, closed: false };
  fixtures.push(value);
  return value;
}

async function addAttachment(value: Fixture, bytes: Uint8Array, filename = "private.txt"): Promise<{ attachmentId: string; sourceId: string; hash: string }> {
  const stored = await value.store.put(bytes);
  const sourceId = value.database.createSource({
    type: "attachment",
    title: "Private attachment",
    uri: "/Users/alice/Documents/private.txt",
    contentHash: stored.sha256,
    provenance: { cwd: "/Users/alice/Documents", parser: "test", apiKey: "sk-test-secret-value-that-must-never-export" }
  });
  const attachment = value.database.createAttachment({
    sourceId,
    filename,
    mediaType: "text/plain",
    size: bytes.byteLength,
    storagePath: join(value.config.attachmentsDir, stored.storageKey),
    contentHash: stored.sha256,
    status: "ready"
  });
  return { attachmentId: attachment.id, sourceId, hash: stored.sha256 };
}

async function exportBytes(value: Fixture, includeAttachments = true, includeSensitiveToolOutput = false): Promise<Buffer> {
  const result = await value.maintenance.exportBundle({ includeAttachments, includeSensitiveToolOutput });
  return readFile(value.maintenance.exportPath(result.filename));
}

function overrideCentralExpandedSize(archive: Buffer, filename: string, size: number): Buffer {
  const mutated = Buffer.from(archive);
  for (let offset = 0; offset + 46 < mutated.length; offset += 1) {
    if (mutated.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = mutated.readUInt16LE(offset + 28);
    const name = mutated.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name !== filename) continue;
    mutated.writeUInt32LE(size, offset + 24);
    return mutated;
  }
  throw new Error(`Central entry ${filename} was not found.`);
}

function multipartBundle(content: Buffer, mode: "verify" | "replace" | "fresh"): { boundary: string; body: Buffer } {
  const boundary = `continuum-${uuidv7()}`;
  return {
    boundary,
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="mode"\r\n\r\n${mode}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="continuum-large.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ])
  };
}

async function structuredFromZip(zip: JSZip): Promise<Record<string, Array<Record<string, unknown>>>> {
  const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")) as { tableShards?: Record<string, string[]> };
  const structured: Record<string, Array<Record<string, unknown>>> = {};
  for (const [table, paths] of Object.entries(manifest.tableShards ?? {})) {
    structured[table] = [];
    for (const path of paths) {
      const text = await zip.file(path)!.async("string");
      structured[table]!.push(...text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>));
    }
  }
  return structured;
}

afterEach(async () => {
  while (fixtures.length) {
    const value = fixtures.pop()!;
    if (!value.closed) value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

describe("VaultMaintenance portable bundles", () => {
  it("shards and round-trips metadata beyond one 32 MiB entry without whole-archive buffering", async () => {
    const source = await fixture("streaming-metadata-source");
    const insert = source.database.connection.transaction(() => {
      for (let index = 0; index < 170; index += 1) source.database.appendEvent({ role: "user", content: `metadata-${index}-${"x".repeat(199_980)}` });
    });
    insert();
    const exported = await source.maintenance.exportBundle({ includeAttachments: false, includeSensitiveToolOutput: false });
    const archivePath = source.maintenance.exportPath(exported.filename);
    expect(exported.size).toBeGreaterThan(64 * 1024 * 1024);
    const verified = await source.maintenance.verifyBundleFile(archivePath);
    expect(verified.manifest.tableShards?.event_content?.length).toBeGreaterThan(1);
    expect(verified.manifest.eventShards?.length).toBeGreaterThan(1);
    expect(verified.portableDatabase?.path).not.toBe(":memory:");
    expect(verified.portableDatabase?.path.startsWith(join(source.config.dataDir, "import-staging"))).toBe(true);
    await verified.cleanup?.();

    const target = await fixture("streaming-metadata-target");
    await target.maintenance.importBundleFile(archivePath, "replace");
    const events = target.database.listEvents({ limit: 200 });
    expect(events).toHaveLength(170);
    expect(events.find((event) => event.sequence === 170)?.content).toContain("metadata-169-");
  }, 120_000);

  it("removes real local-tool output and every solely derived memory projection unless explicitly included", async () => {
    const value = await fixture("tool-output-privacy");
    const secret = "TOOL-ONLY-SECRET-CANARY-7f441dc1";
    const workspace = join(value.root, "workspace");
    await mkdir(workspace, { mode: 0o700 });
    await writeFile(join(workspace, "notes.txt"), secret, { mode: 0o600 });
    const rootId = value.database.authorizeWorkspace(await realpath(workspace), "Private fixture");
    const parent = value.database.appendEvent({ role: "user", content: "Read the project file notes.txt." });
    const run = value.database.createRun(parent.id, "balanced");
    const output = await new LocalToolRuntime(value.database, parent.content).execute(
      { callId: "portable-secret-tool", name: "workspace_read", arguments: { rootId, path: "notes.txt" } },
      run.id,
      parent.id,
      new AbortController().signal,
      { started: () => undefined, completed: () => undefined }
    );
    expect(output).toContain(secret);
    const toolEvent = value.database.connection.prepare("SELECT id FROM events WHERE role = 'tool' AND kind = 'tool_result' ORDER BY sequence DESC LIMIT 1").get() as { id: string };
    const topic = value.database.upsertTopicRevision({
      type: "concept", title: secret, slug: "tool-secret", markdown: `# ${secret}\n`, summary: secret,
      currentState: secret, history: "", sourceIds: [toolEvent.id], promptVersion: "privacy-test-v1"
    });
    const claim = value.database.upsertClaim({
      topicId: topic.id, subject: "Tool", predicate: "revealed", value: secret, confidence: 1, status: "current",
      sourceRole: "tool", sourceIds: [toolEvent.id], validFrom: null, validTo: null, observedAt: new Date().toISOString(), freshnessExpiresAt: null
    });
    const entityId = uuidv7();
    value.database.connection.prepare("INSERT INTO entities(id, core_type, display_name, normalized_name, status, canonical_description, created_at, updated_at) VALUES (?, 'concept', ?, ?, 'active', ?, ?, ?)")
      .run(entityId, secret, secret.toLocaleLowerCase(), secret, new Date().toISOString(), new Date().toISOString());
    value.database.connection.prepare("INSERT INTO entity_aliases(id, entity_id, alias, normalized_alias, confidence, source_id, active, created_at) VALUES (?, ?, ?, ?, 1, ?, 1, ?)")
      .run(uuidv7(), entityId, secret, secret.toLocaleLowerCase(), toolEvent.id, new Date().toISOString());
    expect(claim.sourceIds).toContain(toolEvent.id);

    const redacted = await exportBytes(value, true, false);
    const redactedZip = await JSZip.loadAsync(redacted);
    for (const entry of Object.values(redactedZip.files)) {
      if (!entry.dir) expect((await entry.async("nodebuffer")).includes(Buffer.from(secret))).toBe(false);
    }
    const structured = await structuredFromZip(redactedZip);
    expect(structured.event_content?.filter((row) => row.event_id === toolEvent.id).every((row) => row.text_content === "[excluded from export]")).toBe(true);
    expect(structured.claims?.some((row) => row.id === claim.id)).toBe(false);
    expect(structured.topic_pages?.some((row) => row.id === topic.id)).toBe(false);
    expect(structured.entities?.some((row) => row.id === entityId)).toBe(false);

    const explicit = await exportBytes(value, true, true);
    expect(explicit.includes(Buffer.from(secret))).toBe(true);
  });

  it("streams a portable bundle larger than 50 MiB through export, download, and import", async () => {
    const source = await fixture("streaming-large-source");
    const first = await addAttachment(source, Buffer.alloc(25 * 1024 * 1024, 0x41), "large-a.txt");
    const second = await addAttachment(source, Buffer.alloc(25 * 1024 * 1024, 0x42), "large-b.txt");
    source.database.appendEvent({ role: "user", content: "large portable canary", attachmentIds: [first.attachmentId, second.attachmentId] });
    const sourceApp = await buildApp({ config: source.config, database: source.database });
    try {
      const exportedResponse = await sourceApp.app.inject({
        method: "POST",
        url: "/api/v1/export",
        headers: {
          authorization: `Bearer ${source.config.sessionToken}`,
          host: "127.0.0.1",
          "x-continuum-request": "1",
          "content-type": "application/json"
        },
        payload: { includeAttachments: true, includeSensitiveToolOutput: false, idempotencyKey: uuidv7() }
      });
      expect(exportedResponse.statusCode).toBe(200);
      const exported = exportedResponse.json<{ downloadUrl: string; checksum: string; size: number }>();
      expect(exported.size).toBeGreaterThan(50 * 1024 * 1024);

      const download = await sourceApp.app.inject({
        method: "GET",
        url: exported.downloadUrl,
        headers: { authorization: `Bearer ${source.config.sessionToken}`, host: "127.0.0.1" }
      });
      expect(download.statusCode).toBe(200);
      expect(download.headers["content-length"]).toBe(String(exported.size));
      expect(stableHash(download.rawPayload)).toBe(exported.checksum);

      const target = await fixture("streaming-large-target");
      const targetApp = await buildApp({ config: target.config, database: target.database });
      try {
        const upload = multipartBundle(download.rawPayload, "verify");
        const verified = await targetApp.app.inject({
          method: "POST",
          url: "/api/v1/import",
          headers: {
            authorization: `Bearer ${target.config.sessionToken}`,
            host: "127.0.0.1",
            "x-continuum-request": "1",
            "idempotency-key": uuidv7(),
            "content-type": `multipart/form-data; boundary=${upload.boundary}`
          },
          payload: upload.body
        });
        expect(verified.statusCode, verified.body).toBe(200);
        const verification = verified.json<{ verificationToken: string; archiveChecksum: string }>();
        expect(verification).toMatchObject({ verificationToken: expect.any(String), archiveChecksum: exported.checksum });
        const imported = await targetApp.app.inject({
          method: "POST",
          url: "/api/v1/import/commit",
          headers: {
            authorization: `Bearer ${target.config.sessionToken}`,
            host: "127.0.0.1",
            "x-continuum-request": "1",
            "content-type": "application/json"
          },
          payload: { verificationToken: verification.verificationToken, mode: "replace", idempotencyKey: uuidv7() }
        });
        expect(imported.statusCode, imported.body).toBe(200);
        expect(imported.json()).toMatchObject({ valid: true, replaced: true, attachmentsRestored: 2 });
        expect(target.database.listEvents({ limit: 10 }).map((event) => event.content)).toEqual(["large portable canary"]);
        await expect(target.store.has(first.hash)).resolves.toBe(true);
        await expect(target.store.has(second.hash)).resolves.toBe(true);
        expect((await readdir(join(target.config.dataDir, "import-staging"))).filter((entry) => entry.startsWith("upload-") || entry.startsWith("verify-"))).toEqual([]);
        expect(await readdir(join(target.config.dataDir, "verified-imports"))).toEqual([]);
      } finally {
        await targetApp.app.close();
        target.closed = true;
      }
    } finally {
      await sourceApp.app.close();
      source.closed = true;
    }
  }, 120_000);

  it("retains a staged verified import across a retryable ENOSPC commit and consumes it after success", async () => {
    const source = await fixture("verified-import-retry-source");
    source.database.appendEvent({ role: "user", content: "verified retry canary" });
    const archive = await exportBytes(source, false, false);
    const target = await fixture("verified-import-retry-target");
    const uploadPath = join(target.root, "verified-retry.zip");
    await writeFile(uploadPath, archive);
    const staged = await target.maintenance.stageVerifiedImportFile(uploadPath) as { verificationToken: string };
    const connection = target.database.connection as unknown as { backup: (path: string) => Promise<unknown> };
    const originalBackup = connection.backup.bind(connection);
    connection.backup = async () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); };
    await expect(target.maintenance.importVerifiedToken(staged.verificationToken, "replace")).rejects.toMatchObject({ code: "ENOSPC" });
    expect((await readdir(join(target.config.dataDir, "verified-imports"))).sort()).toEqual([
      `${staged.verificationToken}.json`,
      `${staged.verificationToken}.zip`
    ]);

    connection.backup = originalBackup;
    await expect(target.maintenance.importVerifiedToken(staged.verificationToken, "replace")).resolves.toMatchObject({ valid: true, replaced: true });
    expect(await readdir(join(target.config.dataDir, "verified-imports"))).toEqual([]);
  });

  it("excludes inactive assistant revisions from fresh-import memory compilation batches", async () => {
    const source = await fixture("fresh-active-revisions-source");
    const user = source.database.appendEvent({ role: "user", content: "Which revision is current?" });
    const current = source.database.appendEvent({ role: "assistant", content: "Current answer", parentEventId: user.id, active: true });
    const inactive = source.database.appendEvent({ role: "assistant", content: "Superseded answer", parentEventId: user.id, active: false });
    const archive = await exportBytes(source, false, false);
    const target = await fixture("fresh-active-revisions-target");
    const uploadPath = join(target.root, "fresh-revisions.zip");
    await writeFile(uploadPath, archive);
    const staged = await target.maintenance.stageVerifiedImportFile(uploadPath) as { verificationToken: string };
    await target.maintenance.importVerifiedToken(staged.verificationToken, "fresh");

    const compileIds = target.database.listJobsByTypePrefix("memory.compile")
      .flatMap((job) => Array.isArray(job.payload.sourceEventIds) ? job.payload.sourceEventIds.map(String) : []);
    expect(compileIds).toEqual(expect.arrayContaining([user.id, current.id]));
    expect(compileIds).not.toContain(inactive.id);
  });

  it("recreates durable freshness-expiry jobs when replacing a vault", async () => {
    const source = await fixture("replace-freshness-source");
    const event = source.database.appendEvent({ role: "user", content: "My certification expires in 2099." });
    const topic = source.database.upsertTopicRevision({
      type: "concept",
      title: "Certification",
      slug: "certification",
      markdown: "# Certification\n\nExpiry-backed memory.",
      summary: "Expiry-backed memory.",
      currentState: "Current until expiry.",
      history: "",
      sourceIds: [event.id],
      promptVersion: "test-v1"
    });
    const freshnessExpiresAt = "2099-03-04T05:06:07.000Z";
    const claim = source.database.upsertClaim({
      topicId: topic.id,
      subject: "User certification",
      predicate: "is valid",
      value: true,
      confidence: 1,
      status: "current",
      sourceRole: "user",
      sourceIds: [event.id],
      validFrom: event.createdAt,
      validTo: null,
      observedAt: event.createdAt,
      freshnessExpiresAt
    });
    const archive = await exportBytes(source, false, false);
    const target = await fixture("replace-freshness-target");
    const uploadPath = join(target.root, "replace-freshness.zip");
    await writeFile(uploadPath, archive);
    const staged = await target.maintenance.stageVerifiedImportFile(uploadPath) as { verificationToken: string };
    await target.maintenance.importVerifiedToken(staged.verificationToken, "replace");

    const expiryJobs = target.database.connection.prepare(`
      SELECT payload_json, priority, available_at FROM jobs WHERE type = 'memory.expire'
    `).all() as Array<{ payload_json: string; priority: number; available_at: string }>;
    expect(expiryJobs).toHaveLength(1);
    expect(JSON.parse(expiryJobs[0]!.payload_json)).toEqual({ claimId: claim.id, freshnessExpiresAt });
    expect(expiryJobs[0]).toMatchObject({ priority: 8, available_at: freshnessExpiresAt });
  });

  it("exports content without machine capabilities, local paths, or sensitive tool output", async () => {
    const value = await fixture("export");
    const attachment = await addAttachment(value, Buffer.from("attachment canary"), "C:\\Users\\alice\\private.txt");
    value.database.addSourceChunks(attachment.sourceId, [{ text: "attachment canary", location: { path: "/Users/alice/private.txt", page: 1 } }]);
    const event = value.database.appendEvent({ role: "user", content: "Remember the canary", attachmentIds: [attachment.attachmentId] });
    const run = value.database.createRun(event.id, "balanced");
    value.database.connection.prepare("UPDATE runs SET status = 'complete', completed_at = ? WHERE id = ?").run(new Date().toISOString(), run.id);
    value.database.authorizeWorkspace("/Users/alice/secret-project", "Secret project");
    value.database.enqueueJob("malicious.imported", "must-not-export", { path: "/Users/alice/secret-project" });
    const budgetReservation = value.database.reserveBudget(100, 0.01, "response", run.id);
    value.database.recordModelCall({
      runId: run.id,
      provider: "openai",
      model: "gpt-5.6-luna",
      purpose: "response",
      promptVersion: "export-exclusion-test",
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
      status: "complete",
      estimatedCostUsd: 0.01,
      reservationId: budgetReservation
    });
    value.database.connection.prepare(`
      INSERT INTO tool_executions(id, run_id, tool_name, arguments_json, output_text, citations_json, status, sandbox_json, started_at)
      VALUES (?, ?, 'workspace.read', ?, ?, ?, 'complete', ?, ?)
    `).run(
      uuidv7(),
      run.id,
      JSON.stringify({ path: "/Users/alice/secret-project/.env" }),
      "read /Users/alice/secret-project/.env",
      JSON.stringify([{ path: "/Users/alice/secret-project/.env" }]),
      JSON.stringify({ cwd: "/Users/alice/secret-project" }),
      new Date().toISOString()
    );

    const bytes = await exportBytes(value);
    const zip = await JSZip.loadAsync(bytes);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")) as Record<string, unknown>;
    const structured = await structuredFromZip(zip);
    const structuredText = JSON.stringify(structured);

    expect(Object.keys(structured)).not.toEqual(expect.arrayContaining([
      "workspace_roots", "jobs", "job_attempts", "runs", "run_stream_events", "idempotency_keys", "vectors", "retrieval_traces",
      "installation_budget_ledger", "budget_reservations"
    ]));
    expect(structured.attachments?.[0]).toMatchObject({
      filename: "private.txt",
      storage_path: `cas:${attachment.hash}`
    });
    expect(structured.sources?.[0]?.uri).toBeNull();
    expect(structured.tool_executions?.[0]).toMatchObject({
      arguments_json: JSON.stringify({ excludedFromExport: true }),
      output_text: "[excluded from export]",
      citations_json: "[]",
      sandbox_json: "{}"
    });
    expect(structuredText).not.toContain(value.root);
    expect(structuredText).not.toContain("/Users/alice/secret-project");
    expect(structuredText).not.toContain("sk-test-secret-value-that-must-never-export");
    expect(manifest.sensitiveToolOutputIncluded).toBe(false);
    expect(Object.keys(zip.files)).not.toContain("installation-budget-ledger.json");
    expect(Object.keys(zip.files).sort()).toEqual(["manifest.json", ...Object.keys(manifest.checksums as Record<string, string>)].sort());
    const verified = await value.maintenance.verifyBundle(bytes);
    expect(verified).toMatchObject({ manifest: { format: "continuum-vault", version: 2 } });
    await verified.cleanup?.();
  });

  it("restores attachment bytes into the destination CAS and discards imported operational state", async () => {
    const source = await fixture("replace-source");
    const attachment = await addAttachment(source, Buffer.from("portable attachment"));
    source.database.addSourceChunks(attachment.sourceId, [{ text: "portable attachment" }]);
    const portableEvent = source.database.appendEvent({ role: "user", content: "portable event", attachmentIds: [attachment.attachmentId] });
    const portableTopic = source.database.upsertTopicRevision({
      type: "concept",
      title: "Portable topic",
      slug: "portable-topic",
      markdown: "# Portable topic\n\nEvidence-backed content.",
      summary: "Evidence-backed content.",
      currentState: "Portable",
      history: "",
      sourceIds: [portableEvent.id],
      promptVersion: "test-v1"
    });
    const portableClaim = source.database.upsertClaim({
      topicId: portableTopic.id,
      subject: "ＰＯＲＴＡＢＬＥ\u3000Topic",
      predicate: "IS\t  NAMED",
      value: "Portable topic",
      confidence: 1,
      status: "current",
      sourceRole: "user",
      sourceIds: [portableEvent.id],
      validFrom: null,
      validTo: null,
      observedAt: portableEvent.createdAt,
      freshnessExpiresAt: null
    });
    source.database.authorizeWorkspace("/Users/source/private", "Source private root");
    source.database.enqueueJob("malicious.imported", "source-job", { execute: true });
    const bundle = await exportBytes(source);

    const target = await fixture("replace-target");
    const old = await addAttachment(target, Buffer.from("old attachment"));
    const oldEvent = target.database.appendEvent({ role: "user", content: "old event", attachmentIds: [old.attachmentId] });
    const oldRun = target.database.createRun(oldEvent.id, "fast");
    target.database.appendRunStreamEvent(oldRun.id, { type: "run.started", runId: oldRun.id });
    target.database.connection.prepare("UPDATE runs SET status = 'complete', completed_at = ? WHERE id = ?").run(new Date().toISOString(), oldRun.id);
    target.database.authorizeWorkspace("/Users/target/private", "Target private root");
    target.database.enqueueJob("old.job", "old-job", { execute: true });
    target.database.rememberIdempotentResponse("old-idempotency", "test", { event: "secret" });
    target.database.connection.prepare(`
      INSERT INTO vectors(id, source_id, source_type, model_id, dimensions, content_hash, embedding_version, embedding_json, created_at)
      VALUES (?, ?, 'event', 'test', 2, ?, 'v1', '[0,1]', ?)
    `).run(uuidv7(), oldEvent.id, stableHash("old vector"), new Date().toISOString());

    const result = await target.maintenance.importBundle(bundle, "replace");
    const restored = target.database.getAttachment(attachment.attachmentId);
    expect(result).toMatchObject({ valid: true, replaced: true, mode: "replace", attachmentsRestored: 1 });
    expect(restored?.storagePath.startsWith(target.config.attachmentsDir)).toBe(true);
    expect(Buffer.from(await target.store.get(attachment.hash)).toString("utf8")).toBe("portable attachment");
    await expect(target.store.has(old.hash)).resolves.toBe(false);
    expect(target.database.listEvents({ limit: 20 }).map((event) => event.content)).toEqual(["portable event"]);
    expect(target.database.getTopic(portableTopic.id)?.markdown).toBe("# Portable topic\n\nEvidence-backed content.");
    expect(target.database.listActiveClaimsForSlot("portable topic", "is named", portableTopic.id))
      .toEqual([expect.objectContaining({ id: portableClaim.id })]);
    await expect(readFile(join(target.config.projectionsDir, `${portableTopic.id}-portable-topic.md`), "utf8")).resolves.toContain("Evidence-backed content.");
    expect(target.database.listWorkspaces()).toHaveLength(0);
    expect(target.database.connection.prepare("SELECT COUNT(*) AS count FROM runs").get()).toMatchObject({ count: 0 });
    expect(target.database.connection.prepare("SELECT COUNT(*) AS count FROM idempotency_keys").get()).toMatchObject({ count: 0 });
    expect(target.database.connection.prepare("SELECT COUNT(*) AS count FROM vectors").get()).toMatchObject({ count: 0 });
    const jobs = target.database.listJobs(100);
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((job) => ["embedding.index", "source.extract", "memory.lint", "memory.compile"].includes(job.type))).toBe(true);
    const embeddingJobs = jobs.filter((job) => job.type === "embedding.index");
    expect(embeddingJobs.length).toBeGreaterThan(0);
    expect(embeddingJobs.every((job) => {
      const generation = job.payload.sourceType === "chunk" ? job.payload.sourceGenerationHash : job.payload.contentHash;
      return job.payload.model === target.config.models.embedding
        && typeof generation === "string"
        && /^[a-f0-9]{64}$/.test(generation);
    })).toBe(true);
    expect(jobs.some((job) => job.type === "malicious.imported" || job.type === "old.job")).toBe(false);
  });

  it("rejects checksum-valid but structurally unexpected archive members", async () => {
    const value = await fixture("unexpected-entry");
    value.database.appendEvent({ role: "user", content: "hello" });
    const original = await exportBytes(value, false);
    const zip = await JSZip.loadAsync(original);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")) as {
      checksums: Record<string, string>;
      sizes: Record<string, number>;
      expandedBytes: number;
    };
    zip.file("unexpected.txt", "x", { createFolders: false });
    manifest.checksums["unexpected.txt"] = stableHash("x");
    manifest.sizes["unexpected.txt"] = 1;
    manifest.expandedBytes += 1;
    zip.file("manifest.json", JSON.stringify(manifest), { createFolders: false });
    const tampered = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    await expect(value.maintenance.verifyBundle(tampered)).rejects.toThrow(/portable file set/i);
  });

  it("rejects false row counts and oversized central-directory declarations before expansion", async () => {
    const value = await fixture("bounded-verification");
    value.database.appendEvent({ role: "user", content: "hello" });
    const original = await exportBytes(value, false);
    const zip = await JSZip.loadAsync(original);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string")) as { counts: Record<string, number> };
    manifest.counts.events = (manifest.counts.events ?? 0) + 1;
    zip.file("manifest.json", JSON.stringify(manifest), { createFolders: false });
    const falseCount = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    await expect(value.maintenance.verifyBundle(falseCount)).rejects.toThrow(/count for events/i);

    const oversized = overrideCentralExpandedSize(original, "data/tables/events/000000.jsonl", 65 * 1024 * 1024);
    await expect(value.maintenance.verifyBundle(oversized)).rejects.toThrow(/expanded-size limit/i);
  });

  it("rejects version-2 manifests with missing or non-canonical shard declarations", async () => {
    const value = await fixture("canonical-streamed-layout");
    value.database.appendEvent({ role: "user", content: "hello" });
    const original = await exportBytes(value, false);

    const missingZip = await JSZip.loadAsync(original);
    const missingManifest = JSON.parse(await missingZip.file("manifest.json")!.async("string")) as Record<string, unknown>;
    delete missingManifest.eventShards;
    missingZip.file("manifest.json", JSON.stringify(missingManifest), { createFolders: false });
    const missing = await missingZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    await expect(value.maintenance.verifyBundle(missing)).rejects.toThrow(/must declare table and event shards/i);

    const nonCanonicalZip = await JSZip.loadAsync(original);
    const nonCanonicalManifest = JSON.parse(await nonCanonicalZip.file("manifest.json")!.async("string")) as { eventShards: string[] };
    nonCanonicalManifest.eventShards[0] = "data/events/000001.jsonl";
    nonCanonicalZip.file("manifest.json", JSON.stringify(nonCanonicalManifest), { createFolders: false });
    const nonCanonical = await nonCanonicalZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    await expect(value.maintenance.verifyBundle(nonCanonical)).rejects.toThrow(/non-canonical event shards/i);
  });

  it("supports an evidence-only fresh import and queues trusted memory rebuilding", async () => {
    const source = await fixture("fresh-source");
    const event = source.database.appendEvent({ role: "user", content: "Remember my preferred editor is Helix" });
    const topic = source.database.upsertTopicRevision({
      type: "concept",
      title: "Editor preference",
      slug: "editor-preference",
      markdown: "# Editor preference\n\nHelix",
      summary: "Helix",
      currentState: "Helix",
      history: "",
      sourceIds: [event.id],
      promptVersion: "test-v1"
    });
    source.database.upsertClaim({
      topicId: topic.id,
      subject: "User",
      predicate: "prefers",
      value: "Helix",
      confidence: 1,
      status: "current",
      sourceRole: "user",
      sourceIds: [event.id],
      validFrom: null,
      validTo: null,
      observedAt: event.createdAt,
      freshnessExpiresAt: null
    });
    source.database.connection.prepare(`
      INSERT INTO vectors(id, source_id, source_type, model_id, dimensions, content_hash, embedding_version, embedding_json, created_at)
      VALUES (?, ?, 'topic', 'test', 2, ?, 'v1', '[1,0]', ?)
    `).run(uuidv7(), topic.id, stableHash("topic"), new Date().toISOString());
    const bundle = await exportBytes(source, false);

    const target = await fixture("fresh-target");
    await target.maintenance.importBundle(bundle, "fresh");
    expect(target.database.listEvents({ limit: 20 }).map((item) => item.content)).toEqual(["Remember my preferred editor is Helix"]);
    expect(target.database.listTopics(20)).toHaveLength(0);
    expect(target.database.listClaims(20)).toHaveLength(0);
    expect(target.database.connection.prepare("SELECT COUNT(*) AS count FROM vectors").get()).toMatchObject({ count: 0 });
    const jobs = target.database.listJobs(100);
    expect(jobs.some((job) => job.type === "memory.compile")).toBe(true);
    expect(jobs.some((job) => job.type === "memory.lint")).toBe(true);
  });

  it("creates verified portable managed backups with one CAS member for duplicate logical attachments", async () => {
    const value = await fixture("portable-backup");
    const first = await addAttachment(value, Buffer.from("shared backup bytes"), "first.txt");
    const sourceId = value.database.createSource({ type: "attachment", title: "Second logical copy", contentHash: first.hash });
    value.database.createAttachment({
      sourceId,
      filename: "second.txt",
      mediaType: "text/plain",
      size: Buffer.byteLength("shared backup bytes"),
      storagePath: join(value.config.attachmentsDir, first.hash.slice(0, 2), first.hash),
      contentHash: first.hash,
      status: "ready"
    });

    const backup = await value.maintenance.createBackup("manual");
    const bytes = await readFile(join(value.config.backupsDir, String(backup.filename)));
    const verified = await value.maintenance.verifyBundle(bytes);
    const zip = await JSZip.loadAsync(bytes);

    expect(backup).toMatchObject({ kind: "manual", format: "continuum-vault", includesAttachments: true });
    expect(String(backup.filename)).toMatch(/^continuum-manual-.+\.zip$/);
    expect(verified.portableDatabase?.connection.prepare("SELECT COUNT(*) AS count FROM attachments").get()).toMatchObject({ count: 2 });
    expect(Object.keys(zip.files).filter((path) => path === `attachments/${first.hash}`)).toHaveLength(1);
    expect(await readdir(value.config.exportsDir)).toEqual([]);
    await verified.cleanup?.();
  });

  it("refuses snapshot operations during active work and always releases its maintenance lock", async () => {
    const value = await fixture("active-snapshot");
    const event = value.database.appendEvent({ role: "user", content: "active response" });
    value.database.createRun(event.id, "balanced");

    await expect(value.maintenance.exportBundle({ includeAttachments: false, includeSensitiveToolOutput: false })).rejects.toThrow(/active response runs/i);
    expect(value.database.getSetting("maintenance.locked", false)).toBe(false);
    await expect(value.maintenance.createBackup("manual")).rejects.toThrow(/active response runs/i);
    expect(value.database.getSetting("maintenance.locked", false)).toBe(false);
    expect(value.maintenance.listBackups()).toEqual([]);
  });

  it("bounds export retention and never prunes an active download", async () => {
    const value = await fixture("export-retention");
    const names = Array.from({ length: 5 }, (_, index) => `continuum-retention-${index}.zip`);
    for (let index = 0; index < names.length; index += 1) {
      const path = join(value.config.exportsDir, names[index]!);
      await writeFile(path, `export-${index}`, { mode: 0o600 });
      await utimes(path, new Date(Date.now() - (index + 1) * 1_000), new Date(Date.now() - (index + 1) * 1_000));
    }
    await value.maintenance.pruneExports();
    expect((await readdir(value.config.exportsDir)).filter((entry) => entry.endsWith(".zip"))).toHaveLength(3);

    const activeName = "continuum-active-download.zip";
    const activePath = join(value.config.exportsDir, activeName);
    await writeFile(activePath, "active", { mode: 0o600 });
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
    await utimes(activePath, old, old);
    const opened = await value.maintenance.openExportDownload(activeName);
    await value.maintenance.pruneExports();
    expect(await readdir(value.config.exportsDir)).toContain(activeName);
    const closed = new Promise<void>((resolve) => opened.stream.once("close", resolve));
    opened.stream.destroy();
    await closed;
    await value.maintenance.pruneExports();
    expect(await readdir(value.config.exportsDir)).not.toContain(activeName);
  });

  it("serializes startup catch-up and retains exactly seven daily and four weekly backups", async () => {
    const catchUp = await fixture("backup-catch-up");
    const reference = new Date();
    const [first, second] = await Promise.all([
      catchUp.maintenance.createDueBackups(reference),
      catchUp.maintenance.createDueBackups(reference)
    ]);
    expect(first.map((row) => row.kind).sort()).toEqual(["daily", "weekly"]);
    expect(second).toEqual(first);
    expect(catchUp.maintenance.listBackups()).toHaveLength(2);
    await expect(catchUp.maintenance.createDueBackups(reference)).resolves.toEqual([]);

    const retention = await fixture("backup-retention");
    for (let index = 0; index < 8; index += 1) await retention.maintenance.createBackup("daily");
    for (let index = 0; index < 5; index += 1) await retention.maintenance.createBackup("weekly");
    const records = retention.maintenance.listBackups();
    expect(records.filter((row) => row.kind === "daily")).toHaveLength(7);
    expect(records.filter((row) => row.kind === "weekly")).toHaveLength(4);
    expect((await readdir(retention.config.backupsDir)).filter((entry) => entry.endsWith(".zip"))).toHaveLength(11);
  });

  it("publishes the listening socket before a slow automatic backup catch-up completes", async () => {
    const value = await fixture("nonblocking-backup-startup");
    const developmentConfig = { ...value.config, env: "development" } as AppConfig;
    let release!: (records: Array<Record<string, unknown>>) => void;
    const pending = new Promise<Array<Record<string, unknown>>>((resolve) => { release = resolve; });
    const due = vi.spyOn(VaultMaintenance.prototype, "createDueBackups").mockReturnValue(pending);
    let built: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      built = await Promise.race([
        buildApp({ config: developmentConfig, database: value.database }),
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("buildApp blocked on backup catch-up")), 1_000))
      ]);
      await built.app.listen({ host: "127.0.0.1", port: 0 });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(due).toHaveBeenCalledTimes(1);
      const running = await built.app.inject({
        method: "GET", url: "/api/v1/health",
        headers: { authorization: `Bearer ${value.config.sessionToken}`, host: "127.0.0.1" }
      });
      expect(running.json()).toMatchObject({ backup: { status: "running" } });
      release([]);
      await pending;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const idle = await built.app.inject({
        method: "GET", url: "/api/v1/health",
        headers: { authorization: `Bearer ${value.config.sessionToken}`, host: "127.0.0.1" }
      });
      expect(idle.json()).toMatchObject({ backup: { status: "idle", lastCompletedAt: expect.any(String) } });
    } finally {
      release?.([]);
      if (built) await built.app.close();
      value.closed = Boolean(built);
      due.mockRestore();
    }
  });

  it("keeps the live vault writable while an online backup snapshot is in flight", async () => {
    const value = await fixture("writable-online-backup");
    value.database.appendEvent({ role: "user", content: "before snapshot" });
    const originalBackup = value.database.connection.backup.bind(value.database.connection);
    let snapshotStarted!: () => void;
    let releaseSnapshot!: () => void;
    const started = new Promise<void>((resolve) => { snapshotStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    const backupMethod = vi.spyOn(value.database.connection, "backup").mockImplementation(async (destination, options) => {
      snapshotStarted();
      await gate;
      return originalBackup(destination, options);
    });
    try {
      const pending = value.maintenance.createBackup("manual");
      await started;
      expect(value.database.getSetting("maintenance.locked", false)).toBe(false);
      expect(value.database.appendEvent({ role: "user", content: "chat remains writable" }).content).toBe("chat remains writable");
      releaseSnapshot();
      await expect(pending).resolves.toMatchObject({ kind: "manual" });
    } finally {
      releaseSnapshot?.();
      backupMethod.mockRestore();
    }
  });

  it("removes only stale, marker-owned backup staging directories", async () => {
    const value = await fixture("stale-backup-staging");
    const parent = join(value.config.dataDir, "backup-staging");
    const syncedDirectories: string[] = [];
    const maintenance = new VaultMaintenance(value.database, value.config, {
      syncDirectory: async (path) => { syncedDirectories.push(resolve(path)); }
    });
    const snapshotId = uuidv7();
    const owned = join(parent, `snapshot-${snapshotId}`);
    const unowned = join(parent, `snapshot-${uuidv7()}`);
    await mkdir(owned, { recursive: true, mode: 0o700 });
    await mkdir(unowned, { mode: 0o700 });
    await writeFile(join(owned, ".continuum-owned-backup-staging.json"), JSON.stringify({
      format: "continuum-backup-staging",
      snapshotId,
      ownerHash: stableHash(`continuum-backup-staging:${resolve(value.config.dataDir)}`),
      instanceId: uuidv7(),
      processId: 2_147_483_647,
      createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000).toISOString()
    }), { mode: 0o600 });
    await writeFile(join(owned, "large-partial-file"), "partial", { mode: 0o600 });

    await expect(maintenance.pruneStaleBackupStaging()).resolves.toEqual({ removed: 1, retained: 1 });
    expect(await readdir(parent)).toEqual([basename(unowned)]);
    expect(syncedDirectories).toContain(resolve(parent));
  });

  it("does not publish a backup record when the final directory sync fails and durably cleans staging", async () => {
    const value = await fixture("backup-publish-sync-failure");
    value.database.appendEvent({ role: "user", content: "backup durability canary" });
    const syncedDirectories: string[] = [];
    let injected = false;
    const maintenance = new VaultMaintenance(value.database, value.config, {
      syncDirectory: async (path) => {
        const normalized = resolve(path);
        syncedDirectories.push(normalized);
        if (!injected && normalized === resolve(value.config.backupsDir)) {
          injected = true;
          throw Object.assign(new Error("injected backup directory sync failure"), { code: "EIO" });
        }
      }
    });

    await expect(maintenance.createBackup("manual")).rejects.toThrow(/directory sync failure/i);
    expect(injected).toBe(true);
    expect(maintenance.listBackups()).toEqual([]);
    expect(await readdir(value.config.backupsDir)).toEqual([]);
    expect(await readdir(join(value.config.dataDir, "backup-staging"))).toEqual([]);
    expect(syncedDirectories).toContain(resolve(join(value.config.dataDir, "backup-staging")));
  });

  it("keeps backup records until deleted archives are directory-synced and converges on retry", async () => {
    const value = await fixture("backup-scrub-sync-failure");
    await mkdir(value.config.backupsDir, { recursive: true, mode: 0o700 });
    const filename = `continuum-manual-seeded-${uuidv7()}.zip`;
    const bytes = Buffer.from("stale managed backup");
    await writeFile(join(value.config.backupsDir, filename), bytes, { mode: 0o600 });
    value.database.connection.prepare(`
      INSERT INTO backup_records(id, filename, kind, checksum, size, created_at)
      VALUES (?, ?, 'manual', ?, ?, ?)
    `).run(uuidv7(), filename, stableHash(bytes), bytes.byteLength, new Date().toISOString());

    let injected = false;
    const interrupted = new VaultMaintenance(value.database, value.config, {
      syncDirectory: async (path) => {
        if (!injected && resolve(path) === resolve(value.config.backupsDir)) {
          injected = true;
          throw Object.assign(new Error("injected backup deletion sync failure"), { code: "EIO" });
        }
      }
    });
    await expect(interrupted.scrubManagedBackupsAfterDeletion()).rejects.toThrow(/deletion sync failure/i);
    expect(interrupted.listBackups()).toHaveLength(1);
    expect(await readdir(value.config.backupsDir)).toEqual([]);

    const recovered = new VaultMaintenance(value.database, value.config);
    await expect(recovered.scrubManagedBackupsAfterDeletion()).resolves.toBeUndefined();
    const records = recovered.listBackups();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: "manual" });
    expect(await readdir(value.config.backupsDir)).toEqual([String(records[0]?.filename)]);
  });

  it("cancels an in-flight backup on shutdown and removes its owned staging", async () => {
    const value = await fixture("cancelled-backup-staging");
    const originalBackup = value.database.connection.backup.bind(value.database.connection);
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolveStarted) => { started = resolveStarted; });
    const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
    const backupMethod = vi.spyOn(value.database.connection, "backup").mockImplementation(async (destination, options) => {
      started();
      await gate;
      return originalBackup(destination, options);
    });
    try {
      const pending = value.maintenance.createBackup("manual");
      await entered;
      value.maintenance.requestBackupShutdown();
      let drained = false;
      const shutdown = value.maintenance.waitForBackupShutdown().then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);
      release();
      await expect(pending).rejects.toThrow(/shutting down/i);
      await shutdown;
      expect(drained).toBe(true);
      expect(await readdir(join(value.config.dataDir, "backup-staging"))).toEqual([]);
    } finally {
      release?.();
      backupMethod.mockRestore();
    }
  });

  it("resumes a committed import at startup before normal work begins", async () => {
    const source = await fixture("journal-source");
    const attachment = await addAttachment(source, Buffer.from("journal attachment"));
    const event = source.database.appendEvent({ role: "user", content: "journal import event", attachmentIds: [attachment.attachmentId] });
    const topic = source.database.upsertTopicRevision({
      type: "project", title: "Journal Topic", slug: "journal-topic", markdown: "# Journal Topic\n\nRecovered projection.",
      summary: "Recovered", currentState: "Recovered", history: "", sourceIds: [event.id], promptVersion: "test-v1"
    });
    const bundle = await exportBytes(source);

    const target = await fixture("journal-target");
    const old = await addAttachment(target, Buffer.from("obsolete target bytes"));
    const restrictedParent = join(target.root, "restricted-projections");
    await mkdir(restrictedParent, { mode: 0o500 });
    const recoveryConfig = { ...target.config, projectionsDir: join(restrictedParent, "wiki") } as AppConfig;
    const interrupted = new VaultMaintenance(target.database, recoveryConfig);

    await expect(interrupted.importBundle(bundle, "replace")).rejects.toThrow();
    expect(target.database.listEvents({ limit: 20 }).map((item) => item.content)).toEqual(["journal import event"]);
    expect(target.database.connection.prepare("SELECT phase FROM import_operations").get()).toEqual({ phase: "database_complete" });
    await expect(target.store.has(old.hash)).resolves.toBe(true);

    target.database.close();
    target.closed = true;
    await chmod(restrictedParent, 0o700);
    // Model a crash after live->previous succeeded but both stage->live and
    // rollback failed. Startup must restore, not discard, this last-good tree
    // before retrying the journaled projection replacement.
    const previousProjection = `${recoveryConfig.projectionsDir}.previous-${uuidv7()}`;
    await mkdir(previousProjection, { mode: 0o700 });
    await writeFile(join(previousProjection, "last-good.md"), "last known good projection", { mode: 0o600 });
    const { app, services } = await buildApp({ config: recoveryConfig });
    try {
      expect(services.database.connection.prepare("SELECT phase FROM import_operations").get()).toEqual({ phase: "complete" });
      await expect(readFile(join(recoveryConfig.projectionsDir, `${topic.id}-journal-topic.md`), "utf8")).resolves.toContain("Recovered projection");
      await expect(target.store.has(old.hash)).resolves.toBe(false);
      await expect(target.store.has(attachment.hash)).resolves.toBe(true);
      expect(await readdir(join(target.root, "import-journal"))).toEqual([]);
      expect((await readdir(restrictedParent)).filter((entry) => entry.includes(".previous-") || entry.includes(".import-"))).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("keeps an import database_complete until the projection swap directory is durable, then resumes idempotently", async () => {
    const source = await fixture("projection-sync-source");
    const sourceEvent = source.database.appendEvent({ role: "user", content: "durable imported projection evidence" });
    const importedTopic = source.database.upsertTopicRevision({
      type: "project",
      title: "Durable imported topic",
      slug: "durable-imported-topic",
      markdown: "# Durable imported topic\n\nImported projection canary.",
      summary: "Imported projection canary",
      currentState: "durable",
      history: "",
      sourceIds: [sourceEvent.id],
      promptVersion: "projection-sync-test-v1"
    });
    const bundle = await exportBytes(source, false);

    const target = await fixture("projection-sync-target");
    const oldEvent = target.database.appendEvent({ role: "user", content: "old projection evidence" });
    const oldMarkdown = "# Old projection topic\n\nOld private projection canary.";
    const oldTopic = target.database.upsertTopicRevision({
      type: "project",
      title: "Old projection topic",
      slug: "old-projection-topic",
      markdown: oldMarkdown,
      summary: "Old private projection canary",
      currentState: "old",
      history: "",
      sourceIds: [oldEvent.id],
      promptVersion: "projection-sync-test-v1"
    });
    await mkdir(target.config.projectionsDir, { recursive: true, mode: 0o700 });
    const oldProjectionPath = join(target.config.projectionsDir, `${oldTopic.id}-${oldTopic.slug}.md`);
    await writeFile(oldProjectionPath, oldMarkdown, { mode: 0o600 });

    const projectionParent = resolve(dirname(target.config.projectionsDir));
    const syncedDirectories: string[] = [];
    let parentSyncs = 0;
    const interrupted = new VaultMaintenance(target.database, target.config, {
      syncDirectory: async (path) => {
        const normalized = resolve(path);
        syncedDirectories.push(normalized);
        if (normalized === projectionParent) {
          parentSyncs += 1;
          // cleanup fence, live->previous, then stage->live publication
          if (parentSyncs === 3) throw Object.assign(new Error("injected projection swap sync failure"), { code: "EIO" });
        }
      }
    });

    await expect(interrupted.importBundle(bundle, "replace")).rejects.toThrow(/projection swap sync failure/i);
    expect(parentSyncs).toBe(3);
    expect(syncedDirectories.some((path) => basename(path).includes(".import-"))).toBe(true);
    expect(target.database.connection.prepare("SELECT phase FROM import_operations").get()).toEqual({ phase: "database_complete" });
    expect((await readdir(projectionParent)).some((entry) => entry.includes(".previous-"))).toBe(true);

    const recovered = new VaultMaintenance(target.database, target.config);
    await expect(recovered.resumeIncompleteImports()).resolves.toEqual({ resumed: 1, abandoned: 0 });
    expect(target.database.connection.prepare("SELECT phase FROM import_operations").get()).toEqual({ phase: "complete" });
    await expect(readFile(join(target.config.projectionsDir, `${importedTopic.id}-${importedTopic.slug}.md`), "utf8"))
      .resolves.toContain("Imported projection canary");
    await expect(readFile(oldProjectionPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(projectionParent)).filter((entry) => entry.includes(".previous-") || entry.includes(".import-"))).toEqual([]);
    expect(await readdir(join(target.config.dataDir, "import-journal"))).toEqual([]);
  });

  it("keeps an import files_complete until journal archive deletion is durable, then resumes idempotently", async () => {
    const source = await fixture("journal-delete-sync-source");
    const event = source.database.appendEvent({ role: "user", content: "journal deletion durability evidence" });
    source.database.upsertTopicRevision({
      type: "project",
      title: "Journal deletion topic",
      slug: "journal-deletion-topic",
      markdown: "# Journal deletion topic\n\nThe archive deletion must be durable.",
      summary: "Journal deletion durability",
      currentState: "durable",
      history: "",
      sourceIds: [event.id],
      promptVersion: "journal-delete-sync-test-v1"
    });
    const bundle = await exportBytes(source, false);

    const target = await fixture("journal-delete-sync-target");
    const journalDirectory = resolve(join(target.config.dataDir, "import-journal"));
    let injected = false;
    const interrupted = new VaultMaintenance(target.database, target.config, {
      syncDirectory: async (path) => {
        if (!injected && resolve(path) === journalDirectory) {
          injected = true;
          throw Object.assign(new Error("injected journal archive deletion sync failure"), { code: "EIO" });
        }
      }
    });

    await expect(interrupted.importBundle(bundle, "replace")).rejects.toThrow(/archive deletion sync failure/i);
    expect(injected).toBe(true);
    expect(target.database.connection.prepare("SELECT phase FROM import_operations").get()).toEqual({ phase: "files_complete" });
    expect(await readdir(journalDirectory)).toEqual([]);

    const recovered = new VaultMaintenance(target.database, target.config);
    await expect(recovered.resumeIncompleteImports()).resolves.toEqual({ resumed: 1, abandoned: 0 });
    expect(target.database.connection.prepare("SELECT phase FROM import_operations").get()).toEqual({ phase: "complete" });
    expect(await readdir(journalDirectory)).toEqual([]);
  });

  it("resumes hard-deletion file and backup cleanup at startup", async () => {
    const value = await fixture("deletion-resume");
    const attachment = await addAttachment(value, Buffer.from("delete-on-restart"));
    await value.maintenance.createBackup("manual");
    const deletion = value.database.hardDeleteAttachment(attachment.attachmentId);
    expect(deletion.sharedByteReferences).toBe(0);
    await expect(value.store.has(attachment.hash)).resolves.toBe(true);
    value.database.close();
    value.closed = true;

    const { app, services } = await buildApp({ config: value.config });
    try {
      await expect(value.store.has(attachment.hash)).resolves.toBe(false);
      expect(services.database.connection.prepare("SELECT phase FROM deletion_operations WHERE id = ?").get(deletion.operationId)).toEqual({ phase: "complete" });
      const backups = services.maintenance.listBackups();
      expect(backups).toHaveLength(1);
      expect(backups[0]).toMatchObject({ kind: "manual" });
      expect(String(backups[0]?.filename)).toMatch(/\.zip$/);
      const bytes = await readFile(join(value.config.backupsDir, String(backups[0]?.filename)));
      const zip = await JSZip.loadAsync(bytes);
      const structured = await structuredFromZip(zip);
      expect(structured.attachments).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("finishes a marker-backed whole-vault destruction before startup unlock", async () => {
    const value = await fixture("vault-destroy-resume");
    const attachment = await addAttachment(value, Buffer.from("destroy-on-restart"));
    value.database.appendEvent({ role: "user", content: "This must not survive restart.", attachmentIds: [attachment.attachmentId] });
    await value.maintenance.createBackup("manual");
    const markerPath = join(value.config.dataDir, "vault-destroy.pending.json");
    await writeFile(markerPath, JSON.stringify({
      format: "continuum-vault-destroy-v1",
      idempotencyKey: uuidv7(),
      startedAt: new Date().toISOString()
    }), { mode: 0o600 });
    value.database.close();
    value.closed = true;

    const { app, services } = await buildApp({ config: value.config });
    try {
      expect(services.database.listEvents({ limit: 20 })).toEqual([]);
      expect(services.database.listIncompleteDeletionOperations()).toEqual([]);
      await expect(value.store.has(attachment.hash)).resolves.toBe(false);
      await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(services.database.getSetting("maintenance.locked", true)).toBe(false);

      const backups = services.maintenance.listBackups();
      expect(backups).toHaveLength(1);
      expect(backups[0]).toMatchObject({ kind: "manual" });
      const bytes = await readFile(join(value.config.backupsDir, String(backups[0]?.filename)));
      const structured = await structuredFromZip(await JSZip.loadAsync(bytes));
      expect(structured.events).toEqual([]);
      expect(structured.attachments).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("keeps the process and persistent locks closed after a post-marker vault-destroy failure until startup recovery", async () => {
    const value = await fixture("vault-destroy-failure-lock");
    value.database.appendEvent({ role: "user", content: "Destroy this even if cleanup first fails." });
    const built = await buildApp({ config: value.config, database: value.database });
    let builtClosed = false;
    let recovered: Awaited<ReturnType<typeof buildApp>> | undefined;
    const scrub = vi.spyOn(built.services.maintenance, "scrubManagedBackupsAfterDeletion")
      .mockRejectedValueOnce(Object.assign(new Error("injected backup scrub I/O failure"), { code: "EIO" }));
    const auth = { authorization: `Bearer ${value.config.sessionToken}`, host: "127.0.0.1", "x-continuum-request": "1" };
    try {
      const impactResponse = await built.app.inject({ method: "POST", url: "/api/v1/vault/deletion-impact", headers: auth });
      const impact = impactResponse.json() as { requiredPhrase: string; confirmationToken: string };
      const failed = await built.app.inject({
        method: "DELETE",
        url: "/api/v1/vault",
        headers: auth,
        payload: { confirmation: impact.requiredPhrase, confirmationToken: impact.confirmationToken, idempotencyKey: uuidv7() }
      });
      expect(failed.statusCode, failed.body).toBe(503);
      expect(failed.json()).toMatchObject({ error: { code: "VAULT_DESTROY_RECOVERY_REQUIRED", retryable: true } });
      await expect(readFile(join(value.config.dataDir, "vault-destroy.pending.json"), "utf8")).resolves.toContain("continuum-vault-destroy-v1");
      expect(value.database.getSetting("maintenance.locked", false)).toBe(true);
      value.database.enqueueJob("test.after-destroy-failure", uuidv7(), {});
      expect(value.database.leaseJob("blocked-worker")).toBeNull();
      const lateMutation = await built.app.inject({
        method: "PUT",
        url: "/api/v1/settings",
        headers: auth,
        payload: { key: "theme", value: "dark", idempotencyKey: uuidv7() }
      });
      expect(lateMutation.statusCode, lateMutation.body).toBe(423);

      scrub.mockRestore();
      await built.app.close();
      builtClosed = true;
      value.closed = true;
      recovered = await buildApp({ config: value.config });
      expect(recovered.services.database.getSetting("maintenance.locked", true)).toBe(false);
      expect(recovered.services.database.listEvents({ limit: 20 })).toEqual([]);
      await expect(readFile(join(value.config.dataDir, "vault-destroy.pending.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      const accepted = await recovered.app.inject({
        method: "PUT",
        url: "/api/v1/settings",
        headers: auth,
        payload: { key: "theme", value: "dark", idempotencyKey: uuidv7() }
      });
      expect(accepted.statusCode, accepted.body).toBe(200);
    } finally {
      scrub.mockRestore();
      if (!builtClosed) { await built.app.close(); value.closed = true; }
      if (recovered) await recovered.app.close();
    }
  });

  it("locks after a post-commit hard-delete cleanup failure and recovers its exact idempotent response on restart", async () => {
    const value = await fixture("hard-delete-failure-lock");
    const event = value.database.appendEvent({ role: "user", content: "Delete this with restart-safe cleanup." });
    const built = await buildApp({ config: value.config, database: value.database });
    let builtClosed = false;
    let recovered: Awaited<ReturnType<typeof buildApp>> | undefined;
    const scrub = vi.spyOn(built.services.maintenance, "scrubManagedBackupsAfterDeletion")
      .mockRejectedValueOnce(Object.assign(new Error("injected deletion backup scrub failure"), { code: "EIO" }));
    const auth = { authorization: `Bearer ${value.config.sessionToken}`, host: "127.0.0.1", "x-continuum-request": "1" };
    const idempotencyKey = uuidv7();
    try {
      const impactResponse = await built.app.inject({ method: "POST", url: `/api/v1/events/${event.id}/deletion-impact`, headers: auth, payload: {} });
      const impact = impactResponse.json() as { confirmationToken: string };
      const failed = await built.app.inject({
        method: "DELETE",
        url: `/api/v1/events/${event.id}`,
        headers: auth,
        payload: { confirmationToken: impact.confirmationToken, idempotencyKey }
      });
      expect(failed.statusCode, failed.body).toBe(503);
      expect(failed.json()).toMatchObject({ error: { code: "DELETION_RECOVERY_REQUIRED", retryable: true } });
      expect(value.database.getEvent(event.id)).toBeNull();
      expect(value.database.getSetting("maintenance.locked", false)).toBe(true);
      const operation = value.database.listIncompleteDeletionOperations().find((row) => row.object_type === "event");
      expect(operation).toMatchObject({ phase: "database_complete" });
      expect(JSON.parse(String(operation?.payload_json))).toMatchObject({
        apiRecovery: { idempotencyKey, operation: "deletion.events", response: { operationId: operation?.id } }
      });
      const blocked = await built.app.inject({
        method: "PUT", url: "/api/v1/settings", headers: auth,
        payload: { key: "theme", value: "dark", idempotencyKey: uuidv7() }
      });
      expect(blocked.statusCode, blocked.body).toBe(423);

      scrub.mockRestore();
      await built.app.close();
      builtClosed = true;
      value.closed = true;
      recovered = await buildApp({ config: value.config });
      expect(recovered.services.database.getSetting("maintenance.locked", true)).toBe(false);
      expect(recovered.services.database.listIncompleteDeletionOperations()).toEqual([]);
      const retried = await recovered.app.inject({
        method: "DELETE",
        url: `/api/v1/events/${event.id}`,
        headers: auth,
        payload: { confirmationToken: impact.confirmationToken, idempotencyKey }
      });
      expect(retried.statusCode, retried.body).toBe(200);
      expect(retried.json()).toMatchObject({ operationId: operation?.id });
    } finally {
      scrub.mockRestore();
      if (!builtClosed) { await built.app.close(); value.closed = true; }
      if (recovered) await recovered.app.close();
    }
  });

  it("replays a prepared hard-deletion journal entry after restart", async () => {
    const value = await fixture("prepared-deletion-resume");
    const attachment = await addAttachment(value, Buffer.from("prepared-delete-on-restart"));
    await value.maintenance.createBackup("manual");
    const operationId = uuidv7();
    const timestamp = new Date().toISOString();
    value.database.connection.prepare(`
      INSERT INTO deletion_operations(id, object_type, object_hash, phase, payload_json, created_at, updated_at)
      VALUES (?, 'attachment', ?, 'prepared', ?, ?, ?)
    `).run(operationId, stableHash(attachment.attachmentId), JSON.stringify({ attachmentId: attachment.attachmentId, contentHash: attachment.hash }), timestamp, timestamp);
    value.database.close();
    value.closed = true;

    const { app, services } = await buildApp({ config: value.config });
    try {
      expect(services.database.getAttachment(attachment.attachmentId)).toBeNull();
      await expect(value.store.has(attachment.hash)).resolves.toBe(false);
      expect(services.database.connection.prepare("SELECT phase FROM deletion_operations WHERE id = ?").get(operationId)).toEqual({ phase: "complete" });
      expect(services.database.listIncompleteDeletionOperations()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("does not expose a mutating GET export endpoint", async () => {
    const value = await fixture("no-get-export");
    const { app } = await buildApp({ config: value.config, database: value.database });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/export?attachments=true",
        headers: { authorization: `Bearer ${value.config.sessionToken}`, host: "127.0.0.1" }
      });
      expect(response.statusCode).toBe(404);
      expect(await readdir(value.config.exportsDir)).toEqual([]);
    } finally {
      await app.close();
      value.closed = true;
    }
  });
});
