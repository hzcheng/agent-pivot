'use strict';

import type { AiSessionProviderId, CodexSession } from '../models';
import type { ActiveAiSessionTerminalIdentity } from '../aiSessions/activeTerminalHighlight';
import type { AttentionAggregate } from '../aiSessions/attentionAggregate';
import type { AiSessionExecutionSnapshot } from '../aiSessions/executionMonitor';
import { getAiSessionScanMaxFiles } from '../aiSessions/scanOptions';
import type {
    AiSessionPendingRuntimeSnapshot,
    AiSessionRuntimeIdentity,
    AiSessionRuntimeSnapshot,
} from '../aiSessions/runtimeTypes';
import type {
    AiSessionProviderDefinition,
    AiSessionReadResult,
    SessionProfileDecision,
    WorkspaceAiSessionViewModel,
} from '../aiSessions/types';
import type { AiSessionProviderSelection } from '../aiSessions/providerSelection';
import type { OpenWorkspace } from './types';
import { projectWorkspaceActiveSessions } from './activeSessionPresentation';
import type { WorkspaceActiveSessionPresentation } from './activeSessionPresentation';
import { getWorkspaceAiSessionCandidatePaths, hydrateWorkspaceAiSessions } from './sessionHydration';

type HydrationProvider = Pick<AiSessionProviderDefinition, 'id' | 'label' | 'terminalCwdFields'>;

export interface WorkspaceSessionHydrationReadCoordinator {
    getResults(options: {
        candidatePaths: string[];
        reason: string;
        maxFiles: number;
    }): Record<AiSessionProviderId, AiSessionReadResult>;
}

export interface AiSessionProjectionSnapshot<TTerminal = unknown> {
    revision: number;
    activeRuntimes: readonly AiSessionRuntimeSnapshot<TTerminal>[];
    pendingRuntimes: readonly AiSessionPendingRuntimeSnapshot<TTerminal>[];
    executionSnapshot: Readonly<Record<string, AiSessionExecutionSnapshot>>;
    focusedIdentity: AiSessionRuntimeIdentity | ActiveAiSessionTerminalIdentity | null;
    attentionAggregate: AttentionAggregate | null;
}

export interface AiSessionPresentationTransaction<TTerminal = unknown>
    extends AiSessionProjectionSnapshot<TTerminal> {
    presentation: WorkspaceActiveSessionPresentation;
}

export interface AiSessionProjectionCoordinatorOptions<TTerminal = unknown> {
    getActiveRuntimes: () => readonly AiSessionRuntimeSnapshot<TTerminal>[];
    getPendingRuntimes: () => readonly AiSessionPendingRuntimeSnapshot<TTerminal>[];
    getExecutionSnapshot: () => Readonly<Record<string, AiSessionExecutionSnapshot>>;
    getFocusedIdentity: () => AiSessionRuntimeIdentity | ActiveAiSessionTerminalIdentity | null;
    getAttentionAggregate: () => AttentionAggregate | null;
}

/**
 * Owns the coherent, monotonically-versioned state projected into every
 * current-workspace AI Session surface.
 */
export class AiSessionProjectionCoordinator<TTerminal = unknown> {
    private revision = 0;

    constructor(private readonly options: AiSessionProjectionCoordinatorOptions<TTerminal>) {
    }

    nextRevision(): number {
        if (this.revision >= Number.MAX_SAFE_INTEGER) {
            throw new Error('AI Session projection revision exhausted.');
        }
        this.revision += 1;
        return this.revision;
    }

    capture(): AiSessionProjectionSnapshot<TTerminal> {
        return {
            revision: this.revision,
            activeRuntimes: this.options.getActiveRuntimes(),
            pendingRuntimes: this.options.getPendingRuntimes(),
            executionSnapshot: this.options.getExecutionSnapshot(),
            focusedIdentity: this.options.getFocusedIdentity(),
            attentionAggregate: this.options.getAttentionAggregate(),
        };
    }

    captureNext(
        workspace: OpenWorkspace | null = null
    ): AiSessionPresentationTransaction<TTerminal> {
        this.nextRevision();
        const snapshot = this.capture();
        return {
            ...snapshot,
            presentation: projectWorkspaceActiveSessions({
                workspace,
                activeRuntimes: snapshot.activeRuntimes,
                pendingRuntimes: snapshot.pendingRuntimes,
                executionSnapshot: snapshot.executionSnapshot,
                focusedIdentity: snapshot.focusedIdentity,
                attentionAggregate: snapshot.attentionAggregate,
            }),
        };
    }
}

