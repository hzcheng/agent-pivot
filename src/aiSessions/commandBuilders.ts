'use strict';

import {
    AiSessionLaunchSpec,
    quotePosixShellArg,
    serializeDirectLaunchCommand,
} from './launchSpec';
import { isValidCodexProfileName } from './codexProfileNames';
import type { AiSessionLaunchOptions } from './launchOptions';
import type { AiSessionDirectoryScope } from './types';

export type AiSessionCommandPlatform = NodeJS.Platform;

const SAFE_LAUNCH_OPTIONS: AiSessionLaunchOptions = Object.freeze({ yolo: false });

function yoloArg(options: AiSessionLaunchOptions, argument: string): string[] {
    return options?.yolo === true ? [argument] : [];
}

function codexProfileArgs(options: AiSessionLaunchOptions): string[] {
    const profile = options?.codexProfile;
    return isValidCodexProfileName(profile) ? ['-p', profile] : [];
}

function buildRepeatedAdditionalDirectoryArgs(scope: AiSessionDirectoryScope): string[] {
    return (scope?.additionalDirectories || []).reduce((args, directory) => [
        ...args,
        '--add-dir',
        directory,
    ], [] as string[]);
}

function buildClaudeAdditionalDirectoryArgs(scope: AiSessionDirectoryScope): string[] {
    const additionalDirectories = scope?.additionalDirectories || [];
    return additionalDirectories.length ? ['--add-dir', ...additionalDirectories] : [];
}

function managedCodexLaunch(spec: AiSessionLaunchSpec, scope: AiSessionDirectoryScope,
    options: AiSessionLaunchOptions): AiSessionLaunchSpec {
    if (!options.codexStreamRunner) { return spec; }
    return {
        executable: 'env',
        args: ['ELECTRON_RUN_AS_NODE=1', process.execPath, options.codexStreamRunner,
            JSON.stringify({ args: spec.args, cwd: scope.primaryCwd, markerPath: spec.markerPath })],
        cwd: scope.primaryCwd,
        markerPath: spec.markerPath,
    };
}

export function buildCodexResumeLaunchSpec(sessionId: string, scope: AiSessionDirectoryScope, markerPath: string = null, launchOptions: AiSessionLaunchOptions = SAFE_LAUNCH_OPTIONS, prompt: string = null): AiSessionLaunchSpec {
    return managedCodexLaunch({
        executable: 'codex',
        args: [
            'resume',
            ...codexProfileArgs(launchOptions),
            ...yoloArg(launchOptions, '--dangerously-bypass-approvals-and-sandbox'),
            ...(scope?.primaryCwd ? ['--cd', scope.primaryCwd] : []),
            ...buildRepeatedAdditionalDirectoryArgs(scope),
            sessionId,
            ...(prompt ? [prompt] : []),
        ],
        markerPath,
        windowsDirectShell: 'current',
    }, scope, launchOptions);
}

export function buildCodexNewSessionLaunchSpec(scope: AiSessionDirectoryScope, prompt: string = null, markerPath: string = null, launchOptions: AiSessionLaunchOptions = SAFE_LAUNCH_OPTIONS): AiSessionLaunchSpec {
    return managedCodexLaunch({
        executable: 'codex',
        args: [
            ...codexProfileArgs(launchOptions),
            ...yoloArg(launchOptions, '--dangerously-bypass-approvals-and-sandbox'),
            ...(scope?.primaryCwd ? ['--cd', scope.primaryCwd] : []),
            ...buildRepeatedAdditionalDirectoryArgs(scope),
            ...(prompt ? [prompt] : []),
        ],
        markerPath,
        windowsDirectShell: 'powershell',
    }, scope, launchOptions);
}

export function buildKimiResumeLaunchSpec(sessionId: string, scope: AiSessionDirectoryScope, markerPath: string = null, launchOptions: AiSessionLaunchOptions = SAFE_LAUNCH_OPTIONS, prompt: string = null): AiSessionLaunchSpec {
    return {
        executable: 'kimi',
        args: [
            ...buildRepeatedAdditionalDirectoryArgs(scope),
            ...yoloArg(launchOptions, '--yolo'),
            '--resume', sessionId,
            ...(prompt ? ['--prompt', prompt] : []),
        ],
        cwd: scope?.primaryCwd || undefined,
        markerPath,
        windowsDirectShell: 'current',
    };
}

