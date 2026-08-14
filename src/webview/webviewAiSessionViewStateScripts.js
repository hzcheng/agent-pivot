function normalizeAiSessionTab(value) {
    return value === 'active' ? 'active' : 'sessions';
}

function normalizeAiSessionSurface(value) {
    return value === 'worktree' ? 'worktree' : 'chats';
}

function getAdjacentAiSessionSurface(surface, key) {
    surface = normalizeAiSessionSurface(surface);
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
        return surface === 'worktree' ? 'chats' : 'worktree';
    }
    if (key === 'Home') return 'worktree';
    if (key === 'End') return 'chats';
    return surface;
}

function readAiSessionSurfaceState(vscodeApi) {
    var state = vscodeApi && typeof vscodeApi.getState === 'function'
        ? vscodeApi.getState() || {}
        : {};
    return state.aiSessionSurfaces && typeof state.aiSessionSurfaces === 'object'
        && !Array.isArray(state.aiSessionSurfaces)
        ? Object.assign({}, state.aiSessionSurfaces)
        : {};
}

function writeAiSessionSurfaceState(vscodeApi, projectId, surface) {
    if (!vscodeApi || typeof vscodeApi.setState !== 'function' || !projectId) return;
    var state = typeof vscodeApi.getState === 'function' ? vscodeApi.getState() || {} : {};
    var surfaces = readAiSessionSurfaceState(vscodeApi);
    surfaces[projectId] = normalizeAiSessionSurface(surface);
    vscodeApi.setState(Object.assign({}, state, { aiSessionSurfaces: surfaces }));
}

function selectAiSessionSurfaceDom(projectDiv, surface) {
    if (!projectDiv || typeof projectDiv.querySelectorAll !== 'function') return null;
    surface = normalizeAiSessionSurface(surface);
    var sessionSection = projectDiv.querySelector('.codex-sessions');
    if (sessionSection && typeof sessionSection.setAttribute === 'function') {
        sessionSection.setAttribute('data-selected-ai-session-surface', surface);
    }
    var selectedTab = null;
    projectDiv.querySelectorAll('[data-ai-session-surface-tab]').forEach(tab => {
        var selected = tab.getAttribute('data-ai-session-surface-tab') === surface;
        tab.setAttribute('aria-selected', selected ? 'true' : 'false');
        tab.setAttribute('tabindex', selected ? '0' : '-1');
        if (selected) selectedTab = tab;
    });
    projectDiv.querySelectorAll('[data-ai-session-surface-panel]').forEach(panel => {
        panel.toggleAttribute(
            'hidden',
            panel.getAttribute('data-ai-session-surface-panel') !== surface
        );
    });
    return selectedTab;
}

function restoreAiSessionSurfaceFromState(projectDiv, vscodeApi) {
    if (!projectDiv) return null;
    var projectId = projectDiv.getAttribute('data-id');
    var surfaces = readAiSessionSurfaceState(vscodeApi);
    var section = projectDiv.querySelector('.codex-sessions');
    var fallback = section && typeof section.getAttribute === 'function'
        ? section.getAttribute('data-selected-ai-session-surface') || 'worktree'
        : 'worktree';
    return selectAiSessionSurfaceDom(
        projectDiv,
        Object.prototype.hasOwnProperty.call(surfaces, projectId)
            ? surfaces[projectId]
            : fallback
    );
}

function getSelectedAiSessionSurface(projectDiv) {
    if (!projectDiv || typeof projectDiv.querySelector !== 'function') return null;
    var selected = projectDiv.querySelector(
        '[data-ai-session-surface-tab][aria-selected="true"]'
    );
    return selected
        ? normalizeAiSessionSurface(selected.getAttribute('data-ai-session-surface-tab'))
        : null;
}

function readAiSessionWorktreeCollapseState(vscodeApi) {
    var state = vscodeApi && typeof vscodeApi.getState === 'function' ? vscodeApi.getState() || {} : {};
    return state.aiSessionCollapsedWorktrees
        && typeof state.aiSessionCollapsedWorktrees === 'object'
        && !Array.isArray(state.aiSessionCollapsedWorktrees)
        ? Object.assign({}, state.aiSessionCollapsedWorktrees)
        : {};
}

