'use strict';

import type { AiSessionProviderId } from '../models';
import {
    WORKSPACE_ACTIVE_AI_SESSION_PROVIDER_KEY,
    WORKSPACE_AI_SESSION_PROVIDER_SELECTION_KEY,
    WORKSPACE_EXPANDED_AI_SESSIONS_KEY,
} from '../constants';
import { AI_SESSION_PROVIDER_IDS } from './providers';
import { normalizeAiSessionProviderSelection } from './providerSelection';
import type { AiSessionProviderSelection } from './providerSelection';

interface MementoLike {
    get<T>(key: string): T;
    update(key: string, value: unknown): Thenable<void>;
}

export default class AiSessionWorkspaceStateStore {
    constructor(
        private readonly state: MementoLike,
        private readonly isProviderId: (value: string) => value is AiSessionProviderId,
    ) { }

    getExpandedWorkspaces(): Set<string> {
        const expandedWorkspaces = this.state.get<unknown>(WORKSPACE_EXPANDED_AI_SESSIONS_KEY);
        return new Set(
            Array.isArray(expandedWorkspaces)
                ? expandedWorkspaces.filter((workspaceScopeIdentity): workspaceScopeIdentity is string =>
                    typeof workspaceScopeIdentity === 'string' && Boolean(workspaceScopeIdentity))
                : []
        );
    }

    async setExpanded(workspaceScopeIdentity: string, expanded: boolean): Promise<void> {
        if (!workspaceScopeIdentity) {
            return;
        }

        const expandedWorkspaces = this.getExpandedWorkspaces();
        if (expanded) {
            expandedWorkspaces.add(workspaceScopeIdentity);
        } else {
            expandedWorkspaces.delete(workspaceScopeIdentity);
        }

        await this.state.update(WORKSPACE_EXPANDED_AI_SESSIONS_KEY, Array.from(expandedWorkspaces));
    }

    getActiveProviders(): Record<string, AiSessionProviderId> {
        const selectedProviders = this.state.get<unknown>(WORKSPACE_ACTIVE_AI_SESSION_PROVIDER_KEY);
        if (!selectedProviders || typeof selectedProviders !== 'object' || Array.isArray(selectedProviders)) {
            return {};
        }

        return Object.keys(selectedProviders as Record<string, unknown>).reduce((result, workspaceScopeIdentity) => {
            const providerId = (selectedProviders as Record<string, unknown>)[workspaceScopeIdentity];
            if (typeof providerId === 'string' && this.isProviderId(providerId)) {
                result[workspaceScopeIdentity] = providerId;
            }
            return result;
        }, {} as Record<string, AiSessionProviderId>);
    }

    getProviderSelections(): Record<string, AiSessionProviderSelection> {
        const storedSelections = this.state.get<unknown>(WORKSPACE_AI_SESSION_PROVIDER_SELECTION_KEY);
        if (!storedSelections || typeof storedSelections !== 'object' || Array.isArray(storedSelections)) {
            return {};
        }

        const registeredProviders = AI_SESSION_PROVIDER_IDS.filter(provider => this.isProviderId(provider));
        return Object.keys(storedSelections as Record<string, unknown>).reduce((result, workspaceScopeIdentity) => {
            const stored = (storedSelections as Record<string, unknown>)[workspaceScopeIdentity];
            if (!workspaceScopeIdentity || !stored || typeof stored !== 'object' || Array.isArray(stored)) {
                return result;
            }
            const { primaryProvider, selectedProviders } = stored as {
                primaryProvider?: unknown;
                selectedProviders?: unknown;
            };
            const hasRegisteredProvider = [primaryProvider]
                .concat(Array.isArray(selectedProviders) ? selectedProviders : [])
                .some((provider): provider is string =>
                    typeof provider === 'string' && this.isProviderId(provider));
            if (!hasRegisteredProvider) {
                return result;
            }
            result[workspaceScopeIdentity] = normalizeAiSessionProviderSelection({
                registeredProviders,
                primaryProvider,
                selectedProviders,
            });
            return result;
        }, {} as Record<string, AiSessionProviderSelection>);
    }

    async setActiveProvider(
        workspaceScopeIdentity: string,
        providerId: AiSessionProviderId
    ): Promise<void> {
        if (!workspaceScopeIdentity || !this.isProviderId(providerId)) {
            return;
        }

        const selectedProviders = this.getActiveProviders();
        selectedProviders[workspaceScopeIdentity] = providerId;
        await this.state.update(WORKSPACE_ACTIVE_AI_SESSION_PROVIDER_KEY, selectedProviders);
    }

    async setProviderSelection(
        workspaceScopeIdentity: string,
        selection: AiSessionProviderSelection
    ): Promise<void> {
        if (!workspaceScopeIdentity) {
            return;
        }
        const selections = this.getProviderSelections();
        selections[workspaceScopeIdentity] = {
            primaryProvider: selection.primaryProvider,
            selectedProviders: [...selection.selectedProviders],
        };
        await this.state.update(WORKSPACE_AI_SESSION_PROVIDER_SELECTION_KEY, selections);

        const activeProviders = this.getActiveProviders();
        activeProviders[workspaceScopeIdentity] = selection.primaryProvider;
        await this.state.update(WORKSPACE_ACTIVE_AI_SESSION_PROVIDER_KEY, activeProviders);
    }
}
