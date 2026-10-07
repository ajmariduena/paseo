# Agent lifecycle

How an agent is created, runs, becomes a subagent, gets archived, and disappears from the UI. The model spans the daemon (lifecycle, archive) and the client (tabs, the subagents track).

## States

```
initializing → idle → running → idle (or error → closed)
                 ↑        │
                 └────────┘  (agent completes a turn, awaits next prompt)
```

Each live agent in `AgentManager` carries a `lastStatus` of `initializing`, `idle`, `running`, or `error`. `closed` is the persisted, resumable state for an agent record that has no live provider runtime. State transitions persist to disk and stream to subscribed clients via WebSocket.

## Runtime residency

An unarchived agent may be `closed` without being deleted or archived. Closing releases its provider
processes and subscriptions while retaining its Paseo identity, persistence handle, timeline,
workspace, labels, title, usage, attention, timestamps, and parent relationship. Opening or prompting
the agent runs through `ensureAgentLoaded()`, which resumes the durable provider session under the
same Paseo agent ID. Provider history is not appended again when the canonical timeline is already
primed.

Reload releases the old runtime before resuming its durable session: an idle provider process can
still own an exclusive writer. A close failure retains that runtime for cleanup and blocks the
replacement. Once closure succeeds, a failed resume leaves the durable agent closed and retryable.

An idle agent releases its runtime after `agents.idleRuntimeTimeoutMs` (default two hours; `0`
disables it) when its provider opts in and confirms nothing depends on the live process. The agent
becomes `closed`, not archived, and the next open or prompt resumes the same agent and provider
session. Otherwise runtime closure happens only through an explicit lifecycle action such as
archive, replacement, reload, workspace teardown, or daemon shutdown.

A provider opts in with `idleBackendEvictionEligible` and answers `canEvictIdleBackend()`
immediately before the close, inside the agent's lifecycle queue. It returns `false` while work
needs the process, and a rejection also retains the runtime: when in doubt, stay resident.
Providers that do not opt in stay resident indefinitely. Claude opts in and releases only when the
last Stop hook in the current CLI process reported empty `background_tasks` and `session_crons`,
no later `background_tasks_changed` added a task, and the session holds no session-scoped
permission grant. Neither signal is sent at process start, and older CLIs never send them, so a
fresh process stays resident until its first turn ends. Stateful MCP servers restart on resume;
nothing detects state they held.

Live background work is visible while it runs. Claude's `background_tasks_changed` replaces the
provider's part of the agent's `backgroundTasks` on the snapshot, minus task and workflow children,
which already show as provider subagents; a runtime restart clears that part, because the CLI never
re-announces it. The daemon appends its own work after it, with ids prefixed by their source: each
active pull request watch is a `pull_request_watch` task (`pull-request-watch:<watchId>`) whose
description says what the last read showed, such as `Watching PR #9 · 2 checks running`. Daemon
tasks live outside the runtime, so a closed agent still shows them. The app shows all of them as a
pill above the composer with a per-task stop (`agent.background_task.stop.request`); stopping a
watch task is `unwatch_pull_request` for that watch. The sidebar files an idle agent holding them
under its own "In background" status group, apart from Working, and every row names its
workspace's live tasks on the meta line. The lifecycle stays `idle`: the turn is over, and prompts
and finish notifications follow the turn.

A provider runtime can still die on its own — crash, OOM kill, host suspend. Work the agent parked
inside that process dies with it: Claude Code's background Bash shells, `Monitor` watches, and
workflows all live in the CLI process, and the completion notification that would have woken the
agent never arrives. A runtime that dies mid-turn is reported by whatever is draining its stream, but
between turns nothing is watching, so the agent sits at `idle` looking healthy while its background
work is gone. Report that exit as a turn failure so the agent lands in `error` with a timeline entry.
Claude and OMP report exits between turns. OMP relaunches from its session file on the next prompt;
the unfinished turn is lost.

### Cancellation

