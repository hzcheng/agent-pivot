function normalizeDashboardTab(tab) {
    return tab === 'projects' || tab === 'todo' || tab === 'ai' ? tab : 'open';
}

function getAdjacentDashboardTab(tab, key) {
    tab = normalizeDashboardTab(tab);
    var tabs = ['open', 'projects', 'todo', 'ai'];
    var currentIndex = tabs.indexOf(tab);
    if (key === 'Home') {
        return tabs[0];
    }
    if (key === 'End') {
        return tabs[tabs.length - 1];
    }
    if (key === 'ArrowRight') {
        return tabs[(currentIndex + 1) % tabs.length];
    }
    if (key === 'ArrowLeft') {
        return tabs[(currentIndex + tabs.length - 1) % tabs.length];
    }
    return tab;
}

function validateProjectsPanelMessage(message) {
    return !!message
        && message.type === 'projects-panel-content'
        && message.version === 1
        && Number.isSafeInteger(message.requestId)
        && message.requestId > 0
        && typeof message.html === 'string';
}

function validateProjectsPanelUpdatedMessage(message) {
    if (!message
        || message.type !== 'projects-panel-updated'
        || message.version !== 1
        || !Number.isSafeInteger(message.sequence)
        || message.sequence < 1
        || (message.mode !== 'replace' && message.mode !== 'preserve-order')
        || typeof message.html !== 'string'
        || normalizeDashboardSearchCatalog(message.searchCatalog) !== message.searchCatalog
        || !Array.isArray(message.groupOrders)
        || !Array.isArray(message.favoriteProjectIds)) {
        return false;
    }
    var groupIds = new Set();
    var savedProjectIds = new Set();
    for (var group of message.groupOrders) {
        if (!group
            || typeof group.groupId !== 'string'
            || !group.groupId
            || groupIds.has(group.groupId)
            || !Array.isArray(group.projectIds)) {
            return false;
        }
        groupIds.add(group.groupId);
        for (var projectId of group.projectIds) {
            if (typeof projectId !== 'string'
                || !projectId
                || savedProjectIds.has(projectId)) {
                return false;
            }
            savedProjectIds.add(projectId);
        }
    }
    var favoriteIds = new Set();
    for (var favoriteId of message.favoriteProjectIds) {
        if (typeof favoriteId !== 'string'
            || !favoriteId
            || favoriteIds.has(favoriteId)) {
            return false;
        }
        favoriteIds.add(favoriteId);
    }
    return true;
}

function validateTodoPanelMessage(message) {
    return !!message
        && message.type === 'todo-panel-content'
        && message.version === 1
        && Number.isSafeInteger(message.requestId)
        && message.requestId > 0
        && typeof message.html === 'string';
}

function validateTodoPanelUpdatedMessage(message) {
    return !!message
        && message.type === 'todo-panel-updated'
        && message.version === 1
        && typeof message.html === 'string'
        && normalizeDashboardSearchCatalog(message.searchCatalog) === message.searchCatalog;
}

function hasExactObjectKeys(value, requiredKeys, optionalKeys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    var allowedKeys = requiredKeys.concat(optionalKeys || []);
    var keys = Object.keys(value);
    return requiredKeys.every(key => Object.prototype.hasOwnProperty.call(value, key))
        && keys.every(key => allowedKeys.indexOf(key) >= 0);
}

function validatePromptPanelSnapshot(snapshot) {
    if (!hasExactObjectKeys(
        snapshot,
        ['version', 'revision', 'selectedPromptId', 'prompts'],
        ['readOnlyReason']
    )
        || snapshot.version !== 1
        || !Number.isSafeInteger(snapshot.revision)
        || snapshot.revision < 0
        || (snapshot.selectedPromptId !== null
            && (typeof snapshot.selectedPromptId !== 'string' || !snapshot.selectedPromptId))
        || !Array.isArray(snapshot.prompts)
        || (snapshot.readOnlyReason !== undefined
            && snapshot.readOnlyReason !== 'invalid-data'
            && snapshot.readOnlyReason !== 'unsupported-version')) {
        return false;
    }

    var promptIds = new Set();
    var promptNames = new Set();
    for (var prompt of snapshot.prompts) {
        if (!hasExactObjectKeys(prompt, ['id', 'name', 'text'])
            || typeof prompt.id !== 'string'
            || !prompt.id
            || typeof prompt.name !== 'string'
            || !prompt.name.trim()
            || typeof prompt.text !== 'string'
            || !prompt.text.trim()
            || promptIds.has(prompt.id)
            || promptNames.has(prompt.name.toLowerCase())) {
            return false;
        }
        promptIds.add(prompt.id);
        promptNames.add(prompt.name.toLowerCase());
    }
    return snapshot.selectedPromptId === null || promptIds.has(snapshot.selectedPromptId);
}

function validateAiPanelMessage(message) {
    return hasExactObjectKeys(message, [
        'type',
        'version',
        'authoritySequence',
        'requestId',
        'target',
        'snapshot',
        'html',
    ])
        && message.type === 'ai-panel-content'
        && message.version === 1
        && Number.isSafeInteger(message.authoritySequence)
        && message.authoritySequence > 0
        && typeof message.requestId === 'string'
        && message.requestId.length > 0
        && message.requestId.length <= 128
        && message.target === 'global-prompt-library'
        && validatePromptPanelSnapshot(message.snapshot)
        && typeof message.html === 'string';
}

function validatePromptPanelUpdatedMessage(message) {
    return hasExactObjectKeys(message, [
        'type',
        'version',
        'authoritySequence',
        'target',
        'snapshot',
        'html',
    ])
        && message.type === 'prompt-panel-updated'
        && message.version === 1
        && Number.isSafeInteger(message.authoritySequence)
        && message.authoritySequence > 0
        && message.target === 'global-prompt-library'
        && validatePromptPanelSnapshot(message.snapshot)
        && typeof message.html === 'string';
}

function normalizeDashboardSearchCatalog(value) {
    if (value
        && value.version === 2
        && Array.isArray(value.sessions)
        && Array.isArray(value.openWorkspaces)
        && Array.isArray(value.savedProjects)
        && Array.isArray(value.todos)
        && (value.skills === undefined || Array.isArray(value.skills))) {
        return value;
    }
    return { version: 2, sessions: [], openWorkspaces: [], savedProjects: [], todos: [] };
}

function replaceDashboardSearchCatalogState(state, catalog) {
    return Object.assign({}, state, {
        catalog: normalizeDashboardSearchCatalog(catalog),
    });
}

function readInitialDashboardSearchCatalog() {
    var element = document.getElementById('dashboard-search-catalog');
    try {
        return normalizeDashboardSearchCatalog(JSON.parse(element ? element.textContent || '' : ''));
    } catch (_error) {
        return normalizeDashboardSearchCatalog(null);
    }
}

function globToDashboardRegex(value) {
    var escaped = String(value || '')
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(escaped, 'i');
}

function filterDashboardCatalog(catalog, query) {
    catalog = normalizeDashboardSearchCatalog(catalog);
    var regex = globToDashboardRegex(query);
    var sections = [
        { id: 'ai-sessions', title: 'AI SESSIONS', type: 'session', items: catalog.sessions },
        { id: 'open-workspaces', title: 'OPEN WORKSPACES', type: 'open-workspace', items: catalog.openWorkspaces },
        { id: 'saved-projects', title: 'SAVED PROJECTS', type: 'saved-project', items: catalog.savedProjects },
        { id: 'todos', title: 'TODO RESULTS', type: 'todo', items: catalog.todos },
        { id: 'skills', title: 'SKILLS', type: 'skill', items: catalog.skills || [] },
    ];
    return sections
        .map(section => ({
            id: section.id,
            title: section.title,
            type: section.type,
            items: section.items.filter(item => regex.test(String(item.searchText || ''))),
        }))
        .filter(section => section.items.length > 0);
}

