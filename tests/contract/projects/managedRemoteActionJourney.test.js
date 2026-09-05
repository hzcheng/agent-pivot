'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createCausalVersion,
    createVersionedCandidates,
    joinVersionVectors,
    vectorIncludingVersion,
} = require('../../../out/projects/managedRemote/causal');
const { ManagedRemoteCatalogService } = require('../../../out/projects/managedRemote/catalogService');
const {
    applyManagedCatalogTransaction,
} = require('../../../out/projects/managedRemote/merge');
const {
    createEmptyManagedCatalogEnvelope,
    createManagedRevisionSlot,
} = require('../../../out/projects/managedRemote/envelope');
const {
    managedSshAliasSuffix,
} = require('../../../out/projects/managedRemote/sshConfigProjection');
const {
    ManagedRemoteBridgeController,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/managedRemoteBridgeController');

const MACHINE_NAME = '小红书开发机';
const MACHINE_ID = 'machine:one';
const ALIAS = `${MACHINE_NAME}-${managedSshAliasSuffix(MACHINE_ID)}`;
const CONTAINER_PAYLOAD = Buffer.from(JSON.stringify({
    hostPath: '/work/container',
    localDocker: false,
}), 'utf8').toString('hex');

/**
 * A Machine whose name is non-ASCII, whose port is not 22, and which carries
 * both a Host and a Dev Container Project. This is the combination that
 * regressed: the alias generator accepted the Unicode name while the Dev
 * Container URI rebuilder rejected it.
 */
function journeyEnvelope() {
    let ordinal = 0;
    const catalog = ManagedRemoteCatalogService.create(
        'journey',
        prefix => (prefix === 'machine' ? 'machine:one' : `${prefix}:${++ordinal}`),
    );
    const machine = catalog.addMachine({
        name: MACHINE_NAME, host: 'reddev.example.com', user: 'dev', port: 22022,
    });
    const hostProject = catalog.addProject({
        id: 'project:host',
        environmentId: `host:${machine.id}`,
        name: 'API',
        remotePath: '/work/api',
    });
    const containerId = 'environment:container';
    const withContainer = new ManagedRemoteCatalogService(
        applyManagedCatalogTransaction(catalog.getDocument(), 'journey', {
            environments: {
                [containerId]: {
                    id: containerId,
                    machineId: machine.id,
                    kind: 'devContainer',
                    name: 'Dev Container',
                    devContainerAnchor: {
                        version: 1,
                        originalAuthority:
                            `dev-container+${CONTAINER_PAYLOAD}@ssh-remote+legacy`,
                        sourceKind: 'workspace',
                        sourceLocator: '/work/container',
                    },
                },
            },
        }),
        'journey',
        prefix => `${prefix}:${++ordinal}`,
    );
    const containerProject = withContainer.addProject({
        id: 'project:container',
        environmentId: containerId,
        name: 'Container API',
        remotePath: '/work/container-api',
    });

    const slot = createManagedRevisionSlot(withContainer.getDocument());
    const envelope = createEmptyManagedCatalogEnvelope('envelope');
    const version = createCausalVersion(envelope.causalContext, 'envelope');
    envelope.authority = createVersionedCandidates(
        { lifecycle: 'active', active: slot }, version,
    );
    envelope.causalContext = joinVersionVectors(
        envelope.causalContext, vectorIncludingVersion(version),
    );
    return {
        envelope,
        slot,
        machine,
        hostProject,
        container: { id: containerId },
        containerProject,
    };
}

function harness(envelope) {
    const effects = {
        windows: [], folders: [], terminals: [], copied: [], ensured: [],
    };
    const controller = new ManagedRemoteBridgeController({
        readManagedCatalogEnvelope() { return envelope; },
    }, {
        async create() {
            return {
                getExecutable() { return '/usr/bin/ssh'; },
                async reconcile() {
                    throw new Error('a user action must never block on reconcile');
                },
            };
        },
    }, 'session-12345678', {
        platform: 'linux',
        openTerminal(options) { effects.terminals.push(options); },
        async writeClipboard(value) { effects.copied.push(value); },
        async openRemoteWindow(authority) { effects.windows.push(authority); },
        async openRemoteFolder(uri) { effects.folders.push(uri); },
    }, {
        schedule() {},
        async ensureReady(slot) { effects.ensured.push(slot.revisionId); },
    });
    return { controller, effects };
}

function invoke(controller, operation, revisionId, targetId) {
    return controller.execute({
        protocolVersion: 1,
        requestId: 'request-12345678',
        sessionToken: 'session-12345678',
        operation,
        ...(revisionId ? { expectedRevisionId: revisionId } : {}),
        ...(targetId ? { targetId } : {}),
    });
}

test('MANAGED-REMOTE-ACTIONS-001 opens a Machine for a non-ASCII name on a custom port', async () => {
    const { envelope, slot } = journeyEnvelope();
    const { controller, effects } = harness(envelope);

    const result = await invoke(controller, 'openManagedMachine', slot.revisionId, MACHINE_ID);

    assert.equal(result.status, 'ok');
    assert.equal(result.value.alias, ALIAS);
    assert.deepEqual(effects.windows, [`ssh-remote+${ALIAS}`]);
    // The authority addresses the alias only: the endpoint stays in the SSH
    // config projection so credentials never reach a window authority.
    assert.doesNotMatch(effects.windows[0], /reddev\.example\.com|dev@|22022/u);
});

test('MANAGED-REMOTE-ACTIONS-001 opens a Host Project under a non-ASCII Machine', async () => {
    const { envelope, slot, hostProject } = journeyEnvelope();
    const { controller, effects } = harness(envelope);

    const result = await invoke(
        controller, 'openManagedProject', slot.revisionId, hostProject.id,
    );

    assert.equal(result.status, 'ok');
    assert.deepEqual(effects.folders, [
        `vscode-remote://${encodeURIComponent(`ssh-remote+${ALIAS}`)}/work/api`,
    ]);
});

test('MANAGED-REMOTE-ACTIONS-001 opens a Dev Container Project under a non-ASCII Machine', async () => {
    const { envelope, slot, containerProject } = journeyEnvelope();
    const { controller, effects } = harness(envelope);

    const result = await invoke(
        controller, 'openManagedProject', slot.revisionId, containerProject.id,
    );

    assert.equal(result.status, 'ok');
    // The container payload is preserved verbatim and only the outer SSH
    // authority is retargeted onto the managed alias.
    assert.deepEqual(effects.folders, [
        `vscode-remote://${encodeURIComponent(
            `dev-container+${CONTAINER_PAYLOAD}@ssh-remote+${ALIAS}`,
        )}/work/container-api`,
    ]);
});

test('MANAGED-REMOTE-ACTIONS-001 opens a Dev Container Environment directly', async () => {
    const { envelope, slot, container } = journeyEnvelope();
    const { controller, effects } = harness(envelope);

    const result = await invoke(
        controller, 'openManagedEnvironment', slot.revisionId, container.id,
    );

    assert.equal(result.status, 'ok');
    assert.deepEqual(effects.windows, [
        `dev-container+${CONTAINER_PAYLOAD}@ssh-remote+${ALIAS}`,
    ]);
});

test('MANAGED-REMOTE-SSH-COMMAND-001 copies and opens a terminal for a custom port', async () => {
    const { envelope, slot } = journeyEnvelope();
    const { controller, effects } = harness(envelope);

    const terminal = await invoke(
        controller, 'openLocalSshTerminal', slot.revisionId, MACHINE_ID,
    );
    const copy = await invoke(
        controller, 'copyLocalSshCommand', slot.revisionId, MACHINE_ID,
    );

    assert.equal(terminal.status, 'ok');
    assert.equal(copy.status, 'ok');
    // Both address the endpoint directly, so neither depends on current.conf
    // having been projected yet.
    assert.deepEqual(effects.terminals[0].shellArgs, [
        '-p', '22022', '-l', 'dev', 'reddev.example.com',
    ]);
    assert.equal(effects.terminals[0].name, `SSH: ${MACHINE_NAME}`);
    assert.match(effects.copied[0], /22022/u);
    assert.match(effects.copied[0], /reddev\.example\.com/u);
});

test('MANAGED-REMOTE-ACTIONS-001 keeps every entry point resolvable after a rename', async () => {
    const { envelope, slot, hostProject, containerProject } = journeyEnvelope();
    const { controller, effects } = harness(envelope);

    await invoke(controller, 'openManagedMachine', slot.revisionId, MACHINE_ID);
    await invoke(controller, 'openManagedProject', slot.revisionId, hostProject.id);
    await invoke(controller, 'openManagedProject', slot.revisionId, containerProject.id);
    await invoke(controller, 'openLocalSshTerminal', slot.revisionId, MACHINE_ID);
    await invoke(controller, 'copyLocalSshCommand', slot.revisionId, MACHINE_ID);

    // All five actions resolved against one alias, and none of them fell back
    // to the slow projection reconcile path.
    assert.equal(effects.windows.length, 1);
    assert.equal(effects.folders.length, 2);
    assert.equal(effects.terminals.length, 1);
    assert.equal(effects.copied.length, 1);
    for (const uri of effects.folders) {
        assert.ok(decodeURIComponent(uri).includes(`ssh-remote+${ALIAS}`));
    }
});
