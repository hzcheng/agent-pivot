function initAiSessionPresentationTransactions(options) {
    'use strict';

    options = options || {};
    var isValidAiSessionPresentationState = options.isValidAiSessionPresentationState;
    var applyValidatedAiSessionPresentationState = options.applyValidatedAiSessionPresentationState;
    var latestAiSessionProjectionRevision = 0;
    var latestAiSessionPresentationProjectionRevision = 0;
    var latestAiSessionClosedPresentationRevision = 0;

    function requestFullRefresh(reason) {
        window.vscode.postMessage({
            type: 'request-full-refresh',
            reason,
        });
    }

    function canApplyRevision(revision, latestRevision) {
        if (typeof revision === 'undefined') {
            return latestRevision === 0;
        }
        return Number.isSafeInteger(revision)
            && revision > 0
            && revision > latestRevision;
    }

    function canApplyProjectionRevision(revision) {
        return canApplyRevision(revision, latestAiSessionProjectionRevision);
    }

    function canApplyAtomicPresentationProjectionRevision(revision) {
        return Number.isSafeInteger(revision)
            && revision > 0
            && revision >= latestAiSessionPresentationProjectionRevision
            && revision > latestAiSessionClosedPresentationRevision;
    }

    function commitAtomicProjectionRevision(revision) {
        latestAiSessionProjectionRevision = revision;
        latestAiSessionPresentationProjectionRevision = Math.max(
            latestAiSessionPresentationProjectionRevision,
            revision
        );
        latestAiSessionClosedPresentationRevision = Math.max(
            latestAiSessionClosedPresentationRevision,
            revision
        );
    }

    function acceptPresentationProjectionRevision(revision) {
        if (!Number.isSafeInteger(revision)
            || revision <= 0
            || revision < latestAiSessionProjectionRevision
            || revision <= latestAiSessionPresentationProjectionRevision
            || revision <= latestAiSessionClosedPresentationRevision) {
            return false;
        }
        latestAiSessionPresentationProjectionRevision = revision;
        return true;
    }

    function acceptInitialPresentationProjectionRevision(revision) {
        if (!Number.isSafeInteger(revision)
            || revision <= 0
            || latestAiSessionProjectionRevision !== 0
            || latestAiSessionPresentationProjectionRevision !== 0
            || latestAiSessionClosedPresentationRevision !== 0) {
            return false;
        }
        latestAiSessionProjectionRevision = revision;
        latestAiSessionPresentationProjectionRevision = revision;
        latestAiSessionClosedPresentationRevision = revision;
        return true;
    }

    function applyInitialPresentation(message) {
        if (!isValidAiSessionPresentationState(message)) {
            requestFullRefresh('invalid-initial-ai-session-presentation-state');
            return false;
        }
        if (!acceptInitialPresentationProjectionRevision(message.projectionRevision)) {
            return false;
        }
        applyValidatedAiSessionPresentationState(message);
        return true;
    }

    function applyDirectPresentation(message) {
        if (!isValidAiSessionPresentationState(message)
            || message.revealFocused !== true) {
            requestFullRefresh('invalid-direct-ai-session-presentation-state');
            return false;
        }
        if (!acceptPresentationProjectionRevision(message.projectionRevision)) {
            return false;
        }
        applyValidatedAiSessionPresentationState(message);
        return true;
    }

    function applyAtomicEnvelope(input) {
        var message = input.message;
        if (!Number.isSafeInteger(message.projectionRevision)
            || message.projectionRevision <= 0
            || !isValidAiSessionPresentationState(message.presentation)
            || message.presentation.projectionRevision !== message.projectionRevision
            || message.presentation.revealFocused !== false) {
            requestFullRefresh(input.invalidPresentationReason);
            return false;
        }
        if (!canApplyProjectionRevision(message.projectionRevision)
            || !canApplyAtomicPresentationProjectionRevision(message.projectionRevision)) {
            return false;
        }
        if (!input.replaceContent()) {
            requestFullRefresh(input.invalidReplacementReason);
            return false;
        }
        commitAtomicProjectionRevision(message.projectionRevision);
        if (typeof input.afterReplacement === 'function') {
            input.afterReplacement();
        }
        applyValidatedAiSessionPresentationState(message.presentation);
        return true;
    }

    return {
        applyAtomicEnvelope: applyAtomicEnvelope,
        applyDirectPresentation: applyDirectPresentation,
        applyInitialPresentation: applyInitialPresentation,
        requestFullRefresh: requestFullRefresh,
    };
}

function initProjectAiSessionsUpdate(options) {
    'use strict';

    options = options || {};
    var batchAiSessionState = options.batchAiSessionState;
    var batchAiSessionManager = options.batchAiSessionManager;
    var getPendingAiSessionProviderSelectionProjectId = options.getPendingAiSessionProviderSelectionProjectId;
    var getSelectedAiSessionProviders = options.getSelectedAiSessionProviders;
    var syncAiSessionBatchManagementDom = options.syncAiSessionBatchManagementDom;
    var reconcilePendingAiSessionProviderSelectionDom = options.reconcilePendingAiSessionProviderSelectionDom;
    var submitAiSessionProviderSelection = options.submitAiSessionProviderSelection;
    var toggleCodexSessions = options.toggleCodexSessions;
    var exitAiSessionBatchManagement = options.exitAiSessionBatchManagement;
    var isAiSessionProvider = options.isAiSessionProvider;
    var updateStickyGroupHeaderOffset = options.updateStickyGroupHeaderOffset;
    var presentationTransactions = options.presentationTransactions;

    var pendingWorkspaceSessionReveal = null;

    function applyAiSessionsUpdate(message) {
        if (message.version !== 3
            || typeof message.sequence !== 'number'
            || (message.currentWorkspaceCount !== 0 && message.currentWorkspaceCount !== 1)
            || typeof message.html !== 'string'
            || typeof normalizeDashboardSearchCatalog !== 'function'
            || normalizeDashboardSearchCatalog(message.searchCatalog) !== message.searchCatalog
            || message.searchCatalog.version !== 2) {
            presentationTransactions.requestFullRefresh('unsupported-ai-session-message');
            return;
        }

        if (!Number.isSafeInteger(message.projectionRevision)
                || message.projectionRevision <= 0
                || message.sequence !== message.projectionRevision
                || typeof message.generatedAt !== 'string'
                || !message.generatedAt) {
            presentationTransactions.requestFullRefresh(
                'invalid-ai-session-presentation-envelope'
            );
            return;
        }

        if (!presentationTransactions.applyAtomicEnvelope({
            message: message,
            invalidPresentationReason: 'invalid-ai-session-presentation-envelope',
            invalidReplacementReason: 'invalid-ai-session-workspace-update',
            replaceContent: () => applyWorkspaceUpdate({
                type: 'workspace-updated',
                version: 2,
                currentWorkspaceCount: message.currentWorkspaceCount,
                html: message.html,
            }, {
                canRestoreAiSessionProviderMenu: () =>
                    !getPendingAiSessionProviderSelectionProjectId()
                    && !batchAiSessionState.pending,
            }),
            afterReplacement: () => {
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
            },
        })) {
            return;
        }
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

    return {
        applyAiSessionsUpdate: applyAiSessionsUpdate,
        findCurrentWorkspaceDiv: findCurrentWorkspaceDiv,
        findWorkspaceDiv: findWorkspaceDiv,
        focusSearchRevealTarget: focusSearchRevealTarget,
        requestFullRefresh: presentationTransactions.requestFullRefresh,
    };
}
