import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const token = "continuum-e2e-session-token-0000000000000000";
const controlToken = "continuum-e2e-control-token-00000000000000";
const apiOrigin = "http://127.0.0.1:4317";
const supervisorOrigin = "http://127.0.0.1:4318";
const apiControlOrigin = "http://127.0.0.1:4319";

type JsonRecord = Record<string, any>;

test.describe.serial("no-cost reliability and boundary journeys", () => {
  test("stops a persisted response safely from the real composer in every browser", async ({ page, baseURL }) => {
    await enterWithSessionCookie(page, baseURL!);
    let seeded: JsonRecord | null = null;
    await page.route("**/api/v1/messages", async (route) => {
      seeded = await controlPost(page.request, apiControlOrigin, "/seed-pending-run", {
        content: "Stop-button durability marker.",
        idempotencyKey: idempotency("stop")
      });
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(seeded) });
    });

    await page.getByRole("textbox", { name: "Message Continuum" }).fill("Stop this response after my message is durably saved.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("button", { name: "Stop response" })).toBeVisible();
    await page.getByRole("button", { name: "Stop response" }).click();
    // The acknowledgement label is intentionally brief; the durable UX state
    // is an editable composer with Send restored and no cancellation error.
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message Continuum" })).toBeEditable();
    await expect(page.getByText("Stop was not confirmed")).toBeHidden();

    expect(seeded).not.toBeNull();
    const run = await apiGet(page.request, `/runs/${seeded!.runId}`);
    expect(run.status).toBe("cancelled");
    expect(run.cancellationRequested).toBe(true);
    const retry = await apiPost(page.request, `/runs/${seeded!.runId}/cancel`, { idempotencyKey: idempotency("stop-again") });
    expect(retry.cancelled).toBe(false);
    await page.unroute("**/api/v1/messages");
    await expectZeroSpend(page.request);
  });

  test("enforces an actual read-only root, symlink boundary, and exact one-use secret approval", async ({ request, browserName }) => {
    test.skip(browserName !== "chromium", "The backend boundary is browser-independent and is exercised once.");
    const fixture = await controlPost(request, supervisorOrigin, "/workspace-fixture", {});
    const workspace = await apiPost(request, "/workspaces", {
      path: fixture.root,
      displayName: "Reliability boundary fixture",
      idempotencyKey: idempotency("workspace")
    });
    expect(workspace.readOnly).toBe(true);

    const ordinary = await executeTool(request, {
      userRequest: "Read notes.txt from the authorized workspace files.",
      name: "workspace_read",
      arguments: { rootId: workspace.id, path: "notes.txt" }
    });
    expect(toolData(ordinary).content).toContain("juniper");

    const lexicalEscape = await executeTool(request, {
      userRequest: "Read a file path from the authorized workspace.",
      name: "workspace_read",
      arguments: { rootId: workspace.id, path: "../outside-workspace-canary.txt" }
    });
    expect(toolError(lexicalEscape).code).toBe("BOUNDARY_VIOLATION");
    expect(lexicalEscape.output).not.toContain("scarlet");

    const symlinkEscape = await executeTool(request, {
      userRequest: "Read escape.txt from the authorized workspace files.",
      name: "workspace_read",
      arguments: { rootId: workspace.id, path: "escape.txt" }
    });
    expect(toolError(symlinkEscape).code).toBe("BOUNDARY_VIOLATION");
    expect(symlinkEscape.output).not.toContain("scarlet");

    const blockedSecret = await executeTool(request, {
      userRequest: "Read secrets.txt from the authorized workspace files.",
      name: "workspace_read",
      // This flag is the tool-side assertion that exact user approval exists;
      // without a matching in-memory grant it must still fail closed.
      arguments: { rootId: workspace.id, path: "secrets.txt", allowLikelySecret: true }
    });
    expect(toolError(blockedSecret).code).toBe("SECRET_BLOCKED");

    const approval = await apiPost(request, `/workspaces/${workspace.id}/secret-approvals`, {
      relativePath: "secrets.txt",
      acknowledgement: true,
      idempotencyKey: idempotency("secret-approval")
    });
    expect(approval.rootId).toBe(workspace.id);
    expect(approval.relativePath).toBe("secrets.txt");

    const approvedRead = await executeTool(request, {
      userRequest: "Read secrets.txt from the authorized workspace files after exact user approval.",
      name: "workspace_read",
      arguments: { rootId: workspace.id, path: "secrets.txt", allowLikelySecret: true }
    });
    expect(toolData(approvedRead).content).toContain("ONE_USE_SECRET_CANARY=violet");

    const consumedApproval = await executeTool(request, {
      userRequest: "Read secrets.txt from the authorized workspace files after exact user approval.",
      name: "workspace_read",
      arguments: { rootId: workspace.id, path: "secrets.txt", allowLikelySecret: true }
    });
    expect(toolError(consumedApproval).code).toBe("SECRET_BLOCKED");

    const revoked = await apiDelete(request, `/workspaces/${workspace.id}`, { idempotencyKey: idempotency("revoke-workspace") });
    expect(revoked.revoked).toBe(true);
    const afterRevoke = await executeTool(request, {
      userRequest: "Read notes.txt from the authorized workspace files.",
      name: "workspace_read",
      arguments: { rootId: workspace.id, path: "notes.txt" }
    });
    expect(toolError(afterRevoke).code).toBe("NOT_AUTHORIZED");
    await expectZeroSpend(request);
  });

  test("executes useful code while the disposable sandbox denies host files and all network", async ({ request, browserName }) => {
    test.skip(browserName !== "chromium", "The operating-system sandbox is browser-independent and is exercised once.");
    const fixture = await controlPost(request, supervisorOrigin, "/workspace-fixture", {});

    const successful = await executeTool(request, {
      userRequest: "Run this JavaScript code in the sandbox.",
      name: "execute_code",
      arguments: { language: "javascript", code: "console.log(6 * 7);" }
    });
    expect(successful.tool.sandbox.status).toBe("completed");
    expect(successful.tool.sandbox.network).toBe("denied");
    expect(toolData(successful).content).toContain("42");

    const filesystem = await executeTool(request, {
      userRequest: "Run this JavaScript code to test its filesystem boundary.",
      name: "execute_code",
      arguments: {
        language: "javascript",
        code: `import { readFileSync } from "node:fs"; try { console.log(readFileSync(${JSON.stringify(fixture.outsidePath)}, "utf8")); } catch (error) { console.error(error instanceof Error ? error.name : "denied"); process.exitCode = 18; }`
      }
    });
    expect(filesystem.tool.sandbox.status).toBe("failed");
    expect(filesystem.tool.sandbox.filesystem).toBe("disposable");
    expect(filesystem.output).not.toContain("OUTSIDE_WORKSPACE_CANARY=scarlet");

    const network = await executeTool(request, {
      userRequest: "Run this JavaScript code to test its network boundary.",
      name: "execute_code",
      arguments: {
        language: "javascript",
        code: `try { const response = await fetch("${apiOrigin}/api/v1/health"); console.log(await response.text()); } catch (error) { console.error(error instanceof Error ? error.name : "denied"); process.exitCode = 17; }`
      }
    });
    expect(network.tool.sandbox.status).toBe("failed");
    expect(network.tool.sandbox.network).toBe("denied");
    expect(network.output).not.toContain('"status":"ok"');
    await expectZeroSpend(request);
  });

  test("preserves evidence through correction, entity merge, graph traversal, and exact reversal", async ({ request, browserName }) => {
    test.skip(browserName !== "chromium", "The memory mutation APIs are browser-independent and are exercised once.");
    const fixture = await controlPost(request, apiControlOrigin, "/seed-memory-fixture", { marker: randomMarker() });

    const initialClaim = await apiGet(request, `/claims/${fixture.claimId}`);
    expect(initialClaim.claim.status).toBe("current");
    expect(initialClaim.evidence).toContainEqual(expect.objectContaining({ sourceId: fixture.primaryEvidenceId }));

    const initialGraph = await apiGet(request, `/graph?focusId=${fixture.targetEntityId}&hops=2&limit=100`);
    const ownedBy = initialGraph.edges.find((edge: JsonRecord) => edge.id === fixture.targetEdgeId);
    expect(ownedBy?.evidenceIds).toEqual([fixture.primaryEvidenceId]);
    const evidence = await apiGet(request, `/evidence/${fixture.primaryEvidenceId}`);
    expect(evidence.type).toBe("event");
    expect(evidence.record.content).toContain("owned by Northstar Team");

    const correction = await apiPost(request, `/claims/${fixture.claimId}/correct`, {
      value: "Northstar Foundation",
      reason: "The owning organization changed after the original evidence.",
      idempotencyKey: idempotency("correct-claim")
    });
    expect(correction.supersededClaimId).toBe(fixture.claimId);
    expect(correction.claim.status).toBe("current");
    const oldClaim = await apiGet(request, `/claims/${fixture.claimId}`);
    expect(oldClaim.claim.status).toBe("superseded");
    const corrected = await apiGet(request, `/claims/${correction.claim.id}`);
    expect(corrected.claim.value).toBe("Northstar Foundation");
    expect(corrected.relations).toContainEqual(expect.objectContaining({ type: "supersedes", targetClaimId: fixture.claimId }));
    const correctionEvidence = await apiGet(request, `/evidence/${correction.event.id}`);
    expect(correctionEvidence.record.kind).toBe("revision");

    const impact = await apiPost(request, "/entities/merge-impact", {
      sourceId: fixture.sourceEntityId,
      targetId: fixture.targetEntityId,
      idempotencyKey: idempotency("merge-impact")
    });
    expect(impact.impact.reversible).toBe(true);
    expect(impact.impact.edgesRewritten).toBeGreaterThanOrEqual(1);
    const merged = await apiPost(request, "/entities/merge", {
      sourceId: fixture.sourceEntityId,
      targetId: fixture.targetEntityId,
      confirmationToken: impact.confirmationToken,
      idempotencyKey: idempotency("merge")
    });
    const mergedSource = await apiGet(request, `/entities/${fixture.sourceEntityId}`);
    expect(mergedSource.entity.status).toBe("merged");
    const mergedTarget = await apiGet(request, `/entities/${fixture.targetEntityId}`);
    expect(mergedTarget.aliases).toContainEqual(expect.objectContaining({ normalizedAlias: "atlas platform legacy" }));
    const mergedGraph = await apiGet(request, `/graph?focusId=${fixture.targetEntityId}&hops=2&limit=100`);
    const migratedEdge = mergedGraph.edges.find((edge: JsonRecord) => edge.type === "maintained_by");
    expect(migratedEdge?.source).toBe(fixture.targetEntityId);
    expect(migratedEdge?.evidenceIds).toEqual([fixture.legacyEvidenceId]);
    const migratedEvidence = await apiGet(request, `/evidence/${migratedEdge.evidenceIds[0]}`);
    expect(migratedEvidence.record.content).toContain("maintained by Northstar Team");

    const reversed = await apiPost(request, `/entities/merges/${merged.mergeId}/reverse`, { idempotencyKey: idempotency("reverse-merge") });
    expect(reversed.reversedAt).toBeTruthy();
    const restoredSource = await apiGet(request, `/entities/${fixture.sourceEntityId}`);
    expect(restoredSource.entity.status).toBe("active");
    expect(restoredSource.aliases).toContainEqual(expect.objectContaining({ normalizedAlias: "atlas platform legacy" }));
    const restoredTarget = await apiGet(request, `/entities/${fixture.targetEntityId}`);
    expect(restoredTarget.aliases).not.toContainEqual(expect.objectContaining({ normalizedAlias: "atlas platform legacy" }));
    const restoredGraph = await apiGet(request, `/graph?focusId=${fixture.sourceEntityId}&hops=2&limit=100`);
    const restoredEdge = restoredGraph.edges.find((edge: JsonRecord) => edge.id === fixture.sourceEdgeId);
    expect(restoredEdge?.source).toBe(fixture.sourceEntityId);
    expect(restoredEdge?.evidenceIds).toEqual([fixture.legacyEvidenceId]);
    await expectZeroSpend(request);
  });

  test("reconciles a hard API crash exactly once without duplicating persisted messages", async ({ request, browserName }) => {
    test.skip(browserName !== "chromium", "Process recovery is browser-independent and is exercised once.");
    const seeded = await controlPost(request, apiControlOrigin, "/seed-recovery-run", {
      content: "Durable API crash marker.",
      idempotencyKey: idempotency("api-crash")
    });
    const before = await controlPost(request, apiControlOrigin, "/inspect", { kind: "run", runId: seeded.runId });
    expect(before.run.status).toBe("streaming");
    expect(Number(before.counts.assistants)).toBe(1);

    await controlPost(request, supervisorOrigin, "/crash-api", {});
    await expectApiOffline(request);
    await controlPost(request, supervisorOrigin, "/restart-api", {});

    const recovered = await apiGet(request, `/runs/${seeded.runId}`);
    expect(recovered.status).toBe("failed");
    expect(recovered.errorCode).toBe("API_RESTARTED");
    const after = await controlPost(request, apiControlOrigin, "/inspect", { kind: "run", runId: seeded.runId });
    expect(Number(after.counts.runs)).toBe(1);
    expect(Number(after.counts.users)).toBe(1);
    expect(Number(after.counts.assistants)).toBe(1);
    expect(Number(after.counts.streamEvents)).toBe(3);
    expect(after.assistant).toEqual([expect.objectContaining({ id: seeded.assistantEventId, status: "incomplete", active: 1 })]);
    const visibleEvents = await apiGet(request, "/events?limit=20");
    expect(visibleEvents.events).toContainEqual(expect.objectContaining({
      id: seeded.assistantEventId,
      status: "incomplete",
      active: true,
      content: "Persisted partial response before an intentional API crash."
    }));

    await controlPost(request, supervisorOrigin, "/crash-api", {});
    await controlPost(request, supervisorOrigin, "/restart-api", {});
    const secondRestart = await controlPost(request, apiControlOrigin, "/inspect", { kind: "run", runId: seeded.runId });
    expect(Number(secondRestart.counts.runs)).toBe(1);
    expect(Number(secondRestart.counts.assistants)).toBe(1);
    expect(Number(secondRestart.counts.streamEvents)).toBe(3);
    const secondVisibleEvents = await apiGet(request, "/events?limit=20");
    expect(secondVisibleEvents.events).toContainEqual(expect.objectContaining({
      id: seeded.assistantEventId,
      status: "incomplete",
      active: true,
      content: "Persisted partial response before an intentional API crash."
    }));
    await expectZeroSpend(request);
  });

  test("reclaims an expired worker lease and keeps both the job and its derived vector single-copy", async ({ request, browserName }) => {
    test.skip(browserName !== "chromium", "Process recovery is browser-independent and is exercised once.");
    await controlPost(request, supervisorOrigin, "/crash-worker", {});
    const key = `e2e-worker-recovery-${randomMarker()}`;
    const seeded = await controlPost(request, apiControlOrigin, "/seed-expired-job", { idempotencyKey: key });
    const before = await controlPost(request, apiControlOrigin, "/inspect", { kind: "job", jobId: seeded.jobId, sourceId: seeded.sourceId });
    expect(before.job.status).toBe("running");
    expect(Number(before.counts.jobs)).toBe(1);
    expect(Number(before.counts.attempts)).toBe(1);
    expect(Number(before.counts.vectors)).toBe(0);

    await controlPost(request, supervisorOrigin, "/restart-worker", {});
    await expect.poll(async () => {
      const state = await controlPost(request, apiControlOrigin, "/inspect", { kind: "job", jobId: seeded.jobId, sourceId: seeded.sourceId });
      return { status: state.job.status, vectors: Number(state.counts.vectors) };
    }, { timeout: 20_000, message: "the restarted worker to reclaim and finish the expired lease" }).toEqual({ status: "complete", vectors: 1 });

    const duplicateSeed = await controlPost(request, apiControlOrigin, "/seed-expired-job", { idempotencyKey: key });
    expect(duplicateSeed.jobId).toBe(seeded.jobId);
    expect(duplicateSeed.existing).toBe(true);
    let after = await controlPost(request, apiControlOrigin, "/inspect", { kind: "job", jobId: seeded.jobId, sourceId: seeded.sourceId });
    expect(Number(after.counts.jobs)).toBe(1);
    expect(Number(after.counts.attempts)).toBe(2);
    expect(Number(after.counts.vectors)).toBe(1);

    await controlPost(request, supervisorOrigin, "/crash-worker", {});
    await controlPost(request, supervisorOrigin, "/restart-worker", {});
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 700));
    after = await controlPost(request, apiControlOrigin, "/inspect", { kind: "job", jobId: seeded.jobId, sourceId: seeded.sourceId });
    expect(after.job.status).toBe("complete");
    expect(Number(after.counts.jobs)).toBe(1);
    expect(Number(after.counts.attempts)).toBe(2);
    expect(Number(after.counts.vectors)).toBe(1);
    await expectZeroSpend(request);
  });
});

