# Skill Folders & Scoped Enablement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild skill management so the panel tree mirrors the on-disk central-store folder hierarchy (`~/.skills`, `<project>/.skills`), with per-scope (global/project) per-agent iOS link switches on cards and batch switches on folder headers.

**Architecture:** The on-disk folder tree is the single source of truth (design: `docs/superpowers/specs/2026-07-28-skill-folders-design.md`). Discovery scans central stores recursively (skill = directory with `SKILL.md`, folder = relative parent path) and attributes top-level agent-root symlinks to central records by scope + agent. The webview renders a nested folder tree per scope section plus an Unmanaged section for real-directory skills still in agent roots. All mutations are non-destructive filesystem operations followed by an authoritative HTML refresh.

**Tech Stack:** TypeScript (VS Code extension, CommonJS out dir), plain JS webview scripts, SCSS → gulp-compiled CSS, `node --test` browser tests, `scripts/run-skill-management-checks.js` assertion suite.

## Global Constraints

- Worktree: `/home/hzcheng/projects/repos/vscode-dashboard/.worktrees/feat-ai-skill-management`, branch `feat/ai-skill-management`. All paths below are relative to it.
- Checks run against compiled output: always `npx tsc -p ./` before `node scripts/run-skill-management-checks.js` (the check script requires `out/**`).
- After editing `media/styles.scss` or `src/webview/*.js`, run `npx gulp buildStyles copyWebviewAssets` so `media/styles.css` and `media/webviewDashboardScripts.js` regenerate.
- Agents scan exactly one directory level: links are always top-level entries of an agent skills root.
- Every filesystem mutation is non-destructive: losers park under `.disabled`, moves refuse to overwrite, link removal refuses real directories.
- Commit after every task with the repo's conventional-commit style (`feat:`, `refactor:`, `test:`, `docs:`).

## Core Interfaces (locked)

```ts
// src/skills/types.ts
export type SkillAgentId = 'kimi' | 'claude' | 'codex';
export type SkillScope = 'user' | 'project';
export type SkillSourceDir = 'kimi' | 'claude' | 'codex' | 'agents' | 'central';

/** links[scope][source] = link path; source is one of kimi|claude|codex|agents ('central' never appears). */
export type SkillLinkMap = Partial<Record<SkillScope, Partial<Record<SkillSourceDir, string>>>>;

export interface SkillCentralInfo {
    /** Real directory inside the central store. */
    dirPath: string;
    links: SkillLinkMap;
}

export interface SkillRecord {
    name: string;
    description: string;
    dirPath: string;
    skillFilePath: string;
    scope: SkillScope;
    source: SkillSourceDir;
    enabled: boolean;
    contentHash?: string;
    /** Folder path inside the central store ('' = store root, 'a/b' = nested). Always '' for non-central records. */
    folder: string;
    central?: SkillCentralInfo;
    visibility: Record<SkillAgentId, SkillVisibility>;       // evaluated at record.scope (unchanged)
    shadowedBy: Partial<Record<SkillAgentId, string>>;
    /** Central records with project-scope links: effectiveness evaluated at project scope (inherits user links). */
    projectVisibility?: Record<SkillAgentId, SkillVisibility>;
    projectShadowedBy?: Partial<Record<SkillAgentId, string>>;
    diagnostics: SkillDiagnostic[];
}
```

```ts
// src/skills/centralService.ts (additions)
export interface FolderLinkResult {
    ok: boolean;
    changed: number;
    errors: Array<{ name: string; error: string }>;
}
export function setFolderLinks(
    storeRoot: string, folder: string, scope: SkillScope,
    homeDir: string, workspaceRoot: string | undefined, enable: boolean,
): FolderLinkResult;
export function moveSkillToFolder(
    record: SkillRecord, targetFolder: string, homeDir: string, workspaceRoot?: string,
): CentralResult;   // CentralResult { ok, dirPath?, error? } — dirPath is the NEW location
```

```ts
// src/skills/dashboardController.ts (changes)
handleCentralToggle(dirPath: string, scope: SkillScope, agent: SkillAgentId, enabled: boolean): { ok: boolean; error?: string };
handleFolderToggle(storeRoot: string, folder: string, scope: SkillScope, enabled: boolean): FolderLinkResult;
handleMoveToFolder(dirPath: string, folder: string): { ok: boolean; error?: string };
```

```ts
// Webview message surface (dashboard.ts handlers)
'central-toggle-skill'  { dirPath, source, scope, enabled }   // source = agent id; enabled = CURRENT state (click flips)
'folder-toggle-skill-links' { storeRoot, folder, scope, enabled }
'move-skill-to-folder'  { dirPath, folder }
```

```html
<!-- Markup contracts used by JS + checks -->
<button data-skill-scope-select="user|project">            <!-- filter-row scope selector -->
<div class="skill-folder" data-skill-folder="superpowers" data-skill-store="/home/u/.skills" data-skill-folder-scope="user">
  <button data-folder-toggle="" data-folder-scope="user" class="skill-ios-toggle[ off| indeterminate]">
<input  data-skill-move-folder="/abs/skill/dir">           <!-- move editor -->
<button data-central-toggle="/abs/skill/dir" data-central-source="kimi"
        data-link-user="/home/u/.kimi/skills/x" data-link-project="">
<span class="skill-chip" data-vis-user="active" data-vis-project="absent">
```

---

### Task 1: types + discovery — recursive central scan, folder paths, scope-nested links

**Files:**
- Modify: `src/skills/types.ts` (SkillRecord.folder, SkillLinkMap, SkillCentralInfo.links)
- Modify: `src/skills/discovery.ts` (recursive central scan; links carry scope; merge builds scope-nested links)
- Modify: `src/skills/effectiveness.ts` (compile fix only: read `links.user`; full behavior lands in Task 2)
- Modify: `src/skills/centralService.ts` (compile fix only: `knownBrandRoots` unchanged; link reads use scope map)
- Modify: `src/skills/migrateService.ts`, `src/skills/syncService.ts`, `src/skills/dashboardController.ts` (compile fixes for the type change)
- Test: `scripts/run-skill-management-checks.js` (new `runSkillFolderDiscoveryChecks`; update `runSkillCentralChecks` link assertions)

**Interfaces:**
- Consumes: existing `getCentralSkillsRoot`, `isUnderCentralRoot` from `roots.ts`.
- Produces: `SkillRecord.folder`, `SkillLinkMap`, scope-nested `central.links` exactly as in "Core Interfaces" above.

- [ ] **Step 1: Write the failing checks**

Add to `scripts/run-skill-management-checks.js` (and register `runSkillFolderDiscoveryChecks();` in the runner block before `runSkillGroupStoreChecks()`):

