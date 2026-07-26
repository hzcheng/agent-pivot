# Task 8 Report: Focused Active Session Expansion

## Status

DONE

- Base: `227f28cf942e72fc38b1543733c715240503656a`
- Branch: `docs/active-session-conversation-outline-design`
- Feature commit:
  `c79db33123bb4f7624c90d68f30a93a223ef73e9 feat: expand focused Active Session cards`
- Review-fix commit:
  `6486d602d4d91f833f3928dcb9f70a34fc472e1b fix: harden Active Session expansion recovery`
- Test-stability commit:
  `c55700c26f29d590eb1a2580bdcf7680e55d15bd test: wait for Active Session layout convergence`
- Bounded-wait commit:
  `3046835ef05033612f44d34982a914836c41312f test: bound Active Session browser waits`
- Review: two independent read-only review rounds completed; no Critical or
  Important Task 8 issue remains.
- No push was performed.

## Files

- Modified `src/webview/webviewContent.ts`
- Modified `src/webview/webviewProjectScripts.js`
- Generated `media/webviewProjectScripts.js`
- Modified `media/styles.scss`
- Generated `media/styles.css`
- Modified `tests/integration/dashboard/sessionCardInteraction.test.js`
- Created `tests/integration/dashboard/sessionConversationContent.test.js`
- Created `tests/browser/activeSessionConversationOutline.test.js`
- Modified `docs/testing/behavior-contracts.json`
- Modified `scripts/run-ai-session-safety-checks.js`
- Created `.superpowers/sdd/task-8-report.md`

## TDD RED Evidence

The activation, markup, and Playwright tests were written before production
changes.

```bash
npm run test-compile
node --test tests/integration/dashboard/sessionCardInteraction.test.js
node --test tests/integration/dashboard/sessionConversationContent.test.js
node --test --test-concurrency=1 \
  tests/browser/activeSessionConversationOutline.test.js
```

Compilation passed. The new activation test exited `1` because a focused Active
row still returned the existing `focus-ai-session-terminal` message instead of
`message: null` and `toggleConversation: true`.

The corrected markup test exited `1` because the focused row contained no
`.ai-session-conversation-chevron` or Conversation shell.

The first Playwright test exited `1` because the focused primary action had no
`aria-expanded="false"`. A second test timed out waiting for the missing
expansion affordance. The run was stopped after those expected product
failures to avoid repeated 30-second waits for the same absent shell.

Two test-harness issues were corrected before treating the tests as evidence:

- the markup helper initially matched a session ID outside the target row;
- the browser fixture needed `data-codex-expanded` because it loads the real
  sidebar CSS.

Neither correction changed production behavior.

Later focused assertions also caught two implementation details before final
verification:

- restoring marker focus scrolled the rail away from the captured `scrollTop`;
  focus now uses `preventScroll` and applies the saved rail offset afterward;
- the dashboard gate reproduced a TypeError when its intentionally light DOM
  card lacked `querySelector`; capture/restore helpers now fail closed on
  incomplete DOM capabilities.

An independent review later found two real regressions in the originally
committed feature. Tightened Chromium tests reproduced both before the
follow-up implementation:

- the rail reported `scrollHeight=432` but `clientHeight=0` because the height
  variable only capped `max-height`; the strengthened geometry assertion
  failed at `clientHeight > 0`;
- a valid `open-workspaces-updated` replacement removed the expanded DOM
  without restoring or cancelling it; the new test found no expanded row and
  retained the detached observer/subscription state.

After those fixes, a second read-only review found one additional dynamic
layout bug. Removing 17 of 18 markers without resizing the viewport left both
`clientHeight` and `scrollHeight` at `432` instead of shrinking to `24`.
That regression was also captured as RED before adding content mutation
observation.

A final review found the browser owner itself was flaky while production
geometry converged correctly. Four consecutive runs of the unchanged focused
file produced `PASS, PASS, FAIL, FAIL`; both failures read the prior constrained
rail geometry immediately after returning to the 900 px viewport:

```text
actual:   clientHeight=108, scrollHeight=432
expected: clientHeight=432, scrollHeight=432
```