function getAiSessionWorktreeGroupKey(group) {
    // Reserved identities first: the anchor and manifest groups must never
    // collide with each other or with unmanaged rows on an empty
    // repository/path pair.
    if (group?.hasAttribute('data-worktree-anchor')) {
        return '["__anchor__"]';
    }
    var groupId = group?.getAttribute('data-group-id');
    if (groupId) {
        return JSON.stringify(['group', groupId]);
    }
    return JSON.stringify([
        group?.getAttribute('data-worktree-repository-key') || '',
        group?.getAttribute('data-worktree-path') || '',
        !!group?.hasAttribute('data-worktree-unmanaged'),
    ]);
}

function writeAiSessionWorktreeCollapseState(vscodeApi, projectDiv) {
    if (!vscodeApi || typeof vscodeApi.setState !== 'function' || !projectDiv) return;
    var projectId = projectDiv.getAttribute('data-id');
    if (!projectId) return;
    var state = typeof vscodeApi.getState === 'function' ? vscodeApi.getState() || {} : {};
    var projects = readAiSessionWorktreeCollapseState(vscodeApi);
    projects[projectId] = Array.from(new Set(Array.from(projectDiv.querySelectorAll(
        '.ai-session-worktree-group[data-worktree-collapsed]'
    )).map(getAiSessionWorktreeGroupKey)));
    vscodeApi.setState(Object.assign({}, state, { aiSessionCollapsedWorktrees: projects }));
    syncAiSessionWorktreeCollapseAllButton(projectDiv);
}

// The collapse-all affordance acts like every group toggle at once: any
// expanded group collapses everything, otherwise everything expands.
function toggleAllAiSessionWorktrees(projectDiv) {
    if (!projectDiv || typeof projectDiv.querySelectorAll !== 'function') return;
    var groups = Array.from(projectDiv.querySelectorAll('.ai-session-worktree-group'));
    if (!groups.length) return;
    var anyExpanded = groups.some(group => !group.hasAttribute('data-worktree-collapsed'));
    groups.forEach(group => {
        setAiSessionWorktreeExpanded(
            group.querySelector('.ai-session-worktree-header'),
            !anyExpanded
        );
    });
    writeAiSessionWorktreeCollapseState(window.vscode, projectDiv);
}

function syncAiSessionWorktreeCollapseAllButton(projectDiv) {
    if (!projectDiv || typeof projectDiv.querySelector !== 'function') return;
    var button = projectDiv.querySelector('[data-action="toggle-all-ai-session-worktrees"]');
    if (!button) return;
    var anyExpanded = Array.from(projectDiv.querySelectorAll('.ai-session-worktree-group'))
        .some(group => !group.hasAttribute('data-worktree-collapsed'));
    button.setAttribute('data-collapse-all-state', anyExpanded ? 'expanded' : 'collapsed');
    var label = anyExpanded ? 'Collapse all worktrees' : 'Expand all worktrees';
    button.setAttribute('aria-label', label);
    button.setAttribute('data-tooltip', label);
}

function setAiSessionWorktreeExpanded(header, expanded) {
    if (!header) return false;
    var group = header.closest('.ai-session-worktree-group');
    if (!group) return false;
    expanded = expanded !== false;
    header.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    group.toggleAttribute('data-worktree-collapsed', !expanded);
    var list = group.querySelector('.ai-session-worktree-session-list');
    if (list) list.toggleAttribute('hidden', !expanded);
    return true;
}

function setAiSessionWorktreeGroupExpanded(projectDiv, group, expanded) {
    if (!projectDiv || !group) return false;
    var key = getAiSessionWorktreeGroupKey(group);
    var changed = false;
    projectDiv.querySelectorAll('.ai-session-worktree-group').forEach(candidate => {
        if (getAiSessionWorktreeGroupKey(candidate) !== key) return;
        changed = setAiSessionWorktreeExpanded(
            candidate.querySelector('.ai-session-worktree-header'),
            expanded
        ) || changed;
    });
    return changed;
}

