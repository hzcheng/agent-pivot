function initProjectTodoControls(options) {
    'use strict';

    options = options || {};
    var syncCollapseButton = typeof options.syncCollapseButton === 'function'
        ? options.syncCollapseButton
        : function () {};

    function isDedicatedTodoTarget(target) {
        return Boolean(window.__agentPivotTodo
            && target
            && target.closest
            && target.closest('#dashboard-tab-todo'));
    }

    function onInsideGroupClick(e, groupDiv) {
        var groupId = groupDiv.getAttribute("data-group-id");
        if (groupId == null)
            return;

        var actionDiv = e.target.closest('[data-action]')
        var action = actionDiv != null ? actionDiv.getAttribute("data-action") : null;
        if (!action)
            return;

        if (action === "add") {
            window.vscode.postMessage({
                type: 'add-project',
                groupId: groupId,
            });

            return;
        }

        var collapsed = groupDiv.classList.contains("collapsed");
        if (action === "collapse") {
            groupDiv.classList.toggle("collapsed");
            collapsed = groupDiv.classList.contains("collapsed");
        }

        window.vscode.postMessage({
            type: action + '-group',
            groupId: groupId,
            collapsed,
        });
        syncCollapseButton();
    }

    function onTodoAction(e) {
        var addTodoAction = e.target.closest('[data-action="todo-add"]');
        if (addTodoAction && !addTodoAction.closest('.todo-add-form')) {
            setTodoAddFormVisible(true, addTodoAction.getAttribute('data-group-id'));
            return true;
        }

        var addGroupAction = e.target.closest('[data-action="todo-add-group"]');
        if (addGroupAction) {
            window.vscode.postMessage({
                type: 'todo-add-group',
            });
            return true;
        }

        var toggleAction = e.target.closest('[data-action="todo-toggle"]');
        if (toggleAction) {
            window.vscode.postMessage({
                type: 'todo-toggle',
                todoId: toggleAction.getAttribute('data-todo-id'),
                completed: toggleAction.checked === true,
            });
            return true;
        }

        var deleteAction = e.target.closest('[data-action="todo-delete"]');
        if (deleteAction) {
            window.vscode.postMessage({
                type: 'todo-delete',
                todoId: deleteAction.getAttribute('data-todo-id'),
            });
            return true;
        }

        var deleteGroupAction = e.target.closest('[data-action="todo-delete-group"]');
        if (deleteGroupAction) {
            window.vscode.postMessage({
                type: 'todo-delete-group',
                groupId: deleteGroupAction.getAttribute('data-group-id'),
            });
            return true;
        }

        var renameGroupAction = e.target.closest('[data-action="todo-rename-group"]');
        if (renameGroupAction) {
            window.vscode.postMessage({
                type: 'todo-rename-group',
                groupId: renameGroupAction.getAttribute('data-group-id'),
            });
            return true;
        }

        var collapseGroupAction = e.target.closest('[data-action="todo-collapse-group"]');
        if (collapseGroupAction) {
            var todoGroup = collapseGroupAction.closest('.todo-group');
            if (!todoGroup)
                return true;
            todoGroup.classList.toggle('collapsed');
            syncTodoGroupCollapseControl(todoGroup);
            window.vscode.postMessage({
                type: 'todo-collapse-group',
                groupId: todoGroup.getAttribute('data-todo-group-id'),
                collapsed: todoGroup.classList.contains('collapsed'),
            });
            syncCollapseButton();
            return true;
        }

        var sortAction = e.target.closest('[data-action="todo-sort-priority"]');
        if (sortAction) {
            window.vscode.postMessage({
                type: 'todo-sort-priority',
                groupId: sortAction.getAttribute('data-group-id'),
            });
            return true;
        }

        var showCompletedAction = e.target.closest('[data-action="todo-toggle-show-completed"]');
        if (showCompletedAction) {
            window.vscode.postMessage({
                type: 'todo-toggle-show-completed',
                showCompleted: showCompletedAction.checked === true,
            });
            return true;
        }

        var focusAddAction = e.target.closest('[data-action="todo-focus-add"]');
        if (focusAddAction) {
            setTodoAddFormVisible(true, focusAddAction.getAttribute('data-group-id'));
            return true;
        }

        var cancelAddAction = e.target.closest('[data-action="todo-cancel-add"]');
        if (cancelAddAction) {
            setTodoAddFormVisible(false);
            return true;
        }

        var editAction = e.target.closest('[data-action="todo-edit"]');
        if (editAction) {
            setTodoEditing(editAction.getAttribute('data-todo-id'), true);
            return true;
        }

        var expandAction = e.target.closest('[data-action="todo-toggle-expanded"]');
        if (expandAction) {
            toggleTodoItemExpanded(expandAction.closest('.todo-item'));
            return true;
        }

        var cancelEditAction = e.target.closest('[data-action="todo-cancel-edit"]');
        if (cancelEditAction) {
            setTodoEditing(cancelEditAction.getAttribute('data-todo-id'), false);
            return true;
        }

        return false;
    }

    function syncTodoPrioritySegment(segment) {
        if (!segment)
            return;

        Array.from(segment.querySelectorAll('.todo-priority-choice')).forEach(choice => {
            var input = choice.querySelector('input[name="priority"]');
            choice.classList.toggle('active', !!input && input.checked === true);
        });
    }

    function resetTodoEditForm(form) {
        form.reset();
        syncTodoPrioritySegment(form.querySelector('.todo-priority-segment'));
    }

    function syncTodoListExpandedHeight(list) {
        if (!list)
            return;

        var panel = list.closest('.todo-panel');
        var collapsedHeightValue = panel
            ? getComputedStyle(panel).getPropertyValue('--todo-collapsed-item-height')
            : '';
        var collapsedHeight = parseFloat(collapsedHeightValue) || 58;
        var expandedExtraHeight = Array.from(list.querySelectorAll('.todo-item.expanded'))
            .reduce((total, expandedItem) => total + Math.max(0, expandedItem.offsetHeight - collapsedHeight), 0);
        list.style.setProperty('--todo-list-expanded-extra-height', expandedExtraHeight + 'px');
    }

    function toggleTodoItemExpanded(item, expanded) {
        if (!item)
            return;

        var nextExpanded = typeof expanded === 'boolean'
            ? expanded
            : !item.classList.contains('expanded');
        item.classList.toggle('expanded', nextExpanded);
        syncTodoExpandControl(item, nextExpanded);
        syncTodoListExpandedHeight(item.closest('.todo-list'));
    }

    function isTodoInteractiveTarget(target) {
        return !!(target && target.closest && target.closest('button, input, textarea, select, label, a, [data-action], .todo-edit-form'));
    }

    function setTodoAddFormVisible(visible, groupId) {
        var form = document.querySelector('.todo-add-form');
        if (!form)
            return;

        var groupSelect = form.querySelector('[name="groupId"]');
        if (visible && groupSelect) {
            groupSelect.value = groupId || '';
        }
        form.hidden = !visible;
        if (!visible)
            return;

        var titleInput = form.querySelector('[name="title"]');
        if (titleInput) {
            titleInput.focus();
        }
        form.scrollIntoView({ block: 'nearest' });
    }

    function setTodoEditing(todoId, editing) {
        if (!todoId)
            return;

        var item = Array.from(document.querySelectorAll('.todo-item[data-todo-id]'))
            .find(candidate => candidate.getAttribute('data-todo-id') === todoId);
        if (!item)
            return;

        var wasEditing = item.classList.contains('editing');
        var expandedBeforeEdit = item.getAttribute('data-expanded-before-edit');
        if (editing && !wasEditing) {
            item.setAttribute(
                'data-expanded-before-edit',
                item.classList.contains('expanded') ? 'true' : 'false'
            );
            expandedBeforeEdit = item.getAttribute('data-expanded-before-edit');
        }
        var view = item.querySelector('.todo-item-view');
        var form = item.querySelector('.todo-edit-form');
        var list = item.closest('.todo-list');
        if (form && !editing) {
            resetTodoEditForm(form);
        }
        item.classList.toggle('editing', editing);
        if (view) {
            view.hidden = false;
        }
        if (form) {
            form.hidden = !editing;
        }
        toggleTodoItemExpanded(item, editing ? true : expandedBeforeEdit === 'true');
        if (!editing) {
            item.removeAttribute('data-expanded-before-edit');
        }
        if (list) {
            list.classList.toggle('has-editing-item', !!list.querySelector('.todo-item.editing'));
        }
        if (form && editing) {
            var titleInput = form.querySelector('[name="title"]');
            if (titleInput) {
                titleInput.focus();
            }
            item.scrollIntoView({ block: 'nearest' });
        }
    }

    function onTodoFormSubmit(e) {
        if (window.__agentPivotTodo
            && e.target
            && e.target.closest
            && e.target.closest('#dashboard-tab-todo')) {
            return;
        }
        var addForm = e.target && e.target.closest ? e.target.closest('.todo-add-form') : null;
        if (addForm) {
            e.preventDefault();
            submitTodoComposeForm(addForm, message => window.vscode.postMessage(message));
            return;
        }

        var editForm = e.target && e.target.closest ? e.target.closest('.todo-edit-form') : null;
        if (editForm) {
            e.preventDefault();
            var todoId = editForm.getAttribute('data-todo-id');
            var editTitle = getTodoFormValue(editForm, 'title');
            if (!todoId || !editTitle)
                return;
            window.vscode.postMessage({
                type: 'todo-update',
                todoId,
                title: editTitle,
                notes: getTodoFormValue(editForm, 'notes'),
                priority: getTodoFormValue(editForm, 'priority'),
            });
        }
    }

    return {
        isDedicatedTodoTarget: isDedicatedTodoTarget,
        isTodoInteractiveTarget: isTodoInteractiveTarget,
        onInsideGroupClick: onInsideGroupClick,
        onTodoAction: onTodoAction,
        onTodoFormSubmit: onTodoFormSubmit,
        resetTodoEditForm: resetTodoEditForm,
        setTodoAddFormVisible: setTodoAddFormVisible,
        setTodoEditing: setTodoEditing,
        syncTodoListExpandedHeight: syncTodoListExpandedHeight,
        syncTodoPrioritySegment: syncTodoPrioritySegment,
        toggleTodoItemExpanded: toggleTodoItemExpanded,
    };
}
