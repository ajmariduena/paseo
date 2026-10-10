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
Reading a journal after a process restart does not prove its last rename was synchronized. Finish
file and directory publication before enabling recovered ownership or issuing a receipt. A recovered
release keeps its original binding and never repeats the release decision against mutable source data.

### Conversation persistence contract

The complete conversation barrier remains implementation work. Certify a conversation from durable
inputs, resolved storage obligations and a provider that has finished delivering semantic callbacks.
Keep recovery metadata in the existing agent and presentation stores. A stopped runtime can still
have uncertified state; cancellation, user acknowledgement and a new runtime do not repair it.

Durably mark a runtime generation open before calling a provider's create, resume or import method.
Guard later writes by generation and record revision. Preserve an immutable final candidate when
the provider stops but publication fails, so retry can complete storage without reopening the provider.
Queue progress must remain independent of each operation's outcome. A later snapshot repairs only
fields it actually contains, never an unknown partial handler or a record-owned acknowledgement.

Retain bounded obligations for carried restart notes, handoff context and presentation publication.
Publish their exact identities and retry inputs before dispatch or other external effects. Bind
annotations to native message identities with prepared, dispatched and withdrawn dispositions;
repeated text and prepended context cannot establish that identity. Prove the required completion
milestone before clearing carried notes. Absence from compacted or incomplete artifacts does not
prove a prompt was never sent. Recovery never replays a prompt or tool to discover the outcome.

Keep required presentation facts without sliding-window eviction. Reserve capacity for daemon error
rows before admitting a turn, and account for any unavailable detail explicitly. Retain full content
or identify the omission; a truncated row cannot certify complete content. Publish an exact pending
presentation revision before writing its file, then synchronize it and commit its coverage reference.
Recovery may finish that known publication, but cannot adopt an arbitrary suffix. Legacy entry counts
and text matches do not prove lifetime coverage; preserve available history and state when full
fidelity is unproven.

Provider closure must drain current and retiring message producers, hooks and deferred delivery before
removing subscribers. Track admitted manager work and its descendants per conversation, isolate
client delivery failures from authoritative effects, and prevent stale work from changing a sealed
record. Crash recovery also requires the separate durable process-stop proof. Bind the checkpoint,
presentation coverage, native artifacts and resource dispositions into preparation and release.
The optional durable timeline backend needs its own checkpoint and restart-safe invalidation before
it can participate; production's provider-derived timeline does not require a second transcript store.

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
secrets remain tracked data. Reconstruct remote URLs after removing embedded credentials; do not
copy Git configuration or hooks wholesale. Resolve source URL rewrites before capture so aliases
do not depend on the source's configuration. Destination authentication remains host-owned.
Validate remote and forge behavior separately from file fidelity.

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

