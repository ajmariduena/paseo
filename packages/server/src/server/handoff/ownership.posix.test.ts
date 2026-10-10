import { randomUUID } from "node:crypto";
import { formatPeerMessage } from "@getpaseo/protocol/peer-message";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test as platformTest, vi } from "vitest";
import { HandoffOwnership, verifyHandoffRelease, verifyHandoffCancellation } from "./ownership.js";
import { writeJournal } from "./artifacts.js";
import { syncFilePublication, writeJsonFileAtomic } from "../atomic-file.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentStorage, type StoredAgentRecord } from "../agent/agent-storage.js";
import { AgentQueueStore, type HandoffQueue } from "../agent-queue/store.js";
import { FileUploadStore } from "../file-upload/index.js";
import { formatAgentMessage, parseAgentMessage } from "../agent/agent-messages/index.js";
import {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  createPersistedWorkspaceRecord,
} from "../workspace-registry.js";
import { createHandoffPublication, type HandoffPublication } from "./publication.js";
import { HandoffDestination } from "./destination.js";
import { HandoffArchiveStore } from "./archive.js";
import { packHandoffArchive, readHandoffBundle } from "./bundle.js";
import { captureClaudeSession } from "../agent/providers/claude/handoff.js";
import { claudeProjectDirSync } from "../agent/providers/claude/project-dir.js";
import { captureWorkspace } from "./workspace.js";
import { HandoffSource } from "./source.js";
import { WorkspaceSetupRuntime } from "../workspace-setup-runtime.js";
import { writeHandoffHistory } from "./history.js";

const test = platformTest.skipIf(process.platform === "win32");
let root: string;
let cwd: string;
let directory: string;
let ownership: HandoffOwnership;
const sourceServerId = "source-host";
const digest = "a".repeat(64);
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "paseo-handoff-release-"));
  cwd = path.join(root, "workspace");
  directory = path.join(root, "ownership");
  await mkdir(cwd);
  ownership = new HandoffOwnership({ directory, sourceServerId });
  await ownership.initialize();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("release seals agent-record writes before verification and retains that seal after restart", async () => {
  const input = {
    id: randomUUID(),
    cwd,
    workspaceId: "sealed-workspace",
    agentIds: ["sealed-agent"],
    destinationServerId: "destination-host",
    reservationId: randomUUID(),
  };
  const storagePath = path.join(root, "sealed-agents");
  const createStorage = () =>
    new AgentStorage(storagePath, createTestLogger(), undefined, undefined, (record) =>
      ownership.acquireAgentRecordMutation({
        agentId: record.id,
        workspaceId: record.workspaceId,
        cwd: record.cwd,
      }),
    );
  let agents = createStorage();
  const seed = await agents.upsert({
    id: input.agentIds[0],
    cwd,
    workspaceId: input.workspaceId,
    provider: "claude",
    createdAt: "2026-10-10T00:00:00Z",
    updatedAt: "2026-10-10T00:00:00Z",
    lastStatus: "closed",
    labels: {},
    title: "Captured conversation",
  });
  await ownership.prepare(input);
  await ownership.markReady(input.id, digest);
  const binding = {
    version: 1 as const,
    transferId: input.id,
    sourceServerId,
    destinationServerId: input.destinationServerId,
    reservationId: input.reservationId,
    manifestDigest: digest,
  };
  await expect(
    ownership.release(input.id, binding, async () => {
      await expect(agents.setTitle(seed.id, "Late callback")).rejects.toMatchObject({
        code: "fenced",
      });
      await expect(agents.remove(seed.id)).rejects.toMatchObject({ code: "fenced" });
      await expect(agents.checkpointClosedAgent(seed.id)).resolves.toEqual(seed);
      throw new Error("injected verification failure");
    }),
  ).rejects.toThrow("injected verification failure");
  ownership = new HandoffOwnership({ directory, sourceServerId });
  await ownership.initialize();
  agents = createStorage();
  await expect(agents.setTitle(seed.id, "After restart")).rejects.toMatchObject({ code: "fenced" });
  expect(await agents.get(seed.id)).toEqual(seed);
  await ownership.cancel(input.id);
  await agents.repairPendingPersistence(seed.id);
  expect(await agents.get(seed.id)).toEqual(seed);
  await agents.setTitle(seed.id, "After durable cancellation");
  expect((await agents.get(seed.id))?.title).toBe("After durable cancellation");
});

test("release refuses an agent record publication until its directory sync finishes", async () => {
  const { input, binding } = await prepare();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let holdPublication = false;
  const agents = new AgentStorage(
    path.join(root, "publishing-agents"),
    createTestLogger(),
    undefined,
    async (file, publicationRoot) => {
      if (holdPublication) {
        entered.resolve();
        await finish.promise;
      }
      await syncFilePublication(file, publicationRoot);
    },
    (record) =>
      ownership.acquireAgentRecordMutation({
        agentId: record.id,
        cwd: record.cwd,
        workspaceId: record.workspaceId,
      }),
  );
  const seed = await agents.upsert({
    id: input.agentIds[0],
    cwd,
    workspaceId: input.workspaceId,
    provider: "claude",
    labels: {},
    createdAt: "2026-10-10T00:00:00Z",
    updatedAt: "2026-10-10T00:00:00Z",
    lastStatus: "closed",
  });
  holdPublication = true;
  const writing = agents.addPendingRestartNote(seed.id, [
    { id: "work", kind: "shell", label: "Stopped task" },
  ]);
  await entered.promise;
  try {
    await expect(ownership.release(input.id, binding, async () => {})).rejects.toThrow(
      "mutations are still running",
    );
  } finally {
    finish.resolve();
  }
  await writing;
  const committed = await agents.get(seed.id);
  const receipt = await ownership.release(input.id, binding, async () => {
    expect(await agents.checkpointClosedAgent(seed.id)).toEqual(committed);
  });
  expect(verifyHandoffRelease(receipt, binding, ownership.status(input.id).publicKey)).toBe(true);
  await expect(agents.setTitle(seed.id, "After release")).rejects.toMatchObject({ code: "fenced" });
  expect(() => agents.beginDelete(seed.id)).toThrow("sealed by handoff");
});

test("a failed seal acknowledgement cannot run verification and recovers a sealed ready transfer", async () => {
  const { input, binding } = await prepare();
  const interrupted = new HandoffOwnership({
    directory,
    sourceServerId,
    write: async (file, value) => {
      await writeJournal(file, value);
      throw new Error("seal acknowledgement lost");
    },
  });
  await interrupted.initialize();
  let verified = false;
  await expect(
    interrupted.release(input.id, binding, async () => {
      verified = true;
    }),
  ).rejects.toThrow("seal acknowledgement lost");
  expect(verified).toBe(false);
  ownership = new HandoffOwnership({ directory, sourceServerId });
  await ownership.initialize();
  expect(ownership.status(input.id).state).toBe("ready");
  expect(() => ownership.acquireAgentRecordMutation({ cwd, agentId: input.agentIds[0] })).toThrow(
    "sealed by handoff",
  );
  await ownership.cancel(input.id);
  ownership.acquireAgentRecordMutation({ cwd, agentId: input.agentIds[0] })();
});

test("cancellation before preparation survives restart and refuses a delayed prepare", async () => {
  const input = {
    transferId: randomUUID(),
    destinationServerId: "destination-host",
    reservationId: randomUUID(),
  };
  const cancelled = await ownership.cancelReservation(input);
  expect(
    verifyHandoffCancellation(cancelled, {
      version: 1,
      outcome: "cancelled",
      sourceServerId,
      ...input,
    }),
  ).toBe(true);
  const restarted = new HandoffOwnership({ directory, sourceServerId });
  await restarted.initialize();
  expect(await restarted.cancelReservation(input)).toEqual(cancelled);
  await expect(
    restarted.prepare({
      id: input.transferId,
      workspaceId: "source-workspace",
      cwd,
      agentIds: [],
      destinationServerId: input.destinationServerId,
      reservationId: input.reservationId,
    }),
  ).rejects.toMatchObject({ code: "invalid_state" });
  expect(await restarted.withMutation({ cwd }, async () => "source remains usable")).toBe(
    "source remains usable",
  );
  await expect(
    restarted.cancelReservation({ ...input, reservationId: randomUUID() }),
  ).rejects.toMatchObject({ code: "conflict" });
});

test("a failed cancellation journal write cannot issue a cleanup proof or release the source fence", async () => {
  const input = {
    id: randomUUID(),
    workspaceId: "source-workspace",
    cwd,
    agentIds: [],
    destinationServerId: "destination-host",
    reservationId: randomUUID(),
  };
  await ownership.prepare(input);
  const failing = new HandoffOwnership({
    directory,
    sourceServerId,
    write: async () => {
      throw new Error("disk full");
    },
  });
  await failing.initialize();
  await expect(
    failing.cancelReservation({
      transferId: input.id,
      destinationServerId: input.destinationServerId,
      reservationId: input.reservationId,
    }),
  ).rejects.toThrow("disk full");
  const restarted = new HandoffOwnership({ directory, sourceServerId });
  await restarted.initialize();
  expect(restarted.status(input.id).state).toBe("preparing");
  await expect(restarted.withMutation({ cwd }, async () => "unsafe")).rejects.toMatchObject({
    code: "fenced",
  });
});

