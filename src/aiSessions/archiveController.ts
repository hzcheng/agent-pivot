'use strict';

import type { AiSessionProviderId } from '../models';
import type { AiSessionBatchArchiveCompletedMessage, WorkspaceAiSessionActionTarget } from './types';
import {
    archiveBatchAiSessionItem,
    formatBatchAiSessionIdForLog,
    BatchAiSessionArchiveAttemptStatus,
} from './archiveBatch';
import {
    AggregateAiSessionArchiveResult,
    AggregateAiSessionArchiveSelection,
    AiSessionArchiveItem,
    formatAggregateAiSessionArchiveSummary,
    hasAggregateAiSessionArchiveIssues,
    resolveAggregateAiSessionArchiveSelection,
} from './archiveBatchAcrossProviders';

export interface AiSessionArchiveRuntimeEntry {
    state: 'pending' | 'active' | 'completed' | 'stopped' | 'conflict';
    markerPath: string;
    identity: { workspaceScopeIdentity: string };
}

export interface AiSessionArchiveProvider {
    label: string;
    service: {
        archiveSession(sessionId: string): boolean;
    };
}

export interface AiSessionArchiveControllerOptions<TRuntime extends AiSessionArchiveRuntimeEntry = AiSessionArchiveRuntimeEntry> {
    isProviderId: (value: string) => value is AiSessionProviderId;
    getProvider: (providerId: AiSessionProviderId) => AiSessionArchiveProvider;
    getProviderLabel: (providerId: AiSessionProviderId) => string;
    getWorkspaceTarget: (cardId: string) => WorkspaceAiSessionActionTarget | null;
    getRuntimeById: (providerId: AiSessionProviderId, sessionId: string) => TRuntime | null;
    refreshRuntimeGuard?: (providerId?: AiSessionProviderId, sessionId?: string) => Promise<void>;
    isRuntimeComplete: (runtime: TRuntime) => boolean;
    focusRuntime: (runtime: TRuntime) => unknown;
    deleteRuntimeMarker: (runtime: TRuntime) => void;
    untrackRuntime: (
        providerId: AiSessionProviderId,
        sessionId: string,
        workspaceScopeIdentity: string
    ) => void;
    deletePin: (providerId: AiSessionProviderId, sessionId: string) => void;
    deleteAlias: (providerId: AiSessionProviderId, sessionId: string) => void;
    confirmSingleArchive: (providerLabel: string) => Thenable<string | undefined>;
    confirmBatchArchive: (message: string) => Thenable<string | undefined>;
    showWarningMessage: (message: string) => unknown;
    showErrorMessage: (message: string) => unknown;
    showInformationMessage: (message: string) => unknown;
    appendLine: (message: string) => void;
    postCompletion: (completion: AiSessionBatchArchiveCompletedMessage) => void;
    refresh: () => void;
    syncActiveRuntime: () => void;
    logUnexpectedError: (operation: string, error: unknown, failedSessionId?: string) => void;
}

export class AiSessionArchiveController<TRuntime extends AiSessionArchiveRuntimeEntry = AiSessionArchiveRuntimeEntry> {
    constructor(private readonly options: AiSessionArchiveControllerOptions<TRuntime>) {
    }

