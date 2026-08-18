'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
    runSingleWriterCheck,
} = require('../../../scripts/architecture/checkSingleWriters');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

function makeFixture({ invariants, sources }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-writers-'));
    const writeJson = (relative, value) => {
        fs.mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
        fs.writeFileSync(path.join(root, relative), JSON.stringify(value, null, 2));
    };
    writeJson('docs/testing/architecture-modules.json', {
        version: 1,
        scope: { roots: ['src'] },
        modules: [{
            id: 'MOD-ALPHA',
            title: 'Alpha',
            purpose: 'fixture',
            source: { include: ['src/**'], exclude: [] },
            mayDependOn: [],
            roles: [{ role: 'application', include: ['src/**'] }],
            productCapabilities: ['MAIN-TEST-001'],
        }],
    });
    writeJson('docs/testing/main-capability-coverage.json', {
        version: 1, capabilities: [{ id: 'MAIN-TEST-001' }],
    });
    writeJson('docs/testing/architecture-invariants.json', {
        version: 1, invariants,
    });
    for (const [file, content] of Object.entries(sources)) {
        fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), content);
    }
    return root;
}

function validInvariant(overrides = {}) {
    return {
        id: 'ARCH-TEST-FAMILY-001',
        module: 'MOD-ALPHA',
        productCapabilities: ['MAIN-TEST-001'],
        priority: 'P0',
        kind: 'concurrency',
        statement: 'fixture invariant',
        authority: { path: 'src/store.ts', symbol: 'Store' },
        writers: ['src/writer.ts'],
        linearizationPoint: 'fixture',
        enforcement: ['single-writer'],
        behaviorOwners: ['src/store.ts'],
        guardOwners: [],
        evidence: ['src/store.ts'],
        stateFamily: { storePath: 'src/store.ts', writeMethods: ['writeThing'] },
        ...overrides,
    };
}

const baseSources = {
    'src/store.ts': 'export class Store { writeThing() {} }\n',
    'src/writer.ts': 'import { Store } from \'./store\';\nexport const run = (s: Store) => s.writeThing();\n',
    'src/quiet.ts': 'export const nothing = 1;\n',
};

test('ARCH-INVARIANT-CATALOG-001 ARCH-SINGLE-WRITER-001 the real repository catalog validates and no state family has an undeclared writer', () => {
    const { errors } = runSingleWriterCheck(repoRoot);
    assert.deepEqual(errors, []);
});

test('ARCH-INVARIANT-CATALOG-001 a valid synthetic catalog passes', () => {
    const root = makeFixture({ invariants: [validInvariant()], sources: baseSources });
    assert.deepEqual(runSingleWriterCheck(root).errors, []);
});

test('ARCH-SINGLE-WRITER-001 controlled mutation: a writer outside the declared set fails', () => {
    const root = makeFixture({
        invariants: [validInvariant()],
        sources: {
            ...baseSources,
            'src/bypass.ts': 'import { Store } from \'./store\';\nexport const evil = (s: Store) => s.writeThing();\n',
        },
    });
    const { errors } = runSingleWriterCheck(root);
    assert.ok(errors.some(error => error.includes('src/bypass.ts')
        && error.includes('writeThing') && error.includes('ARCH-TEST-FAMILY-001')));
});

test('ARCH-SINGLE-WRITER-001 a same-named method without a store reference is not a bypass', () => {
    const root = makeFixture({
        invariants: [validInvariant()],
        sources: {
            ...baseSources,
            'src/other.ts': 'export const fine = (todoService) => todoService.writeThing();\n',
        },
    });
    assert.deepEqual(runSingleWriterCheck(root).errors, []);
});

test('ARCH-INVARIANT-CATALOG-001 controlled mutation: duplicate invariant id is rejected', () => {
    const root = makeFixture({
        invariants: [validInvariant(), validInvariant()],
        sources: baseSources,
    });
    assert.ok(runSingleWriterCheck(root).errors
        .some(error => error.includes('duplicate invariant id')));
});

test('ARCH-INVARIANT-CATALOG-001 controlled mutation: unknown module reference is rejected', () => {
    const root = makeFixture({
        invariants: [validInvariant({ module: 'MOD-NOPE' })],
        sources: baseSources,
    });
    assert.ok(runSingleWriterCheck(root).errors
        .some(error => error.includes("unknown module 'MOD-NOPE'")));
});

test('ARCH-INVARIANT-CATALOG-001 controlled mutation: unknown capability reference is rejected', () => {
    const root = makeFixture({
        invariants: [validInvariant({ productCapabilities: ['MAIN-NOPE'] })],
        sources: baseSources,
    });
    assert.ok(runSingleWriterCheck(root).errors
        .some(error => error.includes("unknown product capability 'MAIN-NOPE'")));
});

test('ARCH-INVARIANT-CATALOG-001 controlled mutation: invalid priority is rejected', () => {
    const root = makeFixture({
        invariants: [validInvariant({ priority: 'P9' })],
        sources: baseSources,
    });
    assert.ok(runSingleWriterCheck(root).errors
        .some(error => error.includes('priority must be one of')));
});

test('ARCH-INVARIANT-CATALOG-001 controlled mutation: single-writer enforcement without a state family is rejected', () => {
    const invariant = validInvariant();
    delete invariant.stateFamily;
    const root = makeFixture({ invariants: [invariant], sources: baseSources });
    assert.ok(runSingleWriterCheck(root).errors
        .some(error => error.includes('requires a stateFamily')));
});

test('ARCH-INVARIANT-CATALOG-001 controlled mutation: a missing authority path is rejected', () => {
    const root = makeFixture({
        invariants: [validInvariant({ authority: { path: 'src/nope.ts', symbol: 'Nope' } })],
        sources: baseSources,
    });
    assert.ok(runSingleWriterCheck(root).errors
        .some(error => error.includes("authority.path") && error.includes('does not exist')));
});
