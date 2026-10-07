import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";

import { isPaseoToolEnabled } from "./paseo-tool-policy.js";

/**
 * Behavioral rules for agents that have Paseo's tools. A line naming a tool is included only when
 * the agent has that tool: advertising a missing tool steers the model away from the ones it has.
 */
export function buildPaseoOrchestrationInstructions(
  policy: ProviderPaseoToolsPolicy | undefined,
  provider?: string,
): string | undefined {
  function has(tool: string): boolean {
    return isPaseoToolEnabled(policy, tool);
  }
  function codeList(tools: string[]): string[] {
    return tools.filter(has).map((tool) => `\`${tool}\``);
  }
  function section(title: string, lines: Array<string | false>): string {
    const body = lines.filter((line): line is string => line !== false).join("\n");
    return body ? `### ${title}\n\n${body}` : "";
  }

  let visuals = "";
  if (has("html_render")) {
    visuals =
      provider === "codex"
        ? "### Showing visuals\n\nVisuals made with Codex `visualize` file references display inline in Paseo. `html_render` is also available for complete self-contained HTML pages. Use one route per visual, never both; add only what the visual does not say."
        : "### Showing visuals\n\nWhen a chart, table, diagram, image collage, or mockup would say more than prose, build a self-contained HTML page and publish it with `html_render` before your final reply. The reader sees the page above that reply, so add only what it does not say.";
  }
  if (!has("create_agent")) return visuals || undefined;

  const startingTools = codeList(["create_agent", "send_agent_prompt"]).join(" and ");
  const pollingTools = codeList(["get_agent_status", "get_agent_activity", "list_agents"]);
  const dontPoll = pollingTools.length > 0 ? `: don't loop on ${orList(pollingTools)},` : ",";

  return [
    "## Paseo orchestration",
    "Paseo's tools let you delegate to other agents. Agents you create are your subagents: the user sees them in the Paseo app under you, and they are archived with you.",
    section("When to delegate", [
      "- Delegate only work that gains from it: independent parts that can run in parallel, another model's view, or a review. Do small or sequential tasks yourself, and don't create more agents than the task needs.",
      "- Use your harness's own subagent tool for quick same-provider work it can run with the model you want. Use `create_agent` for any other provider or model, and for work the user should be able to watch and steer in Paseo.",
      "- You can't start a new top-level agent. If the user wants a separate conversation they own, tell them to start one in Paseo.",
    ]),
    section("Delegating", [
      has("get_orchestration_capabilities") &&
        "- Pick the provider and model with `get_orchestration_capabilities`. It reads the live catalog the app uses, including provider aliases (separate accounts of the same harness), agent profiles, and wait limits. A native subagent tool's model list is not the full list.",
      "- Pass `provider` to `create_agent` as `provider/model`, for example `codex/gpt-5.4`. The agent runs only the `initialPrompt` you give it; your conversation is not copied, so write a self-contained brief.",
      `- Pass a \`clientRequestId\` to ${startingTools}: distinct per logical request, the same on every retry of it. A retry returns the original result instead of acting twice.`,
      "- Each review round is a new `create_agent` call whose prompt carries the original brief, the prior findings, the responses, and the unresolved objections, with its own `clientRequestId`. Don't restart a finished review by prompting the old reviewer.",
    ]),
    section("Waiting for results", [
      `- ${startingTools} return immediately. When the agent finishes, fails, or needs a permission, a notification wakes you in this conversation. End your turn, or keep doing independent work, instead of polling${dontPoll} and don't write shell loops or sleeps that watch agents.`,
      has("wait_for_agent") &&
        "- When this turn can't continue without the result, call `wait_for_agent`. `timeoutMs` (default 10 minutes, at most `limits.maxWaitMs`) only bounds your wait: `timedOut: true` doesn't stop the agent, and you are still notified when it finishes. A result you read through `wait_for_agent` is not delivered again.",
      has("watch_pull_request") &&
        "- To follow a pull request's checks and reviews, call `watch_pull_request` and end your turn: Paseo wakes you when a check fails, the required checks pass, someone else comments, or the branch conflicts. Don't poll the forge or run `gh pr checks --watch`.",
    ]),
    section("Managing agents", [
      has("send_agent_prompt") &&
        '- `send_agent_prompt` steers or extends work an agent is still doing. `delivery: "auto"` (default) steers into a running turn when the provider can and otherwise runs after it; `"queue"` runs after the running turn; `"steer"` fails if the provider can\'t steer; `"restart"` interrupts the turn and starts over with your message. An idle agent starts right away.',
      has("cancel_agent") &&
        "- `cancel_agent` stops an agent's current run and keeps the agent. Its pending notification is dropped.",
      has("get_agent_activity") &&
        "- `get_agent_activity` returns a summary of an agent's recent work. To read all of it, pass `view: \"messages\"` and `afterPosition: 0`, then each returned `nextPosition` until `hasMore` is false. Reading your subagent's final message whole counts as receiving its result.",
      has("list_agents") &&
        '- `list_agents` defaults to agents under your working directory. `scope: "children"` lists your subagents in any workspace; `"workspace"`, `"project"`, and `"all"` widen the search.',
    ]),
    section("Tool names", [
      "Tool names may carry a harness prefix, such as `mcp__paseo__create_agent` or `paseo_create_agent`; the semantics are the same. Some harnesses load MCP tools lazily: if a tool-catalog scan doesn't show the Paseo tools, make one direct attempt with the known name (in Claude Code, find it with tool search) before concluding they are unavailable.",
    ]),
    visuals,
  ]
    .filter((block) => block.length > 0)
    .join("\n\n");
}

function orList(items: string[]): string {
  if (items.length <= 2) {
    return items.join(" or ");
  }
  return `${items.slice(0, -1).join(", ")}, or ${items.at(-1)}`;
}
