/**
 * Direct SDK behavior tests - uses same setup as the Claude provider
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  canRunRealProvider,
  getRealProviderRuntimeSettings,
} from "../../../daemon-e2e/real-provider-test-config.js";
import { findExecutable } from "../../../../executable-resolution/executable-resolution.js";
import { claudeQuery } from "./query.js";
import { captureClaudeSession, installClaudeSession } from "./handoff.js";
import { ClaudeAgentClient, resolveClaudeCodeVersion } from "./agent.js";
import { claudeConfigDir, claudeTranscriptPathSync } from "./project-dir.js";
import { collectSessionTurnEvents } from "../test-utils/session-stream-adapter.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";

class Pushable<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolvers: Array<(value: IteratorResult<T, void>) => void> = [];
  private closed = false;

  push(item: T) {
    if (this.closed) return;
    if (this.resolvers.length > 0) {
      this.resolvers.shift()!({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  end() {
    this.closed = true;
    while (this.resolvers.length > 0) {
      this.resolvers.shift()!({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T, void> {
    return {
      next: (): Promise<IteratorResult<T, void>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

function tmpCwd(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sdk-behavior-"));
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

function rmCwd(cwd: string): void {
  try {
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") {
      throw error;
    }
  }
}

function extractTextFromEvents(events: SDKMessage[]): string {
  let responseText = "";
  for (const event of events) {
    if (event.type !== "assistant" || !("message" in event) || !event.message?.content) {
      continue;
    }
    const content = event.message.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content) {
      if (block.type === "text" && block.text) {
        responseText += block.text;
      }
    }
  }
  return responseText;
}

describe("Claude SDK direct behavior", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await canRunRealProvider("claude");
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("shows what happens after interrupt()", async () => {
    const cwd = tmpCwd();
    const input = new Pushable<SDKUserMessage>();
    const claudeBinary = await findExecutable("claude");

    // Use same options as the Claude provider
    const q = claudeQuery(
      {
        prompt: input,
        options: {
          cwd,
          includePartialMessages: true,
          permissionMode: "bypassPermissions",
          ...(claudeBinary ? { pathToClaudeCodeExecutable: claudeBinary } : {}),
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
          },
          settingSources: ["user", "project"],
        },
      },
      { runtimeSettings: getRealProviderRuntimeSettings("claude") },
    );

    try {
      // Send first message
      input.push({
        type: "user",
        message: { role: "user", content: "Say exactly: MESSAGE_ONE" },
        parent_tool_use_id: null,
        session_id: "",
      });

      // Collect events until we see assistant, then interrupt
      const msg1Events: SDKMessage[] = [];
      for await (const event of q) {
        msg1Events.push(event);

        if (event.type === "assistant") {
          // Push MSG2 BEFORE interrupt (like our wrapper does when a new message comes in)
          input.push({
            type: "user",
            message: { role: "user", content: "Say exactly: MESSAGE_TWO" },
            parent_tool_use_id: null,
            session_id: "",
          });
          await q.interrupt();
          break;
        }
        if (event.type === "result") {
          break;
        }
      }

      // MSG2 was already pushed before interrupt
      const msg2Events: SDKMessage[] = [];
      for await (const event of q) {
        msg2Events.push(event);

        if (event.type === "result") {
          break;
        }
      }

      // Analyze response
      const responseText = extractTextFromEvents(msg2Events);

      const sawResult = msg2Events.some((event) => event.type === "result");
      // The SDK may short-circuit after interrupt without a result event.
      expect(sawResult || responseText.length === 0).toBe(true);
    } finally {
      input.end();
      rmCwd(cwd);
    }
  }, 120000);
});

function getAssistantText(events: AgentStreamEvent[]): string {
  return events
    .flatMap((event) =>
      event.type === "timeline" && event.item.type === "assistant_message" ? [event.item.text] : [],
    )
    .join("");
}

test("native handoff resumes in another provider home and returns without selecting the stale session", async () => {
  const cliVersion = await resolveClaudeCodeVersion();
  const root = mkdtempSync(path.join(tmpdir(), "claude-native-handoff-"));
  const sourceCwd = path.join(root, "source");
  const destinationCwd = path.join(root, "destination");
  const returnCwd = path.join(root, "returned");
  const sourceHome = path.join(root, "source-home");
  const destinationHome = path.join(root, "destination-home");
  for (const directory of [sourceCwd, destinationCwd, returnCwd, sourceHome, destinationHome]) {
    mkdirSync(directory);
  }
  // Both isolated homes authenticate locally. Credentials are not part of the transferred artifacts.
  for (const configDir of [sourceHome, destinationHome]) {
    symlinkSync(
      path.join(claudeConfigDir(process.env), ".credentials.json"),
      path.join(configDir, ".credentials.json"),
    );
  }
  const makeClient = (configDir: string) =>
    new ClaudeAgentClient({
      logger: pino({ level: "warn" }),
      runtimeSettings: { env: { CLAUDE_CONFIG_DIR: configDir } },
    });
  const source = await makeClient(sourceHome).createSession({
    provider: "claude",
    model: "haiku",
    modeId: "bypassPermissions",
    cwd: sourceCwd,
  });
  const sessions = [source];
  try {
    const marker = randomUUID();
    const first = await collectSessionTurnEvents(
      source,
      `Remember this transfer token: ${marker}. Reply with the token. Do not write files or run tools.`,
    );
    expect(first.at(-1)?.type).toBe("turn_completed");
    expect(getAssistantText(first)).toContain(marker);
    const handle = await source.describePersistence();
    if (!handle) throw new Error("Claude did not persist its session");
    await source.close();
    const sourcePath = claudeTranscriptPathSync({
      cwd: sourceCwd,
      sessionId: handle.sessionId,
      configDir: sourceHome,
    });
    const sourceBytes = readFileSync(sourcePath);
    const artifactDirectory = path.join(root, "outbound-archive");
    await captureClaudeSession({
      handle,
      cwd: sourceCwd,
      configDir: sourceHome,
      cliVersion,
      artifactDirectory,
    });
    const importId = randomUUID();
    const importedHandle = await installClaudeSession({
      artifactDirectory,
      configDir: destinationHome,
      cwd: destinationCwd,
      importId,
      cliVersion,
    });
    expect(
      await installClaudeSession({
        artifactDirectory,
        configDir: destinationHome,
        cwd: destinationCwd,
        importId,
        cliVersion,
      }),
    ).toEqual(importedHandle);
    const destinationPath = claudeTranscriptPathSync({
      cwd: destinationCwd,
      sessionId: handle.sessionId,
      configDir: destinationHome,
      projectDirName: `paseo-handoff-${importId}`,
    });
    const destination = await makeClient(destinationHome).resumeSession(importedHandle, {
      provider: "claude",
      model: "haiku",
      modeId: "bypassPermissions",
      cwd: destinationCwd,
    });
    sessions.push(destination);
    const history = await Array.fromAsync(destination.streamHistory());
    expect(getAssistantText(history)).toContain(marker);
    expect(readFileSync(destinationPath)).toEqual(sourceBytes);
    const destinationMarker = randomUUID();
    const continued = await collectSessionTurnEvents(
      destination,
      `We moved to ${destinationCwd}. Using the transfer token from the prior conversation, write only that token into continued.txt in the current directory. Remember this return token: ${destinationMarker}. Reply with both tokens.`,
    );
    expect(continued.at(-1)?.type).toBe("turn_completed");
    expect(getAssistantText(continued)).toContain(marker);
    expect(readFileSync(path.join(destinationCwd, "continued.txt"), "utf8").trim()).toBe(marker);
    const continuedHandle = destination.describePersistence();
    expect(continuedHandle?.metadata?.claudeProjectDirName).toBe(`paseo-handoff-${importId}`);
    if (!continuedHandle) throw new Error("Continued session did not persist");
    await destination.close();
    expect(readFileSync(sourcePath)).toEqual(sourceBytes);
    const returnArchive = path.join(root, "return-archive");
    await captureClaudeSession({
      handle: continuedHandle,
      cwd: destinationCwd,
      configDir: destinationHome,
      cliVersion,
      artifactDirectory: returnArchive,
    });
    const returnedHandle = await installClaudeSession({
      artifactDirectory: returnArchive,
      configDir: sourceHome,
      cwd: returnCwd,
      importId: randomUUID(),
      cliVersion,
    });
    const returned = await makeClient(sourceHome).resumeSession(returnedHandle, {
      provider: "claude",
      model: "haiku",
      modeId: "bypassPermissions",
      cwd: returnCwd,
    });
    sessions.push(returned);
    const result = await collectSessionTurnEvents(
      returned,
      "Reply with the transfer token and return token from our prior conversation. Do not read files or run tools.",
    );
    expect(result.at(-1)?.type).toBe("turn_completed");
    expect(getAssistantText(result)).toContain(marker);
    expect(getAssistantText(result)).toContain(destinationMarker);
    await returned.close();
    expect(readFileSync(sourcePath)).toEqual(sourceBytes);
  } finally {
    for (const session of sessions) await session.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 180_000);
