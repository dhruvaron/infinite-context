import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { continuumApi } from "../lib/api-client";
import type { SearchResult } from "../lib/types";
import { SearchDialog } from "./SearchDialog";

describe("unified search", () => {
  it("filters and opens entities and tool evidence as distinct exact records", async () => {
    const user = userEvent.setup();
    const entity: SearchResult = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", type: "entity", title: "Acme Incorporated",
      snippet: "Canonical organization identity", score: 0.91, timestamp: "2026-01-01T00:00:00.000Z", sourceEventId: null, tags: ["organization"]
    };
    const tool: SearchResult = {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", type: "tool_result", title: "workspace_search",
      snippet: "Retained tool evidence", score: 0.84, timestamp: "2026-01-02T00:00:00.000Z", sourceEventId: null, tags: ["tool"]
    };
    const search = vi.spyOn(continuumApi, "search").mockResolvedValue({ results: [entity, tool], nextCursor: null, tookMs: 3 });
    const select = vi.fn();
    render(<SearchDialog open onClose={vi.fn()} onSelect={select} />);

    expect(screen.getByRole("button", { name: "Entities" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Tool evidence" })).toBeVisible();
    await user.type(screen.getByRole("textbox", { name: "Search all memory" }), "identity");
    await user.click(screen.getByRole("button", { name: "Entities" }));
    await waitFor(() => expect(search).toHaveBeenLastCalledWith("identity", expect.objectContaining({ types: ["entity"] }), undefined, false));
    await user.click(await screen.findByRole("option", { name: /acme incorporated.*entity/i }));
    expect(select).toHaveBeenCalledWith(entity);

    await user.click(screen.getByRole("button", { name: "Entities" }));
    await user.click(screen.getByRole("button", { name: "Tool evidence" }));
    await waitFor(() => expect(search).toHaveBeenLastCalledWith("identity", expect.objectContaining({ types: ["tool_result"] }), undefined, false));
    await user.click(screen.getByRole("option", { name: /workspace_search.*tool_result/i }));
    expect(select).toHaveBeenCalledWith(tool);
  });

  it("pages through the complete local result set without duplicating records", async () => {
    const user = userEvent.setup();
    const first: SearchResult = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", type: "event", title: "Recent decision",
      snippet: "First page", score: 0.9, timestamp: "2026-01-02T00:00:00.000Z", sourceEventId: null, tags: []
    };
    const older: SearchResult = {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", type: "event", title: "Older decision",
      snippet: "Second page", score: 0.8, timestamp: "2025-01-02T00:00:00.000Z", sourceEventId: null, tags: []
    };
    const search = vi.spyOn(continuumApi, "search")
      .mockResolvedValueOnce({ results: [first], nextCursor: "50", tookMs: 2 })
      .mockResolvedValueOnce({ results: [first, older], nextCursor: null, tookMs: 3 });
    render(<SearchDialog open onClose={vi.fn()} onSelect={vi.fn()} />);
    await user.type(screen.getByRole("textbox", { name: "Search all memory" }), "decision");
    await user.click(await screen.findByRole("button", { name: "Load older matches" }));
    await waitFor(() => expect(search).toHaveBeenLastCalledWith("decision", expect.any(Object), "50", false));
    expect(await screen.findByRole("option", { name: /older decision.*event/i })).toBeVisible();
    expect(screen.getAllByRole("option", { name: /recent decision.*event/i })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Load older matches" })).not.toBeInTheDocument();
  });
});

afterEach(() => vi.restoreAllMocks());
