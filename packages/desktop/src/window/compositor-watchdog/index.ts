import { app, type BrowserWindow, powerMonitor } from "electron";
import log from "electron-log/main";

// COMPAT(darwinCompositorWatchdog): added in v0.1.78, target removal after
// 2026-11-19. Workaround for Electron/Chromium macOS display-sleep compositor
// stalls; re-test when Electron/Chromium is upgraded.

// How often the main process probes the renderer for frame production.
const FRAME_PROBE_INTERVAL_MS = 2000;
// A probed frame must arrive within this window or the probe counts as stalled.
const FRAME_PROBE_DEADLINE_MS = 300;
// A deadline timer that fires later than this means the renderer main thread was
// busy (long task, memory pressure paging it back in), so a missing frame says
// nothing about the compositor and the probe is inconclusive.
const FRAME_PROBE_MAX_TIMER_LATENESS_MS = 200;
// Consecutive stalled probes before the watchdog restarts the GPU process (~6 s).
const FRAME_STALL_CHECKS_TO_RECOVER = 3;
// Minimum gap between GPU-process restarts.
const COMPOSITOR_RECOVERY_COOLDOWN_MS = 60_000;
// Grace period for Chromium to relaunch the GPU process before probing resumes.
const GPU_RELAUNCH_GRACE_MS = 5_000;
// Chromium counts every GPU-process death, these kills included, and aborts the
// browser once 3 deaths pile up in each GPU mode (forgiving one per 5 minutes).
// Two kills per 30 minutes keeps the watchdog alone from ever reaching that limit.
const MAX_RECOVERIES_PER_BUDGET_WINDOW = 2;
const RECOVERY_BUDGET_WINDOW_MS = 30 * 60_000;

// Resolves { producedFrame, visibilityState, elapsedMs } for the renderer. The
// frame is requested with requestAnimationFrame; setTimeout (not vsync-driven)
// bounds the wait so the probe always resolves even when frame production has
// stopped.
const FRAME_PROBE_SOURCE = `new Promise((resolve) => {
  let settled = false;
  const startedAt = performance.now();
  const finish = (producedFrame) => {
    if (settled) return;
    settled = true;
    resolve({
      producedFrame,
      visibilityState: document.visibilityState,
      elapsedMs: performance.now() - startedAt,
    });
  };
  requestAnimationFrame(() => finish(true));
  setTimeout(() => finish(false), ${FRAME_PROBE_DEADLINE_MS});
})`;

export type FrameProbeOutcome = "frame" | "stall" | "skip" | "inconclusive";

export function classifyFrameProbe(result: unknown): FrameProbeOutcome {
  if (typeof result !== "object" || result === null) {
    return "skip";
  }
  const { producedFrame, visibilityState, elapsedMs } = result as Record<string, unknown>;
  if (visibilityState !== "visible") {
    return "skip";
  }
  if (producedFrame === true) {
    return "frame";
  }
  if (
    typeof elapsedMs !== "number" ||
    elapsedMs > FRAME_PROBE_DEADLINE_MS + FRAME_PROBE_MAX_TIMER_LATENESS_MS
  ) {
    return "inconclusive";
  }
  return "stall";
}

interface FrameStallState {
  stalledChecks: number;
  recovering: boolean;
  now: number;
  recoveryTimestamps: readonly number[];
}

export function shouldRecoverFromFrameStall(state: FrameStallState): boolean {
  if (state.stalledChecks < FRAME_STALL_CHECKS_TO_RECOVER || state.recovering) {
    return false;
  }
  const lastRecoveryAt = state.recoveryTimestamps.at(-1);
  if (
    lastRecoveryAt !== undefined &&
    state.now - lastRecoveryAt < COMPOSITOR_RECOVERY_COOLDOWN_MS
  ) {
    return false;
  }
  const recentRecoveries = state.recoveryTimestamps.filter(
    (at) => state.now - at < RECOVERY_BUDGET_WINDOW_MS,
  ).length;
  return recentRecoveries < MAX_RECOVERIES_PER_BUDGET_WINDOW;
}

