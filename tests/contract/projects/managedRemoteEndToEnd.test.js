'use strict';

/**
 * Crosses the seam the rest of the Managed Remote suite leaves open.
 *
 * The browser suite clicks the real button and asserts only that a message was
 * posted, then fabricates the settlement. The contract suites start from a
 * message and a mock store. Nothing drives a real message through the real
 * handler into the real catalog and back out through the real renderer, so
 * every layer can be green while the assembled feature does nothing.
 *
 * These tests own that seam: the message shape asserted here is the same shape
 * the browser suite captures from a real click, so the two meet in the middle.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { cloneManagedValue } = require('../../../out/projects/managedRemote/causal');
const {
    ManagedCatalogCoordinator,
} = require('../../../out/projects/managedRemote/store');
const {
    ManagedRemoteCatalogManagementStore,
} = require('../../../out/projects/managedRemote/managementStore');
const {
    ManagedRemoteManagementController,
} = require('../../../out/projects/managedRemote/managementController');
const {
    buildManagedRemoteProjectsViewModel,
} = require('../../../out/projects/managedRemote/viewModel');
const {
    renderManagedRemoteProjectsPanel,
} = require('../../../out/webview/webviewManagedRemoteProjectsContent');

class MemoryBackend {
    constructor() { this.value = null; }
    read() { return cloneManagedValue(this.value); }
    async write(value) { this.value = cloneManagedValue(value); }
}

class MemoryReplicas {
    constructor() { this.values = new Map(); }
    async allocateWriter() { return { writerId: 'writer:one', actorId: 'envelope:one' }; }
    readWriter(id) { return cloneManagedValue(this.values.get(id) || null); }
    async writeWriter(id, value) { this.values.set(id, cloneManagedValue(value)); }
}

/**
 * The exact message the webview posts for a toolbar operation. Kept as one
 * builder so a change to the posted shape breaks this suite instead of quietly
 * bypassing the handler.
 */
function webviewAction(operation, expectedRevisionId, targetId) {
    return {
        type: 'managed-remote-action',
        version: 1,
        requestId: `managed-${'a'.repeat(20)}`,
        operation,
        expectedRevisionId: expectedRevisionId || null,
        ...(targetId ? { targetId } : {}),
    };
}

async function harness(prompts = {}) {
    const coordinator = await ManagedCatalogCoordinator.create(
        new MemoryBackend(), new MemoryReplicas(),
    );
    let ordinal = 0;
    const store = new ManagedRemoteCatalogManagementStore(
        coordinator, 'catalog:one', prefix => `${prefix}:e2e-${++ordinal}`,
    );
    const settlements = [];
    let snapshot = await store.getSnapshot();
    const controller = new ManagedRemoteManagementController({
        store,
        prompts: {
            async addMachine() {
                return { name: 'RedDev', host: 'reddev.example.com', user: 'dev', port: 22022 };
            },
            async chooseMachineForProject(machines) { return machines[0]; },
            async addProject(_machine, environments) {
                return {
                    environmentId: environments[0].id,
                    name: 'API',
                    remotePath: '/work/api',
                };
            },
            ...prompts,
        },
        async refreshAuthoritative(_id, _operation, next) { snapshot = next; },
        async postSettlement(value) { settlements.push(value); },
    });
    return {
        controller,
        settlements,
        current: () => snapshot,
        render: () => renderManagedRemoteProjectsPanel(
            buildManagedRemoteProjectsViewModel(snapshot),
        ),
    };
}

test('MANAGED-REMOTE-E2E-001 adds the first Machine from an empty catalog and renders it', async () => {
    const bench = await harness();
    // An empty catalog reports no revision, which is exactly what the webview
    // puts on the wire. Rejecting that would make the toolbar permanently inert
    // on a fresh install.
    assert.equal(bench.current().revisionId, null);

    await bench.controller.handle(webviewAction('addMachine', bench.current().revisionId));

    assert.deepEqual(
        bench.settlements.map(item => item.status),
        ['applied'],
        `add Machine did not apply: ${JSON.stringify(bench.settlements)}`,
    );
    assert.equal(bench.current().catalog.machines.length, 1);
    assert.equal(bench.current().catalog.machines[0].name, 'RedDev');
    // The rendered panel is what the user actually sees.
    assert.match(bench.render(), /RedDev/u);
});

test('MANAGED-REMOTE-E2E-001 adds a Project onto the new Machine and renders it', async () => {
    const bench = await harness();
    await bench.controller.handle(webviewAction('addMachine', bench.current().revisionId));
    const machineId = bench.current().catalog.machines[0].id;

    await bench.controller.handle(
        webviewAction('addProject', bench.current().revisionId, machineId),
    );

    assert.deepEqual(bench.settlements.map(item => item.status), ['applied', 'applied']);
    assert.equal(bench.current().catalog.projects.length, 1);
    assert.match(bench.render(), /API/u);
});

test('MANAGED-REMOTE-E2E-001 keeps the revision the panel renders usable for the next action', async () => {
    const bench = await harness();
    await bench.controller.handle(webviewAction('addMachine', bench.current().revisionId));

    // The panel embeds the revision it rendered; the next click sends it back.
    // If the two disagree the toolbar dies after exactly one action.
    const rendered = bench.render();
    const embedded = /data-managed-revision-id="([^"]*)"/u.exec(rendered);
    assert.ok(embedded, 'the panel must publish the revision it rendered');
    assert.equal(embedded[1], bench.current().revisionId);

    await bench.controller.handle(
        webviewAction('addProject', embedded[1], bench.current().catalog.machines[0].id),
    );
    assert.deepEqual(bench.settlements.map(item => item.status), ['applied', 'applied']);
});

test('MANAGED-REMOTE-E2E-001 reports a cancelled wizard without mutating the catalog', async () => {
    const bench = await harness({ async addMachine() { return undefined; } });
    await bench.controller.handle(webviewAction('addMachine', bench.current().revisionId));

    assert.deepEqual(bench.settlements.map(item => item.status), ['cancelled']);
    assert.equal(bench.current().catalog.machines.length, 0);
});

test('MANAGED-REMOTE-E2E-001 surfaces a stale revision instead of failing silently', async () => {
    const bench = await harness();
    await bench.controller.handle(
        webviewAction('addMachine', `revision:${'f'.repeat(64)}`),
    );

    assert.equal(bench.settlements.length, 1);
    assert.equal(bench.settlements[0].status, 'failed');
    assert.match(bench.settlements[0].message, /changed|refresh/iu);
});
