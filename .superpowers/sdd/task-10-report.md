# Task 10 Report: Packaging, README, full verification

Date: 2026-07-28. Branch worktree: `.worktrees/feat-ai-skill-management`.
No commits, no index mutations — working tree only. (Overwrites a stale
same-named report left by an earlier, unrelated plan.)

## Files changed (this task)

1. `package.json`
   - Added `"test:skills": "npm run test-compile && node scripts/run-skill-management-checks.js",`
     directly after `test:open-projects` (8-space indent, matching neighbors).
   - Appended ` && node scripts/run-skill-management-checks.js` to the END of
     **`test:safety:run`** (not `test:safety`). Rationale: `test:safety` is a
     thin wrapper (`npm run test-compile && npm run test:safety:run`); the
     actual check-script chain lives in `test:safety:run`, where
     `run-open-project-safety-checks.js` is chained — this mirrors the existing
     pattern exactly. Bonus: CI (`test:ci:linux`) invokes `test:safety:run`, so
     the skill checks now run in CI; appending to `test:safety` instead would
     have left CI without them. `npm run test:safety` behavior is unchanged in
     shape: it runs the full chain including skill checks.
2. `scripts/run-skill-management-checks.js` — extended `runSkillWiringChecks`
   with the package.json wiring assertions:
   ```js
   const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
   assert.ok(packageJson.scripts['test:skills'].includes('run-skill-management-checks.js'));
   // test:safety delegates to test:safety:run, which owns the check-script chain.
   assert.ok(packageJson.scripts['test:safety:run'].includes('run-skill-management-checks.js'));
   ```
   Deviation from the briefed form: the second assertion keys on
   `test:safety:run` instead of `test:safety`, matching where the chain was
   actually appended (see above). A `test:safety`-keyed assertion cannot pass
   with the chain in `test:safety:run`; one of the two had to give, and the
   chain placement was the explicitly conditional instruction.
3. `README.md`
   - Feature list: one bullet after the session-discovery bullet —
     "Discovers Kimi, Claude, and Codex skills in one SKILLS tab, with
     per-agent effectiveness, shadowing diagnostics, and one-click
     enable/disable."
   - `## Agent sessions`: one short paragraph after the conversation-outlines
     paragraph describing the SKILLS tab (unified discovery, per-agent
     effectiveness with shadowing diagnostics, one-click toggle).
4. `src/webview/webviewSkillContent.ts` — **regression fix** (see below):
   empty-state string changed from
   `No skills found in Kimi, Claude, or Codex skill directories.` to
   `No skills found in agent skill directories.`

## TDD sequence for the wiring assertions

- Assertions added first → `node scripts/run-skill-management-checks.js`
  FAILED: `TypeError: Cannot read properties of undefined (reading 'includes')`
  at the `test:skills` assertion (red, as expected).
- After the package.json edits → `Skill management checks passed.` (green).
  `package.json` re-validated as parseable JSON.

## Regression found by full verification, and fixed

First `npm run test:safety` run FAILED in the pre-existing guard script
`scripts/run-ai-session-safety-checks.js`:

```
AssertionError [ERR_ASSERTION]: anonymous navigation attention must omit Codex
true !== false
    at runCurrentWorkspaceRenderingChecks (scripts/run-ai-session-safety-checks.js:5867:16)
```

Diagnosis: the guard slices `html.slice(html.indexOf('OTHER WINDOWS'))` and
asserts no provider names (`Codex`, `Kimi`, `Claude`, …) leak into the
anonymous navigation region. The SKILLS tab panel renders after the OPEN tab
in `getStewardContent`, and its empty state (`getSkillsPanelContent([])`)
contained the literal provider names. Verified this is **our branch's
regression, not pre-existing**: `src/webview/webviewSkillContent.ts` does not
exist at `HEAD` (`git show HEAD:...` → "not in 'HEAD'"), and
`run-ai-session-safety-checks.js` is untouched by this branch. Earlier tasks
never ran `test:safety` (task-9 report only reminds that the wiring was still
pending), so the leak survived until this task's full run — exactly what
Task 10 verification is for.