export function buildKimiNewSessionLaunchSpec(scope: AiSessionDirectoryScope, prompt: string = null, markerPath: string = null, launchOptions: AiSessionLaunchOptions = SAFE_LAUNCH_OPTIONS): AiSessionLaunchSpec {
    return {
        executable: 'kimi',
        args: [
            ...buildRepeatedAdditionalDirectoryArgs(scope),
            ...yoloArg(launchOptions, '--yolo'),
            ...(prompt ? ['--prompt', prompt] : []),
        ],
        cwd: scope?.primaryCwd || undefined,
        markerPath,
        windowsDirectShell: 'powershell',
    };
}

export function buildClaudeResumeLaunchSpec(sessionId: string, scope: AiSessionDirectoryScope, markerPath: string = null, launchOptions: AiSessionLaunchOptions = SAFE_LAUNCH_OPTIONS, prompt: string = null): AiSessionLaunchSpec {
    return {
        executable: 'claude',
        args: [
            ...buildClaudeAdditionalDirectoryArgs(scope),
            ...yoloArg(launchOptions, '--dangerously-skip-permissions'),
            '--resume', sessionId,
            ...(prompt ? [prompt] : []),
        ],
        cwd: scope?.primaryCwd || undefined,
        markerPath,
        windowsDirectShell: 'current',
    };
}

export function buildClaudeNewSessionLaunchSpec(scope: AiSessionDirectoryScope, title: string = null, markerPath: string = null, launchOptions: AiSessionLaunchOptions = SAFE_LAUNCH_OPTIONS, prompt: string = null): AiSessionLaunchSpec {
    return {
        executable: 'claude',
        args: [
            ...buildClaudeAdditionalDirectoryArgs(scope),
            ...yoloArg(launchOptions, '--dangerously-skip-permissions'),
            ...(title ? ['--name', title] : []),
            ...(prompt ? [prompt] : []),
        ],
        cwd: scope?.primaryCwd || undefined,
        markerPath,
        windowsDirectShell: 'powershell',
    };
}

export function buildCodexResumeCommand(sessionId: string, scope: AiSessionDirectoryScope, markerPath: string = null, platform: AiSessionCommandPlatform = process.platform): string {
    return serializeDirectLaunchCommand(buildCodexResumeLaunchSpec(sessionId, scope, markerPath), platform);
}

export function buildCodexNewSessionCommand(scope: AiSessionDirectoryScope, prompt: string = null, markerPath: string = null, platform: AiSessionCommandPlatform = process.platform): string {
    return serializeDirectLaunchCommand(buildCodexNewSessionLaunchSpec(scope, prompt, markerPath), platform);
}

export function buildKimiResumeCommand(sessionId: string, scope: AiSessionDirectoryScope, markerPath: string = null, platform: AiSessionCommandPlatform = process.platform): string {
    return serializeDirectLaunchCommand(buildKimiResumeLaunchSpec(sessionId, scope, markerPath), platform);
}

export function buildKimiNewSessionCommand(scope: AiSessionDirectoryScope, prompt: string = null, markerPath: string = null, platform: AiSessionCommandPlatform = process.platform): string {
    return serializeDirectLaunchCommand(buildKimiNewSessionLaunchSpec(scope, prompt, markerPath), platform);
}

export function buildClaudeResumeCommand(sessionId: string, scope: AiSessionDirectoryScope, markerPath: string = null, platform: AiSessionCommandPlatform = process.platform): string {
    return serializeDirectLaunchCommand(buildClaudeResumeLaunchSpec(sessionId, scope, markerPath), platform);
}

export function buildClaudeNewSessionCommand(scope: AiSessionDirectoryScope, title: string = null, markerPath: string = null, platform: AiSessionCommandPlatform = process.platform): string {
    return serializeDirectLaunchCommand(buildClaudeNewSessionLaunchSpec(scope, title, markerPath), platform);
}

export function quoteShellArg(value: string, platform: AiSessionCommandPlatform = process.platform): string {
    if (platform === 'win32') {
        return quoteWindowsCommandArg(value);
    }
    return quotePosixShellArg(value);
}

export function quotePowerShellArg(value: string): string {
    return `'${String(value).replace(/'/g, `''`)}'`;
}

export function quoteWindowsCommandArg(value: string): string {
    return `"${String(value).replace(/"/g, '\\"')}"`;
}
