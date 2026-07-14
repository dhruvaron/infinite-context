import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { demoBootstrap } from "../lib/demo-data";
import type { TopicProposal } from "../lib/types";
import { MemoryInspector } from "./MemoryInspector";

function renderInspector(options: { tab?: "memory" | "debug"; proposals?: TopicProposal[]; onResolveProposal?: (proposal: TopicProposal, action: "accept" | "reject") => Promise<void> } = {}) {
  render(<MemoryInspector
    open
    requestedTab={options.tab ?? "debug"}
    answerRunId={demoBootstrap.debug.trace!.runId}
    traceLoading={false}
    memories={demoBootstrap.activeMemories}
    topics={demoBootstrap.topics}
    attention={[]}
    proposals={options.proposals ?? []}
    debug={demoBootstrap.debug}
    runtime={demoBootstrap.runtime}
    budget={demoBootstrap.budget}
    onClose={vi.fn()}
    onNavigate={vi.fn()}
    onPin={vi.fn()}
    onEditTopic={vi.fn()}
    onDeleteMemory={vi.fn()}
    onResolveProposal={options.onResolveProposal ?? vi.fn().mockResolvedValue(undefined)}
    onReviewEntityMerges={vi.fn()}
    onRetryJob={vi.fn()}
    onLint={vi.fn()}
  />);
}

describe("answer-specific debug inspection", () => {
  it("renders the exact packet, cache use, tool records, and all reproducibility versions", async () => {
    const user = userEvent.setup();
    renderInspector();
    expect(screen.getByText("sha256:demo-context-packet")).toBeInTheDocument();
    expect(screen.getByText(/3,200 cached input tokens/i)).toBeVisible();
    await user.click(screen.getByText(/ordered source IDs/i));
    expect(screen.getByText(demoBootstrap.debug.contextPacket!.orderedSourceIds[0]!)).toBeVisible();
    await user.click(screen.getByText("Exact rendered packet"));
    expect(screen.getByText(/Summaries never replace source evidence/i)).toBeVisible();
    await user.click(screen.getByText("Response"));
    expect(screen.getByText("3,200 cached")).toBeVisible();
    await user.click(screen.getByText("memory.search"));
    expect(screen.getAllByText(/older context/i).some((element) => element.tagName === "PRE")).toBe(true);
    expect(screen.getByText(/local-database/i)).toBeVisible();
    for (const label of ["Prompt", "Schema", "Retrieval", "Reranker", "Context builder", "Response model", "Embedding model"]) expect(screen.getAllByText(label, { exact: true }).length).toBeGreaterThan(0);
  });
});

describe("topic proposal review", () => {
  it("surfaces proposed page changes in Attention and resolves only by explicit action", async () => {
    const proposal: TopicProposal = {
      id: "proposal-1",
      kind: "topic_split",
      topicId: demoBootstrap.topics[0]!.id,
      title: "Split the Continuum project page",
      description: "The compiled page exceeds the active-page size limit.",
      reason: "A trusted user-authored page cannot be replaced automatically.",
      proposedAt: new Date().toISOString(),
      proposedRevision: { summary: "Bounded parent index" },
      affectedTopicIds: [demoBootstrap.topics[0]!.id, "child-topic"]
    };
    const resolve = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderInspector({ tab: "memory", proposals: [proposal], onResolveProposal: resolve });
    expect(screen.getByText(proposal.title)).toBeVisible();
    expect(screen.getByText(/trusted user-authored page/i)).toBeVisible();
    await user.click(screen.getByText("Inspect proposed revision"));
    expect(screen.getByText(/bounded parent index/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Accept proposal" }));
    expect(resolve).toHaveBeenCalledWith(proposal, "accept");
  });

  it("explains normalized bounded shard patches as confirmation-only atomic changes", async () => {
    const proposal: TopicProposal = {
      id: "proposal-shard-1",
      kind: "topic_patch",
      topicId: demoBootstrap.topics[0]!.id,
      title: "Update the Continuum project page",
      description: "Atomically update 2 evidence-linked ranges with 3 proposed pages.",
      reason: "A trusted page is in confirmation-only mode. Its active revision and evidence routes remain unchanged unless you accept this exact patch.",
      proposedAt: new Date().toISOString(),
      proposedRevision: { patches: [{ section: "current_state" }, { section: "evidence" }] },
      affectedTopicIds: [demoBootstrap.topics[0]!.id, "current-shard", "evidence-shard"]
    };
    const resolve = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderInspector({ tab: "memory", proposals: [proposal], onResolveProposal: resolve });
    expect(screen.getByText("Bounded topic patch")).toBeVisible();
    expect(screen.getByText(/active revision and evidence routes remain unchanged/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Accept proposal" }));
    expect(resolve).toHaveBeenCalledWith(proposal, "accept");
  });

  it("does not offer an unsafe accept action for a pre-v2 proposal", async () => {
    const proposal: TopicProposal = {
      id: "proposal-legacy-1",
      kind: "topic_split",
      topicId: demoBootstrap.topics[0]!.id,
      title: "Older topic restructure",
      description: "This proposal predates exact acceptance guards.",
      reason: "Review is still required.",
      proposedAt: new Date().toISOString(),
      proposedRevision: null,
      affectedTopicIds: [demoBootstrap.topics[0]!.id],
      canAccept: false,
      acceptanceBlockedReason: "Reject it so Continuum can compile a safe replacement."
    };
    const resolve = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderInspector({ tab: "memory", proposals: [proposal], onResolveProposal: resolve });
    expect(screen.queryByRole("button", { name: "Accept proposal" })).not.toBeInTheDocument();
    expect(screen.getByText(/compile a safe replacement/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(resolve).toHaveBeenCalledWith(proposal, "reject");
  });
});
