import type { TopicPage } from "@continuum/contracts";

import type {
  CompiledTopicPage,
  EvidenceClaim,
  PageSectionSource,
  TopicParagraph
} from "./types.js";

export class ProvenanceValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Topic-page provenance validation failed: ${errors.join("; ")}`);
    this.name = "ProvenanceValidationError";
  }
}

export interface TopicCompilationInput {
  id: string;
  type: TopicPage["type"];
  title: string;
  tags: string[];
  revision: number;
  updatedAt: string;
  paragraphs: TopicParagraph[];
  claims: EvidenceClaim[];
  previousPage: TopicPage | null;
  /** Hard rendered-character safety ceiling for every automatically active page. */
  maxCharacters?: number;
  relatedPages?: Array<{
    id: string;
    title: string;
    evidenceIds: string[];
  }>;
}

/** Approximately 2,500 tokens under the documented 4-characters/token sizing rule. */
export const MAX_ACTIVE_TOPIC_CHARACTERS = 10_000;
const CHILD_NAVIGATION_HEADROOM = 1_024;

export function slugifyTopic(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 180);
  return slug || "topic";
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function validateParagraphProvenance(
  paragraphs: readonly TopicParagraph[],
  claims: readonly EvidenceClaim[]
): PageSectionSource[] {
  const claimMap = new Map(claims.map((claim) => [claim.id, claim]));
  const errors: string[] = [];
  const seenParagraphIds = new Set<string>();
  const sectionSources: PageSectionSource[] = [];
  for (const paragraph of paragraphs) {
    if (seenParagraphIds.has(paragraph.id)) {
      errors.push(`duplicate paragraph id ${paragraph.id}`);
    }
    seenParagraphIds.add(paragraph.id);
    if (paragraph.factual && paragraph.claimIds.length === 0) {
      errors.push(`factual paragraph ${paragraph.id} has no claim support`);
    }
    const supportedSources = new Set<string>();
    for (const claimId of paragraph.claimIds) {
      const claim = claimMap.get(claimId);
      if (!claim) {
        errors.push(`paragraph ${paragraph.id} references unknown claim ${claimId}`);
        continue;
      }
      for (const sourceId of claim.sourceIds) supportedSources.add(sourceId);
    }
    const sourceIds =
      paragraph.sourceIds.length > 0
        ? paragraph.sourceIds
        : [...supportedSources];
    for (const sourceId of sourceIds) {
      if (!supportedSources.has(sourceId) && paragraph.claimIds.length > 0) {
        errors.push(
          `paragraph ${paragraph.id} source ${sourceId} is not evidence for its claims`
        );
      }
    }
    if (paragraph.factual && sourceIds.length === 0) {
      errors.push(`factual paragraph ${paragraph.id} has no source evidence`);
    }
    sectionSources.push({
      paragraphId: paragraph.id,
      section: paragraph.section,
      claimIds: [...paragraph.claimIds],
      sourceIds
    });
  }
  if (errors.length > 0) throw new ProvenanceValidationError(errors);
  return sectionSources;
}

const SECTION_ORDER: TopicParagraph["section"][] = [
  "summary",
  "current_state",
  "history",
  "related_pages",
  "open_questions",
  "evidence"
];

const SECTION_TITLES: Record<TopicParagraph["section"], string> = {
  summary: "Summary",
  current_state: "Current state",
  history: "History",
  related_pages: "Related pages",
  open_questions: "Open questions",
  evidence: "Evidence"
};

function renderSection(
  section: TopicParagraph["section"],
  paragraphs: readonly TopicParagraph[]
): string {
  const content = paragraphs
    .filter((paragraph) => paragraph.section === section)
    .map((paragraph) => paragraph.markdown.trim())
    .filter(Boolean)
    .join("\n\n");
  return `## ${SECTION_TITLES[section]}\n\n${content || "_None recorded._"}`;
}

