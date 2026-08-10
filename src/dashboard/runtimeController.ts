'use strict';

import type { AiSessionProviderId, Project } from '../models';
import type { AiSessionActiveTerminalChangedMessage, AiSessionBatchArchiveCompletedMessage } from '../aiSessions/types';
import type { ActiveAiSessionTerminalIdentity } from '../aiSessions/activeTerminalHighlight';
import {
    AGENT_PIVOT_EXTENSION_ID,
    AGENT_PIVOT_VIEW_CONTAINER_ID,
} from '../constants';

export interface DashboardRuntimeControllerOptions<TProject extends Project = Project> {
    isVisible: () => boolean;
    refreshProvider: () => void;
    logDashboardDiagnostic: (event: Record<string, unknown>) => void;
    executeCommand: (command: string, ...args: unknown[]) => Thenable<unknown> | Promise<unknown>;
    viewType: string;
    publishOpenWorkspace: () => void;
    getCurrentSavedProject: () => TProject | null;
    syncProjectColorToCurrentWindow: (project: TProject | null) => Thenable<void> | Promise<void>;
    postMessage: (message: unknown) => Thenable<unknown> | Promise<unknown>;
    logError: (message: string, error: unknown) => void;
    refreshAiSessionRuntimes?: (reason: string, force: boolean) => Thenable<void> | Promise<void>;
    logAiSessionRuntimeFailure?: (operation: string, error: unknown) => void;
    nowMs?: () => number;
    visibilityRefreshMinIntervalMs?: number;
}

const DEFAULT_VISIBILITY_REFRESH_MIN_INTERVAL_MS = 10_000;

export interface RevealAgentPivotDashboardOptions {
    executeCommand: (command: string, ...args: unknown[]) => Thenable<unknown> | Promise<unknown>;
    viewType: string;
}

export function revealAgentPivotDashboard(
    options: RevealAgentPivotDashboardOptions,
): Promise<void> {
    return runAsync(() => options.executeCommand(
        `workbench.view.extension.${AGENT_PIVOT_VIEW_CONTAINER_ID}`
    ))
        .then(() => runAsync(() => options.executeCommand(`${options.viewType}.focus`)))
        .then(undefined, () => runAsync(() => options.executeCommand(`${options.viewType}.focus`)))
        .then(undefined, () => undefined);
}

export class DashboardRuntimeController<TProject extends Project = Project> {
    private visibilityRefreshFlight: Promise<void> | null = null;
    private lastVisibilityRefreshAtMs: number | null = null;

    constructor(private readonly options: DashboardRuntimeControllerOptions<TProject>) {
    }

    refresh(reason = 'refresh'): void {
        if (!this.options.isVisible()) {
            return;
        }

        this.options.logDashboardDiagnostic({
            event: 'full-refresh',
            reason,
        });
        this.options.refreshProvider();
    }

    async showAgentPivot(): Promise<void> {
        this.options.publishOpenWorkspace();
        await this.revealAgentPivotDashboard();
        this.refresh('show-agent-pivot');
    }

    async handleAiSessionViewVisibilityChanged(visible: boolean): Promise<void> {
        if (!visible || !this.options.refreshAiSessionRuntimes) {
            return;
        }

        if (this.visibilityRefreshFlight) {
            return this.visibilityRefreshFlight;
        }

        const nowMs = this.nowMs();
        if (this.lastVisibilityRefreshAtMs !== null
            && nowMs - this.lastVisibilityRefreshAtMs < this.visibilityRefreshMinIntervalMs()) {
            return;
        }

        let tracked: Promise<void>;
        const refresh = this.runAsync(() => this.options.refreshAiSessionRuntimes(
            'dashboard-visible', false
        )).then(
            () => { this.lastVisibilityRefreshAtMs = this.nowMs(); },
            error => { this.options.logAiSessionRuntimeFailure?.('dashboard-visible', error); },
        );
        tracked = refresh.then(() => {
            if (this.visibilityRefreshFlight === tracked) {
                this.visibilityRefreshFlight = null;
            }
        });
        this.visibilityRefreshFlight = tracked;
        return tracked;
    }

    refreshAfterMutation(reason = 'project-mutation'): void {
        this.applyProjectColorToCurrentWindow();
        this.refresh(reason);
        this.options.publishOpenWorkspace();
    }

    revealAgentPivotDashboard(): Promise<void> {
        return revealAgentPivotDashboard(this.options);
    }

    postBatchArchiveCompletion(message: AiSessionBatchArchiveCompletedMessage): void {
        this.runAsync(() => this.options.postMessage(message)).then(undefined, error => {
            this.options.logError('Failed to post batch AI session archive completion.', error);
        });
    }

    postActiveAiSessionTerminalChanged(
        identity: ActiveAiSessionTerminalIdentity | null,
        projectionRevision?: number,
    ): void {
        const message: AiSessionActiveTerminalChangedMessage & { projectionRevision?: number } = {
            type: 'active-ai-session-terminal-changed',
            ...(Number.isSafeInteger(projectionRevision) ? { projectionRevision } : {}),
            provider: identity?.provider as AiSessionProviderId || null,
            sessionId: identity?.sessionId || null,
        };
        this.runAsync(() => this.options.postMessage(message)).then(undefined, error => {
            this.options.logError('Failed to post the active AI session terminal.', error);
        });
    }

    applyProjectColorToCurrentWindow(project: TProject = null): void {
        const targetProject: TProject | null = project || this.options.getCurrentSavedProject();
        this.runAsync(() => this.options.syncProjectColorToCurrentWindow(targetProject)).then(undefined, error => {
            this.options.logError('Failed to apply project color to current window.', error);
        });
    }

    async openSettings(query = `@ext:${AGENT_PIVOT_EXTENSION_ID}`): Promise<void> {
        await this.runAsync(() => this.options.executeCommand('workbench.action.openSettings', query));
    }

    private runAsync<T>(operation: () => Thenable<T> | Promise<T> | T): Promise<T> {
        return runAsync(operation);
    }

    private nowMs(): number {
        return this.options.nowMs ? this.options.nowMs() : Date.now();
    }

    private visibilityRefreshMinIntervalMs(): number {
        const configured = this.options.visibilityRefreshMinIntervalMs;
        return Number.isFinite(configured) && (configured as number) >= 0
            ? configured as number
            : DEFAULT_VISIBILITY_REFRESH_MIN_INTERVAL_MS;
    }
}

function runAsync<T>(operation: () => Thenable<T> | Promise<T> | T): Promise<T> {
    try {
        return Promise.resolve(operation());
    } catch (error) {
        return Promise.reject(error);
    }
}
