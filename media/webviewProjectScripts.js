function normalizeAiSessionTab(value) {
    return value === 'active' ? 'active' : 'sessions';
}

function getAiSessionCardActivation(target, projectId) {
    if (!target || typeof target.closest !== 'function') {
        return { handled: false, sessionRow: null, message: null };
    }
    var primarySessionAction = target.closest('[data-action="activate-ai-session"]');
    var interactiveSessionChild = target.closest(
        'button, input, select, textarea, a[href], [data-action]'
    );
    var activationSessionRow = primarySessionAction
        ? primarySessionAction.closest('.codex-session-row')
        : (!interactiveSessionChild ? target.closest('.codex-session-row') : null);
    if (!activationSessionRow) {
        return {
            handled: !!target.closest('.codex-session-row'),
            sessionRow: null,
            message: null,
        };
    }

    var provider = activationSessionRow.getAttribute('data-session-provider') || 'codex';
    var supportedProvider = provider === 'codex' || provider === 'kimi' || provider === 'claude';
    if (activationSessionRow.hasAttribute('data-session-pending')) {
        var createdAt = activationSessionRow.getAttribute('data-pending-created-at');
        return {
            handled: true,
            sessionRow: activationSessionRow,
            message: supportedProvider && createdAt ? {
                type: 'focus-pending-ai-session',
                projectId: projectId,
                provider: provider,
                createdAt: createdAt,
            } : null,
        };
    }

    var sessionId = activationSessionRow.getAttribute('data-session-id');
    if (!sessionId || !supportedProvider) {
        return { handled: true, sessionRow: activationSessionRow, message: null };
    }
    if (activationSessionRow.hasAttribute('data-session-active')) {
        if (activationSessionRow.hasAttribute('data-session-focused')) {
            return {
                handled: true,
                sessionRow: activationSessionRow,
                message: null,
                toggleConversation: true,
            };
        }
        return {
            handled: true,
            sessionRow: activationSessionRow,
            message: {
                type: 'focus-ai-session-terminal',
                projectId: projectId,
                provider: provider,
                sessionId: sessionId,
            },
        };
    }
    return {
        handled: true,
        sessionRow: activationSessionRow,
        message: {
            type: provider === 'kimi'
                ? 'resume-kimi-session'
                : provider === 'claude'
                    ? 'resume-claude-session'
                    : 'resume-codex-session',
            projectId: projectId,
            sessionId: sessionId,
        },
    };
}

var expandedActiveAiSessionConversationKey = null;
var activeAiSessionConversationSubscription = null;
var activeAiSessionConversationRequestId = 0;
var activeAiSessionConversationGeneration = 0;
var activeAiSessionConversationResizeObserver = null;
var activeAiSessionConversationMutationObserver = null;
var activeAiSessionConversationResizeFallbackInstalled = false;
var activeAiSessionConversationRetryTimer = null;
var activeAiSessionConversationRetryDeadline = 0;

var ACTIVE_AI_SESSION_CONVERSATION_PREVIEW_GRAPHEMES = 160;
var ACTIVE_AI_SESSION_CONVERSATION_MAX_INTERACTIONS = 2000;
var ACTIVE_AI_SESSION_CONVERSATION_MAX_MESSAGE_GRAPHEMES = 64 * 1000;
var ACTIVE_AI_SESSION_CONVERSATION_MAX_PREVIEW_CODE_UNITS = 4096;
var ACTIVE_AI_SESSION_CONVERSATION_MAX_RETRY_AFTER_MS = 60 * 1000;
var ACTIVE_AI_SESSION_CONVERSATION_RESPONSE_STATES = [
    'complete', 'inProgress', 'interrupted', 'unknown',
];
var ACTIVE_AI_SESSION_CONVERSATION_ERROR_CODES = [
    'unavailable', 'staleRevision', 'unsupportedVersion', 'tooLarge', 'timeout',
];
var ACTIVE_AI_SESSION_CONVERSATION_ERROR_REASONS = [
    'missingSource', 'updateCodex', 'unsupportedCodexProtocol',
    'reconnectingCodex', 'codexRetryExhausted',
];
var activeAiSessionConversationSegmenter = null;

function isPlainConversationObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasExactConversationKeys(value, required, optional) {
    if (!isPlainConversationObject(value)) return false;
    var requiredKeys = required || [];
    var allowed = new Set(requiredKeys.concat(optional || []));
    var keys = Object.keys(value);
    return requiredKeys.every(key => Object.prototype.hasOwnProperty.call(value, key))
        && keys.every(key => allowed.has(key));
}

function isBoundedConversationIdentity(value) {
    return typeof value === 'string'
        && value.trim().length > 0
        && value.length <= 1024;
}

function conversationGraphemes(value) {
    value = typeof value === 'string' ? value : '';
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
        activeAiSessionConversationSegmenter =
            activeAiSessionConversationSegmenter
            || new Intl.Segmenter(undefined, { granularity: 'grapheme' });
        return Array.from(
            activeAiSessionConversationSegmenter.segment(value),
            segment => segment.segment
        );
    }
    return Array.from(value);
}

function truncateConversationPreview(value) {
    if (value.length <= ACTIVE_AI_SESSION_CONVERSATION_PREVIEW_GRAPHEMES) {
        return value;
    }
    return conversationGraphemes(value)
        .slice(0, ACTIVE_AI_SESSION_CONVERSATION_PREVIEW_GRAPHEMES)
        .join('');
}

function isValidConversationSummary(summary) {
    if (!hasExactConversationKeys(
        summary,
        ['id', 'userPreview', 'userGraphemeCount', 'responseState'],
        ['providerTurnId', 'timestamp']
    )
        || !isBoundedConversationIdentity(summary.id)
        || typeof summary.userPreview !== 'string'
        || summary.userPreview.length
            > ACTIVE_AI_SESSION_CONVERSATION_MAX_PREVIEW_CODE_UNITS
        || conversationGraphemes(summary.userPreview).length
            > ACTIVE_AI_SESSION_CONVERSATION_PREVIEW_GRAPHEMES
        || !Number.isSafeInteger(summary.userGraphemeCount)
        || summary.userGraphemeCount < 0
        || summary.userGraphemeCount
            > ACTIVE_AI_SESSION_CONVERSATION_MAX_MESSAGE_GRAPHEMES
        || !ACTIVE_AI_SESSION_CONVERSATION_RESPONSE_STATES.includes(
            summary.responseState
        )
        || (summary.providerTurnId !== undefined
            && !isBoundedConversationIdentity(summary.providerTurnId))
        || (summary.timestamp !== undefined
            && (!Number.isFinite(summary.timestamp) || summary.timestamp < 0))) {
        return false;
    }
    return true;
}

function isValidConversationOutline(outline, state) {
    if (!hasExactConversationKeys(
        outline,
        [
            'provider', 'sessionId', 'sourceRevision',
            'totalInteractions', 'partial', 'interactions',
        ],
        []
    )
        || outline.provider !== state.provider
        || outline.sessionId !== state.sessionId
        || !isBoundedConversationIdentity(outline.sourceRevision)
        || !Number.isSafeInteger(outline.totalInteractions)
        || outline.totalInteractions < 0
        || typeof outline.partial !== 'boolean'
        || !Array.isArray(outline.interactions)
        || outline.interactions.length > ACTIVE_AI_SESSION_CONVERSATION_MAX_INTERACTIONS
        || outline.totalInteractions < outline.interactions.length
        || !outline.interactions.every(isValidConversationSummary)) {
        return false;
    }
    var ids = new Set(outline.interactions.map(summary => summary.id));
    return ids.size === outline.interactions.length;
}

function isValidConversationError(error, state) {
    if (!hasExactConversationKeys(error, ['code'], ['reason', 'retryAfterMs'])
        || !ACTIVE_AI_SESSION_CONVERSATION_ERROR_CODES.includes(error.code)
        || (error.reason !== undefined
            && !ACTIVE_AI_SESSION_CONVERSATION_ERROR_REASONS.includes(error.reason))) {
        return false;
    }
    if (error.reason === undefined) {
        return error.retryAfterMs === undefined;
    }
    if ([
        'updateCodex', 'unsupportedCodexProtocol',
        'reconnectingCodex', 'codexRetryExhausted',
    ].includes(error.reason)
        && state.provider !== 'codex') {
        return false;
    }
    if (error.reason === 'codexRetryExhausted') {
        return error.code === 'unavailable'
            && Number.isSafeInteger(error.retryAfterMs)
            && error.retryAfterMs > 0
            && error.retryAfterMs
                <= ACTIVE_AI_SESSION_CONVERSATION_MAX_RETRY_AFTER_MS;
    }
    if (error.retryAfterMs !== undefined) return false;
    if (error.reason === 'unsupportedCodexProtocol') {
        return error.code === 'unsupportedVersion';
    }
    return error.code === 'unavailable';
}

function clearActiveAiSessionConversationRetryTimer() {
    if (activeAiSessionConversationRetryTimer !== null) {
        window.clearTimeout(activeAiSessionConversationRetryTimer);
        activeAiSessionConversationRetryTimer = null;
    }
    activeAiSessionConversationRetryDeadline = 0;
}

function clearConversationElement(element) {
    if (!element) return;
    while (element.firstChild) {
        element.removeChild(element.firstChild);
    }
}

function setActiveAiSessionConversationStatus(
    row,
    stateName,
    text,
    hint,
    retryAfterMs,
    retainedRetryDeadline
) {
    var panel = row && row.querySelector('[data-ai-session-conversation-panel]');
    var status = panel && panel.querySelector('.ai-session-conversation-loading');
    if (!status) return null;
    clearConversationElement(status);
    status.hidden = false;
    status.setAttribute('data-ai-session-conversation-state', '');
    status.setAttribute('data-state', stateName);
    var textNode = document.createElement('span');
    textNode.textContent = text;
    status.appendChild(textNode);
    if (hint) {
        var hintNode = document.createElement('span');
        hintNode.className = 'ai-session-conversation-state-hint';
        hintNode.textContent = hint;
        status.appendChild(hintNode);
    }
    if (stateName !== 'loading' && stateName !== 'empty'
        && stateName !== 'partial') {
        var retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'ai-session-conversation-retry';
        retry.setAttribute('data-action', 'retry-ai-session-conversation');
        retry.textContent = 'Retry';
        var requestedDelay = Number.isSafeInteger(retryAfterMs) && retryAfterMs > 0
            ? retryAfterMs
            : 0;
        var hasRetainedDeadline = Number.isFinite(retainedRetryDeadline);
        var retryDeadline = hasRetainedDeadline
            ? retainedRetryDeadline
            : requestedDelay > 0
                ? Date.now() + requestedDelay
                : 0;
        var delay = Math.max(0, retryDeadline - Date.now());
        retry.disabled = delay > 0;
        retry.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            if (retry.disabled
                || activeAiSessionConversationSubscription === null) return;
            var currentRow = getCurrentActiveAiSessionConversationRow(
                activeAiSessionConversationSubscription
            );
            if (currentRow === row) {
                requestActiveAiSessionConversation(row);
            }
        });
        status.appendChild(retry);
        if (delay > 0) {
            activeAiSessionConversationRetryDeadline = retryDeadline;
            var retryState = activeAiSessionConversationSubscription;
            var enableRetry = () => {
                if (activeAiSessionConversationSubscription !== retryState
                    || !retry.isConnected) {
                    clearActiveAiSessionConversationRetryTimer();
                    return;
                }
                var remaining = activeAiSessionConversationRetryDeadline - Date.now();
                if (remaining > 0) {
                    activeAiSessionConversationRetryTimer = window.setTimeout(
                        enableRetry,
                        remaining
                    );
                    return;
                }
                retry.disabled = false;
                activeAiSessionConversationRetryTimer = null;
                activeAiSessionConversationRetryDeadline = 0;
                if (retryState.validatedRender?.kind === 'error') {
                    retryState.validatedRender.retryDeadline = 0;
                }
            };
            activeAiSessionConversationRetryTimer = window.setTimeout(
                enableRetry,
                delay
            );
        }
    }
    return status;
}

function prepareActiveAiSessionConversationLoading(row) {
    clearActiveAiSessionConversationRetryTimer();
    var panel = row && row.querySelector('[data-ai-session-conversation-panel]');
    var rail = panel && panel.querySelector('[data-ai-session-conversation-rail]');
    var count = panel && panel.querySelector('[data-ai-session-conversation-count]');
    if (!panel || !rail || !count) return false;
    clearConversationElement(rail);
    rail.hidden = true;
    count.textContent = '0';
    setActiveAiSessionConversationStatus(
        row,
        'loading',
        'Loading conversation…'
    );
    return true;
}

function getActiveAiSessionConversationTarget(row) {
    if (!row || typeof row.closest !== 'function') return null;
    var projectDiv = row.closest('.project[data-id]');
    var projectId = projectDiv && projectDiv.getAttribute('data-id');
    var provider = row.getAttribute('data-session-provider');
    var sessionId = row.getAttribute('data-session-id');
    if (!projectId || !sessionId
        || (provider !== 'codex' && provider !== 'kimi' && provider !== 'claude')) {
        return null;
    }
    return { projectId: projectId, provider: provider, sessionId: sessionId };
}

function getActiveAiSessionConversationKey(target) {
    return target
        ? JSON.stringify([target.projectId, target.provider, target.sessionId])
        : null;
}

function nextActiveAiSessionConversationEnvelope(target) {
    activeAiSessionConversationRequestId += 1;
    activeAiSessionConversationGeneration += 1;
    return {
        version: 1,
        requestId: activeAiSessionConversationRequestId,
        subscriptionGeneration: activeAiSessionConversationGeneration,
        projectId: target.projectId,
        provider: target.provider,
        sessionId: target.sessionId,
    };
}

function requestActiveAiSessionConversation(row, restoreState) {
    var target = getActiveAiSessionConversationTarget(row);
    if (!target || !window.vscode || typeof window.vscode.postMessage !== 'function') {
        return false;
    }
    prepareActiveAiSessionConversationLoading(row);
    var envelope = nextActiveAiSessionConversationEnvelope(target);
    activeAiSessionConversationSubscription = Object.assign({}, target, envelope, {
        outlineRequestId: envelope.requestId,
        requestId: activeAiSessionConversationRequestId,
        expanded: true,
        sourceRevision: null,
        interactionIds: new Set(),
        hasRenderedOutline: false,
        validatedRender: null,
        restoreState: restoreState || null,
    });
    window.vscode.postMessage(Object.assign({
        type: 'request-ai-session-conversation-outline',
    }, envelope));
    return true;
}

function cancelActiveAiSessionConversation(target) {
    target = target || activeAiSessionConversationSubscription;
    clearActiveAiSessionConversationRetryTimer();
    if (!target || !window.vscode || typeof window.vscode.postMessage !== 'function') {
        activeAiSessionConversationSubscription = null;
        expandedActiveAiSessionConversationKey = null;
        disconnectActiveAiSessionConversationResizeObserver();
        return false;
    }
    var envelope = nextActiveAiSessionConversationEnvelope(target);
    window.vscode.postMessage(Object.assign({
        type: 'cancel-ai-session-conversation',
    }, envelope));
    activeAiSessionConversationSubscription = null;
    expandedActiveAiSessionConversationKey = null;
    disconnectActiveAiSessionConversationResizeObserver();
    return true;
}

