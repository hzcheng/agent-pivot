(function () {
    'use strict';

    var allowedTags = [
        'p', 'br', 'pre', 'code', 'blockquote', 'ul', 'ol', 'li',
        'strong', 'em', 'del', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'a', 'span', 'section', 'article',
    ];
    var allowedAttributes = [
        'href', 'class', 'data-message-id', 'data-interaction-id',
    ];
    var scroll = document.querySelector('[data-conversation-scroll]');
    var messages = document.querySelector('[data-conversation-messages]');
    var position = document.querySelector('[data-conversation-position]');
    var status = document.querySelector('[data-conversation-status]');
    var newResponse = document.querySelector('[data-new-response]');
    var previous = document.querySelector('[data-action="previous"]');
    var next = document.querySelector('[data-action="next"]');
    var latest = document.querySelector('[data-action="latest"]');
    var close = document.querySelector('[data-action="close"]');
    var state = {
        atLatest: false,
        initialized: false,
        latestRequestId: 0,
        subscriptionGeneration: Number(document.body.getAttribute(
            'data-subscription-generation'
        )),
        messageIds: [],
        messageSignatures: new Map(),
        firstNewMessageId: null,
    };

    if (!scroll || !messages || !position || !status || !newResponse
        || !previous || !next || !latest || !close || !window.DOMPurify) {
        return;
    }

    window.DOMPurify.addHook('afterSanitizeAttributes', function (node) {
        if (!node.hasAttribute || !node.hasAttribute('href')) {
            return;
        }
        var href = node.getAttribute('href');
        try {
            if (new URL(href, document.baseURI).protocol !== 'https:') {
                node.removeAttribute('href');
            }
        } catch (_error) {
            node.removeAttribute('href');
        }
    });

    function post(message) {
        if (window.vscode && typeof window.vscode.postMessage === 'function') {
            window.vscode.postMessage(message);
        }
    }

    function validPage(message) {
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
            return false;
        }
        var requiredKeys = [
            'type', 'version', 'requestId', 'subscriptionGeneration',
            'updateKind', 'html', 'selectedInteractionId', 'selectedInput',
            'totalInputs', 'partial', 'atLatest', 'stale',
        ];
        var allowedKeys = new Set(requiredKeys.concat([
            'previousCursor', 'nextCursor',
        ]));
        if (Object.keys(message).some(function (key) {
            return !allowedKeys.has(key);
        }) || requiredKeys.some(function (key) {
            return !Object.prototype.hasOwnProperty.call(message, key);
        })) {
            return false;
        }
        return message.type === 'conversation-viewer-page'
            && message.version === 1
            && Number.isSafeInteger(message.requestId)
            && message.requestId >= 1
            && Number.isSafeInteger(message.subscriptionGeneration)
            && message.subscriptionGeneration >= 1
            && (message.updateKind === 'initial'
                || message.updateKind === 'navigation'
                || message.updateKind === 'refresh')
            && typeof message.html === 'string'
            && typeof message.selectedInteractionId === 'string'
            && Number.isSafeInteger(message.selectedInput)
            && message.selectedInput >= 0
            && Number.isSafeInteger(message.totalInputs)
            && message.totalInputs >= 0
            && typeof message.partial === 'boolean'
            && typeof message.atLatest === 'boolean'
            && (message.previousCursor === undefined
                || typeof message.previousCursor === 'string')
            && (message.nextCursor === undefined
                || typeof message.nextCursor === 'string')
            && typeof message.stale === 'boolean';
    }

    function getMessageIds() {
        return Array.prototype.map.call(
            messages.querySelectorAll('[data-message-id]'),
            function (message) {
                return message.getAttribute('data-message-id');
            }
        );
    }

    function getMessageSignatures() {
        var signatures = new Map();
        Array.prototype.forEach.call(
            messages.querySelectorAll('[data-message-id]'),
            function (message) {
                signatures.set(
                    message.getAttribute('data-message-id'),
                    message.innerHTML
                );
            }
        );
        return signatures;
    }

    function threshold() {
        var value = Number(document.body.getAttribute(
            'data-auto-scroll-threshold'
        ));
        return Number.isFinite(value) && value >= 0 ? value : 0;
    }

    function distanceFromBottom() {
        return Math.max(0, scroll.scrollHeight - scroll.scrollTop
            - scroll.clientHeight);
    }

    function updatePosition(message) {
        var total = message.totalInputs.toLocaleString();
        if (message.partial) total += '+';
        position.textContent = 'Input ' + message.selectedInput + ' of ' + total;
    }

    function applyPage(message) {
        if (!validPage(message)
            || message.subscriptionGeneration !== state.subscriptionGeneration
            || message.requestId <= state.latestRequestId) {
            return;
        }
        state.latestRequestId = message.requestId;
        var previousScrollTop = scroll.scrollTop;
        var isLiveRefresh = state.initialized
            && message.updateKind === 'refresh';
        var shouldFollow = isLiveRefresh
            && state.atLatest
            && distanceFromBottom() <= threshold()
            && message.atLatest;
        var oldIds = new Set(state.messageIds);
        var oldSignatures = state.messageSignatures;
        var clean = window.DOMPurify.sanitize(message.html, {
            ALLOWED_TAGS: allowedTags,
            ALLOWED_ATTR: allowedAttributes,
            ALLOW_DATA_ATTR: false,
            ALLOW_ARIA_ATTR: false,
        });

        messages.innerHTML = clean;
        var nextIds = getMessageIds();
        var nextSignatures = getMessageSignatures();
        var appendedOrChanged = nextIds.filter(function (id) {
            return !oldIds.has(id)
                || oldSignatures.get(id) !== nextSignatures.get(id);
        });
        state.messageIds = nextIds;
        state.messageSignatures = nextSignatures;
        state.atLatest = message.atLatest;
        state.initialized = true;
        updatePosition(message);
        previous.disabled = message.previousCursor === undefined;
        next.disabled = message.nextCursor === undefined;
        latest.disabled = message.atLatest;
        var statusMessages = [];
        if (message.stale) {
            statusMessages.push('Conversation history may be out of date.');
        }
        if (message.partial) {
            statusMessages.push('Partial history — showing newest inputs.');
        }
        status.textContent = statusMessages.join(' ');

        var selectedMessages = Array.prototype.filter.call(
            messages.querySelectorAll('[data-interaction-id]'),
            function (candidate) {
                return candidate.getAttribute('data-interaction-id')
                    === message.selectedInteractionId;
            }
        );
        selectedMessages.forEach(function (candidate) {
            candidate.classList.add('conversation-selected-interaction');
            window.setTimeout(function () {
                candidate.classList.remove('conversation-selected-interaction');
            }, 1600);
        });

        if (!isLiveRefresh) {
            state.firstNewMessageId = null;
            newResponse.hidden = true;
            var selected = selectedMessages[0];
            if (selected) {
                selected.scrollIntoView({ block: 'center' });
                if (message.updateKind === 'navigation') {
                    selected.tabIndex = -1;
                    selected.focus({ preventScroll: true });
                }
            }
            return;
        }

        if (shouldFollow) {
            scroll.scrollTop = scroll.scrollHeight;
            state.firstNewMessageId = null;
            newResponse.hidden = true;
            return;
        }

        scroll.scrollTop = previousScrollTop;
        if (state.firstNewMessageId
            && !nextIds.includes(state.firstNewMessageId)) {
            state.firstNewMessageId = null;
        }
        if (!state.firstNewMessageId && appendedOrChanged.length) {
            state.firstNewMessageId = appendedOrChanged[0];
        }
        newResponse.hidden = !state.firstNewMessageId;
    }

    function postNavigation(type) {
        post({ type: type, version: 1 });
    }

    previous.addEventListener('click', function () {
        postNavigation('conversation-viewer-previous');
    });
    next.addEventListener('click', function () {
        postNavigation('conversation-viewer-next');
    });
    latest.addEventListener('click', function () {
        postNavigation('conversation-viewer-latest');
    });
    close.addEventListener('click', function () {
        postNavigation('conversation-viewer-closed');
    });
    newResponse.addEventListener('click', function () {
        var target = Array.prototype.find.call(
            messages.querySelectorAll('[data-message-id]'),
            function (message) {
                return message.getAttribute('data-message-id')
                    === state.firstNewMessageId;
            }
        );
        if (!target) return;
        target.tabIndex = -1;
        target.scrollIntoView({ block: 'nearest' });
        target.focus();
        state.firstNewMessageId = null;
        newResponse.hidden = true;
    });
    messages.addEventListener('click', function (event) {
        var link = event.target && event.target.closest
            ? event.target.closest('a[href]')
            : null;
        if (!link || !messages.contains(link)) return;
        event.preventDefault();
        var href = link.getAttribute('href');
        try {
            if (new URL(href, document.baseURI).protocol !== 'https:') return;
        } catch (_error) {
            return;
        }
        post({
            type: 'conversation-viewer-open-link',
            version: 1,
            href: href,
        });
    });
    document.addEventListener('keydown', function (event) {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        postNavigation('conversation-viewer-closed');
    });
    window.addEventListener('message', function (event) {
        applyPage(event.data);
    });

    var initialPage = document.body.getAttribute('data-initial-page');
    if (initialPage) {
        document.body.removeAttribute('data-initial-page');
        try {
            applyPage(JSON.parse(initialPage));
        } catch (_error) {
            status.textContent = 'Conversation history unavailable.';
        }
    }
}());