function restoreAiSessionWorktreeCollapseState(projectDiv, vscodeApi) {
    if (!projectDiv) return;
    var projectId = projectDiv.getAttribute('data-id');
    var projects = readAiSessionWorktreeCollapseState(vscodeApi);
    var collapsed = new Set(Array.isArray(projects[projectId]) ? projects[projectId] : []);
    projectDiv.querySelectorAll('.ai-session-worktree-group').forEach(group => {
        setAiSessionWorktreeExpanded(
            group.querySelector('.ai-session-worktree-header'),
            !collapsed.has(getAiSessionWorktreeGroupKey(group))
        );
    });
    syncAiSessionWorktreeCollapseAllButton(projectDiv);
}

function parseAiSessionConversationFocusOrigin(message) {
    var expectedKeys = [
        'type',
        'version',
        'projectId',
        'provider',
        'sessionId',
        'interactionId',
    ];
    if (!message || typeof message !== 'object' || Array.isArray(message)
        || Object.keys(message).length !== expectedKeys.length
        || !expectedKeys.every(key =>
            Object.prototype.hasOwnProperty.call(message, key))
        || message.type !== 'focus-ai-session-conversation-origin'
        || message.version !== 1
        || (message.provider !== 'codex'
            && message.provider !== 'kimi'
            && message.provider !== 'claude')
        || !['projectId', 'sessionId', 'interactionId'].every(key =>
            typeof message[key] === 'string' && message[key].trim())) {
        return null;
    }
    return message;
}

function parseAiSessionRevealRequest(message) {
    var expectedKeys = ['projectId', 'provider', 'sessionId', 'type', 'version'];
    if (!message || typeof message !== 'object' || Array.isArray(message)
        || Object.keys(message).length !== expectedKeys.length
        || !expectedKeys.every(key =>
            Object.prototype.hasOwnProperty.call(message, key))
        || message.type !== 'reveal-ai-session-requested'
        || message.version !== 1
        || (message.provider !== 'codex'
            && message.provider !== 'kimi'
            && message.provider !== 'claude')
        || !['projectId', 'sessionId'].every(key =>
            typeof message[key] === 'string' && message[key].trim())) {
        return null;
    }
    return message;
}

// Session-switch commands land here: the view follows the switched session
// to wherever it lives — its worktree group (expanded, scrolled into view)
// or the Chats active list. Scroll-only; keyboard focus stays put.
function revealAiSessionInWorkspace(message) {
    var request = parseAiSessionRevealRequest(message);
    if (!request || typeof document === 'undefined'
        || typeof document.querySelectorAll !== 'function') {
        return false;
    }
    var projectDiv = Array.from(document.querySelectorAll(
        '.workspace-card[data-current-workspace][data-id]'
    )).find(candidate =>
        candidate.getAttribute('data-id') === request.projectId
    );
    if (!projectDiv) {
        return false;
    }
    var rowSelector = '[data-session-provider][data-session-id]';
    var matches = candidate =>
        candidate.getAttribute('data-session-provider') === request.provider
        && candidate.getAttribute('data-session-id') === request.sessionId;
    var worktreeRow = Array.from(projectDiv.querySelectorAll(
        '[data-ai-session-surface-panel="worktree"] ' + rowSelector
    )).find(matches);
    var surface = worktreeRow ? 'worktree' : 'chats';
    selectAiSessionSurfaceDom(projectDiv, surface);
    writeAiSessionSurfaceState(window.vscode, request.projectId, surface);
    if (window.vscode && typeof window.vscode.postMessage === 'function') {
        window.vscode.postMessage({
            type: 'select-ai-session-surface',
            version: 1,
            projectId: request.projectId,
            surface: surface,
        });
    }
    if (worktreeRow) {
        var group = worktreeRow.closest('.ai-session-worktree-group');
        if (group) {
            setAiSessionWorktreeGroupExpanded(projectDiv, group, true);
            writeAiSessionWorktreeCollapseState(window.vscode, projectDiv);
        }
        worktreeRow.scrollIntoView({ block: 'nearest' });
        return true;
    }
    selectAiSessionTabDom(projectDiv, 'active');
    writeAiSessionTabState(window.vscode, request.projectId, 'active');
    var activeRow = Array.from(projectDiv.querySelectorAll(
        '.active-ai-session-row' + rowSelector
    )).find(matches) || Array.from(projectDiv.querySelectorAll(
        '[data-ai-session-surface-panel="chats"] ' + rowSelector
    )).find(matches);
    if (activeRow) {
        activeRow.scrollIntoView({ block: 'nearest' });
        return true;
    }
    return false;
}

