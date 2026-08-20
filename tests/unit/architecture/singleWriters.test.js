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

function makeFixture({ invariants, sources, twoModules = false, entrypointGlob = null }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-writers-'));
    const writeJson = (relative, value) => {
        fs.mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
        fs.writeFileSync(path.join(root, relative), JSON.stringify(value, null, 2));
    };
    const moduleEntry = (id, glob) => ({
        id,
        title: id,
        purpose: 'fixture',
        source: { include: [glob], exclude: [] },
        publicEntrypoints: [entrypointGlob || glob],
        mayDependOn: [],
        roles: [{ role: 'application', include: [glob] }],
        productCapabilities: ['MAIN-TEST-001'],
    });
    writeJson('docs/testing/architecture-modules.json', {
        version: 1,
        scope: { roots: ['src'] },
        modules: twoModules
            ? [moduleEntry('MOD-ALPHA', 'src/alpha/**'), moduleEntry('MOD-BETA', 'src/beta/**')]
            : [moduleEntry('MOD-ALPHA', 'src/**')],
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


// ── review R7: AST-hardened writer detection ─────────────────────────

function familyWithKeys(keys) {
    return validInvariant({
        stateFamily: {
            storePath: 'src/store.ts',
            writeMethods: ['writeThing'],
            persistenceKeys: keys,
        },
    });
}

test('ARCH-SINGLE-WRITER-001 controlled mutation: element access cannot launder a write', () => {
    const root = makeFixture({
        invariants: [validInvariant()],
        sources: {
            ...baseSources,
            'src/bypass.ts': 'import { Store } from \'./store\';\n'
                + 'export const evil = (s: Store) => s[\'writeThing\']();\n',
        },
    });
    assert.ok(runSingleWriterCheck(root).errors
        .some(error => error.includes('src/bypass.ts') && error.includes('typed receiver')));
});

test('ARCH-SINGLE-WRITER-001 controlled mutation: destructuring cannot launder a write', () => {
    const root = makeFixture({
        invariants: [validInvariant()],
        sources: {
            ...baseSources,
            'src/bypass.ts': 'import { Store } from \'./store\';\n'
                + 'export const evil = (s: Store) => { const { writeThing } = s; writeThing(); };\n',
        },
    });
    assert.ok(runSingleWriterCheck(root).errors
        .some(error => error.includes('src/bypass.ts') && error.includes('destructures')));
});

test('ARCH-SINGLE-WRITER-001 controlled mutation: aliased destructuring cannot launder a write', () => {
    const root = makeFixture({
        invariants: [validInvariant()],
        sources: {
            ...baseSources,
            'src/bypass.ts': 'import { Store } from \'./store\';\n'
                + 'export const evil = (s: Store) => { const { writeThing: wt } = s; wt(); };\n',
        },
    });
    assert.ok(runSingleWriterCheck(root).errors
        .some(error => error.includes('src/bypass.ts') && error.includes('destructures')));
});

test('ARCH-SINGLE-WRITER-001 controlled mutation: bind extraction cannot launder a write', () => {
    const root = makeFixture({
        invariants: [validInvariant()],
        sources: {
            ...baseSources,
            'src/bypass.ts': 'import { Store } from \'./store\';\n'
                + 'export const evil = (s: Store) => { const write = s.writeThing.bind(s); write(); };\n',
        },
    });
    assert.ok(runSingleWriterCheck(root).errors
        .some(error => error.includes('src/bypass.ts') && error.includes('writeThing')));
});

test('ARCH-SINGLE-WRITER-001 controlled mutation: an import alias cannot launder a write', () => {
    const root = makeFixture({
        invariants: [validInvariant()],
        sources: {
            ...baseSources,
            'src/bypass.ts': 'import { Store as Manifest } from \'./store\';\n'
                + 'export const evil = (s: Manifest) => s.writeThing();\n',
        },
    });
    assert.ok(runSingleWriterCheck(root).errors
        .some(error => error.includes('src/bypass.ts') && error.includes('writeThing')));
});

test('ARCH-SINGLE-WRITER-001 controlled mutation: a persistence-key reference outside the store fails', () => {
    const root = makeFixture({
        invariants: [familyWithKeys(['agentPivot.fixture.v1'])],
        sources: {
            'src/store.ts': 'const KEY = \'agentPivot.fixture.v1\';\nexport class Store { writeThing() {} }\n',
            'src/writer.ts': 'import { Store } from \'./store\';\nexport const run = (s: Store) => s.writeThing();\n',
            'src/quiet.ts': 'export const nothing = 1;\n',
            'src/bypass.ts': 'export const rawKey = \'agentPivot.fixture.v1\';\n',
        },
    });
    assert.ok(runSingleWriterCheck(root).errors
        .some(error => error.includes('src/bypass.ts') && error.includes('persistence key')));
});

test('ARCH-SINGLE-WRITER-001 a persistence key referenced only inside the store passes', () => {
    const root = makeFixture({
        invariants: [familyWithKeys(['agentPivot.fixture.v1'])],
        sources: {
            'src/store.ts': 'const KEY = \'agentPivot.fixture.v1\';\nexport class Store { writeThing() {} }\n',
            'src/writer.ts': 'import { Store } from \'./store\';\nexport const run = (s: Store) => s.writeThing();\n',
            'src/quiet.ts': 'export const nothing = 1;\n',
        },
    });
    assert.deepEqual(runSingleWriterCheck(root).errors, []);
});

test('ARCH-INVARIANT-CATALOG-001 controlled mutation: malformed persistenceKeys are rejected', () => {
    const empty = makeFixture({
        invariants: [familyWithKeys([])],
        sources: baseSources,
    });
    assert.ok(runSingleWriterCheck(empty).errors
        .some(error => error.includes('persistenceKeys must be a non-empty array')));
    const stale = makeFixture({
        invariants: [familyWithKeys(['agentPivot.absent.v1'])],
        sources: baseSources,
    });
    assert.ok(runSingleWriterCheck(stale).errors
        .some(error => error.includes('persistence key') && error.includes('does not appear')));
});


// ── review R9: authority rigor (Important 3) ─────────────────────────

const twoModuleSources = {
    'src/alpha/store.ts': 'export class Store { writeThing() {} }\n',
    'src/alpha/writer.ts': 'import { Store } from \'./store\';\nexport const run = (s: Store) => s.writeThing();\n',
    'src/beta/kernel.ts': 'export function sharedCodec() { return 1; }\n',
    'src/beta/reExports.ts': 'export { sharedCodec } from \'./kernel\';\n',
};

function twoModuleInvariant(overrides = {}) {
    return validInvariant({
        authority: { path: 'src/beta/kernel.ts', symbol: 'sharedCodec' },
        writers: ['src/alpha/writer.ts'],
        participatingModules: ['MOD-BETA'],
        behaviorOwners: ['src/alpha/store.ts'],
        evidence: ['src/alpha/store.ts'],
        stateFamily: { storePath: 'src/alpha/store.ts', writeMethods: ['writeThing'] },
        ...overrides,
    });
}

test('ARCH-INVARIANT-CATALOG-001 a declared cross-module authority passes', () => {
    const root = makeFixture({
        invariants: [twoModuleInvariant()],
        sources: twoModuleSources,
        twoModules: true,
    });
    assert.deepEqual(runSingleWriterCheck(root).errors, []);
});

test('ARCH-INVARIANT-CATALOG-001 controlled mutation: a re-exported authority symbol fails', () => {
    const root = makeFixture({
        invariants: [twoModuleInvariant({
            authority: { path: 'src/beta/reExports.ts', symbol: 'sharedCodec' },
        })],
        sources: twoModuleSources,
        twoModules: true,
    });
    assert.ok(runSingleWriterCheck(root).errors
        .some(error => error.includes('reExports.ts') && error.includes('re-export is not an authority')));
});

test('ARCH-INVARIANT-CATALOG-001 controlled mutation: an undeclared cross-module authority fails', () => {
    const invariant = twoModuleInvariant();
    delete invariant.participatingModules;
    const root = makeFixture({
        invariants: [invariant],
        sources: twoModuleSources,
        twoModules: true,
    });
    assert.ok(runSingleWriterCheck(root).errors
        .some(error => error.includes('MOD-BETA') && error.includes('participatingModules')));
});

test('ARCH-INVARIANT-CATALOG-001 controlled mutation: an unknown participating module fails', () => {
    const root = makeFixture({
        invariants: [twoModuleInvariant({ participatingModules: ['MOD-NOPE'] })],
        sources: twoModuleSources,
        twoModules: true,
    });
    assert.ok(runSingleWriterCheck(root).errors
        .some(error => error.includes('participatingModules must be a non-empty array')));
});


// ── round-2 review Important 1: type-resolved bypass forms ───────────

test('ARCH-SINGLE-WRITER-001 controlled mutation: a barrel import cannot launder a write', () => {
    const root = makeFixture({
        invariants: [validInvariant()],
        sources: {
            ...baseSources,
            'src/barrel.ts': 'export { Store } from \'./store\';\n',
            // The bypass file never mentions 'store' textually: only the
            // barrel. Type resolution must see through the re-export.
            'src/bypass.ts': 'import { Store } from \'./barrel\';\n'
                + 'export const evil = (s: Store) => s.writeThing();\n',
        },
    });
    assert.ok(runSingleWriterCheck(root).errors
        .some(error => error.includes('src/bypass.ts') && error.includes('typed receiver')));
});

test('ARCH-SINGLE-WRITER-001 controlled mutation: structural injection dies at the provision site', () => {
    const root = makeFixture({
        invariants: [validInvariant()],
        sources: {
            ...baseSources,
            // The helper writes through an anonymously typed parameter — the
            // receiver is not the store class, so the call itself is clean;
            // the provision site passing a store-class value must fail.
            'src/helper.ts': 'export function bypass(store: { writeThing(): void }) { store.writeThing(); }\n',
            'src/provision.ts': 'import { Store } from \'./store\';\n'
                + 'import { bypass } from \'./helper\';\n'
                + 'export const go = (s: Store) => bypass(s);\n',
        },
    });
    const errors = runSingleWriterCheck(root).errors;
    assert.ok(errors.some(error => error.includes('src/provision.ts')
        && error.includes('provisions') && error.includes('structural')),
        JSON.stringify(errors));
});

test('ARCH-SINGLE-WRITER-001 reading a store-typed value is not a violation', () => {
    const root = makeFixture({
        invariants: [validInvariant()],
        sources: {
            ...baseSources,
            'src/reader.ts': 'import { Store } from \'./store\';\n'
                + 'export const read = (s: Store) => s.toString();\n',
        },
    });
    assert.deepEqual(runSingleWriterCheck(root).errors, []);
});

// ── writerFacade edge rule (Harness Simplification PR 5/6) ────────────

function facadeInvariant(overrides = {}) {
    return validInvariant({
        stateFamily: { storePath: 'src/store.ts', writeMethods: ['writeThing'], writerFacade: true },
        ...overrides,
    });
}

const facadeSources = {
    'src/store.ts': 'export class Store { writeThing() {} }\n',
    'src/writer.ts': 'import { Store } from \'./store\';\nexport const run = (s: Store) => s.writeThing();\n',
    'src/index.ts': 'export { Store } from \'./store\';\n',
};

test('ARCH-SINGLE-WRITER-001 a writerFacade store may be imported only by writers and the entrypoint', () => {
    const root = makeFixture({
        invariants: [facadeInvariant()],
        entrypointGlob: 'src/index.ts',
        sources: {
            ...facadeSources,
            'src/sneaky.ts': 'import { Store } from \'./store\';\nexport const sneak = Store;\n',
        },
    });
    const errors = runSingleWriterCheck(root).errors;
    assert.ok(errors.some(error => error.includes('src/sneaky.ts')
        && error.includes('facade store')), JSON.stringify(errors));

    const clean = makeFixture({
        invariants: [facadeInvariant()],
        entrypointGlob: 'src/index.ts',
        sources: { ...facadeSources },
    });
    assert.deepEqual(runSingleWriterCheck(clean).errors, [],
        'writer and entrypoint imports are allowed');
});

test('ARCH-SINGLE-WRITER-001 without writerFacade the import edge alone is not a violation', () => {
    const root = makeFixture({
        invariants: [validInvariant()],
        entrypointGlob: 'src/index.ts',
        sources: {
            ...facadeSources,
            'src/sneaky.ts': 'import { Store } from \'./store\';\n'
                + 'export const sneak = (s: Store) => s.toString();\n',
        },
    });
    assert.deepEqual(runSingleWriterCheck(root).errors, []);
});

test('ARCH-SINGLE-WRITER-001 controlled mutation: families sharing a store must agree on writerFacade', () => {
    const root = makeFixture({
        invariants: [
            facadeInvariant(),
            facadeInvariant({
                id: 'ARCH-TEST-FAMILY-002',
                stateFamily: { storePath: 'src/store.ts', writeMethods: ['writeThing'] },
            }),
        ],
        entrypointGlob: 'src/index.ts',
        sources: { ...facadeSources },
    });
    const errors = runSingleWriterCheck(root).errors;
    assert.ok(errors.some(error => error.includes('writerFacade')), JSON.stringify(errors));
});
