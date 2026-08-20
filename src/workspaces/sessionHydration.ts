'use strict';

import type { AiSessionProviderId, CodexSession } from '../models';
import type { ActiveAiSessionTerminalIdentity } from '../aiSessions/activeTerminalHighlight';
import type { AttentionAggregate } from '../aiSessions/attentionAggregate';
import type { AiSessionExecutionSnapshot } from '../aiSessions/executionMonitor';
import type {
    AiSessionPendingRuntimeSnapshot,
    AiSessionRuntimeIdentity,
    AiSessionRuntimeSnapshot,
} from '../aiSessions/runtimeTypes';
import type {
    ActiveAiSessionViewModel,
    AiSessionProviderDefinition,
    AiSessionReadResult,
    AiSessionViewModel,
    SessionProfileDecision,
    WorkspaceAiSessionViewModel,
} from '../aiSessions/types';
import type { AiSessionProviderSelection } from '../aiSessions/providerSelection';
import { getAiSessionKey, prepareAiSessionsForDisplay } from '../aiSessions/sessionHelpers';
import {
    assignPathToWorkspaceRoot,
    getWorkspaceHostPathComparisonKey,
    isWorkspaceHostPathContained,
    normalizeWorkspaceHostPath,
} from '../sessionAssignment';
import { hasWorkspaceRuntimeContinuity } from '../runtimeOwnership';
export { hasWorkspaceRuntimeContinuity } from '../runtimeOwnership';
import {
    projectWorkspaceActiveSessions,
    WorkspaceActiveSessionPresentation,
} from './activeSessionPresentation';
import type { OpenWorkspace, WorkspaceRoot } from './types';
import {
    buildWorkspaceSessionAttentionIndex,
    getWorkspaceSessionAttention,
} from './sessionAttention';
import type { ProvisioningWorktreeRow, WorktreeSnapshot } from '../worktrees';
import type { WorktreeGroup } from '../worktrees';
import type { WorktreeKey } from '../worktrees';
import { mapWorktreeBoundHostPaths } from './sessionScope';
import type { DeletionJournalEntry } from '../worktrees';
import type {
    GenerationClaim,
    RetiredWorktreeIdentity,
} from '../worktrees';
import {
    findLatestRetirementForPath,
    judgeSessionGeneration,
} from '../worktrees';
import {
    findGroupMemberWorktreeKeyForPath,
    manifestClaimsWorktreeKey,
} from './worktreeGroupProjection';
import { buildWorkspaceAiSessionViewModel } from './viewModels';
import {
    assignPathToWorkspaceWorktree,
    getWorkspaceWorktreeCandidatePaths,
} from '../worktreeSessionAssignment';

type HydrationProvider = Pick<AiSessionProviderDefinition, 'id' | 'label'>;

