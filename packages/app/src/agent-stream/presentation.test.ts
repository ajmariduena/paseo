import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { runPluginClientBundle, type PluginClientRuntime } from "@/plugins/evaluate";
import type { InstalledPlugin } from "@/plugins/types";
import {
  applyStreamEvent,
  hydrateStreamState,
  type AgentToolCallStatus,
  type StreamItem,
  type ToolCallItem,
  type UserMessageItem,
} from "@/types/stream";
import { transformTimelineItem, type TimelineItemTransform } from "@/plugins/timeline/model";
import { createStreamPresentation } from "./presentation";
import { findCollapsedTurnFoldKey } from "./turn-fold";
import { buildAgentStreamRenderModel } from "./model";

const runtime = {
  paseo: {},
  async rpc() {},
  openSettings() {},
  openSurface() {},
  openPanel() {},
  addHeaderButton() {
    return { update() {}, remove() {} };
  },
  addComposerPill() {
    return { update() {}, remove() {} };
  },
} as unknown as PluginClientRuntime;

function installProbe(
  itemType: "assistant_message" | "tool_call" | "reasoning",
  condition = "true",
): InstalledPlugin {
  const clientBundle = `(function() {
    return { default: function(client) {
      client.addTimelineTransformer({
        id: "probe",
        query: { itemType: ${JSON.stringify(itemType)} },
        transform: function({ item, phase }) {
          if (!(${condition})) return undefined;
          return {
            items: [{
              type: "plugin",
              kind: "probe",
              version: 1,
              data: item.type === "tool_call"
                ? { callId: item.callId, name: item.name, status: item.status,
                    detail: item.detail, ...(item.metadata ? { metadata: item.metadata } : {}), error: item.error, phase: phase }
                : { text: item.text, phase: phase }
            }]
          };
        }
      });
      return function() {};
    } };
  })`;
  const evaluated = runPluginClientBundle("probe-plugin", clientBundle, runtime);
  return {
    ...evaluated,
    serverId: "host-1",
    clientBundle,
    lifetime: new AbortController(),
    queryClient: new QueryClient(),
    paseo: {} as InstalledPlugin["paseo"],
    invoke: async () => undefined,
  };
}

function installedTransform(plugin: InstalledPlugin): TimelineItemTransform {
  return (input) => transformTimelineItem({ ...input, plugins: [plugin] });
}

function toolCall(callId: string, name: string): ToolCallItem {
  return {
    kind: "tool_call",
    id: `tool-${callId}`,
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
    payload: {
      source: "agent",
      data: {
        provider: "codex",
        callId,
        name,
        status: "completed",
        error: null,
        detail: { type: "unknown", input: { callId }, output: { callId } },
      },
    },
  };
}

function pluginData(items: StreamItem[]): unknown[] {
  return items.flatMap((item) => (item.kind === "plugin" ? [item.data] : []));
}

const presentationOptions = { level: "overview" as const, isTurnActive: true };

function streamHarness(transform?: TimelineItemTransform) {
  let state: { tail: StreamItem[]; head: StreamItem[] } = { tail: [], head: [] };
  const present = createStreamPresentation();
  return {
    send(event: AgentStreamEventPayload) {
      state = applyStreamEvent({ ...state, event, timestamp: new Date(1000) });
      return this.render();
    },
    render(nextTransform = transform) {
      return present({ ...presentationOptions, ...state, transform: nextTransform });
    },
    source: () => state,
  };
}

function assistant(text: string, messageId = "message-1"): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider: "claude",
    item: { type: "assistant_message", messageId, text },
  };
}

function rows(result: { tail: StreamItem[]; head: StreamItem[] }): StreamItem[] {
  return [...result.tail, ...result.head];
}

