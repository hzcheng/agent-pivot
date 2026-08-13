'use strict';

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { RepositoryRootBinding, WorkspaceRoot } from '../workspaces/types';
import {
    WorktreeGitSnapshot,
    WorktreeHeadKind,
    WorktreeKey,
    WorktreeRepositorySnapshot,
    WorktreeSnapshotContent,
} from './types';
import { parseWorktreePorcelain, WorktreePorcelainRecord } from './porcelainParser';

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_WORKTREES = 64;
const MAX_DISCOVERED_PATH_LENGTH = 32 * 1024;

export interface GitCommandResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut?: boolean;
}

export type RunGitCommand = (
    cwd: string,
    args: readonly string[]
) => Promise<GitCommandResult>;

export interface GitWorktreeDiscoveryInput {
    workspaceRoots: readonly Pick<WorkspaceRoot, 'id' | 'hostPath'>[];
    priorityWorktreeKeys?: readonly WorktreeKey[];
}

export interface GitWorktreeDiscoveryOptions {
    runGit?: RunGitCommand;
    canonicalizeExistingPath?: (candidatePath: string) => Promise<string>;
    isDirectory?: (candidatePath: string) => Promise<boolean>;
    getBaseRef?: (repositoryKey: string) => string | undefined;
    maxWorktrees?: number;
}

interface RepositoryCandidate {
    repositoryKey: string;
    commandCwd: string;
    rootBindings: RepositoryRootBinding[];
    workspaceWorktreePaths: Set<string>;
}

interface DiscoveredRepository {
    repositoryKey: string;
    rootBindings: RepositoryRootBinding[];
    baseRef?: string;
    worktrees: WorktreeGitSnapshot[];
    workspaceWorktreePaths: Set<string>;
}

export class GitWorktreeDiscoveryError extends Error {
    readonly retryable: boolean;

    constructor(message: string, retryable = true) {
        super(message);
        this.name = 'GitWorktreeDiscoveryError';
        this.retryable = retryable;
        Object.setPrototypeOf(this, GitWorktreeDiscoveryError.prototype);
    }
}

/** Discovers all repositories represented by the current workspace roots. */
export class GitWorktreeDiscovery {
    private readonly runGit: RunGitCommand;
    private readonly canonicalizeExistingPath: (candidatePath: string) => Promise<string>;
    private readonly isDirectory: (candidatePath: string) => Promise<boolean>;
    private supportsNulPorcelain: boolean | undefined;

    constructor(private readonly options: GitWorktreeDiscoveryOptions = {}) {
        this.runGit = options.runGit || runGitCommand;
        this.canonicalizeExistingPath = options.canonicalizeExistingPath
            || canonicalizeExistingPath;
        this.isDirectory = options.isDirectory || isDirectory;
    }

    async discover(input: GitWorktreeDiscoveryInput): Promise<WorktreeSnapshotContent> {
        const candidates = await this.discoverRepositoryCandidates(input.workspaceRoots || []);
        const repositories = await Promise.all(candidates.map(candidate =>
            this.discoverRepository(candidate)));
        return freezeSnapshotContent(this.truncate(repositories, input.priorityWorktreeKeys || []));
    }

    private async discoverRepositoryCandidates(
        roots: readonly Pick<WorkspaceRoot, 'id' | 'hostPath'>[]
    ): Promise<RepositoryCandidate[]> {
        const byRepository = new Map<string, RepositoryCandidate>();
        for (const root of roots) {
            const hostPath = normalizeAbsolutePath(root.hostPath);
            if (!hostPath) {
                continue;
            }
            const commonDirResult = await this.runGit(hostPath, [
                '-C', hostPath, 'rev-parse', '--path-format=absolute', '--git-common-dir',
            ]);
            if (commonDirResult.exitCode !== 0) {
                continue;
            }
            const commonDir = firstOutputLine(commonDirResult.stdout);
            if (!commonDir) {
                continue;
            }
            const absoluteCommonDir = path.isAbsolute(commonDir)
                ? commonDir
                : path.resolve(hostPath, commonDir);
            const repositoryKey = await this.canonicalizeExistingPath(absoluteCommonDir);
            const topLevelResult = await this.runGit(hostPath, [
                '-C', hostPath, 'rev-parse', '--path-format=absolute', '--show-toplevel',
            ]);
            const topLevel = topLevelResult.exitCode === 0
                ? normalizeAbsolutePath(firstOutputLine(topLevelResult.stdout))
                : hostPath;
            if (!topLevel) {
                continue;
            }
            const canonicalTopLevel = await this.canonicalizeIfPresent(topLevel);
            const canonicalHostPath = await this.canonicalizeIfPresent(hostPath);
            const repositoryRelativePath = normalizeRepositoryRelativePath(
                path.relative(canonicalTopLevel, canonicalHostPath)
            );
            if (repositoryRelativePath === null) {
                continue;
            }
            let candidate = byRepository.get(repositoryKey);
            if (!candidate) {
                candidate = {
                    repositoryKey,
                    commandCwd: hostPath,
                    rootBindings: [],
                    workspaceWorktreePaths: new Set(),
                };
                byRepository.set(repositoryKey, candidate);
            }
            if (!candidate.rootBindings.some(binding => binding.workspaceRootId === root.id)) {
                candidate.rootBindings.push({ workspaceRootId: root.id, repositoryRelativePath });
            }
            candidate.workspaceWorktreePaths.add(canonicalTopLevel);
        }
        return Array.from(byRepository.values());
    }

