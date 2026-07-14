import { describe, expect, it, vi } from "vitest";

import {
  generateCandidateRankings,
  InMemoryCandidateIndex
} from "./candidates.js";
import { classifyQuery } from "./classification.js";
import { buildContextPacket } from "./context.js";
import { RetrievalEngine } from "./engine.js";
import { reciprocalRankFusion } from "./fusion.js";
import { expandGraphCandidates } from "./graph.js";
import { LexicalFixtureReranker } from "./reranker.js";
import {
  MemoryToolRoundLimitError,
  MemoryToolRouter,
  type MemoryToolHandlers
} from "./tools.js";
import {
  FULL_RETRIEVAL_FEATURES,
  RETRIEVAL_ABLATIONS,
  type CandidateDocument,
  type QueryClassification,
  type RankedCandidate
} from "./types.js";

const IDS = {
  a: "10000000-0000-4000-8000-000000000001",
  b: "10000000-0000-4000-8000-000000000002",
  c: "10000000-0000-4000-8000-000000000003",
  sourceA: "10000000-0000-4000-8000-000000000004",
  sourceB: "10000000-0000-4000-8000-000000000005",
  edge: "10000000-0000-4000-8000-000000000006",
  run: "10000000-0000-4000-8000-000000000007",
  scope: "10000000-0000-4000-8000-000000000008"
} as const;

function document(overrides: Partial<CandidateDocument> & Pick<CandidateDocument, "id" | "content">): CandidateDocument {
  const { id, content, ...rest } = overrides;
  return {
    id,
    type: "claim",
    sourceKind: "conversation",
    title: "Database decision",
    content,
    sourceIds: [id === IDS.a ? IDS.sourceA : IDS.sourceB],
    observedAt: "2026-01-01T00:00:00.000Z",
    validFrom: null,
    validTo: null,
    status: "current",
    confidence: 1,
    authority: 1,
    freshnessExpiresAt: null,
    scopeId: IDS.scope,
    topicId: IDS.a,
    entityNames: ["Continuum"],
    pinned: false,
    embedding: [1, 0],
    tokenCount: 20,
    rawSource: false,
    ...rest
  };
}

const classification: QueryClassification = {
  classes: ["factual_recall"],
  timeIntent: "current",
  dateRange: null,
  entities: ["Continuum"],
  requestedSourceTypes: [],
  relationshipQuestion: false,
  confidence: 0.9,
  usedModelFallback: false
};

function ranked(doc: CandidateDocument, score = 0.1): RankedCandidate {
  return {
    id: doc.id,
    type: doc.type,
    title: doc.title,
    excerpt: doc.content,
    lexicalScore: score,
    vectorScore: null,
    graphScore: null,
    temporalScore: null,
    fusedScore: score,
    rerankScore: null,
    selected: false,
    reason: "fixture",
    sourceIds: doc.sourceIds,
    document: doc,
    componentScores: { lexical: score },
    componentReasons: ["fixture"],
    rank: 1
  };
}

describe("query understanding", () => {
  it("classifies exact, temporal, document questions without a model", async () => {
    const result = await classifyQuery(
      "What exactly did I originally say in the PDF about Continuum?"
    );
    expect(result.classes).toEqual(
      expect.arrayContaining(["exact_lookup", "temporal_recall", "document_question"])
    );
    expect(result.timeIntent).toBe("historical");
    expect(result.usedModelFallback).toBe(false);
    expect(
      await classifyQuery("What changed between 2024 and 2025?")
    ).toMatchObject({
      timeIntent: "range",
      dateRange: {
        from: "2024-01-01T00:00:00.000Z",
        to: "2026-01-01T00:00:00.000Z"
      }
    });
  });

  it("uses a cheap fallback only when deterministic cues are ambiguous", async () => {
    const result = await classifyQuery("Thoughts?", {
      async classify() {
        return {
          classes: ["conversational"],
          timeIntent: "unspecified",
          entities: [],
          requestedSourceTypes: [],
          relationshipQuestion: false,
          confidence: 0.8
        };
      }
    });
    expect(result.usedModelFallback).toBe(true);
  });
});

