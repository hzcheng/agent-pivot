'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    parseManagedDevContainerProjectUri,
    rebuildManagedDevContainerProjectUri,
} = require('../../../out/projects/managedRemote/devContainerCodec');
const {
    buildManagedRemoteMigrationPlan,
    parseDirectManagedSshTarget,
    resolveWslMigrationAsManagedMachine,
} = require('../../../out/projects/managedRemote/migrationPlan');

function project(id, path, extra = {}) {
    return { id, name: id, path, ...extra };
}

test('MANAGED-REMOTE-MIGRATION-001 classifies direct SSH, aliases, and local WSL explicitly', () => {
    const plan = buildManagedRemoteMigrationPlan([{
        id: 'group',
        groupName: 'Backend',
        projects: [
            project('direct', 'vscode-remote://ssh-remote%2Bdev%40host.example.com%3A22022/work/api', {
                tags: ['active'],
            }),
            project('alias', 'vscode-remote://ssh-remote%2Bbuild-alias/work/worker'),
            project('wsl', 'vscode-remote://wsl%2BUbuntu/home/dev/app'),
        ],
    }]);
    const byId = new Map(plan.records.map(record => [record.projectId, record]));

    assert.equal(byId.get('direct').classification, 'ready');
    assert.deepEqual(byId.get('direct').endpoint, {
        host: 'host.example.com', user: 'dev', port: 22022,
    });
    assert.deepEqual(byId.get('direct').tags, ['active', 'Backend']);
    assert.equal(byId.get('alias').classification, 'needsInput');
    assert.equal(byId.get('wsl').classification, 'clientLocal');
});

test('MANAGED-REMOTE-MIGRATION-001 includes every V1 field in source identity', () => {
    const base = [{ id: 'g', groupName: 'G', projects: [project('p', '/work', { remoteType: 1 })] }];
    const changed = JSON.parse(JSON.stringify(base));
    changed[0].projects[0].remoteType = 2;
    assert.notEqual(
        buildManagedRemoteMigrationPlan(base).planId,
        buildManagedRemoteMigrationPlan(changed).planId,
    );
});

test('MANAGED-REMOTE-MIGRATION-002 converts local WSL only after explicit SSH details', () => {
    const record = buildManagedRemoteMigrationPlan([{
        id: 'g', groupName: '', projects: [
            project('wsl', 'vscode-remote://wsl%2BUbuntu/home/dev/app'),
        ],
    }]).records[0];
    const converted = resolveWslMigrationAsManagedMachine(
        record,
        'Build PC — Ubuntu',
        { host: 'build.example.com', user: 'dev', port: 22022 },
        '/home/dev/app',
    );

    assert.equal(converted.classification, 'needsInput');
    assert.equal(converted.endpoint.port, 22022);
    assert.match(converted.reason, /rehearsal/i);
    assert.equal(parseDirectManagedSshTarget('dev@build.example.com:22022').port, 22022);
});

test('MANAGED-REMOTE-DEV-CONTAINER-001 round-trips a current nested SSH authority', () => {
    const payload = Buffer.from(JSON.stringify({
        hostPath: '/home/dev/workspace',
        localDocker: false,
        configFile: { path: '/home/dev/workspace/.devcontainer/devcontainer.json' },
    }), 'utf8').toString('hex');
    const source = `vscode-remote://${encodeURIComponent(`dev-container+${payload}@ssh-remote+old-alias`)}/workspaces/api`;
    const parsed = parseManagedDevContainerProjectUri(source);
    assert.ok(parsed);
    assert.equal(parsed.outerSshAuthority, 'old-alias');
    assert.equal(parsed.anchor.sourceKind, 'config');

    const rebuilt = rebuildManagedDevContainerProjectUri(
        parsed.anchor,
        'agent-pivot-machine-id',
        parsed.remotePath,
    );
    const reparsed = parseManagedDevContainerProjectUri(rebuilt);
    assert.equal(reparsed.outerSshAuthority, 'agent-pivot-machine-id');
    assert.equal(reparsed.anchor.sourceLocator, parsed.anchor.sourceLocator);
    assert.equal(reparsed.remotePath, '/workspaces/api');
    assert.equal(parseManagedDevContainerProjectUri(
        'vscode-remote://attached-container%2Bopaque/workspaces/api',
    ), null);
});

test('MANAGED-REMOTE-DEV-CONTAINER-001 parses the captured current VS Code authority fixture', () => {
    // Captured by the repository's disposable local-bridge rehearsal. Keep the
    // extra VS Code URI fields: they protect this codec from relying on a toy
    // payload shape that the Dev Containers extension never emits.
    const authority = 'dev-container+7b22686f737450617468223a222f686f6d652f6465706c6f792f446576426f782f646576626f78222c226c6f63616c446f636b6572223a66616c73652c22636f6e66696746696c65223a7b22246d6964223a312c2270617468223a222f686f6d652f6465706c6f792f446576426f782f646576626f782f2e646576636f6e7461696e65722e6a736f6e222c22736368656d61223a227673636f64652d66696c65486f7374227d7d@ssh-remote+reddev';
    const parsed = parseManagedDevContainerProjectUri(
        `vscode-remote://${authority}/tmp/project-steward-attention-fixture-a`,
    );
    assert.ok(parsed);
    assert.equal(parsed.outerSshAuthority, 'reddev');
    assert.equal(
        parsed.anchor.sourceLocator,
        '/home/deploy/DevBox/devbox/.devcontainer.json',
    );
    assert.equal(parsed.remotePath, '/tmp/project-steward-attention-fixture-a');
});
