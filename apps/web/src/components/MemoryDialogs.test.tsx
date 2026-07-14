import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { demoBootstrap } from "../lib/demo-data";
import { EntityMergeDialog, EvidenceDialog, ResponseRevisionsDialog, TopicDetailDialog } from "./MemoryDialogs";

describe("topic-page navigation", () => {
  it("routes safe related-page links back into the topic inspector", async () => {
    const user = userEvent.setup();
    const openTopic = vi.fn();
    const topic = { ...demoBootstrap.topics[0]!, markdown: "# Project\n\n## Related pages\n\n[Memory architecture](continuum://topic/memory-architecture)" };
    render(<TopicDetailDialog topic={topic} open onClose={vi.fn()} onEdit={vi.fn()} onOpenEvidence={vi.fn()} onOpenTopic={openTopic} onShowInGraph={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Memory architecture" }));
    expect(openTopic).toHaveBeenCalledWith("memory-architecture");
  });

  it("opens the exact topic neighborhood in the graph", async () => {
    const user = userEvent.setup();
    const showInGraph = vi.fn();
    const topic = { ...demoBootstrap.topics[0]!, markdown: "# Project" };
    render(<TopicDetailDialog topic={topic} open onClose={vi.fn()} onEdit={vi.fn()} onOpenEvidence={vi.fn()} onOpenTopic={vi.fn()} onShowInGraph={showInGraph} />);
    await user.click(screen.getByRole("button", { name: /show in graph/i }));
    expect(showInGraph).toHaveBeenCalledWith(topic.id);
  });

  it("shows sticky confirmation policy independently from the active revision author", () => {
    const topic = { ...demoBootstrap.topics[0]!, userAuthored: false, updatePolicy: "confirm" as const, markdown: "# Project" };
    render(<TopicDetailDialog topic={topic} open onClose={vi.fn()} onEdit={vi.fn()} onOpenEvidence={vi.fn()} onOpenTopic={vi.fn()} onShowInGraph={vi.fn()} />);
    expect(screen.getByText("Confirmation-only updates")).toBeVisible();
    expect(screen.queryByText("User-authored revision")).not.toBeInTheDocument();
  });
});

describe("persisted response revisions", () => {
  it("previews historical answers and explicitly activates the selected revision", async () => {
    const user = userEvent.setup();
    const active = demoBootstrap.events[1]!;
    const historical = { ...active, id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", content: "Earlier persisted answer", active: false };
    const activate = vi.fn().mockResolvedValue(undefined);
    render(<ResponseRevisionsDialog open revisions={[{ event: historical, revisionNumber: 1, active: false, quality: "fast" }, { event: active, revisionNumber: 2, active: true, quality: "deep" }]} loading={false} error={null} onClose={vi.fn()} onActivate={activate} />);
    expect(screen.getByRole("dialog", { name: /persisted response revisions/i })).toBeVisible();
    await user.click(screen.getByRole("button", { name: /revision 1/i }));
    expect(screen.getByText("Earlier persisted answer")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /make active/i }));
    expect(activate).toHaveBeenCalledWith(historical.id);
  });
});

describe("inspectable and correctable durable memory", () => {
  it("creates a user correction instead of overwriting the retained claim", async () => {
    const user = userEvent.setup();
    const correct = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn();
    const claim = demoBootstrap.claims[0]!;
    render(<EvidenceDialog open evidence={{ type: "claim", id: claim.id, record: { claim, evidence: claim.sourceIds.map((sourceId) => ({ sourceId })), relations: [] } }} loading={false} error={null} onClose={vi.fn()} onOpenEvidence={vi.fn()} onCorrectClaim={correct} onDeleteClaim={remove} onReverseMerge={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /correct this claim/i }));
    await user.clear(screen.getByRole("textbox", { name: /correct value/i }));
    await user.type(screen.getByRole("textbox", { name: /correct value/i }), "The user-confirmed current value");
    await user.type(screen.getByRole("textbox", { name: /^reason/i }), "Verified against source");
    await user.click(screen.getByRole("button", { name: /save as new current claim/i }));
    expect(correct).toHaveBeenCalledWith(claim.id, "The user-confirmed current value", "Verified against source");
    await user.click(await screen.findByRole("button", { name: /delete claim permanently/i }));
    expect(remove).toHaveBeenCalledWith(claim.id, claim.value.slice(0, 80));
  });

  it("requires impact review before a reversible entity merge", async () => {
    const user = userEvent.setup();
    const candidate = { sourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", targetId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", sourceName: "Acme Inc", targetName: "ACME", type: "organization", score: .9, reason: "similar normalized names" };
    const envelope = { impact: { sourceId: candidate.sourceId, targetId: candidate.targetId, sourceName: candidate.sourceName, targetName: candidate.targetName, type: candidate.type, aliasesMoved: 2, edgesRewritten: 3, reversible: true }, confirmationToken: "c".repeat(64) };
    const review = vi.fn().mockResolvedValue(envelope);
    const merge = vi.fn().mockResolvedValue({ mergeId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", sourceId: candidate.sourceId, targetId: candidate.targetId });
    render(<EntityMergeDialog open candidates={[candidate]} loading={false} error={null} onClose={vi.fn()} onReview={review} onMerge={merge} onReverse={vi.fn()} />);
    await user.click(screen.getByRole("option", { name: /acme inc.*acme/i }));
    await user.click(screen.getByRole("button", { name: /review exact impact/i }));
    expect(await screen.findByText("2")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /merge acme inc into acme/i }));
    expect(review).toHaveBeenCalledWith(candidate.sourceId, candidate.targetId);
    expect(merge).toHaveBeenCalledWith(envelope);
    expect(await screen.findByRole("heading", { name: /entities merged/i })).toBeVisible();
  });
});
