'use strict';

import type { AiSessionProviderId } from '../models';
import type { AiSessionProvider, AiSessionProviderDefinition, AiSessionService } from './types';
import {
    buildClaudeNewSessionCommand,
    buildClaudeNewSessionLaunchSpec,
    buildClaudeResumeCommand,
    buildClaudeResumeLaunchSpec,
    buildCodexNewSessionCommand,
    buildCodexNewSessionLaunchSpec,
    buildCodexResumeCommand,
    buildCodexResumeLaunchSpec,
    buildKimiNewSessionCommand,
    buildKimiNewSessionLaunchSpec,
    buildKimiResumeCommand,
    buildKimiResumeLaunchSpec,
} from './commandBuilders';

export const AI_SESSION_PROVIDER_IDS: AiSessionProviderId[] = ['codex', 'kimi', 'claude'];

export const AI_SESSION_PROVIDER_DEFINITIONS: Record<AiSessionProviderId, AiSessionProviderDefinition> = {
    codex: {
        id: 'codex',
        label: 'Codex',
        commandName: 'codex',
        terminalNamePrefix: 'Codex',
        terminalEnvKey: 'AGENT_PIVOT_CODEX_SESSION_ID',
        markerDirName: 'codex-session-terminals',
        projectSessionsKey: 'codexSessions',
        projectSessionsUnavailableKey: 'codexSessionsUnavailable',
        terminalCwdFields: ['cwd'],
        buildResumeLaunchSpec: buildCodexResumeLaunchSpec,
        buildNewSessionLaunchSpec: (scope, _title, markerPath, launchOptions, initialPrompt) =>
            buildCodexNewSessionLaunchSpec(scope, initialPrompt || null, markerPath, launchOptions),
        buildResumeCommand: buildCodexResumeCommand,
        buildNewSessionCommand: (scope, _title, markerPath) => buildCodexNewSessionCommand(scope, null, markerPath),
    },
    kimi: {
        id: 'kimi',
        label: 'Kimi',
        commandName: 'kimi',
        terminalNamePrefix: 'Kimi',
        terminalEnvKey: 'AGENT_PIVOT_KIMI_SESSION_ID',
        markerDirName: 'kimi-session-terminals',
        projectSessionsKey: 'kimiSessions',
        projectSessionsUnavailableKey: 'kimiSessionsUnavailable',
        terminalCwdFields: ['workDir', 'cwd'],
        buildResumeLaunchSpec: buildKimiResumeLaunchSpec,
        buildNewSessionLaunchSpec: (scope, _title, markerPath, launchOptions, initialPrompt) =>
            buildKimiNewSessionLaunchSpec(scope, initialPrompt || null, markerPath, launchOptions),
        buildResumeCommand: buildKimiResumeCommand,
        buildNewSessionCommand: (scope, _title, markerPath) => buildKimiNewSessionCommand(scope, null, markerPath),
    },
    claude: {
        id: 'claude',
        label: 'Claude',
        commandName: 'claude',
        terminalNamePrefix: 'Claude',
        terminalEnvKey: 'AGENT_PIVOT_CLAUDE_SESSION_ID',
        markerDirName: 'claude-session-terminals',
        projectSessionsKey: 'claudeSessions',
        projectSessionsUnavailableKey: 'claudeSessionsUnavailable',
        terminalCwdFields: ['workDir', 'cwd'],
        buildResumeLaunchSpec: buildClaudeResumeLaunchSpec,
        buildNewSessionLaunchSpec: (scope, title, markerPath, launchOptions, initialPrompt) =>
            buildClaudeNewSessionLaunchSpec(scope, title || null, markerPath, launchOptions, initialPrompt || null),
        buildResumeCommand: buildClaudeResumeCommand,
        buildNewSessionCommand: buildClaudeNewSessionCommand,
    },
};

export function getAiSessionProviderDefinition(providerId: AiSessionProviderId): AiSessionProviderDefinition | null {
    return AI_SESSION_PROVIDER_DEFINITIONS[providerId] || null;
}

export function getAiSessionProviderLabel(providerId: AiSessionProviderId): string {
    return getAiSessionProviderDefinition(providerId)?.label || 'AI';
}

export interface AiSessionProviderPick {
    label: string;
    description: string;
    providerId: AiSessionProviderId;
}

export function buildAiSessionProviderPicks(
    providers: readonly Pick<AiSessionProviderDefinition, 'id' | 'label'>[]
): AiSessionProviderPick[] {
    return providers.map(provider => ({
        label: provider.label,
        description: `Open a new ${provider.label} session`,
        providerId: provider.id,
    }));
}

export interface AiSessionProviderRegistry {
    get(providerId: AiSessionProviderId): AiSessionProvider | null;
    providers(): AiSessionProvider[];
}

export function createAiSessionProviderRegistry(services: Record<AiSessionProviderId, AiSessionService>): AiSessionProviderRegistry {
    const providers = AI_SESSION_PROVIDER_IDS.map(id => ({
        ...AI_SESSION_PROVIDER_DEFINITIONS[id],
        service: services[id],
    }));
    const byId = new Map(providers.map(provider => [provider.id, provider] as [AiSessionProviderId, AiSessionProvider]));
    return {
        get: providerId => byId.get(providerId) || null,
        providers: () => providers.slice(),
    };
}
