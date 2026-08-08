'use strict';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
    MAX_OPEN_WORKSPACE_RUNNING_FOCUS_REQUESTS,
    OpenWorkspaceRunningFocusRequest,
    validateOpenWorkspaceRunningFocusRequest,
} from '../../../src/openWorkspaces/runningFocusProtocol';

const REQUEST_FILE_SUFFIX = '.request.json';
const REQUEST_FILE_PATTERN = /^[a-f0-9]{32}\.request\.json$/;
const MAX_REQUEST_FILE_BYTES = 4 * 1024;
const MAX_REQUEST_SCAN_ENTRIES = 1_000;

function hasErrorCode(error: unknown, code: string): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && (error as { code?: unknown }).code === code;
}

/**
 * Durable one-shot mailbox for cross-window running-session focus requests.
 * Requests are individual atomic files (temp file + rename), so a submitter
 * never needs a lock; the winning window deletes the file on delivery and the
 * sweeper deletes whatever outlives its lease.
 */
export class OpenWorkspaceRunningFocusStore {
    public readonly directoryPath: string;

    constructor(private readonly rootDirectory: string) {
        this.directoryPath = path.join(rootDirectory, 'open-workspaces', 'running-focus', 'v1');
    }

    async submit(raw: unknown): Promise<OpenWorkspaceRunningFocusRequest> {
        const request = validateOpenWorkspaceRunningFocusRequest(raw);
        const pending = await this.scan(request.createdAtMs);
        if (pending.length >= MAX_OPEN_WORKSPACE_RUNNING_FOCUS_REQUESTS
            && !pending.some(candidate => candidate.requestId === request.requestId)) {
            throw new Error(
                `No more than ${MAX_OPEN_WORKSPACE_RUNNING_FOCUS_REQUESTS} running focus requests can be pending`,
            );
        }
        await fs.promises.mkdir(this.directoryPath, { recursive: true, mode: 0o700 });
        const temporaryPath = path.join(
            this.directoryPath,
            `.${request.requestId}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
        );
        try {
            await fs.promises.writeFile(temporaryPath, `${JSON.stringify(request)}\n`, {
                encoding: 'utf8',
                mode: 0o600,
                flag: 'wx',
            });
            await fs.promises.rename(temporaryPath, this.requestPath(request.requestId));
        } finally {
            try {
                await fs.promises.unlink(temporaryPath);
            } catch (error) {
                if (!hasErrorCode(error, 'ENOENT')) {
                    // The unique temporary file never participates in delivery.
                }
            }
        }
        return request;
    }

    async scan(nowMs: number): Promise<OpenWorkspaceRunningFocusRequest[]> {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(this.directoryPath, { withFileTypes: true });
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) {
                return [];
            }
            throw error;
        }
        const requests: OpenWorkspaceRunningFocusRequest[] = [];
        for (const entry of entries
            .filter(entry => REQUEST_FILE_PATTERN.test(entry.name))
            .sort((left, right) => left.name.localeCompare(right.name))
            .slice(0, MAX_REQUEST_SCAN_ENTRIES)) {
            const filePath = path.join(this.directoryPath, entry.name);
            try {
                const stats = await fs.promises.lstat(filePath);
                if (!stats.isFile() || stats.isSymbolicLink()
                    || stats.size < 2 || stats.size > MAX_REQUEST_FILE_BYTES) {
                    continue;
                }
                const request = validateOpenWorkspaceRunningFocusRequest(
                    JSON.parse(await fs.promises.readFile(filePath, 'utf8')),
                );
                if (entry.name !== `${request.requestId}${REQUEST_FILE_SUFFIX}`) {
                    continue;
                }
                if (request.expiresAtMs <= nowMs) {
                    await this.remove(request.requestId);
                    continue;
                }
                requests.push(request);
            } catch (_error) {
                // Ignore malformed or transient records; valid requests remain authoritative.
            }
        }
        requests.sort((left, right) =>
            left.createdAtMs - right.createdAtMs
            || left.requestId.localeCompare(right.requestId));
        return requests;
    }

    async remove(requestId: string): Promise<void> {
        try {
            await fs.promises.unlink(this.requestPath(requestId));
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) {
                throw error;
            }
        }
    }

    private requestPath(requestId: string): string {
        return path.join(this.directoryPath, `${requestId}${REQUEST_FILE_SUFFIX}`);
    }
}
