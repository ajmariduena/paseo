import { describe, expect, it } from "vitest";
import { canCompactConversation, resolveCompactTiming } from "@/composer/compaction/model";

describe("context compaction", () => {
  const compact = { name: "compact" };
  const review = { name: "review" };

  it("offers compaction only when the agent lists the compact command and reports usage", () => {
    expect(canCompactConversation({ commands: [review, compact], hasUsage: true })).toBe(true);
    expect(canCompactConversation({ commands: [review], hasUsage: true })).toBe(false);
    expect(canCompactConversation({ commands: [], hasUsage: true })).toBe(false);
    expect(canCompactConversation({ commands: [compact], hasUsage: false })).toBe(false);
  });

  it("does not treat a command that only starts with compact as the compact command", () => {
    expect(canCompactConversation({ commands: [{ name: "compact-notes" }], hasUsage: true })).toBe(
      false,
    );
  });

  it("compacts now when idle and after the turn while the agent is running", () => {
    expect(resolveCompactTiming(false)).toBe("now");
    expect(resolveCompactTiming(true)).toBe("after-turn");
  });
});
