'use strict';

import * as fs from 'fs';
import type { RunGitCommand } from './gitWorktreeDiscovery';
import { runProvisioningGitCommand } from './gitWorktreeProvisioner';
import type {
    WorktreeGitSnapshot,
    WorktreeKey,
    WorktreeRepositorySnapshot,
    WorktreeSnapshot,
} from './types';
import { worktreeKeysEqual } from './types';

const CONFIRM_ACTION = 'Remove Worktree';

export type ManagedWorktreeRemovalOutcome =
  | { kind: 'succeeded' }
  | { kind: 'cancelled' }
  | { kind: 'partial'; errorCode: string }
  | { kind: 'rejected'; errorCode: string }
  | { kind: 'failed'; errorCode: string };

export interface ManagedWorktreeRemovalControllerOptions {
    getSnapshot: () => WorktreeSnapshot | null;
    isProjectTarget: (projectId: string) => boolean;
    isActive: (key: WorktreeKey) => boolean;
    isOpenWorkspace: (key: WorktreeKey) => boolean;
    isProvisioning: (key: WorktreeKey) => boolean;
    confirm: (message: string, action: string) => PromiseLike<string | undefined>;
    refresh: (removedKey: WorktreeKey) => Promise<void>;
    runGit?: RunGitCommand;
    pathExists?: (candidatePath: string) => Promise<boolean>;
    canonicalizeExistingPath?: (candidatePath: string) => Promise<string>;
}

interface RemovalTarget {
    repository: WorktreeRepositorySnapshot;
    worktree: WorktreeGitSnapshot;
    commandCwd: string;
}

/** Removes only clean, idle, explicitly confirmed Agent Pivot worktrees. */
export class ManagedWorktreeRemovalController {
    private readonly runGit: RunGitCommand;
    private readonly pathExists: (candidatePath: string) => Promise<boolean>;
    private readonly canonicalizeExistingPath: (candidatePath: string) => Promise<string>;
    private readonly pending = new Set<string>();

    constructor(private readonly options: ManagedWorktreeRemovalControllerOptions) {
        this.runGit = options.runGit || runProvisioningGitCommand;
        this.pathExists = options.pathExists || exists;
        this.canonicalizeExistingPath = options.canonicalizeExistingPath
            || canonicalizeExistingPath;
    }

