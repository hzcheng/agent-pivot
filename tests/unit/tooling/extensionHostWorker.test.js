'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    main,
    runExtensionHostWorker,
} = require('../../../scripts/run-extension-host-worker');
const {
    EXTENSION_HOST_WORKER_COMPLETED_MESSAGE,
} = require('../../../scripts/lib/extensionHostLauncher');

// RELEASE-SCHEDULED-EXTENSION-HOST-001
test('RELEASE-SCHEDULED-EXTENSION-HOST-001 installs verified VSIX bytes before Host activation', async () => {
    const calls = [];
    const logs = [];
    const environment = {
        workspace: '/isolated/workspace',
        testHarness: '/isolated/test-harness',
    };
    const installedRoots = {
        'hzcheng.agent-pivot': '/isolated/extensions/main',
        'hzcheng.agent-pivot-attention-ui-bridge': '/isolated/extensions/bridge',
    };
    await runExtensionHostWorker('/repository', environment, {
        version: '9.8.7',
        downloadAndUnzipVSCode: async options => {
            calls.push(['download', options]);
            return '/downloaded/code';
        },
        installPackagedExtensions: (...args) => {
            calls.push(['install', ...args]);
            return {
                evidence: [{
                    extensionId: 'hzcheng.agent-pivot',
                    file: 'dist/dashboard.js',
                    sha256: 'verified-sha',
                }],
                installedRoots,
            };
        },
        createExtensionHostTestHarness: (...args) => {
            calls.push(['harness', ...args]);
            return {
                root: environment.testHarness,
                runnerPath: `${environment.testHarness}/index.js`,
            };
        },
        createRunTestsOptions: (...args) => {
            calls.push(['options', ...args]);
            return { vscodeExecutablePath: '/downloaded/code' };
        },
        runTests: async options => {
            calls.push(['run', options]);
        },
        logger: { log: message => logs.push(message) },
    });

    assert.deepEqual(calls.map(([kind]) => kind), [
        'download',
        'install',
        'harness',
        'options',
        'run',
    ]);
    assert.deepEqual(calls[0][1], {
        version: '9.8.7',
        extensionDevelopmentPath: '/repository',
    });
    assert.deepEqual(calls[1].slice(1), [
        '/repository',
        environment,
        '/downloaded/code',
    ]);
    assert.deepEqual(calls[2].slice(1), [
        '/repository',
        environment.testHarness,
    ]);
    assert.deepEqual(calls[3].slice(1), [
        '/repository',
        environment,
        '/downloaded/code',
        installedRoots,
        {
            root: environment.testHarness,
            runnerPath: `${environment.testHarness}/index.js`,
        },
    ]);
    assert.match(logs.join('\n'), /Verified installed .* verified-sha/);
    assert.match(logs.join('\n'), /Running installed Extension Host smoke/);
});

// RELEASE-SCHEDULED-EXTENSION-HOST-001
test('RELEASE-SCHEDULED-EXTENSION-HOST-001 worker rejects malformed isolation input before download', async () => {
    await assert.rejects(
        main(['/repository', 'null'], {
            downloadAndUnzipVSCode: async () => {
                throw new Error('must not download');
            },
        }),
        /requires repository and isolation paths/
    );
    await assert.rejects(
        main(['/repository', '{not-json']),
        /JSON/
    );
});

// RELEASE-EXTENSION-HOST-WORKER-COMPLETION-001
test('RELEASE-EXTENSION-HOST-WORKER-COMPLETION-001 worker reports completion only after tests succeed', async () => {
    const calls = [];
    const environment = { workspace: '/isolated/workspace' };
    const successfulOptions = {
        downloadAndUnzipVSCode: async () => '/downloaded/code',
        installPackagedExtensions: () => ({ evidence: [], installedRoots: {} }),
        createExtensionHostTestHarness: () => ({ runnerPath: '/harness/index.js' }),
        createRunTestsOptions: () => ({}),
        runTests: async () => { calls.push('run-tests'); },
        notifyCompletion: async message => { calls.push(['notify', message]); },
        logger: { log: () => {} },
    };

    await main(['/repository', JSON.stringify(environment)], successfulOptions);
    assert.deepEqual(calls, [
        'run-tests',
        ['notify', EXTENSION_HOST_WORKER_COMPLETED_MESSAGE],
    ]);

    await assert.rejects(
        main(['/repository', JSON.stringify(environment)], {
            ...successfulOptions,
            runTests: async () => { throw new Error('real test failure'); },
        }),
        /real test failure/
    );
    assert.equal(
        calls.filter(call => Array.isArray(call) && call[0] === 'notify').length,
        1,
        'a failed test run must not report completion'
    );
});
