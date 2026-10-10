import type {
  HandoffDestinationSnapshot,
  HandoffCancellationProof,
  HandoffReleaseReceipt,
  HandoffStoppedWorkReview,
  HandoffIntegrationReview,
  HandoffConversationModes,
  HandoffContinuationSelection,
} from "@getpaseo/protocol/handoff-control";
import type { DaemonClient } from "./daemon-client.js";
import {
  handoffRequest,
  handoffResult,
  transferHandoffArchive,
  type HandoffTransferProgress,
} from "./handoff-transfer.js";

interface HandoffConnections {
  source: DaemonClient;
  destination: DaemonClient;
  transferId: string;
  signal?: AbortSignal;
}
export interface WorkspaceHandoffCheckpoint {
  destinationServerId: string;
  snapshot: HandoffDestinationSnapshot;
  sourcePublicKey?: string;
}
interface HandoffCheckpointPersistence {
  checkpoint?: WorkspaceHandoffCheckpoint;
  /** A rejected publication prevents the next host mutation. */
  onCheckpoint?: (checkpoint: WorkspaceHandoffCheckpoint) => Promise<void>;
}

function reservationIdentity(snapshot: HandoffDestinationSnapshot) {
  return {
    transferId: snapshot.transferId,
    reservationId: snapshot.reservationId,
    sourceServerId: snapshot.sourceServerId,
    sourceWorkspaceId: snapshot.sourceWorkspaceId,
    sourceAgentIds: snapshot.sourceAgentIds,
    destinationParent: snapshot.destinationParent,
    destinationCwd: snapshot.destinationCwd,
    workspaceId: snapshot.workspaceId,
    projectId: snapshot.projectId,
    agentMappings: snapshot.agentMappings,
    continuationMode: snapshot.continuationMode,
    conversationModes: snapshot.conversationModes,
    workspaceReviewDigest: snapshot.workspaceReviewDigest,
    stoppedWorkReview: snapshot.stoppedWorkReview,
    integrationReview: snapshot.integrationReview,
  };
}

/** A refreshed journal may advance, but cannot replace the saved reservation or signer. */
export function assertHandoffCheckpointMatches(
  prior: {
    snapshot: HandoffDestinationSnapshot | null;
    sourcePublicKey?: string;
    destinationServerId?: string;
  },
  current: {
    snapshot: HandoffDestinationSnapshot | null;
    sourcePublicKey?: string;
    destinationServerId?: string;
  },
) {
  if (prior.destinationServerId && prior.destinationServerId !== current.destinationServerId)
    throw new Error("Destination host changed since the saved handoff");
  if (
    prior.snapshot &&
    (!current.snapshot ||
      JSON.stringify(reservationIdentity(prior.snapshot)) !==
        JSON.stringify(reservationIdentity(current.snapshot)) ||
      (prior.snapshot.manifestDigest !== null &&
        prior.snapshot.manifestDigest !== current.snapshot.manifestDigest))
  )
    throw new Error("Destination reservation changed since the saved handoff");
  const pinned = prior.sourcePublicKey ?? prior.snapshot?.sourcePublicKey;
  const key = current.sourcePublicKey ?? current.snapshot?.sourcePublicKey;
  if (
    (pinned && pinned !== key) ||
    (current.snapshot?.sourcePublicKey && key && current.snapshot.sourcePublicKey !== key)
  )
    throw new Error("Source signing key changed since the saved handoff");
}

function checkpointWriter(
  input: HandoffCheckpointPersistence & { transferId: string },
  sourceServerId: string,
  destinationServerId: string,
) {
  let prior = input.checkpoint;
  return async (snapshot: HandoffDestinationSnapshot, key = snapshot.sourcePublicKey) => {
    if (snapshot.transferId !== input.transferId || snapshot.sourceServerId !== sourceServerId)
      throw new Error("Destination reservation belongs to another handoff");
    if (snapshot.manifestDigest !== null && !snapshot.sourcePublicKey)
      throw new Error("Destination did not report its pinned source key; update the host");
    const pinned = prior?.sourcePublicKey ?? prior?.snapshot.sourcePublicKey;
    const checkpoint = { destinationServerId, snapshot, sourcePublicKey: key ?? pinned };
    assertHandoffCheckpointMatches(prior ?? { snapshot: null }, checkpoint);
    await input.onCheckpoint?.(checkpoint);
    prior = checkpoint;
  };
}
/** No reservation or source mutation was started, so the caller can discard its local intent. */
export class HandoffReviewChangedError extends Error {}

