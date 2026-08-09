'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { makeTempDirectory } = require('../../helpers/tempDirectory');
const {
    createOpenWorkspaceAttentionFocusRequest,
    validateOpenWorkspaceAttentionFocusOutcome,
    validateOpenWorkspaceAttentionFocusRequest,
} = require('../../../out/openWorkspaces/attentionFocusProtocol');
const {
    OpenWorkspaceAttentionFocusStore,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openWorkspaceAttentionFocusStore');
const {
    OpenWorkspaceAttentionFocusCoordinator,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openWorkspaceAttentionFocusCoordinator');

const TARGET_IDENTITY = 'f'.repeat(64);
const PROJECT_ID = 'e'.repeat(64);

function makeRequest(overrides = {}) {
    return {
        protocolVersion: 1,
        requestId: 'a'.repeat(32),
        targetNavigationIdentity: TARGET_IDENTITY,
        projectId: PROJECT_ID,
        provider: 'codex',
        sessionId: 'session-1',
        createdAtMs: 1000,
        expiresAtMs: 61_000,
        ...overrides,
    };
}

test('ATTENTION-STATUS-BAR-QUEUE-001 strictly validates exact attention focus requests', () => {
    const request = makeRequest();
    assert.deepEqual(validateOpenWorkspaceAttentionFocusRequest(request), request);
    assert.deepEqual(createOpenWorkspaceAttentionFocusRequest({
        requestId: 'b'.repeat(32),
        targetNavigationIdentity: TARGET_IDENTITY,
        target: {
            projectId: PROJECT_ID,
            provider: 'kimi',
            sessionId: 'session-2',
        },
        nowMs: 2000,
    }), makeRequest({
        requestId: 'b'.repeat(32),
        provider: 'kimi',
        sessionId: 'session-2',
        createdAtMs: 2000,
        expiresAtMs: 62_000,
    }));
    assert.throws(
        () => validateOpenWorkspaceAttentionFocusRequest({ ...request, extra: true }),
        /unexpected fields/,
    );
    assert.throws(
        () => validateOpenWorkspaceAttentionFocusRequest({ ...request, provider: 'other' }),
        /provider/,
    );
    assert.throws(
        () => validateOpenWorkspaceAttentionFocusRequest({ ...request, projectId: 'bad' }),
        /projectId/,
    );
    assert.throws(
        () => validateOpenWorkspaceAttentionFocusRequest({ ...request, expiresAtMs: 1000 }),
        /within its lease/,
    );

    const outcome = {
        protocolVersion: 1,
        requestId: request.requestId,
        targetNavigationIdentity: TARGET_IDENTITY,
        delivered: true,
    };
    assert.deepEqual(validateOpenWorkspaceAttentionFocusOutcome(outcome), outcome);
    assert.throws(
        () => validateOpenWorkspaceAttentionFocusOutcome({ ...outcome, delivered: false }),
        /must be delivered/,
    );
});

test('ATTENTION-STATUS-BAR-QUEUE-001 claims and receipts attention focus mailbox requests', async t => {
    const root = makeTempDirectory(t, 'attention-focus-store-');
    const store = new OpenWorkspaceAttentionFocusStore(root);
    await store.submit(makeRequest());
    assert.deepEqual((await store.scan(1000)).map(request => request.requestId), [
        'a'.repeat(32),
    ]);

    assert.equal(await store.claim('a'.repeat(32)), true);
    assert.deepEqual(await store.scan(1000), [], 'a claimed request cannot be delivered twice');
    await store.restore('a'.repeat(32));
    assert.equal((await store.scan(1000)).length, 1);

    assert.equal(await store.claim('a'.repeat(32)), true);
    await store.complete('a'.repeat(32));
    assert.equal(await store.waitForDelivery('a'.repeat(32), 50), true);
    assert.equal(await store.waitForDelivery('a'.repeat(32), 20), false,
        'a consumed receipt cannot be reused');

    await store.submit(makeRequest({ requestId: 'b'.repeat(32) }));
    assert.equal(await store.claim('b'.repeat(32)), true);
    await store.cancel('b'.repeat(32));
    await store.complete('b'.repeat(32));
    assert.equal(await store.waitForDelivery('b'.repeat(32), 20), false,
        'a completion that lost its claim after timeout must not leave an orphan receipt');
});

test('ATTENTION-STATUS-BAR-QUEUE-001 reports delivery only after the target queues the exact focus', async t => {
    const root = makeTempDirectory(t, 'attention-focus-coordinator-');
    const deliveries = [];
    const errors = [];
    const coordinator = new OpenWorkspaceAttentionFocusCoordinator(root, {
        now: () => 5000,
        setInterval: () => 'attention-focus-interval',
        clearInterval: () => undefined,
        createWatcher: () => ({ close: () => undefined }),
        deliverRequest: request => deliveries.push(request),
        isNavigationWinner: identity => Promise.resolve(identity === TARGET_IDENTITY),
        reportError: error => errors.push(error),
        deliveryWaitMs: 200,
    });
    t.after(() => coordinator.dispose());

    const outcome = await coordinator.submit(makeRequest({
        createdAtMs: 5000,
        expiresAtMs: 65_000,
    }));
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].sessionId, 'session-1');
    assert.deepEqual(outcome, {
        protocolVersion: 1,
        requestId: 'a'.repeat(32),
        targetNavigationIdentity: TARGET_IDENTITY,
        delivered: true,
    });
    assert.deepEqual(errors, []);
});

test('ATTENTION-STATUS-BAR-QUEUE-001 waits for a different winning window to receipt delivery', async t => {
    const root = makeTempDirectory(t, 'attention-focus-cross-window-');
    const deliveries = [];
    const makeCoordinator = winner => new OpenWorkspaceAttentionFocusCoordinator(root, {
        now: () => 5000,
        setInterval: () => `attention-focus-${winner}`,
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
    await new Promise(resolve => setTimeout(resolve, 20));
    target.requestDelivery();

    assert.equal((await submission).delivered, true);
    assert.deepEqual(deliveries, ['a'.repeat(32)]);
});
