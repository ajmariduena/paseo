import type { HandoffMutationScope, HandoffOwnership } from "./handoff/ownership.js";

export async function acquireWorkspaceSetupMutation(
  ownership: HandoffOwnership | undefined,
  scope: HandoffMutationScope & { repoRoot?: string },
): Promise<() => void> {
  if (!ownership) return () => {};
  const release = await ownership.acquireMutation({
    cwd: scope.cwd,
    workspaceId: scope.workspaceId,
    agentId: scope.agentId,
  });
  try {
    // Setup receives the source checkout path and can update shared Git metadata.
    const releaseRepo = scope.repoRoot
      ? await ownership.acquireMutation({ cwd: scope.repoRoot })
      : () => {};
    return () => {
      releaseRepo();
      release();
    };
  } catch (error) {
    release();
    throw error;
  }
}

export type WorkspaceSetupOperation = (signal: AbortSignal) => Promise<void>;

interface WorkspaceSetupRun {
  controller: AbortController;
  completion: Promise<void>;
}

export class WorkspaceSetupRuntime {
  private readonly runs = new Map<string, Set<WorkspaceSetupRun>>();

  countActive(workspaceId: string): number {
    return this.runs.get(workspaceId)?.size ?? 0;
  }

  start(workspaceId: string, operation: WorkspaceSetupOperation): void {
    const controller = new AbortController();
    const run: WorkspaceSetupRun = {
      controller,
      completion: Promise.resolve(),
    };
    const runs = this.runs.get(workspaceId) ?? new Set<WorkspaceSetupRun>();
    runs.add(run);
    this.runs.set(workspaceId, runs);
    run.completion = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      })
      .catch(() => undefined)
      .finally(() => {
        runs.delete(run);
        if (runs.size === 0) {
          this.runs.delete(workspaceId);
        }
      });
  }

  async stop(workspaceId: string): Promise<void> {
    const runs = this.runs.get(workspaceId);
    if (!runs) {
      return;
    }
    const stopping = Array.from(runs);
    for (const run of stopping) run.controller.abort();
    await Promise.all(stopping.map((run) => run.completion));
  }
}
