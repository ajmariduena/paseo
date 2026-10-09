import { isHandoffCancellationComplete } from "./persistence";
import { handoffConversationMode } from "@getpaseo/protocol/handoff-control";
import type {
  HandoffConversationModes,
  HandoffDestinationSnapshot,
  HandoffDestinationPreview,
  HandoffDestinationPage,
  HandoffSourcePreview,
  HandoffOmissionsPage,
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
  conversationModes: HandoffConversationModes;
}
type Run =
  | { status: "idle" }
  | { status: "running"; progress: WorkspaceHandoffProgress | null }
  | { status: "error"; message: string };
export interface HandoffReviewPreview extends HandoffDestinationPreview {
  workspace: NonNullable<HandoffSourcePreview["workspace"]>;
  stoppedWork: NonNullable<HandoffSourcePreview["stoppedWork"]>;
  integrationReview: NonNullable<HandoffSourcePreview["integrationReview"]>;
  conversationBytes: number;
  unsavedFiles: string[];
}
export type HandoffFormState =
  | { kind: "loading" }
  | { kind: "load_error"; message: string }
  | { kind: "editing"; draft: Draft; error: string | null }
  | { kind: "checking"; draft: Draft }
  | {
      kind: "recovering";
      draft: Draft & { destination: DestinationHost };
      page: HandoffDestinationPage;
      busy: boolean;
      error: string | null;
    }
  | {
      kind: "review";
      draft: Draft;
      record: HandoffRecord;
      preview: HandoffReviewPreview;
      omissions: {
        page: Omit<HandoffOmissionsPage, "reviewDigest">;
        run:
          | { status: "idle" }
          | { status: "loading"; offset: number }
          | { status: "error"; offset: number; message: string };
      };
    }
  | { kind: "transfer"; record: HandoffRecord; run: Run };

interface OperationOptions {
  signal: AbortSignal;
  onProgress: (progress: WorkspaceHandoffProgress) => void;
}
/** Editor saving failed before any host handoff mutation was attempted. */
export class HandoffFilesNotSavedError extends Error {}

export interface HandoffFormPorts {
  load(origin: HandoffOrigin): Promise<HandoffRecord | null>;
  save(record: HandoffRecord): Promise<void>;
  discard(origin: HandoffOrigin): Promise<void>;
  listDestination(
    origin: HandoffOrigin,
    destination: DestinationHost,
    cursor: string | null,
  ): Promise<HandoffDestinationPage>;
  recoverDestination(
    origin: HandoffOrigin,
    destination: DestinationHost,
    transferId: string,
  ): Promise<HandoffRecord>;
  newTransferId(): string;
  validate(record: HandoffRecord): Promise<HandoffReviewPreview>;
  listOmissions(record: HandoffRecord, offset: number): Promise<HandoffOmissionsPage>;
  prepare(record: HandoffRecord, options: OperationOptions): Promise<HandoffDestinationSnapshot>;
  activate(record: HandoffRecord, options: OperationOptions): Promise<HandoffDestinationSnapshot>;
  cancel(record: HandoffRecord, options: OperationOptions): Promise<HandoffDestinationSnapshot>;
}

