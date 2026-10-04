---
name: paseo
description: Paseo reference for managing projects, workspaces, workspace scripts, agents, schedules, and heartbeats.
---

Paseo is a remote daemon that manages coding agents, terminals. Control it through MCP tools or the CLI.

## Projects

Manage the daemon's project registry through the CLI:

```bash
paseo project create [path]
paseo project ls
paseo project rename <project-id> <name>
paseo project rename <project-id> --reset
paseo project delete <project-id>
```

For a local daemon, `project create` defaults to the current directory and resolves relative paths on the CLI machine. With `--host` or `PASEO_HOST`, always provide a path; the target daemon interprets it on its own machine. Deleting a project archives its active workspaces and removes the project from Paseo without deleting the project directory.

## Workspaces

**`create_workspace`** — create a workspace independently of any agent. Required: `isolation` (`local` or `worktree`). Worktree isolation supports `mode: "branch-off" | "checkout-branch" | "checkout-pr"`: use `branchName`/`baseBranch` for a new branch, `branch` for an existing branch, or `prNumber` plus optional `forge`/`projectPath` for a change request. `worktreeSlug` controls the managed path. Returns the workspace descriptor centered on `workspaceId`.

Choose `baseBranch` explicitly: `origin/main` selects the remote-tracking branch; `refs/heads/main` selects local main. Bare `main` prefers local main when it exists, otherwise origin/main. Paseo retains the resolved ref for workspace comparisons, even after rebasing the branch or changing its PR target.

**`list_workspaces`** — list active workspaces.

**`archive_workspace`** — `{ workspaceId }`. Archives the workspace, its agents, and its terminals. Local directories remain; Paseo removes an owned worktree only after its final active workspace reference is archived.

**`rename_workspace`** — `{ workspaceId, name }`. Rename workspace.

## Workspace scripts

Configured `paseo.json` scripts use the same supervised lifecycle from tools and the CLI.

**`list_workspace_scripts`** — `{ workspaceId }`. Lists configured scripts with lifecycle, service port, proxy URLs, health, exit code, and terminal ID.

**`start_workspace_script`** — `{ workspaceId, scriptName }`. Starts one configured script through Paseo's managed workspace-script launcher and returns its status metadata.

**`stop_workspace_script`** — `{ workspaceId, scriptName }`. Stops a running script through its supervised terminal and returns the stopped status metadata.

The matching CLI surface accepts either an explicit workspace ID or resolves the current directory:

```bash
paseo script ls [--cwd <path> | --workspace <workspace-id>]
paseo script start <name> [--cwd <path> | --workspace <workspace-id>]
paseo script stop <name> [--cwd <path> | --workspace <workspace-id>]
```

## Agents

Agents with Paseo tools also get Paseo's orchestration instructions in their system prompt. Those own the behavior rules (when to delegate, waiting, retries); this section is the parameter reference.

**`create_agent`** — required: `title`, `provider` (`claude/opus`, `codex/gpt-5.4`, …), `initialPrompt`. Optional: `workspaceId`, `settings`, `labels`, `clientRequestId`, `notifyOnFinish`. Returns `{ agentId, workspaceId, … }`, plus `deduplicated: true` when a retry with the same `clientRequestId` returned the agent it already created.

Initial runtime settings live under `settings`: `modeId`, `thinkingOptionId`, and provider-specific `features`. Agent profiles are the preferred source for these values. For Codex fast mode, pass `settings: { features: { "fast_mode": true } }` when creating the agent.

Agent-scoped creation always creates your subagent. Omit `workspaceId` to use your current workspace; pass a workspace returned by `create_workspace` for isolated delegation. Placement never changes parentage.

Detach is an explicit user action in the subagents track, not an agent tool. A cross-workspace child remains your subagent even though it also appears as a normal tab in its workspace.

**`send_agent_prompt`** — `{ agentId, prompt }`, optional `delivery`, `clientRequestId`. `delivery` decides what happens when the agent is busy: `auto` (default for agents) steers into the running turn when the provider can and otherwise runs after it; `queue` runs after it; `steer` fails when the provider can't steer; `restart` interrupts the turn and starts over. Top-level callers default to `restart` and block; agent callers return at once (`background: true`). The result's `disposition` says what happened: `started`, `steered`, `queued`, `restarted`, or `duplicate` for a retried `clientRequestId`.

**`wait_for_agent`** — `{ agentId, timeoutMs? }`. Blocks until the agent is idle, errored, or needs permission. `timeoutMs` defaults to 10 minutes and is clamped to `limits.maxWaitMs`; `timedOut: true` does not stop the agent. Returns your delegated task's result when it has one.

**`get_agent_activity`** — `{ agentId }` returns a curated summary of recent work. For the full text, pass `view: "messages"` and `afterPosition: 0`, then each `nextPosition` until `hasMore` is false.