test("a lost durable cancellation acknowledgement recovers the same proof without restoring the fence", async () => {
  const transferId = randomUUID();
  const input = {
    id: transferId,
    workspaceId: "source-workspace",
    cwd,
    agentIds: [],
    destinationServerId: "destination-host",
    reservationId: randomUUID(),
  };
  const prepared = await ownership.prepare(input);
  const interrupted = new HandoffOwnership({
    directory,
    sourceServerId,
    write: async (file, value) => {
      await writeJournal(file, value);
      throw new Error("lost acknowledgement");
    },
  });
  await interrupted.initialize();
  const request = {
    transferId,
    destinationServerId: input.destinationServerId,
    reservationId: input.reservationId,
  };
  await expect(interrupted.cancelReservation(request)).rejects.toThrow("lost acknowledgement");
  await expect(interrupted.withMutation({ cwd }, async () => "unsafe")).rejects.toMatchObject({
    code: "storage_uncertain",
  });
  const restarted = new HandoffOwnership({ directory, sourceServerId });
  await restarted.initialize();
  const proof = await restarted.cancelReservation(request);
  expect(
    verifyHandoffCancellation(
      proof,
      { ...request, version: 1, outcome: "cancelled", sourceServerId },
      prepared.publicKey,
    ),
  ).toBe(true);
  expect(restarted.status(transferId).state).toBe("cancelled");
  expect(await restarted.withMutation({ cwd }, async () => "resumed")).toBe("resumed");
});

test.each(["cancel", "release"])(
  "%s wins the durable cancellation/release race without issuing both proofs",
  async (first) => {
    const transferId = randomUUID();
    const input = {
      id: transferId,
      workspaceId: "source-workspace",
      cwd,
      agentIds: [],
      destinationServerId: "destination-host",
      reservationId: randomUUID(),
    };
    const prepared = await ownership.prepare(input);
    await ownership.markReady(transferId, digest);
    const binding = {
      version: 1 as const,
      transferId,
      sourceServerId,
      destinationServerId: input.destinationServerId,
      reservationId: input.reservationId,
      manifestDigest: digest,
    };
    const cancel = () =>
      ownership.cancelReservation({
        transferId,
        destinationServerId: input.destinationServerId,
        reservationId: input.reservationId,
      });
    const release = () => ownership.release(transferId, binding, async () => {});
    const operations = first === "cancel" ? [cancel(), release()] : [release(), cancel()];
    const [winner, loser] = await Promise.allSettled(operations);
    expect(winner.status).toBe("fulfilled");
    expect(loser).toMatchObject({ status: "rejected", reason: { code: "invalid_state" } });
    const restarted = new HandoffOwnership({ directory, sourceServerId });
    await restarted.initialize();
    expect(restarted.status(transferId).state).toBe(first === "cancel" ? "cancelled" : "released");
    if (first === "cancel") {
      expect(
        verifyHandoffCancellation(
          winner.status === "fulfilled" ? winner.value : null,
          {
            version: 1,
            outcome: "cancelled",
            transferId,
            sourceServerId,
            destinationServerId: input.destinationServerId,
            reservationId: input.reservationId,
          },
          prepared.publicKey,
        ),
      ).toBe(true);
    } else {
      await expect(
        restarted.cancelReservation({
          transferId,
          destinationServerId: input.destinationServerId,
          reservationId: input.reservationId,
        }),
      ).rejects.toMatchObject({ code: "invalid_state" });
    }
  },
);

function createSourceFixture(
  overrides: Partial<ConstructorParameters<typeof HandoffSource>[0]> = {},
) {
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "source-workspace",
    projectId: "source-project",
    cwd,
    kind: "directory",
    displayName: "Source",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const captures = path.join(root, "source-captures");
  const source = new HandoffSource({
    schedules: {
      reviewForHandoff: async () => [],
      pauseForHandoff: async () => {},
      exportForHandoff: async () => ({ version: 1, schedules: [] }),
      estimateForHandoff: async () => 28,
    },
    pullRequestWatches: { reviewForHandoff: async () => [], stopForHandoff: async () => {} },
    queues: {
      holdForHandoff: async () => {},
      entries: () => [],
      exportForHandoff: async () => ({ version: 1, entries: [] }),
    },
    directory: captures,
    serverId: sourceServerId,
    logger: createTestLogger(),
    ownership,
    archives: new HandoffArchiveStore(path.join(root, "source-archives")),
    destination: {
      hasConversation: () => false,
      withConversationArchive: async () => {
        throw new Error("No previous transfer in this test");
      },
    },
    workspaces: { get: async () => workspace, list: async () => [workspace] },
    agents: new AgentStorage(path.join(root, "agents"), createTestLogger()),
    agentManager: {
      getAgent: () => null,
      listAgents: () => [],
      closeAgent: async () => {},
      projectHistoryForHandoff: async () => [],
      checkpointPromptAnnotations: async () => {},
      recoverPromptAnnotationsForHandoff: async () => {},
    },
    terminals: {
      listDirectories: () => [],
      getTerminals: async () => [],
      killTerminalAndWait: async () => {},
    },
    setup: { activeIds: () => [], stop: async () => {} },
    ...overrides,
  });
  return {
    source,
    captures,
    request: {
      transferId: randomUUID(),
      workspaceId: workspace.workspaceId,
      agentIds: [],
      destinationServerId: "destination",
      reservationId: randomUUID(),
    },
  };
}

test.each(["writers", "watches", "schedules"])(
  "source stop timeout during %s retains cleanup and joins the same stop on retry",
  async (phase) => {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let stopCalls = 0;
    const stop = async () => {
      stopCalls++;
      entered.resolve();
      await finish.promise;
    };
    const { source, request, captures } = createSourceFixture({
      setup: {
        activeIds: () => [],
        stop: phase === "writers" ? stop : async () => {},
      },
      pullRequestWatches: {
        reviewForHandoff: async () => [],
        stopForHandoff: phase === "watches" ? stop : async () => {},
      },
      schedules: {
        reviewForHandoff: async () => [],
        pauseForHandoff: phase === "schedules" ? stop : async () => {},
        exportForHandoff: async () => ({ version: 1, schedules: [] }),
        estimateForHandoff: async () => 28,
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const preparing = source.prepare(request);
    let settled = false;
    const outcome = preparing
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(settled).toBe(true);
      expect(await outcome).toMatchObject({ code: "stop_uncertain" });
      expect(ownership.status(request.transferId).state).toBe("preparing");
      await expect(readdir(captures)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(ownership.acquireMutation({ cwd })).rejects.toMatchObject({ code: "fenced" });
      await expect(source.cancel(request)).rejects.toMatchObject({ code: "stop_uncertain" });
      expect(ownership.cancellation(request.transferId)).toBeNull();

      // The failed wait released the request queue, but the stop operation still belongs to it.
      const retry = source.prepare(request);
      const retried = expect(retry).rejects.toMatchObject({ code: "stop_uncertain" });
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
      await vi.advanceTimersByTimeAsync(30_000);
      await retried;
      expect(stopCalls).toBe(1);
    } finally {
      finish.resolve();
      await outcome;
      await source.dispose();
      vi.useRealTimers();
    }
    // Finishing after the deadline never captures or certifies in the background.
    expect(ownership.status(request.transferId).state).toBe("preparing");
    await expect(readdir(captures)).rejects.toMatchObject({ code: "ENOENT" });
    const recovered = createSourceFixture().source;
    expect((await recovered.prepare(request)).source.state).toBe("ready");
    await recovered.dispose();
  },
);

test("source stop failure after a timeout remains observable and permits a fresh retry", async () => {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let stopCalls = 0;
  const { source, request, captures } = createSourceFixture({
    setup: {
      activeIds: () => [],
      stop: async () => {
        stopCalls++;
        if (stopCalls === 1) {
          entered.resolve();
          await finish.promise;
        }
      },
    },
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const preparing = source.prepare(request);
  const expired = expect(preparing).rejects.toMatchObject({ code: "stop_uncertain" });
  try {
    await entered.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    await expired;
    const retry = source.prepare(request);
    const failure = new Error("late provider stop failure");
    const failed = expect(retry).rejects.toMatchObject({ errors: [failure] });
    await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));
    finish.reject(failure);
    await failed;
    expect(stopCalls).toBe(1);
    expect(ownership.status(request.transferId).state).toBe("preparing");
    await expect(readdir(captures)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await source.prepare(request)).source.state).toBe("ready");
    expect(stopCalls).toBe(3);
  } finally {
    finish.resolve();
    await source.dispose();
    vi.useRealTimers();
  }
});

test("source drain timeout keeps admitted mutations fenced until they finish", async () => {
  const finishMutation = await ownership.acquireMutation({ cwd });
  const entered = Promise.withResolvers<void>();
  const { source, request, captures } = createSourceFixture({
    setup: {
      activeIds: () => [],
      stop: async () => {
        entered.resolve();
      },
    },
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const preparing = source.prepare(request);
  let settled = false;
  const outcome = preparing
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true;
    });
  try {
    await entered.promise;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toBe(true);
    expect(await outcome).toMatchObject({ code: "stop_uncertain" });
    await expect(ownership.markReady(request.transferId, digest)).rejects.toMatchObject({
      code: "invalid_state",
    });
    await expect(source.cancel(request)).rejects.toMatchObject({ code: "stop_uncertain" });
    await expect(readdir(captures)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    finishMutation();
    await outcome;
    await source.dispose();
    vi.useRealTimers();
  }
  expect(ownership.status(request.transferId).state).toBe("preparing");
  const recovered = createSourceFixture().source;
  const cancelled = await recovered.cancel(request);
  expect(cancelled.receipt.outcome).toBe("cancelled");
  const afterCancel = await ownership.acquireMutation({ cwd });
  afterCancel();
  await recovered.dispose();
});

test("source preparation keeps ownership fenced after uncertain cleanup and retries before capture", async () => {
  const transferId = randomUUID();
  const workspace = createPersistedWorkspaceRecord({
    workspaceId: "source-workspace",
    projectId: "source-project",
    cwd,
    kind: "directory",
    displayName: "Source",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const captures = path.join(root, "source-captures");
  const setup = new WorkspaceSetupRuntime();
  const entered = Promise.withResolvers<void>();
  setup.start(workspace.workspaceId, async (signal) => {
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
      entered.resolve();
    });
  });
  await entered.promise;
  let stopFails = true;
  const failure = new Error("setup exit is unconfirmed");
  const createSource = (sourceOwnership = ownership) =>
    createSourceFixture({
      ownership: sourceOwnership,
      setup: {
        activeIds: (workspaceId) => setup.activeIds(workspaceId),
        stop: async () => {
          if (stopFails) throw failure;
          await setup.stop(workspace.workspaceId);
        },
      },
    }).source;
  let source = createSource();
  const request = {
    transferId,
    workspaceId: workspace.workspaceId,
    agentIds: [],
    destinationServerId: "destination",
    reservationId: randomUUID(),
  };
  const preview = await source.preview(workspace.workspaceId);
  expect(preview.stoppedWork).toEqual({
    agentIds: [],
    terminals: [],
    setupOperations: 1,
    queuedMessages: 0,
    queuedBytes: 0,
    scheduledBytes: 28,
    review: {
      agents: [],
      terminals: [],
      setupIds: setup.activeIds(workspace.workspaceId),
      pullRequestWatches: [],
      schedules: [],
    },
  });
  const reviewedRequest = { ...request, stoppedWorkReview: preview.stoppedWork?.review };
  await expect(source.prepare(reviewedRequest)).rejects.toMatchObject({ errors: [failure] });
  expect(setup.countActive(workspace.workspaceId)).toBe(1);
  expect(ownership.status(transferId).state).toBe("preparing");
  await expect(readdir(captures)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(ownership.withMutation({ cwd }, async () => {})).rejects.toMatchObject({
    code: "fenced",
  });
  await source.dispose();
  const recoveredOwnership = new HandoffOwnership({ directory, sourceServerId });
  await recoveredOwnership.initialize();
  expect(recoveredOwnership.status(transferId).stoppedWorkReview).toEqual(
    reviewedRequest.stoppedWorkReview,
  );
  source = createSource(recoveredOwnership);
  await setup.stop(workspace.workspaceId);
  const replacementEntered = Promise.withResolvers<void>();
  setup.start(workspace.workspaceId, async (signal) => {
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
      replacementEntered.resolve();
    });
  });
  await replacementEntered.promise;
  stopFails = false;
  await expect(source.prepare(reviewedRequest)).rejects.toMatchObject({ code: "review_changed" });
  expect(setup.countActive(workspace.workspaceId)).toBe(1);
  await setup.stop(workspace.workspaceId);
  const prepared = await source.prepare(reviewedRequest);
  expect(prepared.source.state).toBe("ready");
  expect(setup.countActive(workspace.workspaceId)).toBe(0);
  expect(await source.prepare(reviewedRequest)).toEqual(prepared);
  const lateSetupEntered = Promise.withResolvers<void>();
  setup.start(workspace.workspaceId, async (signal) => {
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
      lateSetupEntered.resolve();
    });
  });
  await lateSetupEntered.promise;
  await expect(source.release(transferId)).rejects.toMatchObject({ code: "stop_uncertain" });
  expect(recoveredOwnership.status(transferId).state).toBe("ready");
  await setup.stop(workspace.workspaceId);
  const receipt = await source.release(transferId);
  expect(receipt.manifestDigest).toBe(prepared.manifest.entrypoint.sha256);
  await source.dispose();
});

