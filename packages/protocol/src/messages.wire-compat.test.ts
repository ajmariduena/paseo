import { VoiceCommandsSettingsSchema } from "./voice-commands/rpc-schemas.js";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  AgentSnapshotPayloadSchema,
  AgentTimelineItemPayloadSchema,
  ServerInfoStatusPayloadSchema,
  SessionOutboundMessageSchema,
  SessionInboundMessageSchema,
  WSHelloMessageSchema,
  WorkspaceSetupSnapshotSchema,
  WorkspaceSetupProgressMessageSchema,
  AgentTimelineEntryPayloadSchema,
  MutableDaemonConfigPatchSchema,
  MutableDaemonConfigSchema,
  validateQuickPrompts,
} from "./messages.js";

test("terminal listings accept older rows and retain new per-terminal directories", () => {
  const response = {
    type: "list_terminals_response",
    payload: {
      requestId: "terminal-list",
      cwd: "/workspace",
      terminals: [{ id: "terminal", name: "Shell", workspaceId: "workspace" }],
    },
  };
  expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
  const withDirectory = {
    ...response,
    payload: {
      ...response.payload,
      terminals: [{ ...response.payload.terminals[0], cwd: "/workspace/subdirectory" }],
    },
  };
  expect(SessionOutboundMessageSchema.parse(withDirectory)).toEqual(withDirectory);
});

