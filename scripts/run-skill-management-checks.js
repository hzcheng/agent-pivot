'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const frontmatter = require('../out/skills/frontmatter');
const roots = require('../out/skills/roots');
const discovery = require('../out/skills/discovery');
const effectiveness = require('../out/skills/effectiveness');

// Stub `vscode` before requiring webview modules (mirrors run-open-project-safety-checks.js).
// getMediaResource calls vscode.Uri.file at render time, so the stub needs a minimal Uri.file.
const Module = require('module');
const originalModuleLoad = Module._load;
const vscodeStub = {
    Uri: {
        file: filePath => ({
            scheme: 'file',
            path: filePath,
            toString: () => `file://${filePath}`,
        }),
    },
};
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') { return vscodeStub; }
    return originalModuleLoad.call(this, request, parent, isMain);
};
const skillContent = require('../out/webview/webviewSkillContent');
const webviewContent = require('../out/webview/webviewContent');
const promptWebviewContent = require('../out/prompts/webviewContent');
// dashboardController transitively requires webviewSkillContent → webviewContent → vscode,
// so it must be required while the vscode stub is still active.
const { SkillDashboardController, computeSkillLinkConflicts } = require('../out/skills/dashboardController');
Module._load = originalModuleLoad;

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
    assert.strictEqual(roots.DISABLED_DIR_NAME, undefined, 'the .disabled mechanism is retired');
}

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
    // Legacy `.disabled` directories are dot-skipped like any other hidden dir.
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
    assert.strictEqual(byName.get('alpha').description, 'Alpha skill');
    assert.deepStrictEqual(byName.get('alpha').diagnostics, []);
    assert.strictEqual(byName.get('gamma').scope, 'project');
    assert.strictEqual(byName.get('delta').source, 'agents');
    assert.deepStrictEqual(
        byName.get('delta').diagnostics.map(item => item.code),
        ['lowercase-filename']
    );
    assert.ok(!byName.has('parked'), '.disabled content is dot-skipped, never scanned');
    assert.ok(!byName.has('hidden'), 'dot-directories must be skipped');
    assert.ok(!byName.has('.hidden'));
    assert.strictEqual(byName.get('alpha').enabled, undefined, 'SkillRecord.enabled is retired');
    assert.deepStrictEqual(byName.get('alpha').visibility, { kimi: 'active', claude: 'absent', codex: 'absent' });
}

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

function makeRecord(overrides = {}) {
    return {
        name: 'demo', description: 'Demo skill', dirPath: '/home/dev/.kimi/skills/demo',
        skillFilePath: '/home/dev/.kimi/skills/demo/SKILL.md', scope: 'user', source: 'kimi',
        folder: '', visibility: { kimi: 'active', claude: 'absent', codex: 'absent' },
        shadowedBy: {}, diagnostics: [], ...overrides,
    };
}

