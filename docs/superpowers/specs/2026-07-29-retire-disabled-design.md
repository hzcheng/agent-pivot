# Retire `.disabled` — Delete-Only Skill Removal Design

> Status: implemented (2026-07-29)
> Date: 2026-07-29
> Worktree: `.worktrees/feat-ai-skill-management` (branch `feat/ai-skill-management`)

## Background

Skill management v1 (2026-07-21) introduced a reversible "parking"
mechanism: disabling an unmanaged skill moved its directory into
`<agent root>/.disabled/<name>`, and losing duplicate copies during
centralize / migrate / sync were parked under `.disabled/` instead of
being destroyed. The panel gained parked-note rendering, a
parked-duplicates disclosure, and matching containment guards.

User decision (2026-07-29): **the product has not shipped; backward
compatibility is not a goal.** The `.disabled` mechanism is retired
entirely in favor of the central-store model, and every removal
operation becomes a real delete:

- Turning off an unmanaged skill **deletes its directory**.
- Losing duplicate copies in centralize / migrate / sync are **deleted**.
- Existing `.disabled` directories on disk are **ignored** (dot-skipped
  by discovery, like any other hidden directory). **No automatic sweep:**
  the extension never deletes `.disabled` on its own (user decision,
  2026-07-29). The four directories present on the dev machine were
  removed by hand as a one-time cleanup.

## Product direction

**The central store is the only place skills live; agent roots hold
symlinks or nothing.** There is no "suspended" state for a skill. A
skill is either present (effective where located/linked) or gone.

| Job to be done | Today | Product answer |
| --- | --- | --- |
| Turn off an unmanaged skill | Park into `.disabled` (reversible) | Delete the directory (with confirm) |
| Centralize/migrate with duplicate copies | Losers parked under `.disabled` | Losers deleted after the winner is secured |
| Sync a drifted copy ("Use this copy") | Loser parked, winner copied over, rollback on failure | Loser deleted, winner copied over, rollback on failure |
| See previously disabled skills | `.disabled` scan + disclosure | Gone; nothing to show |

## Behavior changes

### Unmanaged skill card

- The iOS-style master toggle (`data-skill-toggle`, message
  `toggle-skill`) is **removed**.
- A **Delete** button (`data-skill-delete`, new message `delete-skill`)
  appears on unmanaged cards instead. Clicking triggers a host
  confirmation modal (`Delete skill "<name>" permanently? This cannot be
  undone.`) and, on confirm, `fs.rmSync(dirPath, { recursive: true })`.
- Delete containment (replaces toggle containment):
  - `dirPath` must be a **direct child of a known agent skills root**
    (`~/.kimi|claude|codex/skills/<name>` or the project equivalents,
    including the `agents` roots) — same root list as today.
  - The on-disk entry at that path must **not be a symlink**
    (`fs.lstatSync`): deleting a symlink's resolved target could destroy
    an unrelated directory outside the roots; such entries are refused
    with a visible error. (Note: `record.dirPath` is realpath-resolved
    for symlinked entries, so the guard must lstat the actual path being
    deleted and refuse when `path.join(root, record.name)` differs from
    `record.dirPath`.)
- Central skills never show Delete: their enablement is link-based, and
  store content is managed through folders/moves.

### Centralize (single skill)

- Winner moves into the store and links back from its original root
  (unchanged).
- Each losing duplicate real directory is **deleted** (`fs.rmSync`
  recursive) instead of parked, and only **after the winner's move +
  link-back have both succeeded**, so a failed centralize never destroys
  a copy.

### Migrate to central (bulk)

- Same winner/loser logic (kimi > claude > codex), losers deleted per
  skill after that skill's winner is secured.
- Report field `parked: string[]` becomes `deleted: string[]`; the
  summary toast reads "N duplicate(s) deleted".
- The pre-migration confirmation text drops "parked reversibly" and
  states that losing copies are deleted.

### Sync (drift resolution, "Use this copy")

