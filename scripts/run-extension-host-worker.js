'use strict';

const {
    downloadAndUnzipVSCode,
    runTests,
} = require('@vscode/test-electron');
const {
    EXTENSION_HOST_WORKER_COMPLETED_MESSAGE,
    VSCODE_STABLE_VERSION,
    createExtensionHostTestHarness,
    createRunTestsOptions,
    installPackagedExtensions,
} = require('./lib/extensionHostLauncher');

const VSCODE_DOWNLOAD_TIMEOUT_MS = 60_000;
const VSCODE_DOWNLOAD_ATTEMPTS = 2;

function isRetriableVSCodeDownloadError(error) {
    if (!error) return false;
    const retriableCodes = new Set([
        'ECONNABORTED',
        'ECONNRESET',
        'ECONNREFUSED',
        'EAI_AGAIN',
        'ENETUNREACH',
        'ETIMEDOUT',
    ]);
    if (retriableCodes.has(error.code)) return true;
    if (Array.isArray(error.errors)
        && error.errors.some(isRetriableVSCodeDownloadError)) return true;
    return /@vscode\/test-electron request timeout/.test(String(error.message || error));
}

async function downloadVSCodeWithRetry(download, options, logger) {
    for (let attempt = 1; attempt <= VSCODE_DOWNLOAD_ATTEMPTS; attempt += 1) {
        try {
            return await download({
                ...options,
                timeout: VSCODE_DOWNLOAD_TIMEOUT_MS,
            });
        } catch (error) {
            if (!isRetriableVSCodeDownloadError(error)
                || attempt === VSCODE_DOWNLOAD_ATTEMPTS) {
                throw error;
            }
            logger.log(
                `VS Code download attempt ${attempt} failed with a transient network error; retrying.`
            );
        }
    }
    throw new Error('VS Code download retry loop exited unexpectedly.');
}

function notifyParentOfCompletion(message) {
    if (typeof process.send !== 'function') return Promise.resolve();
    return new Promise((resolve, reject) => {
        try {
            process.send(message, error => error ? reject(error) : resolve());
        } catch (error) {
            reject(error);
        }
    });
}

async function runExtensionHostWorker(repositoryRoot, environment, options = {}) {
    if (!repositoryRoot || !environment || typeof environment.workspace !== 'string') {
        throw new Error('Extension Host worker requires repository and isolation paths.');
    }
    const version = options.version || VSCODE_STABLE_VERSION;
    const download = options.downloadAndUnzipVSCode || downloadAndUnzipVSCode;
    const install = options.installPackagedExtensions || installPackagedExtensions;
    const createOptions = options.createRunTestsOptions || createRunTestsOptions;
    const createHarness = options.createExtensionHostTestHarness
        || createExtensionHostTestHarness;
    const executeTests = options.runTests || runTests;
    const logger = options.logger || console;
    logger.log(
        `Installing release VSIX files into isolated VS Code ${version}.`
    );
    const vscodeExecutablePath = await downloadVSCodeWithRetry(download, {
        version,
        extensionDevelopmentPath: repositoryRoot,
    }, logger);
    const installation = install(
        repositoryRoot,
        environment,
        vscodeExecutablePath
    );
    for (const item of installation.evidence) {
        logger.log(
            `Verified installed ${item.extensionId} ${item.file} ${item.sha256}`
        );
    }
    const testHarness = createHarness(repositoryRoot, environment.testHarness);
    logger.log(
        `Running installed Extension Host smoke with VS Code ${version}.`
    );
    await executeTests(createOptions(
        repositoryRoot,
        environment,
        vscodeExecutablePath,
        installation.installedRoots,
        testHarness
    ));
}

async function main(argv = process.argv.slice(2), options = {}) {
    const [repositoryRoot, serializedEnvironment] = argv;
    const environment = JSON.parse(serializedEnvironment || 'null');
    await runExtensionHostWorker(repositoryRoot, environment, options);
    const notifyCompletion = options.notifyCompletion || notifyParentOfCompletion;
    await notifyCompletion(EXTENSION_HOST_WORKER_COMPLETED_MESSAGE);
}

if (require.main === module) {
    main().catch(error => {
        console.error(`Extension Host worker failed: ${error && error.stack ? error.stack : error}`);
        process.exitCode = 1;
    });
}

module.exports = {
    VSCODE_DOWNLOAD_ATTEMPTS,
    VSCODE_DOWNLOAD_TIMEOUT_MS,
    downloadVSCodeWithRetry,
    isRetriableVSCodeDownloadError,
    main,
    runExtensionHostWorker,
};
