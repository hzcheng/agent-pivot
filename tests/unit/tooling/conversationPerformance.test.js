'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    assertBudget,
    measureViewerPublicationBudgets,
    retainedViewerSnapshot,
} = require('../../../scripts/run-conversation-performance-checks');

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 retains the reading anchor while enforcing viewer bounds', () => {
    const snapshot = retainedViewerSnapshot();
    assert.equal(snapshot.retainedAnchor, true);
    assert.ok(snapshot.retainedInteractions <= 100);
    assert.ok(snapshot.retainedBytes <= 4 * 1024 * 1024);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 measures Host publication paths and rejects invalid budgets', async () => {
    assert.doesNotThrow(() => assertBudget('fast path', 1, 2));
    assert.throws(() => assertBudget('missing', 1, undefined), /positive/);
    assert.throws(() => assertBudget('slow path', 3, 2), /exceeds/);

    const measurements = await measureViewerPublicationBudgets();
    assert.ok(measurements.hostInitialPublicationMs >= 0);
    assert.ok(measurements.hostIncrementalRefreshMs >= 0);
    assert.ok(measurements.hostSessionSwitchMs >= 0);
});
