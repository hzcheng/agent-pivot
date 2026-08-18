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
    return {
        version: 1,
        states: ['legacy', 'inventoried', 'characterized', 'guarded', 'migrating', 'strict'],
        modules: { 'MOD-ALPHA': { state, since: 'fixture', evidence: [], nextAction: 'none' } },
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
