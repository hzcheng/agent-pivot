'use strict';

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

// ── Provisioning row (Host-owned union) ──────────────────────────

export type ProvisioningStage =
  | 'queued'
  | 'creating'
  | 'setting-up'
  | 'starting-agent'
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
