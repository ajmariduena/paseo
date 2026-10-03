// Audio deltas arrive faster than they play and the phone adds its own buffering, so the
// assistant is still audible this long after the last delta's end.
const PLAYBACK_MARGIN_MS = 800;
// Transcript deltas run ahead of the audio; a gap this long means the text stream stopped.
const TEXT_GRACE_MS = 700;
const USER_GRACE_MS = 900;
const FLUSH_INTERVAL_MS = 200;

export type FloorPriority = "result" | "urgent" | "routine";

/** How long both sides must be quiet before each kind of update may speak, and the longest it waits. */
const RULES: Record<FloorPriority, { quietMs: number; maxWaitMs: number }> = {
  // The answer the user is waiting for: the next short pause.
  result: { quietMs: 400, maxWaitMs: 12_000 },
  // Permission requests and failures: the next real pause.
  urgent: { quietMs: 700, maxWaitMs: 20_000 },
  // Finished work and progress: a settled silence, never mid-exchange.
  routine: { quietMs: 2_000, maxWaitMs: 60_000 },
};

/**
 * Tracks who holds the floor on a live call, so updates are spoken in the gaps instead of
 * cutting the assistant (or the user) off mid-sentence.
 */
export class SpeechFloor {
  private assistantAudioEndsAt = 0;
  private assistantTextAt = 0;
  private userSpeechAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  noteAssistantAudio(durationMs: number): void {
    const at = this.now();
    this.assistantAudioEndsAt = Math.max(at, this.assistantAudioEndsAt) + durationMs;
  }

  noteAssistantText(): void {
    this.assistantTextAt = this.now();
  }

  noteUserSpeech(): void {
    this.userSpeechAt = this.now();
  }

  isAssistantSpeaking(): boolean {
    return this.quietSinceAssistant() > this.now();
  }

  isUserSpeaking(): boolean {
    return this.now() - this.userSpeechAt < USER_GRACE_MS;
  }

  /** Milliseconds both sides have been quiet; zero or less while someone is talking. */
  quietForMs(): number {
    const quietSince = Math.max(this.quietSinceAssistant(), this.userSpeechAt + USER_GRACE_MS);
    return this.now() - quietSince;
  }

  private quietSinceAssistant(): number {
    return Math.max(
      this.assistantAudioEndsAt + PLAYBACK_MARGIN_MS,
      this.assistantTextAt + TEXT_GRACE_MS,
    );
  }
}

interface Held {
  priority: FloorPriority;
  queuedAt: number;
  send: () => void;
}

/**
 * Holds outgoing speech until the floor is free for its priority. Order is kept within a
 * priority; a result never waits behind routine updates.
 */
export class FloorQueue {
  private readonly held: Held[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly floor: SpeechFloor,
    private readonly options: {
      /** Routine updates also wait while the user's request is still being worked on. */
      isAwaitingResult: () => boolean;
      now?: () => number;
    },
  ) {}

  push(priority: FloorPriority, send: () => void): void {
    this.held.push({ priority, queuedAt: this.now(), send });
    this.flush();
    if (this.held.length > 0) this.ensureTimer();
  }

  close(): void {
    this.held.length = 0;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** One update per gap: once something is sent the assistant takes the floor again. */
  private flush(): void {
    const order: FloorPriority[] = ["result", "urgent", "routine"];
    const next = order
      .map((priority) => this.held.find((entry) => entry.priority === priority))
      .find((item): item is Held => item !== undefined && this.isDue(item));
    if (next) {
      this.held.splice(this.held.indexOf(next), 1);
      this.floor.noteAssistantText();
      next.send();
    }
    if (this.held.length === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private isDue(item: Held): boolean {
    const rule = RULES[item.priority];
    if (this.now() - item.queuedAt >= rule.maxWaitMs) return true;
    if (item.priority === "routine" && this.options.isAwaitingResult()) return false;
    return this.floor.quietForMs() >= rule.quietMs;
  }
}

function normalizeSpeech(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when what was "heard" is the assistant's own recent words coming back through the
 * speaker. Such transcripts are echo, not the user, and must not cut the assistant off.
 */
export function isEchoOfAssistant(heard: string, recentAssistant: string): boolean {
  const user = normalizeSpeech(heard);
  if (!user) return true;
  const words = user.split(" ").length;
  return words <= 10 && normalizeSpeech(recentAssistant).includes(user);
}