function getCurrentActiveAiSessionConversationRow(state) {
    if (!state
        || typeof document === 'undefined'
        || typeof document.querySelectorAll !== 'function') return null;
    return Array.from(document.querySelectorAll(
        '.workspace-card[data-current-workspace][data-id] '
        + '.active-ai-session-row[data-conversation-expanded][data-session-focused]'
    )).find(row => {
        var target = getActiveAiSessionConversationTarget(row);
        return target
            && target.projectId === state.projectId
            && target.provider === state.provider
            && target.sessionId === state.sessionId
            && getActiveAiSessionConversationKey(target)
                === expandedActiveAiSessionConversationKey;
    }) || null;
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
        '.active-ai-session-row[data-conversation-expanded]'
        + '[data-session-focused][data-session-provider][data-session-id]'
    )).find(candidate =>
        candidate.getAttribute('data-session-provider') === origin.provider
        && candidate.getAttribute('data-session-id') === origin.sessionId
    );
    if (row) {
        var marker = Array.from(row.querySelectorAll(
            '[data-ai-session-conversation-marker][data-interaction-id]'
        )).find(candidate =>
            candidate.getAttribute('data-interaction-id')
                === origin.interactionId
        );
        var header = row.querySelector('.ai-session-primary-action');
        if (marker && typeof marker.focus === 'function') {
            marker.focus({ preventScroll: true });
        }
        if (marker && document.activeElement === marker) {
            return true;
        }
        if (header && typeof header.focus === 'function') {
            header.focus({ preventScroll: true });
        }
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

function setConversationMarkerSelection(markers, index, shouldFocus) {
    if (!markers.length) return;
    var bounded = Math.max(0, Math.min(markers.length - 1, index));
    markers.forEach((marker, markerIndex) => {
        var selected = markerIndex === bounded;
        marker.tabIndex = selected ? 0 : -1;
        marker.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
    if (shouldFocus) {
        markers[bounded]?.focus({ preventScroll: true });
    }
}

function focusConversationMarker(markers, index) {
    setConversationMarkerSelection(markers, index, true);
}

function activateConversationMarker(marker, state, vscode) {
    if (!marker || !state || !state.expanded || !state.sourceRevision
        || state !== activeAiSessionConversationSubscription
        || getCurrentActiveAiSessionConversationRow(state) === null
        || !vscode || typeof vscode.postMessage !== 'function') return;
    var interactionId = marker.getAttribute('data-interaction-id') || '';
    if (!state.interactionIds.has(interactionId)) return;
    activeAiSessionConversationRequestId += 1;
    state.requestId = activeAiSessionConversationRequestId;
    vscode.postMessage({
        type: 'open-ai-session-conversation',
        version: 1,
        requestId: state.requestId,
        subscriptionGeneration: state.subscriptionGeneration,
        projectId: state.projectId,
        provider: state.provider,
        sessionId: state.sessionId,
        interactionId: interactionId,
        expectedRevision: state.sourceRevision,
    });
}

function getConversationTimestampLabel(timestamp) {
    if (timestamp === undefined) return 'Time unavailable';
    try {
        return new Date(timestamp).toISOString();
    } catch (_error) {
        return 'Time unavailable';
    }
}

function getConversationAutoScrollThreshold(rail) {
    var value = rail && rail.getAttribute('data-auto-scroll-threshold');
    if (typeof value !== 'string'
        || !/^(?:\d+|\d*\.\d+)$/.test(value.trim())) return null;
    var threshold = Number(value);
    return Number.isFinite(threshold) && threshold >= 0 ? threshold : null;
}

function getConversationMarkerKey(marker) {
    return marker.getAttribute('data-interaction-id') || '';
}

function captureConversationRailState(rail) {
    var endThreshold = getConversationAutoScrollThreshold(rail);
    return window.__agentPivotScrollState.capture(rail, {
        itemSelector:
            '[data-ai-session-conversation-marker][data-interaction-id]',
        getKey: getConversationMarkerKey,
        endThreshold: endThreshold === null ? undefined : endThreshold,
    });
}

function restoreConversationRailState(rail, anchor) {
    return window.__agentPivotScrollState.restore(rail, anchor, {
        itemSelector:
            '[data-ai-session-conversation-marker][data-interaction-id]',
        getKey: getConversationMarkerKey,
        followEnd: true,
    });
}

function revealConversationMarker(rail, marker) {
    if (!rail || !marker || rail.scrollHeight <= rail.clientHeight) return;
    var railRect = rail.getBoundingClientRect();
    var markerRect = marker.getBoundingClientRect();
    if (markerRect.bottom > railRect.bottom) {
        rail.scrollTop += markerRect.bottom - railRect.bottom;
    } else if (markerRect.top < railRect.top) {
        rail.scrollTop -= railRect.top - markerRect.top;
    }
}

function handleConversationMarkerKeydown(event, marker, state) {
    var rail = marker && marker.closest('[data-ai-session-conversation-rail]');
    var markers = rail ? Array.from(rail.querySelectorAll(
        '[data-ai-session-conversation-marker]'
    )) : [];
    var index = markers.indexOf(marker);
    if (index < 0) return;
    var destination = null;
    if (event.key === 'ArrowUp') destination = index - 1;
    else if (event.key === 'ArrowDown') destination = index + 1;
    else if (event.key === 'Home') destination = 0;
    else if (event.key === 'End') destination = markers.length - 1;
    else if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        activateConversationMarker(marker, state, window.vscode);
        return;
    } else {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    focusConversationMarker(markers, destination);
    revealConversationMarker(
        rail,
        markers[Math.max(0, Math.min(markers.length - 1, destination))]
    );
}

function renderActiveAiSessionConversationOutline(row, state, outline) {
    var panel = row && row.querySelector('[data-ai-session-conversation-panel]');
    var rail = panel && panel.querySelector('[data-ai-session-conversation-rail]');
    var count = panel && panel.querySelector('[data-ai-session-conversation-count]');
    var status = panel && panel.querySelector('.ai-session-conversation-loading');
    if (!panel || !rail || !count || !status) return false;

    clearActiveAiSessionConversationRetryTimer();
    var currentRailAnchor = captureConversationRailState(rail);
    var focusedMarker = rail.querySelector(
        '[data-ai-session-conversation-marker]:focus'
    );
    var focusedInteractionId = focusedMarker
        ? focusedMarker.getAttribute('data-interaction-id') || ''
        : '';
    var restoreState = state.restoreState;
    state.restoreState = null;

    clearConversationElement(rail);
    state.sourceRevision = outline.sourceRevision;
    state.interactionIds = new Set(outline.interactions.map(summary => summary.id));
    state.validatedRender = {
        kind: 'outline',
        outline: outline,
    };
    var retainedFocusedInteractionId = restoreState?.focusedInteractionId
        || focusedInteractionId;
    var selectedInteractionId = retainedFocusedInteractionId
        || outline.interactions.at(-1)?.id
        || '';

    outline.interactions.forEach((summary, index) => {
        var marker = document.createElement('button');
        var preview = truncateConversationPreview(summary.userPreview);
        marker.type = 'button';
        marker.className = 'ai-session-conversation-marker';
        marker.setAttribute('data-ai-session-conversation-marker', '');
        marker.setAttribute('data-interaction-id', summary.id);
        marker.setAttribute('data-response-state', summary.responseState);
        marker.setAttribute('role', 'option');
        var stroke = document.createElement('span');
        var previewNode = document.createElement('span');
        stroke.className = 'ai-session-conversation-marker-stroke';
        stroke.setAttribute('aria-hidden', 'true');
        previewNode.className = 'ai-session-conversation-marker-preview';
        previewNode.textContent = preview;
        marker.appendChild(stroke);
        marker.appendChild(previewNode);
        var label = getConversationTimestampLabel(summary.timestamp)
            + ' — ' + preview;
        marker.title = label;
        marker.setAttribute('aria-label', label);
        if (index === outline.interactions.length - 1) {
            marker.setAttribute('data-latest', '');
        }
        if (summary.responseState === 'inProgress') {
            marker.setAttribute('data-current', '');
        }
        marker.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            focusConversationMarker(markers, index);
            activateConversationMarker(marker, state, window.vscode);
        });
        marker.addEventListener('keydown', event => {
            handleConversationMarkerKeydown(event, marker, state);
        });
        rail.appendChild(marker);
    });

    var markers = Array.from(rail.querySelectorAll(
        '[data-ai-session-conversation-marker]'
    ));
    var selectedIndex = markers.findIndex(marker =>
        marker.getAttribute('data-interaction-id') === selectedInteractionId
    );
    if (selectedIndex >= 0) {
        setConversationMarkerSelection(markers, selectedIndex, false);
    } else if (retainedFocusedInteractionId) {
        markers.forEach(marker => {
            marker.tabIndex = -1;
            marker.setAttribute('aria-selected', 'false');
        });
    } else {
        setConversationMarkerSelection(markers, markers.length - 1, false);
    }

    var hasOmittedInteractions = outline.partial
        || outline.totalInteractions > outline.interactions.length;
    count.textContent = hasOmittedInteractions
        && outline.totalInteractions > ACTIVE_AI_SESSION_CONVERSATION_MAX_INTERACTIONS
        ? '2,000+'
        : String(outline.totalInteractions);
    if (!markers.length) {
        rail.hidden = true;
        setActiveAiSessionConversationStatus(
            row,
            'empty',
            'No user inputs yet'
        );
        state.hasRenderedOutline = true;
        syncActiveAiSessionConversationListHeight(row);
        return true;
    }

    rail.hidden = false;
    if (hasOmittedInteractions) {
        setActiveAiSessionConversationStatus(
            row,
            'partial',
            'Older inputs omitted'
        );
    } else {
        status.hidden = true;
        status.removeAttribute('data-state');
    }
    syncActiveAiSessionConversationListHeight(row);

    var retainedFocusedMarker = retainedFocusedInteractionId
        ? markers.find(marker =>
            marker.getAttribute('data-interaction-id')
                === retainedFocusedInteractionId
        )
        : null;
    var railAnchor = restoreState?.railAnchor || currentRailAnchor;
    restoreConversationRailState(rail, railAnchor);
    if (retainedFocusedMarker) {
        focusConversationMarker(
            markers,
            markers.indexOf(retainedFocusedMarker)
        );
        restoreConversationRailState(rail, railAnchor);
    }
    state.hasRenderedOutline = true;
    return true;
}

function renderActiveAiSessionConversationError(
    row,
    state,
    error,
    retainedRetryDeadline
) {
    clearActiveAiSessionConversationRetryTimer();
    var panel = row && row.querySelector('[data-ai-session-conversation-panel]');
    var rail = panel && panel.querySelector('[data-ai-session-conversation-rail]');
    var count = panel && panel.querySelector('[data-ai-session-conversation-count]');
    if (!panel || !rail || !count) return false;
    clearConversationElement(rail);
    rail.hidden = true;
    count.textContent = '0';
    state.sourceRevision = null;
    state.interactionIds = new Set();
    state.hasRenderedOutline = false;
    state.restoreState = null;

    var stateName = error.code === 'staleRevision' ? 'stale' : 'unavailable';
    var text = error.code === 'staleRevision'
        ? 'Conversation history changed'
        : error.code === 'tooLarge'
            ? 'Conversation history is too large'
            : error.code === 'timeout'
                ? 'Conversation history timed out'
                : 'Conversation history unavailable';
    var hint = '';
    if (error.reason === 'reconnectingCodex') {
        stateName = 'reconnecting';
        text = 'Reconnecting to Codex…';
    } else if (error.reason === 'codexRetryExhausted') {
        text = 'Codex conversation history unavailable';
    } else if (error.reason === 'updateCodex') {
        text = 'Update Codex to view conversation history';
    } else if (error.reason === 'unsupportedCodexProtocol') {
        text = 'Installed Codex protocol is not supported';
        hint = 'Compare your installed Codex and Agent Pivot versions';
    }
    setActiveAiSessionConversationStatus(
        row,
        stateName,
        text,
        hint,
        error.retryAfterMs,
        retainedRetryDeadline
    );
    state.validatedRender = {
        kind: 'error',
        error: error,
        retryDeadline: activeAiSessionConversationRetryDeadline,
    };
    syncActiveAiSessionConversationListHeight(row);
    return true;
}

function applyAiSessionConversationOutlineResult(message) {
    var state = activeAiSessionConversationSubscription;
    var hasPayload = isPlainConversationObject(message)
        && Object.prototype.hasOwnProperty.call(message, 'payload');
    var hasError = isPlainConversationObject(message)
        && Object.prototype.hasOwnProperty.call(message, 'error');
    var messageKeys = [
        'type', 'version', 'requestId', 'subscriptionGeneration',
        'projectId', 'provider', 'sessionId',
    ];
    if (!state
        || !hasExactConversationKeys(
            message,
            messageKeys.concat(hasPayload ? ['payload'] : ['error']),
            []
        )
        || hasPayload === hasError
        || message.type !== 'ai-session-conversation-outline-result'
        || message.version !== 1
        || !Number.isSafeInteger(message.requestId)
        || message.requestId < 1
        || !Number.isSafeInteger(message.subscriptionGeneration)
        || message.subscriptionGeneration < 0
        || !isBoundedConversationIdentity(message.projectId)
        || (message.provider !== 'codex'
            && message.provider !== 'kimi'
            && message.provider !== 'claude')
        || !isBoundedConversationIdentity(message.sessionId)
        || message.requestId !== state.outlineRequestId
        || message.subscriptionGeneration !== state.subscriptionGeneration
        || message.projectId !== state.projectId
        || message.provider !== state.provider
        || message.sessionId !== state.sessionId) {
        return false;
    }
    var row = getCurrentActiveAiSessionConversationRow(state);
    if (!row) return false;
    if (hasPayload) {
        if (!isValidConversationOutline(message.payload, state)) return false;
        return renderActiveAiSessionConversationOutline(
            row,
            state,
            message.payload
        );
    }
    return isValidConversationError(message.error, state)
        && renderActiveAiSessionConversationError(row, state, message.error);
}

function disconnectActiveAiSessionConversationResizeObserver() {
    if (activeAiSessionConversationResizeObserver) {
        activeAiSessionConversationResizeObserver.disconnect();
        activeAiSessionConversationResizeObserver = null;
    }
    if (activeAiSessionConversationMutationObserver) {
        activeAiSessionConversationMutationObserver.disconnect();
        activeAiSessionConversationMutationObserver = null;
    }
}

function getExpandedActiveAiSessionConversationRow() {
    if (typeof document === 'undefined' || typeof document.querySelector !== 'function') {
        return null;
    }
    return document.querySelector(
        '.active-ai-session-row[data-conversation-expanded]'
    );
}

function syncActiveAiSessionConversationListHeight(row) {
    row = row || getExpandedActiveAiSessionConversationRow();
    if (!row || !row.hasAttribute('data-conversation-expanded')) return false;
    var panel = row.querySelector('[data-ai-session-conversation-panel]');
    var conversationHeader = panel && panel.querySelector('header');
    var list = row.closest('.codex-sessions-list');
    if (!panel || !conversationHeader || !list) return false;

    var collapsedRowHeight = Number(row.__stewardCollapsedConversationHeight);
    if (!Number.isFinite(collapsedRowHeight) || collapsedRowHeight <= 0) {
        collapsedRowHeight = Math.max(
            0,
            row.getBoundingClientRect().height - panel.getBoundingClientRect().height
        );
        row.__stewardCollapsedConversationHeight = collapsedRowHeight;
    }
    var collapsedListHeight = Number(list.__stewardCollapsedConversationHeight);
    if (!Number.isFinite(collapsedListHeight) || collapsedListHeight <= 0) {
        collapsedListHeight = list.getBoundingClientRect().height;
        list.__stewardCollapsedConversationHeight = collapsedListHeight;
    }

    var panelStyle = typeof getComputedStyle === 'function'
        ? getComputedStyle(panel)
        : null;
    var panelVerticalChrome = panelStyle
        ? [
            'marginTop', 'marginBottom',
            'paddingTop', 'paddingBottom',
            'borderTopWidth', 'borderBottomWidth',
        ]
            .reduce((total, property) =>
                total + (parseFloat(panelStyle[property]) || 0), 0)
        : 0;
    var conversationHeaderHeight = conversationHeader.getBoundingClientRect().height;
    var rail = panel.querySelector('[data-ai-session-conversation-rail]');
    var autoScrollThreshold = getConversationAutoScrollThreshold(rail);
    var railWasAtEnd = rail
        && autoScrollThreshold !== null
        && rail.scrollHeight - rail.clientHeight - rail.scrollTop
            <= autoScrollThreshold;
    row.style.removeProperty(
        '--steward-ai-session-conversation-rail-height'
    );
    var visiblePanelContent = Array.from(panel.children).filter(child =>
        child !== conversationHeader
        && !child.hidden
        && (typeof getComputedStyle !== 'function'
            || getComputedStyle(child).display !== 'none')
    );
    var railScrollHeight = rail ? rail.scrollHeight || 0 : 0;
    var railStyle = rail && typeof getComputedStyle === 'function'
        ? getComputedStyle(rail)
        : null;
    var railMaxHeight = railStyle
        ? parseFloat(railStyle.maxHeight)
        : Number.NaN;
    var naturalRailHeight = rail && visiblePanelContent.includes(rail)
        ? Math.min(
            railScrollHeight,
            Number.isFinite(railMaxHeight) && railMaxHeight > 0
                ? railMaxHeight
                : railScrollHeight
        )
        : 0;
    var naturalContentHeight = visiblePanelContent.reduce((total, child) =>
        total + (child === rail
            ? naturalRailHeight
            : Math.max(
                child.scrollHeight || 0,
                child.getBoundingClientRect().height || 0
            )), 0);
    var naturalPanelHeight = conversationHeaderHeight
        + naturalContentHeight
        + panelVerticalChrome;
    var naturalExpandedHeight = collapsedRowHeight + naturalPanelHeight;
    var expansionDelta = Math.max(
        0,
        naturalExpandedHeight - collapsedRowHeight
    );
    var availableListHeight = Math.max(
        collapsedRowHeight + conversationHeaderHeight + 72,
        window.innerHeight - list.getBoundingClientRect().top - 8
    );
    var renderedListHeight = Math.min(
        collapsedListHeight + expansionDelta,
        availableListHeight
    );
    var railHeight = Math.max(
        72,
        renderedListHeight
            - collapsedRowHeight
            - conversationHeaderHeight
            - panelVerticalChrome
    );
    list.style.setProperty(
        '--steward-ai-session-expanded-extra-height',
        Math.max(0, renderedListHeight - collapsedListHeight) + 'px'
    );
    if (naturalRailHeight > 0) {
        row.style.setProperty(
            '--steward-ai-session-conversation-rail-height',
            Math.min(naturalRailHeight, railHeight) + 'px'
        );
        if (railWasAtEnd) {
            rail.scrollTop = Math.max(0, rail.scrollHeight - rail.clientHeight);
        }
    }
    return true;
}

function observeActiveAiSessionConversationSize(row) {
    disconnectActiveAiSessionConversationResizeObserver();
    var list = row && row.closest('.codex-sessions-list');
    var panel = row && row.querySelector(
        '[data-ai-session-conversation-panel]'
    );
    if (typeof ResizeObserver !== 'undefined' && row && list) {
        activeAiSessionConversationResizeObserver = new ResizeObserver(() => {
            syncActiveAiSessionConversationListHeight(row);
        });
        activeAiSessionConversationResizeObserver.observe(row);
        activeAiSessionConversationResizeObserver.observe(list);
    }
    if (typeof MutationObserver !== 'undefined' && panel) {
        activeAiSessionConversationMutationObserver = new MutationObserver(
            () => syncActiveAiSessionConversationListHeight(row)
        );
        activeAiSessionConversationMutationObserver.observe(panel, {
            attributes: true,
            attributeFilter: ['hidden'],
            childList: true,
            subtree: true,
        });
    }
    if (!activeAiSessionConversationResizeFallbackInstalled
        && typeof window !== 'undefined'
        && typeof window.addEventListener === 'function') {
        window.addEventListener('resize', () => {
            syncActiveAiSessionConversationListHeight();
        });
        activeAiSessionConversationResizeFallbackInstalled = true;
    }
}

function applyActiveAiSessionConversationState(row, expanded, reveal) {
    if (!row || typeof row.querySelector !== 'function') return false;
    var panel = row.querySelector('[data-ai-session-conversation-panel]');
    var header = row.querySelector('.ai-session-primary-action[aria-controls]');
    var chevron = row.querySelector('.ai-session-conversation-chevron');
    var list = row.closest('.codex-sessions-list');
    if (!panel || !header || !chevron || !list) return false;

    if (expanded) {
        var otherRow = getExpandedActiveAiSessionConversationRow();
        if (otherRow && otherRow !== row) {
            applyActiveAiSessionConversationState(otherRow, false);
        }
        list.style.removeProperty('--steward-ai-session-expanded-extra-height');
        list.__stewardCollapsedConversationHeight = list.getBoundingClientRect().height;
        row.__stewardCollapsedConversationHeight = row.getBoundingClientRect().height;
        row.setAttribute('data-conversation-expanded', '');
        panel.hidden = false;
        header.setAttribute('aria-expanded', 'true');
        chevron.setAttribute('data-expanded', '');
        expandedActiveAiSessionConversationKey = getActiveAiSessionConversationKey(
            getActiveAiSessionConversationTarget(row)
        );
        syncActiveAiSessionConversationListHeight(row);
        observeActiveAiSessionConversationSize(row);
        if (expanded && reveal && typeof row.scrollIntoView === 'function') {
            row.scrollIntoView({ block: 'nearest' });
        }
        return true;
    }

    row.removeAttribute('data-conversation-expanded');
    panel.hidden = true;
    header.setAttribute('aria-expanded', 'false');
    chevron.removeAttribute('data-expanded');
    row.style.removeProperty('--steward-ai-session-conversation-rail-height');
    list.style.removeProperty('--steward-ai-session-expanded-extra-height');
    list.__stewardCollapsedConversationHeight = null;
    row.__stewardCollapsedConversationHeight = null;
    if (expandedActiveAiSessionConversationKey === getActiveAiSessionConversationKey(
        getActiveAiSessionConversationTarget(row)
    )) {
        expandedActiveAiSessionConversationKey = null;
    }
    prepareActiveAiSessionConversationLoading(row);
    disconnectActiveAiSessionConversationResizeObserver();
    return true;
}

function toggleActiveAiSessionConversation(row) {
    var expanded = row && row.hasAttribute('data-conversation-expanded');
    if (expanded) {
        applyActiveAiSessionConversationState(row, false);
        cancelActiveAiSessionConversation();
        return false;
    }

    var previousRow = getExpandedActiveAiSessionConversationRow();
    if (previousRow && previousRow !== row) {
        var previousTarget = getActiveAiSessionConversationTarget(previousRow);
        applyActiveAiSessionConversationState(previousRow, false);
        cancelActiveAiSessionConversation(previousTarget);
    }
    if (!applyActiveAiSessionConversationState(row, true, true)) return false;
    requestActiveAiSessionConversation(row);
    return true;
}

function collapseActiveAiSessionConversation() {
    var row = getExpandedActiveAiSessionConversationRow();
    if (!row) return false;
    var target = getActiveAiSessionConversationTarget(row);
    applyActiveAiSessionConversationState(row, false);
    cancelActiveAiSessionConversation(target);
    return true;
}

function disposeActiveAiSessionConversation() {
    clearActiveAiSessionConversationRetryTimer();
    if (activeAiSessionConversationSubscription) {
        activeAiSessionConversationSubscription.expanded = false;
    }
    activeAiSessionConversationSubscription = null;
    expandedActiveAiSessionConversationKey = null;
    disconnectActiveAiSessionConversationResizeObserver();
}

function captureExpandedConversationState(projectDiv) {
    if (!projectDiv || typeof projectDiv.querySelector !== 'function') {
        return null;
    }
    var row = projectDiv.querySelector(
        '.active-ai-session-row[data-conversation-expanded]'
    );
    var rail = row?.querySelector('[data-ai-session-conversation-rail]');
    var marker = rail?.querySelector('[data-ai-session-conversation-marker]:focus');
    return row ? {
        provider: row.getAttribute('data-session-provider') || '',
        sessionId: row.getAttribute('data-session-id') || '',
        expanded: true,
        railAnchor: captureConversationRailState(rail),
        focusedInteractionId: marker?.getAttribute('data-interaction-id') || '',
    } : null;
}

function canRestoreExpandedConversation(projectDiv, state) {
    if (!state?.expanded
        || !projectDiv
        || typeof projectDiv.querySelectorAll !== 'function') return null;
    return Array.from(projectDiv.querySelectorAll(
        '.active-ai-session-row[data-session-focused]'
    )).find(row =>
        row.getAttribute('data-session-provider') === state.provider
        && row.getAttribute('data-session-id') === state.sessionId
    ) || null;
}

function rebindActiveAiSessionConversation(row, capturedState) {
    var target = getActiveAiSessionConversationTarget(row);
    var subscription = activeAiSessionConversationSubscription;
    if (!target || !subscription
        || getActiveAiSessionConversationKey(target)
            !== getActiveAiSessionConversationKey(subscription)) {
        return false;
    }
    if (row.hasAttribute('data-conversation-expanded')
        && !applyActiveAiSessionConversationState(row, false)) {
        return false;
    }
    if (!applyActiveAiSessionConversationState(row, true, false)) return false;
    subscription.expanded = true;
    if (capturedState && (!subscription.restoreState
        || subscription.validatedRender?.kind === 'outline')) {
        subscription.restoreState = capturedState;
    }
    if (subscription.validatedRender?.kind === 'outline') {
        renderActiveAiSessionConversationOutline(
            row,
            subscription,
            subscription.validatedRender.outline
        );
    } else if (subscription.validatedRender?.kind === 'error') {
        renderActiveAiSessionConversationError(
            row,
            subscription,
            subscription.validatedRender.error,
            subscription.validatedRender.retryDeadline
        );
    } else {
        prepareActiveAiSessionConversationLoading(row);
        syncActiveAiSessionConversationListHeight(row);
    }
    return true;
}

function captureCurrentWorkspaceConversationStates(root) {
    var states = new Map();
    if (!root || typeof root.querySelectorAll !== 'function') return states;
    root.querySelectorAll(
        '.workspace-card[data-current-workspace][data-id]'
    ).forEach(projectDiv => {
        var state = captureExpandedConversationState(projectDiv);
        var projectId = projectDiv.getAttribute('data-id');
        if (state && projectId) {
            states.set(projectId, state);
        }
    });
    if (states.size) {
        disconnectActiveAiSessionConversationResizeObserver();
    }
    return states;
}

function restoreCurrentWorkspaceConversationStates(root, states) {
    states = states || new Map();
    if (!root || typeof root.querySelectorAll !== 'function') {
        states.forEach((state, projectId) => {
            cancelActiveAiSessionConversation({
                projectId: projectId,
                provider: state.provider,
                sessionId: state.sessionId,
            });
        });
        return;
    }
    root.querySelectorAll(
        '.workspace-card[data-current-workspace][data-id]'
    ).forEach(projectDiv => {
        var projectId = projectDiv.getAttribute('data-id');
        var state = states.get(projectId);
        if (!state) return;
        var row = canRestoreExpandedConversation(projectDiv, state);
        if (!row || !rebindActiveAiSessionConversation(row, state)) {
            cancelActiveAiSessionConversation({
                projectId: projectId,
                provider: state.provider,
                sessionId: state.sessionId,
            });
        }
        states.delete(projectId);
    });
    states.forEach((state, projectId) => {
        cancelActiveAiSessionConversation({
            projectId: projectId,
            provider: state.provider,
            sessionId: state.sessionId,
        });
    });
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

function captureAiSessionViewState(projectDiv) {
    var activeList = projectDiv.querySelector('.ai-session-active-panel .codex-sessions-list');
    var historyList = projectDiv.querySelector('.ai-session-history-panel .codex-sessions-list');
    var focused = typeof document !== 'undefined' ? document.activeElement : null;
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
        focusedTab: focusedTab && focusedTab.getAttribute('data-ai-session-tab'),
        focusedRow: focusedRow ? {
            provider: focusedRow.getAttribute('data-session-provider') || '',
            sessionId: focusedRow.getAttribute('data-session-id') || '',
            pendingCreatedAt: focusedRow.getAttribute('data-pending-created-at') || '',
            panel: focusedRow.closest('[data-ai-session-panel]')?.getAttribute('data-ai-session-panel') || '',
        } : null,
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
                conversation: captureExpandedConversationState(projectDiv),
            });
        });
    if (Array.from(states.values()).some(state => state.conversation)) {
        disconnectActiveAiSessionConversationResizeObserver();
    }
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

