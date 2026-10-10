import type { AudioOutput, MotionActivity } from "./on-the-go-detector";

export type MotionAuthorization =
  | "notDetermined"
  | "restricted"
  | "denied"
  | "authorized"
  | "unavailable";

export interface CarSignalHandlers {
  onRoute: (outputs: AudioOutput[]) => void;
  onMotion: (activity: MotionActivity) => void;
  onCarMode: (carMode: boolean) => void;
}

export interface CarSignals {
  getAudioRoute: () => AudioOutput[];
  getCarMode: () => boolean;
  getMotionAuthorization: () => MotionAuthorization;
  requestMotionAuthorization: () => Promise<MotionAuthorization>;
  /** Opens the system output picker (speaker, Bluetooth, CarPlay); null where there is none. */
  showAudioRoutePicker: (() => void) | null;
  /** Starts the native observers and returns their teardown. */
  observe: (handlers: CarSignalHandlers, options: { motion: boolean }) => () => void;
}
