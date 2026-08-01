'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
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
