'use strict';

// OPEN tab window-switcher navigation pending manager (PR-A; row clicks are
// wired to this in PR-B). Implements the webview half of the versioned
// open-window navigation request/settlement protocol:
// - every request carries a fresh requestId and goes pending;
// - settlements are matched by cardId + requestId, stale/duplicate receipts
//   are ignored;
// - consecutive requests on the same row share the existing pending request;
// - after an intervening cross-row intent, returning to the original row may
//   supersede its older pending request;
// - requests time out into the error state;
// - pending/error row state is replayed after authoritative DOM replacements.
var agentPivotOpenWindowNavigation = (function () {
    var MESSAGE_TYPE_REQUEST = 'open-window-navigation-request';
    var MESSAGE_TYPE_RESULT = 'open-window-navigation-result';
    var PROTOCOL_VERSION = 1;
    var PENDING_TIMEOUT_MS = 5000;
    var VALID_OUTCOMES = ['focused', 'stale-target', 'untitled-workspace', 'failed', 'malformed-request'];

    var nextRequestId = 0;
    var lastRequestedCardId = null;
    // cardId -> { requestId, timeoutHandle }
    var pendingByCardId = new Map();
    // cardId -> { outcome, requestId } (drives the row error state until the
    // next request; the requestId lets a late 'focused' receipt clear the
    // error its own timeout created, as long as no newer request superseded it)
    var errorByCardId = new Map();
    var nextSaveRequestId = 0;
    // cardId -> { requestId }. A Window save can open a Host-side confirmation
    // dialog, so keep the direct control visibly pending until that Host-owned
    // workflow settles.
    var pendingSavesByCardId = new Map();
    var SAVE_PROGRESS_LABELS = {
        'resolving-workspace': 'Checking…',
        'awaiting-workspace-location': 'Choose location…',
        'preparing-project': 'Preparing…',
        'persisting-project': 'Saving…',
    };

    // PRD live region：导航 pending/error 通过切换器内的播报区触达屏幕阅读器。
    function announce(cardId, message) {
        var region = document.querySelector('[data-open-window-nav-live-region]');
        if (!region) {
            return;
        }
        var row = findRow(cardId);
        var name = row && row.querySelector('.open-window-name');
        var label = name && name.textContent ? name.textContent.trim() : '';
        region.textContent = label ? message + ' ' + label : message;
    }

    function findRow(cardId, root) {
        return Array.from((root || document).querySelectorAll(
            '[data-open-window-row][data-id]'
        )).find(function (row) {
            return row.getAttribute('data-id') === cardId;
        }) || null;
    }

    function applyRowState(cardId, state, outcome, root) {
        var row = findRow(cardId, root);
        if (!row) {
            return;
        }
        if (state === 'idle') {
            row.removeAttribute('data-navigation-state');
            row.removeAttribute('data-navigation-outcome');
        } else {
            row.setAttribute('data-navigation-state', state);
            if (state === 'error' && outcome) {
                row.setAttribute('data-navigation-outcome', outcome);
            } else {
                row.removeAttribute('data-navigation-outcome');
            }
        }
        var retry = row.querySelector('[data-action="retry-open-window-navigation"]');
        if (retry) {
            retry.hidden = state !== 'error';
        }
    }

    function applySaveState(cardId, pending, stage, root) {
        var row = findRow(cardId, root);
        if (!row) {
            return;
        }
        var button = row.querySelector('[data-action="save-current-workspace"]');
        if (!button) {
            return;
        }
        if (pending) {
            var label = SAVE_PROGRESS_LABELS[stage] || 'Saving Workspace…';
            row.setAttribute('data-save-state', 'pending');
            if (stage) {
                row.setAttribute('data-save-stage', stage);
            } else {
                row.removeAttribute('data-save-stage');
            }
            button.setAttribute('data-save-pending', 'true');
            button.setAttribute('aria-disabled', 'true');
            button.setAttribute('title', label);
            button.setAttribute('aria-label', label);
            var phase = row.querySelector('.open-window-save-phase');
            if (phase) {
                phase.textContent = label;
            }
        } else {
            row.removeAttribute('data-save-state');
            row.removeAttribute('data-save-stage');
            button.removeAttribute('data-save-pending');
            button.removeAttribute('aria-disabled');
            button.setAttribute('title', 'Save Workspace');
            button.setAttribute('aria-label', 'Save Workspace');
            var phase = row.querySelector('.open-window-save-phase');
            if (phase) {
                phase.textContent = '';
            }
        }
    }

    function requestWorkspaceSave(cardId) {
        if (typeof cardId !== 'string' || !cardId || pendingSavesByCardId.has(cardId)) {
            return;
        }
        nextSaveRequestId = nextSaveRequestId >= Number.MAX_SAFE_INTEGER
            ? 1 : nextSaveRequestId + 1;
        var requestId = 'save-current-workspace-' + Date.now() + '-' + nextSaveRequestId;
        pendingSavesByCardId.set(cardId, { requestId: requestId, projectId: cardId, stage: null });
        applySaveState(cardId, true);
        announce(cardId, 'Saving Workspace');
        if (window.vscode && typeof window.vscode.postMessage === 'function') {
            window.vscode.postMessage({
                type: 'save-current-workspace', version: 1, requestId: requestId, projectId: cardId,
            });
        }
    }

    function completeWorkspaceSave(message) {
        if (!message
            || Object.keys(message).sort().join('\n') !== [
                'operation', 'projectId', 'requestId', 'status', 'type', 'version',
            ].sort().join('\n')
            || message.type !== 'save-current-workspace-result'
            || message.version !== 1
            || typeof message.requestId !== 'string'
            || typeof message.projectId !== 'string'
            || message.operation !== 'save-current-workspace'
            || ['saved', 'cancelled', 'failed'].indexOf(message.status) === -1) {
            return false;
        }
        var cardId = null;
        pendingSavesByCardId.forEach(function (pending, candidateCardId) {
            if (pending.requestId === message.requestId && pending.projectId === message.projectId) {
                cardId = candidateCardId;
            }
        });
        if (!cardId) {
            return true;
        }
        pendingSavesByCardId.delete(cardId);
        applySaveState(cardId, false);
        announce(cardId, message.status === 'saved'
            ? 'Workspace saved'
            : message.status === 'cancelled' ? 'Save cancelled' : 'Could not save Workspace');
        return true;
    }

    function reportWorkspaceSaveProgress(message) {
        if (!message
            || Object.keys(message).sort().join('\n') !== [
                'operation', 'projectId', 'requestId', 'stage', 'type', 'version',
            ].sort().join('\n')
            || message.type !== 'save-current-workspace-progress'
            || message.version !== 1
            || typeof message.requestId !== 'string'
            || typeof message.projectId !== 'string'
            || message.operation !== 'save-current-workspace'
            || typeof message.stage !== 'string'
            || !Object.prototype.hasOwnProperty.call(SAVE_PROGRESS_LABELS, message.stage)) {
            return false;
        }
        var cardId = null;
        pendingSavesByCardId.forEach(function (pending, candidateCardId) {
            if (pending.requestId === message.requestId && pending.projectId === message.projectId) {
                cardId = candidateCardId;
            }
        });
        if (!cardId) {
            return true;
        }
        pendingSavesByCardId.get(cardId).stage = message.stage;
        applySaveState(cardId, true, message.stage);
        announce(cardId, SAVE_PROGRESS_LABELS[message.stage]);
        return true;
    }

    function clearPending(cardId, pending) {
        if (pending && pending.timeoutHandle !== null
            && typeof window.clearTimeout === 'function') {
            window.clearTimeout(pending.timeoutHandle);
        }
        if (pendingByCardId.get(cardId) === pending) {
            pendingByCardId.delete(cardId);
        }
    }

    function failPending(cardId, pending, outcome) {
        clearPending(cardId, pending);
        errorByCardId.set(cardId, { outcome: outcome, requestId: pending.requestId });
        applyRowState(cardId, 'error', outcome);
    }

    function request(cardId) {
        if (typeof cardId !== 'string' || !cardId) {
            return;
        }
        var existing = pendingByCardId.get(cardId);
        if (existing && lastRequestedCardId === cardId) {
            return;
        }
        lastRequestedCardId = cardId;
        if (existing) {
            // A-B-A preserves the final A intent: the intervening B makes
            // this A distinct, so it supersedes the older pending A.
            clearPending(cardId, existing);
        }
        nextRequestId = nextRequestId >= Number.MAX_SAFE_INTEGER ? 1 : nextRequestId + 1;
        var pending = {
            requestId: nextRequestId,
            timeoutHandle: null,
        };
        if (typeof window.setTimeout === 'function') {
            pending.timeoutHandle = window.setTimeout(function () {
                if (pendingByCardId.get(cardId) !== pending) {
                    return;
                }
                failPending(cardId, pending, 'failed');
                announce(cardId, 'Window switch timed out. Retry available on');
            }, PENDING_TIMEOUT_MS);
        }
        pendingByCardId.set(cardId, pending);
        errorByCardId.delete(cardId);
        applyRowState(cardId, 'pending');
        announce(cardId, 'Switching to window');
        if (window.vscode && typeof window.vscode.postMessage === 'function') {
            window.vscode.postMessage({
                type: MESSAGE_TYPE_REQUEST,
                version: PROTOCOL_VERSION,
                requestId: pending.requestId,
                cardId: cardId,
            });
        }
    }

    function retry(cardId) {
        request(cardId);
    }

    function isValidResult(message) {
        return !!message
            && Object.keys(message).sort().join('\n') === [
                'cardId', 'outcome', 'requestId', 'type', 'version',
            ].sort().join('\n')
            && message.type === MESSAGE_TYPE_RESULT
            && message.version === PROTOCOL_VERSION
            && Number.isSafeInteger(message.requestId)
            && message.requestId >= 1
            && typeof message.cardId === 'string'
            && VALID_OUTCOMES.indexOf(message.outcome) !== -1;
    }

    function complete(message) {
        if (!isValidResult(message)) {
            return false;
        }
        var pending = pendingByCardId.get(message.cardId);
        if (!pending || pending.requestId !== message.requestId) {
            // Stale (superseded) or duplicate settlement: ignore — with one
            // exception. The host never cancels a timed-out request, so a
            // late 'focused' receipt still describes a real switch: let it
            // clear the error its own timeout created. A newer request would
            // have deleted the error entry, so a requestId match proves the
            // row has not been superseded.
            var errored = errorByCardId.get(message.cardId);
            if (errored
                && errored.requestId === message.requestId
                && message.outcome === 'focused') {
                errorByCardId.delete(message.cardId);
                applyRowState(message.cardId, 'idle');
            }
            return true;
        }
        clearPending(message.cardId, pending);
        if (message.outcome === 'focused') {
            errorByCardId.delete(message.cardId);
            applyRowState(message.cardId, 'idle');
            announce(message.cardId, 'Now in window');
        } else {
            errorByCardId.set(message.cardId, {
                outcome: message.outcome,
                requestId: message.requestId,
            });
            applyRowState(message.cardId, 'error', message.outcome);
            announce(message.cardId, 'Could not switch to window');
        }
        return true;
    }

    // Re-applies pending/error row state after an authoritative DOM
    // replacement rebuilt the rows.
    function reconcile(root) {
        // 替换后菜单的 __row/origin 指向已分离节点，先关掉。
        closeMenu();
        pendingByCardId.forEach(function (_pending, cardId) {
            applyRowState(cardId, 'pending', undefined, root);
        });
        errorByCardId.forEach(function (entry, cardId) {
            applyRowState(cardId, 'error', entry.outcome, root);
        });
        pendingSavesByCardId.forEach(function (pending, cardId) {
            applySaveState(cardId, true, pending.stage, root);
        });
    }

    // --- window-row ⋯ menu ---------------------------------------------------
    // One shared menu element (#openWindowMenu), positioned next to the row's
    // ⋯ button. Items: Focus Window (non-current rows), Pin/Unpin, Save
    // Workspace (current row). Keyboard: ↑/↓ 导航，Enter 执行，Esc 关闭并焦点返回。
    var menuOriginButton = null;

    function closeMenu(restoreFocus) {
        var menu = document.getElementById('openWindowMenu');
        if (!menu) {
            return;
        }
        menu.classList.remove('visible');
        if (menuOriginButton) {
            menuOriginButton.setAttribute('aria-expanded', 'false');
            // Only keyboard dismissal (Escape) returns focus to the trigger;
            // blur, outside clicks, and item activation each own their focus.
            if (restoreFocus === true && typeof menuOriginButton.focus === 'function') {
                menuOriginButton.focus({ preventScroll: true });
            }
            menuOriginButton = null;
        }
    }

    function openMenu(button) {
        var menu = document.getElementById('openWindowMenu');
        if (!menu) {
            return;
        }
        var row = button.closest('[data-open-window-row]');
        if (!row) {
            return;
        }
        var isCurrent = row.getAttribute('data-window-kind') === 'current';
        var rowDisabled = row.getAttribute('data-navigation-disabled') === 'true';
        var pinned = row.classList.contains('open-window-row-pinned');
        menu.querySelectorAll('[data-open-window-menu-non-current]').forEach(function (item) {
            item.hidden = isCurrent || rowDisabled;
        });
        menu.querySelectorAll('[data-open-window-menu-current]').forEach(function (item) {
            item.hidden = !isCurrent;
        });
        var canPin = row.getAttribute('data-can-pin') !== 'false';
        var pinItem = menu.querySelector('[data-open-window-menu-pin]');
        if (pinItem) {
            pinItem.hidden = !canPin;
            if (canPin) {
                pinItem.textContent = pinned ? 'Unpin Window' : 'Pin Window';
            }
        }
        menu.__row = row;
        if (menuOriginButton && menuOriginButton !== button) {
            menuOriginButton.setAttribute('aria-expanded', 'false');
        }
        menuOriginButton = button;
        button.setAttribute('aria-expanded', 'true');
        menu.style.visibility = 'hidden';
        menu.style.left = '0px';
        menu.style.top = '0px';
        menu.classList.add('visible');
        var buttonRect = button.getBoundingClientRect();
        var menuRect = menu.getBoundingClientRect();
        var viewportPadding = 4;
        var left = Math.max(viewportPadding, Math.min(
            buttonRect.right - menuRect.width,
            window.innerWidth - menuRect.width - viewportPadding
        ));
        var top = buttonRect.bottom + 2;
        if (top + menuRect.height > window.innerHeight - viewportPadding) {
            top = Math.max(viewportPadding, buttonRect.top - menuRect.height - 2);
        }
        menu.style.left = left + 'px';
        menu.style.top = top + 'px';
        menu.style.visibility = 'visible';
        var firstItem = menu.querySelector('[role="menuitem"]:not([hidden])');
        if (firstItem && typeof firstItem.focus === 'function') {
            firstItem.focus();
        }
    }

    function toggleMenu(button) {
        var menu = document.getElementById('openWindowMenu');
        var isOpen = menu && menu.classList.contains('visible')
            && menuOriginButton === button;
        if (isOpen) {
            closeMenu();
        } else {
            openMenu(button);
        }
    }

    function activateMenuItem(item) {
        var menu = document.getElementById('openWindowMenu');
        var row = menu && menu.__row;
        if (!row) {
            closeMenu();
            return;
        }
        var cardId = row.getAttribute('data-id');
        var action = item.getAttribute('data-action');
        closeMenu();
        if (action === 'focus-open-window') {
            request(cardId);
        } else if (action === 'toggle-open-workspace-pin'
            && typeof requestOpenWorkspacePin === 'function') {
            var pinButton = row.querySelector('[data-action="toggle-open-workspace-pin"]');
            if (pinButton) {
                requestOpenWorkspacePin(pinButton, cardId);
            }
        } else if (action === 'save-current-workspace'
            && row.getAttribute('data-window-kind') === 'current') {
            requestWorkspaceSave(cardId);
        }
    }

    function onMenuClick(e) {
        var item = e.target.closest('[role="menuitem"][data-action]');
        if (!item) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        activateMenuItem(item);
    }

    function onMenuKeydown(e) {
        var menu = document.getElementById('openWindowMenu');
        if (!menu || !menu.classList.contains('visible')) {
            return;
        }
        var items = Array.from(menu.querySelectorAll('[role="menuitem"]:not([hidden])'));
        var index = items.indexOf(document.activeElement);
        if (e.key === 'Escape') {
            e.preventDefault();
            closeMenu(true);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            var next = e.key === 'ArrowDown'
                ? (index + 1) % items.length
                : (index - 1 + items.length) % items.length;
            if (items[next]) {
                items[next].focus();
            }
        } else if ((e.key === 'Enter' || e.key === ' ') && index >= 0) {
            e.preventDefault();
            activateMenuItem(items[index]);
        }
    }

    // 行间 ↑/↓ 增强导航（PRD 键盘章节）：在切换器列表内移动焦点。
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') {
            return;
        }
        var row = e.target && e.target.closest
            ? e.target.closest('[data-open-window-row]')
            : null;
        if (!row) {
            return;
        }
        var list = row.closest('[data-open-window-switcher-list]');
        if (!list) {
            return;
        }
        var rows = Array.from(list.querySelectorAll('[data-open-window-row]'));
        var index = rows.indexOf(row);
        if (index === -1) {
            return;
        }
        e.preventDefault();
        var next = e.key === 'ArrowDown'
            ? Math.min(index + 1, rows.length - 1)
            : Math.max(index - 1, 0);
        var focusTarget = rows[next]
            && rows[next].querySelector('[data-action="focus-open-window"]');
        if (focusTarget && typeof focusTarget.focus === 'function') {
            focusTarget.focus();
        }
    });

    if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('blur', function () { closeMenu(); });
    }

    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('click', function (e) {
            // The current-window row owns the workspace and therefore can
            // expose a direct save affordance. Other hosts cannot save a
            // workspace owned by another VS Code window.
            var saveButton = e.target.closest
                && e.target.closest('[data-action="save-current-workspace"]');
            var saveRow = saveButton && saveButton.closest
                && saveButton.closest('[data-open-window-row]');
            if (saveRow) {
                closeMenu();
                e.preventDefault();
                e.stopPropagation();
                if (saveRow.getAttribute('data-window-kind') === 'current'
                    && window.vscode && typeof window.vscode.postMessage === 'function') {
                    requestWorkspaceSave(saveRow.getAttribute('data-id'));
                }
                return;
            }
            var menu = document.getElementById('openWindowMenu');
            if (!menu || !menu.classList.contains('visible')) {
                return;
            }
            if (menu.contains(e.target)) {
                onMenuClick(e);
                return;
            }
            var trigger = e.target.closest
                && e.target.closest('[data-action="open-window-menu"]');
            if (!trigger) {
                closeMenu();
            }
        });
        document.addEventListener('keydown', onMenuKeydown);
    }

    if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('message', function (event) {
            if (!reportWorkspaceSaveProgress(event.data)) {
                completeWorkspaceSave(event.data);
            }
        });
    }

    return {
        request: request,
        retry: retry,
        complete: complete,
        reconcile: reconcile,
        toggleMenu: toggleMenu,
        closeMenu: closeMenu,
        completeWorkspaceSave: completeWorkspaceSave,
        reportWorkspaceSaveProgress: reportWorkspaceSaveProgress,
        isPending: function (cardId) { return pendingByCardId.has(cardId); },
        _pendingByCardId: pendingByCardId,
        _errorByCardId: errorByCardId,
        PENDING_TIMEOUT_MS: PENDING_TIMEOUT_MS,
    };
})();

window.__agentPivotOpenWindowNavigation = agentPivotOpenWindowNavigation;
