'use strict';

import type * as vscode from 'vscode';
import type { AiSessionArchiveController } from '../aiSessions/archiveController';
import type { AiSessionCommandController } from '../aiSessions/commandController';
import type { AiSessionRuntimeSnapshot } from '../aiSessions/runtimeTypes';
import type { AiSessionTerminalCommandController } from '../aiSessions/terminalCommandController';
import { isAiSessionProviderId } from '../models';
import type { AiSessionProviderId, StewardInfos } from '../models';
import type { PromptDashboardController } from '../prompts/dashboardController';
import type { PromptTerminalCommandController } from '../prompts/terminalCommandController';
import type ProjectService from '../services/projectService';
import type { DashboardWorkspaceSearchCatalog } from '../webview/dashboardViewModel';
import { getProjectsPanelContent } from '../webview/webviewContent';
import type { DashboardMessageHandler } from './messageRouter';

export interface DashboardMessageHandlersOptions {
    postMessage: (message: unknown) => Thenable<unknown>;
    /** Late-bound: stewardInfos is assembled after the message router. */
    getStewardInfos: () => StewardInfos;
    projectService: ProjectService;
    /** Late-bound authoritative catalog returned with the lazy Projects panel. */
    getSearchCatalog?: () => DashboardWorkspaceSearchCatalog;
    promptDashboardController: PromptDashboardController;
    /** Late-bound: the prompt terminal controller is constructed after the router. */
    getPromptTerminalCommandController: () => PromptTerminalCommandController;
    aiSessionCommandController: AiSessionCommandController;
    aiSessionTerminalCommandController: AiSessionTerminalCommandController<vscode.Terminal>;
    focusAiSessionAndFollowConversation(target: {
        projectId: string;
        provider: AiSessionProviderId;
        sessionId: string;
    }): Promise<void>;
    aiSessionArchiveController: AiSessionArchiveController<AiSessionRuntimeSnapshot<vscode.Terminal>>;
    acknowledgeAiSessionAttentionEventIds: (
        eventIds: string[],
        target?: {
            provider: AiSessionProviderId;
            sessionId: string;
            workspaceScopeIdentity: string;
        }
    ) => Promise<void | 'committed' | 'degraded-local' | 'rejected'>;
    logOpenWorkspaceDiagnostic: (component: string, event: unknown) => void;
    refreshStewardViews: (reason?: string) => void;
    onOpenWorkspacesRendererReady: () => void;
    /** Late-bound: the highlighter is constructed after the message router. */
    requestActiveAiSessionTerminalHighlight: () => void;
    showAgentPivotSettings: () => Promise<void>;
    showBridgeExtension: () => Thenable<unknown>;
    showSponsorOptions: () => Promise<void>;
    dismissOpenTabLayoutNotice: () => Thenable<unknown>;
    openOpenTabLayoutMigrationGuide: () => Thenable<unknown>;
}

/**
 * Owns the remaining plain-delegate dashboard message handlers: panel content
 * requests, prompt commands, AI session terminal/pin/rename/archive delegates,
 * renderer diagnostics, and settings/bridge openers.
 *
 * Extracted from `initializeDashboard` in src/dashboard.ts (see the project
 * message handlers for the same slice pattern). Behaviour is unchanged: the
 * handler bodies delegate to the same controllers with the same arguments;
 * only their ownership moved. The router-level special hooks (create/resume/
 * archive session, save workspace) stay in dashboard.ts.
 */
