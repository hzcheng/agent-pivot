// M2: the tab domain is CHATS (active set, tree view) / ALL (全部 session).
// Legacy values map onto it ('active' → chats, 'sessions' → all) so pre-M2
// webview state keeps steering the boot import instead of being dropped.
function normalizeAiSessionTab(value) {
    if (value === 'chats' || value === 'all') return value;
    if (value === 'sessions') return 'all';
    return 'chats';
}

function getAdjacentAiSessionTab(tab, key) {
    tab = normalizeAiSessionTab(tab);
    if (key === 'ArrowLeft' || key === 'ArrowRight') return tab === 'chats' ? 'all' : 'chats';
    if (key === 'Home') return 'chats';
    if (key === 'End') return 'all';
    return tab;
}

function readAiSessionWorktreeCollapseState(vscodeApi) {
    var state = vscodeApi && typeof vscodeApi.getState === 'function' ? vscodeApi.getState() || {} : {};
    return state.aiSessionCollapsedWorktrees
        && typeof state.aiSessionCollapsedWorktrees === 'object'
        && !Array.isArray(state.aiSessionCollapsedWorktrees)
        ? Object.assign({}, state.aiSessionCollapsedWorktrees)
        : {};
}

function readAiSessionMemberDetailsState(vscodeApi) {
    var state = vscodeApi && typeof vscodeApi.getState === 'function' ? vscodeApi.getState() || {} : {};
    return state.aiSessionExpandedGroupMembers
        && typeof state.aiSessionExpandedGroupMembers === 'object'
        && !Array.isArray(state.aiSessionExpandedGroupMembers)
        ? Object.assign({}, state.aiSessionExpandedGroupMembers)
        : {};
}

