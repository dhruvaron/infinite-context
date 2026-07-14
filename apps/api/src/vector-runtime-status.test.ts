import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@continuum/config";
import type { ContinuumDatabase } from "@continuum/database";
import { VECTOR_FALLBACK_MAX_ROWS } from "@continuum/database";
import { buildApp } from "./app.js";

const fixtures: Array<{ root: string; app: Awaited<ReturnType<typeof buildApp>>["app"] }> = [];

afterEach(async () => {
  while (fixtures.length) {
    const value = fixtures.pop()!;
    await value.app.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

describe("visible vector runtime status", () => {
  it("reports native version/strategy and the bounded degraded limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "continuum-vector-runtime-"));
    const config = loadConfig({
      NODE_ENV: "test",
      CONTINUUM_DATA_DIR: root,
      CONTINUUM_MOCK_PROVIDER: "true",
      CONTINUUM_SESSION_TOKEN: "vector-runtime-test-token-00000000000000"
    });
    const built = await buildApp({ config });
    fixtures.push({ root, app: built.app });
    const headers = { authorization: `Bearer ${config.sessionToken}`, host: "127.0.0.1" };

    const ready = await built.app.inject({ method: "GET", url: "/api/v1/runtime", headers });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      vectorSearch: "ready",
      vectorMode: "sqlite-vec",
      vectorStrategy: "native-exact-cosine",
      vectorLoadStatus: "ready",
      vectorVersion: expect.any(String),
      vectorFallbackLimit: VECTOR_FALLBACK_MAX_ROWS
    });

    const database = built.services.database as ContinuumDatabase;
    database.vectorAvailable = false;
    database.vectorLoadStatus = "degraded";
    const degraded = await built.app.inject({ method: "GET", url: "/api/v1/runtime", headers });
    expect(degraded.statusCode).toBe(200);
    expect(degraded.json()).toMatchObject({
      vectorSearch: "fallback",
      vectorMode: "bounded-cosine-fallback",
      vectorStrategy: "bounded-json-cosine",
      vectorLoadStatus: "degraded",
      vectorFallbackLimit: VECTOR_FALLBACK_MAX_ROWS
    });
  });
});