```js
function runSkillFolderDiscoveryChecks() {
    const real = dirPath => fs.realpathSync(dirPath);
    const home = real(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-folders-')));
    const ws = real(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-folders-ws-')));
    const write = (filePath, content) => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
    };
    write(path.join(home, '.skills/superpowers/alpha/SKILL.md'), '---\nname: alpha\ndescription: A\n---\n');
    write(path.join(home, '.skills/xiaohongshu/reddoc/r/SKILL.md'), '---\nname: r\ndescription: R\n---\n');
    write(path.join(home, '.skills/solo/SKILL.md'), '---\nname: solo\ndescription: S\n---\n');
    fs.mkdirSync(path.join(home, '.kimi/skills'), { recursive: true });
    fs.symlinkSync(path.join(home, '.skills/superpowers/alpha'), path.join(home, '.kimi/skills/alpha'), 'dir');
    fs.mkdirSync(path.join(ws, '.codex/skills'), { recursive: true });
    fs.symlinkSync(path.join(home, '.skills/xiaohongshu/reddoc/r'), path.join(ws, '.codex/skills/r'), 'dir');

    const records = discovery.scanSkills({ homeDir: home, workspaceRoot: ws });
    const alpha = records.find(record => record.name === 'alpha');
    assert.strictEqual(alpha.source, 'central');
    assert.strictEqual(alpha.scope, 'user');
    assert.strictEqual(alpha.folder, 'superpowers');
    assert.deepStrictEqual(alpha.central.links, { user: { kimi: path.join(home, '.kimi', 'skills', 'alpha') } });
    const r = records.find(record => record.name === 'r');
    assert.strictEqual(r.folder, 'xiaohongshu/reddoc');
    assert.deepStrictEqual(r.central.links, { project: { codex: path.join(ws, '.codex', 'skills', 'r') } });
    const solo = records.find(record => record.name === 'solo');
    assert.strictEqual(solo.folder, '');
    assert.deepStrictEqual(solo.central.links, {});
    // symlinked skill inside the store is followed and deduped by realpath
    fs.symlinkSync(path.join(home, '.skills/solo'), path.join(home, '.skills/alias-solo'), 'dir');
    const withAlias = discovery.scanSkills({ homeDir: home, workspaceRoot: ws });
    assert.strictEqual(withAlias.filter(record => record.dirPath === path.join(home, '.skills', 'solo')).length, 1,
        'store-internal alias symlink does not duplicate the record');
}
```

Also update `runSkillCentralChecks`: every `central.links` assertion becomes scope-nested, e.g.
`assert.deepStrictEqual(shared.central.links, { user: { kimi: '…/shared', codex: '…/shared' } })`, and the
controller assertions read `record.central.links.user?.claude`.

- [ ] **Step 2: Run checks to verify they fail**

Run: `npx tsc -p ./ && node scripts/run-skill-management-checks.js`
Expected: FAIL — `folder` undefined, links not scope-nested.

- [ ] **Step 3: Implement**

`src/skills/types.ts` — apply the "Core Interfaces" definition (add `folder: string`, `SkillLinkMap`,
nest `SkillCentralInfo.links`, add optional `projectVisibility` / `projectShadowedBy`).

`src/skills/discovery.ts`:

```ts
interface SkillLink {
    source: SkillSourceDir;
    scope: SkillScope;
    linkPath: string;
    targetPath: string;
}

// scanDir gains scope on links; signature becomes
// scanDir(root: SkillsRoot, parentDir: string, enabled: boolean, links: SkillLink[], input: ScanSkillsInput)
// and pushes { source: root.source, scope: root.scope, linkPath, targetPath } for central-bound symlinks.

function scanCentralStore(root: SkillsRoot, records: SkillRecord[]): void {
    const walk = (dirPath: string, folder: string): void => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dirPath, { withFileTypes: true });
        } catch (_error) {
            return;
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.')) {
                continue;
            }
            const fullPath = path.join(dirPath, entry.name);
            let realPath = fullPath;
            let isDirectory = entry.isDirectory();
            if (entry.isSymbolicLink()) {
                try {
                    realPath = fs.realpathSync(fullPath);
                    isDirectory = fs.statSync(realPath).isDirectory();
                } catch (_error) {
                    continue;
                }
            }
            if (!isDirectory) {
                continue;
            }
            if (readSkillFile(realPath)) {
                const record = createRecord(root, entry.name, realPath, true);
                if (record) {
                    record.folder = folder;
                    records.push(record);
                }
            } else {
                walk(realPath, folder ? `${folder}/${entry.name}` : entry.name);
            }
        }
    };
    walk(root.dirPath, '');
}
```

- `createRecord` initializes `folder: ''`.
- `scanSkills` calls `scanCentralStore` per central root instead of `scanRoot` for them.
- `mergeCentralRecords` keys central records by `record.dirPath` (realpath) and builds
  `central.links[link.scope][link.source] = link.linkPath` (initialize nested objects on demand).

Fix compile fallout: `effectiveness.ts` reads `record.central.links.user || {}` (Task 2 rewrites the rest);
`dashboardController.handleCentralToggle` resolves root by `(source, scope-param)` — keep old signature
compiling by treating `links.user` until Task 4 rewires; `syncService` iterates `Object.values(candidate.central.links).flatMap(Object.values)`.

- [ ] **Step 4: Run checks to verify they pass**

Run: `npx tsc -p ./ && node scripts/run-skill-management-checks.js`
Expected: `Skill management checks passed.`

- [ ] **Step 5: Commit**

```bash
git add src/skills/types.ts src/skills/discovery.ts src/skills/effectiveness.ts src/skills/centralService.ts src/skills/migrateService.ts src/skills/syncService.ts src/skills/dashboardController.ts scripts/run-skill-management-checks.js
git commit -m "refactor: scan central store recursively into folder-aware records with scope-nested links"
```

---

### Task 2: effectiveness — per-scope central evaluation + projectVisibility

**Files:**
- Modify: `src/skills/effectiveness.ts`
- Test: `scripts/run-skill-management-checks.js` (extend `runSkillCentralChecks` + new project-scope cases in `runSkillFolderDiscoveryChecks`)

**Interfaces:**
- Consumes: `SkillLinkMap` from Task 1.
- Produces: central records carry `projectVisibility`/`projectShadowedBy` when they have project links; rules:
  - user scope (existing behavior, now reading `links.user`): `agents` link → kimi active; link under brand winner → kimi active; any brand link outside winner → kimi shadowed; each linked agent → active.
  - project scope (`links.project`): same rules against the *project* brand winner, EXCEPT inheritance: an agent already `active` from `links.user` stays active regardless.

- [ ] **Step 1: Write the failing checks**

Append to `runSkillFolderDiscoveryChecks`:

