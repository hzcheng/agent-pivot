'use strict';

import {
    ConversationBookmarkSnapshot,
    ConversationBookmarkStore,
    ConversationBookmarkTarget,
    isConversationBookmarkSnapshot,
    MAX_CONVERSATION_BOOKMARKS,
} from './bookmarkStore';
import type { CommentErrorCode } from './commentPrimitives';
import { CommentError } from './commentPrimitives';
import {
    QueuedMutationController,
    QueuedMutationControllerOptions,
    QueuedMutationResultBase,
} from './queuedMutationController';
import type { ConversationOutline } from './types';
import type { ConversationViewerTarget } from './viewerTarget';
import type {
    ConversationViewerBookmarkMutationMessage,
} from './viewerProtocol';

interface ConversationViewerBookmarksResultMessage
    extends QueuedMutationResultBase {
    type: 'conversation-viewer-bookmarks-result';
    operation: 'set';
    interactionIds: string[];
    error?: 'invalid' | 'stale' | 'failed' | 'limit';
}

export interface ConversationBookmarkControllerOptions
    extends QueuedMutationControllerOptions {
    bookmarkStore?: ConversationBookmarkStore;
    getOutline: () => ConversationOutline | undefined;
}

export class ConversationBookmarkController extends QueuedMutationController<
    ConversationBookmarkTarget,
    ConversationBookmarkSnapshot,
    ConversationViewerBookmarkMutationMessage,
    ConversationViewerBookmarksResultMessage
> {
    protected readonly options: ConversationBookmarkControllerOptions;
    private interactionIds = new Set<string>();
    private mutationsFrozen = false;

    constructor(options: ConversationBookmarkControllerOptions) {
        super(options);
        this.options = options;
    }

    async freezeMutations(): Promise<void> {
        this.mutationsFrozen = true;
        await this.drainMutations();
    }

    protected isMutationsFrozen(): boolean {
        return this.mutationsFrozen;
    }

    protected readonly resultType: 'conversation-viewer-bookmarks-result'
        = 'conversation-viewer-bookmarks-result';

    protected getStore(): ConversationBookmarkStore | undefined {
        return this.options.bookmarkStore;
    }

    protected toStoreTarget(
        target: ConversationViewerTarget
    ): ConversationBookmarkTarget {
        return {
            projectId: target.projectId,
            provider: target.provider,
            sessionId: target.sessionId,
        };
    }

    protected makeError(code: CommentErrorCode): CommentError {
        return new CommentError(code);
    }

    protected statePayload(): object {
        return { interactionIds: [...this.interactionIds] };
    }

    protected validateRestoredSnapshot(
        snapshot: ConversationBookmarkSnapshot
    ): boolean {
        return isConversationBookmarkSnapshot(snapshot);
    }

    protected applyRestoredSnapshot(
        snapshot: ConversationBookmarkSnapshot
    ): void {
        this.interactionIds = new Set(snapshot.interactionIds);
    }

    protected clearState(): void {
        this.interactionIds.clear();
        this.mutationsFrozen = false;
    }

    protected async performRequest(
        request: ConversationViewerBookmarkMutationMessage,
        target: ConversationViewerTarget
    ): Promise<void> {
        const interactionExists = this.options.getOutline()?.interactions.some(
            interaction => interaction.id === request.payload.interactionId
        ) === true;
        if (!interactionExists) {
            throw new CommentError('stale');
        }
        const next = new Set(this.interactionIds);
        if (request.payload.bookmarked) {
            next.add(request.payload.interactionId);
        } else {
            next.delete(request.payload.interactionId);
        }
        if (next.size > MAX_CONVERSATION_BOOKMARKS) {
            throw new CommentError('limit');
        }
        const changed = next.size !== this.interactionIds.size
            || [...next].some(id => !this.interactionIds.has(id));
        if (!changed) {
            // A redundant toggle settles successfully without touching the
            // persisted snapshot.
            return;
        }
        const snapshot = {
            revision: this.revision + 1,
            interactionIds: [...next],
        };
        const previousSnapshot = this.snapshot;
        await this.persist(target, snapshot);
        try {
            this.assertUnchanged(
                target,
                request.subscriptionGeneration,
                request.expectedRevision
            );
        } catch (error) {
            await this.persist(target, previousSnapshot);
            throw error;
        }
        this.interactionIds = next;
        this.revision = snapshot.revision;
    }
}
