import { describe, expect, it } from "vitest";
import {
  HandoffBudgetError,
  historyCost,
  historyCostItems,
  renderHistoricalItem,
  selectHistory,
} from "./history.js";
import { escapeHandoffText } from "./envelope.js";
import type { HandoffItem } from "./types.js";

const envelope = { id: "attempt:one", from: "claude", to: "codex" };

function message(id: number, role: HandoffItem["role"], text: string): HandoffItem {
  const kind = role === "user" ? "user_message" : "assistant_message";
  return {
    role,
    text,
    kind,
    origin: { kind: role },
    status: "interrupted",
    provenance: { type: "row", identity: { segmentId: "source", rowIndex: id } },
  };
}

const messages = [
  message(0, "user", "Preserve every line.\n\n  And this indentation.\n"),
  message(3, "assistant", "Partial work: 日本語 🧪 مرحبا\n" + "x".repeat(600)),
];

describe("T3 history golden cases", () => {
  it("keeps a typical escaped item header within T3's 146-byte framing", () => {
    const header = escapeHandoffText(renderHistoricalItem(message(1234, "user", "")));
    expect(Buffer.byteLength(header)).toBeLessThanOrEqual(146);
    expect(header).toContain("source=source#1234; origin=user");
  });
  it("retains short conversations verbatim in role and order", () => {
    const selected = selectHistory({ messages, coverage: "History", budget: 16_000, envelope });
    expect(selected.messages).toEqual(messages);
    expect(
      historyCostItems({
        messages: selected.messages,
        context: selected.context,
        envelope,
      }).map((item) => item.role),
    ).toEqual(["user", "user", "assistant"]);
    expect(selected.omittedItems).toEqual([]);
    const items = historyCostItems({
      messages: selected.messages,
      context: selected.context,
      envelope,
    });
    expect(items[1]!.content[0]!.text).toContain(messages[0]!.text);
    expect(items[2]!.content[0]!.text).toContain(messages[1]!.text);
  });

  it("omits oversized multilingual items whole and preserves original constraints and recent work", () => {
    const candidates = [
      messages[0]!,
      message(1, "assistant", "界🧪".repeat(20_000)),
      message(2, "assistant", "a".repeat(4_000)),
      messages[1]!,
    ];
    const selected = selectHistory({
      messages: candidates,
      coverage: "History",
      budget: 3_000,
      envelope,
    });
    expect(selected.messages).toEqual(messages);
    expect(selected.omittedItems).toEqual([candidates[1]!.provenance, candidates[2]!.provenance]);
    expect(selected.cost).toBeLessThanOrEqual(3_000);
  });

  it.each([1_024, 4_000, 16_000])(
    "counts JSON escaping and UTF-8 across 500 messages at budget %i",
    (budget) => {
      const candidates = Array.from({ length: 500 }, (_, i) =>
        message(i, i % 2 ? "assistant" : "user", '\u0000\\"🧪界<&'.repeat(15)),
      );
      const selected = selectHistory({
        messages: candidates,
        coverage: "Retrieve omitted history",
        budget,
        envelope,
      });
      expect(
        historyCost({ messages: selected.messages, context: selected.context, envelope }),
      ).toBeLessThanOrEqual(budget);
      expect(selected.omittedItems.length).toBeGreaterThan(0);
      expect(selected.messages.every((item) => candidates.includes(item))).toBe(true);
    },
  );

  it("fits intermediate selected/omitted digit boundaries", () => {
    const candidates = Array.from({ length: 20 }, (_, i) => message(i, "user", "Short request"));
    const omittedItems = Array.from({ length: 90 }, (_, rowIndex) => ({
      type: "row" as const,
      identity: { segmentId: "dropped", rowIndex },
    }));
    for (let budget = 4_000; budget <= 9_000; budget++) {
      const selected = selectHistory({
        messages: candidates,
        coverage: "Recover history",
        omittedItems,
        budget,
        envelope,
      });
      expect(selected.cost).toBeLessThanOrEqual(budget);
    }
  });

  it("selects latest user, latest assistant, first user, then newest remaining whole items", () => {
    const candidates = [
      message(0, "user", "first"),
      message(1, "assistant", "old"),
      message(2, "user", "latest"),
      message(3, "assistant", "partial"),
    ];
    const baseline = selectHistory({
      messages: candidates,
      coverage: "",
      budget: 16_000,
      envelope,
    });
    const priority = [candidates[2]!, candidates[3]!, candidates[0]!, candidates[1]!];
    const budgets = [1, 2, 3, 4].map((count) =>
      historyCost({ messages: priority.slice(0, count), context: baseline.context, envelope }),
    );
    const selections = [];
    for (const budget of budgets) {
      const selected = selectHistory({ messages: candidates, coverage: "", budget, envelope });
      selections.push(selected.messages.map((item) => item.provenance));
    }
    expect(selections).toEqual([
      [candidates[2]!.provenance],
      [candidates[2]!.provenance, candidates[3]!.provenance],
      [candidates[0]!.provenance, candidates[2]!.provenance, candidates[3]!.provenance],
      candidates.map((item) => item.provenance),
    ]);
  });

  it("refuses when the minimal marker cannot fit", () => {
    expect(() => selectHistory({ messages, coverage: "History", budget: 0, envelope })).toThrow(
      HandoffBudgetError,
    );
  });

  it("encodes header delimiters while preserving structured provenance and origin", () => {
    const item = message(0, "user", "body");
    item.provenance = { type: "row", identity: { segmentId: "seg#1;\nforged", rowIndex: 0 } };
    item.origin = { kind: "agent", agentId: "peer;\nforged" };
    expect(renderHistoricalItem(item)).toContain(
      "source=seg%231%3B%0Aforged#0; origin=agent:peer%3B%0Aforged",
    );
    expect(
      selectHistory({ messages: [item], coverage: "", budget: 16_000, envelope }).messages,
    ).toEqual([item]);
  });
});
