import type pino from "pino";
import type { VoiceOrchestrator } from "../orchestrator.js";
import { VoiceMessagesCall, type VoiceMessagesSpeech } from "./messages-call.js";

const IDLE_CALL_MS = 20 * 60_000;
const SWEEP_MS = 60_000;

export type VoiceMessagesPushSender = (payload: {
  title: string;
  body: string;
  data: Record<string, unknown>;
}) => void;

/**
 * Owns messages-mode calls at the daemon level, so a call outlives the socket that
 * started it: the phone reconnects (or comes back after a dead zone) and resumes by call id.
 */
export class VoiceMessagesHub {
  private readonly calls = new Map<string, VoiceMessagesCall>();
  private pushSender: VoiceMessagesPushSender | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly options: {
      orchestrator: VoiceOrchestrator;
      speech: VoiceMessagesSpeech;
      logger: pino.Logger;
    },
  ) {}

  setPushSender(sender: VoiceMessagesPushSender | null): void {
    this.pushSender = sender;
  }

  /** Resumes the call with this id, or starts it and closes any other. */
  start(params: { callId: string; history: string[]; greet: boolean }): VoiceMessagesCall {
    const existing = this.calls.get(params.callId);
    if (existing && !existing.isClosed) return existing;
    for (const call of this.calls.values()) call.close();
    this.calls.clear();
    const { orchestrator } = this.options;
    orchestrator.closeLiveCall();
    const call = new VoiceMessagesCall({
      callId: params.callId,
      orchestrator,
      speech: this.options.speech,
      history: params.history.length > 0 ? params.history : orchestrator.takeRecentHistory("live"),
      greet: params.greet,
      sendPush: (payload) => this.pushSender?.(payload),
      logger: this.options.logger,
    });
    this.calls.set(params.callId, call);
    call.start();
    this.ensureSweep();
    return call;
  }

  get(callId: string): VoiceMessagesCall | null {
    const call = this.calls.get(callId);
    return call && !call.isClosed ? call : null;
  }

  /** `handoff` keeps the conversation for a live call that takes over right away. */
  end(callId: string, handoff = false): void {
    this.calls.get(callId)?.close({ handoff });
    this.calls.delete(callId);
  }

  dispose(): void {
    for (const call of this.calls.values()) call.close();
    this.calls.clear();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  private ensureSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      for (const [callId, call] of this.calls) {
        if (call.isClosed || call.idleMs > IDLE_CALL_MS) {
          call.close();
          this.calls.delete(callId);
        }
      }
      if (this.calls.size === 0 && this.sweepTimer) {
        clearInterval(this.sweepTimer);
        this.sweepTimer = null;
      }
    }, SWEEP_MS);
    this.sweepTimer.unref?.();
  }
}
