'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
    runModuleBoundaryCheck,
} = require('../../../scripts/architecture/checkModuleBoundaries');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

/**
 * Synthetic repository: two modules with real import edges, plus policy,
 * baseline, and waiver files.
 */
function makeFixture({ imports = {}, baselineFingerprints = [], waivers = [], mayDependOn = {}, entrypoints = {}, extraFiles = [] }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-boundary-'));
    const writeJson = (relative, value) => {
        fs.mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
        fs.writeFileSync(path.join(root, relative), JSON.stringify(value, null, 2));
    };
    const writeSource = (relative, imported) => {
        fs.mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
        fs.writeFileSync(path.join(root, relative),
            imported.map(target => `import '${target}';`).join('\n') + '\n// fixture\n');
    };

    const moduleEntry = (id, root_, deps) => ({
        id,
        title: id,
        purpose: `${id} fixture`,
        source: { include: [`${root_}/**`], exclude: [] },
        publicEntrypoints: entrypoints[id] || [`${root_}/**`],
        mayDependOn: deps,
        roles: [{ role: 'application', include: [`${root_}/**`] }],
        productCapabilities: ['MAIN-TEST-001'],
    });
    writeJson('docs/testing/architecture-modules.json', {
        version: 1,
        scope: { roots: ['src'] },
        modules: [
            moduleEntry('MOD-ALPHA', 'src/alpha', mayDependOn['MOD-ALPHA'] || []),
            moduleEntry('MOD-BETA', 'src/beta', mayDependOn['MOD-BETA'] || []),
        ],
    });
    writeJson('docs/testing/main-capability-coverage.json', {
        version: 1, capabilities: [{ id: 'MAIN-TEST-001' }],
    });
    writeJson('.ci/architecture-debt-baseline.json', {
        version: 1,
        rules: { 'module-cycle': { fingerprints: baselineFingerprints } },
    });
    writeJson('docs/testing/architecture-waivers.json', { version: 1, waivers });

    const sourceFiles = new Set(Object.keys(imports));
    for (const targets of Object.values(imports)) {
        for (const target of targets) {
            sourceFiles.add(target.replace(/^\.\//, '').replace(/^([ab])/, 'src/$1'));
        }
    }
    for (const file of ['src/alpha/a.ts', 'src/beta/b.ts', ...sourceFiles, ...extraFiles]) {
        writeSource(file, imports[file] || []);
    }
    return root;
}

function waiver(id, fingerprints) {
    return {
        id,
        rule: 'module-cycle',
        fingerprints,
        owner: 'test-owner',
        reason: 'fixture debt',
        tracking: 'fixture-wave',
        createdAt: '2026-08-17',
        retiresWith: 'WAVE-FIXTURE',
        expiresAt: null,
    };
}

test('ARCH-MODULE-BOUNDARY-001 ARCH-MODULE-CYCLE-001 the real repository satisfies the boundary rules', () => {
    const { errors } = runModuleBoundaryCheck(repoRoot);
    assert.deepEqual(errors, []);
});

test('ARCH-MODULE-BOUNDARY-001 a declared edge through a public entrypoint passes', () => {
    const root = makeFixture({
        imports: { 'src/alpha/a.ts': ['./../beta/b'] },
        mayDependOn: { 'MOD-ALPHA': ['MOD-BETA'] },
    });
    assert.deepEqual(runModuleBoundaryCheck(root).errors, []);
});

test('ARCH-MODULE-BOUNDARY-001 controlled mutation: an undeclared cross-module edge fails', () => {
    const root = makeFixture({
        imports: { 'src/alpha/a.ts': ['./../beta/b'] },
        mayDependOn: {},
    });
    const { errors } = runModuleBoundaryCheck(root);
    assert.ok(errors.some(error => error.includes('MOD-ALPHA')
        && error.includes('MOD-BETA') && error.includes('mayDependOn')));
});

test('ARCH-MODULE-BOUNDARY-001 controlled mutation: a deep import past narrowed entrypoints fails', () => {
    const root = makeFixture({
        imports: { 'src/alpha/a.ts': ['./../beta/b'] },
        mayDependOn: { 'MOD-ALPHA': ['MOD-BETA'] },
        entrypoints: { 'MOD-BETA': ['src/beta/public.ts'] },
        extraFiles: ['src/beta/public.ts'],
    });
    const { errors } = runModuleBoundaryCheck(root);
    assert.ok(errors.some(error => error.includes('deep-imports') && error.includes('MOD-BETA')));
});

test('ARCH-MODULE-CYCLE-001 controlled mutation: a new cycle fails as new debt', () => {
    const root = makeFixture({
        imports: { 'src/alpha/a.ts': ['./../beta/b'], 'src/beta/b.ts': ['./../alpha/a'] },
        mayDependOn: { 'MOD-ALPHA': ['MOD-BETA'], 'MOD-BETA': ['MOD-ALPHA'] },
    });
    const { errors } = runModuleBoundaryCheck(root);
    assert.ok(errors.some(error => error.includes('2:MOD-ALPHA->MOD-BETA') && error.includes('new cycle debt')));
});

test('ARCH-MODULE-CYCLE-001 a baselined and waived cycle passes', () => {
    const root = makeFixture({
        imports: { 'src/alpha/a.ts': ['./../beta/b'], 'src/beta/b.ts': ['./../alpha/a'] },
        mayDependOn: { 'MOD-ALPHA': ['MOD-BETA'], 'MOD-BETA': ['MOD-ALPHA'] },
        baselineFingerprints: ['2:MOD-ALPHA->MOD-BETA'],
        waivers: [waiver('ARCH-WAIVER-TEST', ['2:MOD-ALPHA->MOD-BETA'])],
    });
    assert.deepEqual(runModuleBoundaryCheck(root).errors, []);
});

test('ARCH-MODULE-CYCLE-001 controlled mutation: a baseline entry that no longer occurs fails', () => {
    const root = makeFixture({
        imports: {},
        baselineFingerprints: ['2:MOD-ALPHA->MOD-BETA'],
        waivers: [waiver('ARCH-WAIVER-TEST', ['2:MOD-ALPHA->MOD-BETA'])],
    });
    const { errors } = runModuleBoundaryCheck(root);
    assert.ok(errors.some(error => error.includes('no longer occurs')));
});

test('ARCH-MODULE-CYCLE-001 controlled mutation: a waiver without a matching baseline entry fails', () => {
    const root = makeFixture({
        imports: {},
        waivers: [waiver('ARCH-WAIVER-TEST', ['2:MOD-ALPHA->MOD-BETA'])],
    });
    const { errors } = runModuleBoundaryCheck(root);
    assert.ok(errors.some(error => error.includes('not an active baseline fingerprint')));
});

test('ARCH-MODULE-CYCLE-001 controlled mutation: a baseline entry without a waiver fails', () => {
    const root = makeFixture({
        imports: { 'src/alpha/a.ts': ['./../beta/b'], 'src/beta/b.ts': ['./../alpha/a'] },
        mayDependOn: { 'MOD-ALPHA': ['MOD-BETA'], 'MOD-BETA': ['MOD-ALPHA'] },
        baselineFingerprints: ['2:MOD-ALPHA->MOD-BETA'],
    });
    const { errors } = runModuleBoundaryCheck(root);
    assert.ok(errors.some(error => error.includes('has no active waiver')));
});

test('ARCH-MODULE-CYCLE-001 the baseline generator writes the current cycle fingerprints', () => {
    const { generateBaseline } = require('../../../scripts/architecture/updateArchitectureDebtBaseline');
    const root = makeFixture({
        imports: { 'src/alpha/a.ts': ['./../beta/b'], 'src/beta/b.ts': ['./../alpha/a'] },
        mayDependOn: { 'MOD-ALPHA': ['MOD-BETA'], 'MOD-BETA': ['MOD-ALPHA'] },
    });
    const result = generateBaseline(root);
    assert.equal(result.written, true);
    assert.deepEqual(result.fingerprints, ['2:MOD-ALPHA->MOD-BETA']);
});

test('ARCH-MODULE-CYCLE-001 controlled mutation: a waiver without owner or milestone fails', () => {
    const bad = waiver('ARCH-WAIVER-TEST', ['2:MOD-ALPHA->MOD-BETA']);
    bad.owner = '';
    const root = makeFixture({
        imports: { 'src/alpha/a.ts': ['./../beta/b'], 'src/beta/b.ts': ['./../alpha/a'] },
        mayDependOn: { 'MOD-ALPHA': ['MOD-BETA'], 'MOD-BETA': ['MOD-ALPHA'] },
        baselineFingerprints: ['2:MOD-ALPHA->MOD-BETA'],
        waivers: [bad],
    });
    const { errors } = runModuleBoundaryCheck(root);
    assert.ok(errors.some(error => error.includes('owner, reason, and retiresWith')));
});
