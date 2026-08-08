'use strict';

// Covers WEBVIEW-AI-SKILL-PANEL-001 (deterministic render coverage for the
// list-surface markup branches that the Chromium owners exercise visually).

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

function loadSkillContent() {
    // getSkillsPanelContent calls vscode.Uri.file at render time (same stub as
    // tests/contract/skills/skillScanCache.test.js).
    const fakeVscode = {
        Uri: {
            file: filePath => ({
                scheme: 'file',
                path: filePath,
                toString: () => `file://${filePath}`,
            }),
        },
    };
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') { return fakeVscode; }
            return previousLoad.call(this, request, parent, isMain);
        };
        return {
            getSkillsPanelContent: require('../../../out/webview/webviewSkillContent').getSkillsPanelContent,
            getSkillStableKey: require('../../../out/skills/skillGroupStore').getSkillStableKey,
        };
    } finally {
        Module._load = previousLoad;
    }
}

function makeRecord(overrides = {}) {
    return {
        name: 'demo',
        description: 'Demo skill',
        dirPath: '/home/dev/.kimi/skills/demo',
        skillFilePath: '/home/dev/.kimi/skills/demo/SKILL.md',
        scope: 'user',
        source: 'kimi',
        enabled: true,
        visibility: { kimi: 'active', claude: 'absent', codex: 'absent' },
        shadowedBy: {},
        diagnostics: [],
        ...overrides,
    };
}

function centralRecord(overrides = {}) {
    const dirPath = overrides.dirPath || '/home/dev/.skills/superpowers/nested/alpha';
    return makeRecord({
        name: 'alpha',
        source: 'central',
        dirPath,
        skillFilePath: `${dirPath}/SKILL.md`,
        folder: 'superpowers/nested',
        contentHash: 'aaaaaaaaaaaaaaaa',
        central: { dirPath, links: { user: { kimi: '/home/dev/.kimi/skills/alpha' }, project: {} } },
        visibility: { kimi: 'active', claude: 'absent', codex: 'absent' },
        ...overrides,
    });
}

function richFixture() {
    const central = centralRecord({
        central: {
            dirPath: '/home/dev/.skills/superpowers/nested/alpha',
            links: {
                user: { kimi: '/home/dev/.kimi/skills/alpha' },
                project: { kimi: '/work/app/.kimi/skills/alpha', codex: '/work/app/.codex/skills/alpha' },
            },
        },
    });
    const driftTwin = makeRecord({
        name: 'alpha',
        dirPath: '/home/dev/.kimi/skills/alpha',
        skillFilePath: '/home/dev/.kimi/skills/alpha/SKILL.md',
        contentHash: 'bbbbbbbbbbbbbbbb',
    });
    const shadowed = makeRecord({
        name: 'shade',
        dirPath: '/home/dev/.kimi/skills/shade',
        skillFilePath: '/home/dev/.kimi/skills/shade/SKILL.md',
        visibility: { kimi: 'shadowed', claude: 'absent', codex: 'absent' },
        shadowedBy: { kimi: '/home/dev/.kimi/skills/alpha' },
    });
    const broken = makeRecord({
        name: 'broken',
        dirPath: '/home/dev/.kimi/skills/broken',
        skillFilePath: '/home/dev/.kimi/skills/broken/SKILL.md',
        diagnostics: [{ code: 'missing-name', message: 'frontmatter is missing a name' }],
    });
    const plain = makeRecord({
        name: 'plain',
        source: 'claude',
        dirPath: '/home/dev/.claude/skills/plain',
        skillFilePath: '/home/dev/.claude/skills/plain/SKILL.md',
        visibility: { kimi: 'absent', claude: 'active', codex: 'absent' },
    });
    const project = centralRecord({
        name: 'proj',
        scope: 'project',
        dirPath: '/work/app/.skills/proj',
        skillFilePath: '/work/app/.skills/proj/SKILL.md',
        folder: '',
        central: { dirPath: '/work/app/.skills/proj', links: { project: { kimi: '/work/app/.kimi/skills/proj' } } },
    });
    const records = [central, driftTwin, shadowed, broken, plain, project];
    const { getSkillStableKey } = loadSkillContent();
    const view = {
        hasWorkspace: true,
        storeRoots: { user: '/home/dev/.skills', project: '/work/app/.skills' },
        storeFolders: { user: ['superpowers', 'superpowers/nested', 'emptypack'], project: [] },
        conflicts: new Set([central.dirPath]),
        copyTargets: new Map([[getSkillStableKey(driftTwin), [{ source: 'claude', rootDir: '/home/dev/.claude/skills' }]]]),
    };
    return { records, view };
}

