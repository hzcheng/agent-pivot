'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { main } = require('../../../scripts/run-extension-host-tests');

// RELEASE-SCHEDULED-EXTENSION-HOST-001
test('RELEASE-SCHEDULED-EXTENSION-HOST-001 runner uses the short macOS root and always cleans it', async () => {
    const calls = [];
    const isolatedRoot = '/tmp/ap-eh-fixture';
    const environment = { workspace: `${isolatedRoot}/workspace` };
    await main({
        repositoryRoot: '/repository',
        platform: 'darwin',
        tempDirectory: '/var/folders/long/random/T',
        mkdtempSync: prefix => {
            calls.push(['mkdtemp', prefix]);
            return isolatedRoot;
        },
        createExtensionHostTestEnvironment: root => {
            calls.push(['environment', root]);
            return environment;
        },
        withSanitizedExtensionHostEnvironment: async callback => {
            calls.push(['sanitize']);
            return callback();
        },
        runWorkerWithWatchdog: async (spawnWorker, options) => {
            calls.push(['watchdog', options]);
            spawnWorker();
        },
        spawn: (command, args, options) => {
            calls.push(['spawn', command, args, options]);
            return {};
        },
        removeExtensionHostTestEnvironment: root => {
            calls.push(['remove', root]);
        },
    });

    assert.deepEqual(calls.map(([kind]) => kind), [
        'mkdtemp',
        'environment',
        'sanitize',
        'watchdog',
        'spawn',
        'remove',
    ]);
    assert.equal(calls[0][1], '/tmp/ap-eh-');
    assert.equal(calls[4][1], process.execPath);
    assert.deepEqual(calls[4][2], [
        path.resolve(__dirname, '../../../scripts/run-extension-host-worker.js'),
        '/repository',
        JSON.stringify(environment),
    ]);
    assert.equal(calls[4][3].detached, process.platform !== 'win32');
    assert.equal(calls[5][1], isolatedRoot);
});
