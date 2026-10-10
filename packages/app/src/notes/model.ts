import { stripNoteLineMarker } from "@getpaseo/protocol/notes/types";
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import type { HostNote } from "./data";

export type NoteSelection =
  | { kind: "draft"; serverId: string }
  | { kind: "note"; serverId: string; noteId: string };

export function noteKey(note: Pick<HostNote, "serverId" | "id">): string {
  return `${note.serverId}:${note.id}`;
}

export function isSelectedNote(note: HostNote, selection: NoteSelection | null): boolean {
  return (
    selection?.kind === "note" &&
    note.serverId === selection.serverId &&
    note.id === selection.noteId
  );
}

function matchesSearch(note: HostNote, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return (
    note.title.toLowerCase().includes(normalized) || note.body.toLowerCase().includes(normalized)
  );
}

export function filterNotes(notes: readonly HostNote[], query: string): HostNote[] {
  return notes.filter((note) => matchesSearch(note, query));
}

export function isBlankNoteText(text: string): boolean {
  return text.trim().length === 0;
}

/** A stored title becomes the first body line, so the editor (body only) owns all of the text. */
export function foldTitleIntoBody(note: Pick<HostNote, "title" | "body">): string {
  const title = note.title.trim();
  if (!title) return note.body;
  return note.body ? `${title}\n${note.body}` : title;
}

const CHECKLIST_ITEM = /^(\s*)([-*+])\s+\[([ xX])\](\s?)(.*)$/;
const BULLET_ITEM = /^(\s*)([-*+])\s+(.*)$/;

export interface ChecklistProgress {
  done: number;
  total: number;
}

export function checklistProgress(body: string): ChecklistProgress | null {
  let done = 0;
  let total = 0;
  for (const line of body.split("\n")) {
    const match = CHECKLIST_ITEM.exec(line);
    if (!match) continue;
    total += 1;
    if (match[3] !== " ") done += 1;
  }
  return total > 0 ? { done, total } : null;
}

export type NoteSummary =
  | { kind: "progress"; done: number; total: number }
  | { kind: "line"; text: string };

/** What the list row shows after the time: checklist progress, else the line after the title. */
export function noteSummaryLine(note: Pick<HostNote, "title" | "body">): NoteSummary | null {
  const progress = checklistProgress(note.body);
  if (progress) return { kind: "progress", ...progress };
  const lines = note.body
    .split("\n")
    .map(stripNoteLineMarker)
    .filter((line) => line.length > 0);
  const text = note.title.trim() ? lines[0] : lines[1];
  return text ? { kind: "line", text } : null;
}

export interface TextSelection {
  start: number;
  end: number;
}

export interface TextEdit {
  text: string;
  selection: TextSelection;
}

function lineBounds(text: string, offset: number): { start: number; end: number } {
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  const newline = text.indexOf("\n", offset);
  return { start, end: newline === -1 ? text.length : newline };
}

function shiftOffset(offset: number, at: number, delta: number): number {
  return offset >= at ? Math.max(at, offset + delta) : offset;
}

/** ⌘⏎: flips `- [ ]` ⇄ `- [x]` on the caret line, or turns the line into an open item. */
export function toggleChecklistLine(text: string, selection: TextSelection): TextEdit {
  const bounds = lineBounds(text, selection.start);
  const line = text.slice(bounds.start, bounds.end);
  const item = CHECKLIST_ITEM.exec(line);
  if (item) {
    const markIndex = bounds.start + line.indexOf("[") + 1;
    const mark = item[3] === " " ? "x" : " ";
    return {
      text: `${text.slice(0, markIndex)}${mark}${text.slice(markIndex + 1)}`,
      selection,
    };
  }
  const bullet = BULLET_ITEM.exec(line);
  const indent = bullet ? bullet[1] : (/^\s*/.exec(line)?.[0] ?? "");
  const contentStart = bounds.start + line.length - (bullet ? bullet[3] : line.trimStart()).length;
  const replaced = text.slice(bounds.start, contentStart);
  const inserted = `${indent}- [ ] `;
  const delta = inserted.length - replaced.length;
  return {
    text: `${text.slice(0, bounds.start)}${inserted}${text.slice(contentStart)}`,
    selection: {
      start: shiftOffset(selection.start, contentStart, delta),
      end: shiftOffset(selection.end, contentStart, delta),
    },
  };
}

/**
 * ⏎ at the end of a checklist item starts the next item; ⏎ on an empty item removes its marker.
 * Returns null when Enter should insert a plain newline.
 */
export function continueChecklist(text: string, selection: TextSelection): TextEdit | null {
  if (selection.start !== selection.end) return null;
  const caret = selection.start;
  const bounds = lineBounds(text, caret);
  if (caret !== bounds.end) return null;
  const item = CHECKLIST_ITEM.exec(text.slice(bounds.start, bounds.end));
  if (!item) return null;
  const [, indent, bullet, , , content] = item;
  if (!content.trim()) {
    return {
      text: `${text.slice(0, bounds.start)}${text.slice(bounds.end)}`,
      selection: { start: bounds.start, end: bounds.start },
    };
  }
  const inserted = `\n${indent}${bullet} [ ] `;
  const next = caret + inserted.length;
  return {
    text: `${text.slice(0, caret)}${inserted}${text.slice(caret)}`,
    selection: { start: next, end: next },
  };
}

export function appendTranscript(current: string, transcript: string): string {
  const addition = transcript.trim();
  if (!addition) return current;
  if (!current.trim()) return addition;
  return /\s$/.test(current) ? `${current}${addition}` : `${current} ${addition}`;
}

export type LinkedAgentState = "running" | "review" | "error" | "idle" | "archived";

export interface LinkedAgentSource {
  status: AgentLifecycleStatus;
  archivedAt?: Date | null;
}

/** "Ready to review" only applies to open todos: an idle agent finished a turn, not the work. */
export function resolveLinkedAgentState(
  agent: LinkedAgentSource,
  note: Pick<HostNote, "todoState">,
): LinkedAgentState {
  if (agent.archivedAt) return "archived";
  if (agent.status === "running" || agent.status === "initializing") return "running";
  if (agent.status === "error") return "error";
  return note.todoState === "open" ? "review" : "idle";
}

export function linkedAgentStateVariant(
  state: LinkedAgentState,
): "success" | "warning" | "error" | "muted" {
  if (state === "running") return "success";
  if (state === "review") return "warning";
  if (state === "error") return "error";
  return "muted";
}
