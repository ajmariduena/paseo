import { describe, expect, it } from "vitest";
import { formatPeerMessage } from "@getpaseo/protocol/peer-message";
import type { AgentTimelineItem, ToolCallDetail } from "../../agent/agent-sdk-types.js";
import {
  buildAgentDigest,
  condenseTurn,
  formatDigestLine,
  type DigestAgentInput,
} from "./agent-digest.js";

const NOW = Date.parse("2026-10-09T14:00:00.000Z");

function agent(overrides: Partial<DigestAgentInput> = {}): DigestAgentInput {
  return {
    id: "agent-upstream",
    title: "Upstream",
    provider: "codex",
    workspaceId: "workspace-upstream",
    workspace: "Integración",
    projectId: "project-paseo",
    lifecycle: "running",
    pendingPermissions: [],
    lastError: null,
    finishedUnreviewed: false,
    activeTurnStartedAt: new Date(NOW - 120_000),
    updatedAt: new Date(NOW - 10_000),
    unheard: false,
    ...overrides,
  };
}

function tool(
  detail: ToolCallDetail,
  status: "completed" | "running" = "completed",
): AgentTimelineItem {
  return { type: "tool_call", callId: "tool-1", name: detail.type, detail, status, error: null };
}

describe("buildAgentDigest", () => {
  it("describes the current request, progress and observed work without reasoning or raw output", () => {
    const result = buildAgentDigest({
      agent: agent(),
      now: NOW,
      timeline: [
        { type: "user_message", text: "Revisa el upgrade de Paseo, sin publicar." },
        { type: "reasoning", text: "PRIVATE_REASONING" },
        {
          type: "todo",
          items: [
            { text: "Integrar", completed: true, status: "completed" },
            {
              text: "Probar",
              activeForm: "Probando integración",
              completed: false,
              status: "in_progress",
            },
          ],
        },
        tool({ type: "edit", filePath: "/work/paseo/login.ts", newString: "PRIVATE_CODE" }),
        tool({ type: "shell", command: "npm test", output: "PRIVATE_OUTPUT", exitCode: 0 }),
        { type: "assistant_message", text: "Ya integré los cambios. Estoy revisando las pruebas." },
      ],
    });

    expect(result).toEqual({
      agentId: "agent-upstream",
      title: "Upstream",
      workspaceId: "workspace-upstream",
      workspace: "Integración",
      projectId: "project-paseo",
      provider: "codex",
      status: "working",
      statusForMs: 120_000,
      task: "Revisa el upgrade de Paseo, sin publicar.",
      now: "Probando integración; latest note: Ya integré los cambios. Estoy revisando las pruebas.",
      progress: "1 of 2 steps done",
      activity: "edited 1 file (login.ts); ran 1 command (latest: npm test)",
      blocker: null,
      permissionId: null,
      outcome: null,
      summary: null,
      unheard: false,
      updatedAt: "2026-10-09T13:59:50.000Z",
    });
  });

  it("starts the digest at the last real user request, ignoring system and peer notes", () => {
    const result = buildAgentDigest({
      agent: agent({ lifecycle: "idle", finishedUnreviewed: true, unheard: true }),
      now: NOW,
      timeline: [
        { type: "user_message", text: "Corrige el login." },
        tool({ type: "edit", filePath: "/work/login.ts" }),
        { type: "user_message", text: "Ahora revisa Bluetooth." },
        { type: "user_message", text: "<paseo-system>\nSigue trabajando.\n</paseo-system>" },
        {
          type: "user_message",
          text: formatPeerMessage({ sender: { agentId: "peer" }, body: "Mi revisión terminó." }),
        },
        { type: "assistant_message", text: "La revisión terminó. " },
        { type: "assistant_message", text: "Falta probar en el teléfono." },
      ],
    });

    expect(result.task).toBe("Ahora revisa Bluetooth.");
    expect(result.activity).toBe(null);
    expect(result.status).toBe("finished_unreviewed");
    expect(result.now).toBe(null);
    expect(result.outcome).toBe("La revisión terminó. Falta probar en el teléfono.");
    expect(result.unheard).toBe(true);
  });

  it("prioritizes a pending permission and reports the exact requested command", () => {
    const result = buildAgentDigest({
      agent: agent({
        pendingPermissions: [
          {
            id: "permission-1",
            provider: "codex",
            kind: "tool",
            name: "shell",
            detail: { type: "shell", command: "git push origin mejora-audio" },
          },
        ],
      }),
      timeline: [],
      now: NOW,
    });

    expect(result.status).toBe("waiting_permission");
    expect(result.blocker).toBe("permission: run git push origin mejora-audio");
    expect(result.outcome).toBe(null);
  });

  it("reports a failure without inventing a completed result", () => {
    const result = buildAgentDigest({
      agent: agent({ lifecycle: "error", lastError: "Falló `npm test`." }),
      timeline: [],
      now: NOW,
    });
    expect(result.status).toBe("failed");
    expect(result.blocker).toBe("error: Falló npm test.");
    expect(result.outcome).toBe(null);
  });

  it("uses a running tool when the progress note is older than the recent activity", () => {
    const reads = Array.from({ length: 6 }, (_, index) =>
      tool({ type: "read", filePath: `/work/file-${index}.ts` }),
    );
    const result = buildAgentDigest({
      agent: agent(),
      now: NOW,
      timeline: [
        { type: "user_message", text: "Revisa el fallo." },
        { type: "assistant_message", text: "Voy a leer el README." },
        ...reads,
        tool({ type: "shell", command: "npm test", output: "PRIVATE_OUTPUT" }, "running"),
      ],
    });

    expect(result.now).toBe("running npm test");
    expect(result.outcome).toBe(null);
  });

  it("reports a nonzero shell exit and avoids negative durations", () => {
    const result = buildAgentDigest({
      agent: agent({ activeTurnStartedAt: new Date(NOW + 1_000) }),
      now: NOW,
      timeline: [tool({ type: "shell", command: "npm test", exitCode: 1 })],
    });
    expect(result.activity).toBe("ran 1 command, 1 failed (latest: npm test)");
    expect(result.statusForMs).toBe(0);
  });
});

