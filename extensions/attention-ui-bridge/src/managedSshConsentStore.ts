'use strict';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { withManagedFileLock } from './managedFileLock';

export type ManagedSshConsentStatus =
    | 'disabled'
    | 'enabling'
    | 'enabled'
    | 'disabling'
    | 'recoveryRequired';

export interface ManagedSshConsentJournal {
    operation: 'enable' | 'disable' | 'reconcile';
    phase: 'preparing' | 'awaitingInclude' | 'awaitingIncludeRemoval' | 'activating';
    revisionId?: string;
    connectionDigest?: string;
    currentChecksum?: string;
    dependencyDigest?: string;
}

export interface ManagedSshConsentRecordV1 {
    schemaVersion: 1;
    generation: number;
    configPath: string;
    executable: string;
    status: ManagedSshConsentStatus;
    activeRevisionId?: string;
    connectionDigest?: string;
    currentChecksum?: string;
    dependencyDigest?: string;
    journal?: ManagedSshConsentJournal;
    recoveryReason?: string;
}

function recordName(configPath: string): string {
    return crypto.createHash('sha256').update(configPath, 'utf8').digest('hex');
}

function hasExactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
    return Object.keys(value).every(key => allowed.includes(key));
}

function validBoundedString(value: unknown, maximum = 4096): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= maximum
        && !/[\0\r\n]/u.test(value);
}

function validDigest(value: unknown): value is string {
    return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function validRevision(value: unknown): value is string {
    return typeof value === 'string' && /^revision:[a-f0-9]{64}$/u.test(value);
}

function validOptional(
    value: unknown,
    validator: (candidate: unknown) => boolean,
): boolean {
    return value === undefined || validator(value);
}

function validJournal(value: unknown): value is ManagedSshConsentJournal {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
    const journal = value as Record<string, unknown>;
    return hasExactKeys(journal, [
        'operation', 'phase', 'revisionId', 'connectionDigest', 'currentChecksum',
        'dependencyDigest',
    ])
        && ['enable', 'disable', 'reconcile'].includes(journal.operation as string)
        && ['preparing', 'awaitingInclude', 'awaitingIncludeRemoval', 'activating']
            .includes(journal.phase as string)
        && validOptional(journal.revisionId, validRevision)
        && validOptional(journal.connectionDigest, validDigest)
        && validOptional(journal.currentChecksum, validDigest)
        && validOptional(journal.dependencyDigest, validDigest);
}

function validRecord(value: unknown, configPath: string): value is ManagedSshConsentRecordV1 {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { return false; }
    const record = value as Record<string, unknown>;
    if (!hasExactKeys(record, [
        'schemaVersion', 'generation', 'configPath', 'executable', 'status',
        'activeRevisionId', 'connectionDigest', 'currentChecksum', 'dependencyDigest',
        'journal', 'recoveryReason',
    ])
        || record.schemaVersion !== 1
        || !Number.isSafeInteger(record.generation)
        || (record.generation as number) < 0
        || record.configPath !== configPath
        || !validBoundedString(record.executable)
        || !['disabled', 'enabling', 'enabled', 'disabling', 'recoveryRequired']
            .includes(record.status as string)
        || !validOptional(record.activeRevisionId, validRevision)
        || !validOptional(record.connectionDigest, validDigest)
        || !validOptional(record.currentChecksum, validDigest)
        || !validOptional(record.dependencyDigest, validDigest)
        || !validOptional(record.journal, validJournal)
        || !validOptional(record.recoveryReason, candidate => validBoundedString(candidate, 8192))) {
        return false;
    }
    if (record.status === 'disabled') {
        return record.activeRevisionId === undefined
            && record.connectionDigest === undefined
            && record.currentChecksum === undefined
            && record.dependencyDigest === undefined
            && record.journal === undefined
            && record.recoveryReason === undefined;
    }
    if (record.status === 'enabled') {
        return validRevision(record.activeRevisionId)
            && validDigest(record.connectionDigest)
            && validDigest(record.currentChecksum)
            && validDigest(record.dependencyDigest)
            && record.journal === undefined
            && record.recoveryReason === undefined;
    }
    if (record.status === 'enabling') {
        return validJournal(record.journal)
            && ['enable', 'reconcile'].includes(record.journal.operation);
    }
    if (record.status === 'disabling') {
        return validJournal(record.journal)
            && record.journal.operation === 'disable'
            && record.journal.phase === 'awaitingIncludeRemoval';
    }
    return validBoundedString(record.recoveryReason, 8192);
}

function assertPrivateRecordFile(filePath: string): fs.Stats {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new Error('Managed SSH consent record is not a private regular file.');
    }
    if (process.platform !== 'win32') {
        if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
            throw new Error('Managed SSH consent record has foreign ownership.');
        }
        if ((stat.mode & 0o077) !== 0) {
            throw new Error('Managed SSH consent record has unsafe permissions.');
        }
    }
    return stat;
}

