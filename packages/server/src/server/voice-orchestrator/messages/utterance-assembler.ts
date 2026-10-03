const MAX_CHUNKS = 256;
const MAX_TEXT_LENGTH = 4_000;

export interface UtterancePart {
  utteranceId: string;
  text?: string;
  chunkIndex?: number;
  chunkCount?: number;
  audio?: string;
  mimeType?: string;
}

export interface AssembledUtterance {
  utteranceId: string;
  deviceText: string | null;
  audio: { data: Buffer; mimeType: string } | null;
}

interface PendingUtterance {
  utteranceId: string;
  deviceText: string | null;
  mimeType: string | null;
  chunkCount: number | null;
  chunks: Map<number, Buffer>;
  firstSeenAt: number;
}

export interface UtteranceReceipt {
  receivedChunks: number;
  audioComplete: boolean;
  isNew: boolean;
}

/**
 * Collects an utterance sent as device text plus base64 audio chunks that may arrive
 * out of order, repeated, or never. Every part is idempotent so the phone can retry freely.
 */
export class UtteranceAssembler {
  private readonly pending = new Map<string, PendingUtterance>();
  private readonly finished = new Set<string>();

  hasFinished(utteranceId: string): boolean {
    return this.finished.has(utteranceId);
  }

  accept(part: UtterancePart, now = Date.now()): UtteranceReceipt {
    if (this.finished.has(part.utteranceId)) {
      return { receivedChunks: part.chunkCount ?? 0, audioComplete: true, isNew: false };
    }
    let entry = this.pending.get(part.utteranceId);
    const isNew = !entry;
    if (!entry) {
      entry = {
        utteranceId: part.utteranceId,
        deviceText: null,
        mimeType: null,
        chunkCount: null,
        chunks: new Map(),
        firstSeenAt: now,
      };
      this.pending.set(part.utteranceId, entry);
    }
    const text = part.text?.trim();
    if (text) entry.deviceText = text.slice(0, MAX_TEXT_LENGTH);
    if (part.mimeType) entry.mimeType = part.mimeType;
    if (part.chunkCount !== undefined && part.chunkCount > 0 && part.chunkCount <= MAX_CHUNKS) {
      entry.chunkCount = part.chunkCount;
    }
    if (
      part.audio !== undefined &&
      part.chunkIndex !== undefined &&
      part.chunkIndex >= 0 &&
      part.chunkIndex < MAX_CHUNKS &&
      !entry.chunks.has(part.chunkIndex)
    ) {
      entry.chunks.set(part.chunkIndex, Buffer.from(part.audio, "base64"));
    }
    return {
      receivedChunks: entry.chunks.size,
      audioComplete: this.isAudioComplete(entry),
      isNew,
    };
  }

  hasDeviceText(utteranceId: string): boolean {
    return Boolean(this.pending.get(utteranceId)?.deviceText);
  }

  isAudioComplete(entry: PendingUtterance | string): boolean {
    const pending = typeof entry === "string" ? this.pending.get(entry) : entry;
    if (!pending || pending.chunkCount === null || !pending.mimeType) return false;
    return pending.chunks.size >= pending.chunkCount;
  }

  /** Takes the utterance out; later parts for the same id are ignored. */
  finish(utteranceId: string): AssembledUtterance | null {
    const entry = this.pending.get(utteranceId);
    if (!entry) return null;
    this.pending.delete(utteranceId);
    this.finished.add(utteranceId);
    const audio =
      this.isAudioComplete(entry) && entry.mimeType
        ? {
            data: Buffer.concat(
              [...entry.chunks.entries()]
                .sort(([left], [right]) => left - right)
                .map(([, chunk]) => chunk),
            ),
            mimeType: entry.mimeType,
          }
        : null;
    return { utteranceId, deviceText: entry.deviceText, audio };
  }

  /** Drops utterances that never completed so a lost phone doesn't leak memory. */
  prune(maxAgeMs: number, now = Date.now()): void {
    for (const [id, entry] of this.pending) {
      if (now - entry.firstSeenAt > maxAgeMs) this.pending.delete(id);
    }
  }
}