**`update_agent`** — `{ agentId, name?, labels?, settings? }`. Use `settings` for runtime changes on an existing agent: `modeId`, `model`, `thinkingOptionId`, and provider-specific `features`. For Codex fast mode, pass `settings: { features: { "fast_mode": true } }`.

**`list_agents`** — `scope`: `cwd` (default, under your working directory), `children` (your subagents in any workspace), `workspace`, `project`, or `all`. Also filters by `parentAgentId`, `titleContains`, `statuses`, `sinceHours`, `includeArchived`.

**`cancel_agent`** — `{ agentId }`. Stops the current run and keeps the agent; your pending notification for it is dropped.

**`archive_agent`** — `{ agentId }`. Interrupts if running, removes from active list.

## Agent profiles and provider discovery

**`get_orchestration_capabilities`** — one call before delegating: every provider you can start a child on, including provider aliases (separate accounts of the provider they `extends`), health, models with thinking options, modes, `agentProfiles`, wait `limits`, and the orchestration `features` this daemon has.

**`list_profiles`** — the same agent profiles on their own: named launch bundles configured by the human. Read every profile's `notes` before choosing how to launch a delegated agent. Pick a named profile the user requested, or the profile whose notes best match the work.

There is no `profile` parameter on `create_agent`. Materialize the selected profile into the call:

- combine `provider` and `model` as the `provider/model` value for `create_agent.provider`
- copy `modeId` to `settings.modeId`
- copy `thinkingOptionId` to `settings.thinkingOptionId`
- copy `featureValues` to `settings.features`

Omit absent values. Do not remember a selected profile or infer drift later; a profile is only launch configuration.

If no profile fits, or no profiles are configured, choose from the capabilities result rather than guessing, and tell the user you fell back. The narrower tools below read one slice of it.

**`list_providers`** — compact provider availability and modes.

**`list_models`** — full model list for one provider. The list can be large.

**`inspect_provider`** — compact provider capability and feature inspection. Required: `provider`; pass `cwd` when you are not in an agent-scoped session. Optional: `settings` with draft `model`, `modeId`, `thinkingOptionId`, and `features`.

Only set feature IDs returned by `inspect_provider`. For Codex fast mode, look for `fast_mode` and pass `settings: { features: { "fast_mode": true } }` to `create_agent` or `update_agent`.

## Pull requests

**`watch_pull_request`** — `{ number?, url? }`; omit both for your workspace branch's pull request. Paseo checks it every minute and wakes you when a check fails, the required checks pass, someone else comments or reviews, or the branch starts to conflict. The result reports the checks as they are now. Watching ends on merge or close, after 15 minutes of failed reads, when you are archived, or with **`unwatch_pull_request`**.

## Schedules and heartbeats

**`create_schedule`** — starts a new agent on a cron cadence. Required: `prompt`, `cron`, `provider`. Optional: `timezone`, `name`, `cwd`, `maxRuns`, `expiresIn`. Use when the recurring work should live in fresh agents.

**`create_heartbeat`** — sends you a prompt on a cron cadence. Required: `prompt`, `cron`. Optional: `timezone`, `name`, `maxRuns`, `expiresIn`. Use for reminders and status checks that should return to this conversation. To follow a pull request, use `watch_pull_request` instead.

**`delete_heartbeat`** stops it. MCP intentionally exposes no heartbeat update tool; delete and recreate when its task or cadence changes.

Schedules have the full list/inspect/update/pause/resume/run-once/log/delete surface. Heartbeats deliberately do not.

## Waiting

Agents take time — 10–30+ minutes is routine. `create_agent` and agent-scoped `send_agent_prompt` return at once, and a notification wakes you when the agent finishes, fails, or needs permission; a pull request you watch wakes you the same way. End your turn or do independent work. Don't poll `get_agent_status` or `list_agents`, and don't loop on sleeps. Call `wait_for_agent` only when this turn can't continue without the result.

## CLI semantics

The CLI and tools use the same ownership semantics even where their syntax differs:

```bash
paseo workspace create --isolation worktree --mode branch-off --new-branch fix-x --base origin/main
paseo workspace create --isolation worktree --mode checkout-branch --branch existing-work
paseo workspace create --isolation worktree --mode checkout-pr --pr-number 42
paseo run --provider codex/gpt-5.4 --mode full-access --workspace <workspace-id> "<prompt>"
paseo run --provider codex/gpt-5.4 --mode full-access --new-workspace worktree --worktree-mode branch-off --new-branch fix-x --base origin/main "<prompt>"
paseo send <agent-id> "<follow-up>"
paseo ls
paseo schedule create --cron "*/15 * * * *" "ping main build"
paseo heartbeat create --cron "*/15 * * * *" "check the build"
```

Discover with `paseo --help` and `paseo <cmd> --help`.

For product questions, setup, logs, version problems, or troubleshooting, use the **paseo-help** skill.
