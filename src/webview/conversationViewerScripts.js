(function () {
    'use strict';

    var allowedTags = [
        'p', 'br', 'pre', 'code', 'blockquote', 'ul', 'ol', 'li',
        'strong', 'em', 'del', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'a', 'img', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
        'span', 'section', 'article', 'details', 'summary', 'button',
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
    var working = document.querySelector('[data-conversation-working]');
    var position = document.querySelector('[data-conversation-position]');
    var status = document.querySelector('[data-conversation-status]');
    var conversationDisplayName = document.querySelector(
        '[data-conversation-display-name]'
    );
    var conversationProvider = document.querySelector(
        '[data-conversation-provider]'
    );
    var telemetryRoot = document.querySelector('[data-conversation-telemetry]');
    var telemetryProvider = document.querySelector('[data-telemetry-provider]');
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
    var telemetryWorktree = document.querySelector('[data-telemetry-worktree]');
    var telemetryWorktreeBranch = document.querySelector(
        '[data-telemetry-worktree-branch]'
    );
    var previous = document.querySelector('[data-action="previous"]');
    var next = document.querySelector('[data-action="next"]');
    var latest = document.querySelector('[data-action="latest"]');
    var sidebarToggle = document.querySelector(
        '[data-action="toggle-sidebar"]'
    );
    var sessionStatusRunning = document.querySelector(
        '[data-session-status-running]'
    );
    var sessionStatusAttention = document.querySelector(
        '[data-session-status-attention]'
    );
    var sessionNavButtons = Array.prototype.slice.call(
        document.querySelectorAll('[data-session-nav]')
    );
    var commentsWorkspace = document.querySelector('.conversation-workspace');
    var commentsResizer = document.querySelector('[data-comments-resizer]');
    var sidebarRoot = document.querySelector('[data-conversation-sidebar]');
    var sidebarTabs = Array.prototype.slice.call(
        document.querySelectorAll('[data-sidebar-tab]')
    );
    var outlineRoot = document.querySelector('[data-conversation-outline]');
    var outlineSearch = document.querySelector('[data-outline-search]');
    var outlineList = document.querySelector('[data-outline-list]');
    var outlineEmpty = document.querySelector('[data-outline-empty]');
    var outlinePartial = document.querySelector('[data-outline-partial]');
    var outlineBookmarksOnly = document.querySelector(
        '[data-outline-bookmarks-only]'
    );
    var outlineSort = document.querySelector('[data-outline-sort]');
    var outlineBookmarkCount = document.querySelector(
        '[data-outline-bookmark-count]'
    );
    var commentsRoot = document.querySelector('[data-conversation-comments]');
    var subagentsRoot = document.querySelector('[data-conversation-subagents]');
    var subagentsList = document.querySelector('[data-subagents-list]');
    var subagentsEmpty = document.querySelector('[data-subagents-empty]');
    var subagentsSummary = document.querySelector('[data-subagents-summary]');
    var subagentBanner = document.querySelector('[data-subagent-banner]');
    var subagentBannerLabel = document.querySelector(
        '[data-subagent-banner-label]'
    );
    var followNotice = document.querySelector('[data-conversation-notice]');
    var followNoticeText = document.querySelector(
        '[data-conversation-notice-text]'
    );
    var followNoticeClose = document.querySelector('[data-notice-close]');
    var subagentsRunningOnly = document.querySelector(
        '[data-subagents-running-only]'
    );
    var telemetrySubagents = document.querySelector(
        '[data-telemetry-subagents]'
    );
    var telemetrySection = document.querySelector(
        '[data-conversation-telemetry]'
    );
    var closeSubagent = document.querySelector(
        '[data-action="close-subagent"]'
    );
    var commentCount = document.querySelector('[data-comment-count]');
    var commentComposer = document.querySelector('[data-comment-composer]');
    var commentSelection = document.querySelector('[data-comment-selection]');
    var commentInput = document.querySelector('[data-comment-input]');
    var commentList = document.querySelector('[data-comment-list]');
    var commentEmpty = document.querySelector('[data-comment-empty]');
    var commentFilterEmpty = document.querySelector(
        '[data-comment-filter-empty]'
    );
    var commentNew = document.querySelector('[data-comment-action="new"]');
    var commentSend = document.querySelector('[data-comment-action="send"]');
    var commentClearDone = document.querySelector(
        '[data-comment-action="clearDone"]'
    );
    var commentClearAll = document.querySelector(
        '[data-comment-action="clearAll"]'
    );
    var addComment = document.querySelector('[data-add-comment]');
    var findRoot = document.querySelector('[data-conversation-find]');
    var findInput = document.querySelector('[data-find-input]');
    var findCount = document.querySelector('[data-find-count]');
    var findPrevious = document.querySelector('[data-find-previous]');
    var findNext = document.querySelector('[data-find-next]');
    var findClose = document.querySelector('[data-find-close]');
    var telemetryComments = document.querySelector(
        '[data-telemetry-comments]'
    );
    var projectCommentsRoot = document.querySelector('[data-project-comments]');
    var projectCommentsHeader = document.querySelector(
        '[data-project-comments-header]'
    );
    var projectCommentsContent = document.querySelector(
        '[data-project-comments-content]'
    );
    var sessionCommentsHeader = document.querySelector(
        '[data-session-comments-header]'
    );
    var sessionCommentsContent = document.querySelector(
        '[data-session-comments-content]'
    );
    var commentsSectionSash = document.querySelector(
        '[data-comments-section-sash]'
    );
    var projectCommentsCount = document.querySelector(
        '[data-project-comments-count]'
    );
    var sessionCommentsCount = document.querySelector(
        '[data-session-comments-count]'
    );
    var projectCommentComposer = document.querySelector(
        '[data-project-comment-composer]'
    );
    var projectCommentSource = document.querySelector(
        '[data-project-comment-source]'
    );
    var projectCommentSourceLabel = document.querySelector(
        '[data-project-comment-source-label]'
    );
    var projectCommentSourceQuote = document.querySelector(
        '[data-project-comment-source-quote]'
    );
    var projectCommentInput = document.querySelector(
        '[data-project-comment-input]'
    );
    var projectCommentDraftTags = document.querySelector(
        '[data-project-comment-draft-tags]'
    );
    var projectCommentAddTag = document.querySelector(
        '[data-project-comment-action="add-draft-tag"]'
    );
    var projectCommentAdd = document.querySelector(
        '[data-project-comment-action="add"]'
    );
    var commentsFilterBar = document.querySelector(
        '[data-comments-filter-bar]'
    );
    var projectCommentList = document.querySelector(
        '[data-project-comment-list]'
    );
    var projectCommentEmpty = document.querySelector(
        '[data-project-comment-empty]'
    );
    var commentTarget = readJsonAttribute('data-conversation-target');
    var restoreTarget = readJsonAttribute(
        'data-conversation-restore-target'
    );
    var sidebarUiAvailable = !!sidebarToggle
        && !!commentsWorkspace && !!commentsResizer && !!sidebarRoot
        && sidebarTabs.length === 3 && !!outlineRoot
        && !!outlineSearch
        && !!outlineList && !!outlineEmpty && !!outlinePartial
        && !!outlineBookmarksOnly;
    var bookmarkUiAvailable = sidebarUiAvailable
        && validCommentTarget(commentTarget);
    var commentUiAvailable = sidebarUiAvailable
        && !!commentsRoot
        && !!sessionCommentsHeader && !!sessionCommentsContent
        && !!commentsSectionSash && !!sessionCommentsCount
        && !!commentsFilterBar
        && !!commentComposer && !!commentSelection && !!commentInput
        && !!commentList && !!commentEmpty && !!commentFilterEmpty
        && !!commentNew
        && !!commentSend && !!addComment
        && !!commentClearDone && !!commentClearAll
        && !!telemetryComments && !!telemetrySection
        && validCommentTarget(commentTarget);
    var subagentUiAvailable = sidebarUiAvailable
        && !!subagentsRoot && !!subagentsList && !!subagentsEmpty
        && !!subagentsSummary && !!subagentBanner && !!subagentBannerLabel
        && !!subagentsRunningOnly && !!closeSubagent
        && !!telemetrySubagents && !!telemetrySection
        && !!window.__agentPivotConversationSubagents;
    var projectCommentUiAvailable = commentUiAvailable
        && !!projectCommentsRoot && !!projectCommentsHeader
        && !!projectCommentsContent && !!projectCommentComposer
        && !!projectCommentsCount
        && !!projectCommentSource
        && !!projectCommentSourceLabel && !!projectCommentSourceQuote
        && !!projectCommentInput && !!projectCommentDraftTags
        && !!projectCommentAddTag && !!projectCommentAdd
        && !!projectCommentList
        && !!projectCommentEmpty;
    var copyUiAvailable = validCommentTarget(commentTarget);
    var findUiAvailable = !!findRoot && !!findInput && !!findCount
        && !!findPrevious && !!findNext && !!findClose;
    var copyRequestSequence = 0;
    var copyPending = new Map();
    var state = {
        atLatest: false,
        initialized: false,
        latestRequestId: 0,
        latestStatusRequestId: Number(document.body.getAttribute(
            'data-session-status-request-id'
        )) || 0,
        subscriptionGeneration: Number(document.body.getAttribute(
            'data-subscription-generation'
        )),
        messageIds: [],
        messageSignatures: new Map(),
        worklogExpanded: new Map(),
        renderGeneration: 0,
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
    var reconcileController = window.__agentPivotConversationReconcile.create({
        scroll: scroll,
        messages: messages,
        messageSelector: conversationMessageSelector,
        messageId: conversationMessageId,
        releaseMermaid: releaseMermaidObjectUrls,
        preserveMermaid: preserveMermaidContent,
    });
    var outlineController;
    var commentsController;
    var sidebarController = window.__agentPivotConversationSidebar.create({
        available: sidebarUiAvailable,
        vscodeApi: vscodeApi,
        sidebarToggle: sidebarToggle,
        commentsWorkspace: commentsWorkspace,
        commentsResizer: commentsResizer,
        sidebarRoot: sidebarRoot,
        sidebarTabs: sidebarTabs,
        outlineRoot: outlineRoot,
        commentsRoot: commentsRoot,
        subagentsRoot: subagentsRoot,
        outlineQuery: function () {
            return outlineController.query();
        },
        subagentsRunningOnlyQuery: function () {
            return !!subagentsRunningOnly && subagentsRunningOnly.checked;
        },
    });
    var outlineController = window.__agentPivotConversationOutline.create({
        available: sidebarUiAvailable,
        bookmarkAvailable: bookmarkUiAvailable,
        target: commentTarget,
        subscriptionGeneration: state.subscriptionGeneration,
        status: status,
        outlineSearch: outlineSearch,
        outlineList: outlineList,
        outlineEmpty: outlineEmpty,
        outlinePartial: outlinePartial,
        outlineBookmarksOnly: outlineBookmarksOnly,
        outlineBookmarkCount: outlineBookmarkCount,
        outlineSort: outlineSort,
        messagesRoot: messages,
        post: post,
        outlinePanelActive: sidebarController.isOutlineActive,
        persistPanelState: sidebarController.save,
        updateToggle: sidebarController.updateToggle,
    });
    var subagentsController = subagentUiAvailable
        ? window.__agentPivotConversationSubagents.create({
            listRoot: subagentsList,
            emptyRoot: subagentsEmpty,
            summaryRoot: subagentsSummary,
            banner: subagentBanner,
            bannerLabel: subagentBannerLabel,
            runningOnly: subagentsRunningOnly,
            telemetrySubagents: telemetrySubagents,
            telemetrySection: telemetrySection,
            onRunningOnlyChange: function () {
                sidebarController.save();
            },
            onOpen: function (subagentId) {
                post({
                    type: 'conversation-viewer-open-subagent',
                    version: 1,
                    subagentId: subagentId,
                });
            },
        })
        : null;
    if (subagentUiAvailable) {
        closeSubagent.addEventListener('click', function () {
            post({
                type: 'conversation-viewer-close-subagent',
                version: 1,
            });
        });
        telemetrySubagents.addEventListener('click', function () {
            sidebarController.setView('subagents', true, true);
        });
    }
    if (commentUiAvailable) {
        telemetryComments.addEventListener('click', function () {
            sidebarController.setView('comments', true, true);
        });
    }
    if (sidebarUiAvailable && position) {
        position.addEventListener('click', function () {
            sidebarController.setView('outline', true, true);
        });
    }
    var telemetryController = window.__agentPivotConversationTelemetry.create({
        target: commentTarget,
        subscriptionGeneration: state.subscriptionGeneration,
        latestRequestId: function () {
            return state.latestRequestId;
        },
        telemetryRoot: telemetryRoot,
        telemetryProvider: telemetryProvider,
        telemetryModel: telemetryModel,
        telemetryModelValue: telemetryModelValue,
        telemetryContext: telemetryContext,
        telemetryContextProgress: telemetryContextProgress,
        telemetryContextValue: telemetryContextValue,
        telemetryLimits: telemetryLimits,
        telemetryWorktree: telemetryWorktree,
        telemetryWorktreeBranch: telemetryWorktreeBranch,
        scroll: scroll,
        captureAnchor: captureReadingAnchor,
        restoreViewport: restoreViewportReadingPosition,
    });
    var commentsController = window.__agentPivotConversationComments.create({
        available: commentUiAvailable,
        target: commentTarget,
        subscriptionGeneration: state.subscriptionGeneration,
        status: status,
        messages: messages,
        scroll: scroll,
        addComment: addComment,
        commentsRoot: commentsRoot,
        commentCount: commentCount,
        commentComposer: commentComposer,
        commentSelection: commentSelection,
        commentInput: commentInput,
        commentList: commentList,
        commentEmpty: commentEmpty,
        commentFilterEmpty: commentFilterEmpty,
        commentNew: commentNew,
        commentSend: commentSend,
        commentClearDone: commentClearDone,
        commentClearAll: commentClearAll,
        vscodeApi: vscodeApi,
        telemetryComments: telemetryComments,
        telemetrySection: telemetrySection,
        projectCommentsAvailable: projectCommentUiAvailable,
        projectCommentsRoot: projectCommentsRoot,
        projectCommentsHeader: projectCommentsHeader,
        projectCommentsContent: projectCommentsContent,
        projectCommentsCount: projectCommentsCount,
        sessionCommentsHeader: sessionCommentsHeader,
        sessionCommentsContent: sessionCommentsContent,
        commentsSectionSash: commentsSectionSash,
        sessionCommentsCount: sessionCommentsCount,
        projectCommentComposer: projectCommentComposer,
        projectCommentSource: projectCommentSource,
        projectCommentSourceLabel: projectCommentSourceLabel,
        projectCommentSourceQuote: projectCommentSourceQuote,
        projectCommentInput: projectCommentInput,
        projectCommentDraftTags: projectCommentDraftTags,
        projectCommentAddTag: projectCommentAddTag,
        projectCommentAdd: projectCommentAdd,
        commentsFilterBar: commentsFilterBar,
        projectCommentList: projectCommentList,
        projectCommentEmpty: projectCommentEmpty,
        post: post,
        messageSelector: conversationMessageSelector,
        messageId: conversationMessageId,
        setSidebarView: sidebarController.setView,
        updateToggle: sidebarController.updateToggle,
    });
    var findController = window.__agentPivotConversationFind
        ? window.__agentPivotConversationFind.create({
            available: findUiAvailable,
            root: findRoot,
            input: findInput,
            count: findCount,
            previous: findPrevious,
            next: findNext,
            close: findClose,
            messages: messages,
            scroll: scroll,
        })
        : null;

    if (!scroll || !messages || !working || !position || !status
        || !previous || !next || !latest || !window.DOMPurify) {
        return;
    }

    function isHttps(value) {
        try {
            return new URL(value).protocol === 'https:';
        } catch (_error) {
            return false;
        }
    }

    function isAbsoluteFileHref(value) {
        if (!value || value.length > 4096) return false;
        var decoded;
        try {
            decoded = decodeURIComponent(value);
        } catch (_error) {
            return false;
        }
        return !/[\u0000-\u001f\u007f]/.test(decoded)
            && decoded.indexOf('?') === -1
            && decoded.indexOf('#') === -1
            && (/^\/(?!\/)/.test(decoded) || /^[A-Za-z]:[\\/]/.test(decoded));
    }

    function isAllowedLinkHref(value) {
        return isHttps(value) || isAbsoluteFileHref(value);
    }

    window.DOMPurify.addHook('afterSanitizeAttributes', function (node) {
        if (!node.hasAttribute) return;
        if (node.hasAttribute('href') && !isAllowedLinkHref(
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

    function validRestoreTarget(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return false;
        }
        var keys = Object.keys(value);
        var hasSubagent = Object.prototype.hasOwnProperty.call(
            value,
            'subagentId'
        );
        return keys.length === (hasSubagent ? 5 : 4)
            && typeof value.projectId === 'string'
            && value.projectId.length > 0
            && (value.provider === 'codex'
                || value.provider === 'kimi'
                || value.provider === 'claude')
            && typeof value.sessionId === 'string'
            && value.sessionId.length > 0
            && typeof value.interactionId === 'string'
            && value.interactionId.length > 0
            && (!hasSubagent
                || (typeof value.subagentId === 'string'
                    && value.subagentId.length > 0));
    }

    function saveRestoreTarget(nextTarget) {
        if (!validRestoreTarget(nextTarget)
            || !vscodeApi
            || typeof vscodeApi.setState !== 'function') {
            return;
        }
        restoreTarget = Object.assign({}, nextTarget);
        try {
            var saved = typeof vscodeApi.getState === 'function'
                ? vscodeApi.getState()
                : null;
            var next = saved && typeof saved === 'object'
                && !Array.isArray(saved)
                ? Object.assign({}, saved)
                : {};
            next.conversationViewer = {
                version: 1,
                target: Object.assign({}, restoreTarget),
            };
            vscodeApi.setState(next);
        } catch (_error) {
            // Panel restoration is best-effort local Webview state.
        }
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

    function validSubagentEntry(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return false;
        }
        var allowed = new Set([
            'id', 'label', 'agentType', 'status', 'createdAt', 'updatedAt',
        ]);
        return Object.keys(value).every(function (key) {
            return allowed.has(key);
        }) && typeof value.id === 'string' && !!value.id
            && value.id.length <= 128
            && typeof value.label === 'string'
            && (value.agentType === undefined
                || typeof value.agentType === 'string')
            && (value.status === 'running' || value.status === 'idle'
                || value.status === 'quiet' || value.status === 'failed'
                || value.status === 'killed')
            && (value.createdAt === undefined
                || (Number.isSafeInteger(value.createdAt)
                    && value.createdAt >= 0))
            && (value.updatedAt === undefined
                || (Number.isSafeInteger(value.updatedAt)
                    && value.updatedAt >= 0));
    }

    function validSubagents(value) {
        if (!Array.isArray(value) || value.length > 256
            || !value.every(validSubagentEntry)) {
            return false;
        }
        return new Set(value.map(function (entry) {
            return entry.id;
        })).size === value.length;
    }

    function validActiveSubagent(value) {
        if (value === null) return true;
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return false;
        }
        var keys = Object.keys(value);
        return keys.length === 2
            && typeof value.id === 'string' && !!value.id
            && value.id.length <= 128
            && typeof value.label === 'string';
    }

    function validPageTarget(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return false;
        }
        var required = [
            'projectId', 'provider', 'sessionId', 'interactionId', 'displayName',
        ];
        var allowed = new Set(required.concat(['duplicateDisplayName']));
        return Object.keys(value).every(function (key) {
            return allowed.has(key);
        }) && required.every(function (key) {
            return Object.prototype.hasOwnProperty.call(value, key);
        })
            && validCommentTarget({
                projectId: value.projectId,
                provider: value.provider,
                sessionId: value.sessionId,
            })
            && typeof value.interactionId === 'string'
            && value.interactionId.length > 0
            && typeof value.displayName === 'string'
            && value.displayName.length <= 640
            && (value.duplicateDisplayName === undefined
                || typeof value.duplicateDisplayName === 'boolean');
    }

    function validCommentSnapshot(value) {
        return value && typeof value === 'object' && !Array.isArray(value)
            && Object.keys(value).length === 2
            && Number.isSafeInteger(value.revision) && value.revision >= 0
            && Array.isArray(value.comments) && value.comments.length <= 20;
    }

    function validProjectCommentSnapshot(value) {
        return value && typeof value === 'object' && !Array.isArray(value)
            && Object.keys(value).length === 2
            && Number.isSafeInteger(value.revision) && value.revision >= 0
            && Array.isArray(value.comments) && value.comments.length <= 50;
    }

    function validBookmarkSnapshot(value) {
        return value && typeof value === 'object' && !Array.isArray(value)
            && Object.keys(value).length === 2
            && Number.isSafeInteger(value.revision) && value.revision >= 0
            && Array.isArray(value.interactionIds)
            && value.interactionIds.length <= 2000
            && value.interactionIds.every(function (id) {
                return typeof id === 'string' && id.length > 0;
            });
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
            'previousCursor', 'nextCursor', 'subagents', 'activeSubagent',
            'displayName', 'target', 'comments', 'projectComments',
            'bookmarks',
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
            && validSubagents(message.subagents)
            && validActiveSubagent(message.activeSubagent)
            && (message.displayName === undefined
                || (typeof message.displayName === 'string'
                    && message.displayName.length <= 640))
            && (message.target === undefined
                || validPageTarget(message.target))
            && (message.comments === undefined
                || validCommentSnapshot(message.comments))
            && (message.projectComments === undefined
                || validProjectCommentSnapshot(message.projectComments))
            && (message.bookmarks === undefined
                || validBookmarkSnapshot(message.bookmarks))
            && typeof message.stale === 'boolean';
    }

    function providerLabel(provider) {
        if (provider === 'kimi') return 'Kimi';
        if (provider === 'claude') return 'Claude';
        return 'Codex';
    }

    var FOLLOW_NOTICE_MAX_LENGTH = 640;

    function validFollowNotice(message) {
        return !!message
            && Object.keys(message).length === 2
            && typeof message.text === 'string'
            && message.text.length > 0
            && message.text.length <= FOLLOW_NOTICE_MAX_LENGTH;
    }

    function hideFollowNotice() {
        if (followNotice) {
            followNotice.hidden = true;
        }
    }

    function applyFollowNotice(message) {
        if (!message || message.type !== 'conversation-viewer-notice') {
            return false;
        }
        if (!validFollowNotice(message)) {
            return true;
        }
        if (followNotice && followNoticeText) {
            followNoticeText.textContent = message.text;
            followNotice.hidden = false;
        }
        return true;
    }

    function applySessionGeneration(message) {
        if (message.subscriptionGeneration === state.subscriptionGeneration) {
            return true;
        }
        if (message.subscriptionGeneration < state.subscriptionGeneration
            || !validPageTarget(message.target)
            || !validCommentSnapshot(message.comments)
            || !validProjectCommentSnapshot(message.projectComments)
            || !validBookmarkSnapshot(message.bookmarks)
            || !outlineController.canResetSession(message.bookmarks)
            || !commentsController.canResetSession(message.comments)
            || (projectCommentUiAvailable
                && !commentsController.canResetProjectComments(
                    message.projectComments
                ))) {
            return false;
        }
        var nextCommentTarget = {
            projectId: message.target.projectId,
            provider: message.target.provider,
            sessionId: message.target.sessionId,
        };
        if (!outlineController.resetSession(
            nextCommentTarget,
            message.subscriptionGeneration,
            message.bookmarks
        ) || !commentsController.resetSession(
            nextCommentTarget,
            message.subscriptionGeneration,
            message.comments,
            message.projectComments
        )) {
            return false;
        }
        telemetryController.resetSession(
            nextCommentTarget,
            message.subscriptionGeneration
        );
        commentTarget = nextCommentTarget;
        restoreTarget = {
            projectId: message.target.projectId,
            provider: message.target.provider,
            sessionId: message.target.sessionId,
            interactionId: message.target.interactionId,
        };
        state.subscriptionGeneration = message.subscriptionGeneration;
        state.latestRequestId = 0;
        state.latestStatusRequestId = 0;
        state.initialized = false;
        state.messageIds = [];
        state.messageSignatures = new Map();
        state.worklogExpanded = new Map();
        copyPending = new Map();
        document.body.setAttribute(
            'data-subscription-generation',
            String(message.subscriptionGeneration)
        );
        if (conversationProvider) {
            conversationProvider.textContent = providerLabel(
                message.target.provider
            );
        }
        return true;
    }


    function updatePosition(message) {
        var total = message.totalInputs.toLocaleString();
        if (message.partial) total += '+';
        var label = 'Input ' + message.selectedInput + ' of ' + total;
        var value = position.querySelector('[data-conversation-position-value]');
        if (value) {
            value.textContent = message.selectedInput + '/' + total;
            position.title = label + ' — click to open the outline';
            position.setAttribute('aria-label', position.title);
            position.setAttribute('data-tooltip', position.title);
        } else {
            position.textContent = label;
        }
    }

    function centerInMessageViewport(element) {
        var viewportBounds = scroll.getBoundingClientRect();
        var elementBounds = element.getBoundingClientRect();
        scroll.scrollTop += elementBounds.top - viewportBounds.top
            - (scroll.clientHeight - elementBounds.height) / 2;
    }

    function worklogRowForInteraction(interactionId) {
        if (!interactionId) return null;
        return Array.prototype.find.call(
            messages.querySelectorAll('.conversation-message-worklog'),
            function (row) {
                return row.getAttribute('data-interaction-id')
                    === interactionId;
            }
        ) || null;
    }

    function retargetCollapsedWorklogAnchor(anchor) {
        if (!anchor || !anchor.element || !anchor.element.closest) {
            return anchor;
        }
        var message = anchor.element.closest(conversationMessageSelector());
        if (message && !message.isConnected && anchor.messageId) {
            message = Array.prototype.find.call(
                messages.querySelectorAll(conversationMessageSelector()),
                function (candidate) {
                    return conversationMessageId(candidate)
                        === anchor.messageId;
                }
            ) || null;
        }
        if (!message || !message.hidden) return anchor;
        var row = worklogRowForInteraction(
            message.getAttribute('data-interaction-id')
        );
        if (!row) return anchor;
        return Object.assign({}, anchor, {
            element: row,
            messageId: conversationMessageId(row),
            blockIndex: -1,
        });
    }

    function applyWorklogStates() {
        Array.prototype.forEach.call(
            messages.querySelectorAll('.conversation-message-worklog'),
            function (row) {
                var interactionId = row.getAttribute('data-interaction-id');
                if (!interactionId) return;
                var expanded = state.worklogExpanded.get(interactionId) === true;
                var toggle = row.querySelector('.conversation-worklog-toggle');
                if (toggle) {
                    toggle.setAttribute(
                        'aria-expanded',
                        expanded ? 'true' : 'false'
                    );
                }
                row.classList.toggle(
                    'conversation-worklog-expanded',
                    expanded
                );
                // The row heads the work group: entries after it (up to
                // the next turn) collapse, so the toggle never moves when
                // expanding.
                var sibling = row.nextElementSibling;
                while (sibling
                    && sibling.getAttribute('data-interaction-id')
                        === interactionId) {
                    if (sibling.classList.contains('conversation-message-tool')
                        || sibling.classList.contains(
                            'conversation-message-thinking'
                        )
                        || sibling.classList.contains(
                            'conversation-message-progress'
                        )) {
                        sibling.hidden = !expanded;
                    }
                    sibling = sibling.nextElementSibling;
                }
            }
        );
    }

    function nextCopyRequestId() {
        copyRequestSequence += 1;
        return [
            'conversation-copy',
            Date.now().toString(36),
            copyRequestSequence.toString(36),
        ].join(':');
    }

    function postCopyRequest(button, payload) {
        if (!copyUiAvailable) return;
        var requestId = nextCopyRequestId();
        copyPending.set(requestId, button);
        // A settlement should land long before this; the timer only keeps
        // the map bounded if a message ever goes missing.
        window.setTimeout(function () {
            copyPending.delete(requestId);
        }, 30000);
        post({
            type: 'conversation-viewer-copy',
            version: 1,
            requestId: requestId,
            subscriptionGeneration: state.subscriptionGeneration,
            projectId: commentTarget.projectId,
            provider: commentTarget.provider,
            sessionId: commentTarget.sessionId,
            operation: 'copy',
            payload: payload,
        });
    }

    function validCopyResult(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return false;
        }
        var required = ['type', 'version', 'requestId', 'success'];
        var allowed = new Set(required.concat(['error']));
        return Object.keys(value).every(function (key) {
            return allowed.has(key);
        }) && required.every(function (key) {
            return Object.prototype.hasOwnProperty.call(value, key);
        })
            && value.type === 'conversation-viewer-copy-result'
            && value.version === 1
            && typeof value.requestId === 'string'
            && typeof value.success === 'boolean'
            && (value.error === undefined
                || value.error === 'invalid'
                || value.error === 'failed');
    }

    var copyIconNamespace = 'http://www.w3.org/2000/svg';

    function createCopyIconElement(kind) {
        var icon = document.createElementNS(copyIconNamespace, 'svg');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('width', '14');
        icon.setAttribute('height', '14');
        icon.setAttribute('aria-hidden', 'true');
        icon.setAttribute('fill', 'none');
        icon.setAttribute('stroke', 'currentColor');
        icon.setAttribute('stroke-width', '2');
        icon.setAttribute('stroke-linecap', 'round');
        icon.setAttribute('stroke-linejoin', 'round');
        if (kind === 'check' || kind === 'cross') {
            var glyph = document.createElementNS(copyIconNamespace, 'path');
            glyph.setAttribute('d', kind === 'check'
                ? 'M4 12.5l5 5L20 6.5'
                : 'M6 6l12 12M18 6L6 18');
            icon.appendChild(glyph);
            return icon;
        }
        var back = document.createElementNS(copyIconNamespace, 'path');
        back.setAttribute(
            'd',
            'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'
        );
        var front = document.createElementNS(copyIconNamespace, 'rect');
        front.setAttribute('x', '9');
        front.setAttribute('y', '9');
        front.setAttribute('width', '13');
        front.setAttribute('height', '13');
        front.setAttribute('rx', '2');
        icon.appendChild(back);
        icon.appendChild(front);
        return icon;
    }

    function replaceCopyIcon(button, kind) {
        var current = button.querySelector('svg');
        if (current) current.remove();
        button.appendChild(createCopyIconElement(kind));
    }

    function flashCopyResult(button, success) {
        window.clearTimeout(button.__conversationCopyTimer);
        button.classList.toggle('is-copied', success);
        button.classList.toggle('is-failed', !success);
        button.setAttribute(
            'aria-label',
            success ? 'Copied' : 'Copy failed'
        );
        replaceCopyIcon(button, success ? 'check' : 'cross');
        button.__conversationCopyTimer = window.setTimeout(function () {
            button.classList.remove('is-copied');
            button.classList.remove('is-failed');
            button.setAttribute('aria-label', button.title || 'Copy');
            replaceCopyIcon(button, 'copy');
        }, 1400);
    }

    function applyCopyResult(message) {
        if (!validCopyResult(message)) return false;
        var button = copyPending.get(message.requestId);
        if (!button) return false;
        copyPending.delete(message.requestId);
        flashCopyResult(button, message.success);
        return true;
    }

    function applyCopyButtonLabels() {
        Array.prototype.forEach.call(
            messages.querySelectorAll(
                '.conversation-message-copy, .conversation-code-copy'
            ),
            function (button) {
                if (!button.getAttribute('aria-label')) {
                    button.setAttribute(
                        'aria-label',
                        button.title || 'Copy'
                    );
                }
                if (!button.querySelector('svg')) {
                    button.appendChild(createCopyIconElement('copy'));
                }
            }
        );
    }

    function applyPage(message) {
        if (!validPage(message)
            || !applySessionGeneration(message)
            || message.requestId <= state.latestRequestId) {
            return;
        }
        state.latestRequestId = message.requestId;
        var previousScrollTop = scroll.scrollTop;
        var isLiveRefresh = state.initialized
            && message.updateKind === 'refresh';
        var wasFollowingEnd = isLiveRefresh && reconcileController.atEnd();
        var readingAnchor = isLiveRefresh ? captureReadingAnchor() : null;
        var focusedMessage = document.activeElement
            && document.activeElement.closest
            ? document.activeElement.closest(conversationMessageSelector())
            : null;
        var focusedMessageId = focusedMessage
            ? conversationMessageId(focusedMessage)
            : null;
        var focusedInteractionId = focusedMessage
            ? focusedMessage.getAttribute('data-interaction-id')
            : null;
        var oldSignatures = state.messageSignatures;
        state.renderGeneration += 1;
        var renderGeneration = state.renderGeneration;
        var clean = window.DOMPurify.sanitize(message.html, {
            ALLOWED_TAGS: allowedTags,
            ALLOWED_ATTR: allowedAttributes,
            ALLOW_DATA_ATTR: false,
            ALLOW_ARIA_ATTR: false,
        });

        var reconciled = reconcileController.reconcile(
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
        applyWorklogStates();
        applyCopyButtonLabels();
        var nextIds = reconciled.ids;
        var nextSignatures = reconciled.signatures;
        state.messageIds = nextIds;
        state.messageSignatures = nextSignatures;
        state.atLatest = message.atLatest;
        state.initialized = true;
        var nextRestoreTarget = Object.assign({}, restoreTarget || {}, {
            interactionId: message.selectedInteractionId,
        });
        if (message.activeSubagent) {
            nextRestoreTarget.subagentId = message.activeSubagent.id;
        } else {
            delete nextRestoreTarget.subagentId;
        }
        saveRestoreTarget(nextRestoreTarget);
        outlineController.applyOutline(message);
        if (subagentsController) {
            subagentsController.apply(
                message.subagents,
                message.activeSubagent
            );
        }
        commentsController.updateHighlights();
        if (findController) findController.refresh();
        hideFollowNotice();
        if (conversationDisplayName
            && (typeof message.displayName === 'string'
                || validPageTarget(message.target))) {
            conversationDisplayName.textContent = typeof message.displayName
                === 'string'
                ? message.displayName
                : message.target.displayName;
        }
        updatePosition(message);
        var latestInteraction = message.outline[message.outline.length - 1];
        var latestInteractionRendered = latestInteraction
            && Array.prototype.some.call(
                messages.querySelectorAll('[data-interaction-id]'),
                function (candidate) {
                    return candidate.getAttribute('data-interaction-id')
                        === latestInteraction.interactionId;
                }
            );
        working.hidden = !latestInteractionRendered
            || latestInteraction.responseState !== 'inProgress';
        previous.disabled = message.previousCursor === undefined;
        next.disabled = message.nextCursor === undefined;
        latest.disabled = !message.selectedInteractionId;
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
        var selected = selectedMessages[0];
        if (!isLiveRefresh && selected) {
            selected.classList.add('conversation-selected-interaction');
            window.setTimeout(function () {
                selected.classList.remove('conversation-selected-interaction');
            }, 1600);
        }
        if (isLiveRefresh
            && focusedMessageId
            && (!focusedMessage.isConnected
                || focusedMessage.hidden
                || !focusedMessage.contains(document.activeElement))) {
            var restoredFocus = Array.prototype.find.call(
                messages.querySelectorAll(conversationMessageSelector()),
                function (candidate) {
                    return conversationMessageId(candidate)
                        === focusedMessageId;
                }
            );
            if (restoredFocus && !restoredFocus.hidden) {
                restoredFocus.tabIndex = -1;
                restoredFocus.focus({ preventScroll: true });
            } else {
                var worklogRow = worklogRowForInteraction(
                    focusedInteractionId
                );
                var worklogToggle = worklogRow
                    ? worklogRow.querySelector('.conversation-worklog-toggle')
                    : null;
                if (worklogToggle) {
                    worklogToggle.focus({ preventScroll: true });
                }
            }
        }
        renderMermaidDiagrams(renderGeneration);

        if (!isLiveRefresh) {
            var openingAtLatest = message.atLatest
                && message.updateKind === 'initial';
            if (openingAtLatest) {
                reconcileController.scrollToEnd();
            } else if (selected) {
                centerInMessageViewport(selected);
            }
            if (selected && message.updateKind === 'navigation') {
                selected.tabIndex = -1;
                selected.focus({ preventScroll: true });
            }
            if (!openingAtLatest) reconcileController.trackEnd();
            return;
        }

        if (wasFollowingEnd) {
            reconcileController.scrollToEnd();
        } else {
            restoreReadingPosition(
                retargetCollapsedWorklogAnchor(readingAnchor),
                previousScrollTop
            );
            reconcileController.trackEnd();
        }
    }

    function postNavigation(type) {
        post({ type: type, version: 1 });
    }

    reconcileController.attach();

    previous.addEventListener('click', function () {
        postNavigation('conversation-viewer-previous');
    });
    next.addEventListener('click', function () {
        postNavigation('conversation-viewer-next');
    });
    latest.addEventListener('click', function () {
        postNavigation('conversation-viewer-latest');
    });
    sessionNavButtons.forEach(function (button) {
        button.addEventListener('click', function () {
            post({
                type: 'conversation-viewer-switch-session',
                version: 1,
                direction: button.getAttribute('data-session-nav'),
            });
        });
    });
    if (telemetryWorktree) {
        telemetryWorktree.addEventListener('click', function () {
            var worktreeRoot = telemetryWorktree.getAttribute(
                'data-worktree-root'
            );
            if (worktreeRoot) {
                post({
                    type: 'conversation-viewer-open-worktree',
                    version: 1,
                    worktreeRoot: worktreeRoot,
                });
            }
        });
    }
    if (sidebarUiAvailable) {
        sidebarController.attach();
        outlineController.attach();
    }
    messages.addEventListener('click', function (event) {
        var toggle = event.target && event.target.closest
            ? event.target.closest('.conversation-worklog-toggle')
            : null;
        if (!toggle || !messages.contains(toggle)) return;
        var row = toggle.closest('.conversation-message-worklog');
        var interactionId = row
            ? row.getAttribute('data-interaction-id')
            : null;
        if (!interactionId) return;
        if (state.worklogExpanded.get(interactionId) === true) {
            state.worklogExpanded.delete(interactionId);
        } else {
            state.worklogExpanded.set(interactionId, true);
        }
        applyWorklogStates();
    });
    messages.addEventListener('click', function (event) {
        var star = event.target && event.target.closest
            ? event.target.closest('.conversation-message-bookmark')
            : null;
        if (!star || !messages.contains(star)) return;
        var article = star.closest('[data-interaction-id]');
        var interactionId = article
            ? article.getAttribute('data-interaction-id')
            : '';
        if (!interactionId) return;
        outlineController.toggleBookmark(interactionId, 'card');
    });
    messages.addEventListener('click', function (event) {
        var codeCopy = event.target && event.target.closest
            ? event.target.closest('.conversation-code-copy')
            : null;
        if (codeCopy && messages.contains(codeCopy)) {
            var block = codeCopy.closest('.conversation-code-block');
            var code = block ? block.querySelector('pre code') : null;
            if (!code) return;
            postCopyRequest(codeCopy, {
                kind: 'code',
                text: code.textContent || '',
            });
            return;
        }
        var messageCopy = event.target && event.target.closest
            ? event.target.closest('.conversation-message-copy')
            : null;
        if (!messageCopy || !messages.contains(messageCopy)) return;
        var host = messageCopy.closest('[data-message-id]');
        var messageId = host ? host.getAttribute('data-message-id') : '';
        if (!messageId) return;
        postCopyRequest(messageCopy, {
            kind: 'message',
            messageId: messageId,
        });
    });
    messages.addEventListener('click', function (event) {
        var link = event.target && event.target.closest
            ? event.target.closest('a[href]')
            : null;
        if (!link || !messages.contains(link)) return;
        var href = link.getAttribute('href');
        if (isHttps(href)) return;
        event.preventDefault();
        if (!isAbsoluteFileHref(href)) return;
        post({
            type: 'conversation-viewer-open-link',
            version: 1,
            href: href,
        });
    });
    if (findController) {
        findController.attach();
    }
    if (commentUiAvailable) {
        commentsController.attach();
    }
    document.addEventListener('keydown', function (event) {
        if (findController && findController.handleKeydown(event)) return;
        if (commentsController.handleEnterShortcut(event)) return;
        if (event.key !== 'Escape') return;
        if (commentsController.handleEscape(event)) return;
        sidebarController.handleEscape(event);
    });
    function sessionStatusDotLabel(kind, count) {
        if (kind === 'running') {
            if (count === 0) return 'No AI sessions running';
            return count === 1
                ? '1 AI session running across all windows'
                : count + ' AI sessions running across all windows';
        }
        if (count === 0) return 'No AI sessions need attention';
        return count === 1
            ? '1 AI session needs attention across all windows'
            : count + ' AI sessions need attention across all windows';
    }
    function validSessionStatus(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return false;
        }
        var keys = Object.keys(value);
        return keys.length === 2
            && keys.indexOf('runningSessions') !== -1
            && keys.indexOf('attentionSessions') !== -1
            && Number.isSafeInteger(value.runningSessions)
            && value.runningSessions >= 0
            && value.runningSessions <= 100000
            && Number.isSafeInteger(value.attentionSessions)
            && value.attentionSessions >= 0
            && value.attentionSessions <= 100000;
    }
    function applySessionStatusDot(element, kind, count) {
        var label = sessionStatusDotLabel(kind, count);
        element.classList.toggle(
            'conversation-session-status-active',
            count > 0
        );
        element.title = label;
        element.setAttribute('aria-label', label);
    }
    function applySessionStatusMessage(message) {
        if (!message || typeof message !== 'object'
            || message.type !== 'conversation-viewer-session-status'
            || message.version !== 1
            || !Number.isSafeInteger(message.requestId)
            || message.requestId < state.latestStatusRequestId
            || message.subscriptionGeneration !== state.subscriptionGeneration
            || !validSessionStatus(message.status)
            || !sessionStatusRunning || !sessionStatusAttention) {
            return false;
        }
        state.latestStatusRequestId = message.requestId;
        applySessionStatusDot(
            sessionStatusRunning,
            'running',
            message.status.runningSessions
        );
        applySessionStatusDot(
            sessionStatusAttention,
            'attention',
            message.status.attentionSessions
        );
        return true;
    }
    window.addEventListener('message', function (event) {
        if (applyCopyResult(event.data)) return;
        if (outlineController.applyBookmarksResult(event.data)) return;
        if (commentsController.applyCommentsResult(event.data)) return;
        if (commentsController.applyProjectCommentsResult(event.data)) {
            return;
        }
        if (commentsController.applyLocateResult(event.data)) return;
        if (telemetryController.apply(event.data)) return;
        if (applySessionStatusMessage(event.data)) return;
        if (applyFollowNotice(event.data)) return;
        applyPage(event.data);
    });
    if (followNoticeClose) {
        followNoticeClose.addEventListener('click', hideFollowNotice);
    }
    function postFocusState() {
        post({
            type: 'conversation-viewer-focus',
            version: 1,
            focused: document.hasFocus(),
        });
    }
    window.addEventListener('focus', postFocusState);
    window.addEventListener('blur', postFocusState);
    postFocusState();
    window.addEventListener('unload', releaseMermaidObjectUrls);

    saveRestoreTarget(restoreTarget);
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
        outlineController.initializeBookmarks();
        var savedCommentsPanel = sidebarController.readSavedState();
        if (savedCommentsPanel) {
            sidebarController.restore(savedCommentsPanel);
            outlineController.restoreQuery(savedCommentsPanel.query);
            if (subagentsRunningOnly) {
                subagentsRunningOnly.checked =
                    savedCommentsPanel.subagentsRunningOnly === true;
            }
        }
        sidebarController.applyLayout();
        outlineController.filter();
        if (subagentsController) {
            subagentsController.refresh();
        }
    }
    if (commentUiAvailable) {
        commentsController.initializeComments();
    }
}());
