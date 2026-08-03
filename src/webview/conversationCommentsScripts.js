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
        var headerSend = options.headerSend;
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
        var commentNew = options.commentNew;
        var commentSend = options.commentSend;
        var commentClearSent = options.commentClearSent;
        var commentClearResolved = options.commentClearResolved;
        var commentClearAll = options.commentClearAll;
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
            commentClearAll.textContent = 'All';
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
            if (commentCount) {
                commentCount.textContent = String(state.comments.length);
                commentCount.setAttribute(
                    'aria-label',
                    state.comments.length + ' comment'
                        + (state.comments.length === 1 ? '' : 's')
                );
            }
            commentSend.disabled = counts.open === 0 || pending;
            if (headerSend) {
                headerSend.disabled = counts.open === 0 || pending;
                headerSend.textContent = counts.open > 0
                    ? 'Send ' + counts.open
                    : 'Send';
            }
            if (telemetryComments) {
                // The pill doubles as the Comments quick entry; keep it
                // visible even at zero.
                telemetryComments.hidden = false;
                telemetryComments.textContent = 'Comments '
                    + state.comments.length;
                telemetryComments.title = state.comments.length
                    + (state.comments.length === 1 ? ' comment' : ' comments')
                    + ' — click to review';
                if (telemetrySection) {
                    telemetrySection.hidden = false;
                }
            }
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
            if (headerSend) {
                headerSend.disabled = pending;
            }
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
                subscriptionGeneration: subscriptionGeneration,
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
            updateToggle();
            commentEmpty.hidden = state.comments.length > 0;
            var openCount = openCommentCount();
            commentSend.textContent = 'Send ' + openCount + ' open comment'
                + (openCount === 1 ? '' : 's');
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
                || message.subscriptionGeneration !== subscriptionGeneration
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
            if (commentUiAvailable && !commentComposer.hidden) {
                event.preventDefault();
                closeCommentComposer();
                return true;
            }
            return false;
        }

        function initializeComments() {
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
