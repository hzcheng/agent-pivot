function initProjectGroupCollapse() {
    'use strict';

    function updateToggleAllGroupsButton(state) {
        document.body.classList.toggle("steward-all-collapsed", state.collapsed);
        var button = document.querySelector('[data-action="toggle-all-groups"]');
        if (!button)
            return;

        button.disabled = state.disabled;
        button.setAttribute('aria-disabled', state.disabled ? 'true' : 'false');
        button.setAttribute("title", state.title);
        button.setAttribute("aria-label", state.title);
    }

    function getActiveDashboardTab() {
        var dashboard = window.__agentPivotDashboard;
        var selectedTab = !dashboard && document.querySelector
            ? document.querySelector('[data-dashboard-tab][aria-selected="true"]')
            : null;
        var activeTab = dashboard && typeof dashboard.getActiveTab === 'function'
            ? dashboard.getActiveTab()
            : selectedTab && selectedTab.getAttribute('data-dashboard-tab');
        return activeTab === 'projects' || activeTab === 'todo' || activeTab === 'ai'
            ? activeTab
            : 'open';
    }

    function getActiveCollapsibleGroups() {
        var activeTab = getActiveDashboardTab();
        var selector = activeTab === 'projects'
            ? '#dashboard-tab-projects .group[data-group-id]'
            : activeTab === 'todo'
                ? '#dashboard-tab-todo .todo-group[data-todo-group-id]'
                : activeTab === 'open'
                    ? '#dashboard-tab-open .open-other-windows-group[data-group-id]'
                    : null;
        if (!selector) {
            return [];
        }
        return [...document.querySelectorAll(selector)];
    }

    function setGroupCollapsed(group, collapsed, persist) {
        group.classList.toggle('collapsed', collapsed);
        if (persist) {
            var isTodoGroup = group.classList.contains('todo-group');
            window.vscode.postMessage({
                type: isTodoGroup ? 'todo-collapse-group' : 'collapse-group',
                groupId: isTodoGroup
                    ? group.getAttribute('data-todo-group-id')
                    : group.getAttribute('data-group-id'),
                collapsed,
            });
        }
    }

    function syncCollapseButton() {
        var activeTab = getActiveDashboardTab();
        var groups = getActiveCollapsibleGroups();
        updateToggleAllGroupsButton(getCollapseButtonState(
            activeTab,
            groups.map(group => group.classList.contains('collapsed'))
        ));
    }

    function toggleAllGroups() {
        var activeTab = getActiveDashboardTab();
        var groups = getActiveCollapsibleGroups();
        var shouldCollapse = groups.some(group => !group.classList.contains("collapsed"));

        if (activeTab === 'todo') {
            if (window.__agentPivotTodo
                && typeof window.__agentPivotTodo.dispatch === 'function') {
                window.__agentPivotTodo.dispatch('collapse-groups', { collapsed: shouldCollapse });
            } else {
                collapseTodoGroups(groups, shouldCollapse, message => window.vscode.postMessage(message));
            }
            syncCollapseButton();
            return;
        }

        groups.forEach(group => setGroupCollapsed(group, shouldCollapse, true));
        syncCollapseButton();
    }


    window.__agentPivotSyncCollapseButton = syncCollapseButton;

    return {
        setGroupCollapsed: setGroupCollapsed,
        syncCollapseButton: syncCollapseButton,
        toggleAllGroups: toggleAllGroups,
    };
}
