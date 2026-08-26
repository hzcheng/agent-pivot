'use strict';

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import type { GitCommandResult, RunGitCommand } from './gitWorktreeDiscovery';
import type { WorktreeProvisioningPlan } from './provisioningPlan';
import type { MemberBaseline, WorktreeKey } from './types';
import { isBaselineCommitSha } from './baseline';

const MAX_GIT_ERROR_LENGTH = 512;
const PROVISIONING_GIT_TIMEOUT_MS = 60_000;
const PROVISIONING_GIT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export type GitWorktreeProvisioningErrorCode =
  | 'cancelled'
  | 'invalid-plan'
  | 'repository-has-no-commits'
  | 'branch-conflict'
  | 'path-conflict'
  | 'git-timeout'
  | 'worktree-create-failed';

export class GitWorktreeProvisioningError extends Error {
    constructor(
        readonly code: GitWorktreeProvisioningErrorCode,
        message: string = code,
        readonly retryable = code !== 'invalid-plan'
    ) {
        super(message);
        this.name = 'GitWorktreeProvisioningError';
        Object.setPrototypeOf(this, GitWorktreeProvisioningError.prototype);
    }
}

export interface GitWorktreeProvisionerOptions {
    runGit?: RunGitCommand;
    pathExists?: (candidatePath: string) => Promise<boolean>;
    ensureDirectory?: (directoryPath: string) => Promise<void>;
    canonicalizeExistingPath?: (candidatePath: string) => Promise<string>;
}

/** Owns the bounded, shell-free Git mutations used by worktree provisioning. */
export class GitWorktreeProvisioner {
    private readonly runGit: RunGitCommand;
    private readonly pathExists: (candidatePath: string) => Promise<boolean>;
    private readonly ensureDirectory: (directoryPath: string) => Promise<void>;
    private readonly canonicalizeExistingPath: (candidatePath: string) => Promise<string>;

    constructor(options: GitWorktreeProvisionerOptions = {}) {
        this.runGit = options.runGit || runProvisioningGitCommand;
        this.pathExists = options.pathExists || pathExists;
        this.ensureDirectory = options.ensureDirectory || ensureDirectory;
        this.canonicalizeExistingPath = options.canonicalizeExistingPath
            || canonicalizeExistingPath;
    }

    async isBranchAvailable(commandCwd: string, branchName: string): Promise<boolean> {
        if (!isSafeAbsolutePath(commandCwd) || !isSafeBranchName(branchName)) {
            return false;
        }
        const validation = await this.runGit(commandCwd, [
            '-C', commandCwd, 'check-ref-format', '--branch', branchName,
        ]);
        if (validation.exitCode !== 0) {
            return false;
        }
        const lookup = await this.runGit(commandCwd, [
            '-C', commandCwd, 'show-ref', '--verify', '--quiet',
            `refs/heads/${branchName}`,
        ]);
        if (lookup.exitCode === 0) {
            return false;
        }
        if (lookup.exitCode === 1) {
            return true;
        }
        throw gitFailure('worktree-create-failed', lookup);
    }

    async isPathAvailable(worktreePath: string): Promise<boolean> {
        return isSafeAbsolutePath(worktreePath) && !(await this.pathExists(worktreePath));
    }

    /**
     * Freezes a base ref into an immutable baseline (changes-panel PRD
     * §4.2): resolves `baseRef^{commit}` and classifies the source as
     * branch / tag / commit. Returns undefined when the ref does not
     * resolve to a commit — callers must then refuse to start creation
     * rather than provision from a moving or unknown base.
     */
    async resolveBaseCommit(
        commandCwd: string,
        baseRef: string
    ): Promise<MemberBaseline | undefined> {
        if (!isSafeAbsolutePath(commandCwd) || !isSafeRevision(baseRef)) {
            return undefined;
        }
        const shaResult = await this.runGit(commandCwd, [
            '-C', commandCwd, 'rev-parse', '--verify', '--quiet',
            `${baseRef}^{commit}`,
        ]);
        if (shaResult.exitCode !== 0) {
            return undefined;
        }
        const commitSha = shaResult.stdout.trim();
        if (!isBaselineCommitSha(commitSha)) {
            return undefined;
        }
        const fullRefResult = await this.runGit(commandCwd, [
            '-C', commandCwd, 'rev-parse', '--verify', '--quiet',
            '--symbolic-full-name', baseRef,
        ]);
        const fullRef = fullRefResult.exitCode === 0
            ? fullRefResult.stdout.trim()
            : '';
        let source: MemberBaseline['source'];
        if (fullRef.startsWith('refs/heads/')
            || fullRef.startsWith('refs/remotes/')) {
            source = { kind: 'branch', fullRef };
        } else if (fullRef.startsWith('refs/tags/')) {
            source = { kind: 'tag', fullRef };
        } else {
            source = { kind: 'commit' };
        }
        return { commitSha, capturedAt: Date.now(), source };
    }