test("reserves stable destination identities across restart without dropping unprepared conversations", async () => {
  const transferId = randomUUID();
  const store = new HandoffArchiveStore(path.join(root, "archives"));
  const options = {
    directory: path.join(root, "destination-journal"),
    serverId: "destination-host",
    archives: store,
  };
  const destination = new HandoffDestination(options);
  await destination.initialize();
  const request = {
    transferId,
    sourceServerId,
    sourceWorkspaceId: "source-workspace",
    sourceAgentIds: ["first", "second"],
    destinationParent: root,
  };
  const reserved = await destination.reserve(request);
  expect(reserved.agentMappings.map((mapping) => mapping.sourceAgentId)).toEqual([
    "first",
    "second",
  ]);
  expect(new Set(reserved.agentMappings.map((mapping) => mapping.destinationAgentId)).size).toBe(2);
  const restarted = new HandoffDestination(options);
  await restarted.initialize();
  expect(await restarted.reserve(request)).toEqual(reserved);
  await expect(
    restarted.reserve({ ...request, sourceWorkspaceId: "different" }),
  ).rejects.toMatchObject({ code: "conflict" });
  await expect(restarted.stage(transferId)).rejects.toMatchObject({
    code: "invalid_state",
  });
});

test("refuses invalid or duplicate schedule reviews before reserving destination identities", async () => {
  const destination = new HandoffDestination({
    directory: path.join(root, "destination-journal"),
    serverId: "destination-host",
    archives: new HandoffArchiveStore(path.join(root, "archives")),
  });
  await destination.initialize();
  const schedule = {
    id: "1234abcd",
    name: "Build",
    kind: "schedule" as const,
    status: "active" as const,
    cadence: "0 0 1 1 * (UTC)",
    digest: "a".repeat(64),
    runCount: 0,
    omittedSettings: [],
    omittedMcpServers: [],
  };
  const transferId = randomUUID();
  const request = {
    transferId,
    sourceServerId,
    sourceWorkspaceId: "source-workspace",
    sourceAgentIds: [],
    destinationParent: root,
    stoppedWorkReview: { agents: [], setupIds: [], terminals: [], schedules: [schedule] },
  };
  for (const schedules of [[schedule, schedule], [{ ...schedule, id: "../escape" }]]) {
    await expect(
      destination.reserve({
        ...request,
        stoppedWorkReview: { ...request.stoppedWorkReview, schedules },
      }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    expect(() => destination.status(transferId)).toThrow();
  }
  expect((await destination.reserve(request)).state).toBe("reserved");
});

async function capturedQueuedUpload() {
  const sourceHome = path.join(root, "upload-source");
  const id = "upload_fixture-file";
  const fileName = "queued-file.bin";
  const sourcePath = path.join(sourceHome, "uploads", id, fileName);
  await mkdir(path.dirname(sourcePath), { recursive: true });
  const bytes = Buffer.from([0, 255, 128, 7]);
  await writeFile(sourcePath, bytes);
  const attachment = {
    type: "uploaded_file" as const,
    id,
    fileName,
    path: sourcePath,
    mimeType: "application/octet-stream",
    size: bytes.length,
  };
  const queueBlobsDirectory = path.join(root, "queue-blobs");
  const captured = await new FileUploadStore({ paseoHome: sourceHome }).captureForHandoff(
    attachment,
    { directory: queueBlobsDirectory, maxBytes: 32 },
  );
  return { captured, directory: queueBlobsDirectory, bytes };
}

async function nativeDestinationFixture(
  input: {
    write?: typeof writeJournal;
    agentIds?: string[];
    publication?: HandoffPublication;
    continuationMode?: "native" | "context";
    includeHistory?: boolean;
    contextCollision?: boolean;
    queue?: HandoffQueue;
    queueBlobsDirectory?: string;
  } = {},
) {
  const transferId = randomUUID();
  const store = new HandoffArchiveStore(path.join(root, "archives"));
  const claudeHome = path.join(root, "destination-claude");
  const options = {
    directory: path.join(root, "destination-journal"),
    serverId: "destination-host",
    archives: store,
    write: input.write,
    publication: input.publication,
    resolveClaudeRuntime: async () => ({ configDir: claudeHome, cliVersion: "2.1.295" }),
  };
  const destination = new HandoffDestination(options);
  await destination.initialize();
  const reservation = await destination.reserve({
    transferId,
    sourceServerId,
    sourceWorkspaceId: "source-workspace",
    sourceAgentIds: input.agentIds ?? ["source-agent"],
    destinationParent: root,
    continuationMode: input.continuationMode,
  });
  const source = await ownership.prepare({
    id: transferId,
    cwd,
    workspaceId: "source-workspace",
    agentIds: input.agentIds ?? ["source-agent"],
    destinationServerId: options.serverId,
    reservationId: reservation.reservationId,
  });
  const sourceConfigDir = path.join(root, "source-claude");
  const sessionId = randomUUID();
  const project = claudeProjectDirSync(cwd, { configDir: sourceConfigDir });
  await mkdir(project, { recursive: true });
  const transcript =
    JSON.stringify({
      type: "user",
      sessionId,
      message: { role: "user", content: "continue the previous work" },
    }) + "\n";
  await writeFile(path.join(project, `${sessionId}.jsonl`), transcript);
  const sessionDirectory = path.join(root, "session-capture");
  await captureClaudeSession({
    handle: { provider: "claude", sessionId },
    cwd,
    configDir: sourceConfigDir,
    cliVersion: "2.1.295",
    artifactDirectory: sessionDirectory,
  });
  const workspaceDirectory = path.join(root, "workspace-capture");
  if (input.contextCollision)
    await writeFile(
      path.join(cwd, `handoff-context-${reservation.reservationId}`),
      "Existing user file",
    );
  await captureWorkspace({ cwd, artifactDirectory: workspaceDirectory });
  const historyPath = path.join(root, "history.json");
  if (input.includeHistory)
    await writeHandoffHistory(historyPath, {
      version: 1,
      sourceAgentId: "source-agent",
      epoch: transferId,
      rows: [
        {
          seq: 1,
          timestamp: new Date().toISOString(),
          item: { type: "user_message", text: "continue the previous work" },
        },
      ],
    });
  const queuePath = input.queue ? path.join(root, "queue.json") : undefined;
  if (queuePath) await writeJournal(queuePath, input.queue);
  const manifest = await packHandoffArchive({
    store,
    transferId,
    sourceServerId,
    sourceWorkspaceId: "source-workspace",
    sourceCwd: cwd,
    workspaceDirectory,
    conversations: [
      {
        sourceAgentId: "source-agent",
        title: "Imported conversation",
        artifactDirectory: sessionDirectory,
        historyPath: input.includeHistory ? historyPath : undefined,
        queuePath,
        queueBlobsDirectory: input.queueBlobsDirectory,
      },
    ],
  });
  await destination.bindSource({ transferId, publicKey: source.publicKey, manifest });
  const importedPath = path.join(
    claudeHome,
    "projects",
    `paseo-handoff-${reservation.agentMappings.find((item) => item.sourceAgentId === "source-agent")!.destinationAgentId}`,
    `${sessionId}.jsonl`,
  );
  return {
    destination,
    transferId,
    options,
    reservation,
    manifest,
    importedPath,
    transcript,
    claudeHome,
  };
}

test("context export refuses missing readable history without creating a native session", async () => {
  const { destination, transferId, claudeHome, reservation } = await nativeDestinationFixture({
    continuationMode: "context",
  });
  await expect(destination.stage(transferId)).rejects.toThrow("requires complete captured history");
  expect(destination.status(transferId).state).toBe("receiving");
  await expect(readdir(claudeHome)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readdir(reservation.stagingCwd)).rejects.toMatchObject({ code: "ENOENT" });
});

test("context export refuses collision with existing workspace content", async () => {
  const { destination, transferId, reservation } = await nativeDestinationFixture({
    continuationMode: "context",
    includeHistory: true,
    contextCollision: true,
  });
  await expect(destination.stage(transferId)).rejects.toMatchObject({ code: "invalid_artifact" });
  expect(
    await readFile(path.join(cwd, `handoff-context-${reservation.reservationId}`), "utf8"),
  ).toBe("Existing user file");
  await expect(readdir(reservation.stagingCwd)).rejects.toMatchObject({ code: "ENOENT" });
});

test("stages native conversations under reserved identities and recovers them after restart", async () => {
  const { destination, transferId, options, reservation, manifest, importedPath, transcript } =
    await nativeDestinationFixture();
  const staged = await destination.stage(transferId);
  expect(staged.state).toBe("staged");
  expect(await readFile(importedPath, "utf8")).toBe(transcript);
  await expect(readdir(staged.destinationCwd)).rejects.toMatchObject({ code: "ENOENT" });
  const recovered = new HandoffDestination(options);
  await recovered.initialize();
  expect(await recovered.stage(transferId)).toEqual(staged);
  await ownership.markReady(transferId, manifest.entrypoint.sha256);
  const receipt = await ownership.release(
    transferId,
    {
      version: 1,
      transferId,
      sourceServerId,
      destinationServerId: options.serverId,
      reservationId: reservation.reservationId,
      manifestDigest: manifest.entrypoint.sha256,
    },
    async () => {},
  );
  expect((await recovered.acceptRelease(transferId, receipt)).state).toBe("released");
  await expect(recovered.cancel(transferId, null)).rejects.toMatchObject({ code: "invalid_state" });
  expect(await readFile(importedPath, "utf8")).toBe(transcript);
});

test.each(["native", "context"] as const)(
  "%s context publication recovers after interruption",
  async (continuationMode) => {
    let failOnce = true;
    const installed: string[] = [];
    const fixture = await nativeDestinationFixture({
      continuationMode,
      includeHistory: true,
      publication: {
        async install(input) {
          installed.push(input.record.agentMappings[0].destinationAgentId);
          if (failOnce) {
            failOnce = false;
            throw new Error("interrupted publication");
          }
        },
        async publish() {},
      },
    });
    const { destination, transferId, reservation, options, manifest } = fixture;
    await destination.stage(transferId);
    await ownership.markReady(transferId, manifest.entrypoint.sha256);
    const receipt = await ownership.release(
      transferId,
      {
        version: 1,
        transferId,
        sourceServerId,
        destinationServerId: options.serverId,
        reservationId: reservation.reservationId,
        manifestDigest: manifest.entrypoint.sha256,
      },
      async () => {},
    );
    await destination.acceptRelease(transferId, receipt);
    await expect(destination.activate(transferId)).rejects.toThrow("interrupted publication");
    const recovered = new HandoffDestination(options);
    await recovered.initialize();
    await recovered.recoverActivations();
    expect(recovered.status(transferId).state).toBe("active");
    expect(installed).toEqual([
      reservation.agentMappings[0].destinationAgentId,
      reservation.agentMappings[0].destinationAgentId,
    ]);
  },
);

test.each(["native", "context"] as const)(
  "%s legacy activation without queue metadata stays hidden until its empty Stop is durable",
  async (continuationMode) => {
    let current: HandoffDestination;
    let failSync = true;
    const logger = createTestLogger();
    const isVisible = (id: string) => current.isIdentityVisible(id);
    const queueDirectory = path.join(root, "agent-queues");
    function createStores() {
      const projects = new FileBackedProjectRegistry(path.join(root, "projects.json"), logger, {
        isVisible,
      });
      const workspaces = new FileBackedWorkspaceRegistry(
        path.join(root, "workspaces.json"),
        logger,
        { isVisible },
      );
      const agents = new AgentStorage(path.join(root, "agents"), logger, isVisible);
      const queues = new AgentQueueStore(queueDirectory, {
        sync: async (file, publicationRoot) => {
          await syncFilePublication(file, publicationRoot);
          if (failSync) throw new Error("empty Stop acknowledgement lost");
        },
      });
      const publication = createHandoffPublication({
        projects,
        workspaces,
        agents,
        queues,
        schedules: { installHandoffSchedules: async () => {} },
        agentManager: { publishStoredAgent: async () => {} },
      });
      return { projects, workspaces, agents, queues, publication };
    }
    const first = createStores();
    const fixture = await nativeDestinationFixture({
      continuationMode,
      includeHistory: true,
      publication: first.publication,
    });
    current = fixture.destination;
    const { transferId, reservation, manifest, options } = fixture;
    const captured = await options.archives.withVerifiedArchive(transferId, (archive) =>
      readHandoffBundle(archive, {
        sourceServerId,
        sourceWorkspaceId: "source-workspace",
        sourceAgentIds: ["source-agent"],
        manifestDigest: manifest.entrypoint.sha256,
      }),
    );
    expect(captured.bundle.version).toBe(3);
    expect(captured.bundle.conversations[0].queue).toBeUndefined();
    await current.stage(transferId);
    await ownership.markReady(transferId, manifest.entrypoint.sha256);
    const receipt = await ownership.release(
      transferId,
      {
        version: 1,
        transferId,
        sourceServerId,
        destinationServerId: options.serverId,
        reservationId: reservation.reservationId,
        manifestDigest: manifest.entrypoint.sha256,
      },
      async () => {},
    );
    await current.acceptRelease(transferId, receipt);
    await expect(current.activate(transferId)).rejects.toThrow("empty Stop acknowledgement lost");
    expect(await first.agents.list()).toEqual([]);
    expect(await first.workspaces.list()).toEqual([]);
    expect(await first.projects.list()).toEqual([]);

    failSync = false;
    const recovered = createStores();
    await recovered.queues.load();
    current = new HandoffDestination({ ...options, publication: recovered.publication });
    await current.initialize();
    await current.recoverActivations();
    const active = await current.activate(transferId);
    const agentId = reservation.agentMappings[0].destinationAgentId;
    expect(active.state).toBe("active");
    expect((await recovered.agents.list()).map((agent) => agent.id)).toEqual([agentId]);
    const rebootedQueues = new AgentQueueStore(queueDirectory);
    await rebootedQueues.load();
    await rebootedQueues.holdForRestart(agentId);
    expect(rebootedQueues.isHeldForUserStop(agentId)).toBe(true);
    await rebootedQueues.enqueue(
      agentId,
      {
        id: "late-result",
        origin: "delegation_wake",
        senderAgentId: null,
        prompt: null,
        textPreview: "Result arrived after activation",
        wake: { cohortKey: "cohort", generation: 1 },
      },
      new Date().toISOString(),
    );
    expect(await rebootedQueues.dequeueNext(agentId)).toBeNull();
    await rebootedQueues.resume(agentId);
    expect((await rebootedQueues.dequeueNext(agentId))?.entry.id).toBe("late-result");
  },
);

test.each([
  "before records",
  "partial records",
  "after records",
  "legacy after records",
  "before active journal",
  "after active journal",
])("recovers hidden destination publication after failure %s", async (failurePoint) => {
  let current: HandoffDestination;
  let failOnce = true;
  const logger = createTestLogger();
  const isVisible = (id: string) => current.isIdentityVisible(id);
  class InterruptedAgentStorage extends AgentStorage {
    override async installHandoffRecord(record: StoredAgentRecord): Promise<void> {
      if (failOnce && failurePoint === "partial records") {
        failOnce = false;
        throw new Error("interrupted publication");
      }
      await super.installHandoffRecord(record);
    }
  }
  const projects = new FileBackedProjectRegistry(
    path.join(root, "projects", "projects.json"),
    logger,
    { isVisible },
  );
  const workspaces = new FileBackedWorkspaceRegistry(
    path.join(root, "projects", "workspaces.json"),
    logger,
    { isVisible },
  );
  const agents = new InterruptedAgentStorage(path.join(root, "agents"), logger, isVisible);
  const publication = createHandoffPublication({
    schedules: { installHandoffSchedules: async () => {} },
    queues: new AgentQueueStore(path.join(root, "agent-queues"), {
      uploads: new FileUploadStore({ paseoHome: root }),
    }),
    projects,
    workspaces,
    agents,
    agentManager: { publishStoredAgent: async () => {} },
  });
  const interrupted: HandoffPublication = {
    async install(input) {
      if (failOnce && failurePoint === "before records") {
        failOnce = false;
        throw new Error("interrupted publication");
      }
      const legacy = failurePoint === "legacy after records";
      const record = legacy
        ? {
            ...input.record,
            preparedConversations: input.record.preparedConversations.map((conversation) => {
              if (conversation.mode !== "native") return conversation;
              const { runtime: _runtime, ...oldConversation } = conversation;
              return oldConversation;
            }),
          }
        : input.record;
      await publication.install({ ...input, record });
      if (failOnce && (failurePoint === "after records" || legacy)) {
        failOnce = false;
        throw new Error("interrupted publication");
      }
    },
    publish: publication.publish,
  };
  const write: typeof writeJournal = async (file, value) => {
    const active = JSON.stringify(value).includes('"state":"active"');
    if (active) {
      expect(await projects.list()).toEqual([]);
      expect(await workspaces.list()).toEqual([]);
      expect(await agents.list()).toEqual([]);
      expect(() =>
        current.assertMutationAllowed({ cwd: current.status(fixture.transferId).destinationCwd }),
      ).toThrow("finish activation");
    }
    if (active && failOnce && failurePoint === "before active journal") {
      failOnce = false;
      throw new Error("interrupted publication");
    }
    const persisted =
      failurePoint === "legacy after records"
        ? JSON.parse(JSON.stringify(value, (key, item) => (key === "runtime" ? undefined : item)))
        : value;
    await writeJournal(file, persisted);
    if (active && failOnce && failurePoint === "after active journal") {
      failOnce = false;
      throw new Error("interrupted publication");
    }
  };
  const upload = await capturedQueuedUpload();
  const queue: HandoffQueue = {
    version: 2,
    files: [upload.captured],
    entries: [
      {
        id: "queued-user-message",
        origin: "user",
        senderAgentId: null,
        createdAt: "2026-10-10T00:00:00Z",
        prompt: "Continue after I resume the queue",
      },
      {
        id: "queued-agent-message",
        origin: "agent",
        senderAgentId: "source-agent",
        createdAt: "2026-10-10T00:00:01Z",
        prompt: formatAgentMessage({
          id: "queued-agent-message",
          source: { kind: "agent-message", agentId: "source-agent", relation: "peer" },
          text: "Preserve the sender when moving this pending message",
        }),
      },
      {
        id: "legacy-peer-message",
        origin: "agent",
        senderAgentId: "source-agent",
        createdAt: "2026-10-10T00:00:02Z",
        prompt: [
          {
            type: "text",
            text: formatPeerMessage({
              sender: { agentId: "source-agent" },
              body: "Preserve this older queued message",
            }),
          },
          { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
        ],
      },
      {
        id: "pending-file",
        origin: "user",
        senderAgentId: null,
        createdAt: "2026-10-10T00:00:03Z",
        prompt: [upload.captured.attachment],
      },
    ],
  };
  const fixture = await nativeDestinationFixture({
    publication: interrupted,
    write,
    queue,
    queueBlobsDirectory: upload.directory,
  });
  current = fixture.destination;
  const { transferId, options, reservation, manifest } = fixture;
  await current.stage(transferId);
  await expect(current.activate(transferId)).rejects.toMatchObject({ code: "invalid_state" });
  await ownership.markReady(transferId, manifest.entrypoint.sha256);
  const receipt = await ownership.release(
    transferId,
    {
      version: 1,
      transferId,
      sourceServerId,
      destinationServerId: options.serverId,
      reservationId: reservation.reservationId,
      manifestDigest: manifest.entrypoint.sha256,
    },
    async () => {},
  );
  await current.acceptRelease(transferId, receipt);
  await expect(current.activate(transferId)).rejects.toThrow("interrupted publication");
  expect(await projects.list()).toEqual([]);
  expect(await workspaces.list()).toEqual([]);
  expect(await agents.list()).toEqual([]);
  expect(await agents.get(reservation.agentMappings[0].destinationAgentId)).toBeNull();
  expect(() => current.assertMutationAllowed({ cwd: reservation.destinationCwd })).toThrow(
    "finish activation",
  );
  const recoveredProjects = new FileBackedProjectRegistry(
    path.join(root, "projects", "projects.json"),
    logger,
    { isVisible },
  );
  const recoveredWorkspaces = new FileBackedWorkspaceRegistry(
    path.join(root, "projects", "workspaces.json"),
    logger,
    { isVisible },
  );
  const recoveredAgents = new AgentStorage(path.join(root, "agents"), logger, isVisible);
  const recoveredQueues = new AgentQueueStore(path.join(root, "agent-queues"), {
    uploads: new FileUploadStore({ paseoHome: root }),
  });
  await recoveredQueues.load();
  const recoveredPublication = createHandoffPublication({
    schedules: { installHandoffSchedules: async () => {} },
    queues: recoveredQueues,
    projects: recoveredProjects,
    workspaces: recoveredWorkspaces,
    agents: recoveredAgents,
    agentManager: { publishStoredAgent: async () => {} },
  });
  current = new HandoffDestination({
    ...options,
    write: writeJournal,
    publication: recoveredPublication,
  });
  await current.initialize();
  await current.recoverActivations();
  const active = await current.activate(transferId);
  expect(active.state).toBe("active");
  expect(await current.activate(transferId)).toEqual(active);
  expect((await recoveredProjects.list()).map((record) => record.projectId)).toEqual([
    reservation.projectId,
  ]);
  expect(
    (await recoveredWorkspaces.list()).map((record) => [record.workspaceId, record.kind]),
  ).toEqual([[reservation.workspaceId, "directory"]]);
  expect((await recoveredAgents.list()).map((record) => [record.id, record.lastStatus])).toEqual([
    [reservation.agentMappings[0].destinationAgentId, "closed"],
  ]);
  expect(() => current.assertMutationAllowed({ cwd: reservation.destinationCwd })).not.toThrow();
  const agentId = reservation.agentMappings[0].destinationAgentId;
  const importedQueue = await recoveredQueues.exportForHandoff(agentId);
  const importedUpload = importedQueue.files?.[0].attachment;
  if (!importedUpload) throw new Error("Missing installed queued file");
  expect(await readFile(importedUpload.path)).toEqual(upload.bytes);
  expect(importedUpload.path).not.toBe(upload.captured.attachment.path);
  expect(
    importedQueue.entries.map(({ origin, senderAgentId, prompt }) => ({
      origin,
      senderAgentId,
      prompt,
    })),
  ).toEqual([
    { origin: "user", senderAgentId: null, prompt: queue.entries[0].prompt },
    {
      origin: "agent",
      senderAgentId: agentId,
      prompt: formatAgentMessage({
        id: importedQueue.entries[1].id,
        source: { kind: "agent-message", agentId, relation: "peer" },
        text: "Preserve the sender when moving this pending message",
      }),
    },
    {
      origin: "agent",
      senderAgentId: agentId,
      prompt: [
        {
          type: "text",
          text: formatPeerMessage({
            sender: { agentId },
            body: "Preserve this older queued message",
          }),
        },
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
      ],
    },
    { origin: "user", senderAgentId: null, prompt: [importedUpload] },
  ]);
  expect(parseAgentMessage(String(importedQueue.entries[1].prompt))?.source?.agentId).toBe(agentId);
  expect(await recoveredQueues.dequeueNext(agentId)).toBeNull();
  expect((await recoveredAgents.get(agentId))?.persistence?.metadata?.claudeRuntime).toEqual(
    failurePoint === "legacy after records" ? undefined : active.claudeRuntime,
  );
  await recoveredAgents.setTitle(agentId, "Renamed after activation");
  await current.activate(transferId);
  expect((await recoveredAgents.get(agentId))?.title).toBe("Renamed after activation");
});

test("refuses an archive missing a reserved conversation before installing or staging files", async () => {
  const { destination, transferId, reservation, claudeHome } = await nativeDestinationFixture({
    agentIds: ["source-agent", "missing-agent"],
  });
  await expect(destination.stage(transferId)).rejects.toMatchObject({
    code: "conversation_mismatch",
  });
  expect(destination.status(transferId).state).toBe("receiving");
  await expect(readdir(claudeHome)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readdir(reservation.stagingCwd)).rejects.toMatchObject({ code: "ENOENT" });
});

test("refuses a queued sender outside the transferred conversations before publication", async () => {
  const { destination, transferId, reservation, claudeHome } = await nativeDestinationFixture({
    queue: {
      version: 1,
      entries: [
        {
          id: "outside-message",
          origin: "agent",
          senderAgentId: "agent-on-another-workspace",
          createdAt: "2026-10-10T00:00:00Z",
          prompt: "Retain my reply relationship",
        },
      ],
    },
  });
  await expect(destination.stage(transferId)).rejects.toMatchObject({ code: "invalid_artifact" });
  expect(destination.status(transferId).state).toBe("receiving");
  await expect(readdir(claudeHome)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readdir(reservation.stagingCwd)).rejects.toMatchObject({ code: "ENOENT" });
});

test("refuses a queued review from a different workspace before installing or staging files", async () => {
  const { destination, transferId, reservation, claudeHome } = await nativeDestinationFixture({
    queue: {
      version: 1,
      entries: [
        {
          id: "foreign-review",
          origin: "user",
          senderAgentId: null,
          createdAt: "2026-10-10T00:00:00Z",
          prompt: [
            {
              type: "review",
              mimeType: "application/paseo-review",
              cwd: `${cwd}-another`,
              mode: "uncommitted",
              comments: [],
            },
          ],
        },
      ],
    },
  });
  await expect(destination.stage(transferId)).rejects.toThrow("different source workspace");
  expect(destination.status(transferId).state).toBe("receiving");
  await expect(readdir(claudeHome)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readdir(reservation.stagingCwd)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["conversation", "queued upload"])(
  "refuses a %s blob absent from the signed archive inventory",
  async (kind) => {
    const upload = await capturedQueuedUpload();
    const { options, transferId, manifest } = await nativeDestinationFixture({
      queueBlobsDirectory: upload.directory,
      queue: {
        version: 2,
        files: [upload.captured],
        entries: [
          {
            id: "pending-file",
            origin: "user",
            senderAgentId: null,
            createdAt: "2026-10-10T00:00:00Z",
            prompt: [upload.captured.attachment],
          },
        ],
      },
    });
    await options.archives.withVerifiedArchive(transferId, async (archive) => {
      const expected = {
        sourceServerId,
        sourceWorkspaceId: "source-workspace",
        sourceAgentIds: ["source-agent"],
        manifestDigest: manifest.entrypoint.sha256,
      };
      const content = await readHandoffBundle(archive, expected);
      const session = content.sessions.get("source-agent");
      if (!session) throw new Error("Missing captured session");
      const omitted =
        kind === "conversation" ? session.files[0].blob.sha256 : upload.captured.blob.sha256;
      const incomplete = {
        ...manifest,
        blobs: manifest.blobs.filter((blob) => blob.sha256 !== omitted),
      };
      const receiver = new HandoffArchiveStore(path.join(root, "incomplete-archive"));
      const files = new Map(
        incomplete.blobs.map((blob) => [
          blob.sha256,
          path.join(archive.blobsDirectory, blob.sha256),
        ]),
      );
      await receiver.importLocal({ id: transferId, manifest: incomplete, files });
      await expect(
        receiver.withVerifiedArchive(transferId, (verified) =>
          readHandoffBundle(verified, expected),
        ),
      ).rejects.toMatchObject({ code: "invalid_artifact" });
    });
  },
);

test("cancellation after source cancellation removes only its inactive native session", async () => {
  const { destination, transferId, importedPath, claudeHome, options } =
    await nativeDestinationFixture();
  await destination.stage(transferId);
  const unrelated = path.join(claudeHome, "projects", "unrelated");
  await mkdir(unrelated);
  await writeFile(path.join(unrelated, "keep.jsonl"), "another session");
  const source = ownership.status(transferId);
  const imposter = new HandoffOwnership({
    directory: path.join(root, "wrong-key"),
    sourceServerId,
  });
  await imposter.initialize();
  const forged = await imposter.cancelReservation({
    transferId,
    destinationServerId: source.destinationServerId,
    reservationId: source.reservationId,
  });
  await expect(destination.cancel(transferId, forged)).rejects.toMatchObject({
    code: "invalid_cancellation",
  });
  expect(destination.status(transferId).state).toBe("staged");
  const proof = await ownership.cancelReservation({
    transferId,
    destinationServerId: source.destinationServerId,
    reservationId: source.reservationId,
  });
  const container = path.dirname(destination.status(transferId).stagingCwd);
  const moved = `${container}-original`;
  await rename(container, moved);
  await symlink(unrelated, container);
  await expect(destination.cancel(transferId, proof)).rejects.toMatchObject({
    code: "storage_uncertain",
  });
  await expect(readFile(importedPath)).rejects.toMatchObject({ code: "ENOENT" });
  await rm(container);
  await rename(moved, container);
  const recovered = new HandoffDestination(options);
  await recovered.initialize();
  expect((await recovered.cancel(transferId)).cleanupComplete).toBe(true);
  expect((await recovered.cancel(transferId, proof)).state).toBe("cancelled");
  await expect(readFile(importedPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(unrelated, "keep.jsonl"), "utf8")).toBe("another session");
});

test.each(["before", "after"])(
  "recovers native installation when readiness persistence fails %s the durable write",
  async (failurePoint) => {
    let injectFailure = true;
    const write: typeof writeJournal = async (file, value) => {
      const preparing = JSON.stringify(value).includes('"state":"staged"');
      if (injectFailure && preparing && failurePoint === "before") {
        injectFailure = false;
        throw new Error("lost readiness write");
      }
      await writeJournal(file, value);
      if (injectFailure && preparing && failurePoint === "after") {
        injectFailure = false;
        throw new Error("lost readiness acknowledgement");
      }
    };
    const { destination, transferId, options, importedPath, transcript, claudeHome } =
      await nativeDestinationFixture({ write });
    await expect(destination.stage(transferId)).rejects.toThrow("lost readiness");
    expect(await readFile(importedPath, "utf8")).toBe(transcript);
    const recovered = new HandoffDestination({
      ...options,
      write: writeJournal,
      resolveClaudeRuntime: async () => {
        throw new Error("Must use the journaled provider location");
      },
    });
    await recovered.initialize();
    expect((await recovered.stage(transferId)).state).toBe("staged");
    expect(await readdir(path.join(claudeHome, "projects"))).toEqual([
      path.basename(path.dirname(importedPath)),
    ]);
    expect(await readFile(importedPath, "utf8")).toBe(transcript);
  },
);

test("retries archive creation after committing its source binding", async () => {
  const transferId = randomUUID();
  const archivePath = path.join(root, "destination-archives");
  const store = new HandoffArchiveStore(archivePath);
  const options = {
    directory: path.join(root, "destination-journal"),
    serverId: "destination-host",
    archives: store,
  };
  const destination = new HandoffDestination(options);
  await destination.initialize();
  const reserved = await destination.reserve({
    transferId,
    sourceServerId,
    sourceWorkspaceId: "source-workspace",
    sourceAgentIds: [],
    destinationParent: root,
  });
  const source = await ownership.prepare({
    id: transferId,
    cwd,
    workspaceId: "source-workspace",
    agentIds: [],
    destinationServerId: options.serverId,
    reservationId: reserved.reservationId,
  });
  const artifactDirectory = path.join(root, "snapshot");
  await captureWorkspace({ cwd, artifactDirectory });
  const manifest = await packHandoffArchive({
    sourceServerId,
    sourceWorkspaceId: "source-workspace",
    sourceCwd: cwd,
    conversations: [],
    workspaceDirectory: artifactDirectory,
    transferId,
    store: new HandoffArchiveStore(path.join(root, "source-archives")),
  });
  const binding = { transferId, publicKey: source.publicKey, manifest };
  await writeFile(archivePath, "temporarily unavailable archive directory");
  await expect(destination.bindSource(binding)).rejects.toThrow();
  expect(destination.status(transferId).state).toBe("receiving");
  await rm(archivePath);
  const recovered = new HandoffDestination(options);
  await recovered.initialize();
  expect((await recovered.bindSource(binding)).state).toBe("receiving");
  expect((await store.status(transferId)).state).toBe("receiving");
  await expect(
    recovered.bindSource({
      ...binding,
      manifest: {
        ...manifest,
        entrypoint: { ...manifest.entrypoint, sha256: "a".repeat(64) },
        blobs: [{ ...manifest.entrypoint, sha256: "a".repeat(64) }],
      },
    }),
  ).rejects.toMatchObject({ code: "conflict" });
});

test("discovers interrupted cancellation cleanup after restart and retries without contacting the source", async () => {
  const options = {
    directory: path.join(root, "destination-journal"),
    serverId: "destination-host",
    archives: new HandoffArchiveStore(path.join(root, "archives")),
  };
  const destination = new HandoffDestination(options);
  await destination.initialize();
  const transferId = randomUUID();
  const reserved = await destination.reserve({
    transferId,
    sourceServerId,
    sourceWorkspaceId: "source-workspace",
    sourceAgentIds: [],
    destinationParent: root,
  });
  await expect(destination.cancel(transferId, undefined)).rejects.toMatchObject({
    code: "invalid_cancellation",
  });
  const container = path.dirname(reserved.stagingCwd);
  const original = `${container}-original`;
  const unrelated = path.join(root, "unrelated");
  await mkdir(unrelated);
  await writeFile(path.join(unrelated, "keep.txt"), "user data");
  await rename(container, original);
  await symlink(unrelated, container);
  const proof = await ownership.cancelReservation({
    transferId,
    destinationServerId: options.serverId,
    reservationId: reserved.reservationId,
  });
  await expect(destination.cancel(transferId, proof)).rejects.toMatchObject({
    code: "storage_uncertain",
  });
  const query = { sourceServerId, sourceWorkspaceId: "source-workspace" };
  expect(destination.list(query).transfers.map((entry) => entry.transferId)).toContain(transferId);
  expect(destination.status(transferId)).toMatchObject({
    state: "cancelled",
    cleanupComplete: false,
  });
  expect(() => destination.assertMutationAllowed({ cwd: reserved.stagingCwd })).toThrow();
  const recovered = new HandoffDestination(options);
  await recovered.initialize();
  expect(recovered.list(query).transfers.map((entry) => entry.transferId)).toContain(transferId);
  expect(() => recovered.assertMutationAllowed({ cwd: reserved.stagingCwd })).toThrow();
  await rm(container);
  await rename(original, container);
  expect(await recovered.cancel(transferId, undefined)).toMatchObject({
    state: "cancelled",
    cleanupComplete: true,
  });
  expect(recovered.list(query).transfers).toEqual([]);
  expect(() => recovered.assertMutationAllowed({ cwd: reserved.stagingCwd })).not.toThrow();
  expect(await readFile(path.join(unrelated, "keep.txt"), "utf8")).toBe("user data");
  await expect(readdir(container)).rejects.toMatchObject({ code: "ENOENT" });
  // Completed cleanup cannot delete a later directory reusing the old staging pathname.
  await mkdir(container);
  await writeFile(path.join(container, "later.txt"), "later data");
  const completed = new HandoffDestination(options);
  await completed.initialize();
  expect((await completed.cancel(transferId, undefined)).cleanupComplete).toBe(true);
  expect(await readFile(path.join(container, "later.txt"), "utf8")).toBe("later data");
});

test.each(["before", "after"])(
  "recovers cancellation completion when its journal acknowledgement fails %s the write",
  async (point) => {
    const options = {
      directory: path.join(root, "destination-journal"),
      serverId: "destination-host",
      archives: new HandoffArchiveStore(path.join(root, "archives")),
    };
    let interrupted = false;
    const destination = new HandoffDestination({
      ...options,
      write: async (file, value) => {
        const completing = JSON.stringify(value).includes('"cleanupComplete":true');
        if (completing && !interrupted && point === "before") {
          interrupted = true;
          throw new Error("lost completion");
        }
        await writeJournal(file, value);
        if (completing && !interrupted && point === "after") {
          interrupted = true;
          throw new Error("lost completion acknowledgement");
        }
      },
    });
    await destination.initialize();
    const transferId = randomUUID();
    const reserved = await destination.reserve({
      transferId,
      sourceServerId,
      sourceWorkspaceId: "source-workspace",
      sourceAgentIds: [],
      destinationParent: root,
    });
    const proof = await ownership.cancelReservation({
      transferId,
      destinationServerId: options.serverId,
      reservationId: reserved.reservationId,
    });
    await expect(destination.cancel(transferId, proof)).rejects.toThrow("lost completion");
    expect(() => destination.assertMutationAllowed({ cwd: reserved.stagingCwd })).toThrow();
    await expect(readdir(path.dirname(reserved.stagingCwd))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const recovered = new HandoffDestination(options);
    await recovered.initialize();
    expect((await recovered.cancel(transferId)).cleanupComplete).toBe(true);
    expect(() => recovered.assertMutationAllowed({ cwd: reserved.stagingCwd })).not.toThrow();
    expect(
      recovered.list({ sourceServerId, sourceWorkspaceId: "source-workspace" }).transfers,
    ).toEqual([]);
  },
);

test("cancels only private staging and keeps cancellation idempotent after restart", async () => {
  const options = {
    directory: path.join(root, "destination-journal"),
    serverId: "destination-host",
    archives: new HandoffArchiveStore(path.join(root, "archives")),
  };
  const destination = new HandoffDestination(options);
  await destination.initialize();
  const transferId = randomUUID();
  const reserved = await destination.reserve({
    transferId,
    sourceServerId,
    sourceWorkspaceId: "source-workspace",
    sourceAgentIds: [],
    destinationParent: root,
  });
  await mkdir(reserved.stagingCwd);
  await writeFile(path.join(reserved.stagingCwd, "partial"), "incomplete transfer");
  await mkdir(reserved.destinationCwd);
  await writeFile(path.join(reserved.destinationCwd, "user.txt"), "unrelated user file");
  const proof = await ownership.cancelReservation({
    transferId,
    destinationServerId: options.serverId,
    reservationId: reserved.reservationId,
  });
  expect((await destination.cancel(transferId, proof)).state).toBe("cancelled");
  const recovered = new HandoffDestination(options);
  await recovered.initialize();
  expect((await recovered.cancel(transferId, proof)).state).toBe("cancelled");
  await expect(readdir(path.dirname(reserved.stagingCwd))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(path.join(reserved.destinationCwd, "user.txt"), "utf8")).toBe(
    "unrelated user file",
  );
  await expect(recovered.stage(transferId)).rejects.toMatchObject({ code: "invalid_state" });
});

test("shutdown waits for an admitted reservation and rejects new work", async () => {
  let holdWrite = false;
  let entered: () => void = () => {};
  let unblock: () => void = () => {};
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const options = {
    directory: path.join(root, "destination-journal"),
    serverId: "destination-host",
    archives: new HandoffArchiveStore(path.join(root, "archives")),
    write: async (file: string, value: unknown) => {
      if (holdWrite) {
        entered();
        await blocked;
      }
      await writeJournal(file, value);
    },
  };
  const destination = new HandoffDestination(options);
  await destination.initialize();
  holdWrite = true;
  const request = {
    transferId: randomUUID(),
    sourceServerId,
    sourceWorkspaceId: "source-workspace",
    sourceAgentIds: [],
    destinationParent: root,
  };
  const reserving = destination.reserve(request);
  await writing;
  let stopped = false;
  const stopping = destination.dispose().then(() => {
    stopped = true;
    return stopped;
  });
  try {
    await expect(
      destination.reserve({ ...request, transferId: randomUUID() }),
    ).rejects.toMatchObject({ code: "invalid_state" });
    expect(stopped).toBe(false);
  } finally {
    unblock();
  }
  const reserved = await reserving;
  await stopping;
  const recovered = new HandoffDestination({ ...options, write: writeJournal });
  await recovered.initialize();
  expect(await recovered.reserve(request)).toEqual(reserved);
});

test("stages a reserved workspace and accepts only its signed source release", async () => {
  const transferId = randomUUID();
  const store = new HandoffArchiveStore(path.join(root, "archives"));
  const options = {
    directory: path.join(root, "destination-journal"),
    serverId: "destination-host",
    archives: store,
  };
  const restarted = new HandoffDestination(options);
  await restarted.initialize();
  const request = {
    transferId,
    sourceServerId,
    sourceWorkspaceId: "source-workspace",
    sourceAgentIds: [],
    destinationParent: root,
  };
  const reserved = await restarted.reserve(request);
  const source = await ownership.prepare({
    id: transferId,
    cwd,
    workspaceId: "source-workspace",
    agentIds: request.sourceAgentIds,
    destinationServerId: options.serverId,
    reservationId: reserved.reservationId,
  });
  await writeFile(path.join(cwd, "work.txt"), "captured work\n");
  const artifactDirectory = path.join(root, "snapshot");
  await captureWorkspace({ cwd, artifactDirectory });
  const manifest = await packHandoffArchive({
    sourceServerId,
    sourceWorkspaceId: "source-workspace",
    sourceCwd: cwd,
    conversations: [],
    workspaceDirectory: artifactDirectory,
    store,
    transferId,
  });
  await restarted.bindSource({ transferId, publicKey: source.publicKey, manifest });
  const staged = await restarted.stage(transferId);
  expect(staged.state).toBe("staged");
  expect(await readFile(path.join(staged.stagingCwd, "work.txt"), "utf8")).toBe("captured work\n");
  await expect(readFile(path.join(staged.destinationCwd, "work.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  await ownership.markReady(transferId, manifest.entrypoint.sha256);
  const binding = {
    version: 1 as const,
    transferId,
    sourceServerId,
    destinationServerId: options.serverId,
    reservationId: reserved.reservationId,
    manifestDigest: manifest.entrypoint.sha256,
  };
  const receipt = await ownership.release(transferId, binding, async () => {});
  await expect(
    restarted.acceptRelease(transferId, { ...receipt, reservationId: randomUUID() }),
  ).rejects.toMatchObject({ code: "invalid_release" });
  const released = await restarted.acceptRelease(transferId, receipt);
  expect(released.state).toBe("released");
  const recovered = new HandoffDestination(options);
  await recovered.initialize();
  expect(await recovered.acceptRelease(transferId, receipt)).toEqual(released);
  await expect(recovered.cancel(transferId, null)).rejects.toMatchObject({ code: "invalid_state" });
});

async function destinationFixture(write?: typeof writeJournal) {
  const transferId = randomUUID();
  const store = new HandoffArchiveStore(path.join(root, "archives"));
  const options = {
    directory: path.join(root, "destination-journal"),
    serverId: "destination-host",
    archives: store,
    write,
  };
  const destination = new HandoffDestination(options);
  await destination.initialize();
  const reservation = await destination.reserve({
    transferId,
    sourceServerId,
    sourceWorkspaceId: "source-workspace",
    sourceAgentIds: [],
    destinationParent: root,
  });
  const source = await ownership.prepare({
    id: transferId,
    cwd,
    workspaceId: "source-workspace",
    agentIds: [],
    destinationServerId: options.serverId,
    reservationId: reservation.reservationId,
  });
  await writeFile(path.join(cwd, "work.txt"), "original\n");
  const artifactDirectory = path.join(root, "snapshot");
  await captureWorkspace({ cwd, artifactDirectory });
  const manifest = await packHandoffArchive({
    sourceServerId,
    sourceWorkspaceId: "source-workspace",
    sourceCwd: cwd,
    conversations: [],
    workspaceDirectory: artifactDirectory,
    store,
    transferId,
  });
  const bind = { transferId, publicKey: source.publicKey, manifest };
  await destination.bindSource(bind);
  await ownership.markReady(transferId, manifest.entrypoint.sha256);
  const receipt = await ownership.release(
    transferId,
    {
      version: 1,
      transferId,
      sourceServerId,
      destinationServerId: options.serverId,
      reservationId: reservation.reservationId,
      manifestDigest: manifest.entrypoint.sha256,
    },
    async () => {},
  );
  return { destination, options, transferId, reservation, receipt, bind };
}

test("repairs changed private staging from the immutable archive after source release", async () => {
  const { destination, transferId, receipt } = await destinationFixture();
  const staged = await destination.stage(transferId);
  await writeFile(path.join(staged.stagingCwd, "work.txt"), "changed\n");
  await expect(destination.acceptRelease(transferId, receipt)).rejects.toMatchObject({
    code: "source_changed",
  });
  expect(destination.status(transferId).state).toBe("staged");
  await destination.stage(transferId);
  expect(await readFile(path.join(staged.stagingCwd, "work.txt"), "utf8")).toBe("original\n");
  await destination.acceptRelease(transferId, receipt);
  await writeFile(path.join(staged.stagingCwd, "work.txt"), "changed again\n");
  expect((await destination.stage(transferId)).state).toBe("released");
  expect(await readFile(path.join(staged.stagingCwd, "work.txt"), "utf8")).toBe("original\n");
});

test("recovers a destination release committed before its acknowledgement failed", async () => {
  let failAfterWrite = false;
  const write: typeof writeJournal = async (filePath, value) => {
    await writeJournal(filePath, value);
    if (failAfterWrite) throw new Error("lost persistence acknowledgement");
  };
  const { destination, transferId, receipt, options } = await destinationFixture(write);
  const staged = await destination.stage(transferId);
  failAfterWrite = true;
  await expect(destination.acceptRelease(transferId, receipt)).rejects.toThrow(
    "lost persistence acknowledgement",
  );
  expect(() => destination.status(transferId)).toThrow("recovered");
  const recovered = new HandoffDestination({ ...options, write: writeJournal });
  await recovered.initialize();
  expect(await recovered.acceptRelease(transferId, receipt)).toEqual({
    ...staged,
    state: "released",
    receipt,
  });
  await expect(recovered.cancel(transferId, null)).rejects.toMatchObject({ code: "invalid_state" });
});

test("a dangling mutation path is never treated as an unrelated missing directory", async () => {
  await symlink(path.join(root, "removed-target"), path.join(root, "alias"));
  await expect(
    ownership.withMutation({ cwd: path.join(root, "alias", "nested") }, async () => 1),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

async function prepare() {
  const input = {
    id: randomUUID(),
    cwd,
    workspaceId: "workspace-id",
    agentIds: ["agent-id"],
    destinationServerId: "destination-host",
    reservationId: randomUUID(),
  };
  const status = await ownership.prepare(input);
  await ownership.markReady(input.id, digest);
  return {
    input,
    status,
    binding: {
      version: 1 as const,
      transferId: input.id,
      sourceServerId,
      destinationServerId: input.destinationServerId,
      reservationId: input.reservationId,
      manifestDigest: digest,
    },
  };
}

test("release survives restart, is idempotent and cannot be rolled back by cancellation", async () => {
  const { input, status, binding } = await prepare();
  let validations = 0;
  const receipt = await ownership.release(input.id, binding, async () => {
    validations++;
  });
  expect(verifyHandoffRelease(receipt, binding, status.publicKey)).toBe(true);
  const restarted = new HandoffOwnership({ directory, sourceServerId });
  await restarted.initialize();
  expect(
    await restarted.release(input.id, binding, async () => {
      validations++;
    }),
  ).toEqual(receipt);
  expect(validations).toBe(1);
  await expect(restarted.cancel(input.id)).rejects.toMatchObject({ code: "invalid_state" });
  await expect(restarted.withMutation({ cwd }, async () => 1)).rejects.toMatchObject({
    code: "fenced",
  });
  expect(() => restarted.acquireAgentRecordMutation({ cwd, agentId: input.agentIds[0] })).toThrow(
    "sealed by handoff",
  );
});

test("a lost reply after durable release cannot resurrect source ownership", async () => {
  const { input, binding, status } = await prepare();
  const interrupted = new HandoffOwnership({
    directory,
    sourceServerId,
    write: async (file, value) => {
      await writeJournal(file, value);
      if (JSON.parse(await readFile(file, "utf8")).records[0].state === "released")
        throw new Error("lost after durable write");
    },
  });
  await interrupted.initialize();
  await expect(interrupted.release(input.id, binding, async () => {})).rejects.toThrow(
    "lost after durable write",
  );
  await expect(interrupted.cancel(input.id)).rejects.toMatchObject({ code: "storage_uncertain" });
  const restarted = new HandoffOwnership({ directory, sourceServerId });
  await restarted.initialize();
  expect(restarted.status(input.id).state).toBe("released");
  const receipt = await restarted.release(input.id, binding, async () => {
    throw new Error("must not revalidate released ownership");
  });
  expect(verifyHandoffRelease(receipt, binding, status.publicKey)).toBe(true);
  await expect(restarted.cancel(input.id)).rejects.toMatchObject({ code: "invalid_state" });
});

test("a readable release after failed synchronization is not a durable receipt", async () => {
  const { input, binding, status } = await prepare();
  const interrupted = new HandoffOwnership({
    directory,
    sourceServerId,
    write: async (file, value) => {
      await writeJsonFileAtomic(file, value);
      if (JSON.parse(await readFile(file, "utf8")).records[0].state !== "released")
        await syncFilePublication(file, path.dirname(directory));
      if (JSON.parse(await readFile(file, "utf8")).records[0].state === "released")
        throw new Error("directory synchronization failed");
    },
  });
  await interrupted.initialize();
  await expect(interrupted.release(input.id, binding, async () => {})).rejects.toThrow(
    "directory synchronization failed",
  );
  const journalPath = path.join(directory, "ownership.json");
  expect(JSON.parse(await readFile(journalPath, "utf8")).records[0].state).toBe("released");

  let storageRepaired = false;
  const restarted = new HandoffOwnership({
    directory,
    sourceServerId,
    sync: async (file, publicationRoot) => {
      if (!storageRepaired) throw new Error("directory synchronization failed");
      await syncFilePublication(file, publicationRoot);
    },
  });
  await expect(restarted.initialize()).rejects.toThrow("directory synchronization failed");
  await expect(restarted.release(input.id, binding, async () => {})).rejects.toMatchObject({
    code: "storage_uncertain",
  });
  await expect(restarted.withMutation({ cwd }, async () => "unsafe")).rejects.toMatchObject({
    code: "storage_uncertain",
  });

  storageRepaired = true;
  await restarted.initialize();
  const receipt = await restarted.release(input.id, binding, async () => {
    throw new Error("must not revalidate an irrevocable release");
  });
  expect(verifyHandoffRelease(receipt, binding, status.publicKey)).toBe(true);
  expect(await restarted.release(input.id, binding, async () => {})).toEqual(receipt);
  await expect(restarted.cancel(input.id)).rejects.toMatchObject({ code: "invalid_state" });
  await expect(restarted.withMutation({ cwd }, async () => "unsafe")).rejects.toMatchObject({
    code: "fenced",
  });
});

test("failure before persisting release returns no receipt and recovers the ready source fence", async () => {
  const { input, binding } = await prepare();
  const failing = new HandoffOwnership({
    directory,
    sourceServerId,
    write: async () => {
      throw new Error("disk full");
    },
  });
  await failing.initialize();
  await expect(failing.release(input.id, binding, async () => {})).rejects.toThrow("disk full");
  const restarted = new HandoffOwnership({ directory, sourceServerId });
  await restarted.initialize();
  expect(restarted.status(input.id).state).toBe("ready");
  await expect(restarted.withMutation({ cwd }, async () => 1)).rejects.toMatchObject({
    code: "fenced",
  });
  expect((await restarted.cancel(input.id)).state).toBe("cancelled");
});

test("cancellation and release serialize so exactly one transition wins", async () => {
  const { input, binding } = await prepare();
  const [cancelled, release] = await Promise.allSettled([
    ownership.cancel(input.id),
    ownership.release(input.id, binding, async () => {}),
  ]);
  expect(cancelled).toMatchObject({ status: "fulfilled", value: { state: "cancelled" } });
  expect(release).toMatchObject({ status: "rejected", reason: { code: "invalid_state" } });
  expect(await ownership.withMutation({ cwd }, async () => 1)).toBe(1);
});

test("a release already verifying cannot be overtaken by cancellation", async () => {
  const { input, binding } = await prepare();
  let releaseVerification: () => void = () => {};
  let entered: () => void = () => {};
  const verifying = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const unblock = new Promise<void>((resolve) => {
    releaseVerification = resolve;
  });
  const release = ownership.release(input.id, binding, async () => {
    entered();
    await unblock;
  });
  await verifying;
  const cancel = ownership.cancel(input.id);
  const cancelled = expect(cancel).rejects.toMatchObject({ code: "invalid_state" });
  releaseVerification();
  expect(await release).toMatchObject(binding);
  await cancelled;
});

test("failed source verification never produces a receipt and can still be cancelled", async () => {
  const { input, binding } = await prepare();
  await expect(
    ownership.release(input.id, binding, async () => {
      throw new Error("writer did not stop");
    }),
  ).rejects.toThrow("writer did not stop");
  expect(ownership.status(input.id).state).toBe("ready");
  expect((await ownership.cancel(input.id)).state).toBe("cancelled");
});

test("release is bound to the destination, reservation, content and authenticated source key", async () => {
  const { input, binding, status } = await prepare();
  await expect(
    ownership.release(
      input.id,
      { ...binding, destinationServerId: "another-host" },
      async () => {},
    ),
  ).rejects.toMatchObject({ code: "conflict" });
  const receipt = await ownership.release(input.id, binding, async () => {});
  expect(
    verifyHandoffRelease(
      receipt,
      { ...binding, destinationServerId: "another-host" },
      status.publicKey,
    ),
  ).toBe(false);
  expect(
    verifyHandoffRelease(receipt, { ...binding, reservationId: randomUUID() }, status.publicKey),
  ).toBe(false);
  expect(
    verifyHandoffRelease(receipt, { ...binding, manifestDigest: "b".repeat(64) }, status.publicKey),
  ).toBe(false);
  expect(
    verifyHandoffRelease(
      { ...receipt, signature: Buffer.alloc(64).toString("base64") },
      binding,
      status.publicKey,
    ),
  ).toBe(false);
  expect(verifyHandoffRelease(receipt, binding, Buffer.alloc(32).toString("base64"))).toBe(false);
  expect(
    verifyHandoffRelease(
      { ...receipt, signature: `${receipt.signature}%%%` },
      binding,
      status.publicKey,
    ),
  ).toBe(false);
});

test("resolves symlink aliases before admitting workspace mutations", async () => {
  await prepare();
  const alias = path.join(root, "alias");
  await symlink(cwd, alias);
  await expect(ownership.withMutation({ cwd: alias }, async () => 1)).rejects.toMatchObject({
    code: "fenced",
  });
});
