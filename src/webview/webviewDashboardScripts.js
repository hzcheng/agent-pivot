function readDashboardSessionValue(key) {
    try {
        return window.sessionStorage ? window.sessionStorage.getItem(key) : null;
    } catch (_error) {
        return null;
    }
}

function writeDashboardSessionValue(key, value) {
    try {
        if (window.sessionStorage) {
            window.sessionStorage.setItem(key, value);
        }
    } catch (_error) {
        // Some sandboxed Webviews deny sessionStorage. Dashboard state remains local.
    }
}

function renderLocalFileTransferEntries(fileList, entries) {
    fileList.textContent = '';
    entries.forEach(function (entry) {
        var row = document.createElement('li');
        row.className = 'file-transfer-file-row';
        row.setAttribute('data-file-transfer-entry-id', entry.id);
        var kind = entry.kind === 'directory' ? 'Folder' : entry.kind === 'file' ? 'File' : entry.kind;
        row.textContent = kind + '  ' + entry.name;
        fileList.appendChild(row);
    });
}

function validateFileTransferLocalRootMessage(message) {
    if (!message || typeof message !== 'object'
        || message.version !== 1
        || typeof message.requestId !== 'string'
        || !/^[A-Za-z0-9._:-]{16,256}$/.test(message.requestId)
        || (message.side !== 'left' && message.side !== 'right')) {
        return false;
    }
    if (message.type === 'file-transfer-local-root-selected' && message.root) {
        return Object.keys(message).sort().join('\n') === [
            'requestId', 'root', 'side', 'type', 'version',
        ].join('\n') && validateFileTransferLocalRoot(message.root);
    }
    if (message.type === 'file-transfer-local-root-failed') {
        return Object.keys(message).sort().join('\n') === [
            'message', 'requestId', 'side', 'type', 'version',
        ].join('\n')
            && typeof message.message === 'string'
            && message.message.length > 0
            && message.message.length <= 320;
    }
    return Object.keys(message).sort().join('\n') === [
        'cancelled', 'requestId', 'side', 'type', 'version',
    ].join('\n') && message.type === 'file-transfer-local-root-selected'
        && message.cancelled === true;
}

function validateFileTransferLocalRoot(root) {
    return !!root && typeof root === 'object'
        && Object.keys(root).sort().join('\n') === [
            'directoryId', 'entries', 'label', 'rootId',
        ].join('\n')
        && /^[a-f0-9]{32}$/.test(root.rootId)
        && /^[a-f0-9]{32}$/.test(root.directoryId)
        && typeof root.label === 'string'
        && root.label.length > 0
        && root.label.length <= 255
        && Array.isArray(root.entries)
        && root.entries.length <= 1000
        && root.entries.every(validateFileTransferDirectoryEntry);
}

function validateFileTransferDirectoryEntry(entry) {
    return !!entry && typeof entry === 'object'
        && Object.keys(entry).every(function (key) {
            return ['id', 'name', 'kind', 'size', 'modifiedAt'].includes(key);
        })
        && ['id', 'name', 'kind'].every(function (key) {
            return Object.prototype.hasOwnProperty.call(entry, key);
        })
        && /^[a-f0-9]{32}$/.test(entry.id)
        && typeof entry.name === 'string'
        && entry.name.length > 0
        && entry.name.length <= 255
        && ['directory', 'file', 'symlink', 'unsupported'].includes(entry.kind)
        && (entry.size === undefined || (Number.isSafeInteger(entry.size) && entry.size >= 0))
        && (entry.modifiedAt === undefined
            || (Number.isSafeInteger(entry.modifiedAt) && entry.modifiedAt >= 0));
}

