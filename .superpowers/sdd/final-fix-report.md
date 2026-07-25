# Final Fix Report

## Outcome

All six binding findings in `final-review-findings.md` are fixed with test-first
regressions. The review-fix loop found two additional Important edge cases
(successful form focus and refresh-before-lazy-mount ordering); both were also
fixed test-first. Follow-up review found no remaining Critical or Important
issues.

The final implementation/test audit head is
`8c4b77b65c2d8375a800e70efe906b1138fc0096`. Every non-documentation commit
through that head is assigned exactly once to `MAIN-AI-PROMPT-LIBRARY`.

## Binding Findings

### 1. Host authority independent of persisted revision

- Added one positive, monotonic, controller-owned `authoritySequence` across
  initial AI content, Prompt refreshes, and command results.
- Seeded the Webview controller from the accepted initial authority and ordered
  results, external refreshes, and queued refreshes by Host authority rather
  than persisted revision.
- Retained exact snapshot/HTML revision equality and full mutation correlation
  identity.
- Retained only the highest valid Prompt refresh while AI is not mounted,
  preserved it across failed mounts, and drained it after a coherent mount.
  Prompt authority comparison safely rejects a queued refresh older than the
  mounted panel.

RED evidence:

- Host publications returned
  `[undefined, undefined, undefined]` instead of `[1, 2, 3]`.
- A newer-authority refresh after persisted-revision rollback returned
  `false !== true`.
- Before lazy mount, the Dashboard forwarded authorities 2, 3, and 2 instead
  of retaining none until mount.

GREEN evidence:

- Host monotonic-publication, revision-rollback, queued-refresh, failed-mount
  retention, and stale-authority tests pass.
- Final focused Prompt/Dashboard suite: 154 tests passed.

### 2. Captured terminal liveness

- Added an injected terminal-availability probe.
- Production checks the exact captured terminal object against
  `vscode.window.terminals` immediately before `sendText`.
- The existing safe warning, no-Enter insertion, exception containment, and
  invocation-time terminal identity remain unchanged.

RED evidence:

- Availability checks were `[]` instead of `[capturedTerminal]`; the closed
  captured terminal received the Prompt and was shown.

GREEN evidence:

- All 11 terminal insertion contract tests pass, including closure while the
  Quick Pick is open.

### 3. Collapse state follows the live active tab

- AI now has an intrinsic disabled Collapse state and no collapsible groups.
- The shared helper reads the live Dashboard controller; before controller
  publication it reads the semantically selected top-level tab, then falls back
  to OPEN.
- Removed stale tab hints from Projects/TODO callbacks and update paths.
- Preserved exact OPEN, PROJECTS, and TODO labels and behavior.
- Updated the Dashboard source contract to require live-tab synchronization.

RED evidence:

- AI returned an enabled `Collapse Other Windows` state.
- Late Projects/TODO paths overwrote the AI-disabled state.
- Startup synchronization did not read the selected AI tab.

GREEN evidence:

- Helper, startup, actual late response/update, generated parity, and Dashboard
  source-contract checks pass.

### 4. Semantic focus and real viewport restoration

- Added semantic identities for create/edit fields, submit/cancel actions,
  Prompt item actions, and global New Prompt.
- Reapplies drafts before restoring focus and restores the real `window.scrollY`
  with `window.scrollTo`, while retaining existing list-scroll behavior.
- Failed command results and external refreshes restore visible create/edit
  fields/actions and New Prompt.
- Successful create returns focus to New Prompt; successful update returns
  focus to that row's Edit action. Explicit focus changes made while a mutation
  is pending are not stolen.

RED evidence:

- Unit harness focus became `document.body` instead of the recreated create
  textarea.
- Five Chromium failure/refresh scenarios reported no active semantic control.
- Successful Chromium create/update also reported `BODY` rather than New/Edit.

GREEN evidence:

- Prompt interaction suite: 18 tests passed.
- Real Chromium Prompt layout/focus suite: 17 tests passed, including failed
  create, external edit refresh, New Prompt, successful create/update, and real
  viewport positions.

### 5. Coherent lazy AI mount

- Installs candidate AI HTML while state remains `loading`.
- Requires exactly one Prompt surface, a strict nonnegative revision equal to
  the snapshot revision, a Prompt controller, and `mount(...) === true`.
