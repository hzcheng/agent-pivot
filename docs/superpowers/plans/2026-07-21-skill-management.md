# Skill Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a SKILLS tab to the Project Steward dashboard that discovers agent skills across Kimi/Claude/Codex directories, shows per-agent effectiveness with diagnostics, and lets users enable/disable skills by moving directories.

**Architecture:** Pure-function core (`src/skills/`: frontmatter parsing, directory rules, discovery, effectiveness, toggle service) tested with tmp-dir fixtures, plus a thin dashboard controller (scan + watch + post) and webview rendering (tab + cards + detail panel) reusing the existing tab framework and card styles.

**Tech Stack:** TypeScript (tsc + webpack), VS Code webview API, Node `fs`/`fs.watch`, repo-style `node scripts/run-*-checks.js` assertion suites, SCSS → gulp.

**Spec:** `docs/superpowers/specs/2026-07-21-skill-management-design.md`

## Global Constraints

- No commits unless the user explicitly asks; every task ends with checks run, not a commit.
- `SKILL.md` filename discovery is case-sensitive (lowercase `skill.md` = diagnostic, not a skill).
- Disabled skills live in a sibling `.disabled/` directory which is never scanned as skills.
- Kimi brand-directory priority (v1.49.0 behavior): user scope = first existing of `~/.kimi/skills`, `~/.claude/skills`, `~/.codex/skills`; project scope = first existing of `.kimi/skills`, `.claude/skills`, `.codex/skills`. Generic group (`~/.config/agents/skills`, `~/.agents/skills`, `.agents/skills`) merges independently.
- Claude: `~/.claude/skills` + `.claude/skills`. Codex: `~/.codex/skills` + `.codex/skills`.
- Frontmatter limits (agentskills.io): `name` ≤64 chars, `description` ≤1024 chars, body ≤500 lines (warning).
- New CSS must not use `color-mix(` (repo rule enforced by run-ai-session-safety-checks).
- All file writes go through narrow try/catch + diagnostics; the dashboard must never fail activation because of skill scanning.
- Test style: plain `assert` in `scripts/run-skill-management-checks.js`, `vscode` module stubbed like `run-open-project-safety-checks.js`.

## File Structure

- Create: `src/skills/types.ts` — shared types
- Create: `src/skills/frontmatter.ts` — SKILL.md frontmatter parse + health diagnostics
- Create: `src/skills/roots.ts` — agent directory rule tables (user/project, brand/generic)
- Create: `src/skills/discovery.ts` — scan roots → unified `SkillRecord[]` incl. effectiveness
- Create: `src/skills/toggleService.ts` — enable/disable by moving directories
- Create: `src/skills/dashboardController.ts` — scan/watch/post orchestration
- Create: `src/webview/webviewSkillContent.ts` — SKILLS panel HTML
- Modify: `src/webview/webviewContent.ts` — register 4th tab + panel section
- Modify: `src/webview/webviewDashboardScripts.js` + `media/webviewDashboardScripts.js` — panels.skills, normalizeDashboardTab, card interactions, `skills-updated` message
- Modify: `media/styles.scss` + regenerate `media/styles.css`
- Modify: `src/dashboard.ts` — controller wiring, stewardInfos.skills, message handlers
- Modify: `src/dashboard/messageRouter.ts` — nothing (generic handler map already covers new types) — no change expected
- Create: `scripts/run-skill-management-checks.js`
- Modify: `package.json` — `test:skills` script, append to `test:safety`
- Modify: `README.md` — SKILLS tab section

---

### Task 1: Types + frontmatter parsing and diagnostics

**Files:**
- Create: `src/skills/types.ts`
- Create: `src/skills/frontmatter.ts`
- Test: `scripts/run-skill-management-checks.js` (start the file)

**Interfaces:**
- Produces (all later tasks rely on these exact shapes):

```ts
// src/skills/types.ts
export type SkillAgentId = 'kimi' | 'claude' | 'codex';
export type SkillScope = 'user' | 'project';
export type SkillVisibility = 'active' | 'shadowed' | 'absent';
export type SkillSourceDir = 'kimi' | 'claude' | 'codex' | 'agents';

export interface SkillDiagnostic {
    code: 'missing-frontmatter' | 'missing-name' | 'missing-description'
        | 'name-mismatch' | 'name-too-long' | 'description-too-long'
        | 'body-too-long' | 'lowercase-filename' | 'unreadable';
    message: string;
}

export interface SkillRecord {
    name: string;            // directory name
    description: string;     // '' when missing
    dirPath: string;         // absolute path of the skill directory
    skillFilePath: string;   // absolute path of SKILL.md
    scope: SkillScope;
    source: SkillSourceDir;  // which directory brand this copy lives in
    enabled: boolean;        // false when parked under .disabled/
    visibility: Record<SkillAgentId, SkillVisibility>;
    shadowedBy: Partial<Record<SkillAgentId, string>>; // winning dirPath per agent
    diagnostics: SkillDiagnostic[];
}

// src/skills/frontmatter.ts
export interface SkillFrontmatter { name?: string; description?: string; }
export function parseSkillFrontmatter(content: string): SkillFrontmatter | null;
export function getSkillDiagnostics(input: {
    dirName: string;
    fileName: string;        // actual discovered file name, e.g. 'SKILL.md' or 'skill.md'
    frontmatter: SkillFrontmatter | null;
    bodyLineCount: number;
}): import('./types').SkillDiagnostic[];
```

- [ ] **Step 1: Write the failing test**

Create `scripts/run-skill-management-checks.js`:

```js
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const frontmatter = require('../out/skills/frontmatter');

function runFrontmatterChecks() {
    assert.deepStrictEqual(
        frontmatter.parseSkillFrontmatter('---\nname: demo\ndescription: Does things\n---\n\n# Body\n'),
        { name: 'demo', description: 'Does things' }
    );
    assert.strictEqual(frontmatter.parseSkillFrontmatter('# No frontmatter\n'), null);
    assert.strictEqual(frontmatter.parseSkillFrontmatter('---\nname: demo\n'), null, 'unclosed block is not frontmatter');
    assert.deepStrictEqual(
        frontmatter.parseSkillFrontmatter('---\ndescription: "quoted: value"\n---\nx\n'),
        { description: 'quoted: value' }
    );

    const d = frontmatter.getSkillDiagnostics;
    assert.deepStrictEqual(d({ dirName: 'demo', fileName: 'SKILL.md', frontmatter: { name: 'demo', description: 'x' }, bodyLineCount: 10 }), []);
    const codes = list => list.map(item => item.code).sort();
    assert.deepStrictEqual(
        codes(d({ dirName: 'demo', fileName: 'skill.md', frontmatter: null, bodyLineCount: 0 })),
        ['lowercase-filename', 'missing-frontmatter'].sort()
    );
    assert.deepStrictEqual(
        codes(d({ dirName: 'demo', fileName: 'SKILL.md', frontmatter: { name: 'other', description: 'x'.repeat(1100) }, bodyLineCount: 600 })),
        ['name-mismatch', 'description-too-long', 'body-too-long'].sort()
    );
    assert.deepStrictEqual(
        codes(d({ dirName: 'demo', fileName: 'SKILL.md', frontmatter: { description: 'x' }, bodyLineCount: 1 })),
        ['missing-name']
    );
}

runFrontmatterChecks();
console.log('Skill management checks passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test-compile && node scripts/run-skill-management-checks.js`
Expected: FAIL — `Cannot find module '../out/skills/frontmatter'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/skills/types.ts
'use strict';

export type SkillAgentId = 'kimi' | 'claude' | 'codex';
export type SkillScope = 'user' | 'project';
export type SkillVisibility = 'active' | 'shadowed' | 'absent';
export type SkillSourceDir = 'kimi' | 'claude' | 'codex' | 'agents';

export interface SkillDiagnostic {
    code: 'missing-frontmatter' | 'missing-name' | 'missing-description'
        | 'name-mismatch' | 'name-too-long' | 'description-too-long'
        | 'body-too-long' | 'lowercase-filename' | 'unreadable';
    message: string;
}

export interface SkillRecord {
    name: string;
    description: string;
    dirPath: string;
    skillFilePath: string;
    scope: SkillScope;
    source: SkillSourceDir;
    enabled: boolean;
    visibility: Record<SkillAgentId, SkillVisibility>;
    shadowedBy: Partial<Record<SkillAgentId, string>>;
    diagnostics: SkillDiagnostic[];
}
```