function focusAiSessionConversationOrigin(message) {
    var origin = parseAiSessionConversationFocusOrigin(message);
    if (!origin || typeof document === 'undefined'
        || typeof document.querySelectorAll !== 'function') {
        return false;
    }
    var projectDiv = Array.from(document.querySelectorAll(
        '.workspace-card[data-current-workspace][data-id]'
    )).find(candidate =>
        candidate.getAttribute('data-id') === origin.projectId
    );
    if (!projectDiv) {
        return false;
    }
    selectAiSessionSurfaceDom(projectDiv, 'chats');
    writeAiSessionSurfaceState(window.vscode, origin.projectId, 'chats');
    if (window.vscode && typeof window.vscode.postMessage === 'function') {
        window.vscode.postMessage({
            type: 'select-ai-session-surface',
            version: 1,
            projectId: origin.projectId,
            surface: 'chats',
        });
    }
    selectAiSessionTabDom(projectDiv, 'active');
    writeAiSessionTabState(window.vscode, origin.projectId, 'active');
    var row = Array.from(projectDiv.querySelectorAll(
        '.active-ai-session-row[data-session-focused]'
        + '[data-session-provider][data-session-id]'
    )).find(candidate =>
        candidate.getAttribute('data-session-provider') === origin.provider
        && candidate.getAttribute('data-session-id') === origin.sessionId
    );
    if (row) {
        var header = row.querySelector('.ai-session-primary-action');
        if (header && typeof header.focus === 'function') {
            header.focus({ preventScroll: true });
        }
        row.scrollIntoView({ block: 'nearest' });
        if (header && document.activeElement === header) {
            return true;
        }
    }
    var activeTab = Array.from(projectDiv.querySelectorAll(
        '[data-ai-session-tab]'
    )).find(candidate =>
        candidate.getAttribute('data-ai-session-tab') === 'active'
    );
    if (activeTab && typeof activeTab.focus === 'function') {
        activeTab.focus({ preventScroll: true });
        return document.activeElement === activeTab;
    }
    return false;
}

function getAdjacentAiSessionTab(tab, key) {
    tab = normalizeAiSessionTab(tab);
    if (key === 'ArrowLeft' || key === 'ArrowRight') return tab === 'active' ? 'sessions' : 'active';
    if (key === 'Home') return 'active';
    if (key === 'End') return 'sessions';
    return tab;
}

function readAiSessionTabState(vscodeApi) {
    var state = vscodeApi && typeof vscodeApi.getState === 'function' ? vscodeApi.getState() || {} : {};
    return state.aiSessionTabs && typeof state.aiSessionTabs === 'object' && !Array.isArray(state.aiSessionTabs)
        ? Object.assign({}, state.aiSessionTabs)
        : {};
}

function writeAiSessionTabState(vscodeApi, projectId, tab) {
    if (!vscodeApi || typeof vscodeApi.setState !== 'function' || !projectId) return;
    var state = typeof vscodeApi.getState === 'function' ? vscodeApi.getState() || {} : {};
    var tabs = readAiSessionTabState(vscodeApi);
    tabs[projectId] = normalizeAiSessionTab(tab);
    vscodeApi.setState(Object.assign({}, state, { aiSessionTabs: tabs }));
}

