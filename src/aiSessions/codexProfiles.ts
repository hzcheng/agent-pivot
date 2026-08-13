'use strict';

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
    CODEX_PROFILE_CONFIG_SUFFIX,
    isValidCodexProfileName,
} from './codexProfileNames';
import type { SessionProfileDecision } from './types';

export {
    CODEX_PROFILE_CONFIG_SUFFIX,
    CODEX_PROFILE_NAME_MAX_LENGTH,
    isValidCodexProfileName,
    sanitizeCodexProfileName,
} from './codexProfileNames';

export interface CodexProfileLogger {
    (message: string, error: unknown): void;
}

/**
 * Resolves the Codex home directory the same way the Codex CLI does:
 * `$CODEX_HOME` when set, otherwise `~/.codex`.
 */
export function resolveCodexHome(
    env: NodeJS.ProcessEnv = process.env,
    homedir: string = os.homedir()
): string {
    return env.CODEX_HOME || path.join(homedir, '.codex');
}

/**
 * Discovers Codex configuration profiles by listing `<name>.config.toml`
 * overlays in the Codex home directory. A missing directory yields an empty
 * list; unexpected filesystem errors are logged and also yield an empty list
 * so the picker simply stays hidden.
 */
export function listCodexConfigProfiles(
    env: NodeJS.ProcessEnv = process.env,
    homedir: string = os.homedir(),
    log?: CodexProfileLogger
): string[] {
    const codexHome = resolveCodexHome(env, homedir);
    let entries: string[];
    try {
        entries = fs.readdirSync(codexHome);
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            log?.(`Could not list Codex configuration profiles in ${codexHome}.`, error);
        }
        return [];
    }
    const profiles = new Set<string>();
    for (const entry of entries) {
        if (!entry.endsWith(CODEX_PROFILE_CONFIG_SUFFIX)) {
            continue;
        }
        const name = entry.slice(0, entry.length - CODEX_PROFILE_CONFIG_SUFFIX.length);
        if (isValidCodexProfileName(name)) {
            profiles.add(name);
        }
    }
    return [...profiles].sort((left, right) => left.localeCompare(right));
}

export function codexProfileFileExists(
    name: string,
    env: NodeJS.ProcessEnv = process.env,
    homedir: string = os.homedir()
): boolean {
    if (!isValidCodexProfileName(name)) {
        return false;
    }
    try {
        return fs.statSync(
            path.join(resolveCodexHome(env, homedir), `${name}${CODEX_PROFILE_CONFIG_SUFFIX}`)
        ).isFile();
    } catch {
        return false;
    }
}

export interface CodexProfilePick {
    label: string;
    description: string;
    decision: SessionProfileDecision;
}

export const CODEX_BASE_PROFILE_PICK_LABEL = 'Base configuration (no profile)';

/**
 * Builds the profile QuickPick items. The item the user is most likely to
 * want is moved to index 0 (VS Code single-select QuickPicks initially focus
 * the first item, so Enter accepts it) and tagged as `Current`. Preselection
 * priority: last used (still valid) > default setting (still valid) > Base.
 */
export function buildCodexProfilePicks(options: {
    profiles: readonly string[];
    lastUsed?: SessionProfileDecision | null;
    defaultFromSetting?: string | null;
}): CodexProfilePick[] {
    const profiles = (options.profiles || []).filter(isValidCodexProfileName);
    const setting = options.defaultFromSetting && profiles.includes(options.defaultFromSetting)
        ? options.defaultFromSetting
        : null;
    const lastUsed = options.lastUsed || null;
    const lastUsedName = lastUsed?.kind === 'profile' && profiles.includes(lastUsed.name)
        ? lastUsed.name
        : null;

    const basePick: CodexProfilePick = {
        label: CODEX_BASE_PROFILE_PICK_LABEL,
        description: '',
        decision: { kind: 'base' },
    };
    const picks: CodexProfilePick[] = [basePick];
    for (const name of profiles) {
        const tags: string[] = [];
        if (setting === name) {
            tags.push('Default setting');
        }
        if (lastUsedName === name) {
            tags.push('Last used');
        }
        picks.push({
            label: name,
            description: tags.join(' · '),
            decision: { kind: 'profile', name },
        });
    }

    let preselected = basePick;
    if (lastUsed?.kind === 'base') {
        preselected = basePick;
    } else if (lastUsedName) {
        preselected = picks.find(pick => pick.decision.kind === 'profile'
            && pick.decision.name === lastUsedName) || basePick;
    } else if (setting) {
        preselected = picks.find(pick => pick.decision.kind === 'profile'
            && pick.decision.name === setting) || basePick;
    }
    preselected.description = [preselected.description, 'Current']
        .filter(value => !!value)
        .join(' · ');
    return [preselected, ...picks.filter(pick => pick !== preselected)];
}