    /**
     * Post-creation anchor check (changes-panel PRD §4.2 step 4): the
     * new worktree's HEAD must be the frozen baseline commit. A mismatch
     * means the physical state diverged from the recorded intent.
     */
    async verifyBaselineHead(
        worktreePath: string,
        baseline: MemberBaseline
    ): Promise<boolean> {
        if (!isSafeAbsolutePath(worktreePath)) {
            return false;
        }
        const head = await this.runGit(worktreePath, [
            '-C', worktreePath, 'rev-parse', '--verify', '--quiet', 'HEAD',
        ]);
        return head.exitCode === 0
            && head.stdout.trim() === baseline.commitSha;
    }

    /** Local branches offered as base-ref candidates in the group creation form. */
    async listLocalBranches(commandCwd: string): Promise<string[]> {
        if (!isSafeAbsolutePath(commandCwd)) {
            return [];
        }
        const result = await this.runGit(commandCwd, [
            '-C', commandCwd, 'for-each-ref', '--format=%(refname:strip=2)',
            'refs/heads',
        ]);
        if (result.exitCode !== 0) {
            throw gitFailure('worktree-create-failed', result);
        }
        const branches = result.stdout
            .split('\n')
            .map(line => line.trim())
            .filter(line => line && isSafeBranchName(line));
        // PRD §6.1: 不设上限 — the git output itself is already bounded by
        // the provisioner's 4MB output cap.
        return Array.from(new Set(branches))
            .sort((left, right) => left.localeCompare(right));
    }

    /**
     * Fetched remote-tracking branches offered as base-ref candidates in the
     * group creation form. This is deliberately read-only: selecting one
     * never fetches or creates a local tracking branch.
     */
    async listRemoteBranches(commandCwd: string): Promise<string[]> {
        if (!isSafeAbsolutePath(commandCwd)) {
            return [];
        }
        const result = await this.runGit(commandCwd, [
            '-C', commandCwd, 'for-each-ref', '--format=%(refname:strip=2)',
            'refs/remotes',
        ]);
        if (result.exitCode !== 0) {
            throw gitFailure('worktree-create-failed', result);
        }
        const branches = result.stdout
            .split('\n')
            .map(line => line.trim())
            // origin/HEAD is Git's symbolic remote default, not a branch a
            // user can intentionally select as their task baseline.
            .filter(line => line && !/^[^/]+\/HEAD$/u.test(line) && isSafeBranchName(line));
        return Array.from(new Set(branches))
            .sort((left, right) => left.localeCompare(right));
    }

    /**
     * Read-only gate for the group creation preview (PRD §6.1): validates
     * the plan against the live repository and reports the exact blocker
     * without creating anything.
     */
    async preflightPlan(
        plan: WorktreeProvisioningPlan
    ): Promise<'ok' | GitWorktreeProvisioningErrorCode> {
        try {
            await this.validatePlan(plan);
        } catch (error) {
            return error instanceof GitWorktreeProvisioningError
                ? error.code : 'worktree-create-failed';
        }
        if (!(await this.isBranchAvailable(plan.commandCwd, plan.branchName))) {
            return 'branch-conflict';
        }
        if (!(await this.isPathAvailable(plan.worktreePath))) {
            return 'path-conflict';
        }
        return 'ok';
    }

