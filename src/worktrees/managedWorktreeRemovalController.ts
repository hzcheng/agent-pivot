'use strict';

import * as fs from 'fs';
import * as path from 'path';
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
    refresh: (removedKey: WorktreeKey, workspaceIdentity: string | null) => Promise<void>;
    /**
     * Resolves the manifest bucket when the removal starts, so a workspace
     * switch mid-operation cannot retire the wrong workspace's records.
     */
    getWorkspaceIdentity?: (projectId: string) => string | null;
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
        const workspaceIdentity = this.options.getWorkspaceIdentity?.(projectId) ?? null;
        try {
            const initial = this.resolveTarget(key);
            const snapshotWorktree = this.options.getSnapshot()?.repositories
                .find(candidate => candidate.repositoryKey === key.repositoryKey)
                ?.worktrees.find(candidate => worktreeKeysEqual(candidate.key, key));
            // These in-memory guards are instantaneous and avoid presenting
            // a destructive confirmation for a target the dashboard already
            // knows cannot be removed. The Git-backed checks remain after
            // confirmation below, where they also catch races.
            if (this.options.isActive(key)) {
                return { kind: 'rejected', errorCode: 'worktree-active' };
            }
            if (this.options.isOpenWorkspace(key)) {
                return { kind: 'rejected', errorCode: 'worktree-open' };
            }
            if (this.options.isProvisioning(key)) {
                return { kind: 'rejected', errorCode: 'worktree-provisioning' };
            }
            // A confirmation may only describe a currently removable
            // worktree, except for an explicitly discovered stale entry
            // whose missing directory needs record cleanup. Do not let a
            // protocol-valid but otherwise arbitrary absolute path produce a
            // misleading destructive dialog.
            if (!initial && (!isStaleMissingWorktree(snapshotWorktree)
                || await this.pathExists(key.canonicalWorktreePath))) {
                return { kind: 'rejected', errorCode: 'worktree-not-removable' };
            }
            // The confirm label tolerates a stale/prunable snapshot entry:
            // a worktree whose directory is already gone still needs a
            // readable name in the dialog. Do not put the Git safety check
            // ahead of this dialog: a slow filesystem or Git process made a
            // click appear to do nothing for up to its timeout. The full
            // check below remains immediately before the destructive command.
            const branch = (initial?.worktree || snapshotWorktree)?.branchRef
                ?.replace(/^refs\/heads\//u, '')
                || initial?.worktree.head.substring(0, 8)
                || path.basename(key.canonicalWorktreePath);
            const confirmation = await this.options.confirm(
                `Remove the worktree “${branch}” at ${key.canonicalWorktreePath}? `
                    + 'Only clean, idle worktrees can be removed; the local branch is kept.',
                CONFIRM_ACTION
            );
            if (confirmation !== CONFIRM_ACTION) {
                return { kind: 'cancelled' };
            }
            const current = this.resolveTarget(key);
            // Bind the destructive action to the exact snapshot identity the
            // user confirmed. A refresh cannot substitute a different
            // worktree at the same path while the native dialog is open.
            if ((initial && (!current
                || !sameWorktreeIdentity(initial.worktree, current.worktree)))
                || (!initial && current)) {
                return { kind: 'rejected', errorCode: 'worktree-identity-changed' };
            }
            const currentBlocker = await this.getBlocker(current, key, initial?.worktree);
            if (currentBlocker) {
                return { kind: 'rejected', errorCode: currentBlocker };
            }
            if (!(await this.pathExists(key.canonicalWorktreePath))) {
                // The directory vanished (or was never there): prune stale
                // git metadata and succeed — only record cleanup remains.
                await this.pruneStaleMetadata(key);
                try {
                    await this.options.refresh(key, workspaceIdentity);
                } catch (_error) {
                    return { kind: 'partial', errorCode: 'worktree-removed-refresh-failed' };
                }
                return { kind: 'succeeded' };
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
                await this.options.refresh(key, workspaceIdentity);
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

    /**
     * Read-only blocker check for one worktree (no confirmation, no side
     * effects). Used by the journaled group-deletion flow (PRD §6.4) for
     * its admission-time and execution-time rechecks.
     */
    getRemovalBlocker(key: WorktreeKey): Promise<string | null> {
        return this.getBlocker(this.resolveTarget(key), key);
    }

    /**
     * Verified physical removal without confirmation or view refresh, for
     * the journaled group-deletion flow: the caller owns the journal and
     * all publication; this performs the same blocker check, git removal,
     * and post-removal path verification as the interactive flow.
     */
    async removeVerified(
        key: WorktreeKey
    ): Promise<{ kind: 'removed' } | { kind: 'failed'; errorCode: string }> {
        if (!(await this.pathExists(key.canonicalWorktreePath))) {
            // The directory is already gone (deleted externally): prune the
            // stale git administrative entry and report the verified
            // absence — a missing path is a certain observation, so record
            // cleanup must not fail-closed (PRD §6.4).
            await this.pruneStaleMetadata(key);
            return { kind: 'removed' };
        }
        const target = this.resolveTarget(key);
        const blocker = await this.getBlocker(target, key);
        if (blocker) {
            return { kind: 'failed', errorCode: blocker };
        }
        try {
            const result = await this.runGit(target!.commandCwd, [
                '-C', target!.commandCwd,
                'worktree', 'remove', '--', key.canonicalWorktreePath,
            ]);
            if (await this.pathExists(key.canonicalWorktreePath)) {
                return {
                    kind: 'failed',
                    errorCode: result.timedOut ? 'git-timeout' : 'worktree-remove-failed',
                };
            }
            return { kind: 'removed' };
        } catch (_error) {
            return { kind: 'failed', errorCode: 'worktree-remove-failed' };
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

    /**
     * Best-effort cleanup of the git administrative entry after the
     * worktree directory disappeared externally. Skipped silently when the
     * repository itself is out of view — the path is already gone either
     * way.
     */
    private async pruneStaleMetadata(key: WorktreeKey): Promise<void> {
        const snapshot = this.options.getSnapshot();
        const repository = snapshot?.repositories.find(candidate =>
            candidate.repositoryKey === key.repositoryKey);
        const commandCwd = repository?.worktrees.find(candidate =>
            candidate.isMain && !candidate.isBare)?.key.canonicalWorktreePath
            || repository?.worktrees.find(candidate => !candidate.isBare)
                ?.key.canonicalWorktreePath;
        if (!commandCwd) {
            return;
        }
        try {
            await this.runGit(commandCwd, ['-C', commandCwd, 'worktree', 'prune']);
        } catch (_error) { /* best-effort */ }
    }

    private async getBlocker(
        target: RemovalTarget | null,
        key: WorktreeKey,
        expectedWorktree: WorktreeGitSnapshot | undefined = target?.worktree,
    ): Promise<string | null> {
        if (!target) {
            // A physically absent directory is a certain observation:
            // nothing blocks the removal; only record cleanup remains.
            // Anything else (detached repository, truncated discovery)
            // stays fail-closed.
            if (!(await this.pathExists(key.canonicalWorktreePath))) {
                return null;
            }
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
        if (!expectedWorktree || !sameWorktreeIdentity(target.worktree, expectedWorktree)) {
            return 'worktree-identity-changed';
        }
        const [topLevel, commonDir] = await Promise.all([
            this.runGit(key.canonicalWorktreePath, [
                '-C', key.canonicalWorktreePath,
                'rev-parse', '--path-format=absolute', '--show-toplevel',
            ]),
            this.runGit(key.canonicalWorktreePath, [
                '-C', key.canonicalWorktreePath,
                'rev-parse', '--path-format=absolute', '--git-common-dir',
            ]),
        ]);
        if (topLevel.exitCode !== 0 || commonDir.exitCode !== 0) {
            return 'worktree-status-failed';
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
        // Read cleanliness, branch and HEAD together only after all slower
        // path/runtime checks. A separate status + symbolic-ref + rev-parse
        // sequence can splice observations from two checkouts when a user
        // switches worktrees in the middle of the preflight.
        const status = await this.runGit(key.canonicalWorktreePath, [
            '-C', key.canonicalWorktreePath,
            'status', '--porcelain=v2', '--branch', '--untracked-files=normal',
        ]);
        if (status.exitCode !== 0 || status.timedOut) {
            return 'worktree-status-failed';
        }
        const observed = parseStatusIdentity(status.stdout, expectedWorktree.head);
        const expectedBranchRef = expectedWorktree.branchRef || 'HEAD';
        if (!observed) {
            return 'worktree-status-failed';
        }
        if (observed.branchRef !== expectedBranchRef || observed.head !== expectedWorktree.head) {
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
        return observed.dirty ? 'worktree-dirty' : null;
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

function isStaleMissingWorktree(
    worktree: WorktreeGitSnapshot | undefined
): worktree is WorktreeGitSnapshot {
    return !!worktree && !worktree.isMain && !worktree.isBare
        && (worktree.health === 'missing' || worktree.health === 'prunable');
}

function sameWorktreeIdentity(
    left: WorktreeGitSnapshot,
    right: WorktreeGitSnapshot,
): boolean {
    return worktreeKeysEqual(left.key, right.key)
        && left.branchRef === right.branchRef
        && left.head === right.head
        && left.headKind === right.headKind
        && left.isMain === right.isMain
        && left.isBare === right.isBare
        && left.health === right.health;
}

function parseStatusIdentity(value: string, expectedHead: string): {
    branchRef: string;
    head: string;
    dirty: boolean;
} | null {
    let branchHead: string | null = null;
    let head: string | null = null;
    let dirty = false;
    for (const line of (value || '').split(/\r?\n/u)) {
        if (line.startsWith('# branch.head ')) {
            branchHead = line.slice('# branch.head '.length).trim();
        } else if (line.startsWith('# branch.oid ')) {
            head = line.slice('# branch.oid '.length).trim();
        } else if (line && !line.startsWith('# ')) {
            dirty = true;
        }
    }
    if (head === '(initial)') {
        if (!/^0{40}(?:0{24})?$/u.test(expectedHead)) {
            return null;
        }
        head = '0'.repeat(expectedHead.length);
    }
    if (!branchHead || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(head || '')) {
        return null;
    }
    return {
        branchRef: branchHead === '(detached)' ? 'HEAD' : `refs/heads/${branchHead}`,
        head: head as string,
        dirty,
    };
}