- Only then cancels recovery, resets attempts, and transitions to `mounted`.
- Failure restores the prior loading DOM, exposes unavailable/retry state, and
  permits a fresh opaque request ID.

RED evidence:

- Missing controller, false mount, missing/duplicate/mismatched surfaces all
  returned `true !== false`.
- A successful mount callback observed `mounted` instead of `loading`.

GREEN evidence:

- All coherent-mount failure cases, install-before-mount, retry, and pre-mount
  refresh tests pass in the final 53-test Webview state suite.

### 6. Responsive four-tab Dashboard shell

- Changed the default grid to a balanced two-column layout.
- Added a 480 px breakpoint for four equal columns.
- Regenerated `media/styles.css`.
- Added real Chromium coverage against production Dashboard shell markup,
  including search, Collapse, Settings, and exact OPEN/PROJECTS/TODO/AI tabs.

RED evidence:

- At 240 px, PROJECTS had `clientWidth=59` and `scrollWidth=68`.
- Row grouping was `[3, 1]` at 240, 320, and 600 px.

GREEN evidence:

- Chromium verifies `[2, 2]` at 240/320 px and `[4]` at 600 px.
- Every shell/control bound fits the viewport and every tab satisfies
  `scrollWidth <= clientWidth`.

## Review-Fix Loop

The read-only whole-range review found no Critical issue and two Important
issues:

1. Successful create/update dropped focus to `BODY`.
2. A newer Prompt refresh arriving before lazy mount could be discarded.

Commits `05c8531e3b01c1fa61c0b6b312571b2bd966dc0d` and
`8c4b77b65c2d8375a800e70efe906b1138fc0096` fix those issues with new RED/GREEN
unit and Chromium/integration regressions. Follow-up review found no remaining
Critical or Important issue and confirmed source/media parity.

One non-blocking test gap remains: rejection of an older queued refresh after a
newer initial mount is covered compositionally by Dashboard queue tests plus
Prompt authority tests, rather than by one dedicated end-to-end Dashboard test.

## Commits

- `6c1e3ae9a1236ac2cd358568e26320d7c944ce6a` — `fix: order prompt authority independently of revision`
- `965f2818ab49c7830b45eb3ef295ef00f40238fb` — `fix: verify captured terminal before prompt insertion`
- `407226927be794290538010b1f5dc1b05e380021` — `fix: keep collapse state bound to the active tab`
- `e0a18f913dfcd9ac54187bb46aa04445da4b6e99` — `fix: require a coherent prompt mount before AI readiness`
- `48472fe541fef6d7fc066e2490d21abb744c1a11` — `fix: preserve prompt form focus and viewport`
- `4b92407e8f8378583f3ee763488cbf753d3bae84` — `fix: balance four dashboard tabs responsively`
- `31ccf672f178fb8b2ae00c77e00a7865a861905c` — `test: require live-tab collapse synchronization`
- `67905650c52e10c424688e1e658cb9eb49ec4241` — `docs: audit final prompt fixes`
- `05c8531e3b01c1fa61c0b6b312571b2bd966dc0d` — `fix: restore focus after prompt saves`
- `8c4b77b65c2d8375a800e70efe906b1138fc0096` — `fix: retain prompt refreshes until AI mounts`
- `270167b09b344634c5ca475c163f226703ebe67f` — `docs: refresh prompt fix audit`

## Verification

Fresh final-state verification passed:

- Focused Prompt/terminal/Dashboard/style suite: 154 tests.
- Prompt Chromium suite: 17 tests.
- Full browser gate: 34 tests.
- Behavior contract tooling: 40 tests plus live catalog/currency checks.
- Dashboard Webview checks.
- Source/media Prompt, Dashboard, and Project script parity.
- Compiled/minified SCSS/CSS parity.
- Workspace, AI session, tmux, and open-workspace safety/parity checks.
- Architecture baseline and guards.
- Release notes and release VSIX packaging.
- Production Webpack/Gulp prepublish.
- Coverage run: 722 tests; stored coverage baseline passed.
- Fresh `npm run test:ci:linux`: exit 0.

The worktree was clean immediately after the final CI build.
