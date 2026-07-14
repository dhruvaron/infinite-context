import type { BootstrapData, ConversationEvent, SearchResult } from "./types";

const now = new Date();
const iso = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();

export const DEMO_IDS = {
  userEvent: "11111111-1111-4111-8111-111111111111",
  assistantEvent: "22222222-2222-4222-8222-222222222222",
  projectTopic: "33333333-3333-4333-8333-333333333333",
  memoryTopic: "44444444-4444-4444-8444-444444444444",
  decisionTopic: "55555555-5555-4555-8555-555555555555",
  sourceTopic: "66666666-6666-4666-8666-666666666666",
  entity: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  claimCurrent: "77777777-7777-4777-8777-777777777777",
  claimOld: "88888888-8888-4888-8888-888888888888",
  trace: "99999999-9999-4999-8999-999999999999",
  run: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
};

export const demoEvents: ConversationEvent[] = [
  {
    id: DEMO_IDS.userEvent,
    sequence: 1842,
    role: "user",
    kind: "message",
    status: "complete",
    content: "What did we decide about storing older context, and why did we avoid summaries as the source of truth?",
    parentEventId: null,
    runId: DEMO_IDS.run,
    active: true,
    createdAt: iso(3),
    completedAt: iso(3),
    attachments: []
  },
  {
    id: DEMO_IDS.assistantEvent,
    sequence: 1843,
    role: "assistant",
    kind: "message",
    status: "complete",
    content:
      "We decided to keep every conversation event **verbatim** in an append-only local timeline. Topic pages and claims are compiled views, never replacements for the original evidence.\n\nThat gives us three useful properties:\n\n- summaries can make retrieval efficient without erasing detail;\n- changed decisions remain historically queryable; and\n- every remembered claim can lead back to its exact source.\n\n```ts\nconst sourceOfTruth = rawTimeline;\nconst memory = compile(rawTimeline);\n```",
    parentEventId: DEMO_IDS.userEvent,
    runId: DEMO_IDS.run,
    active: true,
    createdAt: iso(2),
    completedAt: iso(2),
    attachments: []
  }
];

