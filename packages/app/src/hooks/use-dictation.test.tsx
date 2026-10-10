/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDictation } from "./use-dictation";

const audio = vi.hoisted(() => ({
  start: vi.fn<() => Promise<void>>(),
  stop: vi.fn<() => Promise<void>>(),
}));

vi.mock("./use-dictation-audio-source", () => ({
  useDictationAudioSource: () => ({ ...audio, volume: 0 }),
}));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("useDictation feedback", () => {
  beforeEach(() => {
    audio.start.mockReset();
    audio.stop.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows startup immediately and sending before the microphone finishes stopping", async () => {
    const started = deferred();
    const stopped = deferred();
    audio.start.mockReturnValue(started.promise);
    audio.stop.mockReturnValue(stopped.promise);
    let paint: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      paint = callback;
      return 1;
    });

    const { result } = renderHook(() =>
      useDictation({ client: null, onTranscript: vi.fn(), canStart: () => true }),
    );

    let start!: Promise<void>;
    act(() => {
      start = result.current.startDictation();
    });
    expect(result.current.status).toBe("starting");
    expect(result.current.isRecording).toBe(false);
    expect(audio.start).not.toHaveBeenCalled();

    await act(async () => {
      paint?.(0);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(audio.start).toHaveBeenCalledTimes(1);

    await act(async () => {
      started.resolve();
      await start;
    });
    expect(result.current.status).toBe("recording");
    expect(result.current.isRecording).toBe(true);

    let confirm!: Promise<void>;
    act(() => {
      confirm = result.current.confirmDictation();
    });
    expect(result.current.isProcessing).toBe(true);
    expect(result.current.isRecording).toBe(true);
    expect(audio.stop).not.toHaveBeenCalled();

    await act(async () => {
      paint?.(0);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(audio.stop).toHaveBeenCalledTimes(1);

    await act(async () => {
      stopped.resolve();
      await confirm;
    });
    expect(result.current.status).toBe("idle");
    expect(result.current.isProcessing).toBe(false);
  });

  it("clears the startup state when microphone access fails", async () => {
    audio.start.mockRejectedValue(new Error("Microphone denied"));
    audio.stop.mockResolvedValue();
    const onError = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { result } = renderHook(() =>
      useDictation({ client: null, onTranscript: vi.fn(), onError, canStart: () => true }),
    );

    let start!: Promise<void>;
    act(() => {
      start = result.current.startDictation();
    });
    expect(result.current.status).toBe("starting");

    await act(async () => {
      await start;
    });
    expect(result.current.status).toBe("idle");
    expect(result.current.isRecording).toBe(false);
    expect(onError).toHaveBeenCalledWith(new Error("Microphone denied"));
    consoleError.mockRestore();
  });

  it("cancels startup before the microphone opens", async () => {
    const started = deferred();
    audio.start.mockReturnValue(started.promise);
    audio.stop.mockResolvedValue();
    let paint: FrameRequestCallback | null = null;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      paint = callback;
      return 1;
    });
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useDictation({ client: null, onTranscript: vi.fn(), onError, canStart: () => true }),
    );

    let start!: Promise<void>;
    act(() => {
      start = result.current.startDictation();
    });
    await act(async () => {
      paint?.(0);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(audio.start).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.cancelDictation();
    });
    expect(result.current.status).toBe("idle");

    await act(async () => {
      started.resolve();
      await start;
    });
    expect(audio.stop).toHaveBeenCalledTimes(1);
    expect(result.current.isRecording).toBe(false);
    expect(result.current.status).toBe("idle");
    expect(onError).not.toHaveBeenCalled();
  });
});
