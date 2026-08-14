'use strict';

import * as path from 'path';
import { URL } from 'url';
import type { AiSessionDirectoryScope } from '../aiSessions/types';
import {
    assignPathToWorkspaceRoot,
    getWorkspaceHostPathComparisonKey,
    isWorkspaceHostPathContained,
    normalizeWorkspaceHostPath,
} from './sessionAssignment';
import type { OpenWorkspace, RepositoryRootBinding, WorkspaceRoot } from './types';
import type { WorktreeKey } from '../worktrees/types';

export interface ActiveEditorUri {
    fsPath: string;
}

export interface PrimaryWorkspaceRootSelectionOptions {
    explicitRootId?: string;
    activeEditorUri?: ActiveEditorUri | string | null;
    lastUsedRootId?: string;
}

export interface AiSessionDirectoryScopeOptions extends PrimaryWorkspaceRootSelectionOptions {
    isDirectory: (hostPath: string) => boolean;
    primaryCwd?: string;
    worktree?: {
        key: WorktreeKey;
        rootBindings: readonly RepositoryRootBinding[];
        /**
         * Other ready group members' worktree paths (PRD §5.5): a group
         * session writes every member worktree, not just its cwd repository.
         */
        extraWritableHostPaths?: readonly string[];
    };
}

export interface InvalidWorkspaceRoot {
    id: string;
    name: string;
}

export class WorkspaceDirectoryScopeError extends Error {
    readonly invalidRoots: InvalidWorkspaceRoot[];

    constructor(invalidRoots: readonly InvalidWorkspaceRoot[]) {
        const copiedRoots = invalidRoots.map(root => Object.freeze({ id: root.id, name: root.name }));
        super(`Workspace roots are unavailable: ${copiedRoots.map(root => `${root.name} (${root.id})`).join(', ')}`);
        this.name = 'WorkspaceDirectoryScopeError';
        this.invalidRoots = Object.freeze(copiedRoots.slice()) as InvalidWorkspaceRoot[];
        Object.setPrototypeOf(this, WorkspaceDirectoryScopeError.prototype);
    }
}

function getActiveEditorHostPath(uri: ActiveEditorUri | string | null | undefined): string {
    if (!uri) {
        return '';
    }
    if (typeof uri !== 'string') {
        return uri.fsPath || '';
    }
    if (!uri.includes('://')) {
        return uri;
    }

    try {
        let uriPath = decodeURIComponent(new URL(uri).pathname);
        if (/^\/[a-zA-Z]:\//.test(uriPath)) {
            uriPath = uriPath.substring(1);
        }
        return uriPath;
    } catch (error) {
        return '';
    }
}

function getFirstWorkspaceRoot(roots: readonly WorkspaceRoot[]): WorkspaceRoot | null {
    return (roots || [])
        .map((root, index) => ({ root, index }))
        .sort((left, right) => (left.root.ordinal - right.root.ordinal) || (left.index - right.index))[0]?.root
        || null;
}

export function selectPrimaryWorkspaceRoot(
    workspace: OpenWorkspace,
    options: PrimaryWorkspaceRootSelectionOptions = {},
): WorkspaceRoot | null {
    const roots = (workspace?.roots || []).slice();
    const explicitRoot = roots.find(root => root.id === options.explicitRootId);
    if (explicitRoot) {
        return explicitRoot;
    }

    const activeEditorRoot = assignPathToWorkspaceRoot(getActiveEditorHostPath(options.activeEditorUri), roots);
    if (activeEditorRoot) {
        return activeEditorRoot;
    }

    const lastUsedRoot = roots.find(root => root.id === options.lastUsedRootId);
    return lastUsedRoot || getFirstWorkspaceRoot(roots);
}