// Isolate one folder node's header segment: from its data-skill-folder marker up to
// the next nested folder or skill card, so batch-switch assertions match only this
// folder's own switch (never a sibling/parent header or a store-level switch).
function folderHeader(html, folderPath) {
    const marker = `data-skill-folder="${folderPath}"`;
    const start = html.indexOf(marker);
    assert.ok(start >= 0, `folder node ${folderPath} renders`);
    const rest = html.slice(start + marker.length);
    const stops = [rest.indexOf('data-skill-folder='), rest.indexOf('project-container')]
        .filter(index => index >= 0);
    return rest.slice(0, stops.length ? Math.min(...stops) : rest.length);
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
        makeRecord({ name: 'broken', diagnostics: [{ code: 'lowercase-filename', message: 'x' }, { code: 'missing-name', message: 'y' }] }),
    ]);
    // tree: two top-level folders (global / project) with collection folders nested inside
    assert.ok(html.includes('</span>global'), 'top-level global folder');
    assert.ok(html.includes('</span>project'), 'top-level project folder');
    assert.ok((html.match(/skill-collection-icon/g) || []).length >= 2, 'folder icons on tree nodes');
    assert.ok(html.includes('data-skill-delete="/home/dev/.kimi/skills/demo"'), 'unmanaged cards render the Delete action');
    assert.ok(!html.includes('data-skill-toggle='), 'master toggle retired');
    assert.ok(html.includes('data-skill-open="/home/dev/.kimi/skills/demo/SKILL.md"'),
        'clean records (no shadowing, no diagnostics) render the Open SKILL.md action');
    assert.ok(!html.includes('class="skill-chip agent-kimi"'), 'agent chips retired on cards');
    assert.ok(!html.includes('class="skill-chip agent-absent"'), 'absent chips retired on cards');
    assert.ok(!html.includes('skill-chip scope-'), 'scope chips retired (section conveys scope)');
    assert.ok((html.match(/skill-agent-dot /g) || []).length >= 3, 'agent dots render on cards');
    assert.ok(html.includes('skill-agent-dot active'), 'active dot renders');
    assert.ok(html.includes('skill-agent-dot shadowed'), 'shadowed dot renders');
    assert.ok(html.includes('skill-detail-desc'), 'expanded detail shows the full description');
    assert.ok(html.includes('⚠ shadowed'));
    assert.ok(html.includes('⚠ 2 issues'));
    assert.ok(!html.includes('skill-card-disabled'), 'disabled card styling retired');
    assert.ok(!html.includes('skill-parked-note'), 'parked note retired');
    assert.ok(html.includes('Effectiveness per agent'));
    assert.ok(html.includes('~/.kimi/skills') === false, 'paths render verbatim, not home-shortened');
    assert.ok(!html.includes('undefined'));
    // scope × source two-level grouping
    assert.ok(html.includes('data-skill-source="kimi"'), 'source sub-groups render');
    assert.ok(html.includes('data-skill-source="claude"'));
    assert.ok(html.includes('<span class="skill-source-path" title="/home/dev/.kimi/skills">/home/dev/.kimi/skills</span>'),
        'source root renders verbatim');
    assert.strictEqual(html.split('data-skill-source="kimi"').length - 1, 1,
        'one kimi source group for the unmanaged records');
    assert.ok(html.indexOf('data-skill-source="kimi"') < html.indexOf('data-skill-source="claude"'),
        'source groups follow kimi > claude order');
    assert.ok(html.includes('<span class="skill-source-count">2</span>'), 'source group shows its skill count');
    assert.ok(html.indexOf('>broken</h2>') < html.indexOf('>demo</h2>'), 'cards sort by name within a source group');
    // TODO(T7): finalized in the group-retirement task — virtual collection node, datalist,
    // ungroup and group-editor rendering assertions removed with the folder-tree rendering (Task 5).
    assert.ok(html.includes('draggable="true"'), 'cards stay draggable for folder moves');
    assert.ok(html.includes('data-skill-scope="user"'));
    assert.ok(html.includes('data-skill-fix-code="lowercase-filename"'), 'fixable diagnostics render a Fix button');
    assert.ok(!skillContent.getSkillsPanelContent([makeRecord({ diagnostics: [{ code: 'body-too-long', message: 'x' }] })]).includes('data-skill-fix='),
        'non-fixable diagnostics render no Fix button');
    // agent filter row + per-card active-agent attributes
    assert.ok(html.includes('data-action="collapse"'), 'skill groups carry the collapse affordance');
    assert.ok(html.includes('collapse-icon'));
    assert.ok(html.includes('data-skill-filter-row'), 'filter row renders');
    assert.ok(html.includes('data-skill-filter="all"'));
    assert.ok(html.includes('data-skill-filter="kimi"'));
    assert.ok(html.includes('data-skill-filter="claude"'));
    assert.ok(html.includes('data-skill-filter="codex"'));
    assert.ok(html.includes('data-skill-agents="kimi"'), 'demo is active for kimi only');
    // SKILLS lives as a subtab inside the AI panel, not as a top-level dashboard tab
    const stewardHtml = webviewContent.getStewardContent(
        { extensionPath: '/extension' },
        { cspSource: 'test', asWebviewUri: uri => uri.toString() },
        [], { config: { get: (k, d) => d }, relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false }, otherStorageHasData: false, openProjects: [] },
        true
    );
    assert.ok(!stewardHtml.includes('data-dashboard-tab="skills"'), 'no top-level SKILLS tab');
    const aiPanelHtml = promptWebviewContent.getAiPanelContent(
        { prompts: [], selectedPromptId: null, revision: 0 },
        html
    );
    assert.ok(aiPanelHtml.includes('id="ai-tab-skills"'));
    assert.ok(aiPanelHtml.includes('id="ai-panel-skills"'));
    assert.ok(aiPanelHtml.includes('data-skill-delete='), 'skills surface embedded in the AI panel');
    assert.ok(!promptWebviewContent.getAiPanelContent({ prompts: [], selectedPromptId: null, revision: 0 }).includes('data-skill-delete='),
        'placeholder renders without a skills surface');

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
        // every member of this folder links all three agents at user scope → batch on
        makeRecord({ name: 'omega', source: 'central', dirPath: '/home/dev/.skills/linked/omega',
            skillFilePath: '/home/dev/.skills/linked/omega/SKILL.md', folder: 'linked',
            central: { dirPath: '/home/dev/.skills/linked/omega', links: { user: {
                kimi: '/home/dev/.kimi/skills/omega',
                claude: '/home/dev/.claude/skills/omega',
                codex: '/home/dev/.codex/skills/omega',
            } } } }),
        makeRecord({ name: 'proj', scope: 'project', source: 'central', dirPath: '/work/app/.skills/pf/proj',
            skillFilePath: '/work/app/.skills/pf/proj/SKILL.md', folder: 'pf',
            central: { dirPath: '/work/app/.skills/pf/proj', links: { project: { kimi: '/work/app/.kimi/skills/proj' } } } }),
        makeRecord(), // unmanaged kimi record, folder ''
    ], { hasWorkspace: true });
    // nested folder nodes with paths + store root + per-agent dropdowns
    assert.ok(tree.includes('data-skill-folder="superpowers"'));
    assert.ok(tree.includes('data-skill-folder="superpowers/nested"'));
    assert.ok(tree.includes('data-skill-folder="other"'));
    assert.ok(tree.includes('data-skill-store="/home/dev/.skills"'));
    assert.ok(tree.indexOf('data-skill-folder="superpowers"') < tree.indexOf('data-skill-folder="superpowers/nested"'),
        'parent folders render before children');
    // folder ⋯ menu button carries per-agent states + scope per section
    const superpowersHeader = folderHeader(tree, 'superpowers');
    assert.ok(superpowersHeader.includes('data-folder-menu="superpowers"'), 'folder has a ⋯ menu button');
    assert.ok(superpowersHeader.includes('data-folder-scope="user"'), 'global-section folder posts user scope');
    assert.ok(superpowersHeader.includes('skill-agent-dots'), 'folder header shows per-agent state dots');
    assert.ok(superpowersHeader.includes('skill-agent-dot indeterminate') && (superpowersHeader.match(/skill-agent-dot off/g) || []).length === 2,
        'folder dots show indeterminate kimi with claude and codex off');
    assert.ok(superpowersHeader.includes('data-state-kimi="indeterminate"'), 'kimi is indeterminate on a partially linked folder');
    assert.ok(superpowersHeader.includes('data-state-claude="off"') && superpowersHeader.includes('data-state-codex="off"'),
        'claude and codex are off');
    const otherHeader = folderHeader(tree, 'other');
    assert.ok(otherHeader.includes('data-state-kimi="off"'), 'unlinked folder is off');
    assert.ok(!otherHeader.includes('indeterminate'), 'unlinked folder has no indeterminate agent');
    const linkedHeader = folderHeader(tree, 'linked');
    assert.ok(linkedHeader.includes('data-state-kimi="on"') && linkedHeader.includes('data-state-claude="on"')
        && linkedHeader.includes('data-state-codex="on"'), 'fully linked folder has every agent on');
    const projectFolderHeader = folderHeader(tree, 'pf');
    assert.ok(projectFolderHeader.includes('data-folder-scope="project"'), 'project-section folder posts project scope');
    assert.ok(!tree.includes('data-folder-agents-toggle'), 'old dropdown trigger removed');
    assert.ok(!tree.includes('skill-folder-agents'), 'static agents panel removed');
    // no scope selector anywhere (scope is positional now); no dual-scope attrs; no P badge
    assert.ok(!tree.includes('data-skill-scope-select'), 'scope selector removed');
    assert.ok(!tree.includes('data-link-user'), 'dual-scope link attrs removed');
    assert.ok(!tree.includes('data-vis-user'), 'dual-scope visibility attrs removed');
    assert.ok(!tree.includes('skill-chip project-linked'), 'P badge removed');
    // empty folders render as nodes (badge 0, all chips unlit, delete action present)
    const emptyTree = skillContent.getSkillsPanelContent([], {
        hasWorkspace: true,
        storeRoots: { user: '/home/dev/.skills' },
        storeFolders: { user: ['newpack', 'newpack/nested'] },
    });
    // empty panel short-circuits on zero records → use one central record to force the tree
    const emptyTree2 = skillContent.getSkillsPanelContent([makeRecord({
        name: 'solo', source: 'central', dirPath: '/home/dev/.skills/solo',
        skillFilePath: '/home/dev/.skills/solo/SKILL.md',
        central: { dirPath: '/home/dev/.skills/solo', links: {} },
    })], {
        hasWorkspace: true,
        storeRoots: { user: '/home/dev/.skills' },
        storeFolders: { user: ['newpack', 'newpack/nested'] },
    });
    assert.ok(emptyTree2.includes('data-skill-folder="newpack"'), 'empty folder renders as a node');
    assert.ok(emptyTree2.includes('data-skill-folder="newpack/nested"'), 'empty nested folder renders');
    const newpackHeader = folderHeader(emptyTree2, 'newpack');
    assert.ok(newpackHeader.includes('<span class="group-title-badge">0</span>'), 'empty folder shows a zero count');
    assert.ok(newpackHeader.includes('data-folder-menu="newpack"'), 'empty folder offers the ⋯ menu (delete lives inside)');
    assert.ok(emptyTree.includes('data-skill-folder="newpack"'), 'empty store with folders still renders the tree');
    const noFolderTree = skillContent.getSkillsPanelContent([], {});
    assert.ok(noFolderTree.includes('skills-empty'), 'zero records and zero folders renders the empty hint');
    // unmanaged section holds the plain record
    assert.ok(tree.includes('skill-unmanaged'));
    // every unmanaged record renders in the list — there is no parked/disabled state
    const dupTree = skillContent.getSkillsPanelContent([
        makeRecord({ name: 'alpha', source: 'central', dirPath: '/home/dev/.skills/alpha',
            skillFilePath: '/home/dev/.skills/alpha/SKILL.md',
            central: { dirPath: '/home/dev/.skills/alpha', links: {} } }),
        makeRecord({ name: 'alpha', source: 'codex', dirPath: '/home/dev/.codex/skills/alpha',
            skillFilePath: '/home/dev/.codex/skills/alpha/SKILL.md',
            visibility: { kimi: 'absent', claude: 'absent', codex: 'active' } }),
        makeRecord({ name: 'loose', source: 'codex', dirPath: '/home/dev/.codex/skills/loose',
            skillFilePath: '/home/dev/.codex/skills/loose/SKILL.md',
            visibility: { kimi: 'absent', claude: 'absent', codex: 'active' } }),
    ]);
    assert.ok(!dupTree.includes('data-skill-parked-toggle'), 'parked disclosure retired');
    assert.ok(!dupTree.includes('skill-parked-duplicates'), 'parked panel styles retired from markup');
    assert.ok(dupTree.includes('data-skill-dir="/home/dev/.codex/skills/alpha"'),
        'unmanaged duplicate of a central skill stays visible');
    assert.ok(dupTree.includes('data-skill-dir="/home/dev/.codex/skills/loose"'),
        'plain unmanaged record stays visible');
    // move editor present, old group editor gone
    assert.ok(tree.includes('data-skill-move-folder='));
    assert.ok(!tree.includes('data-skill-group-input'), 'virtual group editor removed');
    assert.ok(!tree.includes('data-skill-collection='), 'virtual collections removed');
    // name+agent link collisions: controller computes, cards show the conflict chip
    const collisionRecords = [
        makeRecord({ name: 'dup', source: 'central', dirPath: '/home/dev/.skills/f1/dup', folder: 'f1',
            central: { dirPath: '/home/dev/.skills/f1/dup', links: { user: { kimi: '/home/dev/.kimi/skills/dup' } } } }),
        makeRecord({ name: 'dup', source: 'central', dirPath: '/home/dev/.skills/f2/dup', folder: 'f2',
            central: { dirPath: '/home/dev/.skills/f2/dup', links: { user: { kimi: '/home/dev/.kimi/skills/dup' } } } }),
    ];
    const collisions = computeSkillLinkConflicts(collisionRecords);
    assert.ok(collisions.has('/home/dev/.skills/f1/dup') && collisions.has('/home/dev/.skills/f2/dup'),
        'same-name central records linking the same agent+scope collide');
    assert.strictEqual(computeSkillLinkConflicts([collisionRecords[0]]).size, 0, 'a single record never collides');
    const collisionHtml = skillContent.getSkillsPanelContent(collisionRecords, { conflicts: collisions });
    assert.strictEqual(collisionHtml.split('⚠ name conflict').length - 1, 2, 'both colliding cards show the conflict chip');
}

function runSkillStyleChecks() {
    const styles = fs.readFileSync(path.join(__dirname, '..', 'media', 'styles.scss'), 'utf8');
    const compiled = fs.readFileSync(path.join(__dirname, '..', 'media', 'styles.css'), 'utf8');
    assert.ok(styles.includes('.skill-card'));
    assert.ok(styles.includes('body.steward-sidebar .skill-card'));
    assert.ok(styles.includes('.skill-delete'), 'delete button styles');
    assert.ok(!styles.includes('.skill-parked'), 'parked styles retired');
    assert.ok(!styles.includes('.skill-card-disabled'), 'disabled card styles retired');
    assert.ok(styles.includes('.skill-chip'));
    assert.ok(styles.includes('.skill-detail'));
    assert.ok(styles.includes('.skill-source-header'));
    assert.ok(styles.includes('.skill-filter-hidden'));
    assert.ok(styles.includes('.skill-drop-target'));
    assert.ok(styles.includes('.skill-folder'), 'folder node styles');
    assert.ok(styles.includes('.skill-folder-more'), 'folder ⋯ button styles');
    assert.ok(styles.includes('.skill-ios-toggle.indeterminate'), 'indeterminate switch styles');
    assert.ok(styles.includes('.skill-folder-menu-item'), 'folder menu item styles');
    assert.ok(styles.includes('.skill-unmanaged'), 'unmanaged section styles');
    assert.ok(compiled.includes('.skill-folder'));
    assert.ok(compiled.includes('.skill-folder-more'));
    assert.ok(compiled.includes('.skill-folder-menu-item'));
    assert.ok(compiled.includes('.skill-delete'));
    assert.ok(!compiled.includes('.skill-parked-duplicates'));
    assert.ok(compiled.includes('.skills-groups-wrapper .skill-card'), 'compact card rhythm');
    assert.ok(compiled.includes('.skills-groups-wrapper .group'), 'compact tree node rhythm');
    assert.ok(compiled.includes('.skill-ios-toggle.indeterminate'));
    assert.ok(compiled.includes('.skill-unmanaged'));
    assert.ok(compiled.includes('.skill-chip'));
    assert.ok(compiled.includes('.skill-source-header'));
    assert.ok(compiled.includes('.skill-filter-hidden'));
    assert.ok(compiled.includes('.skill-drop-target'));
    assert.ok(!styles.includes('color-mix('));
}

