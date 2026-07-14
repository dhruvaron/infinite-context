import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { link, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BasicPdfExtractor,
  FileSystemContentAddressedStore,
  IngestionError,
  IngestionService,
  MacPdfKitExtractor,
  MacVisionOcrAdapter,
  createMacProviderThumbnail,
  chunkCodeSymbols,
  decodeUtf8Strict,
  extractCsvDocument,
  extractImageDocument,
  extractJsonDocument,
  extractPdfDocument,
  extractTextDocument,
  macNativeIngestionStatus,
  sha256,
  validateAttachmentPolicy,
  validateMessageAttachments
} from "../src/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "continuum-ingestion-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

type StoreChildMessage = {
  phase: string;
  role: string;
  pid: number;
  result?: { sha256: string; deduplicated: boolean };
  error?: { name: string; message: string; stack?: string };
};

const CONTENT_STORE_CHILD_SCRIPT = String.raw`
const [moduleUrl, root, encodedBytes, role] = process.argv.slice(1);
const { FileSystemContentAddressedStore } = await import(moduleUrl);
const bytes = Buffer.from(encodedBytes, "base64");

function send(phase, extra = {}) {
  return new Promise((resolve, reject) => {
    if (!process.send) return reject(new Error("content-store fixture IPC is unavailable"));
    process.send({ phase, role, pid: process.pid, ...extra }, (error) => error ? reject(error) : resolve());
  });
}

function waitFor(action) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("timed out waiting for parent action " + action)), 10_000);
    const onMessage = (message) => {
      if (!message || message.action !== action) return;
      finish();
    };
    const onDisconnect = () => finish(new Error("parent disconnected while waiting for " + action));
    function finish(error) {
      clearTimeout(timeout);
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
      if (error) reject(error);
      else resolve();
    }
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
  });
}

let preScanPaused = false;
let staleRemovalPaused = false;
let yieldPaused = false;
let liveOwnerPaused = false;
let liveStaleOwnerPaused = false;
const hooks = {
  async afterReclaimBarrierPreScan({ liveBarrier }) {
    if (role !== "successor" || liveBarrier || preScanPaused) return;
    preScanPaused = true;
    await send("successor-pre-scan");
    await waitFor("resume-pre-scan");
  },
  async afterStaleHashLockRemoved() {
    if (role !== "reclaimer" || staleRemovalPaused) return;
    staleRemovalPaused = true;
    await send("stale-lock-removed-with-live-barrier");
    await waitFor("resume-reclaimer");
  },
  async afterHashLockYieldedToReclaimBarrier() {
    if (role !== "successor" || yieldPaused) return;
    yieldPaused = true;
    await send("successor-yielded-after-post-scan");
    await waitFor("resume-after-yield");
  },
  async afterLiveHashLockObserved() {
    if (role === "reclaimer" && !liveStaleOwnerPaused) {
      liveStaleOwnerPaused = true;
      await send("reclaimer-observed-live-stale-owner");
      await waitFor("resume-after-stale-owner-exit");
    } else if (role === "successor" && !liveOwnerPaused) {
      liveOwnerPaused = true;
      await send("successor-observed-live-owner");
      await waitFor("resume-after-live-owner");
    }
  },
  async beforeHashOperation() {
    await send("operation-enter");
    await waitFor("resume-operation");
  }
};

try {
  const store = new FileSystemContentAddressedStore(root, hooks);
  const result = await store.put(bytes);
  await send("complete", { result });
  if (process.connected) process.disconnect();
} catch (error) {
  const value = error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { name: "UnknownError", message: String(error) };
  try { await send("error", { error: value }); } catch {}
  process.exitCode = 1;
  if (process.connected) process.disconnect();
}
`;

