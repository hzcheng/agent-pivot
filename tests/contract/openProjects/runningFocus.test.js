'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { makeTempDirectory } = require('../../helpers/tempDirectory');
const {
    createOpenWorkspaceRunningFocusRequest,
    MAX_OPEN_WORKSPACE_RUNNING_FOCUS_REQUESTS,
    validateOpenWorkspaceRunningFocusOutcome,
    validateOpenWorkspaceRunningFocusRequest,
} = require('../../../out/openWorkspaces/runningFocusProtocol');
const {
    OpenWorkspaceRunningFocusStore,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openWorkspaceRunningFocusStore');
const {
    OpenWorkspaceRunningFocusCoordinator,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openWorkspaceRunningFocusCoordinator');
const {
    OpenWorkspaceCoordinator,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openWorkspaceCoordinator');
const {
    OTHER,
    SELF,
    createSyntheticOpenWorkspaceStore,
    flushAsync,
    makePublication,
    makeRecord,
    makeRegistration,
} = require('./helpers');

const TARGET_IDENTITY = 'f'.repeat(64);

function makeRequest(overrides = {}) {
    return {
        protocolVersion: 2,
        requestId: 'a'.repeat(32),
        targetNavigationIdentity: TARGET_IDENTITY,
        createdAtMs: 1000,
        expiresAtMs: 61_000,
        ...overrides,
    };
}

test('OPEN-WORKSPACE-RUNNING-FOCUS-PROTOCOL-001 strictly validates focus requests and outcomes', () => {
    const request = makeRequest();
    assert.deepEqual(validateOpenWorkspaceRunningFocusRequest(request), request);
    assert.deepEqual(
        createOpenWorkspaceRunningFocusRequest({
            requestId: 'b'.repeat(32),
            targetNavigationIdentity: TARGET_IDENTITY,
            nowMs: 2000,
        }),
        makeRequest({ requestId: 'b'.repeat(32), createdAtMs: 2000, expiresAtMs: 62_000 }),
    );
    assert.throws(
        () => validateOpenWorkspaceRunningFocusRequest({ ...request, extra: true }),
        /unexpected fields/,
    );
    assert.throws(
        () => validateOpenWorkspaceRunningFocusRequest({ ...request, requestId: 'nope' }),
        /requestId/,
    );
    assert.throws(
        () => validateOpenWorkspaceRunningFocusRequest({ ...request, targetNavigationIdentity: 'nope' }),
        /targetNavigationIdentity/,
    );
    assert.throws(
        () => validateOpenWorkspaceRunningFocusRequest({ ...request, expiresAtMs: 1000 }),
        /within its lease/,
    );
    assert.throws(
        () => validateOpenWorkspaceRunningFocusRequest({ ...request, expiresAtMs: 1000 + 60_001 }),
        /within its lease/,
    );
    assert.throws(
        () => validateOpenWorkspaceRunningFocusRequest({ ...request, protocolVersion: 1 }),
        /protocol version/,
    );

    const outcome = {
        protocolVersion: 2,
        requestId: request.requestId,
        targetNavigationIdentity: TARGET_IDENTITY,
        delivered: true,
    };
    assert.deepEqual(validateOpenWorkspaceRunningFocusOutcome(outcome), outcome);
    assert.throws(
        () => validateOpenWorkspaceRunningFocusOutcome({ ...outcome, delivered: false }),
        /must be delivered/,
    );
});

test('OPEN-WORKSPACE-RUNNING-FOCUS-STORE-001 submits, scans, consumes, and sweeps expired requests', async t => {
    const root = makeTempDirectory(t, 'running-focus-store-');
    const store = new OpenWorkspaceRunningFocusStore(root);

    await store.submit(makeRequest());
    await store.submit(makeRequest({ requestId: 'b'.repeat(32), createdAtMs: 900, expiresAtMs: 60_900 }));
    await store.submit(makeRequest({ requestId: 'c'.repeat(32), createdAtMs: 500, expiresAtMs: 700 }));

    let pending = await store.scan(1000);
    assert.deepEqual(pending.map(request => request.requestId), [
        'b'.repeat(32),
        'a'.repeat(32),
    ]);

    // The expired request was swept by the scan; malformed files are ignored.
    const fs = require('node:fs');
    fs.writeFileSync(
        require('node:path').join(store.directoryPath, `${'d'.repeat(32)}.request.json`),
        '{"not":"a request"}',
    );
    pending = await store.scan(1000);
    assert.equal(pending.length, 2);

    assert.equal(await store.claim('a'.repeat(32)), true);
    assert.deepEqual((await store.scan(1000)).map(request => request.requestId), [
        'b'.repeat(32),
    ]);
    await store.restore('a'.repeat(32));
    assert.equal(await store.claim('a'.repeat(32)), true);
    await store.complete('a'.repeat(32));
    assert.equal(await store.waitForDelivery('a'.repeat(32), 50), true);
    pending = await store.scan(1000);
    assert.deepEqual(pending.map(request => request.requestId), ['b'.repeat(32)]);

    assert.equal(await store.claim('b'.repeat(32)), true);
    await store.cancel('b'.repeat(32));
    await store.complete('b'.repeat(32));
    assert.equal(await store.waitForDelivery('b'.repeat(32), 20), false,
        'a timed-out claim cannot leave a receipt that a later request consumes');
});

test('OPEN-WORKSPACE-RUNNING-FOCUS-STORE-001 refuses submissions beyond the pending cap', async t => {
    const root = makeTempDirectory(t, 'running-focus-cap-');
    const store = new OpenWorkspaceRunningFocusStore(root);
    for (let index = 0; index < MAX_OPEN_WORKSPACE_RUNNING_FOCUS_REQUESTS; index += 1) {
        await store.submit(makeRequest({
            requestId: index.toString(16).padStart(32, '0'),
            createdAtMs: 1000 + index,
            expiresAtMs: 61_000 + index,
        }));
    }
    await assert.rejects(
        store.submit(makeRequest({ requestId: 'e'.repeat(32) })),
        /pending/,
    );
});

function createFocusCoordinator(t, overrides = {}) {
    const root = makeTempDirectory(t, 'running-focus-coordinator-');
    const mailbox = new Map();
    const claims = new Map();
    const receipts = new Set();
    const waiters = new Map();
    const deliveries = [];
    const errors = [];
    const winners = overrides.winners || new Set();
    let fireInterval;
    const coordinator = new OpenWorkspaceRunningFocusCoordinator(root, {
        now: () => overrides.nowMs ?? 5000,
        setInterval: callback => {
            fireInterval = callback;
            return 'focus-interval';
        },
        clearInterval: () => undefined,
        createWatcher: (_directory, _onDidChange) => ({ close: () => undefined }),
        createStore: () => ({
            directoryPath: path.join(root, 'mailbox'),
            submit: async request => {
                mailbox.set(request.requestId, request);
                return request;
            },
            scan: async nowMs => Array.from(mailbox.values())
                .filter(request => request.expiresAtMs > nowMs)
                .sort((left, right) => left.createdAtMs - right.createdAtMs
                    || left.requestId.localeCompare(right.requestId)),
            claim: async requestId => {
                const request = mailbox.get(requestId);
                if (!request) {
                    return false;
                }
                mailbox.delete(requestId);
                claims.set(requestId, request);
                return true;
            },
            restore: async requestId => {
                const request = claims.get(requestId);
                if (request) {
                    claims.delete(requestId);
                    mailbox.set(requestId, request);
                }
            },
            complete: async requestId => {
                if (!claims.delete(requestId)) {
                    return;
                }
                const waiter = waiters.get(requestId);
                if (waiter) {
                    waiters.delete(requestId);
                    waiter(true);
                } else {
                    receipts.add(requestId);
                }
            },
            waitForDelivery: async requestId => {
                if (receipts.delete(requestId)) {
                    return true;
                }
                return new Promise(resolve => waiters.set(requestId, resolve));
            },
            cancel: async requestId => {
                mailbox.delete(requestId);
                claims.delete(requestId);
                receipts.delete(requestId);
                const waiter = waiters.get(requestId);
                if (waiter) {
                    waiters.delete(requestId);
                    waiter(false);
                }
            },
        }),
        deliverRequest: request => {
            deliveries.push(request.requestId);
            if (overrides.failDeliveryFor && overrides.failDeliveryFor.has(request.requestId)) {
                throw new Error('command is not registered: legacy main extension');
            }
        },
        isNavigationWinner: navigationIdentity => Promise.resolve(winners.has(navigationIdentity)),
        reportError: error => errors.push(error),
        ...overrides.dependencies,
    });
    return {
        coordinator,
        deliveries,
        errors,
        mailbox,
        fireInterval: () => fireInterval(),
    };
}

test('OPEN-WORKSPACE-RUNNING-FOCUS-COORDINATOR-001 delivers mailbox requests only from the winning window', async t => {
    const winners = new Set();
    const { coordinator, deliveries, errors, mailbox } = createFocusCoordinator(t, { winners });
    t.after(() => coordinator.dispose());

    const submission = coordinator.submit(makeRequest());
    await flushAsync();
    assert.deepEqual(deliveries, [], 'a non-winning window must not deliver');
    assert.equal(mailbox.size, 1);

    winners.add(TARGET_IDENTITY);
    coordinator.requestDelivery();
    const outcome = await submission;
    assert.deepEqual(outcome, {
        protocolVersion: 2,
        requestId: 'a'.repeat(32),
        targetNavigationIdentity: TARGET_IDENTITY,
        delivered: true,
    });
    assert.deepEqual(deliveries, ['a'.repeat(32)]);
    assert.equal(mailbox.size, 0, 'a delivered request is consumed');

    coordinator.requestDelivery();
    await flushAsync();
    assert.equal(deliveries.length, 1, 'a consumed request must not redeliver');
    assert.deepEqual(errors, []);
});

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 OPEN-WORKSPACE-RUNNING-FOCUS-COORDINATOR-001 settles only after the winning window accepts delivery', async t => {
    const root = makeTempDirectory(t, 'running-focus-delivery-receipt-');
    const deliveries = [];
    const makeCoordinator = winner => new OpenWorkspaceRunningFocusCoordinator(root, {
        now: () => 5000,
        setInterval: () => `running-focus-${winner}`,
        clearInterval: () => undefined,
        createWatcher: () => ({ close: () => undefined }),
        deliverRequest: request => deliveries.push(request.requestId),
        isNavigationWinner: () => Promise.resolve(winner),
        reportError: error => { throw error; },
        deliveryWaitMs: 500,
    });
    const source = makeCoordinator(false);
    const target = makeCoordinator(true);
    t.after(() => {
        source.dispose();
        target.dispose();
    });

    const submission = source.submit(makeRequest({
        createdAtMs: 5000,
        expiresAtMs: 65_000,
    }));
    const settledBeforeDelivery = await Promise.race([
        submission.then(() => true),
        new Promise(resolve => setTimeout(() => resolve(false), 100)),
    ]);

    assert.equal(settledBeforeDelivery, false,
        'the source must not switch windows while an old Running handoff can still arrive');
    target.requestDelivery();
    await submission;
    assert.deepEqual(deliveries, ['a'.repeat(32)]);
});

test('AI-SESSION-NEXT-RUNNING-COMMAND-001 OPEN-WORKSPACE-RUNNING-FOCUS-COORDINATOR-001 cancels an unclaimed timeout before later navigation', async t => {
    const root = makeTempDirectory(t, 'running-focus-timeout-cancel-');
    const deliveries = [];
    const makeCoordinator = (winner, deliveryWaitMs) =>
        new OpenWorkspaceRunningFocusCoordinator(root, {
            now: () => 5000,
            setInterval: () => `running-focus-timeout-${winner}`,
            clearInterval: () => undefined,
            createWatcher: () => ({ close: () => undefined }),
            deliverRequest: request => deliveries.push(request.requestId),
            isNavigationWinner: () => Promise.resolve(winner),
            reportError: error => { throw error; },
            deliveryWaitMs,
        });
    const source = makeCoordinator(false, 20);
    const target = makeCoordinator(true, 200);
    t.after(() => {
        source.dispose();
        target.dispose();
    });

    await assert.rejects(
        source.submit(makeRequest({ createdAtMs: 5000, expiresAtMs: 65_000 })),
        /not delivered in time/,
    );
    target.requestDelivery();
    await flushAsync();

    assert.deepEqual(deliveries, [],
        'a timed-out Running request cannot arrive after a newer navigation command');
});

test('OPEN-WORKSPACE-RUNNING-FOCUS-COORDINATOR-001 keeps undeliverable requests for retry until consumed', async t => {
    const failures = new Set(['a'.repeat(32)]);
    const { coordinator, deliveries, errors, mailbox } = createFocusCoordinator(t, {
        winners: new Set([TARGET_IDENTITY]),
        failDeliveryFor: failures,
    });
    t.after(() => coordinator.dispose());

    const submission = coordinator.submit(makeRequest());
    await flushAsync();
    assert.deepEqual(deliveries, ['a'.repeat(32)]);
    assert.equal(errors.length, 1);
    assert.equal(mailbox.size, 1, 'a failed delivery stays in the mailbox');

    failures.clear();
    coordinator.requestDelivery();
    await submission;
    assert.deepEqual(deliveries, ['a'.repeat(32), 'a'.repeat(32)]);
    assert.equal(mailbox.size, 0);

    coordinator.requestDelivery();
    await flushAsync();
    assert.equal(deliveries.length, 2, 'a consumed request must not be delivered again');
});

test('OPEN-WORKSPACE-RUNNING-FOCUS-COORDINATOR-001 rejects malformed submissions without touching the mailbox', async t => {
    const { coordinator, mailbox } = createFocusCoordinator(t, {
        winners: new Set([TARGET_IDENTITY]),
    });
    t.after(() => coordinator.dispose());

    await assert.rejects(
        coordinator.submit({ ...makeRequest(), requestId: 'bad' }),
        /requestId/,
    );
    await assert.rejects(
        coordinator.submit({ ...makeRequest(), protocolVersion: 1 }),
        /protocol version/,
    );
    assert.equal(mailbox.size, 0);
});

function createRegistryCoordinator(root, store) {
    let nowMs = 5000;
    const coordinator = new OpenWorkspaceCoordinator(root, {
        now: () => nowMs,
        setInterval: () => 'registry-interval',
        clearInterval: () => undefined,
        createWatcher: () => ({ close: () => undefined }),
        createStore: () => store,
        deliverAggregate: () => undefined,
    });
    return {
        coordinator,
        setNow: value => { nowMs = value; },
    };
}

test('OPEN-WORKSPACE-RUNNING-FOCUS-COORDINATOR-001 resolves the navigation winner by focus priority', async t => {
    const root = makeTempDirectory(t, 'running-focus-winner-');
    const mine = makeRecord({ uri: '/work/mine' });
    const theirs = makeRecord({ uri: '/work/theirs' });
    const store = createSyntheticOpenWorkspaceStore([
        makeRegistration(OTHER, 4000, '/work/theirs'),
    ]);
    const { coordinator } = createRegistryCoordinator(root, store);
    t.after(() => coordinator.dispose());

    await coordinator.publish(makePublication({
        instanceId: SELF,
        workspace: mine,
    }));
    await flushAsync();

    assert.equal(await coordinator.isNavigationWinner(mine.navigationIdentity), true);
    assert.equal(await coordinator.isNavigationWinner(theirs.navigationIdentity), false);
    assert.equal(await coordinator.isNavigationWinner('0'.repeat(64)), false);
    assert.equal(await coordinator.isNavigationWinner('not-an-identity'), false);

    // A second window on the same workspace wins when it was focused more recently.
    store.seed(makeRegistration(OTHER, 9000, '/work/mine'));
    assert.equal(await coordinator.isNavigationWinner(mine.navigationIdentity), false);
});
