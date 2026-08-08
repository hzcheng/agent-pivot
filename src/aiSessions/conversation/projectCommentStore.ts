'use strict';

import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    isBoundedId,
    isRecord,
} from './commentPrimitives';
import {
    cloneProjectComments,
    ProjectComment,
    ProjectCommentTarget,
    validateProjectComments,
} from './projectComments';

const STORE_VERSION = 1;
const STORE_DIRECTORY = path.join('project-comments', 'v1');
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export interface ProjectCommentSnapshot {
    revision: number;
    comments: ProjectComment[];
}

export interface ProjectCommentStore {
    load(target: ProjectCommentTarget): Promise<ProjectCommentSnapshot>;
    save(
        target: ProjectCommentTarget,
        snapshot: ProjectCommentSnapshot
    ): Promise<void>;
}

interface PersistedProjectCommentSnapshot {
    version: 1;
    target: ProjectCommentTarget;
    revision: number;
    updatedAt: string;
    comments: ProjectComment[];
}

export class ProjectCommentFileStore implements ProjectCommentStore {
    private readonly directoryPath: string;

    constructor(
        globalStoragePath: string,
        private readonly now: () => number = () => Date.now()
    ) {
        this.directoryPath = path.join(globalStoragePath, STORE_DIRECTORY);
    }

    async load(
        target: ProjectCommentTarget
    ): Promise<ProjectCommentSnapshot> {
        if (!isProjectCommentTarget(target)) {
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
            validateProjectComments(value.comments);
            return {
                revision: value.revision,
                comments: cloneProjectComments(value.comments),
            };
        } catch (_error) {
            // Missing or corrupt snapshots degrade to an empty project
            // section; a broken file must never block the viewer.
            return emptySnapshot();
        }
    }

    async save(
        target: ProjectCommentTarget,
        snapshot: ProjectCommentSnapshot
    ): Promise<void> {
        if (!isProjectCommentTarget(target) || !isSnapshot(snapshot)) {
            throw new Error('Invalid project comment snapshot.');
        }
        validateProjectComments(snapshot.comments);
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
        const persisted: PersistedProjectCommentSnapshot = {
            version: STORE_VERSION,
            target: { ...target },
            revision: snapshot.revision,
            updatedAt: new Date(this.now()).toISOString(),
            comments: cloneProjectComments(snapshot.comments),
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

    private getSnapshotPath(target: ProjectCommentTarget): string {
        const identity = JSON.stringify([target.projectId]);
        const digest = createHash('sha256').update(identity).digest('hex');
        return path.join(this.directoryPath, `${digest}.json`);
    }
}

function emptySnapshot(): ProjectCommentSnapshot {
    return { revision: 0, comments: [] };
}

function isSnapshot(value: unknown): value is ProjectCommentSnapshot {
    if (!isRecord(value)) {
        return false;
    }
    return Number.isSafeInteger(value.revision)
        && (value.revision as number) >= 0
        && Array.isArray(value.comments);
}

function isPersistedSnapshot(
    value: unknown,
    target: ProjectCommentTarget
): value is PersistedProjectCommentSnapshot {
    if (!isRecord(value)
        || value.version !== STORE_VERSION
        || !isSnapshot(value)
        || typeof value.updatedAt !== 'string'
        || !isProjectCommentTarget(value.target)) {
        return false;
    }
    return value.target.projectId === target.projectId;
}

function isProjectCommentTarget(
    value: unknown
): value is ProjectCommentTarget {
    return isRecord(value) && isBoundedId(value.projectId);
}

function isFileNotFoundError(error: unknown): boolean {
    return Boolean(error && (error as NodeJS.ErrnoException).code === 'ENOENT');
}
