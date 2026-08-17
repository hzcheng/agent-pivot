# AGENTS.md

Instructions for coding agents working in this repository. Read this before
making any change.

## Non-negotiables

1. **Never edit files directly in the primary checkout on `main`.** Each
   line of work runs in its own worktree on that worktree's branch: make
   every commit for the job on that branch and cut serial PRs from it as
   earlier ones merge. Do not switch branches inside the worktree, do not
   spread one job across worktrees, and do not start another worktree for
   the same job:
   ```sh
   git fetch origin main
   git worktree add -b <branch> .worktrees/<topic> origin/main  # once per job
   ```
   Run `npm ci` inside the worktree before verifying anything — npm
   silently resolves binaries from the primary checkout's `node_modules`
   otherwise. Dirty files in the primary checkout are user changes; do not
   revert them. Details: skill `protecting-main-with-worktrees`.

2. **Never push directly to `main`.** Publish through a PR against
   `origin/main` in `hzcheng/agent-pivot`. This repo has two remotes
   (`origin` = fork, `upstream` = original project) — pass
   `--repo hzcheng/agent-pivot` to every `gh` command. Write PR titles, PR
   bodies, and commit messages in English. Details: skill
   `publishing-and-merging-github-prs`.

3. **Load the matching skill before acting.** Project skills live in
   `.skills/` (canonical) and are mirrored into `.kimi/skills/`,
   `.claude/skills/`, `.codex/skills/`. Their descriptions are injected into
   your context — if a description matches the task, read that skill's
   `SKILL.md` first. Only edit skills under `.skills/`, never the mirrors.

4. **Verify before committing, and again after the final fix.** Minimum
   before a commit: `npm run test-compile`, the focused tests for the touched
   area, and `git diff --check`. Details: skill `review-fix-commit-loop`.

## Main-capability audit (required before push)

Every implementation commit must be assigned to exactly one main capability
in `docs/testing/main-capability-coverage.json`; `audit.head` must advance to
the last implementation commit. Use the automation in a separate
documentation-only audit commit:

```sh
node scripts/regenerate-capability-audit.js \
  --assign <sha>=<CAPABILITY-ID> [--assign ...] \
  --harvest none|updated:<comma-separated .skills/paths> \
  --commit "docs: record <topic> capability audit"
```

`--harvest` records the mandatory skill harvest review (skill
`harvesting-workflow-lessons`) as a `Skill-Harvest` trailer in the audit
commit: `none` when no skill change was justified, or `updated:<paths>` for
the iterated `.skills/` directories.

Commits touching only `README.md`, `docs/`, or `.superpowers/` count as
documentation and need no assignment; everything else (including this file)
does. Then rerun `npm run test:behavior-contracts` before pushing.

## Common commands

- Compile for tests: `npm run test-compile`
- Dashboard webview checks: `node scripts/run-dashboard-webview-checks.js`
- Lint: `npm run lint`
- Behavior contracts: `npm run test:behavior-contracts`
- Build + install the extension locally: `npm run install-local`
  (set `SKIP_NPM_CI=1` when dependencies are already installed)

## Key paths

- Dashboard webview HTML/icons: `src/webview/webviewContent.ts`,
  `src/webview/webviewIcons.ts`; webview scripts/styles: `media/`
- AI sessions: `src/aiSessions/`; TODOs: `src/todos/`; prompts: `src/prompts/`
- Behavior catalog and capability manifest: `docs/testing/`