interface CodexProfileSupportMemento {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void> | Promise<void> | void;
}

type ExecFileAsync = (
    executable: string,
    args: string[],
    options: { timeout: number }
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

const CODEX_PROFILE_SUPPORT_CACHE_KEY = 'codexProfileSupport.v1';
const CODEX_PROFILE_SUPPORT_PROBE_TIMEOUT_MS = 5000;

function defaultExecFileAsync(
    executable: string,
    args: string[],
    options: { timeout: number }
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
    return new Promise((resolve, reject) => {
        execFile(executable, args, options, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

/**
 * Lazily probes whether the installed Codex CLI supports `-p/--profile` on
 * `codex resume` (and therefore on new sessions). Results are cached in
 * memory for the session and persisted per executable path so the probe runs
 * at most once per CLI installation.
 */
export class CodexProfileSupportProbe {
    private readonly memoryCache = new Map<string, boolean>();

    constructor(private readonly options: {
        executable: string;
        memento?: CodexProfileSupportMemento;
        execFileAsync?: ExecFileAsync;
    }) {}

    async isSupported(): Promise<boolean> {
        const executable = this.options.executable;
        const cached = this.memoryCache.get(executable);
        if (cached !== undefined) {
            return cached;
        }
        const persisted = this.readPersisted(executable);
        if (persisted !== undefined) {
            this.memoryCache.set(executable, persisted);
            return persisted;
        }
        let supported = false;
        try {
            const execFileAsync = this.options.execFileAsync || defaultExecFileAsync;
            const result = await execFileAsync(
                executable,
                ['resume', '--help'],
                { timeout: CODEX_PROFILE_SUPPORT_PROBE_TIMEOUT_MS }
            );
            supported = `${result.stdout}\n${result.stderr}`.includes('--profile');
        } catch {
            supported = false;
        }
        this.memoryCache.set(executable, supported);
        this.persist(executable, supported);
        return supported;
    }

    private readPersisted(executable: string): boolean | undefined {
        try {
            const record = this.options.memento?.get<Record<string, unknown>>(
                CODEX_PROFILE_SUPPORT_CACHE_KEY
            );
            const value = record?.[executable];
            return typeof value === 'boolean' ? value : undefined;
        } catch {
            return undefined;
        }
    }

    private persist(executable: string, supported: boolean): void {
        try {
            const record = {
                ...(this.options.memento?.get<Record<string, unknown>>(
                    CODEX_PROFILE_SUPPORT_CACHE_KEY
                ) || {}),
                [executable]: supported,
            };
            void this.options.memento?.update(CODEX_PROFILE_SUPPORT_CACHE_KEY, record);
        } catch {
            // Probe caching is best-effort only.
        }
    }
}

// A profile-declared model_context_window is authoritative for the telemetry
// display: the app-server reports its built-in default (258400) for custom
// provider models, ignoring the profile overlay. Files change rarely, so
// reads are cached briefly per resolved path.
const PROFILE_CONTEXT_WINDOW_CACHE_TTL_MS = 10 * 1000;
const MAX_MODEL_CONTEXT_WINDOW = 100_000_000;
const TOP_LEVEL_CONTEXT_WINDOW_PATTERN = /^\s*model_context_window\s*=\s*([0-9]+)\s*(?:#.*)?$/m;

const profileContextWindowCache = new Map<string, { at: number; value: number | undefined }>();

/**
 * Reads the top-level `model_context_window` from a profile's
 * `<name>.config.toml` overlay. Returns undefined for unknown names, missing
 * files, and absent or implausible values.
 */
export function readCodexProfileContextWindow(
    name: string,
    env: NodeJS.ProcessEnv = process.env,
    homedir: string = os.homedir(),
    nowMs: number = Date.now()
): number | undefined {
    if (!isValidCodexProfileName(name)) {
        return undefined;
    }
    const filePath = path.join(
        resolveCodexHome(env, homedir),
        `${name}${CODEX_PROFILE_CONFIG_SUFFIX}`
    );
    const cached = profileContextWindowCache.get(filePath);
    if (cached && nowMs - cached.at < PROFILE_CONTEXT_WINDOW_CACHE_TTL_MS) {
        return cached.value;
    }
    let value: number | undefined;
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        // Only top-level keys count: a model_context_window inside a
        // [model_providers.*] table configures something else entirely.
        const topLevel = content.split(/^\s*\[/m, 1)[0];
        const match = TOP_LEVEL_CONTEXT_WINDOW_PATTERN.exec(topLevel ?? '');
        const parsed = match ? Number(match[1]) : Number.NaN;
        if (Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_MODEL_CONTEXT_WINDOW) {
            value = parsed;
        }
    } catch {
        value = undefined;
    }
    profileContextWindowCache.set(filePath, { at: nowMs, value });
    return value;
}
