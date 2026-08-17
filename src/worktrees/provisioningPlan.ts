'use strict';

import * as path from 'path';
import { createHash } from 'crypto';
import type { MemberBaseline, WorktreeRepositorySnapshot } from './types';

const MAX_TASK_NAME_LENGTH = 200;
const MAX_SUFFIX = 999;

export interface WorktreeProvisioningPlan {
    repositoryKey: string;
    commandCwd: string;
    baseRef: string;
    taskName: string;
    slug: string;
    branchName: string;
    worktreePath: string;
    /**
     * Frozen task-start anchor (changes-panel PRD §4.2): resolved from
     * `baseRef` before any physical side effect; `git worktree add` uses
     * this SHA so a base branch advancing mid-provisioning can never
     * silently move the member's starting point.
     */
    baseline?: MemberBaseline;
}

export interface WorktreeProvisioningPlanOptions {
    repository: WorktreeRepositorySnapshot;
    taskName: string;
    /** Branch from this ref instead of the repository default base ref. */
    baseRefOverride?: string;
    /** Directory (relative to the repository root) that holds managed worktrees. */
    worktreeDirectory?: string;
    isBranchAvailable: (branchName: string) => boolean | Promise<boolean>;
    isPathAvailable: (worktreePath: string) => boolean | Promise<boolean>;
    reservedBranches?: ReadonlySet<string>;
    reservedPaths?: ReadonlySet<string>;
}

export class WorktreeProvisioningPlanError extends Error {
    constructor(readonly code: 'invalid-task' | 'base-ref-unavailable' | 'allocation-exhausted') {
        super(code);
        this.name = 'WorktreeProvisioningPlanError';
        Object.setPrototypeOf(this, WorktreeProvisioningPlanError.prototype);
    }
}

/** Atomically chooses one suffix shared by the branch and managed path. */
export async function createWorktreeProvisioningPlan(
    options: WorktreeProvisioningPlanOptions
): Promise<WorktreeProvisioningPlan> {
    const taskName = normalizeTaskName(options.taskName);
    const slug = slugifyTaskName(taskName);
    if (!taskName || !slug) {
        throw new WorktreeProvisioningPlanError('invalid-task');
    }
    const baseRef = options.baseRefOverride ?? options.repository.baseRef;
    if (!baseRef || baseRef.startsWith('-') || /[\0\r\n]/u.test(baseRef)) {
        throw new WorktreeProvisioningPlanError('base-ref-unavailable');
    }
    const commandCwd = options.repository.worktrees.find(worktree =>
        worktree.isMain && !worktree.isBare)?.key.canonicalWorktreePath
        || options.repository.worktrees.find(worktree => !worktree.isBare)?.key.canonicalWorktreePath;
    if (!commandCwd) {
        throw new WorktreeProvisioningPlanError('base-ref-unavailable');
    }
    const pathApi = getPathApi(commandCwd);
    const repositoryRoot = getManagedRepositoryRoot(options.repository.repositoryKey, pathApi);
    const managedRoot = pathApi.join(
        repositoryRoot,
        normalizeWorktreeDirectory(options.worktreeDirectory)
    );
    for (let suffix = 1; suffix <= MAX_SUFFIX; suffix += 1) {
        const candidateSlug = suffix === 1 ? slug : `${slug}-${suffix}`;
        const branchName = `agent-pivot/${candidateSlug}`;
        const worktreePath = pathApi.join(managedRoot, candidateSlug);
        if (options.reservedBranches?.has(branchName)
            || options.reservedPaths?.has(worktreePath)) {
            continue;
        }
        const [branchAvailable, pathAvailable] = await Promise.all([
            options.isBranchAvailable(branchName),
            options.isPathAvailable(worktreePath),
        ]);
        if (branchAvailable && pathAvailable) {
            return {
                repositoryKey: options.repository.repositoryKey,
                commandCwd,
                baseRef,
                taskName,
                slug: candidateSlug,
                branchName,
                worktreePath,
            };
        }
    }
    throw new WorktreeProvisioningPlanError('allocation-exhausted');
}

export function slugifyTaskName(value: string): string {
    const normalizedTaskName = normalizeTaskName(value);
    if (!normalizedTaskName) {
        return '';
    }
    const slug = normalizedTaskName
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/gu, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-+|-+$/gu, '')
        .replace(/-{2,}/gu, '-')
        .slice(0, 60)
        .replace(/-+$/gu, '');
    // PRD §5.2: fewer than 3 usable ASCII characters (typical: CJK-only
    // names) fall back to a deterministic task-<6-char id> suggestion.
    return slug.length >= 3
        ? slug
        : `task-${createHash('sha256').update(normalizedTaskName).digest('hex').slice(0, 6)}`;
}

function normalizeTaskName(value: string): string {
    return typeof value === 'string'
        ? value.trim().replace(/\s+/gu, ' ').slice(0, MAX_TASK_NAME_LENGTH)
        : '';
}

function getPathApi(value: string): typeof path.posix | typeof path.win32 {
    return /^[a-zA-Z]:[\\/]/u.test(value) || value.startsWith('\\\\')
        ? path.win32
        : path.posix;
}

function getManagedRepositoryRoot(
    repositoryKey: string,
    pathApi: typeof path.posix | typeof path.win32
): string {
    const baseName = pathApi.basename(repositoryKey);
    if (baseName === '.git') {
        return pathApi.dirname(repositoryKey);
    }
    if (baseName.toLowerCase().endsWith('.git') && baseName.length > 4) {
        return pathApi.join(pathApi.dirname(repositoryKey), baseName.slice(0, -4));
    }
    return pathApi.dirname(repositoryKey);
}

export const DEFAULT_WORKTREE_DIRECTORY = '.worktrees';
// Worktrees created before the directory became configurable live here;
// they stay manageable so removal and recovery keep working for them.
const LEGACY_WORKTREE_DIRECTORIES = ['.agent-pivot/worktrees'];

/** Resolves the configured managed-worktree directory, falling back to the default. */
export function normalizeWorktreeDirectory(value: unknown): string {
    if (typeof value !== 'string') {
        return DEFAULT_WORKTREE_DIRECTORY;
    }
    const trimmed = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (!trimmed || trimmed === '.' || /[\0\r\n]/u.test(trimmed)
        || trimmed.startsWith('/') || /^[a-zA-Z]:/u.test(trimmed)
        || trimmed.split('/').some(segment => segment === '..')) {
        return DEFAULT_WORKTREE_DIRECTORY;
    }
    return trimmed;
}

function getManagedWorktreeRoots(
    repositoryKey: string,
    pathApi: typeof path.posix | typeof path.win32,
    directory?: string
): string[] {
    const repositoryRoot = getManagedRepositoryRoot(repositoryKey, pathApi);
    const directories = [
        normalizeWorktreeDirectory(directory),
        DEFAULT_WORKTREE_DIRECTORY,
        ...LEGACY_WORKTREE_DIRECTORIES,
    ];
    return [...new Set(directories)].map(entry => pathApi.join(repositoryRoot, entry));
}

export function isManagedWorktreePath(
    repositoryKey: string,
    worktreePath: string,
    directory?: string
): boolean {
    if (!repositoryKey || !worktreePath) {
        return false;
    }
    const pathApi = getPathApi(repositoryKey);
    return getManagedWorktreeRoots(repositoryKey, pathApi, directory).some(managedRoot => {
        const relative = pathApi.relative(managedRoot, worktreePath);
        return !!relative && relative !== '..' && !relative.startsWith(`..${pathApi.sep}`)
            && !pathApi.isAbsolute(relative) && !relative.includes(pathApi.sep);
    });
}
