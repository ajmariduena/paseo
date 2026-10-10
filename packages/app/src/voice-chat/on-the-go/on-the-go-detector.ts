export type OnTheGoPreference = "auto" | "always" | "never";
export type OnTheGoOverride = "on" | "off" | null;
export type OnTheGoReason =
  | "carplay"
  | "car-bluetooth"
  | "car-mode"
  | "motion"
  | "manual"
  | "always";

export type MotionConfidence = "low" | "medium" | "high";

/** Port types are normalized by the native module to the iOS names on both platforms. */
export interface AudioOutput {
  portType: string;
  uid: string;
  name: string;
}

export interface MotionActivity {
  automotive: boolean;
  stationary: boolean;
  walking: boolean;
  confidence: MotionConfidence;
  /** When the platform says this activity began; lets a drive already under way count at once. */
  startedAt?: number;
}

export interface OnTheGoContext {
  preference: OnTheGoPreference;
  override: OnTheGoOverride;
  rememberedCarUids: ReadonlySet<string>;
}

export interface OnTheGoDecision {
  active: boolean;
  reason: OnTheGoReason | null;
  /** A Bluetooth output that just proved to be a car; the caller remembers it. */
  learnedCar: AudioOutput | null;
}

export interface OnTheGoDetectorOptions {
  /** Grace after a car route disappears, covering Bluetooth reconnects and CarPlay re-plugs. */
  routeExitMs: number;
  /** Motion alone enters only after high-confidence driving lasts this long. */
  motionEnterMs: number;
  /** Motion-entered mode ends after this long without automotive activity. */
  motionExitMs: number;
  /** Walking this long ends motion-entered mode early: the user got out. */
  walkingExitMs: number;
}

export const DEFAULT_ON_THE_GO_OPTIONS: OnTheGoDetectorOptions = {
  routeExitMs: 10_000,
  motionEnterMs: 15_000,
  motionExitMs: 90_000,
  walkingExitMs: 10_000,
};

const BLUETOOTH_PORT_TYPES = new Set(["bluetoothHFP", "bluetoothA2DP", "bluetoothLE"]);
export function isBluetoothOutput(output: AudioOutput): boolean {
  return BLUETOOTH_PORT_TYPES.has(output.portType);
}

const ROUTE_REASONS = new Set<OnTheGoReason>(["carplay", "car-bluetooth", "car-mode"]);
const INACTIVE: OnTheGoDecision = { active: false, reason: null, learnedCar: null };

function atLeastMedium(confidence: MotionConfidence): boolean {
  return confidence === "medium" || confidence === "high";
}

/**
 * Decides whether the voice call should be in On the go mode from the phone's car signals.
 * Pure and clock-injected: the caller feeds signals and calls `resolve` on every change and on
 * a steady tick, because exits are time-based.
 */
export class OnTheGoDetector {
  private readonly options: OnTheGoDetectorOptions;
  private outputs: AudioOutput[] = [];
  private carMode = false;
  private automotiveNow = false;
  private automotiveConfidentNow = false;
  private automotiveHighSince: number | null = null;
  private automotiveFalseSince: number | null = null;
  private walkingSince: number | null = null;
  private routeLostAt: number | null = null;
  private current: OnTheGoReason | null = null;

  constructor(options: Partial<OnTheGoDetectorOptions> = {}) {
    this.options = { ...DEFAULT_ON_THE_GO_OPTIONS, ...options };
  }

  setRoute(outputs: readonly AudioOutput[]): void {
    this.outputs = [...outputs];
  }

  setCarMode(carMode: boolean): void {
    this.carMode = carMode;
  }

  setMotion(activity: MotionActivity, now: number): void {
    this.automotiveNow = activity.automotive;
    this.automotiveConfidentNow = activity.automotive && atLeastMedium(activity.confidence);
    if (activity.automotive && activity.confidence === "high") {
      this.automotiveHighSince ??= Math.min(activity.startedAt ?? now, now);
    } else {
      this.automotiveHighSince = null;
    }
    if (activity.automotive) {
      this.automotiveFalseSince = null;
    } else {
      this.automotiveFalseSince ??= now;
    }
    if (activity.walking && atLeastMedium(activity.confidence)) {
      this.walkingSince ??= now;
    } else {
      this.walkingSince = null;
    }
  }

  /** The routed Bluetooth output, if any: what a manual switch to On the go remembers as a car. */
  bluetoothOutput(): AudioOutput | null {
    return this.outputs.find(isBluetoothOutput) ?? null;
  }

  resolve(context: OnTheGoContext, now: number): OnTheGoDecision {
    const decision = this.decide(context, now);
    this.current = decision.reason;
    return decision;
  }

  private decide(context: OnTheGoContext, now: number): OnTheGoDecision {
    if (context.preference === "never" || context.override === "off") {
      this.routeLostAt = null;
      return INACTIVE;
    }
    if (context.preference === "always") return this.activate("always");
    if (context.override === "on") return this.activate("manual");

    const route = this.routeDecision(context.rememberedCarUids);
    if (route) {
      this.routeLostAt = null;
      return route;
    }
    if (this.current && ROUTE_REASONS.has(this.current)) {
      this.routeLostAt ??= now;
      if (now - this.routeLostAt < this.options.routeExitMs) return this.activate(this.current);
    }
    this.routeLostAt = null;

    if (this.current === "motion") {
      return this.motionEnded(now) ? INACTIVE : this.activate("motion");
    }
    if (
      this.automotiveHighSince !== null &&
      now - this.automotiveHighSince >= this.options.motionEnterMs
    ) {
      return this.activate("motion");
    }
    return INACTIVE;
  }

  private routeDecision(rememberedCarUids: ReadonlySet<string>): OnTheGoDecision | null {
    if (this.outputs.some((output) => output.portType === "carAudio")) {
      return this.activate("carplay");
    }
    const bluetooth = this.bluetoothOutput();
    if (bluetooth && rememberedCarUids.has(bluetooth.uid)) return this.activate("car-bluetooth");
    // Headphones are Bluetooth too, so an unknown device only counts while the phone is driving.
    if (bluetooth && this.automotiveConfidentNow) {
      return { active: true, reason: "car-bluetooth", learnedCar: bluetooth };
    }
    if (this.carMode) return this.activate("car-mode");
    return null;
  }

  private motionEnded(now: number): boolean {
    if (this.automotiveNow) return false;
    if (this.walkingSince !== null && now - this.walkingSince >= this.options.walkingExitMs) {
      return true;
    }
    return (
      this.automotiveFalseSince !== null &&
      now - this.automotiveFalseSince >= this.options.motionExitMs
    );
  }

  private activate(reason: OnTheGoReason): OnTheGoDecision {
    return { active: true, reason, learnedCar: null };
  }
}
