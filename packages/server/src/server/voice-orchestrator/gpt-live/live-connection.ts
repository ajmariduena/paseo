import { EventEmitter } from "node:events";
import { WebSocket, type RawData } from "ws";

export const GPT_LIVE_URL = "wss://api.openai.com/v1/live/sessions";
export const GPT_LIVE_SAMPLE_RATE = 16000;
const START_TIMEOUT_MS = 15_000;
// The Live API rejects appends longer than this many tokens.
const MAX_APPEND_CHARS = 1_800;

export interface GptLiveSessionOptions {
  apiKey: string;
  model: string;
  voice: string;
  instructions: string;
}

export type GptLiveServerEvent =
  | { type: "session.started"; session: { id: string } }
  | { type: "session.output_audio.delta"; delta: string }
  | { type: "session.input_transcript.delta"; delta: string; start_ms?: number; end_ms?: number }
  | { type: "session.output_transcript.delta"; delta: string; start_ms?: number; end_ms?: number }
  | {
      type: "session.delegation.created";
      offset_ms?: number;
      delegation: { id: string; target: string };
    }
  | { type: "session.closed"; usage?: unknown }
  | { type: "error"; error: { message?: string; code?: string; type?: string } }
  | { type: string; [key: string]: unknown };

type AppendKind = "instructions" | "thinking" | "commentary";

export interface GptLiveConnectionEvents {
  event: [GptLiveServerEvent];
  close: [];
}

/** One GPT-Live session over the server WebSocket transport, client delegation mode. */
export class GptLiveConnection extends EventEmitter<GptLiveConnectionEvents> {
  private socket: WebSocket | null = null;

  constructor(private readonly url = GPT_LIVE_URL) {
    super();
  }

  private started = false;
  private eventCounter = 0;

  async start(options: GptLiveSessionOptions): Promise<string> {
    const socket = new WebSocket(this.url, {
      headers: { Authorization: `Bearer ${options.apiKey}` },
      followRedirects: false,
    });
    this.socket = socket;
    socket.on("message", (data) => {
      const event = parseEvent(data);
      if (!event) return;
      if (event.type === "session.closed") socket.close();
      this.emit("event", event);
    });
    socket.on("close", () => {
      this.started = false;
      this.emit("close");
    });

    return await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        socket.terminate();
        reject(new Error("GPT-Live did not start in time"));
      }, START_TIMEOUT_MS);
      const onEvent = (event: GptLiveServerEvent) => {
        if (event.type === "session.started") {
          cleanup();
          this.started = true;
          resolve((event as { session: { id: string } }).session.id);
        } else if (event.type === "error") {
          cleanup();
          socket.terminate();
          reject(new Error(describeError(event)));
        }
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("GPT-Live closed the connection before the session started"));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.off("event", onEvent);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      this.on("event", onEvent);
      socket.once("error", onError);
      socket.once("close", onClose);
      socket.once("open", () => {
        this.send({
          type: "session.start",
          event_id: this.nextEventId(),
          session: {
            model: options.model,
            instructions: options.instructions,
            audio: {
              format: { type: "audio/pcm", rate: GPT_LIVE_SAMPLE_RATE },
              output: { voice: options.voice },
            },
            delegation: { type: "client" },
          },
        });
      });
    });
  }

  get isStarted(): boolean {
    return this.started;
  }

  appendAudio(pcm16: Buffer): void {
    if (!this.started || pcm16.length === 0) return;
    this.send({ type: "session.input_audio.append", audio: pcm16.toString("base64") });
  }

  append(kind: AppendKind, content: string, delegationId: string | null): void {
    if (!this.started) return;
    this.send({
      type: `session.${kind}.append`,
      event_id: this.nextEventId(),
      delegation_id: delegationId,
      content:
        content.length > MAX_APPEND_CHARS ? `${content.slice(0, MAX_APPEND_CHARS)}…` : content,
    });
  }

  setInputMuted(muted: boolean): void {
    if (!this.started) return;
    this.send({
      type: muted ? "session.input_audio.mute" : "session.input_audio.unmute",
      event_id: this.nextEventId(),
    });
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    if (this.started && socket.readyState === WebSocket.OPEN) {
      this.send({ type: "session.close", event_id: this.nextEventId() }, socket);
      setTimeout(() => socket.terminate(), 5_000).unref();
    } else {
      socket.terminate();
    }
    this.started = false;
  }

  private send(message: Record<string, unknown>, socket = this.socket): void {
    if (socket?.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  private nextEventId(): string {
    this.eventCounter += 1;
    return `paseo_${this.eventCounter}`;
  }
}

function parseEvent(data: RawData): GptLiveServerEvent | null {
  try {
    return JSON.parse(data.toString()) as GptLiveServerEvent;
  } catch {
    return null;
  }
}

export function describeError(event: GptLiveServerEvent): string {
  const error = (event as { error?: { message?: string; code?: string } }).error;
  return error?.message ?? error?.code ?? "GPT-Live error";
}
