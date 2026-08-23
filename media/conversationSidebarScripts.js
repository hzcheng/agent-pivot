(function () {
    'use strict';

    function create(options) {
        var sidebarUiAvailable = options.available;
        var vscodeApi = options.vscodeApi;
        var sidebarToggle = options.sidebarToggle;
        var commentsWorkspace = options.commentsWorkspace;
        var commentsResizer = options.commentsResizer;
        var sidebarRoot = options.sidebarRoot;
        var outlineRoot = options.outlineRoot;
        var commentsRoot = options.commentsRoot;
        var subagentsRoot = options.subagentsRoot;
        var changesRoot = options.changesRoot;
        var outlineQuery = options.outlineQuery;
        var subagentsRunningOnlyQuery = options.subagentsRunningOnlyQuery
            || function () { return false; };
        var telemetryPosition = options.telemetryPosition;
        var telemetryComments = options.telemetryComments;
        var telemetrySubagents = options.telemetrySubagents;
        var telemetryChanges = options.telemetryChanges;
        var commentsPanelMinWidth = 192;
        var commentsPanelMaxWidth = 420;
        var conversationMinWidth = 320;
        var state = {
            commentsPanelOpen: false,
            commentsPanelWidth: 240,
            sidebarView: 'outline',
            changesSubTab: 'files',
            widthUserResized: false,
            changesWidthRecommendationApplied: false,
            restoredRecommendationPersistPending: false,
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
                    subagentsRunningOnly: subagentsRunningOnlyQuery(),
                };
                if (typeof state.widthUserResized === 'boolean') {
                    next.conversationSidebar.widthUserResized =
                        state.widthUserResized;
                }
                if (typeof state.changesWidthRecommendationApplied
                    === 'boolean') {
                    next.conversationSidebar
                        .changesWidthRecommendationApplied =
                        state.changesWidthRecommendationApplied;
                }
                if (state.changesSubTab === 'files'
                    || state.changesSubTab === 'commits') {
                    next.conversationSidebar.changesSubTab =
                        state.changesSubTab;
                }
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
            sidebarToggle.setAttribute(
                'aria-expanded',
                state.commentsPanelOpen ? 'true' : 'false'
            );
            sidebarToggle.setAttribute('aria-label',
                state.commentsPanelOpen ? 'Hide side panel' : 'Show side panel');
            sidebarToggle.setAttribute('title',
                state.commentsPanelOpen ? 'Hide side panel' : 'Show side panel');
            if (telemetryPosition) {
                telemetryPosition.setAttribute('aria-pressed',
                    state.commentsPanelOpen && state.sidebarView === 'outline' ? 'true' : 'false');
            }
            if (telemetryComments) {
                telemetryComments.setAttribute('aria-pressed',
                    state.commentsPanelOpen && state.sidebarView === 'comments' ? 'true' : 'false');
            }
            if (telemetrySubagents) {
                telemetrySubagents.setAttribute('aria-pressed',
                    state.commentsPanelOpen && state.sidebarView === 'subagents' ? 'true' : 'false');
            }
            if (telemetryChanges) {
                telemetryChanges.setAttribute('aria-pressed',
                    state.commentsPanelOpen && state.sidebarView === 'changes' ? 'true' : 'false');
            }
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
            subagentsRoot.hidden = state.sidebarView !== 'subagents';
            if (changesRoot) {
                changesRoot.hidden = state.sidebarView !== 'changes';
            }
            commentsResizer.setAttribute('aria-valuemax', String(
                availableCommentsPanelMaxWidth()
            ));
            commentsResizer.setAttribute('aria-valuenow', String(width));
            updateCommentsToggle();
            if (state.restoredRecommendationPersistPending) {
                state.restoredRecommendationPersistPending = false;
                saveCommentsPanelState();
            }
        }

        function applyChangesWidthRecommendation() {
            if (!state.commentsPanelOpen || state.sidebarView !== 'changes') {
                return false;
            }
            if (state.widthUserResized !== false
                || state.changesWidthRecommendationApplied === true) {
                return false;
            }
            state.commentsPanelWidth = 320;
            state.changesWidthRecommendationApplied = true;
            return true;
        }

        function setCommentsPanelOpen(open, persist) {
            state.commentsPanelOpen = open;
            applyCommentsPanelLayout();
            if (persist) saveCommentsPanelState();
        }

        function setSidebarView(view, open, persist) {
            if (view !== 'outline' && view !== 'comments'
                && view !== 'subagents' && view !== 'changes') return;
            state.sidebarView = view;
            state.commentsPanelOpen = open;
            applyChangesWidthRecommendation();
            applyCommentsPanelLayout();
            if (persist) saveCommentsPanelState();
        }

        function setCommentsPanelWidth(width, persist) {
            state.commentsPanelWidth = clampCommentsPanelWidth(width);
            applyCommentsPanelLayout();
            if (persist) saveCommentsPanelState();
        }

        function setChangesSubTab(subTab, persist) {
            if (subTab !== 'files' && subTab !== 'commits') return;
            state.changesSubTab = subTab;
            if (persist) saveCommentsPanelState();
        }

        function attach() {
            if (!sidebarUiAvailable) return;
            sidebarToggle.addEventListener('click', function () {
                setSidebarView(
                    state.sidebarView,
                    !state.commentsPanelOpen,
                    true
                );
            });
            var resizingPointerId = null;
            commentsResizer.addEventListener('pointerdown', function (event) {
                if (event.button !== 0) return;
                state.widthUserResized = true;
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
                state.widthUserResized = true;
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
            sidebarToggle.focus();
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
            state.widthUserResized =
                typeof savedCommentsPanel.widthUserResized === 'boolean'
                    ? savedCommentsPanel.widthUserResized
                    : undefined;
            state.changesWidthRecommendationApplied =
                typeof savedCommentsPanel
                    .changesWidthRecommendationApplied === 'boolean'
                    ? savedCommentsPanel.changesWidthRecommendationApplied
                    : undefined;
            if (savedCommentsPanel.view === 'outline'
                || savedCommentsPanel.view === 'comments'
                || savedCommentsPanel.view === 'subagents'
                || savedCommentsPanel.view === 'changes') {
                state.sidebarView = savedCommentsPanel.view;
            }
            if (savedCommentsPanel.changesSubTab === 'files'
                || savedCommentsPanel.changesSubTab === 'commits') {
                state.changesSubTab = savedCommentsPanel.changesSubTab;
            }
            if (state.commentsPanelOpen && state.sidebarView === 'changes'
                && state.widthUserResized === false
                && state.changesWidthRecommendationApplied === false) {
                state.commentsPanelWidth = 320;
                state.changesWidthRecommendationApplied = true;
                state.restoredRecommendationPersistPending = true;
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
            isPanelOpen: function () { return state.commentsPanelOpen; },
            getView: function () { return state.sidebarView; },
            getChangesSubTab: function () { return state.changesSubTab; },
            setChangesSubTab: setChangesSubTab,
            updateToggle: updateCommentsToggle,
        });
    }

    window.__agentPivotConversation.sidebar = Object.freeze({ create: create });
}());
