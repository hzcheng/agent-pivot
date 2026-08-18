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
    defaultGit,
    formatReport,
} = require('../../../scripts/architecture/reportArchitectureDiff');
const {
    runArchitectureChangeCheck,
} = require('../../../scripts/architecture/checkArchitectureChange');

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

test('ARCH-CHANGE-GATE-001 controlled mutation: deleting a harness guard file fails', () => {
    const result = classifyArchitectureChange(report({
        harnessDelta: {
            touched: ['scripts/architecture/checkClosedWorld.js'],
            deletedFiles: ['scripts/architecture/checkClosedWorld.js'],
            removedGuardIds: [], removedInvocations: [], shrunkMutationTests: [],
        },
    }));
    assert.equal(result.classification, 'relaxing');
    assert.ok(result.errors.some(error => error.includes('ARCH-CHANGE')));
});

test('ARCH-CHANGE-GATE-001 controlled mutation: removing a guard id from the runner fails', () => {
    const result = classifyArchitectureChange(report({
        harnessDelta: {
            touched: ['scripts/run-architecture-guards.js'],
            deletedFiles: [], removedGuardIds: ['ARCH-PROTOCOL-001'],
            removedInvocations: [], shrunkMutationTests: [],
        },
    }));
    assert.equal(result.classification, 'relaxing');
    assert.ok(result.errors.length > 0);
});

test('ARCH-CHANGE-GATE-001 controlled mutation: removing a lane invocation fails', () => {
    const result = classifyArchitectureChange(report({
        harnessDelta: {
            touched: ['package.json'],
            deletedFiles: [], removedGuardIds: [],
            removedInvocations: ['package.json: node scripts/architecture/checkClosedWorld.js'],
            shrunkMutationTests: [],
        },
    }));
    assert.equal(result.classification, 'relaxing');
    assert.ok(result.errors.length > 0);
});

test('ARCH-CHANGE-GATE-001 controlled mutation: shrinking mutation tests fails', () => {
    const result = classifyArchitectureChange(report({
        harnessDelta: {
            touched: ['tests/unit/architecture/moduleBoundaries.test.js'],
            deletedFiles: [], removedGuardIds: [], removedInvocations: [],
            shrunkMutationTests: ['tests/unit/architecture/moduleBoundaries.test.js: 8 -> 4'],
        },
    }));
    assert.equal(result.classification, 'relaxing');
    assert.ok(result.errors.length > 0);
});

