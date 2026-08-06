'use strict';

import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AiSessionProviderId } from '../../models';
import type {
    ConversationBookmarkRebindCopyResult,
    ConversationBookmarkTarget,
} from './bookmarkStore';
import type {
    ConversationCommentRebindCopyResult,
} from './commentStore';
import type { ConversationCommentTarget } from './comments';

const STORE_VERSION = 1;
const STORE_DIRECTORY = path.join('conversation-session-rebinds', 'v1');
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_RECORDS = 512;
const MAX_CHAIN_LENGTH = 64;

export type ConversationSessionRebindTarget = ConversationCommentTarget;
export type ConversationSessionMetadataKind = 'comments' | 'bookmarks';
type RebindCopyResult = ConversationCommentRebindCopyResult
    | ConversationBookmarkRebindCopyResult;

interface RebindCopyStore<TTarget> {
    copyForRebind(
        previous: TTarget,
        next: TTarget
    ): Promise<RebindCopyResult>;
}

interface PersistedConversationSessionRebind {
    version: 1;
    previous: ConversationSessionRebindTarget;
    next: ConversationSessionRebindTarget;
    commentsComplete: boolean;
    bookmarksComplete: boolean;
    runtimeCommitted: boolean;
    updatedAt: string;
}

export interface ConversationSessionRebindCoordinatorOptions {
    globalStoragePath: string;
    commentStore: RebindCopyStore<ConversationCommentTarget>;
    bookmarkStore: RebindCopyStore<ConversationBookmarkTarget>;
    now?: () => number;
    onResult?: (
        kind: ConversationSessionMetadataKind,
        result: RebindCopyResult
    ) => void;
    onFailure?: (
        kind: ConversationSessionMetadataKind,
        error: unknown
    ) => void;
    isRuntimeRebindCommitted?: (
        previous: ConversationSessionRebindTarget,
        next: ConversationSessionRebindTarget
    ) => Promise<boolean>;
}

export function hasCommittedConversationSessionRuntimeRebind(
    bindings: readonly ConversationSessionRebindTarget[],
    previous: ConversationSessionRebindTarget,
    next: ConversationSessionRebindTarget
): boolean {
    return isValidRebind(previous, next)
        && !bindings.some(binding => targetsEqual(binding, previous))
        && bindings.some(binding => targetsEqual(binding, next));
}

export class ConversationSessionRebindCoordinator {
    private readonly directoryPath: string;
    private readonly now: () => number;
    private readonly mappings = new Map<
        string,
        ConversationSessionRebindTarget
    >();
    private readonly records = new Map<
        string,
        PersistedConversationSessionRebind
    >();
    private operationQueue: Promise<void> = Promise.resolve();

    constructor(
        private readonly options: ConversationSessionRebindCoordinatorOptions
    ) {
        this.directoryPath = path.join(
            options.globalStoragePath,
            STORE_DIRECTORY
        );
        this.now = options.now || (() => Date.now());
    }

    restore(): Promise<void> {
        return this.serialize(async () => {
            const records = await this.readRecords();
            for (let index = 0; index < records.length; index += 1) {
                let record = records[index];
                this.records.set(targetKey(record.previous), record);
                if (!record.runtimeCommitted
                    && this.options.isRuntimeRebindCommitted
                    && await this.options.isRuntimeRebindCommitted(
                        record.previous,
                        record.next
                    )) {
                    record = await this.persistUpdate(record, {
                        runtimeCommitted: true,
                    });
                    records[index] = record;
                }
                if (record.runtimeCommitted) {
                    this.addMapping(record.previous, record.next);
                }
            }
            const failures: string[] = [];
            for (const record of records) {
                if (record.runtimeCommitted) {
                    failures.push(...await this.finish(record));
                }
            }
            if (failures.length) {
                throw new Error(
                    `Conversation Session rebind migration failed: ${
                        failures.join(', ')
                    }.`
                );
            }
        });
    }

    rebind(
        previous: ConversationSessionRebindTarget,
        next: ConversationSessionRebindTarget
    ): Promise<void> {
        return this.serialize(async () => {
            const record = await this.prepareUnlocked(previous, next);
            const failures = await this.commitUnlocked(record);
            if (failures.length) {
                throw new Error(
                    `Conversation Session rebind migration failed: ${
                        failures.join(', ')
                    }.`
                );
            }
        });
    }

