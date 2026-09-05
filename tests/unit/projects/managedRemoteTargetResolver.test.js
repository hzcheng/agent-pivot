'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    formatManagedSshCommand,
    managedSshArguments,
    resolveManagedProjectTarget,
} = require('../../../out/projects/managedRemote/targetResolver');
const {
    isManagedSshAliasForMachine,
    managedSshAlias,
    managedSshAliasSuffix,
} = require('../../../out/projects/managedRemote/sshConfigProjection');

const SUFFIX = managedSshAliasSuffix('machine:one');

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
    assert.equal(
        target.remoteUri,
        `vscode-remote://ssh-remote%2Bbuild-${SUFFIX}/work/api`,
    );
});

test('MANAGED-REMOTE-ACTIONS-001 rebuilds a Dev Container Project for a non-ASCII Machine name', () => {
    const current = catalog();
    const payload = Buffer.from(JSON.stringify({
        hostPath: '/work/container',
        localDocker: false,
    }), 'utf8').toString('hex');
    current.machines[0].name = '小红书开发机';
    current.environments[0] = {
        id: 'environment:container', machineId: 'machine:one',
        kind: 'devContainer', name: 'Dev Container',
        devContainerAnchor: {
            version: 1,
            originalAuthority: `dev-container+${payload}@ssh-remote+legacy`,
            sourceKind: 'workspace',
            sourceLocator: '/work/container',
        },
    };
    current.projects[0].environmentId = 'environment:container';

    const target = resolveManagedProjectTarget(current, 'project:one');
    // A fully CJK name leaves nothing readable behind, so the alias falls back
    // to the connection host. OpenSSH resolves an alias with valid_domain()
    // and rejects any non-ASCII byte, so the alias must stay ASCII.
    const alias = managedSshAlias('machine:one', '小红书开发机', '2001:db8::1');
    assert.equal(target.alias, alias);
    assert.match(alias, /^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
    assert.equal(
        target.remoteUri,
        `vscode-remote://${encodeURIComponent(
            `dev-container+${payload}@ssh-remote+${alias}`
        )}/work/api`,
    );
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

test('MANAGED-REMOTE-ACTIONS-001 keeps a Project resolvable after the Machine is renamed', () => {
    const before = resolveManagedProjectTarget(catalog(), 'project:one');
    const renamed = catalog();
    renamed.machines[0].name = 'Build Renamed';
    const after = resolveManagedProjectTarget(renamed, 'project:one');

    // The readable segment tracks the new name, but the identity suffix is
    // unchanged, so the Machine stays addressable across a rename.
    assert.equal(before.alias, `build-${SUFFIX}`);
    assert.equal(after.alias, `build-renamed-${SUFFIX}`);
    assert.ok(before.alias.endsWith(`-${SUFFIX}`));
    assert.ok(after.alias.endsWith(`-${SUFFIX}`));
    assert.ok(isManagedSshAliasForMachine(before.alias, 'machine:one', 'Build Renamed', ''));
});

test('MANAGED-REMOTE-ACTIONS-001 gives two identically named Machines distinct aliases', () => {
    const first = catalog();
    const second = catalog();
    second.machines[0].id = 'machine:two';
    second.environments[0].machineId = 'machine:two';

    const firstAlias = resolveManagedProjectTarget(first, 'project:one').alias;
    const secondAlias = resolveManagedProjectTarget(second, 'project:one').alias;
    assert.notEqual(firstAlias, secondAlias);
});