function selectAiSessionTabDom(projectDiv, tab) {
    if (!projectDiv || typeof projectDiv.querySelectorAll !== 'function') return null;
    tab = normalizeAiSessionTab(tab);
    var sessionSection = projectDiv.querySelector('.codex-sessions');
    if (sessionSection && typeof sessionSection.setAttribute === 'function') {
        sessionSection.setAttribute('data-selected-ai-session-tab', tab);
    }
    var selectedTab = null;
    projectDiv.querySelectorAll('[data-ai-session-tab]').forEach(tabElement => {
        var selected = tabElement.getAttribute('data-ai-session-tab') === tab;
        tabElement.setAttribute('aria-selected', selected ? 'true' : 'false');
        tabElement.setAttribute('tabindex', selected ? '0' : '-1');
        if (selected) selectedTab = tabElement;
    });
    projectDiv.querySelectorAll('[data-ai-session-panel]').forEach(panel => {
        var selected = panel.getAttribute('data-ai-session-panel') === tab;
        panel.toggleAttribute('hidden', !selected);
    });
    return selectedTab;
}

function restoreAiSessionTabsFromState(root, vscodeApi) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    var tabs = readAiSessionTabState(vscodeApi);
    root.querySelectorAll('.workspace-card[data-current-workspace][data-id]').forEach(projectDiv => {
        var projectId = projectDiv.getAttribute('data-id');
        if (Object.prototype.hasOwnProperty.call(tabs, projectId)) {
            selectAiSessionTabDom(projectDiv, tabs[projectId]);
        }
        restoreAiSessionSurfaceFromState(projectDiv, vscodeApi);
        restoreAiSessionWorktreeCollapseState(projectDiv, vscodeApi);
    });
}

function getSelectedAiSessionTab(projectDiv) {
    if (!projectDiv || typeof projectDiv.querySelector !== 'function') return null;
    var selected = projectDiv.querySelector('[data-ai-session-tab][aria-selected="true"]');
    return selected ? normalizeAiSessionTab(selected.getAttribute('data-ai-session-tab')) : null;
}

function getAiSessionScrollItemKey(row) {
    var panel = row.closest('[data-ai-session-panel]');
    return JSON.stringify([
        panel ? panel.getAttribute('data-ai-session-panel') || '' : '',
        row.getAttribute('data-session-provider') || '',
        row.getAttribute('data-session-id') || '',
        row.getAttribute('data-pending-created-at') || '',
    ]);
}

function captureAiSessionListAnchor(list) {
    return window.__agentPivotScrollState.capture(list, {
        itemSelector: '.codex-session-row',
        getKey: getAiSessionScrollItemKey,
    });
}

function restoreAiSessionListAnchor(list, anchor) {
    return window.__agentPivotScrollState.restore(list, anchor, {
        itemSelector: '.codex-session-row',
        getKey: getAiSessionScrollItemKey,
    });
}

function getFocusedAiSessionCardIdentity(projectDiv) {
    if (!projectDiv || typeof projectDiv.querySelector !== 'function') return null;
    var row = projectDiv.querySelector(
        '.ai-session-chats-surface .codex-session-row'
        + '[data-session-focused][data-session-provider][data-session-id]'
    );
    return row ? {
        provider: row.getAttribute('data-session-provider') || '',
        sessionId: row.getAttribute('data-session-id') || '',
    } : null;
}