function assertPrivateConsentDirectory(directory: string): void {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error('Managed SSH consent path is not a private directory.');
    }
    if (process.platform !== 'win32') {
        if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
            throw new Error('Managed SSH consent path has foreign ownership.');
        }
        if ((stat.mode & 0o077) !== 0) {
            throw new Error('Managed SSH consent path has unsafe permissions.');
        }
    }
}

function writeAtomic(filePath: string, value: ManagedSshConsentRecordV1): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    try { assertPrivateRecordFile(filePath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
    }
    const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
    let descriptor: number | undefined;
    try {
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, filePath);
        if (process.platform !== 'win32') { fs.chmodSync(filePath, 0o600); }
    } finally {
        if (descriptor !== undefined) { fs.closeSync(descriptor); }
        try { fs.unlinkSync(temporary); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
        }
    }
}

export class ManagedSshConsentFileStore {
    private readonly root: string;

    constructor(bridgeStorageRoot: string) {
        this.root = path.join(bridgeStorageRoot, 'managed-ssh-consent', 'v1');
    }

    read(configPath: string, executable: string): ManagedSshConsentRecordV1 {
        const filePath = path.join(this.root, `${recordName(configPath)}.json`);
        try {
            assertPrivateConsentDirectory(this.root);
            const stat = assertPrivateRecordFile(filePath);
            let parsed: unknown;
            try {
                parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
            } catch (error) {
                if (error instanceof SyntaxError) {
                    throw new Error('Managed SSH consent record is corrupt.');
                }
                throw error;
            }
            const after = assertPrivateRecordFile(filePath);
            if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size
                || after.mtimeMs !== stat.mtimeMs || after.mode !== stat.mode) {
                throw new Error('Managed SSH consent record changed while it was read.');
            }
            if (!validRecord(parsed, configPath)) {
                throw new Error('Managed SSH consent record is corrupt.');
            }
            return parsed;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
            return {
                schemaVersion: 1,
                generation: 0,
                configPath,
                executable,
                status: 'disabled',
            };
        }
    }

    compareAndSet(
        expectedGeneration: number,
        next: ManagedSshConsentRecordV1,
    ): ManagedSshConsentRecordV1 {
        const filePath = path.join(this.root, `${recordName(next.configPath)}.json`);
        const lockPath = path.join(this.root, `${recordName(next.configPath)}.lock`);
        return withManagedFileLock(lockPath, () => {
            const current = this.read(next.configPath, next.executable);
            if (current.generation !== expectedGeneration) {
                throw new Error('Managed SSH consent changed in another Agent Pivot window.');
            }
            const candidate = { ...next, generation: expectedGeneration + 1 };
            if (!validRecord(candidate, next.configPath)) {
                throw new Error('Managed SSH consent transition is invalid.');
            }
            writeAtomic(filePath, candidate);
            return candidate;
        });
    }
}
