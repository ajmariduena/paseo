import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { VoiceFleetAgent } from "@getpaseo/protocol/voice-fleet/types";
import { FleetView, type FleetHost } from "../fleet/fleet-view.js";
import { FastLlmClient, type FastLlmCompletion } from "./llm-client.js";
import { VoiceRouter, type RouteInput, type RouterExecutor } from "./router.js";

const logger = pino({ level: "silent" });
const NOW = Date.parse("2026-10-09T14:00:00.000Z");
type CompletionInput = Parameters<FastLlmClient["complete"]>[0];

// A typed completion adapter: no HTTP, fake timers, globals or module replacements.
class ScriptedLlmClient extends FastLlmClient {
  readonly requests: CompletionInput[] = [];

  constructor(private readonly replies: FastLlmCompletion[]) {
    super(
      {
        provider: "test",
        baseUrl: "https://unused.test/v1",
        apiKey: "unused",
        model: "test",
        reasoningEffort: null,
      },
      logger,
    );
  }

  override async complete(request: CompletionInput): Promise<FastLlmCompletion> {
    this.requests.push(structuredClone(request));
    const reply = this.replies.shift();
    if (!reply) throw new Error("Unexpected model request");
    return reply;
  }
}

function answer(content: string): FastLlmCompletion {
  return { content, toolCalls: [], elapsedMs: 1, usage: null };
}

function action(name: string, args: Record<string, unknown>): FastLlmCompletion {
  return {
    ...answer(""),
    toolCalls: [
      { id: "tool-1", type: "function", function: { name, arguments: JSON.stringify(args) } },
    ],
  };
}

function agent(id = "agent-upstream", overrides: Partial<VoiceFleetAgent> = {}): VoiceFleetAgent {
  return {
    agentId: id,
    title: "Upstream",
    provider: "codex",
    workspaceId: "workspace-upstream",
    workspace: "Paseo",
    status: "working",
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function host(
  agents: VoiceFleetAgent[] = [agent()],
  overrides: Partial<FleetHost> = {},
): FleetHost {
  return {
    serverId: null,
    label: "Portátil",
    online: true,
    lastSeenAt: null,
    supportsTools: true,
    digest: {
      generatedAt: new Date(NOW).toISOString(),
      agents,
      projects: [],
      workspaces: [],
      sessions: [],
    },
    ...overrides,
  };
}

function input(view: FleetView, latest: string, overrides: Partial<RouteInput> = {}): RouteInput {
  return { view, latest, conversation: [], language: "es", audience: "voice-model", ...overrides };
}

const clients: ScriptedLlmClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
});

function setup(replies: FastLlmCompletion[]) {
  const llm = new ScriptedLlmClient(replies);
  clients.push(llm);
  const executions: Parameters<RouterExecutor["execute"]>[0][] = [];
  const escalations: string[] = [];
  let now = NOW;
  const router = new VoiceRouter({
    llm,
    logger,
    now: () => now,
    executor: {
      execute: async (request) => {
        executions.push(request);
        return { ok: true, text: "La acción terminó." };
      },
      escalate: async (request) => {
        escalations.push(request);
        return "Encargo recibido.";
      },
    },
  });
  return {
    llm,
    executions,
    escalations,
    router,
    setNow(value: number) {
      now = value;
    },
  };
}

