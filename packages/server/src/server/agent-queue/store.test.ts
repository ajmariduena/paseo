import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdir, readFile, realpath, symlink, truncate, writeFile } from "node:fs/promises";
import { syncFilePublication } from "../atomic-file.js";
import { FileUploadStore } from "../file-upload/index.js";

import {
  AgentQueueStore,
  QueueEntryTooLargeError,
  type AgentQueueEntry,
  type NewQueueEntry,
  readHandoffQueue,
  HANDOFF_QUEUE_MAX_BYTES,
} from "./store.js";

const NOW = "2026-10-04T00:00:00.000Z";
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "paseo-agent-queue-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function userMessage(id: string, prompt: NewQueueEntry["prompt"] = `text of ${id}`): NewQueueEntry {
  return { id, origin: "user", senderAgentId: null, textPreview: "", prompt, wake: null };
}

function wake(id: string, generation: number): NewQueueEntry {
  return {
    id,
    origin: "delegation_wake",
    senderAgentId: null,
    textPreview: "Review finished",
    prompt: null,
    wake: { cohortKey: "run-1", generation },
  };
}

function readQueueFile(agentId: string): unknown {
  return JSON.parse(readFileSync(join(root, `${agentId}.json`), "utf8"));
}

async function drainIds(store: AgentQueueStore, agentId: string): Promise<string[]> {
  const ids: string[] = [];
  for (;;) {
    const next = await store.dequeueNext(agentId);
    if (!next) return ids;
    ids.push(next.entry.id);
  }
}

test.skipIf(process.platform === "win32").each([
  { type: "forge_change_request", mimeType: "application/paseo-forge-change-request" },
  { type: "forge_issue", mimeType: "application/paseo-forge-issue" },
] as const)("handoff preserves a $type attachment's remote project identity", async (kind) => {
  const attachment = {
    ...kind,
    forge: "gitlab",
    number: 42,
    title: "Keep the nested project",
    url: "https://gitlab.example/group/subgroup/repo/-/issues/42",
    body: "The project name is not a local directory.",
    projectPath: "group/subgroup/repo",
  };
  const source = new AgentQueueStore(join(root, "source"));
  await source.enqueue("source", userMessage("pending", [attachment]), NOW);
  await source.hold("source", "user_stop");
  const snapshot = await source.exportForHandoff("source");
  const destination = new AgentQueueStore(join(root, "destination"));
  await destination.installHandoffQueue("target", "reservation", snapshot);
  expect(await destination.dequeueNext("target")).toBeNull();
  await destination.resume("target");
  expect((await destination.dequeueNext("target"))?.prompt).toEqual([attachment]);
});

function reviewAttachment(cwd: string, mode: "base" | "uncommitted" = "uncommitted") {
  return {
    type: "review" as const,
    mimeType: "application/paseo-review" as const,
    cwd,
    mode,
    baseRef: mode === "base" ? "main" : null,
    comments: [
      {
        filePath: "deleted.ts",
        side: "old" as const,
        lineNumber: 7,
        body: `Keep this explanation of ${cwd}`,
        context: {
          hunkHeader: "@@ -7 +6,0 @@",
          targetLine: {
            oldLineNumber: 7,
            newLineNumber: null,
            type: "remove" as const,
            content: "removed();",
          },
          lines: [
            {
              oldLineNumber: 7,
              newLineNumber: null,
              type: "remove" as const,
              content: "removed();",
            },
          ],
        },
      },
    ],
  };
}

test.skipIf(process.platform === "win32").each(["base", "uncommitted"] as const)(
  "handoff rebases a captured %s review without changing its comments or historical context",
  async (mode) => {
    const sourceCwd = join(root, "workspace");
    const reviewCwd = join(sourceCwd, "nested");
    const destinationCwd = join(root, "destination-workspace");
    await mkdir(reviewCwd, { recursive: true });
    await mkdir(destinationCwd);
    const alias = join(root, "review-directory-alias");
    await symlink(reviewCwd, alias);
    const review = reviewAttachment(alias, mode);
    const source = new AgentQueueStore(join(root, "source-queues"));
    await source.enqueue("source", userMessage("pending", [review]), NOW);
    await source.hold("source", "user_stop");
    const snapshot = await source.exportForHandoff("source", { workspaceCwd: sourceCwd });
    const canonicalSource = await realpath(sourceCwd);
    const capturedReview = {
      ...review,
      cwd: canonicalSource,
      comments: [{ ...review.comments[0], filePath: "nested/deleted.ts" }],
    };
    expect(snapshot.entries[0].prompt).toEqual([capturedReview]);
    let destination = new AgentQueueStore(join(root, "destination-queues"));
    const workspace = { sourceCwd: canonicalSource, destinationCwd };
    await destination.installHandoffQueue("target", "reservation", snapshot, { workspace });
    expect(snapshot.entries[0].prompt).toEqual([capturedReview]);
    destination = new AgentQueueStore(join(root, "destination-queues"));
    await destination.load();
    await destination.installHandoffQueue("target", "reservation", snapshot, { workspace });
    expect(await destination.dequeueNext("target")).toBeNull();
    await destination.resume("target");
    expect((await destination.dequeueNext("target"))?.prompt).toEqual([
      { ...capturedReview, cwd: destinationCwd },
    ]);
  },
);

