import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { ScheduleStore } from "./store.js";
import {
  captureHandoffSchedules,
  remapHandoffSchedules,
  reviewScheduleForHandoff,
  parseHandoffSchedules,
  scheduleHandoffDigest,
} from "./handoff.js";
import * as atomicFile from "../atomic-file.js";
import * as artifacts from "../handoff/artifacts.js";

describe("ScheduleStore", () => {
  let tempDir: string;
  let store: ScheduleStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "schedule-store-test-"));
    store = new ScheduleStore(tempDir, createTestLogger());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await chmod(join(tempDir, ".pending"), 0o700).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rm(tempDir, { recursive: true, force: true });
  });

  async function createRunningSchedule() {
    const timestamp = "2026-01-01T00:00:00.000Z";
    return store.create({
      name: null,
      prompt: "Continue",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
      nextRunAt: timestamp,
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: 1,
      runs: [
        {
          id: "run",
          scheduledFor: timestamp,
          startedAt: timestamp,
          endedAt: null,
          status: "running",
          agentId: null,
          output: null,
          error: null,
        },
      ],
    });
  }

  test.skipIf(process.platform === "win32").each([
    { kind: "heartbeat", status: "succeeded" },
    { kind: "heartbeat", status: "failed" },
    { kind: "schedule", status: "succeeded" },
    { kind: "schedule", status: "failed" },
  ] as const)(
    "handoff binds a reviewed $kind run while accepting its $status outcome",
    async ({ kind, status }) => {
      const previous = "2026-01-01T00:00:00.000Z";
      const started = "2026-01-01T00:01:00.000Z";
      const ended = "2026-01-01T00:02:00.000Z";
      const agentId = randomUUID();
      const activeRun = { id: randomUUID(), previousLastRunAt: previous };
      const schedule = await store.create({
        name: "Heartbeat",
        prompt: "Continue",
        cadence: { type: "every", everyMs: 60_000 },
        target:
          kind === "heartbeat"
            ? { type: "agent", agentId }
            : {
                type: "new-agent",
                config: { provider: "claude", cwd: tempDir },
              },
        status: "active",
        createdAt: previous,
        updatedAt: started,
        nextRunAt: started,
        lastRunAt: previous,
        pausedAt: null,
        expiresAt: null,
        maxRuns: 2,
        runs: [
          {
            id: randomUUID(),
            scheduledFor: previous,
            startedAt: previous,
            endedAt: previous,
            status: "succeeded",
            agentId,
            output: "earlier output",
            error: null,
          },
          {
            id: activeRun.id,
            scheduledFor: started,
            startedAt: started,
            endedAt: null,
            status: "running",
            agentId,
            output: null,
            error: null,
          },
        ],
      });
      const review = reviewScheduleForHandoff(schedule, activeRun);
      const completed = {
        ...schedule,
        status: "completed" as const,
        lastRunAt: ended,
        nextRunAt: null,
        runs: [
          schedule.runs[0],
          {
            ...schedule.runs[1],
            status,
            endedAt: ended,
            output: "final output",
            error: status === "failed" ? "canceled" : null,
          },
        ],
      };
      expect(scheduleHandoffDigest(completed, activeRun)).toBe(review.digest);
      expect(scheduleHandoffDigest({ ...completed, prompt: "changed" }, activeRun)).not.toBe(
        review.digest,
      );
      expect(
        scheduleHandoffDigest(
          {
            ...completed,
            runs: [{ ...completed.runs[0], output: "changed history" }, completed.runs[1]],
          },
          activeRun,
        ),
      ).not.toBe(review.digest);
      expect(() =>
        scheduleHandoffDigest({ ...completed, runs: [completed.runs[0]] }, activeRun),
      ).toThrow("reviewed scheduled run");
      await store.update(schedule.id, () => completed);
      const paused = await store.pauseForHandoff({
        id: schedule.id,
        digest: review.digest,
        pausedAt: ended,
        activeRun,
      });
      expect(paused).toEqual(completed);
      const snapshot = captureHandoffSchedules({
        records: [paused],
        relativeCwds: new Map([[schedule.id, "."]]),
        reviews: [review],
      });
      expect(snapshot.schedules[0]).toMatchObject({
        reviewDigest: review.digest,
        status: "completed",
        runs: completed.runs,
      });
      expect(() =>
        captureHandoffSchedules({
          records: [{ ...schedule, status: "paused", nextRunAt: null }],
          relativeCwds: new Map([[schedule.id, "."]]),
          reviews: [review],
        }),
      ).toThrow("still active");
    },
  );

  test("handoff recovers a known outcome after restart before its schedule record was published", async () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    const schedule = await createRunningSchedule();
    const candidate = {
      ...schedule,
      status: "completed" as const,
      nextRunAt: null,
      lastRunAt: timestamp,
      runs: [
        {
          ...schedule.runs[0],
          status: "succeeded" as const,
          endedAt: timestamp,
          output: "Exact completed output",
        },
      ],
    };
    const write = atomicFile.writeJsonFileAtomic;
    const fail = vi
      .spyOn(atomicFile, "writeJsonFileAtomic")
      .mockImplementation(async (file, value) => {
        if (file === join(tempDir, `${schedule.id}.json`))
          throw new Error("outcome record unavailable");
        return write(file, value);
      });
    try {
      await expect(store.update(schedule.id, () => candidate, { durable: true })).rejects.toThrow(
        "outcome record unavailable",
      );
    } finally {
      fail.mockRestore();
    }
    const restarted = new ScheduleStore(tempDir, createTestLogger());
    expect(await restarted.get(schedule.id)).toEqual(candidate);
    expect(await restarted.listForHandoff()).toEqual([candidate]);
    await restarted.update(schedule.id, (record) => ({ ...record, name: "Later edit" }));
    expect((await new ScheduleStore(tempDir, createTestLogger()).get(schedule.id))?.name).toBe(
      "Later edit",
    );
  });

  test
    .skipIf(process.platform === "win32" || process.getuid?.() === 0)
    .each(["intent sync", "record sync", "intent removal", "intent retirement sync"])(
    "restart cannot acknowledge a known outcome before repairing %s",
    async (phase) => {
      const schedule = await createRunningSchedule();
      const candidate = {
        ...schedule,
        status: "completed" as const,
        nextRunAt: null,
        runs: [
          {
            ...schedule.runs[0],
            status: "succeeded" as const,
            endedAt: schedule.createdAt,
            output: "Completed once",
          },
        ],
      };
      const recordPath = join(tempDir, `${schedule.id}.json`);
      const journalPath = join(tempDir, ".pending", `${schedule.id}.json`);
      const sync = atomicFile.syncFilePublication;
      const syncDirectory = artifacts.syncDirectory;
      const expectedError = phase === "intent removal" ? "EACCES" : phase;
      vi.spyOn(atomicFile, "syncFilePublication").mockImplementation(async (file, root) => {
        if (
          (phase === "intent sync" && file === journalPath) ||
          (phase === "record sync" && file === recordPath)
        )
          throw new Error(phase);
        await sync(file, root);
        if (phase === "intent removal" && file === recordPath)
          await chmod(join(tempDir, ".pending"), 0o500);
      });
      vi.spyOn(artifacts, "syncDirectory").mockImplementation(async (directory) => {
        if (phase === "intent retirement sync" && directory === join(tempDir, ".pending"))
          throw new Error(phase);
        return syncDirectory(directory);
      });
      await expect(store.update(schedule.id, () => candidate, { durable: true })).rejects.toThrow(
        expectedError,
      );
      const restarted = new ScheduleStore(tempDir, createTestLogger());
      await expect(restarted.get(schedule.id)).rejects.toThrow(expectedError);
      await expect(restarted.listForHandoff()).rejects.toThrow(expectedError);
      const edit = vi.fn((record: typeof schedule) => ({ ...record, name: "Later edit" }));
      await expect(restarted.update(schedule.id, edit)).rejects.toThrow(expectedError);
      expect(edit).not.toHaveBeenCalled();
      vi.restoreAllMocks();
      await chmod(join(tempDir, ".pending"), 0o700);
      expect(await restarted.list()).toEqual([candidate]);
      expect(await readdir(join(tempDir, ".pending"))).toEqual([]);
      await restarted.update(schedule.id, edit);
      expect((await new ScheduleStore(tempDir, createTestLogger()).get(schedule.id))?.name).toBe(
        "Later edit",
      );
      expect(edit).toHaveBeenCalledTimes(1);
    },
  );

  test("restart refuses a conflicting pending outcome and retries after the conflict is repaired", async () => {
    const schedule = await createRunningSchedule();
    const candidate = { ...schedule, name: "Completed result" };
    const recordPath = join(tempDir, `${schedule.id}.json`);
    const write = atomicFile.writeJsonFileAtomic;
    vi.spyOn(atomicFile, "writeJsonFileAtomic").mockImplementation(async (file, value) => {
      if (file === recordPath) throw new Error("record unavailable");
      return write(file, value);
    });
    await expect(store.update(schedule.id, () => candidate, { durable: true })).rejects.toThrow(
      "record unavailable",
    );
    vi.restoreAllMocks();
    const external = { ...schedule, name: "Other writer" };
    await writeFile(recordPath, JSON.stringify(external));
    const restarted = new ScheduleStore(tempDir, createTestLogger());
    await expect(restarted.get(schedule.id)).rejects.toThrow("changed while");
    await expect(restarted.delete(schedule.id)).rejects.toThrow("changed while");
    expect(JSON.parse(await readFile(recordPath, "utf8"))).toEqual(external);
    await writeFile(recordPath, JSON.stringify(schedule));
    expect(await restarted.get(schedule.id)).toEqual(candidate);
  });

  test.each(["invalid JSON", "wrong version", "wrong identity", "directory"])(
    "restart refuses %s recovery metadata before ordinary schedule mutations",
    async (fault) => {
      const schedule = await createRunningSchedule();
      const journalPath = join(tempDir, ".pending", `${schedule.id}.json`);
      const candidate = { ...schedule, name: "Known result" };
      const intent = { version: 1, previous: schedule, record: candidate };
      if (fault === "directory") await mkdir(journalPath);
      else {
        const damaged =
          fault === "invalid JSON"
            ? "{"
            : JSON.stringify({
                ...intent,
                version: fault === "wrong version" ? 2 : 1,
                record: fault === "wrong identity" ? { ...candidate, id: "deadbeef" } : candidate,
              });
        await writeFile(journalPath, damaged);
      }
      const restarted = new ScheduleStore(tempDir, createTestLogger());
      const updater = vi.fn((record: typeof schedule) => ({ ...record, name: "Later edit" }));
      await expect(restarted.update(schedule.id, updater)).rejects.toThrow();
      await expect(restarted.list()).rejects.toThrow();
      expect(updater).not.toHaveBeenCalled();
      expect(JSON.parse(await readFile(join(tempDir, `${schedule.id}.json`), "utf8"))).toEqual(
        schedule,
      );
      await rm(journalPath, { recursive: true });
      await writeFile(journalPath, JSON.stringify(intent));
      expect(await restarted.get(schedule.id)).toEqual(candidate);
    },
  );

  test.skipIf(process.platform === "win32")(
    "handoff outcome repair keeps exact inputs after rename and gates later mutations on synchronization",
    async () => {
      const timestamp = "2026-01-01T00:00:00.000Z";
      const schedule = await store.create({
        name: null,
        prompt: "Continue",
        cadence: { type: "every", everyMs: 60_000 },
        target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
        nextRunAt: timestamp,
        lastRunAt: null,
        pausedAt: null,
        expiresAt: null,
        maxRuns: 1,
        runs: [
          {
            id: "run",
            scheduledFor: timestamp,
            startedAt: timestamp,
            endedAt: null,
            status: "running",
            agentId: null,
            output: null,
            error: null,
          },
        ],
      });
      const candidate = {
        ...schedule,
        status: "completed" as const,
        nextRunAt: null,
        target: {
          type: "new-agent" as const,
          config: { provider: "claude", cwd: tempDir, model: undefined },
        },
        runs: [
          {
            ...schedule.runs[0],
            status: "succeeded" as const,
            endedAt: timestamp,
            output: "Exact output",
          },
        ],
      };
      const sync = atomicFile.syncFilePublication;
      const failedAck = vi
        .spyOn(atomicFile, "syncFilePublication")
        .mockImplementation(async (file, root) => {
          if (file === join(tempDir, `${schedule.id}.json`))
            throw new Error("outcome synchronization unavailable");
          return sync(file, root);
        });
      const laterMutation = vi.fn((record: typeof schedule) => ({
        ...record,
        name: "Later title",
      }));
      try {
        await expect(store.update(schedule.id, () => candidate, { durable: true })).rejects.toThrow(
          "outcome synchronization unavailable",
        );
        candidate.runs[0].output = "Changed after rejection";
        await expect(store.update(schedule.id, laterMutation)).rejects.toThrow(
          "outcome synchronization unavailable",
        );
        await expect(store.delete(schedule.id)).rejects.toThrow(
          "outcome synchronization unavailable",
        );
        await expect(store.listForHandoff()).rejects.toThrow("outcome synchronization unavailable");
        expect(laterMutation).not.toHaveBeenCalled();
      } finally {
        failedAck.mockRestore();
      }
      await store.repairPendingPersistence(schedule.id);
      const reloaded = new ScheduleStore(tempDir, createTestLogger());
      expect((await reloaded.get(schedule.id))?.runs).toEqual([
        { ...candidate.runs[0], output: "Exact output" },
      ]);
      await store.update(schedule.id, laterMutation);
      expect((await reloaded.get(schedule.id))?.name).toBe("Later title");
      expect(laterMutation).toHaveBeenCalledTimes(1);

      const failedWrite = vi
        .spyOn(atomicFile, "writeJsonFileAtomic")
        .mockRejectedValueOnce(new Error("publication unavailable"));
      try {
        await expect(
          store.update(schedule.id, (record) => ({ ...record, name: "Owned title" }), {
            durable: true,
          }),
        ).rejects.toThrow("publication unavailable");
      } finally {
        failedWrite.mockRestore();
      }
      const external = {
        ...JSON.parse(await readFile(join(tempDir, `${schedule.id}.json`), "utf8")),
        name: "Other title",
      };
      await writeFile(join(tempDir, `${schedule.id}.json`), JSON.stringify(external));
      await expect(store.repairPendingPersistence(schedule.id)).rejects.toThrow("changed while");
      expect(JSON.parse(await readFile(join(tempDir, `${schedule.id}.json`), "utf8"))).toEqual(
        external,
      );
    },
  );

  test.skipIf(process.platform === "win32")(
    "handoff pause reacknowledges a surviving rename after a failed synchronization",
    async () => {
      const timestamp = "2026-01-01T00:00:00.000Z";
      const schedule = await store.create({
        name: null,
        prompt: "Continue",
        cadence: { type: "every", everyMs: 60_000 },
        target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
        nextRunAt: timestamp,
        lastRunAt: null,
        pausedAt: null,
        expiresAt: null,
        maxRuns: 2,
        runs: [],
      });
      const input = {
        id: schedule.id,
        digest: scheduleHandoffDigest(schedule),
        pausedAt: timestamp,
      };
      const failedAck = vi
        .spyOn(atomicFile, "syncFilePublication")
        .mockRejectedValueOnce(new Error("lost synchronization acknowledgement"));
      try {
        await expect(store.pauseForHandoff(input)).rejects.toThrow("lost synchronization");
      } finally {
        failedAck.mockRestore();
      }
      const reloaded = new ScheduleStore(tempDir, createTestLogger());
      expect((await reloaded.get(schedule.id))?.status).toBe("paused");
      expect(await reloaded.pauseForHandoff(input)).toMatchObject({
        status: "paused",
        nextRunAt: null,
      });
      await expect(reloaded.pauseForHandoff({ ...input, digest: "a".repeat(64) })).rejects.toThrow(
        "changed",
      );
    },
  );

  test.skipIf(process.platform === "win32")(
    "handoff installation is hidden, durable, idempotent and never overwrites a collision",
    async () => {
      const timestamp = "2026-01-01T00:00:00.000Z";
      const sourceId = "00000000-0000-4000-8000-000000000001";
      const destinationId = "00000000-0000-4000-8000-000000000002";
      const schedule = await store.create({
        name: null,
        prompt: "Continue",
        cadence: { type: "every", everyMs: 60_000 },
        target: { type: "agent", agentId: sourceId },
        status: "paused",
        createdAt: timestamp,
        updatedAt: timestamp,
        nextRunAt: null,
        lastRunAt: null,
        pausedAt: timestamp,
        expiresAt: null,
        maxRuns: 2,
        runs: [],
      });
      const input = {
        snapshot: captureHandoffSchedules({ records: [schedule], relativeCwds: new Map() }),
        reservationId: "reservation",
        sourceServerId: "source",
        sourceWorkspaceId: "old",
        destinationWorkspaceId: "new",
        destinationCwd: tempDir,
        activationAt: timestamp,
        agentMappings: new Map([[sourceId, destinationId]]),
      };
      let active = false;
      const directory = join(tempDir, "incoming");
      const destination = new ScheduleStore(directory, createTestLogger(), {
        isVisible: () => active,
      });
      const [expected] = remapHandoffSchedules(input);
      await destination.installHandoffSchedules(input);
      await destination.installHandoffSchedules(input);
      expect(await destination.list()).toEqual([]);
      expect(await destination.get(expected.id)).toBeNull();
      await destination.delete(expected.id);
      expect(await new ScheduleStore(directory, createTestLogger()).get(expected.id)).toEqual(
        expected,
      );
      active = true;
      expect(await destination.list()).toEqual([expected]);
      await destination.update(expected.id, (record) => ({ ...record, prompt: "Other work" }));
      await expect(destination.installHandoffSchedules(input)).rejects.toThrow("already in use");
      expect((await destination.get(expected.id))?.prompt).toBe("Other work");
    },
  );

  test("handoff remaps paused automation and preserves run provenance without importing host authority", async () => {
    const sourceAgentId = "00000000-0000-4000-8000-000000000001";
    const destinationAgentId = "00000000-0000-4000-8000-000000000002";
    const timestamp = "2026-01-01T00:00:00.000Z";
    const schedule = await store.create({
      name: "Nightly",
      prompt: "Check the build",
      cadence: { type: "cron", expression: "0 2 * * *", timezone: "Europe/Berlin" },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: join(tempDir, "nested"),
          model: "model",
          modeId: "unrestricted",
          providerOptions: { secret: "private-value" },
          featureValues: { permissions: true },
          mcpServers: { private: { command: "host-only" } },
        },
      },
      status: "paused",
      createdAt: timestamp,
      updatedAt: timestamp,
      nextRunAt: null,
      lastRunAt: timestamp,
      pausedAt: timestamp,
      expiresAt: "2027-01-01T00:00:00.000Z",
      maxRuns: 4,
      runs: [
        {
          id: "run",
          scheduledFor: timestamp,
          startedAt: timestamp,
          endedAt: timestamp,
          status: "succeeded",
          agentId: sourceAgentId,
          workspaceId: "old-workspace",
          output: "saved output",
          error: null,
        },
      ],
    });
    const heartbeat = await store.create({
      ...schedule,
      target: { type: "agent", agentId: sourceAgentId },
    });
    const snapshot = captureHandoffSchedules({
      records: [schedule, heartbeat],
      relativeCwds: new Map([[schedule.id, "nested"]]),
    });
    expect(JSON.stringify(snapshot)).not.toContain("private-value");
    expect(reviewScheduleForHandoff(schedule).omittedSettings).toEqual([
      "modeId",
      "providerOptions",
      "featureValues",
    ]);
    expect(reviewScheduleForHandoff(schedule).omittedMcpServers).toEqual(["private"]);
    const input = {
      snapshot,
      reservationId: "reservation",
      sourceServerId: "source",
      sourceWorkspaceId: "old-workspace",
      destinationWorkspaceId: "new-workspace",
      destinationCwd: join(tempDir, "destination"),
      activationAt: "2026-02-01T00:00:00.000Z",
      agentMappings: new Map([[sourceAgentId, destinationAgentId]]),
    };
    const installed = remapHandoffSchedules(input);
    expect(installed).toEqual(remapHandoffSchedules(input));
    expect(installed[0]).toMatchObject({
      status: "paused",
      nextRunAt: null,
      maxRuns: 4,
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: join(input.destinationCwd, "nested"), model: "model" },
      },
      runs: [
        {
          agentId: destinationAgentId,
          workspaceId: "new-workspace",
          output: "saved output",
          origin: {
            serverId: "source",
            scheduleId: schedule.id,
            agentId: sourceAgentId,
            workspaceId: "old-workspace",
          },
        },
      ],
    });
    expect(installed[0].target).toEqual({
      type: "new-agent",
      config: { provider: "claude", cwd: join(input.destinationCwd, "nested"), model: "model" },
    });
    expect(installed[1].target).toEqual({ type: "agent", agentId: destinationAgentId });
    expect(installed[0].cadence).toEqual(schedule.cadence);
    expect(installed[0].expiresAt).toBe(schedule.expiresAt);
    const returned = remapHandoffSchedules({
      ...input,
      snapshot: captureHandoffSchedules({
        records: [installed[1]],
        relativeCwds: new Map(),
      }),
      reservationId: "return-reservation",
      sourceServerId: "second-host",
      sourceWorkspaceId: "new-workspace",
      destinationWorkspaceId: "returned-workspace",
      agentMappings: new Map([[destinationAgentId, sourceAgentId]]),
    });
    expect(returned[0].id).not.toBe(installed[1].id);
    expect(returned[0].runs[0]).toEqual({
      ...installed[1].runs[0],
      agentId: sourceAgentId,
      workspaceId: "returned-workspace",
    });
    const completed = remapHandoffSchedules({
      ...input,
      snapshot: captureHandoffSchedules({
        records: [{ ...heartbeat, status: "completed", pausedAt: null }],
        relativeCwds: new Map(),
      }),
      agentMappings: new Map([[sourceAgentId, destinationAgentId]]),
    });
    expect(completed[0]).toMatchObject({ status: "completed", nextRunAt: null, pausedAt: null });
    expect(() =>
      parseHandoffSchedules({
        ...snapshot,
        schedules: [snapshot.schedules[0], snapshot.schedules[0]],
      }),
    ).toThrow("Duplicate");
    expect(() => remapHandoffSchedules({ ...input, agentMappings: new Map() })).toThrow("outside");
    expect(() =>
      parseHandoffSchedules({
        ...snapshot,
        schedules: [
          {
            ...snapshot.schedules[0],
            target: { ...snapshot.schedules[0].target, relativeCwd: "../escape" },
          },
        ],
      }),
    ).toThrow("inside");
    expect(() =>
      parseHandoffSchedules({
        ...snapshot,
        schedules: [{ ...snapshot.schedules[0], cadence: { type: "cron", expression: "invalid" } }],
      }),
    ).toThrow();
    const retained = captureHandoffSchedules({
      records: [schedule, heartbeat],
      relativeCwds: new Map(),
      reviews: [{ ...reviewScheduleForHandoff(schedule), retainedOnSource: { cwd: tempDir } }],
    });
    expect(retained.version).toBe(2);
    expect(retained.schedules[0].target).toEqual({ type: "source", cwd: tempDir });
    expect(retained.schedules[0].runs).toEqual(schedule.runs);
    expect(JSON.stringify(retained)).not.toContain("private-value");
    expect(remapHandoffSchedules({ ...input, snapshot: retained })).toEqual([installed[1]]);
    expect(() => parseHandoffSchedules({ ...retained, version: 1 })).toThrow("version 2");
    expect(() =>
      parseHandoffSchedules({
        ...retained,
        schedules: [{ ...retained.schedules[0], target: { type: "source", cwd: "relative" } }],
      }),
    ).toThrow("absolute");
  });

  test("handoff mutation admission checks the latest queued target before deletion", async () => {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const protectedTarget = {
      type: "new-agent" as const,
      config: { provider: "claude", cwd: join(tempDir, "protected") },
    };
    const guarded = new ScheduleStore(tempDir, createTestLogger(), {
      admitMutation: async ({ previous, next }) => {
        if (
          !next &&
          previous?.target.type === "new-agent" &&
          previous.target.config.cwd === protectedTarget.config.cwd
        )
          throw new Error("protected schedule");
        return () => {};
      },
    });
    const created = await guarded.create({
      name: null,
      prompt: "before",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [],
    });
    const update = guarded.update(created.id, async (current) => {
      entered.resolve();
      await finish.promise;
      return { ...current, target: protectedTarget };
    });
    await entered.promise;
    const deletion = expect(guarded.delete(created.id)).rejects.toThrow("protected schedule");
    finish.resolve();
    await update;
    await deletion;
    expect(await guarded.get(created.id)).toEqual({ ...created, target: protectedTarget });
    await guarded.update(created.id, (current) => ({ ...current, target: created.target }));
    await guarded.delete(created.id);
    expect(await guarded.get(created.id)).toBeNull();
  });

  test("handoff releases failed schedule publication admission and allows a repaired retry", async () => {
    const released = vi.fn();
    let obstructPublication = false;
    const guarded = new ScheduleStore(tempDir, createTestLogger(), {
      admitMutation: async ({ next }) => {
        if (obstructPublication && next) {
          const file = join(tempDir, `${next.id}.json`);
          await rm(file);
          await mkdir(file);
        }
        return released;
      },
    });
    const created = await guarded.create({
      name: null,
      prompt: "before",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [],
    });
    expect(released).toHaveBeenCalledTimes(1);
    obstructPublication = true;
    await expect(
      guarded.update(created.id, (current) => ({ ...current, prompt: "after" })),
    ).rejects.toThrow();
    expect(released).toHaveBeenCalledTimes(2);
    obstructPublication = false;
    await rm(join(tempDir, `${created.id}.json`), { recursive: true });
    await writeFile(join(tempDir, `${created.id}.json`), JSON.stringify(created));
    await guarded.update(created.id, (current) => ({ ...current, prompt: "after" }));
    expect(released).toHaveBeenCalledTimes(3);
    expect(await store.get(created.id)).toEqual({ ...created, prompt: "after" });
  });

  test("creates and reloads schedules from disk", async () => {
    const created = await store.create({
      name: "Morning summary",
      prompt: "Summarize new commits",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: tempDir,
        },
      },
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextRunAt: "2026-01-01T00:01:00.000Z",
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [],
    });

    const reloaded = new ScheduleStore(tempDir, createTestLogger());
    const listed = await reloaded.list();

    expect(created.id).toHaveLength(8);
    expect(listed).toEqual([created]);
  });

  test("reports an invalid schedule file once while it stays invalid, by name, and lists the rest", async () => {
    const created = await store.create({
      name: "Morning summary",
      prompt: "Summarize new commits",
      cadence: { type: "every", everyMs: 60_000 },
      target: { type: "new-agent", config: { provider: "claude", cwd: tempDir } },
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextRunAt: "2026-01-01T00:01:00.000Z",
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [],
    });
    await writeFile(join(tempDir, "notes.json"), JSON.stringify({ hello: "world" }));
    const logLines: Array<{ msg: string; filePath?: string }> = [];
    const logger = pino(
      { level: "error" },
      new Writable({
        write(chunk, _encoding, callback) {
          logLines.push(JSON.parse(chunk.toString("utf8")));
          callback();
        },
      }),
    );
    const reloaded = new ScheduleStore(tempDir, logger);

    expect(await reloaded.list()).toEqual([created]);
    expect(await reloaded.list()).toEqual([created]);
    await rm(join(tempDir, "notes.json"));
    expect(await reloaded.list()).toEqual([created]);
    await writeFile(join(tempDir, "notes.json"), "{ not json");
    expect(await reloaded.list()).toEqual([created]);

    const skipped = {
      msg: "Skipping invalid schedule file",
      filePath: join(tempDir, "notes.json"),
    };
    expect(logLines.map(({ msg, filePath }) => ({ msg, filePath }))).toEqual([skipped, skipped]);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "fails the listing when a schedule file cannot be read",
    async () => {
      await writeFile(join(tempDir, "unreadable.json"), "{}");
      await chmod(join(tempDir, "unreadable.json"), 0o000);

      await expect(store.list()).rejects.toMatchObject({ code: "EACCES" });
    },
  );

  test("update round-trips an updated schedule to disk", async () => {
    const created = await store.create({
      name: "before",
      prompt: "before",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextRunAt: "2026-01-01T00:01:00.000Z",
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [],
    });

    const updated = {
      ...created,
      name: "after",
      prompt: "after",
      cadence: { type: "cron" as const, expression: "0 9 * * *" },
      target: {
        type: "new-agent" as const,
        config: { provider: "codex", cwd: "/elsewhere", modeId: "full-access" },
      },
      nextRunAt: "2026-01-01T09:00:00.000Z",
      updatedAt: "2026-01-01T00:00:30.000Z",
    };
    await store.update(created.id, () => updated);

    const reloaded = await new ScheduleStore(tempDir, createTestLogger()).get(created.id);
    expect(reloaded).toEqual(updated);
  });

  test("deletes schedules from disk", async () => {
    const created = await store.create({
      name: null,
      prompt: "Check status",
      cadence: { type: "every", everyMs: 30_000 },
      target: {
        type: "new-agent",
        config: {
          provider: "claude",
          cwd: tempDir,
        },
      },
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextRunAt: "2026-01-01T00:00:30.000Z",
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [],
    });

    await store.delete(created.id);

    expect(await store.get(created.id)).toBeNull();
    expect(await store.list()).toEqual([]);
  });

  test("serializes concurrent updates on one schedule without losing writes", async () => {
    const created = await store.create({
      name: "before",
      prompt: "before",
      cadence: { type: "every", everyMs: 60_000 },
      target: {
        type: "new-agent",
        config: { provider: "claude", cwd: tempDir },
      },
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextRunAt: "2026-01-01T00:01:00.000Z",
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [],
    });

    let releaseFirstUpdate: (() => void) | null = null;
    const firstUpdateBlocked = new Promise<void>((resolve) => {
      releaseFirstUpdate = resolve;
    });
    let firstUpdaterEntered: (() => void) | null = null;
    const firstUpdaterStarted = new Promise<void>((resolve) => {
      firstUpdaterEntered = resolve;
    });
    let secondSawRunCount = -1;

    const firstUpdate = store.update(created.id, async (schedule) => {
      firstUpdaterEntered?.();
      await firstUpdateBlocked;
      return {
        ...schedule,
        runs: [
          ...schedule.runs,
          {
            id: "run-1",
            scheduledFor: "2026-01-01T00:01:00.000Z",
            startedAt: "2026-01-01T00:01:00.000Z",
            endedAt: null,
            status: "running" as const,
            agentId: null,
            output: null,
            error: null,
          },
        ],
      };
    });
    await firstUpdaterStarted;

    const secondUpdate = store.update(created.id, (schedule) => {
      secondSawRunCount = schedule.runs.length;
      return {
        ...schedule,
        prompt: "after",
      };
    });

    releaseFirstUpdate?.();
    const [, second] = await Promise.all([firstUpdate, secondUpdate]);

    expect(secondSawRunCount).toBe(1);
    expect(second).toMatchObject({
      prompt: "after",
      runs: [{ id: "run-1" }],
    });
    await expect(
      new ScheduleStore(tempDir, createTestLogger()).get(created.id),
    ).resolves.toMatchObject({
      prompt: "after",
      runs: [{ id: "run-1" }],
    });
  });

  test("revalidates a named target match after waiting for the schedule update queue", async () => {
    class GatedListScheduleStore extends ScheduleStore {
      private listGate: {
        entered: () => void;
        release: Promise<void>;
      } | null = null;

      gateNextList(gate: { entered: () => void; release: Promise<void> }): void {
        this.listGate = gate;
      }

      override async list() {
        const schedules = await super.list();
        const gate = this.listGate;
        if (gate) {
          this.listGate = null;
          gate.entered();
          await gate.release;
        }
        return schedules;
      }
    }

    const gatedStore = new GatedListScheduleStore(tempDir, createTestLogger());
    const target = {
      type: "new-agent" as const,
      config: { provider: "claude" as const, cwd: tempDir },
    };
    const created = await gatedStore.create({
      name: "race",
      prompt: "before",
      cadence: { type: "every", everyMs: 60_000 },
      target,
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      nextRunAt: "2026-01-01T00:01:00.000Z",
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      maxRuns: null,
      runs: [],
    });

    let releaseCompletion: (() => void) | null = null;
    const completionBlocked = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    let completionEntered: (() => void) | null = null;
    const completionStarted = new Promise<void>((resolve) => {
      completionEntered = resolve;
    });
    const completeOriginal = gatedStore.update(created.id, async (schedule) => {
      completionEntered?.();
      await completionBlocked;
      return {
        ...schedule,
        status: "completed" as const,
        nextRunAt: null,
        updatedAt: "2026-01-01T00:00:30.000Z",
      };
    });
    await completionStarted;

    let releaseUpsertList: (() => void) | null = null;
    const upsertListBlocked = new Promise<void>((resolve) => {
      releaseUpsertList = resolve;
    });
    let upsertListEntered: (() => void) | null = null;
    const upsertListed = new Promise<void>((resolve) => {
      upsertListEntered = resolve;
    });
    gatedStore.gateNextList({
      entered: () => upsertListEntered?.(),
      release: upsertListBlocked,
    });

    const upsert = gatedStore.upsertByNameAndTarget("race", target, {
      create: () => ({
        name: "race",
        prompt: "after",
        cadence: { type: "every", everyMs: 60_000 },
        target,
        status: "active",
        createdAt: "2026-01-01T00:01:00.000Z",
        updatedAt: "2026-01-01T00:01:00.000Z",
        nextRunAt: "2026-01-01T00:02:00.000Z",
        lastRunAt: null,
        pausedAt: null,
        expiresAt: null,
        maxRuns: null,
        runs: [],
      }),
      update: () => {
        throw new Error("stale identity match should not update");
      },
    });

    await upsertListed;
    releaseCompletion?.();
    await completeOriginal;
    releaseUpsertList?.();

    const upserted = await upsert;
    expect(upserted.id).not.toBe(created.id);
    expect(upserted).toMatchObject({
      name: "race",
      prompt: "after",
      status: "active",
    });
    await expect(gatedStore.get(created.id)).resolves.toMatchObject({
      status: "completed",
      prompt: "before",
    });
    expect(await gatedStore.list()).toHaveLength(2);
  });
});
