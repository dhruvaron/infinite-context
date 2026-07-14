import type {
  QueryClass,
  QueryClassification,
  TimeIntent
} from "./types.js";

export interface QueryClassifierFallback {
  classify(query: string): Promise<
    Omit<QueryClassification, "usedModelFallback" | "dateRange"> & {
      dateRange?: QueryClassification["dateRange"];
    }
  >;
}

const CUES: Array<{ type: QueryClass; pattern: RegExp }> = [
  {
    type: "exact_lookup",
    pattern: /\b(exact(?:ly)?|verbatim|quote|what did (?:i|you) say|original wording)\b/i
  },
  {
    type: "temporal_recall",
    pattern: /\b(previously|originally|earlier|before|after|back then|history|changed|superseded|at the time|when did)\b/i
  },
  {
    type: "document_question",
    pattern: /\b(file|document|attachment|pdf|page|spreadsheet|csv|source code|markdown)\b/i
  },
  {
    type: "web_question",
    pattern: /\b(web|online|internet|latest news|search for|look up|today'?s|current price)\b/i
  },
  {
    type: "tool_task",
    pattern: /\b(calculate|execute|run (?:this|the)|use (?:python|javascript)|analy[sz]e the data)\b/i
  },
  {
    type: "factual_recall",
    pattern: /\b(remember|recall|what|which|who|where|why|how many|tell me about|my preference|we decided)\b/i
  }
];

function inferTimeIntent(query: string): TimeIntent {
  if (/\b(now|currently|current|latest|today|as of)\b/i.test(query)) return "current";
  if (/\b(previously|originally|earlier|before|back then|used to|at the time)\b/i.test(query)) {
    return "historical";
  }
  if (/\bbetween|from .+ to|during|date range\b/i.test(query)) return "range";
  return "unspecified";
}

function inferDateRange(query: string): QueryClassification["dateRange"] {
  const isoDates = [...query.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)].map(
    (match) => match[1]!
  );
  if (isoDates.length > 0) {
    const fromTimestamp = Date.parse(`${isoDates[0]}T00:00:00.000Z`);
    const last = isoDates[Math.min(1, isoDates.length - 1)]!;
    const endTimestamp = Date.parse(`${last}T00:00:00.000Z`);
    if (Number.isFinite(fromTimestamp) && Number.isFinite(endTimestamp)) {
      const end = new Date(endTimestamp);
      end.setUTCDate(end.getUTCDate() + 1);
      return { from: new Date(fromTimestamp).toISOString(), to: end.toISOString() };
    }
  }
  const years = [...query.matchAll(/\b(20\d{2})\b/g)].map((match) => Number(match[1]));
  if (years.length > 0) {
    const start = Math.min(...years);
    const end = Math.max(...years);
    return {
      from: new Date(Date.UTC(start, 0, 1)).toISOString(),
      to: new Date(Date.UTC(end + 1, 0, 1)).toISOString()
    };
  }
  return null;
}

function requestedSources(query: string): string[] {
  const result: string[] = [];
  if (/\b(message|conversation|chat|said)\b/i.test(query)) result.push("event");
  if (/\b(file|document|attachment|pdf|page)\b/i.test(query)) result.push("source", "chunk");
  if (/\b(memory|wiki|topic)\b/i.test(query)) result.push("topic", "claim");
  if (/\b(web|internet|url|website)\b/i.test(query)) result.push("web");
  return [...new Set(result)];
}

function extractEntities(query: string): string[] {
  const quoted = [...query.matchAll(/["“]([^"”]{2,80})["”]/g)].map((match) => match[1]!);
  const proper = [
    ...query.matchAll(/\b(?:[A-Z][a-z0-9]+(?:\s+[A-Z][a-z0-9]+){0,3}|[A-Z]{2,})\b/g)
  ].map((match) => match[0]);
  const stopwords = new Set([
    "what",
    "which",
    "who",
    "where",
    "when",
    "why",
    "how",
    "quote",
    "remember"
  ]);
  return [...new Set([...quoted, ...proper])]
    .filter((value) => !stopwords.has(value.toLocaleLowerCase()))
    .slice(0, 12);
}

function deterministicClassification(query: string): QueryClassification {
  const classes = CUES.filter((cue) => cue.pattern.test(query)).map((cue) => cue.type);
  if (classes.length === 0) classes.push("conversational");
  const distinctive = classes.some((value) => value !== "conversational");
  return {
    classes: [...new Set(classes)],
    timeIntent: inferTimeIntent(query),
    dateRange: inferDateRange(query),
    entities: extractEntities(query),
    requestedSourceTypes: requestedSources(query),
    relationshipQuestion: /\b(related|relationship|connect|between|depends on|because of|led to|multi[- ]?hop)\b/i.test(
      query
    ),
    confidence: distinctive ? 0.9 : 0.55,
    usedModelFallback: false
  };
}

export async function classifyQuery(
  query: string,
  fallback: QueryClassifierFallback | null = null
): Promise<QueryClassification> {
  const deterministic = deterministicClassification(query);
  if (deterministic.confidence >= 0.75 || fallback === null) return deterministic;
  const model = await fallback.classify(query);
  return {
    ...model,
    classes: model.classes.length > 0 ? [...new Set(model.classes)] : ["conversational"],
    entities: [...new Set(model.entities)],
    requestedSourceTypes: [...new Set(model.requestedSourceTypes)],
    dateRange: model.dateRange ?? deterministic.dateRange,
    confidence: Math.max(0, Math.min(1, model.confidence)),
    usedModelFallback: true
  };
}
