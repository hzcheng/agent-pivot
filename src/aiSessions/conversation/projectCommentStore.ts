'use strict';

import {
    cloneProjectComments,
    ProjectComment,
    ProjectCommentTarget,
    validateProjectComments,
} from './projectComments';
import {
    CommentSnapshot,
    CommentSnapshotFileStore,
} from './snapshotFileStore';
import {
    isBoundedId,
    isRecord,
} from './commentPrimitives';

const STORE_DIRECTORY = ['project-comments', 'v1'].join('/');

export type ProjectCommentSnapshot = CommentSnapshot<ProjectComment>;

export interface ProjectCommentStore {
    load(target: ProjectCommentTarget): Promise<ProjectCommentSnapshot>;
    save(
        target: ProjectCommentTarget,
        snapshot: ProjectCommentSnapshot
    ): Promise<void>;
}

export class ProjectCommentFileStore
    extends CommentSnapshotFileStore<ProjectCommentTarget, ProjectComment>
    implements ProjectCommentStore {

    constructor(
        globalStoragePath: string,
        now: () => number = () => Date.now()
    ) {
        super(globalStoragePath, STORE_DIRECTORY, {
            isValidTarget: isProjectCommentTarget,
            targetsMatch: (persisted, target) =>
                persisted.projectId === target.projectId,
            digestIdentity: target => [target.projectId],
            validateComments: validateProjectComments,
            cloneComments: cloneProjectComments,
            invalidSnapshotMessage: 'Invalid project comment snapshot.',
            invalidPersistedMessage:
                'Invalid persisted project comment snapshot.',
        }, now);
    }
}

function isProjectCommentTarget(
    value: unknown
): value is ProjectCommentTarget {
    return isRecord(value) && isBoundedId(value.projectId);
}
