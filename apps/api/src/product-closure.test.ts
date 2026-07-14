import { mkdtemp, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, stableHash, type AppConfig } from "@continuum/config";
import { uuidv7, type ContinuumDatabase } from "@continuum/database";
import type { TopicShardProposal } from "@continuum/contracts/api";
import { FileSystemContentAddressedStore } from "@continuum/ingestion";
import { buildApp } from "./app.js";
import { answerLinkedActiveTopicIds } from "./orchestrator.js";

type Fixture = Awaited<ReturnType<typeof buildApp>> & { root: string; config: AppConfig; database: ContinuumDatabase };
const fixtures: Fixture[] = [];

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "continuum-product-closure-"));
  const config = loadConfig({
    NODE_ENV: "test",
    CONTINUUM_DATA_DIR: root,
    CONTINUUM_MOCK_PROVIDER: "true",
    CONTINUUM_SESSION_TOKEN: "product-closure-test-token-0000000000000"
  });
  const built = await buildApp({ config });
  const value = { ...built, root, config, database: built.services.database };
  fixtures.push(value);
  return value;
}

function headers(value: Fixture, mutation = false) {
  return {
    authorization: `Bearer ${value.config.sessionToken}`,
    host: "127.0.0.1",
    ...(mutation ? { "x-continuum-request": "1" } : {})
  };
}

function normalizedShardProposalFixture(value: Fixture, marker: string): {
  parentId: string;
  baseTopicId: string;
  baseRevision: number;
  candidateRevisionId: string;
  existingClaimId: string;
  topiclessClaimId: string;
  proposal: TopicShardProposal;
} {
  const timestamp = "2026-07-14T10:00:00.000Z";
  const existingSource = value.database.appendEvent({ role: "user", content: `${marker} existing source` });
  const topiclessSource = value.database.appendEvent({ role: "user", content: `${marker} topicless source` });
  const parent = value.database.upsertTopicRevision({
    type: "project",
    title: `${marker} protected parent`,
    slug: `${marker}-protected-parent`,
    markdown: `# ${marker} protected parent`,
    summary: "Protected parent",
    currentState: "Open the linked parts.",
    history: "",
    authorType: "user",
    promptVersion: "user-edit-v1"
  });
  const existingClaim = value.database.upsertClaim({
    topicId: parent.id,
    subject: `${marker} existing`,
    predicate: "is",
    value: "active",
    confidence: 1,
    status: "current",
    sourceRole: "user",
    sourceIds: [existingSource.id],
    validFrom: null,
    validTo: null,
    observedAt: "2026-07-14T09:00:00.000Z",
    freshnessExpiresAt: null
  });
  const topiclessClaim = value.database.upsertClaim({
    topicId: null,
    subject: `${marker} proposed`,
    predicate: "is",
    value: "candidate-only",
    confidence: 1,
    status: "current",
    sourceRole: "user",
    sourceIds: [topiclessSource.id],
    validFrom: null,
    validTo: null,
    observedAt: "2026-07-14T09:30:00.000Z",
    freshnessExpiresAt: null
  });
  const overview = value.database.upsertTopicRevision({
    type: "project",
    title: `${marker} overview 1`,
    slug: `${parent.id}-overview-part-1`,
    markdown: `# ${marker} overview`,
    summary: "Overview",
    currentState: "Overview",
    history: "",
    authorType: "model",
    promptVersion: "topic-split-v2"
  });
  const baseMarkdown = `# ${marker} current\n\n- existing active`;
  const base = value.database.upsertTopicRevision({
    type: "project",
    title: `${marker} current state 1`,
    slug: `${parent.id}-current-state-part-1`,
    markdown: baseMarkdown,
    summary: "Existing",
    currentState: "- existing active",
    history: "",
    authorType: "model",
    promptVersion: "topic-split-v2"
  });
  const baseRevisionId = String((value.database.connection.prepare(`
    SELECT id FROM topic_page_revisions WHERE topic_id = ? AND revision_number = ?
  `).get(base.id, base.revision) as { id: string }).id);
  value.database.connection.prepare(`
    INSERT INTO page_section_sources(id, revision_id, section_key, start_offset, end_offset, claim_id, source_id)
    VALUES (?, ?, 'current_state', 0, ?, ?, ?)
  `).run(uuidv7(), baseRevisionId, baseMarkdown.length, existingClaim.id, existingSource.id);
  const existingKey = `2026-07-14T09:00:00.000Z\u0000${existingClaim.id}`;
  value.database.connection.prepare(`
    INSERT INTO topic_projection_state(parent_topic_id, layout_version, mode, updated_at)
    VALUES (?, 1, 'sharded', ?)
  `).run(parent.id, timestamp);
  value.database.connection.prepare(`
    INSERT INTO topic_section_shards(child_topic_id, parent_topic_id, section_key, ordinal, min_sort_key, max_sort_key)
    VALUES (?, ?, 'overview', 1, '', '')
  `).run(overview.id, parent.id);
  value.database.connection.prepare(`
    INSERT INTO topic_section_shards(child_topic_id, parent_topic_id, section_key, ordinal, min_sort_key, max_sort_key)
    VALUES (?, ?, 'current_state', 1, ?, ?)
  `).run(base.id, parent.id, existingKey, existingKey);
  const candidateRevisionId = uuidv7();
  const candidateRevision = base.revision + 1;
  const candidateMarkdown = `# ${marker} current\n\n- existing active\n- ${marker} candidate-only`;
  const generationInputsJson = JSON.stringify({
    activation: "proposal",
    parentTopicId: parent.id,
    section: "current_state",
    ordinal: 1,
    claimIds: [existingClaim.id, topiclessClaim.id].sort(),
    sourceIds: [existingSource.id, topiclessSource.id].sort()
  });
  value.database.connection.prepare(`
    INSERT INTO topic_page_revisions(
      id, topic_id, revision_number, markdown, summary, current_state, history,
      open_questions_json, generation_inputs_json, author_type, prompt_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, '', '[]', ?, 'model', 'topic-shard-proposal-v1', ?)
  `).run(candidateRevisionId, base.id, candidateRevision, candidateMarkdown, "Candidate", candidateMarkdown, generationInputsJson, timestamp);
  for (const [claimId, sourceId] of [[existingClaim.id, existingSource.id], [topiclessClaim.id, topiclessSource.id]]) {
    value.database.connection.prepare(`
      INSERT INTO page_section_sources(id, revision_id, section_key, start_offset, end_offset, claim_id, source_id)
      VALUES (?, ?, 'current_state', 0, ?, ?, ?)
    `).run(uuidv7(), candidateRevisionId, candidateMarkdown.length, claimId, sourceId);
  }
  value.database.connection.prepare("DELETE FROM topic_fts WHERE topic_id = ?").run(base.id);
  value.database.connection.prepare(`
    INSERT INTO topic_fts(topic_id, title, content)
    SELECT page.id, page.title, revision.markdown FROM topic_pages page
    JOIN topic_page_revisions revision ON revision.topic_id = page.id AND revision.revision_number = page.active_revision
    WHERE page.id = ?
  `).run(base.id);
  value.database.connection.prepare("DELETE FROM topic_revision_fts WHERE revision_id = ?").run(candidateRevisionId);
  const parentBase = value.database.getTopicShardParentBaseSnapshot(parent.id)!;
  const baseSnapshot = value.database.getTopicShardBaseSnapshot(base.id)!;
  const existingGuard = value.database.getTopicShardClaimGuardSnapshot(existingClaim.id)!;
  const topiclessGuard = value.database.getTopicShardClaimGuardSnapshot(topiclessClaim.id)!;
  const claimIds = [existingClaim.id, topiclessClaim.id].sort();
  const sourceIds = [existingSource.id, topiclessSource.id].sort();
  const proposalId = stableHash(`normalized-api-proposal:${marker}`);
  const proposal: TopicShardProposal = {
    schemaVersion: 2,
    id: proposalId,
    groupId: stableHash(`normalized-api-group:${marker}`),
    kind: "topic_shard_patch",
    topicId: parent.id,
    title: parent.title,
    parentBase,
    patches: [{
      section: "current_state",
      base: {
        topicId: baseSnapshot.topicId,
        revisionId: baseSnapshot.revisionId,
        revision: baseSnapshot.revision,
        ordinal: baseSnapshot.ordinal,
        minSortKey: baseSnapshot.minSortKey,
        maxSortKey: baseSnapshot.maxSortKey,
        fingerprint: baseSnapshot.fingerprint
      },
      routeGuards: [{
        claimId: topiclessClaim.id,
        sortKey: `2026-07-14T09:30:00.000Z\u0000${topiclessClaim.id}`,
        expectedBaseTopicId: base.id
      }],
      outputs: [{
        topicId: base.id,
        revisionId: candidateRevisionId,
        revision: candidateRevision,
        baseRevision: base.revision,
        title: base.title,
        slug: base.slug,
        ordinal: 1,
        minSortKey: existingKey,
        maxSortKey: `2026-07-14T09:30:00.000Z\u0000${topiclessClaim.id}`,
        claimIds,
        sourceIds,
        evidenceIds: [...claimIds, ...sourceIds].sort(),
        contentHash: value.database.getTopicShardRevisionContentHash(candidateRevisionId)!
      }]
    }],
    claimGuards: [
      {
        claimId: existingClaim.id,
        expectedTopicId: existingGuard.topicId,
        stateHash: existingGuard.stateHash,
        projectedTopicId: parent.id,
        assignToTopicId: null
      },
      {
        claimId: topiclessClaim.id,
        expectedTopicId: topiclessGuard.topicId,
        stateHash: topiclessGuard.stateHash,
        projectedTopicId: parent.id,
        assignToTopicId: parent.id
      }
    ].sort((left, right) => left.claimId.localeCompare(right.claimId)),
    claimIds: [topiclessClaim.id],
    sourceIds,
    requiresConfirmation: true,
    status: "pending",
    createdAt: timestamp
  };
  value.database.persistTopicShardProposal(proposal);
  return {
    parentId: parent.id,
    baseTopicId: base.id,
    baseRevision: base.revision,
    candidateRevisionId,
    existingClaimId: existingClaim.id,
    topiclessClaimId: topiclessClaim.id,
    proposal
  };
}

