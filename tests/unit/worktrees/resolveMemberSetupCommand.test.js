'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveMemberSetupCommand } = require('../../../out/worktrees/worktreeSetupRunner');

const SNAPSHOT = {
    repositories: [{
        repositoryKey: '/repo/.git',
        rootBindings: [{ workspaceRootId: 'api' }],
    }],
};
const ROOTS = [
    { id: 'api', uri: 'file:///repo/packages/api' },
    { id: 'web', uri: 'file:///repo/packages/web' },
];

test('resolveMemberSetupCommand reads the command at the bound workspace root scope', () => {
    const scopes = [];
    const command = resolveMemberSetupCommand({
        repositoryKey: '/repo/.git',
        snapshot: SNAPSHOT,
        workspaceRoots: ROOTS,
        readSetupCommand: scopeUri => {
            scopes.push(scopeUri);
            return ['npm', 'run', 'setup'];
        },
    });
    assert.deepEqual(command, ['npm', 'run', 'setup']);
    assert.deepEqual(scopes, ['file:///repo/packages/api']);
});

test('resolveMemberSetupCommand falls back to the unscoped configuration', () => {
    const scopes = [];
    const command = resolveMemberSetupCommand({
        repositoryKey: '/missing/.git',
        snapshot: SNAPSHOT,
        workspaceRoots: ROOTS,
        readSetupCommand: scopeUri => {
            scopes.push(scopeUri);
            return 'not-an-array';
        },
    });
    assert.deepEqual(command, []);
    assert.deepEqual(scopes, [undefined]);
});

test('resolveMemberSetupCommand tolerates null snapshot and roots', () => {
    const command = resolveMemberSetupCommand({
        repositoryKey: '/repo/.git',
        snapshot: null,
        workspaceRoots: null,
        readSetupCommand: () => ['make'],
    });
    assert.deepEqual(command, ['make']);
});