```js
    // effectiveness: project links inherit user links; project brand winner shadows
    fs.mkdirSync(path.join(ws, '.kimi/skills'), { recursive: true });
    fs.symlinkSync(path.join(home, '.skills/solo'), path.join(ws, '.claude/skills/solo'), 'dir');
    // ^ requires <ws>/.claude/skills to exist first; create it via mkdir like the others
    const scoped = discovery.scanSkills({ homeDir: home, workspaceRoot: ws });
    const soloScoped = scoped.find(record => record.name === 'solo');
    assert.deepStrictEqual(soloScoped.visibility, { kimi: 'absent', claude: 'absent', codex: 'absent' },
        'no user links → user scope absent');
    assert.strictEqual(soloScoped.projectVisibility.claude, 'active');
    assert.strictEqual(soloScoped.projectVisibility.kimi, 'shadowed',
        'project link outside the project brand winner shadows kimi');
    assert.strictEqual(soloScoped.projectShadowedBy.kimi, path.join(ws, '.kimi', 'skills'));
    const alphaScoped = scoped.find(record => record.name === 'alpha');
    assert.strictEqual(alphaScoped.visibility.kimi, 'active', 'user link under user winner');
```

- [ ] **Step 2: Run checks to verify they fail**

Run: `npx tsc -p ./ && node scripts/run-skill-management-checks.js`
Expected: FAIL — `projectVisibility` undefined.

- [ ] **Step 3: Implement**

In `src/skills/effectiveness.ts` extract the central branch into:

```ts
function applyCentralScope(record: SkillRecord, links: Partial<Record<SkillSourceDir, string>>, brandWinnerDir: string | null,
    visibility: Record<SkillAgentId, SkillVisibility>, shadowedBy: Partial<Record<SkillAgentId, string>>): void {
    for (const agent of AGENTS) {
        visibility[agent] = 'absent';
        delete shadowedBy[agent];
    }
    if (links.agents) {
        visibility.kimi = 'active';
    } else if (brandWinnerDir && Object.values(links).some(link => link.startsWith(brandWinnerDir + path.sep))) {
        visibility.kimi = 'active';
    } else if (brandWinnerDir && (links.kimi || links.claude || links.codex)) {
        visibility.kimi = 'shadowed';
        shadowedBy.kimi = brandWinnerDir;
    }
    for (const agent of AGENTS) {
        if (agent !== 'kimi' && links[agent]) {
            visibility[agent] = 'active';
        }
    }
}
```

`applyScope` central branch calls `applyCentralScope(record, record.central.links.user || {}, brandWinnerDir, record.visibility, record.shadowedBy)`.
After both scopes run, `applySkillEffectiveness` does a third pass for central records with project links:

```ts
const projectWinnerDir = input.workspaceRoot
    ? (getKimiBrandCandidates(getProjectSkillsRoots(input.workspaceRoot)).find(root => dirExists(root.dirPath))?.dirPath || null)
    : null;
for (const record of cloned.filter(candidate => candidate.central && candidate.central.links.project)) {
    const projectVisibility = { kimi: 'absent', claude: 'absent', codex: 'absent' } as Record<SkillAgentId, SkillVisibility>;
    const projectShadowedBy: Partial<Record<SkillAgentId, string>> = {};
    applyCentralScope(record, record.central?.links.project || {}, projectWinnerDir, projectVisibility, projectShadowedBy);
    // inheritance: user-active stays active at project scope
    for (const agent of AGENTS) {
        if (record.visibility[agent] === 'active') {
            projectVisibility[agent] = 'active';
            delete projectShadowedBy[agent];
        }
    }
    record.projectVisibility = projectVisibility;
    record.projectShadowedBy = projectShadowedBy;
}
```

