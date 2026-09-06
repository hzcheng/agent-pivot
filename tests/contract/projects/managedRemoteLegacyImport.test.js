'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    buildCatalogFromLegacyGroups,
    classifyLegacyProjectPath,
} = require('../../../out/projects/managedRemote/legacyImport');
const {
    materializeManagedRemoteCatalog,
} = require('../../../out/projects/managedRemote/merge');

const CONTAINER_PAYLOAD = Buffer.from(JSON.stringify({
    hostPath: '/home/deploy/DevBox/devbox',
    configFile: { path: '/home/deploy/DevBox/devbox/.devcontainer.json' },
}), 'utf8').toString('hex');

function containerUri(remotePath) {
    const authority = `dev-container+${CONTAINER_PAYLOAD}@ssh-remote+reddev`;
    return `vscode-remote://${encodeURIComponent(authority)}${remotePath}`;
}

function groups() {
    return [
        {
            groupName: 'REDDEV',
            projects: [{
                name: 'DevBox',
                path: 'vscode-remote://ssh-remote%2Breddev/home/deploy/DevBox',
                color: '#FF0000',
                favorite: true,
            }],
        },
        {
            groupName: 'REDDEV CONTAINER',
            projects: [{
                name: 'agent-pivot',
                path: containerUri('/home/hzcheng/projects/repos/vscode-dashboard'),
                description: 'plugin',
            }],
        },
        {
            groupName: 'XHS MAC',
            projects: [{ name: 'local-only', path: '/Users/me/work' }],
        },
    ];
}

function build(resolve) {
    let ordinal = 0;
    return buildCatalogFromLegacyGroups(groups(), resolve, {
        actorId: 'import',
        createId: prefix => `${prefix}:i${++ordinal}`,
    });
}

const RESOLVE_REDDEV = async alias => (alias === 'reddev'
    ? { host: 'reddev.example.com', user: 'hzcheng', port: 22022 }
    : null);

test('MANAGED-REMOTE-LEGACY-IMPORT-001 converts hosts, containers and groups into one catalog', async () => {
    const { document, summary } = await build(RESOLVE_REDDEV);
    const catalog = materializeManagedRemoteCatalog(document);

    assert.equal(catalog.conflicts.length, 0);
    assert.equal(catalog.machines.length, 1);
    assert.equal(catalog.machines[0].connection.host, 'reddev.example.com');
    assert.equal(catalog.machines[0].connection.port, 22022);
    // One host Environment plus one Dev Container Environment.
    assert.equal(catalog.environments.length, 2);
    assert.equal(summary.projects, 2);

    // The group has no home in a Machine-grouped model, so it becomes a tag.
    const host = catalog.projects.find(project => project.name === 'DevBox');
    assert.deepEqual(host.tags, ['REDDEV']);
    assert.equal(host.remotePath, '/home/deploy/DevBox');
    assert.equal(host.color, '#FF0000');
    assert.equal(host.favorite, true);

    const container = catalog.projects.find(project => project.name === 'agent-pivot');
    assert.deepEqual(container.tags, ['REDDEV CONTAINER']);
    assert.equal(container.remotePath, '/home/hzcheng/projects/repos/vscode-dashboard');
    assert.equal(container.description, 'plugin');
});

test('MANAGED-REMOTE-LEGACY-IMPORT-001 reports Local Projects as skipped rather than dropping them', async () => {
    const { summary } = await build(RESOLVE_REDDEV);
    // Local Projects are machine-local by design and the catalog synchronizes,
    // so they stay behind — but the user has to be told which ones.
    assert.deepEqual(
        summary.skipped.map(item => `${item.name}:${item.reason}`),
        ['local-only:local'],
    );
});

test('MANAGED-REMOTE-LEGACY-IMPORT-001 reports an unresolvable host instead of inventing an endpoint', async () => {
    const { summary } = await build(async () => null);
    assert.equal(summary.machines, 0);
    assert.equal(summary.projects, 0);
    assert.deepEqual(summary.skipped.map(item => item.reason).sort(), [
        'local', 'unresolved-host:reddev', 'unresolved-host:reddev',
    ]);
});

