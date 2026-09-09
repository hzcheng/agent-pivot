'use strict';

import {
    cloneMarkdownDocumentComments,
    isMarkdownDocumentCommentTarget,
    MarkdownDocumentComment,
    MarkdownDocumentCommentTarget,
    validateMarkdownDocumentComments,
} from './documentComments';
import {
    CommentSnapshot,
    KeyedSnapshotFileStore,
} from './snapshotFileStore';

const STORE_DIRECTORY = ['markdown-document-comments', 'v1'].join('/');

export type MarkdownDocumentCommentSnapshot =
    CommentSnapshot<MarkdownDocumentComment>;

export interface MarkdownDocumentCommentStore {
    load(
        target: MarkdownDocumentCommentTarget
    ): Promise<MarkdownDocumentCommentSnapshot>;
    save(
        target: MarkdownDocumentCommentTarget,
        snapshot: MarkdownDocumentCommentSnapshot
    ): Promise<void>;
}

/**
 * A document-comment snapshot is keyed by opaque worktree identity and the
 * normalized relative file path. Session IDs never participate, so comments
 * remain available after a conversation closes or a new AI session begins.
 */
export class MarkdownDocumentCommentFileStore
    extends KeyedSnapshotFileStore<
        MarkdownDocumentCommentTarget,
        MarkdownDocumentComment,
        MarkdownDocumentCommentSnapshot
    >
    implements MarkdownDocumentCommentStore {

    constructor(
        globalStoragePath: string,
        now: () => number = () => Date.now()
    ) {
        super(globalStoragePath, STORE_DIRECTORY, {
            isValidTarget: isMarkdownDocumentCommentTarget,
            targetsMatch: (persisted, target) =>
                persisted.projectId === target.projectId
                && persisted.workspaceRootId === target.workspaceRootId
                && persisted.relativePath === target.relativePath,
            digestIdentity: target => [
                target.projectId,
                target.workspaceRootId,
                target.relativePath,
            ],
            payloadKey: 'comments',
            itemsOf: snapshot => snapshot.comments,
            buildSnapshot: (revision, comments) => ({ revision, comments }),
            validateItems: validateMarkdownDocumentComments,
            cloneItems: cloneMarkdownDocumentComments,
            invalidSnapshotMessage: 'Invalid Markdown document comment snapshot.',
            invalidPersistedMessage:
                'Invalid persisted Markdown document comment snapshot.',
            maxSnapshotBytes: 2 * 1024 * 1024,
        }, now);
    }
}
