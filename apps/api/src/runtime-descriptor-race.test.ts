import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({
  canonicalPath: "",
  replacement: "",
  replaceAfterRead: false
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: unknown[]) => {
      const contents = await Reflect.apply(actual.readFile, actual, args);
      if (race.replaceAfterRead) {
        race.replaceAfterRead = false;
        await actual.writeFile(race.canonicalPath, race.replacement, { mode: 0o600 });
      }
      return contents;
    }
  };
});

const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const { removeOwnedRuntimeDescriptor, writeRuntimeDescriptor } = await import("./runtime-descriptor.js");

describe("runtime descriptor replacement race", () => {
  it("cannot unlink a newer descriptor published after ownership was read", async () => {
    const directory = await actualFs.mkdtemp(join(tmpdir(), "continuum-runtime-race-"));
    const path = join(directory, "runtime.json");
    const owner = {
      pid: 42,
      origin: "http://127.0.0.1:4317",
      bootstrapUrl: "http://127.0.0.1:4317/bootstrap?token=old",
      startedAt: "2026-07-13T00:00:00.000Z",
      version: "0.1.0"
    };
    const replacement = {
      ...owner,
      pid: 99,
      bootstrapUrl: "http://127.0.0.1:4318/bootstrap?token=new",
      startedAt: "2026-07-13T00:01:00.000Z"
    };
    await writeRuntimeDescriptor(path, owner);
    race.canonicalPath = path;
    race.replacement = JSON.stringify(replacement);
    race.replaceAfterRead = true;

    expect(await removeOwnedRuntimeDescriptor(path, owner)).toBe(false);
    expect(JSON.parse(await actualFs.readFile(path, "utf8"))).toEqual(replacement);
  });
});