    private async discoverRepository(
        candidate: RepositoryCandidate
    ): Promise<DiscoveredRepository> {
        const records = await this.listWorktrees(candidate.commandCwd);
        const explicitBaseRef = this.options.getBaseRef?.(candidate.repositoryKey);
        // Git lists the main worktree first. Its symbolic branch is a local,
        // remote-name-independent initial default; callers can persist and
        // explicitly supply a different base ref on later discoveries.
        const initialBaseRef = explicitBaseRef || records[0]?.branchRef;
        if (explicitBaseRef && !isSafeRevisionName(explicitBaseRef)) {
            throw new GitWorktreeDiscoveryError('The configured Git base ref is invalid.', false);
        }
        const baseRef = initialBaseRef && isSafeRevisionName(initialBaseRef)
            ? initialBaseRef
            : undefined;
        const worktrees = await Promise.all(records.map((record, index) =>
            this.buildGitSnapshot(candidate, record, index === 0, baseRef)));
        const uniqueKeys = new Set(worktrees.map(worktree => worktreeKeyToken(worktree.key)));
        if (uniqueKeys.size !== worktrees.length) {
            throw new GitWorktreeDiscoveryError('Git returned duplicate worktree paths.', false);
        }
        return {
            repositoryKey: candidate.repositoryKey,
            rootBindings: candidate.rootBindings.slice(),
            ...(baseRef ? { baseRef } : {}),
            worktrees,
            workspaceWorktreePaths: candidate.workspaceWorktreePaths,
        };
    }

    private async listWorktrees(cwd: string): Promise<WorktreePorcelainRecord[]> {
        let nulResult: GitCommandResult | undefined;
        if (this.supportsNulPorcelain !== false) {
            nulResult = await this.runGit(cwd, [
                '-C', cwd, 'worktree', 'list', '--porcelain', '-z',
            ]);
            if (nulResult.exitCode === 0) {
                this.supportsNulPorcelain = true;
                return parseWorktreePorcelain(nulResult.stdout);
            }
            this.supportsNulPorcelain = false;
        }
        const lineResult = await this.runGit(cwd, [
            '-C', cwd, 'worktree', 'list', '--porcelain',
        ]);
        if (lineResult.exitCode !== 0) {
            throw new GitWorktreeDiscoveryError(
                `Could not list Git worktrees: ${boundedError(
                    lineResult.stderr || nulResult?.stderr || '')}`
            );
        }
        return parseWorktreePorcelain(lineResult.stdout);
    }

    private async buildGitSnapshot(
        candidate: RepositoryCandidate,
        record: WorktreePorcelainRecord,
        isMain: boolean,
        baseRef: string | undefined
    ): Promise<WorktreeGitSnapshot> {
        const normalizedPath = normalizeAbsolutePath(record.worktreePath);
        if (!normalizedPath) {
            throw new GitWorktreeDiscoveryError('Git returned a non-absolute worktree path.', false);
        }
        if (record.head && !/^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$/.test(record.head)) {
            throw new GitWorktreeDiscoveryError('Git returned an invalid worktree HEAD.', false);
        }
        const exists = await this.isDirectory(normalizedPath);
        const canonicalWorktreePath = exists
            ? await this.canonicalizeExistingPath(normalizedPath)
            : normalizedPath;
        const key = {
            repositoryKey: candidate.repositoryKey,
            canonicalWorktreePath,
        };
        const defaultHeadKind: WorktreeHeadKind = record.bare
            ? 'unknown'
            : record.detached ? 'detached' : record.branchRef ? 'branch' : 'unknown';
        const headKind = record.branchRef === baseRef
            ? defaultHeadKind
            : record.head && baseRef
            ? await this.classifyAgainstBase(candidate.commandCwd, record.head, baseRef, defaultHeadKind)
            : defaultHeadKind;
        return {
            key,
            ...(record.branchRef ? { branchRef: record.branchRef } : {}),
            head: record.head,
            isMain,
            isBare: record.bare,
            health: record.prunable
                ? 'prunable'
                : record.locked ? 'locked' : exists ? 'normal' : 'missing',
            headKind,
        };
    }

    private async classifyAgainstBase(
        cwd: string,
        head: string,
        baseRef: string,
        fallback: WorktreeHeadKind
    ): Promise<WorktreeHeadKind> {
        const result = await this.runGit(cwd, [
            '-C', cwd, 'merge-base', '--is-ancestor', '--', head, baseRef,
        ]);
        if (result.exitCode === 0) {
            return 'contained-in-base';
        }
        if (result.exitCode === 1) {
            return fallback;
        }
        return 'unknown';
    }

