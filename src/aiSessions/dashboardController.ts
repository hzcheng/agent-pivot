'use strict';

import type { AiSessionProviderId, Group, WorkspaceCardViewModel } from '../models';
import type { AiSessionsUpdatedMessage } from './types';
import { buildAiSessionsUpdatedMessage } from '../dashboard/webviewUpdateMessages';
import type { TodoSearchCatalogItem } from '../todos/types';

interface DisposableLike {
    dispose(): void;
}

export interface AiSessionDashboardControllerOptions<
    TProjection extends AiSessionDashboardProjection = AiSessionDashboardProjection
> {
    providerIds: AiSessionProviderId[];
    isVisible: () => boolean;
    invalidateCache: (providerId: AiSessionProviderId) => void;
    watchSessionChanges: (providerId: AiSessionProviderId, onDidChange: () => void) => DisposableLike;
    getGroups: () => Group[];
    getTodoSearchItems: () => TodoSearchCatalogItem[];
    getSkillRecords?: () => import('../skills/types').SkillRecord[];
    getCards: (projection: TProjection) => WorkspaceCardViewModel[];
    getRunningCardAnimation: () => string | undefined;
    getRunningIconAnimation: () => string | undefined;
    beginProjection: (reason: string) => TProjection;
    postMessage: (message: unknown) => Thenable<boolean>;
    refresh: (reason: string) => void;
    logError: (message: string, error: unknown) => void;
    logDiagnostic?: (event: Record<string, unknown>) => void;
    nowMs?: () => number;
    afterRefresh?: () => void;
    debounceMs: number;
    watcherRefreshMinIntervalMs?: number;
    watcherStopGraceMs?: number;
    newSessionRefreshDelaysMs: number[];
    setTimeout: (callback: () => void, delayMs: number) => NodeJS.Timeout;
    clearTimeout: (handle: NodeJS.Timeout) => void;
}

export interface AiSessionDashboardProjection {
    revision: number;
}

export interface AiSessionDashboardRefreshOptions {
    fallbackToFullRefresh?: boolean;
}

export class AiSessionDashboardController<
    TProjection extends AiSessionDashboardProjection = AiSessionDashboardProjection