function initDashboard(options) {
    options = options || {};
    var storageKey = 'agentPivot.activeDashboardTab';
    var scrollPositions = { open: 0, projects: 0, ai: 0, 'file-transfer': 0 };
    var activeTab = normalizeDashboardTab(readDashboardSessionValue(storageKey));
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
        'file-transfer': document.getElementById('dashboard-tab-file-transfer'),
    };
    var tablist = document.querySelector ? document.querySelector('[role="tablist"]') : null;
    var collapseButton = document.querySelector ? document.querySelector('[data-action="toggle-all-groups"]') : null;
    var searchResults = document.getElementById('dashboard-search-results');

    function getTabScrollPort(tab) {
        return panels[normalizeDashboardTab(tab)] || null;
    }

    function readTabScrollPosition(tab) {
        var scrollPort = getTabScrollPort(tab);
        return scrollPort && typeof scrollPort.scrollTop === 'number'
            ? scrollPort.scrollTop
            : 0;
    }

    function restoreScroll(tab) {
        requestAnimationFrame(() => {
            var scrollPort = getTabScrollPort(tab);
            if (scrollPort) {
                scrollPort.scrollTop = scrollPositions[normalizeDashboardTab(tab)] || 0;
            }
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
        if (collapseButton && (activeTab === 'ai' || activeTab === 'file-transfer')) {
            collapseButton.disabled = true;
            collapseButton.setAttribute('aria-disabled', 'true');
            const unavailableMessage = activeTab === 'ai'
                ? 'No groups to collapse in AI'
                : 'No groups to collapse in File Transfer';
            collapseButton.setAttribute('title', unavailableMessage);
            collapseButton.setAttribute('aria-label', unavailableMessage);
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
        var tabChanged = tab !== activeTab;
        if (tabChanged) {
            if (saveScroll) {
                scrollPositions[activeTab] = readTabScrollPosition(activeTab);
            }
            activeTab = tab;
            writeDashboardSessionValue(storageKey, activeTab);
        }
        renderActiveTab();
        if (searchQuery) {
            renderSearchMode();
            notifyActiveTabChanged();
            return;
        }
        if (activeTab === 'projects') {
            if (projectsPanel.getProjectsState() === 'mounted') {
                if (tabChanged) {
                    restoreScroll('projects');
                }
            } else {
                pendingScrollRestoreTab = 'projects';
                projectsPanel.ensureProjectsPanel();
            }
        } else if (activeTab === 'ai') {
            if (aiPanel.getAiState() === 'mounted') {
                if (tabChanged) {
                    restoreScroll('ai');
                }
            } else {
                pendingScrollRestoreTab = 'ai';
                aiPanel.ensureAiPanel();
            }
        } else if (tabChanged) {
            restoreScroll(activeTab);
        }
        notifyActiveTabChanged();
    }

    function setSearchQuery(query) {
        var nextQuery = String(query || '').trim();
        var wasActive = searchQuery.length > 0;
        if (!wasActive && nextQuery) {
            scrollPositions[activeTab] = readTabScrollPosition(activeTab);
        }
        var queryChanged = nextQuery !== searchQuery;
        searchQuery = nextQuery;
        renderSearchMode();
        if (queryChanged && searchQuery && searchResults) {
            searchResults.scrollTop = 0;
        }
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
        if (action === 'open-managed-project') {
            options.postMessage({
                type: 'managed-remote-client-action',
                version: 1,
                requestId: 'managed-search-' + Date.now(),
                action: 'openProject',
                expectedRevisionId: button.dataset.expectedRevisionId || null,
                targetId: button.dataset.projectId,
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

    function initializeFileTransferPanel() {
        var panel = panels['file-transfer'];
        if (!panel || !panel.querySelectorAll) {
            return;
        }
        var selectors = Array.from(panel.querySelectorAll('[data-file-transfer-endpoint]'));
        var panes = {
            left: panel.querySelector('[data-file-transfer-pane="left"]'),
            right: panel.querySelector('[data-file-transfer-pane="right"]'),
        };
        var hint = panel.querySelector('[data-file-transfer-pair-hint]');
        var summary = panel.querySelector('[data-file-transfer-summary]');
        var review = panel.querySelector('[data-file-transfer-review]');
        var localRoots = { left: null, right: null };
        var pendingLocalRootRequests = { left: null, right: null };

        function selectorFor(side) {
            return selectors.find(function (selector) {
                return selector.getAttribute('data-file-transfer-endpoint') === side;
            }) || null;
        }

        function updatePane(side, selector) {
            var pane = panes[side];
            if (!pane || !selector) {
                return;
            }
            var name = pane.querySelector('[data-file-transfer-pane-name]');
            var path = pane.querySelector('[data-file-transfer-pane-path]');
            var status = pane.querySelector('[data-file-transfer-pane-status]');
            var refresh = pane.querySelector('[data-file-transfer-refresh]');
            var fileList = pane.querySelector('[data-file-transfer-file-list]');
            var option = selector.options && selector.selectedIndex >= 0
                ? selector.options[selector.selectedIndex] : null;
            var value = selector.value || '';
            if (!value) {
                if (name) name.textContent = 'Choose an endpoint';
                if (path) path.textContent = '—';
                if (status) status.textContent = 'Choose an endpoint to browse its files.';
                if (refresh) refresh.disabled = true;
                if (fileList) {
                    fileList.textContent = '';
                    fileList.hidden = true;
                }
                return;
            }
            if (name) name.textContent = option ? option.textContent : 'Selected endpoint';
            var localRoot = value === 'local' ? localRoots[side] : null;
            if (path) path.textContent = localRoot ? localRoot.label
                : value === 'local' ? 'Choose a local folder' : 'Managed Machine';
            if (status) {
                status.textContent = localRoot
                    ? localRoot.entries.length + ' items in this approved local folder.'
                    : value === 'local' && pendingLocalRootRequests[side]
                        ? 'Opening the local folder chooser…'
                    : value === 'local'
                        ? 'Choose a local folder to begin browsing.'
                    : 'Managed Machine selected. File browsing will be enabled by the local UI Bridge.';
            }
            if (fileList) {
                renderLocalFileTransferEntries(fileList, localRoot ? localRoot.entries : []);
                fileList.hidden = !localRoot;
            }
            if (refresh) refresh.disabled = !localRoot;
        }

        function updatePair() {
            var left = selectorFor('left');
            var right = selectorFor('right');
            if (left && right && left.value && left.value === right.value) {
                right.value = '';
                if (hint) hint.textContent = 'Choose two different endpoints.';
            } else if (left && right && left.value && right.value) {
                if (hint) hint.textContent = 'Endpoints are paired. Select files in either pane to choose a copy direction.';
            } else if (hint) {
                hint.textContent = 'Select two endpoints. They are equal until you select files to copy.';
            }
            updatePane('left', left);
            updatePane('right', right);
            if (summary) summary.textContent = 'Select files in either pane to choose a copy direction.';
            if (review) review.disabled = true;
        }

        function requestLocalRoot(side) {
            var requestId = 'file-transfer-' + side + '-' + Date.now() + '-'
                + Math.random().toString(16).slice(2, 18);
            pendingLocalRootRequests[side] = requestId;
            options.postMessage({
                type: 'file-transfer-select-local-root',
                version: 1,
                requestId: requestId,
                side: side,
            });
        }

        function onEndpointChange(event) {
            var selector = event.currentTarget;
            var side = selector && selector.getAttribute
                ? selector.getAttribute('data-file-transfer-endpoint') : null;
            if (side !== 'left' && side !== 'right') {
                return;
            }
            localRoots[side] = null;
            pendingLocalRootRequests[side] = null;
            if (selector.value === 'local') {
                requestLocalRoot(side);
            }
            updatePair();
        }

        function applyLocalRootMessage(message) {
            if (!message || (message.side !== 'left' && message.side !== 'right')
                || pendingLocalRootRequests[message.side] !== message.requestId) {
                return false;
            }
            pendingLocalRootRequests[message.side] = null;
            if (message.type === 'file-transfer-local-root-selected' && message.root) {
                localRoots[message.side] = message.root;
            } else {
                var selector = selectorFor(message.side);
                if (selector) selector.value = '';
                localRoots[message.side] = null;
            }
            updatePair();
            return true;
        }

        selectors.forEach(function (selector) {
            selector.addEventListener('change', onEndpointChange);
        });
        updatePair();

        return { applyLocalRootMessage: applyLocalRootMessage };
    }
    var fileTransferPanel = initializeFileTransferPanel();













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
        if (event && event.data && validateFileTransferLocalRootMessage(event.data)
            && fileTransferPanel) {
            fileTransferPanel.applyLocalRootMessage(event.data);
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
        applyFileTransferLocalRootMessage: fileTransferPanel
            ? fileTransferPanel.applyLocalRootMessage : function () { return false; },
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
