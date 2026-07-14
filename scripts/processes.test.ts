import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run, terminateAndWait } from "./processes.js";

describe("source process supervisor", () => {
  it("waits for graceful child cleanup before returning from termination", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuum-supervisor-"));
    const marker = join(directory, "cleanup.txt");
    const child = run(process.execPath, [
      "-e",
      `const { writeFile } = require("node:fs");
       process.once("SIGTERM", () => setTimeout(() => writeFile(process.argv[1], "complete", () => process.exit(0)), 75));
       process.stdout.write("ready\\n");
       setInterval(() => undefined, 1_000);`,
      marker
    ], { quiet: true });
    if (!child.stdout) throw new Error("Expected the quiet child to expose stdout.");
    await once(child.stdout, "data");

    await terminateAndWait([child], 1_000);

    expect(await readFile(marker, "utf8")).toBe("complete");
    expect(child.exitCode).toBe(0);
  });

  it("does not double-signal a child already interrupted by the terminal process group", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuum-supervisor-"));
    const marker = join(directory, "signals.txt");
    const child = run(process.execPath, [
      "-e",
      `const { writeFile } = require("node:fs");
       let signals = 0;
       process.on("SIGTERM", () => {
         signals += 1;
         setTimeout(() => writeFile(process.argv[1], String(signals), () => process.exit(0)), 75);
       });
       process.stdout.write("ready\\n");
       setInterval(() => undefined, 1_000);`,
      marker
    ], { quiet: true });
    if (!child.stdout) throw new Error("Expected the quiet child to expose stdout.");
    await once(child.stdout, "data");
    child.kill("SIGTERM");

    await terminateAndWait([child], 1_000, true);

    expect(await readFile(marker, "utf8")).toBe("1");
  });
});
