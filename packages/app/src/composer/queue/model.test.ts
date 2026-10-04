import { describe, expect, it } from "vitest";
import {
  resolveEditableQueueText,
  resolveFirstQueuedMessageId,
  resolveHeldQueueTitleKey,
  resolveQueueEntryMoves,
  resolveQueueEntrySource,
  type ServerQueueEntry,
} from "./model";

function entry(id: string, overrides: Partial<ServerQueueEntry> = {}): ServerQueueEntry {
  return {
    id,
    origin: "user",
    senderAgentId: null,
    position: 1,
    textPreview: `text ${id}`,
    attachmentCount: 0,
    createdAt: "2026-10-04T12:00:00.000Z",
    ...overrides,
  };
}

describe("resolveQueueEntrySource", () => {
  it("labels every origin that is not the user's own message", () => {
    expect(resolveQueueEntrySource(entry("u"))).toEqual({ kind: "user" });
    expect(
      resolveQueueEntrySource(entry("a", { origin: "agent", senderAgentId: "parent" })),
    ).toEqual({ kind: "agent", senderAgentId: "parent" });
    expect(resolveQueueEntrySource(entry("w", { origin: "delegation_wake" }))).toEqual({
      kind: "subagent_results",
    });
    expect(resolveQueueEntrySource(entry("s", { origin: "system" }))).toEqual({
      kind: "notification",
    });
  });
});

describe("resolveEditableQueueText", () => {
  it("prefers the whole text this app queued over the cut preview", () => {
    const long = "x".repeat(400);
    expect(resolveEditableQueueText(entry("u", { textPreview: long.slice(0, 200) }), long)).toBe(
      long,
    );
  });

  it("edits a short preview, which is the whole message", () => {
    expect(resolveEditableQueueText(entry("u", { textPreview: "fix the test" }), null)).toBe(
      "fix the test",
    );
  });

  it("refuses a preview at the daemon's cut, which may be truncated", () => {
    expect(resolveEditableQueueText(entry("u", { textPreview: "y".repeat(200) }), null)).toBeNull();
  });

  it("never edits subagent results or notifications", () => {
    expect(resolveEditableQueueText(entry("w", { origin: "delegation_wake" }), null)).toBeNull();
    expect(resolveEditableQueueText(entry("s", { origin: "system" }), "known")).toBeNull();
  });

  it("edits a message another agent queued", () => {
    expect(
      resolveEditableQueueText(entry("a", { origin: "agent", senderAgentId: "p" }), null),
    ).toBe("text a");
  });
});

describe("resolveQueueEntryMoves", () => {
  const queue = [
    entry("wake", { origin: "delegation_wake" }),
    entry("first"),
    entry("second"),
    entry("third"),
  ];

  it("swaps a middle entry with either neighbour and keeps subagent results first", () => {
    expect(resolveQueueEntryMoves(queue, "second")).toEqual({
      up: ["wake", "second", "first", "third"],
      down: ["wake", "first", "third", "second"],
    });
  });

  it("does not move past either end of the movable entries", () => {
    expect(resolveQueueEntryMoves(queue, "first")).toEqual({
      up: null,
      down: ["wake", "second", "first", "third"],
    });
    expect(resolveQueueEntryMoves(queue, "third")).toEqual({
      up: ["wake", "first", "third", "second"],
      down: null,
    });
  });

  it("never moves subagent results", () => {
    expect(resolveQueueEntryMoves(queue, "wake")).toEqual({ up: null, down: null });
  });
});

describe("resolveFirstQueuedMessageId", () => {
  it("picks the oldest written message, skipping subagent results and notifications", () => {
    expect(
      resolveFirstQueuedMessageId([
        entry("wake", { origin: "delegation_wake" }),
        entry("notice", { origin: "system" }),
        entry("from-parent", { origin: "agent", senderAgentId: "p" }),
        entry("mine"),
      ]),
    ).toBe("from-parent");
  });

  it("has nothing to steer when only subagent results wait", () => {
    expect(resolveFirstQueuedMessageId([entry("wake", { origin: "delegation_wake" })])).toBeNull();
    expect(resolveFirstQueuedMessageId([])).toBeNull();
  });
});

describe("resolveHeldQueueTitleKey", () => {
  it("names the reason the daemon held the queue", () => {
    expect(resolveHeldQueueTitleKey("restart")).toBe("composer.queue.held.restart");
    expect(resolveHeldQueueTitleKey("failure")).toBe("composer.queue.held.failure");
    expect(resolveHeldQueueTitleKey("user_stop")).toBe("composer.queue.held.userStop");
    expect(resolveHeldQueueTitleKey(null)).toBe("composer.queue.held.paused");
  });
});
