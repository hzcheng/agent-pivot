'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const {
    EXTENSION_HOST_TIMEOUT_MS,
    EXTENSION_HOST_WORKER_COMPLETED_MESSAGE,
    EXTENSION_HOST_WORKER_TIMEOUT_MS,
    HOSTILE_EXTENSION_HOST_ENVIRONMENT_KEYS,
    BRIDGE_EXTENSION_ID,
    MAIN_EXTENSION_ID,
    TEST_HARNESS_EXTENSION_ID,
    VSCODE_STABLE_VERSION,
    createExtensionHostTestEnvironment,
    createExtensionHostTestHarness,
    createExtensionPackagePlan,
    createRunTestsOptions,
    extensionHostTemporaryRootPrefix,
    installPackagedExtensions,
    removeExtensionHostTestEnvironment,
    runWorkerWithWatchdog,
    verifyInstalledExtensionBytes,
    withSanitizedExtensionHostEnvironment,
} = require('../../../scripts/lib/extensionHostLauncher');

test('RELEASE-SCHEDULED-EXTENSION-HOST-001 keeps macOS IPC paths below the Unix socket limit', () => {
    assert.equal(
        extensionHostTemporaryRootPrefix('darwin', '/var/folders/long/random/T'),
        '/tmp/ap-eh-'
    );
    assert.equal(
        extensionHostTemporaryRootPrefix('linux', '/custom/tmp'),
        '/custom/tmp/ap-eh-'
    );
});

function writeFile(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, value);
}

function createPackagedFixture(root) {
    const mainManifest = {
        name: 'agent-pivot',
        publisher: 'hzcheng',
        version: '9.9.9',
    };
    const bridgeManifest = {
        name: 'agent-pivot-attention-ui-bridge',
        publisher: 'hzcheng',
        version: '8.8.8',
        extensionKind: ['ui'],
    };
    writeFile(path.join(root, 'package.json'), JSON.stringify(mainManifest));
    writeFile(
        path.join(root, 'extensions/attention-ui-bridge/package.json'),
        JSON.stringify(bridgeManifest)
    );
    const sourceFiles = [
        ['dist/dashboard.js', 'main-runtime'],
        ['media/conversationViewerScripts.js', 'viewer-runtime'],
        ['media/conversationMermaidScripts.js', 'mermaid-runtime'],
        ['extensions/attention-ui-bridge/dist/extension.js', 'bridge-runtime'],
    ];
    for (const [relativePath, bytes] of sourceFiles) {
        writeFile(path.join(root, relativePath), bytes);
    }
    writeFile(path.join(root, 'artifacts/agent-pivot-9.9.9.vsix'), 'main-vsix');
    writeFile(
        path.join(root, 'artifacts/agent-pivot-attention-ui-bridge-8.8.8.vsix'),
        'bridge-vsix'
    );
    return { bridgeManifest, mainManifest, sourceFiles };
}

function createInstalledFixture(root, extensionsDirectory, fixture) {
    const roots = {
        [MAIN_EXTENSION_ID]: path.join(extensionsDirectory, 'main-installed'),
        [BRIDGE_EXTENSION_ID]: path.join(extensionsDirectory, 'bridge-installed'),
    };
    writeFile(
        path.join(roots[MAIN_EXTENSION_ID], 'package.json'),
        JSON.stringify({
            __metadata: { installed: true },
            version: fixture.mainManifest.version,
            publisher: fixture.mainManifest.publisher,
            name: fixture.mainManifest.name,
        })
    );
    writeFile(
        path.join(roots[BRIDGE_EXTENSION_ID], 'package.json'),
        JSON.stringify({ ...fixture.bridgeManifest, __metadata: { installed: true } })
    );
    for (const [relativePath, bytes] of fixture.sourceFiles) {
        const isBridge = relativePath.startsWith('extensions/attention-ui-bridge/');
        const installedRelativePath = isBridge
            ? relativePath.slice('extensions/attention-ui-bridge/'.length)
            : relativePath;
        writeFile(
            path.join(
                roots[isBridge ? BRIDGE_EXTENSION_ID : MAIN_EXTENSION_ID],
                installedRelativePath
            ),
            bytes
        );
    }
    return roots;
}

