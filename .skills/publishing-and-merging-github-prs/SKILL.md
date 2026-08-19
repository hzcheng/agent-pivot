---
name: publishing-and-merging-github-prs
description: Use when a branch in this repository must be pushed to GitHub, opened as a PR/MR, marked ready, merged to a specific base branch, or cleaned up after merge.
---

# Publishing And Merging GitHub PRs

## Overview

Publish the intended Agent Pivot branch, create or update the PR against the
requested base, merge only after verification, and confirm the remote state
after every GitHub write.

## Preflight

- Run `gh --version` and `gh auth status`.
- Inspect `git status -sb`, `git remote -v`, and `git branch -avv`.
- Resolve repository explicitly when both `origin` and `upstream` exist.
- Pass `--repo <owner/name>` to every `gh pr`, `gh run`, and Actions command
  when more than one repository remote exists; do not rely on automatic remote
  selection.
- Resolve base branch from the user request first; otherwise use the target repo default.
- Immediately before final verification, packaging, installation, and push,
  fetch the target base and inspect whether the feature branch is behind it.
  If it is behind, rebase before those final steps, reinstall worktree
  dependencies, and rerun every affected build, local installation, byte
  verification, and test. Never publish or report artifacts built before the
  rebase as current.
- When a branch changes a separately packaged extension's runtime or protocol,
  compare that extension's manifest version with `origin/main` and require a
  higher version before publishing. Update exact artifact, brand, and release
  checks with it; reusing the version can leave an installed companion such as
  the UI Bridge stale even when a development VSIX was overwritten locally.
- Check for an existing PR with `gh pr list --head <branch> --repo <owner/repo>`.

## Create PR

1. Stage and commit only intended files.
2. Run fresh verification before push or PR creation.
3. Use `harvesting-workflow-lessons` once to review task-local failures,
   corrections, retries, and ambiguity. Include justified skill changes before
   the final capability audit; a valid “no skill change” decision is allowed.
   Record the decision twice: as the mandatory `--harvest` value of
   `regenerate-capability-audit.js` (a `Skill-Harvest` trailer in the audit
   commit) and in the PR body's required `## Skill harvest` section (CI
   rejects pull requests without it).
4. Complete commit-level main-capability audit currency after the final
   implementation or skill-owner commit.
5. Write PR titles, PR bodies, and commit messages in English, regardless of
   the conversation language.
6. Push with tracking: `git push -u origin <branch>`.
7. Prefer connector PR creation if available and authorized.
8. If connector fails with permission or repository ambiguity, use `gh pr create`.
9. Default to draft for "open a PR" requests unless the user explicitly asks for ready-for-review or the same request includes merging after validation.
10. **After creating or updating a PR, verify it actually works before
    handing off**: `gh pr view <n> --json mergeable,mergeStateStatus` and
    `gh pr checks <n>` — the PR must be mergeable with checks running or
    green. If `origin/main` moved and the PR conflicts, rebase immediately
    and re-push; never leave a PR conflicting, red, or stale.
11. When a rebase follows another merge to main, expect the capability-audit
    commit to conflict on `docs/testing/main-capability-coverage.json`:
    keep main's `audit.head`, finish the rebase, then regenerate the audit
    with `scripts/regenerate-capability-audit.js` so the new commit SHAs are
    referenced; rerun `npm run test:behavior-contracts` before pushing.

If push reports HTTP 408, `unexpected EOF`, or an RPC disconnect:

1. Resolve the remote branch SHA with `git ls-remote` or an explicit-repository
   GitHub API query before retrying.
2. If the expected SHA is present, treat the write as successful and set local
   tracking without pushing again.
3. If the ref is absent, retry the same non-force refspec with
   `git -c http.version=HTTP/1.1 push -u origin HEAD:refs/heads/<branch>`.
4. Verify the remote SHA after the retry. Never infer success or failure from
   the transport error alone.

## Merge PR

1. Inspect PR state:
   - `gh pr view <n> --repo <owner/repo> --json state,isDraft,mergeable,mergeStateStatus,statusCheckRollup,baseRefName,headRefName`
   - Inspect failing Actions with `gh pr checks <n> --repo <owner/repo>` and
     `gh run view <run-id> --repo <owner/repo> --log-failed`.
2. Treat every merge as gated by default: a green CI is never merge authorization. After all checks pass, stop, report the state, and wait for an explicit in-conversation approval ("merge", "合并", or equivalent) for this specific PR. This applies to every PR type — refactors, test-only changes, and behavior changes alike. Only a standing instruction from the user in the current conversation can relax this default, and any earlier "merge after CI" habit from pure-refactor rounds does not carry over.
3. The merge-approval status check enforces the gate mechanically. Before merging, confirm the `merge-approval` status on the PR head is green; it turns green only after the repository owner posts an approval comment that binds the exact head SHA — `approve <full-40-hex-sha>` (the gate's failure status prints the exact comment to paste). An approval that does not name the current head is stale by definition; timestamps are never trusted (round-2 review Blocker 2). If it is missing or stale, ask the user to comment on the PR page and wait. Never use `--admin` or any bypass, and never post, edit, or imitate the approval comment yourself — the main-branch audit (`scripts/run-merge-approval-audit.js`) fails red when a merged PR lacks the SHA-bound owner marker.
4. Honor approval gates exactly. If the user said "merge after I approve", stop until that approval is present in the conversation.
5. If draft and user approved/asked to merge, run `gh pr ready <n>`.
6. Merge with the repository's expected strategy, or default to merge commit:
   - `gh pr merge <n> --merge`
   - Keep the feature branch by default: a worktree-backed branch is a
     long-lived work surface reused across consecutive fixes, so deleting
     the remote branch breaks that loop. Pass `--delete-branch` only when
     the user explicitly asks for branch cleanup.
7. GitHub GraphQL can return `unexpected EOF` after a successful mutation. Always re-check:
   - `gh pr view <n> --json state,mergedAt,mergeCommit,isDraft`
   - `git fetch origin <base> --prune`
   - `git log --oneline -1 origin/<base>`
8. When the user did request branch cleanup and `--delete-branch` did not run because of a transient API failure, delete the remote feature branch explicitly after confirming the PR is merged:
   - `git push origin --delete <branch>`
   - `git ls-remote --heads origin <branch>`

## Guardrails

- Never merge a PR whose target repository or base branch is ambiguous.
- Never merge a PR without an explicit in-conversation approval for that PR; green checks are not approval.
- Never treat an API transport error as failure or success without checking PR state.
- Never delete the remote branch, local branch, or worktree unless the user explicitly asks; even then, never delete the local worktree or branch until the merge commit is confirmed.
- Do not force push or force update refs unless the user explicitly asks.
