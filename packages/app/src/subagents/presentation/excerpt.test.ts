import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { selectSubagentExcerpt, toPlainExcerpt } from "./excerpt";

function assistant(id: string, text: string): StreamItem {
  return { kind: "assistant_message", id, text, timestamp: new Date(0) };
}

function readCall(id: string, filePath: string): StreamItem {
  return {
    kind: "tool_call",
    id,
    timestamp: new Date(0),
    payload: {
      source: "agent",
      data: {
        provider: "claude",
        callId: id,
        name: "Read",
        status: "running",
        error: null,
        detail: { type: "read", filePath },
      },
    },
  };
}

describe("toPlainExcerpt", () => {
  it("drops Markdown syntax and keeps the words", () => {
    expect(
      toPlainExcerpt(
        "## Result\n\n**Split** by default; base = `merge-base`.\n- see [the pane](https://x.y)\n> quoted",
      ),
    ).toBe("Result Split by default; base = merge-base. see the pane quoted");
  });

  it("caps long text", () => {
    const excerpt = toPlainExcerpt("word ".repeat(200));
    expect(excerpt?.length).toBe(280);
    expect(excerpt?.endsWith("…")).toBe(true);
  });

  it("has nothing to show for whitespace", () => {
    expect(toPlainExcerpt("  \n ")).toBeNull();
  });
});

describe("selectSubagentExcerpt", () => {
  it("shows a settled child's last answer", () => {
    expect(
      selectSubagentExcerpt({
        items: [assistant("a", "First"), readCall("r", "/repo/a.ts"), assistant("b", "Final")],
        isLive: false,
      }),
    ).toBe("Final");
  });

  it("shows what a live child is doing right now", () => {
    expect(
      selectSubagentExcerpt({
        items: [assistant("a", "Looking"), readCall("r", "/repo/git-diff-pane.tsx")],
        isLive: true,
      }),
    ).toBe("Read /repo/git-diff-pane.tsx");
  });

  it("skips tool work once the child has settled", () => {
    expect(
      selectSubagentExcerpt({ items: [readCall("r", "/repo/a.ts")], isLive: false }),
    ).toBeNull();
  });
});