export const demoBootstrap: BootstrapData = {
  runtime: {
    mode: "demo",
    apiReachable: false,
    providerReachable: false,
    vectorSearch: "ready",
    memoryQueue: "idle",
    version: "0.1.0",
    lastMemoryUpdate: iso(1),
    message: "Preview data — local API is not connected"
  },
  settings: {
    theme: "system",
    quality: "balanced",
    memoryPaused: false,
    webSearchEnabled: true,
    onboardingComplete: true,
    systemInstructions: "Be clear, grounded, and use historical evidence when it is relevant.",
    showSourceChips: true,
    developerOverrides: false,
    promptTracingEnabled: false,
    responseModelIds: { fast: "gpt-5.6-luna", balanced: "gpt-5.6-terra", deep: "gpt-5.6-sol" },
    extractionModelId: "gpt-5.6-luna",
    embeddingModelId: "text-embedding-3-small"
  },
  budget: {
    totalUsd: 7.42,
    reservedUsd: 0.84,
    allocatedUsd: 8.26,
    availableUsd: 91.74,
    activeReservations: 2,
    capUsd: 100,
    warningThresholdUsd: 20,
    inputTokens: 823_104,
    outputTokens: 64_203,
    extractionTokens: 147_829,
    embeddingTokens: 522_113,
    ledgerCreatedAt: "2026-01-01T00:00:00.000Z",
    warningThresholdsReached: []
  },
  events: demoEvents,
  eventsNextCursor: null,
  activeRuns: [],
  topics: [
    {
      id: DEMO_IDS.projectTopic,
      type: "project",
      title: "Continuum",
      slug: "continuum",
      summary: "A local-first chat with an unbounded, inspectable memory layer.",
      currentState: "V1 is a general personal chat designed to grow into a coding agent.",
      history: "The project began from frustration with context compaction across long coding sessions.",
      openQuestions: ["Which retrieval signals deliver the strongest token-efficiency gain?"],
      tags: ["active", "product"],
      sourceIds: [DEMO_IDS.userEvent],
      sourceReferences: [{ id: DEMO_IDS.userEvent, type: "event" }],
      revision: 12,
      userAuthored: false,
      updatedAt: iso(1)
    },
    {
      id: DEMO_IDS.memoryTopic,
      type: "concept",
      title: "Memory architecture",
      slug: "memory-architecture",
      summary: "Hybrid raw history, atomic evidence, topic wiki, graph, and retrieval.",
      currentState: "Raw events remain authoritative; compiled pages are replaceable projections.",
      history: "A graph-only design was rejected in favor of a hybrid evidence model.",
      openQuestions: [],
      tags: ["architecture", "memory"],
      sourceIds: [DEMO_IDS.userEvent, DEMO_IDS.assistantEvent],
      sourceReferences: [{ id: DEMO_IDS.userEvent, type: "event" }, { id: DEMO_IDS.assistantEvent, type: "event" }],
      revision: 8,
      userAuthored: false,
      updatedAt: iso(1)
    },
    {
      id: DEMO_IDS.decisionTopic,
      type: "decision",
      title: "Raw timeline is authoritative",
      slug: "raw-timeline-authority",
      summary: "Summaries and wiki pages never replace verbatim transcript evidence.",
      currentState: "Accepted and current.",
      history: "Superseded an early proposal to rely on recursive summaries alone.",
      openQuestions: [],
      tags: ["accepted", "provenance"],
      sourceIds: [DEMO_IDS.userEvent],
      sourceReferences: [{ id: DEMO_IDS.userEvent, type: "event" }],
      revision: 3,
      userAuthored: true,
      updatedAt: iso(1)
    }
  ],
  claims: [
    {
      id: DEMO_IDS.claimCurrent,
      topicId: DEMO_IDS.decisionTopic,
      subject: "Continuum",
      predicate: "uses source of truth",
      value: "verbatim append-only event timeline",
      confidence: 0.99,
      status: "current",
      sourceRole: "user",
      sourceIds: [DEMO_IDS.userEvent],
      validFrom: iso(10080),
      validTo: null,
      observedAt: iso(10080),
      freshnessExpiresAt: null
    },
    {
      id: DEMO_IDS.claimOld,
      topicId: DEMO_IDS.decisionTopic,
      subject: "Continuum",
      predicate: "uses source of truth",
      value: "rolling recursive summary",
      confidence: 0.8,
      status: "superseded",
      sourceRole: "assistant",
      sourceIds: [DEMO_IDS.assistantEvent],
      validFrom: iso(20160),
      validTo: iso(10080),
      observedAt: iso(20160),
      freshnessExpiresAt: null
    }
  ],
  graph: {
    focusId: DEMO_IDS.projectTopic,
    truncated: false,
    nodes: [
      { id: DEMO_IDS.projectTopic, type: "topic", label: "Continuum", subtitle: "Project", status: "current", weight: 2.2 },
      { id: DEMO_IDS.entity, type: "entity", label: "Continuum project", subtitle: "Project entity", status: "current", weight: 1.2 },
      { id: DEMO_IDS.memoryTopic, type: "topic", label: "Memory architecture", subtitle: "Concept", status: "current", weight: 1.6 },
      { id: DEMO_IDS.decisionTopic, type: "topic", label: "Raw timeline", subtitle: "Decision", status: "current", weight: 1.5 },
      { id: DEMO_IDS.claimCurrent, type: "claim", label: "Verbatim history", subtitle: "Current claim", status: "current", weight: 1.15 },
      { id: DEMO_IDS.claimOld, type: "claim", label: "Rolling summary", subtitle: "Superseded", status: "historical", weight: 0.9 },
      { id: DEMO_IDS.sourceTopic, type: "source", label: "Planning transcript", subtitle: "Evidence", status: "current", weight: 1 },
      { id: DEMO_IDS.userEvent, type: "event", label: "Original decision", subtitle: "Message · 2 weeks ago", status: "current", weight: 0.8 },
      { id: DEMO_IDS.assistantEvent, type: "event", label: "Latest recall", subtitle: "Message · now", status: "current", weight: 0.75 }
    ],
    edges: [
      { id: "ab111111-1111-4111-8111-111111111111", source: DEMO_IDS.projectTopic, target: DEMO_IDS.memoryTopic, type: "uses", label: "uses", status: "current", evidenceIds: [DEMO_IDS.userEvent] },
      { id: "ab999999-9999-4999-8999-999999999999", source: DEMO_IDS.projectTopic, target: DEMO_IDS.entity, type: "describes", label: "describes", status: "current", evidenceIds: [DEMO_IDS.userEvent] },
      { id: "ab222222-2222-4222-8222-222222222222", source: DEMO_IDS.memoryTopic, target: DEMO_IDS.decisionTopic, type: "governed_by", label: "governed by", status: "current", evidenceIds: [DEMO_IDS.userEvent] },
      { id: "ab333333-3333-4333-8333-333333333333", source: DEMO_IDS.decisionTopic, target: DEMO_IDS.claimCurrent, type: "asserts", label: "asserts", status: "current", evidenceIds: [DEMO_IDS.userEvent] },
      { id: "ab444444-4444-4444-8444-444444444444", source: DEMO_IDS.decisionTopic, target: DEMO_IDS.claimOld, type: "supersedes", label: "supersedes", status: "historical", evidenceIds: [DEMO_IDS.userEvent] },
      { id: "ab555555-5555-4555-8555-555555555555", source: DEMO_IDS.claimCurrent, target: DEMO_IDS.sourceTopic, type: "supported_by", label: "supported by", status: "current", evidenceIds: [DEMO_IDS.userEvent] },
      { id: "ab666666-6666-4666-8666-666666666666", source: DEMO_IDS.sourceTopic, target: DEMO_IDS.userEvent, type: "contains", label: "contains", status: "current", evidenceIds: [] },
      { id: "ab777777-7777-4777-8777-777777777777", source: DEMO_IDS.assistantEvent, target: DEMO_IDS.decisionTopic, type: "retrieved", label: "retrieved", status: "current", evidenceIds: [DEMO_IDS.userEvent] }
    ]
  },
  activeMemories: [
    {
      id: DEMO_IDS.decisionTopic,
      type: "topic",
      title: "Raw timeline is authoritative",
      excerpt: "Compiled summaries never replace original evidence.",
      topicId: DEMO_IDS.decisionTopic,
      status: "current",
      pinned: true,
      reason: "Direct match for “source of truth”"
    },
    {
      id: DEMO_IDS.userEvent,
      type: "event",
      title: "Original architecture decision",
      excerpt: "Keep every event verbatim and link generated knowledge back to it.",
      sourceEventId: DEMO_IDS.userEvent,
      status: "historical",
      reason: "Exact supporting evidence"
    },
    {
      id: DEMO_IDS.memoryTopic,
      type: "topic",
      title: "Memory architecture",
      excerpt: "Hybrid event log, evidence ledger, wiki, and graph.",
      topicId: DEMO_IDS.memoryTopic,
      status: "current",
      reason: "One graph hop from active project"
    }
  ],
  attention: [
    {
      id: "attention-stale",
      kind: "stale",
      title: "1 external claim is stale",
      description: "A model-pricing source passed its 24-hour freshness window.",
      actionLabel: "Review"
    },
    {
      id: "attention-merge",
      kind: "merge",
      title: "Possible alias match",
      description: "“LLM Wiki” may refer to “Karpathy LLM Wiki”.",
      actionLabel: "Resolve"
    }
  ],
  memoryProposals: [],
  debug: {
    trace: {
      id: DEMO_IDS.trace,
      runId: DEMO_IDS.run,
      query: "What did we decide about older context?",
      classifications: ["factual_recall", "temporal_recall"],
      candidates: [
        {
          id: DEMO_IDS.decisionTopic,
          type: "topic",
          title: "Raw timeline is authoritative",
          excerpt: "Summaries never replace source evidence.",
          lexicalScore: 0.84,
          vectorScore: 0.91,
          graphScore: 0.75,
          temporalScore: 0.89,
          fusedScore: 0.92,
          rerankScore: 0.96,
          selected: true,
          reason: "Direct semantic and lexical match",
          sourceIds: [DEMO_IDS.userEvent]
        },
        {
          id: DEMO_IDS.memoryTopic,
          type: "topic",
          title: "Memory architecture",
          excerpt: "Hybrid raw and compiled memory model.",
          lexicalScore: 0.51,
          vectorScore: 0.82,
          graphScore: 0.88,
          temporalScore: null,
          fusedScore: 0.77,
          rerankScore: 0.86,
          selected: true,
          reason: "Graph-neighbor of selected decision",
          sourceIds: [DEMO_IDS.userEvent, DEMO_IDS.assistantEvent]
        },
        {
          id: DEMO_IDS.claimOld,
          type: "claim",
          title: "Rolling summary proposal",
          excerpt: "Early proposal later superseded.",
          lexicalScore: 0.72,
          vectorScore: 0.74,
          graphScore: 0.58,
          temporalScore: 0.32,
          fusedScore: 0.65,
          rerankScore: 0.41,
          selected: false,
          reason: "Excluded as superseded for current-state answer",
          sourceIds: [DEMO_IDS.assistantEvent]
        }
      ],
      selectedIds: [DEMO_IDS.decisionTopic, DEMO_IDS.memoryTopic],
      tokenBudget: { modelContext: 128000, reservedOutput: 32000, instructions: 4400, recentTurns: 1150, evidence: 2670 },
      latencyMs: 184,
      createdAt: iso(2)
    },
    contextPacket: {
      id: "context-packet-demo",
      runId: DEMO_IDS.run,
      orderedSourceIds: [DEMO_IDS.decisionTopic, DEMO_IDS.memoryTopic, DEMO_IDS.userEvent],
      hash: "sha256:demo-context-packet",
      renderedContent: "[Topic: Raw timeline is authoritative]\nSummaries never replace source evidence.\n\n[Event: Original architecture decision]\nKeep every event verbatim and link generated knowledge back to it.",
      reconstructionIntegrity: "verified",
      unavailableReferenceIds: [],
      promptVersion: "response-orchestrator@1.0.0",
      tokenBudget: { instructions: 4400, recentTurns: 1150, evidence: 2670, reservedOutput: 32000, maximumInput: 96000 }
    },
    modelCalls: [
      { id: "model-call-1", runId: DEMO_IDS.run, label: "Response", model: "gpt-5.6-terra", latencyMs: 1420, inputTokens: 8220, cachedInputTokens: 3200, outputTokens: 294, estimatedCostUsd: 0.018, status: "complete", promptVersion: "response-orchestrator@1.0.0", modelVersion: "gpt-5.6-terra" },
      { id: "model-call-2", runId: DEMO_IDS.run, label: "Rerank", model: "gpt-5.6-luna", latencyMs: 121, inputTokens: 1880, cachedInputTokens: 0, outputTokens: 146, estimatedCostUsd: 0.002, status: "complete", promptVersion: "reranker@1.0.0", modelVersion: "gpt-5.6-luna" }
    ],
    toolCalls: [{ id: "tool-call-1", runId: DEMO_IDS.run, name: "memory.search", arguments: { query: "older context" }, output: { selectedIds: [DEMO_IDS.decisionTopic, DEMO_IDS.memoryTopic] }, status: "complete", startedAt: iso(2.1), completedAt: iso(2), durationMs: 184, sandbox: { boundary: "local-database", network: "denied" } }],
    jobs: [
      { id: "job-1", name: "Compile topic pages", status: "complete", attempts: 1, updatedAt: iso(1) },
      { id: "job-2", name: "Embed new evidence", status: "complete", attempts: 1, updatedAt: iso(1) }
    ],
    promptVersion: "response-orchestrator@1.0.0",
    schemaVersion: "memory-delta@1.0.0",
    versions: { prompt: "response-orchestrator@1.0.0", schema: "memory-delta@1.0.0", retrieval: "hybrid-retrieval@1.0.0", reranker: "rrf-reranker@1.0.0", contextBuilder: "context-builder@1.0.0", vector: "sqlite-vec@0.1", parser: "parser@1.0.0", chunker: "chunker@1.0.0", responseModel: "gpt-5.6-terra", embeddingModel: "text-embedding-3-small" }
  }
};

