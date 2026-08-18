'use strict';

import type { OpenWorkspace } from '../workspaces/types';
import { assignPathToWorkspaceWorktree } from '../worktreeSessionAssignment';
import type {
    WorktreeGitSnapshot,
    WorktreeKey,
    WorktreeRepositorySnapshot,
    WorktreeSnapshot,
} from '../worktrees/types';
import { worktreeKeysEqual } from '../worktrees/types';

export interface AiSessionWorktreeCreationCandidate {
    key: WorktreeKey;
    label: string;
    description: string;
}

export type AiSessionCreationScopeTarget =
  | { kind: 'workspace' }
  | { kind: 'worktree'; key: WorktreeKey };

export type AiSessionWorktreeCreationResolution =
  | { status: 'workspace' }
  | { status: 'selected'; key: WorktreeKey }
  | { status: 'pick'; candidates: AiSessionWorktreeCreationCandidate[] }
  | {
      status: 'blocked';
      reason: 'snapshot-unavailable' | 'no-linked-worktrees' | 'target-unavailable';
  };

interface WorkspaceWorktreeCandidate {
    repository: WorktreeRepositorySnapshot;
    worktree: WorktreeGitSnapshot;
}

/**
 * Resolves the worktree target before provider/profile prompts begin.
 * Display grouping is deliberately absent from the inputs: Flat and Worktree
 * are presentation choices and must never change launch scope.
 */
export function resolveAiSessionWorktreeCreationTarget(options: {
    workspace: OpenWorkspace;
    snapshot?: WorktreeSnapshot | null;
    activeEditorPath?: string | null;
    explicitKey?: WorktreeKey;
}): AiSessionWorktreeCreationResolution {
    if (!options.snapshot) {
        return { status: 'blocked', reason: 'snapshot-unavailable' };
    }
    const repositories = getWorkspaceRepositories(options.workspace, options.snapshot);
    if (repositories.length === 0) {
        return options.explicitKey
            ? { status: 'blocked', reason: 'target-unavailable' }
            : { status: 'workspace' };
    }

    const all = repositories.reduce((candidates, repository) => {
        repository.worktrees.forEach(worktree => candidates.push({ repository, worktree }));
        return candidates;
    }, [] as WorkspaceWorktreeCandidate[]);
    const usable = all.filter(candidate => isLaunchableWorktree(candidate.worktree));

    if (options.explicitKey) {
        const selected = usable.find(candidate =>
            worktreeKeysEqual(candidate.worktree.key, options.explicitKey!));
        return selected
            ? { status: 'selected', key: { ...selected.worktree.key } }
            : { status: 'blocked', reason: 'target-unavailable' };
    }

    if (options.activeEditorPath) {
        const active = assignPathToWorkspaceWorktree(
            options.activeEditorPath,
            options.workspace,
            options.snapshot,
        );
        if (active && isLaunchableWorktree(active.worktree)) {
            return { status: 'selected', key: { ...active.worktree.key } };
        }
    }

    if (usable.length === 1) {
        return { status: 'selected', key: { ...usable[0].worktree.key } };
    }
    if (usable.length === 0) {
        return { status: 'blocked', reason: 'no-linked-worktrees' };
    }
    return {
        status: 'pick',
        candidates: usable.map(candidate => ({
            key: { ...candidate.worktree.key },
            label: getWorktreeLabel(candidate.worktree),
            description: candidate.worktree.key.canonicalWorktreePath,
        })),
    };
}

/** Accepts only the exact Webview-to-Host WorktreeKey wire shape. */
export function parseAiSessionCreationWorktreeKey(value: unknown): WorktreeKey | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.length !== 2
        || keys[0] !== 'canonicalWorktreePath'
        || keys[1] !== 'repositoryKey'
        || typeof record.repositoryKey !== 'string'
        || !record.repositoryKey
        || typeof record.canonicalWorktreePath !== 'string'
        || !record.canonicalWorktreePath) {
        return null;
    }
    return {
        repositoryKey: record.repositoryKey,
        canonicalWorktreePath: record.canonicalWorktreePath,
    };
}

function getWorkspaceRepositories(
    workspace: OpenWorkspace,
    snapshot: WorktreeSnapshot | null | undefined,
): readonly WorktreeRepositorySnapshot[] {
    if (!snapshot) {
        return [];
    }
    const rootIds = new Set(workspace.roots.map(root => root.id));
    return snapshot.repositories.filter(repository =>
        repository.rootBindings.some(binding => rootIds.has(binding.workspaceRootId)));
}

function isLaunchableWorktree(worktree: WorktreeGitSnapshot): boolean {
    return !worktree.isBare
        && worktree.health !== 'missing'
        && worktree.health !== 'prunable';
}

function getWorktreeLabel(worktree: WorktreeGitSnapshot): string {
    if (worktree.branchRef) {
        return worktree.branchRef.replace(/^refs\/heads\//u, '');
    }
    const pathName = worktree.key.canonicalWorktreePath
        .replace(/[\\/]+$/u, '')
        .split(/[\\/]/u)
        .pop();
    return pathName || worktree.head.substring(0, 8) || 'worktree';
}
