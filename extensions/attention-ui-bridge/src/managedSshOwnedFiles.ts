'use strict';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { withManagedFileLock } from './managedFileLock';

export interface ManagedSshOwnedPaths {
    root: string;
    revisions: string;
    current: string;
    previous: string;
    state: string;
    lock: string;
}

export interface ManagedSshInstalledProjection {
    connectionDigest: string;
    revisionId: string;
    currentChecksum: string;
    previousChecksum?: string;
    revisionPath: string;
    changed: boolean;
}

export interface ManagedSshStagedProjection {
    revisionId: string;
    connectionDigest: string;
    checksum: string;
    revisionPath: string;
}

export interface ManagedSshOwnedManifestV1 {
    schemaVersion: 1;
    configPath: string;
    revisionId: string;
    connectionDigest: string;
    currentChecksum: string;
    previousChecksum?: string;
}

const REVISION_FILE = /^[a-f0-9]{64}\.conf$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const REVISION_ID = /^revision:[a-f0-9]{64}$/u;

function checksum(value: string | Buffer): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}

export function managedSshOwnedPaths(activeConfigPath: string): ManagedSshOwnedPaths {
    const root = path.join(path.dirname(activeConfigPath), 'agent-pivot');
    return {
        root,
        revisions: path.join(root, 'revisions'),
        current: path.join(root, 'current.conf'),
        previous: path.join(root, 'previous.conf'),
        state: path.join(root, 'state.json'),
        lock: path.join(root, 'config.lock'),
    };
}

function assertSecureDirectory(directory: string): void {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`Managed SSH path is not a real directory: ${directory}`);
    }
    if (process.platform !== 'win32'
        && typeof process.getuid === 'function'
        && stat.uid !== process.getuid()) {
        throw new Error(`Managed SSH directory has foreign ownership: ${directory}`);
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
        throw new Error(`Managed SSH directory has unsafe permissions: ${directory}`);
    }
}

function ensureSecureDirectory(directory: string): void {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertSecureDirectory(directory);
    if (process.platform !== 'win32') { fs.chmodSync(directory, 0o700); }
}

function readRegularOwnedFile(filePath: string): Buffer | null {
    try {
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
            throw new Error(`Managed SSH file is not a private regular file: ${filePath}`);
        }
        if (process.platform !== 'win32'
            && typeof process.getuid === 'function'
            && stat.uid !== process.getuid()) {
            throw new Error(`Managed SSH file has foreign ownership: ${filePath}`);
        }
        if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
            throw new Error(`Managed SSH file has unsafe permissions: ${filePath}`);
        }
        const bytes = fs.readFileSync(filePath);
        const after = fs.lstatSync(filePath);
        if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size
            || after.mtimeMs !== stat.mtimeMs || after.mode !== stat.mode
            || after.nlink !== stat.nlink || after.uid !== stat.uid || after.gid !== stat.gid) {
            throw new Error(`Managed SSH file changed while it was read: ${filePath}`);
        }
        return bytes;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return null; }
        throw error;
    }
}

function fsyncDirectory(directory: string): void {
    if (process.platform === 'win32') { return; }
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function atomicWrite(filePath: string, bytes: Buffer): void {
    ensureSecureDirectory(path.dirname(filePath));
    readRegularOwnedFile(filePath);
    const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
    let descriptor: number | undefined;
    try {
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(descriptor, bytes);
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, filePath);
        if (process.platform !== 'win32') { fs.chmodSync(filePath, 0o600); }
        fsyncDirectory(path.dirname(filePath));
    } finally {
        if (descriptor !== undefined) { fs.closeSync(descriptor); }
        try { fs.unlinkSync(temporary); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
        }
    }
}

export class ManagedSshOwnedFileStore {
    private readonly paths: ManagedSshOwnedPaths;

    constructor(private readonly activeConfigPath: string) {
        this.paths = managedSshOwnedPaths(activeConfigPath);
    }

    getPaths(): ManagedSshOwnedPaths {
        return { ...this.paths };
    }

    readCurrent(): { content: string; checksum: string } | null {
        const bytes = readRegularOwnedFile(this.paths.current);
        return bytes ? { content: bytes.toString('utf8'), checksum: checksum(bytes) } : null;
    }

