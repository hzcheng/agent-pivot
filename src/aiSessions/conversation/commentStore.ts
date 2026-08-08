'use strict';

import {
    cloneConversationComments,
    ConversationCommentDraft,
    ConversationCommentTarget,
    validateConversationComments,
} from './comments';
import {
    CommentSnapshot,
    CommentSnapshotFileStore,
} from './snapshotFileStore';
import {
    isAiSessionProvider,
    isBoundedId,
    isRecord,
} from './commentPrimitives';

const STORE_DIRECTORY = ['conversation-comments', 'v1'].join('/');

export type ConversationCommentSnapshot =
    CommentSnapshot<ConversationCommentDraft>;

export interface ConversationCommentStore {
    load(
        target: ConversationCommentTarget
    ): Promise<ConversationCommentSnapshot>;
    save(
        target: ConversationCommentTarget,
        snapshot: ConversationCommentSnapshot
    ): Promise<void>;
}

export type ConversationCommentRebindCopyResult =
    'copied' | 'source-empty' | 'destination-exists';

export class ConversationCommentFileStore
    extends CommentSnapshotFileStore<
        ConversationCommentTarget,
        ConversationCommentDraft
    >
    implements ConversationCommentStore {

    constructor(
        globalStoragePath: string,
        now: () => number = () => Date.now()
    ) {
        super(globalStoragePath, STORE_DIRECTORY, {
            isValidTarget: isConversationCommentTarget,
            targetsMatch: (persisted, target) =>
                persisted.projectId === target.projectId
                && persisted.provider === target.provider
                && persisted.sessionId === target.sessionId,
            digestIdentity: target => [
                target.projectId,
                target.provider,
                target.sessionId,
            ],
            validateComments: validateConversationComments,
            cloneComments: cloneConversationComments,
            normalizeLegacyComments: normalizeLegacyCommentStatuses,
            invalidSnapshotMessage:
                'Invalid conversation comment snapshot.',
            invalidPersistedMessage:
                'Invalid persisted conversation comment snapshot.',
        }, now);
    }

    async copyForRebind(
        previous: ConversationCommentTarget,
        next: ConversationCommentTarget
    ): Promise<ConversationCommentRebindCopyResult> {
        if (!isValidRebind(previous, next)) {
            throw new Error('Invalid conversation comment rebind.');
        }
        const source = await this.loadStrict(previous);
        if (source.comments.length === 0) {
            return 'source-empty';
        }
        return this.saveIfAbsent(next, source);
    }
}

// Migrates snapshots persisted before the open/done simplification: legacy
// 'sent' and 'resolved' statuses both collapse into 'done'. Timestamps are
// left untouched; createdAt/sentAt are optional and stay absent when the
// legacy snapshot never recorded them.
function normalizeLegacyCommentStatuses(
    comments: unknown[]
): void {
    comments.forEach(comment => {
        if (isRecord(comment)
            && (comment.status === 'sent' || comment.status === 'resolved')) {
            comment.status = 'done';
        }
    });
}

function isConversationCommentTarget(
    value: unknown
): value is ConversationCommentTarget {
    if (!isRecord(value)) {
        return false;
    }
    return isBoundedId(value.projectId)
        && isAiSessionProvider(value.provider)
        && isBoundedId(value.sessionId);
}

function isValidRebind(
    previous: ConversationCommentTarget,
    next: ConversationCommentTarget
): boolean {
    return isConversationCommentTarget(previous)
        && isConversationCommentTarget(next)
        && previous.projectId === next.projectId
        && previous.provider === next.provider
        && previous.sessionId !== next.sessionId;
}
