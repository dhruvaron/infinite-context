import type {
  CandidateChannel,
  CandidateDocument,
  CandidateRankings,
  CandidateSignal,
  QueryClassification,
  RetrievalFeatureFlags
} from "./types.js";

export interface CandidateGenerationRequest {
  query: string;
  queryEmbedding: number[] | null;
  queryEmbeddingModelId: string | null;
  classification: QueryClassification;
  now: string;
  scopeId: string;
  activeTopicIds: string[];
  limitPerChannel: number;
}

export interface CandidateIndex {
  lexical(request: CandidateGenerationRequest): Promise<CandidateSignal[]>;
  vector(request: CandidateGenerationRequest): Promise<CandidateSignal[]>;
  recency(request: CandidateGenerationRequest): Promise<CandidateSignal[]>;
  entity(request: CandidateGenerationRequest): Promise<CandidateSignal[]>;
  activeTopic(request: CandidateGenerationRequest): Promise<CandidateSignal[]>;
  pinned(request: CandidateGenerationRequest): Promise<CandidateSignal[]>;
  temporal(request: CandidateGenerationRequest): Promise<CandidateSignal[]>;
}

export function tokenize(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((token) => token.length > 1);
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let index = 0; index < a.length; index += 1) {
    const av = a[index]!;
    const bv = b[index]!;
    dot += av * bv;
    left += av * av;
    right += bv * bv;
  }
  if (left === 0 || right === 0) return 0;
  return dot / Math.sqrt(left * right);
}

function signal(
  document: CandidateDocument,
  channel: CandidateChannel,
  score: number,
  reason: string
): CandidateSignal {
  return { document, channel, score, reason };
}

function top(
  values: CandidateSignal[],
  limit: number
): CandidateSignal[] {
  return values
    .filter((value) => Number.isFinite(value.score) && value.score > 0)
    .sort((a, b) => b.score - a.score || a.document.id.localeCompare(b.document.id))
    .slice(0, limit);
}

/**
 * Deterministic in-memory implementation used by unit tests, demo fixtures, and
 * sqlite-vec degraded mode. Database implementations can implement CandidateIndex
 * directly while retaining the same fusion semantics.
 */
export class InMemoryCandidateIndex implements CandidateIndex {
  constructor(private readonly documents: readonly CandidateDocument[]) {}

  private scoped(request: CandidateGenerationRequest): CandidateDocument[] {
    return this.documents.filter(
      (document) =>
        document.scopeId === request.scopeId &&
        (request.classification.requestedSourceTypes.length === 0 ||
          request.classification.requestedSourceTypes.includes(document.type) ||
          request.classification.requestedSourceTypes.includes(document.sourceKind))
    );
  }

  async lexical(request: CandidateGenerationRequest): Promise<CandidateSignal[]> {
    const queryTokens = new Set(tokenize(request.query));
    const documents = this.scoped(request);
    const documentFrequency = new Map<string, number>();
    for (const document of documents) {
      for (const token of new Set(tokenize(`${document.title} ${document.content}`))) {
        documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
      }
    }
    const results = documents.map((document) => {
      const tokens = tokenize(`${document.title} ${document.content}`);
      const counts = new Map<string, number>();
      for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
      let score = 0;
      for (const token of queryTokens) {
        const frequency = counts.get(token) ?? 0;
        if (frequency === 0) continue;
        const idf = Math.log(1 + documents.length / (1 + (documentFrequency.get(token) ?? 0)));
        score += (frequency / (frequency + 1.2)) * idf;
      }
      return signal(document, "lexical", score, "FTS-compatible lexical match");
    });
    return top(results, request.limitPerChannel);
  }

  async vector(request: CandidateGenerationRequest): Promise<CandidateSignal[]> {
    if (request.queryEmbedding === null || request.queryEmbeddingModelId === null) return [];
    return top(
      this.scoped(request).map((document) =>
        signal(
          document,
          "vector",
          document.embedding === null
            ? 0
            : Math.max(0, cosineSimilarity(request.queryEmbedding!, document.embedding)),
          "embedding cosine similarity"
        )
      ),
      request.limitPerChannel
    );
  }

