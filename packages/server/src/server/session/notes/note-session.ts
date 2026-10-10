import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { NoteError, type NoteStore } from "../../notes/store.js";

type NoteRequest = Extract<SessionInboundMessage, { type: `note.${string}.request` }>;

export interface NoteSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface NoteSessionOptions {
  host: NoteSessionHost;
  noteStore: NoteStore;
  logger: pino.Logger;
}

export function createNoteSession(input: {
  noteStore: NoteStore | undefined;
  emit: NoteSessionHost["emit"];
  logger: pino.Logger;
}): NoteSession | null {
  if (!input.noteStore) return null;
  return new NoteSession({
    host: { emit: input.emit },
    noteStore: input.noteStore,
    logger: input.logger,
  });
}

export class NoteSession {
  private readonly host: NoteSessionHost;
  private readonly noteStore: NoteStore;
  private readonly logger: pino.Logger;

  constructor(options: NoteSessionOptions) {
    this.host = options.host;
    this.noteStore = options.noteStore;
    this.logger = options.logger;
  }

  dispatch(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "note.list.request":
      case "note.create.request":
      case "note.update.request":
      case "note.archive.request":
      case "note.delete.request":
      case "note.link_agent.request":
        return this.handle(msg);
      default:
        return undefined;
    }
  }

  private async handle(request: NoteRequest): Promise<void> {
    try {
      this.host.emit(await this.respond(request));
    } catch (error) {
      this.emitError(request, error);
    }
  }

  private async respond(request: NoteRequest): Promise<SessionOutboundMessage> {
    const requestId = request.requestId;
    switch (request.type) {
      case "note.list.request":
        return {
          type: "note.list.response",
          payload: {
            requestId,
            notes: await this.noteStore.list({ includeArchived: request.includeArchived }),
          },
        };
      case "note.create.request": {
        const note = await this.noteStore.create({
          title: request.title,
          body: request.body,
          todo: request.todo,
          projectId: request.projectId,
          workspaceId: request.workspaceId,
          author: { type: "user" },
        });
        return { type: "note.create.response", payload: { requestId, note } };
      }
      case "note.update.request": {
        const note = await this.noteStore.update(request.noteId, {
          title: request.title,
          body: request.body,
          todoState: request.todoState,
          projectId: request.projectId,
          expectedRevision: request.expectedRevision,
        });
        return { type: "note.update.response", payload: { requestId, note } };
      }
      case "note.archive.request": {
        const note = await this.noteStore.setArchived(request.noteId, request.archived);
        return { type: "note.archive.response", payload: { requestId, note } };
      }
      case "note.delete.request":
        await this.noteStore.delete(request.noteId);
        return { type: "note.delete.response", payload: { requestId, noteId: request.noteId } };
      case "note.link_agent.request": {
        const note = await this.noteStore.linkAgent(request.noteId, request.agentId);
        return { type: "note.link_agent.response", payload: { requestId, note } };
      }
    }
  }

  private emitError(request: NoteRequest, error: unknown): void {
    const code = error instanceof NoteError ? error.code : "note_request_failed";
    if (!(error instanceof NoteError)) {
      this.logger.error({ err: error, requestType: request.type }, "Note request failed");
    }
    this.host.emit({
      type: "rpc_error",
      payload: {
        requestId: request.requestId,
        requestType: request.type,
        code,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}
