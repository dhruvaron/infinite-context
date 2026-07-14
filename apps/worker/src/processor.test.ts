import { access, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, stableHash, type AppConfig } from "@continuum/config";
import { ContinuumDatabase, uuidv7 } from "@continuum/database";
import { FileSystemContentAddressedStore } from "@continuum/ingestion";
import type { EvidenceClaim, MemoryDelta } from "@continuum/memory";
import { LocalLogger } from "@continuum/observability";
import { ProviderFactory } from "@continuum/providers";
import { compileAffectedTopics, enqueueFreshnessTransitions, JobProcessor, persistEntities, WORKER_JOB_TYPES } from "./processor.js";

const fixtures: Array<{ root: string; database: ContinuumDatabase }> = [];

async function fixture(): Promise<{ database: ContinuumDatabase; processor: JobProcessor; config: AppConfig }> {
  const root = await mkdtemp(join(tmpdir(), "continuum-worker-"));
  const config = loadConfig({
    NODE_ENV: "test",
    CONTINUUM_DATA_DIR: root,
    CONTINUUM_MOCK_PROVIDER: "true",
    CONTINUUM_SESSION_TOKEN: "test-session-token-that-is-at-least-32-characters"
  });
  const database = ContinuumDatabase.open(config);
  fixtures.push({ root, database });
  return {
    database,
    config,
    processor: new JobProcessor(database, config, new ProviderFactory(config), new LocalLogger(config.logsDir))
  };
}

function completedTurn(database: ContinuumDatabase, content: string, attachmentIds: string[] = []) {
  const started = database.createMessageAndRun({ content, attachmentIds, quality: "balanced", idempotencyKey: stableHash(`turn:${content}:${attachmentIds.join(":")}`) });
  const assistant = database.appendEvent({ role: "assistant", kind: "message", status: "complete", content: "Understood.", parentEventId: started.event.id, runId: started.runId });
  database.registerAssistantRevision(started.event.id, assistant.id);
  return { ...started, assistant };
}

function compileJob(database: ContinuumDatabase, runId: string, sourceEventIds: string[]) {
  return database.enqueueJob("memory.compile", stableHash(`compile:${runId}:${sourceEventIds.join(":")}`), { runId, sourceEventIds });
}

function asEvidenceClaim(database: ContinuumDatabase, claimId: string): EvidenceClaim {
  const claim = database.getClaim(claimId, false);
  if (!claim) throw new Error(`Missing claim fixture ${claimId}.`);
  return {
    ...claim,
    recordedAt: claim.observedAt,
    sourceKind: "conversation",
    explicitCorrection: false,
    attributedTo: claim.sourceRole === "assistant" ? "assistant" : null,
    extractionVersion: "test-v1"
  };
}

function deterministicDelta(claims: EvidenceClaim[], affectedTopicHints: string[]): MemoryDelta {
  return {
    entities: [],
    claims,
    relations: [],
    affectedTopicHints,
    trace: {
      promptVersion: "projection-test-v1",
      schemaVersion: "1.0.0",
      providerModel: "deterministic-test",
      inputEventIds: [...new Set(claims.flatMap((claim) => claim.sourceIds))],
      warnings: []
    }
  };
}

async function compileInBatches(processor: JobProcessor, database: ContinuumDatabase, events: Array<{ id: string }>): Promise<void> {
  for (let offset = 0; offset < events.length; offset += 32) {
    await processor.process(compileJob(database, "", events.slice(offset, offset + 32).map((event) => event.id)));
  }
}

