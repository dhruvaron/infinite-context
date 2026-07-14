import type {
  Claim,
  ConversationEvent,
  TopicPage
} from "@continuum/contracts";

export type SourceKind =
  | "conversation"
  | "attachment"
  | "workspace"
  | "web"
  | "tool";

/**
 * The canonical Claim contract plus compilation-only metadata. These fields are
 * deliberately explicit so temporal reconciliation is deterministic and can be
 * replayed without consulting a model.
 */
export interface EvidenceClaim extends Claim {
  recordedAt: string;
  sourceKind: SourceKind;
  explicitCorrection: boolean;
  attributedTo: string | null;
  extractionVersion: string;
}

export type ClaimRelationType =
  | "supports"
  | "contradicts"
  | "refines"
  | "supersedes"
  | "derived_from"
  | "duplicate_of";

export interface ClaimRelation {
  fromClaimId: string;
  toClaimId: string;
  type: ClaimRelationType;
  reason: string;
  createdAt: string;
}

export interface EntityRecord {
  id: string;
  type: TopicPage["type"];
  displayName: string;
  aliases: string[];
  status: "active" | "merged";
  canonicalId: string | null;
  revision: number;
  sourceIds: string[];
}

export interface EntityMention {
  mentionId: string;
  displayName: string;
  type: TopicPage["type"];
  aliases: string[];
  confidence: number;
  sourceIds: string[];
}

export interface GraphRelationDelta {
  sourceMentionId: string;
  targetMentionId: string;
  type: string;
  confidence: number;
  sourceIds: string[];
  validFrom: string | null;
  validTo: string | null;
}

export interface ExtractionContext {
  events: ConversationEvent[];
  relevantClaims: EvidenceClaim[];
  relevantPages: TopicPage[];
  extractionVersion: string;
  promptVersion: string;
}

export interface ExtractionTrace {
  promptVersion: string;
  schemaVersion: string;
  providerModel: string;
  inputEventIds: string[];
  warnings: string[];
}

export interface MemoryDelta {
  entities: EntityMention[];
  claims: EvidenceClaim[];
  relations: GraphRelationDelta[];
  affectedTopicHints: string[];
  trace: ExtractionTrace;
}

export interface TopicParagraph {
  id: string;
  section:
    | "summary"
    | "current_state"
    | "history"
    | "related_pages"
    | "open_questions"
    | "evidence";
  markdown: string;
  factual: boolean;
  claimIds: string[];
  sourceIds: string[];
}

export interface PageSectionSource {
  paragraphId: string;
  section: TopicParagraph["section"];
  claimIds: string[];
  sourceIds: string[];
}

export interface CompiledTopicPage {
  page: TopicPage;
  markdown: string;
  paragraphs: TopicParagraph[];
  sectionSources: PageSectionSource[];
  activation: "activate" | "proposal";
  /**
   * Bounded, fully-rendered child pages used when the source material cannot
   * fit in the parent.  The worker gives each slug a stable topic identity and
   * activates the complete set atomically with the bounded parent index.
   */
  childPages: Array<{
    title: string;
    slug: string;
    markdown: string;
    summary: string;
    currentState: string;
    history: string;
    openQuestions: string[];
    paragraphs: TopicParagraph[];
    sectionSources: PageSectionSource[];
    sourceIds: string[];
    evidenceIds: string[];
  }>;
}

export interface MemoryModelUsage {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}
