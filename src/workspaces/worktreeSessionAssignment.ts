'use strict';

import * as path from 'path';
import type {
    WorktreeGitSnapshot,
    WorktreeKey,
    WorktreeRepositorySnapshot,
    WorktreeSnapshot,
} from '../worktrees/types';
import { worktreeKeysEqual } from '../worktrees/types';
import {
    getWorkspaceHostPathComparisonKey,
    isWorkspaceHostPathContained,
    normalizeWorkspaceHostPath,
} from './sessionAssignment';
import type { OpenWorkspace, WorkspaceRoot } from './types';

export interface WorkspaceWorktreeAssignment {
    repository: WorktreeRepositorySnapshot;
    worktree: WorktreeGitSnapshot;
    root: WorkspaceRoot | null;
    mappedRootPath: string | null;
}

export function getWorkspaceWorktreeCandidatePaths(
    workspace: OpenWorkspace | null,
    snapshot?: WorktreeSnapshot | null,
): string[] {
    const candidates = (workspace?.roots || [])
        .slice()
        .sort((left, right) => left.ordinal - right.ordinal)
        .map(root => root.hostPath);
    for (const repository of getWorkspaceRepositories(workspace, snapshot)) {
        for (const worktree of repository.worktrees) {
            if (!worktree.isBare) {
                candidates.push(worktree.key.canonicalWorktreePath);
            }
        }
    }
    const seen = new Set<string>();
    return candidates
        .map(normalizeWorkspaceHostPath)
        .filter(candidatePath => {
            const key = getWorkspaceHostPathComparisonKey(candidatePath);
            if (!key || seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
}

export function assignPathToWorkspaceWorktree(
    candidatePath: string,
    workspace: OpenWorkspace,
    snapshot?: WorktreeSnapshot | null,
    exactKey?: WorktreeKey,
): WorkspaceWorktreeAssignment | null {
    const candidates: Array<{
        repository: WorktreeRepositorySnapshot;
        worktree: WorktreeGitSnapshot;
    }> = [];
    for (const repository of getWorkspaceRepositories(workspace, snapshot)) {
        for (const worktree of repository.worktrees) {
            if (!worktree.isBare) {
                candidates.push({ repository, worktree });
            }
        }
    }
    const matched = exactKey
        ? candidates.find(candidate => worktreeKeysEqual(candidate.worktree.key, exactKey))
        : candidates
            .filter(candidate => isWorkspaceHostPathContained(
                candidate.worktree.key.canonicalWorktreePath,
                candidatePath,
            ))
            .sort((left, right) => normalizeWorkspaceHostPath(
                right.worktree.key.canonicalWorktreePath
            ).length - normalizeWorkspaceHostPath(
                left.worktree.key.canonicalWorktreePath
            ).length)[0];
    if (!matched) {
        return null;
    }

    const boundRoots = matched.repository.rootBindings
        .map(binding => {
            const root = workspace.roots.find(candidate => candidate.id === binding.workspaceRootId);
            const mappedRootPath = root
                ? mapRepositoryRelativePath(
                    matched.worktree.key.canonicalWorktreePath,
                    binding.repositoryRelativePath,
                )
                : null;
            return { root, mappedRootPath };
        })
        .filter((candidate): candidate is { root: WorkspaceRoot; mappedRootPath: string } =>
            !!candidate.root
            && !!candidate.mappedRootPath);
    const rootMatches = boundRoots
        .filter(candidate => isWorkspaceHostPathContained(candidate.mappedRootPath, candidatePath))
        .sort((left, right) => right.mappedRootPath.length - left.mappedRootPath.length
            || left.root.ordinal - right.root.ordinal);
    const fallbackRoot = exactKey
        ? boundRoots.slice().sort((left, right) => left.root.ordinal - right.root.ordinal)[0]
        : undefined;
    return {
        repository: matched.repository,
        worktree: matched.worktree,
        root: rootMatches[0]?.root || fallbackRoot?.root || null,
        mappedRootPath: rootMatches[0]?.mappedRootPath || fallbackRoot?.mappedRootPath || null,
    };
}

function getWorkspaceRepositories(
    workspace: OpenWorkspace | null,
    snapshot?: WorktreeSnapshot | null,
): readonly WorktreeRepositorySnapshot[] {
    if (!workspace || !snapshot) {
        return [];
    }
    const rootIds = new Set(workspace.roots.map(root => root.id));
    return snapshot.repositories.filter(repository =>
        repository.rootBindings.some(binding => rootIds.has(binding.workspaceRootId)));
}

function mapRepositoryRelativePath(worktreePath: string, relativePath: string): string | null {
    const normalizedWorktreePath = normalizeWorkspaceHostPath(worktreePath);
    if (!normalizedWorktreePath) {
        return null;
    }
    const pathApi = /^[a-zA-Z]:[\\/]/.test(normalizedWorktreePath)
        || normalizedWorktreePath.startsWith('\\\\')
        ? path.win32
        : path.posix;
    const normalizedRelativePath = pathApi.normalize(relativePath || '.');
    if (pathApi.isAbsolute(normalizedRelativePath)
        || normalizedRelativePath === '..'
        || normalizedRelativePath.startsWith(`..${pathApi.sep}`)) {
        return null;
    }
    return normalizeWorkspaceHostPath(pathApi.join(normalizedWorktreePath, normalizedRelativePath));
}
