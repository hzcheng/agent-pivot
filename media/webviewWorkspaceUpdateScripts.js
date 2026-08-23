function getWorkspaceUpdateDomState(root) {
    var currentSurface = root.matches?.('[data-open-session-surface]')
        ? root
        : root.querySelector('[data-open-session-surface]');
    return {
        currentWorkspaceCount: currentSurface
            && currentSurface.hasAttribute('data-current-workspace')
            && currentSurface.hasAttribute('data-workspace-scope-identity')
            ? 1
            : 0,
    };
}

function isWorkspaceUpdateDomConsistent(message, root) {
    if (message.currentWorkspaceCount !== 0 && message.currentWorkspaceCount !== 1) {
        return false;
    }
    return getWorkspaceUpdateDomState(root).currentWorkspaceCount === message.currentWorkspaceCount;
}

// The OPEN tab regions scroll independently, so an authoritative replacement
// must carry each list's scroll position across the new nodes (same
// anchor-based pattern as the skills pane; the scroll-state helper is
// optional and falls back to a clamped scrollTop).
function captureOpenTabListScroll(list, itemSelector, keyAttribute) {
    if (!list) {
        return null;
    }
    if (window.__agentPivotScrollState
        && typeof window.__agentPivotScrollState.capture === 'function') {
        return {
            anchor: window.__agentPivotScrollState.capture(list, {
                itemSelector: itemSelector,
                getKey: function (el) { return el.getAttribute(keyAttribute) || ''; },
            }),
        };
    }
    return { scrollTop: Math.max(0, Number(list.scrollTop) || 0) };
}

function restoreOpenTabListScroll(list, saved, itemSelector, keyAttribute) {
    if (!list || !saved) {
        return;
    }
    if (saved.anchor && window.__agentPivotScrollState
        && typeof window.__agentPivotScrollState.restore === 'function'
        && window.__agentPivotScrollState.restore(list, saved.anchor, {
            itemSelector: itemSelector,
            getKey: function (el) { return el.getAttribute(keyAttribute) || ''; },
        })) {
        return;
    }
    var fallbackTop = saved.anchor ? saved.anchor.scrollTop : saved.scrollTop;
    var maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
    list.scrollTop = Math.min(Math.max(0, Number(fallbackTop) || 0), maxScrollTop);
}

var OPEN_TAB_OTHER_LIST_SELECTOR = '.open-window-switcher-group [data-open-window-switcher-list]';
var OPEN_TAB_OTHER_ITEM_SELECTOR = '[data-open-window-row][data-workspace-navigation-identity]';

// Minimal test doubles may not implement querySelector — treat them as
// "no scrollable list" instead of throwing mid-replacement.
function queryOpenTabList(root, selector) {
    return root && typeof root.querySelector === 'function'
        ? root.querySelector(selector)
        : null;
}

function applyWorkspaceUpdate(message, options) {
    if (!message
        || message.type !== 'workspace-updated'
        || message.version !== 2
        || (message.currentWorkspaceCount !== 0 && message.currentWorkspaceCount !== 1)
        || typeof message.html !== 'string') {
        return false;
    }

    var wrapper = document.querySelector('.sticky-groups-wrapper');
    var currentSurface = wrapper && wrapper.querySelector('[data-open-session-surface]');
    if (!wrapper || !currentSurface || typeof document.createElement !== 'function') {
        return false;
    }
    var holder = document.createElement('div');
    holder.innerHTML = message.html.trim();
    var replacement = holder.firstElementChild;
    if (!replacement
        || holder.children.length !== 1
        || !replacement.matches('[data-open-session-surface]')
        || !isWorkspaceUpdateDomConsistent(message, replacement)) {
        return false;
    }
    if (options && typeof options.validateReplacement === 'function'
        && !options.validateReplacement(replacement)) {
        return false;
    }

    // State helpers query descendants; capture from the wrapper so the
    // surface itself is included (querySelectorAll on the surface excludes
    // its own node).
    var aiSessionStates = captureCurrentWorkspaceAiSessionStates(wrapper);
    // The creation form re-renders after the replacement (reconcileDom), so
    // its focus must be captured while the old DOM is still mounted.
    if (window.__agentPivotWorktreeGroupForm
        && typeof window.__agentPivotWorktreeGroupForm.captureFocus === 'function') {
        window.__agentPivotWorktreeGroupForm.captureFocus();
    }
    currentSurface.replaceWith(replacement);
    if (typeof restoreAiSessionTabsFromState === 'function') {
        restoreAiSessionTabsFromState(wrapper, window.vscode);
    }
    restoreCurrentWorkspaceAiSessionViewStates(
        wrapper,
        aiSessionStates,
        projectId => options
            && typeof options.canRestoreAiSessionProviderMenu === 'function'
            && options.canRestoreAiSessionProviderMenu(projectId)
    );
    restoreCurrentWorkspaceAiSessionAnchorsAndFocus(wrapper, aiSessionStates);
    if (typeof window.__agentPivotSyncCollapseButton === 'function') {
        window.__agentPivotSyncCollapseButton();
    }
    if (typeof window.__agentPivotRevealPendingWorkspaceSession === 'function') {
        window.__agentPivotRevealPendingWorkspaceSession();
    }
    return true;
}

