'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
    classifyArchitectureChange,
} = require('../../../scripts/architecture/checkArchitectureChange');
const {
    collectArchitectureDiff,
} = require('../../../scripts/architecture/reportArchitectureDiff');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

function report(overrides = {}) {
    return {
        baseRef: 'origin/main',
        errors: [],
        touchedModules: {},
        newFiles: [],
        removedFiles: [],
        protectedTouched: [],
        policyDelta: {
            mayDependOnGrown: {},
            writersGrown: {},
            baselineGrown: [],
            waiversAdded: [],
            modulesChanged: false,
        },
        ...overrides,
    };
}

const RECORD = ['docs/architecture/changes/ARCH-CHANGE-001.md'];

test('ARCH-CHANGE-GATE-001 product-only changes pass without a record', () => {
    const result = classifyArchitectureChange(report({
        newFiles: ['src/todos/helper.ts'],
    }));
    assert.equal(result.classification, 'product-only');
    assert.deepEqual(result.errors, []);
});

test('ARCH-CHANGE-GATE-001 tightening (baseline shrink) passes without a record', () => {
    const result = classifyArchitectureChange(report({
        protectedTouched: ['.ci/architecture-debt-baseline.json'],
        policyDelta: {
            mayDependOnGrown: {}, writersGrown: {}, waiversAdded: [],
            baselineGrown: [], modulesChanged: true,
        },
    }));
    assert.equal(result.classification, 'tightening');
    assert.deepEqual(result.errors, []);
});

test('ARCH-CHANGE-GATE-001 controlled mutation: baseline growth without a record fails', () => {
    const result = classifyArchitectureChange(report({
        protectedTouched: ['.ci/architecture-debt-baseline.json'],
        policyDelta: {
            mayDependOnGrown: {}, writersGrown: {}, waiversAdded: [],
            baselineGrown: ['2:MOD-A->MOD-B'], modulesChanged: true,
        },
    }));
    assert.equal(result.classification, 'relaxing');
    assert.ok(result.errors.some(error => error.includes('ARCH-CHANGE')));

    const withRecord = classifyArchitectureChange(report({
        newFiles: RECORD,
        protectedTouched: ['.ci/architecture-debt-baseline.json'],
        policyDelta: {
            mayDependOn: {}, mayDependOnGrown: {}, writersGrown: {}, waiversAdded: [],
            baselineGrown: ['2:MOD-A->MOD-B'], modulesChanged: true,
        },
    }));
    assert.equal(withRecord.classification, 'relaxing');
    assert.deepEqual(withRecord.errors, []);
});

test('ARCH-CHANGE-GATE-001 controlled mutation: broadening mayDependOn without a record fails', () => {
    const result = classifyArchitectureChange(report({
        protectedTouched: ['docs/testing/architecture-modules.json'],
        policyDelta: {
            mayDependOnGrown: { 'MOD-A': ['MOD-B'] }, writersGrown: {},
            baselineGrown: [], waiversAdded: [], modulesChanged: true,
        },
    }));
    assert.equal(result.classification, 'relaxing');
    assert.ok(result.errors.some(error => error.includes('ARCH-CHANGE')));
});

test('ARCH-CHANGE-GATE-001 controlled mutation: growing a writer set without a record fails', () => {
    const result = classifyArchitectureChange(report({
        protectedTouched: ['docs/testing/architecture-invariants.json'],
        policyDelta: {
            mayDependOnGrown: {}, writersGrown: { 'ARCH-X-001': ['src/new-writer.ts'] },
            baselineGrown: [], waiversAdded: [], modulesChanged: true,
        },
    }));
    assert.equal(result.classification, 'relaxing');
    assert.ok(result.errors.length > 0);
});

test('ARCH-CHANGE-GATE-001 controlled mutation: adding a waiver without a record fails', () => {
    const result = classifyArchitectureChange(report({
        protectedTouched: ['docs/testing/architecture-waivers.json'],
        policyDelta: {
            mayDependOnGrown: {}, writersGrown: {},
            baselineGrown: [], waiversAdded: ['ARCH-WAIVER-009'], modulesChanged: true,
        },
    }));
    assert.equal(result.classification, 'relaxing');
    assert.ok(result.errors.length > 0);
});