describe("formatDigestLine", () => {
  it("keeps host, task, blocker and unheard state when a semantic summary is available", () => {
    const digest = buildAgentDigest({
      agent: agent({ unheard: true }),
      now: NOW,
      timeline: [{ type: "user_message", text: "Revisar audio." }],
      summary: "Falta Bluetooth.",
    });
    expect(
      formatDigestLine(
        {
          ...digest,
          blocker: "permission: git push",
          now: "Raw current step",
          outcome: "Raw outcome",
        },
        { host: "Mini" },
      ),
    ).toBe(
      'Mini · Integración · "Upstream" (codex) — working for 2 min | summary: Falta Bluetooth. | permission: git push | task: Revisar audio. | NOT YET TOLD TO THE USER',
    );
  });

  it("keeps finished distinct from reviewed or published", () => {
    const digest = buildAgentDigest({
      agent: agent({ lifecycle: "idle", finishedUnreviewed: true }),
      timeline: [],
      now: NOW,
    });
    expect(formatDigestLine(digest)).toBe(
      'Integración · "Upstream" (codex) — finished less than a minute ago, not reviewed',
    );
  });
});

describe("condenseTurn", () => {
  it("bounds recent log lines while retaining the request and final answer", () => {
    const timeline: AgentTimelineItem[] = [
      { type: "user_message", text: "Revisa las pruebas." },
      { type: "reasoning", text: "PRIVATE_REASONING" },
      tool({ type: "read", filePath: "/work/spec.ts", content: "PRIVATE_FILE" }),
      tool({ type: "read", filePath: "/work/spec.ts", content: "PRIVATE_FILE" }),
      tool({ type: "shell", command: "npm test", output: "PRIVATE_OUTPUT" }),
      { type: "assistant_message", text: "Las pruebas pasaron." },
    ];
    expect(condenseTurn(timeline, 3)).toEqual({
      request: "Revisa las pruebas.",
      lines: ["reading spec.ts", "running npm test", "said: Las pruebas pasaron."],
      finalMessage: "Las pruebas pasaron.",
    });
    expect(condenseTurn(timeline, 1)).toEqual({
      request: "Revisa las pruebas.",
      lines: ["said: Las pruebas pasaron."],
      finalMessage: "Las pruebas pasaron.",
    });
  });

  it("retains failed operations and plan progress without raw errors or code", () => {
    expect(
      condenseTurn(
        [
          { type: "user_message", text: "Revisar." },
          {
            type: "todo",
            items: [
              { text: "Leer", completed: true },
              { text: "Probar", completed: false },
            ],
          },
          {
            type: "tool_call",
            callId: "failed",
            name: "shell",
            detail: { type: "shell", command: "npm test", output: "PRIVATE_OUTPUT" },
            status: "failed",
            error: { private: "PRIVATE_ERROR" },
          },
          { type: "error", message: "No se pudo completar." },
        ],
        10,
      ),
    ).toEqual({
      request: "Revisar.",
      lines: [
        "plan: [x] Leer; [ ] Probar",
        "running npm test (failed)",
        "error: No se pudo completar.",
      ],
      finalMessage: null,
    });
  });
});
