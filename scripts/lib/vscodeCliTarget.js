'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');

/**
 * Whether a VS Code IPC socket actually accepts a connection.
 *
 * VSCODE_IPC_HOOK_CLI stays set in a shell long after the window that created it
 * is gone, and the socket file survives too, so its presence proves nothing. A
 * CLI that inherits a dead hook either fails or silently targets the wrong host.
 */
function isLiveIpcSocket(socketPath, probe = probeUnixSocket) {
    return Boolean(socketPath) && probe(socketPath);
}

function probeUnixSocket(socketPath) {
    try {
        const socket = net.connect(socketPath);
        socket.destroy();
        return fs.statSync(socketPath).isSocket();
    } catch (_error) {
        return false;
    }
}

/**
 * The socket-independent entry point of a VS Code Server installation.
 *
 * `bin/code-server` runs the server's own `out/server-main.js` directly, so it
 * manages extensions without consulting VSCODE_IPC_HOOK_CLI at all.
 */
function serverEntryPoint(serverRoot) {
    return path.join(serverRoot, 'bin', 'code-server');
}

/**
 * Resolves which VS Code CLI should receive an extension install, and where.
 *
 * Preference order:
 *   1. An explicit CODE_CMD, which the caller is responsible for.
 *   2. The running Server installation, when a remote Server is present. This is
 *      required rather than merely preferred when the inherited IPC hook is
 *      stale, because PATH's `code` is the Server's remote-cli wrapper and it
 *      would inherit that dead hook.
 *   3. PATH's `code`, for a plain local install.
 */
function resolveVSCodeCliTarget(options = {}) {
    const environment = options.environment || process.env;
    const exists = options.exists || (candidate => fs.existsSync(candidate));
    const listServerRoots = options.listServerRoots || defaultListServerRoots;
    const socketIsLive = options.isLiveIpcSocket || isLiveIpcSocket;

    if (environment.CODE_CMD) {
        return {
            command: environment.CODE_CMD,
            source: 'explicit',
            extensionsDir: environment.VSCODE_EXTENSIONS || null,
        };
    }

    const serverRoots = listServerRoots(environment);
    const hookPath = environment.VSCODE_IPC_HOOK_CLI || '';
    const hookIsLive = socketIsLive(hookPath);
    for (const serverRoot of serverRoots) {
        const command = serverEntryPoint(serverRoot);
        if (!exists(command)) {
            continue;
        }
        return {
            command,
            source: hookIsLive ? 'server' : 'server-stale-ipc',
            extensionsDir: path.join(path.dirname(path.dirname(serverRoot)), 'extensions'),
        };
    }

    if (hookPath && !hookIsLive) {
        return {
            command: null,
            source: 'stale-ipc-without-server',
            extensionsDir: null,
            error: 'VSCODE_IPC_HOOK_CLI points at a socket that refuses connections and no '
                + 'VS Code Server installation was found. Set CODE_CMD to a CLI that can '
                + 'reach the intended host.',
        };
    }
    return { command: 'code', source: 'path', extensionsDir: null };
}

/** Server installations under ~/.vscode-server/bin, newest mtime first. */
function defaultListServerRoots(environment) {
    const home = environment.HOME || environment.USERPROFILE;
    if (!home) {
        return [];
    }
    const binRoot = path.join(home, '.vscode-server', 'bin');
    let entries;
    try {
        entries = fs.readdirSync(binRoot, { withFileTypes: true });
    } catch (_error) {
        return [];
    }
    return entries
        .filter(entry => entry.isDirectory())
        .map(entry => {
            const directory = path.join(binRoot, entry.name);
            let mtimeMs = 0;
            try {
                mtimeMs = fs.statSync(directory).mtimeMs;
            } catch (_error) {
                mtimeMs = 0;
            }
            return { directory, mtimeMs };
        })
        .sort((left, right) => right.mtimeMs - left.mtimeMs
            || left.directory.localeCompare(right.directory))
        .map(entry => entry.directory);
}

module.exports = {
    defaultListServerRoots,
    isLiveIpcSocket,
    resolveVSCodeCliTarget,
    serverEntryPoint,
};