describe("stream presentation through installed plugins", () => {
  it("offers every source tool call to an installed transformer in Overview mode", () => {
    const calls = [toolCall("call-1", "bash"), toolCall("call-2", "read")];
    const rendered = createStreamPresentation()({
      ...presentationOptions,
      tail: calls,
      head: [],
      transform: installedTransform(installProbe("tool_call")),
    });
    expect(pluginData([...rendered.tail, ...rendered.head])).toMatchObject([
      { callId: "call-1", name: "bash", phase: "complete" },
      { callId: "call-2", name: "read", phase: "complete" },
    ]);
  });

  it.each([
    { type: "turn_completed", provider: "claude" },
    { type: "turn_canceled", provider: "claude", reason: "test cancellation" },
    { type: "turn_failed", provider: "claude", error: "test failure" },
  ] satisfies AgentStreamEventPayload[])(
    "streams accumulated assistant text with one identity through $type",
    (completion) => {
      const harness = streamHarness(installedTransform(installProbe("assistant_message")));
      const first = rows(harness.send(assistant("Header")));
      const fullText = "Header\n\n\n# Body\n\n```ts\nconst x = 1;\n\nconst y = 2;\n```\n";
      const live = rows(harness.send(assistant(fullText.slice("Header".length))));
      const completed = rows(harness.send(completion));

      expect(pluginData(first)).toEqual([{ text: "Header", phase: "streaming" }]);
      expect(pluginData(live)).toEqual([{ text: fullText, phase: "streaming" }]);
      expect(pluginData(completed)).toEqual([{ text: fullText, phase: "complete" }]);
      expect(live.map((item) => item.id)).toEqual(first.map((item) => item.id));
      expect(completed.map((item) => item.id)).toEqual(first.map((item) => item.id));
      expect(rows(harness.source())).toMatchObject([{ kind: "assistant_message", text: fullText }]);
    },
  );

  it("finishes one message before streaming a different message ID", () => {
    const harness = streamHarness(installedTransform(installProbe("assistant_message")));
    harness.send(assistant("First\n\nBody", "first"));
    const result = harness.send(assistant("Second", "second"));
    expect(pluginData(rows(result))).toEqual([
      { text: "First\n\nBody", phase: "complete" },
      { text: "Second", phase: "streaming" },
    ]);
    expect(new Set(rows(result).map((item) => item.id)).size).toBe(2);
  });

  it("lets a plugin claim the accumulated message after earlier text used native Markdown", () => {
    const harness = streamHarness();
    harness.send(assistant("Header\n\nBody"));
    const transform = installedTransform(
      installProbe("assistant_message", 'item.text.includes("Body")'),
    );
    expect(pluginData(rows(harness.render(transform)))).toEqual([
      { text: "Header\n\nBody", phase: "streaming" },
    ]);
    expect(rows(harness.render(transform))).toHaveLength(1);
    expect(rows(harness.render()).map((item) => item.kind)).toEqual([
      "assistant_message",
      "assistant_message",
    ]);
  });

  it("keeps completed native blocks stable while the last block grows and finishes", () => {
    const harness = streamHarness();
    const first = harness.send(assistant("Intro\n\n![Image](image.png)"));
    const growing = harness.send(assistant("\n\nAfter\n"));
    const last = harness.send(assistant("- item"));
    const completed = harness.send({ type: "turn_completed", provider: "claude" });
    expect(first.tail).toMatchObject([{ text: "Intro", blockIndex: 0 }]);
    expect(first.head).toMatchObject([{ text: "![Image](image.png)", blockIndex: 1 }]);
    expect(growing.tail[0]).toBe(first.tail[0]);
    expect(growing.tail[1]).toBe(first.head[0]);
    expect(last.tail).toBe(growing.tail);
    expect(last.head).toMatchObject([{ text: "After\n- item", blockIndex: 2 }]);
    expect(completed.tail).toEqual(rows(last));
    expect(completed.tail[2]).toBe(last.head[0]);
    expect(completed.head).toEqual([]);
  });

  it("keeps blank lines inside an open native code fence", () => {
    const harness = streamHarness();
    harness.send(assistant("Intro\n\n```ts\nconst a = 1;"));
    const result = harness.send(assistant("\n\nconst b = 2;"));
    expect(result.tail).toMatchObject([{ text: "Intro" }]);
    expect(result.head).toMatchObject([{ text: "```ts\nconst a = 1;\n\nconst b = 2;" }]);
  });

  // Codex streams a line break and the next line's indent as their own chunks.
  it("keeps a line break when a chunk ends in the next line's indent", () => {
    const harness = streamHarness();
    harness.send(assistant("```mermaid\nflowchart TD\n    A[Start] --> B[Review]\n"));
    harness.send(assistant("   "));
    const result = harness.send(assistant(" B --> C[Finish]\n```"));
    expect(result.head).toMatchObject([
      { text: "```mermaid\nflowchart TD\n    A[Start] --> B[Review]\n    B --> C[Finish]\n```" },
    ]);
  });

  // One rendering path: a fetched message is the same block group as a streamed one,
  // which is what lets find, scroll-to-message and history reveal address it by id.
  // A link reference definition stays with the paragraph that uses it, so the split
  // never leaves an empty row behind and the reference still resolves.
  it("splits an assistant message into the same blocks through history and through the live head", () => {
    const source = hydrateStreamState([
      {
        event: assistant("[Link][docs]\n\n[docs]: https://example.com\n\nClosing paragraph."),
        timestamp: new Date(1000),
      },
    ]);
    const messageId = source[0]!.id;
    const present = (placement: "tail" | "head") =>
      rows(
        createStreamPresentation()({
          ...presentationOptions,
          tail: placement === "tail" ? source : [],
          head: placement === "head" ? source : [],
          transform: undefined,
        }),
      );
    expect(present("tail")).toMatchObject([
      {
        id: `${messageId}:block:0`,
        blockGroupId: messageId,
        blockIndex: 0,
        text: "[Link][docs]\n\n[docs]: https://example.com",
      },
      {
        id: `${messageId}:block:1`,
        blockGroupId: messageId,
        blockIndex: 1,
        text: "Closing paragraph.",
      },
    ]);
    const blocks = (items: StreamItem[]) =>
      items.map((item) => [item.id, item.kind === "assistant_message" ? item.text : null]);
    expect(blocks(present("head"))).toEqual(blocks(present("tail")));
  });

  // Rows are addressed by id from outside presentation, so the same text has to land on
  // the same ids whether the reader watched it arrive or opened the chat afterwards.
  it("gives a streamed message the block ids its hydrated text would have had", () => {
    const text = "Intro paragraph.\n\n# Heading\n\n- first\n- second\n\nClosing paragraph.";
    const harness = streamHarness();
    for (let end = 8; end < text.length; end += 8) {
      harness.send(assistant(text.slice(end - 8, end)));
    }
    harness.send(assistant(text.slice(text.length - (text.length % 8 || 8))));
    const streamed = rows(harness.send({ type: "turn_completed", provider: "claude" }));
    const hydrated = rows(
      createStreamPresentation()({
        ...presentationOptions,
        tail: hydrateStreamState([{ event: assistant(text), timestamp: new Date(1000) }]),
        head: [],
        transform: undefined,
      }),
    );
    expect(streamed.map((item) => item.id)).toEqual(hydrated.map((item) => item.id));
    expect(streamed.map((item) => item.kind === "assistant_message" && item.text)).toEqual(
      hydrated.map((item) => item.kind === "assistant_message" && item.text),
    );
  });

  it("repoints a block at the canonical source that replaced the streamed one", () => {
    const harness = streamHarness();
    harness.send(assistant("Streamed answer"));
    const streamed = rows(harness.render());
    expect(streamed[0]).not.toHaveProperty("timelineCursor");
    const source = harness.source();
    const live = source.head[0];
    if (live?.kind !== "assistant_message") throw new Error("Expected a live assistant message");
    const canonical = { ...live, timelineCursor: { epoch: "epoch-1", seq: 42 } };
    const present = createStreamPresentation();
    present({ ...presentationOptions, tail: [], head: [live], transform: undefined });
    const repointed = rows(
      present({ ...presentationOptions, tail: [], head: [canonical], transform: undefined }),
    );
    expect(repointed).toMatchObject([
      {
        id: streamed[0]!.id,
        text: "Streamed answer",
        timelineCursor: { epoch: "epoch-1", seq: 42 },
      },
    ]);
  });

  it("keeps a single-paragraph message a one-block group", () => {
    const source = hydrateStreamState([
      { event: assistant("Only one paragraph."), timestamp: new Date(1000) },
    ]);
    const messageId = source[0]!.id;
    const result = createStreamPresentation()({
      ...presentationOptions,
      tail: source,
      head: [],
      transform: undefined,
    });
    expect(result.tail).toMatchObject([
      {
        id: `${messageId}:block:0`,
        blockGroupId: messageId,
        blockIndex: 0,
        text: "Only one paragraph.",
      },
    ]);
    expect(result.tail[0]!.id).not.toBe(messageId);
  });

  it("continues to stream inline reasoning with a stable plugin row", () => {
    const harness = streamHarness(installedTransform(installProbe("reasoning")));
    const first = harness.send({
      type: "timeline",
      provider: "claude",
      item: { type: "reasoning", text: "First" },
    });
    const second = harness.send({
      type: "timeline",
      provider: "claude",
      item: { type: "reasoning", text: "\n\nSecond" },
    });
    const done = harness.send({ type: "turn_completed", provider: "claude" });
    expect(pluginData(rows(second))).toEqual([{ text: "First\n\nSecond", phase: "streaming" }]);
    expect(pluginData(rows(done))).toEqual([{ text: "First\n\nSecond", phase: "complete" }]);
    expect(rows(first)[0]?.id).toBe(rows(done)[0]?.id);
  });

  it("groups only unclaimed tools and passes unchanged tool details to the callback", () => {
    const calls = [
      toolCall("call-1", "read"),
      toolCall("call-2", "read"),
      toolCall("call-3", "bash"),
    ];
    const result = createStreamPresentation()({
      ...presentationOptions,
      isTurnActive: false,
      tail: calls,
      head: [],
      transform: installedTransform(installProbe("tool_call", 'item.name === "bash"')),
    });
    expect(result.groupsByHostId.get(result.tail[0]!.id)?.run.calls).toEqual(calls.slice(0, 2));
    expect(pluginData(rows(result))).toEqual([
      {
        callId: "call-3",
        name: "bash",
        status: "completed",
        error: null,
        detail: { type: "unknown", input: { callId: "call-3" }, output: { callId: "call-3" } },
        phase: "complete",
      },
    ]);
  });

  it.each([
    { status: "completed", error: null },
    { status: "failed", error: { message: "Command failed" } },
    { status: "canceled", error: null },
  ] as const)("keeps a tool card's identity and full payload through $status", (completion) => {
    const harness = streamHarness(installedTransform(installProbe("tool_call")));
    const source = {
      type: "tool_call" as const,
      callId: "call-1",
      name: "bash",
      detail: { type: "shell" as const, command: "pwd", cwd: "/repo" },
      metadata: { sequence: 1 },
    };
    const running = rows(
      harness.send({
        type: "timeline",
        provider: "claude",
        item: {
          ...source,
          status: "running",
          error: null,
        },
      }),
    );
    const terminalItem = { ...source, ...completion };
    const terminal = rows(
      harness.send({
        type: "timeline",
        provider: "claude",
        item: {
          ...terminalItem,
        },
      }),
    );
    expect(pluginData(running)).toMatchObject([
      { callId: "call-1", status: "running", phase: "streaming" },
    ]);
    expect(pluginData(terminal)).toEqual([
      {
        callId: source.callId,
        name: source.name,
        detail: source.detail,
        metadata: source.metadata,
        phase: "complete",
        status: completion.status,
        error: terminalItem.error,
      },
    ]);
    expect(terminal.map((item) => item.id)).toEqual(running.map((item) => item.id));
  });

  it("offers one complete live source assistant message to an installed transformer", () => {
    const sourceText =
      '[IMPORTANT: User invoked the "diagnose" skill; follow its instructions. Full skill below.]\n\n# Diagnose\n\nFind the root cause.';
    const event = {
      type: "timeline" as const,
      provider: "opencode" as const,
      item: { type: "assistant_message" as const, messageId: "message-1", text: sourceText },
    };
    const timestamp = new Date("2026-01-01T00:00:00.000Z");
    const transform = installedTransform(installProbe("assistant_message"));
    const present = createStreamPresentation();

    const fetched = hydrateStreamState([{ event, timestamp }]);
    const history = present({ ...presentationOptions, tail: fetched, head: [], transform });
    expect(pluginData(history.tail)).toEqual([{ text: sourceText, phase: "complete" }]);

    const stream = applyStreamEvent({
      tail: [],
      head: [],
      event,
      timestamp,
    });

    const rendered = present({ ...presentationOptions, ...stream, transform });
    expect(pluginData([...rendered.tail, ...rendered.head])).toEqual([
      { text: sourceText, phase: "streaming" },
    ]);
  });
});