var lastAppliedOpenWorkspacesSemanticRevision = null;
var pendingOpenWorkspacePins = new Map();
var nextOpenWorkspacePinRequestId = 0;

function findOpenWorkspacePinButton(cardId, root) {
    return Array.from((root || document).querySelectorAll(
        '[data-open-window-row][data-id] [data-action="toggle-open-workspace-pin"]'
    )).find(button => button.closest('[data-open-window-row]')?.getAttribute('data-id') === cardId) || null;
}

function announceOpenWorkspacePin(message) {
    var region = document.querySelector('[data-open-workspace-pin-live-region]');
    if (region) {
        region.textContent = message;
    }
}

function setOpenWorkspacePinPending(button, pending) {
    if (!button) return;
    if (pending) {
        button.setAttribute('data-pin-pending', '');
        button.setAttribute('aria-disabled', 'true');
    } else {
        button.removeAttribute('data-pin-pending');
        button.removeAttribute('aria-disabled');
    }
}

function clearOpenWorkspacePinPending(cardId, button) {
    var pending = pendingOpenWorkspacePins.get(cardId);
    if (pending && pending.timeoutHandle !== null
        && typeof window.clearTimeout === 'function') {
        window.clearTimeout(pending.timeoutHandle);
    }
    pendingOpenWorkspacePins.delete(cardId);
    setOpenWorkspacePinPending(button, false);
}

// Window-row focus capture/restore across authoritative replacements: the
// keyboard user may be on any of the row's controls (primary, pin, more,
// retry), so record {cardId, controlKind} and re-focus the same control in
// the rebuilt row (retry is re-unhidden by the navigation reconcile first).
var OPEN_WINDOW_ROW_FOCUS_CONTROLS = [
    { kind: 'focus', selector: '[data-action="focus-open-window"]' },
    { kind: 'pin', selector: '[data-action="toggle-open-workspace-pin"]' },
    { kind: 'more', selector: '[data-action="open-window-menu"]' },
    { kind: 'retry', selector: '[data-action="retry-open-window-navigation"]' },
];

function captureOpenWindowRowFocus() {
    var active = document.activeElement;
    if (!active || typeof active.closest !== 'function') {
        return null;
    }
    var row = active.closest('[data-open-window-row][data-id]');
    if (!row) {
        return null;
    }
    if (typeof active.matches !== 'function') {
        return null;
    }
    for (var i = 0; i < OPEN_WINDOW_ROW_FOCUS_CONTROLS.length; i++) {
        if (active.matches(OPEN_WINDOW_ROW_FOCUS_CONTROLS[i].selector)) {
            return {
                cardId: row.getAttribute('data-id'),
                controlKind: OPEN_WINDOW_ROW_FOCUS_CONTROLS[i].kind,
            };
        }
    }
    return null;
}

