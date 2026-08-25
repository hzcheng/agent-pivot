'use strict';

import type { AiSessionProviderId, CodexSession } from '../models';
import type { OpenWorkspace } from '../workspaces/types';
import type { AggregateAiSessionArchiveResult } from './archiveBatchAcrossProviders';
import type {
    AiSessionAttentionReason,
    AiSessionExecutionState,
    AiSessionLifecycleRequest,
    AiSessionLifecycleSignal,
} from './lifecycle';
import type { DashboardWorkspaceSearchCatalog } from '../webview/dashboardViewModel';
import type { AiSessionLaunchOptions } from './launchOptions';
import type { AiSessionLaunchSpec } from './launchSpec';
import type { AiSessionRuntimeBackendId, AiSessionRuntimeIdentity, AiSessionTmuxLayout } from './runtimeTypes';
import type { WorktreeKey } from '../worktrees';
import type {
    ProvisioningWorktreeRow,
    WorktreeGitSnapshot,
} from '../worktrees';

export interface AiSessionTerminalEntry<TTerminal = unknown> {
    terminal: TTerminal;
    markerPath: string;
    runStartedAtMs: number;
    cwd?: string;
    runtimeIdentity?: AiSessionRuntimeIdentity;
    released?: boolean;
}

export interface AiSessionDirectoryScope {
    workspaceNavigationIdentity: string;
    workspaceScopeIdentity: string;
    workspaceRootHostPaths: string[];
    writableRootHostPaths?: string[];
    worktreeKey?: WorktreeKey;
    /** Strict worktree isolation: writable roots cover member worktrees only. */
    isolatedRoots?: boolean;
    primaryRootId: string;
    primaryCwd: string;
    additionalDirectories: string[];
}

export type WorktreeActivity = 'active' | 'attention' | 'idle';

export interface WorktreeAuthority {
    canInput: boolean;
    canFocus: boolean;
    canStop: boolean;
    canResume: boolean;
    canArchive: boolean;
    canRemove: boolean;
    canTakeControl: boolean;
    liveOwnerAvailable: boolean;
}

export interface WorktreeViewModel {
    git: WorktreeGitSnapshot;
    activity: WorktreeActivity;
    sessions: AiSessionViewModel[];
    authority: WorktreeAuthority;
}

export interface ReadyWorktreeRow extends WorktreeViewModel {
    kind: 'ready';
}

export type WorktreeRowViewModel = ProvisioningWorktreeRow | ReadyWorktreeRow;

// ── Worktree Groups (docs/worktree-tasks-prd.md) ────────────────

export type WorktreeGroupMemberStatus =
  | 'ready'
  | 'pending'
  | 'failed'
  | 'missing'
  | 'deleting'
  | 'detached';

export interface WorktreeGroupMemberViewModel {
    memberId: string;
    repositoryKey: string;
    /** Human repository label derived from the repository key. */
    repositoryLabel: string;
    /** Physical worktree identity; present for members with a created worktree. */
    worktreeKey?: WorktreeKey;
    branchName: string;
    path: string;
    status: WorktreeGroupMemberStatus;
    errorCode?: string;
    isPrimary: boolean;
}

export interface WorktreeRepositoryChip {
    /** Shortest unique prefix among the visible repository labels. */
    label: string;
    /** Full repository label; the chip's accessible name. */
    title: string;
}

export interface WorktreeGroupRowViewModel {
    kind: 'group';
    groupId: string;
    displayName: string;
    /** Persistent monotonic manifest revision (PRD §4); tokens bind to it. */
    revision: number;
    /** Stable branch short name shown when group display names collide. */
    discriminator?: string;
    activity: WorktreeActivity;
    sessions: AiSessionViewModel[];
    members: WorktreeGroupMemberViewModel[];
    chips: WorktreeRepositoryChip[];
    hasDetachedMembers: boolean;
    /** No ready primary member: the row must ask for a primary selection. */
    needsPrimarySelection: boolean;
    /** At least one ready member exists, so sessions can be launched. */
    canCreateSession: boolean;
    /**
     * Live sessions whose persisted writable scope no longer covers the
     * group's expected scope (PRD §6.3): the row annotates them.
     */
    scopeOutdatedSessions?: number;
    /**
     * An active deletion journal leases this group (PRD §6.4): the row
     * shows the operation state and offers Retry/abandon for failures.
     */
    deletion?: {
        operationId: string;
        pendingCount: number;
        failedCount: number;
    };
    /** Other visible groups sharing this group's suggested slug (merge hint). */
    mergeCandidateGroupIds: string[];
}

