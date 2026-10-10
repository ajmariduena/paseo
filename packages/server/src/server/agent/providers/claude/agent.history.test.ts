import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentStreamEvent, AgentTimelineItem } from "../../agent-sdk-types.js";
import { ClaudeAgentClient, extractUserMessageText } from "./agent.js";
import { claudeProjectDirSync, claudeTranscriptPathSync } from "./project-dir.js";
import {
  captureClaudeSession,
  installClaudeSession,
  readClaudeSessionArchive,
  verifyCapturedClaudeSession,
} from "./handoff.js";

describe("extractUserMessageText", () => {
  test("returns trimmed string content", () => {
    expect(extractUserMessageText("  Hello world  ")).toBe("Hello world");
  });

  test("combines multiple text blocks", () => {
    const content = [
      { type: "text", text: "First line" },
      { type: "text", text: "Second line" },
    ];

    expect(extractUserMessageText(content)).toBe("First line\n\nSecond line");
  });

  test("returns Claude slash command prompts without transcript tags", () => {
    const content =
      "<command-message>diagnose</command-message>\n<command-name>/diagnose</command-name>\n<command-args>recently the PR data does not update</command-args>";

    expect(extractUserMessageText(content)).toBe("/diagnose recently the PR data does not update");
  });

  test("returns the Claude slash command prompt when no args were recorded", () => {
    const content =
      "<command-message>caveman:caveman</command-message>\n<command-name>/caveman:caveman</command-name>";

    expect(extractUserMessageText(content)).toBe("/caveman:caveman");
  });

  test("returns null when no textual content is present", () => {
    const content = [
      { type: "image", source: "foo.png" },
      { type: "file", path: "bar.txt" },
    ];

    expect(extractUserMessageText(content)).toBeNull();
  });
});

describe("Claude history replay of prompts absorbed mid-turn", () => {
  const SESSION_ID = "3da1cf01-108a-4e4b-a182-a9ff6523ef98";
  const STEERED_WAKE =
    '<paseo-system>\nDelegated task dlg_0c229bda (agent 12f4881e, "Haiku A") finished.\n\n<agent-response>\nLos pulpos tienen nueve cerebros.\n</agent-response>\n</paseo-system>';
  const QUEUED_WAKE =
    '<paseo-system>\nDelegated task dlg_0d332576 (agent 6229f4ce, "Haiku B") finished.\n\n<agent-response>\nLos pulpos tienen tres corazones.\n</agent-response>\n</paseo-system>';

  let tempRoot: string;
  let cwd: string;
  let configDir: string;

  // Recorded by Claude Code 2.1.288 for a Paseo wake steered into a running turn: the prompt is
  // never written as a user record, only as this attachment after the queue removal.
  const transcript = [
    { type: "queue-operation", operation: "enqueue", sessionId: SESSION_ID },
    {
      type: "queue-operation",
      operation: "remove",
      sessionId: SESSION_ID,
      reason: "absorbed_mid_turn",
      commandUuid: "b5877015-ec20-4b25-bb6b-c2cb97cdde49",
      deliveryId: "9e2d03be-cf05-4c11-91a0-fb0314744d63",
    },
    {
      parentUuid: "d08674ff-e1ab-4f0d-81b3-16d5ab3a0334",
      isSidechain: false,
      attachment: {
        type: "queued_command",
        prompt: [{ type: "text", text: STEERED_WAKE }],
        source_uuid: "b5877015-ec20-4b25-bb6b-c2cb97cdde49",
        delivery_id: "9e2d03be-cf05-4c11-91a0-fb0314744d63",
        commandMode: "prompt",
        timestamp: "2026-10-04T23:09:35.747Z",
      },
      type: "attachment",
      uuid: "10ae3b60-809e-44c7-9bd6-bc2003d9d20c",
      timestamp: "2026-10-04T23:09:35.747Z",
      rendered: [
        {
          content: [
            {
              type: "text",
              text: `<system-reminder>\nThe user sent a new message while you were working:\n${STEERED_WAKE}\n</system-reminder>`,
            },
          ],
        },
      ],
      renderedRole: "system",
      sessionId: SESSION_ID,
    },
    {
      type: "attachment",
      uuid: "peer-message",
      timestamp: "2026-10-04T23:09:36.000Z",
      attachment: {
        type: "queued_command",
        prompt: "<cross-session-message>coordination</cross-session-message>",
        commandMode: "prompt",
        isMeta: true,
        origin: { kind: "peer" },
      },
      sessionId: SESSION_ID,
    },
    {
      type: "attachment",
      uuid: "task-notification",
      timestamp: "2026-10-04T23:09:37.000Z",
      attachment: {
        type: "queued_command",
        prompt: "<task-notification>\n<task-id>b1</task-id>\n</task-notification>",
        commandMode: "task-notification",
      },
      sessionId: SESSION_ID,
    },
    {
      type: "user",
      uuid: "queued-wake-user",
      timestamp: "2026-10-04T23:09:49.515Z",
      sessionId: SESSION_ID,
      message: { role: "user", content: QUEUED_WAKE },
    },
  ];

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(os.tmpdir(), "claude-steered-history-"));
    cwd = path.join(tempRoot, "repo");
    configDir = path.join(tempRoot, "claude-config");
    mkdirSync(cwd, { recursive: true });
    const historyDir = claudeProjectDirSync(cwd, { configDir });
    mkdirSync(historyDir, { recursive: true });
    writeFileSync(
      path.join(historyDir, `${SESSION_ID}.jsonl`),
      transcript.map((record) => JSON.stringify(record)).join("\n"),
      "utf8",
    );
    vi.stubEnv("CLAUDE_CONFIG_DIR", configDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("replays a steered prompt as the user message it was sent as", async () => {
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory: vi.fn(() => {
        throw new Error("history replay must not start a query");
      }),
      resolveBinary: async () => "/test/claude/bin",
    });
    const session = await client.resumeSession(
      { provider: "claude", sessionId: SESSION_ID, nativeHandle: SESSION_ID },
      { cwd },
    );
    const events: AgentStreamEvent[] = [];
    try {
      for await (const event of session.streamHistory()) events.push(event);
    } finally {
      await session.close();
    }

    const userMessages = events.flatMap((event): AgentTimelineItem[] =>
      event.type === "timeline" && event.item.type === "user_message" ? [event.item] : [],
    );
    expect(userMessages).toEqual([
      {
        type: "user_message",
        text: STEERED_WAKE,
        messageId: "b5877015-ec20-4b25-bb6b-c2cb97cdde49",
      },
      { type: "user_message", text: QUEUED_WAKE, messageId: "queued-wake-user" },
    ]);
  });
});

