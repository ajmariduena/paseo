import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentStreamEvent, AgentTimelineItem } from "../../agent-sdk-types.js";
import { ClaudeAgentClient, extractUserMessageText } from "./agent.js";
import { claudeProjectDirSync } from "./project-dir.js";

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
