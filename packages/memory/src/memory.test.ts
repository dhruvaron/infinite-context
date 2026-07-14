import { describe, expect, it } from "vitest";

import {
  FixtureMemoryModel,
  MemoryDeltaSchema,
  SchemaDrivenMemoryExtractor
} from "./extraction.js";
import {
  mergeEntities,
  resolveEntity,
  reverseEntityMerge
} from "./entity-resolution.js";
import {
  planSafeLintRepairs,
  runMemoryLint,
  shouldRunIdleLint
} from "./lint.js";
import {
  applyFreshness,
  freshnessExpiry,
  reconcileClaim,
  removeClaimProvenance,
  selectClaimsForIntent
} from "./temporal.js";
import {
  compileTopicPage,
  ProvenanceValidationError
} from "./topic-compiler.js";
import type {
  EntityRecord,
  EvidenceClaim,
  TopicParagraph
} from "./types.js";

const UUIDS = {
  topic: "00000000-0000-4000-8000-000000000001",
  source1: "00000000-0000-4000-8000-000000000002",
  source2: "00000000-0000-4000-8000-000000000003",
  claim1: "00000000-0000-4000-8000-000000000004",
  claim2: "00000000-0000-4000-8000-000000000005",
  run: "00000000-0000-4000-8000-000000000006",
  edge: "00000000-0000-4000-8000-000000000007",
  missing: "00000000-0000-4000-8000-000000000008",
  page2: "00000000-0000-4000-8000-000000000009"
} as const;

function claim(
  overrides: Partial<EvidenceClaim> & Pick<EvidenceClaim, "id" | "value">
): EvidenceClaim {
  const { id, value, ...rest } = overrides;
  return {
    id,
    topicId: UUIDS.topic,
    subject: "Continuum",
    predicate: "database",
    value,
    confidence: 0.95,
    status: "current",
    sourceRole: "user",
    sourceIds: [UUIDS.source1],
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: null,
    observedAt: "2026-01-01T00:00:00.000Z",
    freshnessExpiresAt: null,
    recordedAt: "2026-01-01T00:00:01.000Z",
    sourceKind: "conversation",
    explicitCorrection: false,
    attributedTo: null,
    extractionVersion: "1",
    ...rest
  };
}

describe("temporal evidence ledger", () => {
  it("supersedes an older user decision while preserving history", () => {
    const old = claim({ id: UUIDS.claim1, value: "MongoDB" });
    const current = claim({
      id: UUIDS.claim2,
      value: "PostgreSQL",
      sourceIds: [UUIDS.source2],
      validFrom: "2026-02-01T00:00:00.000Z",
      observedAt: "2026-02-01T00:00:00.000Z",
      recordedAt: "2026-02-01T00:00:01.000Z",
      explicitCorrection: true
    });
    const result = reconcileClaim([old], current);
    expect(result.outcome).toBe("superseded");
    expect(result.currentClaimIds).toEqual([UUIDS.claim2]);
    expect(result.claims.find((item) => item.id === UUIDS.claim1)).toMatchObject({
      status: "superseded",
      validTo: "2026-02-01T00:00:00.000Z"
    });
    expect(result.relations.map((item) => item.type)).toEqual([
      "supersedes",
      "contradicts"
    ]);
    expect(
      selectClaimsForIntent(result.claims, "historical", "2026-03-01T00:00:00.000Z").map(
        (item) => item.value
      )
    ).toContain("MongoDB");
  });

  it("does not let an assistant silently replace a user fact", () => {
    const user = claim({ id: UUIDS.claim1, value: "PostgreSQL" });
    const assistant = claim({
      id: UUIDS.claim2,
      value: "MySQL",
      sourceRole: "assistant",
      attributedTo: "assistant",
      observedAt: "2026-02-01T00:00:00.000Z",
      recordedAt: "2026-02-01T00:00:00.000Z"
    });
    const result = reconcileClaim([user], assistant);
    expect(result.outcome).toBe("conflicted");
    expect(result.currentClaimIds).toEqual([UUIDS.claim1]);
    expect(result.claims.find((item) => item.id === UUIDS.claim1)?.status).toBe("current");
    expect(result.claims.find((item) => item.id === UUIDS.claim2)?.status).toBe("conflicted");
  });

  it("links duplicates, expires stale current facts, and removes only selected provenance", () => {
    const first = claim({ id: UUIDS.claim1, value: "PostgreSQL", sourceIds: [UUIDS.source1, UUIDS.source2] });
    const duplicate = claim({
      id: UUIDS.claim2,
      value: " postgresql ",
      sourceIds: [UUIDS.source2],
      observedAt: "2026-02-01T00:00:00.000Z",
      recordedAt: "2026-02-01T00:00:00.000Z"
    });
    expect(reconcileClaim([first], duplicate).outcome).toBe("duplicate");
    const expiring = { ...first, freshnessExpiresAt: "2026-01-02T00:00:00.000Z" };
    expect(applyFreshness([expiring], "2026-01-03T00:00:00.000Z")[0]?.status).toBe("expired");
    const removal = removeClaimProvenance(first, new Set([UUIDS.source1]));
    expect(removal.retained?.sourceIds).toEqual([UUIDS.source2]);
    expect(removal.removedClaim).toBe(false);
    expect(removeClaimProvenance(first, new Set([UUIDS.source1, UUIDS.source2])).retained).toBeNull();
    expect(freshnessExpiry("2026-01-01T00:00:00.000Z", "rapidly_changing")).toBe(
      "2026-01-02T00:00:00.000Z"
    );
    expect(freshnessExpiry("2026-01-01T00:00:00.000Z", "timeless")).toBeNull();
  });
});