export interface WorktreeAnchorEntry {
    repositoryLabel: string;
    branch: string;
}

/** The single collapsed row anchoring sessions that run in main checkouts. */
export interface WorktreeAnchorViewModel {
    entries: WorktreeAnchorEntry[];
    /** Main-checkout worktree keys, used to attribute live sessions. */
    worktreeKeys: WorktreeKey[];
    sessions: AiSessionViewModel[];
    activity: WorktreeActivity;
}

export interface WorktreeQuickCreatePreferences {
    provider: AiSessionProviderId;
    profile?: string;
}

export type AiSessionTabId = 'chats' | 'all';

/**
 * The Codex configuration profile decision recorded for a session at creation
 * time. `{ kind: 'base' }` means the session deliberately runs without
 * `-p`; `{ kind: 'profile' }` pins the named `<name>.config.toml` overlay.
 * A missing record means legacy/unknown and must resume without `-p`.
 */
export type SessionProfileDecision =
    | { kind: 'base' }
    | { kind: 'profile'; name: string };
export type ActiveAiSessionExecutionState = 'starting' | AiSessionExecutionState;

export interface AiSessionActiveTerminalRuntime {
    provider: AiSessionProviderId;
    sessionId: string;
    workspaceScopeIdentity: string;
    cwd?: string;
    runStartedAtMs: number;
}

export interface ActiveAiSessionViewModel {
    key: string;
    provider: AiSessionProviderId;
    sessionId?: string;
    pendingId?: string;
    name: string;
    /** Codex config profile name recorded for this runtime, when any. */
    profile?: string;
    /** True when the recorded profile's config file no longer exists. */
    profileUnavailable?: boolean;
    executionState: ActiveAiSessionExecutionState;
    focused: boolean;
    needsAttention: boolean;
    pending: boolean;
    backend: AiSessionRuntimeBackendId;
    tmuxLayout?: AiSessionTmuxLayout;
    attached: boolean;
    conflict?: boolean;
    stale?: boolean;
    updatedAt?: string;
    createdAt?: string;
    pinned?: boolean;
    attentionEventId?: string;
    primaryRootId?: string;
    primaryRootLabel?: string;
    outsideWorkspace?: boolean;
    worktreeKey?: WorktreeKey;
    /**
     * Running pre-isolation worktree session (PRD §5.5): its writable roots
     * still include non-member main checkouts until it is restarted.
     */
    legacyScope?: boolean;
    /**
     * The group gained a member after this session started (PRD §6.3): the
     * persisted writable roots no longer cover the expected group scope.
     * Restart the session to pick the new worktree up.
     */
    scopeOutdated?: boolean;
}

export interface AiSessionReadResult {
    available: boolean;
    sessions: CodexSession[];
    scannedFiles: number;
    parsedFiles: number;
}

export interface AiSessionQueryOptions {
    forceRefresh?: boolean;
    candidatePaths?: string[];
    maxFiles?: number;
    reason?: string;
}

export interface AiSessionDisposable {
    dispose(): void;
}

export interface AiSessionConversationSourceCandidate {
    providerHome: string;
    sourcePath: string;
    /** Provider-authoritative working directory for this Session. */
    cwd?: string;
}

/**
 * A Codex subagent thread discovered on disk: an independent rollout file
 * whose session_meta marks it as spawned by a parent thread.
 */
export interface AiSessionCodexSubagentThread {
    id: string;
    filePath: string;
    agentNickname?: string;
    agentPath?: string;
    agentRole?: string | null;
    createdAt?: number;
    fileMtimeMs: number;
    /** True when the rollout's last lifecycle event is task_complete. */
    completed: boolean;
}

