import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const token = "continuum-e2e-session-token-0000000000000000";
const controlToken = "continuum-e2e-control-token-00000000000000";
const supervisorOrigin = "http://127.0.0.1:4318";
let exportedVaultPath: string | null = null;
let authCookies: Awaited<ReturnType<BrowserContext["cookies"]>> | null = null;

test.describe.serial("polished local-vault journeys", () => {
  test.beforeEach(async ({ request }) => {
    // Each journey still reuses the durable vault, but a fresh API process
    // isolates its intentionally global per-minute limiter. This also makes a
    // Playwright retry independent of the one-use bootstrap consumed earlier.
    await testControl(request, "/crash-api");
    await testControl(request, "/restart-api");
  });

  test("onboards, streams two grounded turns, searches, pins evidence, and survives reload", async ({ page, baseURL }) => {
    await enterContinuum(page, baseURL!);

    await send(page, "Remember that the Playwright continuity marker is cobalt.");
    await expect(page.getByText(/local test response to/i).last()).toBeVisible();
    await send(page, "What continuity marker did I ask you to remember?");
    await expect(page.getByText(/checked the relevant local memory/i).last()).toBeVisible();

    await page.getByRole("button", { name: /Search memory/i }).click();
    const search = page.getByRole("textbox", { name: "Search all memory" });
    await search.fill("cobalt");
    const result = page.getByRole("listbox", { name: "Search results" }).getByRole("option", { name: /You event.*cobalt/i }).first();
    await expect(result).toBeVisible();
    await result.click();
    await expect(page.getByRole("dialog", { name: /search your entire history/i })).toBeHidden();
    await expect(page.locator("article.message-highlight").filter({ hasText: "cobalt" })).toBeVisible();

    await page.getByRole("button", { name: "Open memory inspector" }).click();
    const inspector = page.getByRole("complementary", { name: "Memory inspector" });
    await expect(inspector).toBeVisible();
    const memoryCard = inspector.locator(".memory-card").first();
    await expect(memoryCard).toBeVisible();
    await memoryCard.getByRole("button", { name: /actions for/i }).click();
    const pin = memoryCard.getByRole("button", { name: "Pin to context" });
    const unpin = memoryCard.getByRole("button", { name: "Unpin" });
    await expect(pin.or(unpin)).toBeVisible();
    // A retry or a later browser can revisit the same durable evidence after
    // the first engine has already pinned it. Both states prove the control is
    // usable; only mutate when the memory is not yet pinned.
    if (await pin.isVisible()) await pin.click();
    await expect(memoryCard.getByText("Pinned")).toBeVisible();
    await inspector.getByRole("button", { name: "Close memory inspector" }).click();

    await page.reload();
    await expect(page.getByText(/Playwright continuity marker is cobalt/i).first()).toBeVisible();
  });

  test("shows attachment processing, persists the citation source, and applies deletion impact", async ({ page, baseURL }) => {
    await enterContinuum(page, baseURL!);
    const composer = page.locator("form.composer");
    await composer.locator('input[type="file"]').setInputFiles({
      name: "continuum-e2e-note.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("The attachment evidence marker is marigold.\n")
    });
    await expect(composer.getByText("continuum-e2e-note.txt")).toBeVisible();
    await page.getByRole("textbox", { name: "Message Continuum" }).fill("Retain this attached evidence.");
    await page.getByRole("button", { name: "Send message" }).click();
    const fileCard = page.locator(".message-file").filter({ hasText: "continuum-e2e-note.txt" });
    await expect(fileCard).toContainText("ready", { timeout: 20_000 });
    await expect(page.getByText(/local test response to/i).last()).toBeVisible();

    await page.getByRole("button", { name: "Delete continuum-e2e-note.txt permanently" }).click();
    const deletion = page.getByRole("dialog", { name: "Delete permanently?" });
    await expect(deletion.getByText(/claims retained/i)).toBeVisible();
    await deletion.getByRole("button", { name: "Delete permanently" }).click();
    await expect(fileCard).toBeHidden();
  });

  test("regenerates into persisted revisions and exposes answer-specific debug", async ({ page, baseURL }) => {
    await enterContinuum(page, baseURL!);
    const latestAnswer = page.locator("article.assistant-message").last();
    await latestAnswer.getByRole("button", { name: "Regenerate response" }).click();
    await expect(page.getByText("Answer complete").last()).toBeVisible();
    const regenerated = page.locator("article.assistant-message").last();
    await regenerated.getByRole("button", { name: "View persisted response revisions" }).click();
    const revisions = page.getByRole("dialog", { name: "Persisted response revisions" });
    await expect(revisions.getByRole("button", { name: /revision 1/i })).toBeVisible();
    await expect(revisions.getByRole("button", { name: /revision 2/i })).toBeVisible();
    await revisions.getByRole("button", { name: "Close" }).first().click();

    await regenerated.getByRole("button", { name: "Inspect this answer’s provenance" }).click();
    await expect(page.getByRole("heading", { name: "Candidate ranking" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Context packet" })).toBeVisible();
    await page.getByRole("complementary", { name: "Memory inspector" }).getByRole("button", { name: "Close memory inspector" }).click();
  });

  test("manages backups, workspace authorization, export, and verified import", async ({ page, baseURL }) => {
    await enterContinuum(page, baseURL!);
    const settings = await openDataSettings(page);

    const createBackup = settings.getByRole("button", { name: /create backup now/i });
    await createBackup.click();
    await expect(settings.getByRole("button", { name: "Creating…" })).toBeVisible();
    await expect(createBackup).toBeEnabled({ timeout: 20_000 });
    await expect(settings.getByText(/Last backup/i)).toBeVisible();

    const fixture = await testControl(page.request, "/workspace-fixture");
    await settings.getByLabel("Absolute folder path").fill(String(fixture.root));
    await settings.getByLabel(/Display name/).fill("E2E temporary workspace");
    await settings.getByRole("button", { name: /authorize read-only/i }).click();
    await expect(settings.getByText("E2E temporary workspace")).toBeVisible();
    await settings.getByRole("button", { name: "Revoke access to E2E temporary workspace" }).click();
    await expect(settings.getByText("E2E temporary workspace")).toBeHidden();

    const downloadPromise = page.waitForEvent("download");
    await settings.getByRole("button", { name: /export vault/i }).click();
    const download = await downloadPromise;
    exportedVaultPath = await download.path();
    expect(exportedVaultPath).not.toBeNull();
    await expect(settings.getByText(/is ready/i)).toBeVisible();

    await settings.locator('input[type="file"][accept*="zip"]').setInputFiles(exportedVaultPath!);
    await expect(settings.getByText(/checksums and schema are valid/i)).toBeVisible({ timeout: 20_000 });
    await waitForBackgroundWork(page);
    await settings.getByRole("button", { name: "Replace with exact vault" }).click();
    const retryImport = settings.getByRole("button", { name: "Retry exact replacement" });
    await expect.poll(async () => await page.getByText(/Imported vault is ready/i).isVisible() || await retryImport.isVisible(), { timeout: 20_000 }).toBe(true);
    if (await retryImport.isVisible()) {
      await waitForBackgroundWork(page);
      await retryImport.click();
    }
    await expect(page.getByText(/Imported vault is ready/i)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Playwright continuity marker is cobalt/i).first()).toBeVisible();
  });

  test("retains editable drafts through a local-service outage and stays usable at mobile width", async ({ page, baseURL }) => {
    await enterContinuum(page, baseURL!);
    const composer = page.getByRole("textbox", { name: "Message Continuum" });
    await composer.fill("This draft must survive a provider or service outage.");
    await page.route("**/api/v1/**", (route) => route.abort("connectionrefused"));
    await page.reload();
    await expect(page.getByText("Local service offline")).toBeVisible();
    await expect(composer).toHaveValue("This draft must survive a provider or service outage.");
    await expect(composer).toBeEditable();
    await expect(page.getByRole("button", { name: "Send message" })).toBeDisabled();
    await page.unroute("**/api/v1/**");
    await page.getByRole("button", { name: "Retry connection" }).click();
    await expect(page.getByText("One continuous conversation")).toBeVisible();
    await composer.fill("");

    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.getByRole("button", { name: "Open knowledge graph" }).click();
    const graph = page.getByRole("complementary", { name: "Knowledge graph" });
    await expect(graph).toBeVisible();
    const box = await graph.boundingBox();
    expect(box?.width).toBeLessThanOrEqual(391);
    await graph.getByRole("button", { name: "Close knowledge graph" }).click();
    await page.keyboard.press("Control+K");
    await expect(page.getByRole("dialog", { name: /search your entire history/i })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Search all memory" })).toBeFocused();
    await page.keyboard.press("Escape");
  });

  test("requires current impact and exact phrase before deleting the entire vault", async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await enterContinuum(page, baseURL!);
    const settings = await openDataSettings(page);
    await settings.getByRole("button", { name: /start over/i }).click();
    const reset = page.getByRole("dialog", { name: "Destroy the entire vault?" });
    await expect(reset.getByLabel("Current vault deletion impact")).toBeVisible();
    const destroy = reset.getByRole("button", { name: "Destroy vault" });
    await expect(destroy).toBeDisabled();
    await reset.getByRole("textbox").fill("DELETE MY CONTINUUM VAULT");
    await expect(destroy).toBeEnabled();
    await destroy.click();
    await expect(page.getByRole("heading", { name: "Your history stays addressable." })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Playwright continuity marker is cobalt/i)).toBeHidden();
  });
});

async function enterContinuum(page: Page, baseURL: string) {
  if (authCookies) {
    await page.context().addCookies(authCookies);
    await page.goto(baseURL);
  } else {
    await page.goto(`http://127.0.0.1:4317/bootstrap?token=${token}&returnTo=${encodeURIComponent(baseURL)}`);
  }
  await page.waitForLoadState("domcontentloaded");
  // The shell can render its composer before the asynchronous bootstrap opens
  // onboarding. Wait for that decision, then drive the dialog by its stable
  // controls because its accessible name changes between steps.
  await page.waitForTimeout(300);
  const welcome = page.getByRole("dialog", { name: "Welcome" });
  if (await welcome.isVisible()) {
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Set this up later" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Enter Continuum" }).click();
    await expect(page.locator(".modal-backdrop")).toBeHidden();
  }
  await expect(page.getByRole("textbox", { name: "Message Continuum" })).toBeVisible();
  authCookies = await page.context().cookies();
}