- Agent-record publication retains immutable failed writes for same-process retry and withholds
  acknowledgement until the operation's required synchronization completes. Strict handoff inventory
  repairs retained candidates before inspection, so a failed closed-record write can recover without
  reopening its provider. Monotonic record revisions now reject stale full-record replacements;
  identical retries retain their committed revision after restart. Preparation binds the closed
  checkpoint revision, so changing metadata and restoring its old value still refuses release.
  Failed provider imports revert only their own placement/label patch, preserving newer metadata
  and recovery obligations. Store writes and deletes now participate in release admission. A durable
  ownership-journal seal closes them before final verification and remains after a failed verification
  or restart until cancellation is durable. Existing publication repairs and legacy annotation
  adoption finish before sealing; unchanged checkpoints remain available afterward. This closes the
  record-write window between verification and release, without proving callback or process quiescence.
  See the [record contract](../data-model.md#record-revisions) and
  [persistence evidence](../qa-evidence/handoff-checkpoint-recovery.txt).
  Registered, non-internal conversations now publish an opening generation before provider create,
  resume, import or reload. POSIX publication synchronizes the file and its directories; Windows
  keeps ordinary atomic persistence and still cannot release a handoff. Old-generation snapshots
  and attempts to reopen a closed generation fail. Unclosed predecessors survive a new runtime and
  a later clean close, and prevent handoff until recovery proves their outcome. Capacity exhaustion
  refuses another opening instead of discarding predecessors. This records uncertainty; it does
  not implement the repair proof. Claude close and query replacement now retain each query until
  its process stop, message drain and iterator return complete. Native stdout drains before SDK
  cleanup; pending submission callbacks run before subscribers are removed. Timeouts preserve the
  pending operation for retry, and message-handler failures refuse closure. Reload reads the final
  persistence handle after provider shutdown. Closure also joins admitted provider control, opening
  and rewind work before removing subscribers; a timeout retains that work for retry. New public
  mutations are refused during closure, while repeated interruption joins the close. Concurrent
  control requests share one query opening. Each query owns its SDK permission and hook callbacks;
  retirement cancels pending permissions and joins callbacks after SDK cleanup. Late callbacks and
  failed hook observations refuse certification. Failed or canceled plan approvals settle their
  original SDK callback without a later approval or duplicate resolution. Manager session events
  retain their originating runtime identity. Close and reload join event handlers, runtime-info
  refreshes and carried-note/context settlement; timeouts retain pending work. An unknown handler
  fault still stops the provider but refuses a closed snapshot. Its open generation remains unresolved
  after restart and a later clean generation. Client delivery errors are isolated per subscriber.
  Restart recovery now retains its intent file after pending-note failures, including a declined
  continuation. Later shutdowns preserve unresolved background notes; late continuations cannot
  delete newer shutdown input. POSIX note acknowledgement synchronizes publication before intent
  consumption. A dispatch receipt alone cannot clear an unsaved note. This repairs that storage
  obligation; it does not repair unknown manager event faults. Carried restart notes and handoff
  context now have a bounded, durable pre-dispatch identity. Completion atomically acknowledges
  only that delivery; newer notes and replaced context are preserved. Known publication failures
  retry without another provider call. Unknown invocations survive snapshots, restart and new
  generations, block subsequent turns and refuse handoff certification. Native carried prompts
  retain their UUID even without a caller message ID, and capture checks its presence.
  Unsent restart notes are now part of the verified bundle and remain pending after native or
  context activation and restart. Source release refuses a changed note set. Versioned bundles
  make older readers refuse unsupported metadata; retained archives remain readable. See the
  [carried-context contract](../data-model.md#carried-context-acknowledgement).
  Artifact-based recovery of uncertain completion, remaining manager descendants and producer
  quiescence, presentation coverage and durable process-stop recovery remain open under the
  [conversation persistence contract](#conversation-persistence-contract).
- New Claude notification/origin annotations bind a prepared attempt to its native UUID before
  provider start or steer, and persist the adapter's dispatched/withdrawn result. Replay uses that
  identity across repeated text and prepended context. Handoff refuses unresolved attempts or a
  dispatched UUID missing from captured history. A durable agent-record witness detects annotation
  rollback after restart. Its pending entry change repairs the exact previous or intended file;
  unrelated content refuses. Known disposition-write failures retry on close without another
  provider turn, and release compares the captured witness even when rendered rows are unchanged.
  Required annotations no longer use sliding-window eviction. Annotation writes require a loaded
  runtime and pass the source mutation fence. See the
  [annotation store contract](../data-model.md#prompt-annotation-store) and
  [focused evidence](../qa-evidence/handoff-checkpoint-recovery.txt). This does not establish legacy
  lifetime coverage, prove a turn's completion, or repair ambiguous dispatch after a crash. Error-row reservation and other provider identities
  remain open. The capability stays unadvertised.
- `server/handoff/workspace.ts` and its neighboring tests cover Git and directory snapshots,
  restoration and source rechecks. `packWorkspaceArchive` registers the manifest as an archive blob,
  including an empty workspace; restoration consumes only referenced blobs in the verified inventory.
  Git capture still omits empty untracked directories; preserving or reporting them remains open.
  Read-only review uses the capture's ignore rules and portable-path checks to estimate file and
  Git-history bytes. It reports file/folder/link counts and the first fifty ignored paths with the
  total omitted-path count. Further pages expose every collapsed exclusion, fifty entries at a time,
  tied to the same review digest. An ignored directory represents its entire subtree; the review
  does not enumerate its children. Tracked files matching ignore rules remain included.
  Estimates are advisory while the source is running; the stopped capture still
  determines the archive. Reviewing a directory does not add Git metadata or change its contents.
  App review binds the source directory, included paths/types/modes/link targets, Git HEAD/index
  and the complete collapsed omission list to a digest retained by both host journals. Changing
  that boundary before reservation returns the app to review without stopping work. Source
  preparation rechecks before fencing and during capture; release rechecks before issuing its
  receipt. Ordinary working-file content edits remain allowed before capture so editor saves do
  not invalidate review. Capture verification still binds their final bytes. Tests cover Git and
  directory exclusion changes, same-count renames and omissions beyond the visible sample.
- Git snapshots retain effective fetch/push remote URLs, including distinct push destinations,
  without HTTP userinfo or passwords. SSH login names remain part of the remote address. Local
  paths, file URLs, custom helpers, queries/fragments and unsupported remote names require a
  read-only preflight resolution. Source review and release bind the sanitized destinations;
  rotating embedded credentials alone does not invalidate review. Destination verification
  compares installed URLs independently of host authentication rewrites. Focused tests cover
  worktrees, unborn branches, malformed manifests, forge identity resolution, transport and
  activation after destination restart; see [remote evidence](../qa-evidence/handoff-remotes.txt).
  Branch upstreams, custom refspecs, remote-tracking refs and push policies are not reconstructed;
  their fidelity/dispositions and authenticated forge operations remain open. SSH aliases and
  credentials must exist on the destination. No remote network request runs during capture or
  restore. Git owns rewrite resolution through [remote get-url](https://git-scm.com/docs/git-remote).
- `archive.ts`, `archive.test.ts` and `archive.e2e.test.ts` cover persistent receive offsets,
  checksums, local capture import, and real two-daemon transport. The client coordinator in
  `packages/client/src/handoff-transfer.ts` holds one chunk in flight. The network suite transfers
  captured workspaces and fixture conversations through this path. The source also captures a bounded
  readable timeline from the frozen native artifacts, using the normal notification and message presentation. Its blob is
  bound into the bundle digest. Annotation export waits for that conversation's queued writes and
  validates the stored metadata rather than accepting a stale cache or silently ignoring a damaged
  file. Readiness and release compare the current presentation with the captured history, including
  after source restart. Native/context network cases refuse damaged metadata during preparation,
  retain the source fence, recover after repair and refuse changed notification presentation before
  release. See [history persistence evidence](../qa-evidence/handoff-history-persistence.txt) and the
  [annotation write contract](../data-model.md#prompt-annotation-store).
  The existing timeline RPC reads that snapshot for a prepared or
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
  before discarding destination staging. Read-only source status exposes cancellation even when
  preparation never created a source snapshot. The destination persists the accepted proof before
  cleanup and records completion after durable deletion; interrupted cleanup remains discoverable
  and fenced across restart. Retries reuse the accepted proof without contacting the source.
  Completed retries preserve later files at the former staging path. Tests cover a delayed prepare,
  lost cancellation replies, host restarts, wrong keys and signatures, persistence failures,
  interrupted native-artifact cleanup and both cancel/release orderings.
- `ownership.ts`, `ownership.test.ts` and `bootstrap.test.ts` cover durable source fences,
  admission draining, cancel/release races, signed receipts and loading fences before providers.
  Admission is wired through agent operations, files/Git, terminal creation/input/resize, scripts,
  setup, provisioning, worktree lifecycle, reconciliation and storage cleanup. Their owning test
  files carry the regressions. `source.ts` now coordinates fencing, setup/provider/terminal stop,
  admission draining, a durable closed-record checkpoint, workspace/native capture and release
  revalidation. It rereads the agent inventory strictly instead of silently skipping damaged records.
  Failed cleanup leaves the transfer preparing and fenced; a successful retry captures only after
  stop confirmation. Archived, delegated and non-Claude conversations are currently refused.
  Reviewed preparation retains the selected provider-session and terminal instances and setup-run
  identities in both journals. A changed set before preparation requires a new review; after
  fencing, retries permit completed stops but refuse new or replacement writers. Provider closure
  checks the reviewed session inside its lifecycle lock, including when a reload was already queued.
  Readiness and release refuse surviving terminals or setup. These identities bind stop approval;
  they do not establish OS process identity or recover uncertain descendants after daemon restart.
  Error-reporting barriers for other background event failures, durable process ownership, broader
  launch configuration and complete resource dispositions remain open.
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
  source-artifact and destination-version inspection. A multi-conversation review lets you retain
  native sessions where compatible and explicitly select exported history for another conversation.
  The selected plan is fixed in the destination reservation and local recovery. A changed retry is
  refused. Native installation, context files, cancellation cleanup, labels and readable history
  follow each conversation's choice. Recovery without local state retains the same plan; the transfer
  summary identifies mixed continuation. The [mixed-continuation evidence](../qa-evidence/handoff-mixed.txt)
  separates synthetic session transport/UI coverage from real-provider continuity.
  Destination conversations identify native continuation versus a new session with exported history
  and open a read-only previous conversation
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
  Source capture now uses each conversation's observed storage root and producer version, rather
  than probing the currently configured executable. The [persistence contract](../data-model.md#nested-persistencehandle)
  keeps this host-local pointer separate from portable context. Source release rechecks it after
  restart. Conversations without observed provenance require a source turn before a new capture;
  already prepared journals retain their recorded runtime. Native destination publication records
  its local installation, allowing review for a native return transfer before the first continued
  turn. Before a context-mode destination opens a local runtime, it can transfer again using its
  private verified archive. Three-hop coverage retains original provenance, history, provider
  artifacts and pending notes after visible context copies are deleted or ignored. Review offers
  context mode, and staging refuses a forced native choice. Restart and release checks reject
  changed context or damaged archived history; see [checkpoint evidence](../qa-evidence/handoff-checkpoint-recovery.txt).
  After new local work, the archive retains earlier history and artifacts as separate segments
  with their original host and paths. Native activation resumes the current session and supplies
  a brief pointing to the verified history index. A same-session native return preserves the
  earlier segments without adding a duplicate. The previous-conversation sheet selects a segment
  before paginating or opening source links. An opened runtime without a saved session still
  requires recovery. See the [carried-context contract](../data-model.md#carried-context-acknowledgement).
  Interrupted publication from older journals remains idempotent. Provider and real-daemon tests
  cover changed configuration, different roots/versions in one workspace, final metadata at close,
  legacy recovery and credential-environment preservation; see [runtime evidence](../qa-evidence/handoff-runtime.txt).
  These use synthetic SDK events and transcripts, not a fresh authenticated provider turn. They do
  not establish process identity, credentials, command-wrapper behavior or uncertain-stop recovery.
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
  confirms their exit during preparation. A same-name terminal replacement is refused before
  reservation and by source preparation; fresh review then survives both hosts restarting. The setup
  regression retains approved run identities through failed cleanup and journal reload, refuses a
  replacement with the same active count, and prevents release while setup is active.
  The browser test recovers from a nonportable source path,
  shows the ignored `.env` and running terminal, and verifies the excluded file is absent in the
  destination. Review content scrolls above the pinned actions at compact width.
  The source conversation set is checked again before reservation; a changed set returns the form
  to review. Review also names caller-supplied MCP connections that will need reconfiguration for
  each conversation. Only names cross hosts; commands, endpoints, headers and environment do not.
  Both journals retain that omission approval through restart. Changing the names requires a new
  review before reservation, before stopping, after checkpointing or before release. This covers
  conversation-level configuration; provider-discovered host/project MCP connections remain
  uninspected and the review says so. See the [integration review evidence](../qa-evidence/handoff-integrations.txt).
  Source workspace snapshots project ownership from the durable journal, including live updates
  through preparation, cancellation and release. The app keeps ownership beside the cached
  directory cursor: a reconnect with no newer rows must not reopen source controls. Reconnecting
  does not depend on local transfer storage. The source banner opens preparation/recovery or checks both hosts before navigating to
  the original activated destination. Removing the destination host leaves an actionable error.
  Existing source conversations hide their composer and fork controls while held; cancellation
  restores them. Source drafts retain their unsent text but hide the composer, reject drops and
  pause automatic submission. Agent, terminal and profile launchers, keyboard shortcuts and session
  import follow the same ownership projection, including after reload. Pending terminal creation is
  discarded when ownership is held. File editing and autosave pause without discarding the mounted
  editor's dirty buffer. File creation, rename, duplicate and delete controls disappear; Git mutation,
  branch switching, script execution and setup launch controls are disabled. Deferred file and branch
  confirmations recheck ownership before dispatch. A queued script restart is discarded when the
  source is held and does not run automatically after cancellation. File reads, diffs and existing PR
  links remain available. Server admission remains authoritative for races. Review lists unsaved files
  in the current app instance and its persisted recovery copies without saving files to disk.
  Preparation holds mounted editors, waits for pending writes and saves their latest buffers before
  requesting a destination reservation or source stop. Remaining unmounted recovery copies block
  preparation until their files are opened and resolved.
  A conflict or failed write leaves the local content editable and names the file to resolve. A new
  transfer returns to review; recovery retains an existing transfer's identity. Closing the form during
  saving prevents subsequent preparation. Successfully saved bytes enter the normal workspace capture.
  Web editors checkpoint unresolved buffers in local app storage, scoped by host, workspace, tab
  and file. Reload compares the recovered text with disk and preserves conflicts across repeated
  restarts, including when the file was deleted. Successful saves and explicit discard remove the
  recovery copy; storage failures remain visible and damaged records are retained. Recovery covers
  completed local checkpoints, not browser storage loss or keystrokes whose checkpoint had not
  completed. Other connected clients' buffers, concurrent windows and unsent conversation draft
  transfer remain open. Other workspace mutation surfaces need inventory.
  Source retirement still needs tombstones to replace broad path fences.
  Twenty-one form cases cover unavailable modes, inventory changes, lost replies, storage failures,
  exclusion pagination, duplicate submissions, closing during work, cancellation recovery and host journals advancing
  past local state, including destination lookup and selection failures. Reconstructed records retain
  the reserved mode and reject mismatched host, workspace, reservation, conversation set or digest;
  a released source restores forward recovery. Selecting a destination queries its unfinished
  reservations in pages of twenty, scoped to the source host and workspace. The user chooses an
  existing transfer before resuming; discovery and selection do not prepare or publish work.
  A matching source cancellation tombstone or cancelled destination record restores cancellation
  intent. Pending cleanup offers Resume; starting a new transfer requires completed cleanup.
  The workspace menu keeps saved recovery accessible after an offline reload. A damaged local
  record opens the form's load error instead of hiding the action. The network regression
  discovers twenty-one reservations after destination restart,
  verifies both scope filters and excludes completed cancellation.
  The network suite covers matching/mismatched Claude versions, missing source
  history and workflow artifacts without starting a provider turn during review. The feature
  gate is checked on both hosts before preparation; only isolated test daemons advertise it.
  Browser cases use real isolated daemons with directory or Git workspaces: desktop preparation/reload
  verifies bytes and destination navigation after a real activation conflict and source shutdown;
  changing exclusions after review leaves the terminal running, shows an actionable error and
  creates no destination reservation or source fence before a fresh review;
  starting a terminal after review also requires re-review while both terminals remain running;
  exclusion pagination reaches entries beyond the first fifty on desktop and compact layouts,
  rejects a changed later entry before any host mutation, then completes after fresh review.
  Both cases cross the compact/wide breakpoint four times with review open and retain its page
  and prepare action. After staging, two more transitions retain the same transfer ID and move
  action before activating the destination. Shared shell ownership follows
  [mobile panels](../mobile-panels.md) and [sheet lifecycle](../floating-panels.md#gotcha-6--bottom-sheet-refs-are-not-lifecycle-truth).
  Page failures keep the current entries visible with Retry; late responses cannot replace a newer
  review. Preparation waits for an in-flight page request.
  Compact recovery deletes the local transfer record, reloads the same identity and context mode
  from both host journals, then cancels and verifies a fresh form after clearing local state again.
  Two destination-only recovery cases select one of two reservations and retain its original mode.
  One recovers a cancellation accepted before source preparation. The other interrupts staged
  cleanup with a real path conflict, rediscovers it without local state, saves the recovered intent,
  then reloads and finishes cleanup with the source stopped. Both leave the other reservation intact.
  The source link case removes the destination host, checks its visible error, reconnects and opens
  the same activated workspace. After release and reload, it also verifies disabled agent, terminal
  and profile launchers through the menu and keyboard. Compact cancellation restores an unsent
  draft across reload and creates a real terminal afterward. The Git workspace case verifies read-only
  file editing after reload, live file reads, hidden file mutation actions, disabled commit and script
  launch controls, then real file saves and script execution after cancellation. The editor model's
  45 cases include held dirty buffers, conflicts, already-admitted saves, workspace isolation,
  checkpoint failure/retry, discard, recovery and awaiting the latest buffer before capture;
  the script menu's 11 cases include discarding a queued
  restart. A browser case delays a real file write, forces a revision conflict and verifies a visible
  error with no destination reservation or source fence. After resolving it, preparation waits for
  another delayed write and the activated destination contains the saved bytes. It now recovers the
  conflict across cold reloads and file deletion before resolving it. A file-editor browser case
  cancels closing, reloads the local text, confirms discard, and reopens the unchanged disk file
  without resurrecting the recovery copy. These recovery fixtures contain no conversations. The new source
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
  [workspace review binding results](../qa-evidence/handoff-review-binding.txt),
  [stopped-work review results](../qa-evidence/handoff-writers-review.txt),
  [exclusion pagination results](../qa-evidence/handoff-omissions.txt) with
  [desktop](../qa-evidence/handoff-omissions-desktop.png) and
  [compact](../qa-evidence/handoff-omissions-compact.png) screenshots,
  [resize retention results](../qa-evidence/handoff-resize.txt) with
  [desktop](../qa-evidence/handoff-resize-desktop.png) and
  [compact](../qa-evidence/handoff-resize-compact.png) screenshots,
  [source ownership and UI results](../qa-evidence/handoff-source-state.txt),
  [source launch controls results](../qa-evidence/handoff-source-controls.txt),
  [source file, Git and script results](../qa-evidence/handoff-source-mutations.txt),
  [save-before-handoff results](../qa-evidence/handoff-editor-save.txt),
  [editor recovery results](../qa-evidence/handoff-editor-recovery.txt),
  [cancellation recovery results](../qa-evidence/handoff-cancellation-recovery.txt) with
  [offline recovery](../qa-evidence/handoff-cancellation-offline.png) and
  [completed cleanup](../qa-evidence/handoff-cancellation-complete.png) screenshots,
  [real-provider browser results](../qa-evidence/handoff-app-real.txt),
  [recovery app results](../qa-evidence/handoff-app.txt)
  and [review](../qa-evidence/handoff-review-compact.png), [pending transfers](../qa-evidence/handoff-existing-transfers.png), [desktop](../qa-evidence/handoff-app-desktop.png) / [compact](../qa-evidence/handoff-app-compact.png)
  screenshots. Recovery without local state currently requires both paired hosts online. Destination
  lookup starts only after selecting that host. Cleanup with the source offline is covered after
  recovering and persisting the local transfer intent. Reopening recovery when the source workspace
  is unavailable without that local record, pinned-key client persistence,
  provider-discovered integration/resource dispositions,
  concurrent windows and other connected clients' unsaved buffers and conversation draft transfer,
  complete source mutation affordances and native-platform evidence remain open. Provider-discovered
  integrations and resources outside the current provider-session/terminal/setup inventory still
  need review binding and dispositions. Native rotation and wide-native Explorer dock transitions still need device
  evidence. Final transfer size is not shown separately.
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
