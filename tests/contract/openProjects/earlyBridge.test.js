'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    EarlyOpenWorkspaceBridge,
} = require('../../../out/openWorkspaces/earlyBridge');

function makeBridge() {
    const created = [];
    const bridge = new EarlyOpenWorkspaceBridge({
        createClient: handlers => {
            const client = { handlers, id: created.length + 1 };
            created.push(client);
            return client;
        },
        logError: () => undefined,
    });
    return { bridge, created };
}

function makeHandlers(log) {
    return {
        onAggregate: aggregate => log.push(['aggregate', aggregate]),
        onStatusChange: status => log.push(['status', status]),
        onPinSnapshot: snapshot => log.push(['pin', snapshot]),
        onError: error => log.push(['error', error]),
    };
}

test('OPEN-DASHBOARD-BRIDGE-LIFECYCLE-001 creates the client once so the handshake starts before bootstrap', () => {
    const { bridge, created } = makeBridge();

    assert.equal(created.length, 1);
    assert.equal(bridge.getClient(), created[0]);
});

test('OPEN-DASHBOARD-BRIDGE-LIFECYCLE-001 replays the latest pre-adoption state exactly once', () => {
    const { bridge, created } = makeBridge();
    const log = [];
    created[0].handlers.onStatusChange('unavailable');
    created[0].handlers.onPinSnapshot({ revision: 1 });
    created[0].handlers.onAggregate({ semanticRevision: 'a' });
    created[0].handlers.onStatusChange('ready');
    created[0].handlers.onAggregate({ semanticRevision: 'b' });
    assert.deepEqual(log, []);

    bridge.adopt(makeHandlers(log));

    assert.deepEqual(log, [
        ['status', 'ready'],
        ['pin', { revision: 1 }],
        ['aggregate', { semanticRevision: 'b' }],
    ]);
});

test('OPEN-DASHBOARD-BRIDGE-LIFECYCLE-001 forwards live callbacks straight to the adopted handlers', () => {
    const { bridge, created } = makeBridge();
    const log = [];
    bridge.adopt(makeHandlers(log));

    created[0].handlers.onAggregate({ semanticRevision: 'c' });
    created[0].handlers.onStatusChange('ready');

    assert.deepEqual(log, [
        ['aggregate', { semanticRevision: 'c' }],
        ['status', 'ready'],
    ]);
});

test('OPEN-DASHBOARD-BRIDGE-LIFECYCLE-001 keeps the same client and re-buffers after a bootstrap generation is released', () => {
    const { bridge, created } = makeBridge();
    const first = [];
    bridge.adopt(makeHandlers(first));
    bridge.release();

    created[0].handlers.onAggregate({ semanticRevision: 'd' });
    assert.deepEqual(first, []);

    const second = [];
    bridge.adopt(makeHandlers(second));

    assert.equal(created.length, 1, 'a retry must not register a second bridge client');
    assert.deepEqual(second, [['aggregate', { semanticRevision: 'd' }]]);
});

test('OPEN-DASHBOARD-BRIDGE-LIFECYCLE-001 does not replay state the adopted handlers already saw', () => {
    const { bridge, created } = makeBridge();
    const log = [];
    created[0].handlers.onAggregate({ semanticRevision: 'e' });
    bridge.adopt(makeHandlers(log));
    bridge.release();

    const second = [];
    bridge.adopt(makeHandlers(second));

    assert.deepEqual(log, [['aggregate', { semanticRevision: 'e' }]]);
    assert.deepEqual(second, [], 'nothing new arrived while released');
});

test('OPEN-DASHBOARD-BRIDGE-LIFECYCLE-001 keeps buffering when an adopted handler throws', () => {
    const { bridge, created } = makeBridge();
    bridge.adopt({
        onAggregate: () => { throw new Error('handler exploded'); },
        onStatusChange: () => undefined,
        onPinSnapshot: () => undefined,
        onError: () => undefined,
    });

    assert.doesNotThrow(() => created[0].handlers.onAggregate({ semanticRevision: 'f' }));

    const log = [];
    bridge.release();
    bridge.adopt(makeHandlers(log));
    assert.deepEqual(log, [], 'a delivered-then-failed aggregate is not silently replayed');
});

test('OPEN-DASHBOARD-BRIDGE-LIFECYCLE-001 reports pre-adoption errors without losing them', () => {
    const { bridge, created } = makeBridge();
    const failure = new Error('bridge unreachable');

    assert.doesNotThrow(() => created[0].handlers.onError(failure));

    const log = [];
    bridge.adopt(makeHandlers(log));
    assert.deepEqual(log, [], 'errors are logged as they happen, never replayed as new failures');
});