function findOpenWindowRowControl(cardId, controlKind, root) {
    var selector = null;
    for (var i = 0; i < OPEN_WINDOW_ROW_FOCUS_CONTROLS.length; i++) {
        if (OPEN_WINDOW_ROW_FOCUS_CONTROLS[i].kind === controlKind) {
            selector = OPEN_WINDOW_ROW_FOCUS_CONTROLS[i].selector;
            break;
        }
    }
    if (!selector) {
        return null;
    }
    var rows = (root || document).querySelectorAll('[data-open-window-row][data-id]');
    for (var j = 0; j < rows.length; j++) {
        if (rows[j].getAttribute('data-id') === cardId) {
            return rows[j].querySelector(selector);
        }
    }
    return null;
}

function reconcilePendingOpenWorkspacePins(root) {
    pendingOpenWorkspacePins.forEach((pending, cardId) => {
        var button = findOpenWorkspacePinButton(cardId, root || document);
        if (button && (button.getAttribute('aria-pressed') === 'true') === pending.pinned) {
            clearOpenWorkspacePinPending(cardId, button);
            announceOpenWorkspacePin(pending.pinned ? 'Window pinned.' : 'Window unpinned.');
            flashOpenWindowRow(cardId);
            return;
        }
        if (!button && pending.acknowledged) {
            clearOpenWorkspacePinPending(cardId, null);
            announceOpenWorkspacePin(pending.pinned ? 'Window pinned.' : 'Window unpinned.');
            flashOpenWindowRow(cardId);
            return;
        }
        setOpenWorkspacePinPending(button, true);
    });
}

// PRD：pin 置顶导致行跳动时，该行保持可见并给一次 ≤150ms 短闪烁确认。
function flashOpenWindowRow(cardId) {
    var button = findOpenWorkspacePinButton(cardId);
    var row = button && button.closest('[data-open-window-row]');
    if (!row) {
        return;
    }
    if (typeof row.scrollIntoView === 'function') {
        row.scrollIntoView({ block: 'nearest' });
    }
    if (row.classList && typeof row.classList.add === 'function') {
        row.classList.add('open-window-row-pin-flash');
        if (typeof window.setTimeout === 'function' && row.classList.remove) {
            window.setTimeout(() => row.classList.remove('open-window-row-pin-flash'), 150);
        }
    }
}

function requestOpenWorkspacePin(button, cardId) {
    if (!button || pendingOpenWorkspacePins.has(cardId)) {
        return;
    }
    nextOpenWorkspacePinRequestId = nextOpenWorkspacePinRequestId >= Number.MAX_SAFE_INTEGER
        ? 1
        : nextOpenWorkspacePinRequestId + 1;
    var pinned = button.getAttribute('aria-pressed') !== 'true';
    var card = button.closest('[data-open-window-row]');
    var name = card?.querySelector('.open-window-name, .project-header')?.textContent?.trim() || 'window';
    var pending = {
        requestId: nextOpenWorkspacePinRequestId,
        pinned: pinned,
        acknowledged: false,
        timeoutHandle: null,
    };
    if (typeof window.setTimeout === 'function') {
        pending.timeoutHandle = window.setTimeout(() => {
            if (pendingOpenWorkspacePins.get(cardId) !== pending) {
                return;
            }
            clearOpenWorkspacePinPending(cardId, findOpenWorkspacePinButton(cardId));
            announceOpenWorkspacePin('Pinned window update timed out. Try again.');
            requestFullRefresh('open-workspace-pin-timeout');
        }, 15_000);
    }
    pendingOpenWorkspacePins.set(cardId, pending);
    setOpenWorkspacePinPending(button, true);
    announceOpenWorkspacePin(`${pinned ? 'Pinning' : 'Unpinning'} ${name}…`);
    window.vscode.postMessage({
        type: 'set-open-workspace-pin',
        version: 1,
        requestId: pending.requestId,
        cardId: cardId,
        pinned: pinned,
    });
}

function completeOpenWorkspacePin(message) {
    if (!message
        || Object.keys(message).sort().join('\n') !== [
            'cardId', 'pinned', 'requestId', 'success', 'type', 'version',
        ].sort().join('\n')
        || message.type !== 'open-workspace-pin-result'
        || message.version !== 1
        || !Number.isSafeInteger(message.requestId)
        || message.requestId < 1
        || typeof message.cardId !== 'string'
        || typeof message.pinned !== 'boolean'
        || typeof message.success !== 'boolean') {
        return false;
    }
    var pending = pendingOpenWorkspacePins.get(message.cardId);
    if (!pending
        || pending.requestId !== message.requestId
        || pending.pinned !== message.pinned) {
        return true;
    }
    if (!message.success) {
        clearOpenWorkspacePinPending(
            message.cardId,
            findOpenWorkspacePinButton(message.cardId),
        );
        announceOpenWorkspacePin('Could not update the pinned window.');
        return true;
    }
    pending.acknowledged = true;
    reconcilePendingOpenWorkspacePins(document);
    return true;
}