    readManifest(): ManagedSshOwnedManifestV1 | null {
        const bytes = readRegularOwnedFile(this.paths.state);
        if (!bytes) { return null; }
        try {
            const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
            const keys = Object.keys(value);
            if (!(value
                && value.schemaVersion === 1
                && value.configPath === this.activeConfigPath
                && typeof value.revisionId === 'string' && REVISION_ID.test(value.revisionId)
                && typeof value.connectionDigest === 'string' && DIGEST.test(value.connectionDigest)
                && typeof value.currentChecksum === 'string' && DIGEST.test(value.currentChecksum)
                && (value.previousChecksum === undefined
                    || typeof value.previousChecksum === 'string' && DIGEST.test(value.previousChecksum))
                && keys.every(key => [
                    'schemaVersion', 'configPath', 'revisionId', 'connectionDigest',
                    'currentChecksum', 'previousChecksum',
                ].includes(key)))) {
                throw new Error('Managed SSH state.json is corrupt.');
            }
            return value as unknown as ManagedSshOwnedManifestV1;
        } catch (error) {
            if (error instanceof SyntaxError) {
                throw new Error('Managed SSH state.json is corrupt.');
            }
            throw error;
        }
    }

    withLock<T>(operation: () => T): T {
        return withManagedFileLock(this.paths.lock, operation);
    }

    stageProjection(input: {
        revisionId: string;
        connectionDigest: string;
        content: string;
    }): ManagedSshStagedProjection {
        return this.withLock(() => {
            if (!REVISION_ID.test(input.revisionId) || !DIGEST.test(input.connectionDigest)) {
                throw new Error('Managed SSH projection identity is invalid.');
            }
            ensureSecureDirectory(this.paths.revisions);
            const bytes = Buffer.from(input.content, 'utf8');
            const revisionChecksum = checksum(bytes);
            const revisionPath = path.join(this.paths.revisions, `${revisionChecksum}.conf`);
            const existingRevision = readRegularOwnedFile(revisionPath);
            if (existingRevision && checksum(existingRevision) !== revisionChecksum) {
                throw new Error('Managed SSH revision identity was reused for different bytes.');
            }
            if (!existingRevision) { atomicWrite(revisionPath, bytes); }
            return {
                revisionId: input.revisionId,
                connectionDigest: input.connectionDigest,
                checksum: revisionChecksum,
                revisionPath,
            };
        });
    }

    activateProjection(
        staged: ManagedSshStagedProjection,
        expectedCurrentChecksum?: string,
    ): ManagedSshInstalledProjection {
        return this.withLock(() => {
            const stagedBytes = readRegularOwnedFile(staged.revisionPath);
            if (!stagedBytes || checksum(stagedBytes) !== staged.checksum) {
                throw new Error('Managed SSH staged revision is missing or changed.');
            }
            const current = this.readCurrent();
            if (expectedCurrentChecksum && current?.checksum !== expectedCurrentChecksum) {
                throw new Error('Managed SSH current.conf changed outside Agent Pivot.');
            }
            const currentChecksum = staged.checksum;
            const changed = current?.checksum !== currentChecksum;
            if (changed && current) { atomicWrite(this.paths.previous, Buffer.from(current.content)); }
            if (changed) { atomicWrite(this.paths.current, stagedBytes); }
            const previous = readRegularOwnedFile(this.paths.previous);
            const manifest: ManagedSshOwnedManifestV1 = {
                schemaVersion: 1,
                configPath: this.activeConfigPath,
                revisionId: staged.revisionId,
                connectionDigest: staged.connectionDigest,
                currentChecksum,
                ...(previous ? { previousChecksum: checksum(previous) } : {}),
            };
            atomicWrite(this.paths.state, Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8'));
            return {
                revisionId: staged.revisionId,
                connectionDigest: staged.connectionDigest,
                currentChecksum,
                ...(previous ? { previousChecksum: checksum(previous) } : {}),
                revisionPath: staged.revisionPath,
                changed,
            };
        });
    }

    removeOwnedFiles(expectedCurrentChecksum: string): void {
        this.withLock(() => {
            const current = this.readCurrent();
            if (current && current.checksum !== expectedCurrentChecksum) {
                throw new Error('Managed SSH current.conf changed outside Agent Pivot.');
            }
            const manifest = this.readManifest();
            if (current && (!manifest || manifest.currentChecksum !== current.checksum)) {
                throw new Error('Managed SSH state does not match current.conf.');
            }
            let revisions: string[] = [];
            try { revisions = fs.readdirSync(this.paths.revisions); } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
            }
            if (revisions.some(file => !REVISION_FILE.test(file))) {
                throw new Error('Managed SSH revisions contain files not owned by Agent Pivot.');
            }
            for (const file of revisions) {
                readRegularOwnedFile(path.join(this.paths.revisions, file));
                fs.unlinkSync(path.join(this.paths.revisions, file));
            }
            for (const file of [this.paths.current, this.paths.previous, this.paths.state]) {
                try {
                    readRegularOwnedFile(file);
                    fs.unlinkSync(file);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
                }
            }
            try { fs.rmdirSync(this.paths.revisions); } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
            }
        });
        try { fs.rmdirSync(this.paths.root); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT'
                && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') {
                throw error;
            }
        }
    }
}