export interface HydrateWorkspaceAiSessionsInput<TTerminal = unknown> {
    workspace: OpenWorkspace;
    /** Coherent discovery input reserved for worktree-aware projection. */
    worktreeSnapshot?: WorktreeSnapshot | null;
    provisioningWorktrees?: readonly ProvisioningWorktreeRow[];
    /** Authoritative worktree group manifest bucket for this workspace. */
    worktreeGroups?: readonly WorktreeGroup[];
    /** Active deletion journals for this workspace bucket (PRD §6.4). */
    deletionJournals?: readonly DeletionJournalEntry[];
    /** Retired worktree identities for this workspace bucket (PRD §6.4). */
    retiredWorktreeIdentities?: readonly RetiredWorktreeIdentity[];
    /** Generation claims for this workspace bucket (PRD §6.4). */
    generationClaims?: readonly GenerationClaim[];
    /**
     * Quarantine signal for the retired store (PRD §6.4): while set, every
     * session that cannot be positively placed is unknown — and unknown
     * means unresumable.
     */
    retiredStoreCorrupt?: boolean;
    /** Authoritative clock for generation judgment (clock-drift fail-closed). */
    nowMs?: () => number;
    providers: readonly HydrationProvider[];
    sessionResults: Record<AiSessionProviderId, AiSessionReadResult>;
    getSessionComparableCwd: (providerId: AiSessionProviderId, session: CodexSession) => string;
    pinnedSessions: ReadonlySet<string>;
    aliases: Readonly<Record<string, string>>;
    /** Recorded Codex profile decisions keyed by `provider:sessionId`. */
    profiles?: Readonly<Record<string, SessionProfileDecision>>;
    /** Recorded Codex profile decisions for pending runtimes, keyed by pendingId. */
    pendingProfiles?: Readonly<Record<string, SessionProfileDecision>>;
    /** Availability of each referenced profile's config file. */
    profileAvailability?: Readonly<Record<string, boolean>>;
    /** The Codex profile a picker-free quick-create would launch with, when any. */
    quickCreateProfile?: string;
    /** The provider quick-create remembers for this workspace, when any. */
    quickCreateProvider?: AiSessionProviderId;
    activeRuntimes?: readonly AiSessionRuntimeSnapshot<TTerminal>[];
    pendingRuntimes?: readonly AiSessionPendingRuntimeSnapshot<TTerminal>[];
    executionSnapshot?: Readonly<Record<string, AiSessionExecutionSnapshot>>;
    focusedIdentity?: AiSessionRuntimeIdentity | ActiveAiSessionTerminalIdentity | null;
    attentionAggregate?: AttentionAggregate | null;
    activePresentation?: WorkspaceActiveSessionPresentation;
    activeProvider?: AiSessionProviderId;
    providerSelection?: AiSessionProviderSelection;
    selectedSurface?: 'worktree' | 'chats';
    expanded?: boolean;
}

export function getWorkspaceAiSessionCandidatePaths(
    workspace: OpenWorkspace | null,
    worktreeSnapshot?: WorktreeSnapshot | null,
): string[] {
    return getWorkspaceWorktreeCandidatePaths(workspace, worktreeSnapshot);
}

interface AssignedHistory {
    session: CodexSession;
    root: WorkspaceRoot | null;
    worktreeKey?: import('../worktrees').WorktreeKey;
    worktreeUnavailable?: boolean;
}

interface SortableActiveSession extends ActiveAiSessionViewModel {
    activityMs: number;
    sourceOrder: number;
}

interface ProjectablePendingRuntime<TTerminal> extends AiSessionPendingRuntimeSnapshot<TTerminal> {
    projectionConflict?: boolean;
}