test('WEBVIEW-AI-SKILL-PANEL-001 renders every warn-glyph and row branch', () => {
    const { getSkillsPanelContent } = loadSkillContent();
    const { records, view } = richFixture();
    const html = getSkillsPanelContent(records, view);

    // split panes: both scopes render, so the accessible resizer is present
    assert.ok(html.includes('data-skills-pane="user"'));
    assert.ok(html.includes('data-skills-pane-resizer'));
    assert.ok(html.includes('aria-valuemax="100"'));
    assert.ok(html.includes('data-skills-pane="project"'));

    // nested sticky folder headers carry the exact per-depth offset
    assert.ok(html.includes('data-skill-folder="superpowers"'), 'top-level folder renders');
    assert.ok(html.includes('data-skill-folder="emptypack"'), 'empty folder node renders from the store listing');
    const nestedStart = html.indexOf('data-skill-folder="superpowers/nested"');
    assert.ok(nestedStart > 0);
    assert.ok(html.slice(0, nestedStart).includes('style="top: 0px"'), 'depth-0 folder sticks at the list top');
    assert.ok(html.slice(nestedStart).includes('style="top: 24px"'), 'depth-1 folder stacks one header lower');
    assert.ok(html.includes('skill-folder-icon'), 'folder icon renders');

    // warn glyphs: conflict wins over drift, shadowed and diagnostics variants
    assert.ok(html.includes('title="Name conflict: another central skill links the same agent slot"'));
    assert.ok(html.includes('title="Copies of this skill have drifted"'));
    assert.ok(html.includes('title="Shadowed by another copy for at least one agent"'));
    assert.ok(html.includes('title="1 issue"'));
    assert.strictEqual(html.split('data-skill-warn').length - 1, 4, 'clean rows carry no warn glyph');

    // central detail: link switch with a path note, unlinked notes, scope action count
    assert.ok(html.includes('title="/home/dev/.kimi/skills/alpha"'), 'linked agent note shows the link target');
    assert.ok(html.includes('>not linked<'), 'unlinked agents read as a muted note');
    assert.ok(html.includes('In project · 2'), 'user central with project links shows the link count');
    assert.ok(html.includes('data-skill-move-edit="/home/dev/.skills/superpowers/nested/alpha"'),
        'central detail offers the move editor disclosure');

    // unmanaged detail: active / shadowed / absent status rows
    assert.ok(html.includes('✓ active'));
    assert.ok(html.includes('⚠ shadowed'));
    assert.ok(html.includes('/home/dev/.kimi/skills/alpha wins'), 'shadowed row names the winning copy');
    assert.ok(html.includes('not visible'));

    // drift copies with fingerprints and the sync action
    assert.ok(html.includes('#aaaaaaa') && html.includes('#bbbbbbb'), 'copies list short fingerprints');
    assert.ok(html.includes('(this copy)'));
    assert.ok(html.includes('data-skill-sync="/home/dev/.kimi/skills/alpha"'), 'sync action renders on the other copy');

    // diagnostics note with the fix action, and the copy-to row in the detail
    assert.ok(html.includes('data-skill-fix-code="missing-name"'));
    assert.ok(html.includes('Copy to:'));
    assert.ok(html.includes('data-skill-copy-root="/home/dev/.claude/skills"'));

    // project-scope central offers Move to Global
    assert.ok(html.includes('data-skill-scope-operation="move-to-global"'));
    assert.ok(html.includes('Move to Global'));
});

test('WEBVIEW-AI-SKILL-PANEL-001 renders the no-workspace scope action state', () => {
    const { getSkillsPanelContent } = loadSkillContent();
    const html = getSkillsPanelContent([centralRecord()], { hasWorkspace: false });
    assert.ok(html.includes('Open a project'), 'no workspace disables the apply-to-project action');
    assert.ok(html.includes('title="Open a project to apply this global skill" disabled'));
    assert.ok(!html.includes('data-skills-pane="project"'), 'no project pane without a workspace');
    assert.ok(!html.includes('data-skills-pane-resizer'), 'single pane renders no resizer');
});