function createTimestamp(seed: number): Date {
  return new Date(`2026-01-01T00:00:${seed.toString().padStart(2, "0")}.000Z`);
}

function userMessage(id: string, seed: number): UserMessageItem {
  return {
    kind: "user_message",
    id,
    text: id,
    timestamp: createTimestamp(seed),
  };
}

function assistantMessage(
  id: string,
  seed: number,
): Extract<StreamItem, { kind: "assistant_message" }> {
  return {
    kind: "assistant_message",
    id,
    text: id,
    timestamp: createTimestamp(seed),
  };
}

describe("timeline presentation", () => {
  const present = createStreamPresentation();
  const idleOptions = { ...presentationOptions, isTurnActive: false };
  function projectTimelineItems(items: StreamItem[], transform?: TimelineItemTransform) {
    return present({ ...idleOptions, tail: items, head: [], transform }).tail;
  }
  const envelope =
    "<spoken-input>\nPlease fix the voice chat.\n</spoken-input>\n<instruction>This message was spoken by the user. Respond using the speak tool only, not normal messages, because the user may not be looking at the chat.</instruction>";

  it.each(["live", "history"])(
    "shows only spoken words from a %s user message without mutating its source",
    (source) => {
      const item: UserMessageItem = Object.freeze({
        ...userMessage(source, 1),
        text: envelope,
        messageId: "provider-message",
        clientMessageId: "client-message",
        turnId: "turn-1",
        timelineCursor: { epoch: "epoch", seq: 12 },
      });
      const presentMessage = () =>
        present({
          ...idleOptions,
          tail: source === "history" ? [item] : [],
          head: source === "live" ? [item] : [],
          transform: undefined,
        });
      const projected = rows(presentMessage());
      expect(projected).toEqual([{ ...item, text: "Please fix the voice chat." }]);
      const model = buildAgentStreamRenderModel({
        tail: source === "history" ? projected : [],
        head: source === "live" ? projected : [],
        isTurnActive: source === "live",
        activeTurnStartedAt: item.timestamp,
        platform: "native",
        isMobileBreakpoint: true,
      });
      const rendered = [...model.history, ...model.segments.liveHead];
      expect(rendered).toContainEqual({ ...item, text: "Please fix the voice chat." });
      expect(item.text).toBe(envelope);
      expect(rows(presentMessage())[0]).toBe(projected[0]);
    },
  );

  it("supports older envelopes and preserves multiline spoken content", () => {
    const item = {
      ...userMessage("legacy", 1),
      text: "<spoken-input>\nFirst line.\nSecond line with <example>XML</example>.\n</spoken-input>",
    };
    expect(projectTimelineItems([item])).toEqual([
      { ...item, text: "First line.\nSecond line with <example>XML</example>." },
    ]);
  });

  it("leaves ordinary messages, assistant examples and incomplete wrappers unchanged", () => {
    const items: StreamItem[] = [
      userMessage("ordinary", 1),
      { ...assistantMessage("example", 2), text: envelope },
      { ...userMessage("incomplete", 3), text: "<spoken-input>unfinished" },
      { ...userMessage("quoted", 4), text: "Explain this example: " + envelope },
      {
        ...userMessage("xml", 5),
        text: "<spoken-input>Example</spoken-input><instruction>Explain this XML.</instruction>",
      },
    ];
    expect(projectTimelineItems(items)).toEqual(
      items.map((item) =>
        item.kind === "assistant_message"
          ? { ...item, id: `${item.id}:block:0`, blockGroupId: item.id, blockIndex: 0 }
          : item,
      ),
    );
    expect(projectTimelineItems(items)[0]).toBe(items[0]);
  });

  it("keeps plugin transforms on the original source and respects replacements", () => {
    const source: StreamItem = { ...userMessage("spoken", 1), text: envelope };
    const inputs: string[] = [];
    const transformed = projectTimelineItems([source], ({ item, sourceId }) => {
      if (item.type === "user_message") inputs.push(item.text);
      return [
        {
          type: "plugin",
          pluginId: "test",
          id: sourceId,
          kind: "voice",
          version: 1,
          data: { text: "Custom voice row" },
        },
      ];
    });
    expect(inputs).toEqual([envelope]);
    expect(transformed).toMatchObject([{ kind: "plugin", data: { text: "Custom voice row" } }]);
    expect(projectTimelineItems([source], () => undefined)).toEqual([
      { ...source, text: "Please fix the voice chat." },
    ]);
    expect(projectTimelineItems([source], () => [])).toEqual([]);
  });
});