function spawnStoreChild(input: {
  root: string;
  bytes: Uint8Array;
  role: "reclaimer" | "successor";
}) {
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "-e",
    CONTENT_STORE_CHILD_SCRIPT,
    new URL("../src/content-store.ts", import.meta.url).href,
    input.root,
    Buffer.from(input.bytes).toString("base64"),
    input.role
  ], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "pipe", "ipc"]
  });
  const pending: StoreChildMessage[] = [];
  const waiters: Array<{
    phase: string;
    resolve: (message: StoreChildMessage) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = [];
  const seenPhases: string[] = [];
  let stderr = "";
  let exited = false;
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  child.on("message", (rawMessage) => {
    if (!rawMessage || typeof rawMessage !== "object" || !("phase" in rawMessage)) return;
    const message = rawMessage as StoreChildMessage;
    if (typeof message.phase !== "string") return;
    seenPhases.push(message.phase);
    if (message.phase === "error") {
      const error = new Error(`${input.role} fixture failed: ${message.error?.message ?? "unknown error"}${stderr ? `\n${stderr}` : ""}`);
      while (waiters.length) {
        const waiter = waiters.pop()!;
        clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
      pending.push(message);
      return;
    }
    const waiterIndex = waiters.findIndex((waiter) => waiter.phase === message.phase);
    if (waiterIndex === -1) pending.push(message);
    else {
      const [waiter] = waiters.splice(waiterIndex, 1);
      clearTimeout(waiter!.timeout);
      waiter!.resolve(message);
    }
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once("exit", (code, signal) => {
      exited = true;
      if (code !== 0 && waiters.length) {
        const error = new Error(`${input.role} fixture exited before its expected phase (code=${code}, signal=${signal})${stderr ? `\n${stderr}` : ""}`);
        while (waiters.length) {
          const waiter = waiters.pop()!;
          clearTimeout(waiter.timeout);
          waiter.reject(error);
        }
      }
      resolveExit({ code, signal });
    });
  });
  return {
    child,
    seenPhases,
    waitFor(phase: string, timeoutMs = 10_000): Promise<StoreChildMessage> {
      const queuedIndex = pending.findIndex((message) => message.phase === phase);
      if (queuedIndex !== -1) return Promise.resolve(pending.splice(queuedIndex, 1)[0]!);
      if (exited) return Promise.reject(new Error(`${input.role} fixture exited before phase ${phase}${stderr ? `\n${stderr}` : ""}`));
      return new Promise((resolveMessage, rejectMessage) => {
        const waiter = {
          phase,
          resolve: resolveMessage,
          reject: rejectMessage,
          timeout: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index !== -1) waiters.splice(index, 1);
            rejectMessage(new Error(`timed out waiting for ${input.role} phase ${phase}${stderr ? `\n${stderr}` : ""}`));
          }, timeoutMs)
        };
        waiters.push(waiter);
      });
    },
    send(action: string): void {
      child.send({ action });
    },
    async expectCleanExit(): Promise<void> {
      const outcome = await exit;
      expect(outcome).toEqual({ code: 0, signal: null });
    },
    async stop(): Promise<void> {
      if (!exited) child.kill("SIGKILL");
      await exit;
    }
  };
}

describe("attachment policy", () => {
  it("rejects unsafe names, disguised binary content, unknown types, and message count abuse", () => {
    expect(() => validateAttachmentPolicy({ filename: "../x.txt", declaredMediaType: "text/plain", bytes: Buffer.from("x") })).toThrow(IngestionError);
    expect(() => validateAttachmentPolicy({ filename: "x.txt", declaredMediaType: "text/plain", bytes: Buffer.from("%PDF-1.7") })).toThrowError(expect.objectContaining({ code: "MEDIA_TYPE_MISMATCH" }));
    expect(() => validateAttachmentPolicy({ filename: "x.exe", declaredMediaType: "application/octet-stream", bytes: Buffer.from("x") })).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_MEDIA_TYPE" }));
    expect(() => validateMessageAttachments(Array.from({ length: 21 }, () => ({ bytes: new Uint8Array() })))).toThrowError(expect.objectContaining({ code: "MESSAGE_TOO_LARGE" }));
  });

  it("normalizes MIME parameters but enforces the extension", () => {
    expect(validateAttachmentPolicy({ filename: "notes.md", declaredMediaType: "Text/Markdown; charset=utf-8", bytes: Buffer.from("# Notes") })).toBe("text/markdown");
    expect(() => validateAttachmentPolicy({ filename: "notes.json", declaredMediaType: "text/plain", bytes: Buffer.from("{}") })).toThrowError(expect.objectContaining({ code: "MEDIA_TYPE_MISMATCH" }));
  });

  it("keeps browser-advertised HTML and CSS code attachments aligned with backend policy", () => {
    expect(validateAttachmentPolicy({ filename: "page.html", declaredMediaType: "text/html", bytes: Buffer.from("<!doctype html><title>Continuum</title>") })).toBe("text/html");
    expect(validateAttachmentPolicy({ filename: "theme.css", declaredMediaType: "text/css", bytes: Buffer.from(":root { color-scheme: light dark; }") })).toBe("text/css");
  });
});