test.skipIf(process.platform === "win32")(
  "handoff refuses review directories outside the workspace, including symlink escapes",
  async () => {
    const sourceCwd = join(root, "workspace");
    const outside = join(root, "another-workspace");
    await mkdir(sourceCwd);
    await mkdir(outside);
    const alias = join(sourceCwd, "escape");
    await symlink(outside, alias);
    const source = new AgentQueueStore(join(root, "source-queues"));
    for (const [index, directory] of [outside, alias].entries()) {
      const agentId = `source-${index}`;
      const prompt = [reviewAttachment(directory)];
      await source.enqueue(agentId, userMessage("pending", prompt), NOW);
      await source.hold(agentId, "user_stop");
      await expect(source.exportForHandoff(agentId, { workspaceCwd: sourceCwd })).rejects.toThrow(
        "different source workspace",
      );
      await source.resume(agentId);
      expect((await source.dequeueNext(agentId))?.prompt).toEqual(prompt);
    }
  },
);

test
  .skipIf(process.platform === "win32")
  .each([
    "../escape.ts",
    "/absolute.ts",
    "src/../../escape.ts",
    "C:\\file.ts",
    "C:/file.ts",
    "src\0/file.ts",
  ])(
  "handoff refuses the review comment path %s without dropping the source prompt",
  async (filePath) => {
    const source = new AgentQueueStore(join(root, "source-queues"));
    const review = reviewAttachment(root);
    review.comments[0].filePath = filePath;
    await source.enqueue("source", userMessage("pending", [review]), NOW);
    await source.hold("source", "user_stop");
    await expect(source.exportForHandoff("source", { workspaceCwd: root })).rejects.toThrow(
      "relative to its workspace",
    );
    expect(source.peek("source")?.entries).toHaveLength(1);
    await source.resume("source");
    expect((await source.dequeueNext("source"))?.prompt).toEqual([review]);
  },
);

test.skipIf(process.platform === "win32")(
  "handoff refuses a review whose working directory is a regular file",
  async () => {
    const reviewFile = join(root, "file.txt");
    await writeFile(reviewFile, "data");
    const source = new AgentQueueStore(join(root, "source-queues"));
    await source.enqueue("source", userMessage("pending", [reviewAttachment(reviewFile)]), NOW);
    await source.hold("source", "user_stop");
    await expect(source.exportForHandoff("source", { workspaceCwd: root })).rejects.toThrow(
      "not a directory",
    );
    expect(source.peek("source")?.entries).toHaveLength(1);
  },
);

