import { describe, expect, it } from "vitest";
import type {
  HandoffDestinationSnapshot,
  HandoffSourceSnapshot,
} from "@getpaseo/protocol/handoff-control";
import {
  HandoffFilesNotSavedError,
  handoffFormActions,
  openHandoffForm,
  type HandoffFormPorts,
} from "./form-model";
import {
  createHandoffPersistence,
  restoreHandoffRecord,
  restoreCancelledHandoffRecord,
} from "./persistence";
import { HandoffReviewChangedError } from "@getpaseo/client/internal/workspace-handoff";

const origin = { sourceServerId: "source", workspaceId: "workspace" };
const transferId = "00000000-0000-4000-8000-000000000001";
const emptyReview = {
  conversations: [],
  workspace: {
    kind: "directory" as const,
    fileCount: 0,
    directoryCount: 0,
    symlinkCount: 0,
    fileBytes: 0,
    gitHistoryBytes: 0,
    omittedPaths: [],
    omittedPathCount: 0,
    reviewDigest: "c".repeat(64),
  },
  stoppedWork: {
    agentIds: [],
    terminals: [],
    setupOperations: 0,
    review: { agents: [], terminals: [], setupIds: [] },
  },
  conversationBytes: 0,
  unsavedFiles: [],
};
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
    validate: async () => emptyReview,
    prepare: async (record) => {
      expect(await persistence.load(origin)).toEqual(record);
      calls.push(`prepare:${record.transferId}`);
      return {
        ...destination,
        continuationMode: record.continuationMode,
        workspaceReviewDigest: record.workspaceReviewDigest,
        stoppedWorkReview: record.stoppedWorkReview,
      };
    },
    activate: async (record) => {
      expect((await persistence.load(origin))?.intent).toBe("activate");
      calls.push(`activate:${record.transferId}`);
      return {
        ...destination,
        state: "active",
        workspaceReviewDigest: record.workspaceReviewDigest,
        stoppedWorkReview: record.stoppedWorkReview,
      };
    },
    cancel: async (record) => {
      expect((await persistence.load(origin))?.intent).toBe("cancel");
      calls.push(`cancel:${record.transferId}`);
      return {
        ...destination,
        state: "cancelled",
        cleanupComplete: true,
        cancellationAccepted: true,
        workspaceReviewDigest: record.workspaceReviewDigest,
        stoppedWorkReview: record.stoppedWorkReview,
      };
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
  it("retains the reviewed workspace boundary across reopening and rejects a different saved approval", async () => {
    const { ports, persistence } = fixture();
    const model = await reviewedForm(ports);
    await model.prepare();
    model.close();
    const saved = await persistence.load(origin);
    if (!saved) throw new Error("Missing saved transfer");
    expect(saved.workspaceReviewDigest).toBe(emptyReview.workspace.reviewDigest);
    expect(saved.stoppedWorkReview).toEqual(emptyReview.stoppedWork.review);
    const reopened = openHandoffForm(origin, ports);
    await reopened.load();
    expect(reopened.getState()).toMatchObject({
      kind: "transfer",
      record: { workspaceReviewDigest: emptyReview.workspace.reviewDigest },
    });
    await persistence.save({ ...saved, workspaceReviewDigest: "d".repeat(64) });
    await expect(persistence.load(origin)).rejects.toThrow(
      "Saved handoff destination does not match",
    );
  });

  it("discards only the new local intent when the form closes before editor preparation finishes", async () => {
    const { ports, persistence } = fixture();
    const saving = deferred();
    const entered = deferred();
    ports.prepare = async () => {
      entered.resolve();
      await saving.promise;
      throw new HandoffFilesNotSavedError("Saving was interrupted");
    };
    const model = await reviewedForm(ports);
    const preparing = model.prepare();
    await entered.promise;
    expect((await persistence.load(origin))?.intent).toBe("prepare");
    model.close();
    saving.resolve();
    await preparing;
    expect(await persistence.load(origin)).toBeNull();
  });

  it("returns a new transfer to review after a local save failure, but retains an existing transfer", async () => {
    const { ports, persistence } = fixture();
    ports.prepare = async () => {
      throw new HandoffFilesNotSavedError("Resolve file.ts");
    };
    const model = await reviewedForm(ports);
    await model.prepare();
    expect(model.getState()).toMatchObject({ kind: "editing", error: "Resolve file.ts" });
    expect(await persistence.load(origin)).toBeNull();
    const record = {
      version: 1 as const,
      ...origin,
      transferId,
      destinationServerId: "destination",
      destinationLabel: "VPS",
      destinationParent: "/projects",
      continuationMode: "native" as const,
      intent: "prepare" as const,
      snapshot: null,
    };
    await persistence.save(record);
    const recovered = openHandoffForm(origin, ports);
    await recovered.load();
    await recovered.retry();
    expect(recovered.getState()).toMatchObject({
      kind: "transfer",
      record,
      run: { status: "error", message: "Resolve file.ts" },
    });
    expect(await persistence.load(origin)).toEqual(record);
  });

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
      { ...destination, workspaceReviewDigest: "b".repeat(64) },
      { ...destination, stoppedWorkReview: emptyReview.stoppedWork.review },
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
      ...emptyReview,
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
    ports.prepare = async (record) => ({
      ...destination,
      state: "released",
      workspaceReviewDigest: record.workspaceReviewDigest,
      stoppedWorkReview: record.stoppedWorkReview,
    });
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
    ports.validate = async () => emptyReview;
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
      return {
        ...destination,
        state: "active",
        workspaceReviewDigest: record.workspaceReviewDigest,
        stoppedWorkReview: record.stoppedWorkReview,
      };
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

  it("keeps an interrupted destination cleanup resumable and refuses starting over", async () => {
    const { ports, persistence, calls } = fixture();
    const record = restoreCancelledHandoffRecord({
      origin,
      destination: { serverId: "destination", label: "VPS" },
      snapshot: {
        ...destination,
        state: "cancelled",
        cleanupComplete: false,
        cancellationAccepted: true,
      },
    });
    await persistence.save(record);
    const model = openHandoffForm(origin, ports);
    await model.load();
    expect(handoffFormActions(model.getState())).toEqual({ primary: "retry", canCancel: false });
    model.startOver();
    expect(model.getState().kind).toBe("transfer");
    await model.retry();
    expect(calls).toEqual([`cancel:${transferId}`]);
    expect(handoffFormActions(model.getState())).toEqual({
      primary: "startOver",
      canCancel: false,
    });
  });

  it("restores a cancellation that preceded source preparation only for the matching reservation", () => {
    const input = {
      origin,
      destination: { serverId: "destination", label: "VPS" },
      snapshot: { ...destination, state: "reserved" as const, manifestDigest: null },
      proof: {
        publicKey: "source-key",
        receipt: {
          version: 1 as const,
          outcome: "cancelled" as const,
          transferId,
          sourceServerId: origin.sourceServerId,
          destinationServerId: "destination",
          reservationId: destination.reservationId,
          signature: "signed-proof",
        },
      },
    };
    expect(restoreCancelledHandoffRecord(input)).toMatchObject({ intent: "cancel", transferId });
    for (const field of ["transferId", "sourceServerId", "destinationServerId", "reservationId"]) {
      expect(() =>
        restoreCancelledHandoffRecord({
          ...input,
          proof: { ...input.proof, receipt: { ...input.proof.receipt, [field]: "wrong" } },
        }),
      ).toThrow("does not match");
    }
    expect(() =>
      restoreCancelledHandoffRecord({
        ...input,
        snapshot: { ...input.snapshot, state: "released" },
      }),
    ).toThrow("released transfer");
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