test('ARCH-CHANGE-GATE-001 controlled mutation: registry re-partition without a record fails', () => {
    const result = classifyArchitectureChange(report({
        protectedTouched: ['docs/testing/architecture-modules.json'],
        policyDelta: {
            mayDependOnGrown: {}, writersGrown: {},
            baselineGrown: [], waiversAdded: [], modulesChanged: true,
        },
    }));
    assert.equal(result.classification, 're-partition');
    assert.ok(result.errors.some(error => error.includes('ARCH-CHANGE')));

    const withRecord = classifyArchitectureChange(report({
        newFiles: RECORD,
        protectedTouched: ['docs/testing/architecture-modules.json'],
        policyDelta: {
            mayDependOnGrown: {}, writersGrown: {},
            baselineGrown: [], waiversAdded: [], modulesChanged: true,
        },
    }));
    assert.equal(withRecord.classification, 're-partition');
    assert.deepEqual(withRecord.errors, []);
});

// ── collectArchitectureDiff with a fake git ──────────────────────────

function fakeGit(root, { changed, atBase = {} }) {
    return {
        changedFiles: () => changed,
        fileAt: (ref, relativePath) => {
            if (ref === 'base') { return atBase[relativePath] ?? null; }
            const absolute = path.join(root, relativePath);
            return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null;
        },
    };
}

test('ARCH-CHANGE-GATE-001 the report maps changed files to modules and detects policy growth', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-diff-'));
    fs.mkdirSync(path.join(root, 'src/alpha'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src/beta'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs/testing'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/alpha/a.ts'), '// a\n');
    fs.writeFileSync(path.join(root, 'src/beta/b.ts'), '// b\n');
    const moduleEntry = (id, root_) => ({
        id, title: id, purpose: 'fixture',
        source: { include: [`${root_}/**`], exclude: [] },
        publicEntrypoints: [`${root_}/**`],
        mayDependOn: [], roles: [{ role: 'application', include: [`${root_}/**`] }],
        productCapabilities: ['MAIN-TEST-001'],
    });
    fs.writeFileSync(path.join(root, 'docs/testing/architecture-modules.json'), JSON.stringify({
        version: 1, scope: { roots: ['src'] },
        modules: [moduleEntry('MOD-ALPHA', 'src/alpha'), moduleEntry('MOD-BETA', 'src/beta')],
    }));
    fs.writeFileSync(path.join(root, 'docs/testing/main-capability-coverage.json'),
        JSON.stringify({ version: 1, capabilities: [{ id: 'MAIN-TEST-001' }] }));

    const baseRegistry = {
        version: 1, scope: { roots: ['src'] },
        modules: [
            { ...moduleEntry('MOD-ALPHA', 'src/alpha') },
            { ...moduleEntry('MOD-BETA', 'src/beta') },
        ],
    };
    // Head broadens MOD-ALPHA's mayDependOn relative to the base.
    const headRegistry = JSON.parse(fs.readFileSync(
        path.join(root, 'docs/testing/architecture-modules.json'), 'utf8'));
    headRegistry.modules[0].mayDependOn = ['MOD-BETA'];
    fs.writeFileSync(path.join(root, 'docs/testing/architecture-modules.json'),
        JSON.stringify(headRegistry, null, 4) + '\n');
    const report = collectArchitectureDiff({
        rootDirectory: root,
        baseRef: 'base',
        git: fakeGit(root, {
            changed: [
                { status: 'M', path: 'src/alpha/a.ts' },
                { status: 'A', path: 'src/beta/new.ts' },
                { status: 'M', path: 'docs/testing/architecture-modules.json' },
            ],
            atBase: {
                'docs/testing/architecture-modules.json': JSON.stringify(baseRegistry, null, 4) + '\n',
            },
        }),
    });
    assert.deepEqual(Object.keys(report.touchedModules), ['MOD-ALPHA']);
    assert.deepEqual(report.newFiles, ['src/beta/new.ts']);
    assert.deepEqual(report.protectedTouched, ['docs/testing/architecture-modules.json']);
    assert.deepEqual(report.policyDelta.mayDependOnGrown, { 'MOD-ALPHA': ['MOD-BETA'] });
    assert.equal(report.policyDelta.modulesChanged, true);
    const { classification, errors } = classifyArchitectureChange(report);
    assert.equal(classification, 'relaxing');
    assert.ok(errors.some(error => error.includes('ARCH-CHANGE')));
});