describe("content-addressed attachment storage", () => {
  it("deduplicates exact bytes and verifies reads", async () => {
    const root = await temporaryDirectory();
    const store = new FileSystemContentAddressedStore(root);
    const first = await store.put(Buffer.from("same bytes"));
    const second = await store.put(Buffer.from("same bytes"));
    expect(first.sha256).toBe(sha256("same bytes"));
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(Buffer.from(await store.get(first.sha256)).toString()).toBe("same bytes");
    await expect(store.delete(first.sha256)).resolves.toBe(true);
    await expect(store.has(first.sha256)).resolves.toBe(false);
    await expect(store.delete(first.sha256)).resolves.toBe(false);
  });

  it("keeps a concurrently published hash available across store instances", async () => {
    const root = await temporaryDirectory();
    const stores = [new FileSystemContentAddressedStore(root), new FileSystemContentAddressedStore(root)];
    const bytes = Buffer.from("one immutable value published by concurrent callers");
    const results = await Promise.all(Array.from({ length: 24 }, (_, index) => stores[index % stores.length]!.put(bytes)));
    expect(results.filter((result) => !result.deduplicated)).toHaveLength(1);
    expect(new Set(results.map((result) => result.sha256))).toEqual(new Set([sha256(bytes)]));
    expect(Buffer.from(await stores[1]!.get(sha256(bytes))).toString()).toBe(bytes.toString());
    expect((await readdir(root)).filter((entry) => entry.startsWith(".upload-"))).toEqual([]);
  });

  it("reconciles crash-staged hardlinks and removes them before hard deletion", async () => {
    const root = await temporaryDirectory();
    const first = new FileSystemContentAddressedStore(root);
    const stored = await first.put(Buffer.from("private crash recovery bytes"));
    const canonical = join(root, stored.storageKey);
    const crashed = join(root, `.upload-${stored.sha256}-${randomUUID()}`);
    await link(canonical, crashed);

    const restarted = new FileSystemContentAddressedStore(root);
    await restarted.initialize();
    expect((await readdir(root)).filter((entry) => entry.startsWith(`.upload-${stored.sha256}-`))).toEqual([]);
    await expect(restarted.get(stored.sha256)).resolves.toEqual(Buffer.from("private crash recovery bytes"));

    await link(canonical, crashed);
    await expect(restarted.delete(stored.sha256)).resolves.toBe(true);
    expect((await readdir(root)).filter((entry) => entry.startsWith(`.upload-${stored.sha256}-`))).toEqual([]);
    await expect(restarted.has(stored.sha256)).resolves.toBe(false);
  });

  it("serializes put and delete for the same hash across store instances", async () => {
    const root = await temporaryDirectory();
    const stores = [new FileSystemContentAddressedStore(root), new FileSystemContentAddressedStore(root)];
    const bytes = Buffer.alloc(2_000_000, 0x5a);
    const hash = sha256(bytes);
    const completions: string[] = [];
    await Promise.all([
      stores[0]!.put(bytes).then(() => { completions.push("put"); }),
      stores[1]!.delete(hash).then(() => { completions.push("delete"); })
    ]);
    expect(completions).toHaveLength(2);
    await expect(stores[0]!.has(hash)).resolves.toBe(completions.at(-1) === "put");
  });

  it("coordinates simultaneous reclaimers without unlinking a successor lock", async () => {
    const root = await temporaryDirectory();
    const initialized = new FileSystemContentAddressedStore(root);
    await initialized.initialize();
    const child = spawn(process.execPath, ["-e", ""]);
    const deadPid = child.pid;
    if (!deadPid) throw new Error("The lock-recovery fixture process did not start.");
    await new Promise<void>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", () => resolveExit());
    });
    const bytes = Buffer.from("stale lock recovery with concurrent reclaimers");
    const hash = sha256(bytes);
    await writeFile(join(root, `.lock-${hash}`), JSON.stringify({ pid: deadPid, token: randomUUID() }), { mode: 0o600 });
    const stores = Array.from({ length: 8 }, () => new FileSystemContentAddressedStore(root));
    const results = await Promise.all(stores.map((store) => store.put(bytes)));
    expect(results.filter((result) => !result.deduplicated)).toHaveLength(1);
    expect(Buffer.from(await initialized.get(hash)).toString()).toBe(bytes.toString());
    expect((await readdir(root)).filter((entry) => entry.startsWith(`.lock-${hash}`) || entry.startsWith(`.reclaim-${hash}-`))).toEqual([]);
  });

  it("forces a live subprocess successor through pre-scan, wx, and post-scan while a stale-lock reclaim barrier is held", async () => {
    const root = await temporaryDirectory();
    const initialized = new FileSystemContentAddressedStore(root);
    await initialized.initialize();
    const staleOwner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"]);
    const stalePid = staleOwner.pid;
    if (!stalePid) throw new Error("The stale-owner fixture process did not start.");
    let staleOwnerExited = false;
    const staleOwnerExit = new Promise<void>((resolveExit, rejectExit) => {
      staleOwner.once("error", rejectExit);
      staleOwner.once("exit", () => {
        staleOwnerExited = true;
        resolveExit();
      });
    });

    const bytes = Buffer.from("deterministic cross-process reclaim barrier interleaving");
    const hash = sha256(bytes);
    const children: Array<ReturnType<typeof spawnStoreChild>> = [];
    try {
      await writeFile(join(root, `.lock-${hash}`), JSON.stringify({ pid: stalePid, token: randomUUID() }), { mode: 0o600 });
      const successor = spawnStoreChild({ root, bytes, role: "successor" });
      children.push(successor);
      const preScan = await successor.waitFor("successor-pre-scan");
      expect(preScan.pid).toBe(successor.child.pid);
      expect(() => process.kill(preScan.pid, 0)).not.toThrow();

      const reclaimer = spawnStoreChild({ root, bytes, role: "reclaimer" });
      children.push(reclaimer);
      const liveStaleOwner = await reclaimer.waitFor("reclaimer-observed-live-stale-owner");
      expect(liveStaleOwner.pid).toBe(reclaimer.child.pid);
      expect(() => process.kill(stalePid, 0)).not.toThrow();
      staleOwner.kill("SIGTERM");
      await staleOwnerExit;
      // Both protocol participants already exist, so the now-dead PID cannot
      // be recycled into either owner while reclamation is under test.
      reclaimer.send("resume-after-stale-owner-exit");
      const staleRemoved = await reclaimer.waitFor("stale-lock-removed-with-live-barrier");
      expect(staleRemoved.pid).toBe(reclaimer.child.pid);
      expect(() => process.kill(staleRemoved.pid, 0)).not.toThrow();
      const barriers = (await readdir(root)).filter((entry) => entry.startsWith(`.reclaim-${hash}-`));
      expect(barriers).toHaveLength(1);
      const barrierOwner = JSON.parse(await readFile(join(root, barriers[0]!), "utf8")) as { pid?: unknown };
      expect(barrierOwner.pid).toBe(reclaimer.child.pid);

      // The successor scanned before the barrier existed. The stale pathname
      // is now absent, so it wins wx, then its mandatory post-scan sees the
      // live reclaimer marker and yields its fully published lock.
      successor.send("resume-pre-scan");
      await successor.waitFor("successor-yielded-after-post-scan");
      expect(successor.seenPhases).not.toContain("operation-enter");

      // Keep the yielded successor paused until the reclaimer owns the fixed
      // lock and is paused at the critical-section boundary.
      reclaimer.send("resume-reclaimer");
      await reclaimer.waitFor("operation-enter");
      expect(successor.seenPhases).not.toContain("operation-enter");

      // The successor must treat the reclaimer PID as live. Pause it outside
      // the critical section so cross-child IPC ordering cannot fake overlap.
      successor.send("resume-after-yield");
      await successor.waitFor("successor-observed-live-owner");
      expect(successor.seenPhases).not.toContain("operation-enter");

      reclaimer.send("resume-operation");
      const reclaimerComplete = await reclaimer.waitFor("complete");
      expect(reclaimerComplete.result).toMatchObject({ sha256: hash, deduplicated: false });
      await reclaimer.expectCleanExit();

      // Eventual liveness: once the first owner has durably released, the
      // successor acquires, enters alone, and observes the immutable blob.
      successor.send("resume-after-live-owner");
      await successor.waitFor("operation-enter");
      successor.send("resume-operation");
      const successorComplete = await successor.waitFor("complete");
      expect(successorComplete.result).toMatchObject({ sha256: hash, deduplicated: true });
      await successor.expectCleanExit();

      expect(Buffer.from(await initialized.get(hash)).toString()).toBe(bytes.toString());
      expect((await readdir(root)).filter((entry) => entry.startsWith(`.lock-${hash}`) || entry.startsWith(`.reclaim-${hash}-`))).toEqual([]);
    } finally {
      if (!staleOwnerExited) staleOwner.kill("SIGKILL");
      await staleOwnerExit.catch(() => undefined);
      await Promise.all(children.map((child) => child.stop()));
    }
  }, 30_000);

  it("keeps a failed acquirer's token live until exact-marker cleanup cannot unlink a same-process successor", async () => {
    const root = await temporaryDirectory();
    const bytes = Buffer.from("same-process acquisition cleanup ownership regression");
    const hash = sha256(bytes);
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolveCleanup) => { releaseCleanup = resolveCleanup; });
    let reportCleanupVerified!: () => void;
    const cleanupVerified = new Promise<void>((resolveVerified) => { reportCleanupVerified = resolveVerified; });
    let resumeWaiter!: () => void;
    const waiterGate = new Promise<void>((resolveWaiter) => { resumeWaiter = resolveWaiter; });
    let reportLiveOwner!: () => void;
    const liveOwnerObserved = new Promise<void>((resolveObserved) => { reportLiveOwner = resolveObserved; });
    let waiterEntered = false;

    const failingOwner = new FileSystemContentAddressedStore(root, {
      afterHashLockPublishedBeforeBarrierRescan() {
        throw new Error("forced post-publication acquisition failure");
      },
      async afterHashLockReleaseOwnershipVerified() {
        reportCleanupVerified();
        await cleanupGate;
      }
    });
    const ownerPut = failingOwner.put(bytes);
    await cleanupVerified;

    const waiter = new FileSystemContentAddressedStore(root, {
      async afterLiveHashLockObserved() {
        reportLiveOwner();
        await waiterGate;
      },
      beforeHashOperation() {
        waiterEntered = true;
      }
    });
    const waiterPut = waiter.put(bytes);
    await liveOwnerObserved;
    expect(waiterEntered).toBe(false);

    // The failed owner still advertises its token while paused after reading
    // and comparing the marker. A conforming waiter therefore cannot reclaim
    // the fixed pathname or publish a successor that cleanup could unlink.
    const marker = JSON.parse(await readFile(join(root, `.lock-${hash}`), "utf8")) as { pid?: unknown; token?: unknown };
    expect(marker).toMatchObject({ pid: process.pid, token: expect.any(String) });
    releaseCleanup();
    await expect(ownerPut).rejects.toThrow("forced post-publication acquisition failure");

    resumeWaiter();
    await expect(waiterPut).resolves.toMatchObject({ sha256: hash, deduplicated: false });
    expect(waiterEntered).toBe(true);
    await expect(waiter.get(hash)).resolves.toEqual(bytes);
    expect((await readdir(root)).filter((entry) => entry === `.lock-${hash}` || entry.startsWith(`.reclaim-${hash}-`))).toEqual([]);
  });

  it("detects a blob changed outside the store", async () => {
    const root = await temporaryDirectory();
    const store = new FileSystemContentAddressedStore(root);
    const stored = await store.put(Buffer.from("original"));
    await writeFile(join(root, stored.storageKey), "tampered");
    await expect(store.get(stored.sha256)).rejects.toMatchObject({ code: "STORAGE_INTEGRITY_FAILED" });
    await expect(store.get("../../etc/passwd")).rejects.toMatchObject({ code: "STORAGE_INTEGRITY_FAILED" });
  });
});

