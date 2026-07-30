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
        'data-message-id', 'data-conversation-message-id',
        'data-interaction-id',
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
    var commentsToggle = document.querySelector(
        '[data-action="toggle-comments"]'
    );
    var commentsWorkspace = document.querySelector('.conversation-workspace');
    var commentsResizer = document.querySelector('[data-comments-resizer]');
    var commentsRoot = document.querySelector('[data-conversation-comments]');
    var commentCount = document.querySelector('[data-comment-count]');
    var commentComposer = document.querySelector('[data-comment-composer]');
    var commentSelection = document.querySelector('[data-comment-selection]');
    var commentInput = document.querySelector('[data-comment-input]');
    var commentList = document.querySelector('[data-comment-list]');
    var commentEmpty = document.querySelector('[data-comment-empty]');
    var commentSend = document.querySelector('[data-comment-action="send"]');
    var addComment = document.querySelector('[data-add-comment]');
    var commentTarget = readJsonAttribute('data-conversation-target');
    var commentUiAvailable = !!commentsRoot && !!commentCount
        && !!commentComposer && !!commentSelection && !!commentInput
        && !!commentList && !!commentEmpty && !!commentSend && !!addComment
        && !!commentsToggle && !!commentsWorkspace && !!commentsResizer
        && validCommentTarget(commentTarget);
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
        comments: [],
        commentRevision: 0,
        commentRequestSequence: 0,
        pendingCommentRequest: null,
        pendingLocateRequest: null,
        selectedCommentText: null,
        commentsPanelOpen: true,
        commentsPanelWidth: 240,
    };

    if (!scroll || !messages || !position || !status || !newResponse
        || !previous || !next || !latest || !close || !window.DOMPurify) {
        return;
    }

    var commentsPanelMinWidth = 192;
    var commentsPanelMaxWidth = 420;
    var conversationMinWidth = 320;

    function readCommentsPanelState() {
        if (!vscodeApi || typeof vscodeApi.getState !== 'function') return null;
        try {
            var saved = vscodeApi.getState();
            var panelState = saved && saved.conversationCommentsPanel;
            return panelState && typeof panelState === 'object'
                && !Array.isArray(panelState)
                ? panelState
                : null;
        } catch (_error) {
            return null;
        }
    }

    function saveCommentsPanelState() {
        if (!vscodeApi || typeof vscodeApi.setState !== 'function') return;
        try {
            var saved = typeof vscodeApi.getState === 'function'
                ? vscodeApi.getState()
                : null;
            var next = saved && typeof saved === 'object'
                && !Array.isArray(saved)
                ? Object.assign({}, saved)
                : {};
            next.conversationCommentsPanel = {
                open: state.commentsPanelOpen,
                width: state.commentsPanelWidth,
            };
            vscodeApi.setState(next);
        } catch (_error) {
            // Layout persistence is best-effort local Webview state.
        }
    }

    function availableCommentsPanelMaxWidth() {
        return Math.max(
            commentsPanelMinWidth,
            Math.min(
                commentsPanelMaxWidth,
                commentsWorkspace.clientWidth - conversationMinWidth
            )
        );
    }

    function clampCommentsPanelWidth(value) {
        return Math.max(
            commentsPanelMinWidth,
            Math.min(availableCommentsPanelMaxWidth(), value)
        );
    }

    function updateCommentsToggle() {
        if (!commentUiAvailable) return;
        commentsToggle.textContent = 'Comments (' + openCommentCount()
            + ' open)';
        commentsToggle.setAttribute(
            'aria-expanded',
            state.commentsPanelOpen ? 'true' : 'false'
        );
        var label = state.commentsPanelOpen
            ? 'Hide comments panel'
            : 'Show comments panel';
        commentsToggle.setAttribute('aria-label', label);
        commentsToggle.title = label;
    }

    function applyCommentsPanelLayout() {
        if (!commentUiAvailable) return;
        var width = clampCommentsPanelWidth(state.commentsPanelWidth);
        commentsWorkspace.style.setProperty(
            '--conversation-comments-width',
            width + 'px'
        );
        commentsWorkspace.setAttribute(
            'data-comments-open',
            state.commentsPanelOpen ? 'true' : 'false'
        );
        commentsRoot.hidden = !state.commentsPanelOpen;
        commentsResizer.hidden = !state.commentsPanelOpen;
        commentsResizer.setAttribute('aria-valuemax', String(
            availableCommentsPanelMaxWidth()
        ));
        commentsResizer.setAttribute('aria-valuenow', String(width));
        updateCommentsToggle();
    }

    function setCommentsPanelOpen(open, persist) {
        state.commentsPanelOpen = open;
        applyCommentsPanelLayout();
        if (persist) saveCommentsPanelState();
    }

    function setCommentsPanelWidth(width, persist) {
        state.commentsPanelWidth = clampCommentsPanelWidth(width);
        applyCommentsPanelLayout();
        if (persist) saveCommentsPanelState();
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
                htmlLabels: false,
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

    function conversationMessageSelector() {
        return '[data-conversation-message-id],[data-message-id]';
    }

    function conversationMessageId(message) {
        var encoded = message.getAttribute('data-conversation-message-id');
        if (encoded) {
            try {
                return decodeURIComponent(encoded);
            } catch (_error) {
                return '';
            }
        }
        return message.getAttribute('data-message-id');
    }

    function readJsonAttribute(name) {
        var value = document.body.getAttribute(name);
        if (!value) return null;
        document.body.removeAttribute(name);
        try {
            return JSON.parse(value);
        } catch (_error) {
            return null;
        }
    }

    function validCommentTarget(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return false;
        }
        var keys = Object.keys(value);
        return keys.length === 3
            && typeof value.projectId === 'string'
            && value.projectId.length > 0
            && (value.provider === 'codex'
                || value.provider === 'kimi'
                || value.provider === 'claude')
            && typeof value.sessionId === 'string'
            && value.sessionId.length > 0;
    }

    function validComment(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return false;
        }
        var keys = [
            'id', 'messageId', 'interactionId', 'role',
            'quote', 'prefix', 'suffix', 'comment', 'status',
        ];
        return Object.keys(value).length === keys.length
            && keys.every(function (key) {
                return Object.prototype.hasOwnProperty.call(value, key);
            })
            && typeof value.id === 'string'
            && typeof value.messageId === 'string'
            && typeof value.interactionId === 'string'
            && (value.role === 'user' || value.role === 'assistant')
            && typeof value.quote === 'string'
            && typeof value.prefix === 'string'
            && typeof value.suffix === 'string'
            && typeof value.comment === 'string'
            && (value.status === 'open'
                || value.status === 'sent'
                || value.status === 'resolved');
    }

    function validInitialComments(value) {
        return value && typeof value === 'object' && !Array.isArray(value)
            && Object.keys(value).length === 2
            && Number.isSafeInteger(value.revision)
            && value.revision >= 0
            && Array.isArray(value.comments)
            && value.comments.length <= 20
            && value.comments.every(validComment);
    }

    function validCommentsResult(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return false;
        }
        var required = [
            'type', 'version', 'requestId', 'subscriptionGeneration',
            'projectId', 'provider', 'sessionId', 'operation', 'success',
            'revision', 'comments',
        ];
        var allowed = new Set(required.concat(['error']));
        return Object.keys(value).every(function (key) {
            return allowed.has(key);
        }) && required.every(function (key) {
            return Object.prototype.hasOwnProperty.call(value, key);
        })
            && value.type === 'conversation-viewer-comments-result'
            && value.version === 1
            && typeof value.requestId === 'string'
            && Number.isSafeInteger(value.subscriptionGeneration)
            && typeof value.projectId === 'string'
            && (value.provider === 'codex'
                || value.provider === 'kimi'
                || value.provider === 'claude')
            && typeof value.sessionId === 'string'
            && (value.operation === 'add'
                || value.operation === 'update'
                || value.operation === 'delete'
                || value.operation === 'resolve'
                || value.operation === 'reopen'
                || value.operation === 'sendComments')
            && typeof value.success === 'boolean'
            && Number.isSafeInteger(value.revision)
            && value.revision >= 0
            && Array.isArray(value.comments)
            && value.comments.length <= 20
            && value.comments.every(validComment)
            && (value.error === undefined || [
                'invalid', 'stale', 'limit', 'tooLarge',
                'unavailable', 'busy', 'conflict', 'failed',
            ].includes(value.error));
    }

    function validLocateResult(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return false;
        }
        var required = [
            'type', 'version', 'requestId', 'subscriptionGeneration',
            'projectId', 'provider', 'sessionId', 'commentId', 'success',
        ];
        var allowed = new Set(required.concat(['error']));
        return Object.keys(value).every(function (key) {
            return allowed.has(key);
        }) && required.every(function (key) {
            return Object.prototype.hasOwnProperty.call(value, key);
        })
            && value.type === 'conversation-viewer-locate-comment-result'
            && value.version === 1
            && typeof value.requestId === 'string'
            && Number.isSafeInteger(value.subscriptionGeneration)
            && typeof value.projectId === 'string'
            && (value.provider === 'codex'
                || value.provider === 'kimi'
                || value.provider === 'claude')
            && typeof value.sessionId === 'string'
            && typeof value.commentId === 'string'
            && typeof value.success === 'boolean'
            && (value.error === undefined || value.error === 'stale');
    }

    function openCommentCount() {
        return state.comments.filter(function (comment) {
            return comment.status === 'open';
        }).length;
    }

    function nextCommentRequestId() {
        state.commentRequestSequence += 1;
        return [
            'conversation-comment',
            Date.now().toString(36),
            state.commentRequestSequence.toString(36),
        ].join(':');
    }

    function commentErrorMessage(error) {
        if (error === 'stale') return 'Comments changed. Review the latest draft and try again.';
        if (error === 'limit') return 'A maximum of 20 comments can be sent at once.';
        if (error === 'tooLarge') return 'The combined comments are too large to send.';
        if (error === 'busy') return 'Wait for the current AI response to finish, then send again.';
        if (error === 'conflict') return 'Multiple runtimes match this session. Resolve the conflict first.';
        if (error === 'unavailable') return 'This session is unavailable and the comments were not sent.';
        return 'The comment action failed. Your comments were kept.';
    }

    function setCommentPending(pending) {
        if (!commentUiAvailable) return;
        Array.prototype.forEach.call(
            commentsRoot.querySelectorAll('button, textarea'),
            function (control) {
                control.disabled = pending;
            }
        );
        addComment.disabled = pending;
        if (!pending) {
            commentSend.disabled = openCommentCount() === 0;
        }
        commentsRoot.setAttribute('aria-busy', pending ? 'true' : 'false');
    }

    function postCommentOperation(operation, payload) {
        if (!commentUiAvailable
            || state.pendingCommentRequest
            || state.pendingLocateRequest) return;
        var requestId = nextCommentRequestId();
        state.pendingCommentRequest = { requestId: requestId, operation: operation };
        setCommentPending(true);
        status.textContent = operation === 'sendComments'
            ? 'Sending comments to this session…'
            : 'Saving comment…';
        post({
            type: operation === 'sendComments'
                ? 'conversation-viewer-send-comments'
                : 'conversation-viewer-comment-mutation',
            version: 1,
            requestId: requestId,
            subscriptionGeneration: state.subscriptionGeneration,
            projectId: commentTarget.projectId,
            provider: commentTarget.provider,
            sessionId: commentTarget.sessionId,
            operation: operation,
            expectedRevision: state.commentRevision,
            payload: payload,
        });
    }

    function locateComment(comment) {
        var message = Array.prototype.find.call(
            messages.querySelectorAll(conversationMessageSelector()),
            function (candidate) {
                return conversationMessageId(candidate) === comment.messageId;
            }
        );
        if (!message) {
            return false;
        }
        message.scrollIntoView({ block: 'center' });
        message.tabIndex = -1;
        message.focus({ preventScroll: true });
        message.classList.add('conversation-comment-located');
        window.setTimeout(function () {
            message.classList.remove('conversation-comment-located');
        }, 1600);
        return true;
    }

    function requestCommentLocation(comment) {
        if (locateComment(comment)) {
            status.textContent = 'Comment source located.';
            return;
        }
        if (state.pendingLocateRequest || state.pendingCommentRequest) return;
        var requestId = nextCommentRequestId();
        state.pendingLocateRequest = {
            requestId: requestId,
            commentId: comment.id,
        };
        setCommentPending(true);
        status.textContent = 'Loading the commented message…';
        post({
            type: 'conversation-viewer-locate-comment',
            version: 1,
            requestId: requestId,
            subscriptionGeneration: state.subscriptionGeneration,
            projectId: commentTarget.projectId,
            provider: commentTarget.provider,
            sessionId: commentTarget.sessionId,
            commentId: comment.id,
        });
    }

    function renderComments() {
        if (!commentUiAvailable) return;
        commentList.replaceChildren();
        state.comments.forEach(function (comment, index) {
            var item = document.createElement('article');
            item.className = 'conversation-comment';
            item.setAttribute('data-comment-id', comment.id);
            item.setAttribute('data-comment-status', comment.status);

            var heading = document.createElement('div');
            heading.className = 'conversation-comment-heading';
            var identity = document.createElement('div');
            identity.className = 'conversation-comment-identity';
            var label = document.createElement('strong');
            label.textContent = 'Comment ' + (index + 1);
            var statusLabel = document.createElement('span');
            statusLabel.className = 'conversation-comment-status';
            statusLabel.setAttribute('data-comment-status-label', '');
            statusLabel.textContent = comment.status === 'open'
                ? 'Open'
                : comment.status === 'sent' ? 'Sent' : 'Resolved';
            identity.append(label, statusLabel);
            var locate = document.createElement('button');
            locate.type = 'button';
            locate.setAttribute('data-comment-action', 'locate');
            locate.textContent = 'Show text';
            heading.append(identity, locate);

            var quote = document.createElement('blockquote');
            quote.textContent = comment.quote;
            var input = document.createElement('textarea');
            input.rows = 2;
            input.maxLength = 4000;
            input.value = comment.comment;
            input.readOnly = comment.status !== 'open';
            input.setAttribute('aria-label', 'Comment ' + (index + 1));
            input.setAttribute(
                'aria-keyshortcuts',
                'Control+Enter Meta+Enter'
            );
            input.setAttribute('data-comment-edit', '');
            var actions = document.createElement('div');
            actions.className = 'conversation-comment-actions';
            var remove = document.createElement('button');
            remove.type = 'button';
            remove.setAttribute('data-comment-action', 'delete');
            remove.textContent = 'Delete';
            actions.appendChild(remove);
            if (comment.status === 'open') {
                var save = document.createElement('button');
                save.type = 'button';
                save.setAttribute('data-comment-action', 'update');
                save.title = 'Save comment (Ctrl+Enter or Cmd+Enter)';
                save.textContent = 'Save';
                actions.appendChild(save);
            }
            var review = document.createElement('button');
            review.type = 'button';
            if (comment.status === 'resolved') {
                review.setAttribute('data-comment-action', 'reopen');
                review.textContent = 'Reopen';
            } else if (comment.status === 'sent') {
                review.setAttribute('data-comment-action', 'resolve');
                review.textContent = 'Resolve';
                var reopen = document.createElement('button');
                reopen.type = 'button';
                reopen.setAttribute('data-comment-action', 'reopen');
                reopen.textContent = 'Reopen';
                actions.appendChild(reopen);
            } else {
                review.setAttribute('data-comment-action', 'resolve');
                review.textContent = 'Resolve';
            }
            actions.appendChild(review);
            item.append(heading, quote, input, actions);
            commentList.appendChild(item);
        });
        commentCount.textContent = String(state.comments.length);
        updateCommentsToggle();
        commentEmpty.hidden = state.comments.length > 0;
        var openCount = openCommentCount();
        commentSend.textContent = 'Send ' + openCount + ' open comment'
            + (openCount === 1 ? '' : 's') + ' to this session';
        commentSend.disabled = openCount === 0
            || !!state.pendingCommentRequest;
        updateCommentHighlights();
    }

    function findQuoteRange(root, comment) {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        var nodes = [];
        var combined = '';
        var node;
        while ((node = walker.nextNode())) {
            nodes.push({ node: node, start: combined.length });
            combined += node.nodeValue || '';
        }
        var candidates = [];
        var candidate = combined.indexOf(comment.quote);
        while (candidate >= 0) {
            candidates.push(candidate);
            candidate = combined.indexOf(
                comment.quote,
                candidate + 1
            );
        }
        var start = candidates.find(function (offset) {
            var before = combined.slice(
                Math.max(0, offset - comment.prefix.length),
                offset
            );
            var after = combined.slice(
                offset + comment.quote.length,
                offset + comment.quote.length + comment.suffix.length
            );
            return before === comment.prefix && after === comment.suffix;
        });
        if (start === undefined) start = candidates[0];
        if (start === undefined) return null;
        var end = start + comment.quote.length;
        var startRecord = nodes.find(function (record) {
            return start >= record.start
                && start <= record.start + (record.node.nodeValue || '').length;
        });
        var endRecord = nodes.find(function (record) {
            return end >= record.start
                && end <= record.start + (record.node.nodeValue || '').length;
        });
        if (!startRecord || !endRecord) return null;
        var range = document.createRange();
        range.setStart(startRecord.node, start - startRecord.start);
        range.setEnd(endRecord.node, end - endRecord.start);
        return range;
    }

    function updateCommentHighlights() {
        if (!commentUiAvailable) return;
        Array.prototype.forEach.call(
            messages.querySelectorAll('.conversation-has-comment'),
            function (message) {
                message.classList.remove('conversation-has-comment');
            }
        );
        var ranges = [];
        state.comments.forEach(function (comment) {
            if (comment.status === 'resolved') return;
            var message = Array.prototype.find.call(
                messages.querySelectorAll(conversationMessageSelector()),
                function (candidate) {
                    return conversationMessageId(candidate)
                        === comment.messageId;
                }
            );
            if (!message) return;
            message.classList.add('conversation-has-comment');
            var markdown = message.querySelector('.conversation-markdown');
            var range = markdown && findQuoteRange(markdown, comment);
            if (range) ranges.push(range);
        });
        if (window.CSS && CSS.highlights && typeof Highlight === 'function') {
            CSS.highlights.delete('conversation-comments');
            if (ranges.length) {
                CSS.highlights.set(
                    'conversation-comments',
                    new Highlight(...ranges)
                );
            }
        }
    }

    function applyCommentsResult(message) {
        if (!commentUiAvailable
            || !validCommentsResult(message)
            || message.subscriptionGeneration !== state.subscriptionGeneration
            || message.projectId !== commentTarget.projectId
            || message.provider !== commentTarget.provider
            || message.sessionId !== commentTarget.sessionId
            || !state.pendingCommentRequest
            || message.requestId !== state.pendingCommentRequest.requestId
            || message.operation !== state.pendingCommentRequest.operation) {
            return false;
        }
        state.commentRevision = message.revision;
        state.comments = message.comments.map(function (comment) {
            return Object.assign({}, comment);
        });
        renderComments();
        var operation = state.pendingCommentRequest.operation;
        state.pendingCommentRequest = null;
        setCommentPending(false);
        if (message.success) {
            status.textContent = operation === 'sendComments'
                ? 'Comments sent to this session.'
                : 'Comments saved.';
        } else {
            status.textContent = commentErrorMessage(message.error);
        }
        return true;
    }

    function applyLocateResult(message) {
        if (!commentUiAvailable
            || !validLocateResult(message)
            || message.subscriptionGeneration !== state.subscriptionGeneration
            || message.projectId !== commentTarget.projectId
            || message.provider !== commentTarget.provider
            || message.sessionId !== commentTarget.sessionId
            || !state.pendingLocateRequest
            || message.requestId !== state.pendingLocateRequest.requestId
            || message.commentId !== state.pendingLocateRequest.commentId) {
            return false;
        }
        var comment = state.comments.find(function (candidate) {
            return candidate.id === message.commentId;
        });
        state.pendingLocateRequest = null;
        setCommentPending(false);
        if (message.success && comment && locateComment(comment)) {
            status.textContent = 'Comment source located.';
        } else {
            status.textContent = 'The commented message is no longer available.';
        }
        return true;
    }

    function selectionContext(range, markdown) {
        var before = document.createRange();
        before.selectNodeContents(markdown);
        before.setEnd(range.startContainer, range.startOffset);
        var after = document.createRange();
        after.selectNodeContents(markdown);
        after.setStart(range.endContainer, range.endOffset);
        return {
            prefix: before.toString().slice(-240),
            suffix: after.toString().slice(0, 240),
        };
    }

    function captureCommentSelection() {
        if (!commentUiAvailable || state.pendingCommentRequest) return;
        var selection = window.getSelection();
        if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
            addComment.hidden = true;
            state.selectedCommentText = null;
            return;
        }
        var range = selection.getRangeAt(0);
        var startElement = range.startContainer.nodeType === Node.ELEMENT_NODE
            ? range.startContainer
            : range.startContainer.parentElement;
        var endElement = range.endContainer.nodeType === Node.ELEMENT_NODE
            ? range.endContainer
            : range.endContainer.parentElement;
        var startMessage = startElement && startElement.closest
            ? startElement.closest(conversationMessageSelector())
            : null;
        var endMessage = endElement && endElement.closest
            ? endElement.closest(conversationMessageSelector())
            : null;
        var markdown = startElement && startElement.closest
            ? startElement.closest('.conversation-markdown')
            : null;
        var quote = selection.toString().trim();
        if (!startMessage || startMessage !== endMessage || !markdown
            || !messages.contains(startMessage) || !quote
            || Array.from(quote).length > 4000) {
            addComment.hidden = true;
            state.selectedCommentText = null;
            return;
        }
        var context = selectionContext(range, markdown);
        state.selectedCommentText = {
            messageId: conversationMessageId(startMessage),
            interactionId: startMessage.getAttribute('data-interaction-id'),
            quote: quote,
            prefix: context.prefix,
            suffix: context.suffix,
        };
        var rect = range.getBoundingClientRect();
        addComment.style.left = Math.max(
            8,
            Math.min(window.innerWidth - 120, rect.left)
        ) + 'px';
        addComment.style.top = Math.max(8, rect.bottom + 6) + 'px';
        addComment.hidden = false;
    }

    function openCommentComposer() {
        if (!state.selectedCommentText) return;
        setCommentsPanelOpen(true, true);
        addComment.hidden = true;
        commentSelection.textContent = state.selectedCommentText.quote;
        commentInput.value = '';
        commentComposer.hidden = false;
        commentInput.focus();
    }

    function closeCommentComposer() {
        commentComposer.hidden = true;
        commentInput.value = '';
        state.selectedCommentText = null;
        addComment.hidden = true;
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
            messages.querySelectorAll(conversationMessageSelector()),
            function (message) {
                return conversationMessageId(message);
            }
        );
    }

    function getMessageSignatures() {
        var signatures = new Map();
        Array.prototype.forEach.call(
            messages.querySelectorAll(conversationMessageSelector()),
            function (message) {
                signatures.set(
                    conversationMessageId(message),
                    message.innerHTML
                );
            }
        );
        return signatures;
    }

    function captureReadingAnchor() {
        var scrollBounds = scroll.getBoundingClientRect();
        var candidates = messages.querySelectorAll(
            conversationMessageSelector()
        );
        for (var index = 0; index < candidates.length; index += 1) {
            var bounds = candidates[index].getBoundingClientRect();
            if (bounds.bottom > scrollBounds.top) {
                return {
                    messageId: conversationMessageId(candidates[index]),
                    top: bounds.top - scrollBounds.top,
                };
            }
        }
        return null;
    }

    function restoreReadingPosition(anchor, fallbackScrollTop) {
        scroll.scrollTop = fallbackScrollTop;
        if (!anchor || !anchor.messageId) return;
        var candidate = Array.prototype.find.call(
            messages.querySelectorAll(conversationMessageSelector()),
            function (message) {
                return conversationMessageId(message) === anchor.messageId;
            }
        );
        if (!candidate) return;
        var scrollBounds = scroll.getBoundingClientRect();
        var currentTop = candidate.getBoundingClientRect().top
            - scrollBounds.top;
        scroll.scrollTop += currentTop - anchor.top;
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
        var readingAnchor = isLiveRefresh ? captureReadingAnchor() : null;
        var focusedMessage = document.activeElement
            && document.activeElement.closest
            ? document.activeElement.closest(conversationMessageSelector())
            : null;
        var focusedMessageId = focusedMessage
            ? conversationMessageId(focusedMessage)
            : null;
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
        updateCommentHighlights();
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
        if (isLiveRefresh && focusedMessageId) {
            var restoredFocus = Array.prototype.find.call(
                messages.querySelectorAll(conversationMessageSelector()),
                function (candidate) {
                    return conversationMessageId(candidate)
                        === focusedMessageId;
                }
            );
            if (restoredFocus) {
                restoredFocus.tabIndex = -1;
                restoredFocus.focus({ preventScroll: true });
            }
        }
        renderMermaidDiagrams(renderGeneration).then(function () {
            if (renderGeneration !== state.renderGeneration) return;
            if (isLiveRefresh) {
                restoreReadingPosition(readingAnchor, previousScrollTop);
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

        restoreReadingPosition(readingAnchor, previousScrollTop);
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
    if (commentUiAvailable) {
        commentsToggle.addEventListener('click', function () {
            setCommentsPanelOpen(!state.commentsPanelOpen, true);
        });
        var resizingPointerId = null;
        commentsResizer.addEventListener('pointerdown', function (event) {
            if (event.button !== 0) return;
            resizingPointerId = event.pointerId;
            commentsResizer.setPointerCapture(event.pointerId);
            event.preventDefault();
        });
        commentsResizer.addEventListener('pointermove', function (event) {
            if (event.pointerId !== resizingPointerId) return;
            var bounds = commentsWorkspace.getBoundingClientRect();
            setCommentsPanelWidth(bounds.right - event.clientX, false);
        });
        function finishCommentsResize(event) {
            if (event.pointerId !== resizingPointerId) return;
            resizingPointerId = null;
            saveCommentsPanelState();
        }
        commentsResizer.addEventListener('pointerup', finishCommentsResize);
        commentsResizer.addEventListener(
            'pointercancel',
            finishCommentsResize
        );
        commentsResizer.addEventListener('keydown', function (event) {
            var nextWidth;
            if (event.key === 'ArrowLeft') {
                nextWidth = state.commentsPanelWidth + 16;
            } else if (event.key === 'ArrowRight') {
                nextWidth = state.commentsPanelWidth - 16;
            } else if (event.key === 'Home') {
                nextWidth = commentsPanelMinWidth;
            } else if (event.key === 'End') {
                nextWidth = availableCommentsPanelMaxWidth();
            } else {
                return;
            }
            event.preventDefault();
            setCommentsPanelWidth(nextWidth, true);
        });
        window.addEventListener('resize', applyCommentsPanelLayout);
    }
    newResponse.addEventListener('click', function () {
        var target = Array.prototype.find.call(
            messages.querySelectorAll(conversationMessageSelector()),
            function (message) {
                return conversationMessageId(message)
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
    if (commentUiAvailable) {
        messages.addEventListener('mouseup', function () {
            window.setTimeout(captureCommentSelection, 0);
        });
        messages.addEventListener('keyup', function (event) {
            if (event.key === 'Shift'
                || event.key.startsWith('Arrow')
                || event.key === 'Home'
                || event.key === 'End') {
                window.setTimeout(captureCommentSelection, 0);
            }
        });
        scroll.addEventListener('scroll', function () {
            addComment.hidden = true;
        });
        addComment.addEventListener('click', openCommentComposer);
        commentsRoot.addEventListener('click', function (event) {
            var button = event.target && event.target.closest
                ? event.target.closest('[data-comment-action]')
                : null;
            if (!button || !commentsRoot.contains(button)
                || state.pendingCommentRequest
                || state.pendingLocateRequest) {
                return;
            }
            var action = button.getAttribute('data-comment-action');
            if (action === 'cancel-add') {
                closeCommentComposer();
                return;
            }
            if (action === 'confirm-add') {
                var text = commentInput.value.trim();
                if (!state.selectedCommentText || !text) {
                    status.textContent = 'Enter a comment before adding it.';
                    commentInput.focus();
                    return;
                }
                var payload = Object.assign(
                    {},
                    state.selectedCommentText,
                    { comment: text }
                );
                closeCommentComposer();
                postCommentOperation('add', payload);
                return;
            }
            if (action === 'send') {
                postCommentOperation('sendComments', {});
                return;
            }
            var item = button.closest('[data-comment-id]');
            var commentId = item && item.getAttribute('data-comment-id');
            var comment = state.comments.find(function (candidate) {
                return candidate.id === commentId;
            });
            if (!item || !comment) return;
            if (action === 'locate') {
                requestCommentLocation(comment);
                return;
            }
            if (action === 'delete') {
                postCommentOperation('delete', { commentId: comment.id });
                return;
            }
            if (action === 'resolve' || action === 'reopen') {
                postCommentOperation(action, { commentId: comment.id });
                return;
            }
            if (action === 'update') {
                var edit = item.querySelector('[data-comment-edit]');
                var updated = edit ? edit.value.trim() : '';
                if (!updated) {
                    status.textContent = 'A comment cannot be empty.';
                    if (edit) edit.focus();
                    return;
                }
                postCommentOperation('update', {
                    commentId: comment.id,
                    comment: updated,
                });
            }
        });
    }
    document.addEventListener('keydown', function (event) {
        if (commentUiAvailable
            && event.key === 'Enter'
            && (event.ctrlKey || event.metaKey)
            && !event.altKey) {
            var target = event.target;
            if (target === commentInput && !commentComposer.hidden) {
                event.preventDefault();
                commentComposer.querySelector(
                    '[data-comment-action="confirm-add"]'
                )?.click();
                return;
            }
            if (target && target.matches?.('[data-comment-edit]')) {
                var item = target.closest('[data-comment-id]');
                var save = item?.querySelector(
                    '[data-comment-action="update"]'
                );
                if (save) {
                    event.preventDefault();
                    save.click();
                    return;
                }
            }
        }
        if (event.key !== 'Escape') return;
        if (commentUiAvailable && !commentComposer.hidden) {
            event.preventDefault();
            closeCommentComposer();
            return;
        }
        event.preventDefault();
        postNavigation('conversation-viewer-closed');
    });
    window.addEventListener('message', function (event) {
        if (applyCommentsResult(event.data)) return;
        if (applyLocateResult(event.data)) return;
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
    if (commentUiAvailable) {
        var savedCommentsPanel = readCommentsPanelState();
        if (savedCommentsPanel) {
            if (typeof savedCommentsPanel.open === 'boolean') {
                state.commentsPanelOpen = savedCommentsPanel.open;
            }
            if (Number.isFinite(savedCommentsPanel.width)) {
                state.commentsPanelWidth = Math.round(
                    savedCommentsPanel.width
                );
            }
        }
        applyCommentsPanelLayout();
        var initialComments = readJsonAttribute('data-initial-comments');
        if (validInitialComments(initialComments)) {
            state.commentRevision = initialComments.revision;
            state.comments = initialComments.comments.map(function (comment) {
                return Object.assign({}, comment);
            });
            renderComments();
        } else {
            status.textContent = 'Comment drafts are unavailable.';
        }
    }
}());