  async recency(request: CandidateGenerationRequest): Promise<CandidateSignal[]> {
    const now = Date.parse(request.now);
    return top(
      this.scoped(request).map((document) => {
        const days = Math.max(0, now - Date.parse(document.observedAt)) / 86_400_000;
        return signal(document, "recency", Math.exp(-days / 30), "recency decay");
      }),
      request.limitPerChannel
    );
  }

  async entity(request: CandidateGenerationRequest): Promise<CandidateSignal[]> {
    const wanted = request.classification.entities.map((name) => name.toLocaleLowerCase());
    if (wanted.length === 0) return [];
    return top(
      this.scoped(request).map((document) => {
        const names = document.entityNames.map((name) => name.toLocaleLowerCase());
        const matched = wanted.filter((entity) =>
          names.some((name) => name.includes(entity) || entity.includes(name))
        ).length;
        return signal(
          document,
          "entity",
          matched / wanted.length,
          `matched ${matched}/${wanted.length} query entities`
        );
      }),
      request.limitPerChannel
    );
  }

  async activeTopic(request: CandidateGenerationRequest): Promise<CandidateSignal[]> {
    const active = new Set(request.activeTopicIds);
    return top(
      this.scoped(request).map((document) =>
        signal(
          document,
          "active_topic",
          document.topicId !== null && active.has(document.topicId) ? 1 : 0,
          "active conversation topic"
        )
      ),
      request.limitPerChannel
    );
  }

  async pinned(request: CandidateGenerationRequest): Promise<CandidateSignal[]> {
    return top(
      this.scoped(request).map((document) =>
        signal(document, "pinned", document.pinned ? 1 : 0, "user-pinned memory")
      ),
      request.limitPerChannel
    );
  }

  async temporal(request: CandidateGenerationRequest): Promise<CandidateSignal[]> {
    const intent = request.classification.timeIntent;
    if (intent === "unspecified") return [];
    return top(
      this.scoped(request).map((document) => {
        let score = 0;
        if (intent === "current") {
          score = document.status === "current" ? 1 : document.status === "conflicted" ? 0.65 : 0;
        } else if (intent === "range" && request.classification.dateRange !== null) {
          const rangeStart = Date.parse(
            request.classification.dateRange.from ?? "0000-01-01T00:00:00.000Z"
          );
          const rangeEnd = Date.parse(
            request.classification.dateRange.to ?? "9999-12-31T23:59:59.999Z"
          );
          const documentStart = Date.parse(document.validFrom ?? document.observedAt);
          const documentEnd = Date.parse(document.validTo ?? document.observedAt);
          score = documentStart <= rangeEnd && documentEnd >= rangeStart ? 1 : 0;
        } else {
          score =
            document.status === "historical" || document.status === "superseded"
              ? 1
              : document.validFrom !== null || document.validTo !== null
                ? 0.65
                : 0;
        }
        return signal(document, "temporal", score, `${intent} temporal intent`);
      }),
      request.limitPerChannel
    );
  }
}

export async function generateCandidateRankings(
  index: CandidateIndex,
  request: CandidateGenerationRequest,
  flags: RetrievalFeatureFlags
): Promise<CandidateRankings> {
  const tasks: Array<Promise<[CandidateChannel, CandidateSignal[]]>> = [];
  const add = (
    enabled: boolean,
    channel: CandidateChannel,
    work: () => Promise<CandidateSignal[]>
  ): void => {
    if (enabled) {
      tasks.push(
        work().then((values) => [
          channel,
          flags.topicPages
            ? values
            : values.filter((value) => value.document.type !== "topic")
        ])
      );
    }
  };
  add(flags.lexical, "lexical", () => index.lexical(request));
  add(
    flags.vector && request.queryEmbedding !== null && request.queryEmbeddingModelId !== null,
    "vector",
    () => index.vector(request)
  );
  add(flags.recency, "recency", () => index.recency(request));
  add(flags.entity, "entity", () => index.entity(request));
  add(flags.activeTopic, "active_topic", () => index.activeTopic(request));
  add(flags.pinned, "pinned", () => index.pinned(request));
  add(flags.temporal, "temporal", () => index.temporal(request));
  return Object.fromEntries(await Promise.all(tasks)) as CandidateRankings;
}
