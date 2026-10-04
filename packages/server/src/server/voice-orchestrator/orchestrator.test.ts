import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { VoiceOrchestrator, type VoiceOrchestratorCall } from "./orchestrator.js";

interface Announcement {
  lines: string[];
  urgent: boolean;
  report: (heard: boolean) => void;
}

function createFakeAgentManager() {
  const agents = new Map<string, ManagedAgent>();
  const lastMessages = new Map<string, string | null>();
  const subscribers = new Set<(event: AgentManagerEvent) => void>();
  const manager = {
    listAgents: () => [...agents.values()],
    getAgent: (id: string) => agents.get(id) ?? null,
    getLiveWorkSummary: () => ({ request: null, currentStep: null }),
    getLastAssistantMessage: async (id: string) => lastMessages.get(id) ?? null,
    subscribe: (callback: (event: AgentManagerEvent) => void) => {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
  };
  function setLifecycle(id: string, lifecycle: ManagedAgent["lifecycle"]): void {
    const agent = {
      id,
      provider: "claude",
      cwd: "/work/auth",
      workspaceId: undefined,
      lifecycle,
      labels: {},
      config: { title: "Login fix" },
      pendingPermissions: new Map(),
      attention: { requiresAttention: false },
      updatedAt: new Date(),
    } as unknown as ManagedAgent;
    agents.set(id, agent);
    for (const subscriber of subscribers) subscriber({ type: "agent_state", agent });
  }
  return {
    manager: manager as unknown as AgentManager,
    finish(id: string, message: string | null): void {
      lastMessages.set(id, message);
      setLifecycle(id, "running");
      setLifecycle(id, "idle");
    },
  };
}

describe("VoiceOrchestrator unheard results", () => {
  let paseoHome: string;
  let active: VoiceOrchestrator | null = null;

  beforeEach(async () => {
    paseoHome = await mkdtemp(join(tmpdir(), "voice-orchestrator-"));
  });

  afterEach(async () => {
    active?.dispose();
    active = null;
    vi.useRealTimers();
    await rm(paseoHome, { recursive: true, force: true });
  });

  async function setup() {
    const agents = createFakeAgentManager();
    const orchestrator = new VoiceOrchestrator({
      paseoHome,
      agentManager: agents.manager,
      agentStorage: { list: async () => [] } as unknown as AgentStorage,
      workspaceRegistry: null,
      logger: pino({ level: "silent" }),
    });
    active = orchestrator;
    // The ledger loads from disk; let that real I/O finish before time is faked.
    await new Promise((resolve) => setTimeout(resolve, 50));
    vi.useFakeTimers();
    const announcements: Announcement[] = [];
    const call: VoiceOrchestratorCall = {
      isUserSpeaking: () => false,
      announce: (lines, options) =>
        announcements.push({
          lines,
          urgent: options?.urgent ?? false,
          report: (heard) => options?.onOutcome?.(heard),
        }),
    };
    return { agents, announcements, call, orchestrator };
  }

  it("repeats a result the user cut off and stops once it is heard", async () => {
    const { agents, announcements, call, orchestrator } = await setup();
    orchestrator.attachCall(call);

    agents.finish("a1", "The login now works.");
    await vi.advanceTimersByTimeAsync(4_500);
    expect(announcements).toHaveLength(1);
    expect(announcements[0]?.lines[0]).toContain("Its final message: The login now works.");

    announcements[0]?.report(false);
    await vi.advanceTimersByTimeAsync(4_500);
    expect(announcements).toHaveLength(2);
    expect(announcements[1]?.lines[0]).toContain("Repeating");

    announcements[1]?.report(true);
    await vi.advanceTimersByTimeAsync(4_500);
    expect(announcements).toHaveLength(2);
  });

  it("tells a result that landed between calls when the next call starts", async () => {
    const { agents, announcements, call, orchestrator } = await setup();
    orchestrator.callerContext().onAgentPrompted?.("a2");

    agents.finish("a2", "Done researching.");
    const detach = orchestrator.attachCall(call);
    await vi.advanceTimersByTimeAsync(4_500);

    expect(announcements.map((entry) => entry.lines[0])).toEqual([
      expect.stringContaining("Done researching."),
    ]);
    detach();
  });

  it("keeps an unheard result for the next call when the call ends first", async () => {
    const { agents, announcements, call, orchestrator } = await setup();
    const detach = orchestrator.attachCall(call);
    agents.finish("a3", "Tests pass.");
    await vi.advanceTimersByTimeAsync(4_500);
    detach();
    announcements[0]?.report(false);

    orchestrator.attachCall(call);
    await vi.advanceTimersByTimeAsync(4_500);
    expect(announcements).toHaveLength(2);
    expect(announcements[1]?.lines[0]).toContain("Tests pass.");
  });

  it("reports a run that ended without any reply as a failure", async () => {
    const { agents, announcements, call, orchestrator } = await setup();
    orchestrator.attachCall(call);

    agents.finish("a4", null);
    await vi.advanceTimersByTimeAsync(4_500);

    expect(announcements).toHaveLength(1);
    expect(announcements[0]?.urgent).toBe(true);
    expect(announcements[0]?.lines[0]).toContain("stopped without giving any result");
  });

  it("gives agents it creates the user's chosen mode for the provider", async () => {
    const { orchestrator } = await setup();
    orchestrator.setPreferredAgentModes({ claude: "bypassPermissions" });
    expect(orchestrator.callerContext().defaultModeFor?.("claude")).toBe("bypassPermissions");
    expect(orchestrator.callerContext().defaultModeFor?.("codex")).toBeUndefined();
  });
});
