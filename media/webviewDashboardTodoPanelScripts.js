function createDashboardTodoPanel(injected) {
    injected = injected || {};
    var options = injected.options;
    var panels = injected.panels;
    var scheduleTimeout = injected.scheduleTimeout;
    var cancelTimeout = injected.cancelTimeout;
    var panelRequestTimeoutMs = injected.panelRequestTimeoutMs;
    var showPanelLoading = injected.showPanelLoading;
    var showPanelUnavailable = injected.showPanelUnavailable;
    var restoreScroll = injected.restoreScroll;
    var replaceSearchCatalog = injected.replaceSearchCatalog;
    var getActiveTab = injected.getActiveTab;
    var getSearchQuery = injected.getSearchQuery;
    var getPendingScrollRestoreTab = injected.getPendingScrollRestoreTab;
    var setPendingScrollRestoreTab = injected.setPendingScrollRestoreTab;

    var todoState = 'unloaded';
    var todoRequestId = 0;
    var acceptedTodoRequestId = 0;
    var todoRequestAttempts = 0;
    var todoRequestTimer = null;
    var pendingTodoSearchTarget = null;

    function scheduleTodoRequestTimeout(requestId) {
        if (!scheduleTimeout) {
            return;
        }
        if (todoRequestTimer !== null) {
            cancelTimeout(todoRequestTimer);
        }
        todoRequestTimer = scheduleTimeout(function () {
            todoRequestTimer = null;
            if (todoState !== 'loading' || requestId !== todoRequestId) {
                return;
            }
            todoState = 'unloaded';
            if (todoRequestAttempts < 2 && getActiveTab() === 'todo' && !getSearchQuery()) {
                ensureTodoPanel();
                return;
            }
            showPanelUnavailable('todo');
        }, panelRequestTimeoutMs);
    }

    function ensureTodoPanel() {
        if (todoState !== 'unloaded') {
            return;
        }
        todoState = 'loading';
        todoRequestAttempts += 1;
        todoRequestId += 1;
        showPanelLoading('todo');
        options.postMessage({
            type: 'request-todo-panel',
            version: 1,
            requestId: todoRequestId,
        });
        scheduleTodoRequestTimeout(todoRequestId);
    }

    function revealPendingTodoSearchTarget() {
        if (!pendingTodoSearchTarget || !panels.todo || pendingTodoSearchTarget.focusScheduled) {
            return false;
        }
        var scheduledTarget = pendingTodoSearchTarget;
        scheduledTarget.focusScheduled = true;
        requestAnimationFrame(() => {
            if (pendingTodoSearchTarget !== scheduledTarget) {
                return;
            }
            scheduledTarget.focusScheduled = false;
            if (window.__agentPivotTodo
                && typeof window.__agentPivotTodo.openDetail === 'function'
                && window.__agentPivotTodo.openDetail(scheduledTarget.todoId)) {
                pendingTodoSearchTarget = null;
                return;
            }
            var todoItem = Array.from(panels.todo.querySelectorAll('.todo-item[data-todo-id]'))
                .find(item => item.getAttribute('data-todo-id') === scheduledTarget.todoId);
            var todoGroup = todoItem && todoItem.closest ? todoItem.closest('.todo-group') : null;
            if (!todoItem || (todoGroup && todoGroup.classList.contains('collapsed'))) {
                if (!scheduledTarget.revealRequested) {
                    scheduledTarget.revealRequested = true;
                    options.postMessage({
                        type: 'todo-reveal',
                        todoId: scheduledTarget.todoId,
                        groupId: scheduledTarget.groupId,
                    });
                }
                return;
            }
            if (!todoItem.isConnected) {
                return;
            }

            todoItem.setAttribute('tabindex', '-1');
            try {
                todoItem.scrollIntoView({ block: 'nearest' });
                todoItem.focus();
            } catch (_error) {
                todoItem.removeAttribute('tabindex');
                return;
            }
            if (!todoItem.isConnected || document.activeElement !== todoItem) {
                todoItem.removeAttribute('tabindex');
                return;
            }
            pendingTodoSearchTarget = null;
            todoItem.addEventListener('blur', () => todoItem.removeAttribute('tabindex'), { once: true });
        });
        return true;
    }

    function applyTodoPanelMessage(message) {
        if (!validateTodoPanelMessage(message)
            || todoState !== 'loading'
            || message.requestId !== todoRequestId
            || message.requestId <= acceptedTodoRequestId
            || !panels.todo) {
            return false;
        }

        acceptedTodoRequestId = message.requestId;
        if (todoRequestTimer !== null) {
            cancelTimeout(todoRequestTimer);
            todoRequestTimer = null;
        }
        todoRequestAttempts = 0;
        panels.todo.innerHTML = message.html;
        todoState = 'mounted';
        if (normalizeDashboardSearchCatalog(message.searchCatalog) === message.searchCatalog) {
            replaceSearchCatalog(message.searchCatalog);
        }
        if (typeof options.onTodoMounted === 'function') {
            options.onTodoMounted(panels.todo, message);
        }
        if (getPendingScrollRestoreTab() === 'todo') {
            setPendingScrollRestoreTab(null);
            if (getActiveTab() === 'todo' && !getSearchQuery()) {
                restoreScroll('todo');
            }
        }
        revealPendingTodoSearchTarget();
        return true;
    }

    function applyTodoPanelUpdatedMessage(message) {
        if (!validateTodoPanelUpdatedMessage(message) || !panels.todo) {
            return false;
        }

        var activeElement = document.activeElement;
        var restoreShowCompletedFocus = !!activeElement
            && panels.todo.contains(activeElement)
            && activeElement.getAttribute('data-action') === 'todo-toggle-show-completed';
        var fallbackWindowScrollY = restoreShowCompletedFocus
            ? window.scrollY
            : null;
        if (todoRequestTimer !== null) {
            cancelTimeout(todoRequestTimer);
            todoRequestTimer = null;
        }
        todoRequestAttempts = 0;
        replaceSearchCatalog(message.searchCatalog);
        var refreshed = todoState === 'mounted'
            && message.snapshot
            && typeof options.onTodoRefresh === 'function'
            && options.onTodoRefresh(panels.todo, message) === true;
        if (!refreshed) {
            panels.todo.innerHTML = message.html;
            todoState = 'mounted';
            if (typeof options.onTodoMounted === 'function') {
                options.onTodoMounted(panels.todo, message);
            }
            if (restoreShowCompletedFocus) {
                var showCompletedToggle = panels.todo.querySelector(
                    '[data-action="todo-toggle-show-completed"]'
                );
                if (showCompletedToggle) {
                    showCompletedToggle.focus({ preventScroll: true });
                    if (Number.isFinite(fallbackWindowScrollY)) {
                        window.scrollTo(0, fallbackWindowScrollY);
                    }
                }
            }
        }
        revealPendingTodoSearchTarget();
        return true;
    }

    return {
        ensureTodoPanel: ensureTodoPanel,
        revealPendingTodoSearchTarget: revealPendingTodoSearchTarget,
        applyTodoPanelMessage: applyTodoPanelMessage,
        applyTodoPanelUpdatedMessage: applyTodoPanelUpdatedMessage,
        setPendingTodoSearchTarget: target => { pendingTodoSearchTarget = target; },
        getTodoState: () => todoState,
    };
}
