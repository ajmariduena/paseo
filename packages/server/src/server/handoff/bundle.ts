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
import {
  HANDOFF_SCHEDULE_MAX_BYTES,
  readHandoffSchedules,
  type HandoffSchedules,
} from "../schedule/handoff.js";
import { workspaceArchiveFiles } from "./workspace.js";
import { HANDOFF_HISTORY_MAX_BYTES, readHandoffHistory, parseHandoffHistory } from "./history.js";
import { RestartCancelledWorkSchema, type RestartCancelledWork } from "../agent/agent-storage.js";
import {
  HANDOFF_QUEUE_MAX_BYTES,
  readHandoffQueue,
  assertHandoffQueueWorkspace,
  type HandoffQueue,
} from "../agent-queue/store.js";
import {
  readClaudeSessionArchive,
  readClaudeSessionManifest,
  type ClaudeSessionArchive,
} from "../agent/providers/claude/handoff.js";

import {
  HandoffHistoryOriginSchema,
  HandoffHistorySegmentSchema,
  HANDOFF_PREVIOUS_SEGMENTS_MAX,
  HANDOFF_HISTORY_INDEX_MAX_BYTES,
  validateHistorySegments,
  readHistoryIndex,
  type HandoffHistorySegment,
} from "./history-segments.js";
export { HandoffHistoryOriginSchema } from "./history-segments.js";

const ConversationSchema = z.object({
  sourceAgentId: z.string().min(1).max(512),
  title: z.string().max(4096).nullable(),
  provider: z.literal("claude"),
  mode: z.enum(["native", "context"]),
  session: HandoffBlobSchema,
  history: HandoffBlobSchema.optional(),
  pendingRestartNote: z.array(RestartCancelledWorkSchema).max(1024).optional(),
  origin: HandoffHistoryOriginSchema.optional(),
  previous: z.array(HandoffHistorySegmentSchema).max(HANDOFF_PREVIOUS_SEGMENTS_MAX).optional(),
  historyIndex: HandoffBlobSchema.optional(),
  queue: HandoffBlobSchema.optional(),
});
const BundleSchema = z.object({
  // COMPAT(handoffBundleLegacy): added in v0.11.1, remove after 2027-04-10 once retained transfers use v5.
  version: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  kind: z.literal("workspace_handoff"),
  sourceServerId: z.string().min(1).max(512),
  sourceWorkspaceId: z.string().min(1).max(512),
  sourceCwd: z.string().min(1).max(8192),
  workspace: HandoffBlobSchema,
  conversations: z.array(ConversationSchema).max(1000),
  schedules: HandoffBlobSchema.optional(),
});
export type HandoffBundle = z.infer<typeof BundleSchema>;
export interface CapturedConversation {
  sourceAgentId: string;
  title: string | null;
  artifactDirectory: string;
  historyPath?: string;
  queuePath?: string;
  queueBlobsDirectory?: string;
  pendingRestartNote?: RestartCancelledWork[];
  mode?: "native" | "context";
  origin?: z.infer<typeof HandoffHistoryOriginSchema>;
  previous?: CapturedPreviousSegment[];
}

export interface CapturedPreviousSegment {
  segment: HandoffHistorySegment;
  manifest: ClaudeSessionArchive;
  blobsDirectory: string;
}

export function conversationHistorySegments(
  bundle: HandoffBundle,
  conversation: HandoffBundle["conversations"][number],
): HandoffHistorySegment[] {
  if (!conversation.history) throw new Error("Conversation has no captured readable history");
  return [
    ...(conversation.previous ?? []),
    {
      origin: handoffConversationOrigin(bundle, conversation),
      history: conversation.history,
      session: conversation.session,
    },
  ];
}