describe("text, JSON, CSV, and code extraction", () => {
  it("rejects invalid UTF-8 rather than silently replacing evidence", () => {
    expect(() => decodeUtf8Strict(Uint8Array.from([0xc3, 0x28]))).toThrowError(expect.objectContaining({ code: "INVALID_ENCODING" }));
  });

  it("validates JSON and keeps deterministic line citations", () => {
    const document = extractJsonDocument(Buffer.from('{\n  "decision": "SQLite"\n}'));
    expect(document.metadata.rootType).toBe("object");
    expect(document.chunks[0]?.location).toMatchObject({ lineStart: 1, lineEnd: 3 });
    expect(() => extractJsonDocument(Buffer.from('{"broken":'))).toThrowError(expect.objectContaining({ code: "MALFORMED_CONTENT" }));
  });

  it("parses RFC-style quoted CSV records and emits header-aware row chunks", () => {
    const document = extractCsvDocument(Buffer.from('name,note\nAlice,"line one\nline two"\nBob,"a, b"'));
    expect(document.metadata).toMatchObject({ rowCount: 2, columnCount: 2, headers: ["name", "note"] });
    expect(document.chunks[0]?.text).toContain("name,note");
    expect(document.chunks[0]?.location).toMatchObject({ rowStart: 2, rowEnd: 3, lineStart: 2, lineEnd: 4 });
    expect(() => extractCsvDocument(Buffer.from('a\n"unterminated'))).toThrowError(expect.objectContaining({ code: "MALFORMED_CONTENT" }));
    expect(() => extractCsvDocument(Buffer.from('a\n"closed"junk'))).toThrowError(expect.objectContaining({ code: "MALFORMED_CONTENT" }));
    expect(() => extractCsvDocument(Buffer.from('a\nun"quoted'))).toThrowError(expect.objectContaining({ code: "MALFORMED_CONTENT" }));
  });

  it("chunks TypeScript by named symbols and falls back without dropping lines", async () => {
    const text = "export function alpha() {\n  return 1;\n}\n\nclass Beta {\n  value = 2;\n}";
    const document = await extractTextDocument({ bytes: Buffer.from(text), mediaType: "text/typescript", filename: "sample.ts" });
    expect(document.chunks.map((chunk) => chunk.location.symbol)).toEqual(["alpha", "Beta"]);
    expect(document.chunks.map((chunk) => chunk.text).join("\n")).toContain("value = 2");
    expect(chunkCodeSymbols("only text", [], "test")[0]?.location).toMatchObject({ lineStart: 1, lineEnd: 1 });
  });
});

