import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { OwnedOperation, SessionDelivery } from "../owned-subscriptions/index.js";
import type {
  VoiceMessagesCall,
  VoiceMessagesItem,
} from "../../voice-orchestrator/messages/messages-call.js";
import type { VoiceOrchestrator } from "../../voice-orchestrator/orchestrator.js";

const MAX_AUDIO_SLICE_BYTES = 64 * 1024;
const MAX_LOGGED_EVENTS = 50;

export type VoiceMessagesRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "voice.messages.start.request"
      | "voice.messages.send_utterance.request"
      | "voice.messages.sync.request"
      | "voice.messages.get_audio.request"
      | "voice.messages.end.request"
      | "voice.call.log_events.request"
      | "voice.live.connect.request"
      | "voice.live.end.request";
  }
>;

export function isVoiceMessagesRequest(msg: SessionInboundMessage): msg is VoiceMessagesRequest {
  return (
    msg.type.startsWith("voice.messages.") ||
    msg.type.startsWith("voice.live.") ||
    msg.type === "voice.call.log_events.request"
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isVoiceMessagesUpdate(message: SessionOutboundMessage): boolean {
  return message.type === "voice.messages.update";
}

/** Per-session side of messages mode: RPCs plus pushing outbox updates to this client. */
export class VoiceMessagesSessionHandler {
  private boundCall: VoiceMessagesCall | null = null;
  // Updates belong to the socket that last spoke for the call; a reconnect's next request moves them.
  private updates: { owner: OwnedOperation; source: object } | null = null;
  private readonly listener = (item: VoiceMessagesItem) => {
    if (!this.boundCall) return;
    this.updates?.owner.emit({
      type: "voice.messages.update",
      payload: { callId: this.boundCall.callId, item },
    });
  };

  constructor(
    private readonly options: {
      orchestrator: VoiceOrchestrator | null | undefined;
      emit: (message: SessionOutboundMessage) => void;
      delivery: SessionDelivery;
      logger: pino.Logger;
    },
  ) {}

  private emit(message: SessionOutboundMessage): void {
    this.options.emit(message);
  }

  async handle(msg: VoiceMessagesRequest): Promise<void> {
    switch (msg.type) {
      case "voice.messages.start.request":
        return this.handleStart(msg);
      case "voice.messages.send_utterance.request":
        return this.handleSendUtterance(msg);
      case "voice.messages.sync.request":
        return this.handleSync(msg);
      case "voice.messages.get_audio.request":
        return this.handleGetAudio(msg);
      case "voice.messages.end.request":
        return this.handleEnd(msg);
      case "voice.call.log_events.request":
        return this.handleLogEvents(msg);
      case "voice.live.connect.request":
        return this.handleLiveConnect(msg);
      case "voice.live.end.request":
        return this.handleLiveEnd(msg);
    }
  }

  cleanup(): void {
    this.boundCall?.clearListener(this.listener);
    this.boundCall = null;
    this.releaseUpdates();
  }

  private releaseUpdates(): void {
    const updates = this.updates;
    this.updates = null;
    void updates?.owner.release().catch((error: unknown) => {
      this.options.logger.warn({ err: error }, "Failed to release voice messages updates");
    });
  }

  private claimUpdates(): void {
    const source = this.options.delivery.currentSource;
    if (!source || this.updates?.source === source) return;
    this.releaseUpdates();
    const owner = this.options.delivery.operation(isVoiceMessagesUpdate, () => {
      if (this.updates?.owner === owner) this.updates = null;
    });
    this.updates = { owner, source };
  }

  private requireOrchestrator(): VoiceOrchestrator {
    if (!this.options.orchestrator) {
      throw new Error("The voice assistant is not available on this host.");
    }
    return this.options.orchestrator;
  }

  private bind(call: VoiceMessagesCall): void {
    if (this.boundCall !== call) this.boundCall?.clearListener(this.listener);
    this.boundCall = call;
    call.setListener(this.listener);
    this.claimUpdates();
  }

  /** A known call id rebinds this client to it, which is how a reconnect resumes. */
  private findCall(callId: string): VoiceMessagesCall | null {
    const call = this.options.orchestrator?.messages.get(callId) ?? null;
    if (call) this.bind(call);
    return call;
  }

  private async handleStart(
    msg: Extract<VoiceMessagesRequest, { type: "voice.messages.start.request" }>,
  ): Promise<void> {
    try {
      const orchestrator = this.requireOrchestrator();
      orchestrator.setPreferredLanguage(msg.language ?? null);
      const agentId = await orchestrator.ensureAgent();
      const call = orchestrator.messages.start({
        callId: msg.callId,
        history: msg.history ?? [],
        greet: msg.greet ?? true,
      });
      this.bind(call);
      this.options.logger.info({ callId: msg.callId }, "Voice messages call started");
      this.emit({
        type: "voice.messages.start.response",
        payload: {
          requestId: msg.requestId,
          callId: msg.callId,
          agentId,
          lastSeq: call.lastSeq,
          language: orchestrator.language,
          error: null,
        },
      });
    } catch (error) {
      this.options.logger.warn({ err: error }, "Failed to start the voice messages call");
      this.emit({
        type: "voice.messages.start.response",
        payload: {
          requestId: msg.requestId,
          callId: msg.callId,
          agentId: null,
          lastSeq: 0,
          error: getErrorMessage(error),
        },
      });
    }
  }

  private async handleSendUtterance(
    msg: Extract<VoiceMessagesRequest, { type: "voice.messages.send_utterance.request" }>,
  ): Promise<void> {
    const call = this.findCall(msg.callId);
    if (!call) {
      this.emit({
        type: "voice.messages.send_utterance.response",
        payload: {
          requestId: msg.requestId,
          callId: msg.callId,
          utteranceId: msg.utteranceId,
          receivedChunks: 0,
          audioComplete: false,
          error: "call_not_found",
        },
      });
      return;
    }
    const receipt = call.receive({
      utteranceId: msg.utteranceId,
      ...(msg.text !== undefined ? { text: msg.text } : {}),
      ...(msg.chunkIndex !== undefined ? { chunkIndex: msg.chunkIndex } : {}),
      ...(msg.chunkCount !== undefined ? { chunkCount: msg.chunkCount } : {}),
      ...(msg.audio !== undefined ? { audio: msg.audio } : {}),
      ...(msg.mimeType !== undefined ? { mimeType: msg.mimeType } : {}),
    });
    this.emit({
      type: "voice.messages.send_utterance.response",
      payload: {
        requestId: msg.requestId,
        callId: msg.callId,
        utteranceId: msg.utteranceId,
        receivedChunks: receipt.receivedChunks,
        audioComplete: receipt.audioComplete,
        error: null,
      },
    });
  }

  private async handleSync(
    msg: Extract<VoiceMessagesRequest, { type: "voice.messages.sync.request" }>,
  ): Promise<void> {
    const call = this.findCall(msg.callId);
    this.emit({
      type: "voice.messages.sync.response",
      payload: {
        requestId: msg.requestId,
        callId: msg.callId,
        active: call !== null,
        items: call ? call.sync(msg.afterSeq) : [],
        error: null,
      },
    });
  }

  private async handleGetAudio(
    msg: Extract<VoiceMessagesRequest, { type: "voice.messages.get_audio.request" }>,
  ): Promise<void> {
    const call = this.findCall(msg.callId);
    const slice = call?.readAudio(
      msg.seq,
      msg.offset,
      Math.min(Math.max(msg.length, 0), MAX_AUDIO_SLICE_BYTES),
    );
    this.emit({
      type: "voice.messages.get_audio.response",
      payload: {
        requestId: msg.requestId,
        callId: msg.callId,
        seq: msg.seq,
        offset: msg.offset,
        total: slice?.total ?? 0,
        mimeType: slice?.mimeType ?? null,
        audio: slice ? slice.audio.toString("base64") : null,
        error: slice ? null : "audio_not_found",
      },
    });
  }

  private async handleEnd(
    msg: Extract<VoiceMessagesRequest, { type: "voice.messages.end.request" }>,
  ): Promise<void> {
    if (this.boundCall?.callId === msg.callId) this.cleanup();
    this.options.orchestrator?.messages.end(msg.callId, msg.handoff ?? false);
    this.options.logger.info({ callId: msg.callId }, "Voice messages call ended");
    this.emit({
      type: "voice.messages.end.response",
      payload: { requestId: msg.requestId, error: null },
    });
  }

  private async handleLiveConnect(
    msg: Extract<VoiceMessagesRequest, { type: "voice.live.connect.request" }>,
  ): Promise<void> {
    try {
      const orchestrator = this.requireOrchestrator();
      orchestrator.setPreferredLanguage(msg.language ?? null);
      const answer = await orchestrator.webrtc.connect({ sdp: msg.sdp });
      this.emit({
        type: "voice.live.connect.response",
        payload: {
          requestId: msg.requestId,
          sessionId: answer.sessionId,
          sdp: answer.sdp,
          error: null,
        },
      });
    } catch (error) {
      this.options.logger.warn({ err: error }, "Failed to start a GPT-Live WebRTC call");
      this.emit({
        type: "voice.live.connect.response",
        payload: {
          requestId: msg.requestId,
          sessionId: null,
          sdp: null,
          error: getErrorMessage(error),
        },
      });
    }
  }

  private async handleLiveEnd(
    msg: Extract<VoiceMessagesRequest, { type: "voice.live.end.request" }>,
  ): Promise<void> {
    this.options.orchestrator?.webrtc.end(msg.sessionId);
    this.emit({
      type: "voice.live.end.response",
      payload: { requestId: msg.requestId, error: null },
    });
  }

  /** The phone's view of the call (network changes, reconnects, audio interruptions) in daemon.log. */
  private async handleLogEvents(
    msg: Extract<VoiceMessagesRequest, { type: "voice.call.log_events.request" }>,
  ): Promise<void> {
    for (const event of msg.events.slice(0, MAX_LOGGED_EVENTS)) {
      this.options.logger.info(
        { voiceCallEvent: event.kind, at: event.at, ...event.detail },
        "Voice call client event",
      );
    }
    this.emit({
      type: "voice.call.log_events.response",
      payload: { requestId: msg.requestId },
    });
  }
}
