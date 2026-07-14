import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { run, terminate, waitForExit, waitForHealth } from "./processes.js";

const apiPort = 4317;
const supervisorPort = 4318;
const apiControlPort = 4319;
const webPort = 4400;
const token = "continuum-e2e-session-token-0000000000000000";
const controlToken = "continuum-e2e-control-token-00000000000000";
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const webOrigin = `http://127.0.0.1:${webPort}`;
const root = process.cwd();
const webRoot = resolve(root, "apps", "web");
const dataDir = resolve(root, ".continuum", "playwright");
const role = process.env.CONTINUUM_E2E_ROLE;

const env = {
  ...process.env,
  CONTINUUM_DATA_DIR: dataDir,
  CONTINUUM_HOST: "127.0.0.1",
  CONTINUUM_PORT: String(apiPort),
  CONTINUUM_SESSION_TOKEN: token,
  CONTINUUM_WEB_ORIGIN: webOrigin,
  CONTINUUM_MOCK_PROVIDER: "true",
  CONTINUUM_E2E_CONTROL_PORT: String(apiControlPort),
  CONTINUUM_E2E_CONTROL_TOKEN: controlToken,
  VITE_CONTINUUM_API_ORIGIN: apiOrigin,
  NODE_ENV: "production"
};

if (role === "api") await serveApiChild();
else await serveSupervisor();

