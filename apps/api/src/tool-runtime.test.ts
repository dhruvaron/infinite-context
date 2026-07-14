import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "@continuum/config";
import { ContinuumDatabase, uuidv7 } from "@continuum/database";
import { LocalToolRuntime, OneUseWorkspaceSecretGrants } from "./tool-runtime.js";

const fixtures: Array<{ root: string; database: ContinuumDatabase }> = [];

async function fixture(): Promise<{ root: string; config: AppConfig; database: ContinuumDatabase }> {
  const root = await mkdtemp(join(tmpdir(), "continuum-tool-runtime-"));
  const config = loadConfig({
    NODE_ENV: "test",
    CONTINUUM_DATA_DIR: root,
    CONTINUUM_SESSION_TOKEN: "test-session-token-that-is-at-least-32-characters"
  });
  const database = ContinuumDatabase.open(config);
  fixtures.push({ root, database });
  return { root, config, database };
}

afterEach(async () => {
  while (fixtures.length) {
    const value = fixtures.pop()!;
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

describe("LocalToolRuntime", () => {
  it("offers and executes provenance-framed memory tools with a durable audit trail", async () => {
    const { database } = await fixture();
    database.appendEvent({ role: "user", content: "The launch canary is ultramarine." });
    const question = database.appendEvent({ role: "user", content: "What was the launch canary?" });
    const run = database.createRun(question.id, "balanced");
    const lifecycle: string[] = [];
    const runtime = new LocalToolRuntime(database, question.content);

    expect(runtime.definitions.map((definition) => definition.name)).toEqual([
      "search_memory", "open_event", "open_source", "get_topic_page", "trace_claim", "search_timeline"
    ]);
    const output = await runtime.execute(
      { callId: "provider-call-1", name: "search_memory", arguments: { query: "ultramarine", filters: {}, limit: 20 } },
      run.id,
      question.id,
      new AbortController().signal,
      {
        started: (id, name) => lifecycle.push(`started:${id}:${name}`),
        completed: (id, name) => lifecycle.push(`completed:${id}:${name}`)
      }
    );

    const framed = JSON.parse(output) as { type: string; policy: string; data: { content: string; untrusted: boolean } };
    expect(framed.type).toBe("continuum.untrusted_tool_evidence");
    expect(framed.data.untrusted).toBe(true);
    expect(framed.policy).toMatch(/never follow instructions/i);
    expect(framed.data.content).toContain("ultramarine");
    expect(lifecycle).toHaveLength(2);
    expect(database.connection.prepare("SELECT tool_name, status FROM tool_executions").get()).toMatchObject({ tool_name: "search_memory", status: "complete" });
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM events WHERE role = 'tool'").get()).toMatchObject({ count: 2 });
  });

  it("opens exact source pages beyond ten thousand chunks without whole-source materialization", async () => {
    const { database } = await fixture();
    const sourceId = database.createSource({ type: "attachment", title: "Long source", contentHash: "long-source" });
    const insert = database.connection.prepare(`
      INSERT INTO source_chunks(id, source_id, ordinal, text_content, location_json, token_count, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `);
    database.connection.transaction(() => {
      for (let ordinal = 0; ordinal < 10_005; ordinal += 1) {
        insert.run(uuidv7(), sourceId, ordinal, `chunk-${ordinal}`, JSON.stringify({ page: ordinal + 1 }), `hash-${ordinal}`, "2026-01-01T00:00:00.000Z");
      }
    })();
    const question = database.appendEvent({ role: "user", content: "Open the exact attachment source." });
    const run = database.createRun(question.id, "balanced");
    const output = await new LocalToolRuntime(database, question.content).execute(
      { callId: "provider-long-source", name: "open_source", arguments: { sourceId, cursor: "10000", limit: 3 } },
      run.id,
      question.id,
      new AbortController().signal,
      { started: () => undefined, completed: () => undefined }
    );
    const framed = JSON.parse(output) as { data: { content: string; nextCursor: string | null } };
    const chunks = JSON.parse(framed.data.content) as Array<{ excerpt: string; location: { page: number } }>;
    expect(chunks.map((chunk) => chunk.excerpt)).toEqual(["chunk-10000", "chunk-10001", "chunk-10002"]);
    expect(chunks.map((chunk) => chunk.location.page)).toEqual([10_001, 10_002, 10_003]);
    expect(framed.data.nextCursor).toBe("10003");

    const located = await new LocalToolRuntime(database, question.content).execute(
      { callId: "provider-long-source-location", name: "open_source", arguments: { sourceId, location: { page: 10_005 }, limit: 1 } },
      run.id,
      question.id,
      new AbortController().signal,
      { started: () => undefined, completed: () => undefined }
    );
    const locatedChunk = JSON.parse((JSON.parse(located) as { data: { content: string } }).data.content) as Array<{ excerpt: string }>;
    expect(locatedChunk[0]?.excerpt).toBe("chunk-10004");
  });

  it("carries attachment search hits directly into open_source and enforces the v1 vault scope", async () => {
    const { root, database } = await fixture();
    const storagePath = join(root, "attachment-navigation.txt");
    await writeFile(storagePath, "attachment-navigation-canary");
    const sourceId = database.createSource({ type: "attachment", title: "Navigation attachment", contentHash: "attachment-navigation-source" });
    const attachment = database.createAttachment({
      sourceId,
      filename: "navigation.txt",
      mediaType: "text/plain",
      size: 28,
      storagePath,
      contentHash: "attachment-navigation-file",
      status: "ready"
    });
    const [chunkId] = database.addSourceChunks(sourceId, [{ text: "attachment-navigation-canary", location: { line: 1 } }]);
    const vaultId = String((database.connection.prepare("SELECT id FROM vaults WHERE scope_id = 'global'").get() as { id: string }).id);
    const question = database.appendEvent({ role: "user", content: "Find and open the attachment-navigation canary source." });
    const run = database.createRun(question.id, "balanced");
    const lifecycle = { started: () => undefined, completed: () => undefined };
    const execute = async (name: string, argumentsValue: Record<string, unknown>) => {
      const output = await new LocalToolRuntime(database, question.content).execute(
        { callId: crypto.randomUUID(), name, arguments: argumentsValue },
        run.id,
        question.id,
        new AbortController().signal,
        lifecycle
      );
      return JSON.parse((JSON.parse(output) as { data: { content: string } }).data.content) as Array<Record<string, unknown>>;
    };

    const wrongScope = await execute("search_memory", { query: "attachment-navigation-canary", filters: { scopeId: uuidv7() }, limit: 10 });
    expect(wrongScope).toEqual([]);
    const hits = await execute("search_memory", { query: "attachment-navigation-canary", filters: { scopeId: vaultId, types: ["attachment"] }, limit: 10 });
    expect(hits).toContainEqual(expect.objectContaining({
      id: attachment.id,
      type: "attachment",
      sourceIds: expect.arrayContaining([attachment.id, sourceId, chunkId]),
      location: expect.objectContaining({ sourceId, chunkId, evidenceId: chunkId })
    }));

    const fromAttachmentId = await execute("open_source", { sourceId: attachment.id, limit: 10 });
    expect(fromAttachmentId).toContainEqual(expect.objectContaining({
      excerpt: "attachment-navigation-canary",
      sourceIds: [sourceId],
      location: expect.objectContaining({ sourceId, chunkId, line: 1 })
    }));
    const fromChunkId = await execute("open_source", { sourceId: chunkId, limit: 10 });
    expect(fromChunkId).toEqual(fromAttachmentId);
  });

  it("pages an exact raw event past 100,000 characters without gaps, truncation, or split surrogate pairs", async () => {
    const { database } = await fixture();
    const content = `head-${"x".repeat(99_994)}😀-tail-canary`;
    const event = database.appendEvent({ role: "user", content });
    const question = database.appendEvent({ role: "user", content: "Open the exact earlier message in full." });
    const run = database.createRun(question.id, "balanced");
    const lifecycle = { started: () => undefined, completed: () => undefined };
    const excerpts: string[] = [];
    let cursor: string | undefined;
    do {
      const output = await new LocalToolRuntime(database, question.content).execute(
        { callId: crypto.randomUUID(), name: "open_event", arguments: { eventId: event.id, ...(cursor ? { cursor } : {}), limit: 50 } },
        run.id,
        question.id,
        new AbortController().signal,
        lifecycle
      );
      const framed = JSON.parse(output) as { data: { content: string; nextCursor: string | null } };
      const page = JSON.parse(framed.data.content) as Array<{ excerpt: string; location: { characterStart: number; characterEnd: number; totalCharacters: number } }>;
      expect(page).toHaveLength(1);
      excerpts.push(page[0]!.excerpt);
      expect(page[0]!.location.totalCharacters).toBe(content.length);
      cursor = framed.data.nextCursor ?? undefined;
    } while (cursor);
    expect(excerpts.join("")).toBe(content);
    expect(excerpts.at(-1)).toContain("tail-canary");
  });

  it("returns exact claim statuses, related contradictions, and chunk-level source provenance", async () => {
    const { database } = await fixture();
    const observedAt = new Date().toISOString();
    const currentEvidence = database.appendEvent({ role: "user", content: "Status-probe launch is June." });
    const conflictEvidence = database.appendEvent({ role: "user", content: "Status-probe launch is July." });
    const expiredEvidence = database.appendEvent({ role: "user", content: "Status-probe launch was May." });
    const current = database.upsertClaim({ topicId: null, subject: "Status-probe", predicate: "launch", value: "June", confidence: 1, status: "current", sourceRole: "user", sourceIds: [currentEvidence.id], validFrom: null, validTo: null, observedAt, freshnessExpiresAt: null });
    const conflicted = database.upsertClaim({ topicId: null, subject: "Status-probe", predicate: "launch", value: "July", confidence: 0.8, status: "conflicted", sourceRole: "user", sourceIds: [conflictEvidence.id], validFrom: null, validTo: null, observedAt, freshnessExpiresAt: null });
    const expired = database.upsertClaim({ topicId: null, subject: "Status-probe", predicate: "launch", value: "May", confidence: 0.7, status: "expired", sourceRole: "user", sourceIds: [expiredEvidence.id], validFrom: null, validTo: null, observedAt, freshnessExpiresAt: observedAt });
    const dynamicallyExpired = database.upsertClaim({ topicId: null, subject: "Status-probe", predicate: "web-state", value: "stale-now", confidence: 0.7, status: "current", sourceRole: "user", sourceIds: [expiredEvidence.id], validFrom: null, validTo: null, observedAt, freshnessExpiresAt: observedAt });
    database.connection.prepare(`
      INSERT INTO claim_relations(id, source_claim_id, target_claim_id, relation_type, confidence, created_at)
      VALUES (?, ?, ?, 'contradicts', 0.95, ?)
    `).run(uuidv7(), current.id, conflicted.id, observedAt);

    const sourceId = database.createSource({ type: "document", title: "Exact chunks", contentHash: "exact-chunks" });
    const ordinaryChunkId = uuidv7();
    const targetChunkId = uuidv7();
    const insertChunk = database.connection.prepare(`
      INSERT INTO source_chunks(id, source_id, ordinal, text_content, location_json, token_count, content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `);
    insertChunk.run(ordinaryChunkId, sourceId, 0, "ordinary material", JSON.stringify({ page: 1 }), "ordinary-hash", observedAt);
    insertChunk.run(targetChunkId, sourceId, 1, "chunk-evidence-canary", JSON.stringify({ page: 2 }), "target-hash", observedAt);
    const staleSourceId = database.createSource({ type: "web", title: "Expired web source", contentHash: "expired-web-source", freshnessClass: "news", provenance: { freshnessExpiresAt: observedAt } });
    database.addSourceChunks(staleSourceId, [{ text: "dynamic-web-expiry-canary", location: { line: 1 } }]);

    const question = database.appendEvent({ role: "user", content: "Search exact memory evidence and trace contradictions." });
    const run = database.createRun(question.id, "balanced");
    const lifecycle = { started: () => undefined, completed: () => undefined };
    const call = async (name: string, argumentsValue: Record<string, unknown>) => {
      const output = await new LocalToolRuntime(database, question.content).execute(
        { callId: crypto.randomUUID(), name, arguments: argumentsValue }, run.id, question.id,
        new AbortController().signal, lifecycle
      );
      return JSON.parse((JSON.parse(output) as { data: { content: string } }).data.content) as Array<Record<string, unknown>>;
    };

    const conflicts = await call("search_memory", { query: "Status-probe", filters: { types: ["claim"], statuses: ["conflicted"] }, limit: 20 });
    expect(conflicts.map((item) => item.id)).toEqual([conflicted.id]);
    expect(conflicts[0]?.status).toBe("conflicted");
    const expiredOnly = await call("search_memory", { query: "Status-probe", filters: { types: ["claim"], statuses: ["expired"] }, limit: 20 });
    expect(expiredOnly.map((item) => item.id)).toEqual(expect.arrayContaining([expired.id, dynamicallyExpired.id]));
    const staleSources = await call("search_memory", { query: "dynamic-web-expiry-canary", filters: { types: ["source"], statuses: ["expired"] }, limit: 20 });
    expect(staleSources).toContainEqual(expect.objectContaining({ id: staleSourceId, status: "expired", location: expect.objectContaining({ sourceId: staleSourceId }) }));
    const currentSources = await call("search_memory", { query: "dynamic-web-expiry-canary", filters: { types: ["source"], statuses: ["current"] }, limit: 20 });
    expect(currentSources).toEqual([]);
    expect(database.search("dynamic-web-expiry-canary", 20, { types: ["source"], status: "current" })).toEqual([]);
    expect(database.search("dynamic-web-expiry-canary", 20, { types: ["source"], status: "superseded" })).toContainEqual(expect.objectContaining({ id: staleSourceId, tags: expect.arrayContaining(["expired"]) }));
    expect(database.graph(dynamicallyExpired.id, 50, 1, true).nodes).toContainEqual(expect.objectContaining({ id: dynamicallyExpired.id, status: "expired" }));

    const chunks = await call("search_memory", { query: "chunk-evidence-canary", filters: { types: ["source"] }, limit: 20 });
    expect(chunks).toContainEqual(expect.objectContaining({
      id: sourceId,
      sourceIds: expect.arrayContaining([sourceId, targetChunkId]),
      location: expect.objectContaining({ evidenceId: targetChunkId })
    }));

    const trace = await call("trace_claim", { claimId: current.id });
    expect(trace).toContainEqual(expect.objectContaining({ id: conflicted.id, type: "claim", location: expect.objectContaining({ relationType: "contradicts" }) }));
    expect(trace).toContainEqual(expect.objectContaining({ id: conflictEvidence.id, type: "event", location: expect.objectContaining({ relationType: "contradicts", relatedClaimId: conflicted.id }) }));
  });

  it("only offers workspace and sandbox capabilities for explicit, authorized intent", async () => {
    const { root, database } = await fixture();
    const workspace = join(root, "workspace");
    await (await import("node:fs/promises")).mkdir(workspace);
    await writeFile(join(workspace, "notes.txt"), "workspace canary", { mode: 0o600 });
    const canonical = await realpath(workspace);
    const rootId = database.authorizeWorkspace(canonical, "Fixture workspace");
    const parent = database.appendEvent({ role: "user", content: "Read the project file notes.txt." });
    const run = database.createRun(parent.id, "balanced");

    const ordinary = new LocalToolRuntime(database, "Tell me a joke.");
    expect(ordinary.definitions.map((definition) => definition.name)).not.toContain("workspace_read");
    expect(ordinary.definitions.map((definition) => definition.name)).not.toContain("execute_code");

    const workspaceRuntime = new LocalToolRuntime(database, parent.content);
    expect(workspaceRuntime.definitions.map((definition) => definition.name)).toContain("workspace_read");
    expect(workspaceRuntime.definitions.find((definition) => definition.name === "workspace_read")?.description).toContain(rootId);
    expect(workspaceRuntime.definitions.find((definition) => definition.name === "workspace_read")?.description).toContain("Fixture workspace");
    expect(workspaceRuntime.definitions.find((definition) => definition.name === "workspace_read")?.description).not.toContain(canonical);
    const output = await workspaceRuntime.execute(
      { callId: "provider-call-2", name: "workspace_read", arguments: { rootId, path: "notes.txt" } },
      run.id,
      parent.id,
      new AbortController().signal,
      { started: () => undefined, completed: () => undefined }
    );
    expect(output).toContain("workspace canary");
    expect(output).toContain(`continuum-workspace://${rootId}/notes.txt`);
    expect(output).not.toContain(canonical);

    const listed = await workspaceRuntime.execute(
      { callId: "provider-call-list", name: "workspace_list", arguments: { rootId, limit: 10 } },
      run.id, parent.id, new AbortController().signal,
      { started: () => undefined, completed: () => undefined }
    );
    const searched = await workspaceRuntime.execute(
      { callId: "provider-call-search", name: "workspace_search", arguments: { rootId, query: "workspace canary", limit: 10 } },
      run.id, parent.id, new AbortController().signal,
      { started: () => undefined, completed: () => undefined }
    );
    expect(`${listed}\n${searched}`).not.toContain(canonical);
    expect(searched).toContain(`continuum-workspace://${rootId}/notes.txt`);

    expect(new LocalToolRuntime(database, "Read package.json and summarize it.").definitions.map((definition) => definition.name)).toContain("workspace_read");
    expect(new LocalToolRuntime(database, "Inspect src/index.ts for the entry point.").definitions.map((definition) => definition.name)).toContain("workspace_read");

    const sandboxRuntime = new LocalToolRuntime(database, "Execute this Python code to test the result.");
    expect(sandboxRuntime.definitions.map((definition) => definition.name)).toContain("execute_code");
    expect(new LocalToolRuntime(database, "Use Python to calculate the first 20 primes.").definitions.map((definition) => definition.name)).toContain("execute_code");
  });

  it("does not let provider-generated flags override workspace exclusions without explicit current-user intent", async () => {
    const { root, database } = await fixture();
    const workspace = join(root, "override-workspace");
    await (await import("node:fs/promises")).mkdir(workspace);
    await writeFile(join(workspace, ".gitignore"), "ignored.txt\n");
    await writeFile(join(workspace, "ignored.txt"), "excluded canary");
    const rootId = database.authorizeWorkspace(await realpath(workspace), "Override fixture");
    const parent = database.appendEvent({ role: "user", content: "List the project files." });
    const run = database.createRun(parent.id, "balanced");
    const lifecycle = { started: () => undefined, completed: () => undefined };
    const denied = await new LocalToolRuntime(database, parent.content).execute(
      { callId: crypto.randomUUID(), name: "workspace_list", arguments: { rootId, recursive: true, includeIgnored: true } },
      run.id, parent.id, new AbortController().signal, lifecycle
    );
    expect(denied).toContain("NOT_AUTHORIZED");
    expect(denied).not.toContain("excluded canary");

    const explicit = database.appendEvent({ role: "user", content: "List the gitignored files in the project." });
    const explicitRun = database.createRun(explicit.id, "balanced");
    const allowed = await new LocalToolRuntime(database, explicit.content).execute(
      { callId: crypto.randomUUID(), name: "workspace_list", arguments: { rootId, recursive: true, includeIgnored: true } },
      explicitRun.id, explicit.id, new AbortController().signal, lifecycle
    );
    expect(allowed).toContain("ignored.txt");
  });

  it("requires an exact unexpired one-use grant for secret-like workspace files", async () => {
    const { root, database } = await fixture();
    const workspace = join(root, "secret-workspace");
    await (await import("node:fs/promises")).mkdir(workspace);
    await writeFile(join(workspace, "secrets.txt"), "one-use canary", { mode: 0o600 });
    await writeFile(join(workspace, "other-secret.txt"), "wrong canary", { mode: 0o600 });
    const rootId = database.authorizeWorkspace(await realpath(workspace), "Secret fixture");
    const parent = database.appendEvent({ role: "user", content: "Read the workspace secret file secrets.txt." });
    const run = database.createRun(parent.id, "balanced");
    const grants = new OneUseWorkspaceSecretGrants();
    const lifecycle = { started: () => undefined, completed: () => undefined };
    const execute = (path: string) => new LocalToolRuntime(database, parent.content, grants).execute(
      { callId: crypto.randomUUID(), name: "workspace_read", arguments: { rootId, path, allowLikelySecret: true } },
      run.id,
      parent.id,
      new AbortController().signal,
      lifecycle
    );

    expect(await execute("secrets.txt")).toContain("SECRET_BLOCKED");
    grants.grant(rootId, "secrets.txt");
    expect(await execute("other-secret.txt")).toContain("SECRET_BLOCKED");
    const approvedOutput = await execute("secrets.txt");
    expect(approvedOutput).toContain("one-use canary");
    expect((JSON.parse(approvedOutput) as { data: { metadata: { sensitiveContent: boolean } } }).data.metadata.sensitiveContent).toBe(true);
    expect(await execute("secrets.txt")).toContain("SECRET_BLOCKED");

    grants.grant(rootId, "secrets.txt", 0);
    expect(await execute("secrets.txt")).toContain("SECRET_BLOCKED");
    expect(() => grants.grant(rootId, "../secrets.txt")).toThrow(/traversal/i);
    const readDefinition = new LocalToolRuntime(database, parent.content, grants).definitions.find((definition) => definition.name === "workspace_read");
    expect(readDefinition?.parameters).toMatchObject({ properties: { allowLikelySecret: { type: "boolean" } } });
  });
});
