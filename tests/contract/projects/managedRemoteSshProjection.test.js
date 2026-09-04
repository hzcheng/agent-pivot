'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { ManagedRemoteCatalogService } = require('../../../out/projects/managedRemote/catalogService');
const { createManagedRevisionSlot } = require('../../../out/projects/managedRemote/envelope');
const {
    buildManagedSshProjection,
    managedSshAlias,
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

    assert.equal(projection.entries[0].alias, managedSshAlias(machine.id));
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
