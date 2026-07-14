import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { demoBootstrap, DEMO_IDS } from "../lib/demo-data";
import { KnowledgeGraph, layoutFocusedGraph } from "./KnowledgeGraph";

describe("focused graph", () => {
  it("places the focus at the canvas center and connected nodes on a bounded ring", () => {
    const nodes = layoutFocusedGraph(demoBootstrap.graph, 720, 620);
    const focus = nodes.find((node) => node.id === DEMO_IDS.projectTopic)!;
    expect(focus.x).toBe(360);
    expect(focus.y).toBe(298);
    const other = nodes.find((node) => node.id === DEMO_IDS.memoryTopic)!;
    expect(Math.hypot(other.x - focus.x, other.y - focus.y)).toBeCloseTo(175, 0);
  });

  it("offers keyboard-accessible node details and historical filtering", async () => {
    const user = userEvent.setup();
    const request = vi.fn();
    const evidence = vi.fn();
    const { container } = render(<KnowledgeGraph graph={demoBootstrap.graph} topics={demoBootstrap.topics} onClose={vi.fn()} onRequestGraph={request} onNavigate={vi.fn()} onEvidence={evidence} onEditTopic={vi.fn()} />);
    expect(container.querySelector("svg.graph-canvas")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Entity")).toBeVisible();
    await user.click(screen.getByText(/accessible graph list/i, { selector: "summary" }));
    expect(screen.getByRole("region", { name: /graph relationships/i })).toBeVisible();
    expect(screen.getByText(/relationships and evidence/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /continuum project, entity/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /memory architecture, topic/i }));
    expect(screen.getByText("Hybrid raw history, atomic evidence, topic wiki, graph, and retrieval.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /^history$/i }));
    expect(request).toHaveBeenCalledWith(DEMO_IDS.projectTopic, 1, true);
    await user.click(screen.getByRole("button", { name: /continuum project, entity/i }));
    await user.click(screen.getByRole("button", { name: /inspect exact record/i }));
    expect(evidence).toHaveBeenCalledWith(DEMO_IDS.entity);
    await user.click(screen.getAllByRole("button", { name: /evidence 1/i })[0]!);
    expect(evidence).toHaveBeenCalledWith(demoBootstrap.graph.edges.find((edge) => edge.source === DEMO_IDS.entity || edge.target === DEMO_IDS.entity)?.evidenceIds[0]);
  });

  it("shows the same depth and history controls used by a Show-in-graph request", async () => {
    const user = userEvent.setup();
    const request = vi.fn();
    render(<KnowledgeGraph graph={demoBootstrap.graph} topics={demoBootstrap.topics} initialHops={2} initialIncludeHistory onClose={vi.fn()} onRequestGraph={request} onNavigate={vi.fn()} onEvidence={vi.fn()} onEditTopic={vi.fn()} />);
    expect(screen.getByRole("radio", { name: "2 hops" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "History" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "History" }));
    expect(request).toHaveBeenCalledWith(DEMO_IDS.projectTopic, 2, false);
  });
});
