import equal from "fast-deep-equal";
import { create } from "zustand";
import type { IncomingShare } from "./model";

export interface PendingIncomingShare {
  id: number;
  share: IncomingShare;
}

interface IncomingShareState {
  pending: PendingIncomingShare | null;
  receive: (share: IncomingShare) => void;
  dismiss: () => void;
}

let nextShareId = 1;

export const useIncomingShareStore = create<IncomingShareState>((set) => ({
  pending: null,
  // iOS can deliver the same share twice: once from the reopen URL and once
  // from the app becoming active, before the first read clears the key.
  receive: (share) =>
    set((state) =>
      equal(state.pending?.share, share) ? state : { pending: { id: nextShareId++, share } },
    ),
  dismiss: () => set({ pending: null }),
}));
