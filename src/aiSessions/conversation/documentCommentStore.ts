'use strict';

import * as fs from 'fs';
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
            retainEmptySnapshot: true,
        }, now);
    }

    /**
     * Comment snapshots are shared by all conversation panes for a document.
     * Serialize cross-window read/modify/write operations and reject a stale
     * revision rather than silently letting the later window erase comments.
     */
    async save(
        target: MarkdownDocumentCommentTarget,
        snapshot: MarkdownDocumentCommentSnapshot
    ): Promise<void> {
        const release = await this.acquireTargetLock(target);
        try {
            const current = await this.loadStrict(target);
            if (current.revision >= snapshot.revision) {
                throw new Error('Markdown document comments changed in another window.');
            }
            await super.save(target, snapshot);
        } finally {
            await release();
        }
    }

    private async acquireTargetLock(
        target: MarkdownDocumentCommentTarget
    ): Promise<() => Promise<void>> {
        await fs.promises.mkdir(this.directoryPath, { recursive: true, mode: 0o700 });
        const lockPath = `${this.getSnapshotPath(target)}.lock`;
        for (let attempt = 0; attempt < 80; attempt += 1) {
            try {
                const handle = await fs.promises.open(lockPath, 'wx', 0o600);
                try {
                    await handle.writeFile(JSON.stringify({
                        pid: process.pid,
                        createdAt: Date.now(),
                    }), 'utf8');
                    await handle.sync();
                } catch (error) {
                    await handle.close().catch(() => undefined);
                    await fs.promises.unlink(lockPath).catch(() => undefined);
                    throw error;
                }
                return async () => {
                    await handle.close().catch(() => undefined);
                    await fs.promises.unlink(lockPath).catch(() => undefined);
                };
            } catch (error) {
                if (!isAlreadyExistsError(error)) { throw error; }
                // A crashed extension host must not strand the document
                // forever. Locks are only held for one small atomic rename.
                try {
                    const stat = await fs.promises.stat(lockPath);
                    const owner = await readLockOwner(lockPath, stat.size);
                    const ownerExited = owner !== undefined
                        && !isProcessAlive(owner);
                    const legacyReloadLock = owner === undefined
                        && Date.now() - stat.mtimeMs > 2_000;
                    if (ownerExited || legacyReloadLock
                        || Date.now() - stat.mtimeMs > 30_000) {
                        await fs.promises.unlink(lockPath).catch(() => undefined);
                        continue;
                    }
                } catch (_error) { /* The owner released it; retry below. */ }
                await delay(25);
            }
        }
        throw new Error('Markdown document comments are busy in another window.');
    }
}

async function readLockOwner(lockPath: string, size: number): Promise<number | undefined> {
    if (size < 2 || size > 512) { return undefined; }
    try {
        const parsed: unknown = JSON.parse(await fs.promises.readFile(lockPath, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const pid = (parsed as { pid?: unknown }).pid;
            return Number.isSafeInteger(pid) && (pid as number) > 0
                ? pid as number : undefined;
        }
    } catch (_error) { /* Legacy/partially-written locks use age recovery. */ }
    return undefined;
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

function isAlreadyExistsError(error: unknown): boolean {
    return !!error && typeof error === 'object'
        && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
