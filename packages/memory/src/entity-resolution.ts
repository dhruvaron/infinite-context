import type {
  EntityMention,
  EntityRecord
} from "./types.js";

export interface MergeProposal {
  mentionId: string;
  candidateEntityId: string;
  score: number;
  reasons: string[];
  requiresConfirmation: boolean;
}

export type EntityResolution =
  | { action: "link"; entityId: string; score: number; reasons: string[] }
  | { action: "auto_merge"; entityId: string; score: number; reasons: string[] }
  | { action: "propose_merge"; proposal: MergeProposal }
  | { action: "create"; score: number; reasons: string[] };

export interface EntityResolutionOptions {
  autoMergeThreshold: number;
  proposalThreshold: number;
}

export interface EntityResolutionSignals {
  /** Semantic similarity from evidence associated with the mention and entity. */
  vectorSimilarity?: (mention: EntityMention, entity: EntityRecord) => number | null | undefined;
  /** Overlap between entities surrounding the mention and the entity's existing neighbors. */
  graphContextSimilarity?: (mention: EntityMention, entity: EntityRecord) => number | null | undefined;
}

const DEFAULT_OPTIONS: EntityResolutionOptions = {
  autoMergeThreshold: 0.94,
  proposalThreshold: 0.76
};

export function normalizeEntityName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function bigrams(value: string): Set<string> {
  const padded = ` ${normalizeEntityName(value)} `;
  const result = new Set<string>();
  for (let index = 0; index < padded.length - 1; index += 1) {
    result.add(padded.slice(index, index + 2));
  }
  return result;
}

function diceSimilarity(a: string, b: string): number {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 && right.size === 0) return 1;
  let overlap = 0;
  for (const token of left) if (right.has(token)) overlap += 1;
  return (2 * overlap) / (left.size + right.size);
}

function initials(value: string): string {
  return normalizeEntityName(value)
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .join("");
}

function scoreMention(
  mention: EntityMention,
  entity: EntityRecord,
  signals?: EntityResolutionSignals
): { score: number; lexicalScore: number; exactAlias: boolean; autoMergeSupported: boolean; reasons: string[] } {
  if (entity.status !== "active" || entity.type !== mention.type) {
    return { score: 0, lexicalScore: 0, exactAlias: false, autoMergeSupported: false, reasons: ["type or lifecycle mismatch"] };
  }
  const mentionNames = [mention.displayName, ...mention.aliases];
  const entityNames = [entity.displayName, ...entity.aliases];
  let best = 0;
  const reasons: string[] = [];
  for (const left of mentionNames) {
    for (const right of entityNames) {
      if (normalizeEntityName(left) === normalizeEntityName(right)) {
        return { score: 1, lexicalScore: 1, exactAlias: true, autoMergeSupported: true, reasons: ["exact normalized alias"] };
      }
      const lexical = diceSimilarity(left, right);
      if (lexical > best) best = lexical;
      if (
        initials(left).length >= 2 &&
        initials(left) === normalizeEntityName(right).replace(/ /g, "")
      ) {
        best = Math.max(best, 0.9);
        reasons.push("acronym match");
      }
    }
  }
  const lexicalScore = best * mention.confidence;
  if (best > 0) reasons.push(`lexical similarity ${best.toFixed(3)}`);
  const bounded = (value: number | null | undefined): number | null => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null;
  const vector = bounded(signals?.vectorSimilarity?.(mention, entity));
  const graph = bounded(signals?.graphContextSimilarity?.(mention, entity));
  if (vector !== null) reasons.push(`vector similarity ${vector.toFixed(3)}`);
  if (graph !== null) reasons.push(`graph-context similarity ${graph.toFixed(3)}`);
  let weighted = best * 0.65;
  let weight = 0.65;
  if (vector !== null) { weighted += vector * 0.25; weight += 0.25; }
  if (graph !== null) { weighted += graph * 0.1; weight += 0.1; }
  const score = (weighted / weight) * mention.confidence;
  // Semantic and graph context can promote an ambiguous alias to review, but
  // can never turn a weak lexical match into a silent merge.
  const autoMergeSupported = (vector !== null || graph !== null)
    && (vector === null || vector >= 0.8)
    && (graph === null || graph >= 0.5);
  return { score, lexicalScore, exactAlias: false, autoMergeSupported, reasons };
}

