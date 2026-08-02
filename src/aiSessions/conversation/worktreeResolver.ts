'use strict';

import { execFile } from 'child_process';
import * as path from 'path';

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

/**
 * Resolves the git worktree that contains a candidate path (a session's
 * current working directory or a path extracted from tool activity).
 * Results are cached briefly so telemetry refreshes stay cheap.
 */
export class ConversationWorktreeResolver {
    private readonly cache = new Map<string, {
        readAt: number;
        value?: ConversationWorktreeInfo;
    }>();

    constructor(private readonly options: WorktreeResolverOptions) {}

    async resolve(
        candidatePath: string
    ): Promise<ConversationWorktreeInfo | undefined> {
        if (typeof candidatePath !== 'string'
            || !candidatePath.startsWith('/')
            || candidatePath.length > MAX_PATH_LENGTH) {
            return undefined;
        }
        const cached = this.cache.get(candidatePath);
        const now = this.options.now();
        if (cached
            && now - cached.readAt
                < (this.options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS)) {
            return cached.value ? { ...cached.value } : undefined;
        }
        const value = await this.query(candidatePath);
        if (this.cache.size
            >= (this.options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES)) {
            const oldest = this.cache.keys().next().value;
            if (typeof oldest === 'string') {
                this.cache.delete(oldest);
            }
        }
        this.cache.set(candidatePath, { readAt: now, value });
        return value ? { ...value } : undefined;
    }

    private async query(
        candidatePath: string
    ): Promise<ConversationWorktreeInfo | undefined> {
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
        return {
            branch: branch.slice(0, 128),
            worktreeRoot: toplevel,
            repoRoot: path.dirname(absoluteCommonDir),
        };
    }
}
