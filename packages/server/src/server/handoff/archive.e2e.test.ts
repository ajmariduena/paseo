import {
  transferHandoffArchive,
  prepareWorkspaceHandoff,
  activateWorkspaceHandoff,
  cancelWorkspaceHandoff,
  type HandoffTransferProgress,
  DaemonClient as TransportClient,
} from "@getpaseo/client/internal/daemon-client";
import { WebSocket, type RawData } from "ws";
import type { WorkspaceHandoffCheckpoint } from "@getpaseo/client/internal/workspace-handoff";
import { WSOutboundMessageSchema } from "@getpaseo/protocol/messages";
import { StoredScheduleSchema } from "@getpaseo/protocol/schedule/types";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { HANDOFF_CHUNK_BYTES } from "@getpaseo/protocol/handoff";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { claudeProjectDirSync } from "../agent/providers/claude/project-dir.js";
import { HandoffArchiveStore } from "./archive.js";
import { readHandoffBundle } from "./bundle.js";
import { prependHandoffContext } from "./context.js";
import { PromptAnnotationStore } from "../agent/prompt-annotations.js";
import { PullRequestWatchStore } from "../pull-request-watch/watch-store.js";
import { parseStoredAgentRecord, type StoredAgentRecord } from "../agent/agent-storage.js";
import { captureWorkspace, packWorkspaceArchive, restoreWorkspaceArchive } from "./workspace.js";
import { ScheduleStore } from "../schedule/store.js";
import * as atomicFile from "../atomic-file.js";
import { handoffScheduleId } from "../schedule/handoff.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  createTestAgentClient,
  holdNextClaudeTestTurn,
  holdNextScheduledClaudeTestTurn,
} from "../test-utils/fake-agent-client.js";

const exec = promisify(execFile);

interface Host {
  daemon: TestPaseoDaemon;
  client: DaemonClient;
}
let root: string;
const running = new Set<Host>();

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "paseo-handoff-network-"));
});
afterEach(async () => {
  for (const host of running) await stopHost(host);
  await rm(root, { recursive: true, force: true });
}, 30_000);

async function startHost(name: string, nativeSessions = false): Promise<Host> {
  const home = path.join(root, name);
  const staticDir = path.join(home, "static");
  await mkdir(staticDir, { recursive: true });
  const versionCommand = path.join(home, "claude-version.cjs");
  if (nativeSessions)
    await writeFile(
      versionCommand,
      "if (process.argv[2] !== '--version') throw new Error('Must not start a conversation'); console.log('2.1.295');\n",
    );
  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: home,
    staticDir,
    cleanup: false,
    mcpEnabled: false,
    agentClients: {},
    agentProviderSettings: nativeSessions
      ? {
          claude: {
            command: { mode: "replace", argv: [process.execPath, versionCommand] },
            env: { CLAUDE_CONFIG_DIR: path.join(home, "claude") },
          },
        }
      : undefined,
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.11.1",
  });
  const host = { daemon, client };
  running.add(host);
  await client.connect();
  return host;
}

async function stopHost(host: Host): Promise<void> {
  running.delete(host);
  await host.client.close();
  await host.daemon.close();
}

interface ActiveHeartbeatTestInput {
  source: Host;
  configDir: string;
  agentId: string;
  sessionId: string;
  transcriptFile: string;
  heartbeatId: string;
  workspaceId: string;
}

async function startReviewedHeartbeat({
  source,
  configDir,
  agentId,
  sessionId,
  transcriptFile,
  heartbeatId,
  workspaceId,
}: ActiveHeartbeatTestInput) {
  const manager = source.daemon.daemon.agentManager;
  manager.registerClient(
    "claude",
    createTestAgentClient("claude", {
      claudeRuntime: { configDir, cliVersion: "2.1.295" },
    }),
  );
  expect((await source.client.listCommands(agentId)).error).toBeNull();
  const session = manager.getAgent(agentId)?.session;
  if (!session) throw new Error("Missing active heartbeat session");
  holdNextClaudeTestTurn({ session, sessionId, transcriptFile });
  const waiting = Promise.withResolvers<void>();
  const wait = manager.waitForAgentEvent.bind(manager);
  vi.spyOn(manager, "waitForAgentEvent").mockImplementation((id, options) => {
    const result = wait(id, options);
    waiting.resolve();
    return result;
  });
  const heartbeatResult = source.client
    .scheduleRunOnce({ id: heartbeatId })
    .catch((error: unknown) => error);
  await Promise.race([
    waiting.promise,
    heartbeatResult.then((result) => {
      throw new Error(`Heartbeat ended before its active wait: ${JSON.stringify(result)}`);
    }),
  ]);
  const fresh = (await source.client.handoffPreviewSource({ workspaceId })).result;
  if (!fresh?.stoppedWork?.review) throw new Error("Missing fresh schedule review");
  expect(
    fresh.stoppedWork.review.schedules?.find((entry) => entry.id === heartbeatId)?.activeRun,
  ).toMatchObject({ previousLastRunAt: null });
  return { heartbeatResult, review: fresh.stoppedWork.review };
}

test.skipIf(process.platform === "win32").each(["native", "context"] as const)(
  "%s handoff moves reviewed schedules and heartbeats paused through cancellation and interrupted activation",
  async (continuationMode) => {
    let source = await startHost("source", true);
    let destination = await startHost("destination", true);
    const cwd = path.join(await realpath(root), "automation-workspace");
    await mkdir(path.join(cwd, "nested"), { recursive: true });
    await writeFile(path.join(cwd, "nested", "work.txt"), "scheduled work");
    const created = await source.client.createWorkspace({
      source: { kind: "directory", path: cwd },
    });
    if (!created.workspace) throw new Error("Missing workspace");
    const workspaceId = created.workspace.id;
    const agentId = randomUUID();
    const sessionId = randomUUID();
    const configDir = path.join(root, "source", "claude");
    const project = claudeProjectDirSync(cwd, { configDir });
    await mkdir(project, { recursive: true });
    await writeFile(
      path.join(project, `${sessionId}.jsonl`),
      JSON.stringify({
        type: "user",
        uuid: randomUUID(),
        sessionId,
        message: { role: "user", content: "Continue the scheduled task" },
      }) + "\n",
    );
    const timestamp = new Date().toISOString();
    await source.daemon.daemon.agentStorage.upsert(
      parseStoredAgentRecord({
        id: agentId,
        provider: "claude",
        cwd,
        workspaceId,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastStatus: "closed",
        persistence: {
          provider: "claude",
          sessionId,
          metadata: { cwd, claudeRuntime: { configDir, cliVersion: "2.1.295" } },
        },
      }),
    );
    const cadence = { type: "cron" as const, expression: "0 0 1 1 *", timezone: "Europe/Berlin" };
    const periodic = await source.client.scheduleCreate({
      name: "Annual build",
      prompt: "Run the build",
      cadence,
      runOnCreate: false,
      maxRuns: 4,
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: path.join(cwd, "nested"), model: "test-model" },
      },
    });
    const heartbeat = await source.client.scheduleCreate({
      name: "Annual reminder",
      prompt: "Review progress",
      cadence,
      runOnCreate: false,
      maxRuns: 3,
      target: { type: "agent", agentId },
    });
    if (!periodic.schedule || !heartbeat.schedule) throw new Error("Missing schedules");
    const parent = (
      await destination.client.scheduleCreate({
        name: "Existing parent schedule",
        prompt: "Unrelated work",
        cadence,
        runOnCreate: false,
        target: { type: "new-agent", config: { provider: "claude", cwd: root } },
      })
    ).schedule;
    if (!parent) throw new Error("Missing existing destination schedule");
    const periodicId = periodic.schedule.id;
    const heartbeatId = heartbeat.schedule.id;
    const sourceStore = new ScheduleStore(
      path.join(source.daemon.daemon.config.paseoHome, "schedules"),
      createTestLogger(),
    );
    await sourceStore.update(periodicId, (record) => ({
      ...record,
      runs: [
        {
          id: randomUUID(),
          scheduledFor: timestamp,
          startedAt: timestamp,
          endedAt: timestamp,
          status: "succeeded",
          agentId,
          workspaceId,
          output: "Prior build output",
          error: null,
        },
      ],
    }));
    const review = (await source.client.handoffPreviewSource({ workspaceId })).result;
    if (!review?.stoppedWork?.review) throw new Error("Missing schedule review");
    expect(review.stoppedWork.review.schedules).toHaveLength(2);
    expect(review.stoppedWork.scheduledBytes).toBeGreaterThan(0);
    const prepare = (transferId: string, stoppedWorkReview = review.stoppedWork!.review) =>
      prepareWorkspaceHandoff({
        transferId,
        workspaceId,
        destinationParent: root,
        continuationMode,
        source: source.client,
        destination: destination.client,
        stoppedWorkReview,
      });
    const cancelledId = randomUUID();
    await prepare(cancelledId);
    expect((await source.client.scheduleInspect({ id: periodicId })).schedule?.status).toBe(
      "paused",
    );
    await cancelWorkspaceHandoff({
      transferId: cancelledId,
      sourceServerId: source.daemon.daemon.getServerId(),
      getSource: () => source.client,
      destination: destination.client,
    });
    expect((await source.client.scheduleInspect({ id: periodicId })).schedule?.status).toBe(
      "paused",
    );
    expect((await destination.client.scheduleList()).schedules).toEqual([parent]);
    await source.client.scheduleResume({ id: periodicId });
    await source.client.scheduleResume({ id: heartbeatId });
    const { heartbeatResult, review: activeReview } = await startReviewedHeartbeat({
      source,
      configDir,
      agentId,
      sessionId,
      heartbeatId,
      workspaceId,
      transcriptFile: path.join(project, `${sessionId}.jsonl`),
    });
    const transferId = randomUUID();
    const staged = await prepare(transferId, activeReview);
    expect(await heartbeatResult).toMatchObject({
      schedule: {
        runs: [{ status: "failed", agentId, error: `Scheduled agent ${agentId} was canceled` }],
      },
    });
    expect(source.daemon.daemon.agentManager.getAgent(agentId)).toBeNull();
    const stoppedHeartbeat = await sourceStore.get(heartbeatId);
    if (!stoppedHeartbeat) throw new Error("Missing stopped heartbeat");
    await sourceStore.update(heartbeatId, (record) => ({
      ...record,
      runs: record.runs.map((run) => ({ ...run, output: "Changed after capture" })),
    }));
    expect((await source.client.handoffReleaseSource({ transferId })).error?.code).toBe(
      "source_changed",
    );
    await sourceStore.update(heartbeatId, () => stoppedHeartbeat);
    const retained = await sourceStore.get(periodicId);
    if (!retained) throw new Error("Missing paused source schedule");
    await sourceStore.update(periodicId, (record) => ({ ...record, prompt: "Unreviewed change" }));
    expect((await source.client.handoffReleaseSource({ transferId })).error?.code).toBe(
      "source_changed",
    );
    await sourceStore.update(periodicId, () => retained);
    await stopHost(source);
    await stopHost(destination);
    source = await startHost("source", true);
    destination = await startHost("destination", true);
    const sourceServerId = source.daemon.daemon.getServerId();
    const orderedIds = [periodicId, heartbeatId].sort();
    const firstImportedId = handoffScheduleId(staged.reservationId, orderedIds[0]);
    const obstruction = path.join(
      destination.daemon.daemon.config.paseoHome,
      "schedules",
      `${handoffScheduleId(staged.reservationId, orderedIds[1])}.json`,
    );
    await mkdir(obstruction);
    await expect(
      activateWorkspaceHandoff({
        transferId,
        sourceServerId,
        getSource: () => source.client,
        destination: destination.client,
      }),
    ).rejects.toThrow();
    expect((await source.client.handoffGetSourceStatus({ transferId })).result?.source.state).toBe(
      "released",
    );
    expect(
      (await destination.client.handoffGetDestinationStatus({ transferId })).result?.state,
    ).toBe("activating");
    expect((await destination.client.scheduleList()).schedules).toEqual([parent]);
    await expect(destination.client.scheduleResume({ id: firstImportedId })).rejects.toThrow(
      "not found",
    );
    await expect(
      destination.client.scheduleCreate({
        prompt: "Must not wake a private import",
        cadence,
        runOnCreate: false,
        target: { type: "agent", agentId: staged.agentMappings[0].destinationAgentId },
      }),
    ).rejects.toThrow("finish activation");
    const privateStore = new ScheduleStore(
      path.join(destination.daemon.daemon.config.paseoHome, "schedules"),
      createTestLogger(),
    );
    expect((await privateStore.get(firstImportedId))?.status).toBe("paused");
    await stopHost(destination);
    await rm(obstruction, { recursive: true });
    destination = await startHost("destination", true);
    const active = (await destination.client.handoffGetDestinationStatus({ transferId })).result;
    if (!active) throw new Error("Missing recovered activation");
    expect(active.state).toBe("active");
    const schedules = (await destination.client.scheduleList()).schedules;
    expect(schedules).toHaveLength(3);
    expect(
      schedules.filter((record) => record.id !== parent.id).map((record) => record.status),
    ).toEqual(["paused", "paused"]);
    const imported = await destination.client.scheduleInspect({
      id: handoffScheduleId(staged.reservationId, periodicId),
    });
    expect(imported.schedule).toMatchObject({
      cadence,
      maxRuns: 4,
      nextRunAt: null,
      target: {
        type: "new-agent",
        config: {
          cwd: path.join(active.destinationCwd, "nested"),
          provider: "claude",
          model: "test-model",
        },
      },
      runs: [
        {
          output: "Prior build output",
          agentId: active.agentMappings[0].destinationAgentId,
          workspaceId: active.workspaceId,
          origin: { serverId: sourceServerId, scheduleId: periodicId, agentId, workspaceId },
        },
      ],
    });
    expect(
      (
        await destination.client.scheduleInspect({
          id: handoffScheduleId(staged.reservationId, heartbeatId),
        })
      ).schedule,
    ).toMatchObject({
      target: { type: "agent", agentId: active.agentMappings[0].destinationAgentId },
      status: "paused",
      runs: [
        {
          status: "failed",
          agentId: active.agentMappings[0].destinationAgentId,
          error: `Scheduled agent ${agentId} was canceled`,
          origin: { serverId: sourceServerId, scheduleId: heartbeatId, agentId },
        },
      ],
    });
    expect(
      destination.daemon.daemon.agentManager.getAgent(active.agentMappings[0].destinationAgentId),
    ).toBeNull();
    const history = await destination.client.handoffGetConversationHistory({
      agentId: active.agentMappings[0].destinationAgentId,
    });
    expect(history.error).toBeNull();
    if (!history.result) throw new Error("Missing moved heartbeat history");
    expect(history.result.mode).toBe(continuationMode);
    expect(history.result.timeline.entries.map((entry) => entry.item)).toEqual([
      expect.objectContaining({ type: "user_message", text: "Continue the scheduled task" }),
      expect.objectContaining({
        type: "notification",
        level: "info",
        messageId: `schedule:${heartbeatId}:${stoppedHeartbeat.runs[0].id}`,
        message: expect.stringContaining("Review progress"),
      }),
    ]);
    await activateWorkspaceHandoff({
      transferId,
      sourceServerId,
      getSource: () => source.client,
      destination: destination.client,
    });
    expect((await destination.client.scheduleList()).schedules).toEqual(schedules);
    await expect(source.client.scheduleResume({ id: periodicId })).rejects.toThrow("handoff");
  },
  30_000,
);

test.skipIf(process.platform === "win32").each(["native", "context"] as const)(
  "%s handoff recovers a stopped job outcome after daemon restart and moves its workspace and history",
  async (continuationMode) => {
    let source = await startHost("source", true);
    let destination = await startHost("destination", true);
    const cwd = path.join(await realpath(root), "created-job");
    await mkdir(cwd);
    await writeFile(path.join(cwd, "unfinished.txt"), "Keep this scheduled work");
    const configDir = path.join(root, "source", "claude");
    const manager = source.daemon.daemon.agentManager;
    manager.registerClient(
      "claude",
      createTestAgentClient("claude", {
        claudeRuntime: { configDir, cliVersion: "2.1.295" },
      }),
    );
    const prompt = "Continue the unfinished scheduled task";
    const created = await source.client.scheduleCreate({
      name: "Scheduled implementation",
      prompt,
      cadence: { type: "cron", expression: "0 0 1 1 *", timezone: "UTC" },
      runOnCreate: false,
      target: { type: "new-agent", config: { provider: "claude", cwd } },
    });
    if (!created.schedule) throw new Error("Missing schedule");
    const scheduleId = created.schedule.id;
    holdNextScheduledClaudeTestTurn({ manager, scheduleId, configDir });
    const execution = source.client
      .scheduleRunOnce({ id: scheduleId })
      .catch((error: unknown) => error);
    await expect
      .poll(async () => (await source.client.scheduleInspect({ id: scheduleId })).schedule?.runs)
      .toEqual([
        expect.objectContaining({
          status: "running",
          agentId: expect.any(String),
          workspaceId: expect.any(String),
        }),
      ]);
    const run = (await source.client.scheduleInspect({ id: scheduleId })).schedule?.runs[0];
    if (!run?.agentId || !run.workspaceId) throw new Error("Missing created workspace and agent");
    const { agentId, workspaceId } = run;
    await expect
      .poll(() => source.client.handoffPreviewSource({ workspaceId }))
      .toMatchObject({
        error: null,
        result: {
          conversations: [{ agentId, state: "available" }],
          stoppedWork: {
            review: {
              schedules: [{ id: scheduleId, kind: "schedule", activeRun: { id: run.id } }],
            },
          },
        },
      });
    const review = (await source.client.handoffPreviewSource({ workspaceId })).result;
    if (!review?.stoppedWork?.review) throw new Error("Missing created job review");
    const transferId = randomUUID();
    const stoppedWorkReview = review.stoppedWork.review;
    const prepare = () =>
      prepareWorkspaceHandoff({
        transferId,
        workspaceId,
        destinationParent: root,
        continuationMode,
        source: source.client,
        destination: destination.client,
        stoppedWorkReview,
      });
    const scheduleFile = path.join(source.daemon.paseoHome, "schedules", `${scheduleId}.json`);
    const write = atomicFile.writeJsonFileAtomic;
    const failedOutcome = vi
      .spyOn(atomicFile, "writeJsonFileAtomic")
      .mockImplementation(async (file, value) => {
        if (file === scheduleFile && StoredScheduleSchema.parse(value).runs[0]?.status === "failed")
          throw new Error("Scheduled outcome disk unavailable");
        return write(file, value);
      });
    try {
      await expect(prepare()).rejects.toThrow("Scheduled outcome disk unavailable");
      expect(await execution).toBeInstanceOf(Error);
      expect(JSON.parse(await readFile(scheduleFile, "utf8")).runs[0].status).toBe("running");
      expect(
        (await source.client.handoffGetSourceStatus({ transferId })).result?.source.state,
      ).toBe("preparing");
      expect(manager.getAgent(agentId)).toBeNull();
      await stopHost(source);
      await stopHost(destination);
    } finally {
      failedOutcome.mockRestore();
    }
    source = await startHost("source", true);
    destination = await startHost("destination", true);
    expect((await source.client.scheduleInspect({ id: scheduleId })).schedule).toMatchObject({
      runs: [
        {
          id: run.id,
          agentId,
          workspaceId,
          status: "failed",
          error: `Scheduled agent ${agentId} was canceled`,
        },
      ],
    });
    expect(source.daemon.daemon.agentManager.messageQueue.isHeldForUserStop(agentId)).toBe(true);
    const staged = await prepare();
    expect(manager.getAgent(agentId)).toBeNull();
    expect(await readFile(path.join(cwd, "unfinished.txt"), "utf8")).toBe(
      "Keep this scheduled work",
    );
    await stopHost(source);
    await stopHost(destination);
    source = await startHost("source", true);
    destination = await startHost("destination", true);
    const active = await activateWorkspaceHandoff({
      transferId,
      sourceServerId: source.daemon.daemon.getServerId(),
      getSource: () => source.client,
      destination: destination.client,
    });
    const destinationAgentId = active.agentMappings[0].destinationAgentId;
    expect(
      (
        await destination.client.scheduleInspect({
          id: handoffScheduleId(staged.reservationId, scheduleId),
        })
      ).schedule,
    ).toMatchObject({
      status: "paused",
      target: { type: "new-agent", config: { cwd: active.destinationCwd } },
      runs: [
        {
          id: run.id,
          status: "failed",
          agentId: destinationAgentId,
          workspaceId: active.workspaceId,
        },
      ],
    });
    expect(await readFile(path.join(active.destinationCwd, "unfinished.txt"), "utf8")).toBe(
      "Keep this scheduled work",
    );
    const history = await destination.client.handoffGetConversationHistory({
      agentId: destinationAgentId,
    });
    expect(history.error).toBeNull();
    expect(history.result).toMatchObject({
      mode: continuationMode,
      timeline: {
        entries: [
          expect.objectContaining({
            item: expect.objectContaining({ type: "user_message", text: prompt }),
          }),
        ],
      },
    });
    expect(destination.daemon.daemon.agentManager.getAgent(destinationAgentId)).toBeNull();
    await expect(source.client.scheduleRunOnce({ id: scheduleId })).rejects.toThrow("handoff");
    expect(
      destination.daemon.daemon.agentManager.messageQueue.isHeldForUserStop(destinationAgentId),
    ).toBe(true);
    await stopHost(destination);
    destination = await startHost("destination", true);
    expect(
      destination.daemon.daemon.agentManager.messageQueue.isHeldForUserStop(destinationAgentId),
    ).toBe(true);
    expect(destination.daemon.daemon.agentManager.getAgent(destinationAgentId)).toBeNull();
  },
  30_000,
);

