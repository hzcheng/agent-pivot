'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
    loadArchitecturePolicy,
} = require('../../../scripts/architecture/loadArchitecturePolicy');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

function makeFixture({ registry, files }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-closed-world-'));
    fs.mkdirSync(path.join(root, 'docs/testing'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/testing/architecture-modules.json'),
        JSON.stringify(registry));
    fs.writeFileSync(path.join(root, 'docs/testing/main-capability-coverage.json'),
        JSON.stringify({ version: 1, capabilities: [{ id: 'MAIN-TEST-001' }] }));
    for (const file of files) {
        fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), '// fixture\n');
    }
    return root;
}

function twoModuleRegistry() {
    return {
        version: 1,
        scope: { roots: ['src'] },
        modules: [
            {
                id: 'MOD-ALPHA',
                title: 'Alpha',
                purpose: 'Alpha files.',
                source: { include: ['src/alpha/**'], exclude: [] },
                publicEntrypoints: ['src/alpha/**'],
                mayDependOn: [],
                roles: [{ role: 'application', include: ['src/alpha/**'] }],
                productCapabilities: ['MAIN-TEST-001'],
            },
            {
                id: 'MOD-BETA',
                title: 'Beta',
                purpose: 'Beta files.',
                source: { include: ['src/beta/**'], exclude: [] },
                publicEntrypoints: ['src/beta/**'],
                mayDependOn: [],
                roles: [
                    { role: 'domain', include: ['src/beta/types.ts'] },
                    { role: 'application', include: ['**'] },
                ],
                productCapabilities: ['MAIN-TEST-001'],
            },
        ],
    };
}

test('ARCH-CLOSED-WORLD-001 the real repository classifies every production file exactly once', () => {
    const { errors, classification, files } = loadArchitecturePolicy(repoRoot);
    assert.deepEqual(errors, []);
    assert.equal(classification.size, files.length);
    assert.ok(files.length >= 360, `expected at least 360 classified files, got ${files.length}`);
});

test('ARCH-CLOSED-WORLD-001 real-repository spot checks pin the tricky classifications', () => {
    const { classification } = loadArchitecturePolicy(repoRoot);
    const expected = {
        'src/dashboard.ts': ['MOD-DASHBOARD-SHELL', 'composition'],
        'src/aiSessions/terminalCommandController.ts': ['MOD-AI-SESSION-CONTROL', 'application'],
        'src/aiSessions/tmuxClient.ts': ['MOD-AI-SESSION-RUNTIME', 'infrastructure'],
        'src/aiSessions/conversation/viewer.ts': ['MOD-AI-SESSION-CONVERSATION', 'application'],
        'src/services/codexSessionService.ts': ['MOD-AI-SESSION-PROVIDER', 'infrastructure'],
        'src/worktrees/groupManifestStore.ts': ['MOD-WORKTREE-LIFECYCLE', 'infrastructure'],
        'src/webview/webviewContent.ts': ['MOD-DASHBOARD-SHELL', 'presentation'],
        'shared/attention-bridge/protocol.ts': ['MOD-ATTENTION-BRIDGE-EXT', 'domain'],
        'extensions/attention-ui-bridge/src/extension.ts': ['MOD-ATTENTION-BRIDGE-EXT', 'composition'],
    };
    for (const [file, [moduleId, role]] of Object.entries(expected)) {
        assert.deepEqual(classification.get(file), { moduleId, role }, file);
    }
});

test('ARCH-CLOSED-WORLD-001 the CLI runner exits zero on the real repository', () => {
    const { runClosedWorldCheck } = require('../../../scripts/architecture/checkClosedWorld');
    assert.equal(runClosedWorldCheck(repoRoot), 0);
});

test('ARCH-CLOSED-WORLD-001 the CLI runner exits one with remediation output on violations', () => {
    const { runClosedWorldCheck } = require('../../../scripts/architecture/checkClosedWorld');
    const broken = makeFixture({
        registry: twoModuleRegistry(),
        files: ['src/alpha/index.ts', 'src/beta/index.ts', 'src/beta/types.ts', 'src/orphan.ts'],
    });
    assert.equal(runClosedWorldCheck(broken), 1);
});

test('ARCH-CLOSED-WORLD-001 a clean synthetic tree passes', () => {
    const { errors, classification } = loadArchitecturePolicy(makeFixture({
        registry: twoModuleRegistry(),
        files: ['src/alpha/index.ts', 'src/beta/index.ts', 'src/beta/types.ts'],
    }));
    assert.deepEqual(errors, []);
    assert.equal(classification.get('src/beta/types.ts').role, 'domain');
    assert.equal(classification.get('src/beta/index.ts').role, 'application');
});

test('ARCH-CLOSED-WORLD-001 controlled mutation: an unclassified file fails with remediation identity', () => {
    const { errors } = loadArchitecturePolicy(makeFixture({
        registry: twoModuleRegistry(),
        files: ['src/alpha/index.ts', 'src/beta/index.ts', 'src/beta/types.ts', 'src/orphan.ts'],
    }));
    assert.ok(errors.some(e => e.includes('src/orphan.ts') && e.includes('not classified')));
});

