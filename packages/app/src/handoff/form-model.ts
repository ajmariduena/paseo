import type {
  HandoffDestinationSnapshot,
  HandoffDestinationPreview,
} from "@getpaseo/protocol/handoff-control";
import type { WorkspaceHandoffProgress } from "@getpaseo/client/internal/workspace-handoff";
import { HandoffReviewChangedError } from "@getpaseo/client/internal/workspace-handoff";
import type { HandoffOrigin, HandoffRecord } from "./persistence";

interface DestinationHost {
  serverId: string;
  label: string;
}
interface Draft {
  destination: DestinationHost | null;
  destinationParent: string;
  continuationMode: "native" | "context";
}
type Run =
  | { status: "idle" }
  | { status: "running"; progress: WorkspaceHandoffProgress | null }
  | { status: "error"; message: string };
export type HandoffFormState =
  | { kind: "loading" }
  | { kind: "load_error"; message: string }
  | { kind: "editing"; draft: Draft; error: string | null }
  | { kind: "checking"; draft: Draft }
  | { kind: "review"; draft: Draft; record: HandoffRecord; preview: HandoffDestinationPreview }
  | { kind: "transfer"; record: HandoffRecord; run: Run };

interface OperationOptions {
  signal: AbortSignal;
  onProgress: (progress: WorkspaceHandoffProgress) => void;
}
export interface HandoffFormPorts {
  load(origin: HandoffOrigin): Promise<HandoffRecord | null>;
  save(record: HandoffRecord): Promise<void>;
  discard(origin: HandoffOrigin): Promise<void>;
  newTransferId(): string;
  validate(record: HandoffRecord): Promise<HandoffDestinationPreview>;
  prepare(record: HandoffRecord, options: OperationOptions): Promise<HandoffDestinationSnapshot>;
  activate(record: HandoffRecord, options: OperationOptions): Promise<HandoffDestinationSnapshot>;
  cancel(record: HandoffRecord, options: OperationOptions): Promise<HandoffDestinationSnapshot>;
}

