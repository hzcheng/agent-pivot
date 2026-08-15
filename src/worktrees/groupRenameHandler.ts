'use strict';

import type { WorktreeGroupManifestStore } from './groupManifestStore';
import {
    acceptedWorktreeGroupRenameSettlement,
    parseRenameWorktreeGroupRequest,
    RenameWorktreeGroupRequest,
    settledWorktreeGroupRenameSettlement,
    WorktreeGroupRenameSettlement,
} from './groupRenameProtocol';
import type { SettlementReplayCache } from './settlementReplayCache';

export interface RenameWorktreeGroupHandlerDeps {
    postMessage: (message: unknown) => Thenable<unknown>;
    /** Resolves the caller's project to the current workspace bucket. */
    getNavigationIdentity: (projectId: string) => string | null;
    store: WorktreeGroupManifestStore;
    /** Awaits publication of the authoritative replacement. */
    refreshNow: () => Promise<void>;
    showWarning: (message: string) => void;
    logError: (message: string, error: unknown) => void;
    replayCache: SettlementReplayCache<WorktreeGroupRenameSettlement>;
}

/**
 * Group rename mutation (PRD §5.2): the store regenerates the suggested
 * slug and writes displayName + slug + revision atomically; the request
 * binds the revision the editor saw (stale edits fail closed); replays of
 * a settled request id re-receive the recorded settlement and are never
 * re-executed.
 */
export async function handleRenameWorktreeGroup(
    message: unknown,
    deps: RenameWorktreeGroupHandlerDeps
): Promise<void> {
    const request = parseRenameWorktreeGroupRequest(message);
    if (!request) {
        return;
    }
    // Single-flight per request id: a replay — even a concurrent one —
    // awaits and re-receives the first execution's terminal settlement.
    const replayed = deps.replayCache.get(request.requestId);
    if (replayed) {
        await deps.postMessage(await replayed);
        return;
    }
    if (deps.replayCache.isExpired(request.requestId)) {
        // The settlement aged out of the bounded cache: re-executing could
        // flip an old outcome, so expired replays fail closed.
        await deps.postMessage(settledWorktreeGroupRenameSettlement(
            request, { kind: 'failed', errorCode: 'request-expired' }));
        return;
    }
    const terminal = executeRenameWorktreeGroup(request, deps);
    deps.replayCache.remember(request.requestId, terminal);
    await deps.postMessage(await terminal);
}

async function executeRenameWorktreeGroup(
    request: RenameWorktreeGroupRequest,
    deps: RenameWorktreeGroupHandlerDeps
): Promise<WorktreeGroupRenameSettlement> {
    await deps.postMessage(acceptedWorktreeGroupRenameSettlement(request));
    const settle = (
        outcome: { kind: 'settled' } | { kind: 'failed'; errorCode: string }
    ) => {
        return settledWorktreeGroupRenameSettlement(request, outcome);
    };
    const navigationIdentity = deps.getNavigationIdentity(request.projectId);
    if (!navigationIdentity) {
        return settle({ kind: 'failed', errorCode: 'workspace-unavailable' });
    }
    try {
        await deps.store.renameGroup(
            navigationIdentity,
            request.groupId,
            request.displayName.trim(),
            request.baseRevision);
    } catch (error) {
        deps.logError('Failed to rename the worktree group.', error);
        deps.showWarning(
            'Agent Pivot: could not rename the worktree group. Refresh the dashboard and try again.');
        const errorCode = (error as { code?: string })?.code || 'rename-failed';
        return settle({
            kind: 'failed',
            errorCode: /^[a-z0-9-]{1,64}$/.test(errorCode) ? errorCode : 'rename-failed',
        });
    }
    // The pending editor resolves only through the authoritative
    // replacement, so delivery must be awaited and a full-refresh fallback
    // covers a lost or failed publication.
    await deps.refreshNow();
    return settle({ kind: 'settled' });
}
