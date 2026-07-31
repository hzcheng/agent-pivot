'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const {
    resolveCliArgsFromVSCodeExecutablePath,
} = require('@vscode/test-electron');

const VSCODE_STABLE_VERSION = '1.130.0';
const EXTENSION_HOST_TIMEOUT_MS = 120000;
const EXTENSION_HOST_WORKER_TIMEOUT_MS = 480000;
const HOSTILE_EXTENSION_HOST_ENVIRONMENT_KEYS = Object.freeze([
    'ELECTRON_RUN_AS_NODE',
    'VSCODE_ESM_ENTRYPOINT',
    'VSCODE_CWD',
    'VSCODE_NLS_CONFIG',
    'VSCODE_IPC_HOOK_CLI',
]);
const OWNERSHIP_MARKER = '.agent-pivot-extension-host-test';
const OWNERSHIP_VALUE = 'owned temporary extension host test directory\n';
const MAIN_EXTENSION_ID = 'hzcheng.agent-pivot';
const BRIDGE_EXTENSION_ID = 'hzcheng.agent-pivot-attention-ui-bridge';

function extensionHostTemporaryRootPrefix(
    platform = process.platform,
    tempDirectory = os.tmpdir()
) {
    const parent = platform === 'darwin' ? '/tmp' : tempDirectory;
    return path.join(parent, 'ap-eh-');
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function extensionId(manifest) {
    return `${manifest.publisher}.${manifest.name}`;
}

function createExtensionPackagePlan(repositoryRoot) {
    const definitions = [
        {
            expectedId: BRIDGE_EXTENSION_ID,
            packageRoot: path.join(repositoryRoot, 'extensions', 'attention-ui-bridge'),
            runtimeFiles: ['dist/extension.js'],
        },
        {
            expectedId: MAIN_EXTENSION_ID,
            packageRoot: repositoryRoot,
            runtimeFiles: [
                'dist/dashboard.js',
                'media/conversationViewerScripts.js',
                'media/conversationMermaidScripts.js',
            ],
        },
    ];
    return definitions.map(definition => {
        const manifestPath = path.join(definition.packageRoot, 'package.json');
        const manifest = readJson(manifestPath);
        const id = extensionId(manifest);
        if (id !== definition.expectedId) {
            throw new Error(
                `Extension Host package identity ${id} must equal ${definition.expectedId}`
            );
        }
        return {
            artifactPath: path.join(
                repositoryRoot,
                'artifacts',
                `${manifest.name}-${manifest.version}.vsix`
            ),
            id,
            manifest,
            manifestPath,
            packageRoot: definition.packageRoot,
            runtimeFiles: definition.runtimeFiles,
            version: manifest.version,
        };
    });
}

function normalizedManifest(manifest) {
    const normalized = JSON.parse(JSON.stringify(manifest));
    delete normalized.__metadata;
    return normalized;
}

function canonicalJson(value) {
    if (Array.isArray(value)) {
        return value.map(canonicalJson);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value).sort().map(key => [key, canonicalJson(value[key])])
        );
    }
    return value;
}

function serializedManifest(manifest) {
    return JSON.stringify(canonicalJson(normalizedManifest(manifest)));
}

function fileSha256(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function resolveInstalledExtensionRoots(packagePlan, extensionsDirectory) {
    const roots = {};
    const entries = fs.readdirSync(extensionsDirectory, { withFileTypes: true });
    for (const extensionPackage of packagePlan) {
        const matches = [];
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const candidate = path.join(extensionsDirectory, entry.name);
            const manifestPath = path.join(candidate, 'package.json');
            if (!fs.existsSync(manifestPath)) continue;
            let manifest;
            try {
                manifest = readJson(manifestPath);
            } catch (_error) {
                continue;
            }
            if (extensionId(manifest) === extensionPackage.id
                && manifest.version === extensionPackage.version) {
                matches.push(candidate);
            }
        }
        if (matches.length !== 1) {
            throw new Error(
                `Installed extension ${extensionPackage.id}@${extensionPackage.version} `
                + `must resolve exactly once, found ${matches.length}`
            );
        }
        roots[extensionPackage.id] = matches[0];
    }
    return roots;
}