test.skipIf(process.platform === "win32").each(["native", "context"] as const)(
  "%s handoff retains the parent schedule while moving its running Git worktree",
  async (continuationMode) => {
    let source = await startHost("source", true);
    let destination = await startHost("destination", true);
    const cwd = path.join(await realpath(root), "scheduled-project");
    await mkdir(cwd);
    await writeFile(path.join(cwd, "unfinished.txt"), "Keep this scheduled work");
    const git = (args: string[]) =>
      exec("git", args, {
        cwd,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      });
    await git(["init", "--initial-branch=main"]);
    await git(["add", "unfinished.txt"]);
    await git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-m",
      "Initial work",
    ]);
    const configDir = path.join(root, "source", "claude");
    const manager = source.daemon.daemon.agentManager;
    manager.registerClient(
      "claude",
      createTestAgentClient("claude", {
        claudeRuntime: { configDir, cliVersion: "2.1.295" },
      }),
    );
    const prompt = "Continue the unfinished scheduled task";
    const created = await source.client.scheduleCreate({
      name: "Scheduled implementation",
      prompt,
      cadence: { type: "cron", expression: "0 0 1 1 *", timezone: "UTC" },
      runOnCreate: false,
      target: { type: "new-agent", config: { provider: "claude", cwd, isolation: "worktree" } },
    });
    if (!created.schedule) throw new Error("Missing schedule");
    const scheduleId = created.schedule.id;
    holdNextScheduledClaudeTestTurn({ manager, scheduleId, configDir });
    const execution = source.client
      .scheduleRunOnce({ id: scheduleId })
      .catch((error: unknown) => error);
    await expect
      .poll(async () => (await source.client.scheduleInspect({ id: scheduleId })).schedule?.runs)
      .toEqual([
        expect.objectContaining({
          status: "running",
          agentId: expect.any(String),
          workspaceId: expect.any(String),
        }),
      ]);
    const run = (await source.client.scheduleInspect({ id: scheduleId })).schedule?.runs[0];
    if (!run?.agentId || !run.workspaceId) throw new Error("Missing created workspace and agent");
    const { agentId, workspaceId } = run;
    const worktree = manager.getAgent(agentId)?.cwd;
    if (!worktree) throw new Error("Missing scheduled worktree");
    expect(worktree).not.toBe(cwd);
    await writeFile(path.join(worktree, "unfinished.txt"), "Keep the job's uncommitted changes");
    await expect
      .poll(() => source.client.handoffPreviewSource({ workspaceId }))
      .toMatchObject({
        error: null,
        result: {
          conversations: [{ agentId, state: "available" }],
          stoppedWork: {
            review: {
              schedules: [
                {
                  id: scheduleId,
                  kind: "schedule",
                  activeRun: { id: run.id },
                  retainedOnSource: { cwd },
                },
              ],
            },
          },
        },
      });
    const review = (await source.client.handoffPreviewSource({ workspaceId })).result;
    if (!review?.stoppedWork?.review) throw new Error("Missing created job review");
    const strippedReview = {
      ...review.stoppedWork.review,
      schedules: review.stoppedWork.review.schedules?.map(
        ({ retainedOnSource: _retained, ...schedule }) => schedule,
      ),
    };
    expect(
      (
        await source.client.handoffPrepareSource({
          transferId: randomUUID(),
          workspaceId,
          agentIds: [agentId],
          destinationServerId: destination.daemon.daemon.getServerId(),
          reservationId: randomUUID(),
          stoppedWorkReview: strippedReview,
        })
      ).error?.code,
    ).toBe("review_changed");
    expect((await source.client.handoffFindSource({ workspaceId })).result).toBeNull();
    const transferId = randomUUID();
    await prepareWorkspaceHandoff({
      transferId,
      workspaceId,
      destinationParent: root,
      continuationMode,
      source: source.client,
      destination: destination.client,
      stoppedWorkReview: review.stoppedWork.review,
    });
    expect(await execution).toMatchObject({
      schedule: {
        runs: [
          {
            id: run.id,
            agentId,
            workspaceId,
            status: "failed",
            error: `Scheduled agent ${agentId} was canceled`,
          },
        ],
      },
    });
    expect(manager.getAgent(agentId)).toBeNull();
    expect(await readFile(path.join(cwd, "unfinished.txt"), "utf8")).toBe(
      "Keep this scheduled work",
    );
    const sourceStore = new ScheduleStore(
      path.join(source.daemon.daemon.config.paseoHome, "schedules"),
      createTestLogger(),
    );
    const capturedSchedule = await sourceStore.get(scheduleId);
    if (!capturedSchedule) throw new Error("Missing retained source schedule");
    await sourceStore.update(scheduleId, (record) => ({ ...record, prompt: "Unreviewed change" }));
    expect((await source.client.handoffReleaseSource({ transferId })).error?.code).toBe(
      "source_changed",
    );
    await sourceStore.update(scheduleId, () => capturedSchedule);
    await stopHost(source);
    await stopHost(destination);
    source = await startHost("source", true);
    destination = await startHost("destination", true);
    const active = await activateWorkspaceHandoff({
      transferId,
      sourceServerId: source.daemon.daemon.getServerId(),
      getSource: () => source.client,
      destination: destination.client,
    });
    const destinationAgentId = active.agentMappings[0].destinationAgentId;
    expect((await destination.client.scheduleList()).schedules).toEqual([]);
    expect((await source.client.scheduleInspect({ id: scheduleId })).schedule).toMatchObject({
      status: "paused",
      target: { type: "new-agent", config: { cwd } },
      runs: [{ id: run.id, agentId, workspaceId, status: "failed" }],
    });
    expect(await readFile(path.join(worktree, "unfinished.txt"), "utf8")).toBe(
      "Keep the job's uncommitted changes",
    );
    expect(await readFile(path.join(active.destinationCwd, "unfinished.txt"), "utf8")).toBe(
      "Keep the job's uncommitted changes",
    );
    expect(
      (await destination.daemon.daemon.agentStorage.get(destinationAgentId))?.pendingRestartNote,
    ).toEqual([
      expect.objectContaining({
        kind: "handoff_retained_schedule",
        label: expect.stringContaining(`remains paused on the source host in ${cwd}`),
      }),
    ]);
    const history = await destination.client.handoffGetConversationHistory({
      agentId: destinationAgentId,
    });
    expect(history.error).toBeNull();
    expect(history.result).toMatchObject({
      mode: continuationMode,
      timeline: {
        entries: [
          expect.objectContaining({
            item: expect.objectContaining({ type: "user_message", text: prompt }),
          }),
        ],
      },
    });
    expect(destination.daemon.daemon.agentManager.getAgent(destinationAgentId)).toBeNull();
    expect((await source.client.scheduleResume({ id: scheduleId })).schedule?.status).toBe(
      "active",
    );
    const release = await source.daemon.daemon.handoffOwnership.acquireMutation({ cwd });
    release();
    await expect(
      source.daemon.daemon.handoffOwnership.acquireMutation({
        cwd: worktree,
        agentId,
        workspaceId,
      }),
    ).rejects.toMatchObject({ code: "fenced" });
  },
  30_000,
);

async function storedNativeRecord(host: Host, agentId: string) {
  const record = await host.daemon.daemon.agentStorage.get(agentId);
  if (!record?.persistence) throw new Error("Missing native record");
  return { ...record, persistence: record.persistence };
}

async function expectCapturedRuntimeUnchanged(host: Host, transferId: string, agentId: string) {
  const captured = await storedNativeRecord(host, agentId);
  const metadata = captured.persistence.metadata;
  for (const changed of [
    {
      ...metadata,
      claudeRuntime: { configDir: path.join(root, "changed-home"), cliVersion: "2.1.295" },
    },
    { ...metadata, claudeProjectDirName: "another-session-copy" },
  ]) {
    await host.daemon.daemon.agentStorage.upsert({
      ...captured,
      persistence: { ...captured.persistence, metadata: changed },
    });
    expect((await host.client.handoffReleaseSource({ transferId })).error?.code).toBe(
      "source_changed",
    );
  }
  await host.daemon.daemon.agentStorage.upsert({
    ...captured,
    cwd: path.join(root, "changed-cwd"),
  });
  expect((await host.client.handoffReleaseSource({ transferId })).error?.code).toBe(
    "source_changed",
  );
  await host.daemon.daemon.agentStorage.upsert(captured);
}

async function expectExportedHistory(
  client: DaemonClient,
  agentId: string,
  sourceAgentId: string,
  cwd: string,
) {
  const history = await client.handoffGetConversationHistory({ agentId, limit: 1 });
  expect(history.error).toBeNull();
  if (!history.result) throw new Error("Missing transferred conversation history");
  expect(history.result).toMatchObject({
    mode: "context",
    sourceAgentId,
    sourceCwd: await realpath(cwd),
    timeline: { hasOlder: true, hasNewer: false },
  });
  expect(history.result.timeline.entries).toHaveLength(1);
  expect(JSON.stringify(history.result.timeline.entries)).toContain("Last source note");
  const startCursor = history.result.timeline.startCursor;
  if (!startCursor) throw new Error("Missing history cursor");
  const older = await client.handoffGetConversationHistory({
    agentId,
    cursor: startCursor,
    limit: 1,
  });
  expect(older.error).toBeNull();
  expect(older.result?.timeline.entries).toHaveLength(1);
  expect(JSON.stringify(older.result?.timeline.entries)).toContain("previous-only-token");
  const middleCursor = older.result?.timeline.startCursor;
  if (!middleCursor) throw new Error("Missing middle history cursor");
  const first = await client.handoffGetConversationHistory({
    agentId,
    cursor: middleCursor,
    limit: 1,
  });
  expect(first.result?.timeline.hasOlder).toBe(false);
  expect(first.result?.timeline.epoch).toBe(history.result.timeline.epoch);
  expect(JSON.stringify(first.result?.timeline.entries)).toContain("First source note");
  expect((await client.handoffGetConversationHistory({ agentId: randomUUID() })).error?.code).toBe(
    "not_found",
  );
}

