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
        return activeTab === 'projects' || activeTab === 'ai'
            ? activeTab
            : 'open';
    }

    function getCollapseButtonState(tab, collapsedStates) {
        if (tab === 'ai') {
            return {
                disabled: true,
                collapsed: false,
                title: 'No groups to collapse in AI',
            };
        }
        var labels = tab === 'open'
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

    function getActiveCollapsibleGroups() {
        var activeTab = getActiveDashboardTab();
        var selector = activeTab === 'projects'
            ? '#dashboard-tab-projects .group[data-group-id]'
            : null;
        if (!selector) {
            return [];
        }
        return [...document.querySelectorAll(selector)];
    }

    function setGroupCollapsed(group, collapsed, persist) {
        group.classList.toggle('collapsed', collapsed);
        if (persist) {
            window.vscode.postMessage({
                type: 'collapse-group',
                groupId: group.getAttribute('data-group-id'),
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

        groups.forEach(group => setGroupCollapsed(group, shouldCollapse, true));
        syncCollapseButton();
    }


    window.__agentPivotSyncCollapseButton = syncCollapseButton;
    window.__agentPivotGetCollapseButtonState = getCollapseButtonState;

    return {
        setGroupCollapsed: setGroupCollapsed,
        syncCollapseButton: syncCollapseButton,
        toggleAllGroups: toggleAllGroups,
    };
}