export function hydrateWorkspaceAiSessions<TTerminal = unknown>(
    input: HydrateWorkspaceAiSessionsInput<TTerminal>
): WorkspaceAiSessionViewModel {
    const activePresentation = input.activePresentation
        || projectWorkspaceActiveSessions({
            workspace: input.workspace,
            activeRuntimes: input.activeRuntimes || [],
            pendingRuntimes: input.pendingRuntimes || [],
            executionSnapshot: input.executionSnapshot || {},
            focusedIdentity: input.focusedIdentity || null,
            attentionAggregate: input.attentionAggregate || null,
        });
    const attentionByRootAndSession = buildWorkspaceSessionAttentionIndex(
        input.attentionAggregate || null
    );
    const activeRuntimes = deduplicateActiveRuntimes((input.activeRuntimes || [])
        .filter(runtime => hasWorkspaceRuntimeContinuity(input.workspace, runtime)));
    const pendingRuntimes = deduplicatePendingRuntimes((input.pendingRuntimes || [])
        .filter(runtime => hasWorkspaceRuntimeContinuity(input.workspace, runtime)
            && (!!assignPathToWorkspaceWorktree(
                runtime.identity.cwd,
                input.workspace,
                input.worktreeSnapshot,
                runtime.identity.worktreeKey,
            ) || !!assignPathToWorkspaceRoot(runtime.identity.cwd, input.workspace.roots)
            || !!findGroupMemberWorktreeKeyForPath(
                input.worktreeGroups || [], runtime.identity.cwd))));
    const activeSessionKeys = new Set(activeRuntimes
        .filter(runtime => !!runtime.identity.sessionId)
        .map(runtime => getAiSessionKey(runtime.identity.provider, runtime.identity.sessionId)));
    const focusedTarget = activePresentation.focusedTarget;
    const focusedSessionKey = focusedTarget?.sessionId
        ? getAiSessionKey(focusedTarget.provider, focusedTarget.sessionId)
        : null;
    const focusedPendingKey = focusedTarget?.pendingId
        ? pendingKey(focusedTarget.provider, focusedTarget.pendingId)
        : null;
    const sessionsByProvider: Partial<Record<AiSessionProviderId, AiSessionViewModel[]>> = {};
    const unavailableProviders: AiSessionProviderId[] = [];

    for (const provider of input.providers) {
        const result = input.sessionResults[provider.id];
        if (!result?.available) {
            unavailableProviders.push(provider.id);
            sessionsByProvider[provider.id] = [];
            continue;
        }
        const assigned = assignHistorySessions(
            provider.id,
            result.sessions,
            input.workspace,
            input.worktreeSnapshot,
            input.getSessionComparableCwd,
            input.worktreeGroups,
            input.retiredWorktreeIdentities,
            input.generationClaims,
            input.nowMs,
            input.retiredStoreCorrupt
        );
        const assignmentBySessionId = new Map(assigned.map(item => [item.session.id, item]));
        sessionsByProvider[provider.id] = prepareAiSessionsForDisplay(
            assigned.map(item => item.session),
            provider.id,
            new Set(input.pinnedSessions),
            { ...input.aliases }
        ).map(session => {
            const assignment = assignmentBySessionId.get(session.id);
            const root = assignment?.root;
            const key = getAiSessionKey(provider.id, session.id);
            const attention = root && getWorkspaceSessionAttention(
                attentionByRootAndSession,
                root.uri,
                provider.id,
                session.id
            );
            return {
                ...session,
                provider: provider.id,
                ...profileMetadata(input.profiles?.[key], input.profileAvailability),
                active: activeSessionKeys.has(key),
                focused: focusedSessionKey === key,
                ...(attention ? { attention } : {}),
                ...rootMetadata(root || null),
                ...(assignment?.worktreeKey ? {
                    worktreeKey: { ...assignment.worktreeKey },
                } : {}),
                ...(assignment?.worktreeUnavailable ? { worktreeUnavailable: true } : {}),
            };
        });
    }

    const activeSessions = buildActiveSessions({
        input,
        sessionsByProvider,
        activeRuntimes,
        pendingRuntimes,
        activePresentation,
        focusedPendingKey,
    });
    return buildWorkspaceAiSessionViewModel({
        workspace: input.workspace,
        providers: input.providers,
        sessionsByProvider,
        unavailableProviders,
        activeSessions,
        attentionCount: activePresentation.attentionCount,
        activeProvider: input.activeProvider,
        providerSelection: input.providerSelection,
        selectedSurface: input.selectedSurface,
        expanded: input.expanded,
        quickCreateProfile: input.quickCreateProfile,
        quickCreateProvider: input.quickCreateProvider,
        worktreeSnapshot: input.worktreeSnapshot,
        provisioningWorktrees: input.provisioningWorktrees,
        worktreeGroups: input.worktreeGroups,
        deletionJournals: input.deletionJournals,
    });
}

