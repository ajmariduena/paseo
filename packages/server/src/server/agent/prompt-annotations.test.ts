import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { syncFilePublication } from "../atomic-file.js";

import { PromptAnnotationStore, type PromptAnnotation } from "./prompt-annotations.js";

function notification(message: string): PromptAnnotation {
  return { kind: "notification", level: "info", message };
}

test("new annotations preserve older presentation instead of evicting it at 500 entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prompt-annotations-retain-"));
  try {
    const entries = Array.from({ length: 500 }, (_, index) => ({
      messageId: `m${index}`,
      textHash: createHash("sha256").update("same").digest("hex"),
      annotation: notification(`notification ${index}`),
    }));
    writeFileSync(join(dir, "agent.json"), JSON.stringify({ version: 1, entries }));
    const store = new PromptAnnotationStore(dir);
    await store.remember("agent", {
      messageId: "new",
      text: "new",
      annotation: notification("new"),
    });
    const restored = await new PromptAnnotationStore(dir).historyMatcherForHandoff("agent");
    expect(restored.take("same")).toEqual({
      messageId: "m0",
      annotation: notification("notification 0"),
    });
    expect(restored.take("new")).toEqual({ messageId: "new", annotation: notification("new") });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("native annotations distinguish repeated text, unsent attempts and prepended context", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prompt-annotations-native-"));
  const store = new PromptAnnotationStore(dir);
  const firstId = "00000000-0000-4000-8000-000000000001";
  const secondId = "00000000-0000-4000-8000-000000000002";
  const withdrawnId = "00000000-0000-4000-8000-000000000003";
  try {
    for (const messageId of ["first", "second", "unsent"]) {
      await store.remember("agent", {
        messageId,
        text: "same text",
        annotation: notification(messageId),
        nativeMessageIds: true,
      });
    }
    const first = { agentId: "agent", messageId: "first", nativeMessageId: firstId } as const;
    const second = { agentId: "agent", messageId: "second", nativeMessageId: secondId } as const;
    const withdrawn = {
      agentId: "agent",
      messageId: "first",
      nativeMessageId: withdrawnId,
    } as const;
    await store.prepareNativeDispatch(first);
    await store.prepareNativeDispatch(second);
    await store.prepareNativeDispatch(withdrawn);
    expect((await store.historyMatcher("agent")).take("same text", firstId)).toBeNull();
    await store.settleNativeDispatch({ ...first, state: "dispatched" });
    await store.settleNativeDispatch({ ...second, state: "dispatched" });
    await store.settleNativeDispatch({ ...withdrawn, state: "withdrawn" });

    const matcher = await new PromptAnnotationStore(dir).historyMatcherForHandoff("agent");
    expect(matcher.take("same text", "unrelated-user-message")).toBeNull();
    expect(matcher.take("same text", withdrawnId)).toBeNull();
    expect(matcher.take("context\n\nsame text", secondId)).toEqual({
      messageId: "second",
      annotation: notification("second"),
    });
    expect(() => matcher.assertNativeDispatchesResolved()).toThrow("absent from provider history");
    expect(matcher.take("same text", firstId)).toEqual({
      messageId: "first",
      annotation: notification("first"),
    });
    expect(matcher.take("same text", firstId)).toBeNull();
    expect(matcher.take("same text")).toBeNull();
    expect(() => matcher.assertNativeDispatchesResolved()).not.toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "failed disposition synchronization retries the retained publication",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "prompt-annotations-sync-"));
    let failSync = false;
    const store = new PromptAnnotationStore(dir, async (file, root) => {
      if (failSync) throw new Error("disposition sync failed");
      await syncFilePublication(file, root);
    });
    const attempt = {
      agentId: "agent",
      messageId: "wake",
      nativeMessageId: "00000000-0000-4000-8000-000000000001",
    } as const;
    try {
      await store.remember("agent", {
        messageId: "wake",
        text: "same",
        annotation: notification("done"),
        nativeMessageIds: true,
      });
      await store.prepareNativeDispatch(attempt);
      await store.prepareNativeDispatch(attempt);
      failSync = true;
      await expect(store.settleNativeDispatch({ ...attempt, state: "dispatched" })).rejects.toThrow(
        "disposition sync failed",
      );
      await expect(store.historyMatcherForHandoff("agent")).rejects.toThrow(
        "disposition sync failed",
      );
      failSync = false;
      const repaired = await store.historyMatcherForHandoff("agent");
      expect(repaired.take("same", attempt.nativeMessageId)).toEqual({
        messageId: "wake",
        annotation: notification("done"),
      });
      expect(() => repaired.assertNativeDispatchesResolved()).not.toThrow();
      await expect(store.settleNativeDispatch({ ...attempt, state: "withdrawn" })).rejects.toThrow(
        "disposition cannot change",
      );
      const disk = await new PromptAnnotationStore(dir).historyMatcherForHandoff("agent");
      expect(disk.take("same", attempt.nativeMessageId)).toEqual({
        messageId: "wake",
        annotation: notification("done"),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("annotation capacity refuses new data without overwriting existing history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prompt-annotations-capacity-"));
  const store = new PromptAnnotationStore(dir);
  try {
    await store.remember("agent", {
      messageId: "first",
      text: "first",
      annotation: notification("first"),
    });
    const saved = readFileSync(join(dir, "agent.json"), "utf8");
    await expect(
      store.remember("agent", {
        messageId: "too-large",
        text: "next",
        annotation: notification("x".repeat(16 * 1024 * 1024)),
      }),
    ).rejects.toThrow("storage capacity exceeded");
    expect(store.forMessage("agent", "too-large")).toBeNull();
    expect(readFileSync(join(dir, "agent.json"), "utf8")).toBe(saved);
    await store.remember("agent", {
      messageId: "next",
      text: "next",
      annotation: notification("next"),
    });
    const matcher = await new PromptAnnotationStore(dir).historyMatcherForHandoff("agent");
    expect(matcher.take("first")).toEqual({
      messageId: "first",
      annotation: notification("first"),
    });
    expect(matcher.take("next")).toEqual({ messageId: "next", annotation: notification("next") });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("preparation reserves room to persist the final dispatch disposition", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prompt-annotations-reserve-"));
  const nativeMessageId = "00000000-0000-4000-8000-000000000001";
  try {
    const entry = {
      messageId: "wake",
      textHash: createHash("sha256").update("wake").digest("hex"),
      annotation: notification(""),
      nativeDispatches: [{ messageId: nativeMessageId, state: "prepared" }],
    };
    const preparedBytes = Buffer.byteLength(
      JSON.stringify({ version: 1, entries: [entry] }, null, 2),
    );
    const initial = {
      ...entry,
      annotation: notification("x".repeat(16 * 1024 * 1024 - preparedBytes)),
      nativeDispatches: [],
    };
    const file = join(dir, "agent.json");
    const saved = JSON.stringify({ version: 1, entries: [initial] }, null, 2);
    writeFileSync(file, saved);
    const store = new PromptAnnotationStore(dir);
    await expect(
      store.prepareNativeDispatch({ agentId: "agent", messageId: "wake", nativeMessageId }),
    ).rejects.toThrow("storage capacity exceeded");
    expect(readFileSync(file, "utf8")).toBe(saved);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test.each(["duplicate IDs", "invalid hash", "invalid native identity"])(
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
      if (fault === "invalid native identity")
        data.entries[0].nativeDispatches = [{ messageId: "invalid", state: "dispatched" }];
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
