'use strict';

import { spawn } from 'child_process';

const SETUP_TIMEOUT_MS = 10 * 60_000;
const SETUP_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const SETUP_ERROR_DETAIL_LENGTH = 512;
const MAX_SETUP_ARG_COUNT = 128;
const MAX_SETUP_ARG_LENGTH = 32 * 1024;
const SETUP_FORCE_KILL_DELAY_MS = 1_000;

export type WorktreeSetupErrorCode =
  | 'cancelled'
  | 'setup-timeout'
  | 'setup-failed';

export class WorktreeSetupError extends Error {
    constructor(readonly code: WorktreeSetupErrorCode, message: string = code) {
        super(message);
        this.name = 'WorktreeSetupError';
        Object.setPrototypeOf(this, WorktreeSetupError.prototype);
    }
}

export interface WorktreeSetupCommandResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    cancelled: boolean;
}

export interface WorktreeSetupRunnerOptions {
    runCommand?: (
        command: readonly string[],
        cwd: string,
        isCancelled: () => boolean
    ) => Promise<WorktreeSetupCommandResult>;
}

/** Runs one explicitly configured executable without invoking a shell. */
export class WorktreeSetupRunner {
    private readonly runCommand: NonNullable<WorktreeSetupRunnerOptions['runCommand']>;

    constructor(options: WorktreeSetupRunnerOptions = {}) {
        this.runCommand = options.runCommand || runSetupCommand;
    }

    async run(
        command: readonly string[],
        worktreePath: string,
        isCancelled: () => boolean
    ): Promise<void> {
        const normalized = normalizeWorktreeSetupCommand(command);
        if (!normalized.length) {
            return;
        }
        if (isCancelled()) {
            throw new WorktreeSetupError('cancelled');
        }
        const result = await this.runCommand(normalized, worktreePath, isCancelled);
        if (result.cancelled || isCancelled()) {
            throw new WorktreeSetupError('cancelled');
        }
        if (result.timedOut) {
            throw setupFailure('setup-timeout', result);
        }
        if (result.exitCode !== 0) {
            throw setupFailure('setup-failed', result);
        }
    }
}

/**
 * Resource-scoped per repository (PRD §6.1): a cross-repo group can mix
 * Node/Java/Go stacks, so each member reads its own folder's setup override.
 * Resolves the member repository's bound workspace root and reads the setup
 * command at that root's scope.
 *
 * Extracted from the composition root during the shell decomposition; the
 * host URI plumbing stays with the caller.
 */
export function resolveMemberSetupCommand(input: {
    repositoryKey: string;
    snapshot: {
        repositories: readonly {
            repositoryKey: string;
            rootBindings: readonly { workspaceRootId: string }[];
        }[];
    } | null;
    workspaceRoots: readonly { id: string; uri: string }[] | null;
    readSetupCommand: (scopeUri?: string) => unknown;
}): string[] {
    const workspaceRoots = input.workspaceRoots || [];
    const repository = input.snapshot?.repositories.find(candidate =>
        candidate.repositoryKey === input.repositoryKey);
    const binding = repository?.rootBindings.find(candidate =>
        workspaceRoots.some(root => root.id === candidate.workspaceRootId));
    const root = workspaceRoots.find(candidate =>
        candidate.id === binding?.workspaceRootId);
    return normalizeWorktreeSetupCommand(input.readSetupCommand(root?.uri));
}

export function normalizeWorktreeSetupCommand(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SETUP_ARG_COUNT) {
        return [];
    }
    const args: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string' || item.length === 0
            || item.length > MAX_SETUP_ARG_LENGTH || /[\0\r\n]/u.test(item)) {
            return [];
        }
        args.push(item);
    }
    return args;
}

export function runSetupCommand(
    command: readonly string[],
    cwd: string,
    isCancelled: () => boolean
): Promise<WorktreeSetupCommandResult> {
    return new Promise(resolve => {
        const child = spawn(command[0], command.slice(1), {
            cwd,
            shell: false,
            detached: process.platform !== 'win32',
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let outputBytes = 0;
        let settled = false;
        let timedOut = false;
        let cancelled = false;
        let terminationStarted = false;
        let forceKillTimer: NodeJS.Timeout | undefined;
        const terminate = (): void => {
            if (terminationStarted) {
                return;
            }
            terminationStarted = true;
            if (process.platform === 'win32' && child.pid) {
                const killer = spawn('taskkill', [
                    '/pid', String(child.pid), '/t', '/f',
                ], {
                    shell: false,
                    windowsHide: true,
                    stdio: 'ignore',
                });
                killer.once('error', () => child.kill());
                return;
            }
            if (process.platform !== 'win32' && child.pid) {
                try {
                    process.kill(-child.pid, 'SIGTERM');
                    forceKillTimer = setTimeout(() => {
                        try {
                            process.kill(-child.pid!, 'SIGKILL');
                        } catch (_error) {
                            child.kill('SIGKILL');
                        }
                    }, SETUP_FORCE_KILL_DELAY_MS);
                    return;
                } catch (_error) {
                    // Fall back to the direct child when the group already exited.
                }
            }
            child.kill();
        };
        const append = (current: string, chunk: Buffer): string => {
            outputBytes += chunk.length;
            if (outputBytes > SETUP_MAX_OUTPUT_BYTES) {
                terminate();
                return current;
            }
            return current + chunk.toString('utf8');
        };
        child.stdout?.on('data', chunk => { stdout = append(stdout, chunk); });
        child.stderr?.on('data', chunk => { stderr = append(stderr, chunk); });
        const timeout = setTimeout(() => {
            timedOut = true;
            terminate();
        }, SETUP_TIMEOUT_MS);
        const cancellation = setInterval(() => {
            if (isCancelled()) {
                cancelled = true;
                terminate();
            }
        }, 100);
        const finish = (exitCode: number | null, launchError?: Error): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            clearInterval(cancellation);
            if (forceKillTimer) {
                clearTimeout(forceKillTimer);
            }
            resolve({
                exitCode,
                stdout,
                stderr: launchError ? `${stderr}\n${launchError.message}` : stderr,
                timedOut: timedOut || outputBytes > SETUP_MAX_OUTPUT_BYTES,
                cancelled,
            });
        };
        child.once('error', error => finish(null, error));
        child.once('close', exitCode => finish(exitCode));
    });
}

function setupFailure(
    code: WorktreeSetupErrorCode,
    result: WorktreeSetupCommandResult
): WorktreeSetupError {
    const detail = (result.stderr || result.stdout || '')
        .trim().replace(/\s+/gu, ' ').slice(0, SETUP_ERROR_DETAIL_LENGTH);
    return new WorktreeSetupError(code, detail ? `${code}: ${detail}` : code);
}
