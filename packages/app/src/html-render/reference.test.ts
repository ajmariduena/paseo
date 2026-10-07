import { expect, test } from "vitest";
import type { ToolCallItem } from "@/types/stream";
import { htmlRenderFromToolCall, isHtmlRenderToolName } from "./reference";

const render = {
  htmlRender: { renderId: "550e8400-e29b-41d4-a716-446655440000", title: "Chart", height: 400 },
  message: "Shown",
};

function call(
  name: string,
  output: unknown,
  status: "completed" | "failed" = "completed",
): ToolCallItem {
  return {
    kind: "tool_call",
    id: "call",
    timestamp: new Date(),
    payload: {
      source: "agent",
      data: {
        provider: "codex",
        callId: "call",
        name,
        status,
        error: status === "failed" ? "error" : null,
        detail: { type: "unknown", input: {}, output },
      },
    },
  };
}

test("extracts a render from Claude, Codex, and OpenCode result shapes", () => {
  expect(htmlRenderFromToolCall(call("mcp__paseo__html_render", { output: render }))).toEqual(
    render.htmlRender,
  );
  expect(
    htmlRenderFromToolCall(
      call("paseo.html_render", {
        structuredContent: render,
        content: [{ type: "text", text: JSON.stringify(render) }],
      }),
    ),
  ).toEqual(render.htmlRender);
  expect(htmlRenderFromToolCall(call("html_render", JSON.stringify(render)))).toEqual(
    render.htmlRender,
  );
  expect(isHtmlRenderToolName("mcp__paseo_123__html_render")).toBe(true);
});

test("ignores failed and unrelated calls, and oversized JSON", () => {
  expect(htmlRenderFromToolCall(call("html_render", render, "failed"))).toBeNull();
  expect(htmlRenderFromToolCall(call("other.html_render", render))).toBeNull();
  expect(htmlRenderFromToolCall(call("html_render", "{" + " ".repeat(20_000) + "}"))).toBeNull();
});
