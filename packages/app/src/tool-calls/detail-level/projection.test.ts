import { describe, expect, it } from "vitest";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { StreamItem, ToolCallItem } from "@/types/stream";
import {
  prepareToolCallHistory,
  projectToolCallDetailLevel,
  type PreparedToolCallHistory,
  type ToolCallDetailLevel,
} from "./projection";
import { partitionSpawnRun } from "@/subagents/timeline/spawn-call";

type AssistantMessageItem = Extract<StreamItem, { kind: "assistant_message" }>;

function toolCall(
  id: string,
  detail: ToolCallDetail,
  options: {
    name?: string;
    status?: "running" | "completed" | "failed" | "canceled";
  } = {},
): ToolCallItem {
  return {
    kind: "tool_call",
    id,
    timestamp: new Date(`2026-01-01T00:00:${id.padStart(2, "0")}.000Z`),
    payload: {
      source: "agent",
      data: {
        provider: "claude",
        callId: id,
        name: options.name ?? detail.type,
        status: options.status ?? "completed",
        error: options.status === "failed" ? "boom" : null,
        detail,
      },
    },
  };
}

function assistant(id: string): AssistantMessageItem {
  return {
    kind: "assistant_message",
    id,
    text: id,
    timestamp: new Date("2026-01-01T00:01:00.000Z"),
  };
}

function project(input: {
  level: ToolCallDetailLevel;
  tail?: StreamItem[];
  head?: StreamItem[];
  isTurnActive?: boolean;
  preparedHistory?: PreparedToolCallHistory | null;
}) {
  const tail = input.tail ?? [];
  return projectToolCallDetailLevel({
    level: input.level,
    tail,
    head: input.head ?? [],
    preparedHistory: input.preparedHistory ?? prepareToolCallHistory(input.level, tail),
    isTurnActive: input.isTurnActive ?? false,
  });
}