The test now waits for the rail to reach nonzero natural height and for the
panel to be fully inside the viewport before retaining the exact geometry
assertions. The marker-shrink check likewise waits for exact `24/24` geometry
instead of sleeping for 100 ms. This is test-only determinism work; production
code and timing remain unchanged.

The final gate review then found that Playwright's `waitForFunction` defaults
to no timeout. A static owner test was added first and failed with `4 !== 1`
because the file contained four direct, potentially unbounded calls. All four
now use one helper with an explicit 5000 ms timeout. The same static test
requires exactly one underlying Playwright call and the bounded helper shape,
so a future direct unbounded wait fails deterministically instead of hanging
the browser gate.

## Implementation

- Only a focused, non-pending Active Session row renders the chevron, closed
  ARIA state, and Conversation panel/rail shell.
- A non-focused active row keeps its existing terminal-focus message. An
  already focused row toggles locally. Nested pin, close, and marker controls
  remain consumed without toggling.
- `applyActiveAiSessionConversationState` synchronously updates the row,
  panel, header, chevron, single expanded key, list height, and nearest scroll
  position in one call.
- `syncActiveAiSessionConversationListHeight` measures the collapsed row and
  list, removes the prior rail height to recover natural rail/loading content,
  applies one measured expansion delta, gives the rail a real height, and
  constrains short viewports to a minimum 72 px rail.
- A `ResizeObserver` watches the active row/list, a panel-scoped
  `MutationObserver` remeasures marker and loading/rail visibility changes,
  and a window resize listener provides the viewport/fallback path. Collapse,
  replacement capture/mismatch, and cancellation disconnect both observers
  and clear local expansion state.
- The outer Active Sessions list retains `overflow-y: auto`; only the
  Conversation rail owns constrained internal scrolling.
- Enter and Space use the primary button's native activation. Escape from an
  expanded row closes it, posts the exact correlated cancel, and focuses the
  primary header.
- Before `applyWorkspaceUpdate` replaces the authoritative current-workspace
  group, the Webview captures provider, session, rail offset, and focused
  interaction ID. It restores only the same provider/session that remains
  focused, applies visual/ARIA/layout state synchronously, restores local
  scroll/focus, and issues a fresh correlated outline request.
- A missing, changed-provider, changed-session, or no-longer-focused target
  stays closed and posts an exact newer-generation cancel.
- `applyWorkspaceUpdate` and `applyOpenWorkspacesUpdate` share the same
  current-workspace capture/restore/cancel lifecycle. A valid full replacement
  restores only the exact still-focused identity; an invalid full replacement
  rolls its DOM back, restores local focus/scroll, and issues a fresh request
  for the newly mounted rollback DOM.
- Expansion is held only in the live document. No conversation state is added
  to `vscode.setState`, workspace state, or global state, so a recreated
  Webview starts closed.

## Contract Clarifications

Task 8 emits the request/cancel envelope because matching authoritative
replacement must request fresh content and a collapse must release the existing
Host subscription. It does not consume outline results. Task 9 remains
responsible for result validation, states, markers, and marker navigation.

The brief's inline browser example omitted `projectId` from
`focus-ai-session-terminal`, while the established exact activation contract
already includes it. The implementation preserves the existing
project-scoped message and its regression test.

The browser test injects inert marker buttons only to prove nested controls and
local scroll/focus restoration. No production marker rendering or Task 9
styling was added.

## Review

The scoped self-review and independent reviews checked:

- only the eight Task 8 feature/test/generated files changed in the feature
  commit;
- only one expanded row is discoverable at a time;
- request IDs and subscription generations increase for every request/cancel;
- provider/session/project identity is carried unchanged through request,
  restore, and cancel;
- a mismatched authoritative replacement cannot reopen detached HTML;
- observers and local keys are cleared when the authoritative identity cannot
  be restored;
- natural height is remeasured when moving from a constrained viewport back to
  a spacious viewport and when conversation content shrinks in place;
- both authoritative current-workspace replacement paths disconnect detached
  observers and either issue a fresh request or an exact newer cancel;