async function serveApiChild(): Promise<void> {
  if (process.env.CONTINUUM_MOCK_PROVIDER !== "true") throw new Error("The E2E control API refuses to run without the no-cost mock provider.");
  const [{ buildApp }, { LocalToolRuntime }, { uuidv7 }, { stableHash }] = await Promise.all([
    import("../apps/api/src/app.js"),
    import("../apps/api/src/tool-runtime.js"),
    import("../packages/database/src/index.js"),
    import("../packages/config/src/index.js")
  ]);
  const { app, services } = await buildApp();
  const database = services.database;

  const control = createServer((request, response) => {
    void handleApiControl(request, response).catch((error: unknown) => {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Unknown test-control failure." });
    });
  });

  async function handleApiControl(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!authorizedControlRequest(request)) {
      sendJson(response, 401, { error: "Unauthorized." });
      return;
    }
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${apiControlPort}`);
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { ok: true, pid: process.pid, mockProvider: services.config.mockProvider });
      return;
    }
    if (request.method !== "POST") {
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }
    const body = await readJsonBody(request);

    if (url.pathname === "/seed-pending-run") {
      const content = boundedString(body.content, "content", 20_000);
      const created = database.createMessageAndRun({
        content,
        attachmentIds: [],
        quality: "balanced",
        idempotencyKey: boundedString(body.idempotencyKey ?? `e2e-pending-${randomUUID()}`, "idempotencyKey", 200)
      });
      sendJson(response, 200, created);
      return;
    }

    if (url.pathname === "/seed-recovery-run") {
      const content = boundedString(body.content ?? "API crash recovery marker", "content", 20_000);
      const created = database.createMessageAndRun({
        content,
        attachmentIds: [],
        quality: "balanced",
        idempotencyKey: boundedString(body.idempotencyKey ?? `e2e-recovery-${randomUUID()}`, "idempotencyKey", 200)
      });
      if (!database.claimRunForExecution(created.runId)) throw new Error("Could not claim the recovery fixture run.");
      const partial = "Persisted partial response before an intentional API crash.";
      const assistant = database.appendEvent({
        role: "assistant",
        kind: "message",
        status: "streaming",
        content: partial,
        parentEventId: created.event.id,
        runId: created.runId
      });
      database.setRunStatus(created.runId, "streaming", { assistantEventId: assistant.id });
      database.appendRunStreamEvent(created.runId, { type: "run.started", runId: created.runId });
      database.appendRunStreamEvent(created.runId, { type: "response.delta", runId: created.runId, eventId: assistant.id, delta: partial });
      sendJson(response, 200, { ...created, assistantEventId: assistant.id });
      return;
    }

    if (url.pathname === "/seed-memory-fixture") {
      const marker = boundedString(body.marker ?? randomUUID(), "marker", 200);
      const recordedAt = new Date().toISOString();
      const primaryEvidence = database.appendEvent({
        role: "user",
        kind: "message",
        status: "complete",
        content: `Graph evidence ${marker}: Atlas Platform is owned by Northstar Team.`
      });
      const legacyEvidence = database.appendEvent({
        role: "user",
        kind: "message",
        status: "complete",
        content: `Graph evidence ${marker}: Atlas Platform Legacy is maintained by Northstar Team.`
      });
      const targetEntityId = uuidv7();
      const sourceEntityId = uuidv7();
      const ownerEntityId = uuidv7();
      const insertEntity = database.connection.prepare(`
        INSERT INTO entities(id, core_type, display_name, normalized_name, status, canonical_description, created_at, updated_at)
        VALUES (?, 'organization', ?, ?, 'active', ?, ?, ?)
      `);
      insertEntity.run(targetEntityId, "Atlas Platform", "atlas platform", "Canonical product organization.", recordedAt, recordedAt);
      insertEntity.run(sourceEntityId, "Atlas Platform Legacy", "atlas platform legacy", "Legacy spelling retained for merge review.", recordedAt, recordedAt);
      insertEntity.run(ownerEntityId, "Northstar Team", "northstar team", "Owning team.", recordedAt, recordedAt);
      const insertAlias = database.connection.prepare(`
        INSERT INTO entity_aliases(id, entity_id, alias, normalized_alias, confidence, source_id, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      `);
      insertAlias.run(uuidv7(), targetEntityId, "Atlas Platform", "atlas platform", 1, primaryEvidence.id, recordedAt);
      insertAlias.run(uuidv7(), sourceEntityId, "Atlas Platform Legacy", "atlas platform legacy", 1, legacyEvidence.id, recordedAt);
      insertAlias.run(uuidv7(), ownerEntityId, "Northstar Team", "northstar team", 1, primaryEvidence.id, recordedAt);
      const claim = database.upsertClaim({
        topicId: null,
        subject: "Atlas Platform",
        predicate: "owned by",
        value: "Northstar Team",
        confidence: 0.98,
        status: "current",
        sourceRole: "user",
        sourceIds: [primaryEvidence.id],
        validFrom: recordedAt,
        validTo: null,
        observedAt: recordedAt,
        freshnessExpiresAt: null,
        extractionVersion: "e2e-fixture-v1"
      });
      const targetEdgeId = uuidv7();
      const sourceEdgeId = uuidv7();
      const insertEdge = database.connection.prepare(`
        INSERT INTO edges(id, source_id, target_id, edge_type, label, status, evidence_json, valid_from, valid_to, created_at)
        VALUES (?, ?, ?, ?, ?, 'current', ?, ?, NULL, ?)
      `);
      insertEdge.run(targetEdgeId, targetEntityId, ownerEntityId, "owned_by", "owned by", JSON.stringify([primaryEvidence.id]), recordedAt, recordedAt);
      insertEdge.run(sourceEdgeId, sourceEntityId, ownerEntityId, "maintained_by", "maintained by", JSON.stringify([legacyEvidence.id]), recordedAt, recordedAt);
      sendJson(response, 200, {
        primaryEvidenceId: primaryEvidence.id,
        legacyEvidenceId: legacyEvidence.id,
        claimId: claim.id,
        targetEntityId,
        sourceEntityId,
        ownerEntityId,
        targetEdgeId,
        sourceEdgeId
      });
      return;
    }

    if (url.pathname === "/tool-execute") {
      const userRequest = boundedString(body.userRequest, "userRequest", 20_000);
      const name = boundedString(body.name, "name", 100);
      const parent = database.appendEvent({ role: "user", kind: "message", status: "complete", content: userRequest });
      const run = database.createRun(parent.id, "balanced");
      if (!database.claimRunForExecution(run.id)) throw new Error("Could not claim the tool fixture run.");
      const runtime = new LocalToolRuntime(database, userRequest, services.secretGrants);
      const output = await runtime.execute(
        { callId: `e2e-tool-${randomUUID()}`, name, arguments: body.arguments ?? {} },
        run.id,
        parent.id,
        new AbortController().signal,
        { started: () => undefined, completed: () => undefined }
      );
      database.setRunStatus(run.id, "complete");
      const tool = database.connection.prepare(`
        SELECT id, status, sandbox_json AS sandbox, output_text AS output
        FROM tool_executions WHERE run_id = ? ORDER BY started_at DESC LIMIT 1
      `).get(run.id) as Record<string, unknown> | undefined;
      sendJson(response, 200, {
        runId: run.id,
        parentEventId: parent.id,
        offeredTools: runtime.definitions.map((definition) => definition.name),
        output,
        tool: tool ? { ...tool, sandbox: parseStoredJson(tool.sandbox), output: String(tool.output ?? "") } : null
      });
      return;
    }

    if (url.pathname === "/seed-expired-job") {
      const idempotencyKey = boundedString(body.idempotencyKey, "idempotencyKey", 200);
      const existing = database.connection.prepare("SELECT * FROM jobs WHERE idempotency_key = ?").get(idempotencyKey) as Record<string, unknown> | undefined;
      if (existing) {
        sendJson(response, 200, {
          jobId: String(existing.id),
          sourceId: parseStoredJson(existing.payload_json).sourceId,
          existing: true
        });
        return;
      }
      const event = database.appendEvent({
        role: "user",
        kind: "message",
        status: "complete",
        content: `Worker crash recovery vector marker ${idempotencyKey}.`
      });
      const contentHash = stableHash(event.content);
      const job = database.enqueueJob("embedding.index", idempotencyKey, {
        sourceId: event.id,
        sourceType: "event",
        model: services.config.models.embedding,
        contentHash
      }, 1_000);
      const leased = database.leaseJob("e2e-worker-before-crash", 1, ["embedding.index"]);
      if (!leased || leased.id !== job.id) throw new Error("The crash fixture job was not leased deterministically.");
      database.connection.prepare("UPDATE jobs SET lease_expires_at = ? WHERE id = ?").run(new Date(Date.now() - 1_000).toISOString(), job.id);
      sendJson(response, 200, { jobId: job.id, sourceId: event.id, existing: false });
      return;
    }

    if (url.pathname === "/inspect") {
      const kind = boundedString(body.kind, "kind", 40);
      if (kind === "run") {
        const runId = boundedString(body.runId, "runId", 100);
        const run = database.connection.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as Record<string, unknown> | undefined;
        if (!run) throw new Error("Run not found.");
        const userEventId = String(run.user_event_id);
        const counts = database.connection.prepare(`
          SELECT
            (SELECT COUNT(*) FROM runs WHERE id = ?) AS runs,
            (SELECT COUNT(*) FROM events WHERE id = ?) AS users,
            (SELECT COUNT(*) FROM events WHERE parent_event_id = ? AND role = 'assistant') AS assistants,
            (SELECT COUNT(*) FROM run_stream_events WHERE run_id = ?) AS streamEvents
        `).get(runId, userEventId, userEventId, runId) as Record<string, unknown>;
        const assistant = database.connection.prepare("SELECT id, status, active, completed_at FROM events WHERE parent_event_id = ? AND role = 'assistant' ORDER BY sequence").all(userEventId);
        sendJson(response, 200, { run, counts, assistant });
        return;
      }
      if (kind === "job") {
        const jobId = boundedString(body.jobId, "jobId", 100);
        const sourceId = boundedString(body.sourceId, "sourceId", 100);
        const job = database.connection.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as Record<string, unknown> | undefined;
        if (!job) throw new Error("Job not found.");
        const counts = database.connection.prepare(`
          SELECT
            (SELECT COUNT(*) FROM jobs WHERE idempotency_key = ?) AS jobs,
            (SELECT COUNT(*) FROM job_attempts WHERE job_id = ?) AS attempts,
            (SELECT COUNT(*) FROM vectors WHERE source_id = ? AND source_type = 'event') AS vectors
        `).get(job.idempotency_key, jobId, sourceId) as Record<string, unknown>;
        const attempts = database.connection.prepare("SELECT attempt_number AS attemptNumber, worker_id AS workerId, status, completed_at AS completedAt FROM job_attempts WHERE job_id = ? ORDER BY attempt_number").all(jobId);
        sendJson(response, 200, { job, counts, attempts });
        return;
      }
      throw new Error("Unknown inspection kind.");
    }

    sendJson(response, 404, { error: "Unknown test-control operation." });
  }

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    control.close();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void close());
  process.on("SIGTERM", () => void close());

  await app.listen({ host: services.config.host, port: services.config.port });
  await listen(control, "127.0.0.1", apiControlPort);
  services.logger.info("Continuum E2E API child started", { origin: services.config.apiOrigin, pid: process.pid });
  await new Promise<void>(() => undefined);
}

async function serveSupervisor(): Promise<void> {
  await rm(dataDir, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true, mode: 0o700 });

  const vite = resolve(webRoot, "node_modules", ".bin", "vite");
  const build = run(vite, ["build"], { env, cwd: webRoot });
  await waitForExit(build, "E2E web build");

  let api: ChildProcess | null = null;
  let worker: ChildProcess | null = null;
  let stopping = false;
  let rejectFatal: (error: Error) => void = () => undefined;
  const fatal = new Promise<never>((_resolve, reject) => { rejectFatal = reject; });

  const watch = (kind: "api" | "worker" | "web", child: ChildProcess) => {
    child.once("error", (error) => rejectFatal(error));
    child.once("exit", (code, signal) => {
      if (stopping) return;
      if (kind === "api" && api !== child) return;
      if (kind === "worker" && worker !== child) return;
      rejectFatal(new Error(`E2E ${kind} exited with ${signal ?? `code ${code ?? "unknown"}`}.`));
    });
  };

  const startApi = async () => {
    if (api) throw new Error("The E2E API is already running.");
    const child = run(process.execPath, ["--import", "tsx", resolve(root, "scripts/e2e-server.ts")], {
      env: { ...env, CONTINUUM_E2E_ROLE: "api" },
      cwd: dataDir
    });
    api = child;
    watch("api", child);
    try {
      await waitForHealth(apiOrigin, token, 60_000);
      await waitForControlHealth();
    } catch (error) {
      if (api === child) api = null;
      child.kill("SIGKILL");
      throw error;
    }
  };

  const startWorker = async () => {
    if (worker) throw new Error("The E2E worker is already running.");
    const child = run(process.execPath, ["--import", "tsx", resolve(root, "apps/worker/src/worker.ts")], { env, cwd: dataDir });
    worker = child;
    watch("worker", child);
  };

  await startApi();
  await startWorker();
  // Serve the immutable production bundle that was just built. A development
  // server would hot-reload pages when another parallel task edits source,
  // making release journeys nondeterministic and testing a different artifact.
  const viteServer = run(vite, ["preview", "--host", "127.0.0.1", "--port", String(webPort), "--strictPort"], { env, cwd: webRoot });
  watch("web", viteServer);

  let operation = Promise.resolve();
  const supervisor = createServer((request, response) => {
    operation = operation.then(async () => {
      if (!authorizedControlRequest(request)) {
        sendJson(response, 401, { error: "Unauthorized." });
        return;
      }
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${supervisorPort}`);
      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true, api: Boolean(api), worker: Boolean(worker) });
        return;
      }
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "Method not allowed." });
        return;
      }
      if (url.pathname === "/crash-api") {
        await crashChild("api");
        sendJson(response, 200, { crashed: true });
        return;
      }
      if (url.pathname === "/restart-api") {
        await startApi();
        sendJson(response, 200, { restarted: true });
        return;
      }
      if (url.pathname === "/crash-worker") {
        await crashChild("worker");
        sendJson(response, 200, { crashed: true });
        return;
      }
      if (url.pathname === "/restart-worker") {
        await startWorker();
        sendJson(response, 200, { restarted: true });
        return;
      }
      if (url.pathname === "/workspace-fixture") {
        const fixtureRoot = resolve(dataDir, "workspace-fixture");
        const outsidePath = resolve(dataDir, "outside-workspace-canary.txt");
        await rm(fixtureRoot, { recursive: true, force: true });
        await mkdir(fixtureRoot, { recursive: true, mode: 0o700 });
        await writeFile(resolve(fixtureRoot, "notes.txt"), "Authorized workspace canary: juniper.\n", { mode: 0o600 });
        await writeFile(resolve(fixtureRoot, "secrets.txt"), "ONE_USE_SECRET_CANARY=violet\n", { mode: 0o600 });
        await writeFile(outsidePath, "OUTSIDE_WORKSPACE_CANARY=scarlet\n", { mode: 0o600 });
        await symlink(outsidePath, resolve(fixtureRoot, "escape.txt"));
        sendJson(response, 200, { root: await realpath(fixtureRoot), outsidePath });
        return;
      }
      sendJson(response, 404, { error: "Unknown supervisor operation." });
    }).catch((error: unknown) => {
      sendJson(response, 500, { error: error instanceof Error ? error.message : "Unknown supervisor failure." });
    });
  });

  async function crashChild(kind: "api" | "worker"): Promise<void> {
    const child = kind === "api" ? api : worker;
    if (!child) throw new Error(`The E2E ${kind} is not running.`);
    if (kind === "api") api = null;
    else worker = null;
    child.kill("SIGKILL");
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
  }

  await listen(supervisor, "127.0.0.1", supervisorPort);
  const close = () => {
    if (stopping) return;
    stopping = true;
    supervisor.close();
    terminate([api, worker, viteServer].filter((child): child is ChildProcess => Boolean(child)));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);

  try {
    process.stdout.write(`Mock Continuum E2E UI ready at ${webOrigin}; API at ${apiOrigin}; guarded control at http://127.0.0.1:${supervisorPort}\n`);
    await fatal;
  } finally {
    close();
  }
}

function authorizedControlRequest(request: IncomingMessage): boolean {
  return request.headers["x-continuum-e2e-control"] === controlToken;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 1_000_000) throw new Error("Test-control payload is too large.");
    chunks.push(bytes);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Test-control payload must be an object.");
  return parsed as Record<string, unknown>;
}

function boundedString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new Error(`${name} must be a non-empty string no longer than ${maximum} characters.`);
  return value;
}

function parseStoredJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  if (response.headersSent || response.destroyed) return;
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
    "Cache-Control": "no-store"
  });
  response.end(body);
}

async function listen(server: Server, host: string, port: number): Promise<void> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen({ host, port }, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
}

async function waitForControlHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${apiControlPort}/health`, {
        headers: { "X-Continuum-E2E-Control": controlToken }
      });
      if (response.ok) return;
      lastError = new Error(`API control health returned ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw lastError instanceof Error ? lastError : new Error("The E2E API control did not become ready.");
}
