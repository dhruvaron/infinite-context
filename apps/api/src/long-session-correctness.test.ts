import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, stableHash, type AppConfig } from "@continuum/config";
import type { ContinuumDatabase } from "@continuum/database";
import { buildApp } from "./app.js";

type Fixture = {
  root: string;
  config: AppConfig;
  app: FastifyInstance;
  database: ContinuumDatabase;
};

const fixtures: Fixture[] = [];

async function fixture(label: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `continuum-api-correctness-${label}-`));
  const config = loadConfig({
    NODE_ENV: "test",
    CONTINUUM_DATA_DIR: root,
    CONTINUUM_MOCK_PROVIDER: "true",
    CONTINUUM_SESSION_TOKEN: "long-session-correctness-token-000000000000"
  });
  const { app, services } = await buildApp({ config });
  const value = { root, config, app, database: services.database };
  fixtures.push(value);
  return value;
}

function headers(value: Fixture, mutation = false): Record<string, string> {
  return {
    authorization: `Bearer ${value.config.sessionToken}`,
    host: "127.0.0.1",
    ...(mutation ? { "x-continuum-request": "1" } : {})
  };
}

function multipart(filename: string, mediaType: string, content: Buffer): { boundary: string; body: Buffer } {
  const boundary = "----continuum-idempotency-test-boundary";
  return {
    boundary,
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mediaType}\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ])
  };
}

