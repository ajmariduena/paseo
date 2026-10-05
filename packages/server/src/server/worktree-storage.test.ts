import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistedWorkspaceRecord,
  type PersistedWorkspaceRecord,
} from "./workspace-registry.js";
import {
  cleanupWorktreeStorage,
  listWorktreeStorage,
  type WorktreeStorageContext,
} from "./worktree-storage.js";
import {
  writePaseoWorktreeMetadata,
  readPaseoWorktreeMetadata,
} from "../utils/worktree-metadata.js";
import { createWorktree } from "../utils/worktree.js";

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
    add("plain");
    const archived = add("archived");
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

  it("writes server ownership on newly created Paseo worktrees", async () => {
    const created = await createWorktree({
      cwd: repo,
      worktreeSlug: "owned",
      source: { kind: "branch-off", baseBranch: "main", branchName: "owned" },
      runSetup: false,
      worktreesRoot,
      serverId: "srv-this",
    });
    expect(readPaseoWorktreeMetadata(created.worktreePath)).toMatchObject({
      version: 2,
      owner: { serverId: "srv-this" },
    });
  });
});
