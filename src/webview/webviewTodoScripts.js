function initTodos(options) {
    'use strict';

    options = options || {};
    var postMessage = typeof options.postMessage === 'function'
        ? options.postMessage
        : function (message) { window.vscode.postMessage(message); };
    var state = {
        snapshot: null,
        selectedTodoId: null,
        restoreFocusTodoId: null,
        draft: null,
        composeGroupId: undefined,
        composeDraft: null,
        composeRequestId: null,
        nextRequestId: 0,
        lastRevision: 0,
        pending: new Map(),
        undo: null,
        undoTimer: null,
        announcement: '',
        renderedSurfaceHtml: '',
    };
    var renderer = createTodoRenderer({ state: state });
    var panelHost = null;
    var root = null;
    var layoutObserver = null;
    var skipNextTodoLayoutObserverSync = false;



    function clearCompose() {
        state.composeGroupId = undefined;
        state.composeDraft = null;
        state.composeRequestId = null;
    }























    function syncTodoListExpandedHeights() {
        if (!root || !root.querySelectorAll) {
            return;
        }
        var collapsedHeightValue = typeof getComputedStyle === 'function'
            ? getComputedStyle(root).getPropertyValue('--todo-collapsed-item-height')
            : '';
        var collapsedHeight = parseFloat(collapsedHeightValue) || 58;
        Array.from(root.querySelectorAll('.todo-list')).forEach(function (list) {
            if (!list || !list.style || !list.querySelectorAll) {
                return;
            }
            var expandedExtraHeight = Array.from(list.querySelectorAll('.todo-item.expanded'))
                .reduce(function (total, item) {
                    if (item.style && item.style.removeProperty) {
                        item.style.removeProperty('--todo-expanded-item-height');
                    }
                    var itemStyle = typeof getComputedStyle === 'function'
                        ? getComputedStyle(item)
                        : null;
                    var borderHeight = itemStyle
                        ? (parseFloat(itemStyle.borderTopWidth) || 0)
                            + (parseFloat(itemStyle.borderBottomWidth) || 0)
                        : 0;
                    var expandedHeight = Math.max(
                        Number(item.offsetHeight) || 0,
                        (Number(item.scrollHeight) || 0) + borderHeight
                    );
                    if (expandedHeight > 0 && item.style && item.style.setProperty) {
                        item.style.setProperty('--todo-expanded-item-height', expandedHeight + 'px');
                    }
                    return total + Math.max(0, expandedHeight - collapsedHeight);
                }, 0);
            list.style.setProperty(
                '--todo-list-expanded-extra-height',
                expandedExtraHeight + 'px'
            );
        });
    }

    function refreshTodoLayoutObserverTargets() {
        if (!layoutObserver || !root) {
            return;
        }
        layoutObserver.disconnect();
        layoutObserver.observe(root);
        if (root.querySelectorAll) {
            Array.from(root.querySelectorAll('.todo-item[data-todo-id]')).forEach(function (item) {
                layoutObserver.observe(item);
            });
        }
    }

    function observeTodoLayout() {
        if (layoutObserver) {
            layoutObserver.disconnect();
            layoutObserver = null;
        }
        if (!root || typeof ResizeObserver !== 'function') {
            return;
        }
        layoutObserver = new ResizeObserver(function () {
            if (skipNextTodoLayoutObserverSync) {
                skipNextTodoLayoutObserverSync = false;
                return;
            }
            syncTodoListExpandedHeights();
        });
        refreshTodoLayoutObserverTargets();
    }

    function updateFeedback() {
        if (!root || !root.querySelector) {
            return;
        }
        var undoRegion = root.querySelector('.todo-undo-region');
        if (undoRegion) {
            undoRegion.hidden = !state.undo;
            if (undoRegion.style) {
                undoRegion.style.display = state.undo ? 'flex' : '';
            }
            undoRegion.innerHTML = state.undo
                ? '<span>' + escapeHtml(state.undo.label) + '</span>'
                    + '<button class="todo-primary-button steward-button" type="button" '
                    + 'data-action="todo-undo">Undo</button>'
                : '';
        }
        var liveRegion = root.querySelector('.todo-live-region');
        if (liveRegion) {
            liveRegion.textContent = state.announcement;
        }
    }

    function render(force) {
        if (!root || !isSnapshot(state.snapshot)) {
            return false;
        }
        if (state.selectedTodoId && !renderer.findTodo(state.selectedTodoId)) {
            state.selectedTodoId = null;
            state.draft = null;
        }
        var surfaceHtml = renderer.renderListSurface();
        if (!force && surfaceHtml === state.renderedSurfaceHtml) {
            updateFeedback();
            return false;
        }
        var surface = !force && root.querySelector
            ? root.querySelector('.todo-list-surface')
            : null;
        if (surface && typeof surface.outerHTML === 'string') {
            surface.outerHTML = surfaceHtml;
        } else {
            root.innerHTML = surfaceHtml
                + renderer.renderUndo()
                + '<div class="todo-live-region" role="status" aria-live="polite" aria-atomic="true">'
                + escapeHtml(state.announcement) + '</div>';
        }
        state.renderedSurfaceHtml = surfaceHtml;
        syncTodoListExpandedHeights();
        refreshTodoLayoutObserverTargets();
        updateFeedback();
        if (typeof options.onRendered === 'function') {
            options.onRendered(panelHost);
        }
        return true;
    }

    function patchTodoElements(todoIds) {
        if (!root || !root.querySelector) {
            render();
            return false;
        }
        var patches = [];
        var uniqueTodoIds = todoIds.filter(function (todoId, index) {
            return todoId && todoIds.indexOf(todoId) === index;
        });
        for (var index = 0; index < uniqueTodoIds.length; index += 1) {
            var todoId = uniqueTodoIds[index];
            var todo = renderer.findTodo(todoId);
            var selector = '.todo-item[data-todo-id="' + String(todoId).replace(/"/g, '\\"') + '"]';
            var item = root.querySelector(selector);
            if (!todo || !item || typeof item.innerHTML !== 'string') {
                render();
                return false;
            }
            patches.push({ item: item, todo: todo });
        }
        patches.forEach(function (patch) {
            patch.item.className = renderer.todoClassName(patch.todo);
            patch.item.innerHTML = renderer.renderTodoBody(patch.todo);
        });
        state.renderedSurfaceHtml = renderer.renderListSurface();
        syncTodoListExpandedHeights();
        refreshTodoLayoutObserverTargets();
        updateFeedback();
        return true;
    }

    function patchTodoCompletion(todoId) {
        if (!root || !root.querySelector) {
            return false;
        }
        var todo = renderer.findTodo(todoId);
        var group = todo ? renderer.findGroup(todo.groupId) : null;
        var itemSelector = '.todo-item[data-todo-id="' + String(todoId).replace(/"/g, '\\"') + '"]';
        var groupSelector = group
            ? '.todo-group[data-todo-group-id="' + String(group.id).replace(/"/g, '\\"') + '"]'
            : '';
        var item = todo ? root.querySelector(itemSelector) : null;
        var groupElement = group && groupSelector ? root.querySelector(groupSelector) : null;
        var list = groupElement && groupElement.querySelector
            ? groupElement.querySelector('.todo-list')
            : null;
        var summaryMeta = root.querySelector('.todo-summary-meta');
        var groupCount = groupElement && groupElement.querySelector
            ? groupElement.querySelector('.todo-group-count')
            : null;
        if (!todo || !group || !item || typeof item.innerHTML !== 'string'
            || !groupElement || !list || !summaryMeta || !groupCount) {
            return false;
        }

        var visibleTodos = renderer.orderedTodos(group.id);
        var visibleIndex = visibleTodos.findIndex(function (candidate) {
            return candidate.id === todoId;
        });
        var remainsVisible = visibleIndex >= 0;
        if (!remainsVisible && state.selectedTodoId === todoId) {
            state.selectedTodoId = null;
            state.draft = null;
        }
        item.hidden = !remainsVisible;
        if (remainsVisible) {
            item.className = renderer.todoClassName(todo);
            item.innerHTML = renderer.renderTodoBody(todo);
            var nextTodo = visibleTodos[visibleIndex + 1];
            var nextItem = nextTodo && list.querySelector
                ? list.querySelector('.todo-item[data-todo-id="'
                    + String(nextTodo.id).replace(/"/g, '\\"') + '"]')
                : null;
            if (nextItem && nextItem !== item && list.insertBefore) {
                list.insertBefore(item, nextItem);
            } else if (list.appendChild) {
                list.appendChild(item);
            }
        }

        summaryMeta.textContent = renderer.todoSummaryMeta();
        groupCount.textContent = renderer.todoGroupMeta(group.id);
        var stats = renderer.getGroupStats(group.id);
        var hiddenCompleted = groupElement.querySelector('.todo-hidden-completed');
        if (hiddenCompleted) {
            hiddenCompleted.hidden = stats.hiddenCompletedCount === 0;
            hiddenCompleted.textContent = stats.hiddenCompletedCount + ' completed hidden';
        } else if (stats.hiddenCompletedCount > 0 && groupElement.insertAdjacentHTML) {
            groupElement.insertAdjacentHTML(
                'beforeend',
                '<p class="todo-hidden-completed">'
                    + stats.hiddenCompletedCount + ' completed hidden</p>'
            );
        }

        var emptyState = groupElement.querySelector('.todo-group-empty');
        list.hidden = visibleTodos.length === 0;
        if (emptyState) {
            emptyState.hidden = visibleTodos.length > 0;
        } else if (!visibleTodos.length && list.insertAdjacentHTML) {
            list.insertAdjacentHTML('afterend', '<p class="todo-group-empty">No visible todos</p>');
        }
        state.renderedSurfaceHtml = renderer.renderListSurface();
        syncTodoListExpandedHeights();
        refreshTodoLayoutObserverTargets();
        updateFeedback();
        return true;
    }

    function patchGroupElements(groupIds) {
        if (!root || !root.querySelector) {
            render();
            return false;
        }
        var patches = [];
        for (var index = 0; index < groupIds.length; index += 1) {
            var groupId = groupIds[index];
            var group = renderer.findGroup(groupId);
            var selector = '.todo-group[data-todo-group-id="' + String(groupId).replace(/"/g, '\\"') + '"]';
            var groupElement = root.querySelector(selector);
            var button = groupElement && groupElement.querySelector
                ? groupElement.querySelector('[data-action="todo-collapse-group"]')
                : null;
            if (!group || !groupElement || !groupElement.classList || !button) {
                render();
                return false;
            }
            patches.push({ group: group, element: groupElement, button: button });
        }
        patches.forEach(function (patch) {
            patch.element.classList.toggle('collapsed', patch.group.collapsed);
            patch.button.setAttribute('aria-expanded', patch.group.collapsed ? 'false' : 'true');
            patch.button.setAttribute('aria-label',
                (patch.group.collapsed ? 'Expand ' : 'Collapse ') + patch.group.title);
        });
        state.renderedSurfaceHtml = renderer.renderListSurface();
        updateFeedback();
        return true;
    }

    function announce(message) {
        state.announcement = message;
        render();
    }

    function mount(nextPanelHost, snapshotValue) {
        var nextRoot = nextPanelHost && nextPanelHost.querySelector
            ? nextPanelHost.querySelector('.todo-panel')
            : null;
        if (!nextRoot || !isSnapshot(snapshotValue)) {
            return false;
        }
        if (root && root !== nextRoot && root.removeEventListener) {
            root.removeEventListener('click', onClick);
            root.removeEventListener('change', onChange);
            root.removeEventListener('submit', onSubmit);
            root.removeEventListener('keydown', onKeyDown);
            root.removeEventListener('input', onInput);
        }
        panelHost = nextPanelHost;
        root = nextRoot;
        todoRefreshGeneration += 1;
        skipNextTodoLayoutObserverSync = false;
        state.renderedSurfaceHtml = '';
        state.snapshot = clone(snapshotValue);
        state.selectedTodoId = null;
        state.draft = null;
        clearCompose();
        root.addEventListener('click', onClick);
        root.addEventListener('change', onChange);
        root.addEventListener('submit', onSubmit);
        root.addEventListener('keydown', onKeyDown);
        root.addEventListener('input', onInput);
        render(true);
        observeTodoLayout();
        return true;
    }

    function getTodoScrollItemKey(item) {
        var group = item.closest('.todo-group[data-todo-group-id]');
        return JSON.stringify([
            group ? group.getAttribute('data-todo-group-id') || '' : '',
            item.getAttribute('data-todo-id') || '',
        ]);
    }

    function findTodoGroupElement(groupId) {
        if (!root || !root.querySelectorAll) {
            return null;
        }
        return Array.from(root.querySelectorAll('.todo-group[data-todo-group-id]'))
            .find(function (group) {
                return (group.getAttribute('data-todo-group-id') || '') === groupId;
            }) || null;
    }

    function findTodoItemElement(todoId, groupId) {
        if (!root || !root.querySelectorAll) {
            return null;
        }
        return Array.from(root.querySelectorAll('.todo-item[data-todo-id]'))
            .find(function (item) {
                if ((item.getAttribute('data-todo-id') || '') !== todoId) {
                    return false;
                }
                var group = item.closest('.todo-group[data-todo-group-id]');
                return !groupId
                    || !!group
                        && (group.getAttribute('data-todo-group-id') || '') === groupId;
            }) || null;
    }

    function captureTodoFocus() {
        var active = typeof document !== 'undefined' ? document.activeElement : null;
        if (!active
            || !root
            || typeof root.contains === 'function' && !root.contains(active)) {
            return null;
        }
        var item = closest(active, '.todo-item[data-todo-id]');
        var group = closest(active, '.todo-group[data-todo-group-id]');
        var actionElement = closest(active, '[data-action]');
        var form = closest(active, '[data-todo-form]');
        return {
            todoId: item
                ? item.getAttribute('data-todo-id') || null
                : form && form.getAttribute('data-todo-id') || null,
            groupId: group
                ? group.getAttribute('data-todo-group-id') || null
                : form && (form.getAttribute('data-group-id')
                    || form.getAttribute('data-todo-group-id')) || null,
            action: actionElement ? actionElement.getAttribute('data-action') || null : null,
            formKind: form ? form.getAttribute('data-todo-form') || null : null,
            fieldName: active.getAttribute ? active.getAttribute('name') || null : null,
        };
    }

    function captureTodoRefreshState() {
        var groups = root && root.querySelectorAll
            ? Array.from(root.querySelectorAll('.todo-group[data-todo-group-id]'))
                .map(function (group) {
                    var list = group.querySelector('.todo-list');
                    return {
                        groupId: group.getAttribute('data-todo-group-id') || '',
                        anchor: list
                            && window.__agentPivotScrollState
                            && typeof window.__agentPivotScrollState.capture === 'function'
                            ? window.__agentPivotScrollState.capture(list, {
                                itemSelector: '.todo-item[data-todo-id]',
                                getKey: getTodoScrollItemKey,
                            })
                            : list ? {
                                scrollTop: Math.max(0, Number(list.scrollTop) || 0),
                                itemKey: null,
                                itemOffset: 0,
                                atEnd: false,
                            } : null,
                    };
                })
            : [];
        return {
            windowScrollY: typeof window.scrollY === 'number' ? window.scrollY : 0,
            selectedTodoId: state.selectedTodoId,
            draft: clone(state.draft),
            composeGroupId: state.composeGroupId,
            composeDraft: clone(state.composeDraft),
            composeRequestId: state.composeRequestId,
            focus: captureTodoFocus(),
            groups: groups,
        };
    }

    function isTodoRendered(todoId) {
        var todo = renderer.findTodo(todoId);
        var group = todo && renderer.findGroup(todo.groupId);
        return !!todo
            && !!group
            && !group.collapsed
            && renderer.orderedTodos(group.id).some(function (candidate) {
                return candidate.id === todoId;
            });
    }

    function composeTargetSurvives(composeGroupId, composeDraft) {
        if (composeGroupId === undefined || !composeDraft) {
            return false;
        }
        if (typeof composeGroupId === 'string') {
            return !!renderer.findGroup(composeGroupId);
        }
        if (composeGroupId !== null) {
            return false;
        }
        return typeof composeDraft.groupId !== 'string'
            || composeDraft.groupId.length === 0
            || !!renderer.findGroup(composeDraft.groupId);
    }

    function reconcileTodoRefreshState(local) {
        if (local.selectedTodoId && isTodoRendered(local.selectedTodoId)) {
            state.selectedTodoId = local.selectedTodoId;
            state.draft = clone(local.draft);
        } else {
            state.selectedTodoId = null;
            state.draft = null;
        }
        if (composeTargetSurvives(local.composeGroupId, local.composeDraft)) {
            state.composeGroupId = local.composeGroupId;
            state.composeDraft = clone(local.composeDraft);
            state.composeRequestId = local.composeRequestId;
        } else {
            clearCompose();
        }
    }

    function findTodoFocusTarget(target) {
        if (!target || !root) {
            return null;
        }
        if (target.formKind) {
            var forms = root.querySelectorAll
                ? Array.from(root.querySelectorAll('[data-todo-form]'))
                : [];
            var form = forms.find(function (candidate) {
                if (candidate.getAttribute('data-todo-form') !== target.formKind) {
                    return false;
                }
                if (target.formKind === 'detail-edit') {
                    return candidate.getAttribute('data-todo-id') === target.todoId;
                }
                if (target.formKind === 'quick-add') {
                    return candidate.getAttribute('data-group-id') === target.groupId;
                }
                return target.formKind === 'add';
            });
            if (!form || form.hidden === true || form.hasAttribute && form.hasAttribute('hidden')) {
                return null;
            }
            if (target.fieldName && form.querySelectorAll) {
                return Array.from(form.querySelectorAll('[name]')).find(function (field) {
                    return field.getAttribute('name') === target.fieldName;
                }) || null;
            }
            if (target.action && form.querySelectorAll) {
                return Array.from(form.querySelectorAll('[data-action]')).find(function (action) {
                    return action.getAttribute('data-action') === target.action;
                }) || null;
            }
            return null;
        }
        var scope = target.todoId
            ? findTodoItemElement(target.todoId, target.groupId)
            : target.groupId
                ? findTodoGroupElement(target.groupId)
                : root;
        if (!scope) {
            return null;
        }
        if (!target.action) {
            return target.todoId ? scope : null;
        }
        var actions = scope.querySelectorAll
            ? Array.from(scope.querySelectorAll('[data-action]'))
            : [];
        return actions.find(function (action) {
            return action.getAttribute('data-action') === target.action;
        }) || null;
    }

    function restoreTodoRefreshState(local) {
        if (!local) {
            return;
        }
        if (typeof window.scrollTo === 'function') {
            window.scrollTo(0, local.windowScrollY);
        }
        var focusTarget = findTodoFocusTarget(local.focus);
        if (focusTarget && typeof focusTarget.focus === 'function') {
            focusTarget.focus({ preventScroll: true });
        }
        if (Array.isArray(local.groups)) {
            local.groups.forEach(function (savedGroup) {
                if (!savedGroup.anchor) {
                    return;
                }
                var group = findTodoGroupElement(savedGroup.groupId);
                var list = group && group.querySelector('.todo-list');
                if (!list) {
                    return;
                }
                if (window.__agentPivotScrollState
                    && typeof window.__agentPivotScrollState.restore === 'function') {
                    window.__agentPivotScrollState.restore(list, savedGroup.anchor, {
                        itemSelector: '.todo-item[data-todo-id]',
                        getKey: getTodoScrollItemKey,
                    });
                } else {
                    list.scrollTop = Math.min(
                        Math.max(0, Number(savedGroup.anchor.scrollTop) || 0),
                        Math.max(0, list.scrollHeight - list.clientHeight)
                    );
                }
            });
        }
    }

    var todoRefreshGeneration = 0;

    function scheduleTodoRefreshStateRecheck(local) {
        var generation = ++todoRefreshGeneration;
        if (typeof requestAnimationFrame !== 'function') {
            return;
        }
        requestAnimationFrame(function () {
            if (generation === todoRefreshGeneration) {
                syncTodoListExpandedHeights();
                restoreTodoRefreshState(local);
            }
        });
    }

    function applyRefresh(snapshotValue) {
        if (!root || !isSnapshot(snapshotValue)) {
            return false;
        }
        var local = captureTodoRefreshState();
        state.snapshot = clone(snapshotValue);
        Array.from(state.pending.entries())
            .sort(function (left, right) { return left[0] - right[0]; })
            .forEach(function (entry) {
                optimisticMutation(entry[1].action, entry[1].payload);
            });
        reconcileTodoRefreshState(local);
        skipNextTodoLayoutObserverSync = true;
        render(true);
        restoreTodoRefreshState(local);
        scheduleTodoRefreshStateRecheck(local);
        return true;
    }

    function openDetail(todoId) {
        var todo = renderer.findTodo(todoId);
        if (!todo) {
            return false;
        }
        var group = renderer.findGroup(todo.groupId);
        var rendered = renderer.orderedTodos(todo.groupId).some(function (item) {
            return item.id === todoId;
        });
        if (!rendered || (group && group.collapsed)) {
            return false;
        }
        if (state.selectedTodoId === todoId) {
            return true;
        }
        var previousTodoId = state.selectedTodoId;
        state.restoreFocusTodoId = todoId;
        state.selectedTodoId = todoId;
        state.draft = null;
        clearCompose();
        patchTodoElements([previousTodoId, todoId]);
        return true;
    }

    function backToList() {
        if (!state.selectedTodoId) {
            return false;
        }
        var focusTodoId = state.selectedTodoId;
        state.selectedTodoId = null;
        state.draft = null;
        patchTodoElements([focusTodoId]);
        if (focusTodoId && root && root.querySelector) {
            var selector = '[data-action="todo-open-detail"][data-todo-id="' + focusTodoId.replace(/"/g, '\\"') + '"]';
            var focusTarget = root.querySelector(selector);
            if (focusTarget && focusTarget.focus) {
                focusTarget.focus();
            }
        }
        return true;
    }

    function toggleDetail(todoId) {
        if (state.selectedTodoId === todoId) {
            return backToList();
        }
        return openDetail(todoId);
    }

    function optimisticMutation(action, payload) {
        if (action === 'complete') {
            var completedTodo = renderer.findTodo(payload.todoId);
            if (completedTodo) {
                completedTodo.completed = payload.completed === true;
                completedTodo.completedAt = payload.completed ? new Date().toISOString() : undefined;
            }
        } else if (action === 'delete') {
            state.snapshot.data.todos = state.snapshot.data.todos.filter(function (todo) {
                return todo.id !== payload.todoId;
            });
            if (state.selectedTodoId === payload.todoId) {
                state.selectedTodoId = null;
                state.draft = null;
            }
        } else if (action === 'collapse-group') {
            var group = renderer.findGroup(payload.groupId);
            if (group) {
                group.collapsed = payload.collapsed === true;
            }
        } else if (action === 'collapse-groups') {
            state.snapshot.data.groups.forEach(function (item) {
                item.collapsed = payload.collapsed === true;
            });
        } else if (action === 'show-completed') {
            state.snapshot.showCompleted = payload.showCompleted === true;
        } else if (action === 'update') {
            var updated = renderer.findTodo(payload.todoId);
            if (updated) {
                ['title', 'notes', 'priority', 'groupId'].forEach(function (key) {
                    if (payload[key] !== undefined) {
                        updated[key] = payload[key];
                    }
                });
            }
        } else if (action === 'reorder-items' && Array.isArray(payload.todoIds)) {
            payload.todoIds.forEach(function (todoId, index) {
                var todo = renderer.findTodo(todoId);
                if (todo && todo.groupId === payload.groupId) {
                    todo.order = index;
                }
            });
        } else if (action === 'reorder-groups' && Array.isArray(payload.groupIds)) {
            payload.groupIds.forEach(function (groupId, index) {
                var reorderedGroup = renderer.findGroup(groupId);
                if (reorderedGroup) {
                    reorderedGroup.order = index;
                }
            });
        }
    }

    function dispatch(action, payload) {
        if (!state.snapshot) {
            return 0;
        }
        var requestId = ++state.nextRequestId;
        state.pending.set(requestId, {
            snapshot: clone(state.snapshot),
            selectedTodoId: state.selectedTodoId,
            draft: clone(state.draft),
            compose: action === 'add'
                && state.composeGroupId !== undefined
                && state.composeDraft
                ? {
                    groupId: state.composeGroupId,
                    draft: clone(state.composeDraft),
                }
                : null,
            action: action,
            payload: clone(payload || {}),
        });
        optimisticMutation(action, payload || {});
        if (action === 'complete') {
            if (!patchTodoCompletion(payload.todoId)) {
                render();
            }
        } else if (action === 'collapse-group') {
            patchGroupElements([payload.groupId]);
        } else if (action === 'collapse-groups') {
            patchGroupElements(state.snapshot.data.groups.map(function (group) { return group.id; }));
        } else if (action === 'reorder-items' || action === 'reorder-groups') {
            state.renderedSurfaceHtml = renderer.renderListSurface();
            updateFeedback();
        } else {
            render();
        }
        postMessage({
            type: 'todo-command',
            version: 2,
            requestId: requestId,
            action: action,
            payload: payload || {},
        });
        return requestId;
    }

    function errorMessage(code) {
        if (code === 'conflict') return 'TODO data changed elsewhere. The latest saved version is shown.';
        if (code === 'not-found') return 'That TODO no longer exists.';
        if (code === 'invalid') return 'Check the TODO fields and try again.';
        if (code === 'undo-expired') return 'The Undo window has expired.';
        return 'Could not save the TODO change. Your saved list has been restored.';
    }

    function showUndo(token, action) {
        if (state.undoTimer) {
            clearTimeout(state.undoTimer);
        }
        state.undo = {
            token: token,
            label: action === 'delete' ? 'TODO deleted' : 'TODO updated',
        };
        state.undoTimer = setTimeout(function () {
            state.undo = null;
            state.undoTimer = null;
            updateFeedback();
        }, 5000);
    }

    function isCompletionOnlySnapshotChange(previousSnapshot, nextSnapshot, pending) {
        if (!isSnapshot(previousSnapshot)
            || !isSnapshot(nextSnapshot)
            || !pending
            || pending.action !== 'complete'
            || !pending.payload
            || typeof pending.payload.todoId !== 'string'
            || typeof pending.payload.completed !== 'boolean') {
            return false;
        }
        var previousComparable = clone(previousSnapshot);
        var nextComparable = clone(nextSnapshot);
        var previousTodo = previousComparable.data.todos.find(function (todo) {
            return todo.id === pending.payload.todoId;
        });
        var nextTodo = nextComparable.data.todos.find(function (todo) {
            return todo.id === pending.payload.todoId;
        });
        if (!previousTodo
            || !nextTodo
            || nextTodo.completed !== pending.payload.completed) {
            return false;
        }
        ['completed', 'completedAt', 'updatedAt'].forEach(function (key) {
            if (Object.prototype.hasOwnProperty.call(nextTodo, key)) {
                previousTodo[key] = nextTodo[key];
            } else {
                delete previousTodo[key];
            }
        });
        return JSON.stringify(previousComparable) === JSON.stringify(nextComparable);
    }

    function applyCommandResult(message) {
        if (!message
            || message.type !== 'todo-command-result'
            || message.version !== 2
            || !Number.isSafeInteger(message.revision)
            || message.revision <= state.lastRevision
            || !isSnapshot(message.snapshot)) {
            return false;
        }
        state.lastRevision = message.revision;
        var pending = state.pending.get(message.requestId);
        var previousSnapshot = clone(state.snapshot);
        state.pending.delete(message.requestId);
        state.snapshot = clone(message.snapshot);
        Array.from(state.pending.entries())
            .sort(function (left, right) { return left[0] - right[0]; })
            .forEach(function (entry) {
                optimisticMutation(entry[1].action, entry[1].payload);
            });
        if (message.searchCatalog
            && typeof options.replaceSearchCatalog === 'function') {
            options.replaceSearchCatalog(message.searchCatalog);
        }
        if (message.success === true) {
            if (pending && pending.action === 'update') {
                state.draft = null;
            }
            if (pending
                && pending.compose
                && state.composeRequestId === message.requestId) {
                clearCompose();
            } else if (!composeTargetSurvives(state.composeGroupId, state.composeDraft)) {
                clearCompose();
            }
            if (message.undoToken) {
                showUndo(message.undoToken, pending ? pending.action : '');
            }
            state.announcement = pending && pending.action === 'add'
                ? 'TODO added'
                : 'TODO saved';
        } else {
            if (pending) {
                state.selectedTodoId = pending.selectedTodoId;
                state.draft = pending.draft;
            }
            if (pending
                && pending.compose
                && state.composeRequestId === message.requestId) {
                if (composeTargetSurvives(
                    pending.compose.groupId,
                    pending.compose.draft
                )) {
                    state.composeGroupId = pending.compose.groupId;
                    state.composeDraft = clone(pending.compose.draft);
                    state.composeRequestId = null;
                } else {
                    clearCompose();
                }
            } else if (!composeTargetSurvives(state.composeGroupId, state.composeDraft)) {
                clearCompose();
            }
            state.announcement = errorMessage(message.errorCode);
        }
        if (message.success === true
            && isCompletionOnlySnapshotChange(previousSnapshot, state.snapshot, pending)) {
            if (!patchTodoCompletion(pending.payload.todoId)) {
                render();
            }
        } else {
            render();
        }
        return true;
    }

    function undo() {
        if (!state.undo) {
            return false;
        }
        var token = state.undo.token;
        state.undo = null;
        if (state.undoTimer) {
            clearTimeout(state.undoTimer);
            state.undoTimer = null;
        }
        dispatch('undo', { undoToken: token });
        return true;
    }

    function submitQuickAdd(groupId, title, notes, priority) {
        var normalizedTitle = String(title || '').trim();
        if (!normalizedTitle) {
            announce('Enter a TODO title.');
            return false;
        }
        state.composeGroupId = groupId;
        state.composeDraft = {
            title: String(title || ''),
            notes: String(notes || ''),
            priority: String(priority || '') || 'medium',
            groupId: groupId,
        };
        state.composeRequestId = dispatch('add', {
            title: normalizedTitle,
            notes: state.composeDraft.notes,
            priority: state.composeDraft.priority,
            groupId: groupId,
        });
        return true;
    }

    function readValue(form, name) {
        var field = form && form.querySelector ? form.querySelector('[name="' + name + '"]') : null;
        return field ? String(field.value || '') : '';
    }

    function onSubmit(event) {
        var form = event.target;
        if (!form || !form.getAttribute) {
            return;
        }
        var kind = form.getAttribute('data-todo-form');
        if (!kind) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (kind === 'quick-add') {
            submitQuickAdd(
                form.getAttribute('data-group-id'),
                readValue(form, 'title'),
                readValue(form, 'notes'),
                readValue(form, 'priority')
            );
        } else if (kind === 'add') {
            var title = readValue(form, 'title').trim();
            if (!title) {
                announce('Enter a TODO title.');
                return;
            }
            state.composeGroupId = null;
            state.composeDraft = {
                title: readValue(form, 'title'),
                notes: readValue(form, 'notes'),
                priority: readValue(form, 'priority') || 'medium',
                groupId: readValue(form, 'groupId'),
            };
            state.composeRequestId = dispatch('add', {
                title: title,
                notes: state.composeDraft.notes,
                priority: state.composeDraft.priority,
                groupId: state.composeDraft.groupId,
            });
        } else if (kind === 'detail-edit') {
            var todoId = form.getAttribute('data-todo-id');
            var detailTitle = readValue(form, 'title').trim();
            if (!detailTitle) {
                announce('Enter a TODO title.');
                return;
            }
            dispatch('update', {
                todoId: todoId,
                title: detailTitle,
                notes: readValue(form, 'notes'),
                priority: readValue(form, 'priority') || 'medium',
                groupId: readValue(form, 'groupId'),
            });
        }
    }

    function closest(target, selector) {
        return target && target.closest ? target.closest(selector) : null;
    }

    function onClick(event) {
        var actionTarget = closest(event.target, '[data-action]');
        if (!actionTarget) {
            var item = closest(event.target, '.todo-item[data-todo-id]');
            if (item
                && !closest(event.target, '.todo-inline-detail')
                && !closest(event.target, 'button, input, textarea, select, label, a')) {
                toggleDetail(item.getAttribute('data-todo-id'));
            }
            return;
        }
        var action = actionTarget.getAttribute('data-action');
        var todoId = actionTarget.getAttribute('data-todo-id');
        var groupId = actionTarget.getAttribute('data-group-id')
            || actionTarget.getAttribute('data-todo-group-id');
        if (action === 'todo-open-detail') {
            toggleDetail(todoId);
        } else if (action === 'todo-back') {
            backToList();
        } else if (action === 'todo-edit-detail') {
            var todo = renderer.findTodo(state.selectedTodoId);
            state.draft = todo ? renderer.detailDraft(todo) : null;
            patchTodoElements([state.selectedTodoId]);
        } else if (action === 'todo-cancel-detail-edit') {
            state.draft = null;
            patchTodoElements([state.selectedTodoId]);
        } else if (action === 'todo-toggle-detail') {
            var detailTodo = renderer.findTodo(todoId);
            if (detailTodo) dispatch('complete', { todoId: todoId, completed: !detailTodo.completed });
        } else if (action === 'todo-delete') {
            dispatch('delete', { todoId: todoId });
        } else if (action === 'todo-undo') {
            undo();
        } else if (action === 'todo-add') {
            state.composeGroupId = null;
            state.composeDraft = {
                title: '',
                notes: '',
                priority: 'medium',
                groupId: null,
            };
            state.composeRequestId = null;
            render();
            focusCompose(null);
        } else if (action === 'todo-cancel-add' || action === 'todo-cancel-quick-add') {
            clearCompose();
            render();
        } else if (action === 'todo-quick-add') {
            state.composeGroupId = groupId;
            state.composeDraft = {
                title: '',
                notes: '',
                priority: 'medium',
                groupId: groupId,
            };
            state.composeRequestId = null;
            render();
            focusCompose(groupId);
        } else if (action === 'todo-collapse-group') {
            var group = renderer.findGroup(groupId);
            if (group) dispatch('collapse-group', { groupId: groupId, collapsed: !group.collapsed });
        } else if (action === 'todo-sort-priority') {
            dispatch('sort-priority', { groupId: groupId });
        } else if (action === 'todo-add-group'
            || action === 'todo-rename-group'
            || action === 'todo-delete-group') {
            postMessage({
                type: action,
                groupId: groupId,
            });
        }
    }

    function onChange(event) {
        onInput(event);
        var toggle = closest(event.target, '[data-action="todo-toggle"]');
        if (toggle) {
            dispatch('complete', {
                todoId: toggle.getAttribute('data-todo-id'),
                completed: toggle.checked === true,
            });
            return;
        }
        var showCompleted = closest(event.target, '[data-action="todo-toggle-show-completed"]');
        if (showCompleted) {
            dispatch('show-completed', { showCompleted: showCompleted.checked === true });
        }
    }

    function onKeyDown(event) {
        if (event.key === 'Escape') {
            if (state.draft) {
                state.draft = null;
                render();
                event.preventDefault();
            } else if (state.selectedTodoId) {
                backToList();
                event.preventDefault();
            } else if (state.composeGroupId !== undefined) {
                clearCompose();
                render();
                event.preventDefault();
            }
        } else if (event.altKey && event.key === 'ArrowLeft' && state.selectedTodoId) {
            backToList();
            event.preventDefault();
        }
    }

    function onInput(event) {
        var field = event.target;
        if (!field
            || !field.closest
            || !field.getAttribute) {
            return;
        }
        var name = field.getAttribute('name');
        if (state.draft
            && field.closest('.todo-detail-edit-form')
            && (name === 'title' || name === 'notes' || name === 'priority' || name === 'groupId')) {
            state.draft[name] = String(field.value || '');
            state.renderedSurfaceHtml = renderer.renderListSurface();
            return;
        }
        var composeForm = field.closest('.todo-add-form[data-todo-form]');
        if (state.composeDraft
            && composeForm
            && (name === 'title' || name === 'notes' || name === 'priority' || name === 'groupId')) {
            state.composeRequestId = null;
            state.composeDraft[name] = String(field.value || '');
            state.renderedSurfaceHtml = renderer.renderListSurface();
        }
    }

    function focusCompose(groupId) {
        if (!root || !root.querySelector) {
            return;
        }
        var selector = groupId === null
            ? '.todo-add-form [name="title"]'
            : '.todo-add-form[data-todo-form="quick-add"][data-group-id="'
                + String(groupId).replace(/"/g, '\\"') + '"] [name="title"]';
        var input = root.querySelector(selector);
        if (input && input.focus) {
            input.focus();
        }
    }

    function onWindowMessage(event) {
        if (event && event.data && event.data.type === 'todo-command-result') {
            applyCommandResult(event.data);
        }
    }

    window.addEventListener('message', onWindowMessage);

    var controller = {
        mount: mount,
        openDetail: openDetail,
        toggleDetail: toggleDetail,
        backToList: backToList,
        dispatch: dispatch,
        applyRefresh: applyRefresh,
        applyCommandResult: applyCommandResult,
        submitQuickAdd: submitQuickAdd,
        undo: undo,
        getState: function () { return state; },
        getRoot: function () { return root; },
    };
    window.__agentPivotTodo = controller;
    return controller;
}