    async archiveSession(
        projectId: string,
        providerId: AiSessionProviderId | null,
        sessionId: string
    ): Promise<void> {
        if (!projectId || !providerId || !this.options.isProviderId(providerId) || !sessionId) {
            return;
        }
        const authorization = this.resolveSingleArchiveAuthorization(projectId, providerId, sessionId);
        if (!authorization) {
            return;
        }

        const sessionProvider = this.options.getProvider(providerId);
        if (!await this.refreshRuntimeGuard(providerId, sessionId)) {
            return;
        }
        if (!this.isSingleArchiveAuthorizationCurrent(authorization, projectId, providerId, sessionId)) {
            return;
        }
        let runtime = this.options.getRuntimeById(providerId, sessionId);
        if (await this.blockActiveRuntime(sessionProvider.label, runtime, sessionId)) {
            return;
        }

        const accepted = await this.options.confirmSingleArchive(sessionProvider.label);
        if (!accepted) {
            return;
        }

        if (!await this.refreshRuntimeGuard(providerId, sessionId)) {
            return;
        }
        if (!this.isSingleArchiveAuthorizationCurrent(authorization, projectId, providerId, sessionId)) {
            return;
        }
        runtime = this.options.getRuntimeById(providerId, sessionId);
        if (await this.blockActiveRuntime(sessionProvider.label, runtime, sessionId)) {
            return;
        }
        if (!this.isSingleArchiveAuthorizationCurrent(authorization, projectId, providerId, sessionId)) {
            return;
        }

        const status = this.archiveSessionItem(providerId, sessionId);
        if (status === 'running') {
            runtime = this.options.getRuntimeById(providerId, sessionId);
            this.options.showWarningMessage(`This ${sessionProvider.label} session has an active runtime. Exit the AI provider before archiving it.`);
            if (runtime) {
                try {
                    await this.options.focusRuntime(runtime);
                } catch (error) {
                    this.options.logUnexpectedError('focus-runtime', error, sessionId);
                    this.options.showErrorMessage('Could not focus the AI session terminal.');
                    this.options.refresh();
                }
            }
            return;
        }

        if (status === 'failed') {
            this.options.showErrorMessage(`Could not archive ${sessionProvider.label} session.`);
            return;
        }

        this.options.syncActiveRuntime();
        this.options.refresh();
    }

    private resolveSingleArchiveAuthorization(
        projectId: string,
        providerId: AiSessionProviderId,
        sessionId: string
    ): SingleArchiveAuthorization | null {
        const target = this.options.getWorkspaceTarget(projectId);
        if (!target
            || target.cardId !== projectId
            || target.sessions.workspaceScopeIdentity !== target.workspace.scopeIdentity
            || target.sessions.workspaceNavigationIdentity !== target.workspace.navigationIdentity
            || !(target.sessions.sessionsByProvider[providerId] || [])
                .some(session => session.id === sessionId)) {
            return null;
        }
        return {
            projectId,
            workspaceScopeIdentity: target.workspace.scopeIdentity,
            workspaceNavigationIdentity: target.workspace.navigationIdentity,
        };
    }

    private isSingleArchiveAuthorizationCurrent(
        authorization: SingleArchiveAuthorization,
        projectId: string,
        providerId: AiSessionProviderId,
        sessionId: string
    ): boolean {
        const current = this.resolveSingleArchiveAuthorization(projectId, providerId, sessionId);
        return !!current
            && current.projectId === authorization.projectId
            && current.workspaceScopeIdentity === authorization.workspaceScopeIdentity
            && current.workspaceNavigationIdentity === authorization.workspaceNavigationIdentity;
    }

    archiveSessionItem(
        providerId: AiSessionProviderId,
        sessionId: string
    ): BatchAiSessionArchiveAttemptStatus {
        const sessionProvider = this.options.getProvider(providerId);
        const runtime = this.options.getRuntimeById(providerId, sessionId);
        return archiveBatchAiSessionItem(sessionId, {
            isRunning: () => Boolean(runtime && runtime.state !== 'stopped'
                && !this.options.isRuntimeComplete(runtime)),
            archiveSession: () => sessionProvider.service.archiveSession(sessionId),
            deleteEntryMarker: () => {
                if (runtime) {
                    this.options.deleteRuntimeMarker(runtime);
                }
            },
            untrackTerminal: () => {
                if (runtime) {
                    this.options.untrackRuntime(
                        providerId, sessionId, runtime.identity.workspaceScopeIdentity
                    );
                }
            },
            deletePin: () => this.options.deletePin(providerId, sessionId),
            deleteAlias: () => this.options.deleteAlias(providerId, sessionId),
        });
    }