// RELEASE-SCHEDULED-EXTENSION-HOST-001
test('RELEASE-SCHEDULED-EXTENSION-HOST-001 launches both extensions with pinned stable VS Code', () => {
    const repositoryRoot = path.resolve(__dirname, '../../..');
    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-launcher-test-'));
    try {
        const environment = createExtensionHostTestEnvironment(isolatedRoot);
        const vscodeExecutablePath = path.join(isolatedRoot, 'VS Code');
        const installedRoots = {
            [MAIN_EXTENSION_ID]: path.join(environment.extensions, 'main'),
            [BRIDGE_EXTENSION_ID]: path.join(environment.extensions, 'bridge'),
        };
        const testHarness = createExtensionHostTestHarness(
            repositoryRoot,
            environment.testHarness
        );
        const options = createRunTestsOptions(
            repositoryRoot,
            environment,
            vscodeExecutablePath,
            installedRoots,
            testHarness
        );
        const packagePlan = createExtensionPackagePlan(repositoryRoot);

        assert.equal(VSCODE_STABLE_VERSION, '1.130.0');
        assert.equal(EXTENSION_HOST_TIMEOUT_MS, 120000);
        assert.equal(options.vscodeExecutablePath, vscodeExecutablePath);
        assert.deepEqual(options.extensionDevelopmentPath, [
            installedRoots[MAIN_EXTENSION_ID],
            installedRoots[BRIDGE_EXTENSION_ID],
            environment.testHarness,
        ]);
        assert.deepEqual(packagePlan.map(item => item.id), [
            BRIDGE_EXTENSION_ID,
            MAIN_EXTENSION_ID,
        ]);
        assert.deepEqual(packagePlan.map(item => path.basename(item.artifactPath)), [
            'agent-pivot-attention-ui-bridge-1.0.1.vsix',
            'agent-pivot-1.1.0.vsix',
        ]);
        assert.equal(options.extensionTestsPath,
            path.join(environment.testHarness, 'index.js'));
        assert.deepEqual(options.launchArgs, [
            environment.workspace,
            `--user-data-dir=${environment.userData}`,
            `--extensions-dir=${environment.extensions}`,
            '--use-inmemory-secretstorage',
        ]);
        assert.equal(options.extensionTestsEnv.HOME, environment.home);
        assert.equal(options.extensionTestsEnv.XDG_CONFIG_HOME, path.join(isolatedRoot, 'xdg', 'config'));
        assert.equal(options.extensionTestsEnv.XDG_DATA_HOME, path.join(isolatedRoot, 'xdg', 'data'));
        assert.equal(options.extensionTestsEnv.XDG_CACHE_HOME, path.join(isolatedRoot, 'xdg', 'cache'));
        assert.equal(options.extensionTestsEnv.CODEX_HOME, environment.codexHome);
        assert.equal(options.extensionTestsEnv.KIMI_SHARE_DIR, environment.kimiHome);
        assert.equal(options.extensionTestsEnv.CLAUDE_HOME, environment.claudeHome);
        assert.equal(
            options.extensionTestsEnv.AGENT_PIVOT_EXPECTED_MAIN_EXTENSION_PATH,
            installedRoots[MAIN_EXTENSION_ID]
        );
        assert.equal(
            options.extensionTestsEnv.AGENT_PIVOT_EXPECTED_BRIDGE_EXTENSION_PATH,
            installedRoots[BRIDGE_EXTENSION_ID]
        );
        assert.equal(options.extensionTestsEnv.AGENT_PIVOT_EXTENSION_HOST_TIMEOUT_MS, '120000');
        assert.equal(Object.prototype.hasOwnProperty.call(
            options.extensionTestsEnv, 'VSCODE_IPC_HOOK_CLI'), false);
        for (const directory of Object.values(environment)) {
            assert.equal(fs.statSync(directory).isDirectory(), true);
            assert.equal(path.relative(isolatedRoot, directory).startsWith('..'), false);
        }
    } finally {
        removeExtensionHostTestEnvironment(isolatedRoot);
    }
});

