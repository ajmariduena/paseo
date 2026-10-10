import {
  HANDOFF_CHUNK_BYTES,
  type HandoffArchiveManifest,
  type HandoffArchiveStatus,
  type HandoffError,
} from "@getpaseo/protocol/handoff";
import type { DaemonClient } from "./daemon-client.js";

type Source = Pick<DaemonClient, "handoffArchiveStatus" | "handoffArchiveReadChunk">;
type Destination = Pick<
  DaemonClient,
  "handoffArchiveBegin" | "handoffArchiveWriteChunk" | "handoffArchiveSeal"
>;

export class HandoffTransferError extends Error {
  constructor(readonly detail: HandoffError) {
    super(detail.message);
    this.name = "HandoffTransferError";
  }
}

export interface HandoffTransferProgress {
  receivedBytes: number;
  totalBytes: number;
  phase: "transferring" | "verifying" | "verified";
}

export function handoffResult<T>(reply: { result: T | null; error: HandoffError | null }): T {
  if (reply.error) throw new HandoffTransferError(reply.error);
  if (reply.result === null) throw new Error("Host returned no handoff result");
  return reply.result;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Handoff transfer paused");
}

function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

export async function handoffRequest<T>(
  operation: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  checkAbort(signal);
  if (!signal) return operation();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => {
        checkAbort(signal);
        return operation();
      })
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

function validateInventory(
  status: HandoffArchiveStatus,
  transferId: string,
  manifest: HandoffArchiveManifest,
): void {
  const declared = new Map(manifest.blobs.map((blob) => [blob.sha256, blob.size]));
  if (status.id !== transferId || status.blobs.length !== declared.size)
    throw new Error("Host returned a different handoff inventory");
  for (const blob of status.blobs) {
    if (declared.get(blob.sha256) !== blob.size || blob.receivedBytes > blob.size)
      throw new Error("Host returned invalid handoff progress");
    declared.delete(blob.sha256);
  }
}

/** Reinvoke with the same ID after reconnect. Only one bounded chunk is in flight. */
export async function transferHandoffArchive(input: {
  source: Source;
  destination: Destination;
  transferId: string;
  manifest: HandoffArchiveManifest;
  signal?: AbortSignal;
  onProgress?: (progress: HandoffTransferProgress) => void;
}): Promise<HandoffArchiveStatus> {
  const { source, destination, transferId, manifest, signal } = input;
  const sourceStatus = handoffResult(
    await handoffRequest(() => source.handoffArchiveStatus({ transferId }), signal),
  );
  validateInventory(sourceStatus, transferId, manifest);
  if (sourceStatus.state !== "verified") throw new Error("Source archive is not verified");
  const status = handoffResult(
    await handoffRequest(() => destination.handoffArchiveBegin({ transferId, manifest }), signal),
  );
  validateInventory(status, transferId, manifest);
  const totalBytes = status.blobs.reduce((sum, blob) => sum + blob.size, 0);
  let receivedBytes = status.blobs.reduce((sum, blob) => sum + blob.receivedBytes, 0);
  const progress = (phase: HandoffTransferProgress["phase"]) =>
    input.onProgress?.({ phase, receivedBytes, totalBytes });
  progress("transferring");
  for (const blob of status.blobs) {
    let offset = blob.receivedBytes;
    while (offset < blob.size) {
      const length = Math.min(HANDOFF_CHUNK_BYTES, blob.size - offset);
      const data = handoffResult(
        await handoffRequest(
          () => source.handoffArchiveReadChunk({ transferId, sha256: blob.sha256, offset, length }),
          signal,
        ),
      );
      // Validate byte length without decoding or retaining a second copy on a phone.
      let padding = 0;
      if (data.endsWith("=")) padding = 1;
      if (data.endsWith("==")) padding = 2;
      if (
        data.length % 4 !== 0 ||
        (data.length / 4) * 3 - padding !== length ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
      )
        throw new Error("Source returned an invalid handoff chunk");
      const next = handoffResult(
        await handoffRequest(
          () =>
            destination.handoffArchiveWriteChunk({ transferId, sha256: blob.sha256, offset, data }),
          signal,
        ),
      );
      if (next < offset + length || next > blob.size)
        throw new Error("Destination returned an invalid handoff offset");
      receivedBytes += next - offset;
      offset = next;
      progress("transferring");
    }
  }
  progress("verifying");
  const verified = handoffResult(
    await handoffRequest(() => destination.handoffArchiveSeal({ transferId }), signal),
  );
  validateInventory(verified, transferId, manifest);
  if (
    verified.state !== "verified" ||
    verified.blobs.some((blob) => blob.receivedBytes !== blob.size)
  )
    throw new Error("Destination did not verify the handoff archive");
  checkAbort(signal);
  progress("verified");
  return verified;
}