    async remove(projectId: string, key: WorktreeKey): Promise<ManagedWorktreeRemovalOutcome> {
        if (!this.options.isProjectTarget(projectId)) {
            return { kind: 'rejected', errorCode: 'project-unavailable' };
        }
        const token = `${key.repositoryKey}\0${key.canonicalWorktreePath}`;
        if (this.pending.has(token)) {
            return { kind: 'rejected', errorCode: 'operation-running' };
        }
        this.pending.add(token);
        try {
            const initial = this.resolveTarget(key);
            const blocked = await this.getBlocker(initial, key);
            if (blocked) {
                return { kind: 'rejected', errorCode: blocked };
            }
            const branch = initial!.worktree.branchRef?.replace(/^refs\/heads\//u, '')
                || initial!.worktree.head.substring(0, 8);
            const confirmation = await this.options.confirm(
                `Remove the worktree “${branch}” at ${key.canonicalWorktreePath}? `
                    + 'Only clean, idle worktrees can be removed; the local branch is kept.',
                CONFIRM_ACTION
            );
            if (confirmation !== CONFIRM_ACTION) {
                return { kind: 'cancelled' };
            }
            const current = this.resolveTarget(key);
            const currentBlocker = await this.getBlocker(current, key);
            if (currentBlocker) {
                return { kind: 'rejected', errorCode: currentBlocker };
            }
            const result = await this.runGit(current!.commandCwd, [
                '-C', current!.commandCwd,
                'worktree', 'remove', '--', key.canonicalWorktreePath,
            ]);
            if (await this.pathExists(key.canonicalWorktreePath)) {
                return {
                    kind: 'failed',
                    errorCode: result.timedOut ? 'git-timeout' : 'worktree-remove-failed',
                };
            }
            try {
                await this.options.refresh(key);
            } catch (_error) {
                return { kind: 'partial', errorCode: 'worktree-removed-refresh-failed' };
            }
            return { kind: 'succeeded' };
        } catch (_error) {
            return { kind: 'failed', errorCode: 'worktree-remove-failed' };
        } finally {
            this.pending.delete(token);
        }
    }

    private resolveTarget(key: WorktreeKey): RemovalTarget | null {
        const snapshot = this.options.getSnapshot();
        const repository = snapshot?.repositories.find(candidate =>
            candidate.repositoryKey === key.repositoryKey);
        const worktree = repository?.worktrees.find(candidate =>
            worktreeKeysEqual(candidate.key, key));
        if (!repository || !worktree || worktree.isMain || worktree.isBare
            || worktree.health !== 'normal') {
            return null;
        }
        const commandCwd = repository.worktrees.find(candidate =>
            candidate.isMain && !candidate.isBare)?.key.canonicalWorktreePath
            || repository.worktrees.find(candidate => !candidate.isBare
                && !worktreeKeysEqual(candidate.key, key))?.key.canonicalWorktreePath;
        return commandCwd ? { repository, worktree, commandCwd } : null;
    }

    private async getBlocker(target: RemovalTarget | null, key: WorktreeKey): Promise<string | null> {
        if (!target) {
            return 'worktree-not-removable';
        }
        if (this.options.isActive(key)) {
            return 'worktree-active';
        }
        if (this.options.isOpenWorkspace(key)) {
            return 'worktree-open';
        }
        if (this.options.isProvisioning(key)) {
            return 'worktree-provisioning';
        }
        const [status, topLevel, commonDir, branchRef] = await Promise.all([
            this.runGit(key.canonicalWorktreePath, [
                '-C', key.canonicalWorktreePath,
                'status', '--porcelain=v1', '--untracked-files=normal',
            ]),
            this.runGit(key.canonicalWorktreePath, [
                '-C', key.canonicalWorktreePath,
                'rev-parse', '--path-format=absolute', '--show-toplevel',
            ]),
            this.runGit(key.canonicalWorktreePath, [
                '-C', key.canonicalWorktreePath,
                'rev-parse', '--path-format=absolute', '--git-common-dir',
            ]),
            this.runGit(key.canonicalWorktreePath, [
                '-C', key.canonicalWorktreePath,
                'rev-parse', '--symbolic-full-name', 'HEAD',
            ]),
        ]);
        if (status.exitCode !== 0 || status.timedOut
            || topLevel.exitCode !== 0 || commonDir.exitCode !== 0
            || branchRef.exitCode !== 0) {
            return 'worktree-status-failed';
        }
        const expectedBranchRef = target.worktree.branchRef || 'HEAD';
        if (firstLine(branchRef.stdout) !== expectedBranchRef) {
            return 'worktree-identity-changed';
        }
        try {
            const [actualPath, plannedPath, actualRepository, plannedRepository] =
                await Promise.all([
                    this.canonicalizeExistingPath(firstLine(topLevel.stdout)),
                    this.canonicalizeExistingPath(key.canonicalWorktreePath),
                    this.canonicalizeExistingPath(firstLine(commonDir.stdout)),
                    this.canonicalizeExistingPath(key.repositoryKey),
                ]);
            if (actualPath !== plannedPath || actualRepository !== plannedRepository) {
                return 'worktree-identity-changed';
            }
        } catch (_error) {
            return 'worktree-identity-changed';
        }
        if (this.options.isActive(key)) {
            return 'worktree-active';
        }
        if (this.options.isOpenWorkspace(key)) {
            return 'worktree-open';
        }
        if (this.options.isProvisioning(key)) {
            return 'worktree-provisioning';
        }
        return status.stdout.trim() ? 'worktree-dirty' : null;
    }
}

async function exists(candidatePath: string): Promise<boolean> {
    try {
        await fs.promises.lstat(candidatePath);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

async function canonicalizeExistingPath(candidatePath: string): Promise<string> {
    return await fs.promises.realpath(candidatePath);
}

function firstLine(value: string): string {
    return (value || '').split(/\r?\n/u, 1)[0].trim();
}
