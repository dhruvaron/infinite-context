import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ConversationEvent } from "../lib/types";
import { ChatTimeline } from "./ChatTimeline";

function eventAt(index: number): ConversationEvent {
  const hex = (index + 1).toString(16).padStart(12, "0");
  return {
    id: `00000000-0000-4000-8000-${hex}`,
    sequence: index + 1,
    role: index % 2 === 0 ? "user" : "assistant",
    kind: "message",
    status: "complete",
    content: `Timeline message ${index}`,
    parentEventId: null,
    runId: null,
    active: true,
    createdAt: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
    completedAt: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
    attachments: []
  };
}

const commonProps = {
  offline: false,
  hasOlder: false,
  loadingOlder: false,
  onLoadOlder: vi.fn(),
  referencesByRunId: {},
  loadingTraceRunIds: new Set<string>(),
  revealedEventIds: new Set<string>(),
  onSource: vi.fn(),
  onInspectAnswer: vi.fn(),
  onShowInGraph: vi.fn(),
  onOpenRevisions: vi.fn(),
  onRegenerate: vi.fn(),
  onDelete: vi.fn(),
  onDeleteAttachment: vi.fn(),
  onRetry: vi.fn()
};

describe("ChatTimeline long-session windowing", () => {
  it("keeps the mounted timeline bounded and can move through loaded history", async () => {
    const events = Array.from({ length: 1_000 }, (_, index) => eventAt(index));
    const { container } = render(<ChatTimeline {...commonProps} events={events} highlightedEventId={null} />);

    expect(container.querySelectorAll("article.message")).toHaveLength(160);
    expect(screen.queryByText("Timeline message 0")).not.toBeInTheDocument();
    expect(screen.getByText("Timeline message 999")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /show earlier loaded messages/i }));
    expect(container.querySelectorAll("article.message")).toHaveLength(160);
    expect(screen.getByText("Timeline message 760")).toBeInTheDocument();
    expect(screen.queryByText("Timeline message 999")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /show newer loaded messages/i })).toBeVisible();
  });

  it("moves the bounded window to exact evidence selected from search", async () => {
    const events = Array.from({ length: 1_000 }, (_, index) => eventAt(index));
    const target = events[10]!;
    const { container, rerender } = render(<ChatTimeline {...commonProps} events={events} highlightedEventId={null} />);

    rerender(<ChatTimeline {...commonProps} events={events} highlightedEventId={target.id} />);
    await waitFor(() => expect(screen.getByText("Timeline message 10")).toBeInTheDocument());
    expect(container.querySelectorAll("article.message").length).toBeLessThanOrEqual(160);
  });

  it("previews a persisted image and degrades to an accessible file card on error", () => {
    const event = eventAt(0);
    event.attachments = [{
      id: "11111111-1111-4111-8111-111111111111",
      sourceId: "22222222-2222-4222-8222-222222222222",
      filename: "architecture diagram.png",
      mediaType: "image/png",
      size: 4_096,
      status: "ready",
      createdAt: event.createdAt
    }];
    render(<ChatTimeline {...commonProps} events={[event]} highlightedEventId={null} />);

    const preview = screen.getByRole("img", { name: "architecture diagram.png" });
    expect(preview).toHaveAttribute("src", "/api/v1/attachments/11111111-1111-4111-8111-111111111111/content");
    expect(screen.getByRole("button", { name: "Delete architecture diagram.png permanently" })).toBeVisible();
    fireEvent.error(preview);
    expect(screen.getByText(/preview unavailable/i)).toBeVisible();
  });

  it("does not request persisted image bytes from a retained timeline while offline", () => {
    const event = eventAt(0);
    event.attachments = [{
      id: "31111111-1111-4111-8111-111111111111",
      sourceId: "32222222-2222-4222-8222-222222222222",
      filename: "retained offline image.png",
      mediaType: "image/png",
      size: 4_096,
      status: "ready",
      createdAt: event.createdAt
    }];

    render(<ChatTimeline {...commonProps} offline events={[event]} highlightedEventId={null} />);

    expect(screen.queryByRole("img", { name: event.attachments[0]!.filename })).not.toBeInTheDocument();
    expect(screen.getByText(event.attachments[0]!.filename)).toBeVisible();
  });

  it("keeps an interrupted answer visible with an explicit retry and graph action", () => {
    const retry = vi.fn();
    const showInGraph = vi.fn();
    const event = { ...eventAt(1), status: "incomplete" as const, content: "Exact partial response", active: true };
    render(<ChatTimeline {...commonProps} events={[event]} highlightedEventId={null} onRetry={retry} onShowInGraph={showInGraph} />);

    expect(screen.getByText("Exact partial response")).toBeVisible();
    expect(screen.getByText(/interrupted and retained verbatim/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry response" }));
    expect(retry).toHaveBeenCalledWith(event.id);
    fireEvent.click(screen.getByRole("button", { name: /show this answer in the knowledge graph/i }));
    expect(showInGraph).toHaveBeenCalledWith(event);
  });

  it("announces only response status and stops following streaming deltas after the reader scrolls up", async () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    const event = { ...eventAt(1), status: "streaming" as const, content: "First streamed bytes", completedAt: null };
    const { container, rerender } = render(<ChatTimeline {...commonProps} events={[event]} highlightedEventId={null} />);
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(container.querySelector(".conversation")).not.toHaveAttribute("aria-live");
    expect(screen.getByRole("status")).toHaveTextContent("Assistant response is streaming.");
    const callsAtBottom = scroll.mock.calls.length;

    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 500 });
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 5_000 });
    window.dispatchEvent(new Event("scroll"));
    rerender(<ChatTimeline {...commonProps} events={[{ ...event, content: "First streamed bytes plus a delta" }]} highlightedEventId={null} />);
    await new Promise((resolve) => window.setTimeout(resolve, 80));
    expect(scroll).toHaveBeenCalledTimes(callsAtBottom);
    scroll.mockRestore();
  });
});
