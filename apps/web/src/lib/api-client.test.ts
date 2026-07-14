import { afterEach, describe, expect, it, vi } from "vitest";

import { ContinuumApi, consumeSseStream, parseSseBlock, parseSseFrame } from "./api-client";
import { demoBootstrap } from "./demo-data";

describe("SSE parsing", () => {
  it("combines multi-line data fields and ignores event metadata", () => {
    expect(parseSseBlock("event: message\nid: 12\ndata: {\"hello\":\ndata: \"world\"}"))
      .toBe('{"hello":\n"world"}');
    expect(parseSseFrame("event: message\nid: 12\ndata: ok")).toEqual({ id: "12", data: "ok" });
  });

  it("validates events across arbitrary byte boundaries", async () => {
    const encoder = new TextEncoder();
    const payload = 'id: 1\ndata: {"version":"v1","type":"run.started","runId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}\n\nid: 2\ndata: {"version":"v1","type":"run.cancelled","runId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}\n\n';
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(payload.slice(0, 19)));
        controller.enqueue(encoder.encode(payload.slice(19, 81)));
        controller.enqueue(encoder.encode(payload.slice(81)));
        controller.close();
      }
    });
    const events: string[] = [];
    await consumeSseStream(new Response(body), { onEvent: (event) => events.push(event.type) });
    expect(events).toEqual(["run.started", "run.cancelled"]);
  });

  it("reports malformed messages without ending a healthy stream", async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('id: 1\ndata: nope\n\nid: 2\ndata: {"version":"v1","type":"run.started","runId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}\n\n')); controller.close(); } });
    const malformed = vi.fn(); const received = vi.fn();
    await consumeSseStream(new Response(body), { onEvent: received, onMalformed: malformed });
    expect(malformed).toHaveBeenCalledWith("nope");
    expect(received).toHaveBeenCalledOnce();
  });

  it("dispatches the final event when the stream closes without a blank-line terminator", async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('id: 1\ndata: {"version":"v1","type":"run.cancelled","runId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}')); controller.close(); } });
    const received = vi.fn();
    await consumeSseStream(new Response(body), { onEvent: received });
    expect(received.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ type: "run.cancelled" }));
  });

  it("stops dispatching immediately after the first terminal frame", async () => {
    const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const payload = `id: 1\ndata: {"version":"v1","type":"run.cancelled","runId":"${runId}"}\n\nid: 2\ndata: {"version":"v1","type":"run.started","runId":"${runId}"}\n\n`;
    const received = vi.fn();
    const result = await consumeSseStream(new Response(payload), { onEvent: received });
    expect(received).toHaveBeenCalledTimes(1);
    expect(received.mock.calls[0]?.[0]).toMatchObject({ type: "run.cancelled" });
    expect(result).toEqual({ lastEventId: "1", terminal: true });
  });

  it("reconnects a dropped stream from Last-Event-ID without applying a replayed delta twice", async () => {
    const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const eventId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const firstPayload = `id: 101\nevent: v1\ndata: {"version":"v1","type":"response.delta","runId":"${runId}","eventId":"${eventId}","delta":"once"}\n\n`;
    const secondPayload = `id: 101\nevent: v1\ndata: {"version":"v1","type":"response.delta","runId":"${runId}","eventId":"${eventId}","delta":"once"}\n\nid: 102\nevent: v1\ndata: {"version":"v1","type":"run.cancelled","runId":"${runId}"}\n\n`;
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(firstPayload))
      .mockResolvedValueOnce(new Response(secondPayload));
    const chunks: string[] = [];
    const cursors: string[] = [];
    const reconnects = vi.fn();
    const result = await new ContinuumApi("/api/v1").streamRun(runId, {
      onEvent: (event) => { if (event.type === "response.delta") chunks.push(event.delta); },
      onCursor: (id) => cursors.push(id),
      onReconnect: reconnects
    }, undefined, { reconnectBaseDelayMs: 0, reconnectMaximumDelayMs: 0 });
    expect(chunks.join("")).toBe("once");
    expect(cursors).toEqual(["101", "102"]);
    expect(result).toEqual({ lastEventId: "102", terminal: true });
    expect(reconnects).toHaveBeenCalledWith({ attempt: 1, lastEventId: "101" });
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Last-Event-ID")).toBe("101");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("ContinuumApi security headers", () => {
  it("aborts in-flight vault reads when the vault scope is reset", async () => {
    let requestSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      requestSignal = init?.signal ?? undefined;
      const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
      if (requestSignal?.aborted) abort(); else requestSignal?.addEventListener("abort", abort, { once: true });
    }));
    const api = new ContinuumApi("/api/v1");
    const pending = api.getEvent("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

    api.resetVaultReadScope();

    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT", retryable: true });
    expect(requestSignal?.aborted).toBe(true);
  });

  it("does not expose a client operation that can renew the lifetime budget", () => {
    const api = new ContinuumApi("/api/v1");
    expect(api).not.toHaveProperty("budgetResetImpact");
    expect(api).not.toHaveProperty("resetBudgetCycle");
  });

  it("persists prompt tracing independently under the explicit promptTracing setting", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ key: "promptTracing.enabled", value: true }));
    const api = new ContinuumApi("/api/v1");
    await api.saveSettings({ promptTracingEnabled: true });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ key: "promptTracing.enabled", value: true });
    expect(body.key).not.toBe("developer.traceMode");
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Idempotency-Key")).toBe(body.idempotencyKey);
  });

  it("uses credentialed cookies and marks every setting mutation", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ key: "memory.enabled", value: false }));
    const api = new ContinuumApi("http://127.0.0.1:4317/api/v1");
    await api.saveSettings({ memoryPaused: true });
    const [, options] = fetchMock.mock.calls[0]!;
    expect(options?.credentials).toBe("include");
    expect(new Headers(options?.headers).get("X-Continuum-Request")).toBe("1");
    expect(JSON.parse(String(options?.body))).toMatchObject({ key: "memory.enabled", value: false });
  });

  it("creates exports with a guarded POST before starting the local download", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({
      filename: "continuum-export.zip",
      size: 42,
      checksum: "abc",
      downloadUrl: "/api/v1/export/continuum-export.zip"
    }));
    const api = new ContinuumApi("/api/v1");
    await expect(api.exportVault({ attachments: true, toolOutputs: false })).resolves.toMatchObject({ filename: "continuum-export.zip" });
    const [, options] = fetchMock.mock.calls[0]!;
    expect(options?.method).toBe("POST");
    expect(new Headers(options?.headers).get("X-Continuum-Request")).toBe("1");
    const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ includeAttachments: true, includeSensitiveToolOutput: false });
    expect(new Headers(options?.headers).get("Idempotency-Key")).toBe(body.idempotencyKey);
    expect(click).toHaveBeenCalledOnce();
    expect(click.mock.instances[0]).toMatchObject({ download: "continuum-export.zip" });
  });

  it("requires a fresh vault impact token for full deletion", async () => {
    const impact = {
      confirmationToken: "a".repeat(64), requiredPhrase: "DELETE MY CONTINUUM VAULT" as const,
      events: 3, attachments: 1, claimsRemoved: 2, claimsRetained: 0, topicsRebuilt: 0, edgesRemoved: 4, managedBackupsAffected: 1
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json(impact)).mockResolvedValueOnce(json({ destroyed: true, keyRetainedInKeychain: true }));
    const api = new ContinuumApi("/api/v1");
    await expect(api.vaultDeletionImpact()).resolves.toEqual(impact);
    await api.destroyVault(impact.requiredPhrase, impact.confirmationToken);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/vault/deletion-impact");
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("DELETE");
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ confirmation: impact.requiredPhrase, confirmationToken: impact.confirmationToken });
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Idempotency-Key")).toBe(body.idempotencyKey);
  });

  it("reviews current claim impact before hard deletion", async () => {
    const claimId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const impact = { confirmationToken: "b".repeat(64), events: 0, attachments: 0, claimsRemoved: 1, claimsRetained: 0, topicsRebuilt: 1, edgesRemoved: 2, managedBackupsAffected: 1 };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json(impact)).mockResolvedValueOnce(json({ deleted: true }));
    const api = new ContinuumApi("/api/v1");
    await expect(api.deletionImpact("claims", claimId)).resolves.toEqual(impact);
    await api.confirmDeletion("claims", claimId, impact.confirmationToken);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/claims/${claimId}/deletion-impact`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("DELETE");
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ confirmationToken: impact.confirmationToken });
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Idempotency-Key")).toBe(body.idempotencyKey);
  });

  it("uses header idempotency for attachment uploads and each vault import operation", async () => {
    const attachment = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", filename: "note.txt", mediaType: "text/plain", size: 4, status: "queued", createdAt: "2026-01-01T00:00:00.000Z" };
    const verificationToken = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(attachment))
      .mockResolvedValueOnce(json({ valid: true, replaced: false, manifest: {}, verificationToken, archiveChecksum: "a".repeat(64), size: 6, expiresAt: "2026-01-01T01:00:00.000Z" }))
      .mockResolvedValueOnce(json({ valid: true, replaced: true, mode: "replace", manifest: {}, attachmentsRestored: 0, rebuildJobs: 0, warnings: [] }));
    const api = new ContinuumApi("/api/v1");
    await api.uploadAttachment({ localId: "local", idempotencyKey: "attachment-upload-test-key", file: new File(["note"], "note.txt", { type: "text/plain" }), status: "pending" });
    await api.verifyVaultImport(new File(["bundle"], "continuum.zip", { type: "application/zip" }));
    await api.commitVerifiedVaultImport(verificationToken, "replace");
    const uploadOptions = fetchMock.mock.calls[0]?.[1];
    expect(uploadOptions?.body).toBeInstanceOf(FormData);
    expect(new Headers(uploadOptions?.headers).get("Idempotency-Key")).toBe("attachment-upload-test-key");
    const importOptions = fetchMock.mock.calls[1]?.[1];
    expect(importOptions?.body).toBeInstanceOf(FormData);
    expect(new Headers(importOptions?.headers).get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    const commit = fetchMock.mock.calls[2]?.[1];
    expect(JSON.parse(String(commit?.body))).toMatchObject({ verificationToken, mode: "replace" });
    expect(new Headers(commit?.headers).get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("removes provider credentials through an idempotent guarded delete", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ configured: false }));
    await new ContinuumApi("/api/v1").removeApiKey();
    const [, options] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
    expect(options?.method).toBe("DELETE");
    expect(new Headers(options?.headers).get("Idempotency-Key")).toBe(body.idempotencyKey);
  });

  it("creates an exact one-use workspace secret approval only with acknowledgement", async () => {
    const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const expiresAt = "2026-07-13T12:05:00.000Z";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ approval: { id: "approval-1", workspaceId, relativePath: "config/private.env", expiresAt, remainingUses: 1, status: "ready" } }));
    const approval = await new ContinuumApi("/api/v1").approveWorkspaceSecretFile(workspaceId, "config/private.env");
    expect(approval).toMatchObject({ workspaceId, relativePath: "config/private.env", expiresAt, remainingUses: 1, oneUse: true, status: "ready" });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/workspaces/${workspaceId}/secret-approvals`);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ relativePath: "config/private.env", acknowledgement: true });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Idempotency-Key")).toBe(body.idempotencyKey);
  });

  it("recovers committed message, upload, and regeneration results after their mutation responses are lost", async () => {
    const messageKey = "lost-message-response-key";
    const uploadKey = "lost-upload-response-key";
    const regenerationKey = "lost-regeneration-response-key";
    const runId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const regenerationRunId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const event = { ...demoBootstrap.events[0]!, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", sequence: 1, content: "Committed once", attachments: [] };
    const attachment = { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", sourceId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", filename: "note.txt", mediaType: "text/plain", size: 4, status: "queued" as const, createdAt: "2026-01-01T00:00:00.000Z" };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("response lost after commit"))
      .mockResolvedValueOnce(json({ found: true, operation: "messages.create", result: { event, runId } }))
      .mockRejectedValueOnce(new TypeError("upload response lost after commit"))
      .mockResolvedValueOnce(json({ found: true, operation: "attachments.upload", result: attachment }))
      .mockRejectedValueOnce(new TypeError("regeneration response lost after commit"))
      .mockResolvedValueOnce(json({ found: true, operation: "events.regenerate", result: { runId: regenerationRunId, quality: "deep" } }));
    const api = new ContinuumApi("/api/v1");

    await expect(api.createMessage({ content: event.content, attachmentIds: [], quality: "balanced", idempotencyKey: messageKey })).resolves.toEqual({ event, runId });
    await expect(api.uploadAttachment({ localId: "upload", idempotencyKey: uploadKey, file: new File(["note"], "note.txt", { type: "text/plain" }), status: "pending" })).resolves.toEqual(attachment);
    await expect(api.regenerate(event.id, regenerationKey)).resolves.toEqual({ runId: regenerationRunId, quality: "deep" });

    for (const [index, operation, key] of [[1, "messages.create", messageKey], [3, "attachments.upload", uploadKey], [5, "events.regenerate", regenerationKey]] as const) {
      const [url, options] = fetchMock.mock.calls[index]!;
      expect(String(url)).toContain(`/idempotency-recovery?operation=${encodeURIComponent(operation)}&key=${encodeURIComponent(key)}`);
      expect(options?.method ?? "GET").toBe("GET");
      expect(new Headers(options?.headers).get("X-Continuum-Request")).toBeNull();
    }
  });
});