// M3: the member summary toggles per-member details (PRD §10). Expansion is
// transient view state — preserved across reloads and authoritative
// replacements exactly like the group collapse state.
function setWorktreeGroupMemberDetailsExpanded(group, expanded) {
    if (!group) return false;
    var toggle = group.querySelector('[data-action="toggle-group-member-details"]');
    var details = group.querySelector('.ai-session-worktree-member-details');
    if (!toggle || !details) return false;
    expanded = expanded !== false;
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    // Keep the accessible name honest about what the toggle will do next.
    var label = expanded
        ? toggle.getAttribute('data-label-collapse')
        : toggle.getAttribute('data-label-expand');
    if (label) {
        toggle.setAttribute('aria-label', label);
    }
    group.toggleAttribute('data-member-details-expanded', expanded);
    details.toggleAttribute('hidden', !expanded);
    return true;
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
    var memberDetails = readAiSessionMemberDetailsState(vscodeApi);
    memberDetails[projectId] = Array.from(new Set(Array.from(projectDiv.querySelectorAll(
        '.ai-session-worktree-group[data-member-details-expanded]'
    )).map(getAiSessionWorktreeGroupKey)));
    vscodeApi.setState(Object.assign({}, state, {
        aiSessionCollapsedWorktrees: projects,
        aiSessionExpandedGroupMembers: memberDetails,
    }));
    // M2 transition: mirror the collapsed set into the host-persisted window
    // view state so the PR-D tree view restores it across reloads. Every
    // caller is a user-intent path (toggle / collapse-all / reveal-expand),
    // never a replacement replay, so this posts exactly once per gesture.
    if (typeof vscodeApi.postMessage === 'function') {
        vscodeApi.postMessage({
            type: 'set-ai-session-collapsed-worktree-groups',
            version: 1,
            projectId: projectId,
            collapsedKeys: projects[projectId],
        });
    }
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
    var memberDetails = readAiSessionMemberDetailsState(vscodeApi);
    var expandedMembers = new Set(
        Array.isArray(memberDetails[projectId]) ? memberDetails[projectId] : []);
    projectDiv.querySelectorAll('.ai-session-worktree-group[data-group-id]').forEach(group => {
        if (expandedMembers.has(getAiSessionWorktreeGroupKey(group))) {
            setWorktreeGroupMemberDetailsExpanded(group, true);
        }
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
        '[data-open-session-surface][data-current-workspace][data-id]'
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
    // M2: every session lives in CHATS (tree) or ALL — probe the tree first,
    // then the ALL list; the view follows the session's actual home.
    var treeRow = Array.from(projectDiv.querySelectorAll(
        '[data-ai-session-panel="chats"] ' + rowSelector
    )).find(matches);
    if (!treeRow) {
        var allRow = Array.from(projectDiv.querySelectorAll(
            '[data-ai-session-panel="all"] ' + rowSelector
        )).find(matches);
        if (!allRow) {
            return false;
        }
        selectAiSessionTabDom(projectDiv, 'all');
        writeAiSessionTabState(window.vscode, request.projectId, 'all');
        postSelectedAiSessionViewTab(request.projectId, 'all');
        allRow.scrollIntoView({ block: 'nearest' });
        return true;
    }
    selectAiSessionTabDom(projectDiv, 'chats');
    writeAiSessionTabState(window.vscode, request.projectId, 'chats');
    postSelectedAiSessionViewTab(request.projectId, 'chats');
    var group = treeRow.closest('.ai-session-worktree-group');
    if (group) {
        setAiSessionWorktreeGroupExpanded(projectDiv, group, true);
        writeAiSessionWorktreeCollapseState(window.vscode, projectDiv);
    }
    treeRow.scrollIntoView({ block: 'nearest' });
    return true;
}

function focusAiSessionConversationOrigin(message) {
    var origin = parseAiSessionConversationFocusOrigin(message);
    if (!origin || typeof document === 'undefined'
        || typeof document.querySelectorAll !== 'function') {
        return false;
    }
    var projectDiv = Array.from(document.querySelectorAll(
        '[data-open-session-surface][data-current-workspace][data-id]'
    )).find(candidate =>
        candidate.getAttribute('data-id') === origin.projectId
    );
    if (!projectDiv) {
        return false;
    }
    var rowSelector = '[data-session-provider][data-session-id]';
    var matches = candidate =>
        candidate.getAttribute('data-session-provider') === origin.provider
        && candidate.getAttribute('data-session-id') === origin.sessionId;
    // The view follows the session to the tab it lives on (same probe as
    // revealAiSessionInWorkspace): closing a conversation must not yank the
    // visible tab away from the session's home.
    var treeRow = Array.from(projectDiv.querySelectorAll(
        '[data-ai-session-panel="chats"] ' + rowSelector
    )).find(matches);
    var allRow = treeRow ? null : Array.from(projectDiv.querySelectorAll(
        '[data-ai-session-panel="all"] ' + rowSelector
    )).find(matches);
    // A stale origin (session gone from both panels) falls back to CHATS —
    // the legacy ACTIVE-tab fallback's M2 home (PRD 单击语义: 空操作不迁移视图则留在主 tab)。
    var tab = treeRow ? 'chats' : allRow ? 'all' : 'chats';
    selectAiSessionTabDom(projectDiv, tab);
    writeAiSessionTabState(window.vscode, origin.projectId, tab);
    postSelectedAiSessionViewTab(origin.projectId, tab);
    if (treeRow) {
        var group = treeRow.closest('.ai-session-worktree-group');
        if (group) {
            setAiSessionWorktreeGroupExpanded(projectDiv, group, true);
            writeAiSessionWorktreeCollapseState(window.vscode, projectDiv);
        }
    }
    // 焦点只落在仍持 data-session-focused 标记的行上（唯一焦点状态源，
    // ARCH-AI-SESSION-PRESENTATION-TRANSACTION-001）；否则回到所在 tab。
    if (treeRow && treeRow.hasAttribute('data-session-focused')) {
        var primary = treeRow.querySelector('.ai-session-primary-action');
        if (primary && typeof primary.focus === 'function') {
            primary.focus({ preventScroll: true });
        }
        treeRow.scrollIntoView({ block: 'nearest' });
        if (primary && document.activeElement === primary) {
            return true;
        }
    }
    var tabButton = Array.from(projectDiv.querySelectorAll(
        '[data-ai-session-tab]'
    )).find(candidate =>
        candidate.getAttribute('data-ai-session-tab') === tab
    );
    if (tabButton && typeof tabButton.focus === 'function') {
        tabButton.focus({ preventScroll: true });
        return document.activeElement === tabButton;
    }
    return false;
}

// M2: the selected CHATS/ALL tab also persists host-side (window view state,
// PR-C protocol) so reloads and authoritative re-renders restore it.
function postSelectedAiSessionViewTab(projectId, tab) {
    if (!window.vscode || typeof window.vscode.postMessage !== 'function' || !projectId) return;
    window.vscode.postMessage({
        type: 'select-ai-session-view-tab',
        version: 1,
        projectId: projectId,
        tab: normalizeAiSessionTab(tab),
    });
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
    root.querySelectorAll('[data-open-session-surface][data-current-workspace][data-id]').forEach(projectDiv => {
        var projectId = projectDiv.getAttribute('data-id');
        if (Object.prototype.hasOwnProperty.call(tabs, projectId)) {
            selectAiSessionTabDom(projectDiv, tabs[projectId]);
        }
        restoreAiSessionWorktreeCollapseState(projectDiv, vscodeApi);
    });
}

function getSelectedAiSessionTab(projectDiv) {
    if (!projectDiv || typeof projectDiv.querySelector !== 'function') return null;
    var selected = projectDiv.querySelector('[data-ai-session-tab][aria-selected="true"]');
    return selected ? normalizeAiSessionTab(selected.getAttribute('data-ai-session-tab')) : null;
}

// M2 transition: import the webview-held legacy sub-tab selection into the
// host-persisted window view state exactly once per boot ('sessions' → ALL;
// anything else is the CHATS default). The host first-writer-wins per scope,
// so a live post-upgrade selection is never clobbered by a stale boot import.
var legacyAiSessionTabImportDone = false;

function maybeImportLegacyAiSessionViewState(vscodeApi, root) {
    if (legacyAiSessionTabImportDone) {
        return;
    }
    legacyAiSessionTabImportDone = true;
    if (!vscodeApi || typeof vscodeApi.postMessage !== 'function') {
        return;
    }
    var tabs = readAiSessionTabState(vscodeApi);
    var currentCard = (root || document).querySelector(
        '[data-open-session-surface][data-current-workspace][data-id]'
    );
    var projectId = currentCard && currentCard.getAttribute('data-id');
    var legacyTab = projectId && Object.prototype.hasOwnProperty.call(tabs, projectId)
        ? tabs[projectId]
        : null;
    if (!legacyTab) {
        return;
    }
    vscodeApi.postMessage({
        type: 'migrate-ai-session-view-state',
        version: 1,
        projectId: projectId,
        // Legacy 'sessions' maps to ALL; the current domain passes through.
        tab: normalizeAiSessionTab(legacyTab),
    });
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
    var anchor = window.__agentPivotScrollState.capture(list, {
        itemSelector: '.codex-session-row',
        getKey: getAiSessionScrollItemKey,
    });
    // A focused session is the user's explicit reading position. Prefer it
    // over the first visible row so a reordered history list keeps the
    // active keyboard target in place through an authoritative refresh.
    var focused = typeof document !== 'undefined' ? document.activeElement : null;
    var focusedRow = focused && typeof focused.closest === 'function'
        ? focused.closest('.codex-session-row')
        : null;
    if (!anchor || !focusedRow || !list.contains(focusedRow)) {
        return anchor;
    }
    var listRect = list.getBoundingClientRect();
    var rowRect = focusedRow.getBoundingClientRect();
    anchor.itemKey = getAiSessionScrollItemKey(focusedRow);
    anchor.itemOffset = rowRect.top - listRect.top;
    return anchor;
}

function restoreAiSessionListAnchor(list, anchor) {
    return window.__agentPivotScrollState.restore(list, anchor, {
        itemSelector: '.codex-session-row',
        getKey: getAiSessionScrollItemKey,
    });
}

function captureAiSessionViewState(projectDiv) {
    // M2 panels: CHATS (tree) scrolls its worktree list; ALL scrolls the
    // history list. Both anchors ride every authoritative replacement.
    var chatsList = projectDiv.querySelector('.ai-session-chats-panel .ai-session-worktree-list');
    var allList = projectDiv.querySelector('.ai-session-history-panel .codex-sessions-list');
    var focused = typeof document !== 'undefined' ? document.activeElement : null;
    var focusedInside = focused && typeof focused.closest === 'function'
        && (focused.closest('.project[data-id]')
            || focused.closest('[data-open-session-surface][data-id]')) === projectDiv;
    var focusedRow = focusedInside ? focused.closest('.codex-session-row') : null;
    var focusedTab = focusedInside ? focused.closest('[data-ai-session-tab]') : null;
    var selectedTab = getSelectedAiSessionTab(projectDiv) || 'chats';
    selectAiSessionTabDom(projectDiv, 'chats');
    var chatsAnchor = captureAiSessionListAnchor(chatsList);
    selectAiSessionTabDom(projectDiv, 'all');
    var allAnchor = captureAiSessionListAnchor(allList);
    selectAiSessionTabDom(projectDiv, selectedTab);
    return {
        selectedTab: selectedTab,
        chatsAnchor: chatsAnchor,
        allAnchor: allAnchor,
        pendingCount: projectDiv.querySelectorAll('.active-ai-session-row[data-session-pending]').length,
        activeCount: projectDiv.querySelectorAll('.active-ai-session-row[data-session-active]').length,
        restoreFocus: !!focusedInside,
        focusedTab: focusedTab && focusedTab.getAttribute('data-ai-session-tab'),
        focusedRow: focusedRow ? {
            provider: focusedRow.getAttribute('data-session-provider') || '',
            sessionId: focusedRow.getAttribute('data-session-id') || '',
            pendingCreatedAt: focusedRow.getAttribute('data-pending-created-at') || '',
            panel: focusedRow.closest('[data-ai-session-panel]')?.getAttribute('data-ai-session-panel') || '',
        } : null,
        collapsedWorktrees: Array.from(projectDiv.querySelectorAll(
            '.ai-session-worktree-group[data-worktree-collapsed]'
        )).map(getAiSessionWorktreeGroupKey),
        expandedMemberDetails: Array.from(projectDiv.querySelectorAll(
            '.ai-session-worktree-group[data-member-details-expanded]'
        )).map(getAiSessionWorktreeGroupKey),
        groupRename: window.__agentPivotWorktreeGroupRename
            && typeof window.__agentPivotWorktreeGroupRename.capture === 'function'
            ? window.__agentPivotWorktreeGroupRename.capture(projectDiv)
            : null,
        groupDeletion: window.__agentPivotWorktreeGroupDeletion
            && typeof window.__agentPivotWorktreeGroupDeletion.capture === 'function'
            ? window.__agentPivotWorktreeGroupDeletion.capture(projectDiv)
            : null,
        worktreeAdopt: window.__agentPivotWorktreeAdopt
            && typeof window.__agentPivotWorktreeAdopt.capture === 'function'
            ? window.__agentPivotWorktreeAdopt.capture(projectDiv)
            : null,
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
    var rows = Array.from(projectDiv.querySelectorAll(
        '.codex-sessions .codex-session-row'
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
    var expandedMemberDetails = new Set(viewState.expandedMemberDetails || []);
    projectDiv.querySelectorAll('.ai-session-worktree-group[data-group-id]').forEach(group => {
        if (expandedMemberDetails.has(getAiSessionWorktreeGroupKey(group))) {
            setWorktreeGroupMemberDetailsExpanded(group, true);
        }
    });
    if (viewState.groupRename
        && window.__agentPivotWorktreeGroupRename
        && typeof window.__agentPivotWorktreeGroupRename.restore === 'function') {
        window.__agentPivotWorktreeGroupRename.restore(projectDiv, viewState.groupRename);
    }
    if (viewState.groupDeletion
        && window.__agentPivotWorktreeGroupDeletion
        && typeof window.__agentPivotWorktreeGroupDeletion.restore === 'function') {
        window.__agentPivotWorktreeGroupDeletion.restore(projectDiv, viewState.groupDeletion);
    }
    if (viewState.worktreeAdopt
        && window.__agentPivotWorktreeAdopt
        && typeof window.__agentPivotWorktreeAdopt.restore === 'function') {
        window.__agentPivotWorktreeAdopt.restore(projectDiv, viewState.worktreeAdopt);
    }
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
    var chatsList = projectDiv.querySelector('.ai-session-chats-panel .ai-session-worktree-list');
    var allList = projectDiv.querySelector('.ai-session-history-panel .codex-sessions-list');
    selectAiSessionTabDom(projectDiv, 'chats');
    restoreAiSessionListAnchor(chatsList, viewState.chatsAnchor);
    selectAiSessionTabDom(projectDiv, 'all');
    restoreAiSessionListAnchor(allList, viewState.allAnchor);
    var selectedTab = selectAiSessionTabDom(projectDiv, requestedTab || viewState.selectedTab || 'chats');
    if (!options || options.restoreFocus !== false) {
        restoreAiSessionViewFocus(projectDiv, viewState, selectedTab);
    }
    return selectedTab;
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
            : focusedOption && (focusedOption.closest('.project[data-id]')
                || focusedOption.closest('[data-open-session-surface][data-id]')) === projectDiv
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
    root.querySelectorAll('[data-open-session-surface][data-current-workspace][data-id]')
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
        '[data-ai-session-panel="chats"] .ai-session-worktree-list,'
        + ' [data-ai-session-panel] .codex-sessions-list'
    ).forEach(list => {
        var panel = list.closest('[data-ai-session-panel]');
        if (!panel) return;
        var key = panel.getAttribute('data-ai-session-panel');
        // Record every keyed panel list, including scrollTop 0: a capture
        // taken while the list is momentarily hidden reads 0, and skipping
        // it would leave the replacement DOM to snap back to the top.
        if (key) {
            scrolls.push({ key: key, scrollTop: Math.max(0, Number(list.scrollTop) || 0) });
        }
    });
    return scrolls;
}

function restoreAiSessionListScrolls(projectDiv, scrolls) {
    (scrolls || []).forEach(saved => {
        var panel = projectDiv.querySelector(
            '[data-ai-session-panel="' + saved.key + '"]'
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
    root.querySelectorAll('[data-open-session-surface][data-current-workspace][data-id]')
        .forEach(projectDiv => {
            var projectId = projectDiv.getAttribute('data-id');
            var state = states.get(projectId);
            if (!state) return;
            // Restore the raw fallback first; semantic list anchors are more
            // precise after reordering and must be the final scroll writer.
            restoreAiSessionListScrolls(projectDiv, state.listScrolls);
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
    root.querySelectorAll('[data-open-session-surface][data-current-workspace][data-id]')
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