function runSkillWebviewScriptChecks() {
    const script = fs.readFileSync(path.join(__dirname, '..', 'media', 'webviewDashboardScripts.js'), 'utf8');
    assert.ok(script.includes('#ai-panel-skills .sticky-groups-wrapper'), 'skills-updated targets the AI subtab');
    assert.ok(!script.includes('dashboard-tab-skills'), 'no top-level skills panel remains');
    assert.ok(script.includes('data-skill-filter'), 'agent filter wiring present');
    assert.ok(script.includes('data-skill-agents'), 'agent filter matches card attributes');
    assert.ok(script.includes('skill-filter-hidden'), 'filter hides via class (hidden attr cannot beat author display rules)');
    assert.ok(script.includes('captureSkillCollapsedGroups'), 'collapse state preserved across skills-updated replacement');
    assert.ok(script.includes('restoreSkillCollapsedGroups'));
    assert.ok(!script.includes('data-skill-scope-select'), 'scope selector wiring removed');
    assert.ok(script.includes('data-folder-menu'), 'folder ⋯ menu wiring present');
    assert.ok(script.includes('openSkillFolderMenu'));
    assert.ok(script.includes('closeSkillFolderMenu'));
    assert.ok(script.includes('data-folder-agent'), 'per-agent folder switch wiring present');
    assert.ok(script.includes("'folder-toggle-skill-links'"), 'folder batch wiring present');
    assert.ok(script.includes("'move-skill-to-folder'"), 'move wiring present');
    assert.ok(script.includes('data-skill-move-folder'), 'move editor wiring present');
    assert.ok(script.includes('onSkillDragStart'), 'drag-into-folder wiring present');
    assert.ok(script.includes('findSkillDropFolder'));
    assert.ok(script.includes('skill-drop-target'));
    assert.ok(!script.includes("'set-skill-group'"), 'virtual group wiring removed');
    assert.ok(!script.includes('data-skill-collection'), 'collection drop wiring removed');
    assert.ok(script.includes("'fix-skill-diagnostic'"), 'fix wiring present');
    assert.ok(script.includes("'apply-skill-collection'"), 'collection suggestion wiring present');
    assert.ok(script.includes("'dismiss-skill-collection'"));
    assert.ok(script.includes("'delete-skill'"), 'delete wiring present');
    assert.ok(!script.includes("'toggle-skill'"), 'toggle wiring retired');
    assert.ok(script.includes("'open-skill-file'"));
    assert.ok(script.includes("'skills-updated'"));
    assert.ok(script.includes('data-skill-delete'));
    assert.ok(!script.includes('data-skill-toggle'), 'toggle markup wiring retired');
    assert.ok(!script.includes('data-skill-parked-toggle'), 'parked disclosure wiring retired');
    assert.ok(script.includes('skill-detail-open'), 'card click expands the detail panel');
}

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
    const result = controller.handleDeleteSkill(skillDir);
    assert.strictEqual(result.ok, true);
    assert.ok(!fs.existsSync(skillDir), 'delete removes the skill directory');
    assert.ok(!controller.getRecords().some(record => record.name === 'alpha'),
        'deleted skill leaves the scan after refresh');

    // Path containment: delete must refuse unknown and out-of-scan paths.
    const unknownDelete = controller.handleDeleteSkill(path.join(os.tmpdir(), 'not-a-skill-dir', 'x'));
    assert.strictEqual(unknownDelete.ok, false, 'unknown skill is refused');
    const missingDelete = controller.handleDeleteSkill(path.join(home, '.kimi', 'skills', 'missing'));
    assert.strictEqual(missingDelete.ok, false, 'path not in the scan is refused');

    // A root entry that symlinks to a directory outside the known roots resolves
    // into the scan, but its realpath fails the direct-child check: delete is
    // refused and the outside directory is never touched.
    const outsideDir = path.join(home, 'outside-skill');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'SKILL.md'), '---\nname: outside\ndescription: x\n---\n');
    const outsideReal = fs.realpathSync(outsideDir);
    fs.symlinkSync(outsideDir, path.join(home, '.claude', 'skills', 'alias'), 'dir');
    controller.start();
    const aliasRecord = controller.getRecords().find(record => record.dirPath === outsideReal);
    assert.ok(aliasRecord, 'symlinked entry resolves into the scan');
    const symlinkDelete = controller.handleDeleteSkill(outsideReal);
    assert.strictEqual(symlinkDelete.ok, false, 'delete of a symlink-resolved skill is refused');
    assert.ok(fs.existsSync(path.join(outsideDir, 'SKILL.md')), 'outside directory untouched');

    controller.dispose();
}

function runSkillWiringChecks() {
    const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.ts'), 'utf8');
    assert.ok(dashboard.includes('new SkillDashboardController('));
    assert.ok(dashboard.includes("'delete-skill'"));
    assert.ok(!dashboard.includes("'toggle-skill'"), 'toggle message retired');
    assert.ok(dashboard.includes('permanently? This cannot be undone.'), 'delete confirmation modal wired');
    assert.ok(dashboard.includes("'open-skill-file'"));
    assert.ok(!dashboard.includes("'set-skill-group'"), 'virtual group messages removed');
    assert.ok(!dashboard.includes("'toggle-skill-group'"));
    assert.ok(dashboard.includes("'fix-skill-diagnostic'"));
    assert.ok(dashboard.includes("'apply-skill-collection'"));
    assert.ok(dashboard.includes("'dismiss-skill-collection'"));
    assert.ok(dashboard.includes('skillDashboardController.getRecords()'));
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert.ok(packageJson.scripts['test:skills'].includes('run-skill-management-checks.js'));
    // test:safety delegates to test:safety:run, which owns the check-script chain.
    assert.ok(packageJson.scripts['test:safety:run'].includes('run-skill-management-checks.js'));
}

runFrontmatterChecks();
runRootsChecks();
runDiscoveryChecks();
runEffectivenessChecks();
runSkillRenderingChecks();
runSkillStyleChecks();
runSkillWebviewScriptChecks();
runSkillControllerChecks();
runSkillWiringChecks();
runSkillFixChecks();
runSkillCollectionChecks();
runSkillSearchCatalogChecks();
runSkillSyncChecks();
runSkillCentralChecks();
runSkillMigrationChecks();
runSkillFolderDiscoveryChecks();
runSkillFolderServiceChecks();
runSkillFolderControllerChecks();
runSkillFolderMutationChecks();
console.log('Skill management checks passed.');

function runSkillFixChecks() {
    const fixService = require('../out/skills/fixService');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-fix-'));
    const write = (rel, content) => {
        const filePath = path.join(home, rel);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
        return filePath;
    };
    const record = (overrides) => makeRecord({
        name: 'demo',
        dirPath: path.join(home, '.kimi', 'skills', 'demo'),
        ...overrides,
    });

    // lowercase-filename → rename to SKILL.md
    const lower = write('.kimi/skills/demo/skill.md', '---\nname: demo\n---\nbody\n');
    const lowerResult = fixService.fixSkillDiagnostic(
        record({ skillFilePath: lower }), 'lowercase-filename');
    assert.strictEqual(lowerResult.ok, true);
    assert.ok(fs.existsSync(path.join(home, '.kimi/skills/demo/SKILL.md')));
    const conflict = fixService.fixSkillDiagnostic(record({ skillFilePath: lower }), 'lowercase-filename');
    assert.strictEqual(conflict.ok, false, 'never overwrite an existing SKILL.md');

    // name-mismatch → frontmatter name becomes the directory name
    const mismatch = write('.kimi/skills/demo2/SKILL.md', '---\nname: wrong\ndescription: keep me\n---\nbody\n');
    const mismatchResult = fixService.fixSkillDiagnostic(
        record({ name: 'demo2', dirPath: path.join(home, '.kimi', 'skills', 'demo2'), skillFilePath: mismatch }),
        'name-mismatch');
    assert.strictEqual(mismatchResult.ok, true);
    const fixed = fs.readFileSync(mismatch, 'utf8');
    assert.ok(fixed.includes('name: demo2'));
    assert.ok(fixed.includes('description: keep me'), 'other frontmatter fields are preserved');

    // missing-frontmatter → skeleton prepended
    const bare = write('.kimi/skills/demo3/SKILL.md', '# Just a body\n');
    assert.strictEqual(fixService.fixSkillDiagnostic(
        record({ name: 'demo3', dirPath: path.join(home, '.kimi', 'skills', 'demo3'), skillFilePath: bare }),
        'missing-frontmatter').ok, true);
    const skeleton = fs.readFileSync(bare, 'utf8');
    assert.ok(skeleton.startsWith('---\nname: demo3\ndescription: \n---\n\n# Just a body\n'));

    // missing-name → name inserted into existing frontmatter
    const noName = write('.kimi/skills/demo4/SKILL.md', '---\ndescription: x\n---\nbody\n');
    assert.strictEqual(fixService.fixSkillDiagnostic(
        record({ name: 'demo4', dirPath: path.join(home, '.kimi', 'skills', 'demo4'), skillFilePath: noName }),
        'missing-name').ok, true);
    assert.ok(fs.readFileSync(noName, 'utf8').startsWith('---\nname: demo4\ndescription: x\n---\n'));

    // non-fixable code → refusal, no throw
    assert.strictEqual(fixService.fixSkillDiagnostic(record(), 'body-too-long').ok, false);
}

