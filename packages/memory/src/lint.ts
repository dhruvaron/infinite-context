import type { GraphEdge, TopicPage } from "@continuum/contracts";

import { MAX_ACTIVE_TOPIC_CHARACTERS } from "./topic-compiler.js";
import type {
  EntityRecord,
  EvidenceClaim,
  PageSectionSource
} from "./types.js";

export type LintIssueType =
  | "contradiction"
  | "stale_claim"
  | "unsupported_paragraph"
  | "orphan_page"
  | "broken_link"
  | "duplicate_page"
  | "duplicate_entity"
  | "duplicate_claim"
  | "oversized_page"
  | "extraction_failure";

export interface LintIssue {
  id: string;
  type: LintIssueType;
  severity: "info" | "warning" | "error";
  targetIds: string[];
  message: string;
  autoRepairable: boolean;
}

export interface LintInput {
  now: string;
  pages: TopicPage[];
  pageMarkdown: ReadonlyMap<string, string>;
  sectionSources: PageSectionSource[];
  claims: EvidenceClaim[];
  entities: EntityRecord[];
  edges: GraphEdge[];
  extractionFailures: Array<{ id: string; message: string }>;
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function issue(
  type: LintIssueType,
  severity: LintIssue["severity"],
  targetIds: string[],
  message: string,
  autoRepairable: boolean
): LintIssue {
  return {
    id: `${type}:${targetIds.slice().sort().join(":")}`,
    type,
    severity,
    targetIds,
    message,
    autoRepairable
  };
}

export function runMemoryLint(input: LintInput): LintIssue[] {
  const issues: LintIssue[] = [];
  const claimGroups = new Map<string, EvidenceClaim[]>();
  for (const claim of input.claims) {
    const slot = `${claim.topicId ?? "global"}|${normalized(claim.subject)}|${normalized(claim.predicate)}`;
    const group = claimGroups.get(slot) ?? [];
    group.push(claim);
    claimGroups.set(slot, group);
    if (
      claim.status === "current" &&
      claim.freshnessExpiresAt !== null &&
      Date.parse(claim.freshnessExpiresAt) <= Date.parse(input.now)
    ) {
      issues.push(
        issue("stale_claim", "warning", [claim.id], "Current external claim is stale", false)
      );
    }
    if (claim.sourceIds.length === 0) {
      issues.push(
        issue("unsupported_paragraph", "error", [claim.id], "Claim has no evidence", false)
      );
    }
  }
  for (const group of claimGroups.values()) {
    const current = group.filter(
      (claim) => claim.status === "current" || claim.status === "conflicted"
    );
    const values = new Set(current.map((claim) => normalized(claim.value)));
    if (values.size > 1) {
      issues.push(
        issue(
          "contradiction",
          "warning",
          current.map((claim) => claim.id),
          "Multiple active values occupy the same claim slot",
          false
        )
      );
    }
    const byValue = new Map<string, EvidenceClaim[]>();
    for (const claim of group) {
      // Automatic consolidation is deliberately stricter than contradiction
      // detection: every stored semantic field must match exactly. Merely
      // similar/case-folded values remain review-only.
      const exactKey = JSON.stringify({
        subject: claim.subject,
        predicate: claim.predicate,
        value: claim.value,
        confidence: claim.confidence,
        sourceRole: claim.sourceRole,
        status: claim.status,
        validFrom: claim.validFrom,
        validTo: claim.validTo,
        observedAt: claim.observedAt,
        freshnessExpiresAt: claim.freshnessExpiresAt,
        extractionVersion: claim.extractionVersion
      });
      const claims = byValue.get(exactKey) ?? [];
      claims.push(claim);
      byValue.set(exactKey, claims);
    }
    for (const duplicates of byValue.values()) {
      if (duplicates.length > 1) {
        issues.push(
          issue(
            "duplicate_claim",
            "info",
            duplicates.map((claim) => claim.id),
            "Exact normalized duplicate claims can be linked",
            true
          )
        );
      }
    }
  }

  const pageIds = new Set(input.pages.map((page) => page.id));
  const linkedPageIds = new Set(
    input.edges.flatMap((edge) => [edge.source, edge.target]).filter((id) => pageIds.has(id))
  );
  for (const page of input.pages) {
    if (page.sourceIds.length === 0 && !linkedPageIds.has(page.id)) {
      issues.push(issue("orphan_page", "warning", [page.id], "Page has no evidence or links", false));
    }
    const markdown = input.pageMarkdown.get(page.id) ?? "";
    if (markdown.length > MAX_ACTIVE_TOPIC_CHARACTERS) {
      issues.push(issue("oversized_page", "warning", [page.id], "Page exceeds the approximately 2,500-token rendered-page ceiling", false));
    }
  }
  const exactPageGroups = new Map<string, TopicPage[]>();
  for (const page of input.pages) {
    const markdown = input.pageMarkdown.get(page.id);
    if (markdown === undefined) continue;
    const key = `${page.type}\u0000${markdown}`;
    const pages = exactPageGroups.get(key) ?? [];
    pages.push(page);
    exactPageGroups.set(key, pages);
  }
  for (const duplicates of exactPageGroups.values()) {
    if (duplicates.length < 2) continue;
    issues.push(issue(
      "duplicate_page",
      "info",
      duplicates.map((page) => page.id),
      "Byte-identical active topic pages can be consolidated without semantic judgment",
      true
    ));
  }
  for (const edge of input.edges) {
    if (!pageIds.has(edge.source) || !pageIds.has(edge.target)) {
      issues.push(
        issue("broken_link", "warning", [edge.id], "Page link references a missing page", true)
      );
    }
  }
  const entityGroups = new Map<string, EntityRecord[]>();
  for (const entity of input.entities.filter((item) => item.status === "active")) {
    const key = `${entity.type}:${normalized(entity.displayName)}`;
    const entities = entityGroups.get(key) ?? [];
    entities.push(entity);
    entityGroups.set(key, entities);
  }
  for (const duplicates of entityGroups.values()) {
    if (duplicates.length > 1) {
      issues.push(
        issue(
          "duplicate_entity",
          "warning",
          duplicates.map((entity) => entity.id),
          "Entities share an exact normalized name and type",
          false
        )
      );
    }
  }
  const supportedParagraphs = new Set(
    input.sectionSources
      .filter((source) => source.claimIds.length > 0 && source.sourceIds.length > 0)
      .map((source) => source.paragraphId)
  );
  for (const source of input.sectionSources) {
    if (source.section !== "open_questions" && !supportedParagraphs.has(source.paragraphId)) {
      issues.push(
        issue(
          "unsupported_paragraph",
          "error",
          [source.paragraphId],
          "Factual page paragraph lacks claim/source provenance",
          false
        )
      );
    }
  }
  for (const failure of input.extractionFailures) {
    issues.push(issue("extraction_failure", "error", [failure.id], failure.message, false));
  }
  return issues.sort((a, b) => a.id.localeCompare(b.id));
}

const FIVE_MINUTES_MS = 5 * 60 * 1_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1_000;

export function shouldRunIdleLint(input: {
  now: string;
  lastActivityAt: string;
  lastLintAt: string | null;
  manual: boolean;
}): boolean {
  if (input.manual) return true;
  const now = Date.parse(input.now);
  if (now - Date.parse(input.lastActivityAt) < FIVE_MINUTES_MS) return false;
  return input.lastLintAt === null || now - Date.parse(input.lastLintAt) >= ONE_DAY_MS;
}

export interface SafeRepairPlan {
  brokenEdgeIds: string[];
  duplicateClaimGroups: string[][];
  duplicatePageGroups: string[][];
}

export function planSafeLintRepairs(issues: readonly LintIssue[]): SafeRepairPlan {
  return {
    brokenEdgeIds: issues
      .filter((item) => item.type === "broken_link" && item.autoRepairable)
      .flatMap((item) => item.targetIds),
    duplicateClaimGroups: issues
      .filter((item) => item.type === "duplicate_claim" && item.autoRepairable)
      .map((item) => [...item.targetIds].sort()),
    duplicatePageGroups: issues
      .filter((item) => item.type === "duplicate_page" && item.autoRepairable)
      .map((item) => [...item.targetIds].sort())
  };
}
