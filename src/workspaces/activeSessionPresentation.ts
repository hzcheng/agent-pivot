'use strict';

import type { ActiveAiSessionTerminalIdentity } from '../aiSessions/activeTerminalHighlight';
import type { AttentionAggregate } from '../aiSessions/attentionAggregate';
import { getLogicalAttentionSessionKey } from '../aiSessions/attentionProject';
import type { AiSessionExecutionSnapshot } from '../aiSessions/executionMonitor';
import { getAiSessionKey } from '../aiSessions/sessionHelpers';
import type {
    AiSessionPendingRuntimeSnapshot,
    AiSessionRuntimeIdentity,
    AiSessionRuntimeSnapshot,
} from '../aiSessions/runtimeTypes';
import type {
    ActiveAiSessionFocusedTarget,
    ActiveAiSessionPresentation,
} from '../aiSessions/types';
import { getWorkspaceAttentionSummary } from './attentionProjection';
import { hasWorkspaceRuntimeContinuity } from './runtimeOwnership';
import type { OpenWorkspace } from './types';

export interface WorkspaceActiveSessionPresentation {
    workspaceScopeIdentity: string | null;
    workspaceNavigationIdentity: string | null;
    attentionCount: number;
    activeAttentionCount: number;
    runningSessionCount: number;
    focusedTarget: ActiveAiSessionFocusedTarget | null;
    attentionSessions: Array<{ sessionKey: string; eventIds: string[] }>;
    sessions: ActiveAiSessionPresentation[];
}

export interface ProjectWorkspaceActiveSessionsInput<TTerminal = unknown> {
    workspace: OpenWorkspace | null;
    activeRuntimes: readonly AiSessionRuntimeSnapshot<TTerminal>[];
    pendingRuntimes?: readonly AiSessionPendingRuntimeSnapshot<TTerminal>[];
    executionSnapshot: Readonly<Record<string, AiSessionExecutionSnapshot>>;
    focusedIdentity: AiSessionRuntimeIdentity | ActiveAiSessionTerminalIdentity | null;
    attentionAggregate: AttentionAggregate | null;
}

/**
 * The sole owner of the user-visible Active Session lifecycle projection.
 * Consumers must render these decisions instead of recombining runtime,
 * execution, focus, and Attention state themselves.
 */
export function projectWorkspaceActiveSessions<TTerminal = unknown>(
    input: ProjectWorkspaceActiveSessionsInput<TTerminal>
): WorkspaceActiveSessionPresentation {
    if (!input.workspace) {
        return {
            workspaceScopeIdentity: null,
            workspaceNavigationIdentity: null,
            attentionCount: 0,
            activeAttentionCount: 0,
            runningSessionCount: 0,
            focusedTarget: null,
            attentionSessions: [],
            sessions: [],
        };
    }

    const runtimeGroups = new Map<string, AiSessionRuntimeSnapshot<TTerminal>[]>();
    for (const runtime of input.activeRuntimes || []) {
        const sessionId = runtime.identity.sessionId;
        if (!sessionId || !hasWorkspaceRuntimeContinuity(input.workspace, runtime)) {
            continue;
        }
        const key = getAiSessionKey(runtime.identity.provider, sessionId);
        const group = runtimeGroups.get(key) || [];
        group.push(runtime);
        runtimeGroups.set(key, group);
    }

    const workspaceAttention = getWorkspaceAttentionSummary(
        input.workspace,
        input.attentionAggregate
    );
    const attentionBySession = new Map(workspaceAttention.sessions.map(session => [
        getLogicalAttentionSessionKey(session.sessionKey),
        session.eventIds.slice(),
    ]));
    const runningSessionKeys = new Set<string>();
    const sessions = Array.from(runtimeGroups.entries()).map(([key, runtimes]) => {
        const runtime = runtimes[0];
        const sessionId = runtime.identity.sessionId as string;
        const executionState = input.executionSnapshot[key]?.state || 'stopped';
        const focused = runtimes.some(candidate =>
            input.focusedIdentity?.provider === candidate.identity.provider
            && input.focusedIdentity.sessionId === sessionId
            && input.focusedIdentity.workspaceScopeIdentity
                === candidate.identity.workspaceScopeIdentity
        );
        const eventIds = attentionBySession.get(key) || [];
        if (executionState === 'running') {
            runningSessionKeys.add(key);
        }
        return {
            provider: runtime.identity.provider,
            sessionId,
            executionState,
            focused,
            needsAttention: executionState !== 'running' && eventIds.length > 0,
            conflict: runtimes.length > 1 || runtime.state === 'conflict',
            eventIds: executionState === 'running' ? [] : eventIds,
        };
    }).sort((left, right) => getAiSessionKey(left.provider, left.sessionId)
        .localeCompare(getAiSessionKey(right.provider, right.sessionId)));
    const attentionSessions = workspaceAttention.sessions
        .map(session => ({
            sessionKey: getLogicalAttentionSessionKey(session.sessionKey),
            eventIds: session.eventIds.slice(),
        }))
        .filter(session => !runningSessionKeys.has(session.sessionKey));
    const focusedSession = sessions.find(session => session.focused);
    const focusedPendingId = input.focusedIdentity && 'pendingId' in input.focusedIdentity
        ? input.focusedIdentity.pendingId
        : undefined;
    const focusedPending = !focusedSession && focusedPendingId
        ? (input.pendingRuntimes || []).find(runtime =>
            hasWorkspaceRuntimeContinuity(input.workspace as OpenWorkspace, runtime)
            && runtime.identity.provider === input.focusedIdentity?.provider
            && runtime.identity.pendingId === focusedPendingId
            && runtime.identity.workspaceScopeIdentity
                === input.focusedIdentity?.workspaceScopeIdentity)
        : undefined;
    const focusedTarget: ActiveAiSessionFocusedTarget | null = focusedSession ? {
        provider: focusedSession.provider,
        sessionId: focusedSession.sessionId,
    } : focusedPending ? {
        provider: focusedPending.identity.provider,
        pendingId: focusedPending.identity.pendingId,
    } : null;

    return {
        workspaceScopeIdentity: input.workspace.scopeIdentity,
        workspaceNavigationIdentity: input.workspace.navigationIdentity,
        attentionCount: attentionSessions.length,
        activeAttentionCount: sessions.filter(session => session.needsAttention).length,
        runningSessionCount: sessions.filter(session => session.executionState === 'running').length,
        focusedTarget,
        attentionSessions,
        sessions,
    };
}
