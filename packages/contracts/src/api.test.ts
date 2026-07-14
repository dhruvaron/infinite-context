import { describe, expect, it } from "vitest";

import {
  ApiErrorSchema,
  ImportVaultResponseSchema,
  PUBLIC_API_CONTRACTS,
  PUBLIC_API_RESOURCE_GROUPS,
  RunStreamWireEventSchema,
  SettingBatchMutationRequestSchema,
  TopicIdentitySchema,
  VaultSnapshotBoundarySchema,
  type PublicApiRequestBody,
  type PublicApiResponse
} from "./api.js";

const compileTimeMessageRequest = {
  content: "hello",
  attachmentIds: [],
  quality: "balanced",
  idempotencyKey: "message-request-1"
} satisfies PublicApiRequestBody<"messages.create">;

const compileTimeCancelResponse = { cancelled: true } satisfies PublicApiResponse<"runs.cancel">;
const compileTimeSettingsBatch = {
  mutations: [{ key: "theme", value: "dark" }],
  idempotencyKey: "settings-batch-1"
} satisfies PublicApiRequestBody<"settings.batch.put">;

describe("public API contract inventory", () => {
  it("generates request and response client types from the same route inventory", () => {
    expect(compileTimeMessageRequest.quality).toBe("balanced");
    expect(compileTimeCancelResponse.cancelled).toBe(true);
    expect(compileTimeSettingsBatch.mutations).toHaveLength(1);
  });

  it("bounds settings batches and rejects duplicate submitted keys", () => {
    expect(SettingBatchMutationRequestSchema.safeParse({ mutations: [], idempotencyKey: "empty-settings-batch" }).success).toBe(false);
    const oversized = SettingBatchMutationRequestSchema.safeParse({
      mutations: Array.from({ length: 33 }, (_, index) => ({ key: "system.instructions", value: String(index) })),
      idempotencyKey: "oversized-settings-batch"
    });
    expect(oversized.success).toBe(false);
    if (!oversized.success) expect(oversized.error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "too_big" })]));
    expect(SettingBatchMutationRequestSchema.safeParse({
      mutations: [{ key: "theme", value: "dark" }, { key: "theme", value: "light" }],
      idempotencyKey: "duplicate-settings-batch"
    }).success).toBe(false);
  });

  it("covers every section-11 resource group with unique route identities", () => {
    const ids = PUBLIC_API_CONTRACTS.map((contract) => contract.id);
    const routes = PUBLIC_API_CONTRACTS.map((contract) => `${contract.method} ${contract.path}`);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(routes).size).toBe(routes.length);
    expect(routes).not.toContain("POST /api/v1/budget/reset-impact");
    expect(routes).not.toContain("POST /api/v1/budget/reset");
    const groups = new Set(PUBLIC_API_CONTRACTS.map((contract) => contract.group));
    for (const group of PUBLIC_API_RESOURCE_GROUPS) expect(groups.has(group)).toBe(true);
  });

  it("defines a stable, user-safe error envelope", () => {
    expect(ApiErrorSchema.parse({ error: { code: "NOT_FOUND", message: "Not found.", retryable: false, traceId: "trace-1", details: { field: "id" } } }))
      .toEqual({ error: { code: "NOT_FOUND", message: "Not found.", retryable: false, traceId: "trace-1", details: { field: "id" } } });
    expect(ApiErrorSchema.safeParse({ message: "raw database failure" }).success).toBe(false);
  });

  it("defines a strict server-issued vault snapshot boundary", () => {
    const boundary = { generation: 42, maintenanceLocked: false, vaultId: "00000000-0000-4000-8000-000000000000" };
    expect(VaultSnapshotBoundarySchema.parse(boundary)).toEqual(boundary);
    expect(VaultSnapshotBoundarySchema.safeParse({ ...boundary, generation: -1 }).success).toBe(false);
    expect(VaultSnapshotBoundarySchema.safeParse({ ...boundary, extra: true }).success).toBe(false);
  });

  it("requires a version on every SSE data frame", () => {
    const event = { version: "v1", type: "run.cancelled", runId: "00000000-0000-4000-8000-000000000000" };
    expect(RunStreamWireEventSchema.parse(event)).toEqual(event);
    expect(RunStreamWireEventSchema.safeParse({ ...event, version: undefined }).success).toBe(false);
  });

  it("accepts exact topic UUIDs and safe slugs, never path-like identities", () => {
    expect(TopicIdentitySchema.safeParse("00000000-0000-4000-8000-000000000000").success).toBe(true);
    expect(TopicIdentitySchema.safeParse("project-continuum-v1").success).toBe(true);
    expect(TopicIdentitySchema.safeParse("../project").success).toBe(false);
    expect(TopicIdentitySchema.safeParse("Project Continuum").success).toBe(false);
  });

  it("keeps verified import handles structurally distinct from committed imports", () => {
    const verification = {
      valid: true,
      replaced: false,
      manifest: {},
      verificationToken: "00000000-0000-4000-8000-000000000000",
      archiveChecksum: "a".repeat(64),
      size: 42,
      expiresAt: "2026-07-14T12:00:00.000Z"
    };
    expect(ImportVaultResponseSchema.parse(verification)).toEqual(verification);
    expect(ImportVaultResponseSchema.safeParse({ valid: true, replaced: false, manifest: {} }).success).toBe(false);
    expect(ImportVaultResponseSchema.safeParse({
      valid: true,
      replaced: true,
      mode: "replace",
      manifest: {},
      attachmentsRestored: 0,
      rebuildJobs: 2,
      warnings: []
    }).success).toBe(true);
  });
});
