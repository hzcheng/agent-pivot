function createDashboardProjectsPanel(injected) {
    injected = injected || {};
    var options = injected.options;
    var panels = injected.panels;
    var scheduleTimeout = injected.scheduleTimeout;
    var cancelTimeout = injected.cancelTimeout;
    var panelRequestTimeoutMs = injected.panelRequestTimeoutMs;
    var showPanelLoading = injected.showPanelLoading;
    var showPanelUnavailable = injected.showPanelUnavailable;
    var restoreScroll = injected.restoreScroll;
    var replaceSearchCatalog = injected.replaceSearchCatalog;
    var getActiveTab = injected.getActiveTab;
    var getSearchQuery = injected.getSearchQuery;
    var getPendingScrollRestoreTab = injected.getPendingScrollRestoreTab;
    var setPendingScrollRestoreTab = injected.setPendingScrollRestoreTab;

    var projectsState = 'unloaded';
    var projectsRequestId = 0;
    var acceptedProjectsRequestId = 0;
    var acceptedProjectsUpdateSequence = 0;
    var projectsPanelReplacementGeneration = 0;
    var projectsRequestAttempts = 0;
    var projectsRequestTimer = null;

    function scheduleProjectsRequestTimeout(requestId) {
        if (!scheduleTimeout) {
            return;
        }
        if (projectsRequestTimer !== null) {
            cancelTimeout(projectsRequestTimer);
        }
        projectsRequestTimer = scheduleTimeout(function () {
            projectsRequestTimer = null;
            if (projectsState !== 'loading' || requestId !== projectsRequestId) {
                return;
            }
            projectsState = 'unloaded';
            if (projectsRequestAttempts < 2 && getActiveTab() === 'projects' && !getSearchQuery()) {
                ensureProjectsPanel();
                return;
            }
            showPanelUnavailable('projects');
        }, panelRequestTimeoutMs);
    }

    function ensureProjectsPanel() {
        if (projectsState !== 'unloaded') {
            return;
        }
        projectsState = 'loading';
        projectsRequestAttempts += 1;
        projectsRequestId += 1;
        showPanelLoading('projects');
        options.postMessage({
            type: 'request-projects-panel',
            version: 1,
            requestId: projectsRequestId,
        });
        scheduleProjectsRequestTimeout(projectsRequestId);
    }

    function applyProjectsPanelMessage(message) {
        if (!validateProjectsPanelMessage(message)
            || projectsState !== 'loading'
            || message.requestId !== projectsRequestId
            || message.requestId <= acceptedProjectsRequestId
            || !panels.projects) {
            return false;
        }

        acceptedProjectsRequestId = message.requestId;
        if (message.searchCatalog) {
            replaceSearchCatalog(message.searchCatalog);
        }
        if (projectsRequestTimer !== null) {
            cancelTimeout(projectsRequestTimer);
            projectsRequestTimer = null;
        }
        projectsRequestAttempts = 0;
        panels.projects.innerHTML = message.html;
        projectsState = 'mounted';
        if (typeof options.onProjectsMounted === 'function') {
            options.onProjectsMounted(panels.projects);
        }
        if (getPendingScrollRestoreTab() === 'projects') {
            setPendingScrollRestoreTab(null);
            if (getActiveTab() === 'projects' && !getSearchQuery()) {
                restoreScroll('projects');
            }
        }
        return true;
    }

    function replaceProjectsPanelHtml(html) {
        var panelState = captureProjectsPanelState(panels.projects);
        var replacementGeneration = ++projectsPanelReplacementGeneration;
        panels.projects.innerHTML = html;
        projectsState = 'mounted';
        if (typeof options.onProjectsMounted === 'function') {
            options.onProjectsMounted(panels.projects);
        }
        restoreProjectsPanelAnchors(panels.projects, panelState);
        restoreProjectsFocus(panels.projects, panelState.focus);
        if (panelState.inlineEdit && window.__agentPivotProjectInlineEdit) {
            window.__agentPivotProjectInlineEdit.restoreState(panelState.inlineEdit);
        }
        if (window.__agentPivotProjectInlineEdit
            && typeof window.__agentPivotProjectInlineEdit.onAuthoritativeReplacement === 'function') {
            window.__agentPivotProjectInlineEdit.onAuthoritativeReplacement();
        }
        restoreProjectsWindowScroll(panelState);
        requestAnimationFrame(() => {
            if (replacementGeneration !== projectsPanelReplacementGeneration) {
                return;
            }
            restoreProjectsPanelAnchors(panels.projects, panelState);
            restoreProjectsWindowScroll(panelState);
        });
    }

    function applyProjectsPanelUpdatedMessage(message) {
        if (!validateProjectsPanelUpdatedMessage(message)
            || message.sequence <= acceptedProjectsUpdateSequence
            || !panels.projects) {
            return false;
        }
        acceptedProjectsUpdateSequence = message.sequence;
        replaceSearchCatalog(message.searchCatalog);
        if (projectsState !== 'mounted') {
            return true;
        }
        if (message.mode === 'preserve-order' && isProjectsPanelOrderConsistent(panels.projects, message)) {
            projectsPanelReplacementGeneration += 1;
            return true;
        }
        replaceProjectsPanelHtml(message.html);
        return true;
    }

    return {
        ensureProjectsPanel: ensureProjectsPanel,
        applyProjectsPanelMessage: applyProjectsPanelMessage,
        applyProjectsPanelUpdatedMessage: applyProjectsPanelUpdatedMessage,
        getAcceptedProjectsUpdateSequence: () => acceptedProjectsUpdateSequence,
        getProjectsState: () => projectsState,
    };
}
