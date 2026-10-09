import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import os from "node:os";
import type { Logger } from "pino";
import path from "node:path";
import { z } from "zod";
import { HandoffBlobSchema } from "@getpaseo/protocol/handoff";
import type { AgentPersistenceHandle, AgentStreamEvent } from "../../agent-sdk-types.js";
import { readBoundedFile, syncDirectory, writeJournal } from "../../../handoff/artifacts.js";
import { claudeTranscriptPathSync } from "./project-dir.js";
import { ClaudeAgentClient } from "./agent.js";

const UUID = z.string().uuid();
const ManifestSchema = z.object({
  version: z.literal(1),
  provider: z.literal("claude"),
  sessionId: UUID,
  cliVersion: z.string().regex(/^2\.1\.\d+$/),
  files: z
    .array(z.object({ path: z.string(), blob: HandoffBlobSchema }))
    .min(1)
    .max(10_000),
});
export type ClaudeSessionArchive = z.infer<typeof ManifestSchema>;

export interface ClaudeSessionArchiveLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
}
const DEFAULT_LIMITS: ClaudeSessionArchiveLimits = {
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxFiles: 10_000,
};

export class ClaudeSessionArchiveError extends Error {
  constructor(
    readonly code:
      | "invalid_artifact"
      | "source_changed"
      | "limit_exceeded"
      | "native_incompatible"
      | "destination_exists",
    message: string,
  ) {
    super(message);
    this.name = "ClaudeSessionArchiveError";
  }
}

interface SourceInput {
  handle: AgentPersistenceHandle;
  cwd: string;
  configDir: string;
  cliVersion: string;
  artifactDirectory: string;
  limits?: ClaudeSessionArchiveLimits;
}
interface InstallTarget {
  configDir: string;
  cwd: string;
  importId: string;
  cliVersion: string;
  limits?: ClaudeSessionArchiveLimits;
}
interface InstallInput extends InstallTarget {
  artifactDirectory: string;
}
interface InstallArchiveInput extends InstallTarget {
  manifest: ClaudeSessionArchive;
  blobsDirectory: string;
}

function reject(code: ClaudeSessionArchiveError["code"], message: string): never {
  throw new ClaudeSessionArchiveError(code, message);
}
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
async function isPresent(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
function digest(bytes: Buffer) {
  return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}
function validateArtifactPath(value: string): void {
  if (value === "transcript.jsonl") return;
  const segments = value.split("/");
  const validRoot = segments[0] === "session" && ["subagents", "workflows"].includes(segments[1]);
  if (
    !validRoot ||
    segments.length < 3 ||
    segments.length > 32 ||
    segments.slice(0, -1).some((segment) => !/^[a-zA-Z0-9_-]{1,200}$/.test(segment)) ||
    segments.some((segment) => !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,199}$/.test(segment)) ||
    !(value.endsWith(".jsonl") || value.endsWith(".json"))
  ) {
    reject("invalid_artifact", `Unsupported Claude session artifact: ${value}`);
  }
}
function validateTranscript(bytes: Buffer, sessionId: string, file: string): void {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const lines = file.endsWith(".jsonl") ? text.split("\n").filter((line) => line.trim()) : [text];
    if (lines.length === 0) reject("invalid_artifact", `Empty Claude session artifact: ${file}`);
    for (const line of lines) {
      const record: unknown = JSON.parse(line);
      if (record === null || typeof record !== "object" || Array.isArray(record)) {
        reject("invalid_artifact", `Invalid Claude session record: ${file}`);
      }
      if (file === "transcript.jsonl" && "sessionId" in record && record.sessionId !== sessionId) {
        reject("invalid_artifact", "Claude transcript belongs to another session");
      }
    }
  } catch (error) {
    if (error instanceof ClaudeSessionArchiveError) throw error;
    reject("invalid_artifact", `Unreadable Claude session artifact: ${file}`);
  }
}
function validateManifest(
  value: unknown,
  limits: ClaudeSessionArchiveLimits,
): ClaudeSessionArchive {
  const parsed = ManifestSchema.safeParse(value);
  if (!parsed.success) reject("invalid_artifact", "Invalid Claude session archive manifest");
  const manifest = parsed.data;
  const paths = new Set<string>();
  let total = 0;
  for (const file of manifest.files) {
    validateArtifactPath(file.path);
    const key = file.path.toLowerCase();
    if (paths.has(key)) reject("invalid_artifact", "Duplicate Claude session artifact");
    paths.add(key);
    total += file.blob.size;
    if (file.blob.size > limits.maxFileBytes)
      reject("limit_exceeded", "Claude session file exceeds limit");
  }
  if (!paths.has("transcript.jsonl")) reject("invalid_artifact", "Claude transcript is missing");
  if (manifest.files.length > limits.maxFiles || total > limits.maxTotalBytes) {
    reject("limit_exceeded", "Claude session archive exceeds limits");
  }
  if (Buffer.byteLength(JSON.stringify(manifest)) > 4 * 1024 * 1024) {
    reject("limit_exceeded", "Claude session manifest exceeds limit");
  }
  manifest.files.sort((a, b) => a.path.localeCompare(b.path));
  return manifest;
}
async function sourceFiles(
  input: Omit<SourceInput, "artifactDirectory">,
): Promise<Map<string, string>> {
  UUID.parse(input.handle.sessionId);
  if (input.handle.provider !== "claude") reject("invalid_artifact", "Expected a Claude session");
  const namespace = input.handle.metadata?.claudeProjectDirName;
  if (namespace !== undefined && typeof namespace !== "string")
    reject("invalid_artifact", "Invalid Claude session namespace");
  const transcript = claudeTranscriptPathSync({
    cwd: input.cwd,
    sessionId: input.handle.sessionId,
    configDir: input.configDir,
    projectDirName: namespace,
  });
  const project = await lstat(path.dirname(transcript));
  if (!project.isDirectory() || project.isSymbolicLink())
    reject("invalid_artifact", "Claude project directory must be a directory");
  const transcriptStat = await lstat(transcript);
  if (!transcriptStat.isFile() || transcriptStat.isSymbolicLink())
    reject("invalid_artifact", "Claude transcript must be a regular file");
  const files = new Map([["transcript.jsonl", transcript]]);
  const sessionDirectory = path.join(path.dirname(transcript), input.handle.sessionId);
  if (await isPresent(sessionDirectory)) await visit(sessionDirectory, "session");
  return files;

  async function visit(directory: string, relative: string): Promise<void> {
    if (relative.split("/").length > 32)
      reject("limit_exceeded", "Claude session directory exceeds depth limit");
    if (relative !== "session") validateArtifactPath(`${relative}/entry.json`);
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      reject("invalid_artifact", "Claude session directories cannot be links");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute, name);
      } else {
        validateArtifactPath(name);
        if (!entry.isFile() || entry.isSymbolicLink())
          reject("invalid_artifact", "Claude session artifacts must be regular files");
        files.set(name, absolute);
        if (files.size > (input.limits ?? DEFAULT_LIMITS).maxFiles)
          reject("limit_exceeded", "Too many Claude session artifacts");
      }
    }
  }
}

