function getWorkspaceUpdateDomState(root) {
    var currentGroup = root.matches?.('.open-current-workspace-group')
        ? root
        : root.querySelector('.open-current-workspace-group');
    return {
        currentWorkspaceCount: currentGroup
            ? currentGroup.querySelectorAll('.workspace-card[data-workspace-scope-identity]').length
            : 0,
    };
}

function isWorkspaceUpdateDomConsistent(message, root) {
    if (message.currentWorkspaceCount !== 0 && message.currentWorkspaceCount !== 1) {
        return false;
    }
    return getWorkspaceUpdateDomState(root).currentWorkspaceCount === message.currentWorkspaceCount;
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
    var currentGroup = wrapper && wrapper.querySelector('.open-current-workspace-group');
    if (!wrapper || !currentGroup || typeof document.createElement !== 'function') {
        return false;
    }
    var currentCards = Array.from(wrapper.querySelectorAll('.workspace-card[data-current-workspace][data-workspace-scope-identity]'));
    if (currentCards.some(card => !currentGroup.contains(card))) {
        return false;
    }
    var holder = document.createElement('div');
    holder.innerHTML = message.html.trim();
    var replacement = holder.firstElementChild;
    if (!replacement
        || holder.children.length !== 1
        || !replacement.matches('.open-current-workspace-group')
        || !isWorkspaceUpdateDomConsistent(message, replacement)) {
        return false;
    }

    var aiSessionStates = captureCurrentWorkspaceAiSessionStates(currentGroup);
    currentGroup.replaceWith(replacement);
    if (typeof restoreAiSessionTabsFromState === 'function') {
        restoreAiSessionTabsFromState(replacement, window.vscode);
    }
    restoreCurrentWorkspaceAiSessionViewStates(
        replacement,
        aiSessionStates,
        projectId => options
            && typeof options.canRestoreAiSessionProviderMenu === 'function'
            && options.canRestoreAiSessionProviderMenu(projectId)
    );
    restoreCurrentWorkspaceAiSessionAnchorsAndFocus(replacement, aiSessionStates);
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
        '.open-other-windows-group .workspace-card[data-open-workspace-list-card][data-id] .project-pin-badge[data-action="toggle-open-workspace-pin"]'
    )).find(button => button.closest('.workspace-card')?.getAttribute('data-id') === cardId) || null;
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

function reconcilePendingOpenWorkspacePins(root) {
    pendingOpenWorkspacePins.forEach((pending, cardId) => {
        var button = findOpenWorkspacePinButton(cardId, root || document);
        if (button && (button.getAttribute('aria-pressed') === 'true') === pending.pinned) {
            clearOpenWorkspacePinPending(cardId, button);
            announceOpenWorkspacePin(pending.pinned ? 'Window pinned.' : 'Window unpinned.');
            return;
        }
        if (!button && pending.acknowledged) {
            clearOpenWorkspacePinPending(cardId, null);
            announceOpenWorkspacePin(pending.pinned ? 'Window pinned.' : 'Window unpinned.');
            return;
        }
        setOpenWorkspacePinPending(button, true);
    });
}