> {
    private refreshTimeout: NodeJS.Timeout = null;
    private watcherStopTimeout: NodeJS.Timeout = null;
    private newSessionRefreshTimeouts: NodeJS.Timeout[] = [];
    private watcherDisposables: DisposableLike[] = [];
    private pendingRefreshReason = 'refresh';
    private pendingRefreshDueAtMs = 0;
    private lastWatcherRefreshAtMs: number | null = null;
    private lastPostedIncrementalMessageSignature: string | null = null;

    constructor(private readonly options: AiSessionDashboardControllerOptions<TProjection>) {
    }

    scheduleRefresh(reason = 'refresh'): void {
        if (!this.options.isVisible()) {
            return;
        }

        const dueAtMs = this.nowMs() + this.getRefreshDelayMs(reason);
        // A later request never postpones an already pending refresh. Watcher events
        // arrive continuously while a session streams, and re-arming on the newest
        // reason used to push an urgent status repaint out to the watcher interval
        // and relabel it, so the attention dot lagged the running animation.
        if (this.refreshTimeout !== null && dueAtMs >= this.pendingRefreshDueAtMs) {
            return;
        }

        this.pendingRefreshReason = reason;
        this.pendingRefreshDueAtMs = dueAtMs;
        if (this.refreshTimeout) {
            this.options.clearTimeout(this.refreshTimeout);
        }

        this.refreshTimeout = this.options.setTimeout(() => {
            this.refreshTimeout = null;
            void this.refreshNow(this.pendingRefreshReason);
        }, this.getRefreshDelayMs(reason));
    }

    setWatchersActive(active: boolean): void {
        if (active) {
            this.cancelWatcherStop();
            this.startWatchers();
        } else {
            this.scheduleWatcherStop();
        }
    }

    scheduleNewSessionRefresh(providerId: AiSessionProviderId): void {
        for (let delay of this.options.newSessionRefreshDelaysMs) {
            let timeout: NodeJS.Timeout = null;
            let firedSynchronously = false;
            const callback = () => {
                if (timeout) {
                    this.newSessionRefreshTimeouts = this.newSessionRefreshTimeouts.filter(handle => handle !== timeout);
                } else {
                    firedSynchronously = true;
                }
                this.options.invalidateCache(providerId);
                void this.refreshNow('new-session');
            };
            timeout = this.options.setTimeout(callback, delay);
            if (!firedSynchronously) {
                this.newSessionRefreshTimeouts.push(timeout);
            }
        }
    }

    async refreshNow(
        reason = 'refresh',
        refreshOptions: AiSessionDashboardRefreshOptions = {}
    ): Promise<void> {
        if (!this.options.isVisible()) {
            return;
        }

        const fallbackToFullRefresh = refreshOptions.fallbackToFullRefresh !== false;
        const projection = this.options.beginProjection(reason);
        try {
            const message = this.buildUpdatedMessage(reason, projection);
            const signature = this.getIncrementalMessageSignature(message);
            if (this.shouldSkipUnchangedMessage(reason) && signature === this.lastPostedIncrementalMessageSignature) {
                this.options.logDiagnostic?.({
                    event: 'ai-session-message-skip',
                    reason,
                    sequence: message.sequence,
                    cardCount: message.searchCatalog.openWorkspaces.length,
                    currentWorkspaceCount: message.currentWorkspaceCount,
                });
                return;
            }

            if (this.shouldSkipUnchangedMessage(reason)) {
                this.lastPostedIncrementalMessageSignature = signature;
            }
            this.options.postMessage(message).then(delivered => {
                if (!delivered) {
                    this.lastPostedIncrementalMessageSignature = null;
                    if (fallbackToFullRefresh) {
                        this.options.refresh('ai-session-update-not-delivered');
                    }
                }
            }, error => {
                this.lastPostedIncrementalMessageSignature = null;
                this.options.logError('Failed to post AI session update message.', error);
                if (fallbackToFullRefresh) {
                    this.options.refresh('ai-session-update-post-error');
                }
            });
        } catch (error) {
            this.options.logError('Failed to update AI sessions incrementally.', error);
            if (fallbackToFullRefresh) {
                this.options.refresh('ai-session-update-build-error');
            }
        } finally {
            if (reason === 'watcher') {
                this.lastWatcherRefreshAtMs = this.nowMs();
            }
            this.options.afterRefresh?.();
        }
    }

    getUpdatedMessage(reason = 'refresh'): AiSessionsUpdatedMessage {
        const projection = this.options.beginProjection(reason);
        try {
            return this.buildUpdatedMessage(reason, projection);
        } finally {
            this.options.afterRefresh?.();
        }
    }

    private buildUpdatedMessage(
        reason: string,
        projection: TProjection
    ): AiSessionsUpdatedMessage {
        const startedAt = this.nowMs();
        const cards = this.options.getCards(projection);
        const message = buildAiSessionsUpdatedMessage({
            groups: this.options.getGroups(),
            cards,
            sequence: projection.revision,
            generatedAt: new Date().toISOString(),
            todoSearchItems: this.options.getTodoSearchItems(),
            skills: this.options.getSkillRecords ? this.options.getSkillRecords() : [],
            runningCardAnimation: this.options.getRunningCardAnimation(),
            runningIconAnimation: this.options.getRunningIconAnimation(),
        });
        this.options.logDiagnostic?.({
            event: 'ai-session-message-build',
            reason,
            durationMs: this.nowMs() - startedAt,
            cardCount: cards.length,
            currentWorkspaceCount: message.currentWorkspaceCount,
        });
        return message;
    }

    dispose(): void {
        this.cancelWatcherStop();
        this.stopWatchers();
        for (let timeout of this.newSessionRefreshTimeouts) {
            this.options.clearTimeout(timeout);
        }
        this.newSessionRefreshTimeouts = [];
    }

    private startWatchers(): void {
        if (this.watcherDisposables.length) {
            return;
        }

        this.watcherDisposables = this.options.providerIds
            .map(providerId => this.options.watchSessionChanges(providerId, () => this.scheduleRefresh('watcher')));
    }

    private scheduleWatcherStop(): void {
        if (!this.watcherDisposables.length || this.watcherStopTimeout !== null) {
            return;
        }
        const delayMs = Math.max(0, this.options.watcherStopGraceMs ?? 5000);
        if (delayMs === 0) {
            this.stopWatchers();
            return;
        }
        this.watcherStopTimeout = this.options.setTimeout(() => {
            this.watcherStopTimeout = null;
            if (!this.options.isVisible()) {
                this.stopWatchers();
            }
        }, delayMs);
    }

    private cancelWatcherStop(): void {
        if (this.watcherStopTimeout === null) {
            return;
        }
        this.options.clearTimeout(this.watcherStopTimeout);
        this.watcherStopTimeout = null;
    }

    private stopWatchers(): void {
        for (let disposable of this.watcherDisposables) {
            disposable.dispose();
        }

        this.watcherDisposables = [];
        if (this.refreshTimeout) {
            this.options.clearTimeout(this.refreshTimeout);
            this.refreshTimeout = null;
        }
    }

    private nowMs(): number {
        return this.options.nowMs ? this.options.nowMs() : Date.now();
    }

    private getRefreshDelayMs(reason: string): number {
        if (reason !== 'watcher' || this.lastWatcherRefreshAtMs === null) {
            return this.options.debounceMs;
        }

        const minIntervalMs = Math.max(this.options.watcherRefreshMinIntervalMs || 0, this.options.debounceMs);
        const elapsedMs = Math.max(0, this.nowMs() - this.lastWatcherRefreshAtMs);
        return Math.max(this.options.debounceMs, minIntervalMs - elapsedMs);
    }

    private shouldSkipUnchangedMessage(reason: string): boolean {
        return reason === 'watcher' || reason === 'attention';
    }

    private getIncrementalMessageSignature(message: AiSessionsUpdatedMessage): string {
        return JSON.stringify({
            currentWorkspaceCount: message.currentWorkspaceCount,
            html: message.html,
            searchCatalog: this.stableValue(message.searchCatalog),
        });
    }

    private stableValue(value: unknown): unknown {
        if (Array.isArray(value)) {
            return value.map(item => this.stableValue(item));
        }
        if (!value || typeof value !== 'object') {
            return value;
        }
        return Object.keys(value as Record<string, unknown>)
            .sort()
            .reduce((result, key) => {
                result[key] = this.stableValue((value as Record<string, unknown>)[key]);
                return result;
            }, {} as Record<string, unknown>);
    }
}
