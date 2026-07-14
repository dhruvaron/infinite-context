import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { App } from "./App";
import { ApiRequestError, continuumApi } from "./lib/api-client";
import { demoBootstrap } from "./lib/demo-data";
import { DRAFT_REVISION_KEY, persistMessageIntent, persistRegenerationIntent, readMessageIntent, readRegenerationIntent } from "./lib/mutation-intents";

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
}

describe("Continuum application", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.spyOn(continuumApi, "bootstrap").mockResolvedValue(demoBootstrap);
  });
  afterEach(() => vi.restoreAllMocks());

  it("keeps one quiet timeline and opens the major inspection surfaces", async () => {
    const user = userEvent.setup(); renderApp();
    expect(await screen.findByRole("region", { name: "Conversation" })).toBeInTheDocument();
    expect(screen.queryByText(/new chat/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open memory inspector" }));
    const inspector = screen.getByRole("complementary", { name: "Memory inspector" });
    expect(inspector).toBeVisible();
    await user.click(within(inspector).getByRole("button", { name: "Close memory inspector" }));
    await user.click(screen.getByRole("button", { name: "Open knowledge graph" }));
    expect(screen.getByRole("complementary", { name: "Knowledge graph" })).toBeVisible();
  });

  it("opens unified search with the macOS shortcut", async () => {
    const user = userEvent.setup(); renderApp();
    await user.keyboard("{Meta>}k{/Meta}");
    expect(await screen.findByRole("dialog", { name: /search your entire history/i })).toBeVisible();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Search all memory" })).toHaveFocus());
  });

  it("keeps required onboarding modal-exclusive and cannot stack search above it", async () => {
    vi.mocked(continuumApi.bootstrap).mockResolvedValue({
      ...demoBootstrap,
      runtime: { ...demoBootstrap.runtime, mode: "connected", apiReachable: true },
      settings: { ...demoBootstrap.settings, onboardingComplete: false },
      events: []
    });
    const user = userEvent.setup();
    renderApp();
    const welcome = await screen.findByRole("dialog", { name: "Welcome" });
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(welcome).toBeVisible();
    await user.keyboard("{Meta>}k{/Meta}");
    expect(screen.queryByRole("dialog", { name: /search your entire history/i })).not.toBeInTheDocument();
  });

  it("optimistically appends and completes a demo-vault response", async () => {
    const user = userEvent.setup(); renderApp();
    const input = await screen.findByRole("textbox", { name: "Message Continuum" });
    await waitFor(() => expect(input).not.toBeDisabled());
    fireEvent.change(input, { target: { value: "Do you remember the source-of-truth decision?" } });
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText("Do you remember the source-of-truth decision?")).toBeVisible();
    expect(input).toHaveValue("");
    await waitFor(() => expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled(), { timeout: 4000 });
    expect(screen.getByText(/immutable demo vault/i)).toBeVisible();
  });

  it("recovers an unsent draft from local storage", async () => {
    localStorage.setItem("continuum.unsent-draft", "A recovered thought");
    renderApp();
    expect(await screen.findByRole("textbox", { name: "Message Continuum" })).toHaveValue("A recovered thought");
  });

  it("hydrates a fresh connected vault instead of committing placeholder preview data", async () => {
    const liveEvent = { ...demoBootstrap.events[0]!, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", sequence: 1, content: "Live vault event" };
    vi.mocked(continuumApi.bootstrap).mockResolvedValue({
      ...demoBootstrap,
      runtime: { ...demoBootstrap.runtime, mode: "connected", apiReachable: true, message: "Local vault connected" },
      settings: { ...demoBootstrap.settings, onboardingComplete: false },
      events: [liveEvent],
      topics: [],
      claims: [],
      activeMemories: [],
      graph: { nodes: [], edges: [], focusId: null, truncated: false }
    });
    renderApp();
    expect(await screen.findByText("Live vault event")).toBeVisible();
    expect(screen.queryByText(demoBootstrap.events[0]!.content)).not.toBeInTheDocument();
    expect(await screen.findByRole("dialog", { name: /^welcome$/i })).toBeVisible();
  });

  it("recovers an active run after refresh by replaying durable deltas without duplicating persisted partial text", async () => {
    const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const assistantId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const userMessage = { ...demoBootstrap.events[0]!, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", sequence: 1, runId: null, content: "Resume the response" };
    const partialAssistant = { ...demoBootstrap.events[1]!, id: assistantId, sequence: 2, runId, parentEventId: userMessage.id, status: "streaming" as const, content: "Recovered prefix", completedAt: null };
    vi.mocked(continuumApi.bootstrap).mockResolvedValue({
      ...demoBootstrap,
      runtime: { ...demoBootstrap.runtime, mode: "connected", apiReachable: true },
      events: [userMessage, partialAssistant],
      activeRuns: [{ id: runId, status: "streaming", userEventId: userMessage.id, assistantEventId: assistantId }]
    });
    const streamSpy = vi.spyOn(continuumApi, "streamRun").mockImplementation(async (_runId, handlers) => {
      handlers.onEvent({ type: "response.delta", runId, eventId: assistantId, delta: "Recovered prefix" }, { id: "501" });
      handlers.onCursor?.("501");
      throw new ApiRequestError("stream unavailable", "STREAM_INTERRUPTED", true);
    });
    renderApp();
    await waitFor(() => expect(streamSpy).toHaveBeenCalledWith(
      runId,
      expect.any(Object),
      expect.any(AbortSignal),
      expect.objectContaining({ lastEventId: null })
    ));
    await waitFor(() => {
      expect(screen.getByText("Recovered prefix")).toBeVisible();
      expect(screen.queryByText("Recovered prefixRecovered prefix")).not.toBeInTheDocument();
    });
    expect(JSON.parse(sessionStorage.getItem(`continuum.run-stream.${runId}`) ?? "null")).toMatchObject({ cursor: "501", assistantEventId: assistantId, contentLength: "Recovered prefix".length });
    expect(screen.getByRole("button", { name: "Resume response" })).toBeVisible();
  });

  it("keeps a saved run active and blocks a second send when reconnect attempts are exhausted", async () => {
    const runId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const savedUser = { ...demoBootstrap.events[0]!, id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", sequence: 1, runId: null, parentEventId: null, content: "First request" };
    vi.mocked(continuumApi.bootstrap).mockResolvedValue({
      ...demoBootstrap,
      runtime: { ...demoBootstrap.runtime, mode: "connected", apiReachable: true },
      events: [],
      activeRuns: []
    });
    const createSpy = vi.spyOn(continuumApi, "createMessage").mockResolvedValue({ event: savedUser, runId });
    vi.spyOn(continuumApi, "streamRun").mockRejectedValue(new ApiRequestError("reconnects exhausted", "STREAM_INTERRUPTED", true));
    const user = userEvent.setup();
    renderApp();
    const input = await screen.findByRole("textbox", { name: "Message Continuum" });
    await waitFor(() => expect(input).not.toBeDisabled());
    await user.type(input, "First request");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByRole("button", { name: "Resume response" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Stop response" }).length).toBeGreaterThan(0);
    await user.clear(input);
    await user.type(input, "Second request{Enter}");
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/may still be running/i)).toBeVisible();
  });

  it("recovers a committed message after its POST response is lost without creating a second mutation", async () => {
    const runId = "18888888-8888-4888-8888-888888888888";
    const savedUser = { ...demoBootstrap.events[0]!, id: "19999999-9999-4999-8999-999999999999", sequence: 1, content: "Commit this once", attachments: [] };
    vi.mocked(continuumApi.bootstrap).mockResolvedValue({
      ...demoBootstrap,
      runtime: { ...demoBootstrap.runtime, mode: "connected", apiReachable: true },
      settings: { ...demoBootstrap.settings, onboardingComplete: true },
      events: [],
      activeRuns: []
    });
    vi.spyOn(continuumApi, "getBudgetSummary").mockResolvedValue(demoBootstrap.budget);
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("response disappeared after commit"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ found: true, operation: "messages.create", result: { event: savedUser, runId } }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.spyOn(continuumApi, "streamRun").mockImplementation(async (_runId, handlers) => {
      handlers.onEvent({ type: "run.cancelled", runId }, { id: "1" });
      return { lastEventId: "1", terminal: true };
    });
    const user = userEvent.setup();
    renderApp();
    const input = await screen.findByRole("textbox", { name: "Message Continuum" });
    await user.type(input, savedUser.content);
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText(savedUser.content)).toBeVisible();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const postedKey = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).idempotencyKey as string;
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(`operation=messages.create&key=${encodeURIComponent(postedKey)}`);
    expect(readMessageIntent()).toBeNull();
    expect(localStorage.getItem("continuum.unsent-draft")).toBeNull();
  });

  it("refuses the first mutation when the exact draft cannot be persisted for recovery", async () => {
    vi.mocked(continuumApi.bootstrap).mockResolvedValue({
      ...demoBootstrap,
      runtime: { ...demoBootstrap.runtime, mode: "connected", apiReachable: true },
      settings: { ...demoBootstrap.settings, onboardingComplete: true },
      events: [],
      activeRuns: []
    });
    vi.spyOn(continuumApi, "getBudgetSummary").mockResolvedValue(demoBootstrap.budget);
    const create = vi.spyOn(continuumApi, "createMessage");
    const nativeSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
      if (key === "continuum.unsent-draft") throw new DOMException("Quota exceeded", "QuotaExceededError");
      return nativeSetItem.call(this, key, value);
    });
    const user = userEvent.setup();
    renderApp();
    const input = await screen.findByRole("textbox", { name: "Message Continuum" });
    await user.type(input, "Do not send without a recoverable draft");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(await screen.findByText(/Safe retry storage is unavailable/i)).toBeVisible();
    expect(create).not.toHaveBeenCalled();
    expect(readMessageIntent()).toBeNull();
  });

  it("reconciles a committed browser-persisted message intent after reload", async () => {
    const revision = "draft-revision-after-reload";
    const messageKey = "persisted-message-key-after-reload";
    const runId = "28888888-8888-4888-8888-888888888888";
    const savedUser = { ...demoBootstrap.events[0]!, id: "29999999-9999-4999-8999-999999999999", sequence: 1, content: "Recovered after reload", attachments: [] };
    localStorage.setItem("continuum.unsent-draft", savedUser.content);
    localStorage.setItem(DRAFT_REVISION_KEY, revision);
    expect(persistMessageIntent({ operation: "messages.create", idempotencyKey: messageKey, draftRevisionId: revision, contentKind: "draft", quality: "balanced", attachments: [], createdAt: "2026-07-14T12:00:00.000Z" })).toBe(true);
    vi.mocked(continuumApi.bootstrap).mockResolvedValue({
      ...demoBootstrap,
      runtime: { ...demoBootstrap.runtime, mode: "connected", apiReachable: true },
      settings: { ...demoBootstrap.settings, onboardingComplete: true },
      events: [],
      activeRuns: []
    });
    vi.spyOn(continuumApi, "getBudgetSummary").mockResolvedValue(demoBootstrap.budget);
    const recover = vi.spyOn(continuumApi, "recoverMutation").mockResolvedValue({ found: true, operation: "messages.create", result: { event: savedUser, runId } });
    const create = vi.spyOn(continuumApi, "createMessage");
    vi.spyOn(continuumApi, "streamRun").mockImplementation(async (_runId, handlers) => {
      handlers.onEvent({ type: "run.cancelled", runId }, { id: "1" });
      return { lastEventId: "1", terminal: true };
    });
    renderApp();

    expect(await screen.findByText(savedUser.content)).toBeVisible();
    expect(recover).toHaveBeenCalledWith("messages.create", messageKey);
    expect(create).not.toHaveBeenCalled();
    expect(readMessageIntent()).toBeNull();
    expect(localStorage.getItem("continuum.unsent-draft")).toBeNull();
  });

  it("honestly requires reattachment when an uncommitted file cannot survive reload", async () => {
    const revision = "draft-revision-with-lost-file";
    const messageKey = "persisted-message-with-lost-file";
    const uploadKey = "uncommitted-upload-with-lost-bytes";
    localStorage.setItem("continuum.unsent-draft", "Analyze the missing file");
    localStorage.setItem(DRAFT_REVISION_KEY, revision);
    expect(persistMessageIntent({
      operation: "messages.create",
      idempotencyKey: messageKey,
      draftRevisionId: revision,
      contentKind: "draft",
      quality: "balanced",
      attachments: [{ idempotencyKey: uploadKey, localId: "lost-local-file", filename: "lost.pdf", mediaType: "application/pdf", size: 42, lastModified: 1 }],
      createdAt: "2026-07-14T12:00:00.000Z"
    })).toBe(true);
    vi.mocked(continuumApi.bootstrap).mockResolvedValue({
      ...demoBootstrap,
      runtime: { ...demoBootstrap.runtime, mode: "connected", apiReachable: true },
      settings: { ...demoBootstrap.settings, onboardingComplete: true },
      events: [],
      activeRuns: []
    });
    vi.spyOn(continuumApi, "getBudgetSummary").mockResolvedValue(demoBootstrap.budget);
    vi.spyOn(continuumApi, "recoverMutation").mockImplementation(async (operation) => ({ found: false as const, operation }));
    const create = vi.spyOn(continuumApi, "createMessage");
    renderApp();

    expect(await screen.findByText(/Reattach lost\.pdf before sending/i)).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Message Continuum" })).toHaveValue("Analyze the missing file");
    expect(screen.getByText(/Some files must be reattached/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Remove lost.pdf" })).toBeVisible();
    expect(create).not.toHaveBeenCalled();
    expect(readMessageIntent()?.idempotencyKey).toBe(messageKey);
  });

  it("recovers a committed upload after reload and sends with the original message identity without uploading bytes again", async () => {
    const revision = "draft-revision-with-committed-upload";
    const messageKey = "persisted-message-with-committed-upload";
    const uploadKey = "committed-upload-after-reload";
    const runId = "38888888-8888-4888-8888-888888888888";
    const content = "Analyze the recovered upload";
    const attachment = { id: "39999999-9999-4999-8999-999999999999", sourceId: "3aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", filename: "recovered.pdf", mediaType: "application/pdf", size: 42, status: "ready" as const, createdAt: "2026-07-14T12:00:00.000Z" };
    const savedUser = { ...demoBootstrap.events[0]!, id: "3bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", sequence: 1, content, attachments: [attachment] };
    localStorage.setItem("continuum.unsent-draft", content);
    localStorage.setItem(DRAFT_REVISION_KEY, revision);
    expect(persistMessageIntent({
      operation: "messages.create",
      idempotencyKey: messageKey,
      draftRevisionId: revision,
      contentKind: "draft",
      quality: "balanced",
      attachments: [{ idempotencyKey: uploadKey, localId: "recovered-local-file", filename: attachment.filename, mediaType: attachment.mediaType, size: attachment.size, lastModified: 1 }],
      createdAt: "2026-07-14T12:00:00.000Z"
    })).toBe(true);
    vi.mocked(continuumApi.bootstrap).mockResolvedValue({
      ...demoBootstrap,
      runtime: { ...demoBootstrap.runtime, mode: "connected", apiReachable: true },
      settings: { ...demoBootstrap.settings, onboardingComplete: true },
      events: [],
      activeRuns: []
    });
    vi.spyOn(continuumApi, "getBudgetSummary").mockResolvedValue(demoBootstrap.budget);
    vi.spyOn(continuumApi, "recoverMutation").mockImplementation(async (operation) => operation === "attachments.upload"
      ? { found: true as const, operation, result: attachment }
      : { found: false as const, operation });
    const physicalUpload = vi.spyOn(continuumApi, "uploadAttachment");
    const create = vi.spyOn(continuumApi, "createMessage").mockResolvedValue({ event: savedUser, runId });
    vi.spyOn(continuumApi, "streamRun").mockImplementation(async (_runId, handlers) => {
      handlers.onEvent({ type: "run.cancelled", runId }, { id: "1" });
      return { lastEventId: "1", terminal: true };
    });
    const user = userEvent.setup();
    renderApp();

    expect(await screen.findByText(/recovered upload/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: messageKey, attachmentIds: [attachment.id], content })));
    expect(physicalUpload).not.toHaveBeenCalled();
    expect(readMessageIntent()).toBeNull();
  });

  it("reconciles a committed regeneration intent after reload without starting another run", async () => {
    const eventId = demoBootstrap.events[1]!.id;
    const regenerationKey = "persisted-regeneration-after-reload";
    const runId = "48888888-8888-4888-8888-888888888888";
    expect(persistRegenerationIntent({ operation: "events.regenerate", eventId, idempotencyKey: regenerationKey, createdAt: "2026-07-14T12:00:00.000Z" })).toBe(true);
    vi.mocked(continuumApi.bootstrap).mockResolvedValue({
      ...demoBootstrap,
      runtime: { ...demoBootstrap.runtime, mode: "connected", apiReachable: true },
      settings: { ...demoBootstrap.settings, onboardingComplete: true },
      activeRuns: []
    });
    vi.spyOn(continuumApi, "getBudgetSummary").mockResolvedValue(demoBootstrap.budget);
    const recover = vi.spyOn(continuumApi, "recoverMutation").mockResolvedValue({ found: true, operation: "events.regenerate", result: { runId, quality: "balanced" } });
    const regenerate = vi.spyOn(continuumApi, "regenerate");
    const stream = vi.spyOn(continuumApi, "streamRun").mockImplementation(async (_runId, handlers) => {
      handlers.onEvent({ type: "run.cancelled", runId }, { id: "1" });
      return { lastEventId: "1", terminal: true };
    });
    renderApp();

    await waitFor(() => expect(recover).toHaveBeenCalledWith("events.regenerate", regenerationKey));
    await waitFor(() => expect(stream).toHaveBeenCalledWith(runId, expect.any(Object), expect.any(AbortSignal), expect.any(Object)));
    expect(regenerate).not.toHaveBeenCalled();
    expect(readRegenerationIntent()).toBeNull();
  });

  it("reuses the same regeneration identity after an unconfirmed first attempt", async () => {
    const runId = "58888888-8888-4888-8888-888888888888";
    vi.mocked(continuumApi.bootstrap).mockResolvedValue({
      ...demoBootstrap,
      runtime: { ...demoBootstrap.runtime, mode: "connected", apiReachable: true },
      settings: { ...demoBootstrap.settings, onboardingComplete: true },
      activeRuns: []
    });
    vi.spyOn(continuumApi, "getBudgetSummary").mockResolvedValue(demoBootstrap.budget);
    const regenerate = vi.spyOn(continuumApi, "regenerate")
      .mockRejectedValueOnce(new ApiRequestError("response lost", "REQUEST_FAILED", true))
      .mockResolvedValueOnce({ runId, quality: "balanced" });
    vi.spyOn(continuumApi, "streamRun").mockImplementation(async (_runId, handlers) => {
      handlers.onEvent({ type: "run.cancelled", runId }, { id: "1" });
      return { lastEventId: "1", terminal: true };
    });
    const user = userEvent.setup();
    renderApp();
    const regenerateButtons = await screen.findAllByRole("button", { name: "Regenerate response" });
    await user.click(regenerateButtons[0]!);
    await user.click(await screen.findByRole("button", { name: "Retry response" }));

    await waitFor(() => expect(regenerate).toHaveBeenCalledTimes(2));
    expect(regenerate.mock.calls[0]![1]).toBe(regenerate.mock.calls[1]![1]);
    expect(readRegenerationIntent()).toBeNull();
  });

  it("reuses every durable attachment ID after a mixed extraction failure", async () => {
    vi.mocked(continuumApi.bootstrap).mockResolvedValue({
      ...demoBootstrap,
      runtime: { ...demoBootstrap.runtime, mode: "connected", apiReachable: true },
      events: [],
      activeRuns: []
    });
    const good = { id: "11111111-1111-4111-8111-111111111111", sourceId: "21111111-1111-4111-8111-111111111111", filename: "good.txt", mediaType: "text/plain", size: 4, status: "ready" as const, createdAt: "2026-01-01T00:00:00.000Z" };
    const slowQueued = { id: "12222222-2222-4222-8222-222222222222", sourceId: "22222222-2222-4222-8222-222222222222", filename: "slow.txt", mediaType: "text/plain", size: 4, status: "processing" as const, createdAt: "2026-01-01T00:00:00.000Z" };
    const slowReady = { ...slowQueued, status: "ready" as const };
    const physicalUploads = new Map<string, number>();
    let slowAttempts = 0;
    vi.spyOn(continuumApi, "uploadAndPrepareAttachment").mockImplementation(async (pending) => {
      if (!pending.remote) physicalUploads.set(pending.file.name, (physicalUploads.get(pending.file.name) ?? 0) + 1);
      if (pending.file.name === "good.txt") { pending.remote = good; return good; }
      slowAttempts += 1;
      if (slowAttempts === 1) { pending.remote = slowQueued; throw new ApiRequestError("Extraction is still running", "ATTACHMENT_TIMEOUT", true); }
      expect(pending.remote?.id).toBe(slowQueued.id);
      pending.remote = slowReady;
      return slowReady;
    });
    const saved = { ...demoBootstrap.events[0]!, id: "13333333-3333-4333-8333-333333333333", sequence: 1, content: "Analyze both files", attachments: [good, slowReady] };
    const create = vi.spyOn(continuumApi, "createMessage").mockResolvedValue({ event: saved, runId: "14444444-4444-4444-8444-444444444444" });
    vi.spyOn(continuumApi, "streamRun").mockResolvedValue({ lastEventId: "1", terminal: true });
    const user = userEvent.setup();
    const { container } = renderApp();
    const input = await screen.findByRole("textbox", { name: "Message Continuum" });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(["good"], "good.txt", { type: "text/plain" }), new File(["slow"], "slow.txt", { type: "text/plain" })] } });
    await user.type(input, "Analyze both files");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText(/Message kept as a draft/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]![0].attachmentIds).toEqual([good.id, slowReady.id]);
    expect(physicalUploads).toEqual(new Map([["good.txt", 1], ["slow.txt", 1]]));
  });

  it("reuses uploaded attachment IDs when saving the message fails before a run is created", async () => {
    vi.mocked(continuumApi.bootstrap).mockResolvedValue({
      ...demoBootstrap,
      runtime: { ...demoBootstrap.runtime, mode: "connected", apiReachable: true },
      events: [],
      activeRuns: []
    });
    const remote = { id: "15555555-5555-4555-8555-555555555555", sourceId: "25555555-5555-4555-8555-555555555555", filename: "retained.txt", mediaType: "text/plain", size: 8, status: "ready" as const, createdAt: "2026-01-01T00:00:00.000Z" };
    let physicalUploads = 0;
    vi.spyOn(continuumApi, "uploadAndPrepareAttachment").mockImplementation(async (pending) => {
      if (!pending.remote) physicalUploads += 1;
      pending.remote = remote;
      return remote;
    });
    const saved = { ...demoBootstrap.events[0]!, id: "16666666-6666-4666-8666-666666666666", sequence: 1, content: "Retain this upload", attachments: [remote] };
    const create = vi.spyOn(continuumApi, "createMessage")
      .mockRejectedValueOnce(new ApiRequestError("Local save failed", "SAVE_FAILED", true))
      .mockResolvedValueOnce({ event: saved, runId: "17777777-7777-4777-8777-777777777777" });
    vi.spyOn(continuumApi, "streamRun").mockResolvedValue({ lastEventId: "1", terminal: true });
    const user = userEvent.setup();
    const { container } = renderApp();
    const input = await screen.findByRole("textbox", { name: "Message Continuum" });
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(["retained"], "retained.txt", { type: "text/plain" })] } });
    await user.type(input, "Retain this upload");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(await screen.findByText(/Message kept as a draft/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls.map((call) => call[0].attachmentIds)).toEqual([[remote.id], [remote.id]]);
    expect(create.mock.calls[0]![0].idempotencyKey).toBe(create.mock.calls[1]![0].idempotencyKey);
    expect(physicalUploads).toBe(1);
  });

  it("loads provenance for the specific answer selected", async () => {
    const runId = demoBootstrap.events[1]!.runId!;
    const trace = { ...demoBootstrap.debug.trace!, runId };
    vi.mocked(continuumApi.bootstrap).mockResolvedValue({
      ...demoBootstrap,
      runtime: { ...demoBootstrap.runtime, mode: "connected", apiReachable: true },
      debug: { ...demoBootstrap.debug, trace: null },
      activeMemories: []
    });
    const traceSpy = vi.spyOn(continuumApi, "getRetrievalTrace").mockResolvedValue(trace);
    const debugSpy = vi.spyOn(continuumApi, "getRunDebug").mockResolvedValue({ ...demoBootstrap.debug, trace, contextPacket: demoBootstrap.debug.contextPacket ? { ...demoBootstrap.debug.contextPacket, runId } : null });
    const user = userEvent.setup();
    renderApp();
    await screen.findByText(/We decided to keep every conversation event/i);
    await user.click(screen.getByRole("button", { name: /inspect this answer.*provenance/i }));
    expect(traceSpy).toHaveBeenCalledWith(runId);
    expect(debugSpy).toHaveBeenCalledWith(runId);
    expect(await screen.findByText(`“${trace.query}”`)).toBeVisible();
    expect(screen.getByText("sha256:demo-context-packet")).toBeVisible();
  });

  it("refreshes a cached partial debug snapshot when answer provenance opens", async () => {
    const runId = demoBootstrap.events[1]!.runId!;
    const trace = { ...demoBootstrap.debug.trace!, runId };
    vi.mocked(continuumApi.bootstrap).mockResolvedValue({
      ...demoBootstrap,
      runtime: { ...demoBootstrap.runtime, mode: "connected", apiReachable: true },
      debug: { ...demoBootstrap.debug, trace, contextPacket: null },
      activeMemories: demoBootstrap.activeMemories
    });
    vi.spyOn(continuumApi, "getRetrievalTrace").mockResolvedValue(trace);
    const debugSpy = vi.spyOn(continuumApi, "getRunDebug").mockResolvedValue({
      ...demoBootstrap.debug,
      trace,
      contextPacket: demoBootstrap.debug.contextPacket
        ? { ...demoBootstrap.debug.contextPacket, runId, hash: "sha256:fresh-reference-reconstruction", renderedContent: "Fresh exact packet" }
        : null
    });
    const user = userEvent.setup();
    renderApp();
    await screen.findByText(/We decided to keep every conversation event/i);
    await user.click(screen.getByRole("button", { name: /inspect this answer.*provenance/i }));
    await waitFor(() => expect(debugSpy).toHaveBeenCalledWith(runId));
    expect(await screen.findByText("sha256:fresh-reference-reconstruction")).toBeVisible();
  });

  it("shows truthful offline state with no substituted vault content", async () => {
    vi.mocked(continuumApi.bootstrap).mockResolvedValue({
      ...demoBootstrap,
      runtime: { mode: "offline", apiReachable: false, providerReachable: false, vectorSearch: "unavailable", memoryQueue: "paused", message: "Local service unavailable" },
      events: [], topics: [], claims: [], activeMemories: [], graph: { nodes: [], edges: [], focusId: null, truncated: false },
      debug: { trace: null, contextPacket: null, modelCalls: [], toolCalls: [], jobs: [], promptVersion: "—", schemaVersion: "—", versions: { prompt: "—", schema: "—", retrieval: "—", reranker: "—", contextBuilder: "—", vector: "—", parser: "—", chunker: "—", responseModel: "—", embeddingModel: "—" } }
    });
    renderApp();
    expect(await screen.findByText("Vault data is unavailable")).toBeVisible();
    expect(screen.queryByText(demoBootstrap.events[0]!.content)).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Message Continuum" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(screen.getByText(/drafts stay in this browser/i)).toBeVisible();
  });
});
