import { fileEditorDraftStorage } from "./drafts";
import { FileEditorSaveError, type FileEditorModel } from "./model";

interface WorkspaceIdentity {
  serverId: string;
  workspaceId: string;
}
type SaveBarrier = ReturnType<FileEditorModel["acquireSaveBarrier"]>;
interface WorkspaceEditors {
  models: Map<FileEditorModel, number>;
  barriers: Map<FileEditorModel, SaveBarrier> | null;
}

export function createFileEditorRegistry(
  input: {
    listDraftPaths?: (workspace: WorkspaceIdentity) => Promise<string[]>;
  } = {},
) {
  const workspaces = new Map<string, WorkspaceEditors>();
  const key = (workspace: WorkspaceIdentity) =>
    JSON.stringify([workspace.serverId, workspace.workspaceId]);

  function getWorkspace(workspace: WorkspaceIdentity) {
    const id = key(workspace);
    let entry = workspaces.get(id);
    if (!entry) {
      entry = { models: new Map(), barriers: null };
      workspaces.set(id, entry);
    }
    return entry;
  }

  function prune(workspace: WorkspaceIdentity, entry: WorkspaceEditors) {
    if (entry.models.size === 0 && !entry.barriers) workspaces.delete(key(workspace));
  }

  return {
    register(workspace: WorkspaceIdentity, model: FileEditorModel) {
      const entry = getWorkspace(workspace);
      entry.models.set(model, (entry.models.get(model) ?? 0) + 1);
      // A file pane mounted during preparation must stay read-only too.
      if (entry.barriers && !entry.barriers.has(model)) {
        entry.barriers.set(model, model.acquireSaveBarrier());
      }
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        const count = entry.models.get(model) ?? 0;
        if (count <= 1) entry.models.delete(model);
        else entry.models.set(model, count - 1);
        prune(workspace, entry);
      };
    },
    unsavedPaths(workspace: WorkspaceIdentity): string[] {
      const entry = workspaces.get(key(workspace));
      return [
        ...new Set(
          [...(entry?.models.keys() ?? [])]
            .filter((model) => model.getSnapshot().modified)
            .map((model) => model.getSnapshot().version.path),
        ),
      ].sort();
    },
    async withSavedEditors<T>(
      workspace: WorkspaceIdentity,
      signal: AbortSignal,
      prepare: () => Promise<T>,
    ): Promise<T> {
      const entry = getWorkspace(workspace);
      if (entry.barriers) throw new Error("Workspace files are already being prepared");
      const barriers = new Map<FileEditorModel, SaveBarrier>();
      entry.barriers = barriers;
      try {
        signal.throwIfAborted();
        for (const model of entry.models.keys()) barriers.set(model, model.acquireSaveBarrier());
        const flushed = new Set<SaveBarrier>();
        let draftPaths: string[] = [];
        do {
          // Include editors mounted while saving or checking persisted recovery copies.
          for (const barrier of barriers.values()) {
            if (flushed.has(barrier)) continue;
            await barrier.flush(signal);
            flushed.add(barrier);
          }
          draftPaths = (await input.listDraftPaths?.(workspace)) ?? [];
        } while (flushed.size < barriers.size);
        signal.throwIfAborted();
        if (draftPaths.length) throw new FileEditorSaveError(draftPaths.join(", "), null);
        return await prepare();
      } finally {
        entry.barriers = null;
        for (const barrier of barriers.values()) barrier.release();
        prune(workspace, entry);
      }
    },
  };
}

export const workspaceFileEditors = createFileEditorRegistry({
  listDraftPaths: async (workspace) => {
    return (await fileEditorDraftStorage.listWorkspace(workspace)).map(
      ({ identity }) => identity.path,
    );
  },
});
