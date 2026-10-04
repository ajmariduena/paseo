import { describe, expect, it } from "vitest";

import {
  buildPaseoToolDetailSections,
  resolvePaseoSpawnedAgentId,
} from "./paseo-tool-call-detail.js";

describe("Paseo tool-call detail presentation", () => {
  it.each(["mcp__paseo__create_agent", "paseo.create_agent", "paseo_remote.create_agent"])(
    "shares one create-agent mapping for %s",
    (toolName) => {
      expect(
        buildPaseoToolDetailSections(
          toolName,
          {
            workspaceId: "wks_123",
            provider: "codex/gpt-5.4",
            title: "Greeter",
            initialPrompt: "Say hello back.\nDo nothing else.",
            notifyOnFinish: true,
          },
          { agentId: "agt_123", status: "idle" },
        ),
      ).toEqual([
        {
          kind: "prose",
          title: "Prompt",
          text: "Say hello back.\nDo nothing else.",
        },
        {
          kind: "fields",
          title: "Details",
          fields: [
            { label: "Title", value: "Greeter" },
            { label: "Provider", value: "codex/gpt-5.4" },
            { label: "Workspace", value: "wks_123" },
            { label: "Notify on finish", value: "Yes" },
          ],
        },
        {
          kind: "fields",
          title: "Result",
          fields: [
            { label: "Agent", value: "agt_123" },
            { label: "Status", value: "idle" },
          ],
        },
      ]);
    },
  );

  it("formats schedule cadence and nested settings without JSON syntax", () => {
    const sections = buildPaseoToolDetailSections(
      "mcp__paseo__create_schedule",
      {
        prompt: "Say hello back.",
        cron: "0 9 * * 1",
        timezone: "Europe/Berlin",
        provider: "codex/gpt-5.4",
        maxRuns: 1,
      },
      {
        id: "sch_123",
        status: "active",
        nextRunAt: "2026-09-07T09:00:00.000Z",
        target: { type: "new-agent", mode: "read-only" },
      },
    );

    expect(sections?.slice(0, 2)).toMatchObject([
      { kind: "prose", title: "Prompt", text: "Say hello back." },
      {
        kind: "fields",
        title: "Details",
        fields: [
          { label: "Cron", value: "0 9 * * 1" },
          { label: "Timezone", value: "Europe/Berlin" },
          { label: "Provider", value: "codex/gpt-5.4" },
          { label: "Maximum runs", value: "1" },
        ],
      },
    ]);
    expect(JSON.stringify(sections)).not.toContain('\\"new-agent\\"');
    expect(sections?.at(-1)).toEqual({
      kind: "fields",
      title: "Result",
      fields: [
        { label: "ID", value: "sch_123" },
        { label: "Status", value: "active" },
        { label: "Next run", value: "2026-09-07T09:00:00.000Z" },
      ],
    });
  });

  it("unwraps MCP result envelopes instead of exposing JSON-encoded text", () => {
    expect(
      buildPaseoToolDetailSections(
        "mcp__paseo__send_agent_prompt",
        { prompt: "Say hello back." },
        {
          meta: null,
          content: [
            {
              type: "text",
              text: '{"success":true,"status":"idle","lastMessage":"Hello back."}',
            },
          ],
          structuredContent: {
            success: true,
            status: "idle",
            lastMessage: "Hello back.",
          },
        },
      )?.at(-1),
    ).toEqual({
      kind: "fields",
      title: "Result",
      fields: [
        { label: "Status", value: "idle" },
        { label: "Last message", value: "Hello back." },
      ],
    });
  });

  it("uses readable fallback fields for newly added Paseo tools", () => {
    expect(
      buildPaseoToolDetailSections(
        "mcp__paseo__future_tool",
        { opaqueThing: ["one", "two"], enabled: false },
        { success: true },
      ),
    ).toEqual([
      {
        kind: "fields",
        title: "Details",
        fields: [
          { label: "Enabled", value: "No" },
          { label: "Opaque thing", value: "• one\n• two" },
        ],
      },
      {
        kind: "fields",
        title: "Result",
        fields: [{ label: "Success", value: "Yes" }],
      },
    ]);
  });

  it("reads send_agent_prompt delivery, retry key and outcome in words", () => {
    expect(
      buildPaseoToolDetailSections(
        "mcp__paseo__send_agent_prompt",
        {
          agentId: "agt_1",
          prompt: "Rebase onto main.",
          delivery: "queue",
          clientRequestId: "rebase-1",
          background: true,
        },
        {
          structuredContent: {
            success: true,
            status: "running",
            disposition: "queued",
            lastMessage: null,
            guidance: "You will get notified when the prompted agent finishes.",
          },
        },
      ),
    ).toEqual([
      { kind: "prose", title: "Prompt", text: "Rebase onto main." },
      {
        kind: "fields",
        title: "Details",
        fields: [
          { label: "Agent", value: "agt_1" },
          { label: "If the agent is busy", value: "Run after its turn" },
          { label: "Background", value: "Yes" },
          { label: "Retry key", value: "rebase-1" },
        ],
      },
      {
        kind: "fields",
        title: "Result",
        fields: [
          { label: "Outcome", value: "Runs after the running turn" },
          { label: "Status", value: "running" },
          { label: "Last message", value: "None" },
        ],
      },
    ]);
  });

  it("marks a create_agent retry that returned the agent it already made", () => {
    expect(
      buildPaseoToolDetailSections(
        "mcp__paseo__create_agent",
        { title: "Greeter", initialPrompt: "Hi", clientRequestId: "greeter-1" },
        { structuredContent: { agentId: "agt_1", status: "idle", deduplicated: true } },
      )?.slice(1),
    ).toEqual([
      {
        kind: "fields",
        title: "Details",
        fields: [
          { label: "Title", value: "Greeter" },
          { label: "Retry key", value: "greeter-1" },
        ],
      },
      {
        kind: "fields",
        title: "Result",
        fields: [
          { label: "Agent", value: "agt_1" },
          { label: "Status", value: "idle" },
          { label: "Deduplicated", value: "Yes" },
        ],
      },
    ]);
  });

  it("shows a wait_for_agent timeout and the delegated result it read", () => {
    expect(
      buildPaseoToolDetailSections(
        "mcp__paseo__wait_for_agent",
        { agentId: "agt_1", timeoutMs: 600000 },
        {
          structuredContent: {
            agentId: "agt_1",
            status: "idle",
            timedOut: false,
            lastMessage: "Done.",
            permission: null,
            delegatedTask: {
              taskId: "task_1",
              status: "completed",
              result: "Done.",
              resultTruncated: false,
            },
          },
        },
      ),
    ).toEqual([
      {
        kind: "fields",
        title: "Details",
        fields: [
          { label: "Agent", value: "agt_1" },
          { label: "Timeout (ms)", value: "600000" },
        ],
      },
      {
        kind: "fields",
        title: "Result",
        fields: [
          { label: "Status", value: "idle" },
          { label: "Timed out", value: "No" },
          { label: "Last message", value: "Done." },
          { label: "Permission", value: "None" },
          {
            label: "Delegated result",
            value: "Task: task_1\nStatus: completed\nResult: Done.\nResult truncated: No",
          },
        ],
      },
    ]);
  });

  it("orders list_agents scope filters first and names the scope", () => {
    expect(
      buildPaseoToolDetailSections(
        "mcp__paseo__list_agents",
        { limit: 20, titleContains: "review", scope: "children", parentAgentId: "agt_p" },
        null,
      ),
    ).toEqual([
      {
        kind: "fields",
        title: "Details",
        fields: [
          { label: "Scope", value: "My subagents" },
          { label: "Parent agent", value: "agt_p" },
          { label: "Title contains", value: "review" },
          { label: "Limit", value: "20" },
        ],
      },
    ]);
  });

  it("says whether cancel_agent had a run to stop", () => {
    expect(
      buildPaseoToolDetailSections(
        "mcp__paseo__cancel_agent",
        { agentId: "agt_1" },
        { structuredContent: { success: false, status: "not_running" } },
      )?.at(-1),
    ).toEqual({
      kind: "fields",
      title: "Result",
      fields: [{ label: "Status", value: "Not running" }],
    });
  });

  it("shows watch_pull_request with the checks it saw", () => {
    expect(
      buildPaseoToolDetailSections(
        "mcp__paseo__watch_pull_request",
        { number: 42 },
        {
          structuredContent: {
            number: 42,
            url: "https://github.com/acme/app/pull/42",
            title: "Add the widget",
            watching: true,
            wasWatching: false,
            checks: { failed: ["lint"], pending: 1, passed: false },
            conflicting: false,
          },
        },
      ),
    ).toEqual([
      { kind: "fields", title: "Details", fields: [{ label: "Pull request", value: "42" }] },
      {
        kind: "fields",
        title: "Result",
        fields: [
          { label: "Pull request", value: "42" },
          { label: "Title", value: "Add the widget" },
          { label: "Already watching", value: "No" },
          { label: "Checks", value: "Failed: • lint\nPending: 1\nPassed: No" },
          { label: "Conflicting", value: "No" },
        ],
      },
    ]);
  });

  it("keeps get_orchestration_capabilities to its limits and features", () => {
    expect(
      buildPaseoToolDetailSections(
        "mcp__paseo__get_orchestration_capabilities",
        { provider: "codex" },
        {
          structuredContent: {
            caller: null,
            providers: [{ id: "codex", models: [] }],
            agentProfiles: [],
            limits: { maxWaitMs: 3600000 },
            features: { waitForAgent: true },
          },
        },
      ),
    ).toEqual([
      { kind: "fields", title: "Details", fields: [{ label: "Provider", value: "codex" }] },
      {
        kind: "fields",
        title: "Result",
        fields: [
          { label: "Limits", value: "Max wait ms: 3600000" },
          { label: "Features", value: "Wait for agent: Yes" },
        ],
      },
    ]);
  });

  it("shows get_agent_activity paging position", () => {
    expect(
      buildPaseoToolDetailSections(
        "mcp__paseo__get_agent_activity",
        { agentId: "agt_1", view: "messages", afterPosition: 0, limit: 2 },
        {
          structuredContent: {
            agentId: "agt_1",
            updateCount: 4,
            currentModeId: null,
            content: "",
            epoch: "e1",
            nextPosition: 2,
            hasMore: true,
          },
        },
      ),
    ).toEqual([
      {
        kind: "fields",
        title: "Details",
        fields: [
          { label: "Agent", value: "agt_1" },
          { label: "View", value: "messages" },
          { label: "Limit", value: "2" },
          { label: "After position", value: "0" },
        ],
      },
      {
        kind: "fields",
        title: "Result",
        fields: [
          { label: "Content", value: "" },
          { label: "Next position", value: "2" },
          { label: "More after this page", value: "Yes" },
        ],
      },
    ]);
  });

  it("leaves non-Paseo tools alone", () => {
    expect(buildPaseoToolDetailSections("mcp__github__create_issue", {}, {})).toBeNull();
  });
});

describe("resolvePaseoSpawnedAgentId", () => {
  it.each(["mcp__paseo__create_agent", "paseo.create_agent", "paseo_create_agent"])(
    "reads the created agent from a structured %s result",
    (toolName) => {
      expect(
        resolvePaseoSpawnedAgentId(toolName, { structuredContent: { agentId: "agt_1" } }),
      ).toBe("agt_1");
    },
  );

  it("reads the created agent from a single text content block", () => {
    expect(
      resolvePaseoSpawnedAgentId("mcp__paseo__create_agent", {
        content: [{ type: "text", text: JSON.stringify({ agentId: "agt_2", status: "idle" }) }],
      }),
    ).toBe("agt_2");
  });

  it("returns null for other tools and for results without an agent", () => {
    expect(
      resolvePaseoSpawnedAgentId("mcp__paseo__send_agent_prompt", { agentId: "agt_3" }),
    ).toBeNull();
    expect(resolvePaseoSpawnedAgentId("mcp__paseo__create_agent", { status: "idle" })).toBeNull();
    expect(resolvePaseoSpawnedAgentId("mcp__paseo__create_agent", null)).toBeNull();
  });
});
