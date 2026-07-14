import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Composer } from "./Composer";

const base = {
  draft: "",
  attachments: [],
  progress: { runId: null, stage: "idle" as const, label: "" },
  memoryPaused: false,
  webSearchEnabled: true,
  retryAvailable: false,
  onDraft: vi.fn(),
  onFiles: vi.fn(),
  onRemoveAttachment: vi.fn(),
  onSubmit: vi.fn(),
  onStop: vi.fn(),
  onResumeResponse: vi.fn(),
  onRetryResponse: vi.fn(),
  onToggleMemory: vi.fn(),
  onToggleWeb: vi.fn()
};

describe("Composer", () => {
  it("submits a non-empty draft and exposes the privacy boundary", async () => {
    const user = userEvent.setup(); const submit = vi.fn();
    render(<Composer {...base} draft="remember this" onSubmit={submit} />);
    await user.click(screen.getByRole("button", { name: "Send message" }));
    expect(submit).toHaveBeenCalledOnce();
    expect(screen.getByText(/only selected context/i)).toBeVisible();
  });

  it("changes the primary action to stop during streaming", async () => {
    const user = userEvent.setup(); const stop = vi.fn();
    render(<Composer {...base} draft="" progress={{ runId: "run", stage: "responding", label: "Writing…" }} onStop={stop} />);
    await user.click(screen.getByRole("button", { name: "Stop response" }));
    expect(stop).toHaveBeenCalledOnce();
    expect(screen.getByRole("status")).toHaveTextContent("Writing…");
  });

  it("blocks sending and exposes resume plus stop when the stream connection is lost", async () => {
    const user = userEvent.setup(); const resume = vi.fn(); const stop = vi.fn(); const submit = vi.fn();
    render(<Composer {...base} draft="next message" progress={{ runId: "run", stage: "connection_lost", label: "Connection lost" }} onResumeResponse={resume} onStop={stop} onSubmit={submit} />);
    expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Resume response" }));
    await user.click(screen.getByRole("button", { name: "Stop response" }));
    expect(resume).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
    expect(submit).not.toHaveBeenCalled();
  });

  it("keeps an unavailable-session draft editable without allowing a send", async () => {
    const user = userEvent.setup(); const draft = vi.fn(); const submit = vi.fn();
    render(<Composer {...base} draft="kept locally" disabled onDraft={draft} onSubmit={submit} />);
    const textbox = screen.getByRole("textbox", { name: "Message Continuum" });
    expect(textbox).toBeEnabled();
    await user.type(textbox, " plus more");
    expect(draft).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/drafts stay in this browser/i);
    expect(submit).not.toHaveBeenCalled();
  });
});