function assignHistorySessions(
    providerId: AiSessionProviderId,
    sessions: readonly CodexSession[],
    workspace: OpenWorkspace,
    worktreeSnapshot: WorktreeSnapshot | null | undefined,
    getSessionComparableCwd: (providerId: AiSessionProviderId, session: CodexSession) => string,
    worktreeGroups?: readonly WorktreeGroup[],
    retiredIdentities?: readonly RetiredWorktreeIdentity[],
    generationClaims?: readonly GenerationClaim[],
    nowMs?: () => number,
    retiredStoreCorrupt?: boolean,
): AssignedHistory[] {
    const seen = new Set<string>();
    const assigned: AssignedHistory[] = [];
    for (const session of sessions || []) {
        if (!session?.id || seen.has(session.id)) {
            continue;
        }
        seen.add(session.id);
        const cwd = getSessionComparableCwd(providerId, session);
        const worktree = assignPathToWorkspaceWorktree(cwd, workspace, worktreeSnapshot);
        // Manifest fallback (PRD §6.4): history keeps the worktree identity
        // even after the physical worktree is deleted — including worktrees
        // outside the workspace roots, which would otherwise vanish.
        const manifestKey = worktree
            ? null
            : findGroupMemberWorktreeKeyForPath(worktreeGroups || [], cwd);
        // Retired identity fallback (PRD §6.4): once a journaled deletion
        // removes the manifest member, the retired record keeps the history
        // identity — but only for the pre-deletion generation. Sessions of
        // a later generation (explicit claim, or a stable creation time
        // past the cutoff) are not claimed by the retired record.
        const retired = worktree || manifestKey
            ? null
            : findLatestRetirementForPath(
                retiredIdentities || [],
                cwd,
                normalizeWorkspaceHostPath,
                isWorkspaceHostPathContained);
        const retiredGeneration = retired
            ? judgeSessionGeneration(retired, {
                provider: providerId,
                sessionId: session.id,
                createdAtMs: parseSessionCreatedAtMs(session),
            }, generationClaims || [], retiredIdentities || [],
                nowMs ? nowMs() : Date.now())
            : null;
        const retiredKey = retired && retiredGeneration === 'retired'
            ? {
                repositoryKey: retired.repositoryKey,
                canonicalWorktreePath: retired.canonicalWorktreePath,
            }
            : null;
        const root = worktree?.root
            || (manifestKey || retiredKey ? null : assignPathToWorkspaceRoot(cwd, workspace.roots));
        // While the retired store is quarantined, a root-fallback session
        // might actually belong to a deleted worktree we can no longer see:
        // unknown means unresumable. Sessions sitting directly on a
        // workspace root (the Current anchor's domain) are unaffected.
        const corruptUnknown = !!retiredStoreCorrupt && !worktree && !manifestKey
            && !retiredKey && !!root
            && normalizeWorkspaceHostPath(root.hostPath)
                !== normalizeWorkspaceHostPath(cwd);
        const worktreeUnavailable = !!manifestKey || !!retiredKey || corruptUnknown
            || !!worktree && (worktree.worktree.health === 'missing'
                || worktree.worktree.health === 'prunable');
        if (worktree || manifestKey || retiredKey || root) {
            assigned.push({
                session: { ...session },
                root,
                ...(worktree
                    ? { worktreeKey: { ...worktree.worktree.key } }
                    : manifestKey
                        ? { worktreeKey: manifestKey }
                        : retiredKey ? { worktreeKey: retiredKey } : {}),
                ...(worktreeUnavailable ? { worktreeUnavailable: true } : {}),
            });
        }
    }
    return assigned;
}

