import { access, chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  removeOwnedRuntimeDescriptor,
  removeOwnedRuntimeDescriptorAfterPublication,
  type RuntimeDescriptor,
  writeRuntimeDescriptor
} from "./runtime-descriptor.js";

const descriptor = (pid = 42, startedAt = "2026-07-13T00:00:00.000Z"): RuntimeDescriptor => ({
  pid,
  origin: "http://127.0.0.1:4317",
  bootstrapUrl: "http://127.0.0.1:4317/bootstrap?token=secret",
  startedAt,
  version: "0.1.0"
});

describe("runtime descriptor lifecycle", () => {
  it("writes a private descriptor and removes it during an owned graceful shutdown", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuum-runtime-"));
    const path = join(directory, "runtime.json");
    await writeRuntimeDescriptor(path, descriptor());

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(descriptor());
    if (process.platform !== "win32") {
      const mode = (await import("node:fs/promises")).stat(path).then((value) => value.mode & 0o777);
      expect(await mode).toBe(0o600);
    }
    expect(await removeOwnedRuntimeDescriptor(path, descriptor())).toBe(true);
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not remove a descriptor replaced by a newer process", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuum-runtime-"));
    const path = join(directory, "runtime.json");
    const newer = descriptor(99, "2026-07-13T00:01:00.000Z");
    await writeFile(path, JSON.stringify(newer));
    await chmod(path, 0o600);

    expect(await removeOwnedRuntimeDescriptor(path, descriptor())).toBe(false);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(newer);
  });

  it("leaves malformed descriptors untouched because ownership cannot be proven", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuum-runtime-"));
    const path = join(directory, "runtime.json");
    await writeFile(path, "not json", { mode: 0o600 });

    expect(await removeOwnedRuntimeDescriptor(path, descriptor())).toBe(false);
    expect(await readFile(path, "utf8")).toBe("not json");
  });

  it("leaves non-file descriptor entries untouched because ownership cannot be proven", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuum-runtime-"));
    const path = join(directory, "runtime.json");
    await mkdir(path);

    expect(await removeOwnedRuntimeDescriptor(path, descriptor())).toBe(false);
    expect((await lstat(path)).isDirectory()).toBe(true);
  });

  it("publishes complete descriptors atomically while readers are active", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuum-runtime-"));
    const path = join(directory, "runtime.json");
    await writeRuntimeDescriptor(path, descriptor());
    const large = {
      ...descriptor(99, "2026-07-13T00:01:00.000Z"),
      bootstrapUrl: `http://127.0.0.1/bootstrap?token=${"x".repeat(2_000_000)}`
    };
    let finished = false;
    const writes = (async () => {
      for (let index = 0; index < 5; index += 1) await writeRuntimeDescriptor(path, large);
    })().finally(() => { finished = true; });

    let reads = 0;
    while (!finished) {
      const stored = JSON.parse(await readFile(path, "utf8")) as RuntimeDescriptor;
      expect([42, 99]).toContain(stored.pid);
      reads += 1;
    }
    await writes;
    expect(reads).toBeGreaterThan(0);
  });

  it.runIf(process.platform !== "win32")("replaces rather than follows a pre-existing descriptor symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuum-runtime-"));
    const target = join(directory, "unrelated.txt");
    const path = join(directory, "runtime.json");
    await writeFile(target, "must stay unchanged", { mode: 0o600 });
    await symlink(target, path);

    await writeRuntimeDescriptor(path, descriptor());

    expect(await readFile(target, "utf8")).toBe("must stay unchanged");
    expect((await lstat(path)).isSymbolicLink()).toBe(false);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(descriptor());
  });

  it("waits for an in-flight publication before shutdown removal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuum-runtime-"));
    const path = join(directory, "runtime.json");
    let releasePublication: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releasePublication = resolve; });
    const publication = gate.then(() => writeRuntimeDescriptor(path, descriptor()));
    const removal = removeOwnedRuntimeDescriptorAfterPublication(path, descriptor(), publication);

    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
    releasePublication?.();

    expect(await removal).toBe(true);
    await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
