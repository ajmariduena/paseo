import os from "node:os";
import path from "node:path";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  promises as fs,
} from "node:fs";

import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import { writeJsonFileAtomic } from "./atomic-file.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  resolveWorkspaceDisplayName,
  resolveWorkspaceName,
} from "./workspace-registry.js";

describe("resolveWorkspaceName", () => {
  test("prefers the user-set title over the derived display name", () => {
    expect(
      resolveWorkspaceName({ title: "Payments work", derivedDisplayName: "feature/payments" }),
    ).toBe("Payments work");
  });

  test("falls back to the derived display name when there is no title", () => {
    expect(resolveWorkspaceName({ title: null, derivedDisplayName: "feature/payments" })).toBe(
      "feature/payments",
    );
  });

  test("resolveWorkspaceDisplayName applies the same rule over the persisted record", () => {
    const record = createPersistedWorkspaceRecord({
      workspaceId: "ws-1",
      projectId: "proj-1",
      cwd: "/tmp/repo",
      kind: "local_checkout",
      displayName: "main",
      title: "Renamed",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    expect(resolveWorkspaceDisplayName(record)).toBe("Renamed");
    expect(resolveWorkspaceDisplayName({ ...record, title: null })).toBe("main");
  });
});

describe("workspace registries", () => {
  let tmpDir: string;
  let projectRegistry: FileBackedProjectRegistry;
  let workspaceRegistry: FileBackedWorkspaceRegistry;
  const logger = createTestLogger();

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "workspace-registry-"));
    projectRegistry = new FileBackedProjectRegistry(
      path.join(tmpDir, "projects", "projects.json"),
      logger,
    );
    workspaceRegistry = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test.each(["invalid JSON", "invalid record", "duplicate identity"])(
    "a registry with %s refuses reads and writes until its file is repaired",
    async (damage) => {
      const record = createPersistedWorkspaceRecord({
        workspaceId: "retained-workspace",
        projectId: "project-one",
        cwd: tmpDir,
        kind: "directory",
        displayName: "Retained work",
        createdAt: "2026-10-10T00:00:00.000Z",
        updatedAt: "2026-10-10T00:00:00.000Z",
      });
      const file = path.join(tmpDir, "projects", "workspaces.json");
      const damaged =
        damage === "invalid JSON"
          ? "[broken"
          : JSON.stringify(
              damage === "invalid record" ? [record, { workspaceId: "invalid" }] : [record, record],
            );
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, damaged);

      for (const operation of [
        () => workspaceRegistry.initialize(),
        () => workspaceRegistry.list(),
        () => workspaceRegistry.get(record.workspaceId),
        () => workspaceRegistry.upsert({ ...record, workspaceId: "replacement" }),
        () => workspaceRegistry.archive(record.workspaceId, "2026-10-11T00:00:00.000Z"),
        () => workspaceRegistry.remove(record.workspaceId),
      ]) {
        await expect(operation()).rejects.toThrow("Failed to load registry");
        expect(readFileSync(file, "utf8")).toBe(damaged);
      }

      writeFileSync(file, JSON.stringify([record]));
      expect(await workspaceRegistry.list()).toEqual([record]);
      await workspaceRegistry.update(record.workspaceId, (current) => ({
        ...current,
        title: "Recovered",
      }));
      const cold = new FileBackedWorkspaceRegistry(file, logger);
      expect(await cold.get(record.workspaceId)).toMatchObject({ title: "Recovered" });
    },
  );

  test("a failed presence check cannot describe an unreadable registry as absent", async () => {
    const error = Object.assign(new Error("Registry access denied"), { code: "EACCES" });
    vi.spyOn(fs, "access").mockRejectedValueOnce(error);
    await expect(workspaceRegistry.existsOnDisk()).rejects.toBe(error);
    expect(await workspaceRegistry.existsOnDisk()).toBe(false);
  });

  test("a project registry refuses damaged records without replacing its file", async () => {
    const file = path.join(tmpDir, "projects", "projects.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "[broken");
    await expect(projectRegistry.initialize()).rejects.toThrow("Failed to load registry");
    await expect(projectRegistry.remove("project-one")).rejects.toThrow("Failed to load registry");
    expect(readFileSync(file, "utf8")).toBe("[broken");
    writeFileSync(file, "[]");
    expect(await projectRegistry.list()).toEqual([]);
  });

  test("concurrent initial reads and mutations share one registry snapshot", async () => {
    const file = path.join(tmpDir, "projects", "workspaces.json");
    const record = createPersistedWorkspaceRecord({
      workspaceId: "workspace-one",
      projectId: "project-one",
      cwd: tmpDir,
      kind: "directory",
      displayName: "Original",
      createdAt: "2026-10-10T00:00:00.000Z",
      updatedAt: "2026-10-10T00:00:00.000Z",
    });
    await writeJsonFileAtomic(file, [record]);
    const originalRead = fs.readFile.bind(fs);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const reads = vi.spyOn(fs, "readFile").mockImplementationOnce(async (...args) => {
      const result = await originalRead(...args);
      started.resolve();
      await release.promise;
      return result;
    });
    const initial = workspaceRegistry.get(record.workspaceId);
    await started.promise;
    const update = workspaceRegistry.update(record.workspaceId, (current) => ({
      ...current,
      title: "Latest",
    }));
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(reads).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await Promise.all([initial, update]);
    }
    expect(await workspaceRegistry.get(record.workspaceId)).toMatchObject({ title: "Latest" });
    const cold = new FileBackedWorkspaceRegistry(file, logger);
    expect(await cold.get(record.workspaceId)).toMatchObject({ title: "Latest" });
  });

  test("workspace openings survive metadata edits and restart but change on restore and relocation", async () => {
    const record = createPersistedWorkspaceRecord({
      workspaceId: "opening",
      projectId: "project",
      cwd: tmpDir,
      kind: "directory",
      displayName: "Opening",
      createdAt: "2026-10-10T00:00:00Z",
      updatedAt: "2026-10-10T00:00:00Z",
    });
    await workspaceRegistry.upsert(record);
    await workspaceRegistry.update(record.workspaceId, (current) => ({
      ...current,
      title: "Renamed",
    }));
    expect((await workspaceRegistry.get(record.workspaceId))?.incarnation).toBe(record.incarnation);
    await workspaceRegistry.archive(record.workspaceId, "2026-10-10T01:00:00Z");
    expect((await workspaceRegistry.get(record.workspaceId))?.incarnation).toBe(record.incarnation);
    const restored = await workspaceRegistry.update(record.workspaceId, (current) => ({
      ...current,
      archivedAt: null,
    }));
    expect(restored?.incarnation).toEqual(expect.any(String));
    expect(restored?.incarnation).not.toBe(record.incarnation);
    const cold = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
    expect(await cold.get(record.workspaceId)).toEqual(restored);
    const relocated = await cold.update(record.workspaceId, (current) => ({
      ...current,
      cwd: path.join(tmpDir, "other"),
    }));
    expect(relocated?.incarnation).not.toBe(restored?.incarnation);
  });

  test.skipIf(process.platform === "win32")(
    "handoff retention survives stale edits until explicit archive",
    async () => {
      const record = createPersistedWorkspaceRecord({
        workspaceId: "retained",
        projectId: "project",
        cwd: tmpDir,
        kind: "directory",
        displayName: "Retained",
        createdAt: "2026-10-10T00:00:00Z",
        updatedAt: "2026-10-10T00:00:00Z",
      });
      await workspaceRegistry.upsert(record);
      const request = {
        workspaceId: record.workspaceId,
        expectedIncarnation: record.incarnation!,
        transferId: "3edce3ba-874a-428e-b940-5f493b520f19",
        retainedAt: "2026-10-10T01:00:00Z",
      };
      const retained = await workspaceRegistry.retainForHandoff(request);
      expect(retained.retention).toEqual({
        kind: "handoff",
        transferId: request.transferId,
        retainedAt: request.retainedAt,
      });
      await workspaceRegistry.archive(record.workspaceId, request.retainedAt, {
        automatic: { expectedIncarnation: record.incarnation },
      });
      expect(await workspaceRegistry.get(record.workspaceId)).toEqual(retained);
      await workspaceRegistry.upsert({ ...record, title: "Stale snapshot" });
      await workspaceRegistry.update(record.workspaceId, () => ({
        ...record,
        title: "Stale updater",
      }));
      const cold = new FileBackedWorkspaceRegistry(
        path.join(tmpDir, "projects", "workspaces.json"),
        logger,
      );
      expect(await cold.get(record.workspaceId)).toMatchObject({
        retention: retained.retention,
        title: "Stale updater",
      });
      expect(
        (await cold.retainForHandoff({ ...request, retainedAt: "2026-10-10T02:00:00Z" })).retention,
      ).toEqual(retained.retention);
      await cold.archive(record.workspaceId, "2026-10-10T03:00:00Z");
      expect((await cold.get(record.workspaceId))?.retention).toBeUndefined();
      await expect(cold.retainForHandoff(request)).rejects.toThrow("opening changed");
      // An old retained snapshot cannot reinstate the marker when reopening.
      await cold.upsert({ ...retained, archivedAt: null });
      const reopened = await cold.get(record.workspaceId);
      expect(reopened?.retention).toBeUndefined();
      expect(reopened?.incarnation).not.toBe(record.incarnation);
      await expect(cold.retainForHandoff(request)).rejects.toThrow("opening changed");
    },
  );

  test.skipIf(process.platform === "win32").each(["write", "rename", "sync"] as const)(
    "failed retention %s is repaired before another mutation can drop the protection",
    async (phase) => {
      let fail = false;
      const file = path.join(tmpDir, "projects", "workspaces.json");
      class InterruptedPublicationRegistry extends FileBackedWorkspaceRegistry {
        protected override async synchronizePublication() {
          if (fail && phase === "sync") throw new Error("retention sync failed");
          await super.synchronizePublication();
        }
      }
      const registry = new InterruptedPublicationRegistry(file, logger, {
        writeRecords: async (filePath, records) => {
          if (fail && phase === "write") throw new Error("retention write failed");
          await writeJsonFileAtomic(filePath, records);
          if (fail && phase === "rename") throw new Error("retention rename acknowledgement lost");
        },
      });
      const record = createPersistedWorkspaceRecord({
        workspaceId: "retained",
        projectId: "project",
        cwd: tmpDir,
        kind: "directory",
        displayName: "Retained",
        createdAt: "2026-10-10T00:00:00Z",
        updatedAt: "2026-10-10T00:00:00Z",
      });
      await registry.upsert(record);
      const notify = vi.fn();
      registry.subscribeToMutations(notify);
      const request = {
        workspaceId: record.workspaceId,
        expectedIncarnation: record.incarnation!,
        transferId: "3edce3ba-874a-428e-b940-5f493b520f19",
        retainedAt: "2026-10-10T01:00:00Z",
      };
      fail = true;
      await expect(registry.retainForHandoff(request)).rejects.toThrow("retention");
      await expect(registry.get(record.workspaceId)).rejects.toThrow("retention");
      await expect(registry.list()).rejects.toThrow("retention");
      await expect(registry.upsert(record)).rejects.toThrow("retention");
      await expect(registry.archive(record.workspaceId, request.retainedAt)).rejects.toThrow(
        "retention",
      );
      await expect(registry.remove(record.workspaceId)).rejects.toThrow("retention");
      expect(notify).not.toHaveBeenCalled();
      fail = false;
      await registry.update(record.workspaceId, () => ({ ...record, title: "Edit after failure" }));
      const cold = new FileBackedWorkspaceRegistry(file, logger);
      expect(await cold.get(record.workspaceId)).toMatchObject({
        archivedAt: null,
        title: "Edit after failure",
        retention: {
          kind: "handoff",
          transferId: request.transferId,
          retainedAt: request.retainedAt,
        },
      });
    },
  );

  test("creates, updates, archives, deletes, and lists project records", async () => {
    await projectRegistry.initialize();
    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/repo",
        kind: "git",
        displayName: "acme/repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/repo",
        kind: "git",
        displayName: "acme/repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      }),
    );
    await projectRegistry.archive("remote:github.com/acme/repo", "2026-03-03T00:00:00.000Z");

    const archived = await projectRegistry.get("remote:github.com/acme/repo");
    expect(archived?.archivedAt).toBe("2026-03-03T00:00:00.000Z");
    expect(await projectRegistry.list()).toHaveLength(1);

    await projectRegistry.remove("remote:github.com/acme/repo");
    expect(await projectRegistry.get("remote:github.com/acme/repo")).toBeNull();
    expect(await projectRegistry.list()).toEqual([]);
  });

  test("preserves a concurrent project update when archiving", async () => {
    let pauseNextWrite = false;
    let releaseWrite!: () => void;
    let writeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      writeStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const concurrentRegistry = new FileBackedProjectRegistry(
      path.join(tmpDir, "projects", "concurrent-projects.json"),
      logger,
      {
        writeRecords: async (filePath, records) => {
          if (pauseNextWrite) {
            pauseNextWrite = false;
            writeStarted();
            await release;
          }
          await writeJsonFileAtomic(filePath, records);
        },
      },
    );
    const project = createPersistedProjectRecord({
      projectId: "project-concurrent",
      rootPath: "/tmp/project-concurrent",
      kind: "git",
      displayName: "project-concurrent",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    await concurrentRegistry.upsert(project);
    pauseNextWrite = true;

    const update = concurrentRegistry.update(project.projectId, (current) => ({
      ...current,
      customName: "Kept name",
      updatedAt: "2026-03-02T00:00:00.000Z",
    }));
    await started;
    const archive = concurrentRegistry.archive(project.projectId, "2026-03-03T00:00:00.000Z");
    releaseWrite();
    await Promise.all([update, archive]);

    expect(await concurrentRegistry.get(project.projectId)).toMatchObject({
      customName: "Kept name",
      archivedAt: "2026-03-03T00:00:00.000Z",
    });
  });

  test("publishes only project mutations that change the persisted lifecycle", async () => {
    await projectRegistry.initialize();
    const mutations: Array<{
      kind: "upsert" | "archive" | "remove";
      projectId: string;
      project: ReturnType<typeof createPersistedProjectRecord> | null;
    }> = [];
    const unsubscribe = projectRegistry.subscribeToMutations((mutation) => {
      mutations.push(mutation);
    });
    const active = createPersistedProjectRecord({
      projectId: "project-one",
      rootPath: "/tmp/project-one",
      kind: "non_git",
      displayName: "project-one",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    const archived = {
      ...active,
      updatedAt: "2026-03-02T00:00:00.000Z",
      archivedAt: "2026-03-02T00:00:00.000Z",
    };

    await projectRegistry.upsert(active);
    await projectRegistry.archive(active.projectId, archived.archivedAt);
    await projectRegistry.archive(active.projectId, "2026-03-03T00:00:00.000Z");
    await projectRegistry.archive("project-unknown", "2026-03-03T00:00:00.000Z");
    await projectRegistry.remove(active.projectId);
    await projectRegistry.remove(active.projectId);
    await projectRegistry.remove("project-unknown");

    expect(mutations).toEqual([
      { kind: "upsert", projectId: active.projectId, project: active },
      { kind: "archive", projectId: active.projectId, project: archived },
      { kind: "remove", projectId: active.projectId, project: null },
    ]);
    unsubscribe();
  });

  test("atomically allocates one opaque project for concurrent exact-root adds", async () => {
    await projectRegistry.initialize();
    const rootPath = path.join(tmpDir, "same-root");
    const projects = await Promise.all(
      Array.from({ length: 20 }, () =>
        projectRegistry.getOrCreateActiveByRoot({
          rootPath,
          kind: "non_git",
          displayName: "same-root",
          timestamp: "2026-03-01T00:00:00.000Z",
        }),
      ),
    );

    expect(new Set(projects.map((project) => project.projectId))).toEqual(
      new Set([projects[0]!.projectId]),
    );
    expect(projects[0]!.projectId).toMatch(/^prj_[0-9a-f]{16}$/);
    expect(await projectRegistry.list()).toHaveLength(1);
  });

  test("keeps readable legacy IDs alongside newly allocated opaque IDs", async () => {
    await projectRegistry.initialize();
    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/legacy",
        kind: "git",
        displayName: "repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );
    const opaque = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: "/tmp/new",
      kind: "non_git",
      displayName: "new",
      timestamp: "2026-03-01T00:00:00.000Z",
    });
    expect((await projectRegistry.get("remote:github.com/acme/repo"))?.rootPath).toBe(
      "/tmp/legacy",
    );
    expect(opaque.projectId).toMatch(/^prj_[0-9a-f]{16}$/);
  });

  test("allocates a fresh opaque ID when only an archived exact root exists", async () => {
    await projectRegistry.initialize();
    const rootPath = path.join(tmpDir, "archived-root");
    const archived = createPersistedProjectRecord({
      projectId: "prj_archived",
      rootPath,
      kind: "non_git",
      displayName: "archived-root",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      archivedAt: "2026-03-02T00:00:00.000Z",
    });
    await projectRegistry.upsert(archived);

    const created = await projectRegistry.getOrCreateActiveByRoot({
      rootPath,
      kind: "non_git",
      displayName: "archived-root",
      timestamp: "2026-03-03T00:00:00.000Z",
    });

    expect(created).toMatchObject({ rootPath, archivedAt: null });
    expect(created.projectId).not.toBe(archived.projectId);
    expect(await projectRegistry.get(archived.projectId)).toEqual(archived);
  });

  test("refreshes the oldest active legacy duplicate kind without rewriting its identity", async () => {
    await projectRegistry.initialize();
    const rootPath = path.join(tmpDir, "legacy-root");
    const oldest = createPersistedProjectRecord({
      projectId: "remote:oldest",
      rootPath,
      kind: "git",
      displayName: "oldest",
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    const duplicate = createPersistedProjectRecord({
      projectId: "remote:duplicate",
      rootPath,
      kind: "git",
      displayName: "duplicate",
      createdAt: "2026-03-02T00:00:00.000Z",
      updatedAt: "2026-03-02T00:00:00.000Z",
    });
    await projectRegistry.upsert(oldest);
    await projectRegistry.upsert(duplicate);

    await expect(
      projectRegistry.getOrCreateActiveByRoot({
        rootPath,
        kind: "non_git",
        displayName: "new-name",
        timestamp: "2026-03-03T00:00:00.000Z",
      }),
    ).resolves.toEqual({
      ...oldest,
      kind: "non_git",
      updatedAt: "2026-03-03T00:00:00.000Z",
    });
    expect(await projectRegistry.list()).toEqual([
      { ...oldest, kind: "non_git", updatedAt: "2026-03-03T00:00:00.000Z" },
      duplicate,
    ]);
  });

  test("reuses an active project for Windows lexical-equivalent root spellings", async () => {
    await projectRegistry.initialize();
    const first = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: "C:\\Users\\Paseo\\Repo",
      kind: "git",
      displayName: "Repo",
      timestamp: "2026-03-01T00:00:00.000Z",
    });
    const second = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: "c:/users/paseo/repo/.",
      kind: "git",
      displayName: "Repo",
      timestamp: "2026-03-02T00:00:00.000Z",
    });

    expect(second).toEqual(first);
    expect(await projectRegistry.list()).toEqual([first]);
  });

  test("keeps lexical and symlink root spellings distinct without realpath", async () => {
    await projectRegistry.initialize();
    const target = path.join(tmpDir, "target");
    const link = path.join(tmpDir, "link");
    mkdirSync(target);
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");

    const targetProject = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: target,
      kind: "non_git",
      displayName: "target",
      timestamp: "2026-03-01T00:00:00.000Z",
    });
    const linkProject = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: link,
      kind: "non_git",
      displayName: "link",
      timestamp: "2026-03-02T00:00:00.000Z",
    });

    expect(linkProject.projectId).not.toBe(targetProject.projectId);
    expect(await projectRegistry.list()).toEqual([targetProject, linkProject]);
  });

  test("retries a generated project ID collision", async () => {
    const generatedIds = ["prj_collision", "prj_fresh"];
    projectRegistry = new FileBackedProjectRegistry(
      path.join(tmpDir, "projects", "projects.json"),
      logger,
      { projectIdFactory: () => generatedIds.shift() ?? "prj_unexpected" },
    );
    await projectRegistry.initialize();
    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "prj_collision",
        rootPath: path.join(tmpDir, "existing"),
        kind: "non_git",
        displayName: "existing",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    const created = await projectRegistry.getOrCreateActiveByRoot({
      rootPath: path.join(tmpDir, "new"),
      kind: "non_git",
      displayName: "new",
      timestamp: "2026-03-02T00:00:00.000Z",
    });

    expect(created.projectId).toBe("prj_fresh");
    expect(await projectRegistry.list()).toHaveLength(2);
  });

  test("project record schema accepts records without customName (legacy on-disk records)", async () => {
    await projectRegistry.initialize();

    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/tmp/repo",
        kind: "git",
        displayName: "acme/repo",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    const record = await projectRegistry.get("remote:github.com/acme/repo");
    expect(record?.customName).toBeNull();
  });

  test("project record persists a customName override", async () => {
    await projectRegistry.initialize();

    await projectRegistry.upsert(
      createPersistedProjectRecord({
        projectId: "remote:github.com/acme/repo",
        rootPath: "/home/me/work/repo",
        kind: "git",
        displayName: "acme/repo",
        customName: "Acme (work)",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    const record = await projectRegistry.get("remote:github.com/acme/repo");
    expect(record?.customName).toBe("Acme (work)");
    expect(record?.displayName).toBe("acme/repo");
  });

  test("creates, updates, archives, deletes, and lists workspace records", async () => {
    await workspaceRegistry.initialize();
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "/tmp/repo",
        projectId: "remote:github.com/acme/repo",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "/tmp/repo",
        projectId: "remote:github.com/acme/repo",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "feature/workspace",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-02T00:00:00.000Z",
      }),
    );
    await workspaceRegistry.archive("/tmp/repo", "2026-03-03T00:00:00.000Z");

    const archived = await workspaceRegistry.get("/tmp/repo");
    expect(archived?.displayName).toBe("feature/workspace");
    expect(archived?.archivedAt).toBe("2026-03-03T00:00:00.000Z");

    await workspaceRegistry.remove("/tmp/repo");
    expect(await workspaceRegistry.get("/tmp/repo")).toBeNull();
    expect(await workspaceRegistry.list()).toEqual([]);
  });

  test("refreshes workspace archive timestamps when an archive is repeated", async () => {
    await workspaceRegistry.initialize();
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "workspace-one",
        projectId: "project-one",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await workspaceRegistry.archive("workspace-one", "2026-03-02T00:00:00.000Z");
    await workspaceRegistry.archive("workspace-one", "2026-03-03T00:00:00.000Z");

    expect(await workspaceRegistry.get("workspace-one")).toMatchObject({
      archivedAt: "2026-03-03T00:00:00.000Z",
      updatedAt: "2026-03-03T00:00:00.000Z",
    });
  });

  test("persists the consumed change request with the workspace archive", async () => {
    await workspaceRegistry.initialize();
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "workspace-auto-archive",
        projectId: "project-one",
        cwd: "/tmp/repo",
        kind: "worktree",
        displayName: "feature",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await workspaceRegistry.archive("workspace-auto-archive", "2026-03-02T00:00:00.000Z", {
      autoArchivedChangeRequestUrl: "https://github.com/acme/repo/pull/123",
    });

    const reloaded = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
    await reloaded.initialize();
    expect(await reloaded.get("workspace-auto-archive")).toMatchObject({
      archivedAt: "2026-03-02T00:00:00.000Z",
      autoArchivedChangeRequestUrl: "https://github.com/acme/repo/pull/123",
    });
  });

  test("composes concurrent workspace field updates without losing either change", async () => {
    await workspaceRegistry.initialize();
    await workspaceRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "ws-1",
        projectId: "proj-1",
        cwd: "/tmp/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
    );

    await Promise.all([
      workspaceRegistry.update("ws-1", (record) => ({
        ...record,
        title: "Payments work",
        updatedAt: "2026-03-02T00:00:00.000Z",
      })),
      workspaceRegistry.update("ws-1", (record) => ({
        ...record,
        pinnedAt: "2026-03-03T00:00:00.000Z",
        updatedAt: "2026-03-03T00:00:00.000Z",
      })),
    ]);

    const reloadedRegistry = new FileBackedWorkspaceRegistry(
      path.join(tmpDir, "projects", "workspaces.json"),
      logger,
    );
    await reloadedRegistry.initialize();
    expect(await reloadedRegistry.get("ws-1")).toMatchObject({
      title: "Payments work",
      pinnedAt: "2026-03-03T00:00:00.000Z",
    });
  });
});
