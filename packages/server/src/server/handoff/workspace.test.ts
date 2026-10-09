import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  captureWorkspace,
  restoreWorkspace,
  verifyCapturedWorkspace,
  WORKSPACE_SNAPSHOT_LIMITS,
} from "./workspace.js";

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
  await rm(root, { recursive: true, force: true });
});

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