afterEach(async () => {
  while (fixtures.length) {
    const value = fixtures.pop()!;
    await value.app.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

describe("long-session API correctness", () => {
  it("walks the complete event timeline with sequence cursors and no duplicate boundary row", async () => {
    const value = await fixture("event-cursors");
    for (let index = 0; index < 620; index += 1) {
      value.database.appendEvent({ role: "user", content: `timeline record ${index}` });
    }

    const sequences: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const suffix = cursor === null ? "" : `&cursor=${cursor}`;
      const response = await value.app.inject({
        method: "GET",
        url: `/api/v1/events?limit=137${suffix}`,
        headers: headers(value)
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { events: Array<{ sequence: number }>; nextCursor: string | null };
      expect(body.events.length).toBeGreaterThan(0);
      sequences.push(...body.events.map((event) => event.sequence));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor !== null);

    expect(pages).toBe(5);
    expect(sequences).toHaveLength(620);
    expect(new Set(sequences).size).toBe(620);
    expect([...sequences].sort((left, right) => left - right)).toEqual(
      Array.from({ length: 620 }, (_, index) => index + 1)
    );
  });

  it("keeps offset topic pages stable beyond the first 500 rows", async () => {
    const value = await fixture("topic-cursors");
    for (let index = 0; index < 620; index += 1) {
      value.database.upsertTopicRevision({
        type: "project",
        title: `Scale topic ${index}`,
        slug: `scale-topic-${index}`,
        markdown: `# Scale topic ${index}\n\nlong-session pagination marker`,
        summary: `Topic ${index}`,
        currentState: "active",
        history: "created for pagination verification",
        authorType: "user",
        promptVersion: "long-session-test-v1"
      });
    }

    const first = await value.app.inject({ method: "GET", url: "/api/v1/topics?limit=500", headers: headers(value) });
    expect(first.statusCode).toBe(200);
    const firstBody = first.json() as { topics: Array<{ id: string }>; nextCursor: string | null };
    expect(firstBody.topics).toHaveLength(500);
    expect(firstBody.nextCursor).toBe("500");

    const second = await value.app.inject({ method: "GET", url: `/api/v1/topics?limit=500&cursor=${firstBody.nextCursor}`, headers: headers(value) });
    expect(second.statusCode).toBe(200);
    const secondBody = second.json() as { topics: Array<{ id: string }>; nextCursor: string | null };
    expect(secondBody.topics).toHaveLength(120);
    expect(secondBody.nextCursor).toBeNull();
    expect(new Set([...firstBody.topics, ...secondBody.topics].map((topic) => topic.id)).size).toBe(620);
  });

  it("searches through every result after cursor 500 without gaps or replayed rows", async () => {
    const value = await fixture("search-cursors");
    const strongest = value.database.appendEvent({
      role: "user",
      content: `${"deepsearch ".repeat(12)}focused record`
    });
    for (let index = 1; index < 620; index += 1) {
      value.database.appendEvent({ role: "user", content: `deepsearch marker record ${index}` });
    }

    const ids: string[] = [];
    const observedCursors: number[] = [];
    let cursor: string | null = null;
    do {
      const suffix = cursor === null ? "" : `&cursor=${cursor}`;
      const response = await value.app.inject({
        method: "GET",
        url: `/api/v1/search?q=deepsearch&types=event&limit=80${suffix}`,
        headers: headers(value)
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { results: Array<{ id: string }>; nextCursor: string | null };
      ids.push(...body.results.map((result) => result.id));
      cursor = body.nextCursor;
      if (cursor !== null) observedCursors.push(Number(cursor));
    } while (cursor !== null);

    expect(observedCursors).toContain(560);
    expect(ids).toHaveLength(620);
    expect(new Set(ids).size).toBe(620);
    expect(ids[0]).toBe(strongest.id);
  });

  it("replays an attachment upload without duplicating logical or physical state", async () => {
    const value = await fixture("upload-replay");
    const upload = multipart("replay.txt", "text/plain", Buffer.from("idempotent upload content"));
    const idempotencyKey = "replayed-upload-key";
    const request = () => value.app.inject({
      method: "POST",
      url: "/api/v1/attachments",
      headers: {
        ...headers(value, true),
        "content-type": `multipart/form-data; boundary=${upload.boundary}`,
        "idempotency-key": idempotencyKey
      },
      payload: upload.body
    });

    const first = await request();
    const replay = await request();
    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(first.json());
    expect(first.json()).not.toHaveProperty("storagePath");
    expect(value.database.connection.prepare("SELECT COUNT(*) AS count FROM attachments").get()).toEqual({ count: 1 });
    expect(value.database.connection.prepare("SELECT COUNT(*) AS count FROM sources").get()).toEqual({ count: 1 });
    expect(value.database.connection.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type = 'source.extract'").get()).toEqual({ count: 1 });
    expect(value.database.connection.prepare("SELECT COUNT(*) AS count FROM idempotency_keys WHERE key = ? AND operation = 'attachments.upload'").get(idempotencyKey)).toEqual({ count: 1 });
    const stored = value.database.connection.prepare("SELECT storage_path AS path FROM attachments").get() as { path: string };
    await expect(readFile(stored.path, "utf8")).resolves.toBe("idempotent upload content");
  });

  it("recovers allowlisted committed mutations read-only after a client loses each response", async () => {
    const value = await fixture("mutation-recovery");
    const messageKey = "committed-message-response-loss";
    const messageRequest = {
      content: "Persist exactly once even when the response disappears.",
      attachmentIds: [],
      quality: "balanced",
      idempotencyKey: messageKey
    };
    // The client intentionally ignores this successful response, modeling a
    // connection loss after SQLite commit but before acknowledgement arrives.
    const committedMessage = await value.app.inject({ method: "POST", url: "/api/v1/messages", headers: headers(value, true), payload: messageRequest });
    expect(committedMessage.statusCode).toBe(202);
    const messageRecovery = await value.app.inject({
      method: "GET",
      url: `/api/v1/idempotency-recovery?operation=messages.create&key=${encodeURIComponent(messageKey)}`,
      headers: headers(value)
    });
    expect(messageRecovery.statusCode).toBe(200);
    expect(messageRecovery.json()).toMatchObject({ found: true, operation: "messages.create", result: { event: { content: messageRequest.content } } });
    const recoveredMessage = messageRecovery.json() as { result: { event: { id: string }; runId: string } };
    const replayedMessage = await value.app.inject({ method: "POST", url: "/api/v1/messages", headers: headers(value, true), payload: messageRequest });
    expect(replayedMessage.json()).toMatchObject({ event: { id: recoveredMessage.result.event.id }, runId: recoveredMessage.result.runId });
    expect(value.database.connection.prepare("SELECT COUNT(*) AS count FROM events WHERE role = 'user' AND id = ?").get(recoveredMessage.result.event.id)).toEqual({ count: 1 });
    expect(value.database.connection.prepare("SELECT COUNT(*) AS count FROM runs WHERE user_event_id = ?").get(recoveredMessage.result.event.id)).toEqual({ count: 1 });

    const uploadKey = "committed-upload-response-loss";
    const upload = multipart("recovered.txt", "text/plain", Buffer.from("one durable upload"));
    const uploadRequest = () => value.app.inject({
      method: "POST",
      url: "/api/v1/attachments",
      headers: { ...headers(value, true), "content-type": `multipart/form-data; boundary=${upload.boundary}`, "idempotency-key": uploadKey },
      payload: upload.body
    });
    const committedUpload = await uploadRequest();
    expect(committedUpload.statusCode).toBe(202);
    const uploadRecovery = await value.app.inject({
      method: "GET",
      url: `/api/v1/idempotency-recovery?operation=attachments.upload&key=${encodeURIComponent(uploadKey)}`,
      headers: headers(value)
    });
    expect(uploadRecovery.statusCode).toBe(200);
    expect(uploadRecovery.json()).toMatchObject({ found: true, operation: "attachments.upload", result: { filename: "recovered.txt" } });
    expect(uploadRecovery.json()).not.toHaveProperty("result.storagePath");
    expect((await uploadRequest()).json()).toEqual(committedUpload.json());
    expect(value.database.connection.prepare("SELECT COUNT(*) AS count FROM attachments WHERE filename = 'recovered.txt'").get()).toEqual({ count: 1 });

    const regenerationKey = "committed-regeneration-response-loss";
    const regenerationRequest = { idempotencyKey: regenerationKey, quality: "deep" };
    const committedRegeneration = await value.app.inject({
      method: "POST",
      url: `/api/v1/events/${recoveredMessage.result.event.id}/regenerate`,
      headers: headers(value, true),
      payload: regenerationRequest
    });
    expect(committedRegeneration.statusCode).toBe(202);
    const regenerationRecovery = await value.app.inject({
      method: "GET",
      url: `/api/v1/idempotency-recovery?operation=events.regenerate&key=${encodeURIComponent(regenerationKey)}`,
      headers: headers(value)
    });
    expect(regenerationRecovery.statusCode).toBe(200);
    expect(regenerationRecovery.json()).toMatchObject({ found: true, operation: "events.regenerate", result: { quality: "deep" } });
    const regeneratedRunId = (regenerationRecovery.json() as { result: { runId: string } }).result.runId;
    const replayedRegeneration = await value.app.inject({ method: "POST", url: `/api/v1/events/${recoveredMessage.result.event.id}/regenerate`, headers: headers(value, true), payload: regenerationRequest });
    expect(replayedRegeneration.json()).toMatchObject({ runId: regeneratedRunId, quality: "deep" });
    expect(value.database.connection.prepare("SELECT COUNT(*) AS count FROM runs WHERE user_event_id = ?").get(recoveredMessage.result.event.id)).toEqual({ count: 2 });

    const unsupported = await value.app.inject({ method: "GET", url: "/api/v1/idempotency-recovery?operation=settings.put&key=not-allowlisted-key", headers: headers(value) });
    expect(unsupported.statusCode).toBe(400);
    const unauthenticated = await value.app.inject({ method: "GET", url: `/api/v1/idempotency-recovery?operation=messages.create&key=${messageKey}`, headers: { host: "127.0.0.1" } });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it("replays topic create and patch independently and binds each embedding job to the written revision", async () => {
    const value = await fixture("topic-replay");
    const idempotencyKey = "shared-topic-operation-key";
    const createBody = {
      type: "project",
      title: "Replay-safe project",
      slug: "replay-safe-project",
      markdown: "# Replay-safe project",
      summary: "Original summary",
      currentState: "planned",
      history: "created once",
      openQuestions: [],
      tags: ["correctness"],
      idempotencyKey
    };
    const create = () => value.app.inject({ method: "POST", url: "/api/v1/topics", headers: headers(value, true), payload: createBody });
    const firstCreate = await create();
    const replayCreate = await create();
    expect(firstCreate.statusCode).toBe(200);
    expect(replayCreate.json()).toEqual(firstCreate.json());
    const topic = firstCreate.json() as { id: string; revision: number };

    const patchBody = { expectedRevision: 1, summary: "Updated exactly once", idempotencyKey };
    const patch = () => value.app.inject({ method: "PATCH", url: `/api/v1/topics/${topic.id}`, headers: headers(value, true), payload: patchBody });
    const firstPatch = await patch();
    const replayPatch = await patch();
    expect(firstPatch.statusCode).toBe(200);
    expect(replayPatch.statusCode).toBe(200);
    expect(replayPatch.json()).toEqual(firstPatch.json());
    expect((firstPatch.json() as { revision: number }).revision).toBe(2);
    expect(value.database.connection.prepare("SELECT COUNT(*) AS count FROM topic_page_revisions WHERE topic_id = ?").get(topic.id)).toEqual({ count: 2 });
    expect(value.database.connection.prepare("SELECT COUNT(*) AS count FROM idempotency_keys WHERE key = ?").get(idempotencyKey)).toEqual({ count: 2 });
    const revisionHashes = (value.database.connection.prepare(`
      SELECT revision_number, markdown FROM topic_page_revisions WHERE topic_id = ? ORDER BY revision_number
    `).all(topic.id) as Array<{ revision_number: number; markdown: string }>)
      .map((revision) => stableHash(revision.markdown))
      .sort();
    const embeddingBindings = value.database.listJobs(100)
      .filter((job) => job.type === "embedding.index" && job.payload.sourceId === topic.id && job.payload.sourceType === "topic")
      .map((job) => String(job.payload.contentHash))
      .sort();
    expect(embeddingBindings).toEqual(revisionHashes);
  });

  it("replays a completed topic deletion after the object is gone and creates one receipt", async () => {
    const value = await fixture("delete-replay");
    const idempotencyKey = "shared-create-delete-key";
    const create = await value.app.inject({
      method: "POST",
      url: "/api/v1/topics",
      headers: headers(value, true),
      payload: {
        type: "project",
        title: "Delete once",
        slug: "delete-once",
        markdown: "# Delete once",
        summary: "Temporary",
        currentState: "temporary",
        history: "",
        openQuestions: [],
        tags: [],
        idempotencyKey
      }
    });
    expect(create.statusCode).toBe(200);
    const topicId = (create.json() as { id: string }).id;
    const impact = await value.app.inject({ method: "POST", url: `/api/v1/topics/${topicId}/deletion-impact`, headers: headers(value, true), payload: {} });
    expect(impact.statusCode).toBe(200);
    const confirmationToken = (impact.json() as { confirmationToken: string }).confirmationToken;
    const remove = () => value.app.inject({
      method: "DELETE",
      url: `/api/v1/topics/${topicId}`,
      headers: headers(value, true),
      payload: { confirmationToken, idempotencyKey }
    });

    const first = await remove();
    const replay = await remove();
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(value.database.getTopic(topicId)).toBeNull();
    expect(value.database.connection.prepare("SELECT COUNT(*) AS count FROM deletion_receipts WHERE object_type = 'topic'").get()).toEqual({ count: 1 });
    expect(value.database.connection.prepare("SELECT COUNT(*) AS count FROM deletion_operations WHERE object_type = 'topic'").get()).toEqual({ count: 1 });
    expect(value.database.connection.prepare(`
      SELECT operation FROM idempotency_keys WHERE key = ? ORDER BY operation
    `).all(idempotencyKey)).toEqual([{ operation: "deletion.topics" }]);
  });

  it("destroys every managed projection and orphaned file beyond the old 500-row boundary", async () => {
    const value = await fixture("full-vault-files");
    const projectionPaths: string[] = [];
    for (let index = 0; index < 620; index += 1) {
      const markdown = `# Destroy topic ${index}`;
      const topic = value.database.upsertTopicRevision({
        type: "project",
        title: `Destroy topic ${index}`,
        slug: `destroy-topic-${index}`,
        markdown,
        summary: "temporary",
        currentState: "temporary",
        history: "",
        authorType: "user",
        promptVersion: "vault-destroy-test-v1"
      });
      const path = join(value.config.projectionsDir, `${topic.id}-${topic.slug}.md`);
      projectionPaths.push(path);
      await writeFile(path, markdown);
    }
    await mkdir(join(value.config.attachmentsDir, "orphan-shard"));
    await writeFile(join(value.config.attachmentsDir, "orphan-shard", "orphan-private-bytes"), "private");
    await writeFile(join(value.config.exportsDir, "continuum-orphan.zip"), "private export");
    await writeFile(join(value.config.logsDir, "trace.jsonl"), '{"prompt":"private"}\n');

    const impact = await value.app.inject({ method: "POST", url: "/api/v1/vault/deletion-impact", headers: headers(value, true), payload: {} });
    expect(impact.statusCode).toBe(200);
    const confirmationToken = (impact.json() as { confirmationToken: string }).confirmationToken;
    const destroyed = await value.app.inject({
      method: "DELETE",
      url: "/api/v1/vault",
      headers: headers(value, true),
      payload: { confirmation: "DELETE MY CONTINUUM VAULT", confirmationToken, idempotencyKey: "full-vault-file-purge-key" }
    });
    expect(destroyed.statusCode).toBe(200);
    expect(value.database.connection.prepare("SELECT COUNT(*) AS count FROM topic_pages").get()).toEqual({ count: 0 });
    expect(await readdir(value.config.projectionsDir)).toEqual([]);
    expect(await readdir(value.config.attachmentsDir)).toEqual([]);
    expect(await readdir(value.config.exportsDir)).toEqual([]);
    expect(await readdir(value.config.logsDir)).toEqual([]);
    await expect(readFile(projectionPaths.at(-1)!, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
