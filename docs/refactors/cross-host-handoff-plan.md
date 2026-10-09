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

Stop transferred conversation runtimes and known Paseo-owned writers before capture. Keep the
source admission fence until destination ownership is durable. An uncertain stop, missing worker
acknowledgement, unreadable inventory, or persistence failure cannot certify readiness. Keep the
identity and stop result of each owned launch through retry and daemon restart; root process exit
alone does not prove that observed descendants stopped.

This is a managed-resource contract. Paseo cannot freeze unrelated editors or prove that a process
it never observed did not daemonize. Detect changes during capture, recheck before release, and tell
the user that later source edits do not synchronize. Do not expand handoff into a general OS process
supervisor. The existing POSIX terminator retains observed descendants in memory; launch-time and
restart recovery still need integration into source preparation.

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

Before release, cancellation must durably win the source's cancel/release race before discarding
the inactive destination. A lost release reply must not let destination cleanup destroy the only
prepared copy while the source is irrevocably fenced.
The source issues a signed cancellation bound to the destination reservation. Record it even if
preparation has not arrived, so a delayed prepare cannot revive the cancelled transfer. Destination
cleanup requires that proof and the previously pinned source key when content is already bound.
After release, a lost acknowledgement leaves the source fenced: query/retry the same transfer,
never infer rollback from a timeout. Once the destination has durably accepted the signed receipt,
finish activation using its journal even when the source is offline. Until that acceptance, recovery
still needs the source to resend its receipt. Returning ownership requires a new handoff. Journals load
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

Keep non-Git workspaces as directories, including empty directories; do not create a repository
or run setup when restoring them. Evaluate their local and nested `.gitignore` files without
inheriting host-wide Git exclusions. Preserve unborn Git branches and their staged contents.
Shallow/partial clones, sparse checkouts, submodules, LFS, intent-to-add, conflicts, and in-progress
Git operations need either fidelity tests or a visible preflight refusal with a resolution.
Ignored files (including `.env` and dependencies) are omitted and listed before moving; tracked
secrets remain tracked data. Do not copy Git configuration or hooks. Transfer usable remote URLs
only after removing embedded credentials; validate this separately from file fidelity.

## Provider evidence

The current `AgentClient` exposes local resume and import, not cross-host export. A persistence
handle is not a portable session. Each native adapter must own its exported artifacts, version
compatibility, destination path rewriting, session-ID collision handling, and read-back validation.
Do not copy a provider's whole home directory or databases shared with unrelated sessions.