async function enterWithSessionCookie(page: Page, baseURL: string): Promise<void> {
  await page.context().addCookies([{ name: "continuum_session", value: token, url: baseURL, httpOnly: true, sameSite: "Strict" }]);
  await page.goto(baseURL);
  await page.waitForLoadState("domcontentloaded");
  // The shell renders before the asynchronous bootstrap decides whether to
  // open onboarding, so do not treat the background composer as readiness.
  await page.waitForTimeout(300);
  const welcome = page.getByRole("dialog", { name: "Welcome" });
  if (await welcome.isVisible()) {
    // The dialog's accessible name changes on every onboarding step.
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Set this up later" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Enter Continuum" }).click();
    await expect(page.locator(".modal-backdrop")).toBeHidden();
  }
  await expect(page.getByRole("textbox", { name: "Message Continuum" })).toBeVisible();
}

async function apiGet(request: APIRequestContext, path: string): Promise<JsonRecord> {
  const response = await request.get(`${apiOrigin}/api/v1${path}`, { headers: apiHeaders(false) });
  return checkedJson(response);
}

async function apiPost(request: APIRequestContext, path: string, data: unknown): Promise<JsonRecord> {
  const response = await request.post(`${apiOrigin}/api/v1${path}`, { headers: apiHeaders(true), data });
  return checkedJson(response);
}