function runSkillSearchCatalogChecks() {
    const viewModel = require('../out/webview/dashboardViewModel');
    const catalog = viewModel.buildWorkspaceDashboardSearchCatalog(
        [], [], [],
        [makeRecord(), makeRecord({
            name: 'beta', description: 'Gamma knife', scope: 'project', source: 'claude',
            dirPath: '/work/app/.claude/skills/beta',
        })],
    );
    assert.strictEqual(catalog.skills.length, 2, 'skills enter the search catalog');
    assert.strictEqual(catalog.skills[0].action, 'reveal-skill');
    assert.ok(catalog.skills[0].searchText.includes('demo'));
    assert.ok(catalog.skills[1].searchText.includes('gamma knife'));
    assert.strictEqual(catalog.skills[1].scope, 'project');
    assert.strictEqual((viewModel.buildWorkspaceDashboardSearchCatalog([], [], []).skills || []).length, 0,
        'skills key is omitted when empty (keeps the catalog shape stable)');

    const script = fs.readFileSync(path.join(__dirname, '..', 'media', 'webviewDashboardScripts.js'), 'utf8');
    assert.ok(script.includes("'reveal-skill'"));
    assert.ok(script.includes("type: 'skill'"));
    assert.ok(script.includes('revealSkillCard'));
}

function runSkillSyncChecks() {
    const syncService = require('../out/skills/syncService');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-sync-'));
    const write = (rel, content) => {
        const filePath = path.join(home, rel);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
        return filePath;
    };

    // fingerprints
    write('.kimi/skills/demo/SKILL.md', '---\nname: demo\n---\nA\n');
    write('.kimi/skills/demo/references/r.md', 'ref\n');
    write('.codex/skills/demo/SKILL.md', '---\nname: demo\n---\nA\n');
    write('.codex/skills/demo/references/r.md', 'ref\n');
    const hashA = syncService.hashSkillDirectory(path.join(home, '.kimi', 'skills', 'demo'));
    const hashB = syncService.hashSkillDirectory(path.join(home, '.codex', 'skills', 'demo'));
    assert.strictEqual(hashA, hashB, 'identical trees fingerprint identically');
    write('.codex/skills/demo/references/r.md', 'ref changed\n');
    assert.notStrictEqual(syncService.hashSkillDirectory(path.join(home, '.codex', 'skills', 'demo')), hashA,
        'any content change changes the fingerprint');

    // duplicates + drift via real scan
    write('.claude/skills/demo/SKILL.md', '---\nname: demo\n---\ndifferent\n');
    const records = discovery.scanSkills({ homeDir: home });
    const duplicates = syncService.computeSkillDuplicates(records);
    const group = duplicates.get('user:demo');
    assert.ok(group, 'same-name copies form a duplicate group');
    assert.strictEqual(group.copies.length, 3);
    assert.strictEqual(group.drift, true, 'differing copies drift');
    write('.claude/skills/demo/SKILL.md', '---\nname: demo\n---\nA\n');
    write('.claude/skills/demo/references/r.md', 'ref\n');
    write('.codex/skills/demo/references/r.md', 'ref\n');
    const synced = syncService.computeSkillDuplicates(discovery.scanSkills({ homeDir: home }));
    assert.strictEqual(synced.get('user:demo').drift, false, 'identical copies do not drift');

    // copy targets: only brand roots missing the name, agents excluded
    const copyTargets = syncService.computeSkillCopyTargets(
        discovery.scanSkills({ homeDir: home }), home);
    const demoTargets = copyTargets.get(path.join(home, '.kimi', 'skills', 'demo')) || [];
    assert.strictEqual(demoTargets.length, 0, 'all brand roots already hold demo');

    // sync: source wins, loser deleted (no .disabled parking anywhere)
    write('.kimi/skills/sync-me/SKILL.md', '---\nname: sync-me\n---\nGOOD\n');
    write('.codex/skills/sync-me/SKILL.md', '---\nname: sync-me\n---\nSTALE\n');
    const syncResult = syncService.syncSkillDir(
        path.join(home, '.kimi', 'skills', 'sync-me'),
        path.join(home, '.codex', 'skills', 'sync-me'));
    assert.strictEqual(syncResult.ok, true);
    assert.ok(fs.readFileSync(path.join(home, '.codex', 'skills', 'sync-me', 'SKILL.md'), 'utf8').includes('GOOD'));
    assert.ok(!fs.existsSync(path.join(home, '.codex', 'skills', '.disabled')),
        'losing copy is deleted, never parked');
    const leftovers = fs.readdirSync(os.tmpdir()).filter(entry => entry.startsWith('agent-pivot-skill-sync-'));
    assert.deepStrictEqual(leftovers, [], 'sync temp aside is cleaned up');

    // copy: J6 into another root, never overwriting
    const copyResult = syncService.copySkillDir(
        path.join(home, '.kimi', 'skills', 'demo'),
        path.join(home, '.claude', 'skills'));
    assert.strictEqual(copyResult.ok, false, 'existing destination is never overwritten');
    const copyFresh = syncService.copySkillDir(
        path.join(home, '.kimi', 'skills', 'sync-me'),
        path.join(home, '.claude', 'skills'));
    assert.strictEqual(copyFresh.ok, true);
    assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'sync-me', 'SKILL.md')));

    // controller containment + behavior
    const controller = new SkillDashboardController({
        getHomeDir: () => home,
        getWorkspaceRoot: () => undefined,
        postMessage: () => Promise.resolve(true),
        isVisible: () => true,
        logError: () => undefined,
    });
    controller.start();
    assert.strictEqual(controller.handleSyncSkill(path.join(home, '.kimi', 'skills', 'demo'), '/etc/passwd').ok, false,
        'sync target must be a discovered record');
    assert.strictEqual(controller.handleCopySkill('/etc', path.join(home, '.claude', 'skills')).ok, false,
        'copy source must be a discovered record');
    assert.strictEqual(controller.handleCopySkill(path.join(home, '.kimi', 'skills', 'demo'), '/tmp/nope').ok, false,
        'copy destination must be a known skills root');
    controller.dispose();

    // rendering: drift chip + sync button + copy-to row
    const driftHtml = skillContent.getSkillsPanelContent([
        makeRecord({ contentHash: 'aaaaaaaaaaaaaaaa' }),
        makeRecord({
            name: 'demo', source: 'codex', dirPath: '/home/dev/.codex/skills/demo',
            skillFilePath: '/home/dev/.codex/skills/demo/SKILL.md', contentHash: 'bbbbbbbbbbbbbbbb',
            visibility: { kimi: 'absent', claude: 'absent', codex: 'active' },
        }),
    ]);
    assert.ok(driftHtml.includes('⚠ drift'), 'differing copies get a drift chip');
    assert.ok(driftHtml.includes('data-skill-sync="/home/dev/.codex/skills/demo"'), 'sync action renders');
    assert.ok(driftHtml.includes('#aaaaaaa'), 'copies list short fingerprints');
    const noDriftHtml = skillContent.getSkillsPanelContent([
        makeRecord({ contentHash: 'aaaaaaaaaaaaaaaa' }),
        makeRecord({
            name: 'demo', source: 'codex', dirPath: '/home/dev/.codex/skills/demo',
            skillFilePath: '/home/dev/.codex/skills/demo/SKILL.md', contentHash: 'aaaaaaaaaaaaaaaa',
            visibility: { kimi: 'absent', claude: 'absent', codex: 'active' },
        }),
    ]);
    assert.ok(!noDriftHtml.includes('⚠ drift'), 'identical copies show no drift chip');
    const copyHtml = skillContent.getSkillsPanelContent(
        [makeRecord()],
        { copyTargets: new Map([['/home/dev/.kimi/skills/demo', [{ rootDir: '/home/dev/.codex/skills', source: 'codex', scope: 'user' }]]]) },
    );
    assert.ok(copyHtml.includes('data-skill-copy-root="/home/dev/.codex/skills"'), 'copy-to action renders');
}

