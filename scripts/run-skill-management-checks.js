'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const frontmatter = require('../out/skills/frontmatter');
const roots = require('../out/skills/roots');
const discovery = require('../out/skills/discovery');
const effectiveness = require('../out/skills/effectiveness');
const toggleService = require('../out/skills/toggleService');

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
// dashboardController transitively requires webviewSkillContent → webviewContent → vscode,
// so it must be required while the vscode stub is still active.
const { SkillDashboardController } = require('../out/skills/dashboardController');
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
    assert.strictEqual(roots.DISABLED_DIR_NAME, '.disabled');
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
    write(path.join(home, '.kimi/skills/.disabled/parked/SKILL.md'), '---\nname: parked\ndescription: x\n---\n');
    write(path.join(ws, '.claude/skills/gamma/SKILL.md'), '---\nname: gamma\ndescription: Gamma\n---\n# G\n');
    write(path.join(ws, '.agents/skills/delta/skill.md'), '---\nname: delta\ndescription: Delta\n---\n');
    return { home, ws };
}

function runDiscoveryChecks() {
    const { home, ws } = makeFixture();
    const records = discovery.scanSkills({ homeDir: home, workspaceRoot: ws });
    const byName = new Map(records.map(record => [record.name, record]));

    assert.deepStrictEqual(records.map(record => record.name).sort(), ['alpha', 'beta', 'delta', 'gamma', 'parked']);
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
    const parked = byName.get('parked');
    assert.ok(parked, '.disabled skills are scanned as parked records');
    assert.strictEqual(parked.enabled, false);
    assert.strictEqual(parked.scope, 'user');
    assert.strictEqual(parked.source, 'kimi');
    assert.strictEqual(parked.dirPath, path.join(home, '.kimi', 'skills', '.disabled', 'parked'));
    assert.strictEqual(parked.description, 'x', 'parked records keep frontmatter parsing');
    assert.ok(!byName.has('hidden'), 'dot-directories must be skipped');
    assert.ok(!byName.has('.hidden'));
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

    // Parked records are excluded from effectiveness even when a brand dir exists
    assert.deepStrictEqual(byName.get('parked').visibility, { kimi: 'absent', claude: 'absent', codex: 'absent' });
    assert.deepStrictEqual(byName.get('parked').shadowedBy, {});

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
    assert.deepStrictEqual(
        gammaOnly.find(r => r.name === 'parked').visibility,
        { kimi: 'absent', claude: 'absent', codex: 'absent' },
        'parked records stay absent on re-application'
    );
}

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
    assert.ok(html.includes('data-skill-open="/home/dev/.kimi/skills/demo/SKILL.md"'),
        'clean records (no shadowing, no diagnostics) render the Open SKILL.md action');
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
    const afterDisable = controller.getRecords().find(record => record.name === 'alpha');
    assert.ok(afterDisable, 'disabled skill stays listed as a parked record');
    assert.strictEqual(afterDisable.enabled, false);
    const parkedPath = path.join(home, '.kimi', 'skills', '.disabled', 'alpha');
    assert.strictEqual(controller.handleToggle(parkedPath, false).ok, true);
    const afterEnable = controller.getRecords().find(record => record.name === 'alpha');
    assert.ok(afterEnable, 're-enabled skill is back in the scan');
    assert.strictEqual(afterEnable.enabled, true);

    // Path containment: mutation endpoints must refuse paths outside known skills roots.
    const outsideDisable = controller.handleToggle(path.join(os.tmpdir(), 'not-a-skill-dir', 'x'), true);
    assert.strictEqual(outsideDisable.ok, false, 'disable outside known roots is refused');
    const disableDisabledDir = controller.handleToggle(path.join(home, '.kimi', 'skills', '.disabled'), true);
    assert.strictEqual(disableDisabledDir.ok, false, 'the .disabled directory itself is not a toggle target');
    const outsideEnable = controller.handleToggle(path.join(os.tmpdir(), 'elsewhere', '.disabled', 'x'), false);
    assert.strictEqual(outsideEnable.ok, false, 'enable outside a known root .disabled dir is refused');
    const enableActive = controller.handleToggle(skillDir, false);
    assert.strictEqual(enableActive.ok, false, 'enable on an active (non-parked) path is refused');
    assert.ok(fs.existsSync(path.join(skillDir, 'SKILL.md')), 'refused toggles never touch the filesystem');

    posted.length = 0;
    const bad = controller.handleToggle(path.join(home, '.kimi', 'skills', 'missing'), true);
    assert.strictEqual(bad.ok, false);
    controller.dispose();
}

function runSkillWiringChecks() {
    const dashboard = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard.ts'), 'utf8');
    assert.ok(dashboard.includes('new SkillDashboardController('));
    assert.ok(dashboard.includes("'toggle-skill'"));
    assert.ok(dashboard.includes("'open-skill-file'"));
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
runToggleChecks();
runSkillRenderingChecks();
runSkillStyleChecks();
runSkillWebviewScriptChecks();
runSkillControllerChecks();
runSkillWiringChecks();
console.log('Skill management checks passed.');
