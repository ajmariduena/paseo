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
Keep writers in the stop inventory even if a best-effort terminal close removes them from the UI.
A terminal's synthetic close event and its shell's exit do not prove that all descendants exited.
Awaited terminal stops now reject missing PTY exit confirmation and retain the session for retry;
the coordinator still needs process-tree and previously closed terminal coverage.

The managed-helper ledger covers registered helper PIDs, not every writer or its descendants.
Recovery retains records after termination timeout or uncertain exit inspection, and unreadable
records prevent a complete inventory. A real-helper regression proves retention across registry
restart and removal after confirmed exit. This evidence does not replace the coordinator's full
process-tree inventory.

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

The workspace snapshot implementation lives in `packages/server/src/server/handoff/workspace.ts`.
Its neighboring tests cover Git-backed checkouts, exact file restoration and source rechecks.
`archive.ts` provides bounded, checksummed staging with persistent receive offsets. Archive RPCs
and `packages/client/src/handoff-transfer.ts` now connect two hosts through the ordinary client
transport, with one chunk in flight. No ownership changes or agent starts occur in this layer.

`archive.e2e.test.ts` runs two isolated daemons and verifies destination restart, a dropped reply
after a committed write, pause/resume, invalid encoding and corruption recovery. These tests run
in the existing Linux/Windows server integration job and the macOS server job. Local evidence is
Linux only until those CI jobs pass. Staging cleanup, host-wide disk quotas and the ownership
transaction are still pending; the daemon does not advertise the complete handoff capability.

`ownership.ts` supplies the source ledger and mutation leases. Its real-disk tests
cover recovering fences, draining admitted operations, cancel/release races, failures before and
after journal writes, and destination/content-bound signed release receipts. The signing key is
transfer-specific and stays in the source journal; the destination must pin the public key from
its authenticated source preflight. Bootstrap loads the ledger before constructing providers or
starting queues and automation. Agent creation, resume, import and reload hold leases through
registration, including a changed working directory during reload. Boot tests exercise a persisted
fence through the real WebSocket connection and reject missing or corrupt journals. Missing
working directories retain their path fences without blocking unrelated archived history.

Existing-runtime prompts, steering/replacement, settings, permission responses and rewind now
respect the fence. Turn admission holds its lease until the accepted turn and its waiter are
published; it does not hold the lease for the whole foreground turn, which handoff must stop after
draining admissions. Out-of-band commands hold their leases until they finish. Stop and close
remain available. Tests cover denied prompts, cancellation before provider admission, and draining
admitted turns and commands. Flush event and persistence queues after runtime shutdown and before
capturing conversation data; finishing an RPC alone does not prove those writes have settled.

The shared boot ledger also gates file-editor/explorer mutations and checkout commands. Reads
remain available; denied writes use the existing correlated error responses. Tests hold an admitted
file write or branch change across preparation, then verify draining and cancellation. A merge
requested from a sibling worktree must acquire a lease for the actual target checkout as well as
the caller's directory. The two-worktree regression verifies that a fenced base stays unchanged.

The production terminal worker now shares the boot ledger. Creation holds an admission until the
worker finishes creating and registering the terminal, even after a caller timeout or an early
conpty error. A late terminal remains visible to shutdown. Input and resize check a bound canonical
scope synchronously and hold leases until worker acknowledgement, without filesystem I/O per
keystroke. Read and stop operations remain available. Tests cover late replies, cancelled fences,
real terminal input and rejection over the daemon connection. A worker exit cannot certify that
its child processes stopped; uncertain admissions remain held until coordinator recovery proves
quiescence. That recovery and complete process-tree shutdown are still pending.

Scheduled workspace/agent naming now takes an admission when its callback runs, before consuming
the pending branch-name marker or generating a title. An admitted operation drains through its
Git change and metadata write. Real-worktree tests cover blocked naming, cancellation, generation
failure and shared-checkout subdirectories. Named workspace scripts also take admission before
port allocation and launch, through terminal/runtime registration. Both their RPC and tool entry
points use the boot ledger. The real WebSocket boot test proves a fenced service cannot execute
its port allocator; unit coverage keeps script listing and stopping available. Complete process-tree
shutdown still needs coordinator integration.

