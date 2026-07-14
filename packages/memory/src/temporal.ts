import type {
  ClaimRelation,
  EvidenceClaim
} from "./types.js";

export type TemporalIntent = "current" | "historical" | "all";

export type FreshnessClass =
  | "rapidly_changing"
  | "news_or_product_state"
  | "ordinary_web_fact"
  | "timeless";

const FRESHNESS_MS: Record<Exclude<FreshnessClass, "timeless">, number> = {
  rapidly_changing: 24 * 60 * 60 * 1_000,
  news_or_product_state: 7 * 24 * 60 * 60 * 1_000,
  ordinary_web_fact: 30 * 24 * 60 * 60 * 1_000
};

export function freshnessExpiry(
  observedAt: string,
  freshnessClass: FreshnessClass
): string | null {
  if (freshnessClass === "timeless") return null;
  const timestamp = Date.parse(observedAt);
  if (!Number.isFinite(timestamp)) throw new Error("Invalid freshness observation timestamp");
  return new Date(timestamp + FRESHNESS_MS[freshnessClass]).toISOString();
}

export interface ClaimReconciliation {
  claims: EvidenceClaim[];
  relations: ClaimRelation[];
  currentClaimIds: string[];
  outcome: "inserted" | "duplicate" | "superseded" | "conflicted" | "historical";
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function sameSlot(a: EvidenceClaim, b: EvidenceClaim): boolean {
  return (
    a.topicId === b.topicId &&
    normalize(a.subject) === normalize(b.subject) &&
    normalize(a.predicate) === normalize(b.predicate)
  );
}

function sameValue(a: EvidenceClaim, b: EvidenceClaim): boolean {
  return normalize(a.value) === normalize(b.value);
}

function authority(claim: EvidenceClaim): number {
  if (claim.sourceRole === "user" && claim.explicitCorrection) return 500;
  if (claim.sourceRole === "user") return 400;
  if (claim.sourceRole === "tool") return 300;
  if (claim.sourceRole === "system") return 250;
  return 100;
}

function timeOf(claim: EvidenceClaim): number {
  return Date.parse(claim.validFrom ?? claim.observedAt);
}

function isHistoricalOnArrival(claim: EvidenceClaim, now: string): boolean {
  return (
    claim.status === "historical" ||
    (claim.validTo !== null && Date.parse(claim.validTo) <= Date.parse(now))
  );
}

function withStatus(
  claim: EvidenceClaim,
  status: EvidenceClaim["status"],
  validTo: string | null = claim.validTo
): EvidenceClaim {
  return { ...claim, status, validTo };
}

function relation(
  from: EvidenceClaim,
  to: EvidenceClaim,
  type: ClaimRelation["type"],
  reason: string,
  now: string
): ClaimRelation {
  return {
    fromClaimId: from.id,
    toClaimId: to.id,
    type,
    reason,
    createdAt: now
  };
}

/**
 * Reconciles one append-only claim against the active ledger. No evidence is
 * removed: older values transition to superseded/historical states and remain
 * queryable.
 */
export function reconcileClaim(
  existing: readonly EvidenceClaim[],
  incoming: EvidenceClaim,
  now = incoming.recordedAt
): ClaimReconciliation {
  const relevant = existing.filter(
    (claim) =>
      sameSlot(claim, incoming) &&
      (claim.status === "current" || claim.status === "conflicted")
  );
  if (isHistoricalOnArrival(incoming, now)) {
    const stored = withStatus(incoming, "historical");
    return {
      claims: [...existing, stored],
      relations: [],
      currentClaimIds: relevant
        .filter((claim) => claim.status === "current")
        .map((claim) => claim.id),
      outcome: "historical"
    };
  }

  const duplicate = relevant.find((claim) => sameValue(claim, incoming));
  if (duplicate) {
    const stored = withStatus(incoming, "historical");
    return {
      claims: [...existing, stored],
      relations: [
        relation(stored, duplicate, "duplicate_of", "Normalized values match", now),
        relation(stored, duplicate, "supports", "Independent supporting evidence", now)
      ],
      currentClaimIds: relevant
        .filter((claim) => claim.status === "current")
        .map((claim) => claim.id),
      outcome: "duplicate"
    };
  }

  if (relevant.length === 0) {
    const status: EvidenceClaim["status"] =
      incoming.freshnessExpiresAt !== null &&
      Date.parse(incoming.freshnessExpiresAt) <= Date.parse(now)
        ? "expired"
        : "current";
    const stored = withStatus(incoming, status);
    return {
      claims: [...existing, stored],
      relations: [],
      currentClaimIds: status === "current" ? [stored.id] : [],
      outcome: "inserted"
    };
  }

  const newestRelevant = [...relevant].sort((a, b) => timeOf(b) - timeOf(a))[0]!;
  const incomingDominates =
    incoming.explicitCorrection ||
    (timeOf(incoming) > timeOf(newestRelevant) &&
      authority(incoming) >= authority(newestRelevant));

  if (incomingDominates) {
    const cutoff = incoming.validFrom ?? incoming.observedAt;
    const changed = existing.map((claim) =>
      relevant.some((active) => active.id === claim.id)
        ? withStatus(claim, "superseded", claim.validTo ?? cutoff)
        : claim
    );
    const stored = withStatus(incoming, "current");
    return {
      claims: [...changed, stored],
      relations: relevant.flatMap((claim) => [
        relation(stored, claim, "supersedes", "Newer authoritative statement", now),
        relation(stored, claim, "contradicts", "Values differ for the same temporal slot", now)
      ]),
      currentClaimIds: [stored.id],
      outcome: "superseded"
    };
  }

  // A lower-authority source cannot silently replace explicit user memory.
  if (authority(incoming) < authority(newestRelevant)) {
    const stored = withStatus(incoming, "conflicted");
    return {
      claims: [...existing, stored],
      relations: [
        relation(stored, newestRelevant, "contradicts", "Lower-authority conflicting evidence", now)
      ],
      currentClaimIds: relevant
        .filter((claim) => claim.status === "current")
        .map((claim) => claim.id),
      outcome: "conflicted"
    };
  }

  // Neither side dominates (for example simultaneous user statements).
  const changed = existing.map((claim) =>
    relevant.some((active) => active.id === claim.id)
      ? withStatus(claim, "conflicted")
      : claim
  );
  const stored = withStatus(incoming, "conflicted");
  return {
    claims: [...changed, stored],
    relations: relevant.map((claim) =>
      relation(stored, claim, "contradicts", "Unresolved evidence conflict", now)
    ),
    currentClaimIds: [],
    outcome: "conflicted"
  };
}

export function applyFreshness(
  claims: readonly EvidenceClaim[],
  now: string
): EvidenceClaim[] {
  const timestamp = Date.parse(now);
  return claims.map((claim) =>
    claim.status === "current" &&
    claim.freshnessExpiresAt !== null &&
    Date.parse(claim.freshnessExpiresAt) <= timestamp
      ? withStatus(claim, "expired")
      : claim
  );
}

export function selectClaimsForIntent(
  claims: readonly EvidenceClaim[],
  intent: TemporalIntent,
  now: string
): EvidenceClaim[] {
  const refreshed = applyFreshness(claims, now);
  if (intent === "all") return refreshed;
  if (intent === "current") {
    return refreshed.filter(
      (claim) => claim.status === "current" || claim.status === "conflicted"
    );
  }
  return refreshed.filter((claim) => claim.status !== "current");
}

export interface ProvenanceRemoval {
  retained: EvidenceClaim | null;
  removedClaim: boolean;
  removedSourceIds: string[];
}

export function removeClaimProvenance(
  claim: EvidenceClaim,
  sourceIds: ReadonlySet<string>
): ProvenanceRemoval {
  const retainedSources = claim.sourceIds.filter((id) => !sourceIds.has(id));
  const removedSourceIds = claim.sourceIds.filter((id) => sourceIds.has(id));
  return {
    retained:
      retainedSources.length > 0 ? { ...claim, sourceIds: retainedSources } : null,
    removedClaim: retainedSources.length === 0,
    removedSourceIds
  };
}