function topicLink(label: string, identity: string): string {
  const safeLabel = label.slice(0, 120).replaceAll("[", "\\[").replaceAll("]", "\\]");
  return `[${safeLabel}](continuum://topic/${encodeURIComponent(identity)})`;
}

function renderPage(title: string, paragraphs: readonly TopicParagraph[]): string {
  return [
    `# ${title}`,
    ...SECTION_ORDER.map((section) => renderSection(section, paragraphs))
  ].join("\n\n");
}

function bySection(
  paragraphs: readonly TopicParagraph[],
  section: TopicParagraph["section"]
): string {
  return paragraphs
    .filter((paragraph) => paragraph.section === section)
    .map((paragraph) => paragraph.markdown)
    .join("\n\n");
}

function splitText(text: string, maximum: number): string[] {
  const value = text.trim();
  if (value.length <= maximum) return value ? [value] : [];
  const parts: string[] = [];
  let remaining = value;
  while (remaining.length > maximum) {
    const minimumBreak = Math.floor(maximum * 0.55);
    const candidate = remaining.slice(0, maximum + 1);
    const newline = candidate.lastIndexOf("\n");
    const whitespace = candidate.lastIndexOf(" ");
    const naturalBreak = Math.max(newline >= minimumBreak ? newline : -1, whitespace >= minimumBreak ? whitespace : -1);
    const splitAt = naturalBreak > 0 ? naturalBreak : maximum;
    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function fragmentParagraphs(
  title: string,
  paragraphs: readonly TopicParagraph[],
  maxCharacters: number
): TopicParagraph[] {
  const boundedTitle = title.slice(0, 160);
  const emptyOverhead = renderPage(`${boundedTitle} — Current state 9999`, []).length;
  // Leave room for the bounded parent/previous/next links added after
  // batching. Their labels and Continuum identities can together exceed a
  // few hundred characters on middle shards.
  const contentLimit = Math.max(96, maxCharacters - emptyOverhead - CHILD_NAVIGATION_HEADROOM);
  return paragraphs.flatMap((paragraph) =>
    splitText(paragraph.markdown, contentLimit).map((markdown, index, fragments) => ({
      ...paragraph,
      id: fragments.length === 1 ? paragraph.id : `${paragraph.id}:fragment:${index + 1}`,
      markdown
    }))
  );
}

function compileChildPages(
  input: TopicCompilationInput,
  maxCharacters: number
): CompiledTopicPage["childPages"] {
  const fragments = fragmentParagraphs(input.title, input.paragraphs, maxCharacters);
  const batches: Array<{
    group: string;
    part: number;
    content: TopicParagraph[];
    title: string;
    slug: string;
  }> = [];
  // Shard every rendered section independently. New evidence and newly
  // historical claims then append inside their own section instead of a small
  // summary/current-state edit shifting every later child-page boundary.
  // Section-qualified slugs keep existing topic IDs stable as other sections
  // gain or lose pages.
  const shardGroups: Array<{ key: string; label: string; sections: TopicParagraph["section"][] }> = [
    // Keep the small nonfactual related/open-question sections beside the
    // evidence-backed summary. This avoids creating navigation-only child
    // topics that cannot be invalidated through source provenance.
    { key: "overview", label: "Overview", sections: ["summary", "related_pages", "open_questions"] },
    { key: "current-state", label: SECTION_TITLES.current_state, sections: ["current_state"] },
    { key: "history", label: SECTION_TITLES.history, sections: ["history"] },
    { key: "evidence", label: SECTION_TITLES.evidence, sections: ["evidence"] }
  ];
  for (const group of shardGroups) {
    const sectionFragments = fragments.filter((fragment) => group.sections.includes(fragment.section));
    let content: TopicParagraph[] = [];
    let part = 1;
    const push = () => {
      if (content.length === 0) return;
      batches.push({
        group: group.key,
        part,
        content,
        title: `${input.title.slice(0, 160)} — ${group.label} ${part}`,
        slug: `${input.id}-${group.key}-part-${part}`
      });
      part += 1;
      content = [];
    };
    for (const fragment of sectionFragments) {
      const candidate = [...content, fragment];
      const provisionalTitle = `${input.title.slice(0, 160)} — ${group.label} ${part}`;
      if (content.length > 0 && renderPage(provisionalTitle, candidate).length > maxCharacters - CHILD_NAVIGATION_HEADROOM) push();
      content.push(fragment);
    }
    push();
  }

  // A topic containing only historical claims can have a small overview made
  // solely of "No unresolved questions." Never persist that as an orphanable
  // source-free child: fold it into the first evidence-backed shard. The
  // overview is tiny, and fragmentation above reserves navigation headroom.
  for (let index = batches.length - 1; index >= 0; index -= 1) {
    const batch = batches[index]!;
    if (batch.content.some((paragraph) => paragraph.claimIds.length > 0)) continue;
    const targetIndex = batches.findIndex((candidate, candidateIndex) => candidateIndex !== index
      && candidate.content.some((paragraph) => paragraph.claimIds.length > 0));
    if (targetIndex < 0) continue;
    const target = batches[targetIndex]!;
    const combined = [...batch.content, ...target.content];
    if (renderPage(target.title, combined).length > maxCharacters - 320) continue;
    target.content = combined;
    batches.splice(index, 1);
  }

  return batches.map((batch, index) => {
    const { content, title, slug } = batch;
    const navigation: string[] = [`- Parent: ${topicLink(input.title, input.id)}`];
    const previous = batches[index - 1];
    const next = batches[index + 1];
    if (previous) navigation.push(`- Previous: ${topicLink(previous.title, previous.slug)}`);
    if (next) navigation.push(`- Next: ${topicLink(next.title, next.slug)}`);
    const related: TopicParagraph = {
      id: `${input.id}:${batch.group}:${batch.part}:navigation`,
      section: "related_pages",
      markdown: navigation.join("\n"),
      factual: false,
      claimIds: [],
      sourceIds: []
    };
    const paragraphs = [...content, related];
    const sectionSources = validateParagraphProvenance(paragraphs, input.claims);
    const markdown = renderPage(title, paragraphs);
    if (markdown.length > maxCharacters) {
      throw new Error(`Unable to bound compiled topic child ${batch.group}/${batch.part} to ${maxCharacters} characters`);
    }
    const sourceIds = [...new Set(sectionSources.flatMap((section) => section.sourceIds))];
    return {
      title,
      slug,
      markdown,
      summary: bySection(paragraphs, "summary"),
      currentState: bySection(paragraphs, "current_state"),
      history: bySection(paragraphs, "history"),
      openQuestions: paragraphs.filter((item) => item.section === "open_questions").map((item) => item.markdown),
      paragraphs,
      sectionSources,
      sourceIds,
      evidenceIds: [...new Set(sectionSources.flatMap((section) => [...section.claimIds, ...section.sourceIds]))]
    };
  });
}

function boundedParentIndex(
  input: TopicCompilationInput,
  children: ReadonlyArray<CompiledTopicPage["childPages"][number]>,
  maxCharacters: number
): { markdown: string; paragraphs: TopicParagraph[]; sectionSources: PageSectionSource[] } {
  const indexParagraphs = (visibleChildren: number): TopicParagraph[] => {
    const related = children.slice(0, visibleChildren).map((child, index) => ({
      id: `${input.id}:index:related:${index + 1}`,
      section: "related_pages" as const,
      markdown: `- ${topicLink(child.title, child.slug)}`,
      factual: false,
      claimIds: [...new Set(child.sectionSources.flatMap((source) => source.claimIds))],
      sourceIds: [...new Set(child.sectionSources.flatMap((source) => source.sourceIds))]
    }));
    const remaining = children.length - visibleChildren;
    return [
      { id: `${input.id}:index:summary`, section: "summary", markdown: `This topic is organized into ${children.length} bounded, evidence-linked parts.`, factual: false, claimIds: [], sourceIds: [] },
      { id: `${input.id}:index:current`, section: "current_state", markdown: "Open the linked parts for current facts, history, questions, and exact evidence.", factual: false, claimIds: [], sourceIds: [] },
      ...related,
      ...(remaining > 0 ? [{ id: `${input.id}:index:continuation`, section: "related_pages" as const, markdown: `- Continue through the Next links for ${remaining} additional ${remaining === 1 ? "part" : "parts"}.`, factual: false, claimIds: [], sourceIds: [] }] : [])
    ];
  };
  let visibleChildren = 0;
  for (let index = 0; index < children.length; index += 1) {
    const paragraphs = indexParagraphs(index + 1);
    if (renderPage(input.title.slice(0, 160), paragraphs).length > maxCharacters) break;
    visibleChildren = index + 1;
  }
  const paragraphs = indexParagraphs(visibleChildren);
  const markdown = renderPage(input.title.slice(0, 160), paragraphs);
  if (markdown.length > maxCharacters) throw new Error(`Unable to bound topic index to ${maxCharacters} characters`);
  return { markdown, paragraphs, sectionSources: validateParagraphProvenance(paragraphs, input.claims) };
}

export function compileTopicPage(input: TopicCompilationInput): CompiledTopicPage {
  const claimById = new Map(input.claims.map((claim) => [claim.id, claim]));
  const relatedParagraphs: TopicParagraph[] = (input.relatedPages ?? []).map((related) => {
    const claimIds = related.evidenceIds.filter((id) => claimById.has(id));
    const supportedSources = new Set(claimIds.flatMap((id) => claimById.get(id)?.sourceIds ?? []));
    return {
      id: `${input.id}:related:${related.id}`,
      section: "related_pages",
      markdown: `- ${topicLink(related.title, related.id)}`,
      factual: false,
      claimIds,
      sourceIds: related.evidenceIds.filter((id) => supportedSources.has(id))
    };
  });
  const sourceParagraphs = [...input.paragraphs, ...relatedParagraphs];
  const initialSectionSources = validateParagraphProvenance(sourceParagraphs, input.claims);
  const initialMarkdown = renderPage(input.title.slice(0, 160), sourceParagraphs);
  const maxCharacters = input.maxCharacters ?? MAX_ACTIVE_TOPIC_CHARACTERS;
  const childPages = initialMarkdown.length > maxCharacters
    ? compileChildPages({ ...input, paragraphs: sourceParagraphs }, maxCharacters)
    : [];
  const parent = childPages.length > 0
    ? boundedParentIndex(input, childPages, maxCharacters)
    : { markdown: initialMarkdown, paragraphs: sourceParagraphs, sectionSources: initialSectionSources };
  const sourceIds = [...new Set(parent.sectionSources.flatMap((section) => section.sourceIds))];
  const page: TopicPage = {
    id: input.id,
    type: input.type,
    title: input.title,
    slug: `${input.id}-${slugifyTopic(input.title)}`,
    summary: bySection(parent.paragraphs, "summary"),
    currentState: bySection(parent.paragraphs, "current_state"),
    history: bySection(parent.paragraphs, "history"),
    openQuestions: parent.paragraphs
      .filter((paragraph) => paragraph.section === "open_questions")
      .map((paragraph) => paragraph.markdown),
    tags: [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))],
    sourceIds,
    revision: input.revision,
    userAuthored: false,
    updatedAt: input.updatedAt
  };
  return {
    page,
    markdown: parent.markdown,
    paragraphs: parent.paragraphs.map((paragraph) => ({ ...paragraph })),
    sectionSources: parent.sectionSources,
    activation: input.previousPage?.userAuthored ? "proposal" : "activate",
    childPages
  };
}
