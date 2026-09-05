'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    parseManagedDevContainerProjectUri,
    rebuildManagedDevContainerProjectUri,
} = require('../../../out/projects/managedRemote/devContainerCodec');
const {
    buildManagedCatalogFromMigrationPlan,
    buildManagedRemoteMigrationPlan,
    excludeManagedMigrationRecord,
    parseDirectManagedSshTarget,
    resolveManagedMigrationWithConnection,
    resolveWslMigrationAsManagedMachine,
} = require('../../../out/projects/managedRemote/migrationPlan');
const { materializeManagedRemoteCatalog } = require('../../../out/projects/managedRemote/merge');

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
    assert.match(converted.reason, /host, user, port, and Linux path/i);
    assert.equal(parseDirectManagedSshTarget('dev@build.example.com:22022').port, 22022);
});

test('MANAGED-REMOTE-MIGRATION-001 builds a lossless remote catalog and excludes local records', () => {
    const plan = buildManagedRemoteMigrationPlan([{
        id: 'g', groupName: 'Backend', projects: [
            project('api', 'vscode-remote://ssh-remote%2Bdev%40build.example.com%3A2207/srv/api', {
                description: 'API service', tags: ['prod'], color: '#ff0000',
                favorite: true, favoriteOrder: 3,
            }),
            project('worker', 'vscode-remote://ssh-remote%2Bdev%40build.example.com%3A2207/srv/worker', {
                favorite: true, favoriteOrder: 1,
            }),
            project('local', '/Users/dev/local'),
        ],
    }]);
    const catalog = materializeManagedRemoteCatalog(
        buildManagedCatalogFromMigrationPlan(plan, 'migration-actor'),
    );

    assert.equal(catalog.machines.length, 1);
    assert.equal(catalog.environments.length, 1);
    assert.deepEqual(catalog.projects.map(value => value.id), ['api', 'worker']);
    assert.deepEqual(catalog.projects[0], {
        id: 'api',
        environmentId: catalog.environments[0].id,
        name: 'api',
        description: 'API service',
        remotePath: '/srv/api',
        tags: ['prod', 'Backend'],
        color: '#ff0000',
        favorite: true,
    });
    assert.deepEqual(catalog.layout.favoriteProjectIds, ['worker', 'api']);
    assert.equal(catalog.projects.some(value => value.id === 'local'), false);
});

test('MANAGED-REMOTE-MIGRATION-001 keeps a fixed Host beside a migrated Dev Container', () => {
    const payload = Buffer.from(JSON.stringify({
        hostPath: '/srv/api', localDocker: false,
        configFile: { path: '/srv/api/.devcontainer/devcontainer.json' },
    }), 'utf8').toString('hex');
    const plan = buildManagedRemoteMigrationPlan([{
        id: 'g', groupName: '', projects: [project(
            'container',
            `vscode-remote://${encodeURIComponent(`dev-container+${payload}@ssh-remote+build`)}/workspaces/api`,
        )],
    }]);
    plan.records[0] = resolveManagedMigrationWithConnection(
        plan.records[0],
        'Build',
        { host: 'build.example.com', user: 'dev', port: 2222 },
    );
    const catalog = materializeManagedRemoteCatalog(
        buildManagedCatalogFromMigrationPlan(plan, 'migration-actor'),
    );

    assert.deepEqual(catalog.environments.map(value => value.kind), ['host', 'devContainer']);
    assert.equal(catalog.projects[0].environmentId, catalog.environments[1].id);
    assert.equal(catalog.environments[1].devContainerAnchor.sourceKind, 'config');
});

test('MANAGED-REMOTE-MIGRATION-001 requires review or explicit exclusion before conversion', () => {
    const plan = buildManagedRemoteMigrationPlan([{
        id: 'g', groupName: '', projects: [
            project('alias', 'vscode-remote://ssh-remote%2Bbuild/work/api'),
        ],
    }]);
    assert.throws(
        () => buildManagedCatalogFromMigrationPlan(plan, 'migration-actor'),
        /still requires migration review/u,
    );
    plan.records[0] = excludeManagedMigrationRecord(plan.records[0]);
    const catalog = materializeManagedRemoteCatalog(
        buildManagedCatalogFromMigrationPlan(plan, 'migration-actor'),
    );
    assert.equal(catalog.projects.length, 0);
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
        '小红书开发机',
        parsed.remotePath,
    );
    const reparsed = parseManagedDevContainerProjectUri(rebuilt);
    assert.equal(reparsed.outerSshAuthority, '小红书开发机');
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
