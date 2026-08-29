---
name: fixing-regressions-with-ci
description: Use when fixing a bug or functional regression in this repository, when a previously fixed behavior returns, or when investigating why CI failed to catch incorrect user-visible behavior.
---

# Fixing Regressions With CI

## Overview

Turn every confirmed regression into a CI-owned behavior before changing production code.

**Core rule:** no production edit, including a test seam, before a CI-reachable focused test has failed for the expected reason. Before RED, name the required PR check and its `package.json` command path.

**REQUIRED SUB-SKILLS:** Use `systematic-debugging`, `protecting-main-with-worktrees`, and `test-driven-development`. Before completion, use `review-fix-commit-loop` and `verification-before-completion`.

## Workflow

1. **Diagnose**
   - Reproduce the symptom and trace the root cause.
   - Define the user-visible expected behavior. Do not freeze accidental current behavior.
   - Identify which side of the PR supplies the failing check's code before
     editing: `pull_request` checks run PR-head files, but
     `pull_request_target` checks (merge-approval gate, trusted kernel) run
     default-branch files, so a PR-head edit cannot change a default-branch
     check's behavior until it merges. Confirm against the failed run's log
     line provenance; when the fix must land on the default branch first,
     sequence a dedicated PR instead of iterating on the blocked one.
   - The same blind spot applies to GREEN: when the changed code path only
     executes from the default branch after the merge, CI on the PR cannot
     exercise it — verify by directly invoking the changed entry point
     locally (unit-level call, not only pattern assertions on the source).
2. **Own the behavior**
   - Read `docs/testing/README.md`.
   - Select an existing behavior ID or add one to `docs/testing/behavior-contracts.json`.
   - Add the ID to a focused test at the lowest stable layer.
   - For every user-visible UI/Webview regression, ensure at least one automated owner asserts the final rendered or interaction surface. A ViewModel, controller, protocol, or intermediate message assertion alone is insufficient; if the focused owner stops at an intermediate layer, add a rendered-surface owner.
   - When one change has regressed multiple neighboring features, add a
     cross-feature journey in the real rendered surface in addition to the
     focused owners. Exercise the relevant transition, provider, and viewport
     matrix without duplicating unrelated coverage.
   - When the repair changes a layout strategy rather than a single value,
     the absence of the reported artifact is not the contract. Enumerate the
     properties a reader depends on — alignment across every repeated group,
     nothing clipped, nothing requiring a scroll that hides the content it is
     compared against — and assert them together. Measure each candidate
     layout against that set and keep the evidence; a candidate that removes
     the reported artifact while losing another property is a different
     regression, not a fix. Render the real reported content and look at it
     before choosing.
3. **Prove CI reachability**
   - Before reporting RED, trace the test file through `package.json` to an existing required PR check; state that trace before any production-edit plan.
   - A locally runnable orphan test is not CI coverage.
4. **Verify RED**
   - Run the focused test against the unfixed implementation.
   - Confirm it fails because of the reported regression, not setup, compilation, or an unrelated assertion.
   - If the test reads repository working-tree files, confirm every path is git-tracked or produced by an earlier step of the CI job that runs it, and rerun the test with build outputs absent. A locally built artifact is not CI evidence.
   - The same hermeticity rule covers machine state the test relies on: git identity, environment variables, tools on PATH. A fixture that shells out must provide its own configuration (e.g. repo-local `git config user.name`), and proves it by rerunning with an empty HOME.
   - When adding a guardrail after the implementation is already repaired,
     prove mutation sensitivity: temporarily reintroduce each causal defect,
     observe the new focused or journey assertion fail for that defect, then
     restore the implementation before GREEN. A rejected candidate repair is
     also a defect worth this treatment: reintroduce it and confirm the guard
     names the property it lost, so the guard cannot be satisfied by the very
     alternative that was discarded.
   - If it passes, repair the test; do not touch production code.
5. **Fix minimally**
   - Change only enough production code to satisfy the behavior.
   - Keep unrelated refactors and features out of the fix.
6. **Verify GREEN**
   - Run the focused test, `npm run test:behavior-contracts`, the affected layered suite, and the relevant platform/environment gate.
   - Review the final diff and run the branch-level CI equivalent before push or PR.
   - Never pipe a verification command to `tail`/`head` without
     `pipefail`: the pipeline's exit code becomes the pager's, masking a
     red run as green. Use `set -o pipefail` or read the stored log.
7. **Keep the behavior catalog current**
   - In every automated owner file, use literal behavior IDs for the behaviors it owns. After any implementation, owner, or catalog change, run `npm run test:behavior-contracts`.
   - That command validates catalog→owner only: every entry's owner files
     exist and cite its ID. It never reads a test for IDs the catalog is
     missing, so a behavior ID that appears in a test but in no catalog entry
     passes every required check silently and the behavior ends up owned by
     nothing. When putting an ID in a test, confirm the reverse direction
     explicitly: `grep -c '<BEHAVIOR-ID>' docs/testing/behavior-contracts.json`
     must be non-zero.
   - Classify commits by changed paths and protected behavior, never by a subject prefix. Treat `.skills/` and skill-owner tests as implementation paths.
   - In repositories with both `origin` and `upstream`, pass the intended `--repo <owner/name>` to every `gh pr checks`, `gh run view`, and Actions log command. Do not let local remote ordering select the repository.

## Automation Boundary

If stable PR automation is impossible, stop and explain why. Only after explicit user approval may the behavior be recorded as `scheduled` or `manual` with a reason and owner. Partial fake coverage must not be labeled as complete automation.

## Stop Conditions

| Rationalization | Required response |
|---|---|
| "The fix is obvious or tiny" | Add and observe the failing regression test first. |
| "A test exists locally" | Prove a required PR check reaches it. |
| "Tests can come after verification" | Stop; tests-after do not prove the regression was captured. |
| "A fake covers enough of a real environment" | Keep the real gap scheduled/manual unless the actual environment is exercised. |
| "The user wants an immediate patch" | Report the RED gate; urgency does not reverse the order. |

Production code changed before RED? Revert that task-local change and restart from the test.
