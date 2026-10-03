export type IncomingSharePage =
  | { kind: "host" }
  | { kind: "workspace"; serverId: string }
  | { kind: "agent"; serverId: string; workspaceId: string };

export type IncomingShareDelivery =
  | { status: "idle" }
  | { status: "pending"; targetKey: string }
  | { status: "failed"; reason: "hostDisconnected" | "failed" };

export interface IncomingShareSheetState {
  page: IncomingSharePage;
  delivery: IncomingShareDelivery;
}

export type IncomingShareSheetAction =
  | { type: "chooseHost"; serverId: string }
  | { type: "chooseWorkspace"; workspaceId: string }
  | { type: "back" }
  | { type: "deliveryStarted"; targetKey: string }
  | { type: "deliveryFailed"; reason: "hostDisconnected" | "failed" };

const IDLE: IncomingShareDelivery = { status: "idle" };

/** A single host skips the host page; the user never has to pick from one option. */
export function createIncomingShareSheetState(
  serverIds: readonly string[],
): IncomingShareSheetState {
  const page: IncomingSharePage =
    serverIds.length === 1 ? { kind: "workspace", serverId: serverIds[0] } : { kind: "host" };
  return { page, delivery: IDLE };
}

export function canGoBack(input: { page: IncomingSharePage; hostCount: number }): boolean {
  if (input.page.kind === "agent") {
    return true;
  }
  return input.page.kind === "workspace" && input.hostCount > 1;
}

function previousPage(page: IncomingSharePage): IncomingSharePage {
  if (page.kind === "agent") {
    return { kind: "workspace", serverId: page.serverId };
  }
  return { kind: "host" };
}

export function reduceIncomingShareSheet(
  state: IncomingShareSheetState,
  action: IncomingShareSheetAction,
): IncomingShareSheetState {
  if (action.type === "deliveryStarted") {
    return { ...state, delivery: { status: "pending", targetKey: action.targetKey } };
  }
  if (action.type === "deliveryFailed") {
    return { ...state, delivery: { status: "failed", reason: action.reason } };
  }
  if (state.delivery.status === "pending") {
    return state;
  }
  if (action.type === "chooseHost") {
    return { page: { kind: "workspace", serverId: action.serverId }, delivery: IDLE };
  }
  if (action.type === "chooseWorkspace") {
    if (state.page.kind !== "workspace") {
      return state;
    }
    return {
      page: { kind: "agent", serverId: state.page.serverId, workspaceId: action.workspaceId },
      delivery: IDLE,
    };
  }
  return { page: previousPage(state.page), delivery: IDLE };
}
