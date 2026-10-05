import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPersistedWorkspaceRecord,
  type PersistedWorkspaceRecord,
} from "./workspace-registry.js";
import {
  cleanupWorktreeStorage,
  listWorktreeStorage,
  sweepOwnedArchivedWorktrees,
  type WorktreeStorageContext,
} from "./worktree-storage.js";
import {
  writePaseoWorktreeMetadata,
  readPaseoWorktreeMetadata,
} from "../utils/worktree-metadata.js";
import { createWorktree } from "../utils/worktree.js";
import { assertWorktreeNotCleaningUp, withWorktreeProjectLock } from "./worktree-use-lock.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function workspace(cwd: string, archivedAt: string | null = null): PersistedWorkspaceRecord {
  return createPersistedWorkspaceRecord({
    workspaceId: `ws-${cwd}`,
    projectId: "project",
    cwd,
    worktreeRoot: cwd,
    kind: "worktree",
    displayName: "Test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt,
  });
}

function expectCleanupReserved(path: string): void {
  expect(() => assertWorktreeNotCleaningUp(path)).toThrow("Worktree is cleaning up");
}

describe("worktree storage cleanup", () => {
  let root: string;
  let repo: string;
  let worktreesRoot: string;
  let records: PersistedWorkspaceRecord[];
  let agentCwds: string[];
  let terminalCwds: string[];
  let context: WorktreeStorageContext;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "paseo-storage-"));
    repo = join(root, "repo");
    worktreesRoot = join(root, "worktrees");
    mkdirSync(repo);
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "user.email", "test@example.invalid");
    writeFileSync(join(repo, "README.md"), "initial\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "initial");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    records = [];
    agentCwds = [];
    terminalCwds = [];
    context = {
      paseoHome: root,
      worktreesRoot,
      serverId: "srv-this",
      listWorkspaces: async () => records,
      listAgentCwds: () => agentCwds,
      listTerminalCwds: async () => terminalCwds,
    };
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function add(name: string): string {
    const projectRoot = join(worktreesRoot, "project-hash");
    mkdirSync(projectRoot, { recursive: true });
    const path = join(projectRoot, name);
    git(repo, "worktree", "add", "-b", name, path);
    return path;
  }

  it("lists plain git worktrees, archived leftovers, and each kept reason", async () => {
    const plain = add("plain");
    writePaseoWorktreeMetadata(plain, {
      baseRefName: "main",
      serverId: "srv-this",
      paseoHome: root,
    });
    const archived = add("archived");
    writePaseoWorktreeMetadata(archived, {
      baseRefName: "main",
      serverId: "srv-this",
      paseoHome: root,
    });
    records.push(workspace(archived, "2026-01-02T00:00:00.000Z"));
    const active = add("active");
    records.push(workspace(active));
    const agent = add("agent");
    agentCwds.push(agent);
    const terminal = add("terminal");
    terminalCwds.push(terminal);
    const foreign = add("foreign");
    writePaseoWorktreeMetadata(foreign, { baseRefName: "main", serverId: "srv-other" });
    const dirty = add("dirty");
    writeFileSync(join(dirty, "untracked.txt"), "keep");
    const unpushed = add("unpushed");
    writeFileSync(join(unpushed, "README.md"), "changed\n");
    git(unpushed, "add", ".");
    git(unpushed, "commit", "-m", "local");
    const invalid = join(worktreesRoot, "project-hash", "invalid");
    mkdirSync(invalid);

    const entries = (await listWorktreeStorage(context)).entries;
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    expect(byName.get("plain")).toMatchObject({ freeable: true, reason: "not a workspace" });
    expect(byName.get("archived")).toMatchObject({ freeable: true, reason: "archived" });
    expect(byName.get("active")?.reason).toBe("used by an active workspace");
    expect(byName.get("agent")?.reason).toBe("used by a live agent or terminal");
    expect(byName.get("terminal")?.reason).toBe("used by a live agent or terminal");
    expect(byName.get("foreign")?.reason).toBe("used by another Paseo host");
    expect(byName.get("dirty")?.reason).toBe("1 uncommitted change");
    expect(byName.get("unpushed")?.reason).toBe("1 unpushed commit");
    expect(byName.get("invalid")?.reason).toBe("not a git worktree");
    expect(byName.get("plain")?.sizeBytes).toBeGreaterThan(0);
    const foreignId = byName.get("foreign")?.entryId;
    expect(foreignId).toBeDefined();
    const refused = await cleanupWorktreeStorage(context, [foreignId!]);
    expect(refused).toEqual([
      { entryId: foreignId, removed: false, error: "used by another Paseo host" },
    ]);
    expect(existsSync(foreign)).toBe(true);
  });

  it("removes only a freshly freeable entry without force and keeps the branch", async () => {
    const removable = add("removable");
    writePaseoWorktreeMetadata(removable, {
      baseRefName: "main",
      serverId: "srv-this",
      paseoHome: root,
    });
    const becameDirty = add("became-dirty");
    const entries = (await listWorktreeStorage(context)).entries;
    writeFileSync(join(becameDirty, "new.txt"), "important");
    const results = await cleanupWorktreeStorage(
      context,
      entries.map((entry) => entry.entryId),
    );
    expect(results).toEqual(
      expect.arrayContaining([
        {
          entryId: entries.find((entry) => entry.name === "removable")?.entryId,
          removed: true,
          error: null,
        },
        expect.objectContaining({
          entryId: entries.find((entry) => entry.name === "became-dirty")?.entryId,
          removed: false,
          error: "1 uncommitted change",
        }),
      ]),
    );
    expect(existsSync(removable)).toBe(false);
    expect(existsSync(becameDirty)).toBe(true);
    expect(git(repo, "branch", "--list", "removable")).toContain("removable");
    expect((await cleanupWorktreeStorage(context, [entries[0]!.entryId]))[0]?.removed).toBe(false);
  });

  it("keeps a clean archived worktree when manual teardown fails, then retries", async () => {
    writeFileSync(
      join(repo, "paseo.json"),
      JSON.stringify({
        worktree: {
          teardown:
            "node -e \"process.exit(require('fs').existsSync(process.env.PASEO_SOURCE_CHECKOUT_PATH + '/ready') ? 0 : 1)\"",
        },
      }),
    );
    git(repo, "add", "paseo.json");
    git(repo, "commit", "-m", "add teardown");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    const path = add("manual-teardown");
    writePaseoWorktreeMetadata(path, {
      baseRefName: "main",
      serverId: "srv-this",
      paseoHome: root,
    });
    records.push(workspace(path, "2026-01-02T00:00:00.000Z"));
    const entry = (await listWorktreeStorage(context)).entries[0]!;
    expect(entry).toMatchObject({ freeable: true, reason: "archived" });

    const failed = await cleanupWorktreeStorage(context, [entry.entryId]);
    expect(failed[0]).toMatchObject({ removed: false });
    expect(failed[0]?.error).toContain("Worktree teardown command failed");
    expect(existsSync(path)).toBe(true);

    writeFileSync(join(repo, "ready"), "yes");
    expect((await cleanupWorktreeStorage(context, [entry.entryId]))[0]).toEqual({
      entryId: entry.entryId,
      removed: true,
      error: null,
    });
    expect(existsSync(path)).toBe(false);
  });

  it("reports when the host cannot inspect running process directories", async () => {
    const path = add("no-lsof");
    writePaseoWorktreeMetadata(path, {
      baseRefName: "main",
      serverId: "srv-this",
      paseoHome: root,
    });
    context.readProcessCwds = async () => ({ cwds: null, unavailableReason: "lsof_missing" });
    const storage = await listWorktreeStorage(context);
    expect(storage.processCheckUnavailableReason).toBe("lsof_missing");
    expect(storage.entries[0]).toMatchObject({
      freeable: false,
      reason: "Could not check running processes",
    });
  });

  it("shares an initial process reading and refreshes before each manual removal", async () => {
    for (const name of ["shared-one", "shared-two", "shared-three"]) {
      const path = add(name);
      writePaseoWorktreeMetadata(path, {
        baseRefName: "main",
        serverId: "srv-this",
        paseoHome: root,
      });
    }
    let reads = 0;
    context.readProcessCwds = async () => {
      reads += 1;
      return { cwds: [], unavailableReason: null };
    };
    context.processProbeNow = () => 1_000;
    const entryIds = (await listWorktreeStorage(context)).entries.map((entry) => entry.entryId);
    reads = 0;

    const results = await cleanupWorktreeStorage(context, entryIds);
    expect(results).toHaveLength(3);
    expect(results.every((result) => result.removed)).toBe(true);
    expect(reads).toBe(4);
  });

  it("rechecks running processes before manual removal even without teardown", async () => {
    const path = add("process-without-teardown");
    writePaseoWorktreeMetadata(path, {
      baseRefName: "main",
      serverId: "srv-this",
      paseoHome: root,
    });
    let reads = 0;
    context.readProcessCwds = async () => ({
      cwds: ++reads === 1 ? [] : [realpathSync(path)],
      unavailableReason: null,
    });
    context.processProbeNow = () => 1_000;
    const entryId = (await listWorktreeStorage(context)).entries[0]!.entryId;
    reads = 0;

    expect(await cleanupWorktreeStorage(context, [entryId])).toEqual([
      { entryId, removed: false, error: "used by a running process" },
    ]);
    expect(reads).toBe(2);
    expect(existsSync(path)).toBe(true);
  });

  it("keeps the worktree when the final process check exceeds its time budget", async () => {
    const path = add("process-check-timeout");
    writePaseoWorktreeMetadata(path, {
      baseRefName: "main",
      serverId: "srv-this",
      paseoHome: root,
    });
    let reads = 0;
    context.readProcessCwds = async () => {
      reads += 1;
      if (reads === 1) return { cwds: [], unavailableReason: null };
      return new Promise<never>(() => undefined);
    };
    context.processProbeNow = () => 1_000;
    context.processCheckTimeoutMs = 25;
    const entryId = (await listWorktreeStorage(context)).entries[0]!.entryId;
    reads = 0;

    expect(await cleanupWorktreeStorage(context, [entryId])).toEqual([
      { entryId, removed: false, error: "Could not check running processes" },
    ]);
    expect(reads).toBe(2);
    expect(existsSync(path)).toBe(true);
  });

  it("refreshes the process reading after manual teardown before removing", async () => {
    writeFileSync(
      join(repo, "paseo.json"),
      JSON.stringify({ worktree: { teardown: 'node -e "process.exit(0)"' } }),
    );
    git(repo, "add", "paseo.json");
    git(repo, "commit", "-m", "add teardown");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    const path = add("process-after-teardown");
    writePaseoWorktreeMetadata(path, {
      baseRefName: "main",
      serverId: "srv-this",
      paseoHome: root,
    });
    records.push(workspace(path, "2026-01-02T00:00:00.000Z"));
    let reads = 0;
    context.readProcessCwds = async () => ({
      cwds: ++reads === 1 ? [] : [realpathSync(path)],
      unavailableReason: null,
    });
    context.processProbeNow = () => 1_000;
    const entryId = (await listWorktreeStorage(context)).entries[0]!.entryId;
    reads = 0;

    const result = await cleanupWorktreeStorage(context, [entryId]);
    expect(result).toEqual([{ entryId, removed: false, error: "used by a running process" }]);
    expect(reads).toBe(2);
    expect(existsSync(path)).toBe(true);
  });

  it("requires explicit entry consent for an ownerless worktree", async () => {
    const path = add("legacy-manual");
    const entry = (await listWorktreeStorage(context)).entries[0]!;
    expect(entry).toMatchObject({
      freeable: false,
      requiresExplicitOptIn: true,
      reason: "Created before ownership tracking",
    });
    expect((await cleanupWorktreeStorage(context, [entry.entryId]))[0]?.removed).toBe(false);
    expect(existsSync(path)).toBe(true);
    expect(
      (await cleanupWorktreeStorage(context, [entry.entryId], [entry.entryId]))[0]?.removed,
    ).toBe(true);
  });

  it("keeps a worktree with an external process cwd inside it", async () => {
    const path = add("external-process");
    writePaseoWorktreeMetadata(path, {
      baseRefName: "main",
      serverId: "srv-this",
      paseoHome: root,
    });
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: path });
    await once(child, "spawn");
    try {
      const entry = (await listWorktreeStorage(context)).entries[0]!;
      expect(entry.reason).toBe("used by a running process");
      expect((await cleanupWorktreeStorage(context, [entry.entryId]))[0]?.removed).toBe(false);
      expect(existsSync(path)).toBe(true);
    } finally {
      child.kill();
      await once(child, "exit");
    }
  });

  it("keeps detached HEAD worktrees", async () => {
    const path = add("detached");
    writePaseoWorktreeMetadata(path, {
      baseRefName: "main",
      serverId: "srv-this",
      paseoHome: root,
    });
    git(path, "checkout", "--detach");
    const entry = (await listWorktreeStorage(context)).entries[0]!;
    expect(entry).toMatchObject({ freeable: false, reason: "Detached HEAD" });
    expect((await cleanupWorktreeStorage(context, [entry.entryId]))[0]?.removed).toBe(false);
  });

  it("rechecks live workspace use under the removal lock", async () => {
    const path = add("became-active");
    writePaseoWorktreeMetadata(path, {
      baseRefName: "main",
      serverId: "srv-this",
      paseoHome: root,
    });
    const entry = (await listWorktreeStorage(context)).entries[0]!;
    let reads = 0;
    context.listWorkspaces = async () => {
      reads += 1;
      return reads >= 2 ? [workspace(path)] : [];
    };
    const result = await cleanupWorktreeStorage(context, [entry.entryId]);
    expect(result[0]).toMatchObject({ removed: false, error: "used by an active workspace" });
    expect(existsSync(path)).toBe(true);
  });

  it("writes server ownership on newly created Paseo worktrees", async () => {
    const created = await createWorktree({
      cwd: repo,
      worktreeSlug: "owned",
      source: { kind: "branch-off", baseBranch: "main", branchName: "owned" },
      runSetup: false,
      worktreesRoot,
      paseoHome: root,
      serverId: "srv-this",
    });
    expect(readPaseoWorktreeMetadata(created.worktreePath)).toMatchObject({
      version: 2,
      owner: { serverId: "srv-this", paseoHome: root },
    });
  });

  it("automatically removes only owned archived worktrees after a fresh safety check", async () => {
    const eligible = add("eligible");
    writePaseoWorktreeMetadata(eligible, {
      baseRefName: "main",
      serverId: "srv-this",
      paseoHome: root,
    });
    records.push(workspace(eligible, "2026-01-02T00:00:00.000Z"));

    const foreign = add("foreign-auto");
    writePaseoWorktreeMetadata(foreign, { baseRefName: "main", serverId: "srv-other" });
    records.push(workspace(foreign, "2026-01-02T00:00:00.000Z"));

    const legacy = add("legacy-auto");
    records.push(workspace(legacy, "2026-01-02T00:00:00.000Z"));

    const olderOwner = add("older-owner-auto");
    writePaseoWorktreeMetadata(olderOwner, { baseRefName: "main", serverId: "srv-this" });
    records.push(workspace(olderOwner, "2026-01-02T00:00:00.000Z"));

    const clonedHome = add("cloned-home-auto");
    writePaseoWorktreeMetadata(clonedHome, {
      baseRefName: "main",
      serverId: "srv-this",
      paseoHome: join(root, "another-home"),
    });
    records.push(workspace(clonedHome, "2026-01-02T00:00:00.000Z"));

    const unknown = add("unknown-auto");
    writePaseoWorktreeMetadata(unknown, {
      baseRefName: "main",
      serverId: "srv-this",
      paseoHome: root,
    });

    const active = add("active-auto");
    writePaseoWorktreeMetadata(active, {
      baseRefName: "main",
      serverId: "srv-this",
      paseoHome: root,
    });
    records.push(workspace(active, "2026-01-02T00:00:00.000Z"));
    records.push({ ...workspace(active), workspaceId: "active-second" });

    const busy = add("busy-auto");
    writePaseoWorktreeMetadata(busy, {
      baseRefName: "main",
      serverId: "srv-this",
      paseoHome: root,
    });
    records.push(workspace(busy, "2026-01-02T00:00:00.000Z"));
    agentCwds.push(busy);

    const dirty = add("dirty-auto");
    writePaseoWorktreeMetadata(dirty, {
      baseRefName: "main",
      serverId: "srv-this",
      paseoHome: root,
    });
    records.push(workspace(dirty, "2026-01-02T00:00:00.000Z"));
    writeFileSync(join(dirty, "untracked.txt"), "keep");

    const result = await sweepOwnedArchivedWorktrees(context, () => true);
    expect(result).toMatchObject({ scanned: 9, candidates: 1, removed: 1, failures: [] });
    expect(existsSync(eligible)).toBe(false);
    for (const kept of [foreign, legacy, olderOwner, clonedHome, unknown, active, busy, dirty]) {
      expect(existsSync(kept)).toBe(true);
    }
  });

  it("retains a worktree when teardown fails and retries after it succeeds", async () => {
    writeFileSync(
      join(repo, "paseo.json"),
      JSON.stringify({
        worktree: {
          teardown:
            "node -e \"process.exit(require('fs').existsSync(process.env.PASEO_SOURCE_CHECKOUT_PATH + '/ready') ? 0 : 1)\"",
        },
      }),
    );
    git(repo, "add", "paseo.json");
    git(repo, "commit", "-m", "add teardown");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    const path = add("retry-auto");
    writePaseoWorktreeMetadata(path, {
      baseRefName: "main",
      serverId: "srv-this",
      paseoHome: root,
    });
    records.push(workspace(path, "2026-01-02T00:00:00.000Z"));

    const failed = await sweepOwnedArchivedWorktrees(context, () => true);
    expect(failed.removed).toBe(0);
    expect(failed.failures).toHaveLength(1);
    expect(existsSync(path)).toBe(true);

    writeFileSync(join(repo, "ready"), "yes");
    const retried = await sweepOwnedArchivedWorktrees(context, () => true);
    expect(retried).toMatchObject({ candidates: 1, removed: 1, failures: [] });
    expect(existsSync(path)).toBe(false);
  });

  it("rechecks Git after teardown and retains files the teardown creates", async () => {
    writeFileSync(
      join(repo, "paseo.json"),
      JSON.stringify({
        worktree: {
          teardown: "node -e \"require('fs').writeFileSync('generated.txt', 'keep')\"",
        },
      }),
    );
    git(repo, "add", "paseo.json");
    git(repo, "commit", "-m", "add teardown");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    const path = add("generated-auto");
    writePaseoWorktreeMetadata(path, {
      baseRefName: "main",
      serverId: "srv-this",
      paseoHome: root,
    });
    records.push(workspace(path, "2026-01-02T00:00:00.000Z"));

    const result = await sweepOwnedArchivedWorktrees(context, () => true);
    expect(result).toMatchObject({ candidates: 1, removed: 0 });
    expect(existsSync(join(path, "generated.txt"))).toBe(true);
  });

  it("rechecks running processes before automatic removal without teardown", async () => {
    const path = add("automatic-process-without-teardown");
    writePaseoWorktreeMetadata(path, {
      baseRefName: "main",
      serverId: "srv-this",
      paseoHome: root,
    });
    records.push(workspace(path, "2026-01-02T00:00:00.000Z"));
    let reads = 0;
    context.readProcessCwds = async () => ({
      cwds: ++reads === 1 ? [] : [realpathSync(path)],
      unavailableReason: null,
    });
    context.processProbeNow = () => 1_000;

    expect(await sweepOwnedArchivedWorktrees(context, () => true)).toMatchObject({
      candidates: 1,
      removed: 0,
      failures: [],
    });
    expect(reads).toBe(2);
    expect(existsSync(path)).toBe(true);
  });

  it("lets another project operation finish while automatic teardown waits", async () => {
    writeFileSync(
      join(repo, "paseo.json"),
      JSON.stringify({
        worktree: {
          teardown:
            "node -e \"const fs=require('fs'); const root=process.env.PASEO_SOURCE_CHECKOUT_PATH; fs.appendFileSync(root+'/teardown-started','x'); const until=Date.now()+4000; while(!fs.existsSync(root+'/project-operation-done') && Date.now()<until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25); process.exit(fs.existsSync(root+'/project-operation-done')?0:1)\"",
        },
      }),
    );
    git(repo, "add", "paseo.json");
    git(repo, "commit", "-m", "add waiting teardown");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    const path = add("teardown-waits");
    writePaseoWorktreeMetadata(path, {
      baseRefName: "main",
      serverId: "srv-this",
      paseoHome: root,
    });
    records.push(workspace(path, "2026-01-02T00:00:00.000Z"));
    const entryId = (await listWorktreeStorage(context)).entries[0]!.entryId;

    const sweep = sweepOwnedArchivedWorktrees(context, () => true);
    await vi.waitFor(() => expect(existsSync(join(repo, "teardown-started"))).toBe(true), {
      timeout: 3_000,
    });
    expect(await cleanupWorktreeStorage(context, [entryId])).toEqual([
      { entryId, removed: false, error: "Worktree is cleaning up" },
    ]);
    await withWorktreeProjectLock(dirname(path), async () => {
      expectCleanupReserved(path);
      writeFileSync(join(repo, "project-operation-done"), "yes");
    });
    expect(await sweep).toMatchObject({ candidates: 1, removed: 1, failures: [] });
    expect(readFileSync(join(repo, "teardown-started"), "utf8")).toBe("x");
    expect(existsSync(path)).toBe(false);
  });

  it("does nothing while automatic cleanup is disabled", async () => {
    const path = add("disabled-auto");
    writePaseoWorktreeMetadata(path, {
      baseRefName: "main",
      serverId: "srv-this",
      paseoHome: root,
    });
    records.push(workspace(path, "2026-01-02T00:00:00.000Z"));
    const result = await sweepOwnedArchivedWorktrees(context, () => false);
    expect(result.removed).toBe(0);
    expect(existsSync(path)).toBe(true);
  });
});
