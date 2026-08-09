'use strict';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const REQUEST_FILE_SUFFIX = '.request.json';
const REQUEST_FILE_PATTERN = /^([a-f0-9]{32})\.request\.json$/;
const MAX_REQUEST_FILE_BYTES = 4 * 1024;
const MAX_REQUEST_SCAN_ENTRIES = 1_000;
const DELIVERY_POLL_MS = 10;

export interface OpenWorkspaceFocusMailboxRequest {
    requestId: string;
    targetNavigationIdentity: string;
    createdAtMs: number;
    expiresAtMs: number;
}

export interface OpenWorkspaceFocusMailboxStoreLike<
    Request extends OpenWorkspaceFocusMailboxRequest,
> {
    readonly directoryPath: string;
    submit(raw: unknown): Promise<Request>;
    scan(nowMs: number): Promise<Request[]>;
    claim(requestId: string): Promise<boolean>;
    restore(requestId: string): Promise<void>;
    complete(requestId: string): Promise<void>;
    waitForDelivery(requestId: string, timeoutMs: number): Promise<boolean>;
    cancel(requestId: string): Promise<void>;
}

export interface OpenWorkspaceFocusMailboxStoreOptions<
    Request extends OpenWorkspaceFocusMailboxRequest,
> {
    readonly directorySegments: readonly string[];
    readonly maxPendingRequests: number;
    readonly pendingRequestDescription: string;
    readonly validateRequest: (raw: unknown) => Request;
    readonly temporaryFileStem?: (requestId: string) => string;
    readonly ignoreTemporaryCleanupErrors?: boolean;
}

function hasErrorCode(error: unknown, code: string): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && (error as { code?: unknown }).code === code;
}

/**
 * Durable one-shot mailbox shared by cross-window focus transports.
 * Protocol-specific stores supply only validation, capacity, and the stable
 * on-disk directory that belongs to their wire protocol.
 */
export class OpenWorkspaceFocusMailboxStore<
    Request extends OpenWorkspaceFocusMailboxRequest,
> implements OpenWorkspaceFocusMailboxStoreLike<Request> {
    public readonly directoryPath: string;

    constructor(
        rootDirectory: string,
        private readonly options: OpenWorkspaceFocusMailboxStoreOptions<Request>,
    ) {
        this.directoryPath = path.join(rootDirectory, ...options.directorySegments);
    }

    async submit(raw: unknown): Promise<Request> {
        const request = this.options.validateRequest(raw);
        const pending = await this.scan(request.createdAtMs);
        if (pending.length >= this.options.maxPendingRequests
            && !pending.some(candidate => candidate.requestId === request.requestId)) {
            throw new Error(
                `No more than ${this.options.maxPendingRequests}`
                    + ` ${this.options.pendingRequestDescription} can be pending`,
            );
        }
        await fs.promises.mkdir(this.directoryPath, { recursive: true, mode: 0o700 });
        await this.writeAtomic(this.requestPath(request.requestId), request, request.requestId);
        return request;
    }

    async scan(nowMs: number): Promise<Request[]> {
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(this.directoryPath, { withFileTypes: true });
        } catch (error) {
            if (hasErrorCode(error, 'ENOENT')) {
                return [];
            }
            throw error;
        }
        const requests: Request[] = [];
        for (const entry of entries
            .filter(candidate => REQUEST_FILE_PATTERN.test(candidate.name))
            .sort((left, right) => left.name.localeCompare(right.name))
            .slice(0, MAX_REQUEST_SCAN_ENTRIES)) {
            const match = REQUEST_FILE_PATTERN.exec(entry.name);
            if (!match) {
                continue;
            }
            const filePath = path.join(this.directoryPath, entry.name);
            try {
                const stats = await fs.promises.lstat(filePath);
                if (!stats.isFile() || stats.isSymbolicLink()
                    || stats.size < 2 || stats.size > MAX_REQUEST_FILE_BYTES) {
                    continue;
                }
                const request = this.options.validateRequest(
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
            // The rename is both the ownership check and receipt creation, so
            // timeout cancellation cannot race with a later receipt write.
            await fs.promises.rename(this.claimPath(requestId), this.receiptPath(requestId));
        } catch (error) {
            if (!hasErrorCode(error, 'ENOENT')) {
                throw error;
            }
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
            await new Promise(resolve => setTimeout(resolve, DELIVERY_POLL_MS));
        } while (Date.now() < deadline);
        return false;
    }

    async cancel(requestId: string): Promise<void> {
        await this.unlinkIfPresent(this.requestPath(requestId));
        await this.unlinkIfPresent(this.claimPath(requestId));
        await this.unlinkIfPresent(this.receiptPath(requestId));
    }

    private async writeAtomic(finalPath: string, value: unknown, requestId: string): Promise<void> {
        const temporaryFileStem = this.options.temporaryFileStem
            ? this.options.temporaryFileStem(requestId)
            : path.basename(finalPath);
        const temporaryPath = path.join(
            this.directoryPath,
            `.${temporaryFileStem}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
        );
        try {
            await fs.promises.writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
                encoding: 'utf8', mode: 0o600, flag: 'wx',
            });
            await fs.promises.rename(temporaryPath, finalPath);
        } finally {
            try {
                await this.unlinkIfPresent(temporaryPath);
            } catch (error) {
                if (!this.options.ignoreTemporaryCleanupErrors) {
                    throw error;
                }
            }
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
        return path.join(this.directoryPath, `${requestId}${REQUEST_FILE_SUFFIX}`);
    }

    private claimPath(requestId: string): string {
        return path.join(this.directoryPath, `${requestId}.claim.json`);
    }

    private receiptPath(requestId: string): string {
        return path.join(this.directoryPath, `${requestId}.delivered.json`);
    }
}
