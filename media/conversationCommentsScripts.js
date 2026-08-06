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
        var commentSummary = options.commentSummary;
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
            var allowed = required.concat(['scope', 'createdAt', 'sentAt']);
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
            var summary = [];
            if (counts.open) summary.push(counts.open + ' open');
            if (counts.done) summary.push(counts.done + ' done');
            commentSummary.textContent = summary.length
                ? summary.join(' · ')
                : 'No comments yet';
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
                var statusLabel = document.createElement('span');
                statusLabel.className = 'conversation-comment-status';
                statusLabel.setAttribute('data-comment-status-label', '');
                statusLabel.textContent = comment.status === 'open'
                    ? 'Open'
                    : 'Done';
                heading.appendChild(statusLabel);
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
                commentList.appendChild(item);
            });
            updateToggle();
            commentEmpty.hidden = state.comments.length > 0;
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

        function attach() {
            if (!commentUiAvailable) return;
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
        }

        function handleEnterShortcut(event) {
            if (!commentUiAvailable
                || event.key !== 'Enter'
                || (!event.ctrlKey && !event.metaKey)
                || event.altKey) {
                return false;
            }
            var target = event.target;
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

        return Object.freeze({
            applyCommentsResult: applyCommentsResult,
            applyLocateResult: applyLocateResult,
            attach: attach,
            handleEnterShortcut: handleEnterShortcut,
            handleEscape: handleEscape,
            initializeComments: initializeComments,
            openCount: openCommentCount,
            sendOpenComments: function () {
                postCommentOperation('sendComments', {});
            },
            updateHighlights: updateCommentHighlights,
        });
    }

    window.__agentPivotConversationComments = Object.freeze({ create: create });
}());