function validateReviewedInventory(
  expected: string[] | undefined,
  current: string[],
  reserved: boolean,
) {
  if (!expected || JSON.stringify([...current].sort()) === JSON.stringify([...expected].sort()))
    return;
  if (reserved) throw new Error("Saved review does not match the destination reservation");
  throw new HandoffReviewChangedError(
    "Source conversations changed after review; review the transfer again",
  );
}
export interface WorkspaceHandoffProgress {
  phase:
    | "inspecting"
    | "preparing_source"
    | "transferring"
    | "preparing_destination"
    | "ready"
    | "releasing"
    | "activating"
    | "active";
  transfer?: HandoffTransferProgress;
}
export interface PrepareWorkspaceHandoffInput
  extends HandoffConnections, HandoffCheckpointPersistence {
  workspaceId: string;
  destinationParent: string;
  continuationMode: "native" | "context";
  conversationModes?: HandoffConversationModes;
  expectedAgentIds?: string[];
  workspaceReviewDigest?: string;
  stoppedWorkReview?: HandoffStoppedWorkReview;
  integrationReview?: HandoffIntegrationReview;
  onProgress?: (progress: WorkspaceHandoffProgress) => void;
}
export interface ActivateWorkspaceHandoffInput extends HandoffCheckpointPersistence {
  sourceServerId: string;
  getSource: () => DaemonClient;
  destination: DaemonClient;
  transferId: string;
  signal?: AbortSignal;
  onProgress?: (progress: WorkspaceHandoffProgress) => void;
}
function serverId(client: DaemonClient): string {
  const info = client.getLastServerInfoMessage();
  if (!info) throw new Error("Connect both handoff hosts before continuing");
  return info.serverId;
}
function requireDistinctHosts(input: HandoffConnections) {
  const sourceServerId = serverId(input.source);
  const destinationServerId = serverId(input.destination);
  if (sourceServerId === destinationServerId)
    throw new Error("Choose a different destination host");
  return { sourceServerId, destinationServerId };
}

async function validateReview(
  input: PrepareWorkspaceHandoffInput,
  prior: HandoffDestinationSnapshot | null,
) {
  const saved = prior ?? input;
  const expected = input.workspaceReviewDigest ?? saved.workspaceReviewDigest;
  const stoppedWorkReview = input.stoppedWorkReview ?? saved.stoppedWorkReview;
  const integrationReview = input.integrationReview ?? saved.integrationReview;
  if ((expected || stoppedWorkReview || integrationReview) && !prior) {
    const current = handoffResult(
      await handoffRequest(
        () => input.source.handoffPreviewSource({ workspaceId: input.workspaceId }),
        input.signal,
      ),
    );
    if (
      integrationReview &&
      JSON.stringify(current.integrationReview) !== JSON.stringify(integrationReview)
    )
      throw new HandoffReviewChangedError(
        "Conversation MCP connections changed after review; review the transfer again",
      );
    if (expected && current.workspace?.reviewDigest !== expected)
      throw new HandoffReviewChangedError(
        "Workspace files or exclusions changed after review; review the transfer again",
      );
    if (
      stoppedWorkReview &&
      JSON.stringify(current.stoppedWork?.review) !== JSON.stringify(stoppedWorkReview)
    )
      throw new HandoffReviewChangedError(
        "Work that will stop changed after review; review the transfer again",
      );
  }
  return {
    workspaceReviewDigest: expected,
    stoppedWorkReview,
    integrationReview,
    conversationModes: input.conversationModes ?? saved.conversationModes,
  };
}

