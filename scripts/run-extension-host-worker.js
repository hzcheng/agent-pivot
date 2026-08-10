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
    const vscodeExecutablePath = await download({
        version,
        extensionDevelopmentPath: repositoryRoot,
    });
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
    main,
    runExtensionHostWorker,
};