describe("VoiceRouter confirmations", () => {
  it("asks before archiving and executes the exact challenged target on a short yes without another model call", async () => {
    const state = setup([action("archive", { target: "a1" })]);
    const view = new FleetView([host()], NOW);
    const asked = await state.router.route(input(view, "Archiva Upstream."));
    expect(asked.kind).toBe("confirm");
    expect(state.executions).toEqual([]);
    expect(state.router.hasPendingConfirmation).toBe(true);

    const reordered = new FleetView(
      [host([agent("another", { status: "waiting_permission" }), agent()])],
      NOW,
    );
    const done = await state.router.route(input(reordered, "Sí, dale."));
    expect(done.kind).toBe("action");
    expect(done.timings.confirmed).toBe(1);
    expect(state.executions.map(({ tool, args }) => ({ tool, args }))).toEqual([
      { tool: "archive_agent", args: { agentId: "agent-upstream" } },
    ]);
    expect(state.llm.requests).toHaveLength(1);
    expect(state.router.hasPendingConfirmation).toBe(false);
  });

  it("cancels on a short no without consulting the model or running an action", async () => {
    const state = setup([action("archive", { target: "a1" })]);
    const view = new FleetView([host()], NOW);
    await state.router.route(input(view, "Archiva Upstream."));
    const denied = await state.router.route(input(view, "No, déjalo."));
    expect(denied.kind).toBe("answer");
    expect(denied.text).toContain("cancelled");
    expect(state.executions).toEqual([]);
    expect(state.llm.requests).toHaveLength(1);
    expect(state.router.hasPendingConfirmation).toBe(false);
  });

  it("does not reuse an expired challenge", async () => {
    const state = setup([
      action("archive", { target: "a1" }),
      answer("¿Qué acción quieres confirmar?"),
    ]);
    const view = new FleetView([host()], NOW);
    await state.router.route(input(view, "Archiva Upstream."));
    state.setNow(NOW + 120_001);
    const result = await state.router.route(input(view, "Sí."));
    expect(result.kind).toBe("question");
    expect(state.executions).toEqual([]);
    expect(state.llm.requests).toHaveLength(2);
  });

  it.each(["Dale si es seguro.", "¿Lo apruebo?", "Sí, solo si funciona."])(
    "does not accept a conditional or questioned permission: %s",
    async (latest) => {
      const state = setup([action("answer_permission", { agent: "a1", decision: "allow" })]);
      const view = new FleetView(
        [host([agent("agent-upstream", { status: "waiting_permission", blocker: "git push" })])],
        NOW,
      );
      expect((await state.router.route(input(view, latest))).kind).toBe("confirm");
      expect(state.executions).toEqual([]);
    },
  );

  it("accepts an explicit unconditioned permission approval", async () => {
    const state = setup([action("answer_permission", { agent: "a1", decision: "allow" })]);
    const view = new FleetView(
      [host([agent("agent-upstream", { status: "waiting_permission", blocker: "git push" })])],
      NOW,
    );
    expect((await state.router.route(input(view, "Sí, aprueba ese push."))).kind).toBe("action");
    expect(state.executions[0]).toMatchObject({
      tool: "answer_permission",
      args: { agentId: "agent-upstream", allow: true },
    });
  });

  it("never treats a short conditional yes as confirmation of an existing challenge", async () => {
    const state = setup([
      action("archive", { target: "a1" }),
      answer("¿Confirmas que lo archive?"),
    ]);
    const view = new FleetView([host()], NOW);
    await state.router.route(input(view, "Archiva Upstream."));
    const result = await state.router.route(input(view, "Dale si es seguro."));
    expect(state.executions).toEqual([]);
    expect(result.kind).toBe("question");
    expect(state.llm.requests).toHaveLength(2);
  });
});