function disjointEvidenceProposal(value: Fixture, parentId: string, marker: string): TopicShardProposal {
  const timestamp = "2026-07-14T10:30:00.000Z";
  const source = value.database.appendEvent({ role: "user", content: `${marker} evidence source` });
  const claim = value.database.upsertClaim({
    topicId: parentId,
    subject: `${marker} evidence`,
    predicate: "supports",
    value: "an independent shard",
    confidence: 1,
    status: "current",
    sourceRole: "user",
    sourceIds: [source.id],
    validFrom: null,
    validTo: null,
    observedAt: "2026-07-14T08:00:00.000Z",
    freshnessExpiresAt: null
  });
  const baseMarkdown = `# ${marker} evidence\n\n- independent shard`;
  const base = value.database.upsertTopicRevision({
    type: "project",
    title: `${marker} evidence 1`,
    slug: `${parentId}-evidence-part-1`,
    markdown: baseMarkdown,
    summary: "Evidence",
    currentState: "",
    history: "",
    authorType: "model",
    promptVersion: "topic-split-v2"
  });
  const baseRevisionId = String((value.database.connection.prepare(`
    SELECT id FROM topic_page_revisions WHERE topic_id = ? AND revision_number = ?
  `).get(base.id, base.revision) as { id: string }).id);
  value.database.connection.prepare(`
    INSERT INTO page_section_sources(id, revision_id, section_key, start_offset, end_offset, claim_id, source_id)
    VALUES (?, ?, 'evidence', 0, ?, ?, ?)
  `).run(uuidv7(), baseRevisionId, baseMarkdown.length, claim.id, source.id);
  const sortKey = `2026-07-14T08:00:00.000Z\u0000${claim.id}`;
  value.database.connection.prepare(`
    INSERT INTO topic_section_shards(child_topic_id, parent_topic_id, section_key, ordinal, min_sort_key, max_sort_key)
    VALUES (?, ?, 'evidence', 1, ?, ?)
  `).run(base.id, parentId, sortKey, sortKey);
  const candidateRevisionId = uuidv7();
  const candidateMarkdown = `# ${marker} evidence\n\n- independent shard accepted`;
  const generationInputsJson = JSON.stringify({ activation: "proposal", parentTopicId: parentId, section: "evidence", ordinal: 1, claimIds: [claim.id], sourceIds: [source.id] });
  value.database.connection.prepare(`
    INSERT INTO topic_page_revisions(
      id, topic_id, revision_number, markdown, summary, current_state, history,
      open_questions_json, generation_inputs_json, author_type, prompt_version, created_at
    ) VALUES (?, ?, ?, ?, 'Evidence', '', '', '[]', ?, 'model', 'topic-shard-proposal-v1', ?)
  `).run(candidateRevisionId, base.id, base.revision + 1, candidateMarkdown, generationInputsJson, timestamp);
  value.database.connection.prepare(`
    INSERT INTO page_section_sources(id, revision_id, section_key, start_offset, end_offset, claim_id, source_id)
    VALUES (?, ?, 'evidence', 0, ?, ?, ?)
  `).run(uuidv7(), candidateRevisionId, candidateMarkdown.length, claim.id, source.id);
  value.database.connection.prepare("DELETE FROM topic_fts WHERE topic_id = ?").run(base.id);
  value.database.connection.prepare(`
    INSERT INTO topic_fts(topic_id, title, content)
    SELECT page.id, page.title, revision.markdown FROM topic_pages page
    JOIN topic_page_revisions revision ON revision.topic_id = page.id AND revision.revision_number = page.active_revision
    WHERE page.id = ?
  `).run(base.id);
  value.database.connection.prepare("DELETE FROM topic_revision_fts WHERE revision_id = ?").run(candidateRevisionId);
  const parentBase = value.database.getTopicShardParentBaseSnapshot(parentId)!;
  const baseSnapshot = value.database.getTopicShardBaseSnapshot(base.id)!;
  const guard = value.database.getTopicShardClaimGuardSnapshot(claim.id)!;
  const id = stableHash(`disjoint-evidence-proposal:${marker}`);
  const proposal: TopicShardProposal = {
    schemaVersion: 2,
    id,
    groupId: stableHash(`disjoint-evidence-group:${marker}`),
    kind: "topic_shard_patch",
    topicId: parentId,
    title: `${marker} evidence proposal`,
    parentBase,
    patches: [{
      section: "evidence",
      base: {
        topicId: baseSnapshot.topicId,
        revisionId: baseSnapshot.revisionId,
        revision: baseSnapshot.revision,
        ordinal: baseSnapshot.ordinal,
        minSortKey: baseSnapshot.minSortKey,
        maxSortKey: baseSnapshot.maxSortKey,
        fingerprint: baseSnapshot.fingerprint
      },
      routeGuards: [],
      outputs: [{
        topicId: base.id,
        revisionId: candidateRevisionId,
        revision: base.revision + 1,
        baseRevision: base.revision,
        title: base.title,
        slug: base.slug,
        ordinal: 1,
        minSortKey: sortKey,
        maxSortKey: sortKey,
        claimIds: [claim.id],
        sourceIds: [source.id],
        evidenceIds: [claim.id, source.id].sort(),
        contentHash: value.database.getTopicShardRevisionContentHash(candidateRevisionId)!
      }]
    }],
    claimGuards: [{
      claimId: claim.id,
      expectedTopicId: guard.topicId,
      stateHash: guard.stateHash,
      projectedTopicId: parentId,
      assignToTopicId: null
    }],
    claimIds: [],
    sourceIds: [source.id],
    requiresConfirmation: true,
    status: "pending",
    createdAt: timestamp
  };
  value.database.persistTopicShardProposal(proposal);
  return proposal;
}

