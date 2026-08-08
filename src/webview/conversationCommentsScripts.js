(function () {
    'use strict';

    function create(options) {
        var commentUiAvailable = options.available;
        var commentTarget = options.target;
        var subscriptionGeneration = options.subscriptionGeneration;
        var status = options.status;
        var messages = options.messages;
        var scroll = options.scroll;
        var addComment = options.addComment;
        var telemetryComments = options.telemetryComments;
        var telemetrySection = options.telemetrySection;
        var commentsRoot = options.commentsRoot;
        var commentCount = options.commentCount;
        var commentComposer = options.commentComposer;
        var commentSelection = options.commentSelection;
        var commentInput = options.commentInput;
        var commentList = options.commentList;
        var commentEmpty = options.commentEmpty;
        var commentFilterEmpty = options.commentFilterEmpty;
        var commentNew = options.commentNew;
        var commentSend = options.commentSend;
        var commentClearDone = options.commentClearDone;
        var commentClearAll = options.commentClearAll;
        var vscodeApi = options.vscodeApi;
        var post = options.post;
        var projectCommentsAvailable = options.projectCommentsAvailable;
        var projectCommentsRoot = options.projectCommentsRoot;
        var projectCommentsHeader = options.projectCommentsHeader;
        var projectCommentsContent = options.projectCommentsContent;
        var sessionCommentsHeader = options.sessionCommentsHeader;
        var sessionCommentsContent = options.sessionCommentsContent;
        var commentsSectionSash = options.commentsSectionSash;
        var sessionCommentsCount = options.sessionCommentsCount;
        var projectCommentsCount = options.projectCommentsCount;
        var commentsBody = commentsRoot
            ? commentsRoot.querySelector('[data-comments-body]')
            : null;
        var projectCommentComposer = options.projectCommentComposer;
        var projectCommentSource = options.projectCommentSource;
        var projectCommentSourceLabel = options.projectCommentSourceLabel;
        var projectCommentSourceQuote = options.projectCommentSourceQuote;
        var projectCommentInput = options.projectCommentInput;
        var projectCommentDraftTags = options.projectCommentDraftTags;
        var projectCommentAddTag = options.projectCommentAddTag;
        var projectCommentAdd = options.projectCommentAdd;
        var projectCommentTagFilter = options.projectCommentTagFilter;
        var projectCommentList = options.projectCommentList;
        var projectCommentEmpty = options.projectCommentEmpty;
        var conversationMessageSelector = options.messageSelector;
        var conversationMessageId = options.messageId;
        var setSidebarView = options.setSidebarView;
        var updateToggle = options.updateToggle;
        var state = {
            comments: [],
            commentRevision: 0,
            commentRequestSequence: 0,
            pendingCommentRequest: null,
            pendingLocateRequest: null,
            clearAllConfirmation: false,
            selectedCommentText: null,
            editingComment: null,
            filter: 'all',
            expandedDoneComments: new Set(),
            draggedCommentId: null,
            projectComments: [],
            projectCommentRevision: 0,
            projectCommentRequestSequence: 0,
            pendingProjectCommentRequest: null,
            projectTagFilter: null,
            projectDraftTags: [],
            projectDraftTagInputOpen: false,
            projectPendingSource: null,
            editingProjectComment: null,
            projectTagEditor: null,
            expandedDoneProjectComments: new Set(),
            projectSectionCollapsed: false,
            sessionSectionCollapsed: false,
            draggedProjectCommentId: null,
            sessionTagEditor: null,
        };

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

        function validComment(value) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                return false;
            }
            var required = [
                'id', 'messageId', 'interactionId', 'role',
                'quote', 'prefix', 'suffix', 'comment', 'status',
            ];
            var allowed = required.concat(
                ['scope', 'createdAt', 'sentAt', 'tags']
            );
            var hasSessionScope = value.scope === 'session';
            return Object.keys(value).every(function (key) {
                return allowed.indexOf(key) >= 0;
            }) && required.every(function (key) {
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
                && (hasSessionScope || value.quote.trim().length > 0)
                && (value.status === 'open' || value.status === 'done')
                && (value.tags === undefined
                    || (Array.isArray(value.tags)
                        && value.tags.length <= 5
                        && value.tags.every(function (tag) {
                            return typeof tag === 'string'
                                && tag.trim().length > 0
                                && Array.from(tag).length <= 24;
                        })))
                && (value.createdAt === undefined
                    || (Number.isSafeInteger(value.createdAt)
                        && value.createdAt >= 0))
                && (value.sentAt === undefined
                    || (Number.isSafeInteger(value.sentAt)
                        && value.sentAt >= 0));
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
                    || value.operation === 'reorder'
                    || value.operation === 'addTag'
                    || value.operation === 'removeTag'
                    || value.operation === 'clearDone'
                    || value.operation === 'clearAll'
                    || value.operation === 'sendComments'
                    || value.operation === 'sendComment')
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
            }, { open: 0, done: 0 });
        }

        function updateSectionCount(element, counts, noun) {
            var total = counts.open + counts.done;
            element.textContent = counts.open + '/' + total;
            var label = counts.open + ' open of ' + total + ' ' + noun;
            element.title = label;
            element.setAttribute('aria-label', label);
        }

        function resetClearAllConfirmation() {
            if (!commentUiAvailable) return;
            state.clearAllConfirmation = false;
            commentClearAll.removeAttribute('data-confirming');
            commentClearAll.title = 'Clear all comments';
            commentClearAll.setAttribute('aria-label', 'Clear all comments');
        }

        function updateCommentControls() {
            if (!commentUiAvailable) return;
            var counts = commentStatusCounts();
            var pending = !!state.pendingCommentRequest
                || !!state.pendingLocateRequest;
            updateSectionCount(sessionCommentsCount, counts, 'comments');
            if (commentCount) {
                commentCount.textContent = String(state.comments.length);
                commentCount.setAttribute(
                    'aria-label',
                    state.comments.length + ' comment'
                        + (state.comments.length === 1 ? '' : 's')
                );
            }
            var sendLabel = 'Send ' + counts.open + ' open comment'
                + (counts.open === 1 ? '' : 's') + ' to the session input';
            commentSend.disabled = counts.open === 0 || pending;
            commentSend.title = sendLabel;
            commentSend.setAttribute('aria-label', sendLabel);
            if (telemetryComments) {
                // The pill doubles as the Comments quick entry; keep it
                // visible even at zero.
                telemetryComments.hidden = false;
                var telemetryCommentValue = telemetryComments.querySelector(
                    '[data-telemetry-comments-value]'
                );
                var visibleCommentCount = state.comments.length > 0
                    ? counts.open + '/' + state.comments.length
                    : '0';
                if (telemetryCommentValue) {
                    telemetryCommentValue.textContent = visibleCommentCount;
                } else {
                    telemetryComments.textContent = visibleCommentCount;
                }
                var telemetryCommentLabel = counts.open
                    + ' open of '
                    + state.comments.length
                    + (state.comments.length === 1 ? ' comment' : ' comments')
                    + ' — click to review';
                telemetryComments.title = telemetryCommentLabel;
                telemetryComments.setAttribute(
                    'aria-label', telemetryCommentLabel
                );
                telemetryComments.setAttribute(
                    'data-tooltip', telemetryCommentLabel
                );
                if (telemetrySection) {
                    telemetrySection.hidden = false;
                }
            }
            commentNew.disabled = pending;
            commentClearDone.disabled = counts.done === 0 || pending;
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
                    if (projectCommentsRoot
                        && projectCommentsRoot.contains(control)) {
                        // The project section has its own pending gate.
                        return;
                    }
                    var card = control.matches
                        && control.matches('[data-comment-drag-handle]')
                        ? control.closest('[data-comment-id]')
                        : null;
                    var editingDragHandle = !!card
                        && !!state.editingComment
                        && card.getAttribute('data-comment-id')
                            === state.editingComment.commentId;
                    control.disabled = pending || editingDragHandle;
                }
            );
            Array.prototype.forEach.call(
                addComment.querySelectorAll('button'),
                function (control) {
                    control.disabled = pending;
                }
            );
            if (!pending) {
                updateCommentControls();
            }
            commentsRoot.setAttribute('aria-busy', pending ? 'true' : 'false');
        }

        function postCommentOperation(operation, payload, focusCommentId) {
            if (!commentUiAvailable
                || state.pendingCommentRequest
                || state.pendingLocateRequest) return;
            var requestId = nextCommentRequestId();
            resetClearAllConfirmation();
            state.pendingCommentRequest = {
                requestId: requestId,
                operation: operation,
                focusCommentId: focusCommentId || null,
            };
            setCommentPending(true);
            status.textContent = operation === 'sendComments'
                ? 'Adding comments to session input…'
                : operation === 'sendComment'
                    ? 'Adding comment to session input…'
                    : operation === 'clearDone'
                        || operation === 'clearAll'
                        ? 'Clearing comments…'
                        : operation === 'reorder'
                            ? 'Saving comment order…'
                        : 'Saving comment…';
            post({
                type: operation === 'sendComments'
                    || operation === 'sendComment'
                    ? 'conversation-viewer-send-comments'
                    : 'conversation-viewer-comment-mutation',
                version: 1,
                requestId: requestId,
                subscriptionGeneration: subscriptionGeneration,
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
            var markdown = message.querySelector('.conversation-markdown');
            var range = markdown && findQuoteRange(markdown, comment);
            var scroll = messages.closest('[data-conversation-scroll]');
            if (range && scroll) {
                var quoteBounds = range.getBoundingClientRect();
                var scrollBounds = scroll.getBoundingClientRect();
                scroll.scrollTop += (quoteBounds.top + quoteBounds.bottom) / 2
                    - (scrollBounds.top + scrollBounds.bottom) / 2;
            } else {
                message.scrollIntoView({ block: 'center' });
            }
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
                subscriptionGeneration: subscriptionGeneration,
                projectId: commentTarget.projectId,
                provider: commentTarget.provider,
                sessionId: commentTarget.sessionId,
                commentId: comment.id,
            });
        }

        var COMMENT_ICON_ATTRS = 'viewBox="0 0 24 24" fill="none" '
            + 'stroke="currentColor" stroke-width="2" '
            + 'stroke-linecap="round" stroke-linejoin="round" '
            + 'aria-hidden="true" focusable="false"';

        function commentIcon(paths) {
            return '<svg ' + COMMENT_ICON_ATTRS + '>' + paths + '</svg>';
        }

        var COMMENT_ICONS = {
            send: commentIcon('<path d="M22 2 11 13"/>'
                + '<path d="M22 2 15 22l-4-9-9-4Z"/>'),
            locate: commentIcon('<circle cx="12" cy="12" r="7"/>'
                + '<path d="M12 2v3"/><path d="M12 19v3"/>'
                + '<path d="M2 12h3"/><path d="M19 12h3"/>'),
            edit: commentIcon('<path d="M17 3a2.85 2.83 0 1 1 4 4'
                + 'L7.5 20.5 2 22l1.5-5.5Z"/>'),
            save: commentIcon('<path d="M20 6 9 17l-5-5"/>'),
            cancel: commentIcon('<path d="M18 6 6 18"/><path d="M6 6l12 12"/>'),
            remove: commentIcon('<path d="M3 6h18"/><path d="M8 6V4h8v2"/>'
                + '<path d="m19 6-1 14H6L5 6"/>'
                + '<path d="M10 11v6"/><path d="M14 11v6"/>'),
            drag: commentIcon('<circle cx="8" cy="7" r="1" fill="currentColor"/>'
                + '<circle cx="16" cy="7" r="1" fill="currentColor"/>'
                + '<circle cx="8" cy="12" r="1" fill="currentColor"/>'
                + '<circle cx="16" cy="12" r="1" fill="currentColor"/>'
                + '<circle cx="8" cy="17" r="1" fill="currentColor"/>'
                + '<circle cx="16" cy="17" r="1" fill="currentColor"/>'),
            chevron: commentIcon('<path d="m6 9 6 6 6-6"/>'),
            marker: commentIcon('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5'
                + 'a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>'),
        };

        function commentIconButton(action, icon, label, modifier) {
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'conversation-comment-icon-button'
                + (modifier ? ' ' + modifier : '');
            button.setAttribute('data-comment-action', action);
            button.title = label;
            button.setAttribute('aria-label', label);
            button.innerHTML = icon;
            return button;
        }

        function autosizeCommentInput(textarea) {
            textarea.style.height = 'auto';
            var chrome = textarea.offsetHeight - textarea.clientHeight;
            textarea.style.height = (textarea.scrollHeight + chrome) + 'px';
        }

        function formatCommentTime(timestamp) {
            if (!Number.isSafeInteger(timestamp) || timestamp < 0) return '';
            var elapsed = Date.now() - timestamp;
            if (elapsed < 60 * 1000) return 'just now';
            if (elapsed < 60 * 60 * 1000) {
                return Math.floor(elapsed / 60000) + 'm ago';
            }
            if (elapsed < 24 * 60 * 60 * 1000) {
                return Math.floor(elapsed / 3600000) + 'h ago';
            }
            return Math.floor(elapsed / 86400000) + 'd ago';
        }

        function readCommentsFilter() {
            if (!vscodeApi || typeof vscodeApi.getState !== 'function') {
                return 'all';
            }
            try {
                var saved = vscodeApi.getState();
                var filter = saved && saved.conversationCommentsFilter;
                return filter === 'open' || filter === 'done'
                    ? filter
                    : 'all';
            } catch (_error) {
                return 'all';
            }
        }

        function saveCommentsFilter() {
            if (!vscodeApi || typeof vscodeApi.setState !== 'function') {
                return;
            }
            try {
                var saved = typeof vscodeApi.getState === 'function'
                    ? vscodeApi.getState()
                    : null;
                var next = saved && typeof saved === 'object'
                    && !Array.isArray(saved)
                    ? Object.assign({}, saved)
                    : {};
                next.conversationCommentsFilter = state.filter;
                vscodeApi.setState(next);
            } catch (_error) {
                // Filter persistence is best-effort local Webview state.
            }
        }

        function updateFilterButtons() {
            Array.prototype.forEach.call(
                commentsRoot.querySelectorAll('[data-comment-filter]'),
                function (button) {
                    button.setAttribute(
                        'aria-pressed',
                        button.getAttribute('data-comment-filter')
                            === state.filter ? 'true' : 'false'
                    );
                }
            );
        }

        function visibleCommentEntries() {
            return state.comments
                .map(function (comment, index) {
                    return { comment: comment, index: index };
                })
                .filter(function (entry) {
                    return state.filter === 'all'
                        || entry.comment.status === state.filter;
                });
        }

        function renderComments() {
            if (!commentUiAvailable) return;
            clearCommentDragState();
            resetClearAllConfirmation();
            commentList.replaceChildren();
            if (state.editingComment) {
                var editingTarget = state.comments.find(function (candidate) {
                    return candidate.id === state.editingComment.commentId;
                });
                if (!editingTarget) {
                    state.editingComment = null;
                }
            }
            var ids = new Set(state.comments.map(function (comment) {
                return comment.id;
            }));
            state.expandedDoneComments.forEach(function (id) {
                if (!ids.has(id)) {
                    state.expandedDoneComments.delete(id);
                }
            });
            updateFilterButtons();
            var entries = visibleCommentEntries();
            entries.forEach(function (entry) {
                var comment = entry.comment;
                var index = entry.index;
                var item = document.createElement('article');
                item.className = 'conversation-comment';
                item.setAttribute('data-comment-id', comment.id);
                item.setAttribute('data-comment-status', comment.status);
                item.setAttribute(
                    'data-comment-scope',
                    comment.scope === 'session' ? 'session' : 'selection'
                );

                var editing = !!state.editingComment
                    && state.editingComment.commentId === comment.id;

                var heading = document.createElement('div');
                heading.className = 'conversation-comment-heading';
                var dragHandle = document.createElement('button');
                dragHandle.type = 'button';
                dragHandle.className = 'conversation-comment-drag-handle';
                dragHandle.setAttribute('data-comment-drag-handle', '');
                dragHandle.setAttribute(
                    'aria-label',
                    'Move comment ' + (index + 1)
                );
                dragHandle.setAttribute(
                    'aria-keyshortcuts',
                    'Alt+ArrowUp Alt+ArrowDown'
                );
                dragHandle.title = 'Drag to reorder · Alt+Up/Down';
                dragHandle.innerHTML = COMMENT_ICONS.drag;
                dragHandle.draggable = !editing;
                dragHandle.disabled = editing;
                heading.appendChild(dragHandle);
                var actions = document.createElement('div');
                actions.className = 'conversation-comment-actions';
                heading.appendChild(actions);
                item.appendChild(heading);

                if (editing) {
                    actions.appendChild(commentIconButton(
                        'update',
                        COMMENT_ICONS.save,
                        'Save comment (Ctrl+Enter or Cmd+Enter)'
                    ));
                    actions.appendChild(commentIconButton(
                        'cancel-edit',
                        COMMENT_ICONS.cancel,
                        'Discard changes (Esc)'
                    ));
                    var input = document.createElement('textarea');
                    input.rows = 1;
                    input.maxLength = 4000;
                    input.value = state.editingComment.draft;
                    input.setAttribute('aria-label', 'Comment ' + (index + 1));
                    input.setAttribute(
                        'aria-keyshortcuts',
                        'Control+Enter Meta+Enter'
                    );
                    input.setAttribute('data-comment-edit', '');
                    var hint = document.createElement('div');
                    hint.className = 'conversation-comment-edit-hint';
                    hint.textContent = 'Ctrl+Enter to save · Esc to cancel';
                    item.append(input, hint);
                    item.appendChild(
                        buildSessionCommentTagsRow(comment, index)
                    );
                    commentList.appendChild(item);
                    autosizeCommentInput(input);
                    input.focus();
                    input.setSelectionRange(
                        input.value.length,
                        input.value.length
                    );
                    return;
                }

                var expanded = comment.status !== 'done'
                    || state.expandedDoneComments.has(comment.id);
                if (comment.status === 'done' && !expanded) {
                    item.classList.add('conversation-comment-done-collapsed');
                    var expand = commentIconButton(
                        'toggle-done',
                        COMMENT_ICONS.chevron,
                        'Expand comment'
                    );
                    expand.setAttribute('aria-expanded', 'false');
                    actions.appendChild(expand);
                    var collapsedBody = document.createElement('div');
                    collapsedBody.className =
                        'conversation-comment-collapsed-body';
                    collapsedBody.setAttribute(
                        'data-comment-action',
                        'toggle-done'
                    );
                    collapsedBody.textContent = comment.comment;
                    item.appendChild(collapsedBody);
                    item.appendChild(
                        buildSessionCommentTagsRow(comment, index)
                    );
                    commentList.appendChild(item);
                    return;
                }

                if (comment.status === 'done') {
                    var collapse = commentIconButton(
                        'toggle-done',
                        COMMENT_ICONS.chevron,
                        'Collapse comment'
                    );
                    collapse.setAttribute('aria-expanded', 'true');
                    actions.appendChild(collapse);
                }
                if (comment.status === 'open') {
                    actions.appendChild(commentIconButton(
                        'send-comment',
                        COMMENT_ICONS.send,
                        'Send this comment to the session'
                    ));
                }
                if (comment.scope !== 'session') {
                    actions.appendChild(commentIconButton(
                        'locate',
                        COMMENT_ICONS.locate,
                        'Show commented text'
                    ));
                }
                actions.appendChild(commentIconButton(
                    'edit-comment',
                    COMMENT_ICONS.edit,
                    'Edit comment'
                ));
                actions.appendChild(commentIconButton(
                    'delete',
                    COMMENT_ICONS.remove,
                    'Delete comment',
                    'danger'
                ));

                var body = document.createElement('div');
                body.className = 'conversation-comment-body';
                body.textContent = comment.comment;
                item.appendChild(body);
                if (comment.scope !== 'session') {
                    var quoteGroup = document.createElement('div');
                    quoteGroup.className = 'conversation-comment-quote';
                    var quoteLabel = document.createElement('span');
                    quoteLabel.className = 'conversation-comment-quote-label';
                    quoteLabel.textContent = 'Selected text';
                    var quote = document.createElement('blockquote');
                    quote.textContent = comment.quote;
                    quoteGroup.append(quoteLabel, quote);
                    item.appendChild(quoteGroup);
                }
                var meta = document.createElement('div');
                meta.className = 'conversation-comment-meta';
                var metaLabel = document.createElement('span');
                metaLabel.textContent = '#' + (index + 1);
                meta.appendChild(metaLabel);
                if (comment.scope === 'session') {
                    var scope = document.createElement('span');
                    scope.className = 'conversation-comment-scope';
                    scope.textContent = 'Session note';
                    meta.appendChild(scope);
                }
                var timeText = comment.status === 'done'
                    && typeof comment.sentAt === 'number'
                    ? 'sent ' + formatCommentTime(comment.sentAt)
                    : formatCommentTime(comment.createdAt);
                if (timeText) {
                    var time = document.createElement('span');
                    time.className = 'conversation-comment-time';
                    time.textContent = timeText;
                    meta.appendChild(time);
                }
                item.appendChild(meta);
                item.appendChild(
                    buildSessionCommentTagsRow(comment, index)
                );
                commentList.appendChild(item);
            });
            updateToggle();
            commentEmpty.hidden = state.comments.length > 0;
            if (state.sessionTagEditor) {
                var sessionTagInput = commentList.querySelector(
                    '[data-comment-tag-input]'
                );
                if (sessionTagInput) {
                    sessionTagInput.focus();
                    sessionTagInput.setSelectionRange(
                        sessionTagInput.value.length,
                        sessionTagInput.value.length
                    );
                }
            }
            if (commentFilterEmpty) {
                var filteredOut = state.comments.length > 0
                    && entries.length === 0;
                commentFilterEmpty.hidden = !filteredOut;
                commentFilterEmpty.textContent = filteredOut
                    ? state.filter === 'open'
                        ? 'No open comments.'
                        : 'No done comments.'
                    : '';
            }
            updateCommentControls();
            updateCommentHighlights();
            if (state.pendingCommentRequest || state.pendingLocateRequest) {
                // Any re-render during an in-flight request must keep the
                // disabled pending state instead of reviving controls.
                setCommentPending(true);
            }
        }

        function clearCommentDragState() {
            state.draggedCommentId = null;
            Array.prototype.forEach.call(
                commentList.querySelectorAll(
                    '.conversation-comment-dragging, [data-comment-drop-position]'
                ),
                function (card) {
                    card.classList.remove('conversation-comment-dragging');
                    card.removeAttribute('data-comment-drop-position');
                }
            );
        }

        function reorderedCommentIds(sourceId, targetId, placement) {
            var visibleIds = visibleCommentEntries().map(function (entry) {
                return entry.comment.id;
            });
            var sourceIndex = visibleIds.indexOf(sourceId);
            if (sourceIndex < 0 || sourceId === targetId) return null;
            visibleIds.splice(sourceIndex, 1);
            var targetIndex = visibleIds.indexOf(targetId);
            if (targetIndex < 0) return null;
            visibleIds.splice(
                targetIndex + (placement === 'after' ? 1 : 0),
                0,
                sourceId
            );
            var originalVisibleIds = visibleCommentEntries().map(
                function (entry) {
                    return entry.comment.id;
                }
            );
            var unchanged = visibleIds.every(function (id, index) {
                return id === originalVisibleIds[index];
            });
            if (unchanged) return null;
            var visibleSet = new Set(originalVisibleIds);
            var visibleIndex = 0;
            return state.comments.map(function (comment) {
                if (!visibleSet.has(comment.id)) return comment.id;
                var reorderedId = visibleIds[visibleIndex];
                visibleIndex += 1;
                return reorderedId;
            });
        }

        function postCommentReorder(sourceId, targetId, placement) {
            var orderedCommentIds = reorderedCommentIds(
                sourceId,
                targetId,
                placement
            );
            clearCommentDragState();
            if (!orderedCommentIds) return false;
            postCommentOperation(
                'reorder',
                { orderedCommentIds: orderedCommentIds },
                sourceId
            );
            return true;
        }

        function focusCommentDragHandle(commentId) {
            if (!commentId) return;
            var card = commentList.querySelector(
                '[data-comment-id="' + CSS.escape(commentId) + '"]'
            );
            var handle = card && card.querySelector(
                '[data-comment-drag-handle]'
            );
            if (handle && !handle.disabled) {
                handle.focus({ preventScroll: true });
            }
        }

        function revealCommentCard(commentId) {
            var comment = state.comments.find(function (candidate) {
                return candidate.id === commentId;
            });
            if (!comment) return false;
            var needsRender = false;
            if (comment.status === 'done'
                && !state.expandedDoneComments.has(commentId)) {
                state.expandedDoneComments.add(commentId);
                needsRender = true;
            }
            if (state.filter !== 'all' && comment.status !== state.filter) {
                state.filter = 'all';
                saveCommentsFilter();
                needsRender = true;
            }
            if (needsRender) {
                renderComments();
            }
            setSidebarView('comments', true, true);
            var card = commentList.querySelector(
                '[data-comment-id="' + CSS.escape(commentId) + '"]'
            );
            if (!card) return false;
            card.scrollIntoView({ block: 'center' });
            card.classList.add('conversation-comment-flash');
            window.setTimeout(function () {
                card.classList.remove('conversation-comment-flash');
            }, 1600);
            return true;
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
                return offset >= comment.prefix.length
                    && combined.startsWith(
                        comment.prefix,
                        offset - comment.prefix.length
                    )
                    && combined.startsWith(
                        comment.suffix,
                        offset + comment.quote.length
                    );
            });
            if (start === undefined) {
                var relaxedPrefix = comment.prefix.trimEnd();
                var relaxedSuffix = comment.suffix.trimStart();
                start = candidates.find(function (offset) {
                    var beforeEnd = offset;
                    while (beforeEnd > 0
                        && /\s/.test(combined.charAt(beforeEnd - 1))) {
                        beforeEnd -= 1;
                    }
                    var afterStart = offset + comment.quote.length;
                    while (afterStart < combined.length
                        && /\s/.test(combined.charAt(afterStart))) {
                        afterStart += 1;
                    }
                    return beforeEnd >= relaxedPrefix.length
                        && combined.startsWith(
                            relaxedPrefix,
                            beforeEnd - relaxedPrefix.length
                        )
                        && combined.startsWith(relaxedSuffix, afterStart);
                });
            }
            var end;
            if (start !== undefined) {
                end = start + comment.quote.length;
            } else {
                var compactChars = [];
                var compactOffsets = [];
                for (var index = 0; index < combined.length; index += 1) {
                    if (/\s/.test(combined.charAt(index))) continue;
                    compactOffsets.push(index);
                    compactChars.push(combined.charAt(index));
                }
                var compacted = compactChars.join('');
                var compactQuote = comment.quote.replace(/\s/g, '');
                if (!compactQuote) return null;
                var compactPrefix = comment.prefix.replace(/\s/g, '');
                var compactSuffix = comment.suffix.replace(/\s/g, '');
                var compactCandidate = compacted.indexOf(compactQuote);
                var firstCompactCandidate = compactCandidate >= 0
                    ? compactCandidate
                    : undefined;
                var compactStart;
                while (compactCandidate >= 0) {
                    if (compactCandidate >= compactPrefix.length
                        && compacted.startsWith(
                            compactPrefix,
                            compactCandidate - compactPrefix.length
                        )
                        && compacted.startsWith(
                            compactSuffix,
                            compactCandidate + compactQuote.length
                        )) {
                        compactStart = compactCandidate;
                        break;
                    }
                    compactCandidate = compacted.indexOf(
                        compactQuote,
                        compactCandidate + 1
                    );
                }
                if (compactStart === undefined) {
                    compactStart = firstCompactCandidate;
                }
                if (compactStart !== undefined) {
                    start = compactOffsets[compactStart];
                    end = compactOffsets[
                        compactStart + compactQuote.length - 1
                    ] + 1;
                }
            }
            if (start === undefined) start = candidates[0];
            if (start === undefined) return null;
            if (end === undefined) end = start + comment.quote.length;
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
            Array.prototype.forEach.call(
                messages.querySelectorAll('.conversation-comment-marker'),
                function (marker) {
                    marker.remove();
                }
            );
            var commentsByMessage = new Map();
            state.comments.forEach(function (comment) {
                if (comment.scope === 'session') return;
                var bucket = commentsByMessage.get(comment.messageId);
                if (!bucket) {
                    bucket = [];
                    commentsByMessage.set(comment.messageId, bucket);
                }
                bucket.push(comment);
            });
            var ranges = [];
            commentsByMessage.forEach(function (bucket, messageId) {
                var message = Array.prototype.find.call(
                    messages.querySelectorAll(conversationMessageSelector()),
                    function (candidate) {
                        return conversationMessageId(candidate) === messageId;
                    }
                );
                if (!message) return;
                var openOnMessage = bucket.filter(function (comment) {
                    return comment.status === 'open';
                });
                if (openOnMessage.length) {
                    message.classList.add('conversation-has-comment');
                }
                openOnMessage.forEach(function (comment) {
                    var markdown = message.querySelector(
                        '.conversation-markdown'
                    );
                    var range = markdown && findQuoteRange(markdown, comment);
                    if (range) ranges.push(range);
                });
                var label = bucket.length
                    + (bucket.length === 1 ? ' comment' : ' comments')
                    + ' — click to review';
                var marker = document.createElement('button');
                marker.type = 'button';
                marker.className = 'conversation-comment-marker';
                marker.setAttribute('data-comment-marker', messageId);
                marker.title = label;
                marker.setAttribute('aria-label', label);
                marker.innerHTML = COMMENT_ICONS.marker
                    + '<span class="conversation-comment-marker-count">'
                    + bucket.length + '</span>';
                message.appendChild(marker);
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
                || message.subscriptionGeneration !== subscriptionGeneration
                || message.projectId !== commentTarget.projectId
                || message.provider !== commentTarget.provider
                || message.sessionId !== commentTarget.sessionId
                || !state.pendingCommentRequest
                || message.requestId !== state.pendingCommentRequest.requestId
                || message.operation !== state.pendingCommentRequest.operation) {
                return false;
            }
            var operation = state.pendingCommentRequest.operation;
            var focusCommentId = state.pendingCommentRequest.focusCommentId;
            if (message.success
                && (operation === 'sendComment'
                    || operation === 'sendComments')) {
                // Keep freshly sent cards expanded once so a card does not
                // appear to vanish right after sending.
                var previouslyOpen = new Set();
                state.comments.forEach(function (comment) {
                    if (comment.status === 'open') {
                        previouslyOpen.add(comment.id);
                    }
                });
                message.comments.forEach(function (comment) {
                    if (comment.status === 'done'
                        && previouslyOpen.has(comment.id)) {
                        state.expandedDoneComments.add(comment.id);
                    }
                });
            }
            state.commentRevision = message.revision;
            state.comments = message.comments.map(function (comment) {
                return Object.assign({}, comment);
            });
            if (message.success && message.operation === 'update') {
                state.editingComment = null;
            }
            renderComments();
            state.pendingCommentRequest = null;
            setCommentPending(false);
            if (message.success) {
                status.textContent = operation === 'sendComments'
                    ? 'Comments added to session input. Review and press Enter to send.'
                    : operation === 'sendComment'
                        ? 'Comment added to session input. Review and press Enter to send.'
                        : operation === 'clearDone'
                            ? 'Sent comments cleared.'
                            : operation === 'clearAll'
                                ? 'All comments cleared.'
                                : operation === 'reorder'
                                    ? 'Comment order saved.'
                                : 'Comments saved.';
            } else {
                status.textContent = commentErrorMessage(message.error);
            }
            focusCommentDragHandle(focusCommentId);
            return true;
        }

        function applyLocateResult(message) {
            if (!commentUiAvailable
                || !validLocateResult(message)
                || message.subscriptionGeneration !== subscriptionGeneration
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
            var selectedText = selection.toString();
            var quote = selectedText.trim();
            if (!startMessage || startMessage !== endMessage || !markdown
                || !messages.contains(startMessage) || !quote
                || Array.from(quote).length > 4000) {
                addComment.hidden = true;
                state.selectedCommentText = null;
                return;
            }
            var context = selectionContext(range, markdown);
            var quoteStart = selectedText.indexOf(quote);
            var quoteEnd = quoteStart + quote.length;
            context.prefix = (context.prefix
                + selectedText.slice(0, quoteStart)).slice(-240);
            context.suffix = (selectedText.slice(quoteEnd)
                + context.suffix).slice(0, 240);
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
                Math.min(window.innerWidth - 64, rect.left)
            ) + 'px';
            addComment.style.top = Math.max(8, rect.bottom + 6) + 'px';
            addComment.hidden = false;
        }

        function sendSelectionToTerminal() {
            if (!state.selectedCommentText || state.pendingCommentRequest) {
                return;
            }
            var quote = state.selectedCommentText.quote;
            addComment.hidden = true;
            state.selectedCommentText = null;
            var selection = window.getSelection();
            if (selection) {
                selection.removeAllRanges();
            }
            post({
                type: 'conversation-viewer-send-selection',
                version: 1,
                text: quote,
            });
            status.textContent = 'Selection sent to the active terminal.';
        }

        function openCommentComposer() {
            if (!state.selectedCommentText) return;
            setSidebarView('comments', true, true);
            expandSessionSection();
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
            expandSessionSection();
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

        var PROJECT_TAG_COLOR_COUNT = 6;
        var PROJECT_COMMENT_OPERATIONS = [
            'add', 'update', 'delete', 'setStatus', 'addTag', 'removeTag',
            'reorder',
        ];

        function providerLabel(provider) {
            if (provider === 'kimi') return 'Kimi';
            if (provider === 'claude') return 'Claude';
            return 'Codex';
        }

        function buildCommentStatusChip(status, toggleAction) {
            var chip = document.createElement(
                toggleAction ? 'button' : 'span'
            );
            chip.className = 'conversation-comment-status-chip';
            chip.setAttribute('data-comment-status-chip', status);
            chip.textContent = status === 'open' ? 'Open' : 'Done';
            if (toggleAction) {
                chip.type = 'button';
                chip.setAttribute(
                    'data-project-comment-action',
                    toggleAction
                );
                chip.title = status === 'open' ? 'Mark done' : 'Reopen';
                chip.setAttribute('aria-label', chip.title);
            }
            return chip;
        }

        function buildSessionCommentTagsRow(comment, index) {
            var row = document.createElement('div');
            row.className = 'conversation-comment-tags-row';
            row.appendChild(buildCommentStatusChip(comment.status, null));
            var tags = comment.tags || [];
            tags.forEach(function (tag) {
                var chip = document.createElement('span');
                chip.className = 'conversation-project-comment-tag';
                chip.setAttribute(
                    'data-tag-color',
                    String(projectTagColorKey(tag))
                );
                chip.appendChild(document.createTextNode(tag));
                var remove = document.createElement('button');
                remove.type = 'button';
                remove.setAttribute('data-comment-action', 'remove-tag');
                remove.setAttribute('data-tag', tag);
                remove.title = 'Remove tag ' + tag;
                remove.setAttribute('aria-label', 'Remove tag ' + tag);
                remove.textContent = '\u00d7';
                chip.appendChild(remove);
                row.appendChild(chip);
            });
            if (state.sessionTagEditor
                && state.sessionTagEditor.commentId === comment.id) {
                var tagInput = document.createElement('input');
                tagInput.type = 'text';
                tagInput.maxLength = 48;
                tagInput.className = 'conversation-project-comment-tag-input';
                tagInput.setAttribute('data-comment-tag-input', '');
                tagInput.setAttribute('aria-label', 'New tag');
                tagInput.placeholder = 'tag';
                tagInput.value = state.sessionTagEditor.draft;
                row.appendChild(tagInput);
            } else if (tags.length < 5) {
                var addTag = document.createElement('button');
                addTag.type = 'button';
                addTag.className = 'conversation-project-comment-tag-add';
                addTag.setAttribute('data-comment-action', 'open-tag-editor');
                addTag.title = 'Add tag';
                addTag.setAttribute('aria-label', 'Add tag');
                addTag.textContent = '+';
                row.appendChild(addTag);
            }
            return row;
        }

        function validProjectCommentSource(value) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                return false;
            }
            var keys = Object.keys(value);
            return (keys.length === 2 || keys.length === 3)
                && (value.provider === 'codex' || value.provider === 'kimi'
                    || value.provider === 'claude')
                && typeof value.sessionId === 'string'
                && value.sessionId.length > 0
                && (keys.length === 2 || (typeof value.quote === 'string'
                    && value.quote.trim().length > 0));
        }

        function validProjectCommentDispatch(value) {
            return value && typeof value === 'object' && !Array.isArray(value)
                && Object.keys(value).length === 3
                && (value.provider === 'codex' || value.provider === 'kimi'
                    || value.provider === 'claude')
                && typeof value.sessionId === 'string'
                && value.sessionId.length > 0
                && Number.isSafeInteger(value.at) && value.at >= 0;
        }

        function validProjectComment(value) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) {
                return false;
            }
            var required = [
                'id', 'text', 'tags', 'status', 'createdAt', 'dispatches',
            ];
            var allowed = required.concat(['updatedAt', 'doneAt', 'source']);
            return Object.keys(value).every(function (key) {
                return allowed.indexOf(key) >= 0;
            }) && required.every(function (key) {
                return Object.prototype.hasOwnProperty.call(value, key);
            })
                && typeof value.id === 'string' && value.id.length > 0
                && typeof value.text === 'string'
                && value.text.trim().length > 0
                && Array.isArray(value.tags) && value.tags.length <= 5
                && value.tags.every(function (tag) {
                    return typeof tag === 'string' && tag.trim().length > 0
                        && Array.from(tag).length <= 24;
                })
                && (value.status === 'open' || value.status === 'done')
                && Number.isSafeInteger(value.createdAt)
                && value.createdAt >= 0
                && (value.updatedAt === undefined
                    || (Number.isSafeInteger(value.updatedAt)
                        && value.updatedAt >= 0))
                && (value.doneAt === undefined
                    || (Number.isSafeInteger(value.doneAt)
                        && value.doneAt >= 0))
                && (value.source === undefined
                    || validProjectCommentSource(value.source))
                && Array.isArray(value.dispatches)
                && value.dispatches.length <= 20
                && value.dispatches.every(validProjectCommentDispatch);
        }

        function validInitialProjectComments(value) {
            return value && typeof value === 'object' && !Array.isArray(value)
                && Object.keys(value).length === 2
                && Number.isSafeInteger(value.revision)
                && value.revision >= 0
                && Array.isArray(value.comments)
                && value.comments.length <= 50
                && value.comments.every(validProjectComment);
        }

        function validProjectCommentsResult(value) {
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
                && value.type === 'conversation-viewer-project-comments-result'
                && value.version === 1
                && typeof value.requestId === 'string'
                && Number.isSafeInteger(value.subscriptionGeneration)
                && typeof value.projectId === 'string'
                && (value.provider === 'codex'
                    || value.provider === 'kimi'
                    || value.provider === 'claude')
                && typeof value.sessionId === 'string'
                && (PROJECT_COMMENT_OPERATIONS.indexOf(value.operation) >= 0
                    || value.operation === 'sendProjectComment')
                && typeof value.success === 'boolean'
                && Number.isSafeInteger(value.revision)
                && value.revision >= 0
                && Array.isArray(value.comments)
                && value.comments.length <= 50
                && value.comments.every(validProjectComment)
                && (value.error === undefined || [
                    'invalid', 'stale', 'limit', 'tooLarge',
                    'unavailable', 'busy', 'conflict', 'failed',
                ].includes(value.error));
        }

        function cloneProjectComment(comment) {
            return Object.assign({}, comment, {
                tags: comment.tags.slice(),
                dispatches: comment.dispatches.map(function (dispatch) {
                    return Object.assign({}, dispatch);
                }),
            });
        }

        function orderedProjectComments() {
            // The array order is the display order: new notes land on top,
            // manual reordering is persisted by the Host.
            return state.projectComments.slice();
        }

        function projectTagMatches(tag, filter) {
            return tag.toLowerCase() === filter;
        }

        function projectCommentHasTag(comment, filter) {
            return comment.tags.some(function (tag) {
                return projectTagMatches(tag, filter);
            });
        }

        function projectCommentFilterEquals(a, b) {
            if (a === null || b === null) {
                return a === b;
            }
            return a.type === b.type && a.value === b.value;
        }

        function visibleProjectComments() {
            var ordered = orderedProjectComments();
            var filter = state.projectTagFilter;
            if (!filter) return ordered;
            return ordered.filter(function (comment) {
                if (filter.type === 'status') {
                    return comment.status === filter.value;
                }
                return projectCommentHasTag(comment, filter.value);
            });
        }

        function projectTagColorKey(tag) {
            var hash = 0;
            var text = tag.toLowerCase();
            for (var index = 0; index < text.length; index += 1) {
                hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
            }
            return hash % PROJECT_TAG_COLOR_COUNT;
        }

        function normalizeProjectTag(value) {
            return typeof value === 'string'
                ? value.replace(/\s+/g, ' ').trim()
                : '';
        }

        function validProjectTag(tag) {
            return tag.length > 0
                && Array.from(tag).length <= 24
                && !/[\u0000-\u001f\u007f]/.test(tag);
        }

        function readProjectTagFilter() {
            if (!vscodeApi || typeof vscodeApi.getState !== 'function') {
                return null;
            }
            try {
                var saved = vscodeApi.getState();
                var filter = saved
                    && saved.conversationProjectCommentsTagFilter;
                if (!filter || typeof filter !== 'object'
                    || Array.isArray(filter)) {
                    return null;
                }
                if (filter.type === 'status'
                    && (filter.value === 'open'
                        || filter.value === 'done')) {
                    return { type: 'status', value: filter.value };
                }
                if (filter.type === 'tag'
                    && typeof filter.value === 'string'
                    && filter.value) {
                    return { type: 'tag', value: filter.value };
                }
                return null;
            } catch (_error) {
                return null;
            }
        }

        function saveProjectTagFilter() {
            if (!vscodeApi || typeof vscodeApi.setState !== 'function') {
                return;
            }
            try {
                var saved = typeof vscodeApi.getState === 'function'
                    ? vscodeApi.getState()
                    : null;
                var next = saved && typeof saved === 'object'
                    && !Array.isArray(saved)
                    ? Object.assign({}, saved)
                    : {};
                next.conversationProjectCommentsTagFilter
                    = state.projectTagFilter;
                vscodeApi.setState(next);
            } catch (_error) {
                // Filter persistence is best-effort local Webview state.
            }
        }

        function nextProjectCommentRequestId() {
            state.projectCommentRequestSequence += 1;
            return [
                'project-comment',
                Date.now().toString(36),
                state.projectCommentRequestSequence.toString(36),
            ].join(':');
        }

        function projectCommentErrorMessage(error) {
            if (error === 'stale') return 'Project notes changed. Review the latest notes and try again.';
            if (error === 'limit') return 'The project note limit was reached (50 notes, 5 tags per note, or 20 distinct tags).';
            if (error === 'tooLarge') return 'The project note is too large to send.';
            if (error === 'busy') return 'Wait for the current AI response to finish, then send again.';
            if (error === 'conflict') return 'Multiple runtimes match this session. Resolve the conflict first.';
            if (error === 'unavailable') return 'This session is unavailable and the note was not added.';
            return 'The project note action failed. Your notes were kept.';
        }

        function setProjectCommentPending(pending) {
            if (!projectCommentsAvailable) return;
            Array.prototype.forEach.call(
                projectCommentsRoot.querySelectorAll('button, textarea, input'),
                function (control) {
                    control.disabled = pending;
                }
            );
            if (!pending) {
                updateProjectComposerControls();
            }
            projectCommentsRoot.setAttribute(
                'aria-busy',
                pending ? 'true' : 'false'
            );
        }

        function updateProjectComposerControls() {
            if (!projectCommentsAvailable) return;
            var pending = !!state.pendingProjectCommentRequest;
            var text = projectCommentInput.value.trim();
            projectCommentAdd.disabled = pending || !text;
            projectCommentAddTag.disabled = pending
                || state.projectDraftTags.length >= 5;
        }

        function renderProjectDraftTags() {
            if (!projectCommentsAvailable) return;
            projectCommentDraftTags.replaceChildren();
            state.projectDraftTags.forEach(function (tag) {
                var chip = document.createElement('span');
                chip.className = 'conversation-project-comment-tag';
                chip.setAttribute(
                    'data-tag-color',
                    String(projectTagColorKey(tag))
                );
                chip.appendChild(document.createTextNode(tag));
                var remove = document.createElement('button');
                remove.type = 'button';
                remove.setAttribute('data-project-comment-action', 'remove-draft-tag');
                remove.setAttribute('data-tag', tag);
                remove.title = 'Remove tag ' + tag;
                remove.setAttribute('aria-label', 'Remove tag ' + tag);
                remove.textContent = '\u00d7';
                chip.appendChild(remove);
                projectCommentDraftTags.appendChild(chip);
            });
            if (state.projectDraftTagInputOpen) {
                var input = document.createElement('input');
                input.type = 'text';
                input.maxLength = 48;
                input.className = 'conversation-project-comment-tag-input';
                input.setAttribute('data-project-comment-draft-tag-input', '');
                input.setAttribute('aria-label', 'New tag');
                input.placeholder = 'tag';
                projectCommentDraftTags.appendChild(input);
                input.focus();
            }
            updateProjectComposerControls();
        }

        function closeProjectDraftTagInput() {
            if (!state.projectDraftTagInputOpen) return;
            state.projectDraftTagInputOpen = false;
            renderProjectDraftTags();
        }

        function commitProjectDraftTag(value) {
            var tag = normalizeProjectTag(value);
            state.projectDraftTagInputOpen = false;
            if (tag && validProjectTag(tag)) {
                var exists = state.projectDraftTags.some(function (candidate) {
                    return candidate.toLowerCase() === tag.toLowerCase();
                });
                if (!exists && state.projectDraftTags.length < 5) {
                    state.projectDraftTags.push(tag);
                }
            }
            renderProjectDraftTags();
        }

        function updateProjectSourcePreview() {
            if (!projectCommentsAvailable) return;
            var source = state.projectPendingSource;
            projectCommentSource.hidden = !source;
            if (!source) {
                projectCommentSourceQuote.textContent = '';
                return;
            }
            projectCommentSourceLabel.textContent = 'From '
                + providerLabel(source.provider) + ' session';
            projectCommentSourceQuote.textContent = source.quote || '';
        }

        function resetProjectComposer() {
            if (!projectCommentsAvailable) return;
            projectCommentInput.value = '';
            projectCommentInput.style.height = '';
            state.projectDraftTags = [];
            state.projectDraftTagInputOpen = false;
            state.projectPendingSource = null;
            renderProjectDraftTags();
            updateProjectSourcePreview();
            updateProjectComposerControls();
        }

        function readCommentSectionState() {
            if (!vscodeApi || typeof vscodeApi.getState !== 'function') {
                return;
            }
            try {
                var saved = vscodeApi.getState();
                var sections = saved && saved.conversationCommentsSections;
                if (sections && typeof sections === 'object'
                    && !Array.isArray(sections)) {
                    state.projectSectionCollapsed
                        = sections.project === true;
                    state.sessionSectionCollapsed
                        = sections.session === true;
                }
            } catch (_error) {
                // Section state persistence is best-effort.
            }
        }

        function saveCommentSectionState() {
            if (!vscodeApi || typeof vscodeApi.setState !== 'function') {
                return;
            }
            try {
                var saved = typeof vscodeApi.getState === 'function'
                    ? vscodeApi.getState()
                    : null;
                var next = saved && typeof saved === 'object'
                    && !Array.isArray(saved)
                    ? Object.assign({}, saved)
                    : {};
                next.conversationCommentsSections = {
                    project: state.projectSectionCollapsed,
                    session: state.sessionSectionCollapsed,
                };
                vscodeApi.setState(next);
            } catch (_error) {
                // Section state persistence is best-effort.
            }
        }

        function applySectionToggle(header, content, collapsed) {
            var toggle = header.querySelector('[data-comments-section-toggle]');
            if (toggle) {
                toggle.setAttribute(
                    'aria-expanded',
                    collapsed ? 'false' : 'true'
                );
                var label = collapsed ? 'Expand section' : 'Collapse section';
                toggle.title = label;
                toggle.setAttribute('aria-label', label);
            }
            content.hidden = collapsed;
        }

        function applyCommentSectionState() {
            applySectionToggle(
                sessionCommentsHeader,
                sessionCommentsContent,
                state.sessionSectionCollapsed
            );
            if (projectCommentsAvailable) {
                applySectionToggle(
                    projectCommentsHeader,
                    projectCommentsContent,
                    state.projectSectionCollapsed
                );
            }
            if (commentsSectionSash) {
                commentsSectionSash.hidden = state.projectSectionCollapsed
                    || state.sessionSectionCollapsed;
            }
            if (commentsBody) {
                commentsBody.setAttribute(
                    'data-workspace-collapsed',
                    state.projectSectionCollapsed ? 'true' : 'false'
                );
            }
        }

        function toggleSessionSection() {
            state.sessionSectionCollapsed = !state.sessionSectionCollapsed;
            applyCommentSectionState();
            saveCommentSectionState();
        }

        var SESSION_REGION_MIN_HEIGHT = 56;

        function clampSessionRegionHeight(height) {
            var bodyHeight = commentsBody
                ? commentsBody.getBoundingClientRect().height
                : 0;
            var max = bodyHeight > 0 ? bodyHeight * 0.7 : height;
            return Math.max(
                SESSION_REGION_MIN_HEIGHT,
                Math.min(Math.round(height), Math.round(max))
            );
        }

        function setSessionRegionHeight(height, persist) {
            if (!commentUiAvailable) return;
            sessionCommentsContent.style.height = height + 'px';
            sessionCommentsContent.style.maxHeight = 'none';
            sessionCommentsContent.setAttribute('data-explicit-height', '');
            var bodyHeight = commentsBody.getBoundingClientRect().height;
            if (bodyHeight > 0) {
                commentsSectionSash.setAttribute(
                    'aria-valuenow',
                    String(Math.round((height / bodyHeight) * 100))
                );
            }
            if (persist) {
                saveSessionRegionHeight(height);
            }
        }

        function resetSessionRegionHeight() {
            if (!commentUiAvailable) return;
            sessionCommentsContent.style.height = '';
            sessionCommentsContent.style.maxHeight = '';
            sessionCommentsContent.removeAttribute('data-explicit-height');
            commentsSectionSash.setAttribute('aria-valuenow', '45');
            saveSessionRegionHeight(null);
        }

        function saveSessionRegionHeight(height) {
            if (!vscodeApi || typeof vscodeApi.setState !== 'function') {
                return;
            }
            try {
                var saved = typeof vscodeApi.getState === 'function'
                    ? vscodeApi.getState()
                    : null;
                var next = saved && typeof saved === 'object'
                    && !Array.isArray(saved)
                    ? Object.assign({}, saved)
                    : {};
                next.conversationCommentsSessionRegionHeight =
                    Number.isFinite(height) ? height : null;
                vscodeApi.setState(next);
            } catch (_error) {
                // Region height persistence is best-effort.
            }
        }

        function restoreSessionRegionHeight() {
            if (!commentUiAvailable) return;
            try {
                var saved = vscodeApi && typeof vscodeApi.getState === 'function'
                    ? vscodeApi.getState()
                    : null;
                var height = saved
                    && saved.conversationCommentsSessionRegionHeight;
                if (Number.isFinite(height)) {
                    setSessionRegionHeight(
                        clampSessionRegionHeight(height),
                        false
                    );
                }
            } catch (_error) {
                // Region height persistence is best-effort.
            }
        }

        function attachCommentsSectionSash() {
            if (!commentUiAvailable) return;
            var sashPointerId = null;
            commentsSectionSash.addEventListener('pointerdown', function (event) {
                if (event.button !== 0) return;
                sashPointerId = event.pointerId;
                commentsSectionSash.setPointerCapture(event.pointerId);
                event.preventDefault();
            });
            commentsSectionSash.addEventListener('pointermove', function (event) {
                if (event.pointerId !== sashPointerId) return;
                var bounds = commentsBody.getBoundingClientRect();
                setSessionRegionHeight(
                    clampSessionRegionHeight(bounds.bottom - event.clientY),
                    false
                );
            });
            function finishSashResize(event) {
                if (event.pointerId !== sashPointerId) return;
                sashPointerId = null;
                saveSessionRegionHeight(
                    sessionCommentsContent.getBoundingClientRect().height
                );
            }
            commentsSectionSash.addEventListener('pointerup', finishSashResize);
            commentsSectionSash.addEventListener(
                'pointercancel',
                finishSashResize
            );
            commentsSectionSash.addEventListener('dblclick', function () {
                resetSessionRegionHeight();
            });
            commentsSectionSash.addEventListener('keydown', function (event) {
                var current = sessionCommentsContent
                    .getBoundingClientRect().height;
                var bodyHeight = commentsBody.getBoundingClientRect().height;
                var nextHeight;
                if (event.key === 'ArrowUp') {
                    nextHeight = current - 16;
                } else if (event.key === 'ArrowDown') {
                    nextHeight = current + 16;
                } else if (event.key === 'Home') {
                    nextHeight = SESSION_REGION_MIN_HEIGHT;
                } else if (event.key === 'End') {
                    nextHeight = bodyHeight * 0.7;
                } else {
                    return;
                }
                event.preventDefault();
                setSessionRegionHeight(
                    clampSessionRegionHeight(nextHeight),
                    true
                );
            });
        }

        function toggleProjectSection() {
            state.projectSectionCollapsed = !state.projectSectionCollapsed;
            applyCommentSectionState();
            saveCommentSectionState();
        }

        function expandSessionSection() {
            if (!state.sessionSectionCollapsed) return;
            state.sessionSectionCollapsed = false;
            applyCommentSectionState();
            saveCommentSectionState();
        }

        function expandProjectSection() {
            if (!projectCommentsAvailable
                || !state.projectSectionCollapsed) return;
            state.projectSectionCollapsed = false;
            applyCommentSectionState();
            saveCommentSectionState();
        }

        function openProjectCommentComposer() {
            if (!projectCommentsAvailable
                || state.pendingProjectCommentRequest) return;
            // Opening the composer from a collapsed section must unfold the
            // group first, or the composer surfaces inside hidden content.
            expandProjectSection();
            projectCommentComposer.hidden = false;
            updateProjectComposerControls();
            projectCommentInput.focus();
        }

        function closeProjectCommentComposer() {
            if (!projectCommentsAvailable) return;
            projectCommentComposer.hidden = true;
            resetProjectComposer();
        }

        function saveSelectionAsProjectNote() {
            if (!projectCommentsAvailable
                || !state.selectedCommentText
                || state.selectedCommentText.scope === 'session'
                || state.pendingProjectCommentRequest) {
                return;
            }
            state.projectPendingSource = {
                provider: commentTarget.provider,
                sessionId: commentTarget.sessionId,
                quote: state.selectedCommentText.quote,
            };
            state.selectedCommentText = null;
            addComment.hidden = true;
            var selection = window.getSelection();
            if (selection) {
                selection.removeAllRanges();
            }
            setSidebarView('comments', true, true);
            updateProjectSourcePreview();
            openProjectCommentComposer();
        }

        function postProjectCommentOperation(operation, payload, focusCommentId) {
            if (!projectCommentsAvailable
                || state.pendingProjectCommentRequest) return;
            var requestId = nextProjectCommentRequestId();
            state.pendingProjectCommentRequest = {
                requestId: requestId,
                operation: operation,
                focusCommentId: focusCommentId || null,
            };
            setProjectCommentPending(true);
            status.textContent = operation === 'sendProjectComment'
                ? 'Adding note to session input…'
                : 'Saving project note…';
            post({
                type: operation === 'sendProjectComment'
                    ? 'conversation-viewer-send-project-comment'
                    : 'conversation-viewer-project-comment-mutation',
                version: 1,
                requestId: requestId,
                subscriptionGeneration: subscriptionGeneration,
                projectId: commentTarget.projectId,
                provider: commentTarget.provider,
                sessionId: commentTarget.sessionId,
                operation: operation,
                expectedRevision: state.projectCommentRevision,
                payload: payload,
            });
        }

        function addProjectCommentFromComposer() {
            var text = projectCommentInput.value.trim();
            if (!text) {
                status.textContent = 'Enter a note before adding it.';
                projectCommentInput.focus();
                return;
            }
            var payload = {
                text: text,
                tags: state.projectDraftTags.slice(),
            };
            if (state.projectPendingSource) {
                payload.source = Object.assign(
                    {},
                    state.projectPendingSource
                );
            }
            closeProjectCommentComposer();
            postProjectCommentOperation('add', payload);
        }

        function projectTagElement(comment, tag, removable) {
            var chip = document.createElement('span');
            chip.className = 'conversation-project-comment-tag';
            chip.setAttribute(
                'data-tag-color',
                String(projectTagColorKey(tag))
            );
            chip.appendChild(document.createTextNode(tag));
            if (removable) {
                var remove = document.createElement('button');
                remove.type = 'button';
                remove.setAttribute(
                    'data-project-comment-action',
                    'remove-tag'
                );
                remove.setAttribute('data-tag', tag);
                remove.title = 'Remove tag ' + tag;
                remove.setAttribute('aria-label', 'Remove tag ' + tag);
                remove.textContent = '\u00d7';
                chip.appendChild(remove);
            }
            return chip;
        }

        function buildProjectCommentTagsRow(comment) {
            var row = document.createElement('div');
            row.className = 'conversation-comment-tags-row';
            row.appendChild(
                buildCommentStatusChip(comment.status, 'toggle-status')
            );
            comment.tags.forEach(function (tag) {
                row.appendChild(projectTagElement(comment, tag, true));
            });
            if (state.projectTagEditor
                && state.projectTagEditor.commentId === comment.id) {
                var tagInput = document.createElement('input');
                tagInput.type = 'text';
                tagInput.maxLength = 48;
                tagInput.className = 'conversation-project-comment-tag-input';
                tagInput.setAttribute('data-project-comment-tag-input', '');
                tagInput.setAttribute('aria-label', 'New tag');
                tagInput.placeholder = 'tag';
                tagInput.value = state.projectTagEditor.draft;
                row.appendChild(tagInput);
            } else if (comment.tags.length < 5) {
                var addTag = document.createElement('button');
                addTag.type = 'button';
                addTag.className = 'conversation-project-comment-tag-add';
                addTag.setAttribute(
                    'data-project-comment-action',
                    'open-tag-editor'
                );
                addTag.title = 'Add tag';
                addTag.setAttribute('aria-label', 'Add tag');
                addTag.textContent = '+';
                row.appendChild(addTag);
            }
            return row;
        }

        function buildProjectCommentCard(comment, index) {
            var item = document.createElement('article');
            item.className = 'conversation-comment conversation-project-comment';
            item.setAttribute('data-project-comment-id', comment.id);
            item.setAttribute('data-comment-status', comment.status);

            var editing = !!state.editingProjectComment
                && state.editingProjectComment.commentId === comment.id;

            var heading = document.createElement('div');
            heading.className = 'conversation-comment-heading';
            var dragHandle = document.createElement('button');
            dragHandle.type = 'button';
            dragHandle.className = 'conversation-comment-drag-handle';
            dragHandle.setAttribute('data-project-comment-drag-handle', '');
            dragHandle.setAttribute('aria-label', 'Move note ' + (index + 1));
            dragHandle.setAttribute(
                'aria-keyshortcuts',
                'Alt+ArrowUp Alt+ArrowDown'
            );
            dragHandle.title = 'Drag to reorder · Alt+Up/Down';
            dragHandle.innerHTML = COMMENT_ICONS.drag;
            dragHandle.draggable = !editing;
            dragHandle.disabled = editing;
            heading.appendChild(dragHandle);
            var actions = document.createElement('div');
            actions.className = 'conversation-comment-actions';
            heading.appendChild(actions);
            item.appendChild(heading);

            function projectIconButton(action, icon, label, modifier) {
                var button = commentIconButton(action, icon, label, modifier);
                button.setAttribute('data-project-comment-action', action);
                button.removeAttribute('data-comment-action');
                return button;
            }

            if (editing) {
                actions.appendChild(projectIconButton(
                    'update',
                    COMMENT_ICONS.save,
                    'Save note (Ctrl+Enter or Cmd+Enter)'
                ));
                actions.appendChild(projectIconButton(
                    'cancel-edit',
                    COMMENT_ICONS.cancel,
                    'Discard changes (Esc)'
                ));
                var input = document.createElement('textarea');
                input.rows = 1;
                input.maxLength = 4000;
                input.value = state.editingProjectComment.draft;
                input.setAttribute('aria-label', 'Workspace note ' + (index + 1));
                input.setAttribute(
                    'aria-keyshortcuts',
                    'Control+Enter Meta+Enter'
                );
                input.setAttribute('data-project-comment-edit', '');
                var hint = document.createElement('div');
                hint.className = 'conversation-comment-edit-hint';
                hint.textContent = 'Ctrl+Enter to save · Esc to cancel';
                item.append(input, hint);
                item.appendChild(buildProjectCommentTagsRow(comment));
                window.setTimeout(function () {
                    autosizeCommentInput(input);
                    input.focus();
                    input.setSelectionRange(
                        input.value.length,
                        input.value.length
                    );
                }, 0);
                return item;
            }

            var expanded = comment.status !== 'done'
                || state.expandedDoneProjectComments.has(comment.id);
            if (comment.status === 'done' && !expanded) {
                item.classList.add('conversation-comment-done-collapsed');
                var expand = projectIconButton(
                    'toggle-done',
                    COMMENT_ICONS.chevron,
                    'Expand note'
                );
                expand.setAttribute('aria-expanded', 'false');
                actions.appendChild(expand);
                actions.appendChild(projectIconButton(
                    'delete',
                    COMMENT_ICONS.remove,
                    'Delete note',
                    'danger'
                ));
                var collapsedBody = document.createElement('div');
                collapsedBody.className =
                    'conversation-comment-collapsed-body';
                collapsedBody.setAttribute(
                    'data-project-comment-action',
                    'toggle-done'
                );
                collapsedBody.textContent = comment.text;
                item.appendChild(collapsedBody);
                item.appendChild(buildProjectCommentTagsRow(comment));
                return item;
            }

            if (comment.status === 'done') {
                var collapse = projectIconButton(
                    'toggle-done',
                    COMMENT_ICONS.chevron,
                    'Collapse note'
                );
                collapse.setAttribute('aria-expanded', 'true');
                actions.appendChild(collapse);
            }
            actions.appendChild(projectIconButton(
                'send',
                COMMENT_ICONS.send,
                'Send this note to the session input'
            ));
            actions.appendChild(projectIconButton(
                'edit',
                COMMENT_ICONS.edit,
                'Edit note'
            ));
            actions.appendChild(projectIconButton(
                'delete',
                COMMENT_ICONS.remove,
                'Delete note',
                'danger'
            ));

            var body = document.createElement('div');
            body.className = 'conversation-comment-body';
            body.textContent = comment.text;
            item.appendChild(body);
            if (comment.source) {
                var quoteGroup = document.createElement('div');
                quoteGroup.className = 'conversation-comment-quote';
                var quoteLabel = document.createElement('span');
                quoteLabel.className = 'conversation-comment-quote-label';
                quoteLabel.textContent = 'From '
                    + providerLabel(comment.source.provider) + ' session';
                quoteGroup.appendChild(quoteLabel);
                if (comment.source.quote) {
                    var quote = document.createElement('blockquote');
                    quote.textContent = comment.source.quote;
                    quoteGroup.appendChild(quote);
                }
                item.appendChild(quoteGroup);
            }
            var meta = document.createElement('div');
            meta.className = 'conversation-comment-meta';
            var metaLabel = document.createElement('span');
            metaLabel.textContent = '#' + (index + 1);
            meta.appendChild(metaLabel);
            var timeText = formatCommentTime(comment.createdAt);
            if (timeText) {
                var time = document.createElement('span');
                time.className = 'conversation-comment-time';
                time.textContent = timeText;
                meta.appendChild(time);
            }
            if (comment.dispatches.length) {
                var lastDispatch = comment.dispatches[
                    comment.dispatches.length - 1
                ];
                var dispatch = document.createElement('span');
                dispatch.className = 'conversation-project-comment-dispatch';
                dispatch.textContent = '\u2192 Sent to '
                    + providerLabel(lastDispatch.provider)
                    + ' · ' + formatCommentTime(lastDispatch.at);
                meta.appendChild(dispatch);
            }
            item.appendChild(meta);
            item.appendChild(buildProjectCommentTagsRow(comment));
            return item;
        }

        function renderProjectTagFilter() {
            if (!projectCommentsAvailable) return;
            var vocabulary = [];
            var counts = new Map();
            var openCount = 0;
            var doneCount = 0;
            orderedProjectComments().forEach(function (comment) {
                if (comment.status === 'open') {
                    openCount += 1;
                } else {
                    doneCount += 1;
                }
                comment.tags.forEach(function (tag) {
                    var key = tag.toLowerCase();
                    if (!counts.has(key)) {
                        counts.set(key, 0);
                        vocabulary.push(tag);
                    }
                    counts.set(key, counts.get(key) + 1);
                });
            });
            if (state.projectTagFilter
                && state.projectTagFilter.type === 'tag'
                && !counts.has(state.projectTagFilter.value)) {
                state.projectTagFilter = null;
                saveProjectTagFilter();
            }
            projectCommentTagFilter.replaceChildren();
            projectCommentTagFilter.hidden
                = state.projectComments.length === 0;
            if (!state.projectComments.length) return;

            function filterChip(label, pressed, attributes) {
                var chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'conversation-project-comment-filter-chip';
                chip.setAttribute('data-project-comment-action', 'filter-tag');
                Object.keys(attributes).forEach(function (name) {
                    chip.setAttribute(name, attributes[name]);
                });
                chip.setAttribute(
                    'aria-pressed',
                    pressed ? 'true' : 'false'
                );
                chip.appendChild(document.createTextNode(label));
                projectCommentTagFilter.appendChild(chip);
                return chip;
            }

            var filter = state.projectTagFilter;
            filterChip(
                'All · ' + state.projectComments.length,
                filter === null,
                { 'data-tag': '' }
            );
            ['open', 'done'].forEach(function (status) {
                var chip = filterChip(
                    (status === 'open' ? 'Open' : 'Done') + ' · '
                        + (status === 'open' ? openCount : doneCount),
                    !!filter && filter.type === 'status'
                        && filter.value === status,
                    { 'data-status-filter': status }
                );
                var dot = document.createElement('span');
                dot.className = 'conversation-project-comment-filter-dot';
                dot.setAttribute('data-comment-status-chip', status);
                chip.insertBefore(dot, chip.firstChild);
            });
            vocabulary.forEach(function (tag) {
                var key = tag.toLowerCase();
                var chip = filterChip(
                    tag + ' · ' + counts.get(key),
                    !!filter && filter.type === 'tag'
                        && filter.value === key,
                    { 'data-tag': tag }
                );
                var dot = document.createElement('span');
                dot.className = 'conversation-project-comment-filter-dot';
                dot.setAttribute(
                    'data-tag-color',
                    String(projectTagColorKey(tag))
                );
                chip.insertBefore(dot, chip.firstChild);
            });
        }

        function renderProjectComments() {
            if (!projectCommentsAvailable) return;
            clearProjectCommentDragState();
            renderProjectTagFilter();
            projectCommentList.replaceChildren();
            var visible = visibleProjectComments();
            visible.forEach(function (comment, index) {
                projectCommentList.appendChild(
                    buildProjectCommentCard(comment, index)
                );
            });
            projectCommentEmpty.hidden = state.projectComments.length > 0;
            if (!projectCommentEmpty.hidden) {
                projectCommentEmpty.textContent = 'No workspace notes yet.';
            }
            if (state.projectComments.length > 0 && visible.length === 0) {
                projectCommentEmpty.hidden = false;
                projectCommentEmpty.textContent = 'No notes match this filter.';
            }
            updateSectionCount(
                projectCommentsCount,
                state.projectComments.reduce(function (counts, comment) {
                    counts[comment.status] += 1;
                    return counts;
                }, { open: 0, done: 0 }),
                'notes'
            );
            if (state.projectTagEditor) {
                var editorInput = projectCommentList.querySelector(
                    '[data-project-comment-tag-input]'
                );
                if (editorInput) {
                    editorInput.focus();
                    editorInput.setSelectionRange(
                        editorInput.value.length,
                        editorInput.value.length
                    );
                }
            }
            updateProjectComposerControls();
        }

        function focusProjectCommentDragHandle(commentId) {
            if (!commentId || !projectCommentsAvailable) return;
            var card = projectCommentList.querySelector(
                '[data-project-comment-id="' + CSS.escape(commentId) + '"]'
            );
            var handle = card && card.querySelector(
                '[data-project-comment-drag-handle]'
            );
            if (handle && !handle.disabled) {
                handle.focus({ preventScroll: true });
            }
        }

        function clearProjectCommentDragState() {
            state.draggedProjectCommentId = null;
            if (!projectCommentsAvailable) return;
            Array.prototype.forEach.call(
                projectCommentList.querySelectorAll(
                    '.conversation-comment-dragging, [data-comment-drop-position]'
                ),
                function (card) {
                    card.classList.remove('conversation-comment-dragging');
                    card.removeAttribute('data-comment-drop-position');
                }
            );
        }

        function reorderedProjectCommentIds(sourceId, targetId, placement) {
            var visibleIds = visibleProjectComments().map(function (comment) {
                return comment.id;
            });
            var sourceIndex = visibleIds.indexOf(sourceId);
            if (sourceIndex < 0 || sourceId === targetId) return null;
            visibleIds.splice(sourceIndex, 1);
            var targetIndex = visibleIds.indexOf(targetId);
            if (targetIndex < 0) return null;
            visibleIds.splice(
                targetIndex + (placement === 'after' ? 1 : 0),
                0,
                sourceId
            );
            var originalVisibleIds = visibleProjectComments().map(
                function (comment) {
                    return comment.id;
                }
            );
            var unchanged = visibleIds.every(function (id, index) {
                return id === originalVisibleIds[index];
            });
            if (unchanged) return null;
            var visibleSet = new Set(originalVisibleIds);
            var visibleIndex = 0;
            return state.projectComments.map(function (comment) {
                if (!visibleSet.has(comment.id)) return comment.id;
                var reorderedId = visibleIds[visibleIndex];
                visibleIndex += 1;
                return reorderedId;
            });
        }

        function postProjectCommentReorder(sourceId, targetId, placement) {
            var orderedCommentIds = reorderedProjectCommentIds(
                sourceId,
                targetId,
                placement
            );
            clearProjectCommentDragState();
            if (!orderedCommentIds) return false;
            postProjectCommentOperation(
                'reorder',
                { orderedCommentIds: orderedCommentIds },
                sourceId
            );
            return true;
        }

        function applyProjectCommentsResult(message) {
            if (!projectCommentsAvailable
                || !validProjectCommentsResult(message)
                || message.subscriptionGeneration !== subscriptionGeneration
                || message.projectId !== commentTarget.projectId
                || message.provider !== commentTarget.provider
                || message.sessionId !== commentTarget.sessionId
                || !state.pendingProjectCommentRequest
                || message.requestId
                    !== state.pendingProjectCommentRequest.requestId
                || message.operation
                    !== state.pendingProjectCommentRequest.operation) {
                return false;
            }
            var operation = state.pendingProjectCommentRequest.operation;
            var focusCommentId
                = state.pendingProjectCommentRequest.focusCommentId;
            state.projectCommentRevision = message.revision;
            state.projectComments = message.comments.map(cloneProjectComment);
            if (message.success && operation === 'update') {
                state.editingProjectComment = null;
            }
            renderProjectComments();
            state.pendingProjectCommentRequest = null;
            setProjectCommentPending(false);
            if (message.success) {
                status.textContent = operation === 'sendProjectComment'
                    ? 'Note added to session input.'
                        + ' Review and press Enter to send.'
                    : operation === 'delete'
                        ? 'Project note deleted.'
                        : operation === 'reorder'
                            ? 'Note order saved.'
                        : 'Project note saved.';
            } else {
                status.textContent = projectCommentErrorMessage(message.error);
            }
            updateCommentControls();
            focusProjectCommentDragHandle(focusCommentId);
            return true;
        }

        function attach() {
            if (!commentUiAvailable) return;
            attachCommentsSectionSash();
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
            messages.addEventListener('click', function (event) {
                var marker = event.target && event.target.closest
                    ? event.target.closest('[data-comment-marker]')
                    : null;
                if (!marker || !messages.contains(marker)) return;
                var messageId = marker.getAttribute('data-comment-marker');
                var matching = state.comments.filter(function (comment) {
                    return comment.messageId === messageId
                        && comment.scope !== 'session';
                });
                if (!matching.length) return;
                var target = matching.find(function (comment) {
                    return comment.status === 'open';
                }) || matching[0];
                revealCommentCard(target.id);
            });
            scroll.addEventListener('scroll', function () {
                addComment.hidden = true;
            });
            commentsRoot.addEventListener('input', function (event) {
                var target = event.target;
                if (target && target.matches
                    && target.matches('[data-comment-edit]')) {
                    if (state.editingComment) {
                        state.editingComment.draft = target.value;
                    }
                    autosizeCommentInput(target);
                } else if (target && target.matches
                    && target.matches('[data-comment-tag-input]')
                    && state.sessionTagEditor) {
                    state.sessionTagEditor.draft = target.value;
                }
            });
            commentList.addEventListener('dragstart', function (event) {
                var handle = event.target && event.target.closest
                    ? event.target.closest('[data-comment-drag-handle]')
                    : null;
                var item = handle && handle.closest('[data-comment-id]');
                if (!handle || !item
                    || state.pendingCommentRequest
                    || state.pendingLocateRequest
                    || handle.disabled) {
                    event.preventDefault();
                    return;
                }
                state.draggedCommentId = item.getAttribute('data-comment-id');
                item.classList.add('conversation-comment-dragging');
                if (event.dataTransfer) {
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData(
                        'text/plain',
                        state.draggedCommentId
                    );
                }
            });
            commentList.addEventListener('dragover', function (event) {
                if (!state.draggedCommentId) return;
                var item = event.target && event.target.closest
                    ? event.target.closest('[data-comment-id]')
                    : null;
                if (!item || !commentList.contains(item)
                    || item.getAttribute('data-comment-id')
                        === state.draggedCommentId) {
                    return;
                }
                event.preventDefault();
                if (event.dataTransfer) {
                    event.dataTransfer.dropEffect = 'move';
                }
                Array.prototype.forEach.call(
                    commentList.querySelectorAll('[data-comment-drop-position]'),
                    function (candidate) {
                        if (candidate !== item) {
                            candidate.removeAttribute(
                                'data-comment-drop-position'
                            );
                        }
                    }
                );
                var bounds = item.getBoundingClientRect();
                item.setAttribute(
                    'data-comment-drop-position',
                    event.clientY < bounds.top + bounds.height / 2
                        ? 'before'
                        : 'after'
                );
            });
            commentList.addEventListener('drop', function (event) {
                if (!state.draggedCommentId) return;
                var item = event.target && event.target.closest
                    ? event.target.closest('[data-comment-id]')
                    : null;
                if (!item || !commentList.contains(item)) {
                    clearCommentDragState();
                    return;
                }
                event.preventDefault();
                var sourceId = state.draggedCommentId;
                var targetId = item.getAttribute('data-comment-id');
                var placement = item.getAttribute(
                    'data-comment-drop-position'
                ) || 'after';
                postCommentReorder(sourceId, targetId, placement);
            });
            commentList.addEventListener('dragend', clearCommentDragState);
            commentList.addEventListener('keydown', function (event) {
                if (!event.altKey || event.ctrlKey || event.metaKey
                    || (event.key !== 'ArrowUp'
                        && event.key !== 'ArrowDown')
                    || state.pendingCommentRequest
                    || state.pendingLocateRequest) {
                    return;
                }
                var handle = event.target && event.target.closest
                    ? event.target.closest('[data-comment-drag-handle]')
                    : null;
                var item = handle && handle.closest('[data-comment-id]');
                if (!handle || !item || handle.disabled) return;
                var visibleIds = visibleCommentEntries().map(function (entry) {
                    return entry.comment.id;
                });
                var sourceId = item.getAttribute('data-comment-id');
                var sourceIndex = visibleIds.indexOf(sourceId);
                var targetIndex = sourceIndex
                    + (event.key === 'ArrowUp' ? -1 : 1);
                if (sourceIndex < 0
                    || targetIndex < 0
                    || targetIndex >= visibleIds.length) {
                    return;
                }
                event.preventDefault();
                postCommentReorder(
                    sourceId,
                    visibleIds[targetIndex],
                    event.key === 'ArrowUp' ? 'before' : 'after'
                );
            });
            addComment.addEventListener('click', function (event) {
                var button = event.target && event.target.closest
                    ? event.target.closest('[data-comment-selection-action]')
                    : null;
                if (!button || !addComment.contains(button)) return;
                if (button.getAttribute('data-comment-selection-action')
                    === 'send') {
                    sendSelectionToTerminal();
                    return;
                }
                if (button.getAttribute('data-comment-selection-action')
                    === 'project') {
                    saveSelectionAsProjectNote();
                    return;
                }
                openCommentComposer();
            });
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
                if (action === 'filter') {
                    var filter = button.getAttribute('data-comment-filter');
                    if (filter === 'all' || filter === 'open'
                        || filter === 'done') {
                        state.filter = filter;
                        saveCommentsFilter();
                        renderComments();
                    }
                    return;
                }
                if (action === 'send') {
                    postCommentOperation('sendComments', {});
                    return;
                }
                if (action === 'clearDone') {
                    postCommentOperation('clearDone', {});
                    return;
                }
                if (action === 'clearAll') {
                    if (!state.clearAllConfirmation) {
                        state.clearAllConfirmation = true;
                        commentClearAll.setAttribute('data-confirming', 'true');
                        commentClearAll.title =
                            'Click again to confirm clear all';
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
                if (action === 'open-tag-editor') {
                    state.sessionTagEditor = {
                        commentId: comment.id,
                        draft: '',
                    };
                    renderComments();
                    return;
                }
                if (action === 'remove-tag') {
                    postCommentOperation('removeTag', {
                        commentId: comment.id,
                        tag: button.getAttribute('data-tag') || '',
                    });
                    return;
                }
                if (action === 'toggle-done') {
                    if (state.expandedDoneComments.has(comment.id)) {
                        state.expandedDoneComments.delete(comment.id);
                    } else {
                        state.expandedDoneComments.add(comment.id);
                    }
                    renderComments();
                    return;
                }
                if (action === 'send-comment') {
                    postCommentOperation(
                        'sendComment',
                        { commentId: comment.id }
                    );
                    return;
                }
                if (action === 'edit-comment') {
                    state.editingComment = {
                        commentId: comment.id,
                        draft: comment.comment,
                    };
                    renderComments();
                    return;
                }
                if (action === 'cancel-edit') {
                    state.editingComment = null;
                    renderComments();
                    status.textContent = 'Edit cancelled.';
                    return;
                }
                if (action === 'locate') {
                    requestCommentLocation(comment);
                    return;
                }
                if (action === 'delete') {
                    postCommentOperation('delete', { commentId: comment.id });
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
            if (projectCommentsAvailable) {
                projectCommentsHeader.addEventListener(
                    'click',
                    function (event) {
                        var actionElement = event.target
                            && event.target.closest
                            ? event.target.closest(
                                '[data-project-comment-action]'
                            )
                            : null;
                        if (actionElement
                            && projectCommentsHeader.contains(actionElement)) {
                            if (actionElement.getAttribute(
                                'data-project-comment-action'
                            ) === 'open-composer') {
                                openProjectCommentComposer();
                            }
                            return;
                        }
                        toggleProjectSection();
                    }
                );
            }
            sessionCommentsHeader.addEventListener('click', function (event) {
                var actionElement = event.target && event.target.closest
                    ? event.target.closest('[data-comment-action]')
                    : null;
                if (actionElement
                    && sessionCommentsHeader.contains(actionElement)) {
                    return;
                }
                toggleSessionSection();
            });
            if (projectCommentsAvailable) {
                projectCommentInput.addEventListener('input', function () {
                    autosizeCommentInput(projectCommentInput);
                    updateProjectComposerControls();
                });
                projectCommentsRoot.addEventListener('input', function (event) {
                    var target = event.target;
                    if (!target || !target.matches) return;
                    if (target.matches('[data-project-comment-edit]')) {
                        if (state.editingProjectComment) {
                            state.editingProjectComment.draft = target.value;
                        }
                        autosizeCommentInput(target);
                    } else if (target.matches('[data-project-comment-tag-input]')
                        && state.projectTagEditor) {
                        state.projectTagEditor.draft = target.value;
                    }
                });
                projectCommentsRoot.addEventListener('click', function (event) {
                    var button = event.target && event.target.closest
                        ? event.target.closest('[data-project-comment-action]')
                        : null;
                    if (!button || !projectCommentsRoot.contains(button)
                        || state.pendingProjectCommentRequest) {
                        return;
                    }
                    var action = button.getAttribute(
                        'data-project-comment-action'
                    );
                    if (action === 'open-composer') {
                        openProjectCommentComposer();
                        return;
                    }
                    if (action === 'cancel-add') {
                        closeProjectCommentComposer();
                        status.textContent = 'Project note cancelled.';
                        return;
                    }
                    if (action === 'add') {
                        addProjectCommentFromComposer();
                        return;
                    }
                    if (action === 'add-draft-tag') {
                        state.projectDraftTagInputOpen = true;
                        renderProjectDraftTags();
                        return;
                    }
                    if (action === 'remove-draft-tag') {
                        var draftTag = button.getAttribute('data-tag');
                        state.projectDraftTags = state.projectDraftTags.filter(
                            function (candidate) {
                                return candidate !== draftTag;
                            }
                        );
                        renderProjectDraftTags();
                        return;
                    }
                    if (action === 'clear-source') {
                        state.projectPendingSource = null;
                        updateProjectSourcePreview();
                        return;
                    }
                    if (action === 'filter-tag') {
                        var statusValue = button.getAttribute(
                            'data-status-filter'
                        );
                        var tagValue = button.getAttribute('data-tag');
                        var nextFilter = statusValue
                            ? { type: 'status', value: statusValue }
                            : tagValue
                                ? { type: 'tag', value: tagValue.toLowerCase() }
                                : null;
                        state.projectTagFilter = projectCommentFilterEquals(
                            state.projectTagFilter,
                            nextFilter
                        )
                            ? null
                            : nextFilter;
                        saveProjectTagFilter();
                        renderProjectComments();
                        return;
                    }
                    var card = button.closest('[data-project-comment-id]');
                    var commentId = card && card.getAttribute(
                        'data-project-comment-id'
                    );
                    var comment = state.projectComments.find(
                        function (candidate) {
                            return candidate.id === commentId;
                        }
                    );
                    if (!card || !comment) return;
                    if (action === 'toggle-done') {
                        if (state.expandedDoneProjectComments.has(comment.id)) {
                            state.expandedDoneProjectComments.delete(
                                comment.id
                            );
                        } else {
                            state.expandedDoneProjectComments.add(comment.id);
                        }
                        renderProjectComments();
                        return;
                    }
                    if (action === 'toggle-status') {
                        postProjectCommentOperation('setStatus', {
                            commentId: comment.id,
                            status: comment.status === 'open'
                                ? 'done'
                                : 'open',
                        });
                        return;
                    }
                    if (action === 'send') {
                        postProjectCommentOperation('sendProjectComment', {
                            commentId: comment.id,
                        });
                        return;
                    }
                    if (action === 'edit') {
                        state.editingProjectComment = {
                            commentId: comment.id,
                            draft: comment.text,
                        };
                        renderProjectComments();
                        return;
                    }
                    if (action === 'cancel-edit') {
                        state.editingProjectComment = null;
                        renderProjectComments();
                        status.textContent = 'Edit cancelled.';
                        return;
                    }
                    if (action === 'update') {
                        var editor = card.querySelector(
                            '[data-project-comment-edit]'
                        );
                        var text = editor ? editor.value.trim() : '';
                        if (!text) {
                            status.textContent =
                                'A project note cannot be empty.';
                            if (editor) editor.focus();
                            return;
                        }
                        postProjectCommentOperation('update', {
                            commentId: comment.id,
                            text: text,
                        });
                        return;
                    }
                    if (action === 'delete') {
                        postProjectCommentOperation('delete', {
                            commentId: comment.id,
                        });
                        return;
                    }
                    if (action === 'open-tag-editor') {
                        state.projectTagEditor = {
                            commentId: comment.id,
                            draft: '',
                        };
                        renderProjectComments();
                        return;
                    }
                    if (action === 'remove-tag') {
                        postProjectCommentOperation('removeTag', {
                            commentId: comment.id,
                            tag: button.getAttribute('data-tag') || '',
                        });
                    }
                });
                projectCommentList.addEventListener('dragstart', function (event) {
                    var handle = event.target && event.target.closest
                        ? event.target.closest('[data-project-comment-drag-handle]')
                        : null;
                    var item = handle && handle.closest('[data-project-comment-id]');
                    if (!handle || !item
                        || state.pendingProjectCommentRequest
                        || handle.disabled) {
                        event.preventDefault();
                        return;
                    }
                    state.draggedProjectCommentId = item.getAttribute(
                        'data-project-comment-id'
                    );
                    item.classList.add('conversation-comment-dragging');
                    if (event.dataTransfer) {
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData(
                            'text/plain',
                            state.draggedProjectCommentId
                        );
                    }
                });
                projectCommentList.addEventListener('dragover', function (event) {
                    if (!state.draggedProjectCommentId) return;
                    var item = event.target && event.target.closest
                        ? event.target.closest('[data-project-comment-id]')
                        : null;
                    if (!item || !projectCommentList.contains(item)
                        || item.getAttribute('data-project-comment-id')
                            === state.draggedProjectCommentId) {
                        return;
                    }
                    event.preventDefault();
                    if (event.dataTransfer) {
                        event.dataTransfer.dropEffect = 'move';
                    }
                    Array.prototype.forEach.call(
                        projectCommentList.querySelectorAll('[data-comment-drop-position]'),
                        function (candidate) {
                            if (candidate !== item) {
                                candidate.removeAttribute(
                                    'data-comment-drop-position'
                                );
                            }
                        }
                    );
                    var bounds = item.getBoundingClientRect();
                    item.setAttribute(
                        'data-comment-drop-position',
                        event.clientY < bounds.top + bounds.height / 2
                            ? 'before'
                            : 'after'
                    );
                });
                projectCommentList.addEventListener('drop', function (event) {
                    if (!state.draggedProjectCommentId) return;
                    var item = event.target && event.target.closest
                        ? event.target.closest('[data-project-comment-id]')
                        : null;
                    if (!item || !projectCommentList.contains(item)) {
                        clearProjectCommentDragState();
                        return;
                    }
                    event.preventDefault();
                    var sourceId = state.draggedProjectCommentId;
                    var targetId = item.getAttribute('data-project-comment-id');
                    var placement = item.getAttribute(
                        'data-comment-drop-position'
                    ) || 'after';
                    postProjectCommentReorder(sourceId, targetId, placement);
                });
                projectCommentList.addEventListener(
                    'dragend',
                    clearProjectCommentDragState
                );
                projectCommentList.addEventListener('keydown', function (event) {
                    if (!event.altKey || event.ctrlKey || event.metaKey
                        || (event.key !== 'ArrowUp'
                            && event.key !== 'ArrowDown')
                        || state.pendingProjectCommentRequest) {
                        return;
                    }
                    var handle = event.target && event.target.closest
                        ? event.target.closest('[data-project-comment-drag-handle]')
                        : null;
                    var item = handle && handle.closest('[data-project-comment-id]');
                    if (!handle || !item || handle.disabled) return;
                    var visibleIds = visibleProjectComments().map(
                        function (comment) {
                            return comment.id;
                        }
                    );
                    var sourceId = item.getAttribute('data-project-comment-id');
                    var sourceIndex = visibleIds.indexOf(sourceId);
                    var targetIndex = sourceIndex
                        + (event.key === 'ArrowUp' ? -1 : 1);
                    if (sourceIndex < 0
                        || targetIndex < 0
                        || targetIndex >= visibleIds.length) {
                        return;
                    }
                    event.preventDefault();
                    postProjectCommentReorder(
                        sourceId,
                        visibleIds[targetIndex],
                        event.key === 'ArrowUp' ? 'before' : 'after'
                    );
                });
            }
        }

        function handleEnterShortcut(event) {
            var eventTarget = event.target;
            if (projectCommentsAvailable && eventTarget && eventTarget.matches) {
                if (eventTarget.matches('[data-project-comment-draft-tag-input]')) {
                    if (event.key === 'Enter' && !event.ctrlKey
                        && !event.metaKey && !event.altKey) {
                        event.preventDefault();
                        commitProjectDraftTag(eventTarget.value);
                        return true;
                    }
                    return false;
                }
                if (eventTarget.matches('[data-project-comment-tag-input]')) {
                    if (event.key === 'Enter' && !event.ctrlKey
                        && !event.metaKey && !event.altKey
                        && state.projectTagEditor) {
                        event.preventDefault();
                        var editor = state.projectTagEditor;
                        state.projectTagEditor = null;
                        var tag = normalizeProjectTag(editor.draft);
                        if (tag) {
                            postProjectCommentOperation('addTag', {
                                commentId: editor.commentId,
                                tag: tag,
                            });
                        } else {
                            renderProjectComments();
                        }
                        return true;
                    }
                    return false;
                }
            }
            if (eventTarget && eventTarget.matches
                && eventTarget.matches('[data-comment-tag-input]')) {
                if (event.key === 'Enter' && !event.ctrlKey
                    && !event.metaKey && !event.altKey
                    && state.sessionTagEditor) {
                    event.preventDefault();
                    var sessionEditor = state.sessionTagEditor;
                    state.sessionTagEditor = null;
                    var sessionTag = normalizeProjectTag(sessionEditor.draft);
                    if (sessionTag) {
                        postCommentOperation('addTag', {
                            commentId: sessionEditor.commentId,
                            tag: sessionTag,
                        });
                    } else {
                        renderComments();
                    }
                    return true;
                }
                return false;
            }
            if (!commentUiAvailable
                || event.key !== 'Enter'
                || (!event.ctrlKey && !event.metaKey)
                || event.altKey) {
                return false;
            }
            var target = event.target;
            if (projectCommentsAvailable && target === projectCommentInput) {
                event.preventDefault();
                addProjectCommentFromComposer();
                return true;
            }
            if (projectCommentsAvailable && target
                && target.matches?.('[data-project-comment-edit]')) {
                var projectCard = target.closest('[data-project-comment-id]');
                var projectSave = projectCard?.querySelector(
                    '[data-project-comment-action="update"]'
                );
                if (projectSave) {
                    event.preventDefault();
                    projectSave.click();
                    return true;
                }
            }
            if (target === commentInput && !commentComposer.hidden) {
                event.preventDefault();
                commentComposer.querySelector(
                    '[data-comment-action="confirm-add"]'
                )?.click();
                return true;
            }
            if (target && target.matches?.('[data-comment-edit]')) {
                var item = target.closest('[data-comment-id]');
                var save = item?.querySelector(
                    '[data-comment-action="update"]'
                );
                if (save) {
                    event.preventDefault();
                    save.click();
                    return true;
                }
            }
            return false;
        }

        function handleEscape(event) {
            if (projectCommentsAvailable
                && state.projectDraftTagInputOpen) {
                event.preventDefault();
                closeProjectDraftTagInput();
                return true;
            }
            if (projectCommentsAvailable
                && !state.editingProjectComment
                && !state.projectTagEditor
                && !projectCommentComposer.hidden
                && !state.pendingProjectCommentRequest) {
                event.preventDefault();
                closeProjectCommentComposer();
                return true;
            }
            if (projectCommentsAvailable && state.projectTagEditor) {
                event.preventDefault();
                if (!state.pendingProjectCommentRequest) {
                    state.projectTagEditor = null;
                    renderProjectComments();
                }
                return true;
            }
            if (commentUiAvailable && state.sessionTagEditor) {
                event.preventDefault();
                if (!state.pendingCommentRequest
                    && !state.pendingLocateRequest) {
                    state.sessionTagEditor = null;
                    renderComments();
                }
                return true;
            }
            if (projectCommentsAvailable && state.editingProjectComment) {
                event.preventDefault();
                if (!state.pendingProjectCommentRequest) {
                    state.editingProjectComment = null;
                    renderProjectComments();
                    status.textContent = 'Edit cancelled.';
                }
                return true;
            }
            if (commentUiAvailable && state.clearAllConfirmation) {
                event.preventDefault();
                resetClearAllConfirmation();
                status.textContent = 'Clear all cancelled.';
                commentClearAll.focus();
                return true;
            }
            if (commentUiAvailable && state.editingComment) {
                event.preventDefault();
                if (!state.pendingCommentRequest
                    && !state.pendingLocateRequest) {
                    state.editingComment = null;
                    renderComments();
                    status.textContent = 'Edit cancelled.';
                }
                return true;
            }
            if (commentUiAvailable && !commentComposer.hidden) {
                event.preventDefault();
                closeCommentComposer();
                return true;
            }
            return false;
        }

        function initializeComments() {
            state.filter = readCommentsFilter();
            readCommentSectionState();
            applyCommentSectionState();
            restoreSessionRegionHeight();
            if (projectCommentsAvailable) {
                state.projectTagFilter = readProjectTagFilter();
                var initialProjectComments = readJsonAttribute(
                    'data-initial-project-comments'
                );
                if (validInitialProjectComments(initialProjectComments)) {
                    state.projectCommentRevision
                        = initialProjectComments.revision;
                    state.projectComments = initialProjectComments.comments
                        .map(cloneProjectComment);
                    renderProjectComments();
                } else {
                    projectCommentEmpty.hidden = false;
                    projectCommentEmpty.textContent =
                        'Project notes are unavailable.';
                }
            }
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

        function resetSession(target, generation, snapshot, projectSnapshot) {
            if (!validInitialComments(snapshot)
                || (projectCommentsAvailable
                    && !validInitialProjectComments(projectSnapshot))) {
                return false;
            }
            commentTarget = target;
            subscriptionGeneration = generation;
            state.comments = snapshot.comments.map(function (comment) {
                return Object.assign({}, comment);
            });
            state.commentRevision = snapshot.revision;
            state.pendingCommentRequest = null;
            state.pendingLocateRequest = null;
            state.editingComment = null;
            state.expandedDoneComments.clear();
            if (projectCommentsAvailable) {
                state.projectComments = projectSnapshot.comments.map(
                    cloneProjectComment
                );
                state.projectCommentRevision = projectSnapshot.revision;
                state.pendingProjectCommentRequest = null;
                state.editingProjectComment = null;
                state.projectTagEditor = null;
                state.expandedDoneProjectComments.clear();
                closeProjectCommentComposer();
                renderProjectComments();
            }
            if (!commentUiAvailable) {
                return true;
            }
            closeCommentComposer();
            renderComments();
            updateCommentHighlights();
            return true;
        }

        return Object.freeze({
            applyCommentsResult: applyCommentsResult,
            applyLocateResult: applyLocateResult,
            applyProjectCommentsResult: applyProjectCommentsResult,
            attach: attach,
            canResetProjectComments: validInitialProjectComments,
            canResetSession: validInitialComments,
            handleEnterShortcut: handleEnterShortcut,
            handleEscape: handleEscape,
            initializeComments: initializeComments,
            openCount: openCommentCount,
            resetSession: resetSession,
            sendOpenComments: function () {
                postCommentOperation('sendComments', {});
            },
            updateHighlights: updateCommentHighlights,
        });
    }

    window.__agentPivotConversationComments = Object.freeze({ create: create });
}());