- `syncSkillDir` renames the losing target aside into the system temp
  directory (`fs.mkdtempSync`), copies the winner into place, then
  **deletes** the aside copy. Rollback on copy failure is unchanged
  (aside moved back, so the target never ends up missing). No
  `.disabled` directory is created anywhere.

### Discovery & effectiveness

- `scanRoot` no longer scans `<root>/.disabled`; the `enabled` flag is
  removed from `SkillRecord` (all discovered records are present and
  effective where located/linked). Effectiveness drops the
  `!record.enabled` skip.
- `DISABLED_DIR_NAME` is deleted from `roots.ts` along with every
  import (`toggleService.ts` is deleted; `skillGroupStore`,
  `syncService.computeSkillCopyTargets`, `webviewSkillContent`
  root-normalization are simplified).

### Panel UI

- Removed: parked note (`parked at …`), `skill-card-disabled` styling,
  the parked-duplicates disclosure (`data-skill-parked-toggle` button,
  panel, styles, and click handler), and the master-toggle markup for
  unmanaged cards.
- The Unmanaged section keeps source-group rendering and the Centralize
  action; cards gain the Delete button described above.

### Compatibility

- None. Existing `.disabled` directories on disk are ignored by the scan
  (they start with a dot) and are never touched by the extension.
  `SkillRecord.enabled` deserialization is not a concern: records are
  rebuilt from disk on every scan, nothing is persisted.

## Backend changes

| Module | Change |
| --- | --- |
| `roots.ts` | Remove `DISABLED_DIR_NAME` |
| `toggleService.ts` | **File deleted** |
| `types.ts` | Remove `SkillRecord.enabled` |
| `discovery.ts` | Drop `.disabled` scan, `enabled` param, and record field |
| `effectiveness.ts` | Drop `!record.enabled` skip |
| `centralService.ts` | Delete `parkRealDir`; `centralizeSkill` deletes duplicates after winner secured |
| `migrateService.ts` | `parked` → `deleted`; losers deleted; docstrings updated |
| `syncService.ts` | `syncSkillDir` aside-to-temp + delete; `computeSkillCopyTargets` drops `.disabled` normalization |
| `skillGroupStore.ts` | Drop `.disabled` path normalization in `getSkillStableKey` |
| `dashboardController.ts` | `handleToggle`/`checkToggleContainment` → `handleDeleteSkill` with delete containment; migrate report field rename |
| `dashboard.ts` | `toggle-skill` handler → `delete-skill` (with confirm modal); migrate summary/confirm text updated |
| `webviewSkillContent.ts` | Delete button replaces master toggle; parked note/disclosure/disabled-class rendering removed; root normalization simplified |
| `webviewDashboardScripts.js` (+ `media/` copy) | Delete click handler posts `delete-skill`; parked-toggle and toggle handlers removed |
| `media/styles.scss` | Remove `.skill-parked-*`, `.skill-card-disabled`, `.skill-toggle` styles; add Delete button style |

## Error handling

- Delete is the only destructive operation and always sits behind a
  confirmation modal plus the containment guard. Failures surface as
  warning toasts plus a refresh (unchanged pattern).
- Centralize/migrate/sync delete losers only after the winner is fully
  secured; a failure before that point leaves all copies untouched.
- Batch operations (migrate, folder toggles) continue past per-skill
  errors and summarize failures in the toast (unchanged).

## Testing

- `run-skill-management-checks.js`: delete containment (root child ✓ /
  outside root ✗ / symlink entry ✗), `delete-skill` wiring (webview post,
  host handler, confirm modal), centralize deletes duplicates,
  migrate `deleted` report + toast text, sync aside-delete with rollback,
  no `.disabled` references remain in `src/`, `SkillRecord.enabled`
  removed, parked/disclosure markup absent from rendering.
- Browser tests: Delete button renders on unmanaged cards only; clicking
  posts `delete-skill`; parked disclosure no longer rendered.
- Contract/dashboard checks: `toggle-skill` handler gone, `delete-skill`
  present.
- README updated (no more `.disabled` parking; delete semantics).