describe("entity resolution", () => {
  const entity: EntityRecord = {
    id: UUIDS.topic,
    type: "project",
    displayName: "Infinite Build",
    aliases: ["InfiniteBuild"],
    status: "active",
    canonicalId: null,
    revision: 1,
    sourceIds: [UUIDS.source1]
  };

  it("links exact aliases and requests review for uncertain names", () => {
    expect(
      resolveEntity(
        {
          mentionId: "m1",
          displayName: "InfiniteBuild",
          type: "project",
          aliases: [],
          confidence: 1,
          sourceIds: [UUIDS.source1]
        },
        [entity]
      )
    ).toMatchObject({ action: "link", entityId: UUIDS.topic });
    const uncertain = resolveEntity(
      {
        mentionId: "m2",
        displayName: "Infinite Builder",
        type: "project",
        aliases: [],
        confidence: 0.95,
        sourceIds: [UUIDS.source2]
      },
      [entity],
      { autoMergeThreshold: 0.99, proposalThreshold: 0.6 }
    );
    expect(uncertain.action).toBe("propose_merge");
  });

  it("uses vector and graph context to propose ambiguous aliases without unsafe auto-merges", () => {
    const ambiguousMention = {
      mentionId: "m-context",
      displayName: "Infinite Builder Platform",
      type: "project" as const,
      aliases: [],
      confidence: 1,
      sourceIds: [UUIDS.source2]
    };
    expect(resolveEntity(ambiguousMention, [entity]).action).toBe("create");
    const contextual = resolveEntity(ambiguousMention, [entity], undefined, {
      vectorSimilarity: () => 0.98,
      graphContextSimilarity: () => 0.9
    });
    expect(contextual).toMatchObject({
      action: "propose_merge",
      proposal: { candidateEntityId: UUIDS.topic, requiresConfirmation: true }
    });
    if (contextual.action === "propose_merge") {
      expect(contextual.proposal.reasons).toEqual(expect.arrayContaining([
        "vector similarity 0.980",
        "graph-context similarity 0.900"
      ]));
    }

    const reordered = resolveEntity({ ...ambiguousMention, displayName: "Build Infinite" }, [entity], undefined, {
      vectorSimilarity: () => 0.1,
      graphContextSimilarity: () => 0.1
    });
    expect(reordered.action).not.toBe("link");
    expect(reordered.action).not.toBe("auto_merge");
  });

  it("supports optimistic, reversible merges", () => {
    const secondary: EntityRecord = {
      ...entity,
      id: UUIDS.claim1,
      displayName: "Infinite Builder",
      aliases: [],
      sourceIds: [UUIDS.source2]
    };
    const history = mergeEntities("merge-1", entity, secondary);
    expect(history.secondaryAfter).toMatchObject({ status: "merged", canonicalId: UUIDS.topic });
    const [restoredPrimary, restoredSecondary] = reverseEntityMerge(
      history,
      history.primaryAfter,
      history.secondaryAfter
    );
    expect(restoredPrimary.displayName).toBe("Infinite Build");
    expect(restoredSecondary.status).toBe("active");
    expect(() =>
      reverseEntityMerge(
        history,
        { ...history.primaryAfter, revision: 99 },
        history.secondaryAfter
      )
    ).toThrow(/concurrent/i);
  });
});

