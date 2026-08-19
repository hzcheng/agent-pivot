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
const {
    fingerprintFields,
} = require('../../../scripts/architecture/architectureChangeRecords');

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
            invariantChanges: {},
            invariantsRemoved: [],
            baselineGrown: [],
            waiversAdded: [],
            modulesChanged: false,
        },
        ...overrides,
    };
}

const RECORD = ['docs/architecture/changes/ARCH-CHANGE-001.md'];

// Field fingerprints are sha256 hex; fixture values just need to match
// between the report and the record.
const FP_BEFORE = 'a'.repeat(64);
const FP_AFTER = 'b'.repeat(64);

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
            mayDependOnGrown: {}, invariantChanges: {}, invariantsRemoved: [], waiversAdded: [],
            baselineGrown: [], modulesChanged: true,
        },
    }));
    assert.equal(result.classification, 'tightening');
    assert.deepEqual(result.errors, []);
});

test('ARCH-CHANGE-GATE-001 tightening (pure writer removal) passes without a record (review R9)', () => {
    const result = classifyArchitectureChange(report({
        protectedTouched: ['docs/testing/architecture-invariants.json'],
        policyDelta: {
            mayDependOnGrown: {},
            invariantChanges: {
                'ARCH-X-001': {
                    fields: ['writers'],
                    writersAdded: [],
                    writersRemoved: ['src/old-writer.ts'],
                    before: FP_BEFORE,
                    after: FP_AFTER,
                },
            },
            invariantsRemoved: [], waiversAdded: [],
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
            mayDependOnGrown: {}, invariantChanges: {}, invariantsRemoved: [], waiversAdded: [],
            baselineGrown: ['2:MOD-A->MOD-B'], modulesChanged: true,
        },
    }));
    assert.equal(result.classification, 'relaxing');
    assert.ok(result.errors.some(error => error.includes('architecture approval')));
});

test('ARCH-CHANGE-GATE-001 controlled mutation: broadening mayDependOn without a record fails', () => {
    const result = classifyArchitectureChange(report({
        protectedTouched: ['docs/testing/architecture-modules.json'],
        policyDelta: {
            mayDependOnGrown: { 'MOD-A': ['MOD-B'] }, invariantChanges: {}, invariantsRemoved: [],
            baselineGrown: [], waiversAdded: [], modulesChanged: true,
        },
    }));
    assert.equal(result.classification, 'relaxing');
    assert.ok(result.errors.some(error => error.includes('architecture approval')));
});

test('ARCH-CHANGE-GATE-001 owner architecture approval authorizes the relaxation', () => {
    // Harness Simplification: `approve-architecture <full-head-sha>` is the
    // only authorization after record machine authorization was deleted. The
    // caller verifies the comment binds the exact head; the classifier only
    // receives the verdict.
    const approved = classifyArchitectureChange(report({
        protectedTouched: ['docs/testing/architecture-modules.json'],
        policyDelta: {
            mayDependOnGrown: { 'MOD-A': ['MOD-B'] }, invariantChanges: {}, invariantsRemoved: [],
            baselineGrown: [], waiversAdded: [], modulesChanged: true,
        },
    }), { architectureApproved: true });
    assert.equal(approved.classification, 'relaxing',
        'the classification is computed from the diff, never weakened by the approval');
    assert.deepEqual(approved.errors, []);

    const unapproved = classifyArchitectureChange(report({
        protectedTouched: ['docs/testing/architecture-modules.json'],
        policyDelta: {
            mayDependOnGrown: { 'MOD-A': ['MOD-B'] }, invariantChanges: {}, invariantsRemoved: [],
            baselineGrown: [], waiversAdded: [], modulesChanged: true,
        },
    }), { architectureApproved: false });
    assert.ok(unapproved.errors.some(error => error.includes('anti-self-amendment')));
});

