import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type pino from "pino";

export type CallTranscriptKind =
  | "call_started"
  | "user"
  | "assistant"
  | "delegation"
  | "result"
  | "notice"
  | "status"
  | "muted"
  | "unmuted"
  | "call_ended";

export interface CallTranscriptEntry {
  at: string;
  kind: CallTranscriptKind;
  text: string;
  detail?: Record<string, unknown>;
}

const LABELS: Record<CallTranscriptKind, string> = {
  call_started: "Inicio",
  user: "Tú",
  assistant: "Paseo",
  delegation: "Delegó",
  result: "Resultado",
  notice: "Aviso",
  status: "Estado",
  muted: "Micrófono silenciado",
  unmuted: "Micrófono activado",
  call_ended: "Fin",
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function localTime(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function renderMarkdown(params: {
  mode: string;
  callId: string;
  startedAt: Date;
  entries: CallTranscriptEntry[];
}): string {
  const { startedAt } = params;
  const date = `${startedAt.getFullYear()}-${pad(startedAt.getMonth() + 1)}-${pad(startedAt.getDate())}`;
  const lines = [
    `# Llamada de voz · ${date} ${localTime(startedAt)}`,
    "",
    `Modo: ${params.mode} · id \`${params.callId}\``,
    "",
  ];
  for (const entry of params.entries) {
    const time = localTime(new Date(entry.at));
    const text = entry.text.replace(/\s+/g, " ").trim();
    switch (entry.kind) {
      case "user":
      case "assistant":
        lines.push(`**${time} ${LABELS[entry.kind]}:** ${text}`, "");
        break;
      default:
        lines.push(`> ${time} · ${LABELS[entry.kind]}${text ? `: ${text}` : ""}`, "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * The record of one voice call: every turn, delegation, result, notice and state change,
 * appended as JSONL while the call runs and rendered to Markdown when it ends, so a call can
 * be read back later. Writes are best-effort; a full disk must not break the call.
 */
export class CallTranscript {
  private readonly entries: CallTranscriptEntry[] = [];
  private readonly startedAt = new Date();
  private readonly basePath: string;
  private writes: Promise<void>;
  private closed = false;

  constructor(
    private readonly options: {
      directory: string;
      callId: string;
      mode: string;
      logger: pino.Logger;
    },
  ) {
    const started = this.startedAt;
    const day = `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())}`;
    const stamp = `${pad(started.getHours())}${pad(started.getMinutes())}${pad(started.getSeconds())}`;
    const dayDirectory = join(options.directory, day);
    this.basePath = join(dayDirectory, `${stamp}-${options.mode}-${options.callId.slice(0, 8)}`);
    this.writes = mkdir(dayDirectory, { recursive: true }).then(
      () => undefined,
      (error: unknown) => this.warn(error),
    );
    this.record("call_started", "", { mode: options.mode, callId: options.callId });
  }

  get path(): string {
    return `${this.basePath}.md`;
  }

  record(kind: CallTranscriptKind, text: string, detail?: Record<string, unknown>): void {
    if (this.closed) return;
    const entry: CallTranscriptEntry = {
      at: new Date().toISOString(),
      kind,
      text,
      ...(detail ? { detail } : {}),
    };
    this.entries.push(entry);
    this.enqueue(() => appendFile(`${this.basePath}.jsonl`, `${JSON.stringify(entry)}\n`));
  }

  close(detail?: Record<string, unknown>): Promise<void> {
    if (this.closed) return this.writes;
    this.record("call_ended", "", detail);
    this.closed = true;
    this.enqueue(() =>
      writeFile(
        this.path,
        renderMarkdown({
          mode: this.options.mode,
          callId: this.options.callId,
          startedAt: this.startedAt,
          entries: this.entries,
        }),
      ),
    );
    return this.writes;
  }

  private enqueue(write: () => Promise<void>): void {
    this.writes = this.writes.then(write).catch((error: unknown) => this.warn(error));
  }

  private warn(error: unknown): void {
    this.options.logger.warn({ err: error, path: this.basePath }, "Voice transcript write failed");
  }
}
