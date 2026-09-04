function createMachineProjectsUi() {
    var panel = null;
    var selectedTags = new Set();
    var textQuery = '';
    var activeProjectMenuTrigger = null;
    var storageKeys = {
        tags: 'machineProjects.selectedTags.v1',
        collapsed: 'machineProjects.collapsed.v1',
    };
    var ProjectOpenType = {
        Default: 0,
        NewWindow: 1,
        CurrentWindow: 3,
    };

    function readArray(key) {
        try {
            var parsed = JSON.parse(window.sessionStorage.getItem(key) || '[]');
            return Array.isArray(parsed)
                ? parsed.filter(function (value) { return typeof value === 'string'; })
                : [];
        } catch (_error) {
            return [];
        }
    }

    function writeArray(key, values) {
        try {
            window.sessionStorage.setItem(key, JSON.stringify(Array.from(values)));
        } catch (_error) {
            // A denied Webview storage API must not make the view unusable.
        }
    }

    function parseTags(row) {
        try {
            var value = JSON.parse(row.getAttribute('data-machine-project-tags') || '[]');
            return Array.isArray(value) ? value : [];
        } catch (_error) {
            return [];
        }
    }

    function matches(row) {
        var tags = parseTags(row);
        var tagMatch = true;
        selectedTags.forEach(function (tag) {
            if (tags.indexOf(tag) === -1) tagMatch = false;
        });
        return tagMatch && (!textQuery
            || (row.getAttribute('data-machine-search') || '').indexOf(textQuery) !== -1);
    }

    function formatSummary(projects, machines) {
        return projects + ' project' + (projects === 1 ? '' : 's')
            + ' on ' + machines + ' machine' + (machines === 1 ? '' : 's');
    }

    function applyFilters() {
        if (!panel) return;
        var filtering = selectedTags.size > 0 || Boolean(textQuery);
        var matchedIds = new Set();
        var matchedMachines = new Set();
        panel.querySelectorAll('[data-machine-project-row]').forEach(function (row) {
            var visible = matches(row);
            row.hidden = !visible;
            if (visible) {
                matchedIds.add(row.getAttribute('data-machine-project-id'));
                matchedMachines.add(row.getAttribute('data-machine-id'));
            }
        });
        panel.querySelectorAll('[data-machine-row]').forEach(function (machine) {
            var zeroMatches = filtering
                && !matchedMachines.has(machine.getAttribute('data-machine-id'));
            machine.toggleAttribute('data-zero-matches', zeroMatches);
            applyFilterCollapse(machine, zeroMatches);
            machine.querySelectorAll('[data-machine-environment-row]').forEach(function (environment) {
                var visibleProjects = environment.querySelectorAll(
                    ':scope > .machine-project-list > [data-machine-project-row]:not([hidden])'
                ).length;
                environment.toggleAttribute(
                    'data-zero-matches',
                    filtering && visibleProjects === 0
                );
            });
        });
        var summary = panel.querySelector('[data-machine-projects-summary]');
        if (summary) summary.textContent = formatSummary(matchedIds.size, matchedMachines.size);
        var clear = panel.querySelector('[data-action="clear-machine-tags"]');
        if (clear) clear.hidden = selectedTags.size === 0;
        var trigger = panel.querySelector('[data-action="toggle-machine-tags"]');
        if (trigger) {
            var filterLabel = selectedTags.size
                ? 'Filter projects by tag, ' + selectedTags.size + ' selected'
                : 'Filter projects by tag';
            trigger.setAttribute('aria-label', filterLabel);
            trigger.setAttribute('title', filterLabel);
            var count = trigger.querySelector('[data-machine-filter-count]');
            if (count) {
                count.textContent = String(selectedTags.size);
                count.hidden = selectedTags.size === 0;
            }
        }
    }

    function applyFilterCollapse(machine, zeroMatches) {
        var control = machine.querySelector(
            ':scope > .machine-row-line > [data-machine-disclosure="machine"]'
        );
        if (!control) return;
        if (zeroMatches) {
            if (!machine.hasAttribute('data-filter-collapsed')) {
                machine.setAttribute(
                    'data-filter-base-expanded',
                    control.getAttribute('aria-expanded') || 'true'
                );
                machine.setAttribute('data-filter-collapsed', '');
            }
            if (!machine.hasAttribute('data-filter-manual-expanded')) {
                setExpanded(control, false, false);
            }
            return;
        }
        if (!machine.hasAttribute('data-filter-collapsed')) return;
        var baseExpanded = machine.getAttribute('data-filter-base-expanded') !== 'false';
        machine.removeAttribute('data-filter-collapsed');
        machine.removeAttribute('data-filter-base-expanded');
        machine.removeAttribute('data-filter-manual-expanded');
        setExpanded(control, baseExpanded, false);
    }

    function disclosureKey(control) {
        var owner = control.closest(
            '[data-machine-row], [data-machine-environment-row], [data-machine-favorites]'
        );
        if (!owner) return 'unknown';
        return owner.getAttribute('data-machine-id')
            || owner.getAttribute('data-environment-id')
            || 'favorites';
    }

    function setExpanded(control, expanded, persist) {
        var target = document.getElementById(control.getAttribute('aria-controls'));
        control.setAttribute('aria-expanded', String(expanded));
        if (target) target.hidden = !expanded;
        var nameNode = control.querySelector('.machine-row-name');
        var name = nameNode ? nameNode.textContent
            : (control.textContent || '').trim().replace(/\s+/g, ' ');
        control.setAttribute('aria-label', (expanded ? 'Collapse ' : 'Expand ') + name);
        var owner = control.closest(
            '[data-machine-row], [data-machine-environment-row], [data-machine-favorites]'
        );
        if (owner) owner.toggleAttribute('data-collapsed', !expanded);
        if (!expanded && target && target.contains(document.activeElement)) control.focus();
        if (persist) {
            var collapsed = new Set(readArray(storageKeys.collapsed));
            var key = disclosureKey(control);
            if (expanded) collapsed.delete(key); else collapsed.add(key);
            writeArray(storageKeys.collapsed, collapsed);
        }
    }

    function restoreState() {
        selectedTags = new Set(readArray(storageKeys.tags));
        var available = new Set(Array.from(
            panel.querySelectorAll('[data-machine-tag-checkbox]')
        ).map(function (input) { return input.value; }));
        selectedTags.forEach(function (tag) {
            if (!available.has(tag)) selectedTags.delete(tag);
        });
        panel.querySelectorAll('[data-machine-tag-checkbox]').forEach(function (input) {
            input.checked = selectedTags.has(input.value);
        });
        var collapsed = new Set(readArray(storageKeys.collapsed));
        panel.querySelectorAll('[data-machine-disclosure]').forEach(function (control) {
            if (collapsed.has(disclosureKey(control))) setExpanded(control, false, false);
        });
        applyFilters();
    }

    function getDisclosureCollapsedStates() {
        if (!panel) return [];
        return Array.from(panel.querySelectorAll('[data-machine-disclosure]'))
            .map(function (control) {
                return control.getAttribute('aria-expanded') !== 'true';
            });
    }

    function setAllDisclosuresCollapsed(collapsed) {
        if (!panel) return;
        panel.querySelectorAll('[data-machine-disclosure]').forEach(function (control) {
            var machine = control.closest('[data-machine-row]');
            if (machine && control.getAttribute('data-machine-disclosure') === 'machine'
                && machine.hasAttribute('data-filter-collapsed')) {
                machine.setAttribute('data-filter-base-expanded', String(!collapsed));
                machine.toggleAttribute('data-filter-manual-expanded', !collapsed);
            }
            setExpanded(control, !collapsed, true);
        });
    }

    function closeTags(returnFocus) {
        var popover = panel && panel.querySelector('[data-machine-tag-popover]');
        var trigger = panel && panel.querySelector('[data-action="toggle-machine-tags"]');
        if (popover) popover.hidden = true;
        if (trigger) {
            trigger.setAttribute('aria-expanded', 'false');
            if (returnFocus) trigger.focus();
        }
    }

    function toggleTags() {
        var popover = panel.querySelector('[data-machine-tag-popover]');
        var trigger = panel.querySelector('[data-action="toggle-machine-tags"]');
        if (!popover || !trigger) return;
        var opening = popover.hidden;
        if (opening) closeProjectMenu(false);
        popover.hidden = !opening;
        trigger.setAttribute('aria-expanded', String(opening));
        if (opening) {
            var first = panel.querySelector('[data-machine-tag-checkbox]');
            if (first) first.focus();
        }
    }

    function closeProjectMenu(returnFocus) {
        if (!activeProjectMenuTrigger) return;
        var trigger = activeProjectMenuTrigger;
        var shell = trigger.closest('.machine-project-menu-shell');
        var menu = shell && shell.querySelector('[data-machine-project-menu]');
        if (menu) menu.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        activeProjectMenuTrigger = null;
        if (returnFocus && trigger.isConnected && typeof trigger.focus === 'function') {
            trigger.focus();
        }
    }

    function toggleProjectMenu(trigger, focusFirst) {
        var shell = trigger && trigger.closest('.machine-project-menu-shell');
        var menu = shell && shell.querySelector('[data-machine-project-menu]');
        if (!menu) return;
        var opening = menu.hidden;
        closeProjectMenu(false);
        if (!opening) return;
        closeTags(false);
        menu.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        activeProjectMenuTrigger = trigger;
        if (focusFirst) {
            var first = menu.querySelector('[role="menuitem"]');
            if (first) first.focus();
        }
    }

    function postProjectAction(control, type) {
        var row = control.closest('[data-machine-project-row]');
        var projectId = row && row.getAttribute('data-machine-project-id');
        if (!projectId) return;
        closeProjectMenu(false);
        window.vscode.postMessage({ type: type, projectId: projectId });
    }

    function postProjectOpen(row, openType) {
        var projectId = row && row.getAttribute('data-machine-project-id');
        if (!projectId) return;
        window.vscode.postMessage({
            type: 'selected-project',
            projectId: projectId,
            projectOpenType: openType,
        });
    }

    function onClick(event) {
        var control = event.target && event.target.closest
            ? event.target.closest('[data-action], [data-machine-disclosure]')
            : null;
        if (!control) {
            if (event.target && event.target.closest
                && event.target.closest('.machine-project-actions')) {
                return;
            }
            var row = event.target && event.target.closest
                ? event.target.closest('[data-machine-project-row]')
                : null;
            if (row && panel.contains(row)) {
                postProjectOpen(
                    row,
                    event.ctrlKey || event.metaKey
                        ? ProjectOpenType.CurrentWindow
                        : ProjectOpenType.Default
                );
            }
            return;
        }
        if (!panel.contains(control)) return;
        if (control.hasAttribute('data-machine-disclosure')) {
            var machine = control.closest('[data-machine-row]');
            if (machine && machine.hasAttribute('data-filter-collapsed')) {
                machine.toggleAttribute(
                    'data-filter-manual-expanded',
                    control.getAttribute('aria-expanded') === 'false'
                );
            }
            setExpanded(control, control.getAttribute('aria-expanded') !== 'true', true);
            if (window.__agentPivotSyncCollapseButton) {
                window.__agentPivotSyncCollapseButton();
            }
            return;
        }
        var action = control.getAttribute('data-action');
        if (action === 'toggle-machine-tags') {
            toggleTags();
        } else if (action === 'close-machine-tags') {
            closeTags(true);
        } else if (action === 'clear-machine-tags') {
            selectedTags.clear();
            panel.querySelectorAll('[data-machine-tag-checkbox]').forEach(function (input) {
                input.checked = false;
            });
            writeArray(storageKeys.tags, selectedTags);
            applyFilters();
        } else if (action === 'add-project') {
            window.vscode.postMessage({ type: 'add-project' });
        } else if (action === 'toggle-machine-favorite') {
            var favoriteRow = control.closest('[data-machine-project-row]');
            if (favoriteRow) {
                window.vscode.postMessage({
                    type: 'favorite-project',
                    projectId: favoriteRow.getAttribute('data-machine-project-id'),
                });
            }
        } else if (action === 'toggle-machine-project-menu') {
            toggleProjectMenu(control, false);
        } else if (action === 'open-machine-project-current') {
            postProjectOpen(control.closest('[data-machine-project-row]'), ProjectOpenType.CurrentWindow);
            closeProjectMenu(false);
        } else if (action === 'edit-machine-project') {
            postProjectAction(control, 'edit-project');
        } else if (action === 'color-machine-project') {
            postProjectAction(control, 'color-project');
        } else if (action === 'remove-machine-project') {
            postProjectAction(control, 'remove-project');
        } else if (action === 'open-machine-project') {
            var projectRow = control.closest('[data-machine-project-row]');
            postProjectOpen(
                projectRow,
                event.ctrlKey || event.metaKey
                    ? ProjectOpenType.CurrentWindow
                    : ProjectOpenType.Default
            );
        } else if (action === 'open-machine-host') {
            var machineRow = control.closest('[data-machine-row]');
            if (machineRow) {
                window.vscode.postMessage({
                    type: 'open-machine-host',
                    machineId: machineRow.getAttribute('data-machine-id'),
                    projectId: control.getAttribute('data-host-project-id'),
                });
            }
        }
    }

    function onAuxClick(event) {
        if (event.button !== 1 || !event.target || !event.target.closest) return;
        var action = event.target.closest('[data-action]');
        if (action && action.getAttribute('data-action') !== 'open-machine-project') return;
        var row = event.target.closest('[data-machine-project-row]');
        if (!row || !panel.contains(row)) return;
        event.preventDefault();
        postProjectOpen(row, ProjectOpenType.NewWindow);
    }

    function onChange(event) {
        if (!event.target || !event.target.matches('[data-machine-tag-checkbox]')) return;
        if (event.target.checked) selectedTags.add(event.target.value);
        else selectedTags.delete(event.target.value);
        writeArray(storageKeys.tags, selectedTags);
        applyFilters();
    }

    function onKeyDown(event) {
        if (event.key === 'Escape' && activeProjectMenuTrigger) {
            event.preventDefault();
            closeProjectMenu(true);
            return;
        }
        var menu = event.target && event.target.closest
            ? event.target.closest('[data-machine-project-menu]')
            : null;
        if (menu && (event.key === 'ArrowDown' || event.key === 'ArrowUp'
            || event.key === 'Home' || event.key === 'End')) {
            event.preventDefault();
            var items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
            var current = items.indexOf(document.activeElement);
            var next = event.key === 'Home' ? 0
                : event.key === 'End' ? items.length - 1
                    : event.key === 'ArrowDown'
                        ? (current + 1) % items.length
                        : (current - 1 + items.length) % items.length;
            if (items[next]) items[next].focus();
            return;
        }
        if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
            && event.target && event.target.closest) {
            var row = event.target.closest('[data-machine-project-row]');
            var trigger = row && row.querySelector('[data-action="toggle-machine-project-menu"]');
            if (trigger) {
                event.preventDefault();
                toggleProjectMenu(trigger, true);
                return;
            }
        }
        if (event.key === 'Escape') closeTags(true);
    }

    function onDocumentPointerDown(event) {
        if (!panel || !event.target || !event.target.closest) return;
        if (!event.target.closest('.machine-tag-filter')) closeTags(false);
        if (!event.target.closest('.machine-project-menu-shell')) closeProjectMenu(false);
    }

    function onDocumentFocusIn(event) {
        if (!activeProjectMenuTrigger || !event.target) return;
        var shell = activeProjectMenuTrigger.closest('.machine-project-menu-shell');
        if (shell && !shell.contains(event.target)) closeProjectMenu(false);
    }

    function onDocumentScroll(event) {
        if (!activeProjectMenuTrigger) return;
        var row = activeProjectMenuTrigger.closest('[data-machine-project-row]');
        if (!row || !row.contains(event.target)) closeProjectMenu(false);
    }

    function onWindowBlur() {
        closeProjectMenu(false);
        closeTags(false);
    }

    function mount(nextPanel) {
        closeProjectMenu(false);
        panel = nextPanel && nextPanel.querySelector('[data-machine-projects]')
            ? nextPanel : null;
        if (!panel) return false;
        if (!panel.__agentPivotMachineProjectsBound) {
            panel.addEventListener('click', onClick);
            panel.addEventListener('auxclick', onAuxClick);
            panel.addEventListener('change', onChange);
            panel.addEventListener('keydown', onKeyDown);
            panel.__agentPivotMachineProjectsBound = true;
        }
        restoreState();
        return true;
    }

    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    document.addEventListener('focusin', onDocumentFocusIn);
    document.addEventListener('scroll', onDocumentScroll, true);
    window.addEventListener('blur', onWindowBlur);
    return {
        mount: mount,
        isMounted: function () { return Boolean(panel); },
        getDisclosureCollapsedStates: getDisclosureCollapsedStates,
        setAllDisclosuresCollapsed: setAllDisclosuresCollapsed,
        applyTextFilter: function (value) {
            textQuery = String(value || '').trim().toLocaleLowerCase();
            applyFilters();
        },
    };
}
