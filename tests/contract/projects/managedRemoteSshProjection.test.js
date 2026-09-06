'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { ManagedRemoteCatalogService } = require('../../../out/projects/managedRemote/catalogService');
const { createManagedRevisionSlot } = require('../../../out/projects/managedRemote/envelope');
const {
    buildManagedSshProjection,
    isManagedSshAliasForMachine,
    managedSshAlias,
    managedSshAliasSuffix,
    renderManagedSshConfig,
    renderManagedSshIncludeBlock,
} = require('../../../out/projects/managedRemote/sshConfigProjection');

function catalog() {
    let ordinal = 0;
    return ManagedRemoteCatalogService.create('projection', prefix => `${prefix}:${++ordinal}`);
}

test('MANAGED-REMOTE-SSH-PROJECTION-001 renders stable aliases and custom ports without credentials', () => {
    const service = catalog();
    const machine = service.addMachine({
        name: 'Build', host: 'build.example.com', user: 'dev', port: 22022,
    });
    const slot = createManagedRevisionSlot(service.getDocument());
    const projection = buildManagedSshProjection(slot);
    const rendered = renderManagedSshConfig(projection);

    assert.equal(projection.entries[0].alias, managedSshAlias(machine.id, machine.name));
    assert.equal(projection.entries[0].alias, `build-${managedSshAliasSuffix(machine.id)}`);
    assert.match(rendered, /HostName build\.example\.com/);
    assert.match(rendered, /Port 22022/);
    assert.match(rendered, /ProxyJump none/);
    assert.match(rendered, /ForwardAgent no/);
    assert.match(rendered, /RemoteCommand none/);
    assert.match(rendered, /ControlMaster no/);
    assert.doesNotMatch(rendered, /IdentityFile|password/i);
    assert.equal(
        buildManagedSshProjection(createManagedRevisionSlot(service.getDocument()))
            .connectionDigest,
        projection.connectionDigest,
    );
});

test('MANAGED-REMOTE-SSH-PROJECTION-001 ignores metadata-only edits in the connection digest', () => {
    const service = catalog();
    const machine = service.addMachine({
        name: 'Build', host: 'build.example.com', user: 'dev', port: 22,
    });
    const project = service.addProject({
        environmentId: `host:${machine.id}`,
        name: 'API', remotePath: '/work/api', tags: ['one'],
    });
    const before = buildManagedSshProjection(createManagedRevisionSlot(service.getDocument()));
    service.editProject(project.id, { tags: ['two'], favorite: true });
    const after = buildManagedSshProjection(createManagedRevisionSlot(service.getDocument()));

    assert.equal(after.connectionDigest, before.connectionDigest);
    assert.notEqual(after.revisionId, before.revisionId);
});

test('MANAGED-REMOTE-SSH-PROJECTION-001 makes aliases readable, unique, and safe', () => {
    assert.equal(
        managedSshAlias('machine:one', 'RedDev Main'),
        `reddev-main-${managedSshAliasSuffix('machine:one')}`,
    );
    assert.equal(
        managedSshAlias('machine:two', '小红书开发机', 'reddev.example.com'),
        `reddev.example.com-${managedSshAliasSuffix('machine:two')}`,
    );
    assert.equal(
        managedSshAlias('machine:three', '🚀', 'reddev.example.com'),
        `reddev.example.com-${managedSshAliasSuffix('machine:three')}`,
    );
    assert.ok(managedSshAlias('machine:one', 'A'.repeat(200)).length <= 63);

    // OpenSSH resolves an alias with valid_domain(), which rejects any byte
    // outside [A-Za-z0-9._-]. A non-ASCII alias makes `ssh -G` fail with
    // "hostname contains invalid characters", so no name may produce one.
    for (const name of ['小红书开发机', 'Café Dev', '🚀 Rocket', 'Ω', 'офис']) {
        const alias = managedSshAlias('machine:one', name, 'fallback.example.com');
        assert.match(alias, /^[A-Za-z0-9][A-Za-z0-9._-]*$/u, `alias for ${name}`);
    }

    // The identity suffix, not the display name, is what addresses a Machine:
    // renaming must not orphan an already-projected alias, and two Machines
    // sharing a name must never collapse onto one alias.
    assert.equal(isManagedSshAliasForMachine(
        managedSshAlias('machine:one', 'Old Name'), 'machine:one', 'Old Name'), true);
    assert.equal(isManagedSshAliasForMachine(
        managedSshAlias('machine:one', 'Old Name'), 'machine:one', 'New Name'), true);
    assert.equal(isManagedSshAliasForMachine(
        'old-name-9707c5df', 'machine:one', 'New Name'), true);
    assert.equal(isManagedSshAliasForMachine(
        managedSshAlias('machine:two', 'Other Name'), 'machine:one', 'New Name'), false);
    assert.notEqual(
        managedSshAlias('machine:one', 'Same Name'),
        managedSshAlias('machine:two', 'Same Name'),
    );
});

test('MANAGED-REMOTE-SSH-PROJECTION-001 allows same-named Machines to coexist as distinct hosts', () => {
    const service = catalog();
    service.addMachine({ name: 'Red Dev', host: 'one.example.com', user: 'dev' });
    const second = service.addMachine({
        name: 'red-dev', host: 'two.example.com', user: 'dev',
    });
    const projection = buildManagedSshProjection(
        createManagedRevisionSlot(service.getDocument()),
    );
    const aliases = projection.entries.map(entry => entry.alias);
    assert.equal(new Set(aliases).size, 2);
    assert.ok(aliases.includes(
        `red-dev-${managedSshAliasSuffix(second.id)}`,
    ));
});

test('MANAGED-REMOTE-SSH-PROJECTION-001 quotes only representable Include paths', () => {
    assert.equal(
        renderManagedSshIncludeBlock('/home/user/SSH Config/agent-pivot/current.conf'),
        '# >>> Agent Pivot managed SSH hosts (do not edit)\n'
        + 'Include "/home/user/SSH Config/agent-pivot/current.conf"\n'
        + '# <<< Agent Pivot managed SSH hosts',
    );
    assert.throws(() => renderManagedSshIncludeBlock('/tmp/bad"path'), /safely/);
    assert.match(
        renderManagedSshIncludeBlock('C:\\Users\\Dev\\.ssh\\agent-pivot\\current.conf'),
        /Include "C:\/Users\/Dev\/\.ssh\/agent-pivot\/current\.conf"/,
    );
});