function findGpuProcessPid(): number | null {
  for (const metric of app.getAppMetrics()) {
    if (metric.type === "GPU") {
      return metric.pid;
    }
  }
  return null;
}

// macOS display sleep can leave Chromium's GPU-process display link (the vsync
// source that drives frame production) stuck on a stale display. The compositor
// then stops producing frames and the window looks frozen: unresponsive to
// clicks and keys even though the renderer and every process stay alive. This
// watchdog polls the renderer for frame production and, on a sustained stall,
// restarts the GPU process so Chromium rebuilds the display link.
export function setupDarwinCompositorWatchdog(win: BrowserWindow): void {
  if (process.platform !== "darwin") {
    return;
  }

  // Deliberately do NOT call win.webContents.setBackgroundThrottling(false) here.
  // Disabling background throttling keeps Chromium's compositor producing frames
  // continuously, which pins ProMotion displays at their max refresh rate (120Hz)
  // forever and drains the battery even while the app sits idle. The probe does
  // not need it: the visibility guards below (screen lock / isVisible /
  // isMinimized / document.visibilityState) already skip windows that legitimately
  // stop producing frames, so throttling cannot fool the probe into a false stall.
  // The freeze this watchdog targets happens while the window is visible and
  // focused (just after display wake), where background throttling never applies.

  let stalledChecks = 0;
  let recovering = false;
  let recoveryTimestamps: number[] = [];
  let screenLocked = false;

  const recoverCompositor = async () => {
    recovering = true;
    const now = Date.now();
    recoveryTimestamps = [
      ...recoveryTimestamps.filter((at) => now - at < RECOVERY_BUDGET_WINDOW_MS),
      now,
    ];
    stalledChecks = 0;
    const gpuPid = findGpuProcessPid();
    log.warn("[compositor-watchdog] window stopped producing frames; restarting GPU process", {
      gpuPid,
      recoveriesInBudgetWindow: recoveryTimestamps.length,
    });
    if (gpuPid !== null) {
      try {
        process.kill(gpuPid, "SIGKILL");
      } catch (error) {
        log.warn("[compositor-watchdog] could not restart GPU process", error);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, GPU_RELAUNCH_GRACE_MS));
    recovering = false;
  };

  const probeFrameProduction = async () => {
    if (win.isDestroyed() || recovering) {
      return;
    }
    // A freeze is only meaningful, and only distinguishable from a normal idle
    // window, while the window is actually on screen. A locked screen, a
    // minimized window, or a hidden one legitimately stops producing frames.
    if (screenLocked || !win.isVisible() || win.isMinimized()) {
      stalledChecks = 0;
      return;
    }

    let result: unknown;
    try {
      result = await win.webContents.executeJavaScript(FRAME_PROBE_SOURCE);
    } catch {
      return;
    }
    switch (classifyFrameProbe(result)) {
      case "frame":
      case "skip":
        stalledChecks = 0;
        return;
      case "inconclusive":
        return;
      case "stall":
        stalledChecks += 1;
        break;
    }

    if (
      shouldRecoverFromFrameStall({
        stalledChecks,
        recovering,
        now: Date.now(),
        recoveryTimestamps,
      })
    ) {
      void recoverCompositor();
    }
  };

  const probeTimer = setInterval(() => void probeFrameProduction(), FRAME_PROBE_INTERVAL_MS);
  const handleScreenLocked = () => {
    screenLocked = true;
    stalledChecks = 0;
  };
  const handleScreenUnlocked = () => {
    screenLocked = false;
    stalledChecks = 0;
  };
  powerMonitor.on("lock-screen", handleScreenLocked);
  powerMonitor.on("unlock-screen", handleScreenUnlocked);

  win.once("closed", () => {
    clearInterval(probeTimer);
    powerMonitor.off("lock-screen", handleScreenLocked);
    powerMonitor.off("unlock-screen", handleScreenUnlocked);
  });
}