function restoreCurrentWorkspaceAiSessionConversations(root, states) {
    var conversationStates = new Map();
    states.forEach((state, projectId) => {
        if (state.conversation) {
            conversationStates.set(projectId, state.conversation);
        }
    });
    restoreCurrentWorkspaceConversationStates(root, conversationStates);
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
            var focusedConversationMarker = state.conversation
                && state.conversation.focusedInteractionId
                ? Array.from(projectDiv.querySelectorAll(
                    '.active-ai-session-row[data-conversation-expanded] '
                    + '[data-ai-session-conversation-marker]'
                    + '[data-interaction-id]'
                )).find(marker =>
                    marker.getAttribute('data-interaction-id')
                        === state.conversation.focusedInteractionId
                    && document.activeElement === marker
                )
                : null;
            if (focusedConversationMarker) return;
            restoreAiSessionViewFocus(projectDiv, state.view, selectedTab);
        });
}

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
    restoreCurrentWorkspaceAiSessionConversations(replacement, aiSessionStates);
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
        restoreCurrentWorkspaceAiSessionConversations(wrapper, aiSessionStates);
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
    restoreCurrentWorkspaceAiSessionConversations(wrapper, aiSessionStates);
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

function getCollapseButtonState(tab, collapsedStates) {
    tab = tab === 'projects' || tab === 'todo' || tab === 'ai' ? tab : 'open';
    if (tab === 'ai') {
        return {
            disabled: true,
            collapsed: false,
            title: 'No groups to collapse in AI',
        };
    }
    var labels = tab === 'todo'
        ? {
            empty: 'No TODO groups to collapse',
            collapse: 'Collapse TODO Groups',
            expand: 'Expand TODO Groups',
        }
        : tab === 'open'
            ? {
                empty: 'No open windows to collapse',
                collapse: 'Collapse Open Windows',
                expand: 'Expand Open Windows',
            }
            : {
                empty: 'No project groups to collapse',
                collapse: 'Collapse All Groups',
                expand: 'Expand All Groups',
            };
    if (!collapsedStates.length) {
        return {
            disabled: true,
            collapsed: false,
            title: labels.empty,
        };
    }

    var collapsed = collapsedStates.every(Boolean);
    return {
        disabled: false,
        collapsed,
        title: collapsed ? labels.expand : labels.collapse,
    };
}

