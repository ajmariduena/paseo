import { describe, expect, it } from "vitest";
import type {
  HandoffDestinationSnapshot,
  HandoffSourceSnapshot,
} from "@getpaseo/protocol/handoff-control";
import { handoffFormActions, openHandoffForm, type HandoffFormPorts } from "./form-model";
import { createHandoffPersistence, restoreHandoffRecord } from "./persistence";
import { HandoffReviewChangedError } from "@getpaseo/client/internal/workspace-handoff";

const origin = { sourceServerId: "source", workspaceId: "workspace" };
const transferId = "00000000-0000-4000-8000-000000000001";
const destination: HandoffDestinationSnapshot = {
  transferId,
  reservationId: "00000000-0000-4000-8000-000000000002",
  sourceServerId: "source",
  sourceWorkspaceId: "workspace",
  sourceAgentIds: [],
  destinationParent: "/projects",
  destinationCwd: "/projects/transferred",
  workspaceId: "destination-workspace",
  projectId: "destination-project",
  agentMappings: [],
  continuationMode: "native",
  state: "staged",
  manifestDigest: "a".repeat(64),
};

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const values = new Map<string, string>();
  const persistence = createHandoffPersistence({
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  });
  const calls: string[] = [];
  const ports: HandoffFormPorts = {
    ...persistence,
    listDestination: async () => ({ transfers: [], nextCursor: null }),
    recoverDestination: async () => {
      throw new Error("No transfer was selected");
    },
    newTransferId: () => transferId,
    validate: async () => ({ conversations: [] }),
    prepare: async (record) => {
      expect(await persistence.load(origin)).toEqual(record);
      calls.push(`prepare:${record.transferId}`);
      return { ...destination, continuationMode: record.continuationMode };
    },
    activate: async (record) => {
      expect((await persistence.load(origin))?.intent).toBe("activate");
      calls.push(`activate:${record.transferId}`);
      return { ...destination, state: "active" };
    },
    cancel: async (record) => {
      expect((await persistence.load(origin))?.intent).toBe("cancel");
      calls.push(`cancel:${record.transferId}`);
      return { ...destination, state: "cancelled" };
    },
  };
  return { values, persistence, calls, ports };
}

async function editedForm(ports: HandoffFormPorts) {
  const model = openHandoffForm(origin, ports);
  await model.load();
  await model.setDestination({ serverId: "destination", label: "VPS" });
  model.setDestinationParent("/projects");
  return model;
}

async function reviewedForm(ports: HandoffFormPorts) {
  const model = await editedForm(ports);
  await model.review();
  return model;
}