afterEach(async () => {
  while (fixtures.length) {
    const value = fixtures.pop()!;
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

describe("worker memory integration", () => {
  it("leases durable projection repair through the worker's shared job-type contract", async () => {
    const { database } = await fixture();
    const queued = database.enqueueJob("projection.sync", stableHash("lease-projection-sync"), { topicIds: [] }, 8);
    const leased = database.leaseJob("projection-test-worker", 30_000, [...WORKER_JOB_TYPES]);
    expect(leased).toMatchObject({ id: queued.id, type: "projection.sync", status: "running" });
  });

  it("publishes the latest committed projection and durably reconciles stale slugs and crashed temporaries", async () => {
    const { database, processor, config } = await fixture();
    const topic = database.upsertTopicRevision({
      type: "project",
      title: "Durable projection",
      slug: "durable-projection-old",
      markdown: "# Durable projection\n\nOld revision.",
      summary: "Old revision.",
      currentState: "Old revision.",
      history: "",
      authorType: "model",
      promptVersion: "projection-test-v1"
    });
    await mkdir(config.projectionsDir, { recursive: true });
    const stalePath = join(config.projectionsDir, `${topic.id}-${topic.slug}.md`);
    const crashedTemporary = join(config.projectionsDir, ".projection-crashed-worker.tmp");
    await writeFile(stalePath, "stale bytes");
    await writeFile(crashedTemporary, "partial bytes");
    const oldTime = new Date(Date.now() - 120_000);
    await utimes(crashedTemporary, oldTime, oldTime);
    database.upsertTopicRevision({
      id: topic.id,
      type: "project",
      title: "Durable projection",
      slug: "durable-projection-current",
      markdown: "# Durable projection\n\nNewest committed revision.",
      summary: "Newest committed revision.",
      currentState: "Newest committed revision.",
      history: "",
      authorType: "model",
      promptVersion: "projection-test-v2"
    });
    const job = database.enqueueJob(
      "projection.sync",
      stableHash(`projection-sync-test:${topic.id}`),
      { topicIds: [topic.id], reason: "test" },
      8
    );

    const result = await processor.process(job);

    const current = database.getTopic(topic.id)!;
    const currentPath = join(config.projectionsDir, `${current.id}-${current.slug}.md`);
    expect(result).toMatchObject({ topicIds: [topic.id] });
    expect(await readFile(currentPath, "utf8")).toBe(current.markdown);
    await expect(access(stalePath)).rejects.toThrow();
    await expect(access(crashedTemporary)).rejects.toThrow();
    expect((await readdir(config.projectionsDir)).filter((entry) => entry.startsWith(".projection-"))).toEqual([]);
  });

  it("fails closed when an imported database row has an unsafe projection slug", async () => {
    const { database, processor, config } = await fixture();
    const topic = database.upsertTopicRevision({
      type: "project",
      title: "Unsafe imported projection",
      slug: "safe-before-import",
      markdown: "# Unsafe imported projection",
      summary: "Imported row.",
      currentState: "Imported row.",
      history: "",
      authorType: "model",
      promptVersion: "projection-test-v1"
    });
    database.connection.prepare("UPDATE topic_pages SET slug = '../escape-attempt' WHERE id = ?").run(topic.id);
    const job = database.enqueueJob(
      "projection.sync",
      stableHash(`unsafe-projection-sync-test:${topic.id}`),
      { topicIds: [topic.id], reason: "test" },
      8
    );

    await expect(processor.process(job)).rejects.toMatchObject({ code: "PROJECTION_SLUG_INVALID" });
    expect(await readdir(config.projectionsDir)).toEqual([]);
  });

  it("does not let an obsolete embedding completion replace the current revision vector", async () => {
    const { database, config } = await fixture();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const providers = {
      create: async () => ({
        embed: async (inputs: string[], model = "") => {
          markStarted();
          await providerGate;
          return {
            vectors: inputs.map((input) => [input.length, 1]),
            model,
            inputTokens: inputs.length,
            estimatedCostUsd: 0
          };
        }
      })
    } as unknown as ProviderFactory;
    const processor = new JobProcessor(database, config, providers, new LocalLogger(config.logsDir));
    const embeddingModel = database.getSetting("models.embedding", config.models.embedding);
    const oldMarkdown = "# Embedding race\n\nOld authoritative revision.";
    const currentMarkdown = "# Embedding race\n\nCurrent replacement revision.";
    const topic = database.upsertTopicRevision({
      type: "project",
      title: "Embedding race",
      slug: "embedding-race",
      markdown: oldMarkdown,
      summary: "Old authoritative revision.",
      currentState: "Old authoritative revision.",
      history: "",
      authorType: "model",
      promptVersion: "embedding-race-v1"
    });
    database.connection.prepare(`
      INSERT INTO vectors(id, source_id, source_type, model_id, dimensions, content_hash, embedding_version, embedding_json, created_at)
      VALUES (?, ?, 'topic', 'legacy-model', 2, ?, 'v1', '[1,0]', ?)
    `).run(uuidv7(), topic.id, stableHash(oldMarkdown), new Date().toISOString());
    const staleJob = database.enqueueJob(
      "embedding.index",
      stableHash(`embedding-race:old:${topic.id}`),
      { sourceId: topic.id, sourceType: "topic", model: embeddingModel, contentHash: stableHash(oldMarkdown) }
    );

    const staleProcessing = processor.process(staleJob);
    await started;
    database.upsertTopicRevision({
      id: topic.id,
      type: "project",
      title: "Embedding race",
      slug: "embedding-race",
      markdown: currentMarkdown,
      summary: "Current replacement revision.",
      currentState: "Current replacement revision.",
      history: "",
      authorType: "model",
      promptVersion: "embedding-race-v2"
    });
    // Simulate a newer job winning while the old provider call is in flight.
    database.connection.prepare(`
      INSERT INTO vectors(id, source_id, source_type, model_id, dimensions, content_hash, embedding_version, embedding_json, created_at)
      VALUES (?, ?, 'topic', 'current-model', 2, ?, 'v1', '[0,1]', ?)
    `).run(uuidv7(), topic.id, stableHash(currentMarkdown), new Date().toISOString());
    releaseProvider();

    await expect(staleProcessing).resolves.toMatchObject({ indexed: 0, stale: 1, removed: 1 });
    expect(database.connection.prepare(`
      SELECT model_id, content_hash FROM vectors WHERE source_id = ? AND source_type = 'topic'
    `).all(topic.id)).toEqual([{ model_id: "current-model", content_hash: stableHash(currentMarkdown) }]);

    const replacementJob = database.enqueueJob(
      "embedding.index",
      stableHash(`embedding-race:current:${topic.id}`),
      { sourceId: topic.id, sourceType: "topic", model: embeddingModel, contentHash: stableHash(currentMarkdown) }
    );
    await expect(processor.process(replacementJob)).resolves.toMatchObject({ indexed: 1, stale: 0, removed: 1 });
    expect(database.connection.prepare(`
      SELECT model_id, content_hash FROM vectors WHERE source_id = ? AND source_type = 'topic'
    `).all(topic.id)).toEqual([{ model_id: embeddingModel, content_hash: stableHash(currentMarkdown) }]);

    database.connection.prepare("UPDATE topic_pages SET lifecycle_status = 'archived' WHERE id = ?").run(topic.id);
    const inactiveJob = database.enqueueJob(
      "embedding.index",
      stableHash(`embedding-race:inactive:${topic.id}`),
      { sourceId: topic.id, sourceType: "topic", model: embeddingModel, contentHash: stableHash(currentMarkdown) }
    );
    await expect(processor.process(inactiveJob)).resolves.toMatchObject({ indexed: 0, removed: 1 });
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM vectors WHERE source_id = ?").get(topic.id)).toEqual({ count: 0 });
  });

  it("binds embedding jobs to one model and reuses an exact current vector without another provider call", async () => {
    const { database, config } = await fixture();
    const originalModel = database.getSetting("models.embedding", config.models.embedding);
    const replacementModel = originalModel === "text-embedding-3-small" ? "text-embedding-3-large" : "text-embedding-3-small";
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const embed = vi.fn(async (inputs: string[], model = "") => {
      markStarted();
      await providerGate;
      return {
        vectors: inputs.map((input) => [1, input.length]),
        model,
        inputTokens: inputs.length,
        estimatedCostUsd: 0
      };
    });
    const providers = { create: async () => ({ embed }) } as unknown as ProviderFactory;
    const processor = new JobProcessor(database, config, providers, new LocalLogger(config.logsDir));
    const markdown = "# Model-bound embedding\n\nOne canonical page.";
    const topic = database.upsertTopicRevision({
      type: "project",
      title: "Model-bound embedding",
      slug: "model-bound-embedding",
      markdown,
      summary: "One canonical page.",
      currentState: "One canonical page.",
      history: "",
      authorType: "model",
      promptVersion: "embedding-model-test-v1"
    });
    const oldModelJob = database.enqueueJob(
      "embedding.index",
      stableHash(`embedding-model-race:old:${topic.id}`),
      { sourceId: topic.id, sourceType: "topic", model: originalModel, contentHash: stableHash(markdown) }
    );

    const oldProcessing = processor.process(oldModelJob);
    await started;
    database.setSetting("models.embedding", replacementModel);
    database.connection.prepare(`
      INSERT INTO vectors(id, source_id, source_type, model_id, dimensions, content_hash, embedding_version, embedding_json, created_at)
      VALUES (?, ?, 'topic', ?, 2, ?, 'v1', '[0,1]', ?)
    `).run(uuidv7(), topic.id, replacementModel, stableHash(markdown), new Date().toISOString());
    releaseProvider();

    await expect(oldProcessing).resolves.toMatchObject({ indexed: 0, modelStale: 1, removed: 0 });
    expect(database.connection.prepare(`
      SELECT model_id, content_hash FROM vectors WHERE source_id = ? AND source_type = 'topic'
    `).all(topic.id)).toEqual([{ model_id: replacementModel, content_hash: stableHash(markdown) }]);
    expect(embed).toHaveBeenCalledTimes(1);

    const replacementJob = database.enqueueJob(
      "embedding.index",
      stableHash(`embedding-model-race:replacement:${topic.id}`),
      { sourceId: topic.id, sourceType: "topic", model: replacementModel, contentHash: stableHash(markdown) }
    );
    await expect(processor.process(replacementJob)).resolves.toMatchObject({ indexed: 0, reused: 1, stale: 0, removed: 0 });
    expect(embed).toHaveBeenCalledTimes(1);

    const unboundJob = database.enqueueJob(
      "embedding.index",
      stableHash(`embedding-model-race:unbound:${topic.id}`),
      { sourceId: topic.id, sourceType: "topic", contentHash: stableHash(markdown) }
    );
    await expect(processor.process(unboundJob)).resolves.toMatchObject({ indexed: 0, skipped: true, reason: "embedding job has no model binding" });
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it("preserves an exact vector when deterministic compilation replays the same active topic", async () => {
    const { database, config } = await fixture();
    const evidence = database.appendEvent({ role: "user", content: "Replay project remains exactly unchanged." });
    const storedClaim = database.upsertClaim({
      topicId: null,
      subject: "Replay project",
      predicate: "status",
      value: "remains exactly unchanged",
      confidence: 1,
      status: "current",
      sourceRole: "user",
      sourceIds: [evidence.id],
      validFrom: null,
      validTo: null,
      observedAt: evidence.createdAt,
      freshnessExpiresAt: null
    });
    const claim = asEvidenceClaim(database, storedClaim.id);
    const delta = deterministicDelta([claim], ["Replay project"]);
    await compileAffectedTopics(database, delta, [claim], config, "2026-07-14T12:00:00.000Z");
    expect(claim.topicId).not.toBeNull();
    const topic = database.getTopic(claim.topicId!)!;
    const model = database.getSetting("models.embedding", config.models.embedding);
    const vectorId = uuidv7();
    database.connection.prepare(`
      INSERT INTO vectors(id, source_id, source_type, model_id, dimensions, content_hash, embedding_version, embedding_json, created_at)
      VALUES (?, ?, 'topic', ?, 2, ?, 'v1', '[1,0]', ?)
    `).run(vectorId, topic.id, model, stableHash(topic.markdown), new Date().toISOString());
    const embeddingJobCount = database.listJobs(500).filter((queued) => queued.type === "embedding.index").length;

    await compileAffectedTopics(database, delta, [claim], config, "2026-07-14T12:01:00.000Z");

    expect(database.connection.prepare(`
      SELECT id, model_id, content_hash FROM vectors WHERE source_id = ? AND source_type = 'topic'
    `).all(topic.id)).toEqual([{ id: vectorId, model_id: model, content_hash: stableHash(topic.markdown) }]);
    expect(database.listJobs(500).filter((queued) => queued.type === "embedding.index")).toHaveLength(embeddingJobCount);
  });

  it("never treats a user-editable parent tag as compiler ownership", async () => {
    const { database, processor, config } = await fixture();
    const generated = database.upsertTopicRevision({
      type: "project",
      title: "Generated root",
      slug: "generated-root",
      markdown: "# Generated root",
      summary: "Generated root.",
      currentState: "",
      history: "",
      tags: ["auto-compiled"],
      authorType: "model",
      promptVersion: "compiler-test-v1"
    });
    const trusted = database.upsertTopicRevision({
      type: "project",
      title: "Trusted tagged page",
      slug: "trusted-tagged-page",
      markdown: "# Trusted tagged page\n\nThis page is independent.",
      summary: "This page is independent.",
      currentState: "This page is independent.",
      history: "",
      tags: ["auto-split", `parent:${generated.id}`],
      authorType: "user",
      promptVersion: "user-edit-v1"
    });
    await mkdir(config.projectionsDir, { recursive: true });
    const generatedPath = join(config.projectionsDir, `${generated.id}-${generated.slug}.md`);
    const trustedPath = join(config.projectionsDir, `${trusted.id}-${trusted.slug}.md`);
    await writeFile(generatedPath, database.getTopic(generated.id)!.markdown);
    await writeFile(trustedPath, database.getTopic(trusted.id)!.markdown);

    const trustedRebuild = database.enqueueJob(
      "memory.rebuild",
      stableHash(`fake-parent-tag:trusted:${trusted.id}`),
      { topicIds: [trusted.id] }
    );
    await expect(processor.process(trustedRebuild)).resolves.toMatchObject({ preserved: [trusted.id], removed: [] });
    expect(database.getTopic(generated.id)).not.toBeNull();

    const rootRebuild = database.enqueueJob(
      "memory.rebuild",
      stableHash(`fake-parent-tag:root:${generated.id}`),
      { topicIds: [generated.id] }
    );
    await expect(processor.process(rootRebuild)).resolves.toMatchObject({ removed: [generated.id] });
    expect(database.getTopic(generated.id)).toBeNull();
    await expect(access(generatedPath)).rejects.toThrow();
    expect(database.getTopic(trusted.id)).toMatchObject({ id: trusted.id, userAuthored: true });
    await expect(readFile(trustedPath, "utf8")).resolves.toBe(trusted.markdown);
  });

  it("uses the topic/revision index for latest and active revision reads", async () => {
    const { database } = await fixture();
    const topicId = uuidv7();
    const latestPlan = database.connection.prepare(`
      EXPLAIN QUERY PLAN SELECT id, revision_number, markdown, prompt_version
      FROM topic_page_revisions WHERE topic_id = ? ORDER BY revision_number DESC LIMIT 1
    `).all(topicId) as Array<{ detail: string }>;
    const activePlan = database.connection.prepare(`
      EXPLAIN QUERY PLAN SELECT id, revision_number, markdown
      FROM topic_page_revisions WHERE topic_id = ? AND revision_number = ?
    `).all(topicId, 1) as Array<{ detail: string }>;

    for (const plan of [latestPlan, activePlan]) {
      const detail = plan.map((row) => row.detail).join("\n");
      expect(detail).toMatch(/SEARCH topic_page_revisions USING INDEX/i);
      expect(detail).not.toMatch(/SCAN topic_page_revisions/i);
    }
  });

  it("queues already-due freshness transitions for immediate processing and skips only invalid dates", async () => {
    const { database } = await fixture();
    const timestamp = "2026-07-14T12:00:00.000Z";
    const base: EvidenceClaim = {
      id: uuidv7(),
      topicId: null,
      subject: "Release status",
      predicate: "is",
      value: "current",
      confidence: 1,
      status: "current",
      sourceRole: "user",
      sourceIds: [uuidv7()],
      validFrom: null,
      validTo: null,
      observedAt: "2026-07-13T12:00:00.000Z",
      freshnessExpiresAt: "2026-07-14T11:00:00.000Z",
      recordedAt: "2026-07-13T12:00:00.000Z",
      sourceKind: "conversation",
      explicitCorrection: false,
      attributedTo: null,
      extractionVersion: "test-v1"
    };
    const future = { ...base, id: uuidv7(), freshnessExpiresAt: "2026-07-15T12:00:00.000Z" };
    const invalid = { ...base, id: uuidv7(), freshnessExpiresAt: "not-a-date" };

    const jobIds = enqueueFreshnessTransitions(database, [
      { before: null, after: base },
      { before: null, after: future },
      { before: null, after: invalid }
    ], timestamp);

    expect(jobIds).toHaveLength(2);
    const jobs = database.connection.prepare("SELECT payload_json, available_at FROM jobs WHERE type = 'memory.expire' ORDER BY available_at").all() as Array<{ payload_json: string; available_at: string }>;
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => ({ ...(JSON.parse(job.payload_json) as Record<string, string>), availableAt: job.available_at }))).toEqual([
      { claimId: base.id, freshnessExpiresAt: base.freshnessExpiresAt, availableAt: timestamp },
      { claimId: future.id, freshnessExpiresAt: future.freshnessExpiresAt, availableAt: future.freshnessExpiresAt }
    ]);
  });

  it("keeps post-turn claim reconciliation independent of unrelated ledger size", async () => {
    const { database, processor } = await fixture();
    const timestamp = "2026-07-13T12:00:00.000Z";
    for (let index = 0; index < 300; index += 1) {
      const source = database.appendEvent({ role: "user", content: `Unrelated historical evidence ${index}.` });
      database.upsertClaim({
        topicId: uuidv7(),
        subject: `Unrelated subject ${index}`,
        predicate: "records",
        value: `unrelated value ${index}`,
        confidence: 1,
        status: "current",
        sourceRole: "user",
        sourceIds: [source.id],
        validFrom: null,
        validTo: null,
        observedAt: timestamp,
        freshnessExpiresAt: null
      });
    }
    const listClaims = vi.spyOn(database, "listClaims");
    const turn = database.appendEvent({ role: "user", content: "Remember this important fact: my launch color is red." });

    await processor.process(compileJob(database, "", [turn.id]));

    expect(listClaims.mock.calls.every(([limit]) => Number(limit) <= 80)).toBe(true);
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM claims").get()).toEqual({ count: 301 });
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM claims WHERE value = ?").get(turn.content)).toEqual({ count: 1 });
  });

  it("keeps exploratory mock-provider batches out of durable memory without changing the worker cadence", async () => {
    const { database, processor } = await fixture();
    const events = Array.from({ length: 320 }, (_, index) => database.appendEvent({
      role: index % 2 === 0 ? "user" : "assistant",
      content: index === 0
        ? "Remember this: the application codename is Northstar."
        : index === 1
          ? "Recorded: Northstar is the application codename."
          : index % 2 === 0
            ? "Can you sanity-check this architecture idea against the constraints we established?"
            : "The architecture tradeoff is recorded as exploratory; it does not supersede an explicit project decision."
    }));

    for (let offset = 0; offset < events.length; offset += 32) {
      await processor.process(compileJob(database, "", events.slice(offset, offset + 32).map((event) => event.id)));
    }

    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM claims").get()).toEqual({ count: 1 });
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM claims WHERE value LIKE '%exploratory%'").get()).toEqual({ count: 0 });
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM topic_pages").get()).toEqual({ count: 1 });
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM topic_page_revisions").get()).toEqual({ count: 1 });
    expect(Number((database.connection.prepare("SELECT COUNT(*) AS count FROM page_section_sources").get() as { count: number }).count)).toBeLessThanOrEqual(20);
  });

  it("keeps durable-growth revisions page-local with stable child identities and complete active provenance", async () => {
    const { database, processor } = await fixture();
    const addDurableBatch = async (start: number, count: number) => {
      const events = Array.from({ length: count }, (_, index) => {
        const number = start + index;
        return database.appendEvent({ role: "user", content: `Remember this important project fact ${number}: component ${number} has durable requirement ${number}.` });
      });
      for (let offset = 0; offset < events.length; offset += 32) {
        await processor.process(compileJob(database, "", events.slice(offset, offset + 32).map((event) => event.id)));
      }
      return events;
    };

    const initialEvents = await addDurableBatch(1, 256);
    const before = database.connection.prepare("SELECT id, slug, active_revision FROM topic_pages WHERE lifecycle_status = 'active'").all() as Array<{ id: string; slug: string; active_revision: number }>;
    const beforeRevisionCount = Number((database.connection.prepare("SELECT COUNT(*) AS count FROM topic_page_revisions").get() as { count: number }).count);
    const addedEvents = await addDurableBatch(257, 32);
    const after = database.connection.prepare("SELECT id, slug, active_revision FROM topic_pages WHERE lifecycle_status = 'active'").all() as Array<{ id: string; slug: string; active_revision: number }>;
    const afterBySlug = new Map(after.map((row) => [row.slug, row]));
    const newTopicCount = after.length - before.length;
    const afterRevisionCount = Number((database.connection.prepare("SELECT COUNT(*) AS count FROM topic_page_revisions").get() as { count: number }).count);

    expect(before.every((row) => afterBySlug.get(row.slug)?.id === row.id)).toBe(true);
    expect(before.filter((row) => afterBySlug.get(row.slug)?.active_revision !== row.active_revision).length).toBeLessThanOrEqual(8);
    expect(afterRevisionCount - beforeRevisionCount).toBeLessThanOrEqual(newTopicCount + 8);
    expect(database.connection.prepare(`
      SELECT COUNT(DISTINCT pss.source_id) AS count
      FROM page_section_sources pss
      JOIN topic_page_revisions revision ON revision.id = pss.revision_id
      JOIN topic_pages page ON page.id = revision.topic_id AND page.active_revision = revision.revision_number
      WHERE page.lifecycle_status = 'active'
    `).get()).toEqual({ count: initialEvents.length + addedEvents.length });
    expect(after.every((row) => database.getTopic(row.id)!.markdown.length <= 10_000)).toBe(true);
    expect(database.connection.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  });

  it("routes backfilled additions by shard range, splits only that bounded range, and preserves one global chain", async () => {
    const { database, processor, config } = await fixture();
    const initialEvents = Array.from({ length: 128 }, (_, index) => database.appendEvent({
      role: "user",
      content: `Remember this important durable project fact ${index}: component ${index} retains invariant ${index} across releases.`
    }));
    await compileInBatches(processor, database, initialEvents);
    const parent = database.connection.prepare(`
      SELECT page.id FROM topic_pages page
      JOIN topic_projection_state projection ON projection.parent_topic_id = page.id AND projection.mode = 'sharded'
      WHERE page.title = 'User profile' AND page.lifecycle_status = 'active'
    `).get() as { id: string };
    const beforeEvidenceShards = database.connection.prepare(`
      SELECT shard.child_topic_id, shard.min_sort_key, shard.max_sort_key, child.active_revision
      FROM topic_section_shards shard
      JOIN topic_pages child ON child.id = shard.child_topic_id AND child.lifecycle_status = 'active'
      WHERE shard.parent_topic_id = ? AND shard.section_key = 'evidence'
      ORDER BY shard.max_sort_key, shard.ordinal
    `).all(parent.id) as Array<{ child_topic_id: string; min_sort_key: string; max_sort_key: string; active_revision: number }>;
    expect(beforeEvidenceShards.length).toBeGreaterThan(1);
    const rangeTail = beforeEvidenceShards.at(-1)!;
    const additions: EvidenceClaim[] = [];
    for (let index = 0; index < 16; index += 1) {
      const source = database.appendEvent({ role: "user", content: `Backfilled source ${index}.` });
      const observedAt = new Date(Date.UTC(2020, 0, 1, 0, 0, index)).toISOString();
      const stored = database.upsertClaim({
        topicId: parent.id,
        subject: `Backfilled component ${index}`,
        predicate: "retains",
        value: `historical bounded-range invariant ${index} ${"backfilled architectural context ".repeat(34)}`,
        confidence: 1,
        status: "current",
        sourceRole: "user",
        sourceIds: [source.id],
        validFrom: observedAt,
        validTo: null,
        observedAt,
        freshnessExpiresAt: null
      });
      additions.push(asEvidenceClaim(database, stored.id));
    }

    await compileAffectedTopics(
      database,
      deterministicDelta(additions, ["User profile"]),
      additions,
      config,
      new Date().toISOString(),
      additions.map((after) => ({ before: null, after }))
    );

    expect(database.connection.prepare("SELECT active_revision FROM topic_pages WHERE id = ?").get(rangeTail.child_topic_id)).toEqual({ active_revision: rangeTail.active_revision });
    const afterEvidenceShards = database.connection.prepare(`
      SELECT shard.child_topic_id, shard.min_sort_key, shard.max_sort_key
      FROM topic_section_shards shard
      JOIN topic_pages child ON child.id = shard.child_topic_id AND child.lifecycle_status = 'active'
      WHERE shard.parent_topic_id = ? AND shard.section_key = 'evidence'
      ORDER BY shard.max_sort_key, shard.ordinal
    `).all(parent.id) as Array<{ child_topic_id: string; min_sort_key: string; max_sort_key: string }>;
    expect(afterEvidenceShards.length).toBeGreaterThan(beforeEvidenceShards.length);
    const additionMarks = additions.map(() => "?").join(",");
    const additionMemberships = database.connection.prepare(`
      SELECT DISTINCT pss.claim_id, shard.child_topic_id FROM topic_section_shards shard
      JOIN topic_pages child ON child.id = shard.child_topic_id AND child.lifecycle_status = 'active'
      JOIN topic_page_revisions revision ON revision.topic_id = child.id AND revision.revision_number = child.active_revision
      JOIN page_section_sources pss ON pss.revision_id = revision.id
      WHERE shard.parent_topic_id = ? AND shard.section_key = 'evidence' AND pss.claim_id IN (${additionMarks})
    `).all(parent.id, ...additions.map((claim) => claim.id)) as Array<{ claim_id: string; child_topic_id: string }>;
    expect(new Set(additionMemberships.map((row) => row.claim_id)).size).toBe(additions.length);
    expect(additionMemberships.every((row) => row.child_topic_id !== rangeTail.child_topic_id)).toBe(true);

    const orderedShards = database.connection.prepare(`
      SELECT shard.child_topic_id FROM topic_section_shards shard
      JOIN topic_pages child ON child.id = shard.child_topic_id AND child.lifecycle_status = 'active'
      WHERE shard.parent_topic_id = ?
      ORDER BY CASE shard.section_key WHEN 'overview' THEN 0 WHEN 'current_state' THEN 1 WHEN 'history' THEN 2 ELSE 3 END,
        shard.max_sort_key, shard.ordinal
    `).all(parent.id) as Array<{ child_topic_id: string }>;
    const nextLinks = database.connection.prepare("SELECT source_topic_id, target_topic_id FROM page_links WHERE relation_type = 'next'").all() as Array<{ source_topic_id: string; target_topic_id: string }>;
    const previousLinks = database.connection.prepare("SELECT source_topic_id, target_topic_id FROM page_links WHERE relation_type = 'previous'").all() as Array<{ source_topic_id: string; target_topic_id: string }>;
    for (let index = 0; index < orderedShards.length; index += 1) {
      const id = orderedShards[index]!.child_topic_id;
      const next = nextLinks.filter((link) => link.source_topic_id === id);
      const previous = previousLinks.filter((link) => link.source_topic_id === id);
      expect(next).toEqual(index + 1 < orderedShards.length ? [{ source_topic_id: id, target_topic_id: orderedShards[index + 1]!.child_topic_id }] : []);
      expect(previous).toEqual(index > 0 ? [{ source_topic_id: id, target_topic_id: orderedShards[index - 1]!.child_topic_id }] : []);
    }
    expect(orderedShards.every((row) => database.getTopic(row.child_topic_id)!.markdown.length <= 10_000)).toBe(true);
  });

  it("keeps protected sharded proposals bounded, invisible, immutable, and replay-idempotent", async () => {
    const { database, processor, config } = await fixture();
    const initialEvents = Array.from({ length: 64 }, (_, index) => database.appendEvent({
      role: "user",
      content: `Remember this important protected profile fact ${index}: preference ${index} remains durable.`
    }));
    await compileInBatches(processor, database, initialEvents);
    const parent = database.connection.prepare(`
      SELECT page.id FROM topic_pages page
      JOIN topic_projection_state projection ON projection.parent_topic_id = page.id AND projection.mode = 'sharded'
      WHERE page.title = 'User profile' AND page.lifecycle_status = 'active'
    `).get() as { id: string };
    expect(database.setTopicUpdatePolicy(parent.id, "confirm")).toBe(true);

    const source = database.appendEvent({ role: "user", content: "Protected proposal source." });
    const stored = database.upsertClaim({
      topicId: null,
      subject: "User profile protecteduniquemarker",
      predicate: "records",
      value: "protecteduniquemarker must remain proposal-only until acceptance",
      confidence: 1,
      status: "current",
      sourceRole: "user",
      sourceIds: [source.id],
      validFrom: null,
      validTo: null,
      observedAt: "2026-07-14T10:00:00.000Z",
      freshnessExpiresAt: null
    });
    const after = asEvidenceClaim(database, stored.id);
    const delta = deterministicDelta([after], ["User profile"]);
    const activeBefore = database.connection.prepare(`
      SELECT id, active_revision, title, slug, lifecycle_status, updated_at
      FROM topic_pages WHERE lifecycle_status = 'active' ORDER BY id
    `).all();
    const shardsBefore = database.connection.prepare(`
      SELECT * FROM topic_section_shards WHERE parent_topic_id = ?
      ORDER BY section_key, ordinal, child_topic_id
    `).all(parent.id);
    const projectionBefore = database.connection.prepare("SELECT * FROM topic_projection_state WHERE parent_topic_id = ?").get(parent.id);
    const linksBefore = database.connection.prepare("SELECT * FROM page_links ORDER BY id").all();
    const topicFtsBefore = database.connection.prepare("SELECT topic_id, title, content FROM topic_fts ORDER BY topic_id").all();
    const filesBefore = (await readdir(config.projectionsDir)).sort();
    const pagesBefore = Number((database.connection.prepare("SELECT COUNT(*) AS count FROM topic_pages").get() as { count: number }).count);
    const revisionsBefore = Number((database.connection.prepare("SELECT COUNT(*) AS count FROM topic_page_revisions").get() as { count: number }).count);
    const fullTopicScan = vi.spyOn(database, "listClaimsForTopic");

    const first = await compileAffectedTopics(
      database,
      delta,
      [after],
      config,
      "2026-07-14T12:00:00.000Z",
      [{ before: null, after }]
    );

    expect(fullTopicScan).not.toHaveBeenCalled();
    expect(first.changedTopicIds).toEqual([]);
    expect(first.proposalIds).toHaveLength(1);
    expect(database.getClaim(after.id, true)?.topicId).toBeNull();
    const proposal = database.getTopicShardProposal(first.proposalIds[0]!)!;
    expect(proposal.kind).toBe("topic_shard_patch");
    expect(database.getSetting("memory.pendingTopicProposals", [])).toEqual([]);
    expect(proposal.claimGuards).toEqual(expect.arrayContaining([expect.objectContaining({
      claimId: after.id,
      expectedTopicId: null,
      assignToTopicId: parent.id
    })]));
    expect(proposal.patches.length).toBeLessThanOrEqual(2);
    const outputs = proposal.patches.flatMap((patch) => patch.outputs);
    expect(outputs.length).toBeLessThanOrEqual(4);
    expect(Number((database.connection.prepare("SELECT COUNT(*) AS count FROM topic_page_revisions").get() as { count: number }).count) - revisionsBefore).toBe(outputs.length);
    expect(Number((database.connection.prepare("SELECT COUNT(*) AS count FROM topic_pages").get() as { count: number }).count) - pagesBefore)
      .toBe(outputs.filter((output) => output.baseRevision === null).length);

    expect(database.connection.prepare(`
      SELECT id, active_revision, title, slug, lifecycle_status, updated_at
      FROM topic_pages WHERE lifecycle_status = 'active' ORDER BY id
    `).all()).toEqual(activeBefore);
    expect(database.connection.prepare(`
      SELECT * FROM topic_section_shards WHERE parent_topic_id = ?
      ORDER BY section_key, ordinal, child_topic_id
    `).all(parent.id)).toEqual(shardsBefore);
    expect(database.connection.prepare("SELECT * FROM topic_projection_state WHERE parent_topic_id = ?").get(parent.id)).toEqual(projectionBefore);
    expect(database.connection.prepare("SELECT * FROM page_links ORDER BY id").all()).toEqual(linksBefore);
    expect(database.connection.prepare("SELECT topic_id, title, content FROM topic_fts ORDER BY topic_id").all()).toEqual(topicFtsBefore);
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM topic_fts WHERE topic_fts MATCH ?").get("protecteduniquemarker")).toEqual({ count: 0 });
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM topic_revision_fts WHERE topic_revision_fts MATCH ?").get("protecteduniquemarker")).toEqual({ count: 0 });
    for (const output of outputs) {
      expect(database.connection.prepare("SELECT COUNT(*) AS count FROM topic_revision_fts WHERE revision_id = ?").get(output.revisionId)).toEqual({ count: 0 });
      expect(database.getTopicShardRevisionContentHash(output.revisionId)).toBe(output.contentHash);
      if (output.baseRevision !== null) continue;
      expect(database.connection.prepare("SELECT lifecycle_status FROM topic_pages WHERE id = ?").get(output.topicId)).toEqual({ lifecycle_status: "proposal" });
      expect(database.connection.prepare("SELECT COUNT(*) AS count FROM topic_section_shards WHERE child_topic_id = ?").get(output.topicId)).toEqual({ count: 0 });
      expect(database.connection.prepare("SELECT COUNT(*) AS count FROM page_links WHERE source_topic_id = ? OR target_topic_id = ?").get(output.topicId, output.topicId)).toEqual({ count: 0 });
      await expect(access(join(config.projectionsDir, `${output.topicId}-${output.slug}.md`))).rejects.toThrow();
    }
    expect((await readdir(config.projectionsDir)).sort()).toEqual(filesBefore);

    const second = await compileAffectedTopics(
      database,
      delta,
      [after],
      config,
      "2026-07-15T12:00:00.000Z",
      [{ before: null, after }]
    );
    expect(second).toEqual(first);
    expect(database.listPendingTopicShardProposals()).toHaveLength(1);
    expect(Number((database.connection.prepare("SELECT COUNT(*) AS count FROM topic_page_revisions").get() as { count: number }).count) - revisionsBefore).toBe(outputs.length);
    expect(database.getClaim(after.id, true)?.topicId).toBeNull();

    const overlappingSource = database.appendEvent({ role: "user", content: "Overlapping protected proposal source." });
    const overlappingStored = database.upsertClaim({
      topicId: null,
      subject: "User profile protectedoverlapmarker",
      predicate: "records",
      value: "protectedoverlapmarker must merge with the earlier pending delta",
      confidence: 1,
      status: "current",
      sourceRole: "user",
      sourceIds: [overlappingSource.id],
      validFrom: null,
      validTo: null,
      observedAt: "2026-07-14T10:00:01.000Z",
      freshnessExpiresAt: null
    });
    const overlappingAfter = asEvidenceClaim(database, overlappingStored.id);
    const overlapping = await compileAffectedTopics(
      database,
      deterministicDelta([overlappingAfter], ["User profile"]),
      [overlappingAfter],
      config,
      "2026-07-16T12:00:00.000Z",
      [{ before: null, after: overlappingAfter }]
    );
    expect(overlapping.changedTopicIds).toEqual([]);
    expect(overlapping.proposalIds).toHaveLength(1);
    expect(overlapping.proposalIds[0]).not.toBe(proposal.id);
    expect(database.connection.prepare("SELECT status FROM topic_shard_proposals WHERE id = ?").get(proposal.id)).toEqual({ status: "superseded" });
    for (const output of outputs) {
      const sharedRevision = database.connection.prepare(`
        SELECT 1 FROM topic_shard_proposal_outputs candidate
        JOIN topic_shard_proposals pending ON pending.id = candidate.proposal_id
        WHERE candidate.revision_id = ? AND pending.status = 'pending' LIMIT 1
      `).get(output.revisionId);
      if (!sharedRevision) expect(database.connection.prepare("SELECT 1 FROM topic_page_revisions WHERE id = ?").get(output.revisionId)).toBeUndefined();
      if (output.baseRevision !== null) continue;
      const sharedTopic = database.connection.prepare(`
        SELECT 1 FROM topic_shard_proposal_outputs candidate
        JOIN topic_shard_proposals pending ON pending.id = candidate.proposal_id
        WHERE candidate.topic_id = ? AND pending.status = 'pending' LIMIT 1
      `).get(output.topicId);
      if (!sharedTopic) expect(database.connection.prepare("SELECT 1 FROM topic_pages WHERE id = ?").get(output.topicId)).toBeUndefined();
    }
    const combinedProposal = database.getTopicShardProposal(overlapping.proposalIds[0]!)!;
    expect(combinedProposal.claimIds).toEqual(expect.arrayContaining([after.id, overlappingAfter.id]));
    expect(database.listPendingTopicShardProposals().map((item) => item.id)).toEqual([combinedProposal.id]);
    expect(database.getClaim(after.id, true)?.topicId).toBeNull();
    expect(database.getClaim(overlappingAfter.id, true)?.topicId).toBeNull();
    expect(() => database.persistTopicShardProposal({ ...proposal, title: `${proposal.title} divergent` }))
      .toThrowError(expect.objectContaining({ code: "TOPIC_SHARD_PROPOSAL_COLLISION" }));

    const combinedOutputs = combinedProposal.patches.flatMap((patch) => patch.outputs);
    const unchangedRenderedClaimId = combinedOutputs.flatMap((output) => output.claimIds)
      .find((claimId) => claimId !== after.id && claimId !== overlappingAfter.id)!;
    const unchangedGuard = combinedProposal.claimGuards.find((guard) => guard.claimId === unchangedRenderedClaimId)!;
    expect(unchangedGuard).toBeDefined();
    database.connection.prepare("UPDATE claims SET value = value || ' externally-mutated' WHERE id = ?").run(unchangedRenderedClaimId);
    expect(database.getTopicShardClaimGuardSnapshot(unchangedRenderedClaimId)?.stateHash).not.toBe(unchangedGuard.stateHash);
  });

  it("keeps protected planner reads bounded at 1k, 5k, and 10k unrelated claims", async () => {
    const { database, processor, config } = await fixture();
    const initialEvents = Array.from({ length: 64 }, (_, index) => database.appendEvent({
      role: "user",
      content: `Remember this important read-budget profile fact ${index}: invariant ${index} remains durable.`
    }));
    await compileInBatches(processor, database, initialEvents);
    const parent = database.connection.prepare(`
      SELECT page.id FROM topic_pages page
      JOIN topic_projection_state projection ON projection.parent_topic_id = page.id AND projection.mode = 'sharded'
      WHERE page.title = 'User profile' AND page.lifecycle_status = 'active'
    `).get() as { id: string };
    database.setTopicUpdatePolicy(parent.id, "confirm");
    const source = database.appendEvent({ role: "user", content: "Bounded planner source." });
    const stored = database.upsertClaim({
      topicId: null,
      subject: "User profile boundedreadmarker",
      predicate: "records",
      value: "boundedreadmarker remains local to one delta",
      confidence: 1,
      status: "current",
      sourceRole: "user",
      sourceIds: [source.id],
      validFrom: null,
      validTo: null,
      observedAt: "2026-07-14T10:00:00.000Z",
      freshnessExpiresAt: null
    });
    const after = asEvidenceClaim(database, stored.id);
    const delta = deterministicDelta([after], ["User profile"]);
    const insertUnrelated = database.connection.prepare(`
      INSERT INTO claims(
        id, topic_id, subject, predicate, value, confidence, status, source_role,
        valid_from, valid_to, observed_at, freshness_expires_at, extraction_version
      ) VALUES (?, NULL, ?, 'records', ?, 1, 'current', 'user', NULL, NULL, ?, NULL, 'scale-fixture-v1')
    `);
    let inserted = 0;
    const readCounts: number[] = [];
    for (const scale of [1_000, 5_000, 10_000]) {
      database.connection.transaction(() => {
        while (inserted < scale) {
          insertUnrelated.run(
            uuidv7(),
            `Unrelated scale subject ${inserted}`,
            `Unrelated scale value ${inserted}`,
            "2020-01-01T00:00:00.000Z"
          );
          inserted += 1;
        }
      })();
      const getClaim = vi.spyOn(database, "getClaim");
      const listClaimsForTopic = vi.spyOn(database, "listClaimsForTopic");
      const result = await compileAffectedTopics(
        database,
        delta,
        [after],
        config,
        new Date(Date.UTC(2026, 6, 14 + readCounts.length)).toISOString(),
        [{ before: null, after }]
      );
      readCounts.push(getClaim.mock.calls.length);
      expect(result.changedTopicIds).toEqual([]);
      expect(result.proposalIds).toHaveLength(1);
      expect(listClaimsForTopic).not.toHaveBeenCalled();
      expect(getClaim.mock.calls.length).toBeLessThanOrEqual(256);
      expect(database.connection.prepare("SELECT COUNT(*) AS count FROM claims WHERE extraction_version = 'scale-fixture-v1'").get()).toEqual({ count: scale });
      expect(database.getClaim(after.id, true)?.topicId).toBeNull();
      getClaim.mockRestore();
      listClaimsForTopic.mockRestore();
    }
    expect(Math.max(...readCounts) - Math.min(...readCounts)).toBeLessThanOrEqual(2);
    expect(database.listPendingTopicShardProposals()).toHaveLength(1);
  });

  it("records unambiguous projected-topic intent for history, removal, and cross-parent moves", async () => {
    const { database, processor, config } = await fixture();
    const initialEvents = Array.from({ length: 64 }, (_, index) => database.appendEvent({
      role: "user",
      content: `Remember this important transition profile fact ${index}: transition ${index} is current.`
    }));
    await compileInBatches(processor, database, initialEvents);
    const parent = database.connection.prepare(`
      SELECT page.id, page.title FROM topic_pages page
      JOIN topic_projection_state projection ON projection.parent_topic_id = page.id AND projection.mode = 'sharded'
      WHERE page.title = 'User profile' AND page.lifecycle_status = 'active'
    `).get() as { id: string; title: string };
    database.setTopicUpdatePolicy(parent.id, "confirm");
    const claimRows = database.connection.prepare(`
      SELECT id FROM claims WHERE topic_id = ? AND status = 'current'
      ORDER BY observed_at, id LIMIT 3
    `).all(parent.id) as Array<{ id: string }>;
    expect(claimRows).toHaveLength(3);

    const historyBefore = asEvidenceClaim(database, claimRows[0]!.id);
    database.connection.prepare("UPDATE claims SET status = 'historical', valid_to = ? WHERE id = ?")
      .run("2026-07-14T11:00:00.000Z", historyBefore.id);
    const historyAfter = asEvidenceClaim(database, historyBefore.id);
    const historyResult = await compileAffectedTopics(
      database,
      deterministicDelta([historyAfter], [parent.title]),
      [historyAfter],
      config,
      "2026-07-14T12:00:00.000Z",
      [{ before: historyBefore, after: historyAfter }]
    );
    const historyGuard = database.getTopicShardProposal(historyResult.proposalIds[0]!)!.claimGuards
      .find((guard) => guard.claimId === historyAfter.id)!;
    expect(historyGuard).toMatchObject({
      expectedTopicId: parent.id,
      projectedTopicId: parent.id,
      assignToTopicId: null
    });
    expect(database.connection.prepare(`
      SELECT COUNT(*) AS count FROM topic_section_shards shard
      JOIN topic_pages child ON child.id = shard.child_topic_id AND child.lifecycle_status = 'active'
      JOIN topic_page_revisions revision ON revision.topic_id = child.id AND revision.revision_number = child.active_revision
      JOIN page_section_sources pss ON pss.revision_id = revision.id AND pss.claim_id = ?
      WHERE shard.parent_topic_id = ? AND shard.section_key = 'current_state'
    `).get(historyAfter.id, parent.id)).toEqual({ count: 0 });

    const removalBefore = asEvidenceClaim(database, claimRows[1]!.id);
    database.connection.prepare("UPDATE claims SET status = 'expired', valid_to = ? WHERE id = ?")
      .run("2026-07-14T11:30:00.000Z", removalBefore.id);
    const removalCanonical = asEvidenceClaim(database, removalBefore.id);
    const removalAfter = { ...removalCanonical, topicId: null };
    const removalResult = await compileAffectedTopics(
      database,
      deterministicDelta([removalAfter], [parent.title]),
      [removalAfter],
      config,
      "2026-07-14T12:30:00.000Z",
      [{ before: removalBefore, after: removalAfter }]
    );
    expect(removalResult.proposalIds).toEqual([]);
    expect(database.connection.prepare(`
      SELECT COUNT(*) AS count FROM topic_section_shards shard
      JOIN topic_pages child ON child.id = shard.child_topic_id AND child.lifecycle_status = 'active'
      JOIN topic_page_revisions revision ON revision.topic_id = child.id AND revision.revision_number = child.active_revision
      JOIN page_section_sources pss ON pss.revision_id = revision.id AND pss.claim_id = ?
      WHERE shard.parent_topic_id = ?
    `).get(removalAfter.id, parent.id)).toEqual({ count: 0 });

    const moveBefore = asEvidenceClaim(database, claimRows[2]!.id);
    const destinationTopicId = uuidv7();
    database.connection.prepare("UPDATE claims SET topic_id = ? WHERE id = ?").run(destinationTopicId, moveBefore.id);
    const moveAfter = asEvidenceClaim(database, moveBefore.id);
    const moveResult = await compileAffectedTopics(
      database,
      deterministicDelta([moveAfter], [parent.title]),
      [moveAfter],
      config,
      "2026-07-14T13:00:00.000Z",
      [{ before: moveBefore, after: moveAfter }]
    );
    expect(moveResult.proposalIds).toEqual([]);
    expect(database.connection.prepare(`
      SELECT COUNT(*) AS count FROM topic_section_shards shard
      JOIN topic_pages child ON child.id = shard.child_topic_id AND child.lifecycle_status = 'active'
      JOIN topic_page_revisions revision ON revision.topic_id = child.id AND revision.revision_number = child.active_revision
      JOIN page_section_sources pss ON pss.revision_id = revision.id AND pss.claim_id = ?
      WHERE shard.parent_topic_id = ?
    `).get(moveAfter.id, parent.id)).toEqual({ count: 0 });
  });

  it("cleans both bounded parents when a claim moves between sharded topics", async () => {
    const { database, processor } = await fixture();
    const userEvents = Array.from({ length: 64 }, (_, index) => database.appendEvent({
      role: "user",
      content: `Remember this important movable user fact ${index}: user component ${index} is durable.`
    }));
    const assistantEvents = Array.from({ length: 64 }, (_, index) => database.appendEvent({
      role: "assistant",
      content: `Attributed conclusion: assistant component ${index} has important durable constraint ${index}.`
    }));
    await compileInBatches(processor, database, userEvents);
    await compileInBatches(processor, database, assistantEvents);
    const parents = database.connection.prepare(`
      SELECT page.id, page.title FROM topic_pages page
      JOIN topic_projection_state projection ON projection.parent_topic_id = page.id AND projection.mode = 'sharded'
      WHERE page.title IN ('User profile', 'Assistant conclusions') AND page.lifecycle_status = 'active'
    `).all() as Array<{ id: string; title: string }>;
    const sourceParent = parents.find((page) => page.title === "User profile")!;
    const destinationParent = parents.find((page) => page.title === "Assistant conclusions")!;
    expect(sourceParent).toBeDefined();
    expect(destinationParent).toBeDefined();
    const moved = database.connection.prepare("SELECT id FROM claims WHERE topic_id = ? AND status IN ('current', 'conflicted') ORDER BY observed_at DESC, id DESC LIMIT 1").get(sourceParent.id) as { id: string };
    const priorMemberships = database.connection.prepare(`
      SELECT DISTINCT shard.child_topic_id FROM topic_section_shards shard
      JOIN topic_pages child ON child.id = shard.child_topic_id AND child.lifecycle_status = 'active'
      JOIN topic_page_revisions revision ON revision.topic_id = child.id AND revision.revision_number = child.active_revision
      JOIN page_section_sources pss ON pss.revision_id = revision.id AND pss.claim_id = ?
      WHERE shard.parent_topic_id = ?
    `).all(moved.id, sourceParent.id) as Array<{ child_topic_id: string }>;
    const crashTimestamp = new Date().toISOString();
    // Simulate the exact hard-crash boundary: canonical assignment plus both
    // dirty-parent generations committed, but no in-memory before/after edge
    // survived to projection compilation.
    database.connection.transaction(() => {
      database.connection.prepare("UPDATE claims SET topic_id = ? WHERE id = ?").run(destinationParent.id, moved.id);
      database.connection.prepare(`
        INSERT INTO topic_projection_dirty(parent_topic_id, claim_id, first_seen_at, generation, repair_token)
        VALUES (?, ?, ?, 1, ?), (?, ?, ?, 1, ?)
      `).run(sourceParent.id, moved.id, crashTimestamp, uuidv7(), destinationParent.id, moved.id, crashTimestamp, uuidv7());
    })();
    const rebuild = database.enqueueJob(
      "memory.rebuild",
      stableHash(`dirty-move-rebuild:${moved.id}`),
      { topicIds: [sourceParent.id, destinationParent.id], reason: "test_crash_replay", claimGenerations: [{ claimId: moved.id, generation: 1 }] },
      15
    );

    await processor.process(rebuild);

    const membershipCounts = database.connection.prepare(`
      SELECT shard.parent_topic_id, COUNT(DISTINCT shard.section_key) AS count FROM topic_section_shards shard
      JOIN topic_pages child ON child.id = shard.child_topic_id AND child.lifecycle_status = 'active'
      JOIN topic_page_revisions revision ON revision.topic_id = child.id AND revision.revision_number = child.active_revision
      JOIN page_section_sources pss ON pss.revision_id = revision.id AND pss.claim_id = ?
      WHERE shard.parent_topic_id IN (?, ?)
      GROUP BY shard.parent_topic_id
    `).all(moved.id, sourceParent.id, destinationParent.id) as Array<{ parent_topic_id: string; count: number }>;
    expect(membershipCounts.find((row) => row.parent_topic_id === sourceParent.id)).toBeUndefined();
    expect(membershipCounts.find((row) => row.parent_topic_id === destinationParent.id)?.count).toBe(2);
    for (const membership of priorMemberships) {
      const link = database.connection.prepare("SELECT evidence_json FROM page_links WHERE source_topic_id = ? AND target_topic_id = ? AND relation_type = 'contains'").get(sourceParent.id, membership.child_topic_id) as { evidence_json: string } | undefined;
      if (link) expect(JSON.parse(link.evidence_json)).not.toContain(moved.id);
    }
    const destinationLinks = database.connection.prepare(`
      SELECT link.evidence_json FROM page_links link
      JOIN topic_section_shards shard ON shard.child_topic_id = link.target_topic_id
      WHERE link.source_topic_id = ? AND link.relation_type = 'contains' AND shard.parent_topic_id = ?
    `).all(destinationParent.id, destinationParent.id) as Array<{ evidence_json: string }>;
    expect(destinationLinks.filter((link) => (JSON.parse(link.evidence_json) as string[]).includes(moved.id))).toHaveLength(2);
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM topic_projection_dirty WHERE claim_id = ?").get(moved.id)).toEqual({ count: 0 });
    expect(database.listJobs(500).some((job) => job.type === "projection.sync"
      && Array.isArray(job.payload.topicIds)
      && (job.payload.topicIds as unknown[]).includes(sourceParent.id))).toBe(true);
  });

  it("patches a sharded topic when a current claim reaches its freshness deadline", async () => {
    const { database, processor } = await fixture();
    const events = Array.from({ length: 64 }, (_, index) => database.appendEvent({
      role: "user",
      content: `Remember this important time-sensitive project fact ${index}: deployment channel ${index} is current.`
    }));
    for (let offset = 0; offset < events.length; offset += 32) {
      await processor.process(compileJob(database, "", events.slice(offset, offset + 32).map((event) => event.id)));
    }
    const current = database.connection.prepare("SELECT id, topic_id FROM claims WHERE status = 'current' ORDER BY observed_at DESC, id DESC LIMIT 1").get() as { id: string; topic_id: string };
    expect(database.connection.prepare("SELECT mode FROM topic_projection_state WHERE parent_topic_id = ?").get(current.topic_id)).toEqual({ mode: "sharded" });
    const expiry = "2026-01-01T00:00:00.000Z";
    database.connection.prepare("UPDATE claims SET freshness_expires_at = ? WHERE id = ?").run(expiry, current.id);
    database.connection.prepare(`
      INSERT INTO vectors(id, source_id, source_type, model_id, dimensions, content_hash, embedding_version, embedding_json, created_at)
      VALUES (?, ?, 'claim', 'stale-claim-model', 2, ?, 'v1', '[1,0]', ?)
    `).run(uuidv7(), current.id, stableHash("stale claim vector"), new Date().toISOString());
    const dirtyJobsBefore = new Set(database.listJobs(500)
      .filter((queued) => queued.type === "memory.rebuild" && queued.payload.reason === "claim_projection_dirty")
      .map((queued) => queued.idempotencyKey));
    const job = database.enqueueJobAt("memory.expire", stableHash(`memory.expire:${current.id}:${expiry}`), { claimId: current.id, freshnessExpiresAt: expiry }, expiry, 8);

    await processor.process(job);

    expect(database.connection.prepare("SELECT status FROM claims WHERE id = ?").get(current.id)).toEqual({ status: "expired" });
    expect(database.connection.prepare(`
      SELECT COUNT(*) AS count FROM topic_section_shards shard
      JOIN topic_pages child ON child.id = shard.child_topic_id AND child.lifecycle_status = 'active'
      JOIN topic_page_revisions revision ON revision.topic_id = child.id AND revision.revision_number = child.active_revision
      JOIN page_section_sources pss ON pss.revision_id = revision.id AND pss.claim_id = ?
      WHERE shard.parent_topic_id = ? AND shard.section_key = 'current_state'
    `).get(current.id, current.topic_id)).toEqual({ count: 0 });
    expect(Number((database.connection.prepare(`
      SELECT COUNT(*) AS count FROM topic_section_shards shard
      JOIN topic_pages child ON child.id = shard.child_topic_id AND child.lifecycle_status = 'active'
      JOIN topic_page_revisions revision ON revision.topic_id = child.id AND revision.revision_number = child.active_revision
      JOIN page_section_sources pss ON pss.revision_id = revision.id AND pss.claim_id = ?
      WHERE shard.parent_topic_id = ? AND shard.section_key = 'history'
    `).get(current.id, current.topic_id) as { count: number }).count)).toBe(0);
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM vectors WHERE source_id = ? AND source_type = 'claim'").get(current.id)).toEqual({ count: 0 });
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM topic_projection_dirty WHERE claim_id = ?").get(current.id)).toEqual({ count: 0 });

    const afterFirst = database.listJobs(500)
      .filter((queued) => queued.type === "memory.rebuild" && queued.payload.reason === "claim_projection_dirty"
        && !dirtyJobsBefore.has(queued.idempotencyKey));
    expect(afterFirst).toHaveLength(1);
    const secondExpiry = "2026-01-02T00:00:00.000Z";
    database.connection.prepare(`
      UPDATE claims SET status = 'current', valid_to = NULL, freshness_expires_at = ? WHERE id = ?
    `).run(secondExpiry, current.id);
    const secondJob = database.enqueueJobAt(
      "memory.expire",
      stableHash(`memory.expire:${current.id}:${secondExpiry}`),
      { claimId: current.id, freshnessExpiresAt: secondExpiry },
      secondExpiry,
      8
    );
    await processor.process(secondJob);
    const afterSecond = database.listJobs(500)
      .filter((queued) => queued.type === "memory.rebuild" && queued.payload.reason === "claim_projection_dirty"
        && !dirtyJobsBefore.has(queued.idempotencyKey));
    expect(afterSecond).toHaveLength(2);
    expect(new Set(afterSecond.map((queued) => queued.idempotencyKey)).size).toBe(2);
    expect(new Set(afterSecond.flatMap((queued) => Array.isArray(queued.payload.claimGenerations)
      ? queued.payload.claimGenerations.map((entry) => String((entry as { repairToken?: unknown }).repairToken ?? ""))
      : [])).size).toBe(2);
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM topic_projection_dirty WHERE claim_id = ?").get(current.id)).toEqual({ count: 0 });
  });

  it("reconciles a freshness retry after the ledger was already expired and replaces active link provenance", async () => {
    const { database, processor } = await fixture();
    const events = Array.from({ length: 64 }, (_, index) => database.appendEvent({
      role: "user",
      content: `Remember this important retry-sensitive project fact ${index}: release lane ${index} is current.`
    }));
    await compileInBatches(processor, database, events);
    const current = database.connection.prepare("SELECT id, topic_id FROM claims WHERE status IN ('current', 'conflicted') ORDER BY observed_at DESC, id DESC LIMIT 1").get() as { id: string; topic_id: string };
    const oldCurrentShard = database.connection.prepare(`
      SELECT shard.child_topic_id FROM topic_section_shards shard
      JOIN topic_pages child ON child.id = shard.child_topic_id AND child.lifecycle_status = 'active'
      JOIN topic_page_revisions revision ON revision.topic_id = child.id AND revision.revision_number = child.active_revision
      JOIN page_section_sources pss ON pss.revision_id = revision.id AND pss.claim_id = ?
      WHERE shard.parent_topic_id = ? AND shard.section_key = 'current_state' LIMIT 1
    `).get(current.id, current.topic_id) as { child_topic_id: string };
    const expiry = "2026-01-01T00:00:00.000Z";
    // Simulate a crash boundary: the canonical ledger transition committed,
    // while the active projection and materialized links are still stale.
    database.connection.prepare("UPDATE claims SET status = 'expired', freshness_expires_at = ?, valid_to = ? WHERE id = ?").run(expiry, expiry, current.id);
    const job = database.enqueueJobAt("memory.expire", stableHash(`retry-expire:${current.id}:${expiry}`), { claimId: current.id, freshnessExpiresAt: expiry }, expiry, 8);

    await processor.process(job);

    expect(database.connection.prepare(`
      SELECT COUNT(*) AS count FROM topic_section_shards shard
      JOIN topic_pages child ON child.id = shard.child_topic_id AND child.lifecycle_status = 'active'
      JOIN topic_page_revisions revision ON revision.topic_id = child.id AND revision.revision_number = child.active_revision
      JOIN page_section_sources pss ON pss.revision_id = revision.id AND pss.claim_id = ?
      WHERE shard.parent_topic_id = ? AND shard.section_key = 'current_state'
    `).get(current.id, current.topic_id)).toEqual({ count: 0 });
    expect(database.connection.prepare(`
      SELECT COUNT(*) AS count FROM topic_section_shards shard
      JOIN topic_pages child ON child.id = shard.child_topic_id AND child.lifecycle_status = 'active'
      JOIN topic_page_revisions revision ON revision.topic_id = child.id AND revision.revision_number = child.active_revision
      JOIN page_section_sources pss ON pss.revision_id = revision.id AND pss.claim_id = ?
      WHERE shard.parent_topic_id = ?
    `).get(current.id, current.topic_id)).toEqual({ count: 0 });
    const oldContains = database.connection.prepare("SELECT evidence_json FROM page_links WHERE source_topic_id = ? AND target_topic_id = ? AND relation_type = 'contains'").get(current.topic_id, oldCurrentShard.child_topic_id) as { evidence_json: string } | undefined;
    if (oldContains) expect(JSON.parse(oldContains.evidence_json)).not.toContain(current.id);

    const revisionCount = database.connection.prepare("SELECT COUNT(*) AS count FROM topic_page_revisions").get();
    await processor.process(job);
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM topic_page_revisions").get()).toEqual(revisionCount);

    const unsupported = database.connection.prepare(`
      SELECT claim.id, claim.topic_id, source.source_id FROM claims claim
      JOIN claim_sources source ON source.claim_id = claim.id
      JOIN events event ON event.id = source.source_id AND event.active = 1
      WHERE claim.topic_id = ? AND claim.status IN ('current', 'conflicted') AND claim.id <> ?
      ORDER BY claim.observed_at DESC, claim.id DESC LIMIT 1
    `).get(current.topic_id, current.id) as { id: string; topic_id: string; source_id: string };
    const unsupportedMemberships = database.connection.prepare(`
      SELECT DISTINCT shard.child_topic_id FROM topic_section_shards shard
      JOIN topic_pages child ON child.id = shard.child_topic_id AND child.lifecycle_status = 'active'
      JOIN topic_page_revisions revision ON revision.topic_id = child.id AND revision.revision_number = child.active_revision
      JOIN page_section_sources pss ON pss.revision_id = revision.id AND pss.claim_id = ?
      WHERE shard.parent_topic_id = ?
    `).all(unsupported.id, unsupported.topic_id) as Array<{ child_topic_id: string }>;
    database.connection.prepare("UPDATE events SET active = 0 WHERE id = ?").run(unsupported.source_id);
    database.connection.prepare("UPDATE claims SET status = 'expired', freshness_expires_at = ?, valid_to = ? WHERE id = ?").run(expiry, expiry, unsupported.id);
    const unsupportedJob = database.enqueueJobAt("memory.expire", stableHash(`unsupported-expire:${unsupported.id}:${expiry}`), { claimId: unsupported.id, freshnessExpiresAt: expiry }, expiry, 8);

    const unsupportedResult = await processor.process(unsupportedJob) as { lostActiveEvidence: boolean };

    expect(unsupportedResult.lostActiveEvidence).toBe(true);
    expect(database.connection.prepare(`
      SELECT COUNT(*) AS count FROM topic_section_shards shard
      JOIN topic_pages child ON child.id = shard.child_topic_id AND child.lifecycle_status = 'active'
      JOIN topic_page_revisions revision ON revision.topic_id = child.id AND revision.revision_number = child.active_revision
      JOIN page_section_sources pss ON pss.revision_id = revision.id AND pss.claim_id = ?
      WHERE shard.parent_topic_id = ?
    `).get(unsupported.id, unsupported.topic_id)).toEqual({ count: 0 });
    for (const membership of unsupportedMemberships) {
      const link = database.connection.prepare("SELECT evidence_json FROM page_links WHERE source_topic_id = ? AND target_topic_id = ? AND relation_type = 'contains'").get(unsupported.topic_id, membership.child_topic_id) as { evidence_json: string } | undefined;
      if (link) expect(JSON.parse(link.evidence_json)).not.toContain(unsupported.id);
    }
  });

  it("removes a generated inline page when its final evidence disappears but preserves a trusted user page", async () => {
    const { database, processor, config } = await fixture();
    const source = database.appendEvent({ role: "user", content: "Remember this important single inline fact: the release badge is amber." });
    await processor.process(compileJob(database, "", [source.id]));
    const generatedClaim = database.connection.prepare("SELECT id, topic_id FROM claims WHERE source_role = 'user' LIMIT 1").get() as { id: string; topic_id: string };
    const generatedTopic = database.getTopic(generatedClaim.topic_id)!;
    expect(database.connection.prepare("SELECT mode FROM topic_projection_state WHERE parent_topic_id = ?").get(generatedTopic.id)).toEqual({ mode: "inline" });
    const projectionPath = join(config.projectionsDir, `${generatedTopic.id}-${generatedTopic.slug}.md`);
    await expect(access(projectionPath)).resolves.toBeUndefined();
    const expiry = "2026-01-01T00:00:00.000Z";
    database.connection.prepare("UPDATE events SET active = 0 WHERE id = ?").run(source.id);
    database.connection.prepare("UPDATE claims SET status = 'expired', freshness_expires_at = ?, valid_to = ? WHERE id = ?").run(expiry, expiry, generatedClaim.id);
    const generatedJob = database.enqueueJobAt("memory.expire", stableHash(`inline-final-expire:${generatedClaim.id}`), { claimId: generatedClaim.id, freshnessExpiresAt: expiry }, expiry, 8);

    const generatedResult = await processor.process(generatedJob) as { removedTopicId: string };

    expect(generatedResult.removedTopicId).toBe(generatedTopic.id);
    expect(database.getTopic(generatedTopic.id)).toBeNull();
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM page_links WHERE source_topic_id = ? OR target_topic_id = ?").get(generatedTopic.id, generatedTopic.id)).toEqual({ count: 0 });
    await expect(access(projectionPath)).rejects.toThrow();
    expect(database.listJobs(500).some((job) => job.type === "projection.sync"
      && Array.isArray(job.payload.topicIds) && job.payload.topicIds.includes(generatedTopic.id))).toBe(true);

    const trusted = database.upsertTopicRevision({
      type: "concept",
      title: "Trusted release notes",
      slug: "trusted-release-notes",
      markdown: "# Trusted release notes\n\nUser-owned content.",
      summary: "User-owned content.",
      currentState: "User-owned content.",
      history: "",
      sourceIds: [],
      authorType: "user",
      promptVersion: "user-edit-v1"
    });
    const trustedSource = database.appendEvent({ role: "user", content: "Trusted page support." });
    const trustedClaim = database.upsertClaim({
      topicId: trusted.id,
      subject: "Trusted release notes",
      predicate: "has",
      value: "temporary support",
      confidence: 1,
      status: "expired",
      sourceRole: "user",
      sourceIds: [trustedSource.id],
      validFrom: null,
      validTo: expiry,
      observedAt: expiry,
      freshnessExpiresAt: expiry
    });
    database.connection.prepare("UPDATE events SET active = 0 WHERE id = ?").run(trustedSource.id);
    const trustedJob = database.enqueueJobAt("memory.expire", stableHash(`trusted-final-expire:${trustedClaim.id}`), { claimId: trustedClaim.id, freshnessExpiresAt: expiry }, expiry, 8);

    const trustedResult = await processor.process(trustedJob) as { preservedUserAuthored: boolean };

    expect(trustedResult.preservedUserAuthored).toBe(true);
    expect(database.getTopic(trusted.id)).toMatchObject({ id: trusted.id, userAuthored: true });
  });

  it("persists the same final temporal state when multiple claims reconcile in one batch", async () => {
    const { database, processor } = await fixture();
    const first = database.appendEvent({ role: "user", content: "Remember this important fact: my launch color is red." });
    const correction = database.appendEvent({ role: "user", content: "Actually, correction: remember this important fact: my launch color is blue." });

    await processor.process(compileJob(database, "", [first.id, correction.id]));

    expect(database.connection.prepare("SELECT value, status FROM claims ORDER BY observed_at, id").all()).toEqual([
      { value: first.content, status: "superseded" },
      { value: correction.content, status: "current" }
    ]);
    expect(database.connection.prepare("SELECT relation_type FROM claim_relations ORDER BY relation_type").all()).toEqual([
      { relation_type: "contradicts" },
      { relation_type: "supersedes" }
    ]);
  });

  it("reconciles a later correction after the original claim has been assigned to a compiled topic", async () => {
    const { database, processor } = await fixture();
    const first = database.appendEvent({ role: "user", content: "Remember this important fact: my launch color is red." });
    await processor.process(compileJob(database, "", [first.id]));
    const firstClaim = database.connection.prepare("SELECT topic_id FROM claims WHERE value = ?").get(first.content) as { topic_id: string };
    expect(firstClaim).toEqual({ topic_id: expect.any(String) });

    const correction = database.appendEvent({ role: "user", content: "Actually, correction: remember this important fact: my launch color is blue." });
    await processor.process(compileJob(database, "", [correction.id]));

    expect(database.connection.prepare("SELECT value, status, topic_id FROM claims ORDER BY observed_at, id").all()).toEqual([
      { value: first.content, status: "superseded", topic_id: expect.any(String) },
      { value: correction.content, status: "current", topic_id: expect.any(String) }
    ]);
    expect(database.connection.prepare("SELECT relation_type FROM claim_relations ORDER BY relation_type").all()).toEqual([
      { relation_type: "contradicts" },
      { relation_type: "supersedes" }
    ]);
    expect(database.listJobs(500).filter((job) => job.type === "embedding.index" && job.payload.sourceType === "topic" && job.payload.sourceId === firstClaim.topic_id)).toHaveLength(2);
  });

  it("does not re-attribute the mock assistant echo while retaining a genuine assistant conclusion", async () => {
    const { database, processor } = await fixture();
    const user = database.appendEvent({ role: "user", content: "Remember that my preferred theme is dark mode." });
    const echo = database.appendEvent({
      role: "assistant",
      content: "This is Continuum’s local test response to: “Remember that my preferred theme is dark mode.”. I checked the relevant local memory and kept the supporting evidence linked."
    });
    const conclusion = database.appendEvent({
      role: "assistant",
      content: "Attributed conclusion: graph expansion must be bounded to prevent semantic drift."
    });

    await processor.process(compileJob(database, "", [user.id, echo.id, conclusion.id]));

    expect(database.connection.prepare("SELECT value, source_role FROM claims ORDER BY observed_at, id").all()).toEqual([
      { value: user.content, source_role: "user" },
      { value: conclusion.content, source_role: "assistant" }
    ]);
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM claim_sources WHERE source_id = ?").get(echo.id)).toEqual({ count: 0 });
  });

  it("persists per-chunk parser, chunker, location, and metadata audit fields", async () => {
    const { database, processor, config } = await fixture();
    const bytes = new TextEncoder().encode("# Audit heading\n\nA source chunk with auditable parser metadata.");
    const stored = await new FileSystemContentAddressedStore(config.attachmentsDir).put(bytes);
    const sourceId = database.createSource({ type: "attachment", title: "audit.md", contentHash: stored.sha256 });
    const attachment = database.createAttachment({ sourceId, filename: "audit.md", mediaType: "text/markdown", size: bytes.byteLength, storagePath: stored.storageKey, contentHash: stored.sha256, status: "queued" });
    const job = database.enqueueJob("source.extract", stableHash(`extract:${attachment.id}`), { attachmentId: attachment.id });

    await processor.process(job);

    const chunks = database.connection.prepare("SELECT id, ordinal, location_json, parser_version, chunker_version, metadata_json FROM source_chunks WHERE source_id = ? ORDER BY ordinal").all(sourceId) as Array<{ id: string; ordinal: number; location_json: string; parser_version: string; chunker_version: string; metadata_json: string }>;
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.parser_version).toMatch(/^continuum-ingestion\//);
      expect(chunk.chunker_version).toMatch(/^continuum-chunker\//);
      expect(JSON.parse(chunk.location_json)).toEqual(expect.objectContaining({ lineStart: expect.any(Number) }));
      expect(JSON.parse(chunk.metadata_json)).toEqual(expect.objectContaining({
        audit: expect.objectContaining({ attachmentId: attachment.id, ordinal: chunk.ordinal, contentHash: expect.stringMatching(/^[a-f0-9]{64}$/), location: JSON.parse(chunk.location_json) })
      }));
    }

    // Simulate a worker crash after chunk commit but before the source job was
    // acknowledged. Re-delivery must reuse the exact committed chunk IDs.
    await processor.process(job);
    expect(database.connection.prepare("SELECT id, ordinal FROM source_chunks WHERE source_id = ? ORDER BY ordinal").all(sourceId)).toEqual(
      chunks.map((chunk) => ({ id: chunk.id, ordinal: chunk.ordinal }))
    );
    expect(database.getAttachment(attachment.id)).toMatchObject({ status: "ready" });
  });

  it("safely replaces a mismatched partial chunk set and removes its derived provenance", async () => {
    const { database } = await fixture();
    const timestamp = "2026-07-14T12:00:00.000Z";
    const sourceId = database.createSource({ type: "attachment", title: "retry.txt", contentHash: stableHash("retry-source") });
    const [oldChunkId] = database.addSourceChunks(sourceId, [{ text: "partial stale extraction" }]);
    const topic = database.upsertTopicRevision({
      type: "concept",
      title: "Chunk retry",
      slug: "chunk-retry",
      markdown: "# Chunk retry\n\nPartial stale extraction.",
      summary: "Partial stale extraction.",
      currentState: "Partial stale extraction.",
      history: "",
      sourceIds: [oldChunkId!],
      authorType: "model",
      promptVersion: "test-v1"
    });
    const claim = database.upsertClaim({
      topicId: topic.id,
      subject: "Chunk retry",
      predicate: "contains",
      value: "partial stale extraction",
      confidence: 1,
      status: "current",
      sourceRole: "tool",
      sourceIds: [oldChunkId!],
      validFrom: null,
      validTo: null,
      observedAt: timestamp,
      freshnessExpiresAt: null
    });
    database.connection.prepare("UPDATE claim_sources SET source_type = 'chunk' WHERE claim_id = ? AND source_id = ?").run(claim.id, oldChunkId);
    const revision = database.connection.prepare("SELECT id FROM topic_page_revisions WHERE topic_id = ? AND revision_number = 1").get(topic.id) as { id: string };
    database.connection.prepare(`
      INSERT INTO page_section_sources(id, revision_id, section_key, start_offset, end_offset, claim_id, source_id)
      VALUES (?, ?, 'current_state', 0, 24, ?, ?)
    `).run(uuidv7(), revision.id, claim.id, oldChunkId);
    database.connection.prepare(`
      INSERT INTO vectors(id, source_id, source_type, model_id, dimensions, content_hash, embedding_version, embedding_json, created_at)
      VALUES (?, ?, 'chunk', 'test', 2, ?, 'v1', '[1,0]', ?)
    `).run(uuidv7(), oldChunkId, stableHash("partial stale extraction"), timestamp);

    const replacement = database.addSourceChunksDetailed(sourceId, [
      { text: "complete replacement part one" },
      { text: "complete replacement part two" }
    ]);
    const replacementIds = replacement.chunkIds;

    expect(replacementIds).toHaveLength(2);
    expect(replacement).toMatchObject({ exactReplay: false, invalidatedClaimIds: [claim.id], invalidatedTopicIds: [topic.id] });
    expect(replacementIds).not.toContain(oldChunkId);
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM source_chunks WHERE id = ?").get(oldChunkId)).toEqual({ count: 0 });
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM vectors WHERE source_id = ?").get(oldChunkId)).toEqual({ count: 0 });
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM page_section_sources WHERE source_id = ? OR claim_id = ?").get(oldChunkId, claim.id)).toEqual({ count: 0 });
    expect(database.getClaim(claim.id, true)).toBeNull();
    expect(database.search("partial stale extraction", 20, { types: ["topic"], status: "current" }).some((result) => result.id === topic.id)).toBe(false);
    expect(database.addSourceChunksDetailed(sourceId, [
      { text: "complete replacement part one", parserVersion: "parser-v2", chunkerVersion: "chunker-v2", metadata: { replay: true } },
      { text: "complete replacement part two", parserVersion: "parser-v2", chunkerVersion: "chunker-v2", metadata: { replay: true } }
    ])).toEqual({ chunkIds: replacementIds, exactReplay: true, invalidatedClaimIds: [], invalidatedTopicIds: [] });
    expect(database.connection.prepare("SELECT parser_version, chunker_version, metadata_json FROM source_chunks WHERE source_id = ? ORDER BY ordinal").all(sourceId))
      .toEqual([
        { parser_version: "parser-v2", chunker_version: "chunker-v2", metadata_json: JSON.stringify({ replay: true }) },
        { parser_version: "parser-v2", chunker_version: "chunker-v2", metadata_json: JSON.stringify({ replay: true }) }
      ]);
  });

  it("rebuilds invalidated chunk roots before source readiness, removes orphan files, and preserves trusted pages", async () => {
    const { database, processor, config } = await fixture();
    const bytes = new TextEncoder().encode("Complete replacement source text with no legacy projection token.");
    const stored = await new FileSystemContentAddressedStore(config.attachmentsDir).put(bytes);
    const sourceId = database.createSource({ type: "attachment", title: "replacement.txt", contentHash: stored.sha256 });
    const attachment = database.createAttachment({
      sourceId,
      filename: "replacement.txt",
      mediaType: "text/plain",
      size: bytes.byteLength,
      storagePath: stored.storageKey,
      contentHash: stored.sha256,
      status: "queued"
    });
    const [oldChunkId] = database.addSourceChunks(sourceId, [{ text: "orphanedprojectiontoken stale chunk" }]);
    const generated = database.upsertTopicRevision({
      type: "concept",
      title: "Obsolete generated chunk page",
      slug: "obsolete-generated-chunk-page",
      markdown: "# Obsolete generated chunk page\n\nOrphanedprojectiontoken must disappear.",
      summary: "Orphanedprojectiontoken must disappear.",
      currentState: "Orphanedprojectiontoken must disappear.",
      history: "",
      sourceIds: [oldChunkId!],
      authorType: "model",
      promptVersion: "test-v1"
    });
    const trusted = database.upsertTopicRevision({
      type: "concept",
      title: "Trusted chunk notes",
      slug: "trusted-chunk-notes",
      markdown: "# Trusted chunk notes\n\nUser-authored text must survive source replacement.",
      summary: "User-authored text must survive source replacement.",
      currentState: "User-authored text must survive source replacement.",
      history: "",
      sourceIds: [oldChunkId!],
      authorType: "user",
      promptVersion: "user-edit-v1"
    });
    const addChunkClaim = (topicId: string, value: string) => {
      const claim = database.upsertClaim({
        topicId,
        subject: "Replacement source",
        predicate: "contained",
        value,
        confidence: 1,
        status: "current",
        sourceRole: "tool",
        sourceIds: [oldChunkId!],
        validFrom: null,
        validTo: null,
        observedAt: "2026-07-14T12:00:00.000Z",
        freshnessExpiresAt: null
      });
      database.connection.prepare("UPDATE claim_sources SET source_type = 'chunk' WHERE claim_id = ? AND source_id = ?").run(claim.id, oldChunkId);
    };
    addChunkClaim(generated.id, "orphanedprojectiontoken stale claim");
    addChunkClaim(trusted.id, "trusted support claim");
    await mkdir(config.projectionsDir, { recursive: true });
    const generatedPath = join(config.projectionsDir, `${generated.id}-${generated.slug}.md`);
    const trustedPath = join(config.projectionsDir, `${trusted.id}-${trusted.slug}.md`);
    await writeFile(generatedPath, database.getTopic(generated.id)!.markdown);
    await writeFile(trustedPath, database.getTopic(trusted.id)!.markdown);
    const job = database.enqueueJob("source.extract", stableHash(`replacement-extract:${attachment.id}`), { attachmentId: attachment.id });

    const result = await processor.process(job) as { invalidatedTopicIds: string[]; memoryRebuild: { removed: string[]; preserved: string[] } };

    expect(result.invalidatedTopicIds).toEqual(expect.arrayContaining([generated.id, trusted.id]));
    expect(result.memoryRebuild.removed).toContain(generated.id);
    expect(result.memoryRebuild.preserved).toContain(trusted.id);
    expect(database.getAttachment(attachment.id)).toMatchObject({ status: "ready" });
    expect(database.search("orphanedprojectiontoken", 20, { types: ["topic"], status: "current" })).toEqual([]);
    expect(database.getTopic(generated.id)).toBeNull();
    await expect(access(generatedPath)).rejects.toThrow();
    expect(database.getTopic(trusted.id)).toMatchObject({ id: trusted.id, userAuthored: true });
    await expect(access(trustedPath)).resolves.toBeUndefined();
  });

  it("uses persisted vector and graph context to propose an ambiguous entity without auto-merging it", async () => {
    const { database } = await fixture();
    const timestamp = "2026-07-13T12:00:00.000Z";
    const candidateSource = database.appendEvent({ role: "user", content: "Infinite Build is connected to Alice." });
    const mentionSource = database.appendEvent({ role: "user", content: "Infinite Builder Platform works with Alice." });
    const neighborSource = database.appendEvent({ role: "user", content: "Alice is the project owner." });
    const candidateId = stableHash("candidate-entity").slice(0, 8) + "-0000-4000-8000-000000000001";
    const neighborId = stableHash("neighbor-entity").slice(0, 8) + "-0000-4000-8000-000000000002";
    database.connection.prepare("INSERT INTO entities(id, core_type, display_name, normalized_name, status, canonical_description, created_at, updated_at) VALUES (?, 'project', 'Infinite Build', 'infinite build', 'active', '', ?, ?)").run(candidateId, timestamp, timestamp);
    database.connection.prepare("INSERT INTO entities(id, core_type, display_name, normalized_name, status, canonical_description, created_at, updated_at) VALUES (?, 'person', 'Alice', 'alice', 'active', '', ?, ?)").run(neighborId, timestamp, timestamp);
    database.connection.prepare("INSERT INTO entity_aliases(id, entity_id, alias, normalized_alias, confidence, source_id, active, created_at) VALUES (?, ?, 'Infinite Build', 'infinite build', 1, ?, 1, ?)").run(stableHash("candidate-alias"), candidateId, candidateSource.id, timestamp);
    database.connection.prepare("INSERT INTO entity_aliases(id, entity_id, alias, normalized_alias, confidence, source_id, active, created_at) VALUES (?, ?, 'Alice', 'alice', 1, ?, 1, ?)").run(stableHash("neighbor-alias"), neighborId, neighborSource.id, timestamp);
    const insertVector = database.connection.prepare("INSERT INTO vectors(id, source_id, source_type, model_id, dimensions, content_hash, embedding_version, embedding_json, created_at) VALUES (?, ?, 'event', 'test-embedding', 3, ?, 'v1', ?, ?)");
    insertVector.run(stableHash("candidate-vector"), candidateSource.id, stableHash(candidateSource.content), JSON.stringify([1, 0, 0]), timestamp);
    insertVector.run(stableHash("mention-vector"), mentionSource.id, stableHash(mentionSource.content), JSON.stringify([0.99, 0.08, 0]), timestamp);
    database.connection.prepare("INSERT INTO edges(id, source_id, target_id, edge_type, status, evidence_json, created_at) VALUES (?, ?, ?, 'uses', 'current', ?, ?)").run(stableHash("context-edge"), candidateId, neighborId, JSON.stringify([candidateSource.id]), timestamp);
    const delta: MemoryDelta = {
      entities: [
        { mentionId: "ambiguous", displayName: "Infinite Builder Platform", type: "project", aliases: [], confidence: 1, sourceIds: [mentionSource.id] },
        { mentionId: "neighbor", displayName: "Alice", type: "person", aliases: [], confidence: 1, sourceIds: [mentionSource.id] }
      ],
      claims: [],
      relations: [{ sourceMentionId: "ambiguous", targetMentionId: "neighbor", type: "uses", confidence: 1, sourceIds: [mentionSource.id], validFrom: null, validTo: null }],
      affectedTopicHints: [],
      trace: { promptVersion: "test", schemaVersion: "1.0.0", providerModel: "fixture", inputEventIds: [mentionSource.id], warnings: [] }
    };

    const resolved = persistEntities(database, delta, timestamp);

    expect(resolved.get("ambiguous")).not.toBe(candidateId);
    expect(resolved.get("neighbor")).toBe(neighborId);
    const proposals = database.getSetting<Array<{ candidateEntityId: string; createdEntityId: string; reasons: string[]; status: string }>>("memory.pendingEntityMergeProposals", []);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ candidateEntityId: candidateId, createdEntityId: resolved.get("ambiguous"), status: "pending" });
    expect(proposals[0]!.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/^vector similarity 0\.99/), "graph-context similarity 1.000"]));
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM entities WHERE status = 'active'").get()).toEqual({ count: 3 });
  });

  it("reconciles a correction against claims older than the repository page cap", async () => {
    const { database, processor } = await fixture();
    const evidence = database.appendEvent({ role: "user", content: "My launch color was red." });
    database.upsertClaim({
      topicId: null,
      subject: "User",
      predicate: "stated",
      value: "My launch color was red.",
      confidence: 1,
      status: "current",
      sourceRole: "user",
      sourceIds: [evidence.id],
      validFrom: "2020-01-01T00:00:00.000Z",
      validTo: null,
      observedAt: "2020-01-01T00:00:00.000Z",
      freshnessExpiresAt: null
    });
    for (let index = 0; index < 1_005; index += 1) {
      database.upsertClaim({
        topicId: null,
        subject: `Filler ${index}`,
        predicate: "records",
        value: `Value ${index}`,
        confidence: 1,
        status: "current",
        sourceRole: "user",
        sourceIds: [evidence.id],
        validFrom: null,
        validTo: null,
        observedAt: new Date(Date.UTC(2021, 0, 1, 0, 0, index)).toISOString(),
        freshnessExpiresAt: null
      });
    }
    const turn = completedTurn(database, "Actually, correction: remember my launch color is blue.");

    await processor.process(compileJob(database, turn.runId, [turn.event.id, turn.assistant.id]));

    const old = database.connection.prepare("SELECT status FROM claims WHERE value = 'My launch color was red.'").get() as { status: string };
    expect(old.status).toBe("superseded");
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM claims").get()).toMatchObject({ count: 1_007 });
  });

  it("extracts same-run tool and attachment evidence, records exact provenance, and queues raw embeddings", async () => {
    const { database, processor } = await fixture();
    const sourceId = database.createSource({ type: "attachment", title: "project-notes.txt", contentHash: stableHash("project-notes") });
    const attachment = database.createAttachment({ sourceId, filename: "project-notes.txt", mediaType: "text/plain", size: 48, storagePath: "unused", contentHash: stableHash("project-notes"), status: "ready" });
    const chunkIds = database.addSourceChunks(sourceId, Array.from({ length: 30 }, (_, index) => ({
      text: index === 18 ? "The ultraviolet project deadline is October 8 and it is important." : `Ordinary filler section ${index}.`,
      location: { line: index + 1 }
    })));
    const chunkId = chunkIds[18]!;
    const turn = completedTurn(database, "Remember the attached ultraviolet project deadline.", [attachment.id]);
    const tool = database.appendEvent({ role: "tool", kind: "tool_result", status: "complete", content: "Tool verified the important project deadline is October 8.", parentEventId: turn.event.id, runId: turn.runId });

    await processor.process(compileJob(database, turn.runId, [turn.event.id, turn.assistant.id]));

    const sourceTypes = database.connection.prepare("SELECT source_id, source_type FROM claim_sources WHERE source_id IN (?, ?) ORDER BY source_id").all(chunkId, tool.id) as Array<{ source_id: string; source_type: string }>;
    expect(sourceTypes).toEqual(expect.arrayContaining([
      { source_id: chunkId, source_type: "chunk" },
      { source_id: tool.id, source_type: "tool_result" }
    ]));
    const provenance = database.connection.prepare("SELECT section_key, start_offset, end_offset, claim_id FROM page_section_sources WHERE claim_id IS NOT NULL").all() as Array<{ section_key: string; start_offset: number; end_offset: number; claim_id: string }>;
    expect(provenance.length).toBeGreaterThan(0);
    expect(provenance.every((row) => row.end_offset > row.start_offset && row.claim_id.length > 0)).toBe(true);
    expect(provenance.map((row) => row.section_key)).toEqual(expect.arrayContaining(["summary", "current_state", "evidence"]));
    const embeddingJobs = database.listJobs(100).filter((job) => job.type === "embedding.index");
    expect(embeddingJobs.some((job) => job.payload.sourceType === "event" && job.payload.sourceId === tool.id)).toBe(true);
    expect(embeddingJobs.some((job) => job.payload.sourceType === "claim")).toBe(true);
  });

  it("keeps a trusted inline page active while planning an exact normalized sharded conversion", async () => {
    const { database, processor } = await fixture();
    const original = database.upsertTopicRevision({
      type: "person",
      title: "User profile",
      slug: "user-profile",
      markdown: "# User profile\n\nTrusted notes.",
      summary: "Trusted notes.",
      currentState: "Trusted notes.",
      history: "",
      sourceIds: [],
      authorType: "user",
      promptVersion: "user-edit-v1"
    });
    const longFact = `Remember this important plan: ${"preserve detailed context ".repeat(450)}`;
    const turn = completedTurn(database, longFact);

    await processor.process(compileJob(database, turn.runId, [turn.event.id, turn.assistant.id]));

    expect(database.getTopic(original.id)).toMatchObject({ revision: 1, userAuthored: true, summary: "Trusted notes." });
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM topic_page_revisions WHERE topic_id = ? AND prompt_version = 'topic-proposal-v1'").get(original.id)).toEqual({ count: 0 });
    expect(database.getSetting("memory.pendingTopicProposals", [])).toEqual([]);
    const proposals = database.listPendingTopicShardProposals(100);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ kind: "topic_shard_patch", schemaVersion: 2, status: "pending", topicId: original.id });
    expect(proposals[0]!.claimIds.length).toBeGreaterThan(0);
    expect(proposals[0]!.sourceIds).toContain(turn.event.id);
    expect(proposals[0]!.patches.map((patch) => patch.section)).toEqual(expect.arrayContaining(["current_state", "evidence"]));
    const outputs = proposals[0]!.patches.flatMap((patch) => patch.outputs);
    expect(outputs.length).toBeGreaterThan(0);
    expect(outputs.every((output) => output.baseRevision === null)).toBe(true);
    expect(proposals[0]!.claimGuards.some((guard) => guard.expectedTopicId === null
      && guard.projectedTopicId === original.id
      && guard.assignToTopicId === original.id)).toBe(true);
    const proposedIds = outputs.map((output) => output.topicId);
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM topic_pages WHERE lifecycle_status = 'proposal'").get()).toEqual({ count: proposedIds.length });
    const proposalIds = new Set(proposedIds);
    expect(database.search("preserve", 100, { types: ["topic"], status: "current" }).some((result) => proposalIds.has(result.id))).toBe(false);
    const proposedMarks = proposedIds.map(() => "?").join(",");
    const proposalLinks = database.connection.prepare(`SELECT source_topic_id, target_topic_id, relation_type FROM page_links WHERE source_topic_id IN (${proposedMarks}) OR target_topic_id IN (${proposedMarks})`).all(...proposedIds, ...proposedIds);
    expect(proposalLinks).toEqual([]);
    const proposedMarkdown = database.connection.prepare(`
      SELECT tpr.markdown FROM topic_pages tp JOIN topic_page_revisions tpr ON tpr.topic_id = tp.id
      WHERE tp.lifecycle_status = 'proposal'
    `).all() as Array<{ markdown: string }>;
    expect(proposedMarkdown.every((row) => row.markdown.length <= 10_000)).toBe(true);
  });

  it("activates a bounded parent index and evidence-linked child pages atomically", async () => {
    const { database, processor, config } = await fixture();
    const relatedEvidence = database.appendEvent({ role: "user", content: "A reference page supports the user profile architecture." });
    const relatedPage = database.upsertTopicRevision({ type: "concept", title: "Reference page", slug: "reference-page", markdown: "# Reference page\n\n## Summary\n\nReference evidence.", summary: "Reference evidence.", currentState: "", history: "", sourceIds: [relatedEvidence.id], authorType: "user", promptVersion: "test" });
    database.upsertClaim({ topicId: relatedPage.id, subject: "User profile", predicate: "has", value: "reference architecture evidence", confidence: 1, status: "current", sourceRole: "user", sourceIds: [relatedEvidence.id], validFrom: null, validTo: null, observedAt: relatedEvidence.createdAt, freshnessExpiresAt: null });
    const turn = completedTurn(database, `Remember this important architecture record: ${"bounded evidence segment ".repeat(500)}`);

    await processor.process(compileJob(database, turn.runId, [turn.event.id, turn.assistant.id]));

    const active = database.listTopics(500);
    expect(active.length).toBeGreaterThan(1);
    const children = active.filter((page) => page.tags.includes("auto-split"));
    expect(children.length).toBeGreaterThan(0);
    expect(active.every((page) => database.getTopic(page.id)!.markdown.length <= 10_000)).toBe(true);
    const links = database.connection.prepare("SELECT source_topic_id, target_topic_id, relation_type, evidence_json FROM page_links ORDER BY relation_type, target_topic_id").all() as Array<{ source_topic_id: string; target_topic_id: string; relation_type: string; evidence_json: string }>;
    for (const child of children) {
      const contains = links.find((link) => link.target_topic_id === child.id && link.relation_type === "contains");
      expect(contains).toBeDefined();
      expect(database.getTopic(contains!.source_topic_id)!.markdown).toContain("continuum://topic/");
      expect(links).toContainEqual(expect.objectContaining({ source_topic_id: child.id, target_topic_id: contains!.source_topic_id, relation_type: "part_of" }));
    }
    const relatedLinks = links.filter((link) => link.relation_type === "related");
    expect(relatedLinks.length).toBeGreaterThan(0);
    for (const link of relatedLinks) {
      expect(database.getTopic(link.source_topic_id)!.markdown).toContain(`continuum://topic/${encodeURIComponent(link.target_topic_id)}`);
    }
    expect(Number((database.connection.prepare("SELECT COUNT(*) AS count FROM page_section_sources WHERE section_key = 'related_pages' AND claim_id IS NOT NULL").get() as { count: number }).count)).toBeGreaterThan(0);
    expect(links.every((link) => (JSON.parse(link.evidence_json) as string[]).length > 0)).toBe(true);

    const compiledParentId = links.find((link) => link.relation_type === "contains")!.source_topic_id;
    const compiledFamilyIds = [compiledParentId, ...children.map((child) => child.id)];
    const durableProjectionJobs = database.listJobs(500).filter((queued) => queued.type === "projection.sync");
    expect(durableProjectionJobs.some((queued) => Array.isArray(queued.payload.topicIds)
      && compiledFamilyIds.every((topicId) => queued.payload.topicIds.includes(topicId))
      && queued.maximumAttempts >= 8)).toBe(true);
    const durableEmbeddingIds = new Set(database.listJobs(500)
      .filter((queued) => queued.type === "embedding.index" && queued.payload.sourceType === "topic")
      .map((queued) => String(queued.payload.sourceId)));
    expect(compiledFamilyIds.every((topicId) => durableEmbeddingIds.has(topicId))).toBe(true);
    const embeddingModel = database.getSetting("models.embedding", config.models.embedding);
    for (const child of children) {
      database.connection.prepare(`
        INSERT INTO vectors(id, source_id, source_type, model_id, dimensions, content_hash, embedding_version, embedding_json, created_at)
        VALUES (?, ?, 'topic', ?, 2, ?, 'v1', '[1,0]', ?)
      `).run(uuidv7(), child.id, embeddingModel, stableHash(database.getTopic(child.id)!.markdown), new Date().toISOString());
    }
    const jobsBeforeRebuild = new Set(database.listJobs(500).map((queued) => queued.id));
    database.upsertClaim({
      topicId: compiledParentId,
      subject: "User profile",
      predicate: "retains",
      value: "independently supported reference architecture evidence",
      confidence: 1,
      status: "current",
      sourceRole: "user",
      sourceIds: [relatedEvidence.id],
      validFrom: null,
      validTo: null,
      observedAt: relatedEvidence.createdAt,
      freshnessExpiresAt: null
    });

    const deletion = database.hardDeleteEvent(turn.event.id);
    const rebuild = database.enqueueJob("memory.rebuild", stableHash(`partial-rebuild:${deletion.affectedTopicIds.sort().join(":")}`), { topicIds: deletion.affectedTopicIds, reason: "partial_evidence_deletion" });
    await processor.process(rebuild);
    const afterDeletion = database.listTopics(500);
    expect(afterDeletion.some((page) => page.id === compiledParentId)).toBe(true);
    expect(afterDeletion.every((page) => database.getTopic(page.id)!.markdown.length <= 10_000)).toBe(true);
    expect(afterDeletion.filter((page) => page.tags.includes("auto-split"))).toHaveLength(0);
    for (const child of children) {
      expect(database.connection.prepare("SELECT COUNT(*) AS count FROM vectors WHERE source_id = ? AND source_type = 'topic'").get(child.id)).toEqual({ count: 0 });
    }
    const rebuildProjectionJobs = database.listJobs(500).filter((queued) => queued.type === "projection.sync" && !jobsBeforeRebuild.has(queued.id));
    expect(rebuildProjectionJobs.some((queued) => Array.isArray(queued.payload.topicIds)
      && children.every((child) => queued.payload.topicIds.includes(child.id))
      && queued.maximumAttempts >= 8)).toBe(true);
    expect(database.connection.prepare(`
      SELECT COUNT(*) AS count FROM page_links pl
      LEFT JOIN topic_pages source ON source.id = pl.source_topic_id
      LEFT JOIN topic_pages target ON target.id = pl.target_topic_id
      WHERE source.id IS NULL OR target.id IS NULL
    `).get()).toEqual({ count: 0 });
  });

  it("keeps an oversized exact claim canonical while bounding every compiled wiki page", async () => {
    const { database, processor } = await fixture();
    const exact = `Remember this important architecture record: ${"dense requirement ".repeat(3_400)}END-OF-EXACT-CLAIM`;
    const event = database.appendEvent({ role: "user", content: exact });

    await processor.process(compileJob(database, "", [event.id]));

    expect(database.connection.prepare("SELECT value FROM claims WHERE source_role = 'user'").get()).toEqual({ value: exact });
    const active = database.listTopics(500);
    expect(active.length).toBeGreaterThan(0);
    expect(active.every((page) => database.getTopic(page.id)!.markdown.length <= 10_000)).toBe(true);
    expect(active.some((page) => database.getTopic(page.id)!.markdown.includes("characters omitted from this compiled view; exact claim retained"))).toBe(true);
    expect(active.some((page) => database.getTopic(page.id)!.markdown.includes("END-OF-EXACT-CLAIM"))).toBe(true);
  });

  it("preserves a protected parent with an active model index while retracting its final unsafe shard claim", async () => {
    const { database, processor } = await fixture();
    const event = database.appendEvent({
      role: "user",
      content: `Remember this important protected terminal record: ${"durable bounded context ".repeat(1_200)}`
    });
    await processor.process(compileJob(database, "", [event.id]));
    const claim = database.connection.prepare("SELECT id, topic_id FROM claims WHERE source_role = 'user' LIMIT 1")
      .get() as { id: string; topic_id: string };
    const initialParent = database.getTopic(claim.topic_id)!;
    expect(database.connection.prepare("SELECT mode FROM topic_projection_state WHERE parent_topic_id = ?").get(initialParent.id))
      .toEqual({ mode: "sharded" });

    database.upsertTopicRevision({
      id: initialParent.id,
      type: initialParent.type,
      title: initialParent.title,
      slug: initialParent.slug,
      markdown: `# ${initialParent.title}\n\nTrusted immutable user note.`,
      summary: "Trusted immutable user note.",
      currentState: "Trusted immutable user note.",
      history: "",
      authorType: "user",
      promptVersion: "protected-parent-user-v1"
    });
    database.upsertTopicRevision({
      id: initialParent.id,
      type: initialParent.type,
      title: initialParent.title,
      slug: initialParent.slug,
      markdown: initialParent.markdown,
      summary: initialParent.summary,
      currentState: initialParent.currentState,
      history: initialParent.history,
      authorType: "model",
      promptVersion: "protected-parent-index-v1"
    });
    database.setTopicUpdatePolicy(initialParent.id, "confirm");
    const timestamp = "2026-07-14T14:00:00.000Z";
    database.connection.transaction(() => {
      database.connection.prepare("UPDATE claims SET status = 'expired', valid_to = ? WHERE id = ?").run(timestamp, claim.id);
      database.connection.prepare(`
        INSERT INTO topic_projection_dirty(parent_topic_id, claim_id, first_seen_at, generation, repair_token)
        VALUES (?, ?, ?, 1, ?)
      `).run(initialParent.id, claim.id, timestamp, uuidv7());
    })();
    const rebuild = database.enqueueJob(
      "memory.rebuild",
      stableHash(`protected-zero-claim:${claim.id}:1`),
      { topicIds: [initialParent.id], reason: "test_zero_claim_safety", claimGenerations: [{ claimId: claim.id, generation: 1 }] },
      15
    );

    await processor.process(rebuild);

    expect(database.getTopic(initialParent.id)).not.toBeNull();
    expect(database.getTopicUpdatePolicy(initialParent.id)).toBe("confirm");
    expect(database.connection.prepare(`
      SELECT COUNT(*) AS count FROM topic_page_revisions WHERE topic_id = ? AND author_type = 'user'
    `).get(initialParent.id)).toEqual({ count: 1 });
    expect(database.connection.prepare(`
      SELECT COUNT(*) AS count FROM topic_section_shards shard
      JOIN topic_pages child ON child.id = shard.child_topic_id AND child.lifecycle_status = 'active'
      JOIN topic_page_revisions revision ON revision.topic_id = child.id AND revision.revision_number = child.active_revision
      JOIN page_section_sources source ON source.revision_id = revision.id AND source.claim_id = ?
      WHERE shard.parent_topic_id = ?
    `).get(claim.id, initialParent.id)).toEqual({ count: 0 });
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM topic_projection_dirty WHERE parent_topic_id = ?").get(initialParent.id)).toEqual({ count: 0 });
    expect(database.listPendingTopicShardProposals()).toEqual([]);
  });

  it("includes compiled parents in hard-deletion rebuilds and leaves no dangling links", async () => {
    const { database, processor } = await fixture();
    const turn = completedTurn(database, `Remember this erasable architecture record: ${"deletion-linked segment ".repeat(420)}`);
    await processor.process(compileJob(database, turn.runId, [turn.event.id, turn.assistant.id]));
    const before = database.listTopics(500);
    const parentIds = before.filter((page) => !page.tags.includes("auto-split")).map((page) => page.id);
    const childIds = before.filter((page) => page.tags.includes("auto-split")).map((page) => page.id);
    expect(childIds.length).toBeGreaterThan(0);

    const deletion = database.hardDeleteEvent(turn.event.id);
    expect(deletion.affectedTopicIds).toEqual(expect.arrayContaining(parentIds));
    const rebuild = database.enqueueJob("memory.rebuild", stableHash(`rebuild:${deletion.affectedTopicIds.sort().join(":")}`), { topicIds: deletion.affectedTopicIds, reason: "test_hard_deletion" });
    await processor.process(rebuild);

    for (const topicId of [...parentIds, ...childIds]) expect(database.getTopic(topicId)).toBeNull();
    expect(database.connection.prepare(`
      SELECT COUNT(*) AS count FROM page_links pl
      LEFT JOIN topic_pages source ON source.id = pl.source_topic_id
      LEFT JOIN topic_pages target ON target.id = pl.target_topic_id
      WHERE source.id IS NULL OR target.id IS NULL
    `).get()).toEqual({ count: 0 });
  });

  it("applies only deterministic lint repairs, records an audit, and reconciles projections", async () => {
    const { database, processor, config } = await fixture();
    const firstEvidence = database.appendEvent({ role: "user", content: "Exact page evidence one." });
    const secondEvidence = database.appendEvent({ role: "user", content: "Exact page evidence two." });
    const markdown = "# Exact duplicate\n\n## Summary\n\nSame bytes.";
    const first = database.upsertTopicRevision({ type: "concept", title: "Exact duplicate", slug: "exact-one", markdown, summary: "Same bytes.", currentState: "", history: "", sourceIds: [firstEvidence.id], authorType: "user", promptVersion: "test" });
    const second = database.upsertTopicRevision({ type: "concept", title: "Exact duplicate", slug: "exact-two", markdown, summary: "Same bytes.", currentState: "", history: "", sourceIds: [secondEvidence.id], authorType: "model", promptVersion: "test" });
    database.upsertClaim({ topicId: second.id, subject: "Exact", predicate: "value", value: "same", confidence: 1, status: "current", sourceRole: "user", sourceIds: [secondEvidence.id], validFrom: null, validTo: null, observedAt: "2026-01-01T00:00:00.000Z", freshnessExpiresAt: null });
    const archived = database.upsertTopicRevision({ type: "concept", title: "Archived", slug: "archived", markdown: "# Archived", summary: "", currentState: "", history: "", sourceIds: [], authorType: "model", promptVersion: "test" });
    database.connection.prepare("UPDATE topic_pages SET lifecycle_status = 'archived' WHERE id = ?").run(archived.id);
    const brokenLinkId = stableHash("broken-link");
    database.connection.prepare("INSERT INTO page_links(id, source_topic_id, target_topic_id, relation_type, evidence_json, created_at) VALUES (?, ?, ?, 'related', '[]', ?)").run(brokenLinkId, first.id, archived.id, new Date().toISOString());
    await mkdir(config.projectionsDir, { recursive: true });
    const firstProjection = join(config.projectionsDir, `${first.id}-${first.slug}.md`);
    const secondProjection = join(config.projectionsDir, `${second.id}-${second.slug}.md`);
    await writeFile(firstProjection, "stale canonical bytes");
    await writeFile(secondProjection, second.markdown);

    const job = database.enqueueJob("memory.lint", stableHash("lint:exact-repairs"), { manual: true });
    const result = await processor.process(job) as { repairs: Array<{ type: string }> };

    expect(result.repairs.map((repair) => repair.type)).toEqual(expect.arrayContaining(["broken_link_removed", "duplicate_page_consolidated"]));
    expect(database.connection.prepare("SELECT lifecycle_status FROM topic_pages WHERE id = ?").get(first.id)).toEqual({ lifecycle_status: "active" });
    expect(database.connection.prepare("SELECT lifecycle_status FROM topic_pages WHERE id = ?").get(second.id)).toEqual({ lifecycle_status: "archived" });
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM page_links WHERE id = ?").get(brokenLinkId)).toEqual({ count: 0 });
    expect(database.connection.prepare("SELECT COUNT(DISTINCT source_id) AS count FROM page_section_sources pss JOIN topic_page_revisions tpr ON tpr.id = pss.revision_id JOIN topic_pages tp ON tp.id = tpr.topic_id AND tp.active_revision = tpr.revision_number WHERE tp.id = ?").get(first.id)).toEqual({ count: 2 });
    expect(database.connection.prepare("SELECT COUNT(*) AS count FROM claims WHERE topic_id = ?").get(first.id)).toEqual({ count: 1 });
    expect(database.getSetting<Array<unknown>>("memory.lintRepairAudit", [])).toHaveLength(1);
    await expect(readFile(firstProjection, "utf8")).resolves.toBe(first.markdown);
    await expect(access(secondProjection)).rejects.toThrow();
    expect(database.listJobs(500).some((queued) => queued.type === "projection.sync"
      && Array.isArray(queued.payload.topicIds)
      && queued.payload.topicIds.includes(first.id)
      && queued.payload.topicIds.includes(second.id)
      && queued.maximumAttempts >= 8)).toBe(true);
  });
});