export interface WorkspaceSessionHydrationControllerOptions<TTerminal = unknown> {
    providers: readonly HydrationProvider[];
    readCoordinator: WorkspaceSessionHydrationReadCoordinator;
    incrementalScanMaxFiles: number;
    getRefreshReason: () => string;
    getSessionComparableCwd: (providerId: AiSessionProviderId, session: CodexSession) => string;
    getPinnedSessions: () => ReadonlySet<string>;
    getAliases: () => Readonly<Record<string, string>>;
    getProfiles?: () => Readonly<Record<string, SessionProfileDecision>>;
    getPendingProfiles?: () => Readonly<Record<string, SessionProfileDecision>>;
    getProfileAvailability?: () => Readonly<Record<string, boolean>>;
    /** The Codex profile a picker-free quick-create would launch with, when any. */
    getQuickCreateProfile?: () => string | undefined;
    /** The provider quick-create remembers for a workspace, when any. */
    getQuickCreateProvider?: (
        workspaceScopeIdentity: string
    ) => AiSessionProviderId | undefined;
    getProviderSelection: (
        workspaceScopeIdentity: string
    ) => AiSessionProviderSelection | undefined;
    getExpanded: (workspaceScopeIdentity: string) => boolean;
    getProjectionSnapshot: () => AiSessionProjectionSnapshot<TTerminal>;
    onDidReadSessions?: (
        workspace: OpenWorkspace,
        sessionResults: Record<AiSessionProviderId, AiSessionReadResult>,
        reason: string
    ) => void;
    nowMs?: () => number;
    logDiagnostic?: (event: Record<string, unknown>) => void;
}

export class WorkspaceSessionHydrationController<TTerminal = unknown> {
    constructor(private readonly options: WorkspaceSessionHydrationControllerOptions<TTerminal>) {
    }

    hydrate(
        workspace: OpenWorkspace | null,
        projectionOverride?: AiSessionProjectionSnapshot<TTerminal>
            | AiSessionPresentationTransaction<TTerminal>
    ): WorkspaceAiSessionViewModel | null {
        const startedAt = this.nowMs();
        const reason = this.options.getRefreshReason();
        if (!workspace) {
            this.logDiagnostic({
                event: 'workspace-ai-session-hydration',
                reason,
                durationMs: this.nowMs() - startedAt,
                workspaceCount: 0,
                candidatePathCount: 0,
                providerCount: this.options.providers.length,
                sessionCount: 0,
            });
            return null;
        }

        const candidatePaths = getWorkspaceAiSessionCandidatePaths(workspace);
        const maxFiles = getAiSessionScanMaxFiles(reason, this.options.incrementalScanMaxFiles);
        const sessionResults = this.options.readCoordinator.getResults({ candidatePaths, reason, maxFiles });
        this.options.onDidReadSessions?.(workspace, sessionResults, reason);
        const projection = projectionOverride || this.options.getProjectionSnapshot();
        const activePresentation = Object.prototype.hasOwnProperty.call(
            projection,
            'presentation'
        )
            ? (projection as AiSessionPresentationTransaction<TTerminal>).presentation
            : undefined;
        if (activePresentation
            && (activePresentation.workspaceScopeIdentity !== workspace.scopeIdentity
                || activePresentation.workspaceNavigationIdentity
                    !== workspace.navigationIdentity)) {
            throw new Error('AI Session presentation transaction does not match the hydrated workspace.');
        }
        const result = hydrateWorkspaceAiSessions({
            workspace,
            providers: this.options.providers,
            sessionResults,
            getSessionComparableCwd: this.options.getSessionComparableCwd,
            pinnedSessions: this.options.getPinnedSessions(),
            aliases: this.options.getAliases(),
            profiles: this.options.getProfiles?.() || {},
            pendingProfiles: this.options.getPendingProfiles?.() || {},
            profileAvailability: this.options.getProfileAvailability?.() || {},
            quickCreateProfile: this.options.getQuickCreateProfile?.(),
            quickCreateProvider: this.options.getQuickCreateProvider?.(workspace.scopeIdentity),
            activeRuntimes: projection.activeRuntimes,
            pendingRuntimes: projection.pendingRuntimes,
            executionSnapshot: projection.executionSnapshot,
            focusedIdentity: projection.focusedIdentity,
            attentionAggregate: projection.attentionAggregate,
            activePresentation,
            providerSelection: this.options.getProviderSelection(workspace.scopeIdentity),
            expanded: this.options.getExpanded(workspace.scopeIdentity),
        });
        this.logDiagnostic({
            event: 'workspace-ai-session-hydration',
            reason,
            durationMs: this.nowMs() - startedAt,
            workspaceCount: 1,
            candidatePathCount: candidatePaths.length,
            providerCount: this.options.providers.length,
            sessionCount: result.aiSessionCount,
            activeSessionCount: result.activeSessionCount,
            unavailableProviderCount: result.unavailableProviders.length,
        });
        return result;
    }

    private nowMs(): number {
        return this.options.nowMs ? this.options.nowMs() : Date.now();
    }

    private logDiagnostic(event: Record<string, unknown>): void {
        this.options.logDiagnostic?.(event);
    }
}
