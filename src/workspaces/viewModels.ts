'use strict';

import type { AiSessionProviderId } from '../models';
import { normalizeAiSessionProviderSelection } from '../aiSessions/providerSelection';
import type { AiSessionProviderSelection } from '../aiSessions/providerSelection';
import type {
    ActiveAiSessionViewModel,
    AiSessionProviderDefinition,
    AiSessionViewModel,
    WorktreeRowViewModel,
    WorkspaceAiSessionViewModel,
} from '../aiSessions/types';
import type { OpenWorkspace } from './types';
import type { ProvisioningWorktreeRow, WorktreeSnapshot } from '../worktrees/types';
import { worktreeKeysEqual } from '../worktrees/types';
import { isManagedWorktreePath } from '../worktrees/provisioningPlan';
import { isWorkspaceHostPathContained } from './sessionAssignment';

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
    /** The AI session surface the user last selected for this workspace. */
    selectedSurface?: 'worktree' | 'chats';
    /** Configured managed-worktree directory (relative to each repository root). */
    worktreeDirectory?: string;
    worktreeSnapshot?: WorktreeSnapshot | null;
    provisioningWorktrees?: readonly ProvisioningWorktreeRow[];
}

export function buildWorkspaceAiSessionViewModel(
    input: BuildWorkspaceAiSessionViewModelInput
): WorkspaceAiSessionViewModel {
    const unavailableProviders = new Set(input.unavailableProviders);
    const sessionsByProvider: Partial<Record<AiSessionProviderId, AiSessionViewModel[]>> = {};
    const providers = input.providers.map(provider => {
        const sessions = (input.sessionsByProvider[provider.id] || []).map(cloneHistorySession);
        sessionsByProvider[provider.id] = sessions;
        return {
            id: provider.id,
            label: provider.label,
            count: sessions.length,
            ...(unavailableProviders.has(provider.id) ? { unavailable: true } : {}),
        };
    });
    const activeSessions = input.activeSessions.map(cloneActiveSession);
    const allSessions: AiSessionViewModel[] = [];
    input.providers.forEach(provider => allSessions.push(...(sessionsByProvider[provider.id] || [])));
    const worktrees = buildWorktreeRows(
        input.workspace,
        input.worktreeSnapshot,
        allSessions,
        activeSessions,
        input.provisioningWorktrees,
        input.worktreeDirectory,
    );
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
        ...(input.selectedSurface === 'worktree' || input.selectedSurface === 'chats'
            ? { selectedSurface: input.selectedSurface }
            : {}),
        ...(input.worktreeDirectory ? { worktreeDirectory: input.worktreeDirectory } : {}),
        activeSessions,
        activeSessionCount: activeSessions.length,
        activeAttentionCount: activeSessions.filter(session => session.needsAttention).length,
        worktrees,
        ...(input.worktreeSnapshot ? {
            worktreeRepositoryCount: input.worktreeSnapshot.repositories.length,
            bareWorktreeCount: input.worktreeSnapshot.repositories.reduce(
                (count, repository) => count
                    + repository.worktrees.filter(worktree => worktree.isBare).length,
                0
            ),
        } : {}),
        unmanagedSessions: allSessions.filter(session => !session.worktreeKey),
        unmanagedActiveSessions: activeSessions.filter(session => !session.worktreeKey),
        ...(input.worktreeSnapshot ? {
            worktreeSnapshotRevision: input.worktreeSnapshot.revision,
        } : {}),
        truncatedWorktreeCount: input.worktreeSnapshot?.truncatedWorktreeCount || 0,
        ...(input.quickCreateProfile ? { quickCreateProfile: input.quickCreateProfile } : {}),
        ...(input.quickCreateProvider ? { quickCreateProvider: input.quickCreateProvider } : {}),
    };
}

function cloneHistorySession(session: AiSessionViewModel): AiSessionViewModel {
    return {
        ...session,
        ...(session.worktreeKey ? { worktreeKey: { ...session.worktreeKey } } : {}),
    };
}

function cloneActiveSession(session: ActiveAiSessionViewModel): ActiveAiSessionViewModel {
    return {
        ...session,
        ...(session.worktreeKey ? { worktreeKey: { ...session.worktreeKey } } : {}),
    };
}

function buildWorktreeRows(
    workspace: OpenWorkspace,
    snapshot: WorktreeSnapshot | null | undefined,
    sessions: readonly AiSessionViewModel[],
    activeSessions: readonly ActiveAiSessionViewModel[],
    provisioningWorktrees: readonly ProvisioningWorktreeRow[] = [],
    worktreeDirectory?: string,
): WorktreeRowViewModel[] {
    if (!snapshot) {
        return [];
    }
    const workspaceRootIds = new Set(workspace.roots.map(root => root.id));
    const rows: WorktreeRowViewModel[] = [];
    snapshot.repositories
        .filter(repository => repository.rootBindings.some(binding =>
            workspaceRootIds.has(binding.workspaceRootId)))
        .forEach(repository => repository.worktrees.forEach(worktree => {
            const worktreeSessions = sessions
                .filter(session => !!session.worktreeKey
                    && worktreeKeysEqual(session.worktreeKey, worktree.key));
            const liveSessions = activeSessions.filter(session => !!session.worktreeKey
                && worktreeKeysEqual(session.worktreeKey, worktree.key));
            const needsAttention = worktreeSessions.some(session => session.attention?.unread)
                || liveSessions.some(session => session.needsAttention);
            const liveOwnerAvailable = liveSessions.length > 0;
            const usable = !worktree.isBare
                && worktree.health !== 'missing'
                && worktree.health !== 'prunable';
            const openAsWorkspace = inputWorkspaceUsesWorktree(
                workspace,
                worktree.key.canonicalWorktreePath
            );
            rows.push({
                kind: 'ready' as const,
                git: {
                    ...worktree,
                    key: { ...worktree.key },
                },
                activity: needsAttention ? 'attention' as const
                    : liveOwnerAvailable ? 'active' as const
                        : 'idle' as const,
                sessions: worktreeSessions,
                authority: {
                    canInput: liveOwnerAvailable,
                    canFocus: liveOwnerAvailable,
                    canStop: liveOwnerAvailable,
                    canResume: usable,
                    canArchive: worktreeSessions.length > 0,
                    canRemove: usable && !worktree.isMain && !liveOwnerAvailable
                        && !openAsWorkspace
                        && isManagedWorktreePath(
                            worktree.key.repositoryKey,
                            worktree.key.canonicalWorktreePath,
                            worktreeDirectory),
                    canTakeControl: false,
                    liveOwnerAvailable,
                },
            });
        }));
    const repositoryKeys = new Set(snapshot.repositories
        .filter(repository => repository.rootBindings.some(binding =>
            workspaceRootIds.has(binding.workspaceRootId)))
        .map(repository => repository.repositoryKey));
    provisioningWorktrees
        .filter(row => repositoryKeys.has(row.repositoryKey))
        .forEach(row => rows.unshift({
            ...row,
            completedSteps: row.completedSteps.slice(),
        }));
    return rows;
}

function inputWorkspaceUsesWorktree(workspace: OpenWorkspace, worktreePath: string): boolean {
    return workspace.roots.some(root =>
        isWorkspaceHostPathContained(worktreePath, root.hostPath));
}