test.skipIf(process.platform === "win32")(
  "handoff moves queued file bytes into the destination upload store before publishing the queue",
  async () => {
    const sourceHome = join(root, "source");
    const uploads = new FileUploadStore({ paseoHome: sourceHome });
    const source = new AgentQueueStore(join(sourceHome, "agent-queues"), { uploads });
    const id = "upload_00000000-0000-4000-8000-000000000001";
    const fileName = "queued.bin";
    const uploadPath = join(sourceHome, "uploads", id, fileName);
    await mkdir(join(sourceHome, "uploads", id), { recursive: true });
    const bytes = Buffer.from([0, 1, 128, 255]);
    await writeFile(uploadPath, bytes);
    const attachment = {
      type: "uploaded_file" as const,
      id,
      fileName,
      mimeType: "application/octet-stream",
      path: uploadPath,
      size: bytes.length,
    };
    await source.enqueue(
      "source-agent",
      userMessage("pending", [{ type: "text", text: "Read this file" }, attachment]),
      NOW,
    );
    await source.hold("source-agent", "user_stop");
    const blobsDirectory = join(sourceHome, "capture");
    const captured = await source.exportForHandoff("source-agent", { blobsDirectory });
    const destinationHome = join(root, "destination");
    const destination = new AgentQueueStore(join(destinationHome, "agent-queues"), {
      uploads: new FileUploadStore({ paseoHome: destinationHome }),
    });
    await destination.installHandoffQueue("destination-agent", "reservation", captured, {
      blobsDirectory,
    });
    await expect(
      destination.installHandoffQueue("destination-agent", "another-reservation", captured, {
        blobsDirectory,
      }),
    ).rejects.toThrow("different handoff");
    expect(readdirSync(join(destinationHome, "uploads"))).toHaveLength(1);
    expect(await destination.dequeueNext("destination-agent")).toBeNull();
    await destination.resume("destination-agent");
    const delivered = (await destination.dequeueNext("destination-agent"))?.prompt;
    if (!Array.isArray(delivered) || delivered[1].type !== "uploaded_file")
      throw new Error("Missing installed upload");
    expect(delivered[1].path.startsWith(destinationHome)).toBe(true);
    expect(await readFile(delivered[1].path)).toEqual(bytes);
    expect(delivered[1].path).not.toBe(uploadPath);
    await writeFile(uploadPath, Buffer.from([0, 1, 127, 255]));
    expect(await source.exportForHandoff("source-agent")).not.toEqual(captured);
  },
);

test.skipIf(process.platform === "win32")(
  "handoff installs the exact queued prompts held and retries after a destination restart",
  async () => {
    const source = new AgentQueueStore(join(root, "source"));
    await source.enqueue("source-agent", userMessage("first", "first pending instruction"), NOW);
    const prompt = [
      { type: "text" as const, text: "inspect this image" },
      { type: "image" as const, mimeType: "image/png", data: "aGVsbG8=" },
    ];
    await source.enqueue("source-agent", userMessage("second", prompt), NOW);
    await source.hold("source-agent", "user_stop");
    const exported = await source.exportForHandoff("source-agent");
    const destinationPath = join(root, "destination");
    let destination = new AgentQueueStore(destinationPath);
    await destination.installHandoffQueue("destination-agent", "reservation", exported);
    expect(destination.peek("destination-agent")).toMatchObject({
      held: true,
      heldReason: "user_stop",
    });
    expect(await destination.dequeueNext("destination-agent")).toBeNull();
    destination = new AgentQueueStore(destinationPath);
    await destination.load();
    await destination.holdForRestart("destination-agent");
    await destination.installHandoffQueue("destination-agent", "reservation", exported);
    expect(destination.peek("destination-agent")?.entries).toHaveLength(2);
    await expect(
      destination.installHandoffQueue("destination-agent", "other-reservation", exported),
    ).rejects.toThrow("different handoff");
    await destination.resume("destination-agent");
    const first = await destination.dequeueNext("destination-agent");
    expect(first?.prompt).toBe("first pending instruction");
    if (!first) throw new Error("Missing first prompt");
    await destination.discard("destination-agent", first.entry);
    expect((await destination.dequeueNext("destination-agent"))?.prompt).toEqual(prompt);
    expect((await source.exportForHandoff("source-agent")).entries).toHaveLength(2);
  },
);

test.skipIf(process.platform === "win32")(
  "a queue publication that reached disk but failed synchronization is unacknowledged and retryable",
  async () => {
    const snapshot = {
      version: 1 as const,
      entries: [
        {
          id: "pending",
          origin: "user" as const,
          senderAgentId: null,
          createdAt: NOW,
          prompt: "keep this",
        },
      ],
    };
    const destination = new AgentQueueStore(root, {
      sync: async (file, directory) => {
        await syncFilePublication(file, directory);
        if (file === join(root, "target.json")) throw new Error("sync acknowledgement lost");
      },
    });
    await expect(
      destination.installHandoffQueue("target", "reservation", snapshot),
    ).rejects.toThrow("sync acknowledgement lost");
    expect(destination.peek("target")).toBeNull();
    const recovered = new AgentQueueStore(root);
    await recovered.installHandoffQueue("target", "reservation", snapshot);
    expect(recovered.peek("target")?.held).toBe(true);
    await expect(
      recovered.installHandoffQueue("target", "reservation", {
        ...snapshot,
        entries: [{ ...snapshot.entries[0], prompt: "different" }],
      }),
    ).rejects.toThrow("different handoff");
    expect(
      (await recovered.exportForHandoff("target")).entries.map((entry) => entry.prompt),
    ).toEqual(["keep this"]);
  },
);