describe("VoiceRouter targets and speculative plans", () => {
  it("reuses a plan with the view that assigned its refs, never the reordered view", async () => {
    const state = setup([
      action("send_message", { agent: "a1", message: "Primero Bluetooth, sin publicar." }),
    ]);
    const original = input(
      new FleetView([host([agent("original")])], NOW),
      "Dile que revise Bluetooth.",
    );
    const plan = state.router.plan(original);
    expect(state.executions).toEqual([]);
    const current = input(new FleetView([host([agent("different")])], NOW), original.latest);
    const result = await state.router.route(current, plan);
    expect(result.timings.planReused).toBe(1);
    expect(state.llm.requests).toHaveLength(1);
    expect(state.executions[0]?.args).toMatchObject({
      agentId: "original",
      message: "Primero Bluetooth, sin publicar.",
    });
  });

  it("does not reuse a plan when the request changes", async () => {
    const state = setup([
      action("send_message", { agent: "a1", message: "Antiguo" }),
      answer("No se envió nada."),
    ]);
    const view = new FleetView([host()], NOW);
    const plan = state.router.plan(input(view, "Envía el mensaje."));
    const result = await state.router.route(input(view, "Espera, no lo envíes."), plan);
    expect(result.timings.planReused).toBe(0);
    expect(state.executions).toEqual([]);
    expect(state.llm.requests).toHaveLength(2);
  });

  it("rejects an offline target without calling the executor", async () => {
    const state = setup([action("send_message", { agent: "a1", message: "Revisa el audio." })]);
    const view = new FleetView(
      [host([], {}), host([agent()], { serverId: "mini", label: "Mini", online: false })],
      NOW,
    );
    const result = await state.router.route(input(view, "Dile al Mini que revise audio."));
    expect(result.kind).toBe("failed");
    expect(result.text).toContain("Mini is offline");
    expect(state.executions).toEqual([]);
  });

  it("rejects a remote host that cannot execute voice tools", async () => {
    const state = setup([action("send_message", { agent: "a1", message: "Revisa el audio." })]);
    const view = new FleetView(
      [host([], {}), host([agent()], { serverId: "mini", label: "Mini", supportsTools: false })],
      NOW,
    );
    const result = await state.router.route(input(view, "Revisa audio en el Mini."));
    expect(result.kind).toBe("failed");
    expect(result.text).toContain("update it");
    expect(state.executions).toEqual([]);
  });

  it("does not reuse a plan after its conversational referent changes at the same history length", async () => {
    const state = setup([
      action("send_message", { agent: "a1", message: "Antiguo destino" }),
      action("send_message", { agent: "a2", message: "Destino corregido" }),
    ]);
    const view = new FleetView([host([agent("first"), agent("second", { title: "Voz" })])], NOW);
    const plan = state.router.plan(
      input(view, "Dile que siga.", { conversation: ["User: Hablamos de Upstream."] }),
    );
    const result = await state.router.route(
      input(view, "Dile que siga.", { conversation: ["User: Hablamos de Voz."] }),
      plan,
    );
    expect(result.timings.planReused).toBe(0);
    expect(state.executions[0]?.args.agentId).toBe("second");
  });

  it("rechecks reachability when a host goes offline after a plan was prepared", async () => {
    const state = setup([action("send_message", { agent: "a1", message: "Revisa audio." })]);
    const online = host([agent()], { serverId: "mini", label: "Mini" });
    const original = input(
      new FleetView([host([]), online], NOW),
      "Dile al Mini que revise audio.",
    );
    const plan = state.router.plan(original);
    const current = input(
      new FleetView([host([]), { ...online, online: false }], NOW),
      original.latest,
    );
    const result = await state.router.route(current, plan);
    expect(result.kind).toBe("failed");
    expect(state.executions).toEqual([]);
  });

  it("rechecks reachability before executing a confirmed destructive action", async () => {
    const state = setup([action("archive", { target: "a1" })]);
    const online = host([agent()], { serverId: "mini", label: "Mini" });
    await state.router.route(
      input(new FleetView([host([]), online], NOW), "Archiva Upstream del Mini."),
    );
    const result = await state.router.route(
      input(new FleetView([host([]), { ...online, online: false }], NOW), "Sí, dale."),
    );
    expect(result.kind).toBe("failed");
    expect(state.executions).toEqual([]);
  });

  it("does not announce success when every proposed tool call has invalid arguments", async () => {
    const state = setup(
      Array.from({ length: 3 }, () =>
        action("send_message", { agent: "a999", message: "Revisa." }),
      ),
    );
    const result = await state.router.route(
      input(new FleetView([host()], NOW), "Envía el mensaje."),
    );
    expect(result.kind).toBe("failed");
    expect(state.executions).toEqual([]);
    expect(result.text).not.toBe("Done.");
  });
});

describe("VoiceRouter permission binding", () => {
  it("answers the permission request the user heard, by its id", async () => {
    const state = setup([action("answer_permission", { agent: "a1", decision: "allow" })]);
    const waiting = agent("agent-ci", {
      title: "CI",
      status: "waiting_permission",
      blocker: "permission: run docker compose up",
      permissionId: "perm-heard",
    });
    const view = new FleetView([host([waiting])], NOW);
    await state.router.route(input(view, "Sí, apruébalo."));
    expect(state.executions[0]).toMatchObject({
      tool: "answer_permission",
      args: { agentId: "agent-ci", allow: true, requestId: "perm-heard" },
    });
  });
});
