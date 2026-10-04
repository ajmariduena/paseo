import { resolvePaseoSpawnedAgentId } from "@getpaseo/protocol/paseo-tool-call-detail";
import { getPaseoCallLeafName } from "@getpaseo/protocol/tool-name-normalization";
import type { StreamItem, ToolCallItem } from "@/types/stream";
import type { SubagentToolCallStatus } from "../presentation/status";

/** A tool call that started a subagent, read from the call alone. */
export type SubagentSpawnCall =
  | {
      kind: "paseo";
      callId: string;
      status: SubagentToolCallStatus;
      /** Null while `create_agent` is still running. */
      agentId: string | null;
      title: string | null;
      provider: string | null;
    }
  | {
      kind: "provider";
      callId: string;
      status: SubagentToolCallStatus;
      title: string | null;
    };

const spawnCallCache = new WeakMap<ToolCallItem, SubagentSpawnCall | null>();

function readInputString(input: unknown, key: string): string | null {
  if (typeof input !== "object" || input === null) return null;
  const value: unknown = Reflect.get(input, key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readSpawnCall(item: ToolCallItem): SubagentSpawnCall | null {
  if (item.payload.source !== "agent") return null;
  const { data } = item.payload;
  if (data.detail.type === "sub_agent") {
    return {
      kind: "provider",
      callId: data.callId,
      status: data.status,
      title: data.detail.description?.trim() || data.detail.subAgentType?.trim() || null,
    };
  }
  if (getPaseoCallLeafName(data.name) !== "create_agent") return null;
  // A failed spawn has no child to show; it stays a tool call with its error.
  if (data.status === "failed" || data.status === "canceled") return null;
  const input = data.detail.type === "unknown" ? data.detail.input : null;
  const output = data.detail.type === "unknown" ? data.detail.output : null;
  const agentId = resolvePaseoSpawnedAgentId(data.name, output);
  if (data.status === "completed" && !agentId) return null;
  return {
    kind: "paseo",
    callId: data.callId,
    status: data.status,
    agentId,
    title: readInputString(input, "title"),
    provider: readInputString(input, "provider")?.split("/")[0] ?? null,
  };
}

export function readSubagentSpawnCall(item: StreamItem): SubagentSpawnCall | null {
  if (item.kind !== "tool_call") return null;
  const cached = spawnCallCache.get(item);
  if (cached !== undefined) return cached;
  const spawn = readSpawnCall(item);
  spawnCallCache.set(item, spawn);
  return spawn;
}

export function isSubagentSpawnCall(item: StreamItem): boolean {
  return readSubagentSpawnCall(item) !== null;
}
