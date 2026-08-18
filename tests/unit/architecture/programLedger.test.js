'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
    runProgramLedgerCheck,
} = require('../../../scripts/architecture/checkProgramLedger');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

function makeFixture({ ledger, baselineFingerprints = [], waiverFingerprints = [], invariants = [] }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-ledger-'));
    const writeJson = (relative, value) => {
        fs.mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
        fs.writeFileSync(path.join(root, relative), JSON.stringify(value, null, 2));
    };
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/a.ts'), '// fixture\n');
    writeJson('docs/testing/architecture-modules.json', {
        version: 1, scope: { roots: ['src'] },
        modules: [{
            id: 'MOD-ALPHA', title: 'Alpha', purpose: 'fixture',
            source: { include: ['src/**'], exclude: [] }, publicEntrypoints: ['src/**'],
            mayDependOn: [], roles: [{ role: 'application', include: ['src/**'] }],
            productCapabilities: ['MAIN-TEST-001'],
        }],
    });
    writeJson('docs/testing/main-capability-coverage.json',
        { version: 1, capabilities: [{ id: 'MAIN-TEST-001' }] });
    writeJson('docs/testing/architecture-program.json', ledger);
    writeJson('.ci/architecture-debt-baseline.json',
        { version: 1, rules: { 'module-cycle': { fingerprints: baselineFingerprints } } });
    writeJson('docs/testing/architecture-waivers.json', {
        version: 1,
        waivers: waiverFingerprints.map(fingerprint => ({
            id: 'ARCH-WAIVER-T', rule: 'module-cycle', fingerprints: [fingerprint],
            owner: 'o', reason: 'r', tracking: 't', createdAt: 'x', retiresWith: 'W', expiresAt: null,
        })),
    });
    writeJson('docs/testing/architecture-invariants.json', { version: 1, invariants });
    return root;
}

function ledgerWith(state) {
    const entry = { state, since: 'fixture', evidence: [], nextAction: 'none' };
    if (state === 'strict') {
        entry.target = { publicEntrypoints: ['src/**'] };
    }
    return {
        version: 1,
        states: ['legacy', 'inventoried', 'characterized', 'guarded', 'migrating', 'strict'],
        modules: { 'MOD-ALPHA': entry },
    };
}

const validInvariant = {
    id: 'ARCH-TEST-001', module: 'MOD-ALPHA', productCapabilities: ['MAIN-TEST-001'],
    priority: 'P0', kind: 'concurrency', statement: 'fixture',
    authority: { path: 'src/a.ts', symbol: 'a' }, writers: ['src/a.ts'],
    linearizationPoint: 'x', enforcement: ['single-writer'],
    behaviorOwners: ['src/a.ts'], guardOwners: [], evidence: [],
};

test('ARCH-PROGRAM-LEDGER-001 the real ledger is valid and the pilot module is strict-clean', () => {
    assert.deepEqual(runProgramLedgerCheck(repoRoot).errors, []);
});

test('ARCH-PROGRAM-LEDGER-001 a clean strict module passes', () => {
    const root = makeFixture({ ledger: ledgerWith('strict'), invariants: [validInvariant] });
    assert.deepEqual(runProgramLedgerCheck(root).errors, []);
});

test('ARCH-PROGRAM-LEDGER-001 controlled mutation: a registered module without a ledger entry fails', () => {
    const ledger = ledgerWith('legacy');
    ledger.modules = {};
    const root = makeFixture({ ledger });
    assert.ok(runProgramLedgerCheck(root).errors
        .some(error => error.includes('MOD-ALPHA') && error.includes('no ledger entry')));
});

test('ARCH-PROGRAM-LEDGER-001 controlled mutation: strict without a target contract fails', () => {
    const ledger = ledgerWith('strict');
    delete ledger.modules['MOD-ALPHA'].target;
    const root = makeFixture({ ledger, invariants: [validInvariant] });
    assert.ok(runProgramLedgerCheck(root).errors
        .some(error => error.includes('target.publicEntrypoints')));
});

test('ARCH-PROGRAM-LEDGER-001 controlled mutation: a target contract mismatched with the registry fails', () => {
    const ledger = ledgerWith('strict');
    ledger.modules['MOD-ALPHA'].target = { publicEntrypoints: ['src/public-only.ts'] };
    const root = makeFixture({ ledger, invariants: [validInvariant] });
    assert.ok(runProgramLedgerCheck(root).errors
        .some(error => error.includes('do not match the registry')));
});

