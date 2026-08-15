'use strict';

/**
 * The M2 inline worktree group creation form (PRD §6.1): an in-place card
 * at the top of the Worktree panel with a real-time per-member preview.
 *
 * Form state lives here (not in the DOM) because authoritative workspace
 * updates replace the surface HTML wholesale; reconcileDom re-renders the
 * form after every applied update. Closing the form keeps the unsubmitted
 * input for the next open.
 */
function initWorktreeGroupForm(options) {
    options = options || {};
    var getCurrentWorkspaceDiv = options.findCurrentWorkspaceDiv;

    var PREVIEW_DEBOUNCE_MS = 300;
    var statesByProject = new Map();
    var nextRequestSerial = 0;

    function nextRequestId(prefix) {
        nextRequestSerial = nextRequestSerial >= Number.MAX_SAFE_INTEGER
            ? 1 : nextRequestSerial + 1;
        return prefix + '-' + nextRequestSerial.toString(36);
    }

    function getState(projectId) {
        return statesByProject.get(projectId) || null;
    }

    function ensureState(projectId) {
        var state = statesByProject.get(projectId);
        if (!state) {
            state = {
                open: false,
                bootstrapping: false,
                name: '',
                repositories: [],
                checked: {},
                baseRefOverrides: {},
                setupDisabled: {},
                primaryRepositoryKey: '',
                preview: null,
                previewDirty: false,
                previewRequestId: '',
                previewTimer: 0,
                confirming: false,
                confirmRequestId: '',
                formError: '',
                pendingFocusGroupId: '',
                pendingMemberRequests: {},
            };
            statesByProject.set(projectId, state);
        }
        return state;
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function shortRefName(ref) {
        var value = String(ref || '');
        return value.indexOf('refs/heads/') === 0
            ? value.slice('refs/heads/'.length)
            : value;
    }

    function checkedRepositories(state) {
        return state.repositories.filter(function (repository) {
            return state.checked[repository.repositoryKey];
        });
    }

    function openForm(projectId, seed) {
        var state = ensureState(projectId);
        if (state.open) {
            return;
        }
        state.open = true;
        state.bootstrapping = true;
        state.formError = '';
        renderForm(projectId);
        var message = {
            type: 'open-worktree-group-form',
            version: 1,
            projectId: projectId,
        };
        if (seed && seed.repositoryKey && seed.worktreePath) {
            message.seedRepositoryKey = seed.repositoryKey;
            message.seedWorktreePath = seed.worktreePath;
        }
        window.vscode.postMessage(message);
        focusNameInput(projectId);
    }

    function closeForm(projectId, keepInput) {
        var state = getState(projectId);
        if (!state || !state.open) {
            return;
        }
        state.open = false;
        state.bootstrapping = false;
        state.confirming = false;
        state.previewDirty = false;
        if (state.previewTimer) {
            clearTimeout(state.previewTimer);
            state.previewTimer = 0;
        }
        if (!keepInput) {
            var focusGroupId = state.pendingFocusGroupId;
            statesByProject.delete(projectId);
            if (focusGroupId) {
                ensureState(projectId).pendingFocusGroupId = focusGroupId;
            }
        }
        renderForm(projectId);
    }

    function applyFormState(message) {
        if (!message || message.type !== 'worktree-group-form-state'
            || message.version !== 1 || typeof message.projectId !== 'string'
            || !Array.isArray(message.repositories)) {
            return false;
        }
        var state = getState(message.projectId);
        if (!state || !state.open) {
            return true;
        }
        state.bootstrapping = false;
        state.repositories = message.repositories.filter(function (repository) {
            return repository && typeof repository.repositoryKey === 'string';
        });
        if (!Object.keys(state.checked).length) {
            state.repositories.forEach(function (repository) {
                state.checked[repository.repositoryKey] = !!repository.defaultChecked;
            });
        }
        if (message.seed && typeof message.seed.repositoryKey === 'string'
            && typeof message.seed.baseRef === 'string') {
            // Branch-from-here: check only the seeded repository and prefill
            // its branch as the base-ref override (PRD §6.1 entry rules).
            state.repositories.forEach(function (repository) {
                state.checked[repository.repositoryKey] =
                    repository.repositoryKey === message.seed.repositoryKey;
            });
            state.baseRefOverrides[message.seed.repositoryKey] = message.seed.baseRef;
        }
        var checked = checkedRepositories(state);
        if (!checked.some(function (repository) {
            return repository.repositoryKey === state.primaryRepositoryKey;
        })) {
            state.primaryRepositoryKey = checked.length
                ? checked[0].repositoryKey : '';
        }
        schedulePreview(message.projectId, 0);
        renderForm(message.projectId);
        return true;
    }

    function schedulePreview(projectId, debounceMs) {
        var state = getState(projectId);
        if (!state || !state.open) {
            return;
        }
        if (state.previewTimer) {
            clearTimeout(state.previewTimer);
        }
        state.previewDirty = true;
        state.previewTimer = setTimeout(function () {
            state.previewTimer = 0;
            sendPreviewRequest(projectId);
        }, debounceMs === undefined ? PREVIEW_DEBOUNCE_MS : debounceMs);
        // Never rebuild the form on a keystroke: innerHTML replacement
        // destroys the focused input mid-typing. Patch only the actions row.
        syncActionsDom(projectId);
    }

    function sendPreviewRequest(projectId) {
        var state = getState(projectId);
        if (!state || !state.open) {
            return;
        }
        var requestId = nextRequestId('group-preview');
        state.previewRequestId = requestId;
        window.vscode.postMessage({
            type: 'preview-worktree-group',
            version: 1,
            requestId: requestId,
            projectId: projectId,
            displayName: state.name,
            selections: checkedRepositories(state).map(function (repository) {
                var override = state.baseRefOverrides[repository.repositoryKey];
                return override
                    ? { repositoryKey: repository.repositoryKey, baseRef: override }
                    : { repositoryKey: repository.repositoryKey };
            }),
        });
    }

    function applyPreview(message) {
        if (!message || message.type !== 'worktree-group-preview'
            || message.version !== 1 || typeof message.requestId !== 'string'
            || !Array.isArray(message.members)) {
            return false;
        }
        var state = statesByProject.get(message.projectId || '');
        // Stale responses must never overwrite a newer form state (PRD §6.1
        // preview engineering contract).
        if (!state || !state.open || message.requestId !== state.previewRequestId) {
            return true;
        }
        state.preview = {
            slug: typeof message.slug === 'string' ? message.slug : '',
            formError: message.formError === 'invalid-task' ? 'invalid-task' : '',
            members: message.members,
        };
        state.previewDirty = false;
        renderForm(message.projectId);
        return true;
    }

    function previewMemberFor(state, repositoryKey) {
        if (!state.preview) {
            return null;
        }
        for (var index = 0; index < state.preview.members.length; index++) {
            if (state.preview.members[index].repositoryKey === repositoryKey) {
                return state.preview.members[index];
            }
        }
        return null;
    }

    function availableMembers(state) {
        return checkedRepositories(state).filter(function (repository) {
            var member = previewMemberFor(state, repository.repositoryKey);
            return member && member.preflight === 'ok';
        });
    }

    function hasPreflightFailures(state) {
        return checkedRepositories(state).some(function (repository) {
            var member = previewMemberFor(state, repository.repositoryKey);
            return member && member.preflight !== 'ok';
        });
    }

    function confirmForm(projectId, availableOnly) {
        var state = getState(projectId);
        if (!state || !state.open || state.confirming || state.previewDirty
            || !state.preview || state.preview.formError) {
            return;
        }
        var selected = availableOnly
            ? availableMembers(state)
            : checkedRepositories(state);
        if (!selected.length) {
            return;
        }
        if (!availableOnly && hasPreflightFailures(state)) {
            return;
        }
        var members = [];
        for (var index = 0; index < selected.length; index++) {
            var repository = selected[index];
            var preview = previewMemberFor(state, repository.repositoryKey);
            if (!preview || preview.preflight !== 'ok') {
                return;
            }
            members.push({
                repositoryKey: repository.repositoryKey,
                baseRef: preview.baseRef,
                branchName: preview.branchName,
                worktreePath: preview.worktreePath,
                setupCommand: state.setupDisabled[repository.repositoryKey]
                    ? []
                    : (repository.setupCommand || []),
            });
        }
        var primaryAvailable = members.some(function (member) {
            return member.repositoryKey === state.primaryRepositoryKey;
        });
        state.confirming = true;
        state.confirmRequestId = nextRequestId('group-confirm');
        state.formError = '';
        var message = {
            type: 'confirm-worktree-group',
            version: 1,
            requestId: state.confirmRequestId,
            projectId: projectId,
            displayName: state.name,
            members: members,
        };
        if (primaryAvailable) {
            message.primaryRepositoryKey = state.primaryRepositoryKey;
        }
        window.vscode.postMessage(message);
        renderForm(projectId);
    }

    function applyCreationSettlement(message) {
        if (!message || message.type !== 'worktree-group-creation-settlement'
            || message.version !== 1 || typeof message.requestId !== 'string'
            || ['accepted', 'created', 'failed'].indexOf(message.status) < 0) {
            return false;
        }
        var entries = statesByProject.entries();
        for (var step = entries.next(); !step.done; step = entries.next()) {
            var projectId = step.value[0];
            var state = step.value[1];
            if (state.confirmRequestId !== message.requestId) {
                continue;
            }
            if (message.status === 'accepted') {
                return true;
            }
            state.confirming = false;
            if (message.status === 'created') {
                state.pendingFocusGroupId = typeof message.groupId === 'string'
                    ? message.groupId : '';
                // Confirmed: the next open starts from a clean form, and
                // focus lands on the new group row once it renders.
                announce(projectId, 'Worktree group created.');
                closeForm(projectId, false);
            } else {
                state.formError = typeof message.errorCode === 'string'
                    ? message.errorCode : 'unexpected-error';
                announce(projectId, describeFormError(state.formError));
                renderForm(projectId);
            }
            return true;
        }
        return true;
    }

    function submitMemberRequest(projectId, button, type) {
        var groupId = button.getAttribute('data-group-id');
        var memberId = button.getAttribute('data-member-id');
        if (!groupId || !memberId || button.disabled) {
            return;
        }
        var requestId = nextRequestId('group-member');
        button.disabled = true;
        button.setAttribute('aria-disabled', 'true');
        var state = ensureState(projectId);
        state.pendingMemberRequests[requestId] = {
            button: button, groupId: groupId, memberId: memberId,
        };
        window.vscode.postMessage({
            type: type,
            version: 1,
            requestId: requestId,
            projectId: projectId,
            groupId: groupId,
            memberId: memberId,
        });
    }

    function applyMemberSettlement(message) {
        if (!message || message.type !== 'worktree-group-member-settlement'
            || message.version !== 1 || typeof message.requestId !== 'string'
            || ['accepted', 'settled', 'failed'].indexOf(message.status) < 0) {
            return false;
        }
        var entries = statesByProject.entries();
        for (var step = entries.next(); !step.done; step = entries.next()) {
            var pending = step.value[1].pendingMemberRequests[message.requestId];
            if (!pending) {
                continue;
            }
            if (message.status === 'accepted') {
                return true;
            }
            delete step.value[1].pendingMemberRequests[message.requestId];
            if (pending.button && pending.button.isConnected) {
                pending.button.disabled = false;
                pending.button.removeAttribute('aria-disabled');
            }
            announce(step.value[0], message.status === 'settled'
                ? 'Member worktree ready.'
                : 'Member action failed'
                    + (typeof message.errorCode === 'string'
                        ? ': ' + describePreflight(message.errorCode) : '') + '.');
            return true;
        }
        return true;
    }

    function describePreflight(code) {
        switch (code) {
            case 'branch-conflict': return 'branch name already exists';
            case 'path-conflict': return 'path already exists';
            case 'repository-has-no-commits': return 'repository has no commits yet';
            case 'base-ref-unavailable': return 'base ref unavailable';
            case 'allocation-exhausted': return 'no free branch/path suffix';
            case 'repository-unavailable': return 'repository unavailable';
            default: return code || 'unavailable';
        }
    }

    // PRD §8: 人话错误，不显示裸错误码.
    function describeFormError(code) {
        switch (code) {
            case 'invalid-task': return 'Enter a group name.';
            case 'invalid-members': return 'The member set is no longer valid; close and reopen the form.';
            case 'workspace-unavailable': return 'The workspace is unavailable.';
            case 'manifest-unavailable': return 'The workspace changed during creation; try again.';
            case 'store-full': return 'Too many worktree groups; remove some first.';
            default: return 'Creation failed: ' + (code || 'unexpected error');
        }
    }

    function announce(projectId, text) {
        var projectDiv = getCurrentWorkspaceDiv
            ? getCurrentWorkspaceDiv(projectId) : null;
        var liveRegion = projectDiv
            && projectDiv.querySelector('[data-ai-session-live-region]');
        if (liveRegion) {
            liveRegion.textContent = text;
        }
    }

    // The single-instance rule must be visible: while the form is open the
    // new-worktree button is disabled (PRD §6.1).
    function syncCreateButton(projectId, formOpen) {
        var projectDiv = getCurrentWorkspaceDiv
            ? getCurrentWorkspaceDiv(projectId) : null;
        var button = projectDiv
            && projectDiv.querySelector('[data-action="create-isolated-session"]');
        if (button) {
            button.disabled = !!formOpen;
        }
    }

    function memberRowHtml(state, repository, index) {
        var key = repository.repositoryKey;
        var checked = !!state.checked[key];
        var preview = previewMemberFor(state, key);
        var seen = {};
        var refs = [];
        [repository.defaultBaseRef]
            .concat((repository.localBranches || []).map(function (branch) {
                return 'refs/heads/' + branch;
            }))
            .forEach(function (ref) {
                if (ref && !seen[ref]) {
                    seen[ref] = true;
                    refs.push(ref);
                }
            });
        var optionsHtml = refs.map(function (ref) {
            var selected = (state.baseRefOverrides[key] || repository.defaultBaseRef) === ref;
            return '<option value="' + escapeHtml(ref) + '"'
                + (selected ? ' selected' : '') + '>'
                + escapeHtml(shortRefName(ref)) + '</option>';
        }).join('');
        var multiRepo = state.repositories.length > 1;
        var preflight = preview && preview.preflight !== 'ok'
            ? '<span class="ai-session-group-form-preflight" role="alert" id="group-form-preflight-'
                + index + '">' + escapeHtml(describePreflight(preview.preflight.code)) + '</span>'
            : '';
        var plan = preview && preview.preflight === 'ok'
            ? '<span class="ai-session-group-form-plan">'
                + escapeHtml(preview.worktreePath) + ' \u2190 '
                + escapeHtml(preview.branchName) + '</span>'
            : '';
        var setup = repository.setupCommand && repository.setupCommand.length
            ? '<label class="ai-session-group-form-setup">'
                + '<input type="checkbox" data-group-form-setup="' + escapeHtml(key) + '"'
                + (state.setupDisabled[key] ? '' : ' checked') + (checked ? '' : ' disabled') + '>'
                + '<span>' + (state.setupDisabled[key]
                    ? 'setup disabled for this repository'
                    : 'setup: ' + escapeHtml(repository.setupCommand.join(' '))) + '</span></label>'
            : '<span class="ai-session-group-form-setup ai-session-group-form-setup-none">no setup configured</span>';
        var primary = checked
            ? '<label class="ai-session-group-form-primary" data-tooltip="Primary worktree for new sessions">'
                + '<input type="radio" name="group-form-primary" data-group-form-primary="'
                + escapeHtml(key) + '"'
                + (state.primaryRepositoryKey === key ? ' checked' : '') + '>primary</label>'
            : '';
        return '<div class="ai-session-group-form-member"'
            + ' data-group-form-member="' + escapeHtml(key) + '"'
            + (checked ? '' : ' data-unchecked') + '>'
            + (multiRepo
                ? '<label class="ai-session-group-form-check">'
                    + '<input type="checkbox" data-group-form-check="' + escapeHtml(key) + '"'
                    + (checked ? ' checked' : '') + '>'
                    + '<span>' + escapeHtml(repository.label) + '</span></label>'
                : '<span class="ai-session-group-form-check ai-session-group-form-single">'
                    + escapeHtml(repository.label) + '</span>')
            + '<select class="ai-session-group-form-base" data-group-form-base="'
                + escapeHtml(key) + '" aria-label="Base branch for '
                + escapeHtml(repository.label) + '"' + (checked ? '' : ' disabled') + '>'
                + optionsHtml + '</select>'
            + primary + setup + plan + preflight
            + '</div>';
    }

    function formSlot(projectId) {
        var projectDiv = getCurrentWorkspaceDiv
            ? getCurrentWorkspaceDiv(projectId) : null;
        return projectDiv && projectDiv.querySelector('[data-worktree-group-form-slot]');
    }

    function actionsHtml(state) {
        var checked = checkedRepositories(state);
        var failures = hasPreflightFailures(state);
        var availableCount = availableMembers(state).length;
        var hasName = !!state.name.trim();
        var canConfirm = !state.confirming && !state.previewDirty
            && !!state.preview && !state.preview.formError
            && checked.length > 0 && !failures && hasName;
        var canConfirmAvailable = !state.confirming && !state.previewDirty
            && !!state.preview && failures && availableCount > 0 && hasName;
        var availableButton = failures
            ? '<button type="button" class="ai-session-group-form-available"'
                + ' data-group-form-action="confirm-available"'
                + (canConfirmAvailable ? '' : ' disabled')
                + '>Create only the available ' + availableCount + '/'
                + checked.length + ' members</button>'
            : '';
        return '<button type="button" class="ai-session-group-form-confirm"'
            + ' data-group-form-action="confirm"' + (canConfirm ? '' : ' disabled')
            + '>Create worktree group</button>'
            + availableButton
            + (state.previewDirty && hasName
                ? '<span class="ai-session-group-form-pending">previewing\u2026</span>'
                : '');
    }

    // Light patch for keystroke-driven state changes: the confirm button
    // and the pending indicator follow the dirty flag without touching the
    // rest of the form (a full rebuild would drop input focus).
    function syncActionsDom(projectId) {
        var state = getState(projectId);
        var slot = formSlot(projectId);
        var actions = slot && slot.querySelector('.ai-session-group-form-actions');
        if (!state || !state.open || !actions) {
            return;
        }
        actions.innerHTML = actionsHtml(state);
    }

    function captureFormFocus(slot) {
        var active = document.activeElement;
        if (!active || !slot.contains(active)) {
            return null;
        }
        var attributes = [
            'data-group-form-name',
            'data-group-form-base',
            'data-group-form-check',
            'data-group-form-setup',
            'data-group-form-primary',
            'data-group-form-action',
        ];
        for (var index = 0; index < attributes.length; index++) {
            var attribute = attributes[index];
            var value = active.getAttribute && active.getAttribute(attribute);
            if (value !== null && value !== undefined) {
                return {
                    selector: '[' + attribute + (value ? '="' + CSS.escape(value) + '"' : '') + ']',
                    selectionStart: attribute === 'data-group-form-name'
                        ? active.selectionStart : null,
                    selectionEnd: attribute === 'data-group-form-name'
                        ? active.selectionEnd : null,
                };
            }
        }
        return null;
    }

    function restoreFormFocus(slot, capture) {
        if (!capture) {
            return;
        }
        var element = slot.querySelector(capture.selector);
        if (!element) {
            return;
        }
        element.focus();
        if (capture.selectionStart !== null && element.setSelectionRange) {
            element.setSelectionRange(capture.selectionStart, capture.selectionEnd);
        }
    }

    function renderForm(projectId) {
        var state = getState(projectId);
        var slot = formSlot(projectId);
        if (!slot) {
            return;
        }
        if (!state || !state.open) {
            slot.hidden = true;
            slot.innerHTML = '';
            syncCreateButton(projectId, false);
            return;
        }
        var focus = captureFormFocus(slot);
        var membersHtml = state.bootstrapping
            ? '<div class="ai-session-group-form-loading">Loading repositories\u2026</div>'
            : (state.repositories.length
                ? state.repositories.map(function (repository, index) {
                    return memberRowHtml(state, repository, index);
                }).join('')
                : '<div class="ai-session-group-form-loading">No git repository found in this workspace.</div>');
        var selectionTools = state.repositories.length > 1
            ? '<div class="ai-session-group-form-tools">'
                + '<button type="button" data-group-form-action="select-all">Select all</button>'
                + '<button type="button" data-group-form-action="select-none">Clear</button>'
                + '</div>'
            : '';
        slot.innerHTML = '<div class="ai-session-group-form" data-worktree-group-form'
            + ' data-project-id="' + escapeHtml(projectId) + '">'
            + '<div class="ai-session-group-form-title">New worktree group</div>'
            + '<div class="ai-session-group-form-header">'
            + '<input type="text" class="ai-session-group-form-name"'
            + ' data-group-form-name placeholder="Worktree group name"'
            + ' aria-label="Worktree group name" value="' + escapeHtml(state.name) + '">'
            + '<button type="button" class="ai-session-group-form-close"'
            + ' data-group-form-action="close" aria-label="Close creation form"'
            + ' data-tooltip="Close (Esc)">\u00d7</button>'
            + '</div>'
            + (state.preview && state.preview.formError === 'invalid-task'
                ? '<div class="ai-session-group-form-error" role="alert">Enter a group name.</div>'
                : '')
            + (state.formError
                ? '<div class="ai-session-group-form-error" role="alert">'
                    + escapeHtml(describeFormError(state.formError)) + '</div>'
                : '')
            + selectionTools
            + '<div class="ai-session-group-form-members">' + membersHtml + '</div>'
            + '<div class="ai-session-group-form-actions">' + actionsHtml(state) + '</div>'
            + '</div>';
        slot.hidden = false;
        restoreFormFocus(slot, focus);
        syncCreateButton(projectId, true);
    }

    function focusNameInput(projectId) {
        var projectDiv = getCurrentWorkspaceDiv
            ? getCurrentWorkspaceDiv(projectId) : null;
        var input = projectDiv && projectDiv.querySelector('[data-group-form-name]');
        if (input) {
            input.focus();
        }
    }

    // Re-render after authoritative workspace updates replaced the DOM, and
    // move focus to a freshly created group row exactly once.
    function reconcileDom() {
        var entries = statesByProject.entries();
        for (var step = entries.next(); !step.done; step = entries.next()) {
            var projectId = step.value[0];
            var state = step.value[1];
            if (state.open) {
                renderForm(projectId);
            }
            if (state.pendingFocusGroupId) {
                var projectDiv = getCurrentWorkspaceDiv
                    ? getCurrentWorkspaceDiv(projectId) : null;
                var header = projectDiv && projectDiv.querySelector(
                    '.ai-session-worktree-task-group[data-group-id="'
                    + CSS.escape(state.pendingFocusGroupId)
                    + '"] .ai-session-worktree-header');
                if (header) {
                    state.pendingFocusGroupId = '';
                    header.focus();
                }
            }
        }
    }

    function onClick(target, projectDiv, projectId) {
        var formAction = target.closest
            ? target.closest('[data-group-form-action]') : null;
        if (formAction) {
            var action = formAction.getAttribute('data-group-form-action');
            if (action === 'close') {
                closeForm(projectId, true);
            } else if (action === 'confirm') {
                confirmForm(projectId, false);
            } else if (action === 'confirm-available') {
                confirmForm(projectId, true);
            } else if (action === 'select-all' || action === 'select-none') {
                var state = getState(projectId);
                if (state) {
                    var checkAll = action === 'select-all';
                    state.repositories.forEach(function (repository) {
                        state.checked[repository.repositoryKey] = checkAll;
                    });
                    var remaining = checkedRepositories(state);
                    if (!remaining.some(function (repository) {
                        return repository.repositoryKey === state.primaryRepositoryKey;
                    })) {
                        state.primaryRepositoryKey = remaining.length
                            ? remaining[0].repositoryKey : '';
                    }
                    schedulePreview(projectId, 0);
                    // Bulk selection changes every checkbox: the light
                    // actions patch is not enough here.
                    renderForm(projectId);
                }
            }
            return true;
        }
        var memberAction = target.closest
            ? target.closest('[data-action="retry-group-member"],'
                + '[data-action="dismiss-group-member"]') : null;
        if (memberAction) {
            submitMemberRequest(
                projectId, memberAction,
                memberAction.getAttribute('data-action') === 'retry-group-member'
                    ? 'retry-worktree-group-member'
                    : 'dismiss-worktree-group-member');
            return true;
        }
        return false;
    }

    function onInput(target) {
        var nameInput = target.closest
            ? target.closest('[data-group-form-name]') : null;
        if (!nameInput) {
            return false;
        }
        var form = nameInput.closest('[data-worktree-group-form]');
        var projectId = form && form.getAttribute('data-project-id');
        var state = projectId && getState(projectId);
        if (!state) {
            return true;
        }
        state.name = nameInput.value;
        schedulePreview(projectId);
        return true;
    }

    function onChange(target) {
        var form = target.closest
            ? target.closest('[data-worktree-group-form]') : null;
        if (!form) {
            return false;
        }
        var projectId = form.getAttribute('data-project-id');
        var state = projectId && getState(projectId);
        if (!state) {
            return true;
        }
        var check = target.closest('[data-group-form-check]');
        if (check) {
            var key = check.getAttribute('data-group-form-check');
            state.checked[key] = !!check.checked;
            if (state.checked[key] && !state.primaryRepositoryKey) {
                state.primaryRepositoryKey = key;
            }
            if (!state.checked[key] && state.primaryRepositoryKey === key) {
                var remaining = checkedRepositories(state);
                state.primaryRepositoryKey = remaining.length
                    ? remaining[0].repositoryKey : '';
            }
            schedulePreview(projectId, 0);
            return true;
        }
        var base = target.closest('[data-group-form-base]');
        if (base) {
            state.baseRefOverrides[base.getAttribute('data-group-form-base')] =
                base.value;
            schedulePreview(projectId, 0);
            return true;
        }
        var setup = target.closest('[data-group-form-setup]');
        if (setup) {
            state.setupDisabled[setup.getAttribute('data-group-form-setup')] =
                !setup.checked;
            renderForm(projectId);
            return true;
        }
        var primary = target.closest('[data-group-form-primary]');
        if (primary) {
            state.primaryRepositoryKey =
                primary.getAttribute('data-group-form-primary');
            renderForm(projectId);
            return true;
        }
        return false;
    }

    function onKeydown(event) {
        var form = event.target && event.target.closest
            ? event.target.closest('[data-worktree-group-form]') : null;
        if (!form) {
            return false;
        }
        var projectId = form.getAttribute('data-project-id');
        if (event.key === 'Escape') {
            closeForm(projectId, true);
            return true;
        }
        if (event.key === 'Enter' && event.target.matches('[data-group-form-name]')) {
            // Single-repo degradation keeps the old one-shot flow: Enter
            // submits when the form is confirmable (PRD §7).
            confirmForm(projectId, false);
            return true;
        }
        return false;
    }

    document.addEventListener('input', function (event) {
        onInput(event.target);
    });
    document.addEventListener('change', function (event) {
        onChange(event.target);
    });
    document.addEventListener('keydown', function (event) {
        onKeydown(event);
    });

    return {
        openForm: openForm,
        closeForm: closeForm,
        isOpen: function (projectId) {
            var state = getState(projectId);
            return !!state && state.open;
        },
        onClick: onClick,
        reconcileDom: reconcileDom,
        applyFormState: applyFormState,
        applyPreview: applyPreview,
        applyCreationSettlement: applyCreationSettlement,
        applyMemberSettlement: applyMemberSettlement,
    };
}
