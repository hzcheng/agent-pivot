(function () {
    'use strict';

    function create(options) {
        var sidebarUiAvailable = options.available;
        var bookmarkUiAvailable = options.bookmarkAvailable;
        var commentTarget = options.target;
        var subscriptionGeneration = options.subscriptionGeneration;
        var status = options.status;
        var outlineSearch = options.outlineSearch;
        var outlineList = options.outlineList;
        var outlineEmpty = options.outlineEmpty;
        var outlinePartial = options.outlinePartial;
        var outlineBookmarksOnly = options.outlineBookmarksOnly;
        var outlineBookmarkCount = options.outlineBookmarkCount;
        var outlineSort = options.outlineSort;
        var messagesRoot = options.messagesRoot;
        var post = options.post;
        var outlinePanelActive = options.outlinePanelActive;
        var persistPanelState = options.persistPanelState;
        var updateToggle = options.updateToggle;
        var state = {
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
            newestFirst: true,
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

        function postBookmarkMutation(interactionId, bookmarked, origin) {
            if (!bookmarkUiAvailable
                || state.pendingBookmarkRequest) return;
            var requestId = nextBookmarkRequestId();
            state.pendingBookmarkRequest = {
                requestId: requestId,
                interactionId: interactionId,
                origin: origin === 'card' ? 'card' : 'outline',
            };
            renderBookmarkState();
            post({
                type: 'conversation-viewer-bookmark-mutation',
                version: 1,
                requestId: requestId,
                subscriptionGeneration: subscriptionGeneration,
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
                || message.subscriptionGeneration !== subscriptionGeneration
                || message.projectId !== commentTarget.projectId
                || message.provider !== commentTarget.provider
                || message.sessionId !== commentTarget.sessionId) {
                return false;
            }
            var focusedId = state.pendingBookmarkRequest.interactionId;
            var pendingOrigin = state.pendingBookmarkRequest.origin;
            state.pendingBookmarkRequest = null;
            state.bookmarkRevision = message.revision;
            state.bookmarkIds = new Set(message.interactionIds);
            renderBookmarkState();
            filterOutline();
            if (message.success) {
                // The star fill plus the aria-pressed flip on the focused
                // button are the settlement feedback; keep the status line
                // for failures so a snap-back never goes unexplained.
                if (status.textContent === 'Bookmark could not be updated.') {
                    status.textContent = '';
                }
            } else {
                status.textContent = 'Bookmark could not be updated.';
            }
            var focused = pendingOrigin === 'card'
                ? messageBookmarkButton(focusedId)
                : null;
            if (!focused) {
                focused = outlineList.querySelector(
                    '[data-outline-bookmark-id="' + CSS.escape(focusedId) + '"]'
                );
            }
            if (focused) focused.focus();
            return true;
        }

        function messageBookmarkButton(interactionId) {
            if (!messagesRoot) return null;
            var article = messagesRoot.querySelector(
                '.conversation-message-user[data-interaction-id="'
                    + CSS.escape(interactionId) + '"]'
            );
            return article
                ? article.querySelector('.conversation-message-bookmark')
                : null;
        }

        function renderMessageBookmarks() {
            if (!messagesRoot) return;
            Array.prototype.forEach.call(
                messagesRoot.querySelectorAll('.conversation-message-bookmark'),
                function (button) {
                    var article = button.closest
                        ? button.closest('[data-interaction-id]')
                        : null;
                    var interactionId = article
                        ? article.getAttribute('data-interaction-id')
                        : '';
                    var bookmarked = interactionId !== ''
                        && state.bookmarkIds.has(interactionId);
                    button.classList.toggle('is-bookmarked', bookmarked);
                    button.setAttribute(
                        'aria-pressed',
                        bookmarked ? 'true' : 'false'
                    );
                    var label = bookmarked
                        ? 'Remove bookmark from this input'
                        : 'Bookmark this input';
                    button.setAttribute('aria-label', label);
                    button.title = label;
                    button.disabled = !!state.pendingBookmarkRequest;
                }
            );
        }

        function renderBookmarkState() {
            renderMessageBookmarks();
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
            if (outlineBookmarkCount) {
                outlineBookmarkCount.textContent = String(count);
            } else {
                outlineBookmarksOnly.textContent
                    = (state.bookmarksOnly ? '★ ' : '☆ ') + count;
            }
            outlineBookmarksOnly.setAttribute(
                'aria-pressed',
                state.bookmarksOnly ? 'true' : 'false'
            );
            var bookmarkLabel = count + ' bookmark'
                + (count === 1 ? '' : 's');
            outlineBookmarksOnly.setAttribute(
                'aria-label',
                (state.bookmarksOnly
                    ? 'Show all inputs, '
                    : 'Show bookmarked inputs only, ') + bookmarkLabel
            );
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

        function createStarIcon() {
            var namespace = 'http://www.w3.org/2000/svg';
            var icon = document.createElementNS(namespace, 'svg');
            icon.setAttribute('viewBox', '0 0 16 16');
            icon.setAttribute('width', '14');
            icon.setAttribute('height', '14');
            icon.setAttribute('aria-hidden', 'true');
            icon.setAttribute('fill', 'none');
            icon.setAttribute('stroke', 'currentColor');
            icon.setAttribute('stroke-width', '1');
            icon.setAttribute('stroke-linejoin', 'round');
            var path = document.createElementNS(namespace, 'path');
            path.setAttribute(
                'd',
                'm8 1.8 1.85 3.76 4.15.6-3 2.92.71 4.13L8 11.26l-3.71 1.95L5 9.08 2 6.16l4.15-.6z'
            );
            icon.appendChild(path);
            return icon;
        }

        function renderSortState() {
            if (!outlineSort) return;
            var order = state.newestFirst ? 'newest' : 'oldest';
            var label = state.newestFirst
                ? 'Show oldest inputs first'
                : 'Show newest inputs first';
            outlineSort.setAttribute('data-order', order);
            outlineSort.setAttribute('aria-label', label);
            outlineSort.title = label;
        }

        function buildOutlineList() {
            var fragment = document.createDocumentFragment();
            var entries = state.newestFirst
                ? state.outline.slice().reverse()
                : state.outline;
            entries.forEach(function (entry) {
                var item = document.createElement('li');
                item.className = 'conversation-outline-item';
                var bookmark = document.createElement('button');
                bookmark.type = 'button';
                bookmark.className = 'conversation-outline-bookmark';
                bookmark.setAttribute(
                    'data-outline-bookmark-id',
                    entry.interactionId
                );
                bookmark.appendChild(createStarIcon());
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
                item.appendChild(button);
                item.appendChild(bookmark);
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
                    button.closest('.conversation-outline-item')
                        .classList.toggle('is-selected', current);
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
                && outlinePanelActive()
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
            outlinePartial.hidden = !message.partial;
            filterOutline();
            renderBookmarkState();
            updateOutlineSelection(changed || message.updateKind !== 'refresh');
            updateToggle();
        }

        function attach() {
            if (!sidebarUiAvailable) return;
            renderSortState();
            outlineSearch.addEventListener('input', function () {
                state.outlineQuery = outlineSearch.value;
                filterOutline();
                persistPanelState();
            });
            outlineBookmarksOnly.addEventListener('click', function () {
                state.bookmarksOnly = !state.bookmarksOnly;
                renderBookmarkState();
                filterOutline();
            });
            if (outlineSort) {
                outlineSort.addEventListener('click', function () {
                    state.newestFirst = !state.newestFirst;
                    renderSortState();
                    buildOutlineList();
                    filterOutline();
                });
            }
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
                        !state.bookmarkIds.has(bookmarkId),
                        'outline'
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
        }

        function toggleBookmark(interactionId, origin) {
            if (typeof interactionId !== 'string'
                || interactionId === '') return;
            postBookmarkMutation(
                interactionId,
                !state.bookmarkIds.has(interactionId),
                origin
            );
        }

        function initializeBookmarks() {
            var initialBookmarks = readJsonAttribute('data-initial-bookmarks');
            if (validBookmarkSnapshot(initialBookmarks)) {
                applyBookmarksSnapshot(initialBookmarks);
            } else {
                status.textContent = 'Conversation bookmarks are unavailable.';
            }
        }

        function applyBookmarksSnapshot(bookmarks) {
            if (!validBookmarkSnapshot(bookmarks)) return false;
            state.bookmarkRevision = bookmarks.revision;
            state.bookmarkIds = new Set(bookmarks.interactionIds);
            renderBookmarkState();
            if (sidebarUiAvailable) filterOutline();
            return true;
        }

        function resetSession(target, generation, bookmarks) {
            if (!validBookmarkSnapshot(bookmarks)) {
                return false;
            }
            commentTarget = target;
            subscriptionGeneration = generation;
            state.outline = [];
            state.outlineSelectedInteractionId = '';
            state.outlineSelectedInput = 0;
            state.outlineTotalInputs = 0;
            state.outlinePartial = false;
            state.bookmarkIds = new Set(bookmarks.interactionIds);
            state.bookmarkRevision = bookmarks.revision;
            state.pendingBookmarkRequest = null;
            if (!sidebarUiAvailable) {
                return true;
            }
            buildOutlineList();
            renderBookmarkState();
            filterOutline();
            return true;
        }

        function restoreQuery(value) {
            if (typeof value !== 'string') return;
            state.outlineQuery = value.slice(0, 4096);
            outlineSearch.value = state.outlineQuery;
        }

        function query() {
            return state.outlineQuery;
        }

        function size() {
            return state.outline.length;
        }

        return Object.freeze({
            applyBookmarksResult: applyBookmarksResult,
            applyBookmarksSnapshot: applyBookmarksSnapshot,
            applyOutline: applyOutline,
            attach: attach,
            canResetSession: validBookmarkSnapshot,
            filter: filterOutline,
            initializeBookmarks: initializeBookmarks,
            query: query,
            resetSession: resetSession,
            restoreQuery: restoreQuery,
            size: size,
            toggleBookmark: toggleBookmark,
        });
    }

    window.__agentPivotConversation.outline = Object.freeze({ create: create });
}());