export const demoSearchResults: SearchResult[] = [
  {
    id: DEMO_IDS.userEvent,
    type: "event",
    title: "You · Architecture decision",
    snippet: "…keep every conversation event verbatim and use summaries only as compiled views…",
    score: 0.96,
    timestamp: iso(10080),
    sourceEventId: DEMO_IDS.userEvent,
    tags: ["architecture", "decision"]
  },
  {
    id: DEMO_IDS.decisionTopic,
    type: "topic",
    title: "Raw timeline is authoritative",
    snippet: "Summaries and wiki pages never replace verbatim transcript evidence.",
    score: 0.93,
    timestamp: iso(1),
    sourceEventId: DEMO_IDS.userEvent,
    tags: ["accepted", "provenance"]
  },
  {
    id: DEMO_IDS.claimCurrent,
    type: "claim",
    title: "Continuum uses a verbatim event timeline",
    snippet: "Current · confidence 99% · supported by one user statement",
    score: 0.87,
    timestamp: iso(10080),
    sourceEventId: DEMO_IDS.userEvent,
    tags: ["current"]
  },
  {
    id: DEMO_IDS.sourceTopic,
    type: "source",
    title: "Planning transcript",
    snippet: "Original product and architecture discussion, including the infinite-context thesis.",
    score: 0.71,
    timestamp: iso(20160),
    sourceEventId: DEMO_IDS.userEvent,
    tags: ["transcript"]
  }
];
