import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { PromptAnnotationStore, type PromptAnnotation } from "./prompt-annotations.js";

function notification(message: string): PromptAnnotation {
  return { kind: "notification", level: "info", message };
}

test("duplicate prompts do not acknowledge a failed annotation write and can retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "prompt-annotations-failure-"));
  const dir = join(root, "annotations");
  const store = new PromptAnnotationStore(dir);
  const prompt = { messageId: "m1", text: "wake", annotation: notification("finished") };
  try {
    await store.historyMatcher("agent-1");
    writeFileSync(dir, "blocks annotation storage");
    const attempts = await Promise.allSettled([
      store.remember("agent-1", prompt),
      store.remember("agent-1", prompt),
    ]);
    expect(attempts.map((attempt) => attempt.status)).toEqual(["rejected", "rejected"]);
    expect(store.forMessage("agent-1", "m1")).toBe(null);
    rmSync(dir);
    await store.remember("agent-1", prompt);
    const restored = await new PromptAnnotationStore(dir).historyMatcher("agent-1");
    expect(restored.take("wake")).toEqual({
      messageId: "m1",
      annotation: notification("finished"),
    });
    expect(restored.take("wake")).toBe(null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("handoff waits for submitted annotations and deletion does not resurrect older prompts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prompt-annotations-order-"));
  const store = new PromptAnnotationStore(dir);
  try {
    const first = store.remember("agent-1", {
      messageId: "m1",
      text: "first",
      annotation: notification("first"),
    });
    const pendingHistory = store.historyMatcherForHandoff("agent-1");
    await first;
    expect((await pendingHistory).take("first")).toEqual({
      messageId: "m1",
      annotation: notification("first"),
    });
    const deletion = store.delete("agent-1");
    const second = store.remember("agent-1", {
      messageId: "m2",
      text: "second",
      annotation: notification("second"),
    });
    await Promise.all([deletion, second]);
    const restored = await new PromptAnnotationStore(dir).historyMatcherForHandoff("agent-1");
    expect(restored.take("first")).toBe(null);
    expect(restored.take("second")).toEqual({
      messageId: "m2",
      annotation: notification("second"),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handoff refuses a missing committed annotation file until it is restored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prompt-annotations-missing-"));
  const store = new PromptAnnotationStore(dir);
  try {
    await store.remember("agent-1", {
      messageId: "m1",
      text: "wake",
      annotation: notification("n"),
    });
    const file = join(dir, "agent-1.json");
    const saved = readFileSync(file);
    rmSync(file);
    await expect(store.historyMatcherForHandoff("agent-1")).rejects.toThrow("changed on disk");
    expect((await store.historyMatcherForHandoff("another-agent")).take("wake")).toBe(null);
    writeFileSync(file, saved);
    expect((await store.historyMatcherForHandoff("agent-1")).take("wake")).toEqual({
      messageId: "m1",
      annotation: notification("n"),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each(["duplicate IDs", "invalid hash", "too many entries"])(
  "handoff refuses annotation metadata with %s and can retry repaired data",
  async (fault) => {
    const dir = mkdtempSync(join(tmpdir(), "prompt-annotations-invalid-"));
    const store = new PromptAnnotationStore(dir);
    try {
      await store.remember("agent-1", {
        messageId: "m1",
        text: "wake",
        annotation: notification("n"),
      });
      const file = join(dir, "agent-1.json");
      const saved = readFileSync(file, "utf8");
      const data = JSON.parse(saved);
      if (fault === "duplicate IDs") data.entries.push(data.entries[0]);
      if (fault === "invalid hash") data.entries[0].textHash = "invalid";
      if (fault === "too many entries")
        data.entries = Array.from({ length: 501 }, (_, index) => ({
          ...data.entries[0],
          messageId: `m${index}`,
        }));
      writeFileSync(file, JSON.stringify(data));
      const reader = new PromptAnnotationStore(dir);
      await expect(reader.historyMatcherForHandoff("agent-1")).rejects.toThrow(
        "Prompt annotation history is invalid",
      );
      writeFileSync(file, saved);
      expect((await reader.historyMatcherForHandoff("agent-1")).take("wake")).toEqual({
        messageId: "m1",
        annotation: notification("n"),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("handoff bounds the annotation file before parsing it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prompt-annotations-size-"));
  try {
    writeFileSync(join(dir, "agent-1.json"), Buffer.alloc(16 * 1024 * 1024 + 1, 32));
    await expect(
      new PromptAnnotationStore(dir).historyMatcherForHandoff("agent-1"),
    ).rejects.toThrow("Invalid handoff metadata file size");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ordinary history cannot turn damaged annotation metadata into a successful overwrite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prompt-annotations-preserve-"));
  try {
    const file = join(dir, "agent-1.json");
    const writer = new PromptAnnotationStore(dir);
    await writer.remember("agent-1", {
      messageId: "m1",
      text: "first",
      annotation: notification("first"),
    });
    const saved = readFileSync(file, "utf8");
    const damaged = JSON.stringify({ ...JSON.parse(saved), version: 0 });
    writeFileSync(file, damaged);
    const reader = new PromptAnnotationStore(dir);
    expect((await reader.historyMatcher("agent-1")).take("first")).toBe(null);
    const next = { messageId: "m2", text: "second", annotation: notification("second") };
    await expect(reader.remember("agent-1", next)).rejects.toThrow(
      "Prompt annotation history is invalid",
    );
    expect(readFileSync(file, "utf8")).toBe(damaged);
    writeFileSync(file, saved);
    await reader.remember("agent-1", next);
    const restored = await new PromptAnnotationStore(dir).historyMatcherForHandoff("agent-1");
    expect(restored.take("first")).toEqual({ messageId: "m1", annotation: notification("first") });
    expect(restored.take("second")).toEqual({
      messageId: "m2",
      annotation: notification("second"),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