    private truncate(
        repositories: readonly DiscoveredRepository[],
        priorityKeys: readonly WorktreeKey[]
    ): WorktreeSnapshotContent {
        const configuredLimit = this.options.maxWorktrees ?? DEFAULT_MAX_WORKTREES;
        const maxWorktrees = Number.isSafeInteger(configuredLimit)
            ? Math.max(1, Math.min(DEFAULT_MAX_WORKTREES, configuredLimit))
            : DEFAULT_MAX_WORKTREES;
        const priority = new Set(priorityKeys.map(worktreeKeyToken));
        const flattened = repositories.reduce((items, repository, repositoryIndex) => {
            items.push(...repository.worktrees.map((worktree, worktreeIndex) => ({
                repositoryIndex,
                worktreeIndex,
                worktree,
                workspacePriority: repository.workspaceWorktreePaths
                    .has(worktree.key.canonicalWorktreePath),
                runtimePriority: priority.has(worktreeKeyToken(worktree.key)),
            })));
            return items;
        }, [] as Array<{
            repositoryIndex: number;
            worktreeIndex: number;
            worktree: WorktreeGitSnapshot;
            workspacePriority: boolean;
            runtimePriority: boolean;
        }>);
        const selected = flattened.slice().sort((left, right) =>
            Number(right.workspacePriority || right.runtimePriority)
                - Number(left.workspacePriority || left.runtimePriority)
            || Number(right.workspacePriority) - Number(left.workspacePriority)
            || left.repositoryIndex - right.repositoryIndex
            || left.worktreeIndex - right.worktreeIndex
        ).slice(0, maxWorktrees);
        const selectedKeys = new Set(selected.map(item => worktreeKeyToken(item.worktree.key)));
        const snapshots: WorktreeRepositorySnapshot[] = repositories.map(repository => ({
            repositoryKey: repository.repositoryKey,
            rootBindings: repository.rootBindings.slice(),
            ...(repository.baseRef ? { baseRef: repository.baseRef } : {}),
            worktrees: repository.worktrees.filter(worktree =>
                selectedKeys.has(worktreeKeyToken(worktree.key))),
        }));
        return {
            repositories: snapshots,
            truncatedWorktreeCount: Math.max(0, flattened.length - selected.length),
        };
    }

    private async canonicalizeIfPresent(candidatePath: string): Promise<string> {
        return await this.isDirectory(candidatePath)
            ? this.canonicalizeExistingPath(candidatePath)
            : candidatePath;
    }
}

export function runGitCommand(
    cwd: string,
    args: readonly string[]
): Promise<GitCommandResult> {
    return new Promise(resolve => {
        execFile('git', [...args], {
            cwd,
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: GIT_MAX_OUTPUT_BYTES,
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

async function canonicalizeExistingPath(candidatePath: string): Promise<string> {
    return normalizeAbsolutePath(await fs.promises.realpath(candidatePath));
}

async function isDirectory(candidatePath: string): Promise<boolean> {
    try {
        return (await fs.promises.stat(candidatePath)).isDirectory();
    } catch (_error) {
        return false;
    }
}

function normalizeAbsolutePath(value: string): string {
    if (typeof value !== 'string' || !value || value.length > MAX_DISCOVERED_PATH_LENGTH
        || /[\0\r\n]/.test(value) || (!path.isAbsolute(value)
        && !path.win32.isAbsolute(value))) {
        return '';
    }
    return path.normalize(value);
}

function isSafeRevisionName(value: string): boolean {
    return typeof value === 'string' && value.length > 0 && value.length <= 1024
        && !value.startsWith('-') && !/[\0\r\n]/.test(value);
}

function normalizeRepositoryRelativePath(value: string): string | null {
    const normalized = value ? path.normalize(value) : '.';
    if (path.isAbsolute(normalized) || normalized === '..'
        || normalized.startsWith(`..${path.sep}`)) {
        return null;
    }
    return normalized === '.' ? '' : normalized.split(path.sep).join('/');
}

function firstOutputLine(value: string): string {
    return (value || '').split(/\r?\n/, 1)[0].trim();
}

function boundedError(value: string): string {
    const message = (value || '').trim().replace(/\s+/g, ' ');
    return message.slice(0, 512) || 'unknown Git error';
}

function worktreeKeyToken(key: WorktreeKey): string {
    return JSON.stringify([key.repositoryKey, key.canonicalWorktreePath]);
}

function freezeSnapshotContent(content: WorktreeSnapshotContent): WorktreeSnapshotContent {
    const repositories = content.repositories.map(repository => Object.freeze({
        repositoryKey: repository.repositoryKey,
        rootBindings: Object.freeze(repository.rootBindings.map(binding => Object.freeze({ ...binding }))),
        ...(repository.baseRef ? { baseRef: repository.baseRef } : {}),
        worktrees: Object.freeze(repository.worktrees.map(worktree => Object.freeze({
            ...worktree,
            key: Object.freeze({ ...worktree.key }),
        }))),
    }));
    return Object.freeze({
        repositories: Object.freeze(repositories),
        truncatedWorktreeCount: content.truncatedWorktreeCount,
    });
}
