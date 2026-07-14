import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { demoBootstrap } from "../lib/demo-data";
import { SettingsDialog } from "./SettingsDialog";

describe("vector degradation diagnostics", () => {
  it("shows the bounded fallback limit in user-visible developer diagnostics", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog
      open
      settings={demoBootstrap.settings}
      runtime={{
        ...demoBootstrap.runtime,
        mode: "connected",
        apiReachable: true,
        providerReachable: true,
        vectorSearch: "fallback",
        vectorStrategy: "bounded-json-cosine",
        vectorLoadStatus: "degraded",
        vectorFallbackLimit: 5_000
      }}
      budget={demoBootstrap.budget}
      pinnedCount={0}
      onClose={vi.fn()}
      onSave={vi.fn(async () => undefined)}
      onReset={vi.fn()}
      onOpenMemory={vi.fn()}
      onProviderChanged={vi.fn(async () => undefined)}
      onVaultReplaced={vi.fn(async () => undefined)}
    />);

    await user.click(screen.getByRole("button", { name: "Developer" }));
    expect(screen.getByText("fallback · 5,000 max")).toBeVisible();
    expect(screen.getByText(/Degraded mode searches only the newest 5,000 vectors/)).toBeVisible();
    expect(screen.getByText(/Text and graph search remain available/)).toBeVisible();
  });

  it("distinguishes committed spend, active reservations, allocation, and available credit", async () => {
    const user = userEvent.setup();
    render(<SettingsDialog
      open
      settings={demoBootstrap.settings}
      runtime={demoBootstrap.runtime}
      budget={demoBootstrap.budget}
      pinnedCount={0}
      onClose={vi.fn()}
      onSave={vi.fn(async () => undefined)}
      onReset={vi.fn()}
      onOpenMemory={vi.fn()}
      onProviderChanged={vi.fn(async () => undefined)}
      onVaultReplaced={vi.fn(async () => undefined)}
    />);

    await user.click(screen.getByRole("button", { name: "Models" }));
    expect(screen.getByText("$8.26 allocated", { exact: false })).toBeVisible();
    expect(screen.getByText(/\$7\.42 spent · \$0\.84 reserved across 2 active calls · \$91\.74 available/)).toBeVisible();
  });
});
