import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { LocalLogger, redactLogFields } from "./index.js";

describe("local prompt tracing", () => {
  it("redacts ordinary content unless tracing has been explicitly enabled", () => {
    expect(redactLogFields({ prompt: "private request", nested: { message: "private reply" } }, false)).toEqual({
      prompt: "[REDACTED]",
      nested: { message: "[REDACTED]" }
    });
    expect(redactLogFields({ prompt: "private request", nested: { message: "private reply" } }, true)).toEqual({
      prompt: "private request",
      nested: { message: "private reply" }
    });
  });

  it("always removes credential fields and credential patterns even in trace mode", () => {
    const fields = redactLogFields({
      apiKey: "sk-thismustneverreachlogs123456",
      prompt: "Use Bearer abcdefghijklmnop and OPENAI_API_KEY=sk-anothersecret123456789",
      nested: { authorization: "Bearer should-never-appear" }
    }, true);
    expect(fields.apiKey).toBe("[REDACTED]");
    expect(fields.nested).toEqual({ authorization: "[REDACTED]" });
    expect(String(fields.prompt)).not.toContain("abcdefghijklmnop");
    expect(String(fields.prompt)).not.toContain("sk-anothersecret");
  });

  it("keeps non-sensitive version and usage fields while redacting actual token credentials", () => {
    expect(redactLogFields({
      promptVersion: "response-v1",
      inputTokens: 123,
      cachedInputTokens: 45,
      tokenBudget: { evidence: 500 },
      sessionToken: "browser-session-secret",
      accessToken: "provider-access-secret"
    }, false)).toEqual({
      promptVersion: "response-v1",
      inputTokens: 123,
      cachedInputTokens: 45,
      tokenBudget: { evidence: 500 },
      sessionToken: "[REDACTED]",
      accessToken: "[REDACTED]"
    });
  });

  it("can change trace mode at runtime after the UI consent setting changes", () => {
    const logger = new LocalLogger("/private/tmp/continuum-observability-test", false);
    expect(logger.promptTracingEnabled).toBe(false);
    logger.setPromptTracing(true);
    expect(logger.promptTracingEnabled).toBe(true);
    logger.setPromptTracing(false);
    expect(logger.promptTracingEnabled).toBe(false);
  });

  it("serializes writes and rotates local files at the configured size boundary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuum-log-rotation-"));
    try {
      const logger = new LocalLogger(directory, false, 1_024);
      for (let index = 0; index < 20; index += 1) logger.info(`record-${index}`, { detail: "x".repeat(180) });
      await logger.flush();
      const files = (await readdir(directory)).filter((entry) => entry.endsWith(".jsonl"));
      expect(files.length).toBeGreaterThan(1);
      const records = (await Promise.all(files.map((entry) => readFile(join(directory, entry), "utf8"))))
        .flatMap((content) => content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { message: string }));
      expect(records.map((record) => record.message)).toEqual(Array.from({ length: 20 }, (_, index) => `record-${index}`));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("allows API and worker log pruning to race without hiding real failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuum-log-prune-race-"));
    try {
      for (let index = 0; index < 40; index += 1) {
        await writeFile(join(directory, `oversize-${index}.jsonl`), "x".repeat(2_048));
      }
      const apiLogger = new LocalLogger(directory);
      const workerLogger = new LocalLogger(directory);
      await expect(Promise.all([
        apiLogger.prune(7, 1_024),
        workerLogger.prune(7, 1_024)
      ])).resolves.toEqual([undefined, undefined]);
      expect((await readdir(directory)).filter((entry) => entry.endsWith(".jsonl"))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