test('ARCH-CHANGE-GATE-001 controlled mutation: a same-size writer replacement is relaxing (review R9)', () => {
    const result = classifyArchitectureChange(report({
        protectedTouched: ['docs/testing/architecture-invariants.json'],
        policyDelta: {
            mayDependOnGrown: {},
            invariantChanges: {
                'ARCH-X-001': {
                    fields: ['writers'],
                    writersAdded: ['src/new-writer.ts'],
                    writersRemoved: ['src/old-writer.ts'],
                    before: FP_BEFORE,
                    after: FP_AFTER,
                },
            },
            invariantsRemoved: [], baselineGrown: [], waiversAdded: [], modulesChanged: true,
        },
    }));
    assert.equal(result.classification, 'relaxing');
    assert.ok(result.errors.length > 0);
});

test('ARCH-CHANGE-GATE-001 controlled mutation: authority, statement, and state-family edits are relaxing (review R9)', () => {
    for (const [field, flag] of [
        ['authority', 'authorityChanged'],
        ['statement', 'statementChanged'],
        ['linearizationPoint', 'linearizationPointChanged'],
        ['stateFamily', 'stateFamilyChanged'],
        ['participatingModules', 'participatingModulesChanged'],
    ]) {
        const result = classifyArchitectureChange(report({
            protectedTouched: ['docs/testing/architecture-invariants.json'],
            policyDelta: {
                mayDependOnGrown: {},
                invariantChanges: {
                    'ARCH-X-001': {
                        fields: [field], [flag]: true,
                        before: FP_BEFORE, after: FP_AFTER,
                    },
                },
                invariantsRemoved: [], baselineGrown: [], waiversAdded: [], modulesChanged: true,
            },
        }));
        assert.equal(result.classification, 'relaxing', field);
        assert.ok(result.errors.length > 0, field);
    }
});

test('ARCH-CHANGE-GATE-001 controlled mutation: removing an invariant is relaxing (review R9)', () => {
    const result = classifyArchitectureChange(report({
        protectedTouched: ['docs/testing/architecture-invariants.json'],
        policyDelta: {
            mayDependOnGrown: {}, invariantChanges: {},
            invariantsRemoved: ['ARCH-X-001'],
            baselineGrown: [], waiversAdded: [], modulesChanged: true,
        },
    }));
    assert.equal(result.classification, 'relaxing');
    assert.ok(result.errors.length > 0);
});

test('ARCH-CHANGE-GATE-001 controlled mutation: growing a writer set without a record fails', () => {
    const result = classifyArchitectureChange(report({
        protectedTouched: ['docs/testing/architecture-invariants.json'],
        policyDelta: {
            mayDependOnGrown: {},
            invariantChanges: {
                'ARCH-X-001': {
                    fields: ['writers'],
                    writersAdded: ['src/new-writer.ts'],
                    before: FP_BEFORE,
                    after: FP_AFTER,
                },
            },
            invariantsRemoved: [], baselineGrown: [], waiversAdded: [], modulesChanged: true,
        },
    }));
    assert.equal(result.classification, 'relaxing');
    assert.ok(result.errors.length > 0);
});