function captureAiSessionViewState(projectDiv) {
    var activeList = projectDiv.querySelector('.ai-session-active-panel .codex-sessions-list');
    var historyList = projectDiv.querySelector('.ai-session-history-panel .codex-sessions-list');
    var focused = typeof document !== 'undefined' ? document.activeElement : null;
    var focusedSession = getFocusedAiSessionCardIdentity(projectDiv);
    var focusedInside = focused && typeof focused.closest === 'function' && focused.closest('.project[data-id]') === projectDiv;
    var focusedRow = focusedInside ? focused.closest('.codex-session-row') : null;
    var focusedTab = focusedInside ? focused.closest('[data-ai-session-tab]') : null;
    var focusedSurfaceTab = focusedInside
        ? focused.closest('[data-ai-session-surface-tab]')
        : null;
    var selectedTab = getSelectedAiSessionTab(projectDiv);
    var selectedSurface = getSelectedAiSessionSurface(projectDiv);
    selectAiSessionSurfaceDom(projectDiv, 'chats');
    selectAiSessionTabDom(projectDiv, 'active');
    var activeAnchor = captureAiSessionListAnchor(activeList);
    selectAiSessionTabDom(projectDiv, 'sessions');
    var historyAnchor = captureAiSessionListAnchor(historyList);
    selectAiSessionTabDom(projectDiv, selectedTab);
    selectAiSessionSurfaceDom(projectDiv, selectedSurface);
    return {
        selectedSurface: selectedSurface,
        selectedTab: selectedTab,
        activeAnchor: activeAnchor,
        historyAnchor: historyAnchor,
        pendingCount: projectDiv.querySelectorAll('.active-ai-session-row[data-session-pending]').length,
        activeCount: projectDiv.querySelectorAll('.active-ai-session-row[data-session-active]').length,
        restoreFocus: !!focusedInside,
        focusedSession: focusedSession,
        focusedTab: focusedTab && focusedTab.getAttribute('data-ai-session-tab'),
        focusedSurfaceTab: focusedSurfaceTab
            && focusedSurfaceTab.getAttribute('data-ai-session-surface-tab'),
        focusedRow: focusedRow ? {
            provider: focusedRow.getAttribute('data-session-provider') || '',
            sessionId: focusedRow.getAttribute('data-session-id') || '',
            pendingCreatedAt: focusedRow.getAttribute('data-pending-created-at') || '',
            panel: focusedRow.closest('[data-ai-session-panel]')?.getAttribute('data-ai-session-panel') || '',
        } : null,
        collapsedWorktrees: Array.from(projectDiv.querySelectorAll(
            '.ai-session-worktree-group[data-worktree-collapsed]'
        )).map(getAiSessionWorktreeGroupKey),
        worktreeKeys: Array.from(new Set(Array.from(projectDiv.querySelectorAll(
            '.ai-session-worktree-group'
        )).map(getAiSessionWorktreeGroupKey))),
    };
}

function restoreAiSessionViewFocus(projectDiv, viewState, selectedTab) {
    if (!viewState || !viewState.restoreFocus) return;
    if (viewState.focusedSurfaceTab) {
        var surfaceTabToFocus = Array.from(projectDiv.querySelectorAll(
            '[data-ai-session-surface-tab]'
        )).find(tab =>
            tab.getAttribute('data-ai-session-surface-tab') === viewState.focusedSurfaceTab
        );
        surfaceTabToFocus?.focus({ preventScroll: true });
        return;
    }
    if (viewState.focusedTab) {
        var tabToFocus = Array.from(projectDiv.querySelectorAll('[data-ai-session-tab]'))
            .find(tab => tab.getAttribute('data-ai-session-tab') === viewState.focusedTab);
        (tabToFocus || selectedTab)?.focus({ preventScroll: true });
        return;
    }
    if (!viewState.focusedRow) return;
    var rows = Array.from(projectDiv.querySelectorAll(
        '.ai-session-chats-surface .codex-session-row'
    ));
    var match = rows.find(row => {
        var panel = row.closest('[data-ai-session-panel]');
        return (row.getAttribute('data-session-provider') || '') === viewState.focusedRow.provider
            && (row.getAttribute('data-session-id') || '') === viewState.focusedRow.sessionId
            && (row.getAttribute('data-pending-created-at') || '') === viewState.focusedRow.pendingCreatedAt
            && (!viewState.focusedRow.panel || panel?.getAttribute('data-ai-session-panel') === viewState.focusedRow.panel);
    });
    (match?.querySelector('.ai-session-primary-action') || selectedTab)?.focus({ preventScroll: true });
}

