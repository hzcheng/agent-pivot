'use strict';

import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AiSessionProviderId } from '../../models';

const STORE_VERSION = 1;
const STORE_DIRECTORY = path.join('conversation-bookmarks', 'v1');
const MAX_SNAPSHOT_BYTES = 256 * 1024;
export const MAX_CONVERSATION_BOOKMARKS = 2000;

export interface ConversationBookmarkTarget {
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
}

export interface ConversationBookmarkSnapshot {
    revision: number;
    interactionIds: string[];
}

export interface ConversationBookmarkStore {
    load(
        target: ConversationBookmarkTarget
    ): Promise<ConversationBookmarkSnapshot>;
    save(
        target: ConversationBookmarkTarget,
        snapshot: ConversationBookmarkSnapshot
    ): Promise<void>;
}

interface PersistedConversationBookmarkSnapshot
    extends ConversationBookmarkSnapshot {
    version: 1;
    target: ConversationBookmarkTarget;
    updatedAt: string;
}

export class ConversationBookmarkFileStore
implements ConversationBookmarkStore {
    private readonly directoryPath: string;

    constructor(
        globalStoragePath: string,
        private readonly now: () => number = () => Date.now()
    ) {
        this.directoryPath = path.join(globalStoragePath, STORE_DIRECTORY);
    }

    async load(
        target: ConversationBookmarkTarget
    ): Promise<ConversationBookmarkSnapshot> {
        if (!isTarget(target)) {
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
            return isPersistedSnapshot(value, target)
                ? cloneSnapshot(value)
                : emptySnapshot();
        } catch (_error) {
            return emptySnapshot();
        }
    }

    async save(
        target: ConversationBookmarkTarget,
        snapshot: ConversationBookmarkSnapshot
    ): Promise<void> {
        if (!isTarget(target) || !isSnapshot(snapshot)) {
            throw new Error('Invalid conversation bookmark snapshot.');
        }
        const snapshotPath = this.getSnapshotPath(target);
        if (snapshot.interactionIds.length === 0) {
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
        const persisted: PersistedConversationBookmarkSnapshot = {
            version: STORE_VERSION,
            target: { ...target },
            revision: snapshot.revision,
            updatedAt: new Date(this.now()).toISOString(),
            interactionIds: [...snapshot.interactionIds],
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
            } catch (_error) {
                // Temporary cleanup must not mask the authoritative result.
            }
        }
    }

    private getSnapshotPath(target: ConversationBookmarkTarget): string {
        const identity = JSON.stringify([
            target.projectId,
            target.provider,
            target.sessionId,
        ]);
        const digest = createHash('sha256').update(identity).digest('hex');
        return path.join(this.directoryPath, `${digest}.json`);
    }
}

export function isConversationBookmarkSnapshot(
    value: unknown
): value is ConversationBookmarkSnapshot {
    return isSnapshot(value);
}

function emptySnapshot(): ConversationBookmarkSnapshot {
    return { revision: 0, interactionIds: [] };
}

function cloneSnapshot(
    snapshot: ConversationBookmarkSnapshot
): ConversationBookmarkSnapshot {
    return {
        revision: snapshot.revision,
        interactionIds: [...snapshot.interactionIds],
    };
}

function isSnapshot(value: unknown): value is ConversationBookmarkSnapshot {
    if (!isRecord(value)
        || !Number.isSafeInteger(value.revision)
        || (value.revision as number) < 0
        || !Array.isArray(value.interactionIds)
        || value.interactionIds.length > MAX_CONVERSATION_BOOKMARKS
        || !value.interactionIds.every(isIdentity)) {
        return false;
    }
    return new Set(value.interactionIds).size === value.interactionIds.length;
}

function isPersistedSnapshot(
    value: unknown,
    target: ConversationBookmarkTarget
): value is PersistedConversationBookmarkSnapshot {
    if (!isRecord(value)
        || value.version !== STORE_VERSION
        || typeof value.updatedAt !== 'string'
        || !isTarget(value.target)
        || !isSnapshot(value)) {
        return false;
    }
    return value.target.projectId === target.projectId
        && value.target.provider === target.provider
        && value.target.sessionId === target.sessionId;
}

function isTarget(value: unknown): value is ConversationBookmarkTarget {
    return isRecord(value)
        && isIdentity(value.projectId)
        && isProvider(value.provider)
        && isIdentity(value.sessionId);
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

function isFileNotFoundError(error: unknown): boolean {
    return Boolean(error && (error as NodeJS.ErrnoException).code === 'ENOENT');
}
