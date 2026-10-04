import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { PromptAnnotationStore, type PromptAnnotation } from "./prompt-annotations.js";

function notification(message: string): PromptAnnotation {
  return { kind: "notification", level: "info", message };
}

test("replayed history matches each remembered prompt once, in send order, across processes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prompt-annotations-"));
  const writer = new PromptAnnotationStore(dir);
  await writer.remember("agent-1", {
    messageId: "m1",
    text: "same",
    annotation: notification("first"),
  });
  await writer.remember("agent-1", {
    messageId: "m2",
    text: "same",
    annotation: notification("second"),
  });
  await writer.remember("agent-1", {
    messageId: "m1",
    text: "same",
    annotation: notification("x"),
  });

  const matcher = await new PromptAnnotationStore(dir).historyMatcher("agent-1");

  expect(matcher.take("unrelated")).toBe(null);
  expect(matcher.take("same")).toEqual({ messageId: "m1", annotation: notification("first") });
  expect(matcher.take("same")).toEqual({ messageId: "m2", annotation: notification("second") });
  expect(matcher.take("same")).toBe(null);
});

test("deleting an agent forgets its prompts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prompt-annotations-"));
  const store = new PromptAnnotationStore(dir);
  await store.remember("agent-1", { messageId: "m1", text: "hi", annotation: notification("n") });

  await store.delete("agent-1");

  expect(store.forMessage("agent-1", "m1")).toBe(null);
  expect((await new PromptAnnotationStore(dir).historyMatcher("agent-1")).take("hi")).toBe(null);
});
