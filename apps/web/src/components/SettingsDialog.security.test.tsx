import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ApiRequestError, continuumApi } from "../lib/api-client";
import { demoBootstrap } from "../lib/demo-data";
import { SettingsDialog } from "./SettingsDialog";

const workspace = { id: "workspace-1", path: "/Users/example/project", displayName: "Example project", readOnly: true } as const;

function renderSettings(onSave = vi.fn().mockResolvedValue(undefined)) {
  render(<SettingsDialog
    open
    settings={{ ...demoBootstrap.settings, promptTracingEnabled: false, developerOverrides: false }}
    runtime={{ ...demoBootstrap.runtime, mode: "connected", apiReachable: true }}
    budget={demoBootstrap.budget}
    pinnedCount={0}
    onClose={vi.fn()}
    onSave={onSave}
    onReset={vi.fn()}
    onOpenMemory={vi.fn()}
    onProviderChanged={vi.fn().mockResolvedValue(undefined)}
    onVaultReplaced={vi.fn().mockResolvedValue(undefined)}
  />);
  return onSave;
}

describe("sensitive local settings", () => {
  beforeEach(() => {
    vi.spyOn(continuumApi, "listBackups").mockResolvedValue([]);
    vi.spyOn(continuumApi, "listWorkspaces").mockResolvedValue([workspace]);
  });
  afterEach(() => vi.restoreAllMocks());

  it("keeps prompt tracing separate and requires the inline raw-content acknowledgement", async () => {
    const user = userEvent.setup();
    const onSave = renderSettings();
    await user.click(screen.getByRole("button", { name: "Developer" }));
    expect(screen.getByText(/raw prompts, messages, and ordinary tool output are logged locally for up to 7 days/i)).toBeVisible();
    expect(screen.getByText(/recognized credential patterns and explicitly approved secret-file output are withheld/i)).toBeVisible();
    const traceSwitch = screen.getByRole("switch", { name: /enable raw prompt tracing/i });
    expect(traceSwitch).toBeDisabled();
    expect(screen.getByRole("switch", { name: /enable model overrides/i })).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: /I understand raw conversation and tool content/i }));
    expect(traceSwitch).toBeEnabled();
    await user.click(traceSwitch);
    expect(traceSwitch).toBeChecked();
    expect(screen.getByRole("switch", { name: /enable model overrides/i })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ promptTracingEnabled: true, developerOverrides: false }));
  });

  it("keeps secret files denied until an exact one-use path is explicitly approved", async () => {
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const approve = vi.spyOn(continuumApi, "approveWorkspaceSecretFile").mockResolvedValue({ id: "approval-1", workspaceId: workspace.id, relativePath: "config/private.env", expiresAt, oneUse: true, remainingUses: 1, status: "ready" });
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole("button", { name: "Data" }));
    expect(await screen.findByText(/likely-secret files denied by default/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: /one-use secret-file approval/i }));
    const allow = screen.getByRole("button", { name: "Allow one read" });
    expect(allow).toBeDisabled();
    const path = screen.getByRole("textbox", { name: `Secret file path for ${workspace.displayName}` });
    await user.type(path, "/private.env");
    expect(screen.getByRole("alert")).toHaveTextContent(/use a relative path/i);
    await user.clear(path);
    await user.type(path, "config/private.env");
    await user.click(screen.getByRole("checkbox", { name: /I approve one model-visible read/i }));
    expect(allow).toBeEnabled();
    await user.click(allow);
    await waitFor(() => expect(approve).toHaveBeenCalledWith(workspace.id, "config/private.env"));
    expect(await screen.findByText(/ready for one read/i)).toBeVisible();
  });

  it("states the non-renewable lifetime cap and offers no reset control", async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole("button", { name: "Models" }));
    expect(await screen.findByText(/one non-renewable \$100 lifetime cap/i)).toBeVisible();
    expect(screen.getByText(/vault deletion, replacement, import, or reinstalling/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /budget reset|new \$100 cycle/i })).not.toBeInTheDocument();
  });

  it("keeps a verified local import through settings refresh and retryable maintenance lock", async () => {
    const token = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    vi.spyOn(continuumApi, "verifyVaultImport").mockResolvedValue({
      valid: true,
      verificationToken: token,
      archiveChecksum: "b".repeat(64),
      size: 512,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      manifest: { counts: { events: 12 } }
    });
    const commit = vi.spyOn(continuumApi, "commitVerifiedVaultImport")
      .mockRejectedValueOnce(new ApiRequestError("Maintenance is still draining.", "MAINTENANCE_LOCKED", true, 423))
      .mockResolvedValueOnce({ valid: true, replaced: true });
    const onVaultReplaced = vi.fn().mockResolvedValue(undefined);
    const shared = {
      open: true,
      runtime: { ...demoBootstrap.runtime, mode: "connected" as const, apiReachable: true },
      budget: demoBootstrap.budget,
      pinnedCount: 0,
      onClose: vi.fn(),
      onSave: vi.fn().mockResolvedValue(undefined),
      onReset: vi.fn(),
      onOpenMemory: vi.fn(),
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      onVaultReplaced
    };
    const user = userEvent.setup();
    const view = render(<SettingsDialog {...shared} settings={demoBootstrap.settings} />);
    await user.click(screen.getByRole("button", { name: "Data" }));
    const input = screen.getByLabelText<HTMLInputElement>("Choose vault import file");
    await user.upload(input, new File(["vault"], "continuum.zip", { type: "application/zip" }));
    expect(await screen.findByRole("button", { name: "Replace with exact vault" })).toBeVisible();

    view.rerender(<SettingsDialog {...shared} settings={{ ...demoBootstrap.settings, quality: "deep" }} />);
    await user.click(screen.getByRole("button", { name: "Replace with exact vault" }));
    expect(await screen.findByRole("button", { name: "Retry exact replacement" })).toBeVisible();
    expect(commit).toHaveBeenLastCalledWith(token, "replace", expect.any(String));
    const firstCommitKey = commit.mock.calls[0]?.[2];
    await user.click(screen.getByRole("button", { name: "Retry exact replacement" }));
    await waitFor(() => expect(onVaultReplaced).toHaveBeenCalledOnce());
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls[1]?.[2]).toBe(firstCommitKey);
  });

  it("treats a lost import commit response as a vault boundary instead of offering an unsafe exact retry", async () => {
    const token = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    vi.spyOn(continuumApi, "verifyVaultImport").mockResolvedValue({
      valid: true,
      verificationToken: token,
      archiveChecksum: "c".repeat(64),
      size: 512,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      manifest: { counts: { events: 12 } }
    });
    vi.spyOn(continuumApi, "commitVerifiedVaultImport").mockRejectedValue(new ApiRequestError("Response lost", "OFFLINE", true, 0));
    const onVaultReplaced = vi.fn().mockRejectedValue(new Error("Reconnect required"));
    const user = userEvent.setup();
    render(<SettingsDialog
      open
      settings={demoBootstrap.settings}
      runtime={{ ...demoBootstrap.runtime, mode: "connected", apiReachable: true }}
      budget={demoBootstrap.budget}
      pinnedCount={0}
      onClose={vi.fn()}
      onSave={vi.fn().mockResolvedValue(undefined)}
      onReset={vi.fn()}
      onOpenMemory={vi.fn()}
      onProviderChanged={vi.fn().mockResolvedValue(undefined)}
      onVaultReplaced={onVaultReplaced}
    />);
    await user.click(screen.getByRole("button", { name: "Data" }));
    await user.upload(screen.getByLabelText<HTMLInputElement>("Choose vault import file"), new File(["vault"], "continuum.zip", { type: "application/zip" }));
    await user.click(await screen.findByRole("button", { name: "Replace with exact vault" }));

    await waitFor(() => expect(onVaultReplaced).toHaveBeenCalledWith("ambiguous"));
    expect(screen.queryByRole("button", { name: "Retry exact replacement" })).not.toBeInTheDocument();
    expect(screen.getByText(/Import committed or may have committed/i)).toBeVisible();
  });

  it.each([
    ["VERIFIED_IMPORT_CONSUMED", 410, false],
    ["VERIFIED_IMPORT_IN_USE", 409, true],
    ["VAULT_IMPORT_RECOVERY_REQUIRED", 503, true]
  ])("scrubs the prior vault when import commit returns %s", async (code, status, retryable) => {
    vi.spyOn(continuumApi, "verifyVaultImport").mockResolvedValue({
      valid: true,
      verificationToken: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      archiveChecksum: "d".repeat(64),
      size: 512,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      manifest: { counts: { events: 12 } }
    });
    vi.spyOn(continuumApi, "commitVerifiedVaultImport").mockRejectedValue(new ApiRequestError("The import committed or is owned by another request.", code, retryable, status));
    const onVaultReplaced = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<SettingsDialog
      open
      settings={demoBootstrap.settings}
      runtime={{ ...demoBootstrap.runtime, mode: "connected", apiReachable: true }}
      budget={demoBootstrap.budget}
      pinnedCount={0}
      onClose={vi.fn()}
      onSave={vi.fn().mockResolvedValue(undefined)}
      onReset={vi.fn()}
      onOpenMemory={vi.fn()}
      onProviderChanged={vi.fn().mockResolvedValue(undefined)}
      onVaultReplaced={onVaultReplaced}
    />);
    await user.click(screen.getByRole("button", { name: "Data" }));
    await user.upload(screen.getByLabelText<HTMLInputElement>("Choose vault import file"), new File(["vault"], "continuum.zip", { type: "application/zip" }));
    await user.click(await screen.findByRole("button", { name: "Replace with exact vault" }));

    await waitFor(() => expect(onVaultReplaced).toHaveBeenCalledWith("ambiguous"));
    expect(screen.queryByRole("button", { name: "Retry exact replacement" })).not.toBeInTheDocument();
    expect(screen.getByText(/prior vault view was scrubbed/i)).toBeVisible();
  });

  it("keeps the prior view but discards the consumed token when rollback recovery proves the database did not commit", async () => {
    vi.spyOn(continuumApi, "verifyVaultImport").mockResolvedValue({
      valid: true,
      verificationToken: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      archiveChecksum: "e".repeat(64),
      size: 512,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      manifest: { counts: { events: 12 } }
    });
    vi.spyOn(continuumApi, "commitVerifiedVaultImport").mockRejectedValue(new ApiRequestError(
      "Replacement rolled back; restart for cleanup.",
      "VAULT_IMPORT_ROLLBACK_RECOVERY_REQUIRED",
      true,
      503
    ));
    const onVaultReplaced = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<SettingsDialog
      open
      settings={demoBootstrap.settings}
      runtime={{ ...demoBootstrap.runtime, mode: "connected", apiReachable: true }}
      budget={demoBootstrap.budget}
      pinnedCount={0}
      onClose={vi.fn()}
      onSave={vi.fn().mockResolvedValue(undefined)}
      onReset={vi.fn()}
      onOpenMemory={vi.fn()}
      onProviderChanged={vi.fn().mockResolvedValue(undefined)}
      onVaultReplaced={onVaultReplaced}
    />);
    await user.click(screen.getByRole("button", { name: "Data" }));
    await user.upload(screen.getByLabelText<HTMLInputElement>("Choose vault import file"), new File(["vault"], "continuum.zip", { type: "application/zip" }));
    await user.click(await screen.findByRole("button", { name: "Replace with exact vault" }));

    expect(await screen.findByText(/prior vault was not replaced/i)).toBeVisible();
    expect(onVaultReplaced).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Retry exact replacement" })).not.toBeInTheDocument();
  });
});