export function createDashboardMessageHandlers(
    options: DashboardMessageHandlersOptions
): Record<string, DashboardMessageHandler> {
    const postMessage = options.postMessage;
    const getStewardInfos = options.getStewardInfos;
    const projectService = options.projectService;
    const getSearchCatalog = options.getSearchCatalog;
    const promptDashboardController = options.promptDashboardController;
    const getPromptTerminalCommandController = options.getPromptTerminalCommandController;
    const aiSessionCommandController = options.aiSessionCommandController;
    const aiSessionTerminalCommandController = options.aiSessionTerminalCommandController;
    const focusAiSessionAndFollowConversation = options.focusAiSessionAndFollowConversation;
    const aiSessionArchiveController = options.aiSessionArchiveController;
    const acknowledgeAiSessionAttentionEventIds = options.acknowledgeAiSessionAttentionEventIds;
    const logOpenWorkspaceDiagnostic = options.logOpenWorkspaceDiagnostic;
    const refreshStewardViews = options.refreshStewardViews;
    const onOpenWorkspacesRendererReady = options.onOpenWorkspacesRendererReady;
    const requestActiveAiSessionTerminalHighlight = options.requestActiveAiSessionTerminalHighlight;
    const showAgentPivotSettings = options.showAgentPivotSettings;
    const showBridgeExtension = options.showBridgeExtension;
    const showSponsorOptions = options.showSponsorOptions;
    const dismissOpenTabLayoutNotice = options.dismissOpenTabLayoutNotice;
    const openOpenTabLayoutMigrationGuide = options.openOpenTabLayoutMigrationGuide;
    const attentionAcknowledgementFlights = new Map<string, {
        eventIdsFingerprint: string;
        flight: Promise<'committed' | 'degraded-local' | 'rejected'>;
        settled: boolean;
    }>();
    const pruneAttentionAcknowledgementFlights = () => {
        while (attentionAcknowledgementFlights.size > 256) {
            const settledKey = Array.from(attentionAcknowledgementFlights.entries())
                .find(([, entry]) => entry.settled)?.[0];
            if (!settledKey) {
                return;
            }
            attentionAcknowledgementFlights.delete(settledKey);
        }
    };

    return {
        'request-projects-panel': async e => {
            if (e.version !== 1 || !Number.isSafeInteger(e.requestId) || e.requestId < 1) {
                return;
            }
            await postMessage({
                type: 'projects-panel-content',
                version: 1,
                requestId: e.requestId,
                html: getProjectsPanelContent(projectService.getGroups(), getStewardInfos()),
                ...(getSearchCatalog ? { searchCatalog: getSearchCatalog() } : {}),
            });
        },
        'request-ai-panel': async e => {
            if (Object.keys(e).length !== 4
                || e.version !== 1
                || typeof e.requestId !== 'string'
                || e.requestId.length < 1
                || e.requestId.length > 128
                || e.target !== 'global-prompt-library') {
                return;
            }
            await postMessage(
                promptDashboardController.getPanelContent(e.requestId)
            );
        },
        'prompt-command': async e => {
            const result = await promptDashboardController.handle(e);
            if (result !== undefined) {
                await postMessage(result);
            }
        },
        'prompt-insert-terminal': async e => {
            const result = await getPromptTerminalCommandController().handleInsertRequest(e);
            if (result !== undefined) {
                await postMessage(result);
            }
        },
        'toggle-codex-sessions': async e => {
            await aiSessionCommandController.toggleSessionsExpanded(e.projectId as string, Boolean(e.expanded));
        },
        // M2 window view-state protocol (additive until the PR-D cutover).
        // Same fire-and-forget semantics as the surface route: strict envelope
        // shape, controller resolves the workspace scope, store validates.
        'select-ai-session-view-tab': async e => {
            const keys = Object.keys(e).sort();
            if (e.version !== 1
                || keys.join('\n') !== ['projectId', 'tab', 'type', 'version'].sort().join('\n')) {
                return;
            }
            await aiSessionCommandController.selectWindowViewTab(e.projectId, e.tab);
        },
        'select-ai-session-chats-view-mode': async e => {
            const keys = Object.keys(e).sort();
            if (e.version !== 1
                || keys.join('\n') !== ['projectId', 'type', 'version', 'viewMode'].sort().join('\n')) {
                return;
            }
            await aiSessionCommandController.selectChatsViewMode(e.projectId, e.viewMode);
            refreshStewardViews('select-ai-session-chats-view-mode');
        },
        'open-tab-telemetry': e => {
            if (Object.keys(e).sort().join('\n') !== ['event', 'type', 'version'].join('\n')
                || e.type !== 'open-tab-telemetry'
                || e.version !== 1
                || e.event !== 'chats-view-menu-opened') {
                return;
            }
            logOpenWorkspaceDiagnostic('Telemetry', { event: 'open-tab-chats-view-menu-opened' });
        },
        'dismiss-open-tab-layout-notice': async e => {
            if (Object.keys(e).sort().join('\n') !== ['type', 'version'].join('\n')
                || e.type !== 'dismiss-open-tab-layout-notice'
                || e.version !== 1) {
                return;
            }
            try {
                await dismissOpenTabLayoutNotice();
                await postMessage({
                    type: 'open-tab-layout-notice-dismissed',
                    version: 1,
                    outcome: 'dismissed',
                });
            } catch (_error) {
                await postMessage({
                    type: 'open-tab-layout-notice-dismissed',
                    version: 1,
                    outcome: 'failed',
                });
            }
        },
        'open-open-tab-layout-migration-guide': async e => {
            if (Object.keys(e).sort().join('\n') !== ['type', 'version'].join('\n')
                || e.type !== 'open-open-tab-layout-migration-guide'
                || e.version !== 1) {
                return;
            }
            await openOpenTabLayoutMigrationGuide();
        },
        'set-ai-session-collapsed-worktree-groups': async e => {
            const keys = Object.keys(e).sort();
            if (e.version !== 1
                || keys.join('\n')
                    !== ['collapsedKeys', 'projectId', 'type', 'version'].sort().join('\n')) {
                return;
            }
            await aiSessionCommandController.setCollapsedWorktreeGroups(e.projectId, e.collapsedKeys);
        },
        'migrate-ai-session-view-state': async e => {
            const keys = Object.keys(e).sort();
            if (e.version !== 1
                || keys.join('\n') !== ['projectId', 'tab', 'type', 'version'].sort().join('\n')) {
                return;
            }
            await aiSessionCommandController.importLegacyWindowViewTab(e.projectId, e.tab);
        },
        'select-ai-session-providers': async e => {
            await aiSessionCommandController.selectProviders(
                e.projectId as string,
                e.selectedProviders,
                e.requestId,
                e.version
            );
        },
        'focus-ai-session-terminal': async e => {
            const target = {
                projectId: e.projectId as string,
                provider: e.provider as AiSessionProviderId,
                sessionId: e.sessionId as string,
            };
            await focusAiSessionAndFollowConversation(target);
        },
        'focus-pending-ai-session': async e => {
            await aiSessionTerminalCommandController.focusPending(
                e.projectId as string,
                e.provider as string,
                e.createdAt as string
            );
        },
        'close-ai-session-terminal': async e => {
            await aiSessionTerminalCommandController.closeTerminal({
                projectId: e.projectId as string,
                providerId: e.provider as string,
                sessionId: e.sessionId as string,
                pendingCreatedAt: e.pendingCreatedAt as string,
                expectedBackend: 'vscode',
            });
        },
        'detach-ai-session-terminal': async e => {
            await aiSessionTerminalCommandController.closeTerminal({
                projectId: e.projectId as string,
                providerId: e.provider as string,
                sessionId: e.sessionId as string,
                pendingCreatedAt: e.pendingCreatedAt as string,
                expectedBackend: 'tmux',
            });
        },
        'stop-ai-session-runtime': async e => {
            const expectedBackend = e.backend === undefined
                ? 'tmux'
                : e.backend === 'vscode' || e.backend === 'tmux'
                    ? e.backend
                    : undefined;
            if (!expectedBackend) {
                return;
            }
            await aiSessionTerminalCommandController.stopSession({
                projectId: e.projectId as string,
                providerId: e.provider as string,
                sessionId: e.sessionId as string,
                pendingCreatedAt: e.pendingCreatedAt as string,
                expectedBackend,
            });
        },
        'toggle-ai-session-pin': async e => {
            await aiSessionCommandController.togglePin(e.provider as string, e.sessionId as string);
        },
        'acknowledge-ai-session-attention': async e => {
            const transactionCandidate = [
                'version', 'requestId', 'provider', 'sessionId',
                'workspaceScopeIdentity', 'projectionRevision',
            ].some(key => Object.prototype.hasOwnProperty.call(e, key));
            if (transactionCandidate) {
                if (e.version !== 1
                    || !Number.isSafeInteger(e.requestId)
                    || (e.requestId as number) < 1) {
                    return;
                }
                const correlated = {
                    type: 'ai-session-attention-acknowledgement-result',
                    version: 1,
                    requestId: e.requestId as number,
                    provider: typeof e.provider === 'string' ? e.provider : '',
                    sessionId: typeof e.sessionId === 'string' ? e.sessionId : '',
                    workspaceScopeIdentity: typeof e.workspaceScopeIdentity === 'string'
                        ? e.workspaceScopeIdentity : '',
                    projectionRevision: Number.isSafeInteger(e.projectionRevision)
                        ? e.projectionRevision as number : 0,
                };
                const exactKeys = [
                    'eventIds', 'projectionRevision', 'provider', 'requestId', 'sessionId',
                    'type', 'version', 'workspaceScopeIdentity',
                ];
                const eventIds = Array.isArray(e.eventIds) ? e.eventIds : [];
                const valid = Object.keys(e).sort().join('\n') === exactKeys.sort().join('\n')
                    && typeof e.provider === 'string' && isAiSessionProviderId(e.provider)
                    && typeof e.sessionId === 'string' && e.sessionId.length > 0 && e.sessionId.length <= 512
                    && typeof e.workspaceScopeIdentity === 'string'
                    && e.workspaceScopeIdentity.length > 0 && e.workspaceScopeIdentity.length <= 1024
                    && Number.isSafeInteger(e.projectionRevision) && (e.projectionRevision as number) > 0
                    && eventIds.length > 0 && eventIds.length <= 1000
                    && eventIds.every((id: unknown) => typeof id === 'string'
                        && id.length > 0 && id.length <= 1024)
                    && new Set(eventIds).size === eventIds.length;
                if (!valid) {
                    await postMessage({ ...correlated, outcome: 'rejected' });
                    return;
                }
                const flightKey = JSON.stringify([
                    correlated.workspaceScopeIdentity, correlated.provider,
                    correlated.sessionId, correlated.requestId,
                    correlated.projectionRevision,
                ]);
                const eventIdsFingerprint = JSON.stringify(eventIds);
                let entry = attentionAcknowledgementFlights.get(flightKey);
                if (entry && entry.eventIdsFingerprint !== eventIdsFingerprint) {
                    await postMessage({ ...correlated, outcome: 'rejected' });
                    return;
                }
                if (!entry) {
                    entry = {
                        eventIdsFingerprint,
                        settled: false,
                        flight: (async () => {
                        try {
                            const outcome = await acknowledgeAiSessionAttentionEventIds(
                                eventIds as string[],
                                {
                                    provider: e.provider as AiSessionProviderId,
                                    sessionId: e.sessionId as string,
                                    workspaceScopeIdentity: e.workspaceScopeIdentity as string,
                                }
                            );
                            return outcome === 'committed'
                                || outcome === 'degraded-local'
                                || outcome === 'rejected'
                                ? outcome : 'rejected';
                        } catch (_error) {
                            return 'rejected';
                        }
                        })(),
                    };
                    attentionAcknowledgementFlights.set(flightKey, entry);
                    pruneAttentionAcknowledgementFlights();
                }
                const outcome = await entry.flight;
                if (attentionAcknowledgementFlights.get(flightKey) === entry) {
                    entry.settled = true;
                    pruneAttentionAcknowledgementFlights();
                }
                await postMessage({ ...correlated, outcome });
                return;
            }
            if (Object.keys(e).sort().join('\n') !== ['eventIds', 'type'].sort().join('\n')) {
                return;
            }
            const attentionEventIds = Array.isArray(e.eventIds)
                ? e.eventIds.filter((id: unknown): id is string => typeof id === 'string') : [];
            await acknowledgeAiSessionAttentionEventIds(attentionEventIds);
        },
        'rename-ai-session': async e => {
            await aiSessionCommandController.renameSession(e.provider as string, e.sessionId as string);
        },
        'copy-ai-session-id': async e => {
            await aiSessionCommandController.copySessionId(e.sessionId as string);
        },
        'request-full-refresh': e => {
            logOpenWorkspaceDiagnostic('Renderer', {
                event: 'full-refresh-requested',
                reason: typeof e.reason === 'string' ? e.reason.slice(0, 256) : 'unknown',
            });
            refreshStewardViews(typeof e.reason === 'string' ? e.reason.slice(0, 256) : 'webview-requested');
        },
        'open-workspaces-renderer-ready': e => {
            if (Object.keys(e).length !== 3
                || e.type !== 'open-workspaces-renderer-ready'
                || e.version !== 1
                || !Number.isSafeInteger(e.documentGeneration)) {
                return;
            }
            logOpenWorkspaceDiagnostic('Renderer', {
                event: 'open-workspaces-renderer-ready',
            });
            onOpenWorkspacesRendererReady();
        },
        'open-workspaces-rendered': e => {
            logOpenWorkspaceDiagnostic('Renderer', {
                event: 'open-workspaces-rendered',
                semanticRevision: typeof e.semanticRevision === 'string'
                    ? e.semanticRevision.slice(0, 128)
                    : 'invalid',
                windowRowCount: Number.isSafeInteger(e.windowRowCount)
                    && (e.windowRowCount as number) >= 0
                    ? e.windowRowCount as number
                    : -1,
                currentWindowRowCount: (e.currentWindowRowCount === 0 || e.currentWindowRowCount === 1)
                    ? e.currentWindowRowCount as number
                    : -1,
                navigationWindowRowCount: Number.isSafeInteger(e.navigationWindowRowCount)
                    && (e.navigationWindowRowCount as number) >= 0
                    ? e.navigationWindowRowCount as number
                    : -1,
                currentDetailCount: (e.currentDetailCount === 0 || e.currentDetailCount === 1)
                    ? e.currentDetailCount as number
                    : -1,
                hasWindowSwitcher: e.hasWindowSwitcher === true,
                otherWindowsStatus: e.otherWindowsStatus === 'ready'
                    || e.otherWindowsStatus === 'connecting'
                    || e.otherWindowsStatus === 'unavailable'
                    || e.otherWindowsStatus === 'update-required'
                    ? e.otherWindowsStatus as string
                    : 'invalid',
            });
        },
        'request-active-ai-session-terminal': () => {
            requestActiveAiSessionTerminalHighlight();
        },
        'open-settings': async () => {
            await showAgentPivotSettings();
        },
        'open-bridge-extension': async () => {
            await showBridgeExtension();
        },
        'sponsor': async () => {
            await showSponsorOptions();
        },
        'archive-ai-sessions': async e => {
            await aiSessionArchiveController.archiveSessions(
                e.projectId,
                e.items,
                e.requestId,
                e.version
            );
        },
    };
}