async function send(page: Page, content: string) {
  await page.getByRole("textbox", { name: "Message Continuum" }).fill(content);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({ timeout: 20_000 });
}

async function openDataSettings(page: Page) {
  await page.getByRole("button", { name: "Open settings" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Data" }).click();
  await expect(settings.getByText("Portable vault")).toBeVisible();
  return settings;
}

async function waitForBackgroundWork(page: Page) {
  await expect.poll(async () => {
    const response = await page.request.get("http://127.0.0.1:4317/api/v1/memory-jobs?limit=100");
    if (!response.ok()) return false;
    const payload = await response.json() as { jobs?: Array<{ status?: string }> };
    return (payload.jobs ?? []).every((job) => job.status !== "queued" && job.status !== "running");
  }, { message: "background memory work to drain before vault maintenance", timeout: 20_000 }).toBe(true);
}

async function testControl(request: Page["request"], path: string): Promise<Record<string, unknown>> {
  const response = await request.post(`${supervisorOrigin}${path}`, {
    headers: { "X-Continuum-E2E-Control": controlToken, "Content-Type": "application/json" },
    data: {}
  });
  const body = await response.text();
  expect(response.ok(), `${path} should succeed: ${body}`).toBe(true);
  return JSON.parse(body) as Record<string, unknown>;
}
