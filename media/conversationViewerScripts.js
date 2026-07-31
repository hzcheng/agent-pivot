(function () {
    'use strict';

    var allowedTags = [
        'p', 'br', 'pre', 'code', 'blockquote', 'ul', 'ol', 'li',
        'strong', 'em', 'del', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'a', 'img', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
        'span', 'section', 'article',
    ];
    var allowedAttributes = [
        'href', 'src', 'alt', 'title', 'class', 'start',
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
    var telemetryRoot = document.querySelector('[data-conversation-telemetry]');
    var telemetryModel = document.querySelector('[data-telemetry-model]');
    var telemetryModelValue = document.querySelector(
        '[data-telemetry-model-value]'
    );
    var telemetryContext = document.querySelector('[data-telemetry-context]');
    var telemetryContextProgress = document.querySelector(
        '[data-telemetry-context-progress]'
    );
    var telemetryContextValue = document.querySelector(
        '[data-telemetry-context-value]'
    );
    var telemetryLimits = document.querySelector('[data-telemetry-limits]');
    var newResponse = document.querySelector('[data-new-response]');
    var previous = document.querySelector('[data-action="previous"]');
    var next = document.querySelector('[data-action="next"]');
    var latest = document.querySelector('[data-action="latest"]');
    var close = document.querySelector('[data-action="close"]');
    var outlineToggle = document.querySelector(
        '[data-action="toggle-outline"]'
    );
    var commentsToggle = document.querySelector(
        '[data-action="toggle-comments"]'
    );
    var commentsWorkspace = document.querySelector('.conversation-workspace');
    var commentsResizer = document.querySelector('[data-comments-resizer]');
    var sidebarRoot = document.querySelector('[data-conversation-sidebar]');
    var sidebarTabs = Array.prototype.slice.call(
        document.querySelectorAll('[data-sidebar-tab]')
    );
    var sidebarClose = document.querySelector('[data-sidebar-close]');
    var outlineRoot = document.querySelector('[data-conversation-outline]');
    var outlineCount = document.querySelector('[data-outline-count]');
    var outlineSummary = document.querySelector('[data-outline-summary]');
    var outlineSearch = document.querySelector('[data-outline-search]');
    var outlineList = document.querySelector('[data-outline-list]');
    var outlineEmpty = document.querySelector('[data-outline-empty]');
    var outlinePartial = document.querySelector('[data-outline-partial]');
    var outlineBookmarksOnly = document.querySelector(
        '[data-outline-bookmarks-only]'
    );
    var commentsRoot = document.querySelector('[data-conversation-comments]');
    var commentCount = document.querySelector('[data-comment-count]');
    var commentSummary = document.querySelector('[data-comment-summary]');
    var commentComposer = document.querySelector('[data-comment-composer]');
    var commentSelection = document.querySelector('[data-comment-selection]');
    var commentInput = document.querySelector('[data-comment-input]');
    var commentList = document.querySelector('[data-comment-list]');
    var commentEmpty = document.querySelector('[data-comment-empty]');
    var commentNew = document.querySelector('[data-comment-action="new"]');
    var commentSend = document.querySelector('[data-comment-action="send"]');
    var commentClearSent = document.querySelector(
        '[data-comment-action="clearSent"]'
    );
    var commentClearResolved = document.querySelector(
        '[data-comment-action="clearResolved"]'
    );
    var commentClearAll = document.querySelector(
        '[data-comment-action="clearAll"]'
    );
    var addComment = document.querySelector('[data-add-comment]');
    var commentTarget = readJsonAttribute('data-conversation-target');
    var sidebarUiAvailable = !!outlineToggle && !!commentsToggle
        && !!commentsWorkspace && !!commentsResizer && !!sidebarRoot
        && sidebarTabs.length === 2 && !!sidebarClose && !!outlineRoot
        && !!outlineCount && !!outlineSummary && !!outlineSearch
        && !!outlineList && !!outlineEmpty && !!outlinePartial
        && !!outlineBookmarksOnly;
    var bookmarkUiAvailable = sidebarUiAvailable
        && validCommentTarget(commentTarget);
    var commentUiAvailable = sidebarUiAvailable
        && !!commentsRoot && !!commentCount
        && !!commentSummary
        && !!commentComposer && !!commentSelection && !!commentInput
        && !!commentList && !!commentEmpty && !!commentNew
        && !!commentSend && !!addComment
        && !!commentClearSent && !!commentClearResolved && !!commentClearAll
        && validCommentTarget(commentTarget);
    var state = {
        atLatest: false,
        followingEnd: false,
        initialized: false,
        latestRequestId: 0,
        latestTelemetryRequestId: 0,
        subscriptionGeneration: Number(document.body.getAttribute(
            'data-subscription-generation'
        )),
        messageIds: [],
        messageSignatures: new Map(),
        firstNewMessageId: null,
        renderGeneration: 0,
        comments: [],
        commentRevision: 0,
        commentRequestSequence: 0,
        pendingCommentRequest: null,
        pendingLocateRequest: null,
        clearAllConfirmation: false,
        selectedCommentText: null,
        commentsPanelOpen: true,
        commentsPanelWidth: 240,
        sidebarView: 'outline',
        outline: [],
        outlineSelectedInteractionId: '',
        outlineSelectedInput: 0,
        outlineTotalInputs: 0,
        outlinePartial: false,
        outlineQuery: '',
        bookmarkIds: new Set(),
        bookmarkRevision: 0,
        bookmarkRequestSequence: 0,
        pendingBookmarkRequest: null,
        bookmarksOnly: false,
    };
    var readingAnchorController =
        window.__agentPivotConversationReadingAnchor.create({
            scroll: scroll,
            messages: messages,
            messageSelector: conversationMessageSelector,
            messageId: conversationMessageId,
        });
    var captureReadingAnchor = readingAnchorController.capture;
    var restoreReadingPosition = readingAnchorController.restore;
    var restoreViewportReadingPosition =
        readingAnchorController.restoreViewport;
    var mermaidRenderer = window.__agentPivotConversationMermaid.create({
        source: mermaidSource,
        nonce: scriptNonce,
        messages: messages,
        scroll: scroll,
        maxDiagrams: maxMermaidDiagrams,
        captureAnchor: captureReadingAnchor,
        restoreAnchor: restoreReadingPosition,
    });
    var releaseMermaidObjectUrls = mermaidRenderer.release;
    var renderMermaidDiagrams = mermaidRenderer.render;
    var preserveMermaidContent = mermaidRenderer.preserve;

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
            var panelState = saved && saved.conversationSidebar;
            if (!panelState && saved && saved.conversationCommentsPanel) {
                panelState = Object.assign(
                    { view: 'comments' },
                    saved.conversationCommentsPanel
                );
            }
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
            next.conversationSidebar = {
                open: state.commentsPanelOpen,
                width: state.commentsPanelWidth,
                view: state.sidebarView,
                query: state.outlineQuery,
            };
            delete next.conversationCommentsPanel;
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
        if (!sidebarUiAvailable) return;
        outlineToggle.textContent = 'Outline (' + state.outline.length + ')';
        outlineToggle.setAttribute(
            'aria-expanded',
            state.commentsPanelOpen && state.sidebarView === 'outline'
                ? 'true'
                : 'false'
        );
        commentsToggle.textContent = 'Comments (' + openCommentCount()
            + ' open)';
        commentsToggle.setAttribute(
            'aria-expanded',
            state.commentsPanelOpen && state.sidebarView === 'comments'
                ? 'true'
                : 'false'
        );
        outlineToggle.setAttribute('aria-label',
            state.commentsPanelOpen && state.sidebarView === 'outline'
                ? 'Hide conversation outline'
                : 'Show conversation outline');
        commentsToggle.setAttribute('aria-label',
            state.commentsPanelOpen && state.sidebarView === 'comments'
                ? 'Hide comments panel'
                : 'Show comments panel');
        sidebarTabs.forEach(function (tab) {
            var selected = tab.getAttribute('data-sidebar-tab')
                === state.sidebarView;
            tab.setAttribute('aria-selected', selected ? 'true' : 'false');
            tab.tabIndex = selected ? 0 : -1;
        });
    }

    function applyCommentsPanelLayout() {
        if (!sidebarUiAvailable) return;
        var width = clampCommentsPanelWidth(state.commentsPanelWidth);
        commentsWorkspace.style.setProperty(
            '--conversation-comments-width',
            width + 'px'
        );
        commentsWorkspace.setAttribute(
            'data-comments-open',
            state.commentsPanelOpen ? 'true' : 'false'
        );
        sidebarRoot.hidden = !state.commentsPanelOpen;
        commentsResizer.hidden = !state.commentsPanelOpen;
        outlineRoot.hidden = state.sidebarView !== 'outline';
        commentsRoot.hidden = state.sidebarView !== 'comments';
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

    function setSidebarView(view, open, persist) {
        if (view !== 'outline' && view !== 'comments') return;
        state.sidebarView = view;
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

    function codeIndentColumns(whitespace) {
        var columns = 0;
        for (var index = 0; index < whitespace.length; index += 1) {
            if (whitespace[index] === '\t') {
                columns += 4 - (columns % 4);
            } else {
                columns += 1;
            }
        }
        return columns;
    }

    function enhanceCodeBlockIndentation() {
        Array.prototype.forEach.call(
            messages.querySelectorAll(
                'pre > code:not(.language-mermaid)'
            ),
            function (code) {
                if (code.hasAttribute('data-conversation-code-guides')) {
                    return;
                }
                code.setAttribute('data-conversation-code-guides', 'true');
                var source = code.textContent || '';
                var lines = source.split('\n');
                var indentation = lines.map(function (line) {
                    var match = line.match(/^[\t ]+/);
                    return match ? codeIndentColumns(match[0]) : 0;
                }).filter(function (columns) {
                    return columns > 0;
                });
                if (!indentation.length) return;
                var indentStep = indentation.reduce(
                    function (smallest, columns) {
                        return Math.min(smallest, columns);
                    },
                    indentation[0]
                );
                var fragment = document.createDocumentFragment();
                lines.forEach(function (line, index) {
                    if (index > 0) {
                        fragment.appendChild(document.createTextNode('\n'));
                    }
                    var match = line.match(/^[\t ]+/);
                    if (!match) {
                        fragment.appendChild(document.createTextNode(line));
                        return;
                    }
                    var indent = document.createElement('span');
                    indent.className = 'conversation-code-indent';
                    indent.style.setProperty(
                        '--conversation-code-indent-step',
                        (indentStep * 2) + 'ch'
                    );
                    indent.style.setProperty(
                        '--conversation-code-indent-offset',
                        codeIndentColumns(match[0]) + 'ch'
                    );
                    indent.textContent = match[0];
                    fragment.appendChild(indent);
                    fragment.appendChild(document.createTextNode(
                        line.slice(match[0].length)
                    ));
                });
                code.replaceChildren(fragment);
            }
        );
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
        var actualKeys = Object.keys(value);
        var hasSessionScope = value.scope === 'session';
        return actualKeys.length === keys.length + (hasSessionScope ? 1 : 0)
            && keys.every(function (key) {
                return Object.prototype.hasOwnProperty.call(value, key);
            })
            && (value.scope === undefined || hasSessionScope)
            && typeof value.id === 'string'
            && typeof value.messageId === 'string'
            && typeof value.interactionId === 'string'
            && (value.role === 'user' || value.role === 'assistant')
            && typeof value.quote === 'string'
            && typeof value.prefix === 'string'
            && typeof value.suffix === 'string'
            && typeof value.comment === 'string'
            && (!hasSessionScope
                || (value.messageId === ''
                    && value.interactionId === ''
                    && value.role === 'user'
                    && value.quote === ''
                    && value.prefix === ''
                    && value.suffix === ''))
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
                || value.operation === 'clearSent'
                || value.operation === 'clearResolved'
                || value.operation === 'clearAll'
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

    function commentStatusCounts() {
        return state.comments.reduce(function (counts, comment) {
            counts[comment.status] += 1;
            return counts;
        }, { open: 0, sent: 0, resolved: 0 });
    }

    function resetClearAllConfirmation() {
        if (!commentUiAvailable) return;
        state.clearAllConfirmation = false;
        commentClearAll.textContent = 'Clear all';
        commentClearAll.removeAttribute('data-confirming');
        commentClearAll.setAttribute('aria-label', 'Clear all comments');
    }

    function updateCommentControls() {
        if (!commentUiAvailable) return;
        var counts = commentStatusCounts();
        var pending = !!state.pendingCommentRequest
            || !!state.pendingLocateRequest;
        var summary = [];
        if (counts.open) summary.push(counts.open + ' open');
        if (counts.sent) summary.push(counts.sent + ' added');
        if (counts.resolved) summary.push(counts.resolved + ' resolved');
        commentSummary.textContent = summary.length
            ? summary.join(' · ')
            : 'No comments yet';
        commentCount.textContent = String(state.comments.length);
        commentCount.setAttribute(
            'aria-label',
            state.comments.length + ' comment'
                + (state.comments.length === 1 ? '' : 's')
        );
        commentSend.disabled = counts.open === 0 || pending;
        commentNew.disabled = pending;
        commentClearSent.disabled = counts.sent === 0 || pending;
        commentClearResolved.disabled = counts.resolved === 0 || pending;
        commentClearAll.disabled = state.comments.length === 0 || pending;
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
        if (error === 'limit') return 'A maximum of 20 comments can be added at once.';
        if (error === 'tooLarge') return 'The combined comments are too large to send.';
        if (error === 'busy') return 'Wait for the current AI response to finish, then send again.';
        if (error === 'conflict') return 'Multiple runtimes match this session. Resolve the conflict first.';
        if (error === 'unavailable') return 'This session is unavailable and the comments were not added.';
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
            updateCommentControls();
        }
        commentsRoot.setAttribute('aria-busy', pending ? 'true' : 'false');
    }

    function postCommentOperation(operation, payload) {
        if (!commentUiAvailable
            || state.pendingCommentRequest
            || state.pendingLocateRequest) return;
        var requestId = nextCommentRequestId();
        resetClearAllConfirmation();
        state.pendingCommentRequest = { requestId: requestId, operation: operation };
        setCommentPending(true);
        status.textContent = operation === 'sendComments'
            ? 'Adding comments to session input…'
            : operation === 'clearSent'
                || operation === 'clearResolved'
                || operation === 'clearAll'
                ? 'Clearing comments…'
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
        if (comment.scope === 'session') return false;
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
        resetClearAllConfirmation();
        commentList.replaceChildren();
        state.comments.forEach(function (comment, index) {
            var item = document.createElement('article');
            item.className = 'conversation-comment';
            item.setAttribute('data-comment-id', comment.id);
            item.setAttribute('data-comment-status', comment.status);
            item.setAttribute(
                'data-comment-scope',
                comment.scope === 'session' ? 'session' : 'selection'
            );

            var heading = document.createElement('div');
            heading.className = 'conversation-comment-heading';
            var identity = document.createElement('div');
            identity.className = 'conversation-comment-identity';
            var label = document.createElement('strong');
            label.textContent = 'Comment ' + (index + 1);
            if (comment.scope === 'session') {
                var scope = document.createElement('span');
                scope.className = 'conversation-comment-scope';
                scope.textContent = 'Session note';
                identity.append(label, scope);
            } else {
                identity.appendChild(label);
            }
            var statusLabel = document.createElement('span');
            statusLabel.className = 'conversation-comment-status';
            statusLabel.setAttribute('data-comment-status-label', '');
            statusLabel.textContent = comment.status === 'open'
                ? 'Open'
                : comment.status === 'sent' ? 'Added' : 'Resolved';
            identity.appendChild(statusLabel);
            heading.appendChild(identity);
            if (comment.scope !== 'session') {
                var locate = document.createElement('button');
                locate.type = 'button';
                locate.className = 'conversation-comment-locate';
                locate.setAttribute('data-comment-action', 'locate');
                locate.textContent = 'Show text';
                heading.appendChild(locate);
            }

            var quoteGroup = document.createElement('div');
            quoteGroup.className = 'conversation-comment-quote';
            var quoteLabel = document.createElement('span');
            quoteLabel.className = 'conversation-comment-quote-label';
            quoteLabel.textContent = 'Selected text';
            var quote = document.createElement('blockquote');
            quote.textContent = comment.quote;
            quoteGroup.append(quoteLabel, quote);
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
            remove.className = 'conversation-comment-delete';
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
            item.appendChild(heading);
            if (comment.scope !== 'session') {
                item.appendChild(quoteGroup);
            }
            item.append(input, actions);
            commentList.appendChild(item);
        });
        updateCommentsToggle();
        commentEmpty.hidden = state.comments.length > 0;
        var openCount = openCommentCount();
        commentSend.textContent = 'Send ' + openCount + ' open comment'
            + (openCount === 1 ? '' : 's') + ' to this session';
        updateCommentControls();
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
            if (comment.status === 'resolved'
                || comment.scope === 'session') return;
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
                ? 'Comments added to session input. Review and press Enter to send.'
                : operation === 'clearSent'
                    ? 'Added comments cleared.'
                    : operation === 'clearResolved'
                        ? 'Resolved comments cleared.'
                        : operation === 'clearAll'
                            ? 'All comments cleared.'
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
        setSidebarView('comments', true, true);
        addComment.hidden = true;
        commentSelection.textContent = state.selectedCommentText.quote;
        commentComposer.setAttribute('data-comment-composer-scope', 'selection');
        commentInput.value = '';
        commentComposer.hidden = false;
        commentInput.focus();
    }

    function openSessionCommentComposer() {
        if (!commentUiAvailable
            || state.pendingCommentRequest
            || state.pendingLocateRequest) return;
        setSidebarView('comments', true, true);
        addComment.hidden = true;
        state.selectedCommentText = { scope: 'session' };
        commentSelection.textContent = 'Session note';
        commentComposer.setAttribute('data-comment-composer-scope', 'session');
        commentInput.value = '';
        commentComposer.hidden = false;
        commentInput.focus();
    }

    function closeCommentComposer() {
        commentComposer.hidden = true;
        commentComposer.removeAttribute('data-comment-composer-scope');
        commentInput.value = '';
        state.selectedCommentText = null;
        addComment.hidden = true;
    }

    function validOutlineEntry(entry) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return false;
        }
        var keys = Object.keys(entry);
        return keys.length === 3
            && keys.includes('interactionId')
            && keys.includes('userPreview')
            && keys.includes('responseState')
            && typeof entry.interactionId === 'string'
            && entry.interactionId.length > 0
            && entry.interactionId.length <= 512
            && !/[\u0000-\u001f\u007f]/.test(entry.interactionId)
            && typeof entry.userPreview === 'string'
            && entry.userPreview.length <= 4096
            && ['complete', 'inProgress', 'interrupted', 'unknown']
                .includes(entry.responseState);
    }

    function validBookmarkSnapshot(value) {
        return value && typeof value === 'object' && !Array.isArray(value)
            && Object.keys(value).length === 2
            && Number.isSafeInteger(value.revision)
            && value.revision >= 0
            && Array.isArray(value.interactionIds)
            && value.interactionIds.length <= 2000
            && value.interactionIds.every(function (id) {
                return typeof id === 'string'
                    && id.length > 0
                    && id.length <= 512
                    && !/[\u0000-\u001f\u007f]/.test(id);
            })
            && new Set(value.interactionIds).size
                === value.interactionIds.length;
    }

    function validBookmarksResult(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return false;
        }
        var required = [
            'type', 'version', 'requestId', 'subscriptionGeneration',
            'projectId', 'provider', 'sessionId', 'operation', 'success',
            'revision', 'interactionIds',
        ];
        var allowed = new Set(required.concat(['error']));
        return Object.keys(value).every(function (key) {
            return allowed.has(key);
        }) && required.every(function (key) {
            return Object.prototype.hasOwnProperty.call(value, key);
        })
            && value.type === 'conversation-viewer-bookmarks-result'
            && value.version === 1
            && typeof value.requestId === 'string'
            && Number.isSafeInteger(value.subscriptionGeneration)
            && typeof value.projectId === 'string'
            && ['codex', 'kimi', 'claude'].includes(value.provider)
            && typeof value.sessionId === 'string'
            && value.operation === 'set'
            && typeof value.success === 'boolean'
            && validBookmarkSnapshot({
                revision: value.revision,
                interactionIds: value.interactionIds,
            })
            && (value.error === undefined
                || ['invalid', 'stale', 'failed', 'limit']
                    .includes(value.error));
    }

    function nextBookmarkRequestId() {
        state.bookmarkRequestSequence += 1;
        return [
            'conversation-bookmark',
            Date.now().toString(36),
            state.bookmarkRequestSequence.toString(36),
        ].join(':');
    }

    function postBookmarkMutation(interactionId, bookmarked) {
        if (!bookmarkUiAvailable
            || state.pendingBookmarkRequest) return;
        var requestId = nextBookmarkRequestId();
        state.pendingBookmarkRequest = { requestId: requestId, interactionId: interactionId };
        renderBookmarkState();
        post({
            type: 'conversation-viewer-bookmark-mutation',
            version: 1,
            requestId: requestId,
            subscriptionGeneration: state.subscriptionGeneration,
            projectId: commentTarget.projectId,
            provider: commentTarget.provider,
            sessionId: commentTarget.sessionId,
            operation: 'set',
            expectedRevision: state.bookmarkRevision,
            payload: {
                interactionId: interactionId,
                bookmarked: bookmarked,
            },
        });
    }

    function applyBookmarksResult(message) {
        if (!bookmarkUiAvailable
            || !validBookmarksResult(message)
            || !state.pendingBookmarkRequest
            || message.requestId !== state.pendingBookmarkRequest.requestId
            || message.subscriptionGeneration !== state.subscriptionGeneration
            || message.projectId !== commentTarget.projectId
            || message.provider !== commentTarget.provider
            || message.sessionId !== commentTarget.sessionId) {
            return false;
        }
        var focusedId = state.pendingBookmarkRequest.interactionId;
        state.pendingBookmarkRequest = null;
        state.bookmarkRevision = message.revision;
        state.bookmarkIds = new Set(message.interactionIds);
        renderBookmarkState();
        filterOutline();
        status.textContent = message.success
            ? (state.bookmarkIds.has(focusedId)
                ? 'Input bookmarked.'
                : 'Bookmark removed.')
            : 'Bookmark could not be updated.';
        var focused = outlineList.querySelector(
            '[data-outline-bookmark-id="' + CSS.escape(focusedId) + '"]'
        );
        if (focused) focused.focus();
        return true;
    }

    function renderBookmarkState() {
        if (!sidebarUiAvailable) return;
        Array.prototype.forEach.call(
            outlineList.querySelectorAll('[data-outline-bookmark-id]'),
            function (button) {
                var interactionId = button.getAttribute(
                    'data-outline-bookmark-id'
                );
                var bookmarked = state.bookmarkIds.has(interactionId);
                var entry = state.outline.find(function (candidate) {
                    return candidate.interactionId === interactionId;
                });
                var inputNumber = entry ? entry.inputNumber : '';
                button.textContent = bookmarked ? '★' : '☆';
                button.classList.toggle('is-bookmarked', bookmarked);
                button.setAttribute('aria-pressed',
                    bookmarked ? 'true' : 'false');
                button.setAttribute(
                    'aria-label',
                    (bookmarked ? 'Remove bookmark from input ' : 'Bookmark input ')
                        + inputNumber
                );
                button.title = button.getAttribute('aria-label');
                button.disabled = !!state.pendingBookmarkRequest;
            }
        );
        var count = state.bookmarkIds.size;
        outlineBookmarksOnly.textContent = (state.bookmarksOnly ? '★' : '☆')
            + ' Bookmarks (' + count + ')';
        outlineBookmarksOnly.setAttribute(
            'aria-pressed',
            state.bookmarksOnly ? 'true' : 'false'
        );
    }

    function validOutline(value, selectedInteractionId) {
        if (!Array.isArray(value)
            || value.length < 1
            || value.length > 2000
            || !value.every(validOutlineEntry)) {
            return false;
        }
        var identities = new Set(value.map(function (entry) {
            return entry.interactionId;
        }));
        return identities.size === value.length
            && identities.has(selectedInteractionId);
    }

    function outlineChanged(entries) {
        return entries.length !== state.outline.length
            || entries.some(function (entry, index) {
                var current = state.outline[index];
                return !current
                    || current.interactionId !== entry.interactionId
                    || current.userPreview !== entry.userPreview
                    || current.responseState !== entry.responseState;
            });
    }

    function responseStateLabel(value) {
        if (value === 'inProgress') return 'Response in progress';
        if (value === 'interrupted') return 'Response interrupted';
        if (value === 'unknown') return 'Response state unknown';
        return 'Response complete';
    }

    function buildOutlineList() {
        var fragment = document.createDocumentFragment();
        state.outline.forEach(function (entry) {
            var item = document.createElement('li');
            item.className = 'conversation-outline-item';
            var bookmark = document.createElement('button');
            bookmark.type = 'button';
            bookmark.className = 'conversation-outline-bookmark';
            bookmark.setAttribute(
                'data-outline-bookmark-id',
                entry.interactionId
            );
            var button = document.createElement('button');
            button.type = 'button';
            button.setAttribute('data-outline-interaction-id',
                entry.interactionId);
            button.setAttribute('data-outline-filter-text',
                entry.userPreview.toLocaleLowerCase());
            button.tabIndex = -1;

            var number = document.createElement('span');
            number.className = 'conversation-outline-number';
            number.textContent = String(entry.inputNumber);
            var preview = document.createElement('span');
            preview.className = 'conversation-outline-preview';
            preview.textContent = entry.userPreview || '(empty input)';
            var responseState = document.createElement('span');
            responseState.className = 'conversation-outline-state'
                + ' conversation-outline-state-' + entry.responseState;
            responseState.title = responseStateLabel(entry.responseState);
            responseState.setAttribute(
                'aria-label',
                responseStateLabel(entry.responseState)
            );

            button.appendChild(number);
            button.appendChild(preview);
            button.appendChild(responseState);
            item.appendChild(bookmark);
            item.appendChild(button);
            fragment.appendChild(item);
        });
        outlineList.replaceChildren(fragment);
        renderBookmarkState();
    }

    function visibleOutlineButtons() {
        return Array.prototype.filter.call(
            outlineList.querySelectorAll('[data-outline-interaction-id]'),
            function (button) {
                return !button.closest('li').hidden;
            }
        );
    }

    function updateOutlineSelection(scrollSelected) {
        var selected;
        Array.prototype.forEach.call(
            outlineList.querySelectorAll('[data-outline-interaction-id]'),
            function (button) {
                var current = button.getAttribute(
                    'data-outline-interaction-id'
                ) === state.outlineSelectedInteractionId;
                button.classList.toggle('is-selected', current);
                if (current) {
                    button.setAttribute('aria-current', 'location');
                    selected = button;
                } else {
                    button.removeAttribute('aria-current');
                }
                button.tabIndex = current ? 0 : -1;
            }
        );
        var visible = visibleOutlineButtons();
        if (!visible.some(function (button) {
            return button.tabIndex === 0;
        }) && visible[0]) {
            visible[0].tabIndex = 0;
        }
        if (scrollSelected
            && selected
            && state.commentsPanelOpen
            && state.sidebarView === 'outline'
            && !selected.closest('li').hidden) {
            selected.scrollIntoView({ block: 'nearest' });
        }
    }

    function filterOutline() {
        var query = state.outlineQuery.trim().toLocaleLowerCase();
        var visibleCount = 0;
        Array.prototype.forEach.call(
            outlineList.querySelectorAll('.conversation-outline-item'),
            function (item) {
                var button = item.querySelector(
                    '[data-outline-interaction-id]'
                );
                var visible = !query
                    || (button.getAttribute('data-outline-filter-text') || '')
                        .includes(query);
                if (visible && state.bookmarksOnly) {
                    visible = state.bookmarkIds.has(button.getAttribute(
                        'data-outline-interaction-id'
                    ));
                }
                item.hidden = !visible;
                if (visible) visibleCount += 1;
            }
        );
        outlineEmpty.hidden = visibleCount > 0;
        outlineEmpty.textContent = state.bookmarksOnly
            ? 'No bookmarked inputs match this view.'
            : 'No inputs match this search.';
        updateOutlineSelection(false);
    }

    function applyOutline(message) {
        if (!sidebarUiAvailable) return;
        var selectedIndex = message.outline.findIndex(function (entry) {
            return entry.interactionId === message.selectedInteractionId;
        });
        var offset = Math.max(
            0,
            message.selectedInput - selectedIndex - 1
        );
        var nextOutline = message.outline.map(function (entry, index) {
            return Object.assign({}, entry, {
                inputNumber: offset + index + 1,
            });
        });
        var changed = outlineChanged(nextOutline);
        state.outline = nextOutline;
        state.outlineSelectedInteractionId = message.selectedInteractionId;
        state.outlineSelectedInput = message.selectedInput;
        state.outlineTotalInputs = message.totalInputs;
        state.outlinePartial = message.partial;
        if (changed) buildOutlineList();
        outlineCount.textContent = String(message.outline.length);
        outlineCount.setAttribute(
            'aria-label',
            message.outline.length + ' inputs'
        );
        outlineSummary.textContent = message.partial
            ? message.outline.length.toLocaleString() + '+ latest inputs'
            : message.outline.length.toLocaleString() + ' inputs';
        outlinePartial.hidden = !message.partial;
        filterOutline();
        renderBookmarkState();
        updateOutlineSelection(changed || message.updateKind !== 'refresh');
        updateCommentsToggle();
    }

    function validPage(message) {
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
            return false;
        }
        var requiredKeys = [
            'type', 'version', 'requestId', 'subscriptionGeneration',
            'updateKind', 'html', 'outline', 'selectedInteractionId', 'selectedInput',
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
            && validOutline(message.outline, message.selectedInteractionId)
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

    function exactKeys(value, required, optional) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return false;
        }
        var keys = Object.keys(value);
        var allowed = new Set(required.concat(optional || []));
        return required.every(function (key) {
            return Object.prototype.hasOwnProperty.call(value, key);
        }) && keys.every(function (key) {
            return allowed.has(key);
        });
    }

    function validTelemetry(value) {
        if (!exactKeys(
            value,
            ['provider', 'sessionId', 'rateLimits'],
            ['model', 'context']
        )) return false;
        if (!['codex', 'kimi', 'claude'].includes(value.provider)
            || typeof value.sessionId !== 'string'
            || !value.sessionId
            || value.sessionId.length > 256
            || (value.model !== undefined
                && (typeof value.model !== 'string'
                    || !value.model
                    || value.model.length > 128))
            || !Array.isArray(value.rateLimits)
            || value.rateLimits.length > 4) {
            return false;
        }
        if (value.context !== undefined
            && (!exactKeys(value.context, ['usedTokens', 'maxTokens'])
                || !Number.isSafeInteger(value.context.usedTokens)
                || value.context.usedTokens < 0
                || !Number.isSafeInteger(value.context.maxTokens)
                || value.context.maxTokens <= 0)) {
            return false;
        }
        return value.rateLimits.every(function (limit) {
            return exactKeys(
                limit,
                ['id', 'label', 'usedPercent'],
                ['windowDurationMins', 'resetsAt']
            )
                && typeof limit.id === 'string'
                && limit.id.length > 0
                && limit.id.length <= 256
                && typeof limit.label === 'string'
                && limit.label.length > 0
                && limit.label.length <= 64
                && Number.isFinite(limit.usedPercent)
                && limit.usedPercent >= 0
                && limit.usedPercent <= 100
                && (limit.windowDurationMins === undefined
                    || (Number.isSafeInteger(limit.windowDurationMins)
                        && limit.windowDurationMins > 0))
                && (limit.resetsAt === undefined
                    || (Number.isSafeInteger(limit.resetsAt)
                        && limit.resetsAt > 0));
        });
    }

    function compactTokens(value) {
        if (value >= 1000000) {
            return (value / 1000000).toFixed(value >= 10000000 ? 0 : 1) + 'm';
        }
        if (value >= 1000) {
            return (value / 1000).toFixed(value >= 100000 ? 0 : 1) + 'k';
        }
        return String(value);
    }

    function compactResetTime(resetsAt) {
        var remainingMinutes = Math.max(
            1,
            Math.ceil((resetsAt * 1000 - Date.now()) / 60000)
        );
        if (remainingMinutes < 60) return remainingMinutes + 'm';
        var remainingHours = Math.ceil(remainingMinutes / 60);
        if (remainingHours < 48) return remainingHours + 'h';
        return Math.ceil(remainingHours / 24) + 'd';
    }

    function applyTelemetry(message) {
        if (!exactKeys(
            message,
            ['type', 'version', 'requestId', 'subscriptionGeneration', 'telemetry']
        )
            || message.type !== 'conversation-viewer-telemetry'
            || message.version !== 1
            || !Number.isSafeInteger(message.requestId)
            || message.requestId < state.latestRequestId
            || message.requestId < state.latestTelemetryRequestId
            || message.subscriptionGeneration !== state.subscriptionGeneration
            || (message.telemetry !== null
                && !validTelemetry(message.telemetry))
            || (message.telemetry !== null
                && (!commentTarget
                    || message.telemetry.provider !== commentTarget.provider
                    || message.telemetry.sessionId !== commentTarget.sessionId))
            || !telemetryRoot || !telemetryModel || !telemetryModelValue
            || !telemetryContext || !telemetryContextProgress
            || !telemetryContextValue || !telemetryLimits) {
            return false;
        }
        state.latestTelemetryRequestId = message.requestId;
        var readingAnchor = captureReadingAnchor();
        var previousScrollTop = scroll.scrollTop;
        var telemetry = message.telemetry;
        if (!telemetry) {
            telemetryRoot.hidden = true;
            restoreViewportReadingPosition(
                readingAnchor,
                previousScrollTop
            );
            return true;
        }
        telemetryModel.hidden = !telemetry.model;
        telemetryModelValue.textContent = telemetry.model || '';
        telemetryContext.hidden = !telemetry.context;
        if (telemetry.context) {
            var percent = Math.max(0, Math.min(
                100,
                telemetry.context.usedTokens
                    / telemetry.context.maxTokens * 100
            ));
            telemetryContextProgress.max = telemetry.context.maxTokens;
            telemetryContextProgress.value = telemetry.context.usedTokens;
            telemetryContextValue.textContent = Math.round(percent) + '% · '
                + compactTokens(telemetry.context.usedTokens) + ' / '
                + compactTokens(telemetry.context.maxTokens);
        }
        telemetryLimits.replaceChildren();
        telemetry.rateLimits.forEach(function (limit) {
            var meter = document.createElement('div');
            meter.className = 'conversation-telemetry-meter';
            var label = document.createElement('span');
            label.textContent = limit.label;
            var progress = document.createElement('progress');
            progress.max = 100;
            progress.value = limit.usedPercent;
            progress.setAttribute('aria-label', limit.label + ' usage');
            var value = document.createElement('span');
            var text = Math.round(100 - limit.usedPercent) + '% left';
            if (limit.resetsAt) {
                text += ' · resets in ' + compactResetTime(limit.resetsAt);
                value.title = new Date(
                    limit.resetsAt * 1000
                ).toLocaleString();
            }
            value.textContent = text;
            meter.append(label, progress, value);
            telemetryLimits.appendChild(meter);
        });
        telemetryRoot.hidden = !telemetry.model
            && !telemetry.context
            && telemetry.rateLimits.length === 0;
        restoreViewportReadingPosition(readingAnchor, previousScrollTop);
        return true;
    }

    function reconcileMessages(clean, preserveUnchanged, previousSignatures) {
        var template = document.createElement('template');
        template.innerHTML = clean;
        var candidates = Array.prototype.slice.call(
            template.content.querySelectorAll(conversationMessageSelector())
        );
        var nextIds = [];
        var nextSignatures = new Map();
        candidates.forEach(function (candidate) {
            var id = conversationMessageId(candidate);
            nextIds.push(id);
            nextSignatures.set(id, candidate.outerHTML);
        });
        if (!preserveUnchanged) {
            releaseMermaidObjectUrls();
            messages.replaceChildren(template.content);
            return { ids: nextIds, signatures: nextSignatures };
        }
        var oldMessages = Array.prototype.slice.call(
            messages.querySelectorAll(conversationMessageSelector())
        );
        var unchanged = oldMessages.length === candidates.length
            && candidates.every(function (candidate, index) {
                var id = conversationMessageId(candidate);
                return conversationMessageId(oldMessages[index]) === id
                    && previousSignatures.get(id) === candidate.outerHTML;
            });
        if (unchanged) {
            return { ids: nextIds, signatures: nextSignatures };
        }
        var oldById = new Map();
        oldMessages.forEach(function (message) {
            var id = conversationMessageId(message);
            if (id && !oldById.has(id)) oldById.set(id, message);
        });
        var preserved = new Set();
        candidates.forEach(function (candidate) {
            var id = conversationMessageId(candidate);
            var oldMessage = oldById.get(id);
            if (!id
                || !oldMessage
                || preserved.has(oldMessage)) {
                return;
            }
            if (previousSignatures.get(id) === candidate.outerHTML) {
                preserved.add(oldMessage);
                candidate.replaceWith(oldMessage);
                return;
            }
            preserveMermaidContent(oldMessage, candidate);
        });
        oldMessages.forEach(function (oldMessage) {
            if (!preserved.has(oldMessage)) {
                releaseMermaidObjectUrls(oldMessage);
            }
        });
        messages.replaceChildren(template.content);
        return { ids: nextIds, signatures: nextSignatures };
    }

    function updatePosition(message) {
        var total = message.totalInputs.toLocaleString();
        if (message.partial) total += '+';
        position.textContent = 'Input ' + message.selectedInput + ' of ' + total;
    }

    function scrollToConversationEnd() {
        scroll.scrollTop = Math.max(
            0,
            scroll.scrollHeight - scroll.clientHeight
        );
        state.followingEnd = true;
    }

    function conversationAtEnd() {
        var threshold = Number(
            document.body.getAttribute('data-auto-scroll-threshold')
        );
        return Number.isFinite(threshold)
            && threshold >= 0
            && scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop
                <= threshold;
    }

    function trackConversationEnd() {
        state.followingEnd = conversationAtEnd();
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
        var clean = window.DOMPurify.sanitize(message.html, {
            ALLOWED_TAGS: allowedTags,
            ALLOWED_ATTR: allowedAttributes,
            ALLOW_DATA_ATTR: false,
            ALLOW_ARIA_ATTR: false,
        });

        var reconciled = reconcileMessages(
            clean,
            isLiveRefresh,
            oldSignatures
        );
        enhanceCodeBlockIndentation();
        Array.prototype.forEach.call(
            messages.querySelectorAll('img'),
            function (image) {
                image.loading = 'lazy';
                image.decoding = 'async';
                image.referrerPolicy = 'no-referrer';
            }
        );
        var nextIds = reconciled.ids;
        var nextSignatures = reconciled.signatures;
        var appendedOrChanged = nextIds.filter(function (id) {
            return !oldIds.has(id)
                || oldSignatures.get(id) !== nextSignatures.get(id);
        });
        state.messageIds = nextIds;
        state.messageSignatures = nextSignatures;
        state.atLatest = message.atLatest;
        state.initialized = true;
        applyOutline(message);
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
        if (isLiveRefresh
            && focusedMessageId
            && (!focusedMessage.isConnected
                || !focusedMessage.contains(document.activeElement))) {
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
        renderMermaidDiagrams(renderGeneration);

        if (!isLiveRefresh) {
            state.firstNewMessageId = null;
            newResponse.hidden = true;
            var selected = selectedMessages[0];
            var openingAtLatest = message.atLatest
                && message.updateKind === 'initial';
            if (openingAtLatest) {
                scrollToConversationEnd();
            } else if (selected) {
                selected.scrollIntoView({ block: 'center' });
            }
            if (selected && message.updateKind === 'navigation') {
                selected.tabIndex = -1;
                selected.focus({ preventScroll: true });
            }
            if (!openingAtLatest) trackConversationEnd();
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
        trackConversationEnd();
    }

    function postNavigation(type) {
        post({ type: type, version: 1 });
    }

    scroll.addEventListener('scroll', trackConversationEnd, { passive: true });
    if (typeof ResizeObserver === 'function') {
        var viewportObserver = new ResizeObserver(function () {
            if (state.followingEnd) scrollToConversationEnd();
        });
        viewportObserver.observe(scroll);
        window.addEventListener('unload', function () {
            viewportObserver.disconnect();
        });
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
    if (sidebarUiAvailable) {
        function toggleSidebarView(view) {
            var alreadyOpen = state.commentsPanelOpen
                && state.sidebarView === view;
            setSidebarView(view, !alreadyOpen, true);
        }
        outlineToggle.addEventListener('click', function () {
            toggleSidebarView('outline');
        });
        commentsToggle.addEventListener('click', function () {
            toggleSidebarView('comments');
        });
        sidebarTabs.forEach(function (tab) {
            tab.addEventListener('click', function () {
                setSidebarView(
                    tab.getAttribute('data-sidebar-tab'),
                    true,
                    true
                );
            });
            tab.addEventListener('keydown', function (event) {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End']
                    .includes(event.key)) return;
                var current = sidebarTabs.indexOf(tab);
                var nextIndex = current;
                if (event.key === 'Home') nextIndex = 0;
                else if (event.key === 'End') {
                    nextIndex = sidebarTabs.length - 1;
                } else if (event.key === 'ArrowLeft') {
                    nextIndex = Math.max(0, current - 1);
                } else {
                    nextIndex = Math.min(
                        sidebarTabs.length - 1,
                        current + 1
                    );
                }
                event.preventDefault();
                var nextTab = sidebarTabs[nextIndex];
                setSidebarView(
                    nextTab.getAttribute('data-sidebar-tab'),
                    true,
                    true
                );
                nextTab.focus();
            });
        });
        sidebarClose.addEventListener('click', function () {
            setCommentsPanelOpen(false, true);
            if (state.sidebarView === 'outline') {
                outlineToggle.focus();
            } else {
                commentsToggle.focus();
            }
        });
        outlineSearch.addEventListener('input', function () {
            state.outlineQuery = outlineSearch.value;
            filterOutline();
            saveCommentsPanelState();
        });
        outlineBookmarksOnly.addEventListener('click', function () {
            state.bookmarksOnly = !state.bookmarksOnly;
            renderBookmarkState();
            filterOutline();
        });
        outlineList.addEventListener('click', function (event) {
            var bookmark = event.target.closest
                ? event.target.closest('[data-outline-bookmark-id]')
                : null;
            if (bookmark && outlineList.contains(bookmark)) {
                var bookmarkId = bookmark.getAttribute(
                    'data-outline-bookmark-id'
                );
                postBookmarkMutation(
                    bookmarkId,
                    !state.bookmarkIds.has(bookmarkId)
                );
                return;
            }
            var button = event.target.closest
                ? event.target.closest('[data-outline-interaction-id]')
                : null;
            if (!button || !outlineList.contains(button)) return;
            post({
                type: 'conversation-viewer-select-interaction',
                version: 1,
                interactionId: button.getAttribute(
                    'data-outline-interaction-id'
                ),
            });
        });
        outlineList.addEventListener('keydown', function (event) {
            if (!['ArrowUp', 'ArrowDown', 'Home', 'End']
                .includes(event.key)) return;
            var visible = visibleOutlineButtons();
            if (!visible.length) return;
            var current = event.target.closest
                ? event.target.closest('[data-outline-interaction-id]')
                : null;
            var index = visible.indexOf(current);
            if (event.key === 'Home') index = 0;
            else if (event.key === 'End') index = visible.length - 1;
            else if (event.key === 'ArrowUp') {
                index = Math.max(0, index - 1);
            } else {
                index = Math.min(visible.length - 1, index + 1);
            }
            event.preventDefault();
            visible.forEach(function (button) {
                button.tabIndex = -1;
            });
            visible[index].tabIndex = 0;
            visible[index].focus();
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
            if (action !== 'clearAll' && state.clearAllConfirmation) {
                resetClearAllConfirmation();
            }
            if (action === 'new') {
                openSessionCommentComposer();
                return;
            }
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
            if (action === 'clearSent' || action === 'clearResolved') {
                postCommentOperation(action, {});
                return;
            }
            if (action === 'clearAll') {
                if (!state.clearAllConfirmation) {
                    state.clearAllConfirmation = true;
                    commentClearAll.textContent = 'Confirm clear all';
                    commentClearAll.setAttribute('data-confirming', 'true');
                    commentClearAll.setAttribute(
                        'aria-label',
                        'Confirm clearing all comments'
                    );
                    status.textContent =
                        'Select Clear all again to remove every comment.';
                    return;
                }
                postCommentOperation('clearAll', {});
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
        if (commentUiAvailable && state.clearAllConfirmation) {
            event.preventDefault();
            resetClearAllConfirmation();
            status.textContent = 'Clear all cancelled.';
            commentClearAll.focus();
            return;
        }
        if (commentUiAvailable && !commentComposer.hidden) {
            event.preventDefault();
            closeCommentComposer();
            return;
        }
        if (sidebarUiAvailable
            && state.commentsPanelOpen
            && sidebarRoot.contains(document.activeElement)) {
            event.preventDefault();
            setCommentsPanelOpen(false, true);
            if (state.sidebarView === 'outline') outlineToggle.focus();
            else commentsToggle.focus();
            return;
        }
        event.preventDefault();
        postNavigation('conversation-viewer-closed');
    });
    window.addEventListener('message', function (event) {
        if (applyBookmarksResult(event.data)) return;
        if (applyCommentsResult(event.data)) return;
        if (applyLocateResult(event.data)) return;
        if (applyTelemetry(event.data)) return;
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
    if (sidebarUiAvailable) {
        var initialBookmarks = readJsonAttribute('data-initial-bookmarks');
        if (validBookmarkSnapshot(initialBookmarks)) {
            state.bookmarkRevision = initialBookmarks.revision;
            state.bookmarkIds = new Set(initialBookmarks.interactionIds);
            renderBookmarkState();
        } else {
            status.textContent = 'Conversation bookmarks are unavailable.';
        }
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
            if (savedCommentsPanel.view === 'outline'
                || savedCommentsPanel.view === 'comments') {
                state.sidebarView = savedCommentsPanel.view;
            }
            if (typeof savedCommentsPanel.query === 'string') {
                state.outlineQuery = savedCommentsPanel.query.slice(0, 4096);
                outlineSearch.value = state.outlineQuery;
            }
        }
        applyCommentsPanelLayout();
        filterOutline();
    }
    if (commentUiAvailable) {
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
