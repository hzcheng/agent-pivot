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
   - After the final implementation or skill-owner commit exists, complete the
     main-capability assignment and `audit.head` update in a separate
     documentation-only audit commit, then rerun
     `npm run test:behavior-contracts` before push.

## Reporting

Summarize:
- reviewer Critical/Important findings
- what was fixed
- verification commands and outcomes
- commit hash or message
- any Minor items intentionally left for later

## Pitfalls

- Do not call a review complete until fresh verification has run after the final fix.
- Do not bury review fixes inside unrelated feature commits unless the user requested squashing.
- Do not trust subagent output blindly; inspect the actual diff and rerun evidence-producing commands.
- Do not treat a pre-commit behavior-contract pass as proof of commit-level audit currency.
- Judge gate and verification scripts by their own exit code: piping to
  `grep`/`head` masks it (check `$?` directly or use `set -o pipefail`), and
  chain commits after verification steps with `&&`, never `;`.
