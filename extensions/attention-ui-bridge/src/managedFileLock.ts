'use strict';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const LOCK_STALE_MS = 10 * 60 * 1000;

function ensureLockDirectory(directory: string): void {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Managed lock path is not a real directory: ${directory}`);
    }
    if (process.platform !== 'win32'
        && typeof process.getuid === 'function'
        && stat.uid !== process.getuid()) {
        throw new Error(`Managed lock directory has foreign ownership: ${directory}`);
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
        throw new Error(`Managed lock directory has unsafe permissions: ${directory}`);
    }
}

function readLock(lockPath: string): Buffer | null {
    try {
        const stat = fs.lstatSync(lockPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
            throw new Error(`Managed lock is not a private regular file: ${lockPath}`);
        }
        if (process.platform !== 'win32'
            && typeof process.getuid === 'function'
            && stat.uid !== process.getuid()) {
            throw new Error(`Managed lock has foreign ownership: ${lockPath}`);
        }
        if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
            throw new Error(`Managed lock has unsafe permissions: ${lockPath}`);
        }
        const bytes = fs.readFileSync(lockPath);
        const after = fs.lstatSync(lockPath);
        if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size
            || after.mtimeMs !== stat.mtimeMs || after.mode !== stat.mode
            || after.nlink !== stat.nlink || after.uid !== stat.uid || after.gid !== stat.gid) {
            throw new Error(`Managed lock changed while it was read: ${lockPath}`);
        }
        return bytes;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return null; }
        throw error;
    }
}

function processIsAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) { return false; }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

function removeStaleLock(lockPath: string, expectedBytes: Buffer): void {
    const abandoned = `${lockPath}.abandoned-${crypto.randomBytes(8).toString('hex')}`;
    try {
        fs.linkSync(lockPath, abandoned);
        const linked = fs.lstatSync(abandoned);
        const current = fs.lstatSync(lockPath);
        const linkedBytes = fs.readFileSync(abandoned);
        if (!linked.isFile() || linked.isSymbolicLink()
            || linked.dev !== current.dev || linked.ino !== current.ino
            || linked.nlink !== 2 || current.nlink !== 2
            || !linkedBytes.equals(expectedBytes)) {
            throw new Error('Managed SSH config is busy in another Agent Pivot window.');
        }
        fs.unlinkSync(lockPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error('Managed SSH lock changed during stale recovery.');
        }
        throw error;
    } finally {
        try { fs.unlinkSync(abandoned); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
        }
    }
}

export function withManagedFileLock<T>(lockPath: string, operation: () => T): T {
    ensureLockDirectory(path.dirname(lockPath));
    const token = crypto.randomBytes(16).toString('hex');
    const acquire = (): number => {
        try {
            const descriptor = fs.openSync(lockPath, 'wx', 0o600);
            fs.writeFileSync(descriptor, JSON.stringify({
                schemaVersion: 1,
                pid: process.pid,
                host: os.hostname(),
                createdAtMs: Date.now(),
                token,
            }));
            fs.fsyncSync(descriptor);
            return descriptor;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
            const bytes = readLock(lockPath);
            let owner: { pid?: number; host?: string; createdAtMs?: number } = {};
            try { owner = bytes ? JSON.parse(bytes.toString('utf8')) : {}; } catch (_parseError) {
                throw new Error('Managed lock record is corrupt.');
            }
            const localOwner = owner.host === os.hostname()
                && typeof owner.pid === 'number';
            const locallyAlive = localOwner && processIsAlive(owner.pid!);
            const fresh = typeof owner.createdAtMs === 'number'
                && Date.now() - owner.createdAtMs < LOCK_STALE_MS;
            if (locallyAlive || (!localOwner && fresh)) {
                throw new Error('Managed SSH config is busy in another Agent Pivot window.');
            }
            if (!bytes) {
                throw new Error('Managed SSH lock changed during stale recovery.');
            }
            removeStaleLock(lockPath, bytes);
            return acquire();
        }
    };
    const descriptor = acquire();
    try {
        return operation();
    } finally {
        fs.closeSync(descriptor);
        const bytes = readLock(lockPath);
        if (bytes) {
            try {
                const owner = JSON.parse(bytes.toString('utf8')) as { token?: string };
                if (owner.token === token) { fs.unlinkSync(lockPath); }
            } catch (_error) { /* preserve an unexpected lock for recovery */ }
        }
    }
}