Provider interruption is idempotent at the `AgentSession` boundary. It resolves when the prior
foreground turn can no longer run, including when the provider reports that it is already idle. It
rejects only when the provider may still own the turn. Provider adapters translate native errors
into that contract; lifecycle callers do not interpret provider-specific errors.

After an acknowledged interrupt, the manager settles the captured run even when no terminal event
arrives or the run was still waiting for its provider turn id. The captured run token prevents an
older cancellation from settling a newer turn. If interruption is rejected or times out, the agent
keeps its active foreground turn and replacement, reload, and rewind report the failure: starting
their work after an ambiguous interruption would create a split-brain session. Stop does not refuse.
It settles the run locally (`turn_canceled`, pending permissions resolved, output so far kept) and
abandons the turn, so a late provider event for that turn cannot revive or fail the stopped agent.

## Relationships

Agents can launch other agents via the agent-scoped `create_agent` MCP tool. Agent-scoped creation is always asynchronous and always stamps `paseo.parent-agent-id`, pointing back at the caller. Omit `workspaceId` to use the caller's workspace, or pass an existing workspace ID returned by `create_workspace`. Placement never changes parentage.

- **Subagents** — exist as part of the creating agent's work, appear in that agent's subagent track, and are archived with it.
- **Detached agents** — stand on their own after an explicit detach transition, do not appear in the former parent's subagent track, and are not archived with it.

Parent archive detaches a subagent instead of archiving it when either condition holds:

- The child belongs to another workspace.
- The child is currently open in an agent tab.

All other children archive with the parent. After the workspace layout hydrates, the client marks
every managed subagent present in its tabs with `paseo.open-agent-tab.<client-id>=true` through the
generic agent metadata update. This includes background and restored tabs; navigation does not own
the marker. Closing a tab sets that client's label to `false`. Any `true` client label keeps the child
open. Detach clears the parent and every open-tab label. The surviving child therefore becomes a
normal root agent immediately, and closing its still-open tab archives it.

Runtime ownership is resolved from explicit workspace ID and caller context, never from `cwd`. Workspace creation is a separate operation with `local | worktree` isolation; agent creation only selects an existing workspace.

Users can also detach an existing subagent from the subagents track. Detach is deliberately a manual lifecycle gesture, not an agent-facing MCP tool. It removes the parent and open-tab lifecycle labels: it does not stop, archive, move, or restart the agent. The agent keeps its current `cwd` and `workspaceId`, leaves the former parent's track, and behaves like a root agent for tab close, workspace activity, and future parent archive.

