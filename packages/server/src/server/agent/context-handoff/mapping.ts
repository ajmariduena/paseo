import type { AgentTimelineItem, ToolCallTimelineItem } from "../agent-sdk-types.js";
import { HandoffInputError } from "./budget.js";
import type {
  ContextArtifact,
  HandoffItem,
  HandoffProvenance,
  HandoffSourceRow,
  RowIdentity,
} from "./types.js";

interface MappingInput {
  rows: readonly HandoffSourceRow[];
  excludeNativeRows: ReadonlySet<string>;
  artifacts: readonly ContextArtifact[];
}

export function rowIdentityKey(identity: RowIdentity): string {
  const validIndex = Number.isSafeInteger(identity.rowIndex) && identity.rowIndex >= 0;
  if (!identity.segmentId || !validIndex) throw new HandoffInputError("row identity");
  return JSON.stringify([identity.segmentId, identity.rowIndex]);
}

function toolText(item: ToolCallTimelineItem): string {
  const detail = item.detail;
  switch (detail.type) {
    case "shell":
      return `Command: ${detail.command}\nExit code: ${detail.exitCode ?? "unknown"}\n${detail.output ?? ""}`;
    case "edit":
    case "write":
      return `File change: ${detail.filePath}`;
    case "plan":
      return detail.text;
    case "sub_agent":
      // The log/actions mirror child-pane activity, not the parent's delegated result.
      return `Delegated task: ${detail.description ?? ""}\nChild: ${detail.childSessionId ?? item.callId}\nAgent type: ${detail.subAgentType ?? "unknown"}`;
    default:
      return JSON.stringify({ tool: item.name, callId: item.callId, detail, error: item.error });
  }
}

function itemText(item: AgentTimelineItem): string | null {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
      return item.text;
    case "error":
      return item.message;
    case "tool_call": {
      const text = toolText(item);
      if (item.status === "failed") return `${text}\nError: ${JSON.stringify(item.error)}`;
      return text;
    }
    case "reasoning":
    case "todo":
    case "notification":
    case "compaction":
    case "plugin":
      return null;
  }
}

function itemOrigin(item: AgentTimelineItem): string {
  if (item.type === "user_message") {
    return item.origin?.kind === "agent" ? `agent:${item.origin.agentId}` : "user";
  }
  if (item.type === "tool_call") return `tool:${item.name}; call:${item.callId}`;
  return "assistant";
}

function itemStatus(source: HandoffSourceRow): HandoffItem["status"] {
  if (source.interrupted) return "interrupted";
  if (source.row.item.type === "tool_call") return source.row.item.status;
  if (source.row.item.type === "error") return "failed";
  return "completed";
}

export function mapHandoffItems(input: MappingInput) {
  const items: HandoffItem[] = [];
  const omittedItems: HandoffProvenance[] = [];
  const artifactsSeen = new Set<string>();
  for (const artifact of input.artifacts) {
    if (artifactsSeen.has(artifact.id)) continue;
    artifactsSeen.add(artifact.id);
    items.push({
      role: "assistant",
      kind: "context_artifact",
      text: artifact.text,
      origin: artifact.origin,
      status: "completed",
      provenance: { type: "artifact", id: artifact.id, origin: artifact.origin },
    });
  }
  const seen = new Set(input.excludeNativeRows);
  for (const source of input.rows) {
    if (source.scope === "child") continue;
    const key = rowIdentityKey(source.identity);
    if (seen.has(key)) continue;
    seen.add(key);
    const item = source.row.item;
    const text = itemText(item);
    if (text === null) continue;
    const provenance: HandoffProvenance = { type: "row", identity: { ...source.identity } };
    const oversizedTool = item.type === "tool_call" && Buffer.byteLength(text) > 64_000;
    if (oversizedTool) {
      omittedItems.push(provenance);
      continue;
    }
    const role = item.type === "user_message" ? "user" : "assistant";
    const origin = itemOrigin(item);
    const status = itemStatus(source);
    items.push({ role, kind: item.type, text, provenance, origin, status });
  }
  return { items, omittedItems };
}
