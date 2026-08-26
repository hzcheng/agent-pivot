---
name: protecting-main-with-worktrees
description: Use when working in this repository and main/master is protected, must not be directly pushed, or feature work should happen in a local .worktree without touching user changes in the primary checkout.
---

# Protecting Main With Worktrees

## Overview

Keep Agent Pivot's protected branches and the user's primary checkout clean by
doing feature work in an isolated git worktree under the project.

One line of work = one worktree = one branch: make every commit for the job
on that worktree's branch, and cut serial PRs from that same branch as
earlier ones merge. Do not switch branches inside the worktree, do not spread
one job across worktrees, and do not create another worktree for the same
job.

## Workflow

1. Inspect state before creating anything:
   - `git status -sb`
   - `git branch --show-current`
   - `git remote -v`
   - `git worktree list`
   - identify the intended repository remote and base branch from the user request, local tracking branch, or remote default

2. If the user asks for a worktree under the current project, place it under
   `.worktrees/<topic>` (plural — the product's own default and the layout in
   use) — worktree creation happens once per line of work.
   - Do not add `.worktrees/` to tracked `.gitignore` unless the user explicitly wants a repo change.
   - Prefer local ignore: `printf '.worktrees/\n' >> .git/info/exclude` if needed.

3. Create from the protected base:
   - `git fetch <remote> <base>`
   - `git worktree add -b <branch> .worktree/<topic> <remote>/<base>`
   - Use `origin/main` only after confirming that `origin` and `main` are the intended target.
   - Bootstrap dependencies inside the new worktree (`npm run worktree:bootstrap`) before running verification. It runs `npm ci --ignore-scripts --allow-scripts=` when the install is missing or stale, so user-level npm script allowlists cannot break the bootstrap, and serializes it with other guarded commands in that worktree. Run complete verification commands as `npm run worktree:run -- <command>` so a concurrent install cannot delete `node_modules` while the command is using it. Do not share or symlink node_modules between worktrees: npm resolves binaries from a parent checkout's node_modules when the worktree has none, which masks the missing install until a check constructs `<worktree>/node_modules/...` paths directly.

4. Work only in the feature worktree.
   - Use `git -C .worktree/<topic> ...` or set `workdir` there.
   - Treat dirty files in the primary checkout as user changes. Do not revert them.
   - Stage explicit paths when the tree is mixed.

5. After merge, clean up intentionally:
   - Confirm the worktree is clean with `git -C .worktree/<topic> status -sb`.
   - `git worktree remove .worktree/<topic>`
   - `git worktree prune`
   - Re-run `git worktree list`.

## Guardrails

- Never push directly to `main`/`master` when the user said it is protected.
- An open PR absorbs anything pushed to its branch: push the next slice's
  commits only after the branch's previous PR has merged.
- Never repair the `.gitignore` mistake by committing ignore-only churn to protected main.
- Never assume `origin/main` when the repo also has `upstream` or the user named a different target.
- If a feature branch tracks a deleted remote after merge, that is expected; remove the worktree after checking it is clean.
- If a command accidentally affects the primary checkout, stop and inspect before continuing.