test('ARCH-CHANGE-GATE-001 controlled mutation: adding a waiver without a record fails', () => {
    const result = classifyArchitectureChange(report({
        protectedTouched: ['docs/testing/architecture-waivers.json'],
        policyDelta: {
            mayDependOnGrown: {}, invariantChanges: {}, invariantsRemoved: [],
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
            mayDependOnGrown: {}, invariantChanges: {}, invariantsRemoved: [],
            baselineGrown: [], waiversAdded: [], modulesChanged: true,
        },
    }));
    assert.equal(result.classification, 're-partition');
    assert.ok(result.errors.some(error => error.includes('architecture approval')));
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
    assert.ok(result.errors.some(error => error.includes('architecture approval')));
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

function fakeGit(root, { changed, atBase = {}, baseRecords = [] }) {
    return {
        changedFiles: () => changed,
        fileAt: (ref, relativePath) => {
            if (ref === 'base') { return atBase[relativePath] ?? null; }
            const absolute = path.join(root, relativePath);
            return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null;
        },
        listFiles: (ref, prefix) => (ref === 'base' && prefix.startsWith('docs/architecture/changes')
            ? baseRecords : []),
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
    assert.ok(errors.some(error => error.includes('architecture approval')));
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
            invariantChanges: {
                'ARCH-X-001': { fields: ['writers'], writersAdded: ['src/writer.ts'] },
            },
            invariantsRemoved: [],
            baselineGrown: ['2:MOD-A->MOD-B'],
            waiversAdded: ['ARCH-WAIVER-009'],
            modulesChanged: true,
        },
    });
    for (const fragment of [
        'MOD-ALPHA', 'src/alpha/new.ts', 'src/alpha/old.ts',
        'architecture-modules.json', 'mayDependOn broadened: MOD-ALPHA += MOD-BETA',
        'invariant changed: ARCH-X-001 (writers += src/writer.ts)',
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
        listFiles: () => [],
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
    assert.deepEqual(report.policyDelta.invariantChanges, {
        'ARCH-TEST-001': {
            fields: ['writers'],
            before: fingerprintFields({ writers: ['src/alpha/a.ts'] }),
            after: fingerprintFields({ writers: ['src/alpha/a.ts', 'src/alpha/b.ts'] }),
            writersAdded: ['src/alpha/b.ts'],
            writersRemoved: [],
            authorityChanged: false,
            statementChanged: false,
            linearizationPointChanged: false,
            stateFamilyChanged: false,
            participatingModulesChanged: false,
        },
    });
    assert.deepEqual(report.policyDelta.waiversAdded, ['ARCH-WAIVER-009']);
    assert.deepEqual(report.policyDelta.baselineGrown, ['2:MOD-A->MOD-B']);

    // Review R9 (Important 4): a same-size writer replacement is a semantic
    // change, not a tightening — only a pure removal with an unchanged
    // authority shrinks the writer set.
    write('docs/testing/architecture-invariants.json', {
        version: 1,
        invariants: [{ ...invariant, writers: ['src/alpha/coordinator.ts'] }],
    });
    // Reset the waiver/baseline growth from the first half of this test so
    // the invariant-only classifications below are not contaminated.
    write('docs/testing/architecture-waivers.json', { version: 1, waivers: [] });
    write('.ci/architecture-debt-baseline.json',
        { version: 1, rules: { 'module-cycle': { fingerprints: [] } } });
    const moved = collectArchitectureDiff({ rootDirectory: root, baseRef: 'base', git });
    assert.deepEqual(moved.policyDelta.invariantChanges['ARCH-TEST-001'].writersAdded,
        ['src/alpha/coordinator.ts']);
    assert.deepEqual(moved.policyDelta.invariantChanges['ARCH-TEST-001'].writersRemoved,
        ['src/alpha/a.ts']);
    assert.equal(
        classifyArchitectureChange(moved).classification, 'relaxing',
        'a replaced writer is relaxing, never silently tightening');
    write('docs/testing/architecture-invariants.json', {
        version: 1,
        invariants: [{ ...invariant, writers: [] }],
    });
    const shrunk = collectArchitectureDiff({ rootDirectory: root, baseRef: 'base', git });
    assert.deepEqual(shrunk.policyDelta.invariantChanges['ARCH-TEST-001'].writersRemoved,
        ['src/alpha/a.ts']);
    assert.equal(classifyArchitectureChange(shrunk).classification, 'tightening',
        'a pure writer removal is the only tightening form');
    // Authority, statement, and removal detection.
    write('docs/testing/architecture-invariants.json', {
        version: 1,
        invariants: [{ ...invariant, authority: { path: 'src/alpha/a.ts', symbol: 'b' } }],
    });
    const authorityMoved = collectArchitectureDiff({ rootDirectory: root, baseRef: 'base', git });
    assert.deepEqual(authorityMoved.policyDelta.invariantChanges['ARCH-TEST-001'].fields,
        ['authority']);
    write('docs/testing/architecture-invariants.json', { version: 1, invariants: [] });
    const removed = collectArchitectureDiff({ rootDirectory: root, baseRef: 'base', git });
    assert.deepEqual(removed.policyDelta.invariantsRemoved, ['ARCH-TEST-001']);
    // (guardSemantics removed in PR #296)
    //         'removed invariants keep the base record for the coverage fingerprint');
});

test('ARCH-CHANGE-GATE-001 the harness delta detects removed guard ids, invocations, and shrunk mutation tests', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-diff-harness-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs/testing'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/a.ts'), '// a\n');
    fs.writeFileSync(path.join(root, 'docs/testing/architecture-modules.json'), JSON.stringify({
        version: 1, scope: { roots: ['src'] },
        modules: [{
            id: 'MOD-ALPHA', title: 'A', purpose: 'fixture',
            source: { include: ['src/**'], exclude: [] }, publicEntrypoints: ['src/**'],
            mayDependOn: [], roles: [{ role: 'application', include: ['src/**'] }],
            productCapabilities: ['MAIN-TEST-001'],
        }],
    }));
    fs.writeFileSync(path.join(root, 'docs/testing/main-capability-coverage.json'),
        JSON.stringify({ version: 1, capabilities: [{ id: 'MAIN-TEST-001' }] }));
    const headGuards = "class G { 'ARCH-ONE-001'(root) {} }";
    const baseGuards = "class G { 'ARCH-ONE-001'(root) {} 'ARCH-TWO-001'(root) {} }";
    const headPkg = JSON.stringify({ scripts: { 'test:architecture-policy': "node scripts/architecture/checkClosedWorld.js" } });
    const basePkg = JSON.stringify({ scripts: { 'test:architecture-policy': "node scripts/architecture/checkClosedWorld.js && node scripts/architecture/checkModuleBoundaries.js" } });
    const headTests = '// controlled mutation\n';
    const baseTests = '// controlled mutation\n// controlled mutation\n// controlled mutation\n';
    const git = {
        changedFiles: () => [
            { status: 'M', path: 'scripts/run-architecture-guards.js' },
            { status: 'M', path: 'package.json' },
            { status: 'M', path: 'tests/unit/architecture/moduleBoundaries.test.js' },
            { status: 'D', path: 'scripts/architecture/checkWebviewManifest.js' },
        ],
        listFiles: () => [],
        fileAt: (ref, relativePath) => {
            if (relativePath.endsWith('run-architecture-guards.js')) {
                return ref === 'base' ? baseGuards : headGuards;
            }
            if (relativePath === 'package.json') { return ref === 'base' ? basePkg : headPkg; }
            if (relativePath.endsWith('moduleBoundaries.test.js')) {
                return ref === 'base' ? baseTests : headTests;
            }
            return null;
        },
    };
    const report = collectArchitectureDiff({ rootDirectory: root, baseRef: 'base', git });
    assert.deepEqual(report.harnessDelta.deletedFiles,
        ['scripts/architecture/checkWebviewManifest.js']);
    assert.deepEqual(report.harnessDelta.removedGuardIds, ['ARCH-TWO-001']);
    assert.deepEqual(report.harnessDelta.removedInvocations,
        ['package.json: node scripts/architecture/checkModuleBoundaries.js']);
    assert.deepEqual(report.harnessDelta.shrunkMutationTests,
        ['tests/unit/architecture/moduleBoundaries.test.js: 3 -> 1']);
    const { classification, errors } = classifyArchitectureChange(report);
    assert.equal(classification, 'relaxing');
    assert.ok(errors.some(error => error.includes('architecture approval')));
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

