import { stableHash } from "@continuum/config";
import { ContinuumDatabase } from "@continuum/database";
import type { ContextNotice, ContextTurn, RankedCandidate } from "@continuum/retrieval";

export interface ContextPacketEvidenceReference {
  id: string;
  type: RankedCandidate["document"]["type"];
  bodyRefId: string;
  title: string;
  status: RankedCandidate["document"]["status"];
  confidence: number;
  sourceIds: string[];
  tokenCount: number;
  contentHash: string;
}

export interface ContextPacketComposition {
  version: 1;
  notices: Array<ContextNotice & { contentHash: string }>;
  evidence: ContextPacketEvidenceReference[];
  recentTurns: Array<Pick<ContextTurn, "id" | "role" | "turnIndex" | "tokenCount"> & { contentHash: string }>;
}

export interface ReconstructedContextPacket {
  renderedContent: string | null;
  integrity: "verified" | "unavailable" | "mismatch" | "legacy";
  unavailableReferenceIds: string[];
  expectedContentHash: string;
  actualContentHash: string | null;
}

export function renderUntrustedMemoryContext(notices: readonly ContextNotice[], evidence: readonly RankedCandidate[]): string {
  const renderedNotices = notices.map((notice, index) => JSON.stringify({
    noticeLabel: `N${index + 1}`,
    noticeKind: notice.kind,
    untrustedNotice: notice.text
  }));
  const renderedEvidence = evidence.map((candidate, index) => JSON.stringify({
    evidenceLabel: `M${index + 1}`,
    evidenceType: candidate.document.type,
    status: candidate.document.status,
    confidence: candidate.document.confidence,
    title: candidate.document.title,
    sourceIds: candidate.document.sourceIds,
    untrustedEvidence: candidate.document.content
  }));
  return [...renderedNotices, ...renderedEvidence].join("\n");
}

function activeTopicRevisionId(database: ContinuumDatabase, topicId: string): string | null {
  const row = database.connection.prepare(`
    SELECT tpr.id FROM topic_pages tp
    JOIN topic_page_revisions tpr
      ON tpr.topic_id = tp.id AND tpr.revision_number = tp.active_revision
    WHERE tp.id = ?
  `).get(topicId) as { id: string } | undefined;
  return row?.id ?? null;
}

export function composeStoredContextPacket(input: {
  database: ContinuumDatabase;
  notices: readonly ContextNotice[];
  evidence: readonly RankedCandidate[];
  recentTurns: readonly ContextTurn[];
  additionalDependencyIds?: readonly string[];
}): { composition: ContextPacketComposition; dependencyIds: string[]; renderedContent: string } {
  const evidence = input.evidence.map((candidate): ContextPacketEvidenceReference => {
    const bodyRefId = candidate.document.type === "topic"
      ? activeTopicRevisionId(input.database, candidate.document.id) ?? candidate.document.id
      : candidate.document.id;
    return {
      id: candidate.document.id,
      type: candidate.document.type,
      bodyRefId,
      title: candidate.document.title,
      status: candidate.document.status,
      confidence: candidate.document.confidence,
      sourceIds: [...candidate.document.sourceIds],
      tokenCount: candidate.document.tokenCount,
      contentHash: stableHash(candidate.document.content)
    };
  });
  const composition: ContextPacketComposition = {
    version: 1,
    notices: input.notices.map((notice) => ({ ...notice, contentHash: stableHash(notice.text) })),
    evidence,
    recentTurns: input.recentTurns.map((turn) => ({
      id: turn.id,
      role: turn.role,
      turnIndex: turn.turnIndex,
      tokenCount: turn.tokenCount,
      contentHash: stableHash(turn.content)
    }))
  };
  const dependencyIds = [...new Set([
    ...composition.recentTurns.map((turn) => turn.id),
    ...evidence.flatMap((reference) => [reference.id, reference.bodyRefId, ...reference.sourceIds]),
    ...(input.additionalDependencyIds ?? [])
  ])];
  return {
    composition,
    dependencyIds,
    renderedContent: renderUntrustedMemoryContext(input.notices, input.evidence)
  };
}

