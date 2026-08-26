'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    EXPECTED_SHARDS,
    collectShardFailures,
    main,
} = require('../../../scripts/check-ci-shard-results');

function createLogger() {
    const lines = [];
    return {
        lines,
        log: line => lines.push({ level: 'log', line }),
        error: line => lines.push({ level: 'error', line }),
    };
}

function successfulNeeds() {
    return Object.fromEntries(EXPECTED_SHARDS.map(shard => [shard, { result: 'success' }]));
}

test('CI-LINUX-SHARD-AGGREGATE-001 collectShardFailures accepts all-success shards', () => {
    assert.deepEqual(collectShardFailures(successfulNeeds()), []);
});

test('CI-LINUX-SHARD-AGGREGATE-001 collectShardFailures reports every non-success shard', () => {
    assert.deepEqual(collectShardFailures({
        ...successfulNeeds(),
        'linux-browser': { result: 'failure' },
        'linux-release': { result: 'cancelled' },
    }), [
        { shard: 'linux-browser', result: 'failure' },
        { shard: 'linux-release', result: 'cancelled' },
    ]);
});

test('CI-LINUX-SHARD-AGGREGATE-001 collectShardFailures treats skipped and missing shards as failures', () => {
    const needs = successfulNeeds();
    delete needs['linux-safety'];
    needs['linux-core'] = { result: 'skipped' };
    needs['linux-release'] = {};
    assert.deepEqual(collectShardFailures(needs), [
        { shard: 'linux-core', result: 'skipped' },
        { shard: 'linux-safety', result: 'missing' },
        { shard: 'linux-release', result: 'missing' },
    ]);
});

test('CI-LINUX-SHARD-AGGREGATE-001 collectShardFailures rejects a non-object needs payload', () => {
    for (const needs of [null, 'success', [1, 2]]) {
        assert.throws(() => collectShardFailures(needs), /needs results must be an object/);
    }
});

test('CI-LINUX-SHARD-AGGREGATE-001 main succeeds and logs each shard when all shards pass', () => {
    const logger = createLogger();
    const exitCode = main({ NEEDS_JSON: JSON.stringify(successfulNeeds()) }, logger);
    assert.equal(exitCode, 0);
    for (const shard of EXPECTED_SHARDS) {
        assert.ok(logger.lines.some(entry => entry.line === `${shard}: success`),
            `main must log the ${shard} result`);
    }
    assert.ok(logger.lines.some(entry => entry.line === 'All quality-linux shards succeeded.'));
});

test('CI-LINUX-SHARD-AGGREGATE-001 main fails and names the failing shards', () => {
    const logger = createLogger();
    const exitCode = main({
        NEEDS_JSON: JSON.stringify({ ...successfulNeeds(), 'linux-core': { result: 'failure' } }),
    }, logger);
    assert.equal(exitCode, 1);
    assert.ok(logger.lines.some(entry => entry.level === 'error'
        && entry.line.includes('linux-core=failure')));
});

test('CI-LINUX-SHARD-AGGREGATE-001 main fails when NEEDS_JSON is absent or invalid', () => {
    for (const environment of [{}, { NEEDS_JSON: 'not-json' }]) {
        const logger = createLogger();
        assert.equal(main(environment, logger), 1);
        assert.ok(logger.lines.some(entry => entry.level === 'error'
            && entry.line.includes('NEEDS_JSON must be valid JSON')));
    }
});

test('CI-LINUX-SHARD-AGGREGATE-001 main fails when the parsed payload is not an object', () => {
    const logger = createLogger();
    assert.equal(main({ NEEDS_JSON: '[1, 2]' }, logger), 1);
    assert.ok(logger.lines.some(entry => entry.level === 'error'
        && entry.line === 'needs results must be an object'));
});