    async archiveSessions(projectId: string, items: unknown): Promise<void> {
        if (!await this.refreshRuntimeGuard()) {
            return;
        }
        let completed = false;
        let executionStarted = false;
        let refreshed = false;
        let result: AggregateAiSessionArchiveResult | undefined;
        const complete = (
            status: AiSessionBatchArchiveCompletedMessage['status'],
            completionResult?: AggregateAiSessionArchiveResult
        ) => {
            if (completed) {
                return;
            }
            completed = true;
            this.options.postCompletion({
                type: 'ai-session-batch-archive-completed',
                projectId,
                status,
                result: completionResult,
            });
        };
        const refresh = () => {
            if (refreshed) {
                return;
            }
            refreshed = true;
            this.options.refresh();
        };

        try {
            const target = this.resolveAggregateArchiveTarget(projectId);
            if (!target) {
                this.options.showWarningMessage(
                    'The selected AI sessions are no longer in the active workspace.'
                );
                complete('rejected');
                return;
            }

            const selection = resolveAggregateAiSessionArchiveSelection(items, {
                selectedProviders: target.sessions.selectedProviders,
                sessionsByProvider: target.sessions.sessionsByProvider,
            });
            if (!selection.eligible.length) {
                this.logRejectedAggregateAiSessionSelections(selection);
                this.options.showWarningMessage('No eligible AI sessions were selected.');
                complete('rejected');
                return;
            }

            const eligibleCount = selection.eligible.length;
            const pinnedCount = selection.eligible.filter(item => item.session.pinned).length;
            const accepted = await this.options.confirmBatchArchive(
                `Archive ${eligibleCount} selected AI ${eligibleCount === 1 ? 'session' : 'sessions'}? `
                + `${pinnedCount} selected ${pinnedCount === 1 ? 'session is' : 'sessions are'} pinned.`
            );
            if (!accepted) {
                complete('cancelled');
                return;
            }
            if (!await this.refreshRuntimeGuard()) {
                complete('cancelled');
                return;
            }

            const currentTarget = this.resolveAggregateArchiveTarget(projectId);
            if (!currentTarget
                || currentTarget.workspace.scopeIdentity !== target.workspace.scopeIdentity
                || currentTarget.workspace.navigationIdentity !== target.workspace.navigationIdentity
                || selection.eligible.some(item =>
                    !currentTarget.sessions.selectedProviders.includes(item.provider)
                )) {
                this.options.showWarningMessage(
                    'The selected AI sessions are no longer in the active workspace and provider scope.'
                );
                complete('rejected');
                return;
            }

            executionStarted = true;
            result = {
                archived: [],
                running: [],
                missing: [],
                rejected: [...selection.rejected],
                rejectedCount: selection.rejectedCount,
                failed: [],
                malformedCount: selection.malformedCount,
            };
            for (const selectedItem of selection.eligible) {
                const item = toArchiveItem(selectedItem);
                const currentSession = (currentTarget.sessions.sessionsByProvider[item.provider] || [])
                    .find(session => session.id === item.sessionId);
                if (!currentSession) {
                    result.missing.push(item);
                    continue;
                }
                if (currentSession.active) {
                    result.running.push(item);
                    continue;
                }

                try {
                    const status = this.archiveSessionItem(item.provider, item.sessionId);
                    result[status === 'archived' ? 'archived' : status === 'running' ? 'running' : 'failed']
                        .push(item);
                } catch (error) {
                    result.failed.push(item);
                    this.options.logUnexpectedError(
                        'archive-session',
                        error,
                        this.formatAggregateAiSessionItemForLog(item)
                    );
                }
            }

            try {
                this.logAggregateAiSessionArchiveResult(result);
                const summary = formatAggregateAiSessionArchiveSummary(result);
                if (hasAggregateAiSessionArchiveIssues(result)) {
                    this.options.showWarningMessage(summary);
                } else {
                    this.options.showInformationMessage(summary);
                }
            } catch (error) {
                this.options.logUnexpectedError('report-result', error);
            }
            complete('finished', result);
            refresh();
        } catch (error) {
            this.options.logUnexpectedError(
                executionStarted ? 'execute-request' : 'prepare-request',
                error
            );
            complete(executionStarted ? 'finished' : 'rejected', result);
            if (executionStarted) {
                refresh();
            }
        } finally {
            this.options.syncActiveRuntime();
        }
    }