function verifyInstalledExtensionBytes(packagePlan, installedRoots) {
    const evidence = [];
    for (const extensionPackage of packagePlan) {
        const installedRoot = installedRoots[extensionPackage.id];
        if (!installedRoot) {
            throw new Error(`Missing installed root for ${extensionPackage.id}`);
        }
        const installedManifestPath = path.join(installedRoot, 'package.json');
        const installedManifest = readJson(installedManifestPath);
        if (serializedManifest(installedManifest)
            !== serializedManifest(extensionPackage.manifest)) {
            throw new Error(
                `Installed manifest for ${extensionPackage.id} differs from its VSIX source`
            );
        }
        evidence.push({
            extensionId: extensionPackage.id,
            file: 'package.json',
            sha256: crypto.createHash('sha256')
                .update(serializedManifest(installedManifest))
                .digest('hex'),
        });
        for (const relativePath of extensionPackage.runtimeFiles) {
            const sourcePath = path.join(extensionPackage.packageRoot, relativePath);
            const installedPath = path.join(installedRoot, relativePath);
            const sourceHash = fileSha256(sourcePath);
            const installedHash = fileSha256(installedPath);
            if (sourceHash !== installedHash) {
                throw new Error(
                    `Installed ${extensionPackage.id} ${relativePath} differs from built bytes`
                );
            }
            evidence.push({
                extensionId: extensionPackage.id,
                file: relativePath,
                sha256: installedHash,
            });
        }
    }
    return evidence;
}

function installPackagedExtensions(
    repositoryRoot,
    environment,
    vscodeExecutablePath,
    options = {}
) {
    const packagePlan = createExtensionPackagePlan(repositoryRoot);
    const spawnSync = options.spawnSync || childProcess.spawnSync;
    const resolveCliArgs = options.resolveCliArgs
        || resolveCliArgsFromVSCodeExecutablePath;
    const [cli, ...cliPrefixArgs] = resolveCliArgs(vscodeExecutablePath, {
        reuseMachineInstall: true,
    });
    for (const extensionPackage of packagePlan) {
        if (!fs.statSync(extensionPackage.artifactPath).isFile()) {
            throw new Error(`Missing packaged extension ${extensionPackage.artifactPath}`);
        }
        const args = [
            ...cliPrefixArgs,
            `--extensions-dir=${environment.extensions}`,
            `--user-data-dir=${environment.userData}`,
            '--install-extension',
            extensionPackage.artifactPath,
            '--force',
        ];
        const result = spawnSync(cli, args, {
            encoding: 'utf8',
            env: { ...process.env },
            shell: process.platform === 'win32',
            stdio: options.stdio || 'inherit',
            windowsHide: true,
        });
        if (result.error || result.status !== 0) {
            throw result.error || new Error(
                `VS Code CLI failed to install ${extensionPackage.id} with status ${result.status}`
            );
        }
    }
    const installedRoots = resolveInstalledExtensionRoots(
        packagePlan,
        environment.extensions
    );
    return {
        evidence: verifyInstalledExtensionBytes(packagePlan, installedRoots),
        installedRoots,
    };
}

function createExtensionHostTestEnvironment(isolatedRoot) {
    if (!path.isAbsolute(isolatedRoot)) {
        throw new Error('Extension Host isolation root must be absolute.');
    }
    fs.mkdirSync(isolatedRoot, { recursive: true });
    fs.writeFileSync(path.join(isolatedRoot, OWNERSHIP_MARKER), OWNERSHIP_VALUE, { flag: 'wx' });
    const environment = {
        workspace: path.join(isolatedRoot, 'workspace'),
        userData: path.join(isolatedRoot, 'user-data'),
        extensions: path.join(isolatedRoot, 'extensions'),
        home: path.join(isolatedRoot, 'home'),
        xdgConfigHome: path.join(isolatedRoot, 'xdg', 'config'),
        xdgDataHome: path.join(isolatedRoot, 'xdg', 'data'),
        xdgCacheHome: path.join(isolatedRoot, 'xdg', 'cache'),
        codexHome: path.join(isolatedRoot, 'providers', 'codex'),
        kimiHome: path.join(isolatedRoot, 'providers', 'kimi'),
        claudeHome: path.join(isolatedRoot, 'providers', 'claude'),
    };
    for (const directory of Object.values(environment)) {
        fs.mkdirSync(directory, { recursive: true });
    }
    return environment;
}

function createRunTestsOptions(
    repositoryRoot,
    environment,
    vscodeExecutablePath,
    installedRoots
) {
    const mainExtensionRoot = installedRoots && installedRoots[MAIN_EXTENSION_ID];
    const bridgeExtensionRoot = installedRoots && installedRoots[BRIDGE_EXTENSION_ID];
    if (!path.isAbsolute(vscodeExecutablePath || '')
        || !path.isAbsolute(mainExtensionRoot || '')
        || !path.isAbsolute(bridgeExtensionRoot || '')) {
        throw new Error('Extension Host test requires absolute installed extension paths.');
    }
    return {
        vscodeExecutablePath,
        extensionDevelopmentPath: [
            mainExtensionRoot,
            bridgeExtensionRoot,
        ],
        extensionTestsPath: path.join(repositoryRoot, 'tests', 'extension-host', 'suite', 'index.js'),
        launchArgs: [
            environment.workspace,
            `--user-data-dir=${environment.userData}`,
            `--extensions-dir=${environment.extensions}`,
        ],
        extensionTestsEnv: {
            HOME: environment.home,
            XDG_CONFIG_HOME: environment.xdgConfigHome,
            XDG_DATA_HOME: environment.xdgDataHome,
            XDG_CACHE_HOME: environment.xdgCacheHome,
            CODEX_HOME: environment.codexHome,
            KIMI_SHARE_DIR: environment.kimiHome,
            CLAUDE_HOME: environment.claudeHome,
            AGENT_PIVOT_EXPECTED_MAIN_EXTENSION_PATH: mainExtensionRoot,
            AGENT_PIVOT_EXPECTED_BRIDGE_EXTENSION_PATH: bridgeExtensionRoot,
            AGENT_PIVOT_EXTENSION_HOST_TIMEOUT_MS: String(EXTENSION_HOST_TIMEOUT_MS),
        },
    };
}