describe("tool call detail-level projection", () => {
  it.each(["detailed", "overview"] as const)(
    "keeps pending approval tools out of %s presentation without removing their canonical position",
    (level) => {
      const pending = toolCall(
        "1",
        { type: "plan", text: "Ship it" },
        { name: "ExitPlanMode", status: "running" },
      );
      const followUp = {
        kind: "user_message",
        id: "question",
        text: "What about tests?",
        timestamp: new Date(2),
      } satisfies StreamItem;
      const tail = [pending, followUp];
      expect(project({ level, tail }).tail).toEqual([followUp]);
      expect(tail).toEqual([pending, followUp]);
      const rejected = toolCall("1", { type: "plan", text: "Ship it" }, { name: "plan_approval" });
      expect(project({ level, tail: [rejected, followUp] }).tail).toEqual([rejected, followUp]);
    },
  );

  it("passes detailed timelines through without grouping work", () => {
    const tail = [toolCall("1", { type: "shell", command: "one" })];
    const head = [toolCall("2", { type: "shell", command: "two" })];

    const prepared = prepareToolCallHistory("detailed", tail);
    const result = project({ level: "detailed", tail, head, preparedHistory: prepared });

    expect(prepared).toBeNull();
    expect(result.tail).toBe(tail);
    expect(result.head).toBe(head);
    expect(result.groupsByHostId.size).toBe(0);
  });

  it("keeps one stable overview host as a run grows", () => {
    const firstCall = toolCall("1", { type: "shell", command: "one" });
    const secondCall = toolCall("2", { type: "read", filePath: "/repo/a.ts" });
    const prepared = prepareToolCallHistory("overview", []);

    const single = project({
      level: "overview",
      head: [firstCall],
      isTurnActive: true,
      preparedHistory: prepared,
    });
    expect(single.head).toEqual([firstCall]);
    expect(single.groupsByHostId.get(firstCall.id)?.run).toMatchObject({
      calls: [firstCall],
      latest: firstCall,
      isSealed: false,
    });

    const grouped = project({
      level: "overview",
      head: [firstCall, secondCall],
      isTurnActive: true,
      preparedHistory: prepared,
    });
    expect(grouped.head).toEqual([
      expect.objectContaining({ id: firstCall.id, timestamp: secondCall.timestamp }),
    ]);
    expect(grouped.groupsByHostId.get(firstCall.id)?.run).toMatchObject({
      calls: [firstCall, secondCall],
      latest: secondCall,
      isSealed: false,
    });
  });

  it("keeps a parallel group loading while any call is still running", () => {
    const calls = [
      toolCall("1", { type: "shell", command: "slow" }, { status: "running" }),
      toolCall("2", { type: "shell", command: "done" }),
    ];
    const result = project({ level: "overview", head: calls, isTurnActive: true });

    expect(result.groupsByHostId.get("1")).toMatchObject({ mode: "overview", isLoading: true });
  });

  it("builds a loading aggregate for a one-call run", () => {
    const call = toolCall("1", { type: "shell", command: "one" }, { status: "running" });
    const result = project({ level: "overview", head: [call], isTurnActive: true });
    const group = result.groupsByHostId.get(call.id);
    if (!group) {
      throw new Error("Expected an overview group");
    }

    expect(group).toMatchObject({
      isLoading: true,
      summary: { commandCount: 1 },
    });
  });

  it("keeps an active overview group on its latest call until a visible boundary arrives", () => {
    const calls = [
      toolCall("1", { type: "shell", command: "one" }),
      toolCall("2", { type: "read", filePath: "/repo/a.ts" }),
      toolCall("3", { type: "read", filePath: "/repo/b.ts" }),
      toolCall("4", { type: "edit", filePath: "/repo/a.ts" }),
    ];
    const prepared = prepareToolCallHistory("overview", []);
    const active = project({
      level: "overview",
      head: calls,
      isTurnActive: true,
      preparedHistory: prepared,
    });
    const activeGroup = active.groupsByHostId.get("1");

    expect(activeGroup).toMatchObject({
      mode: "overview",
      run: { id: "1", latest: calls[3], isSealed: false },
    });
    const boundary = assistant("answer");
    const sealed = project({
      level: "overview",
      head: [...calls, boundary],
      isTurnActive: true,
      preparedHistory: prepared,
    });
    expect(sealed.groupsByHostId.get("1")).toMatchObject({
      mode: "overview",
      run: { latest: calls[3], isSealed: true },
      summary: { editedFileCount: 1, readFileCount: 2, commandCount: 1 },
    });
  });

  it("keeps a running overview group live before the agent lifecycle catches up", () => {
    const calls = ["1", "2", "3", "4"].map((id) =>
      toolCall(id, { type: "shell", command: id }, { status: "running" }),
    );

    const result = project({
      level: "overview",
      tail: calls,
      isTurnActive: false,
    });

    expect(result.groupsByHostId.get("1")).toMatchObject({
      run: { latest: calls[3], isSealed: false },
      isLoading: true,
      summary: { commandCount: 4 },
    });
  });

  it("seals the trailing overview group only when the turn ends", () => {
    const calls = ["1", "2", "3", "4"].map((id) => toolCall(id, { type: "shell", command: id }));
    const prepared = prepareToolCallHistory("overview", []);

    const betweenCalls = project({
      level: "overview",
      head: calls,
      isTurnActive: true,
      preparedHistory: prepared,
    });
    const nextCall = toolCall("5", { type: "read", filePath: "/repo/a.ts" });
    const continued = project({
      level: "overview",
      head: [...calls, nextCall],
      isTurnActive: true,
      preparedHistory: prepared,
    });
    const ended = project({
      level: "overview",
      head: [...calls, nextCall],
      isTurnActive: false,
      preparedHistory: prepared,
    });

    expect(betweenCalls.groupsByHostId.get("1")?.run.isSealed).toBe(false);
    expect(continued.groupsByHostId.get("1")?.run).toMatchObject({
      latest: nextCall,
      isSealed: false,
    });
    expect(ended.groupsByHostId.get("1")?.run.isSealed).toBe(true);
  });

  it("builds overview summaries without category-specific presentation data", () => {
    const calls = [
      toolCall("1", { type: "read", filePath: "/repo/src/a.ts" }),
      toolCall("2", { type: "read", filePath: "/repo/src/b.ts" }),
      toolCall("3", { type: "shell", command: "npm test" }),
      toolCall("4", { type: "edit", filePath: "/repo/src/a.ts" }, { status: "failed" }),
    ];

    const overview = project({ level: "overview", head: calls });

    expect(overview.groupsByHostId.get("1")).toEqual({
      mode: "overview",
      run: expect.any(Object),
      isLoading: false,
      summary: {
        editedFileCount: 1,
        commandCount: 1,
        readFileCount: 2,
        searchCount: 0,
        otherToolCount: 0,
        paseoActivities: [],
        paseoCallCount: 0,
      },
    });
  });

  it("distinguishes reads, searches, and other tools in overview", () => {
    const calls = [
      toolCall("1", { type: "read", filePath: "/repo/src/a.ts" }),
      toolCall("2", { type: "read", filePath: "C:\\repo\\src\\beta.ts" }),
      toolCall("3", { type: "fetch", url: "https://github.com/org/repo" }),
      toolCall(
        "4",
        { type: "search", query: "paseo", toolName: "web_search" },
        { status: "failed" },
      ),
      toolCall("5", { type: "fetch", url: "not a url" }),
    ];

    const result = project({ level: "overview", head: calls });

    expect(result.groupsByHostId.get("1")).toMatchObject({
      summary: {
        editedFileCount: 0,
        commandCount: 0,
        readFileCount: 2,
        searchCount: 1,
        otherToolCount: 2,
      },
    });
  });

  it("counts unique edited files and every shell command in overview", () => {
    const calls = [
      toolCall("1", { type: "edit", filePath: "/repo/a.ts" }),
      toolCall("2", { type: "edit", filePath: "/repo/a.ts" }),
      toolCall("3", { type: "write", filePath: "/repo/b.ts" }),
      toolCall("4", { type: "shell", command: "npm test" }),
      toolCall("5", { type: "shell", command: "npm run lint" }),
      toolCall("6", { type: "read", filePath: "/repo/c.ts" }),
    ];

    const result = project({ level: "overview", head: calls });

    expect(result.groupsByHostId.get("1")).toMatchObject({
      summary: {
        editedFileCount: 2,
        commandCount: 2,
        readFileCount: 1,
        otherToolCount: 0,
      },
    });
  });

  it("counts Paseo calls separately from other tools", () => {
    const calls = [
      toolCall("1", { type: "unknown", input: null, output: null }, { name: "paseo.list_agents" }),
      toolCall(
        "2",
        { type: "unknown", input: null, output: null },
        { name: "mcp__paseo__list_worktrees" },
      ),
      toolCall("3", { type: "fetch", url: "https://paseo.sh" }),
      toolCall("4", { type: "fetch", url: "https://github.com/getpaseo" }),
    ];

    const result = project({ level: "overview", head: calls });

    expect(result.groupsByHostId.get("1")).toMatchObject({
      summary: {
        otherToolCount: 2,
        paseoActivities: [{ activity: "listedAgents", count: 1, agentCount: 1, failedOnly: false }],
        paseoCallCount: 1,
      },
    });
  });

  it("classifies direct Brave search and Paseo runtime tool names", () => {
    const unknownDetail = { type: "unknown" as const, input: null, output: null };
    const calls = [
      toolCall("1", unknownDetail, { name: "brave-search_brave_web_search" }),
      toolCall("2", unknownDetail, { name: "brave-search_brave_llm_context" }),
      toolCall("3", unknownDetail, { name: "paseo_list_providers" }),
      toolCall("4", unknownDetail, { name: "paseo_list_worktrees" }),
      toolCall("5", unknownDetail, { name: "paseo_list_worktrees" }),
      toolCall("6", unknownDetail, { name: "mcp__exa__web_search" }),
    ];

    const result = project({ level: "overview", head: calls });

    expect(result.groupsByHostId.get("1")).toMatchObject({
      summary: { searchCount: 3, otherToolCount: 0, paseoCallCount: 3 },
    });
  });

  it("reuses prepared history and sealed group models across live-head updates", () => {
    const historicalCalls = ["1", "2", "3", "4"].map((id) =>
      toolCall(id, { type: "shell", command: id }),
    );
    const tail = [...historicalCalls, assistant("boundary")];
    const prepared = prepareToolCallHistory("overview", tail);
    if (!prepared) {
      throw new Error("Overview history must be prepared");
    }
    expect(prepared.grouped.tail).toEqual([
      expect.objectContaining({ id: "1", timestamp: historicalCalls[3]?.timestamp }),
      tail[4],
    ]);
    const first = project({
      level: "overview",
      tail,
      head: [toolCall("5", { type: "read", filePath: "/repo/a.ts" })],
      isTurnActive: true,
      preparedHistory: prepared,
    });
    const second = project({
      level: "overview",
      tail,
      head: [
        toolCall("5", { type: "read", filePath: "/repo/a.ts" }),
        toolCall("6", { type: "read", filePath: "/repo/b.ts" }),
      ],
      isTurnActive: true,
      preparedHistory: prepared,
    });

    expect(first.tail).toBe(prepared.grouped.tail);
    expect(second.tail).toBe(prepared.grouped.tail);
    expect(first.groupsByHostId.get("1")).toBe(prepared.grouped.groupsByHostId.get("1"));
    expect(second.groupsByHostId.get("1")).toBe(prepared.grouped.groupsByHostId.get("1"));
    expect(first.historyGroupUpdatesByHostId.size).toBe(0);
    expect(second.historyGroupUpdatesByHostId).toBe(first.historyGroupUpdatesByHostId);
    expect(second.groupsByHostId.get("5")?.run.calls).toHaveLength(2);
  });

  it("preserves projected history identity during assistant-only head updates", () => {
    const trailingCalls = [
      toolCall("1", { type: "shell", command: "one" }),
      toolCall("2", { type: "read", filePath: "/repo/a.ts" }),
    ];
    const tail = [assistant("before"), ...trailingCalls];
    const prepared = prepareToolCallHistory("overview", tail);
    if (!prepared) {
      throw new Error("Overview history must be prepared");
    }

    const firstHead = [assistant("answer")];
    const secondHead = [{ ...firstHead[0], text: "answer grows" }];
    const first = project({
      level: "overview",
      tail,
      head: firstHead,
      isTurnActive: true,
      preparedHistory: prepared,
    });
    const second = project({
      level: "overview",
      tail,
      head: secondHead,
      isTurnActive: true,
      preparedHistory: prepared,
    });

    expect(first.tail).toBe(prepared.grouped.tail);
    expect(second.tail).toBe(prepared.grouped.tail);
    expect(first.groupsByHostId).toBe(prepared.grouped.groupsByHostId);
    expect(second.groupsByHostId).toBe(prepared.grouped.groupsByHostId);
    expect(first.historyGroupUpdatesByHostId.size).toBe(0);
    expect(second.historyGroupUpdatesByHostId).toBe(first.historyGroupUpdatesByHostId);
  });

  it("forms one group across the retained-history and live-head boundary", () => {
    const tail = [
      assistant("before"),
      toolCall("1", { type: "shell", command: "one" }),
      toolCall("2", { type: "shell", command: "two" }),
    ];
    const head = [
      toolCall("3", { type: "read", filePath: "/repo/a.ts" }),
      toolCall("4", { type: "edit", filePath: "/repo/a.ts" }, { status: "running" }),
    ];

    const result = project({ level: "overview", tail, head, isTurnActive: true });

    expect(result.tail).toEqual([
      tail[0],
      expect.objectContaining({ id: "1", timestamp: tail[2]?.timestamp }),
    ]);
    expect(result.head).toEqual([]);
    expect(result.groupsByHostId.get("1")?.run).toMatchObject({
      calls: [...tail.slice(1), ...head],
      latest: head[1],
      isSealed: false,
    });
    expect(result.historyGroupUpdatesByHostId.get("1")).toBe(result.groupsByHostId.get("1"));
  });

  it("keeps a trailing history-only group in the retained segment", () => {
    const tail = ["1", "2", "3", "4"].map((id) => toolCall(id, { type: "shell", command: id }));

    const result = project({ level: "overview", tail, isTurnActive: false });

    expect(result.tail).toEqual([
      expect.objectContaining({ id: "1", timestamp: tail[3]?.timestamp }),
    ]);
    expect(result.head).toEqual([]);
    expect(result.groupsByHostId.get("1")?.run.isSealed).toBe(true);
  });

  it("hosts single calls while leaving plans and spoken messages ungrouped", () => {
    const singleCall = toolCall("1", { type: "shell", command: "one" });
    const plan = toolCall("2", { type: "plan", text: "Plan" });
    const speak = toolCall(
      "3",
      { type: "unknown", input: "Hello", output: null },
      { name: "speak" },
    );

    const result = project({ level: "overview", head: [singleCall, plan, speak] });

    expect(result.head).toEqual([singleCall, plan, speak]);
    expect(result.groupsByHostId.get(singleCall.id)?.run.calls).toEqual([singleCall]);
    expect(result.groupsByHostId.size).toBe(1);
  });

  describe("subagent spawn calls", () => {
    function createAgent(id: string, agentId: string | null): ToolCallItem {
      return toolCall(
        id,
        {
          type: "unknown",
          input: { title: `Child ${id}`, provider: "codex/gpt-5.4" },
          output: agentId ? { structuredContent: { agentId } } : null,
        },
        { name: "mcp__paseo__create_agent", status: agentId ? "completed" : "running" },
      );
    }

    it("takes spawns out of the overview run and groups adjacent ones", () => {
      const read = toolCall("1", { type: "read", filePath: "/repo/a.ts" });
      const first = createAgent("2", "agt_a");
      const second = createAgent("3", "agt_b");
      const shell = toolCall("4", { type: "shell", command: "rg x" });

      const result = project({ level: "overview", tail: [read, first, second, shell] });

      expect(result.tail).toEqual([
        expect.objectContaining({ id: "1" }),
        expect.objectContaining({ id: "2" }),
        expect.objectContaining({ id: "4" }),
      ]);
      expect(result.groupsByHostId.get("1")).toMatchObject({
        mode: "overview",
        summary: { readFileCount: 1, paseoCallCount: 0 },
      });
      expect(result.groupsByHostId.get("2")).toMatchObject({
        mode: "subagents",
        run: { kind: "subagents", calls: [first, second] },
      });
      expect(result.groupsByHostId.get("4")).toMatchObject({ mode: "overview" });
    });

    it("keeps a still-running spawn in the subagent run before its agent exists", () => {
      const running = createAgent("1", null);

      const result = project({ level: "overview", head: [running], isTurnActive: true });

      expect(result.groupsByHostId.get("1")).toMatchObject({
        mode: "subagents",
        run: { calls: [running], isSealed: false },
      });
    });

    it("leaves a failed spawn in the overview run with its error", () => {
      const failed = toolCall(
        "1",
        { type: "unknown", input: { title: "Child" }, output: null },
        { name: "mcp__paseo__create_agent", status: "failed" },
      );
      const read = toolCall("2", { type: "read", filePath: "/repo/a.ts" });

      const result = project({ level: "overview", tail: [failed, read] });

      expect(result.groupsByHostId.get("1")).toMatchObject({
        mode: "overview",
        run: { calls: [failed, read] },
      });
    });

    it("joins a provider subagent call with an adjacent Paseo spawn", () => {
      const native = toolCall(
        "1",
        { type: "sub_agent", subAgentType: "Explore", description: "Map the pane", log: "" },
        { name: "Task", status: "running" },
      );
      const paseo = createAgent("2", "agt_a");

      const result = project({ level: "overview", head: [native, paseo], isTurnActive: true });

      expect(result.groupsByHostId.get("1")).toMatchObject({
        mode: "subagents",
        run: { calls: [native, paseo] },
      });
    });

    it("seals a history spawn run when the live head continues with tool work", () => {
      const spawn = createAgent("1", "agt_a");
      const shell = toolCall("2", { type: "shell", command: "rg x" }, { status: "running" });

      const result = project({
        level: "overview",
        tail: [spawn],
        head: [shell],
        isTurnActive: true,
      });

      expect(result.groupsByHostId.get("1")).toMatchObject({
        mode: "subagents",
        run: { calls: [spawn], isSealed: true },
      });
      expect(result.groupsByHostId.get("2")).toMatchObject({
        mode: "overview",
        run: { calls: [shell] },
      });
    });
  });
});

