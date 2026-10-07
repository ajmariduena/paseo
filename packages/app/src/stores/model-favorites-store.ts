import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

const MAX_FAVORITES = 100;

const PersistedModelFavoritesSchema = z.object({
  keys: z.array(z.string()),
});

type PersistedModelFavorites = z.infer<typeof PersistedModelFavoritesSchema>;

interface ModelFavoritesStoreState extends PersistedModelFavorites {
  toggle: (key: string) => void;
}

/** Favorites are per device and keyed `provider:modelId`, the model row's identity. */
export function toggleModelFavorite(keys: readonly string[], key: string): string[] {
  if (keys.includes(key)) return keys.filter((entry) => entry !== key);
  return [...keys, key].slice(-MAX_FAVORITES);
}

export const useModelFavoritesStore = create<ModelFavoritesStoreState>()(
  persist<ModelFavoritesStoreState, [], [], PersistedModelFavorites>(
    (set) => ({
      keys: [],
      toggle: (key) => set((state) => ({ keys: toggleModelFavorite(state.keys, key) })),
    }),
    {
      name: "model-picker-favorites",
      storage: createValidatedPersistStorage(AsyncStorage, PersistedModelFavoritesSchema),
      partialize: (state) => ({ keys: state.keys }),
    },
  ),
);