function editingState(): HandoffFormState {
  return {
    kind: "editing",
    draft: { destination: null, destinationParent: "", continuationMode: "native" },
    error: null,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function openHandoffForm(origin: HandoffOrigin, ports: HandoffFormPorts) {
  let state: HandoffFormState = { kind: "loading" };
  let closed = false;
  let loading = false;
  const abort = new AbortController();
  const listeners = new Set<() => void>();

  function publish(next: HandoffFormState) {
    if (closed) return;
    state = next;
    for (const listener of listeners) listener();
  }

  async function run(record: HandoffRecord) {
    if (closed || (state.kind === "transfer" && state.run.status === "running")) return;
    publish({ kind: "transfer", record, run: { status: "running", progress: null } });
    try {
      // Persist intent before any RPC: a lost release reply must reopen as forward recovery.
      await ports.save(record);
      if (closed) return;
      const snapshot = await ports[record.intent](record, {
        signal: abort.signal,
        onProgress: (progress) =>
          publish({
            kind: "transfer",
            record,
            run: { status: "running", progress },
          }),
      });
      if (closed) return;
      const completed = { ...record, snapshot };
      await ports.save(completed);
      publish({ kind: "transfer", record: completed, run: { status: "idle" } });
    } catch (error) {
      if (!closed && record.intent === "prepare" && error instanceof HandoffReviewChangedError) {
        try {
          await ports.discard(origin);
          publish({
            kind: "editing",
            draft: {
              destination: { serverId: record.destinationServerId, label: record.destinationLabel },
              destinationParent: record.destinationParent,
              continuationMode: record.continuationMode,
            },
            error: message(error),
          });
          return;
        } catch (discardError) {
          publish({
            kind: "transfer",
            record,
            run: { status: "error", message: message(discardError) },
          });
          return;
        }
      }
      publish({ kind: "transfer", record, run: { status: "error", message: message(error) } });
    }
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async load() {
      if (closed || loading || (state.kind !== "loading" && state.kind !== "load_error")) return;
      loading = true;
      publish({ kind: "loading" });
      try {
        const record = await ports.load(origin);
        publish(record ? { kind: "transfer", record, run: { status: "idle" } } : editingState());
      } catch (error) {
        publish({ kind: "load_error", message: message(error) });
      } finally {
        loading = false;
      }
    },
    setDestination(destination: DestinationHost) {
      if (state.kind !== "editing" || destination.serverId === origin.sourceServerId) return;
      publish({ ...state, draft: { ...state.draft, destination } });
    },
    setDestinationParent(destinationParent: string) {
      if (state.kind !== "editing") return;
      publish({ ...state, draft: { ...state.draft, destinationParent } });
    },
    setContinuationMode(continuationMode: Draft["continuationMode"]) {
      if (state.kind === "review") {
        publish({
          ...state,
          draft: { ...state.draft, continuationMode },
          record: { ...state.record, continuationMode },
        });
        return;
      }
      if (state.kind !== "editing") return;
      publish({ ...state, draft: { ...state.draft, continuationMode } });
    },
    async review() {
      if (state.kind !== "editing") return;
      const draft = state.draft;
      const { destination, continuationMode } = state.draft;
      const destinationParent = state.draft.destinationParent.trim();
      if (!destination || !destinationParent) return;
      const record: HandoffRecord = {
        version: 1,
        ...origin,
        transferId: ports.newTransferId(),
        destinationServerId: destination.serverId,
        destinationLabel: destination.label,
        destinationParent,
        continuationMode,
        intent: "prepare",
        snapshot: null,
      };
      publish({ kind: "checking", draft });
      try {
        const preview = await ports.validate(record);
        publish({
          kind: "review",
          draft,
          record: {
            ...record,
            reviewedAgentIds: preview.conversations.map((conversation) => conversation.agentId),
          },
          preview,
        });
      } catch (error) {
        publish({ kind: "editing", draft, error: message(error) });
        return;
      }
    },
    edit() {
      if (state.kind === "review") publish({ kind: "editing", draft: state.draft, error: null });
    },
    async prepare() {
      if (state.kind !== "review") return;
      const { record, preview } = state;
      if (
        !preview.conversations.every(
          (conversation) => conversation[record.continuationMode].available,
        )
      )
        return;
      await run(record);
    },
    async retry() {
      if (state.kind !== "transfer") return;
      await run(state.record);
    },
    async activate() {
      if (state.kind !== "transfer" || state.record.intent === "cancel") return;
      const snapshot = state.record.snapshot;
      if (!snapshot || !["staged", "released", "activating"].includes(snapshot.state)) return;
      await run({ ...state.record, intent: "activate" });
    },
    async cancel() {
      if (state.kind !== "transfer" || state.record.intent === "activate") return;
      const snapshot = state.record.snapshot;
      if (snapshot && ["released", "activating", "active", "cancelled"].includes(snapshot.state))
        return;
      await run({ ...state.record, intent: "cancel" });
    },
    startOver() {
      if (state.kind !== "transfer" || state.record.snapshot?.state !== "cancelled") return;
      publish(editingState());
    },
    close() {
      closed = true;
      abort.abort();
      listeners.clear();
    },
  };
}
export type HandoffFormModel = ReturnType<typeof openHandoffForm>;

export function handoffFormActions(state: HandoffFormState) {
  if (state.kind === "checking") return { primary: null, canCancel: false } as const;
  if (state.kind === "loading") return { primary: null, canCancel: false } as const;
  if (state.kind === "load_error") return { primary: "load", canCancel: false } as const;
  if (state.kind === "editing") {
    const ready = state.draft.destination !== null && state.draft.destinationParent.trim() !== "";
    return { primary: ready ? "review" : null, canCancel: false } as const;
  }
  if (state.kind === "review") {
    const ready = state.preview.conversations.every(
      (conversation) => conversation[state.record.continuationMode].available,
    );
    return { primary: ready ? "prepare" : null, canCancel: false } as const;
  }
  return transferActions(state);
}

function transferActions(state: Extract<HandoffFormState, { kind: "transfer" }>) {
  if (state.run.status === "running") return { primary: null, canCancel: false } as const;
  const snapshot = state.record.snapshot;
  if (snapshot?.state === "active") return { primary: "open", canCancel: false } as const;
  if (snapshot?.state === "cancelled") return { primary: "startOver", canCancel: false } as const;
  const committed =
    state.record.intent === "activate" ||
    snapshot?.state === "released" ||
    snapshot?.state === "activating";
  const canCancel = !committed && state.record.intent !== "cancel";
  if (state.run.status === "error") return { primary: "retry", canCancel } as const;
  const canActivate = snapshot && ["staged", "released", "activating"].includes(snapshot.state);
  if (canActivate && state.record.intent === "prepare") {
    return { primary: "activate", canCancel } as const;
  }
  return { primary: "retry", canCancel } as const;
}
