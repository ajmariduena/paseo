import { describe, expect, it } from "vitest";
import { createAgentHistory, type AgentVisit } from "./agent-history";

function agent(agentId: string, serverId = "host-a"): AgentVisit {
  return { serverId, workspaceId: `workspace-${agentId}`, agentId };
}

function createHarness() {
  let now = 0;
  const history = createAgentHistory({ now: () => now, capacity: 50, cycleWindowMs: 1500 });
  const always = () => true;
  return {
    history,
    always,
    advance(ms: number) {
      now += ms;
    },
    visitAll(...visits: AgentVisit[]) {
      for (const visit of visits) {
        history.visit(visit);
      }
    },
    /** Runs a ⌃Tab press and the navigation it causes, the way the app does. */
    cycle(delta: 1 | -1) {
      const target = history.cycleRecent(delta, always);
      if (target) history.visit(target);
      return target?.agentId ?? null;
    },
    step(delta: 1 | -1, isAvailable: (visit: AgentVisit) => boolean = always) {
      const target = history.step(delta, isAvailable);
      if (target) history.visit(target);
      return target?.agentId ?? null;
    },
  };
}

function recentIds(history: ReturnType<typeof createAgentHistory>): string[] {
  return history.recent().map((visit) => visit.agentId);
}

describe("agent history: most recently used", () => {
  it("keeps the most recently visited agent first, once each", () => {
    const { history, visitAll } = createHarness();

    visitAll(agent("a"), agent("b"), agent("c"), agent("a"));

    expect(recentIds(history)).toEqual(["a", "c", "b"]);
  });

  it("tells agents on different hosts apart", () => {
    const { history, visitAll } = createHarness();

    visitAll(agent("same", "host-a"), agent("same", "host-b"));

    expect(history.recent()).toEqual([agent("same", "host-b"), agent("same", "host-a")]);
  });

  it("toggles between the last two agents when presses are far apart", () => {
    const harness = createHarness();
    harness.visitAll(agent("a"), agent("b"), agent("c"));

    expect(harness.cycle(1)).toBe("b");
    harness.advance(2000);
    expect(harness.cycle(1)).toBe("c");
    harness.advance(2000);
    expect(recentIds(harness.history)).toEqual(["c", "b", "a"]);
  });

  it("walks deeper on quick repeated presses and commits where it stops", () => {
    const harness = createHarness();
    harness.visitAll(agent("a"), agent("b"), agent("c"), agent("d"));

    expect(harness.cycle(1)).toBe("c");
    harness.advance(300);
    expect(harness.cycle(1)).toBe("b");
    harness.advance(300);
    expect(harness.cycle(-1)).toBe("c");
    harness.advance(300);
    expect(harness.cycle(1)).toBe("b");
    harness.advance(2000);

    expect(recentIds(harness.history)).toEqual(["b", "d", "c", "a"]);
  });

  it("goes to the least recent agent with ⌃⇧Tab", () => {
    const harness = createHarness();
    harness.visitAll(agent("a"), agent("b"), agent("c"));

    expect(harness.cycle(-1)).toBe("a");
  });

  it("ends a cycle early when the user navigates somewhere else", () => {
    const harness = createHarness();
    harness.visitAll(agent("a"), agent("b"), agent("c"));

    expect(harness.cycle(1)).toBe("b");
    harness.history.visit(agent("x"));
    harness.advance(100);

    expect(harness.cycle(1)).toBe("b");
  });

  it("skips agents that are gone and does nothing with fewer than two", () => {
    const { history, visitAll } = createHarness();
    visitAll(agent("a"), agent("b"), agent("c"));

    expect(history.cycleRecent(1, (visit) => visit.agentId !== "b")?.agentId).toBe("a");

    const lonely = createHarness();
    lonely.visitAll(agent("only"));
    expect(lonely.history.cycleRecent(1, lonely.always)).toBeNull();
  });
});

describe("agent history: back and forward", () => {
  it("steps back and forward without growing the history", () => {
    const harness = createHarness();
    harness.visitAll(agent("a"), agent("b"), agent("c"));

    expect(harness.step(-1)).toBe("b");
    expect(harness.step(-1)).toBe("a");
    expect(harness.step(-1)).toBeNull();
    expect(harness.step(1)).toBe("b");
    expect(harness.step(1)).toBe("c");
    expect(harness.step(1)).toBeNull();
  });

  it("drops the forward entries when the user navigates somewhere new", () => {
    const harness = createHarness();
    harness.visitAll(agent("a"), agent("b"), agent("c"));

    expect(harness.step(-1)).toBe("b");
    harness.history.visit(agent("d"));

    expect(harness.step(1)).toBeNull();
    expect(harness.step(-1)).toBe("b");
    expect(harness.step(-1)).toBe("a");
  });

  it("skips agents that no longer exist", () => {
    const harness = createHarness();
    harness.visitAll(agent("a"), agent("b"), agent("c"));

    expect(harness.step(-1, (visit) => visit.agentId !== "b")).toBe("a");
  });

  it("records ⌃Tab jumps as ordinary history", () => {
    const harness = createHarness();
    harness.visitAll(agent("a"), agent("b"), agent("c"));

    expect(harness.cycle(1)).toBe("b");
    expect(harness.step(-1)).toBe("c");
  });

  it("keeps at most `capacity` entries", () => {
    let now = 0;
    const history = createAgentHistory({ now: () => now, capacity: 2, cycleWindowMs: 1500 });
    for (const id of ["a", "b", "c", "d"]) {
      history.visit(agent(id));
      now += 1;
    }

    expect(history.recent().map((visit) => visit.agentId)).toEqual(["d", "c"]);
    expect(history.step(-1, () => true)?.agentId).toBe("c");
    expect(history.step(-1, () => true)?.agentId).toBe("b");
    expect(history.step(-1, () => true)).toBeNull();
  });
});
