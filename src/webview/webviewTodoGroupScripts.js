function getCollapseButtonState(tab, collapsedStates) {
    tab = tab === 'projects' || tab === 'todo' || tab === 'ai' ? tab : 'open';
    if (tab === 'ai') {
        return {
            disabled: true,
            collapsed: false,
            title: 'No groups to collapse in AI',
        };
    }
    var labels = tab === 'todo'
        ? {
            empty: 'No TODO groups to collapse',
            collapse: 'Collapse TODO Groups',
            expand: 'Expand TODO Groups',
        }
        : tab === 'open'
            ? {
                empty: 'No open windows to collapse',
                collapse: 'Collapse Open Windows',
                expand: 'Expand Open Windows',
            }
            : {
                empty: 'No project groups to collapse',
                collapse: 'Collapse All Groups',
                expand: 'Expand All Groups',
            };
    if (!collapsedStates.length) {
        return {
            disabled: true,
            collapsed: false,
            title: labels.empty,
        };
    }

    var collapsed = collapsedStates.every(Boolean);
    return {
        disabled: false,
        collapsed,
        title: collapsed ? labels.expand : labels.collapse,
    };
}

function syncTodoGroupCollapseControl(group) {
    if (!group || typeof group.querySelector !== 'function') {
        return;
    }
    var control = group.querySelector('[data-action="todo-collapse-group"]');
    if (!control) {
        return;
    }
    var collapsed = group.classList.contains('collapsed');
    var action = collapsed ? 'Expand' : 'Collapse';
    var heading = group.querySelector('h2');
    var groupTitle = heading ? String(heading.textContent || '').trim() : '';
    control.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    control.setAttribute('title', action + ' todo group');
    control.setAttribute('aria-label', action + (groupTitle ? ' ' + groupTitle : ' todo group'));
}

function syncTodoExpandControl(item, expanded) {
    if (!item || typeof item.querySelector !== 'function') {
        return;
    }
    var control = item.querySelector('[data-action="todo-toggle-expanded"]');
    if (!control) {
        return;
    }
    var action = expanded ? 'Collapse' : 'Expand';
    var titleElement = item.querySelector('.todo-title-text');
    var todoTitle = titleElement ? String(titleElement.textContent || '').trim() : '';
    control.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    control.setAttribute('title', action + ' todo');
    control.setAttribute('aria-label', action + (todoTitle ? ' ' + todoTitle : ' todo'));
}

function collapseTodoGroups(groups, collapsed, postMessage) {
    groups.forEach(group => {
        group.classList.toggle('collapsed', collapsed);
        syncTodoGroupCollapseControl(group);
    });
    postMessage({
        type: 'todo-collapse-groups',
        collapsed,
    });
}

var nextTodoMutationRequestId = 0;

function getTodoFormValue(form, name) {
    var checkedElement = form.querySelector('[name="' + name + '"]:checked');
    if (checkedElement) {
        return String(checkedElement.value || '').trim();
    }
    var element = form.querySelector('[name="' + name + '"]');
    return element ? String(element.value || '').trim() : '';
}

function setTodoComposePending(form, pending) {
    form.setAttribute('data-todo-pending', pending ? 'true' : 'false');
    var submitButton = form.querySelector('[type="submit"]');
    if (!submitButton)
        return;

    submitButton.disabled = pending;
    if (pending) {
        submitButton.setAttribute('aria-busy', 'true');
    } else {
        submitButton.removeAttribute('aria-busy');
    }
}

function submitTodoComposeForm(form, postMessage) {
    if (form.getAttribute('data-todo-pending') === 'true')
        return false;

    var title = getTodoFormValue(form, 'title');
    if (!title)
        return false;

    nextTodoMutationRequestId += 1;
    var requestId = nextTodoMutationRequestId;
    form.setAttribute('data-todo-request-id', String(requestId));
    setTodoComposePending(form, true);
    postMessage({
        type: 'todo-add',
        requestId,
        title,
        notes: getTodoFormValue(form, 'notes'),
        priority: getTodoFormValue(form, 'priority'),
        groupId: getTodoFormValue(form, 'groupId'),
    });
    return true;
}

function applyTodoMutationResult(message, root) {
    if (!message
        || message.type !== 'todo-mutation-result'
        || message.version !== 1
        || !Number.isSafeInteger(message.requestId)
        || message.requestId < 1
        || typeof message.success !== 'boolean') {
        return false;
    }

    var form = root.querySelector('.todo-add-form[data-todo-request-id="' + message.requestId + '"]');
    if (!form)
        return false;
    if (!message.success) {
        setTodoComposePending(form, false);
        form.removeAttribute('data-todo-request-id');
    } else if (message.panelRefreshed === false) {
        form.reset();
        setTodoComposePending(form, false);
        form.removeAttribute('data-todo-request-id');
    }
    return true;
}
