import { describe, expect, it } from "vitest";
import type { VoiceFleetAgent } from "@getpaseo/protocol/voice-fleet/types";
import { FleetView, type FleetHost } from "../fleet/fleet-view.js";
import { LiveFleetSnapshot } from "./live-fleet-snapshot.js";

const NOW = Date.parse("2026-10-09T14:00:00.000Z");

function agent(id: string, overrides: Partial<VoiceFleetAgent> = {}): VoiceFleetAgent {
  return {
    agentId: id,
    title: id,
    provider: "codex",
    workspaceId: "workspace",
    workspace: "Paseo",
    status: "working",
    statusForMs: 60_000,
    updatedAt: new Date(NOW).toISOString(),
    task: "Revisar integración",
    ...overrides,
  };
}

function host(agents: VoiceFleetAgent[] = [], overrides: Partial<FleetHost> = {}): FleetHost {
  return {
    serverId: null,
    label: "Mini",
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

function setup(initial: FleetView) {
  let view = initial;
  const messages: string[] = [];
  const snapshot = new LiveFleetSnapshot({
    describe: async () => view,
    append: (message) => messages.push(message),
  });
  return {
    snapshot,
    messages,
    setView(next: FleetView) {
      view = next;
    },
  };
}

describe("LiveFleetSnapshot", () => {
  it("sends a full snapshot, then stays silent when only agent ages change", async () => {
    const state = setup(new FleetView([host([agent("Upstream")])], NOW));
    await state.snapshot.sendFull();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toContain('"Upstream" (codex) — working for 1 min');
    state.setView(
      new FleetView([host([agent("Upstream", { statusForMs: 180_000 })])], NOW + 120_000),
    );
    await state.snapshot.sendChanges();
    expect(state.messages).toHaveLength(1);
  });

  it("emits only the changed agent and suppresses a repeated unchanged update", async () => {
    const state = setup(new FleetView([host([agent("Upstream"), agent("Voz")])], NOW));
    await state.snapshot.sendFull();
    state.setView(
      new FleetView(
        [
          host([
            agent("Upstream"),
            agent("Voz", {
              status: "finished_unreviewed",
              outcome: "Pruebas pasaron.",
              unheard: true,
            }),
          ]),
        ],
        NOW,
      ),
    );
    await state.snapshot.sendChanges();
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1]).toContain('"Voz"');
    expect(state.messages[1]).toContain("NOT YET TOLD TO THE USER");
    expect(state.messages[1]).not.toContain('"Upstream"');
    await state.snapshot.sendChanges();
    expect(state.messages).toHaveLength(2);
  });

  it("reports lost reachability and recovery independently of agent changes", async () => {
    const state = setup(new FleetView([host()], NOW));
    await state.snapshot.sendFull();
    state.setView(
      new FleetView([host([], { online: false, lastSeenAt: new Date(NOW).toISOString() })], NOW),
    );
    await state.snapshot.sendChanges();
    expect(state.messages[1]).toContain("Mini is offline");
    state.setView(new FleetView([host()], NOW));
    await state.snapshot.sendChanges();
    expect(state.messages[2]).toContain("online");
  });

  it("splits a full fleet into bounded appends while including every agent", async () => {
    const agents = Array.from({ length: 12 }, (_, i) =>
      agent(`Agent-${i}`, { task: "A detailed task ".repeat(30) }),
    );
    const state = setup(new FleetView([host(agents)], NOW));
    await state.snapshot.sendFull();
    expect(state.messages.length).toBeGreaterThan(1);
    expect(state.messages.every((message) => message.length <= 1_600)).toBe(true);
    for (const entry of agents) expect(state.messages.join("\n")).toContain(`"${entry.title}"`);
  });

  it("removes an absent agent from the voice model's previous snapshot", async () => {
    const state = setup(new FleetView([host([agent("Upstream")])], NOW));
    await state.snapshot.sendFull();
    state.setView(new FleetView([host()], NOW));
    await state.snapshot.sendChanges();
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1]).toMatch(/removed|no longer|replacing earlier/i);
  });

  it("does not append updates solely because an offline host's age increased", async () => {
    const offline = host([], { online: false, lastSeenAt: new Date(NOW - 60_000).toISOString() });
    const state = setup(new FleetView([offline], NOW));
    await state.snapshot.sendFull();
    state.setView(new FleetView([offline], NOW + 120_000));
    await state.snapshot.sendChanges();
    expect(state.messages).toHaveLength(1);
  });
});