function parseSessionCreatedAtMs(session: CodexSession): number | undefined {
    if (!session.createdAt) {
        return undefined;
    }
    const parsed = Date.parse(session.createdAt);
    return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Scope-outdated judgment (PRD §6.3 决策 D): a live group session's
 * persisted writable roots no longer MATCH the group's expected scope —
 * a member added after the start leaves the session unable to write it,
 * and a member removed after the start leaves the session with write
 * access to a worktree that no longer belongs to the task. Both
 * directions flag the row. The expected scope maps every ready,
 * non-detached member's visible repository bindings into its worktree;
 * comparison is normalized and case/path-separator safe. Unknown
 * persisted scope means no hint — never a guess.
 */
export function isGroupSessionScopeOutdated(
    runtime: {
        identity: {
            worktreeKey?: WorktreeKey;
            isolatedRoots?: boolean;
            writableRootHostPaths?: readonly string[];
        };
    },
    groups: readonly WorktreeGroup[],
    snapshot: WorktreeSnapshot | null | undefined,
    workspace: OpenWorkspace
): boolean {
    const key = runtime.identity.worktreeKey;
    if (!key || !runtime.identity.isolatedRoots) {
        // Pre-isolation runtimes carry the legacy marker instead (PRD §5.5).
        return false;
    }
    const group = groups.find(candidate => candidate.members.some(member =>
        member.worktreeKey
        && member.worktreeKey.repositoryKey === key.repositoryKey
        && member.worktreeKey.canonicalWorktreePath === key.canonicalWorktreePath));
    if (!group || !snapshot) {
        return false;
    }
    const persisted = runtime.identity.writableRootHostPaths;
    if (!persisted || persisted.length === 0) {
        return false;
    }
    // Cross-platform comparison keys (Windows case/separator-insensitive).
    // Cross-platform comparison keys (Windows case/separator-insensitive).
    const persistedSet = new Set(persisted.map(getWorkspaceHostPathComparisonKey));
    const expectedSet = new Set<string>();
    for (const member of group.members) {
        // New members enter the expected scope only once ready (PRD §6.3).
        if (member.state !== 'ready' || member.detached || !member.worktreeKey) {
            continue;
        }
        const repository = snapshot.repositories.find(candidate =>
            candidate.repositoryKey === member.repositoryKey);
        if (!repository) {
            continue;
        }
        let mapped: string[];
        try {
            mapped = mapWorktreeBoundHostPaths(
                member.worktreeKey.canonicalWorktreePath,
                repository.rootBindings,
                workspace.roots);
        } catch {
            continue;
        }
        for (const candidatePath of mapped) {
            expectedSet.add(getWorkspaceHostPathComparisonKey(candidatePath));
        }
    }
    for (const candidate of expectedSet) {
        if (!persistedSet.has(candidate)) {
            return true;
        }
    }
    // Removed members leave stale write access behind (PRD §6.3): any
    // persisted root outside the expected scope outdates the session too.
    for (const candidate of persistedSet) {
        if (!expectedSet.has(candidate)) {
            return true;
        }
    }
    return false;
}

function buildActiveSessions<TTerminal>(input: {
    input: HydrateWorkspaceAiSessionsInput<TTerminal>;
    sessionsByProvider: Partial<Record<AiSessionProviderId, AiSessionViewModel[]>>;
    activeRuntimes: AiSessionRuntimeSnapshot<TTerminal>[];
    pendingRuntimes: ProjectablePendingRuntime<TTerminal>[];
    activePresentation: WorkspaceActiveSessionPresentation;
    focusedPendingKey: string | null;
}): ActiveAiSessionViewModel[] {
    const active = input.activeRuntimes
        .filter(runtime => !!runtime.identity.sessionId)
        .map((runtime, sourceOrder): SortableActiveSession => {
            const providerId = runtime.identity.provider;
            const sessionId = runtime.identity.sessionId;
            const key = getAiSessionKey(providerId, sessionId);
            const session = input.sessionsByProvider[providerId]
                ?.find(candidate => candidate.id === sessionId);
            const worktree = assignPathToWorkspaceWorktree(
                runtime.identity.cwd,
                input.input.workspace,
                input.input.worktreeSnapshot,
                runtime.identity.worktreeKey,
            );
            const manifestKey = !worktree && runtime.identity.worktreeKey
                && manifestClaimsWorktreeKey(
                    input.input.worktreeGroups || [], runtime.identity.worktreeKey)
                ? { ...runtime.identity.worktreeKey }
                : null;
            const root = worktree?.root
                || assignPathToWorkspaceRoot(runtime.identity.cwd, input.input.workspace.roots);
            const presentation = input.activePresentation.sessions.find(candidate =>
                candidate.provider === providerId && candidate.sessionId === sessionId
            );
            const focused = presentation?.focused === true;
            const executionState = presentation?.executionState || 'stopped';
            const needsAttention = presentation?.needsAttention === true;
            const conflict = presentation?.conflict === true;
            return {
                key,
                provider: providerId,
                sessionId,
                ...profileMetadata(input.input.profiles?.[key], input.input.profileAvailability),
                name: session?.name || `${providerLabel(input.input.providers, providerId)} ${shortId(sessionId)}`,
                executionState,
                focused,
                needsAttention,
                pending: false,
                backend: runtime.backend,
                ...(runtime.tmux?.layout ? { tmuxLayout: runtime.tmux.layout } : {}),
                attached: runtime.attached,
                ...(conflict ? { conflict: true } : {}),
                ...(runtime.stale ? { stale: true } : {}),
                ...(session?.updatedAt ? { updatedAt: session.updatedAt } : {}),
                ...(session?.pinned !== undefined ? { pinned: session.pinned } : {}),
                ...(needsAttention && presentation?.eventIds[0]
                    ? { attentionEventId: presentation.eventIds[0] }
                    : {}),
                ...rootMetadata(root),
                ...(worktree
                    ? { worktreeKey: { ...worktree.worktree.key } }
                    : manifestKey ? { worktreeKey: manifestKey } : {}),
                // Pre-isolation worktree runtimes keep their wider writable
                // roots until restarted (PRD §5.5 legacy marker).
                ...(runtime.identity.worktreeKey && !runtime.identity.isolatedRoots
                    ? { legacyScope: true }
                    : {}),
                ...(isGroupSessionScopeOutdated(
                    runtime,
                    input.input.worktreeGroups || [],
                    input.input.worktreeSnapshot,
                    input.input.workspace)
                    ? { scopeOutdated: true }
                    : {}),
                activityMs: finiteNumber(runtime.runStartedAtMs),
                sourceOrder,
            };
        });
    const pending = input.pendingRuntimes.map((runtime, sourceOrder): SortableActiveSession => {
        const providerId = runtime.identity.provider;
        const pendingId = runtime.identity.pendingId || runtime.createdAt;
        const key = pendingKey(providerId, pendingId);
        const worktree = assignPathToWorkspaceWorktree(
            runtime.identity.cwd,
            input.input.workspace,
            input.input.worktreeSnapshot,
            runtime.identity.worktreeKey,
        );
        const manifestKey = !worktree && runtime.identity.worktreeKey
            && manifestClaimsWorktreeKey(
                input.input.worktreeGroups || [], runtime.identity.worktreeKey)
            ? { ...runtime.identity.worktreeKey }
            : null;
        const root = worktree?.root
            || assignPathToWorkspaceRoot(runtime.identity.cwd, input.input.workspace.roots);
        const focused = input.focusedPendingKey === key;
        const conflict = runtime.projectionConflict === true;
        return {
            key,
            provider: providerId,
            pendingId,
            ...profileMetadata(
                input.input.pendingProfiles?.[runtime.identity.pendingId || ''],
                input.input.profileAvailability
            ),
            name: runtime.title || `New ${providerLabel(input.input.providers, providerId)} session`,
            executionState: 'starting',
            focused,
            needsAttention: false,
            pending: true,
            backend: runtime.backend,
            ...(runtime.tmux?.layout ? { tmuxLayout: runtime.tmux.layout } : {}),
            attached: runtime.attached,
            ...(conflict ? { conflict: true } : {}),
            ...(runtime.stale ? { stale: true } : {}),
            createdAt: runtime.createdAt,
            ...rootMetadata(root),
            ...(worktree
                ? { worktreeKey: { ...worktree.worktree.key } }
                : manifestKey ? { worktreeKey: manifestKey } : {}),
            ...(runtime.identity.worktreeKey && !runtime.identity.isolatedRoots
                ? { legacyScope: true }
                : {}),
            ...(isGroupSessionScopeOutdated(
                runtime,
                input.input.worktreeGroups || [],
                input.input.worktreeSnapshot,
                input.input.workspace)
                ? { scopeOutdated: true }
                : {}),
            activityMs: timestamp(runtime.createdAt),
            sourceOrder: active.length + sourceOrder,
        };
    });
    return [...active, ...pending]
        .sort(compareActiveSessions)
        .map(({ activityMs: _activityMs, sourceOrder: _sourceOrder, ...session }) => session);
}

function rootMetadata(root: WorkspaceRoot | null): Pick<
ActiveAiSessionViewModel,
'primaryRootId' | 'primaryRootLabel' | 'outsideWorkspace'
> {
    return root ? {
        primaryRootId: root.id,
        primaryRootLabel: root.name,
    } : {
        primaryRootLabel: 'Outside workspace',
        outsideWorkspace: true,
    };
}

function profileMetadata(
    decision: SessionProfileDecision | undefined,
    availability: Readonly<Record<string, boolean>> | undefined
): { profile?: string; profileUnavailable?: boolean } {
    if (!decision || decision.kind !== 'profile') {
        return {};
    }
    return {
        profile: decision.name,
        ...(availability?.[decision.name] === false ? { profileUnavailable: true } : {}),
    };
}

function deduplicateActiveRuntimes<TTerminal>(
    runtimes: readonly AiSessionRuntimeSnapshot<TTerminal>[]
): AiSessionRuntimeSnapshot<TTerminal>[] {
    const bySession = new Map<string, AiSessionRuntimeSnapshot<TTerminal>>();
    for (const runtime of runtimes) {
        const sessionId = runtime.identity.sessionId;
        if (!sessionId) {
            continue;
        }
        const key = getAiSessionKey(runtime.identity.provider, sessionId);
        const existing = bySession.get(key);
        if (!existing) {
            bySession.set(key, cloneRuntime(runtime));
        } else {
            bySession.set(key, { ...existing, state: 'conflict' });
        }
    }
    return Array.from(bySession.values());
}

function deduplicatePendingRuntimes<TTerminal>(
    runtimes: readonly AiSessionPendingRuntimeSnapshot<TTerminal>[]
): ProjectablePendingRuntime<TTerminal>[] {
    const byPending = new Map<string, AiSessionPendingRuntimeSnapshot<TTerminal>[]>();
    for (const runtime of runtimes) {
        const pendingId = runtime.identity.pendingId;
        if (!pendingId) {
            continue;
        }
        const key = pendingKey(runtime.identity.provider, pendingId);
        const group = byPending.get(key) || [];
        group.push(runtime);
        byPending.set(key, group);
    }
    return Array.from(byPending.values()).map(group => {
        const representative = group.slice().sort((left, right) => {
            if (left.backend !== right.backend) {
                return left.backend === 'tmux' ? -1 : 1;
            }
            return left.markerPath.localeCompare(right.markerPath);
        })[0];
        return {
            ...cloneRuntime(representative),
            state: 'pending',
            createdAt: representative.createdAt,
            excludedSessionIds: [...representative.excludedSessionIds],
            ...(representative.title === undefined ? {} : { title: representative.title }),
            ...(group.length > 1 ? { projectionConflict: true } : {}),
        };
    });
}

function cloneRuntime<TTerminal>(runtime: AiSessionRuntimeSnapshot<TTerminal>): AiSessionRuntimeSnapshot<TTerminal> {
    return {
        ...runtime,
        identity: {
            ...runtime.identity,
            workspaceRootHostPaths: [...runtime.identity.workspaceRootHostPaths],
        },
        ...(runtime.tmux ? { tmux: { ...runtime.tmux } } : {}),
    };
}

function providerLabel(providers: readonly HydrationProvider[], providerId: AiSessionProviderId): string {
    return providers.find(provider => provider.id === providerId)?.label || 'AI';
}

function compareActiveSessions(left: SortableActiveSession, right: SortableActiveSession): number {
    if (left.pending !== right.pending) {
        return left.pending ? 1 : -1;
    }
    if (left.pending && right.pending) {
        return left.activityMs - right.activityMs || left.sourceOrder - right.sourceOrder;
    }
    return right.activityMs - left.activityMs || left.sourceOrder - right.sourceOrder;
}

function timestamp(value: string | undefined): number {
    const parsed = value ? Date.parse(value) : NaN;
    return Number.isFinite(parsed) ? parsed : 0;
}

function finiteNumber(value: number): number {
    return Number.isFinite(value) ? value : 0;
}

function pendingKey(providerId: AiSessionProviderId, pendingId: string): string {
    return `pending:${providerId}:${pendingId}`;
}

function shortId(value: string): string {
    return (value || 'unknown').substring(0, 8);
}
