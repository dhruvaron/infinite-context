import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  unlink
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { IngestionError } from "./errors.js";
import type { StoredBlob } from "./types.js";

export interface ContentAddressedStore {
  put(bytes: Uint8Array): Promise<StoredBlob>;
  get(sha256: string): Promise<Uint8Array>;
  has(sha256: string): Promise<boolean>;
  listHashes(): Promise<string[]>;
  delete(sha256: string): Promise<boolean>;
}

function validateHash(hash: string): void {
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new IngestionError("STORAGE_INTEGRITY_FAILED", "Invalid content hash.");
  }
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const ACTIVE_HASH_LOCKS = new Set<string>();
const ACTIVE_HASH_RECLAIMS = new Set<string>();
const HASH_LOCK_WAIT_MS = 30_000;
const INCOMPLETE_LOCK_GRACE_MS = 30_000;

/**
 * Deterministic scheduling seam for cross-process lock protocol tests. Product
 * callers omit this argument; hooks run at protocol boundaries and never alter
 * lock ownership themselves.
 */
interface ContentStoreInterleavingHooks {
  afterReclaimBarrierPreScan?(input: { hash: string; liveBarrier: boolean }): void | Promise<void>;
  afterStaleHashLockRemoved?(input: { hash: string }): void | Promise<void>;
  afterHashLockPublishedBeforeBarrierRescan?(input: { hash: string }): void | Promise<void>;
  afterHashLockReleaseOwnershipVerified?(input: { hash: string }): void | Promise<void>;
  afterHashLockYieldedToReclaimBarrier?(input: { hash: string }): void | Promise<void>;
  afterLiveHashLockObserved?(input: { hash: string }): void | Promise<void>;
  beforeHashOperation?(input: { hash: string }): void | Promise<void>;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    // A few filesystems do not support syncing directory descriptors. Other
    // failures mean the new link/unlink cannot be claimed as crash-durable.
    if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(code)) throw error;
  } finally {
    await handle.close();
  }
}

/**
 * Files are immutable and addressed only by SHA-256. The store deliberately does
 * not retain user filenames in paths, preventing traversal and Unicode path issues.
 */
export class FileSystemContentAddressedStore implements ContentAddressedStore {
  readonly #configuredRoot: string;
  readonly #interleavingHooks: ContentStoreInterleavingHooks;
  #root?: string;

  constructor(root: string, interleavingHooks: ContentStoreInterleavingHooks = {}) {
    this.#configuredRoot = resolve(root);
    this.#interleavingHooks = interleavingHooks;
  }

  async initialize(): Promise<void> {
    const missingEntries: string[] = [];
    for (let cursor = this.#configuredRoot; ; cursor = dirname(cursor)) {
      try {
        await lstat(cursor);
        break;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        missingEntries.push(cursor);
        if (dirname(cursor) === cursor) throw error;
      }
    }
    await mkdir(this.#configuredRoot, { recursive: true, mode: 0o700 });
    await chmod(this.#configuredRoot, 0o700);
    // mkdir({ recursive: true }) can create more than the leaf. Persist every
    // newly published directory entry from the leaf's parent back to the
    // nearest pre-existing ancestor.
    for (const parent of [...new Set(missingEntries.map((entry) => dirname(entry)))]) {
      await syncDirectory(parent);
    }
    const rootInfo = await lstat(this.#configuredRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new IngestionError("STORAGE_INTEGRITY_FAILED", "Attachment store root is unsafe.");
    }
    this.#root = await realpath(this.#configuredRoot);
    const pendingHashes = new Set<string>();
    for (const entry of await readdir(this.#root)) {
      const match = /^\.upload-([a-f0-9]{64})-[0-9a-f-]+$/.exec(entry);
      if (match?.[1]) pendingHashes.add(match[1]);
    }
    // A crash can leave the private staging hardlink beside the canonical
    // blob. Serialize reconciliation with live publishers of the same hash.
    for (const hash of pendingHashes) {
      await this.#withHashLock(this.#root, hash, () => this.#removeUploadEntries(this.#root!, hash));
    }
  }

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    const root = await this.#getRoot();
    const hash = sha256(bytes);
    return this.#withHashLock(root, hash, async () => {
      await this.#removeUploadEntries(root, hash);
      const shard = join(root, hash.slice(0, 2));
      await mkdir(shard, { mode: 0o700, recursive: true });
      // Persist a newly created shard before publishing a child entry inside it.
      await syncDirectory(root);
      const shardInfo = await lstat(shard);
      if (!shardInfo.isDirectory() || shardInfo.isSymbolicLink()) {
        throw new IngestionError("STORAGE_INTEGRITY_FAILED", "Attachment shard is unsafe.");
      }
      const target = this.#pathFor(root, hash);
      const temporary = join(root, `.upload-${hash}-${randomUUID()}`);
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      const cleanupTemporary = async (primaryError: unknown, message: string): Promise<never> => {
        const errors = [primaryError];
        if (handle) {
          try { await handle.close(); }
          catch (error) { errors.push(error); }
          handle = undefined;
        }
        try { await rm(temporary, { force: true }); }
        catch (error) { errors.push(error); }
        try { await syncDirectory(root); }
        catch (error) { errors.push(error); }
        if (errors.length > 1) throw new AggregateError(errors, message);
        throw primaryError;
      };
      try {
        handle = await open(temporary, "wx", 0o600);
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close();
        handle = undefined;
      } catch (error) {
        return cleanupTemporary(error, "Attachment staging failed and its private entry could not be durably cleaned up.");
      }
      let linked = false;
      try {
        try {
          await link(temporary, target);
          linked = true;
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
        }
        const targetHandle = await open(target, "r");
        try { await targetHandle.sync(); }
        finally { await targetHandle.close(); }
        await syncDirectory(shard);
        await this.#verify(target, hash, bytes.byteLength);
      } catch (error) {
        // Once the immutable target is linked it is public. Retain it on a
        // publisher failure so no independently acknowledged reader loses it.
        return cleanupTemporary(error, "Attachment publication failed and its private entry could not be durably cleaned up.");
      }
      try {
        await rm(temporary, { force: true });
        await syncDirectory(root);
      } catch (error) {
        return cleanupTemporary(error, "Attachment staging-link cleanup could not be made durable.");
      }
      return { sha256: hash, size: bytes.byteLength, storageKey: `${hash.slice(0, 2)}/${hash}`, deduplicated: !linked };
    });
  }

