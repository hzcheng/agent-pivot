'use strict';

import type { RepositoryRootBinding } from '../workspaces/types';

// ── Stable Identity ──────────────────────────────────────────────

/**
 * Stable within a single worktree path lifetime.  External
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

// ── Git Snapshot ─────────────────────────────────────────────────

export type WorktreeHealth = 'normal' | 'missing' | 'prunable' | 'locked';

export type WorktreeHeadKind =
  | 'branch'
  | 'detached'
  | 'contained-in-base'
  | 'unknown';

/**
 * Pure Git snapshot parsed from `git worktree list --porcelain`.
 * Does NOT include AI-session projection (activity / sessions).
 */
export interface WorktreeGitSnapshot {
    key: WorktreeKey;
    branchRef?: string;
    head: string;
    isMain: boolean;
    isBare: boolean;
    health: WorktreeHealth;
    headKind: WorktreeHeadKind;
}

export interface WorktreeRepositorySnapshot {
    /** Canonical common-dir; also used by every child WorktreeKey. */
    repositoryKey: string;
    /** Workspace roots that caused this repository to be discovered. */
    rootBindings: readonly RepositoryRootBinding[];
    /** Explicit or initially detected local base ref, when available. */
    baseRef?: string;
    worktrees: readonly WorktreeGitSnapshot[];
}

/** Immutable, coherent Git discovery result published to projection readers. */
export interface WorktreeSnapshot {
    revision: number;
    repositories: readonly WorktreeRepositorySnapshot[];
    truncatedWorktreeCount: number;
}

export interface WorktreeSnapshotContent {
    repositories: readonly WorktreeRepositorySnapshot[];
    truncatedWorktreeCount: number;
}

// ── Member Baseline (task-start anchor) ─────────────────────────

/**
 * What the group's base ref resolved to when the member was created.
 * - branch: fully-qualified ref (refs/heads/… or refs/remotes/…); the
 *   ref may advance after capture (base-moved / behind detection).
 * - tag: fixed starting point; a force-moved tag only warrants a
 *   source-changed notice, never branch-style behind wording.
 * - commit: detached / raw SHA base; no movable base exists.
 */
export type WorktreeBaselineSource =
  | { kind: 'branch'; fullRef: string }
  | { kind: 'tag'; fullRef: string }
  | { kind: 'commit' };

/**
 * Immutable task-start anchor for a group member (changes-panel PRD
 * §4.2): captured before any physical side effect and persisted with
 * the provisioning intent. Absent means the baseline is unknown
 * (adopted / legacy / capture-failed) — never guessed from HEAD.
 */
export interface MemberBaseline {
    /** Frozen base commit SHA (`baseRef^{commit}` at capture time). */
    commitSha: string;
    capturedAt: number;
    source: WorktreeBaselineSource;
}

export type WorktreeSnapshotState =
  | { kind: 'uninitialized' }
  | { kind: 'loading' }
  | { kind: 'ready'; snapshot: WorktreeSnapshot; refreshing: boolean }
  | {
      kind: 'error';
      message: string;
      lastGoodSnapshot?: WorktreeSnapshot;
      retryable: boolean;
  };

// ── Provisioning row (Host-owned union) ──────────────────────────

export type ProvisioningStage =
  | 'queued'
  | 'creating'
  | 'setting-up'
  | 'failed';

export interface ProvisioningWorktreeRow {
    kind: 'provisioning';
    operationId: string;
    repositoryKey: string;
    taskName: string;
    proposedPath?: string;
    stage: ProvisioningStage;
    completedSteps: string[];
    retryable: boolean;
    cancellable: boolean;
    errorCode?: string;
}

// ── Helpers ──────────────────────────────────────────────────────

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
