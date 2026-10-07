import { useCallback, useMemo } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  CreateNoteOptions,
  DaemonClient,
  UpdateNoteOptions,
} from "@getpaseo/client/internal/daemon-client";
import type { Note } from "@getpaseo/protocol/notes/types";
import { useFetchQuery } from "@/data/query";
import { hostSupportsFeature } from "@/runtime/host-features";
import {
  getHostRuntimeStore,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { toErrorMessage } from "@/utils/error-messages";

export const notesQueryBaseKey = ["notes"] as const;

const NOTES_POLL_INTERVAL_MS = 5_000;

/** A note tagged with the host that owns it; note ids are only unique per host. */
export interface HostNote extends Note {
  serverId: string;
  serverName: string;
}

export interface NoteHostError {
  serverId: string;
  serverName: string;
  message: string;
}

export type NotesLoadState =
  | { status: "loading" }
  | {
      status: "loaded";
      notes: HostNote[];
      hostErrors: NoteHostError[];
      supportedHosts: number;
      supportedServerIds: string[];
    };

interface NoteHostInput {
  serverId: string;
  serverName: string;
}

type NotesClient = Pick<DaemonClient, "listNotes">;

interface FetchNotesInput {
  hosts: readonly NoteHostInput[];
  getClient: (serverId: string) => NotesClient | null;
  isOnline: (serverId: string) => boolean;
  supportsNotes: (serverId: string) => boolean;
}

export async function fetchAggregatedNotes(input: FetchNotesInput): Promise<NotesLoadState> {
  const notes: HostNote[] = [];
  const hostErrors: NoteHostError[] = [];
  const supportedServerIds: string[] = [];
  await Promise.all(
    input.hosts.map(async (host) => {
      const client = input.getClient(host.serverId);
      if (!client || !input.isOnline(host.serverId) || !input.supportsNotes(host.serverId)) {
        return;
      }
      supportedServerIds.push(host.serverId);
      try {
        const payload = await client.listNotes();
        for (const note of payload.notes) {
          notes.push({ ...note, serverId: host.serverId, serverName: host.serverName });
        }
      } catch (error) {
        hostErrors.push({
          serverId: host.serverId,
          serverName: host.serverName,
          message: toErrorMessage(error),
        });
      }
    }),
  );
  notes.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return {
    status: "loaded",
    notes,
    hostErrors,
    supportedHosts: supportedServerIds.length,
    supportedServerIds,
  };
}

export function useNotes(options: { poll: boolean }): {
  loadState: NotesLoadState;
  refetch: () => void;
} {
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const connectionStatuses = useHostRuntimeConnectionStatuses(serverIds);
  const featureKey = useSessionStore((state) =>
    serverIds
      .map((serverId) =>
        hostSupportsFeature(state.sessions[serverId]?.serverInfo, "notes") ? 1 : 0,
      )
      .join(""),
  );
  const connectionKey = serverIds
    .map((serverId) => connectionStatuses.get(serverId) ?? "connecting")
    .join("|");

  const query = useFetchQuery({
    queryKey: [...notesQueryBaseKey, serverIds.join("|"), connectionKey, featureKey],
    queryFn: () => {
      const runtime = getHostRuntimeStore();
      return fetchAggregatedNotes({
        hosts: hosts.map((host) => ({ serverId: host.serverId, serverName: host.label })),
        getClient: (serverId) => runtime.getClient(serverId),
        isOnline: (serverId) => runtime.getSnapshot(serverId)?.connectionStatus === "online",
        supportsNotes: (serverId) =>
          hostSupportsFeature(useSessionStore.getState().sessions[serverId]?.serverInfo, "notes"),
      });
    },
    dataShape: "list",
    staleTimeMs: 2_000,
    refetchInterval: options.poll ? NOTES_POLL_INTERVAL_MS : false,
  });

  const refetch = useCallback(() => {
    void query.refetch();
  }, [query]);

  return {
    loadState: query.data ?? { status: "loading" },
    refetch,
  };
}

function requireNotesClient(serverId: string): DaemonClient {
  const client = getHostRuntimeStore().getClient(serverId);
  if (!client) {
    throw new Error("Host is offline");
  }
  return client;
}

function patchCachedNotes(
  queryClient: QueryClient,
  update: (notes: HostNote[]) => HostNote[],
): void {
  queryClient.setQueriesData<NotesLoadState>({ queryKey: notesQueryBaseKey }, (current) =>
    current?.status === "loaded" ? { ...current, notes: update(current.notes) } : current,
  );
}

function upsertCachedNote(queryClient: QueryClient, note: HostNote): void {
  patchCachedNotes(queryClient, (notes) => {
    const without = notes.filter(
      (candidate) => !(candidate.serverId === note.serverId && candidate.id === note.id),
    );
    if (note.archivedAt !== null) return without;
    return [note, ...without].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  });
}

export interface NoteActions {
  create: (serverId: string, input: Omit<CreateNoteOptions, "requestId">) => Promise<HostNote>;
  update: (
    note: Pick<HostNote, "serverId" | "serverName" | "id">,
    patch: Omit<UpdateNoteOptions, "requestId" | "noteId">,
  ) => Promise<HostNote>;
  setArchived: (note: HostNote, archived: boolean) => Promise<HostNote>;
  remove: (note: Pick<HostNote, "serverId" | "id">) => Promise<void>;
}

export function useNoteActions(): NoteActions {
  const queryClient = useQueryClient();
  const hosts = useHosts();
  const serverName = useCallback(
    (serverId: string) => hosts.find((host) => host.serverId === serverId)?.label ?? serverId,
    [hosts],
  );

  return useMemo<NoteActions>(
    () => ({
      create: async (serverId, input) => {
        const { note } = await requireNotesClient(serverId).createNote(input);
        const hostNote = { ...note, serverId, serverName: serverName(serverId) };
        upsertCachedNote(queryClient, hostNote);
        return hostNote;
      },
      update: async (target, patch) => {
        const { note } = await requireNotesClient(target.serverId).updateNote({
          ...patch,
          noteId: target.id,
        });
        const hostNote = { ...note, serverId: target.serverId, serverName: target.serverName };
        upsertCachedNote(queryClient, hostNote);
        return hostNote;
      },
      setArchived: async (target, archived) => {
        const { note } = await requireNotesClient(target.serverId).archiveNote({
          noteId: target.id,
          archived,
        });
        const hostNote = { ...note, serverId: target.serverId, serverName: target.serverName };
        upsertCachedNote(queryClient, hostNote);
        return hostNote;
      },
      remove: async (target) => {
        await requireNotesClient(target.serverId).deleteNote({ noteId: target.id });
        patchCachedNotes(queryClient, (notes) =>
          notes.filter(
            (candidate) => !(candidate.serverId === target.serverId && candidate.id === target.id),
          ),
        );
      },
    }),
    [queryClient, serverName],
  );
}

export function isNoteRevisionConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "note_revision_conflict"
  );
}
