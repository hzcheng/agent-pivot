function normalizeAiSessionTab(value) {
    return value === 'active' ? 'active' : 'sessions';
}

function normalizeAiSessionGrouping(value) {
    return value === 'worktree' ? 'worktree' : 'flat';
}

function readAiSessionGroupingState(vscodeApi) {
    var state = vscodeApi && typeof vscodeApi.getState === 'function' ? vscodeApi.getState() || {} : {};
    return state.aiSessionGrouping && typeof state.aiSessionGrouping === 'object'
        && !Array.isArray(state.aiSessionGrouping)
        ? Object.assign({}, state.aiSessionGrouping)
        : {};
}

function writeAiSessionGroupingState(vscodeApi, projectId, grouping) {
    if (!vscodeApi || typeof vscodeApi.setState !== 'function' || !projectId) return;
    var state = typeof vscodeApi.getState === 'function' ? vscodeApi.getState() || {} : {};
    var groupings = readAiSessionGroupingState(vscodeApi);
    groupings[projectId] = normalizeAiSessionGrouping(grouping);
    vscodeApi.setState(Object.assign({}, state, { aiSessionGrouping: groupings }));
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
}

function applyAiSessionGroupingDom(projectDiv, grouping, announce) {
    if (!projectDiv || typeof projectDiv.querySelector !== 'function') return 'flat';
    var section = projectDiv.querySelector('.codex-sessions');
    if (!section) return 'flat';
    var select = projectDiv.querySelector('[data-ai-session-grouping-select]');
    grouping = normalizeAiSessionGrouping(grouping);
    if (grouping === 'worktree' && !select) grouping = 'flat';
    section.setAttribute('data-ai-session-grouping', grouping);
    if (select) select.value = grouping;
    if (announce) {
        var liveRegion = projectDiv.querySelector('[data-ai-session-live-region]');
        if (liveRegion) {
            var count = new Set(Array.from(projectDiv.querySelectorAll(
                '.ai-session-worktree-group'
            )).map(getAiSessionWorktreeGroupKey)).size;
            liveRegion.textContent = grouping === 'worktree'
                ? 'Grouped AI sessions by ' + count + ' worktree' + (count === 1 ? '.' : 's.')
                : 'Showing a flat AI session list.';
        }
    }
    return grouping;
}

function restoreAiSessionGroupingFromState(projectDiv, vscodeApi) {
    if (!projectDiv) return 'flat';
    var projectId = projectDiv.getAttribute('data-id');
    var groupings = readAiSessionGroupingState(vscodeApi);
    var section = projectDiv.querySelector('.codex-sessions');
    var fallback = section && typeof section.getAttribute === 'function'
        ? section.getAttribute('data-default-ai-session-grouping') || 'flat'
        : 'flat';
    return applyAiSessionGroupingDom(
        projectDiv,
        Object.prototype.hasOwnProperty.call(groupings, projectId)
            ? groupings[projectId]
            : fallback,
        false
    );
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
        restoreAiSessionGroupingFromState(projectDiv, vscodeApi);
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
        '.codex-session-row[data-session-focused][data-session-provider][data-session-id]'
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
    var selectedTab = getSelectedAiSessionTab(projectDiv);
    selectAiSessionTabDom(projectDiv, 'active');
    var activeAnchor = captureAiSessionListAnchor(activeList);
    selectAiSessionTabDom(projectDiv, 'sessions');
    var historyAnchor = captureAiSessionListAnchor(historyList);
    selectAiSessionTabDom(projectDiv, selectedTab);
    return {
        selectedTab: selectedTab,
        activeAnchor: activeAnchor,
        historyAnchor: historyAnchor,
        pendingCount: projectDiv.querySelectorAll('.active-ai-session-row[data-session-pending]').length,
        activeCount: projectDiv.querySelectorAll('.active-ai-session-row[data-session-active]').length,
        restoreFocus: !!focusedInside,
        focusedSession: focusedSession,
        focusedTab: focusedTab && focusedTab.getAttribute('data-ai-session-tab'),
        focusedRow: focusedRow ? {
            provider: focusedRow.getAttribute('data-session-provider') || '',
            sessionId: focusedRow.getAttribute('data-session-id') || '',
            pendingCreatedAt: focusedRow.getAttribute('data-pending-created-at') || '',
            panel: focusedRow.closest('[data-ai-session-panel]')?.getAttribute('data-ai-session-panel') || '',
        } : null,
        grouping: projectDiv.querySelector('.codex-sessions')
            ?.getAttribute('data-ai-session-grouping') || 'flat',
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
    if (viewState.focusedTab) {
        var tabToFocus = Array.from(projectDiv.querySelectorAll('[data-ai-session-tab]'))
            .find(tab => tab.getAttribute('data-ai-session-tab') === viewState.focusedTab);
        (tabToFocus || selectedTab)?.focus({ preventScroll: true });
        return;
    }
    if (!viewState.focusedRow) return;
    var rows = Array.from(projectDiv.querySelectorAll('.codex-session-row'));
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
    applyAiSessionGroupingDom(projectDiv, viewState.grouping, false);
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
    selectAiSessionTabDom(projectDiv, 'active');
    restoreAiSessionListAnchor(activeList, viewState.activeAnchor);
    selectAiSessionTabDom(projectDiv, 'sessions');
    restoreAiSessionListAnchor(historyList, viewState.historyAnchor);
    var selectedTab = selectAiSessionTabDom(projectDiv, requestedTab || viewState.selectedTab);
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
            });
        });
    return states;
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