```ts
// src/skills/frontmatter.ts
'use strict';

import type { SkillDiagnostic } from './types';

export interface SkillFrontmatter {
    name?: string;
    description?: string;
}

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_BODY_LINES = 500;

export function parseSkillFrontmatter(content: string): SkillFrontmatter | null {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content || '');
    if (!match) {
        return null;
    }
    const result: SkillFrontmatter = {};
    for (const line of match[1].split(/\r?\n/)) {
        const field = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
        if (!field) {
            continue;
        }
        const value = field[2].trim().replace(/^["']|["']$/g, '');
        if (field[1] === 'name') {
            result.name = value;
        } else if (field[1] === 'description') {
            result.description = value;
        }
    }
    return result;
}

export function getSkillDiagnostics(input: {
    dirName: string;
    fileName: string;
    frontmatter: SkillFrontmatter | null;
    bodyLineCount: number;
}): SkillDiagnostic[] {
    const diagnostics: SkillDiagnostic[] = [];
    if (input.fileName !== 'SKILL.md') {
        diagnostics.push({
            code: 'lowercase-filename',
            message: `Skill file must be named SKILL.md (found ${input.fileName}); discovery is case-sensitive.`,
        });
    }
    if (!input.frontmatter) {
        diagnostics.push({ code: 'missing-frontmatter', message: 'SKILL.md has no YAML frontmatter block.' });
        return diagnostics;
    }
    const { name, description } = input.frontmatter;
    if (!name) {
        diagnostics.push({ code: 'missing-name', message: 'Frontmatter is missing the name field.' });
    } else {
        if (name !== input.dirName) {
            diagnostics.push({ code: 'name-mismatch', message: `Frontmatter name "${name}" does not match directory "${input.dirName}".` });
        }
        if (name.length > MAX_NAME_LENGTH) {
            diagnostics.push({ code: 'name-too-long', message: `Frontmatter name exceeds ${MAX_NAME_LENGTH} characters.` });
        }
    }
    if (!description) {
        diagnostics.push({ code: 'missing-description', message: 'Frontmatter is missing the description field.' });
    } else if (description.length > MAX_DESCRIPTION_LENGTH) {
        diagnostics.push({ code: 'description-too-long', message: `Description exceeds ${MAX_DESCRIPTION_LENGTH} characters.` });
    }
    if (input.bodyLineCount > MAX_BODY_LINES) {
        diagnostics.push({ code: 'body-too-long', message: `SKILL.md body exceeds ${MAX_BODY_LINES} lines; move detail into references/.` });
    }
    return diagnostics;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test-compile && node scripts/run-skill-management-checks.js`
Expected: `Skill management checks passed.`

---

### Task 2: Agent directory rule tables (roots)

**Files:**
- Create: `src/skills/roots.ts`
- Test: extend `scripts/run-skill-management-checks.js`

**Interfaces:**
- Consumes: nothing
- Produces:

```ts
// src/skills/roots.ts
export interface SkillsRoot {
    source: import('./types').SkillSourceDir; // 'kimi' | 'claude' | 'codex' | 'agents'
    scope: import('./types').SkillScope;      // 'user' | 'project'
    dirPath: string;
}
export const DISABLED_DIR_NAME = '.disabled';
export function getUserSkillsRoots(homeDir: string): SkillsRoot[];
export function getProjectSkillsRoots(workspaceRoot: string): SkillsRoot[];
export function getKimiBrandCandidates(roots: SkillsRoot[]): SkillsRoot[]; // roots with source !== 'agents', ordered kimi > claude > codex
```

- [ ] **Step 1: Write the failing test** (append to the check script, call from main)

```js
const roots = require('../out/skills/roots');

function runRootsChecks() {
    const userRoots = roots.getUserSkillsRoots('/home/dev');
    assert.deepStrictEqual(
        userRoots.map(root => `${root.source}:${root.dirPath}`),
        [
            'kimi:/home/dev/.kimi/skills',
            'claude:/home/dev/.claude/skills',
            'codex:/home/dev/.codex/skills',
            'agents:/home/dev/.config/agents/skills',
            'agents:/home/dev/.agents/skills',
        ]
    );
    assert.ok(userRoots.every(root => root.scope === 'user'));

    const projectRoots = roots.getProjectSkillsRoots('/work/app');
    assert.deepStrictEqual(
        projectRoots.map(root => `${root.source}:${root.dirPath}`),
        [
            'kimi:/work/app/.kimi/skills',
            'claude:/work/app/.claude/skills',
            'codex:/work/app/.codex/skills',
            'agents:/work/app/.agents/skills',
        ]
    );

    const brand = roots.getKimiBrandCandidates(userRoots);
    assert.deepStrictEqual(brand.map(root => root.source), ['kimi', 'claude', 'codex']);
    assert.strictEqual(roots.DISABLED_DIR_NAME, '.disabled');
}

// main: runFrontmatterChecks(); runRootsChecks(); console.log(...)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test-compile && node scripts/run-skill-management-checks.js`
Expected: FAIL — `Cannot find module '../out/skills/roots'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/skills/roots.ts
'use strict';

import * as path from 'path';

import type { SkillScope, SkillSourceDir } from './types';

export interface SkillsRoot {
    source: SkillSourceDir;
    scope: SkillScope;
    dirPath: string;
}

export const DISABLED_DIR_NAME = '.disabled';

export function getUserSkillsRoots(homeDir: string): SkillsRoot[] {
    return [
        { source: 'kimi', scope: 'user', dirPath: path.join(homeDir, '.kimi', 'skills') },
        { source: 'claude', scope: 'user', dirPath: path.join(homeDir, '.claude', 'skills') },
        { source: 'codex', scope: 'user', dirPath: path.join(homeDir, '.codex', 'skills') },
        { source: 'agents', scope: 'user', dirPath: path.join(homeDir, '.config', 'agents', 'skills') },
        { source: 'agents', scope: 'user', dirPath: path.join(homeDir, '.agents', 'skills') },
    ];
}

export function getProjectSkillsRoots(workspaceRoot: string): SkillsRoot[] {
    return [
        { source: 'kimi', scope: 'project', dirPath: path.join(workspaceRoot, '.kimi', 'skills') },
        { source: 'claude', scope: 'project', dirPath: path.join(workspaceRoot, '.claude', 'skills') },
        { source: 'codex', scope: 'project', dirPath: path.join(workspaceRoot, '.codex', 'skills') },
        { source: 'agents', scope: 'project', dirPath: path.join(workspaceRoot, '.agents', 'skills') },
    ];
}

export function getKimiBrandCandidates(roots: SkillsRoot[]): SkillsRoot[] {
    const order: SkillSourceDir[] = ['kimi', 'claude', 'codex'];
    return order
        .map(source => roots.find(root => root.source === source))
        .filter((root): root is SkillsRoot => Boolean(root));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test-compile && node scripts/run-skill-management-checks.js`
Expected: `Skill management checks passed.`

---

### Task 3: Discovery scanner (records without effectiveness)

