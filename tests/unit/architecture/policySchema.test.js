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

/**
 * Build a synthetic repository root: the given registry and capability
 * manifest plus the listed production files under their roots.
 */
function makeFixture({ registry, files = [], capabilities = ['MAIN-TEST-001'] }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-policy-'));
    for (const file of ['docs/testing/architecture-modules.json', 'docs/testing/main-capability-coverage.json']) {
        fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    }
    fs.writeFileSync(path.join(root, 'docs/testing/architecture-modules.json'),
        JSON.stringify(registry));
    fs.writeFileSync(path.join(root, 'docs/testing/main-capability-coverage.json'),
        JSON.stringify({ version: 1, audit: { base: null, head: null, ignoredDocumentationCommits: [] }, capabilities: capabilities.map(id => ({ id })) }));
    for (const file of files) {
        fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), '// fixture\n');
    }
    return root;
}

function validRegistry(overrides = {}) {
    return {
        version: 1,
        scope: { roots: ['src'] },
        modules: [{
            id: 'MOD-TEST-CORE',
            title: 'Test core',
            purpose: 'Own the fixture.',
            source: { include: ['src/**'], exclude: [] },
            publicEntrypoints: ['src/**'],
            mayDependOn: [],
            roles: [
                { role: 'domain', include: ['src/types.ts'] },
                { role: 'application', include: ['src/**'] },
            ],
            productCapabilities: ['MAIN-TEST-001'],
        }],
        ...overrides,
    };
}

const fixtureFiles = ['src/index.ts', 'src/types.ts'];

function errorsFor(registry, files = fixtureFiles) {
    return loadArchitecturePolicy(makeFixture({ registry, files })).errors;
}

test('ARCH-POLICY-SCHEMA-001 the real repository registry validates clean', () => {
    const { errors, modules } = loadArchitecturePolicy(repoRoot);
    assert.deepEqual(errors, []);
    assert.equal(modules.length, 15);
});

test('ARCH-POLICY-SCHEMA-001 controlled mutation: duplicate module id is rejected', () => {
    const registry = validRegistry();
    registry.modules.push(JSON.parse(JSON.stringify(registry.modules[0])));
    assert.ok(errorsFor(registry).some(e => e.includes('duplicate module id')));
});

test('ARCH-POLICY-SCHEMA-001 controlled mutation: malformed module id is rejected', () => {
    const registry = validRegistry();
    registry.modules[0].id = 'mod-test-core';
    assert.ok(errorsFor(registry).some(e => e.includes('id must match')));
});

test('ARCH-POLICY-SCHEMA-001 controlled mutation: mayDependOn must resolve and not self-reference', () => {
    const unknown = validRegistry();
    unknown.modules[0].mayDependOn = ['MOD-NOPE'];
    assert.ok(errorsFor(unknown).some(e => e.includes('unknown module MOD-NOPE')));
    const self = validRegistry();
    self.modules[0].mayDependOn = ['MOD-TEST-CORE'];
    assert.ok(errorsFor(self).some(e => e.includes('must not reference itself')));
});

test('ARCH-POLICY-SCHEMA-001 controlled mutation: a module without capabilities is rejected', () => {
    const registry = validRegistry();
    registry.modules[0].productCapabilities = [];
    assert.ok(errorsFor(registry).some(e => e.includes('productCapabilities must not be empty')));
});

test('ARCH-POLICY-SCHEMA-001 controlled mutation: invalid or missing roles are rejected', () => {
    const badRole = validRegistry();
    badRole.modules[0].roles = [{ role: 'business', include: ['src/**'] }];
    assert.ok(errorsFor(badRole).some(e => e.includes('role must be one of')));
    const noRoles = validRegistry();
    noRoles.modules[0].roles = [];
    assert.ok(errorsFor(noRoles).some(e => e.includes('roles must be a non-empty array')));
});

test('ARCH-POLICY-SCHEMA-001 controlled mutation: wrong registry version is rejected', () => {
    const registry = validRegistry({ version: 2 });
    assert.ok(errorsFor(registry).some(e => e.includes('version must be 1')));
});