describe("ContinuumApi live integration mapping", () => {
  it("returns an explicit empty offline shell instead of fictional demo vault data", async () => {
    localStorage.setItem("continuum.ui-settings", JSON.stringify({ theme: "dark" }));
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("connection refused"));
    const result = await new ContinuumApi("http://127.0.0.1:4317/api/v1").bootstrap();
    expect(result.runtime).toMatchObject({ mode: "offline", apiReachable: false });
    expect(result.settings.theme).toBe("dark");
    expect(result.events).toEqual([]);
    expect(result.topics).toEqual([]);
    expect(result.debug.trace).toBeNull();
  });

  it("maps canonical bootstrap envelopes without leaking preview data into a connected vault", async () => {
    const event = { id: "11111111-1111-4111-8111-111111111111", sequence: 1, role: "user", kind: "message", status: "complete", content: "Live event", parentEventId: null, runId: null, active: true, createdAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:00.000Z", attachments: [] };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/health")) return json({ status: "ok", providerConfigured: true, worker: { queuedJobs: 0 }, database: { vectorMode: "bounded-cosine-fallback", schemaVersion: 7 }, version: "0.1.0" });
      if (url.endsWith("/runtime")) return json({ mockProvider: false, vectorMode: "bounded-cosine-fallback" });
      if (url.endsWith("/settings")) return json({ settings: { theme: "dark", quality: "deep", memoryPaused: true, webSearchEnabled: false, onboardingComplete: true }, raw: { "memory.enabled": false } });
      if (url.endsWith("/budget")) return json({ hardLimitUsd: 100, spentUsd: 2.5, reservedUsd: 0.75, allocatedUsd: 3.25, availableUsd: 96.75, activeReservations: 2, inputTokens: 123, outputTokens: 45, extractionTokens: 67, embeddingTokens: 89, warningThresholdUsd: 75 });
      if (url.includes("/events?")) return json({ events: [event], nextCursor: null });
      if (url.includes("/topics?")) return json({ topics: [], nextCursor: null });
      if (url.includes("/claims?")) return json({ claims: [], nextCursor: null });
      if (url.includes("/graph?")) return json({ nodes: [], edges: [], focusId: null, truncated: false });
      if (url.endsWith("/model-calls?limit=20")) return json({ calls: [] });
      if (url.endsWith("/memory-jobs")) return json({ jobs: [] });
      if (url.endsWith("/memories/lint")) return json({ issues: [] });
      if (url.endsWith("/memories/pins")) return json({ pins: [] });
      return json({ error: { message: "No trace yet" } }, 404);
    });
    const result = await new ContinuumApi("http://127.0.0.1:4317/api/v1").bootstrap();
    expect(result.runtime).toMatchObject({ mode: "connected", apiReachable: true, providerReachable: true, vectorSearch: "fallback" });
    expect(result.settings).toMatchObject({ theme: "dark", quality: "deep", memoryPaused: true, webSearchEnabled: false });
    expect(result.events).toEqual([event]);
    expect(result.budget).toMatchObject({ totalUsd: 2.5, reservedUsd: 0.75, allocatedUsd: 3.25, availableUsd: 96.75, activeReservations: 2, capUsd: 100, inputTokens: 123, outputTokens: 45, extractionTokens: 67, embeddingTokens: 89, warningThresholdUsd: 75 });
  });

  it("waits for attachment extraction before returning a message-safe ID", async () => {
    vi.useFakeTimers();
    const attachment = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", filename: "notes.txt", mediaType: "text/plain", size: 5, status: "queued", createdAt: "2026-01-01T00:00:00.000Z" } as const;
    let reads = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, options) => {
      if (options?.method === "POST") return json(attachment, 202);
      reads += 1;
      return json({ ...attachment, status: reads > 1 ? "ready" : "processing" });
    });
    const api = new ContinuumApi("http://127.0.0.1:4317/api/v1");
    const promise = api.uploadAndPrepareAttachment({ localId: "local", idempotencyKey: "wait-for-ready-key", file: new File(["hello"], "notes.txt", { type: "text/plain" }), status: "uploading" });
    await vi.advanceTimersByTimeAsync(2_100);
    await expect(promise).resolves.toMatchObject({ status: "ready" });
    expect(reads).toBe(2);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("X-Continuum-Request")).toBe("1");
  });

  it("resumes a durable uploaded attachment on retry instead of posting duplicate bytes", async () => {
    const queued = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", filename: "slow.pdf", mediaType: "application/pdf", size: 25_000_000, status: "queued", createdAt: "2026-01-01T00:00:00.000Z" } as const;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ ...queued, status: "ready" }));
    const api = new ContinuumApi("http://127.0.0.1:4317/api/v1");
    const pending = { localId: "local", idempotencyKey: "resume-upload-key", file: new File(["pdf"], "slow.pdf", { type: "application/pdf" }), status: "pending" as const, remote: queued };
    await expect(api.uploadAndPrepareAttachment(pending)).resolves.toMatchObject({ id: queued.id, status: "ready" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method ?? "GET").toBe("GET");
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/attachments/${queued.id}`);
  });

  it("requires deliberate reattachment after terminal extraction instead of replaying a failed upload key", async () => {
    const failed = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", filename: "broken.pdf", mediaType: "application/pdf", size: 6, status: "failed" as const, createdAt: "2026-01-01T00:00:00.000Z" };
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const pending = { localId: "local", idempotencyKey: "terminal-upload-key", file: new File(["broken"], "broken.pdf", { type: "application/pdf" }), status: "failed" as const, remote: failed };

    await expect(new ContinuumApi("/api/v1").uploadAndPrepareAttachment(pending)).rejects.toMatchObject({ code: "ATTACHMENT_REATTACH_REQUIRED", retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(pending.idempotencyKey).toBe("terminal-upload-key");
  });

  it("pins by object identity and unpins by the durable pin ID", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }))
      .mockResolvedValueOnce(json({ deleted: true }));
    const api = new ContinuumApi("http://127.0.0.1:4317/api/v1");
    const memory = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", type: "topic" as const, title: "Architecture" };
    await api.setPinned(memory, true);
    await api.setPinned({ ...memory, pinId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, false);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ objectType: "topic", objectId: memory.id, label: "Architecture" });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/memories/pins/cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("DELETE");
  });

  it("loads provenance and persisted revision controls by answer identity", async () => {
    const trace = demoBootstrap.debug.trace!;
    const revision = { event: demoBootstrap.events[1]!, revisionNumber: 2, active: true, quality: "deep" as const };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(trace))
      .mockResolvedValueOnce(json({ revisions: [revision], items: [revision], nextCursor: null }))
      .mockResolvedValueOnce(json({ event: revision.event }))
      .mockResolvedValueOnce(json({ cancelled: true }));
    const api = new ContinuumApi("http://127.0.0.1:4317/api/v1");
    await expect(api.getRetrievalTrace(trace.runId)).resolves.toEqual(trace);
    await expect(api.getEventRevisions(revision.event.id)).resolves.toMatchObject({ revisions: [revision] });
    await expect(api.activateEventRevision(revision.event.id)).resolves.toEqual({ event: revision.event });
    await expect(api.cancelRun(trace.runId)).resolves.toEqual({ cancelled: true });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/retrieval-traces/${trace.runId}`);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(`/events/${revision.event.id}/revisions`);
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBe("PATCH");
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain(`/events/${revision.event.id}/activate`);
    expect(fetchMock.mock.calls[3]?.[1]?.method).toBe("POST");
  });

  it("normalizes answer-specific context, cache, tool, and version diagnostics", async () => {
    const runId = demoBootstrap.debug.trace!.runId;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({
      contextPacket: { id: "packet", runId, orderedSourceIds: ["source-a", "source-b"], contentHash: "sha256:packet", renderedContent: "exact packet", promptVersion: "prompt@2", tokenBudget: { instructions: 10, recentTurns: 20, evidence: 30, reservedOutput: 40, maximumInput: 100 } },
      modelCalls: [{ id: "call", runId, purpose: "response", model: "gpt-test", latencyMs: 50, inputTokens: 60, cachedInputTokens: 25, outputTokens: 7, estimatedCostUsd: .01, status: "complete", traceMetadata: { retrievalVersion: "retrieval@2" } }],
      toolExecutions: [{ id: "tool", runId, toolName: "workspace.read_file", argumentsJson: "{\"path\":\"README.md\"}", outputJson: "{\"bytes\":42}", status: "complete", durationMs: 4, sandboxJson: "{\"network\":\"denied\"}" }],
      versions: { prompt: "prompt@2", schema: "schema@4", retrieval: "retrieval@2", reranker: "reranker@1", contextBuilder: "builder@3", responseModel: "gpt-test", embeddingModel: "embedding@1" }
    }));
    const debug = await new ContinuumApi("/api/v1").getRunDebug(runId);
    expect(debug.contextPacket).toMatchObject({ orderedSourceIds: ["source-a", "source-b"], hash: "sha256:packet", renderedContent: "exact packet", tokenBudget: { maximumInput: 100 } });
    expect(debug.modelCalls[0]).toMatchObject({ cachedInputTokens: 25, retrievalVersion: "retrieval@2" });
    expect(debug.toolCalls[0]).toMatchObject({ name: "workspace.read_file", arguments: { path: "README.md" }, output: { bytes: 42 }, sandbox: { network: "denied" } });
    expect(debug.versions).toMatchObject({ prompt: "prompt@2", schema: "schema@4", contextBuilder: "builder@3" });
  });

  it("lists and resolves topic proposals with an idempotent explicit action", async () => {
    const proposalId = "proposal-1";
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ proposals: [{ id: proposalId, kind: "topic_split", topicId: "topic-1", title: "Split architecture page", reason: "Page is oversized", proposedAt: "2026-07-13T12:00:00.000Z", proposedRevision: { summary: "Index" }, affectedTopicIds: ["topic-1", "topic-2"] }] }))
      .mockResolvedValueOnce(json({ resolved: true }));
    const api = new ContinuumApi("/api/v1");
    await expect(api.listMemoryProposals()).resolves.toEqual([expect.objectContaining({
      id: proposalId,
      kind: "topic_split",
      affectedTopicIds: ["topic-1", "topic-2"],
      canAccept: false,
      acceptanceBlockedReason: expect.stringMatching(/exact claim, evidence, content, and route guards/i)
    })]);
    await api.resolveMemoryProposal(proposalId, "accept");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(`/memory-proposals/${proposalId}/resolve`);
    const body = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ action: "accept" });
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Idempotency-Key")).toBe(body.idempotencyKey);
  });

  it("normalizes bounded shard patches without hiding archived or split ranges", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ proposals: [{
      schemaVersion: 2,
      id: "a".repeat(64),
      groupId: "a".repeat(64),
      kind: "topic_shard_patch",
      topicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Architecture",
      parentBase: { revisionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", revision: 4, fingerprint: "b".repeat(64) },
      patches: [
        {
          section: "current_state",
          base: { topicId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
          outputs: [
            { topicId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
            { topicId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }
          ]
        },
        { section: "history", base: { topicId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }, outputs: [] }
      ],
      claimIds: ["ffffffff-ffff-4fff-8fff-ffffffffffff"],
      sourceIds: ["11111111-1111-4111-8111-111111111111"],
      requiresConfirmation: true,
      createdAt: "2026-07-13T12:00:00.000Z"
    }] }));

    const [proposal] = await new ContinuumApi("/api/v1").listMemoryProposals();
    expect(proposal).toMatchObject({
      kind: "topic_patch",
      canAccept: true,
      affectedTopicIds: [
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
      ]
    });
    expect(proposal?.description).toMatch(/2 evidence-linked ranges with 2 proposed pages and archive 1 emptied range/i);
    expect(proposal?.reason).toMatch(/active revision and evidence routes remain unchanged/i);
  });

  it("keeps explicit demo search isolated from a connected live vault", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const filters = { types: [], role: "all", status: "all", date: "all", source: "", tag: "" } as const;
    const result = await new ContinuumApi("http://127.0.0.1:4317/api/v1").search("raw timeline", { ...filters, types: [] }, undefined, true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.results.length).toBeGreaterThan(0);
  });

  it("refreshes every durable-memory surface after compilation", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/topics?")) return json({ topics: [], items: [], nextCursor: null });
      if (url.includes("/claims?")) return json({ claims: [], items: [], nextCursor: null });
      if (url.includes("/graph?")) return json({ nodes: [], edges: [], focusId: null, truncated: false });
      if (url.includes("/memory-jobs?")) {
        const jobs = [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", type: "memory.compile", status: "running", attempts: 1, updatedAt: "2026-01-01T00:00:00.000Z", payload: { runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, lastErrorCode: null }];
        return json({ jobs, items: jobs, nextCursor: null });
      }
      return json({}, 404);
    });
    const result = await new ContinuumApi("http://127.0.0.1:4317/api/v1").refreshMemoryState();
    expect(result).toMatchObject({ topics: [], claims: [], graph: { nodes: [], edges: [] }, jobs: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "running", runId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", lastErrorCode: null }] });
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual(expect.arrayContaining([
      expect.stringContaining("/topics?"), expect.stringContaining("/claims?"), expect.stringContaining("/graph?"), expect.stringContaining("/memory-jobs")
    ]));
  });

  it("uses explicit mutation contracts for correction, entity merge reversal, and workspace revocation", async () => {
    const sourceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const targetId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const mergeId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const envelope = { impact: { sourceId, targetId, sourceName: "Acme", targetName: "ACME", type: "organization", aliasesMoved: 2, edgesRewritten: 3, reversible: true }, confirmationToken: "d".repeat(64) };
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ type: "claim", id: sourceId, record: {} }))
      .mockResolvedValueOnce(json({ claim: demoBootstrap.claims[0], evidence: [], relations: [] }))
      .mockResolvedValueOnce(json({ event: demoBootstrap.events[0], claim: demoBootstrap.claims[0], supersededClaimId: sourceId }))
      .mockResolvedValueOnce(json({ candidates: [{ ...envelope.impact, score: 0.9, reason: "similar names" }], items: [{ ...envelope.impact, score: 0.9, reason: "similar names" }], nextCursor: null }))
      .mockResolvedValueOnce(json(envelope))
      .mockResolvedValueOnce(json({ mergeId, sourceId, targetId }))
      .mockResolvedValueOnce(json({ mergeId, sourceId, targetId, reversedAt: new Date().toISOString() }))
      .mockResolvedValueOnce(json({ revoked: true }));
    const api = new ContinuumApi("/api/v1");
    await api.getEvidence(sourceId);
    await api.getClaimDetail(sourceId);
    await api.correctClaim(sourceId, "Correct value", "User verified it");
    await api.listEntityMergeCandidates();
    await api.entityMergeImpact(sourceId, targetId);
    await api.mergeEntities(envelope);
    await api.reverseEntityMerge(mergeId);
    await api.revokeWorkspace(sourceId);
    const calls = fetchMock.mock.calls;
    expect(String(calls[0]?.[0])).toContain(`/evidence/${sourceId}`);
    expect(JSON.parse(String(calls[2]?.[1]?.body))).toMatchObject({ value: "Correct value", reason: "User verified it" });
    expect(JSON.parse(String(calls[5]?.[1]?.body))).toMatchObject({ sourceId, targetId, confirmationToken: envelope.confirmationToken });
    expect(String(calls[6]?.[0])).toContain(`/entities/merges/${mergeId}/reverse`);
    expect(calls[7]?.[1]?.method).toBe("DELETE");
    for (const index of [2, 4, 5, 6, 7]) expect(new Headers(calls[index]?.[1]?.headers).get("X-Continuum-Request")).toBe("1");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}
