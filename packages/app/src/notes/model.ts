import { noteDisplayTitle } from "@getpaseo/protocol/notes/types";
import type { AgentLifecycleStatus } from "@getpaseo/protocol/agent-lifecycle";
import type { HostNote } from "./data";

export type NotesFilter = "all" | "todos" | "done";

export interface NoteSelection {
  serverId: string;
  noteId: string;
}

export function noteKey(note: Pick<HostNote, "serverId" | "id">): string {
  return `${note.serverId}:${note.id}`;
}

export function isSelectedNote(note: HostNote, selection: NoteSelection | null): boolean {
  return selection !== null && note.serverId === selection.serverId && note.id === selection.noteId;
}

function matchesFilter(note: HostNote, filter: NotesFilter): boolean {
  if (filter === "todos") return note.todoState === "open";
  if (filter === "done") return note.todoState === "done";
  return note.todoState !== "done";
}

function matchesSearch(note: HostNote, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return (
    note.title.toLowerCase().includes(normalized) || note.body.toLowerCase().includes(normalized)
  );
}

export function filterNotes(
  notes: readonly HostNote[],
  input: { filter: NotesFilter; query: string },
): HostNote[] {
  return notes.filter(
    (note) => matchesFilter(note, input.filter) && matchesSearch(note, input.query),
  );
}

export function countOpenTodos(notes: readonly HostNote[]): number {
  return notes.filter((note) => note.todoState === "open").length;
}

export interface NoteGroup {
  key: string;
  label: string;
  notes: HostNote[];
}

/**
 * Groups by project, in the order each project first appears in the (newest-first) list, with
 * notes that have no project last. Host names join the label only when notes span hosts.
 */
export function groupNotesByProject(
  notes: readonly HostNote[],
  input: {
    projectName: (serverId: string, projectId: string) => string | null;
    noProjectLabel: string;
  },
): NoteGroup[] {
  const multiHost = new Set(notes.map((note) => note.serverId)).size > 1;
  const groups = new Map<string, NoteGroup>();
  const unassigned = new Map<string, NoteGroup>();
  for (const note of notes) {
    const hostSuffix = multiHost ? ` · ${note.serverName}` : "";
    if (note.projectId) {
      const key = `${note.serverId}:${note.projectId}`;
      const existing = groups.get(key);
      if (existing) {
        existing.notes.push(note);
        continue;
      }
      const name = input.projectName(note.serverId, note.projectId) ?? input.noProjectLabel;
      groups.set(key, { key, label: `${name}${hostSuffix}`, notes: [note] });
      continue;
    }
    const key = `${note.serverId}:none`;
    const existing = unassigned.get(key);
    if (existing) existing.notes.push(note);
    else unassigned.set(key, { key, label: `${input.noProjectLabel}${hostSuffix}`, notes: [note] });
  }
  return [...groups.values(), ...unassigned.values()];
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

export function noteSearchText(note: HostNote): string {
  return noteDisplayTitle(note);
}
