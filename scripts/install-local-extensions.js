'use strict';

const childProcess = require('child_process');
const path = require('path');
const {
    createExtensionPackagePlan,
    resolveInstalledExtensionRoots,
    verifyInstalledExtensionBytes,
} = require('./lib/extensionHostLauncher');
const { resolveVSCodeCliTarget } = require('./lib/vscodeCliTarget');

/**
 * Arguments for installing one packaged extension into a live host.
 *
 * The artifact path is absolute because a relative one is resolved by the VS
 * Code Server against its own working directory rather than the shell's, which
 * made the previous script fail with ENOENT under a remote host. The extensions
 * directory is pinned whenever it is known, so that installing and any later
 * listing cannot disagree about where the bytes went. Unlike the Extension Host
 * test harness this must not override the user data directory: it is installing
 * into the host the user is actually running.
 */
function buildInstallArgs(artifactPath, extensionsDir) {
    return [
        ...(extensionsDir ? [`--extensions-dir=${extensionsDir}`] : []),
        '--install-extension',
        path.resolve(artifactPath),
        '--force',
    ];
}

function main(options = {}) {
    const repositoryRoot = options.repositoryRoot || path.resolve(__dirname, '..');
    const spawnSync = options.spawnSync || childProcess.spawnSync;
    const logger = options.logger || console;
    const target = options.target || resolveVSCodeCliTarget();

    if (!target.command) {
        logger.error(`error: ${target.error}`);
        return 1;
    }

    const packagePlan = createExtensionPackagePlan(repositoryRoot);
    logger.log(`==> installing with ${target.command} (${target.source})`);
    if (target.extensionsDir) {
        logger.log(`    extensions dir: ${target.extensionsDir}`);
    }

    for (const extensionPackage of packagePlan) {
        const args = buildInstallArgs(extensionPackage.artifactPath, target.extensionsDir);
        const result = spawnSync(target.command, args, {
            encoding: 'utf8',
            // A stale hook must not reach the CLI we deliberately chose.
            env: withoutIpcHook(process.env),
            stdio: 'inherit',
            windowsHide: true,
        });
        if (result.error || result.status !== 0) {
            logger.error(
                `error: failed to install ${extensionPackage.id}: `
                + `${result.error ? result.error.message : `status ${result.status}`}`
            );
            return 1;
        }
    }

    if (!target.extensionsDir) {
        logger.log(
            'Installed, but the extensions directory is unknown for this host, '
            + 'so installed bytes were not verified.'
        );
        return 0;
    }

    let evidence;
    try {
        evidence = verifyInstalledExtensionBytes(
            packagePlan,
            resolveInstalledExtensionRoots(packagePlan, target.extensionsDir)
        );
    } catch (error) {
        logger.error(`error: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
    }
    for (const item of evidence) {
        logger.log(`    ${item.extensionId} ${item.file} ${item.sha256.slice(0, 16)}…`);
    }
    logger.log(`Installed ${packagePlan.length} extensions and verified their bytes.`);
    return 0;
}

function withoutIpcHook(environment) {
    const copy = { ...environment };
    delete copy.VSCODE_IPC_HOOK_CLI;
    return copy;
}

if (require.main === module) {
    try {
        process.exitCode = main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

module.exports = { buildInstallArgs, main, withoutIpcHook };
