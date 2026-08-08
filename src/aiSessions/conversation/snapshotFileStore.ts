'use strict';

import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Generic atomic file storage for the comment stacks. Each stack keys
 * snapshots by a target identity (session comments by
 * project+provider+session, workspace notes by project alone) and supplies
 * its own validation/cloning hooks; this class owns the shared persistence
 * protocol: digest-addressed JSON files, size caps, temp-write + rename
 * (or hard-link for create-if-absent), and fail-soft reads.
 */

const STORE_VERSION = 1;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;

export interface CommentSnapshot<TComment> {
    revision: number;
    comments: TComment[];
}

interface PersistedCommentSnapshot<TTarget, TComment> {
    version: 1;
    target: TTarget;
    revision: number;
    updatedAt: string;
    comments: TComment[];
}

export interface CommentSnapshotStoreHooks<TTarget, TComment> {
    /** Rejects caller-supplied targets before any IO happens. */
    isValidTarget: (value: unknown) => value is TTarget;
    /** The persisted target must match the requested one exactly. */
    targetsMatch: (persisted: TTarget, target: TTarget) => boolean;
    /** Stable identity fields feeding the per-target digest file name. */
    digestIdentity: (target: TTarget) => readonly unknown[];
    /** Throws when persisted comments fail model validation. */
    validateComments: (comments: TComment[]) => void;
    cloneComments: (comments: TComment[]) => TComment[];
    /** In-place migration hook for legacy persisted shapes (optional). */
    normalizeLegacyComments?: (comments: TComment[]) => void;
    /** Error message used when save() receives an invalid snapshot. */
    invalidSnapshotMessage: string;
    /** Error message used when a strict rebind read hits corruption. */
    invalidPersistedMessage: string;
}

export class CommentSnapshotFileStore<TTarget, TComment> {
    protected readonly directoryPath: string;

    constructor(
        globalStoragePath: string,
        storageDirectory: string,
        protected readonly hooks: CommentSnapshotStoreHooks<TTarget, TComment>,
        protected readonly now: () => number = () => Date.now()
    ) {
        this.directoryPath = path.join(globalStoragePath, storageDirectory);
    }

    async load(target: TTarget): Promise<CommentSnapshot<TComment>> {
        if (!this.hooks.isValidTarget(target)) {
            return emptySnapshot();
        }
        try {
            return await this.readPersisted(target);
        } catch {
            // Missing or corrupt snapshots degrade to an empty list; the
            // controller simply starts from a clean revision.
            return emptySnapshot();
        }
    }

    async save(
        target: TTarget,
        snapshot: CommentSnapshot<TComment>
    ): Promise<void> {
        if (!this.hooks.isValidTarget(target) || !isSnapshot(snapshot)) {
            throw new Error(this.hooks.invalidSnapshotMessage);
        }
        this.hooks.validateComments(snapshot.comments);
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
        const temporaryPath = await this.writeTemporary(
            target,
            snapshot,
            snapshotPath
        );
        try {
            await fs.promises.rename(temporaryPath, snapshotPath);
        } finally {
            await this.removeTemporary(temporaryPath);
        }
    }

    /**
     * Strict read for rebind flows: corruption raises instead of degrading,
     * only a missing file yields the empty snapshot.
     */
    protected async loadStrict(
        target: TTarget
    ): Promise<CommentSnapshot<TComment>> {
        try {
            return await this.readPersisted(target);
        } catch (error) {
            if (isFileNotFoundError(error)) {
                return emptySnapshot();
            }
            throw new Error(this.hooks.invalidPersistedMessage);
        }
    }

