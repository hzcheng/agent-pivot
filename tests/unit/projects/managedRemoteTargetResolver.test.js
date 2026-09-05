'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    formatManagedSshCommand,
    managedSshArguments,
    resolveManagedProjectTarget,
} = require('../../../out/projects/managedRemote/targetResolver');

function catalog() {
    return {
        machines: [{
            id: 'machine:one', name: 'Build',
            connection: { kind: 'ssh', host: '2001:db8::1', user: 'dev', port: 2207 },
        }],
        environments: [{
            id: 'host:machine:one', machineId: 'machine:one', kind: 'host', name: 'Host',
        }],
        projects: [{
            id: 'project:one', environmentId: 'host:machine:one',
            name: 'API', remotePath: '/work/api',
        }],
        conflicts: [],
        layout: {
            machineIds: [], environmentIdsByMachine: {},
            projectIdsByEnvironment: {}, favoriteProjectIds: [],
        },
    };
}

test('MANAGED-REMOTE-ACTIONS-001 resolves one validated Project relationship and URI', () => {
    const target = resolveManagedProjectTarget(catalog(), 'project:one');
    assert.equal(target.machine.id, 'machine:one');
    assert.equal(target.environment.id, 'host:machine:one');
    assert.equal(target.project.id, 'project:one');
    assert.equal(target.remoteUri, 'vscode-remote://ssh-remote%2Bbuild/work/api');
});

test('MANAGED-REMOTE-ACTIONS-001 propagates related conflicts into target resolution', () => {
    const current = catalog();
    current.conflicts.push({
        kind: 'update-update', entityType: 'environment', entityId: 'host:machine:one',
        relatedEntityIds: ['project:one'],
    });
    assert.throws(
        () => resolveManagedProjectTarget(current, 'project:one'),
        /unresolved conflict/,
    );
});

test('MANAGED-REMOTE-SSH-COMMAND-001 formats a config-independent non-22 IPv6 command', () => {
    const machine = catalog().machines[0];
    assert.deepEqual(managedSshArguments(machine), [
        '-p', '2207', '-l', 'dev', '2001:db8::1',
    ]);
    assert.equal(
        formatManagedSshCommand(machine),
        'ssh -p 2207 -l "dev" "2001:db8::1"',
    );
});
