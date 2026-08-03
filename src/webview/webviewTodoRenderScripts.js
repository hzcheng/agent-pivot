function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isSnapshot(value) {
    return !!value
        && value.version === 1
        && value.data
        && value.data.version === 1
        && Array.isArray(value.data.groups)
        && Array.isArray(value.data.todos)
        && typeof value.showCompleted === 'boolean';
}

function renderTodoCommandIcon(kind) {
    if (kind === 'add') {
        return '<svg viewBox="0 0 512 512"><path d="M416 208H272V64c0-17.67-14.33-32-32-32h-32'
            + 'c-17.67 0-32 14.33-32 32v144H32c-17.67 0-32 14.33-32 32v32c0 17.67 14.33 32 32 32'
            + 'h144v144c0 17.67 14.33 32 32 32h32c17.67 0 32-14.33 32-32V304h144c17.67 0 32-14.33'
            + ' 32-32v-32c0-17.67-14.33-32-32-32z"></path></svg>';
    }
    if (kind === 'group') {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
            + 'stroke-linecap="round" stroke-linejoin="round"><path d="m3.5 6 1.5 1.5L7.5 5"></path>'
            + '<path d="m3.5 12 1.5 1.5 2.5-2.5"></path><path d="m3.5 18 1.5 1.5L7.5 17"></path>'
            + '<path d="M10.5 6.5h10M10.5 12.5h10M10.5 18.5h10"></path></svg>';
    }
    return '<svg viewBox="0 0 448 512"><path d="M64 32C28.7 32 0 60.7 0 96v320c0 35.3 28.7'
        + ' 64 64 64h320c35.3 0 64-28.7 64-64V96c0-35.3-28.7-64-64-64H64zm88 200h144c13.3 0'
        + ' 24 10.7 24 24s-10.7 24-24 24H152c-13.3 0-24-10.7-24-24s10.7-24 24-24z"></path></svg>';
}

function renderGroupChevron() {
    return '<span class="todo-group-chevron collapse-icon" aria-hidden="true">'
        + '<svg viewBox="0 0 320 512"><path d="M143 352.3L7 216.3c-9.4-9.4-9.4-24.6 '
        + '0-33.9l22.6-22.6c9.4-9.4 24.6-9.4 33.9 0l96.4 96.4 96.4-96.4c9.4-9.4 '
        + '24.6-9.4 33.9 0l22.6 22.6c9.4 9.4 9.4 24.6 0 33.9l-136 136c-9.2 '
        + '9.4-24.4 9.4-33.8 0z"></path></svg></span>';
}

