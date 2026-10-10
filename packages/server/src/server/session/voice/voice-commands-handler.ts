import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { VoiceCommandsService } from "../../voice-orchestrator/fast-brain/voice-commands-service.js";

export type VoiceCommandsRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "voice.commands.get_settings.request"
      | "voice.commands.set_model.request"
      | "voice.commands.set_key.request"
      | "voice.commands.test_model.request";
  }
>;

export function isVoiceCommandsRequest(msg: SessionInboundMessage): msg is VoiceCommandsRequest {
  return msg.type.startsWith("voice.commands.");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const UNAVAILABLE = "Voice commands are not available on this host";

/** Settings → Voice → Voice commands: read, change and test the call's fast model. */
export async function handleVoiceCommandsRequest(
  msg: VoiceCommandsRequest,
  context: {
    service: VoiceCommandsService | null;
    emit: (message: SessionOutboundMessage) => void;
  },
): Promise<void> {
  const { service, emit } = context;
  if (msg.type === "voice.commands.test_model.request") {
    if (!service) {
      emit({
        type: "voice.commands.test_model.response",
        payload: {
          requestId: msg.requestId,
          ok: false,
          roundTripMs: null,
          model: null,
          error: UNAVAILABLE,
          settings: null,
        },
      });
      return;
    }
    const result = await service.test(msg.target);
    emit({
      type: "voice.commands.test_model.response",
      payload: { requestId: msg.requestId, ...result },
    });
    return;
  }
  const type = responseType(msg);
  try {
    if (!service) throw new Error(UNAVAILABLE);
    const settings = applyRequest(service, msg);
    emit({ type, payload: { requestId: msg.requestId, settings, error: null } });
  } catch (error) {
    emit({
      type,
      payload: { requestId: msg.requestId, settings: null, error: errorMessage(error) },
    });
  }
}

type SettingsRequest = Exclude<VoiceCommandsRequest, { type: "voice.commands.test_model.request" }>;

function responseType(
  msg: SettingsRequest,
):
  | "voice.commands.get_settings.response"
  | "voice.commands.set_model.response"
  | "voice.commands.set_key.response" {
  switch (msg.type) {
    case "voice.commands.get_settings.request":
      return "voice.commands.get_settings.response";
    case "voice.commands.set_model.request":
      return "voice.commands.set_model.response";
    case "voice.commands.set_key.request":
      return "voice.commands.set_key.response";
  }
}

function applyRequest(service: VoiceCommandsService, msg: SettingsRequest) {
  switch (msg.type) {
    case "voice.commands.get_settings.request":
      return service.settings();
    case "voice.commands.set_model.request":
      return service.setModel({
        selection: msg.selection,
        backup: msg.backup,
        customBaseUrl: msg.customBaseUrl,
      });
    case "voice.commands.set_key.request":
      return service.setKey({ provider: msg.provider, apiKey: msg.apiKey });
  }
}
