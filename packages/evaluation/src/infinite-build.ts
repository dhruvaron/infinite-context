import { createHash } from "node:crypto";

import type {
  EvaluationDataset,
  EvaluationMessage,
  EvaluationProbe,
  ProbeCategory
} from "./types.js";

export const INFINITE_BUILD_VERSION = "1.0.0";

class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x6d2b79f5;
  }

  next(): number {
    this.state += 0x6d2b79f5;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  }

  pick<T>(values: readonly T[]): T {
    return values[Math.floor(this.next() * values.length)]!;
  }
}
function tokenCount(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

const NOISE_TOPICS = [
  "requirements",
  "architecture",
  "ui",
  "implementation",
  "debugging",
  "research",
  "deployment",
  "accessibility"
] as const;

const NOISE_USER = [
  "Let's examine the next implementation detail for {topic} and list the tradeoffs.",
  "Can you sanity-check this {topic} idea against the constraints we established?",
  "Before coding, write one concise acceptance criterion for this {topic} task.",
  "I found another edge case in {topic}; help me reason through it without changing prior decisions.",
  "Summarize the immediate next step for {topic}, but preserve all earlier evidence."
] as const;

const NOISE_ASSISTANT = [
  "For {topic}, the next bounded step is to validate the interface and retain provenance for every conclusion.",
  "The {topic} tradeoff is recorded as exploratory; it does not supersede an explicit project decision.",
  "A useful {topic} acceptance check is deterministic behavior under restart and irrelevant-topic interference.",
  "I will treat that {topic} case as a hypothesis until direct evidence establishes it.",
  "The immediate {topic} work is isolated and leaves the existing architecture unchanged."
] as const;

interface ScriptedMessage {
  content: string;
  topic: string;
  key: string;
}

function scriptedMessages(total: number): Map<number, ScriptedMessage> {
  const at = (preferred: number): number => {
    const bounded = Math.max(0, Math.min(total - 2, preferred));
    return bounded % 2 === 0 ? bounded : bounded - 1;
  };
  const map = new Map<number, ScriptedMessage>();
  const entries: Array<[number, ScriptedMessage]> = [
    [2, { key: "codename", topic: "requirements", content: "Remember this: the application codename is Northstar." }],
    [10, { key: "preference", topic: "ui", content: "My durable UI preference is dark mode with restrained blue accents." }],
    [20, { key: "quote", topic: "requirements", content: "Record my exact launch principle: ‘One timeline, no context tax.’" }],
    [30, { key: "database-old", topic: "architecture", content: "We decided the production database will be MongoDB." }],
    [60, { key: "database-new", topic: "architecture", content: "Correction: replace MongoDB with PostgreSQL as the current production database decision." }],
    [70, { key: "relation-alice", topic: "implementation", content: "Alice owns the Atlas indexing service." }],
    [72, { key: "relation-atlas", topic: "implementation", content: "The Atlas indexing service is written in Rust." }],
    [88, { key: "conflict-a", topic: "deployment", content: "The unresolved launch window might be September." }],
    [90, { key: "conflict-b", topic: "deployment", content: "A separate stakeholder says the launch window is October; do not resolve this yet." }],
    [800, { key: "auth-old", topic: "architecture", content: "For authentication, the initial decision is signed server sessions." }],
    [900, { key: "auth-new", topic: "architecture", content: "Explicit correction: authentication will use passkeys, superseding signed server sessions." }],
    [3_800, { key: "color-old", topic: "ui", content: "The warning color is currently amber." }],
    [4_200, { key: "color-new", topic: "ui", content: "Change the warning color from amber to coral; coral is now current." }],
    [8_500, { key: "retention", topic: "requirements", content: "Remember that managed backups retain seven daily and four weekly snapshots." }],
    [9_200, { key: "assistant-conclusion-request", topic: "research", content: "Analyze our evidence and retain your conclusion about why graph expansion must be bounded." }]
  ];
  for (const [position, message] of entries) {
    const index = at(position);
    if (index < total) map.set(index, message);
  }
  return map;
}

function makeMessage(
  sequence: number,
  role: EvaluationMessage["role"],
  content: string,
  topic: string
): EvaluationMessage {
  return {
    id: `ib-msg-${String(sequence).padStart(6, "0")}`,
    sequence,
    role,
    content,
    tokenCount: tokenCount(content),
    topic,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString()
  };
}

function scriptResponse(key: string): string {
  const responses: Record<string, string> = {
    codename: "Recorded: Northstar is the application codename.",
    preference: "Recorded as a durable preference: dark mode with restrained blue accents.",
    quote: "Recorded verbatim with its source turn.",
    "database-old": "MongoDB is recorded as the initial production database decision.",
    "database-new": "PostgreSQL is current; MongoDB remains queryable as superseded history.",
    "relation-alice": "Recorded: Alice owns Atlas.",
    "relation-atlas": "Recorded: Atlas is written in Rust.",
    "conflict-a": "September is recorded as tentative, not established.",
    "conflict-b": "September and October remain an explicit unresolved conflict.",
    "auth-old": "Signed server sessions are recorded as the initial authentication decision.",
    "auth-new": "Passkeys are current and signed server sessions are superseded.",
    "color-old": "Amber is recorded as the current warning color.",
    "color-new": "Coral is current; amber remains historical.",
    retention: "Recorded: seven daily and four weekly managed-backup snapshots.",
    "assistant-conclusion-request": "Attributed conclusion: graph expansion must be bounded to prevent semantic drift and uncontrolled token growth."
  };
  return responses[key] ?? "Recorded with provenance.";
}

function evidenceId(sequence: number): string {
  return `ib-msg-${String(sequence).padStart(6, "0")}`;
}

function probe(
  checkpoint: number,
  category: ProbeCategory,
  suffix: string,
  question: string,
  acceptableAnswers: string[],
  evidence: number[],
  current: string | null,
  absent = false
): EvaluationProbe {
  return {
    id: `ib-${checkpoint}-${suffix}`,
    checkpoint,
    category,
    question,
    acceptableAnswers,
    expectedEvidenceIds: evidence.map(evidenceId),
    expectedCurrentValue: current,
    shouldRefuseForMissingEvidence: absent,
    deterministic: true,
    notes: "Generated from seeded InfiniteBuild ground truth."
  };
}

function probesFor(checkpoint: number): EvaluationProbe[] {
  const result: EvaluationProbe[] = [
    probe(checkpoint, "single_fact", "codename", "What is the application codename?", ["Northstar"], [3], "Northstar"),
    probe(checkpoint, "preference", "theme", "What durable visual preference did I state?", ["dark mode with restrained blue accents", "dark mode"], [11], "dark mode with restrained blue accents"),
    probe(checkpoint, "exact_quote", "quote", "Quote my exact launch principle.", ["One timeline, no context tax."], [21], null),
    probe(checkpoint, "decision_supersession", "db-current", "What is the current production database, and what did it replace?", ["PostgreSQL", "PostgreSQL replaced MongoDB"], [31, 61], "PostgreSQL"),
    probe(checkpoint, "temporal_ordering", "db-original", "What database did we originally choose?", ["MongoDB"], [31, 61], "MongoDB"),
    probe(checkpoint, "multi_hop", "alice-language", "What language is the service owned by Alice written in?", ["Rust"], [71, 73], "Rust"),
    probe(checkpoint, "contradiction", "launch", "What is the established launch month?", ["unresolved", "September or October", "not established"], [89, 91], null),
    probe(checkpoint, "absent_evidence", "pet", "What is my pet's name?", ["not found", "I don't know", "no evidence"], [], null, true),
    probe(checkpoint, "interference", "codename-return", "After all the unrelated work, remind me of the codename.", ["Northstar"], [3], "Northstar")
  ];
  if (checkpoint >= 1_000) {
    result.push(
      probe(checkpoint, "decision_supersession", "auth", "What is the current authentication approach?", ["passkeys"], [801, 901], "passkeys")
    );
  }
  if (checkpoint >= 5_000) {
    result.push(
      probe(checkpoint, "decision_supersession", "warning-color", "What is the current warning color?", ["coral"], [3_801, 4_201], "coral")
    );
  }
  if (checkpoint >= 10_000) {
    result.push(
      probe(checkpoint, "single_fact", "retention", "What is the managed backup retention?", ["seven daily and four weekly", "7 daily and 4 weekly"], [8_501], "seven daily and four weekly"),
      probe(checkpoint, "assistant_conclusion", "bounded-graph", "Why did you conclude graph expansion must be bounded?", ["prevent semantic drift and uncontrolled token growth", "semantic drift"], [9_201, 9_202], null)
    );
  }
  return result;
}

export interface InfiniteBuildOptions {
  messages?: number;
  seed?: number;
  checkpoints?: number[];
}

export function generateInfiniteBuild(
  options: InfiniteBuildOptions = {}
): EvaluationDataset {
  const total = options.messages ?? 10_000;
  if (!Number.isInteger(total) || total < 100) {
    throw new Error("InfiniteBuild requires at least 100 messages");
  }
  const seed = options.seed ?? 2_026_0713;
  const rng = new SeededRandom(seed);
  const scripts = scriptedMessages(total);
  const messages: EvaluationMessage[] = [];
  let pendingScript: ScriptedMessage | null = null;
  for (let index = 0; index < total; index += 1) {
    const sequence = index + 1;
    const role: EvaluationMessage["role"] = index % 2 === 0 ? "user" : "assistant";
    const script = scripts.get(index);
    if (role === "user" && script) {
      pendingScript = script;
      messages.push(makeMessage(sequence, role, script.content, script.topic));
      continue;
    }
    if (role === "assistant" && pendingScript) {
      messages.push(
        makeMessage(sequence, role, scriptResponse(pendingScript.key), pendingScript.topic)
      );
      pendingScript = null;
      continue;
    }
    const topic = rng.pick(NOISE_TOPICS);
    const template = role === "user" ? rng.pick(NOISE_USER) : rng.pick(NOISE_ASSISTANT);
    messages.push(makeMessage(sequence, role, template.replace("{topic}", topic), topic));
  }
  const checkpoints = (options.checkpoints ?? [100, 1_000, 5_000, 10_000])
    .filter((checkpoint) => checkpoint <= total)
    .sort((a, b) => a - b);
  if (checkpoints.length === 0 || checkpoints.at(-1) !== total) checkpoints.push(total);
  const probes = checkpoints.flatMap(probesFor);
  const generatorHash = stableHash({ version: INFINITE_BUILD_VERSION, seed, total, checkpoints });
  return {
    id: `infinite-build-${generatorHash.slice(0, 12)}`,
    name: "InfiniteBuild",
    version: INFINITE_BUILD_VERSION,
    seed,
    generatorHash,
    checkpoints,
    messages,
    probes,
    license: "MIT",
    provenance: "Seeded synthetic dataset generated by Continuum"
  };
}

export function createManualBuildScenario(): EvaluationDataset {
  const messages = [
    makeMessage(1, "user", "The project is called Lantern. It helps students trace research evidence.", "requirements"),
    makeMessage(2, "assistant", "Lantern and its evidence-tracing purpose are recorded.", "requirements"),
    makeMessage(3, "user", "Use SQLite locally; do not require a hosted database.", "architecture"),
    makeMessage(4, "assistant", "SQLite is the current local-first database decision.", "architecture"),
    makeMessage(5, "user", "Actually, preserve SQLite but add optional PostgreSQL export later; that is not a migration.", "architecture"),
    makeMessage(6, "assistant", "SQLite remains authoritative; PostgreSQL export is a future option, not a replacement.", "architecture")
  ];
  const probes = [
    probe(6, "decision_supersession", "manual-db", "What is Lantern's current database decision?", ["SQLite"], [3, 5], "SQLite")
  ];
  return {
    id: "manual-lantern-v1",
    name: "Manual Lantern scenario",
    version: "1.0.0",
    seed: 0,
    generatorHash: stableHash({ messages, probes }),
    checkpoints: [6],
    messages,
    probes,
    license: "MIT",
    provenance: "Manually authored Continuum evaluation fixture"
  };
}
