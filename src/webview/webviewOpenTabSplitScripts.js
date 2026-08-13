function initOpenTabSplit() {
    'use strict';

    // --- OPEN tab window-region split --------------------------------------
    // CURRENT WINDOW and OPEN WINDOWS scroll as two independent regions; the
    // separator between them resizes the CURRENT WINDOW share (mouse drag or
    // arrow keys). A null share means "auto": CURRENT WINDOW is content-sized
    // up to a CSS cap. The dragged share is a fraction of the wrapper height
    // and persists in webview view state (same pattern as the skills pane
    // ratio) so it survives window reloads; it is applied as a custom
    // property on .sticky-groups-wrapper, whose node survives authoritative
    // innerHTML replacements, so replacements never have to replay it.
    var OPEN_TAB_PANE_MIN_PX = 72;
    // Expanded CURRENT WINDOW cards carry fixed AI-session chrome (module
    // header, surface tabs, chat tabs, provider controls); the pane minimum
    // rises so the chrome and one session row stay reachable. Measured
    // against the sidebar fit layout (360px/240px widths) and mirrored as
    // the min-height of the expanded rules in media/styles.scss.
    var OPEN_TAB_PANE_MIN_EXPANDED_PX = 322;
    var OPEN_TAB_KEY_STEP_PX = 24;
    var OPEN_TAB_STATE_KEY = 'openTab';

    function readOpenTabState() {
        var api = window.vscode;
        if (!api || typeof api.getState !== 'function') {
            return {};
        }
        var state = api.getState() || {};
        var tab = state[OPEN_TAB_STATE_KEY];
        return tab && typeof tab === 'object' && !Array.isArray(tab) ? tab : {};
    }

    function readPersistedCurrentShare() {
        var share = Number(readOpenTabState().currentWindowShare);
        return Number.isFinite(share) && share > 0 && share < 1 ? share : null;
    }

    var currentShare = readPersistedCurrentShare();
    var dragState = null;

    function persistCurrentShare() {
        var api = window.vscode;
        if (!api || typeof api.setState !== 'function') {
            return;
        }
        var state = typeof api.getState === 'function' ? api.getState() || {} : {};
        var tab = Object.assign({}, readOpenTabState());
        if (currentShare === null) {
            delete tab.currentWindowShare;
        } else {
            tab.currentWindowShare = currentShare;
        }
        var patch = {};
        patch[OPEN_TAB_STATE_KEY] = tab;
        api.setState(Object.assign({}, state, patch));
    }

    function findOpenTabElement(selector) {
        return document.querySelector
            ? document.querySelector('#dashboard-tab-open ' + selector)
            : null;
    }

    function findWrapper() {
        return findOpenTabElement('.sticky-groups-wrapper');
    }

    function findResizer() {
        return findOpenTabElement('[data-open-tab-split-resizer]');
    }

    function findCurrentGroup() {
        return findOpenTabElement('.open-current-workspace-group');
    }

    function findOtherGroup() {
        return findOpenTabElement('.open-other-windows-group');
    }

    // Apply the in-memory share: manual mode pins CURRENT WINDOW to a
    // wrapper-height percentage; auto mode clears the override.
    function applyShare() {
        var wrapper = findWrapper();
        if (!wrapper || !wrapper.style) {
            return;
        }
        if (currentShare === null) {
            wrapper.classList.remove('open-tab-split-manual');
            wrapper.style.removeProperty('--open-tab-current-share');
            return;
        }
        wrapper.classList.add('open-tab-split-manual');
        wrapper.style.setProperty('--open-tab-current-share', (currentShare * 100) + '%');
    }

    // Split geometry: the wrapper's full height (the share basis) and the
    // pane space inside it (resizer excluded; the aria percentage basis).
    function measureSplit() {
        var wrapper = findWrapper();
        if (!wrapper || typeof wrapper.getBoundingClientRect !== 'function'
            || !wrapper.getClientRects().length) {
            return null; // hidden (another tab) — keep the last applied state
        }
        var resizer = findResizer();
        var resizerHeight = resizer && !resizer.hidden
            ? resizer.getBoundingClientRect().height
            : 0;
        var wrapperHeight = wrapper.getBoundingClientRect().height;
        return {
            wrapperHeight: wrapperHeight,
            inner: Math.max(wrapperHeight - resizerHeight, OPEN_TAB_PANE_MIN_PX),
        };
    }

    // Reconcile the (possibly freshly replaced) resizer with the live layout:
    // hidden while OPEN WINDOWS is collapsed, aria-valuenow tracking the
    // CURRENT WINDOW percentage of the pane space.
    function syncResizer() {
        var resizer = findResizer();
        if (!resizer) {
            return;
        }
        var otherGroup = findOtherGroup();
        resizer.hidden = Boolean(
            otherGroup && otherGroup.classList.contains('collapsed')
        );
        var currentGroup = findCurrentGroup();
        var split = measureSplit();
        if (!resizer.hidden && currentGroup && split
            && typeof currentGroup.getBoundingClientRect === 'function' && split.inner > 0) {
            var percent = Math.round(currentGroup.getBoundingClientRect().height / split.inner * 100);
            resizer.setAttribute('aria-valuenow', String(Math.min(100, Math.max(0, percent))));
        }
    }

    function scheduleSyncResizer() {
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(function () { syncResizer(); });
            return;
        }
        syncResizer();
    }

    // The live CURRENT WINDOW pane floor: it rises while the card is
    // expanded so the AI session controls can never be dragged out of reach.
    function currentPaneMinPx() {
        var group = findCurrentGroup();
        return group && group.classList && group.classList.contains('current-card-expanded')
            ? OPEN_TAB_PANE_MIN_EXPANDED_PX
            : OPEN_TAB_PANE_MIN_PX;
    }

    function clampPanePx(nextPx, split) {
        var minPx = currentPaneMinPx();
        return Math.min(
            Math.max(nextPx, minPx),
            Math.max(split.inner - OPEN_TAB_PANE_MIN_PX, minPx)
        );
    }

    function applySharePx(nextPx) {
        var split = measureSplit();
        if (!split || split.wrapperHeight <= 0) {
            return;
        }
        currentShare = clampPanePx(nextPx, split) / split.wrapperHeight;
        applyShare();
        syncResizer();
    }

    function onPointerDown(event) {
        var resizer = event.target && event.target.closest
            ? event.target.closest('[data-open-tab-split-resizer]')
            : null;
        if (!resizer || resizer.hidden
            || (event.button !== 0 && event.button !== undefined)) {
            return;
        }
        var currentGroup = findCurrentGroup();
        if (!currentGroup) {
            return;
        }
        event.preventDefault();
        dragState = {
            pointerId: event.pointerId,
            startY: event.clientY,
            startHeight: currentGroup.getBoundingClientRect().height,
            resizer: resizer,
        };
        resizer.classList.add('open-tab-split-resizer-active');
        if (document.body) {
            document.body.classList.add('open-tab-split-resizing');
        }
        if (event.pointerId !== undefined && typeof resizer.setPointerCapture === 'function') {
            try {
                resizer.setPointerCapture(event.pointerId);
            } catch (_error) { /* capture is best-effort */ }
        }
    }

    function onPointerMove(event) {
        if (!dragState
            || (dragState.pointerId !== undefined && event.pointerId !== dragState.pointerId)) {
            return;
        }
        // CURRENT WINDOW sits above the resizer: dragging down grows it.
        applySharePx(dragState.startHeight + (event.clientY - dragState.startY));
    }

    function onPointerUp(event) {
        if (!dragState
            || (dragState.pointerId !== undefined && event.pointerId !== dragState.pointerId)) {
            return;
        }
        dragState.resizer.classList.remove('open-tab-split-resizer-active');
        if (document.body) {
            document.body.classList.remove('open-tab-split-resizing');
        }
        if (event.pointerId !== undefined
            && typeof dragState.resizer.releasePointerCapture === 'function') {
            try {
                dragState.resizer.releasePointerCapture(event.pointerId);
            } catch (_error) { /* capture is best-effort */ }
        }
        dragState = null;
        persistCurrentShare();
    }

    function onKeydown(event) {
        var resizer = event.target && event.target.closest
            ? event.target.closest('[data-open-tab-split-resizer]')
            : null;
        if (!resizer || resizer.hidden
            || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) {
            return;
        }
        var currentGroup = findCurrentGroup();
        if (!currentGroup) {
            return;
        }
        event.preventDefault();
        // ArrowDown grows the pane above the separator, ArrowUp shrinks it.
        var direction = event.key === 'ArrowDown' ? 1 : -1;
        applySharePx(currentGroup.getBoundingClientRect().height
            + direction * OPEN_TAB_KEY_STEP_PX);
        persistCurrentShare();
    }

    // Collapse toggles (group header, collapse-all button) change whether the
    // resizer participates; window resizes change the auto-layout geometry.
    // Both are measured after the frame so the class/geometry settles first.
    function onClick(event) {
        var togglesLayout = event.target && event.target.closest
            ? event.target.closest('[data-action="collapse"], [data-action="toggle-all-groups"]')
            : null;
        if (togglesLayout) {
            scheduleSyncResizer();
        }
    }

    // Re-clamp the live share against the current pane minimum without
    // rewriting the persisted share: the minimum rises when the CURRENT
    // WINDOW card expands (and the persisted value may predate that state),
    // so init and expand/collapse toggles reconcile the applied pane here.
    function syncCurrentPaneMinimum() {
        if (currentShare !== null) {
            var split = measureSplit();
            if (split && split.wrapperHeight > 0) {
                var px = currentShare * split.wrapperHeight;
                var clamped = clampPanePx(px, split);
                if (Math.abs(clamped - px) > 0.5) {
                    currentShare = clamped / split.wrapperHeight;
                    applyShare();
                }
            }
        }
        syncResizer();
    }

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('click', onClick);
    window.addEventListener('resize', scheduleSyncResizer);

    applyShare();
    syncCurrentPaneMinimum();

    window.__agentPivotOpenTabSplit = {
        sync: syncResizer,
        syncCurrentPaneMinimum: syncCurrentPaneMinimum,
    };

    return {
        applyShare: applyShare,
        syncResizer: syncResizer,
        syncCurrentPaneMinimum: syncCurrentPaneMinimum,
        getCurrentShare: () => currentShare,
    };
}
