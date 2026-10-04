import { describe, expect, it } from "vitest";
import { recordSendDisposition, resolveSendMarker, useSendMarkerStore } from "./send-markers";

function markerFor(identity: { messageId?: string; clientMessageId?: string }) {
  return resolveSendMarker(useSendMarkerStore.getState().markers, identity);
}

describe("send markers", () => {
  it("marks a send that steered or waited in the queue, and nothing else", () => {
    recordSendDisposition("m-steered", "steered");
    recordSendDisposition("m-queued", "queued");
    recordSendDisposition("m-started", "started");
    recordSendDisposition("m-retried", undefined);

    expect(markerFor({ clientMessageId: "m-steered" })).toBe("steered");
    expect(markerFor({ messageId: "m-queued" })).toBe("queued");
    expect(markerFor({ messageId: "m-started" })).toBeNull();
    expect(markerFor({ messageId: "m-retried" })).toBeNull();
  });

  it("turns a queued message that was later sent as a steer into a steer", () => {
    recordSendDisposition("m-promoted", "queued");
    recordSendDisposition("m-promoted", "steered");

    expect(markerFor({ messageId: "m-promoted" })).toBe("steered");
  });

  it("keeps the queued mark when the queued message later started its own turn", () => {
    recordSendDisposition("m-drained", "queued");
    recordSendDisposition("m-drained", "started");

    expect(markerFor({ messageId: "m-drained" })).toBe("queued");
  });
});
