function getProjectIdsFromGroup(group) {
    return Array.from(group.querySelectorAll('.project[data-id]:not([data-virtual-project])'))
        .map(project => project.getAttribute('data-id'));
}

function arraysEqual(left, right) {
    return left.length === right.length
        && left.every((value, index) => value === right[index]);
}

function isProjectsPanelOrderConsistent(panel, message) {
    if (!panel || typeof panel.querySelectorAll !== 'function') {
        return false;
    }
    var groups = Array.from(panel.querySelectorAll(
        '.groups-wrapper > .group[data-group-id]:not([data-virtual-group])'
    ));
    if (groups.length !== message.groupOrders.length) {
        return false;
    }
    for (var index = 0; index < groups.length; index += 1) {
        var expected = message.groupOrders[index];
        if (groups[index].getAttribute('data-group-id') !== expected.groupId
            || !arraysEqual(getProjectIdsFromGroup(groups[index]), expected.projectIds)) {
            return false;
        }
    }
    var favoritesGroup = panel.querySelector(
        '.group[data-system-group="__favorites"]'
    );
    var favoriteIds = favoritesGroup
        ? Array.from(favoritesGroup.querySelectorAll('.project[data-id]'))
            .map(project => project.getAttribute('data-id'))
        : [];
    return arraysEqual(favoriteIds, message.favoriteProjectIds);
}

function getProjectsFocusTarget(panel) {
    var activeElement = document.activeElement;
    if (!activeElement || !panel || !panel.contains(activeElement)) {
        return null;
    }
    var project = activeElement.closest ? activeElement.closest('.project[data-id]') : null;
    var action = activeElement.closest ? activeElement.closest('[data-action]') : null;
    if (project) return {
        kind: 'legacy-project',
        groupId: project.closest('.group[data-group-id]')
            ? project.closest('.group[data-group-id]').getAttribute('data-group-id') || ''
            : '',
        projectId: project.getAttribute('data-id'),
        action: action ? action.getAttribute('data-action') : null,
    };
    var machineProject = activeElement.closest
        ? activeElement.closest('[data-machine-project-row]') : null;
    if (machineProject) return {
        kind: 'machine-project',
        machineId: machineProject.getAttribute('data-machine-id') || '',
        environmentId: machineProject.getAttribute('data-environment-id') || '',
        projectId: machineProject.getAttribute('data-machine-project-id') || '',
        favoriteMirror: Boolean(machineProject.closest('[data-machine-favorites]')),
        action: action ? action.getAttribute('data-action') : null,
    };
    var environment = activeElement.closest
        ? activeElement.closest('[data-machine-environment-row]') : null;
    if (environment) return {
        kind: 'machine-environment',
        machineId: environment.closest('[data-machine-row]')?.getAttribute('data-machine-id') || '',
        environmentId: environment.getAttribute('data-environment-id') || '',
        action: action ? action.getAttribute('data-action') : null,
    };
    var machine = activeElement.closest ? activeElement.closest('[data-machine-row]') : null;
    return machine ? {
        kind: 'machine',
        machineId: machine.getAttribute('data-machine-id') || '',
        action: action ? action.getAttribute('data-action') : null,
    } : null;
}

function getProjectScrollItemKey(project) {
    var group = project.closest('.group[data-group-id]');
    return JSON.stringify([
        group ? group.getAttribute('data-group-id') || '' : '',
        project.getAttribute('data-id') || '',
    ]);
}

function captureProjectsPanelState(panel) {
    var state = {
        panelScrollTop: panel && typeof panel.scrollTop === 'number' ? panel.scrollTop : 0,
        focus: getProjectsFocusTarget(panel),
        inlineEdit: window.__agentPivotProjectInlineEdit
            && typeof window.__agentPivotProjectInlineEdit.captureState === 'function'
            ? window.__agentPivotProjectInlineEdit.captureState()
            : null,
        groups: Array.from(panel.querySelectorAll(
            '.group[data-group-id]'
        )).map(function (group) {
            var list = group.querySelector('.group-list');
            return {
                groupId: group.getAttribute('data-group-id') || '',
                anchor: list && window.__agentPivotScrollState
                    ? window.__agentPivotScrollState.capture(list, {
                        itemSelector: '.project[data-id]',
                        getKey: getProjectScrollItemKey,
                    })
                    : null,
            };
        }),
    };
    if (!state.focus) {
        return state;
    }
    if (state.focus.kind !== 'legacy-project') {
        return state;
    }
    var focusGroup = findProjectsPanelGroup(panel, state.focus.groupId);
    var focusList = focusGroup && focusGroup.querySelector('.group-list');
    var focusProject = focusList && Array.from(
        focusList.querySelectorAll('.project[data-id]')
    ).find(project => project.getAttribute('data-id') === state.focus.projectId);
    var groupState = state.groups.find(group => group.groupId === state.focus.groupId);
    if (!focusList || !focusProject || !groupState || !groupState.anchor) {
        return state;
    }
    groupState.anchor.itemKey = getProjectScrollItemKey(focusProject);
    groupState.anchor.itemOffset = focusProject.getBoundingClientRect().top
        - focusList.getBoundingClientRect().top;
    return state;
}