test('RELEASE-SCHEDULED-EXTENSION-HOST-001 binds the suite to a registered development host', () => {
    const repositoryRoot = path.resolve(__dirname, '../../..');
    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-hosted-suite-'));
    try {
        const environment = createExtensionHostTestEnvironment(isolatedRoot);
        const harnessRoot = path.join(isolatedRoot, 'test-harness');
        const testHarness = createExtensionHostTestHarness(
            repositoryRoot,
            harnessRoot
        );
        const installedRoots = {
            [MAIN_EXTENSION_ID]: path.join(environment.extensions, 'main'),
            [BRIDGE_EXTENSION_ID]: path.join(environment.extensions, 'bridge'),
        };
        const options = createRunTestsOptions(
            repositoryRoot,
            environment,
            path.join(isolatedRoot, 'VS Code'),
            installedRoots,
            testHarness
        );

        assert.deepEqual(options.extensionDevelopmentPath, [
            installedRoots[MAIN_EXTENSION_ID],
            installedRoots[BRIDGE_EXTENSION_ID],
            harnessRoot,
        ]);
        assert.equal(
            path.relative(harnessRoot, options.extensionTestsPath).startsWith('..'),
            false,
            'the test path must be owned by a registered development extension'
        );
        const harnessManifest = JSON.parse(fs.readFileSync(
            path.join(harnessRoot, 'package.json'),
            'utf8'
        ));
        assert.equal(
            `${harnessManifest.publisher}.${harnessManifest.name}`,
            TEST_HARNESS_EXTENSION_ID
        );
        assert.equal(
            fs.readFileSync(options.extensionTestsPath, 'utf8'),
            fs.readFileSync(
                path.join(repositoryRoot, 'tests', 'extension-host', 'suite', 'index.js'),
                'utf8'
            )
        );
    } finally {
        removeExtensionHostTestEnvironment(isolatedRoot);
    }
});

// RELEASE-SCHEDULED-EXTENSION-HOST-001
test('RELEASE-SCHEDULED-EXTENSION-HOST-001 verifies installed manifests and executable bytes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-installed-bytes-'));
    try {
        const fixture = createPackagedFixture(root);
        const extensionsDirectory = path.join(root, 'installed');
        fs.mkdirSync(extensionsDirectory, { recursive: true });
        const installedRoots = createInstalledFixture(
            root,
            extensionsDirectory,
            fixture
        );
        const evidence = verifyInstalledExtensionBytes(
            createExtensionPackagePlan(root),
            installedRoots
        );
        assert.equal(evidence.length, 6);
        assert.deepEqual(new Set(evidence.map(item => item.extensionId)), new Set([
            MAIN_EXTENSION_ID,
            BRIDGE_EXTENSION_ID,
        ]));

        writeFile(
            path.join(installedRoots[MAIN_EXTENSION_ID], 'package.json'),
            JSON.stringify({ ...fixture.mainManifest, displayName: 'mutated' })
        );
        assert.throws(
            () => verifyInstalledExtensionBytes(
                createExtensionPackagePlan(root),
                installedRoots
            ),
            /manifest .* differs from its VSIX source/
        );
        writeFile(
            path.join(installedRoots[MAIN_EXTENSION_ID], 'package.json'),
            JSON.stringify(fixture.mainManifest)
        );
        fs.writeFileSync(
            path.join(installedRoots[MAIN_EXTENSION_ID], 'dist/dashboard.js'),
            'mutated-runtime'
        );
        assert.throws(
            () => verifyInstalledExtensionBytes(
                createExtensionPackagePlan(root),
                installedRoots
            ),
            /differs from built bytes/
        );
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// RELEASE-SCHEDULED-EXTENSION-HOST-001
test('RELEASE-SCHEDULED-EXTENSION-HOST-001 installs both VSIX files through one isolated CLI profile', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-install-plan-'));
    const isolatedRoot = path.join(root, 'isolation');
    try {
        const fixture = createPackagedFixture(root);
        const environment = createExtensionHostTestEnvironment(isolatedRoot);
        createInstalledFixture(root, environment.extensions, fixture);
        const calls = [];
        const installation = installPackagedExtensions(
            root,
            environment,
            path.join(root, 'VS Code'),
            {
                resolveCliArgs: () => ['/verified/code', '--profile-arg'],
                spawnSync: (command, args, options) => {
                    calls.push({ command, args, options });
                    return { status: 0 };
                },
                stdio: 'pipe',
            }
        );

        assert.deepEqual(calls.map(call => call.command), [
            '/verified/code',
            '/verified/code',
        ]);
        assert.match(calls[0].args.join('\n'), /agent-pivot-attention-ui-bridge-8\.8\.8\.vsix/);
        assert.match(calls[1].args.join('\n'), /agent-pivot-9\.9\.9\.vsix/);
        for (const call of calls) {
            assert.ok(call.args.includes('--profile-arg'));
            assert.ok(call.args.includes(`--extensions-dir=${environment.extensions}`));
            assert.ok(call.args.includes(`--user-data-dir=${environment.userData}`));
            assert.ok(call.args.includes('--force'));
        }
        assert.equal(installation.evidence.length, 6);
    } finally {
        if (fs.existsSync(isolatedRoot)) removeExtensionHostTestEnvironment(isolatedRoot);
        fs.rmSync(root, { recursive: true, force: true });
    }
});

