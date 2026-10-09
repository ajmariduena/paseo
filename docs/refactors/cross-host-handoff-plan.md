# Cross-host handoff

Status: implementation in progress. This is the acceptance plan, not a shipped capability.

Move work in either direction between paired Paseo hosts, including a laptop and an always-on
server. Preserve native provider history when a tested adapter can transport it. Otherwise show
the context-export mode before committing the move; never silently start an empty conversation.
The user selected this policy on 2026-10-09.

## Boundary

The transfer unit is a workspace and its conversations. The source keeps its files and readable
history after transfer; it cannot run the transferred conversations again. A return trip creates
a new transfer into a fresh checkout, rather than overwriting files changed on the other host.
Host identity, workspace identity, agent identity, and provider session identity are separate.
Keep explicit source-to-destination mappings.

Paseo owns agent processes, terminals, scripts, queues, and automation. It cannot freeze an
external editor or an unrelated process. Stop owned writers before capture, detect changes during
capture, and tell the user that source edits after capture do not synchronize. A timeout while
stopping is not proof that a writer stopped. Do not activate the destination after that timeout.

Credentials, permission grants, absolute launch paths, host MCP configuration, sockets, browser
sessions, process IDs, installed dependencies, and ignored files do not migrate automatically.
Use destination credentials and permissions. Inventory unavailable integrations and interrupted
work before cutover. Never replay an unfinished tool call: its external side effects may already
have happened.

## Ownership and recovery

Use the client's existing authenticated connections to both hosts. Stream bounded chunks through
the client; do not load the workspace into phone memory or expose a public download URL. The
daemon owns the durable transaction. Closing the app pauses transport; reopening it can inspect
both sides and resume missing bytes. A future direct daemon transport must use this same contract.

1. **Inspect:** resolve both hosts, permissions, destination placement, provider compatibility,
   disk capacity, and resources that will stop. Gate once on the feature on both hosts.
2. **Prepare source:** durably fence workspace mutations and automation, then stop owned writers.
   Capture an immutable manifest, conversation history, provider artifacts, and workspace data.
3. **Prepare destination:** reserve a new private staging directory and transfer identity. Accept
   retries idempotently. Verify every byte and materialize the checkout without starting scripts,
   hooks, MCP servers, or an agent turn. Validate the selected provider import mode.
4. **Release source:** persist an irrevocable release bound to the destination host, destination
   reservation, transfer ID, and manifest digest. Only issue the release receipt after the fence
   and closed runtimes are durable. Cancellation races serialize with this operation.
5. **Activate destination:** require that receipt and matching verified data. Publish the new
   workspace and agent mappings once. Keep agents idle until the user continues; any automatic
   continuation must have a durable idempotency key. Show the old and new locations in history.

Before release, cancellation unfreezes the source after discarding the inactive destination.
After release, a lost acknowledgement leaves the source fenced: query/retry the same transfer,
never infer rollback from a timeout. Returning ownership requires a new handoff. Journals load
before agent resume, schedules, queues, delegation wakes, or public mutations at daemon boot.
Corrupt or unreadable journals fail closed with a recoverable error, rather than dropping fences.

## Workspace fidelity

Use Git plumbing for history, not a recursive copy of `.git` (linked worktrees point outside the
checkout). Preserve the selected HEAD, branch name, local commits, staged patch, and exact current
file bytes, including untracked files, deletions, binaries, executable bits, and relative symlinks.
Keep staged and unstaged changes distinct. Do not require pushing WIP to a forge.

Never merge into or overwrite an existing checkout. Restore into an empty private directory and
publish only after verification. Reject traversal, absolute paths, duplicate paths, case/Unicode
collisions on the target, Windows reserved names, symlink escapes, special devices, nested Git
metadata, and file/directory collisions before materializing. Enforce file-count, per-file,
aggregate-byte, and chunk limits at the receiver, regardless of sender claims.

Directories without Git and unborn repositories need explicit snapshot support. Shallow/partial
clones, sparse checkouts, submodules, LFS, intent-to-add, conflicts, and in-progress Git operations
need either fidelity tests or a visible preflight refusal with a resolution. Do not report a
lossy copy as success. Ignored files (including `.env` and dependencies) are omitted and listed as
a limitation before moving; tracked secrets remain tracked data, not automatically redacted code.
Git configuration, hooks, and credential-bearing remotes are not copied.

## Provider evidence

