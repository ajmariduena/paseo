import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import type { AudioOutput, OnTheGoPreference } from "./on-the-go-detector";

const ON_THE_GO_STORAGE_KEY = "voice-on-the-go";
const MAX_REMEMBERED_CARS = 10;

export const OnTheGoPersistedStateSchema = z.object({
  preference: z.enum(["auto", "always", "never"]),
  useMotion: z.boolean(),
  rememberedCars: z.array(z.object({ uid: z.string(), name: z.string() })),
});

type OnTheGoPersistedState = z.infer<typeof OnTheGoPersistedStateSchema>;

export interface RememberedCar {
  uid: string;
  name: string;
}

interface OnTheGoSettingsState extends OnTheGoPersistedState {
  setPreference: (preference: OnTheGoPreference) => void;
  setUseMotion: (useMotion: boolean) => void;
  rememberCar: (output: AudioOutput) => void;
  forgetCar: (uid: string) => void;
}

/** Device-local settings for the call's On the go mode: they follow the phone, not a host. */
export const useOnTheGoSettingsStore = create<OnTheGoSettingsState>()(
  persist(
    (set) => ({
      preference: "auto",
      useMotion: false,
      rememberedCars: [],
      setPreference: (preference) => set({ preference }),
      setUseMotion: (useMotion) => set({ useMotion }),
      rememberCar: (output) =>
        set((state) => {
          if (!output.uid || state.rememberedCars.some((car) => car.uid === output.uid)) {
            return state;
          }
          const car = { uid: output.uid, name: output.name || output.uid };
          return { rememberedCars: [car, ...state.rememberedCars].slice(0, MAX_REMEMBERED_CARS) };
        }),
      forgetCar: (uid) =>
        set((state) => ({ rememberedCars: state.rememberedCars.filter((car) => car.uid !== uid) })),
    }),
    {
      name: ON_THE_GO_STORAGE_KEY,
      version: 1,
      storage: createValidatedPersistStorage(AsyncStorage, OnTheGoPersistedStateSchema),
      partialize: (state) => ({
        preference: state.preference,
        useMotion: state.useMotion,
        rememberedCars: state.rememberedCars,
      }),
    },
  ),
);