`notifyOnFinish` defaults to `true` for agent-scoped creation and background prompt follow-ups because most delegated work needs to report back to the creating agent. Set it to `false` only for truly fire-and-forget agents or prompts.
Each notified prompt is a durable delegated task (see [data-model.md](data-model.md#delegation-store)). The child has a result once it settles: idle, holding no background tasks, and with no open delegated tasks of its own. Paseo then records the result and wakes the parent:

- A wake never interrupts the parent. It steers into a running turn when the provider can steer; otherwise it waits for the turn to end and starts a new one.
- Children of the same parent turn that finish together share one wake. A child finishing while that wake's turn runs goes out in the next wake.
- The wake inlines each result, capped at 4000 characters, with the task id and a pointer to `get_agent_activity` for the rest.
- Reading a finished child's result through `get_agent_status`, `get_agent_activity`, or `wait_for_agent` acknowledges it and cancels a wake that has not started yet. While the parent blocks in `wait_for_agent`, the child's wake is held for the parent's current turn; a wait that times out or is aborted releases it, so the child still reports back. A timeout never stops the child.
- A user Stop drops every result the agent was still waiting for, from any of its runs, even while it sits idle waiting on children. It also stops the work the agent started: its pull request watches end, and every live Paseo descendant, depth first, has its queue held, its results dropped, its watches ended, and its run cancelled. One descendant that fails to stop does not shield the rest. A tool call from the run Stop reached cannot start more work: `create_agent` and `watch_pull_request` answer with a stopped-run error. Archiving the parent drops all of its results. The parent's `cancel_agent` on a child drops that child's results and stops the child's subtree the same way, even when the child itself already finished.
- A child that closes before it finishes reports as stopped, so delegated work cannot disappear silently during archive or workspace teardown.
- A daemon restart is not a result. At boot, a child the restart cut reports `cancelled` and wakes its parent, even an idle one. A wake turn the restart cut hands its results to the next wake. A wake that was claimed but never sent is offered once, under the same id, so the parent's timeline keeps one row for it. A child that settled before a crash but whose result was not recorded is reloaded, and its result comes from its provider history. Queues come back held with reason `restart` until `agent.queue.resume`; a held queue does not stop a wake from starting an idle parent. Permission notices waiting in a queue are dropped, because pending permissions do not survive a restart.
- With `agents.continueAfterRestart` on (off by default), a turn the restart cut gets one `Continue where you left off.`, shown as a notification row. It is declined when the agent was archived, switched provider, got a newer prompt, was asked to stop, was running an out-of-band command, or has no provider session to resume; a turn started by something else first also wins. A continued child keeps its task open and reports when it settles; a declined one reports `cancelled`. An agent that was idle when the daemon stopped stays asleep even if its background work was cancelled: its next turn starts with a note listing that work.

`send_agent_prompt` from an agent never interrupts a busy target unless it passes `delivery: "restart"`. The default `auto` steers into the running turn when the provider can steer and otherwise runs the prompt after that turn ends (`queued`); `steer` fails instead of falling back. Top-level callers keep `restart` as the default. A queued prompt waits in the agent's durable queue ([data-model.md](data-model.md#agent-queue-store)) and starts when the running turn settles. A failed turn or a user Stop holds the queue: it delivers nothing until `agent.queue.resume`, but a message sent to an idle agent still starts. A user Stop holds the queue even when it is empty: until the user resumes or writes to the agent, system messages (child results, permission notices, pull request news) wait in the held queue instead of starting a turn. The app's `send_agent_message_request` accepts the same `queue` and `auto` behaviors, and its `interrupt` and `steer` keep their meaning: a `steer` the provider cannot take replaces the turn it was admitted against, and a steer that arrives after its turn ended starts a new turn, or queues behind a newer one, instead of replacing it. A `clientRequestId` makes `create_agent` and `send_agent_prompt` safe to retry: the agent created under a key is persisted with it, and a resent prompt answers `duplicate`.

Permission requests are checkpoints. The parent hears each request as it happens, through the same never-interrupt delivery, with the normalized request plus the child and request IDs so it can respond without fetching agent status. A request resolved before the parent hears it is dropped.

`watch_pull_request` uses the same never-interrupt delivery for pull request news. The daemon reads each watched pull request once per pass for every agent watching it, every minute while a check runs, mergeability is unknown, or the remarks could not be read, and every two minutes otherwise; every watch on one forge account shares its rate limit. It wakes the watching agent only when a check newly fails, the required checks newly pass (every check when the forge marks none required) or a required check appears already passed, an account other than the one the agent's forge CLI acts as comments, reviews, or edits one, or the branch newly conflicts. A push starts the check news over for the new head commit. The watch result reports the current checks, so the state at watch time never wakes the agent. A wake lost to a restart is sent again on the next pass ([data-model.md](data-model.md#pull-request-watch-store)), and one still queued when the agent unwatches is dropped. Watching ends without a wake when the pull request merges or closes, on `unwatch_pull_request` or stopping the watch's background task, or when the agent is archived, and with a final wake after 10 comment-only wakes in a row or 8 failed reads in a row. A forge rate limit skips the pass and never counts as a failed read. Agents are told to unwatch when they hand the work back, because the watch keeps them in the background (see [Workspace activity](#workspace-activity)).

## Archive

Archive is a **soft delete**: the agent record stays on disk with `archivedAt` set, the runtime is closed, and the agent disappears from active lists. Archive is **global** — it lives on the server and propagates to every connected client.

Archive sets `archivedAt`, invokes the provider's native archive hook, and cascades to managed
children.

`create_agent_request` can opt an agent into `autoArchive`. In that mode the daemon archives the agent after the first terminal turn event (`turn_completed`, `turn_failed`, or `turn_canceled`). When the agent owns an isolated workspace, auto-archive archives that workspace too; the managed worktree is removed when its final workspace reference is gone.

Archiving runs through `AgentManager.archiveAgent` (`packages/server/src/server/agent/agent-manager.ts`):

1. Snapshot the current session into the registry
2. Set `archivedAt` and normalize `lastStatus` away from `running`/`initializing`
3. Notify subscribers
4. Close the runtime (kills the process if still running)
5. **Resolve children** — detach cross-workspace and open-tab children; cascade-archive the rest recursively

Cascade is what keeps subagent fleets from outliving their orchestrator.

Workspace archive is a separate lifecycle. Archiving or removing a worktree can close a surviving
agent record without setting the agent's `archivedAt`, while its `workspaceId` still points at the
archived workspace. History navigation must not infer workspace lifecycle from `agent.archivedAt`
or mutate either lifecycle. The workspace route asks the daemon for authoritative recovery state;
only the route's explicit Unarchive or Restore action changes the archived workspace.

History navigation opens the selected agent without changing either archive state. Workspace
**Restore** recovers only the workspace; the selected archived agent stays open with its callout.
The agent's **Unarchive** runs the provider's native unarchive hook before interactive resume and
history hydration. Other archived agents stay archived.

Opening an agent is a navigation choice, independent of whether its details are cached. The
layout retains that choice across reload while the panel fetches the agent from the daemon.
Once the daemon reports the agent active, its tab follows normal archive propagation again.
An empty active list cannot cancel an explicit History selection. Agent-detail loading does
not own selection or release the explicit open.

Persisted resume, native restore, and both live and stored-only archive enter the same per-agent
lifecycle queue. Resume chooses its history or interactive purpose from the durable record after
entering that queue. Shutdown must finish before the manager releases runtime ownership; a failed
close retains the runtime for cleanup and blocks replacement through that close operation.

Authoritative timeline catch-up can use a runtime-only `history` resume purpose. For Codex, that
purpose initializes a temporary app-server, reads the persisted thread and child histories, and
releases the process before returning. It never loads, resumes, or unarchives a native thread,
including legacy records whose native archive failed. The retained history session contains only
the read results. Interactive resume remains responsible for repairing a provider session archived
outside Paseo while its Paseo agent is active.

Provider session connection owns every process it spawns until the session is registered with
`AgentManager`. If initialization, persisted-session resume, or initial history hydration fails,
`connect()` must dispose that process before rethrowing; the manager cannot clean up a session it never
received.

## Tabs vs archive

These are two distinct concepts that used to be conflated:

| Concept                    | Scope      | Triggers                   |
| -------------------------- | ---------- | -------------------------- |
| **Tab** (workspace layout) | Per-client | User opens/closes a view   |
| **Archive** (lifecycle)    | Global     | Explicit lifecycle gesture |

Closing a tab on a **root agent** still archives — the tab is the agent's home, so closing it means "I'm done with this agent." A confirm dialog protects against archiving a running agent by accident.

Closing a tab on a **subagent** (any agent with `parentAgentId`) is **layout-only**. The app clears the current client's open-tab label before removing the tab. Another client's open tab remains protected. The agent stays unarchived and stays in its parent's track, so a later parent archive cascades to it when no client still has it open. The user can re-open the tab from the track at any time. Single and bulk tab close apply the same policy.

The asymmetry is intentional: a subagent's persistent relationship lives in the parent's track. Same-workspace subagents are not auto-opened as tabs; the user opens one from that track when needed. A cross-workspace subagent is also auto-opened as a tab in its own workspace so opening that workspace does not appear empty. It remains in the parent's track until it is actually detached.

The sidebar hides a workspace while every active agent in it belongs to one active parent's subagent tree; you reach it from that parent's track. The daemon marks it with `delegatedByAgentId` on the workspace descriptor. It comes back when you pin it, detach a subagent in it, archive the parent (which detaches cross-workspace children), or start a root agent there.

## Workspace activity

Agent lifecycle status stays literal: a parent agent is `idle` when its own turn is idle, even if a child is running.

Workspace status is an aggregate activity signal computed **per `workspaceId`**. Ownership is never derived from `cwd` — many workspaces may share one directory, and same-`cwd` siblings do not clump under one status. Root agents and cross-workspace subagents contribute their normal state bucket to their own workspace. Same-workspace descendants contribute `running` to the nearest ancestor in that workspace; their non-running attention, permission, and error states stay in the parent's subagents track. An idle workspace root with running delegated Paseo descendants in any workspace presents as Waiting. Its wire bucket remains `running` for older clients; the optional `waitingOnSubagents` count lets new clients distinguish it. Detached agents and terminal activity do not create this state. Pending permission and failure take priority.

Running provider-native subagents contribute `running` to the workspace owned by their parent agent. Their completed, failed, and canceled states stay in the parent's subagents track.

A finished workspace can be marked unread after it has been reviewed. The daemon restores
`finished` attention on its newest eligible workspace-root agent without sending a new completion
notification. Opening the workspace clears that attention through the normal focus flow.

Finished attention and its notification wait while a parent has running delegated descendants. They also wait when a turn that a daemon message started (a pull request wake, a child's result) ends while the agent holds daemon background work, so a watching agent stays In background instead of asking for review on every wake; they are raised once that work is gone. A turn the user prompted, permissions, and errors ask for attention as usual. If the parent starts another turn, that turn owns its next finished attention. The wait is in memory: a daemon restart or an idle runtime release drops it. Attention is set by the agent finishing or failing and cleared by the client's
`workspace.clear_attention`, which fires when the user reads the chat. Loading an agent's runtime is
neither, so resuming carries the stored attention and the stored last-activity time through
untouched. Forging either makes a background resume look like the user read a workspace and like the
agent worked in it just now, which rewrites the sidebar timestamp permanently — persisted
`updatedAt` is what workspace `statusEnteredAt` is re-derived from on the next daemon start.

## The subagents track

The track is a pill at the foot of an agent's pane (`packages/app/src/subagents/track.tsx`): a count you can read at a glance, and a panel behind it — a popover on wide screens, a sheet on compact ones — holding the rows. It floats over the transcript rather than sitting in a band above the composer, so the timeline scrolls underneath it; `packages/app/src/panels/agent-tracks.tsx` owns that placement, and the pill frame is shared with the task list in `packages/app/src/composer/tracks.tsx`.

The rows combine two kinds of children:

- **Paseo subagents** are full managed agents. Their membership rule (`packages/app/src/subagents/select.ts`) is:

```
parentAgentId === thisAgent.id  AND  !archivedAt
```

- **Provider subagents** are child executions owned by the provider: Claude, Codex, OpenCode, OMP, and Pi extensions report them. They are not inserted into `AgentManager` as managed agents. Providers emit a separate descriptor and timeline stream through `agent.provider_subagents.*`; the client keeps that state outside the normal agent store and merges only the presentation rows into the track. A descriptor's optional `parentSubagentId` identifies its direct provider-subagent parent; an absent value identifies a direct child of the managed agent.

Clicking either kind opens a workspace tab. A Paseo subagent tab is a normal interactive agent pane. A provider subagent tab is a read-only timeline pane with no composer, archive, detach, rewind, or fork actions. Its composer slot holds a bar with the provider's subtitle, the elapsed time and Open parent (`packages/app/src/subagents/provider-bar.tsx`); the timing comes from the descriptor's `createdAt` and `updatedAt`. It shows its own direct children in a subagents track. Both panes use `AgentStreamView`, so message, reasoning, tool-call, and layout rendering stay identical.

The parent's timeline also shows each child where it was started, as a subagent row in place of the spawning tool call (`packages/app/src/subagents/timeline/`). A `create_agent` call becomes a row once its result names the agent; one that failed has no child and stays a tool call. A provider `sub_agent` call finds its descriptor through `descriptor.toolCallId`. Spawn calls run separately from tool work in the overview grouping, so adjacent spawns become one group, and a collapsed turn keeps them visible. Settled Paseo rows show no duration: the snapshot has no turn end time.

When a child reports back, the wake the parent receives shows in its timeline as the same row, drawn from the notification's `source.subagents`. The dot and word are the reported event (Finished, Failed, Needs input, Closed) and do not follow the child afterwards; the trailing slot is the time the wake arrived. A batched wake holds one row per child in a card. The wake starts a new visible response, as a user message does, and a collapsed turn keeps it visible. A child the client no longer knows keeps the wake's title and still opens by id. Notifications without a source render as before.

A subagent's own timeline starts with "Subagent of {parent}" in the history-start slot, so it shows once history is fully loaded and scrolls away with it. It opens the Lineage surface (`packages/app/src/lineage/`): the parent, the subagents still worth a look (working, waiting, or finished and unread), previous subagents behind a toggle, and archived ones on request through `fetch_agents` with the parent label. Rows keep creation order, so a child finishing or waking never moves.

A user message another agent sent (a `create_agent` initial prompt or a `send_agent_prompt`) carries `origin: { kind: "agent", agentId }` and shows "Sent by {sender}" above the bubble, which opens the sender. It reads "Sent by an agent" while the client does not know the sender's title. The bubble is unchanged: the provider received it as a user turn.

Provider timelines use the same structural timeline item format but deliberately have a separate lifecycle and transport. A provider thread/session identifier is not a Paseo agent identifier, and closing its tab is always layout-only.

Provider descriptors may include one compact subtitle. The provider owns its contents and formatting; clients display and truncate it without interpreting provider-specific model, thinking, or usage fields.

### Claude provider subagents: the task protocol

Claude Code announces subagent lifecycle on the SDK stream (`task_started` / `task_updated` / `task_notification` / `task_progress`), and Paseo reads those announcements rather than reconstructing them from sidechain frames. The live source (`subagents/live-source.ts`) and the replay source (`subagents/replay-source.ts`) both translate into one observation vocabulary (`subagents/observation.ts`), so a fact is derived once for both paths instead of once per path. Gotchas that are not obvious from the SDK types:

- **Not every announced task belongs in the track.** Task subagents announce as `local_agent` and workflows as `local_workflow`; a backgrounded shell announces as `local_bash` with the same `tool_use_id` shape, and ambient housekeeping sets `skip_transcript`. The Claude provider normalizes a workflow to a generic provider-subagent descriptor titled `Workflow`, using Claude's summary as its description and timeline opener. Shared storage, protocol, and UI do not distinguish it from another provider subagent.
- **A task that was never declared gets no descriptor, by any route.** Filtered tasks still emit `task_notification`s carrying a `tool_use_id`, and still emit frames carrying `parent_tool_use_id`. Attributing either produces a descriptor with no identity and a defaulted `running` status — a nameless row that never finishes. Status, presentation updates, and sidechain frames all route through the declaration table.
- **Task ids are session-scoped, not turn-scoped.** Cancelling a turn must not clear the routing table: a backgrounded child settles after the interrupt and needs its descriptor to still exist. Cancellation instead terminalizes the declared children that were running in the foreground, and a later `task_notification` is free to correct that guess. Backgrounded children are identified by `task_updated.patch.is_backgrounded`.
- **A resumed task can be announced again with a new `tool_use_id`.** The first Task tool id remains the canonical descriptor and later ids are routing aliases for the same session-scoped task. The resumed prompt is added to that child timeline.
- **Effort is only reachable through hooks.** It appears nowhere on the message stream at any depth, and the level Paseo requests is not necessarily the level that runs — a model that does not support it is silently downgraded. A hook firing inside a subagent reports the active post-downgrade level next to its `agent_id`, which is the same id `task_started` calls `task_id`.
- **Backgrounded subagents emit no frames carrying `parent_tool_use_id` at all.** Everything keyed off that field sees nothing for one; they are visible only because the task protocol announces them.
- **Nested ownership comes from the launching sidechain, not `spawn_depth` alone.** A sidechain's Agent or Bash tool call records the direct owner of that `tool_use_id`; the following `task_started` inherits it. This routes a grandchild descriptor and child-owned background notifications without relying on labels or flattening them into the managed parent.
- **On replay, `<session>/subagents/` holds every descendant beside the root.** Resolve the tree one proven generation at a time: the root transcript admits direct children, then each admitted sidechain transcript admits its children by `toolUseId`. `spawnDepth` orders candidates but does not establish ownership. Unresolved sidecars remain excluded as ambient or unrelated work.
- **Replay `totalTokens` is a context-size reading, not cumulative spend.** Claude Code finalizes a subagent by summing the _last_ assistant message's usage block and shipping that as `usage.total_tokens`. Summing per-entry usage instead multiplies the cached prefix by the turn count and reports a number several times larger than the live path.

Archived Paseo subagents disappear from the track, by design. To remove one from the track without closing its tab, use the **archive button** on the row — it opens a confirm dialog and archives the subagent on confirm. Provider-owned rows have no individual Paseo lifecycle controls.

The **Archive finished** row at the foot of the panel covers every finished row. It archives idle or errored managed Paseo subagents one at a time, and hides completed, failed, or canceled provider-owned rows in the current app session. Native sessions and timelines are untouched. Running and initializing children remain in the track. If a hidden provider child starts running again, the app brings it back to the track.

To keep the agent alive but remove it from the parent's track, use **detach**. The daemon clears the relationship lifecycle labels, emits the normal agent update, and every client reclassifies the agent from subagent to root/sibling from that updated snapshot.

## Why this shape

The decision was to **decouple "close tab" from "archive" only for subagents**, rather than universally:

- **Closing a tab on a root agent still archives** — preserves the existing UX users are trained on
- **Closing a tab on a subagent is layout-only** — fixes the lossy "click to read, close to dismiss view, lose the row" flow
- **Archive button on track rows** — gives subagents an explicit lifecycle gesture in their home surface
- **Detach button on track rows** — lets a subagent continue independently without killing its work
- **Cascade archive on parent** — keeps subagents from leaking when the parent is archived

We considered universal decoupling (no tab close ever archives, archive is always explicit) but rejected it: it changes a behavior root-agent users rely on.

## Limitations

### Subagent accumulation under long-lived parents

A parent that spawns many subagents will see the panel's list grow; the pill only counts them. Managed Paseo subagents can be archived individually or with **Archive finished**. That action hides finished provider-owned rows locally; this presentation state resets when the app restarts.

### Cross-client tab dismissal

Closing a subagent's tab on one client doesn't affect other clients' layouts. This is the expected behavior of decoupled tabs and is consistent with how layouts have always worked. Archive remains the global gesture for cross-client cleanup.

## Storage

```
$PASEO_HOME/agents/{cwd-with-dashes}/{agent-id}.json
```

`{cwd-with-dashes}` is derived from the agent's filesystem `cwd`. It is not the workspace id; agent storage stays cwd-keyed while workspace identity is the opaque workspace id.

Each agent is a single JSON file. Fields relevant to this doc:

| Field                                        | Type          | Meaning                                                                            |
| -------------------------------------------- | ------------- | ---------------------------------------------------------------------------------- |
| `id`                                         | `string`      | Stable identifier                                                                  |
| `archivedAt`                                 | `string?`     | Soft-delete timestamp (ISO 8601)                                                   |
| `labels["paseo.parent-agent-id"]`            | `string?`     | Parent agent ID, set automatically for agent-scoped creation and removed by detach |
| `labels["paseo.open-agent-tab.<client-id>"]` | `string?`     | `"true"` protects an open tab on that client; detach clears every matching label   |
| `lastStatus`                                 | `AgentStatus` | `initializing` / `idle` / `running` / `error` / `closed`                           |

See [`docs/data-model.md`](./data-model.md) for the full agent record.
