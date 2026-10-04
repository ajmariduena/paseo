import { beforeAll, describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import type { ToolCallItem } from "@/types/stream";
import { summarizeOverviewToolCalls } from "./model";
import { formatPaseoActivity } from "./paseo-activity";

let nextId = 0;

function paseoCall(
  leaf: string,
  input: Record<string, unknown> = {},
  options: { status?: "completed" | "failed"; output?: unknown; name?: string } = {},
): ToolCallItem {
  nextId += 1;
  const status = options.status ?? "completed";
  return {
    kind: "tool_call",
    id: `call_${nextId}`,
    timestamp: new Date(nextId),
    payload: {
      source: "agent",
      data: {
        provider: "claude",
        callId: `call_${nextId}`,
        name: options.name ?? `mcp__paseo__${leaf}`,
        status,
        error: status === "failed" ? "boom" : null,
        detail: { type: "unknown", input, output: options.output ?? null },
      },
    },
  };
}

function phrases(calls: ToolCallItem[]): string[] {
  const { summary } = summarizeOverviewToolCalls(calls);
  return summary.paseoActivities.map((entry) => formatPaseoActivity(i18n.t, entry));
}

describe("Paseo orchestration summaries", () => {
  beforeAll(async () => {
    if (!i18n.isInitialized) {
      await i18n.init();
    }
    await i18n.changeLanguage("en");
  });

  it("counts prompts and dedupes the agents they went to", () => {
    expect(
      phrases([
        paseoCall("send_agent_prompt", { agentId: "a", prompt: "one" }),
        paseoCall("send_agent_prompt", { agentId: "a", prompt: "two" }),
        paseoCall("send_agent_prompt", { agentId: "b", prompt: "three" }),
      ]),
    ).toEqual(["sent 3 prompts to 2 agents"]);
  });

  it("counts checked agents once however often they are polled", () => {
    expect(
      phrases([
        paseoCall("get_agent_status", { agentId: "a" }),
        paseoCall("get_agent_activity", { agentId: "a" }),
        paseoCall("get_agent_status", { agentId: "b" }),
      ]),
    ).toEqual(["checked 2 agents"]);
  });

  it("names each orchestration action in a fixed order", () => {
    expect(
      phrases([
        paseoCall("get_orchestration_capabilities"),
        paseoCall("create_heartbeat", { cron: "*/5 * * * *" }),
        paseoCall("create_schedule", { cron: "0 9 * * 1" }),
        paseoCall("respond_to_permission", { agentId: "a", requestId: "r1" }),
        paseoCall("archive_agent", { agentId: "a" }),
        paseoCall("cancel_agent", { agentId: "b" }),
        paseoCall("list_agents"),
        paseoCall("wait_for_agent", { agentIds: ["a", "b"] }),
      ]),
    ).toEqual([
      "waited for 2 agents",
      "listed agents",
      "stopped 1 agent",
      "archived 1 agent",
      "answered 1 permission request",
      "created 1 schedule",
      "created 1 heartbeat",
      "checked orchestration capabilities",
    ]);
  });

  it("reads 'tried to' only when every call of an action failed", () => {
    expect(
      phrases([
        paseoCall("cancel_agent", { agentId: "a" }, { status: "failed" }),
        paseoCall("send_agent_prompt", { agentId: "a" }, { status: "failed" }),
        paseoCall("send_agent_prompt", { agentId: "b" }),
      ]),
    ).toEqual(["sent 2 prompts to 2 agents", "tried to stop 1 agent"]);
  });

  it("accepts the direct paseo_ names some providers emit", () => {
    expect(phrases([paseoCall("", {}, { name: "paseo_list_agents" })])).toEqual(["listed agents"]);
  });

  it("keeps unnamed Paseo tools as 'called Paseo' and leaves spawns to the subagent rows", () => {
    const { summary } = summarizeOverviewToolCalls([
      paseoCall("list_worktrees"),
      paseoCall(
        "create_agent",
        { title: "Child" },
        { output: { structuredContent: { agentId: "agt_child" } } },
      ),
    ]);
    expect(summary.paseoActivities).toEqual([]);
    expect(summary.paseoCallCount).toBe(1);
  });

  it("counts a failed create_agent as a Paseo call, because it has no row of its own", () => {
    const { summary } = summarizeOverviewToolCalls([
      paseoCall("create_agent", { title: "Child" }, { status: "failed" }),
    ]);
    expect(summary.paseoCallCount).toBe(1);
  });
});