- invalid full replacement rollback restores expansion, rail offset, marker
  focus, and a live observer pair;
- no `setState` call persists expansion;
- Task 9 result/marker rendering and Task 10 production Host wiring are absent.

The reviews found and fixed:

1. detached resize-observer and expanded-key cleanup on replacement mismatch;
2. natural-height remeasurement after a prior rail cap;
3. focus-induced rail-scroll drift during restoration;
4. missing DOM-capability guards required by the dashboard harness.
5. a zero-height rail hidden by the original max-height-only browser assertion;
6. lifecycle bypass through `open-workspaces-updated`;
7. stale fixed height after marker content shrank without a viewport resize;
8. an AI-session safety check that still asserted the pre-Task-8 list-height
   formula.

The final independent read-only re-review reported no Critical or Important
findings.

## Final GREEN Evidence

The final fresh verification covered:

```bash
npm run test-compile
npx gulp --production
npm run test:deterministic:run
npm run test:browser:run
npm run test:safety:run
npm run test:dashboard:run
npm run test:architecture-guards
npm run test:architecture-baseline
npm run test:behavior-contracts
npm run lint
npm run lint:ci
npx tslint -c tslint.json src/webview/webviewContent.ts --format stylish
git diff --check
cmp src/webview/webviewProjectScripts.js media/webviewProjectScripts.js
```

- TypeScript and the attention bridge compiled.
- Production Gulp assets built.
- The complete deterministic unit/contract/integration chain passed; its final
  integration stage reported `183/183`.
- Dashboard Webview checks passed.
- Safety, architecture guards, and architecture baseline checks passed.
- The complete browser suite reported `51/51`; the focused Task 8 file reported
  `6/6`, including the bounded-wait static contract.
- The focused Task 8 browser file also passed 10 consecutive post-fix runs
  (`10/10`) after the unchanged test reproduced the flake in two of four runs.
- After bounding all waits, the focused Task 8 browser file passed three more
  consecutive runs (`3/3`).
- Behavior catalog and main-capability unit checks reported `40/40`.
- Task-owned TypeScript lint reported no warnings.
- Diff whitespace and generated JS parity checks passed.

Additional focused browser coverage verified:

- every row starts closed;
- non-focused first click focuses without expansion;
- focused click, Enter, and Space toggle;
- Escape closes and returns focus;
- opening a second focused shell closes the first;
- nested action and marker controls do not toggle;
- a recreated document starts closed;
- a 900 px viewport applies exactly one measured row delta and fully exposes
  the panel and all rail content;
- a 260 px viewport keeps both headers visible and makes only the rail scroll;
- returning to 900 px removes the prior constraint, and reducing 18 markers to
  one without a viewport resize shrinks the rail from 432 px to 24 px;
- matching authoritative replacement preserves expansion, rail offset, and
  focused marker while issuing a fresh request;
- valid full replacement does the same and disconnects the detached observer;
- invalid full replacement rollback restores expansion/scroll/focus and issues
  a fresh exact request;
- a focus/identity mismatch remains closed, clears both observers and the
  ephemeral key, and emits the exact newer cancel.

`npm run lint` also exited `0`, while reporting only repository-wide existing
warnings outside Task 8 files. `npm run lint:ci` still exits `1` for the
pre-existing `src/aiSessions/conversation/codexAppServerClient.ts` semicolon
baseline (`0=5`). `git diff --exit-code 227f28c --` for that file is empty;
Task 8 did not modify it.

`npm run test:behavior-contracts` completes its catalog/capability unit tests
but its final currency audit exits `1` because the branch already contains the
unaudited Task 1–8 implementation lineage from `115a4f1` through the Task 8
implementation and owner commits, including `6486d60` and `c55700c`. The
follow-up adds the two P0 automated behavior entries and owner/evidence paths.
The bounded-wait owner commit `3046835` is likewise implementation evidence;
the branch-wide commit assignment belongs to the later capability-audit task
rather than this scoped fix.

## Concerns

No Task 8 implementation concern remains. The repository-wide `lint:ci`
baseline mismatch and branch capability-audit currency issue above remain
pre-existing and are intentionally not broadened into this task.
