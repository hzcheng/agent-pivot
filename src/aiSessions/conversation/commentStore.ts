'use strict';

import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AiSessionProviderId } from '../../models';
import {
    cloneConversationComments,
    ConversationCommentDraft,
    ConversationCommentTarget,
    validateConversationComments,
} from './comments';

const STORE_VERSION = 1;
const STORE_DIRECTORY = path.join('conversation-comments', 'v1');
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export interface ConversationCommentSnapshot {
    revision: number;
    comments: ConversationCommentDraft[];
}

export interface ConversationCommentStore {
    load(
        target: ConversationCommentTarget
    ): Promise<ConversationCommentSnapshot>;
    save(
        target: ConversationCommentTarget,
        snapshot: ConversationCommentSnapshot
    ): Promise<void>;
}

interface PersistedConversationCommentSnapshot {
    version: 1;
    target: ConversationCommentTarget;
    revision: number;
    updatedAt: string;
    comments: ConversationCommentDraft[];
}

export class ConversationCommentFileStore implements ConversationCommentStore {
    private readonly directoryPath: string;

    constructor(
        globalStoragePath: string,
        private readonly now: () => number = () => Date.now()
    ) {
        this.directoryPath = path.join(globalStoragePath, STORE_DIRECTORY);
    }

    async load(
        target: ConversationCommentTarget
    ): Promise<ConversationCommentSnapshot> {
        if (!isConversationCommentTarget(target)) {
            return emptySnapshot();
        }
        const snapshotPath = this.getSnapshotPath(target);
        try {
            const stats = await fs.promises.stat(snapshotPath);
            if (!stats.isFile() || stats.size > MAX_SNAPSHOT_BYTES) {
                return emptySnapshot();
            }
            const value = JSON.parse(
                await fs.promises.readFile(snapshotPath, 'utf8')
            );
            if (!isPersistedSnapshot(value, target)) {
                return emptySnapshot();
            }
            validateConversationComments(value.comments);
            return {
                revision: value.revision,
                comments: cloneConversationComments(value.comments),
            };
        } catch (error) {
            if (isFileNotFoundError(error)) {
                return emptySnapshot();
            }
            return emptySnapshot();
        }
    }

    async save(
        target: ConversationCommentTarget,
        snapshot: ConversationCommentSnapshot
    ): Promise<void> {
        if (!isConversationCommentTarget(target)
            || !isSnapshot(snapshot)) {
            throw new Error('Invalid conversation comment snapshot.');
        }
        validateConversationComments(snapshot.comments);
        const snapshotPath = this.getSnapshotPath(target);
        if (snapshot.comments.length === 0) {
            try {
                await fs.promises.unlink(snapshotPath);
            } catch (error) {
                if (!isFileNotFoundError(error)) {
                    throw error;
                }
            }
            return;
        }
        await fs.promises.mkdir(this.directoryPath, {
            recursive: true,
            mode: 0o700,
        });
        const persisted: PersistedConversationCommentSnapshot = {
            version: STORE_VERSION,
            target: { ...target },
            revision: snapshot.revision,
            updatedAt: new Date(this.now()).toISOString(),
            comments: cloneConversationComments(snapshot.comments),
        };
        const temporaryPath = `${snapshotPath}.${process.pid}.${
            randomBytes(8).toString('hex')
        }.tmp`;
        try {
            await fs.promises.writeFile(
                temporaryPath,
                JSON.stringify(persisted),
                { encoding: 'utf8', flag: 'wx', mode: 0o600 }
            );
            await fs.promises.rename(temporaryPath, snapshotPath);
        } finally {
            try {
                await fs.promises.unlink(temporaryPath);
            } catch (error) {
                if (!isFileNotFoundError(error)) {
                    // The authoritative rename already succeeded or raised its
                    // own error. Temporary cleanup must not mask that result.
                }
            }
        }
    }

    private getSnapshotPath(target: ConversationCommentTarget): string {
        const identity = JSON.stringify([
            target.projectId,
            target.provider,
            target.sessionId,
        ]);
        const digest = createHash('sha256').update(identity).digest('hex');
        return path.join(this.directoryPath, `${digest}.json`);
    }
}

function emptySnapshot(): ConversationCommentSnapshot {
    return { revision: 0, comments: [] };
}

function isSnapshot(value: unknown): value is ConversationCommentSnapshot {
    if (!isRecord(value)) {
        return false;
    }
    return Number.isSafeInteger(value.revision)
        && (value.revision as number) >= 0
        && Array.isArray(value.comments);
}

function isPersistedSnapshot(
    value: unknown,
    target: ConversationCommentTarget
): value is PersistedConversationCommentSnapshot {
    if (!isRecord(value)
        || value.version !== STORE_VERSION
        || !isSnapshot(value)
        || typeof value.updatedAt !== 'string'
        || !isConversationCommentTarget(value.target)) {
        return false;
    }
    return value.target.projectId === target.projectId
        && value.target.provider === target.provider
        && value.target.sessionId === target.sessionId;
}

function isConversationCommentTarget(
    value: unknown
): value is ConversationCommentTarget {
    if (!isRecord(value)) {
        return false;
    }
    return isBoundedIdentity(value.projectId)
        && isAiSessionProvider(value.provider)
        && isBoundedIdentity(value.sessionId);
}

function isAiSessionProvider(value: unknown): value is AiSessionProviderId {
    return value === 'codex' || value === 'kimi' || value === 'claude';
}

function isBoundedIdentity(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= 512
        && !/[\u0000-\u001f\u007f]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value)
        && typeof value === 'object'
        && !Array.isArray(value);
}

function isFileNotFoundError(error: unknown): boolean {
    return Boolean(error && (error as NodeJS.ErrnoException).code === 'ENOENT');
}
