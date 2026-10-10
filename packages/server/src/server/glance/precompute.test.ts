import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { AgentManager, AgentManagerEvent, AgentSubscriber } from "../agent/agent-manager.js";
import type { AgentPermissionRequest, AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { StructuredAgentGenerationWithFallbackOptions } from "../agent/agent-response-loop.js";
import { GlancePrecomputer, type GlanceSummaryPush } from "./precompute.js";
import { GlanceSummaryService, glanceSummaryKey } from "./service.js";

interface FakeAgent {
  cwd: string;
  internal?: boolean;
  pendingPermissions: Map<string, AgentPermissionRequest>;
  rows: Array<{ item: AgentTimelineItem; seqStart: number }>;
}

function setup(options: { glassesMode?: boolean } = {}) {
  const agents = new Map<string, FakeAgent>();
  let subscriber: AgentSubscriber | null = null;
  const prompts: string[] = [];
  const service = new GlanceSummaryService({
    agentManager: {} as AgentManager,
    providerSnapshotManager: { listProviders: async () => [] },
    getConfig: () => ({ metadataGeneration: { providers: [{ provider: "claude" }] } }),
    logger: pino({ level: "silent" }),
    generateStructured: async (input: StructuredAgentGenerationWithFallbackOptions<unknown>) => {
      prompts.push(input.prompt);
      const sources = JSON.parse(input.prompt) as Array<{ id: string; role: string }>;
      const result = sources.map((source) => ({
        id: source.id,
        line: source.role === "user" ? "Revisa el cambio." : "Terminé el cambio.",
      }));
      if (!("parse" in input.schema) || typeof input.schema.parse !== "function")
        throw new Error("Expected Zod schema");
      return input.schema.parse(result);
    },
  });
  if (options.glassesMode !== false) void service.enableGlassesMode();
  const pushes: GlanceSummaryPush[] = [];
  const precomputer = new GlancePrecomputer({
    agents: {
      subscribe: (callback) => {
        subscriber = callback;
        return () => {
          subscriber = null;
        };
      },
      getAgent: (agentId) => agents.get(agentId) ?? null,
      fetchTimeline: (agentId) => ({ rows: agents.get(agentId)?.rows ?? [] }),
    },
    service,
    publish: (push) => pushes.push(push),
    logger: pino({ level: "silent" }),
  });
  precomputer.start();
  const emit = async (agentId: string, event: AgentManagerEvent) => {
    subscriber?.(event);
    await precomputer.settled(agentId);
  };
  const turnCompleted = (agentId: string): AgentManagerEvent => ({
    type: "agent_stream",
    agentId,
    event: { type: "turn_completed", provider: "claude" },
  });
  return { agents, service, precomputer, pushes, prompts, emit, turnCompleted };
}

const turnRows = (): FakeAgent["rows"] => [
  {
    item: { type: "user_message", text: " Revisa este cambio ", clientMessageId: "c1" },
    seqStart: 1,
  },
  { item: { type: "reasoning", text: "Pensando" }, seqStart: 2 },
  { item: { type: "assistant_message", text: "Terminé de implementar el cambio" }, seqStart: 7 },
];

describe("GlancePrecomputer", () => {
  it("summarizes a finished turn once, caches it, and pushes the lines", async () => {
    const { agents, service, pushes, prompts, emit, turnCompleted } = setup();
    agents.set("agent", { cwd: "/repo", pendingPermissions: new Map(), rows: turnRows() });

    await emit("agent", turnCompleted("agent"));
    expect(prompts).toHaveLength(1);
    expect(pushes).toEqual([
      {
        agentId: "agent",
        items: [
          {
            id: "c1",
            role: "user",
            line: "Revisa el cambio.",
            textHash: glanceSummaryKey("user", "Revisa este cambio"),
          },
          {
            id: "seq:7",
            role: "assistant",
            line: "Terminé el cambio.",
            textHash: glanceSummaryKey("assistant", "Terminé de implementar el cambio"),
          },
        ],
      },
    ]);
    expect(service.getCachedLine("assistant", "Terminé de implementar el cambio")).toBe(
      "Terminé el cambio.",
    );

    await emit("agent", {
      type: "agent_stream",
      agentId: "agent",
      event: { type: "attention_required", provider: "claude", reason: "finished", timestamp: "" },
    });
    expect(prompts).toHaveLength(1);
    expect(pushes).toHaveLength(1);
  });

  it("adds the pending question on attention and skips lines already cached", async () => {
    const { agents, pushes, prompts, emit, turnCompleted } = setup();
    const agent: FakeAgent = { cwd: "/repo", pendingPermissions: new Map(), rows: turnRows() };
    agents.set("agent", agent);
    await emit("agent", turnCompleted("agent"));
    agent.pendingPermissions.set("perm-1", {
      id: "perm-1",
      provider: "claude",
      name: "AskUserQuestion",
      kind: "question",
      input: { questions: [{ question: "¿Despliego a producción?" }] },
    });

    await emit("agent", {
      type: "agent_stream",
      agentId: "agent",
      event: {
        type: "attention_required",
        provider: "claude",
        reason: "permission",
        timestamp: "",
      },
    });
    expect(JSON.parse(prompts[1]!)).toEqual([
      { id: "0", role: "assistant", text: "¿Despliego a producción?" },
    ]);
    expect(pushes[1]!.items).toEqual([
      expect.objectContaining({ id: "permission:perm-1", role: "assistant" }),
    ]);
  });

  it("ignores internal agents, unrelated events, and hosts without glasses", async () => {
    const internal = setup();
    internal.agents.set("summarizer", {
      cwd: "/repo",
      internal: true,
      pendingPermissions: new Map(),
      rows: turnRows(),
    });
    await internal.emit("summarizer", internal.turnCompleted("summarizer"));
    await internal.emit("summarizer", {
      type: "agent_stream",
      agentId: "summarizer",
      event: { type: "turn_started", provider: "claude" },
    });
    expect(internal.prompts).toEqual([]);
    expect(internal.pushes).toEqual([]);

    const unpaired = setup({ glassesMode: false });
    unpaired.agents.set("agent", { cwd: "/repo", pendingPermissions: new Map(), rows: turnRows() });
    await unpaired.emit("agent", unpaired.turnCompleted("agent"));
    expect(unpaired.prompts).toEqual([]);
  });

  it("logs provider failures without throwing into the agent event stream", async () => {
    const { agents, service, pushes, emit, turnCompleted } = setup();
    vi.spyOn(service, "summarize").mockRejectedValueOnce(new Error("provider offline"));
    agents.set("agent", { cwd: "/repo", pendingPermissions: new Map(), rows: turnRows() });
    await expect(emit("agent", turnCompleted("agent"))).resolves.toBeUndefined();
    expect(pushes).toEqual([]);
    await emit("agent", turnCompleted("agent"));
    expect(pushes).toHaveLength(1);
  });

  it("coalesces events that arrive while a run is in flight", async () => {
    const { agents, service, precomputer, emit, turnCompleted } = setup();
    agents.set("agent", { cwd: "/repo", pendingPermissions: new Map(), rows: turnRows() });
    const summarize = vi.spyOn(service, "summarize");
    const first = emit("agent", turnCompleted("agent"));
    await emit("agent", turnCompleted("agent"));
    await first;
    await precomputer.settled("agent");
    expect(summarize).toHaveBeenCalledTimes(1);
  });
});
