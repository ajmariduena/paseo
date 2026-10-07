import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import { buildWorkspaceAgentActivityIndex } from "./workspace-agent-activity";

function agent(input: {
  id: string;
  workspaceId?: string;
  status?: Agent["status"];
  turn?: Agent["turn"];
  updatedAt: string;
  attentionTimestamp?: string | null;
  requiresAttention?: boolean;
  attentionReason?: Agent["attentionReason"];
  pendingPermissionCount?: number;
  archivedAt?: string | null;
  parentAgentId?: string | null;
  backgroundTasks?: Agent["backgroundTasks"];
}): Agent {
  return {
    serverId: "host-a",
    id: input.id,
    provider: "codex",
    status: input.status ?? "idle",
    turn:
      input.turn ??
      (input.status === "running"
        ? {
            phase: "open",
            turnId: "turn-1",
            startedAt: null,
            cancellationRequestId: null,
          }
        : { phase: "idle", cancellationRequestId: null }),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date(input.updatedAt),
    lastUserMessageAt: null,
    lastActivityAt: new Date(input.updatedAt),
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
    pendingPermissions: Array.from({ length: input.pendingPermissionCount ?? 0 }, (_, index) => ({
      id: `permission-${index}`,
      provider: "codex",
      name: "shell",
      kind: "tool",
      input: {},
    })),
    persistence: null,
    title: null,
    cwd: "/repo",
    workspaceId: input.workspaceId,
    model: null,
    requiresAttention: input.requiresAttention,
    attentionReason: input.attentionReason,
    attentionTimestamp: input.attentionTimestamp ? new Date(input.attentionTimestamp) : null,
    archivedAt: input.archivedAt ? new Date(input.archivedAt) : null,
    parentAgentId: input.parentAgentId ?? null,
    labels: {},
    backgroundTasks: input.backgroundTasks,
  };
}