const LegacySubAgentToolCallSchema = z.object({
  type: z.literal("tool_call"),
  callId: z.string(),
  name: z.string(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
  error: z.unknown().nullable(),
  detail: z.object({
    type: z.literal("sub_agent"),
    subAgentType: z.string().optional(),
    description: z.string().optional(),
    log: z.string(),
    // Copied from v0.1.65-beta.3: actions was required even though the UI ignored it.
    actions: z.array(
      z.object({
        index: z.number().int().positive(),
        toolName: z.string(),
        summary: z.string().optional(),
      }),
    ),
  }),
});

const LegacyAgentCapabilityFlagsSchema = z.object({
  supportsStreaming: z.boolean(),
  supportsSessionPersistence: z.boolean(),
  supportsDynamicModes: z.boolean(),
  supportsMcpServers: z.boolean(),
  supportsReasoningStream: z.boolean(),
  supportsToolInvocations: z.boolean(),
});

const LegacyAgentSnapshotPayloadSchema = AgentSnapshotPayloadSchema.extend({
  capabilities: LegacyAgentCapabilityFlagsSchema,
});

describe("wire schema compatibility", () => {
  test("preview browser setup and status RPCs accept optional response fields", () => {
    for (const operation of ["get_status", "setup"] as const) {
      expect(
        SessionInboundMessageSchema.parse({
          type: `daemon.browser.${operation}.request`,
          requestId: "browser",
        }),
      ).toMatchObject({ requestId: "browser" });
      expect(
        SessionOutboundMessageSchema.parse({
          type: `daemon.browser.${operation}.response`,
          payload: { requestId: "browser" },
        }),
      ).toMatchObject({ payload: { requestId: "browser" } });
      expect(
        SessionOutboundMessageSchema.parse({
          type: `daemon.browser.${operation}.response`,
          payload: {
            requestId: "browser",
            status: { state: "installed", version: "155", platform: "mac-arm64" },
          },
        }),
      ).toMatchObject({ payload: { status: { state: "installed" } } });
    }
  });
  test("HTML render RPC is correlated and the server feature stays optional", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({ status: "server_info", serverId: "old" }).features,
    ).toBeUndefined();
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "new",
        features: { htmlRender: true },
      }).features?.htmlRender,
    ).toBe(true);
    expect(
      SessionInboundMessageSchema.parse({
        type: "agent.html_render.get.request",
        requestId: "r",
        agentId: "a",
        renderId: "id",
      }),
    ).toMatchObject({ requestId: "r", agentId: "a", renderId: "id" });
    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.html_render.get.response",
        payload: {
          requestId: "r",
          agentId: "a",
          renderId: "id",
          html: "<p>Hi</p>",
          title: "Hi",
          error: null,
        },
      }),
    ).toMatchObject({ payload: { requestId: "r", html: "<p>Hi</p>" } });
  });

  test("Codex visualization RPCs preserve optional feature flags and correlation", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({ status: "server_info", serverId: "old" }).features,
    ).toBeUndefined();
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "new",
        features: { codexVisualization: true },
      }).features?.codexVisualization,
    ).toBe(true);
    expect(
      SessionInboundMessageSchema.parse({
        type: "agent.visualization.get.request",
        requestId: "read",
        agentId: "agent",
        path: "/work/visual.html",
      }),
    ).toMatchObject({ requestId: "read", agentId: "agent" });
    expect(
      SessionInboundMessageSchema.parse({
        type: "agent.visualization.set_state.request",
        requestId: "write",
        agentId: "agent",
        path: "/work/visual.html",
        state: { modelContent: { selected: "a" } },
      }),
    ).toMatchObject({ requestId: "write", state: { modelContent: { selected: "a" } } });
    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.visualization.get.response",
        payload: {
          requestId: "read",
          agentId: "agent",
          path: "/work/visual.html",
          canonicalPath: "/work/visual.html",
          revision: "sha256",
          html: "<p>Visual</p>",
          state: null,
          error: null,
        },
      }),
    ).toMatchObject({ payload: { requestId: "read", html: "<p>Visual</p>" } });
    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.visualization.set_state.response",
        payload: {
          requestId: "write",
          agentId: "agent",
          path: "/work/visual.html",
          state: { modelContent: { selected: "a" }, privateContent: null },
          error: null,
        },
      }),
    ).toMatchObject({ payload: { requestId: "write" } });
  });
  test("hello parses with and without the project update capability", () => {
    const legacy = WSHelloMessageSchema.parse({
      type: "hello",
      clientId: "legacy-client",
      clientType: "mobile",
      protocolVersion: 1,
    });
    const capable = WSHelloMessageSchema.parse({
      type: "hello",
      clientId: "capable-client",
      clientType: "mobile",
      protocolVersion: 1,
      capabilities: { project_updates: true },
    });

    expect([legacy, capable]).toEqual([
      {
        type: "hello",
        clientId: "legacy-client",
        clientType: "mobile",
        protocolVersion: 1,
      },
      {
        type: "hello",
        clientId: "capable-client",
        clientType: "mobile",
        protocolVersion: 1,
        capabilities: { project_updates: true },
      },
    ]);
  });

  test("timeline replacement invalidation is opt-in and carries no timeline rows", () => {
    expect(
      WSHelloMessageSchema.parse({
        type: "hello",
        clientId: "capable-client",
        clientType: "mobile",
        protocolVersion: 1,
        capabilities: { timeline_replacement_invalidation: true },
      }).capabilities,
    ).toEqual({ timeline_replacement_invalidation: true });

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.timeline.replacement",
        payload: { agentId: "agent-1", epoch: "epoch-2" },
      }),
    ).toEqual({
      type: "agent.timeline.replacement",
      payload: { agentId: "agent-1", epoch: "epoch-2" },
    });
  });

  test("server info strips unknown legacy features while accepting former turn identity", () => {
    const parsed = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "legacy-server",
      features: {
        workspaceGithubClone: true,
        agentTurnIdentity: true,
      },
    });

    expect(parsed).toEqual({
      status: "server_info",
      serverId: "legacy-server",
      hostname: null,
      version: null,
      features: { agentTurnIdentity: true },
    });
  });

  test("assistant timeline message ids are optional on the wire", () => {
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "assistant_message",
        text: "old daemon shape",
      }),
    ).toEqual({
      type: "assistant_message",
      text: "old daemon shape",
    });
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "assistant_message",
        text: "new daemon shape",
        messageId: "msg-1",
      }),
    ).toEqual({
      type: "assistant_message",
      text: "new daemon shape",
      messageId: "msg-1",
    });
  });

  test("task progress fields are optional on the wire", () => {
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "todo",
        items: [{ text: "Legacy task", completed: false }],
      }),
    ).toEqual({ type: "todo", items: [{ text: "Legacy task", completed: false }] });
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "todo",
        items: [
          {
            id: "task-1",
            text: "Current task",
            activeForm: "Working on current task",
            status: "in_progress",
            completed: false,
          },
        ],
      }),
    ).toEqual({
      type: "todo",
      items: [
        {
          id: "task-1",
          text: "Current task",
          activeForm: "Working on current task",
          status: "in_progress",
          completed: false,
        },
      ],
    });
  });

  test("sub_agent tool-call payload still parses against the v0.1.65-beta.3 schema", () => {
    const parsed = LegacySubAgentToolCallSchema.parse({
      type: "tool_call",
      callId: "call-sub-agent-1",
      name: "Task",
      status: "completed",
      error: null,
      detail: {
        type: "sub_agent",
        subAgentType: "Explore",
        description: "Inspect repository structure",
        childSessionId: "child-session-1",
        log: "[Read] README.md",
        actions: [],
      },
    });

    expect(parsed.detail.actions).toEqual([]);
  });

  test("old clients parse agent snapshots with rewind capabilities", () => {
    const parsed = LegacyAgentSnapshotPayloadSchema.parse({
      id: "agent-1",
      provider: "claude",
      cwd: "/tmp/project",
      model: null,
      thinkingOptionId: null,
      effectiveThinkingOptionId: null,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
        supportsRewindConversation: true,
        supportsRewindFiles: true,
        supportsRewindBoth: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: null,
      labels: {},
    });

    expect(parsed.capabilities).toEqual({
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    });
  });

  test("new clients parse agent snapshots without rewind capabilities", () => {
    const parsed = AgentSnapshotPayloadSchema.parse({
      id: "agent-1",
      provider: "claude",
      cwd: "/tmp/project",
      model: null,
      thinkingOptionId: null,
      effectiveThinkingOptionId: null,
      createdAt: "2026-05-23T00:00:00.000Z",
      updatedAt: "2026-05-23T00:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: null,
      labels: {},
    });

    expect(parsed.capabilities.supportsRewindConversation).toBe(false);
    expect(parsed.capabilities.supportsRewindFiles).toBe(false);
    expect(parsed.capabilities.supportsRewindBoth).toBe(false);
  });

  test("user messages carry the agent that sent them, and old clients still parse them", () => {
    const item = {
      type: "user_message",
      text: "Review the diff",
      messageId: "mcp:parent:1",
      clientMessageId: "mcp:parent:1",
      origin: { kind: "agent", agentId: "parent-agent" },
    };
    expect(AgentTimelineItemPayloadSchema.parse(item)).toEqual(item);
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "user_message",
        text: "hi",
        origin: { kind: "user" },
      }),
    ).toEqual({ type: "user_message", text: "hi", origin: { kind: "user" } });

    // Copied from v0.11.0-beta.3, before user messages had an origin.
    const LegacyUserMessageSchema = z.object({
      type: z.literal("user_message"),
      text: z.string(),
      messageId: z.string().optional(),
      clientMessageId: z.string().optional(),
    });
    expect(LegacyUserMessageSchema.parse(item)).toEqual({
      type: "user_message",
      text: "Review the diff",
      messageId: "mcp:parent:1",
      clientMessageId: "mcp:parent:1",
    });
  });

  test("notification rows carry their prompt id and subagent source, and old clients still parse them", () => {
    const item = {
      type: "notification",
      level: "info",
      message: "2 delegated tasks reported back: Review, Tests",
      messageId: "wake:parent:run-1:1",
      source: {
        kind: "subagent",
        subagents: [
          { agentId: "child-a", reason: "finished", title: "Review", durationMs: 42_000 },
          { agentId: "child-b", reason: "errored" },
        ],
      },
    };
    expect(AgentTimelineItemPayloadSchema.parse(item)).toEqual(item);

    // Copied from v0.11.0-beta.3, before notification rows had a source.
    const LegacyNotificationSchema = z.object({
      type: z.literal("notification"),
      level: z.enum(["info", "warning", "error"]),
      message: z.string(),
    });
    expect(LegacyNotificationSchema.parse(item)).toEqual({
      type: "notification",
      level: "info",
      message: "2 delegated tasks reported back: Review, Tests",
    });
  });

  test("provider switch dividers stay parseable by clients that only know subagent sources", () => {
    const divider = {
      type: "notification",
      level: "info",
      message: "Switched from claude to codex",
      providerSegment: {
        kind: "provider_switch",
        segmentId: "seg-b",
        fromProvider: "claude",
        toProvider: "codex",
        fromModel: "claude-opus-5-5",
        toModel: null,
        handoffId: "handoff-1",
      },
    };
    expect(AgentTimelineItemPayloadSchema.parse(divider)).toEqual(divider);
    const gap = {
      type: "notification",
      level: "warning",
      message: "The earlier claude history could not be read",
      providerSegment: {
        kind: "retired_history",
        segmentId: "seg-a",
        incarnationId: "inc-a1",
        reason: "unavailable",
      },
    };
    expect(AgentTimelineItemPayloadSchema.parse(gap)).toEqual(gap);
    const marker = {
      type: "notification",
      level: "warning",
      message: "A codex prompt's delivery was uncertain; a new session was started",
      providerSegment: {
        kind: "incarnation",
        segmentId: "seg-b",
        incarnationId: "inc-b2",
        reason: "uncertain_delivery",
      },
    };
    expect(AgentTimelineItemPayloadSchema.parse(marker)).toEqual(marker);

    // Copied from v0.11.0-beta.19: notifications with a closed `source` union.
    const NotificationWithSourceSchema = z.object({
      type: z.literal("notification"),
      level: z.enum(["info", "warning", "error"]),
      message: z.string(),
      messageId: z.string().optional(),
      source: z
        .discriminatedUnion("kind", [
          z.object({
            kind: z.literal("subagent"),
            subagents: z.array(z.object({ agentId: z.string() })),
          }),
        ])
        .optional(),
    });
    for (const row of [divider, gap, marker]) {
      expect(NotificationWithSourceSchema.parse(row)).toEqual({
        type: "notification",
        level: row.level,
        message: row.message,
      });
    }
  });

  test("agent snapshots carry the server queue, and old clients still parse them", () => {
    const snapshot = {
      id: "agent-1",
      provider: "claude",
      cwd: "/tmp/project",
      model: null,
      createdAt: "2026-10-04T00:00:00.000Z",
      updatedAt: "2026-10-04T00:00:00.000Z",
      lastUserMessageAt: null,
      status: "running",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: null,
      labels: {},
    };
    const queue = {
      held: true,
      heldReason: "restart",
      entries: [
        {
          id: "wake:agent-1:run-1:1",
          origin: "delegation_wake",
          senderAgentId: null,
          position: 2,
          textPreview: "Review finished",
          attachmentCount: 0,
          createdAt: "2026-10-04T00:00:01.000Z",
        },
        {
          id: "msg-1",
          origin: "user",
          senderAgentId: null,
          position: 1,
          textPreview: "next task",
          attachmentCount: 1,
          createdAt: "2026-10-04T00:00:00.000Z",
        },
      ],
    };
    expect(AgentSnapshotPayloadSchema.parse({ ...snapshot, queue }).queue).toEqual(queue);
    expect(AgentSnapshotPayloadSchema.parse(snapshot).queue).toBeUndefined();

    // Copied from v0.11.0-beta.3, before agent snapshots had a queue.
    const LegacySnapshotSchema = AgentSnapshotPayloadSchema.omit({ queue: true });
    expect(LegacySnapshotSchema.parse({ ...snapshot, queue })).not.toHaveProperty("queue");
  });

  test("agent snapshots carry how the last turn ended, and old clients still parse them", () => {
    const snapshot = {
      id: "agent-1",
      provider: "claude",
      cwd: "/tmp/project",
      model: null,
      createdAt: "2026-10-07T00:00:00.000Z",
      updatedAt: "2026-10-07T00:00:00.000Z",
      lastUserMessageAt: null,
      status: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: null,
      labels: {},
    };
    expect(
      AgentSnapshotPayloadSchema.parse({ ...snapshot, lastTurnOutcome: "canceled" })
        .lastTurnOutcome,
    ).toBe("canceled");
    expect(AgentSnapshotPayloadSchema.parse(snapshot).lastTurnOutcome).toBeUndefined();

    // Copied from v0.11.0-beta.3, before agent snapshots had a last turn outcome.
    const LegacySnapshotSchema = AgentSnapshotPayloadSchema.omit({ lastTurnOutcome: true });
    expect(
      LegacySnapshotSchema.parse({ ...snapshot, lastTurnOutcome: "canceled" }),
    ).not.toHaveProperty("lastTurnOutcome");
  });

  test("send responses carry the disposition, and old clients still parse them", () => {
    const response = {
      type: "send_agent_message_response",
      payload: {
        requestId: "request-1",
        agentId: "agent-1",
        accepted: true,
        error: null,
        disposition: "queued",
      },
    };
    expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);

    // Copied from v0.11.0-beta.3, before send responses had a disposition.
    const LegacySendResponseSchema = z.object({
      type: z.literal("send_agent_message_response"),
      payload: z.object({
        requestId: z.string(),
        agentId: z.string(),
        accepted: z.boolean(),
        error: z.string().nullable(),
      }),
    });
    expect(LegacySendResponseSchema.parse(response).payload).toEqual({
      requestId: "request-1",
      agentId: "agent-1",
      accepted: true,
      error: null,
    });
    const { disposition: _omitted, ...oldPayload } = response.payload;
    expect(SessionOutboundMessageSchema.parse({ ...response, payload: oldPayload })).toEqual({
      ...response,
      payload: oldPayload,
    });
  });

  test("queue RPC responses carry the queue after the operation", () => {
    const response = {
      type: "agent.queue.promote_to_steer.response",
      payload: {
        requestId: "request-1",
        agentId: "agent-1",
        accepted: true,
        error: null,
        queue: { held: false, heldReason: null, entries: [] },
        disposition: "steered",
      },
    };
    expect(SessionOutboundMessageSchema.parse(response)).toEqual(response);
  });

  test("server info advertises the server message queue as an optional feature", () => {
    const info = { status: "server_info", serverId: "srv", features: { serverMessageQueue: true } };
    expect(ServerInfoStatusPayloadSchema.parse(info).features?.serverMessageQueue).toBe(true);
  });

  test("daemon config carries the restart continuation setting only when the daemon has it", () => {
    const config = {
      relay: { enabled: false },
      mcp: { enabled: true, injectIntoAgents: false },
    };
    expect(MutableDaemonConfigSchema.parse(config).continueAfterRestart).toBeUndefined();
    expect(
      MutableDaemonConfigSchema.parse({ ...config, continueAfterRestart: true })
        .continueAfterRestart,
    ).toBe(true);
    expect(
      MutableDaemonConfigPatchSchema.parse({ continueAfterRestart: false }).continueAfterRestart,
    ).toBe(false);
    const info = {
      status: "server_info",
      serverId: "srv",
      features: { restartContinuation: true },
    };
    expect(ServerInfoStatusPayloadSchema.parse(info).features?.restartContinuation).toBe(true);
  });

  test("notification timeline items parse their level and message", () => {
    expect(
      AgentTimelineItemPayloadSchema.parse({
        type: "notification",
        level: "warning",
        message: "Command blocked by user",
      }),
    ).toEqual({
      type: "notification",
      level: "warning",
      message: "Command blocked by user",
    });
  });
});