    prepare(
        previous: ConversationSessionRebindTarget,
        next: ConversationSessionRebindTarget
    ): Promise<void> {
        return this.serialize(async () => {
            await this.prepareUnlocked(previous, next);
        });
    }

    commit(
        previous: ConversationSessionRebindTarget,
        next: ConversationSessionRebindTarget
    ): Promise<void> {
        return this.serialize(async () => {
            let record = this.records.get(targetKey(previous));
            if (!record || !targetsEqual(record.next, next)) {
                record = await this.prepareUnlocked(previous, next);
            }
            const failures = await this.commitUnlocked(record);
            if (failures.length) {
                throw new Error(
                    `Conversation Session rebind migration failed: ${
                        failures.join(', ')
                    }.`
                );
            }
        });
    }

    resolve<T extends ConversationSessionRebindTarget>(target: T): T {
        if (!isTarget(target)) {
            return target;
        }
        let current: ConversationSessionRebindTarget = { ...target };
        const visited = new Set<string>();
        for (let depth = 0; depth < MAX_CHAIN_LENGTH; depth += 1) {
            const key = targetKey(current);
            if (visited.has(key)) {
                break;
            }
            visited.add(key);
            const next = this.mappings.get(key);
            if (!next) {
                break;
            }
            current = { ...next };
        }
        return { ...target, sessionId: current.sessionId };
    }

    private async finish(
        record: PersistedConversationSessionRebind
    ): Promise<string[]> {
        const failures: string[] = [];
        if (!record.commentsComplete) {
            try {
                const result = await this.options.commentStore.copyForRebind(
                    record.previous,
                    record.next
                );
                this.options.onResult?.('comments', result);
                record = await this.persistUpdate(record, {
                    commentsComplete: true,
                });
            } catch (error) {
                this.options.onFailure?.('comments', error);
                failures.push('comments');
            }
        }
        if (!record.bookmarksComplete) {
            try {
                const result = await this.options.bookmarkStore.copyForRebind(
                    record.previous,
                    record.next
                );
                this.options.onResult?.('bookmarks', result);
                record = await this.persistUpdate(record, {
                    bookmarksComplete: true,
                });
            } catch (error) {
                this.options.onFailure?.('bookmarks', error);
                failures.push('bookmarks');
            }
        }
        return failures;
    }

    private async prepareUnlocked(
        previous: ConversationSessionRebindTarget,
        next: ConversationSessionRebindTarget
    ): Promise<PersistedConversationSessionRebind> {
        if (!isValidRebind(previous, next)
            || this.resolve(next).sessionId === previous.sessionId) {
            throw new Error('Invalid conversation Session rebind.');
        }
        const existing = this.records.get(targetKey(previous));
        if (existing && targetsEqual(existing.next, next)) {
            return existing;
        }
        const record: PersistedConversationSessionRebind = {
            version: STORE_VERSION,
            previous: { ...previous },
            next: { ...next },
            commentsComplete: false,
            bookmarksComplete: false,
            runtimeCommitted: false,
            updatedAt: new Date(this.now()).toISOString(),
        };
        await this.writeRecord(record);
        this.records.set(targetKey(previous), record);
        return record;
    }

    private async commitUnlocked(
        record: PersistedConversationSessionRebind
    ): Promise<string[]> {
        if (!record.runtimeCommitted) {
            record = await this.persistUpdate(record, {
                runtimeCommitted: true,
            });
        }
        this.addMapping(record.previous, record.next);
        return this.finish(record);
    }

    private async persistUpdate(
        record: PersistedConversationSessionRebind,
        changes: Partial<Pick<
            PersistedConversationSessionRebind,
            'runtimeCommitted' | 'commentsComplete' | 'bookmarksComplete'
        >>
    ): Promise<PersistedConversationSessionRebind> {
        const updated = {
            ...record,
            ...changes,
            updatedAt: new Date(this.now()).toISOString(),
        };
        await this.writeRecord(updated);
        this.records.set(targetKey(updated.previous), updated);
        return updated;
    }

    private addMapping(
        previous: ConversationSessionRebindTarget,
        next: ConversationSessionRebindTarget
    ): void {
        this.mappings.set(targetKey(previous), { ...next });
    }

