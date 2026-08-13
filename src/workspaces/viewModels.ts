'use strict';

import type { AiSessionProviderId } from '../models';
import { normalizeAiSessionProviderSelection } from '../aiSessions/providerSelection';
import type { AiSessionProviderSelection } from '../aiSessions/providerSelection';
import type {
    ActiveAiSessionViewModel,
    AiSessionProviderDefinition,
    AiSessionViewModel,
    WorkspaceAiSessionViewModel,
} from '../aiSessions/types';
import type { OpenWorkspace } from './types';

export interface BuildWorkspaceAiSessionViewModelInput {
    workspace: OpenWorkspace;
    providers: readonly Pick<AiSessionProviderDefinition, 'id' | 'label'>[];
    sessionsByProvider: Partial<Record<AiSessionProviderId, AiSessionViewModel[]>>;
    unavailableProviders: readonly AiSessionProviderId[];
    activeSessions: readonly ActiveAiSessionViewModel[];
    attentionCount: number;
    activeProvider?: AiSessionProviderId;
    providerSelection?: AiSessionProviderSelection;
    expanded?: boolean;
    /** The Codex profile a picker-free quick-create would launch with, when any. */
    quickCreateProfile?: string;
    /** The provider quick-create remembers for this workspace, when any. */
    quickCreateProvider?: AiSessionProviderId;
}

export function buildWorkspaceAiSessionViewModel(
    input: BuildWorkspaceAiSessionViewModelInput
): WorkspaceAiSessionViewModel {
    const unavailableProviders = new Set(input.unavailableProviders);
    const sessionsByProvider: Partial<Record<AiSessionProviderId, AiSessionViewModel[]>> = {};
    const providers = input.providers.map(provider => {
        const sessions = (input.sessionsByProvider[provider.id] || []).map(session => ({ ...session }));
        sessionsByProvider[provider.id] = sessions;
        return {
            id: provider.id,
            label: provider.label,
            count: sessions.length,
            ...(unavailableProviders.has(provider.id) ? { unavailable: true } : {}),
        };
    });
    const activeSessions = input.activeSessions.map(session => ({ ...session }));
    const selection = normalizeAiSessionProviderSelection({
        registeredProviders: input.providers.map(provider => provider.id),
        primaryProvider: input.providerSelection?.primaryProvider || input.activeProvider,
        selectedProviders: input.providerSelection?.selectedProviders,
        sessionCounts: providers.reduce((counts, provider) => {
            counts[provider.id] = provider.count;
            return counts;
        }, {} as Partial<Record<AiSessionProviderId, number>>),
    });

    return {
        workspaceScopeIdentity: input.workspace.scopeIdentity,
        workspaceNavigationIdentity: input.workspace.navigationIdentity,
        activeProvider: selection.primaryProvider,
        selectedProviders: selection.selectedProviders,
        expanded: Boolean(input.expanded),
        providers,
        sessionsByProvider,
        unavailableProviders: input.providers
            .filter(provider => unavailableProviders.has(provider.id))
            .map(provider => provider.id),
        aiSessionCount: providers.reduce((count, provider) => count + provider.count, 0),
        attentionCount: input.attentionCount,
        defaultTab: activeSessions.length ? 'active' : 'sessions',
        activeSessions,
        activeSessionCount: activeSessions.length,
        activeAttentionCount: activeSessions.filter(session => session.needsAttention).length,
        ...(input.quickCreateProfile ? { quickCreateProfile: input.quickCreateProfile } : {}),
        ...(input.quickCreateProvider ? { quickCreateProvider: input.quickCreateProvider } : {}),
    };
}
