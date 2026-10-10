import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { HandoffArchiveError, type HandoffArchiveStore } from "./archive.js";

const responseTypes = {
  "workspace.handoff.begin_archive.request": "workspace.handoff.begin_archive.response",
  "workspace.handoff.get_archive_status.request": "workspace.handoff.get_archive_status.response",
  "workspace.handoff.write_archive_chunk.request": "workspace.handoff.write_archive_chunk.response",
  "workspace.handoff.read_archive_chunk.request": "workspace.handoff.read_archive_chunk.response",
  "workspace.handoff.seal_archive.request": "workspace.handoff.seal_archive.response",
  "workspace.handoff.reset_archive_blob.request": "workspace.handoff.reset_archive_blob.response",
} as const;

type ArchiveRequest = Extract<SessionInboundMessage, { type: keyof typeof responseTypes }>;
type ArchiveResponse = Extract<
  SessionOutboundMessage,
  { type: (typeof responseTypes)[keyof typeof responseTypes] }
>;

async function handle(
  store: HandoffArchiveStore | undefined,
  request: ArchiveRequest,
): Promise<ArchiveResponse> {
  if (!store) throw new Error("Handoff archive service is unavailable");
  const payload = { requestId: request.requestId, transferId: request.transferId, error: null };
  try {
    switch (request.type) {
      case "workspace.handoff.begin_archive.request":
        return {
          type: responseTypes[request.type],
          payload: {
            ...payload,
            result: await store.begin({ id: request.transferId, manifest: request.manifest }),
          },
        };
      case "workspace.handoff.get_archive_status.request":
        return {
          type: responseTypes[request.type],
          payload: { ...payload, result: await store.status(request.transferId) },
        };
      case "workspace.handoff.write_archive_chunk.request": {
        const data = Buffer.from(request.data, "base64");
        if (data.toString("base64") !== request.data)
          throw new HandoffArchiveError(
            "invalid_chunk",
            "Chunk must use canonical base64 encoding",
          );
        return {
          type: responseTypes[request.type],
          payload: {
            ...payload,
            result: await store.writeChunk({
              id: request.transferId,
              sha256: request.sha256,
              offset: request.offset,
              data,
            }),
          },
        };
      }
      case "workspace.handoff.read_archive_chunk.request": {
        const bytes = await store.readChunk({
          id: request.transferId,
          sha256: request.sha256,
          offset: request.offset,
          length: request.length,
        });
        return {
          type: responseTypes[request.type],
          payload: { ...payload, result: bytes.toString("base64") },
        };
      }
      case "workspace.handoff.seal_archive.request":
        return {
          type: responseTypes[request.type],
          payload: { ...payload, result: await store.seal(request.transferId) },
        };
      case "workspace.handoff.reset_archive_blob.request":
        await store.resetBlob(request.transferId, request.sha256);
        return { type: responseTypes[request.type], payload: { ...payload, result: true } };
    }
  } catch (error) {
    if (!(error instanceof HandoffArchiveError)) throw error;
    return {
      type: responseTypes[request.type],
      payload: {
        ...payload,
        result: null,
        error: { code: error.code, message: error.message, blob: error.blob },
      },
    };
  }
}

export function dispatchHandoffArchiveMessage(input: {
  store: HandoffArchiveStore | undefined;
  message: SessionInboundMessage;
  emit: (message: SessionOutboundMessage) => void;
}): Promise<void> | undefined {
  const { message } = input;
  switch (message.type) {
    case "workspace.handoff.begin_archive.request":
    case "workspace.handoff.get_archive_status.request":
    case "workspace.handoff.write_archive_chunk.request":
    case "workspace.handoff.read_archive_chunk.request":
    case "workspace.handoff.seal_archive.request":
    case "workspace.handoff.reset_archive_blob.request":
      return handle(input.store, message).then(input.emit);
    default:
      return undefined;
  }
}
