(function () {
    'use strict';

    var allowedTags = [
        'p', 'br', 'pre', 'code', 'blockquote', 'ul', 'ol', 'li',
        'strong', 'em', 'del', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'a', 'img', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
        'span', 'section', 'article',
    ];
    var allowedAttributes = [
        'href', 'src', 'alt', 'title', 'class',
        'data-message-id', 'data-interaction-id',
    ];
    var maxMermaidDiagrams = 40;
    var viewerScript = document.currentScript;
    var scriptNonce = viewerScript ? viewerScript.nonce : '';
    var mermaidSource = document.body.getAttribute('data-mermaid-src') || '';
    document.body.removeAttribute('data-mermaid-src');
    var vscodeApi = null;
    try {
        if (typeof acquireVsCodeApi === 'function') {
            vscodeApi = acquireVsCodeApi();
        } else if (window.vscode
            && typeof window.vscode.postMessage === 'function') {
            vscodeApi = window.vscode;
        }
    } catch (_error) {
        vscodeApi = null;
    }
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
        mermaidInitialized: false,
        mermaidObjectUrls: [],
        mermaidLoad: null,
        renderGeneration: 0,
    };

    if (!scroll || !messages || !position || !status || !newResponse
        || !previous || !next || !latest || !close || !window.DOMPurify) {
        return;
    }

    function isHttps(value) {
        try {
            return new URL(value, document.baseURI).protocol === 'https:';
        } catch (_error) {
            return false;
        }
    }

    window.DOMPurify.addHook('afterSanitizeAttributes', function (node) {
        if (!node.hasAttribute) return;
        if (node.hasAttribute('href') && !isHttps(
            node.getAttribute('href')
        )) {
            node.removeAttribute('href');
        }
        if (node.hasAttribute('src') && !isHttps(
            node.getAttribute('src')
        )) {
            node.removeAttribute('src');
        }
    });

    function releaseMermaidObjectUrls() {
        state.mermaidObjectUrls.forEach(function (url) {
            try {
                URL.revokeObjectURL(url);
            } catch (_error) {
                // Revocation is best-effort during document teardown.
            }
        });
        state.mermaidObjectUrls = [];
    }

    function themeValue(name, fallback) {
        var value = window.getComputedStyle(document.body)
            .getPropertyValue(name)
            .trim();
        return value || fallback;
    }

    function initializeMermaid() {
        if (state.mermaidInitialized) return true;
        if (!window.mermaid
            || typeof window.mermaid.initialize !== 'function') {
            return false;
        }
        try {
            window.mermaid.initialize({
                startOnLoad: false,
                securityLevel: 'strict',
                suppressErrorRendering: true,
                maxTextSize: 50000,
                theme: 'base',
                fontFamily: themeValue(
                    '--vscode-font-family',
                    'system-ui, sans-serif'
                ),
                flowchart: {
                    htmlLabels: false,
                },
                themeVariables: {
                    darkMode: document.body.classList.contains('vscode-dark')
                        || document.body.classList.contains(
                            'vscode-high-contrast'
                        ),
                    background: themeValue(
                        '--vscode-editor-background',
                        '#1e1e1e'
                    ),
                    primaryColor: themeValue(
                        '--vscode-textCodeBlock-background',
                        '#252526'
                    ),
                    primaryTextColor: themeValue(
                        '--vscode-editor-foreground',
                        '#d4d4d4'
                    ),
                    primaryBorderColor: themeValue(
                        '--vscode-panel-border',
                        '#454545'
                    ),
                    lineColor: themeValue(
                        '--vscode-descriptionForeground',
                        '#a0a0a0'
                    ),
                    secondaryColor: themeValue(
                        '--vscode-input-background',
                        '#252526'
                    ),
                    tertiaryColor: themeValue(
                        '--vscode-editor-background',
                        '#1e1e1e'
                    ),
                },
            });
            state.mermaidInitialized = true;
            return true;
        } catch (_error) {
            return false;
        }
    }

    function loadMermaid() {
        if (window.mermaid) {
            return Promise.resolve(initializeMermaid());
        }
        if (state.mermaidLoad) return state.mermaidLoad;
        if (!mermaidSource) return Promise.resolve(false);
        state.mermaidLoad = new Promise(function (resolve) {
            var script = document.createElement('script');
            script.src = mermaidSource;
            if (scriptNonce) script.nonce = scriptNonce;
            script.addEventListener('load', function () {
                resolve(initializeMermaid());
            }, { once: true });
            script.addEventListener('error', function () {
                resolve(false);
            }, { once: true });
            document.head.appendChild(script);
        });
        return state.mermaidLoad;
    }

    function mermaidAlt(source) {
        var summary = source.split(/\r?\n/).map(function (line) {
            return line.trim();
        }).find(function (line) {
            return line.length > 0;
        }) || 'diagram';
        return 'Mermaid diagram: ' + summary.slice(0, 120);
    }

    function normalizeSvg(svg) {
        var clean = window.DOMPurify.sanitize(svg, {
            USE_PROFILES: {
                svg: true,
                svgFilters: true,
            },
            FORBID_TAGS: ['foreignObject', 'script'],
            ALLOW_DATA_ATTR: false,
        });
        var documentValue = new DOMParser().parseFromString(
            clean,
            'image/svg+xml'
        );
        var root = documentValue.documentElement;
        if (!root
            || root.localName !== 'svg'
            || documentValue.querySelector('parsererror')) {
            throw new Error('Mermaid returned invalid SVG.');
        }
        var viewBox = (root.getAttribute('viewBox') || '')
            .trim()
            .split(/[\s,]+/)
            .map(Number);
        if (viewBox.length === 4
            && viewBox.every(Number.isFinite)
            && viewBox[2] > 0
            && viewBox[3] > 0) {
            root.setAttribute('width', String(Math.min(viewBox[2], 4096)));
            root.setAttribute('height', String(Math.min(viewBox[3], 4096)));
        }
        return new XMLSerializer().serializeToString(root);
    }

    function renderMermaidDiagram(pre, source, id, generation) {
        pre.setAttribute('aria-busy', 'true');
        return Promise.resolve(window.mermaid.render(id, source))
            .then(function (result) {
                if (generation !== state.renderGeneration
                    || !pre.isConnected) {
                    return;
                }
                var svg = normalizeSvg(result.svg);
                var objectUrl = URL.createObjectURL(new Blob([svg], {
                    type: 'image/svg+xml',
                }));
                if (generation !== state.renderGeneration
                    || !pre.isConnected) {
                    URL.revokeObjectURL(objectUrl);
                    return;
                }
                state.mermaidObjectUrls.push(objectUrl);
                var figure = document.createElement('figure');
                figure.className = 'conversation-mermaid';
                var image = document.createElement('img');
                image.className = 'conversation-mermaid-image';
                image.src = objectUrl;
                image.alt = mermaidAlt(source);
                image.decoding = 'async';
                figure.appendChild(image);
                pre.replaceWith(figure);
            })
            .catch(function () {
                if (generation !== state.renderGeneration
                    || !pre.isConnected) {
                    return;
                }
                pre.removeAttribute('aria-busy');
                pre.classList.add('conversation-mermaid-error');
                var label = document.createElement('span');
                label.className = 'conversation-mermaid-error-label';
                label.setAttribute('role', 'status');
                label.textContent = 'Mermaid diagram could not be rendered.';
                pre.parentNode.insertBefore(label, pre);
                var temporary = document.getElementById(id);
                if (temporary) temporary.remove();
            });
    }

    function renderMermaidDiagrams(generation) {
        var codeBlocks = Array.prototype.slice.call(
            messages.querySelectorAll('pre > code.language-mermaid'),
            0,
            maxMermaidDiagrams
        );
        if (!codeBlocks.length) return Promise.resolve();
        return loadMermaid().then(function (available) {
            if (!available || generation !== state.renderGeneration) return;
            return codeBlocks.reduce(function (promise, code, index) {
                return promise.then(function () {
                    if (generation !== state.renderGeneration) return undefined;
                    return renderMermaidDiagram(
                        code.parentElement,
                        code.textContent || '',
                        'conversation-mermaid-' + generation + '-' + index,
                        generation
                    );
                });
            }, Promise.resolve());
        });
    }

    function post(message) {
        if (vscodeApi && typeof vscodeApi.postMessage === 'function') {
            vscodeApi.postMessage(message);
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
        state.renderGeneration += 1;
        var renderGeneration = state.renderGeneration;
        releaseMermaidObjectUrls();
        var clean = window.DOMPurify.sanitize(message.html, {
            ALLOWED_TAGS: allowedTags,
            ALLOWED_ATTR: allowedAttributes,
            ALLOW_DATA_ATTR: false,
            ALLOW_ARIA_ATTR: false,
        });

        messages.innerHTML = clean;
        Array.prototype.forEach.call(
            messages.querySelectorAll('img'),
            function (image) {
                image.loading = 'lazy';
                image.decoding = 'async';
                image.referrerPolicy = 'no-referrer';
            }
        );
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
        renderMermaidDiagrams(renderGeneration).then(function () {
            if (renderGeneration !== state.renderGeneration) return;
            if (shouldFollow) {
                scroll.scrollTop = scroll.scrollHeight;
            } else if (isLiveRefresh) {
                scroll.scrollTop = previousScrollTop;
            } else if (selectedMessages[0]) {
                selectedMessages[0].scrollIntoView({ block: 'center' });
            }
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
    window.addEventListener('unload', releaseMermaidObjectUrls);

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
