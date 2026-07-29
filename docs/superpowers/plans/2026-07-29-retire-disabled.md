# Retire `.disabled` — Implementation Plan

> **For agentic workers:** implement task-by-task, commit after each task
> with conventional-commit subjects.  Plan lock: user decisions on
> 2026-07-29 (no auto-sweep of `.disabled`, destructive deletes for losers,
> confirm modal for unmanaged Delete).
>
> Design: `docs/superpowers/specs/2026-07-29-retire-disabled-design.md`  
> Worktree: `/home/hzcheng/projects/repos/vscode-dashboard/.worktrees/feat-ai-skill-management`, branch `feat/ai-skill-management`

**Goal:** Remove the `.disabled` parking mechanism and the
`SkillRecord.enabled` field entirely. Unmanaged skill removal becomes a
real delete with a confirmation modal; centralize/migrate/sync losers are
deleted after the winner is secured. Existing `.disabled` directories are
ignored (dot-skipped) and are never touched by the extension.

**Tech Stack:** TypeScript → CommonJS `out/`, plain JS webview scripts,
SCSS → `npx gulp buildStyles copyWebviewAssets`, `node --test` browser
suite, `scripts/run-skill-management-checks.js` assertion suite.

## Global Constraints

- Always run `npx tsc -p ./` before `node scripts/run-skill-management-checks.js`.
- After editing `src/webview/webviewDashboardScripts.js` or
  `media/styles.scss`, run `npx gulp buildStyles copyWebviewAssets` so
  `media/webviewDashboardScripts.js` and `media/styles.css` regenerate and
  remain byte-identical to source.
- Dot-directories are skipped by `readdirSync` filtering already present
  in `discovery.ts`/`centralService.ts`; this is the only mechanism for
  handling `.disabled`.
- No new `.disabled` directory is ever created. Losers are deleted only
  after the winner mutation succeeds.

## Core Interface Changes

```ts
// src/skills/types.ts
export interface SkillRecord {
    name: string;
    description: string;
    dirPath: string;
    skillFilePath: string;
    scope: SkillScope;
    source: SkillSourceDir;
    // enabled: boolean;        ← removed
    contentHash: string;
    folder: string;
    visibility: Record<SkillAgentId, SkillVisibility>;
    shadowedBy: Partial<Record<SkillAgentId, string>>;
    projectVisibility?: Record<SkillAgentId, SkillVisibility>;
    projectShadowedBy?: Partial<Record<SkillAgentId, string>>;
    diagnostics: SkillDiagnostic[];
    central?: SkillCentralInfo;
}
```

```ts
// src/skills/migrateService.ts
export interface SkillMigrationReport {
    ok: boolean;
    migrated: string[];
    drifted: string[];
    deleted: string[];        // was parked: string[]
    skipped: Array<{ name: string; reason: string }>;
    errors: Array<{ name: string; error: string }>;
}
```

New webview → host message:

```ts
{ type: 'delete-skill', dirPath: string }
```

Removed webview → host message:

```ts
// { type: 'toggle-skill', dirPath: string, enabled: boolean }
```

## Tasks

### T1: Remove backend `.disabled` scaffolding

- [ ] `src/skills/roots.ts`: remove `DISABLED_DIR_NAME` export.
- [ ] Delete `src/skills/toggleService.ts`.
- [ ] `src/skills/types.ts`: remove `enabled` from `SkillRecord`.
- [ ] `src/skills/discovery.ts`:
  - remove `DISABLED_DIR_NAME` import and `.disabled` scan in `scanRoot`;
  - drop `enabled` parameter from `createRecord` / `scanDir` / `scanRoot`;
  - stop emitting `enabled` on records.
- [ ] `src/skills/effectiveness.ts`: remove `!record.enabled` skip and any
  `candidate.enabled` guard.
- [ ] `src/skills/skillGroupStore.ts`: simplify `getSkillStableKey`
  root-normalization (no `.disabled` branch).
- [ ] `src/skills/syncService.ts`: remove `.disabled` normalization in
  `computeSkillCopyTargets`.
- [ ] Fix any remaining `DISABLED_DIR_NAME` / `SkillToggleResult` imports.
- [ ] `scripts/run-skill-management-checks.js`: remove assertions that
  reference `toggleService`, `.disabled`, or `enabled` in
  discovery/effectiveness; add assertions that `DISABLED_DIR_NAME` is
  absent from `roots.ts` output and `enabled` is absent from the
  `SkillRecord` type.
- [ ] Compile: `npx tsc -p ./`. Run: `npm run test:skills`.
- [ ] Commit: `refactor: remove .disabled scaffolding and SkillRecord.enabled`.

### T2: Change losers to delete (centralize / migrate / sync)

- [ ] `src/skills/centralService.ts`:
  - delete `parkRealDir`;
  - in `centralizeSkill`, after the winner move and optional link-back
    succeed, delete each losing duplicate via
    `fs.rmSync(duplicate.dirPath, { recursive: true, force: true })`;
    stop and return the first delete error.
- [ ] `src/skills/migrateService.ts`:
  - rename report field `parked` → `deleted`;
  - delete loser directories after `centralizeSkill` succeeds;
  - report deleted paths.
