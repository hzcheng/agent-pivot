function initProjectAiSessionsUpdate(options) {
    'use strict';

    options = options || {};
    var batchAiSessionState = options.batchAiSessionState;
    var batchAiSessionManager = options.batchAiSessionManager;
    var getPendingAiSessionProviderSelectionProjectId = options.getPendingAiSessionProviderSelectionProjectId;
    var getSelectedAiSessionProviders = options.getSelectedAiSessionProviders;
    var syncAiSessionBatchManagementDom = options.syncAiSessionBatchManagementDom;
    var syncActiveAiSessionProjectionDom = options.syncActiveAiSessionProjectionDom;
    var reconcilePendingAiSessionProviderSelectionDom = options.reconcilePendingAiSessionProviderSelectionDom;
    var submitAiSessionProviderSelection = options.submitAiSessionProviderSelection;
    var toggleCodexSessions = options.toggleCodexSessions;
    var exitAiSessionBatchManagement = options.exitAiSessionBatchManagement;
    var isAiSessionProvider = options.isAiSessionProvider;
    var updateStickyGroupHeaderOffset = options.updateStickyGroupHeaderOffset;

    var pendingWorkspaceSessionReveal = null;
    var latestAiSessionUpdateSequence = 0;
    var latestAiSessionProjectionRevision = 0;

    function canApplyProjectionRevision(revision) {
        if (typeof revision === 'undefined') {
            return latestAiSessionProjectionRevision === 0;
        }
        return Number.isSafeInteger(revision)
            && revision > 0
            && revision > latestAiSessionProjectionRevision;
    }

    function commitProjectionRevision(revision) {
        if (Number.isSafeInteger(revision) && revision > 0) {
            latestAiSessionProjectionRevision = revision;
        }
    }

    function acceptProjectionRevision(revision) {
        if (!canApplyProjectionRevision(revision)) {
            return false;
        }
        commitProjectionRevision(revision);
        return true;
    }

    function applyAiSessionsUpdate(message) {
        if (message.version !== 2
            || typeof message.sequence !== 'number'
            || (message.currentWorkspaceCount !== 0 && message.currentWorkspaceCount !== 1)
            || typeof message.html !== 'string'
            || typeof normalizeDashboardSearchCatalog !== 'function'
            || normalizeDashboardSearchCatalog(message.searchCatalog) !== message.searchCatalog
            || message.searchCatalog.version !== 2) {
            requestFullRefresh('unsupported-ai-session-message');
            return;
        }

        if (message.sequence <= latestAiSessionUpdateSequence) {
            return;
        }
        if (!canApplyProjectionRevision(message.projectionRevision)) {
            return;
        }

        if (!applyWorkspaceUpdate({
            type: 'workspace-updated',
            version: 2,
            currentWorkspaceCount: message.currentWorkspaceCount,
            html: message.html,
        }, {
            canRestoreAiSessionProviderMenu: () =>
                !getPendingAiSessionProviderSelectionProjectId()
                && !batchAiSessionState.pending,
        })) {
            requestFullRefresh('invalid-ai-session-workspace-update');
            return;
        }

        latestAiSessionUpdateSequence = message.sequence;
        commitProjectionRevision(message.projectionRevision);
        if (batchAiSessionState.projectId) {
            var projectDiv = findCurrentWorkspaceDiv(batchAiSessionState.projectId);
            if (projectDiv) {
                batchAiSessionManager.reconcileVisible(projectDiv);
                syncAiSessionBatchManagementDom(projectDiv);
            } else {
                exitAiSessionBatchManagement();
            }
        }
        reconcilePendingAiSessionProviderSelectionDom();
        syncActiveAiSessionProjectionDom();
        updateStickyGroupHeaderOffset();
        if (window.__agentPivotDashboard) {
            window.__agentPivotDashboard.replaceSearchCatalog(message.searchCatalog);
        }
    }

    function findCurrentWorkspaceDiv(projectId) {
        if (!projectId) {
            return null;
        }

        var projects = document.querySelectorAll('.workspace-card[data-current-workspace][data-id]');
        for (var projectDiv of projects) {
            if (projectDiv.getAttribute("data-id") === projectId) {
                return projectDiv;
            }
        }

        return null;
    }

    function findWorkspaceDiv(navigationIdentity) {
        if (!navigationIdentity) {
            return null;
        }
        var workspaces = document.querySelectorAll('.workspace-card[data-workspace-navigation-identity]');
        for (var workspaceDiv of workspaces) {
            if (workspaceDiv.getAttribute('data-workspace-navigation-identity') === navigationIdentity) {
                return workspaceDiv;
            }
        }
        return null;
    }

    function focusSearchRevealTarget(target) {
        target.setAttribute('tabindex', '-1');
        target.focus();
        target.scrollIntoView({ block: 'nearest' });
        target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true });
    }

    window.__agentPivotRevealWorkspace = navigationIdentity => {
        var workspaceDiv = findWorkspaceDiv(navigationIdentity);
        if (!workspaceDiv) {
            return false;
        }
        focusSearchRevealTarget(workspaceDiv);
        return true;
    };

    function revealWorkspaceSession(navigationIdentity, provider, sessionId) {
        if (!isAiSessionProvider(provider) || !sessionId) {
            return false;
        }
        var workspaceDiv = findWorkspaceDiv(navigationIdentity);
        if (!workspaceDiv) {
            return false;
        }
        var workspaceId = workspaceDiv.getAttribute('data-id');
        if (!workspaceDiv.hasAttribute('data-codex-expanded')) {
            toggleCodexSessions(workspaceDiv, workspaceId);
        }
        selectAiSessionTabDom(workspaceDiv, 'sessions');
        writeAiSessionTabState(window.vscode, workspaceId, 'sessions');
        var sessionRow = Array.from(workspaceDiv.querySelectorAll('.codex-session-row[data-session-id][data-session-provider]'))
            .find(row => row.getAttribute('data-session-provider') === provider
                && row.getAttribute('data-session-id') === sessionId);
        if (sessionRow) {
            pendingWorkspaceSessionReveal = null;
            focusSearchRevealTarget(sessionRow);
            return true;
        }
        var selectedProviders = getSelectedAiSessionProviders(workspaceDiv);
        if (!selectedProviders.includes(provider)) {
            pendingWorkspaceSessionReveal = { navigationIdentity, provider, sessionId };
            submitAiSessionProviderSelection(
                workspaceDiv,
                selectedProviders.concat(provider)
            );
            return true;
        }
        pendingWorkspaceSessionReveal = null;
        focusSearchRevealTarget(workspaceDiv);
        return false;
    }

    window.__agentPivotRevealWorkspaceSession = revealWorkspaceSession;
    window.__agentPivotRevealPendingWorkspaceSession = () => {
        if (!pendingWorkspaceSessionReveal) {
            return false;
        }
        var pending = pendingWorkspaceSessionReveal;
        return revealWorkspaceSession(
            pending.navigationIdentity,
            pending.provider,
            pending.sessionId
        );
    };

    function requestFullRefresh(reason) {
        window.vscode.postMessage({
            type: 'request-full-refresh',
            reason,
        });
    }

    return {
        applyAiSessionsUpdate: applyAiSessionsUpdate,
        acceptProjectionRevision: acceptProjectionRevision,
        canApplyProjectionRevision: canApplyProjectionRevision,
        commitProjectionRevision: commitProjectionRevision,
        findCurrentWorkspaceDiv: findCurrentWorkspaceDiv,
        findWorkspaceDiv: findWorkspaceDiv,
        focusSearchRevealTarget: focusSearchRevealTarget,
        requestFullRefresh: requestFullRefresh,
    };
}