// ── review R9: entrypoint and ledger policy deltas (collect level) ────

test('ARCH-CHANGE-GATE-001 the policy delta computes entrypoint growth and ledger regressions', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-diff-ledger-'));
    const write = (relative, value) => {
        fs.mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
        fs.writeFileSync(path.join(root, relative),
            typeof value === 'string' ? value : JSON.stringify(value, null, 4) + '\n');
    };
    write('src/alpha/a.ts', '// a\n');
    const moduleEntry = entrypoints => ({
        id: 'MOD-ALPHA', title: 'A', purpose: 'fixture',
        source: { include: ['src/**'], exclude: [] }, publicEntrypoints: entrypoints,
        mayDependOn: [], roles: [{ role: 'application', include: ['src/**'] }],
        productCapabilities: ['MAIN-TEST-001'],
    });
    write('docs/testing/architecture-modules.json', {
        version: 1, scope: { roots: ['src'] }, modules: [moduleEntry(['src/**'])],
    });
    write('docs/testing/main-capability-coverage.json',
        { version: 1, capabilities: [{ id: 'MAIN-TEST-001' }] });
    const ledger = modules => ({
        version: 1,
        states: ['legacy', 'inventoried', 'characterized', 'guarded', 'migrating', 'strict'],
        modules,
    });
    write('docs/testing/architecture-program.json', ledger({
        'MOD-ALPHA': { state: 'migrating', since: 'x', evidence: [], nextAction: 'y' },
    }));
    let changed = [
        { status: 'M', path: 'docs/testing/architecture-modules.json' },
        { status: 'M', path: 'docs/testing/architecture-program.json' },
    ];
    const git = {
        changedFiles: () => changed,
        listFiles: () => [],
        fileAt: (ref, relativePath) => {
            if (ref !== 'base') {
                const absolute = path.join(root, relativePath);
                return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null;
            }
            if (relativePath.endsWith('architecture-modules.json')) {
                return JSON.stringify({ version: 1, scope: { roots: ['src'] }, modules: [moduleEntry(['src/**'])] });
            }
            return JSON.stringify(ledger({
                'MOD-ALPHA': { state: 'guarded', since: 'x', evidence: [], nextAction: 'y' },
            }));
        },
    };
    // Head broadens the entrypoints and regresses the ledger state.
    write('docs/testing/architecture-modules.json', {
        version: 1, scope: { roots: ['src'] }, modules: [moduleEntry(['src/**', 'src/new-entry.ts'])],
    });
    write('docs/testing/architecture-program.json', ledger({
        'MOD-ALPHA': { state: 'inventoried', since: 'x', evidence: [], nextAction: 'y' },
    }));
    const report = collectArchitectureDiff({ rootDirectory: root, baseRef: 'base', git });
    assert.deepEqual(report.policyDelta.entrypointsGrown, { 'MOD-ALPHA': ['src/new-entry.ts'] });
    assert.deepEqual(report.policyDelta.ledgerRegressions, ['MOD-ALPHA: guarded -> inventoried']);
    const { classification, errors } = classifyArchitectureChange(report);
    assert.equal(classification, 'relaxing');
    assert.ok(errors.length > 0);

    // A forward ledger move alone stays tightening.
    changed = [{ status: 'M', path: 'docs/testing/architecture-program.json' }];
    write('docs/testing/architecture-modules.json', {
        version: 1, scope: { roots: ['src'] }, modules: [moduleEntry(['src/**'])],
    });
    write('docs/testing/architecture-program.json', ledger({
        'MOD-ALPHA': { state: 'migrating', since: 'x', evidence: [], nextAction: 'y' },
    }));
    const forward = collectArchitectureDiff({ rootDirectory: root, baseRef: 'base', git });
    assert.deepEqual(forward.policyDelta.ledgerRegressions, []);
    assert.equal(classifyArchitectureChange(forward).classification, 'tightening');
});