**Files:**
- Create: `src/skills/discovery.ts`
- Test: extend `scripts/run-skill-management-checks.js` (tmp fixture dirs)

**Interfaces:**
- Consumes: `roots.ts`, `frontmatter.ts`, `types.ts`
- Produces:

```ts
// src/skills/discovery.ts
export function scanSkills(input: {
    homeDir: string;
    workspaceRoot?: string;
    readFile?: (filePath: string) => string;       // injectable for tests
    listDir?: (dirPath: string) => import('fs').Dirent[]; // injectable for tests
}): import('./types').SkillRecord[];
```

`scanSkills` walks every existing root (skipping `.disabled` as a root child marker: a child directory named `.disabled` is skipped), reads `SKILL.md` (or detects wrong-case `skill.md`), parses frontmatter, computes diagnostics, sets `enabled: true`, and leaves `visibility` all-`'absent'` + `shadowedBy: {}` (Task 4 fills them).

- [ ] **Step 1: Write the failing test**

```js
const discovery = require('../out/skills/discovery');

function makeFixture(t) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-home-'));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-ws-'));
    const write = (filePath, content) => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
    };
    write(path.join(home, '.kimi/skills/alpha/SKILL.md'), '---\nname: alpha\ndescription: Alpha skill\n---\n# A\n');
    write(path.join(home, '.claude/skills/beta/SKILL.md'), '---\nname: beta\ndescription: Beta skill\n---\n# B\n');
    write(path.join(home, '.kimi/skills/.hidden/SKILL.md'), '---\nname: hidden\ndescription: x\n---\n');
    write(path.join(home, '.kimi/skills/.disabled/parked/SKILL.md'), '---\nname: parked\ndescription: x\n---\n');
    write(path.join(ws, '.claude/skills/gamma/SKILL.md'), '---\nname: gamma\ndescription: Gamma\n---\n# G\n');
    write(path.join(ws, '.agents/skills/delta/skill.md'), '---\nname: delta\ndescription: Delta\n---\n');
    return { home, ws };
}

function runDiscoveryChecks() {
    const { home, ws } = makeFixture();
    const records = discovery.scanSkills({ homeDir: home, workspaceRoot: ws });
    const byName = new Map(records.map(record => [record.name, record]));

    assert.deepStrictEqual(records.map(record => record.name).sort(), ['alpha', 'beta', 'delta', 'gamma']);
    assert.strictEqual(byName.get('alpha').scope, 'user');
    assert.strictEqual(byName.get('alpha').source, 'kimi');
    assert.strictEqual(byName.get('alpha').enabled, true);
    assert.strictEqual(byName.get('alpha').description, 'Alpha skill');
    assert.deepStrictEqual(byName.get('alpha').diagnostics, []);
    assert.strictEqual(byName.get('gamma').scope, 'project');
    assert.strictEqual(byName.get('delta').source, 'agents');
    assert.deepStrictEqual(
        byName.get('delta').diagnostics.map(item => item.code),
        ['lowercase-filename']
    );
    assert.ok(!byName.has('parked'), '.disabled must never be scanned');
    assert.ok(!byName.has('hidden'), 'dot-directories must be skipped');
    assert.ok(!byName.has('.hidden'));
    assert.deepStrictEqual(byName.get('alpha').visibility, { kimi: 'absent', claude: 'absent', codex: 'absent' });
}

// main: runFrontmatterChecks(); runRootsChecks(); runDiscoveryChecks();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test-compile && node scripts/run-skill-management-checks.js`
Expected: FAIL — `Cannot find module '../out/skills/discovery'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/skills/discovery.ts
'use strict';

import * as fs from 'fs';
import * as path from 'path';

import { getSkillDiagnostics, parseSkillFrontmatter } from './frontmatter';
import { DISABLED_DIR_NAME, getProjectSkillsRoots, getUserSkillsRoots, SkillsRoot } from './roots';
import type { SkillDiagnostic, SkillRecord } from './types';

export interface ScanSkillsInput {
    homeDir: string;
    workspaceRoot?: string;
}

function readSkillFile(dirPath: string): { fileName: string; content: string } | null {
    for (const fileName of ['SKILL.md', 'skill.md']) {
        const filePath = path.join(dirPath, fileName);
        try {
            return { fileName, content: fs.readFileSync(filePath, 'utf8') };
        } catch (_error) {
            // try next candidate
        }
    }
    return null;
}

function scanRoot(root: SkillsRoot): SkillRecord[] {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(root.dirPath, { withFileTypes: true });
    } catch (_error) {
        return [];
    }
    const records: SkillRecord[] = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) {
            continue;
        }
        const dirPath = path.join(root.dirPath, entry.name);
        const skillFile = readSkillFile(dirPath);
        if (!skillFile) {
            continue;
        }
        const frontmatter = parseSkillFrontmatter(skillFile.content);
        const bodyLineCount = skillFile.content.split(/\r?\n/).length;
        records.push({
            name: entry.name,
            description: frontmatter?.description || '',
            dirPath,
            skillFilePath: path.join(dirPath, skillFile.fileName),
            scope: root.scope,
            source: root.source,
            enabled: true,
            visibility: { kimi: 'absent', claude: 'absent', codex: 'absent' },
            shadowedBy: {},
            diagnostics: getSkillDiagnostics({
                dirName: entry.name,
                fileName: skillFile.fileName,
                frontmatter,
                bodyLineCount,
            }),
        });
    }
    return records;
}

export function scanSkills(input: ScanSkillsInput): SkillRecord[] {
    const roots = getUserSkillsRoots(input.homeDir)
        .concat(input.workspaceRoot ? getProjectSkillsRoots(input.workspaceRoot) : []);
    return roots.flatMap(scanRoot);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test-compile && node scripts/run-skill-management-checks.js`
Expected: `Skill management checks passed.`

---

### Task 4: Effectiveness (per-agent visibility + shadowing)

**Files:**
- Create: `src/skills/effectiveness.ts`
- Modify: `src/skills/discovery.ts` (apply effectiveness at the end of `scanSkills`)
- Test: extend `scripts/run-skill-management-checks.js`

**Interfaces:**
- Consumes: `SkillRecord[]`, roots tables
- Produces:

```ts
// src/skills/effectiveness.ts
export function applySkillEffectiveness(
    records: import('./types').SkillRecord[],
    input: { homeDir: string; workspaceRoot?: string; dirExists?: (dirPath: string) => boolean }
): import('./types').SkillRecord[]; // new array; records cloned
```

Rules (per Global Constraints):
- For each scope separately (`user`, `project`):
  - **kimi**: brand winner = first **existing** candidate dir among kimi > claude > codex (that scope). Records in the winner dir → `active`; records in other brand dirs → `shadowed`, `shadowedBy.kimi = <winner dirPath>`. Records with `source === 'agents'` → `active` (generic group merges independently). If no brand dir exists → all brand records `absent`.
  - **claude**: records in claude dirs → `active`; others `absent`.
  - **codex**: records in codex dirs → `active`; others `absent`.
- `dirExists` defaults to `fs.existsSync`.

- [ ] **Step 1: Write the failing test**

