import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

const MAX_AGENTS = 200;
const MAX_FOLDS_PER_AGENT = 200;

const PersistedTurnFoldsSchema = z.object({
  expandedByAgent: z.record(z.string(), z.array(z.string())),
});

type PersistedTurnFolds = z.infer<typeof PersistedTurnFoldsSchema>;

interface TurnFoldStoreState extends PersistedTurnFolds {
  setExpanded: (agentKey: string, foldKey: string, expanded: boolean) => void;
}

export function buildTurnFoldAgentKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

/** The most recently touched agents and folds are kept; older entries fall off. */
export function setTurnFoldExpanded(
  state: PersistedTurnFolds,
  agentKey: string,
  foldKey: string,
  expanded: boolean,
): PersistedTurnFolds {
  const current = state.expandedByAgent[agentKey] ?? [];
  if (current.includes(foldKey) === expanded) {
    return state;
  }
  const withoutFold = current.filter((key) => key !== foldKey);
  const next = expanded ? [...withoutFold, foldKey].slice(-MAX_FOLDS_PER_AGENT) : withoutFold;
  const { [agentKey]: _previous, ...others } = state.expandedByAgent;
  const agents = Object.entries(others);
  if (next.length > 0) {
    agents.push([agentKey, next]);
  }
  return { expandedByAgent: Object.fromEntries(agents.slice(-MAX_AGENTS)) };
}

export const useTurnFoldStore = create<TurnFoldStoreState>()(
  persist<TurnFoldStoreState, [], [], PersistedTurnFolds>(
    (set) => ({
      expandedByAgent: {},
      setExpanded: (agentKey, foldKey, expanded) =>
        set((state) => setTurnFoldExpanded(state, agentKey, foldKey, expanded)),
    }),
    {
      name: "agent-stream-turn-folds",
      storage: createValidatedPersistStorage(AsyncStorage, PersistedTurnFoldsSchema),
      partialize: (state) => ({ expandedByAgent: state.expandedByAgent }),
    },
  ),
);
