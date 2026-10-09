import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
  AgentSnapshotPayloadSchema,
  AgentTimelineItemPayloadSchema,
  ServerInfoStatusPayloadSchema,
  SessionOutboundMessageSchema,
  WSHelloMessageSchema,
  WorkspaceSetupSnapshotSchema,
  WorkspaceSetupProgressMessageSchema,
  AgentTimelineEntryPayloadSchema,
  MutableDaemonConfigPatchSchema,
  MutableDaemonConfigSchema,
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

  test("provider switch dividers and retired-history rows are notification sources", () => {
    const divider = {
      type: "notification",
      level: "info",
      message: "Switched from claude to codex",
      source: {
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
      source: {
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
      source: {
        kind: "incarnation",
        segmentId: "seg-b",
        incarnationId: "inc-b2",
        reason: "uncertain_delivery",
      },
    };
    expect(AgentTimelineItemPayloadSchema.parse(marker)).toEqual(marker);
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
