import pino from "pino";
import { describe, expect, it } from "vitest";
import type { VoiceOrchestrator } from "../orchestrator.js";
import { VoiceMessagesHub } from "./messages-hub.js";

function createHub() {
  const orchestrator = {
    language: "es",
    attachCall: () => () => undefined,
    closeLiveCall: () => undefined,
    takeRecentHistory: () => [],
    saveCallHistory: () => undefined,
  } as unknown as VoiceOrchestrator;
  return new VoiceMessagesHub({
    orchestrator,
    speech: { resolveStt: () => null, resolveTts: () => null },
    logger: pino({ level: "silent" }),
  });
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("VoiceMessagesHub", () => {
  it("says a live answer that finished during the switch once the messages call starts", async () => {
    const hub = createHub();
    hub.deliverLateReply("auth terminó: el login ya funciona.");
    const call = hub.start({ callId: "c1", history: [], greet: false });
    await settle();

    expect(call.sync(0)).toMatchObject([
      { kind: "reply", text: "auth terminó: el login ya funciona." },
    ]);
    hub.dispose();
  });

  it("resumes the same call by id and replaces a different one", () => {
    const hub = createHub();
    const first = hub.start({ callId: "c1", history: [], greet: false });

    expect(hub.start({ callId: "c1", history: [], greet: false })).toBe(first);
    const second = hub.start({ callId: "c2", history: [], greet: false });
    expect(first.isClosed).toBe(true);
    expect(hub.get("c2")).toBe(second);
    hub.dispose();
  });
});