test("handoff refuses a missing prompt and cache/disk disagreement instead of exporting less data", async () => {
  const store = new AgentQueueStore(root);
  const entry = await store.enqueue("source", userMessage("pending"), NOW);
  await store.hold("source", "user_stop");
  if (!entry.promptFile) throw new Error("Missing test prompt");
  rmSync(join(root, "source", entry.promptFile));
  await expect(store.exportForHandoff("source")).rejects.toMatchObject({ code: "ENOENT" });
  writeFileSync(join(root, "source", entry.promptFile), JSON.stringify("text of pending"));
  rmSync(join(root, "source.json"));
  await expect(store.exportForHandoff("source")).rejects.toThrow("differ from durable storage");
});

test("handoff refuses unportable queue entries and oversized snapshot files", async () => {
  const store = new AgentQueueStore(root);
  await store.enqueue("delegation", wake("pending-wake", 1), NOW);
  await store.hold("delegation", "user_stop");
  await expect(store.exportForHandoff("delegation")).rejects.toThrow(
    "notifications or delegations",
  );
  await store.enqueue(
    "file",
    userMessage("pending-file", [
      {
        type: "uploaded_file",
        id: "upload",
        fileName: "local.txt",
        mimeType: "text/plain",
        size: 1,
        path: "/source-only/local.txt",
      },
    ]),
    NOW,
  );
  await store.hold("file", "user_stop");
  await expect(store.exportForHandoff("file")).rejects.toThrow("source-local files or paths");
  const oversized = join(root, "oversized.json");
  await writeFile(oversized, "");
  await truncate(oversized, HANDOFF_QUEUE_MAX_BYTES + 1);
  await expect(readHandoffQueue(oversized)).rejects.toThrow("file size");
});

test("enqueue writes one queue file per agent with positions, and the prompt in a sidecar", async () => {
  const store = new AgentQueueStore(root);
  const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
  await store.enqueue("agent-1", userMessage("m1"), NOW);
  const second = await store.enqueue(
    "agent-1",
    userMessage("m2", [{ type: "text", text: "look at this" }, image]),
    NOW,
  );

  const expectedSecond: AgentQueueEntry = {
    id: "m2",
    origin: "user",
    senderAgentId: null,
    position: 2,
    createdAt: NOW,
    textPreview: "look at this",
    attachmentCount: 1,
    promptFile: second.promptFile,
    wake: null,
  };
  expect(second).toEqual(expectedSecond);
  expect(readQueueFile("agent-1")).toEqual({
    version: 1,
    agentId: "agent-1",
    held: false,
    heldReason: null,
    entries: [
      {
        id: "m1",
        origin: "user",
        senderAgentId: null,
        position: 1,
        createdAt: NOW,
        textPreview: "text of m1",
        attachmentCount: 0,
        promptFile: expect.any(String),
        wake: null,
      },
      expectedSecond,
    ],
  });
  expect(readFileSync(join(root, "agent-1.json"), "utf8")).not.toContain(image.data);

  const first = await store.dequeueNext("agent-1");
  expect(first?.prompt).toBe("text of m1");
  const next = await store.dequeueNext("agent-1");
  expect(next?.prompt).toEqual([{ type: "text", text: "look at this" }, image]);
});

test("delegation wakes are delivered before user messages, then by position", async () => {
  const store = new AgentQueueStore(root);
  await store.enqueue("agent-1", userMessage("m1"), NOW);
  await store.enqueue("agent-1", wake("wake-1", 1), NOW);
  await store.enqueue("agent-1", userMessage("m2"), NOW);
  await store.enqueue("agent-1", wake("wake-2", 2), NOW);

  expect(await drainIds(store, "agent-1")).toEqual(["wake-1", "wake-2", "m1", "m2"]);
});

test("an empty user-stop hold survives restart and blocks later queued work until explicit resume", async () => {
  const writer = new AgentQueueStore(root);
  await writer.hold("agent-1", "user_stop");
  const recovered = new AgentQueueStore(root);
  await recovered.load();
  await recovered.holdForRestart("agent-1");
  await recovered.enqueue("agent-1", userMessage("later"), NOW);
  expect(await recovered.dequeueNext("agent-1")).toBeNull();
  expect(recovered.peek("agent-1")).toMatchObject({ held: true });
  await recovered.resume("agent-1");
  expect((await recovered.dequeueNext("agent-1"))?.prompt).toBe("text of later");
});