Fix: reworded the empty state to drop provider names (one line, in the
branch's own file; no test pins the old string). The plan document still
contains the old string inside a historical code block — left as-is.

## Verification results (final working-tree state, in brief order)

| # | Command | Result |
|---|---------|--------|
| 1 | `npm run test:skills` | PASS (exit 0) |
| 2 | `npm run test:open-projects` | PASS (exit 0) |
| 3 | `npm run test:dashboard` | PASS (exit 0) |
| 4 | `npm run test:safety` | PASS (exit 0) — after the regression fix above |
| 5 | `npx gulp --production` | PASS (exit 0) |

Commands 1–3 were re-run after the `webviewSkillContent.ts` fix so every
recorded result reflects the final tree (each `test:*` recompiles via
`test-compile`).

Output tails:

`npm run test:skills`:
```
npm notice run agent-pivot@1.0.0 attention:bridge:compile
npm notice run tsc -p extensions/attention-ui-bridge/tsconfig.json
Skill management checks passed.
```

`npm run test:open-projects`:
```
npm notice run tsc -p extensions/attention-ui-bridge/tsconfig.json
Open workspace safety checks passed.
```

`npm run test:dashboard`:
```
npm notice run node scripts/run-dashboard-webview-checks.js
Dashboard Webview checks passed.
```

`npm run test:safety` (note the chained skill checks at the end):
```
npm notice run node scripts/run-workspace-parity-checks.js && node scripts/run-ai-session-tmux-checks.js && node scripts/run-ai-session-safety-checks.js && node scripts/run-open-project-safety-checks.js && node scripts/run-skill-management-checks.js
Workspace parity checks passed.
AI session tmux checks passed.
AI session safety checks passed.
Open workspace safety checks passed.
Skill management checks passed.
```

`npx gulp --production`:
```
[09:22:55] Starting 'default'...
[09:22:55] Starting 'buildStyles'...
[09:22:55] Starting 'copyWebviewAssets'...
[09:22:55] Starting 'copyNodeAssets'...
[09:22:56] Finished 'buildStyles' after 380 ms
[09:22:56] Finished 'copyNodeAssets' after 386 ms
[09:22:56] Finished 'copyWebviewAssets' after 390 ms
[09:22:56] Finished 'default' after 391 ms
```

## `git diff --check` (substitute)

The plan's `git diff --check main...HEAD` is meaningless here (no commits on
the branch). Substituted `git diff --check HEAD` (working tree vs base):

- Result: **exit 2 — 12 trailing-whitespace warnings**, ALL of them in two
  generated design-mockup assets staged by the plan's design phase:
  - `docs/superpowers/specs/assets/skill-management-diagnostic.html` (lines 110, 121)
  - `docs/superpowers/specs/assets/skill-management-tab-list.html` (lines 110, 121, 135, 149, 176, 187, 201, 214, 225, 239)
- None are in Task 10 files (`package.json`, `README.md`,
  `scripts/run-skill-management-checks.js`, `src/webview/webviewSkillContent.ts`)
  or in any source file — all are whitespace-only lines in the mockup HTML.
- Left untouched: fixing staged content properly requires the index, which is
  off-limits for this task. Remedy for the committer: strip trailing spaces in
  those two files (cosmetic only) and re-stage.

## Pre-existing failures

- The known pre-existing `brandAssets.test.js` failure (missing optional
  `sharp` dep) was NOT encountered: none of the five verification commands run
  that suite. Nothing in this branch's diff touches brand assets.
- No other pre-existing failures observed.

## Concerns

1. Assertion-key deviation (`test:safety` → `test:safety:run`) documented
   above; if the exact briefed assertion text is preferred instead, move the
   append from `test:safety:run` to `test:safety`
   (`npm run test-compile && npm run test:safety:run && node scripts/run-skill-management-checks.js`)
   — but then `test:ci:linux` would skip the skill checks.
2. The plan doc (`docs/superpowers/plans/2026-07-21-skill-management.md`)
   still shows the old empty-state string in its Task 6 code block; harmless
   historical spec text, updated nowhere else.
3. The empty-state rewording drops provider names from the SKILLS empty view;
   README/tab copy still communicates Kimi/Claude/Codex coverage.
4. `git diff --check HEAD` is not clean due to the design-mockup whitespace
   (see above) — decision left to the committer.
