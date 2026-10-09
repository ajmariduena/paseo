import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  HandoffBlobSchema,
  type HandoffArchiveManifest,
  type HandoffBlob,
} from "@getpaseo/protocol/handoff";
import type { HandoffArchiveStore, VerifiedHandoffArchive } from "./archive.js";
import { readBoundedFile, writeJournal } from "./artifacts.js";
import { workspaceArchiveFiles } from "./workspace.js";
import { HANDOFF_HISTORY_MAX_BYTES, readHandoffHistory } from "./history.js";
import {
  readClaudeSessionArchive,
  readClaudeSessionManifest,
  type ClaudeSessionArchive,
} from "../agent/providers/claude/handoff.js";

const ConversationSchema = z.object({
  sourceAgentId: z.string().min(1).max(512),
  title: z.string().max(4096).nullable(),
  provider: z.literal("claude"),
  mode: z.literal("native"),
  session: HandoffBlobSchema,
  history: HandoffBlobSchema.optional(),
});
const BundleSchema = z.object({
  version: z.literal(1),
  kind: z.literal("workspace_handoff"),
  sourceServerId: z.string().min(1).max(512),
  sourceWorkspaceId: z.string().min(1).max(512),
  sourceCwd: z.string().min(1).max(8192),
  workspace: HandoffBlobSchema,
  conversations: z.array(ConversationSchema).max(1000),
});
export type HandoffBundle = z.infer<typeof BundleSchema>;
export interface CapturedConversation {
  sourceAgentId: string;
  title: string | null;
  artifactDirectory: string;
  historyPath?: string;
}
interface PackInput {
  store: HandoffArchiveStore;
  transferId: string;
  sourceServerId: string;
  sourceWorkspaceId: string;
  sourceCwd: string;
  workspaceDirectory: string;
  conversations: CapturedConversation[];
}
export interface HandoffBundleExpectation {
  sourceServerId: string;
  sourceWorkspaceId: string;
  sourceAgentIds: string[];
  manifestDigest: string;
}
export interface VerifiedHandoffBundle {
  bundle: HandoffBundle;
  sessions: ReadonlyMap<string, ClaudeSessionArchive>;
}
export class HandoffBundleError extends Error {
  constructor(
    readonly code: "invalid_artifact" | "conversation_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "HandoffBundleError";
  }
}
function reject(code: HandoffBundleError["code"], message: string): never {
  throw new HandoffBundleError(code, message);
}
function parseBundle(value: unknown): HandoffBundle {
  const result = BundleSchema.safeParse(value);
  if (!result.success)
    reject("invalid_artifact", "Invalid workspace and conversation handoff manifest");
  const bundle = result.data;
  const ids = bundle.conversations.map((item) => item.sourceAgentId);
  if (new Set(ids).size !== ids.length)
    reject("conversation_mismatch", "Duplicate conversation in handoff");
  bundle.conversations.sort((a, b) => a.sourceAgentId.localeCompare(b.sourceAgentId));
  return bundle;
}