function claudeCreateAgent(
  id: string,
  input: { title: string; provider: string },
  result: { agentId: string; type: string; currentModeId: string } | { error: string },
): ToolCallItem {
  const failed = "error" in result;
  const call = toolCall(
    id,
    {
      type: "unknown",
      input: { ...input, initialPrompt: "Solo la línea.", clientRequestId: `qa-${id}` },
      output: failed
        ? null
        : {
            output: {
              ...result,
              status: "running",
              cwd: "/tmp/qa-orch",
              lastMessage: null,
              permission: null,
            },
          },
    },
    { name: "mcp__paseo__create_agent", status: failed ? "failed" : "completed" },
  );
  if (failed && call.payload.source === "agent") {
    call.payload.data.error = {
      type: "tool_result",
      content: result.error,
      is_error: true,
      tool_use_id: call.payload.data.callId,
    };
  }
  return call;
}

function claudeCall(id: string, name: string, output: unknown): ToolCallItem {
  return toolCall(id, { type: "unknown", input: {}, output: { output } }, { name });
}

describe("subagent spawn runs from real Claude timelines", () => {
  it("groups two Haiku children created after permission approval", () => {
    const search = claudeCall("1", "ToolSearch", [
      { tool_name: "mcp__paseo__create_agent", type: "tool_reference" },
    ]);
    const capabilities = claudeCall("2", "mcp__paseo__get_orchestration_capabilities", {
      caller: { provider: "claude", modeId: "default" },
    });
    const haikuA = claudeCreateAgent(
      "3",
      { title: "Haiku A", provider: "claude/claude-haiku-4-5" },
      {
        agentId: "12f4881e-4be0-45ec-b149-260a3d9ec66f",
        type: "claude",
        currentModeId: "default",
      },
    );
    const haikuB = claudeCreateAgent(
      "4",
      { title: "Haiku B", provider: "claude/claude-haiku-4-5" },
      {
        agentId: "6229f4ce-e8a8-4301-b68a-df2a419e57c6",
        type: "claude",
        currentModeId: "default",
      },
    );

    const result = project({
      level: "overview",
      tail: [search, capabilities, haikuA, haikuB, assistant("done")],
    });

    expect(result.groupsByHostId.get("1")).toMatchObject({
      mode: "overview",
      run: { calls: [search, capabilities] },
      summary: { paseoCallCount: 0 },
    });
    expect(result.groupsByHostId.get("3")).toMatchObject({
      mode: "subagents",
      run: { calls: [haikuA, haikuB] },
    });
  });

  it("keeps a failed spawn in the group's run without splitting the successful ones", () => {
    const claude = claudeCreateAgent(
      "1",
      { title: "Claude: nombre", provider: "claude/claude-haiku-4-5" },
      {
        agentId: "dfc3ef40-b151-4599-a21f-22b5cc787767",
        type: "claude",
        currentModeId: "bypassPermissions",
      },
    );
    const codexFailed = claudeCreateAgent(
      "2",
      { title: "Codex: nombre", provider: "codex/gpt-6-sol" },
      {
        error:
          "cannot inherit mode 'bypassPermissions' from caller (provider 'claude') for new agent (provider 'codex'). Pass an explicit mode.",
      },
    );
    const codex = claudeCreateAgent(
      "3",
      { title: "Codex: nombre", provider: "codex/gpt-6-sol" },
      { agentId: "bf7e54dd-ad56-40a7-b767-0409f33ca733", type: "codex", currentModeId: "auto" },
    );
    const wait = claudeCall("4", "mcp__paseo__wait_for_agent", {
      agentId: "dfc3ef40-b151-4599-a21f-22b5cc787767",
      status: "idle",
    });

    const result = project({ level: "overview", tail: [claude, codexFailed, codex, wait] });

    expect(result.tail.map((item) => item.id)).toEqual(["1", "4"]);
    const group = result.groupsByHostId.get("1");
    expect(group).toMatchObject({
      mode: "subagents",
      run: { calls: [claude, codexFailed, codex] },
    });
    expect(partitionSpawnRun(group?.run.calls ?? [])).toEqual({
      spawns: [claude, codex],
      failed: [codexFailed],
    });
    expect(result.groupsByHostId.get("4")).toMatchObject({
      mode: "overview",
      summary: { paseoActivities: [{ activity: "waitedForAgents" }] },
    });
  });

  it("leaves a failed spawn that no spawn precedes in the tool run", () => {
    const failed = claudeCreateAgent(
      "1",
      { title: "Codex: nombre", provider: "codex/gpt-6-sol" },
      { error: "boom" },
    );
    const retry = claudeCreateAgent(
      "2",
      { title: "Codex: nombre", provider: "codex/gpt-6-sol" },
      { agentId: "agt_retry", type: "codex", currentModeId: "auto" },
    );

    const result = project({ level: "overview", tail: [failed, retry] });

    expect(result.groupsByHostId.get("1")).toMatchObject({
      mode: "overview",
      run: { calls: [failed] },
    });
    expect(result.groupsByHostId.get("2")).toMatchObject({
      mode: "subagents",
      run: { calls: [retry] },
    });
  });

  it("continues a live subagent run across a failed spawn arriving in the head", () => {
    const first = claudeCreateAgent(
      "1",
      { title: "A", provider: "claude/claude-haiku-4-5" },
      { agentId: "agt_a", type: "claude", currentModeId: "default" },
    );
    const failed = claudeCreateAgent(
      "2",
      { title: "B", provider: "codex/gpt-6-sol" },
      { error: "boom" },
    );
    const second = claudeCreateAgent(
      "3",
      { title: "B", provider: "codex/gpt-6-sol" },
      { agentId: "agt_b", type: "codex", currentModeId: "auto" },
    );

    const result = project({
      level: "overview",
      tail: [first],
      head: [failed, second],
      isTurnActive: true,
    });

    expect(result.groupsByHostId.get("1")).toMatchObject({
      mode: "subagents",
      run: { calls: [first, failed, second] },
    });
  });
});