    async createWorktree(
        plan: WorktreeProvisioningPlan,
        isCancelled: () => boolean
    ): Promise<WorktreeKey> {
        await this.validatePlan(plan);
        if (isCancelled()) {
            throw new GitWorktreeProvisioningError('cancelled');
        }
        const existing = await this.reconcileCreatedWorktree(plan);
        if (existing) {
            await this.assertBaselineHead(plan, existing);
            return existing;
        }
        if (!(await this.isBranchAvailable(plan.commandCwd, plan.branchName))) {
            throw new GitWorktreeProvisioningError('branch-conflict');
        }
        if (!(await this.isPathAvailable(plan.worktreePath))) {
            throw new GitWorktreeProvisioningError('path-conflict');
        }
        if (isCancelled()) {
            throw new GitWorktreeProvisioningError('cancelled');
        }
        await this.ensureDirectory(path.dirname(plan.worktreePath));
        if (isCancelled()) {
            throw new GitWorktreeProvisioningError('cancelled');
        }
        // The worktree branches from the frozen baseline SHA, never from
        // the (possibly advanced) short base ref (changes-panel PRD §4.2).
        const startPoint = plan.baseline?.commitSha ?? plan.baseRef;
        const result = await this.runGit(plan.commandCwd, [
            '-C', plan.commandCwd, 'worktree', 'add', '-b', plan.branchName,
            '--', plan.worktreePath, startPoint,
        ]);
        const reconciled = await this.reconcileCreatedWorktree(plan);
        if (reconciled) {
            await this.assertBaselineHead(plan, reconciled);
            return reconciled;
        }
        if (result.timedOut) {
            throw gitFailure('git-timeout', result);
        }
        if (!(await this.isBranchAvailable(plan.commandCwd, plan.branchName))) {
            throw gitFailure('branch-conflict', result);
        }
        if (!(await this.isPathAvailable(plan.worktreePath))) {
            throw gitFailure('path-conflict', result);
        }
        throw gitFailure('worktree-create-failed', result);
    }

    async validateCreatedWorktree(
        plan: WorktreeProvisioningPlan,
        key: WorktreeKey
    ): Promise<void> {
        await this.validatePlan(plan);
        const reconciled = await this.reconcileCreatedWorktree(plan);
        if (!reconciled
            || reconciled.repositoryKey !== key.repositoryKey
            || reconciled.canonicalWorktreePath !== key.canonicalWorktreePath) {
            throw new GitWorktreeProvisioningError('worktree-create-failed');
        }
    }

    private async assertBaselineHead(
        plan: WorktreeProvisioningPlan,
        key: WorktreeKey
    ): Promise<void> {
        if (!plan.baseline) {
            return;
        }
        if (!(await this.verifyBaselineHead(
            key.canonicalWorktreePath, plan.baseline))) {
            throw new GitWorktreeProvisioningError('worktree-create-failed');
        }
    }

    private async validatePlan(plan: WorktreeProvisioningPlan): Promise<void> {
        if (!plan || !isSafeAbsolutePath(plan.commandCwd)
            || !isSafeAbsolutePath(plan.worktreePath)
            || !isSafeAbsolutePath(plan.repositoryKey)
            || !isSafeBranchName(plan.branchName)
            || !isSafeRevision(plan.baseRef)
            || path.relative(plan.commandCwd, plan.worktreePath) === '') {
            throw new GitWorktreeProvisioningError('invalid-plan');
        }
        const branchValidation = await this.runGit(plan.commandCwd, [
            '-C', plan.commandCwd, 'check-ref-format', '--branch', plan.branchName,
        ]);
        const baseValidation = await this.runGit(plan.commandCwd, [
            '-C', plan.commandCwd, 'rev-parse', '--verify', '--quiet',
            `${plan.baseRef}^{commit}`,
        ]);
        const commonDir = await this.runGit(plan.commandCwd, [
            '-C', plan.commandCwd, 'rev-parse', '--path-format=absolute', '--git-common-dir',
        ]);
        if (branchValidation.exitCode !== 0 || baseValidation.exitCode !== 0
            || commonDir.exitCode !== 0) {
            if (baseValidation.exitCode !== 0) {
                const head = await this.runGit(plan.commandCwd, [
                    '-C', plan.commandCwd, 'rev-parse', '--verify', '--quiet', 'HEAD',
                ]);
                if (head.exitCode !== 0) {
                    throw new GitWorktreeProvisioningError('repository-has-no-commits');
                }
            }
            throw new GitWorktreeProvisioningError('invalid-plan');
        }
        try {
            const [actualRepository, plannedRepository] = await Promise.all([
                this.canonicalizeExistingPath(firstLine(commonDir.stdout)),
                this.canonicalizeExistingPath(plan.repositoryKey),
            ]);
            if (actualRepository !== plannedRepository) {
                throw new GitWorktreeProvisioningError('invalid-plan');
            }
        } catch (error) {
            if (error instanceof GitWorktreeProvisioningError) {
                throw error;
            }
            throw new GitWorktreeProvisioningError('invalid-plan');
        }
    }

