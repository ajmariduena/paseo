import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { readBoundedFile } from "./artifacts.js";
import type { HandoffArchiveStore } from "./archive.js";
import {
  HandoffBlobSchema as BlobSchema,
  HandoffDigestSchema as DigestSchema,
  type HandoffArchiveManifest,
} from "@getpaseo/protocol/handoff";
import {
  createRunGitCommand,
  runGitCommandBytes,
  runGitCommandToFile,
  type GitCommandResult,
} from "../../utils/run-git-command.js";

const git = createRunGitCommand("handoff-workspace");
const GitNormalizationSchema = z.object({
  autocrlf: z.enum(["true", "false", "input"]),
  eol: z.enum(["lf", "crlf"]),
});
const FileSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    path: z.string(),
    executable: z.boolean(),
    blob: BlobSchema,
  }),
  z.object({ kind: z.literal("symlink"), path: z.string(), target: z.string() }),
  z.object({ kind: z.literal("directory"), path: z.string() }),
]);
const ManifestSchema = z.object({
  version: z.literal(1),
  git: z
    .object({
      objectFormat: z.enum(["sha1", "sha256"]),
      normalization: GitNormalizationSchema,
      head: z
        .string()
        .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
        .nullable(),
      branch: z.string().nullable(),
      bundle: BlobSchema.nullable(),
      indexPatch: BlobSchema,
      indexFingerprint: DigestSchema,
    })
    .nullable(),
  files: z.array(FileSchema),
});

export type WorkspaceManifest = z.infer<typeof ManifestSchema>;
type Blob = z.infer<typeof BlobSchema>;
type WorkspaceFile = z.infer<typeof FileSchema>;

export interface WorkspaceSnapshotLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxManifestBytes: number;
}

export const WORKSPACE_SNAPSHOT_LIMITS: WorkspaceSnapshotLimits = {
  maxFiles: 100_000,
  maxFileBytes: 1024 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  maxManifestBytes: 20 * 1024 * 1024,
};

type ErrorCode =
  | "invalid_artifact"
  | "unsupported_workspace"
  | "source_changed"
  | "limit_exceeded"
  | "destination_exists";

export class HandoffWorkspaceError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HandoffWorkspaceError";
  }
}

interface CaptureInput {
  cwd: string;
  artifactDirectory: string;
  limits?: WorkspaceSnapshotLimits;
}

interface RestoreInput {
  artifactDirectory: string;
  destination: string;
  limits?: WorkspaceSnapshotLimits;
}

interface GitState {
  kind: "git";
  objectFormat: "sha1" | "sha256";
  normalization: z.infer<typeof GitNormalizationSchema>;
  head: string | null;
  branch: string | null;
  paths: string[];
  index: string;
}

interface DirectoryState {
  kind: "directory";
  paths: string[];
}

type WorkspaceState = GitState | DirectoryState;

interface BlobCapture {
  directory: string;
  maxFileBytes: number;
  remainingBytes: number;
}