async function apiDelete(request: APIRequestContext, path: string, data: unknown): Promise<JsonRecord> {
  const response = await request.delete(`${apiOrigin}/api/v1${path}`, { headers: apiHeaders(true), data });
  return checkedJson(response);
}

async function controlPost(request: APIRequestContext, origin: string, path: string, data: unknown): Promise<JsonRecord> {
  const response = await request.post(`${origin}${path}`, {
    headers: { "X-Continuum-E2E-Control": controlToken, "Content-Type": "application/json" },
    data
  });
  return checkedJson(response);
}

async function checkedJson(response: Awaited<ReturnType<APIRequestContext["get"]>>): Promise<JsonRecord> {
  if (!response.ok()) throw new Error(`Request ${response.url()} failed with ${response.status()}: ${await response.text()}`);
  return await response.json() as JsonRecord;
}

function apiHeaders(mutation: boolean): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...(mutation ? { "X-Continuum-Request": "1", "Content-Type": "application/json" } : {})
  };
}

async function executeTool(request: APIRequestContext, input: { userRequest: string; name: string; arguments: Record<string, unknown> }): Promise<JsonRecord> {
  return controlPost(request, apiControlOrigin, "/tool-execute", input);
}

function parsedToolOutput(result: JsonRecord): JsonRecord {
  return JSON.parse(String(result.output)) as JsonRecord;
}

function toolData(result: JsonRecord): JsonRecord {
  const parsed = parsedToolOutput(result);
  if (parsed.type !== "continuum.untrusted_tool_evidence") throw new Error(`Expected tool evidence, received ${result.output}`);
  return parsed.data as JsonRecord;
}

function toolError(result: JsonRecord): JsonRecord {
  const parsed = parsedToolOutput(result);
  if (parsed.type !== "continuum.tool_error") throw new Error(`Expected a tool error, received ${result.output}`);
  return parsed.error as JsonRecord;
}

async function expectZeroSpend(request: APIRequestContext): Promise<void> {
  const budget = await apiGet(request, "/budget");
  expect(Number(budget.spentUsd)).toBe(0);
  expect(Number(budget.reservedUsd)).toBe(0);
}

async function expectApiOffline(request: APIRequestContext): Promise<void> {
  let offline = false;
  try {
    const response = await request.get(`${apiOrigin}/api/v1/health`, { headers: apiHeaders(false), timeout: 1_000 });
    offline = !response.ok();
  } catch {
    offline = true;
  }
  expect(offline).toBe(true);
}

function idempotency(prefix: string): string {
  return `e2e-${prefix}-${crypto.randomUUID()}`;
}

function randomMarker(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 16);
}