describe("topic compilation and lint", () => {
  const supportedClaim = claim({ id: UUIDS.claim1, value: "PostgreSQL" });
  const paragraph: TopicParagraph = {
    id: "p1",
    section: "current_state",
    markdown: "PostgreSQL is the current database.",
    factual: true,
    claimIds: [UUIDS.claim1],
    sourceIds: [UUIDS.source1]
  };

  it("rejects unsupported factual prose and protects user-authored pages", () => {
    expect(() =>
      compileTopicPage({
        id: UUIDS.topic,
        type: "project",
        title: "Continuum",
        tags: [],
        revision: 2,
        updatedAt: "2026-01-01T00:00:00.000Z",
        paragraphs: [{ ...paragraph, claimIds: [], sourceIds: [] }],
        claims: [supportedClaim],
        previousPage: null
      })
    ).toThrow(ProvenanceValidationError);
    const compiled = compileTopicPage({
      id: UUIDS.topic,
      type: "project",
      title: "Continuum",
      tags: ["memory", "memory"],
      revision: 2,
      updatedAt: "2026-01-01T00:00:00.000Z",
      paragraphs: [paragraph],
      claims: [supportedClaim],
      previousPage: {
        id: UUIDS.topic,
        type: "project",
        title: "Continuum",
        slug: "old",
        summary: "",
        currentState: "",
        history: "",
        openQuestions: [],
        tags: [],
        sourceIds: [UUIDS.source1],
        revision: 1,
        userAuthored: true,
        updatedAt: "2025-12-01T00:00:00.000Z"
      }
    });
    expect(compiled.activation).toBe("proposal");
    expect(compiled.page.tags).toEqual(["memory"]);
    expect(compiled.markdown).toContain("## Evidence");
    const oversized = compileTopicPage({
      id: UUIDS.topic,
      type: "project",
      title: "Continuum",
      tags: [],
      revision: 3,
      updatedAt: "2026-01-01T00:00:00.000Z",
      paragraphs: [{ ...paragraph, markdown: "x".repeat(1_000) }],
      claims: [supportedClaim],
      previousPage: null,
      maxCharacters: 700
    });
    expect(oversized.childPages.length).toBeGreaterThan(0);
    expect(oversized.markdown.length).toBeLessThanOrEqual(700);
    expect(oversized.childPages.every((child) => child.markdown.length <= 700)).toBe(true);
    expect(oversized.markdown).toContain("continuum://topic/");

    const manyParts = compileTopicPage({
      id: UUIDS.topic,
      type: "project",
      title: "Continuum",
      tags: [],
      revision: 4,
      updatedAt: "2026-01-01T00:00:00.000Z",
      paragraphs: [{ ...paragraph, markdown: "bounded ".repeat(1_600) }],
      claims: [supportedClaim],
      previousPage: null,
      maxCharacters: 700
    });
    expect(manyParts.childPages.length).toBeGreaterThan(30);
    expect(manyParts.markdown.length).toBeLessThanOrEqual(700);
    expect(manyParts.markdown).toContain("Continue through the Next links");
    expect(manyParts.childPages.every((child) => child.markdown.length <= 700 && child.markdown.includes("Parent:"))).toBe(true);
    expect(manyParts.childPages[0]!.markdown).toContain("Next:");
    expect(manyParts.childPages.at(-1)!.markdown).toContain("Previous:");

    const historicalOnly = compileTopicPage({
      id: UUIDS.topic,
      type: "project",
      title: "Continuum history",
      tags: [],
      revision: 5,
      updatedAt: "2026-01-01T00:00:00.000Z",
      paragraphs: [
        { ...paragraph, section: "history", markdown: "historical evidence ".repeat(500) },
        { id: "open", section: "open_questions", markdown: "No unresolved questions.", factual: false, claimIds: [], sourceIds: [] }
      ],
      claims: [{ ...supportedClaim, status: "historical" }],
      previousPage: null,
      maxCharacters: 700
    });
    expect(historicalOnly.childPages.length).toBeGreaterThan(1);
    expect(historicalOnly.childPages.every((child) => child.evidenceIds.includes(UUIDS.claim1) && child.evidenceIds.includes(UUIDS.source1))).toBe(true);
  });

  it("finds deterministic lint issues and only auto-plans safe repairs", () => {
    const duplicate = claim({ id: UUIDS.claim2, value: "PostgreSQL", sourceIds: [UUIDS.source2] });
    const compiled = compileTopicPage({
      id: UUIDS.topic,
      type: "project",
      title: "Continuum",
      tags: [],
      revision: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      paragraphs: [paragraph],
      claims: [supportedClaim],
      previousPage: null
    });
    const issues = runMemoryLint({
      now: "2026-02-01T00:00:00.000Z",
      pages: [compiled.page, { ...compiled.page, id: UUIDS.page2 }],
      pageMarkdown: new Map([[UUIDS.topic, compiled.markdown], [UUIDS.page2, compiled.markdown]]),
      sectionSources: compiled.sectionSources,
      claims: [supportedClaim, duplicate],
      entities: [],
      edges: [
        {
          id: UUIDS.edge,
          source: UUIDS.topic,
          target: UUIDS.missing,
          type: "related",
          status: "current",
          evidenceIds: []
        }
      ],
      extractionFailures: []
    });
    expect(issues.map((item) => item.type)).toEqual(
      expect.arrayContaining(["broken_link", "duplicate_claim"])
    );
    expect(planSafeLintRepairs(issues)).toEqual({
      brokenEdgeIds: [UUIDS.edge],
      duplicateClaimGroups: [[UUIDS.claim1, UUIDS.claim2]],
      duplicatePageGroups: [[UUIDS.topic, UUIDS.page2]]
    });
    const nearDuplicateIssues = runMemoryLint({
      now: "2026-02-01T00:00:00.000Z",
      pages: [compiled.page, { ...compiled.page, id: UUIDS.page2 }],
      pageMarkdown: new Map([[UUIDS.topic, compiled.markdown], [UUIDS.page2, `${compiled.markdown}\n`]]),
      sectionSources: compiled.sectionSources,
      claims: [supportedClaim, { ...duplicate, value: "postgresql" }],
      entities: [],
      edges: [],
      extractionFailures: []
    });
    expect(planSafeLintRepairs(nearDuplicateIssues)).toMatchObject({ duplicateClaimGroups: [], duplicatePageGroups: [] });
    expect(
      shouldRunIdleLint({
        now: "2026-01-02T00:05:00.000Z",
        lastActivityAt: "2026-01-02T00:00:00.000Z",
        lastLintAt: "2026-01-01T00:00:00.000Z",
        manual: false
      })
    ).toBe(true);
  });
});

