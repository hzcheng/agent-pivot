'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    OBSOLETE_PROJECT_SETTING_KEYS,
} = require('../../../out/constants');

/**
 * Mirrors the activation-time cleanup in dashboard.ts. The behaviour worth
 * pinning is that it only writes when a value is actually present and never
 * throws: it runs on every activation, so a failure must not break startup.
 */
function clearObsolete(configurationSource, log = []) {
    const cleared = [];
    for (const key of OBSOLETE_PROJECT_SETTING_KEYS) {
        try {
            const configuration = configurationSource();
            if (configuration.inspect(key)?.globalValue === undefined) { continue; }
            configuration.update(key, undefined, 'global');
            cleared.push(key);
        } catch (error) {
            log.push(`${key}:${error.message}`);
        }
    }
    return cleared;
}

function source(values, options = {}) {
    const writes = [];
    return {
        writes,
        acquire: () => ({
            inspect: key => (key in values ? { globalValue: values[key] } : undefined),
            update: (key, value, target) => {
                if (options.failOn === key) { throw new Error('denied'); }
                writes.push([key, value, target]);
                delete values[key];
            },
        }),
    };
}

test('PROJECT-OBSOLETE-SETTINGS-001 names only the pre-catalog project keys', () => {
    // Widening this list would delete settings that still back behaviour.
    assert.deepEqual([...OBSOLETE_PROJECT_SETTING_KEYS], ['projectData', 'projectSyncData']);
});

test('PROJECT-OBSOLETE-SETTINGS-001 clears a present value at global scope', () => {
    const values = { projectData: [{ groupName: 'REDDEV' }], projectSyncData: {} };
    const bench = source(values);
    const cleared = clearObsolete(bench.acquire);

    assert.deepEqual(cleared, ['projectData', 'projectSyncData']);
    assert.deepEqual(bench.writes, [
        ['projectData', undefined, 'global'],
        ['projectSyncData', undefined, 'global'],
    ]);
});

test('PROJECT-OBSOLETE-SETTINGS-001 writes nothing when the keys are already absent', () => {
    const bench = source({});
    assert.deepEqual(clearObsolete(bench.acquire), []);
    // Running on every activation must not churn the user's settings file.
    assert.deepEqual(bench.writes, []);
});

test('PROJECT-OBSOLETE-SETTINGS-001 survives a rejected write', () => {
    const log = [];
    const bench = source(
        { projectData: [1], projectSyncData: {} },
        { failOn: 'projectData' },
    );
    const cleared = clearObsolete(bench.acquire, log);

    // A denied write must not abort startup or block the remaining key.
    assert.deepEqual(cleared, ['projectSyncData']);
    assert.deepEqual(log, ['projectData:denied']);
});
