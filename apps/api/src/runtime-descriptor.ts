import { randomUUID } from "node:crypto";
import { link, open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";

export interface RuntimeDescriptor {
  pid: number;
  origin: string;
  bootstrapUrl: string;
  startedAt: string;
  version: string;
}

export async function writeRuntimeDescriptor(path: string, descriptor: RuntimeDescriptor): Promise<void> {
  const temporaryPath = siblingPath(path, "write");
  let file: FileHandle | null = await open(temporaryPath, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(descriptor, null, 2), "utf8");
    await file.chmod(0o600);
    await file.close();
    file = null;
    // Publish only a complete private file. Besides preventing partial reads,
    // replacement-by-rename does not follow a hostile runtime.json symlink.
    await rename(temporaryPath, path);
  } catch (error) {
    await file?.close().catch(() => undefined);
    await unlinkIfExists(temporaryPath);
    throw error;
  }
}

/**
 * A signal can arrive after publication starts but before runtime.json exists.
 * Wait for that publication attempt to settle before performing the owned
 * removal, otherwise the write can win after an early ENOENT and leave a stale
 * bootstrap token behind after shutdown.
 */
export async function removeOwnedRuntimeDescriptorAfterPublication(
  path: string,
  owner: Pick<RuntimeDescriptor, "pid" | "startedAt">,
  publication: Promise<void>
): Promise<boolean> {
  await publication.catch(() => undefined);
  return removeOwnedRuntimeDescriptor(path, owner);
}

/**
 * Remove only the descriptor written by this process. A second Continuum
 * process may have replaced a stale descriptor while the first one was
 * shutting down, so an unconditional unlink would erase the new bootstrap
 * address and token.
 */
export async function removeOwnedRuntimeDescriptor(
  path: string,
  owner: Pick<RuntimeDescriptor, "pid" | "startedAt">
): Promise<boolean> {
  // Avoid perturbing malformed or obviously foreign entries. Ownership is
  // checked again after the atomic claim because this preflight read alone is
  // not sufficient to authorize deletion.
  if (!(await descriptorBelongsTo(path, owner))) return false;

  const claimedPath = siblingPath(path, "remove");
  try {
    // Claim the exact directory entry before the final ownership decision. A
    // read followed by unlink(path) has a TOCTOU window in which a newer
    // process can replace the descriptor and then have its file deleted.
    await rename(path, claimedPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }

  if (!(await descriptorBelongsTo(claimedPath, owner))) {
    // A replacement is not demonstrably ours. Restore it unless a
    // concurrently-started process has already published another descriptor.
    await restoreClaimedDescriptor(claimedPath, path);
    return false;
  }
  try {
    await unlink(claimedPath);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function descriptorBelongsTo(
  path: string,
  owner: Pick<RuntimeDescriptor, "pid" | "startedAt">
): Promise<boolean> {
  let stored: unknown;
  try {
    stored = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return false;
  }
  if (!stored || typeof stored !== "object") return false;
  const record = stored as Record<string, unknown>;
  return record.pid === owner.pid && record.startedAt === owner.startedAt;
}

function siblingPath(path: string, operation: "write" | "remove"): string {
  return `${path}.${operation}-${process.pid}-${randomUUID()}`;
}

async function restoreClaimedDescriptor(claimedPath: string, path: string): Promise<void> {
  try {
    // link() is an atomic create-if-absent operation. It cannot overwrite a
    // descriptor published while the claimed file was being inspected.
    await link(claimedPath, path);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  await unlinkIfExists(claimedPath);
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