describe("schema-driven extraction", () => {
  it("validates provenance, filters trivia, honors remember, and attributes assistant conclusions", async () => {
    const event = {
      id: UUIDS.source1,
      sequence: 1,
      role: "user" as const,
      kind: "message" as const,
      status: "complete" as const,
      content: "Remember this even if confidence is low.",
      parentEventId: null,
      runId: UUIDS.run,
      active: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      attachments: []
    };
    const fixture = MemoryDeltaSchema.parse({
      entities: [],
      claims: [
        claim({
          id: UUIDS.claim1,
          value: "confidence is low",
          confidence: 0.2,
          sourceIds: [UUIDS.source1],
          sourceRole: "assistant",
          attributedTo: null
        })
      ],
      relations: [],
      affectedTopicHints: ["Continuum"],
      trace: {
        promptVersion: "p1",
        schemaVersion: "1.0.0",
        providerModel: "fixture",
        inputEventIds: [UUIDS.source1],
        warnings: []
      }
    });
    const extractor = new SchemaDrivenMemoryExtractor(new FixtureMemoryModel(fixture));
    const result = await extractor.extract({
      events: [event],
      relevantClaims: [],
      relevantPages: [],
      extractionVersion: "1",
      promptVersion: "p1"
    });
    expect(result.delta.claims).toHaveLength(1);
    expect(result.delta.claims[0]?.attributedTo).toBe("assistant");
    expect(result.delta.trace.providerModel).toBe("fixture-memory-model");
    expect(result.delta.trace.inputEventIds).toEqual([UUIDS.source1]);
  });
});