function reject(code: ErrorCode, message: string): never {
  throw new HandoffWorkspaceError(code, message);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function validatePath(value: string): void {
  if (Buffer.byteLength(value) > 4096)
    reject("unsupported_workspace", "Workspace path is too long");
  if (Buffer.from(value).toString("utf8") !== value)
    reject("unsupported_workspace", "Workspace path contains invalid Unicode");
  const segments = value.split("/");
  const invalid = segments.some((segment) => {
    return (
      segment === "" ||
      Buffer.byteLength(segment) > 255 ||
      segment === "." ||
      segment === ".." ||
      segment.toLowerCase() === ".git" ||
      /~[0-9]+(?:\.|$)/.test(segment) ||
      /\p{Default_Ignorable_Code_Point}/u.test(segment) ||
      /[\\<>:"|?*]/.test(segment) ||
      Array.from(segment).some((character) => character.charCodeAt(0) < 32) ||
      /[. ]$/.test(segment) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
    );
  });
  if (invalid) reject("unsupported_workspace", `Path is not portable between hosts: ${value}`);
}

function validatePaths(
  values: readonly string[],
  code: ErrorCode,
  directories = new Set<string>(),
): void {
  const paths = new Set<string>();
  const spelling = new Map<string, string>();
  for (const value of values) {
    validatePath(value);
    const canonical = portablePathKey(value);
    if (paths.has(canonical)) reject(code, `Colliding workspace path: ${value}`);
    paths.add(canonical);
    const prefix: string[] = [];
    for (const segment of value.split("/")) {
      prefix.push(segment);
      const original = prefix.join("/");
      const key = portablePathKey(original);
      const previous = spelling.get(key);
      if (previous !== undefined && previous !== original)
        reject(code, `Colliding workspace path: ${original}`);
      spelling.set(key, original);
    }
  }
  for (const value of paths) {
    const segments = value.split("/");
    segments.pop();
    while (segments.length > 0) {
      const parent = segments.join("/");
      if (paths.has(parent) && !directories.has(parent))
        reject(code, `File is also a parent directory: ${value}`);
      segments.pop();
    }
  }
}

function validateFiles(files: readonly WorkspaceFile[]): void {
  validatePaths(
    files.map((file) => file.path),
    "invalid_artifact",
    new Set(
      files.filter((file) => file.kind === "directory").map((file) => portablePathKey(file.path)),
    ),
  );
  const links = new Map<string, string>();
  for (const file of files) {
    if (file.kind === "symlink") links.set(portablePathKey(file.path), file.target);
  }
  for (const [link, target] of links) validateSymlink(link, target, links);
}

function validateIndex(index: string, code: ErrorCode): void {
  const paths: string[] = [];
  for (const entry of index.split("\0").filter(Boolean)) {
    const match = /^(100644|100755|120000) [a-f0-9]+ 0\t(.*)$/s.exec(entry);
    if (!match) reject(code, "Handoff requires an index of resolved regular files and symlinks");
    paths.push(match[2]);
  }
  validatePaths(paths, code);
}

function portablePathKey(value: string): string {
  return value.normalize("NFC").toUpperCase().toLowerCase();
}

function validateSymlink(link: string, target: string, links: ReadonlyMap<string, string>): void {
  const resolved = link.split("/").slice(0, -1);
  const pending = target.split("/").toReversed();
  let expansions = 0;
  if (target === "" || target.length > 4096 || path.posix.isAbsolute(target))
    reject("unsupported_workspace", `Non-relative symlink: ${link}`);
  while (pending.length > 0) {
    const segment = pending.pop();
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (resolved.length === 0)
        reject("unsupported_workspace", `Symlink leaves workspace: ${link}`);
      resolved.pop();
      continue;
    }
    validatePath(segment);
    resolved.push(portablePathKey(segment));
    const next = links.get(resolved.join("/"));
    if (next === undefined) continue;
    if (++expansions > 64)
      reject("unsupported_workspace", `Cyclic or too deeply nested symlink: ${link}`);
    if (next.length > 4096 || path.posix.isAbsolute(next))
      reject("unsupported_workspace", `Non-relative symlink: ${link}`);
    resolved.pop();
    pending.push(...next.split("/").toReversed());
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const result = await runGitCommandBytes(["-c", "core.hooksPath=", ...args], {
    cwd,
    envOverlay: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  return decodeGitOutput(result);
}

async function runRestoreGit(cwd: string, args: string[]): Promise<string> {
  const result = await runGitCommandBytes(["-c", "core.hooksPath=", ...args], {
    cwd,
    envOverlay: {
      GIT_CONFIG_NOSYSTEM: "1",
      // Git for Windows maps /dev/null itself; Node's \\.\nul path is rejected by Git.
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return decodeGitOutput(result);
}

function decodeGitOutput(result: GitCommandResult<Buffer>): string {
  if (result.truncated) reject("limit_exceeded", "Git output exceeds the handoff limit");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
  } catch (error) {
    if (error instanceof TypeError)
      reject("unsupported_workspace", "Workspace contains non-UTF-8 Git paths or configuration");
    throw error;
  }
}

async function getGitState(cwd: string, limits: WorkspaceSnapshotLimits): Promise<GitState> {
  const top = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
  if ((await realpath(top)) !== cwd)
    reject("unsupported_workspace", "Select the checkout root to move this workspace");
  const index = await runGit(cwd, ["ls-files", "--stage", "-z"]);
  if (index.split("\0").some((entry) => entry.startsWith("160000 ")))
    reject("unsupported_workspace", "Submodules require a separate handoff");
  if (index.split("\0").some((entry) => /^[0-9]+ [a-f0-9]+ [123]\t/.test(entry))) {
    reject("unsupported_workspace", "Resolve Git conflicts before moving this workspace");
  }
  validateIndex(index, "unsupported_workspace");
  const pathsText = await runGit(cwd, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const paths = Array.from(new Set(pathsText.split("\0").filter(Boolean))).sort();
  if (paths.length > limits.maxFiles) reject("limit_exceeded", "Workspace contains too many files");
  for (const filePath of paths) validatePath(filePath);
  const headResult = await git(["rev-parse", "--verify", "--quiet", "HEAD"], {
    cwd,
    acceptExitCodes: [0, 1],
  });
  const refs = headResult.stdout;
  const branchResult = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd,
    acceptExitCodes: [0, 1],
  });
  const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : null;
  const objectFormat = (await runGit(cwd, ["rev-parse", "--show-object-format"])).trim();
  if (objectFormat !== "sha1" && objectFormat !== "sha256")
    reject("unsupported_workspace", "Unsupported Git object format");
  const autocrlf = await git(["config", "--get", "core.autocrlf"], {
    cwd,
    acceptExitCodes: [0, 1],
  });
  const eol = await git(["config", "--get", "core.eol"], { cwd, acceptExitCodes: [0, 1] });
  const configuredEol = eol.stdout.trim();
  const nativeEol = os.EOL === "\r\n" ? "crlf" : "lf";
  const isNativeEol = configuredEol === "" || configuredEol === "native";
  const normalization = GitNormalizationSchema.parse({
    autocrlf: autocrlf.stdout.trim() || "false",
    eol: isNativeEol ? nativeEol : configuredEol,
  });
  return {
    kind: "git",
    objectFormat,
    normalization,
    head: refs.trim() || null,
    branch,
    paths,
    index,
  };
}

async function getWorkspaceState(
  cwd: string,
  limits: WorkspaceSnapshotLimits,
  scratchParent: string,
): Promise<WorkspaceState> {
  const probe = await git(["rev-parse", "--show-toplevel"], {
    cwd,
    acceptExitCodes: [0, 128],
    envOverlay: { LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" },
  });
  if (probe.exitCode === 0) return getGitState(cwd, limits);
  if (!probe.stderr.includes("not a git repository")) {
    reject("unsupported_workspace", `Cannot inspect workspace Git state: ${probe.stderr.trim()}`);
  }
  const scratchRoot = await realpath(scratchParent);
  if (isWithin(cwd, scratchRoot))
    reject("unsupported_workspace", "Store the handoff artifact outside the source workspace");
  const scratch = await mkdtemp(path.join(scratchRoot, ".handoff-ignore-"));
  try {
    // Query Git's ignore engine without adding a repository to the source or
    // inheriting another host's global exclude rules. No index is populated.
    await runRestoreGit(scratch, ["init", "--bare", "--template=", "--quiet"]);
    const ignoredText = await runRestoreGit(cwd, [
      `--git-dir=${scratch}`,
      `--work-tree=${cwd}`,
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ]);
    const ignored = new Set(ignoredText.split("\0").filter(Boolean));
    const paths: string[] = [];
    const directories = [""];
    for (const directory of directories) {
      const absolute = path.join(cwd, directory);
      if (!isWithin(cwd, await realpath(absolute)))
        reject("source_changed", "Directory left the workspace during enumeration");
      for (const entry of await readdir(absolute, { withFileTypes: true, encoding: "buffer" })) {
        let name: string;
        try {
          name = new TextDecoder("utf-8", { fatal: true }).decode(entry.name);
        } catch {
          reject("unsupported_workspace", "Workspace contains non-UTF-8 filenames");
        }
        const relative = directory ? `${directory}/${name}` : name;
        if (ignored.has(relative) || ignored.has(`${relative}/`)) continue;
        validatePath(relative);
        paths.push(relative);
        if (paths.length > limits.maxFiles)
          reject("limit_exceeded", "Workspace contains too many files or directories");
        if (entry.isDirectory()) directories.push(relative);
      }
    }
    return { kind: "directory", paths: paths.sort() };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function validateGitCapture(cwd: string, paths: string[]): Promise<void> {
  await validateExternalAttributes(cwd);
  if (paths.length > 0) {
    const attributes = await runGitCommandBytes(["check-attr", "-z", "--stdin", "filter"], {
      cwd,
      input: `${paths.join("\0")}\0`,
    });
    const values = decodeGitOutput(attributes).split("\0");
    for (let index = 2; index < values.length; index += 3) {
      if (values[index] !== "unspecified" && values[index] !== "unset")
        reject(
          "unsupported_workspace",
          `Remove or materialize the external Git filter before moving: ${values[index]}`,
        );
    }
  }
  const visibleIntent = await runGit(cwd, [
    "diff",
    "--cached",
    "--name-only",
    "--ita-visible-in-index",
    "-z",
  ]);
  const hiddenIntent = await runGit(cwd, [
    "diff",
    "--cached",
    "--name-only",
    "--ita-invisible-in-index",
    "-z",
  ]);
  if (visibleIntent !== hiddenIntent)
    reject(
      "unsupported_workspace",
      "Stage or reset intent-to-add entries before moving this workspace",
    );
  const flags = await runGit(cwd, ["ls-files", "-v", "-z"]);
  if (
    flags
      .split("\0")
      .filter(Boolean)
      .some((entry) => !entry.startsWith("H "))
  ) {
    reject(
      "unsupported_workspace",
      "Clear sparse, skip-worktree and assume-unchanged flags before moving this workspace",
    );
  }
  const shallow = (await runGit(cwd, ["rev-parse", "--is-shallow-repository"])).trim();
  if (shallow !== "false")
    reject("unsupported_workspace", "Fetch full Git history before moving a shallow checkout");
  const config = await runGit(cwd, ["config", "--list"]);
  if (
    /^(?:extensions\.partialclone=|remote\..*\.promisor=true$|core\.sparsecheckout=true$)/m.test(
      config,
    )
  ) {
    reject(
      "unsupported_workspace",
      "Materialize a full checkout before moving a partial or sparse clone",
    );
  }
  for (const marker of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
    "BISECT_LOG",
    "sequencer",
  ]) {
    const markerPath = (await runGit(cwd, ["rev-parse", "--git-path", marker])).trim();
    try {
      await lstat(path.resolve(cwd, markerPath));
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    reject(
      "unsupported_workspace",
      `Finish the in-progress Git operation before moving: ${marker}`,
    );
  }
}

async function validateExternalAttributes(cwd: string): Promise<void> {
  const locations = [(await runGit(cwd, ["rev-parse", "--git-path", "info/attributes"])).trim()];
  for (const variable of ["GIT_ATTR_SYSTEM", "GIT_ATTR_GLOBAL"]) {
    const result = await runGitCommandBytes(["var", variable], {
      cwd,
      acceptExitCodes: [0, 1, 129],
    });
    if (result.exitCode === 129)
      reject(
        "unsupported_workspace",
        "Update Git to a version that reports attribute locations before moving this workspace",
      );
    if (result.exitCode === 0) locations.push(...decodeGitOutput(result).trimEnd().split("\n"));
  }
  for (const location of locations) {
    let stat;
    try {
      stat = await lstat(path.resolve(cwd, location));
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (stat.isFile()) {
      const contents = await readBoundedFile(path.resolve(cwd, location), 1024 * 1024);
      const hasRules = contents
        .toString("utf8")
        .split("\n")
        .some((line) => {
          const text = line.trim();
          return text !== "" && !text.startsWith("#");
        });
      if (!hasRules) continue;
    }
    reject(
      "unsupported_workspace",
      `Move external Git attributes into the workspace's .gitattributes before handoff: ${location}`,
    );
  }
}

async function copyBlob(source: string, capture: BlobCapture): Promise<Blob> {
  const temporary = path.join(capture.directory, `${randomUUID()}.partial`);
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await input.stat();
    if (!before.isFile())
      reject("unsupported_workspace", `Only regular files can be copied: ${source}`);
    const byteLimit = Math.min(capture.maxFileBytes, capture.remainingBytes);
    if (before.size > byteLimit)
      reject("limit_exceeded", `File exceeds remaining handoff byte limit: ${source}`);
    const output = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    try {
      for await (const chunk of input.createReadStream({ autoClose: false })) {
        size += chunk.length;
        if (size > byteLimit)
          reject("limit_exceeded", `File exceeds remaining handoff byte limit: ${source}`);
        hash.update(chunk);
        await output.writeFile(chunk);
      }
      await output.sync();
    } finally {
      await output.close();
    }
    const after = await input.stat();
    const current = await lstat(source);
    const changed =
      before.size !== size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.ino !== current.ino;
    if (changed) reject("source_changed", `File changed while capturing: ${source}`);
    const sha256 = hash.digest("hex");
    await rename(temporary, path.join(capture.directory, sha256));
    capture.remainingBytes -= size;
    return { sha256, size };
  } finally {
    await input.close();
    await rm(temporary, { force: true });
  }
}

interface GitArtifactInput {
  cwd: string;
  args: string[];
  outputPath: string;
  capture: BlobCapture;
}

async function captureGitArtifact(input: GitArtifactInput): Promise<Blob> {
  const result = await runGitCommandToFile(
    ["-c", "core.hooksPath=", "-c", "pack.threads=1", "-c", "pack.windowMemory=32m", ...input.args],
    {
      cwd: input.cwd,
      outputPath: input.outputPath,
      maxOutputBytes: Math.min(input.capture.maxFileBytes, input.capture.remainingBytes),
      envOverlay: { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      timeout: 120_000,
    },
  );
  if (result.truncated)
    reject("limit_exceeded", "Git artifact exceeds remaining handoff byte limit");
  const blob = await copyBlob(input.outputPath, input.capture);
  await rm(input.outputPath);
  return blob;
}

function manifestBlobs(manifest: WorkspaceManifest): Blob[] {
  const blobs: Blob[] = [];
  if (manifest.git) {
    blobs.push(manifest.git.indexPatch);
    if (manifest.git.bundle) blobs.push(manifest.git.bundle);
  }
  for (const file of manifest.files) {
    if (file.kind === "file") blobs.push(file.blob);
  }
  return blobs;
}

function validateManifest(manifest: WorkspaceManifest, limits: WorkspaceSnapshotLimits): void {
  if (manifest.files.length > limits.maxFiles)
    reject("limit_exceeded", "Workspace contains too many files");
  validateFiles(manifest.files);
  if (manifest.git && (manifest.git.head === null) !== (manifest.git.bundle === null))
    reject("invalid_artifact", "History bundle does not match HEAD");
  let total = 0;
  for (const blob of manifestBlobs(manifest)) {
    total += blob.size;
    if (blob.size > limits.maxFileBytes || total > limits.maxTotalBytes)
      reject("limit_exceeded", "Workspace exceeds handoff byte limits");
  }
}

/** Capture only after the handoff owner has fenced and stopped workspace writers. */
export async function captureWorkspace(input: CaptureInput): Promise<WorkspaceManifest> {
  const limits = input.limits ?? WORKSPACE_SNAPSHOT_LIMITS;
  const cwd = await realpath(input.cwd);
  const artifact = path.resolve(input.artifactDirectory);
  const parent = await realpath(path.dirname(artifact));
  if (isWithin(cwd, path.join(parent, path.basename(artifact))))
    reject("unsupported_workspace", "Store the handoff artifact outside the source workspace");
  const before = await getWorkspaceState(cwd, limits, parent);
  if (before.kind === "git") await validateGitCapture(cwd, before.paths);
  await mkdir(artifact, { mode: 0o700 });
  try {
    const blobs = path.join(artifact, "blobs");
    await mkdir(blobs, { mode: 0o700 });
    const capture: BlobCapture = {
      directory: blobs,
      maxFileBytes: limits.maxFileBytes,
      remainingBytes: limits.maxTotalBytes,
    };
    let gitManifest: WorkspaceManifest["git"] = null;
    if (before.kind === "git") {
      const patchPath = path.join(artifact, "index.patch");
      const indexPatch = await captureGitArtifact({
        cwd,
        outputPath: patchPath,
        capture,
        args: [
          "diff",
          "--cached",
          "--binary",
          "--full-index",
          "--no-color",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "--no-ext-diff",
          "--no-textconv",
        ],
      });
      let bundle: Blob | null = null;
      if (before.head) {
        const bundlePath = path.join(artifact, "history.bundle");
        bundle = await captureGitArtifact({
          cwd,
          outputPath: bundlePath,
          capture,
          args: ["bundle", "create", "-", "HEAD"],
        });
      }
      gitManifest = {
        objectFormat: before.objectFormat,
        normalization: before.normalization,
        head: before.head,
        branch: before.branch,
        bundle,
        indexPatch,
        indexFingerprint: createHash("sha256").update(before.index).digest("hex"),
      };
    }
    const files: WorkspaceFile[] = [];
    for (const filePath of before.paths) {
      const absolute = path.join(cwd, filePath);
      let stat;
      try {
        stat = await lstat(absolute);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      const resolvedParent = await realpath(path.dirname(absolute));
      if (!isWithin(cwd, resolvedParent))
        reject("unsupported_workspace", `Path leaves workspace: ${filePath}`);
      if (stat.isSymbolicLink()) {
        files.push({ kind: "symlink", path: filePath, target: await readlink(absolute) });
      } else if (stat.isFile()) {
        const blob = await copyBlob(absolute, capture);
        files.push({ kind: "file", path: filePath, executable: (stat.mode & 0o111) !== 0, blob });
      } else if (stat.isDirectory() && before.kind === "directory") {
        files.push({ kind: "directory", path: filePath });
      } else {
        reject("unsupported_workspace", `Cannot transfer directory or special file: ${filePath}`);
      }
    }
    const after = await getWorkspaceState(cwd, limits, parent);
    if (JSON.stringify(before) !== JSON.stringify(after))
      reject("source_changed", "Workspace state changed during capture");
    const manifest: WorkspaceManifest = {
      version: 1,
      git: gitManifest,
      files,
    };
    validateManifest(manifest, limits);
    await verifySourceFiles(cwd, manifest);
    const finalState = await getWorkspaceState(cwd, limits, parent);
    if (JSON.stringify(before) !== JSON.stringify(finalState))
      reject("source_changed", "Workspace state changed while verifying capture");
    const json = JSON.stringify(manifest);
    if (Buffer.byteLength(json) > limits.maxManifestBytes)
      reject("limit_exceeded", "Workspace manifest exceeds handoff limit");
    await writeFile(path.join(artifact, "manifest.json"), json, { mode: 0o600, flag: "wx" });
    return manifest;
  } catch (error) {
    await rm(artifact, { recursive: true, force: true });
    throw error;
  }
}

async function verifyBlob(filePath: string, blob: Blob): Promise<void> {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== blob.size)
      reject("invalid_artifact", `Blob size mismatch: ${blob.sha256}`);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > blob.size)
        reject("invalid_artifact", `Blob grew during verification: ${blob.sha256}`);
      hash.update(chunk);
    }
    if (size !== blob.size || hash.digest("hex") !== blob.sha256)
      reject("invalid_artifact", `Blob checksum mismatch: ${blob.sha256}`);
  } finally {
    await handle.close();
  }
}

async function readManifest(
  directory: string,
  limits: WorkspaceSnapshotLimits,
): Promise<WorkspaceManifest> {
  const handle = await open(
    path.join(directory, "manifest.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  const chunks: Buffer[] = [];
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limits.maxManifestBytes)
      reject("limit_exceeded", "Invalid workspace manifest size");
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > limits.maxManifestBytes)
        reject("limit_exceeded", "Workspace manifest grew past the byte limit");
      chunks.push(chunk);
    }
  } finally {
    await handle.close();
  }
  return parseManifest(Buffer.concat(chunks), limits);
}

function parseManifest(bytes: Buffer, limits: WorkspaceSnapshotLimits): WorkspaceManifest {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError)
      reject("invalid_artifact", "Malformed workspace manifest JSON");
    throw error;
  }
  const parsed = ManifestSchema.safeParse(value);
  if (!parsed.success) reject("invalid_artifact", "Invalid workspace manifest");
  const manifest = parsed.data;
  validateManifest(manifest, limits);
  return manifest;
}

interface WorkspaceArchiveInput {
  store: HandoffArchiveStore;
  transferId: string;
  limits?: WorkspaceSnapshotLimits;
  expectedManifestDigest?: string;
}

/** Register a stopped source's capture as a durable, self-contained transfer archive. */
export async function packWorkspaceArchive(
  input: WorkspaceArchiveInput & { artifactDirectory: string },
): Promise<HandoffArchiveManifest> {
  const limits = input.limits ?? WORKSPACE_SNAPSHOT_LIMITS;
  const manifestPath = path.join(input.artifactDirectory, "manifest.json");
  const bytes = await readBoundedFile(manifestPath, limits.maxManifestBytes);
  const workspace = parseManifest(bytes, limits);
  const entrypoint = {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
  };
  const blobs = new Map<string, Blob>();
  const files = new Map<string, string>();
  for (const blob of manifestBlobs(workspace)) {
    const previous = blobs.get(blob.sha256);
    if (previous && previous.size !== blob.size)
      reject("invalid_artifact", "Conflicting sizes for a workspace blob");
    blobs.set(blob.sha256, blob);
    files.set(blob.sha256, path.join(input.artifactDirectory, "blobs", blob.sha256));
  }
  blobs.set(entrypoint.sha256, entrypoint);
  files.set(entrypoint.sha256, manifestPath);
  const manifest: HandoffArchiveManifest = { version: 1, entrypoint, blobs: [...blobs.values()] };
  await input.store.importLocal({ id: input.transferId, manifest, files });
  return manifest;
}

/** Materialize private staging only. Workspace publication and agent activation are separate. */
export async function restoreWorkspaceArchive(
  input: WorkspaceArchiveInput & { destination: string },
): Promise<WorkspaceManifest> {
  const limits = input.limits ?? WORKSPACE_SNAPSHOT_LIMITS;
  return input.store.withVerifiedArchive(input.transferId, async ({ manifest, blobsDirectory }) => {
    if (input.expectedManifestDigest && manifest.entrypoint.sha256 !== input.expectedManifestDigest)
      reject("invalid_artifact", "Archive differs from the reserved workspace content");
    if (manifest.entrypoint.size > limits.maxManifestBytes)
      reject("limit_exceeded", "Workspace manifest exceeds handoff limit");
    const workspace = parseManifest(
      await readBoundedFile(
        path.join(blobsDirectory, manifest.entrypoint.sha256),
        limits.maxManifestBytes,
      ),
      limits,
    );
    const inventory = new Map(manifest.blobs.map((blob) => [blob.sha256, blob.size]));
    for (const blob of manifestBlobs(workspace)) {
      if (inventory.get(blob.sha256) !== blob.size)
        reject("invalid_artifact", "Workspace references a blob outside its archive inventory");
    }
    return restoreWorkspaceContents({
      manifest: workspace,
      blobs: blobsDirectory,
      destination: input.destination,
    });
  });
}

export async function restoreWorkspace(input: RestoreInput): Promise<WorkspaceManifest> {
  const limits = input.limits ?? WORKSPACE_SNAPSHOT_LIMITS;
  const manifest = await readManifest(input.artifactDirectory, limits);
  const blobs = path.join(input.artifactDirectory, "blobs");
  return restoreWorkspaceContents({ manifest, blobs, destination: input.destination });
}

async function restoreWorkspaceContents(input: {
  manifest: WorkspaceManifest;
  blobs: string;
  destination: string;
}): Promise<WorkspaceManifest> {
  const { manifest, blobs } = input;
  for (const blob of manifestBlobs(manifest)) await verifyBlob(path.join(blobs, blob.sha256), blob);
  try {
    await mkdir(input.destination, { mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      reject("destination_exists", "Handoff destination already exists");
    throw error;
  }
  try {
    // No checkout: smudge filters, repository hooks and source Git config must not execute.
    if (manifest.git) {
      await runRestoreGit(input.destination, [
        "init",
        "--template=",
        `--object-format=${manifest.git.objectFormat}`,
      ]);
      await validateExternalAttributes(input.destination);
      await runRestoreGit(input.destination, [
        "config",
        "core.autocrlf",
        manifest.git.normalization.autocrlf,
      ]);
      await runRestoreGit(input.destination, [
        "config",
        "core.eol",
        manifest.git.normalization.eol,
      ]);
      if (manifest.git.branch) {
        await runRestoreGit(input.destination, [
          "check-ref-format",
          `refs/heads/${manifest.git.branch}`,
        ]);
        await runRestoreGit(input.destination, [
          "symbolic-ref",
          "HEAD",
          `refs/heads/${manifest.git.branch}`,
        ]);
      }
      if (manifest.git.bundle && manifest.git.head) {
        await runRestoreGit(input.destination, [
          "fetch",
          "--no-tags",
          "--",
          path.resolve(blobs, manifest.git.bundle.sha256),
          "HEAD",
        ]);
        const fetched = (
          await runRestoreGit(input.destination, ["rev-parse", "FETCH_HEAD"])
        ).trim();
        if (fetched !== manifest.git.head)
          reject("invalid_artifact", "Bundle HEAD differs from the manifest");
        if (manifest.git.branch) {
          await runRestoreGit(input.destination, ["update-ref", "HEAD", fetched]);
        } else {
          await runRestoreGit(input.destination, ["update-ref", "--no-deref", "HEAD", fetched]);
        }
        await runRestoreGit(input.destination, ["read-tree", "HEAD"]);
      }
      if (manifest.git.indexPatch.size > 0) {
        await runRestoreGit(input.destination, [
          "apply",
          "--cached",
          "--binary",
          "--",
          path.resolve(blobs, manifest.git.indexPatch.sha256),
        ]);
      }
      const index = await runRestoreGit(input.destination, ["ls-files", "--stage", "-z"]);
      validateIndex(index, "invalid_artifact");
      if (createHash("sha256").update(index).digest("hex") !== manifest.git.indexFingerprint)
        reject("invalid_artifact", "Restored index differs from the source");
    }
    for (const file of manifest.files)
      await restoreFile({ destination: input.destination, blobs, file });
    return manifest;
  } catch (error) {
    await rm(input.destination, { recursive: true, force: true });
    throw error;
  }
}

async function verifySourceFiles(cwd: string, manifest: WorkspaceManifest): Promise<void> {
  try {
    for (const file of manifest.files) {
      const absolute = path.join(cwd, file.path);
      const parent = await realpath(path.dirname(absolute));
      if (!isWithin(cwd, parent))
        reject("source_changed", `Path left workspace during capture: ${file.path}`);
      const stat = await lstat(absolute);
      if (file.kind === "symlink") {
        if (!stat.isSymbolicLink() || (await readlink(absolute)) !== file.target)
          reject("source_changed", `Symlink changed: ${file.path}`);
      } else if (file.kind === "directory") {
        if (!stat.isDirectory()) reject("source_changed", `Directory changed: ${file.path}`);
      } else {
        if (!stat.isFile() || ((stat.mode & 0o111) !== 0) !== file.executable)
          reject("source_changed", `File type or permissions changed: ${file.path}`);
        await verifyBlob(absolute, file.blob);
      }
    }
  } catch (error) {
    if (isMissing(error) || error instanceof HandoffWorkspaceError)
      reject("source_changed", "Workspace files changed after capture");
    throw error;
  }
}

export async function verifyCapturedWorkspace(input: CaptureInput): Promise<void> {
  const limits = input.limits ?? WORKSPACE_SNAPSHOT_LIMITS;
  const cwd = await realpath(input.cwd);
  const manifest = await readManifest(input.artifactDirectory, limits);
  await verifyWorkspaceContents({
    cwd,
    manifest,
    limits,
    scratchParent: path.dirname(path.resolve(input.artifactDirectory)),
  });
}

export async function verifyWorkspaceArchive(
  input: WorkspaceArchiveInput & { cwd: string },
): Promise<void> {
  const limits = input.limits ?? WORKSPACE_SNAPSHOT_LIMITS;
  const cwd = await realpath(input.cwd);
  return input.store.withVerifiedArchive(input.transferId, async ({ manifest, blobsDirectory }) => {
    if (input.expectedManifestDigest && manifest.entrypoint.sha256 !== input.expectedManifestDigest)
      reject("invalid_artifact", "Archive differs from the reserved workspace content");
    const bytes = await readBoundedFile(
      path.join(blobsDirectory, manifest.entrypoint.sha256),
      limits.maxManifestBytes,
    );
    const workspace = parseManifest(bytes, limits);
    await verifyWorkspaceContents({
      cwd,
      manifest: workspace,
      limits,
      scratchParent: path.dirname(cwd),
    });
  });
}

interface VerifyWorkspaceContentsInput {
  cwd: string;
  manifest: WorkspaceManifest;
  limits: WorkspaceSnapshotLimits;
  scratchParent: string;
}

async function verifyWorkspaceContents({
  cwd,
  manifest,
  limits,
  scratchParent,
}: VerifyWorkspaceContentsInput): Promise<void> {
  const state = await getWorkspaceState(cwd, limits, scratchParent);
  if ((state.kind === "git") !== (manifest.git !== null))
    reject("source_changed", "Workspace Git ownership changed after capture");
  if (state.kind === "git" && manifest.git) {
    const index = createHash("sha256").update(state.index).digest("hex");
    if (
      state.head !== manifest.git.head ||
      state.branch !== manifest.git.branch ||
      JSON.stringify(state.normalization) !== JSON.stringify(manifest.git.normalization) ||
      index !== manifest.git.indexFingerprint
    ) {
      reject("source_changed", "Git state changed after capture");
    }
  }
  const capturedPaths = new Set(manifest.files.map((file) => file.path));
  for (const candidate of state.paths) {
    if (capturedPaths.has(candidate)) continue;
    try {
      await lstat(path.join(cwd, candidate));
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    reject("source_changed", `File appeared after capture: ${candidate}`);
  }
  if (state.kind === "git") await validateGitCapture(cwd, state.paths);
  await verifySourceFiles(cwd, manifest);
}

interface RestoreFileInput {
  destination: string;
  blobs: string;
  file: WorkspaceFile;
}

async function restoreFile({ destination, blobs, file }: RestoreFileInput): Promise<void> {
  const target = path.join(destination, file.path);
  if (file.kind === "directory") {
    await mkdir(target, { recursive: true, mode: 0o700 });
    return;
  }
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  if (file.kind === "symlink") {
    await symlink(file.target, target);
    return;
  }
  const source = await open(
    path.join(blobs, file.blob.sha256),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const output = await open(target, "wx", 0o600);
    try {
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of source.createReadStream({ autoClose: false })) {
        size += chunk.length;
        if (size > file.blob.size)
          reject("invalid_artifact", `Blob grew during restore: ${file.path}`);
        hash.update(chunk);
        await output.writeFile(chunk);
      }
      if (size !== file.blob.size || hash.digest("hex") !== file.blob.sha256)
        reject("invalid_artifact", `Blob changed during restore: ${file.path}`);
      await output.sync();
    } finally {
      await output.close();
    }
  } finally {
    await source.close();
  }
  await chmod(target, file.executable ? 0o755 : 0o644);
}
