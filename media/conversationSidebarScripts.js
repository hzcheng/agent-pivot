(function () {
    'use strict';

    function create(options) {
        var sidebarUiAvailable = options.available;
        var vscodeApi = options.vscodeApi;
        var outlineToggle = options.outlineToggle;
        var commentsToggle = options.commentsToggle;
        var commentsWorkspace = options.commentsWorkspace;
        var commentsResizer = options.commentsResizer;
        var sidebarRoot = options.sidebarRoot;
        var sidebarTabs = options.sidebarTabs;
        var sidebarClose = options.sidebarClose;
        var outlineRoot = options.outlineRoot;
        var commentsRoot = options.commentsRoot;
        var outlineQuery = options.outlineQuery;
        var outlineSize = options.outlineSize;
        var openComments = options.openComments;
        var commentsPanelMinWidth = 192;
        var commentsPanelMaxWidth = 420;
        var conversationMinWidth = 320;
        var state = {
            commentsPanelOpen: true,
            commentsPanelWidth: 240,
            sidebarView: 'outline',
        };

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
                    query: outlineQuery(),
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
            outlineToggle.textContent = 'Outline ('
                + outlineSize() + ')';
            outlineToggle.setAttribute(
                'aria-expanded',
                state.commentsPanelOpen && state.sidebarView === 'outline'
                    ? 'true'
                    : 'false'
            );
            commentsToggle.textContent = 'Comments ('
                + openComments()
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

        function attach() {
            if (!sidebarUiAvailable) return;
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

        function handleEscape(event) {
            if (!sidebarUiAvailable
                || !state.commentsPanelOpen
                || !sidebarRoot.contains(document.activeElement)) {
                return false;
            }
            event.preventDefault();
            setCommentsPanelOpen(false, true);
            if (state.sidebarView === 'outline') outlineToggle.focus();
            else commentsToggle.focus();
            return true;
        }

        function isOutlineActive() {
            return state.commentsPanelOpen && state.sidebarView === 'outline';
        }

        function restore(savedCommentsPanel) {
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
        }

        return Object.freeze({
            applyLayout: applyCommentsPanelLayout,
            attach: attach,
            handleEscape: handleEscape,
            isOutlineActive: isOutlineActive,
            readSavedState: readCommentsPanelState,
            restore: restore,
            save: saveCommentsPanelState,
            setOpen: setCommentsPanelOpen,
            setView: setSidebarView,
            updateToggle: updateCommentsToggle,
        });
    }

    window.__agentPivotConversationSidebar = Object.freeze({ create: create });
}());
