import { describe, expect, it } from "vitest";
import { EnergyVad, pcm16Rms } from "./energy-vad";

const CHUNK_MS = 100;
const SAMPLES_PER_CHUNK = (16000 * CHUNK_MS) / 1000;

function chunk(amplitude: number): Uint8Array {
  const out = new Uint8Array(SAMPLES_PER_CHUNK * 2);
  const view = new DataView(out.buffer);
  for (let index = 0; index < SAMPLES_PER_CHUNK; index += 1) {
    const value = Math.round(Math.sin(index / 3) * amplitude * 32767);
    view.setInt16(index * 2, value, true);
  }
  return out;
}

function feed(vad: EnergyVad, amplitude: number, ms: number) {
  const events = [];
  for (let elapsed = 0; elapsed < ms; elapsed += CHUNK_MS)
    events.push(...vad.push(chunk(amplitude)));
  return events;
}

describe("EnergyVad", () => {
  it("measures RMS of PCM16", () => {
    expect(pcm16Rms(chunk(0))).toBe(0);
    expect(pcm16Rms(chunk(0.5))).toBeGreaterThan(0.3);
  });

  it("emits one utterance with pre-roll after speech and a pause", () => {
    const vad = new EnergyVad();
    expect(feed(vad, 0.002, 1000)).toEqual([]);
    expect(feed(vad, 0.3, 300).map((event) => event.type)).toEqual(["speech_started"]);
    feed(vad, 0.3, 1200);
    const events = feed(vad, 0.002, 1300);

    expect(events).toHaveLength(1);
    const utterance = events[0];
    expect(utterance?.type).toBe("utterance");
    if (utterance?.type === "utterance") {
      expect(utterance.durationMs).toBeGreaterThanOrEqual(1500 + 1200);
      expect(utterance.durationMs).toBeLessThan(1500 + 1300 + 400);
    }
  });

  it("discards a short noise burst", () => {
    const vad = new EnergyVad();
    feed(vad, 0.002, 500);
    feed(vad, 0.3, 300);
    const events = feed(vad, 0.002, 1300);

    expect(events.map((event) => event.type)).toEqual(["discarded"]);
  });

  it("raises the threshold in steady background noise", () => {
    const vad = new EnergyVad();
    const quiet = vad.threshold();
    feed(vad, 0.015, 5000);

    expect(vad.threshold()).toBeGreaterThan(quiet);
    expect(vad.isInSpeech).toBe(false);
  });
});
