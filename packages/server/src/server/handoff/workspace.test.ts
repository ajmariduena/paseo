import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
  lstat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  captureWorkspace,
  restoreWorkspace,
  restoreWorkspaceArchive,
  verifyCapturedWorkspace,
  WORKSPACE_SNAPSHOT_LIMITS,
  previewWorkspace,
  listWorkspaceOmissions,
  packWorkspaceArchive,
  verifyWorkspaceArchive,
} from "./workspace.js";
import { HandoffArchiveStore } from "./archive.js";
import { parseGitRemoteLocation } from "@getpaseo/protocol/git-remote";
import { createForgeResolver } from "../../services/forge-resolver.js";

const exec = promisify(execFile);
let root: string;
let source: string;
let artifact: string;
let destination: string;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await exec("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Handoff Test",
      GIT_AUTHOR_EMAIL: "handoff@example.com",
      GIT_COMMITTER_NAME: "Handoff Test",
      GIT_COMMITTER_EMAIL: "handoff@example.com",
    },
  });
  return result.stdout;
}

async function verifyRestoredWorkspace(): Promise<void> {
  const store = new HandoffArchiveStore(path.join(root, "archives"));
  const transferId = randomUUID();
  await packWorkspaceArchive({ store, transferId, artifactDirectory: artifact });
  await verifyWorkspaceArchive({ store, transferId, cwd: destination });
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "paseo-handoff-workspace-")));
  source = path.join(root, "source");
  artifact = path.join(root, "artifact");
  destination = path.join(root, "destination");
  await mkdir(source);
  await git(source, "init", "--initial-branch=work");
  await writeFile(path.join(source, "tracked.txt"), "committed\n");
  await writeFile(path.join(source, ".gitignore"), "ignored/\n.env\n");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "Initial local commit");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

