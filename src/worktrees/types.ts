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
