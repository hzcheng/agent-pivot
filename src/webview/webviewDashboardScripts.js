function initDashboard(options) {
    options = options || {};
    var storageKey = 'agentPivot.activeDashboardTab';
    var scrollPositions = { open: 0, projects: 0, ai: 0 };
    var activeTab = normalizeDashboardTab(sessionStorage.getItem(storageKey));
    var pendingScrollRestoreTab = null;
    var panelRequestTimeoutMs = Number(options.panelRequestTimeoutMs) > 0
        ? Number(options.panelRequestTimeoutMs)
        : 5000;
    var scheduleTimeout = options.setTimeout
        || (typeof setTimeout === 'function' ? setTimeout : null);
    var cancelTimeout = options.clearTimeout
        || (typeof clearTimeout === 'function' ? clearTimeout : function () {});
    var catalog = readInitialDashboardSearchCatalog();
    var searchQuery = String(options.initialSearchQuery || '').trim();
    var tabButtons = Array.from(document.querySelectorAll('[data-dashboard-tab]'));
    var panels = {
        open: document.getElementById('dashboard-tab-open'),
        projects: document.getElementById('dashboard-tab-projects'),
        ai: document.getElementById('dashboard-panel-ai'),
    };
    var tablist = document.querySelector ? document.querySelector('[role="tablist"]') : null;
    var collapseButton = document.querySelector ? document.querySelector('[data-action="toggle-all-groups"]') : null;
    var searchResults = document.getElementById('dashboard-search-results');

    function restoreScroll(tab) {
        requestAnimationFrame(() => {
            window.scrollTo(0, scrollPositions[normalizeDashboardTab(tab)] || 0);
        });
    }

    function renderActiveTab() {
        Object.keys(panels).forEach(tab => {
            if (panels[tab]) {
                panels[tab].hidden = tab !== activeTab;
            }
        });
        tabButtons.forEach(button => {
            var selected = normalizeDashboardTab(button.getAttribute('data-dashboard-tab')) === activeTab;
            button.setAttribute('aria-selected', selected ? 'true' : 'false');
            button.setAttribute('tabindex', selected ? '0' : '-1');
            button.classList.toggle('active', selected);
        });
    }

    function renderSearchMode() {
        var active = searchQuery.length > 0;
        if (tablist) {
            tablist.hidden = active;
        }
        if (collapseButton) {
            collapseButton.hidden = active;
        }
        Object.keys(panels).forEach(tab => {
            if (panels[tab]) {
                panels[tab].hidden = active || tab !== activeTab;
            }
        });
        if (searchResults) {
            searchResults.hidden = !active;
        }
        document.body.classList.toggle('dashboard-search-active', active);
        if (active) {
            renderDashboardSearchResults(searchResults, filterDashboardCatalog(catalog, searchQuery));
        }
    }

    function notifyActiveTabChanged() {
        if (typeof options.onActiveTabChanged === 'function') {
            options.onActiveTabChanged(activeTab);
        }
        if (collapseButton && activeTab === 'ai') {
            collapseButton.disabled = true;
            collapseButton.setAttribute('aria-disabled', 'true');
            collapseButton.setAttribute('title', 'No groups to collapse in AI');
            collapseButton.setAttribute('aria-label', 'No groups to collapse in AI');
        }
    }

    function getPanelLoadingElement(tab) {
        var panel = panels[tab];
        if (!panel || !panel.querySelector) {
            return null;
        }
        return panel.querySelector(tab === 'projects'
            ? '.dashboard-projects-loading'
            : '.dashboard-ai-loading');
    }

    function showPanelLoading(tab) {
        var loadingElement = getPanelLoadingElement(tab);
        if (!loadingElement) {
            return;
        }
        loadingElement.textContent = tab === 'projects'
            ? 'Loading projects…'
            : 'Loading AI configuration…';
        loadingElement.hidden = false;
    }

    function showPanelUnavailable(tab) {
        var loadingElement = getPanelLoadingElement(tab);
        if (!loadingElement) {
            return;
        }
        loadingElement.textContent = (tab === 'projects'
            ? 'Projects'
            : 'AI configuration')
            + ' are temporarily unavailable. Select this tab to retry.';
        loadingElement.hidden = false;
    }








    function activateTab(tab, saveScroll) {
        tab = normalizeDashboardTab(tab);
        saveScroll = saveScroll !== false;
        if (tab !== activeTab) {
            if (saveScroll) {
                scrollPositions[activeTab] = window.scrollY || 0;
            }
            activeTab = tab;
            sessionStorage.setItem(storageKey, activeTab);
        }
        renderActiveTab();
        if (searchQuery) {
            renderSearchMode();
            notifyActiveTabChanged();
            return;
        }
        if (activeTab === 'projects') {
            if (projectsPanel.getProjectsState() === 'mounted') {
                restoreScroll('projects');
            } else {
                pendingScrollRestoreTab = 'projects';
                projectsPanel.ensureProjectsPanel();
            }
        } else if (activeTab === 'ai') {
            if (aiPanel.getAiState() === 'mounted') {
                restoreScroll('ai');
            } else {
                pendingScrollRestoreTab = 'ai';
                aiPanel.ensureAiPanel();
            }
        } else {
            restoreScroll(activeTab);
        }
        notifyActiveTabChanged();
    }

    function setSearchQuery(query) {
        var nextQuery = String(query || '').trim();
        var wasActive = searchQuery.length > 0;
        if (!wasActive && nextQuery) {
            scrollPositions[activeTab] = window.scrollY || 0;
        }
        searchQuery = nextQuery;
        renderSearchMode();
        if (!searchQuery && wasActive) {
            renderActiveTab();
            if (activeTab === 'projects' && projectsPanel.getProjectsState() !== 'mounted') {
                pendingScrollRestoreTab = 'projects';
                projectsPanel.ensureProjectsPanel();
            } else if (activeTab === 'ai' && aiPanel.getAiState() !== 'mounted') {
                pendingScrollRestoreTab = 'ai';
                aiPanel.ensureAiPanel();
            } else {
                restoreScroll(activeTab);
            }
        }
        notifyActiveTabChanged();
    }

    function replaceSearchCatalog(nextCatalog) {
        var state = replaceDashboardSearchCatalogState({
            activeTab,
            searchQuery,
            scrollPositions,
            catalog,
        }, nextCatalog);
        catalog = state.catalog;
        if (searchQuery) {
            renderDashboardSearchResults(searchResults, filterDashboardCatalog(catalog, searchQuery));
        }
    }

    var pendingSkillReveal = null;

    function onSearchResultClick(event) {
        var button = event.target && event.target.closest
            ? event.target.closest('.dashboard-search-result[data-search-action]')
            : null;
        if (!button) {
            return;
        }
        var action = button.dataset.searchAction;
        if (action === 'resume-session') {
            var provider = button.dataset.provider;
            if (provider !== 'codex' && provider !== 'kimi' && provider !== 'claude') {
                return;
            }
            if (typeof window.__agentPivotAcknowledgeSession === 'function') {
                window.__agentPivotAcknowledgeSession(provider, button.dataset.sessionId);
            }
            options.postMessage({
                type: 'resume-' + provider + '-session',
                provider,
                projectId: button.dataset.projectId,
                sessionId: button.dataset.sessionId,
            });
            return;
        }
        if (action === 'reveal-skill') {
            if (typeof options.clearSearch === 'function') {
                options.clearSearch();
            } else {
                setSearchQuery('');
            }
            pendingSkillReveal = String(button.dataset.skillDir || '');
            activateTab('ai', false);
            if (aiPanel.getAiState() === 'mounted') {
                var revealDir = pendingSkillReveal;
                pendingSkillReveal = null;
                skillPanel.revealSkillCard(revealDir);
            }
            return;
        }
        if (action === 'reveal-workspace-session') {
            if (typeof options.clearSearch === 'function') {
                options.clearSearch();
            } else {
                setSearchQuery('');
            }
            activateTab('open', false);
            if (typeof window.__agentPivotRevealWorkspaceSession === 'function') {
                window.__agentPivotRevealWorkspaceSession(
                    button.dataset.workspaceNavigationIdentity,
                    button.dataset.provider,
                    button.dataset.sessionId
                );
            }
            return;
        }
        if (action === 'reveal-workspace-worktree') {
            if (typeof options.clearSearch === 'function') {
                options.clearSearch();
            } else {
                setSearchQuery('');
            }
            activateTab('open', false);
            if (typeof window.__agentPivotRevealWorkspaceWorktree === 'function') {
                window.__agentPivotRevealWorkspaceWorktree(
                    button.dataset.workspaceNavigationIdentity,
                    button.dataset.repositoryKey,
                    button.dataset.worktreePath
                );
            } else if (typeof window.__agentPivotRevealWorkspace === 'function') {
                window.__agentPivotRevealWorkspace(button.dataset.workspaceNavigationIdentity);
            }
            return;
        }
        if (action === 'show-current-workspace') {
            if (typeof options.clearSearch === 'function') {
                options.clearSearch();
            } else {
                setSearchQuery('');
            }
            activateTab('open', false);
            if (typeof window.__agentPivotRevealWorkspace === 'function') {
                window.__agentPivotRevealWorkspace(button.dataset.workspaceNavigationIdentity);
            }
            return;
        }
        if (action === 'switch-open-workspace') {
            options.postMessage({
                type: 'selected-workspace',
                workspaceId: button.dataset.workspaceId,
                navigationIdentity: button.dataset.workspaceNavigationIdentity,
            });
            return;
        }
        if (action === 'open-saved-project') {
            options.postMessage({
                type: 'selected-project',
                projectId: button.dataset.projectId,
                projectOpenType: 0,
            });
            return;
        }
    }

    var skillPanel = initSkillPanel({
        postMessage: options.postMessage,
        aiPanel: panels.ai,
    });
    var projectsPanel = createDashboardProjectsPanel({
        options: options,
        panels: panels,
        scheduleTimeout: scheduleTimeout,
        cancelTimeout: cancelTimeout,
        panelRequestTimeoutMs: panelRequestTimeoutMs,
        showPanelLoading: showPanelLoading,
        showPanelUnavailable: showPanelUnavailable,
        restoreScroll: restoreScroll,
        replaceSearchCatalog: replaceSearchCatalog,
        getActiveTab: () => activeTab,
        getSearchQuery: () => searchQuery,
        getPendingScrollRestoreTab: () => pendingScrollRestoreTab,
        setPendingScrollRestoreTab: value => { pendingScrollRestoreTab = value; },
    });
    var aiPanel = createDashboardAiPanel({
        options: options,
        panels: panels,
        scheduleTimeout: scheduleTimeout,
        cancelTimeout: cancelTimeout,
        panelRequestTimeoutMs: panelRequestTimeoutMs,
        showPanelLoading: showPanelLoading,
        showPanelUnavailable: showPanelUnavailable,
        restoreScroll: restoreScroll,
        replaceSearchCatalog: replaceSearchCatalog,
        getActiveTab: () => activeTab,
        getSearchQuery: () => searchQuery,
        getPendingScrollRestoreTab: () => pendingScrollRestoreTab,
        setPendingScrollRestoreTab: value => { pendingScrollRestoreTab = value; },
        skillPanel: skillPanel,
        getPendingSkillReveal: () => pendingSkillReveal,
        setPendingSkillReveal: value => { pendingSkillReveal = value; },
    });













    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            activateTab(button.getAttribute('data-dashboard-tab'));
        });
        button.addEventListener('keydown', event => {
            var tab = normalizeDashboardTab(button.getAttribute('data-dashboard-tab'));
            if (event.key === 'ArrowLeft'
                || event.key === 'ArrowRight'
                || event.key === 'Home'
                || event.key === 'End') {
                event.preventDefault();
                var adjacentTab = getAdjacentDashboardTab(tab, event.key);
                var adjacentButton = tabButtons.find(candidate =>
                    normalizeDashboardTab(candidate.getAttribute('data-dashboard-tab')) === adjacentTab
                );
                if (adjacentButton) {
                    adjacentButton.focus();
                }
                return;
            }
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                activateTab(tab);
            }
        });
    });

    window.addEventListener('message', event => {
        if (event && event.data && event.data.type === 'projects-panel-content') {
            projectsPanel.applyProjectsPanelMessage(event.data);
        }
        if (event && event.data && event.data.type === 'projects-panel-updated') {
            if (validateProjectsPanelUpdatedMessage(event.data)
                && event.data.sequence <= projectsPanel.getAcceptedProjectsUpdateSequence()) {
                return;
            }
            if (!projectsPanel.applyProjectsPanelUpdatedMessage(event.data)) {
                options.postMessage({
                    type: 'request-full-refresh',
                    reason: 'invalid-projects-panel-update',
                });
            }
        }
        if (event && event.data && event.data.type === 'ai-panel-content') {
            aiPanel.applyAiPanelMessage(event.data);
        }
        if (event && event.data && event.data.type === 'prompt-panel-updated') {
            aiPanel.applyPromptPanelUpdatedMessage(event.data);
        }
        if (event && event.data && event.data.type === 'skills-updated') {
            skillPanel.replaceSkillsHtml(event.data.html, event.data.settlement);
        }
        if (event && event.data && event.data.type === 'skill-scope-action-result') {
            skillPanel.settleSkillScopeActionWithoutHtml(event.data);
        }
        if (event && event.data
            && event.data.type === 'select-dashboard-tab'
            && event.data.version === 1
            && event.data.tab === 'ai'
            && event.data.aiSubtab === 'prompts') {
            if (searchQuery && typeof options.clearSearch === 'function') {
                options.clearSearch();
            }
            if (searchQuery) {
                setSearchQuery('');
            }
            aiPanel.setPendingAiSubtab('prompts');
            activateTab('ai');
            aiPanel.applyPendingAiSubtab();
        }
        if (event && event.data
            && event.data.type === 'reveal-workspace-worktree-requested'
            && event.data.version === 1
            && Object.keys(event.data).length === 5
            && typeof event.data.navigationIdentity === 'string'
            && event.data.navigationIdentity
            && typeof event.data.repositoryKey === 'string'
            && event.data.repositoryKey
            && typeof event.data.canonicalWorktreePath === 'string'
            && event.data.canonicalWorktreePath) {
            if (searchQuery && typeof options.clearSearch === 'function') {
                options.clearSearch();
            }
            if (searchQuery) {
                setSearchQuery('');
            }
            activateTab('open', false);
            if (typeof window.__agentPivotRevealWorkspaceWorktree === 'function') {
                window.__agentPivotRevealWorkspaceWorktree(
                    event.data.navigationIdentity,
                    event.data.repositoryKey,
                    event.data.canonicalWorktreePath
                );
            }
        }
    });
    if (searchResults) {
        searchResults.addEventListener('click', onSearchResultClick);
    }
    renderActiveTab();
    if (searchQuery) {
        renderSearchMode();
    } else if (activeTab === 'projects') {
        pendingScrollRestoreTab = 'projects';
        projectsPanel.ensureProjectsPanel();
    } else if (activeTab === 'ai') {
        pendingScrollRestoreTab = 'ai';
        aiPanel.ensureAiPanel();
    }
    document.body.classList.remove('preload');
    notifyActiveTabChanged();

    return {
        activateTab,
        applyProjectsPanelMessage: projectsPanel.applyProjectsPanelMessage,
        applyProjectsPanelUpdatedMessage: projectsPanel.applyProjectsPanelUpdatedMessage,
        applyAiPanelMessage: aiPanel.applyAiPanelMessage,
        applyPromptPanelUpdatedMessage: aiPanel.applyPromptPanelUpdatedMessage,
        ensureProjectsPanel: projectsPanel.ensureProjectsPanel,
        ensureAiPanel: aiPanel.ensureAiPanel,
        getActiveTab: () => activeTab,
        getProjectsState: projectsPanel.getProjectsState,
        getAiState: aiPanel.getAiState,
        getScrollPosition: tab => scrollPositions[normalizeDashboardTab(tab)],
        isSearchActive: () => searchQuery.length > 0,
        replaceSearchCatalog,
        setSearchQuery,
    };
}
