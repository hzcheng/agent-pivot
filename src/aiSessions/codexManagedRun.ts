'use strict';

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { execFileSync } from 'child_process';
import type { AiSessionLaunchSpec } from './launchSpec';

export interface CodexManagedRun {
    version: 1;
    runId: string;
    state: 'starting' | 'running';
    pid?: number;
    processStart?: string;
    startedAt?: number;
    cwd?: string;
    sessionId?: string;
    socketPath?: string;
    sequence?: number;
}

export function codexStreamRegistry(): string {
    return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'agent-pivot-streaming');
}

export function processStartIdentity(pid: number, procRoot = '/proc'): string | undefined {
    if (!Number.isSafeInteger(pid) || pid < 1) { return undefined; }
    try {
        if (process.platform === 'linux' || procRoot !== '/proc') {
            const stat = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
            return stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[19];
        }
        return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='],
            { encoding: 'utf8', timeout: 1000, maxBuffer: 4096 }).trim() || undefined;
    } catch (_error) { return undefined; }
}

export function writePrivateJson(file: string, value: unknown): void {
    const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
        fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, file);
    } finally {
        try { fs.unlinkSync(temporary); } catch (_error) { /* Already renamed. */ }
    }
}

export function readCodexManagedRun(file: string, procRoot = '/proc'): CodexManagedRun | undefined {
    try {
        const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        let text: string;
        try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || stat.size > 8192 || (stat.mode & 0o077)
                || (process.getuid && stat.uid !== process.getuid())) { return undefined; }
            text = fs.readFileSync(fd, 'utf8');
        } finally { fs.closeSync(fd); }
        const value = JSON.parse(text) as CodexManagedRun;
        if (value.version !== 1 || value.state !== 'running'
            || !/^[a-f0-9]{32}$/.test(value.runId || '')
            || !/^[A-Za-z0-9_-]{1,128}$/.test(value.sessionId || '')
            || typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd)
            || !Number.isFinite(value.startedAt)
            || !value.processStart || processStartIdentity(value.pid, procRoot) !== value.processStart) {
            return undefined;
        }
        return value;
    } catch (_error) { return undefined; }
}

export function resolveCodexManagedSocket(sessionId: string): string | undefined {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) { return undefined; }
    const run = readCodexManagedRun(path.join(codexStreamRegistry(), `${sessionId}.json`));
    if (run?.sessionId !== sessionId || !run.socketPath || !path.isAbsolute(run.socketPath)) {
        return undefined;
    }
    try {
        const parent = fs.lstatSync(path.dirname(run.socketPath));
        const socket = fs.lstatSync(run.socketPath);
        if (!parent.isDirectory() || (parent.mode & 0o077) || !socket.isSocket()
            || (process.getuid && (parent.uid !== process.getuid() || socket.uid !== process.getuid()))) {
            return undefined;
        }
        return run.socketPath;
    } catch (_error) { return undefined; }
}

/** Called only when an admitted runtime actually materializes its command. */
export function prepareCodexManagedLaunch(spec: AiSessionLaunchSpec): AiSessionLaunchSpec {
    if (spec.executable !== 'env' || spec.args[0] !== 'ELECTRON_RUN_AS_NODE=1'
        || !spec.args[2]?.endsWith('/codexTerminal.js')) { return spec; }
    const payload = JSON.parse(spec.args[3]);
    if (!payload.markerPath) { throw new Error('Streaming terminal requires a lifecycle marker.'); }
    payload.runId = randomBytes(16).toString('hex');
    writePrivateJson(`${payload.markerPath}.stream.json`, {
        version: 1, state: 'starting', runId: payload.runId,
    });
    return { ...spec, args: [...spec.args.slice(0, 3), JSON.stringify(payload)] };
}