function requestOpenWorkspacePin(button, cardId) {
    if (!button || pendingOpenWorkspacePins.has(cardId)) {
        return;
    }
    nextOpenWorkspacePinRequestId = nextOpenWorkspacePinRequestId >= Number.MAX_SAFE_INTEGER
        ? 1
        : nextOpenWorkspacePinRequestId + 1;
    var pinned = button.getAttribute('aria-pressed') !== 'true';
    var card = button.closest('.workspace-card');
    var name = card?.querySelector('.project-header')?.textContent?.trim() || 'window';
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

function applyOpenWorkspacesUpdate(message) {
    if (!message
        || message.type !== 'open-workspaces-updated'
        || message.version !== 2
        || typeof message.semanticRevision !== 'string'
        || !message.semanticRevision
        || (message.currentWorkspaceCount !== 0 && message.currentWorkspaceCount !== 1)
        || !Number.isSafeInteger(message.navigationWorkspaceCount)
        || message.navigationWorkspaceCount < 0
        || (message.otherWindowsStatus !== 'ready'
            && message.otherWindowsStatus !== 'connecting'
            && message.otherWindowsStatus !== 'unavailable'
            && message.otherWindowsStatus !== 'update-required')
        || typeof message.html !== 'string'
        || typeof normalizeDashboardSearchCatalog !== 'function'
        || normalizeDashboardSearchCatalog(message.searchCatalog) !== message.searchCatalog
        || message.searchCatalog.version !== 2) {
        return false;
    }
    if (message.semanticRevision === lastAppliedOpenWorkspacesSemanticRevision) {
        reconcilePendingOpenWorkspacePins(document);
        return true;
    }
    var wrapper = document.querySelector('.sticky-groups-wrapper');
    if (!wrapper) return false;
    var previousHtml = wrapper.innerHTML;
    var focusedPinButton = document.activeElement
        && document.activeElement.matches?.(
            '.project-pin-badge[data-action="toggle-open-workspace-pin"]'
        )
        ? document.activeElement.closest('.workspace-card')?.getAttribute('data-id')
        : null;
    var aiSessionStates = captureCurrentWorkspaceAiSessionStates(wrapper);
    wrapper.innerHTML = message.html;
    if (!isOpenWorkspacesUpdateDomConsistent(message)) {
        wrapper.innerHTML = previousHtml;
        if (typeof restoreAiSessionTabsFromState === 'function') {
            restoreAiSessionTabsFromState(document, window.vscode);
        }
        restoreCurrentWorkspaceAiSessionViewStates(wrapper, aiSessionStates);
        restoreCurrentWorkspaceAiSessionAnchorsAndFocus(wrapper, aiSessionStates);
        return false;
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
    var restoredPinButton = focusedPinButton
        ? findOpenWorkspacePinButton(focusedPinButton, wrapper)
        : null;
    if (restoredPinButton && typeof restoredPinButton.focus === 'function') {
        restoredPinButton.focus({ preventScroll: true });
    }
    if (typeof window.__agentPivotSyncCollapseButton === 'function') {
        window.__agentPivotSyncCollapseButton();
    }
    lastAppliedOpenWorkspacesSemanticRevision = message.semanticRevision;
    return true;
}

function getOpenWorkspacesUpdateDomState() {
    var otherWindowsGroup = document.querySelector(
        '.sticky-groups-wrapper .open-other-windows-group[data-other-windows-status]'
    );
    var openWorkspaceCards = Array.from(document.querySelectorAll(
        '.sticky-groups-wrapper .open-other-windows-group '
        + '.workspace-card[data-open-workspace-list-card][data-workspace-navigation-identity]'
    ));
    var navigationCards = openWorkspaceCards.filter(card =>
        card.hasAttribute('data-workspace-navigation')
    );
    var navigationIdentities = openWorkspaceCards.map(card =>
        card.getAttribute('data-workspace-navigation-identity')
    );
    return {
        currentWorkspaceCount: document.querySelectorAll(
            '.sticky-groups-wrapper .workspace-card[data-current-workspace][data-workspace-scope-identity]'
        ).length,
        navigationWorkspaceCount: navigationCards.length,
        openWorkspaceListCount: openWorkspaceCards.length,
        hasUniqueNavigationIdentities: navigationIdentities.every(identity => !!identity)
            && new Set(navigationIdentities).size === navigationIdentities.length,
        hasOtherWindowsGroup: document.querySelectorAll(
            '.sticky-groups-wrapper .open-other-windows-group'
        ).length > 0,
        otherWindowsStatus: otherWindowsGroup
            ? otherWindowsGroup.getAttribute('data-other-windows-status')
            : 'ready',
    };
}

function isOpenWorkspacesUpdateDomConsistent(message) {
    var rendered = getOpenWorkspacesUpdateDomState();
    return rendered.currentWorkspaceCount === message.currentWorkspaceCount
        && rendered.navigationWorkspaceCount === message.navigationWorkspaceCount
        && rendered.hasUniqueNavigationIdentities
        && rendered.otherWindowsStatus === message.otherWindowsStatus
        && rendered.hasOtherWindowsGroup
        && rendered.openWorkspaceListCount
            === message.currentWorkspaceCount + message.navigationWorkspaceCount
        && message.searchCatalog.openWorkspaces.length
            === message.currentWorkspaceCount + message.navigationWorkspaceCount;
}