    private async readRecords(): Promise<PersistedConversationSessionRebind[]> {
        let names: string[];
        try {
            names = await fs.promises.readdir(this.directoryPath);
        } catch (error) {
            if (isNodeError(error, 'ENOENT')) {
                return [];
            }
            throw error;
        }
        const entries: PersistedConversationSessionRebind[] = [];
        for (const name of names.filter(candidate => candidate.endsWith('.json'))) {
            const filePath = path.join(this.directoryPath, name);
            try {
                const stats = await fs.promises.stat(filePath);
                if (!stats.isFile() || stats.size > MAX_RECORD_BYTES) {
                    continue;
                }
                const value = JSON.parse(
                    await fs.promises.readFile(filePath, 'utf8')
                );
                if (isPersistedRecord(value)
                    && filePath === this.recordPath(value.previous)) {
                    entries.push(value);
                }
            } catch (_error) {
                // One malformed private record must not block other retries.
            }
        }
        entries.sort((left, right) =>
            Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
        );
        for (const stale of entries.slice(MAX_RECORDS)) {
            await removeFile(this.recordPath(stale.previous));
        }
        return entries.slice(0, MAX_RECORDS);
    }

    private async writeRecord(
        record: PersistedConversationSessionRebind
    ): Promise<void> {
        await fs.promises.mkdir(this.directoryPath, {
            recursive: true,
            mode: 0o700,
        });
        const recordPath = this.recordPath(record.previous);
        const temporaryPath = `${recordPath}.${process.pid}.${
            randomBytes(8).toString('hex')
        }.tmp`;
        try {
            await fs.promises.writeFile(
                temporaryPath,
                JSON.stringify(record),
                { encoding: 'utf8', flag: 'wx', mode: 0o600 }
            );
            await fs.promises.rename(temporaryPath, recordPath);
        } finally {
            await removeFile(temporaryPath);
        }
    }

    private recordPath(target: ConversationSessionRebindTarget): string {
        const digest = createHash('sha256')
            .update(targetKey(target))
            .digest('hex');
        return path.join(this.directoryPath, `${digest}.json`);
    }

    private serialize<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.operationQueue.then(operation);
        this.operationQueue = result.then(() => undefined, () => undefined);
        return result;
    }
}

function isPersistedRecord(
    value: unknown
): value is PersistedConversationSessionRebind {
    if (!isRecord(value)
        || value.version !== STORE_VERSION
        || !isTarget(value.previous)
        || !isTarget(value.next)
        || !isValidRebind(value.previous, value.next)
        || typeof value.commentsComplete !== 'boolean'
        || typeof value.bookmarksComplete !== 'boolean'
        || typeof value.runtimeCommitted !== 'boolean'
        || typeof value.updatedAt !== 'string'
        || !Number.isFinite(Date.parse(value.updatedAt))) {
        return false;
    }
    return true;
}

function targetsEqual(
    left: ConversationSessionRebindTarget,
    right: ConversationSessionRebindTarget
): boolean {
    return left.projectId === right.projectId
        && left.provider === right.provider
        && left.sessionId === right.sessionId;
}

function isValidRebind(
    previous: ConversationSessionRebindTarget,
    next: ConversationSessionRebindTarget
): boolean {
    return isTarget(previous)
        && isTarget(next)
        && previous.projectId === next.projectId
        && previous.provider === next.provider
        && previous.sessionId !== next.sessionId;
}

function isTarget(value: unknown): value is ConversationSessionRebindTarget {
    return isRecord(value)
        && isIdentity(value.projectId)
        && isProvider(value.provider)
        && isIdentity(value.sessionId);
}

function targetKey(target: ConversationSessionRebindTarget): string {
    return JSON.stringify([
        target.projectId,
        target.provider,
        target.sessionId,
    ]);
}

function isIdentity(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= 512
        && !/[\u0000-\u001f\u007f]/.test(value);
}

function isProvider(value: unknown): value is AiSessionProviderId {
    return value === 'codex' || value === 'kimi' || value === 'claude';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value)
        && typeof value === 'object'
        && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
    return Boolean(error && (error as NodeJS.ErrnoException).code === code);
}

async function removeFile(filePath: string): Promise<void> {
    try {
        await fs.promises.unlink(filePath);
    } catch (error) {
        if (!isNodeError(error, 'ENOENT')) {
            throw error;
        }
    }
}
