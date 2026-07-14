import type { QualityPreset } from "@continuum/contracts";

const STORAGE_KEY = "continuum.pending-mutations.v1";
export const DRAFT_REVISION_KEY = "continuum.unsent-draft.revision";

export type PersistedUploadIntent = {
  idempotencyKey: string;
  localId: string;
  filename: string;
  mediaType: string;
  size: number;
  lastModified: number;
};

export type PersistedMessageIntent = {
  operation: "messages.create";
  idempotencyKey: string;
  draftRevisionId: string;
  contentKind: "draft" | "attachment-default";
  quality: QualityPreset;
  attachments: PersistedUploadIntent[];
  createdAt: string;
};

export type PersistedRegenerationIntent = {
  operation: "events.regenerate";
  idempotencyKey: string;
  eventId: string;
  createdAt: string;
};

type PersistedMutationState = {
  version: 1;
  message: PersistedMessageIntent | null;
  regeneration: PersistedRegenerationIntent | null;
};

const EMPTY_STATE: PersistedMutationState = { version: 1, message: null, regeneration: null };

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 500;
}

function isIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= 200;
}

function isUploadIntent(value: unknown): value is PersistedUploadIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PersistedUploadIntent>;
  return isIdempotencyKey(candidate.idempotencyKey)
    && isString(candidate.localId)
    && isString(candidate.filename)
    && typeof candidate.mediaType === "string"
    && Number.isSafeInteger(candidate.size)
    && Number(candidate.size) >= 0
    && Number.isSafeInteger(candidate.lastModified)
    && Number(candidate.lastModified) >= 0;
}

function isMessageIntent(value: unknown): value is PersistedMessageIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PersistedMessageIntent>;
  return candidate.operation === "messages.create"
    && isIdempotencyKey(candidate.idempotencyKey)
    && isString(candidate.draftRevisionId)
    && (candidate.contentKind === "draft" || candidate.contentKind === "attachment-default")
    && (candidate.quality === "fast" || candidate.quality === "balanced" || candidate.quality === "deep")
    && Array.isArray(candidate.attachments)
    && candidate.attachments.length <= 20
    && candidate.attachments.every(isUploadIntent)
    && isString(candidate.createdAt);
}

function isRegenerationIntent(value: unknown): value is PersistedRegenerationIntent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PersistedRegenerationIntent>;
  return candidate.operation === "events.regenerate"
    && isIdempotencyKey(candidate.idempotencyKey)
    && isString(candidate.eventId)
    && isString(candidate.createdAt);
}

function readState(): PersistedMutationState {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...EMPTY_STATE };
    const candidate = parsed as Partial<PersistedMutationState>;
    if (candidate.version !== 1) return { ...EMPTY_STATE };
    return {
      version: 1,
      message: isMessageIntent(candidate.message) ? candidate.message : null,
      regeneration: isRegenerationIntent(candidate.regeneration) ? candidate.regeneration : null
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

function writeState(state: PersistedMutationState): boolean {
  try {
    if (!state.message && !state.regeneration) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function readMessageIntent(): PersistedMessageIntent | null {
  return readState().message;
}

export function persistMessageIntent(intent: PersistedMessageIntent): boolean {
  return writeState({ ...readState(), message: intent });
}

export function clearMessageIntent(idempotencyKey?: string): boolean {
  const state = readState();
  if (idempotencyKey && state.message?.idempotencyKey !== idempotencyKey) return true;
  return writeState({ ...state, message: null });
}

export function readRegenerationIntent(): PersistedRegenerationIntent | null {
  return readState().regeneration;
}

export function persistRegenerationIntent(intent: PersistedRegenerationIntent): boolean {
  return writeState({ ...readState(), regeneration: intent });
}

export function clearRegenerationIntent(idempotencyKey?: string): boolean {
  const state = readState();
  if (idempotencyKey && state.regeneration?.idempotencyKey !== idempotencyKey) return true;
  return writeState({ ...state, regeneration: null });
}

export function clearAllMutationIntents(): boolean {
  return writeState({ ...EMPTY_STATE });
}

export function messageIntentMatches(intent: PersistedMessageIntent, input: {
  draftRevisionId: string;
  contentKind: PersistedMessageIntent["contentKind"];
  quality: QualityPreset;
  attachmentKeys: string[];
}): boolean {
  return intent.draftRevisionId === input.draftRevisionId
    && intent.contentKind === input.contentKind
    && intent.quality === input.quality
    && intent.attachments.length === input.attachmentKeys.length
    && intent.attachments.every((attachment, index) => attachment.idempotencyKey === input.attachmentKeys[index]);
}
