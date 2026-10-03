import { describe, expect, it } from "vitest";
import { setTurnFoldExpanded } from "./turn-fold-store";

describe("turn fold expanded state", () => {
  it("remembers opened folds per agent and forgets closed ones", () => {
    let state = { expandedByAgent: {} };
    state = setTurnFoldExpanded(state, "host:agent-a", "epoch:1", true);
    state = setTurnFoldExpanded(state, "host:agent-a", "epoch:5", true);
    state = setTurnFoldExpanded(state, "host:agent-b", "epoch:2", true);
    state = setTurnFoldExpanded(state, "host:agent-a", "epoch:1", false);

    expect(state.expandedByAgent).toEqual({
      "host:agent-a": ["epoch:5"],
      "host:agent-b": ["epoch:2"],
    });
  });

  it("returns the same state when nothing changes", () => {
    const state = { expandedByAgent: { "host:agent": ["epoch:1"] } };

    expect(setTurnFoldExpanded(state, "host:agent", "epoch:1", true)).toBe(state);
    expect(setTurnFoldExpanded(state, "host:other", "epoch:1", false)).toBe(state);
  });

  it("drops an agent once none of its folds are open", () => {
    const state = { expandedByAgent: { "host:agent": ["epoch:1"] } };

    expect(setTurnFoldExpanded(state, "host:agent", "epoch:1", false).expandedByAgent).toEqual({});
  });
});
