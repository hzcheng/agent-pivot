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
2. Honor approval gates exactly. If the user said "merge after I approve", stop until that approval is present in the conversation.
3. If draft and user approved/asked to merge, run `gh pr ready <n>`.
4. Merge with the repository's expected strategy, or default to merge commit:
   - `gh pr merge <n> --merge --delete-branch`
5. GitHub GraphQL can return `unexpected EOF` after a successful mutation. Always re-check:
   - `gh pr view <n> --json state,mergedAt,mergeCommit,isDraft`
   - `git fetch origin <base> --prune`
   - `git log --oneline -1 origin/<base>`
6. If `--delete-branch` did not run because of a transient API failure, delete the remote feature branch explicitly after confirming the PR is merged:
   - `git push origin --delete <branch>`
   - `git ls-remote --heads origin <branch>`

## Guardrails

- Never merge a PR whose target repository or base branch is ambiguous.
- Never merge before an explicit requested approval gate has been satisfied.
- Never treat an API transport error as failure or success without checking PR state.
- Never delete the local worktree or branch until the merge commit is confirmed.
- Do not force push or force update refs unless the user explicitly asks.
