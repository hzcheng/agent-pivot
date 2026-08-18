'use strict';

// ARCH-DEPENDENCY-GRAPH-001: the dependency graph must classify edge kinds
// from the AST (review R7): runtime `await import('./x')` is a value edge
// (the cycle ratchet sees it), only type-position `import('./x').T` stays a
// type edge, and unrecognized import/require forms fail closed.

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { buildDependencyGraph } = require('../../../scripts/architecture/buildDependencyGraph');

function makeFixture(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-graph-'));
    for (const [relative, content] of Object.entries(files)) {
        fs.mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
        fs.writeFileSync(path.join(root, relative), content);
    }
    fs.mkdirSync(path.join(root, 'docs/testing'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/testing/architecture-modules.json'), JSON.stringify({
        version: 1, scope: { roots: ['src'] },
        modules: ['MOD-ALPHA', 'MOD-BETA'].map(id => ({
            id, title: id, purpose: 'fixture',
            source: { include: [`src/${id === 'MOD-ALPHA' ? 'alpha' : 'beta'}/**`], exclude: [] },
            publicEntrypoints: [`src/${id === 'MOD-ALPHA' ? 'alpha' : 'beta'}/**`],
            mayDependOn: [],
            roles: [{ role: 'application', include: [`src/${id === 'MOD-ALPHA' ? 'alpha' : 'beta'}/**`] }],
            productCapabilities: ['MAIN-TEST-001'],
        })),
    }));
    fs.writeFileSync(path.join(root, 'docs/testing/main-capability-coverage.json'),
        JSON.stringify({ version: 1, capabilities: [{ id: 'MAIN-TEST-001' }] }));
    return root;
}

function edgeKinds(root) {
    const { edges, errors } = buildDependencyGraph(root);
    return { edges, errors };
}

test('ARCH-DEPENDENCY-GRAPH-001 runtime dynamic import is a value edge; type-position stays type', () => {
    const root = makeFixture({
        'src/alpha/a.ts': [
            "export async function load() { return import('../beta/b'); }",
            "export type B = import('../beta/b').B;",
        ].join('\n'),
        'src/beta/b.ts': 'export interface B { x: number }\n',
    });
    const { edges, errors } = edgeKinds(root);
    assert.deepEqual(errors, []);
    const byKind = edges.map(edge => edge.kind).sort();
    assert.deepEqual(byKind, ['type', 'value'],
        'one value edge (runtime import) and one type edge (import type)');
});

test('ARCH-DEPENDENCY-GRAPH-001 static forms keep their kinds', () => {
    const root = makeFixture({
        'src/alpha/a.ts': [
            "import { b } from '../beta/b';",
            "import type { B } from '../beta/b2';",
            "import '../beta/sideEffect';",
            "export * from '../beta/reExport';",
            "export type { C } from '../beta/b3';",
            "const legacy = require('../beta/legacy');",
            'void legacy; void b;',
        ].join('\n'),
        'src/beta/b.ts': 'export const b = 1;\n',
        'src/beta/b2.ts': 'export interface B { x: number }\n',
        'src/beta/b3.ts': 'export interface C { y: number }\n',
        'src/beta/sideEffect.ts': 'export {};\n',
        'src/beta/reExport.ts': 'export {};\n',
        'src/beta/legacy.ts': 'export {};\n',
    });
    const { edges, errors } = edgeKinds(root);
    assert.deepEqual(errors, []);
    assert.equal(edges.filter(edge => edge.kind === 'value').length, 4,
        'import, side-effect import, export-from, and require are value edges');
    assert.equal(edges.filter(edge => edge.kind === 'type').length, 2,
        'import type and export type are type edges');
});

test('ARCH-DEPENDENCY-GRAPH-001 controlled mutation: a dynamic-import runtime cycle is detected as value debt', () => {
    const root = makeFixture({
        'src/alpha/a.ts': "export async function load() { return import('../beta/b'); }\n",
        'src/beta/b.ts': "import { load } from '../alpha/a';\nexport function use() { return load; }\n",
    });
    const { edges, errors } = edgeKinds(root);
    assert.deepEqual(errors, []);
    const valuePairs = new Set(edges.filter(edge => edge.kind === 'value')
        .map(edge => `${edge.sourceModule}->${edge.targetModule}`));
    assert.ok(valuePairs.has('MOD-ALPHA->MOD-BETA'));
    assert.ok(valuePairs.has('MOD-BETA->MOD-ALPHA'),
        'the dynamic import participates in the value graph (2-cycle visible)');
});

test('ARCH-DEPENDENCY-GRAPH-001 controlled mutation: non-literal dynamic import and require fail closed', () => {
    const root = makeFixture({
        'src/alpha/a.ts': [
            'declare const name: string;',
            'export async function load() { return import(name); }',
            "const legacy = require(`../beta/${'b'}`);",
            'void legacy;',
        ].join('\n'),
        'src/beta/b.ts': 'export {};\n',
    });
    const { errors } = edgeKinds(root);
    assert.ok(errors.some(error => error.includes('non-literal specifier')), JSON.stringify(errors));
    assert.ok(errors.filter(error => error.includes('non-literal specifier')).length === 2,
        'both the dynamic import and the template require fail closed');
});

test('ARCH-DEPENDENCY-GRAPH-001 package specifiers never become edges', () => {
    const root = makeFixture({
        'src/alpha/a.ts': [
            "import fs from 'fs';",
            "import { workspace } from 'vscode';",
            "export async function load() { return import('fs'); }",
            'void fs; void workspace;',
        ].join('\n'),
        'src/beta/b.ts': 'export {};\n',
    });
    const { edges, errors } = edgeKinds(root);
    assert.deepEqual(errors, []);
    assert.deepEqual(edges, []);
});
