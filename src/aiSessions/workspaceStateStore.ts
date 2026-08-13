'use strict';

import type { AiSessionProviderId } from '../models';
import {
    WORKSPACE_ACTIVE_AI_SESSION_PROVIDER_KEY,
    WORKSPACE_AI_SESSION_PROVIDER_SELECTION_KEY,
    WORKSPACE_EXPANDED_AI_SESSIONS_KEY,
    WORKSPACE_QUICK_CREATE_AI_SESSION_PROVIDER_KEY,
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

    private readProviderMap(key: string): Record<string, AiSessionProviderId> {
        const stored = this.state.get<unknown>(key);
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
            return {};
        }

        return Object.keys(stored as Record<string, unknown>).reduce((result, workspaceScopeIdentity) => {
            const providerId = (stored as Record<string, unknown>)[workspaceScopeIdentity];
            if (typeof providerId === 'string' && this.isProviderId(providerId)) {
                result[workspaceScopeIdentity] = providerId;
            }
            return result;
        }, {} as Record<string, AiSessionProviderId>);
    }

    getActiveProviders(): Record<string, AiSessionProviderId> {
        return this.readProviderMap(WORKSPACE_ACTIVE_AI_SESSION_PROVIDER_KEY);
    }

    /**
     * The provider remembered for one-click quick-create, per workspace.
     * Independent from the list-filter selection: scopes without a
     * quick-create memory fall back to the legacy active provider so
     * pre-migration installs keep their last choice.
     */
    getQuickCreateProviders(): Record<string, AiSessionProviderId> {
        return {
            ...this.getActiveProviders(),
            ...this.readProviderMap(WORKSPACE_QUICK_CREATE_AI_SESSION_PROVIDER_KEY),
        };
    }

    async setQuickCreateProvider(
        workspaceScopeIdentity: string,
        providerId: AiSessionProviderId
    ): Promise<void> {
        if (!workspaceScopeIdentity || !this.isProviderId(providerId)) {
            return;
        }

        const providers = this.readProviderMap(WORKSPACE_QUICK_CREATE_AI_SESSION_PROVIDER_KEY);
        providers[workspaceScopeIdentity] = providerId;
        await this.state.update(WORKSPACE_QUICK_CREATE_AI_SESSION_PROVIDER_KEY, providers);
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
        const normalizedSelection = normalizeAiSessionProviderSelection({
            registeredProviders: AI_SESSION_PROVIDER_IDS.filter(provider => this.isProviderId(provider)),
            primaryProvider: selection?.primaryProvider,
            selectedProviders: selection?.selectedProviders,
        });
        const previousSelections = this.state.get<unknown>(
            WORKSPACE_AI_SESSION_PROVIDER_SELECTION_KEY
        );
        const previousActiveProviders = this.state.get<unknown>(
            WORKSPACE_ACTIVE_AI_SESSION_PROVIDER_KEY
        );
        const selections = this.getProviderSelections();
        selections[workspaceScopeIdentity] = normalizedSelection;
        const activeProviders = this.getActiveProviders();
        activeProviders[workspaceScopeIdentity] = normalizedSelection.primaryProvider;

        let selectionWriteAttempted = false;
        let activeProviderWriteAttempted = false;
        try {
            selectionWriteAttempted = true;
            await this.state.update(WORKSPACE_AI_SESSION_PROVIDER_SELECTION_KEY, selections);
            activeProviderWriteAttempted = true;
            await this.state.update(WORKSPACE_ACTIVE_AI_SESSION_PROVIDER_KEY, activeProviders);
        } catch (error) {
            if (activeProviderWriteAttempted) {
                try {
                    await this.state.update(
                        WORKSPACE_ACTIVE_AI_SESSION_PROVIDER_KEY,
                        previousActiveProviders
                    );
                } catch (_rollbackError) {
                    // Continue repairing the authoritative combined record.
                }
            }
            if (selectionWriteAttempted) {
                try {
                    await this.state.update(
                        WORKSPACE_AI_SESSION_PROVIDER_SELECTION_KEY,
                        previousSelections
                    );
                } catch (_rollbackError) {
                    // The controller refreshes whichever combined record remains authoritative.
                }
            }
            throw error;
        }
    }
}
