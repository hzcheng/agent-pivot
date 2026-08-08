'use strict';

import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Generic atomic file storage for keyed viewer state (comments, workspace
 * notes, bookmarks). Each stack keys snapshots by a target identity and
 * supplies its own validation/cloning hooks; this class owns the shared
 * persistence protocol: digest-addressed JSON files, size caps, temp-write +
 * rename (or hard-link for create-if-absent), and fail-soft reads.
 */

const STORE_VERSION = 1;

/** The comments-shaped snapshot shared by both comment stacks. */
export interface CommentSnapshot<TComment> {
    revision: number;
    comments: TComment[];
}

export interface KeyedSnapshotStoreHooks<TTarget, TItem, TSnap> {
    /** Rejects caller-supplied targets before any IO happens. */
    isValidTarget: (value: unknown) => value is TTarget;
    /** The persisted target must match the requested one exactly. */
    targetsMatch: (persisted: TTarget, target: TTarget) => boolean;
    /** Stable identity fields feeding the per-target digest file name. */
    digestIdentity: (target: TTarget) => readonly unknown[];
    /** Envelope field carrying the item array ('comments', …). */
    payloadKey: string;
    itemsOf: (snapshot: TSnap) => TItem[];
    buildSnapshot: (revision: number, items: TItem[]) => TSnap;
    /** Throws when persisted items fail model validation. */
    validateItems: (items: TItem[]) => void;
    cloneItems: (items: TItem[]) => TItem[];
    /** In-place migration hook for legacy persisted shapes (optional). */
    normalizeLegacyItems?: (items: TItem[]) => void;
    /** Error message used when save() receives an invalid snapshot. */
    invalidSnapshotMessage: string;
    /** Error message used when a strict rebind read hits corruption. */
    invalidPersistedMessage: string;
    /** Persisted files larger than this are treated as corrupt. */
    maxSnapshotBytes: number;
}

export class KeyedSnapshotFileStore<
    TTarget,
    TItem,
    TSnap extends { revision: number }
> {
    protected readonly directoryPath: string;

    constructor(
        globalStoragePath: string,
        storageDirectory: string,
        protected readonly hooks: KeyedSnapshotStoreHooks<
            TTarget,
            TItem,
            TSnap
        >,
        protected readonly now: () => number = () => Date.now()
    ) {
        this.directoryPath = path.join(globalStoragePath, storageDirectory);
    }

    async load(target: TTarget): Promise<TSnap> {
        if (!this.hooks.isValidTarget(target)) {
            return this.hooks.buildSnapshot(0, []);
        }
        try {
            return await this.readPersisted(target);
        } catch {
            // Missing or corrupt snapshots degrade to an empty list; the
            // controller simply starts from a clean revision.
            return this.hooks.buildSnapshot(0, []);
        }
    }

    async save(target: TTarget, snapshot: TSnap): Promise<void> {
        if (!this.hooks.isValidTarget(target)
            || !this.isSnapshotShape(snapshot)) {
            throw new Error(this.hooks.invalidSnapshotMessage);
        }
        const items = this.hooks.itemsOf(snapshot);
        this.hooks.validateItems(items);
        const snapshotPath = this.getSnapshotPath(target);
        if (items.length === 0) {
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
    protected async loadStrict(target: TTarget): Promise<TSnap> {
        try {
            return await this.readPersisted(target);
        } catch (error) {
            if (isFileNotFoundError(error)) {
                return this.hooks.buildSnapshot(0, []);
            }
            throw new Error(this.hooks.invalidPersistedMessage);
        }
    }

    /** Atomic create-if-absent via hard link; never overwrites. */
    protected async saveIfAbsent(
        target: TTarget,
        snapshot: TSnap
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

    private async readPersisted(target: TTarget): Promise<TSnap> {
        const snapshotPath = this.getSnapshotPath(target);
        const stats = await fs.promises.stat(snapshotPath);
        if (!stats.isFile() || stats.size > this.hooks.maxSnapshotBytes) {
            throw new Error(this.hooks.invalidPersistedMessage);
        }
        const value: unknown = JSON.parse(
            await fs.promises.readFile(snapshotPath, 'utf8')
        );
        if (!isRecord(value)
            || value.version !== STORE_VERSION
            || typeof value.updatedAt !== 'string'
            || !Number.isSafeInteger(value.revision)
            || (value.revision as number) < 0
            || !this.hooks.isValidTarget(value.target)
            || !this.hooks.targetsMatch(value.target, target)
            || !Array.isArray(value[this.hooks.payloadKey])) {
            throw new Error(this.hooks.invalidPersistedMessage);
        }
        const items = value[this.hooks.payloadKey] as TItem[];
        this.hooks.normalizeLegacyItems?.(items);
        this.hooks.validateItems(items);
        return this.hooks.buildSnapshot(
            value.revision as number,
            this.hooks.cloneItems(items)
        );
    }

    private isSnapshotShape(snapshot: TSnap): boolean {
        return Boolean(snapshot)
            && Number.isSafeInteger(snapshot.revision)
            && snapshot.revision >= 0
            && Array.isArray(this.hooks.itemsOf(snapshot));
    }

    private async writeTemporary(
        target: TTarget,
        snapshot: TSnap,
        snapshotPath: string
    ): Promise<string> {
        const persisted: Record<string, unknown> = {
            version: STORE_VERSION,
            target: { ...target },
            revision: snapshot.revision,
            updatedAt: new Date(this.now()).toISOString(),
        };
        persisted[this.hooks.payloadKey] = this.hooks.cloneItems(
            this.hooks.itemsOf(snapshot)
        );
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