function syncTodoGroupCollapseControl(group) {
    if (!group || typeof group.querySelector !== 'function') {
        return;
    }
    var control = group.querySelector('[data-action="todo-collapse-group"]');
    if (!control) {
        return;
    }
    var collapsed = group.classList.contains('collapsed');
    var action = collapsed ? 'Expand' : 'Collapse';
    var heading = group.querySelector('h2');
    var groupTitle = heading ? String(heading.textContent || '').trim() : '';
    control.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    control.setAttribute('title', action + ' todo group');
    control.setAttribute('aria-label', action + (groupTitle ? ' ' + groupTitle : ' todo group'));
}

function syncTodoExpandControl(item, expanded) {
    if (!item || typeof item.querySelector !== 'function') {
        return;
    }
    var control = item.querySelector('[data-action="todo-toggle-expanded"]');
    if (!control) {
        return;
    }
    var action = expanded ? 'Collapse' : 'Expand';
    var titleElement = item.querySelector('.todo-title-text');
    var todoTitle = titleElement ? String(titleElement.textContent || '').trim() : '';
    control.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    control.setAttribute('title', action + ' todo');
    control.setAttribute('aria-label', action + (todoTitle ? ' ' + todoTitle : ' todo'));
}

function collapseTodoGroups(groups, collapsed, postMessage) {
    groups.forEach(group => {
        group.classList.toggle('collapsed', collapsed);
        syncTodoGroupCollapseControl(group);
    });
    postMessage({
        type: 'todo-collapse-groups',
        collapsed,
    });
}

var nextTodoMutationRequestId = 0;

function getTodoFormValue(form, name) {
    var checkedElement = form.querySelector('[name="' + name + '"]:checked');
    if (checkedElement) {
        return String(checkedElement.value || '').trim();
    }
    var element = form.querySelector('[name="' + name + '"]');
    return element ? String(element.value || '').trim() : '';
}

function setTodoComposePending(form, pending) {
    form.setAttribute('data-todo-pending', pending ? 'true' : 'false');
    var submitButton = form.querySelector('[type="submit"]');
    if (!submitButton)
        return;

    submitButton.disabled = pending;
    if (pending) {
        submitButton.setAttribute('aria-busy', 'true');
    } else {
        submitButton.removeAttribute('aria-busy');
    }
}

function submitTodoComposeForm(form, postMessage) {
    if (form.getAttribute('data-todo-pending') === 'true')
        return false;

    var title = getTodoFormValue(form, 'title');
    if (!title)
        return false;

    nextTodoMutationRequestId += 1;
    var requestId = nextTodoMutationRequestId;
    form.setAttribute('data-todo-request-id', String(requestId));
    setTodoComposePending(form, true);
    postMessage({
        type: 'todo-add',
        requestId,
        title,
        notes: getTodoFormValue(form, 'notes'),
        priority: getTodoFormValue(form, 'priority'),
        groupId: getTodoFormValue(form, 'groupId'),
    });
    return true;
}

function applyTodoMutationResult(message, root) {
    if (!message
        || message.type !== 'todo-mutation-result'
        || message.version !== 1
        || !Number.isSafeInteger(message.requestId)
        || message.requestId < 1
        || typeof message.success !== 'boolean') {
        return false;
    }

    var form = root.querySelector('.todo-add-form[data-todo-request-id="' + message.requestId + '"]');
    if (!form)
        return false;
    if (!message.success) {
        setTodoComposePending(form, false);
        form.removeAttribute('data-todo-request-id');
    } else if (message.panelRefreshed === false) {
        form.reset();
        setTodoComposePending(form, false);
        form.removeAttribute('data-todo-request-id');
    }
    return true;
}

var MAX_AI_SESSION_BATCH_ARCHIVE_RESULT_COUNT = 100;

function getBoundedAiSessionBatchArchiveResultCounts(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        return null;
    }
    var arrayFields = ['archived', 'running', 'missing', 'rejected', 'failed'];
    if (arrayFields.some(field =>
        !Array.isArray(result[field])
        || result[field].length > MAX_AI_SESSION_BATCH_ARCHIVE_RESULT_COUNT
    )) {
        return null;
    }
    if (!Number.isSafeInteger(result.rejectedCount)
        || result.rejectedCount < result.rejected.length
        || !Number.isSafeInteger(result.malformedCount)
        || result.rejectedCount < 0
        || result.malformedCount < 0) {
        return null;
    }
    var counts = {
        archived: result.archived.length,
        running: result.running.length,
        missing: result.missing.length,
        rejected: result.rejectedCount + result.malformedCount,
        failed: result.failed.length,
    };
    var total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    if (!Number.isSafeInteger(total)
        || total > MAX_AI_SESSION_BATCH_ARCHIVE_RESULT_COUNT) {
        return null;
    }
    return counts;
}

function formatAiSessionBatchArchiveCount(count, singular, plural) {
    return count + ' ' + (count === 1 ? singular : plural);
}

function getAiSessionBatchArchiveAnnouncement(message) {
    if (message.status === 'cancelled') {
        return 'Archive cancelled. No sessions were archived.';
    }
    if (message.status === 'rejected') {
        return 'Archive request was rejected. No sessions were archived.';
    }
    var counts = getBoundedAiSessionBatchArchiveResultCounts(message.result);
    if (!counts) {
        return 'Archive completed, but its result summary was unavailable.';
    }
    var parts = [
        'Archived ' + formatAiSessionBatchArchiveCount(
            counts.archived,
            'AI session',
            'AI sessions'
        ),
    ];
    if (counts.running) {
        parts.push('skipped ' + formatAiSessionBatchArchiveCount(
            counts.running,
            'running session',
            'running sessions'
        ));
    }
    if (counts.missing) {
        parts.push(formatAiSessionBatchArchiveCount(
            counts.missing,
            'session was',
            'sessions were'
        ) + ' no longer available');
    }
    if (counts.rejected) {
        parts.push(formatAiSessionBatchArchiveCount(
            counts.rejected,
            'invalid or out-of-scope selection was rejected',
            'invalid or out-of-scope selections were rejected'
        ));
    }
    if (counts.failed) {
        parts.push(formatAiSessionBatchArchiveCount(
            counts.failed,
            'session failed',
            'sessions failed'
        ));
    }
    return parts.join('; ') + '.';
}

