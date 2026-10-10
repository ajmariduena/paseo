import { useEffect } from "react";
import { logVoiceCallEvent } from "@/voice-chat/call-event-log";
import { useGlobalVoiceStore } from "@/voice-chat/global-voice-store";
import { getCarSignals } from "./car-signals";
import { isBluetoothOutput, OnTheGoDetector } from "./on-the-go-detector";
import { useOnTheGoSettingsStore } from "./on-the-go-store";

const TICK_MS = 1_000;

/** Switches the call to On the go by hand, remembering a routed Bluetooth device as a car. */
export function enterOnTheGo(): void {
  const bluetooth = getCarSignals()?.getAudioRoute().find(isBluetoothOutput);
  if (bluetooth) useOnTheGoSettingsStore.getState().rememberCar(bluetooth);
  useGlobalVoiceStore.getState().setOnTheGo({ onTheGoOverride: "on" });
}

/** Leaves On the go for the rest of this call, whatever the car signals say. */
export function exitOnTheGo(): void {
  useGlobalVoiceStore.getState().setOnTheGo({ onTheGoOverride: "off" });
}

/**
 * Runs the car detector for as long as a call is up and mirrors its decision into the call
 * store. Nothing runs between calls.
 */
export function useOnTheGo(inCall: boolean): void {
  useEffect(() => {
    if (!inCall) return;
    const signals = getCarSignals();
    const detector = new OnTheGoDetector();

    const evaluate = () => {
      const settings = useOnTheGoSettingsStore.getState();
      const store = useGlobalVoiceStore.getState();
      const decision = detector.resolve(
        {
          preference: settings.preference,
          override: store.onTheGoOverride,
          rememberedCarUids: new Set(settings.rememberedCars.map((car) => car.uid)),
        },
        Date.now(),
      );
      if (decision.learnedCar) settings.rememberCar(decision.learnedCar);
      if (decision.active === store.onTheGo && decision.reason === store.onTheGoReason) return;
      if (decision.active !== store.onTheGo) {
        logVoiceCallEvent("on_the_go", { active: decision.active, reason: decision.reason });
      }
      // Hands-free there is no pill to tap, so a minimized call comes back full screen.
      if (decision.active && !store.onTheGo) store.setMinimized(false);
      store.setOnTheGo({ onTheGo: decision.active, onTheGoReason: decision.reason });
    };

    let stopObserving: (() => void) | null = null;
    if (signals) {
      detector.setRoute(signals.getAudioRoute());
      detector.setCarMode(signals.getCarMode());
      const settings = useOnTheGoSettingsStore.getState();
      const motion =
        settings.preference === "auto" &&
        settings.useMotion &&
        signals.getMotionAuthorization() === "authorized";
      stopObserving = signals.observe(
        {
          onRoute: (outputs) => {
            detector.setRoute(outputs);
            evaluate();
          },
          onMotion: (activity) => {
            detector.setMotion(activity, Date.now());
            evaluate();
          },
          onCarMode: (carMode) => {
            detector.setCarMode(carMode);
            evaluate();
          },
        },
        { motion },
      );
    }

    evaluate();
    const timer = setInterval(evaluate, TICK_MS);
    const unsubscribeCall = useGlobalVoiceStore.subscribe((state, previous) => {
      if (state.onTheGoOverride !== previous.onTheGoOverride) evaluate();
    });
    const unsubscribeSettings = useOnTheGoSettingsStore.subscribe(evaluate);

    return () => {
      clearInterval(timer);
      unsubscribeCall();
      unsubscribeSettings();
      stopObserving?.();
      useGlobalVoiceStore
        .getState()
        .setOnTheGo({ onTheGo: false, onTheGoReason: null, onTheGoOverride: null });
    };
  }, [inCall]);
}