/** A live inspection is advisory; capture validates the stopped session again. */
export async function previewClaudeSession(input: Omit<SourceInput, "artifactDirectory">) {
  if (!/^2\.1\.\d+$/.test(input.cliVersion))
    reject("invalid_artifact", "This Claude version has no tested source export format");
  try {
    const files = await sourceFiles(input);
    const limits = input.limits ?? DEFAULT_LIMITS;
    let artifactBytes = 0;
    for (const file of files.values()) {
      const stat = await lstat(file);
      if (!stat.isFile())
        reject("invalid_artifact", "Claude session artifact changed during review");
      artifactBytes += stat.size;
      if (stat.size > limits.maxFileBytes || artifactBytes > limits.maxTotalBytes)
        reject("limit_exceeded", "Claude session exceeds handoff byte limits");
    }
    return {
      cliVersion: input.cliVersion,
      hasWorkflows: [...files.keys()].some((file) => file.startsWith("session/workflows/")),
      artifactBytes,
    };
  } catch (error) {
    if (missing(error))
      reject("invalid_artifact", "Saved Claude session files are missing on the source host");
    throw error;
  }
}

export function claudeNativeHandoffReason(input: {
  sourceVersion: string;
  destinationVersion: string;
  hasWorkflows: boolean;
}): string | null {
  const version = /^2\.1\.(\d+)$/.exec(input.destinationVersion);
  if (!version || Number(version[1]) < 295 || input.sourceVersion !== input.destinationVersion)
    return "Native Claude handoff requires matching Claude Code versions, at least 2.1.295";
  if (input.hasWorkflows)
    return "Claude workflow state needs an explicit disposition before native continuation";
  return null;
}