function runSkillCentralChecks() {
    const centralService = require('../out/skills/centralService');
    const real = dirPath => fs.realpathSync(dirPath);
    const makeCentralFixture = () => {
        const home = real(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-central-')));
        const ws = real(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-central-ws-')));
        const write = (filePath, content) => {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, content);
        };
        write(path.join(home, '.skills/shared/SKILL.md'), '---\nname: shared\ndescription: Shared skill\n---\n# S\n');
        fs.mkdirSync(path.join(home, '.kimi/skills'), { recursive: true });
        fs.mkdirSync(path.join(home, '.codex/skills'), { recursive: true });
        fs.symlinkSync(path.join(home, '.skills/shared'), path.join(home, '.kimi/skills/shared'), 'dir');
        fs.symlinkSync(path.join(home, '.skills/shared'), path.join(home, '.codex/skills/shared'), 'dir');
        write(path.join(home, '.claude/skills/solo/SKILL.md'), '---\nname: solo\ndescription: Solo\n---\n');
        write(path.join(home, '.codex/skills/solo/SKILL.md'), '---\nname: solo\ndescription: Solo\n---\n');
        write(path.join(ws, '.skills/proj/SKILL.md'), '---\nname: proj\ndescription: Project skill\n---\n');
        fs.mkdirSync(path.join(ws, '.claude/skills'), { recursive: true });
        fs.symlinkSync(path.join(ws, '.skills/proj'), path.join(ws, '.claude/skills/proj'), 'dir');
        return { home, ws };
    };

    // discovery: symlinks into the central store merge into a single central record
    const { home, ws } = makeCentralFixture();
    const scanned = discovery.scanSkills({ homeDir: home, workspaceRoot: ws });
    const sharedCopies = scanned.filter(record => record.name === 'shared');
    assert.strictEqual(sharedCopies.length, 1, 'agent links merge into one central record');
    const shared = sharedCopies[0];
    assert.strictEqual(shared.source, 'central');
    assert.strictEqual(shared.scope, 'user');
    assert.strictEqual(shared.dirPath, path.join(home, '.skills', 'shared'));
    assert.deepStrictEqual(shared.central, {
        dirPath: path.join(home, '.skills', 'shared'),
        links: {
            user: {
                kimi: path.join(home, '.kimi', 'skills', 'shared'),
                codex: path.join(home, '.codex', 'skills', 'shared'),
            },
        },
    });
    // effectiveness: linked agents are active; kimi follows the link under its winning brand dir
    assert.deepStrictEqual(shared.visibility, { kimi: 'active', claude: 'absent', codex: 'active' });
    const proj = scanned.find(record => record.name === 'proj');
    assert.strictEqual(proj.source, 'central');
    assert.strictEqual(proj.scope, 'project', 'project central store scopes correctly');
    assert.deepStrictEqual(proj.central.links, { project: { claude: path.join(ws, '.claude', 'skills', 'proj') } });
    assert.deepStrictEqual(proj.visibility, { kimi: 'active', claude: 'active', codex: 'absent' });

    // effectiveness: linked only outside the winning brand dir → kimi shadowed
    const shadowHome = real(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-central-shadow-')));
    fs.mkdirSync(path.join(shadowHome, '.kimi/skills'), { recursive: true });
    fs.mkdirSync(path.join(shadowHome, '.codex/skills'), { recursive: true });
    fs.mkdirSync(path.join(shadowHome, '.skills/x'), { recursive: true });
    fs.writeFileSync(path.join(shadowHome, '.skills/x/SKILL.md'), '---\nname: x\ndescription: X\n---\n');
    fs.symlinkSync(path.join(shadowHome, '.skills/x'), path.join(shadowHome, '.codex/skills/x'), 'dir');
    const x = discovery.scanSkills({ homeDir: shadowHome }).find(record => record.name === 'x');
    assert.strictEqual(x.visibility.kimi, 'shadowed', 'link outside the winning brand dir shadows kimi');
    assert.strictEqual(x.shadowedBy.kimi, path.join(shadowHome, '.kimi', 'skills'));
    assert.strictEqual(x.visibility.codex, 'active');

    // setCentralLink: create / idempotent / refuse real dirs / remove
    const linkHome = real(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-link-')));
    const centralDir = path.join(linkHome, '.skills', 'tool');
    fs.mkdirSync(centralDir, { recursive: true });
    fs.writeFileSync(path.join(centralDir, 'SKILL.md'), '---\nname: tool\ndescription: T\n---\n');
    const kimiRoot = path.join(linkHome, '.kimi', 'skills');
    const linkPath = path.join(kimiRoot, 'tool');
    assert.strictEqual(centralService.setCentralLink(centralDir, kimiRoot, true).ok, true, 'creates the agent link');
    assert.ok(fs.lstatSync(linkPath).isSymbolicLink());
    assert.strictEqual(fs.realpathSync(linkPath), centralDir);
    assert.strictEqual(centralService.setCentralLink(centralDir, kimiRoot, true).ok, true, 're-link is idempotent');
    assert.strictEqual(centralService.setCentralLink(centralDir, kimiRoot, false).ok, true, 'removes the agent link');
    assert.ok(!fs.existsSync(linkPath));
    assert.strictEqual(centralService.setCentralLink(centralDir, kimiRoot, false).ok, true, 're-remove is idempotent');
    assert.ok(fs.existsSync(path.join(centralDir, 'SKILL.md')), 'link removal never touches the store');
    fs.mkdirSync(linkPath, { recursive: true });
    assert.strictEqual(centralService.setCentralLink(centralDir, kimiRoot, true).ok, false, 'never replaces a real directory');
    assert.strictEqual(centralService.setCentralLink(centralDir, kimiRoot, false).ok, false, 'never deletes a real directory');
    assert.ok(fs.lstatSync(linkPath).isDirectory());

    // centralizeSkill: winner moves into the store, links back, losers deleted
    const beforeCentralize = discovery.scanSkills({ homeDir: home, workspaceRoot: ws });
    const claudSolo = beforeCentralize.find(record => record.name === 'solo' && record.source === 'claude');
    const soloDuplicates = beforeCentralize.filter(record =>
        record.scope === claudSolo.scope && record.name === claudSolo.name && record.dirPath !== claudSolo.dirPath);
    const centralized = centralService.centralizeSkill(claudSolo, soloDuplicates, home, ws);
    assert.strictEqual(centralized.ok, true);
    assert.strictEqual(centralized.dirPath, path.join(home, '.skills', 'solo'));
    assert.ok(fs.existsSync(path.join(home, '.skills', 'solo', 'SKILL.md')), 'skill content moved into the store');
    assert.ok(fs.lstatSync(path.join(home, '.claude', 'skills', 'solo')).isSymbolicLink(), 'original root links back');
    assert.strictEqual(fs.realpathSync(path.join(home, '.claude', 'skills', 'solo')), path.join(home, '.skills', 'solo'));
    assert.ok(!fs.existsSync(path.join(home, '.codex', 'skills', 'solo')), 'losing copy left its root');
    assert.ok(!fs.existsSync(path.join(home, '.codex', 'skills', '.disabled')),
        'losing copy is deleted, never parked');
    const rescanned = discovery.scanSkills({ homeDir: home, workspaceRoot: ws });
    const soloRecords = rescanned.filter(record => record.name === 'solo');
    assert.strictEqual(soloRecords.length, 1, 'centralized skill merges into one record');
    assert.strictEqual(soloRecords[0].source, 'central');
    assert.deepStrictEqual(soloRecords[0].central.links, { user: { claude: path.join(home, '.claude', 'skills', 'solo') } });
    assert.strictEqual(centralService.centralizeSkill(soloRecords[0], [], home, ws).ok, false, 'already centralized is refused');

    // controller: per-agent link toggle refreshes records; bogus inputs refused
    const controller = new SkillDashboardController({
        getHomeDir: () => home,
        getWorkspaceRoot: () => ws,
        postMessage: () => Promise.resolve(true),
        isVisible: () => true,
        logError: () => undefined,
    });
    controller.start();
    const sharedDir = path.join(home, '.skills', 'shared');
    // enabled === false → the link does not exist yet → create it
    assert.strictEqual(controller.handleCentralToggle(sharedDir, 'user', 'claude', false).ok, true);
    assert.ok(fs.lstatSync(path.join(home, '.claude', 'skills', 'shared')).isSymbolicLink());
    assert.strictEqual(
        controller.getRecords().find(record => record.name === 'shared').central.links.user?.claude,
        path.join(home, '.claude', 'skills', 'shared'),
        'refresh picks up the new link');
    // enabled === true → the link exists → remove it
    assert.strictEqual(controller.handleCentralToggle(sharedDir, 'user', 'claude', true).ok, true);
    assert.ok(!fs.existsSync(path.join(home, '.claude', 'skills', 'shared')));
    assert.strictEqual(controller.handleCentralToggle('/nope', 'user', 'claude', false).ok, false, 'unknown skill refused');
    assert.strictEqual(controller.handleCentralToggle(sharedDir, 'user', 'agents', false).ok, false, 'agents root is not a link target');
    assert.strictEqual(controller.handleCentralToggle(sharedDir, 'user', 'central', false).ok, false, 'central source is not a link target');
    controller.dispose();

    // controller: centralize moves the skill and refreshes into a central record
    const { home: home2, ws: ws2 } = makeCentralFixture();
    const controller2 = new SkillDashboardController({
        getHomeDir: () => home2,
        getWorkspaceRoot: () => ws2,
        postMessage: () => Promise.resolve(true),
        isVisible: () => true,
        logError: () => undefined,
    });
    controller2.start();
    const soloDir = path.join(home2, '.claude', 'skills', 'solo');
    assert.strictEqual(controller2.handleCentralize(soloDir).ok, true);
    assert.strictEqual(controller2.getRecords().find(record => record.name === 'solo').source, 'central');
    assert.strictEqual(controller2.handleCentralize(soloDir).ok, false, 'already-central skill is refused');
    assert.strictEqual(controller2.handleCentralize('/nope').ok, false, 'unknown skill refused');
    controller2.dispose();

    // rendering: central chip, per-agent link switches, centralize action only on plain skills
    const centralRecord = makeRecord({
        name: 'shared', source: 'central',
        dirPath: '/home/dev/.skills/shared', skillFilePath: '/home/dev/.skills/shared/SKILL.md',
        visibility: { kimi: 'active', claude: 'absent', codex: 'active' },
        central: { dirPath: '/home/dev/.skills/shared', links: { user: { kimi: '/home/dev/.kimi/skills/shared', codex: '/home/dev/.codex/skills/shared' } } },
    });
    const centralHtml = skillContent.getSkillsPanelContent([centralRecord, makeRecord()]);
    assert.ok(!centralHtml.includes('skill-chip central'), 'central chip retired on cards');
    assert.ok(centralHtml.includes('skill-agent-dots'), 'central cards show agent dots');
    assert.ok(!centralHtml.includes('data-skill-source="central"'), 'central records no longer render in source groups');
    assert.ok(centralHtml.indexOf('data-skill-dir="/home/dev/.skills/shared"') < centralHtml.indexOf('skill-unmanaged'),
        'root-level central cards render directly under the scope section, before unmanaged');
    assert.ok(centralHtml.includes('data-skill-move-folder="/home/dev/.skills/shared"'), 'central detail shows the move editor');
    assert.ok(!centralHtml.includes('data-skill-group-input'), 'virtual group editor removed');
    assert.ok(!centralHtml.includes('Linked agents'), 'no separate link section remains');
    assert.strictEqual(centralHtml.split('class="skill-agent-row"').length - 1, 3, 'one iOS-style row per agent');
    assert.strictEqual(centralHtml.split('data-central-source=').length - 1, 3, 'one switch per agent');
    assert.ok(centralHtml.includes('data-central-toggle="/home/dev/.skills/shared"'));
    assert.ok(centralHtml.includes('data-central-source="kimi"'));
    assert.ok(centralHtml.includes('data-central-source="claude"'));
    assert.ok(centralHtml.includes('class="skill-ios-toggle off"'), 'unlinked agents render an off switch');
    assert.ok(centralHtml.includes('Disable for kimi (/home/dev/.kimi/skills/shared)'), 'link path moves into the tooltip');
    assert.ok(centralHtml.includes('Enable for claude'));
    assert.ok(!centralHtml.includes('not linked'), 'no per-agent path rows remain');
    assert.ok(!centralHtml.includes('data-skill-delete="/home/dev/.skills/shared"'), 'central cards hide the Delete action');
    assert.ok(!centralHtml.includes('data-skill-centralize="/home/dev/.skills/shared"'), 'central cards are not re-centralizable');
    assert.ok(centralHtml.includes('data-skill-centralize="/home/dev/.kimi/skills/demo"'), 'plain skills offer Centralize');
    assert.ok(centralHtml.includes('data-skill-delete="/home/dev/.kimi/skills/demo"'), 'plain skills offer Delete');

    // wiring + styles
    const script = fs.readFileSync(path.join(__dirname, '..', 'media', 'webviewDashboardScripts.js'), 'utf8');
    assert.ok(script.includes("'central-toggle-skill'"), 'webview posts per-agent link toggles');
    assert.ok(script.includes("'centralize-skill'"));
    assert.ok(script.includes('data-central-toggle'));
    assert.ok(script.includes('data-central-source'));
    const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.ts'), 'utf8');
    assert.ok(dashboard.includes("'central-toggle-skill'"));
    assert.ok(dashboard.includes("'centralize-skill'"));
    const styles = fs.readFileSync(path.join(__dirname, '..', 'media', 'styles.scss'), 'utf8');
    const compiledCss = fs.readFileSync(path.join(__dirname, '..', 'media', 'styles.css'), 'utf8');
    assert.ok(styles.includes('.skill-chip.central'));
    assert.ok(styles.includes('.skill-centralize'));
    assert.ok(styles.includes('.skill-ios-toggle'));
    assert.ok(compiledCss.includes('.skill-centralize'));
    assert.ok(compiledCss.includes('.skill-ios-toggle'));
}

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

    // empty folder path = whole store (section-level batch): alpha/beta are
    // already codex-linked from the folder batch above, so only gamma changes
    const wholeStore = centralService.setFolderLinks(storeRoot, '', 'user', home, ws, true, ['codex']);
    assert.strictEqual(wholeStore.ok, true);
    assert.strictEqual(wholeStore.changed, 1, 'already-linked skills are not re-created');
    assert.ok(fs.lstatSync(path.join(home, '.codex/skills/gamma')).isSymbolicLink(), 'other folder linked too');
    const wholeOff = centralService.setFolderLinks(storeRoot, '', 'user', home, ws, false, ['codex']);
    assert.strictEqual(wholeOff.changed, 3, 'section batch removes every codex link in the store');
    assert.ok(!fs.existsSync(path.join(home, '.codex/skills/gamma')));
    assert.ok(!fs.existsSync(path.join(home, '.codex/skills/alpha')));
    // batch disable at user scope removes the remaining links (codex links
    // were already removed by the section batch above: 6 - 2 = 4 left)
    const disabled = centralService.setFolderLinks(storeRoot, 'superpowers', 'user', home, ws, false);
    assert.strictEqual(disabled.changed, 4);
    assert.ok(!fs.existsSync(path.join(home, '.kimi/skills/alpha')));

    // batch collects errors instead of stopping: block one link with a real dir
    fs.mkdirSync(path.join(home, '.kimi/skills/alpha'), { recursive: true });
    const partial = centralService.setFolderLinks(storeRoot, 'superpowers', 'user', home, ws, true);
    assert.strictEqual(partial.ok, false);
    assert.strictEqual(partial.errors.length, 1);
    assert.strictEqual(partial.errors[0].name, 'alpha');
    assert.strictEqual(partial.changed, 5, 'remaining links still created');
    fs.rmSync(path.join(home, '.kimi/skills/alpha'), { recursive: true });

    // project scope without a workspace stays error-collecting (no raw TypeError)
    const noWorkspace = centralService.setFolderLinks(storeRoot, 'superpowers', 'project', home, undefined, true);
    assert.strictEqual(noWorkspace.ok, false);
    assert.strictEqual(noWorkspace.changed, 0);
    assert.ok(noWorkspace.errors[0].error.includes('No workspace'));

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

    // refuses: existing destination, '..', absolute folder, empty segment, backslash
    assert.strictEqual(centralService.moveSkillToFolder(movedRecord, '../escape', home, ws).ok, false);
    assert.strictEqual(centralService.moveSkillToFolder(movedRecord, '/abs', home, ws).ok, false);
    assert.strictEqual(centralService.moveSkillToFolder(movedRecord, 'a//b', home, ws).ok, false, 'empty segment refused');
    assert.strictEqual(centralService.moveSkillToFolder(movedRecord, 'a\\b', home, ws).ok, false, 'backslash refused');
    const alpha2 = discovery.scanSkills({ homeDir: home, workspaceRoot: ws })
        .find(record => record.name === 'alpha');
    // materialize a name collision so the destination already exists
    write(path.join(home, '.skills/xiaohongshu/yunxiao/alpha/SKILL.md'), '---\nname: alpha\ndescription: A2\n---\n');
    const dup = centralService.moveSkillToFolder(alpha2, 'xiaohongshu/yunxiao', home, ws);
    assert.strictEqual(dup.ok, false, 'existing destination refused');
    assert.ok(fs.existsSync(path.join(home, '.skills', 'superpowers', 'alpha', 'SKILL.md')), 'source untouched');
}

function runSkillFolderControllerChecks() {
    const real = dirPath => fs.realpathSync(dirPath);
    const home = real(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-fctrl-')));
    const ws = real(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-fctrl-ws-')));
    const write = (filePath, content) => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
    };
    write(path.join(home, '.skills/superpowers/alpha/SKILL.md'), '---\nname: alpha\ndescription: A\n---\n');
    write(path.join(home, '.skills/superpowers/nested/beta/SKILL.md'), '---\nname: beta\ndescription: B\n---\n');

    const storeRoot = path.join(home, '.skills');
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
    // folder toggle is per-agent now (folder starts unlinked → enabled === false → click links it)
    const folderResult = controller.handleFolderToggle(storeRoot, 'superpowers', 'user', 'claude', false);
    assert.strictEqual(folderResult.ok, true);
    assert.ok(fs.lstatSync(path.join(home, '.claude/skills/beta')).isSymbolicLink(), 'batch links every member for that agent');
    assert.ok(!fs.existsSync(path.join(home, '.kimi/skills/beta')), 'other agents untouched by the batch');
    // move
    assert.strictEqual(controller.handleMoveToFolder(alphaDir, 'collections').ok, true);
    assert.strictEqual(
        controller.getRecords().find(record => record.name === 'alpha').folder, 'collections');
    assert.strictEqual(controller.handleMoveToFolder(alphaDir, 'collections').ok, false,
        'stale dirPath refused after the move');
    controller.dispose();

    // project-scope endpoints without a workspace refuse cleanly (no throw)
    const noWsController = new SkillDashboardController({
        getHomeDir: () => home,
        getWorkspaceRoot: () => undefined,
        postMessage: () => Promise.resolve(true),
        isVisible: () => true,
        logError: () => undefined,
    });
    noWsController.start();
    const movedAlphaDir = path.join(home, '.skills', 'collections', 'alpha');
    const noWsToggle = noWsController.handleCentralToggle(movedAlphaDir, 'project', 'kimi', false);
    assert.strictEqual(noWsToggle.ok, false, 'project-scope toggle without a workspace refuses cleanly');
    const noWsFolder = noWsController.handleFolderToggle(storeRoot, 'superpowers', 'project', false);
    assert.strictEqual(noWsFolder.ok, false, 'project-scope folder toggle without a workspace refuses cleanly');
    noWsController.dispose();
}

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

    // effectiveness: project links inherit user links; project brand winner shadows
    fs.mkdirSync(path.join(ws, '.kimi/skills'), { recursive: true });
    // the symlink into <ws>/.claude/skills requires that directory to exist first
    fs.mkdirSync(path.join(ws, '.claude/skills'), { recursive: true });
    fs.symlinkSync(path.join(home, '.skills/solo'), path.join(ws, '.claude/skills/solo'), 'dir');
    // alpha also linked into a project root that is NOT the project brand winner
    // (<ws>/.kimi/skills is the winner): its user-active link must inherit into
    // the project scope and clear the project shadowing.
    fs.symlinkSync(path.join(home, '.skills/superpowers/alpha'), path.join(ws, '.codex/skills/alpha'), 'dir');
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
    assert.strictEqual(alphaScoped.projectVisibility.kimi, 'active', 'user-active inherits into project scope');
    assert.strictEqual(alphaScoped.projectShadowedBy.kimi, undefined, 'inheritance clears project shadowing');

    // symlinked skill inside the store is followed and deduped by realpath
    fs.symlinkSync(path.join(home, '.skills/solo'), path.join(home, '.skills/alias-solo'), 'dir');
    const withAlias = discovery.scanSkills({ homeDir: home, workspaceRoot: ws });
    assert.strictEqual(withAlias.filter(record => record.dirPath === path.join(home, '.skills', 'solo')).length, 1,
        'store-internal alias symlink does not duplicate the record');

    // empty folders are listed per store (nodes render even with no skills inside)
    fs.mkdirSync(path.join(home, '.skills/empty/parent'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.skills/ws-empty'), { recursive: true });
    const detailed = discovery.scanSkillsDetailed({ homeDir: home, workspaceRoot: ws });
    assert.ok(detailed.storeFolders.user.includes('superpowers'));
    assert.ok(detailed.storeFolders.user.includes('xiaohongshu/reddoc'));
    assert.ok(detailed.storeFolders.user.includes('empty/parent'), 'empty nested folder listed');
    assert.ok(detailed.storeFolders.user.includes('empty'), 'its parent listed too');
    assert.ok(detailed.storeFolders.project.includes('ws-empty'), 'project empty folder listed');

    // A `.disabled` dir inside the central store is dot-skipped like anywhere else.
    write(path.join(home, '.skills', '.disabled', 'parked-central', 'SKILL.md'), '---\nname: parked-central\ndescription: P\n---\n');
    assert.ok(!discovery.scanSkills({ homeDir: home, workspaceRoot: ws })
        .some(record => record.name === 'parked-central'), 'store `.disabled` content is never scanned');
}

function runSkillMigrationChecks() {
    const migrateService = require('../out/skills/migrateService');
    const real = dirPath => fs.realpathSync(dirPath);
    const makeMigrationFixture = () => {
        const home = real(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-migrate-')));
        const write = (filePath, content) => {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, content);
        };
        // Identical copies of 'same' in kimi + codex (kimi wins, codex deleted).
        write(path.join(home, '.kimi/skills/same/SKILL.md'), '---\nname: same\ndescription: Same\n---\n');
        write(path.join(home, '.codex/skills/same/SKILL.md'), '---\nname: same\ndescription: Same\n---\n');
        // Drifted copies of 'drifty' in claude + codex (claude wins by priority).
        write(path.join(home, '.claude/skills/drifty/SKILL.md'), '---\nname: drifty\ndescription: Claude\n---\n');
        write(path.join(home, '.codex/skills/drifty/SKILL.md'), '---\nname: drifty\ndescription: Codex\n---\n');
        // Already-central 'shared' + its codex link + a leftover real-dir copy
        // in kimi (must be skipped, link untouched).
        write(path.join(home, '.skills/shared/SKILL.md'), '---\nname: shared\ndescription: Shared\n---\n');
        write(path.join(home, '.kimi/skills/shared/SKILL.md'), '---\nname: shared\ndescription: Shared\n---\n');
        fs.mkdirSync(path.join(home, '.codex/skills'), { recursive: true });
        fs.symlinkSync(path.join(home, '.skills/shared'), path.join(home, '.codex/skills/shared'), 'dir');
        // Kimi-only skill.
        write(path.join(home, '.kimi/skills/solo/SKILL.md'), '---\nname: solo\ndescription: Solo\n---\n');
        // Generic agents dir skill (outside migration scope).
        write(path.join(home, '.agents/skills/generic/SKILL.md'), '---\nname: generic\ndescription: Generic\n---\n');
        // A legacy `.disabled` copy of 'same' in claude is dot-skipped and left untouched.
        write(path.join(home, '.claude/skills/.disabled/same/SKILL.md'), '---\nname: same\ndescription: Parked\n---\n');
        return { home };
    };

    const { home } = makeMigrationFixture();
    const before = discovery.scanSkills({ homeDir: home });
    const report = migrateService.migrateUserSkillsToCentral(before, home);

    assert.strictEqual(report.ok, true);
    assert.deepStrictEqual(report.migrated.sort(), ['drifty', 'same', 'solo']);
    assert.deepStrictEqual(report.drifted, ['drifty'], 'drift is reported when copies differ');
    assert.strictEqual(report.deleted.length, 2, 'codex copies of same and drifty are deleted');
    assert.ok(report.skipped.some(item => item.name === 'shared' && item.reason === 'already in the central store'));
    assert.ok(report.skipped.some(item => item.name === 'generic' && item.reason === 'lives outside the kimi/claude/codex roots'));

    // Real contents: winner copies moved into ~/.skills; losers deleted, never parked
    assert.ok(fs.existsSync(path.join(home, '.skills', 'same', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(home, '.skills', 'drifty', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(home, '.skills', 'solo', 'SKILL.md')));
    assert.ok(!fs.existsSync(path.join(home, '.codex', 'skills', '.disabled', 'same')), 'codex loser deleted');
    assert.ok(!fs.existsSync(path.join(home, '.codex', 'skills', '.disabled', 'drifty')), 'codex loser deleted');
    assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', '.disabled', 'same', 'SKILL.md')),
        'pre-existing .disabled content is left untouched');
    assert.ok(!fs.existsSync(path.join(home, '.kimi', 'skills', 'same')), 'winner left its original root');
    assert.ok(!fs.existsSync(path.join(home, '.codex', 'skills', 'same')), 'loser left its original root');
    assert.ok(!fs.existsSync(path.join(home, '.claude', 'skills', 'drifty')));

    // Migration creates no agent links for the migrated skills (clean slate).
    const brandRoots = ['.kimi/skills', '.claude/skills', '.codex/skills'];
    for (const brandRoot of brandRoots) {
        const rootPath = path.join(home, brandRoot);
        if (!fs.existsSync(rootPath)) {
            continue;
        }
        for (const entry of fs.readdirSync(rootPath)) {
            const fullPath = path.join(rootPath, entry);
            if (['same', 'drifty', 'solo'].includes(entry) && fs.lstatSync(fullPath).isSymbolicLink()) {
                assert.fail(`migration must not create links: ${fullPath}`);
            }
        }
    }
    // Pre-existing central links (shared) are left untouched.
    assert.ok(fs.lstatSync(path.join(home, '.codex', 'skills', 'shared')).isSymbolicLink());

    // Idempotent second run migrates nothing
    const repeat = migrateService.migrateUserSkillsToCentral(discovery.scanSkills({ homeDir: home }), home);
    assert.strictEqual(repeat.migrated.length, 0, 'second run migrates nothing');
    assert.deepStrictEqual(repeat.skipped.map(item => item.name).sort(), ['generic', 'shared'],
        'only out-of-scope and already-central leftovers are reported on the second run');

    // project scope: same dedupe rules into <project>/.skills against project roots
    const pHome = real(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-migrate-p-')));
    const pWs = real(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-migrate-pws-')));
    const pWrite = (filePath, content) => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
    };
    pWrite(path.join(pWs, '.kimi/skills/alpha/SKILL.md'), '---\nname: alpha\ndescription: A\n---\n');
    pWrite(path.join(pWs, '.codex/skills/alpha/SKILL.md'), '---\nname: alpha\ndescription: A\n---\n');
    pWrite(path.join(pWs, '.claude/skills/beta/SKILL.md'), '---\nname: beta\ndescription: B\n---\n');
    const pReport = migrateService.migrateSkillsToCentral(
        discovery.scanSkills({ homeDir: pHome, workspaceRoot: pWs }), pHome, 'project', pWs);
    assert.strictEqual(pReport.ok, true);
    assert.deepStrictEqual(pReport.migrated.sort(), ['alpha', 'beta']);
    assert.ok(fs.existsSync(path.join(pWs, '.skills', 'alpha', 'SKILL.md')), 'winner moved into the project store');
    assert.ok(fs.existsSync(path.join(pWs, '.skills', 'beta', 'SKILL.md')));
    assert.ok(!fs.existsSync(path.join(pWs, '.codex', 'skills', '.disabled', 'alpha')),
        'project loser deleted, never parked');
    assert.ok(!fs.existsSync(path.join(pWs, '.kimi', 'skills', 'alpha')), 'winner left its project root');
    for (const entry of ['.kimi/skills', '.claude/skills', '.codex/skills']) {
        for (const name of fs.readdirSync(path.join(pWs, entry)).filter(name => !name.startsWith('.'))) {
            assert.ok(!fs.lstatSync(path.join(pWs, entry, name)).isSymbolicLink(),
                `project migration creates no links (${entry}/${name})`);
        }
    }
    const noWs = migrateService.migrateSkillsToCentral([], pHome, 'project');
    assert.strictEqual(noWs.ok, false, 'project migration without a workspace refuses cleanly');

    // controller endpoint refreshes records
    const controller = new SkillDashboardController({
        getHomeDir: () => home,
        getWorkspaceRoot: () => undefined,
        postMessage: () => Promise.resolve(true),
        isVisible: () => true,
        logError: () => undefined,
    });
    controller.start();
    const ctrlReport = controller.handleMigrateToCentral();
    assert.strictEqual(ctrlReport.migrated.length, 0, 'controller migration is idempotent after prior migration');
    assert.strictEqual(controller.getRecords().filter(record => record.central && ['same', 'drifty', 'solo'].includes(record.name)).length, 3);
    controller.dispose();

    // rendering and wiring: migrate lives in the section ⋯ menu, not the filter row
    const html = skillContent.getSkillsPanelContent([makeRecord()]);
    assert.ok(!html.includes('data-skill-migrate-central'), 'filter row migrate button removed');
    assert.ok(!html.includes('Migrate to central'), 'filter row has no migrate label');
    const script = fs.readFileSync(path.join(__dirname, '..', 'media', 'webviewDashboardScripts.js'), 'utf8');
    assert.ok(script.includes("'migrate-skills-to-central'"), 'webview posts migrate command');
    assert.ok(script.includes('data-skill-menu-migrate'), 'section ⋯ menu carries migrate');
    const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.ts'), 'utf8');
    assert.ok(dashboard.includes("'migrate-skills-to-central'"), 'dashboard handles migrate message');
    assert.ok(dashboard.includes('migrateSkillsToCentral: () => runSkillMigrationToCentral(),'), 'palette command handler wired');
    const reg = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'commandRegistration.ts'), 'utf8');
    assert.ok(reg.includes("'agentPivot.migrateSkillsToCentral'"), 'command id registered');
    assert.ok(reg.includes('migrateSkillsToCentral: DashboardCommandHandler'), 'handler type declared');
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const commands = packageJson.contributes.commands.map((item) => item.command);
    assert.ok(commands.includes('agentPivot.migrateSkillsToCentral'), 'palette command contributed');
}

function runSkillCollectionChecks() {
    const knownCollections = require('../out/skills/knownCollections');
    const real = dirPath => fs.realpathSync(dirPath);
    const home = real(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-collections-')));
    const write = (filePath, content) => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
    };
    // Two superpowers members at the store root, one already filed, one unmanaged in kimi.
    write(path.join(home, '.skills/brainstorming/SKILL.md'), '---\nname: brainstorming\ndescription: B\n---\n');
    write(path.join(home, '.skills/writing-plans/SKILL.md'), '---\nname: writing-plans\ndescription: W\n---\n');
    write(path.join(home, '.skills/superpowers/systematic-debugging/SKILL.md'), '---\nname: systematic-debugging\ndescription: S\n---\n');
    write(path.join(home, '.kimi/skills/test-driven-development/SKILL.md'), '---\nname: test-driven-development\ndescription: T\n---\n');

    // suggestion semantics: unfiled = not central or outside <store>/<name>
    const scanned = discovery.scanSkills({ homeDir: home });
    const suggestions = knownCollections.getCollectionSuggestions(scanned, []);
    assert.strictEqual(suggestions.length, 1, 'superpowers suggestion renders');
    assert.strictEqual(suggestions[0].name, 'superpowers');
    assert.strictEqual(suggestions[0].unfiledCount, 3, 'filed member does not count');
    assert.ok(!knownCollections.getCollectionSuggestions(scanned, ['superpowers']).length,
        'dismissed suggestion stays hidden');

    // controller: apply moves members into the on-disk folder (centralize first for unmanaged)
    const controller = new SkillDashboardController({
        getHomeDir: () => home,
        getWorkspaceRoot: () => undefined,
        postMessage: () => Promise.resolve(true),
        isVisible: () => true,
        logError: () => undefined,
        groupStore: {
            getDismissedCollections: () => [],
            dismissCollection: () => Promise.resolve(),
        },
    });
    controller.start();
    assert.strictEqual(controller.getCollectionSuggestions().length, 1, 'suggestion comes from the controller');
    const applied = controller.handleApplyCollectionSuggestion('superpowers');
    assert.strictEqual(applied.ok, true);
    assert.ok(fs.existsSync(path.join(home, '.skills', 'superpowers', 'brainstorming', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(home, '.skills', 'superpowers', 'writing-plans', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(home, '.skills', 'superpowers', 'test-driven-development', 'SKILL.md')),
        'unmanaged member is centralized into the folder');
    const tddLink = path.join(home, '.kimi', 'skills', 'test-driven-development');
    assert.ok(fs.lstatSync(tddLink).isSymbolicLink(), 'centralized member stays linked from its original root');
    assert.strictEqual(fs.realpathSync(tddLink), path.join(home, '.skills', 'superpowers', 'test-driven-development'),
        'the link follows the move into the folder');
    const filed = controller.getRecords().filter(record => record.folder === 'superpowers');
    assert.strictEqual(filed.length, 4, 'all four members filed under the folder');
    assert.strictEqual(controller.getCollectionSuggestions().length, 0, 'suggestion gone once everything is filed');
    controller.dispose();

    // rendering: suggestion row with new copy, Create/Dismiss actions
    const html = skillContent.getSkillsPanelContent(
        [makeRecord({
            name: 'brainstorming', source: 'central', dirPath: '/home/dev/.skills/brainstorming',
            skillFilePath: '/home/dev/.skills/brainstorming/SKILL.md',
            central: { dirPath: '/home/dev/.skills/brainstorming', links: {} },
        }), makeRecord({
            name: 'writing-plans', source: 'central', dirPath: '/home/dev/.skills/writing-plans',
            skillFilePath: '/home/dev/.skills/writing-plans/SKILL.md',
            central: { dirPath: '/home/dev/.skills/writing-plans', links: {} },
        })],
        { suggestions: [{ name: 'superpowers', presentCount: 2, unfiledCount: 2 }] },
    );
    assert.ok(html.includes('Create the <strong>superpowers</strong> folder'), 'suggestion copy names the folder');
    assert.ok(html.includes('move 2 skills into it'));
    assert.ok(html.includes('data-skill-apply-suggestion="superpowers"'));
    assert.ok(html.includes('data-skill-dismiss-suggestion="superpowers"'));
    assert.ok(!html.includes('data-skill-collection='), 'no virtual collection markup');
}

function runSkillFolderMutationChecks() {
    const centralService = require('../out/skills/centralService');
    const real = dirPath => fs.realpathSync(dirPath);
    const home = real(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-fmut-')));
    const write = (filePath, content) => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
    };
    const storeRoot = path.join(home, '.skills');

    // createSkillFolder
    write(path.join(storeRoot, 'pack/solo/SKILL.md'), '---\nname: solo\ndescription: S\n---\n');
    const created = centralService.createSkillFolder(storeRoot, 'xiaohongshu/yunxiao');
    assert.strictEqual(created.ok, true);
    assert.ok(fs.statSync(path.join(storeRoot, 'xiaohongshu', 'yunxiao')).isDirectory(), 'nested folder created');
    assert.strictEqual(centralService.createSkillFolder(storeRoot, 'xiaohongshu').ok, false, 'existing folder refused');
    assert.strictEqual(centralService.createSkillFolder(storeRoot, '../escape').ok, false);
    assert.strictEqual(centralService.createSkillFolder(storeRoot, '/abs').ok, false);
    assert.strictEqual(centralService.createSkillFolder(storeRoot, 'a\\b').ok, false);
    assert.strictEqual(centralService.createSkillFolder(storeRoot, '  ').ok, false, 'blank name refused');

    // removeSkillFolder
    assert.strictEqual(centralService.removeSkillFolder(storeRoot, 'pack').ok, false, 'folder with skills refused');
    assert.ok(fs.existsSync(path.join(storeRoot, 'pack', 'solo', 'SKILL.md')), 'skills untouched by refusal');
    assert.strictEqual(centralService.removeSkillFolder(storeRoot, 'missing').ok, false, 'unknown folder refused');
    const removed = centralService.removeSkillFolder(storeRoot, 'xiaohongshu/yunxiao');
    assert.strictEqual(removed.ok, true, 'empty leaf folder deleted');
    assert.ok(!fs.existsSync(path.join(storeRoot, 'xiaohongshu', 'yunxiao')));
    assert.ok(fs.existsSync(path.join(storeRoot, 'xiaohongshu')), 'parent folder kept');
    assert.strictEqual(centralService.removeSkillFolder(storeRoot, 'xiaohongshu').ok, true, 'now-empty parent deleted');

    // controller: create/remove with containment
    const controller = new SkillDashboardController({
        getHomeDir: () => home,
        getWorkspaceRoot: () => undefined,
        postMessage: () => Promise.resolve(true),
        isVisible: () => true,
        logError: () => undefined,
    });
    controller.start();
    assert.deepStrictEqual(controller.getStoreRoots(), { user: storeRoot, project: undefined });
    assert.strictEqual(controller.handleCreateFolder('user', 'newpack').ok, true);
    assert.ok(fs.statSync(path.join(storeRoot, 'newpack')).isDirectory());
    assert.strictEqual(controller.handleCreateFolder('project', 'p').ok, false, 'no workspace → clean refusal');
    assert.strictEqual(controller.handleRemoveFolder('/etc', 'newpack').ok, false, 'unknown store refused');
    assert.strictEqual(controller.handleRemoveFolder(storeRoot, 'newpack').ok, true);
    assert.ok(!fs.existsSync(path.join(storeRoot, 'newpack')));
    controller.dispose();

    // rendering: section "+" and folder "×" actions + store roots from the view
    const tree = skillContent.getSkillsPanelContent([
        makeRecord({
            name: 'alpha', source: 'central', dirPath: '/home/dev/.skills/pack/alpha',
            skillFilePath: '/home/dev/.skills/pack/alpha/SKILL.md', folder: 'pack',
            central: { dirPath: '/home/dev/.skills/pack/alpha', links: {} },
        }),
    ], { hasWorkspace: true, storeRoots: { user: '/home/dev/.skills', project: '/work/app/.skills' } });
    assert.ok(tree.includes('data-section-menu="user"'), 'global section has a ⋯ menu (create folder inside)');
    assert.ok(tree.includes('data-state-kimi='), 'section ⋯ button carries per-agent batch states');
    assert.ok(tree.split('data-section-menu')[0].includes('skill-agent-dots'), 'section header shows per-agent state dots');
    assert.ok(tree.includes('data-folder-menu="pack"'), 'folder header has the ⋯ menu (delete lives inside)');
    const noViewRoots = skillContent.getSkillsPanelContent([makeRecord({
        name: 'beta', source: 'central', dirPath: '/home/dev/.skills/pack/beta',
        skillFilePath: '/home/dev/.skills/pack/beta/SKILL.md', folder: 'pack',
        central: { dirPath: '/home/dev/.skills/pack/beta', links: {} },
    })], { hasWorkspace: true });
    assert.ok(noViewRoots.includes('data-section-menu="user"'), 'store root derived from records when view omits it');

    // wiring
    const script = fs.readFileSync(path.join(__dirname, '..', 'media', 'webviewDashboardScripts.js'), 'utf8');
    assert.ok(script.includes("'create-skill-folder'"), 'create folder wiring present');
    assert.ok(script.includes("'remove-skill-folder'"), 'remove folder wiring present');
    assert.ok(script.includes('data-skill-menu-new-folder'));
    assert.ok(script.includes('data-section-menu'), 'section ⋯ menu wiring present');
    assert.ok(script.includes('data-skill-remove-folder'));
    const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.ts'), 'utf8');
    assert.ok(dashboard.includes("'create-skill-folder'"));
    assert.ok(dashboard.includes("'remove-skill-folder'"));
    assert.ok(dashboard.includes('showInputBox'), 'folder name prompted host-side');
    const styles = fs.readFileSync(path.join(__dirname, '..', 'media', 'styles.scss'), 'utf8');
    const compiledCss = fs.readFileSync(path.join(__dirname, '..', 'media', 'styles.css'), 'utf8');
    assert.ok(styles.includes('.skill-folder-add'));
    assert.ok(styles.includes('.skill-folder-remove'));
    assert.ok(compiledCss.includes('.skill-folder-add'));
    assert.ok(compiledCss.includes('body.steward-sidebar .ai-tablist'), 'AI tab row sticks below the main header');
}