    /** Atomic create-if-absent via hard link; never overwrites. */
    protected async saveIfAbsent(
        target: TTarget,
        snapshot: CommentSnapshot<TComment>
    ): Promise<'copied' | 'destination-exists'> {
        const snapshotPath = this.getSnapshotPath(target);
        await fs.promises.mkdir(this.directoryPath, {
            recursive: true,
            mode: 0o700,
        });
        const temporaryPath = await this.writeTemporary(
            target,
            snapshot,
            snapshotPath
        );
        try {
            try {
                await fs.promises.link(temporaryPath, snapshotPath);
                return 'copied';
            } catch (error) {
                if (isFileExistsError(error)) {
                    return 'destination-exists';
                }
                throw error;
            }
        } finally {
            await this.removeTemporary(temporaryPath);
        }
    }

    protected getSnapshotPath(target: TTarget): string {
        const identity = JSON.stringify(this.hooks.digestIdentity(target));
        const digest = createHash('sha256').update(identity).digest('hex');
        return path.join(this.directoryPath, `${digest}.json`);
    }

    private async readPersisted(
        target: TTarget
    ): Promise<CommentSnapshot<TComment>> {
        const snapshotPath = this.getSnapshotPath(target);
        const stats = await fs.promises.stat(snapshotPath);
        if (!stats.isFile() || stats.size > MAX_SNAPSHOT_BYTES) {
            throw new Error(this.hooks.invalidPersistedMessage);
        }
        const value: unknown = JSON.parse(
            await fs.promises.readFile(snapshotPath, 'utf8')
        );
        if (!this.isPersistedSnapshot(value, target)) {
            throw new Error(this.hooks.invalidPersistedMessage);
        }
        this.hooks.normalizeLegacyComments?.(value.comments);
        this.hooks.validateComments(value.comments);
        return {
            revision: value.revision,
            comments: this.hooks.cloneComments(value.comments),
        };
    }

    private isPersistedSnapshot(
        value: unknown,
        target: TTarget
    ): value is PersistedCommentSnapshot<TTarget, TComment> {
        if (!isRecord(value)
            || value.version !== STORE_VERSION
            || !isSnapshot(value)
            || typeof value.updatedAt !== 'string'
            || !this.hooks.isValidTarget(value.target)) {
            return false;
        }
        return this.hooks.targetsMatch(value.target, target);
    }

    private async writeTemporary(
        target: TTarget,
        snapshot: CommentSnapshot<TComment>,
        snapshotPath: string
    ): Promise<string> {
        const persisted: PersistedCommentSnapshot<TTarget, TComment> = {
            version: STORE_VERSION,
            target: { ...target },
            revision: snapshot.revision,
            updatedAt: new Date(this.now()).toISOString(),
            comments: this.hooks.cloneComments(snapshot.comments),
        };
        const temporaryPath = `${snapshotPath}.${process.pid}.${
            randomBytes(8).toString('hex')
        }.tmp`;
        await fs.promises.writeFile(
            temporaryPath,
            JSON.stringify(persisted),
            { encoding: 'utf8', flag: 'wx', mode: 0o600 }
        );
        return temporaryPath;
    }

    private async removeTemporary(temporaryPath: string): Promise<void> {
        try {
            await fs.promises.unlink(temporaryPath);
        } catch (error) {
            if (!isFileNotFoundError(error)) {
                // The authoritative rename/link already succeeded or raised
                // its own error. Temporary cleanup must not mask that result.
            }
        }
    }
}

function emptySnapshot<TComment>(): CommentSnapshot<TComment> {
    return { revision: 0, comments: [] };
}

function isSnapshot<TComment>(
    value: unknown
): value is CommentSnapshot<TComment> {
    if (!isRecord(value)) {
        return false;
    }
    return Number.isSafeInteger(value.revision)
        && (value.revision as number) >= 0
        && Array.isArray(value.comments);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value)
        && typeof value === 'object'
        && !Array.isArray(value);
}

function isFileNotFoundError(error: unknown): boolean {
    return Boolean(error && (error as NodeJS.ErrnoException).code === 'ENOENT');
}

function isFileExistsError(error: unknown): boolean {
    return Boolean(error && (error as NodeJS.ErrnoException).code === 'EEXIST');
}
