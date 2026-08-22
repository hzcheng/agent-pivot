'use strict';

import type { AiSessionProviderId } from '../models';
import {
    WORKSPACE_ACTIVE_AI_SESSION_PROVIDER_KEY,
    WORKSPACE_AI_SESSION_PROVIDER_SELECTION_KEY,
    WORKSPACE_AI_SESSION_SURFACE_KEY,
    WORKSPACE_AI_SESSION_VIEW_STATE_KEY,
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

export type AiSessionSurfaceId = 'worktree' | 'chats';

/** M2 window-scoped OPEN tab view state (PRD 状态模型: CHATS/ALL tab, CHATS 视图模式, worktree 组折叠集合). */
export type AiSessionWindowViewTab = 'chats' | 'all';
export type AiSessionChatsViewMode = 'tree' | 'list';
export interface AiSessionWindowViewState {
    tab?: AiSessionWindowViewTab;
    chatsViewMode?: AiSessionChatsViewMode;
    collapsedWorktreeGroups?: string[];
}

const MAX_COLLAPSED_WORKTREE_GROUPS = 500;
const MAX_WORKTREE_GROUP_KEY_LENGTH = 1024;

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
        return this.readProviderSelections();
    }

    getSelectedSurfaces(): Record<string, AiSessionSurfaceId> {
        const stored = this.state.get<unknown>(WORKSPACE_AI_SESSION_SURFACE_KEY);
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
            return {};
        }
        return Object.keys(stored as Record<string, unknown>).reduce((result, workspaceScopeIdentity) => {
            const surface = (stored as Record<string, unknown>)[workspaceScopeIdentity];
            if (workspaceScopeIdentity && (surface === 'worktree' || surface === 'chats')) {
                result[workspaceScopeIdentity] = surface;
            }
            return result;
        }, {} as Record<string, AiSessionSurfaceId>);
    }

    // --- M2 window view state (additive; PR-D makes it the render source) ---

    private readWindowViewStates(): Record<string, AiSessionWindowViewState> {
        const stored = this.state.get<unknown>(WORKSPACE_AI_SESSION_VIEW_STATE_KEY);
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
            return {};
        }
        const result: Record<string, AiSessionWindowViewState> = {};
        for (const [scopeIdentity, value] of Object.entries(stored as Record<string, unknown>)) {
            if (!scopeIdentity || !value || typeof value !== 'object' || Array.isArray(value)) {
                continue;
            }
            const record = value as Record<string, unknown>;
            const entry: AiSessionWindowViewState = {};
            if (record.tab === 'chats' || record.tab === 'all') {
                entry.tab = record.tab;
            }
            if (record.chatsViewMode === 'tree' || record.chatsViewMode === 'list') {
                entry.chatsViewMode = record.chatsViewMode;
            }
            if (Array.isArray(record.collapsedWorktreeGroups)) {
                const keys = record.collapsedWorktreeGroups
                    .filter((key): key is string =>
                        typeof key === 'string'
                        && key.length > 0
                        && key.length <= MAX_WORKTREE_GROUP_KEY_LENGTH)
                    .slice(0, MAX_COLLAPSED_WORKTREE_GROUPS);
                entry.collapsedWorktreeGroups = Array.from(new Set(keys));
            }
            result[scopeIdentity] = entry;
        }
        return result;
    }

    /**
     * The window's resolved view state. Unstored fields fall to the CHATS +
     * tree defaults, which double as the存量迁移 mapping: a legacy 'worktree'
     * surface lands on CHATS + tree, and a legacy 'chats' surface refines the
     * tab through the webview's one-time legacy sub-tab import
     * (`importLegacyWindowViewTab`: sub-tab 'sessions' → ALL).
     */
    getWindowViewState(workspaceScopeIdentity: string): AiSessionWindowViewState {
        if (!workspaceScopeIdentity) {
            return {};
        }
        const stored = this.readWindowViewStates()[workspaceScopeIdentity];
        if (stored?.tab && stored?.chatsViewMode) {
            return stored;
        }
        return {
            tab: stored?.tab ?? 'chats',
            chatsViewMode: stored?.chatsViewMode ?? 'tree',
            ...(stored?.collapsedWorktreeGroups
                ? { collapsedWorktreeGroups: stored.collapsedWorktreeGroups }
                : {}),
        };
    }

    private async updateWindowViewState(
        workspaceScopeIdentity: string,
        patch: (current: AiSessionWindowViewState) => AiSessionWindowViewState,
    ): Promise<void> {
        if (!workspaceScopeIdentity) {
            return;
        }
        const states = this.readWindowViewStates();
        states[workspaceScopeIdentity] = patch(states[workspaceScopeIdentity] || {});
        await this.state.update(WORKSPACE_AI_SESSION_VIEW_STATE_KEY, states);
    }

    async setWindowViewTab(
        workspaceScopeIdentity: string,
        tab: AiSessionWindowViewTab
    ): Promise<void> {
        if (tab !== 'chats' && tab !== 'all') {
            return;
        }
        await this.updateWindowViewState(workspaceScopeIdentity, current => ({
            ...current,
            tab,
        }));
    }

    async setChatsViewMode(
        workspaceScopeIdentity: string,
        viewMode: AiSessionChatsViewMode
    ): Promise<void> {
        if (viewMode !== 'tree' && viewMode !== 'list') {
            return;
        }
        await this.updateWindowViewState(workspaceScopeIdentity, current => ({
            ...current,
            chatsViewMode: viewMode,
        }));
    }

    async setCollapsedWorktreeGroups(
        workspaceScopeIdentity: string,
        collapsedKeys: readonly string[]
    ): Promise<void> {
        // A non-array payload is junk, not a clear-all: only an explicit
        // (possibly empty) array replaces the collapsed set.
        if (!Array.isArray(collapsedKeys)) {
            return;
        }
        const keys = collapsedKeys
            .filter((key): key is string =>
                typeof key === 'string'
                && key.length > 0
                && key.length <= MAX_WORKTREE_GROUP_KEY_LENGTH)
            .slice(0, MAX_COLLAPSED_WORKTREE_GROUPS);
        await this.updateWindowViewState(workspaceScopeIdentity, current => ({
            ...current,
            collapsedWorktreeGroups: Array.from(new Set(keys)),
        }));
    }

    /**
     * One-time legacy import from the webview-held sub-tab state: fills the
     * window's tab only when no new tab was persisted yet. A legacy 'worktree'
     * surface migrates to CHATS regardless of the hidden sub-tab (PRD 存量迁移),
     * so the import stays out of that case; 'chats' + sub-tab 'sessions' maps
     * to ALL through the import.
     */
    async importLegacyWindowViewTab(
        workspaceScopeIdentity: string,
        tab: AiSessionWindowViewTab
    ): Promise<boolean> {
        if (!workspaceScopeIdentity || (tab !== 'chats' && tab !== 'all')) {
            return false;
        }
        if (this.readWindowViewStates()[workspaceScopeIdentity]?.tab) {
            return false;
        }
        if (this.getSelectedSurfaces()[workspaceScopeIdentity] === 'worktree') {
            return false;
        }
        await this.updateWindowViewState(workspaceScopeIdentity, current => ({
            ...current,
            tab,
        }));
        return true;
    }

    private readProviderSelections(): Record<string, AiSessionProviderSelection> {
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
