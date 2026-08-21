'use strict';

// OPEN tab window-switcher navigation pending manager (PR-A; row clicks are
// wired to this in PR-B). Implements the webview half of the versioned
// open-window navigation request/settlement protocol:
// - every request carries a fresh requestId and goes pending;
// - settlements are matched by cardId + requestId, stale/duplicate receipts
//   are ignored;
// - consecutive requests on the same row supersede earlier pending ones;
// - requests time out into the error state;
// - pending/error row state is replayed after authoritative DOM replacements.
var agentPivotOpenWindowNavigation = (function () {
    var MESSAGE_TYPE_REQUEST = 'open-window-navigation-request';
    var MESSAGE_TYPE_RESULT = 'open-window-navigation-result';
    var PROTOCOL_VERSION = 1;
    var PENDING_TIMEOUT_MS = 5000;
    var VALID_OUTCOMES = ['focused', 'stale-target', 'untitled-workspace', 'failed', 'malformed-request'];

    var nextRequestId = 0;
    // cardId -> { requestId, timeoutHandle }
    var pendingByCardId = new Map();
    // cardId -> outcome (drives the row error state until the next request)
    var errorByCardId = new Map();

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
        errorByCardId.set(cardId, outcome);
        applyRowState(cardId, 'error', outcome);
    }

    function request(cardId) {
        if (typeof cardId !== 'string' || !cardId) {
            return;
        }
        var existing = pendingByCardId.get(cardId);
        if (existing) {
            // Consecutive clicks supersede: the old request's settlement is
            // ignored when it arrives (requestId no longer matches).
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
            }, PENDING_TIMEOUT_MS);
        }
        pendingByCardId.set(cardId, pending);
        errorByCardId.delete(cardId);
        applyRowState(cardId, 'pending');
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
            // Stale (superseded) or duplicate settlement: ignore.
            return true;
        }
        clearPending(message.cardId, pending);
        if (message.outcome === 'focused') {
            errorByCardId.delete(message.cardId);
            applyRowState(message.cardId, 'idle');
        } else {
            errorByCardId.set(message.cardId, message.outcome);
            applyRowState(message.cardId, 'error', message.outcome);
        }
        return true;
    }

    // Re-applies pending/error row state after an authoritative DOM
    // replacement rebuilt the rows.
    function reconcile(root) {
        pendingByCardId.forEach(function (_pending, cardId) {
            applyRowState(cardId, 'pending', undefined, root);
        });
        errorByCardId.forEach(function (outcome, cardId) {
            applyRowState(cardId, 'error', outcome, root);
        });
    }

    return {
        request: request,
        retry: retry,
        complete: complete,
        reconcile: reconcile,
        isPending: function (cardId) { return pendingByCardId.has(cardId); },
        _pendingByCardId: pendingByCardId,
        _errorByCardId: errorByCardId,
        PENDING_TIMEOUT_MS: PENDING_TIMEOUT_MS,
    };
})();

window.__agentPivotOpenWindowNavigation = agentPivotOpenWindowNavigation;
