import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test as platformTest } from "vitest";
import { captureWorkspace, restoreWorkspace } from "./workspace.js";

const test = platformTest.skipIf(process.platform === "win32");
const exec = promisify(execFile);
let root: string;
let source: string;
let artifactDirectory: string;
let destination: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "paseo-handoff-posix-"));
  source = path.join(root, "source");
  artifactDirectory = path.join(root, "artifact");
  destination = path.join(root, "destination");
  await mkdir(source);
  await exec("git", ["init", "--initial-branch=work"], { cwd: source });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("preserves executable files and internal relative symlinks", async () => {
  await writeFile(path.join(source, "script.sh"), "#!/bin/sh\nexit 0\n");
  await chmod(path.join(source, "script.sh"), 0o755);
  await mkdir(path.join(source, "nested"));
  await symlink("../script.sh", path.join(source, "nested", "script"));
  await captureWorkspace({ cwd: source, artifactDirectory });
  await restoreWorkspace({ artifactDirectory, destination });
  expect((await lstat(path.join(destination, "script.sh"))).mode & 0o111).toBe(0o111);
  expect(await readlink(path.join(destination, "nested", "script"))).toBe("../script.sh");
  expect(await readFile(path.join(destination, "nested", "script"), "utf8")).toBe(
    "#!/bin/sh\nexit 0\n",
  );
});

test("allows a relative symlink to the workspace root", async () => {
  await mkdir(path.join(source, "nested"));
  await symlink("..", path.join(source, "nested", "root"));
  await captureWorkspace({ cwd: source, artifactDirectory });
  await restoreWorkspace({ artifactDirectory, destination });
  expect(await readlink(path.join(destination, "nested", "root"))).toBe("..");
});

test("rejects symlink chains whose lexical paths appear safe but resolve outside the checkout", async () => {
  await mkdir(path.join(source, "directory"));
  await symlink("..", path.join(source, "directory", "up"));
  await symlink("directory/up/../outside", path.join(source, "escape"));
  await expect(captureWorkspace({ cwd: source, artifactDirectory })).rejects.toMatchObject({
    code: "unsupported_workspace",
  });
});

test("does not follow absolute symlinks or copy their target bytes", async () => {
  await writeFile(path.join(root, "private"), "outside bytes");
  await symlink(path.join(root, "private"), path.join(source, "link"));
  await expect(captureWorkspace({ cwd: source, artifactDirectory })).rejects.toMatchObject({
    code: "unsupported_workspace",
  });
  expect(await readFile(path.join(root, "private"), "utf8")).toBe("outside bytes");
});

test("does not follow a destination symlink to an existing directory", async () => {
  await writeFile(path.join(source, "file"), "transferred");
  await captureWorkspace({ cwd: source, artifactDirectory });
  const occupied = path.join(root, "occupied");
  await mkdir(occupied);
  await writeFile(path.join(occupied, "keep"), "existing");
  await symlink(occupied, destination);
  await expect(restoreWorkspace({ artifactDirectory, destination })).rejects.toMatchObject({
    code: "destination_exists",
  });
  expect(await readFile(path.join(occupied, "keep"), "utf8")).toBe("existing");
});

test.each(["git~1/config", ".g\u200cit/config", ".gi\u034ft/config"])(
  "rejects cross-platform Git directory aliases: %s",
  async (unsafePath) => {
    await writeFile(path.join(source, "file"), "payload");
    const manifest = await captureWorkspace({ cwd: source, artifactDirectory });
    const entry = manifest.files[0];
    if (!entry) throw new Error("Missing fixture entry");
    entry.path = unsafePath;
    await writeFile(path.join(artifactDirectory, "manifest.json"), JSON.stringify(manifest));
    await expect(restoreWorkspace({ artifactDirectory, destination })).rejects.toMatchObject({
      code: "unsupported_workspace",
    });
  },
);

// macOS rejects invalid UTF-8 at file creation. Linux can retain these untracked names.
test.skipIf(process.platform !== "linux")(
  "refuses undecodable filenames instead of silently treating them as deleted",
  async () => {
    const bytes = Buffer.concat([Buffer.from(`${source}/`), Buffer.from([0xff])]);
    await writeFile(bytes, "keep this file");
    await expect(captureWorkspace({ cwd: source, artifactDirectory })).rejects.toMatchObject({
      code: "unsupported_workspace",
    });
  },
);
