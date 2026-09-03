function createMachineProjectsUi() {
    var panel = null;
    var selectedTags = new Set();
    var textQuery = '';
    var menuReturnControl = null;
    var handoffTimers = new Map();
    var transientMachineStates = new Map();
    var transientProjectStates = new Map();
    var pendingMachineActions = new Map();
    var storageKeys = {
        tags: 'machineProjects.selectedTags.v1',
        collapsed: 'machineProjects.collapsed.v1',
    };

    function readArray(key) {
        try {
            var parsed = JSON.parse(window.sessionStorage.getItem(key) || '[]');
            return Array.isArray(parsed) ? parsed.filter(value => typeof value === 'string') : [];
        } catch (_error) {
            return [];
        }
    }

    function writeArray(key, values) {
        try {
            window.sessionStorage.setItem(key, JSON.stringify(Array.from(values)));
        } catch (_error) {
            // The view remains usable when a sandboxed Webview denies storage.
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
        if (!tagMatch) return false;
        if (!textQuery) return true;
        return (row.getAttribute('data-machine-search') || '').indexOf(textQuery) !== -1;
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
            var machineId = machine.getAttribute('data-machine-id');
            var zeroMatches = filtering && !matchedMachines.has(machineId);
            machine.toggleAttribute('data-zero-matches', zeroMatches);
            applyFilterCollapse(machine, zeroMatches);
            machine.querySelectorAll('[data-machine-environment-row]').forEach(function (environment) {
                var visibleProjects = environment.querySelectorAll(
                    ':scope > .machine-project-list > [data-machine-project-row]:not([hidden])'
                ).length;
                environment.toggleAttribute('data-zero-matches', filtering && visibleProjects === 0);
            });
        });
        var summary = panel.querySelector('[data-machine-projects-summary]');
        if (summary) summary.textContent = formatSummary(matchedIds.size, matchedMachines.size);
        var clear = panel.querySelector('[data-action="clear-machine-tags"]');
        if (clear) clear.hidden = selectedTags.size === 0;
        var trigger = panel.querySelector('[data-action="toggle-machine-tags"]');
        if (trigger) trigger.textContent = selectedTags.size ? 'Tags (' + selectedTags.size + ')' : 'Tags';
        var selection = panel.querySelector('[data-machine-tag-selection]');
        if (selection) {
            var shown = Array.from(selectedTags).slice(0, 2);
            selection.textContent = shown.join('  ') + (selectedTags.size > 2 ? '  +' + (selectedTags.size - 2) : '');
        }
    }

    function applyFilterCollapse(machine, zeroMatches) {
        var control = machine.querySelector(':scope > .machine-row-line > [data-machine-disclosure="machine"]');
        if (!control) return;
        if (zeroMatches) {
            if (!machine.hasAttribute('data-filter-collapsed')) {
                machine.setAttribute('data-filter-base-expanded', control.getAttribute('aria-expanded') || 'true');
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

    function restoreState() {
        selectedTags = new Set(readArray(storageKeys.tags));
        var available = new Set(Array.from(
            panel.querySelectorAll('[data-machine-tag-checkbox]')
        ).map(input => input.value));
        selectedTags.forEach(function (tag) {
            if (!available.has(tag)) selectedTags.delete(tag);
        });
        panel.querySelectorAll('[data-machine-tag-checkbox]').forEach(function (input) {
            input.checked = selectedTags.has(input.value);
        });
        var collapsed = new Set(readArray(storageKeys.collapsed));
        panel.querySelectorAll('[data-machine-disclosure]').forEach(function (control) {
            var key = disclosureKey(control);
            if (collapsed.has(key)) setExpanded(control, false, false);
        });
        applyFilters();
    }

    function disclosureKey(control) {
        var owner = control.closest('[data-machine-row], [data-machine-environment-row], [data-machine-favorites]');
        if (!owner) return 'unknown';
        return owner.getAttribute('data-machine-id')
            || owner.getAttribute('data-environment-id')
            || 'favorites';
    }

    function setExpanded(control, expanded, persist) {
        var target = document.getElementById(control.getAttribute('aria-controls'));
        control.setAttribute('aria-expanded', String(expanded));
        if (target) target.hidden = !expanded;
        var name = control.querySelector('.machine-row-name')?.textContent
            || (control.textContent || '').trim().replace(/\s+/g, ' ');
        control.setAttribute('aria-label', (expanded ? 'Collapse ' : 'Expand ') + name);
        control.closest('[data-machine-row], [data-machine-environment-row], [data-machine-favorites]')
            ?.toggleAttribute('data-collapsed', !expanded);
        if (!expanded && target && target.contains(document.activeElement)) control.focus();
        if (persist) {
            var collapsed = new Set(readArray(storageKeys.collapsed));
            var key = disclosureKey(control);
            if (expanded) collapsed.delete(key); else collapsed.add(key);
            writeArray(storageKeys.collapsed, collapsed);
        }
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
        popover.hidden = !opening;
        trigger.setAttribute('aria-expanded', String(opening));
        if (opening) panel.querySelector('[data-machine-tag-checkbox]')?.focus();
    }

    function requestId() {
        var values = new Uint8Array(16);
        if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
            window.crypto.getRandomValues(values);
        } else {
            for (var index = 0; index < values.length; index += 1) {
                values[index] = Math.floor(Math.random() * 256);
            }
        }
        return Array.from(values).map(value => value.toString(16).padStart(2, '0')).join('');
    }

    function postMachineAction(action, row, trigger) {
        var machine = row.closest('[data-machine-row]');
        var machineId = machine
            ? machine.getAttribute('data-machine-id') : row.getAttribute('data-machine-id');
        var machineName = machine
            ? machine.getAttribute('data-machine-name') : row.getAttribute('data-machine-name');
        if (!machineId || !machineName || trigger.hasAttribute('data-pending')) return;
        if (Array.from(pendingMachineActions.values()).some(function (pending) {
            return pending.machineId === machineId;
        })) {
            announce('A connection action is already in progress for this Machine.');
            return;
        }
        var id = requestId();
        pendingMachineActions.set(id, {
            machineId: machineId,
            action: trigger.getAttribute('data-action'),
            projectId: row.getAttribute('data-legacy-project-id'),
        });
        trigger.setAttribute('data-pending', id);
        trigger.setAttribute('data-pending-previous-aria-disabled', trigger.getAttribute('aria-disabled') || 'false');
        trigger.setAttribute('aria-disabled', 'true');
        if (action === 'openHost' && machine) {
            showOpeningState(machine, trigger.getAttribute('data-action'));
        }
        window.vscode.postMessage({
            type: 'machine-project-action',
            version: 1,
            requestId: id,
            action: action,
            machineId: machineId,
            machineName: machineName,
            ...(action === 'openProject' ? {
                projectId: row.getAttribute('data-legacy-project-id'),
                environmentId: row.getAttribute('data-environment-id'),
            } : {}),
        });
    }

    function activateAction(action, target) {
        var row = target.closest('[data-machine-project-row], [data-machine-environment-row], [data-machine-row]');
        if (!row) return;
        if (action === 'open-machine-project') {
            postMachineAction('openProject', row, target);
        } else if (action === 'unavailable-machine-project') {
            announce(target.getAttribute('aria-label') || 'This Project is not available.');
        } else if (action === 'toggle-machine-favorite') {
            window.vscode.postMessage({
                type: 'favorite-project',
                projectId: row.getAttribute('data-legacy-project-id'),
            });
        } else if (action === 'open-machine-host') {
            postMachineAction('openHost', row, target);
        } else if (action === 'setup-machine') {
            postMachineAction('setup', row, target);
        } else if (action === 'rebind-machine') {
            postMachineAction('rebind', row, target);
        } else if (action === 'open-remote-ssh-extension') {
            window.vscode.postMessage({ type: 'open-remote-ssh-extension' });
            announce('Opening the Remote - SSH extension page.');
        } else if (action === 'open-environment' || action === 'setup-environment') {
            announce('Dev Container opening and repair will be enabled in the next milestone.');
        }
    }

    function closeMenu(returnFocus) {
        var menu = panel && panel.querySelector('[data-machine-row-menu]');
        if (menu) {
            menu.hidden = true;
            menu.replaceChildren();
        }
        if (returnFocus && menuReturnControl) menuReturnControl.focus();
        menuReturnControl = null;
    }

    function openMenu(trigger) {
        var row = trigger.closest('[data-machine-project-row], [data-machine-environment-row], [data-machine-row]');
        var menu = panel.querySelector('[data-machine-row-menu]');
        if (!row || !menu) return;
        closeMenu(false);
        menuReturnControl = row.querySelector(
            '.machine-row-primary, .machine-environment-primary, .machine-project-primary'
        );
        var actions = Array.from(row.querySelectorAll(':scope > .machine-row-line > [data-action]'))
            .filter(action => action.getAttribute('data-action') !== 'machine-row-menu'
                && !action.disabled
                && (!action.hidden || action.hasAttribute('data-machine-menu-source'))
                && action.getAttribute('data-action') !== 'unavailable-machine-project');
        actions.forEach(function (source) {
            var item = document.createElement('button');
            item.type = 'button';
            item.setAttribute('role', 'menuitem');
            item.setAttribute('data-forward-action', source.getAttribute('data-action'));
            item.textContent = source.getAttribute('aria-label') || source.title || 'Action';
            menu.appendChild(item);
        });
        if (!actions.length) {
            var unavailable = document.createElement('button');
            unavailable.type = 'button';
            unavailable.disabled = true;
            unavailable.setAttribute('role', 'menuitem');
            unavailable.textContent = 'No actions available';
            menu.appendChild(unavailable);
        }
        var rect = trigger.getBoundingClientRect();
        menu.style.left = Math.max(4, Math.min(rect.left, window.innerWidth - 240)) + 'px';
        menu.style.top = Math.max(4, Math.min(rect.bottom, window.innerHeight - 120)) + 'px';
        menu.hidden = false;
        menu.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
    }

    function announce(message) {
        var announcer = panel && panel.querySelector('[data-machine-projects-announcer]');
        if (!announcer) return;
        announcer.textContent = '';
        window.requestAnimationFrame(function () { announcer.textContent = message; });
    }

    function onClick(event) {
        var disclosure = event.target.closest('[data-machine-disclosure]');
        if (disclosure) {
            var machine = disclosure.closest('[data-machine-row]');
            var filtered = machine && machine.hasAttribute('data-filter-collapsed');
            var expanded = disclosure.getAttribute('aria-expanded') !== 'true';
            setExpanded(disclosure, expanded, !filtered);
            if (filtered) {
                machine.toggleAttribute('data-filter-manual-expanded', expanded);
            }
            if (typeof window.__agentPivotSyncCollapseButton === 'function') {
                window.__agentPivotSyncCollapseButton();
            }
            return;
        }
        var actionTarget = event.target.closest('[data-action]');
        if (!actionTarget) return;
        var action = actionTarget.getAttribute('data-action');
        if (action === 'toggle-machine-tags') toggleTags();
        else if (action === 'add-project') {
            window.vscode.postMessage({ type: 'save-project' });
        }
        else if (action === 'open-machine-bridge') {
            window.vscode.postMessage({ type: 'open-bridge-extension' });
        }
        else if (action === 'retry-machine-preview') {
            window.vscode.postMessage({
                type: 'request-full-refresh',
                reason: 'retry-machine-projects-preview',
            });
        }
        else if (action === 'repair-machine-preview') {
            window.vscode.postMessage({ type: 'repair-machine-projects-preview' });
        }
        else if (action === 'cancel-machine-preview') {
            window.vscode.postMessage({ type: 'cancel-machine-projects-preview' });
        }
        else if (action === 'close-machine-tags') closeTags(true);
        else if (action === 'clear-machine-tags') {
            selectedTags.clear();
            panel.querySelectorAll('[data-machine-tag-checkbox]').forEach(input => { input.checked = false; });
            writeArray(storageKeys.tags, selectedTags);
            applyFilters();
        } else if (action === 'machine-row-menu') openMenu(actionTarget);
        else activateAction(action, actionTarget);
    }

    function onChange(event) {
        var input = event.target.closest('[data-machine-tag-checkbox]');
        if (!input) return;
        if (input.checked) selectedTags.add(input.value); else selectedTags.delete(input.value);
        writeArray(storageKeys.tags, selectedTags);
        applyFilters();
    }

    function onKeyDown(event) {
        if (event.key === 'Escape') {
            var menu = panel.querySelector('[data-machine-row-menu]');
            var popover = panel.querySelector('[data-machine-tag-popover]');
            if (menu && !menu.hidden) {
                event.preventDefault();
                closeMenu(true);
            } else if (popover && !popover.hidden) {
                event.preventDefault();
                closeTags(true);
            }
            return;
        }
        var primary = event.target.closest(
            '.machine-row-primary, .machine-environment-primary, .machine-project-primary'
        );
        if (primary && event.shiftKey && event.key === 'F10') {
            event.preventDefault();
            openMenu(primary);
            return;
        }
        var menuItem = event.target.closest('[data-machine-row-menu] [role="menuitem"]');
        if (!menuItem) return;
        var items = Array.from(panel.querySelectorAll(
            '[data-machine-row-menu] [role="menuitem"]:not(:disabled)'
        ));
        var index = items.indexOf(menuItem);
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp'
            || event.key === 'Home' || event.key === 'End') {
            event.preventDefault();
            var next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            items[next]?.focus();
        } else if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            var action = menuItem.getAttribute('data-forward-action');
            var returnControl = menuReturnControl;
            var row = returnControl && returnControl.closest(
                '[data-machine-project-row], [data-machine-environment-row], [data-machine-row]'
            );
            var source = row && Array.from(row.querySelectorAll(
                ':scope > .machine-row-line > [data-action]'
            )).find(candidate => candidate.getAttribute('data-action') === action);
            closeMenu(false);
            if (source && action) activateAction(action, source);
            returnControl?.focus();
        }
    }

    function onHostMessage(event) {
        var message = event.data;
        if (!message || message.type !== 'machine-project-action-settlement'
            || message.version !== 1 || typeof message.requestId !== 'string'
            || typeof message.machineId !== 'string' || typeof message.message !== 'string') return;
        var machine = panel && Array.from(panel.querySelectorAll('[data-machine-row]'))
            .find(row => row.getAttribute('data-machine-id') === message.machineId);
        var pendingRecord = pendingMachineActions.get(message.requestId);
        if (!pendingRecord || pendingRecord.machineId !== message.machineId) return;
        if (message.status === 'opening') {
            if (machine) showOpeningState(machine, pendingRecord.action);
            announce(message.message);
            return;
        }
        pendingMachineActions.delete(message.requestId);
        var pending = machine && machine.querySelector('[data-pending="' + message.requestId + '"]');
        if (!pending) {
            pending = panel && panel.querySelector('[data-pending="' + message.requestId + '"]');
        }
        var pendingAction = pendingRecord.action;
        if (pending) {
            pending.setAttribute(
                'aria-disabled',
                pending.getAttribute('data-pending-previous-aria-disabled') || 'false',
            );
            pending.removeAttribute('data-pending');
            pending.removeAttribute('data-pending-previous-aria-disabled');
        }
        if (message.status === 'handedOff' || message.status === 'saved') {
            if (pendingAction === 'open-machine-project') {
                clearMachineTransientState(machine);
                clearProjectFailureState(pendingRecord.projectId);
            } else if (message.status === 'handedOff' && machine) {
                showHandoffState(machine, message.message);
            } else {
                clearMachineTransientState(machine);
            }
        } else if (message.status === 'failed' && machine) {
            if (pendingAction === 'open-machine-project'
                && message.message.indexOf('Remote - SSH') === -1) {
                showProjectFailureState(pendingRecord.projectId, message.message);
                window.vscode.postMessage({
                    type: 'request-full-refresh',
                    reason: 'machine-project-open-state-changed',
                });
            } else {
                showFailureState(machine, message.message, pendingAction);
            }
        }
        announce(message.message);
    }

    function showOpeningState(machine, pendingAction) {
        var status = machine.querySelector('[data-machine-connection-status]');
        var action = pendingAction === 'rebind-machine'
            ? machine.querySelector('[data-action="rebind-machine"]')
            : machine.querySelector('[data-action="open-machine-host"], [data-action="setup-machine"]');
        var install = machine.querySelector('[data-action="open-remote-ssh-extension"]');
        if (!status || !action) return;
        transientMachineStates.set(machine.getAttribute('data-machine-id'), {
            kind: 'opening', action: pendingAction,
        });
        status.textContent = 'Opening a new VS Code window…';
        status.title = status.textContent;
        if (pendingAction !== 'rebind-machine') action.hidden = false;
        action.setAttribute('aria-label', 'Opening a new VS Code window');
        if (install) install.hidden = true;
    }

    function showFailureState(machine, message, pendingAction) {
        var status = machine.querySelector('[data-machine-connection-status]');
        var configurationFailure = message.indexOf('was not saved') !== -1
            || message.indexOf('Connection state is unavailable') !== -1;
        var action = configurationFailure && pendingAction === 'rebind-machine'
            ? machine.querySelector('[data-action="rebind-machine"]')
            : machine.querySelector('[data-action="open-machine-host"], [data-action="setup-machine"]');
        var install = machine.querySelector('[data-action="open-remote-ssh-extension"]');
        if (!status || !action) return;
        var dependencyMissing = message.indexOf('Remote - SSH') !== -1;
        transientMachineStates.set(machine.getAttribute('data-machine-id'), {
            kind: 'failed', message: message, action: pendingAction,
        });
        status.textContent = dependencyMissing ? 'Remote - SSH is required'
            : configurationFailure ? (pendingAction === 'rebind-machine'
                ? 'Connection update wasn’t saved' : 'Connection setup wasn’t saved')
                : 'VS Code couldn’t start the window';
        status.title = status.textContent;
        if (!(configurationFailure && pendingAction === 'rebind-machine')) action.hidden = false;
        action.setAttribute('aria-label', configurationFailure
            ? (pendingAction === 'rebind-machine' ? 'Retry updating connection for '
                : 'Retry setting up connection for ') + machine.getAttribute('data-machine-name')
            : 'Retry opening a new window for ' + machine.getAttribute('data-machine-name'));
        if (install) install.hidden = !dependencyMissing;
    }

    function clearMachineTransientState(machine) {
        if (!machine) return;
        var machineId = machine.getAttribute('data-machine-id');
        var status = machine.querySelector('[data-machine-connection-status]');
        var action = machine.querySelector(
            '[data-action="open-machine-host"], [data-action="setup-machine"]'
        );
        var install = machine.querySelector('[data-action="open-remote-ssh-extension"]');
        if (machineId) transientMachineStates.delete(machineId);
        if (machineId && handoffTimers.has(machineId)) {
            window.clearTimeout(handoffTimers.get(machineId));
            handoffTimers.delete(machineId);
        }
        if (status) {
            status.textContent = status.getAttribute('data-default-text') || '';
            status.title = status.textContent;
        }
        if (action) {
            action.hidden = false;
            action.setAttribute('aria-label', action.getAttribute('data-default-aria-label')
                || (action.getAttribute('data-action') === 'open-machine-host'
                    ? 'Open Host on ' + machine.getAttribute('data-machine-name') + ' in a new window'
                    : 'Set up connection for ' + machine.getAttribute('data-machine-name') + ' in this VS Code'));
        }
        var rebind = machine.querySelector('[data-action="rebind-machine"]');
        if (rebind && rebind.getAttribute('data-default-aria-label')) {
            rebind.setAttribute('aria-label', rebind.getAttribute('data-default-aria-label'));
            rebind.hidden = true;
        }
        if (install) install.hidden = true;
    }

    function showProjectFailureState(projectId, message) {
        if (!projectId) return;
        transientProjectStates.set(projectId, message);
        panel.querySelectorAll('[data-machine-project-row]').forEach(function (row) {
            if (row.getAttribute('data-legacy-project-id') !== projectId) return;
            var primary = row.querySelector('.machine-project-primary');
            if (!primary) return;
            var identity = primary.getAttribute('data-default-aria-label')
                || primary.getAttribute('aria-label') || 'Project';
            primary.setAttribute('aria-label', identity + '. Unavailable: ' + message);
            primary.title = message;
            var state = row.querySelector('[data-project-open-error]');
            if (!state) {
                state = document.createElement('span');
                state.className = 'machine-project-state';
                state.setAttribute('data-project-open-error', '');
                primary.insertAdjacentElement('afterend', state);
            }
            state.textContent = 'Unavailable';
            state.title = message;
        });
    }

    function clearProjectFailureState(projectId) {
        if (!projectId) return;
        transientProjectStates.delete(projectId);
        panel.querySelectorAll('[data-machine-project-row]').forEach(function (row) {
            if (row.getAttribute('data-legacy-project-id') !== projectId) return;
            var primary = row.querySelector('.machine-project-primary');
            var state = row.querySelector('[data-project-open-error]');
            if (primary) {
                primary.setAttribute('aria-label', primary.getAttribute('data-default-aria-label')
                    || primary.getAttribute('aria-label'));
                primary.title = primary.getAttribute('data-default-title') || primary.title;
            }
            if (state) state.remove();
        });
    }

    function showHandoffState(machine, message) {
        var machineId = machine.getAttribute('data-machine-id');
        var status = machine.querySelector('[data-machine-connection-status]');
        var action = machine.querySelector('[data-action="open-machine-host"]');
        if (!machineId || !status || !action) return;
        transientMachineStates.set(machineId, { kind: 'handedOff', message: message });
        status.textContent = message;
        status.title = message;
        action.hidden = false;
        var install = machine.querySelector('[data-action="open-remote-ssh-extension"]');
        if (install) install.hidden = true;
        action.setAttribute('aria-label', 'Open another window for ' + machine.getAttribute('data-machine-name'));
        if (handoffTimers.has(machineId)) window.clearTimeout(handoffTimers.get(machineId));
        handoffTimers.set(machineId, window.setTimeout(function () {
            if (!panel || !panel.contains(machine)) return;
            status.textContent = status.getAttribute('data-default-text') || '';
            status.title = status.textContent;
            action.setAttribute('aria-label', 'Open Host on '
                + machine.getAttribute('data-machine-name') + ' in a new window');
            handoffTimers.delete(machineId);
            transientMachineStates.delete(machineId);
        }, 5000));
    }

    function restoreTransientMachineStates() {
        panel.querySelectorAll('[data-machine-row]').forEach(function (machine) {
            var state = transientMachineStates.get(machine.getAttribute('data-machine-id'));
            if (!state) return;
            if (state.kind === 'opening') showOpeningState(machine, state.action);
            else if (state.kind === 'failed') showFailureState(machine, state.message, state.action);
            else if (state.kind === 'handedOff') showHandoffState(machine, state.message);
        });
        transientProjectStates.forEach(function (message, projectId) {
            showProjectFailureState(projectId, message);
        });
    }

    function mount(nextPanel) {
        panel = nextPanel && nextPanel.querySelector('[data-machine-projects]')
            ? nextPanel : null;
        if (!panel) return false;
        if (!panel.__agentPivotMachineProjectsBound) {
            panel.addEventListener('click', onClick);
            panel.addEventListener('change', onChange);
            panel.addEventListener('keydown', onKeyDown);
            panel.__agentPivotMachineProjectsBound = true;
        }
        restoreState();
        restoreTransientMachineStates();
        return true;
    }

    window.addEventListener('message', onHostMessage);
    return {
        mount: mount,
        isMounted: () => Boolean(panel),
        getDisclosureCollapsedStates: getDisclosureCollapsedStates,
        setAllDisclosuresCollapsed: setAllDisclosuresCollapsed,
        applyTextFilter: function (value) {
            textQuery = String(value || '').trim().toLocaleLowerCase();
            applyFilters();
        },
    };
}