```js
const effectiveness = require('../out/skills/effectiveness');

function runEffectivenessChecks() {
    const { home, ws } = makeFixture();
    const scanned = discovery.scanSkills({ homeDir: home, workspaceRoot: ws });
    const records = effectiveness.applySkillEffectiveness(scanned, { homeDir: home, workspaceRoot: ws });
    const byName = new Map(records.map(record => [record.name, record]));

    // ~/.kimi/skills exists → Kimi loads only that brand dir; ~/.claude copy is shadowed
    assert.strictEqual(byName.get('alpha').visibility.kimi, 'active');
    assert.strictEqual(byName.get('beta').visibility.kimi, 'shadowed');
    assert.strictEqual(byName.get('beta').shadowedBy.kimi, path.join(home, '.kimi', 'skills'));
    // Claude / Codex see only their own dirs
    assert.strictEqual(byName.get('beta').visibility.claude, 'active');
    assert.strictEqual(byName.get('alpha').visibility.claude, 'absent');
    assert.strictEqual(byName.get('beta').visibility.codex, 'absent');
    // Generic agents dir is visible to Kimi even when a brand dir wins
    assert.strictEqual(byName.get('delta').visibility.kimi, 'active');
    // Project scope: only .claude/skills + .agents/skills exist → claude brand wins for kimi
    assert.strictEqual(byName.get('gamma').visibility.kimi, 'active');
    assert.strictEqual(byName.get('delta').visibility.claude, 'absent');

    // No brand dirs at all → kimi absent
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-empty-'));
    const lonely = discovery.scanSkills({ homeDir: emptyHome });
    assert.deepStrictEqual(lonely, []);
    const gammaOnly = effectiveness.applySkillEffectiveness(scanned, {
        homeDir: emptyHome,
        dirExists: () => false,
    });
    assert.strictEqual(gammaOnly.find(r => r.name === 'alpha').visibility.kimi, 'absent');
    assert.strictEqual(gammaOnly.find(r => r.name === 'delta').visibility.kimi, 'active', 'generic group is independent of brand dirs');
}

// main: ... runEffectivenessChecks();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test-compile && node scripts/run-skill-management-checks.js`
Expected: FAIL — `Cannot find module '../out/skills/effectiveness'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/skills/effectiveness.ts
'use strict';

import * as fs from 'fs';

import { getKimiBrandCandidates, getProjectSkillsRoots, getUserSkillsRoots } from './roots';
import type { SkillAgentId, SkillRecord, SkillScope } from './types';

interface EffectivenessInput {
    homeDir: string;
    workspaceRoot?: string;
    dirExists?: (dirPath: string) => boolean;
}

const AGENTS: SkillAgentId[] = ['kimi', 'claude', 'codex'];

function applyScope(
    records: SkillRecord[],
    scope: SkillScope,
    brandWinnerDir: string | null
): void {
    for (const record of records.filter(candidate => candidate.scope === scope)) {
        if (record.source === 'agents') {
            record.visibility.kimi = 'active';
        } else if (brandWinnerDir && record.dirPath.startsWith(brandWinnerDir + require('path').sep)) {
            record.visibility.kimi = 'active';
        } else if (brandWinnerDir) {
            record.visibility.kimi = 'shadowed';
            record.shadowedBy.kimi = brandWinnerDir;
        }
        for (const agent of AGENTS) {
            if (agent === 'kimi') {
                continue;
            }
            if (record.source === agent) {
                record.visibility[agent] = 'active';
            }
        }
    }
}

export function applySkillEffectiveness(records: SkillRecord[], input: EffectivenessInput): SkillRecord[] {
    const dirExists = input.dirExists || ((dirPath: string) => fs.existsSync(dirPath));
    const cloned = records.map(record => ({
        ...record,
        visibility: { ...record.visibility },
        shadowedBy: { ...record.shadowedBy },
    }));

    const userWinner = getKimiBrandCandidates(getUserSkillsRoots(input.homeDir))
        .find(root => dirExists(root.dirPath));
    applyScope(cloned, 'user', userWinner ? userWinner.dirPath : null);

    if (input.workspaceRoot) {
        const projectWinner = getKimiBrandCandidates(getProjectSkillsRoots(input.workspaceRoot))
            .find(root => dirExists(root.dirPath));
        applyScope(cloned, 'project', projectWinner ? projectWinner.dirPath : null);
    }
    return cloned;
}
```

And in `discovery.ts`, end of `scanSkills`:

```ts
import { applySkillEffectiveness } from './effectiveness';
// ...
export function scanSkills(input: ScanSkillsInput): SkillRecord[] {
    const roots = getUserSkillsRoots(input.homeDir)
        .concat(input.workspaceRoot ? getProjectSkillsRoots(input.workspaceRoot) : []);
    return applySkillEffectiveness(roots.flatMap(scanRoot), input);
}
```

Note: Task 3's assertion `visibility all 'absent'` must be updated to expect Task 4 results for the fixture (alpha.kimi = 'active'). Update that assertion in this task.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test-compile && node scripts/run-skill-management-checks.js`
Expected: `Skill management checks passed.`

---

### Task 5: Toggle service (enable/disable by moving directories)

**Files:**
- Create: `src/skills/toggleService.ts`
- Test: extend `scripts/run-skill-management-checks.js`

**Interfaces:**
- Produces:

```ts
// src/skills/toggleService.ts
export interface SkillToggleResult {
    ok: boolean;
    dirPath?: string;   // new directory location when ok
    error?: string;
}
export function disableSkill(dirPath: string): SkillToggleResult; // move <root>/<name> → <root>/.disabled/<name>
export function enableSkill(dirPath: string): SkillToggleResult;  // move <root>/.disabled/<name> → <root>/<name>
```

Rules: destination already exists → `{ ok: false, error }`, never overwrite; create `.disabled` lazily; only operate when the path shape matches (a skill dir directly under a skills root, or directly under a `.disabled` dir); fs errors → `{ ok: false, error: message }`, never throw.

- [ ] **Step 1: Write the failing test**

```js
const toggleService = require('../out/skills/toggleService');

function runToggleChecks() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-toggle-'));
    const skillDir = path.join(home, '.kimi', 'skills', 'alpha');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: alpha\n---\n');

    const disabled = toggleService.disableSkill(skillDir);
    assert.strictEqual(disabled.ok, true);
    assert.strictEqual(disabled.dirPath, path.join(home, '.kimi', 'skills', '.disabled', 'alpha'));
    assert.ok(!fs.existsSync(skillDir));
    assert.ok(fs.existsSync(path.join(disabled.dirPath, 'SKILL.md')));

    const again = toggleService.disableSkill(disabled.dirPath);
    assert.strictEqual(again.ok, false, 'already parked is not a valid disable');

    const enabled = toggleService.enableSkill(disabled.dirPath);
    assert.strictEqual(enabled.ok, true);
    assert.strictEqual(enabled.dirPath, skillDir);
    assert.ok(fs.existsSync(path.join(skillDir, 'SKILL.md')));

    const conflictDir = path.join(home, '.kimi', 'skills', '.disabled', 'alpha');
    fs.mkdirSync(conflictDir, { recursive: true });
    const conflict = toggleService.disableSkill(skillDir);
    assert.strictEqual(conflict.ok, false);
    assert.match(conflict.error, /already exists/i);
    assert.ok(fs.existsSync(skillDir), 'source untouched on conflict');

    assert.strictEqual(toggleService.enableSkill(skillDir).ok, false, 'not parked → cannot enable');
}

// main: ... runToggleChecks();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test-compile && node scripts/run-skill-management-checks.js`
Expected: FAIL — `Cannot find module '../out/skills/toggleService'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/skills/toggleService.ts
'use strict';

import * as fs from 'fs';
import * as path from 'path';

import { DISABLED_DIR_NAME } from './roots';

export interface SkillToggleResult {
    ok: boolean;
    dirPath?: string;
    error?: string;
}

function move(dirPath: string, targetDir: string): SkillToggleResult {
    const name = path.basename(dirPath);
    const destination = path.join(targetDir, name);
    try {
        if (fs.existsSync(destination)) {
            return { ok: false, error: `Destination already exists: ${destination}` };
        }
        fs.mkdirSync(targetDir, { recursive: true });
        fs.renameSync(dirPath, destination);
        return { ok: true, dirPath: destination };
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}

export function disableSkill(dirPath: string): SkillToggleResult {
    if (path.basename(path.dirname(dirPath)) === DISABLED_DIR_NAME) {
        return { ok: false, error: 'Skill is already disabled.' };
    }
    return move(dirPath, path.join(path.dirname(dirPath), DISABLED_DIR_NAME));
}

export function enableSkill(dirPath: string): SkillToggleResult {
    if (path.basename(path.dirname(dirPath)) !== DISABLED_DIR_NAME) {
        return { ok: false, error: 'Skill is not disabled.' };
    }
    return move(dirPath, path.dirname(path.dirname(dirPath)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test-compile && node scripts/run-skill-management-checks.js`
