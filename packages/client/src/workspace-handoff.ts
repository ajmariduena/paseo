import type {
  HandoffDestinationSnapshot,
  HandoffCancellationProof,
  HandoffReleaseReceipt,
  HandoffStoppedWorkReview,
  HandoffIntegrationReview,
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
export interface PrepareWorkspaceHandoffInput extends HandoffConnections {
  workspaceId: string;
  destinationParent: string;
  continuationMode: "native" | "context";
  expectedAgentIds?: string[];
  workspaceReviewDigest?: string;
  stoppedWorkReview?: HandoffStoppedWorkReview;
  integrationReview?: HandoffIntegrationReview;
  onProgress?: (progress: WorkspaceHandoffProgress) => void;
}
export interface ActivateWorkspaceHandoffInput {
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
  const expected = input.workspaceReviewDigest ?? prior?.workspaceReviewDigest;
  const stoppedWorkReview = input.stoppedWorkReview ?? prior?.stoppedWorkReview;
  const integrationReview = input.integrationReview ?? prior?.integrationReview;
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
  return { workspaceReviewDigest: expected, stoppedWorkReview, integrationReview };
}

/** Keep transferId in the caller's durable UI state. Reconnect reuses the hosts' journals. */
export async function prepareWorkspaceHandoff(
  input: PrepareWorkspaceHandoffInput,
): Promise<HandoffDestinationSnapshot> {
  const { source, destination, transferId, signal } = input;
  const { sourceServerId, destinationServerId } = requireDistinctHosts(input);
  const progress = (phase: WorkspaceHandoffProgress["phase"]) => input.onProgress?.({ phase });
  progress("inspecting");
  const prior = await handoffRequest(
    () => destination.handoffGetDestinationStatus({ transferId }),
    signal,
  );
  if (prior.error && prior.error.code !== "not_found") handoffResult(prior);
  const { workspaceReviewDigest, stoppedWorkReview, integrationReview } = await validateReview(
    input,
    prior.result,
  );
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
          workspaceReviewDigest,
          stoppedWorkReview,
          integrationReview,
        }),
      signal,
    ),
  );
  validateReservedReview(reserved, { workspaceReviewDigest, stoppedWorkReview, integrationReview });
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
  progress("preparing_source");
  const priorSource = await handoffRequest(
    () => source.handoffGetSourceStatus({ transferId }),
    signal,
  );
  if (priorSource.error && priorSource.error.code !== "not_found") handoffResult(priorSource);
  let prepared = priorSource.result;
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
  handoffResult(
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
  await transferHandoffArchive({
    source,
    destination,
    transferId,
    manifest,
    signal,
    onProgress: (transfer) => input.onProgress?.({ phase: "transferring", transfer }),
  });
  progress("preparing_destination");
  const staged = handoffResult(
    await handoffRequest(() => destination.handoffStageDestination({ transferId }), signal),
  );
  progress("ready");
  return staged;
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
    "workspaceReviewDigest" | "stoppedWorkReview" | "integrationReview"
  >,
) {
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
  input.onProgress?.({ phase: "active" });
  return active;
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
  if (["released", "activating", "active"].includes(target.state))
    throw new Error("Source ownership was released; finish destination activation");
  if (target.state === "cancelled" && target.cleanupComplete === true) return target;
  let proof: HandoffCancellationProof | undefined;
  if (!target.cancellationAccepted) {
    const source = input.getSource();
    if (serverId(source) !== sourceServerId)
      throw new Error("Source connection belongs to another host");
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
  }
  return handoffResult(
    await handoffRequest(() => destination.handoffCancelDestination({ transferId, proof }), signal),
  );
}