test("preserves other branches, annotated tags, notes and symbolic remote references", async () => {
  await git(source, "branch", "topic");
  await git(source, "tag", "-a", "release", "-m", "Release annotation");
  await git(source, "tag", "work");
  await git(source, "notes", "add", "-m", "Review note");
  const commit = (await git(source, "rev-parse", "HEAD")).trim();
  await git(source, "update-ref", "refs/remotes/origin/work", commit);
  await git(source, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/work");
  const refs = await git(source, "for-each-ref", "--format=%(refname) %(objectname) %(symref)");
  await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  await restoreWorkspace({ artifactDirectory: artifact, destination });
  expect(
    await git(destination, "for-each-ref", "--format=%(refname) %(objectname) %(symref)"),
  ).toBe(refs);
  expect(await git(destination, "notes", "show")).toBe("Review note\n");
  expect(await git(destination, "cat-file", "-t", "release")).toBe("tag\n");
  await verifyRestoredWorkspace();
});

test("preserves upstreams, custom fetch refspecs and explicit push policy", async () => {
  await git(source, "remote", "add", "origin", "https://github.com/org/repo.git");
  await git(source, "remote", "add", "publish", "git@github.com:me/repo.git");
  await git(source, "config", "--unset-all", "remote.origin.fetch");
  await git(
    source,
    "config",
    "--add",
    "remote.origin.fetch",
    "+refs/heads/*:refs/remotes/origin/team/*",
  );
  await git(source, "config", "--add", "remote.origin.fetch", "^refs/heads/private/*");
  await git(source, "config", "--add", "remote.publish.push", "refs/heads/work:refs/heads/review");
  await git(source, "config", "branch.work.remote", "origin");
  await git(source, "config", "branch.work.merge", "refs/heads/work");
  await git(source, "config", "branch.work.pushRemote", "publish");
  await git(source, "config", "branch.work.rebase", "merges");
  await git(source, "config", "remote.pushDefault", "publish");
  await git(source, "config", "push.default", "nothing");
  const head = (await git(source, "rev-parse", "HEAD")).trim();
  await git(source, "update-ref", "refs/remotes/origin/team/work", head);
  await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  await restoreWorkspace({ artifactDirectory: artifact, destination });
  expect(await git(destination, "rev-parse", "--symbolic-full-name", "@{upstream}")).toBe(
    "refs/remotes/origin/team/work\n",
  );
  const pattern =
    "^(branch\\..*\\.(remote|merge|pushremote|rebase)|remote\\..*\\.(fetch|push)|remote\\.pushdefault|push\\.default)$";
  expect((await git(destination, "config", "--get-regexp", pattern)).split("\n").sort()).toEqual(
    (await git(source, "config", "--get-regexp", pattern)).split("\n").sort(),
  );
  expect(await git(destination, "config", "--get-all", "remote.origin.fetch")).toBe(
    "+refs/heads/*:refs/remotes/origin/team/*\n^refs/heads/private/*\n",
  );
  await verifyRestoredWorkspace();
  const origin = path.join(root, "origin.git");
  const publish = path.join(root, "publish.git");
  await git(root, "clone", "--bare", source, origin);
  await git(root, "init", "--bare", publish);
  await git(origin, "branch", "topic");
  await git(origin, "branch", "private/secret");
  // Exercise the installed policy against local bare repositories, without forge credentials.
  await git(
    destination,
    "-c",
    `url.${pathToFileURL(origin).href}.insteadOf=https://github.com/org/repo.git`,
    "fetch",
    "origin",
  );
  expect(await git(destination, "rev-parse", "refs/remotes/origin/team/topic")).toBe(`${head}\n`);
  expect(await git(destination, "for-each-ref", "refs/remotes/origin/team/private")).toBe("");
  await git(
    destination,
    "-c",
    `url.${pathToFileURL(publish).href}.insteadOf=git@github.com:me/repo.git`,
    "push",
  );
  expect(await git(publish, "rev-parse", "refs/heads/review")).toBe(`${head}\n`);
});

test.each(["unborn", "detached"])("preserves references with a %s HEAD", async (kind) => {
  const original = (await git(source, "rev-parse", "HEAD")).trim();
  if (kind === "unborn") await git(source, "symbolic-ref", "HEAD", "refs/heads/unborn");
  else {
    await git(source, "checkout", "--detach");
    await writeFile(path.join(source, "detached.txt"), "Detached commit\n");
    await git(source, "add", "detached.txt");
    await git(source, "commit", "-m", "Detached only");
  }
  const blob = (await git(source, "rev-parse", `${original}:tracked.txt`)).trim();
  await git(source, "tag", "blob-tag", blob);
  const manifest = await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  await restoreWorkspace({ artifactDirectory: artifact, destination });
  expect(await git(destination, "rev-parse", "refs/heads/work")).toBe(`${original}\n`);
  expect(await git(destination, "cat-file", "-t", "blob-tag")).toBe("blob\n");
  expect(manifest.git?.bundle?.size).toBeGreaterThan(0);
  await verifyRestoredWorkspace();
});

test("preserves the absence of a fetch mapping and a local branch upstream", async () => {
  await git(source, "branch", "base");
  await git(source, "branch", "--set-upstream-to=base");
  await git(source, "remote", "add", "origin", "https://github.com/org/repo.git");
  await git(source, "config", "--unset-all", "remote.origin.fetch");
  await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  await restoreWorkspace({ artifactDirectory: artifact, destination });
  expect(await git(destination, "rev-parse", "--symbolic-full-name", "@{upstream}")).toBe(
    "refs/heads/base\n",
  );
  await expect(
    git(destination, "config", "--get-all", "remote.origin.fetch"),
  ).rejects.toMatchObject({ code: 1 });
  await verifyRestoredWorkspace();
});

test("binds non-HEAD references and tracking policy to review and release", async () => {
  const review = await previewWorkspace({ cwd: source, scratchParent: root });
  await git(source, "tag", "after-review");
  await expect(
    captureWorkspace({
      cwd: source,
      artifactDirectory: artifact,
      expectedReviewDigest: review.reviewDigest,
    }),
  ).rejects.toMatchObject({ code: "review_changed" });
  await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  await git(source, "config", "push.default", "matching");
  await expect(
    verifyCapturedWorkspace({ cwd: source, artifactDirectory: artifact }),
  ).rejects.toMatchObject({ code: "source_changed" });
  await git(source, "config", "--unset", "push.default");
  await git(source, "tag", "-d", "after-review");
  await expect(
    verifyCapturedWorkspace({ cwd: source, artifactDirectory: artifact }),
  ).rejects.toMatchObject({ code: "source_changed" });
});

test.each(["stash", "replace", "custom", "dangling", "cycle"])(
  "refuses unsupported %s reference state during preflight",
  async (kind) => {
    const head = (await git(source, "rev-parse", "HEAD")).trim();
    if (kind === "stash") {
      await writeFile(path.join(source, "tracked.txt"), "Stashed\n");
      await git(source, "stash", "push");
    } else if (kind === "dangling")
      await git(source, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/missing");
    else if (kind === "cycle") {
      await git(source, "symbolic-ref", "refs/remotes/a", "refs/remotes/b");
      await git(source, "symbolic-ref", "refs/remotes/b", "refs/remotes/a");
    } else await git(source, "update-ref", `refs/${kind}/saved`, head);
    await expect(previewWorkspace({ cwd: source, scratchParent: root })).rejects.toMatchObject({
      code: "unsupported_workspace",
    });
    await expect(lstat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.each([
  ["branch.work.remote", "https://PRIVATE_TOKEN@host/repo"],
  ["branch.work.mergeoptions", "--strategy=PRIVATE_COMMAND"],
  ["remote.origin.mirror", "true"],
  ["remote.origin.fetch", "+refs/heads/*:../../outside"],
])("refuses unsupported tracking without exporting its value: %s", async (key, value) => {
  await git(source, "remote", "add", "origin", "https://github.com/org/repo.git");
  await git(source, "config", key, value);
  const error = await previewWorkspace({ cwd: source, scratchParent: root }).catch(
    (reason: unknown) => reason,
  );
  expect(error).toMatchObject({ code: "unsupported_workspace" });
  expect(String(error)).not.toContain("PRIVATE_");
});

test.each([
  "different-oid",
  "missing-ref",
  "symbolic-cycle",
  "config-command",
  "config-url",
  "new-version",
])("rejects inconsistent Git metadata on receipt: %s", async (kind) => {
  await git(source, "tag", "saved");
  await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  const file = path.join(artifact, "manifest.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  if (kind === "different-oid") manifest.git.references[1].oid = "a".repeat(40);
  else if (kind === "missing-ref") manifest.git.references.pop();
  else if (kind === "symbolic-cycle")
    manifest.git.references[1].target = manifest.git.references[1].name;
  else if (kind === "new-version") manifest.version = 3;
  else
    manifest.git.tracking.push({
      key: kind === "config-command" ? "core.sshcommand" : "branch.work.remote",
      values: ["PRIVATE_COMMAND"],
    });
  await writeFile(file, JSON.stringify(manifest));
  await expect(
    restoreWorkspace({ artifactDirectory: artifact, destination }),
  ).rejects.toMatchObject({ code: "invalid_artifact" });
  await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
});

test("reads a legacy HEAD-only workspace archive", async () => {
  await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  const file = path.join(artifact, "manifest.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  manifest.version = 1;
  delete manifest.git.references;
  delete manifest.git.tracking;
  delete manifest.git.remotes;
  await writeFile(file, JSON.stringify(manifest));
  await restoreWorkspace({ artifactDirectory: artifact, destination });
  expect(await git(destination, "rev-parse", "HEAD")).toBe(await git(source, "rev-parse", "HEAD"));
  await verifyRestoredWorkspace();
});

test("preserves the exact remote SSH path when removing a password", async () => {
  await git(
    source,
    "remote",
    "add",
    "origin",
    "ssh://git:PRIVATE_PASSWORD@example.com/link/../repo.git",
  );
  const manifest = await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  expect(JSON.stringify(manifest)).not.toContain("PRIVATE_PASSWORD");
  await restoreWorkspace({ artifactDirectory: artifact, destination });
  expect(await git(destination, "remote", "get-url", "origin")).toBe(
    "ssh://git@example.com/link/../repo.git\n",
  );
  await verifyRestoredWorkspace();
});

test("verifies installed remotes and tracking without importing destination host policy", async () => {
  const sourceConfig = path.join(root, "source.gitconfig");
  await writeFile(sourceConfig, "[pull]\n\trebase = false\n");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_GLOBAL", sourceConfig);
  await git(source, "remote", "add", "origin", "https://github.com/org/repo.git");
  const manifest = await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  expect(manifest).toMatchObject({
    version: 2,
    git: { tracking: expect.arrayContaining([{ key: "pull.rebase", values: ["false"] }]) },
  });
  const store = new HandoffArchiveStore(path.join(root, "archives"));
  const transferId = randomUUID();
  await packWorkspaceArchive({ store, transferId, artifactDirectory: artifact });
  const config = path.join(root, "destination.gitconfig");
  await writeFile(
    config,
    '[url "ssh://git@github.com/"]\n\tinsteadOf = https://github.com/\n[pull]\n\trebase = true\n',
  );
  vi.stubEnv("GIT_CONFIG_GLOBAL", config);
  await restoreWorkspaceArchive({ store, transferId, destination });
  expect(
    (await exec("git", ["remote", "get-url", "origin"], { cwd: destination, env: process.env }))
      .stdout,
  ).toBe("ssh://git@github.com/org/repo.git\n");
  await verifyWorkspaceArchive({ store, transferId, cwd: destination });
  expect(await git(destination, "config", "--local", "--get", "remote.origin.url")).toBe(
    "https://github.com/org/repo.git\n",
  );
  expect(await git(destination, "config", "--local", "--get-all", "pull.rebase")).toBe("false\n");
  await git(destination, "config", "pull.rebase", "true");
  await expect(
    verifyWorkspaceArchive({ store, transferId, cwd: destination }),
  ).rejects.toMatchObject({
    code: "source_changed",
  });
});

test("preserves effective fetch and push remotes without transferring credentials or host config", async () => {
  await git(source, "remote", "add", "origin", "team:org/repo.git");
  await git(source, "config", "url.https://PRIVATE_TOKEN@github.com/.insteadOf", "team:");
  await git(
    source,
    "remote",
    "set-url",
    "--add",
    "origin",
    "https://user:PRIVATE_PASSWORD@backup.example/org/repo.git",
  );
  await git(
    source,
    "remote",
    "set-url",
    "--push",
    "origin",
    "ssh://git:PRIVATE_SSH_PASSWORD@github.com:2222/org/repo.git",
  );
  await git(source, "remote", "add", "upstream", "git@gitlab.com:org/repo.git");
  await git(source, "config", "credential.helper", "!PRIVATE_HELPER");
  await git(source, "config", "core.sshCommand", "PRIVATE_COMMAND");
  const manifest = await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  expect(JSON.stringify(manifest)).not.toContain("PRIVATE_");
  await restoreWorkspace({ artifactDirectory: artifact, destination });
  expect(await git(destination, "remote", "get-url", "--all", "origin")).toBe(
    "https://github.com/org/repo.git\nhttps://backup.example/org/repo.git\n",
  );
  expect(await git(destination, "remote", "get-url", "--push", "--all", "origin")).toBe(
    "ssh://git@github.com:2222/org/repo.git\n",
  );
  expect(await git(destination, "remote", "get-url", "upstream")).toBe(
    "git@gitlab.com:org/repo.git\n",
  );
  expect(
    parseGitRemoteLocation(await git(destination, "remote", "get-url", "origin")),
  ).toMatchObject({
    host: "github.com",
    path: "org/repo",
    transport: "https",
  });
  const config = await readFile(path.join(destination, ".git", "config"), "utf8");
  expect(config).not.toContain("PRIVATE_");
  expect(config).not.toContain("insteadOf");
  expect(config).not.toContain("credential");
  expect(config).not.toContain("sshCommand");
  const resolver = createForgeResolver({
    resolveRemoteUrl: (cwd) => git(cwd, "remote", "get-url", "origin"),
  });
  await expect(resolver.resolve(destination)).resolves.toMatchObject({
    forge: "github",
    host: "github.com",
  });
  await verifyCapturedWorkspace({ cwd: source, artifactDirectory: artifact });
  await verifyRestoredWorkspace();
  await git(destination, "remote", "set-url", "upstream", "git@gitlab.com:other/repo.git");
  expect(await git(destination, "remote", "get-url", "--push", "upstream")).toBe(
    "git@gitlab.com:other/repo.git\n",
  );
  await expect(verifyRestoredWorkspace()).rejects.toMatchObject({ code: "source_changed" });
});

test("retains a pushInsteadOf destination and binds reviewed remote changes without binding credentials", async () => {
  await git(source, "remote", "add", "origin", "https://FIRST_SECRET@github.com/org/repo.git");
  const preview = await previewWorkspace({ cwd: source, scratchParent: root });
  await git(source, "remote", "set-url", "origin", "https://SECOND_SECRET@github.com/org/repo.git");
  expect((await previewWorkspace({ cwd: source, scratchParent: root })).reviewDigest).toBe(
    preview.reviewDigest,
  );
  await git(
    source,
    "config",
    "url.git@github.com:.pushInsteadOf",
    "https://SECOND_SECRET@github.com/",
  );
  await expect(
    captureWorkspace({
      cwd: source,
      artifactDirectory: artifact,
      expectedReviewDigest: preview.reviewDigest,
    }),
  ).rejects.toMatchObject({ code: "review_changed" });
  const refreshed = await previewWorkspace({ cwd: source, scratchParent: root });
  await captureWorkspace({
    cwd: source,
    artifactDirectory: artifact,
    expectedReviewDigest: refreshed.reviewDigest,
  });
  await restoreWorkspace({ artifactDirectory: artifact, destination });
  expect(await git(destination, "remote", "get-url", "origin")).toBe(
    "https://github.com/org/repo.git\n",
  );
  expect(await git(destination, "remote", "get-url", "--push", "origin")).toBe(
    "git@github.com:org/repo.git\n",
  );
  await verifyRestoredWorkspace();
  await git(source, "remote", "set-url", "origin", "https://github.com/other/repo.git");
  await expect(
    verifyCapturedWorkspace({ cwd: source, artifactDirectory: artifact }),
  ).rejects.toMatchObject({ code: "source_changed" });
});

test.each(["linked", "unborn"])("preserves remote URLs in a %s Git workspace", async (kind) => {
  let cwd = source;
  if (kind === "linked") {
    cwd = path.join(root, "linked");
    await git(source, "worktree", "add", "-b", "linked", cwd);
  } else {
    await rm(path.join(source, ".git"), { recursive: true });
    await git(source, "init", "--initial-branch=new");
    await git(source, "add", "tracked.txt");
  }
  await git(cwd, "remote", "add", "origin", "ssh://git@[2001:db8::1]:2222/org/repo.git");
  await captureWorkspace({ cwd, artifactDirectory: artifact });
  await restoreWorkspace({ artifactDirectory: artifact, destination });
  expect(await git(destination, "remote", "get-url", "origin")).toBe(
    "ssh://git@[2001:db8::1]:2222/org/repo.git\n",
  );
  await verifyRestoredWorkspace();
});

test.each([
  "/host/PRIVATE_LOCAL_PATH",
  "file:///host/PRIVATE_LOCAL_PATH",
  "C:/PRIVATE_LOCAL_PATH",
  "ext::PRIVATE_COMMAND",
  "helper://PRIVATE_TOKEN/repo",
  "https://github.com/repo?PRIVATE_TOKEN=secret",
  "https://github.com/repo#PRIVATE_TOKEN",
  "https://github.com/repo\nPRIVATE_TOKEN",
  "user:PRIVATE_PASSWORD@host:repo",
])("refuses a nonportable remote before capture: %s", async (url) => {
  await git(source, "remote", "add", "origin", url);
  const error = await previewWorkspace({ cwd: source, scratchParent: root }).then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toMatchObject({ code: "unsupported_workspace" });
  expect(String(error)).not.toContain("PRIVATE_");
  await expect(lstat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each([["origin", "ORIGIN"], ["../outside"], ["origin\nother"]])(
  "rejects colliding or nonportable remote names in a manifest: %j",
  async (...names) => {
    await captureWorkspace({ cwd: source, artifactDirectory: artifact });
    const manifestPath = path.join(artifact, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.git.remotes = names.map((name) => ({
      name,
      fetchUrls: ["https://github.com/org/repo.git"],
      pushUrls: null,
    }));
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(
      restoreWorkspace({ artifactDirectory: artifact, destination }),
    ).rejects.toMatchObject({ code: "invalid_artifact" });
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("rejects an oversized remote URL list before capture and on receipt", async () => {
  await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  for (let index = 0; index < 17; index++)
    await git(
      source,
      "config",
      "--add",
      "remote.origin.url",
      `https://github.com/org/repo${index}.git`,
    );
  await expect(previewWorkspace({ cwd: source, scratchParent: root })).rejects.toMatchObject({
    code: "unsupported_workspace",
  });
  const manifestPath = path.join(artifact, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.git.remotes = [
    {
      name: "origin",
      fetchUrls: Array(17).fill("https://github.com/org/repo.git"),
      pushUrls: null,
    },
  ];
  await writeFile(manifestPath, JSON.stringify(manifest));
  await expect(
    restoreWorkspace({ artifactDirectory: artifact, destination }),
  ).rejects.toMatchObject({ code: "invalid_artifact" });
  await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each([
  "https://PRIVATE_TOKEN@github.com/org/repo.git",
  "ext::PRIVATE_COMMAND",
  "file:///PRIVATE_PATH",
])(
  "rejects an unsafe remote in an incoming manifest before creating the checkout: %s",
  async (url) => {
    await captureWorkspace({ cwd: source, artifactDirectory: artifact });
    const manifestPath = path.join(artifact, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.git.remotes = [{ name: "origin", fetchUrls: [url], pushUrls: null }];
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(
      restoreWorkspace({ artifactDirectory: artifact, destination }),
    ).rejects.toMatchObject({ code: "invalid_artifact" });
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test.each(["git", "directory"])(
  "pages every reviewed exclusion for a %s workspace and rejects a changed review",
  async (kind) => {
    if (kind === "directory") await rm(path.join(source, ".git"), { recursive: true });
    await writeFile(path.join(source, ".gitignore"), ".env*\nignored/\n");
    const paths = Array.from(
      { length: 103 },
      (_, index) => `.env.${String(index).padStart(3, "0")}`,
    );
    for (const entry of paths) await writeFile(path.join(source, entry), "excluded bytes");
    await mkdir(path.join(source, "ignored"));
    await writeFile(path.join(source, "ignored", "nested.txt"), "excluded child");
    paths.push("ignored/");
    const preview = await previewWorkspace({ cwd: source, scratchParent: root });
    expect(preview.omittedPaths).toEqual(paths.slice(0, 50));
    const input = { cwd: source, scratchParent: root, reviewDigest: preview.reviewDigest };
    const pages = [];
    for (const offset of [0, 50, 100])
      pages.push(await listWorkspaceOmissions({ ...input, offset }));
    expect(pages.map((page) => page.nextOffset)).toEqual([50, 100, null]);
    expect(pages.map((page) => page.total)).toEqual([104, 104, 104]);
    expect(pages.flatMap((page) => page.paths)).toEqual(paths);
    expect(await listWorkspaceOmissions({ ...input, offset: 50 })).toEqual(pages[1]);
    await expect(listWorkspaceOmissions({ ...input, offset: 105 })).rejects.toMatchObject({
      code: "invalid_artifact",
    });
    await rename(path.join(source, ".env.102"), path.join(source, ".env.103"));
    await expect(listWorkspaceOmissions({ ...input, offset: 100 })).rejects.toMatchObject({
      code: "review_changed",
    });
  },
);

test.each(["git", "directory"])(
  "binds the reviewed included and omitted paths before capturing a %s workspace",
  async (kind) => {
    if (kind === "directory") await rm(path.join(source, ".git"), { recursive: true });
    await writeFile(path.join(source, ".env"), "PRIVATE_VALUE=do-not-export\n");
    const reviewed = await previewWorkspace({ cwd: source, scratchParent: root });
    await writeFile(path.join(source, ".gitignore"), "ignored/\n");
    await expect(
      captureWorkspace({
        cwd: source,
        artifactDirectory: path.join(root, "capture"),
        expectedReviewDigest: reviewed.reviewDigest,
      }),
    ).rejects.toMatchObject({ code: "review_changed" });
    await expect(lstat(path.join(root, "capture"))).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("keeps ordinary working edits in the reviewed boundary but detects changed omissions beyond the sample", async () => {
  await writeFile(path.join(source, ".gitignore"), ".env*\n");
  for (let index = 0; index < 51; index++)
    await writeFile(path.join(source, `.env.${String(index).padStart(2, "0")}`), "ignored");
  const reviewed = await previewWorkspace({ cwd: source, scratchParent: root });
  await writeFile(path.join(source, "tracked.txt"), "latest saved buffer\n");
  expect((await previewWorkspace({ cwd: source, scratchParent: root })).reviewDigest).toBe(
    reviewed.reviewDigest,
  );
  await captureWorkspace({
    cwd: source,
    artifactDirectory: artifact,
    expectedReviewDigest: reviewed.reviewDigest,
  });
  await restoreWorkspace({ artifactDirectory: artifact, destination });
  expect(await readFile(path.join(destination, "tracked.txt"), "utf8")).toBe(
    "latest saved buffer\n",
  );
  await rename(path.join(source, ".env.50"), path.join(source, ".env.51"));
  const changed = await previewWorkspace({ cwd: source, scratchParent: root });
  expect(changed.omittedPaths).toEqual(reviewed.omittedPaths);
  expect(changed.omittedPathCount).toBe(reviewed.omittedPathCount);
  expect(changed.reviewDigest).not.toBe(reviewed.reviewDigest);
  await expect(
    verifyCapturedWorkspace({
      cwd: source,
      artifactDirectory: artifact,
      expectedReviewDigest: reviewed.reviewDigest,
    }),
  ).rejects.toMatchObject({ code: "review_changed" });
});

test("rejects a same-count included file rename after review", async () => {
  await writeFile(path.join(source, "new.txt"), "new");
  const reviewed = await previewWorkspace({ cwd: source, scratchParent: root });
  await rename(path.join(source, "new.txt"), path.join(source, "renamed.txt"));
  const changed = await previewWorkspace({ cwd: source, scratchParent: root });
  expect(changed.fileCount).toBe(reviewed.fileCount);
  expect(changed.fileBytes).toBe(reviewed.fileBytes);
  await expect(
    captureWorkspace({
      cwd: source,
      artifactDirectory: artifact,
      expectedReviewDigest: reviewed.reviewDigest,
    }),
  ).rejects.toMatchObject({ code: "review_changed" });
});

test("reviews directory bytes and omitted paths without changing the workspace", async () => {
  await rm(path.join(source, ".git"), { recursive: true });
  await mkdir(path.join(source, "empty"));
  await mkdir(path.join(source, "ignored"));
  await writeFile(path.join(source, "ignored", "local-cache"), "not transferred");
  await writeFile(path.join(source, ".env"), "LOCAL_SECRET=not-transferred\n");
  const before = await readdir(source);
  expect(await previewWorkspace({ cwd: source, scratchParent: root })).toEqual({
    kind: "directory",
    fileCount: 2,
    directoryCount: 1,
    symlinkCount: 0,
    fileBytes: Buffer.byteLength("committed\nignored/\n.env\n"),
    gitHistoryBytes: 0,
    omittedPaths: [".env", "ignored/"],
    omittedPathCount: 2,
    reviewDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(await readdir(source)).toEqual(before);
  await expect(lstat(path.join(source, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(source, ".env"), "utf8")).toBe("LOCAL_SECRET=not-transferred\n");
  expect((await readdir(root)).sort()).toEqual(["source"]);
});

test("reviews Git data using transfer ignore rules and bounds the omitted-path sample", async () => {
  await writeFile(path.join(source, ".gitignore"), "ignored/\n.env*\n");
  await writeFile(path.join(source, ".env"), "tracked secret stays tracked\n");
  await git(source, "add", "--force", ".env");
  await mkdir(path.join(source, "ignored"));
  await writeFile(path.join(source, "ignored", "cache"), "not transferred");
  for (let index = 0; index < 51; index++)
    await writeFile(path.join(source, `.env.${String(index).padStart(2, "0")}`), "not transferred");
  const before = await git(source, "status", "--porcelain=v1", "-z");
  const preview = await previewWorkspace({ cwd: source, scratchParent: root });
  expect(preview).toMatchObject({
    kind: "git",
    fileCount: 3,
    directoryCount: 0,
    symlinkCount: 0,
    fileBytes: Buffer.byteLength("committed\nignored/\n.env*\ntracked secret stays tracked\n"),
    omittedPathCount: 52,
    omittedPaths: Array.from(
      { length: 50 },
      (_, index) => `.env.${String(index).padStart(2, "0")}`,
    ),
  });
  expect(preview.gitHistoryBytes).toBeGreaterThan(0);
  expect(await git(source, "status", "--porcelain=v1", "-z")).toBe(before);
  const capture = await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  expect(capture.files.map((file) => file.path)).toEqual([".env", ".gitignore", "tracked.txt"]);
});

test("moves a non-Git directory with local ignores and empty directories without creating a repository", async () => {
  await rm(path.join(source, ".git"), { recursive: true });
  await mkdir(path.join(source, "empty"));
  await mkdir(path.join(source, "nested"));
  await mkdir(path.join(source, "ignored"));
  const binary = Buffer.from([0, 255, 13, 10, 128]);
  await writeFile(path.join(source, "nested", "file.bin"), binary);
  await writeFile(path.join(source, "ignored", "local-cache"), "not transferred");
  await writeFile(path.join(source, ".env"), "LOCAL_SECRET=not-transferred\n");

  const manifest = await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  expect(manifest.git).toBeNull();
  await verifyCapturedWorkspace({ cwd: source, artifactDirectory: artifact });
  await restoreWorkspace({ artifactDirectory: artifact, destination });

  expect(await readFile(path.join(destination, "tracked.txt"), "utf8")).toBe("committed\n");
  expect(await readFile(path.join(destination, "nested", "file.bin"))).toEqual(binary);
  expect((await lstat(path.join(destination, "empty"))).isDirectory()).toBe(true);
  await expect(lstat(path.join(destination, "ignored"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(path.join(destination, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(path.join(destination, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(lstat(path.join(source, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(path.join(source, "nested", "file.bin"))).toEqual(binary);
});

test("restores an entirely empty non-Git workspace", async () => {
  await rm(source, { recursive: true });
  await mkdir(source);
  expect(await captureWorkspace({ cwd: source, artifactDirectory: artifact })).toEqual({
    version: 2,
    git: null,
    files: [],
  });
  await verifyCapturedWorkspace({ cwd: source, artifactDirectory: artifact });
  await restoreWorkspace({ artifactDirectory: artifact, destination });
  expect(await readdir(destination)).toEqual([]);
});

test("honors nested ignore rules and negation in a non-Git workspace", async () => {
  await rm(path.join(source, ".git"), { recursive: true });
  await writeFile(path.join(source, ".gitignore"), "cache/\n*.log\n!keep.log\n");
  await mkdir(path.join(source, "cache"));
  await mkdir(path.join(source, "nested"));
  await writeFile(path.join(source, "nested", ".gitignore"), "*.tmp\n!keep.tmp\n");
  for (const name of ["drop.log", "keep.log", "drop.tmp", "keep.tmp"]) {
    await writeFile(path.join(source, "nested", name), name);
  }
  const manifest = await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  expect(manifest.files.map((entry) => entry.path)).toEqual([
    ".gitignore",
    "nested",
    "nested/.gitignore",
    "nested/keep.log",
    "nested/keep.tmp",
    "tracked.txt",
  ]);
  // Changes inside omitted paths do not invalidate the captured workspace.
  await writeFile(path.join(source, "cache", "later"), "ignored");
  await writeFile(path.join(source, "nested", "drop.log"), "changed ignored file");
  await verifyCapturedWorkspace({ cwd: source, artifactDirectory: artifact });
  await restoreWorkspace({ artifactDirectory: artifact, destination });
  expect(await readFile(path.join(destination, "nested", "keep.tmp"), "utf8")).toBe("keep.tmp");
  await expect(lstat(path.join(destination, "cache"))).rejects.toMatchObject({ code: "ENOENT" });
});

test.each([
  ["file edit", async () => writeFile(path.join(source, "tracked.txt"), "changed")],
  ["file deletion", async () => rm(path.join(source, "tracked.txt"))],
  ["new empty directory", async () => mkdir(path.join(source, "new-directory"))],
  ["changed ignore rules", async () => writeFile(path.join(source, ".gitignore"), "tracked.txt\n")],
  [
    "new Git repository",
    async () => {
      await git(source, "init", "--initial-branch=new");
    },
  ],
])("refuses release of a non-Git snapshot after %s", async (_description, change) => {
  await rm(path.join(source, ".git"), { recursive: true });
  await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  await change();
  await expect(
    verifyCapturedWorkspace({ cwd: source, artifactDirectory: artifact }),
  ).rejects.toMatchObject({
    code: "source_changed",
  });
});

test("counts empty non-Git directories against capture and receiver limits", async () => {
  await rm(source, { recursive: true });
  await mkdir(path.join(source, "one", "two"), { recursive: true });
  const limits = { ...WORKSPACE_SNAPSHOT_LIMITS, maxFiles: 1 };
  await expect(
    captureWorkspace({ cwd: source, artifactDirectory: artifact, limits }),
  ).rejects.toMatchObject({
    code: "limit_exceeded",
  });
  await expect(lstat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
  await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  await expect(
    restoreWorkspace({ artifactDirectory: artifact, destination, limits }),
  ).rejects.toMatchObject({
    code: "limit_exceeded",
  });
  await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["file", "symlink"] as const)(
  "rejects a non-Git directory beneath a %s before restoring any files",
  async (kind) => {
    await rm(path.join(source, ".git"), { recursive: true });
    const manifest = await captureWorkspace({ cwd: source, artifactDirectory: artifact });
    if (kind === "symlink") manifest.files.push({ kind, path: "parent", target: "inside" });
    else {
      const file = manifest.files.find((entry) => entry.kind === "file");
      if (!file) throw new Error("Expected a file fixture");
      manifest.files.push({ ...file, path: "parent" });
    }
    manifest.files.push({ kind: "directory", path: "parent/nested" });
    await writeFile(path.join(artifact, "manifest.json"), JSON.stringify(manifest));
    await expect(
      restoreWorkspace({ artifactDirectory: artifact, destination }),
    ).rejects.toMatchObject({
      code: "invalid_artifact",
    });
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

test("moves local history and staged, unstaged and untracked bytes without changing the source", async () => {
  await writeFile(path.join(source, "tracked.txt"), "staged\n");
  await git(source, "add", "tracked.txt");
  await writeFile(path.join(source, "tracked.txt"), "working\n");
  const binary = Buffer.from([0, 1, 2, 255, 128]);
  await writeFile(path.join(source, "new binary.bin"), binary);
  await writeFile(path.join(source, ".env"), "LOCAL_SECRET=not-transferred\n");
  const originalHead = await git(source, "rev-parse", "HEAD");
  const originalIndex = await git(source, "diff", "--cached", "--binary");
  const originalStatus = await git(source, "status", "--porcelain=v1", "-z");

  await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  await restoreWorkspace({ artifactDirectory: artifact, destination });

  expect(await git(destination, "rev-parse", "HEAD")).toBe(originalHead);
  expect(await git(destination, "symbolic-ref", "--short", "HEAD")).toBe("work\n");
  expect(await git(destination, "diff", "--cached", "--binary")).toBe(originalIndex);
  expect(await git(destination, "status", "--porcelain=v1", "-z")).toBe(originalStatus);
  expect(await readFile(path.join(destination, "tracked.txt"), "utf8")).toBe("working\n");
  expect(await readFile(path.join(destination, "new binary.bin"))).toEqual(binary);
  await expect(readFile(path.join(destination, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await git(source, "rev-parse", "HEAD")).toBe(originalHead);
  expect(await git(source, "diff", "--cached", "--binary")).toBe(originalIndex);
  expect(await git(source, "status", "--porcelain=v1", "-z")).toBe(originalStatus);
});

test("refuses intent-to-add instead of silently changing the Git index", async () => {
  await writeFile(path.join(source, "intent.txt"), "not staged yet\n");
  await git(source, "add", "--intent-to-add", "intent.txt");
  await expect(
    captureWorkspace({ cwd: source, artifactDirectory: artifact }),
  ).rejects.toMatchObject({ code: "unsupported_workspace" });
});

test("refuses undecodable index names even when the host cannot create their working files", async () => {
  const hash = (await git(source, "rev-parse", "HEAD:tracked.txt")).trim();
  const entry = Buffer.concat([Buffer.from(`100644 ${hash}\t`), Buffer.from([0xff, 0])]);
  const update = exec("git", ["update-index", "-z", "--index-info"], { cwd: source });
  if (!update.child.stdin) throw new Error("Git index fixture needs piped stdin");
  update.child.stdin.end(entry);
  await update;
  const index = await exec("git", ["ls-files", "--stage", "-z"], {
    cwd: source,
    encoding: "buffer",
  });
  expect(index.stdout.includes(Buffer.from([0x09, 0xff, 0]))).toBe(true);
  await expect(
    captureWorkspace({ cwd: source, artifactDirectory: artifact }),
  ).rejects.toMatchObject({
    code: "unsupported_workspace",
    message: "Workspace contains non-UTF-8 Git paths or configuration",
  });
});

test.each([
  ["case-file", "CASE-FILE"],
  ["directory/one", "DIRECTORY/two"],
  ["é/one", "e\u0301/two"],
])("refuses colliding index paths %s and %s even without working files", async (first, second) => {
  // macOS Git otherwise normalizes argv before these distinct index paths are inserted.
  await git(source, "config", "core.precomposeUnicode", "false");
  const hash = (await git(source, "rev-parse", "HEAD:tracked.txt")).trim();
  await git(source, "update-index", "--add", "--cacheinfo", `100644,${hash},${first}`);
  await git(source, "update-index", "--add", "--cacheinfo", `100644,${hash},${second}`);
  const indexPaths = (await git(source, "ls-files", "-z")).split("\0");
  expect(indexPaths).toContain(first);
  expect(indexPaths).toContain(second);
  await expect(
    captureWorkspace({ cwd: source, artifactDirectory: artifact }),
  ).rejects.toMatchObject({ code: "unsupported_workspace" });
});

test("rejects an incoming index with portable path collisions before publishing the checkout", async () => {
  const manifest = await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  if (!manifest.git) throw new Error("Expected a Git snapshot fixture");
  const hash = (await git(source, "rev-parse", "HEAD:tracked.txt")).trim();
  await git(source, "update-index", "--add", "--cacheinfo", `100644,${hash},case-file`);
  await git(source, "update-index", "--add", "--cacheinfo", `100644,${hash},CASE-FILE`);
  const patch = await git(
    source,
    "diff",
    "--cached",
    "--binary",
    "--full-index",
    "--src-prefix=a/",
    "--dst-prefix=b/",
  );
  const sha256 = createHash("sha256").update(patch).digest("hex");
  manifest.git.indexPatch = { sha256, size: Buffer.byteLength(patch) };
  manifest.git.indexFingerprint = createHash("sha256")
    .update(await git(source, "ls-files", "--stage", "-z"))
    .digest("hex");
  await writeFile(path.join(artifact, "blobs", sha256), patch);
  await writeFile(path.join(artifact, "manifest.json"), JSON.stringify(manifest));
  await expect(
    restoreWorkspace({ artifactDirectory: artifact, destination }),
  ).rejects.toMatchObject({ code: "invalid_artifact" });
  await expect(readFile(path.join(destination, "tracked.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("rejects workspace references outside the verified archive inventory before creating a destination", async () => {
  await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  const manifestPath = path.join(artifact, "manifest.json");
  const bytes = await readFile(manifestPath);
  const entrypoint = {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
  const store = new HandoffArchiveStore(path.join(root, "archives"));
  const transferId = randomUUID();
  await store.importLocal({
    id: transferId,
    manifest: { version: 1, entrypoint, blobs: [entrypoint] },
    files: new Map([[entrypoint.sha256, manifestPath]]),
  });
  await expect(restoreWorkspaceArchive({ store, transferId, destination })).rejects.toMatchObject({
    code: "invalid_artifact",
  });
  await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
});

test("restores staged binaries, renames, staged deletions and unstaged deletions", async () => {
  await writeFile(path.join(source, "delete-staged.txt"), "delete me\n");
  await writeFile(path.join(source, "delete-working.txt"), "delete me too\n");
  await writeFile(path.join(source, "binary.bin"), Buffer.from([0, 255, 1]));
  await git(source, "add", ".");
  await git(source, "commit", "-m", "More local history");
  await git(source, "mv", "tracked.txt", "renamed ü.txt");
  await git(source, "rm", "delete-staged.txt");
  await rm(path.join(source, "delete-working.txt"));
  await writeFile(path.join(source, "binary.bin"), Buffer.from([0, 255, 2]));
  await git(source, "add", "binary.bin");
  await writeFile(path.join(source, "binary.bin"), Buffer.from([0, 255, 3]));
  await writeFile(path.join(source, "added.txt"), "added to index\n");
  await git(source, "add", "added.txt");
  await rm(path.join(source, "added.txt"));

  await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  await restoreWorkspace({ artifactDirectory: artifact, destination });

  expect(await git(destination, "status", "--porcelain=v1", "-z")).toBe(
    await git(source, "status", "--porcelain=v1", "-z"),
  );
  expect(await git(destination, "diff", "--cached", "--binary")).toBe(
    await git(source, "diff", "--cached", "--binary"),
  );
  expect(await git(destination, "diff", "--binary")).toBe(await git(source, "diff", "--binary"));
});

test("copies a linked worktree without copying its external gitdir", async () => {
  const worktree = path.join(root, "linked");
  await git(source, "worktree", "add", "-b", "linked-work", worktree);
  await writeFile(path.join(worktree, "tracked.txt"), "from worktree\n");
  await captureWorkspace({ cwd: worktree, artifactDirectory: artifact });
  await restoreWorkspace({ artifactDirectory: artifact, destination });
  await git(source, "worktree", "remove", "--force", worktree);
  expect(await git(destination, "rev-parse", "--show-toplevel")).toBe(
    `${destination.replaceAll("\\", "/")}\n`,
  );
  expect(await git(destination, "symbolic-ref", "--short", "HEAD")).toBe("linked-work\n");
  expect(await readFile(path.join(destination, "tracked.txt"), "utf8")).toBe("from worktree\n");
});

test("preserves a detached HEAD", async () => {
  await git(source, "checkout", "--detach");
  await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  await restoreWorkspace({ artifactDirectory: artifact, destination });
  expect(await git(destination, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD\n");
  expect(await git(destination, "rev-parse", "HEAD")).toBe(await git(source, "rev-parse", "HEAD"));
});

test("preserves an unborn branch with a staged file", async () => {
  await rm(path.join(source, ".git"), { recursive: true });
  await git(source, "init", "--initial-branch=unborn");
  await git(source, "add", "tracked.txt");
  await writeFile(path.join(source, "tracked.txt"), "unstaged\n");
  await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  await restoreWorkspace({ artifactDirectory: artifact, destination });
  expect(await git(destination, "symbolic-ref", "--short", "HEAD")).toBe("unborn\n");
  expect(await git(destination, "status", "--porcelain=v1", "-z")).toBe(
    await git(source, "status", "--porcelain=v1", "-z"),
  );
});

test("refuses an existing destination and leaves its contents alone", async () => {
  await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  await mkdir(destination);
  await writeFile(path.join(destination, "keep"), "existing work");
  await expect(
    restoreWorkspace({ artifactDirectory: artifact, destination }),
  ).rejects.toMatchObject({ code: "destination_exists" });
  expect(await readFile(path.join(destination, "keep"), "utf8")).toBe("existing work");
});

test("detects a corrupted blob before creating the destination", async () => {
  const manifest = await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  const file = manifest.files.find((entry) => entry.path === "tracked.txt");
  if (!file || file.kind !== "file") throw new Error("Missing test fixture file");
  await writeFile(path.join(artifact, "blobs", file.blob.sha256), "corrupted\n");
  await expect(
    restoreWorkspace({ artifactDirectory: artifact, destination }),
  ).rejects.toMatchObject({ code: "invalid_artifact" });
  await expect(readFile(path.join(destination, "tracked.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test.each([
  "../outside",
  "/tmp/absolute",
  "C:/outside",
  "a\\..\\outside",
  ".git/config",
  "a/.GIT/config",
  "aux.txt",
  "trailing.",
])("refuses unsafe artifact path %s", async (unsafePath) => {
  const manifest = await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  manifest.files[0]!.path = unsafePath;
  await writeFile(path.join(artifact, "manifest.json"), JSON.stringify(manifest));
  await expect(
    restoreWorkspace({ artifactDirectory: artifact, destination }),
  ).rejects.toMatchObject({ code: "unsupported_workspace" });
});

test.each(["maxFiles", "maxFileBytes", "maxTotalBytes", "maxManifestBytes"])(
  "enforces receiver %s independently of the sender",
  async (limit) => {
    await captureWorkspace({ cwd: source, artifactDirectory: artifact });
    const limits = { ...WORKSPACE_SNAPSHOT_LIMITS, [limit]: 1 };
    await expect(
      restoreWorkspace({ artifactDirectory: artifact, destination, limits }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
  },
);

test.each(["--assume-unchanged", "--skip-worktree"])(
  "refuses index flag %s rather than dropping it",
  async (flag) => {
    await git(source, "update-index", flag, "tracked.txt");
    await expect(
      captureWorkspace({ cwd: source, artifactDirectory: artifact }),
    ).rejects.toMatchObject({ code: "unsupported_workspace" });
  },
);

test("refuses an in-progress merge even when conflicts are resolved", async () => {
  await writeFile(path.join(source, ".git", "MERGE_HEAD"), await git(source, "rev-parse", "HEAD"));
  await expect(
    captureWorkspace({ cwd: source, artifactDirectory: artifact }),
  ).rejects.toMatchObject({ code: "unsupported_workspace" });
});

test("refuses sparse and partial clones", async () => {
  await git(source, "config", "remote.origin.promisor", "true");
  await expect(
    captureWorkspace({ cwd: source, artifactDirectory: artifact }),
  ).rejects.toMatchObject({ code: "unsupported_workspace" });
});

test("preserves a SHA-256 Git repository", async () => {
  await rm(path.join(source, ".git"), { recursive: true });
  await git(source, "init", "--object-format=sha256", "--initial-branch=work");
  await git(source, "add", ".");
  await git(source, "commit", "-m", "SHA-256 history");
  await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  await restoreWorkspace({ artifactDirectory: artifact, destination });
  expect(await git(destination, "rev-parse", "HEAD")).toBe(await git(source, "rev-parse", "HEAD"));
});

test("detects edits made after capture before the source can release ownership", async () => {
  await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  await writeFile(path.join(source, "tracked.txt"), "changed after capture\n");
  await expect(
    verifyCapturedWorkspace({ cwd: source, artifactDirectory: artifact }),
  ).rejects.toMatchObject({ code: "source_changed" });
});

test("refuses LFS and custom filters whose data is not in a Git bundle", async () => {
  await writeFile(
    path.join(source, ".gitattributes"),
    "tracked.txt filter=lfs diff=lfs merge=lfs -text\n",
  );
  await expect(
    captureWorkspace({ cwd: source, artifactDirectory: artifact }),
  ).rejects.toMatchObject({ code: "unsupported_workspace" });
});

test.each(["repository info", "global"])(
  "refuses %s attributes that would be lost on the destination",
  async (location) => {
    const attributes =
      location === "global"
        ? path.join(root, "attributes")
        : path.join(source, ".git", "info", "attributes");
    await writeFile(attributes, "tracked.txt text eol=crlf\n");
    if (location === "global") await git(source, "config", "core.attributesFile", attributes);
    const reportedPath =
      location === "global"
        ? await git(source, "var", "GIT_ATTR_GLOBAL")
        : await git(source, "rev-parse", "--git-path", "info/attributes");
    await expect(
      captureWorkspace({ cwd: source, artifactDirectory: artifact }),
    ).rejects.toMatchObject({
      code: "unsupported_workspace",
      message: `Move external Git attributes into the workspace's .gitattributes before handoff: ${reportedPath.trim()}`,
    });
  },
);

test("rechecks external attributes before source release", async () => {
  await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  await writeFile(path.join(source, ".git", "info", "attributes"), "tracked.txt text eol=crlf\n");
  await expect(
    verifyCapturedWorkspace({ cwd: source, artifactDirectory: artifact }),
  ).rejects.toMatchObject({ code: "unsupported_workspace" });
});

test("permits comment-only external attributes without copying host configuration", async () => {
  await writeFile(
    path.join(source, ".git", "info", "attributes"),
    "# Local instructions\n\n  # No rules\n",
  );
  await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  await restoreWorkspace({ artifactDirectory: artifact, destination });
  await expect(
    readFile(path.join(destination, ".git", "info", "attributes")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

test("preserves Git line-ending normalization when hosts have different defaults", async () => {
  await git(source, "config", "core.autocrlf", "true");
  await writeFile(path.join(source, "tracked.txt"), "committed\r\n");
  await git(source, "add", "tracked.txt");
  await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  await restoreWorkspace({ artifactDirectory: artifact, destination });
  expect(await git(destination, "status", "--porcelain=v1", "-z")).toBe(
    await git(source, "status", "--porcelain=v1", "-z"),
  );
  expect(await readFile(path.join(destination, "tracked.txt"), "utf8")).toBe("committed\r\n");
});

test.each([
  { name: "duplicate", first: "same", second: "same" },
  { name: "case", first: "file", second: "FILE" },
  { name: "unicode", first: "é", second: "e\u0301" },
  { name: "case folding", first: "σ", second: "ς" },
  { name: "directory case", first: "Dir/a", second: "dir/b" },
  { name: "directory normalization", first: "é/a", second: "e\u0301/b" },
  { name: "parent", first: "file", second: "file/child" },
])("rejects $name path collisions before materialization", async ({ first, second }) => {
  const manifest = await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  const entry = manifest.files[0];
  if (!entry) throw new Error("Missing fixture file");
  manifest.files = [
    { ...entry, path: first },
    { ...entry, path: second },
  ];
  await writeFile(path.join(artifact, "manifest.json"), JSON.stringify(manifest));
  await expect(
    restoreWorkspace({ artifactDirectory: artifact, destination }),
  ).rejects.toMatchObject({ code: "invalid_artifact" });
});

test("rejects malformed manifest JSON without creating a destination", async () => {
  await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  await writeFile(path.join(artifact, "manifest.json"), "{unfinished");
  await expect(
    restoreWorkspace({ artifactDirectory: artifact, destination }),
  ).rejects.toMatchObject({ code: "invalid_artifact" });
});

test("rejects a shallow clone before trying to capture incomplete history", async () => {
  const shallow = path.join(root, "shallow");
  await git(root, "clone", "--depth=1", pathToFileURL(source).href, shallow);
  await expect(
    captureWorkspace({ cwd: shallow, artifactDirectory: artifact }),
  ).rejects.toMatchObject({ code: "unsupported_workspace" });
});

test("cleans up only the artifact it owns when capture exceeds its byte budget", async () => {
  const limits = { ...WORKSPACE_SNAPSHOT_LIMITS, maxTotalBytes: 1 };
  await expect(
    captureWorkspace({ cwd: source, artifactDirectory: artifact, limits }),
  ).rejects.toMatchObject({ code: "limit_exceeded" });
  await expect(readFile(path.join(artifact, "manifest.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(await readFile(path.join(source, "tracked.txt"), "utf8")).toBe("committed\n");
});

test("never creates an artifact inside the workspace being captured", async () => {
  await expect(
    captureWorkspace({ cwd: source, artifactDirectory: path.join(source, "artifact") }),
  ).rejects.toMatchObject({ code: "unsupported_workspace" });
});

test("detects new untracked files and index changes after capture", async () => {
  await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  await writeFile(path.join(source, "appeared.txt"), "new\n");
  await expect(
    verifyCapturedWorkspace({ cwd: source, artifactDirectory: artifact }),
  ).rejects.toMatchObject({ code: "source_changed" });
  await git(source, "add", "appeared.txt");
  await expect(
    verifyCapturedWorkspace({ cwd: source, artifactDirectory: artifact }),
  ).rejects.toMatchObject({ code: "source_changed" });
});

test("verifies an unchanged capture", async () => {
  await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  await expect(
    verifyCapturedWorkspace({ cwd: source, artifactDirectory: artifact }),
  ).resolves.toBeUndefined();
});

test("does not let personal diff formatting corrupt the staged patch", async () => {
  await git(source, "config", "diff.noprefix", "true");
  await git(source, "config", "color.diff", "always");
  await writeFile(path.join(source, "tracked.txt"), "staged modification\n");
  await git(source, "add", "tracked.txt");
  await captureWorkspace({ cwd: source, artifactDirectory: artifact });
  await restoreWorkspace({ artifactDirectory: artifact, destination });
  expect(await git(destination, "show", ":tracked.txt")).toBe("staged modification\n");
});
