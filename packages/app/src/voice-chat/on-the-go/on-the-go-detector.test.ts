import { describe, expect, it } from "vitest";
import {
  OnTheGoDetector,
  type AudioOutput,
  type MotionActivity,
  type OnTheGoContext,
} from "./on-the-go-detector";

const CARPLAY: AudioOutput = { portType: "carAudio", uid: "carplay-1", name: "CarPlay" };
const CAR_BT: AudioOutput = { portType: "bluetoothHFP", uid: "car-bt", name: "My Car" };
const AIRPODS: AudioOutput = { portType: "bluetoothHFP", uid: "airpods", name: "AirPods" };
const SPEAKER: AudioOutput = { portType: "builtInSpeaker", uid: "speaker", name: "Speaker" };

function context(patch: Partial<OnTheGoContext> = {}): OnTheGoContext {
  return { preference: "auto", override: null, rememberedCarUids: new Set(), ...patch };
}

function motion(patch: Partial<MotionActivity>): MotionActivity {
  return { automotive: false, stationary: false, walking: false, confidence: "high", ...patch };
}

describe("OnTheGoDetector", () => {
  it("enters at once on CarPlay", () => {
    const detector = new OnTheGoDetector();
    detector.setRoute([CARPLAY]);
    expect(detector.resolve(context(), 0)).toMatchObject({ active: true, reason: "carplay" });
  });

  it("enters at once on a remembered car's Bluetooth", () => {
    const detector = new OnTheGoDetector();
    detector.setRoute([CAR_BT]);
    const decision = detector.resolve(context({ rememberedCarUids: new Set(["car-bt"]) }), 0);
    expect(decision).toEqual({ active: true, reason: "car-bluetooth", learnedCar: null });
  });

  it("ignores unknown Bluetooth without driving, so headphones on the sofa stay out", () => {
    const detector = new OnTheGoDetector();
    detector.setRoute([AIRPODS]);
    expect(detector.resolve(context(), 0).active).toBe(false);
  });

  it("learns an unknown Bluetooth device as a car while driving", () => {
    const detector = new OnTheGoDetector();
    detector.setRoute([CAR_BT]);
    detector.setMotion(motion({ automotive: true, confidence: "medium" }), 0);
    expect(detector.resolve(context(), 0)).toEqual({
      active: true,
      reason: "car-bluetooth",
      learnedCar: CAR_BT,
    });
  });

  it("enters on the system car mode", () => {
    const detector = new OnTheGoDetector();
    detector.setCarMode(true);
    expect(detector.resolve(context(), 0)).toMatchObject({ active: true, reason: "car-mode" });
  });

  it("enters on high-confidence driving only after it lasts", () => {
    const detector = new OnTheGoDetector();
    detector.setRoute([SPEAKER]);
    detector.setMotion(motion({ automotive: true }), 0);
    expect(detector.resolve(context(), 14_999).active).toBe(false);
    expect(detector.resolve(context(), 15_000)).toMatchObject({ active: true, reason: "motion" });
  });

  it("counts a drive already under way from the activity's start", () => {
    const detector = new OnTheGoDetector();
    detector.setMotion(motion({ automotive: true, startedAt: 0 }), 60_000);
    expect(detector.resolve(context(), 60_000).reason).toBe("motion");
  });

  it("never enters on medium-confidence driving alone", () => {
    const detector = new OnTheGoDetector();
    detector.setMotion(motion({ automotive: true, confidence: "medium" }), 0);
    expect(detector.resolve(context(), 60_000).active).toBe(false);
  });

  it("stays on at a traffic light", () => {
    const detector = new OnTheGoDetector();
    detector.setMotion(motion({ automotive: true }), 0);
    detector.resolve(context(), 15_000);
    detector.setMotion(motion({ automotive: true, stationary: true }), 20_000);
    expect(detector.resolve(context(), 200_000).active).toBe(true);
  });

  it("leaves motion mode after 90 s without driving", () => {
    const detector = new OnTheGoDetector();
    detector.setMotion(motion({ automotive: true }), 0);
    detector.resolve(context(), 15_000);
    detector.setMotion(motion({ stationary: true }), 20_000);
    expect(detector.resolve(context(), 109_999).active).toBe(true);
    expect(detector.resolve(context(), 110_000).active).toBe(false);
  });

  it("leaves motion mode after 10 s of walking", () => {
    const detector = new OnTheGoDetector();
    detector.setMotion(motion({ automotive: true }), 0);
    detector.resolve(context(), 15_000);
    detector.setMotion(motion({ walking: true, confidence: "medium" }), 20_000);
    expect(detector.resolve(context(), 29_999).active).toBe(true);
    expect(detector.resolve(context(), 30_000).active).toBe(false);
  });

  it("keeps a lost car route for 10 s before leaving", () => {
    const detector = new OnTheGoDetector();
    detector.setRoute([CARPLAY]);
    detector.resolve(context(), 0);
    detector.setRoute([SPEAKER]);
    expect(detector.resolve(context(), 1_000)).toMatchObject({ active: true, reason: "carplay" });
    expect(detector.resolve(context(), 10_999).active).toBe(true);
    expect(detector.resolve(context(), 11_000).active).toBe(false);
  });

  it("restarts the grace when the car route comes back", () => {
    const detector = new OnTheGoDetector();
    detector.setRoute([CARPLAY]);
    detector.resolve(context(), 0);
    detector.setRoute([]);
    detector.resolve(context(), 1_000);
    detector.setRoute([CARPLAY]);
    detector.resolve(context(), 5_000);
    detector.setRoute([]);
    detector.resolve(context(), 6_000);
    expect(detector.resolve(context(), 15_999).active).toBe(true);
  });

  it("lets the call's off override win over every signal", () => {
    const detector = new OnTheGoDetector();
    detector.setRoute([CARPLAY]);
    expect(detector.resolve(context({ override: "off" }), 0).active).toBe(false);
  });

  it("turns on manually without any signal", () => {
    const detector = new OnTheGoDetector();
    expect(detector.resolve(context({ override: "on" }), 0)).toMatchObject({ reason: "manual" });
  });

  it("is off with the never preference and on with always", () => {
    const detector = new OnTheGoDetector();
    detector.setRoute([CARPLAY]);
    expect(detector.resolve(context({ preference: "never" }), 0).active).toBe(false);
    detector.setRoute([]);
    expect(detector.resolve(context({ preference: "always" }), 0)).toMatchObject({
      reason: "always",
    });
  });

  it("reports the routed Bluetooth output for manual learning", () => {
    const detector = new OnTheGoDetector();
    detector.setRoute([SPEAKER, CAR_BT]);
    expect(detector.bluetoothOutput()).toEqual(CAR_BT);
  });
});
