# Quick prompts MVP — 2026-10-05

Branch: `feat/quick-prompts`, rebased onto `feat/composer-model-effort-card` (`9bb91dfc5`,
including `ec224499d`). Local implementation and commit only; no push, PR, CI or release.

## Delivered behavior

Host-owned catalog and undo window use the existing daemon config write and change subscription.
The new fields and capability are optional on the wire. Older clients accept the extra fields;
new clients accept older configs and hide quick prompts without `features.quickPrompts`.
There is no device-local catalog fallback. Config writes reject duplicate IDs, multiple defaults
and more than three pins before persistence or notification.

The composer uses Bookmark, a named split trigger on wide layouts, and the shared menu engine.
Compact layouts use the picker. The shared capacity model budgets the actual button-row interior,
fixed action targets, model/effort/mode labels and quick prompts together. Secondary pins disappear
first, then the agent-control labels, then the default prompt label; an icon-only trigger opens
the picker. The one toolbar insertion is immediately after `AGENT_CONTROLS_END` inside
`beforeVoiceContent` in `composer/index.tsx`: ring · model pill · quick prompt · mic · send/stop.
Existing model, effort, permission and voice controls retain their structure.

A captured send waits 2.5 seconds by default, supports undo and a second tap to dispatch once,
and reports the daemon's disposition. Failure requires explicit retry. Destination, policy,
permission, visibility, foreground, connection and presentation changes cancel the wait.
The iOS menu teardown callback is guarded against a changed destination. Sending uses the
normal dispatch/enqueue transport and leaves the draft and selected attachments intact;
mandatory workspace context follows the existing attachment policy.

Settings › Host › Agents includes create/edit, send/insert mode, pin/default, reorder, confirmed
delete and the undo window. All new UI copy has entries in the nine existing locales.

## Automated checks

Builds and workspace typechecking ran through `CRABBOX_STATIC_ID=paseo-quick-prompts crabbox run`.
Only the touched test files ran; no full suite. Typecheck, lint, format and these tests were
repeated after the rebase. The workspace builds below were completed before the rebase; the
existing declarations remained current.

| Check                                                                                                                 | Result                                          |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `npm run build:server`                                                                                                | Passed, including protocol validator generation |
| `npm run build:app-deps`                                                                                              | Passed                                          |
| `npm run typecheck`                                                                                                   | Passed across workspaces                        |
| `npm run lint`                                                                                                        | Passed, 0 warnings / 0 errors                   |
| `npm run format`                                                                                                      | Passed before commit                            |
| App: `npx vitest run src/composer/input/state.test.ts src/composer/agent-controls/layout.test.ts --bail=1`            | 61 passed                                       |
| Protocol: `npx vitest run src/messages.wire-compat.test.ts --bail=1`                                                  | 22 passed                                       |
| Root, on mini: `npx vitest run packages/server/src/server/daemon-config-store.test.ts --bail=1`                       | 40 passed                                       |
| App: `npx vitest run src/i18n/resources.test.ts --bail=1 -t 'quick prompt\|keys in sync\|non-English\|interpolation'` | 4 passed, 33 outside the filter                 |

The full touched `resources.test.ts` failed its existing untranslated-connection-error check:
`screens/settings/worktree-storage-card.tsx: Host is not connected`. The same two literals exist
in the starting HEAD at lines 78 and 92. That file was not changed. The new namespace, key
parity, interpolation and translation coverage checks pass independently. The same unrelated failure was reproduced after rebasing.

The deferred-send tests cover undo, second tap, each context cancellation, transient disconnect,
manual-send cancellation, unmount, delayed menu selection, failure/retry, and all three daemon
dispositions (including no invented feedback when a response omits disposition). Picker tests
cover send versus insert, pin limit, exclusive default, order and form failure preservation.
Capacity tests cover 368 px with pointer and touch density, the prompt label surviving the
model label, and longer labels at 1×, 1.5× and 2× font scales.

## Browser evidence