Expected: `Skill management checks passed.`

---

### Task 6: SKILLS tab registration + panel HTML rendering

**Files:**
- Create: `src/webview/webviewSkillContent.ts`
- Modify: `src/webview/webviewContent.ts` (4th tab button + panel section)
- Modify: `src/models.ts` (`StewardInfos.skills`)
- Test: extend `scripts/run-skill-management-checks.js` with rendering assertions (stub `vscode` like `run-open-project-safety-checks.js`)

**Interfaces:**
- Consumes: `SkillRecord` (Task 1)
- Produces:

```ts
// src/webview/webviewSkillContent.ts
export function getSkillsPanelContent(records: import('../skills/types').SkillRecord[]): string;
// renders <div class="sticky-groups-wrapper">…groups…</div> grouped USER SKILLS / PROJECT SKILLS
```

Card HTML (mirrors the mockup `docs/superpowers/specs/assets/skill-management-tab-list.html`, real classes):

```html
<div class="project-container">
  <div class="project steward-item-card skill-card" data-skill-dir="{dirPath}" data-skill-file="{skillFilePath}">
    <div class="project-aura"></div>
    <div class="project-border steward-item-accent"></div>
    <button class="skill-toggle" title="Disable skill" data-skill-toggle="{dirPath}"></button>
    <div class="fitty-container project-title-row">
      <span class="project-kind-icon">{terminalLine svg}</span>
      <h2 class="project-header">{name}</h2>
    </div>
    <p class="project-description" title="{description}">{description}</p>
    <div class="skill-chip-row">
      <span class="skill-chip scope-user|scope-project">User|Project</span>
      <span class="skill-chip agent-kimi|agent-claude|agent-codex|agent-absent|warn">kimi|claude|codex</span>…
      <span class="skill-chip warn" data-skill-warn="{dirPath}">⚠ shadowed|N issues</span>
    </div>
    <div class="skill-detail" hidden>…Effectiveness per agent rows + actions…</div>
  </div>
</div>
```

Disabled card adds class `skill-card-disabled`, toggle gets `off`, and a `<span class="skill-parked-note">parked at {dirPath}</span>` after the description.

