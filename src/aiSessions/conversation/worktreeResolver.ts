'use strict';

import { execFile } from 'child_process';
import * as path from 'path';
import type { WorktreeKey } from '../../worktrees';

export interface ConversationWorktreeInfo {
    branch: string;
    worktreeRoot: string;
    repoRoot: string;
    /** The signaled path no longer exists; branch comes from session logs. */
    missing?: boolean;
}

export interface WorktreeResolverOptions {
    now(): number;
    execGit?: (
        args: string[],
        cwd: string
    ) => Promise<{ stdout: string; stderr: string }>;
    /**
     * Canonicalizer for the manifest-compatible WorktreeKey (symlink
     * resolution). Injected by composition: this module stays in the
     * Codex reachable graph, which forbids filesystem imports
     * (ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001).
     */
    canonicalizePath?: (candidatePath: string) => Promise<string>;
    cacheTtlMs?: number;
    maxCacheEntries?: number;
}

const DEFAULT_CACHE_TTL_MS = 5_000;
const DEFAULT_MAX_CACHE_ENTRIES = 64;
const GIT_TIMEOUT_MS = 5_000;
const MAX_PATH_LENGTH = 1024;

function defaultExecGit(
    args: string[],
    cwd: string
): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        execFile(
            'git',
            args,
            { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 },
            (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve({ stdout, stderr });
            }
        );
    });
}

export type ResolveWorktree = (
    candidatePath: string
) => Promise<ConversationWorktreeInfo | undefined>;

export type ResolveWorktreeKey = (
    candidatePath: string
) => Promise<WorktreeKey | undefined>;

/**
 * Resolves the git worktree that contains a candidate path (a session's
 * current working directory or a path extracted from tool activity).
 * Results are cached briefly so telemetry refreshes stay cheap.
 */
export class ConversationWorktreeResolver {
    private readonly cache = new Map<string, {
        readAt: number;
        value?: ConversationWorktreeInfo;
        key?: WorktreeKey;
    }>();

    constructor(private readonly options: WorktreeResolverOptions) {}

    async resolve(
        candidatePath: string
    ): Promise<ConversationWorktreeInfo | undefined> {
        if (!isUsableCandidatePath(candidatePath)) {
            return undefined;
        }
        const cached = this.cache.get(candidatePath);
        const now = this.options.now();
        if (cached
            && now - cached.readAt
                < (this.options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS)) {
            return cached.value ? { ...cached.value } : undefined;
        }
        const queried = await this.query(candidatePath);
        if (this.cache.size
            >= (this.options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES)) {
            const oldest = this.cache.keys().next().value;
            if (typeof oldest === 'string') {
                this.cache.delete(oldest);
            }
        }
        this.cache.set(candidatePath, {
            readAt: now,
            value: queried?.info,
            key: queried?.key,
        });
        return queried?.info ? { ...queried.info } : undefined;
    }

    /**
     * Resolves the manifest-compatible WorktreeKey for a candidate path
     * (changes-panel PRD §4.1): repositoryKey is the canonical common
     * git dir (symlinks resolved), matching WorktreeKey semantics, NOT
     * `dirname(commonDir)`; canonicalWorktreePath is the canonical
     * worktree root. Shares the resolve() cache.
     */
    async resolveKey(
        candidatePath: string
    ): Promise<WorktreeKey | undefined> {
        if (!isUsableCandidatePath(candidatePath)) {
            return undefined;
        }
        const cached = this.cache.get(candidatePath);
        const now = this.options.now();
        if (cached
            && now - cached.readAt
                < (this.options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS)) {
            return cached.key ? { ...cached.key } : undefined;
        }
        await this.resolve(candidatePath);
        return this.cache.get(candidatePath)?.key
            ? { ...this.cache.get(candidatePath)!.key! }
            : undefined;
    }

    private async query(
        candidatePath: string
    ): Promise<{ info: ConversationWorktreeInfo; key: WorktreeKey } | undefined> {
        const execGit = this.options.execGit || defaultExecGit;
        let stdout: string;
        try {
            const result = await execGit([
                '-C', candidatePath,
                'rev-parse',
                '--show-toplevel',
                '--git-common-dir',
                '--abbrev-ref', 'HEAD',
            ], candidatePath);
            stdout = result.stdout;
        } catch (_error) {
            return undefined;
        }
        const lines = stdout.split('\n').map(line => line.trim());
        const [worktreeRoot, commonDir, abbrevRef] = lines;
        if (!worktreeRoot || !commonDir) {
            return undefined;
        }
        const toplevel = path.resolve(worktreeRoot);
        const absoluteCommonDir = path.isAbsolute(commonDir)
            ? commonDir
            : path.resolve(toplevel, commonDir);
        let branch = abbrevRef && abbrevRef !== 'HEAD' ? abbrevRef : '';
        if (!branch) {
            try {
                const result = await execGit([
                    '-C', candidatePath, 'rev-parse', '--short', 'HEAD',
                ], candidatePath);
                branch = result.stdout.trim();
            } catch (_error) {
                branch = '';
            }
        }
        if (!branch) {
            return undefined;
        }
        const canonicalize = this.options.canonicalizePath
            || (candidate => Promise.resolve(path.resolve(candidate)));
        const key = {
            repositoryKey: await canonicalize(absoluteCommonDir),
            canonicalWorktreePath: await canonicalize(toplevel),
        };
        return {
            info: {
                branch: branch.slice(0, 128),
                worktreeRoot: toplevel,
                repoRoot: path.dirname(absoluteCommonDir),
            },
            key,
        };
    }
}

function isUsableCandidatePath(candidatePath: unknown): candidatePath is string {
    // Windows absolute paths (C:\… / C:/…) are valid candidates; the host
    // path API decides what is absolute on this platform.
    return typeof candidatePath === 'string'
        && path.isAbsolute(candidatePath)
        && candidatePath.length <= MAX_PATH_LENGTH;
}