/** Keep transferId in the caller's durable UI state. Reconnect reuses the hosts' journals. */
export async function prepareWorkspaceHandoff(
  input: PrepareWorkspaceHandoffInput,
): Promise<HandoffDestinationSnapshot> {
  const { source, destination, transferId, signal } = input;
  const { sourceServerId, destinationServerId } = requireDistinctHosts(input);
  const checkpoint = checkpointWriter(input, sourceServerId, destinationServerId);
  const progress = (phase: WorkspaceHandoffProgress["phase"]) => input.onProgress?.({ phase });
  progress("inspecting");
  const prior = await handoffRequest(
    () => destination.handoffGetDestinationStatus({ transferId }),
    signal,
  );
  if (prior.error && prior.error.code !== "not_found") handoffResult(prior);
  if (prior.result) await checkpoint(prior.result);
  else if (input.checkpoint) throw new Error("Saved destination reservation is unavailable");
  const { workspaceReviewDigest, stoppedWorkReview, integrationReview, conversationModes } =
    await validateReview(input, prior.result);
  const inventory = prior.result
    ? { agentIds: prior.result.sourceAgentIds }
    : handoffResult(
        await handoffRequest(
          () => source.handoffInspectSource({ workspaceId: input.workspaceId }),
          signal,
        ),
      );
  validateReviewedInventory(input.expectedAgentIds, inventory.agentIds, prior.result !== null);
  const reserved = handoffResult(
    await handoffRequest(
      () =>
        destination.handoffReserveDestination({
          transferId,
          sourceServerId,
          sourceWorkspaceId: input.workspaceId,
          sourceAgentIds: inventory.agentIds,
          destinationParent: input.destinationParent,
          continuationMode: input.continuationMode,
          conversationModes,
          workspaceReviewDigest,
          stoppedWorkReview,
          integrationReview,
        }),
      signal,
    ),
  );
  validateReservedReview(reserved, {
    workspaceReviewDigest,
    stoppedWorkReview,
    integrationReview,
    continuationMode: input.continuationMode,
    conversationModes,
  });
  await checkpoint(reserved);
  if (reserved.state === "cancelled")
    throw new Error("This handoff was cancelled; start a new transfer");
  if (reserved.state === "active") {
    progress("active");
    return reserved;
  }
  if (reserved.state === "released" || reserved.state === "activating") {
    progress("activating");
    return reserved;
  }
  if (reserved.state === "staged") {
    const staged = await stageWorkspaceHandoff(input);
    await checkpoint(staged);
    return staged;
  }
  progress("preparing_source");
  const prepared = await prepareSource(input, reserved, destinationServerId, checkpoint);
  const manifest = prepared.manifest;
  await checkpoint(reserved, prepared.source.publicKey);
  const bound = handoffResult(
    await handoffRequest(
      () =>
        destination.handoffBindDestination({
          transferId,
          publicKey: prepared.source.publicKey,
          manifest,
        }),
      signal,
    ),
  );
  await checkpoint(bound);
  await transferHandoffArchive({
    source,
    destination,
    transferId,
    manifest,
    signal,
    onProgress: (transfer) => input.onProgress?.({ phase: "transferring", transfer }),
  });
  const staged = await stageWorkspaceHandoff(input);
  await checkpoint(staged);
  return staged;
}

async function prepareSource(
  input: PrepareWorkspaceHandoffInput,
  reserved: HandoffDestinationSnapshot,
  destinationServerId: string,
  checkpoint: ReturnType<typeof checkpointWriter>,
) {
  const { source, transferId, signal } = input;
  const priorSource = await handoffRequest(
    () => source.handoffGetSourceStatus({ transferId }),
    signal,
  );
  if (priorSource.error && priorSource.error.code !== "not_found") handoffResult(priorSource);
  let prepared = priorSource.result;
  if (prepared) await checkpoint(reserved, prepared.source.publicKey);
  if (!prepared || prepared.source.state === "preparing") {
    prepared = handoffResult(
      await handoffRequest(
        () =>
          source.handoffPrepareSource({
            transferId,
            workspaceId: input.workspaceId,
            agentIds: reserved.sourceAgentIds,
            destinationServerId,
            reservationId: reserved.reservationId,
            workspaceReviewDigest: reserved.workspaceReviewDigest,
            stoppedWorkReview: reserved.stoppedWorkReview,
            integrationReview: reserved.integrationReview,
          }),
        signal,
      ),
    );
  }
  if (prepared.source.state === "cancelled")
    throw new Error("Source cancelled this handoff; start a new transfer");
  if (
    prepared.source.destinationServerId !== destinationServerId ||
    prepared.source.reservationId !== reserved.reservationId ||
    prepared.source.workspaceId !== input.workspaceId ||
    !handoffReviewsMatch(prepared.source, reserved)
  )
    throw new Error("Source handoff belongs to another destination reservation");
  const manifest = prepared.manifest;
  if (!manifest || prepared.source.manifestDigest !== manifest.entrypoint.sha256)
    throw new Error("Source capture is not ready");
  return { source: prepared.source, manifest };
}

