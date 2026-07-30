'use strict';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { withFilesystemMutationLock } from '../../../src/aiSessions/tmuxCreationLock';
import {
    createOpenWorkspacePinSnapshot,
    MAX_OPEN_WORKSPACE_PINS,
    OPEN_WORKSPACE_PIN_PROTOCOL_VERSION,
    OpenWorkspacePinRecord,
    OpenWorkspacePinSetOutcome,
    OpenWorkspacePinSetRequest,
    OpenWorkspacePinSnapshot,
    validateOpenWorkspacePinRecord,
    validateOpenWorkspacePinSetRequest,
} from '../../../src/openWorkspaces/pinProtocol';

const PIN_FILE_SUFFIX = '.pin.json';
const MAX_PIN_FILE_BYTES = 4 * 1024;
const MAX_PIN_SCAN_ENTRIES = 1_000;
const PIN_LOCK_DIRECTORY = 'open-workspace-pin-locks';
const PIN_LOCK_KEY = 'pins-v1';

function hasErrorCode(error: unknown, code: string): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && (error as { code?: unknown }).code === code;
}

function validateNowMs(nowMs: number): number {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
        throw new Error('open workspace pin time must be a non-negative safe integer');
    }
    return nowMs;
}

export class OpenWorkspacePinStore {
    public readonly directoryPath: string;
    private mutationQueue: Promise<void> = Promise.resolve();

    constructor(private readonly rootDirectory: string) {
        this.directoryPath = path.join(rootDirectory, 'open-workspaces', 'pins', 'v1');
    }

    async scan(): Promise<OpenWorkspacePinSnapshot> {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(this.directoryPath, { withFileTypes: true });
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) {
                return createOpenWorkspacePinSnapshot([]);
            }
            throw error;
        }
        const records: OpenWorkspacePinRecord[] = [];
        for (const entry of entries
            .filter(entry =>
                /^[a-f0-9]{64}\.pin\.json$/.test(entry.name))
            .sort((left, right) => left.name.localeCompare(right.name))
            .slice(0, MAX_PIN_SCAN_ENTRIES)) {
            const identity = entry.name.slice(0, -PIN_FILE_SUFFIX.length);
            const filePath = path.join(this.directoryPath, entry.name);
            try {
                const stats = await fs.promises.lstat(filePath);
                if (!stats.isFile() || stats.isSymbolicLink()
                    || stats.size < 2 || stats.size > MAX_PIN_FILE_BYTES) {
                    continue;
                }
                const record = validateOpenWorkspacePinRecord(
                    JSON.parse(await fs.promises.readFile(filePath, 'utf8')),
                );
                if (record.navigationIdentity === identity) {
                    records.push(record);
                }
            } catch (_error) {
                // Ignore malformed or transient records; valid marker files remain authoritative.
            }
        }
        records.sort((left, right) =>
            left.pinnedAtMs - right.pinnedAtMs
            || left.navigationIdentity.localeCompare(right.navigationIdentity));
        return createOpenWorkspacePinSnapshot(records.slice(0, MAX_OPEN_WORKSPACE_PINS));
    }

    setPinned(raw: unknown, nowMs: number): Promise<OpenWorkspacePinSetOutcome> {
        const request = validateOpenWorkspacePinSetRequest(raw);
        const timestamp = validateNowMs(nowMs);
        return this.enqueueMutation(() => withFilesystemMutationLock(
            this.rootDirectory,
            PIN_LOCK_DIRECTORY,
            PIN_LOCK_KEY,
            async () => {
                let created = false;
                if (request.pinned) {
                    created = await this.createPin(request, timestamp);
                } else {
                    await this.removePin(request.navigationIdentity);
                }
                const snapshot = await this.scan();
                if (request.pinned && !snapshot.pins.some(
                    pin => pin.navigationIdentity === request.navigationIdentity,
                )) {
                    if (created) {
                        await this.removePin(request.navigationIdentity);
                    }
                    throw new Error(`No more than ${MAX_OPEN_WORKSPACE_PINS} open workspaces can be pinned`);
                }
                return {
                    protocolVersion: OPEN_WORKSPACE_PIN_PROTOCOL_VERSION,
                    requestId: request.requestId,
                    navigationIdentity: request.navigationIdentity,
                    pinned: request.pinned,
                    snapshot,
                };
            },
        ));
    }

    private async createPin(
        request: OpenWorkspacePinSetRequest,
        pinnedAtMs: number,
    ): Promise<boolean> {
        await fs.promises.mkdir(this.directoryPath, { recursive: true, mode: 0o700 });
        const finalPath = this.pinPath(request.navigationIdentity);
        const existing = await this.readExisting(finalPath, request.navigationIdentity);
        if (existing) {
            return false;
        }
        const current = await this.scan();
        if (current.pins.length >= MAX_OPEN_WORKSPACE_PINS) {
            throw new Error(`No more than ${MAX_OPEN_WORKSPACE_PINS} open workspaces can be pinned`);
        }
        const record: OpenWorkspacePinRecord = {
            protocolVersion: OPEN_WORKSPACE_PIN_PROTOCOL_VERSION,
            navigationIdentity: request.navigationIdentity,
            pinnedAtMs,
        };
        const contents = `${JSON.stringify(record)}\n`;
        const temporaryPath = path.join(
            this.directoryPath,
            `.${request.navigationIdentity}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
        );
        try {
            await fs.promises.writeFile(temporaryPath, contents, {
                encoding: 'utf8',
                mode: 0o600,
                flag: 'wx',
            });
            try {
                await fs.promises.link(temporaryPath, finalPath);
            } catch (error) {
                if (!hasErrorCode(error, 'EEXIST')) {
                    throw error;
                }
                const winner = await this.readExisting(finalPath, request.navigationIdentity);
                if (!winner) {
                    throw new Error('The existing open workspace pin is invalid');
                }
                return false;
            }
            return true;
        } finally {
            try {
                await fs.promises.unlink(temporaryPath);
            } catch (error) {
                if (!hasErrorCode(error, 'ENOENT')) {
                    // The unique temporary file never participates in pin ownership.
                }
            }
        }
    }

    private async readExisting(
        filePath: string,
        navigationIdentity: string,
    ): Promise<OpenWorkspacePinRecord | null> {
        try {
            const stats = await fs.promises.lstat(filePath);
            if (!stats.isFile() || stats.isSymbolicLink()
                || stats.size < 2 || stats.size > MAX_PIN_FILE_BYTES) {
                throw new Error('The existing open workspace pin is invalid');
            }
            const record = validateOpenWorkspacePinRecord(
                JSON.parse(await fs.promises.readFile(filePath, 'utf8')),
            );
            if (record.navigationIdentity !== navigationIdentity) {
                throw new Error('The existing open workspace pin identity does not match');
            }
            return record;
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) {
                return null;
            }
            throw error;
        }
    }

    private async removePin(navigationIdentity: string): Promise<void> {
        try {
            await fs.promises.unlink(this.pinPath(navigationIdentity));
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) {
                throw error;
            }
        }
    }

    private pinPath(navigationIdentity: string): string {
        return path.join(this.directoryPath, `${navigationIdentity}${PIN_FILE_SUFFIX}`);
    }

    private enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
        const result = this.mutationQueue.then(mutation);
        this.mutationQueue = result.then(() => undefined, () => undefined);
        return result;
    }
}
