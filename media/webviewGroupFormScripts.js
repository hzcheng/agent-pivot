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
    var MAX_RENDERED_BASE_OPTIONS = 100;
    var getCurrentWorkspaceDiv = options.findCurrentWorkspaceDiv;

    var PREVIEW_DEBOUNCE_MS = 300;
    var statesByProject = new Map();
    var nextRequestSerial = 0;
    // Focus captured BEFORE an authoritative replacement destroys the form
    // slot; renderForm prefers it over the live DOM read (which can only see
    // document.body once the old slot is gone).
    var replacementFocusByProject = new Map();
    // IME composition (CJK input): while a composition is active the preedit
    // string lives inside the focused input, so ANY form rebuild — a preview
    // response re-render or an authoritative surface replacement — detaches
    // that input and aborts the composition (the candidate window dies and
    // focus restore cannot resurrect it). Renders defer to compositionend,
    // and the message dispatcher queues authoritative updates via
    // onCompositionEnd.
    var composition = { active: false, projectId: '' };
    var compositionEndListeners = [];

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
                previewId: '',
                previewDirty: false,
                previewRequestId: '',
                previewTimer: 0,
                baseDropdown: null,
                confirming: false,
                confirmRequestId: '',
                formError: '',
                renderDeferred: false,
                pendingClose: null,
                pendingFocusGroupId: '',
                pendingMemberRequests: {},
                derive: null,
                addRepo: null,
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
        if (value.indexOf('refs/heads/') === 0) {
            return value.slice('refs/heads/'.length);
        }
        return value.indexOf('refs/remotes/') === 0
            ? value.slice('refs/remotes/'.length)
            : value;
    }

    function baseRefLabel(ref) {
        var name = shortRefName(ref);
        return String(ref || '').indexOf('refs/remotes/') === 0
            ? name + ' (remote)' : name;
    }

    function matchingBaseRefs(refs, filter) {
        var query = String(filter || '').toLowerCase();
        return refs.filter(function (ref) {
            return baseRefLabel(ref).toLowerCase().indexOf(query) >= 0;
        });
    }

    function baseRefsFor(repository) {
        return [repository.defaultBaseRef]
            .concat((repository.localBranches || []).map(function (branch) {
                return 'refs/heads/' + branch;
            }))
            .concat((repository.remoteBranches || []).map(function (branch) {
                return 'refs/remotes/' + branch;
            }))
            .filter(function (ref, position, all) {
                return ref && all.indexOf(ref) === position;
            });
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
        if (seed && seed.sourceGroupId) {
            message.sourceGroupId = seed.sourceGroupId;
        }
        if (seed && seed.targetGroupId) {
            message.targetGroupId = seed.targetGroupId;
        }
        window.vscode.postMessage(message);
        focusNameInput(projectId);
    }

    function closeForm(projectId, keepInput) {
        var state = getState(projectId);
        if (!state || !state.open) {
            return;
        }
        if (composition.active && composition.projectId === projectId) {
            // Tearing the form down now would detach the composing input
            // and abort the IME session; close when the composition ends.
            state.pendingClose = !!keepInput;
            return;
        }
        state.open = false;
        state.bootstrapping = false;
        state.confirming = false;
        state.pendingClose = null;
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
        if (message.derive && typeof message.derive === 'object'
            && typeof message.derive.sourceGroupId === 'string') {
            // Derive mode (PRD §6.2): precheck the source group's member
            // repositories, override each base ref to the source branch,
            // and prefill the default name 源名-2 (until the user types).
            state.derive = {
                sourceGroupId: message.derive.sourceGroupId,
                sourceName: typeof message.derive.sourceName === 'string'
                    ? message.derive.sourceName : '',
                skipped: Array.isArray(message.derive.skipped)
                    ? message.derive.skipped.filter(function (entry) {
                        return entry && typeof entry.repositoryLabel === 'string'
                            && typeof entry.reason === 'string';
                    })
                    : [],
            };
            var deriveChecked = Array.isArray(message.derive.checkedRepositories)
                ? message.derive.checkedRepositories : [];
            state.repositories.forEach(function (repository) {
                state.checked[repository.repositoryKey] =
                    deriveChecked.indexOf(repository.repositoryKey) >= 0;
            });
            if (message.derive.baseOverrides
                && typeof message.derive.baseOverrides === 'object') {
                Object.keys(message.derive.baseOverrides).forEach(function (repositoryKey) {
                    if (typeof message.derive.baseOverrides[repositoryKey] === 'string') {
                        state.baseRefOverrides[repositoryKey] =
                            message.derive.baseOverrides[repositoryKey];
                    }
                });
            }
            if (!state.name.trim() && typeof message.derive.suggestedName === 'string') {
                state.name = message.derive.suggestedName;
            }
        }
        if (message.addRepo && typeof message.addRepo === 'object'
            && typeof message.addRepo.groupId === 'string'
            && typeof message.addRepo.displayName === 'string') {
            // Add-repo mode (PRD §6.3): the group name and slug are locked;
            // the form only picks the repositories to add.
            state.addRepo = {
                groupId: message.addRepo.groupId,
                displayName: message.addRepo.displayName,
            };
            state.name = message.addRepo.displayName;
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
        if (!state || !state.open || composition.active) {
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
            ...(state.derive ? { sourceGroupId: state.derive.sourceGroupId } : {}),
            ...(state.addRepo ? { targetGroupId: state.addRepo.groupId } : {}),
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
            || typeof message.previewId !== 'string'
            || typeof message.projectId !== 'string'
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
        state.previewId = message.previewId;
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
            || composition.active
            || !state.preview || state.preview.formError || !state.previewId) {
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
                // The host re-reads the configured command per repository;
                // the webview only carries the user's toggle.
                setupEnabled: !state.setupDisabled[repository.repositoryKey],
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
            previewId: state.previewId,
            displayName: state.name,
            members: members,
        };
        if (state.addRepo) {
            message.targetGroupId = state.addRepo.groupId;
        }
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
                // The group row usually rendered before this settlement
                // arrived; try the focus immediately instead of waiting
                // for a replacement that may never come.
                reconcileDom();
            } else {
                state.formError = typeof message.errorCode === 'string'
                    ? message.errorCode : 'unexpected-error';
                announce(projectId, describeFormError(state.formError));
                renderForm(projectId);
                if (state.formError === 'preview-stale') {
                    // Recompute immediately so the refreshed preview shows
                    // the configuration that rejected the old confirm.
                    schedulePreview(projectId, 0);
                }
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
            case 'store-full': return 'too many dismissed worktrees pending cleanup; remove them from disk first';
            default: return code || 'unavailable';
        }
    }

    // PRD §8: 人话错误，不显示裸错误码.
    function describeFormError(code) {
        switch (code) {
            case 'invalid-task': return 'Enter a group name.';
            case 'invalid-members': return 'The member set is no longer valid; close and reopen the form.';
            case 'preview-stale': return 'The setup configuration changed; the preview has been refreshed — review and confirm again.';
            case 'workspace-unavailable': return 'The workspace is unavailable.';
            case 'manifest-unavailable': return 'The workspace changed during creation; try again.';
            case 'base-ref-unavailable': return 'The selected base branch is no longer available; choose another branch and try again.';
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
        var refs = baseRefsFor(repository);
        var multiRepo = state.repositories.length > 1;
        var preflight = preview && preview.preflight !== 'ok'
            ? '<span class="ai-session-group-form-preflight" role="alert" id="group-form-preflight-'
                + index + '">' + escapeHtml(describePreflight(preview.preflight.code)) + '</span>'
            : '';
        var preflightId = preflight ? 'group-form-preflight-' + index : '';
        var selectedRef = state.baseRefOverrides[key] || repository.defaultBaseRef;
        var baseHtml = baseComboboxHtml(
            state, key, repository, refs, selectedRef, checked, preflightId);
        var plan = preview && preview.preflight === 'ok'
            ? '<span class="ai-session-group-form-plan">'
                + escapeHtml(preview.worktreePath) + ' \u2190 '
                + escapeHtml(preview.branchName) + '</span>'
            : '';
        // Display the setup command from the authoritative preview (config
        // is re-resolved per preview); the bootstrap value is only a
        // pre-first-preview placeholder. An empty array is authoritative
        // too: a config change to empty must not resurrect the old command.
        var setupCommand = preview && Array.isArray(preview.setupCommand)
            ? preview.setupCommand
            : repository.setupCommand;
        var setup = setupCommand && setupCommand.length
            ? '<label class="ai-session-group-form-setup">'
                + '<input type="checkbox" data-group-form-setup="' + escapeHtml(key) + '"'
                + (state.setupDisabled[key] ? '' : ' checked') + (checked ? '' : ' disabled') + '>'
                + '<span>' + (state.setupDisabled[key]
                    ? 'setup disabled for this repository'
                    : 'setup: ' + escapeHtml(setupCommand.join(' '))) + '</span></label>'
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
                    + (checked ? ' checked' : '')
                    + (preflightId ? ' aria-describedby="' + preflightId + '"' : '') + '>'
                    + '<span>' + escapeHtml(repository.label) + '</span></label>'
                : '<span class="ai-session-group-form-check ai-session-group-form-single">'
                    + escapeHtml(repository.label) + '</span>')
            + baseHtml
            + primary + setup + plan + preflight
            + '</div>';
    }

    // Searchable base-branch combobox (PRD §6.1): a text input filters the
    // local and fetched remote branch list; ArrowUp/Down + Enter choose, Esc closes.
    function baseComboboxHtml(state, key, repository, refs, selectedRef, checked, preflightId) {
        var label = repository.label;
        var open = state.baseDropdown && state.baseDropdown.repositoryKey === key;
        if (!open) {
            return '<button type="button" class="ai-session-group-form-base"'
                + ' data-group-form-base="' + escapeHtml(key) + '"'
                + ' role="combobox" aria-expanded="false"'
                + ' aria-label="Base branch for ' + escapeHtml(label) + ': '
                    + escapeHtml(baseRefLabel(selectedRef)) + '"'
                + ' data-tooltip="' + escapeHtml(baseRefLabel(selectedRef)) + '"'
                + (preflightId
                    ? ' aria-invalid="true" aria-errormessage="' + preflightId + '"'
                        + ' aria-describedby="' + preflightId + '"'
                    : '')
                + (checked ? '' : ' disabled') + '>'
                + escapeHtml(baseRefLabel(selectedRef)) + ' \u25be</button>';
        }
        var filter = state.baseDropdown.filter || '';
        var matching = matchingBaseRefs(refs, filter);
        var filtered = matching.slice(0, MAX_RENDERED_BASE_OPTIONS);
        var activeIndex = Math.min(state.baseDropdown.activeIndex, filtered.length - 1);
        var optionsHtml = filtered.map(function (ref, position) {
            return '<li role="option" id="group-form-base-option-' + position + '"'
                + ' data-group-form-base-option="' + escapeHtml(ref) + '"'
                + ' aria-selected="' + (ref === selectedRef) + '"'
                + (position === activeIndex ? ' data-active' : '') + '>'
                + escapeHtml(baseRefLabel(ref)) + '</li>';
        }).join('');
        if (matching.length > filtered.length) {
            optionsHtml += '<li class="ai-session-group-form-base-limit"'
                + ' role="option" aria-disabled="true">Showing the first '
                + MAX_RENDERED_BASE_OPTIONS + ' of ' + matching.length
                + ' matches; refine your search.</li>';
        }
        return '<span class="ai-session-group-form-base-combobox">'
            + '<input type="text" class="ai-session-group-form-base-filter"'
            + ' data-group-form-base-filter="' + escapeHtml(key) + '"'
            + ' role="combobox" aria-expanded="true"'
            + ' aria-controls="group-form-base-listbox"'
            + (preflightId
                ? ' aria-invalid="true" aria-errormessage="' + preflightId + '"'
                    + ' aria-describedby="' + preflightId + '"'
                : '')
            + (activeIndex >= 0
                ? ' aria-activedescendant="group-form-base-option-' + activeIndex + '"'
                : '')
            + ' aria-label="Search base branch for ' + escapeHtml(label) + '"'
            + ' value="' + escapeHtml(filter) + '">'
            + '<ul role="listbox" id="group-form-base-listbox"'
            + ' class="ai-session-group-form-base-listbox">'
            + (optionsHtml || '<li class="ai-session-group-form-base-empty">no matching branch</li>')
            + '</ul></span>';
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
            'data-group-form-base-filter',
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
                var isTextInput = attribute === 'data-group-form-name'
                    || attribute === 'data-group-form-base-filter';
                return {
                    selector: '[' + attribute + (value ? '="' + CSS.escape(value) + '"' : '') + ']',
                    selectionStart: isTextInput
                        ? active.selectionStart : null,
                    selectionEnd: isTextInput
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

    // Called by the authoritative update paths while the old DOM is still
    // mounted (focus is global, so at most one open form holds it).
    function captureFocus() {
        var entries = statesByProject.entries();
        for (var step = entries.next(); !step.done; step = entries.next()) {
            var projectId = step.value[0];
            var state = step.value[1];
            if (!state.open) {
                continue;
            }
            var slot = formSlot(projectId);
            var focus = slot && captureFormFocus(slot);
            if (focus) {
                replacementFocusByProject.set(projectId, focus);
            }
        }
    }

    function renderForm(projectId) {
        var state = getState(projectId);
        var slot = formSlot(projectId);
        if (!slot) {
            return;
        }
        // Never rebuild mid-composition: detaching the input that owns the
        // IME preedit aborts the composition. The deferred render flushes
        // on compositionend.
        if (state && state.open && composition.projectId === projectId) {
            state.renderDeferred = true;
            return;
        }
        if (state) {
            state.renderDeferred = false;
        }
        if (!state || !state.open) {
            replacementFocusByProject.delete(projectId);
            slot.hidden = true;
            slot.innerHTML = '';
            syncCreateButton(projectId, false);
            return;
        }
        var focus = replacementFocusByProject.get(projectId) || null;
        replacementFocusByProject.delete(projectId);
        if (!focus) {
            focus = captureFormFocus(slot);
        }
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
            + '<div class="ai-session-group-form-title">'
            + (state.addRepo
                ? 'Add repositories to ' + escapeHtml(state.addRepo.displayName)
                : state.derive
                    ? 'Derive from ' + escapeHtml(state.derive.sourceName || 'group')
                    : 'New worktree group')
            + '</div>'
            + (state.derive && state.derive.skipped.length
                ? '<div class="ai-session-group-form-derive-skipped" role="note">'
                    + 'Skipped: ' + state.derive.skipped.map(function (entry) {
                        return escapeHtml(entry.repositoryLabel)
                            + ' (' + escapeHtml(entry.reason) + ')';
                    }).join('; ')
                    + '</div>'
                : '')
            + '<div class="ai-session-group-form-header">'
            + '<input type="text" class="ai-session-group-form-name"'
            + ' data-group-form-name placeholder="Worktree group name"'
            + ' aria-label="Worktree group name" value="' + escapeHtml(state.name) + '"'
            // Add-repo mode locks the group name (PRD §6.3: slug 锁定).
            + (state.addRepo ? ' readonly aria-readonly="true"' : '')
            + ((state.preview && state.preview.formError === 'invalid-task') || state.formError
                ? ' aria-invalid="true" aria-describedby="group-form-name-error group-form-error"'
                : '') + '>'
            + '<button type="button" class="ai-session-group-form-close"'
            + ' data-group-form-action="close" aria-label="Close creation form"'
            + ' data-tooltip="Close (Esc)">\u00d7</button>'
            + '</div>'
            + (state.preview && state.preview.formError === 'invalid-task'
                ? '<div class="ai-session-group-form-error" id="group-form-name-error" role="alert">Enter a group name.</div>'
                : '')
            + (state.formError
                ? '<div class="ai-session-group-form-error" id="group-form-error" role="alert">'
                    + escapeHtml(describeFormError(state.formError)) + '</div>'
                : '')
            + '<div class="ai-session-group-form-remote-hint" role="note">'
                + 'Remote branches reflect your last fetch; creating does not fetch.</div>'
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
        var state = getState(projectId);
        var baseToggle = target.closest
            ? target.closest('[data-group-form-base]') : null;
        if (baseToggle) {
            if (state) {
                var toggleKey = baseToggle.getAttribute('data-group-form-base');
                state.baseDropdown = state.baseDropdown
                    && state.baseDropdown.repositoryKey === toggleKey
                    ? null
                    : { repositoryKey: toggleKey, filter: '', activeIndex: 0 };
                renderForm(projectId);
                if (state.baseDropdown) {
                    var filterInput = formSlot(projectId)
                        && formSlot(projectId).querySelector('[data-group-form-base-filter]');
                    if (filterInput) {
                        filterInput.focus();
                    }
                }
            }
            return true;
        }
        var baseOption = target.closest
            ? target.closest('[data-group-form-base-option]') : null;
        if (baseOption) {
            if (state && state.baseDropdown) {
                state.baseRefOverrides[state.baseDropdown.repositoryKey] =
                    baseOption.getAttribute('data-group-form-base-option');
                state.baseDropdown = null;
                schedulePreview(projectId, 0);
                renderForm(projectId);
            }
            return true;
        }
        if (state && state.baseDropdown
            && !(target.closest && target.closest('.ai-session-group-form-base-combobox'))) {
            state.baseDropdown = null;
            renderForm(projectId);
            // Fall through: the click may still hit another form control.
        }
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
        var filterInput = target.closest
            ? target.closest('[data-group-form-base-filter]') : null;
        if (filterInput) {
            var filterForm = filterInput.closest('[data-worktree-group-form]');
            var filterProjectId = filterForm && filterForm.getAttribute('data-project-id');
            var filterState = filterProjectId && getState(filterProjectId);
            if (filterState && filterState.baseDropdown) {
                filterState.baseDropdown.filter = filterInput.value;
                filterState.baseDropdown.activeIndex = 0;
                renderForm(filterProjectId);
            }
            return true;
        }
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
        if (composition.active) {
            // The preedit text is not a committed name yet: previewing it
            // would race the compositionend commit, and the preview
            // response's re-render would abort the composition. The
            // compositionend handler syncs the actions row.
            return true;
        }
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
        // Keystrokes owned by an in-progress IME composition (candidate
        // navigation, Enter committing the candidate, Esc cancelling the
        // preedit) must not drive form actions.
        if (event.isComposing || composition.active) {
            return false;
        }
        var projectId = form.getAttribute('data-project-id');
        var state = projectId && getState(projectId);
        if (state && state.baseDropdown
            && event.target.hasAttribute('data-group-form-base-filter')) {
            var dropdown = state.baseDropdown;
            if (event.key === 'Escape') {
                state.baseDropdown = null;
                renderForm(projectId);
                return true;
            }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp'
                || event.key === 'Enter') {
                var repository = state.repositories.find(function (candidate) {
                    return candidate.repositoryKey === dropdown.repositoryKey;
                });
                var refs = repository ? baseRefsFor(repository) : [];
                var filtered = matchingBaseRefs(refs, dropdown.filter)
                    .slice(0, MAX_RENDERED_BASE_OPTIONS);
                if (event.key === 'Enter') {
                    var chosen = filtered[Math.min(dropdown.activeIndex, filtered.length - 1)];
                    if (chosen) {
                        state.baseRefOverrides[dropdown.repositoryKey] = chosen;
                    }
                    state.baseDropdown = null;
                    schedulePreview(projectId, 0);
                    renderForm(projectId);
                } else {
                    var delta = event.key === 'ArrowDown' ? 1 : -1;
                    dropdown.activeIndex = Math.max(0, Math.min(
                        filtered.length - 1, dropdown.activeIndex + delta));
                    renderForm(projectId);
                }
                event.preventDefault();
                return true;
            }
        }
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

    function compositionFormProjectId(target) {
        if (!target || !target.closest
            || !(target.hasAttribute('data-group-form-name')
                || target.hasAttribute('data-group-form-base-filter'))) {
            return '';
        }
        var form = target.closest('[data-worktree-group-form]');
        return form ? form.getAttribute('data-project-id') || '' : '';
    }

    document.addEventListener('compositionstart', function (event) {
        var projectId = compositionFormProjectId(event.target);
        if (!projectId) {
            return;
        }
        composition.active = true;
        composition.projectId = projectId;
        var state = getState(projectId);
        if (!state || !state.open) {
            return;
        }
        // A preview debounced before the composition began must not send
        // preedit text, and its in-flight response must not be accepted.
        // previewDirty keeps confirm blocked until the committed text has
        // been previewed.
        if (state.previewTimer) {
            clearTimeout(state.previewTimer);
            state.previewTimer = 0;
        }
        state.previewRequestId = '';
        state.previewDirty = true;
        syncActionsDom(projectId);
    });

    document.addEventListener('compositionend', function (event) {
        var projectId = compositionFormProjectId(event.target)
            || composition.projectId;
        if (!projectId || !composition.active) {
            return;
        }
        composition.active = false;
        composition.projectId = '';
        var state = getState(projectId);
        if (state && state.open) {
            var isFilter = !!(event.target && event.target.hasAttribute
                && event.target.hasAttribute('data-group-form-base-filter'));
            if (isFilter) {
                if (state.baseDropdown) {
                    state.baseDropdown.filter = event.target.value;
                }
            } else if (event.target && event.target.hasAttribute
                && event.target.hasAttribute('data-group-form-name')) {
                state.name = event.target.value;
            }
            if (state.pendingClose !== null) {
                // A close deferred while composing (e.g. the created
                // settlement) lands now that no input can be aborted.
                var keepInput = state.pendingClose;
                state.pendingClose = null;
                closeForm(projectId, keepInput);
                reconcileDom();
            } else {
                if (state.renderDeferred) {
                    state.renderDeferred = false;
                    renderForm(projectId);
                }
                if (!isFilter || state.previewDirty) {
                    // The preedit is now committed text: preview the real
                    // name. Filtering branches needs no new preview, but a
                    // preview dirtied mid-composition must be refreshed or
                    // confirm stays blocked.
                    schedulePreview(projectId);
                }
            }
        }
        // Release the authoritative host updates queued while composing;
        // their replacements can no longer abort a composition.
        compositionEndListeners.slice().forEach(function (listener) {
            listener();
        });
    });

    return {
        openForm: openForm,
        closeForm: closeForm,
        isOpen: function (projectId) {
            var state = getState(projectId);
            return !!state && state.open;
        },
        isComposing: function () {
            return composition.active;
        },
        onCompositionEnd: function (listener) {
            if (typeof listener === 'function') {
                compositionEndListeners.push(listener);
            }
        },
        onClick: onClick,
        reconcileDom: reconcileDom,
        captureFocus: captureFocus,
        applyFormState: applyFormState,
        applyPreview: applyPreview,
        applyCreationSettlement: applyCreationSettlement,
        applyMemberSettlement: applyMemberSettlement,
    };
}