/** One digest binds the workspace and every conversation; there is no separate release for history. */
export async function packHandoffArchive(input: PackInput): Promise<HandoffArchiveManifest> {
  const workspace = await workspaceArchiveFiles({ artifactDirectory: input.workspaceDirectory });
  const blobs = new Map(workspace.manifest.blobs.map((blob) => [blob.sha256, blob]));
  const files = new Map(workspace.files);
  const conversations: HandoffBundle["conversations"] = [];
  for (const conversation of input.conversations) {
    const session = await readClaudeSessionArchive(conversation.artifactDirectory);
    for (const file of session.files)
      add(file.blob, path.join(conversation.artifactDirectory, "blobs", file.blob.sha256));
    const manifestPath = path.join(conversation.artifactDirectory, "manifest.json");
    const descriptor = await describeFile(manifestPath);
    add(descriptor, manifestPath);
    let history;
    if (conversation.historyPath) {
      await readHandoffHistory(conversation.historyPath, conversation.sourceAgentId);
      history = await describeFile(conversation.historyPath, HANDOFF_HISTORY_MAX_BYTES);
      add(history, conversation.historyPath);
    }
    conversations.push({
      sourceAgentId: conversation.sourceAgentId,
      title: conversation.title,
      provider: "claude",
      mode: "native",
      session: descriptor,
      ...(history ? { history } : {}),
    });
  }
  const bundle = parseBundle({
    version: 1,
    kind: "workspace_handoff",
    sourceServerId: input.sourceServerId,
    sourceWorkspaceId: input.sourceWorkspaceId,
    sourceCwd: input.sourceCwd,
    workspace: workspace.manifest.entrypoint,
    conversations,
  });
  const temporary = await mkdtemp(path.join(os.tmpdir(), "paseo-handoff-bundle-"));
  try {
    const manifestPath = path.join(temporary, "handoff.json");
    await writeJournal(manifestPath, bundle);
    const entrypoint = await describeFile(manifestPath);
    add(entrypoint, manifestPath);
    const manifest: HandoffArchiveManifest = { version: 1, entrypoint, blobs: [...blobs.values()] };
    await input.store.importLocal({ id: input.transferId, manifest, files });
    return manifest;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  function add(blob: HandoffBlob, file: string): void {
    const existing = blobs.get(blob.sha256);
    if (existing && existing.size !== blob.size)
      reject("invalid_artifact", "Conflicting handoff blob sizes");
    blobs.set(blob.sha256, blob);
    files.set(blob.sha256, file);
  }
}
async function describeFile(file: string, maxBytes = 4 * 1024 * 1024): Promise<HandoffBlob> {
  const bytes = await readBoundedFile(file, maxBytes);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}

export async function readHandoffBundle(
  archive: VerifiedHandoffArchive,
  expected: HandoffBundleExpectation,
): Promise<VerifiedHandoffBundle> {
  if (archive.manifest.entrypoint.sha256 !== expected.manifestDigest)
    reject("invalid_artifact", "Archive differs from the destination reservation");
  const bytes = await readBoundedFile(
    path.join(archive.blobsDirectory, archive.manifest.entrypoint.sha256),
    4 * 1024 * 1024,
  );
  const bundle = parseBundle(JSON.parse(bytes.toString("utf8")));
  if (
    bundle.sourceServerId !== expected.sourceServerId ||
    bundle.sourceWorkspaceId !== expected.sourceWorkspaceId
  )
    reject("invalid_artifact", "Handoff belongs to a different source workspace");
  const sourceAgentIds = bundle.conversations
    .map((conversation) => conversation.sourceAgentId)
    .sort();
  if (JSON.stringify(sourceAgentIds) !== JSON.stringify([...expected.sourceAgentIds].sort()))
    reject("conversation_mismatch", "Handoff does not contain exactly the reserved conversations");
  const inventory = new Map(archive.manifest.blobs.map((blob) => [blob.sha256, blob.size]));
  requireBlob(bundle.workspace);
  const sessions = new Map<string, ClaudeSessionArchive>();
  let metadataBytes = bytes.length;
  let artifactCount = 0;
  for (const conversation of bundle.conversations) {
    requireBlob(conversation.session);
    if (conversation.history) {
      requireBlob(conversation.history);
      await readHandoffHistory(
        path.join(archive.blobsDirectory, conversation.history.sha256),
        conversation.sourceAgentId,
      );
    }
    metadataBytes += conversation.session.size;
    if (metadataBytes > 20 * 1024 * 1024)
      reject("invalid_artifact", "Conversation manifests exceed the handoff metadata limit");
    const session = await readClaudeSessionManifest(
      path.join(archive.blobsDirectory, conversation.session.sha256),
    );
    artifactCount += session.files.length;
    if (artifactCount > 100_000)
      reject("invalid_artifact", "Too many conversation artifacts in handoff");
    for (const file of session.files) requireBlob(file.blob);
    sessions.set(conversation.sourceAgentId, session);
  }
  return { bundle, sessions };
  function requireBlob(blob: HandoffBlob): void {
    if (inventory.get(blob.sha256) !== blob.size)
      reject("invalid_artifact", "Handoff references content outside its verified archive");
  }
}
