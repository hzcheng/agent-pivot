'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makeTempDirectory } = require('../../helpers/tempDirectory');
const { createExtensionPackagePlan } = require('../../../scripts/lib/extensionHostLauncher');
const {
    buildInstallArgs,
    main,
    withoutIpcHook,
} = require('../../../scripts/install-local-extensions');

const repositoryRoot = path.resolve(__dirname, '../../..');

function collectLogger() {
    const out = [];
    return { out, log: line => out.push(line), error: line => out.push(`ERR ${line}`) };
}

test('LOCAL-INSTALL-CLI-TARGET-001 passes an absolute artifact path and pins the extensions dir', () => {
    const args = buildInstallArgs('artifacts/agent-pivot-1.0.1.vsix', '/srv/extensions');

    assert.deepEqual(args, [
        '--extensions-dir=/srv/extensions',
        '--install-extension',
        path.resolve('artifacts/agent-pivot-1.0.1.vsix'),
        '--force',
    ]);
    assert.ok(path.isAbsolute(args[2]),
        'a relative path would resolve against the Server working directory, not the shell');
});

test('LOCAL-INSTALL-CLI-TARGET-001 omits the extensions dir when the host default applies', () => {
    assert.deepEqual(buildInstallArgs('/tmp/x.vsix', null), [
        '--install-extension', '/tmp/x.vsix', '--force',
    ]);
});

test('LOCAL-INSTALL-CLI-TARGET-001 never leaks a stale IPC hook to the chosen CLI', () => {
    const cleaned = withoutIpcHook({ PATH: '/usr/bin', VSCODE_IPC_HOOK_CLI: '/tmp/stale.sock' });

    assert.equal('VSCODE_IPC_HOOK_CLI' in cleaned, false);
    assert.equal(cleaned.PATH, '/usr/bin');
});

test('LOCAL-INSTALL-CLI-TARGET-001 refuses to install when no CLI can be trusted', () => {
    const logger = collectLogger();
    let spawned = 0;

    const status = main({
        repositoryRoot,
        logger,
        spawnSync: () => { spawned += 1; return { status: 0 }; },
        target: { command: null, source: 'stale-ipc-without-server', error: 'no reachable host' },
    });

    assert.equal(status, 1);
    assert.equal(spawned, 0, 'nothing may be installed into an unknown host');
    assert.match(logger.out.join('\n'), /no reachable host/);
});

test('LOCAL-INSTALL-CLI-TARGET-001 stops at the first failing install', () => {
    const logger = collectLogger();
    const calls = [];

    const status = main({
        repositoryRoot,
        logger,
        spawnSync: (command, args) => {
            calls.push({ command, args });
            return { status: 1 };
        },
        target: { command: '/srv/bin/code-server', source: 'server', extensionsDir: '/srv/ext' },
    });

    assert.equal(status, 1);
    assert.equal(calls.length, 1, 'a failed install must not be followed by the next one');
    assert.equal(calls[0].command, '/srv/bin/code-server');
    assert.ok(calls[0].args.includes('--extensions-dir=/srv/ext'));
    assert.ok(path.isAbsolute(calls[0].args.at(-2)));
});

test('LOCAL-INSTALL-CLI-TARGET-001 installs without verifying when the host directory is unknown', () => {
    const logger = collectLogger();
    const calls = [];

    const status = main({
        repositoryRoot,
        logger,
        spawnSync: (command, args) => { calls.push(args); return { status: 0 }; },
        target: { command: 'code', source: 'path', extensionsDir: null },
    });

    assert.equal(status, 0);
    assert.equal(calls.length, 2, 'both extensions are installed');
    assert.ok(calls.every(args => !args.some(arg => arg.startsWith('--extensions-dir'))));
    assert.match(logger.out.join('\n'), /not verified/,
        'skipping verification must be stated, not implied by silence');
});

test('LOCAL-INSTALL-CLI-TARGET-001 verifies installed bytes against the built extension', t => {
    const extensionsDir = makeTempDirectory(t, 'local-install-verify-');
    const packagePlan = createExtensionPackagePlan(repositoryRoot);
    for (const extensionPackage of packagePlan) {
        const installedRoot = path.join(
            extensionsDir, `${extensionPackage.id}-${extensionPackage.version}`
        );
        fs.mkdirSync(installedRoot, { recursive: true });
        // VS Code injects __metadata on install; verification must tolerate it.
        fs.writeFileSync(path.join(installedRoot, 'package.json'), JSON.stringify({
            ...extensionPackage.manifest,
            __metadata: { installedTimestamp: 1 },
        }), 'utf8');
        for (const relativePath of extensionPackage.runtimeFiles) {
            const target = path.join(installedRoot, relativePath);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(path.join(extensionPackage.packageRoot, relativePath), target);
        }
    }

    const logger = collectLogger();
    const status = main({
        repositoryRoot,
        logger,
        spawnSync: () => ({ status: 0 }),
        target: { command: '/srv/bin/code-server', source: 'server', extensionsDir },
    });

    assert.equal(status, 0);
    const output = logger.out.join('\n');
    assert.match(output, /verified their bytes/);
    for (const extensionPackage of packagePlan) {
        assert.ok(output.includes(extensionPackage.id), `${extensionPackage.id} reported`);
    }
});

test('LOCAL-INSTALL-CLI-TARGET-001 fails when installed bytes do not match the build', t => {
    const extensionsDir = makeTempDirectory(t, 'local-install-mismatch-');
    const [extensionPackage] = createExtensionPackagePlan(repositoryRoot);
    const installedRoot = path.join(
        extensionsDir, `${extensionPackage.id}-${extensionPackage.version}`
    );
    fs.mkdirSync(installedRoot, { recursive: true });
    fs.writeFileSync(
        path.join(installedRoot, 'package.json'),
        JSON.stringify(extensionPackage.manifest), 'utf8'
    );
    for (const relativePath of extensionPackage.runtimeFiles) {
        const target = path.join(installedRoot, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'tampered', 'utf8');
    }

    const logger = collectLogger();
    const status = main({
        repositoryRoot,
        logger,
        spawnSync: () => ({ status: 0 }),
        target: { command: '/srv/bin/code-server', source: 'server', extensionsDir },
    });

    assert.equal(status, 1, 'a zero exit status from the CLI is not proof of installed bytes');
    assert.match(logger.out.join('\n'), /ERR /);
});
