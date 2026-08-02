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
2. **Own the behavior**
   - Read `docs/testing/README.md`.
   - Select an existing behavior ID or add one to `docs/testing/behavior-contracts.json`.
   - Add the ID to a focused test at the lowest stable layer.
3. **Prove CI reachability**
   - Before reporting RED, trace the test file through `package.json` to an existing required PR check; state that trace before any production-edit plan.
   - A locally runnable orphan test is not CI coverage.
4. **Verify RED**
   - Run the focused test against the unfixed implementation.
   - Confirm it fails because of the reported regression, not setup, compilation, or an unrelated assertion.
   - If the test reads repository working-tree files, confirm every path is git-tracked or produced by an earlier step of the CI job that runs it, and rerun the test with build outputs absent. A locally built artifact is not CI evidence.
   - The same hermeticity rule covers machine state the test relies on: git identity, environment variables, tools on PATH. A fixture that shells out must provide its own configuration (e.g. repo-local `git config user.name`), and proves it by rerunning with an empty HOME.
   - If it passes, repair the test; do not touch production code.
5. **Fix minimally**
   - Change only enough production code to satisfy the behavior.
   - Keep unrelated refactors and features out of the fix.
6. **Verify GREEN**
   - Run the focused test, `npm run test:behavior-contracts`, the affected layered suite, and the relevant platform/environment gate.
   - Review the final diff and run the branch-level CI equivalent before push or PR.
7. **Maintain audit currency**
   - In every automated owner file, use literal behavior IDs for the behaviors it owns. After any implementation, owner, catalog, or audit change, run `npm run test:behavior-contracts`.
   - Classify commits by changed paths and protected behavior, never by a subject prefix. Treat `.skills/` and skill-owner tests as implementation paths: tests and owner-marker commits remain implementation evidence even with a `docs:` subject.
   - Form the final implementation commit before completing the audit. Record its full SHA, assign it exactly once to the matching capability, advance `audit.head` to that SHA, and commit the manifest update separately as a genuine documentation-only audit commit.
   - Regenerate audit assignments with `node scripts/regenerate-capability-audit.js --assign <sha>=<CAPABILITY-ID> [--behavior <CAPABILITY-ID>=<BEHAVIOR-ID>] --harvest none|updated:<.skills/paths> --commit "docs: audit ..."`, especially after a rebase: the script classifies every commit beyond the audit head, registers documentation-only commits, advances `audit.head`, validates the manifest, and restores it on failure instead of hand-editing. `--harvest` is mandatory and records the skill harvest decision as a `Skill-Harvest` trailer in the audit commit.
   - If another implementation path changes after that audit, including `.skills/`, repeat the sequence with the new implementation SHA. A pre-commit local pass cannot prove commit-level audit currency because the final SHA does not exist yet.
   - Advance `audit.head` only after every implementation commit has a complete main-capability assignment with CI-reachable behavior ownership. Only genuine documentation-only commits may remain after the audit head.
   - Treat audit-currency failures as immediate failures. A later audit commit cannot create missing RED evidence or retroactively make an implementation commit documentation-only.
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