export function handoffConversationOrigin(
  bundle: HandoffBundle,
  conversation: HandoffBundle["conversations"][number],
) {
  return (
    conversation.origin ?? {
      sourceServerId: bundle.sourceServerId,
      sourceWorkspaceId: bundle.sourceWorkspaceId,
      sourceAgentId: conversation.sourceAgentId,
      sourceCwd: bundle.sourceCwd,
    }
  );
}
interface PackInput {
  store: HandoffArchiveStore;
  transferId: string;
  sourceServerId: string;
  sourceWorkspaceId: string;
  sourceCwd: string;
  workspaceDirectory: string;
  conversations: CapturedConversation[];
  schedulesPath?: string;
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
  previousSessions: ReadonlyMap<string, ClaudeSessionArchive>;
  queues: ReadonlyMap<string, HandoffQueue>;
  schedules: HandoffSchedules;
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
  if ((bundle.version === 5) !== (bundle.schedules !== undefined))
    reject("invalid_artifact", "Scheduled automation requires a version 5 handoff snapshot");
  const carriesNotes = bundle.conversations.some((item) => item.pendingRestartNote !== undefined);
  // Version 1 readers ignore unknown fields. Version 2 makes them refuse rather than lose notes.
  if (bundle.version === 1 && carriesNotes)
    reject("invalid_artifact", "Pending restart notes require handoff bundle version 2");
  for (const conversation of bundle.conversations) validateConversation(bundle, conversation);
  const ids = bundle.conversations.map((item) => item.sourceAgentId);
  if (new Set(ids).size !== ids.length)
    reject("conversation_mismatch", "Duplicate conversation in handoff");
  bundle.conversations.sort((a, b) => a.sourceAgentId.localeCompare(b.sourceAgentId));
  return bundle;
}

function validateConversation(
  bundle: HandoffBundle,
  conversation: HandoffBundle["conversations"][number],
): void {
  requireQueueVersion(bundle.version, conversation.queue);
  if (
    conversation.mode === "context" &&
    (bundle.version === 1 || !conversation.origin || !conversation.history)
  )
    reject(
      "invalid_artifact",
      "Context-only conversation requires its original history and provenance",
    );
  if (conversation.mode === "native" && conversation.origin)
    reject("invalid_artifact", "Native history cannot replace its source identity");
  if (conversation.previous?.length) {
    if (bundle.version < 3 || !conversation.historyIndex)
      reject(
        "invalid_artifact",
        "Earlier conversation segments require handoff bundle version 3 and an index",
      );
    validateHistorySegments(conversationHistorySegments(bundle, conversation));
  } else if (conversation.historyIndex) {
    reject("invalid_artifact", "Conversation history index has no earlier segments");
  }
  const noteIds = conversation.pendingRestartNote?.map((note) => note.id) ?? [];
  if (new Set(noteIds).size !== noteIds.length)
    reject("invalid_artifact", "Duplicate pending restart note in handoff");
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
    const queue = await addQueue(conversation.queuePath, conversation.queueBlobsDirectory);
    if (conversation.historyPath) {
      await readHandoffHistory(
        conversation.historyPath,
        conversation.origin?.sourceAgentId ?? conversation.sourceAgentId,
      );
      history = await describeFile(conversation.historyPath, HANDOFF_HISTORY_MAX_BYTES);
      add(history, conversation.historyPath);
    }
    for (const previous of conversation.previous ?? []) {
      add(
        previous.segment.session,
        path.join(previous.blobsDirectory, previous.segment.session.sha256),
      );
      add(
        previous.segment.history,
        path.join(previous.blobsDirectory, previous.segment.history.sha256),
      );
      for (const file of previous.manifest.files)
        add(file.blob, path.join(previous.blobsDirectory, file.blob.sha256));
    }
    conversations.push({
      sourceAgentId: conversation.sourceAgentId,
      title: conversation.title,
      provider: "claude",
      mode: conversation.mode ?? "native",
      session: descriptor,
      ...(history ? { history } : {}),
      queue,
      ...(conversation.origin ? { origin: conversation.origin } : {}),
      ...(conversation.previous?.length
        ? { previous: conversation.previous.map((item) => item.segment) }
        : {}),
      ...(conversation.pendingRestartNote?.length
        ? { pendingRestartNote: conversation.pendingRestartNote }
        : {}),
    });
  }
  const schedules = await addSchedules(input.schedulesPath);
  const candidate: HandoffBundle = {
    version: captureBundleVersion(input),
    schedules,
    kind: "workspace_handoff",
    sourceServerId: input.sourceServerId,
    sourceWorkspaceId: input.sourceWorkspaceId,
    sourceCwd: input.sourceCwd,
    workspace: workspace.manifest.entrypoint,
    conversations,
  };
  const temporary = await mkdtemp(path.join(os.tmpdir(), "paseo-handoff-bundle-"));
  try {
    for (const [index, conversation] of conversations.entries()) {
      if (!conversation.previous?.length) continue;
      const segments = conversationHistorySegments(candidate, conversation);
      validateHistorySegments(segments);
      const indexPath = path.join(temporary, `history-${index}.json`);
      await writeJournal(indexPath, { version: 1, segments });
      conversation.historyIndex = await describeFile(indexPath, HANDOFF_HISTORY_INDEX_MAX_BYTES);
      add(conversation.historyIndex, indexPath);
    }
    const bundle = parseBundle(candidate);
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
  async function addSchedules(file?: string): Promise<HandoffBlob | undefined> {
    if (!file) return undefined;
    await readHandoffSchedules(file);
    const descriptor = await describeFile(file, HANDOFF_SCHEDULE_MAX_BYTES);
    add(descriptor, file);
    return descriptor;
  }
  async function addQueue(file?: string, directory?: string): Promise<HandoffBlob | undefined> {
    if (!file) return undefined;
    const captured = await readHandoffQueue(file);
    for (const upload of captured.files ?? []) {
      if (!directory) throw new Error("Captured queue upload files are unavailable");
      add(upload.blob, path.join(directory, upload.blob.sha256));
    }
    const queue = await describeFile(file, HANDOFF_QUEUE_MAX_BYTES);
    add(queue, file);
    return queue;
  }
}
function captureBundleVersion(input: PackInput): HandoffBundle["version"] {
  // COMPAT(handoffBundleCapture): added in v0.11.1, remove after 2027-04-10 once all callers capture v5.
  if (input.schedulesPath) return 5;
  if (input.conversations.some((conversation) => conversation.queuePath)) return 4;
  return 3;
}