function applyOpenWorkspacesUpdate(message, options) {
    if (!message
        || message.type !== 'open-workspaces-updated'
        || message.version !== 4
        || typeof message.semanticRevision !== 'string'
        || !message.semanticRevision
        || !Number.isSafeInteger(message.windowRowCount)
        || message.windowRowCount < 0
        || (message.currentWindowRowCount !== 0 && message.currentWindowRowCount !== 1)
        || !Number.isSafeInteger(message.navigationWindowRowCount)
        || message.navigationWindowRowCount < 0
        || (message.currentDetailCount !== 0 && message.currentDetailCount !== 1)
        || (message.otherWindowsStatus !== 'ready'
            && message.otherWindowsStatus !== 'connecting'
            && message.otherWindowsStatus !== 'unavailable'
            && message.otherWindowsStatus !== 'update-required')
        || typeof message.html !== 'string'
        || typeof normalizeDashboardSearchCatalog !== 'function'
        || normalizeDashboardSearchCatalog(message.searchCatalog) !== message.searchCatalog
        || message.searchCatalog.version !== 3) {
        return false;
    }
    if (message.semanticRevision === lastAppliedOpenWorkspacesSemanticRevision) {
        reconcilePendingOpenWorkspacePins(document);
        return true;
    }
    var wrapper = document.querySelector('.sticky-groups-wrapper');
    if (!wrapper) return false;
    var holder = null;
    if (typeof document.createElement === 'function') {
        holder = document.createElement('div');
        holder.innerHTML = message.html;
        if (!isOpenWorkspacesUpdateDomConsistent(message, holder)
            || (options && typeof options.validateReplacement === 'function'
                && !options.validateReplacement(holder))) {
            return false;
        }
    } else if (options && typeof options.validateReplacement === 'function') {
        return false;
    }
    var previousHtml = wrapper.innerHTML;
    var focusedRowControl = captureOpenWindowRowFocus();
    var aiSessionStates = captureCurrentWorkspaceAiSessionStates(wrapper);
    // This path replaces the whole wrapper, so preserve the WINDOWS list and
    // the dashboard window position. Session-list scroll is captured with the
    // session view state below, where its semantic item identity is known.
    var otherListScroll = captureOpenTabListScroll(
        queryOpenTabList(wrapper, OPEN_TAB_OTHER_LIST_SELECTOR),
        OPEN_TAB_OTHER_ITEM_SELECTOR,
        'data-workspace-navigation-identity'
    );
    var windowScrollY = typeof window.scrollY === 'number' ? window.scrollY : 0;
    // Capture the open creation form's focus before destroying its slot.
    if (window.__agentPivotWorktreeGroupForm
        && typeof window.__agentPivotWorktreeGroupForm.captureFocus === 'function') {
        window.__agentPivotWorktreeGroupForm.captureFocus();
    }
    wrapper.innerHTML = holder ? holder.innerHTML : message.html;
    if (!isOpenWorkspacesUpdateDomConsistent(message)) {
        wrapper.innerHTML = previousHtml;
        restoreOpenTabListScroll(
            queryOpenTabList(wrapper, OPEN_TAB_OTHER_LIST_SELECTOR),
            otherListScroll,
            OPEN_TAB_OTHER_ITEM_SELECTOR,
            'data-workspace-navigation-identity'
        );
        if (typeof window.scrollTo === 'function') {
            window.scrollTo(0, windowScrollY);
        }
        if (typeof restoreAiSessionTabsFromState === 'function') {
            restoreAiSessionTabsFromState(document, window.vscode);
        }
        restoreCurrentWorkspaceAiSessionViewStates(wrapper, aiSessionStates);
        restoreCurrentWorkspaceAiSessionAnchorsAndFocus(wrapper, aiSessionStates);
        return false;
    }
    restoreOpenTabListScroll(
        queryOpenTabList(wrapper, OPEN_TAB_OTHER_LIST_SELECTOR),
        otherListScroll,
        OPEN_TAB_OTHER_ITEM_SELECTOR,
        'data-workspace-navigation-identity'
    );
    if (typeof window.scrollTo === 'function') {
        window.scrollTo(0, windowScrollY);
    }
    if (window.__agentPivotDashboard) {
        window.__agentPivotDashboard.replaceSearchCatalog(message.searchCatalog);
    }
    if (typeof restoreAiSessionTabsFromState === 'function') {
        restoreAiSessionTabsFromState(document, window.vscode);
    }
    restoreCurrentWorkspaceAiSessionViewStates(wrapper, aiSessionStates);
    restoreCurrentWorkspaceAiSessionAnchorsAndFocus(wrapper, aiSessionStates);
    reconcilePendingOpenWorkspacePins(wrapper);
    // Replay the navigation pending/error row state before restoring focus so
    // an error row's Retry control is visible (focusable) again. The caller
    // reconciles once more afterwards; both passes are idempotent.
    if (window.__agentPivotOpenWindowNavigation
        && typeof window.__agentPivotOpenWindowNavigation.reconcile === 'function') {
        window.__agentPivotOpenWindowNavigation.reconcile(wrapper);
    }
    var restoredRowControl = focusedRowControl
        ? findOpenWindowRowControl(focusedRowControl.cardId, focusedRowControl.controlKind, wrapper)
        : null;
    if (restoredRowControl && typeof restoredRowControl.focus === 'function') {
        restoredRowControl.focus({ preventScroll: true });
    }
    if (typeof window.__agentPivotSyncCollapseButton === 'function') {
        window.__agentPivotSyncCollapseButton();
    }
    lastAppliedOpenWorkspacesSemanticRevision = message.semanticRevision;
    return true;
}

