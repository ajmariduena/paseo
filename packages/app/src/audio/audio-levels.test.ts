import { afterEach, expect, test } from "vitest";
import {
  clearPlaybackLevels,
  levelFromAmplitude,
  readAudioLevels,
  reportCapturedPcm16,
  reportTransportLevels,
  resetAudioLevels,
  schedulePlaybackPcm16,
} from "./audio-levels";

function tone(amplitude: number, samples: number): Uint8Array {
  const pcm = new Uint8Array(samples * 2);
  const view = new DataView(pcm.buffer);
  for (let index = 0; index < samples; index += 1) {
    view.setInt16(index * 2, Math.round((index % 2 === 0 ? 1 : -1) * amplitude * 32767), true);
  }
  return pcm;
}

afterEach(() => resetAudioLevels());

test("maps amplitude onto a 0–1 perceptual scale", () => {
  expect(levelFromAmplitude(0)).toBe(0);
  expect(levelFromAmplitude(1)).toBeCloseTo(1, 1);
  expect(levelFromAmplitude(0.01)).toBeGreaterThan(0);
  expect(levelFromAmplitude(0.01)).toBeLessThan(levelFromAmplitude(0.1));
});

test("the microphone level goes silent when reports stop", () => {
  reportCapturedPcm16(tone(0.3, 320), 1_000);
  expect(readAudioLevels(1_100).user).toBeGreaterThan(0.5);
  expect(readAudioLevels(1_500).user).toBe(0);
});

test("playback levels follow when the audio is heard, not when it was queued", () => {
  const silence = tone(0, 1_600);
  const loud = tone(0.5, 1_600);
  schedulePlaybackPcm16(new Uint8Array([...silence, ...loud]), 16_000, 2_000);
  expect(readAudioLevels(1_900).assistant).toBe(0);
  expect(readAudioLevels(2_050).assistant).toBe(0);
  expect(readAudioLevels(2_150).assistant).toBeGreaterThan(0.5);
  expect(readAudioLevels(2_250).assistant).toBe(0);
});

test("stopping playback clears what was still queued", () => {
  schedulePlaybackPcm16(tone(0.5, 16_000), 16_000, 0);
  clearPlaybackLevels();
  expect(readAudioLevels(100).assistant).toBe(0);
});

test("transport levels report both sides", () => {
  reportTransportLevels({ user: 0.2, assistant: 0.7 }, 5_000);
  expect(readAudioLevels(5_100)).toEqual({ user: 0.2, assistant: 0.7 });
  expect(readAudioLevels(5_400)).toEqual({ user: 0, assistant: 0 });
});
