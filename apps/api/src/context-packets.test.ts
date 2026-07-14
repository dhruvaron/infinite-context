import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@continuum/config";
import { ContinuumDatabase } from "@continuum/database";
import type { RankedCandidate } from "@continuum/retrieval";
import { composeStoredContextPacket, reconstructStoredContextPacket } from "./context-packets.js";

const fixtures: Array<{ root: string; database: ContinuumDatabase }> = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "continuum-context-packet-"));
  const config = loadConfig({
    NODE_ENV: "test",
    CONTINUUM_DATA_DIR: root,
    CONTINUUM_SESSION_TOKEN: "context-packet-test-token-at-least-32-chars"
  });
  const database = ContinuumDatabase.open(config);
  fixtures.push({ root, database });
  return database;
}

afterEach(async () => {
  while (fixtures.length) {
    const value = fixtures.pop()!;
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

describe("reference-only context packet audit", () => {
  it("reconstructs and verifies exact rendered memory without storing source bodies twice", async () => {
    const database = await fixture();
    const event = database.appendEvent({ role: "user", content: "Private packet canary: lilac telescope." });
    const candidate: RankedCandidate = {
      id: event.id,
      type: "event",
      title: "User evidence",
      excerpt: event.content,
      lexicalScore: 1,
      vectorScore: null,
      graphScore: null,
      temporalScore: null,
      fusedScore: 1,
      rerankScore: 1,
      selected: true,
      reason: "fixture",
      sourceIds: [event.id],
      document: {
        id: event.id,
        type: "event",
        sourceKind: "conversation",
        title: "User evidence",
        content: event.content,
        sourceIds: [event.id],
        observedAt: event.createdAt,
        validFrom: event.createdAt,
        validTo: null,
        status: "current",
        confidence: 1,
        authority: 1,
        freshnessExpiresAt: null,
        scopeId: "global",
        topicId: null,
        entityNames: [],
        pinned: false,
        embedding: null,
        tokenCount: 10,
        rawSource: true
      },
      componentScores: {},
      componentReasons: [],
      rank: 1
    };
    const stored = composeStoredContextPacket({
      database,
      notices: [{ kind: "stale", text: "Verify time-sensitive evidence.", tokenCount: 5 }],
      evidence: [candidate],
      recentTurns: [{ id: event.id, role: "user", turnIndex: 1, content: event.content, complete: true, tokenCount: 10 }]
    });
    const run = database.createRun(event.id, "balanced");
    database.saveContextPacket({
      runId: run.id,
      budget: { evidence: 10 },
      sourceIds: stored.dependencyIds,
      promptVersion: "response-v1",
      renderedContent: stored.renderedContent,
      composition: stored.composition
    });

    const row = database.connection.prepare(`
      SELECT rendered_content, composition_json, content_hash, source_ids_json
      FROM context_packets WHERE run_id = ?
    `).get(run.id) as { rendered_content: string; composition_json: string; content_hash: string; source_ids_json: string };
    expect(row.rendered_content).toBe("");
    expect(row.composition_json).not.toContain("lilac telescope");
    expect(JSON.parse(row.source_ids_json)).toContain(event.id);

    const reconstructed = reconstructStoredContextPacket(database, JSON.parse(row.composition_json), row.content_hash);
    expect(reconstructed).toMatchObject({ integrity: "verified", unavailableReferenceIds: [] });
    expect(reconstructed.renderedContent).toBe(stored.renderedContent);
  });

  it("refuses to display stale debug text after a referenced body disappears", async () => {
    const database = await fixture();
    const event = database.appendEvent({ role: "user", content: "Remove this exact source." });
    const composition = {
      version: 1,
      notices: [],
      evidence: [{ id: event.id, type: "event", bodyRefId: event.id, title: "Source", status: "current", confidence: 1, sourceIds: [event.id], tokenCount: 5, contentHash: "not-the-current-hash" }],
      recentTurns: []
    };
    const reconstructed = reconstructStoredContextPacket(database, composition, "expected");
    expect(reconstructed).toMatchObject({ integrity: "unavailable", renderedContent: null, unavailableReferenceIds: [event.id] });
  });
});
