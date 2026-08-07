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
    primaryRootId: string;
    primaryCwd: string;
    additionalDirectories: string[];
}

export type AiSessionTabId = 'active' | 'sessions';
export type ActiveAiSessionExecutionState = 'starting' | AiSessionExecutionState;
export type ActiveAiSessionStatus = 'starting' | 'running' | 'focused' | 'needsAttention' | 'conflict';

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
    name: string;
    executionState: ActiveAiSessionExecutionState;
    status: ActiveAiSessionStatus;
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
        launchOptions: AiSessionLaunchOptions
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
    activeSessions: ActiveAiSessionViewModel[];
    activeSessionCount: number;
    activeAttentionCount: number;
}

export interface WorkspaceAiSessionActionTarget {
    cardId: string;
    workspace: OpenWorkspace;
    sessions: WorkspaceAiSessionViewModel;
}

export interface AiSessionsUpdatedMessage {
    type: 'ai-sessions-updated';
    version: 2;
    sequence: number;
    generatedAt: string;
    currentWorkspaceCount: 0 | 1;
    html: string;
    searchCatalog: DashboardWorkspaceSearchCatalog;
}

export interface AiSessionActiveTerminalChangedMessage {
    type: 'active-ai-session-terminal-changed';
    provider: AiSessionProviderId | null;
    sessionId: string | null;
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
