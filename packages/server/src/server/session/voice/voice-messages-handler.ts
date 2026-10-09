import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { OwnedOperation, SessionDelivery } from "../owned-subscriptions/index.js";
import type {
  VoiceMessagesCall,
  VoiceMessagesItem,
} from "../../voice-orchestrator/messages/messages-call.js";
import type { VoiceOrchestrator } from "../../voice-orchestrator/orchestrator.js";
import type { CourierChannel } from "../../voice-orchestrator/fleet/remote-fleet.js";

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
      | "voice.live.end.request"
      | "voice.call.set_mute.request"
      | "voice.fleet.digest.request"
      | "voice.fleet.sync.request"
      | "voice.tools.invoke.request"
      | "voice.courier.result.request";
  }
>;

export function isVoiceMessagesRequest(msg: SessionInboundMessage): msg is VoiceMessagesRequest {
  return (
    msg.type.startsWith("voice.messages.") ||
    msg.type.startsWith("voice.live.") ||
    msg.type.startsWith("voice.fleet.") ||
    msg.type === "voice.tools.invoke.request" ||
    msg.type === "voice.courier.result.request" ||
    msg.type === "voice.call.log_events.request" ||
    msg.type === "voice.call.set_mute.request"
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isVoiceMessagesUpdate(message: SessionOutboundMessage): boolean {
  return message.type === "voice.messages.update";
}

function isCourierExecute(message: SessionOutboundMessage): boolean {
  return message.type === "voice.courier.execute";
}

/** Per-session side of messages mode: RPCs plus pushing outbox updates to this client. */
export class VoiceMessagesSessionHandler {
  private boundCall: VoiceMessagesCall | null = null;
  // Updates belong to the socket that last spoke for the call; a reconnect's next request moves them.
  private updates: { owner: OwnedOperation; source: object } | null = null;
  // The socket that last synced the fleet carries the call's actions to the other hosts.
  private courier: { owner: OwnedOperation; source: object } | null = null;
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
      case "voice.call.set_mute.request":
        this.options.orchestrator?.setCallMuted(msg.muted);
        this.emit({ type: "voice.call.set_mute.response", payload: { requestId: msg.requestId } });
        return;
      case "voice.fleet.digest.request":
        return this.handleFleetDigest(msg);
      case "voice.fleet.sync.request":
        return this.handleFleetSync(msg);
      case "voice.tools.invoke.request":
        return this.handleToolsInvoke(msg);
      case "voice.courier.result.request":
        this.options.orchestrator?.settleCourier({
          operationId: msg.operationId,
          result: msg.result,
          error: msg.error,
        });
        this.emit({
          type: "voice.courier.result.response",
          payload: { requestId: msg.requestId },
        });
        return;
    }
  }

  cleanup(): void {
    this.boundCall?.clearListener(this.listener);
    this.boundCall = null;
    this.releaseUpdates();
    this.releaseCourier();
  }

  private releaseCourier(): void {
    const courier = this.courier;
    this.courier = null;
    void courier?.owner.release().catch((error: unknown) => {
      this.options.logger.warn({ err: error }, "Failed to release the voice courier");
    });
  }

  private claimCourier(): CourierChannel | null {
    const source = this.options.delivery.currentSource;
    if (!source) return null;
    if (this.courier?.source !== source) {
      this.releaseCourier();
      const owner = this.options.delivery.operation(isCourierExecute, () => {
        if (this.courier?.owner === owner) this.courier = null;
      });
      this.courier = { owner, source };
    }
    const owner = this.courier.owner;
    return (request) =>
      owner.emit({
        type: "voice.courier.execute",
        payload: {
          operationId: request.operationId,
          serverId: request.serverId,
          tool: request.tool,
          args: request.args,
          language: request.language,
        },
      });
  }

  private async handleFleetDigest(
    msg: Extract<VoiceMessagesRequest, { type: "voice.fleet.digest.request" }>,
  ): Promise<void> {
    try {
      const orchestrator = this.requireOrchestrator();
      if (msg.language) orchestrator.setPreferredLanguage(msg.language);
      const digest = await orchestrator.fleetDigest();
      this.emit({
        type: "voice.fleet.digest.response",
        payload: { requestId: msg.requestId, digest, error: null },
      });
    } catch (error) {
      this.emit({
        type: "voice.fleet.digest.response",
        payload: { requestId: msg.requestId, digest: null, error: getErrorMessage(error) },
      });
    }
  }

  private async handleFleetSync(
    msg: Extract<VoiceMessagesRequest, { type: "voice.fleet.sync.request" }>,
  ): Promise<void> {
    const active =
      this.options.orchestrator?.updateRemoteFleet({
        hosts: msg.hosts,
        appState: msg.appState ?? null,
        selfLabel: msg.selfLabel ?? null,
        channel: this.claimCourier(),
      }) ?? false;
    if (!active) this.releaseCourier();
    this.emit({
      type: "voice.fleet.sync.response",
      payload: { requestId: msg.requestId, active },
    });
  }

  private async handleToolsInvoke(
    msg: Extract<VoiceMessagesRequest, { type: "voice.tools.invoke.request" }>,
  ): Promise<void> {
    try {
      const orchestrator = this.requireOrchestrator();
      if (msg.language) orchestrator.setPreferredLanguage(msg.language);
      const result = await orchestrator.invokeTool({
        operationId: msg.operationId,
        tool: msg.tool,
        args: msg.args,
      });
      this.emit({
        type: "voice.tools.invoke.response",
        payload: {
          requestId: msg.requestId,
          operationId: msg.operationId,
          result,
          error: null,
        },
      });
    } catch (error) {
      this.emit({
        type: "voice.tools.invoke.response",
        payload: {
          requestId: msg.requestId,
          operationId: msg.operationId,
          result: null,
          error: getErrorMessage(error),
        },
      });
    }
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