async function withSanitizedExtensionHostEnvironment(callback) {
    const previous = new Map(HOSTILE_EXTENSION_HOST_ENVIRONMENT_KEYS.map(key => [key, {
        existed: Object.prototype.hasOwnProperty.call(process.env, key),
        value: process.env[key],
    }]));
    for (const key of HOSTILE_EXTENSION_HOST_ENVIRONMENT_KEYS) delete process.env[key];
    try {
        return await callback();
    } finally {
        for (const [key, state] of previous) {
            if (state.existed) process.env[key] = state.value;
            else delete process.env[key];
        }
    }
}

function runWorkerWithWatchdog(spawnWorker, options = {}) {
    const timeoutMs = options.timeoutMs || EXTENSION_HOST_WORKER_TIMEOUT_MS;
    const platform = options.platform || process.platform;
    const killProcess = options.killProcess || process.kill.bind(process);
    const setTimeoutFn = options.setTimeout || setTimeout;
    const clearTimeoutFn = options.clearTimeout || clearTimeout;
    return new Promise((resolve, reject) => {
        let child;
        let timedOut = false;
        let forceTimer;
        let timeoutTimer;
        let settled = false;
        const timeoutError = () => new Error(
            `Extension Host worker exceeded ${timeoutMs} ms and was terminated`
        );
        const isMissingProcessGroup = error => error && error.code === 'ESRCH';
        const clearTimers = () => {
            if (timeoutTimer !== undefined) clearTimeoutFn(timeoutTimer);
            if (forceTimer !== undefined) clearTimeoutFn(forceTimer);
        };
        const finish = error => {
            if (settled) return;
            settled = true;
            clearTimers();
            if (child) {
                child.removeListener('error', onError);
                child.removeListener('close', onClose);
            }
            error ? reject(error) : resolve();
        };
        const terminate = signal => {
            if (!child || !child.pid) return;
            if (platform === 'darwin' || platform === 'linux') killProcess(-child.pid, signal);
            else child.kill(signal);
        };
        const onError = error => {
            if (!timedOut) finish(error);
        };
        const onClose = (code, signal) => {
            if (timedOut) return;
            if (code === 0) finish();
            else finish(new Error(`Extension Host worker failed with code ${code === null ? signal : code}`));
        };
        try {
            child = spawnWorker();
        } catch (error) {
            finish(error);
            return;
        }
        child.once('error', onError);
        child.once('close', onClose);
        timeoutTimer = setTimeoutFn(() => {
            timedOut = true;
            try {
                terminate('SIGTERM');
                forceTimer = setTimeoutFn(() => {
                    try {
                        terminate('SIGKILL');
                        finish(timeoutError());
                    } catch (error) {
                        finish(isMissingProcessGroup(error) ? timeoutError() : error);
                    }
                }, 5000);
            } catch (error) {
                finish(isMissingProcessGroup(error) ? timeoutError() : error);
            }
        }, timeoutMs);
    });
}

function removeExtensionHostTestEnvironment(isolatedRoot) {
    const markerPath = path.join(isolatedRoot, OWNERSHIP_MARKER);
    if (!path.isAbsolute(isolatedRoot) || !fs.existsSync(markerPath)
        || fs.readFileSync(markerPath, 'utf8') !== OWNERSHIP_VALUE) {
        throw new Error('Refusing to remove an unowned Extension Host test directory.');
    }
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
}

module.exports = {
    EXTENSION_HOST_TIMEOUT_MS,
    EXTENSION_HOST_WORKER_TIMEOUT_MS,
    HOSTILE_EXTENSION_HOST_ENVIRONMENT_KEYS,
    BRIDGE_EXTENSION_ID,
    MAIN_EXTENSION_ID,
    VSCODE_STABLE_VERSION,
    createExtensionHostTestEnvironment,
    createExtensionPackagePlan,
    createRunTestsOptions,
    extensionHostTemporaryRootPrefix,
    installPackagedExtensions,
    removeExtensionHostTestEnvironment,
    runWorkerWithWatchdog,
    resolveInstalledExtensionRoots,
    verifyInstalledExtensionBytes,
    withSanitizedExtensionHostEnvironment,
};