function renderDashboardSearchResults(container, sections) {
    if (!container) {
        return;
    }
    while (container.firstChild) {
        container.removeChild(container.firstChild);
    }
    if (!sections.length) {
        var empty = document.createElement('div');
        empty.className = 'dashboard-search-empty';
        empty.setAttribute('role', 'status');
        empty.textContent = 'No matching projects or AI sessions.';
        container.appendChild(empty);
        return;
    }

    sections.forEach(section => {
        var sectionElement = document.createElement('section');
        sectionElement.className = 'dashboard-search-section';
        sectionElement.dataset.sectionType = section.type;
        var heading = document.createElement('h2');
        heading.className = 'dashboard-search-section-title';
        heading.textContent = section.title;
        sectionElement.appendChild(heading);

        section.items.forEach(item => {
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'dashboard-search-result';
            button.dataset.projectId = String(item.projectId || '');

            var title = document.createElement('span');
            title.className = 'dashboard-search-result-title';
            title.textContent = String(item.name || item.title || '');
            button.appendChild(title);

            var metadata = document.createElement('span');
            metadata.className = 'dashboard-search-result-meta';
            if (section.type === 'session') {
                button.dataset.provider = String(item.provider || '');
                button.dataset.sessionId = String(item.sessionId || '');
                button.dataset.searchAction = 'reveal-workspace-session';
                button.dataset.workspaceId = String(item.workspaceId || '');
                button.dataset.workspaceNavigationIdentity = String(item.workspaceNavigationIdentity || '');
                metadata.textContent = [item.workspaceName, item.provider].filter(Boolean).join(' · ');
                if (item.active === true) {
                    var activeBadge = document.createElement('span');
                    activeBadge.className = 'dashboard-search-result-status active';
                    activeBadge.textContent = 'Active';
                    metadata.appendChild(activeBadge);
                }
            } else if (section.type === 'open-workspace') {
                button.dataset.workspaceId = String(item.workspaceId || '');
                button.dataset.workspaceNavigationIdentity = String(item.navigationIdentity || '');
                button.dataset.searchAction = item.current === true
                    ? 'show-current-workspace'
                    : 'switch-open-workspace';
                metadata.textContent = [item.description, item.environmentLabel].filter(Boolean).join(' · ');
            } else if (section.type === 'skill') {
                button.dataset.searchAction = 'reveal-skill';
                button.dataset.skillDir = String(item.dirPath || '');
                metadata.textContent = [item.scope === 'project' ? 'Project' : 'Global', item.description].filter(Boolean).join(' · ');
            } else if (section.type === 'todo') {
                button.dataset.searchAction = 'show-todo';
                button.dataset.todoId = String(item.todoId || '');
                button.dataset.groupId = String(item.groupId || '');
                button.classList.toggle('completed', item.completed === true);
                var groupBadge = document.createElement('span');
                groupBadge.className = 'dashboard-search-result-group steward-badge';
                groupBadge.textContent = String(item.groupTitle || '');
                metadata.appendChild(groupBadge);
                var priority = document.createElement('span');
                priority.className = 'dashboard-search-result-priority';
                priority.textContent = String(item.priority || '').toUpperCase();
                metadata.appendChild(priority);
                if (item.completed === true) {
                    var status = document.createElement('span');
                    status.className = 'dashboard-search-result-status';
                    status.textContent = 'Completed';
                    metadata.appendChild(status);
                }
            } else {
                button.dataset.searchAction = 'open-saved-project';
                metadata.textContent = [item.description].concat(item.groupLabels || []).filter(Boolean).join(' · ');
            }
            button.appendChild(metadata);
            sectionElement.appendChild(button);
        });
        container.appendChild(sectionElement);
    });
}