function restoreAiSessionViewState(projectDiv, viewState, requestedTab, options) {
    if (!projectDiv || !viewState) return null;
    var collapsed = new Set(viewState.collapsedWorktrees || []);
    projectDiv.querySelectorAll('.ai-session-worktree-group').forEach(group => {
        var key = getAiSessionWorktreeGroupKey(group);
        setAiSessionWorktreeExpanded(
            group.querySelector('.ai-session-worktree-header'),
            !collapsed.has(key)
        );
    });
    var currentWorktreeKeys = Array.from(new Set(Array.from(projectDiv.querySelectorAll(
        '.ai-session-worktree-group'
    )).map(getAiSessionWorktreeGroupKey)));
    if (Array.isArray(viewState.worktreeKeys)
        && JSON.stringify(viewState.worktreeKeys) !== JSON.stringify(currentWorktreeKeys)) {
        var liveRegion = projectDiv.querySelector('[data-ai-session-live-region]');
        if (liveRegion) {
            liveRegion.textContent = 'Worktree list updated. ' + currentWorktreeKeys.length
                + ' worktree' + (currentWorktreeKeys.length === 1 ? ' shown.' : 's shown.');
        }
    }
    var activeList = projectDiv.querySelector('.ai-session-active-panel .codex-sessions-list');
    var historyList = projectDiv.querySelector('.ai-session-history-panel .codex-sessions-list');
    selectAiSessionSurfaceDom(projectDiv, 'chats');
    selectAiSessionTabDom(projectDiv, 'active');
    restoreAiSessionListAnchor(activeList, viewState.activeAnchor);
    selectAiSessionTabDom(projectDiv, 'sessions');
    restoreAiSessionListAnchor(historyList, viewState.historyAnchor);
    var selectedTab = selectAiSessionTabDom(projectDiv, requestedTab || viewState.selectedTab);
    selectAiSessionSurfaceDom(projectDiv, viewState.selectedSurface);
    if (!options || options.restoreFocus !== false) {
        restoreAiSessionViewFocus(projectDiv, viewState, selectedTab);
    }
    return selectedTab;
}

function revealChangedFocusedAiSessionCard(root, states) {
    if (!root || typeof root.querySelectorAll !== 'function'
        || !states || typeof states.get !== 'function') return;
    root.querySelectorAll('.workspace-card[data-current-workspace][data-id]').forEach(projectDiv => {
        var state = states.get(projectDiv.getAttribute('data-id'));
        var previous = state && state.view ? state.view.focusedSession : null;
        var row = projectDiv.querySelector(
            '.ai-session-active-panel .codex-session-row[data-session-focused]'
            + '[data-session-provider][data-session-id]'
        );
        if (!row) return;
        var provider = row.getAttribute('data-session-provider') || '';
        var sessionId = row.getAttribute('data-session-id') || '';
        if (previous && previous.provider === provider && previous.sessionId === sessionId) {
            return;
        }
        // Session focus moved to this card during the authoritative refresh:
        // surface it instead of preserving the stale scroll position.
        var panel = row.closest('[data-ai-session-panel]');
        if (panel && panel.hidden) {
            selectAiSessionSurfaceDom(projectDiv, 'chats');
            writeAiSessionSurfaceState(
                window.vscode,
                projectDiv.getAttribute('data-id'),
                'chats'
            );
            selectAiSessionTabDom(projectDiv, 'active');
            writeAiSessionTabState(window.vscode, projectDiv.getAttribute('data-id'), 'active');
        }
        row.scrollIntoView({ block: 'nearest' });
    });
}

function captureAiSessionProviderMenuState(projectDiv) {
    if (!projectDiv || typeof projectDiv.querySelector !== 'function') {
        return { open: false, focus: null };
    }
    var trigger = projectDiv.querySelector('[data-ai-provider-menu-trigger]');
    var menu = projectDiv.querySelector('[data-ai-provider-menu]');
    var focused = typeof document !== 'undefined' ? document.activeElement : null;
    var focusedTrigger = focused === trigger;
    var focusedOption = focused && typeof focused.closest === 'function'
        ? focused.closest('[data-ai-provider-option][data-provider]')
        : null;
    return {
        open: !!trigger && !!menu
            && trigger.getAttribute('aria-expanded') === 'true'
            && !menu.hidden,
        focus: focusedTrigger
            ? { kind: 'trigger' }
            : focusedOption && focusedOption.closest('.project[data-id]') === projectDiv
                ? {
                    kind: 'option',
                    provider: focusedOption.getAttribute('data-provider') || '',
                }
                : null,
    };
}