test('ARCH-CHANGE-GATE-001 a guard change with intact wiring classifies as tightening (its own mutation tests are the kill mechanism)', () => {
    const result = classifyArchitectureChange(report({
        harnessDelta: {
            touched: ['scripts/run-architecture-guards.js'],
            deletedFiles: [], removedGuardIds: [], removedInvocations: [],
            shrunkMutationTests: [],
        },
    }));
    assert.equal(result.classification, 'tightening');
    assert.deepEqual(result.errors, []);
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
'use strict';

test('ARCH-CHANGE-GATE-001 formatReport renders every delta section', () => {
    const text = formatReport({
        baseRef: 'origin/main',
        errors: [],
        touchedModules: { 'MOD-ALPHA': ['src/alpha/a.ts'] },
        newFiles: ['src/alpha/new.ts'],
        removedFiles: ['src/alpha/old.ts'],
        protectedTouched: ['docs/testing/architecture-modules.json'],
        policyDelta: {
            mayDependOnGrown: { 'MOD-ALPHA': ['MOD-BETA'] },
            writersGrown: { 'ARCH-X-001': ['src/writer.ts'] },
            baselineGrown: ['2:MOD-A->MOD-B'],
            waiversAdded: ['ARCH-WAIVER-009'],
            modulesChanged: true,
        },
    });
    for (const fragment of [
        'MOD-ALPHA', 'src/alpha/new.ts', 'src/alpha/old.ts',
        'architecture-modules.json', 'mayDependOn broadened: MOD-ALPHA += MOD-BETA',
        'writers broadened: ARCH-X-001 += src/writer.ts',
        'baseline grew: 2:MOD-A->MOD-B', 'waivers added: ARCH-WAIVER-009',
    ]) {
        assert.ok(text.includes(fragment), fragment);
    }
});

test('ARCH-CHANGE-GATE-001 the policy delta covers invariants, baseline, and waivers', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-diff-delta-'));
    const write = (relative, value) => {
        fs.mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
        fs.writeFileSync(path.join(root, relative),
            typeof value === 'string' ? value : JSON.stringify(value, null, 4) + '\n');
    };
    write('src/alpha/a.ts', '// a\n');
    write('docs/testing/architecture-modules.json', {
        version: 1, scope: { roots: ['src'] },
        modules: [{
            id: 'MOD-ALPHA', title: 'A', purpose: 'fixture',
            source: { include: ['src/**'], exclude: [] }, publicEntrypoints: ['src/**'],
            mayDependOn: [], roles: [{ role: 'application', include: ['src/**'] }],
            productCapabilities: ['MAIN-TEST-001'],
        }],
    });
    write('docs/testing/main-capability-coverage.json',
        { version: 1, capabilities: [{ id: 'MAIN-TEST-001' }] });
    const invariant = {
        id: 'ARCH-TEST-001', module: 'MOD-ALPHA', productCapabilities: ['MAIN-TEST-001'],
        priority: 'P1', kind: 'concurrency', statement: 'fixture',
        authority: { path: 'src/alpha/a.ts', symbol: 'a' },
        writers: ['src/alpha/a.ts'], linearizationPoint: 'x', enforcement: [],
        behaviorOwners: [], guardOwners: [], evidence: [],
    };
    write('docs/testing/architecture-invariants.json', { version: 1, invariants: [invariant] });
    write('docs/testing/architecture-waivers.json', { version: 1, waivers: [] });
    write('.ci/architecture-debt-baseline.json', { version: 1, rules: { 'module-cycle': { fingerprints: [] } } });

    const baseInvariant = { ...invariant };
    const git = {
        changedFiles: () => [
            { status: 'M', path: 'docs/testing/architecture-invariants.json' },
            { status: 'M', path: 'docs/testing/architecture-waivers.json' },
            { status: 'M', path: '.ci/architecture-debt-baseline.json' },
        ],
        fileAt: (ref, relativePath) => {
            if (ref !== 'base') {
                const absolute = path.join(root, relativePath);
                return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null;
            }
            if (relativePath.endsWith('architecture-invariants.json')) {
                return JSON.stringify({ version: 1, invariants: [baseInvariant] });
            }
            if (relativePath.endsWith('architecture-waivers.json')) {
                return JSON.stringify({ version: 1, waivers: [] });
            }
            return JSON.stringify({ version: 1, rules: { 'module-cycle': { fingerprints: [] } } });
        },
    };
    // Head adds a writer, a waiver, and a baseline fingerprint.
    const headInvariants = { version: 1, invariants: [{ ...invariant, writers: ['src/alpha/a.ts', 'src/alpha/b.ts'] }] };
    write('docs/testing/architecture-invariants.json', headInvariants);
    write('docs/testing/architecture-waivers.json', {
        version: 1, waivers: [{ id: 'ARCH-WAIVER-009', fingerprints: [], owner: 'o', reason: 'r', retiresWith: 'W' }],
    });
    write('.ci/architecture-debt-baseline.json',
        { version: 1, rules: { 'module-cycle': { fingerprints: ['2:MOD-A->MOD-B'] } } });

    const report = collectArchitectureDiff({ rootDirectory: root, baseRef: 'base', git });
    assert.deepEqual(report.policyDelta.writersGrown, { 'ARCH-TEST-001': ['src/alpha/b.ts'] });
    assert.deepEqual(report.policyDelta.waiversAdded, ['ARCH-WAIVER-009']);
    assert.deepEqual(report.policyDelta.baselineGrown, ['2:MOD-A->MOD-B']);

    // An authority move (writer set shrinks while gaining the new authority
    // file) is tightening, not broadening.
    write('docs/testing/architecture-invariants.json', {
        version: 1,
        invariants: [{ ...invariant, writers: ['src/alpha/coordinator.ts'] }],
    });
    const moved = collectArchitectureDiff({ rootDirectory: root, baseRef: 'base', git });
    assert.deepEqual(moved.policyDelta.writersGrown, {},
        'a shrunk writer set with a replacement is not broadening');
});

test('ARCH-CHANGE-GATE-001 a self-diff against HEAD is a clean product-only report', () => {
    const report = collectArchitectureDiff({
        rootDirectory: repoRoot,
        baseRef: 'HEAD',
        git: defaultGit(repoRoot),
    });
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.newFiles, []);
    assert.deepEqual(report.protectedTouched, []);
    const result = runArchitectureChangeCheck(repoRoot, 'HEAD');
    assert.equal(result.classification, 'product-only');
    assert.deepEqual(result.errors, []);
});