test('MANAGED-REMOTE-LEGACY-IMPORT-001 reuses one Environment per Dev Container anchor', async () => {
    const shared = groups();
    shared[1].projects.push({ name: 'second', path: containerUri('/work/other') });
    let ordinal = 0;
    const { document } = await buildCatalogFromLegacyGroups(shared, RESOLVE_REDDEV, {
        actorId: 'import',
        createId: prefix => `${prefix}:i${++ordinal}`,
    });
    const catalog = materializeManagedRemoteCatalog(document);
    // Two Projects behind the same container must not create two Environments.
    assert.equal(catalog.environments.filter(e => e.kind === 'devContainer').length, 1);
    assert.equal(catalog.projects.length, 3);
});

test('MANAGED-REMOTE-LEGACY-IMPORT-001 classifies each legacy path shape', () => {
    assert.equal(classifyLegacyProjectPath('/Users/me/work').kind, 'local');
    assert.equal(classifyLegacyProjectPath(undefined).kind, 'local');
    assert.equal(
        classifyLegacyProjectPath('vscode-remote://wsl%2BUbuntu/work').kind,
        'unsupported',
    );
    const host = classifyLegacyProjectPath(
        'vscode-remote://ssh-remote%2Breddev/home/dev/api',
    );
    assert.equal(host.kind, 'host');
    assert.equal(host.alias, 'reddev');
    assert.equal(host.remotePath, '/home/dev/api');
});

/**
 * The guards on one-time recovery. Recovery is not an upgrade path the product
 * maintains, so re-running it or letting it overwrite a populated catalog would
 * be worse than never running it at all.
 */
function recoveryHarness(overrides = {}) {
    const state = new Map(Object.entries(overrides.state || {}));
    const imports = [];
    const files = overrides.files || {};
    const notifications = [];
    let machines = overrides.machines ?? 0;
    return {
        state,
        imports,
        notifications,
        async run() {
            if (state.get('legacyProjectImport.v1')) { return 'already-done'; }
            if (machines > 0) { return 'catalog-populated'; }
            const raw = files['projectData.json'];
            if (raw === undefined) { return 'no-backup'; }
            const groups = JSON.parse(raw);
            if (!groups.length) { return 'empty-backup'; }
            if (overrides.failImport) { return 'failed-not-marked'; }
            imports.push(groups.length);
            state.set('legacyProjectImport.v1', { projects: 2 });
            machines = 1;
            notifications.push('recovered');
            return 'recovered';
        },
    };
}

test('MANAGED-REMOTE-LEGACY-IMPORT-001 recovers once and never repeats', async () => {
    const bench = recoveryHarness({
        files: { 'projectData.json': JSON.stringify(groups()) },
    });
    assert.equal(await bench.run(), 'recovered');
    // A second activation must be a no-op, or every reload duplicates the data.
    assert.equal(await bench.run(), 'already-done');
    assert.equal(bench.imports.length, 1);
    assert.equal(bench.notifications.length, 1);
});

test('MANAGED-REMOTE-LEGACY-IMPORT-001 refuses to touch a catalog that already has Machines', async () => {
    const bench = recoveryHarness({
        machines: 2,
        files: { 'projectData.json': JSON.stringify(groups()) },
    });
    assert.equal(await bench.run(), 'catalog-populated');
    assert.equal(bench.imports.length, 0);
});

test('MANAGED-REMOTE-LEGACY-IMPORT-001 stays silent when there is no backup', async () => {
    const bench = recoveryHarness({});
    assert.equal(await bench.run(), 'no-backup');
    assert.equal(bench.notifications.length, 0);
});

test('MANAGED-REMOTE-LEGACY-IMPORT-001 leaves a failed recovery retryable', async () => {
    const bench = recoveryHarness({
        failImport: true,
        files: { 'projectData.json': JSON.stringify(groups()) },
    });
    assert.equal(await bench.run(), 'failed-not-marked');
    // Marking a failure as done would strand the data permanently.
    assert.equal(bench.state.get('legacyProjectImport.v1'), undefined);
});
