'use strict';

// Covers OPEN-WINDOW-NAVIGATION-SETTLEMENT-001 (host side): every
// open-window-navigation-request settles exactly once with its association
// fields echoed back, across malformed / stale / untitled / throw / success
// paths.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    OpenWindowNavigationRequestController,
    OPEN_WINDOW_NAVIGATION_WEBVIEW_PROTOCOL_VERSION,
} = require('../../../out/openWorkspaces/openWindowNavigationRequestController');

const VALID_CARD_ID = '__openWorkspaceNavigation-' + 'a'.repeat(24);

function makeRequest(overrides = {}) {
    return {
        type: 'open-window-navigation-request',
        version: OPEN_WINDOW_NAVIGATION_WEBVIEW_PROTOCOL_VERSION,
        requestId: 1,
        cardId: VALID_CARD_ID,
        ...overrides,
    };
}

function createHarness(navigate, options = {}) {
    const posted = [];
    const telemetry = [];
    const controller = new OpenWindowNavigationRequestController({
        navigate,
        postMessage: message => {
            posted.push(message);
            return Promise.resolve(true);
        },
        logError: () => {},
        recordTelemetry: event => telemetry.push(event),
        nowMs: () => 125,
        ...options,
    });
    return { controller, posted, telemetry };
}

test('OPEN-WINDOW-NAVIGATION-SETTLEMENT-001: successful navigation settles with focused', async () => {
    const { controller, posted, telemetry } = createHarness(async () => 'focused');
    await controller.handle(makeRequest());
    assert.equal(posted.length, 1);
    assert.deepEqual(posted[0], {
        type: 'open-window-navigation-result',
        version: 1,
        requestId: 1,
        cardId: VALID_CARD_ID,
        outcome: 'focused',
    });
    assert.deepEqual(telemetry, [{
        event: 'open-tab-window-navigation', outcome: 'focused', durationMs: 0,
    }], 'telemetry records only aggregate outcome and duration, never card identity');
});

test('OPEN-WINDOW-NAVIGATION-SETTLEMENT-001: a rapid second switch records only a timestamp-based suspected correction', async () => {
    const writes = [];
    const { controller, telemetry } = createHarness(async () => 'focused', {
        readLastFocusedNavigationAtMs: () => 10_000,
        writeLastFocusedNavigationAtMs: atMs => {
            writes.push(atMs);
            return Promise.resolve();
        },
        nowEpochMs: () => 12_500,
    });
    await controller.handle(makeRequest());
    assert.deepEqual(telemetry, [
        {
            event: 'open-tab-window-navigation-suspected-correction',
            delayMs: 2500,
        },
        { event: 'open-tab-window-navigation', outcome: 'focused', durationMs: 0 },
    ], 'the correction event must not contain a card, window, or session identity');
    assert.deepEqual(writes, [12_500]);
});

test('OPEN-WINDOW-NAVIGATION-SETTLEMENT-001: stale or failed switches do not refresh the correction marker', async () => {
    const writes = [];
    const { controller, telemetry } = createHarness(async () => 'failed', {
        readLastFocusedNavigationAtMs: () => 1,
        writeLastFocusedNavigationAtMs: atMs => {
            writes.push(atMs);
            return Promise.resolve();
        },
        nowEpochMs: () => 10_000,
    });
    await controller.handle(makeRequest());
    assert.deepEqual(telemetry, [
        { event: 'open-tab-window-navigation', outcome: 'failed', durationMs: 0 },
    ]);
    assert.deepEqual(writes, []);
});

test('OPEN-WINDOW-NAVIGATION-SETTLEMENT-001: stale target settles with stale-target', async () => {
    const { controller, posted } = createHarness(async () => 'stale-target');
    await controller.handle(makeRequest({ requestId: 7 }));
    assert.equal(posted.length, 1);
    assert.equal(posted[0].outcome, 'stale-target');
    assert.equal(posted[0].requestId, 7);
    assert.equal(posted[0].cardId, VALID_CARD_ID);
});

test('OPEN-WINDOW-NAVIGATION-SETTLEMENT-001: untitled workspace settles with untitled-workspace', async () => {
    const { controller, posted } = createHarness(async () => 'untitled-workspace');
    await controller.handle(makeRequest());
    assert.equal(posted.length, 1);
    assert.equal(posted[0].outcome, 'untitled-workspace');
});

test('OPEN-WINDOW-NAVIGATION-SETTLEMENT-001: navigation throw settles with failed', async () => {
    const { controller, posted } = createHarness(async () => {
        throw new Error('command exploded');
    });
    await controller.handle(makeRequest());
    assert.equal(posted.length, 1);
    assert.equal(posted[0].outcome, 'failed');
});

test('OPEN-WINDOW-NAVIGATION-SETTLEMENT-001: malformed request settles when association fields are salvageable', async () => {
    const { controller, posted, telemetry } = createHarness(async () => 'focused');
    await controller.handle({
        type: 'open-window-navigation-request',
        version: 1,
        requestId: 42,
        cardId: VALID_CARD_ID,
        unexpected: true,
    });
    assert.equal(posted.length, 1);
    assert.equal(posted[0].outcome, 'malformed-request');
    assert.equal(posted[0].requestId, 42);
    assert.equal(posted[0].cardId, VALID_CARD_ID);
    assert.deepEqual(telemetry, [{
        event: 'open-tab-window-navigation', outcome: 'malformed-request', durationMs: 0,
    }]);
});

test('OPEN-WINDOW-NAVIGATION-SETTLEMENT-001: malformed request without salvageable association fields settles nothing', async () => {
    const { controller, posted } = createHarness(async () => 'focused');
    await controller.handle({ type: 'open-window-navigation-request', version: 1 });
    await controller.handle(null);
    await controller.handle('open-window-navigation-request');
    assert.equal(posted.length, 0);
});

test('OPEN-WINDOW-NAVIGATION-SETTLEMENT-001: wrong version and bad cardId still settle as malformed when fields parse', async () => {
    const { controller, posted } = createHarness(async () => 'focused');
    await controller.handle(makeRequest({ version: 99 }));
    assert.equal(posted.length, 1);
    assert.equal(posted[0].outcome, 'malformed-request');

    const badCard = makeRequest({ cardId: 'not-a-card-id' });
    await controller.handle(badCard);
    // cardId fails the pattern, so it is not salvageable: no settlement.
    assert.equal(posted.length, 1);
});

test('OPEN-WINDOW-NAVIGATION-SETTLEMENT-001: settlement failure is swallowed and logged', async () => {
    const logged = [];
    const controller = new OpenWindowNavigationRequestController({
        navigate: async () => 'focused',
        postMessage: () => Promise.reject(new Error('post failed')),
        logError: (message, error) => logged.push([message, String(error)]),
    });
    await controller.handle(makeRequest());
    assert.equal(logged.length, 1);
    assert.match(logged[0][0], /settle/);
});