describe("Claude native session archives", () => {
  let root: string;
  let sessionId: string;
  let configDir: string;
  let cwd: string;
  let project: string;
  let transcript: string;
  let artifactDirectory: string;
  const cliVersion = "2.1.295";
  const limits = { maxFileBytes: 4096, maxTotalBytes: 8192, maxFiles: 10 };

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "claude-session-archive-"));
    sessionId = randomUUID();
    configDir = path.join(root, "source-home");
    cwd = path.join(root, "source");
    mkdirSync(cwd);
    project = claudeProjectDirSync(cwd, { configDir });
    mkdirSync(project, { recursive: true });
    transcript = path.join(project, `${sessionId}.jsonl`);
    artifactDirectory = path.join(root, "archive");
    writeFileSync(
      transcript,
      [
        {
          type: "user",
          sessionId,
          uuid: randomUUID(),
          timestamp: "2026-10-09T10:00:00Z",
          message: { role: "user", content: "Remember original history" },
        },
        {
          type: "assistant",
          sessionId,
          uuid: randomUUID(),
          timestamp: "2026-10-09T10:00:01Z",
          opaqueProviderField: { preserve: true },
          message: { role: "assistant", content: [{ type: "text", text: "original history" }] },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function source() {
    return {
      handle: {
        provider: "claude" as const,
        sessionId,
        metadata: {
          cwd,
          systemPrompt: "SOURCE POLICY MUST NOT MIGRATE",
          mcpServers: { source: { command: "do-not-run" } },
        },
      },
      cwd,
      configDir,
      cliVersion,
      artifactDirectory,
      limits,
    };
  }
  function destination() {
    return {
      artifactDirectory,
      configDir: path.join(root, "destination-home"),
      cwd: path.join(root, "destination"),
      importId: randomUUID(),
      cliVersion,
      limits,
    };
  }
  function sidechain(name = "agent-child.jsonl") {
    const directory = path.join(project, sessionId, "subagents");
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, name);
    writeFileSync(
      file,
      JSON.stringify({
        type: "assistant",
        sessionId,
        message: { role: "assistant", content: [{ type: "text", text: "child history" }] },
      }),
    );
    return file;
  }

  test("preserves raw transcripts and sidechains, retries inactive install, and reads history without a runtime", async () => {
    const child = sidechain();
    writeFileSync(path.join(configDir, ".credentials.json"), "secret-not-transferable");
    const snapshot = await captureClaudeSession(source());
    expect(snapshot.files.map((file) => file.path)).toEqual([
      "session/subagents/agent-child.jsonl",
      "transcript.jsonl",
    ]);
    const input = destination();
    const stale = claudeProjectDirSync(input.cwd, { configDir: input.configDir });
    mkdirSync(stale, { recursive: true });
    writeFileSync(path.join(stale, `${sessionId}.jsonl`), "stale source copy");
    const handle = await installClaudeSession(input);
    expect(await installClaudeSession(input)).toEqual(handle);
    expect(handle).toEqual({
      provider: "claude",
      sessionId,
      nativeHandle: sessionId,
      metadata: {
        cwd: input.cwd,
        claudeProjectDirName: `paseo-handoff-${input.importId}`,
        claudeRuntime: { configDir: input.configDir, cliVersion },
      },
    });
    const installed = claudeProjectDirSync(input.cwd, {
      configDir: input.configDir,
      projectDirName: `paseo-handoff-${input.importId}`,
    });
    expect(readFileSync(path.join(installed, `${sessionId}.jsonl`))).toEqual(
      readFileSync(transcript),
    );
    expect(readFileSync(path.join(installed, sessionId, "subagents", "agent-child.jsonl"))).toEqual(
      readFileSync(child),
    );
    expect(readdirSync(input.configDir)).toEqual(["projects"]);
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      runtimeSettings: { env: { CLAUDE_CONFIG_DIR: input.configDir } },
      queryFactory: () => {
        throw new Error("Import history must not start a runtime");
      },
    });
    const session = await client.resumeSession(handle, { cwd: input.cwd });
    try {
      const history = await Array.fromAsync(session.streamHistory());
      expect(
        history.filter((event) => event.type === "timeline").map((event) => event.item),
      ).toContainEqual(
        expect.objectContaining({ type: "assistant_message", text: "original history" }),
      );
    } finally {
      await session.close();
    }
    expect(readFileSync(path.join(stale, `${sessionId}.jsonl`), "utf8")).toBe("stale source copy");
  });

  test("an exact namespace never falls back to a stale transcript", () => {
    const projectDirName = `paseo-handoff-${randomUUID()}`;
    expect(claudeTranscriptPathSync({ cwd, configDir, sessionId, projectDirName })).toBe(
      path.join(configDir, "projects", projectDirName, `${sessionId}.jsonl`),
    );
    expect(() => claudeProjectDirSync(cwd, { configDir, projectDirName: "../escape" })).toThrow(
      "Invalid Claude project directory",
    );
  });

  test("refuses to resume an imported session when its exact transcript disappeared", async () => {
    await captureClaudeSession(source());
    const input = destination();
    const handle = await installClaudeSession(input);
    const imported = path.join(
      input.configDir,
      "projects",
      `paseo-handoff-${input.importId}`,
      `${sessionId}.jsonl`,
    );
    rmSync(imported);
    const stale = claudeProjectDirSync(input.cwd, { configDir: input.configDir });
    mkdirSync(stale, { recursive: true });
    writeFileSync(path.join(stale, `${sessionId}.jsonl`), readFileSync(transcript));
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      runtimeSettings: { env: { CLAUDE_CONFIG_DIR: input.configDir } },
      queryFactory: () => {
        throw new Error("Must not start a runtime");
      },
    });
    await expect(client.resumeSession(handle, { cwd: input.cwd })).rejects.toThrow(
      "Imported Claude transcript is missing",
    );
  });

  test("detects source edits and added sidechains before release", async () => {
    await captureClaudeSession(source());
    await verifyCapturedClaudeSession(source());
    const original = readFileSync(transcript);
    writeFileSync(
      transcript,
      Buffer.concat([original, Buffer.from('{"type":"summary","summary":"later"}\n')]),
    );
    await expect(verifyCapturedClaudeSession(source())).rejects.toMatchObject({
      code: "source_changed",
    });
    writeFileSync(transcript, original);
    sidechain();
    await expect(verifyCapturedClaudeSession(source())).rejects.toMatchObject({
      code: "source_changed",
    });
  });

  test.each(["partial JSON", "wrong session", "invalid UTF-8"])(
    "refuses %s without losing the source",
    async (kind) => {
      let bytes: Buffer;
      if (kind === "partial JSON") bytes = Buffer.from('{"type":');
      else if (kind === "wrong session")
        bytes = Buffer.from(JSON.stringify({ type: "user", sessionId: randomUUID() }));
      else bytes = Buffer.from([0xff]);
      writeFileSync(transcript, bytes);
      await expect(captureClaudeSession(source())).rejects.toMatchObject({
        code: "invalid_artifact",
      });
      expect(readFileSync(transcript)).toEqual(bytes);
      expect(existsSync(artifactDirectory)).toBe(false);
    },
  );

  test("rejects corrupted blobs and keeps an existing imported session intact", async () => {
    const manifest = await captureClaudeSession(source());
    const input = destination();
    const blobPath = path.join(artifactDirectory, "blobs", manifest.files[0].blob.sha256);
    const bytes = readFileSync(blobPath);
    writeFileSync(blobPath, "tampered");
    await expect(installClaudeSession(input)).rejects.toMatchObject({ code: "invalid_artifact" });
    expect(readdirSync(path.join(input.configDir, "projects"))).toEqual([]);
    writeFileSync(blobPath, bytes);
    await installClaudeSession(input);
    const target = path.join(
      input.configDir,
      "projects",
      `paseo-handoff-${input.importId}`,
      `${sessionId}.jsonl`,
    );
    writeFileSync(target, "continued or externally changed");
    await expect(installClaudeSession(input)).rejects.toMatchObject({ code: "destination_exists" });
    expect(readFileSync(target, "utf8")).toBe("continued or externally changed");
  });

  test.each([
    "../escape.jsonl",
    "session/subagents/../../escape.jsonl",
    "session/subagents/a.jsonl/child.jsonl",
  ])("rejects invalid artifact path %s", async (value) => {
    const manifest = await captureClaudeSession(source());
    manifest.files.push({ path: value, blob: manifest.files[0].blob });
    writeFileSync(path.join(artifactDirectory, "manifest.json"), JSON.stringify(manifest));
    await expect(installClaudeSession(destination())).rejects.toMatchObject({
      code: "invalid_artifact",
    });
  });

  test("never replaces a namespace that lacks its import marker", async () => {
    await captureClaudeSession(source());
    const input = destination();
    const occupied = path.join(input.configDir, "projects", `paseo-handoff-${input.importId}`);
    mkdirSync(occupied, { recursive: true });
    writeFileSync(path.join(occupied, "unrelated.jsonl"), "keep me");
    await expect(installClaudeSession(input)).rejects.toMatchObject({ code: "destination_exists" });
    expect(readFileSync(path.join(occupied, "unrelated.jsonl"), "utf8")).toBe("keep me");
  });

  test("enforces receiver limits and refuses incompatible native versions", async () => {
    await captureClaudeSession(source());
    await expect(
      readClaudeSessionArchive(artifactDirectory, { ...limits, maxTotalBytes: 1 }),
    ).rejects.toMatchObject({ code: "limit_exceeded" });
    await expect(
      installClaudeSession({ ...destination(), cliVersion: "2.1.294" }),
    ).rejects.toMatchObject({ code: "native_incompatible" });
    await expect(
      installClaudeSession({ ...destination(), cliVersion: "2.1.296" }),
    ).rejects.toMatchObject({ code: "native_incompatible" });
  });

  test("preserves workflow artifacts but refuses to reactivate their automation implicitly", async () => {
    const directory = path.join(project, sessionId, "workflows");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, "workflow.json"),
      JSON.stringify({ state: "running", opaque: true }),
    );
    const manifest = await captureClaudeSession(source());
    expect(manifest.files.map((file) => file.path)).toEqual([
      "session/workflows/workflow.json",
      "transcript.jsonl",
    ]);
    await expect(installClaudeSession(destination())).rejects.toMatchObject({
      code: "native_incompatible",
    });
  });

  test.skipIf(process.platform === "win32")(
    "refuses session symlinks instead of exporting unrelated files",
    async () => {
      const child = sidechain();
      rmSync(child);
      const secret = path.join(root, "secret");
      writeFileSync(secret, "never export");
      symlinkSync(secret, child);
      await expect(captureClaudeSession(source())).rejects.toMatchObject({
        code: "invalid_artifact",
      });
      expect(existsSync(artifactDirectory)).toBe(false);
    },
  );
});