function initProjects() {

    const ProjectOpenType = {
        Default: 0,
        NewWindow: 1,
        AddToWorkspace: 2,
        CurrentWindow: 3,
    };

    var batchAiSessionState = {
        projectId: null,
        selectedItems: new Map(),
        pending: false,
        requestId: null,
    };
    var activeAiSessionTerminalState = { provider: null, sessionId: null };
    var pendingWorkspaceSessionReveal = null;
    var nextAiSessionBatchArchiveRequestId = 0;
    var nextAiSessionProviderSelectionRequestId = 0;
    var pendingAiSessionProviderSelectionProjectId = null;
    var pendingAiSessionProviderSelectionRequestId = null;
    var pendingAiSessionProviderSelectionProviders = [];
    window.addEventListener('pagehide', disposeActiveAiSessionConversation);

    function isDedicatedTodoTarget(target) {
        return Boolean(window.__agentPivotTodo
            && target
            && target.closest
            && target.closest('#dashboard-tab-todo'));
    }

    function getAiSessionBatchItemKey(provider, sessionId) {
        return JSON.stringify([provider, sessionId]);
    }

    function enter(projectId) {
        if (batchAiSessionState.pending)
            return;
        batchAiSessionState.projectId = projectId;
        batchAiSessionState.selectedItems = new Map();
        batchAiSessionState.pending = false;
        batchAiSessionState.requestId = null;
    }

    function toggle(provider, sessionId, active) {
        if (!isAiSessionProvider(provider) || !sessionId || active || batchAiSessionState.pending)
            return;
        var key = getAiSessionBatchItemKey(provider, sessionId);
        if (batchAiSessionState.selectedItems.has(key))
            batchAiSessionState.selectedItems.delete(key);
        else
            batchAiSessionState.selectedItems.set(key, { provider, sessionId });
    }

    function selectUnpinned(sessions) {
        if (batchAiSessionState.pending)
            return;
        sessions
            .filter(session => isAiSessionProvider(session.provider)
                && session.id && !session.pinned && !session.active)
            .forEach(session => {
                var item = { provider: session.provider, sessionId: session.id };
                batchAiSessionState.selectedItems.set(
                    getAiSessionBatchItemKey(item.provider, item.sessionId),
                    item
                );
            });
    }

    function clear() {
        if (!batchAiSessionState.pending)
            batchAiSessionState.selectedItems.clear();
    }

    function reconcile(projectId, remainingItems) {
        if (projectId !== batchAiSessionState.projectId) {
            exit();
            return;
        }
        let selectedItems = batchAiSessionState.selectedItems;
        batchAiSessionState.selectedItems = new Map(
            remainingItems
                .filter(item => item && isAiSessionProvider(item.provider) && item.sessionId)
                .map(item => {
                    var key = getAiSessionBatchItemKey(item.provider, item.sessionId);
                    return [key, selectedItems.get(key)];
                })
                .filter(entry => entry[1])
        );
    }

    function reconcileVisible(projectDiv) {
        if (!projectDiv)
            return;
        var projectId = projectDiv.getAttribute('data-id');
        var remainingItems = Array.from(
            projectDiv.querySelectorAll('.ai-session-history-panel .codex-session-row[data-session-id]')
        )
            .filter(row => isAiSessionProvider(row.getAttribute('data-session-provider') || 'codex')
                && row.getAttribute('data-session-id')
                && !row.hasAttribute('data-session-active'))
            .map(row => ({
                provider: row.getAttribute('data-session-provider') || 'codex',
                sessionId: row.getAttribute('data-session-id'),
            }));
        reconcile(projectId, remainingItems);
    }

    function submit() {
        if (batchAiSessionState.pending || !batchAiSessionState.selectedItems.size)
            return;
        nextAiSessionBatchArchiveRequestId = nextAiSessionBatchArchiveRequestId >= Number.MAX_SAFE_INTEGER
            ? 1
            : nextAiSessionBatchArchiveRequestId + 1;
        var requestId = nextAiSessionBatchArchiveRequestId;
        batchAiSessionState.pending = true;
        batchAiSessionState.requestId = requestId;
        window.vscode.postMessage({
            type: 'archive-ai-sessions',
            version: 1,
            requestId: requestId,
            projectId: batchAiSessionState.projectId,
            items: Array.from(batchAiSessionState.selectedItems.values()),
        });
    }

    function complete(message) {
        if (!message
            || message.type !== 'ai-session-batch-archive-completed'
            || message.version !== 1
            || !Number.isSafeInteger(message.requestId)
            || message.requestId < 1
            || typeof message.projectId !== 'string'
            || !['cancelled', 'rejected', 'finished'].includes(message.status)
            || !batchAiSessionState.pending
            || message.projectId !== batchAiSessionState.projectId
            || message.requestId !== batchAiSessionState.requestId) {
            return false;
        }
        if (message.status === 'finished') {
            exit();
            return true;
        }
        batchAiSessionState.pending = false;
        batchAiSessionState.requestId = null;
        return true;
    }

    function exit() {
        batchAiSessionState.projectId = null;
        batchAiSessionState.selectedItems = new Map();
        batchAiSessionState.pending = false;
        batchAiSessionState.requestId = null;
    }

    function snapshot() {
        return {
            projectId: batchAiSessionState.projectId,
            selectedItems: Array.from(batchAiSessionState.selectedItems.values()),
            pending: batchAiSessionState.pending,
        };
    }

    var batchAiSessionManager = {
        enter, toggle, selectUnpinned, clear, reconcile, reconcileVisible,
        submit, complete, exit, snapshot,
    };
    window.__agentPivotBatchAiSessions = batchAiSessionManager;

    function openProject(projectId, projectOpenType) {
        window.vscode.postMessage({
            type: 'selected-project',
            projectId,
            projectOpenType,
        });
    }

    function onAddProjectClicked(e) {
        if (!e.target)
            return;

        var projectDiv = e.target.closest('.project');
        if (!projectDiv)
            return;

        var groupId = projectDiv.getAttribute("data-group-id");

        window.vscode.postMessage({
            type: 'add-project',
            groupId,
        });
    }

    function onImportFromOtherStorageClicked(e) {
        if (!e.target)
            return;

        window.vscode.postMessage({
            type: 'import-from-other-storage',
        });
    }

    function onInsideProjectClick(e, projectDiv) {
        projectDiv = projectDiv || e.target.closest(".project");
        var dataId = projectDiv && projectDiv.getAttribute("data-id");
        if (dataId == null)
            return;

        if (onTriggerAiSessionAction(e.target, dataId))
            return;

        if (onTriggerProjectAction(e.target, dataId))
            return;

        if (projectDiv.hasAttribute("data-current-workspace")) {
            if (e.target.closest('[data-ai-session-region]'))
                return;

            toggleCodexSessions(projectDiv, dataId);
            return;
        }

        if (projectDiv.hasAttribute("data-open-workspace-current")) {
            return;
        }

        if (projectDiv.hasAttribute("data-workspace-navigation")) {
            openProject(dataId, ProjectOpenType.Default);
            return;
        }

        var currentWindow = e.ctrlKey || e.metaKey;
        var newWindow = e.button === 1;
        openProject(dataId, currentWindow ? ProjectOpenType.CurrentWindow : newWindow ? ProjectOpenType.NewWindow : ProjectOpenType.Default);

    }

    function onTriggerAiSessionAction(target, projectId) {
        var projectDiv = target.closest('.project[data-id]');
        var tabAction = target.closest('[data-action="select-ai-session-tab"][data-tab]');
        if (tabAction) {
            var selectedTab = normalizeAiSessionTab(tabAction.getAttribute('data-tab'));
            selectAiSessionTabDom(projectDiv, selectedTab);
            writeAiSessionTabState(window.vscode, projectId, selectedTab);
            return true;
        }

        var providerMenuTrigger = target.closest('[data-ai-provider-menu-trigger]');
        if (providerMenuTrigger) {
            toggleAiSessionProviderMenu(projectDiv);
            return true;
        }

        var providerOption = target.closest('[data-ai-provider-option][data-provider]');
        if (providerOption) {
            activateAiSessionProviderOption(projectDiv, providerOption);
            return true;
        }

        var createAction = target.closest('[data-action="create-ai-session"]');
        if (createAction) {
            window.vscode.postMessage({
                type: 'create-ai-session',
                projectId,
            });

            return true;
        }

        var manageAction = target.closest('[data-action="manage-ai-sessions"][data-provider]');
        if (manageAction) {
            if (batchAiSessionState.pending
                || pendingAiSessionProviderSelectionProjectId)
                return true;

            var manageProvider = manageAction.getAttribute("data-provider");
            if (projectDiv && isAiSessionProvider(manageProvider)) {
                if (isActiveAiSessionBatchScope(projectId, manageProvider)) {
                    exitAiSessionBatchManagement();
                } else {
                    batchAiSessionManager.enter(projectId);
                    syncAiSessionBatchManagementDom(projectDiv);
                }
            }

            return true;
        }

        var selectUnpinnedAction = target.closest('[data-action="select-unpinned-ai-sessions"]');
        if (selectUnpinnedAction) {
            if (isActiveAiSessionBatchScope(projectId, getProjectActiveAiSessionProvider(projectDiv))) {
                var sessions = Array.from(projectDiv.querySelectorAll('.ai-session-history-panel .codex-session-row[data-session-id]'))
                    .map(row => ({
                        provider: row.getAttribute("data-session-provider") || "codex",
                        id: row.getAttribute("data-session-id"),
                        pinned: row.hasAttribute("data-session-pinned"),
                        active: row.hasAttribute("data-session-active"),
                    }));
                batchAiSessionManager.selectUnpinned(sessions);
                syncAiSessionBatchManagementDom(projectDiv);
            }

            return true;
        }

        var clearSelectionAction = target.closest('[data-action="clear-ai-session-selection"]');
        if (clearSelectionAction) {
            if (isActiveAiSessionBatchScope(projectId, getProjectActiveAiSessionProvider(projectDiv))) {
                batchAiSessionManager.clear();
                syncAiSessionBatchManagementDom(projectDiv);
            }

            return true;
        }

        var archiveSelectedAction = target.closest('[data-action="archive-selected-ai-sessions"]');
        if (archiveSelectedAction) {
            if (isActiveAiSessionBatchScope(projectId, getProjectActiveAiSessionProvider(projectDiv))) {
                batchAiSessionManager.submit();
                syncAiSessionBatchManagementDom(projectDiv);
            }

            return true;
        }

        var terminalAction = target.closest('[data-action="close-ai-session-terminal"], [data-action="detach-ai-session-terminal"]');
        if (terminalAction) {
            var terminalRow = terminalAction.closest('.codex-session-row[data-session-provider][data-session-backend]');
            var terminalProvider = terminalRow && terminalRow.getAttribute('data-session-provider');
            var terminalBackend = terminalRow && terminalRow.getAttribute('data-session-backend');
            var requestedDetach = terminalAction.getAttribute('data-action') === 'detach-ai-session-terminal';
            if (terminalRow && isAiSessionProvider(terminalProvider)
                && ((requestedDetach && terminalBackend === 'tmux')
                    || (!requestedDetach && terminalBackend === 'vscode'))) {
                var terminalMessage = {
                    type: requestedDetach ? 'detach-ai-session-terminal' : 'close-ai-session-terminal',
                    projectId,
                    provider: terminalProvider,
                };
                if (terminalRow.hasAttribute('data-session-pending')) {
                    terminalMessage.pendingCreatedAt = terminalRow.getAttribute('data-pending-created-at');
                } else {
                    terminalMessage.sessionId = terminalRow.getAttribute('data-session-id');
                }
                window.vscode.postMessage(terminalMessage);
            }
            return true;
        }

        var managedSessionRow = target.closest('.codex-session-row[data-session-id]');
        if (managedSessionRow) {
            var managedSessionProvider = managedSessionRow.getAttribute("data-session-provider") || "codex";
            if (isActiveAiSessionBatchScope(projectId, managedSessionProvider)
                && !managedSessionRow.hasAttribute('data-session-active')) {
                batchAiSessionManager.toggle(
                    managedSessionProvider,
                    managedSessionRow.getAttribute("data-session-id"),
                    managedSessionRow.hasAttribute('data-session-active')
                );
                syncAiSessionBatchManagementDom(projectDiv);
                return true;
            }
        }

        var pinAction = target.closest('[data-action="toggle-ai-session-pin"]');
        if (pinAction) {
            var pinRow = pinAction.closest('.codex-session-row[data-session-id]');
            var pinSessionId = pinRow && pinRow.getAttribute("data-session-id");
            var pinProvider = pinRow && pinRow.getAttribute("data-session-provider") || "codex";
            if (pinSessionId) {
                window.vscode.postMessage({
                    type: 'toggle-ai-session-pin',
                    projectId,
                    provider: pinProvider,
                    sessionId: pinSessionId,
                });
            }

            return true;
        }

        var archiveAction = target.closest('[data-action="archive-codex-session"], [data-action="archive-kimi-session"], [data-action="archive-claude-session"]');
        if (archiveAction) {
            var archiveRow = archiveAction.closest('.codex-session-row[data-session-id]');
            var archiveSessionId = archiveRow && archiveRow.getAttribute("data-session-id");
            var archiveProvider = archiveRow && archiveRow.getAttribute("data-session-provider") || "codex";
            if (archiveSessionId && isAiSessionProvider(archiveProvider)) {
                acknowledgeAiSessionRow(archiveRow);
                window.vscode.postMessage({
                    type: getArchiveAiSessionMessageType(archiveProvider),
                    projectId,
                    sessionId: archiveSessionId,
                });
            }

            return true;
        }

        var activation = getAiSessionCardActivation(target, projectId);
        if (!activation.handled)
            return false;
        if (activation.sessionRow
            && !activation.sessionRow.hasAttribute('data-session-pending')
            && activation.sessionRow.getAttribute('data-session-id')) {
            acknowledgeAiSessionRow(activation.sessionRow);
        }
        if (activation.toggleConversation) {
            toggleActiveAiSessionConversation(activation.sessionRow);
            return true;
        }
        if (activation.message?.type === 'focus-ai-session-terminal') {
            collapseActiveAiSessionConversation();
        }
        if (activation.message) {
            window.vscode.postMessage(activation.message);
        }
        return true;
    }

    function acknowledgeAiSessionRow(sessionRow) {
        if (!sessionRow || !sessionRow.hasAttribute('data-ai-session-attention')) return;
        var provider = sessionRow.getAttribute('data-session-provider') || 'codex';
        var sessionId = sessionRow.getAttribute('data-session-id') || '';
        var fallback = sessionRow.getAttribute('data-session-event-id') || sessionRow.getAttribute('data-ai-session-event-id');
        acknowledgeAiSession(provider, sessionId, fallback);
    }

    function acknowledgeAiSession(provider, sessionId, fallbackEventId) {
        var sessionKey = provider + ':' + sessionId;
        window.__agentPivotAttentionSessionEvents = window.__agentPivotAttentionSessionEvents || {};
        var eventIds = window.__agentPivotAttentionSessionEvents[sessionKey] || [];
        if (!eventIds.length && fallbackEventId) {
            eventIds = [fallbackEventId];
        }
        eventIds = Array.from(new Set(eventIds.filter(eventId => typeof eventId === 'string' && !!eventId)));
        if (eventIds.length) {
            window.vscode.postMessage({ type: 'acknowledge-ai-session-attention', eventIds: eventIds });
        }
    }

    window.__agentPivotAcknowledgeSession = (provider, sessionId) => {
        if (isAiSessionProvider(provider) && sessionId) {
            acknowledgeAiSession(provider, sessionId);
        }
    };

    function getSelectedAiSessionProviders(projectDiv) {
        var region = projectDiv && projectDiv.querySelector('[data-ai-session-region]');
        return (region && region.getAttribute('data-selected-ai-session-providers') || '')
            .split(',')
            .filter(isAiSessionProvider);
    }

    function submitAiSessionProviderSelection(projectDiv, providers) {
        var projectId = projectDiv && projectDiv.getAttribute('data-id');
        if (!projectId || !providers.length || batchAiSessionState.pending
            || pendingAiSessionProviderSelectionProjectId)
            return;

        exitAiSessionBatchManagement();
        nextAiSessionProviderSelectionRequestId += 1;
        var requestId = nextAiSessionProviderSelectionRequestId;
        pendingAiSessionProviderSelectionProjectId = projectId;
        pendingAiSessionProviderSelectionRequestId = requestId;
        pendingAiSessionProviderSelectionProviders = providers.slice();
        syncAiSessionProviderMenuDisabledDom(projectDiv, true);
        window.vscode.postMessage({
            type: 'select-ai-session-providers',
            version: 1,
            requestId: requestId,
            projectId,
            selectedProviders: providers,
        });
    }

    function setAiSessionProviderMenuOpen(projectDiv, open) {
        var trigger = projectDiv && projectDiv.querySelector('[data-ai-provider-menu-trigger]');
        var menu = projectDiv && projectDiv.querySelector('[data-ai-provider-menu]');
        if (!trigger || !menu)
            return;
        if (open && (batchAiSessionState.pending
            || pendingAiSessionProviderSelectionProjectId))
            return;

        trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
        menu.hidden = !open;
    }

    function closeAiSessionProviderMenus(exceptProjectDiv) {
        document.querySelectorAll('.project[data-id]').forEach(projectDiv => {
            if (projectDiv !== exceptProjectDiv) {
                setAiSessionProviderMenuOpen(projectDiv, false);
            }
        });
    }

    function closeAiSessionProviderMenu(projectDiv, restoreFocus) {
        setAiSessionProviderMenuOpen(projectDiv, false);
        if (restoreFocus) {
            projectDiv?.querySelector('[data-ai-provider-menu-trigger]')?.focus();
        }
    }

    function toggleAiSessionProviderMenu(projectDiv) {
        if (!projectDiv || batchAiSessionState.pending
            || pendingAiSessionProviderSelectionProjectId)
            return;
        var trigger = projectDiv.querySelector('[data-ai-provider-menu-trigger]');
        var open = trigger?.getAttribute('aria-expanded') !== 'true';
        closeAiSessionProviderMenus(projectDiv);
        setAiSessionProviderMenuOpen(projectDiv, open);
    }

    function activateAiSessionProviderOption(projectDiv, option) {
        if (!projectDiv || !option || batchAiSessionState.pending
            || pendingAiSessionProviderSelectionProjectId)
            return;
        var provider = option.getAttribute('data-provider');
        if (!isAiSessionProvider(provider))
            return;
        var selectedProviders = getSelectedAiSessionProviders(projectDiv);
        var selected = selectedProviders.includes(provider);
        if (selected && selectedProviders.length === 1)
            return;
        submitAiSessionProviderSelection(
            projectDiv,
            selected
                ? selectedProviders.filter(candidate => candidate !== provider)
                : selectedProviders.concat(provider)
        );
    }

    function getAiSessionProviderOptions(projectDiv) {
        return projectDiv
            ? Array.from(projectDiv.querySelectorAll('[data-ai-provider-option][data-provider]'))
            : [];
    }

    function isAiSessionProvider(provider) {
        return provider === "codex" || provider === "kimi" || provider === "claude";
    }

    function getResumeAiSessionMessageType(provider) {
        if (provider === "kimi")
            return 'resume-kimi-session';
        if (provider === "claude")
            return 'resume-claude-session';

        return 'resume-codex-session';
    }

    function getArchiveAiSessionMessageType(provider) {
        if (provider === "kimi")
            return 'archive-kimi-session';
        if (provider === "claude")
            return 'archive-claude-session';

        return 'archive-codex-session';
    }

    function toggleCodexSessions(projectDiv, projectId) {
        var expanded = !projectDiv.hasAttribute("data-codex-expanded");
        if (!expanded && batchAiSessionState.projectId === projectId) {
            exitAiSessionBatchManagement();
        }
        projectDiv.toggleAttribute("data-codex-expanded", expanded);
        updateStickyGroupHeaderOffset();

        window.vscode.postMessage({
            type: 'toggle-codex-sessions',
            projectId,
            expanded,
        });
    }

    function isActiveAiSessionBatchScope(projectId) {
        return projectId === batchAiSessionState.projectId;
    }

    function getProjectActiveAiSessionProvider(projectDiv) {
        if (!projectDiv)
            return null;

        var region = projectDiv.querySelector('[data-ai-session-region]');
        var activeProvider = region && region.getAttribute('data-active-ai-session-provider');
        if (isAiSessionProvider(activeProvider))
            return activeProvider;

        var selectedProviders = region && region.getAttribute('data-selected-ai-session-providers') || '';
        return selectedProviders.split(',').find(isAiSessionProvider) || null;
    }

    function syncActiveAiSessionTerminalDom() {
        document.querySelectorAll('.codex-session-row[data-session-id]').forEach(row => {
            var provider = row.getAttribute('data-session-provider') || 'codex';
            var sessionId = row.getAttribute('data-session-id');
            row.toggleAttribute(
                'data-ai-session-active-terminal',
                provider === activeAiSessionTerminalState.provider
                    && sessionId === activeAiSessionTerminalState.sessionId
            );
        });
    }

    function syncAiSessionBatchManagementDom(projectDiv) {
        var snapshot = batchAiSessionManager.snapshot();
        document.querySelectorAll('.project[data-ai-session-managing], .project[data-ai-session-pending]').forEach(project => {
            if (project !== projectDiv || project.getAttribute("data-id") !== snapshot.projectId) {
                project.removeAttribute("data-ai-session-managing");
                project.removeAttribute("data-ai-session-pending");
                syncAiSessionProviderMenuDisabledDom(project, false);
                var inactiveManageButton = project.querySelector('[data-action="manage-ai-sessions"]');
                if (inactiveManageButton) {
                    inactiveManageButton.setAttribute('aria-pressed', 'false');
                    inactiveManageButton.disabled = false;
                }
            }
        });

        if (!projectDiv)
            return;

        var projectId = projectDiv.getAttribute("data-id");
        var isScoped = projectId === snapshot.projectId;
        projectDiv.toggleAttribute("data-ai-session-managing", isScoped);
        projectDiv.toggleAttribute("data-ai-session-pending", isScoped && snapshot.pending);
        syncAiSessionProviderMenuDisabledDom(projectDiv, isScoped && snapshot.pending);
        var manageButton = projectDiv.querySelector('[data-action="manage-ai-sessions"]');
        if (manageButton) {
            manageButton.setAttribute('aria-pressed', isScoped ? 'true' : 'false');
            manageButton.disabled = isScoped && snapshot.pending;
        }

        var selectedItems = new Set(snapshot.selectedItems.map(item =>
            getAiSessionBatchItemKey(item.provider, item.sessionId)
        ));
        projectDiv.querySelectorAll('.ai-session-history-panel .codex-session-row[data-session-id]').forEach(row => {
            var rowProvider = row.getAttribute("data-session-provider") || "codex";
            var isActive = row.hasAttribute('data-session-active');
            var isSelected = isScoped
                && !isActive
                && selectedItems.has(getAiSessionBatchItemKey(
                    rowProvider,
                    row.getAttribute("data-session-id")
                ));
            row.toggleAttribute("data-ai-session-selected", isSelected);
            var checkbox = row.querySelector('.ai-session-batch-checkbox');
            if (checkbox) {
                checkbox.checked = isSelected;
                checkbox.disabled = isActive || (isScoped && snapshot.pending);
            }
        });

        var count = isScoped ? snapshot.selectedItems.length : 0;
        var countElement = projectDiv.querySelector('.ai-session-batch-count');
        if (countElement) {
            countElement.textContent = count + ' selected';
        }
        projectDiv.querySelectorAll('.ai-session-batch-actions button').forEach(button => {
            button.disabled = isScoped && snapshot.pending;
        });
        var archiveButton = projectDiv.querySelector('[data-action="archive-selected-ai-sessions"]');
        if (archiveButton) {
            archiveButton.disabled = !isScoped || snapshot.pending || count === 0;
        }
    }

    function syncAiSessionProviderMenuDisabledDom(projectDiv, batchPending) {
        var projectId = projectDiv?.getAttribute('data-id');
        var providerSelectionPending = projectId
            === pendingAiSessionProviderSelectionProjectId;
        var pending = Boolean(
            batchPending || batchAiSessionState.pending || providerSelectionPending
        );
        var trigger = projectDiv && projectDiv.querySelector('[data-ai-provider-menu-trigger]');
        if (trigger) {
            trigger.disabled = pending;
            trigger.setAttribute('aria-disabled', pending ? 'true' : 'false');
        }
        var selectedProviders = getSelectedAiSessionProviders(projectDiv);
        getAiSessionProviderOptions(projectDiv).forEach(option => {
            var provider = option.getAttribute('data-provider');
            var lastSelectedProvider = selectedProviders.length === 1
                && selectedProviders[0] === provider;
            option.disabled = pending;
            option.setAttribute(
                'aria-disabled',
                pending || lastSelectedProvider ? 'true' : 'false'
            );
        });
        if (pending) {
            closeAiSessionProviderMenu(projectDiv, false);
        }
    }

    function clearPendingAiSessionProviderSelection() {
        pendingAiSessionProviderSelectionProjectId = null;
        pendingAiSessionProviderSelectionRequestId = null;
        pendingAiSessionProviderSelectionProviders = [];
    }

    function selectedAiSessionProvidersMatch(projectDiv, expectedProviders) {
        var selectedProviders = getSelectedAiSessionProviders(projectDiv);
        return selectedProviders.length === expectedProviders.length
            && selectedProviders.every(provider =>
                expectedProviders.includes(provider)
            );
    }

    function reconcilePendingAiSessionProviderSelectionDom() {
        if (!pendingAiSessionProviderSelectionProjectId)
            return;
        var projectDiv = findCurrentWorkspaceDiv(
            pendingAiSessionProviderSelectionProjectId
        );
        if (!projectDiv)
            return;
        if (selectedAiSessionProvidersMatch(
            projectDiv,
            pendingAiSessionProviderSelectionProviders
        )) {
            clearPendingAiSessionProviderSelection();
        }
        syncAiSessionProviderMenuDisabledDom(projectDiv, false);
    }

    function applyAiSessionProviderSelectionResult(message) {
        if (!message
            || message.type !== 'ai-session-provider-selection-result'
            || message.version !== 1
            || !Number.isSafeInteger(message.requestId)
            || message.requestId < 1
            || typeof message.projectId !== 'string'
            || typeof message.success !== 'boolean'
            || message.projectId !== pendingAiSessionProviderSelectionProjectId
            || message.requestId !== pendingAiSessionProviderSelectionRequestId) {
            return false;
        }
        if (message.success) {
            return true;
        }

        var projectDiv = findCurrentWorkspaceDiv(message.projectId);
        clearPendingAiSessionProviderSelection();
        syncAiSessionProviderMenuDisabledDom(projectDiv, false);
        var liveRegion = projectDiv?.querySelector('[data-ai-session-live-region]');
        if (liveRegion) {
            liveRegion.textContent = 'Could not update AI session providers. Try again.';
        }
        return true;
    }

    function exitAiSessionBatchManagement() {
        var projectId = batchAiSessionState.projectId;
        batchAiSessionManager.exit();
        syncAiSessionBatchManagementDom(findCurrentWorkspaceDiv(projectId));
    }

    function onInsideGroupClick(e, groupDiv) {
        var groupId = groupDiv.getAttribute("data-group-id");
        if (groupId == null)
            return;

        var actionDiv = e.target.closest('[data-action]')
        var action = actionDiv != null ? actionDiv.getAttribute("data-action") : null;
        if (!action)
            return;

        if (action === "add") {
            window.vscode.postMessage({
                type: 'add-project',
                groupId: groupId,
            });

            return;
        }

        var collapsed = groupDiv.classList.contains("collapsed");
        if (action === "collapse") {
            groupDiv.classList.toggle("collapsed");
            collapsed = groupDiv.classList.contains("collapsed");
        }

        window.vscode.postMessage({
            type: action + '-group',
            groupId: groupId,
            collapsed,
        });
        syncCollapseButton();
    }

    function onTodoAction(e) {
        var addTodoAction = e.target.closest('[data-action="todo-add"]');
        if (addTodoAction && !addTodoAction.closest('.todo-add-form')) {
            setTodoAddFormVisible(true, addTodoAction.getAttribute('data-group-id'));
            return true;
        }

        var addGroupAction = e.target.closest('[data-action="todo-add-group"]');
        if (addGroupAction) {
            window.vscode.postMessage({
                type: 'todo-add-group',
            });
            return true;
        }

        var toggleAction = e.target.closest('[data-action="todo-toggle"]');
        if (toggleAction) {
            window.vscode.postMessage({
                type: 'todo-toggle',
                todoId: toggleAction.getAttribute('data-todo-id'),
                completed: toggleAction.checked === true,
            });
            return true;
        }

        var deleteAction = e.target.closest('[data-action="todo-delete"]');
        if (deleteAction) {
            window.vscode.postMessage({
                type: 'todo-delete',
                todoId: deleteAction.getAttribute('data-todo-id'),
            });
            return true;
        }

        var deleteGroupAction = e.target.closest('[data-action="todo-delete-group"]');
        if (deleteGroupAction) {
            window.vscode.postMessage({
                type: 'todo-delete-group',
                groupId: deleteGroupAction.getAttribute('data-group-id'),
            });
            return true;
        }

        var renameGroupAction = e.target.closest('[data-action="todo-rename-group"]');
        if (renameGroupAction) {
            window.vscode.postMessage({
                type: 'todo-rename-group',
                groupId: renameGroupAction.getAttribute('data-group-id'),
            });
            return true;
        }

        var collapseGroupAction = e.target.closest('[data-action="todo-collapse-group"]');
        if (collapseGroupAction) {
            var todoGroup = collapseGroupAction.closest('.todo-group');
            if (!todoGroup)
                return true;
            todoGroup.classList.toggle('collapsed');
            syncTodoGroupCollapseControl(todoGroup);
            window.vscode.postMessage({
                type: 'todo-collapse-group',
                groupId: todoGroup.getAttribute('data-todo-group-id'),
                collapsed: todoGroup.classList.contains('collapsed'),
            });
            syncCollapseButton();
            return true;
        }

        var sortAction = e.target.closest('[data-action="todo-sort-priority"]');
        if (sortAction) {
            window.vscode.postMessage({
                type: 'todo-sort-priority',
                groupId: sortAction.getAttribute('data-group-id'),
            });
            return true;
        }

        var showCompletedAction = e.target.closest('[data-action="todo-toggle-show-completed"]');
        if (showCompletedAction) {
            window.vscode.postMessage({
                type: 'todo-toggle-show-completed',
                showCompleted: showCompletedAction.checked === true,
            });
            return true;
        }

        var focusAddAction = e.target.closest('[data-action="todo-focus-add"]');
        if (focusAddAction) {
            setTodoAddFormVisible(true, focusAddAction.getAttribute('data-group-id'));
            return true;
        }

        var cancelAddAction = e.target.closest('[data-action="todo-cancel-add"]');
        if (cancelAddAction) {
            setTodoAddFormVisible(false);
            return true;
        }

        var editAction = e.target.closest('[data-action="todo-edit"]');
        if (editAction) {
            setTodoEditing(editAction.getAttribute('data-todo-id'), true);
            return true;
        }

        var expandAction = e.target.closest('[data-action="todo-toggle-expanded"]');
        if (expandAction) {
            toggleTodoItemExpanded(expandAction.closest('.todo-item'));
            return true;
        }

        var cancelEditAction = e.target.closest('[data-action="todo-cancel-edit"]');
        if (cancelEditAction) {
            setTodoEditing(cancelEditAction.getAttribute('data-todo-id'), false);
            return true;
        }

        return false;
    }

    function syncTodoPrioritySegment(segment) {
        if (!segment)
            return;

        Array.from(segment.querySelectorAll('.todo-priority-choice')).forEach(choice => {
            var input = choice.querySelector('input[name="priority"]');
            choice.classList.toggle('active', !!input && input.checked === true);
        });
    }

    function resetTodoEditForm(form) {
        form.reset();
        syncTodoPrioritySegment(form.querySelector('.todo-priority-segment'));
    }

    function syncTodoListExpandedHeight(list) {
        if (!list)
            return;

        var panel = list.closest('.todo-panel');
        var collapsedHeightValue = panel
            ? getComputedStyle(panel).getPropertyValue('--todo-collapsed-item-height')
            : '';
        var collapsedHeight = parseFloat(collapsedHeightValue) || 58;
        var expandedExtraHeight = Array.from(list.querySelectorAll('.todo-item.expanded'))
            .reduce((total, expandedItem) => total + Math.max(0, expandedItem.offsetHeight - collapsedHeight), 0);
        list.style.setProperty('--todo-list-expanded-extra-height', expandedExtraHeight + 'px');
    }

    function toggleTodoItemExpanded(item, expanded) {
        if (!item)
            return;

        var nextExpanded = typeof expanded === 'boolean'
            ? expanded
            : !item.classList.contains('expanded');
        item.classList.toggle('expanded', nextExpanded);
        syncTodoExpandControl(item, nextExpanded);
        syncTodoListExpandedHeight(item.closest('.todo-list'));
    }

    function isTodoInteractiveTarget(target) {
        return !!(target && target.closest && target.closest('button, input, textarea, select, label, a, [data-action], .todo-edit-form'));
    }

    function setTodoAddFormVisible(visible, groupId) {
        var form = document.querySelector('.todo-add-form');
        if (!form)
            return;

        var groupSelect = form.querySelector('[name="groupId"]');
        if (visible && groupSelect) {
            groupSelect.value = groupId || '';
        }
        form.hidden = !visible;
        if (!visible)
            return;

        var titleInput = form.querySelector('[name="title"]');
        if (titleInput) {
            titleInput.focus();
        }
        form.scrollIntoView({ block: 'nearest' });
    }

    function setTodoEditing(todoId, editing) {
        if (!todoId)
            return;

        var item = Array.from(document.querySelectorAll('.todo-item[data-todo-id]'))
            .find(candidate => candidate.getAttribute('data-todo-id') === todoId);
        if (!item)
            return;

        var wasEditing = item.classList.contains('editing');
        var expandedBeforeEdit = item.getAttribute('data-expanded-before-edit');
        if (editing && !wasEditing) {
            item.setAttribute(
                'data-expanded-before-edit',
                item.classList.contains('expanded') ? 'true' : 'false'
            );
            expandedBeforeEdit = item.getAttribute('data-expanded-before-edit');
        }
        var view = item.querySelector('.todo-item-view');
        var form = item.querySelector('.todo-edit-form');
        var list = item.closest('.todo-list');
        if (form && !editing) {
            resetTodoEditForm(form);
        }
        item.classList.toggle('editing', editing);
        if (view) {
            view.hidden = false;
        }
        if (form) {
            form.hidden = !editing;
        }
        toggleTodoItemExpanded(item, editing ? true : expandedBeforeEdit === 'true');
        if (!editing) {
            item.removeAttribute('data-expanded-before-edit');
        }
        if (list) {
            list.classList.toggle('has-editing-item', !!list.querySelector('.todo-item.editing'));
        }
        if (form && editing) {
            var titleInput = form.querySelector('[name="title"]');
            if (titleInput) {
                titleInput.focus();
            }
            item.scrollIntoView({ block: 'nearest' });
        }
    }

    function onTodoFormSubmit(e) {
        if (window.__agentPivotTodo
            && e.target
            && e.target.closest
            && e.target.closest('#dashboard-tab-todo')) {
            return;
        }
        var addForm = e.target && e.target.closest ? e.target.closest('.todo-add-form') : null;
        if (addForm) {
            e.preventDefault();
            submitTodoComposeForm(addForm, message => window.vscode.postMessage(message));
            return;
        }

        var editForm = e.target && e.target.closest ? e.target.closest('.todo-edit-form') : null;
        if (editForm) {
            e.preventDefault();
            var todoId = editForm.getAttribute('data-todo-id');
            var editTitle = getTodoFormValue(editForm, 'title');
            if (!todoId || !editTitle)
                return;
            window.vscode.postMessage({
                type: 'todo-update',
                todoId,
                title: editTitle,
                notes: getTodoFormValue(editForm, 'notes'),
                priority: getTodoFormValue(editForm, 'priority'),
            });
        }
    }

    function onTriggerProjectAction(target, projectId) {
        var actionDiv = target.closest('[data-action]')
        if (actionDiv == null)
            return false;

        var action = actionDiv.getAttribute("data-action");
        if (!action)
            return false;

        if (action === 'save-current-workspace') {
            window.vscode.postMessage({
                type: 'save-current-workspace',
                projectId,
            });
            return true;
        }

        if (action === 'toggle-open-workspace-pin') {
            requestOpenWorkspacePin(actionDiv, projectId);
            return true;
        }

        window.vscode.postMessage({
            type: action + '-project',
            projectId,
        });

        return true;
    }

    var contextMenuProjectId = null;
    var contextMenuGroupId = null;
    var contextMenuAiSessionId = null;
    var contextMenuAiSessionProvider = null;
    var contextMenuAiSessionProjectId = null;
    var contextMenuAiSessionActive = false;
    var contextMenuAiSessionBackend = null;
    var contextMenuAiSessionConflict = false;
    var contextMenuAiSessionOrigin = null;
    var latestAiSessionUpdateSequence = 0;

    function showContextMenu(contextMenuElement, e) {
        contextMenuElement.style.visibility = "hidden";
        contextMenuElement.style.left = "0px";
        contextMenuElement.style.top = "0px";
        contextMenuElement.classList.add("visible");

        var rect = contextMenuElement.getBoundingClientRect();
        var viewportPadding = 4;
        var left = e.clientX;
        var top = e.clientY;

        if (left + rect.width + viewportPadding > window.innerWidth) {
            left = Math.max(viewportPadding, window.innerWidth - rect.width - viewportPadding);
        }

        if (top + rect.height + viewportPadding > window.innerHeight) {
            top = Math.max(viewportPadding, window.innerHeight - rect.height - viewportPadding);
        }

        contextMenuElement.style.left = left + "px";
        contextMenuElement.style.top = top + "px";
        contextMenuElement.style.visibility = "";
    }

    function onContextMenu(e) {
        closeContextMenus(); // Close previews

        var sessionRow = e.target.closest('.codex-session-row[data-session-id][data-session-provider]');
        if (sessionRow) {
            contextMenuAiSessionOrigin = sessionRow.querySelector('.ai-session-primary-action') || sessionRow;
            contextMenuAiSessionId = sessionRow.getAttribute("data-session-id");
            contextMenuAiSessionProvider = sessionRow.getAttribute("data-session-provider");
            var sessionProjectDiv = sessionRow.closest('.project[data-id]');
            contextMenuAiSessionProjectId = sessionProjectDiv ? sessionProjectDiv.getAttribute("data-id") : null;
            contextMenuAiSessionActive = sessionRow.hasAttribute('data-session-active');
            contextMenuAiSessionBackend = sessionRow.getAttribute('data-session-backend') || 'vscode';
            contextMenuAiSessionConflict = sessionRow.hasAttribute('data-session-conflict');
            if (!contextMenuAiSessionId || !isAiSessionProvider(contextMenuAiSessionProvider))
                return;

            e.preventDefault();
            var sessionContextMenuElement = document.getElementById("aiSessionContextMenu");
            if (!sessionContextMenuElement)
                return;
            sessionContextMenuElement.querySelectorAll(':scope > *').forEach(element => element.classList.remove('disabled'));
            var archiveMenuItem = sessionContextMenuElement.querySelector('[data-action="archive"]');
            var closeMenuItem = sessionContextMenuElement.querySelector('[data-action="close-terminal"]');
            if (archiveMenuItem) archiveMenuItem.classList.toggle('disabled', contextMenuAiSessionActive);
            if (closeMenuItem) {
                var terminalActionLabel = contextMenuAiSessionBackend === 'tmux'
                    ? 'Detach Terminal…' : 'Close Terminal…';
                closeMenuItem.textContent = terminalActionLabel;
                closeMenuItem.setAttribute('aria-label', terminalActionLabel);
                closeMenuItem.toggleAttribute('hidden', contextMenuAiSessionConflict);
                closeMenuItem.classList.toggle(
                    'disabled', !contextMenuAiSessionActive || contextMenuAiSessionConflict
                );
            }

            showContextMenu(sessionContextMenuElement, e);
            if (e.keyboardTrigger) {
                var firstMenuItem = sessionContextMenuElement.querySelector('.custom-context-menu-item[data-action]:not(.disabled)');
                firstMenuItem?.focus();
            }
            return;
        }

        var projectDiv = e.target.closest('.project[data-id]');
        var groupDiv = e.target.closest('.group-title')
        if (!projectDiv && !groupDiv)
            return;

        if (projectDiv && projectDiv.hasAttribute("data-readonly-project"))
            return;

        e.preventDefault();

        let contextMenuForProject = projectDiv != null;
        var contextMenuElement;
        if (contextMenuForProject) {
            contextMenuProjectId = projectDiv.getAttribute("data-id");
            if (contextMenuProjectId == null)
                return;

            contextMenuElement = document.getElementById("projectContextMenu");
        } else {
            let groupIdDiv = groupDiv.closest(".group[data-group-id]");
            if (groupIdDiv && groupIdDiv.hasAttribute("data-virtual-group"))
                return;

            contextMenuGroupId = groupIdDiv ? groupIdDiv.getAttribute("data-group-id") : null;
            if (contextMenuGroupId == null)
                return;

            contextMenuElement = document.getElementById("groupContextMenu");
        }

        // disable elements if needed
        contextMenuElement.querySelectorAll(":scope > *").forEach(e => e.classList.remove("disabled"));

        if (projectDiv && projectDiv.hasAttribute("data-is-remote")) {
            contextMenuElement.querySelectorAll(".not-remote").forEach(e => e.classList.add("disabled"));
        }

        // place and show contextmenu

        showContextMenu(contextMenuElement, e);
    }

    function onProjectContextMenuActionClicked(el) {
        var action = el.getAttribute("data-action");

        if (action == null || contextMenuProjectId == null)
            return;

        switch (action) {
            case 'open':
                openProject(contextMenuProjectId, ProjectOpenType.CurrentWindow);
                break;
            case 'open-add-to-workspace':
                openProject(contextMenuProjectId, ProjectOpenType.AddToWorkspace);
                break;
            default:
                window.vscode.postMessage({
                    type: action + '-project',
                    projectId: contextMenuProjectId,
                });
                break;
        }

        closeContextMenus();
    }

    function onGroupContextMenuActionClicked(el) {
        var action = el.getAttribute("data-action");

        if (action == null || contextMenuGroupId == null)
            return;

        switch (action) {
            case 'add':
                window.vscode.postMessage({
                    type: 'add-project',
                    groupId: contextMenuGroupId,
                });
                break;
            default:
                window.vscode.postMessage({
                    type: action + '-group',
                    groupId: contextMenuGroupId,
                });
                break;
        }

        closeContextMenus();
    }

    function onAiSessionContextMenuActionClicked(el) {
        var action = el.getAttribute("data-action");
        var origin = contextMenuAiSessionOrigin;

        if (action == null || contextMenuAiSessionId == null || contextMenuAiSessionProvider == null)
            return;

        switch (action) {
            case 'resume':
                window.vscode.postMessage(contextMenuAiSessionActive ? {
                    type: 'focus-ai-session-terminal',
                    provider: contextMenuAiSessionProvider,
                    projectId: contextMenuAiSessionProjectId,
                    sessionId: contextMenuAiSessionId,
                } : {
                    type: getResumeAiSessionMessageType(contextMenuAiSessionProvider),
                    provider: contextMenuAiSessionProvider,
                    projectId: contextMenuAiSessionProjectId,
                    sessionId: contextMenuAiSessionId,
                });
                break;
            case 'rename':
                window.vscode.postMessage({
                    type: 'rename-ai-session',
                    provider: contextMenuAiSessionProvider,
                    sessionId: contextMenuAiSessionId,
                });
                break;
            case 'copy-id':
                window.vscode.postMessage({
                    type: 'copy-ai-session-id',
                    provider: contextMenuAiSessionProvider,
                    sessionId: contextMenuAiSessionId,
                });
                break;
            case 'pin':
                window.vscode.postMessage({
                    type: 'toggle-ai-session-pin',
                    provider: contextMenuAiSessionProvider,
                    sessionId: contextMenuAiSessionId,
                });
                break;
            case 'archive':
                if (contextMenuAiSessionActive) break;
                window.vscode.postMessage({
                    type: getArchiveAiSessionMessageType(contextMenuAiSessionProvider),
                    projectId: contextMenuAiSessionProjectId,
                    provider: contextMenuAiSessionProvider,
                    sessionId: contextMenuAiSessionId,
                });
                break;
            case 'close-terminal':
                if (!contextMenuAiSessionActive || contextMenuAiSessionConflict) break;
                window.vscode.postMessage({
                    type: contextMenuAiSessionBackend === 'tmux'
                        ? 'detach-ai-session-terminal' : 'close-ai-session-terminal',
                    projectId: contextMenuAiSessionProjectId,
                    provider: contextMenuAiSessionProvider,
                    sessionId: contextMenuAiSessionId,
                });
                break;
        }

        closeContextMenus();
        origin?.focus();
    }

    function closeContextMenus() {
        contextMenuProjectId = null;
        contextMenuGroupId = null;
        contextMenuAiSessionId = null;
        contextMenuAiSessionProvider = null;
        contextMenuAiSessionProjectId = null;
        contextMenuAiSessionActive = false;
        contextMenuAiSessionBackend = null;
        contextMenuAiSessionConflict = false;
        contextMenuAiSessionOrigin = null;
        // Only close menus this script owns; the dashboard script owns the
        // skill folder menu and keeps it open across per-agent toggles.
        document.querySelectorAll(".custom-context-menu:not(.skill-folder-menu)").forEach(element =>
            element.classList.remove("visible")
        );
    }

    function updateToggleAllGroupsButton(state) {
        document.body.classList.toggle("steward-all-collapsed", state.collapsed);
        var button = document.querySelector('[data-action="toggle-all-groups"]');
        if (!button)
            return;

        button.disabled = state.disabled;
        button.setAttribute('aria-disabled', state.disabled ? 'true' : 'false');
        button.setAttribute("title", state.title);
        button.setAttribute("aria-label", state.title);
    }

    function getActiveDashboardTab() {
        var dashboard = window.__agentPivotDashboard;
        var selectedTab = !dashboard && document.querySelector
            ? document.querySelector('[data-dashboard-tab][aria-selected="true"]')
            : null;
        var activeTab = dashboard && typeof dashboard.getActiveTab === 'function'
            ? dashboard.getActiveTab()
            : selectedTab && selectedTab.getAttribute('data-dashboard-tab');
        return activeTab === 'projects' || activeTab === 'todo' || activeTab === 'ai'
            ? activeTab
            : 'open';
    }

    function getActiveCollapsibleGroups() {
        var activeTab = getActiveDashboardTab();
        var selector = activeTab === 'projects'
            ? '#dashboard-tab-projects .group[data-group-id]'
            : activeTab === 'todo'
                ? '#dashboard-tab-todo .todo-group[data-todo-group-id]'
                : activeTab === 'open'
                    ? '#dashboard-tab-open .open-other-windows-group[data-group-id]'
                    : null;
        if (!selector) {
            return [];
        }
        return [...document.querySelectorAll(selector)];
    }

    function setGroupCollapsed(group, collapsed, persist) {
        group.classList.toggle('collapsed', collapsed);
        if (persist) {
            var isTodoGroup = group.classList.contains('todo-group');
            window.vscode.postMessage({
                type: isTodoGroup ? 'todo-collapse-group' : 'collapse-group',
                groupId: isTodoGroup
                    ? group.getAttribute('data-todo-group-id')
                    : group.getAttribute('data-group-id'),
                collapsed,
            });
        }
    }

    function syncCollapseButton() {
        var activeTab = getActiveDashboardTab();
        var groups = getActiveCollapsibleGroups();
        updateToggleAllGroupsButton(getCollapseButtonState(
            activeTab,
            groups.map(group => group.classList.contains('collapsed'))
        ));
    }

    function toggleAllGroups() {
        var activeTab = getActiveDashboardTab();
        var groups = getActiveCollapsibleGroups();
        var shouldCollapse = groups.some(group => !group.classList.contains("collapsed"));

        if (activeTab === 'todo') {
            if (window.__agentPivotTodo
                && typeof window.__agentPivotTodo.dispatch === 'function') {
                window.__agentPivotTodo.dispatch('collapse-groups', { collapsed: shouldCollapse });
            } else {
                collapseTodoGroups(groups, shouldCollapse, message => window.vscode.postMessage(message));
            }
            syncCollapseButton();
            return;
        }

        groups.forEach(group => setGroupCollapsed(group, shouldCollapse, true));
        syncCollapseButton();
    }

    window.__agentPivotSyncCollapseButton = syncCollapseButton;

    function onMouseEvent(e) {
        if (!e.target || e.target.closest(".disabled"))
            return;
        if (isDedicatedTodoTarget(e.target))
            return;

        var contextMenuElement = e.target.closest("#projectContextMenu [data-action]");
        if (contextMenuElement) {
            onProjectContextMenuActionClicked(contextMenuElement);
            return;
        }

        contextMenuElement = e.target.closest("#aiSessionContextMenu [data-action]");
        if (contextMenuElement) {
            onAiSessionContextMenuActionClicked(contextMenuElement);
            return;
        }

        contextMenuElement = e.target.closest("#groupContextMenu [data-action]");
        if (contextMenuElement) {
            onGroupContextMenuActionClicked(contextMenuElement);
            return;
        }

        closeContextMenus();
        if (!e.target.closest('.ai-session-provider-menu-wrapper')) {
            closeAiSessionProviderMenus();
        }

        if (e.target.closest('[data-action="toggle-all-groups"]')) {
            toggleAllGroups();
            return;
        }

        if (e.target.closest('[data-action="open-settings"]')) {
            window.vscode.postMessage({
                type: 'open-settings'
            });
            return;
        }

        if (e.target.closest('[data-action="open-bridge-extension"]')) {
            window.vscode.postMessage({
                type: 'open-bridge-extension'
            });
            return;
        }

        if (e.target.closest('[data-action="add-group"]')) {
            window.vscode.postMessage({
                type: 'add-group'
            });
            return;
        }

        if (e.target.closest('[data-action="add-project"]')) {
            onAddProjectClicked(e);
            return;
        }

        if (e.target.closest('[data-action="import-from-other-storage"]')) {
            onImportFromOtherStorageClicked(e);
            return;
        }

        if (onTodoAction(e)) {
            return;
        }

        var todoItem = e.target.closest('.todo-item[data-todo-id]');
        if (todoItem && !todoItem.classList.contains('editing') && !isTodoInteractiveTarget(e.target)) {
            toggleTodoItemExpanded(todoItem);
            return;
        }

        var projectDiv = e.target.closest('.project');
        if (projectDiv) {
            onInsideProjectClick(e, projectDiv);
            return;
        }

        var groupDiv = e.target.closest('.group');
        if (groupDiv) {
            onInsideGroupClick(e, groupDiv);
            return;
        }
    }

    function onChangeEvent(e) {
        if (!e.target)
            return;
        if (isDedicatedTodoTarget(e.target))
            return;

        var todoPriorityInput = e.target.closest('.todo-priority-choice input[name="priority"]');
        if (todoPriorityInput) {
            syncTodoPrioritySegment(todoPriorityInput.closest('.todo-priority-segment'));
            return;
        }

    }

    function updateStickyGroupHeaderOffset() {
        window.requestAnimationFrame(() => {
            var stickyHeader = document.querySelector('.steward-sticky-header');
            var offset = stickyHeader ? Math.ceil(stickyHeader.getBoundingClientRect().height) : 0;
            document.body.style.setProperty('--steward-sticky-header-height', offset + 'px');
        });
    }

    function onWindowMessage(e) {
        var message = e && e.data;
        if (message
            && message.type === 'focus-ai-session-conversation-origin') {
            focusAiSessionConversationOrigin(message);
            return;
        }
        if (message
            && message.type === 'ai-session-conversation-outline-result') {
            applyAiSessionConversationOutlineResult(message);
            return;
        }
        if (message && message.type === 'todo-mutation-result') {
            applyTodoMutationResult(message, document);
            return;
        }
        if (message && message.type === 'ai-session-provider-selection-result') {
            applyAiSessionProviderSelectionResult(message);
            return;
        }
        if (message && (message.type === 'todo-panel-content' || message.type === 'todo-panel-updated')) {
            window.setTimeout(() => {
                var todoRoot = document.querySelector('#dashboard-tab-todo');
                if (todoRoot && typeof initDnD === 'function' && typeof disposeDnD === 'function') {
                    disposeDnD(todoRoot);
                    initDnD(todoRoot);
                    syncCollapseButton();
                }
            }, 0);
        }
        if (message && message.type === 'workspace-updated') {
            if (!applyWorkspaceUpdate(message, {
                canRestoreAiSessionProviderMenu: () =>
                    !pendingAiSessionProviderSelectionProjectId
                    && !batchAiSessionState.pending,
            })) {
                requestFullRefresh('invalid-workspace-update');
                return;
            }
            if (batchAiSessionState.projectId) {
                var managedProjectDiv = findCurrentWorkspaceDiv(batchAiSessionState.projectId);
                if (managedProjectDiv) {
                    batchAiSessionManager.reconcileVisible(managedProjectDiv);
                    syncAiSessionBatchManagementDom(managedProjectDiv);
                } else {
                    exitAiSessionBatchManagement();
                }
            }
            reconcilePendingAiSessionProviderSelectionDom();
            syncActiveAiSessionTerminalDom();
            updateStickyGroupHeaderOffset();
            var renderedWorkspaceState = getWorkspaceUpdateDomState(document);
            window.vscode.postMessage({
                type: 'workspace-rendered',
                version: 2,
                currentWorkspaceCount: renderedWorkspaceState.currentWorkspaceCount,
            });
            return;
        }
        if (message && message.type === 'open-workspaces-updated') {
            if (!applyOpenWorkspacesUpdate(message)) {
                requestFullRefresh('invalid-open-workspaces-update');
                return;
            }
            syncActiveAiSessionTerminalDom();
            updateStickyGroupHeaderOffset();
            var renderedOpenWorkspaceState = getOpenWorkspacesUpdateDomState();
            window.vscode.postMessage({
                type: 'open-workspaces-rendered',
                version: 2,
                semanticRevision: message.semanticRevision,
                currentWorkspaceCount: renderedOpenWorkspaceState.currentWorkspaceCount,
                navigationWorkspaceCount: renderedOpenWorkspaceState.navigationWorkspaceCount,
                hasOtherWindowsGroup: renderedOpenWorkspaceState.hasOtherWindowsGroup,
                otherWindowsStatus: renderedOpenWorkspaceState.otherWindowsStatus,
            });
            return;
        }
        if (message && message.type === 'open-workspace-pin-result') {
            completeOpenWorkspacePin(message);
            return;
        }
        if (message && message.type === 'ai-session-tab-selection-requested') {
            var requestedProject = findCurrentWorkspaceDiv(message.projectId);
            if (requestedProject && (message.tab === 'active' || message.tab === 'sessions')) {
                selectAiSessionTabDom(requestedProject, message.tab);
                writeAiSessionTabState(window.vscode, message.projectId, message.tab);
            }
            return;
        }

        if (message && message.type === 'ai-session-status-announcement') {
            var announcementProject = findCurrentWorkspaceDiv(message.projectId);
            var announcement = typeof message.message === 'string' ? message.message.trim().slice(0, 256) : '';
            var announcementRegion = announcementProject && announcementProject.querySelector('[data-ai-session-live-region]');
            if (announcementRegion && announcement) announcementRegion.textContent = announcement;
            return;
        }

        if (message && message.type === 'active-ai-session-terminal-changed') {
            activeAiSessionTerminalState.provider = isAiSessionProvider(message.provider) ? message.provider : null;
            activeAiSessionTerminalState.sessionId = typeof message.sessionId === 'string' ? message.sessionId : null;
            syncActiveAiSessionTerminalDom();
            return;
        }

        if (message && message.type === 'ai-session-attention-state') {
            window.__agentPivotAttentionEvents = window.__agentPivotAttentionEvents || {};
            window.__agentPivotAttentionSessionEvents = {};
            (Array.isArray(message.sessionEvents) ? message.sessionEvents.slice(0, 1000) : []).forEach(session => {
                if (!session || typeof session.sessionKey !== 'string' || !Array.isArray(session.eventIds)) return;
                var separator = session.sessionKey.indexOf(':');
                if (separator <= 0 || !isAiSessionProvider(session.sessionKey.slice(0, separator))) return;
                var eventIds = Array.from(new Set(session.eventIds
                    .slice(0, 1000)
                    .filter(eventId => typeof eventId === 'string' && !!eventId)));
                if (eventIds.length) window.__agentPivotAttentionSessionEvents[session.sessionKey] = eventIds;
            });
            (message.eventIds || []).forEach(eventId => {
                if (typeof eventId === 'string') window.__agentPivotAttentionEvents[eventId] = true;
            });
            return;
        }

        if (message && message.type === 'ai-session-batch-archive-completed') {
            if (batchAiSessionManager.complete(message)) {
                var completedProject = findCurrentWorkspaceDiv(message.projectId);
                syncAiSessionBatchManagementDom(completedProject);
                var archiveLiveRegion = completedProject
                    && completedProject.querySelector('[data-ai-session-live-region]');
                if (archiveLiveRegion) {
                    archiveLiveRegion.textContent =
                        getAiSessionBatchArchiveAnnouncement(message);
                }
            }
            return;
        }

        if (!message || message.type !== 'ai-sessions-updated') {
            return;
        }

        applyAiSessionsUpdate(message);
    }

    function applyAiSessionsUpdate(message) {
        if (message.version !== 2
            || typeof message.sequence !== 'number'
            || (message.currentWorkspaceCount !== 0 && message.currentWorkspaceCount !== 1)
            || typeof message.html !== 'string'
            || typeof normalizeDashboardSearchCatalog !== 'function'
            || normalizeDashboardSearchCatalog(message.searchCatalog) !== message.searchCatalog
            || message.searchCatalog.version !== 2) {
            requestFullRefresh('unsupported-ai-session-message');
            return;
        }

        if (message.sequence <= latestAiSessionUpdateSequence) {
            return;
        }

        if (!applyWorkspaceUpdate({
            type: 'workspace-updated',
            version: 2,
            currentWorkspaceCount: message.currentWorkspaceCount,
            html: message.html,
        }, {
            canRestoreAiSessionProviderMenu: () =>
                !pendingAiSessionProviderSelectionProjectId
                && !batchAiSessionState.pending,
        })) {
            requestFullRefresh('invalid-ai-session-workspace-update');
            return;
        }

        latestAiSessionUpdateSequence = message.sequence;
        if (batchAiSessionState.projectId) {
            var projectDiv = findCurrentWorkspaceDiv(batchAiSessionState.projectId);
            if (projectDiv) {
                batchAiSessionManager.reconcileVisible(projectDiv);
                syncAiSessionBatchManagementDom(projectDiv);
            } else {
                exitAiSessionBatchManagement();
            }
        }
        reconcilePendingAiSessionProviderSelectionDom();
        syncActiveAiSessionTerminalDom();
        updateStickyGroupHeaderOffset();
        if (window.__agentPivotDashboard) {
            window.__agentPivotDashboard.replaceSearchCatalog(message.searchCatalog);
        }
    }

    function findCurrentWorkspaceDiv(projectId) {
        if (!projectId) {
            return null;
        }

        var projects = document.querySelectorAll('.workspace-card[data-current-workspace][data-id]');
        for (var projectDiv of projects) {
            if (projectDiv.getAttribute("data-id") === projectId) {
                return projectDiv;
            }
        }

        return null;
    }

    function findWorkspaceDiv(navigationIdentity) {
        if (!navigationIdentity) {
            return null;
        }
        var workspaces = document.querySelectorAll('.workspace-card[data-workspace-navigation-identity]');
        for (var workspaceDiv of workspaces) {
            if (workspaceDiv.getAttribute('data-workspace-navigation-identity') === navigationIdentity) {
                return workspaceDiv;
            }
        }
        return null;
    }

    function focusSearchRevealTarget(target) {
        target.setAttribute('tabindex', '-1');
        target.focus();
        target.scrollIntoView({ block: 'nearest' });
        target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true });
    }

    window.__agentPivotRevealWorkspace = navigationIdentity => {
        var workspaceDiv = findWorkspaceDiv(navigationIdentity);
        if (!workspaceDiv) {
            return false;
        }
        focusSearchRevealTarget(workspaceDiv);
        return true;
    };

    function revealWorkspaceSession(navigationIdentity, provider, sessionId) {
        if (!isAiSessionProvider(provider) || !sessionId) {
            return false;
        }
        var workspaceDiv = findWorkspaceDiv(navigationIdentity);
        if (!workspaceDiv) {
            return false;
        }
        var workspaceId = workspaceDiv.getAttribute('data-id');
        if (!workspaceDiv.hasAttribute('data-codex-expanded')) {
            toggleCodexSessions(workspaceDiv, workspaceId);
        }
        selectAiSessionTabDom(workspaceDiv, 'sessions');
        writeAiSessionTabState(window.vscode, workspaceId, 'sessions');
        var sessionRow = Array.from(workspaceDiv.querySelectorAll('.codex-session-row[data-session-id][data-session-provider]'))
            .find(row => row.getAttribute('data-session-provider') === provider
                && row.getAttribute('data-session-id') === sessionId);
        if (sessionRow) {
            pendingWorkspaceSessionReveal = null;
            focusSearchRevealTarget(sessionRow);
            return true;
        }
        var selectedProviders = getSelectedAiSessionProviders(workspaceDiv);
        if (!selectedProviders.includes(provider)) {
            pendingWorkspaceSessionReveal = { navigationIdentity, provider, sessionId };
            submitAiSessionProviderSelection(
                workspaceDiv,
                selectedProviders.concat(provider)
            );
            return true;
        }
        pendingWorkspaceSessionReveal = null;
        focusSearchRevealTarget(workspaceDiv);
        return false;
    }

    window.__agentPivotRevealWorkspaceSession = revealWorkspaceSession;
    window.__agentPivotRevealPendingWorkspaceSession = () => {
        if (!pendingWorkspaceSessionReveal) {
            return false;
        }
        var pending = pendingWorkspaceSessionReveal;
        return revealWorkspaceSession(
            pending.navigationIdentity,
            pending.provider,
            pending.sessionId
        );
    };

    function requestFullRefresh(reason) {
        window.vscode.postMessage({
            type: 'request-full-refresh',
            reason,
        });
    }

    function observeStickyGroupHeaderOffset() {
        updateStickyGroupHeaderOffset();
        window.addEventListener('resize', updateStickyGroupHeaderOffset);

        var stickyHeader = document.querySelector('.steward-sticky-header');
        if (stickyHeader && typeof ResizeObserver !== 'undefined') {
            var observer = new ResizeObserver(updateStickyGroupHeaderOffset);
            observer.observe(stickyHeader);
            window.__stewardStickyHeaderObserver = observer;
        }
    }

    // Middle mouse button requires mousedown, as it does not fire click event when scroll option is available.
    document.addEventListener('click', (e) => {
        if (e.button !== 1) {
            onMouseEvent(e);
        }
    });

    document.addEventListener('change', onChangeEvent);
    document.addEventListener('submit', onTodoFormSubmit);

    document.addEventListener('mousedown', (e) => {
        if (e.target.closest('.codex-session-row')) {
            return;
        }

        if (e.button === 1) {
            onMouseEvent(e);
        }
    });

    document.addEventListener('contextmenu', (e) => {
        if (!e.target)
            return;

        onContextMenu(e);
    });

    document.addEventListener("keydown", e => {
        var aiSessionProviderTrigger = e.target && e.target.closest
            ? e.target.closest('[data-ai-provider-menu-trigger]')
            : null;
        if (aiSessionProviderTrigger
            && (e.key === 'ArrowDown' || e.key === 'ArrowUp'
                || e.key === 'Home' || e.key === 'End')) {
            e.preventDefault();
            var triggerProject = aiSessionProviderTrigger.closest('.project[data-id]');
            closeAiSessionProviderMenus(triggerProject);
            setAiSessionProviderMenuOpen(triggerProject, true);
            var triggerOptions = getAiSessionProviderOptions(triggerProject);
            var triggerOptionIndex = e.key === 'ArrowUp' || e.key === 'End'
                ? triggerOptions.length - 1
                : 0;
            triggerOptions[triggerOptionIndex]?.focus();
            return;
        }
        if (aiSessionProviderTrigger && e.key === 'Escape') {
            e.preventDefault();
            closeAiSessionProviderMenu(
                aiSessionProviderTrigger.closest('.project[data-id]'),
                true
            );
            return;
        }

        var aiSessionProviderOption = e.target && e.target.closest
            ? e.target.closest('[data-ai-provider-option][data-provider]')
            : null;
        if (aiSessionProviderOption) {
            var providerProject = aiSessionProviderOption.closest('.project[data-id]');
            var providerOptions = getAiSessionProviderOptions(providerProject);
            var providerOptionIndex = providerOptions.indexOf(aiSessionProviderOption);
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp'
                || e.key === 'Home' || e.key === 'End') {
                e.preventDefault();
                var nextProviderOptionIndex = e.key === 'Home' ? 0
                    : e.key === 'End' ? providerOptions.length - 1
                        : (providerOptionIndex + (e.key === 'ArrowDown' ? 1 : -1)
                            + providerOptions.length) % providerOptions.length;
                providerOptions[nextProviderOptionIndex]?.focus();
                return;
            }
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                activateAiSessionProviderOption(providerProject, aiSessionProviderOption);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                closeAiSessionProviderMenu(providerProject, true);
                return;
            }
            if (e.key === 'Tab') {
                closeAiSessionProviderMenu(providerProject, false);
            }
        }

        var aiSessionMenuItem = e.target && e.target.closest
            ? e.target.closest('#aiSessionContextMenu [role="menuitem"]')
            : null;
        if (aiSessionMenuItem) {
            var aiSessionMenu = aiSessionMenuItem.closest('#aiSessionContextMenu');
            var enabledMenuItems = Array.from(aiSessionMenu.querySelectorAll('[role="menuitem"]'))
                .filter(item => !item.classList.contains('disabled'));
            var currentMenuIndex = enabledMenuItems.indexOf(aiSessionMenuItem);
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
                e.preventDefault();
                var nextMenuIndex = e.key === 'Home' ? 0
                    : e.key === 'End' ? enabledMenuItems.length - 1
                        : (currentMenuIndex + (e.key === 'ArrowDown' ? 1 : -1) + enabledMenuItems.length)
                            % enabledMenuItems.length;
                enabledMenuItems[nextMenuIndex]?.focus();
                return;
            }
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onAiSessionContextMenuActionClicked(aiSessionMenuItem);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                var menuOrigin = contextMenuAiSessionOrigin;
                closeContextMenus();
                menuOrigin?.focus();
                return;
            }
            if (e.key === 'Tab') {
                closeContextMenus();
            }
        }

        var tab = e.target && e.target.closest ? e.target.closest('[data-ai-session-tab]') : null;
        if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
            e.preventDefault();
            var nextTabId = getAdjacentAiSessionTab(tab.getAttribute('data-ai-session-tab'), e.key);
            var projectDiv = tab.closest('.project[data-id]');
            var nextTab = projectDiv && Array.from(projectDiv.querySelectorAll('[data-ai-session-tab]'))
                .find(candidate => candidate.getAttribute('data-ai-session-tab') === nextTabId);
            nextTab?.focus();
            return;
        }
        if (tab && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            var tabProject = tab.closest('.project[data-id]');
            var tabProjectId = tabProject && tabProject.getAttribute('data-id');
            if (tabProjectId) onTriggerAiSessionAction(tab, tabProjectId);
            return;
        }

        var expandedConversationRow = e.target && e.target.closest
            ? e.target.closest(
                '.active-ai-session-row[data-conversation-expanded]'
            )
            : null;
        if (expandedConversationRow && e.key === 'Escape') {
            e.preventDefault();
            var conversationHeader = expandedConversationRow.querySelector(
                '.ai-session-primary-action'
            );
            collapseActiveAiSessionConversation();
            conversationHeader?.focus();
            return;
        }

        var sessionRow = e.target && e.target.closest ? e.target.closest('.codex-session-row') : null;
        var interactiveChild = e.target && e.target.closest
            ? e.target.closest('button, input, select, textarea, a[href]')
            : null;
        var primarySessionAction = e.target && e.target.closest
            ? e.target.closest('.ai-session-primary-action') : null;
        if (sessionRow && (!interactiveChild || primarySessionAction)
            && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) {
            e.preventDefault();
            var sessionRowRect = sessionRow.getBoundingClientRect();
            onContextMenu({
                target: primarySessionAction || sessionRow,
                preventDefault: () => {},
                clientX: sessionRowRect.left + 8,
                clientY: sessionRowRect.top + 8,
                keyboardTrigger: true,
            });
            return;
        }
        if (e.key === "Escape") {
            var editForm = e.target && e.target.closest ? e.target.closest('.todo-edit-form') : null;
            if (editForm) {
                e.preventDefault();
                setTodoEditing(editForm.getAttribute('data-todo-id'), false);
                return;
            }
            closeContextMenus();
            if (batchAiSessionState.projectId && !batchAiSessionState.pending) {
                exitAiSessionBatchManagement();
            }
        }
    });

    window.addEventListener('message', onWindowMessage);
    restoreAiSessionTabsFromState(document, window.vscode);
    window.vscode.postMessage({ type: 'request-active-ai-session-terminal' });
    window.vscode.postMessage({ type: 'request-ai-session-attention-state' });

    observeStickyGroupHeaderOffset();
}
