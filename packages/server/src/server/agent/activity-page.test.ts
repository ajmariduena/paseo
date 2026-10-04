import { expect, test } from "vitest";

import { readActivityPage, type ActivityRow } from "./activity-page.js";

const ROWS: ActivityRow[] = [
  { seq: 1, item: { type: "user_message", text: "first task" } },
  { seq: 2, item: { type: "reasoning", text: "thinking" } },
  { seq: 3, item: { type: "assistant_message", text: "first answer" } },
  { seq: 4, item: { type: "user_message", text: "second task" } },
  { seq: 5, item: { type: "assistant_message", text: "a long final answer" } },
];

function page(overrides: Partial<Parameters<typeof readActivityPage>[0]> = {}) {
  return readActivityPage({
    rows: ROWS,
    view: "activity",
    limit: 50,
    maxCharsPerItem: 1000,
    ...overrides,
  });
}

test("reads forward from a position and points at the next one", () => {
  const first = page({ afterPosition: 0, limit: 2 });
  expect(first.items.map((item) => item.position)).toEqual([1, 2]);
  expect(first).toMatchObject({ hasMore: true, hasOlder: false, nextPosition: 2 });

  const rest = page({ afterPosition: first.nextPosition, limit: 10 });
  expect(rest.items.map((item) => item.position)).toEqual([3, 4, 5]);
  expect(rest).toMatchObject({ hasMore: false, hasOlder: true, nextPosition: 5 });

  expect(page({ afterPosition: rest.nextPosition }).items).toEqual([]);
});

test("the latest page is the tail, and its nextPosition reads only newer items", () => {
  const latest = page({ limit: 2 });
  expect(latest.items.map((item) => item.position)).toEqual([4, 5]);
  expect(latest).toMatchObject({ hasMore: false, hasOlder: true, nextPosition: 5 });
});

test("the messages view keeps only user and assistant messages", () => {
  const messages = page({ view: "messages", afterPosition: 0 });
  expect(messages.items.map((item) => item.kind)).toEqual([
    "user_message",
    "assistant_message",
    "user_message",
    "assistant_message",
  ]);
});

test("a long item is truncated and continues from nextTextOffset", () => {
  const truncated = page({ afterPosition: 4, maxCharsPerItem: 6 });
  expect(truncated.items).toEqual([
    {
      position: 5,
      kind: "assistant_message",
      text: "a long",
      textOffset: 0,
      textTruncated: true,
      nextTextOffset: 6,
    },
  ]);
  expect(truncated.includesFinalAssistantMessage).toBe(false);

  const continued = page({ itemPosition: 5, textOffset: 6, maxCharsPerItem: 100 });
  expect(continued.items).toEqual([
    {
      position: 5,
      kind: "assistant_message",
      text: " final answer",
      textOffset: 6,
      textTruncated: false,
    },
  ]);
  expect(continued.includesFinalAssistantMessage).toBe(false);
});

test("only a whole final assistant message counts as reading the result", () => {
  expect(page({ afterPosition: 0, limit: 3 }).includesFinalAssistantMessage).toBe(false);
  expect(page({ limit: 1 }).includesFinalAssistantMessage).toBe(true);
});
