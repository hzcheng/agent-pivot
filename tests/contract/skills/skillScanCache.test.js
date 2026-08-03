'use strict';

// Covers PERSIST-AI-SKILL-DISCOVERY-001 (scan freshness after the skill hash
// cache and the hidden-sidebar scan gate landed).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function loadSkillsModules() {
    // dashboardController transitively requires webviewSkillContent → webviewContent
    // → vscode, and getSkillsPanelContent calls vscode.Uri.file at render time
    // (mirrors run-skill-management-checks.js).
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
            syncService: require('../../../out/skills/syncService'),
            dashboardController: require('../../../out/skills/dashboardController'),
        };
    } finally {
        Module._load = previousLoad;
    }
}

const { syncService, dashboardController } = loadSkillsModules();
const { hashSkillDirectory } = syncService;
const { SkillDashboardController } = dashboardController;

function makeTempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSkill(dirPath, description, extras = {}, name) {
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(
        path.join(dirPath, 'SKILL.md'),
        `---\nname: ${name || path.basename(dirPath)}\ndescription: ${description}\n---\n\nbody\n`,
    );
    for (const [relative, content] of Object.entries(extras)) {
        const filePath = path.join(dirPath, relative);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
    }
}

test('PERSIST-AI-SKILL-DISCOVERY-001 hash cache serves identical copies and unchanged directories', () => {
    const home = makeTempDir('skill-hash-cache-');
    try {
        const dirA = path.join(home, 'copy-a');
        const dirB = path.join(home, 'copy-b');
        writeSkill(dirA, 'first', { 'refs/guide.txt': 'guide-body' }, 'demo');
        writeSkill(dirB, 'first', { 'refs/guide.txt': 'guide-body' }, 'demo');

        const hashA = hashSkillDirectory(dirA);
        assert.strictEqual(hashSkillDirectory(dirB), hashA, 'identical copies share a fingerprint');
        assert.strictEqual(hashSkillDirectory(dirA), hashA, 'an unchanged directory reuses its cached hash');
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('PERSIST-AI-SKILL-DISCOVERY-001 hash cache tracks top-level and nested file changes', () => {
    const home = makeTempDir('skill-hash-invalidation-');
    try {
        const dir = path.join(home, 'skill');
        writeSkill(dir, 'first', { 'scripts/run.sh': 'echo one' });
        const initial = hashSkillDirectory(dir);

        writeSkill(dir, 'second-description-is-longer', { 'scripts/run.sh': 'echo one' });
        const afterTopLevel = hashSkillDirectory(dir);
        assert.notStrictEqual(afterTopLevel, initial, 'top-level file change invalidates the cache');

        fs.writeFileSync(path.join(dir, 'scripts', 'run.sh'), 'echo one && echo two');
        const afterNested = hashSkillDirectory(dir);
        assert.notStrictEqual(afterNested, afterTopLevel, 'nested file change invalidates the cache');
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('PERSIST-AI-SKILL-DISCOVERY-001 hash cache ignores node_modules and .git content', () => {
    const home = makeTempDir('skill-hash-exclusions-');
    try {
        const dir = path.join(home, 'skill');
        writeSkill(dir, 'first', { 'node_modules/pkg/index.js': 'v1', '.git/refs/heads/main': 'ref-a' });
        const initial = hashSkillDirectory(dir);

        fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'v2-with-more-bytes');
        fs.writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'main'), 'ref-b-longer');
        assert.strictEqual(hashSkillDirectory(dir), initial, 'excluded directories never affect the fingerprint');
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

function createControllerFixture(home, options = {}) {
    const posted = [];
    let visible = options.visible ?? false;
    const controller = new SkillDashboardController({
        getHomeDir: () => home,
        getWorkspaceRoot: () => undefined,
        postMessage: message => { posted.push(message); return Promise.resolve(true); },
        isVisible: () => visible,
        logError: () => undefined,
    });
    return {
        controller,
        posted,
        setVisible: value => { visible = value; },
    };
}

test('PERSIST-AI-SKILL-DISCOVERY-001 hidden watch refreshes defer the scan until records are read', async () => {
    const home = makeTempDir('skill-hidden-scan-');
    try {
        const skillDir = path.join(home, '.kimi', 'skills', 'demo');
        writeSkill(skillDir, 'first');
        const { controller, posted } = createControllerFixture(home, { visible: false });

        controller.start();
        assert.strictEqual(controller.getRecords().length, 1, 'start() still performs the bootstrap scan while hidden');
        assert.strictEqual(posted.length, 0, 'hidden start posts nothing');

        writeSkill(skillDir, 'second-description-is-longer');
        const delivered = await controller.refresh('watch');
        assert.strictEqual(delivered, false, 'hidden watch refresh skips delivery');
        assert.strictEqual(posted.length, 0, 'hidden watch refresh posts nothing');

        const records = controller.getRecords();
        assert.strictEqual(records.length, 1);
        assert.strictEqual(
            records[0].description,
            'second-description-is-longer',
            'reading records after a hidden watch refresh rescans lazily',
        );
        controller.dispose();
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});

test('PERSIST-AI-SKILL-DISCOVERY-001 visible watch refreshes scan and post immediately', async () => {
    const home = makeTempDir('skill-visible-scan-');
    try {
        const skillDir = path.join(home, '.kimi', 'skills', 'demo');
        writeSkill(skillDir, 'first');
        const { controller, posted } = createControllerFixture(home, { visible: true });

        controller.start();
        assert.strictEqual(posted.length, 1, 'visible start posts the panel');
        assert.strictEqual(posted[0].type, 'skills-updated');

        writeSkill(skillDir, 'second-description-is-longer');
        const delivered = await controller.refresh('watch');
        assert.strictEqual(delivered, true, 'visible watch refresh delivers');
        assert.strictEqual(posted.length, 2, 'visible watch refresh posts the rebuilt panel');
        assert.strictEqual(posted[1].type, 'skills-updated');
        assert.match(posted[1].html, /second-description-is-longer/);
        assert.strictEqual(controller.getRecords()[0].description, 'second-description-is-longer');
        controller.dispose();
    } finally {
        fs.rmSync(home, { recursive: true, force: true });
    }
});