export interface AiSessionService {
    getSessions(options?: boolean | AiSessionQueryOptions): AiSessionReadResult;
    getLifecycleSignals(requests: readonly AiSessionLifecycleRequest[]): Record<string, AiSessionLifecycleSignal>;
    watchSessionChanges(onDidChange: () => void): AiSessionDisposable;
    archiveSession(sessionId: string): boolean;
    invalidateCache(): void;
    resolveSessionFilePath?(sessionId: string): string | null;
    getConversationLifecycleSignal?(
        sessionId: string
    ): AiSessionLifecycleSignal | undefined;
    resolveConversationSource?(
        sessionId: string,

        candidatePaths?: readonly string[]
    ): AiSessionConversationSourceCandidate | null;
    listSubagentThreads?(sessionId: string): AiSessionCodexSubagentThread[];
}

export interface AiSessionProviderDefinition {
    id: AiSessionProviderId;
    label: string;
    commandName: string;
    terminalNamePrefix: string;
    terminalEnvKey: string;
    markerDirName: string;
    projectSessionsKey: 'codexSessions' | 'kimiSessions' | 'claudeSessions';
    projectSessionsUnavailableKey: 'codexSessionsUnavailable' | 'kimiSessionsUnavailable' | 'claudeSessionsUnavailable';
    terminalCwdFields: Array<'cwd' | 'workDir'>;
    buildResumeLaunchSpec: (
        sessionId: string,
        scope: AiSessionDirectoryScope,
        markerPath: string,
        launchOptions: AiSessionLaunchOptions,
        prompt?: string
    ) => AiSessionLaunchSpec;
    buildNewSessionLaunchSpec: (
        scope: AiSessionDirectoryScope,
        title: string,
        markerPath: string,
        launchOptions: AiSessionLaunchOptions,
        initialPrompt?: string
    ) => AiSessionLaunchSpec;
    buildResumeCommand: (sessionId: string, scope: AiSessionDirectoryScope, markerPath: string) => string;
    buildNewSessionCommand: (scope: AiSessionDirectoryScope, title: string, markerPath: string) => string;
}

export interface AiSessionProvider extends AiSessionProviderDefinition {
    service: AiSessionService;
}

export interface AiSessionProviderSummary {
    id: AiSessionProviderId;
    label: string;
    count: number;
    unavailable?: boolean;
}

export interface AiSessionViewModel {
    id: string;
    name: string;
    provider: AiSessionProviderId;
    /** Codex config profile name recorded for this session, when any. */
    profile?: string;
    /** True when the recorded profile's config file no longer exists. */
    profileUnavailable?: boolean;
    updatedAt?: string;
    cwd?: string;
    workDir?: string;
    pinned?: boolean;
    active?: boolean;
    focused?: boolean;
    attention?: { eventId: string; reason: AiSessionAttentionReason; unread: boolean };
    primaryRootId?: string;
    primaryRootLabel?: string;
    outsideWorkspace?: boolean;
    worktreeKey?: WorktreeKey;
    /**
     * The session's worktree is gone or unhealthy (PRD §6.4): viewing the
     * conversation stays available, resume fails closed.
     */
    worktreeUnavailable?: boolean;
}