test.skipIf(process.platform === "win32")(
  "publishes source ownership in workspace snapshots through cancellation, release and restart",
  async () => {
    let source = await startHost("source");
    const cwd = path.join(root, "source-state-workspace");
    await mkdir(cwd);
    const created = await source.client.createWorkspace({
      source: { kind: "directory", path: cwd },
    });
    if (!created.workspace) throw new Error("Missing source workspace");
    expect(created.workspace.handoff).toBeNull();
    const workspaceId = created.workspace.id;
    const updates: unknown[] = [];
    const unsubscribe = source.client.on("workspace_update", ({ payload }) => {
      if (payload.kind === "upsert" && payload.workspace.id === workspaceId)
        updates.push(payload.workspace.handoff);
    });
    const subscription = source.client.observeWorkspaces();
    await subscription.ready;
    const request = {
      transferId: randomUUID(),
      workspaceId,
      agentIds: [],
      destinationServerId: "destination-host",
      reservationId: randomUUID(),
    };
    expect((await source.client.handoffPrepareSource(request)).error).toBeNull();
    const preparing = {
      transferId: request.transferId,
      destinationServerId: "destination-host",
      state: "preparing",
    };
    const ready = { ...preparing, state: "ready" };
    await expect.poll(() => updates).toEqual(expect.arrayContaining([preparing, ready]));
    expect((await source.client.fetchWorkspaces()).entries[0]?.handoff).toEqual(ready);
    expect((await source.client.handoffCancelSource(request)).error).toBeNull();
    await expect.poll(() => updates.at(-1)).toBeNull();
    expect((await source.client.fetchWorkspaces()).entries[0]?.handoff).toBeNull();
    const next = { ...request, transferId: randomUUID(), reservationId: randomUUID() };
    expect((await source.client.handoffPrepareSource(next)).error).toBeNull();
    expect(
      (await source.client.handoffReleaseSource({ transferId: next.transferId })).error,
    ).toBeNull();
    const released = { ...ready, transferId: next.transferId, state: "released" };
    await expect.poll(() => updates.at(-1)).toEqual(released);
    unsubscribe();
    await subscription.release();
    await stopHost(source);
    source = await startHost("source");
    expect((await source.client.fetchWorkspaces()).entries[0]?.handoff).toEqual(released);
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "reviews omitted files and nested terminals without stopping work until preparation",
  async () => {
    const source = await startHost("source");
    const cwd = path.join(root, "workspace");
    await mkdir(path.join(cwd, "nested"), { recursive: true });
    await writeFile(path.join(cwd, ".gitignore"), ".env\n");
    await writeFile(path.join(cwd, ".env"), "PRIVATE_VALUE=do-not-export\n");
    await writeFile(path.join(cwd, "notes.txt"), "move this\n");
    const created = await source.client.createWorkspace({
      source: { kind: "directory", path: cwd },
    });
    if (!created.workspace) throw new Error("Missing source workspace");
    const workspaceId = created.workspace.id;
    const manager = source.daemon.daemon.terminalManager;
    const terminals = [];
    for (const [name, directory] of [
      ["Root terminal", cwd],
      ["Nested terminal", path.join(cwd, "nested")],
    ]) {
      terminals.push(
        await manager.createTerminal({
          cwd: directory,
          workspaceId,
          name,
          command: process.execPath,
          args: ["-e", "setInterval(() => {}, 1000)"],
        }),
      );
    }
    const preview = await source.client.handoffPreviewSource({ workspaceId });
    expect(preview.error).toBeNull();
    expect(preview.result?.workspace).toEqual({
      kind: "directory",
      fileCount: 2,
      directoryCount: 1,
      symlinkCount: 0,
      fileBytes: Buffer.byteLength(".env\nmove this\n"),
      gitHistoryBytes: 0,
      omittedPaths: [".env"],
      omittedPathCount: 1,
      reviewDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(preview.result?.stoppedWork).toEqual({
      agentIds: [],
      setupOperations: 0,
      queuedMessages: 0,
      queuedBytes: 0,
      scheduledBytes: Buffer.byteLength(JSON.stringify({ version: 1, schedules: [] })),
      review: {
        agents: [],
        setupIds: [],
        pullRequestWatches: [],
        schedules: [],
        terminals: terminals
          .map(({ id, name }) => ({ id, name, instanceId: expect.any(String) }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      },
      terminals: terminals
        .map(({ id, name }) => ({ id, name }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    });
    expect(JSON.stringify(preview)).not.toContain("PRIVATE_VALUE");
    expect(terminals.map((terminal) => terminal.getExitInfo())).toEqual([null, null]);
    expect((await source.client.handoffFindSource({ workspaceId })).result).toBeNull();
    await writeFile(path.join(cwd, "notes.txt"), "still writable before preparation\n");
    const prepared = await source.client.handoffPrepareSource({
      transferId: randomUUID(),
      workspaceId,
      agentIds: [],
      destinationServerId: "destination",
      reservationId: randomUUID(),
    });
    expect(prepared.error).toBeNull();
    expect(prepared.result?.source.state).toBe("ready");
    expect(await manager.getTerminals(cwd)).toEqual([]);
    expect(terminals.every((terminal) => terminal.getExitInfo() !== null)).toBe(true);
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "requires a fresh review when a terminal is replaced before source preparation",
  async () => {
    let source = await startHost("source");
    let destination = await startHost("destination");
    const cwd = path.join(root, "reviewed-writers");
    await mkdir(cwd);
    const created = await source.client.createWorkspace({
      source: { kind: "directory", path: cwd },
    });
    if (!created.workspace) throw new Error("Missing workspace");
    const workspaceId = created.workspace.id;
    const manager = source.daemon.daemon.terminalManager;
    const launch = () =>
      manager.createTerminal({
        cwd,
        workspaceId,
        name: "Build",
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
      });
    const original = await launch();
    const preview = await source.client.handoffPreviewSource({ workspaceId });
    await manager.killTerminalAndWait(original.id);
    const replacement = await launch();
    const request = {
      source: source.client,
      destination: destination.client,
      transferId: randomUUID(),
      workspaceId,
      destinationParent: root,
      continuationMode: "context" as const,
      stoppedWorkReview: preview.result?.stoppedWork?.review,
    };
    await expect(prepareWorkspaceHandoff(request)).rejects.toThrow(
      "Work that will stop changed after review",
    );
    expect(replacement.getExitInfo()).toBeNull();
    expect((await source.client.handoffFindSource({ workspaceId })).result).toBeNull();
    expect((await destination.client.handoffGetDestinationStatus(request)).error?.code).toBe(
      "not_found",
    );
    const reserved = await destination.client.handoffReserveDestination({
      ...request,
      sourceServerId: source.daemon.daemon.getServerId(),
      sourceWorkspaceId: workspaceId,
      sourceAgentIds: [],
    });
    if (!reserved.result) throw new Error("Missing reservation");
    const prepare = {
      transferId: request.transferId,
      workspaceId,
      agentIds: [],
      destinationServerId: destination.daemon.daemon.getServerId(),
      reservationId: reserved.result.reservationId,
      stoppedWorkReview: request.stoppedWorkReview,
    };
    expect((await source.client.handoffPrepareSource(prepare)).error?.code).toBe("review_changed");
    expect(replacement.getExitInfo()).toBeNull();
    expect((await source.client.handoffFindSource({ workspaceId })).result).toBeNull();
    await cancelWorkspaceHandoff({
      sourceServerId: source.daemon.daemon.getServerId(),
      getSource: () => source.client,
      destination: destination.client,
      transferId: request.transferId,
    });
    const refreshed = await source.client.handoffPreviewSource({ workspaceId });
    const stoppedWorkReview = refreshed.result?.stoppedWork?.review;
    if (!stoppedWorkReview) throw new Error("Missing refreshed stopped work review");
    const next = { ...request, transferId: randomUUID(), stoppedWorkReview };
    const staged = await prepareWorkspaceHandoff(next);
    expect(replacement.getExitInfo()).not.toBeNull();
    expect(staged.stoppedWorkReview).toEqual(stoppedWorkReview);
    await stopHost(source);
    await stopHost(destination);
    source = await startHost("source");
    destination = await startHost("destination");
    expect(
      (await source.client.handoffGetSourceStatus(next)).result?.source.stoppedWorkReview,
    ).toEqual(stoppedWorkReview);
    expect(
      (await destination.client.handoffGetDestinationStatus(next)).result?.stoppedWorkReview,
    ).toEqual(stoppedWorkReview);
    expect(
      (
        await source.client.handoffPrepareSource({
          ...prepare,
          transferId: next.transferId,
          reservationId: staged.reservationId,
          stoppedWorkReview: undefined,
        })
      ).error?.code,
    ).toBe("conflict");
    const active = await activateWorkspaceHandoff({
      sourceServerId: source.daemon.daemon.getServerId(),
      getSource: () => source.client,
      destination: destination.client,
      transferId: next.transferId,
    });
    expect(active.state).toBe("active");
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "binds reviewed workspace exclusions through reservation, restart and release",
  async () => {
    let source = await startHost("source");
    let destination = await startHost("destination");
    const cwd = path.join(root, "reviewed-workspace");
    await mkdir(cwd);
    await writeFile(path.join(cwd, ".gitignore"), ".env*\n");
    await writeFile(path.join(cwd, ".env"), "private\n");
    await writeFile(path.join(cwd, "work.txt"), "reviewed work\n");
    const created = await source.client.createWorkspace({
      source: { kind: "directory", path: cwd },
    });
    if (!created.workspace) throw new Error("Missing workspace");
    const workspaceId = created.workspace.id;
    const preview = await source.client.handoffPreviewSource({ workspaceId });
    const workspaceReviewDigest = preview.result?.workspace?.reviewDigest;
    if (!workspaceReviewDigest) throw new Error("Missing workspace review digest");
    const request = {
      transferId: randomUUID(),
      workspaceId,
      destinationParent: root,
      continuationMode: "context" as const,
      workspaceReviewDigest,
    };
    await writeFile(path.join(cwd, ".gitignore"), "");
    await expect(
      prepareWorkspaceHandoff({
        ...request,
        source: source.client,
        destination: destination.client,
      }),
    ).rejects.toThrow("Workspace files or exclusions changed after review");
    expect((await destination.client.handoffGetDestinationStatus(request)).error?.code).toBe(
      "not_found",
    );
    expect((await source.client.handoffFindSource({ workspaceId })).result).toBeNull();
    const reserved = await destination.client.handoffReserveDestination({
      ...request,
      sourceServerId: source.daemon.daemon.getServerId(),
      sourceWorkspaceId: workspaceId,
      sourceAgentIds: [],
    });
    if (!reserved.result) throw new Error("Missing reservation");
    const prepare = {
      transferId: request.transferId,
      workspaceId,
      agentIds: [],
      workspaceReviewDigest,
      destinationServerId: destination.daemon.daemon.getServerId(),
      reservationId: reserved.result.reservationId,
    };
    expect((await source.client.handoffPrepareSource(prepare)).error?.code).toBe("review_changed");
    expect((await source.client.handoffFindSource({ workspaceId })).result).toBeNull();
    await writeFile(path.join(cwd, ".gitignore"), ".env*\n");
    await writeFile(path.join(cwd, "work.txt"), "latest saved work\n");
    const staged = await prepareWorkspaceHandoff({
      ...request,
      source: source.client,
      destination: destination.client,
    });
    expect(staged).toMatchObject({ state: "staged", workspaceReviewDigest });
    await stopHost(source);
    await stopHost(destination);
    source = await startHost("source");
    destination = await startHost("destination");
    expect(
      (await source.client.handoffGetSourceStatus(request)).result?.source.workspaceReviewDigest,
    ).toBe(workspaceReviewDigest);
    expect(
      (await destination.client.handoffGetDestinationStatus(request)).result?.workspaceReviewDigest,
    ).toBe(workspaceReviewDigest);
    expect(
      (await source.client.handoffPrepareSource({ ...prepare, workspaceReviewDigest: undefined }))
        .error?.code,
    ).toBe("conflict");
    await writeFile(path.join(cwd, ".env.new"), "new omitted file\n");
    const activate = () =>
      activateWorkspaceHandoff({
        sourceServerId: source.daemon.daemon.getServerId(),
        getSource: () => source.client,
        destination: destination.client,
        transferId: request.transferId,
      });
    await expect(activate()).rejects.toThrow("Workspace files or exclusions changed after review");
    expect((await source.client.handoffGetSourceStatus(request)).result?.source.state).toBe(
      "ready",
    );
    expect((await destination.client.fetchWorkspaces()).entries).toEqual([]);
    await rm(path.join(cwd, ".env.new"));
    const active = await activate();
    expect(await readFile(path.join(active.destinationCwd, "work.txt"), "utf8")).toBe(
      "latest saved work\n",
    );
    await expect(readFile(path.join(active.destinationCwd, ".env"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "discovers destination-only reservations in bounded pages after restart",
  async () => {
    const source = await startHost("source");
    let destination = await startHost("destination");
    const sourceServerId = source.daemon.daemon.getServerId();
    const query = { sourceServerId, sourceWorkspaceId: "lost-local-state" };
    const ids = Array.from(
      { length: 21 },
      (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    for (const transferId of ids) {
      await destination.client.handoffReserveDestination({
        ...query,
        transferId,
        sourceAgentIds: [],
        destinationParent: root,
        continuationMode: "context",
      });
    }
    await stopHost(destination);
    destination = await startHost("destination");
    const first = await destination.client.handoffListDestination(query);
    expect(first.error).toBeNull();
    expect(first.result?.transfers.map((transfer) => transfer.transferId)).toEqual(
      ids.slice(0, 20),
    );
    expect(first.result?.nextCursor).toBe(ids[19]);
    const last = await destination.client.handoffListDestination({ ...query, cursor: ids[19] });
    expect(last.result?.transfers).toEqual([
      {
        transferId: ids[20],
        ...query,
        destinationCwd: (
          await destination.client.handoffGetDestinationStatus({ transferId: ids[20] })
        ).result?.destinationCwd,
        continuationMode: "context",
        state: "reserved",
      },
    ]);
    expect(last.result?.nextCursor).toBeNull();
    expect(
      (
        await destination.client.handoffListDestination({
          ...query,
          sourceWorkspaceId: "another-workspace",
        })
      ).result,
    ).toEqual({ transfers: [], nextCursor: null });
    expect(
      (
        await destination.client.handoffListDestination({
          ...query,
          sourceServerId: "another-host",
        })
      ).result,
    ).toEqual({ transfers: [], nextCursor: null });
    await cancelWorkspaceHandoff({
      sourceServerId: source.daemon.daemon.getServerId(),
      getSource: () => source.client,
      destination: destination.client,
      transferId: ids[0],
    });
    const afterCancel = await destination.client.handoffListDestination(query);
    expect(afterCancel.result?.transfers.map((transfer) => transfer.transferId)).toEqual(
      ids.slice(1),
    );
    expect(afterCancel.result?.nextCursor).toBeNull();
    expect((await destination.client.fetchWorkspaces()).entries).toEqual([]);
    await stopHost(source);
    const removedOrigin = {
      sourceServerId: "removed-source",
      sourceWorkspaceId: "removed-workspace",
    };
    const orphanId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await destination.client.handoffReserveDestination({
      ...removedOrigin,
      transferId: orphanId,
      sourceAgentIds: [],
      destinationParent: root,
      continuationMode: "context",
    });
    const global = await destination.client.handoffListDestination({});
    expect(global.error).toBeNull();
    expect(global.result?.transfers.map(({ transferId }) => transferId)).toEqual(ids.slice(1));
    expect(global.result?.nextCursor).toBe(ids[20]);
    const remaining = await destination.client.handoffListDestination({ cursor: ids[20] });
    expect(remaining.result?.transfers).toEqual([
      expect.objectContaining({ ...removedOrigin, transferId: orphanId, state: "reserved" }),
    ]);
    expect(remaining.result?.nextCursor).toBeNull();
    expect((await destination.client.handoffListDestination(removedOrigin)).result).toEqual(
      remaining.result,
    );
  },
  30_000,
);

test.skipIf(process.platform === "win32").each(["reserved", "staged"] as const)(
  "cancels a %s handoff after a lost source cancellation reply and host restart",
  async (phase) => {
    let source = await startHost("source");
    let destination = await startHost("destination");
    const cwd = path.join(root, "cancel-workspace");
    await mkdir(cwd);
    await writeFile(path.join(cwd, "work.txt"), "Original work");
    const created = await source.client.createWorkspace({
      source: { kind: "directory", path: cwd },
    });
    if (!created.workspace) throw new Error("Missing workspace");
    const transferId = randomUUID();
    const request = {
      transferId,
      workspaceId: created.workspace.id,
      destinationParent: root,
      continuationMode: "native" as const,
    };
    const reservation = await destination.client.handoffReserveDestination({
      transferId,
      sourceServerId: source.daemon.daemon.getServerId(),
      sourceWorkspaceId: request.workspaceId,
      sourceAgentIds: [],
      destinationParent: root,
      continuationMode: "native",
    });
    if (!reservation.result) throw new Error("Missing reservation");
    if (phase === "staged")
      await prepareWorkspaceHandoff({
        ...request,
        source: source.client,
        destination: destination.client,
      });
    const cancelRequest = {
      transferId,
      destinationServerId: destination.daemon.daemon.getServerId(),
      reservationId: reservation.result.reservationId,
    };
    const cancelled = await source.client.handoffCancelSource(cancelRequest);
    expect(cancelled.error).toBeNull();
    if (!cancelled.result) throw new Error("Missing cancellation proof");
    const invalid = await destination.client.handoffCancelDestination({
      transferId,
      proof: {
        ...cancelled.result,
        receipt: { ...cancelled.result.receipt, signature: "invalid-signature" },
      },
    });
    expect(invalid.error?.code).toBe("invalid_cancellation");
    expect(
      (await destination.client.handoffGetDestinationStatus({ transferId })).result?.state,
    ).toBe(phase);
    // Source committed cancellation, but its reply was not forwarded before both hosts restarted.
    await stopHost(source);
    await stopHost(destination);
    source = await startHost("source");
    destination = await startHost("destination");
    expect((await source.client.handoffCancelSource(cancelRequest)).result).toEqual(
      cancelled.result,
    );
    const discovered = await source.client.handoffGetSourceStatus({ transferId });
    expect(discovered.error).toBeNull();
    expect(discovered.cancellation).toEqual(cancelled.result);
    expect(discovered.result?.source.state ?? null).toBe(phase === "reserved" ? null : "cancelled");
    const delayed = await source.client.handoffPrepareSource({
      ...cancelRequest,
      workspaceId: request.workspaceId,
      agentIds: [],
    });
    expect(delayed.error?.code).toBe("invalid_state");
    const result = await cancelWorkspaceHandoff({
      sourceServerId: source.daemon.daemon.getServerId(),
      getSource: () => source.client,
      destination: destination.client,
      transferId,
    });
    expect(result.state).toBe("cancelled");
    expect(result.cleanupComplete).toBe(true);
    expect(result.cancellationAccepted).toBe(true);
    expect(
      await cancelWorkspaceHandoff({
        sourceServerId: source.daemon.daemon.getServerId(),
        getSource: () => source.client,
        destination: destination.client,
        transferId,
      }),
    ).toEqual(result);
    await stopHost(source);
    expect(
      await cancelWorkspaceHandoff({
        sourceServerId: result.sourceServerId,
        getSource: () => {
          throw new Error("Source is offline");
        },
        destination: destination.client,
        transferId,
      }),
    ).toEqual(result);
    source = await startHost("source");
    expect(await readFile(path.join(cwd, "work.txt"), "utf8")).toBe("Original work");
    expect(
      await source.daemon.daemon.handoffOwnership.withMutation({ cwd }, async () => "resumed"),
    ).toBe("resumed");
    await expect(
      readdir(path.join(root, `.paseo-handoff-${result.reservationId}`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await destination.client.fetchWorkspaces()).entries).toEqual([]);
  },
  30_000,
);

test.skipIf(process.platform === "win32").each(["native", "context"] as const)(
  "transfers queued text, images and uploaded files held through %s activation and destination restart",
  async (continuationMode) => {
    let source = await startHost("source", true);
    let destination = await startHost("destination", true);
    const cwd = path.join(await realpath(root), "transported-queue-workspace");
    await mkdir(cwd);
    await writeFile(path.join(cwd, "work.txt"), "Prior work");
    const created = await source.client.createWorkspace({
      source: { kind: "directory", path: cwd },
    });
    if (!created.workspace) throw new Error("Missing workspace");
    const agentId = randomUUID();
    const sessionId = randomUUID();
    const configDir = path.join(root, "source", "claude");
    const project = claudeProjectDirSync(cwd, { configDir });
    await mkdir(project, { recursive: true });
    await writeFile(
      path.join(project, `${sessionId}.jsonl`),
      JSON.stringify({
        type: "user",
        uuid: randomUUID(),
        sessionId,
        message: { role: "user", content: "Keep the prior task" },
      }) + "\n",
    );
    await source.daemon.daemon.agentStorage.upsert(
      parseStoredAgentRecord({
        id: agentId,
        provider: "claude",
        cwd,
        workspaceId: created.workspace.id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastStatus: "closed",
        persistence: {
          provider: "claude",
          sessionId,
          metadata: { cwd, claudeRuntime: { configDir, cliVersion: "2.1.295" } },
        },
      }),
    );
    const queue = source.daemon.daemon.agentManager.messageQueue;
    await queue.hold(agentId, "user_stop");
    const fileBytes = Buffer.from([0, 255, 128, 42]);
    const uploaded = await source.client.uploadFile({
      requestId: randomUUID(),
      fileName: "pending binary.bin",
      mimeType: "application/octet-stream",
      bytes: fileBytes,
    });
    if (!uploaded.file) throw new Error("Missing queued upload");
    const review = {
      type: "review" as const,
      mimeType: "application/paseo-review" as const,
      cwd,
      mode: "base" as const,
      baseRef: "main",
      comments: [
        {
          filePath: "deleted.ts",
          side: "old" as const,
          lineNumber: 3,
          body: "Keep the explanation even though this file was deleted.",
          context: {
            hunkHeader: "@@ -3 +2,0 @@",
            targetLine: {
              oldLineNumber: 3,
              newLineNumber: null,
              type: "remove" as const,
              content: "removed();",
            },
            lines: [
              {
                oldLineNumber: 3,
                newLineNumber: null,
                type: "remove" as const,
                content: "removed();",
              },
            ],
          },
        },
      ],
    };
    const issue = {
      type: "forge_issue" as const,
      mimeType: "application/paseo-forge-issue" as const,
      forge: "gitlab",
      projectPath: "group/subgroup/repo",
      number: 42,
      title: "Continue the review",
      url: "https://gitlab.example/group/subgroup/repo/-/issues/42",
    };
    const prompts = [
      "Do not lose the next task",
      [
        { type: "text" as const, text: "Then inspect this image" },
        { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" },
      ],
      [{ type: "text" as const, text: "Then read this file" }, uploaded.file, review, issue],
    ];
    for (const [index, prompt] of prompts.entries()) {
      const queued = await queue.enqueue(
        agentId,
        {
          id: `pending-${index}`,
          origin: "user",
          senderAgentId: null,
          textPreview: "",
          prompt,
          wake: null,
        },
        async () => {
          throw new Error("Handoff must leave pending work paused");
        },
      );
      void queued.settled.catch(() => undefined);
    }
    const preview = await source.client.handoffPreviewSource({ workspaceId: created.workspace.id });
    expect(preview.result?.stoppedWork?.queuedMessages).toBe(3);
    expect(preview.result?.stoppedWork?.queuedBytes).toBeGreaterThan(fileBytes.length);
    const staged = await prepareWorkspaceHandoff({
      transferId: randomUUID(),
      workspaceId: created.workspace.id,
      destinationParent: root,
      continuationMode,
      source: source.client,
      destination: destination.client,
    });
    expect(staged.state).toBe("staged");
    const sourcePrompt = queue.entries(agentId)[0];
    if (!sourcePrompt?.promptFile) throw new Error("Missing queued prompt file");
    const promptPath = path.join(
      source.daemon.paseoHome,
      "agent-queues",
      agentId,
      sourcePrompt.promptFile,
    );
    const capturedPrompt = await readFile(promptPath);
    await writeFile(promptPath, JSON.stringify("changed after preparation"));
    const refused = await source.client.handoffReleaseSource({ transferId: staged.transferId });
    expect(refused.error?.code).toBe("source_changed");
    await writeFile(promptPath, capturedPrompt);
    await writeFile(uploaded.file.path, Buffer.from([0, 255, 127, 42]));
    expect(
      (await source.client.handoffReleaseSource({ transferId: staged.transferId })).error?.code,
    ).toBe("source_changed");
    await writeFile(uploaded.file.path, fileBytes);
    const reviewPromptFile = queue.entries(agentId)[2].promptFile;
    if (!reviewPromptFile) throw new Error("Missing queued review prompt");
    const reviewPromptPath = path.join(
      source.daemon.paseoHome,
      "agent-queues",
      agentId,
      reviewPromptFile,
    );
    const capturedReviewPrompt = await readFile(reviewPromptPath, "utf8");
    await writeFile(
      reviewPromptPath,
      capturedReviewPrompt.replace(review.comments[0].body, "Changed review after capture"),
    );
    expect(
      (await source.client.handoffReleaseSource({ transferId: staged.transferId })).error?.code,
    ).toBe("source_changed");
    await writeFile(reviewPromptPath, capturedReviewPrompt);
    await stopHost(source);
    await stopHost(destination);
    source = await startHost("source", true);
    destination = await startHost("destination", true);
    const activation = {
      transferId: staged.transferId,
      sourceServerId: source.daemon.daemon.getServerId(),
      getSource: () => source.client,
      destination: destination.client,
    };
    const active = await activateWorkspaceHandoff(activation);
    const destinationAgentId = active.agentMappings[0]!.destinationAgentId;
    expect((await destination.client.listAgentQueue(destinationAgentId)).queue).toMatchObject({
      held: true,
      heldReason: "user_stop",
      entries: [
        { origin: "user", textPreview: "Do not lose the next task", attachmentCount: 0 },
        { origin: "user", textPreview: "Then inspect this image", attachmentCount: 1 },
        { origin: "user", textPreview: "Then read this file", attachmentCount: 3 },
      ],
    });
    expect(destination.daemon.daemon.agentManager.getAgent(destinationAgentId)).toBeNull();
    const imported = await destination.daemon.daemon.agentManager.messageQueue.exportForHandoff(
      destinationAgentId,
      { workspaceCwd: active.destinationCwd },
    );
    expect(imported.entries.slice(0, 2).map((entry) => entry.prompt)).toEqual(prompts.slice(0, 2));
    const importedFile = imported.files?.[0].attachment;
    if (!importedFile) throw new Error("Missing destination upload");
    expect(imported.entries[2].prompt).toEqual([
      { type: "text", text: "Then read this file" },
      importedFile,
      { ...review, cwd: active.destinationCwd },
      issue,
    ]);
    expect(importedFile.path.startsWith(destination.daemon.paseoHome)).toBe(true);
    expect(await readFile(importedFile.path)).toEqual(fileBytes);
    expect(imported.entries.map((entry) => entry.id)).not.toEqual([
      "pending-0",
      "pending-1",
      "pending-2",
    ]);
    await stopHost(destination);
    destination = await startHost("destination", true);
    expect(
      (await activateWorkspaceHandoff({ ...activation, destination: destination.client })).state,
    ).toBe("active");
    expect(
      await destination.daemon.daemon.agentManager.messageQueue.exportForHandoff(
        destinationAgentId,
        { workspaceCwd: active.destinationCwd },
      ),
    ).toEqual(imported);
    expect((await destination.client.listAgentQueue(destinationAgentId)).queue.held).toBe(true);
    expect(destination.daemon.daemon.agentManager.getAgent(destinationAgentId)).toBeNull();
    expect(
      (
        await source.daemon.daemon.agentManager.messageQueue.exportForHandoff(agentId, {
          workspaceCwd: cwd,
        })
      ).entries.map((entry) => entry.prompt),
    ).toEqual(prompts);
    const returning = await prepareWorkspaceHandoff({
      transferId: randomUUID(),
      workspaceId: active.workspaceId,
      destinationParent: root,
      continuationMode,
      source: destination.client,
      destination: source.client,
    });
    const returned = await activateWorkspaceHandoff({
      transferId: returning.transferId,
      sourceServerId: destination.daemon.daemon.getServerId(),
      getSource: () => destination.client,
      destination: source.client,
    });
    const returnedQueue = await source.daemon.daemon.agentManager.messageQueue.exportForHandoff(
      returned.agentMappings[0]!.destinationAgentId,
      { workspaceCwd: returned.destinationCwd },
    );
    const returnedFile = returnedQueue.files?.[0].attachment;
    if (!returnedFile) throw new Error("Missing returned queued upload");
    expect(returnedFile.path).not.toBe(uploaded.file.path);
    expect(await readFile(returnedFile.path)).toEqual(fileBytes);
    expect(returnedQueue.entries[2].prompt).toEqual([
      { type: "text", text: "Then read this file" },
      returnedFile,
      { ...review, cwd: returned.destinationCwd },
      issue,
    ]);
    expect(
      (await source.client.listAgentQueue(returned.agentMappings[0]!.destinationAgentId)).queue
        .held,
    ).toBe(true);
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "holds source queued messages through handoff preparation, restart and cancellation",
  async () => {
    let source = await startHost("source", true);
    let destination = await startHost("destination", true);
    const cwd = path.join(root, "queued-workspace");
    await mkdir(cwd);
    await writeFile(path.join(cwd, "work.txt"), "Prior work");
    const created = await source.client.createWorkspace({
      source: { kind: "directory", path: cwd },
    });
    if (!created.workspace) throw new Error("Missing workspace");
    const agentId = randomUUID();
    const sessionId = randomUUID();
    const configDir = path.join(root, "source", "claude");
    const project = claudeProjectDirSync(cwd, { configDir });
    await mkdir(project, { recursive: true });
    await writeFile(
      path.join(project, `${sessionId}.jsonl`),
      JSON.stringify({
        type: "user",
        uuid: randomUUID(),
        sessionId,
        message: { role: "user", content: "Keep the prior task" },
      }) + "\n",
    );
    await source.daemon.daemon.agentStorage.upsert(
      parseStoredAgentRecord({
        id: agentId,
        provider: "claude",
        cwd,
        workspaceId: created.workspace.id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastStatus: "closed",
        persistence: {
          provider: "claude",
          sessionId,
          metadata: { cwd, claudeRuntime: { configDir, cliVersion: "2.1.295" } },
        },
      }),
    );
    const queue = source.daemon.daemon.agentManager.messageQueue;
    await queue.hold(agentId, "user_stop");
    const queued = await queue.enqueue(
      agentId,
      {
        id: "next-user-task",
        origin: "user",
        senderAgentId: null,
        textPreview: "",
        prompt: "Do not lose this pending instruction",
        wake: null,
      },
      async () => {
        throw new Error("Preparation must not deliver queued work");
      },
    );
    void queued.settled.catch(() => undefined);
    const transferId = randomUUID();
    const staged = await prepareWorkspaceHandoff({
      transferId,
      workspaceId: created.workspace.id,
      destinationParent: root,
      continuationMode: "native",
      source: source.client,
      destination: destination.client,
    });
    expect(staged.state).toBe("staged");
    expect((await source.client.listAgentQueue(agentId)).queue).toMatchObject({
      held: true,
      entries: [{ id: "next-user-task", textPreview: "Do not lose this pending instruction" }],
    });
    await expect(source.client.resumeAgentQueue(agentId)).rejects.toThrow("held by handoff");
    await expect(
      source.client.editQueuedAgentMessage(agentId, "next-user-task", "changed"),
    ).rejects.toThrow("held by handoff");
    await expect(source.client.cancelQueuedAgentMessage(agentId, "next-user-task")).rejects.toThrow(
      "held by handoff",
    );
    await stopHost(source);
    source = await startHost("source", true);
    expect((await source.client.listAgentQueue(agentId)).queue).toMatchObject({
      held: true,
      entries: [{ id: "next-user-task", textPreview: "Do not lose this pending instruction" }],
    });
    const cancelled = await cancelWorkspaceHandoff({
      transferId,
      sourceServerId: source.daemon.daemon.getServerId(),
      getSource: () => source.client,
      destination: destination.client,
    });
    expect(cancelled.state).toBe("cancelled");
    expect((await source.client.listAgentQueue(agentId)).queue.held).toBe(true);
    expect(
      (
        await source.client.editQueuedAgentMessage(
          agentId,
          "next-user-task",
          "Still pending after cancellation",
        )
      ).accepted,
    ).toBe(true);
    const stored = source.daemon.daemon.agentManager.messageQueue.entries(agentId)[0];
    if (!stored?.promptFile) throw new Error("Pending prompt was lost");
    expect(
      JSON.parse(
        await readFile(
          path.join(source.daemon.paseoHome, "agent-queues", agentId, stored.promptFile),
          "utf8",
        ),
      ),
    ).toBe("Still pending after cancellation");
    expect(source.daemon.daemon.agentManager.getAgent(agentId)).toBeNull();
    expect((await destination.client.fetchWorkspaces()).entries).toEqual([]);
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "reviews and durably stops source PR watches before capture without restarting them on destination",
  async () => {
    let source = await startHost("source", true);
    let destination = await startHost("destination", true);
    const cwd = path.join(root, "watched-workspace");
    await mkdir(cwd);
    await writeFile(path.join(cwd, "work.txt"), "Prior work");
    const created = await source.client.createWorkspace({
      source: { kind: "directory", path: cwd },
    });
    if (!created.workspace) throw new Error("Missing workspace");
    const agentId = randomUUID();
    const sessionId = randomUUID();
    const configDir = path.join(root, "source", "claude");
    const project = claudeProjectDirSync(cwd, { configDir });
    await mkdir(project, { recursive: true });
    await writeFile(
      path.join(project, `${sessionId}.jsonl`),
      JSON.stringify({
        type: "user",
        uuid: randomUUID(),
        sessionId,
        message: { role: "user", content: "Keep the PR task" },
      }) + "\n",
    );
    await source.daemon.daemon.agentStorage.upsert(
      parseStoredAgentRecord({
        id: agentId,
        provider: "claude",
        cwd,
        workspaceId: created.workspace.id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastStatus: "closed",
        persistence: {
          provider: "claude",
          sessionId,
          metadata: { cwd, claudeRuntime: { configDir, cliVersion: "2.1.295" } },
        },
      }),
    );
    const watches = new PullRequestWatchStore(
      path.join(source.daemon.paseoHome, "pull-request-watches.json"),
    );
    const watch = {
      id: randomUUID(),
      agentId,
      cwd,
      number: 42,
      url: "https://github.com/example/work/pull/42",
      title: "Prior PR task",
      headRefName: "work",
      startedAt: new Date().toISOString(),
      progress: {
        headSha: null,
        failedChecks: [],
        passed: false,
        passedChecks: [],
        remarksThrough: 0,
        remarkIds: [],
        conflicting: false,
        wakes: 0,
      },
    };
    await watches.add(watch);
    const preview = (
      await source.client.handoffPreviewSource({ workspaceId: created.workspace.id })
    ).result;
    if (!preview?.stoppedWork?.review) throw new Error("Missing review");
    expect(preview.stoppedWork.review.pullRequestWatches).toEqual([
      expect.objectContaining({ id: watch.id, agentId, number: 42 }),
    ]);
    const replacement = { ...watch, id: randomUUID() };
    await watches.remove(watch.id);
    await watches.add(replacement);
    const request = {
      transferId: randomUUID(),
      workspaceId: created.workspace.id,
      destinationParent: root,
      continuationMode: "native" as const,
      stoppedWorkReview: preview.stoppedWork.review,
    };
    await expect(
      prepareWorkspaceHandoff({
        ...request,
        source: source.client,
        destination: destination.client,
      }),
    ).rejects.toThrow("Work that will stop changed");
    expect(
      (await source.client.handoffFindSource({ workspaceId: created.workspace.id })).result,
    ).toBeNull();
    const refreshed = (
      await source.client.handoffPreviewSource({ workspaceId: created.workspace.id })
    ).result;
    if (!refreshed?.stoppedWork?.review) throw new Error("Missing fresh review");
    const staged = await prepareWorkspaceHandoff({
      ...request,
      stoppedWorkReview: refreshed.stoppedWork.review,
      source: source.client,
      destination: destination.client,
    });
    expect(await watches.list()).toEqual([]);
    expect(staged.stoppedWorkReview?.pullRequestWatches).toEqual(
      refreshed.stoppedWork.review.pullRequestWatches,
    );
    await stopHost(source);
    await stopHost(destination);
    source = await startHost("source", true);
    destination = await startHost("destination", true);
    expect(await watches.list()).toEqual([]);
    const active = await activateWorkspaceHandoff({
      transferId: request.transferId,
      sourceServerId: source.daemon.daemon.getServerId(),
      getSource: () => source.client,
      destination: destination.client,
    });
    expect(active.state).toBe("active");
    const moved = await destination.daemon.daemon.agentStorage.get(
      active.agentMappings[0]!.destinationAgentId,
    );
    expect(moved?.pendingRestartNote).toEqual([
      {
        id: `handoff:${request.transferId}:pr-watch:${replacement.id}`,
        kind: "handoff_pull_request_watch",
        label:
          "PR #42 (https://github.com/example/work/pull/42). Restart this watch explicitly if needed.",
      },
    ]);
    expect(
      await new PullRequestWatchStore(
        path.join(destination.daemon.paseoHome, "pull-request-watches.json"),
      ).list(),
    ).toEqual([]);
    expect(await readFile(path.join(active.destinationCwd, "work.txt"), "utf8")).toBe("Prior work");
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "persists client signing checkpoints before effects and rejects changed bindings after restart",
  async () => {
    let source = await startHost("source");
    let destination = await startHost("destination");
    const sourceServerId = source.daemon.daemon.getServerId();
    const cwd = path.join(root, "checkpoint-workspace");
    await mkdir(cwd);
    await writeFile(path.join(cwd, "work.txt"), "Retained client binding");
    const created = await source.client.createWorkspace({
      source: { kind: "directory", path: cwd },
    });
    if (!created.workspace) throw new Error("Missing workspace");
    const transferId = randomUUID();
    const request = {
      transferId,
      workspaceId: created.workspace.id,
      destinationParent: root,
      continuationMode: "context" as const,
    };
    const file = path.join(root, "client-checkpoint.json");
    const readCheckpoint = async (): Promise<WorkspaceHandoffCheckpoint> =>
      JSON.parse(await readFile(file, "utf8"));
    let failure: "reservation" | "key" | null = "reservation";
    const onCheckpoint = async (checkpoint: WorkspaceHandoffCheckpoint) => {
      if (failure === "reservation" || (failure === "key" && checkpoint.sourcePublicKey))
        throw new Error("Client checkpoint disk failed");
      if (checkpoint.snapshot.state === "reserved" && checkpoint.sourcePublicKey) {
        const target = await destination.client.handoffGetDestinationStatus({ transferId });
        expect(target.result?.state).toBe("reserved");
        expect(target.result?.sourcePublicKey).toBeUndefined();
      }
      await writeFile(file, JSON.stringify(checkpoint));
    };
    await expect(
      prepareWorkspaceHandoff({
        ...request,
        source: source.client,
        destination: destination.client,
        onCheckpoint,
      }),
    ).rejects.toThrow("Client checkpoint disk failed");
    expect(
      (await source.client.handoffFindSource({ workspaceId: created.workspace.id })).result,
    ).toBeNull();
    expect(
      (await destination.client.handoffGetDestinationStatus({ transferId })).result?.state,
    ).toBe("reserved");
    failure = "key";
    await expect(
      prepareWorkspaceHandoff({
        ...request,
        source: source.client,
        destination: destination.client,
        onCheckpoint,
      }),
    ).rejects.toThrow("Client checkpoint disk failed");
    expect((await source.client.handoffGetSourceStatus({ transferId })).result?.source.state).toBe(
      "ready",
    );
    expect(
      (await destination.client.handoffGetDestinationStatus({ transferId })).result?.state,
    ).toBe("reserved");
    expect((await readCheckpoint()).sourcePublicKey).toBeUndefined();
    failure = null;
    const staged = await prepareWorkspaceHandoff({
      ...request,
      source: source.client,
      destination: destination.client,
      checkpoint: await readCheckpoint(),
      onCheckpoint,
    });
    const saved = await readCheckpoint();
    expect(saved.snapshot).toEqual(staged);
    expect(saved.sourcePublicKey).toBe(
      (await source.client.handoffGetSourceStatus({ transferId })).result?.source.publicKey,
    );
    expect(saved.sourcePublicKey).toBe(staged.sourcePublicKey);
    await stopHost(source);
    await stopHost(destination);
    source = await startHost("source");
    destination = await startHost("destination");
    const activation = {
      sourceServerId,
      getSource: () => source.client,
      destination: destination.client,
      transferId,
    };
    for (const checkpoint of [
      { ...saved, destinationServerId: "changed-host" },
      { ...saved, sourcePublicKey: "changed-key" },
      { ...saved, snapshot: { ...saved.snapshot, reservationId: randomUUID() } },
      { ...saved, snapshot: { ...saved.snapshot, workspaceId: "changed-workspace" } },
      { ...saved, snapshot: { ...saved.snapshot, manifestDigest: "b".repeat(64) } },
    ]) {
      await expect(activateWorkspaceHandoff({ ...activation, checkpoint })).rejects.toThrow(
        /changed/,
      );
      await expect(cancelWorkspaceHandoff({ ...activation, checkpoint })).rejects.toThrow(
        /changed/,
      );
      expect(
        (await source.client.handoffGetSourceStatus({ transferId })).result?.source.state,
      ).toBe("ready");
      expect(
        (await destination.client.handoffGetDestinationStatus({ transferId })).result?.state,
      ).toBe("staged");
    }
    const getSourceStatus = source.client.handoffGetSourceStatus.bind(source.client);
    for (const operation of [activateWorkspaceHandoff, cancelWorkspaceHandoff]) {
      const changedSource = vi
        .spyOn(source.client, "handoffGetSourceStatus")
        .mockImplementationOnce(async (input) => {
          const response = await getSourceStatus(input);
          if (!response.result) throw new Error("Missing source status");
          return {
            ...response,
            result: {
              ...response.result,
              source: { ...response.result.source, publicKey: "changed-key" },
            },
          };
        });
      await expect(operation({ ...activation, checkpoint: saved })).rejects.toThrow(
        "signing key changed",
      );
      changedSource.mockRestore();
      expect((await getSourceStatus({ transferId })).result?.source.state).toBe("ready");
    }
    failure = "reservation";
    await expect(
      activateWorkspaceHandoff({ ...activation, checkpoint: saved, onCheckpoint }),
    ).rejects.toThrow("Client checkpoint disk failed");
    expect((await source.client.handoffGetSourceStatus({ transferId })).result?.source.state).toBe(
      "ready",
    );
    failure = null;
    const active = await activateWorkspaceHandoff({
      ...activation,
      checkpoint: saved,
      onCheckpoint,
    });
    expect(active.state).toBe("active");
    expect((await readCheckpoint()).sourcePublicKey).toBe(saved.sourcePublicKey);
    expect(await readFile(path.join(active.destinationCwd, "work.txt"), "utf8")).toBe(
      "Retained client binding",
    );
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "coordinates handoff over RPC and recovers a lost release reply after reconnect",
  async () => {
    let source = await startHost("source");
    const sourceServerId = source.daemon.daemon.getServerId();
    let destination = await startHost("destination");
    const cwd = path.join(root, "rpc-workspace");
    await mkdir(cwd);
    await writeFile(path.join(cwd, "work.txt"), "Pending work");
    const created = await source.client.createWorkspace({
      source: { kind: "directory", path: cwd },
    });
    if (!created.workspace) throw new Error("Workspace creation failed");
    const workspaceLookup = { workspaceId: created.workspace.id };
    expect(await source.client.handoffFindSource(workspaceLookup)).toMatchObject({
      result: null,
      error: null,
    });
    const inspected = await source.client.handoffInspectSource({
      workspaceId: created.workspace.id,
    });
    expect(inspected.error).toBeNull();
    expect(inspected.result).toMatchObject({ workspaceId: created.workspace.id, agentIds: [] });
    const transferId = randomUUID();
    const request = {
      transferId,
      workspaceId: created.workspace.id,
      destinationParent: root,
      continuationMode: "native" as const,
    };
    const staged = await prepareWorkspaceHandoff({
      ...request,
      source: source.client,
      destination: destination.client,
    });
    expect(staged.state).toBe("staged");
    const discovered = await source.client.handoffFindSource(workspaceLookup);
    expect(discovered.error).toBeNull();
    expect(discovered.result).toEqual(
      (await source.client.handoffGetSourceStatus({ transferId })).result?.source,
    );
    expect(discovered.result).toMatchObject({ id: transferId, state: "ready" });
    expect(discovered.result).not.toHaveProperty("privateKey");
    expect(
      await source.client.handoffFindSource({ workspaceId: "another-workspace" }),
    ).toMatchObject({
      result: null,
      error: null,
    });
    expect((await destination.client.fetchWorkspaces()).entries).toEqual([]);
    const unreleased = await destination.client.handoffActivateDestination({ transferId });
    expect(unreleased.error?.code).toBe("invalid_state");
    await expect(
      activateWorkspaceHandoff({
        sourceServerId,
        getSource: () => destination.client,
        destination: destination.client,
        transferId,
      }),
    ).rejects.toThrow("Source connection belongs to another host");
    const release = await source.client.handoffReleaseSource({ transferId });
    expect(release.error).toBeNull();
    if (!release.result) throw new Error("Missing release receipt");
    await expect(
      cancelWorkspaceHandoff({
        sourceServerId: source.daemon.daemon.getServerId(),
        getSource: () => source.client,
        destination: destination.client,
        transferId,
      }),
    ).rejects.toThrow("Source ownership was released");
    const refused = await destination.client.handoffActivateDestination({
      transferId,
      receipt: { ...release.result, signature: "invalid-signature" },
    });
    expect(refused.error?.code).toBe("invalid_release");
    expect(
      (await destination.client.handoffGetDestinationStatus({ transferId })).result?.state,
    ).toBe("staged");
    // The client lost the reply before forwarding it, then both hosts restarted.
    await stopHost(source);
    await stopHost(destination);
    await rm(cwd, { recursive: true });
    await rm(path.join(source.daemon.paseoHome, "handoff"), { recursive: true });
    destination = await startHost("destination");
    await expect(
      activateWorkspaceHandoff({
        sourceServerId,
        getSource: () => source.client,
        destination: destination.client,
        transferId,
      }),
    ).rejects.toThrow("Connect both handoff hosts before continuing");
    expect((await destination.client.fetchWorkspaces()).entries).toEqual([]);
    source = await startHost("source");
    expect(await source.client.handoffGetSourceStatus({ transferId })).toMatchObject({
      error: null,
      result: { source: { state: "released" }, manifest: null },
    });
    expect(await source.client.handoffReleaseSource({ transferId })).toMatchObject({
      error: null,
      result: release.result,
    });
    const staging = destination.daemon.daemon.handoffDestination.status(transferId);
    await writeFile(path.join(staging.stagingCwd, "work.txt"), "Interrupted destination write");
    const resumed = await prepareWorkspaceHandoff({
      ...request,
      source: source.client,
      destination: destination.client,
    });
    expect(resumed).toEqual(staged);
    expect(await readFile(path.join(staging.stagingCwd, "work.txt"), "utf8")).toBe("Pending work");
    expect(await source.client.handoffFindSource(workspaceLookup)).toMatchObject({
      error: null,
      result: { ...discovered.result, state: "released" },
    });
    // A previous client reached release acceptance but stopped before activation.
    await destination.daemon.daemon.handoffDestination.acceptRelease(transferId, release.result);
    const accepted = await prepareWorkspaceHandoff({
      ...request,
      source: source.client,
      destination: destination.client,
    });
    expect(accepted.state).toBe("released");
    // Once the destination has the signed release, recovery must not need the source.
    await stopHost(source);
    await stopHost(destination);
    destination = await startHost("destination");
    const activation = {
      sourceServerId,
      getSource: () => {
        throw new Error("Source must not be accessed after destination accepted release");
      },
      destination: destination.client,
      transferId,
    };
    const active = await activateWorkspaceHandoff(activation);
    expect(active.state).toBe("active");
    expect(active.workspaceId).toBe(staged.workspaceId);
    expect(await readFile(path.join(active.destinationCwd, "work.txt"), "utf8")).toBe(
      "Pending work",
    );
    expect(await activateWorkspaceHandoff(activation)).toEqual(active);
    await expect(
      activateWorkspaceHandoff({ ...activation, sourceServerId: "another-source" }),
    ).rejects.toThrow("Destination reservation belongs to another source host");
    expect((await destination.client.fetchWorkspaces()).entries.map((entry) => entry.id)).toEqual([
      active.workspaceId,
    ]);
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "activates an explicit context export without installing a native session",
  async () => {
    const source = await startHost("source", true);
    let destination = await startHost("destination", true);
    const origin = source.daemon.daemon;
    const cwd = path.join(root, "workspace");
    await mkdir(cwd);
    const created = await source.client.createWorkspace({
      source: { kind: "directory", path: cwd },
    });
    if (!created.workspace) throw new Error("Missing source workspace");
    const sourceAgentId = randomUUID();
    const sessionId = randomUUID();
    const project = claudeProjectDirSync(cwd, { configDir: path.join(root, "source", "claude") });
    await mkdir(project, { recursive: true });
    const transcript =
      ["First source note", "Remember the export token: previous-only-token", "Last source note"]
        .map((content) =>
          JSON.stringify({
            type: "user",
            uuid: randomUUID(),
            sessionId,
            message: { role: "user", content },
          }),
        )
        .join("\n") + "\n";
    await writeFile(path.join(project, `${sessionId}.jsonl`), transcript);
    const timestamp = new Date().toISOString();
    await origin.agentStorage.upsert(
      parseStoredAgentRecord({
        id: sourceAgentId,
        provider: "claude",
        cwd,
        workspaceId: created.workspace.id,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastStatus: "closed",
        persistence: {
          provider: "claude",
          sessionId,
          metadata: {
            claudeRuntime: {
              configDir: path.join(root, "source", "claude"),
              cliVersion: "2.1.295",
            },
          },
        },
      }),
    );
    const preview = await source.client.handoffPreviewSource({ workspaceId: created.workspace.id });
    expect(preview.error).toBeNull();
    if (!preview.result) throw new Error("Missing source preview");
    expect(preview.result.conversations).toEqual([
      {
        agentId: sourceAgentId,
        title: null,
        provider: "claude",
        state: "available",
        cliVersion: "2.1.295",
        hasWorkflows: false,
        artifactBytes: Buffer.byteLength(transcript),
      },
    ]);
    const compatibility = await destination.client.handoffPreviewDestination({
      conversations: preview.result.conversations,
    });
    expect(compatibility.error).toBeNull();
    expect(compatibility.result?.conversations).toEqual([
      {
        agentId: sourceAgentId,
        title: null,
        provider: "claude",
        native: { available: true, reason: null },
        context: { available: true, reason: null },
      },
    ]);
    await rm(path.join(project, `${sessionId}.jsonl`));
    const missingHistory = await source.client.handoffPreviewSource({
      workspaceId: created.workspace.id,
    });
    expect(missingHistory.result?.conversations).toEqual([
      {
        agentId: sourceAgentId,
        title: null,
        provider: "claude",
        state: "blocked",
        reason: "Saved Claude session files are missing on the source host",
      },
    ]);
    if (!missingHistory.result) throw new Error("Missing source failure preview");
    const blocked = await destination.client.handoffPreviewDestination({
      conversations: missingHistory.result.conversations,
    });
    expect(blocked.result?.conversations[0]).toMatchObject({
      native: {
        available: false,
        reason: "Saved Claude session files are missing on the source host",
      },
      context: {
        available: false,
        reason: "Saved Claude session files are missing on the source host",
      },
    });
    await writeFile(path.join(project, `${sessionId}.jsonl`), transcript);
    await writeFile(
      path.join(root, "destination", "claude-version.cjs"),
      "console.log('2.1.296');\n",
    );
    const mismatched = await destination.client.handoffPreviewDestination({
      conversations: preview.result.conversations,
    });
    expect(mismatched.result?.conversations[0]).toMatchObject({
      native: {
        available: false,
        reason: "Native Claude handoff requires matching Claude Code versions, at least 2.1.295",
      },
      context: { available: true, reason: null },
    });
    await writeFile(
      path.join(root, "destination", "claude-version.cjs"),
      "console.log('2.1.295');\n",
    );
    const workflows = path.join(project, sessionId, "workflows");
    await mkdir(workflows, { recursive: true });
    await writeFile(path.join(workflows, "state.json"), JSON.stringify({ type: "state" }));
    const withWorkflow = await source.client.handoffPreviewSource({
      workspaceId: created.workspace.id,
    });
    expect(withWorkflow.result?.conversations[0]).toMatchObject({ hasWorkflows: true });
    if (!withWorkflow.result) throw new Error("Missing workflow preview");
    const workflowCompatibility = await destination.client.handoffPreviewDestination({
      conversations: withWorkflow.result.conversations,
    });
    expect(workflowCompatibility.result?.conversations[0]).toMatchObject({
      native: {
        available: false,
        reason: "Claude workflow state needs an explicit disposition before native continuation",
      },
      context: { available: true, reason: null },
    });
    expect(await origin.handoffOwnership.withMutation({ cwd }, async () => "still writable")).toBe(
      "still writable",
    );
    expect((await destination.client.fetchWorkspaces()).entries).toEqual([]);
    const transferId = randomUUID();
    await expect(
      prepareWorkspaceHandoff({
        source: source.client,
        destination: destination.client,
        transferId,
        workspaceId: created.workspace.id,
        destinationParent: root,
        continuationMode: "context",
        expectedAgentIds: [],
      }),
    ).rejects.toThrow("Source conversations changed after review");
    expect((await destination.client.handoffGetDestinationStatus({ transferId })).error?.code).toBe(
      "not_found",
    );
    const request = {
      transferId,
      sourceServerId: origin.getServerId(),
      sourceWorkspaceId: created.workspace.id,
      sourceAgentIds: [sourceAgentId],
      destinationParent: root,
      continuationMode: "context" as const,
    };
    const reserved = await destination.daemon.daemon.handoffDestination.reserve(request);
    expect(reserved.continuationMode).toBe("context");
    await expect(
      destination.daemon.daemon.handoffDestination.reserve({
        ...request,
        continuationMode: "native",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const prepared = await origin.handoffSource.prepare({
      transferId,
      workspaceId: created.workspace.id,
      agentIds: [sourceAgentId],
      destinationServerId: destination.daemon.daemon.getServerId(),
      reservationId: reserved.reservationId,
    });
    await destination.daemon.daemon.handoffDestination.bindSource({
      transferId,
      manifest: prepared.manifest,
      publicKey: prepared.source.publicKey,
    });
    await transferHandoffArchive({
      source: source.client,
      destination: destination.client,
      transferId,
      manifest: prepared.manifest,
    });
    // Context mode must not inspect or launch the destination native importer.
    await writeFile(
      path.join(root, "destination", "claude-version.cjs"),
      "throw new Error('Native importer must not be used');\n",
    );
    const staged = await destination.daemon.daemon.handoffDestination.stage(transferId);
    expect(
      (
        await destination.client.handoffGetConversationHistory({
          agentId: staged.agentMappings[0].destinationAgentId,
        })
      ).error?.code,
    ).toBe("not_found");
    expect(staged.claudeRuntime).toBeNull();
    expect(staged.preparedConversations).toEqual([{ sourceAgentId, title: null, mode: "context" }]);
    expect((await destination.client.fetchAgents()).entries).toEqual([]);
    const receipt = await origin.handoffSource.release(transferId);
    const stagedContext = path.join(
      staged.stagingCwd,
      `handoff-context-${staged.reservationId}`,
      staged.agentMappings[0].destinationAgentId,
      "timeline.json",
    );
    await writeFile(stagedContext, "modified context");
    await expect(
      destination.daemon.daemon.handoffDestination.acceptRelease(transferId, receipt),
    ).rejects.toMatchObject({ code: "source_changed" });
    expect(destination.daemon.daemon.handoffDestination.status(transferId).state).toBe("staged");
    await destination.daemon.daemon.handoffDestination.stage(transferId);
    expect(await readFile(stagedContext, "utf8")).toContain("previous-only-token");
    await destination.daemon.daemon.handoffDestination.acceptRelease(transferId, receipt);
    await stopHost(destination);
    destination = await startHost("destination", true);
    const active = await destination.daemon.daemon.handoffDestination.activate(transferId);
    const agentId = active.agentMappings[0].destinationAgentId;
    const record = await destination.daemon.daemon.agentStorage.get(agentId);
    expect(record?.persistence).toBeNull();
    expect(record?.handoffContext).toMatchObject({
      sourceAgentId,
      sourceCwd: await realpath(cwd),
      pending: true,
    });
    expect(record?.labels["paseo.handoff-mode"]).toBe("context");
    if (!record?.handoffContext) throw new Error("Missing continuation context");
    const contextDirectory = path.join(active.destinationCwd, record.handoffContext.directory);
    expect(await readFile(path.join(contextDirectory, "native", "transcript.jsonl"), "utf8")).toBe(
      transcript,
    );
    expect(await readFile(path.join(contextDirectory, "timeline.json"), "utf8")).toContain(
      "previous-only-token",
    );
    await expect(
      readdir(path.join(root, "destination", "claude", "projects")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await stopHost(destination);
    destination = await startHost("destination", true);
    expect(await destination.daemon.daemon.agentStorage.get(agentId)).toEqual(record);
    expect(await destination.daemon.daemon.handoffDestination.activate(transferId)).toEqual(active);
    await rm(contextDirectory, { recursive: true });
    await stopHost(source);
    await expectExportedHistory(destination.client, agentId, sourceAgentId, cwd);
    expect((await destination.daemon.daemon.agentStorage.get(agentId))?.persistence).toBeNull();
  },
  30_000,
);

test.skipIf(process.platform === "win32").each([
  {
    kind: "directory",
    hasGit: false,
    legacy: false,
    subdirEntries: [],
    prepare: async (_cwd: string) => {},
  },
  {
    kind: "legacy directory",
    hasGit: false,
    legacy: true,
    subdirEntries: [],
    prepare: async (_cwd: string) => {},
  },
  {
    kind: "git",
    legacy: false,
    hasGit: true,
    subdirEntries: [".keep"],
    prepare: async (cwd: string) => {
      await writeFile(path.join(cwd, "subdir", ".keep"), "");
      await exec("git", ["init", "--initial-branch=main"], { cwd });
      await exec("git", ["add", "work.txt", "subdir"], { cwd });
      await exec(
        "git",
        [
          "-c",
          "user.name=Handoff Test",
          "-c",
          "user.email=handoff@example.test",
          "commit",
          "-m",
          "Initial work",
        ],
        { cwd },
      );
    },
  },
])(
  "transfers native conversation artifacts and activates a $kind workspace across real daemon restarts",
  async ({ prepare, hasGit, legacy, subdirEntries }) => {
    let source = await startHost("source", true);
    let destination = await startHost("destination", true);
    let sourceDaemon = source.daemon.daemon;
    const transferId = randomUUID();
    const cwd = path.join(root, "workspace");
    await mkdir(cwd);
    await mkdir(path.join(cwd, "subdir"));
    await writeFile(path.join(cwd, "work.txt"), "work in progress\n");
    await prepare(cwd);
    const created = await source.client.createWorkspace({
      source: { kind: "directory", path: cwd },
    });
    if (!created.workspace) throw new Error(created.error?.message ?? "Workspace creation failed");
    const request = {
      transferId,
      sourceServerId: sourceDaemon.getServerId(),
      sourceWorkspaceId: created.workspace.id,
      sourceAgentIds: ["00000000-0000-4000-8000-000000000301"],
      destinationParent: root,
    };
    const reserved = await destination.daemon.daemon.handoffDestination.reserve(request);
    const sourceConfigDir = path.join(root, "source", "claude");
    const sessionId = randomUUID();
    const project = claudeProjectDirSync(cwd, { configDir: sourceConfigDir });
    await mkdir(project, { recursive: true });
    const transcript =
      JSON.stringify({
        type: "user",
        sessionId,
        message: { role: "user", content: "Complete the work from our prior conversation" },
      }) +
      "\n" +
      JSON.stringify({
        type: "assistant",
        sessionId,
        message: { role: "assistant", content: [{ type: "text", text: "Ready to continue" }] },
      }) +
      "\n";
    await writeFile(path.join(project, `${sessionId}.jsonl`), transcript);
    const timestamp = new Date().toISOString();
    await sourceDaemon.agentStorage.upsert(
      parseStoredAgentRecord({
        id: "00000000-0000-4000-8000-000000000301",
        provider: "claude",
        cwd,
        workspaceId: request.sourceWorkspaceId,
        createdAt: timestamp,
        updatedAt: timestamp,
        title: "Conversation to continue",
        lastStatus: "closed",
        persistence: {
          provider: "claude",
          sessionId,
          metadata: {
            cwd,
            claudeRuntime: {
              configDir: path.join(root, "source", "claude"),
              cliVersion: "2.1.295",
            },
          },
        },
      }),
    );
    const sourceRequest = {
      transferId,
      workspaceId: request.sourceWorkspaceId,
      agentIds: request.sourceAgentIds,
      destinationServerId: destination.daemon.daemon.getServerId(),
      reservationId: reserved.reservationId,
    };
    const prepared = await sourceDaemon.handoffSource.prepare(sourceRequest);
    const manifest = prepared.manifest;
    expect(prepared.source.state).toBe("ready");
    if (legacy) {
      // A transfer already captured by an older daemon used one host runtime in its local journal.
      await writeFile(
        path.join(source.daemon.paseoHome, "handoff", "source", transferId, "source.json"),
        JSON.stringify({
          version: 1,
          transferId,
          cwd: await realpath(cwd),
          manifest,
          agents: [
            { id: request.sourceAgentIds[0], cwd, title: "Conversation to continue", sessionId },
          ],
          runtime: { configDir: path.join(root, "source", "claude"), cliVersion: "2.1.295" },
        }),
      );
      const record = await sourceDaemon.agentStorage.get(request.sourceAgentIds[0]);
      if (!record?.persistence) throw new Error("Missing legacy record");
      await sourceDaemon.agentStorage.upsert({
        ...record,
        persistence: { ...record.persistence, metadata: { cwd } },
      });
    }
    await stopHost(source);
    if (legacy) {
      const agentsDirectory = path.join(source.daemon.paseoHome, "agents");
      const relative = (await readdir(agentsDirectory, { recursive: true })).find((file) =>
        file.endsWith(`${request.sourceAgentIds[0]}.json`),
      );
      if (!relative) throw new Error("Missing legacy agent file");
      const recordPath = path.join(agentsDirectory, relative);
      const legacyRecord = JSON.parse(await readFile(recordPath, "utf8"));
      delete legacyRecord.promptAnnotations;
      delete legacyRecord.revision;
      await writeFile(recordPath, JSON.stringify(legacyRecord));
    }
    source = await startHost("source", true);
    sourceDaemon = source.daemon.daemon;
    expect(await sourceDaemon.handoffSource.status(transferId)).toEqual(prepared);
    if (!legacy) expect(await sourceDaemon.handoffSource.prepare(sourceRequest)).toEqual(prepared);
    const binding = { transferId, publicKey: prepared.source.publicKey, manifest };
    const receiving = await destination.daemon.daemon.handoffDestination.bindSource(binding);
    await stopHost(destination);
    destination = await startHost("destination", true);
    expect(await destination.daemon.daemon.handoffDestination.reserve(request)).toEqual(receiving);
    await transferHandoffArchive({
      source: source.client,
      destination: destination.client,
      transferId,
      manifest,
    });
    const staged = await destination.daemon.daemon.handoffDestination.stage(transferId);
    const importedPath = path.join(
      root,
      "destination",
      "claude",
      "projects",
      `paseo-handoff-${reserved.agentMappings[0].destinationAgentId}`,
      `${sessionId}.jsonl`,
    );
    expect(await readFile(importedPath, "utf8")).toBe(transcript);
    expect(staged.preparedConversations).toEqual([
      {
        sourceAgentId: "00000000-0000-4000-8000-000000000301",
        title: "Conversation to continue",
        mode: "native",
        sessionId,
        runtime: { configDir: path.join(root, "destination", "claude"), cliVersion: "2.1.295" },
      },
    ]);
    expect(await readFile(path.join(staged.stagingCwd, "work.txt"), "utf8")).toBe(
      "work in progress\n",
    );
    expect(await readdir(path.join(staged.stagingCwd, "subdir"))).toEqual(subdirEntries);
    expect((await readdir(staged.stagingCwd)).includes(".git")).toBe(hasGit);
    await writeFile(path.join(cwd, "work.txt"), "changed after preparation\n");
    await expect(sourceDaemon.handoffSource.release(transferId)).rejects.toMatchObject({
      code: "source_changed",
    });
    await writeFile(path.join(cwd, "work.txt"), "work in progress\n");
    const sourceTranscript = path.join(project, `${sessionId}.jsonl`);
    await writeFile(
      sourceTranscript,
      transcript +
        JSON.stringify({
          type: "user",
          sessionId,
          message: { role: "user", content: "New source turn" },
        }) +
        "\n",
    );
    await expect(sourceDaemon.handoffSource.release(transferId)).rejects.toMatchObject({
      code: "source_changed",
    });
    expect(sourceDaemon.handoffOwnership.status(transferId).state).toBe("ready");
    await expect(
      sourceDaemon.handoffOwnership.withMutation({ cwd }, async () => {}),
    ).rejects.toMatchObject({ code: "fenced" });
    await writeFile(sourceTranscript, transcript);
    const receipt = await sourceDaemon.handoffSource.release(transferId);
    expect(await sourceDaemon.handoffSource.release(transferId)).toEqual(receipt);
    await rm(sourceTranscript);
    const sourceHistory = await source.client.fetchAgentTimeline(
      "00000000-0000-4000-8000-000000000301",
    );
    expect(JSON.stringify(sourceHistory.entries)).toContain(
      "Complete the work from our prior conversation",
    );
    expect(sourceDaemon.agentManager.getAgent("00000000-0000-4000-8000-000000000301")).toBeNull();
    await stopHost(source);
    source = await startHost("source", true);
    sourceDaemon = source.daemon.daemon;
    const restartedHistory = await source.client.fetchAgentTimeline(
      "00000000-0000-4000-8000-000000000301",
    );
    expect(restartedHistory.entries).toEqual(sourceHistory.entries);
    expect(restartedHistory.epoch).toBe(sourceHistory.epoch);
    expect(sourceDaemon.agentManager.getAgent("00000000-0000-4000-8000-000000000301")).toBeNull();
    const lastPage = await source.client.fetchAgentTimeline(request.sourceAgentIds[0], {
      limit: 1,
    });
    expect(lastPage.entries.map((entry) => entry.item.type)).toEqual(["assistant_message"]);
    if (!lastPage.startCursor) throw new Error("Missing history cursor");
    const priorPage = await source.client.fetchAgentTimeline(request.sourceAgentIds[0], {
      direction: "before",
      cursor: lastPage.startCursor,
      limit: 1,
    });
    expect(priorPage.entries.map((entry) => entry.item.type)).toEqual(["user_message"]);
    const historyFile = await sourceDaemon.handoffArchives.withVerifiedArchive(
      transferId,
      async (archive) => {
        const { bundle } = await readHandoffBundle(archive, {
          sourceServerId: request.sourceServerId,
          sourceWorkspaceId: request.sourceWorkspaceId,
          sourceAgentIds: request.sourceAgentIds,
          manifestDigest: manifest.entrypoint.sha256,
        });
        const history = bundle.conversations[0].history;
        if (!history) throw new Error("Missing readable conversation snapshot");
        return path.join(archive.blobsDirectory, history.sha256);
      },
    );
    const historyBytes = await readFile(historyFile);
    await writeFile(historyFile, "damaged history");
    await expect(source.client.fetchAgentTimeline(request.sourceAgentIds[0])).rejects.toThrow();
    expect(sourceDaemon.agentManager.getAgent(request.sourceAgentIds[0])).toBeNull();
    await writeFile(historyFile, historyBytes);
    expect((await source.client.fetchAgentTimeline(request.sourceAgentIds[0])).entries).toEqual(
      sourceHistory.entries,
    );
    const released = await destination.daemon.daemon.handoffDestination.acceptRelease(
      transferId,
      receipt,
    );
    await stopHost(destination);
    destination = await startHost("destination", true);
    expect(
      await destination.daemon.daemon.handoffDestination.acceptRelease(transferId, receipt),
    ).toEqual(released);
    await expect(
      destination.daemon.daemon.handoffDestination.cancel(transferId, null),
    ).rejects.toMatchObject({ code: "invalid_state" });
    await expect(
      sourceDaemon.handoffOwnership.withMutation({ cwd }, async () => {}),
    ).rejects.toMatchObject({ code: "fenced" });
    // Preparation must remain private until conversation installation and publication are complete.
    await expect(readdir(reserved.destinationCwd)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await destination.client.fetchAgents()).entries).toEqual([]);
    expect(await readFile(importedPath, "utf8")).toBe(transcript);
    const active = await destination.daemon.daemon.handoffDestination.activate(transferId);
    expect(active.state).toBe("active");
    expect(await destination.daemon.daemon.handoffDestination.activate(transferId)).toEqual(active);
    expect(await readFile(path.join(active.destinationCwd, "work.txt"), "utf8")).toBe(
      "work in progress\n",
    );
    expect((await readdir(active.destinationCwd)).includes(".git")).toBe(hasGit);
    const agentId = active.agentMappings[0].destinationAgentId;
    const record = await destination.daemon.daemon.agentStorage.get(agentId);
    expect(record).toMatchObject({
      id: agentId,
      workspaceId: active.workspaceId,
      cwd: active.destinationCwd,
      lastStatus: "closed",
      persistence: { sessionId },
    });
    expect((await destination.client.fetchAgents()).entries.map((entry) => entry.agent.id)).toEqual(
      [agentId],
    );
    await stopHost(destination);
    destination = await startHost("destination", true);
    expect((await destination.client.fetchAgents()).entries.map((entry) => entry.agent.id)).toEqual(
      [agentId],
    );
    expect(await destination.daemon.daemon.handoffDestination.activate(transferId)).toEqual(active);
    const returnPreview = await destination.client.handoffPreviewSource({
      workspaceId: active.workspaceId,
    });
    expect(returnPreview.result?.conversations).toEqual([
      {
        agentId,
        title: "Conversation to continue",
        provider: "claude",
        state: "available",
        cliVersion: "2.1.295",
        hasWorkflows: false,
        artifactBytes: Buffer.byteLength(transcript),
      },
    ]);
  },
  30_000,
);

test.each(["missing", "corrupt", "foreign"])(
  "refuses daemon startup with a %s destination journal",
  async (damage) => {
    const destination = await startHost("destination");
    const journal = path.join(
      destination.daemon.paseoHome,
      "handoff-destination",
      "destination.json",
    );
    await stopHost(destination);
    if (damage === "missing") await rm(journal);
    else if (damage === "corrupt") await writeFile(journal, "{");
    else
      await writeFile(
        journal,
        JSON.stringify({ version: 1, serverId: "another-host", records: [] }),
      );
    await expect(startHost("destination")).rejects.toThrow();
  },
);

async function transferCapturedWorkspace(cwd: string) {
  const artifactDirectory = path.join(root, "snapshot");
  const destinationPath = path.join(root, "restored");
  const transferId = randomUUID();
  const snapshot = await captureWorkspace({ cwd, artifactDirectory });
  const sourceStore = new HandoffArchiveStore(
    path.join(root, "source", ".paseo", "handoff", "archives"),
  );
  const manifest = await packWorkspaceArchive({
    artifactDirectory,
    store: sourceStore,
    transferId,
  });
  await rm(artifactDirectory, { recursive: true });
  // Boot from the durable server-side import; the client never seeds source bytes.
  const source = await startHost("source");
  const destination = await startHost("destination");
  const transferred = await transferHandoffArchive({
    source: source.client,
    destination: destination.client,
    transferId,
    manifest,
  });
  expect(transferred.state).toBe("verified");
  expect((await destination.client.fetchAgents()).entries).toEqual([]);
  await stopHost(destination);
  // A reconstructed store restores directly from received blobs after daemon shutdown.
  const destinationStore = new HandoffArchiveStore(
    path.join(destination.daemon.paseoHome, "handoff", "archives"),
  );
  expect(
    await restoreWorkspaceArchive({
      store: destinationStore,
      transferId,
      destination: destinationPath,
    }),
  ).toEqual(snapshot);
  return { destinationPath, manifest };
}

test("transfers a captured Git workspace through two daemons and restores its staged and working bytes", async () => {
  const cwd = path.join(root, "workspace");
  await mkdir(cwd);
  async function git(...args: string[]) {
    return (
      await exec("git", args, {
        cwd,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      })
    ).stdout;
  }
  await git("init", "--initial-branch=work");
  await git("config", "core.autocrlf", "false");
  await writeFile(path.join(cwd, "tracked"), "committed\n");
  await writeFile(path.join(cwd, ".gitignore"), ".env\n");
  await git("add", ".");
  await git(
    "-c",
    "user.name=Handoff Test",
    "-c",
    "user.email=handoff@example.com",
    "commit",
    "-m",
    "local history",
  );
  await writeFile(path.join(cwd, "tracked"), "staged\n");
  await git("add", "tracked");
  await writeFile(path.join(cwd, "tracked"), "working\n");
  await writeFile(path.join(cwd, ".env"), "SOURCE_ONLY=1\n");
  const binary = Buffer.alloc(HANDOFF_CHUNK_BYTES + 17, 173);
  await writeFile(path.join(cwd, "binary"), binary);
  await writeFile(path.join(cwd, "same-binary"), binary);
  const originalStatus = await git("status", "--porcelain=v1", "-z");
  const originalHead = await git("rev-parse", "HEAD");
  const { destinationPath, manifest } = await transferCapturedWorkspace(cwd);
  expect(new Set(manifest.blobs.map((blob) => blob.sha256)).size).toBe(manifest.blobs.length);
  expect(await readFile(path.join(destinationPath, "tracked"), "utf8")).toBe("working\n");
  expect((await exec("git", ["show", ":tracked"], { cwd: destinationPath })).stdout).toBe(
    "staged\n",
  );
  expect(await readFile(path.join(destinationPath, "binary"))).toEqual(binary);
  expect(await readFile(path.join(destinationPath, "same-binary"))).toEqual(binary);
  await expect(readFile(path.join(destinationPath, ".env"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(
    (await exec("git", ["status", "--porcelain=v1", "-z"], { cwd: destinationPath })).stdout,
  ).toBe(originalStatus);
  expect((await exec("git", ["rev-parse", "HEAD"], { cwd: destinationPath })).stdout).toBe(
    originalHead,
  );
  expect(await git("status", "--porcelain=v1", "-z")).toBe(originalStatus);
}, 30_000);

test("transfers an empty non-Git workspace with its manifest as the only archive blob", async () => {
  const cwd = path.join(root, "empty-workspace");
  await mkdir(cwd);
  const { destinationPath, manifest } = await transferCapturedWorkspace(cwd);
  expect(manifest.blobs).toEqual([manifest.entrypoint]);
  expect(await readdir(destinationPath)).toEqual([]);
}, 30_000);

test("streams bounded chunks between two real daemons and resumes after destination restart", async () => {
  const source = await startHost("source");
  let destination = await startHost("destination");
  const data = Buffer.alloc(HANDOFF_CHUNK_BYTES * 2 + 173);
  for (let index = 0; index < data.length; index++) data[index] = index % 251;
  const blob = { sha256: createHash("sha256").update(data).digest("hex"), size: data.length };
  const manifest = { version: 1 as const, entrypoint: blob, blobs: [blob] };
  const transferId = randomUUID();
  expect((await source.client.handoffArchiveBegin({ transferId, manifest })).error).toBeNull();
  for (let offset = 0; offset < data.length; offset += HANDOFF_CHUNK_BYTES) {
    const chunk = data.subarray(offset, offset + HANDOFF_CHUNK_BYTES);
    expect(
      (
        await source.client.handoffArchiveWriteChunk({
          transferId,
          sha256: blob.sha256,
          offset,
          data: chunk.toString("base64"),
        })
      ).result,
    ).toBe(offset + chunk.length);
  }
  expect((await source.client.handoffArchiveSeal({ transferId })).result?.state).toBe("verified");
  expect((await destination.client.handoffArchiveBegin({ transferId, manifest })).error).toBeNull();
  const first = await source.client.handoffArchiveReadChunk({
    transferId,
    sha256: blob.sha256,
    offset: 0,
    length: HANDOFF_CHUNK_BYTES,
  });
  if (first.result === null) throw new Error("Source returned no chunk");
  expect(
    (
      await destination.client.handoffArchiveWriteChunk({
        transferId,
        sha256: blob.sha256,
        offset: 0,
        data: first.result,
      })
    ).result,
  ).toBe(HANDOFF_CHUNK_BYTES);

  await stopHost(destination);
  destination = await startHost("destination");
  expect((await destination.client.handoffArchiveStatus({ transferId })).result).toEqual({
    id: transferId,
    state: "receiving",
    blobs: [{ ...blob, receivedBytes: HANDOFF_CHUNK_BYTES }],
  });
  // A client that lost the acknowledgement can replay it without duplicating bytes.
  expect(
    (
      await destination.client.handoffArchiveWriteChunk({
        transferId,
        sha256: blob.sha256,
        offset: 0,
        data: first.result,
      })
    ).result,
  ).toBe(HANDOFF_CHUNK_BYTES);
  const progress: HandoffTransferProgress[] = [];
  expect(
    await transferHandoffArchive({
      source: source.client,
      destination: destination.client,
      transferId,
      manifest,
      onProgress: (value) => progress.push(value),
    }),
  ).toEqual({
    id: transferId,
    state: "verified",
    blobs: [{ ...blob, receivedBytes: blob.size }],
  });
  expect(progress).toEqual([
    { phase: "transferring", receivedBytes: HANDOFF_CHUNK_BYTES, totalBytes: blob.size },
    { phase: "transferring", receivedBytes: HANDOFF_CHUNK_BYTES * 2, totalBytes: blob.size },
    { phase: "transferring", receivedBytes: blob.size, totalBytes: blob.size },
    { phase: "verifying", receivedBytes: blob.size, totalBytes: blob.size },
    { phase: "verified", receivedBytes: blob.size, totalBytes: blob.size },
  ]);
  expect(
    await readFile(
      path.join(
        destination.daemon.paseoHome,
        "handoff",
        "archives",
        transferId,
        "blobs",
        blob.sha256,
      ),
    ),
  ).toEqual(data);
  expect((await destination.client.fetchAgents()).entries).toEqual([]);
}, 30_000);

test("returns correlated integrity and encoding failures and repairs an unverified blob", async () => {
  const { client } = await startHost("receiver");
  const transferId = randomUUID();
  const data = Buffer.from("preserve every byte");
  const blob = { sha256: createHash("sha256").update(data).digest("hex"), size: data.length };
  await client.handoffArchiveBegin({
    transferId,
    manifest: { version: 1, entrypoint: blob, blobs: [blob] },
  });
  expect(
    await client.handoffArchiveWriteChunk({
      transferId,
      sha256: blob.sha256,
      offset: 0,
      data: "%%%",
      requestId: "bad-encoding",
    }),
  ).toEqual({
    requestId: "bad-encoding",
    transferId,
    result: null,
    error: {
      code: "invalid_chunk",
      message: "Chunk must use canonical base64 encoding",
      blob: null,
    },
  });
  await client.handoffArchiveWriteChunk({
    transferId,
    sha256: blob.sha256,
    offset: 0,
    data: Buffer.alloc(data.length).toString("base64"),
  });
  expect((await client.handoffArchiveSeal({ transferId })).error).toMatchObject({
    code: "integrity_mismatch",
    blob: blob.sha256,
  });
  expect(
    (
      await client.handoffArchiveReadChunk({
        transferId,
        sha256: blob.sha256,
        offset: 0,
        length: 10,
      })
    ).error,
  ).toMatchObject({ code: "invalid_state" });
  expect((await client.handoffArchiveResetBlob({ transferId, sha256: blob.sha256 })).result).toBe(
    true,
  );
  await client.handoffArchiveWriteChunk({
    transferId,
    sha256: blob.sha256,
    offset: 0,
    data: data.toString("base64"),
  });
  expect((await client.handoffArchiveSeal({ transferId })).result?.state).toBe("verified");
}, 30_000);

test("a socket lost after a committed write resumes from disk without duplicating the chunk", async () => {
  const source = await startHost("source");
  const destination = await startHost("destination");
  const transferId = randomUUID();
  const data = Buffer.alloc(HANDOFF_CHUNK_BYTES + 83, 137);
  const blob = { sha256: createHash("sha256").update(data).digest("hex"), size: data.length };
  const manifest = { version: 1 as const, entrypoint: blob, blobs: [blob] };
  await source.client.handoffArchiveBegin({ transferId, manifest });
  for (let offset = 0; offset < data.length; offset += HANDOFF_CHUNK_BYTES) {
    await source.client.handoffArchiveWriteChunk({
      transferId,
      sha256: blob.sha256,
      offset,
      data: data.subarray(offset, offset + HANDOFF_CHUNK_BYTES).toString("base64"),
    });
  }
  await source.client.handoffArchiveSeal({ transferId });
  let droppedReplies = 0;
  const interrupted = new TransportClient({
    clientId: "handoff-lost-reply",
    url: `ws://127.0.0.1:${destination.daemon.port}/ws`,
    reconnect: { enabled: false },
    transportFactory: ({ url, headers, protocols }) => {
      const socket = new WebSocket(url, protocols, { headers });
      return {
        send: (value) => socket.send(value),
        close: (code, reason) => socket.close(code, reason),
        onOpen: (handler) => {
          socket.on("open", handler);
          return () => {
            socket.off("open", handler);
          };
        },
        onClose: (handler) => {
          socket.on("close", handler);
          return () => {
            socket.off("close", handler);
          };
        },
        onError: (handler) => {
          socket.on("error", handler);
          return () => {
            socket.off("error", handler);
          };
        },
        onMessage: (handler) => {
          const receive = (bytes: RawData, binary: boolean) => {
            const message = binary
              ? null
              : WSOutboundMessageSchema.parse(JSON.parse(bytes.toString()));
            if (
              message?.type === "session" &&
              message.message.type === "workspace.handoff.write_archive_chunk.response"
            ) {
              droppedReplies++;
              socket.terminate();
              return;
            }
            handler(bytes, binary);
          };
          socket.on("message", receive);
          return () => {
            socket.off("message", receive);
          };
        },
      };
    },
  });
  try {
    await interrupted.connect();
    await expect(
      transferHandoffArchive({
        source: source.client,
        destination: interrupted,
        transferId,
        manifest,
      }),
    ).rejects.toMatchObject({ name: "DaemonConnectionError" });
    expect(droppedReplies).toBe(1);
    expect((await destination.client.handoffArchiveStatus({ transferId })).result?.blobs).toEqual([
      { ...blob, receivedBytes: HANDOFF_CHUNK_BYTES },
    ]);
    expect(
      (
        await transferHandoffArchive({
          source: source.client,
          destination: destination.client,
          transferId,
          manifest,
        })
      ).state,
    ).toBe("verified");
    expect(
      await readFile(
        path.join(
          destination.daemon.paseoHome,
          "handoff",
          "archives",
          transferId,
          "blobs",
          blob.sha256,
        ),
      ),
    ).toEqual(data);
  } finally {
    await interrupted.close();
  }
}, 30_000);

test("pausing between chunks keeps verified source data and resumes only missing bytes", async () => {
  const source = await startHost("source");
  const destination = await startHost("destination");
  const transferId = randomUUID();
  const data = Buffer.alloc(HANDOFF_CHUNK_BYTES + 57, 42);
  const blob = { sha256: createHash("sha256").update(data).digest("hex"), size: data.length };
  const manifest = { version: 1 as const, entrypoint: blob, blobs: [blob] };
  await source.client.handoffArchiveBegin({ transferId, manifest });
  for (let offset = 0; offset < data.length; offset += HANDOFF_CHUNK_BYTES) {
    await source.client.handoffArchiveWriteChunk({
      transferId,
      sha256: blob.sha256,
      offset,
      data: data.subarray(offset, offset + HANDOFF_CHUNK_BYTES).toString("base64"),
    });
  }
  await source.client.handoffArchiveSeal({ transferId });
  const pause = new AbortController();
  await expect(
    transferHandoffArchive({
      source: source.client,
      destination: destination.client,
      transferId,
      manifest,
      signal: pause.signal,
      onProgress: (progress) => {
        if (progress.receivedBytes === HANDOFF_CHUNK_BYTES)
          pause.abort(new Error("User paused the transfer"));
      },
    }),
  ).rejects.toThrow("User paused the transfer");
  expect((await destination.client.handoffArchiveStatus({ transferId })).result).toEqual({
    id: transferId,
    state: "receiving",
    blobs: [{ ...blob, receivedBytes: HANDOFF_CHUNK_BYTES }],
  });
  expect((await source.client.handoffArchiveStatus({ transferId })).result?.state).toBe("verified");
  expect(
    (
      await transferHandoffArchive({
        source: source.client,
        destination: destination.client,
        transferId,
        manifest,
      })
    ).state,
  ).toBe("verified");
}, 30_000);

async function contextRecord(host: Host, agentId: string) {
  const record = await host.daemon.daemon.agentStorage.get(agentId);
  if (!record?.workspaceId || !record.handoffContext)
    throw new Error("Missing context conversation");
  expect(record.persistence).toBeNull();
  expect(record.handoffContext.pending).toBe(true);
  return { ...record, workspaceId: record.workspaceId, handoffContext: record.handoffContext };
}

async function expectRecordRevisionReleaseCheck(source: Host, agentId: string, transferId: string) {
  const preparationPath = path.join(
    source.daemon.paseoHome,
    "handoff",
    "source",
    transferId,
    "source.json",
  );
  const preparationBytes = await readFile(preparationPath);
  const preparation = JSON.parse(preparationBytes.toString("utf8"));
  expect(preparation.version).toBe(3);
  delete preparation.agents[0].recordRevision;
  await writeFile(preparationPath, JSON.stringify(preparation));
  expect((await source.client.handoffReleaseSource({ transferId })).error?.message).toContain(
    "missing its record revision",
  );
  await writeFile(preparationPath, preparationBytes);
  const capturedRecord = await source.daemon.daemon.agentStorage.get(agentId);
  if (!capturedRecord) throw new Error("Missing captured conversation");
  await source.daemon.daemon.agentStorage.setTitle(agentId, "Metadata changed after capture");
  const changedRecord = await source.daemon.daemon.agentStorage.get(agentId);
  if (!changedRecord) throw new Error("Missing changed conversation");
  await source.daemon.daemon.agentStorage.upsert({ ...changedRecord, title: capturedRecord.title });
  const changedRevision = await source.client.handoffReleaseSource({ transferId });
  expect(changedRevision.error?.code).toBe("source_changed");
  expect(changedRevision.error?.message).toContain("record changed after capture");
}

async function expectContextReleaseChecks(
  host: Host,
  receiver: Host,
  agentId: string,
  originalTransferId: string,
  transferId: string,
) {
  const record = await contextRecord(host, agentId);
  await host.daemon.daemon.agentStorage.upsert({
    ...record,
    handoffContext: { ...record.handoffContext, pending: false },
  });
  expect((await host.client.handoffReleaseSource({ transferId })).error?.code).toBe(
    "source_changed",
  );
  const changed = await host.daemon.daemon.agentStorage.get(agentId);
  if (!changed) throw new Error("Missing changed context conversation");
  await expect(
    host.daemon.daemon.agentStorage.upsert({
      ...changed,
      handoffContext: record.handoffContext,
    }),
  ).rejects.toMatchObject({ code: "fenced" });
  await cancelWorkspaceHandoff({
    transferId,
    sourceServerId: host.daemon.daemon.getServerId(),
    getSource: () => host.client,
    destination: receiver.client,
  });
  await host.daemon.daemon.agentStorage.upsert({
    ...changed,
    handoffContext: record.handoffContext,
  });
  transferId = randomUUID();
  await prepareWorkspaceHandoff({
    transferId,
    workspaceId: record.workspaceId,
    destinationParent: root,
    continuationMode: "context",
    source: host.client,
    destination: receiver.client,
  });
  // An already-captured v2 context transfer predates record revisions.
  const preparationPath = path.join(
    host.daemon.paseoHome,
    "handoff",
    "source",
    transferId,
    "source.json",
  );
  const preparation = JSON.parse(await readFile(preparationPath, "utf8"));
  preparation.version = 2;
  for (const agent of preparation.agents) delete agent.recordRevision;
  await writeFile(preparationPath, JSON.stringify(preparation));
  const original = await host.daemon.daemon.handoffArchives.withVerifiedArchive(
    originalTransferId,
    async (archive) => {
      const file = path.join(archive.blobsDirectory, record.handoffContext.history.sha256);
      return { file, bytes: await readFile(file) };
    },
  );
  await writeFile(original.file, "damaged history");
  expect((await host.client.handoffReleaseSource({ transferId })).error?.code).toBe(
    "integrity_mismatch",
  );
  await writeFile(original.file, original.bytes);
  return transferId;
}

async function expectContextReturnPreview(source: Host, destination: Host, workspaceId: string) {
  const preview = await source.client.handoffPreviewSource({ workspaceId });
  expect(preview.error).toBeNull();
  expect(preview.result?.conversations[0]?.state).toBe("available");
  if (!preview.result) throw new Error("Missing context return preview");
  const compatibility = await destination.client.handoffPreviewDestination({
    conversations: preview.result.conversations,
  });
  expect(compatibility.result?.conversations[0]).toMatchObject({
    native: {
      available: false,
      reason: "This conversation contains exported context, not a local native session",
    },
    context: { available: true, reason: null },
  });
  const refusedId = randomUUID();
  await expect(
    prepareWorkspaceHandoff({
      transferId: refusedId,
      workspaceId,
      destinationParent: root,
      continuationMode: "native",
      source: source.client,
      destination: destination.client,
    }),
  ).rejects.toThrow("exported context, not a local native session");
  await cancelWorkspaceHandoff({
    transferId: refusedId,
    sourceServerId: source.daemon.daemon.getServerId(),
    getSource: () => source.client,
    destination: destination.client,
  });
}

async function expectContextHandoffReturn(input: {
  source: Host;
  destination: Host;
  agentId: string;
  originalAgentId: string;
  originalCwd: string;
  originalTranscript: string;
  originalTransferId: string;
  sessionId: string;
  notes: NonNullable<StoredAgentRecord["pendingRestartNote"]>;
}) {
  let { source, destination } = input;
  const record = await contextRecord(destination, input.agentId);
  await writeFile(path.join(record.cwd, ".gitignore"), "handoff-context-*/\n");
  await rm(path.join(record.cwd, record.handoffContext.directory), { recursive: true });
  await rm(input.originalTranscript);
  await expectContextReturnPreview(destination, source, record.workspaceId);
  let returnTransferId = randomUUID();
  await prepareWorkspaceHandoff({
    transferId: returnTransferId,
    workspaceId: record.workspaceId,
    destinationParent: root,
    continuationMode: "context",
    source: destination.client,
    destination: source.client,
  });
  returnTransferId = await expectContextReleaseChecks(
    destination,
    source,
    input.agentId,
    input.originalTransferId,
    returnTransferId,
  );
  await stopHost(source);
  await stopHost(destination);
  source = await startHost("source-notes", true);
  destination = await startHost("destination-notes", true);
  const returned = await activateWorkspaceHandoff({
    transferId: returnTransferId,
    sourceServerId: destination.daemon.daemon.getServerId(),
    getSource: () => destination.client,
    destination: source.client,
  });
  expect(returned.state).toBe("active");
  const returnedAgent = await contextRecord(source, returned.agentMappings[0].destinationAgentId);
  expect(returnedAgent.pendingRestartNote).toEqual(input.notes);
  expect(returnedAgent.carriedPrompt).toBeUndefined();
  expect(returnedAgent.handoffContext).toMatchObject({
    sourceAgentId: input.originalAgentId,
    sourceCwd: input.originalCwd,
  });
  const history = await source.client.handoffGetConversationHistory({ agentId: returnedAgent.id });
  expect(history.error).toBeNull();
  expect(history.result?.sourceAgentId).toBe(input.originalAgentId);
  expect(JSON.stringify(history.result?.timeline.entries)).toContain("Earlier work");
  const prompt = await prependHandoffContext({
    cwd: returnedAgent.cwd,
    context: returnedAgent.handoffContext,
    prompt: "Continue here",
  });
  expect(prompt).toContain("Earlier work");
  expect(prompt).toContain("Continue here");
  expect(
    await readFile(
      path.join(
        returnedAgent.cwd,
        returnedAgent.handoffContext.directory,
        "native",
        "transcript.jsonl",
      ),
      "utf8",
    ),
  ).toContain("Earlier work");
  const nextId = randomUUID();
  await prepareWorkspaceHandoff({
    transferId: nextId,
    workspaceId: returnedAgent.workspaceId,
    destinationParent: root,
    continuationMode: "context",
    source: source.client,
    destination: destination.client,
  });
  const next = await activateWorkspaceHandoff({
    transferId: nextId,
    sourceServerId: source.daemon.daemon.getServerId(),
    getSource: () => source.client,
    destination: destination.client,
  });
  const nextAgent = await contextRecord(destination, next.agentMappings[0].destinationAgentId);
  expect(nextAgent.handoffContext).toMatchObject({
    sourceServerId: returnedAgent.handoffContext.sourceServerId,
    sourceAgentId: input.originalAgentId,
    sourceCwd: input.originalCwd,
    history: returnedAgent.handoffContext.history,
  });
  expect(nextAgent.pendingRestartNote).toEqual(input.notes);
  const nextHistory = await destination.client.handoffGetConversationHistory({
    agentId: nextAgent.id,
  });
  expect(nextHistory.result?.timeline.entries).toEqual(history.result?.timeline.entries);
  const retiredHistory = await source.client.fetchAgentTimeline(returnedAgent.id);
  expect(retiredHistory.entries.map((entry) => entry.item)).toEqual(
    history.result?.timeline.entries.map((entry) => entry.item),
  );
  expect(source.daemon.daemon.agentManager.getAgent(returnedAgent.id)).toBeNull();
  await expectContinuedContextHandoff(destination, source, nextAgent.id);
}

async function expectContinuedContextHandoff(source: Host, destination: Host, agentId: string) {
  const record = await contextRecord(source, agentId);
  const sessionId = randomUUID();
  const configDir = path.join(root, "destination-notes", "claude");
  const project = claudeProjectDirSync(record.cwd, { configDir });
  await mkdir(project, { recursive: true });
  await writeFile(
    path.join(project, `${sessionId}.jsonl`),
    JSON.stringify({
      type: "user",
      uuid: randomUUID(),
      sessionId,
      message: { role: "user", content: "New local work after the context export" },
    }) + "\n",
  );
  await source.daemon.daemon.agentStorage.upsert({
    ...record,
    persistence: {
      provider: "claude",
      sessionId,
      metadata: { claudeRuntime: { configDir, cliVersion: "2.1.295" } },
    },
    handoffContext: { ...record.handoffContext, pending: false },
  });
  const preview = await source.client.handoffPreviewSource({ workspaceId: record.workspaceId });
  expect(preview.result?.conversations[0]?.state).toBe("available");
  const transferId = randomUUID();
  await prepareWorkspaceHandoff({
    transferId,
    workspaceId: record.workspaceId,
    destinationParent: root,
    continuationMode: "native",
    source: source.client,
    destination: destination.client,
  });
  const active = await activateWorkspaceHandoff({
    transferId,
    sourceServerId: source.daemon.daemon.getServerId(),
    getSource: () => source.client,
    destination: destination.client,
  });
  const installedId = active.agentMappings[0].destinationAgentId;
  const installed = await destination.daemon.daemon.agentStorage.get(installedId);
  expect(installed?.persistence?.sessionId).toBe(sessionId);
  const history = await destination.client.handoffGetConversationHistory({ agentId: installedId });
  if (!history.result) throw new Error("Missing continued history");
  expect(history.result.segments).toHaveLength(2);
  expect(JSON.stringify(history.result.timeline.entries)).toContain("New local work");
  const previousId = history.result.segments?.[0].id;
  if (!previousId) throw new Error("Missing previous history segment");
  const previous = await destination.client.handoffGetConversationHistory({
    agentId: installedId,
    segmentId: previousId,
  });
  expect(previous.result?.sourceAgentId).toBe(record.handoffContext.sourceAgentId);
  expect(JSON.stringify(previous.result?.timeline.entries)).toContain("Earlier work");
  expect(previous.result?.sourceServerId).toBe(record.handoffContext.sourceServerId);
  const foreign = await destination.client.handoffGetConversationHistory({
    agentId: installedId,
    segmentId: "0".repeat(64),
  });
  expect(foreign.result).toBeNull();
  expect(foreign.error).not.toBeNull();
  if (!installed?.handoffContext || !installed.workspaceId)
    throw new Error("Missing native history context");
  const contextual = {
    ...installed,
    handoffContext: installed.handoffContext,
    workspaceId: installed.workspaceId,
  };
  expect(contextual.handoffContext.continuationMode).toBe("native");
  const prompt = await prependHandoffContext({
    cwd: contextual.cwd,
    context: contextual.handoffContext,
    prompt: "Continue the task",
  });
  expect(prompt).toContain("native continuation");
  expect(prompt).toContain("Earlier work");
  expect(prompt).toContain("New local work");
  const contextDirectory = path.join(contextual.cwd, contextual.handoffContext.directory);
  const indexPath = path.join(contextDirectory, "index.json");
  const indexBytes = await readFile(indexPath);
  await writeFile(indexPath, Buffer.alloc(indexBytes.length));
  await expect(
    prependHandoffContext({
      cwd: contextual.cwd,
      context: contextual.handoffContext,
      prompt: "Go",
    }),
  ).rejects.toThrow("history index changed");
  await writeFile(indexPath, indexBytes);

  // Same native session: preserve the earlier segment without duplicating the current one.
  const returnId = randomUUID();
  await prepareWorkspaceHandoff({
    transferId: returnId,
    workspaceId: contextual.workspaceId,
    destinationParent: root,
    continuationMode: "native",
    source: destination.client,
    destination: source.client,
  });
  const returned = await activateWorkspaceHandoff({
    transferId: returnId,
    sourceServerId: destination.daemon.daemon.getServerId(),
    getSource: () => destination.client,
    destination: source.client,
  });
  const returnedId = returned.agentMappings[0].destinationAgentId;
  const returnedHistory = await source.client.handoffGetConversationHistory({
    agentId: returnedId,
  });
  expect(returnedHistory.result?.segments).toHaveLength(2);
  expect(returnedHistory.result?.segments?.[0].id).toBe(previousId);
  expect((await source.daemon.daemon.agentStorage.get(returnedId))?.persistence?.sessionId).toBe(
    sessionId,
  );
  await expectSegmentedContextReturns(source, destination, returned.workspaceId, previousId);
}

async function expectSegmentedContextReturns(
  source: Host,
  destination: Host,
  workspaceId: string,
  previousId: string,
) {
  let current = { host: source, workspaceId };
  for (const target of [destination, source]) {
    const nextId = randomUUID();
    await prepareWorkspaceHandoff({
      transferId: nextId,
      workspaceId: current.workspaceId,
      destinationParent: root,
      continuationMode: "context",
      source: current.host.client,
      destination: target.client,
    });
    const next = await activateWorkspaceHandoff({
      transferId: nextId,
      sourceServerId: current.host.daemon.daemon.getServerId(),
      getSource: () => current.host.client,
      destination: target.client,
    });
    const nextAgentId = next.agentMappings[0].destinationAgentId;
    const nextContext = await contextRecord(target, nextAgentId);
    const nextHistory = await target.client.handoffGetConversationHistory({ agentId: nextAgentId });
    expect(nextHistory.result?.segments).toHaveLength(2);
    expect(nextHistory.result?.segments?.[0].id).toBe(previousId);
    const nextPrompt = await prependHandoffContext({
      cwd: nextContext.cwd,
      context: nextContext.handoffContext,
      prompt: "Keep going",
    });
    expect(nextPrompt).toContain("NEW provider session");
    expect(nextPrompt).toContain("Earlier work");
    expect(nextPrompt).toContain("New local work");
    current = { host: target, workspaceId: next.workspaceId };
  }
}

for (const continuationMode of ["native", "context"] as const) {
  test.skipIf(process.platform === "win32")(
    `preserves unsent restart notes through ${continuationMode} activation and restart`,
    async () => {
      let source = await startHost("source-notes", true);
      let destination = await startHost("destination-notes", true);
      const cwd = path.join(root, "notes-workspace");
      await mkdir(cwd);
      const created = await source.client.createWorkspace({
        source: { kind: "directory", path: cwd },
      });
      if (!created.workspace) throw new Error("Missing source workspace");
      const workspaceId = created.workspace.id;
      const agentId = randomUUID();
      const sessionId = randomUUID();
      const configDir = path.join(root, "source-notes", "claude");
      const project = claudeProjectDirSync(cwd, { configDir });
      await mkdir(project, { recursive: true });
      await writeFile(
        path.join(project, `${sessionId}.jsonl`),
        JSON.stringify({
          type: "user",
          uuid: randomUUID(),
          sessionId,
          message: { role: "user", content: "Earlier work" },
        }) + "\n",
      );
      const timestamp = new Date().toISOString();
      await source.daemon.daemon.agentStorage.upsert(
        parseStoredAgentRecord({
          id: agentId,
          provider: "claude",
          cwd,
          workspaceId,
          createdAt: timestamp,
          updatedAt: timestamp,
          lastStatus: "closed",
          persistence: {
            provider: "claude",
            sessionId,
            metadata: { claudeRuntime: { configDir, cliVersion: "2.1.295" } },
          },
        }),
      );
      const notes = [
        { id: "first-task", kind: "shell", label: "Interrupted build — revisar salida" },
      ];
      await source.daemon.daemon.agentStorage.addPendingRestartNote(agentId, notes);
      let transferId = randomUUID();
      const request = {
        workspaceId,
        destinationParent: root,
        continuationMode,
        source: source.client,
        destination: destination.client,
      };
      const staged = await prepareWorkspaceHandoff({ ...request, transferId });
      expect(staged.state).toBe("staged");
      await source.daemon.daemon.handoffArchives.withVerifiedArchive(
        transferId,
        async (archive) => {
          const { bundle, schedules } = await readHandoffBundle(archive, {
            sourceServerId: source.daemon.daemon.getServerId(),
            sourceWorkspaceId: workspaceId,
            sourceAgentIds: [agentId],
            manifestDigest: archive.manifest.entrypoint.sha256,
          });
          expect(bundle.version).toBe(5);
          expect(schedules).toEqual({ version: 1, schedules: [] });
          expect(bundle.conversations[0].pendingRestartNote).toEqual(notes);
        },
      );
      await expectRecordRevisionReleaseCheck(source, agentId, transferId);
      await cancelWorkspaceHandoff({
        transferId,
        sourceServerId: source.daemon.daemon.getServerId(),
        getSource: () => source.client,
        destination: destination.client,
      });
      transferId = randomUUID();
      await prepareWorkspaceHandoff({ ...request, transferId });
      const late = { id: "later-task", kind: "delegation", label: "Later interrupted review" };
      await source.daemon.daemon.agentStorage.addPendingRestartNote(agentId, [late]);
      const rejected = await source.client.handoffReleaseSource({ transferId });
      expect(rejected.error?.code).toBe("source_changed");
      await cancelWorkspaceHandoff({
        transferId,
        sourceServerId: source.daemon.daemon.getServerId(),
        getSource: () => source.client,
        destination: destination.client,
      });
      transferId = randomUUID();
      const refreshed = await prepareWorkspaceHandoff({ ...request, transferId });
      await stopHost(source);
      await stopHost(destination);
      source = await startHost("source-notes", true);
      destination = await startHost("destination-notes", true);
      const active = await activateWorkspaceHandoff({
        transferId,
        sourceServerId: source.daemon.daemon.getServerId(),
        getSource: () => source.client,
        destination: destination.client,
      });
      expect(active.state).toBe("active");
      expect(active.agentMappings).toEqual(refreshed.agentMappings);
      await expect(
        source.daemon.daemon.agentStorage.setTitle(agentId, "Late source write"),
      ).rejects.toMatchObject({ code: "fenced" });
      await expect(source.daemon.daemon.agentStorage.remove(agentId)).rejects.toMatchObject({
        code: "fenced",
      });
      const destinationAgentId = active.agentMappings[0].destinationAgentId;
      const record = await destination.daemon.daemon.agentStorage.get(destinationAgentId);
      expect(record?.pendingRestartNote).toEqual([...notes, late]);
      expect(record?.carriedPrompt).toBeUndefined();
      expect(record?.lastStatus).toBe("closed");
      expect(destination.daemon.daemon.agentManager.getAgent(destinationAgentId)).toBeNull();
      if (continuationMode === "context") expect(record?.handoffContext?.pending).toBe(true);
      await stopHost(destination);
      destination = await startHost("destination-notes", true);
      expect(
        (await destination.daemon.daemon.agentStorage.get(destinationAgentId))?.pendingRestartNote,
      ).toEqual([...notes, late]);
      expect((await source.daemon.daemon.agentStorage.get(agentId))?.pendingRestartNote).toEqual([
        ...notes,
        late,
      ]);
      if (continuationMode === "native") {
        if (!record?.workspaceId) throw new Error("Missing destination workspace");
        const returnTransferId = randomUUID();
        await prepareWorkspaceHandoff({
          transferId: returnTransferId,
          workspaceId: record.workspaceId,
          destinationParent: root,
          continuationMode: "native",
          source: destination.client,
          destination: source.client,
        });
        const returned = await activateWorkspaceHandoff({
          transferId: returnTransferId,
          sourceServerId: destination.daemon.daemon.getServerId(),
          getSource: () => destination.client,
          destination: source.client,
        });
        expect(returned.state).toBe("active");
        const returnedAgent = await source.daemon.daemon.agentStorage.get(
          returned.agentMappings[0].destinationAgentId,
        );
        expect(returnedAgent?.pendingRestartNote).toEqual([...notes, late]);
        expect(returnedAgent?.persistence?.sessionId).toBe(sessionId);
        expect(returnedAgent?.carriedPrompt).toBeUndefined();
      } else {
        await expectContextHandoffReturn({
          source,
          destination,
          agentId: destinationAgentId,
          originalAgentId: agentId,
          originalCwd: cwd,
          originalTranscript: path.join(project, `${sessionId}.jsonl`),
          originalTransferId: transferId,
          sessionId,
          notes: [...notes, late],
        });
      }
    },
    30_000,
  );

  test.skipIf(process.platform === "win32")(
    `keeps ${continuationMode} handoff fenced until prompt annotation history is saved and unchanged`,
    async () => {
      let source = await startHost("source", true);
      let destination = await startHost("destination", true);
      const cwd = path.join(root, "annotation-workspace");
      await mkdir(cwd);
      const created = await source.client.createWorkspace({
        source: { kind: "directory", path: cwd },
      });
      if (!created.workspace) throw new Error("Missing source workspace");
      const workspaceId = created.workspace.id;
      const agentId = randomUUID();
      const sessionId = randomUUID();
      const recoveredMessageId = randomUUID();
      const project = claudeProjectDirSync(cwd, { configDir: path.join(root, "source", "claude") });
      await mkdir(project, { recursive: true });
      await writeFile(
        path.join(project, `${sessionId}.jsonl`),
        [randomUUID(), recoveredMessageId]
          .map((uuid) =>
            JSON.stringify({
              type: "user",
              uuid,
              sessionId,
              message: { role: "user", content: "A background task finished" },
            }),
          )
          .join("\n") + "\n",
      );
      const timestamp = new Date().toISOString();
      await source.daemon.daemon.agentStorage.upsert(
        parseStoredAgentRecord({
          id: agentId,
          provider: "claude",
          cwd,
          workspaceId,
          createdAt: timestamp,
          updatedAt: timestamp,
          lastStatus: "closed",
          persistence: {
            provider: "claude",
            sessionId,
            metadata: {
              claudeRuntime: {
                configDir: path.join(root, "source", "claude"),
                cliVersion: "2.1.295",
              },
            },
          },
        }),
      );
      // Seed a historical, already closed conversation without opening a provider runtime.
      const annotationDirectory = path.join(source.daemon.paseoHome, "prompt-annotations");
      const annotations = new PromptAnnotationStore(annotationDirectory, {
        records: source.daemon.daemon.agentStorage,
      });
      await annotations.remember(agentId, {
        messageId: "wake-1",
        text: "A background task finished",
        annotation: { kind: "notification", level: "info", message: "Original notification" },
      });
      await annotations.remember(agentId, {
        messageId: "wake-2",
        text: "A background task finished",
        annotation: { kind: "notification", level: "info", message: "Recovered notification" },
        nativeMessageIds: true,
      });
      await annotations.prepareNativeDispatch({
        agentId,
        messageId: "wake-2",
        nativeMessageId: recoveredMessageId,
      });
      // The daemon lost the dispatch acknowledgement; the native user UUID survived.
      await stopHost(source);
      source = await startHost("source", true);
      const annotationPath = path.join(
        source.daemon.paseoHome,
        "prompt-annotations",
        `${agentId}.json`,
      );
      let original = await readFile(annotationPath, "utf8");
      await writeFile(annotationPath, JSON.stringify({ version: 1, entries: {} }));
      const transferId = randomUUID();
      const request = { transferId, workspaceId, destinationParent: root, continuationMode };
      await expect(
        prepareWorkspaceHandoff({
          ...request,
          source: source.client,
          destination: destination.client,
        }),
      ).rejects.toThrow("Prompt annotation history is invalid");
      expect(
        (await source.client.handoffGetSourceStatus({ transferId })).result?.source.state,
      ).toBe("preparing");
      await expect(
        source.daemon.daemon.handoffOwnership.withMutation({ cwd }, async () => {}),
      ).rejects.toMatchObject({ code: "fenced" });
      await writeFile(annotationPath, original);
      const transcriptPath = path.join(project, `${sessionId}.jsonl`);
      const transcript = await readFile(transcriptPath, "utf8");
      const transcriptLines = transcript.trim().split("\n");
      // Matching text under another UUID is not evidence for the missing dispatch.
      await writeFile(transcriptPath, transcriptLines[0] + "\n");
      await expect(
        prepareWorkspaceHandoff({
          ...request,
          source: source.client,
          destination: destination.client,
        }),
      ).rejects.toThrow("Native prompt dispatch outcome is unresolved");
      expect(await readFile(annotationPath, "utf8")).toBe(original);
      // Duplicate identities must remain ambiguous through the real history decoder.
      await writeFile(transcriptPath, transcript + transcriptLines[1] + "\n");
      await expect(
        prepareWorkspaceHandoff({
          ...request,
          source: source.client,
          destination: destination.client,
        }),
      ).rejects.toThrow("Native prompt identity appears more than once");
      expect(await readFile(annotationPath, "utf8")).toBe(original);
      await writeFile(transcriptPath, transcript);
      const manager = source.daemon.daemon.agentManager;
      const recover = manager.recoverPromptAnnotationsForHandoff.bind(manager);
      const concurrentEdit = vi
        .spyOn(manager, "recoverPromptAnnotationsForHandoff")
        .mockImplementationOnce(async (...args) => {
          await recover(...args);
          await source.daemon.daemon.agentStorage.setTitle(agentId, "Concurrent title");
        });
      try {
        await expect(
          prepareWorkspaceHandoff({
            ...request,
            source: source.client,
            destination: destination.client,
          }),
        ).rejects.toThrow("Source conversation changed during annotation recovery");
      } finally {
        concurrentEdit.mockRestore();
      }
      const staged = await prepareWorkspaceHandoff({
        ...request,
        source: source.client,
        destination: destination.client,
      });
      expect(staged.state).toBe("staged");
      original = await readFile(annotationPath, "utf8");
      expect(JSON.parse(original).entries[1].nativeDispatches).toEqual([
        { messageId: recoveredMessageId, state: "dispatched" },
      ]);
      await stopHost(source);
      await stopHost(destination);
      const changed = JSON.parse(original);
      changed.entries[0].annotation.message = "Changed notification";
      await writeFile(annotationPath, JSON.stringify(changed));
      source = await startHost("source", true);
      destination = await startHost("destination", true);
      expect((await source.client.handoffReleaseSource({ transferId })).error?.message).toContain(
        "checkpoint does not match",
      );
      expect(
        (await source.client.handoffGetSourceStatus({ transferId })).result?.source.state,
      ).toBe("ready");
      await writeFile(annotationPath, original);
      // Valid checkpoints enter final verification; a changed workspace still refuses release.
      const lateFile = path.join(cwd, "changed-before-release.txt");
      await writeFile(lateFile, "Late workspace edit");
      expect((await source.client.handoffReleaseSource({ transferId })).error?.code).toBe(
        "source_changed",
      );
      await rm(lateFile);
      // The final verification has sealed the store even when it refuses the changed workspace.
      await expect(
        new PromptAnnotationStore(annotationDirectory, {
          records: source.daemon.daemon.agentStorage,
        }).remember(agentId, {
          messageId: "not-sent",
          text: "not in the transcript",
          annotation: { kind: "notification", level: "info", message: "Not sent" },
        }),
      ).rejects.toMatchObject({ code: "fenced" });
      expect(await readFile(annotationPath, "utf8")).toBe(original);
      await cancelWorkspaceHandoff({
        transferId,
        sourceServerId: source.daemon.daemon.getServerId(),
        getSource: () => source.client,
        destination: destination.client,
      });
      let refreshedTransferId = randomUUID();
      await prepareWorkspaceHandoff({
        ...request,
        transferId: refreshedTransferId,
        source: source.client,
        destination: destination.client,
      });
      // Before sealing, a changed witness still invalidates capture even without a new history row.
      await new PromptAnnotationStore(annotationDirectory, {
        records: source.daemon.daemon.agentStorage,
      }).remember(agentId, {
        messageId: "not-sent",
        text: "not in the transcript",
        annotation: { kind: "notification", level: "info", message: "Not sent" },
      });
      expect(
        (await source.client.handoffReleaseSource({ transferId: refreshedTransferId })).error?.code,
      ).toBe("source_changed");
      await cancelWorkspaceHandoff({
        transferId: refreshedTransferId,
        sourceServerId: source.daemon.daemon.getServerId(),
        getSource: () => source.client,
        destination: destination.client,
      });
      refreshedTransferId = randomUUID();
      await prepareWorkspaceHandoff({
        ...request,
        transferId: refreshedTransferId,
        source: source.client,
        destination: destination.client,
      });
      const active = await activateWorkspaceHandoff({
        transferId: refreshedTransferId,
        sourceServerId: source.daemon.daemon.getServerId(),
        getSource: () => source.client,
        destination: destination.client,
      });
      expect(active.state).toBe("active");
      const history = await destination.client.handoffGetConversationHistory({
        agentId: active.agentMappings[0].destinationAgentId,
      });
      expect(history.error).toBeNull();
      expect(history.result?.mode).toBe(continuationMode);
      expect(history.result?.timeline.entries.map((entry) => entry.item)).toEqual([
        {
          type: "notification",
          level: "info",
          message: "Original notification",
          messageId: "wake-1",
        },
        {
          type: "notification",
          level: "info",
          message: "Recovered notification",
          messageId: "wake-2",
        },
      ]);
    },
    30_000,
  );

  test.skipIf(process.platform === "win32")(
    `reviews omitted conversation MCP connections before ${continuationMode} handoff and retains approval through restart`,
    async () => {
      let source = await startHost("source", true);
      let destination = await startHost("destination", true);
      const cwd = path.join(root, "mcp-workspace");
      await mkdir(cwd);
      const created = await source.client.createWorkspace({
        source: { kind: "directory", path: cwd },
      });
      if (!created.workspace) throw new Error("Missing source workspace");
      const workspaceId = created.workspace.id;
      const agentId = randomUUID();
      const sessionId = randomUUID();
      const project = claudeProjectDirSync(cwd, { configDir: path.join(root, "source", "claude") });
      await mkdir(project, { recursive: true });
      await writeFile(
        path.join(project, `${sessionId}.jsonl`),
        JSON.stringify({
          type: "user",
          uuid: randomUUID(),
          sessionId,
          message: { role: "user", content: "Continue the workspace task" },
        }) + "\n",
      );
      const timestamp = new Date().toISOString();
      const record = parseStoredAgentRecord({
        id: agentId,
        provider: "claude",
        cwd,
        workspaceId,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastStatus: "closed",
        persistence: {
          provider: "claude",
          sessionId,
          metadata: {
            claudeRuntime: {
              configDir: path.join(root, "source", "claude"),
              cliVersion: "2.1.295",
            },
          },
        },
        config: {
          mcpServers: {
            tracker: {
              type: "http",
              url: "https://PRIVATE_ENDPOINT.invalid/mcp",
              headers: { Authorization: "PRIVATE_CREDENTIAL" },
            },
            browser: {
              type: "stdio",
              command: "/PRIVATE_EXECUTABLE",
              env: { TOKEN: "PRIVATE_ENV" },
            },
          },
        },
      });
      await source.daemon.daemon.agentStorage.upsert(record);
      const preview = await source.client.handoffPreviewSource({ workspaceId });
      expect(preview.error).toBeNull();
      const integrationReview = preview.result?.integrationReview;
      expect(integrationReview).toEqual([{ agentId, omittedMcpServers: ["browser", "tracker"] }]);
      expect(JSON.stringify(preview)).not.toContain("PRIVATE_");
      const request = {
        transferId: randomUUID(),
        workspaceId,
        destinationParent: root,
        continuationMode,
        integrationReview,
      };
      const changed = {
        ...record,
        config: { mcpServers: { calendar: { type: "stdio", command: "/PRIVATE_NEW_EXECUTABLE" } } },
      };
      await source.daemon.daemon.agentStorage.upsert(changed);
      await expect(
        prepareWorkspaceHandoff({
          ...request,
          source: source.client,
          destination: destination.client,
        }),
      ).rejects.toThrow("Conversation MCP connections changed after review");
      expect((await destination.client.handoffGetDestinationStatus(request)).error?.code).toBe(
        "not_found",
      );
      expect((await source.client.handoffFindSource({ workspaceId })).result).toBeNull();
      const reservation = await destination.client.handoffReserveDestination({
        ...request,
        sourceServerId: source.daemon.daemon.getServerId(),
        sourceWorkspaceId: workspaceId,
        sourceAgentIds: [agentId],
      });
      if (!reservation.result) throw new Error("Missing destination reservation");
      const prepare = {
        transferId: request.transferId,
        workspaceId,
        agentIds: [agentId],
        integrationReview,
        destinationServerId: destination.daemon.daemon.getServerId(),
        reservationId: reservation.result.reservationId,
      };
      expect((await source.client.handoffPrepareSource(prepare)).error?.code).toBe(
        "review_changed",
      );
      expect((await source.client.handoffFindSource({ workspaceId })).result).toBeNull();
      await source.daemon.daemon.agentStorage.upsert(record);
      const staged = await prepareWorkspaceHandoff({
        ...request,
        source: source.client,
        destination: destination.client,
      });
      expect(staged).toMatchObject({ state: "staged", integrationReview });
      await stopHost(source);
      await stopHost(destination);
      source = await startHost("source", true);
      destination = await startHost("destination", true);
      expect(
        (await source.client.handoffGetSourceStatus(request)).result?.source.integrationReview,
      ).toEqual(integrationReview);
      expect(
        (await destination.client.handoffGetDestinationStatus(request)).result?.integrationReview,
      ).toEqual(integrationReview);
      expect(
        (await source.client.handoffPrepareSource({ ...prepare, integrationReview: [] })).error
          ?.code,
      ).toBe("review_changed");
      await expect(
        prepareWorkspaceHandoff({
          ...request,
          integrationReview: [],
          source: source.client,
          destination: destination.client,
        }),
      ).rejects.toThrow("Transfer already has another destination reservation");
      await source.daemon.daemon.agentStorage.upsert(changed);
      expect((await source.client.handoffReleaseSource(request)).error?.code).toBe(
        "review_changed",
      );
      expect((await source.client.handoffGetSourceStatus(request)).result?.source.state).toBe(
        "ready",
      );
      await source.daemon.daemon.agentStorage.upsert(record);
      const active = await activateWorkspaceHandoff({
        sourceServerId: source.daemon.daemon.getServerId(),
        getSource: () => source.client,
        destination: destination.client,
        transferId: request.transferId,
      });
      expect(active.state).toBe("active");
      const imported = await destination.daemon.daemon.agentStorage.get(
        active.agentMappings[0].destinationAgentId,
      );
      expect(imported?.lastStatus).toBe("closed");
      expect(imported?.config?.mcpServers).toBeUndefined();
      expect(JSON.stringify(imported)).not.toContain("PRIVATE_");
      expect(JSON.stringify(active)).not.toContain("PRIVATE_");
    },
    30_000,
  );
}

test.skipIf(process.platform === "win32")(
  "retains Git references, tracking and sanitized remotes through transport, restart and activation",
  async () => {
    // Fixture commits and tags must not invoke the host's signing program or hooks.
    const runGit = (args: string[], cwd: string | undefined) =>
      exec("git", args, {
        cwd,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      });
    const source = await startHost("source");
    let destination = await startHost("destination");
    const cwd = path.join(root, "remote-workspace");
    await mkdir(cwd);
    await runGit(["init", "--initial-branch=work"], cwd);
    await writeFile(path.join(cwd, "work.txt"), "local work\n");
    await runGit(["add", "work.txt"], cwd);
    await runGit(
      [
        "-c",
        "user.name=Handoff Test",
        "-c",
        "user.email=handoff@example.com",
        "-c",
        "core.hooksPath=",
        "commit",
        "--no-gpg-sign",
        "-m",
        "Work before transfer",
      ],
      cwd,
    );
    const url = "https://PRIVATE_REMOTE_TOKEN@github.com/org/repo.git";
    await runGit(["remote", "add", "origin", url], cwd);
    await runGit(["branch", "topic"], cwd);
    await runGit(["tag", "saved"], cwd);
    const head = (await runGit(["rev-parse", "HEAD"], cwd)).stdout.trim();
    await runGit(["update-ref", "refs/remotes/origin/work", head], cwd);
    await runGit(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/work"], cwd);
    await runGit(["branch", "--set-upstream-to=origin/work"], cwd);
    await runGit(["config", "push.default", "current"], cwd);
    const refs = (
      await runGit(["for-each-ref", "--format=%(refname) %(objectname) %(symref)"], cwd)
    ).stdout;
    const created = await source.client.createWorkspace({
      source: { kind: "directory", path: cwd },
    });
    if (!created.workspace) throw new Error("Missing workspace");
    const transferId = randomUUID();
    const staged = await prepareWorkspaceHandoff({
      transferId,
      source: source.client,
      destination: destination.client,
      workspaceId: created.workspace.id,
      destinationParent: root,
      continuationMode: "native",
    });
    expect(staged.state).toBe("staged");
    const stagingCwd = destination.daemon.daemon.handoffDestination.status(transferId).stagingCwd;
    expect((await runGit(["remote", "get-url", "origin"], stagingCwd)).stdout).toBe(
      "https://github.com/org/repo.git\n",
    );
    expect(
      (await runGit(["for-each-ref", "--format=%(refname) %(objectname) %(symref)"], stagingCwd))
        .stdout,
    ).toBe(refs);
    await runGit(["config", "push.default", "matching"], cwd);
    expect((await source.client.handoffReleaseSource({ transferId })).error?.code).toBe(
      "source_changed",
    );
    await runGit(["config", "push.default", "current"], cwd);
    await runGit(["tag", "-d", "saved"], cwd);
    expect((await source.client.handoffReleaseSource({ transferId })).error?.code).toBe(
      "source_changed",
    );
    await runGit(["tag", "saved", head], cwd);
    await runGit(["remote", "set-url", "origin", "https://github.com/changed/repo.git"], cwd);
    const refused = await source.client.handoffReleaseSource({ transferId });
    expect(refused.error?.code).toBe("source_changed");
    expect(source.daemon.daemon.handoffOwnership.status(transferId).state).toBe("ready");
    await runGit(["remote", "set-url", "origin", url], cwd);
    await stopHost(destination);
    destination = await startHost("destination");
    const activated = await activateWorkspaceHandoff({
      transferId,
      sourceServerId: source.daemon.daemon.getServerId(),
      getSource: () => source.client,
      destination: destination.client,
    });
    expect(activated.state).toBe("active");
    expect((await runGit(["remote", "get-url", "origin"], activated.destinationCwd)).stdout).toBe(
      "https://github.com/org/repo.git\n",
    );
    expect(
      await readFile(path.join(activated.destinationCwd, ".git", "config"), "utf8"),
    ).not.toContain("PRIVATE_REMOTE_TOKEN");
    expect(
      (
        await runGit(
          ["for-each-ref", "--format=%(refname) %(objectname) %(symref)"],
          activated.destinationCwd,
        )
      ).stdout,
    ).toBe(refs);
    expect(
      (await runGit(["rev-parse", "--symbolic-full-name", "@{upstream}"], activated.destinationCwd))
        .stdout,
    ).toBe("refs/remotes/origin/work\n");
    expect((await runGit(["config", "push.default"], activated.destinationCwd)).stdout).toBe(
      "current\n",
    );
  },
  30_000,
);

for (const outcome of ["activate", "cancel"] as const) {
  test.skipIf(process.platform === "win32")(
    `retains mixed native/context choices through restart and ${outcome}`,
    async () => {
      let source = await startHost("source", true);
      let destination = await startHost("destination", true);
      const cwd = path.join(root, "mixed-workspace");
      await mkdir(cwd);
      const created = await source.client.createWorkspace({
        source: { kind: "directory", path: cwd },
      });
      if (!created.workspace) throw new Error("Missing workspace");
      const workspaceId = created.workspace.id;
      const choices = ["native", "context"].map((mode) => ({
        mode,
        agentId: randomUUID(),
        sessionId: randomUUID(),
        runtime: {
          configDir: path.join(root, `original-${mode}-home`),
          cliVersion: mode === "native" ? "2.1.295" : "2.1.296",
        },
      }));
      for (const choice of choices) {
        const project = claudeProjectDirSync(cwd, { configDir: choice.runtime.configDir });
        await mkdir(project, { recursive: true });
        const timestamp = new Date().toISOString();
        await source.daemon.daemon.agentStorage.upsert(
          parseStoredAgentRecord({
            id: choice.agentId,
            provider: "claude",
            cwd,
            workspaceId,
            title: choice.mode,
            createdAt: timestamp,
            updatedAt: timestamp,
            lastStatus: "closed",
            persistence: {
              provider: "claude",
              sessionId: choice.sessionId,
              metadata: { claudeRuntime: choice.runtime },
            },
          }),
        );
        await writeFile(
          path.join(project, `${choice.sessionId}.jsonl`),
          JSON.stringify({
            type: "user",
            uuid: randomUUID(),
            sessionId: choice.sessionId,
            message: { role: "user", content: `${choice.mode} conversation prior-only-token` },
          }) + "\n",
        );
        if (choice.mode === "context") {
          const workflows = path.join(project, choice.sessionId, "workflows");
          await mkdir(workflows, { recursive: true });
          await writeFile(path.join(workflows, "state.json"), JSON.stringify({ type: "state" }));
        }
      }
      const conversationModes = [
        { sourceAgentId: choices[0].agentId, mode: "native" as const },
        { sourceAgentId: choices[1].agentId, mode: "context" as const },
      ].sort((a, b) => a.sourceAgentId.localeCompare(b.sourceAgentId));
      const request = {
        transferId: randomUUID(),
        workspaceId,
        destinationParent: root,
        continuationMode: "native" as const,
        conversationModes,
      };
      const original = await storedNativeRecord(source, choices[0].agentId);
      await source.daemon.daemon.agentStorage.upsert({
        ...original,
        persistence: { ...original.persistence, metadata: {} },
      });
      const unknown = await source.client.handoffPreviewSource({ workspaceId });
      expect(
        unknown.result?.conversations.find((item) => item.agentId === original.id),
      ).toMatchObject({
        state: "blocked",
        reason:
          "This conversation has no recorded Claude runtime. Resume it on the source host before transferring it.",
      });
      await source.daemon.daemon.agentStorage.upsert(original);
      const review = await source.client.handoffPreviewSource({ workspaceId });
      if (!review.result) throw new Error("Missing source review");
      for (const choice of choices) {
        expect(
          review.result.conversations.find((item) => item.agentId === choice.agentId),
        ).toMatchObject({
          state: "available",
          cliVersion: choice.runtime.cliVersion,
        });
      }
      const compatibility = await destination.client.handoffPreviewDestination({
        conversations: review.result.conversations,
      });
      expect(compatibility.result?.supportsConversationModes).toBe(true);
      expect(
        compatibility.result?.conversations.find((item) => item.agentId === choices[1].agentId),
      ).toMatchObject({
        native: { available: false },
        context: { available: true },
      });
      for (const invalid of [
        [],
        [conversationModes[0], conversationModes[0]],
        [...conversationModes, { sourceAgentId: "unknown", mode: "context" as const }],
      ]) {
        const rejected = await destination.client.handoffReserveDestination({
          ...request,
          sourceServerId: source.daemon.daemon.getServerId(),
          sourceWorkspaceId: workspaceId,
          sourceAgentIds: choices.map((item) => item.agentId),
          conversationModes: invalid,
        });
        expect(rejected.error?.code).toBe("invalid_state");
        expect((await destination.client.handoffGetDestinationStatus(request)).error?.code).toBe(
          "not_found",
        );
      }
      const staged = await prepareWorkspaceHandoff({
        ...request,
        source: source.client,
        destination: destination.client,
      });
      expect(staged).toMatchObject({ state: "staged", conversationModes });
      const mapping = (sourceAgentId: string) => {
        const found = staged.agentMappings.find((item) => item.sourceAgentId === sourceAgentId);
        if (!found) throw new Error("Missing conversation mapping");
        return found.destinationAgentId;
      };
      const nativeId = mapping(choices[0].agentId);
      const contextId = mapping(choices[1].agentId);
      const configDir = path.join(root, "destination", "claude", "projects");
      expect(await readdir(configDir)).toContain(`paseo-handoff-${nativeId}`);
      expect(await readdir(configDir)).not.toContain(`paseo-handoff-${contextId}`);
      const sourceId = source.daemon.daemon.getServerId();
      await stopHost(source);
      await stopHost(destination);
      source = await startHost("source", true);
      destination = await startHost("destination", true);
      const recovered = await destination.client.handoffGetDestinationStatus(request);
      expect(recovered.result?.conversationModes).toEqual(conversationModes);
      await expectCapturedRuntimeUnchanged(source, request.transferId, choices[0].agentId);
      expect(
        (
          await destination.client.handoffListDestination({
            sourceServerId: sourceId,
            sourceWorkspaceId: workspaceId,
          })
        ).result?.transfers[0].conversationModes,
      ).toEqual(conversationModes);
      await expect(
        prepareWorkspaceHandoff({
          ...request,
          source: source.client,
          destination: destination.client,
          conversationModes: conversationModes.map(({ sourceAgentId }) => ({
            sourceAgentId,
            mode: "context",
          })),
        }),
      ).rejects.toThrow("Transfer already has another destination reservation");
      if (outcome === "cancel") {
        // No native installation belongs to the context conversation; cleanup must leave foreign content alone.
        const foreign = path.join(configDir, `paseo-handoff-${contextId}`);
        await mkdir(foreign);
        await writeFile(path.join(foreign, "foreign.txt"), "unrelated");
        const cancelled = await cancelWorkspaceHandoff({
          sourceServerId: sourceId,
          getSource: () => source.client,
          destination: destination.client,
          transferId: request.transferId,
        });
        expect(cancelled.cleanupComplete).toBe(true);
        expect(await readdir(configDir)).not.toContain(`paseo-handoff-${nativeId}`);
        expect(await readFile(path.join(foreign, "foreign.txt"), "utf8")).toBe("unrelated");
        return;
      }
      const release = await source.client.handoffReleaseSource(request);
      if (!release.result) throw new Error("Missing release receipt");
      await destination.daemon.daemon.handoffDestination.acceptRelease(
        request.transferId,
        release.result,
      );
      await stopHost(source);
      const active = await activateWorkspaceHandoff({
        sourceServerId: sourceId,
        getSource: () => {
          throw new Error("Source is offline");
        },
        destination: destination.client,
        transferId: request.transferId,
      });
      expect(active.state).toBe("active");
      const native = await destination.daemon.daemon.agentStorage.get(nativeId);
      const context = await destination.daemon.daemon.agentStorage.get(contextId);
      expect(native).toMatchObject({
        persistence: {
          sessionId: choices[0].sessionId,
          metadata: {
            claudeRuntime: {
              configDir: path.join(root, "destination", "claude"),
              cliVersion: "2.1.295",
            },
          },
        },
      });
      expect(native).not.toHaveProperty("handoffContext");
      expect(context).toMatchObject({ persistence: null, handoffContext: { pending: true } });
      for (const choice of choices) {
        const history = await destination.client.handoffGetConversationHistory({
          agentId: mapping(choice.agentId),
        });
        expect(history.result?.mode).toBe(choice.mode);
        expect(JSON.stringify(history.result?.timeline.entries)).toContain(
          `${choice.mode} conversation prior-only-token`,
        );
      }
      const contextDirectories = await readdir(
        path.join(active.destinationCwd, `handoff-context-${active.reservationId}`),
      );
      expect(contextDirectories).toEqual([contextId]);
    },
    30_000,
  );
}
