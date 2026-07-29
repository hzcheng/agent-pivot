# Task 9 Report: Dashboard controller + host wiring

**Status:** DONE — `npm run test-compile && node scripts/run-skill-management-checks.js` → `Skill management checks passed.`

## What was implemented

### 1. `src/skills/dashboardController.ts` (new)
Exact controller per the brief, with two trivial deviations:
- Dropped the brief's unused `import * as path from 'path'`.
- `resetWatchers()` reads `getWorkspaceRoot()` once into a local instead of calling it twice with an `as string` cast (same semantics, no double-invoke race).

Behavior as specified: `start()` → `refresh('start')`; `refresh()` scans inside try/catch (`logError` + `records = []` on failure, never throws), rebuilds watchers, posts `skills-updated` `{html}` only when visible; `handleToggle(dirPath, enabled)` maps `enabled === true → disableSkill`, `enabled === false → enableSkill` (webview polarity preserved, not "fixed"), logs failures, refreshes, returns `{ok, error?}`; watchers are non-recursive `fs.watch` on every skills root dir + every scanned skill dir, per-dir try/catch + `watcher.on('error')` swallow, debounced 300 ms → `refresh('watch')`; `dispose()` clears the debounce timer and closes all watchers, and `refresh()` no-ops once disposed.

### 2. `src/dashboard.ts` wiring — real integration points found
- **Provider API:** `provider.postMessage(message): Thenable<boolean>` (resolves `false` when no view — safe pre-resolve) and `provider.visible` (boolean getter). Both exist on `AgentPivotViewProvider` exactly as the brief assumed.
- **Handler registration:** the plan's claim "messageRouter.ts needs no change" is **verified true** — `createDashboardMessageRouter` dispatches unknown types through the generic `handlers: Record<string, DashboardMessageHandler>` map passed from `dashboard.ts`. The two handlers were added to that map (right before `'prompt-command'`, grouping with the other panel handlers):
  - `'toggle-skill'` → `skillDashboardController.handleToggle(String(e.dirPath || ''), e.enabled === true)`, `showWarningMessage` on `!result.ok`.
  - `'open-skill-file'` → `vscode.window.showTextDocument(vscode.Uri.file(String(e.skillFilePath || '')))`. No local try/catch (matches brief and sibling handlers); `AgentPivotViewProvider.handleMessage` already wraps `onMessage` in try/catch + `logError`, so a bad path is logged, never crashes the host.
- **Controller placement/lifecycle:** instantiated inside `initializeDashboard` immediately after `promptDashboardController` (where `provider`, `logError`, `ownResource` are in scope), then `skillDashboardController.start()`. **Adaptation vs. brief:** the brief said `context.subscriptions.push({ dispose })`; I used `ownResource(() => new SkillDashboardController({...}))` instead, which is how *every* controller created in `initializeDashboard` is owned (`AiSessionDashboardController`, `AttentionBridgeClient`, etc.). Bootstrap `transfer: resources => resources.transferTo(context.subscriptions)` lands it in `context.subscriptions` on success, while a discarded/retried bootstrap generation disposes it instead of leaking watchers. Net effect identical to the brief on the happy path, strictly safer on retry.
- **`stewardInfos`:** added `get skills() { return skillDashboardController.getRecords() },` to the `StewardInfos` literal (line ~1923). `StewardInfos.skills?: SkillRecord[]` already existed in `src/models.ts` from Task 6/8; the getter is lazy so it always serves the latest scan to `getStewardContent`. No TDZ hazard: controller is declared at ~line 405, all references (handlers ~1322, getter ~1923) are later lexically and only invoked post-init anyway.
- Added `import * as os from 'os';` (was missing) and `import { SkillDashboardController } from './skills/dashboardController';`.

### 3. `scripts/run-skill-management-checks.js`
- `require('../out/skills/dashboardController')` placed **while the `vscode` Module._load stub is still active** (next to the webview requires, before the restore) — required because it transitively loads `webviewSkillContent` → `webviewContent` → `vscode`.
- Appended `runSkillControllerChecks()` (brief code verbatim, uses existing `makeFixture()`) and `runSkillWiringChecks()` — **split per approved deviation**: only the four `src/dashboard.ts` source assertions (`new SkillDashboardController(`, `'toggle-skill'`, `'open-skill-file'`, `skillDashboardController.getRecords()`). The two `packageJson.scripts` assertions were **deliberately omitted**; they land with the package.json change in Task 10.
- Both called in main before the final `console.log`.

## TDD evidence
- **RED:** after adding the require + tests but before implementing:
  `Error: Cannot find module '../out/skills/dashboardController'` (Require stack: run-skill-management-checks.js) — matches the brief's expected failure.
- **GREEN:** after implementing controller + wiring:
  `Skill management checks passed.`

## Verification run
- `npm run test-compile && node scripts/run-skill-management-checks.js` → `Skill management checks passed.`
- `node scripts/check-tslint-baseline.js` → passed (remaining warnings pre-existing).
- `node scripts/run-dashboard-webview-checks.js` → passed.
- `node scripts/check-behavior-contracts.js` → passed. `node scripts/run-architecture-guards.js` → passed.
- `npm run test:unit` → all pass except `tests/unit/tooling/brandAssets.test.js`, which fails with `Cannot find module 'sharp'` — pre-existing missing optional tooling dependency, unrelated to this change.
- `npm run test:integration` → 255/255 pass.

## Files changed
- `src/skills/dashboardController.ts` (new)
- `src/dashboard.ts` (os import, controller import, instantiation + `start()` after `promptDashboardController`, two router handlers, `stewardInfos.skills` getter)
- `scripts/run-skill-management-checks.js` (stubbed require placement, `runSkillControllerChecks`, `runSkillWiringChecks` — dashboard.ts assertions only)

No git mutations of any kind (no commits, no index changes).

## Self-review findings & concerns
1. **Toggle double-refresh (benign):** `handleToggle` refreshes synchronously; the rename also fires watchers → one extra debounced `refresh('watch')` ~300 ms later. Harmless (idempotent rescan).
2. **External `.disabled` changes:** parked dir contents aren't watched (`.disabled` is skipped by the scanner and not a watch target), so external park/unpark without touching the watched roots won't auto-refresh. Host-initiated toggles always refresh explicitly. Matches the brief's design.
3. **`nowMs?` option** is declared in the options interface per the brief but unused by the implementation (debounce uses the constant directly); kept for interface parity with the plan.
4. **Task 10 reminder:** the split-out `package.json` script assertions (`test:skills` / `test:safety` including `run-skill-management-checks.js`) still need to land with the package.json change; `runSkillWiringChecks` intentionally does not assert them yet.
5. **Hidden-while-scanning:** watchers stay active when the webview is hidden, so `getRecords()` (and thus the next full render via `stewardInfos.skills`) is fresh even though `skills-updated` posts are suppressed while hidden — no stale-panel risk on re-show.