export function resolveEntity(
  mention: EntityMention,
  entities: readonly EntityRecord[],
  options: EntityResolutionOptions = DEFAULT_OPTIONS,
  signals?: EntityResolutionSignals
): EntityResolution {
  const ranked = entities
    .map((entity) => ({ entity, ...scoreMention(mention, entity, signals) }))
    .sort((a, b) => b.score - a.score || a.entity.id.localeCompare(b.entity.id));
  const best = ranked[0];
  if (!best || best.score < options.proposalThreshold) {
    return { action: "create", score: best?.score ?? 0, reasons: best?.reasons ?? [] };
  }
  if (best.exactAlias) {
    return {
      action: "link",
      entityId: best.entity.id,
      score: best.score,
      reasons: best.reasons
    };
  }
  if (best.score >= options.autoMergeThreshold && best.lexicalScore >= options.autoMergeThreshold && best.autoMergeSupported) {
    return {
      action: "auto_merge",
      entityId: best.entity.id,
      score: best.score,
      reasons: best.reasons
    };
  }
  return {
    action: "propose_merge",
    proposal: {
      mentionId: mention.mentionId,
      candidateEntityId: best.entity.id,
      score: best.score,
      reasons: best.reasons,
      requiresConfirmation: true
    }
  };
}

export interface MergeHistoryRecord {
  id: string;
  primaryBefore: EntityRecord;
  secondaryBefore: EntityRecord;
  primaryAfter: EntityRecord;
  secondaryAfter: EntityRecord;
  expectedPrimaryRevision: number;
  expectedSecondaryRevision: number;
}

export function mergeEntities(
  id: string,
  primary: EntityRecord,
  secondary: EntityRecord
): MergeHistoryRecord {
  if (primary.id === secondary.id) throw new Error("Cannot merge an entity into itself");
  if (primary.type !== secondary.type) throw new Error("Cannot merge different entity types");
  if (primary.status !== "active" || secondary.status !== "active") {
    throw new Error("Only active entities can be merged");
  }
  const aliases = [...new Set([
    ...primary.aliases,
    secondary.displayName,
    ...secondary.aliases
  ])];
  const primaryAfter: EntityRecord = {
    ...primary,
    aliases,
    sourceIds: [...new Set([...primary.sourceIds, ...secondary.sourceIds])],
    revision: primary.revision + 1
  };
  const secondaryAfter: EntityRecord = {
    ...secondary,
    status: "merged",
    canonicalId: primary.id,
    revision: secondary.revision + 1
  };
  return {
    id,
    primaryBefore: structuredClone(primary),
    secondaryBefore: structuredClone(secondary),
    primaryAfter,
    secondaryAfter,
    expectedPrimaryRevision: primaryAfter.revision,
    expectedSecondaryRevision: secondaryAfter.revision
  };
}

export function reverseEntityMerge(
  record: MergeHistoryRecord,
  currentPrimary: EntityRecord,
  currentSecondary: EntityRecord
): [EntityRecord, EntityRecord] {
  if (
    currentPrimary.revision !== record.expectedPrimaryRevision ||
    currentSecondary.revision !== record.expectedSecondaryRevision
  ) {
    throw new Error("Merge cannot be reversed after concurrent entity changes");
  }
  return [
    { ...structuredClone(record.primaryBefore), revision: currentPrimary.revision + 1 },
    { ...structuredClone(record.secondaryBefore), revision: currentSecondary.revision + 1 }
  ];
}
