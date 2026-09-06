function createMachineProjectsUi() {
    var panel = null;
    var selectedTags = new Set();
    var textQuery = '';
    var activeProjectMenuTrigger = null;
    var nextManagedRequestId = 1;
    var pendingManagedActions = new Map();
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
        var restoredTagCount = selectedTags.size;
        var available = new Set(Array.from(
            panel.querySelectorAll('[data-machine-tag-checkbox]')
        ).map(function (input) { return input.value; }));
        selectedTags.forEach(function (tag) {
            if (!available.has(tag)) selectedTags.delete(tag);
        });
        if (selectedTags.size !== restoredTagCount) {
            writeArray(storageKeys.tags, selectedTags);
        }
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
            var first = menu.querySelector('[role="menuitem"]:not(:disabled)');
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

    function postMachineAction(control, type) {
        var row = control.closest('[data-machine-row]');
        var machineId = row && row.getAttribute('data-machine-id');
        if (!machineId) return;
        closeProjectMenu(false);
        window.vscode.postMessage({ type: type, machineId: machineId });
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

    function managedControlKey(operation, targetId) {
        return operation + '\n' + (targetId || '');
    }

    function managedRoot() {
        return panel && panel.querySelector('[data-managed-remote-projects]');
    }

    function findManagedControls(operation, targetId) {
        if (!panel) return [];
        return Array.from(panel.querySelectorAll('[data-managed-operation]'))
            .filter(function (control) {
                return control.getAttribute('data-managed-operation') === operation
                    && (control.getAttribute('data-managed-target-id') || '') === (targetId || '');
            });
    }

    function findManagedMachineForm(operation, targetId) {
        if (!panel) return null;
        return Array.from(panel.querySelectorAll('[data-managed-machine-form]')).find(function (form) {
            return form.getAttribute('data-managed-machine-form-operation') === operation
                && (form.getAttribute('data-managed-target-id') || '') === (targetId || '');
        }) || null;
    }

    function hasPendingManagedMachineForm() {
        return Array.from(pendingManagedActions.values()).some(function (pending) {
            return pending.operation === 'addMachine' || pending.operation === 'editMachine';
        });
    }

    function setManagedControlsPending(operation, targetId, requestId, pending) {
        findManagedControls(operation, targetId).forEach(function (control) {
            if (pending) {
                control.setAttribute('data-managed-pending', requestId);
                control.disabled = true;
            } else if (control.getAttribute('data-managed-pending') === requestId) {
                control.removeAttribute('data-managed-pending');
                control.disabled = false;
            }
        });
        if (operation === 'addMachine' || operation === 'editMachine') {
            var form = findManagedMachineForm(operation, targetId);
            if (form) {
                form.setAttribute('aria-busy', String(pending));
                form.querySelectorAll('input, button').forEach(function (item) { item.disabled = pending; });
            }
        }
    }

    function restoreManagedPendingControls() {
        pendingManagedActions.forEach(function (pending, requestId) {
            setManagedControlsPending(
                pending.operation,
                pending.targetId,
                requestId,
                true
            );
        });
    }

    function announceManaged(message) {
        var announcer = panel && panel.querySelector('[data-machine-projects-announcer]');
        if (announcer) announcer.textContent = message;
    }

    function postManagedAction(control, input) {
        var operation = control.getAttribute('data-managed-operation');
        var targetId = control.getAttribute('data-managed-target-id') || '';
        var root = managedRoot();
        if (!operation || !root) return;
        var key = managedControlKey(operation, targetId);
        var duplicate = Array.from(pendingManagedActions.values()).some(function (pending) {
            return pending.key === key;
        });
        if (duplicate) return;
        var focusOwner = control.closest(
            '[data-machine-project-row], [data-machine-row]'
        );
        var focusReturn = focusOwner && focusOwner.querySelector(
            '.machine-project-primary, .machine-row-primary'
        );
        closeProjectMenu(false);
        if (focusReturn && typeof focusReturn.focus === 'function') focusReturn.focus();
        var requestId = 'managed-' + Date.now() + '-' + nextManagedRequestId++;
        pendingManagedActions.set(requestId, {
            key: key,
            operation: operation,
            targetId: targetId,
            focusAddMachine: operation === 'addMachine',
            focusEditedMachineId: operation === 'editMachine' ? targetId : '',
        });
        setManagedControlsPending(operation, targetId, requestId, true);
        announceManaged('Working…');
        window.vscode.postMessage({
            type: 'managed-remote-action',
            version: 1,
            requestId: requestId,
            operation: operation,
            expectedRevisionId: root.getAttribute('data-managed-revision-id') || null,
            ...(targetId ? { targetId: targetId } : {}),
            ...(input ? { input: input } : {}),
        });
    }

    function setManagedMachineFormOpen(form, open, returnFocus) {
        var trigger = panel && panel.querySelector('[data-action="show-add-machine-form"]');
        if (!form || (!open && form.getAttribute('aria-busy') === 'true')) return;
        if (open && hasPendingManagedMachineForm()) return;
        if (open) {
            panel.querySelectorAll('[data-managed-machine-form]').forEach(function (other) {
                if (other !== form) {
                    other.hidden = true;
                    resetDismissedManagedMachineForm(other);
                }
            });
            if (trigger) trigger.setAttribute('aria-expanded', 'false');
        }
        form.hidden = !open;
        if (!open) resetDismissedManagedMachineForm(form);
        if (trigger && form.getAttribute('data-managed-machine-form-operation') === 'addMachine') {
            trigger.setAttribute('aria-expanded', String(open));
        }
        if (open) {
            var name = form.elements.name;
            if (name && typeof name.focus === 'function') name.focus();
        } else if (returnFocus) {
            var focusReturn = form.getAttribute('data-managed-machine-form-operation') === 'addMachine'
                ? trigger : form.closest('[data-machine-row]') && form.closest('[data-machine-row]').querySelector('.machine-row-primary');
            if (focusReturn && typeof focusReturn.focus === 'function') focusReturn.focus();
        }
    }

    function resetDismissedManagedMachineForm(form) {
        if (form.getAttribute('data-managed-machine-form-operation') !== 'editMachine') return;
        resetManagedMachineForm(form);
    }

    function resetManagedMachineForm(form) {
        form.reset();
        form.querySelectorAll('input[aria-invalid]').forEach(function (input) {
            input.removeAttribute('aria-invalid');
            input.removeAttribute('aria-describedby');
        });
        var error = form.querySelector('[data-managed-machine-form-error]');
        if (error) { error.hidden = true; error.textContent = ''; }
    }

    function setAddMachineFormOpen(open, returnFocus) {
        setManagedMachineFormOpen(findManagedMachineForm('addMachine', ''), open, returnFocus);
    }

    function setEditMachineFormOpen(targetId, open, returnFocus) {
        setManagedMachineFormOpen(findManagedMachineForm('editMachine', targetId), open, returnFocus);
    }

    function submitManagedMachineForm(form) {
        var values = {
            name: String(form.elements.name.value || '').trim(),
            host: String(form.elements.host.value || '').trim(),
            user: String(form.elements.user.value || '').trim(),
            port: Number(form.elements.port.value),
        };
        var error = form.querySelector('[data-managed-machine-form-error]');
        var invalidField = !isValidMachineName(values.name) ? 'name'
            : !isValidHost(values.host) ? 'host'
            : !isValidSshUser(values.user) ? 'user'
            : !Number.isInteger(values.port) || values.port < 1 || values.port > 65535 ? 'port' : '';
        var message = invalidField === 'name' ? 'Enter a Machine name of up to 128 characters.'
            : invalidField === 'host' ? 'Enter a valid DNS name or IP address.'
            : invalidField === 'user' ? 'Enter a valid SSH user.'
            : invalidField === 'port' ? 'Enter a port from 1 to 65535.' : '';
        if (message) {
            var invalidInput = form.elements[invalidField];
            if (invalidInput) {
                invalidInput.setAttribute('aria-invalid', 'true');
                if (error && error.id) invalidInput.setAttribute('aria-describedby', error.id);
                invalidInput.focus();
            }
            if (error) { error.textContent = message; error.hidden = false; }
            return;
        }
        form.querySelectorAll('input[aria-invalid]').forEach(function (input) {
            input.removeAttribute('aria-invalid');
            input.removeAttribute('aria-describedby');
        });
        if (error) { error.hidden = true; error.textContent = ''; }
        postManagedAction(form.querySelector('[data-managed-operation]'), values);
    }

    function captureManagedMachineFormState() {
        var form = Array.from(panel ? panel.querySelectorAll('[data-managed-machine-form]') : [])
            .find(function (candidate) { return !candidate.hidden; });
        if (!form) return null;
        var activeElement = document.activeElement;
        return {
            operation: form.getAttribute('data-managed-machine-form-operation') || '',
            targetId: form.getAttribute('data-managed-target-id') || '',
            values: {
                name: String(form.elements.name.value || ''),
                host: String(form.elements.host.value || ''),
                user: String(form.elements.user.value || ''),
                port: String(form.elements.port.value || ''),
            },
            focusField: activeElement && form.contains(activeElement)
                ? activeElement.getAttribute('name') || '' : '',
        };
    }

    function restoreManagedMachineFormState(state) {
        if (!state || (state.operation !== 'addMachine' && state.operation !== 'editMachine')
            || !state.values) return;
        var form = findManagedMachineForm(state.operation, state.targetId || '');
        if (!form) return;
        ['name', 'host', 'user', 'port'].forEach(function (field) {
            if (typeof state.values[field] === 'string') form.elements[field].value = state.values[field];
        });
        form.hidden = false;
        if (state.operation === 'addMachine') {
            var trigger = panel && panel.querySelector('[data-action="show-add-machine-form"]');
            if (trigger) trigger.setAttribute('aria-expanded', 'true');
        }
        var focusField = state.focusField && form.elements[state.focusField];
        if (focusField && typeof focusField.focus === 'function') focusField.focus();
    }

    function isValidMachineName(value) {
        return value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
    }

    function isValidSshUser(value) {
        return /^[A-Za-z0-9][A-Za-z0-9._@\\-]{0,255}$/.test(value);
    }

    function isValidIpv4(value) {
        var parts = value.split('.');
        return parts.length === 4 && parts.every(function (part) {
            return /^(?:0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255;
        });
    }

    function isValidIpv6(value) {
        if (value.indexOf(':') === -1 || /[^0-9a-fA-F:.]/.test(value)) return false;
        var normalized = value.replace(/(^|:)([0-9.]+)$/u, function (_match, prefix, ipv4) {
            return isValidIpv4(ipv4) ? prefix + 'ipv4:ipv4' : 'invalid';
        });
        if (normalized === 'invalid') return false;
        var halves = normalized.split('::');
        if (halves.length > 2) return false;
        var units = 0;
        for (var index = 0; index < halves.length; index++) {
            var half = halves[index];
            if (!half) continue;
            var groups = half.split(':');
            if (!groups.every(function (group) {
                return group === 'ipv4' || /^[0-9a-fA-F]{1,4}$/.test(group);
            })) return false;
            units += groups.reduce(function (count, group) {
                return count + (group === 'ipv4' ? 2 : 1);
            }, 0);
        }
        return halves.length === 2 ? units < 8 : units === 8;
    }

    function isValidHost(value) {
        return isValidIpv4(value)
            || isValidIpv6(value)
            || /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(value);
    }

    function postManagedClientAction(control) {
        var action = control.getAttribute('data-managed-client-action');
        var root = managedRoot();
        if (!action || !root || control.disabled) return;
        closeProjectMenu(false);
        window.vscode.postMessage({
            type: 'managed-remote-client-action',
            version: 1,
            requestId: 'managed-client-' + Date.now() + '-' + nextManagedRequestId++,
            action: action,
            expectedRevisionId: root.getAttribute('data-managed-revision-id') || null,
            ...(control.getAttribute('data-managed-target-id')
                ? { targetId: control.getAttribute('data-managed-target-id') } : {}),
        });
    }

    function onClick(event) {
        var control = event.target && event.target.closest
            ? event.target.closest('[data-action], [data-machine-disclosure], [data-managed-operation], [data-managed-client-action]')
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
                var managedOpen = row.querySelector(
                    ':scope > .machine-row-line > [data-managed-client-action="openProject"]'
                );
                if (managedOpen && !managedOpen.disabled) {
                    postManagedClientAction(managedOpen);
                    return;
                }
                if (managedOpen) return;
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
        if (control.getAttribute('data-action') === 'show-add-machine-form') {
            setAddMachineFormOpen(true, false);
            return;
        }
        if (control.getAttribute('data-action') === 'show-edit-machine-form') {
            closeProjectMenu(false);
            setEditMachineFormOpen(control.getAttribute('data-managed-target-id') || '', true, false);
            return;
        }
        if (control.getAttribute('data-action') === 'cancel-managed-machine-form') {
            setManagedMachineFormOpen(control.closest('[data-managed-machine-form]'), false, true);
            return;
        }
        if (control.closest('[data-managed-machine-form]')) return;
        if (control.hasAttribute('data-managed-operation')) {
            postManagedAction(control);
            return;
        }
        if (control.hasAttribute('data-managed-client-action')) {
            postManagedClientAction(control);
            return;
        }
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
            toggleProjectMenu(control, event.detail === 0);
        } else if (action === 'toggle-machine-menu') {
            toggleProjectMenu(control, event.detail === 0);
        } else if (action === 'rename-machine') {
            postMachineAction(control, 'rename-machine');
        } else if (action === 'reset-machine-name') {
            postMachineAction(control, 'reset-machine-name');
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
        var managedOpen = row.querySelector(
            ':scope > .machine-row-line > [data-managed-client-action="openProject"]'
        );
        if (managedOpen) {
            if (!managedOpen.disabled) postManagedClientAction(managedOpen);
            return;
        }
        postProjectOpen(row, ProjectOpenType.NewWindow);
    }

    function onChange(event) {
        if (!event.target || !event.target.matches('[data-machine-tag-checkbox]')) return;
        if (event.target.checked) selectedTags.add(event.target.value);
        else selectedTags.delete(event.target.value);
        writeArray(storageKeys.tags, selectedTags);
        applyFilters();
    }

    function onSubmit(event) {
        var form = event.target && event.target.closest
            ? event.target.closest('[data-managed-machine-form]') : null;
        if (!form || !panel || !panel.contains(form)) return;
        event.preventDefault();
        submitManagedMachineForm(form);
    }

    function onKeyDown(event) {
        if (event.key === 'Escape' && activeProjectMenuTrigger) {
            event.preventDefault();
            closeProjectMenu(true);
            return;
        }
        if (event.key === 'Escape' && event.target && event.target.closest
            && event.target.closest('[data-managed-machine-form]')) {
            event.preventDefault();
            setManagedMachineFormOpen(event.target.closest('[data-managed-machine-form]'), false, true);
            return;
        }
        var menu = event.target && event.target.closest
            ? event.target.closest('[data-machine-project-menu]')
            : null;
        if (menu && (event.key === 'ArrowDown' || event.key === 'ArrowUp'
            || event.key === 'Home' || event.key === 'End')) {
            event.preventDefault();
            var items = Array.from(menu.querySelectorAll('[role="menuitem"]:not(:disabled)'));
            if (!items.length) return;
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
            var projectRow = event.target.closest('[data-machine-project-row]');
            var machineRow = !projectRow && event.target.closest('[data-machine-row]');
            var trigger = projectRow
                ? projectRow.querySelector('[data-action="toggle-machine-project-menu"]')
                : machineRow && machineRow.querySelector(
                    ':scope > .machine-row-line [data-action="toggle-machine-menu"]'
                );
            if (trigger) {
                event.preventDefault();
                toggleProjectMenu(trigger, true);
                return;
            }
        }
        if (event.key === 'Escape') {
            var tagPopover = panel && panel.querySelector('[data-machine-tag-popover]');
            if (tagPopover && !tagPopover.hidden) {
                event.preventDefault();
                closeTags(true);
            }
        }
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
        var row = activeProjectMenuTrigger.closest(
            '[data-machine-project-row], [data-machine-row]'
        );
        if (event.target === document
            && activeProjectMenuTrigger.getAttribute('data-action') === 'toggle-machine-menu') {
            return;
        }
        if (!row || !row.contains(event.target)) closeProjectMenu(false);
    }

    function onWindowBlur() {
        closeProjectMenu(false);
        closeTags(false);
    }

    function onWindowMessage(event) {
        var message = event && event.data;
        if (!message || message.type !== 'managed-remote-settlement'
            || message.version !== 1 || typeof message.requestId !== 'string') {
            return;
        }
        var pending = pendingManagedActions.get(message.requestId);
        if (!pending || message.operation !== pending.operation) return;
        pendingManagedActions.delete(message.requestId);
        setManagedControlsPending(
            pending.operation,
            pending.targetId,
            message.requestId,
            false
        );
        if (message.status === 'applied') {
            var submittedForm = findManagedMachineForm(pending.operation, pending.targetId);
            if (submittedForm) {
                submittedForm.hidden = true;
                resetManagedMachineForm(submittedForm);
                if (pending.operation === 'addMachine') {
                    var addTrigger = panel && panel.querySelector('[data-action="show-add-machine-form"]');
                    if (addTrigger) addTrigger.setAttribute('aria-expanded', 'false');
                }
            }
            if (pending.focusAddMachine) {
                var trigger = panel && panel.querySelector('[data-action="show-add-machine-form"]');
                if (trigger) trigger.focus();
            } else if (pending.focusEditedMachineId) {
                var editedMachine = panel && Array.from(panel.querySelectorAll('[data-machine-row]'))
                    .find(function (row) { return row.getAttribute('data-machine-id') === pending.focusEditedMachineId; });
                var editedFocus = editedMachine && editedMachine.querySelector('.machine-row-primary');
                if (editedFocus) editedFocus.focus();
            }
            announceManaged('Changes saved to your VS Code User settings.');
        } else if (message.status === 'cancelled') {
            announceManaged('No changes were saved.');
        } else {
            var form = findManagedMachineForm(pending.operation, pending.targetId);
            if ((pending.operation === 'addMachine' || pending.operation === 'editMachine')
                && form && !form.hidden) {
                var error = form.querySelector('[data-managed-machine-form-error]');
                if (error) {
                    error.textContent = typeof message.message === 'string'
                        ? message.message : pending.operation === 'editMachine'
                            ? 'Unable to save Machine changes.' : 'Unable to add the Machine.';
                    error.hidden = false;
                }
            }
            announceManaged(typeof message.message === 'string'
                ? message.message : 'The Managed Remote action failed.');
        }
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
            panel.addEventListener('submit', onSubmit);
            panel.addEventListener('keydown', onKeyDown);
            panel.__agentPivotMachineProjectsBound = true;
        }
        restoreState();
        restoreManagedPendingControls();
        return true;
    }

    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    document.addEventListener('focusin', onDocumentFocusIn);
    document.addEventListener('scroll', onDocumentScroll, true);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('message', onWindowMessage);
    return {
        mount: mount,
        isMounted: function () { return Boolean(panel); },
        getDisclosureCollapsedStates: getDisclosureCollapsedStates,
        setAllDisclosuresCollapsed: setAllDisclosuresCollapsed,
        captureManagedMachineFormState: captureManagedMachineFormState,
        restoreManagedMachineFormState: restoreManagedMachineFormState,
        applyTextFilter: function (value) {
            textQuery = String(value || '').trim().toLocaleLowerCase();
            applyFilters();
        },
    };
}