describe("PDF and image extraction", () => {
  it("validates bounded provider-ready image derivatives without changing originals", async () => {
    const original = Uint8Array.from([1, 2, 3, 4]);
    const thumbnailBytes = Buffer.from("bounded-thumbnail");
    const thumbnail = await createMacProviderThumbnail(
      { bytes: original, mediaType: "image/png" },
      async (input) => {
        expect(input.bytes).toEqual(original);
        expect(input.mode).toBe("thumbnail");
        return { mediaType: "image/jpeg", base64: thumbnailBytes.toString("base64"), width: 800, height: 600 };
      }
    );
    expect(thumbnail).toMatchObject({ mediaType: "image/jpeg", width: 800, height: 600 });
    expect(Buffer.from(thumbnail.bytes)).toEqual(thumbnailBytes);
    expect(original).toEqual(Uint8Array.from([1, 2, 3, 4]));
    await expect(createMacProviderThumbnail(
      { bytes: original, mediaType: "image/png" },
      async () => ({ mediaType: "image/jpeg", base64: thumbnailBytes.toString("base64"), width: 4_000, height: 4_000 })
    )).rejects.toMatchObject({ code: "PARSER_LIMIT_EXCEEDED" });
  });

  it("validates native adapter output and reports non-macOS fallback explicitly", async () => {
    expect(macNativeIngestionStatus("linux", true, true)).toMatchObject({ available: false, ocrEngine: "unavailable", pdfEngine: "builtin-fallback" });
    const ocr = new MacVisionOcrAdapter(async (input) => {
      expect(input.mode).toBe("ocr");
      return { text: "local OCR", engine: "Apple Vision", words: [{ text: "local", confidence: 0.98, x: 0.1, y: 0.2 }] };
    });
    await expect(ocr.recognize({ bytes: Buffer.from("fixture"), mediaType: "image/png" })).resolves.toMatchObject({
      text: "local OCR",
      engine: "Apple Vision",
      words: [expect.objectContaining({ text: "local", confidence: 0.98 })]
    });
    const pdf = new MacPdfKitExtractor(async (input) => {
      expect(input.mode).toBe("pdf");
      return [{ page: 1, text: "PDFKit text", items: [{ text: "PDFKit text", x: 72, y: 700, width: 80, height: 12 }] }];
    });
    await expect(pdf.extract(Buffer.from("%PDF-fixture"))).resolves.toEqual([
      expect.objectContaining({ page: 1, text: "PDFKit text", items: [expect.objectContaining({ x: 72, y: 700 })] })
    ]);
  });

  it("preserves page numbers and approximate text coordinates from a basic PDF", async () => {
    const pdf = Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 65 >>
stream
BT 1 0 0 1 72 700 Tm (Hello \\(Continuum\\)) Tj ET
endstream
endobj
%%EOF`, "latin1");
    const document = await extractPdfDocument({ bytes: pdf, extractor: new BasicPdfExtractor() });
    expect(document.metadata.pageCount).toBe(1);
    expect(document.text).toContain("Hello (Continuum)");
    expect(document.chunks[0]?.location.page).toBe(1);
    expect(document.metadata.pages).toEqual([
      expect.objectContaining({ page: 1, textItemCount: 1, coordinates: [expect.objectContaining({ x: 72, y: 700 })] })
    ]);
  });

  it("falls back to the bounded local PDF parser when native extraction fails", async () => {
    const pdf = Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>
endobj
4 0 obj
<< /Length 43 >>
stream
BT 72 700 Td (Fallback text) Tj ET
endstream
endobj
%%EOF`, "latin1");
    const document = await extractPdfDocument({
      bytes: pdf,
      extractor: { name: "native-fixture", version: "1", extract: async () => { throw new IngestionError("PDF_EXTRACTION_FAILED", "native unavailable"); } }
    });
    expect(document.text).toContain("Fallback text");
    expect(document.metadata).toMatchObject({ extractor: "builtin-pdf-content-stream" });
    expect(document.warnings).toContain("Native PDF extraction failed; the built-in local parser was used.");
  });

  it("rejects encrypted PDFs and can add OCR to image metadata", async () => {
    await expect(new BasicPdfExtractor().extract(Buffer.from("%PDF-1.4\n/Encrypt"))).rejects.toMatchObject({ code: "ENCRYPTED_PDF" });
    const png = Buffer.alloc(29);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    png.writeUInt32BE(13, 8);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(100, 16);
    png.writeUInt32BE(50, 20);
    png[24] = 8;
    png[25] = 6;
    const document = await extractImageDocument({
      bytes: png,
      mediaType: "image/png",
      ocr: { recognize: async () => ({ text: "diagram label", engine: "fixture" }) }
    });
    expect(document.metadata).toMatchObject({ width: 100, height: 50, requiresVisionAnalysis: true, ocrEngine: "fixture" });
    expect(document.chunks[0]?.text).toContain("diagram label");
  });
});

