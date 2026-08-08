'use strict';

import type { AiSessionProviderId } from '../../models';
import {
    isAiSessionProvider,
    isBoundedId,
    isRecord,
} from './commentPrimitives';
import { KeyedSnapshotFileStore } from './snapshotFileStore';

const STORE_DIRECTORY = ['conversation-bookmarks', 'v1'].join('/');
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

export type ConversationBookmarkRebindCopyResult =
    'copied' | 'source-empty' | 'destination-exists';

export class ConversationBookmarkFileStore
    extends KeyedSnapshotFileStore<
        ConversationBookmarkTarget,
        string,
        ConversationBookmarkSnapshot
    >
    implements ConversationBookmarkStore {

    constructor(
        globalStoragePath: string,
        now: () => number = () => Date.now()
    ) {
        super(globalStoragePath, STORE_DIRECTORY, {
            isValidTarget: isTarget,
            targetsMatch: (persisted, target) =>
                persisted.projectId === target.projectId
                && persisted.provider === target.provider
                && persisted.sessionId === target.sessionId,
            digestIdentity: target => [
                target.projectId,
                target.provider,
                target.sessionId,
            ],
            payloadKey: 'interactionIds',
            itemsOf: snapshot => snapshot.interactionIds,
            buildSnapshot: (revision, interactionIds) => ({
                revision,
                interactionIds,
            }),
            validateItems: validateInteractionIds,
            cloneItems: interactionIds => [...interactionIds],
            invalidSnapshotMessage:
                'Invalid conversation bookmark snapshot.',
            invalidPersistedMessage:
                'Invalid persisted conversation bookmark snapshot.',
            maxSnapshotBytes: 256 * 1024,
        }, now);
    }

    async copyForRebind(
        previous: ConversationBookmarkTarget,
        next: ConversationBookmarkTarget
    ): Promise<ConversationBookmarkRebindCopyResult> {
        if (!isValidRebind(previous, next)) {
            throw new Error('Invalid conversation bookmark rebind.');
        }
        const source = await this.loadStrict(previous);
        if (source.interactionIds.length === 0) {
            return 'source-empty';
        }
        return this.saveIfAbsent(next, source);
    }
}

export function isConversationBookmarkSnapshot(
    value: unknown
): value is ConversationBookmarkSnapshot {
    return isRecord(value)
        && Number.isSafeInteger(value.revision)
        && (value.revision as number) >= 0
        && Array.isArray(value.interactionIds)
        && isValidInteractionIds(value.interactionIds);
}

function validateInteractionIds(items: string[]): void {
    if (!isValidInteractionIds(items)) {
        throw new Error('Invalid conversation bookmark snapshot.');
    }
}

function isValidInteractionIds(items: unknown[]): boolean {
    return items.length <= MAX_CONVERSATION_BOOKMARKS
        && items.every(item => isBoundedId(item))
        && new Set(items).size === items.length;
}

function isTarget(value: unknown): value is ConversationBookmarkTarget {
    return isRecord(value)
        && isBoundedId(value.projectId)
        && isAiSessionProvider(value.provider)
        && isBoundedId(value.sessionId);
}

function isValidRebind(
    previous: ConversationBookmarkTarget,
    next: ConversationBookmarkTarget
): boolean {
    return isTarget(previous)
        && isTarget(next)
        && previous.projectId === next.projectId
        && previous.provider === next.provider
        && previous.sessionId !== next.sessionId;
}