async function stageWorkspaceHandoff(
  input: Pick<PrepareWorkspaceHandoffInput, "destination" | "transferId" | "signal" | "onProgress">,
) {
  const { destination, transferId, signal, onProgress } = input;
  onProgress?.({ phase: "preparing_destination" });
  const staged = handoffResult(
    await handoffRequest(() => destination.handoffStageDestination({ transferId }), signal),
  );
  onProgress?.({ phase: "ready" });
  return staged;
}

export function handoffContinuationsMatch(
  left: HandoffContinuationSelection,
  right: HandoffContinuationSelection,
): boolean {
  const sorted = (modes: HandoffConversationModes | undefined) =>
    modes?.toSorted((a, b) => a.sourceAgentId.localeCompare(b.sourceAgentId));
  return (
    left.continuationMode === right.continuationMode &&
    JSON.stringify(sorted(left.conversationModes)) ===
      JSON.stringify(sorted(right.conversationModes))
  );
}

export function handoffReviewsMatch(
  left: Pick<
    HandoffDestinationSnapshot,
    "workspaceReviewDigest" | "stoppedWorkReview" | "integrationReview"
  >,
  right: Pick<
    HandoffDestinationSnapshot,
    "workspaceReviewDigest" | "stoppedWorkReview" | "integrationReview"
  >,
): boolean {
  return (
    left.workspaceReviewDigest === right.workspaceReviewDigest &&
    JSON.stringify(left.stoppedWorkReview) === JSON.stringify(right.stoppedWorkReview) &&
    JSON.stringify(left.integrationReview) === JSON.stringify(right.integrationReview)
  );
}

function validateReservedReview(
  reserved: HandoffDestinationSnapshot,
  review: Pick<
    PrepareWorkspaceHandoffInput,
    | "workspaceReviewDigest"
    | "stoppedWorkReview"
    | "integrationReview"
    | "continuationMode"
    | "conversationModes"
  >,
) {
  if (!handoffContinuationsMatch(reserved, review))
    throw new Error("Destination reservation did not retain the selected conversation modes");
  if (JSON.stringify(reserved.integrationReview) !== JSON.stringify(review.integrationReview))
    throw new Error("Destination reservation did not retain the reviewed conversation connections");
  if (reserved.workspaceReviewDigest !== review.workspaceReviewDigest)
    throw new Error("Destination reservation did not retain the reviewed workspace boundary");
  if (JSON.stringify(reserved.stoppedWorkReview) !== JSON.stringify(review.stoppedWorkReview))
    throw new Error("Destination reservation did not retain the reviewed work that will stop");
}

