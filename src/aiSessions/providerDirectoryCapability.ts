'use strict';

import * as childProcess from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import type { AiSessionProviderId } from '../models';

export type ProviderDirectoryCapabilityStatus = 'supported' | 'unsupported' | 'unavailable';

/**
 * Two CLI implementations ship a `kimi` executable: the Python Kimi CLI
 * (`kimi-cli`, supports `--work-dir` and treats `--prompt` as an interactive
 * session seed) and the TypeScript Kimi Code CLI (`kimi-code`, no
 * `--work-dir`; `--prompt` switches to a headless one-shot run). Launch
 * arguments must follow the detected dialect.
 */
export type KimiCliDialect = 'kimi-cli' | 'kimi-code';

export interface ProviderDirectoryCapabilityProvider {
    id: AiSessionProviderId;
    commandName: string;
}

export interface BoundedChildProcessOptions {
    timeoutMs: number;
    maxOutputBytes: number;
}

export interface BoundedChildProcessResult {
    exitCode: number | null;
    stdout?: string;
    stderr?: string;
    timedOut?: boolean;
}

export interface ProviderDirectoryCapabilityChildProcessAdapter {
    resolveExecutable(commandName: string): string | null;
    run(
        executable: string,
        args: readonly string[],
        options: BoundedChildProcessOptions
    ): Promise<BoundedChildProcessResult>;
}

export interface ProviderDirectoryCapabilityResult {
    status: ProviderDirectoryCapabilityStatus;
    /**
     * Kimi only: which CLI dialect the resolved `kimi` executable speaks,
     * derived from the same `--help` output as the capability status.
     * Undefined for other providers and when help output is unavailable.
     */
    kimiDialect?: KimiCliDialect;
    /**
     * Why the provider is unavailable; set only when `status` is
     * 'unavailable' so launch surfaces can tell "executable missing" apart
     * from a failing `--help` probe.
     */
    unavailableReason?: ProviderUnavailableReason;
}

export type ProviderUnavailableReason = 'missing' | 'help-failed' | 'help-timeout' | 'help-nonzero';

const HELP_TIMEOUT_MS = 5_000;
const HELP_OUTPUT_MAX_BYTES = 64 * 1024;
const NEGATIVE_CACHE_TTL_MS = 30_000;
const ADD_DIRECTORY_OPTION = /(?:^|\s)--add-dir(?=$|[\s=<\[(])/m;
const WORK_DIR_OPTION = /(?:^|\s)--work-dir(?=$|[\s=<\[(])/m;

function boundedHelpOutput(help: BoundedChildProcessResult): string {
    const stdout = typeof help.stdout === 'string' ? help.stdout : '';
    const stderr = typeof help.stderr === 'string' ? help.stderr : '';
    return Buffer.from(`${stdout}\n${stderr}`, 'utf8')
        .slice(0, HELP_OUTPUT_MAX_BYTES)
        .toString('utf8');
}

function result(
    status: ProviderDirectoryCapabilityStatus,
    extras?: { kimiDialect?: KimiCliDialect; unavailableReason?: ProviderUnavailableReason }
): ProviderDirectoryCapabilityResult {
    return Object.freeze({
        status,
        ...(extras?.kimiDialect ? { kimiDialect: extras.kimiDialect } : {}),
        ...(extras?.unavailableReason ? { unavailableReason: extras.unavailableReason } : {}),
    });
}

interface ProbeCacheEntry {
    promise: Promise<ProviderDirectoryCapabilityResult>;
    expiresAt: number;
}

export class ProviderDirectoryCapabilityProbe {
    private readonly cache = new Map<string, ProbeCacheEntry>();

    constructor(
        private readonly childProcess: ProviderDirectoryCapabilityChildProcessAdapter,
        private readonly logDiagnostic: (message: string) => void = () => undefined,
        private readonly nowMs: () => number = () => Date.now(),
    ) { }

    probe(provider: ProviderDirectoryCapabilityProvider): Promise<ProviderDirectoryCapabilityResult> {
        const resolvedExecutable = this.childProcess.resolveExecutable(provider.commandName);
        if (!resolvedExecutable) {
            // Never cached: the executable can appear without a window reload
            // (for example when the user installs into a directory that is
            // already on the extension host PATH), and the PATH scan itself
            // is cheap.
            this.logDiagnostic(`AI provider directory capability unavailable (${provider.id}: executable missing).`);
            return Promise.resolve(result('unavailable', { unavailableReason: 'missing' }));
        }

        const cacheKey = `${provider.id}:${resolvedExecutable}`;
        const cached = this.cache.get(cacheKey);
        if (cached && cached.expiresAt > this.nowMs()) {
            return cached.promise;
        }

        const pending = this.execute(provider, resolvedExecutable);
        const entry: ProbeCacheEntry = { promise: pending, expiresAt: Number.POSITIVE_INFINITY };
        this.cache.set(cacheKey, entry);
        void pending.then(resolved => {
            // Negative results expire instead of sticking for the extension
            // host lifetime: a transient --help failure (cold start, timeout)
            // recovers on a later probe, while a persistently broken provider
            // is re-probed at most once per TTL window.
            if (resolved.status === 'unavailable' && this.cache.get(cacheKey) === entry) {
                entry.expiresAt = this.nowMs() + NEGATIVE_CACHE_TTL_MS;
            }
        });
        return pending;
    }

    private async execute(
        provider: ProviderDirectoryCapabilityProvider,
        executable: string,
    ): Promise<ProviderDirectoryCapabilityResult> {
        let help: BoundedChildProcessResult;
        try {
            help = await this.childProcess.run(executable, ['--help'], {
                timeoutMs: HELP_TIMEOUT_MS,
                maxOutputBytes: HELP_OUTPUT_MAX_BYTES,
            });
        } catch (error) {
            this.logDiagnostic(`AI provider directory capability unavailable (${provider.id}: help execution failed).`);
            return result('unavailable', { unavailableReason: 'help-failed' });
        }

        if (help?.timedOut) {
            this.logDiagnostic(`AI provider directory capability unavailable (${provider.id}: help execution timed out).`);
            return result('unavailable', { unavailableReason: 'help-timeout' });
        }
        if (!help || help.exitCode !== 0) {
            this.logDiagnostic(`AI provider directory capability unavailable (${provider.id}: help exited unsuccessfully).`);
            return result('unavailable', { unavailableReason: 'help-nonzero' });
        }

        const output = boundedHelpOutput(help);
        const kimiDialect = provider.id === 'kimi'
            ? (WORK_DIR_OPTION.test(output) ? 'kimi-cli' : 'kimi-code')
            : undefined;
        return result(ADD_DIRECTORY_OPTION.test(output) ? 'supported' : 'unsupported', { kimiDialect });
    }
}

export function resolveAiProviderExecutable(commandName: string): string | null {
    if (!commandName) {
        return null;
    }
    if (path.isAbsolute(commandName)) {
        return existsSync(commandName) ? commandName : null;
    }

    const windows = process.platform === 'win32';
    const pathValue = process.env.PATH || process.env.Path || '';
    const extensions = windows
        ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
        : [''];
    for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
        for (const extension of extensions) {
            const candidate = path.join(directory, `${commandName}${extension}`);
            if (existsSync(candidate)) {
                return candidate;
            }
        }
    }
    return null;
}

export function runBoundedAiProviderHelp(
    executable: string,
    args: readonly string[],
    options: BoundedChildProcessOptions
): Promise<BoundedChildProcessResult> {
    return new Promise(resolve => {
        childProcess.execFile(executable, [...args], {
            timeout: options.timeoutMs,
            maxBuffer: options.maxOutputBytes,
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
