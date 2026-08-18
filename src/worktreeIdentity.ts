'use strict';

/**
 * Worktree identity kernel (MOD-SHARED-KERNEL): the WorktreeKey type and its
 * canonical codecs. Owned here at the bottom of the module graph so every
 * module may depend on identity without cycles (ARCH-CHANGE-002).
 *
 * The tombstone key encoding is a persisted contract: byte-stable, never
 * change without a migration.
 */

/**
 * Stable within a single worktree path lifetime. External
 * `git worktree move` is treated as remove+add; existing sessions
 * that referenced the old WorktreeKey may temporarily degrade to
 * unmanaged until the next snapshot reconciles them.
 */
export interface WorktreeKey {
    /** Canonical git common-dir (resolved symlinks, normalized). */
    repositoryKey: string;
    /** Normalized absolute worktree path. */
    canonicalWorktreePath: string;
}

export function worktreeKeysEqual(a: WorktreeKey, b: WorktreeKey): boolean {
    return a.repositoryKey === b.repositoryKey
        && a.canonicalWorktreePath === b.canonicalWorktreePath;
}

export function cloneWorktreeKey(key: WorktreeKey): WorktreeKey {
    return {
        repositoryKey: key.repositoryKey,
        canonicalWorktreePath: key.canonicalWorktreePath,
    };
}

export function worktreeKeyToString(key: WorktreeKey): string {
    return `${key.repositoryKey}::${key.canonicalWorktreePath}`;
}

/**
 * Optional-field identity match: both keys undefined counts as matching
 * (no difference to report); exactly one defined is a mismatch.
 */
export function worktreeKeysMatch(
    left: WorktreeKey | undefined,
    right: WorktreeKey | undefined
): boolean {
    if (!left || !right) {
        return left === right;
    }
    return worktreeKeysEqual(left, right);
}

/**
 * Tombstone path-matching key. PERSISTED CONTRACT: the space-joined
 * repositoryKey + worktreePath feeds the tombstone pruning sets; the
 * encoding is byte-stable and must not change without a migration.
 */
export function worktreeKeyTombstoneKey(
    repositoryKey: string,
    worktreePath: string
): string {
    return `${repositoryKey} ${worktreePath}`;
}