function requireQueueVersion(
  version: HandoffBundle["version"],
  queue: HandoffBlob | undefined,
): void {
  if (version >= 4 !== (queue !== undefined))
    reject(
      "invalid_artifact",
      "Queued messages require handoff bundle version 4 and a queue snapshot",
    );
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
  assertBundleIdentity(bundle, expected);
  const inventory = new Map(archive.manifest.blobs.map((blob) => [blob.sha256, blob.size]));
  requireBlob(bundle.workspace);
  const sessions = new Map<string, ClaudeSessionArchive>();
  const previousSessions = new Map<string, ClaudeSessionArchive>();
  const queues = new Map<string, HandoffQueue>();
  let queueBytes = 0;
  const queueFiles = new Set<string>();
  let metadataBytes = bytes.length;
  let artifactCount = 0;
  for (const conversation of bundle.conversations) {
    await readQueue(conversation);
    requireBlob(conversation.session);
    if (conversation.history) {
      requireBlob(conversation.history);
      await readHandoffHistory(
        path.join(archive.blobsDirectory, conversation.history.sha256),
        conversation.origin?.sourceAgentId ?? conversation.sourceAgentId,
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
    for (const segment of conversation.previous ?? []) {
      requireBlob(segment.history);
      requireBlob(segment.session);
      metadataBytes += segment.session.size;
      if (metadataBytes > 20 * 1024 * 1024)
        reject("invalid_artifact", "Conversation manifests exceed the handoff metadata limit");
      await readHandoffHistory(
        path.join(archive.blobsDirectory, segment.history.sha256),
        segment.origin.sourceAgentId,
      );
      const previous = await readClaudeSessionManifest(
        path.join(archive.blobsDirectory, segment.session.sha256),
      );
      artifactCount += previous.files.length;
      if (artifactCount > 100_000)
        reject("invalid_artifact", "Too many conversation artifacts in handoff");
      for (const file of previous.files) requireBlob(file.blob);
      previousSessions.set(segment.session.sha256, previous);
    }
    if (conversation.historyIndex) {
      requireBlob(conversation.historyIndex);
      await readHistoryIndex(
        path.join(archive.blobsDirectory, conversation.historyIndex.sha256),
        conversationHistorySegments(bundle, conversation),
      );
    }
  }
  // COMPAT(handoffSchedules): added in v0.11.1, remove after 2027-04-10 once pre-v5 transfers finish.
  let schedules: HandoffSchedules = { version: 1, schedules: [] };
  if (bundle.schedules) {
    requireBlob(bundle.schedules);
    schedules = await readHandoffSchedules(
      path.join(archive.blobsDirectory, bundle.schedules.sha256),
    );
    for (const schedule of schedules.schedules) {
      if (
        schedule.target.type === "agent" &&
        !expected.sourceAgentIds.includes(schedule.target.agentId)
      )
        reject("invalid_artifact", "Heartbeat target is outside the transferred conversations");
    }
  }
  return { bundle, sessions, previousSessions, queues, schedules };
  async function readQueue(conversation: HandoffBundle["conversations"][number]): Promise<void> {
    if (conversation.queue) {
      requireBlob(conversation.queue);
      queueBytes += conversation.queue.size;
      if (queueBytes > HANDOFF_QUEUE_MAX_BYTES)
        reject("invalid_artifact", "Queued messages exceed the handoff byte limit");
      const queue = await readHandoffQueue(
        path.join(archive.blobsDirectory, conversation.queue.sha256),
      );
      assertHandoffQueueWorkspace(queue, bundle.sourceCwd);
      for (const { blob } of queue.files ?? []) {
        requireBlob(blob);
        if (!queueFiles.has(blob.sha256)) queueBytes += blob.size;
        queueFiles.add(blob.sha256);
      }
      if (queueBytes > HANDOFF_QUEUE_MAX_BYTES)
        reject("invalid_artifact", "Queued messages exceed the handoff byte limit");
      for (const entry of queue.entries) {
        if (entry.senderAgentId && !expected.sourceAgentIds.includes(entry.senderAgentId))
          reject(
            "invalid_artifact",
            "Queued message sender is outside the transferred conversations",
          );
      }
      queues.set(conversation.sourceAgentId, queue);
    }
  }
  function requireBlob(blob: HandoffBlob): void {
    if (inventory.get(blob.sha256) !== blob.size)
      reject("invalid_artifact", "Handoff references content outside its verified archive");
  }
}

function assertBundleIdentity(bundle: HandoffBundle, expected: HandoffBundleExpectation): void {
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
}

export async function readTransferredConversation(input: {
  store: HandoffArchiveStore;
  transferId: string;
  entrypoint: HandoffBlob;
  expected: HandoffBundleExpectation;
  sourceAgentId: string;
  segmentId?: string;
}) {
  if (input.entrypoint.sha256 !== input.expected.manifestDigest)
    reject("invalid_artifact", "Archive differs from the destination reservation");
  const bytes = await input.store.readVerifiedBlob(
    input.transferId,
    input.entrypoint,
    4 * 1024 * 1024,
  );
  const bundle = parseBundle(JSON.parse(bytes.toString("utf8")));
  assertBundleIdentity(bundle, input.expected);
  const conversation = bundle.conversations.find(
    (item) => item.sourceAgentId === input.sourceAgentId,
  );
  if (!conversation?.history)
    reject("invalid_artifact", "This transfer does not contain readable history");
  const segments = conversationHistorySegments(bundle, conversation);
  const segment = input.segmentId
    ? segments.find((item) => item.history.sha256 === input.segmentId)
    : segments.at(-1);
  if (!segment)
    reject("invalid_artifact", "Requested history segment does not belong to this conversation");
  const history = parseHandoffHistory(
    await input.store.readVerifiedBlob(
      input.transferId,
      segment.history,
      HANDOFF_HISTORY_MAX_BYTES,
    ),
    segment.origin.sourceAgentId,
  );
  return { bundle, conversation, history, segments, segment };
}