function getOpenWorkspacesUpdateDomState(root) {
    var projectionRoot = root || document;
    var wrapperPrefix = root ? '' : '.sticky-groups-wrapper ';
    var switcherGroup = projectionRoot.querySelector(
        wrapperPrefix + '.open-window-switcher-group[data-other-windows-status]'
    );
    var windowRows = Array.from(projectionRoot.querySelectorAll(
        wrapperPrefix + '[data-open-window-row][data-workspace-navigation-identity]'
    ));
    var navigationRows = windowRows.filter(row =>
        row.getAttribute('data-window-kind') === 'navigation'
    );
    var navigationIdentities = navigationRows.map(row =>
        row.getAttribute('data-workspace-navigation-identity')
    );
    return {
        windowRowCount: windowRows.length,
        currentWindowRowCount: windowRows.filter(row =>
            row.getAttribute('data-window-kind') === 'current'
        ).length,
        navigationWindowRowCount: navigationRows.length,
        currentDetailCount: projectionRoot.querySelectorAll(
            wrapperPrefix
                + '[data-open-session-surface][data-current-workspace][data-workspace-scope-identity]'
        ).length,
        hasUniqueNavigationIdentities: navigationIdentities.every(identity => !!identity)
            && new Set(navigationIdentities).size === navigationIdentities.length,
        hasWindowSwitcher: !!switcherGroup,
        otherWindowsStatus: switcherGroup
            ? switcherGroup.getAttribute('data-other-windows-status')
            : 'ready',
    };
}

function isOpenWorkspacesUpdateDomConsistent(message, root) {
    var rendered = getOpenWorkspacesUpdateDomState(root);
    return rendered.currentWindowRowCount === message.currentWindowRowCount
        && rendered.navigationWindowRowCount === message.navigationWindowRowCount
        && rendered.windowRowCount === message.windowRowCount
        && rendered.currentDetailCount === message.currentDetailCount
        && rendered.hasUniqueNavigationIdentities
        && rendered.otherWindowsStatus === message.otherWindowsStatus
        && rendered.hasWindowSwitcher
        && message.windowRowCount
            === message.currentWindowRowCount + message.navigationWindowRowCount
        && message.searchCatalog.openWorkspaces.length
            === message.currentWindowRowCount + message.navigationWindowRowCount;
}
