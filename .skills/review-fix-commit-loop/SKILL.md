---
name: review-fix-commit-loop
description: Use when this repository's code changes need review, requested fixes, fresh verification, and intentional follow-up commits before push, PR, or merge.
---

# Review Fix Commit Loop

## Overview

Turn Agent Pivot review findings into focused fixes without losing
traceability: inspect, fix Critical/Important findings, verify freshly, then
commit only the intended files.

## Workflow

1. Establish scope:
   - `git status -sb`
   - `git diff --stat`
   - `git diff <base>..HEAD` for committed branch review

2. Request or perform review.
   - Use a read-only reviewer for substantial changes or before merge.
   - Give the reviewer base/head SHAs and concrete requirements.
   - Tell the reviewer not to mutate the checkout.

3. Triage findings by severity.
   - Critical: fix before continuing.
   - Important: fix before push/merge unless demonstrably invalid.
   - Minor: fix if cheap and low-risk; otherwise note as follow-up.
   - If a reviewer is wrong, explain with code or test evidence.

4. Patch narrowly.
   - Keep review fixes separate from unrelated refactors.
   - Add or tighten tests for every behavior bug found.
   - Preserve user changes in dirty worktrees.

5. Reproduce and classify every failing check before deferring it.
   - A failure is blocking until its result is reproduced and classified as a
     behavior regression, test/harness problem, environment issue, or valid
     audit-currency exception.
   - Do not call a real harness or integration regression "audit currency".
     That label requires matching audit-currency evidence, not an assertion or
     a commit subject.
   - Unexplained CI or harness failures block PR creation, push-for-review,
     and merge.

6. Verify after fixes, not before only.
   - Run the smallest focused commands that prove each fix.
   - Also run fresh branch-level checks needed for the PR; do not reuse results
     from before the final fix.
   - Include `git diff --check` when code or docs changed.
   - For Webview visual or layout changes, also verify rendered output (a
     screenshot or equivalent) at the panel's default and minimum supported
     widths: DOM assertions and bounding-box checks are blind to
     `text-overflow: ellipsis` truncation, so only rendered pixels reveal
     clipped labels such as `Resol…`.
   - Model verification dependencies before parallelizing. Run any command that
     cleans or rebuilds `out/` before checks that consume `out/`; parallelize
     only checks whose inputs and outputs do not overlap. Classify
     `MODULE_NOT_FOUND` from a concurrently deleted build tree as a scheduling
     failure only after the affected checks pass in dependency order.
   - Run browser performance-threshold tests without concurrent CPU-intensive
     checks such as coverage. If a threshold fails under resource contention,
     rerun the affected test and the browser suite alone before classifying it
     as a product regression.
   - When runtime identity, tmux metadata versions, or runtime-binding
     persistence changes, run the aggregate `npm run test:safety:run` gate.
     A focused safety script does not cover all migration, recovery, and
     cross-host race fixtures owned by that gate.

7. Complete final integration review after all task-level reviews.
   - Run one final, read-only review of the complete merge-base-to-HEAD diff;
     provide the merge base and HEAD to the reviewer and forbid checkout
     mutations.
   - Review cross-task protocols, shared state, partial failures, rollback
     paths, accessibility announcements, and replacement lifecycles as well as
     individual task changes.
   - Critical and Important integration findings remain blocking until fixed.
     After the final fix, run fresh focused and branch-level verification, then
     re-review the complete merge-base-to-HEAD diff before PR creation or merge.

8. Commit intentionally.
   - Stage explicit paths.
   - Use a commit message that names the fixed issue, e.g. `fix: tighten open projects update consistency`.
   - Re-check `git status -sb`.
   - Edit large machine-formatted JSON manifests (`docs/testing/*.json`) with
     targeted text edits, never programmatic parse-and-rewrite; before
     committing, check `git diff --stat` for whole-file reformat churn
     (hundreds of rewritten lines for a few-line change) and redo the edit
     when seen.
   - Keep every commit self-consistent across Host-document ↔ Webview-script
     contract pairs (availability guards, message shapes, shared markup):
     coupled markup and script changes belong in the same commit, so no
     intermediate commit leaves the Webview gated off by missing elements.
   - The capability manifest (`docs/testing/main-capability-coverage.json`) is
     a read-only historical record since the harness pruning (PR #309): do not
     add audit commits, capability assignments, or `audit.head` updates.

## Reporting

Summarize:
- reviewer Critical/Important findings
- what was fixed
- verification commands and outcomes
- commit hash or message
- any Minor items intentionally left for later

## Pitfalls

- Do not call a review complete until fresh verification has run after the final fix.
- `npx gulp` (default task) ends in watch mode under development and never
  exits. The `media/` script copies need no manual step at all (every build
  regenerates them from `src/webview/`); SCSS styles are still compiled into
  the tracked minified CSS — rebuild one-shot with `npx gulp buildStyles`
  (or `npx gulp --production`), the same mode CI uses.
- Do not bury review fixes inside unrelated feature commits unless the user requested squashing.
- Do not trust subagent output blindly; inspect the actual diff and rerun evidence-producing commands.
- Do not treat a pre-commit behavior-contract pass as proof of commit-level audit currency (the audit itself was pruned in PR #309; the manifest is historical).
- Before moving, renaming, or deleting repository content, grep `scripts/` and
  `tests/` for strings anchored to that content (changelog entries, README
  phrases, shipped file paths) and update every anchored reader in the same
  commit; the release artifact has its own anchors — `.vscodeignore` whitelists
  shipped `out/` paths one by one and `run-release-packaging-checks.js` pins the
  exact VSIX contents, so a moved production file also needs its shipping entry
  moved (the runtime `require` closure of shipped files decides which root-level
  `out/` files ship). Content-anchor checks fail only when their own suite runs, not at
  edit time.
- Judge gate and verification scripts by their own exit code: piping to
  `grep`/`head` masks it (check `$?` directly or use `set -o pipefail`), and
  chain commits after verification steps with `&&`, never `;`.
- Run long suites such as `npm run test:ci:linux` as a background task with an
  explicit generous `timeout`: background tasks default to about a minute and
  foreground calls cap out around five minutes, so either default kills the
  suite mid-run.
- After editing `media/*.scss`, grep the compiled `media/*.css` for the new
  selectors before trusting tests: a replacement anchor like `.foo {` also
  matches inside a longer selector such as `.bar .foo {`, and Sass happily
  compiles the mangled nesting.
- A multi-edit replace call reports applied replacements, not matched
  edits: an edit whose anchor does not match is silently skipped and only
  shows up as a lower replacement count than the edit count. Compare the
  two numbers and grep the anchors before running tests, or an unapplied
  hunk rides into the commit unnoticed.
- Adding a Dashboard command or an activation-time `vscode` API (e.g.
  `createStatusBarItem`) fails activation-harness and integration tests with
  opaque `waitFor` timeouts far from the cause: bootstrap errors are swallowed
  into the `[Agent Pivot] agent-pivot-bootstrap-failed` output-channel line, so
  read that line first. Update every inline fake `vscode` surface
  (`tests/fixtures/aiSessions/runtimeHostActivationHarness.js`,
  `tests/integration/dashboard/helpers/terminalCloseHarness.js`,
  `todoPanelHarness.js`) and every hardcoded command list
  (`dashboardBoundaries.test.js` twice, `runtimeComposition.test.js`,
  `extensionHostSuite.test.js`, `run-dashboard-webview-checks.js`) alongside
  `DASHBOARD_COMMANDS` and `package.json`.
