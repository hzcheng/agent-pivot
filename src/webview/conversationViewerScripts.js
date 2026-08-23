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
    var conversationWorkspaceName = document.querySelector(
        '[data-conversation-workspace-name]'
    );
    var conversationTaskName = document.querySelector(
        '[data-conversation-task-name]'
    );
    var conversationTaskSeparator = document.querySelector(
        '[data-conversation-task-separator]'
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
    var previous = document.querySelector('[data-action="previous"]');
    var next = document.querySelector('[data-action="next"]');
    var latest = document.querySelector('[data-action="latest"]');
    var sidebarToggle = document.querySelector(
        '[data-action="toggle-sidebar"]'
    );
    var sessionStatusRunning = document.querySelector(
        '[data-session-status-running]'
    );
    var sessionStatusRunningCount = document.querySelector(
        '[data-session-status-running-count]'
    );
    var sessionStatusAttention = document.querySelector(
        '[data-session-status-attention]'
    );
    var sessionStatusAttentionCount = document.querySelector(
        '[data-session-status-attention-count]'
    );
    var sessionStatusIdle = document.querySelector(
        '[data-session-status-idle]'
    );
    var sessionStatusIdleCount = document.querySelector(
        '[data-session-status-idle-count]'
    );
    var sessionNavButtons = Array.prototype.slice.call(
        document.querySelectorAll('[data-session-nav]')
    );
    var commentsWorkspace = document.querySelector('.conversation-workspace');
    var commentsResizer = document.querySelector('[data-comments-resizer]');
    var sidebarRoot = document.querySelector('[data-conversation-sidebar]');
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
    var telemetryChanges = document.querySelector(
        '[data-telemetry-changes]'
    );
    var telemetryChangesValue = document.querySelector(
        '[data-telemetry-changes-value]'
    );
    var telemetrySection = document.querySelector(
        '[data-conversation-telemetry]'
    );
    var changesRoot = document.querySelector('[data-conversation-changes]');
    var changesMemberSelect = document.querySelector(
        '[data-changes-member-select]'
    );
    var changesPrev = document.querySelector('[data-changes-prev]');
    var changesNext = document.querySelector('[data-changes-next]');
    var changesPosition = document.querySelector('[data-changes-position]');
    var changesRepoTitle = document.querySelector(
        '[data-changes-repo-title]'
    );
    var changesRepoPicker = document.querySelector(
        '[data-changes-repo-picker]'
    );
    var changesRepoLabel = document.querySelector(
        '[data-changes-repo-label]'
    );
    var changesRepoName = document.querySelector('[data-changes-repo-name]');
    var changesOutside = document.querySelector('[data-changes-outside]');
    var changesBranch = document.querySelector('[data-changes-branch]');
    var changesBranchPrefix = document.querySelector(
        '[data-changes-branch-prefix]'
    );
    var changesBranchTail = document.querySelector(
        '[data-changes-branch-tail]'
    );
    var changesLive = document.querySelector('[data-changes-live]');
    var changesRefresh = document.querySelector('[data-changes-refresh]');
    var changesCrossMember = document.querySelector(
        '[data-changes-cross-member]'
    );
    var changesCrossMemberSummary = document.querySelector(
        '[data-changes-cross-member-summary]'
    );
    var changesCrossMemberGo = document.querySelector(
        '[data-changes-cross-member-go]'
    );
    var changesReview = document.querySelector('[data-changes-review]');
    var changesFoldToggle = document.querySelector(
        '[data-changes-fold-toggle]'
    );
    var changesGroups = document.querySelector('[data-changes-groups]');
    var changesEmpty = document.querySelector('[data-changes-empty]');
    var changesUnavailable = document.querySelector(
        '[data-changes-unavailable]'
    );
    var changesOpenScm = document.querySelector('[data-changes-open-scm]');
    var changesSubtabs = document.querySelector('[data-changes-subtabs]');
    var changesFilesView = document.querySelector(
        '[data-changes-files-view]'
    );
    var changesCommitsView = document.querySelector(
        '[data-changes-commits-view]'
    );
    var changesCommitsNotice = document.querySelector(
        '[data-changes-commits-notice]'
    );
    var changesCommitsList = document.querySelector(
        '[data-changes-commits-list]'
    );
    var changesCommitsEmpty = document.querySelector(
        '[data-changes-commits-empty]'
    );
    var changesCommitsLoading = document.querySelector(
        '[data-changes-commits-loading]'
    );
    var changesCommitsError = document.querySelector(
        '[data-changes-commits-error]'
    );
    var changesCommitsRetry = document.querySelector(
        '[data-changes-commits-retry]'
    );
    var changesCommitsMore = document.querySelector(
        '[data-changes-commits-more]'
    );
    var changesCommitsFull = document.querySelector(
        '[data-changes-commits-full]'
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
    var sessionCommentsTab = document.querySelector(
        '[data-comments-tab="session"]'
    );
    var workspaceCommentsTab = document.querySelector(
        '[data-comments-tab="workspace"]'
    );
    var sessionCommentsPane = document.querySelector(
        '[data-comments-panel="session"]'
    );
    var workspaceCommentsPane = document.querySelector(
        '[data-comments-panel="workspace"]'
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
        && !!outlineRoot
        && !!outlineSearch
        && !!outlineList && !!outlineEmpty && !!outlinePartial
        && !!outlineBookmarksOnly;
    var changesUiAvailable = sidebarUiAvailable
        && !!changesRoot && !!changesMemberSelect && !!changesRefresh
        && !!changesPrev && !!changesNext && !!changesPosition
        && !!changesRepoTitle && !!changesRepoPicker && !!changesRepoLabel
        && !!changesRepoName && !!changesOutside && !!changesBranch
        && !!changesBranchPrefix && !!changesBranchTail && !!changesLive
        && !!changesReview
        && !!changesFoldToggle
        && !!changesGroups && !!changesEmpty
        && !!changesUnavailable && !!changesOpenScm && !!changesCrossMember
        && !!changesCrossMemberSummary && !!changesCrossMemberGo
        && !!telemetryChanges
        && !!changesSubtabs && !!changesFilesView && !!changesCommitsView
        && !!changesCommitsNotice && !!changesCommitsList
        && !!changesCommitsEmpty && !!changesCommitsLoading
        && !!changesCommitsError && !!changesCommitsRetry
        && !!changesCommitsMore && !!changesCommitsFull
        && !!window.__agentPivotConversation.changes
        && validCommentTarget(commentTarget);
    var bookmarkUiAvailable = sidebarUiAvailable
        && validCommentTarget(commentTarget);
    var commentUiAvailable = sidebarUiAvailable
        && !!commentsRoot
        && !!sessionCommentsHeader && !!sessionCommentsContent
        && (!!sessionCommentsTab && !!sessionCommentsPane
            || !!commentsSectionSash && !!sessionCommentsCount)
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
        && !!window.__agentPivotConversation.subagents;
    var projectCommentUiAvailable = commentUiAvailable
        && !!projectCommentsRoot && !!projectCommentsHeader
        && !!projectCommentsContent && !!projectCommentComposer
        && (!!workspaceCommentsTab && !!workspaceCommentsPane
            || !!projectCommentsCount)
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
    // One resync request per subscription generation: a rapid A→B→C
    // switch that misses twice must still escalate the latest miss.
    var resyncRequestedGeneration = 0;
    var conversationLoading = false;
    // Detached conversation frames keyed by session: switching back to a
    // session whose content token is unchanged reattaches the already-built
    // DOM — no HTML transfer, sanitize, parse, or reconcile at all. Bounded
    // by both frame count and a total node budget so large conversations
    // cannot balloon Webview memory.
    var frameCache = new Map();
    var frameCacheNodes = 0;
    var FRAME_CACHE_LIMIT = 4;
    var FRAME_CACHE_NODE_BUDGET = 600;
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
        appliedHtmlSignature: undefined,
    };
    var readingAnchorController =
        window.__agentPivotConversation.readingAnchor.create({
            scroll: scroll,
            messages: messages,
            messageSelector: conversationMessageSelector,
            messageId: conversationMessageId,
        });
    var captureReadingAnchor = readingAnchorController.capture;
    var restoreReadingPosition = readingAnchorController.restore;
    var restoreViewportReadingPosition =
        readingAnchorController.restoreViewport;
    var mermaidRenderer = window.__agentPivotConversation.mermaid.create({
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
    var reconcileController = window.__agentPivotConversation.reconcile.create({
        scroll: scroll,
        messages: messages,
        messageSelector: conversationMessageSelector,
        messageId: conversationMessageId,
        releaseMermaid: function (root) {
            if (root) {
                mermaidRenderer.release(root);
                return;
            }
            // A global release must spare stashed frames: their figures are
            // detached but alive and reattach on restore.
            var stashed = [];
            frameCache.forEach(function (frame) {
                stashed.push.apply(stashed, frame.nodes);
            });
            mermaidRenderer.releaseExcept(stashed);
        },
        preserveMermaid: preserveMermaidContent,
    });
    var outlineController;
    var commentsController;
    var sidebarController = window.__agentPivotConversation.sidebar.create({
        available: sidebarUiAvailable,
        vscodeApi: vscodeApi,
        sidebarToggle: sidebarToggle,
        commentsWorkspace: commentsWorkspace,
        commentsResizer: commentsResizer,
        sidebarRoot: sidebarRoot,
        outlineRoot: outlineRoot,
        commentsRoot: commentsRoot,
        subagentsRoot: subagentsRoot,
        changesRoot: changesRoot,
        outlineQuery: function () {
            return outlineController.query();
        },
        subagentsRunningOnlyQuery: function () {
            return !!subagentsRunningOnly && subagentsRunningOnly.checked;
        },
        telemetryPosition: position,
        telemetryComments: telemetryComments,
        telemetrySubagents: telemetrySubagents,
        telemetryChanges: telemetryChanges,
    });
    var changesController = changesUiAvailable
        ? window.__agentPivotConversation.changes.create({
            post: post,
            target: commentTarget,
            panelRoot: changesRoot,
            telemetryChanges: telemetryChanges,
            telemetryChangesValue: telemetryChangesValue,
            memberSelect: changesMemberSelect,
            prevButton: changesPrev,
            nextButton: changesNext,
            positionIndicator: changesPosition,
            repoTitle: changesRepoTitle,
            repoPicker: changesRepoPicker,
            repoLabel: changesRepoLabel,
            repoName: changesRepoName,
            outsideBadge: changesOutside,
            branchRoot: changesBranch,
            branchPrefix: changesBranchPrefix,
            branchTail: changesBranchTail,
            liveRegion: changesLive,
            refreshButton: changesRefresh,
            crossMemberNote: changesCrossMember,
            crossMemberSummary: changesCrossMemberSummary,
            crossMemberGo: changesCrossMemberGo,
            reviewButton: changesReview,
            foldToggle: changesFoldToggle,
            groupsRoot: changesGroups,
            emptyRoot: changesEmpty,
            unavailableRoot: changesUnavailable,
            openScmButton: changesOpenScm,
            subtabs: changesSubtabs,
            filesView: changesFilesView,
            commitsView: changesCommitsView,
            commitsNotice: changesCommitsNotice,
            commitsList: changesCommitsList,
            commitsEmpty: changesCommitsEmpty,
            commitsLoading: changesCommitsLoading,
            commitsError: changesCommitsError,
            commitsRetry: changesCommitsRetry,
            commitsMore: changesCommitsMore,
            commitsFull: changesCommitsFull,
            getChangesSubTab: sidebarController.getChangesSubTab,
            setChangesSubTab: sidebarController.setChangesSubTab,
            updateToggle: sidebarController.updateToggle,
            subscriptionGeneration: state.subscriptionGeneration,
        })
        : null;
    var outlineController = window.__agentPivotConversation.outline.create({
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
        ? window.__agentPivotConversation.subagents.create({
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
            if (sidebarController.isPanelOpen() && sidebarController.getView() === 'subagents') {
                sidebarController.setView('subagents', false, true);
            } else {
                sidebarController.setView('subagents', true, true);
            }
        });
    }
    if (commentUiAvailable) {
        telemetryComments.addEventListener('click', function () {
            if (sidebarController.isPanelOpen() && sidebarController.getView() === 'comments') {
                sidebarController.setView('comments', false, true);
            } else {
                sidebarController.setView('comments', true, true);
            }
        });
    }
    if (changesUiAvailable) {
        telemetryChanges.addEventListener('click', function () {
            if (sidebarController.isPanelOpen() && sidebarController.getView() === 'changes') {
                sidebarController.setView('changes', false, true);
            } else {
                sidebarController.setView('changes', true, true);
            }
        });
    }
    if (sidebarUiAvailable && position) {
        position.addEventListener('click', function () {
            if (sidebarController.isPanelOpen() && sidebarController.getView() === 'outline') {
                sidebarController.setView('outline', false, true);
            } else {
                sidebarController.setView('outline', true, true);
            }
        });
    }
    var telemetryController = window.__agentPivotConversation.telemetry.create({
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
        scroll: scroll,
        captureAnchor: captureReadingAnchor,
        restoreViewport: restoreViewportReadingPosition,
    });
    var commentsController = window.__agentPivotConversation.comments.create({
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
        sessionCommentsHeader: sessionCommentsHeader,
        sessionCommentsContent: sessionCommentsContent,
        commentsSectionSash: commentsSectionSash,
        projectCommentsCount: projectCommentsCount,
        sessionCommentsCount: sessionCommentsCount,
        sessionCommentsTab: sessionCommentsTab,
        workspaceCommentsTab: workspaceCommentsTab,
        sessionCommentsPane: sessionCommentsPane,
        workspaceCommentsPane: workspaceCommentsPane,
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
    });
    var findController = window.__agentPivotConversation.find
        ? window.__agentPivotConversation.find.create({
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
        allowed.add('workspaceName');
        allowed.add('taskName');
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
                || typeof value.duplicateDisplayName === 'boolean')
            && (value.taskName === undefined
                || (typeof value.taskName === 'string'
                    && value.taskName.length <= 640));
    }

    // The identity line reads project · task · session; the task segment
    // only renders when the session belongs to a worktree task group.
    function applyConversationTaskName(target) {
        var taskName = target && typeof target.taskName === 'string'
            ? target.taskName
            : '';
        if (conversationTaskName) {
            conversationTaskName.textContent = taskName;
            conversationTaskName.hidden = !taskName;
        }
        if (conversationTaskSeparator) {
            conversationTaskSeparator.hidden = !taskName;
        }
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
            'updateKind', 'outline', 'selectedInteractionId', 'selectedInput',
            'totalInputs', 'partial', 'atLatest', 'stale',
        ];
        var allowedKeys = new Set(requiredKeys.concat([
            'html', 'htmlSignature', 'restoreFrame', 'previousCursor',
            'nextCursor', 'subagents', 'activeSubagent', 'displayName',
            'target', 'comments', 'projectComments', 'bookmarks',
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
            && (message.html === undefined
                || typeof message.html === 'string')
            && (message.htmlSignature === undefined
                || typeof message.htmlSignature === 'string')
            && (message.html !== undefined
                || message.htmlSignature !== undefined)
            && (message.restoreFrame === undefined
                || typeof message.restoreFrame === 'boolean')
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

    // A reused panel keeps the outgoing conversation on screen while the
    // incoming session loads. The Host's loading notice arms a lightweight
    // indicator — status text plus a dimmed, aria-busy message list —
    // which the first applied page of the incoming generation clears.
    function applyLoadingNotice(message) {
        if (!message || typeof message !== 'object'
            || message.type !== 'conversation-viewer-loading') {
            return false;
        }
        if (message.version !== 1
            || !Number.isSafeInteger(message.subscriptionGeneration)
            || message.subscriptionGeneration < 1
            || !validCommentTarget({
                projectId: message.target && message.target.projectId,
                provider: message.target && message.target.provider,
                sessionId: message.target && message.target.sessionId,
            })) {
            return true;
        }
        if (message.subscriptionGeneration <= state.subscriptionGeneration
            || (commentTarget
                && message.target.projectId === commentTarget.projectId
                && message.target.provider === commentTarget.provider
                && message.target.sessionId === commentTarget.sessionId)) {
            // Stale or same-session notices never dim the live content.
            return true;
        }
        conversationLoading = true;
        document.body.setAttribute('data-conversation-loading', 'true');
        messages.setAttribute('aria-busy', 'true');
        status.textContent = 'Loading conversation…';
        return true;
    }

    function clearConversationLoading() {
        if (!conversationLoading) {
            return;
        }
        conversationLoading = false;
        document.body.removeAttribute('data-conversation-loading');
        messages.removeAttribute('aria-busy');
        // The applied page recomputes the status line right below.
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
        // The session is really switching: stash the outgoing conversation
        // as a detached frame before any state is reset, so a later switch
        // back can reattach it whole.
        stashCurrentFrame();
        telemetryController.resetSession(
            nextCommentTarget,
            message.subscriptionGeneration
        );
        if (changesController) {
            changesController.resetSession(
                message.subscriptionGeneration,
                nextCommentTarget
            );
        }
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
        state.appliedHtmlSignature = undefined;
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
        if (conversationWorkspaceName
            && typeof message.target.workspaceName === 'string') {
            conversationWorkspaceName.textContent = message.target.workspaceName;
        }
        if (validPageTarget(message.target)) {
            applyConversationTaskName(message.target);
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

    function frameSessionKey(target) {
        if (!target) {
            return null;
        }
        return target.projectId + '\u0001' + target.provider
            + '\u0001' + target.sessionId;
    }

    // Stash the live conversation as a detached frame before a session
    // switch resets the viewer state. Only a fully applied page is
    // stashable; the content token is what makes the frame trustworthy.
    function stashCurrentFrame() {
        if (!state.initialized
            || typeof state.appliedHtmlSignature !== 'string'
            || !commentTarget
            || !messages.firstChild) {
            return;
        }
        var key = frameSessionKey(commentTarget);
        if (!key) {
            return;
        }
        var anchor = captureReadingAnchor();
        var scrollTop = scroll.scrollTop;
        var followingEnd = reconcileController.atEnd();
        var nodes = Array.prototype.slice.call(messages.childNodes);
        // Pending mermaid renders never settle once detached (isConnected
        // guards drop them); resetting lets a restore re-render from source.
        nodes.forEach(function (node) {
            if (!node || node.nodeType !== 1) {
                return;
            }
            Array.prototype.forEach.call(
                node.querySelectorAll('pre[aria-busy="true"]'),
                function (pre) {
                    pre.removeAttribute('aria-busy');
                }
            );
        });
        var existing = frameCache.get(key);
        if (existing) {
            frameCacheNodes -= existing.nodeCount;
            frameCache.delete(key);
        }
        frameCache.set(key, {
            projectId: commentTarget.projectId,
            provider: commentTarget.provider,
            sessionId: commentTarget.sessionId,
            token: state.appliedHtmlSignature,
            nodes: nodes,
            nodeCount: nodes.length,
            messageIds: state.messageIds,
            messageSignatures: state.messageSignatures,
            worklogExpanded: state.worklogExpanded,
            scrollTop: scrollTop,
            anchor: anchor,
            followingEnd: followingEnd,
            selectedInteractionId: restoreTarget
                ? restoreTarget.interactionId
                : undefined,
        });
        frameCacheNodes += nodes.length;
        while ((frameCache.size > FRAME_CACHE_LIMIT
                || frameCacheNodes > FRAME_CACHE_NODE_BUDGET)
            && frameCache.size > 1) {
            var oldestKey = frameCache.keys().next().value;
            if (oldestKey === undefined || oldestKey === key) {
                break;
            }
            var evicted = frameCache.get(oldestKey);
            frameCache.delete(oldestKey);
            if (evicted) {
                frameCacheNodes -= evicted.nodeCount;
                evicted.nodes.forEach(function (node) {
                    if (node && node.nodeType === 1) {
                        mermaidRenderer.release(node);
                    }
                });
            }
        }
    }

    // A frame is restorable only when its content token matches the page's
    // signature — the token equality proves the DOM is byte-identical to
    // what the Host just published. Restoring takes the frame out of the
    // cache: its nodes move back into the live tree.
    function takeRestorableFrame(message) {
        var key = frameSessionKey(message.target);
        if (!key || typeof message.htmlSignature !== 'string') {
            return undefined;
        }
        var frame = frameCache.get(key);
        if (!frame || frame.token !== message.htmlSignature) {
            return undefined;
        }
        frameCacheNodes -= frame.nodeCount;
        frameCache.delete(key);
        return frame;
    }

    function restoreConversationFrame(frame) {
        messages.replaceChildren.apply(messages, frame.nodes);
        state.messageIds = frame.messageIds;
        state.messageSignatures = frame.messageSignatures;
        state.worklogExpanded = frame.worklogExpanded;
    }

    function acknowledgePage(message) {
        // The correlated applied acknowledgement: the Host may omit HTML
        // from a later publication only after this confirms application.
        // The frame inventory keeps the Host's restoreFrame offers truthful
        // about what is actually still cached here.
        if (typeof message.htmlSignature !== 'string') {
            return;
        }
        var frames = [];
        frameCache.forEach(function (frame) {
            frames.push({
                projectId: frame.projectId,
                provider: frame.provider,
                sessionId: frame.sessionId,
                token: frame.token,
            });
        });
        post({
            type: 'conversation-viewer-applied',
            version: 1,
            subscriptionGeneration: message.subscriptionGeneration,
            requestId: message.requestId,
            htmlSignature: message.htmlSignature,
            frames: frames,
        });
    }

    function applyPage(message) {
        if (!validPage(message)
            || !applySessionGeneration(message)
            || message.requestId <= state.latestRequestId) {
            return;
        }
        state.latestRequestId = message.requestId;
        var hasHtml = typeof message.html === 'string';
        // A stashed frame whose token matches this page's signature is
        // byte-identical to what the Host published: restore it whole and
        // skip the sanitize, parse, and reconcile entirely.
        var frame = hasHtml || message.restoreFrame === true
            ? takeRestorableFrame(message)
            : undefined;
        if (!hasHtml && !frame) {
            if (message.restoreFrame === true) {
                // The Host believes this frame is cached but it is not (or
                // its token moved on): request a full resync.
                requestConversationResync();
                return;
            }
            if (message.htmlSignature !== state.appliedHtmlSignature) {
                // A delta that does not match the applied content cannot be
                // applied; request a full resync instead of staying stale.
                requestConversationResync();
                return;
            }
        }
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
        if (frame) {
            restoreConversationFrame(frame);
        } else if (hasHtml) {
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
            state.messageIds = reconciled.ids;
            state.messageSignatures = reconciled.signatures;
        }
        if (typeof message.htmlSignature === 'string') {
            state.appliedHtmlSignature = message.htmlSignature;
        }
        state.atLatest = message.atLatest;
        state.initialized = true;
        clearConversationLoading();
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
        if (conversationWorkspaceName
            && validPageTarget(message.target)
            && typeof message.target.workspaceName === 'string') {
            conversationWorkspaceName.textContent = message.target.workspaceName;
        }
        if (validPageTarget(message.target)) {
            applyConversationTaskName(message.target);
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
            // A frame restore carrying a fresh navigation target behaves
            // like that navigation, not like a return to the stashed
            // reading position.
            var resumeFramePosition = frame
                && message.selectedInteractionId
                    === frame.selectedInteractionId;
            if (resumeFramePosition && frame.followingEnd
                && message.atLatest) {
                reconcileController.scrollToEnd();
            } else if (resumeFramePosition) {
                restoreViewportReadingPosition(
                    frame.anchor,
                    frame.scrollTop
                );
                reconcileController.trackEnd();
            } else if (openingAtLatest) {
                reconcileController.scrollToEnd();
            } else if (selected) {
                centerInMessageViewport(selected);
            }
            if (selected && message.updateKind === 'navigation') {
                selected.tabIndex = -1;
                selected.focus({ preventScroll: true });
            }
            if (!openingAtLatest && !resumeFramePosition) {
                reconcileController.trackEnd();
            }
            acknowledgePage(message);
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
        acknowledgePage(message);
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
                type: 'conversation-viewer-switch-window',
                version: 1,
                direction: button.getAttribute('data-session-nav'),
            });
        });
    });
    [sessionStatusRunning, sessionStatusAttention, sessionStatusIdle]
        .forEach(function (button) {
            if (!button) return;
            button.addEventListener('click', function () {
                post({
                    type: 'conversation-viewer-cycle-status-session',
                    version: 1,
                    kind: button.getAttribute('data-session-status-cycle'),
                });
            });
        });
    // The telemetry provider icon clears the viewed session's attention
    // state; it is actionable only while the Host reports 'attention'.
    function postAcknowledgeAttention() {
        if (!telemetryProvider
            || telemetryProvider.getAttribute('data-session-state')
                !== 'attention') {
            return;
        }
        post({
            type: 'conversation-viewer-acknowledge-attention',
            version: 1,
        });
    }
    if (telemetryProvider) {
        telemetryProvider.addEventListener('click', postAcknowledgeAttention);
        telemetryProvider.addEventListener('keydown', function (event) {
            if (event.key !== 'Enter' && event.key !== ' ') {
                return;
            }
            event.preventDefault();
            postAcknowledgeAttention();
        });
    }
    if (conversationDisplayName) {
        conversationDisplayName.addEventListener('click', function () {
            post({
                type: 'conversation-viewer-rename-session',
                version: 1,
            });
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
    function sessionStatusDotLabel(kind, localCount) {
        if (kind === 'running') {
            return localCount === 0
                ? 'No AI sessions running in this window'
                : localCount + ' running in this window'
                    + ' · click to switch to the next';
        }
        if (kind === 'attention') {
            return localCount === 0
                ? 'No AI sessions need attention in this window'
                : localCount + ' need attention in this window'
                    + ' · click to switch to the next';
        }
        return localCount === 0
            ? 'No idle AI sessions in this window'
            : localCount + ' idle in this window'
                + ' · click to switch to the next';
    }
    function validSessionStatus(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return false;
        }
        var keys = Object.keys(value);
        return (keys.length === 5
                || (keys.length === 6
                    && keys.indexOf('currentSessionKind') !== -1))
            && keys.indexOf('runningSessions') !== -1
            && keys.indexOf('attentionSessions') !== -1
            && keys.indexOf('runningSessionsLocal') !== -1
            && keys.indexOf('attentionSessionsLocal') !== -1
            && keys.indexOf('idleSessionsLocal') !== -1
            && (keys.indexOf('currentSessionKind') === -1
                || value.currentSessionKind === 'running'
                || value.currentSessionKind === 'attention'
                || value.currentSessionKind === 'idle')
            && Number.isSafeInteger(value.runningSessions)
            && value.runningSessions >= 0
            && value.runningSessions <= 100000
            && Number.isSafeInteger(value.attentionSessions)
            && value.attentionSessions >= 0
            && value.attentionSessions <= 100000
            && Number.isSafeInteger(value.runningSessionsLocal)
            && value.runningSessionsLocal >= 0
            && value.runningSessionsLocal <= value.runningSessions
            && Number.isSafeInteger(value.attentionSessionsLocal)
            && value.attentionSessionsLocal >= 0
            && value.attentionSessionsLocal <= value.attentionSessions
            && Number.isSafeInteger(value.idleSessionsLocal)
            && value.idleSessionsLocal >= 0
            && value.idleSessionsLocal <= 100000;
    }
    function applySessionStatusDot(element, countElement, kind, localCount) {
        var label = sessionStatusDotLabel(kind, localCount);
        element.classList.toggle(
            'conversation-session-status-active',
            kind !== 'idle' && localCount > 0
        );
        element.title = label;
        element.setAttribute('aria-label', label);
        element.disabled = localCount === 0;
        countElement.textContent = String(localCount);
    }
    function applySessionStatusMessage(message) {
        if (!message || typeof message !== 'object'
            || message.type !== 'conversation-viewer-session-status'
            || message.version !== 1
            || !Number.isSafeInteger(message.requestId)
            || message.requestId < state.latestStatusRequestId
            || message.subscriptionGeneration !== state.subscriptionGeneration
            || !validSessionStatus(message.status)
            || !sessionStatusRunning || !sessionStatusRunningCount
            || !sessionStatusAttention || !sessionStatusAttentionCount
            || !sessionStatusIdle || !sessionStatusIdleCount) {
            return false;
        }
        state.latestStatusRequestId = message.requestId;
        applySessionStatusDot(
            sessionStatusRunning,
            sessionStatusRunningCount,
            'running',
            message.status.runningSessionsLocal
        );
        applySessionStatusDot(
            sessionStatusAttention,
            sessionStatusAttentionCount,
            'attention',
            message.status.attentionSessionsLocal
        );
        applySessionStatusDot(
            sessionStatusIdle,
            sessionStatusIdleCount,
            'idle',
            message.status.idleSessionsLocal
        );
        // The provider icon in the telemetry bar mirrors the viewed
        // session's lifecycle group; the Host is authoritative, so the
        // icon simply renders whatever kind the message carries.
        telemetryController.setSessionState(message.status.currentSessionKind);
        return true;
    }
    function requestConversationResync(page, applyError) {
        // Correlate the request to the page that failed to apply: the
        // Host rebuilds only while it still owns that generation and
        // session, and ignores requests stranded by a newer switch. One
        // request per generation; the Host bounds rebuilds per
        // publication, so a persistent apply failure cannot reload-loop.
        var generation = state.subscriptionGeneration;
        var target = commentTarget;
        if (page
            && Number.isSafeInteger(page.subscriptionGeneration)
            && page.subscriptionGeneration >= 1
            && validCommentTarget({
                projectId: page.target && page.target.projectId,
                provider: page.target && page.target.provider,
                sessionId: page.target && page.target.sessionId,
            })) {
            generation = page.subscriptionGeneration;
            target = page.target;
        }
        if (!target || !generation
            || resyncRequestedGeneration === generation) {
            return;
        }
        resyncRequestedGeneration = generation;
        // Dropped deltas must not suppress the rebuilt full publication.
        state.appliedHtmlSignature = undefined;
        var message = {
            type: 'conversation-viewer-request-sync',
            version: 1,
            subscriptionGeneration: generation,
            projectId: target.projectId,
            provider: target.provider,
            sessionId: target.sessionId,
        };
        if (applyError) {
            // Sanitized, bounded: the first line of the apply failure tells
            // the Host which page application path keeps failing.
            message.applyError = String(
                applyError && applyError.message || applyError
            ).split('\n')[0].slice(0, 200);
        }
        post(message);
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
        if (changesController && changesController.apply(event.data)) return;
        if (applySessionStatusMessage(event.data)) return;
        if (applyFollowNotice(event.data)) return;
        if (applyLoadingNotice(event.data)) return;
        try {
            applyPage(event.data);
        } catch (_applyError) {
            requestConversationResync(event.data, _applyError);
        }
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
        var parsedInitialPage;
        try {
            parsedInitialPage = JSON.parse(initialPage);
            applyPage(parsedInitialPage);
        } catch (_error) {
            status.textContent = 'Conversation history unavailable.';
            requestConversationResync(parsedInitialPage);
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
        if (changesController) {
            changesController.restoreSubTab();
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