test('ARCH-CLOSED-WORLD-001 controlled mutation: a multiply classified file fails with both owners', () => {
    const registry = twoModuleRegistry();
    registry.modules[0].source.include.push('src/beta/**');
    const { errors } = loadArchitecturePolicy(makeFixture({
        registry,
        files: ['src/alpha/index.ts', 'src/beta/index.ts', 'src/beta/types.ts'],
    }));
    assert.ok(errors.some(e => e.includes('src/beta/index.ts') && e.includes('MOD-ALPHA') && e.includes('MOD-BETA')));
});

test('ARCH-CLOSED-WORLD-001 controlled mutation: a file without a role fails', () => {
    const registry = twoModuleRegistry();
    registry.modules[1].roles = [{ role: 'domain', include: ['src/beta/types.ts'] }];
    const { errors } = loadArchitecturePolicy(makeFixture({
        registry,
        files: ['src/alpha/index.ts', 'src/beta/index.ts', 'src/beta/types.ts'],
    }));
    assert.ok(errors.some(e => e.includes('src/beta/index.ts') && e.includes('has no role')));
});

test('ARCH-CLOSED-WORLD-001 controlled mutation: an unknown file kind fails closed', () => {
    const { errors } = loadArchitecturePolicy(makeFixture({
        registry: twoModuleRegistry(),
        files: ['src/alpha/index.ts', 'src/beta/index.ts', 'src/beta/types.ts', 'src/alpha/readme.py'],
    }));
    assert.ok(errors.some(e => e.includes('src/alpha/readme.py') && e.includes('unknown file kind')));
});

test('ARCH-CLOSED-WORLD-001 controlled mutation: a stale pattern that matches nothing fails', () => {
    const registry = twoModuleRegistry();
    registry.modules[0].source.include.push('src/alpha/legacy/**');
    const { errors } = loadArchitecturePolicy(makeFixture({
        registry,
        files: ['src/alpha/index.ts', 'src/beta/index.ts', 'src/beta/types.ts'],
    }));
    assert.ok(errors.some(e => e.includes('stale source.include pattern src/alpha/legacy/**')));
});

test('ARCH-CLOSED-WORLD-001 controlled mutation: a file matching two specific roles fails with both roles and patterns', () => {
    const registry = twoModuleRegistry();
    registry.modules[1].roles = [
        { role: 'domain', include: ['src/beta/types.ts', 'src/beta/index.ts'] },
        { role: 'application', include: ['src/beta/index.ts'] },
    ];
    const { errors } = loadArchitecturePolicy(makeFixture({
        registry,
        files: ['src/alpha/index.ts', 'src/beta/index.ts', 'src/beta/types.ts'],
    }));
    assert.ok(errors.some(error => error.includes('src/beta/index.ts')
        && error.includes('multiple roles') && error.includes('domain')
        && error.includes('application')), JSON.stringify(errors));
});

test('ARCH-CLOSED-WORLD-001 controlled mutation: a remainder role not in last position fails', () => {
    const registry = twoModuleRegistry();
    registry.modules[1].roles = [
        { role: 'application', include: ['**'] },
        { role: 'domain', include: ['src/beta/types.ts'] },
    ];
    const { errors } = loadArchitecturePolicy(makeFixture({
        registry,
        files: ['src/alpha/index.ts', 'src/beta/index.ts', 'src/beta/types.ts'],
    }));
    assert.ok(errors.some(error => error.includes('remainder role')
        && error.includes('last')), JSON.stringify(errors));
});

test('ARCH-CLOSED-WORLD-001 the remainder role catches only unclaimed files', () => {
    const { errors, classification } = loadArchitecturePolicy(makeFixture({
        registry: twoModuleRegistry(),
        files: ['src/alpha/index.ts', 'src/beta/index.ts', 'src/beta/types.ts'],
    }));
    assert.deepEqual(errors, []);
    assert.equal(classification.get('src/beta/types.ts').role, 'domain');
    assert.equal(classification.get('src/beta/index.ts').role, 'application');
});

test('ARCH-CLOSED-WORLD-001 controlled mutation: an entrypoint outside the module fails', () => {
    const registry = twoModuleRegistry();
    registry.modules[0].publicEntrypoints = ['src/nope/**'];
    const { errors } = loadArchitecturePolicy(makeFixture({
        registry,
        files: ['src/alpha/index.ts', 'src/beta/index.ts', 'src/beta/types.ts'],
    }));
    assert.ok(errors.some(e => e.includes('public entrypoint src/nope/**')));
});

test('ARCH-CLOSED-WORLD-001 controlled mutation: missing or empty publicEntrypoints fail closed (review R9)', () => {
    const missing = twoModuleRegistry();
    delete missing.modules[0].publicEntrypoints;
    const { errors: missingErrors } = loadArchitecturePolicy(makeFixture({
        registry: missing,
        files: ['src/alpha/index.ts', 'src/beta/index.ts', 'src/beta/types.ts'],
    }));
    assert.ok(missingErrors.some(e => e.includes('MOD-ALPHA')
        && e.includes('publicEntrypoints is required')), JSON.stringify(missingErrors));
    const empty = twoModuleRegistry();
    empty.modules[0].publicEntrypoints = [];
    const { errors: emptyErrors } = loadArchitecturePolicy(makeFixture({
        registry: empty,
        files: ['src/alpha/index.ts', 'src/beta/index.ts', 'src/beta/types.ts'],
    }));
    assert.ok(emptyErrors.some(e => e.includes('MOD-ALPHA')
        && e.includes('publicEntrypoints')), JSON.stringify(emptyErrors));
});