Before the rebase, used Aside with a real isolated development daemon and its built-in Mock Load Test provider.
Metro and daemon ran on the mini; only the browser ran locally. The main daemon on 6767 was
not restarted. Temporary processes, workspace, daemon home, tunnels and browser tabs were removed.

At 1440 px:

- The labeled default and pinned prompt appeared before the mic.
- Undo produced “Cancelled; not sent” without submitting.
- A second tap submitted once, showed daemon-confirmed “Sent”, and preserved the draft.
- The picker inserted text at the cursor and saved the current draft as a new pinned prompt.
- The host settings showed that prompt; reorder, undo-window change to 5 s and delete persisted.

At 390 px, using the real app in an iframe of that width:

- The toolbar showed only the Bookmark picker trigger.
- The trigger opened the shared bottom sheet.
- Selecting a row started deferred send; Undo cancelled it.
- The picker labels and previews remained aligned after correcting a short-row alignment issue.

Local screenshots: `/tmp/quick-prompts-qa/wide.png` and `/tmp/quick-prompts-qa/compact.png`.
Raw command logs: `/tmp/quick-prompts-*.log`.

## Remaining validation

| Surface                                                               | Coverage                                                              |
| --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Browser web, wide and compact                                         | Exercised before rebase; combined toolbar not visually rechecked      |
| iOS / iPadOS hardware                                                 | Not exercised                                                         |
| Android hardware                                                      | Not exercised                                                         |
| Electron macOS / Windows / Linux                                      | Not exercised                                                         |
| Native long-press, VoiceOver, software keyboard and touch geometry    | Not exercised                                                         |
| Real provider steering / queue / permissions and transport failure UI | State/transport contracts only; manual browser used the mock provider |
| Concurrent model/effort toolbar branch                                | Rebased; shared capacity tests, typecheck and lint pass               |

The isolated QA is not production acceptance. CI, deployment and physical-device acceptance
remain outside this local handoff.

## Changed files

- `docs/data-model.md`
- `docs/design.md`
- `docs/glossary.md`
- `docs/qa-evidence/quick-prompts.md`
- `packages/app/src/composer/agent-controls/index.tsx`
- `packages/app/src/composer/agent-controls/layout.test.ts`
- `packages/app/src/composer/agent-controls/layout.ts`
- `packages/app/src/composer/index.tsx`
- `packages/app/src/composer/input/input.tsx`
- `packages/app/src/composer/input/state.test.ts`
- `packages/app/src/i18n/resources.test.ts`
- `packages/app/src/i18n/resources/ar.ts`
- `packages/app/src/i18n/resources/en.ts`
- `packages/app/src/i18n/resources/es.ts`
- `packages/app/src/i18n/resources/fr.ts`
- `packages/app/src/i18n/resources/ja.ts`
- `packages/app/src/i18n/resources/ko.ts`
- `packages/app/src/i18n/resources/pt-BR.ts`
- `packages/app/src/i18n/resources/ru.ts`
- `packages/app/src/i18n/resources/zh-CN.ts`
- `packages/app/src/quick-prompts/capacity.tsx`
- `packages/app/src/quick-prompts/catalog.ts`
- `packages/app/src/quick-prompts/deferred-send.ts`
- `packages/app/src/quick-prompts/edit-modal.tsx`
- `packages/app/src/quick-prompts/form.ts`
- `packages/app/src/quick-prompts/settings-section.tsx`
- `packages/app/src/quick-prompts/toolbar.tsx`
- `packages/app/src/quick-prompts/use-deferred-send.ts`
- `packages/app/src/quick-prompts/use-quick-prompts.ts`
- `packages/app/src/screens/settings/host-page.tsx`
- `packages/protocol/src/messages.ts`
- `packages/protocol/src/messages.wire-compat.test.ts`
- `packages/protocol/src/quick-prompt.ts`
- `packages/server/src/server/bootstrap.ts`
- `packages/server/src/server/config.ts`
- `packages/server/src/server/daemon-config-store.test.ts`
- `packages/server/src/server/daemon-config-store.ts`
- `packages/server/src/server/persisted-config.ts`
- `packages/server/src/server/websocket-server.ts`