// RELEASE-SCHEDULED-EXTENSION-HOST-001
test('RELEASE-SCHEDULED-EXTENSION-HOST-001 removes hostile parent variables and restores exact state after failure', async () => {
    const original = new Map(HOSTILE_EXTENSION_HOST_ENVIRONMENT_KEYS.map(key => [key, process.env[key]]));
    for (const [index, key] of HOSTILE_EXTENSION_HOST_ENVIRONMENT_KEYS.entries()) {
        if (index === HOSTILE_EXTENSION_HOST_ENVIRONMENT_KEYS.length - 1) delete process.env[key];
        else process.env[key] = `hostile-${index}`;
    }
    try {
        await assert.rejects(
            withSanitizedExtensionHostEnvironment(async () => {
                for (const key of HOSTILE_EXTENSION_HOST_ENVIRONMENT_KEYS) {
                    assert.equal(Object.prototype.hasOwnProperty.call(process.env, key), false, key);
                }
                throw new Error('fixture failure');
            }),
            /fixture failure/);
        for (const [index, key] of HOSTILE_EXTENSION_HOST_ENVIRONMENT_KEYS.entries()) {
            if (index === HOSTILE_EXTENSION_HOST_ENVIRONMENT_KEYS.length - 1) {
                assert.equal(Object.prototype.hasOwnProperty.call(process.env, key), false, key);
            } else {
                assert.equal(process.env[key], `hostile-${index}`, key);
            }
        }
    } finally {
        for (const [key, value] of original) {
            value === undefined ? delete process.env[key] : process.env[key] = value;
        }
    }
});

// RELEASE-SCHEDULED-EXTENSION-HOST-001
test('RELEASE-SCHEDULED-EXTENSION-HOST-001 watchdog terminates the POSIX worker process group', async () => {
    const child = new EventEmitter();
    child.pid = 4321;
    const kills = [];
    const timers = [];
    let settlements = 0;
    const promise = runWorkerWithWatchdog(() => child, {
        timeoutMs: 25,
        platform: 'linux',
        killProcess: (pid, signal) => { kills.push([pid, signal]); },
        setTimeout: (callback, delay) => {
            const timer = { callback, cleared: false, delay };
            timers.push(timer);
            return timer;
        },
        clearTimeout: timer => { timer.cleared = true; },
    });
    promise.then(() => { settlements += 1; }, () => { settlements += 1; });

    timers[0].callback();
    child.emit('close', null, 'SIGTERM');
    await Promise.resolve();
    assert.equal(settlements, 0, 'worker close must not settle before process-group escalation');
    assert.equal(timers[1].cleared, false, 'worker close must not clear the force-kill timer');
    timers[1].callback();

    await assert.rejects(promise, /exceeded 25 ms/);
    assert.equal(EXTENSION_HOST_WORKER_TIMEOUT_MS, 480000);
    assert.deepEqual(kills, [[-4321, 'SIGTERM'], [-4321, 'SIGKILL']]);
    assert.equal(settlements, 1);
    assert.equal(timers.every(timer => timer.cleared), true);
    assert.equal(child.listenerCount('error'), 0);
    assert.equal(child.listenerCount('close'), 0);
});