function editingState(): HandoffFormState {
  return {
    kind: "editing",
    draft: {
      destination: null,
      destinationParent: "",
      continuationMode: "native",
      conversationModes: [],
    },
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

  function currentOmissionRequest(pageRun: { status: "loading"; offset: number }) {
    if (closed || state.kind !== "review" || state.omissions.run !== pageRun) return null;
    return state;
  }

  async function findTransfers(previous: Extract<HandoffFormState, { kind: "recovering" }>) {
    publish({ ...previous, busy: true, error: null });
    try {
      const page = await ports.listDestination(
        origin,
        previous.draft.destination,
        previous.page.nextCursor,
      );
      const transfers = new Map(
        (previous.page.nextCursor ? previous.page.transfers : []).map((transfer) => [
          transfer.transferId,
          transfer,
        ]),
      );
      for (const transfer of page.transfers) transfers.set(transfer.transferId, transfer);
      if (transfers.size === 0) publish({ kind: "editing", draft: previous.draft, error: null });
      else
        publish({
          ...previous,
          page: { ...page, transfers: [...transfers.values()] },
          busy: false,
          error: null,
        });
    } catch (error) {
      publish({ ...previous, busy: false, error: message(error) });
    }
  }

  async function run(record: HandoffRecord) {
    if (closed || (state.kind === "transfer" && state.run.status === "running")) return;
    const fromReview = state.kind === "review";
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
      if (
        record.intent === "prepare" &&
        ((!closed && error instanceof HandoffReviewChangedError) ||
          (fromReview && error instanceof HandoffFilesNotSavedError))
      ) {
        try {
          await ports.discard(origin);
          publish({
            kind: "editing",
            draft: {
              destination: { serverId: record.destinationServerId, label: record.destinationLabel },
              destinationParent: record.destinationParent,
              continuationMode: record.continuationMode,
              conversationModes: record.conversationModes ?? [],
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
    async setDestination(destination: DestinationHost) {
      if (state.kind !== "editing" || destination.serverId === origin.sourceServerId) return;
      await findTransfers({
        kind: "recovering",
        draft: { ...state.draft, destination },
        page: { transfers: [], nextCursor: null },
        busy: false,
        error: null,
      });
    },
    async moreTransfers() {
      if (state.kind !== "recovering" || state.busy || (!state.error && !state.page.nextCursor))
        return;
      await findTransfers(state);
    },
    async recoverTransfer(transferId: string) {
      if (
        state.kind !== "recovering" ||
        state.busy ||
        !state.page.transfers.some((transfer) => transfer.transferId === transferId)
      )
        return;
      const previous = state;
      publish({ ...previous, busy: true, error: null });
      try {
        const record = await ports.recoverDestination(
          origin,
          previous.draft.destination,
          transferId,
        );
        if (closed) return;
        await ports.save(record);
        publish({ kind: "transfer", record, run: { status: "idle" } });
      } catch (error) {
        publish({ ...previous, busy: false, error: message(error) });
      }
    },
    setDestinationParent(destinationParent: string) {
      if (state.kind !== "editing") return;
      publish({ ...state, draft: { ...state.draft, destinationParent } });
    },
    setContinuationMode(continuationMode: Draft["continuationMode"]) {
      if (state.kind === "review") {
        const conversationModes = state.preview.conversations.map(({ agentId }) => ({
          sourceAgentId: agentId,
          mode: continuationMode,
        }));
        publish({
          ...state,
          draft: { ...state.draft, continuationMode, conversationModes },
          record: { ...state.record, continuationMode, conversationModes },
        });
        return;
      }
      if (state.kind !== "editing") return;
      publish({ ...state, draft: { ...state.draft, continuationMode, conversationModes: [] } });
    },
    setConversationMode(sourceAgentId: string, mode: Draft["continuationMode"]) {
      if (
        state.kind !== "review" ||
        !state.preview.conversations.some((conversation) => conversation.agentId === sourceAgentId)
      )
        return;
      const record = state.record;
      const conversationModes = state.preview.conversations.map(({ agentId }) => ({
        sourceAgentId: agentId,
        mode: agentId === sourceAgentId ? mode : handoffConversationMode(record, agentId),
      }));
      publish({
        ...state,
        draft: { ...state.draft, conversationModes },
        record: { ...state.record, conversationModes },
      });
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
        const conversationModes = preview.conversations.map(({ agentId }) => ({
          sourceAgentId: agentId,
          mode:
            draft.conversationModes.find((item) => item.sourceAgentId === agentId)?.mode ??
            continuationMode,
        }));
        publish({
          kind: "review",
          draft: { ...draft, conversationModes },
          record: {
            ...record,
            conversationModes,
            reviewedAgentIds: preview.conversations.map((conversation) => conversation.agentId),
            workspaceReviewDigest: preview.workspace.reviewDigest,
            stoppedWorkReview: preview.stoppedWork.review,
            integrationReview: preview.integrationReview,
          },
          preview,
          omissions: {
            page: {
              paths: preview.workspace.omittedPaths,
              offset: 0,
              total: preview.workspace.omittedPathCount,
              nextOffset:
                preview.workspace.omittedPaths.length < preview.workspace.omittedPathCount
                  ? preview.workspace.omittedPaths.length
                  : null,
            },
            run: { status: "idle" },
          },
        });
      } catch (error) {
        publish({ kind: "editing", draft, error: message(error) });
        return;
      }
    },
    edit() {
      if (state.kind === "recovering" && !state.busy)
        publish({ kind: "editing", draft: { ...state.draft, destination: null }, error: null });
      if (state.kind === "review") publish({ kind: "editing", draft: state.draft, error: null });
    },
    async listOmissions(offset: number) {
      if (state.kind !== "review" || state.omissions.run.status === "loading") return;
      const { record } = state;
      const pageRun = { status: "loading", offset } as const;
      publish({ ...state, omissions: { ...state.omissions, run: pageRun } });
      try {
        const page = await ports.listOmissions(record, offset);
        const current = currentOmissionRequest(pageRun);
        if (!current) return;
        if (
          page.reviewDigest !== record.workspaceReviewDigest ||
          page.offset !== offset ||
          page.total !== current.preview.workspace.omittedPathCount
        )
          throw new Error("Excluded paths do not match this workspace review");
        publish({ ...current, omissions: { page, run: { status: "idle" } } });
      } catch (error) {
        const current = currentOmissionRequest(pageRun);
        if (!current) return;
        if (error instanceof HandoffReviewChangedError) {
          publish({ kind: "editing", draft: current.draft, error: message(error) });
          return;
        }
        publish({
          ...current,
          omissions: {
            ...current.omissions,
            run: { status: "error", offset, message: message(error) },
          },
        });
      }
    },
    async prepare() {
      if (state.kind !== "review" || state.omissions.run.status === "loading") return;
      const { record, preview } = state;
      if (
        !preview.conversations.every(
          (conversation) =>
            conversation[handoffConversationMode(record, conversation.agentId)].available,
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
      if (state.kind !== "transfer" || !isHandoffCancellationComplete(state.record.snapshot))
        return;
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
  if (state.kind === "recovering")
    return {
      primary: !state.busy && state.error ? "moreTransfers" : null,
      canCancel: false,
    } as const;
  if (state.kind === "checking") return { primary: null, canCancel: false } as const;
  if (state.kind === "loading") return { primary: null, canCancel: false } as const;
  if (state.kind === "load_error") return { primary: "load", canCancel: false } as const;
  if (state.kind === "editing") {
    const ready = state.draft.destination !== null && state.draft.destinationParent.trim() !== "";
    return { primary: ready ? "review" : null, canCancel: false } as const;
  }
  if (state.kind === "review") {
    const ready =
      state.omissions.run.status !== "loading" &&
      state.preview.conversations.every(
        (conversation) =>
          conversation[handoffConversationMode(state.record, conversation.agentId)].available,
      );
    return { primary: ready ? "prepare" : null, canCancel: false } as const;
  }
  return transferActions(state);
}

function transferActions(state: Extract<HandoffFormState, { kind: "transfer" }>) {
  if (state.run.status === "running") return { primary: null, canCancel: false } as const;
  const snapshot = state.record.snapshot;
  if (snapshot?.state === "active") return { primary: "open", canCancel: false } as const;
  if (isHandoffCancellationComplete(snapshot))
    return { primary: "startOver", canCancel: false } as const;
  if (snapshot?.state === "cancelled") return { primary: "retry", canCancel: false } as const;
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