Workspace setup and agent setup continuations take admission before runtime metadata, commands or
automatic terminals. They retain it through their final workspace or timeline publication, including
failure. Run setup fences the provenance update and runtime registration too. Agent continuations
use the shared cancellable setup runtime; multiple runs for one workspace remain in its stop
inventory. After installing the fence, cancel registered setup runs before waiting for their leases
to drain; waiting for long-running commands first can prevent preparation from finishing. Tests cover
shared paths and identities, delayed continuations, cancellation of a real command, final writes in
flight and persisted provenance through the real RPC. These tests do not prove descendant-process
quiescence after shell exit; the coordinator still needs that proof.

Workspace provisioning takes admission at its public boundary, through project/workspace writes
and failed-import rollback. Internal composition keeps that admission if a fence arrives while
I/O is pending. Tests use real registries and hold both final writes and rollback across preparation;
the source cannot become ready before they finish. Scratch creation checks workspace identity before
creating directories, and worktree registration checks its source and backing directory. Unarchiving
records is fenced too. The boot test rejects workspace creation and adoption over the real connection.
Asynchronous plugin hooks still need their own admission boundaries.

Fresh worktree creation fences the caller's identity, backing checkout, shared repository and
destination directory before Git can fetch, create branches or run setup. Admission covers generated
and collision-suffixed paths and lasts through registration or rollback teardown. If preparation
arrives before registration takes its own admission, creation fails and drains its cleanup before
the source can become ready. Real Git/registry tests cover these races, partial admission failure and
cancel/retry. Both workspace-creation RPCs reject before changing refs in the real boot test.

Archived-worktree recovery fences the selected backing directory and source repository before Git
can prune or reconstruct anything. Reconstruction runs inside provisioning's unarchive admission,
so preparation cannot split filesystem recovery from record publication. Real Git/registry tests
hold reconstruction and the final write across preparation, and verify cleanup when the restored
branch lacks the selected subdirectory. Recovery inspection stays readable under a fence. A real
WebSocket regression proves the boot ledger reaches reconstruction, including a stale worktree
registration that must remain untouched when the request is denied.

Automatic workspace reconciliation admits project and member identities, including missing or
archived members, before changing shared metadata or archiving missing directories. Persisted and
newly discovered backing roots are fenced too. Unrelated projects keep converging; cancellation
allows the next pass to retry. Admissions last through runtime cleanup and final publication.
Sibling reads and writes must settle even when one fails. Real Git and registry tests cover legacy
placement, absent members, partial admission and pending cleanup/publication. The boot test proves
the shared ledger prevents background changes to persisted source records.

