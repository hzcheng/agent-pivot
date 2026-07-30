'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    createOpenWorkspacePinSnapshot,
    validateOpenWorkspacePinSetOutcome,
    validateOpenWorkspacePinSetRequest,
    validateOpenWorkspacePinSnapshot,
} = require('../../../out/openWorkspaces/pinProtocol');
const {
    OpenWorkspacePinStore,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openWorkspacePinStore');
const {
    OpenWorkspacePinCoordinator,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openWorkspacePinCoordinator');
const {
    OpenWorkspacePinController,
} = require('../../../out/openWorkspaces/pinController');
const { makeRecord } = require('./helpers');

function pinRequest(requestId, navigationIdentity, pinned) {
    return {
        protocolVersion: 1,
        requestId,
        navigationIdentity,
        pinned,
    };
}

test('OPEN-WORKSPACE-PIN-PROTOCOL-001 strictly validates and deterministically orders pin snapshots', () => {
    const first = 'a'.repeat(64);
    const second = 'b'.repeat(64);
    const snapshot = createOpenWorkspacePinSnapshot([
        { protocolVersion: 1, navigationIdentity: second, pinnedAtMs: 20 },
        { protocolVersion: 1, navigationIdentity: first, pinnedAtMs: 10 },
    ]);

    assert.deepEqual(snapshot.pins.map(pin => pin.navigationIdentity), [first, second]);
    assert.deepEqual(validateOpenWorkspacePinSnapshot(snapshot), snapshot);
    assert.deepEqual(validateOpenWorkspacePinSetRequest(pinRequest(1, first, true)), pinRequest(1, first, true));
    assert.throws(
        () => validateOpenWorkspacePinSetRequest({ ...pinRequest(1, first, true), extra: true }),
        /unexpected fields/,
    );
    assert.throws(
        () => validateOpenWorkspacePinSnapshot({ ...snapshot, revision: 'f'.repeat(64) }),
        /revision does not match/,
    );
    assert.throws(
        () => validateOpenWorkspacePinSetOutcome({
            protocolVersion: 1,
            requestId: 1,
            navigationIdentity: first,
            pinned: false,
            snapshot,
        }),
        /does not match/,
    );
});

test('OPEN-WORKSPACE-PIN-STORE-001 preserves the first pin time across concurrent UI-host mutations', async t => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-pivot-pins-'));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const identity = 'c'.repeat(64);
    const firstStore = new OpenWorkspacePinStore(root);
    const secondStore = new OpenWorkspacePinStore(root);

    await Promise.all([
        firstStore.setPinned(pinRequest(1, identity, true), 2000),
        secondStore.setPinned(pinRequest(2, identity, true), 1000),
    ]);
    const pinned = await firstStore.scan();

    assert.equal(pinned.pins.length, 1);
    assert.ok(pinned.pins[0].pinnedAtMs === 1000 || pinned.pins[0].pinnedAtMs === 2000);
    const originalTime = pinned.pins[0].pinnedAtMs;
    await secondStore.setPinned(pinRequest(3, identity, true), 9000);
    assert.equal((await firstStore.scan()).pins[0].pinnedAtMs, originalTime);
    await firstStore.setPinned(pinRequest(4, identity, false), 10_000);
    assert.deepEqual((await secondStore.scan()).pins, []);
});

test('OPEN-WORKSPACE-PIN-STORE-001 rolls back one concurrent mutation at the 200-pin boundary', async t => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-pivot-pin-limit-'));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const firstStore = new OpenWorkspacePinStore(root);
    const secondStore = new OpenWorkspacePinStore(root);
    await fs.promises.mkdir(firstStore.directoryPath, { recursive: true });
    await Promise.all(Array.from({ length: 199 }, (_, index) => {
        const identity = index.toString(16).padStart(64, '0');
        return fs.promises.writeFile(
            path.join(firstStore.directoryPath, `${identity}.pin.json`),
            JSON.stringify({
                protocolVersion: 1,
                navigationIdentity: identity,
                pinnedAtMs: index,
            }),
        );
    }));
    const firstIdentity = 'e'.repeat(64);
    const secondIdentity = 'f'.repeat(64);

    const outcomes = await Promise.allSettled([
        firstStore.setPinned(pinRequest(1, firstIdentity, true), 10_000),
        secondStore.setPinned(pinRequest(2, secondIdentity, true), 10_001),
    ]);

    assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(outcome => outcome.status === 'rejected').length, 1);
    assert.equal((await firstStore.scan()).pins.length, 200);
    const markerNames = (await fs.promises.readdir(firstStore.directoryPath))
        .filter(name => name.endsWith('.pin.json'));
    assert.equal(markerNames.length, 200);
});

test('OPEN-WORKSPACE-PIN-COORDINATOR-001 returns durable success when proactive delivery fails and retries later', async t => {
    const identity = 'd'.repeat(64);
    let snapshot = createOpenWorkspacePinSnapshot([]);
    let deliveryAttempts = 0;
    let intervalCallback;
    const errors = [];
    const coordinator = new OpenWorkspacePinCoordinator('/synthetic-pins', {
        now: () => 1234,
        createStore: () => ({
            directoryPath: '/tmp',
            scan: async () => snapshot,
            setPinned: async request => {
                snapshot = createOpenWorkspacePinSnapshot(request.pinned ? [{
                    protocolVersion: 1,
                    navigationIdentity: request.navigationIdentity,
                    pinnedAtMs: 1234,
                }] : []);
                return { ...request, snapshot };
            },
        }),
        deliverSnapshot: () => {
            deliveryAttempts += 1;
            if (deliveryAttempts === 1) throw new Error('main host unavailable');
        },
        reportError: error => errors.push(error.message),
        setInterval: callback => {
            intervalCallback = callback;
            return 'timer';
        },
        clearInterval: () => undefined,
        createWatcher: () => ({ close: () => undefined }),
    });
    t.after(() => coordinator.dispose());

    const outcome = await coordinator.setPinned(pinRequest(1, identity, true));
    assert.equal(outcome.pinned, true);
    assert.deepEqual(errors, ['main host unavailable']);
    intervalCallback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(deliveryAttempts, 2);
});

test('OPEN-WORKSPACE-PIN-HOST-001 resolves card identity authoritatively and settles success and failure exactly once', async () => {
    const record = makeRecord();
    const posted = [];
    const mutations = [];
    let publishCount = 0;
    const controller = new OpenWorkspacePinController({
        getRecord: cardId => cardId === '__openWorkspaceNavigation-' + 'a'.repeat(24)
            ? record
            : null,
        setPinned: async (...args) => mutations.push(args),
        publishAuthoritativeUpdate: async () => { publishCount += 1; },
        postMessage: async message => posted.push(message),
        showError: () => undefined,
        logError: () => undefined,
    });

    await controller.handle({
        type: 'set-open-workspace-pin',
        version: 1,
        requestId: 7,
        cardId: '__openWorkspaceNavigation-' + 'a'.repeat(24),
        pinned: true,
    });
    await controller.handle({
        type: 'set-open-workspace-pin',
        version: 1,
        requestId: 8,
        cardId: '__openWorkspaceNavigation-' + 'b'.repeat(24),
        pinned: false,
    });

    assert.deepEqual(mutations, [[7, record.navigationIdentity, true]]);
    assert.equal(publishCount, 1);
    assert.deepEqual(posted.map(message => [message.requestId, message.success]), [
        [7, true],
        [8, false],
    ]);
});