describe("candidate generation and fusion", () => {
  it("runs independently switchable lexical, vector, entity, and temporal channels", async () => {
    const current = document({ id: IDS.a, content: "PostgreSQL is the current Continuum database." });
    const historical = document({
      id: IDS.b,
      content: "MongoDB was the original Continuum database.",
      status: "superseded",
      embedding: [0.8, 0.2]
    });
    const index = new InMemoryCandidateIndex([current, historical]);
    const rankings = await generateCandidateRankings(
      index,
      {
        query: "What is the current Continuum database?",
        queryEmbedding: [1, 0],
        queryEmbeddingModelId: "fixture",
        classification,
        now: "2026-02-01T00:00:00.000Z",
        scopeId: IDS.scope,
        activeTopicIds: [IDS.a],
        limitPerChannel: 10
      },
      FULL_RETRIEVAL_FEATURES
    );
    expect(Object.keys(rankings)).toEqual(
      expect.arrayContaining(["lexical", "vector", "entity", "temporal"])
    );
    const fused = reciprocalRankFusion(rankings, classification, {
      now: "2026-02-01T00:00:00.000Z"
    });
    expect(fused[0]?.id).toBe(IDS.a);
    expect(fused[0]?.temporalScore).toBe(1);
  });

  it("honors requested source filters and topic-page ablations", async () => {
    const conversation = document({ id: IDS.a, content: "Conversation fact" });
    const web = document({
      id: IDS.b,
      content: "Web fact",
      type: "source",
      sourceKind: "web"
    });
    const topic = document({
      id: IDS.c,
      content: "Web topic summary",
      type: "topic",
      sourceKind: "web"
    });
    const rankings = await generateCandidateRankings(
      new InMemoryCandidateIndex([conversation, web, topic]),
      {
        query: "web fact",
        queryEmbedding: [1, 0],
        queryEmbeddingModelId: "fixture",
        classification: { ...classification, requestedSourceTypes: ["web"] },
        now: "2026-02-01T00:00:00.000Z",
        scopeId: IDS.scope,
        activeTopicIds: [],
        limitPerChannel: 10
      },
      RETRIEVAL_ABLATIONS.no_topic_pages
    );
    const ids = Object.values(rankings).flat().map((item) => item.document.id);
    expect(ids).toContain(IDS.b);
    expect(ids).not.toContain(IDS.a);
    expect(ids).not.toContain(IDS.c);
  });

  it("does not run vector retrieval when the query embedding has no exact model id", async () => {
    const vector = vi.fn(async () => []);
    const empty = vi.fn(async () => []);
    const rankings = await generateCandidateRankings(
      {
        lexical: empty,
        vector,
        recency: empty,
        entity: empty,
        activeTopic: empty,
        pinned: empty,
        temporal: empty
      },
      {
        query: "database",
        queryEmbedding: [1, 0],
        queryEmbeddingModelId: null,
        classification,
        now: "2026-02-01T00:00:00.000Z",
        scopeId: IDS.scope,
        activeTopicIds: [],
        limitPerChannel: 10
      },
      FULL_RETRIEVAL_FEATURES
    );

    expect(vector).not.toHaveBeenCalled();
    expect(rankings).not.toHaveProperty("vector");
  });
});

describe("bounded graph expansion", () => {
  it("uses one hop normally and permits a second hop only for relationship questions", () => {
    const a = document({ id: IDS.a, content: "Alice owns Atlas." });
    const b = document({ id: IDS.b, content: "Atlas service implementation." });
    const c = document({ id: IDS.c, content: "Atlas is written in Rust." });
    const edges = [
        { id: IDS.edge, source: IDS.a, target: IDS.b, type: "owns", status: "current" as const, evidenceIds: [] },
        { id: IDS.sourceA, source: IDS.b, target: IDS.c, type: "written_in", status: "current" as const, evidenceIds: [] }
      ];
    const graph = {
      getAdjacent(id: string, limit: number) {
        return edges.filter((edge) => edge.source === id || edge.target === id).slice(0, limit);
      },
      getDocument(id: string) {
        return [a, b, c].find((item) => item.id === id) ?? null;
      }
    };
    const ordinary = expandGraphCandidates("Atlas Rust", [ranked(a)], graph, classification);
    expect(ordinary.map((item) => item.document.id)).toEqual([IDS.b]);
    const relationship = expandGraphCandidates(
      "How is Alice related to Rust?",
      [ranked(a)],
      graph,
      { ...classification, relationshipQuestion: true }
    );
    expect(relationship.map((item) => item.document.id)).toEqual(
      expect.arrayContaining([IDS.b, IDS.c])
    );
  });
});