  async get(hash: string): Promise<Uint8Array> {
    validateHash(hash);
    const root = await this.#getRoot();
    const target = this.#pathFor(root, hash);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new IngestionError("STORAGE_INTEGRITY_FAILED", "Attachment blob is not a regular file.");
    }
    const bytes = await readFile(target);
    if (sha256(bytes) !== hash) {
      throw new IngestionError("STORAGE_INTEGRITY_FAILED", "Attachment blob failed its checksum.");
    }
    return bytes;
  }

  async has(hash: string): Promise<boolean> {
    validateHash(hash);
    const root = await this.#getRoot();
    try {
      const info = await lstat(this.#pathFor(root, hash));
      return info.isFile() && !info.isSymbolicLink();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }

  async listHashes(): Promise<string[]> {
    const root = await this.#getRoot();
    const hashes: string[] = [];
    for (const shardName of await readdir(root)) {
      if (!/^[a-f0-9]{2}$/.test(shardName)) continue;
      const shard = join(root, shardName);
      const shardInfo = await lstat(shard);
      if (!shardInfo.isDirectory() || shardInfo.isSymbolicLink()) {
        throw new IngestionError("STORAGE_INTEGRITY_FAILED", "Attachment shard is unsafe.");
      }
      for (const entry of await readdir(shard)) {
        if (!new RegExp(`^${shardName}[a-f0-9]{62}$`).test(entry)) continue;
        const target = this.#pathFor(root, entry);
        const info = await lstat(target);
        if (!info.isFile() || info.isSymbolicLink()) {
          throw new IngestionError("STORAGE_INTEGRITY_FAILED", "Attachment blob is not a regular file.");
        }
        hashes.push(entry);
      }
    }
    return hashes.sort();
  }

  async delete(hash: string): Promise<boolean> {
    validateHash(hash);
    const root = await this.#getRoot();
    return this.#withHashLock(root, hash, async () => {
      // Remove and persist every private hardlink before the canonical name.
      // If the process crashes, a retry can still discover the canonical hash.
      await this.#removeUploadEntries(root, hash);
      const shard = join(root, hash.slice(0, 2));
      let deleted = false;
      try {
        await unlink(this.#pathFor(root, hash));
        deleted = true;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
      try {
        await syncDirectory(shard);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        await syncDirectory(root);
      }
      return deleted;
    });
  }

  async #getRoot(): Promise<string> {
    if (!this.#root) await this.initialize();
    if (!this.#root) throw new IngestionError("STORAGE_INTEGRITY_FAILED", "Attachment store failed to initialize.");
    return this.#root;
  }

  #pathFor(root: string, hash: string): string {
    validateHash(hash);
    const target = resolve(root, hash.slice(0, 2), hash);
    if (!target.startsWith(`${root}${sep}`)) {
      throw new IngestionError("STORAGE_INTEGRITY_FAILED", "Attachment path escaped its store.");
    }
    return target;
  }

  async #removeUploadEntries(root: string, hash: string): Promise<void> {
    const prefix = `.upload-${hash}-`;
    for (const entry of await readdir(root)) {
      if (entry.startsWith(prefix)) await unlink(join(root, entry));
    }
    // Unconditional so a retry persists an unlink that succeeded before an
    // earlier directory fsync failed.
    await syncDirectory(root);
  }

  async #ownerMarkerIsLive(path: string): Promise<boolean> {
    const info = await lstat(path);
    let owner: { pid?: unknown; token?: unknown };
    try { owner = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown; token?: unknown }; }
    catch (error) {
      if (error instanceof SyntaxError) return Date.now() - info.mtimeMs < INCOMPLETE_LOCK_GRACE_MS;
      throw error;
    }
    if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || typeof owner.token !== "string") {
      return Date.now() - info.mtimeMs < INCOMPLETE_LOCK_GRACE_MS;
    }
    if (owner.pid === process.pid) {
      return ACTIVE_HASH_LOCKS.has(owner.token) || ACTIVE_HASH_RECLAIMS.has(owner.token);
    }
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
      if (error instanceof Error && "code" in error && error.code === "EPERM") return true;
      throw error;
    }
  }

  async #hasLiveReclaimBarrier(root: string, hash: string): Promise<boolean> {
    const prefix = `.reclaim-${hash}-`;
    let removed = false;
    for (const entry of await readdir(root)) {
      if (!entry.startsWith(prefix)) continue;
      const path = join(root, entry);
      try {
        if (await this.#ownerMarkerIsLive(path)) return true;
        // Barrier names contain a never-reused UUID. Removing this exact stale
        // path cannot unlink a successor barrier created by another process.
        await unlink(path);
        removed = true;
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
    }
    if (removed) await syncDirectory(root);
    return false;
  }

  async #releaseHashLock(root: string, hash: string, lockPath: string, token: string): Promise<void> {
    const owner = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
    if (owner.token !== token) {
      throw new IngestionError("STORAGE_INTEGRITY_FAILED", "Attachment storage lock ownership changed unexpectedly.");
    }
    await this.#interleavingHooks.afterHashLockReleaseOwnershipVerified?.({ hash });
    await unlink(lockPath);
    await syncDirectory(root);
  }

  async #reclaimStaleHashLock(root: string, hash: string, lockPath: string, deadline: number): Promise<void> {
    const reclaimToken = randomUUID();
    const barrierPath = join(root, `.reclaim-${hash}-${reclaimToken}`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    ACTIVE_HASH_RECLAIMS.add(reclaimToken);
    let primaryError: unknown;
    try {
      handle = await open(barrierPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token: reclaimToken, createdAt: new Date().toISOString() }));
      await handle.sync();
      await handle.close();
      handle = undefined;
      // From this durable point, every conforming acquirer blocks before its
      // operation. Re-read the fixed owner; never act on pre-barrier evidence.
      await syncDirectory(root);
      for (;;) {
        try {
          if (!await this.#ownerMarkerIsLive(lockPath)) {
            await unlink(lockPath);
            await syncDirectory(root);
            await this.#interleavingHooks.afterStaleHashLockRemoved?.({ hash });
            break;
          }
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") break;
          throw error;
        }
        if (Date.now() >= deadline) {
          throw new IngestionError("STORAGE_INTEGRITY_FAILED", "Attachment storage is busy with another operation for this content hash.", { retryable: true });
        }
        await delay(25);
      }
    } catch (error) {
      const errors = [error];
      if (handle) {
        try { await handle.close(); }
        catch (closeError) { errors.push(closeError); }
      }
      primaryError = errors.length > 1
        ? new AggregateError(errors, "Attachment lock reclamation failed while its barrier was active.")
        : error;
    }
    ACTIVE_HASH_RECLAIMS.delete(reclaimToken);
    const cleanupErrors: unknown[] = [];
    try { await unlink(barrierPath); }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") cleanupErrors.push(error);
    }
    try { await syncDirectory(root); }
    catch (error) { cleanupErrors.push(error); }
    if (primaryError !== undefined && cleanupErrors.length) {
      throw new AggregateError([primaryError, ...cleanupErrors], "Attachment lock reclamation failed and its barrier could not be durably removed.");
    }
    if (primaryError !== undefined) throw primaryError;
    if (cleanupErrors.length) {
      throw new AggregateError(cleanupErrors, "Attachment lock reclamation barrier could not be durably removed.");
    }
  }

  async #withHashLock<T>(root: string, hash: string, operation: () => Promise<T>): Promise<T> {
    validateHash(hash);
    const lockPath = join(root, `.lock-${hash}`);
    const token = randomUUID();
    const deadline = Date.now() + HASH_LOCK_WAIT_MS;
    for (;;) {
      const liveBarrier = await this.#hasLiveReclaimBarrier(root, hash);
      await this.#interleavingHooks.afterReclaimBarrierPreScan?.({ hash, liveBarrier });
      if (liveBarrier) {
        if (Date.now() >= deadline) {
          throw new IngestionError("STORAGE_INTEGRITY_FAILED", "Attachment storage is busy with another operation for this content hash.", { retryable: true });
        }
        await delay(25);
        continue;
      }
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(lockPath, "wx", 0o600);
        ACTIVE_HASH_LOCKS.add(token);
        await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }));
        await handle.sync();
        await handle.close();
        handle = undefined;
        await syncDirectory(root);
        await this.#interleavingHooks.afterHashLockPublishedBeforeBarrierRescan?.({ hash });
        // A reclaimer can publish its barrier between the pre-scan and wx.
        // Release our fully identified lock before waiting; the operation has
        // not started, so the reclaimer can then make progress safely.
        if (await this.#hasLiveReclaimBarrier(root, hash)) {
          await this.#releaseHashLock(root, hash, lockPath, token);
          ACTIVE_HASH_LOCKS.delete(token);
          await this.#interleavingHooks.afterHashLockYieldedToReclaimBarrier?.({ hash });
          await delay(25);
          continue;
        }
        break;
      } catch (error) {
        const acquisitionErrors: unknown[] = [error];
        if (handle) {
          try { await handle.close(); }
          catch (closeError) { acquisitionErrors.push(closeError); }
        }
        if (ACTIVE_HASH_LOCKS.has(token)) {
          try {
            // Keep the token live until the exact marker has been verified,
            // removed, and persisted. Otherwise a same-process waiter can
            // reclaim the fixed pathname and this cleanup can unlink its
            // successor lock.
            await this.#releaseHashLock(root, hash, lockPath, token);
          } catch (releaseError) {
            acquisitionErrors.push(releaseError);
          } finally {
            ACTIVE_HASH_LOCKS.delete(token);
          }
        }
        if (acquisitionErrors.length > 1) {
          throw new AggregateError(acquisitionErrors, "Attachment content-lock acquisition failed and its lock entry could not be durably cleaned up.");
        }
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;

        let reclaim = false;
        try {
          reclaim = !await this.#ownerMarkerIsLive(lockPath);
        } catch (lockError) {
          if (lockError instanceof Error && "code" in lockError && lockError.code === "ENOENT") continue;
          throw lockError;
        }
        if (reclaim) {
          await this.#reclaimStaleHashLock(root, hash, lockPath, deadline);
          continue;
        }
        await this.#interleavingHooks.afterLiveHashLockObserved?.({ hash });
        if (Date.now() >= deadline) {
          throw new IngestionError("STORAGE_INTEGRITY_FAILED", "Attachment storage is busy with another operation for this content hash.", { retryable: true });
        }
        await delay(25);
      }
    }

    let result: T | undefined;
    let operationError: unknown;
    try {
      await this.#interleavingHooks.beforeHashOperation?.({ hash });
      result = await operation();
    }
    catch (error) { operationError = error; }
    let releaseError: unknown;
    try {
      await this.#releaseHashLock(root, hash, lockPath, token);
    } catch (error) { releaseError = error; }
    finally { ACTIVE_HASH_LOCKS.delete(token); }
    if (operationError !== undefined && releaseError !== undefined) {
      throw new AggregateError([operationError, releaseError], "Attachment operation failed and its content lock could not be released durably.");
    }
    if (operationError !== undefined) throw operationError;
    if (releaseError !== undefined) throw releaseError;
    return result as T;
  }

  async #verify(path: string, hash: string, expectedSize: number): Promise<void> {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== expectedSize) {
      throw new IngestionError("STORAGE_INTEGRITY_FAILED", "Stored attachment size is incorrect.");
    }
    const bytes = await readFile(path);
    if (sha256(bytes) !== hash) {
      throw new IngestionError("STORAGE_INTEGRITY_FAILED", "Stored attachment checksum is incorrect.");
    }
  }
}