describe("workspace agent activity index", () => {
  it("shows an idle agent with live background tasks as background", () => {
    const backgroundTasks = [
      {
        id: "task-1",
        taskType: "local_bash",
        description: "Watch canary run",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const result = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "watching",
          agent({
            id: "watching",
            workspaceId: "workspace-watching",
            updatedAt: "2026-01-01T00:00:00.000Z",
            backgroundTasks,
          }),
        ],
        [
          "quiet",
          agent({
            id: "quiet",
            workspaceId: "workspace-quiet",
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        ],
      ]),
    );

    expect(result.get("workspace-watching")?.status).toBe("background");
    expect(result.get("workspace-watching")?.backgroundTasks).toEqual(backgroundTasks);
    expect(result.get("workspace-quiet")?.status).toBe("done");
    expect(result.get("workspace-quiet")?.backgroundTasks).toEqual([]);
  });

  it("files an idle agent watching a pull request under background until it asks for attention", () => {
    const backgroundTasks = [
      {
        id: "pull-request-watch:w1",
        taskType: "pull_request_watch",
        description: "Watching PR #9 · 2 checks running",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const result = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "watching",
          agent({
            id: "watching",
            workspaceId: "workspace-watching",
            updatedAt: "2026-01-01T00:00:00.000Z",
            backgroundTasks,
          }),
        ],
        [
          "handed-back",
          agent({
            id: "handed-back",
            workspaceId: "workspace-handed-back",
            updatedAt: "2026-01-01T00:00:00.000Z",
            requiresAttention: true,
            attentionReason: "finished",
            attentionTimestamp: "2026-01-01T00:01:00.000Z",
            backgroundTasks,
          }),
        ],
      ]),
    );

    expect(result.get("workspace-watching")?.status).toBe("background");
    expect(result.get("workspace-handed-back")?.status).toBe("attention");
  });

  it("keeps working and unread agents in their own bucket while carrying their tasks", () => {
    const backgroundTasks = [
      {
        id: "task-1",
        taskType: "local_bash",
        description: "npm run dev",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const result = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "thinking",
          agent({
            id: "thinking",
            workspaceId: "workspace-thinking",
            status: "running",
            updatedAt: "2026-01-01T00:00:00.000Z",
            backgroundTasks,
          }),
        ],
        [
          "unread",
          agent({
            id: "unread",
            workspaceId: "workspace-unread",
            updatedAt: "2026-01-01T00:00:00.000Z",
            requiresAttention: true,
            attentionReason: "finished",
            backgroundTasks,
          }),
        ],
      ]),
    );

    expect(result.get("workspace-thinking")?.status).toBe("running");
    expect(result.get("workspace-thinking")?.backgroundTasks).toEqual(backgroundTasks);
    expect(result.get("workspace-unread")?.status).toBe("attention");
    expect(result.get("workspace-unread")?.backgroundTasks).toEqual(backgroundTasks);
  });

  it("collects background tasks from every root agent in the workspace", () => {
    const result = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "older",
          agent({
            id: "older",
            workspaceId: "workspace-shared",
            updatedAt: "2026-01-01T00:00:00.000Z",
            backgroundTasks: [
              {
                id: "task-1",
                taskType: "local_bash",
                description: "npm run dev",
                startedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          }),
        ],
        [
          "latest",
          agent({
            id: "latest",
            workspaceId: "workspace-shared",
            updatedAt: "2026-01-02T00:00:00.000Z",
          }),
        ],
      ]),
    );

    expect(result.get("workspace-shared")?.agentId).toBe("latest");
    expect(result.get("workspace-shared")?.status).toBe("background");
    expect(result.get("workspace-shared")?.backgroundTasks.map((task) => task.id)).toEqual([
      "task-1",
    ]);
  });

  it("uses turn liveness for running while preserving protocol lifecycle states", () => {
    const result = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "open",
          agent({
            id: "open",
            workspaceId: "workspace-open",
            status: "idle",
            turn: {
              phase: "open",
              turnId: null,
              startedAt: null,
              cancellationRequestId: null,
            },
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        ],
        [
          "idle-error",
          agent({
            id: "idle-error",
            workspaceId: "workspace-error",
            status: "error",
            turn: { phase: "idle", cancellationRequestId: null },
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
        ],
      ]),
    );

    expect(result.get("workspace-open")?.status).toBe("running");
    expect(result.get("workspace-error")?.status).toBe("failed");
  });

  it("keeps the latest active root agent for each workspace", () => {
    const index = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "older",
          agent({
            id: "older",
            workspaceId: "workspace-a",
            status: "running",
            updatedAt: "2026-06-01T10:00:00.000Z",
          }),
        ],
        [
          "permission",
          agent({
            id: "permission",
            workspaceId: "workspace-a",
            updatedAt: "2026-06-01T10:01:00.000Z",
            pendingPermissionCount: 1,
          }),
        ],
        [
          "attention",
          agent({
            id: "attention",
            workspaceId: "workspace-b",
            updatedAt: "2026-06-01T10:00:00.000Z",
            attentionTimestamp: "2026-06-01T10:02:00.000Z",
            requiresAttention: true,
            attentionReason: "finished",
          }),
        ],
      ]),
    );

    expect(index).toEqual(
      new Map([
        [
          "workspace-a",
          {
            agentId: "permission",
            status: "needs_input",
            enteredAt: new Date("2026-06-01T10:01:00.000Z"),
            backgroundTasks: [],
          },
        ],
        [
          "workspace-b",
          {
            agentId: "attention",
            status: "attention",
            enteredAt: new Date("2026-06-01T10:02:00.000Z"),
            backgroundTasks: [],
          },
        ],
      ]),
    );
  });

  it("does not let archived or child agents change root workspace activity", () => {
    const index = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "root",
          agent({
            id: "root",
            workspaceId: "workspace-a",
            status: "running",
            updatedAt: "2026-06-01T10:00:00.000Z",
          }),
        ],
        [
          "child",
          agent({
            id: "child",
            workspaceId: "workspace-a",
            updatedAt: "2026-06-01T10:03:00.000Z",
            pendingPermissionCount: 1,
            parentAgentId: "root",
          }),
        ],
        [
          "archived",
          agent({
            id: "archived",
            workspaceId: "workspace-a",
            updatedAt: "2026-06-01T10:04:00.000Z",
            requiresAttention: true,
            attentionReason: "error",
            archivedAt: "2026-06-01T10:04:00.000Z",
          }),
        ],
      ]),
    );

    expect(index.get("workspace-a")).toEqual({
      agentId: "root",
      status: "running",
      enteredAt: new Date("2026-06-01T10:00:00.000Z"),
      backgroundTasks: [],
    });
  });

  it("treats a cross-workspace subagent as activity in its own workspace", () => {
    const index = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "parent",
          agent({
            id: "parent",
            workspaceId: "workspace-a",
            updatedAt: "2026-06-01T10:00:00.000Z",
          }),
        ],
        [
          "child",
          agent({
            id: "child",
            workspaceId: "workspace-b",
            status: "running",
            updatedAt: "2026-06-01T10:03:00.000Z",
            parentAgentId: "parent",
          }),
        ],
      ]),
    );

    expect(index).toEqual(
      new Map([
        [
          "workspace-a",
          {
            agentId: "parent",
            status: "done",
            enteredAt: new Date("2026-06-01T10:00:00.000Z"),
            backgroundTasks: [],
          },
        ],
        [
          "workspace-b",
          {
            agentId: "child",
            status: "running",
            enteredAt: new Date("2026-06-01T10:03:00.000Z"),
            backgroundTasks: [],
          },
        ],
      ]),
    );
  });

  it("preserves the activity index while the same agent remains in the same status", () => {
    const previous = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "root",
          agent({
            id: "root",
            workspaceId: "workspace-a",
            status: "running",
            updatedAt: "2026-06-01T10:00:00.000Z",
          }),
        ],
      ]),
    );

    const next = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "root",
          agent({
            id: "root",
            workspaceId: "workspace-a",
            status: "running",
            updatedAt: "2026-06-01T10:05:00.000Z",
          }),
        ],
      ]),
      previous,
    );

    expect(next).toBe(previous);
    expect(next.get("workspace-a")?.enteredAt).toEqual(new Date("2026-06-01T10:00:00.000Z"));
  });

  it("records a new entry time when an agent changes status", () => {
    const previous = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "root",
          agent({
            id: "root",
            workspaceId: "workspace-a",
            status: "running",
            updatedAt: "2026-06-01T10:00:00.000Z",
          }),
        ],
      ]),
    );

    const next = buildWorkspaceAgentActivityIndex(
      new Map([
        [
          "root",
          agent({
            id: "root",
            workspaceId: "workspace-a",
            status: "idle",
            updatedAt: "2026-06-01T10:05:00.000Z",
            pendingPermissionCount: 1,
          }),
        ],
      ]),
      previous,
    );

    expect(next).not.toBe(previous);
    expect(next.get("workspace-a")).toEqual({
      agentId: "root",
      status: "needs_input",
      enteredAt: new Date("2026-06-01T10:05:00.000Z"),
      backgroundTasks: [],
    });
  });
});