describe("adaptive context budget", () => {
  it("reserves 25% output, retains four complete turns, deduplicates evidence, and prefers raw sources", () => {
    const summary = document({ id: IDS.a, content: "same evidence", rawSource: false, tokenCount: 50 });
    const raw = document({ id: IDS.b, content: "same evidence", rawSource: true, tokenCount: 50 });
    const packet = buildContextPacket({
      modelContextTokens: 1_000,
      instructionTokens: 100,
      toolDefinitionTokens: 50,
      recentTurns: Array.from({ length: 8 }, (_, index) => ({
        id: `turn-${index}`,
        turnIndex: Math.floor(index / 2),
        role: index % 2 === 0 ? "user" as const : "assistant" as const,
        content: "turn",
        complete: true,
        tokenCount: 20
      })),
      candidates: [ranked(summary, 0.2), ranked(raw, 0.1)],
      notices: [{ kind: "conflict", text: "Evidence conflicts", tokenCount: 10 }]
    });
    expect(packet.reservedOutputTokens).toBe(250);
    expect(new Set(packet.recentTurns.map((turn) => turn.turnIndex)).size).toBe(4);
    expect(packet.evidence).toHaveLength(1);
    expect(packet.evidence[0]?.id).toBe(IDS.b);
    expect(packet.usedTokens).toBeLessThanOrEqual(750);
  });

  it("never includes half of a conversational turn when capacity is tight", () => {
    const packet = buildContextPacket({
      modelContextTokens: 200,
      instructionTokens: 100,
      toolDefinitionTokens: 0,
      recentTurns: [
        { id: "user", turnIndex: 1, role: "user", content: "u", complete: true, tokenCount: 20 },
        { id: "assistant", turnIndex: 1, role: "assistant", content: "a", complete: true, tokenCount: 40 }
      ],
      candidates: [],
      notices: []
    });
    expect(packet.recentTurns).toEqual([]);
    expect(packet.exclusions.map((item) => item.id)).toEqual(["user", "assistant"]);
  });
});

describe("exact lookup tools and engine trace", () => {
  const emptyResult = { items: [], nextCursor: null, exhausted: true, warning: null };
  const handlers = Object.fromEntries(
    ["search_memory", "open_event", "open_source", "get_topic_page", "trace_claim", "search_timeline"].map(
      (name) => [name, async () => emptyResult]
    )
  ) as unknown as MemoryToolHandlers;

  it("hard-stops after three provider-neutral lookup rounds", async () => {
    const router = new MemoryToolRouter(handlers);
    for (let round = 0; round < 3; round += 1) {
      await router.call("search_memory", { query: "database", filters: {}, limit: 10 });
    }
    await expect(
      router.call("search_memory", { query: "database", filters: {}, limit: 10 })
    ).rejects.toBeInstanceOf(MemoryToolRoundLimitError);
    expect(router.roundsRemaining).toBe(0);
  });

  it("records a complete deterministic retrieval trace", async () => {
    const doc = document({ id: IDS.a, content: "PostgreSQL is current." });
    const index = new InMemoryCandidateIndex([doc]);
    const engine = new RetrievalEngine(
      index,
      { getAdjacent: () => [], getDocument: () => null },
      new LexicalFixtureReranker(),
      null,
      FULL_RETRIEVAL_FEATURES
    );
    const result = await engine.retrieve({
      runId: IDS.run,
      query: "What is the current PostgreSQL database?",
      queryEmbedding: [1, 0],
      queryEmbeddingModelId: "fixture",
      now: "2026-02-01T00:00:00.000Z",
      scopeId: IDS.scope,
      activeTopicIds: [IDS.a],
      limit: 5,
      modelContextTokens: 8_000,
      reservedOutputTokens: 2_000,
      instructionTokens: 500,
      recentTurnTokens: 1_000,
      evidenceTokenBudget: 2_000
    });
    expect(result.trace.runId).toBe(IDS.run);
    expect(result.trace.selectedIds).toEqual([IDS.a]);
    expect(result.trace.candidates[0]).not.toHaveProperty("document");
  });

  it("keeps vector and graph channels independently disabled by ablation flags", async () => {
    const doc = document({ id: IDS.a, content: "PostgreSQL is current." });
    const lexical = vi.fn(async () => [{ document: doc, channel: "lexical" as const, score: 1, reason: "fixture" }]);
    const vector = vi.fn(async () => [{ document: doc, channel: "vector" as const, score: 1, reason: "must not run" }]);
    const empty = vi.fn(async () => []);
    const index = {
      lexical,
      vector,
      recency: empty,
      entity: empty,
      activeTopic: empty,
      pinned: empty,
      temporal: empty
    };
    const getAdjacent = vi.fn(() => []);
    const engine = new RetrievalEngine(
      index,
      { getAdjacent, getDocument: () => null },
      new LexicalFixtureReranker(),
      null,
      { ...RETRIEVAL_ABLATIONS.no_vector, graph: false, reranking: false }
    );

    await engine.retrieve({
      runId: IDS.run,
      query: "What is the current PostgreSQL database?",
      queryEmbedding: [1, 0],
      queryEmbeddingModelId: "fixture",
      now: "2026-02-01T00:00:00.000Z",
      scopeId: IDS.scope,
      activeTopicIds: [],
      limit: 5,
      modelContextTokens: 8_000,
      reservedOutputTokens: 2_000,
      instructionTokens: 500,
      recentTurnTokens: 1_000,
      evidenceTokenBudget: 2_000
    });

    expect(lexical).toHaveBeenCalledOnce();
    expect(vector).not.toHaveBeenCalled();
    expect(getAdjacent).not.toHaveBeenCalled();
  });
});
