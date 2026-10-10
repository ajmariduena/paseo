import type { AgentTimelineItem, ToolCallTimelineItem } from "../agent-sdk-types.js";
import { HandoffInputError } from "./types.js";
import type {
  ContextArtifact,
  HandoffItem,
  HandoffOrigin,
  HandoffProvenance,
  HandoffSourceRow,
  RowIdentity,
} from "./types.js";

interface MappingInput {
  rows: readonly HandoffSourceRow[];
  excludeNativeRows: ReadonlySet<string>;
  artifacts: readonly ContextArtifact[];
}

export interface MappedHandoff {
  items: HandoffItem[];
  omittedItems: HandoffProvenance[];
  sourceRows: RowIdentity[];
}

export function rowIdentityKey(identity: RowIdentity): string {
  const validIndex = Number.isSafeInteger(identity.rowIndex) && identity.rowIndex >= 0;
  if (!identity.segmentId || !validIndex) throw new HandoffInputError("row identity");
  return JSON.stringify([identity.segmentId, identity.incarnationId ?? null, identity.rowIndex]);
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
    case "read":
      return `Read: ${detail.filePath}`;
    case "search": {
      const lines = [`Search: ${detail.query}`];
      if (detail.numFiles !== undefined) lines.push(`Files: ${detail.numFiles}`);
      if (detail.numMatches !== undefined) lines.push(`Matches: ${detail.numMatches}`);
      return lines.join("\n");
    }
    case "fetch":
      return `Fetch: ${detail.url}`;
    case "worktree_setup":
      return `Worktree: ${detail.worktreePath}\nBranch: ${detail.branchName}`;
    case "plain_text":
      return detail.label ?? item.name;
    case "unknown":
      return JSON.stringify({ tool: item.name, callId: item.callId, detail });
  }
}

function itemContent(item: AgentTimelineItem): Pick<HandoffItem, "kind" | "text"> | null {
  switch (item.type) {
    case "user_message": {
      // Match replay's complete system-envelope rule without importing the dispatch module.
      if (/^<paseo-system>\n[\s\S]*\n<\/paseo-system>$/.test(item.text)) return null;
      return { kind: item.type, text: item.text };
    }
    case "assistant_message":
      return { kind: item.type, text: item.text };
    case "error":
      return { kind: item.type, text: item.message };
    case "tool_call": {
      let text = toolText(item);
      if (item.status === "failed") text += `\nError: ${JSON.stringify(item.error)}`;
      return { kind: item.type, text };
    }
    case "reasoning":
    case "todo":
    case "notification":
    case "compaction":
    case "plugin":
      return null;
  }
}

function itemOrigin(item: AgentTimelineItem): HandoffOrigin {
  if (item.type === "user_message") {
    return item.origin ?? { kind: "user" };
  }
  if (item.type === "tool_call") return { kind: "tool", name: item.name, callId: item.callId };
  return { kind: "assistant" };
}

function itemStatus(source: HandoffSourceRow): HandoffItem["status"] {
  if (source.interrupted) return "interrupted";
  if (source.row.item.type === "tool_call") return source.row.item.status;
  if (source.row.item.type === "error") return "failed";
  return "completed";
}

export function mapHandoffItems(input: MappingInput): MappedHandoff {
  const items: HandoffItem[] = [];
  const omittedItems: HandoffProvenance[] = [];
  const sourceRows: RowIdentity[] = [];
  const artifactsSeen = new Set<string>();
  for (const artifact of input.artifacts) {
    if (artifactsSeen.has(artifact.id)) continue;
    artifactsSeen.add(artifact.id);
    items.push({
      role: "assistant",
      kind: "context_artifact",
      text: artifact.text,
      origin: { kind: "artifact", source: artifact.origin },
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
    sourceRows.push({ ...source.identity });
    const item = source.row.item;
    const content = itemContent(item);
    if (content === null) continue;
    const { kind, text } = content;
    const provenance: HandoffProvenance = { type: "row", identity: { ...source.identity } };
    const oversizedTool = item.type === "tool_call" && Buffer.byteLength(text) > 64_000;
    if (oversizedTool) {
      omittedItems.push(provenance);
      continue;
    }
    const role = item.type === "user_message" ? "user" : "assistant";
    const origin = itemOrigin(item);
    const status = itemStatus(source);
    items.push({ role, kind, text, provenance, origin, status });
  }
  return { items, omittedItems, sourceRows };
}