- [ ] `src/skills/syncService.ts`:
  - rewrite `syncSkillDir` to rename the losing target aside into a
    temp directory (`fs.mkdtempSync`), copy the winner, then delete the
    aside;
  - preserve rollback: on copy failure move the aside back.
- [ ] `src/skills/dashboardController.ts`: update `handleMigrateToCentral`
  to merge `deleted` instead of `parked`.
- [ ] `src/dashboard.ts`: update migrate confirmation/summary text
  ("copies are deleted" / "N duplicate(s) deleted").
- [ ] `scripts/run-skill-management-checks.js`: update centralize/migrate/sync
  assertions for delete semantics (no `.disabled`, losers deleted, sync
  aside cleaned up).
- [ ] Compile: `npx tsc -p ./`. Run: `npm run test:skills`.
- [ ] Commit: `feat: delete losing skill copies instead of parking`.

### T3: Add `delete-skill` host path

- [ ] `src/skills/dashboardController.ts`:
  - remove `handleToggle` and `checkToggleContainment`;
  - add `handleDeleteSkill(dirPath)`:
    - find the matching record by `dirPath`;
    - refuse if `record.central`;
    - refuse unless `path.dirname(dirPath)` is one of the known agent
      skills roots (user + project);
    - refuse if `fs.lstatSync(dirPath)` is a symlink (real directories
      only);
    - `fs.rmSync(dirPath, { recursive: true, force: true })`;
    - refresh.
- [ ] `src/dashboard.ts`:
  - remove `toggle-skill` message handler;
  - add `delete-skill` handler:
    - show modal confirmation using the skill name
      (`vscode.window.showWarningMessage` with `modal: true`, actions
      `Delete` / `Cancel`);
    - on confirm call `skillDashboardController.handleDeleteSkill`;
    - surface errors as warning messages.
- [ ] `scripts/run-skill-management-checks.js`: assert `delete-skill`
  wiring present, `toggle-skill` wiring absent, delete containment
  validation exists in dashboardController.
- [ ] Compile: `npx tsc -p ./`. Run: `npm run test:skills`.
- [ ] Commit: `feat: delete unmanaged skills with confirm modal`.

### T4: Update webview UI and media parity

- [ ] `src/webview/webviewSkillContent.ts`:
  - replace the unmanaged master toggle with a Delete button
    (`data-skill-delete`) next to the Centralize button;
  - remove `parkedNote`, `skill-card-disabled` class, and the
    parked-duplicates disclosure from `renderScopeSection`;
  - simplify `getSkillRootDir` (no `.disabled` branch);
  - remove `DISABLED_DIR_NAME` import.
- [ ] `src/webview/webviewDashboardScripts.js`:
  - remove `toggle-skill` click handler and
    `data-skill-parked-toggle` handler;
  - add `delete-skill` click handler that posts the new message.
- [ ] `media/styles.scss`:
  - remove `.skill-parked-note`, `.skill-parked-duplicates`,
    `.skill-parked-duplicates-toggle`, `.skill-card-disabled`, and the
    unused `.skill-toggle` rules if they are skill-only;
  - add `.skill-delete` styling mirroring `.skill-centralize`.
- [ ] `npx gulp buildStyles copyWebviewAssets` to regenerate
  `media/styles.css` and `media/webviewDashboardScripts.js`.
- [ ] Verify `diff src/webview/webviewDashboardScripts.js media/webviewDashboardScripts.js` is empty.
- [ ] `scripts/run-skill-management-checks.js` and
  `tests/browser/skillsFolderTree.test.js`:
  - remove parked/disabled assertions;
  - assert Delete button markup present, toggle markup absent, parked
    disclosure absent.
- [ ] Compile: `npx tsc -p ./`. Run: `npm run test:skills` and
  `npm run test:browser`.
- [ ] Commit: `feat: replace unmanaged toggle with Delete button and drop parked UI`.

### T5: Docs, stray file cleanup, and full verification

- [ ] Delete accidentally committed `scripts/fixtures/x`.
- [ ] `README.md`: update skill-management copy to describe central-store
  model and delete semantics (no `.disabled` parking).
- [ ] `docs/superpowers/specs/2026-07-29-retire-disabled-design.md`:
  mark status `implemented`.
- [ ] `docs/superpowers/plans/2026-07-29-retire-disabled.md`: tick task
  checkboxes and note verification results.
- [ ] Full verification (fresh):
  - `npm run test:skills`
  - `npm run test:dashboard`
  - `npm run test:browser`
  - `npm run test:unit`
  - `npm run test:contract`
  - `npm run test:integration`
  - `npm run test:safety`
  - `git diff --check HEAD`
- [ ] Commit: `docs: update README for retired .disabled mechanism`.
- [ ] Commit: `chore: remove accidentally committed empty fixture`.

## Follow-ups (Minor / ledger)

- Symlink-cycle visited-sets in `scanCentralStore` / `walkSkillDirs`
  (pre-existing, still Minor).
- Double project brand-winner computation (still Minor).
- Warn-chip precedence / conflict UX (still Minor).
- Final whole-branch review deferred until feature churn subsides.