test('ARCH-CHANGE-GATE-001 formatReport renders entrypoint and ledger sections', () => {
    const text = formatReport({
        baseRef: 'origin/main',
        errors: [],
        touchedModules: {},
        newFiles: [],
        removedFiles: [],
        protectedTouched: ['docs/testing/architecture-modules.json'],
        policyDelta: {
            mayDependOnGrown: {},
            entrypointsGrown: { 'MOD-A': ['src/a/entry.ts'] },
            invariantChanges: {}, invariantsRemoved: [],
            baselineGrown: [], waiversAdded: [],
            ledgerRegressions: ['MOD-A: strict -> migrating'],
            modulesChanged: true,
        },
    });
    assert.ok(text.includes('entrypoints broadened: MOD-A += src/a/entry.ts'));
    assert.ok(text.includes('ledger regression: MOD-A: strict -> migrating'));
});


// ── round-2 review Blocker 3: the record-authoring describer ─────────

test('ARCH-CHANGE-GATE-001 describeArchitectureChange prints a diff summary', () => {
    const { describeArchitectureChange } = require('../../../scripts/architecture/describeArchitectureChange');
    const result = describeArchitectureChange(repoRoot, 'HEAD');
    assert.equal(result.classification, 'product-only');
    assert.ok(Array.isArray(result.touchedModules));
    assert.ok(typeof result.policyDelta === 'object');
});
