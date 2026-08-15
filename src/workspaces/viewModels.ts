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
import { isWorkspaceHostPathContained } from './sessionAssignment';
import type { WorktreeGroup } from '../worktrees/groupManifestStore';
import { buildWorktreeGroupProjection } from './worktreeGroupProjection';
import type { DeletionJournalEntry } from '../worktrees/deletionJournal';

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
    worktreeSnapshot?: WorktreeSnapshot | null;
    provisioningWorktrees?: readonly ProvisioningWorktreeRow[];
    /** Authoritative manifest bucket for this workspace (PRD §5.2). */
    worktreeGroups?: readonly WorktreeGroup[];
    /** Active deletion journals for this workspace bucket (PRD §6.4). */
    deletionJournals?: readonly DeletionJournalEntry[];
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
    const groupProjection = buildWorktreeGroupProjection({
        workspace: input.workspace,
        snapshot: input.worktreeSnapshot,
        groups: input.worktreeGroups || [],
        deletionJournals: input.deletionJournals || [],
        sessions: allSessions,
        activeSessions,
    });
    const provisioningRows = visibleProvisioningRows(
        input.workspace,
        input.worktreeSnapshot,
        input.provisioningWorktrees,
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
        activeSessions,
        activeSessionCount: activeSessions.length,
        activeAttentionCount: activeSessions.filter(session => session.needsAttention).length,
        worktreeAnchor: groupProjection.anchor,
        worktreeGroups: groupProjection.groups,
        worktrees: [
            ...provisioningRows,
            ...groupProjection.unmanaged,
        ],
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

function visibleProvisioningRows(
    workspace: OpenWorkspace,
    snapshot: WorktreeSnapshot | null | undefined,
    provisioningWorktrees: readonly ProvisioningWorktreeRow[] = [],
): ProvisioningWorktreeRow[] {
    if (!snapshot) {
        return [];
    }
    const workspaceRootIds = new Set(workspace.roots.map(root => root.id));
    const repositoryKeys = new Set(snapshot.repositories
        .filter(repository => repository.rootBindings.some(binding =>
            workspaceRootIds.has(binding.workspaceRootId)))
        .map(repository => repository.repositoryKey));
    return provisioningWorktrees
        .filter(row => repositoryKeys.has(row.repositoryKey))
        .map(row => ({
            ...row,
            completedSteps: row.completedSteps.slice(),
        }));
}