// RELEASE-SCHEDULED-EXTENSION-HOST-001
test('RELEASE-SCHEDULED-EXTENSION-HOST-001 watchdog treats ESRCH as a cleanly absent process group', async () => {
    const child = new EventEmitter();
    child.pid = 9876;
    const timers = [];
    const promise = runWorkerWithWatchdog(() => child, {
        timeoutMs: 25,
        platform: 'darwin',
        killProcess: () => {
            const error = new Error('no such process group');
            error.code = 'ESRCH';
            throw error;
        },
        setTimeout: (callback, delay) => {
            const timer = { callback, cleared: false, delay };
            timers.push(timer);
            return timer;
        },
        clearTimeout: timer => { timer.cleared = true; },
    });

    timers[0].callback();

    await assert.rejects(promise, /exceeded 25 ms/);
    assert.equal(timers.length, 1, 'ESRCH must not schedule a redundant force kill');
    assert.equal(timers[0].cleared, true);
    assert.equal(child.listenerCount('error'), 0);
    assert.equal(child.listenerCount('close'), 0);
});

// RELEASE-EXTENSION-HOST-WORKER-COMPLETION-001
test('RELEASE-EXTENSION-HOST-WORKER-COMPLETION-001 watchdog accepts authenticated completion and terminates a lingering POSIX worker', async () => {
    const child = new EventEmitter();
    child.pid = 2468;
    const kills = [];
    const timers = [];
    const promise = runWorkerWithWatchdog(() => child, {
        timeoutMs: 25,
        platform: 'linux',
        killProcess: (pid, signal) => { kills.push([pid, signal]); },
        setTimeout: (callback, delay) => {
            const timer = { callback, cleared: false, delay };
            timers.push(timer);
            return timer;
        },
        clearTimeout: timer => { timer.cleared = true; },
    });

    try {
        assert.equal(child.listenerCount('message'), 1);
        child.emit('message', { type: 'untrusted-completion', version: 1 });
        assert.deepEqual(kills, [], 'unknown worker messages must not settle the run');

        child.emit('message', EXTENSION_HOST_WORKER_COMPLETED_MESSAGE);
        assert.deepEqual(kills, [[-2468, 'SIGTERM']]);
        assert.equal(timers[0].cleared, true, 'completion must clear the failure watchdog');
        assert.equal(timers[1].delay, 5000, 'completion cleanup retains force-kill protection');

        child.emit('close', null, 'SIGTERM');
        await promise;
        assert.equal(timers[1].cleared, true);
        assert.equal(child.listenerCount('error'), 0);
        assert.equal(child.listenerCount('close'), 0);
        assert.equal(child.listenerCount('message'), 0);
    } finally {
        child.emit('close', 0, null);
        await promise.catch(() => {});
    }
});

// RELEASE-EXTENSION-HOST-WORKER-COMPLETION-001
test('RELEASE-EXTENSION-HOST-WORKER-COMPLETION-001 authenticated completion survives force-kill cleanup', async () => {
    const child = new EventEmitter();
    child.pid = 1357;
    const kills = [];
    const timers = [];
    const promise = runWorkerWithWatchdog(() => child, {
        timeoutMs: 25,
        platform: 'linux',
        killProcess: (pid, signal) => { kills.push([pid, signal]); },
        setTimeout: (callback, delay) => {
            const timer = { callback, cleared: false, delay };
            timers.push(timer);
            return timer;
        },
        clearTimeout: timer => { timer.cleared = true; },
    });

    child.emit('message', EXTENSION_HOST_WORKER_COMPLETED_MESSAGE);
    timers[1].callback();

    await promise;
    assert.deepEqual(kills, [[-1357, 'SIGTERM'], [-1357, 'SIGKILL']]);
    assert.equal(timers.every(timer => timer.cleared), true);
    assert.equal(child.listenerCount('message'), 0);
});

// RELEASE-SCHEDULED-EXTENSION-HOST-001
test('RELEASE-SCHEDULED-EXTENSION-HOST-001 cleanup removes only the owned isolation root', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-launcher-parent-'));
    const isolatedRoot = path.join(parent, 'owned');
    createExtensionHostTestEnvironment(isolatedRoot);
    fs.writeFileSync(path.join(parent, 'keep.txt'), 'keep');

    removeExtensionHostTestEnvironment(isolatedRoot);

    assert.equal(fs.existsSync(isolatedRoot), false);
    assert.equal(fs.readFileSync(path.join(parent, 'keep.txt'), 'utf8'), 'keep');
    fs.rmSync(parent, { recursive: true, force: true });
});
