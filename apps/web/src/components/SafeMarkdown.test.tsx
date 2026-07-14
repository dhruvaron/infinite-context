import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SafeMarkdown } from "./SafeMarkdown";

describe("SafeMarkdown", () => {
  it("renders GFM while dropping raw HTML", () => {
    render(<SafeMarkdown>{"**Safe**\n\n<script>alert('unsafe')</script>\n\n| A | B |\n| - | - |\n| 1 | 2 |"}</SafeMarkdown>);
    expect(screen.getByText("Safe")).toHaveStyle({ fontWeight: "bold" });
    expect(document.querySelector("script")).not.toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  it("does not expose javascript links", () => {
    render(<SafeMarkdown>{"[unsafe](javascript:alert(1)) and [safe](https://example.com)"}</SafeMarkdown>);
    expect(screen.getByRole("link", { name: /safe/i })).toHaveAttribute("href", "https://example.com");
    expect(screen.queryByRole("link", { name: "unsafe" })).toBeNull();
  });

  it("routes only exact Continuum topic links without browser navigation", async () => {
    const onTopicLink = vi.fn();
    const user = userEvent.setup();
    render(<SafeMarkdown onTopicLink={onTopicLink}>{"[related](continuum://topic/project-memory) [encoded](continuum://topic/topic%2D123) [wrong host](continuum://source/project-memory) [path escape](continuum://topic/../secret) [other](file:///tmp/secret)"}</SafeMarkdown>);
    const related = screen.getByRole("button", { name: "related" });
    expect(related).not.toHaveAttribute("href");
    await user.click(related);
    expect(onTopicLink).toHaveBeenCalledWith("project-memory");
    await user.click(screen.getByRole("button", { name: "encoded" }));
    expect(onTopicLink).toHaveBeenLastCalledWith("topic-123");
    expect(screen.queryByRole("link", { name: "wrong host" })).toBeNull();
    expect(screen.queryByRole("link", { name: "path escape" })).toBeNull();
    expect(screen.queryByRole("link", { name: "other" })).toBeNull();
  });

  it("syntax-highlights common fenced languages without converting code into HTML", () => {
    const { container } = render(<SafeMarkdown>{"```typescript\nconst answer: number = 42; // retained\n```"}</SafeMarkdown>);
    const block = container.querySelector("code.language-typescript");
    expect(block).toHaveTextContent("const answer: number = 42; // retained");
    expect(block?.querySelector(".syntax-keyword")).toHaveTextContent("const");
    expect(block?.querySelector(".syntax-number")).toHaveTextContent("42");
    expect(block?.querySelector(".syntax-comment")).toHaveTextContent("// retained");
  });
});
