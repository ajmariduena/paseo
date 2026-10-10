import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { z } from "zod";

const STORAGE_KEY = "pending-workspace-creations-v1";
const PendingCreationSchema = z.object({
  serverId: z.string().min(1),
  workspaceId: z.string().regex(/^wks_[a-f0-9]{16}$/),
  agentId: z.uuid(),
  draftId: z.string().min(1),
  clientMessageId: z.string().min(1),
  projectViewKey: z.string().min(1),
  projectId: z.string().min(1),
  projectName: z.string(),
  projectKind: z.enum(["git", "non_git", "directory", "unknown"]),
  sourceDirectory: z.string(),
  prompt: z.string(),
  createdAt: z.number(),
  phase: z.enum(["preparing", "accepted", "workspace_ready", "failed"]),
  revision: z.number().int().nonnegative(),
  error: z.string().nullable(),
  outcomeUnknown: z.boolean(),
  agentSetup: z
    .object({
      provider: z.string().min(1),
      cwd: z.string(),
      modeId: z.string().nullable(),
      model: z.string().nullable(),
      thinkingOptionId: z.string().nullable(),
      featureValues: z.record(z.string(), z.unknown()),
    })
    .optional(),
});

export type PendingWorkspaceCreation = z.infer<typeof PendingCreationSchema>;

interface PendingCreationState {
  byKey: Record<string, PendingWorkspaceCreation>;
  // A restored intent has no in-memory draft handoff; the reconciler must prepare it again.
  presentationReadyByKey: Record<string, true>;
  hydrated: boolean;
  add: (creation: PendingWorkspaceCreation) => Promise<void>;
  update: (key: string, change: Partial<PendingWorkspaceCreation>) => void;
  markPresentationReady: (key: string) => void;
  remove: (key: string) => void;
}

export function pendingWorkspaceCreationKey(serverId: string, workspaceId: string): string {
  return `${serverId}:${workspaceId}`;
}

let hydration: Promise<void> | null = null;
let pendingWrite = Promise.resolve();
const localCreations = new Set<string>();

export function setLocalPendingWorkspaceCreation(key: string, active: boolean): void {
  if (active) localCreations.add(key);
  else localCreations.delete(key);
}

export function isLocalPendingWorkspaceCreation(key: string): boolean {
  return localCreations.has(key);
}

function persistCreations(): Promise<void> {
  pendingWrite = pendingWrite
    .catch(() => undefined)
    .then(() => {
      const byKey = usePendingWorkspaceCreationStore.getState().byKey;
      return AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(byKey));
    });
  return pendingWrite;
}

export const usePendingWorkspaceCreationStore = create<PendingCreationState>((set) => ({
  byKey: {},
  presentationReadyByKey: {},
  hydrated: false,
  add: async (creation) => {
    const key = pendingWorkspaceCreationKey(creation.serverId, creation.workspaceId);
    set((state) => ({ byKey: { ...state.byKey, [key]: creation } }));
    await hydratePendingWorkspaceCreations();
    await persistCreations();
  },
  update: (key, change) => {
    set((state) => {
      const current = state.byKey[key];
      if (!current || (change.revision !== undefined && change.revision < current.revision)) {
        return state;
      }
      return { byKey: { ...state.byKey, [key]: { ...current, ...change } } };
    });
    void persistCreations().catch((error) => {
      console.error("[PendingWorkspaceCreation] Failed to persist phase", error);
    });
  },
  markPresentationReady: (key) =>
    set((state) => ({
      presentationReadyByKey: { ...state.presentationReadyByKey, [key]: true },
    })),
  remove: (key) => {
    set((state) => {
      if (!state.byKey[key]) return state;
      const byKey = { ...state.byKey };
      delete byKey[key];
      const presentationReadyByKey = { ...state.presentationReadyByKey };
      delete presentationReadyByKey[key];
      return { byKey, presentationReadyByKey };
    });
    void persistCreations().catch((error) => {
      console.error("[PendingWorkspaceCreation] Failed to remove saved creation", error);
    });
  },
}));

export function hydratePendingWorkspaceCreations(): Promise<void> {
  if (hydration) return hydration;
  hydration = AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      if (!raw) return undefined;
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch {
        return undefined;
      }
      const parsed = z.record(z.string(), PendingCreationSchema).safeParse(decoded);
      if (!parsed.success) return undefined;
      usePendingWorkspaceCreationStore.setState((state) => ({
        byKey: { ...parsed.data, ...state.byKey },
      }));
      return undefined;
    })
    .finally(() => usePendingWorkspaceCreationStore.setState({ hydrated: true }));
  return hydration;
}

void hydratePendingWorkspaceCreations().catch(() => undefined);