describe("turn folding", () => {
  function workCall(
    id: string,
    seed: number,
    detail: ToolCallDetail,
    options: { name?: string; status?: AgentToolCallStatus } = {},
  ): ToolCallItem {
    return {
      kind: "tool_call",
      id,
      timestamp: createTimestamp(seed),
      payload: {
        source: "agent",
        data: {
          provider: "claude",
          callId: id,
          name: options.name ?? detail.type,
          status: options.status ?? "completed",
          error: null,
          detail,
        },
      },
    };
  }

  function notification(id: string, seed: number): Extract<StreamItem, { kind: "notification" }> {
    return {
      kind: "notification",
      sourceType: "notification",
      id,
      timestamp: createTimestamp(seed),
      level: "info",
      message: id,
    };
  }

  function thought(id: string, seed: number): StreamItem {
    return { kind: "thought", id, text: id, timestamp: createTimestamp(seed), status: "ready" };
  }

  function present(input: {
    tail: StreamItem[];
    head?: StreamItem[];
    isTurnActive?: boolean;
    expanded?: ReadonlySet<string>;
    level?: "overview" | "detailed";
    presentation?: ReturnType<typeof createStreamPresentation>;
  }) {
    return (input.presentation ?? createStreamPresentation())({
      level: input.level ?? "detailed",
      tail: input.tail,
      head: input.head ?? [],
      transform: undefined,
      isTurnActive: input.isTurnActive ?? false,
      expandedTurnFoldKeys: input.expanded,
    });
  }

  const ids = (items: StreamItem[]) => items.map((item) => item.id);
  const prompt = userMessage("prompt", 0);
  const work: StreamItem[] = [
    assistantMessage("note", 1),
    thought("thinking", 2),
    workCall("read", 3, { type: "read", filePath: "/repo/src/a.ts" }),
    workCall("edit", 4, {
      type: "edit",
      filePath: "/repo/src/a.ts",
      unifiedDiff: "@@ -1 +1,2 @@\n-old\n+new\n+added",
    }),
    workCall("shell", 5, { type: "shell", command: "npm test" }),
  ];
  const answer = assistantMessage("answer", 43);
  const turn = [prompt, ...work, answer];

  it("folds a finished turn into a header above its answer and a files card", () => {
    const result = present({ tail: turn });

    expect(ids(result.tail)).toEqual([
      "prompt",
      "prompt:turn-fold",
      "note:block:0",
      "answer:block:0",
      "prompt:turn-files",
    ]);
    expect(result.turnFolds.rowsById.get("prompt:turn-fold")).toMatchObject({
      role: "header",
      fold: {
        key: "prompt",
        state: "complete",
        expanded: false,
        durationMs: 43_000,
        stepCount: 3,
        summary: { editedFileCount: 1, commandCount: 1, readFileCount: 1 },
        files: [{ path: "/repo/src/a.ts", additions: 2, deletions: 1 }],
      },
    });
    expect(result.turnFolds.rowsById.get("prompt:turn-files")?.role).toBe("files");
  });

  it.each(["detailed", "overview"] as const)(
    "keeps a completed HTML render at its tool position in %s mode",
    (level) => {
      const render = workCall(
        "render",
        6,
        {
          type: "unknown",
          input: {},
          output: {
            htmlRender: {
              renderId: "550e8400-e29b-41d4-a716-446655440000",
              title: "Chart",
              height: 400,
            },
          },
        },
        { name: "mcp__paseo__html_render" },
      );
      const result = present({ tail: [prompt, ...work, render, answer], level });
      expect(ids(result.tail)).toContain("render");
      expect(ids(result.tail).indexOf("render")).toBeLessThan(
        ids(result.tail).indexOf("answer:block:0"),
      );
      expect(result.turnFolds.rowsById.get("prompt:turn-fold")?.fold.state).toBe("complete");
    },
  );

  it.each(["detailed", "overview"] as const)(
    "shows exactly the unfolded %s rows once expanded",
    (level) => {
      const expanded = present({ tail: turn, level, expanded: new Set(["prompt"]) });
      const unfolded = present({ tail: turn, level, isTurnActive: true });
      const withoutFoldRows = (items: StreamItem[]) =>
        ids(items).filter((id) => !id.endsWith(":turn-fold") && !id.endsWith(":turn-files"));

      expect(withoutFoldRows(expanded.tail)).toEqual(withoutFoldRows(unfolded.tail));
      expect(ids(expanded.tail).slice(0, 2)).toEqual(["prompt", "prompt:turn-fold"]);
      expect(ids(expanded.tail).at(-1)).toBe("prompt:turn-files");
    },
  );

  it.each([
    ["an error notification", { ...notification("failed", 6), level: "error" as const }],
    ["a system error message", { ...assistantMessage("failure", 44), text: "[System Error] boom" }],
    [
      "a canceled tool call",
      workCall("canceled", 6, { type: "shell", command: "sleep" }, { status: "canceled" }),
    ],
  ])("leaves a turn that ended with %s unfolded", (_, row) => {
    const tail = [prompt, ...work, row, answer];

    const result = present({ tail });

    const running = ids(present({ tail, isTurnActive: true }).tail);
    expect(ids(result.tail)).toEqual(running.filter((id) => id !== "prompt:turn-fold"));
    expect(result.turnFolds.folds).toEqual([]);
  });

  it("shows a live header above a running turn and folds it once the turn ends", () => {
    const running = present({ tail: turn, isTurnActive: true });

    const workRows = ["note:block:0", "thinking", "read", "edit", "shell"];
    expect(ids(running.tail)).toEqual([
      "prompt",
      "prompt:turn-fold",
      ...workRows,
      "answer:block:0",
    ]);
    expect(running.turnFolds.rowsById.get("prompt:turn-fold")?.fold.state).toBe("running");

    const streaming = present({ tail: turn.slice(0, -1), head: [answer] });
    expect(ids(streaming.tail)).toEqual(["prompt", ...workRows]);
  });

  it("keeps plans and warnings visible in a collapsed turn", () => {
    const plan = workCall("plan", 6, { type: "plan", text: "1. Fix it" }, { name: "update_plan" });
    const warning = { ...notification("careful", 7), level: "warning" as const };
    const tail = [prompt, ...work, plan, warning, answer];

    const result = present({ tail });

    expect(ids(result.tail)).toEqual([
      "prompt",
      "prompt:turn-fold",
      "note:block:0",
      "plan",
      "careful",
      "answer:block:0",
      "prompt:turn-files",
    ]);
  });

  it("keeps a subagent wake visible in a collapsed turn", () => {
    const wake: StreamItem = {
      ...notification("wake", 7),
      source: { kind: "subagent", subagents: [{ agentId: "child", reason: "finished" }] },
    };
    const tail = [prompt, ...work, wake, answer];

    const result = present({ tail });

    expect(ids(result.tail)).toEqual([
      "prompt",
      "prompt:turn-fold",
      "note:block:0",
      "wake",
      "answer:block:0",
      "prompt:turn-files",
    ]);
  });

  it("lets chat find open the fold that hides a message", () => {
    const collapsed = present({ tail: turn });
    expect(findCollapsedTurnFoldKey(collapsed.turnFolds, "thinking")).toBe("prompt");
    expect(findCollapsedTurnFoldKey(collapsed.turnFolds, "answer")).toBeNull();

    const expanded = present({ tail: turn, expanded: new Set(["prompt"]) });
    expect(findCollapsedTurnFoldKey(expanded.turnFolds, "thinking")).toBeNull();
    expect(ids(expanded.tail)).toContain("thinking");
  });

  it("keeps an answer visible when the agent runs a tool after it", () => {
    const reply = assistantMessage("reply", 40);
    const memoryWrite = workCall("memory", 41, { type: "write", filePath: "/m.md", content: "x" });
    const ack = assistantMessage("ack", 42);
    const tail = [
      prompt,
      workCall("search", 1, { type: "shell", command: "rg x" }),
      reply,
      memoryWrite,
      ack,
    ];

    const result = present({ tail });

    expect(ids(result.tail)).toEqual([
      "prompt",
      "prompt:turn-fold",
      "reply:block:0",
      "ack:block:0",
      "prompt:turn-files",
    ]);
  });

  it("remembers a fold under its timeline position", () => {
    const anchored = { ...prompt, timelineCursor: { epoch: "epoch-1", seq: 12 } };
    const tail = [anchored, ...work, answer];

    const result = present({ tail, expanded: new Set(["epoch-1:12"]) });

    expect(result.turnFolds.rowsById.get("prompt:turn-fold")?.fold).toMatchObject({
      key: "epoch-1:12",
      expanded: true,
    });
  });

  it("keeps fold row identity until what the fold shows changes", () => {
    const presentation = createStreamPresentation();
    const first = present({ tail: turn, presentation });
    const next = present({ tail: [...turn, userMessage("follow-up", 50)], presentation });
    const header = (result: typeof first) =>
      result.tail.find((item) => item.id === "prompt:turn-fold");

    expect(header(next)).toBe(header(first));

    const opened = present({
      tail: [...turn, userMessage("follow-up", 50)],
      expanded: new Set(["prompt"]),
      presentation,
    });
    expect(header(opened)).not.toBe(header(next));
  });
});