    private async reconcileCreatedWorktree(
        plan: WorktreeProvisioningPlan
    ): Promise<WorktreeKey | undefined> {
        if (!(await this.pathExists(plan.worktreePath))) {
            return undefined;
        }
        const [topLevel, commonDir, branchRef] = await Promise.all([
            this.runGit(plan.worktreePath, [
                '-C', plan.worktreePath, 'rev-parse', '--path-format=absolute', '--show-toplevel',
            ]),
            this.runGit(plan.worktreePath, [
                '-C', plan.worktreePath, 'rev-parse', '--path-format=absolute', '--git-common-dir',
            ]),
            this.runGit(plan.worktreePath, [
                '-C', plan.worktreePath, 'rev-parse', '--symbolic-full-name', 'HEAD',
            ]),
        ]);
        if (topLevel.exitCode !== 0 || commonDir.exitCode !== 0 || branchRef.exitCode !== 0
            || firstLine(branchRef.stdout) !== `refs/heads/${plan.branchName}`) {
            return undefined;
        }
        const canonicalTopLevel = await this.canonicalizeExistingPath(firstLine(topLevel.stdout));
        const canonicalCommonDir = await this.canonicalizeExistingPath(firstLine(commonDir.stdout));
        const canonicalPlanRepository = await this.canonicalizeExistingPath(plan.repositoryKey);
        const canonicalPlanPath = await this.canonicalizeExistingPath(plan.worktreePath);
        if (canonicalTopLevel !== canonicalPlanPath
            || canonicalCommonDir !== canonicalPlanRepository) {
            return undefined;
        }
        return {
            repositoryKey: canonicalPlanRepository,
            canonicalWorktreePath: canonicalPlanPath,
        };
    }
}

export function runProvisioningGitCommand(
    cwd: string,
    args: readonly string[]
): Promise<GitCommandResult> {
    return new Promise(resolve => {
        execFile('git', [...args], {
            cwd,
            timeout: PROVISIONING_GIT_TIMEOUT_MS,
            maxBuffer: PROVISIONING_GIT_MAX_OUTPUT_BYTES,
            encoding: 'utf8',
            windowsHide: true,
        }, (error, stdout, stderr) => {
            const childError = error as unknown as NodeJS.ErrnoException & {
                code?: string | number;
                killed?: boolean;
            };
            resolve({
                exitCode: error
                    ? (typeof childError.code === 'number' ? childError.code : null)
                    : 0,
                stdout: typeof stdout === 'string' ? stdout : '',
                stderr: typeof stderr === 'string' ? stderr : '',
                timedOut: Boolean(error && childError.killed),
            });
        });
    });
}

function gitFailure(
    code: GitWorktreeProvisioningErrorCode,
    result: GitCommandResult
): GitWorktreeProvisioningError {
    const detail = (result.stderr || result.stdout || '')
        .trim().replace(/\s+/gu, ' ').slice(0, MAX_GIT_ERROR_LENGTH);
    return new GitWorktreeProvisioningError(code, detail ? `${code}: ${detail}` : code);
}

function isSafeBranchName(value: string): boolean {
    return typeof value === 'string' && value.length > 0 && value.length <= 1024
        && !value.startsWith('-') && !/[\0\r\n]/u.test(value);
}

function isSafeRevision(value: string): boolean {
    return typeof value === 'string' && value.length > 0 && value.length <= 1024
        && !value.startsWith('-') && !/[\0\r\n]/u.test(value);
}

function isSafeAbsolutePath(value: string): boolean {
    return typeof value === 'string' && value.length > 0 && value.length <= 32 * 1024
        && !/[\0\r\n]/u.test(value)
        && (path.isAbsolute(value) || path.win32.isAbsolute(value));
}

function firstLine(value: string): string {
    return (value || '').split(/\r?\n/u, 1)[0].trim();
}

async function pathExists(candidatePath: string): Promise<boolean> {
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

async function ensureDirectory(directoryPath: string): Promise<void> {
    await fs.promises.mkdir(directoryPath, { recursive: true });
}

async function canonicalizeExistingPath(candidatePath: string): Promise<string> {
    return path.normalize(await fs.promises.realpath(candidatePath));
}
