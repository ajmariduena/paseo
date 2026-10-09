import type pino from "pino";
import type { VoiceOrchestrator } from "../orchestrator.js";
import { buildLiveInstructions } from "../prompt.js";
import { createGptLiveWebrtcSession } from "./live-connection.js";
import { GptLiveCall } from "./live-call.js";

/**
 * Live calls whose audio runs over WebRTC between the phone and OpenAI. The host creates
 * each session with its own key and controls it through a sideband, so the call does not
 * depend on the phone's connection to this host.
 */
export class LiveWebrtcHub {
  private readonly calls = new Map<string, GptLiveCall>();

  constructor(
    private readonly options: {
      orchestrator: VoiceOrchestrator;
      logger: pino.Logger;
      createSession?: typeof createGptLiveWebrtcSession;
    },
  ) {}

  get available(): boolean {
    return this.options.orchestrator.liveEngine !== null;
  }

  async connect(params: { sdp: string }): Promise<{ sessionId: string; sdp: string }> {
    const { orchestrator, logger } = this.options;
    const engine = orchestrator.liveEngine;
    if (!engine) throw new Error("GPT-Live is not configured on this host.");
    orchestrator.noteCallStarting();
    if (orchestrator.hasFastBrain) {
      // The fast brain answers on its own; the agent is only needed for escalated work.
      void orchestrator.ensureAgent().catch((error: unknown) => {
        logger.warn({ err: error }, "Voice agent unavailable; escalated requests will fail");
      });
    } else {
      await orchestrator.ensureAgent();
    }
    this.endAll();
    const history = orchestrator.takeRecentHistory("messages");
    const createSession = this.options.createSession ?? createGptLiveWebrtcSession;
    const answer = await createSession({
      apiKey: engine.apiKey,
      model: engine.model,
      voice: engine.voice,
      instructions: buildLiveInstructions(orchestrator.language),
      sdp: params.sdp,
      history,
    });
    const call = new GptLiveCall({
      engine,
      orchestrator,
      emit: () => undefined,
      logger: logger.child({ component: "gpt-live-webrtc", sessionId: answer.sessionId }),
      sidebandSessionId: answer.sessionId,
      previousHistory: history,
    });
    try {
      await call.start();
    } catch (error) {
      call.close();
      throw error;
    }
    this.calls.set(answer.sessionId, call);
    logger.info({ sessionId: answer.sessionId }, "GPT-Live WebRTC call started");
    return answer;
  }

  end(sessionId: string): void {
    this.calls.get(sessionId)?.close();
    this.calls.delete(sessionId);
  }

  endAll(): void {
    for (const call of this.calls.values()) call.close();
    this.calls.clear();
  }
}
