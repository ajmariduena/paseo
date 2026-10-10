import { describe, expect, it } from "vitest";
import { ReflectedInput } from "./reflected-audio.js";

function frame(value: number): Buffer {
  const pcm = Buffer.alloc(960);
  for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(value, offset);
  return pcm;
}

describe("ReflectedInput", () => {
  it("waits for real microphone signal before calling the phone live", () => {
    let now = 1_000;
    const input = new ReflectedInput(() => now);
    expect(input.note(frame(0))).toBe(false);
    now += 900;
    expect(input.note(frame(0))).toBe(false);
    expect(input.isLive).toBe(false);
    now += 100;
    expect(input.note(frame(3))).toBe(true);
    expect(input.note(frame(3))).toBe(false);
    expect(input.silentLeadMs).toBe(1_000);
  });

  it("reports the loudest recent input", () => {
    let now = 0;
    const input = new ReflectedInput(() => now);
    input.note(frame(1_200));
    now += 2_000;
    input.note(frame(40));
    expect(input.peak(1_500)).toBe(40);
    expect(input.peak(2_500)).toBe(1_200);
  });
});