describe("handoff form recovery", () => {
  it("recovers a chosen destination-only reservation without starting work and keeps lookup failures retryable", async () => {
    const { ports, calls, persistence } = fixture();
    ports.listDestination = async () => {
      throw new Error("Destination disconnected");
    };
    const model = await editedForm(ports);
    expect(model.getState()).toMatchObject({
      kind: "recovering",
      error: "Destination disconnected",
      busy: false,
    });
    const recoveredId = "00000000-0000-4000-8000-000000000004";
    const snapshot = {
      ...destination,
      transferId: recoveredId,
      state: "reserved" as const,
      continuationMode: "context" as const,
      manifestDigest: null,
    };
    ports.listDestination = async () => ({ transfers: [snapshot], nextCursor: null });
    await model.moreTransfers();
    expect(model.getState()).toMatchObject({ kind: "recovering", error: null });
    await model.recoverTransfer(recoveredId);
    expect(model.getState()).toMatchObject({
      kind: "recovering",
      error: "No transfer was selected",
    });
    expect(await persistence.load(origin)).toBeNull();
    ports.recoverDestination = async () => ({
      version: 1,
      ...origin,
      transferId: recoveredId,
      destinationServerId: "destination",
      destinationLabel: "VPS",
      destinationParent: snapshot.destinationParent,
      continuationMode: "context",
      intent: "prepare",
      snapshot,
    });
    await model.recoverTransfer(recoveredId);
    expect(model.getState()).toMatchObject({
      kind: "transfer",
      record: { transferId: recoveredId, continuationMode: "context" },
      run: { status: "idle" },
    });
    expect((await persistence.load(origin))?.transferId).toBe(recoveredId);
    expect(calls).toEqual([]);
    await model.retry();
    expect(calls).toEqual([`prepare:${recoveredId}`]);
  });

  it("restores a released transfer without local state as forward recovery in its reserved mode", async () => {
    const { ports, persistence, calls } = fixture();
    const source: HandoffSourceSnapshot["source"] = {
      id: transferId,
      workspaceId: origin.workspaceId,
      cwd: "/old/source",
      agentIds: [],
      destinationServerId: "destination",
      reservationId: destination.reservationId,
      state: "released",
      manifestDigest: destination.manifestDigest,
      publicKey: "source-key",
    };
    const record = restoreHandoffRecord({
      origin,
      source,
      destination: { serverId: "destination", label: "VPS" },
      snapshot: { ...destination, continuationMode: "context" },
    });
    expect(record).toMatchObject({ transferId, continuationMode: "context", intent: "activate" });
    await persistence.save(record);
    const model = openHandoffForm(origin, ports);
    await model.load();
    expect(handoffFormActions(model.getState())).toEqual({ primary: "retry", canCancel: false });
    await model.cancel();
    expect(calls).toEqual([]);
    await model.retry();
    expect(calls).toEqual([`activate:${transferId}`]);
    for (const snapshot of [
      { ...destination, sourceServerId: "another-host" },
      { ...destination, sourceWorkspaceId: "another-workspace" },
      { ...destination, reservationId: "00000000-0000-4000-8000-000000000003" },
      { ...destination, manifestDigest: "b".repeat(64) },
      { ...destination, sourceAgentIds: ["another-conversation"] },
    ]) {
      expect(() =>
        restoreHandoffRecord({
          origin,
          source,
          destination: { serverId: "destination", label: "VPS" },
          snapshot,
        }),
      ).toThrow("Source and destination handoff records do not match");
    }
  });

  it("returns to review when the conversation inventory changes before any host mutation", async () => {
    const { ports, persistence, calls } = fixture();
    ports.prepare = async () => {
      throw new HandoffReviewChangedError("Review the changed conversations");
    };
    const model = await reviewedForm(ports);
    await model.prepare();
    expect(model.getState()).toMatchObject({
      kind: "editing",
      error: "Review the changed conversations",
    });
    expect(await persistence.load(origin)).toBeNull();
    expect(calls).toEqual([]);
    const reopened = openHandoffForm(origin, ports);
    await reopened.load();
    expect(reopened.getState().kind).toBe("editing");
  });

  it("requires an explicit supported continuation choice after read-only review", async () => {
    const { ports, persistence, calls } = fixture();
    ports.validate = async () => ({
      conversations: [
        {
          agentId: "conversation",
          title: "Current work",
          provider: "claude",
          native: { available: false, reason: "Claude versions differ" },
          context: { available: true, reason: null },
        },
      ],
    });
    const model = await editedForm(ports);
    await model.review();
    expect(model.getState()).toMatchObject({
      kind: "review",
      draft: { continuationMode: "native" },
    });
    expect(await persistence.load(origin)).toBeNull();
    expect(calls).toEqual([]);
    expect(handoffFormActions(model.getState()).primary).toBeNull();
    await model.prepare();
    expect(calls).toEqual([]);
    model.setContinuationMode("context");
    await model.prepare();
    expect(calls).toEqual([`prepare:${transferId}`]);
    expect((await persistence.load(origin))?.continuationMode).toBe("context");
  });

  it("finishes activation when the host journal has advanced past the saved preparation", async () => {
    const { ports, calls } = fixture();
    ports.prepare = async () => ({ ...destination, state: "released" });
    const model = await reviewedForm(ports);
    await model.prepare();
    expect(handoffFormActions(model.getState())).toEqual({ primary: "activate", canCancel: false });
    await model.cancel();
    await model.activate();
    expect(calls).toEqual([`activate:${transferId}`]);
  });

  it("keeps invalid placement editable without reserving or stopping either host", async () => {
    const { ports, calls, persistence } = fixture();
    ports.validate = async () => {
      throw new Error("Destination directory is missing");
    };
    const model = await reviewedForm(ports);
    await model.prepare();
    expect(model.getState()).toMatchObject({
      kind: "editing",
      error: "Destination directory is missing",
      draft: {
        destination: { serverId: "destination", label: "VPS" },
        destinationParent: "/projects",
      },
    });
    expect(await persistence.load(origin)).toBeNull();
    expect(calls).toEqual([]);
    ports.validate = async () => ({ conversations: [] });
    await model.review();
    await model.prepare();
    expect(calls).toEqual([`prepare:${transferId}`]);
  });

  it("persists the identity before preparation and retains it after reopening", async () => {
    const { ports, calls } = fixture();
    const first = await reviewedForm(ports);
    await first.prepare();
    first.close();
    const reopened = openHandoffForm(origin, ports);
    await reopened.load();
    expect(reopened.getState()).toMatchObject({
      kind: "transfer",
      record: { transferId, snapshot: destination },
      run: { status: "idle" },
    });
    await reopened.activate();
    expect(calls).toEqual([`prepare:${transferId}`, `activate:${transferId}`]);
    expect(reopened.getState()).toMatchObject({
      kind: "transfer",
      record: { snapshot: { state: "active" } },
    });
  });

  it("recovers a lost release reply with the same identity and never offers rollback", async () => {
    const { ports, persistence, calls } = fixture();
    const model = await reviewedForm(ports);
    await model.prepare();
    ports.activate = async (record) => {
      expect((await persistence.load(origin))?.intent).toBe("activate");
      calls.push(`lost-reply:${record.transferId}`);
      throw new Error("Connection closed after release");
    };
    await model.activate();
    expect(model.getState()).toMatchObject({
      kind: "transfer",
      run: { status: "error", message: "Connection closed after release" },
    });
    model.close();
    const reopened = openHandoffForm(origin, ports);
    await reopened.load();
    await reopened.cancel();
    ports.activate = async (record) => {
      calls.push(`recovered:${record.transferId}`);
      return { ...destination, state: "active" };
    };
    await reopened.retry();
    expect(calls).toEqual([
      `prepare:${transferId}`,
      `lost-reply:${transferId}`,
      `recovered:${transferId}`,
    ]);
    expect((await persistence.load(origin))?.snapshot?.state).toBe("active");
  });

  it("does not contact a host when the local intent cannot be saved", async () => {
    const { ports, calls, persistence } = fixture();
    ports.save = async () => {
      throw new Error("Storage full");
    };
    const model = await reviewedForm(ports);
    await model.prepare();
    expect(calls).toEqual([]);
    expect(model.getState()).toMatchObject({
      kind: "transfer",
      run: { status: "error", message: "Storage full" },
    });
    ports.save = persistence.save;
    await model.retry();
    expect(calls).toEqual([`prepare:${transferId}`]);
  });

  it("blocks duplicate submissions while an operation is running", async () => {
    const { ports, calls } = fixture();
    const entered = deferred();
    const release = deferred();
    const prepare = ports.prepare;
    ports.prepare = async (record, options) => {
      entered.resolve();
      await release.promise;
      return prepare(record, options);
    };
    const model = await reviewedForm(ports);
    const running = model.prepare();
    await entered.promise;
    await model.prepare();
    await model.retry();
    await model.cancel();
    release.resolve();
    await running;
    expect(calls).toEqual([`prepare:${transferId}`]);
  });

  it("closing while saving cannot start preparation afterward", async () => {
    const { ports, calls, persistence } = fixture();
    const entered = deferred();
    const release = deferred();
    ports.save = async (record) => {
      entered.resolve();
      await release.promise;
      await persistence.save(record);
    };
    const model = await reviewedForm(ports);
    const running = model.prepare();
    await entered.promise;
    model.close();
    release.resolve();
    await running;
    expect(calls).toEqual([]);
    expect((await persistence.load(origin))?.transferId).toBe(transferId);
  });

  it("closing during transfer aborts transport and ignores its late result", async () => {
    const { ports, persistence } = fixture();
    const entered = deferred();
    const release = deferred();
    ports.prepare = async (_record, options) => {
      entered.resolve();
      await release.promise;
      expect(options.signal.aborted).toBe(true);
      options.onProgress({ phase: "ready" });
      return destination;
    };
    const model = await reviewedForm(ports);
    const running = model.prepare();
    await entered.promise;
    model.close();
    const atClose = model.getState();
    release.resolve();
    await running;
    expect(model.getState()).toBe(atClose);
    expect((await persistence.load(origin))?.snapshot).toBeNull();
  });

  it("reopens a failed cancellation as a cancellation retry", async () => {
    const { ports, persistence, calls } = fixture();
    const model = await reviewedForm(ports);
    await model.prepare();
    const cancel = ports.cancel;
    ports.cancel = async () => {
      throw new Error("Lost cancellation acknowledgement");
    };
    await model.cancel();
    model.close();
    const reopened = openHandoffForm(origin, ports);
    await reopened.load();
    await reopened.activate();
    ports.cancel = cancel;
    await reopened.retry();
    expect(calls).toEqual([`prepare:${transferId}`, `cancel:${transferId}`]);
    expect((await persistence.load(origin))?.snapshot?.state).toBe("cancelled");
    reopened.startOver();
    expect(reopened.getState().kind).toBe("editing");
  });

  it("surfaces corrupt saved state without silently starting another transfer", async () => {
    const { ports, values, calls } = fixture();
    const model = await reviewedForm(ports);
    await model.prepare();
    model.close();
    for (const key of values.keys()) values.set(key, "not json");
    const reopened = openHandoffForm(origin, ports);
    await reopened.load();
    expect(reopened.getState().kind).toBe("load_error");
    await reopened.prepare();
    expect(calls).toEqual([`prepare:${transferId}`]);
    expect([...values.values()]).toEqual(["not json"]);
  });
});