Detail panel rows per agent (`kimi`/`claude`/`codex`): chip + status (`✓ active` / `⚠ shadowed`) + resolved path (`shadowedBy[agent]` when shadowed, else `dirPath` when active in that agent's own dir, else `—`). Warn chip label: `⚠ shadowed` when any visibility is shadowed, else `⚠ N issue(s)` when diagnostics exist.

- [ ] **Step 1: Write the failing test**

Prepend to the check script (mirroring `run-open-project-safety-checks.js`):

```js
const Module = require('module');
const originalModuleLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') { return {}; }
    return originalModuleLoad.call(this, request, parent, isMain);
};
const skillContent = require('../out/webview/webviewSkillContent');
const webviewContent = require('../out/webview/webviewContent');
Module._load = originalModuleLoad;
```

```js
function makeRecord(overrides = {}) {
    return {
        name: 'demo', description: 'Demo skill', dirPath: '/home/dev/.kimi/skills/demo',
        skillFilePath: '/home/dev/.kimi/skills/demo/SKILL.md', scope: 'user', source: 'kimi',
        enabled: true, visibility: { kimi: 'active', claude: 'absent', codex: 'absent' },
        shadowedBy: {}, diagnostics: [], ...overrides,
    };
}

function runSkillRenderingChecks() {
    const html = skillContent.getSkillsPanelContent([
        makeRecord(),
        makeRecord({
            name: 'beta', scope: 'project', source: 'claude',
            dirPath: '/work/app/.claude/skills/beta', skillFilePath: '/work/app/.claude/skills/beta/SKILL.md',
            visibility: { kimi: 'shadowed', claude: 'active', codex: 'absent' },
            shadowedBy: { kimi: '/work/app/.kimi/skills' },
        }),
        makeRecord({ name: 'parked', enabled: false, dirPath: '/home/dev/.kimi/skills/.disabled/parked' }),
        makeRecord({ name: 'broken', diagnostics: [{ code: 'lowercase-filename', message: 'x' }, { code: 'missing-name', message: 'y' }] }),
    ]);
    assert.ok(html.includes('USER SKILLS'));
    assert.ok(html.includes('PROJECT SKILLS'));
    assert.ok(html.includes('data-skill-toggle="/home/dev/.kimi/skills/demo"'));
    assert.ok(html.includes('class="skill-chip agent-kimi"'));
    assert.ok(html.includes('class="skill-chip agent-absent"'));
    assert.ok(html.includes('⚠ shadowed'));
    assert.ok(html.includes('⚠ 2 issues'));
    assert.ok(html.includes('skill-card-disabled'));
    assert.ok(html.includes('parked at /home/dev/.kimi/skills/.disabled/parked'));
    assert.ok(html.includes('Effectiveness per agent'));
    assert.ok(html.includes('~/.kimi/skills') === false, 'paths render verbatim, not home-shortened');
    assert.ok(!html.includes('undefined'));
    // tab registration
    const stewardHtml = webviewContent.getStewardContent(
        { extensionPath: '/extension' },
        { cspSource: 'test', asWebviewUri: uri => uri.toString() },
        [], { config: { get: (k, d) => d }, relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false }, otherStorageHasData: false, openProjects: [], skills: [makeRecord()] },
        true
    );
    assert.ok(stewardHtml.includes('data-dashboard-tab="skills"'));
    assert.ok(stewardHtml.includes('id="dashboard-tab-skills"'));
    assert.ok(stewardHtml.includes('>SKILLS</button>'));
    assert.ok(stewardHtml.includes('data-skill-toggle='));
}

// main: ... runSkillRenderingChecks();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test-compile && node scripts/run-skill-management-checks.js`
Expected: FAIL — `Cannot find module '../out/webview/webviewSkillContent'`

- [ ] **Step 3: Write minimal implementation**

`src/models.ts` — add to `StewardInfos`:

```ts
skills?: import('./skills/types').SkillRecord[];
```

`src/webview/webviewSkillContent.ts`:

```ts
'use strict';

import type { SkillAgentId, SkillRecord, SkillVisibility } from '../skills/types';
import { escapeAttribute, sanitizeProjectName } from './webviewContent';
import { terminalLine } from './webviewIcons';

const AGENTS: SkillAgentId[] = ['kimi', 'claude', 'codex'];

function agentChip(agent: SkillAgentId, visibility: SkillVisibility): string {
    if (visibility === 'active') {
        return `<span class="skill-chip agent-${agent}">${agent}</span>`;
    }
    if (visibility === 'shadowed') {
        return `<span class="skill-chip warn">⚠ ${agent}</span>`;
    }
    return `<span class="skill-chip agent-absent">${agent}</span>`;
}

function getSkillDetail(record: SkillRecord): string {
    const rows = AGENTS.map(agent => {
        const visibility = record.visibility[agent];
        const status = visibility === 'active'
            ? '<span class="skill-detail-status ok">✓ active</span>'
            : visibility === 'shadowed'
                ? '<span class="skill-detail-status warn">⚠ shadowed</span>'
                : '<span class="skill-detail-status">—</span>';
        const detail = visibility === 'shadowed'
            ? `${escapeAttribute(record.shadowedBy[agent] || '')} wins`
            : visibility === 'active'
                ? escapeAttribute(record.dirPath)
                : 'not visible';
        return `<div class="skill-detail-row">${agentChip(agent, visibility === 'shadowed' ? 'shadowed' : visibility)}${status}<span class="skill-detail-path">${detail}</span></div>`;
    }).join('');
    const notes = record.diagnostics.map(item => `<p class="skill-detail-note">⚠ ${escapeAttribute(item.message)}</p>`).join('');
    return `<div class="skill-detail" hidden>
        <p class="skill-detail-title">Effectiveness per agent</p>
        ${rows}${notes}
        <div class="skill-detail-actions">
            <button class="primary" data-skill-open="${escapeAttribute(record.skillFilePath)}">Open SKILL.md</button>
        </div>
    </div>`;
}

function getSkillDiv(record: SkillRecord): string {
    const name = escapeAttribute(sanitizeProjectName(record.name));
    const description = escapeAttribute(sanitizeProjectName(record.description));
    const scopeLabel = record.scope === 'user' ? 'User' : 'Project';
    const shadowed = AGENTS.some(agent => record.visibility[agent] === 'shadowed');
    const warnChip = shadowed
        ? `<span class="skill-chip warn" data-skill-warn>⚠ shadowed</span>`
        : record.diagnostics.length
            ? `<span class="skill-chip warn" data-skill-warn>⚠ ${record.diagnostics.length} issue${record.diagnostics.length === 1 ? '' : 's'}</span>`
            : '';
    const chips = `<span class="skill-chip scope-${record.scope}">${scopeLabel}</span>`
        + AGENTS.map(agent => agentChip(agent, record.visibility[agent])).join('')
        + warnChip;
    const parkedNote = record.enabled ? '' : `<span class="skill-parked-note">parked at ${escapeAttribute(record.dirPath)}</span>`;
    return `
<div class="project-container">
    <div class="project steward-item-card skill-card${record.enabled ? '' : ' skill-card-disabled'}" data-skill-dir="${escapeAttribute(record.dirPath)}">
        <div class="project-aura"></div>
        <div class="project-border steward-item-accent"></div>
        <button class="skill-toggle${record.enabled ? '' : ' off'}" title="${record.enabled ? 'Disable' : 'Enable'} skill" data-skill-toggle="${escapeAttribute(record.dirPath)}"></button>
        <div class="fitty-container project-title-row">
            <span class="project-kind-icon">${terminalLine}</span>
            <h2 class="project-header">${name}</h2>
        </div>
        <p class="project-description" title="${description}">${description}</p>
        ${parkedNote}
        <div class="skill-chip-row">${chips}</div>
        ${shadowed || record.diagnostics.length ? getSkillDetail(record) : ''}
    </div>
</div>`;
}

export function getSkillsPanelContent(records: SkillRecord[]): string {
    const user = (records || []).filter(record => record.scope === 'user');
    const project = (records || []).filter(record => record.scope === 'project');
    const sections = [
        ['USER SKILLS', user],
        ['PROJECT SKILLS', project],
    ] as const;
    return `<div class="sticky-groups-wrapper skills-groups-wrapper">${sections
        .filter(([, items]) => items.length)
        .map(([title, items]) => `
<div class="group steward-section" data-group-id="${title.toLowerCase().replace(/\s+/g, '-')}">
    <div class="group-title steward-section-header steward-group-header">
        <span class="group-title-text">${title}</span>
        <span class="group-title-badge">${items.length}</span>
    </div>
    <div class="group-list">
        <div class="drop-signal"></div>
        ${items.map(getSkillDiv).join('\n')}
    </div>
</div>`).join('\n') || '<div class="skills-empty">No skills found in Kimi, Claude, or Codex skill directories.</div>'}
</div>`;
}
```

If `escapeAttribute`/`sanitizeProjectName` are not exported from `webviewContent.ts`, export them (they are module-level functions there; add `export` if missing) — keep imports working.

`src/webview/webviewContent.ts` — in `getStewardContent`, after the TODO tab button add:

```ts
<button type="button" id="dashboard-tab-skills-button" class="dashboard-tab-button" role="tab" aria-selected="false" aria-controls="dashboard-tab-skills" tabindex="-1" data-dashboard-tab="skills">SKILLS</button>
```

and after the TODO panel section add:

```ts
<section id="dashboard-tab-skills" class="dashboard-tab-panel" role="tabpanel" aria-labelledby="dashboard-tab-skills-button" hidden>
    ${getSkillsPanelContent(infos.skills || [])}
</section>
```

with `import { getSkillsPanelContent } from './webviewSkillContent';`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test-compile && node scripts/run-skill-management-checks.js`
Expected: `Skill management checks passed.`

---

### Task 7: Skill card styles

**Files:**
- Modify: `media/styles.scss`
- Regenerate: `media/styles.css` (`npx gulp buildStyles`)
- Test: style assertions in the check script

- [ ] **Step 1: Write the failing test**

```js
function runSkillStyleChecks() {
    const styles = fs.readFileSync(path.join(__dirname, '..', 'media', 'styles.scss'), 'utf8');
    const compiled = fs.readFileSync(path.join(__dirname, '..', 'media', 'styles.css'), 'utf8');
    assert.ok(styles.includes('.skill-card'));
    assert.ok(styles.includes('body.steward-sidebar .skill-card'));
    assert.ok(styles.includes('.skill-toggle'));
    assert.ok(styles.includes('.skill-chip'));
    assert.ok(styles.includes('.skill-detail'));
    assert.ok(compiled.includes('.skill-toggle'));
    assert.ok(compiled.includes('.skill-chip'));
    assert.ok(!styles.includes('color-mix('));
}

// main: ... runSkillStyleChecks();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx gulp buildStyles && node scripts/run-skill-management-checks.js`
Expected: FAIL on missing selectors

- [ ] **Step 3: Write minimal implementation**

Append inside the existing `body.steward-sidebar { … }` block in `media/styles.scss` (end of block):

```scss
.skill-card {
    height: auto;
    min-height: 96px;
}

body.steward-sidebar .skill-card .project-description {
    white-space: normal;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
}

.skill-toggle {
    position: absolute;
    top: 8px;
    right: 9px;
    z-index: 3;
    width: 26px;
    height: 14px;
    border: 0;
    border-radius: 999px;
    padding: 0;
    background: var(--vscode-button-background);
    cursor: pointer;

    &::after {
        content: "";
        position: absolute;
        top: 2px;
        right: 2px;
        width: 10px;
        height: 10px;
        border-radius: 999px;
        background: #fff;
    }

    &.off {
        background: #3c3c3c;
        box-shadow: inset 0 0 0 1px #555;

        &::after {
            right: auto;
            left: 2px;
            background: #888;
        }
    }
}

.skill-card-disabled {
    opacity: .55;
}

.skill-parked-note {
    display: block;
    margin-top: 2px;
    font-size: 9px;
    font-style: italic;
    color: var(--vscode-descriptionForeground);
    opacity: .8;
}

.skill-chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
    margin-top: 6px;
}

.skill-chip {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 7px;
    border: 1px solid transparent;
    border-radius: 999px;
    font-size: 9px;
    line-height: 14px;
    white-space: nowrap;

    &.scope-user { color: #8ab4f8; background: rgba(55, 148, 255, .14); border-color: rgba(138, 180, 248, .4); }
    &.scope-project { color: #c9a6f2; background: rgba(180, 130, 255, .13); border-color: rgba(201, 166, 242, .35); }
    &.agent-kimi { color: #7aa2ff; background: rgba(122, 162, 255, .13); border-color: rgba(122, 162, 255, .4); }
    &.agent-claude { color: #d97757; background: rgba(217, 119, 87, .13); border-color: rgba(217, 119, 87, .4); }
    &.agent-codex { color: #4ec9b0; background: rgba(78, 201, 176, .13); border-color: rgba(78, 201, 176, .4); }
    &.agent-absent { color: #6a6a6a; background: rgba(110, 110, 110, .08); border-color: rgba(110, 110, 110, .25); text-decoration: line-through; }
    &.warn { color: var(--vscode-editorWarning-foreground, #cca700); background: rgba(204, 167, 0, .12); border-color: rgba(204, 167, 0, .4); cursor: pointer; }
}

.skill-detail {
    margin-top: 8px;
    padding: 8px 10px;
    border: 1px solid #3a3d42;
    border-radius: 12px;
    background: #1e2023;
}

.skill-detail-title {
    margin: 0 0 7px;
    font-size: 11px;
    font-weight: 600;
}

.skill-detail-row {
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 5px 0;
    font-size: 10px;
}

.skill-detail-status {
    flex: none;
    width: 74px;
    font-size: 10px;

    &.ok { color: var(--vscode-charts-green); }
    &.warn { color: var(--vscode-editorWarning-foreground, #cca700); }
}

.skill-detail-path {
    overflow: hidden;
    color: var(--vscode-descriptionForeground);
    font-size: 9.5px;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.skill-detail-note {
    margin: 8px 0 0;
    padding-top: 7px;
    border-top: 1px solid #333;
    color: var(--vscode-editorWarning-foreground, #cca700);
    font-size: 10px;
    line-height: 1.5;
}

.skill-detail-actions {
    display: flex;
    gap: 6px;
    margin-top: 8px;

    button {
        padding: 3px 10px;
        border: 0;
        border-radius: 4px;
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        cursor: pointer;
        font-size: 10px;
    }

    button.primary {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
    }
}

.skills-empty {
    padding: 12px 4px;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
}
```

Run `npx gulp buildStyles`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx gulp buildStyles && node scripts/run-skill-management-checks.js`
Expected: `Skill management checks passed.`

---

### Task 8: Webview JS — tab wiring + card interactions + incremental updates

**Files:**
- Modify: `src/webview/webviewDashboardScripts.js`
- Copy: `media/webviewDashboardScripts.js` (`npx gulp copyWebviewAssets`)
- Test: assertions in the check script

**Interfaces:**
- Messages (webview → host): `{ type: 'toggle-skill', dirPath: string, enabled: boolean }`, `{ type: 'open-skill-file', skillFilePath: string }`
- Messages (host → webview): `{ type: 'skills-updated', html: string }`

- [ ] **Step 1: Write the failing test**

```js
function runSkillWebviewScriptChecks() {
    const script = fs.readFileSync(path.join(__dirname, '..', 'media', 'webviewDashboardScripts.js'), 'utf8');
    assert.ok(script.includes("panels.skills") || script.includes('skills: document.getElementById'));
    assert.ok(script.includes("tab === 'skills'"));
    assert.ok(script.includes("'toggle-skill'"));
    assert.ok(script.includes("'open-skill-file'"));
    assert.ok(script.includes("'skills-updated'"));
    assert.ok(script.includes('data-skill-toggle'));
    assert.ok(script.includes('data-skill-warn'));
}

// main: ... runSkillWebviewScriptChecks();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx gulp copyWebviewAssets && node scripts/run-skill-management-checks.js`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

In `src/webview/webviewDashboardScripts.js`:

1. panels map: add `skills: document.getElementById('dashboard-tab-skills'),`
2. `normalizeDashboardTab`: `return tab === 'projects' || tab === 'todo' || tab === 'skills' ? tab : 'open';`
3. tabs array: `var tabs = ['open', 'projects', 'todo', 'skills'];`
4. Message handler registration (next to existing `open-projects-updated` handling):

```js
if (message.type === 'skills-updated') {
    var skillsWrapper = document.querySelector('#dashboard-tab-skills .sticky-groups-wrapper');
    if (skillsWrapper && typeof message.html === 'string') {
        skillsWrapper.outerHTML = message.html;
    }
    return;
}
```

5. Card interactions (delegate on document, next to existing project click delegation):

```js
document.addEventListener('click', event => {
    var toggle = event.target.closest ? event.target.closest('[data-skill-toggle]') : null;
    if (toggle) {
        event.preventDefault();
        event.stopPropagation();
        vscodeApi.postMessage({
            type: 'toggle-skill',
            dirPath: toggle.getAttribute('data-skill-toggle'),
            enabled: !toggle.classList.contains('off'),
        });
        return;
    }
    var openButton = event.target.closest ? event.target.closest('[data-skill-open]') : null;
    if (openButton) {
        event.preventDefault();
        event.stopPropagation();
        vscodeApi.postMessage({ type: 'open-skill-file', skillFilePath: openButton.getAttribute('data-skill-open') });
        return;
    }
    var warn = event.target.closest ? event.target.closest('[data-skill-warn]') : null;
    if (warn) {
        event.preventDefault();
        var card = warn.closest('.skill-card');
        var detail = card && card.querySelector('.skill-detail');
        if (detail) {
            detail.hidden = !detail.hidden;
        }
        return;
    }
    var skillCard = event.target.closest ? event.target.closest('.skill-card[data-skill-dir]') : null;
    if (skillCard) {
        var openTarget = skillCard.querySelector('[data-skill-open]');
        if (openTarget) {
            vscodeApi.postMessage({ type: 'open-skill-file', skillFilePath: openTarget.getAttribute('data-skill-open') });
        }
    }
});
```

Use the webview's existing `vscode` API handle name (check the file: it may be `vscode` or `api`; match it).

Run `npx gulp copyWebviewAssets`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx gulp copyWebviewAssets && node scripts/run-skill-management-checks.js`
Expected: `Skill management checks passed.`

---

### Task 9: Dashboard controller + host wiring

**Files:**
- Create: `src/skills/dashboardController.ts`
- Modify: `src/dashboard.ts` (instantiate, stewardInfos.skills, message handlers)
- Test: controller behavior test in the check script (stub postMessage/scan) + source wiring assertions

**Interfaces:**
- Produces:

```ts
// src/skills/dashboardController.ts
export interface SkillDashboardControllerOptions {
    getHomeDir: () => string;
    getWorkspaceRoot: () => string | undefined;
    postMessage: (message: unknown) => Thenable<boolean>;
    isVisible: () => boolean;
    logError: (message: string, error: unknown) => void;
    nowMs?: () => number;
}
export class SkillDashboardController implements { dispose(): void } {
    constructor(options: SkillDashboardControllerOptions);
    getRecords(): import('./types').SkillRecord[];   // last scan, [] before first
    refresh(reason?: string): void;                  // rescan + post 'skills-updated' when visible
    handleToggle(dirPath: string, enabled: boolean): { ok: boolean; error?: string };
    start(): void;   // initial scan + watchers
    dispose(): void;
}
```

Watcher approach: after each scan, `fs.watch` every existing skills root dir AND every first-level skill dir (non-recursive; Linux has no recursive watch), debounced 300 ms → `refresh('watch')`. All watcher errors swallowed via logError.

- [ ] **Step 1: Write the failing test**

```js
const { SkillDashboardController } = require('../out/skills/dashboardController');

function runSkillControllerChecks() {
    const { home } = makeFixture();
    const posted = [];
    const controller = new SkillDashboardController({
        getHomeDir: () => home,
        getWorkspaceRoot: () => undefined,
        postMessage: message => { posted.push(message); return Promise.resolve(true); },
        isVisible: () => true,
        logError: () => undefined,
    });
    controller.start();
    const records = controller.getRecords();
    assert.ok(records.length >= 2);
    assert.ok(posted.some(message => message.type === 'skills-updated' && message.html.includes('alpha')));

    const skillDir = path.join(home, '.kimi', 'skills', 'alpha');
    const result = controller.handleToggle(skillDir, true);
    assert.strictEqual(result.ok, true);
    assert.ok(!controller.getRecords().some(record => record.name === 'alpha'),
        'disabled skill disappears from the next scan');
    const parkedPath = path.join(home, '.kimi', 'skills', '.disabled', 'alpha');
    assert.strictEqual(controller.handleToggle(parkedPath, false).ok, true);
    assert.ok(controller.getRecords().some(record => record.name === 'alpha'));

    posted.length = 0;
    const bad = controller.handleToggle(path.join(home, '.kimi', 'skills', 'missing'), true);
    assert.strictEqual(bad.ok, false);
    controller.dispose();
}

// main: ... runSkillControllerChecks();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test-compile && node scripts/run-skill-management-checks.js`
Expected: FAIL — `Cannot find module '../out/skills/dashboardController'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/skills/dashboardController.ts
'use strict';

import * as fs from 'fs';
import * as path from 'path';

import { scanSkills } from './discovery';
import { getProjectSkillsRoots, getUserSkillsRoots } from './roots';
import { disableSkill, enableSkill } from './toggleService';
import { getSkillsPanelContent } from '../webview/webviewSkillContent';
import type { SkillRecord } from './types';

export interface SkillDashboardControllerOptions {
    getHomeDir: () => string;
    getWorkspaceRoot: () => string | undefined;
    postMessage: (message: unknown) => Thenable<boolean>;
    isVisible: () => boolean;
    logError: (message: string, error: unknown) => void;
    nowMs?: () => number;
}

const WATCH_DEBOUNCE_MS = 300;

export class SkillDashboardController {
    private records: SkillRecord[] = [];
    private watchers: fs.FSWatcher[] = [];
    private refreshTimer: NodeJS.Timeout | null = null;
    private disposed = false;

    constructor(private readonly options: SkillDashboardControllerOptions) {
    }

    getRecords(): SkillRecord[] {
        return this.records;
    }

    start(): void {
        this.refresh('start');
    }

    refresh(_reason = 'refresh'): void {
        if (this.disposed) {
            return;
        }
        try {
            this.records = scanSkills({
                homeDir: this.options.getHomeDir(),
                workspaceRoot: this.options.getWorkspaceRoot(),
            });
        } catch (error) {
            this.options.logError('Skill scan failed.', error);
            this.records = [];
        }
        this.resetWatchers();
        if (this.options.isVisible()) {
            void this.options.postMessage({
                type: 'skills-updated',
                html: getSkillsPanelContent(this.records),
            });
        }
    }

    handleToggle(dirPath: string, enabled: boolean): { ok: boolean; error?: string } {
        const result = enabled ? disableSkill(dirPath) : enableSkill(dirPath);
        if (!result.ok) {
            this.options.logError('Failed to toggle skill.', new Error(result.error || 'unknown error'));
        }
        this.refresh('toggle');
        return result;
    }

    dispose(): void {
        this.disposed = true;
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = null;
        }
        this.resetWatchers();
    }

    private resetWatchers(): void {
        for (const watcher of this.watchers) {
            try { watcher.close(); } catch (_error) { /* ignore */ }
        }
        this.watchers = [];
        if (this.disposed) {
            return;
        }
        const roots = getUserSkillsRoots(this.options.getHomeDir())
            .concat(this.options.getWorkspaceRoot() ? getProjectSkillsRoots(this.options.getWorkspaceRoot() as string) : []);
        const dirs = roots.map(root => root.dirPath)
            .concat(this.records.map(record => record.dirPath));
        for (const dirPath of dirs) {
            try {
                if (!fs.existsSync(dirPath)) {
                    continue;
                }
                const watcher = fs.watch(dirPath, () => this.scheduleRefresh());
                watcher.on('error', () => undefined);
                this.watchers.push(watcher);
            } catch (_error) {
                // Unwatchable directories must not break the dashboard.
            }
        }
    }

    private scheduleRefresh(): void {
        if (this.refreshTimer) {
            return;
        }
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = null;
            this.refresh('watch');
        }, WATCH_DEBOUNCE_MS);
    }
}
```

`src/dashboard.ts` wiring (near other controllers, after `provider` exists):

```ts
const skillDashboardController = new SkillDashboardController({
    getHomeDir: () => os.homedir(),                          // add `import * as os from 'os';` if missing
    getWorkspaceRoot: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    postMessage: message => provider.postMessage(message),
    isVisible: () => provider.visible,
    logError,
});
skillDashboardController.start();
context.subscriptions.push({ dispose: () => skillDashboardController.dispose() });
```

- `stewardInfos`: add `get skills() { return skillDashboardController.getRecords() },`
- message router handlers map: add

```ts
'toggle-skill': e => {
    const result = skillDashboardController.handleToggle(String(e.dirPath || ''), e.enabled === true);
    if (!result.ok) {
        void vscode.window.showWarningMessage(`Could not toggle skill: ${result.error}`);
    }
},
'open-skill-file': async e => {
    await vscode.window.showTextDocument(vscode.Uri.file(String(e.skillFilePath || '')));
},
```

- Source wiring assertions in the check script:

```js
function runSkillWiringChecks() {
    const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.ts'), 'utf8');
    assert.ok(dashboard.includes('new SkillDashboardController('));
    assert.ok(dashboard.includes("'toggle-skill'"));
    assert.ok(dashboard.includes("'open-skill-file'"));
    assert.ok(dashboard.includes('skillDashboardController.getRecords()'));
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.ok(packageJson.scripts['test:skills'].includes('run-skill-management-checks.js'));
    assert.ok(packageJson.scripts['test:safety'].includes('run-skill-management-checks.js'));
}

// main: ... runSkillWiringChecks();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test-compile && node scripts/run-skill-management-checks.js`
Expected: `Skill management checks passed.`

---

### Task 10: Packaging, README, full verification

**Files:**
- Modify: `package.json`
- Modify: `README.md`
- Test: all suites

- [ ] **Step 1: package.json scripts**

```json
"test:skills": "npm run test-compile && node scripts/run-skill-management-checks.js",
```

and append `&& node scripts/run-skill-management-checks.js` to `test:safety`.

- [ ] **Step 2: README**

Add to the feature list / AI sections: a short "SKILLS tab" paragraph — unified cross-agent skill discovery (Kimi/Claude/Codex), per-agent effectiveness with shadowing diagnostics, one-click enable/disable.

- [ ] **Step 3: Full verification**

Run, in order:

```bash
npm run test:skills
npm run test:open-projects
npm run test:dashboard
npm run test:safety
npx gulp --production
```

Expected: all pass; `git diff --check main...HEAD` clean.

- [ ] **Step 4: Report**

Summarize files changed, checks run with outputs, and stop. Do NOT commit — the user decides.

---

## Self-Review

- **Spec coverage:** unified model (T1–T4), toggle (T5), tab list (T6), styles (T7), interactions + watcher refresh (T8–T9), diagnostics incl. lowercase-filename fixture (T1, T3), packaging (T10). P1/P2 items (sync, registry, built-in) intentionally absent.
- **Placeholders:** none — every code step shows the code.
- **Type consistency:** `SkillRecord`/`SkillsRoot`/`SkillDashboardControllerOptions` shapes match across tasks; message type strings match between T8 and T9 (`toggle-skill`, `open-skill-file`, `skills-updated`).
- **Known follow-ups verified at implementation time:** the webview's vscode API handle name in `webviewDashboardScripts.js` (T8 step 3 note); `escapeAttribute`/`sanitizeProjectName` export status (T6 step 3 note).