describe("IngestionService", () => {
  it("stores, extracts, versions, and validates a complete attachment record", async () => {
    const root = await temporaryDirectory();
    const service = new IngestionService({
      store: new FileSystemContentAddressedStore(root),
      now: () => new Date("2026-07-13T12:00:00.000Z")
    });
    const result = await service.ingest({
      id: randomUUID(),
      sourceId: randomUUID(),
      filename: "notes.md",
      declaredMediaType: "text/markdown",
      bytes: Buffer.from("# Decision\n\nUse SQLite.")
    });
    expect(result.status).toBe("ready");
    expect(result.sha256).toHaveLength(64);
    expect(result.document.chunks[0]?.metadata.heading).toBe("Decision");
    expect(result.extractedAt).toBe("2026-07-13T12:00:00.000Z");
  });

  it("retains the immutable blob identity when parsing fails so the worker can retry", async () => {
    const root = await temporaryDirectory();
    const service = new IngestionService({ store: new FileSystemContentAddressedStore(root) });
    await expect(service.ingest({
      id: randomUUID(),
      sourceId: randomUUID(),
      filename: "broken.json",
      declaredMediaType: "application/json",
      bytes: Buffer.from('{"broken":')
    })).rejects.toMatchObject({
      code: "MALFORMED_CONTENT",
      details: { extractionFailed: true, storedBlob: expect.objectContaining({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }) }
    });
  });
});