/** The caller must stop the source runtime and drain persistence before capture. */
export async function captureClaudeSession(input: SourceInput): Promise<ClaudeSessionArchive> {
  const limits = input.limits ?? DEFAULT_LIMITS;
  const sources = await sourceFiles(input);
  await mkdir(input.artifactDirectory, { mode: 0o700 });
  const blobDirectory = path.join(input.artifactDirectory, "blobs");
  await mkdir(blobDirectory, { mode: 0o700 });
  try {
    const files: ClaudeSessionArchive["files"] = [];
    let total = 0;
    for (const [name, source] of sources) {
      const bytes = await readBoundedFile(
        source,
        Math.min(limits.maxFileBytes, limits.maxTotalBytes - total),
      );
      validateTranscript(bytes, input.handle.sessionId, name);
      total += bytes.length;
      const blob = digest(bytes);
      const destination = path.join(blobDirectory, blob.sha256);
      if (!(await isPresent(destination))) await writeBytes(destination, bytes);
      files.push({ path: name, blob });
    }
    const manifest = validateManifest(
      {
        version: 1,
        provider: "claude",
        sessionId: input.handle.sessionId,
        cliVersion: input.cliVersion,
        files,
      },
      limits,
    );
    await writeJournal(path.join(input.artifactDirectory, "manifest.json"), manifest);
    await syncDirectory(blobDirectory);
    await syncDirectory(input.artifactDirectory);
    await syncDirectory(path.dirname(input.artifactDirectory));
    await verifyCapturedClaudeSession(input);
    return manifest;
  } catch (error) {
    await rm(input.artifactDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function readClaudeSessionArchive(
  artifactDirectory: string,
  limits = DEFAULT_LIMITS,
): Promise<ClaudeSessionArchive> {
  return readClaudeSessionManifest(path.join(artifactDirectory, "manifest.json"), limits);
}

/** Decode the captured bytes without registering an agent or starting a provider process. */
export async function readCapturedClaudeHistory(input: {
  artifactDirectory: string;
  cwd: string;
  logger: Logger;
}) {
  const manifest = await readClaudeSessionArchive(input.artifactDirectory);
  const configDir = await mkdtemp(path.join(os.tmpdir(), "paseo-handoff-history-"));
  try {
    // Decoding an isolated copy does not resume its workflow or require native import compatibility.
    const handle = await materializeClaudeSessionArchive({
      ...input,
      manifest,
      blobsDirectory: path.join(input.artifactDirectory, "blobs"),
      configDir,
      importId: manifest.sessionId,
    });
    const reader = await new ClaudeAgentClient({
      logger: input.logger,
      runtimeSettings: { env: { CLAUDE_CONFIG_DIR: configDir } },
      queryFactory: () => {
        throw new Error("Handoff history cannot start a provider runtime");
      },
    }).resumeSession(handle, { cwd: input.cwd });
    try {
      const history: AgentStreamEvent[] = [];
      for await (const event of reader.streamHistory()) history.push(event);
      return history;
    } finally {
      await reader.close();
    }
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}

export async function readClaudeSessionManifest(
  manifestPath: string,
  limits = DEFAULT_LIMITS,
): Promise<ClaudeSessionArchive> {
  const bytes = await readBoundedFile(manifestPath, 4 * 1024 * 1024);
  return validateManifest(JSON.parse(bytes.toString("utf8")), limits);
}

export async function verifyCapturedClaudeSession(input: SourceInput): Promise<void> {
  const limits = input.limits ?? DEFAULT_LIMITS;
  const manifest = await readClaudeSessionArchive(input.artifactDirectory, limits);
  const sources = await sourceFiles(input);
  if (sources.size !== manifest.files.length || input.handle.sessionId !== manifest.sessionId)
    reject("source_changed", "Claude session inventory changed after capture");
  for (const file of manifest.files) {
    const source = sources.get(file.path);
    if (!source) reject("source_changed", "Claude session artifact disappeared");
    const bytes = await readBoundedFile(source, limits.maxFileBytes);
    if (digest(bytes).sha256 !== file.blob.sha256)
      reject("source_changed", "Claude session changed after capture");
  }
}

/** Installs no credentials, settings or processes. importId is allocated and journaled by the destination. */
export async function installClaudeSession(input: InstallInput): Promise<AgentPersistenceHandle> {
  const limits = input.limits ?? DEFAULT_LIMITS;
  const manifest = await readClaudeSessionArchive(input.artifactDirectory, limits);
  return installClaudeSessionArchive({
    ...input,
    manifest,
    blobsDirectory: path.join(input.artifactDirectory, "blobs"),
  });
}

export async function installClaudeSessionArchive(
  input: InstallArchiveInput,
): Promise<AgentPersistenceHandle> {
  UUID.parse(input.importId);
  const limits = input.limits ?? DEFAULT_LIMITS;
  const manifest = validateManifest(input.manifest, limits);
  const incompatibility = claudeNativeHandoffReason({
    sourceVersion: manifest.cliVersion,
    destinationVersion: input.cliVersion,
    hasWorkflows: manifest.files.some((file) => file.path.startsWith("session/workflows/")),
  });
  if (incompatibility) reject("native_incompatible", incompatibility);
  return materializeClaudeSessionArchive({ ...input, manifest });
}

async function materializeClaudeSessionArchive(
  input: Omit<InstallArchiveInput, "cliVersion">,
): Promise<AgentPersistenceHandle> {
  UUID.parse(input.importId);
  const limits = input.limits ?? DEFAULT_LIMITS;
  const manifest = validateManifest(input.manifest, limits);
  const projectDirName = `paseo-handoff-${input.importId}`;
  const projects = path.join(input.configDir, "projects");
  await mkdir(projects, { recursive: true, mode: 0o700 });
  const destination = path.join(projects, projectDirName);
  if (await isPresent(destination)) {
    await verifyClaudeSessionInstallation(input);
  } else {
    const staging = path.join(projects, `.paseo-import-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    try {
      for (const file of manifest.files) {
        const bytes = await readBoundedFile(
          path.join(input.blobsDirectory, file.blob.sha256),
          limits.maxFileBytes,
        );
        if (bytes.length !== file.blob.size || digest(bytes).sha256 !== file.blob.sha256)
          reject("invalid_artifact", "Claude session blob checksum mismatch");
        validateTranscript(bytes, manifest.sessionId, file.path);
        const target = installedPath(staging, manifest.sessionId, file.path);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await writeBytes(target, bytes);
      }
      await writeJournal(path.join(staging, ".paseo-handoff.json"), manifest);
      await syncTree(staging);
      await rename(staging, destination);
      await syncDirectory(projects);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  return {
    provider: "claude",
    sessionId: manifest.sessionId,
    nativeHandle: manifest.sessionId,
    metadata: { cwd: input.cwd, claudeProjectDirName: projectDirName },
  };
}

export async function verifyClaudeSessionInstallation(
  input: Pick<InstallArchiveInput, "configDir" | "importId" | "manifest" | "limits">,
): Promise<void> {
  UUID.parse(input.importId);
  const limits = input.limits ?? DEFAULT_LIMITS;
  const manifest = validateManifest(input.manifest, limits);
  const destination = path.join(input.configDir, "projects", `paseo-handoff-${input.importId}`);
  const stat = await lstat(destination);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    reject("destination_exists", "Claude handoff namespace is already occupied");
  const marker = path.join(destination, ".paseo-handoff.json");
  if (!(await isPresent(marker)))
    reject("destination_exists", "Claude handoff namespace is not owned by this handoff");
  const record = await readBoundedFile(marker, 4 * 1024 * 1024);
  if (record.toString("utf8") !== JSON.stringify(manifest))
    reject("destination_exists", "Claude handoff namespace is already occupied");
  await verifyInstalled(destination, manifest, limits);
}

export async function removeClaudeSessionInstallation(
  input: Pick<InstallArchiveInput, "configDir" | "importId" | "manifest">,
): Promise<void> {
  UUID.parse(input.importId);
  const project = path.join(input.configDir, "projects", `paseo-handoff-${input.importId}`);
  if (!(await isPresent(project))) return;
  const stat = await lstat(project);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    reject("destination_exists", "Claude handoff namespace is not owned by this handoff");
  const marker = await readBoundedFile(path.join(project, ".paseo-handoff.json"), 4 * 1024 * 1024);
  if (marker.toString("utf8") !== JSON.stringify(validateManifest(input.manifest, DEFAULT_LIMITS)))
    reject("destination_exists", "Claude handoff namespace is not owned by this handoff");
  await rm(project, { recursive: true });
  await syncDirectory(path.dirname(project));
}
function installedPath(project: string, sessionId: string, file: string): string {
  return file === "transcript.jsonl"
    ? path.join(project, `${sessionId}.jsonl`)
    : path.join(project, sessionId, ...file.split("/").slice(1));
}
async function verifyInstalled(
  project: string,
  manifest: ClaudeSessionArchive,
  limits: ClaudeSessionArchiveLimits,
): Promise<void> {
  const stat = await lstat(project);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    reject("destination_exists", "Claude import directory is not owned by this handoff");
  for (const file of manifest.files) {
    const bytes = await readBoundedFile(
      installedPath(project, manifest.sessionId, file.path),
      limits.maxFileBytes,
    );
    if (bytes.length !== file.blob.size || digest(bytes).sha256 !== file.blob.sha256)
      reject("destination_exists", "Installed Claude session has changed");
  }
}
async function writeBytes(filePath: string, bytes: Buffer): Promise<void> {
  const file = await open(filePath, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}
async function syncTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await syncTree(path.join(directory, entry.name));
  }
  await syncDirectory(directory);
}
