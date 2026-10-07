import { describe, expect, test } from "vitest";

import { buildPaseoOrchestrationInstructions } from "./orchestration-instructions.js";

test("Codex visuals allow one of its file reference or Paseo's complete document tool", () => {
  const text = buildPaseoOrchestrationInstructions(undefined, "codex") ?? "";
  expect(text).toContain("Codex `visualize` file references display inline");
  expect(text).toContain("`html_render` is also available");
  expect(text).toContain("Use one route per visual, never both");
});

test("preview guidance appears only when the preview tool is attached", () => {
  expect(buildPaseoOrchestrationInstructions(undefined, "claude", true)).toContain(
    "check it with `html_preview`, then publish it",
  );
  expect(
    buildPaseoOrchestrationInstructions({ disabledTools: ["html_preview"] }, "claude", true),
  ).not.toContain("html_preview");
  expect(buildPaseoOrchestrationInstructions(undefined, "codex", true)).toContain(
    "Use one route per visual",
  );
});

describe("buildPaseoOrchestrationInstructions", () => {
  test("full text with every orchestration tool", () => {
    expect(buildPaseoOrchestrationInstructions(undefined)).toMatchInlineSnapshot(`
      "## Paseo orchestration

      Paseo's tools let you delegate to other agents. Agents you create are your subagents: the user sees them in the Paseo app under you, and they are archived with you.

      ### When to delegate

      - Delegate only work that gains from it: independent parts that can run in parallel, another model's view, or a review. Do small or sequential tasks yourself, and don't create more agents than the task needs.
      - Use your harness's own subagent tool for quick same-provider work it can run with the model you want. Use \`create_agent\` for any other provider or model, and for work the user should be able to watch and steer in Paseo.
      - You can't start a new top-level agent. If the user wants a separate conversation they own, tell them to start one in Paseo.

      ### Delegating

      - Pick the provider and model with \`get_orchestration_capabilities\`. It reads the live catalog the app uses, including provider aliases (separate accounts of the same harness), agent profiles, and wait limits. A native subagent tool's model list is not the full list.
      - Pass \`provider\` to \`create_agent\` as \`provider/model\`, for example \`codex/gpt-5.4\`. The agent runs only the \`initialPrompt\` you give it; your conversation is not copied, so write a self-contained brief.
      - Pass a \`clientRequestId\` to \`create_agent\` and \`send_agent_prompt\`: distinct per logical request, the same on every retry of it. A retry returns the original result instead of acting twice.
      - Each review round is a new \`create_agent\` call whose prompt carries the original brief, the prior findings, the responses, and the unresolved objections, with its own \`clientRequestId\`. Don't restart a finished review by prompting the old reviewer.

      ### Waiting for results

      - \`create_agent\` and \`send_agent_prompt\` return immediately. When the agent finishes, fails, or needs a permission, a notification wakes you in this conversation. End your turn, or keep doing independent work, instead of polling: don't loop on \`get_agent_status\`, \`get_agent_activity\`, or \`list_agents\`, and don't write shell loops or sleeps that watch agents.
      - When this turn can't continue without the result, call \`wait_for_agent\`. \`timeoutMs\` (default 10 minutes, at most \`limits.maxWaitMs\`) only bounds your wait: \`timedOut: true\` doesn't stop the agent, and you are still notified when it finishes. A result you read through \`wait_for_agent\` is not delivered again.
      - To follow a pull request's checks and reviews, call \`watch_pull_request\` and end your turn: Paseo wakes you when a check fails, the required checks pass, someone else comments, or the branch conflicts. Don't poll the forge or run \`gh pr checks --watch\`.
      - Call \`unwatch_pull_request\` when you hand the work back: the pull request merged or was abandoned, or the user takes over. Until then the user sees you as working in the background.

      ### Recurring work

      - \`create_heartbeat\` sends you a prompt in this conversation on a cron cadence. On each one, delegate the new work or skip what is already covered; don't start a duplicate of a subagent that is still running.
      - \`create_schedule\` starts a new agent on each run instead. Use it when every run should start fresh rather than come back to you.

      ### Managing agents

      - \`send_agent_prompt\` steers or extends work an agent is still doing. \`delivery: "auto"\` (default) steers into a running turn when the provider can and otherwise runs after it; \`"queue"\` runs after the running turn; \`"steer"\` fails if the provider can't steer; \`"restart"\` interrupts the turn and starts over with your message. An idle agent starts right away.
      - \`cancel_agent\` stops an agent's current run and the runs of every agent under it, and keeps the agents. Its pending notification is dropped.
      - \`get_agent_activity\` returns a summary of an agent's recent work. To read all of it, pass \`view: "messages"\` and \`afterPosition: 0\`, then each returned \`nextPosition\` until \`hasMore\` is false. Reading your subagent's final message whole counts as receiving its result.
      - \`list_agents\` defaults to agents under your working directory. \`scope: "children"\` lists your subagents in any workspace; \`"workspace"\`, \`"project"\`, and \`"all"\` widen the search.

      ### Tool names

      Tool names may carry a harness prefix, such as \`mcp__paseo__create_agent\` or \`paseo_create_agent\`; the semantics are the same. Some harnesses load MCP tools lazily: if a tool-catalog scan doesn't show the Paseo tools, make one direct attempt with the known name (in Claude Code, find it with tool search) before concluding they are unavailable.

      ### Showing visuals

      When a chart, table, diagram, image collage, or mockup would say more than prose, build a self-contained HTML page and publish it with \`html_render\` before your final reply. The reader sees the page above that reply, so add only what it does not say."
    `);
  });

  test("names no tool the agent doesn't have", () => {
    const disabledTools = [
      "send_agent_prompt",
      "wait_for_agent",
      "get_orchestration_capabilities",
      "get_agent_status",
      "get_agent_activity",
      "cancel_agent",
      "list_agents",
      "create_heartbeat",
      "create_schedule",
    ];

    const text = buildPaseoOrchestrationInstructions({ disabledTools }) ?? "";

    expect(text).toContain("`create_agent`");
    for (const tool of disabledTools) {
      expect(text).not.toContain(tool);
    }
    expect(text).not.toContain("### Managing agents");
    expect(text).not.toContain("### Recurring work");
  });

  test("keeps visual guidance when delegation is disabled", () => {
    expect(buildPaseoOrchestrationInstructions({ disabledTools: ["create_agent"] })).toContain(
      "### Showing visuals",
    );
    expect(buildPaseoOrchestrationInstructions({ enabled: false })).toBe(undefined);
  });
});