Note: the project pass applies to central records of EITHER scope (a user-store skill can be project-linked;
a project-store skill's `visibility` already equals its project evaluation, so skip records whose `scope === 'project'`).

- [ ] **Step 4: Run checks to verify they pass**

Run: `npx tsc -p ./ && node scripts/run-skill-management-checks.js`
Expected: `Skill management checks passed.`

- [ ] **Step 5: Commit**

```bash
git add src/skills/effectiveness.ts scripts/run-skill-management-checks.js
git commit -m "feat: evaluate central skill effectiveness per scope with project inheritance"
```

---

### Task 3: centralService — folder batch links + move-to-folder

**Files:**
- Modify: `src/skills/centralService.ts`
- Test: `scripts/run-skill-management-checks.js` (new `runSkillFolderServiceChecks`, registered next to the other central checks)

**Interfaces:**
- Consumes: `SkillRecord`, `SkillScope`, `setCentralLink`, `getCentralSkillsRoot`, agent roots.
- Produces: `setFolderLinks`, `moveSkillToFolder`, `FolderLinkResult` exactly as in "Core Interfaces".

- [ ] **Step 1: Write the failing checks**

```js
function runSkillFolderServiceChecks() {
    const centralService = require('../out/skills/centralService');
    const real = dirPath => fs.realpathSync(dirPath);
    const home = real(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-fsvc-')));
    const ws = real(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-fsvc-ws-')));
    const write = (filePath, content) => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
    };
    write(path.join(home, '.skills/superpowers/alpha/SKILL.md'), '---\nname: alpha\ndescription: A\n---\n');
    write(path.join(home, '.skills/superpowers/nested/beta/SKILL.md'), '---\nname: beta\ndescription: B\n---\n');
    write(path.join(home, '.skills/other/gamma/SKILL.md'), '---\nname: gamma\ndescription: G\n---\n');

    // batch enable at user scope links every skill under the folder (recursive) for all 3 agents
    const storeRoot = path.join(home, '.skills');
    const enabled = centralService.setFolderLinks(storeRoot, 'superpowers', 'user', home, ws, true);
    assert.strictEqual(enabled.ok, true);
    assert.strictEqual(enabled.changed, 6, 'two skills × three agents');
    assert.strictEqual(enabled.errors.length, 0);
    assert.ok(fs.lstatSync(path.join(home, '.kimi/skills/alpha')).isSymbolicLink());
    assert.ok(fs.lstatSync(path.join(home, '.claude/skills/beta')).isSymbolicLink());
    assert.ok(!fs.existsSync(path.join(home, '.kimi/skills/gamma')), 'other folders untouched');
    const again = centralService.setFolderLinks(storeRoot, 'superpowers', 'user', home, ws, true);
    assert.strictEqual(again.changed, 0, 'idempotent');

    // batch disable at project scope is a no-op when nothing is linked there
    const disabledProject = centralService.setFolderLinks(storeRoot, 'superpowers', 'project', home, ws, false);
    assert.strictEqual(disabledProject.changed, 0);
    // batch disable at user scope removes every link created above
    const disabled = centralService.setFolderLinks(storeRoot, 'superpowers', 'user', home, ws, false);
    assert.strictEqual(disabled.changed, 6);
    assert.ok(!fs.existsSync(path.join(home, '.kimi/skills/alpha')));

    // batch collects errors instead of stopping: block one link with a real dir
    fs.mkdirSync(path.join(home, '.kimi/skills/alpha'), { recursive: true });
    const partial = centralService.setFolderLinks(storeRoot, 'superpowers', 'user', home, ws, true);
    assert.strictEqual(partial.ok, false);
    assert.strictEqual(partial.errors.length, 1);
    assert.strictEqual(partial.errors[0].name, 'alpha');
    assert.strictEqual(partial.changed, 5, 'remaining links still created');
    fs.rmSync(path.join(home, '.kimi/skills/alpha'), { recursive: true });

    // moveSkillToFolder: moves the dir, re-creates links at both scopes
    centralService.setCentralLink(path.join(home, '.skills/other/gamma'), path.join(home, '.kimi/skills'), true);
    centralService.setCentralLink(path.join(home, '.skills/other/gamma'), path.join(ws, '.codex/skills'), true);
    const gamma = discovery.scanSkills({ homeDir: home, workspaceRoot: ws })
        .find(record => record.name === 'gamma');
    const moved = centralService.moveSkillToFolder(gamma, 'xiaohongshu/yunxiao', home, ws);
    assert.strictEqual(moved.ok, true);
    assert.strictEqual(moved.dirPath, path.join(home, '.skills', 'xiaohongshu', 'yunxiao', 'gamma'));
    assert.ok(fs.existsSync(path.join(moved.dirPath, 'SKILL.md')));
    assert.strictEqual(fs.realpathSync(path.join(home, '.kimi/skills/gamma')), moved.dirPath, 'user link re-pointed');
    assert.strictEqual(fs.realpathSync(path.join(ws, '.codex/skills/gamma')), moved.dirPath, 'project link re-pointed');
    const movedRecord = discovery.scanSkills({ homeDir: home, workspaceRoot: ws })
        .find(record => record.name === 'gamma');
    assert.strictEqual(movedRecord.folder, 'xiaohongshu/yunxiao');

    // refuses: existing destination, '..', absolute folder
    assert.strictEqual(centralService.moveSkillToFolder(movedRecord, '../escape', home, ws).ok, false);
    assert.strictEqual(centralService.moveSkillToFolder(movedRecord, '/abs', home, ws).ok, false);
    const alpha2 = discovery.scanSkills({ homeDir: home, workspaceRoot: ws })
        .find(record => record.name === 'alpha');
    const dup = centralService.moveSkillToFolder(alpha2, 'xiaohongshu/yunxiao', home, ws);
    assert.strictEqual(dup.ok, false, 'existing destination refused');
    assert.ok(fs.existsSync(path.join(home, '.skills', 'superpowers', 'alpha', 'SKILL.md')), 'source untouched');
}
```

- [ ] **Step 2: Run checks to verify they fail**

Run: `npx tsc -p ./ && node scripts/run-skill-management-checks.js`
Expected: FAIL — `setFolderLinks is not a function`.

- [ ] **Step 3: Implement**

Add to `src/skills/centralService.ts`:

```ts
function walkSkillDirs(dirPath: string, found: string[]): string[] {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (_error) {
        return found;
    }
    for (const entry of entries) {
        if (entry.name.startsWith('.')) {
            continue;
        }
        const fullPath = path.join(dirPath, entry.name);
        let realPath = fullPath;
        let isDirectory = entry.isDirectory();
        if (entry.isSymbolicLink()) {
            try {
                realPath = fs.realpathSync(fullPath);
                isDirectory = fs.statSync(realPath).isDirectory();
            } catch (_error) {
                continue;
            }
        }
        if (!isDirectory) {
            continue;
        }
        if (fs.existsSync(path.join(realPath, 'SKILL.md')) || fs.existsSync(path.join(realPath, 'skill.md'))) {
            if (!found.includes(realPath)) {
                found.push(realPath);
            }
        } else {
            walkSkillDirs(realPath, found);
        }
    }
    return found;
}

export function setFolderLinks(
    storeRoot: string, folder: string, scope: SkillScope,
    homeDir: string, workspaceRoot: string | undefined, enable: boolean,
): FolderLinkResult {
    const result: FolderLinkResult = { ok: true, changed: 0, errors: [] };
    const roots = scope === 'user' ? getUserSkillsRoots(homeDir) : getProjectSkillsRoots(workspaceRoot as string);
    const agentRoots = roots.filter(root => root.source === 'kimi' || root.source === 'claude' || root.source === 'codex');
    for (const skillDir of walkSkillDirs(path.join(storeRoot, folder), [])) {
        for (const root of agentRoots) {
            const link = setCentralLink(skillDir, root.dirPath, enable);
            if (link.ok) {
                result.changed += 1;
            } else {
                result.ok = false;
                result.errors.push({ name: path.basename(skillDir), error: link.error || 'unknown error' });
            }
        }
    }
    return result;
}
```

`changed` must count only actual create/remove transitions — adjust `setCentralLink` to return
`CentralResult & { changed?: boolean }` (`true` when it created/removed a link, `false` on no-op), and sum those.

```ts
function sanitizeFolder(targetFolder: string): string | null {
    const trimmed = targetFolder.trim().replace(/\/+$/u, '').replace(/^\/+/u, '');
    if (!trimmed) {
        return '';
    }
    const segments = trimmed.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..' || segment.includes('\\'))) {
        return null;
    }
    return segments.join('/');
}

export function moveSkillToFolder(
    record: SkillRecord, targetFolder: string, homeDir: string, workspaceRoot?: string,
): CentralResult {
    try {
        if (!record.central) {
            return { ok: false, error: 'Only centralized skills can be moved between folders.' };
        }
        const folder = sanitizeFolder(targetFolder);
        if (folder === null) {
            return { ok: false, error: `Invalid folder: ${targetFolder}` };
        }
        const storeRoot = getCentralSkillsRoot(homeDir, record.scope, workspaceRoot);
        const destination = folder ? path.join(storeRoot, folder, record.name) : path.join(storeRoot, record.name);
        if (destination === record.dirPath) {
            return { ok: true, dirPath: destination };
        }
        if (fs.existsSync(destination)) {
            return { ok: false, error: `Already exists: ${destination}` };
        }
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.renameSync(record.dirPath, destination);
        // Re-point every existing link (both scopes) at the new location.
        for (const scopeLinks of Object.values(record.central.links)) {
            for (const linkPath of Object.values(scopeLinks || {})) {
                try {
                    if (fs.lstatSync(linkPath).isSymbolicLink()) {
                        fs.unlinkSync(linkPath);
                        fs.symlinkSync(destination, linkPath, 'dir');
                    }
                } catch (_error) {
                    // best effort; a rescan surfaces any stale link
                }
            }
        }
        return { ok: true, dirPath: destination };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
```

- [ ] **Step 4: Run checks to verify they pass**

Run: `npx tsc -p ./ && node scripts/run-skill-management-checks.js`
Expected: `Skill management checks passed.`

- [ ] **Step 5: Commit**

```bash
git add src/skills/centralService.ts scripts/run-skill-management-checks.js
git commit -m "feat: batch folder link toggling and move-to-folder with link re-pointing"
```

---

### Task 4: controller + dashboard wiring

**Files:**
- Modify: `src/skills/dashboardController.ts`
- Modify: `src/dashboard.ts` (message handlers)
- Test: `scripts/run-skill-management-checks.js` (extend controller assertions)

**Interfaces:**
- Consumes: Task 3 service functions; Task 1 link model.
- Produces: the exact controller methods and message surface from "Core Interfaces".

- [ ] **Step 1: Write the failing checks**

Extend the controller section of `runSkillFolderServiceChecks` (or a new `runSkillFolderControllerChecks`):

```js
    const controller = new SkillDashboardController({
        getHomeDir: () => home,
        getWorkspaceRoot: () => ws,
        postMessage: () => Promise.resolve(true),
        isVisible: () => true,
        logError: () => undefined,
    });
    controller.start();
    // per-agent toggle at project scope
    const alphaDir = path.join(home, '.skills', 'superpowers', 'alpha');
    assert.strictEqual(controller.handleCentralToggle(alphaDir, 'project', 'kimi', false).ok, true);
    assert.ok(fs.lstatSync(path.join(ws, '.kimi/skills/alpha')).isSymbolicLink());
    assert.strictEqual(
        controller.getRecords().find(record => record.name === 'alpha').central.links.project.kimi,
        path.join(ws, '.kimi', 'skills', 'alpha'));
    assert.strictEqual(controller.handleCentralToggle(alphaDir, 'project', 'kimi', true).ok, true);
    // folder toggle
    const folderResult = controller.handleFolderToggle(storeRoot, 'superpowers', 'user', true);
    assert.strictEqual(folderResult.ok, true);
    assert.ok(fs.lstatSync(path.join(home, '.claude/skills/beta')).isSymbolicLink());
    // move
    assert.strictEqual(controller.handleMoveToFolder(alphaDir, 'collections').ok, true);
    assert.strictEqual(
        controller.getRecords().find(record => record.name === 'alpha').folder, 'collections');
    assert.strictEqual(controller.handleMoveToFolder(alphaDir, 'collections').ok, false,
        'stale dirPath refused after the move');
    controller.dispose();
```

Update `runSkillCentralChecks` controller calls to the new signature
(`handleCentralToggle(dir, scope, agent, enabled)`).

- [ ] **Step 2: Run checks to verify they fail**

Run: `npx tsc -p ./ && node scripts/run-skill-management-checks.js`
Expected: FAIL — signature mismatch / missing methods.

- [ ] **Step 3: Implement**

`dashboardController.ts`:

```ts
handleCentralToggle(dirPath: string, scope: SkillScope, agent: SkillAgentId, enabled: boolean): { ok: boolean; error?: string } {
    const record = this.records.find(candidate => candidate.central && candidate.dirPath === dirPath);
    if (!record || !record.central) {
        return { ok: false, error: `Unknown centralized skill: ${dirPath}` };
    }
    const roots = scope === 'user'
        ? getUserSkillsRoots(this.options.getHomeDir())
        : getProjectSkillsRoots(this.options.getWorkspaceRoot() as string);
    const root = roots.find(candidate => candidate.source === agent && candidate.scope === scope);
    if (!root || (scope === 'project' && !this.options.getWorkspaceRoot())) {
        return { ok: false, error: `Unknown ${scope} skills root for ${agent}.` };
    }
    const result = setCentralLink(dirPath, root.dirPath, !enabled);
    if (!result.ok) {
        this.options.logError('Failed to toggle the skill link.', new Error(result.error || 'unknown error'));
    }
    this.refresh('central-toggle-skill');
    return result;
}

handleFolderToggle(storeRoot: string, folder: string, scope: SkillScope, enabled: boolean): FolderLinkResult {
    const result = setFolderLinks(storeRoot, folder, scope, this.options.getHomeDir(), this.options.getWorkspaceRoot(), !enabled);
    for (const error of result.errors) {
        this.options.logError(`Failed to toggle folder link for ${error.name}.`, new Error(error.error));
    }
    this.refresh('folder-toggle-skill-links');
    return result;
}

handleMoveToFolder(dirPath: string, folder: string): { ok: boolean; error?: string } {
    const record = this.records.find(candidate => candidate.central && candidate.dirPath === dirPath);
    if (!record) {
        return { ok: false, error: `Unknown centralized skill: ${dirPath}` };
    }
    const result = moveSkillToFolder(record, folder, this.options.getHomeDir(), this.options.getWorkspaceRoot());
    if (!result.ok) {
        this.options.logError('Failed to move the skill.', new Error(result.error || 'unknown error'));
    }
    this.refresh('move-skill-to-folder');
    return result;
}
```

Note the `!enabled` inversion matches the existing click protocol (message carries the CURRENT state).

`dashboard.ts` — replace the old `'central-toggle-skill'` handler and add the new ones:

```ts
'central-toggle-skill': e => {
    const result = skillDashboardController.handleCentralToggle(
        String(e.dirPath || ''),
        (e.scope === 'project' ? 'project' : 'user') as never,
        String(e.source || '') as never,
        e.enabled === true,
    );
    if (!result.ok) {
        void vscode.window.showWarningMessage(`Could not toggle the skill link: ${result.error}`);
    }
},
'folder-toggle-skill-links': e => {
    const result = skillDashboardController.handleFolderToggle(
        String(e.storeRoot || ''), String(e.folder || ''),
        (e.scope === 'project' ? 'project' : 'user') as never,
        e.enabled === true,
    );
    if (!result.ok) {
        void vscode.window.showWarningMessage(
            `Some folder links failed: ${result.errors.map(item => item.name).join(', ')}`);
    }
},
'move-skill-to-folder': e => {
    const result = skillDashboardController.handleMoveToFolder(String(e.dirPath || ''), String(e.folder || ''));
    if (!result.ok) {
        void vscode.window.showWarningMessage(`Could not move the skill: ${result.error}`);
    }
},
```

- [ ] **Step 4: Run checks to verify they pass**

Run: `npx tsc -p ./ && node scripts/run-skill-management-checks.js`
Expected: `Skill management checks passed.`

- [ ] **Step 5: Commit**

```bash
git add src/skills/dashboardController.ts src/dashboard.ts scripts/run-skill-management-checks.js
git commit -m "feat: scope-aware skill link endpoints and folder batch toggling in the dashboard"
```

---

### Task 5: webview rendering — folder tree, scoped switches, selector, unmanaged

**Files:**
- Modify: `src/webview/webviewSkillContent.ts` (major rewrite of `getSkillsPanelContent` + `getSkillDetail` + `getSkillDiv`)
- Modify: `media/styles.scss` (folder node, segmented control, indeterminate switch, P badge, conflict chip)
- Test: `scripts/run-skill-management-checks.js` (rewrite `runSkillRenderingChecks` + central rendering assertions)

**Interfaces:**
- Consumes: Task 1–2 record model; Task 4 message surface.
- Produces: the markup contracts in "Core Interfaces" plus:
  - `SkillPanelView = { scope?: SkillScope (selected, default 'user'), duplicates?, copyTargets?, conflicts?: Set<string> (dirPaths with a name+agent link collision) }` — groups/suggestions fields are deleted.
  - Folder node: `<div class="skill-folder" data-skill-folder="<relpath>" data-skill-store="<storeRoot>" data-skill-folder-scope="user|project">` with header `<span data-action="collapse">`, count badge, and `<button data-folder-toggle data-folder-scope class="skill-ios-toggle|off|indeterminate">`.
  - Unmanaged section: `<div class="skill-unmanaged">` wrapping the existing source-group rendering (kept verbatim, including Centralize buttons).
  - Card detail for central records: three rows `kimi|claude|codex`, each `<div class="skill-agent-row"><span class="skill-agent-row-name">` + `<button class="skill-ios-toggle[ off]" data-central-toggle data-central-source data-link-user data-link-project>`.
  - Card detail move editor: `<input data-skill-move-folder="<dirPath>" placeholder="Move to folder…">` + `<button data-skill-move-set="<dirPath>">Move</button>`.
  - P badge on cards with project links: `<span class="skill-chip project-linked" title="Enabled in this project">P</span>`.
  - Conflict chip when two central records share a name and both link the same agent+scope: `<span class="skill-chip warn" data-skill-warn>⚠ name conflict</span>`.

- [ ] **Step 1: Write the failing checks**

Rewrite `runSkillRenderingChecks` central/tree portion (keep the non-central assertions that still apply):

```js
    const tree = skillContent.getSkillsPanelContent([
        makeRecord({ name: 'alpha', source: 'central', dirPath: '/home/dev/.skills/superpowers/alpha',
            skillFilePath: '/home/dev/.skills/superpowers/alpha/SKILL.md', folder: 'superpowers',
            central: { dirPath: '/home/dev/.skills/superpowers/alpha', links: { user: { kimi: '/home/dev/.kimi/skills/alpha' }, project: { codex: '/work/app/.codex/skills/alpha' } } },
            projectVisibility: { kimi: 'active', claude: 'absent', codex: 'active' } }),
        makeRecord({ name: 'beta', source: 'central', dirPath: '/home/dev/.skills/superpowers/nested/beta',
            skillFilePath: '/home/dev/.skills/superpowers/nested/beta/SKILL.md', folder: 'superpowers/nested',
            central: { dirPath: '/home/dev/.skills/superpowers/nested/beta', links: {} } }),
        makeRecord({ name: 'gamma', source: 'central', dirPath: '/home/dev/.skills/other/gamma',
            skillFilePath: '/home/dev/.skills/other/gamma/SKILL.md', folder: 'other',
            central: { dirPath: '/home/dev/.skills/other/gamma', links: {} } }),
        makeRecord(), // unmanaged kimi record, folder ''
    ], { scope: 'user' });
    // nested folder nodes with paths + store root + batch switches
    assert.ok(tree.includes('data-skill-folder="superpowers"'));
    assert.ok(tree.includes('data-skill-folder="superpowers/nested"'));
    assert.ok(tree.includes('data-skill-folder="other"'));
    assert.ok(tree.includes('data-skill-store="/home/dev/.skills"'));
    assert.ok(tree.indexOf('data-skill-folder="superpowers"') < tree.indexOf('data-skill-folder="superpowers/nested"'),
        'parent folders render before children');
    // batch switch states: superpowers partial → indeterminate; other empty → off
    const superpowersHeader = tree.split('data-skill-folder="superpowers"')[0];
    assert.ok(/skill-ios-toggle indeterminate/.test(superpowersHeader), 'partial folder is indeterminate');
    // scope selector in the filter row
    assert.ok(tree.includes('data-skill-scope-select="user"'));
    assert.ok(tree.includes('data-skill-scope-select="project"'));
    // switches carry both scopes' link state for client-side toggling
    assert.ok(tree.includes('data-link-user="/home/dev/.kimi/skills/alpha"'));
    assert.ok(tree.includes('data-link-project="/work/app/.codex/skills/alpha"'));
    // P badge for project-linked card
    assert.ok(tree.includes('skill-chip project-linked'));
    // unmanaged section holds the plain record
    assert.ok(tree.includes('skill-unmanaged'));
    // move editor present, old group editor gone
    assert.ok(tree.includes('data-skill-move-folder='));
    assert.ok(!tree.includes('data-skill-group-input'), 'virtual group editor removed');
    assert.ok(!tree.includes('data-skill-collection='), 'virtual collections removed');
```

- [ ] **Step 2: Run checks to verify they fail**

Run: `npx tsc -p ./ && node scripts/run-skill-management-checks.js`
Expected: FAIL — new markup absent.

- [ ] **Step 3: Implement**

Rewrite `getSkillsPanelContent` around two helpers:

```ts
interface SkillFolderNode {
    path: string;           // '' for the store root pseudo-node
    name: string;
    children: Map<string, SkillFolderNode>;
    items: SkillRecord[];   // records whose folder === node.path
}

function buildFolderTree(records: SkillRecord[]): SkillFolderNode {
    const root: SkillFolderNode = { path: '', name: '', children: new Map(), items: [] };
    for (const record of records.filter(candidate => candidate.central)) {
        const segments = record.folder ? record.folder.split('/') : [];
        let node = root;
        let current = '';
        for (const segment of segments) {
            current = current ? `${current}/${segment}` : segment;
            let child = node.children.get(segment);
            if (!child) {
                child = { path: current, name: segment, children: new Map(), items: [] };
                node.children.set(segment, child);
            }
            node = child;
        }
        node.items.push(record);
    }
    return root;
}
```

- `renderFolderNode(node, storeRoot, scope, view)` emits the folder header (collapse caret via
  `data-action="collapse"`, folder icon, name, recursive member count, batch switch whose state comes from
  `folderLinkState(node, scope)` → `'on' | 'off' | 'indeterminate'`) then children folders (sorted by name)
  then item cards (sorted by name).
- `folderLinkState` walks the subtree: a member counts as linked at `scope` when
  `record.central.links[scope]` has all three of kimi/claude/codex; all members linked → on; none → off; else indeterminate.
- Root-level central records (`folder === ''`) render directly under the scope section, before the Unmanaged section.
- Scope section titles stay `global` / `project`; `data-skill-folder-scope` is the section scope.
- `getSkillDiv` keeps the current card markup; changes:
  - chips row gains the P badge when `record.central?.links.project` has any entry;
  - chips render from `record.visibility` when `view.scope !== 'project'`, else `record.projectVisibility || record.visibility`;
  - the centralize button only shows for unmanaged records (unchanged); the master `.skill-toggle` stays hidden for central records (unchanged);
  - conflict chip when `view.conflicts?.has(record.dirPath)` (controller computes name+scope+agent collisions).
- `getSkillDetail` central branch renders three `skill-agent-row` rows per the markup contract, the move
  editor, and drops the old group editor; non-central records keep the existing status rows.
- Filter row gains `<button data-skill-scope-select="user" class="is-active">Global</button><button data-skill-scope-select="project">This project</button>` (hidden entirely when no workspace is open).
- Styles in `media/styles.scss`: `.skill-folder` (reuse `.group` visuals), `.skill-scope-select` segmented
  control (reuse `.skills-filter` pill visuals with `.is-active`), `.skill-ios-toggle.indeterminate`
  (green track, knob centered: `right: 9px;` on a 34px track), `.skill-chip.project-linked` (teal like
  `.skill-chip.central`), then `npx gulp buildStyles copyWebviewAssets`.

- [ ] **Step 4: Run checks to verify they pass**

Run: `npx tsc -p ./ && npx gulp buildStyles copyWebviewAssets && node scripts/run-skill-management-checks.js && node scripts/run-dashboard-webview-checks.js`
Expected: both suites pass.

- [ ] **Step 5: Commit**

```bash
git add src/webview/webviewSkillContent.ts media/styles.scss media/styles.css scripts/run-skill-management-checks.js
git commit -m "feat: render skills as an on-disk folder tree with scoped switches"
```

---

### Task 6: webview JS — selector, batch toggles, move, drag-and-drop, collapse

**Files:**
- Modify: `src/webview/webviewDashboardScripts.js` (media copy regenerates via gulp)
- Test: `scripts/run-skill-management-checks.js` (wiring assertions) + `tests/browser/**/*.test.js` (Task 8)

**Interfaces:**
- Consumes: Task 5 markup contracts; Task 4 message surface.
- Produces: click/change/drop handlers posting `central-toggle-skill` (with `scope`), `folder-toggle-skill-links`, `move-skill-to-folder`; `skill-scope-select` client-side scope switching; folder-node collapse persistence via the existing capture/restore mechanism.

- [ ] **Step 1: Write the failing checks**

Extend the webview-script assertions in `runSkillMigrationChecks`-adjacent section:

```js
    assert.ok(script.includes('data-skill-scope-select'), 'scope selector wiring present');
    assert.ok(script.includes("'folder-toggle-skill-links'"), 'folder batch wiring present');
    assert.ok(script.includes("'move-skill-to-folder'"), 'move wiring present');
    assert.ok(script.includes('data-link-user'), 'switch state swaps per scope client-side');
    assert.ok(script.includes('data-skill-move-folder'), 'move editor wiring present');
```

- [ ] **Step 2: Run checks to verify they fail**

Run: `node scripts/run-skill-management-checks.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `initDashboard` click delegation (same block as the existing central handlers):

```js
var scopeSelect = event.target && event.target.closest ? event.target.closest('[data-skill-scope-select]') : null;
if (scopeSelect) {
    event.preventDefault();
    setSkillLinkScope(scopeSelect.getAttribute('data-skill-scope-select'));
    return;
}
var folderToggle = event.target && event.target.closest ? event.target.closest('[data-folder-toggle]') : null;
if (folderToggle) {
    event.preventDefault();
    event.stopPropagation();
    var folderNode = folderToggle.closest('[data-skill-store]');
    options.postMessage({
        type: 'folder-toggle-skill-links',
        storeRoot: folderNode ? folderNode.getAttribute('data-skill-store') : '',
        folder: folderToggle.getAttribute('data-folder-toggle'),
        scope: folderToggle.getAttribute('data-folder-scope'),
        enabled: !folderToggle.classList.contains('off') && !folderToggle.classList.contains('indeterminate'),
    });
    return;
}
var moveSet = event.target && event.target.closest ? event.target.closest('[data-skill-move-set]') : null;
if (moveSet) {
    event.preventDefault();
    event.stopPropagation();
    var moveInput = document.querySelector('[data-skill-move-folder="' + CSS.escape(moveSet.getAttribute('data-skill-move-set')) + '"]');
    options.postMessage({ type: 'move-skill-to-folder', dirPath: moveSet.getAttribute('data-skill-move-set'), folder: moveInput ? moveInput.value : '' });
    return;
}
```

- `data-folder-toggle` on the button carries the folder path; the store root comes from the enclosing `[data-skill-store]` folder node (Task 5 markup).
- `setSkillLinkScope(scope)`: persists to `localStorage('agentPivot.skillLinkScope')`, toggles
  `.is-active` on the selector buttons, and walks every `[data-central-toggle]` switch + `[data-vis-*]` chip:
  switches read `data-link-user|data-link-project` to set `.off`; chips read `data-vis-user|data-vis-project`
  to swap chip class/text; folder batch switches recompute from their subtree's switches. Restore on load.
- `central-toggle-skill` click now posts `scope: getSkillLinkScope()` and
  `enabled: !btn.classList.contains('off')` (unchanged semantics).
- Folder batch switch visual update: after any central toggle click, recompute affected folder headers.
  (Authoritative refresh will correct any drift; client update is best-effort.)
- Drag-and-drop: reuse the existing card drag (`onSkillDragStart` sets `dataTransfer` dirPath); folder nodes
  and scope-section roots get `dragover` highlight (`.skill-drop-target`) + `drop` →
  `postMessage({type:'move-skill-to-folder', dirPath, folder: nodeFolderPath})` (section root → `''`).
  Remove the old collection-drop handler.
- Collapse: extend `captureSkillCollapsedGroups`/`restoreSkillCollapsedGroups` to also capture
  `.skill-folder[data-skill-folder]` open/closed state keyed by `store + '|' + folder`.

- [ ] **Step 4: Run checks to verify they pass**

Run: `npx gulp copyWebviewAssets && node scripts/run-skill-management-checks.js && node scripts/run-dashboard-webview-checks.js`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/webview/webviewDashboardScripts.js media/webviewDashboardScripts.js scripts/run-skill-management-checks.js
git commit -m "feat: scope selector, folder batch toggles, and on-disk drag-and-drop in the skills panel"
```

---

### Task 7: retire virtual groups; collection suggestions become on-disk folders

**Files:**
- Modify: `src/skills/dashboardController.ts` (drop `SkillGroupStore` from the view; `handleApplyCollectionSuggestion` moves members)
- Modify: `src/skills/knownCollections.ts` (suggestions keyed on store folders instead of groups)
- Modify: `src/dashboard.ts` (drop group messages; keep `apply-skill-collection`/`dismiss-skill-collection`)
- Modify: `src/webview/webviewSkillContent.ts` (suggestion card copy: "Create folder and move skills in")
- Test: `scripts/run-skill-management-checks.js` (rewrite `runSkillCollectionChecks`, delete `runSkillGroupStoreChecks`)

**Interfaces:**
- Consumes: `moveSkillToFolder` (Task 3), `KNOWN_SKILL_COLLECTIONS`.
- Produces: `handleApplyCollectionSuggestion(name)` moves every present member record into folder `<name>` of its store (central members via `moveSkillToFolder`; unmanaged members are centralized first, then moved); suggestion hidden when a folder with that name already exists in the store or all members are already filed under it.

- [ ] **Step 1: Write the failing checks**

```js
    // suggestion applies as an on-disk folder move
    const applyResult = controller.handleApplyCollectionSuggestion('superpowers');
    assert.strictEqual(applyResult.ok, true);
    const filed = controller.getRecords().filter(record => record.folder === 'superpowers');
    assert.ok(filed.length >= 2, 'members moved into the store folder');
    assert.ok(fs.existsSync(path.join(home, '.skills', 'superpowers', 'brainstorming', 'SKILL.md')));
    // groupStore is no longer read by the panel
    const html = skillContent.getSkillsPanelContent(controller.getRecords(), {});
    assert.ok(!html.includes('data-skill-collection='));
```

- [ ] **Step 2: Run checks to verify they fail**

Run: `npx tsc -p ./ && node scripts/run-skill-management-checks.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `knownCollections.getCollectionSuggestions(records, dismissed)`: drop the `groups` parameter; compute
  from folders (`record.folder !== collection.name` counts as unfiled).
- Controller: delete `groupStore` from the view model and the group endpoints (`handleSetGroup`,
  `handleToggleSkillGroup`, ungroup); keep dismissals (globalState) for suggestions.
  `handleApplyCollectionSuggestion(name)` loops member records: central → `moveSkillToFolder(record, name)`;
  unmanaged enabled → `centralizeSkill(record, duplicates, …)` then move; skip parked records; collect errors.
- `dashboard.ts`: remove `'set-skill-group'`/`'toggle-skill-group'`/ungroup handlers; keep
  apply/dismiss handlers (signature unchanged).
- Rendering: suggestion card text becomes `Create the <name> folder and move N skills into it`.
- Delete `runSkillGroupStoreChecks` and group-fixture helpers now unused; keep the store file
  `src/skills/skillGroupStore.ts` on disk (unused by the panel; avoids touching unrelated state migrations).

- [ ] **Step 4: Run checks to verify they pass**

Run: `npx tsc -p ./ && node scripts/run-skill-management-checks.js && node scripts/run-dashboard-webview-checks.js`
Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src/skills/dashboardController.ts src/skills/knownCollections.ts src/dashboard.ts src/webview/webviewSkillContent.ts scripts/run-skill-management-checks.js
git commit -m "refactor: replace virtual skill groups with on-disk store folders"
```

---

### Task 8: browser tests for the new interactions

**Files:**
- Create: `tests/browser/skillsFolderTree.test.js` (follow the naming/patterns of existing `tests/browser/skills*.test.js`)
- Test: runs via `node --test --test-concurrency=1 'tests/browser/**/*.test.js'`

**Interfaces:**
- Consumes: the packaged webview HTML/JS from Tasks 5–6.

- [ ] **Step 1: Write the browser tests**

Cases (each mirrors an existing browser-test pattern: load panel HTML + media script into the Chromium harness, dispatch events, assert DOM/posts):
1. Scope selector toggles switch states from `data-link-user/project` without a host round-trip and persists across reload (localStorage).
2. Folder batch switch posts `folder-toggle-skill-links` with `{storeRoot, folder, scope, enabled}`; indeterminate click posts `enabled: false`→meaning "complete the set" (assert the exact `enabled` flag semantics from Task 6).
3. Dragging a card onto a folder node posts `move-skill-to-folder` with the folder path; dropping onto the section root posts `folder: ''`; dropping a project-scope card onto the global section is refused client-side (no post).
4. Folder collapse state survives an authoritative `skills-updated` HTML replacement.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test-compile && node --test --test-concurrency=1 'tests/browser/**/*.test.js'`
Expected: FAIL on the new cases.

- [ ] **Step 3: Fix implementation until green**

Iterate on `webviewDashboardScripts.js`/`webviewSkillContent.ts` until all browser tests pass.

- [ ] **Step 4: Run the full browser suite**

Run: `node --test --test-concurrency=1 'tests/browser/**/*.test.js'`
Expected: all pass (existing 89 + new).

- [ ] **Step 5: Commit**

```bash
git add tests/browser/skillsFolderTree.test.js src/webview/ media/
git commit -m "test: cover skill folder tree interactions in browser tests"
```

---

### Task 9: README, full verification, package & install

**Files:**
- Modify: `README.md` (skills paragraph: folder model + scoped enablement)

- [ ] **Step 1: Update README**

Rewrite the skills paragraph: folder tree in `~/.skills`/`<project>/.skills`, per-scope iOS switches,
folder batch switches, drag-and-drop filing, migration command, reversible parking.

- [ ] **Step 2: Full verification**

```bash
npm run test:deterministic
node --test --test-concurrency=1 'tests/browser/**/*.test.js'
node scripts/run-dashboard-webview-checks.js
node scripts/run-skill-management-checks.js
npm run test:behavior-contracts
```
Expected: all green.

- [ ] **Step 3: Package + install + byte verification**

```bash
npm run package:release
EP=/home/hzcheng/.vscode-server/bin/4fe60c8b1cdac1c4c174f2fb180d0d758272d713/bin/code-server
env -u VSCODE_IPC_HOOK_CLI $EP --extensions-dir /home/hzcheng/.vscode-server/extensions \
  --install-extension "$PWD/artifacts/agent-pivot-1.0.0.vsix" --force
# unzip the VSIX and sha256-compare dist/dashboard.js, media/webviewDashboardScripts.js, media/styles.css
```
Expected: `successfully installed` + `MATCH` on all three files.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: describe on-disk skill folders and scoped enablement"
```

---

## Self-Review Notes

- Spec coverage: storage model (Task 1), enable matrix (Tasks 2/4/5/6), panel structure (Task 5), interactions
  (Tasks 4/6/7), conflicts (Tasks 4/5 — refusal in `setCentralLink`, chip via controller `view.conflicts`),
  retirement of virtual groups (Task 7), testing (all tasks + Task 8), README (Task 9).
- The conflict computation in Task 5 references `view.conflicts` (a `Set<string>` of dirPaths) — the
  controller builds it in Task 4's refresh: group central records by `scope+name`, flag records sharing at
  least one linked agent at the same scope.
