'use strict';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
    MAX_OPEN_WORKSPACE_ATTENTION_FOCUS_REQUESTS,
    OpenWorkspaceAttentionFocusRequest,
    validateOpenWorkspaceAttentionFocusRequest,
} from '../../../src/openWorkspaces/attentionFocusProtocol';

const REQUEST_PATTERN = /^([a-f0-9]{32})\.request\.json$/;
const MAX_FILE_BYTES = 4 * 1024;
const MAX_SCAN_ENTRIES = 1_000;
const POLL_MS = 10;

function hasErrorCode(error: unknown, code: string): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && (error as { code?: unknown }).code === code;
}

export class OpenWorkspaceAttentionFocusStore {
    public readonly directoryPath: string;

    constructor(private readonly rootDirectory: string) {
        this.directoryPath = path.join(rootDirectory, 'open-workspaces', 'attention-focus', 'v1');
    }

    async submit(raw: unknown): Promise<OpenWorkspaceAttentionFocusRequest> {
        const request = validateOpenWorkspaceAttentionFocusRequest(raw);
        const pending = await this.scan(request.createdAtMs);
        if (pending.length >= MAX_OPEN_WORKSPACE_ATTENTION_FOCUS_REQUESTS
            && !pending.some(candidate => candidate.requestId === request.requestId)) {
            throw new Error(
                `No more than ${MAX_OPEN_WORKSPACE_ATTENTION_FOCUS_REQUESTS}`
                    + ' attention focus requests can be pending',
            );
        }
        await fs.promises.mkdir(this.directoryPath, { recursive: true, mode: 0o700 });
        await this.writeAtomic(this.requestPath(request.requestId), request);
        return request;
    }

    async scan(nowMs: number): Promise<OpenWorkspaceAttentionFocusRequest[]> {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(this.directoryPath, { withFileTypes: true });
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) {
                return [];
            }
            throw error;
        }
        const requests: OpenWorkspaceAttentionFocusRequest[] = [];
        for (const entry of entries
            .filter(candidate => REQUEST_PATTERN.test(candidate.name))
            .sort((left, right) => left.name.localeCompare(right.name))
            .slice(0, MAX_SCAN_ENTRIES)) {
            const match = REQUEST_PATTERN.exec(entry.name);
            if (!match) {
                continue;
            }
            const filePath = path.join(this.directoryPath, entry.name);
            try {
                const stats = await fs.promises.lstat(filePath);
                if (!stats.isFile() || stats.isSymbolicLink()
                    || stats.size < 2 || stats.size > MAX_FILE_BYTES) {
                    continue;
                }
                const request = validateOpenWorkspaceAttentionFocusRequest(
                    JSON.parse(await fs.promises.readFile(filePath, 'utf8')),
                );
                if (request.requestId !== match[1]) {
                    continue;
                }
                if (request.expiresAtMs <= nowMs) {
                    await this.cancel(request.requestId);
                    continue;
                }
                requests.push(request);
            } catch (_error) {
                // Malformed and transient records never become authoritative.
            }
        }
        requests.sort((left, right) =>
            left.createdAtMs - right.createdAtMs
            || left.requestId.localeCompare(right.requestId));
        return requests;
    }

    async claim(requestId: string): Promise<boolean> {
        try {
            await fs.promises.rename(this.requestPath(requestId), this.claimPath(requestId));
            return true;
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) {
                return false;
            }
            throw error;
        }
    }

    async restore(requestId: string): Promise<void> {
        try {
            await fs.promises.rename(this.claimPath(requestId), this.requestPath(requestId));
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) {
                throw error;
            }
        }
    }

    async complete(requestId: string): Promise<void> {
        try {
            // Promote the claim itself into the receipt. The rename is the
            // ownership check and completion in one atomic operation, so a
            // timeout cancellation cannot race between a claim check and a
            // later receipt write and leave an orphan receipt behind.
            await fs.promises.rename(
                this.claimPath(requestId),
                this.receiptPath(requestId),
            );
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) {
                return;
            }
            throw error;
        }
    }

    async waitForDelivery(requestId: string, timeoutMs: number): Promise<boolean> {
        const deadline = Date.now() + timeoutMs;
        do {
            try {
                const raw = JSON.parse(await fs.promises.readFile(
                    this.receiptPath(requestId),
                    'utf8',
                )) as { requestId?: unknown };
                if (raw.requestId === requestId) {
                    await this.unlinkIfPresent(this.receiptPath(requestId));
                    return true;
                }
            } catch (error) {
                if (!hasErrorCode(error, 'ENOENT') && !(error instanceof SyntaxError)) {
                    throw error;
                }
            }
            await new Promise(resolve => setTimeout(resolve, POLL_MS));
        } while (Date.now() < deadline);
        return false;
    }

    async cancel(requestId: string): Promise<void> {
        await this.unlinkIfPresent(this.requestPath(requestId));
        await this.unlinkIfPresent(this.claimPath(requestId));
        await this.unlinkIfPresent(this.receiptPath(requestId));
    }

    private async writeAtomic(finalPath: string, value: unknown): Promise<void> {
        const temporaryPath = path.join(
            this.directoryPath,
            `.${path.basename(finalPath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
        );
        try {
            await fs.promises.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
                encoding: 'utf8', mode: 0o600, flag: 'wx',
            });
            await fs.promises.rename(temporaryPath, finalPath);
        } finally {
            await this.unlinkIfPresent(temporaryPath);
        }
    }

    private async unlinkIfPresent(filePath: string): Promise<void> {
        try {
            await fs.promises.unlink(filePath);
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) {
                throw error;
            }
        }
    }

    private requestPath(requestId: string): string {
        return path.join(this.directoryPath, `${requestId}.request.json`);
    }

    private claimPath(requestId: string): string {
        return path.join(this.directoryPath, `${requestId}.claim.json`);
    }

    private receiptPath(requestId: string): string {
        return path.join(this.directoryPath, `${requestId}.delivered.json`);
    }
}