test('ARCH-PROGRAM-LEDGER-001 controlled mutation: strict with a deep import into internals fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-ledger-deep-'));
    const writeJson = (relative, value) => {
        fs.mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
        fs.writeFileSync(path.join(root, relative), JSON.stringify(value, null, 2));
    };
    fs.mkdirSync(path.join(root, 'src/alpha'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src/beta'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/alpha/index.ts'), 'export {};' + '\n');
    fs.writeFileSync(path.join(root, 'src/alpha/internal.ts'), 'export {};' + '\n');
    fs.writeFileSync(path.join(root, 'src/beta/b.ts'),
        'import {} from "../alpha/internal";' + '\n' + 'export {};' + '\n');
    writeJson('docs/testing/architecture-modules.json', {
        version: 1, scope: { roots: ['src'] },
        modules: [
            {
                id: 'MOD-ALPHA', title: 'A', purpose: 'fixture',
                source: { include: ['src/alpha/**'], exclude: [] },
                publicEntrypoints: ['src/alpha/index.ts'],
                mayDependOn: [], roles: [{ role: 'application', include: ['src/alpha/**'] }],
                productCapabilities: ['MAIN-TEST-001'],
            },
            {
                id: 'MOD-BETA', title: 'B', purpose: 'fixture',
                source: { include: ['src/beta/**'], exclude: [] },
                publicEntrypoints: ['src/beta/**'],
                mayDependOn: ['MOD-ALPHA'],
                roles: [{ role: 'application', include: ['src/beta/**'] }],
                productCapabilities: ['MAIN-TEST-001'],
            },
        ],
    });
    writeJson('docs/testing/main-capability-coverage.json',
        { version: 1, capabilities: [{ id: 'MAIN-TEST-001' }] });
    const ledger = ledgerWith('strict');
    ledger.modules['MOD-ALPHA'].target = { publicEntrypoints: ['src/alpha/index.ts'] };
    ledger.modules['MOD-BETA'] = { state: 'legacy', since: 'fixture', evidence: [], nextAction: 'x' };
    writeJson('docs/testing/architecture-program.json', ledger);
    writeJson('.ci/architecture-debt-baseline.json',
        { version: 1, rules: { 'module-cycle': { fingerprints: [] } } });
    writeJson('docs/testing/architecture-waivers.json', { version: 1, waivers: [] });
    writeJson('docs/testing/architecture-invariants.json', { version: 1, invariants: [validInvariant] });
    assert.ok(runProgramLedgerCheck(root).errors
        .some(error => error.includes('MOD-ALPHA') && error.includes('deep-import')));
});

test('ARCH-PROGRAM-LEDGER-001 controlled mutation: strict with a naming baseline entry fails', () => {
    const root = makeFixture({
        ledger: ledgerWith('strict'),
        baselineFingerprints: ['2:MOD-ALPHA->MOD-BETA'],
        waiverFingerprints: ['2:MOD-ALPHA->MOD-BETA'],
        invariants: [validInvariant],
    });
    assert.ok(runProgramLedgerCheck(root).errors
        .some(error => error.includes('MOD-ALPHA') && error.includes('baseline entry')));
});

test('ARCH-PROGRAM-LEDGER-001 controlled mutation: strict with a naming waiver fails', () => {
    const root = makeFixture({
        ledger: ledgerWith('strict'),
        waiverFingerprints: ['scc:MOD-ALPHA|MOD-BETA'],
        invariants: [validInvariant],
    });
    assert.ok(runProgramLedgerCheck(root).errors
        .some(error => error.includes('waiver-covered')));
});

test('ARCH-PROGRAM-LEDGER-001 controlled mutation: strict with a P0 invariant lacking behavior owner fails', () => {
    const root = makeFixture({
        ledger: ledgerWith('strict'),
        invariants: [{ ...validInvariant, behaviorOwners: [] }],
    });
    assert.ok(runProgramLedgerCheck(root).errors
        .some(error => error.includes('ARCH-TEST-001') && error.includes('no behavior owner')));
});

test('ARCH-PROGRAM-LEDGER-001 controlled mutation: strict with classification errors fails', () => {
    // An unclassified file in the fixture breaks exact-once; strict must fail.
    const root = makeFixture({ ledger: ledgerWith('strict'), invariants: [validInvariant] });
    fs.writeFileSync(path.join(root, 'src/a.py'), '# unknown file kind\n');
    const { errors } = runProgramLedgerCheck(root);
    assert.ok(errors.some(error => error.includes('MOD-ALPHA')
        && error.includes('closed-world')), JSON.stringify(errors));
});

test('ARCH-PROGRAM-LEDGER-001 controlled mutation: unknown module and unknown state fail', () => {
    const bad = ledgerWith('strict');
    bad.modules['MOD-GHOST'] = { state: 'strict', since: 'x', evidence: [], nextAction: 'x' };
    const root = makeFixture({ ledger: bad, invariants: [validInvariant] });
    assert.ok(runProgramLedgerCheck(root).errors
        .some(error => error.includes('MOD-GHOST') && error.includes('not a registered module')));

    const unknownState = ledgerWith('halfway');
    const root2 = makeFixture({ ledger: unknownState, invariants: [validInvariant] });
    assert.ok(runProgramLedgerCheck(root2).errors
        .some(error => error.includes("unknown state 'halfway'")));
});