afterEach(async () => {
  while (fixtures.length) {
    const value = fixtures.pop()!;
    await value.app.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

describe("product closure API", () => {
  it("exports a stable vault snapshot without cancelling response orchestration", async () => {
    const value = await fixture();
    const cancelAll = vi.spyOn(value.services.orchestrator, "cancelAll");
    try {
      const before = await value.app.inject({ method: "GET", url: "/api/v1/vault/snapshot-boundary", headers: headers(value) });
      expect(before.statusCode, before.body).toBe(200);
      const response = await value.app.inject({
        method: "POST",
        url: "/api/v1/export",
        headers: headers(value, true),
        payload: { includeAttachments: false, includeSensitiveToolOutput: false, idempotencyKey: "export-without-answer-cancellation" }
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(cancelAll).not.toHaveBeenCalled();
      const after = await value.app.inject({ method: "GET", url: "/api/v1/vault/snapshot-boundary", headers: headers(value) });
      expect(after.statusCode, after.body).toBe(200);
      expect(after.json()).toMatchObject({ maintenanceLocked: false, vaultId: expect.any(String) });
      expect(after.json().generation).toBeGreaterThan(before.json().generation);
    } finally {
      cancelAll.mockRestore();
    }
  });

  it("closes mutation admission before draining an older request for maintenance", async () => {
    const value = await fixture();
    let markSlowStarted!: () => void;
    let releaseSlow!: () => void;
    const slowStarted = new Promise<void>((resolve) => { markSlowStarted = resolve; });
    const slowRelease = new Promise<void>((resolve) => { releaseSlow = resolve; });
    value.app.post("/api/v1/test/slow-admitted-mutation", async () => {
      markSlowStarted();
      await slowRelease;
      return { complete: true };
    });

    const slow = value.app.inject({ method: "POST", url: "/api/v1/test/slow-admitted-mutation", headers: headers(value, true), payload: {} });
    await slowStarted;
    const maintenance = value.app.inject({
      method: "POST",
      url: "/api/v1/import/commit",
      headers: headers(value, true),
      payload: { verificationToken: uuidv7(), mode: "replace", idempotencyKey: "admission-maintenance-import" }
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The persistent lock is set only after the older request drains, so this
    // 423 specifically proves the process-local admission gate is already shut.
    expect(value.database.getSetting("maintenance.locked", false)).toBe(false);
    const late = await value.app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: headers(value, true),
      payload: { key: "theme", value: "dark", idempotencyKey: "late-mutation-during-drain" }
    });
    expect(late.statusCode, late.body).toBe(423);
    expect(late.json()).toMatchObject({ error: { code: "MAINTENANCE_LOCKED", retryable: true } });

    releaseSlow();
    expect((await slow).statusCode).toBe(200);
    const completedMaintenance = await maintenance;
    expect(completedMaintenance.statusCode, completedMaintenance.body).toBe(410);
    expect(value.database.getSetting("maintenance.locked", false)).toBe(false);
  });

  it("keeps every empty-vault section-11 read projection inside the shared response contracts", async () => {
    const value = await fixture();
    const urls = [
      "/api/v1/health",
      "/api/v1/runtime",
      "/api/v1/vault/snapshot-boundary",
      "/api/v1/settings",
      "/api/v1/providers",
      "/api/v1/budget",
      "/api/v1/events?limit=1",
      "/api/v1/runs?limit=1",
      "/api/v1/attachments?limit=1",
      "/api/v1/sources?limit=1",
      "/api/v1/workspaces?limit=1",
      "/api/v1/tools?limit=1",
      "/api/v1/search?q=empty&limit=1",
      "/api/v1/topics?limit=1",
      "/api/v1/claims?limit=1",
      "/api/v1/entities?limit=1",
      "/api/v1/entities/merge-candidates?limit=1",
      "/api/v1/graph?limit=10",
      "/api/v1/memories/pins?limit=1",
      "/api/v1/memories/lint?limit=1",
      "/api/v1/memory-jobs?limit=1",
      "/api/v1/retrieval-traces?limit=1",
      "/api/v1/retrieval-traces/latest",
      "/api/v1/context-packets?limit=1",
      "/api/v1/model-calls?limit=1",
      "/api/v1/backups?limit=1",
      "/api/v1/vault"
    ];
    for (const url of urls) {
      const response = await value.app.inject({ method: "GET", url, headers: headers(value) });
      expect(response.statusCode, `${url}: ${response.body}`).toBe(200);
    }
  });

  it("filters durable-memory jobs by the response run carried in their payload", async () => {
    const value = await fixture();
    const wantedRunId = uuidv7();
    const otherRunId = uuidv7();
    value.database.enqueueJob("memory.compile", stableHash(`job:${wantedRunId}`), { runId: wantedRunId, sourceEventIds: [] }, 10);
    value.database.enqueueJob("memory.compile", stableHash(`job:${otherRunId}`), { runId: otherRunId, sourceEventIds: [] }, 10);
    const response = await value.app.inject({ method: "GET", url: `/api/v1/memory-jobs?runId=${wantedRunId}&limit=20`, headers: headers(value) });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<{ jobs: Array<{ payload: { runId: string } }> }>().jobs.map((job) => job.payload.runId)).toEqual([wantedRunId]);
  });

  it("returns an explicit 404 for an unknown graph focus instead of substituting recent memory", async () => {
    const value = await fixture();
    const unknownId = uuidv7();
    const response = await value.app.inject({ method: "GET", url: `/api/v1/graph?focusId=${unknownId}&limit=50`, headers: headers(value) });
    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "GRAPH_FOCUS_NOT_FOUND", retryable: false } });
  });

  it("keeps required privacy onboarding independent from the provider-key lifecycle", async () => {
    const value = await fixture();
    let storedKey: string | null = null;
    const getKey = vi.spyOn(value.services.providers.keychain, "getOpenAiApiKey").mockImplementation(async () => storedKey);
    const setKey = vi.spyOn(value.services.providers.keychain, "setOpenAiApiKey").mockImplementation(async (key) => { storedKey = key; });
    const deleteKey = vi.spyOn(value.services.providers.keychain, "deleteOpenAiApiKey").mockImplementation(async () => { storedKey = null; });
    value.database.setSetting("onboarding.complete", false);
    try {
      const configured = await value.app.inject({
        method: "POST",
        url: "/api/v1/providers/openai-key",
        headers: headers(value, true),
        payload: { apiKey: "sk-test-onboarding-invariant-000000000000", idempotencyKey: "provider-key-onboarding-test" }
      });
      expect(configured.statusCode, configured.body).toBe(200);
      expect(value.database.getSetting("onboarding.complete", false)).toBe(false);

      value.database.setSetting("onboarding.complete", true);
      const removed = await value.app.inject({
        method: "DELETE",
        url: "/api/v1/providers/openai-key",
        headers: headers(value, true),
        payload: { idempotencyKey: "provider-key-removal-onboarding-test" }
      });
      expect(removed.statusCode, removed.body).toBe(200);
      expect(value.database.getSetting("onboarding.complete", false)).toBe(true);
    } finally {
      getKey.mockRestore();
      setKey.mockRestore();
      deleteKey.mockRestore();
    }
  });

  it("does not expose any operation that can renew the installation-lifetime budget", async () => {
    const value = await fixture();
    const active = value.database.reserveBudget(100, 0.25, "response");
    const impact = await value.app.inject({
      method: "POST",
      url: "/api/v1/budget/reset-impact",
      headers: headers(value, true)
    });
    const reset = await value.app.inject({
      method: "POST",
      url: "/api/v1/budget/reset",
      headers: headers(value, true),
      payload: { confirmation: "AUTHORIZE A NEW $100 API BUDGET", idempotencyKey: "budget-reset-attempt" }
    });
    expect(impact.statusCode).toBe(404);
    expect(reset.statusCode).toBe(404);
    const after = await value.app.inject({ method: "GET", url: "/api/v1/budget", headers: headers(value) });
    expect(after.json()).toMatchObject({ spentUsd: 0, reservedUsd: 0.25, allocatedUsd: 0.25, availableUsd: 99.75 });
    value.database.releaseBudgetReservation(active);
  });

  it("normalizes created and listed backups to the shared camel-case contract", async () => {
    const value = await fixture();
    const created = await value.app.inject({
      method: "POST",
      url: "/api/v1/backups",
      headers: headers(value, true),
      payload: { idempotencyKey: "contract-backup-create" }
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json()).toMatchObject({
      id: expect.any(String),
      filename: expect.stringMatching(/\.zip$/),
      kind: "manual",
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/)
    });

    const listed = await value.app.inject({ method: "GET", url: "/api/v1/backups?limit=1", headers: headers(value) });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toMatchObject({
      backups: [expect.objectContaining({ id: created.json().id, createdAt: created.json().createdAt })],
      items: [expect.objectContaining({ id: created.json().id })],
      nextCursor: null
    });
  });

  it("lists active runs with their resumable assistant identity in the camel-case contract", async () => {
    const value = await fixture();
    const user = value.database.appendEvent({ role: "user", content: "resume me" });
    const active = value.database.createRun(user.id, "balanced");
    const assistant = value.database.appendEvent({ role: "assistant", status: "streaming", content: "partial", parentEventId: user.id, runId: active.id });
    value.database.setRunStatus(active.id, "streaming", { assistantEventId: assistant.id });
    const finished = value.database.createRun(user.id, "fast");
    value.database.setRunStatus(finished.id, "complete");

    const response = await value.app.inject({ method: "GET", url: "/api/v1/runs?status=active&limit=10", headers: headers(value) });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      runs: [{ id: active.id, status: "streaming", userEventId: user.id, assistantEventId: assistant.id, cancellationRequested: false }],
      nextCursor: null
    });
    expect(response.body).not.toContain("assistant_event_id");
    expect(response.body).not.toContain(finished.id);
  });

  it("replays every stored SSE event after Last-Event-ID even when the backlog exceeds one database page", async () => {
    const value = await fixture();
    const user = value.database.appendEvent({ role: "user", content: "long stream" });
    const run = value.database.createRun(user.id, "balanced");
    const assistantId = uuidv7();
    const firstId = value.database.appendRunStreamEvent(run.id, { type: "run.started", runId: run.id });
    for (let index = 0; index < 1_001; index += 1) {
      value.database.appendRunStreamEvent(run.id, { type: "response.delta", runId: run.id, eventId: assistantId, delta: String(index % 10) });
    }
    value.database.setRunStatus(run.id, "cancelled");
    const terminalId = value.database.appendRunStreamEvent(run.id, { type: "run.cancelled", runId: run.id });

    const response = await value.app.inject({ method: "GET", url: `/api/v1/runs/${run.id}/stream`, headers: { ...headers(value), "last-event-id": String(firstId) } });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain(`id: ${firstId}\n`);
    expect(response.body).toContain(`id: ${terminalId}\n`);
    expect(response.body.match(/event: v1/g)).toHaveLength(1_002);
  });

  it("resolves topic reads by exact UUID or safe slug while keeping writes UUID-only", async () => {
    const value = await fixture();
    const topic = value.database.upsertTopicRevision({
      type: "project",
      title: "Slug-addressable project",
      slug: "slug-addressable-project",
      markdown: "# Slug-addressable project",
      summary: "Addressable beyond the first topic page.",
      currentState: "active",
      history: "",
      authorType: "model",
      promptVersion: "topic-page-v1"
    });

    for (const identity of [topic.id, topic.slug]) {
      const response = await value.app.inject({ method: "GET", url: `/api/v1/topics/${identity}`, headers: headers(value) });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ id: topic.id, slug: topic.slug });
    }

    const unsafeRead = await value.app.inject({ method: "GET", url: "/api/v1/topics/Not%20A%20Slug", headers: headers(value) });
    expect(unsafeRead.statusCode).toBe(400);
    const slugWrite = await value.app.inject({
      method: "PATCH",
      url: `/api/v1/topics/${topic.slug}`,
      headers: headers(value, true),
      payload: { expectedRevision: topic.revision, title: "Should not write", idempotencyKey: "slug-write-rejected" }
    });
    expect(slugWrite.statusCode).toBe(400);
    expect(value.database.getTopic(topic.id)?.title).toBe(topic.title);
  });

  it("serves only ready persisted images through the authenticated content-addressed store", async () => {
    const value = await fixture();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const store = new FileSystemContentAddressedStore(value.config.attachmentsDir);
    await store.initialize();
    const stored = await store.put(bytes);
    const sourceId = value.database.createSource({ type: "attachment", title: "preview.png", contentHash: stored.sha256 });
    const attachment = value.database.createAttachment({
      sourceId,
      filename: "preview.png",
      mediaType: "image/png",
      size: bytes.byteLength,
      storagePath: join(value.config.attachmentsDir, stored.storageKey),
      contentHash: stored.sha256,
      status: "ready"
    });
    const response = await value.app.inject({ method: "GET", url: `/api/v1/attachments/${attachment.id}/content`, headers: headers(value) });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["content-type"]).toContain("image/png");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.rawPayload).toEqual(bytes);

    value.database.updateAttachmentStatus(attachment.id, "failed");
    const unavailable = await value.app.inject({ method: "GET", url: `/api/v1/attachments/${attachment.id}/content`, headers: headers(value) });
    expect(unavailable.statusCode).toBe(404);
  });

  it("removes a canonical blob orphaned by a crash before attachment metadata commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "continuum-product-closure-"));
    const config = loadConfig({
      NODE_ENV: "test",
      CONTINUUM_DATA_DIR: root,
      CONTINUUM_MOCK_PROVIDER: "true",
      CONTINUUM_SESSION_TOKEN: "product-closure-test-token-0000000000000"
    });
    const store = new FileSystemContentAddressedStore(config.attachmentsDir);
    const orphan = await store.put(Buffer.from("canonical bytes without a committed attachment row"));
    const built = await buildApp({ config });
    const value = { ...built, root, config, database: built.services.database };
    fixtures.push(value);
    await expect(store.has(orphan.sha256)).resolves.toBe(false);
    expect(value.database.connection.prepare("SELECT COUNT(*) AS count FROM attachments").get()).toMatchObject({ count: 0 });
  });

  it("creates exact one-use secret grants and wires prompt tracing to the local logger", async () => {
    const value = await fixture();
    const workspace = join(value.root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "secrets.txt"), "private", { mode: 0o600 });
    const rootId = value.database.authorizeWorkspace(await realpath(workspace), "Fixture");
    const approval = await value.app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${rootId}/secret-approvals`,
      headers: headers(value, true),
      payload: { relativePath: "secrets.txt", acknowledgement: true, idempotencyKey: "secret-grant-1" }
    });
    expect(approval.statusCode).toBe(200);
    expect(approval.json()).toMatchObject({ rootId, relativePath: "secrets.txt", oneUse: true, expiresAt: expect.any(String) });
    expect(await value.services.secretGrants.approve({ rootId, relativePath: "secrets.txt" })).toBe(true);
    expect(await value.services.secretGrants.approve({ rootId, relativePath: "secrets.txt" })).toBe(false);

    const invalid = await value.app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${rootId}/secret-approvals`,
      headers: headers(value, true),
      payload: { relativePath: "notes.txt", acknowledgement: true, idempotencyKey: "secret-grant-2" }
    });
    expect(invalid.statusCode).toBe(400);

    const tracing = await value.app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: headers(value, true),
      payload: { key: "promptTracing.enabled", value: true, idempotencyKey: "prompt-trace-enable" }
    });
    expect(tracing.statusCode).toBe(200);
    expect(value.services.logger.promptTracingEnabled).toBe(true);
    expect(tracing.json().settings.promptTracingEnabled).toBe(true);
  });

  it("fails closed when an embedding-model change would mix an existing vector corpus", async () => {
    const value = await fixture();
    const changed = await value.app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: headers(value, true),
      payload: { key: "models.embedding", value: "text-embedding-3-large", idempotencyKey: "embedding-model-before-corpus" }
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const event = value.database.appendEvent({ role: "user", content: "vector model guard" });
    value.database.connection.prepare(`
      INSERT INTO vectors(id, source_id, source_type, model_id, dimensions, content_hash, embedding_version, embedding_json, created_at)
      VALUES (?, ?, 'event', 'text-embedding-3-large', 2, ?, 'embedding-v1', '[1,0]', ?)
    `).run(uuidv7(), event.id, stableHash(event.content), new Date().toISOString());

    const rejected = await value.app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: headers(value, true),
      payload: { key: "models.embedding", value: "text-embedding-3-small", idempotencyKey: "embedding-model-after-corpus" }
    });
    expect(rejected.statusCode, rejected.body).toBe(409);
    expect(rejected.json()).toMatchObject({ error: { code: "EMBEDDING_MODEL_REINDEX_REQUIRED", retryable: false } });
    expect(value.database.getSetting("models.embedding", "missing")).toBe("text-embedding-3-large");
  });

  it("applies settings batches atomically, rejects canonical alias collisions, and replays idempotently", async () => {
    const value = await fixture();
    value.database.appendEvent({ role: "user", content: "the existing corpus makes an embedding-model swap unsafe" });
    const settingsBefore = value.database.listSettings();
    const presetsBefore = value.database.connection.prepare(`
      SELECT name, model_id AS modelId, updated_at AS updatedAt FROM provider_presets ORDER BY name
    `).all();

    const rejected = await value.app.inject({
      method: "PUT",
      url: "/api/v1/settings/batch",
      headers: headers(value, true),
      payload: {
        mutations: [
          { key: "theme", value: "dark" },
          { key: "promptTracing.enabled", value: true },
          { key: "models.response", value: { fast: "gpt-5.4-nano", balanced: "gpt-5.4-mini", deep: "gpt-5.4" } },
          { key: "models.embedding", value: "text-embedding-3-large" }
        ],
        idempotencyKey: "atomic-settings-batch-rejected"
      }
    });
    expect(rejected.statusCode, rejected.body).toBe(409);
    expect(rejected.json()).toMatchObject({ error: { code: "EMBEDDING_MODEL_REINDEX_REQUIRED", retryable: false } });
    expect(value.database.listSettings()).toEqual(settingsBefore);
    expect(value.database.connection.prepare(`
      SELECT name, model_id AS modelId, updated_at AS updatedAt FROM provider_presets ORDER BY name
    `).all()).toEqual(presetsBefore);
    expect(value.services.logger.promptTracingEnabled).toBe(false);
    expect(value.database.connection.prepare(`
      SELECT 1 FROM idempotency_keys WHERE key = ? AND operation = 'settings.batch.put'
    `).get("atomic-settings-batch-rejected")).toBeUndefined();

    const duplicateCanonical = await value.app.inject({
      method: "PUT",
      url: "/api/v1/settings/batch",
      headers: headers(value, true),
      payload: {
        mutations: [{ key: "quality", value: "fast" }, { key: "quality.default", value: "deep" }],
        idempotencyKey: "canonical-duplicate-settings-batch"
      }
    });
    expect(duplicateCanonical.statusCode, duplicateCanonical.body).toBe(400);
    expect(duplicateCanonical.json()).toMatchObject({ error: { code: "DUPLICATE_SETTING_MUTATION", retryable: false } });
    expect(value.database.listSettings()).toEqual(settingsBefore);

    const tracingSpy = vi.spyOn(value.services.logger, "setPromptTracing");
    const responseModels = { fast: "gpt-5.4-nano", balanced: "gpt-5.4-mini", deep: "gpt-5.4" };
    const payload = {
      mutations: [
        { key: "theme", value: "dark" },
        { key: "promptTracingEnabled", value: true },
        { key: "responseModelIds", value: responseModels }
      ],
      idempotencyKey: "successful-settings-batch"
    };
    const first = await value.app.inject({ method: "PUT", url: "/api/v1/settings/batch", headers: headers(value, true), payload });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      mutations: [
        { key: "theme", value: "dark" },
        { key: "promptTracing.enabled", value: true },
        { key: "models.response", value: responseModels }
      ],
      settings: { theme: "dark", promptTracingEnabled: true, responseModelIds: responseModels }
    });
    expect(value.database.connection.prepare(`
      SELECT name, model_id AS modelId FROM provider_presets ORDER BY name
    `).all()).toEqual([
      { name: "balanced", modelId: responseModels.balanced },
      { name: "deep", modelId: responseModels.deep },
      { name: "fast", modelId: responseModels.fast }
    ]);
    const replay = await value.app.inject({ method: "PUT", url: "/api/v1/settings/batch", headers: headers(value, true), payload });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(value.database.getSetting("theme", "missing")).toBe("dark");
    expect(value.database.getSetting("promptTracing.enabled", false)).toBe(true);
    expect(value.services.logger.promptTracingEnabled).toBe(true);
    expect(tracingSpy).toHaveBeenCalledTimes(1);

    await value.app.close();
    const reopened = await buildApp({ config: value.config });
    value.app = reopened.app;
    value.services = reopened.services;
    value.database = reopened.services.database;
    expect(value.database.getSetting("models.response", null)).toEqual(responseModels);
    expect(value.database.connection.prepare(`
      SELECT name, model_id AS modelId FROM provider_presets ORDER BY name
    `).all()).toEqual([
      { name: "balanced", modelId: responseModels.balanced },
      { name: "deep", modelId: responseModels.deep },
      { name: "fast", modelId: responseModels.fast }
    ]);
  });

  it("returns answer-specific packet, tool, cache, and version diagnostics", async () => {
    const value = await fixture();
    const user = value.database.appendEvent({ role: "user", content: "debug this answer" });
    const run = value.database.createRun(user.id, "balanced");
    const exactPacket = JSON.stringify({
      evidenceLabel: "M1",
      evidenceType: "event",
      status: "current",
      confidence: 1,
      title: "Debug source",
      sourceIds: [user.id],
      untrustedEvidence: user.content
    });
    value.database.saveContextPacket({
      runId: run.id,
      budget: { usedTokens: 42 },
      sourceIds: [user.id],
      promptVersion: "response-v1",
      renderedContent: exactPacket,
      composition: {
        version: 1,
        notices: [],
        evidence: [{
          id: user.id,
          type: "event",
          bodyRefId: user.id,
          title: "Debug source",
          status: "current",
          confidence: 1,
          sourceIds: [user.id],
          tokenCount: 4,
          contentHash: stableHash(user.content)
        }],
        recentTurns: [{ id: user.id, role: "user", turnIndex: 1, tokenCount: 4, contentHash: stableHash(user.content) }]
      }
    });
    value.database.saveRetrievalTrace({
      runId: run.id,
      query: "debug",
      classifications: ["exact_lookup"],
      candidates: [],
      selectedIds: [],
      tokenBudget: { modelContext: 64_000, reservedOutput: 4_000, instructions: 1_000, recentTurns: 20, evidence: 10 },
      latencyMs: 4
    });
    value.database.recordModelCall({
      runId: run.id,
      provider: "mock",
      model: "fixture-model",
      purpose: "response",
      promptVersion: "response-v1",
      inputTokens: 100,
      outputTokens: 20,
      latencyMs: 12,
      status: "complete",
      estimatedCostUsd: 0,
      traceMetadata: { cachedInputTokens: 60 }
    });
    value.database.connection.prepare(`
      INSERT INTO tool_executions(id, run_id, tool_name, arguments_json, output_text, citations_json, status, sandbox_json, started_at, completed_at)
      VALUES (?, ?, 'execute_code', '{"language":"javascript"}', '42', '[]', 'complete', '{"backend":"macos-sandbox-exec"}', ?, ?)
    `).run(crypto.randomUUID(), run.id, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:01.000Z");

    const response = await value.app.inject({ method: "GET", url: `/api/v1/runs/${run.id}/debug`, headers: headers(value) });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      runId: run.id,
      contextPacket: {
        sourceIds: [user.id],
        renderedContent: exactPacket,
        reconstructionIntegrity: "verified",
        contentHash: expect.any(String),
        budget: { usedTokens: 42 }
      },
      modelCalls: [{ model: "fixture-model", cachedInputTokens: 60, traceMetadata: { cachedInputTokens: 60 } }],
      toolCalls: [{ toolName: "execute_code", arguments: { language: "javascript" }, sandbox: { backend: "macos-sandbox-exec" } }],
      versions: { schemaVersion: "18", retrievalVersion: "retrieval-v1", promptVersions: expect.arrayContaining([expect.objectContaining({ semanticVersion: "response-v1" })]) }
    });
  });

  it("uses prior answer-linked topics instead of globally newest unrelated pages", async () => {
    const value = await fixture();
    const linked = value.database.upsertTopicRevision({
      type: "project", title: "Linked project", slug: "linked-project", markdown: "# Linked", summary: "linked",
      currentState: "active", history: "", authorType: "model", promptVersion: "topic-page-v1"
    });
    value.database.upsertTopicRevision({
      type: "project", title: "New but unrelated", slug: "new-unrelated", markdown: "# Unrelated", summary: "unrelated",
      currentState: "active", history: "", authorType: "model", promptVersion: "topic-page-v1"
    });
    const priorUser = value.database.appendEvent({ role: "user", content: "prior question" });
    const priorRun = value.database.createRun(priorUser.id, "balanced");
    value.database.saveRetrievalTrace({
      runId: priorRun.id,
      query: "prior",
      classifications: ["factual_recall"],
      candidates: [{ id: linked.id, type: "topic", selected: true }],
      selectedIds: [linked.id],
      tokenBudget: {},
      latencyMs: 1
    });
    const currentUser = value.database.appendEvent({ role: "user", content: "follow up on that" });
    const currentRun = value.database.createRun(currentUser.id, "balanced");
    expect(answerLinkedActiveTopicIds(value.database, currentRun.id, [priorUser.id, currentUser.id])).toEqual([linked.id]);
  });

  it("accepts normalized shard proposals atomically and queues durable projection and embedding repair", async () => {
    const value = await fixture();
    const prepared = normalizedShardProposalFixture(value, "acceptv2");
    const related = value.database.upsertTopicRevision({
      type: "concept", title: "Unrelated preserved link", slug: "unrelated-preserved-link",
      markdown: "# Related", summary: "Related", currentState: "", history: "",
      authorType: "model", promptVersion: "test-v1"
    });
    value.database.connection.prepare(`
      INSERT INTO page_links(id, source_topic_id, target_topic_id, relation_type, evidence_json, created_at)
      VALUES (?, ?, ?, 'related', '[]', ?)
    `).run(uuidv7(), prepared.baseTopicId, related.id, new Date().toISOString());

    const listed = await value.app.inject({ method: "GET", url: "/api/v1/memory-proposals", headers: headers(value) });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().proposals).toEqual(expect.arrayContaining([expect.objectContaining({
      id: prepared.proposal.id,
      kind: "topic_shard_patch",
      schemaVersion: 2
    })]));
    expect(value.database.getClaim(prepared.topiclessClaimId, true)?.topicId).toBeNull();

    const accepted = await value.app.inject({
      method: "POST",
      url: `/api/v1/memory-proposals/${prepared.proposal.id}/resolve`,
      headers: headers(value, true),
      payload: { action: "accept", idempotencyKey: "accept-normalized-shard-proposal" }
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(value.database.getClaim(prepared.topiclessClaimId, true)?.topicId).toBe(prepared.parentId);
    expect(value.database.getTopic(prepared.baseTopicId)).toMatchObject({
      revision: prepared.baseRevision + 1,
      markdown: expect.stringContaining("candidate-only")
    });
    expect(value.database.getTopicUpdatePolicy(prepared.parentId)).toBe("confirm");
    expect(value.database.connection.prepare("SELECT status FROM topic_shard_proposals WHERE id = ?").get(prepared.proposal.id)).toEqual({ status: "accepted" });
    expect(value.database.connection.prepare("SELECT COUNT(*) AS count FROM topic_revision_fts WHERE revision_id = ?").get(prepared.candidateRevisionId)).toEqual({ count: 1 });
    expect(value.database.connection.prepare(`
      SELECT COUNT(*) AS count FROM page_links WHERE source_topic_id = ? AND target_topic_id = ? AND relation_type = 'related'
    `).get(prepared.baseTopicId, related.id)).toEqual({ count: 1 });
    expect(value.database.connection.prepare(`
      SELECT COUNT(*) AS count FROM page_links
      WHERE source_topic_id = ? AND target_topic_id = ? AND relation_type = 'contains'
    `).get(prepared.parentId, prepared.baseTopicId)).toEqual({ count: 1 });
    expect(Number((value.database.connection.prepare(`
      SELECT COUNT(*) AS count FROM jobs WHERE type = 'projection.sync' AND status = 'queued'
    `).get() as { count: number }).count)).toBeGreaterThan(0);
    expect(Number((value.database.connection.prepare(`
      SELECT COUNT(*) AS count FROM jobs WHERE type = 'embedding.index' AND status = 'queued'
    `).get() as { count: number }).count)).toBeGreaterThan(0);

    const replay = await value.app.inject({
      method: "POST",
      url: `/api/v1/memory-proposals/${prepared.proposal.id}/resolve`,
      headers: headers(value, true),
      payload: { action: "accept", idempotencyKey: "accept-normalized-shard-proposal" }
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(accepted.json());
  });

  it("paginates beyond five hundred normalized proposals without truncating the merge", async () => {
    const value = await fixture();
    const prepared = normalizedShardProposalFixture(value, "pagev2");
    for (let index = 0; index < 501; index += 1) {
      value.database.persistTopicShardProposal({
        ...prepared.proposal,
        id: stableHash(`pagev2-proposal-${index}`),
        groupId: stableHash(`pagev2-group-${index}`),
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
      });
    }
    expect(value.database.connection.prepare("SELECT COUNT(*) AS count FROM topic_shard_proposals WHERE status = 'pending'").get()).toEqual({ count: 502 });
    const response = await value.app.inject({
      method: "GET",
      url: "/api/v1/memory-proposals?limit=10&cursor=500",
      headers: headers(value)
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().proposals).toHaveLength(2);
    expect(response.json().nextCursor).toBeNull();
  });

  it("merges legacy and normalized proposal pages in global order with normalized ID precedence", async () => {
    const value = await fixture();
    const prepared = normalizedShardProposalFixture(value, "merged-page-v2");
    const legacy = (id: string, createdAt: string) => ({
      id,
      groupId: id,
      kind: "topic_update" as const,
      topicId: prepared.parentId,
      title: `Legacy ${id.slice(0, 6)}`,
      claimIds: [],
      sourceIds: prepared.proposal.sourceIds,
      parentRevisionId: prepared.proposal.parentBase.revisionId,
      parentRevision: prepared.proposal.parentBase.revision,
      baseRevision: prepared.proposal.parentBase.revision,
      children: [],
      links: [],
      requiresConfirmation: true as const,
      status: "pending" as const,
      createdAt
    });
    const newerId = "1".repeat(64);
    const olderId = "2".repeat(64);
    value.database.setSetting("memory.pendingTopicProposals", [
      legacy(olderId, "2026-07-14T09:00:00.000Z"),
      legacy(prepared.proposal.id, "2026-07-14T12:00:00.000Z"),
      legacy(newerId, "2026-07-14T11:00:00.000Z")
    ]);

    const response = await value.app.inject({
      method: "GET",
      url: "/api/v1/memory-proposals?limit=10",
      headers: headers(value)
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().proposals.map((proposal: { id: string }) => proposal.id)).toEqual([
      newerId,
      prepared.proposal.id,
      olderId
    ]);
    expect(response.json().proposals.filter((proposal: { id: string }) => proposal.id === prepared.proposal.id)).toHaveLength(1);
  });

  it("rejects normalized candidates without changing active projection state or leaking candidate search rows", async () => {
    const value = await fixture();
    const prepared = normalizedShardProposalFixture(value, "rejectv2");
    const activeBefore = value.database.getTopic(prepared.baseTopicId)!;
    const shardsBefore = value.database.connection.prepare(`
      SELECT * FROM topic_section_shards WHERE parent_topic_id = ? ORDER BY section_key, ordinal
    `).all(prepared.parentId);
    const linksBefore = value.database.connection.prepare("SELECT * FROM page_links ORDER BY id").all();
    const rejected = await value.app.inject({
      method: "POST",
      url: `/api/v1/memory-proposals/${prepared.proposal.id}/resolve`,
      headers: headers(value, true),
      payload: { action: "reject", idempotencyKey: "reject-normalized-shard-proposal" }
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(value.database.getTopic(prepared.baseTopicId)).toMatchObject({
      revision: activeBefore.revision,
      markdown: activeBefore.markdown
    });
    expect(value.database.getClaim(prepared.topiclessClaimId, true)?.topicId).toBeNull();
    expect(value.database.connection.prepare("SELECT 1 FROM topic_page_revisions WHERE id = ?").get(prepared.candidateRevisionId)).toBeUndefined();
    expect(value.database.connection.prepare("SELECT COUNT(*) AS count FROM topic_revision_fts WHERE revision_id = ?").get(prepared.candidateRevisionId)).toEqual({ count: 0 });
    expect(value.database.connection.prepare(`
      SELECT * FROM topic_section_shards WHERE parent_topic_id = ? ORDER BY section_key, ordinal
    `).all(prepared.parentId)).toEqual(shardsBefore);
    expect(value.database.connection.prepare("SELECT * FROM page_links ORDER BY id").all()).toEqual(linksBefore);
    expect(value.database.connection.prepare("SELECT status FROM topic_shard_proposals WHERE id = ?").get(prepared.proposal.id)).toEqual({ status: "rejected" });
  });

  it("returns 409 without activating stale content and terminalizes its dead candidate", async () => {
    const value = await fixture();
    const prepared = normalizedShardProposalFixture(value, "stalev2");
    const activeBefore = value.database.getTopic(prepared.baseTopicId)!;
    const linksBefore = value.database.connection.prepare("SELECT * FROM page_links ORDER BY id").all();
    value.database.connection.prepare("UPDATE topic_page_revisions SET markdown = markdown || ' tampered' WHERE id = ?")
      .run(prepared.candidateRevisionId);
    const stale = await value.app.inject({
      method: "POST",
      url: `/api/v1/memory-proposals/${prepared.proposal.id}/resolve`,
      headers: headers(value, true),
      payload: { action: "accept", idempotencyKey: "stale-normalized-shard-proposal" }
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(value.database.getTopic(prepared.baseTopicId)).toMatchObject({
      revision: activeBefore.revision,
      markdown: activeBefore.markdown
    });
    expect(value.database.getClaim(prepared.topiclessClaimId, true)?.topicId).toBeNull();
    expect(value.database.connection.prepare("SELECT status FROM topic_shard_proposals WHERE id = ?").get(prepared.proposal.id)).toEqual({ status: "stale" });
    expect(value.database.connection.prepare("SELECT 1 FROM topic_page_revisions WHERE id = ?").get(prepared.candidateRevisionId)).toBeUndefined();
    expect(value.database.connection.prepare("SELECT * FROM page_links ORDER BY id").all()).toEqual(linksBefore);
    expect(value.database.connection.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type IN ('projection.sync','embedding.index')").get()).toEqual({ count: 0 });
  });

  it("returns 409 and garbage-collects a candidate whose evidence was deactivated", async () => {
    const value = await fixture();
    const prepared = normalizedShardProposalFixture(value, "inactive-evidence-v2");
    const source = value.database.connection.prepare(`
      SELECT source_id FROM claim_sources WHERE claim_id = ? ORDER BY source_id LIMIT 1
    `).get(prepared.topiclessClaimId) as { source_id: string };
    const activeBefore = value.database.getTopic(prepared.baseTopicId)!;
    value.database.connection.prepare("UPDATE events SET active = 0 WHERE id = ?").run(source.source_id);

    const stale = await value.app.inject({
      method: "POST",
      url: `/api/v1/memory-proposals/${prepared.proposal.id}/resolve`,
      headers: headers(value, true),
      payload: { action: "accept", idempotencyKey: "inactive-evidence-normalized-shard" }
    });

    expect(stale.statusCode, stale.body).toBe(409);
    expect(value.database.getTopic(prepared.baseTopicId)).toMatchObject({ revision: activeBefore.revision, markdown: activeBefore.markdown });
    expect(value.database.getClaim(prepared.topiclessClaimId, true)?.topicId).toBeNull();
    expect(value.database.connection.prepare("SELECT status FROM topic_shard_proposals WHERE id = ?").get(prepared.proposal.id)).toEqual({ status: "stale" });
    expect(value.database.connection.prepare("SELECT 1 FROM topic_page_revisions WHERE id = ?").get(prepared.candidateRevisionId)).toBeUndefined();
    expect(value.database.connection.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type IN ('projection.sync','embedding.index')").get()).toEqual({ count: 0 });
  });

  it("returns 409 and garbage-collects a candidate whose guarded evidence bytes changed", async () => {
    const value = await fixture();
    const prepared = normalizedShardProposalFixture(value, "changed-evidence-v2");
    const source = value.database.connection.prepare(`
      SELECT source_id FROM claim_sources WHERE claim_id = ? ORDER BY source_id LIMIT 1
    `).get(prepared.topiclessClaimId) as { source_id: string };
    const activeBefore = value.database.getTopic(prepared.baseTopicId)!;
    value.database.connection.prepare(`
      UPDATE event_content SET text_content = text_content || ' changed after proposal planning'
      WHERE event_id = ? AND ordinal = 0
    `).run(source.source_id);

    const stale = await value.app.inject({
      method: "POST",
      url: `/api/v1/memory-proposals/${prepared.proposal.id}/resolve`,
      headers: headers(value, true),
      payload: { action: "accept", idempotencyKey: "changed-evidence-normalized-shard" }
    });

    expect(stale.statusCode, stale.body).toBe(409);
    expect(value.database.getTopic(prepared.baseTopicId)).toMatchObject({ revision: activeBefore.revision, markdown: activeBefore.markdown });
    expect(value.database.getClaim(prepared.topiclessClaimId, true)?.topicId).toBeNull();
    expect(value.database.connection.prepare("SELECT status FROM topic_shard_proposals WHERE id = ?").get(prepared.proposal.id)).toEqual({ status: "stale" });
    expect(value.database.connection.prepare("SELECT 1 FROM topic_page_revisions WHERE id = ?").get(prepared.candidateRevisionId)).toBeUndefined();
    expect(value.database.connection.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type IN ('projection.sync','embedding.index')").get()).toEqual({ count: 0 });
  });

  it("archives an emptied protected base while retaining the parent confirmation policy", async () => {
    const value = await fixture();
    const prepared = normalizedShardProposalFixture(value, "archivev2");
    value.database.connection.transaction(() => {
      value.database.connection.prepare("DELETE FROM topic_shard_proposal_outputs WHERE proposal_id = ?").run(prepared.proposal.id);
      value.database.connection.prepare("DELETE FROM topic_shard_proposal_routes WHERE proposal_id = ?").run(prepared.proposal.id);
      value.database.connection.prepare("DELETE FROM topic_page_revisions WHERE id = ?").run(prepared.candidateRevisionId);
      value.database.connection.prepare("UPDATE claims SET status = 'expired', valid_to = ? WHERE id = ?")
        .run("2026-07-14T09:45:00.000Z", prepared.existingClaimId);
      const guard = value.database.getTopicShardClaimGuardSnapshot(prepared.existingClaimId)!;
      value.database.connection.prepare("DELETE FROM topic_shard_proposal_claim_guards WHERE proposal_id = ?").run(prepared.proposal.id);
      value.database.connection.prepare(`
        INSERT INTO topic_shard_proposal_claim_guards(
          proposal_id, guard_index, claim_id, expected_topic_id, state_hash, projected_topic_id, assign_to_topic_id
        ) VALUES (?, 0, ?, ?, ?, NULL, NULL)
      `).run(prepared.proposal.id, prepared.existingClaimId, guard.topicId, guard.stateHash);
      value.database.connection.prepare("UPDATE topic_shard_proposals SET claim_ids_json = ? WHERE id = ?")
        .run(JSON.stringify([prepared.existingClaimId]), prepared.proposal.id);
    })();
    const accepted = await value.app.inject({
      method: "POST",
      url: `/api/v1/memory-proposals/${prepared.proposal.id}/resolve`,
      headers: headers(value, true),
      payload: { action: "accept", idempotencyKey: "archive-empty-normalized-shard" }
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(value.database.connection.prepare("SELECT lifecycle_status FROM topic_pages WHERE id = ?").get(prepared.baseTopicId)).toEqual({ lifecycle_status: "archived" });
    expect(value.database.connection.prepare("SELECT COUNT(*) AS count FROM topic_section_shards WHERE child_topic_id = ?").get(prepared.baseTopicId)).toEqual({ count: 0 });
    expect(value.database.connection.prepare("SELECT COUNT(*) AS count FROM topic_fts WHERE topic_id = ?").get(prepared.baseTopicId)).toEqual({ count: 0 });
    expect(value.database.getTopicUpdatePolicy(prepared.parentId)).toBe("confirm");
  });

  it("rebases a disjoint pending shard proposal so both independent accepts can succeed", async () => {
    const value = await fixture();
    const currentState = normalizedShardProposalFixture(value, "rebase-current-v2");
    const evidence = disjointEvidenceProposal(value, currentState.parentId, "rebase-evidence-v2");
    const evidenceBefore = value.database.getTopicShardProposal(evidence.id)!;

    const first = await value.app.inject({
      method: "POST",
      url: `/api/v1/memory-proposals/${currentState.proposal.id}/resolve`,
      headers: headers(value, true),
      payload: { action: "accept", idempotencyKey: "accept-current-before-evidence" }
    });
    expect(first.statusCode, first.body).toBe(200);

    const rebased = value.database.getTopicShardProposal(evidence.id)!;
    expect(rebased.status).toBe("pending");
    expect(rebased.parentBase.revision).toBeGreaterThan(evidenceBefore.parentBase.revision);
    expect(rebased.parentBase.revisionId).not.toBe(evidenceBefore.parentBase.revisionId);
    expect(rebased.parentBase.fingerprint).not.toBe(evidenceBefore.parentBase.fingerprint);

    const second = await value.app.inject({
      method: "POST",
      url: `/api/v1/memory-proposals/${evidence.id}/resolve`,
      headers: headers(value, true),
      payload: { action: "accept", idempotencyKey: "accept-evidence-after-rebase" }
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(value.database.connection.prepare("SELECT status FROM topic_shard_proposals WHERE id = ?").get(evidence.id)).toEqual({ status: "accepted" });
    expect(value.database.getTopicUpdatePolicy(currentState.parentId)).toBe("confirm");
  });

  it("marks overlapping pending shard proposals stale after one candidate is accepted", async () => {
    const value = await fixture();
    const prepared = normalizedShardProposalFixture(value, "overlap-v2");
    const overlappingId = stableHash("overlap-v2-second-proposal");
    value.database.persistTopicShardProposal({
      ...prepared.proposal,
      id: overlappingId,
      groupId: stableHash("overlap-v2-second-group"),
      createdAt: "2026-07-14T10:01:00.000Z"
    });

    const accepted = await value.app.inject({
      method: "POST",
      url: `/api/v1/memory-proposals/${prepared.proposal.id}/resolve`,
      headers: headers(value, true),
      payload: { action: "accept", idempotencyKey: "accept-first-overlapping-v2" }
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(value.database.connection.prepare("SELECT status FROM topic_shard_proposals WHERE id = ?").get(overlappingId)).toEqual({ status: "stale" });

    const stale = await value.app.inject({
      method: "POST",
      url: `/api/v1/memory-proposals/${overlappingId}/resolve`,
      headers: headers(value, true),
      payload: { action: "accept", idempotencyKey: "attempt-stale-overlapping-v2" }
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(value.database.connection.prepare("SELECT status FROM topic_shard_proposals WHERE id = ?").get(overlappingId)).toEqual({ status: "stale" });
  });

  it("keeps trusted topic revisions active and rejects unsafe pre-v2 proposal acceptance", async () => {
    const value = await fixture();
    const user = value.database.appendEvent({ role: "user", content: "proposal evidence" });
    const topic = value.database.upsertTopicRevision({
      type: "project", title: "Trusted page", slug: "trusted-page", markdown: "# Trusted\n\nOriginal", summary: "Original",
      currentState: "original", history: "", sourceIds: [user.id], authorType: "user", promptVersion: "user-edit-v1"
    });
    const insertCandidate = (revision: number, markdown: string) => {
      const revisionId = uuidv7();
      value.database.connection.prepare(`
        INSERT INTO topic_page_revisions(id, topic_id, revision_number, markdown, summary, current_state, history,
          open_questions_json, generation_inputs_json, author_type, prompt_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, '', '[]', '{}', 'model', 'topic-proposal-v1', ?)
      `).run(revisionId, topic.id, revision, markdown, markdown, markdown, new Date().toISOString());
      value.database.connection.prepare("DELETE FROM topic_revision_fts WHERE revision_id = ?").run(revisionId);
      value.database.connection.prepare("DELETE FROM topic_fts WHERE topic_id = ?").run(topic.id);
      value.database.connection.prepare(`
        INSERT INTO topic_fts(topic_id, title, content)
        SELECT tp.id, tp.title, tpr.markdown FROM topic_pages tp JOIN topic_page_revisions tpr
          ON tpr.topic_id = tp.id AND tpr.revision_number = tp.active_revision WHERE tp.id = ?
      `).run(topic.id);
      return revisionId;
    };
    const firstRevisionId = insertCandidate(2, "# Trusted\n\nAccepted candidate");
    const proposal = {
      id: "a".repeat(64), groupId: "a".repeat(64), kind: "topic_update", topicId: topic.id, title: topic.title,
      claimIds: [], sourceIds: [user.id], parentRevisionId: firstRevisionId, parentRevision: 2, baseRevision: 1,
      children: [], links: [], requiresConfirmation: true, status: "pending", createdAt: new Date().toISOString()
    };
    value.database.setSetting("memory.pendingTopicProposals", [proposal]);
    const listed = await value.app.inject({ method: "GET", url: "/api/v1/memory-proposals", headers: headers(value) });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().proposals).toEqual([expect.objectContaining({ id: proposal.id, kind: "topic_update" })]);
    expect(value.database.getTopic(topic.id)?.revision).toBe(1);

    const accepted = await value.app.inject({
      method: "POST", url: `/api/v1/memory-proposals/${proposal.id}/resolve`, headers: headers(value, true),
      payload: { action: "accept", idempotencyKey: "accept-topic-proposal" }
    });
    expect(accepted.statusCode, accepted.body).toBe(409);
    expect(accepted.json()).toMatchObject({ error: { code: "MEMORY_PROPOSAL_STALE", retryable: true } });
    expect(value.database.getTopic(topic.id)).toMatchObject({ revision: 1, markdown: "# Trusted\n\nOriginal" });
    expect(value.database.getSetting<Array<{ id: string }>>("memory.pendingTopicProposals", []).map((item) => item.id)).toEqual([proposal.id]);

    const rejected = await value.app.inject({
      method: "POST", url: `/api/v1/memory-proposals/${proposal.id}/resolve`, headers: headers(value, true),
      payload: { action: "reject", idempotencyKey: "reject-topic-proposal" }
    });
    expect(rejected.statusCode).toBe(200);
    expect(value.database.getTopic(topic.id)?.revision).toBe(1);
    expect(value.database.getSetting<unknown[]>("memory.pendingTopicProposals", [])).toEqual([]);
    expect(value.database.getSetting<Array<{ status: string }>>("memory.resolvedTopicProposals", []).map((item) => item.status)).toEqual(["rejected"]);
    expect(value.database.connection.prepare("SELECT 1 FROM topic_page_revisions WHERE id = ?").get(firstRevisionId)).toBeUndefined();
    const rebuild = value.database.connection.prepare(`
      SELECT type, payload_json AS payloadJson, status, priority FROM jobs WHERE idempotency_key = ?
    `).get(stableHash(`memory.rebuild:legacy-proposal-reject:${proposal.id}`)) as {
      type: string;
      payloadJson: string;
      status: string;
      priority: number;
    } | undefined;
    expect(rebuild).toMatchObject({ type: "memory.rebuild", status: "queued", priority: 20 });
    expect(JSON.parse(rebuild!.payloadJson)).toEqual({
      topicIds: [topic.id],
      reason: "legacy_topic_proposal_reject",
      proposalId: proposal.id
    });
  });
});