The current `AgentClient` exposes local resume and import, not cross-host export. A persistence
handle is not a portable session. Each native adapter must own its exported artifacts, version
compatibility, destination path rewriting, session-ID collision handling, and read-back validation.
Do not copy a provider's whole home directory or databases shared with unrelated sessions.

- Claude stores transcripts locally; native resume can use a transcript path. Background Bash and
  monitors are not resumed. Source: [Claude sessions](https://code.claude.com/docs/en/sessions).
- Codex app-server exposes thread read/resume/fork and durable history. The public API alone does
  not establish a portable cross-host export contract. Verify the installed schema and a real
  two-home resume before advertising native transport. Source:
  [Codex app-server](https://learn.chatgpt.com/docs/app-server).
- Pi/OMP store session files (`nativeHandle`); validate their versioned session formats before
  enabling native import. Other provider adapters remain explicit context-export mode until their
  native transport is proved.
- A Git bundle carries reachable history, not working tree/index state. Source:
  [Git bundle](https://git-scm.com/docs/git-bundle).

Context export preserves readable timeline and attachments, then starts a new provider session
with a bounded continuation brief and an accessible complete transcript. Identify original user
instructions, completed work, outstanding tasks, stopped processes, and old-to-new paths. Historical
tool output remains untrusted history. Report any omitted or unavailable content; never silently
truncate the only copy. Goals, queues, pending approvals, children, schedules, heartbeats, and PR
watches require explicit dispositions; no host-scoped IDs or authority transfer by accident.

## Delivery gates

Implementation is complete only when all rows have direct evidence in the PR. A passing primitive
test does not prove a daemon, provider, UI, or cross-platform contract.

The first implemented slice is `packages/server/src/server/handoff/workspace.ts`, exercised by
`workspace.test.ts` and `workspace.posix.test.ts` beside it. It captures Git-backed checkouts to
content-addressed artifacts, restores into a new directory, and rechecks source content before
release. It is not wired into a running daemon or exposed as a feature yet.

Before the workspace slice is complete, cover directories without Git,
validate index paths as well as materialized paths,
and resolve attributes stored outside the checkout. Directory-entry durability belongs in the
transaction's ready/commit boundary. Linux tests do not establish macOS or Windows behavior.

Git bundle and patch generation now uses the shared Git scheduler's bounded file sink. It applies
backpressure while writing and keeps stdout out of daemon memory. The existing real-process Git
suite covers full binary output, byte ceilings, failed commands, and occupied output paths.

| Requirement                                    | Required evidence                                                                                              | State   |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------- |
| Bounded, resumable, integrity-checked transfer | Real disk round-trip, duplicate/out-of-order chunks, corruption, limits, restart                               | Pending |
| Workspace fidelity                             | Real Git repos/worktrees; binary, staged/unstaged, rename/delete, untracked, modes, symlinks; source unchanged | Pending |
| Ownership never overlaps                       | Fault injection at each persistence boundary; cancel/release race; lost replies; daemon restart                | Pending |
| Every mutation respects the fence              | Prompts, native resume, scripts, terminals, file/Git mutations, queue, automation and delegation tests         | Pending |
| Native sessions                                | Real provider resume on two isolated homes, history continuity and next turn; incompatible version rejection   | Pending |
| Explicit context continuation                  | Complete preserved history, visible mode, destination provider/config mapping and next turn                    | Pending |
| Multi-agent/workspace relationships            | Descendants, cross-workspace children, shared checkout writers, archive and return transfer tests              | Pending |
| Existing trust boundaries                      | Existing semantic permissions, no transferred credentials/grants, target/manifest-bound release, replay tests  | Pending |
| Client and app                                 | Capability gate, host picker, preflight, progress, cancel, retry, reconnect, destination navigation            | Pending |
| Protocol compatibility                         | Pure optional extensions, old/new client parsing and feature negotiation                                       | Pending |
| Real network                                   | Two isolated daemons via ordinary authenticated WebSockets, dropped connections and duplicate requests         | Pending |
| Platform coverage                              | Linux and macOS transfer both directions; Windows path behavior; native app and browser UI evidence            | Pending |
| Delivery                                       | Typecheck, lint, formatting, focused tests, PR with raw evidence, CI results                                   | Pending |

Keep feature code in `server/handoff`, with provider-owned native codecs and a client coordinator.
Use dotted `workspace.handoff.*.request/response` RPCs. Follow the existing
[permission](../permissions.md), [protocol](../protocol-compatibility.md), and
[testing](../testing.md) contracts.