    private async refreshRuntimeGuard(
        providerId?: AiSessionProviderId,
        sessionId?: string
    ): Promise<boolean> {
        if (!this.options.refreshRuntimeGuard) {
            return true;
        }
        try {
            await this.options.refreshRuntimeGuard(providerId, sessionId);
            return true;
        } catch (_error) {
            this.options.logUnexpectedError(
                'refresh-runtime-guard',
                new Error('AI session runtime refresh failed.'),
                sessionId
            );
            this.options.showErrorMessage('Could not verify the AI session runtime.');
            this.options.refresh();
            return false;
        }
    }

    private async blockActiveRuntime(
        providerLabel: string,
        runtime: TRuntime | null,
        sessionId: string
    ): Promise<boolean> {
        if (!runtime || runtime.state === 'stopped' || this.options.isRuntimeComplete(runtime)) {
            return false;
        }
        this.options.showWarningMessage(
            `This ${providerLabel} session has an active runtime. Exit the AI provider before archiving it.`
        );
        try {
            await this.options.focusRuntime(runtime);
        } catch (error) {
            this.options.logUnexpectedError('focus-runtime', error, sessionId);
            this.options.showErrorMessage('Could not focus the AI session terminal.');
            this.options.refresh();
        }
        return true;
    }

    private resolveAggregateArchiveTarget(projectId: string): WorkspaceAiSessionActionTarget | null {
        const target = this.options.getWorkspaceTarget(projectId);
        if (!target
            || target.cardId !== projectId
            || target.sessions.workspaceScopeIdentity !== target.workspace.scopeIdentity
            || target.sessions.workspaceNavigationIdentity !== target.workspace.navigationIdentity) {
            return null;
        }
        return target;
    }

    private logRejectedAggregateAiSessionSelections(
        selection: Pick<AggregateAiSessionArchiveSelection, 'rejected' | 'rejectedCount' | 'malformedCount'>
    ): void {
        for (const item of selection.rejected) {
            this.options.appendLine(
                `[Batch Archive] Rejected out-of-scope session: ${this.formatAggregateAiSessionItemForLog(item)}`
            );
        }
        if (selection.rejectedCount > selection.rejected.length) {
            this.options.appendLine(
                `[Batch Archive] Omitted ${selection.rejectedCount - selection.rejected.length} additional out-of-scope session(s).`
            );
        }
        if (selection.malformedCount) {
            this.options.appendLine(
                `[Batch Archive] Rejected ${selection.malformedCount} malformed selection(s).`
            );
        }
    }

    private logAggregateAiSessionArchiveResult(result: AggregateAiSessionArchiveResult): void {
        this.logRejectedAggregateAiSessionSelections(result);
        for (const item of result.running) {
            this.options.appendLine(
                `[Batch Archive] Skipped running session: ${this.formatAggregateAiSessionItemForLog(item)}`
            );
        }
        for (const item of result.missing) {
            this.options.appendLine(
                `[Batch Archive] Session no longer available: ${this.formatAggregateAiSessionItemForLog(item)}`
            );
        }
        for (const item of result.failed) {
            this.options.appendLine(
                `[Batch Archive] Archive failed: ${this.formatAggregateAiSessionItemForLog(item)}`
            );
        }
    }

    private formatAggregateAiSessionItemForLog(item: AiSessionArchiveItem): string {
        return `${this.options.getProviderLabel(item.provider)} / ${formatBatchAiSessionIdForLog(item.sessionId)}`;
    }
}

interface SingleArchiveAuthorization {
    projectId: string;
    workspaceScopeIdentity: string;
    workspaceNavigationIdentity: string;
}

function toArchiveItem(item: AiSessionArchiveItem): AiSessionArchiveItem {
    return { provider: item.provider, sessionId: item.sessionId };
}