function findProjectsPanelGroup(panel, groupId) {
    return Array.from(panel.querySelectorAll('.group[data-group-id]'))
        .find(group => (group.getAttribute('data-group-id') || '') === groupId)
        || null;
}

function restoreProjectsPanelAnchors(panel, state) {
    if (!state || !Array.isArray(state.groups) || !window.__agentPivotScrollState) {
        return;
    }
    state.groups.forEach(function (savedGroup) {
        if (!savedGroup.anchor) {
            return;
        }
        var group = findProjectsPanelGroup(panel, savedGroup.groupId);
        var list = group && group.querySelector('.group-list');
        if (!list) {
            return;
        }
        window.__agentPivotScrollState.restore(list, savedGroup.anchor, {
            itemSelector: '.project[data-id]',
            getKey: getProjectScrollItemKey,
        });
    });
}

function restoreProjectsPanelScroll(panel, state) {
    if (panel && state && Number.isFinite(state.panelScrollTop)) {
        panel.scrollTop = state.panelScrollTop;
    }
}

function restoreProjectsFocus(panel, target) {
    if (!target || !panel) {
        return;
    }
    if (target.kind && target.kind !== 'legacy-project') {
        restoreMachineProjectsFocus(panel, target);
        return;
    }
    var group = findProjectsPanelGroup(panel, target.groupId || '');
    var project = group && Array.from(group.querySelectorAll('.project[data-id]'))
        .find(candidate => candidate.getAttribute('data-id') === target.projectId);
    if (!project) {
        focusProjectsPanelFallback(panel);
        return;
    }
    var focusTarget = project;
    if (target.action) {
        focusTarget = Array.from(project.querySelectorAll('[data-action]'))
            .find(candidate => candidate.getAttribute('data-action') === target.action);
    }
    if (focusTarget && typeof focusTarget.focus === 'function') {
        if (!focusTarget.getAttribute('tabindex')) {
            focusTarget.setAttribute('tabindex', '-1');
        }
        focusTarget.focus({ preventScroll: true });
    }
}

function restoreMachineProjectsFocus(panel, target) {
    var machine = Array.from(panel.querySelectorAll('[data-machine-row]'))
        .find(candidate => candidate.getAttribute('data-machine-id') === target.machineId);
    if (!machine) {
        focusProjectsPanelFallback(panel);
        return;
    }
    var owner = machine;
    if (target.kind === 'machine-environment' || target.kind === 'machine-project') {
        owner = Array.from(machine.querySelectorAll('[data-machine-environment-row]'))
            .find(candidate => candidate.getAttribute('data-environment-id') === target.environmentId)
            || machine;
    }
    if (target.kind === 'machine-project') {
        var candidates = Array.from(panel.querySelectorAll('[data-machine-project-row]'))
            .filter(candidate => candidate.getAttribute('data-machine-project-id') === target.projectId);
        owner = candidates.find(candidate =>
            Boolean(candidate.closest('[data-machine-favorites]')) === target.favoriteMirror)
            || candidates[0]
            || owner;
    }
    var focusTarget = target.action
        ? Array.from(owner.querySelectorAll(':scope > .machine-row-line > [data-action]'))
            .find(candidate => candidate.getAttribute('data-action') === target.action)
        : null;
    focusTarget = focusTarget
        || owner.querySelector(':scope > .machine-row-line > .machine-project-primary')
        || owner.querySelector(':scope > .machine-row-line > .machine-environment-primary')
        || owner.querySelector(':scope > .machine-row-line > .machine-row-primary')
        || machine.querySelector(':scope > .machine-row-line > .machine-row-primary');
    if (focusTarget && typeof focusTarget.focus === 'function') {
        focusTarget.focus({ preventScroll: true });
    }
}

function focusProjectsPanelFallback(panel) {
    var fallback = panel && panel.querySelector(
        '[data-managed-operation="addMachine"], [data-action="add-project"], button:not(:disabled)'
    );
    if (fallback && typeof fallback.focus === 'function') {
        fallback.focus({ preventScroll: true });
    }
}