function initDashboard(options) {
    options = options || {};
    var storageKey = 'agentPivot.activeDashboardTab';
    var scrollPositions = { open: 0, projects: 0, todo: 0, ai: 0 };
    var activeTab = normalizeDashboardTab(sessionStorage.getItem(storageKey));
    var projectsState = 'unloaded';
    var projectsRequestId = 0;
    var acceptedProjectsRequestId = 0;
    var acceptedProjectsUpdateSequence = 0;
    var projectsPanelReplacementGeneration = 0;
    var projectsRequestAttempts = 0;
    var projectsRequestTimer = null;
    var todoState = 'unloaded';
    var todoRequestId = 0;
    var acceptedTodoRequestId = 0;
    var todoRequestAttempts = 0;
    var todoRequestTimer = null;
    var aiState = 'unloaded';
    var aiRequestId = null;
    var aiRequestAttempts = 0;
    var aiRequestTimer = null;
    var aiRequestSequence = 0;
    var issuedAiRequestIds = new Set();
    var pendingAiSubtab = null;
    var pendingPromptRefresh = null;
    var pendingTodoSearchTarget = null;
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
        todo: document.getElementById('dashboard-tab-todo'),
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
            : tab === 'todo'
                ? '.dashboard-todo-loading'
                : '.dashboard-ai-loading');
    }

    function showPanelLoading(tab) {
        var loadingElement = getPanelLoadingElement(tab);
        if (!loadingElement) {
            return;
        }
        loadingElement.textContent = tab === 'projects'
            ? 'Loading projects…'
            : tab === 'todo'
                ? 'Loading todos…'
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
            : tab === 'todo'
                ? 'TODO'
                : 'AI configuration')
            + ' are temporarily unavailable. Select this tab to retry.';
        loadingElement.hidden = false;
    }

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
            if (projectsRequestAttempts < 2 && activeTab === 'projects' && !searchQuery) {
                ensureProjectsPanel();
                return;
            }
            showPanelUnavailable('projects');
        }, panelRequestTimeoutMs);
    }

    function scheduleTodoRequestTimeout(requestId) {
        if (!scheduleTimeout) {
            return;
        }
        if (todoRequestTimer !== null) {
            cancelTimeout(todoRequestTimer);
        }
        todoRequestTimer = scheduleTimeout(function () {
            todoRequestTimer = null;
            if (todoState !== 'loading' || requestId !== todoRequestId) {
                return;
            }
            todoState = 'unloaded';
            if (todoRequestAttempts < 2 && activeTab === 'todo' && !searchQuery) {
                ensureTodoPanel();
                return;
            }
            showPanelUnavailable('todo');
        }, panelRequestTimeoutMs);
    }

    function scheduleAiRequestTimeout(requestId) {
        if (!scheduleTimeout) {
            return;
        }
        if (aiRequestTimer !== null) {
            cancelTimeout(aiRequestTimer);
        }
        aiRequestTimer = scheduleTimeout(function () {
            aiRequestTimer = null;
            if (aiState !== 'loading' || requestId !== aiRequestId) {
                return;
            }
            aiState = 'unloaded';
            if (aiRequestAttempts < 2 && activeTab === 'ai' && !searchQuery) {
                ensureAiPanel();
                return;
            }
            showPanelUnavailable('ai');
        }, panelRequestTimeoutMs);
    }

    function createFreshAiRequestId() {
        aiRequestSequence += 1;
        var randomId = '';
        try {
            if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
                randomId = crypto.randomUUID();
            }
        } catch (_error) {
            randomId = '';
        }
        if (!randomId) {
            randomId = Date.now().toString(36)
                + '-' + Math.random().toString(36).slice(2);
        }
        var requestId = randomId + '-' + aiRequestSequence.toString(36);
        while (issuedAiRequestIds.has(requestId)) {
            aiRequestSequence += 1;
            requestId = randomId + '-' + aiRequestSequence.toString(36);
        }
        issuedAiRequestIds.add(requestId);
        return requestId;
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

    function ensureTodoPanel() {
        if (todoState !== 'unloaded') {
            return;
        }
        todoState = 'loading';
        todoRequestAttempts += 1;
        todoRequestId += 1;
        showPanelLoading('todo');
        options.postMessage({
            type: 'request-todo-panel',
            version: 1,
            requestId: todoRequestId,
        });
        scheduleTodoRequestTimeout(todoRequestId);
    }

    function ensureAiPanel() {
        if (aiState !== 'unloaded') {
            return;
        }
        aiState = 'loading';
        aiRequestAttempts += 1;
        aiRequestId = createFreshAiRequestId();
        showPanelLoading('ai');
        options.postMessage({
            type: 'request-ai-panel',
            version: 1,
            requestId: aiRequestId,
            target: 'global-prompt-library',
        });
        scheduleAiRequestTimeout(aiRequestId);
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
            if (projectsState === 'mounted') {
                restoreScroll('projects');
            } else {
                pendingScrollRestoreTab = 'projects';
                ensureProjectsPanel();
            }
        } else if (activeTab === 'todo') {
            if (todoState === 'mounted') {
                restoreScroll('todo');
            } else {
                pendingScrollRestoreTab = 'todo';
                ensureTodoPanel();
            }
        } else if (activeTab === 'ai') {
            if (aiState === 'mounted') {
                restoreScroll('ai');
            } else {
                pendingScrollRestoreTab = 'ai';
                ensureAiPanel();
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
            if (activeTab === 'projects' && projectsState !== 'mounted') {
                pendingScrollRestoreTab = 'projects';
                ensureProjectsPanel();
            } else if (activeTab === 'todo' && todoState !== 'mounted') {
                pendingScrollRestoreTab = 'todo';
                ensureTodoPanel();
            } else if (activeTab === 'ai' && aiState !== 'mounted') {
                pendingScrollRestoreTab = 'ai';
                ensureAiPanel();
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

    function revealSkillCard(dirPath) {
        if (!panels.ai || typeof panels.ai.querySelector !== 'function') {
            return false;
        }
        var skillsTab = panels.ai.querySelector('#ai-tab-skills');
        if (skillsTab && skillsTab.getAttribute('aria-selected') !== 'true' && typeof skillsTab.click === 'function') {
            skillsTab.click();
        }
        var cards = panels.ai.querySelectorAll('.skill-card[data-skill-dir]');
        for (var i = 0; i < cards.length; i++) {
            if (cards[i].getAttribute('data-skill-dir') !== dirPath) {
                continue;
            }
            var detail = cards[i].querySelector('.skill-detail');
            if (detail) {
                detail.hidden = false;
                cards[i].classList.add('skill-detail-open');
            }
            if (typeof cards[i].scrollIntoView === 'function') {
                cards[i].scrollIntoView({ block: 'center' });
            }
            return true;
        }
        return false;
    }

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
            if (aiState === 'mounted') {
                var revealDir = pendingSkillReveal;
                pendingSkillReveal = null;
                revealSkillCard(revealDir);
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
        if (action === 'show-todo') {
            pendingTodoSearchTarget = {
                todoId: String(button.dataset.todoId || ''),
                groupId: String(button.dataset.groupId || ''),
                revealRequested: false,
                focusScheduled: false,
            };
            if (typeof options.clearSearch === 'function') {
                options.clearSearch();
            } else {
                setSearchQuery('');
            }
            activateTab('todo', false);
            if (todoState === 'mounted') {
                revealPendingTodoSearchTarget();
            }
        }
    }

    var skillAgentFilter = 'all';
    var skillScopeActionSequence = 0;
    var skillScopeActionPending = {};

    function nextSkillScopeActionRequestId() {
        skillScopeActionSequence += 1;
        return 'skill-scope-' + Date.now().toString(36) + '-' + skillScopeActionSequence.toString(36);
    }

    function findSkillScopeActionButton(dirPath, operation) {
        var buttons = document.querySelectorAll
            ? document.querySelectorAll('[data-skill-scope-action]')
            : [];
        for (var i = 0; i < buttons.length; i++) {
            if (buttons[i].getAttribute('data-skill-scope-action') === dirPath
                && buttons[i].getAttribute('data-skill-scope-operation') === operation) {
                return buttons[i];
            }
        }
        return null;
    }

    function markSkillScopeActionPending(button, pending) {
        if (!button || !pending) {
            return;
        }
        button.setAttribute('aria-disabled', 'true');
        button.classList.add('pending');
        button.textContent = pending.operation === 'move-to-global' ? 'Moving…' : 'Applying…';
    }

    function restorePendingSkillScopeActions() {
        Object.keys(skillScopeActionPending).forEach(function (requestId) {
            var pending = skillScopeActionPending[requestId];
            markSkillScopeActionPending(
                findSkillScopeActionButton(pending.dirPath, pending.operation),
                pending
            );
        });
    }

    function isMatchingSkillScopeSettlement(settlement, pending) {
        return Boolean(settlement && settlement.version === 1
            && settlement.requestId === pending.requestId
            && settlement.dirPath === pending.dirPath
            && settlement.operation === pending.operation
            && typeof settlement.ok === 'boolean');
    }

    function announceSkillScopeSettlement(settlement, pending) {
        var status = document.querySelector ? document.querySelector('[data-skill-scope-status]') : null;
        if (!status || !settlement || !pending) {
            return;
        }
        status.textContent = settlement.ok
            ? (pending.operation === 'move-to-global'
                ? 'Skill moved to Global management.'
                : 'Project skill access updated.')
            : (settlement.code === 'cancelled' ? 'Skill action cancelled.' : 'Skill action failed.');
    }

    function replaceSkillsHtml(html, settlement) {
        var skillsWrapper = document.querySelector
            ? document.querySelector('#ai-panel-skills .sticky-groups-wrapper')
            : null;
        if (!skillsWrapper || typeof html !== 'string') {
            return false;
        }
        var collapsedSkillGroups = captureSkillCollapsedGroups(skillsWrapper);
        var expandedSkillCards = captureSkillExpandedCards(skillsWrapper);
        var folderMenuState = captureSkillFolderMenuState();
        var focused = document.activeElement && document.activeElement.getAttribute
            ? {
                dirPath: document.activeElement.getAttribute('data-skill-scope-action'),
                operation: document.activeElement.getAttribute('data-skill-scope-operation'),
            }
            : null;
        var candidatePending = settlement ? skillScopeActionPending[settlement.requestId] : null;
        var settledPending = candidatePending && isMatchingSkillScopeSettlement(settlement, candidatePending)
            ? candidatePending
            : null;
        if (settledPending) {
            delete skillScopeActionPending[settlement.requestId];
        }
        skillsWrapper.outerHTML = html;
        var nextSkillsWrapper = document.querySelector('#ai-panel-skills .sticky-groups-wrapper');
        restoreSkillCollapsedGroups(nextSkillsWrapper, collapsedSkillGroups);
        restoreSkillExpandedCards(nextSkillsWrapper, expandedSkillCards);
        restoreSkillFolderMenuState(folderMenuState);
        restorePendingSkillScopeActions();
        applySkillAgentFilter();
        announceSkillScopeSettlement(settlement, settledPending);
        if (focused && focused.dirPath) {
            var nextFocused = findSkillScopeActionButton(focused.dirPath, focused.operation);
            if (!nextFocused && settledPending && settlement.ok && settlement.resultDirPath) {
                nextFocused = findSkillScopeActionButton(settlement.resultDirPath, 'apply-to-project');
            }
            if (nextFocused && typeof nextFocused.focus === 'function') {
                nextFocused.focus();
            } else if (settledPending && nextSkillsWrapper && typeof nextSkillsWrapper.focus === 'function') {
                nextSkillsWrapper.setAttribute('tabindex', '-1');
                nextSkillsWrapper.focus();
            }
        }
        return true;
    }

    function settleSkillScopeActionWithoutHtml(settlement) {
        var pending = settlement && skillScopeActionPending[settlement.requestId];
        if (!pending || !isMatchingSkillScopeSettlement(settlement, pending) || settlement.ok) {
            return false;
        }
        delete skillScopeActionPending[settlement.requestId];
        var button = findSkillScopeActionButton(pending.dirPath, pending.operation);
        if (button) {
            button.removeAttribute('aria-disabled');
            button.classList.remove('pending');
            button.textContent = pending.label;
        }
        announceSkillScopeSettlement(settlement, pending);
        return true;
    }

    function applySkillAgentFilter() {
        var panel = document.querySelector
            ? document.querySelector('#ai-panel-skills')
            : null;
        if (!panel) {
            return;
        }
        var row = panel.querySelector('[data-skill-filter-row]');
        if (!row) {
            return;
        }
        var buttons = row.querySelectorAll('[data-skill-filter]');
        for (var i = 0; i < buttons.length; i++) {
            buttons[i].classList.toggle('is-active', buttons[i].getAttribute('data-skill-filter') === skillAgentFilter);
        }
        // NOTE: the `hidden` attribute cannot hide .project-container/.group
        // (author display rules beat the UA [hidden] rule) — use a class.
        var cards = panel.querySelectorAll('.skill-card[data-skill-dir]');
        for (var c = 0; c < cards.length; c++) {
            var agents = cards[c].getAttribute('data-skill-agents') || '';
            var show = skillAgentFilter === 'all'
                || (' ' + agents + ' ').indexOf(' ' + skillAgentFilter + ' ') !== -1;
            var container = cards[c].closest('.project-container') || cards[c];
            container.classList.toggle('skill-filter-hidden', !show);
        }
        // Children first (reverse document order) so parent folders see their
        // children's computed visibility.
        var sections = panel.querySelectorAll('.group.steward-section, .skill-source-group');
        for (var s = sections.length - 1; s >= 0; s--) {
            var section = sections[s];
            var sectionCards = section.querySelectorAll('.skill-card[data-skill-dir]');
            var sectionVisible = 0;
            for (var sc = 0; sc < sectionCards.length; sc++) {
                var scContainer = sectionCards[sc].closest('.project-container') || sectionCards[sc];
                if (!scContainer.classList.contains('skill-filter-hidden')) {
                    sectionVisible += 1;
                }
            }
            if (section.classList.contains('skill-source-group')) {
                section.classList.toggle('skill-filter-hidden', sectionVisible === 0);
            } else {
                var childFolders = section.querySelectorAll('.skill-folder');
                var visibleChildFolders = 0;
                for (var cf = 0; cf < childFolders.length; cf++) {
                    if (!childFolders[cf].classList.contains('skill-filter-hidden')) {
                        visibleChildFolders += 1;
                    }
                }
                // Empty leaf folders (created via "+") always stay visible; a folder
                // or section hides only when nothing inside it — cards or child
                // folders — is visible.
                var emptyLeaf = section.classList.contains('skill-folder')
                    && sectionCards.length === 0 && childFolders.length === 0;
                section.classList.toggle('skill-filter-hidden',
                    sectionVisible === 0 && visibleChildFolders === 0 && !emptyLeaf);
            }
            var countEl = section.querySelector(':scope > .group-title > .group-title-badge')
                || section.querySelector(':scope > .skill-source-header > .skill-source-count');
            if (countEl) {
                countEl.textContent = String(sectionVisible);
            }
        }
    }

    function captureSkillCollapsedGroups(wrapper) {
        // Folder nodes are keyed by store + folder path (stable across re-renders);
        // every other section keeps its data-group-id key.
        var ids = [];
        var folders = [];
        if (wrapper && wrapper.querySelectorAll) {
            var collapsed = wrapper.querySelectorAll('.group.steward-section.collapsed');
            for (var i = 0; i < collapsed.length; i++) {
                if (collapsed[i].classList.contains('skill-folder')) {
                    continue;
                }
                ids.push(collapsed[i].getAttribute('data-group-id'));
            }
            var folderNodes = wrapper.querySelectorAll('.skill-folder[data-skill-folder]');
            for (var f = 0; f < folderNodes.length; f++) {
                if (folderNodes[f].classList.contains('collapsed')) {
                    folders.push(folderNodes[f].getAttribute('data-skill-store') + '|' + folderNodes[f].getAttribute('data-skill-folder'));
                }
            }
        }
        return { ids: ids, folders: folders };
    }

    function restoreSkillCollapsedGroups(wrapper, state) {
        if (!wrapper || !state) {
            return;
        }
        var ids = state.ids || [];
        for (var i = 0; i < ids.length; i++) {
            var group = wrapper.querySelector('.group.steward-section[data-group-id="' + ids[i] + '"]');
            if (group) {
                group.classList.add('collapsed');
            }
        }
        var folderKeys = state.folders || [];
        if (!folderKeys.length || !wrapper.querySelectorAll) {
            return;
        }
        var folderNodes = wrapper.querySelectorAll('.skill-folder[data-skill-folder]');
        for (var f = 0; f < folderNodes.length; f++) {
            var key = folderNodes[f].getAttribute('data-skill-store') + '|' + folderNodes[f].getAttribute('data-skill-folder');
            if (folderKeys.indexOf(key) !== -1) {
                folderNodes[f].classList.add('collapsed');
            }
        }
    }

    function onSkillMoveInputKeydown(event) {
        var input = event.target && event.target.closest ? event.target.closest('[data-skill-move-folder]') : null;
        if (!input || event.key !== 'Enter') {
            return;
        }
        event.preventDefault();
        var detail = input.closest('.skill-detail');
        var button = detail && detail.querySelector('[data-skill-move-set]');
        if (button && typeof button.click === 'function') {
            button.click();
        }
    }

    // Scope is positional: switches in the global section act on user-level agent
    // roots, switches in the project section on the current project's agent roots.
    // There is no panel-level scope selector anymore.
    function skillSwitchScope(el) {
        return el.closest && el.closest('[data-group-id="project-skills"]') ? 'project' : 'user';
    }

    var skillFolderMenu = null;

    function closeSkillFolderMenu() {
        if (skillFolderMenu) {
            skillFolderMenu.remove();
            skillFolderMenu = null;
        }
    }

    function onSkillFolderMenuKeydown(event) {
        if (event.key === 'Escape') {
            closeSkillFolderMenu();
        }
    }

    // One shared context menu for folder batch actions (VS Code "More Actions"
    // style): agent switches + delete, built from the ⋯ button's data attributes.
    function positionSkillFolderMenu(menu, button) {
        var rect = menu.getBoundingClientRect();
        var anchor = button.getBoundingClientRect();
        var viewportPadding = 4;
        var left = anchor.right - rect.width;
        var top = anchor.bottom + 2;
        if (left + rect.width + viewportPadding > window.innerWidth) {
            left = Math.max(viewportPadding, window.innerWidth - rect.width - viewportPadding);
        }
        if (left < viewportPadding) {
            left = viewportPadding;
        }
        if (top + rect.height + viewportPadding > window.innerHeight) {
            top = Math.max(viewportPadding, anchor.top - rect.height - 2);
        }
        menu.style.left = left + 'px';
        menu.style.top = top + 'px';
    }

    function appendMenuAgentToggles(menu, button, folder, scope) {
        var agents = ['kimi', 'claude', 'codex'];
        for (var i = 0; i < agents.length; i++) {
            var agent = agents[i];
            var state = button.getAttribute('data-state-' + agent) || 'off';
            var item = document.createElement('div');
            item.className = 'custom-context-menu-item skill-folder-menu-item';
            var label = document.createElement('span');
            label.className = 'skill-folder-menu-agent';
            label.textContent = agent;
            var toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'skill-ios-toggle' + (state === 'on' ? '' : ' ' + state);
            toggle.title = (state === 'on' ? 'Disable every skill under ' : 'Enable every skill under ')
                + (folder || 'this section') + ' for ' + agent;
            toggle.setAttribute('data-folder-toggle', folder);
            toggle.setAttribute('data-folder-agent', agent);
            toggle.setAttribute('data-folder-scope', scope);
            item.appendChild(label);
            item.appendChild(toggle);
            menu.appendChild(item);
        }
        var separator = document.createElement('div');
        separator.className = 'custom-context-menu-separator';
        menu.appendChild(separator);
    }

    function appendMenuAction(menu, className, text) {
        var item = document.createElement('div');
        item.className = 'custom-context-menu-item ' + className;
        item.textContent = text;
        menu.appendChild(item);
        return item;
    }

    function openSkillFolderMenu(button) {
        closeSkillFolderMenu();
        var folder = button.getAttribute('data-folder-menu') || '';
        var scope = button.getAttribute('data-folder-scope') || 'user';
        var storeNode = button.closest('[data-skill-store]');
        var menu = document.createElement('div');
        menu.className = 'custom-context-menu skill-folder-menu visible';
        if (storeNode) {
            menu.setAttribute('data-skill-store', storeNode.getAttribute('data-skill-store'));
        }
        // DOM construction (not innerHTML) so disk-derived folder names can
        // never break out of attributes and inject markup.
        appendMenuAgentToggles(menu, button, folder, scope);
        var newItem = appendMenuAction(menu, 'skill-folder-menu-new', 'New subfolder');
        newItem.setAttribute('data-skill-menu-new-folder', folder);
        newItem.setAttribute('data-folder-scope', scope);
        var removeItem = appendMenuAction(menu, 'skill-folder-menu-remove', 'Delete empty folder');
        removeItem.setAttribute('data-skill-remove-folder', folder);
        document.body.appendChild(menu);
        positionSkillFolderMenu(menu, button);
        menu.__sourceButton = button;
        menu.__identity = { section: false, folder: folder, scope: scope };
        skillFolderMenu = menu;
    }

    // Section (global / project) ⋯ menu: store-level actions.
    function openSkillSectionMenu(button) {
        closeSkillFolderMenu();
        var scope = button.getAttribute('data-section-menu') || 'user';
        var menu = document.createElement('div');
        menu.className = 'custom-context-menu skill-folder-menu visible';
        var storeNode = button.closest('[data-skill-store]');
        if (storeNode) {
            menu.setAttribute('data-skill-store', storeNode.getAttribute('data-skill-store'));
        }
        appendMenuAgentToggles(menu, button, '', scope);
        var newItem = appendMenuAction(menu, 'skill-folder-menu-new', 'New folder');
        newItem.setAttribute('data-skill-menu-new-folder', '');
        newItem.setAttribute('data-folder-scope', scope);
        var migrateItem = appendMenuAction(menu, 'skill-folder-menu-migrate', 'Migrate to central…');
        migrateItem.setAttribute('data-skill-menu-migrate', scope);
        if (scope === 'user') {
            var locationItem = appendMenuAction(
                menu,
                'skill-folder-menu-location',
                'Change Global Skills Location…'
            );
            locationItem.setAttribute('data-change-global-skills-location', '');
        }
        document.body.appendChild(menu);
        positionSkillFolderMenu(menu, button);
        menu.__sourceButton = button;
        menu.__identity = { section: true, folder: '', scope: scope };
        skillFolderMenu = menu;
    }

    // Keep the ⋯ menu open across per-agent toggles: the switch gets a pending
    // look (never an optimistic committed state) and the authoritative
    // skills-updated re-syncs it afterwards. Popup state stays webview-local.
    function captureSkillFolderMenuState() {
        if (!skillFolderMenu || !skillFolderMenu.__identity) {
            return null;
        }
        return { identity: skillFolderMenu.__identity };
    }

    function restoreSkillFolderMenuState(state) {
        if (!state || !skillFolderMenu) {
            return;
        }
        var identity = state.identity;
        var candidates = document.querySelectorAll(identity.section ? '[data-section-menu]' : '[data-folder-menu]');
        var button = null;
        for (var i = 0; i < candidates.length; i++) {
            var candidate = candidates[i];
            if (identity.section) {
                if (candidate.getAttribute('data-section-menu') === identity.scope) {
                    button = candidate;
                    break;
                }
            } else if (candidate.getAttribute('data-folder-menu') === identity.folder
                && candidate.getAttribute('data-folder-scope') === identity.scope) {
                button = candidate;
                break;
            }
        }
        if (!button) {
            closeSkillFolderMenu();
            return;
        }
        var menu = skillFolderMenu;
        var agents = ['kimi', 'claude', 'codex'];
        for (var j = 0; j < agents.length; j++) {
            var agent = agents[j];
            var sw = menu.querySelector('[data-folder-agent="' + agent + '"]');
            if (!sw) {
                continue;
            }
            var next = button.getAttribute('data-state-' + agent) || 'off';
            sw.classList.remove('off', 'indeterminate', 'skill-toggle-pending');
            sw.disabled = false;
            if (next !== 'on') {
                sw.classList.add(next);
            }
            var folder = sw.getAttribute('data-folder-toggle') || '';
            var target = folder ? 'every skill under ' + folder : 'every skill in this section';
            sw.setAttribute('title', (next === 'on' ? 'Disable ' : 'Enable ') + target + ' for ' + agent);
        }
        menu.__sourceButton = button;
        positionSkillFolderMenu(menu, button);
    }

    function captureSkillExpandedCards(wrapper) {
        var dirs = [];
        if (wrapper && wrapper.querySelectorAll) {
            var open = wrapper.querySelectorAll('.skill-card.skill-detail-open');
            for (var i = 0; i < open.length; i++) {
                dirs.push(open[i].getAttribute('data-skill-dir'));
            }
        }
        return dirs;
    }

    function restoreSkillExpandedCards(wrapper, dirs) {
        if (!wrapper || !dirs || !dirs.length) {
            return;
        }
        var cards = wrapper.querySelectorAll('.skill-card[data-skill-dir]');
        for (var i = 0; i < cards.length; i++) {
            if (dirs.indexOf(cards[i].getAttribute('data-skill-dir')) === -1) {
                continue;
            }
            var detail = cards[i].querySelector('.skill-detail');
            if (detail) {
                detail.hidden = false;
                cards[i].classList.add('skill-detail-open');
            }
        }
    }

    var skillDragState = null;

    function findSkillDropFolder(event) {
        if (!skillDragState) {
            return null;
        }
        var folder = event.target && event.target.closest
            ? event.target.closest('.skill-folder')
            : null;
        var section = event.target && event.target.closest
            ? event.target.closest('.group.steward-section[data-skill-store]')
            : null;
        var target = folder || section;
        if (!target) {
            return null;
        }
        // A card can only move inside its own store: user skills in the global
        // section, project skills in the project section.
        var targetScope = folder
            ? folder.getAttribute('data-skill-folder-scope')
            : (section.getAttribute('data-group-id') === 'project-skills' ? 'project' : 'user');
        if (targetScope !== skillDragState.scope) {
            return null;
        }
        return {
            element: target,
            folder: folder ? folder.getAttribute('data-skill-folder') || '' : '',
        };
    }

    function onSkillDragStart(event) {
        var container = event.target && event.target.closest
            ? event.target.closest('.project-container[data-skill-scope]')
            : null;
        if (!container) {
            return;
        }
        var card = container.querySelector('.skill-card[data-skill-dir]');
        if (!card) {
            return;
        }
        skillDragState = {
            dirPath: card.getAttribute('data-skill-dir'),
            scope: container.getAttribute('data-skill-scope'),
        };
        container.classList.add('skill-card-dragging');
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', skillDragState.dirPath);
        }
    }

    function onSkillDragOver(event) {
        var target = findSkillDropFolder(event);
        if (!target) {
            return;
        }
        event.preventDefault();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'move';
        }
        target.element.classList.add('skill-drop-target');
    }

    function onSkillDragLeave(event) {
        var target = findSkillDropFolder(event);
        if (target && event.relatedTarget && target.element.contains(event.relatedTarget)) {
            return;
        }
        if (target) {
            target.element.classList.remove('skill-drop-target');
        }
    }

    function onSkillDrop(event) {
        var target = findSkillDropFolder(event);
        if (!target) {
            return;
        }
        event.preventDefault();
        target.element.classList.remove('skill-drop-target');
        options.postMessage({
            type: 'move-skill-to-folder',
            dirPath: skillDragState.dirPath,
            folder: target.folder,
        });
    }

    function onSkillDragEnd(event) {
        if (skillDragState) {
            var dragging = document.querySelectorAll('.skill-card-dragging');
            for (var i = 0; i < dragging.length; i++) {
                dragging[i].classList.remove('skill-card-dragging');
            }
        }
        skillDragState = null;
        var targets = document.querySelectorAll('.skill-drop-target');
        for (var t = 0; t < targets.length; t++) {
            targets[t].classList.remove('skill-drop-target');
        }
    }

    function onSkillCardClick(event) {
        var filter = event.target && event.target.closest ? event.target.closest('[data-skill-filter]') : null;
        if (filter) {
            event.preventDefault();
            skillAgentFilter = filter.getAttribute('data-skill-filter') || 'all';
            applySkillAgentFilter();
            return;
        }
        if (skillFolderMenu && !(event.target && event.target.closest && event.target.closest('.skill-folder-menu'))) {
            closeSkillFolderMenu();
        }
        var scopeAction = event.target && event.target.closest ? event.target.closest('[data-skill-scope-action]') : null;
        if (scopeAction) {
            event.preventDefault();
            event.stopPropagation();
            if (scopeAction.disabled || scopeAction.getAttribute('aria-disabled') === 'true'
                || scopeAction.classList.contains('pending')) {
                return;
            }
            var requestId = nextSkillScopeActionRequestId();
            var pending = {
                requestId: requestId,
                dirPath: scopeAction.getAttribute('data-skill-scope-action') || '',
                operation: scopeAction.getAttribute('data-skill-scope-operation') || '',
                label: scopeAction.textContent || '',
            };
            skillScopeActionPending[requestId] = pending;
            markSkillScopeActionPending(scopeAction, pending);
            options.postMessage({
                type: 'skill-scope-action',
                version: 1,
                requestId: requestId,
                dirPath: pending.dirPath,
                operation: pending.operation,
            });
            return;
        }
        var sectionMenuButton = event.target && event.target.closest ? event.target.closest('[data-section-menu]') : null;
        if (sectionMenuButton) {
            event.preventDefault();
            event.stopPropagation();
            if (skillFolderMenu && skillFolderMenu.__sourceButton === sectionMenuButton) {
                closeSkillFolderMenu();
            } else {
                openSkillSectionMenu(sectionMenuButton);
            }
            return;
        }
        var folderMenuButton = event.target && event.target.closest ? event.target.closest('[data-folder-menu]') : null;
        if (folderMenuButton) {
            event.preventDefault();
            event.stopPropagation();
            if (skillFolderMenu && skillFolderMenu.__sourceButton === folderMenuButton) {
                closeSkillFolderMenu();
            } else {
                openSkillFolderMenu(folderMenuButton);
            }
            return;
        }
        var folderToggle = event.target && event.target.closest ? event.target.closest('[data-folder-toggle]') : null;
        if (folderToggle) {
            event.preventDefault();
            event.stopPropagation();
            var folderNode = folderToggle.closest('[data-skill-store]');
            // The menu stays open for multi-agent changes; pending ≠ committed,
            // the authoritative skills-updated re-syncs the switch.
            folderToggle.classList.add('skill-toggle-pending');
            folderToggle.disabled = true;
            options.postMessage({
                type: 'folder-toggle-skill-links',
                storeRoot: folderNode ? folderNode.getAttribute('data-skill-store') : '',
                folder: folderToggle.getAttribute('data-folder-toggle'),
                scope: folderToggle.getAttribute('data-folder-scope'),
                agent: folderToggle.getAttribute('data-folder-agent'),
                enabled: !folderToggle.classList.contains('off') && !folderToggle.classList.contains('indeterminate'),
            });
            return;
        }
        var moveSet = event.target && event.target.closest ? event.target.closest('[data-skill-move-set]') : null;
        if (moveSet) {
            event.preventDefault();
            event.stopPropagation();
            var moveDetail = moveSet.closest('.skill-detail');
            var moveInput = moveDetail && moveDetail.querySelector('[data-skill-move-folder]');
            options.postMessage({
                type: 'move-skill-to-folder',
                dirPath: moveSet.getAttribute('data-skill-move-set'),
                folder: moveInput ? moveInput.value : '',
            });
            return;
        }
        var newFolder = event.target && event.target.closest ? event.target.closest('[data-skill-menu-new-folder]') : null;
        if (newFolder) {
            event.preventDefault();
            event.stopPropagation();
            closeSkillFolderMenu();
            options.postMessage({
                type: 'create-skill-folder',
                scope: newFolder.getAttribute('data-folder-scope'),
                parentFolder: newFolder.getAttribute('data-skill-menu-new-folder'),
            });
            return;
        }
        var removeFolder = event.target && event.target.closest ? event.target.closest('[data-skill-remove-folder]') : null;
        if (removeFolder) {
            event.preventDefault();
            event.stopPropagation();
            var menuFolder = removeFolder.closest('.skill-folder-menu');
            var removeNode = menuFolder
                ? (skillFolderMenu && skillFolderMenu.__sourceButton
                    ? skillFolderMenu.__sourceButton.closest('[data-skill-store]')
                    : null)
                : removeFolder.closest('[data-skill-store]');
            closeSkillFolderMenu();
            options.postMessage({
                type: 'remove-skill-folder',
                storeRoot: removeNode ? removeNode.getAttribute('data-skill-store') : '',
                folder: removeFolder.getAttribute('data-skill-remove-folder'),
            });
            return;
        }
        var deleteSkill = event.target && event.target.closest ? event.target.closest('[data-skill-delete]') : null;
        if (deleteSkill) {
            event.preventDefault();
            event.stopPropagation();
            options.postMessage({ type: 'delete-skill', dirPath: deleteSkill.getAttribute('data-skill-delete') });
            return;
        }
        var applySuggestion = event.target && event.target.closest ? event.target.closest('[data-skill-apply-suggestion]') : null;
        if (applySuggestion) {
            event.preventDefault();
            event.stopPropagation();
            options.postMessage({ type: 'apply-skill-collection', name: applySuggestion.getAttribute('data-skill-apply-suggestion') });
            return;
        }
        var dismissSuggestion = event.target && event.target.closest ? event.target.closest('[data-skill-dismiss-suggestion]') : null;
        if (dismissSuggestion) {
            event.preventDefault();
            event.stopPropagation();
            options.postMessage({ type: 'dismiss-skill-collection', name: dismissSuggestion.getAttribute('data-skill-dismiss-suggestion') });
            return;
        }
        var centralToggle = event.target && event.target.closest ? event.target.closest('[data-central-toggle]') : null;
        if (centralToggle) {
            event.preventDefault();
            event.stopPropagation();
            options.postMessage({
                type: 'central-toggle-skill',
                dirPath: centralToggle.getAttribute('data-central-toggle'),
                source: centralToggle.getAttribute('data-central-source'),
                scope: skillSwitchScope(centralToggle),
                enabled: !centralToggle.classList.contains('off'),
            });
            return;
        }
        var centralize = event.target && event.target.closest ? event.target.closest('[data-skill-centralize]') : null;
        if (centralize) {
            event.preventDefault();
            event.stopPropagation();
            options.postMessage({ type: 'centralize-skill', dirPath: centralize.getAttribute('data-skill-centralize') });
            return;
        }
        var migrateCentral = event.target && event.target.closest ? event.target.closest('[data-skill-menu-migrate]') : null;
        if (migrateCentral) {
            event.preventDefault();
            event.stopPropagation();
            closeSkillFolderMenu();
            options.postMessage({ type: 'migrate-skills-to-central', scope: migrateCentral.getAttribute('data-skill-menu-migrate') });
            return;
        }
        var changeGlobalSkillsLocation = event.target && event.target.closest
            ? event.target.closest('[data-change-global-skills-location]')
            : null;
        if (changeGlobalSkillsLocation) {
            event.preventDefault();
            event.stopPropagation();
            closeSkillFolderMenu();
            options.postMessage({ type: 'change-global-skills-location' });
            return;
        }
        var sync = event.target && event.target.closest ? event.target.closest('[data-skill-sync]') : null;
        if (sync) {
            event.preventDefault();
            event.stopPropagation();
            options.postMessage({
                type: 'sync-skill',
                sourceDir: sync.getAttribute('data-skill-sync'),
                targetDir: sync.getAttribute('data-skill-sync-target'),
            });
            return;
        }
        var copy = event.target && event.target.closest ? event.target.closest('[data-skill-copy]') : null;
        if (copy) {
            event.preventDefault();
            event.stopPropagation();
            options.postMessage({
                type: 'copy-skill',
                sourceDir: copy.getAttribute('data-skill-copy'),
                targetRoot: copy.getAttribute('data-skill-copy-root'),
            });
            return;
        }
        var fix = event.target && event.target.closest ? event.target.closest('[data-skill-fix]') : null;
        if (fix) {
            event.preventDefault();
            event.stopPropagation();
            options.postMessage({
                type: 'fix-skill-diagnostic',
                dirPath: fix.getAttribute('data-skill-fix'),
                code: fix.getAttribute('data-skill-fix-code'),
            });
            return;
        }
        var openButton = event.target && event.target.closest ? event.target.closest('[data-skill-open]') : null;
        if (openButton) {
            event.preventDefault();
            event.stopPropagation();
            options.postMessage({ type: 'open-skill-file', skillFilePath: openButton.getAttribute('data-skill-open') });
            return;
        }
        var skillCard = event.target && event.target.closest ? event.target.closest('.skill-card[data-skill-dir]') : null;
        if (skillCard) {
            if (event.target.closest && event.target.closest('.skill-detail')) {
                return;
            }
            var detail = skillCard.querySelector('.skill-detail');
            if (detail) {
                detail.hidden = !detail.hidden;
                skillCard.classList.toggle('skill-detail-open', !detail.hidden);
            }
        }
    }

    function revealPendingTodoSearchTarget() {
        if (!pendingTodoSearchTarget || !panels.todo || pendingTodoSearchTarget.focusScheduled) {
            return false;
        }
        var scheduledTarget = pendingTodoSearchTarget;
        scheduledTarget.focusScheduled = true;
        requestAnimationFrame(() => {
            if (pendingTodoSearchTarget !== scheduledTarget) {
                return;
            }
            scheduledTarget.focusScheduled = false;
            if (window.__agentPivotTodo
                && typeof window.__agentPivotTodo.openDetail === 'function'
                && window.__agentPivotTodo.openDetail(scheduledTarget.todoId)) {
                pendingTodoSearchTarget = null;
                return;
            }
            var todoItem = Array.from(panels.todo.querySelectorAll('.todo-item[data-todo-id]'))
                .find(item => item.getAttribute('data-todo-id') === scheduledTarget.todoId);
            var todoGroup = todoItem && todoItem.closest ? todoItem.closest('.todo-group') : null;
            if (!todoItem || (todoGroup && todoGroup.classList.contains('collapsed'))) {
                if (!scheduledTarget.revealRequested) {
                    scheduledTarget.revealRequested = true;
                    options.postMessage({
                        type: 'todo-reveal',
                        todoId: scheduledTarget.todoId,
                        groupId: scheduledTarget.groupId,
                    });
                }
                return;
            }
            if (!todoItem.isConnected) {
                return;
            }

            todoItem.setAttribute('tabindex', '-1');
            try {
                todoItem.scrollIntoView({ block: 'nearest' });
                todoItem.focus();
            } catch (_error) {
                todoItem.removeAttribute('tabindex');
                return;
            }
            if (!todoItem.isConnected || document.activeElement !== todoItem) {
                todoItem.removeAttribute('tabindex');
                return;
            }
            pendingTodoSearchTarget = null;
            todoItem.addEventListener('blur', () => todoItem.removeAttribute('tabindex'), { once: true });
        });
        return true;
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
        if (pendingScrollRestoreTab === 'projects') {
            pendingScrollRestoreTab = null;
            if (activeTab === 'projects' && !searchQuery) {
                restoreScroll('projects');
            }
        }
        return true;
    }

    function getProjectIdsFromGroup(group) {
        return Array.from(group.querySelectorAll('.project[data-id]:not([data-virtual-project])'))
            .map(project => project.getAttribute('data-id'));
    }

    function arraysEqual(left, right) {
        return left.length === right.length
            && left.every((value, index) => value === right[index]);
    }

    function isProjectsPanelOrderConsistent(message) {
        if (!panels.projects || typeof panels.projects.querySelectorAll !== 'function') {
            return false;
        }
        var groups = Array.from(panels.projects.querySelectorAll(
            '.groups-wrapper > .group[data-group-id]:not([data-virtual-group])'
        ));
        if (groups.length !== message.groupOrders.length) {
            return false;
        }
        for (var index = 0; index < groups.length; index += 1) {
            var expected = message.groupOrders[index];
            if (groups[index].getAttribute('data-group-id') !== expected.groupId
                || !arraysEqual(getProjectIdsFromGroup(groups[index]), expected.projectIds)) {
                return false;
            }
        }
        var favoritesGroup = panels.projects.querySelector(
            '.group[data-system-group="__favorites"]'
        );
        var favoriteIds = favoritesGroup
            ? Array.from(favoritesGroup.querySelectorAll('.project[data-id]'))
                .map(project => project.getAttribute('data-id'))
            : [];
        return arraysEqual(favoriteIds, message.favoriteProjectIds);
    }

    function getProjectsFocusTarget() {
        var activeElement = document.activeElement;
        if (!activeElement || !panels.projects || !panels.projects.contains(activeElement)) {
            return null;
        }
        var project = activeElement.closest ? activeElement.closest('.project[data-id]') : null;
        var action = activeElement.closest ? activeElement.closest('[data-action]') : null;
        return project ? {
            groupId: project.closest('.group[data-group-id]')
                ? project.closest('.group[data-group-id]').getAttribute('data-group-id') || ''
                : '',
            projectId: project.getAttribute('data-id'),
            action: action ? action.getAttribute('data-action') : null,
        } : null;
    }

    function getProjectScrollItemKey(project) {
        var group = project.closest('.group[data-group-id]');
        return JSON.stringify([
            group ? group.getAttribute('data-group-id') || '' : '',
            project.getAttribute('data-id') || '',
        ]);
    }

    function captureProjectsPanelState() {
        var state = {
            windowScrollY: window.scrollY,
            focus: getProjectsFocusTarget(),
            groups: Array.from(panels.projects.querySelectorAll(
                '.group[data-group-id]'
            )).map(function (group) {
                var list = group.querySelector('.group-list');
                return {
                    groupId: group.getAttribute('data-group-id') || '',
                    anchor: list && window.__agentPivotScrollState
                        ? window.__agentPivotScrollState.capture(list, {
                            itemSelector: '.project[data-id]',
                            getKey: getProjectScrollItemKey,
                        })
                        : null,
                };
            }),
        };
        if (!state.focus) {
            return state;
        }
        var focusGroup = findProjectsPanelGroup(state.focus.groupId);
        var focusList = focusGroup && focusGroup.querySelector('.group-list');
        var focusProject = focusList && Array.from(
            focusList.querySelectorAll('.project[data-id]')
        ).find(project => project.getAttribute('data-id') === state.focus.projectId);
        var groupState = state.groups.find(group => group.groupId === state.focus.groupId);
        if (!focusList || !focusProject || !groupState || !groupState.anchor) {
            return state;
        }
        groupState.anchor.itemKey = getProjectScrollItemKey(focusProject);
        groupState.anchor.itemOffset = focusProject.getBoundingClientRect().top
            - focusList.getBoundingClientRect().top;
        return state;
    }

    function findProjectsPanelGroup(groupId) {
        return Array.from(panels.projects.querySelectorAll('.group[data-group-id]'))
            .find(group => (group.getAttribute('data-group-id') || '') === groupId)
            || null;
    }

    function restoreProjectsPanelAnchors(state) {
        if (!state || !Array.isArray(state.groups) || !window.__agentPivotScrollState) {
            return;
        }
        state.groups.forEach(function (savedGroup) {
            if (!savedGroup.anchor) {
                return;
            }
            var group = findProjectsPanelGroup(savedGroup.groupId);
            var list = group && group.querySelector('.group-list');
            if (!list) {
                return;
            }
            window.__agentPivotScrollState.restore(list, savedGroup.anchor, {
                itemSelector: '.project[data-id]',
                getKey: getProjectScrollItemKey,
            });
        });
    }

    function restoreProjectsWindowScroll(state) {
        if (state && Number.isFinite(state.windowScrollY)) {
            window.scrollTo(0, state.windowScrollY);
        }
    }

    function restoreProjectsFocus(target) {
        if (!target || !panels.projects) {
            return;
        }
        var group = findProjectsPanelGroup(target.groupId || '');
        var project = group && Array.from(group.querySelectorAll('.project[data-id]'))
            .find(candidate => candidate.getAttribute('data-id') === target.projectId);
        if (!project) {
            return;
        }
        var focusTarget = project;
        if (target.action) {
            focusTarget = Array.from(project.querySelectorAll('[data-action]'))
                .find(candidate => candidate.getAttribute('data-action') === target.action);
        }
        if (focusTarget && typeof focusTarget.focus === 'function') {
            if (!focusTarget.getAttribute('tabindex')) {
                focusTarget.setAttribute('tabindex', '-1');
            }
            focusTarget.focus({ preventScroll: true });
        }
    }

    function replaceProjectsPanelHtml(html) {
        var panelState = captureProjectsPanelState();
        var replacementGeneration = ++projectsPanelReplacementGeneration;
        panels.projects.innerHTML = html;
        projectsState = 'mounted';
        if (typeof options.onProjectsMounted === 'function') {
            options.onProjectsMounted(panels.projects);
        }
        restoreProjectsPanelAnchors(panelState);
        restoreProjectsFocus(panelState.focus);
        restoreProjectsWindowScroll(panelState);
        requestAnimationFrame(() => {
            if (replacementGeneration !== projectsPanelReplacementGeneration) {
                return;
            }
            restoreProjectsPanelAnchors(panelState);
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
        if (message.mode === 'preserve-order' && isProjectsPanelOrderConsistent(message)) {
            projectsPanelReplacementGeneration += 1;
            return true;
        }
        replaceProjectsPanelHtml(message.html);
        return true;
    }

    function applyTodoPanelMessage(message) {
        if (!validateTodoPanelMessage(message)
            || todoState !== 'loading'
            || message.requestId !== todoRequestId
            || message.requestId <= acceptedTodoRequestId
            || !panels.todo) {
            return false;
        }

        acceptedTodoRequestId = message.requestId;
        if (todoRequestTimer !== null) {
            cancelTimeout(todoRequestTimer);
            todoRequestTimer = null;
        }
        todoRequestAttempts = 0;
        panels.todo.innerHTML = message.html;
        todoState = 'mounted';
        if (normalizeDashboardSearchCatalog(message.searchCatalog) === message.searchCatalog) {
            replaceSearchCatalog(message.searchCatalog);
        }
        if (typeof options.onTodoMounted === 'function') {
            options.onTodoMounted(panels.todo, message);
        }
        if (pendingScrollRestoreTab === 'todo') {
            pendingScrollRestoreTab = null;
            if (activeTab === 'todo' && !searchQuery) {
                restoreScroll('todo');
            }
        }
        revealPendingTodoSearchTarget();
        return true;
    }

    function applyTodoPanelUpdatedMessage(message) {
        if (!validateTodoPanelUpdatedMessage(message) || !panels.todo) {
            return false;
        }

        var activeElement = document.activeElement;
        var restoreShowCompletedFocus = !!activeElement
            && panels.todo.contains(activeElement)
            && activeElement.getAttribute('data-action') === 'todo-toggle-show-completed';
        var fallbackWindowScrollY = restoreShowCompletedFocus
            ? window.scrollY
            : null;
        if (todoRequestTimer !== null) {
            cancelTimeout(todoRequestTimer);
            todoRequestTimer = null;
        }
        todoRequestAttempts = 0;
        replaceSearchCatalog(message.searchCatalog);
        var refreshed = todoState === 'mounted'
            && message.snapshot
            && typeof options.onTodoRefresh === 'function'
            && options.onTodoRefresh(panels.todo, message) === true;
        if (!refreshed) {
            panels.todo.innerHTML = message.html;
            todoState = 'mounted';
            if (typeof options.onTodoMounted === 'function') {
                options.onTodoMounted(panels.todo, message);
            }
            if (restoreShowCompletedFocus) {
                var showCompletedToggle = panels.todo.querySelector(
                    '[data-action="todo-toggle-show-completed"]'
                );
                if (showCompletedToggle) {
                    showCompletedToggle.focus({ preventScroll: true });
                    if (Number.isFinite(fallbackWindowScrollY)) {
                        window.scrollTo(0, fallbackWindowScrollY);
                    }
                }
            }
        }
        revealPendingTodoSearchTarget();
        return true;
    }

    function failAiPanelMount(previousHtml) {
        if (aiRequestTimer !== null) {
            cancelTimeout(aiRequestTimer);
            aiRequestTimer = null;
        }
        panels.ai.innerHTML = previousHtml;
        aiState = 'unloaded';
        aiRequestAttempts = 0;
        showPanelUnavailable('ai');
        return false;
    }

    function getInstalledPromptSurface(message) {
        if (!panels.ai
            || typeof panels.ai.querySelectorAll !== 'function'
            || !message
            || !message.snapshot) {
            return null;
        }
        var surfaces = Array.from(panels.ai.querySelectorAll('[data-prompt-surface]'));
        if (surfaces.length !== 1 || typeof surfaces[0].getAttribute !== 'function') {
            return null;
        }
        var revisionValue = surfaces[0].getAttribute('data-prompt-revision');
        if (typeof revisionValue !== 'string' || !/^(0|[1-9]\d*)$/.test(revisionValue)) {
            return null;
        }
        var revision = Number(revisionValue);
        return Number.isSafeInteger(revision) && revision === message.snapshot.revision
            ? surfaces[0]
            : null;
    }

    function applyAiPanelMessage(message) {
        if (!validateAiPanelMessage(message)
            || aiState !== 'loading'
            || message.requestId !== aiRequestId
            || !panels.ai) {
            return false;
        }

        var previousHtml = panels.ai.innerHTML;
        try {
            panels.ai.innerHTML = message.html;
        } catch (_error) {
            return failAiPanelMount(previousHtml);
        }
        if (!getInstalledPromptSurface(message)
            || !window.__agentPivotPrompts
            || typeof window.__agentPivotPrompts.mount !== 'function') {
            return failAiPanelMount(previousHtml);
        }
        try {
            if (window.__agentPivotPrompts.mount(panels.ai, message) !== true) {
                return failAiPanelMount(previousHtml);
            }
        } catch (_error) {
            return failAiPanelMount(previousHtml);
        }
        if (aiRequestTimer !== null) {
            cancelTimeout(aiRequestTimer);
            aiRequestTimer = null;
        }
        aiRequestAttempts = 0;
        aiState = 'mounted';
        drainPendingPromptRefresh();
        applyPendingAiSubtab();
        applySkillAgentFilter();
        if (pendingSkillReveal) {
            var revealDir = pendingSkillReveal;
            pendingSkillReveal = null;
            revealSkillCard(revealDir);
        }
        if (pendingScrollRestoreTab === 'ai') {
            pendingScrollRestoreTab = null;
            if (activeTab === 'ai' && !searchQuery) {
                restoreScroll('ai');
            }
        }
        return true;
    }

    function applyPendingAiSubtab() {
        if (pendingAiSubtab !== 'prompts'
            || aiState !== 'mounted'
            || !panels.ai
            || typeof panels.ai.querySelector !== 'function') {
            return false;
        }
        var promptTab = panels.ai.querySelector('#ai-tab-prompts');
        if (!promptTab || typeof promptTab.click !== 'function') {
            return false;
        }
        pendingAiSubtab = null;
        promptTab.click();
        return true;
    }

    function applyPromptPanelUpdatedMessage(message) {
        if (!validatePromptPanelUpdatedMessage(message)) {
            return false;
        }
        if (aiState !== 'mounted') {
            if (pendingPromptRefresh
                && message.authoritySequence <= pendingPromptRefresh.authoritySequence) {
                return false;
            }
            pendingPromptRefresh = message;
            return true;
        }
        if (!window.__agentPivotPrompts
            || typeof window.__agentPivotPrompts.applyRefresh !== 'function') {
            return false;
        }
        return window.__agentPivotPrompts.applyRefresh(message) === true;
    }

    function drainPendingPromptRefresh() {
        var refresh = pendingPromptRefresh;
        pendingPromptRefresh = null;
        return refresh ? applyPromptPanelUpdatedMessage(refresh) : false;
    }

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
            applyProjectsPanelMessage(event.data);
        }
        if (event && event.data && event.data.type === 'projects-panel-updated') {
            if (validateProjectsPanelUpdatedMessage(event.data)
                && event.data.sequence <= acceptedProjectsUpdateSequence) {
                return;
            }
            if (!applyProjectsPanelUpdatedMessage(event.data)) {
                options.postMessage({
                    type: 'request-full-refresh',
                    reason: 'invalid-projects-panel-update',
                });
            }
        }
        if (event && event.data && event.data.type === 'todo-panel-content') {
            applyTodoPanelMessage(event.data);
        }
        if (event && event.data && event.data.type === 'todo-panel-updated') {
            applyTodoPanelUpdatedMessage(event.data);
        }
        if (event && event.data && event.data.type === 'ai-panel-content') {
            applyAiPanelMessage(event.data);
        }
        if (event && event.data && event.data.type === 'prompt-panel-updated') {
            applyPromptPanelUpdatedMessage(event.data);
        }
        if (event && event.data && event.data.type === 'skills-updated') {
            replaceSkillsHtml(event.data.html, event.data.settlement);
        }
        if (event && event.data && event.data.type === 'skill-scope-action-result') {
            settleSkillScopeActionWithoutHtml(event.data);
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
            pendingAiSubtab = 'prompts';
            activateTab('ai');
            applyPendingAiSubtab();
        }
    });
    if (searchResults) {
        searchResults.addEventListener('click', onSearchResultClick);
    }
    if (typeof document.addEventListener === 'function') {
        document.addEventListener('click', onSkillCardClick);
        document.addEventListener('keydown', onSkillMoveInputKeydown);
        document.addEventListener('keydown', onSkillFolderMenuKeydown);
        document.addEventListener('dragstart', onSkillDragStart);
        document.addEventListener('dragover', onSkillDragOver);
        document.addEventListener('dragleave', onSkillDragLeave);
        document.addEventListener('drop', onSkillDrop);
        document.addEventListener('dragend', onSkillDragEnd);
    }
    renderActiveTab();
    if (searchQuery) {
        renderSearchMode();
    } else if (activeTab === 'projects') {
        pendingScrollRestoreTab = 'projects';
        ensureProjectsPanel();
    } else if (activeTab === 'todo') {
        pendingScrollRestoreTab = 'todo';
        ensureTodoPanel();
    } else if (activeTab === 'ai') {
        pendingScrollRestoreTab = 'ai';
        ensureAiPanel();
    }
    document.body.classList.remove('preload');
    notifyActiveTabChanged();

    return {
        activateTab,
        applyProjectsPanelMessage,
        applyProjectsPanelUpdatedMessage,
        applyTodoPanelMessage,
        applyTodoPanelUpdatedMessage,
        applyAiPanelMessage,
        applyPromptPanelUpdatedMessage,
        ensureProjectsPanel,
        ensureTodoPanel,
        ensureAiPanel,
        getActiveTab: () => activeTab,
        getProjectsState: () => projectsState,
        getTodoState: () => todoState,
        getAiState: () => aiState,
        getScrollPosition: tab => scrollPositions[normalizeDashboardTab(tab)],
        isSearchActive: () => searchQuery.length > 0,
        replaceSearchCatalog,
        setSearchQuery,
    };
}
