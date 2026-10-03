import { describe, expect, it } from "vitest";
import { FloorQueue, SpeechFloor, isEchoOfAssistant } from "./speech-floor.js";

function clock() {
  let now = 10_000;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("SpeechFloor", () => {
  it("keeps the assistant on the floor until its queued audio has played", () => {
    const time = clock();
    const floor = new SpeechFloor(time.now);
    floor.noteAssistantAudio(2_000);
    floor.noteAssistantAudio(1_000);

    time.advance(3_500);
    expect(floor.isAssistantSpeaking()).toBe(true);
    time.advance(400);
    expect(floor.isAssistantSpeaking()).toBe(false);
  });
});

describe("FloorQueue", () => {
  function setup(awaitingResult = false) {
    const time = clock();
    const floor = new SpeechFloor(time.now);
    const sent: string[] = [];
    const queue = new FloorQueue(floor, { isAwaitingResult: () => awaitingResult, now: time.now });
    return { time, floor, sent, queue };
  }

  it("holds an update while the assistant talks and sends it in the next lull", () => {
    const { time, floor, sent, queue } = setup();
    floor.noteAssistantAudio(3_000);
    queue.push("routine", () => sent.push("auth terminó"));
    expect(sent).toEqual([]);

    time.advance(3_000 + 800 + 1_900);
    queue.push("routine", () => sent.push("noop"));
    expect(sent).toEqual([]);
    time.advance(200);
    queue.push("routine", () => sent.push("segundo"));
    expect(sent).toEqual(["auth terminó"]);
    queue.close();
  });

  it("lets the user's answer through before routine updates, one per gap", () => {
    const { time, floor, sent, queue } = setup();
    floor.noteAssistantText();
    queue.push("routine", () => sent.push("routine"));
    queue.push("result", () => sent.push("result"));
    time.advance(5_000);
    queue.push("urgent", () => sent.push("urgent"));

    expect(sent).toEqual(["result"]);
    queue.close();
  });

  it("keeps routine updates back while the user's request is still running", () => {
    const { time, sent, queue } = setup(true);
    queue.push("routine", () => sent.push("routine"));
    time.advance(30_000);
    queue.push("urgent", () => sent.push("urgent"));

    expect(sent).toEqual(["urgent"]);
    queue.close();
  });

  it("never holds an update past its deadline", () => {
    const { time, floor, sent, queue } = setup();
    floor.noteUserSpeech();
    queue.push("result", () => sent.push("result"));
    for (let elapsed = 0; elapsed < 12_000; elapsed += 500) {
      time.advance(500);
      floor.noteUserSpeech();
    }
    queue.push("routine", () => undefined);

    expect(sent).toEqual(["result"]);
    queue.close();
  });
});

describe("isEchoOfAssistant", () => {
  it("recognizes the assistant's own words coming back through the speaker", () => {
    expect(isEchoOfAssistant("¿algo más?", "Listo, auth terminó. ¿Algo más?")).toBe(true);
    expect(isEchoOfAssistant("espera para", "Listo, auth terminó. ¿Algo más?")).toBe(false);
  });
});