Daemon shutdown awaits workspace reconciliation and background managed-helper recovery before
releasing its state. Stopping watches alone leaves Git reads and registry writes in flight; they
can recreate files during test cleanup or race a subsequent daemon. Held reconciliation and helper
recovery regressions reproduce the early return. The [macOS job passed on `08eed1128`](https://github.com/ajmariduena/paseo/actions/runs/37905242577/job/113737292319),
including the storage and reconciliation mutation gates. Helper-recovery changes still need fresh
CI evidence.

Workspace archive acquires all target identities and backing/source paths before stopping setup,
archiving agents or executing teardown. It holds admission through directory removal and final
updates, including failure. Real-worktree tests cover shared directories, archived-record retries,
orphan paths and cancellation. The same ledger reaches RPCs, agent tools, merge automation,
schedules and creation cleanup. Project removal also fences its workspaces before archiving any.
Real registry tests hold removal writes across preparation, and the boot test covers both archive
RPCs and project removal. Archive remains best-effort shutdown; its success cannot certify source
quiescence. Plugin callbacks and shared Git metadata still need integration.

Manual and automatic storage cleanup admit the target paths, archived workspace identities and
source repository before teardown or deletion. Git pruning separately admits every registered
worktree, including missing directories and checkouts outside managed storage. A fence retains
those stale registrations until cancellation. Storage inspection disables Git's optional index
writes. Real-worktree tests cover unchanged index bytes, cancel/retry, shared paths, stale entries
and teardown/removal checks held across preparation. Daemon shutdown awaits an in-flight sweep;
its WebSocket cleanup and automatic-sweep context both receive the boot ledger. Teardown descendants
still need coordinator stop inventory and confirmed process-tree termination.

These tests do not establish the complete ownership promise: draft catalog runtimes,
standalone teardown hooks, remaining background workspace mutations,
shared Git metadata ownership, runtime termination and destination activation still need
integration.
Source history needs a readable path that does not reopen a fenced native runtime. Source release
explicitly refuses Windows until durable directory updates
have an implementation there; archive staging alone does not satisfy that requirement.

Before the workspace slice is complete, cover directories without Git. Directory-entry durability
belongs in the transaction's ready/commit boundary. Linux tests do not establish macOS or Windows
behavior. Path collision checks include index-only entries and directory segments. External Git
attribute rules require moving into `.gitattributes` before capture or restore: Git reads them
outside the checkout, and the handoff does not transport host configuration. Attribute-location
discovery requires a Git version supporting `GIT_ATTR_SYSTEM` and `GIT_ATTR_GLOBAL`; unsupported
Git versions get an explicit update request. See [Git attributes](https://git-scm.com/docs/gitattributes)
and [Git logical variables](https://git-scm.com/docs/git-var).

Git bundle and patch generation now uses the shared Git scheduler's bounded file sink. It applies
backpressure while writing and keeps stdout out of daemon memory. The existing real-process Git
suite covers full binary output, byte ceilings, failed commands, and occupied output paths.

| Requirement                                    | Required evidence                                                                                               | State   |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------- |
| Bounded, resumable, integrity-checked transfer | Archive unit + two-daemon tests pass on Linux; CI platforms, aggregate disk quota and lifecycle cleanup pending | Partial |
| Workspace fidelity                             | Real Git repos/worktrees; binary, staged/unstaged, rename/delete, untracked, modes, symlinks; source unchanged  | Pending |
| Ownership never overlaps                       | Fault injection at each persistence boundary; cancel/release race; lost replies; daemon restart                 | Pending |
| Every mutation respects the fence              | Prompts, native resume, scripts, terminals, file/Git mutations, queue, automation and delegation tests          | Pending |
| Native sessions                                | Real provider resume on two isolated homes, history continuity and next turn; incompatible version rejection    | Pending |
| Explicit context continuation                  | Complete preserved history, visible mode, destination provider/config mapping and next turn                     | Pending |
| Multi-agent/workspace relationships            | Descendants, cross-workspace children, shared checkout writers, archive and return transfer tests               | Pending |
| Existing trust boundaries                      | Existing semantic permissions, no transferred credentials/grants, target/manifest-bound release, replay tests   | Pending |
| Client and app                                 | Capability gate, host picker, preflight, progress, cancel, retry, reconnect, destination navigation             | Pending |
| Protocol compatibility                         | Pure optional extensions, old/new client parsing and feature negotiation                                        | Pending |
| Real network                                   | Archive transport passes two-daemon restart/drop/retry tests on Linux; full cutover still pending               | Partial |
| Platform coverage                              | Linux and macOS transfer both directions; Windows path behavior; native app and browser UI evidence             | Pending |
| Delivery                                       | Typecheck, lint, formatting, focused tests, PR with raw evidence, CI results                                    | Pending |

Keep feature code in `server/handoff`, with provider-owned native codecs and a client coordinator.
Use dotted `workspace.handoff.*.request/response` RPCs. Follow the existing
[permission](../permissions.md), [protocol](../protocol-compatibility.md), and
[testing](../testing.md) contracts.
