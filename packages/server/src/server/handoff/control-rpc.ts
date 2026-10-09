import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { HandoffDestinationSnapshotSchema } from "@getpaseo/protocol/handoff-control";
import type { HandoffSource } from "./source.js";
import type { HandoffDestination, DestinationHandoffStatus } from "./destination.js";
const responseTypes = {
  "workspace.handoff.find_source.request": "workspace.handoff.find_source.response",
  "workspace.handoff.preview_source.request": "workspace.handoff.preview_source.response",
  "workspace.handoff.preview_destination.request": "workspace.handoff.preview_destination.response",
  "workspace.handoff.cancel_source.request": "workspace.handoff.cancel_source.response",
  "workspace.handoff.cancel_destination.request": "workspace.handoff.cancel_destination.response",
  "workspace.handoff.inspect_source.request": "workspace.handoff.inspect_source.response",
  "workspace.handoff.prepare_source.request": "workspace.handoff.prepare_source.response",
  "workspace.handoff.get_source_status.request": "workspace.handoff.get_source_status.response",
  "workspace.handoff.release_source.request": "workspace.handoff.release_source.response",
  "workspace.handoff.reserve_destination.request": "workspace.handoff.reserve_destination.response",
  "workspace.handoff.bind_destination.request": "workspace.handoff.bind_destination.response",
  "workspace.handoff.stage_destination.request": "workspace.handoff.stage_destination.response",
  "workspace.handoff.get_destination_status.request":
    "workspace.handoff.get_destination_status.response",
  "workspace.handoff.activate_destination.request":
    "workspace.handoff.activate_destination.response",
} as const;
type ControlRequest = Extract<SessionInboundMessage, { type: keyof typeof responseTypes }>;
type ControlResponse = Extract<
  SessionOutboundMessage,
  { type: (typeof responseTypes)[keyof typeof responseTypes] }
>;
interface Services {
  source: HandoffSource | undefined;
  destination: HandoffDestination | undefined;
}
function snapshot(record: DestinationHandoffStatus) {
  return HandoffDestinationSnapshotSchema.parse({
    ...record,
    manifestDigest: record.binding?.manifest.entrypoint.sha256 ?? null,
  });
}
function errorResponse(request: ControlRequest, error: unknown): ControlResponse {
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "operation_failed";
  const message = error instanceof Error ? error.message : "Handoff operation failed";
  return {
    type: responseTypes[request.type],
    payload: { requestId: request.requestId, result: null, error: { code, message, blob: null } },
  };
}
async function handle(services: Services, request: ControlRequest): Promise<ControlResponse> {
  const payload = { requestId: request.requestId, error: null };
  function source() {
    if (!services.source) throw new Error("Source handoff service is unavailable");
    return services.source;
  }
  function destination() {
    if (!services.destination) throw new Error("Destination handoff service is unavailable");
    return services.destination;
  }
  try {
    switch (request.type) {
      case "workspace.handoff.find_source.request":
        return {
          type: responseTypes[request.type],
          payload: { ...payload, result: source().findWorkspace(request.workspaceId) },
        };
      case "workspace.handoff.preview_source.request":
        return {
          type: responseTypes[request.type],
          payload: { ...payload, result: await source().preview(request.workspaceId) },
        };
      case "workspace.handoff.preview_destination.request":
        return {
          type: responseTypes[request.type],
          payload: { ...payload, result: await destination().preview(request.conversations) },
        };
      case "workspace.handoff.cancel_source.request":
        return {
          type: responseTypes[request.type],
          payload: { ...payload, result: await source().cancel(request) },
        };
      case "workspace.handoff.cancel_destination.request":
        return {
          type: responseTypes[request.type],
          payload: {
            ...payload,
            result: snapshot(await destination().cancel(request.transferId, request.proof)),
          },
        };
      case "workspace.handoff.inspect_source.request":
        return {
          type: responseTypes[request.type],
          payload: { ...payload, result: await source().inspect(request.workspaceId) },
        };
      case "workspace.handoff.prepare_source.request":
        return {
          type: responseTypes[request.type],
          payload: { ...payload, result: await source().prepare(request) },
        };
      case "workspace.handoff.get_source_status.request":
        return {
          type: responseTypes[request.type],
          payload: { ...payload, result: await source().status(request.transferId) },
        };
      case "workspace.handoff.release_source.request":
        return {
          type: responseTypes[request.type],
          payload: { ...payload, result: await source().release(request.transferId) },
        };
      case "workspace.handoff.reserve_destination.request":
        return {
          type: responseTypes[request.type],
          payload: { ...payload, result: snapshot(await destination().reserve(request)) },
        };
      case "workspace.handoff.bind_destination.request":
        return {
          type: responseTypes[request.type],
          payload: { ...payload, result: snapshot(await destination().bindSource(request)) },
        };
      case "workspace.handoff.stage_destination.request":
        return {
          type: responseTypes[request.type],
          payload: { ...payload, result: snapshot(await destination().stage(request.transferId)) },
        };
      case "workspace.handoff.get_destination_status.request":
        return {
          type: responseTypes[request.type],
          payload: { ...payload, result: snapshot(destination().status(request.transferId)) },
        };
      case "workspace.handoff.activate_destination.request":
        // Without a supplied receipt, activate requires the destination's previously verified release.
        if (request.receipt) await destination().acceptRelease(request.transferId, request.receipt);
        return {
          type: responseTypes[request.type],
          payload: {
            ...payload,
            result: snapshot(await destination().activate(request.transferId)),
          },
        };
    }
  } catch (error) {
    return errorResponse(request, error);
  }
}
export function dispatchHandoffControlMessage(
  input: Services & {
    message: SessionInboundMessage;
    emit: (message: SessionOutboundMessage) => void;
  },
): Promise<void> | undefined {
  switch (input.message.type) {
    case "workspace.handoff.find_source.request":
    case "workspace.handoff.preview_source.request":
    case "workspace.handoff.preview_destination.request":
    case "workspace.handoff.cancel_source.request":
    case "workspace.handoff.cancel_destination.request":
    case "workspace.handoff.inspect_source.request":
    case "workspace.handoff.prepare_source.request":
    case "workspace.handoff.get_source_status.request":
    case "workspace.handoff.release_source.request":
    case "workspace.handoff.reserve_destination.request":
    case "workspace.handoff.bind_destination.request":
    case "workspace.handoff.stage_destination.request":
    case "workspace.handoff.get_destination_status.request":
    case "workspace.handoff.activate_destination.request":
      return handle(input, input.message).then(input.emit);
    default:
      return undefined;
  }
}