test("reviving future wakes preserves held entries across restart and retiring the last entry", async () => {
  const store = new AgentQueueStore(root);
  await store.enqueue("agent-1", userMessage("pending"), NOW);
  await store.hold("agent-1", "user_stop");
  await store.releaseUserStop("agent-1");
  const recovered = new AgentQueueStore(root);
  await recovered.load();
  expect(recovered.peek("agent-1")).toMatchObject({ held: true, userStopped: false });
  expect(await recovered.dequeueNext("agent-1")).toBeNull();
  await recovered.take("agent-1", "pending");
  expect(recovered.peek("agent-1")).toBeNull();
  const restarted = new AgentQueueStore(root);
  await restarted.load();
  expect(restarted.peek("agent-1")).toBeNull();
});

test("removing the last notification keeps user Stop, while explicit clear retires it", async () => {
  const store = new AgentQueueStore(root);
  await store.hold("agent-1", "user_stop");
  await store.enqueue("agent-1", wake("wake", 1), NOW);
  await store.take("agent-1", "wake");
  const recovered = new AgentQueueStore(root);
  await recovered.load();
  expect(recovered.peek("agent-1")).toMatchObject({ userStopped: true, held: true, entries: [] });
  await recovered.clear("agent-1");
  const restarted = new AgentQueueStore(root);
  await restarted.load();
  expect(restarted.peek("agent-1")).toBeNull();
});

test.skipIf(process.platform === "win32")(
  "an empty destination queue is durably stopped and exact installation retries cannot revive it",
  async () => {
    const destination = new AgentQueueStore(root);
    const snapshot = { version: 1 as const, entries: [] };
    await destination.installHandoffQueue("target", "reservation", snapshot);
    const recovered = new AgentQueueStore(root);
    await recovered.load();
    await recovered.holdForRestart("target");
    await recovered.installHandoffQueue("target", "reservation", snapshot);
    expect(recovered.peek("target")).toMatchObject({ userStopped: true, held: true, entries: [] });
    await recovered.enqueue("target", wake("late", 1), NOW);
    expect(await recovered.dequeueNext("target")).toBeNull();
    await expect(recovered.installHandoffQueue("target", "reservation", snapshot)).rejects.toThrow(
      "changed during handoff installation",
    );
  },
);

test.skipIf(process.platform === "win32")(
  "a failed user-stop publication is not acknowledged and can be repaired without reopening work",
  async () => {
    let fail = true;
    const store = new AgentQueueStore(root, {
      sync: async (file, directory) => {
        if (fail) throw new Error("hold fsync failed");
        await syncFilePublication(file, directory);
      },
    });
    await expect(store.hold("agent-1", "user_stop")).rejects.toThrow("hold fsync failed");
    expect(store.peek("agent-1")).toBeNull();
    fail = false;
    await store.hold("agent-1", "user_stop");
    const recovered = new AgentQueueStore(root);
    await recovered.load();
    expect(recovered.peek("agent-1")).toMatchObject({ userStopped: true, held: true });
  },
);

test.skipIf(process.platform === "win32")(
  "an older private queue installation adopts Stop but a subsequently revived queue cannot be overwritten",
  async () => {
    const snapshot = {
      version: 1 as const,
      entries: [
        {
          id: "pending",
          origin: "user" as const,
          senderAgentId: null,
          createdAt: NOW,
          prompt: "keep this",
        },
      ],
    };
    const store = new AgentQueueStore(root);
    await store.installHandoffQueue("target", "reservation", snapshot);
    const legacy = structuredClone(store.peek("target"));
    if (!legacy) throw new Error("Missing installed queue");
    delete legacy.userStopped;
    legacy.heldReason = "restart";
    await writeFile(join(root, "target.json"), JSON.stringify(legacy));
    const recovered = new AgentQueueStore(root);
    await recovered.load();
    await recovered.installHandoffQueue("target", "reservation", snapshot);
    expect(recovered.isHeldForUserStop("target")).toBe(true);
    await recovered.releaseUserStop("target");
    await expect(recovered.installHandoffQueue("target", "reservation", snapshot)).rejects.toThrow(
      "changed during handoff installation",
    );
    expect(recovered.peek("target")).toMatchObject({ held: true, userStopped: false });
  },
);

