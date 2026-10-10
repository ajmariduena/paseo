import { requireOptionalNativeModule, type EventSubscription } from "expo-modules-core";
import type { AudioOutput, MotionActivity } from "./on-the-go-detector";
import type { CarSignals, MotionAuthorization } from "./car-signals-types";

interface NativeMotionActivity extends Omit<MotionActivity, "startedAt"> {
  startedAt: number | null;
}

interface PaseoCarContextModule {
  getAudioRoute(): { outputs: AudioOutput[] };
  getCarMode(): boolean;
  getMotionAuthorization(): MotionAuthorization;
  requestMotionAuthorization(): Promise<MotionAuthorization>;
  startObserving(motion: boolean): Promise<void>;
  stopObserving(): void;
  addListener(
    eventName: "onAudioRouteChanged",
    handler: (event: { outputs: AudioOutput[] }) => void,
  ): EventSubscription;
  addListener(
    eventName: "onMotionActivity",
    handler: (event: NativeMotionActivity) => void,
  ): EventSubscription;
  addListener(
    eventName: "onCarModeChanged",
    handler: (event: { carMode: boolean }) => void,
  ): EventSubscription;
}

// Optional because an OTA JS update can land on a binary built before the module existed;
// On the go then still works manually and with the Always preference.
const carModule = requireOptionalNativeModule<PaseoCarContextModule>("PaseoCarContext");

function toMotionActivity(event: NativeMotionActivity): MotionActivity {
  const { startedAt, ...activity } = event;
  return startedAt === null ? activity : { ...activity, startedAt };
}

export function getCarSignals(): CarSignals | null {
  const native = carModule;
  if (!native) return null;
  return {
    getAudioRoute: () => native.getAudioRoute().outputs,
    getCarMode: () => native.getCarMode(),
    getMotionAuthorization: () => native.getMotionAuthorization(),
    requestMotionAuthorization: () => native.requestMotionAuthorization(),
    observe: (handlers, options) => {
      const subscriptions = [
        native.addListener("onAudioRouteChanged", (event) => handlers.onRoute(event.outputs)),
        native.addListener("onMotionActivity", (event) =>
          handlers.onMotion(toMotionActivity(event)),
        ),
        native.addListener("onCarModeChanged", (event) => handlers.onCarMode(event.carMode)),
      ];
      native.startObserving(options.motion).catch((error: unknown) => {
        console.warn("[OnTheGo] Could not observe car signals", error);
      });
      return () => {
        for (const subscription of subscriptions) subscription.remove();
        native.stopObserving();
      };
    },
  };
}
