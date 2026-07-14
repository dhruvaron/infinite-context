import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Modal } from "./Primitives";

describe("accessible modal primitive", () => {
  it("portals the active dialog, isolates the application, traps focus, and restores the trigger", async () => {
    const close = vi.fn();
    const { container, unmount } = render(<><button type="button">Open settings</button><Modal open title="Settings" description="Account controls" onClose={close}><button type="button">First action</button><button type="button">Last action</button></Modal></>);
    const trigger = screen.getByRole("button", { name: "Open settings" });
    trigger.focus();
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await waitFor(() => expect(dialog).toHaveFocus());
    expect(container.parentElement).toBe(document.body);
    expect((container as HTMLElement).inert).toBe(true);
    expect(container).toHaveAttribute("aria-hidden", "true");

    const last = screen.getByRole("button", { name: "Last action" });
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).toHaveBeenCalledTimes(1);

    unmount();
    expect((container as HTMLElement).inert).toBe(false);
    expect(container).not.toHaveAttribute("aria-hidden");
  });

  it("does not expose fake close, backdrop, or Escape affordances for required setup", async () => {
    const close = vi.fn();
    render(<Modal open title="Welcome" dismissible={false} onClose={close}><button type="button">Continue</button></Modal>);
    await screen.findByRole("dialog", { name: "Welcome" });
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.mouseDown(document.querySelector(".modal-backdrop")!);
    expect(close).not.toHaveBeenCalled();
  });
});