- Claude's native codec preserves the raw session transcript and scoped sidechain artifacts.
  Each import gets its own `CLAUDE_CODE_PROJECT_DIR_NAME` under the destination's configuration
  directory. Keep that namespace in the persistence handle: a return trip retains the native
  session ID, so searching all project directories could select the stale source copy. Current
  native import requires matching 2.1.x versions at least 2.1.295; workflow artifacts are preserved
  but refused for native activation until automation dispositions are implemented. Credentials and
  source launch configuration are excluded. Sources: [cross-host resume](https://code.claude.com/docs/en/agent-sdk/sessions#resume-across-hosts)
  and [session storage](https://code.claude.com/docs/en/agent-sdk/session-storage).
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

Finish one usable transfer before adding more standalone admission checks. Keep the complete
handoff capability unadvertised until all four gates have direct evidence. Primitive tests and
archive transport tests do not establish conversation ownership or provider continuity.

### 1. Usable transfer

Connect source preparation, archive transport, private destination staging, signed release and
idempotent activation. Start with a Git workspace and a Claude conversation, using two isolated
provider homes. Persist the source/destination host IDs, pinned source key, reservation, digest,
chosen mode and stable workspace/agent/session mappings before side effects.

Cancel setup and long-running operations before draining their admission leases. Stop each owned
runtime, drain events and use an error-reporting persistence barrier before exporting history.
Capture workspace and provider artifacts into the source archive. Recheck both before release;
changes require a fresh preparation, never activation with a stale digest.

Destination preparation must restore privately without running hooks, setup, MCP servers or turns.
Install provider artifacts and closed agent records under preallocated IDs. Journal each activation
step so a restart or lost reply cannot duplicate a workspace or conversation. After release, recovery
moves forward. Keep source history readable without reopening its fenced provider runtime. Retire
the source transfer with agent tombstones and a moved destination reference; permanent broad path
fences must not prevent unrelated future work or exhaust the journal.

Evidence: real two-daemon cutover, a real continued turn using information found only in the prior
conversation, a destination file edit, source prompt refusal and source history after restart.
Exercise cancel, a dropped release reply and interruption at every journal transition. A file-backed
test provider can prove transaction recovery; it does not prove native provider compatibility.

### 2. Fidelity and return

Prove native resume for each enabled provider with two isolated homes and different absolute paths.
Cover version incompatibility, native session-ID collisions, compaction, attachments, interrupted
tools, provider restart and a return transfer into a fresh checkout. Use destination credentials
and permission policy. Existing import methods that start a runtime or allocate fresh random IDs
cannot serve as an idempotent inactive installation step.

For every unsupported native path, preserve available history and attachments, show the explicit
context-export mode, and prove the next turn receives the bounded brief and can access the complete
transcript. Report unavailable raw tool output or provider artifacts. Never silently truncate the
only surviving history, replay pending tool calls or restore provider automation accidentally.

Workspace evidence includes Git/worktree history and index state, non-Git and unborn workspaces,
binary bytes, executable modes, symlinks, ignored paths, portable names, receiver limits and source
change detection. Verify sanitized remotes and forge behavior independently.

### 3. Recovery and resource coverage

Resolve the complete conversation set, including archived agents and same-workspace descendants.
Include or explicitly refuse other writers sharing the checkout. Give cross-workspace children and
open delegations a stated disposition. Transfer queued messages held, invalidate pending approvals,
and remap schedules and heartbeats into a paused state. State what happens to goals and PR watches.
Do not transport source host IDs or authority as if they belonged to the destination.

Verify the finite resource inventory used by the coordinator: provider runtimes, terminals, setup,
teardown, scripts, queues, automation, plugin callbacks and shared Git metadata. New mutation entry
points need an explicit classification. An uncertain terminal worker exit needs recoverable stop
state, not an admission lease that can wait forever without explanation. Recovery must preserve
known process identities after owner exit and must not kill a reused PID or unrelated shared server.

Enforce destination reservations, host-wide disk quotas and staging cleanup. Test malformed manifests,
missing/corrupt journals, replayed or mismatched receipts, destination collisions, full disks,
transient disconnects and concurrent cancel/release. Keep memory and chunk sizes bounded.

### 4. App and delivery evidence

Provide the workspace action, paired-host picker and capability gate on both hosts. Preflight shows
provider mode and reason per conversation, omitted files/integrations, stopped work and transfer size.
Keep progress and actionable errors visible. Support retry, cancellation before release and recovery
from daemon journals after reopening the app. Navigate to the destination and show the source's moved
state. Follow the existing forms and routing contracts.

Required evidence: a real MacBook → Linux VPS → MacBook round trip, both native and context-export
continuation, browser/Electron and native iOS/Android flows, client/daemon version drift, and the
existing CI matrix. Windows paths and archive staging remain tested; source release stays explicitly
unavailable there until durable directory updates are implemented. Run focused tests locally and
full suites in CI. The PR needs raw results plus typecheck, lint and formatting checks.

## Current evidence and integration gaps

- `server/handoff/workspace.ts` and its neighboring tests cover Git and directory snapshots,
  restoration and source rechecks. `packWorkspaceArchive` registers the manifest as an archive blob,
  including an empty workspace; restoration consumes only referenced blobs in the verified inventory.
  Git capture still omits empty untracked directories; preserving or reporting them remains open.
  Read-only review uses the capture's ignore rules and portable-path checks to estimate file and
  Git-history bytes. It reports file/folder/link counts and the first fifty ignored paths with the
  total omitted-path count; ignored directories are collapsed. Tracked files matching ignore rules
  remain included. Estimates are advisory while the source is running; the stopped capture still
  determines the archive. Reviewing a directory does not add Git metadata or change its contents.
- `archive.ts`, `archive.test.ts` and `archive.e2e.test.ts` cover persistent receive offsets,
  checksums, local capture import, and real two-daemon transport. The client coordinator in
  `packages/client/src/handoff-transfer.ts` holds one chunk in flight. The network suite transfers
  captured workspaces and fixture conversations through this path. The source also captures a bounded
  readable timeline from the frozen native artifacts, using the normal notification and message presentation. Its blob is
  bound into the bundle digest. The existing timeline RPC reads that snapshot for a prepared or
  released source without loading a provider, including after source restart or deletion of the
  original transcript. Cursors remain stable across restart; corrupt, foreign, incomplete and
  oversized history fails explicitly. Native artifacts remain the unabridged provider copy.
  Activated destinations serve paginated previous-conversation history from their private verified
  archive. Reading it never starts a provider and does not depend on the source or editable exported
  files. A network regression restarts the destination, stops the source, removes those workspace
  copies and reads three pages with stable cursors. Staged and unknown conversations are refused.
  Each read verifies the requested metadata and history blobs, without rehashing the workspace.
  `packages/client/src/workspace-handoff.ts` coordinates inspection, reservation, source preparation,
  transfer, staging, signed release and activation through correlated `workspace.handoff.*` RPCs.
  Retry reuses the hosts' journals and transfer ID. A network regression loses the release reply,
  restarts both hosts and removes the original directory before recovering the same destination
  workspace. It also restarts the destination after accepting release and activates with the source
  stopped. Activation without a stored receipt and mismatched source identities are refused.
  Invalid release signatures are refused. The app retains the transfer ID and operation
  intent before sending mutating RPCs. Source-journal discovery finds the held transfer by workspace
  even after source-directory removal; its response contains no private signing key. Cancellation uses the source's durable proof
  before discarding destination staging. Tests cover a delayed prepare, lost cancellation replies,
  host restarts, wrong keys and signatures, persistence failures, and both cancel/release orderings.
- `ownership.ts`, `ownership.test.ts` and `bootstrap.test.ts` cover durable source fences,
  admission draining, cancel/release races, signed receipts and loading fences before providers.
  Admission is wired through agent operations, files/Git, terminal creation/input/resize, scripts,
  setup, provisioning, worktree lifecycle, reconciliation and storage cleanup. Their owning test
  files carry the regressions. `source.ts` now coordinates fencing, setup/provider/terminal stop,
  admission draining, a durable closed-record checkpoint, workspace/native capture and release
  revalidation. It rereads the agent inventory strictly instead of silently skipping damaged records.
  Failed cleanup leaves the transfer preparing and fenced; a successful retry captures only after
  stop confirmation. Archived, delegated and non-Claude conversations are currently refused.
  Error-reporting barriers for background event failures, launch-time provider configuration and
  complete resource dispositions remain open.
- `destination.ts`, `ownership.posix.test.ts` and `archive.e2e.test.ts` cover durable destination
  reservations, stable identity mappings, private workspace staging and signed release acceptance.
  Bootstrap owns the destination journal and shares one archive store with WebSocket transport.
  `bundle.ts` binds workspace and native conversation artifacts to one signed digest and requires
  exactly the reserved conversation set. The reservation fixes native or context-export continuation;
  retries cannot change that choice. Native preparation journals the current host's Claude location
  before installing under the reserved agent IDs; retries retain that location across configuration
  changes. Cancellation removes only the transfer's inactive sessions after source cancellation.
  Activation publishes the reserved project, workspace and closed agent IDs after source release.
  Registry reads and mutation admission remain closed until the activation journal is durable;
  bootstrap recovers interrupted publication before loading agents. Tests reconstruct the stores
  after failures before, during and after publication, including lost journal acknowledgements.
  Repeated activation preserves later agent edits. Two-daemon tests publish fixture conversations,
  retain Git/directory workspace identity and recover the same IDs after restart. They use a
  version-only launcher; native provider continuation has separate evidence below.
  Missing, corrupt or foreign destination journals prevent startup. The final checkout move uses
  an identity-checked POSIX rename; atomic no-replace behavior against external filesystem writers
  remains an acceptance gap.
- Context export uses the captured Claude timeline and original provider artifacts without invoking
  the destination's native importer. It places verified copies inside the new workspace so a sandboxed
  session can read them, refusing path collisions and changed bytes before activation. The imported
  agent has no source persistence handle. Its first turn receives a bounded, explicitly historical
  excerpt and paths to the complete files; failure keeps that context pending, and success persists
  delivery across restart. Tests cover missing history, collisions, damaged context, publication
  recovery and bounded Unicode excerpts. A real two-daemon Claude test uses the client coordinator
  and RPCs, starts a new session and recovers a prior-only token from exported files to write in the
  destination workspace. Reservation
  status and agent labels expose the mode. Historical decoding materializes only an isolated copy;
  native activation policy must not prevent reading exported history. A workflow-bearing fixture
  now exports its history while native installation still refuses its automation state.
  The app shows native/context availability and reasons for each conversation, using read-only
  source-artifact and destination-version inspection. The chosen mode still applies to the whole
  workspace; mixed per-conversation choices remain open. Destination conversations identify native
  continuation versus a new session with exported history and open a read-only previous conversation
  with its source host and path. Historical links retain source authority and may be unavailable;
  they must not resolve against the destination's workspace by accident.
  Source decoding still uses the tested Claude codec; other providers and incompatible source
  formats are not yet exportable. External attachments are reported as unavailable, not transported.
- `utils/tree-kill.test.ts`, `managed-processes.test.ts` and `bootstrap-managed-processes.test.ts`
  cover observed descendant termination, helper retention and awaited startup recovery. The
  coordinator still needs launch-time ownership and durable uncertain-stop recovery.
- `agent/providers/claude/handoff.ts` captures bounded raw transcripts and sidechains, detects source
  changes and installs under stable import IDs without a runtime. The existing history suite proves
  inactive retries, corruption/limit refusals, source edits and exact-namespace history loading.
  `sdk-behavior.real.e2e.test.ts` proves a real Claude Code 2.1.295 round trip on Linux with two isolated
  configuration directories and three workspace paths: prior-only tokens survive, destination edits
  occur there and the original transcript remains unchanged. A second real test uses two isolated
  daemons and a Git workspace: source preparation closes the actual runtime, the client transfers
  the archive, signed release permits destination activation and a continued native turn recalls
  the prior-only token and writes it in the new checkout. A source prompt over WebSocket and a
  direct resume are both refused after release; the original transcript remains unchanged. After
  restarting the source without provider clients, the timeline RPC returns the same history and
  cursor epoch while a new source prompt remains refused.
  Compaction, external attachments, file checkpoints, rewind/fork namespace handling and cross-OS
  evidence remain open before enabling native handoff.
- `packages/app/src/handoff` connects the workspace menu to the client coordinator. Its form persists
  transfer identity and intent before host mutations, preserves the selected mode across reopening,
  and exposes review, prepare, activate, retry, cancel and destination navigation. Review does not
  stop work or reserve a destination. Read-only placement errors leave the form editable. The source
  review also shows estimated workspace/provider bytes, ignored paths, live conversation count,
  terminal names and active setup count. Terminal enumeration is shared with preparation and
  deduplicates nested buckets. The network regression leaves terminals running during review and
  confirms their exit during preparation; the setup regression retains its active count through an
  uncertain stop until cleanup succeeds. The browser test recovers from a nonportable source path,
  shows the ignored `.env` and running terminal, and verifies the excluded file is absent in the
  destination. Review content scrolls above the pinned actions at compact width.
  The source conversation set is checked again before reservation; a changed set returns the form
  to review.
  Source workspace snapshots project ownership from the durable journal, including live updates
  through preparation, cancellation and release. The app keeps ownership beside the cached
  directory cursor: a reconnect with no newer rows must not reopen source controls. Reconnecting
  does not depend on local transfer storage. The source banner opens preparation/recovery or checks both hosts before navigating to
  the original activated destination. Removing the destination host leaves an actionable error.
  Existing source conversations hide their composer and fork controls while held; cancellation
  restores them. Source drafts retain their unsent text but hide the composer, reject drops and
  pause automatic submission. Agent, terminal and profile launchers, keyboard shortcuts and session
  import follow the same ownership projection, including after reload. Pending terminal creation is
  discarded when ownership is held. File, Git, script and other workspace mutation affordances still
  need the same treatment; server admission remains authoritative. Source retirement still needs
  tombstones to replace broad path fences.
  Fourteen form cases cover unavailable modes, inventory changes, lost replies, storage failures,
  duplicate submissions, closing during work, cancellation recovery and host journals advancing
  past local state, including destination lookup and selection failures. Reconstructed records retain
  the reserved mode and reject mismatched host, workspace, reservation, conversation set or digest;
  a released source restores forward recovery. Selecting a destination queries its unfinished
  reservations in pages of twenty, scoped to the source host and workspace. The user chooses an
  existing transfer before resuming; discovery and selection do not prepare or publish work.
  A matching cancelled source record restores cancellation intent so interrupted destination cleanup
  can finish. The network regression discovers twenty-one reservations after destination restart,
  verifies both scope filters and excludes completed cancellation.
  The network suite covers matching/mismatched Claude versions, missing source
  history and workflow artifacts without starting a provider turn during review. The feature
  gate is checked on both hosts before preparation; only isolated test daemons advertise it. Four
  browser cases use real isolated daemons and a directory workspace: desktop preparation/reload
  verifies bytes and destination navigation after a real activation conflict and source shutdown;
  compact recovery deletes the local transfer record, reloads the same identity and context mode
  from both host journals, then cancels and verifies a fresh form after clearing local state again.
  Destination-only recovery selects one of two reservations, preserves its original mode without
  preparing work until Resume, then reconstructs and finishes an interrupted source cancellation.
  The source link case removes the destination host, checks its visible error, reconnects and opens
  the same activated workspace. After release and reload, it also verifies disabled agent, terminal
  and profile launchers through the menu and keyboard. Compact cancellation restores an unsent
  draft across reload and creates a real terminal afterward. These recovery fixtures contain no
  conversations. The new source
  conversation UI assertions still need a passing real-provider run: the latest native attempt failed
  with an invalid Claude OAuth refresh token; context mode timed out waiting for the initial reply.
  Two additional real-provider browser cases use
  Claude Code 2.1.295, Git workspaces and separate source/destination configuration directories on
  Linux. They review, prepare, activate, navigate and continue through the app. Native continuation
  shows the original message and retains the provider session ID; context export starts a new session
  and reads a prior-only token beyond the supplied excerpt from the exported files. Both approve the
  destination Write permission through the UI, verify the destination file and absent source file,
  and refuse source prompts before and after continuation. Both modes also open the previous
  conversation in the destination UI. Corrupting the private archive produces a visible error;
  restoring the bytes and choosing Retry reveals the original message and source provenance without
  a composer or replaying a turn. The context-export case exercises that sheet at compact width;
  its first run exposed missing pane context across the portal, now covered by the regression.
  See the [history results](../qa-evidence/handoff-history.txt),
  [preflight results](../qa-evidence/handoff-preflight.txt),
  [source ownership and UI results](../qa-evidence/handoff-source-state.txt),
  [source launch controls results](../qa-evidence/handoff-source-controls.txt),
  [real-provider browser results](../qa-evidence/handoff-app-real.txt),
  [recovery app results](../qa-evidence/handoff-app.txt)
  and [review](../qa-evidence/handoff-review-compact.png), [pending transfers](../qa-evidence/handoff-existing-transfers.png), [desktop](../qa-evidence/handoff-app-desktop.png) / [compact](../qa-evidence/handoff-app-compact.png)
  screenshots. Recovery without local state currently requires both paired hosts online. Destination
  lookup starts only after selecting that host. Cancellation before source preparation leaves only a
  tombstone; automatic discovery of that cancellation intent remains open, as does unfinished cleanup
  after the destination journal already says cancelled. Reopening recovery when the source workspace
  is unavailable, pinned-key client persistence,
  complete omitted-path access and integration/resource dispositions, complete source mutation
  affordances and native-platform evidence remain open. Review does not bind approval to a resource digest or
  revalidate reviewed exclusions before preparation; final transfer size is not shown separately.
- Source retirement/tombstones and automation dispositions remain unimplemented.
  The composite archive currently captures Claude conversations;
  other provider codecs remain open. Complete handoff is not advertised.

Keep feature code in `server/handoff`, provider transport in provider-owned codecs and orchestration
in the client coordinator. Use dotted `workspace.handoff.*.request/response` RPCs. Follow the
[permission](../permissions.md), [protocol](../protocol-compatibility.md), and
[testing](../testing.md) contracts. Directory-entry durability belongs at the transaction's ready and
activation boundaries. External Git attributes require an explicit resolution before transfer; see
[Git attributes](https://git-scm.com/docs/gitattributes) and
[Git logical variables](https://git-scm.com/docs/git-var).