/** A timeout after release leaves ownership at destination; retry activation with this same ID. */
export async function activateWorkspaceHandoff(
  input: ActivateWorkspaceHandoffInput,
): Promise<HandoffDestinationSnapshot> {
  const { sourceServerId, destination, transferId, signal } = input;
  const destinationServerId = serverId(destination);
  if (sourceServerId === destinationServerId)
    throw new Error("Choose a different destination host");
  const target = handoffResult(
    await handoffRequest(() => destination.handoffGetDestinationStatus({ transferId }), signal),
  );
  if (target.sourceServerId !== sourceServerId)
    throw new Error("Destination reservation belongs to another source host");
  const checkpoint = checkpointWriter(input, sourceServerId, destinationServerId);
  await checkpoint(target);
  if (target.state === "active") {
    input.onProgress?.({ phase: "active" });
    return target;
  }
  if (!["staged", "released", "activating"].includes(target.state))
    throw new Error("Prepare the destination before releasing source ownership");
  // A released destination owns its durable receipt, including after an app or source disconnect.
  let receipt: HandoffReleaseReceipt | undefined;
  if (target.state === "staged") {
    const source = input.getSource();
    if (serverId(source) !== sourceServerId)
      throw new Error("Source connection belongs to another host");
    const prepared = handoffResult(
      await handoffRequest(() => source.handoffGetSourceStatus({ transferId }), signal),
    );
    if (
      prepared.source.destinationServerId !== destinationServerId ||
      prepared.source.reservationId !== target.reservationId ||
      prepared.source.manifestDigest !== target.manifestDigest ||
      !handoffReviewsMatch(prepared.source, target)
    )
      throw new Error("Handoff ownership and destination content do not match");
    await checkpoint(target, prepared.source.publicKey);
    input.onProgress?.({ phase: "releasing" });
    receipt = handoffResult(
      await handoffRequest(() => source.handoffReleaseSource({ transferId }), signal),
    );
  }
  input.onProgress?.({ phase: "activating" });
  const active = handoffResult(
    await handoffRequest(
      () => destination.handoffActivateDestination({ transferId, receipt }),
      signal,
    ),
  );
  if (active.state !== "active") throw new Error("Destination has not completed activation");
  await checkpoint(active);
  input.onProgress?.({ phase: "active" });
  return active;
}

async function verifyCancellationSigner(
  source: DaemonClient,
  target: HandoffDestinationSnapshot,
  input: Omit<ActivateWorkspaceHandoffInput, "onProgress">,
  checkpoint: ReturnType<typeof checkpointWriter>,
) {
  const pinned =
    input.checkpoint?.sourcePublicKey ??
    input.checkpoint?.snapshot.sourcePublicKey ??
    target.sourcePublicKey;
  if (!pinned) return;
  const status = await handoffRequest(
    () => source.handoffGetSourceStatus({ transferId: input.transferId }),
    input.signal,
  );
  if (status.error) handoffResult(status);
  const key = status.result?.source.publicKey ?? status.cancellation?.publicKey;
  if (!key) throw new Error("Saved source signing key is unavailable");
  await checkpoint(target, key);
}

/** Cancellation wins durably at source before destination is permitted to discard its copy. */
export async function cancelWorkspaceHandoff(
  input: Omit<ActivateWorkspaceHandoffInput, "onProgress">,
): Promise<HandoffDestinationSnapshot> {
  const { sourceServerId, destination, transferId, signal } = input;
  const target = handoffResult(
    await handoffRequest(() => destination.handoffGetDestinationStatus({ transferId }), signal),
  );
  const destinationServerId = serverId(destination);
  if (destinationServerId === sourceServerId)
    throw new Error("Choose a different destination host");
  if (target.sourceServerId !== sourceServerId)
    throw new Error("Destination reservation belongs to another source host");
  const checkpoint = checkpointWriter(input, sourceServerId, destinationServerId);
  await checkpoint(target);
  if (["released", "activating", "active"].includes(target.state))
    throw new Error("Source ownership was released; finish destination activation");
  if (target.state === "cancelled" && target.cleanupComplete === true) return target;
  let proof: HandoffCancellationProof | undefined;
  if (!target.cancellationAccepted) {
    const source = input.getSource();
    if (serverId(source) !== sourceServerId)
      throw new Error("Source connection belongs to another host");
    await verifyCancellationSigner(source, target, input, checkpoint);
    proof = handoffResult(
      await handoffRequest(
        () =>
          source.handoffCancelSource({
            transferId,
            destinationServerId,
            reservationId: target.reservationId,
          }),
        signal,
      ),
    );
    await checkpoint(target, proof.publicKey);
  }
  const cancelled = handoffResult(
    await handoffRequest(() => destination.handoffCancelDestination({ transferId, proof }), signal),
  );
  await checkpoint(cancelled);
  return cancelled;
}
