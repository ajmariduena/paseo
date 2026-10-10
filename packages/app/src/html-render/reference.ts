import type { ToolCallItem } from "@/types/stream";
import { validRenderHeights, type RenderHeights } from "@getpaseo/protocol/html-render";

export interface HtmlRenderReference {
  renderId: string;
  title: string;
  height: number;
  heights?: RenderHeights;
}

export function isHtmlRenderToolName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    normalized === "html_render" ||
    normalized === "paseo_html_render" ||
    /^mcp__paseo(?:_[a-z0-9_-]+)?__html_render$/.test(normalized) ||
    /^paseo(?:_[a-z0-9_-]+)?\.html_render$/.test(normalized)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDirectReference(value: Record<string, unknown>): HtmlRenderReference | null {
  const candidate = value.htmlRender;
  if (!isRecord(candidate)) return null;
  const { renderId, title, height, heights } = candidate;
  if (
    typeof renderId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(renderId)
  )
    return null;
  if (typeof title !== "string" || title.length === 0 || title.length > 200) return null;
  if (typeof height !== "number" || !Number.isInteger(height) || height < 80 || height > 2000)
    return null;
  return { renderId, title, height, ...(validRenderHeights(heights) ? { heights } : {}) };
}

function readReference(value: unknown, depth = 0): HtmlRenderReference | null {
  if (depth > 4) return null;
  if (typeof value === "string") {
    if (value.length > 16_384 || !value.trim().startsWith("{")) return null;
    try {
      return readReference(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (!isRecord(value)) return null;
  const direct = parseDirectReference(value);
  if (direct) return direct;
  for (const key of ["structuredContent", "output", "result", "content"]) {
    const next = value[key];
    if (Array.isArray(next)) {
      for (const block of next.slice(0, 8)) {
        const reference = readReference(block, depth + 1);
        if (reference) return reference;
      }
    } else {
      const reference = readReference(next, depth + 1);
      if (reference) return reference;
    }
  }
  if (value.type === "text") return readReference(value.text, depth + 1);
  return null;
}

export function htmlRenderFromToolCall(item: ToolCallItem): HtmlRenderReference | null {
  if (item.payload.source === "agent") {
    const call = item.payload.data;
    if (!isHtmlRenderToolName(call.name) || call.status !== "completed" || call.error !== null)
      return null;
    return call.detail.type === "unknown" ? readReference(call.detail.output) : null;
  }
  const call = item.payload.data;
  if (!isHtmlRenderToolName(call.toolName) || call.status !== "completed" || call.error)
    return null;
  return readReference(call.result);
}