test("a failure hold delivers nothing, keeps later entries held, and stops holding once empty", async () => {
  const store = new AgentQueueStore(root);
  expect(await store.hold("agent-1", "failure")).toBe(false);

  await store.enqueue("agent-1", userMessage("m1"), NOW);
  expect(await store.hold("agent-1", "failure")).toBe(true);
  await store.enqueue("agent-1", wake("wake-1", 1), NOW);

  expect(await store.dequeueNext("agent-1")).toBeNull();
  expect(store.peek("agent-1")).toMatchObject({ held: true, heldReason: "failure" });

  await store.take("agent-1", "m1");
  await store.take("agent-1", "wake-1");
  expect(store.peek("agent-1")).toBeNull();
  await store.enqueue("agent-1", userMessage("m2"), NOW);
  expect(store.peek("agent-1")).toMatchObject({ held: false, heldReason: null });

  await store.hold("agent-1", "user_stop");
  expect(await store.resume("agent-1")).toBe(true);
  expect(await drainIds(store, "agent-1")).toEqual(["m2"]);
});

test("reorder moves the listed entries to the front and rejects unknown ids", async () => {
  const store = new AgentQueueStore(root);
  for (const id of ["m1", "m2", "m3", "m4"]) {
    await store.enqueue("agent-1", userMessage(id), NOW);
  }

  expect(await store.reorder("agent-1", ["m3", "missing"])).toBe(false);
  expect(await store.reorder("agent-1", ["m4", "m2"])).toBe(true);

  expect(await drainIds(store, "agent-1")).toEqual(["m4", "m2", "m1", "m3"]);
});

test("edit replaces the text, keeps images, and deletes the old prompt", async () => {
  const store = new AgentQueueStore(root);
  const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
  const original = await store.enqueue(
    "agent-1",
    userMessage("m1", [{ type: "text", text: "first" }, image]),
    NOW,
  );

  const edited = await store.edit("agent-1", "m1", "second");

  expect(edited).toMatchObject({ id: "m1", textPreview: "second", attachmentCount: 1 });
  expect(readdirSync(join(root, "agent-1"))).toEqual([edited?.promptFile]);
  expect(edited?.promptFile).not.toBe(original.promptFile);
  expect((await store.dequeueNext("agent-1"))?.prompt).toEqual([
    { type: "text", text: "second" },
    image,
  ]);
  expect(await store.edit("agent-1", "m1", "gone")).toBeNull();
});

test("load restores queues from disk and removes prompts nothing references", async () => {
  const writer = new AgentQueueStore(root);
  await writer.enqueue("agent-1", userMessage("m1"), NOW);
  await writer.hold("agent-1", "restart");
  writeFileSync(join(root, "agent-1", "orphan.json"), JSON.stringify("lost"));

  const reader = new AgentQueueStore(root);
  await reader.load();

  expect(reader.agentIds()).toEqual(["agent-1"]);
  expect(reader.peek("agent-1")).toMatchObject({ held: true, heldReason: "restart" });
  expect(readdirSync(join(root, "agent-1"))).toHaveLength(1);
  await reader.resume("agent-1");
  expect((await reader.dequeueNext("agent-1"))?.prompt).toBe("text of m1");
});

test("a prompt over the size cap is rejected before anything is written", async () => {
  const store = new AgentQueueStore(root);
  const huge = "x".repeat(33 * 1024 * 1024);

  await expect(store.enqueue("agent-1", userMessage("m1", huge), NOW)).rejects.toBeInstanceOf(
    QueueEntryTooLargeError,
  );
  expect(readdirSync(root)).toEqual([]);
});

test("a restart drops process-bound system entries and holds the rest", async () => {
  const store = new AgentQueueStore(root);
  await store.enqueue("agent-1", userMessage("m1"), NOW);
  await store.enqueue(
    "agent-1",
    { ...wake("perm:child:req-1", 0), origin: "system", wake: null },
    NOW,
  );
  await store.enqueue("agent-1", wake("wake-1", 1), NOW);
  await store.enqueue(
    "agent-2",
    { ...wake("perm:child:req-2", 0), origin: "system", wake: null },
    NOW,
  );

  expect((await store.holdForRestart("agent-1")).map((entry) => entry.id)).toEqual([
    "perm:child:req-1",
  ]);
  await store.holdForRestart("agent-2");

  expect(store.peek("agent-1")).toMatchObject({
    held: true,
    heldReason: "restart",
    entries: [{ id: "m1" }, { id: "wake-1" }],
  });
  expect(store.peek("agent-2")).toBeNull();
});
