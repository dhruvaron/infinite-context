import type { RankedCandidate } from "./types.js";

export interface ContextTurn {
  id: string;
  turnIndex: number;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  complete: boolean;
  tokenCount: number;
}

export interface ContextNotice {
  kind: "conflict" | "missing_evidence" | "stale";
  text: string;
  tokenCount: number;
}

export interface ContextPacketInput {
  modelContextTokens: number;
  instructionTokens: number;
  toolDefinitionTokens: number;
  recentTurns: ContextTurn[];
  candidates: RankedCandidate[];
  notices: ContextNotice[];
  minimumCompleteTurns?: number;
}

export interface ContextPacket {
  modelContextTokens: number;
  reservedOutputTokens: number;
  instructionTokens: number;
  toolDefinitionTokens: number;
  recentTurns: ContextTurn[];
  evidence: RankedCandidate[];
  notices: ContextNotice[];
  usedTokens: number;
  evidenceTokens: number;
  recentTurnTokens: number;
  exclusions: Array<{ id: string; reason: string }>;
}

function uniqueEvidence(candidates: readonly RankedCandidate[]): RankedCandidate[] {
  const byFingerprint = new Map<string, RankedCandidate>();
  for (const candidate of candidates) {
    const fingerprint = candidate.excerpt
      .normalize("NFKC")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase();
    const previous = byFingerprint.get(fingerprint);
    if (
      !previous ||
      (candidate.document.rawSource && !previous.document.rawSource) ||
      (candidate.document.rawSource === previous.document.rawSource &&
        candidate.fusedScore > previous.fusedScore)
    ) {
      byFingerprint.set(fingerprint, candidate);
    }
  }
  return [...byFingerprint.values()].sort(
    (a, b) =>
      (b.rerankScore ?? b.fusedScore) - (a.rerankScore ?? a.fusedScore)
  );
}

function completeTurnGroups(turns: readonly ContextTurn[]): ContextTurn[][] {
  const grouped = new Map<number, ContextTurn[]>();
  for (const turn of turns) {
    const values = grouped.get(turn.turnIndex) ?? [];
    values.push(turn);
    grouped.set(turn.turnIndex, values);
  }
  return [...grouped.entries()]
    .filter(([, values]) => values.length > 0 && values.every((turn) => turn.complete))
    .sort(([left], [right]) => right - left)
    .map(([, values]) => values);
}

export function buildContextPacket(input: ContextPacketInput): ContextPacket {
  if (input.modelContextTokens <= 0) throw new Error("Model context must be positive");
  const reservedOutputTokens = Math.floor(input.modelContextTokens * 0.25);
  const inputCapacity = input.modelContextTokens - reservedOutputTokens;
  const fixed = input.instructionTokens + input.toolDefinitionTokens;
  if (fixed > inputCapacity) throw new Error("Instructions exceed model input capacity");
  let remaining = inputCapacity - fixed;
  const selectedTurns: ContextTurn[] = [];
  const exclusions: ContextPacket["exclusions"] = [];
  const allGroups = completeTurnGroups(input.recentTurns);
  const requiredGroups = allGroups.slice(0, input.minimumCompleteTurns ?? 4);
  // Newest turn groups receive priority if all four cannot fit.
  for (const group of requiredGroups) {
    const tokens = group.reduce((sum, turn) => sum + turn.tokenCount, 0);
    if (tokens <= remaining) {
      selectedTurns.push(...group);
      remaining -= tokens;
    } else {
      exclusions.push(
        ...group.map((turn) => ({
          id: turn.id,
          reason: "complete recent turn exceeded remaining input"
        }))
      );
    }
  }
  selectedTurns.sort((a, b) => a.turnIndex - b.turnIndex);
  const selectedNotices: ContextNotice[] = [];
  for (const notice of input.notices) {
    if (notice.tokenCount <= remaining) {
      selectedNotices.push(notice);
      remaining -= notice.tokenCount;
    }
  }

  const evidenceCapacity = Math.min(
    remaining,
    Math.floor((inputCapacity - fixed) * 0.45)
  );
  let evidenceRemaining = evidenceCapacity;
  const evidence: RankedCandidate[] = [];
  for (const candidate of uniqueEvidence(input.candidates)) {
    if (candidate.document.tokenCount <= evidenceRemaining) {
      evidence.push({ ...candidate, selected: true });
      evidenceRemaining -= candidate.document.tokenCount;
    } else {
      exclusions.push({ id: candidate.id, reason: "evidence token budget" });
    }
  }
  const evidenceTokens = evidenceCapacity - evidenceRemaining;
  remaining -= evidenceTokens;

  // Use leftover input for older complete turns without displacing retrieved evidence.
  const selectedIndices = new Set(selectedTurns.map((turn) => turn.turnIndex));
  const olderGroups = allGroups.filter(
    (group) => !selectedIndices.has(group[0]!.turnIndex)
  );
  for (const group of olderGroups) {
    const tokens = group.reduce((sum, turn) => sum + turn.tokenCount, 0);
    if (tokens <= remaining) {
      selectedTurns.push(...group);
      selectedIndices.add(group[0]!.turnIndex);
      remaining -= tokens;
    }
  }
  selectedTurns.sort((a, b) => a.turnIndex - b.turnIndex);
  const finalRecentTokens = selectedTurns.reduce((sum, turn) => sum + turn.tokenCount, 0);
  const noticeTokens = selectedNotices.reduce((sum, notice) => sum + notice.tokenCount, 0);
  const usedTokens = fixed + finalRecentTokens + evidenceTokens + noticeTokens;
  if (usedTokens > inputCapacity) throw new Error("Context packet exceeded input capacity");
  return {
    modelContextTokens: input.modelContextTokens,
    reservedOutputTokens,
    instructionTokens: input.instructionTokens,
    toolDefinitionTokens: input.toolDefinitionTokens,
    recentTurns: selectedTurns,
    evidence,
    notices: selectedNotices,
    usedTokens,
    evidenceTokens,
    recentTurnTokens: finalRecentTokens,
    exclusions
  };
}