function restoreAiSessionProviderMenuState(projectDiv, menuState, allowed) {
    if (!allowed || !menuState || !menuState.open) {
        return;
    }
    var trigger = projectDiv.querySelector('[data-ai-provider-menu-trigger]');
    var menu = projectDiv.querySelector('[data-ai-provider-menu]');
    if (!trigger || !menu) {
        return;
    }
    trigger.setAttribute('aria-expanded', 'true');
    menu.hidden = false;
    if (menuState.focus?.kind === 'trigger') {
        trigger.focus({ preventScroll: true });
        return;
    }
    if (menuState.focus?.kind !== 'option') {
        return;
    }
    var option = Array.from(
        projectDiv.querySelectorAll('[data-ai-provider-option][data-provider]')
    ).find(candidate =>
        candidate.getAttribute('data-provider') === menuState.focus.provider
    );
    option?.focus({ preventScroll: true });
}

function captureCurrentWorkspaceAiSessionStates(root) {
    var states = new Map();
    if (!root || typeof root.querySelectorAll !== 'function') return states;
    root.querySelectorAll('.workspace-card[data-current-workspace][data-id]')
        .forEach(projectDiv => {
            var projectId = projectDiv.getAttribute('data-id');
            if (!projectId) return;
            states.set(projectId, {
                view: captureAiSessionViewState(projectDiv),
                providerMenu: captureAiSessionProviderMenuState(projectDiv),
                listScrolls: captureAiSessionListScrolls(projectDiv),
            });
        });
    return states;
}

// The worktree/chats panels scroll independently of the outer workspace
// list, so an authoritative HTML replacement must carry each inner list's
// scroll position across the new nodes; otherwise every refresh snaps the
// panel back to the top.
function captureAiSessionListScrolls(projectDiv) {
    var scrolls = [];
    projectDiv.querySelectorAll(
        '[data-ai-session-surface-panel] .ai-session-worktree-list,'
        + ' [data-ai-session-panel] .codex-sessions-list'
    ).forEach(list => {
        var panel = list.closest('[data-ai-session-surface-panel], [data-ai-session-panel]');
        if (!panel) return;
        var key = panel.getAttribute('data-ai-session-surface-panel')
            || panel.getAttribute('data-ai-session-panel');
        var scrollTop = Math.max(0, Number(list.scrollTop) || 0);
        if (key && scrollTop > 0) {
            scrolls.push({ key: key, scrollTop: scrollTop });
        }
    });
    return scrolls;
}

function restoreAiSessionListScrolls(projectDiv, scrolls) {
    (scrolls || []).forEach(saved => {
        var panel = projectDiv.querySelector(
            '[data-ai-session-surface-panel="' + saved.key + '"],'
            + ' [data-ai-session-panel="' + saved.key + '"]'
        );
        var list = panel
            ? panel.querySelector('.ai-session-worktree-list, .codex-sessions-list')
            : null;
        if (!list) return;
        var maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
        list.scrollTop = Math.min(saved.scrollTop, maxScrollTop);
    });
}

function restoreCurrentWorkspaceAiSessionViewStates(root, states, canRestoreProviderMenu) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    root.querySelectorAll('.workspace-card[data-current-workspace][data-id]')
        .forEach(projectDiv => {
            var projectId = projectDiv.getAttribute('data-id');
            var state = states.get(projectId);
            if (!state) return;
            restoreAiSessionViewState(projectDiv, state.view, state.view.selectedTab, {
                restoreFocus: false,
            });
            restoreAiSessionListScrolls(projectDiv, state.listScrolls);
            restoreAiSessionProviderMenuState(
                projectDiv,
                state.providerMenu,
                !canRestoreProviderMenu || canRestoreProviderMenu(projectId)
            );
        });
}

function restoreCurrentWorkspaceAiSessionAnchorsAndFocus(root, states) {
    if (!root || typeof root.querySelectorAll !== 'function') return;
    root.querySelectorAll('.workspace-card[data-current-workspace][data-id]')
        .forEach(projectDiv => {
            var state = states.get(projectDiv.getAttribute('data-id'));
            if (!state) return;
            var selectedTab = restoreAiSessionViewState(
                projectDiv,
                state.view,
                state.view.selectedTab,
                { restoreFocus: false }
            );
            restoreAiSessionViewFocus(projectDiv, state.view, selectedTab);
        });
}