function isAbsoluteHostPath(value: string): boolean {
    return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

export function buildAiSessionDirectoryScope(
    workspace: OpenWorkspace,
    options: AiSessionDirectoryScopeOptions,
): AiSessionDirectoryScope {
    const roots = (workspace?.roots || []).slice();
    const normalizedRoots = roots.map(root => ({
        root,
        hostPath: normalizeWorkspaceHostPath(root.hostPath),
    }));
    const invalidRoots = normalizedRoots
        .filter(candidate => {
            if (!candidate.hostPath || !isAbsoluteHostPath(candidate.hostPath)) {
                return true;
            }
            try {
                return !options?.isDirectory(candidate.hostPath);
            } catch (error) {
                return true;
            }
        })
        .map(candidate => ({ id: candidate.root.id, name: candidate.root.name }));

    if (invalidRoots.length) {
        throw new WorkspaceDirectoryScopeError(invalidRoots);
    }

    const worktreeRootBindings = buildWorktreeRootBindingMap(
        options.worktree?.key.repositoryKey,
        options.worktree?.key.canonicalWorktreePath,
        options.worktree?.rootBindings,
        roots
    );
    const invalidWorktreeRoots = normalizedRoots.filter(candidate => {
        const mappedPath = worktreeRootBindings.get(candidate.root.id);
        if (!mappedPath) {
            return false;
        }
        try {
            return !options.isDirectory(mappedPath);
        } catch (_error) {
            return true;
        }
    });
    if (invalidWorktreeRoots.length) {
        throw new WorkspaceDirectoryScopeError(invalidWorktreeRoots.map(candidate => ({
            id: candidate.root.id,
            name: candidate.root.name,
        })));
    }
    const normalizedPrimaryCwd = normalizeWorkspaceHostPath(options.primaryCwd || '');
    const historicalRoot = normalizedPrimaryCwd
        ? assignPathToWorkspaceRoot(normalizedPrimaryCwd, roots)
        : null;
    const historicalWorktreeRoot = !historicalRoot && normalizedPrimaryCwd
        ? normalizedRoots
            .filter(candidate => {
                const mappedPath = worktreeRootBindings.get(candidate.root.id);
                return !!mappedPath && isWorkspaceHostPathContained(mappedPath, normalizedPrimaryCwd);
            })
            .sort((left, right) => {
                const leftPath = worktreeRootBindings.get(left.root.id) || '';
                const rightPath = worktreeRootBindings.get(right.root.id) || '';
                return rightPath.length - leftPath.length
                    || left.root.ordinal - right.root.ordinal;
            })[0]?.root || null
        : null;
    const primaryRoot = historicalRoot
        || historicalWorktreeRoot
        || selectPrimaryWorkspaceRoot(workspace, options);
    if (!primaryRoot) {
        throw new WorkspaceDirectoryScopeError([]);
    }

    const primaryRootHostPath = normalizedRoots
        .find(candidate => candidate.root.id === primaryRoot.id)?.hostPath || '';
    const primaryWorktreePath = worktreeRootBindings.get(primaryRoot.id);
    if (options.worktree && !primaryWorktreePath) {
        throw new WorkspaceDirectoryScopeError([{ id: primaryRoot.id, name: primaryRoot.name }]);
    }
    const primaryCwd = historicalWorktreeRoot
        ? normalizedPrimaryCwd
        : primaryWorktreePath
        || (historicalRoot ? normalizedPrimaryCwd : primaryRootHostPath);
    const seenPaths = new Set<string>();
    const workspaceRootHostPaths = normalizedRoots.reduce((result, candidate) => {
        const comparablePath = getWorkspaceHostPathComparisonKey(candidate.hostPath);
        if (!seenPaths.has(comparablePath)) {
            seenPaths.add(comparablePath);
            result.push(candidate.hostPath);
        }
        return result;
    }, [] as string[]);
    const primaryRootComparisonKey = getWorkspaceHostPathComparisonKey(primaryRootHostPath);
    const additionalDirectories = workspaceRootHostPaths.filter(
        hostPath => getWorkspaceHostPathComparisonKey(hostPath) !== primaryRootComparisonKey
    );
    // Strict worktree isolation (docs/worktree-tasks-prd.md §5.5): a worktree
    // session may write only the mapped paths of roots bound to its
    // repository. Roots of other repositories no longer fall back to their
    // main-checkout path, so a session can never write a non-member
    // repository's main checkout.
    const extraWritableHostPaths = normalizeExtraWritableHostPaths(
        options.worktree?.extraWritableHostPaths);
    const writableRootHostPaths = options.worktree
        ? dedupeHostPaths(normalizedRoots
            .map(candidate => worktreeRootBindings.get(candidate.root.id))
            .filter((hostPath): hostPath is string => !!hostPath)
            .concat(extraWritableHostPaths))
        : workspaceRootHostPaths;
    const writablePrimaryComparisonKey = getWorkspaceHostPathComparisonKey(
        primaryWorktreePath || primaryCwd
    );
    const writableAdditionalDirectories = writableRootHostPaths.filter(
        hostPath => getWorkspaceHostPathComparisonKey(hostPath) !== writablePrimaryComparisonKey
    );

    return Object.freeze({
        workspaceNavigationIdentity: workspace.navigationIdentity,
        workspaceScopeIdentity: workspace.scopeIdentity,
        workspaceRootHostPaths: Object.freeze(workspaceRootHostPaths.slice()) as string[],
        ...(options.worktree ? {
            writableRootHostPaths: Object.freeze(writableRootHostPaths.slice()) as string[],
            worktreeKey: Object.freeze({ ...options.worktree.key }),
            isolatedRoots: true,
        } : {}),
        primaryRootId: primaryRoot.id,
        primaryCwd,
        additionalDirectories: Object.freeze(
            (options.worktree ? writableAdditionalDirectories : additionalDirectories).slice()
        ) as string[],
    });
}

function normalizeExtraWritableHostPaths(
    value: readonly string[] | undefined
): string[] {
    if (!value) {
        return [];
    }
    return value.map(candidate => {
        const normalized = normalizeWorkspaceHostPath(candidate || '');
        // Group member paths come from the authoritative manifest; reject
        // anything that is not an absolute, already-normalized host path
        // instead of silently widening or narrowing the session scope.
        if (!normalized || normalized !== candidate || !isAbsoluteHostPath(normalized)) {
            throw new WorkspaceDirectoryScopeError([]);
        }
        return normalized;
    });
}

/**
 * Maps a peer member's visible repository bindings into its worktree, so a
 * group session writes the bound workspace subdirectories — not the whole
 * physical worktree root (review: peer rootBindings must be honored).
 */
export function mapWorktreeBoundHostPaths(
    worktreePath: string,
    bindings: readonly RepositoryRootBinding[],
    roots: readonly WorkspaceRoot[]
): string[] {
    const visibleRootIds = new Set(roots.map(root => root.id));
    const visibleBindings = bindings.filter(binding => visibleRootIds.has(binding.workspaceRootId));
    if (visibleBindings.length === 0) {
        return [];
    }
    const pathApi = /^[a-zA-Z]:[\\/]/.test(worktreePath) || worktreePath.startsWith('\\\\')
        ? path.win32
        : path.posix;
    return visibleBindings.map(binding => {
        const relativePath = normalizeRepositoryRelativePath(binding.repositoryRelativePath);
        if (relativePath === null) {
            throw new WorkspaceDirectoryScopeError([]);
        }
        return normalizeWorkspaceHostPath(
            relativePath ? pathApi.join(worktreePath, relativePath) : worktreePath);
    });
}

function buildWorktreeRootBindingMap(
    repositoryKey: string | undefined,
    worktreePath: string | undefined,
    bindings: readonly RepositoryRootBinding[] | undefined,
    roots: readonly WorkspaceRoot[]
): Map<string, string> {
    if (!repositoryKey && !worktreePath && !bindings) {
        return new Map();
    }
    const normalizedRepositoryKey = normalizeWorkspaceHostPath(repositoryKey || '');
    const normalizedWorktreePath = normalizeWorkspaceHostPath(worktreePath || '');
    if (!normalizedRepositoryKey || !isAbsoluteHostPath(normalizedRepositoryKey)
        || normalizedRepositoryKey !== repositoryKey
        || !normalizedWorktreePath || !isAbsoluteHostPath(normalizedWorktreePath)
        || normalizedWorktreePath !== worktreePath) {
        throw new WorkspaceDirectoryScopeError([]);
    }
    const rootById = new Map(roots.map(root => [root.id, root]));
    const result = new Map<string, string>();
    for (const binding of bindings || []) {
        const root = rootById.get(binding.workspaceRootId);
        const relativePath = normalizeRepositoryRelativePath(binding.repositoryRelativePath);
        if (!root || relativePath === null || result.has(binding.workspaceRootId)) {
            throw new WorkspaceDirectoryScopeError(root ? [{ id: root.id, name: root.name }] : []);
        }
        const pathApi = /^[a-zA-Z]:[\\/]/.test(normalizedWorktreePath) || normalizedWorktreePath.startsWith('\\\\')
            ? path.win32
            : path.posix;
        result.set(binding.workspaceRootId, normalizeWorkspaceHostPath(
            relativePath ? pathApi.join(normalizedWorktreePath, relativePath) : normalizedWorktreePath
        ));
    }
    return result;
}

function normalizeRepositoryRelativePath(value: string): string | null {
    if (typeof value !== 'string' || CONTROL_CHARACTERS.test(value)) {
        return null;
    }
    if (!value || value === '.') {
        return '';
    }
    const pathApi = value.includes('\\') ? path.win32 : path.posix;
    const normalized = pathApi.normalize(value);
    return pathApi.isAbsolute(normalized)
        || normalized === '..'
        || normalized.startsWith(`..${pathApi.sep}`)
        ? null
        : normalized;
}

function dedupeHostPaths(values: readonly string[]): string[] {
    const seen = new Set<string>();
    return values.filter(value => {
        const key = getWorkspaceHostPathComparisonKey(value);
        if (!key || seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
