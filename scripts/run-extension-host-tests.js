'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const {
    EXTENSION_HOST_WORKER_TIMEOUT_MS,
    createExtensionHostTestEnvironment,
    extensionHostTemporaryRootPrefix,
    removeExtensionHostTestEnvironment,
    runWorkerWithWatchdog,
    withSanitizedExtensionHostEnvironment,
} = require('./lib/extensionHostLauncher');

async function main(options = {}) {
    const repositoryRoot = options.repositoryRoot || path.resolve(__dirname, '..');
    const isolatedRoot = (options.mkdtempSync || fs.mkdtempSync)(
        extensionHostTemporaryRootPrefix(
            options.platform || process.platform,
            options.tempDirectory || os.tmpdir()
        )
    );
    const createEnvironment = options.createExtensionHostTestEnvironment
        || createExtensionHostTestEnvironment;
    const sanitize = options.withSanitizedExtensionHostEnvironment
        || withSanitizedExtensionHostEnvironment;
    const runWorker = options.runWorkerWithWatchdog || runWorkerWithWatchdog;
    const spawn = options.spawn || childProcess.spawn;
    const removeEnvironment = options.removeExtensionHostTestEnvironment
        || removeExtensionHostTestEnvironment;
    try {
        const environment = createEnvironment(isolatedRoot);
        const workerPath = path.join(__dirname, 'run-extension-host-worker.js');
        await sanitize(() => runWorker(
            () => spawn(process.execPath, [
                workerPath,
                repositoryRoot,
                JSON.stringify(environment),
            ], {
                detached: process.platform !== 'win32',
                env: { ...process.env },
                stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
            }),
            { timeoutMs: EXTENSION_HOST_WORKER_TIMEOUT_MS }
        ));
    } finally {
        removeEnvironment(isolatedRoot);
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(`Extension Host smoke failed: ${error && error.stack ? error.stack : error}`);
        process.exitCode = 1;
    });
}

module.exports = { main };
