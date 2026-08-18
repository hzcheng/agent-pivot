'use strict';

import type { RepositoryRootBinding } from '../workspaces/types';

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

// The worktree identity type and codecs live in the shared kernel
// (MOD-SHARED-KERNEL, ARCH-CHANGE-002); re-exported here so existing
// consumers keep their import paths.
import type { WorktreeKey } from '../worktreeIdentity';
export type { WorktreeKey } from '../worktreeIdentity';
export {
    cloneWorktreeKey,
    worktreeKeysEqual,
    worktreeKeysMatch,
    worktreeKeyToString,
    worktreeKeyTombstoneKey,
} from '../worktreeIdentity';
