'use strict';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { spawn, execFileSync, ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import {
    CodexManagedRun, codexStreamRegistry, processStartIdentity, writePrivateJson,
} from './codexManagedRun';
const WebSocket = require('ws');
const MAX_FRAME = 64 * 1024 * 1024;
function canonicalDirectory(value: unknown): string | undefined {
    try { return typeof value === 'string' && path.isAbsolute(value) ? fs.realpathSync(value) : undefined; }
    catch (_error) { return undefined; }
}

export interface CodexTerminalLaunch {
    args: string[];
    cwd: string;
    markerPath: string;
    runId?: string;
}

/** Owns the companion for exactly the lifetime of this terminal, not the extension host. */
export async function runCodexTerminal(input: CodexTerminalLaunch): Promise<number> {
    if (!input || !Array.isArray(input.args) || input.args.some(arg => typeof arg !== 'string')
        || !path.isAbsolute(input.cwd || '') || !path.isAbsolute(input.markerPath || '')) {
        throw new Error('Invalid streaming terminal launch.');
    }
    const marker = `${input.markerPath}.stream.json`;
    const runId = input.runId || randomBytes(16).toString('hex');
    const run: CodexManagedRun = {
        version: 1, runId, state: 'starting', pid: process.pid,
        processStart: processStartIdentity(process.pid), startedAt: Date.now(), cwd: input.cwd,
    };
    const registry = codexStreamRegistry();
    let directory: string;
    let companion: ChildProcess;
    let terminal: ChildProcess;
    let web: http.Server;
    let sockets: any;
    let selected: string;
    let stopped = false;
    let failed = false;
    const ownedIndexes = new Set<string>();
    const unlinkOwned = (file: string) => {
        try {
            if (JSON.parse(fs.readFileSync(file, 'utf8')).runId === runId) { fs.unlinkSync(file); }
        } catch (_error) { /* A later launch may already own the marker. */ }
    };
    const stopCompanion = () => {
        sockets?.clients.forEach(socket => socket.terminate());
        sockets?.close();
        web?.close();
        if (companion?.pid && companion.exitCode === null && companion.signalCode === null) {
            try { process.kill(-companion.pid, 'SIGTERM'); } catch (_error) { /* Already exited. */ }
        }
    };
    const onTermination = () => {
        stopped = true;
        terminal?.kill('SIGTERM');
        stopCompanion();
    };
    // The TUI handles Ctrl-C. Its companion has a separate process group.
    const onInterrupt = () => {};
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTermination);
    process.on('SIGHUP', onTermination);
    const startTerminal = (args: string[]): Promise<number> => new Promise((resolve, reject) => {
        if (stopped) { reject(new Error('Terminal launch was cancelled.')); return; }
        terminal = spawn('codex', args, {
            cwd: input.cwd, env: { ...process.env, PWD: input.cwd }, stdio: 'inherit',
        });
        terminal.once('error', reject);
        terminal.once('exit', (code, signal) => resolve(failed ? 1 : code ?? (signal ? 1 : 0)));
    });
    try {
        writePrivateJson(marker, run);
        let help: string;
        try {
            help = execFileSync('codex', ['--help'], { encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024 });
        } catch (_error) { help = ''; }
        if (!help.includes('--remote') || !help.includes('unix://') || input.args.includes('-p')) {
            unlinkOwned(marker);
            process.stderr.write('[Agent Pivot] This Codex launch uses ordinary terminal mode; live text is unavailable.\n');
            return await startTerminal(input.args);
        }
        fs.mkdirSync(registry, { recursive: true, mode: 0o700 });
        const registryStat = fs.lstatSync(registry);
        if (!registryStat.isDirectory() || (registryStat.mode & 0o077)
            || (process.getuid && registryStat.uid !== process.getuid())) {
            throw new Error('The streaming registry must be a private directory.');
        }
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-codex-'));
        fs.chmodSync(directory, 0o700);
        const backend = path.join(directory, 'b.sock');
        const frontend = path.join(directory, 't.sock');
        run.socketPath = backend;
        const extraDirectories: string[] = [];
        const tuiArgs: string[] = [];
        const resume = input.args[0] === 'resume';
        const permissionOverrides: { approvalPolicy?: string; sandbox?: string } = {};
        for (let i = 0; i < input.args.length; i++) {
            if (input.args[i] === '--add-dir' && i + 1 < input.args.length) {
                extraDirectories.push(input.args[++i]);
            } else if (resume && input.args[i] === '--dangerously-bypass-approvals-and-sandbox') {
                permissionOverrides.approvalPolicy = 'never';
                permissionOverrides.sandbox = 'danger-full-access';
            } else if (resume && ['--sandbox', '--ask-for-approval'].includes(input.args[i])
                && i + 1 < input.args.length) {
                const field = input.args[i] === '--sandbox' ? 'sandbox' : 'approvalPolicy';
                permissionOverrides[field] = input.args[++i];
            } else { tuiArgs.push(input.args[i]); }
        }
        const serverArgs = ['app-server', '--listen', `unix://${backend}`];
        if (extraDirectories.length) {
            serverArgs.push('-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(extraDirectories)}`);
        }
        companion = spawn('codex', serverArgs, {
            cwd: input.cwd, env: { ...process.env, PWD: input.cwd }, detached: true,
            stdio: ['pipe', 'ignore', 'pipe'],
        });
        let serverError = false;
        companion.once('error', () => { serverError = true; });
        // Drain diagnostics without copying provider data into extension logs.
        companion.stderr.on('data', () => {});
        companion.once('exit', () => {
            serverError = true;
            if (terminal && !stopped) {
                failed = true;
                process.stderr.write('[Agent Pivot] The streaming companion stopped. Reopen this chat to resume its saved history.\n');
                terminal.kill('SIGTERM');
            }
        });
        for (let i = 0; i < 300 && !fs.existsSync(backend) && !serverError && !stopped; i++) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (serverError || stopped || !fs.existsSync(backend)) {
            throw new Error('Codex streaming companion could not start.');
        }
        web = http.createServer();
        sockets = new WebSocket.WebSocketServer({ server: web, maxPayload: MAX_FRAME, perMessageDeflate: false });
        let issuedSelection = 0;
        let acceptedSelection = 0;
        sockets.on('connection', client => {
            if (sockets.clients.size > 2) { client.close(); return; }
            const upstream = new WebSocket(`ws+unix://${backend}:/`, {
                maxPayload: MAX_FRAME, perMessageDeflate: false, handshakeTimeout: 5000,
            });
            const pending = new Map<unknown, { selection: number }>();
            const queue: string[] = [];
            let queuedBytes = 0;
            const fail = () => { client.terminate(); upstream.terminate(); };
            upstream.on('open', () => queue.splice(0).forEach(value => upstream.send(value)));
            client.on('message', (data: Buffer) => {
                try {
                    let text = data.toString();
                    const message = JSON.parse(text);
                    if (message.id !== undefined && ['thread/start', 'thread/resume', 'thread/fork'].includes(message.method)
                        && message.params?.ephemeral !== true) {
                        if (pending.size >= 128) { fail(); return; }
                        pending.set(message.id, { selection: ++issuedSelection });
                        {
                            // Remote resume rejects CLI permission flags. Apply the original
                            // invocation's explicit choices through the server request instead.
                            message.params = { ...message.params, cwd: input.cwd,
                                runtimeWorkspaceRoots: [input.cwd, ...extraDirectories],
                                ...(!selected ? permissionOverrides : {}) };
                            if (!selected && permissionOverrides.sandbox) { delete message.params.permissions; }
                            text = JSON.stringify(message);
                        }
                    }
                    if (upstream.readyState === WebSocket.OPEN) {
                        if (upstream.bufferedAmount > MAX_FRAME) { fail(); return; }
                        upstream.send(text);
                    } else {
                        queuedBytes += Buffer.byteLength(text);
                        if (queuedBytes > 1024 * 1024 || queue.length >= 128) { fail(); return; }
                        queue.push(text);
                    }
                } catch (_error) { fail(); }
            });
            upstream.on('message', (data: Buffer) => {
                try {
                    const text = data.toString();
                    const message = JSON.parse(text);
                    const request = pending.get(message.id);
                    if (request && !message.method) {
                        pending.delete(message.id);
                        const thread = message.result?.thread;
                        if (thread) {
                            const expectedRoots = [input.cwd, ...extraDirectories].map(root => canonicalDirectory(root)).sort();
                            const actualRoots = message.result.runtimeWorkspaceRoots;
                            const valid = expectedRoots.every(Boolean) && typeof message.result.cwd === 'string'
                                && canonicalDirectory(message.result.cwd) === canonicalDirectory(input.cwd)
                                && Array.isArray(actualRoots)
                                && JSON.stringify(actualRoots.map(root => canonicalDirectory(root)).sort()) === JSON.stringify(expectedRoots);
                            if (!valid) {
                                failed = true;
                                process.stderr.write('[Agent Pivot] Codex did not retain the requested workspace roots; the terminal was stopped.\n');
                                terminal?.kill('SIGTERM');
                                fail(); return;
                            }
                        }
                        if (thread && thread.ephemeral !== true && /^[A-Za-z0-9_-]{1,128}$/.test(thread.id || '')
                            && request.selection > acceptedSelection) {
                            acceptedSelection = request.selection;
                            if (selected && selected !== thread.id) {
                                unlinkOwned(path.join(registry, `${selected}.json`));
                                ownedIndexes.delete(path.join(registry, `${selected}.json`));
                            }
                            selected = thread.id;
                            Object.assign(run, { state: 'running', sessionId: selected, sequence: acceptedSelection });
                            writePrivateJson(marker, run);
                            const index = path.join(registry, `${selected}.json`);
                            writePrivateJson(index, run);
                            ownedIndexes.add(index);
                        }
                    }
                    if (client.readyState === WebSocket.OPEN) {
                        if (client.bufferedAmount > MAX_FRAME) { fail(); return; }
                        client.send(text);
                    }
                } catch (_error) { fail(); }
            });
            client.on('error', fail);
            upstream.on('error', fail);
            client.on('close', () => { pending.clear(); upstream.close(); });
            upstream.on('close', () => { pending.clear(); client.close(); });
        });
        await new Promise<void>((resolve, reject) => {
            web.once('error', reject);
            web.listen(frontend, () => {
                if (stopped) { reject(new Error('Terminal launch was cancelled.')); return; }
                try { fs.chmodSync(frontend, 0o600); resolve(); } catch (error) { reject(error); }
            });
        });
        if (stopped || serverError) { throw new Error('Terminal launch was cancelled.'); }
        return await startTerminal(['--remote', `unix://${frontend}`, ...tuiArgs]);
    } finally {
        stopped = true;
        stopCompanion();
        if (companion && companion.exitCode === null && companion.signalCode === null) {
            await new Promise<void>(resolve => {
                const timer = setTimeout(() => {
                    try { process.kill(-companion.pid, 'SIGKILL'); } catch (_error) { /* Already exited. */ }
                    resolve();
                }, 3000);
                companion.once('exit', () => { clearTimeout(timer); resolve(); });
            });
        }
        ownedIndexes.forEach(unlinkOwned);
        unlinkOwned(marker);
        if (directory) { fs.rmSync(directory, { recursive: true, force: true }); }
        process.removeListener('SIGINT', onInterrupt);
        process.removeListener('SIGTERM', onTermination);
        process.removeListener('SIGHUP', onTermination);
    }
}
