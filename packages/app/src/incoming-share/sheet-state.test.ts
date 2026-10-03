import { describe, expect, it } from "vitest";
import { canGoBack, createIncomingShareSheetState, reduceIncomingShareSheet } from "./sheet-state";

describe("incoming share sheet state", () => {
  it("skips the host page when there is one host", () => {
    expect(createIncomingShareSheetState(["host-a"]).page).toEqual({
      kind: "workspace",
      serverId: "host-a",
    });
    expect(createIncomingShareSheetState(["host-a", "host-b"]).page).toEqual({ kind: "host" });
    expect(canGoBack({ page: { kind: "workspace", serverId: "host-a" }, hostCount: 1 })).toBe(
      false,
    );
  });

  it("walks host, workspace and agent, and back", () => {
    let state = createIncomingShareSheetState(["host-a", "host-b"]);
    state = reduceIncomingShareSheet(state, { type: "chooseHost", serverId: "host-b" });
    state = reduceIncomingShareSheet(state, { type: "chooseWorkspace", workspaceId: "ws-1" });
    expect(state.page).toEqual({ kind: "agent", serverId: "host-b", workspaceId: "ws-1" });
    state = reduceIncomingShareSheet(state, { type: "back" });
    expect(state.page).toEqual({ kind: "workspace", serverId: "host-b" });
    state = reduceIncomingShareSheet(state, { type: "back" });
    expect(state.page).toEqual({ kind: "host" });
  });

  it("holds the page while a delivery is in flight and clears a failure on navigation", () => {
    let state = createIncomingShareSheetState(["host-a"]);
    state = reduceIncomingShareSheet(state, { type: "chooseWorkspace", workspaceId: "ws-1" });
    state = reduceIncomingShareSheet(state, { type: "deliveryStarted", targetKey: "new-agent" });
    expect(reduceIncomingShareSheet(state, { type: "back" })).toBe(state);
    state = reduceIncomingShareSheet(state, { type: "deliveryFailed", reason: "failed" });
    expect(state.delivery).toEqual({ status: "failed", reason: "failed" });
    state = reduceIncomingShareSheet(state, { type: "back" });
    expect(state.delivery).toEqual({ status: "idle" });
  });
});
