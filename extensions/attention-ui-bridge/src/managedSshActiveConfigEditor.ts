'use strict';

import * as fs from 'fs';
import * as path from 'path';

import { NodeManagedSshConfigFileSystem } from './managedSshConfigPolicy';
import { ManagedSshOwnedFileStore } from './managedSshOwnedFiles';

export interface ManagedSshActiveConfigEditResult {
    status: 'updated' | 'manualRequired';
    backupPath?: string;
    reason?: string;
}

export interface ManagedSshActiveConfigEditingService {
    hasInterruptedExchange(): boolean;
    recoverInterruptedExchange(): ManagedSshActiveConfigEditResult | null;
    replace(expectedContent: string, candidateContent: string): ManagedSshActiveConfigEditResult;
}

export interface ManagedSshActiveConfigEditorHooks {
    afterDisplace?(): void;
}

function readExistingRegularFile(filePath: string, maximumLinks = 1): fs.Stats | null {
    try {
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()
            || stat.nlink < 1 || stat.nlink > maximumLinks) {
            throw new Error(`Managed SSH exchange path is not a regular file: ${filePath}`);
        }
        if (process.platform !== 'win32'
            && typeof process.getuid === 'function'
            && stat.uid !== process.getuid()) {
            throw new Error(`Managed SSH exchange path has foreign ownership: ${filePath}`);
        }
        return stat;
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

function unlinkIfPresent(filePath: string): void {
    try { fs.unlinkSync(filePath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
    }
}

export class ManagedSshActiveConfigEditor implements ManagedSshActiveConfigEditingService {
    private readonly configFiles = new NodeManagedSshConfigFileSystem();
    private readonly paths: {
        candidate: string;
        exchange: string;
        previous: string;
    };

    constructor(
        private readonly activeConfigPath: string,
        private readonly owned: ManagedSshOwnedFileStore,
        private readonly hooks: ManagedSshActiveConfigEditorHooks = {},
    ) {
        const paths = owned.getPaths();
        this.paths = {
            candidate: paths.activeConfigCandidate,
            exchange: paths.activeConfigExchange,
            previous: paths.activeConfigPrevious,
        };
    }

    hasInterruptedExchange(): boolean {
        return readExistingRegularFile(this.paths.exchange) !== null
            || readExistingRegularFile(this.paths.candidate, 2) !== null;
    }

    recoverInterruptedExchange(): ManagedSshActiveConfigEditResult | null {
        return this.owned.withLock(() => {
            const exchange = readExistingRegularFile(this.paths.exchange);
            let candidate = readExistingRegularFile(this.paths.candidate, 2);
            if (!exchange && !candidate) { return null; }
            let activeExists = true;
            if (candidate) {
                try {
                    const active = fs.lstatSync(this.activeConfigPath);
                    if (active.isFile() && !active.isSymbolicLink()
                        && active.dev === candidate.dev && active.ino === candidate.ino) {
                        unlinkIfPresent(this.paths.candidate);
                        candidate = null;
                    }
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
                }
            }
            try { this.configFiles.readSecureFile(this.activeConfigPath); } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
                activeExists = false;
            }
            if (exchange && !activeExists) {
                fs.linkSync(this.paths.exchange, this.activeConfigPath);
                unlinkIfPresent(this.paths.exchange);
                unlinkIfPresent(this.paths.candidate);
                fsyncDirectory(path.dirname(this.activeConfigPath));
                return {
                    status: 'manualRequired',
                    reason: 'Agent Pivot restored the SSH config after an interrupted automatic update.',
                };
            }
            if (exchange) { this.archiveExchange(); }
            if (candidate) { unlinkIfPresent(this.paths.candidate); }
            return {
                status: 'manualRequired',
                ...(exchange ? { backupPath: this.paths.previous } : {}),
                reason: 'An interrupted automatic SSH config update requires validation.',
            };
        });
    }

    replace(
        expectedContent: string,
        candidateContent: string,
    ): ManagedSshActiveConfigEditResult {
        return this.owned.withLock(() => {
            if (this.hasInterruptedExchange()) {
                throw new Error('Managed SSH has an interrupted active-config exchange.');
            }
            const active = this.configFiles.readSecureFile(this.activeConfigPath);
            if (active.content !== expectedContent) {
                return {
                    status: 'manualRequired',
                    reason: 'The active SSH config changed before the automatic update.',
                };
            }
            if (expectedContent === candidateContent) {
                return { status: 'updated' };
            }
            this.writeCandidate(candidateContent, active);
            fs.renameSync(this.activeConfigPath, this.paths.exchange);
            fsyncDirectory(path.dirname(this.activeConfigPath));
            const displaced = this.configFiles.readSecureFile(this.paths.exchange);
            if (displaced.checksum !== active.checksum
                || displaced.device !== active.device
                || displaced.inode !== active.inode) {
                return this.restoreDisplaced(
                    'The active SSH config changed during the automatic update.',
                );
            }
            this.hooks.afterDisplace?.();
            try {
                fs.linkSync(this.paths.candidate, this.activeConfigPath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
                    unlinkIfPresent(this.paths.candidate);
                    this.archiveExchange();
                    return {
                        status: 'manualRequired',
                        backupPath: this.paths.previous,
                        reason: 'Another editor saved the active SSH config during the automatic update.',
                    };
                }
                return this.restoreDisplaced(
                    `The automatic SSH config update could not publish its candidate: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
            unlinkIfPresent(this.paths.candidate);
            fsyncDirectory(path.dirname(this.activeConfigPath));
            const installed = this.configFiles.readSecureFile(this.activeConfigPath);
            this.archiveExchange();
            if (installed.content !== candidateContent) {
                return {
                    status: 'manualRequired',
                    backupPath: this.paths.previous,
                    reason: 'The active SSH config changed immediately after the automatic update.',
                };
            }
            return { status: 'updated', backupPath: this.paths.previous };
        });
    }

    private writeCandidate(
        content: string,
        active: { mode: number; uid?: number; gid?: number },
    ): void {
        fs.mkdirSync(path.dirname(this.paths.candidate), { recursive: true, mode: 0o700 });
        const descriptor = fs.openSync(this.paths.candidate, 'wx', active.mode & 0o777);
        try {
            fs.writeFileSync(descriptor, content, 'utf8');
            if (process.platform !== 'win32'
                && active.uid !== undefined
                && active.gid !== undefined) {
                fs.fchownSync(descriptor, active.uid, active.gid);
                fs.fchmodSync(descriptor, active.mode & 0o777);
            }
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
        fsyncDirectory(path.dirname(this.paths.candidate));
    }

    private restoreDisplaced(reason: string): ManagedSshActiveConfigEditResult {
        try {
            fs.linkSync(this.paths.exchange, this.activeConfigPath);
            unlinkIfPresent(this.paths.exchange);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { throw error; }
            this.archiveExchange();
        }
        unlinkIfPresent(this.paths.candidate);
        fsyncDirectory(path.dirname(this.activeConfigPath));
        return {
            status: 'manualRequired',
            ...(readExistingRegularFile(this.paths.previous)
                ? { backupPath: this.paths.previous } : {}),
            reason,
        };
    }

    private archiveExchange(): void {
        const exchange = readExistingRegularFile(this.paths.exchange);
        if (!exchange) { return; }
        const previous = readExistingRegularFile(this.paths.previous);
        if (previous) { fs.unlinkSync(this.paths.previous); }
        fs.renameSync(this.paths.exchange, this.paths.previous);
        fsyncDirectory(path.dirname(this.paths.previous));
    }
}