function createTodoRenderer(options) {
    'use strict';

    options = options || {};
    var state = options.state;

    function orderedGroups() {
        return state.snapshot.data.groups.slice().sort(function (left, right) {
            return left.order - right.order;
        });
    }

    function orderedTodos(groupId) {
        var todos = state.snapshot.data.todos
            .filter(function (todo) { return todo.groupId === groupId; })
            .sort(function (left, right) { return left.order - right.order; });
        var incomplete = todos.filter(function (todo) { return !todo.completed; });
        var completed = todos.filter(function (todo) { return todo.completed; });
        var visibleCompleted = state.snapshot.showCompleted
            ? completed
            : completed.filter(function (todo) {
                return todo.id === state.snapshot.revealedTodoId;
            });
        return incomplete.concat(visibleCompleted);
    }

    function findTodo(todoId) {
        return state.snapshot && state.snapshot.data.todos.find(function (todo) {
            return todo.id === todoId;
        });
    }

    function findGroup(groupId) {
        return state.snapshot && state.snapshot.data.groups.find(function (group) {
            return group.id === groupId;
        });
    }

    function renderPriorityOptions(selected) {
        return ['high', 'medium', 'low'].map(function (priority) {
            return '<option value="' + priority + '"' + (priority === selected ? ' selected' : '') + '>'
                + priority.toUpperCase() + '</option>';
        }).join('');
    }

    function renderGroupOptions(selected) {
        return '<option value=""' + (!selected ? ' selected' : '') + '>Inbox</option>'
            + orderedGroups().map(function (group) {
            return '<option value="' + escapeHtml(group.id) + '"'
                + (group.id === selected ? ' selected' : '') + '>'
                + escapeHtml(group.title) + '</option>';
        }).join('');
    }

    function todoClassName(todo) {
        return 'todo-item steward-item-card todo-priority-' + escapeHtml(todo.priority)
            + (todo.completed ? ' completed' : '')
            + (state.selectedTodoId === todo.id ? ' expanded' : '');
    }

    function renderTodoBody(todo) {
        var checked = todo.completed ? ' checked' : '';
        var expanded = state.selectedTodoId === todo.id;
        var priorityBadge = todo.priority === 'medium'
            ? ''
            : '<span class="todo-priority-badge steward-badge">'
                + escapeHtml(todo.priority.toUpperCase()) + '</span>';
        return '<span class="todo-item-accent steward-item-accent" aria-hidden="true"></span>'
            + '<div class="todo-item-view"><div class="todo-item-main">'
            + '<label class="todo-check"><input type="checkbox" data-action="todo-toggle" data-todo-id="'
            + escapeHtml(todo.id) + '" aria-label="Complete ' + escapeHtml(todo.title) + '"' + checked + '>'
            + '<span class="todo-checkbox-visual"></span></label>'
            + '<div class="todo-item-content"><div class="todo-title-line">'
            + '<button class="todo-title-button" type="button" data-action="todo-open-detail" data-todo-id="'
            + escapeHtml(todo.id) + '" aria-expanded="' + (expanded ? 'true' : 'false') + '" title="'
            + (expanded ? 'Collapse details' : 'Expand details') + '"><span class="todo-title-text">'
            + escapeHtml(todo.title) + '</span></button>' + priorityBadge + '</div></div>'
            + '<div class="todo-item-actions">'
            + '<button class="todo-icon-button steward-icon-button danger" type="button" data-action="todo-delete" '
            + 'data-todo-id="' + escapeHtml(todo.id) + '" title="Delete todo" aria-label="Delete todo">×</button>'
            + '<button class="todo-drag-handle todo-icon-button steward-icon-button" type="button" draggable="true" '
            + 'data-drag-todo-item="' + escapeHtml(todo.id) + '" title="Drag to reorder" aria-label="Drag '
            + escapeHtml(todo.title) + '">⋮⋮</button></div>'
            + '</div>' + (expanded ? renderInlineDetail(todo) : '') + '</div>';
    }

    function renderTodo(todo) {
        return '<li class="' + todoClassName(todo) + '" data-todo-id="' + escapeHtml(todo.id) + '">'
            + renderTodoBody(todo) + '</li>';
    }

    function renderCompose(group) {
        var groupId = group ? group.id : null;
        var visible = state.composeGroupId === groupId;
        var draft = visible && state.composeDraft
            ? state.composeDraft
            : { title: '', notes: '', priority: 'medium', groupId: groupId };
        var groupControl = group
            ? '<input type="hidden" name="groupId" value="' + escapeHtml(group.id) + '">'
                + '<span class="todo-compose-group-fixed steward-meta" title="' + escapeHtml(group.title)
                + '" aria-label="Todo group: ' + escapeHtml(group.title) + '">' + escapeHtml(group.title) + '</span>'
            : '<select name="groupId" aria-label="Todo group">'
                + renderGroupOptions(draft.groupId) + '</select>';
        return '<form class="todo-add-form todo-compose-panel steward-card" data-todo-form="'
            + (group ? 'quick-add' : 'add') + '"'
            + (group ? ' data-group-id="' + escapeHtml(group.id) + '"' : '')
            + (visible ? '' : ' hidden') + '>'
            + '<div class="todo-compose-primary"><span class="todo-compose-icon">＋</span>'
            + '<input class="todo-title-input" type="text" name="title" placeholder="'
            + (group ? 'Add to ' + escapeHtml(group.title) : 'Add a todo') + '" aria-label="Todo title" value="'
            + escapeHtml(draft.title) + '">'
            + '</div><textarea class="todo-notes-input" name="notes" rows="2" placeholder="Notes" '
            + 'aria-label="Todo notes">' + escapeHtml(draft.notes)
            + '</textarea><div class="todo-form-row todo-compose-meta">'
            + '<select name="priority" aria-label="Todo priority">'
            + renderPriorityOptions(draft.priority) + '</select>'
            + groupControl
            + '<button class="todo-primary-button steward-button steward-button-primary" type="submit">Add</button>'
            + '<button class="todo-secondary-button steward-button" type="button" data-action="'
            + (group ? 'todo-cancel-quick-add' : 'todo-cancel-add') + '">Cancel</button></div></form>';
    }

    function getGroupStats(groupId) {
        var todos = state.snapshot.data.todos.filter(function (todo) {
            return todo.groupId === groupId;
        });
        var incompleteCount = todos.filter(function (todo) { return !todo.completed; }).length;
        var completedCount = todos.length - incompleteCount;
        var visibleCompletedCount = orderedTodos(groupId)
            .filter(function (todo) { return todo.completed; }).length;
        return {
            incompleteCount: incompleteCount,
            completedCount: completedCount,
            hiddenCompletedCount: completedCount - visibleCompletedCount,
        };
    }

    function todoGroupMeta(groupId) {
        var stats = getGroupStats(groupId);
        return stats.incompleteCount + ' open'
            + (state.snapshot.showCompleted && stats.completedCount
                ? ' · ' + stats.completedCount + ' done'
                : '');
    }

    function todoSummaryMeta() {
        var todos = state.snapshot.data.todos;
        var incomplete = todos.filter(function (todo) { return !todo.completed; }).length;
        var completed = todos.length - incomplete;
        var groupCount = orderedGroups().length;
        return incomplete + ' open · ' + groupCount + (groupCount === 1 ? ' group' : ' groups')
            + ' · ' + (state.snapshot.showCompleted ? completed + ' completed shown' : 'completed hidden');
    }

    function renderGroup(group) {
        var visibleTodos = orderedTodos(group.id);
        var stats = getGroupStats(group.id);
        return '<section class="todo-group group steward-section' + (group.collapsed ? ' collapsed' : '')
            + '" data-todo-group-id="' + escapeHtml(group.id) + '">'
            + '<header class="todo-group-header group-title steward-group-header">'
            + '<div class="todo-group-title-block group-title-text">'
            + '<button class="todo-group-collapse-button" type="button" data-action="todo-collapse-group" '
            + 'data-todo-group-id="' + escapeHtml(group.id) + '" aria-expanded="'
            + (group.collapsed ? 'false' : 'true') + '" aria-label="'
            + (group.collapsed ? 'Expand ' : 'Collapse ') + escapeHtml(group.title) + '">'
            + renderGroupChevron() + '</button>'
            + '<h2 data-drag-todo-group title="' + escapeHtml(group.title) + '">' + escapeHtml(group.title) + '</h2>'
            + '<span class="todo-group-count">' + todoGroupMeta(group.id) + '</span></div>'
            + '<div class="todo-group-actions group-actions right">'
            + '<button class="todo-group-action" type="button" data-action="todo-quick-add" data-group-id="'
            + escapeHtml(group.id) + '" title="Add todo to group" aria-label="Add todo to '
            + escapeHtml(group.title) + '">＋</button>'
            + '<button class="todo-group-action" type="button" data-action="todo-sort-priority" data-group-id="'
            + escapeHtml(group.id) + '" title="Sort by priority" aria-label="Sort by priority">⇅</button>'
            + '<button class="todo-group-action" type="button" data-action="todo-rename-group" data-group-id="'
            + escapeHtml(group.id) + '" title="Rename todo group" aria-label="Rename todo group">✎</button>'
            + '<button class="todo-group-action danger" type="button" data-action="todo-delete-group" data-group-id="'
            + escapeHtml(group.id) + '" title="Delete todo group" aria-label="Delete todo group">×</button>'
            + '</div></header>' + renderCompose(group)
            + (visibleTodos.length
                ? '<ul class="todo-list">' + visibleTodos.map(renderTodo).join('') + '</ul>'
                : '<p class="todo-group-empty">No visible todos</p>')
            + (stats.hiddenCompletedCount > 0
                ? '<p class="todo-hidden-completed">' + stats.hiddenCompletedCount + ' completed hidden</p>'
                : '')
            + '</section>';
    }

    function renderGlobalCompose() {
        return renderCompose(null);
    }

    function renderListSurface() {
        var groups = orderedGroups();
        return '<div class="todo-list-surface">'
            + '<header class="todo-page-header todo-page-command-bar">'
            + '<div class="todo-summary-copy"><strong>TODO</strong>'
            + '<span class="todo-summary-meta steward-meta">' + todoSummaryMeta() + '</span></div>'
            + '<div class="todo-summary-actions group-actions right">'
            + '<button class="todo-square-button steward-icon-button" type="button" data-action="todo-add" '
            + 'title="Add todo" aria-label="Add todo">' + renderTodoCommandIcon('add') + '</button>'
            + '<button class="todo-square-button steward-icon-button" type="button" data-action="todo-add-group" '
            + 'title="Add group" aria-label="Add group">' + renderTodoCommandIcon('group') + '</button>'
            + '<label class="todo-square-toggle steward-icon-button'
            + (state.snapshot.showCompleted ? ' active' : '') + '" title="Show completed" aria-label="Show completed">'
            + '<input type="checkbox" data-action="todo-toggle-show-completed"'
            + (state.snapshot.showCompleted ? ' checked' : '') + '><span>'
            + renderTodoCommandIcon('completed') + '</span></label>'
            + '</div></header>' + renderGlobalCompose()
            + (groups.length
                ? '<div class="todo-groups">' + groups.map(renderGroup).join('') + '</div>'
                : '<p class="todo-empty-state steward-empty-state">No todos yet</p>')
            + '</div>';
    }

    function detailDraft(todo) {
        return state.draft || {
            title: todo.title,
            notes: todo.notes || '',
            priority: todo.priority,
            groupId: todo.groupId,
        };
    }

    function renderInlineDetail(todo) {
        var group = findGroup(todo.groupId);
        var groupName = group ? group.title : 'Unknown group';
        if (state.draft) {
            var draft = detailDraft(todo);
            return '<form class="todo-inline-detail todo-detail-edit-form" data-todo-form="detail-edit" '
                + 'aria-label="Edit ' + escapeHtml(todo.title) + '" '
                + 'data-todo-id="' + escapeHtml(todo.id) + '">'
                + '<label class="todo-field-label">Title</label>'
                + '<textarea class="todo-title-input" name="title" rows="3" aria-label="Todo title">'
                + escapeHtml(draft.title) + '</textarea>'
                + '<label class="todo-field-label">Notes</label>'
                + '<textarea class="todo-notes-input" name="notes" rows="8" aria-label="Todo notes">'
                + escapeHtml(draft.notes) + '</textarea>'
                + '<label class="todo-field-label">Priority</label><select name="priority" aria-label="Todo priority">'
                + renderPriorityOptions(draft.priority) + '</select>'
                + '<label class="todo-field-label">Group</label><select name="groupId" aria-label="Todo group">'
                + renderGroupOptions(draft.groupId) + '</select>'
                + '<div class="todo-detail-actions"><button class="todo-primary-button steward-button '
                + 'steward-button-primary" type="submit">Save</button>'
                + '<button class="todo-secondary-button steward-button" type="button" '
                + 'data-action="todo-cancel-detail-edit">Cancel</button></div></form>';
        }
        return '<section class="todo-inline-detail" role="region" aria-label="Details for '
            + escapeHtml(todo.title) + '">'
            + '<div class="todo-inline-row"><span class="todo-inline-label">Notes</span>'
            + '<p class="todo-inline-value todo-detail-notes">' + escapeHtml(todo.notes || 'No notes') + '</p></div>'
            + '<div class="todo-inline-row"><span class="todo-inline-label">Group</span>'
            + '<span class="todo-inline-value">' + escapeHtml(groupName) + '</span></div>'
            + '<div class="todo-inline-row"><span class="todo-inline-label">Priority</span>'
            + '<span class="todo-inline-value">' + escapeHtml(todo.priority.toUpperCase()) + '</span></div>'
            + '<div class="todo-inline-row"><span class="todo-inline-label">Created</span>'
            + '<span class="todo-inline-value">' + escapeHtml(String(todo.createdAt || '').slice(0, 10)) + '</span></div>'
            + '<div class="todo-inline-row"><span class="todo-inline-label">Updated</span>'
            + '<span class="todo-inline-value">' + escapeHtml(String(todo.updatedAt || '').slice(0, 10)) + '</span></div>'
            + (todo.completedAt
                ? '<div class="todo-inline-row"><span class="todo-inline-label">Completed</span>'
                    + '<span class="todo-inline-value">'
                    + escapeHtml(String(todo.completedAt).slice(0, 10)) + '</span></div>'
                : '')
            + '<div class="todo-detail-actions">'
            + '<button class="todo-primary-button steward-button" type="button" data-action="todo-toggle-detail" '
            + 'data-todo-id="' + escapeHtml(todo.id) + '">' + (todo.completed ? 'Reopen' : 'Complete') + '</button>'
            + '<button class="todo-secondary-button steward-button" type="button" data-action="todo-edit-detail">Edit</button>'
            + '<button class="todo-secondary-button steward-button danger" type="button" data-action="todo-delete" '
            + 'data-todo-id="' + escapeHtml(todo.id) + '">Delete</button>'
            + '</div></section>';
    }

    function renderUndo() {
        if (!state.undo) {
            return '<div class="todo-undo-region" role="status" aria-live="polite" hidden></div>';
        }
        return '<div class="todo-undo-region" role="status" aria-live="polite" style="display:flex">'
            + '<span>' + escapeHtml(state.undo.label) + '</span>'
            + '<button class="todo-primary-button steward-button" type="button" data-action="todo-undo">Undo</button></div>';
    }

    return {
        orderedTodos: orderedTodos,
        findTodo: findTodo,
        findGroup: findGroup,
        renderTodoBody: renderTodoBody,
        todoClassName: todoClassName,
        getGroupStats: getGroupStats,
        todoGroupMeta: todoGroupMeta,
        todoSummaryMeta: todoSummaryMeta,
        renderListSurface: renderListSurface,
        renderUndo: renderUndo,
        detailDraft: detailDraft,
    };
}