function bodyForReference(database: ContinuumDatabase, reference: ContextPacketEvidenceReference): string | null {
  if (reference.type === "event") return database.getEvent(reference.bodyRefId)?.content ?? null;
  if (reference.type === "claim") {
    const row = database.connection.prepare("SELECT subject, predicate, value FROM claims WHERE id = ?").get(reference.bodyRefId) as
      | { subject: string; predicate: string; value: string }
      | undefined;
    return row ? `${row.subject} ${row.predicate}: ${row.value}` : null;
  }
  if (reference.type === "topic") {
    const row = database.connection.prepare("SELECT markdown FROM topic_page_revisions WHERE id = ?").get(reference.bodyRefId) as
      | { markdown: string }
      | undefined;
    return row?.markdown ?? null;
  }
  if (reference.type === "chunk") {
    const row = database.connection.prepare("SELECT text_content FROM source_chunks WHERE id = ?").get(reference.bodyRefId) as
      | { text_content: string }
      | undefined;
    return row?.text_content ?? null;
  }
  return null;
}

function isComposition(value: unknown): value is ContextPacketComposition {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ContextPacketComposition>;
  return candidate.version === 1 && Array.isArray(candidate.notices) && Array.isArray(candidate.evidence) && Array.isArray(candidate.recentTurns);
}

export function reconstructStoredContextPacket(
  database: ContinuumDatabase,
  compositionValue: unknown,
  expectedContentHash: string
): ReconstructedContextPacket {
  if (!isComposition(compositionValue)) {
    return {
      renderedContent: null,
      integrity: "legacy",
      unavailableReferenceIds: [],
      expectedContentHash,
      actualContentHash: null
    };
  }
  const unavailableReferenceIds: string[] = [];
  const evidence: RankedCandidate[] = [];
  for (const reference of compositionValue.evidence) {
    const content = bodyForReference(database, reference);
    if (content === null || stableHash(content) !== reference.contentHash) {
      unavailableReferenceIds.push(reference.bodyRefId);
      continue;
    }
    evidence.push({
      id: reference.id,
      type: reference.type,
      title: reference.title,
      excerpt: content,
      lexicalScore: null,
      vectorScore: null,
      graphScore: null,
      temporalScore: null,
      fusedScore: 0,
      rerankScore: null,
      selected: true,
      reason: "Reconstructed from the reference-only context audit record",
      sourceIds: reference.sourceIds,
      document: {
        id: reference.id,
        type: reference.type,
        sourceKind: reference.type === "topic" ? "wiki" : reference.type === "event" || reference.type === "claim" ? "conversation" : "attachment",
        title: reference.title,
        content,
        sourceIds: reference.sourceIds,
        observedAt: "1970-01-01T00:00:00.000Z",
        validFrom: null,
        validTo: null,
        status: reference.status,
        confidence: reference.confidence,
        authority: 0,
        freshnessExpiresAt: null,
        scopeId: "global",
        topicId: null,
        entityNames: [],
        pinned: false,
        embedding: null,
        tokenCount: reference.tokenCount,
        rawSource: reference.type === "event" || reference.type === "chunk"
      },
      componentScores: {},
      componentReasons: [],
      rank: evidence.length + 1
    });
  }
  const notices = compositionValue.notices.filter((notice) => stableHash(notice.text) === notice.contentHash);
  if (notices.length !== compositionValue.notices.length) {
    unavailableReferenceIds.push(...compositionValue.notices
      .filter((notice) => stableHash(notice.text) !== notice.contentHash)
      .map((_, index) => `notice:${index}`));
  }
  if (unavailableReferenceIds.length) {
    return { renderedContent: null, integrity: "unavailable", unavailableReferenceIds, expectedContentHash, actualContentHash: null };
  }
  const renderedContent = renderUntrustedMemoryContext(notices, evidence);
  const actualContentHash = stableHash(renderedContent);
  return {
    renderedContent: actualContentHash === expectedContentHash ? renderedContent : null,
    integrity: actualContentHash === expectedContentHash ? "verified" : "mismatch",
    unavailableReferenceIds: [],
    expectedContentHash,
    actualContentHash
  };
}