test("0.8 timeline and setup capabilities remain optional in the hello", () => {
  const hello = { type: "hello", clientId: "compat", clientType: "mobile", protocolVersion: 1 };
  expect(WSHelloMessageSchema.safeParse(hello).success).toBe(true);
  expect(
    WSHelloMessageSchema.parse({
      ...hello,
      capabilities: { plugin_timeline_items: true, workspace_setup_blocked: true },
    }).capabilities,
  ).toEqual({ plugin_timeline_items: true, workspace_setup_blocked: true });
});

test("plugin rows and identity merges require a capable receiver", () => {
  const item = {
    type: "plugin",
    id: "task",
    pluginId: "tasks",
    kind: "tasks",
    version: 1,
    data: { text: "Working" },
  };
  expect(AgentTimelineItemPayloadSchema.parse(item)).toEqual(item);
  const legacyItems = z.object({
    type: z.enum([
      "user_message",
      "assistant_message",
      "reasoning",
      "tool_call",
      "todo",
      "error",
      "notification",
      "compaction",
    ]),
  });
  expect(legacyItems.safeParse(item).success).toBe(false);
  const entry = {
    provider: "codex",
    item,
    timestamp: "2026-09-07T00:00:00.000Z",
    seqStart: 1,
    seqEnd: 2,
    sourceSeqRanges: [{ startSeq: 1, endSeq: 2 }],
    collapsed: ["identity"],
  };
  expect(AgentTimelineEntryPayloadSchema.parse(entry)).toEqual(entry);
  const legacyCollapsed = z.array(z.enum(["assistant_merge", "reasoning_merge", "tool_lifecycle"]));
  expect(legacyCollapsed.safeParse(entry.collapsed).success).toBe(false);
});

