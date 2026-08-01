'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
    isLiveIpcSocket,
    resolveVSCodeCliTarget,
    serverEntryPoint,
} = require('../../../scripts/lib/vscodeCliTarget');

const SERVER_ROOT = '/home/dev/.vscode-server/bin/abc123';

function resolve(overrides = {}) {
    return resolveVSCodeCliTarget({
        environment: {},
        exists: () => true,
        listServerRoots: () => [],
        isLiveIpcSocket: () => false,
        ...overrides,
    });
}

test('LOCAL-INSTALL-CLI-TARGET-001 honours an explicit CODE_CMD before probing anything', () => {
    let probed = false;
    const target = resolve({
        environment: { CODE_CMD: 'code-insiders' },
        listServerRoots: () => { probed = true; return [SERVER_ROOT]; },
    });

    assert.equal(target.command, 'code-insiders');
    assert.equal(target.source, 'explicit');
    assert.equal(probed, false, 'an explicit choice must not be second-guessed');
});

test('LOCAL-INSTALL-CLI-TARGET-001 prefers the Server entry point over the inherited CLI', () => {
    // PATH's `code` inside a Server is remote-cli, which inherits the IPC hook.
    // bin/code-server talks to the Server installation directly instead.
    const target = resolve({
        environment: { VSCODE_IPC_HOOK_CLI: '/tmp/live.sock' },
        listServerRoots: () => [SERVER_ROOT],
        isLiveIpcSocket: () => true,
    });

    assert.equal(target.command, path.join(SERVER_ROOT, 'bin', 'code-server'));
    assert.equal(target.source, 'server');
    assert.equal(target.extensionsDir, '/home/dev/.vscode-server/extensions',
        'install and list must name the same extensions directory');
});

test('LOCAL-INSTALL-CLI-TARGET-001 still resolves the Server when the inherited hook is dead', () => {
    const target = resolve({
        environment: { VSCODE_IPC_HOOK_CLI: '/tmp/stale.sock' },
        listServerRoots: () => [SERVER_ROOT],
        isLiveIpcSocket: () => false,
    });

    assert.equal(target.command, path.join(SERVER_ROOT, 'bin', 'code-server'));
    assert.equal(target.source, 'server-stale-ipc');
});

test('LOCAL-INSTALL-CLI-TARGET-001 refuses to guess when the hook is dead and no Server exists', () => {
    const target = resolve({
        environment: { VSCODE_IPC_HOOK_CLI: '/tmp/stale.sock' },
        listServerRoots: () => [],
    });

    assert.equal(target.command, null);
    assert.match(target.error, /refuses connections/);
    assert.match(target.error, /CODE_CMD/, 'the message must say how to proceed');
});

test('LOCAL-INSTALL-CLI-TARGET-001 falls back to PATH for a plain local install', () => {
    const target = resolve({ environment: {} });

    assert.equal(target.command, 'code');
    assert.equal(target.source, 'path');
    assert.equal(target.extensionsDir, null, 'a local install keeps its default directory');
});

test('LOCAL-INSTALL-CLI-TARGET-001 skips a Server directory with no entry point', () => {
    const older = '/home/dev/.vscode-server/bin/older';
    const target = resolve({
        listServerRoots: () => [older, SERVER_ROOT],
        exists: candidate => candidate === serverEntryPoint(SERVER_ROOT),
    });

    assert.equal(target.command, serverEntryPoint(SERVER_ROOT));
});

test('LOCAL-INSTALL-CLI-TARGET-001 treats an unreachable socket path as dead', () => {
    assert.equal(isLiveIpcSocket('', () => true), false, 'an unset hook is not live');
    assert.equal(isLiveIpcSocket('/tmp/whatever.sock', () => false), false);
    assert.equal(isLiveIpcSocket('/tmp/whatever.sock', () => true), true);
});