export interface WorkspaceAiSessionViewModel {
    workspaceScopeIdentity: string;
    workspaceNavigationIdentity: string;
    activeProvider: AiSessionProviderId;
    selectedProviders: AiSessionProviderId[];
    expanded: boolean;
    providers: AiSessionProviderSummary[];
    sessionsByProvider: Partial<Record<AiSessionProviderId, AiSessionViewModel[]>>;
    unavailableProviders: AiSessionProviderId[];
    aiSessionCount: number;
    attentionCount: number;
    defaultTab: AiSessionTabId;
    /**
     * M2 window-scoped view state (CHATS/ALL tab, CHATS view mode, collapsed
     * worktree groups), resolved host-side with defaults; drives the CHATS/ALL
     * render at the PR-D cutover.
     */
    windowViewState?: import('./workspaceStateStore').AiSessionWindowViewState;
    activeSessions: ActiveAiSessionViewModel[];
    activeSessionCount: number;
    activeAttentionCount: number;
    /** Collapsed main-checkout anchor row (PRD §4); sessions run in main checkouts. */
    worktreeAnchor?: WorktreeAnchorViewModel;
    /** Manifest-backed worktree group rows (authoritative grouping). */
    worktreeGroups?: WorktreeGroupRowViewModel[];
    /** Provisioning + unclaimed ready rows (rendered as the Unmanaged section). */
    worktrees: WorktreeRowViewModel[];
    /** Adopt suggestions: unmanaged worktrees clustered by task slug (PRD §6.5). */
    worktreeAdoptSuggestions?: {
        slug: string;
        members: {
            worktreeKey: WorktreeKey;
            branchName: string;
            repositoryLabel: string;
        }[];
    }[];
    worktreeRepositoryCount?: number;
    bareWorktreeCount?: number;
    unmanagedSessions: AiSessionViewModel[];
    unmanagedActiveSessions: ActiveAiSessionViewModel[];
    worktreeSnapshotRevision?: number;
    truncatedWorktreeCount: number;
    /** The Codex profile a picker-free quick-create would launch with, when any. */
    quickCreateProfile?: string;
    /** Named Codex profiles available for one-click creation. */
    codexProfiles?: string[];
    /** The provider quick-create remembers for this workspace, when any. */
    quickCreateProvider?: AiSessionProviderId;
}

export interface WorkspaceAiSessionActionTarget {
    cardId: string;
    workspace: OpenWorkspace;
    sessions: WorkspaceAiSessionViewModel;
}

export interface AiSessionsUpdatedMessage {
    type: 'ai-sessions-updated';
    version: 3;
    sequence: number;
    projectionRevision: number;
    generatedAt: string;
    currentWorkspaceCount: 0 | 1;
    html: string;
    searchCatalog: DashboardWorkspaceSearchCatalog;
    presentation: AiSessionPresentationStateMessage;
}

export interface ActiveAiSessionPresentation {
    provider: AiSessionProviderId;
    sessionId: string;
    executionState: AiSessionExecutionState;
    focused: boolean;
    needsAttention: boolean;
    conflict: boolean;
    eventIds: string[];
}

export type ActiveAiSessionFocusedTarget =
    | { provider: AiSessionProviderId; sessionId: string; pendingId?: never }
    | { provider: AiSessionProviderId; pendingId: string; sessionId?: never };

export interface AiSessionPresentationStateMessage {
    type: 'ai-session-presentation-state';
    version: 1;
    projectionRevision: number;
    workspaceScopeIdentity: string | null;
    workspaceNavigationIdentity: string | null;
    /**
     * The worktree-group aggregate revision this presentation was built
     * from (PRD §6.4 decision J): deletion settlements bind a minimum, and
     * the webview clears pending state only once a rendered presentation
     * at or beyond it has applied.
     */
    worktreeGroupsAggregateRevision?: number | null;
    attentionCount: number;
    activeAttentionCount: number;
    runningSessionCount: number;
    runningCardAnimation: string;
    runningIconAnimation: string;
    revealFocused: boolean;
    focusedTarget: ActiveAiSessionFocusedTarget | null;
    attentionSessions: Array<{ sessionKey: string; eventIds: string[] }>;
    sessions: ActiveAiSessionPresentation[];
}

export interface AiSessionAssignmentCandidate<TProject = { id: string }> {
    project: TProject;
    path: string;
}

export interface AiSessionBatchArchiveCompletedMessage {
    type: 'ai-session-batch-archive-completed';
    version: 1;
    requestId: number;
    projectId: string;
    status: 'cancelled' | 'rejected' | 'finished';
    result?: AggregateAiSessionArchiveResult;
}

export interface AiSessionProviderSelectionResultMessage {
    type: 'ai-session-provider-selection-result';
    version: 1;
    requestId: number;
    projectId: string;
    success: boolean;
}