test("blocked setup preserves the legacy failed shape and optional provenance", () => {
  const snapshot = {
    status: "blocked",
    error: null,
    detail: {
      type: "worktree_setup",
      worktreePath: "/workspace",
      branchName: "fork",
      log: "",
      commands: [],
    },
    blockedSource: {
      kind: "change_request",
      forge: "github",
      number: 42,
      headRepository: "contributor/project",
    },
  };
  expect(WorkspaceSetupSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  const legacyStatus = z.enum(["running", "completed", "failed"]);
  const legacySnapshot = WorkspaceSetupSnapshotSchema.omit({ blockedSource: true }).extend({
    status: legacyStatus,
  });
  expect(legacySnapshot.safeParse(snapshot).success).toBe(false);
  const failed = { ...snapshot, status: "failed", error: "Update Paseo to review and run setup." };
  expect(legacySnapshot.safeParse(failed).success).toBe(true);
  const progress = {
    type: "workspace_setup_progress",
    payload: { ...failed, workspaceId: "workspace" },
  };
  expect(WorkspaceSetupProgressMessageSchema.parse(progress)).toEqual(progress);
  expect(WorkspaceSetupSnapshotSchema.parse(legacySnapshot.parse(failed))).toEqual(
    legacySnapshot.parse(failed),
  );
});

test("quick prompts remain optional and survive config responses and patches", () => {
  const legacy = { mcp: { injectIntoAgents: false } };
  expect(MutableDaemonConfigSchema.parse(legacy).quickPrompts).toBeUndefined();
  expect(MutableDaemonConfigPatchSchema.parse({})).toEqual({});
  const quickPrompts = [
    {
      id: "summary",
      title: "Summary",
      text: "Summarize.",
      mode: "send",
      pinned: true,
      isDefault: true,
    },
  ];
  const current = { ...legacy, quickPrompts, quickPromptUndoMs: 2500 };
  expect(MutableDaemonConfigSchema.parse(current).quickPrompts).toEqual(quickPrompts);
  expect(MutableDaemonConfigPatchSchema.parse({ quickPrompts, quickPromptUndoMs: 0 })).toEqual({
    quickPrompts,
    quickPromptUndoMs: 0,
  });
  const oldConfigSchema = MutableDaemonConfigSchema.omit({
    quickPrompts: true,
    quickPromptUndoMs: true,
  });
  expect(oldConfigSchema.safeParse(current).success).toBe(true);
  expect(MutableDaemonConfigPatchSchema.safeParse({ quickPromptUndoMs: -1 }).success).toBe(false);
});

test("the dictionary is optional in config responses and patches", () => {
  const legacy = { mcp: { injectIntoAgents: false } };
  expect(MutableDaemonConfigSchema.parse(legacy).dictionary).toBeUndefined();
  const dictionary = { words: ["Zentrix"], replacements: [{ from: "Hello", to: "Jelou" }] };
  const current = { ...legacy, dictionary };
  expect(MutableDaemonConfigSchema.parse(current).dictionary).toEqual(dictionary);
  expect(MutableDaemonConfigPatchSchema.parse({ dictionary })).toEqual({ dictionary });
  const oldConfigSchema = MutableDaemonConfigSchema.omit({ dictionary: true });
  expect(oldConfigSchema.safeParse(current).success).toBe(true);
  const legacyInfo = { status: "server_info", serverId: "host", features: { voiceFleet: true } };
  expect(ServerInfoStatusPayloadSchema.parse(legacyInfo).features?.dictionary).toBeUndefined();
});

test("voice commands settings stay readable as they grow", () => {
  const legacyInfo = { status: "server_info", serverId: "host", features: { dictionary: true } };
  expect(ServerInfoStatusPayloadSchema.parse(legacyInfo).features?.voiceCommands).toBeUndefined();
  const settings = {
    selection: { provider: "cerebras", model: "qwen-3.8-27b" },
    backup: null,
    active: { provider: "cerebras", model: "qwen-3.8-27b" },
    lastRoundTripMs: 312,
    providers: [{ id: "cerebras", label: "Cerebras", hasKey: true, region: "us" }],
    options: [{ provider: "cerebras", model: "qwen-3.8-27b", label: "Qwen 3.8 27B", tier: "fast" }],
    futureField: true,
  };
  expect(VoiceCommandsSettingsSchema.parse(settings)).toEqual(settings);
});

test("quick prompt capability is optional and discarded by older feature schemas", () => {
  const legacy = { status: "server_info", serverId: "host" };
  expect(ServerInfoStatusPayloadSchema.safeParse(legacy).success).toBe(true);
  const current = { ...legacy, features: { quickPrompts: true } };
  expect(ServerInfoStatusPayloadSchema.parse(current).features?.quickPrompts).toBe(true);
  const oldFeatures = z.object({ agentProfiles: z.boolean().optional() });
  expect(oldFeatures.parse(current.features)).toEqual({});
});

test("quick prompt validation permits localized client messages without changing wire parsing", () => {
  const prompt = {
    id: "a",
    title: "A",
    text: "text",
    mode: "send" as const,
    pinned: false,
    isDefault: false,
  };
  const messages = {
    duplicateIds: "identificadores únicos",
    multipleDefaults: "un predeterminado",
    pinLimit: "tres fijados",
    required: "título y texto",
  };
  expect(() => validateQuickPrompts([prompt, prompt], messages)).toThrow(messages.duplicateIds);
  expect(() =>
    validateQuickPrompts(
      [
        { ...prompt, isDefault: true },
        { ...prompt, id: "b", isDefault: true },
      ],
      messages,
    ),
  ).toThrow(messages.multipleDefaults);
  expect(() =>
    validateQuickPrompts(
      ["a", "b", "c", "d"].map((id) => Object.assign({}, prompt, { id, pinned: true })),
      messages,
    ),
  ).toThrow(messages.pinLimit);
  expect(() => validateQuickPrompts([{ ...prompt, text: " " }], messages)).toThrow(
    messages.required,
  );
});

test("usage login errors are additive and older reports still parse", () => {
  const entry = {
    id: "codex:account",
    account: {},
    fetchedAt: "2026-10-05T00:00:00.000Z",
    sourceId: "codex",
    sourceLabel: "Codex",
    report: { status: "error", error: "Usage API returned 500" },
  };
  const legacy = z.object({
    type: z.literal("usage.list_reports.update"),
    payload: z.object({
      requestId: z.string(),
      report: z.object({
        id: z.string(),
        account: z.object({ label: z.string().optional() }),
        fetchedAt: z.string(),
        sourceId: z.string(),
        sourceLabel: z.string(),
        icon: z.string().optional(),
        report: z.discriminatedUnion("status", [
          z.object({ status: z.literal("available"), windows: z.array(z.unknown()) }),
          z.object({ status: z.literal("unavailable"), problem: z.unknown() }),
          z.object({ status: z.literal("error"), error: z.string() }),
        ]),
      }),
    }),
  });
  const oldMessage = {
    type: "usage.list_reports.update",
    payload: { requestId: "usage", report: entry },
  };
  const newMessage = {
    ...oldMessage,
    payload: {
      ...oldMessage.payload,
      report: {
        ...entry,
        loginErrors: [{ harness: "Codex", report: entry.report }],
      },
    },
  };
  expect(SessionOutboundMessageSchema.parse(oldMessage)).toEqual(oldMessage);
  expect(SessionOutboundMessageSchema.parse(newMessage)).toEqual(newMessage);
  expect(legacy.parse(newMessage)).toEqual(oldMessage);
});
