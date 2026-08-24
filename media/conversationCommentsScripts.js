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
        var runSelection = addComment
            ? addComment.querySelector('[data-comment-selection-action="run"]')
            : null;
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
        // An adjacent-generation Viewer wrapper may predate the tab options
        // while rendering this tabbed document. Resolve the authoritative
        // DOM directly so the newer Comments module remains available.
        var sessionCommentsTab = options.sessionCommentsTab
            || (commentsRoot
                ? commentsRoot.querySelector('[data-comments-tab="session"]')
                : null);
        var workspaceCommentsTab = options.workspaceCommentsTab
            || (commentsRoot
                ? commentsRoot.querySelector('[data-comments-tab="workspace"]')
                : null);
        var sessionCommentsPane = options.sessionCommentsPane
            || (commentsRoot
                ? commentsRoot.querySelector('[data-comments-panel="session"]')
                : null);
        var workspaceCommentsPane = options.workspaceCommentsPane
            || (commentsRoot
                ? commentsRoot.querySelector('[data-comments-panel="workspace"]')
                : null);
        var projectCommentComposer = options.projectCommentComposer;
        var projectCommentSource = options.projectCommentSource;
        var projectCommentSourceLabel = options.projectCommentSourceLabel;
        var projectCommentSourceQuote = options.projectCommentSourceQuote;
        var projectCommentInput = options.projectCommentInput;
        var projectCommentDraftTags = options.projectCommentDraftTags;
        var projectCommentAddTag = options.projectCommentAddTag;
        var projectCommentAdd = options.projectCommentAdd;
        var commentsFilterBar = options.commentsFilterBar;
        var projectCommentList = options.projectCommentList;
        var projectCommentEmpty = options.projectCommentEmpty;
        var conversationMessageSelector = options.messageSelector;
        var conversationMessageId = options.messageId;
        var setSidebarView = options.setSidebarView;
        var state = {
            comments: [],
            commentRevision: 0,
            commentRequestSequence: 0,
            pendingCommentRequest: null,
            pendingLocateRequest: null,
            clearAllConfirmation: false,
            selectedCommentText: null,
            selectedRunnableCommand: false,
            editingComment: null,
            expandedDoneComments: new Set(),
            expandedClampedComments: new Set(),
            draggedCommentId: null,
            commentsPanelFilters: { session: null, workspace: null },
            activeTab: 'session',
            previousTab: null,
            projectComments: [],
            projectCommentRevision: 0,
            projectCommentRequestSequence: 0,
            pendingProjectCommentRequest: null,
            projectDraftTags: [],
            projectDraftTagInputOpen: false,
            projectPendingSource: null,
            editingProjectComment: null,
            projectTagEditor: null,
            expandedDoneProjectComments: new Set(),
            expandedClampedProjectComments: new Set(),
            draggedProjectCommentId: null,
            sessionTagEditor: null,
            projectClearAllConfirmation: false,
        };

        function stateField(key) {
            return {
                get: function () { return state[key]; },
                set: function (value) { state[key] = value; },
            };
        }

        function buildResultValidator(spec) {
            return function (value) {
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
                    && value.type === spec.type
                    && value.version === 1
                    && typeof value.requestId === 'string'
                    && Number.isSafeInteger(value.subscriptionGeneration)
                    && typeof value.projectId === 'string'
                    && (value.provider === 'codex'
                        || value.provider === 'kimi'
                        || value.provider === 'claude')
                    && typeof value.sessionId === 'string'
                    && spec.operations.indexOf(value.operation) >= 0
                    && typeof value.success === 'boolean'
                    && Number.isSafeInteger(value.revision)
                    && value.revision >= 0
                    && Array.isArray(value.comments)
                    && value.comments.length <= spec.maxComments
                    && value.comments.every(spec.isValidItem)
                    && (value.error === undefined || [
                        'invalid', 'stale', 'limit', 'tooLarge',
                        'unavailable', 'busy', 'conflict', 'failed',
                    ].includes(value.error));
            };
        }

        function nextStackRequestId(stack) {
            var sequence = stack.requestSequence.get() + 1;
            stack.requestSequence.set(sequence);
            return [
                stack.requestIdPrefix,
                Date.now().toString(36),
                sequence.toString(36),
            ].join(':');
        }

        function stackErrorMessage(stack, error) {
            return stack.errorMessages[error] || stack.errorMessages.failed;
        }

        var PROJECT_COMMENT_OPERATIONS = [
            'add', 'update', 'delete', 'setStatus', 'addTag', 'removeTag',
            'reorder', 'clearDone', 'clearAll',
        ];

        var sessionStack = {
            available: commentUiAvailable,
            comments: stateField('comments'),
            revision: stateField('commentRevision'),
            requestSequence: stateField('commentRequestSequence'),
            pendingRequest: stateField('pendingCommentRequest'),
            editing: stateField('editingComment'),
            clearAllConfirmation: stateField('clearAllConfirmation'),
            tagEditor: stateField('sessionTagEditor'),
            requestIdPrefix: 'conversation-comment',
            statusPrefix: '',
            actionAttribute: 'data-comment-action',
            tagInputAttribute: 'data-comment-tag-input',
            statusToggleAction: null,
            isValidResult: buildResultValidator({
                type: 'conversation-viewer-comments-result',
                operations: [
                    'add', 'update', 'delete', 'reorder', 'addTag',
                    'removeTag', 'clearDone', 'clearAll', 'sendComments',
                    'sendComment',
                ],
                isValidItem: validComment,
                maxComments: 20,
            }),
            cloneItem: function (comment) {
                return Object.assign({}, comment);
            },
            noteSentComments: function (message) {
                // Keep freshly sent cards expanded once so a card does not
                // appear to vanish right after sending.
                if (!message.success
                    || (message.operation !== 'sendComment'
                        && message.operation !== 'sendComments')) {
                    return;
                }
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
            },
            afterSettle: null,
            render: renderComments,
            list: commentList,
            idAttribute: 'data-comment-id',
            dragHandleAttribute: 'data-comment-drag-handle',
            draggedId: stateField('draggedCommentId'),
            visibleIds: function () {
                return visibleCommentEntries().map(function (entry) {
                    return entry.comment.id;
                });
            },
            settledStatus: function (operation) {
                return operation === 'sendComments'
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
            },
            errorMessages: {
                stale: 'Comments changed. Review the latest draft and try again.',
                limit: 'A maximum of 20 comments can be added at once.',
                tooLarge: 'The combined comments are too large to send.',
                busy: 'Wait for the current AI response to finish, then send again.',
                conflict: 'Multiple runtimes match this session. Resolve the conflict first.',
                unavailable: 'This session is unavailable and the comments were not added.',
                failed: 'The comment action failed. Your comments were kept.',
            },
            pendingRoots: [
                sessionCommentsHeader,
                sessionCommentsContent,
            ].filter(Boolean),
            popover: addComment,
            busyRoot: commentsRoot,
            heldDisabled: function (control) {
                var card = control.matches
                    && control.matches('[data-comment-drag-handle]')
                    ? control.closest('[data-comment-id]')
                    : null;
                return !!card
                    && !!state.editingComment
                    && card.getAttribute('data-comment-id')
                        === state.editingComment.commentId;
            },
            onPendingCleared: function () {
                updateCommentControls();
                if (projectCommentsAvailable) {
                    updateWorkspaceHeaderControls();
                }
            },
            gateOnLocate: true,
            sendOperations: ['sendComments', 'sendComment'],
            sendMessageType: 'conversation-viewer-send-comments',
            mutationMessageType: 'conversation-viewer-comment-mutation',
            pendingStatus: function (operation) {
                return operation === 'sendComments'
                    ? 'Adding comments to session input…'
                    : operation === 'sendComment'
                        ? 'Adding comment to session input…'
                        : operation === 'clearDone'
                            || operation === 'clearAll'
                            ? 'Clearing comments…'
                            : operation === 'reorder'
                                ? 'Saving comment order…'
                                : 'Saving comment…';
            },
            clearAllScope: sessionCommentsHeader,
            clearAllSelector: '[data-comment-action="clearAll"]',
            clearAllLabel: 'Clear all comments',
        };

        var projectStack = {
            available: projectCommentsAvailable,
            comments: stateField('projectComments'),
            revision: stateField('projectCommentRevision'),
            requestSequence: stateField('projectCommentRequestSequence'),
            pendingRequest: stateField('pendingProjectCommentRequest'),
            editing: stateField('editingProjectComment'),
            clearAllConfirmation: stateField('projectClearAllConfirmation'),
            tagEditor: stateField('projectTagEditor'),
            requestIdPrefix: 'project-comment',
            statusPrefix: 'Workspace: ',
            actionAttribute: 'data-project-comment-action',
            tagInputAttribute: 'data-project-comment-tag-input',
            statusToggleAction: 'toggle-status',
            isValidResult: buildResultValidator({
                type: 'conversation-viewer-project-comments-result',
                operations: PROJECT_COMMENT_OPERATIONS.concat([
                    'sendProjectComment', 'sendProjectComments',
                ]),
                isValidItem: validProjectComment,
                maxComments: 50,
            }),
            cloneItem: cloneProjectComment,
            noteSentComments: null,
            afterSettle: updateCommentControls,
            render: renderProjectComments,
            list: projectCommentList,
            idAttribute: 'data-project-comment-id',
            dragHandleAttribute: 'data-project-comment-drag-handle',
            draggedId: stateField('draggedProjectCommentId'),
            visibleIds: function () {
                return visibleProjectComments().map(function (comment) {
                    return comment.id;
                });
            },
            settledStatus: function (operation) {
                return operation === 'sendProjectComment'
                    ? 'Note added to session input. Review and press Enter to send.'
                    : operation === 'sendProjectComments'
                        ? 'Notes added to session input. Review and press Enter to send.'
                        : operation === 'delete'
                            ? 'Project note deleted.'
                            : operation === 'clearDone'
                                ? 'Done notes cleared.'
                                : operation === 'clearAll'
                                    ? 'All notes cleared.'
                                    : operation === 'reorder'
                                        ? 'Note order saved.'
                                        : 'Project note saved.';
            },
            errorMessages: {
                stale: 'Project notes changed. Review the latest notes and try again.',
                limit: 'The project note limit was reached (50 notes, 5 tags per note, or 20 distinct tags).',
                tooLarge: 'The project note is too large to send.',
                busy: 'Wait for the current AI response to finish, then send again.',
                conflict: 'Multiple runtimes match this session. Resolve the conflict first.',
                unavailable: 'This session is unavailable and the note was not added.',
                failed: 'The project note action failed. Your notes were kept.',
            },
            pendingRoots: [projectCommentsRoot, projectCommentsHeader]
                .filter(Boolean),
            popover: null,
            busyRoot: projectCommentsRoot,
            heldDisabled: function () {
                return false;
            },
            onPendingCleared: function () {
                updateProjectComposerControls();
                updateWorkspaceHeaderControls();
            },
            gateOnLocate: false,
            sendOperations: ['sendProjectComment', 'sendProjectComments'],
            sendMessageType: 'conversation-viewer-send-project-comment',
            mutationMessageType: 'conversation-viewer-project-comment-mutation',
            pendingStatus: function (operation) {
                return operation === 'sendProjectComment'
                    ? 'Adding note to session input…'
                    : 'Saving project note…';
            },
            clearAllScope: projectCommentsHeader,
            clearAllSelector: '[data-project-comment-action="clear-all"]',
            clearAllLabel: 'Clear all notes',
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

        function commentStatusCounts() {
            return state.comments.reduce(function (counts, comment) {
                counts[comment.status] += 1;
                return counts;
            }, { open: 0, done: 0 });
        }

        function workspaceNoteOpenCount() {
            if (!projectCommentsAvailable) return 0;
            return state.projectComments.reduce(function (count, note) {
                return note.status === 'open' ? count + 1 : count;
            }, 0);
        }

        function writeCommentsTabLabel(tab, name, openCount, noun) {
            if (!tab) return;
            var count = tab.querySelector('[data-comments-tab-count]');
            if (count) {
                count.textContent = '· ' + openCount;
            }
            var label = name + ': ' + openCount + ' open ' + noun;
            tab.title = label;
            tab.setAttribute('aria-label', label);
        }

        function updateCommentsTabLabels() {
            if (!commentUiAvailable) return;
            var workspaceCounts = { open: 0, done: 0 };
            if (projectCommentsAvailable) {
                state.projectComments.forEach(function (comment) {
                    workspaceCounts[comment.status] += 1;
                });
            }
            writeCommentsTabLabel(
                sessionCommentsTab,
                'Session',
                commentStatusCounts().open,
                'comments'
            );
            writeCommentsTabLabel(
                workspaceCommentsTab,
                'Workspace',
                workspaceCounts.open,
                'notes'
            );
        }

        function resetStackClearAllConfirmation(stack) {
            if (!stack.available) return;
            stack.clearAllConfirmation.set(false);
            var clearAll = stack.clearAllScope.querySelector(
                stack.clearAllSelector
            );
            if (clearAll) {
                clearAll.removeAttribute('data-confirming');
                clearAll.title = stack.clearAllLabel;
                clearAll.setAttribute('aria-label', stack.clearAllLabel);
            }
        }

        function updateCommentControls() {
            if (!commentUiAvailable) return;
            var counts = commentStatusCounts();
            var pending = !!state.pendingCommentRequest
                || !!state.pendingLocateRequest;
            updateCommentsTabLabels();
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
                var sessionOpenCount = counts.open;
                var workspaceOpenCount = workspaceNoteOpenCount();
                var visibleCommentCount = sessionOpenCount
                    + ' · ' + workspaceOpenCount;
                if (telemetryCommentValue) {
                    telemetryCommentValue.textContent = visibleCommentCount;
                } else {
                    telemetryComments.textContent = visibleCommentCount;
                }
                var telemetryCommentLabel = sessionOpenCount
                    + ' open session comment'
                    + (sessionOpenCount === 1 ? '' : 's')
                    + ' · '
                    + workspaceOpenCount
                    + ' open workspace note'
                    + (workspaceOpenCount === 1 ? '' : 's')
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

        function setStackPending(stack, pending) {
            if (!stack.available) return;
            stack.pendingRoots.forEach(function (root) {
                Array.prototype.forEach.call(
                    root.querySelectorAll('button, textarea, input'),
                    function (control) {
                        control.disabled = pending
                            || stack.heldDisabled(control);
                    }
                );
            });
            if (stack.popover) {
                Array.prototype.forEach.call(
                    stack.popover.querySelectorAll('button'),
                    function (control) {
                        control.disabled = pending;
                    }
                );
            }
            if (!pending) {
                stack.onPendingCleared();
            }
            stack.busyRoot.setAttribute(
                'aria-busy',
                pending ? 'true' : 'false'
            );
            updateFilterBarPending();
        }

        function postStackOperation(stack, operation, payload, focusCommentId) {
            if (!stack.available
                || stack.pendingRequest.get()
                || (stack.gateOnLocate && state.pendingLocateRequest)) return;
            var requestId = nextStackRequestId(stack);
            resetStackClearAllConfirmation(stack);
            stack.pendingRequest.set({
                requestId: requestId,
                operation: operation,
                focusCommentId: focusCommentId || null,
            });
            setStackPending(stack, true);
            status.textContent = stack.pendingStatus(operation);
            post({
                type: stack.sendOperations.indexOf(operation) >= 0
                    ? stack.sendMessageType
                    : stack.mutationMessageType,
                version: 1,
                requestId: requestId,
                subscriptionGeneration: subscriptionGeneration,
                projectId: commentTarget.projectId,
                provider: commentTarget.provider,
                sessionId: commentTarget.sessionId,
                operation: operation,
                expectedRevision: stack.revision.get(),
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
            var requestId = nextStackRequestId(sessionStack);
            state.pendingLocateRequest = {
                requestId: requestId,
                commentId: comment.id,
            };
            setStackPending(sessionStack, true);
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

        function commentIconButton(
            actionAttribute,
            action,
            icon,
            label,
            modifier
        ) {
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'conversation-comment-icon-button'
                + (modifier ? ' ' + modifier : '');
            button.setAttribute(actionAttribute, action);
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

        function validPanelFilter(filter) {
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
        }

        function readCommentsPanelFilters() {
            var fallback = { session: null, workspace: null };
            if (!vscodeApi || typeof vscodeApi.getState !== 'function') {
                return fallback;
            }
            try {
                var saved = vscodeApi.getState();
                var filter = saved && saved.conversationCommentsPanelFilter;
                if (!filter || typeof filter !== 'object'
                    || Array.isArray(filter)) {
                    return fallback;
                }
                // v1 kept one filter shared by both stacks; it becomes the
                // session filter.
                if (filter.type) {
                    return {
                        session: validPanelFilter(filter),
                        workspace: null,
                    };
                }
                return {
                    session: validPanelFilter(filter.session),
                    workspace: validPanelFilter(filter.workspace),
                };
            } catch (_error) {
                return fallback;
            }
        }

        function saveCommentsPanelFilter() {
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
                next.conversationCommentsPanelFilter
                    = state.commentsPanelFilters;
                vscodeApi.setState(next);
            } catch (_error) {
                // Filter persistence is best-effort local Webview state.
            }
        }

        function updateFilterButtons() {
            renderCommentsFilterBar();
        }

        function commentMatchesPanelFilter(comment, filter) {
            if (!filter) return true;
            if (filter.type === 'status') {
                return comment.status === filter.value;
            }
            return (comment.tags || []).some(function (tag) {
                return tag.toLowerCase() === filter.value;
            });
        }

        function visibleCommentEntries() {
            var filter = state.commentsPanelFilters.session;
            return state.comments
                .map(function (comment, index) {
                    return { comment: comment, index: index };
                })
                .filter(function (entry) {
                    return commentMatchesPanelFilter(entry.comment, filter);
                });
        }

        // Long-comment clamping: open cards render their body inside a
        // clampable container (CSS max-height, full text stays in the DOM).
        // A per-card toggle expands/collapses; expansion is in-memory only.
        function markCommentClampable(element) {
            element.classList.add('conversation-comment-clampable');
            element.classList.add('is-clamped');
            var fade = document.createElement('div');
            fade.className = 'conversation-comment-clamp-fade';
            fade.setAttribute('aria-hidden', 'true');
            element.appendChild(fade);
        }

        function createCommentClampToggle(toggleAttribute, expanded) {
            var toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'conversation-comment-clamp-toggle';
            toggle.setAttribute(toggleAttribute, '');
            toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
            toggle.textContent = expanded ? 'Show less' : 'Show more';
            return toggle;
        }

        function measureCommentCardClamps(
            list,
            idAttribute,
            toggleAttribute,
            expandedSet
        ) {
            if (!list) return;
            var cards = list.querySelectorAll('[' + idAttribute + ']');
            Array.prototype.forEach.call(cards, function (card) {
                // A zero-height card is inside a hidden panel; keep the last
                // measurement instead of mistaking layout absence for fit.
                if (!card.offsetHeight) return;
                var toggle = card.querySelector('[' + toggleAttribute + ']');
                if (card.getAttribute('data-comment-status') !== 'open') {
                    // Done cards never clamp; drop a stale toggle if the
                    // card flipped status while present in the expanded set.
                    if (toggle) toggle.remove();
                    return;
                }
                var id = card.getAttribute(idAttribute);
                if (id && expandedSet.has(id)) {
                    if (!toggle) {
                        card.appendChild(
                            createCommentClampToggle(toggleAttribute, true)
                        );
                    }
                    return;
                }
                var clampable = card.querySelectorAll(
                    '.conversation-comment-clampable'
                );
                if (!clampable.length) return;
                var overflow = false;
                Array.prototype.forEach.call(clampable, function (element) {
                    // Hidden subtrees (closed panel) report zero heights;
                    // the ResizeObserver re-measures once they become visible.
                    var elementOverflows
                        = element.scrollHeight > element.clientHeight + 1;
                    if (elementOverflows) {
                        element.classList.add('is-clamped');
                        overflow = true;
                    } else {
                        element.classList.remove('is-clamped');
                    }
                });
                if (!overflow) {
                    Array.prototype.forEach.call(clampable, function (element) {
                        element.classList.remove('is-clamped');
                    });
                    if (toggle) toggle.remove();
                    return;
                }
                if (!toggle) {
                    card.appendChild(
                        createCommentClampToggle(toggleAttribute, false)
                    );
                } else {
                    toggle.textContent = 'Show more';
                    toggle.setAttribute('aria-expanded', 'false');
                }
            });
        }

        function measureAllCommentClamps() {
            if (commentUiAvailable) {
                measureCommentCardClamps(
                    commentList,
                    'data-comment-id',
                    'data-comment-clamp-toggle',
                    state.expandedClampedComments
                );
            }
            if (projectCommentsAvailable) {
                measureCommentCardClamps(
                    projectCommentList,
                    'data-project-comment-id',
                    'data-project-comment-clamp-toggle',
                    state.expandedClampedProjectComments
                );
            }
        }

        function renderComments() {
            if (!commentUiAvailable) return;
            clearStackDragState(sessionStack);
            resetStackClearAllConfirmation(sessionStack);
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
            state.expandedClampedComments.forEach(function (id) {
                if (!ids.has(id)) {
                    state.expandedClampedComments.delete(id);
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
                        'data-comment-action',
                        'update',
                        COMMENT_ICONS.save,
                        'Save comment (Ctrl+Enter or Cmd+Enter)'
                    ));
                    actions.appendChild(commentIconButton(
                        'data-comment-action',
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
                        buildCommentTagsRow(sessionStack, comment)
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
                        'data-comment-action',
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
                        buildCommentTagsRow(sessionStack, comment)
                    );
                    commentList.appendChild(item);
                    return;
                }

                if (comment.status === 'done') {
                    var collapse = commentIconButton(
                        'data-comment-action',
                        'toggle-done',
                        COMMENT_ICONS.chevron,
                        'Collapse comment'
                    );
                    collapse.setAttribute('aria-expanded', 'true');
                    actions.appendChild(collapse);
                }
                if (comment.status === 'open') {
                    actions.appendChild(commentIconButton(
                        'data-comment-action',
                        'send-comment',
                        COMMENT_ICONS.send,
                        'Send this comment to the session'
                    ));
                }
                if (comment.scope !== 'session') {
                    actions.appendChild(commentIconButton(
                        'data-comment-action',
                        'locate',
                        COMMENT_ICONS.locate,
                        'Show commented text'
                    ));
                }
                actions.appendChild(commentIconButton(
                    'data-comment-action',
                    'edit-comment',
                    COMMENT_ICONS.edit,
                    'Edit comment'
                ));
                actions.appendChild(commentIconButton(
                    'data-comment-action',
                    'delete',
                    COMMENT_ICONS.remove,
                    'Delete comment',
                    'danger'
                ));

                var clampExpanded = state.expandedClampedComments.has(
                    comment.id
                );
                var body = document.createElement('div');
                body.className = 'conversation-comment-body';
                body.textContent = comment.comment;
                if (comment.status === 'open' && !clampExpanded) {
                    markCommentClampable(body);
                }
                item.appendChild(body);
                if (comment.scope !== 'session') {
                    var quoteGroup = document.createElement('div');
                    quoteGroup.className = 'conversation-comment-quote';
                    var quoteLabel = document.createElement('span');
                    quoteLabel.className = 'conversation-comment-quote-label';
                    quoteLabel.textContent = 'Selected text';
                    var quote = document.createElement('blockquote');
                    quote.textContent = comment.quote;
                    if (comment.status === 'open' && !clampExpanded) {
                        markCommentClampable(quote);
                    }
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
                    buildCommentTagsRow(sessionStack, comment)
                );
                if (comment.status === 'open' && clampExpanded) {
                    item.appendChild(createCommentClampToggle(
                        'data-comment-clamp-toggle',
                        true
                    ));
                }
                commentList.appendChild(item);
            });
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
                    ? state.commentsPanelFilters.session
                        && state.commentsPanelFilters.session.type === 'status'
                        ? state.commentsPanelFilters.session.value === 'open'
                            ? 'No open comments.'
                            : 'No done comments.'
                        : 'No comments match this filter.'
                    : '';
            }
            updateCommentControls();
            updateCommentHighlights();
            if (state.pendingCommentRequest || state.pendingLocateRequest) {
                // Any re-render during an in-flight request must keep the
                // disabled pending state instead of reviving controls.
                setStackPending(sessionStack, true);
            }
            measureCommentCardClamps(
                commentList,
                'data-comment-id',
                'data-comment-clamp-toggle',
                state.expandedClampedComments
            );
        }

        function clearStackDragState(stack) {
            stack.draggedId.set(null);
            if (!stack.available) return;
            Array.prototype.forEach.call(
                stack.list.querySelectorAll(
                    '.conversation-comment-dragging, [data-comment-drop-position]'
                ),
                function (card) {
                    card.classList.remove('conversation-comment-dragging');
                    card.removeAttribute('data-comment-drop-position');
                }
            );
        }

        function reorderedStackCommentIds(stack, sourceId, targetId, placement) {
            var visibleIds = stack.visibleIds();
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
            var originalVisibleIds = stack.visibleIds();
            var unchanged = visibleIds.every(function (id, index) {
                return id === originalVisibleIds[index];
            });
            if (unchanged) return null;
            var visibleSet = new Set(originalVisibleIds);
            var visibleIndex = 0;
            return stack.comments.get().map(function (comment) {
                if (!visibleSet.has(comment.id)) return comment.id;
                var reorderedId = visibleIds[visibleIndex];
                visibleIndex += 1;
                return reorderedId;
            });
        }

        function postStackReorder(stack, sourceId, targetId, placement) {
            var orderedCommentIds = reorderedStackCommentIds(
                stack,
                sourceId,
                targetId,
                placement
            );
            clearStackDragState(stack);
            if (!orderedCommentIds) return false;
            postStackOperation(
                stack,
                'reorder',
                { orderedCommentIds: orderedCommentIds },
                sourceId
            );
            return true;
        }

        function focusStackDragHandle(stack, commentId) {
            if (!commentId || !stack.available) return;
            // A settlement landing while its stack's tab is hidden must not
            // try to focus a hidden card.
            if (stack === sessionStack && state.activeTab !== 'session') return;
            if (stack === projectStack && state.activeTab !== 'workspace') return;
            var card = stack.list.querySelector(
                '[' + stack.idAttribute + '="' + CSS.escape(commentId) + '"]'
            );
            var handle = card && card.querySelector(
                '[' + stack.dragHandleAttribute + ']'
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
            var initialCard = commentList.querySelector(
                '[data-comment-id="' + CSS.escape(commentId) + '"]'
            );
            var shouldExpandClamp = !!initialCard
                && comment.status === 'open'
                && !!initialCard.querySelector('[data-comment-clamp-toggle]');
            var needsRender = false;
            if (comment.status === 'done'
                && !state.expandedDoneComments.has(commentId)) {
                state.expandedDoneComments.add(commentId);
                needsRender = true;
            }
            if (!commentMatchesPanelFilter(
                comment,
                state.commentsPanelFilters.session
            )) {
                state.commentsPanelFilters.session = null;
                saveCommentsPanelFilter();
                needsRender = true;
            }
            if (needsRender) {
                renderComments();
            }
            // A marker jump always lands on the Session tab.
            setActiveTab('session', true);
            setSidebarView('comments', true, true);
            // The panel may have been hidden while renderComments() ran; now
            // that it is visible, clamp measurements are meaningful again.
            measureAllCommentClamps();
            var card = commentList.querySelector(
                '[data-comment-id="' + CSS.escape(commentId) + '"]'
            );
            if (!card) return false;
            if (shouldExpandClamp
                && !state.expandedClampedComments.has(commentId)) {
                // Reveal the full card when its content is clamped (a
                // rendered toggle means the measurement found overflow).
                state.expandedClampedComments.add(commentId);
                renderComments();
                card = commentList.querySelector(
                    '[data-comment-id="' + CSS.escape(commentId) + '"]'
                );
                if (!card) return false;
            }
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

        function settleCommentsResult(stack, message) {
            var pendingRequest = stack.pendingRequest.get();
            if (!stack.available
                || !stack.isValidResult(message)
                || message.subscriptionGeneration !== subscriptionGeneration
                || message.projectId !== commentTarget.projectId
                || message.provider !== commentTarget.provider
                || message.sessionId !== commentTarget.sessionId
                || !pendingRequest
                || message.requestId !== pendingRequest.requestId
                || message.operation !== pendingRequest.operation) {
                return false;
            }
            var operation = pendingRequest.operation;
            var focusCommentId = pendingRequest.focusCommentId;
            if (stack.noteSentComments) {
                stack.noteSentComments(message);
            }
            stack.revision.set(message.revision);
            stack.comments.set(message.comments.map(stack.cloneItem));
            if (message.success && message.operation === 'update') {
                stack.editing.set(null);
            }
            stack.render();
            stack.pendingRequest.set(null);
            setStackPending(stack, false);
            if (message.success) {
                status.textContent = stack.statusPrefix
                    + stack.settledStatus(operation);
            } else {
                status.textContent = stack.statusPrefix
                    + stackErrorMessage(stack, message.error);
            }
            if (stack.afterSettle) {
                stack.afterSettle();
            }
            focusStackDragHandle(stack, focusCommentId);
            return true;
        }

        function applyCommentsResult(message) {
            return settleCommentsResult(sessionStack, message);
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
            setStackPending(sessionStack, false);
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
                if (runSelection) runSelection.hidden = true;
                state.selectedCommentText = null;
                state.selectedRunnableCommand = false;
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
                if (runSelection) runSelection.hidden = true;
                state.selectedCommentText = null;
                state.selectedRunnableCommand = false;
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
            state.selectedRunnableCommand = isRunnableShellSelection(
                quote,
                startElement,
                endElement
            );
            if (runSelection) {
                runSelection.hidden = !state.selectedRunnableCommand;
            }
            var rect = range.getBoundingClientRect();
            // Measure the actual action count before positioning. A hidden
            // popover has zero width, which otherwise lets the new Run action
            // overflow when the selection is against the right edge.
            addComment.hidden = false;
            addComment.style.visibility = 'hidden';
            var popoverWidth = addComment.offsetWidth;
            addComment.style.left = Math.max(
                8,
                Math.min(window.innerWidth - popoverWidth - 8, rect.left)
            ) + 'px';
            addComment.style.top = Math.max(8, rect.bottom + 6) + 'px';
            addComment.style.visibility = '';
        }

        function sendSelectionToTerminal() {
            if (!state.selectedCommentText || state.pendingCommentRequest) {
                return;
            }
            var quote = state.selectedCommentText.quote;
            addComment.hidden = true;
            state.selectedCommentText = null;
            state.selectedRunnableCommand = false;
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

        var RUNNABLE_SHELL_COMMANDS = new Set([
            'awk', 'bash', 'cat', 'cd', 'chmod', 'cp', 'curl', 'docker',
            'echo', 'export', 'find', 'git', 'go', 'grep', 'kubectl', 'ls',
            'make', 'mkdir', 'mvn', 'node', 'npm', 'perl', 'pip', 'pnpm',
            'python', 'python3', 'rg', 'rm', 'sed', 'sh', 'touch', 'yarn',
            'zsh',
        ]);

        function isRunnableShellSelection(quote, startElement, endElement) {
            if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(quote)) {
                return false;
            }
            var startBlock = startElement && startElement.closest
                ? startElement.closest('.conversation-code-block')
                : null;
            var endBlock = endElement && endElement.closest
                ? endElement.closest('.conversation-code-block')
                : null;
            if (startBlock && startBlock === endBlock) {
                var code = startBlock.querySelector('pre code');
                if (code && /(?:^|\s)language-(?:bash|sh|shell|zsh)(?:\s|$)/i
                    .test(code.className || '')) {
                    return true;
                }
            }
            var command = quote.trim().replace(
                /^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*/,
                ''
            );
            var first = /^([^\s|&;<>]+)/.exec(command);
            if (!first) return false;
            return RUNNABLE_SHELL_COMMANDS.has(first[1])
                || /^(?:\.{1,2}\/|~\/|\/)/.test(first[1])
                || /(?:\|\||&&|[|;<>`$()]|\*)/.test(command);
        }

        function runSelectionInNewTerminal() {
            if (!state.selectedCommentText
                || state.pendingCommentRequest
                || !state.selectedRunnableCommand) {
                return;
            }
            var command = state.selectedCommentText.quote;
            addComment.hidden = true;
            if (runSelection) runSelection.hidden = true;
            state.selectedCommentText = null;
            state.selectedRunnableCommand = false;
            var selection = window.getSelection();
            if (selection) {
                selection.removeAllRanges();
            }
            post({
                type: 'conversation-viewer-run-command',
                version: 1,
                subscriptionGeneration: subscriptionGeneration,
                projectId: commentTarget.projectId,
                provider: commentTarget.provider,
                sessionId: commentTarget.sessionId,
                command: command,
            });
            status.textContent = 'Opening selection in a new terminal.';
        }

        function openCommentComposer() {
            if (!state.selectedCommentText) return;
            state.previousTab = state.activeTab === 'session'
                ? null
                : state.activeTab;
            setSidebarView('comments', true, true);
            setActiveTab('session', true);
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
            setActiveTab('session', true);
            addComment.hidden = true;
            state.selectedCommentText = { scope: 'session' };
            state.selectedRunnableCommand = false;
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
            state.selectedRunnableCommand = false;
            addComment.hidden = true;
        }

        var PROJECT_TAG_COLOR_COUNT = 6;

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

        function buildTagChip(tag, actionAttribute, removeAction) {
            var chip = document.createElement('span');
            chip.className = 'conversation-project-comment-tag';
            chip.setAttribute(
                'data-tag-color',
                String(projectTagColorKey(tag))
            );
            chip.appendChild(document.createTextNode(tag));
            if (removeAction) {
                var remove = document.createElement('button');
                remove.type = 'button';
                remove.setAttribute(actionAttribute, removeAction);
                remove.setAttribute('data-tag', tag);
                remove.title = 'Remove tag ' + tag;
                remove.setAttribute('aria-label', 'Remove tag ' + tag);
                remove.textContent = '\u00d7';
                chip.appendChild(remove);
            }
            return chip;
        }

        function buildCommentTagsRow(stack, comment) {
            var row = document.createElement('div');
            row.className = 'conversation-comment-tags-row';
            row.appendChild(
                buildCommentStatusChip(comment.status, stack.statusToggleAction)
            );
            var tags = comment.tags || [];
            tags.forEach(function (tag) {
                row.appendChild(
                    buildTagChip(tag, stack.actionAttribute, 'remove-tag')
                );
            });
            var tagEditor = stack.tagEditor.get();
            if (tagEditor && tagEditor.commentId === comment.id) {
                var tagInput = document.createElement('input');
                tagInput.type = 'text';
                tagInput.maxLength = 48;
                tagInput.className = 'conversation-project-comment-tag-input';
                tagInput.setAttribute(stack.tagInputAttribute, '');
                tagInput.setAttribute('aria-label', 'New tag');
                tagInput.placeholder = 'tag';
                tagInput.value = tagEditor.draft;
                row.appendChild(tagInput);
            } else if (tags.length < 5) {
                var addTag = document.createElement('button');
                addTag.type = 'button';
                addTag.className = 'conversation-project-comment-tag-add';
                addTag.setAttribute(stack.actionAttribute, 'open-tag-editor');
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
            var filter = state.commentsPanelFilters.workspace;
            if (!filter) return ordered;
            return ordered.filter(function (comment) {
                return commentMatchesPanelFilter(comment, filter);
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

        function updateWorkspaceHeaderControls() {
            if (!projectCommentsAvailable) return;
            var counts = { open: 0, done: 0 };
            state.projectComments.forEach(function (comment) {
                counts[comment.status] += 1;
            });
            var pending = !!state.pendingProjectCommentRequest;
            var openComposer = projectCommentsHeader.querySelector(
                '[data-project-comment-action="open-composer"]'
            );
            var sendAll = projectCommentsHeader.querySelector(
                '[data-project-comment-action="send-all"]'
            );
            var clearDone = projectCommentsHeader.querySelector(
                '[data-project-comment-action="clear-done"]'
            );
            var clearAll = projectCommentsHeader.querySelector(
                '[data-project-comment-action="clear-all"]'
            );
            openComposer.disabled = pending;
            var sendLabel = 'Send ' + counts.open + ' open note'
                + (counts.open === 1 ? '' : 's') + ' to the session input';
            sendAll.disabled = pending || counts.open === 0;
            sendAll.title = sendLabel;
            sendAll.setAttribute('aria-label', sendLabel);
            clearDone.disabled = pending || counts.done === 0;
            clearAll.disabled = pending || state.projectComments.length === 0;
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
                projectCommentDraftTags.appendChild(buildTagChip(
                    tag,
                    'data-project-comment-action',
                    'remove-draft-tag'
                ));
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

        function readActiveTab() {
            if (!vscodeApi || typeof vscodeApi.getState !== 'function') {
                return 'session';
            }
            try {
                var saved = vscodeApi.getState();
                return saved
                    && saved.conversationCommentsActiveTab === 'workspace'
                    ? 'workspace'
                    : 'session';
            } catch (_error) {
                return 'session';
            }
        }

        function saveActiveTab() {
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
                next.conversationCommentsActiveTab = state.activeTab;
                vscodeApi.setState(next);
            } catch (_error) {
                // Tab persistence is best-effort local Webview state.
            }
        }

        function updateFilterBarPending() {
            if (!commentUiAvailable || !commentsFilterBar) return;
            var barPending = state.activeTab === 'workspace'
                && projectCommentsAvailable
                ? !!state.pendingProjectCommentRequest
                : !!(state.pendingCommentRequest || state.pendingLocateRequest);
            Array.prototype.forEach.call(
                commentsFilterBar.querySelectorAll('button'),
                function (control) {
                    control.disabled = barPending;
                }
            );
        }

        function applyActiveTab(rerenderStack) {
            if (!commentUiAvailable) return;
            if (state.activeTab === 'workspace' && !projectCommentsAvailable) {
                state.activeTab = 'session';
            }
            var workspaceActive = state.activeTab === 'workspace';
            if (sessionCommentsTab && workspaceCommentsTab
                && sessionCommentsPane && workspaceCommentsPane) {
                workspaceCommentsTab.disabled = !projectCommentsAvailable;
                sessionCommentsTab.setAttribute(
                    'aria-selected',
                    workspaceActive ? 'false' : 'true'
                );
                workspaceCommentsTab.setAttribute(
                    'aria-selected',
                    workspaceActive ? 'true' : 'false'
                );
                sessionCommentsTab.tabIndex = workspaceActive ? -1 : 0;
                workspaceCommentsTab.tabIndex = workspaceActive ? 0 : -1;
                sessionCommentsPane.hidden = workspaceActive;
                workspaceCommentsPane.hidden = !workspaceActive;
            }
            renderCommentsFilterBar();
            // Re-render the now-visible stack as well as its filter bar. A
            // tag vocabulary can disappear while its tab is hidden; clearing
            // only the chip would leave the old empty list behind.
            if (rerenderStack !== false
                && workspaceActive && projectCommentsAvailable) {
                renderProjectComments();
            } else if (rerenderStack !== false && !workspaceActive) {
                renderComments();
            }
            updateFilterBarPending();
        }

        function setActiveTab(tab, persist) {
            if (tab !== 'session' && tab !== 'workspace') return;
            if (tab === 'workspace' && !projectCommentsAvailable) return;
            var tabChanged = state.activeTab !== tab;
            state.activeTab = tab;
            applyActiveTab(tabChanged);
            resetStackClearAllConfirmation(sessionStack);
            if (projectCommentsAvailable) {
                resetStackClearAllConfirmation(projectStack);
            }
            if (persist) {
                saveActiveTab();
            }
        }

        function returnToPreviousTab() {
            var target = state.previousTab;
            state.previousTab = null;
            if (target && target !== state.activeTab) {
                setActiveTab(target, true);
            }
        }


        function openProjectCommentComposer() {
            if (!projectCommentsAvailable
                || state.pendingProjectCommentRequest) return;
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
            state.previousTab = state.activeTab === 'workspace'
                ? null
                : state.activeTab;
            setActiveTab('workspace', true);
            updateProjectSourcePreview();
            openProjectCommentComposer();
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
            state.previousTab = null;
            closeProjectCommentComposer();
            postStackOperation(projectStack, 'add', payload);
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
                return commentIconButton(
                    'data-project-comment-action',
                    action,
                    icon,
                    label,
                    modifier
                );
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
                item.appendChild(buildCommentTagsRow(projectStack, comment));
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
                item.appendChild(buildCommentTagsRow(projectStack, comment));
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

            var projectClampExpanded = state.expandedClampedProjectComments.has(
                comment.id
            );
            var body = document.createElement('div');
            body.className = 'conversation-comment-body';
            body.textContent = comment.text;
            if (comment.status === 'open' && !projectClampExpanded) {
                markCommentClampable(body);
            }
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
                    if (comment.status === 'open'
                        && !projectClampExpanded) {
                        markCommentClampable(quote);
                    }
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
            item.appendChild(buildCommentTagsRow(projectStack, comment));
            if (comment.status === 'open' && projectClampExpanded) {
                item.appendChild(createCommentClampToggle(
                    'data-project-comment-clamp-toggle',
                    true
                ));
            }
            return item;
        }

        function renderCommentsFilterBar() {
            if (!commentUiAvailable) return;
            var workspaceTab = state.activeTab === 'workspace'
                && projectCommentsAvailable;
            var items = workspaceTab ? state.projectComments : state.comments;
            var filter = workspaceTab
                ? state.commentsPanelFilters.workspace
                : state.commentsPanelFilters.session;
            var vocabulary = [];
            var counts = new Map();
            var openCount = 0;
            var doneCount = 0;
            items.forEach(function (comment) {
                if (comment.status === 'open') {
                    openCount += 1;
                } else {
                    doneCount += 1;
                }
                (comment.tags || []).forEach(function (tag) {
                    var key = tag.toLowerCase();
                    if (!counts.has(key)) {
                        counts.set(key, 0);
                        vocabulary.push(tag);
                    }
                    counts.set(key, counts.get(key) + 1);
                });
            });
            if (filter && filter.type === 'tag' && !counts.has(filter.value)) {
                filter = null;
                if (workspaceTab) {
                    state.commentsPanelFilters.workspace = null;
                } else {
                    state.commentsPanelFilters.session = null;
                }
                saveCommentsPanelFilter();
            }
            commentsFilterBar.replaceChildren();
            commentsFilterBar.hidden = items.length === 0;
            if (!items.length) return;

            function filterChip(label, pressed, attributes) {
                var chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'conversation-comments-filter-chip';
                chip.setAttribute('data-comment-action', 'filter');
                Object.keys(attributes).forEach(function (name) {
                    chip.setAttribute(name, attributes[name]);
                });
                chip.setAttribute(
                    'aria-pressed',
                    pressed ? 'true' : 'false'
                );
                chip.appendChild(document.createTextNode(label));
                commentsFilterBar.appendChild(chip);
                return chip;
            }

            var filter = workspaceTab
                ? state.commentsPanelFilters.workspace
                : state.commentsPanelFilters.session;
            filterChip(
                'All · ' + items.length,
                filter === null,
                { 'data-comment-filter': 'all' }
            );
            ['open', 'done'].forEach(function (status) {
                var chip = filterChip(
                    (status === 'open' ? 'Open' : 'Done') + ' · '
                        + (status === 'open' ? openCount : doneCount),
                    !!filter && filter.type === 'status'
                        && filter.value === status,
                    { 'data-comment-filter': status }
                );
                var dot = document.createElement('span');
                dot.className = 'conversation-comments-filter-dot';
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
                dot.className = 'conversation-comments-filter-dot';
                dot.setAttribute(
                    'data-tag-color',
                    String(projectTagColorKey(tag))
                );
                chip.insertBefore(dot, chip.firstChild);
            });
        }

        function renderProjectComments() {
            if (!projectCommentsAvailable) return;
            clearStackDragState(projectStack);
            resetStackClearAllConfirmation(projectStack);
            renderCommentsFilterBar();
            projectCommentList.replaceChildren();
            var projectIds = new Set(state.projectComments.map(
                function (comment) {
                    return comment.id;
                }
            ));
            state.expandedClampedProjectComments.forEach(function (id) {
                if (!projectIds.has(id)) {
                    state.expandedClampedProjectComments.delete(id);
                }
            });
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
            updateCommentsTabLabels();
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
            updateWorkspaceHeaderControls();
            if (state.pendingProjectCommentRequest) {
                // Any re-render during an in-flight request must keep the
                // disabled pending state instead of reviving controls.
                setStackPending(projectStack, true);
            }
            measureCommentCardClamps(
                projectCommentList,
                'data-project-comment-id',
                'data-project-comment-clamp-toggle',
                state.expandedClampedProjectComments
            );
        }

        function applyProjectCommentsResult(message) {
            return settleCommentsResult(projectStack, message);
        }

        function attachStackDragAndDrop(stack) {
            stack.list.addEventListener('dragstart', function (event) {
                var handle = event.target && event.target.closest
                    ? event.target.closest('[' + stack.dragHandleAttribute + ']')
                    : null;
                var item = handle && handle.closest('[' + stack.idAttribute + ']');
                if (!handle || !item
                    || stack.pendingRequest.get()
                    || (stack.gateOnLocate && state.pendingLocateRequest)
                    || handle.disabled) {
                    event.preventDefault();
                    return;
                }
                stack.draggedId.set(item.getAttribute(stack.idAttribute));
                item.classList.add('conversation-comment-dragging');
                if (event.dataTransfer) {
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData(
                        'text/plain',
                        stack.draggedId.get()
                    );
                }
            });
            stack.list.addEventListener('dragover', function (event) {
                if (!stack.draggedId.get()) return;
                var item = event.target && event.target.closest
                    ? event.target.closest('[' + stack.idAttribute + ']')
                    : null;
                if (!item || !stack.list.contains(item)
                    || item.getAttribute(stack.idAttribute)
                        === stack.draggedId.get()) {
                    return;
                }
                event.preventDefault();
                if (event.dataTransfer) {
                    event.dataTransfer.dropEffect = 'move';
                }
                Array.prototype.forEach.call(
                    stack.list.querySelectorAll('[data-comment-drop-position]'),
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
            stack.list.addEventListener('drop', function (event) {
                if (!stack.draggedId.get()) return;
                var item = event.target && event.target.closest
                    ? event.target.closest('[' + stack.idAttribute + ']')
                    : null;
                if (!item || !stack.list.contains(item)) {
                    clearStackDragState(stack);
                    return;
                }
                event.preventDefault();
                var sourceId = stack.draggedId.get();
                var targetId = item.getAttribute(stack.idAttribute);
                var placement = item.getAttribute(
                    'data-comment-drop-position'
                ) || 'after';
                postStackReorder(stack, sourceId, targetId, placement);
            });
            stack.list.addEventListener('dragend', function () {
                clearStackDragState(stack);
            });
            stack.list.addEventListener('keydown', function (event) {
                if (!event.altKey || event.ctrlKey || event.metaKey
                    || (event.key !== 'ArrowUp'
                        && event.key !== 'ArrowDown')
                    || stack.pendingRequest.get()
                    || (stack.gateOnLocate && state.pendingLocateRequest)) {
                    return;
                }
                var handle = event.target && event.target.closest
                    ? event.target.closest('[' + stack.dragHandleAttribute + ']')
                    : null;
                var item = handle && handle.closest('[' + stack.idAttribute + ']');
                if (!handle || !item || handle.disabled) return;
                var visibleIds = stack.visibleIds();
                var sourceId = item.getAttribute(stack.idAttribute);
                var sourceIndex = visibleIds.indexOf(sourceId);
                var targetIndex = sourceIndex
                    + (event.key === 'ArrowUp' ? -1 : 1);
                if (sourceIndex < 0
                    || targetIndex < 0
                    || targetIndex >= visibleIds.length) {
                    return;
                }
                event.preventDefault();
                postStackReorder(
                    stack,
                    sourceId,
                    visibleIds[targetIndex],
                    event.key === 'ArrowUp' ? 'before' : 'after'
                );
            });
        }

        function attach() {
            if (!commentUiAvailable) return;
            var tabButtons = [
                sessionCommentsTab,
                workspaceCommentsTab,
            ].filter(Boolean);
            tabButtons.forEach(function (tab) {
                tab.addEventListener('click', function () {
                    state.previousTab = null;
                    setActiveTab(tab.getAttribute('data-comments-tab'), true);
                });
                tab.addEventListener('keydown', function (event) {
                    var navigable = tabButtons.filter(function (candidate) {
                        return !candidate.disabled;
                    });
                    var index = navigable.indexOf(tab);
                    var nextIndex = null;
                    if (event.key === 'ArrowLeft') {
                        nextIndex = (index - 1 + navigable.length)
                            % navigable.length;
                    } else if (event.key === 'ArrowRight') {
                        nextIndex = (index + 1) % navigable.length;
                    } else if (event.key === 'Home') {
                        nextIndex = 0;
                    } else if (event.key === 'End') {
                        nextIndex = navigable.length - 1;
                    } else {
                        return;
                    }
                    event.preventDefault();
                    var next = navigable[nextIndex];
                    state.previousTab = null;
                    setActiveTab(
                        next.getAttribute('data-comments-tab'),
                        true
                    );
                    next.focus();
                });
            });
            if (typeof ResizeObserver === 'function') {
                // Re-measure clamp overflow whenever a list changes size:
                // panel open, sidebar view switch, panel width drag. The
                // observer also covers the hidden-to-visible transition that
                // makes synchronous measurements during render meaningless.
                var clampObserver = new ResizeObserver(function () {
                    measureAllCommentClamps();
                });
                clampObserver.observe(commentList);
                if (projectCommentList) {
                    clampObserver.observe(projectCommentList);
                }
            }
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
            attachStackDragAndDrop(sessionStack);
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
                    === 'run') {
                    runSelectionInNewTerminal();
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
                var clampToggle = event.target && event.target.closest
                    ? event.target.closest('[data-comment-clamp-toggle]')
                    : null;
                if (clampToggle && commentsRoot.contains(clampToggle)) {
                    var clampCard = clampToggle.closest('[data-comment-id]');
                    var clampId = clampCard
                        ? clampCard.getAttribute('data-comment-id')
                        : null;
                    if (clampId) {
                        if (state.expandedClampedComments.has(clampId)) {
                            state.expandedClampedComments.delete(clampId);
                        } else {
                            state.expandedClampedComments.add(clampId);
                        }
                        renderComments();
                    }
                    return;
                }
                var button = event.target && event.target.closest
                    ? event.target.closest('[data-comment-action]')
                    : null;
                if (!button || !commentsRoot.contains(button)) {
                    return;
                }
                var action = button.getAttribute('data-comment-action');
                // Filter chips stay live while the *other* stack is pending;
                // everything else waits for the session stack to settle.
                var sessionPending = state.pendingCommentRequest
                    || state.pendingLocateRequest;
                if (sessionPending && (action !== 'filter'
                    || state.activeTab !== 'workspace'
                    || !projectCommentsAvailable)) {
                    return;
                }
                if (action !== 'clearAll' && state.clearAllConfirmation) {
                    resetStackClearAllConfirmation(sessionStack);
                }
                if (action === 'new') {
                    openSessionCommentComposer();
                    return;
                }
                if (action === 'cancel-add') {
                    closeCommentComposer();
                    returnToPreviousTab();
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
                    state.previousTab = null;
                    closeCommentComposer();
                    postStackOperation(sessionStack, 'add', payload);
                    return;
                }
                if (action === 'filter') {
                    var workspaceTab = state.activeTab === 'workspace'
                        && projectCommentsAvailable;
                    var statusValue = button.getAttribute(
                        'data-comment-filter'
                    );
                    var tagValue = button.getAttribute('data-tag');
                    var nextFilter = tagValue
                        ? { type: 'tag', value: tagValue.toLowerCase() }
                        : statusValue === 'open' || statusValue === 'done'
                            ? { type: 'status', value: statusValue }
                            : null;
                    var currentFilter = workspaceTab
                        ? state.commentsPanelFilters.workspace
                        : state.commentsPanelFilters.session;
                    var appliedFilter = projectCommentFilterEquals(
                        currentFilter,
                        nextFilter
                    )
                        ? null
                        : nextFilter;
                    if (workspaceTab) {
                        state.commentsPanelFilters.workspace = appliedFilter;
                    } else {
                        state.commentsPanelFilters.session = appliedFilter;
                    }
                    saveCommentsPanelFilter();
                    renderCommentsFilterBar();
                    if (workspaceTab) {
                        renderProjectComments();
                    } else {
                        renderComments();
                    }
                    return;
                }
                if (action === 'send') {
                    postStackOperation(sessionStack, 'sendComments', {});
                    return;
                }
                if (action === 'clearDone') {
                    postStackOperation(sessionStack, 'clearDone', {});
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
                    postStackOperation(sessionStack, 'clearAll', {});
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
                    postStackOperation(sessionStack, 'removeTag', {
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
                    postStackOperation(
                        sessionStack,
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
                    postStackOperation(sessionStack, 'delete', { commentId: comment.id });
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
                    postStackOperation(sessionStack, 'update', {
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
                            var headerAction = actionElement.getAttribute(
                                'data-project-comment-action'
                            );
                            if (headerAction === 'open-composer') {
                                openProjectCommentComposer();
                            } else if (headerAction === 'send-all') {
                                resetStackClearAllConfirmation(projectStack);
                                postStackOperation(
                                    projectStack,
                                    'sendProjectComments',
                                    {}
                                );
                            } else if (headerAction === 'clear-done') {
                                resetStackClearAllConfirmation(projectStack);
                                postStackOperation(projectStack, 'clearDone', {});
                            } else if (headerAction === 'clear-all') {
                                if (state.pendingProjectCommentRequest) {
                                    return;
                                }
                                if (!state.projectClearAllConfirmation) {
                                    state.projectClearAllConfirmation = true;
                                    actionElement.setAttribute(
                                        'data-confirming',
                                        'true'
                                    );
                                    actionElement.title =
                                        'Click again to confirm clear all';
                                    actionElement.setAttribute(
                                        'aria-label',
                                        'Confirm clearing all notes'
                                    );
                                    status.textContent = 'Select Clear all'
                                        + ' again to remove every note.';
                                } else {
                                    resetStackClearAllConfirmation(projectStack);
                                    postStackOperation(
                                        projectStack,
                                        'clearAll',
                                        {}
                                    );
                                }
                            }
                            return;
                        }
                    }
                );
            }
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
                    var clampToggle = event.target && event.target.closest
                        ? event.target.closest(
                            '[data-project-comment-clamp-toggle]'
                        )
                        : null;
                    if (clampToggle
                        && projectCommentsRoot.contains(clampToggle)) {
                        var clampCard = clampToggle.closest(
                            '[data-project-comment-id]'
                        );
                        var clampId = clampCard
                            ? clampCard.getAttribute('data-project-comment-id')
                            : null;
                        if (clampId) {
                            if (state.expandedClampedProjectComments.has(
                                clampId
                            )) {
                                state.expandedClampedProjectComments.delete(
                                    clampId
                                );
                            } else {
                                state.expandedClampedProjectComments.add(
                                    clampId
                                );
                            }
                            renderProjectComments();
                        }
                        return;
                    }
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
                        returnToPreviousTab();
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
                        postStackOperation(projectStack, 'setStatus', {
                            commentId: comment.id,
                            status: comment.status === 'open'
                                ? 'done'
                                : 'open',
                        });
                        return;
                    }
                    if (action === 'send') {
                        postStackOperation(projectStack, 'sendProjectComment', {
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
                        postStackOperation(projectStack, 'update', {
                            commentId: comment.id,
                            text: text,
                        });
                        return;
                    }
                    if (action === 'delete') {
                        postStackOperation(projectStack, 'delete', {
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
                        postStackOperation(projectStack, 'removeTag', {
                            commentId: comment.id,
                            tag: button.getAttribute('data-tag') || '',
                        });
                    }
                });
                attachStackDragAndDrop(projectStack);
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
                            postStackOperation(projectStack, 'addTag', {
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
                        postStackOperation(sessionStack, 'addTag', {
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
                && state.projectClearAllConfirmation) {
                event.preventDefault();
                resetStackClearAllConfirmation(projectStack);
                status.textContent = 'Clear all cancelled.';
                return true;
            }
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
                returnToPreviousTab();
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
                resetStackClearAllConfirmation(sessionStack);
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
                returnToPreviousTab();
                return true;
            }
            return false;
        }

        function initializeComments() {
            state.commentsPanelFilters = readCommentsPanelFilters();
            // Persist the v1 → v2 filter migration immediately so a later
            // legacy-shaped read cannot resurrect the shared-stack filter.
            saveCommentsPanelFilter();
            state.activeTab = readActiveTab();
            applyActiveTab();
            if (projectCommentsAvailable) {
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
                    renderProjectComments();
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
            state.sessionTagEditor = null;
            state.expandedDoneComments.clear();
            state.expandedClampedComments.clear();
            state.previousTab = null;
            if (projectCommentsAvailable) {
                state.projectComments = projectSnapshot.comments.map(
                    cloneProjectComment
                );
                state.projectCommentRevision = projectSnapshot.revision;
                state.pendingProjectCommentRequest = null;
                state.editingProjectComment = null;
                state.projectTagEditor = null;
                state.expandedDoneProjectComments.clear();
                state.expandedClampedProjectComments.clear();
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
            resetSession: resetSession,
            updateHighlights: updateCommentHighlights,
        });
    }

    window.__agentPivotConversation.comments = Object.freeze({ create: create });
}());
