function initProjectInlineEdit() {
    var editingTarget = null;
    var saveRequestSequence = 0;
    var pendingRequestId = null;
    var pendingAuthorityRevision = null;
    var pendingSettlementStatus = null;
    var authorityRevision = 0;

    function getProjectGroupId(projectDiv) {
        var sourceGroupId = projectDiv && projectDiv.getAttribute('data-source-group-id');
        if (sourceGroupId) return sourceGroupId;
        var group = projectDiv && projectDiv.closest('.group');
        if (!group) return '';
        return group.getAttribute('data-group-id')
            || group.getAttribute('data-system-group')
            || '';
    }

    function getProjectTarget(projectDiv) {
        if (!projectDiv) return null;
        var projectId = projectDiv.getAttribute('data-id');
        var groupId = getProjectGroupId(projectDiv);
        return projectId && groupId ? { projectId: projectId, groupId: groupId } : null;
    }

    function findProject(target) {
        if (!target) return null;
        var exact = Array.from(document.querySelectorAll('.project[data-id]')).find(function(projectDiv) {
            return projectDiv.getAttribute('data-id') === target.projectId
                && getProjectGroupId(projectDiv) === target.groupId
                && !projectDiv.closest('[data-virtual-group]');
        });
        if (exact) return exact;

        // A reorder or authoritative sync can move the source row while the
        // editor is open. Fall back only to one real project row, never its
        // Favorites mirror, then adopt its current authoritative group.
        var matches = Array.from(document.querySelectorAll('.project[data-id]')).filter(function(projectDiv) {
            return projectDiv.getAttribute('data-id') === target.projectId
                && !projectDiv.closest('[data-virtual-group]');
        });
        if (matches.length === 1) {
            target.groupId = getProjectGroupId(matches[0]);
            return matches[0];
        }
        return null;
    }

    function setFeedback(projectDiv, message) {
        var feedback = projectDiv && projectDiv.querySelector('[data-project-edit-feedback]');
        if (!feedback) return;
        feedback.textContent = message || '';
        feedback.hidden = !message;
    }

    function setSaving(projectDiv, saving) {
        if (!projectDiv) return;
        projectDiv.toggleAttribute('data-saving', saving);
        Array.from(projectDiv.querySelectorAll('.project-edit-input, .project-edit-actions button'))
            .forEach(function(control) {
                control.disabled = saving;
            });
    }

    function focusEditField(projectDiv, fieldName, selectName) {
        var input = projectDiv && projectDiv.querySelector(
            '[data-edit-field="' + fieldName + '"]'
        );
        if (!input || typeof input.focus !== 'function') return;
        input.focus({ preventScroll: true });
        if (selectName && typeof input.select === 'function') {
            input.select();
        }
    }

    function showEditForm(projectDiv) {
        var target = getProjectTarget(projectDiv);
        if (!target) return;
        if (editingTarget) {
            cancelEdit();
        }

        if (!projectDiv || projectDiv.hasAttribute('data-readonly-project')) return;

        editingTarget = target;
        var form = projectDiv.querySelector('.project-edit-form');
        if (form && typeof form.reset === 'function') {
            form.reset();
        }
        setFeedback(projectDiv, '');
        projectDiv.setAttribute('data-editing', '');

        focusEditField(projectDiv, 'name', true);
    }

    function cancelEdit() {
        if (!editingTarget) return;

        var projectDiv = findProject(editingTarget);
        if (projectDiv) {
            var form = projectDiv.querySelector('.project-edit-form');
            if (form && typeof form.reset === 'function') {
                form.reset();
            }
            setFeedback(projectDiv, '');
            projectDiv.removeAttribute('data-editing');
            setSaving(projectDiv, false);
        }
        editingTarget = null;
        pendingRequestId = null;
        pendingAuthorityRevision = null;
        pendingSettlementStatus = null;
    }

    function saveEdit() {
        if (!editingTarget) return;

        var projectDiv = findProject(editingTarget);
        if (!projectDiv) return;
        if (projectDiv.hasAttribute('data-saving')) return;

        var nameInput = projectDiv.querySelector('[data-edit-field="name"]');
        var descInput = projectDiv.querySelector('[data-edit-field="description"]');
        var tagsInput = projectDiv.querySelector('[data-edit-field="tags"]');

        var name = (nameInput && nameInput.value || '').trim();
        if (!name) {
            setFeedback(projectDiv, 'A project name is required.');
            if (nameInput) nameInput.focus();
            return;
        }

        saveRequestSequence += 1;
        pendingRequestId = 'project-inline-edit-' + Date.now() + '-' + saveRequestSequence;
        pendingAuthorityRevision = authorityRevision;
        pendingSettlementStatus = null;
        setSaving(projectDiv, true);
        setFeedback(projectDiv, 'Saving…');
        window.vscode.postMessage({
            type: 'save-project-inline',
            version: 1,
            requestId: pendingRequestId,
            projectId: editingTarget.projectId,
            groupId: editingTarget.groupId,
            name: name,
            description: (descInput && descInput.value || '').trim(),
            tags: (tagsInput && tagsInput.value || '').trim(),
        });
    }

    function onProjectAction(e, projectDiv, projectId) {
        var actionEl = e.target.closest('[data-action]');
        if (!actionEl) return false;

        var action = actionEl.getAttribute('data-action');
        if (action === 'edit-inline') {
            e.preventDefault();
            e.stopPropagation();
            showEditForm(projectDiv);
            return true;
        }

        if (action === 'cancel-edit') {
            e.preventDefault();
            e.stopPropagation();
            cancelEdit();
            return true;
        }

        if (action === 'save-edit') {
            e.preventDefault();
            e.stopPropagation();
            saveEdit();
            return true;
        }
        return false;
    }

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && editingTarget) {
            e.preventDefault();
            cancelEdit();
        }
        if (e.key === 'Enter' && editingTarget && e.target && e.target.closest('.project-edit-form')) {
            e.preventDefault();
            saveEdit();
        }
    });

    function settlePendingEdit(status) {
        var projectDiv = findProject(editingTarget);
        if (!projectDiv) return;
        setSaving(projectDiv, false);
        pendingRequestId = null;
        pendingAuthorityRevision = null;
        pendingSettlementStatus = null;
        setFeedback(projectDiv, status === 'saved'
            ? 'Saved.'
            : 'Could not save the project. Try again.');
    }

    function settleSavedAfterAuthority() {
        if (pendingSettlementStatus !== 'saved' || pendingAuthorityRevision === null
            || authorityRevision <= pendingAuthorityRevision) {
            return;
        }
        settlePendingEdit('saved');
    }

    window.addEventListener('message', function(event) {
        var message = event && event.data;
        if (!message || message.type !== 'project-inline-edit-settlement'
            || message.version !== 1 || (message.status !== 'saved' && message.status !== 'failed')
            || !editingTarget || message.projectId !== editingTarget.projectId
            || message.requestId !== pendingRequestId) {
            return;
        }
        if (message.status === 'failed') {
            settlePendingEdit('failed');
            return;
        }
        pendingSettlementStatus = 'saved';
        settleSavedAfterAuthority();
    });

    function captureState() {
        if (!editingTarget) return null;
        var projectDiv = findProject(editingTarget);
        if (!projectDiv || !projectDiv.hasAttribute('data-editing')) return null;
        var activeElement = document.activeElement;
        var focusedField = activeElement && projectDiv.contains(activeElement)
            ? activeElement.getAttribute('data-edit-field')
            : null;
        var selectionStart = focusedField && typeof activeElement.selectionStart === 'number'
            ? activeElement.selectionStart
            : null;
        var selectionEnd = focusedField && typeof activeElement.selectionEnd === 'number'
            ? activeElement.selectionEnd
            : null;
        return {
            projectId: editingTarget.projectId,
            groupId: editingTarget.groupId,
            name: (projectDiv.querySelector('[data-edit-field="name"]') || {}).value || '',
            description: (projectDiv.querySelector('[data-edit-field="description"]') || {}).value || '',
            tags: (projectDiv.querySelector('[data-edit-field="tags"]') || {}).value || '',
            feedback: (projectDiv.querySelector('[data-project-edit-feedback]') || {}).textContent || '',
            focusedField: typeof focusedField === 'string' ? focusedField : null,
            selectionStart: selectionStart,
            selectionEnd: selectionEnd,
            pendingRequestId: pendingRequestId,
            pendingAuthorityRevision: pendingAuthorityRevision,
            pendingSettlementStatus: pendingSettlementStatus,
        };
    }

    function restoreState(state) {
        if (!state || typeof state.projectId !== 'string' || typeof state.groupId !== 'string'
            || typeof state.name !== 'string' || typeof state.description !== 'string'
            || typeof state.tags !== 'string') {
            return;
        }
        var target = { projectId: state.projectId, groupId: state.groupId };
        var projectDiv = findProject(target);
        if (!projectDiv || projectDiv.hasAttribute('data-readonly-project')) {
            return;
        }
        editingTarget = target;
        var nameInput = projectDiv.querySelector('[data-edit-field="name"]');
        var descInput = projectDiv.querySelector('[data-edit-field="description"]');
        var tagsInput = projectDiv.querySelector('[data-edit-field="tags"]');
        if (nameInput) nameInput.value = state.name;
        if (descInput) descInput.value = state.description;
        if (tagsInput) tagsInput.value = state.tags;
        projectDiv.setAttribute('data-editing', '');
        pendingRequestId = typeof state.pendingRequestId === 'string' && state.pendingRequestId
            ? state.pendingRequestId
            : null;
        pendingAuthorityRevision = typeof state.pendingAuthorityRevision === 'number'
            ? state.pendingAuthorityRevision
            : null;
        pendingSettlementStatus = state.pendingSettlementStatus === 'saved'
            ? 'saved'
            : null;
        setSaving(projectDiv, Boolean(pendingRequestId));
        setFeedback(projectDiv, typeof state.feedback === 'string' ? state.feedback : '');
        if (state.focusedField === 'name' || state.focusedField === 'description'
            || state.focusedField === 'tags') {
            focusEditField(projectDiv, state.focusedField, false);
            var focusedInput = document.activeElement;
            if (focusedInput && typeof state.selectionStart === 'number'
                && typeof state.selectionEnd === 'number'
                && typeof focusedInput.setSelectionRange === 'function') {
                focusedInput.setSelectionRange(state.selectionStart, state.selectionEnd);
            }
        }
    }

    function onAuthoritativeReplacement() {
        authorityRevision += 1;
        settleSavedAfterAuthority();
    }

    return {
        onProjectAction: onProjectAction,
        showEditForm: showEditForm,
        cancelEdit: cancelEdit,
        captureState: captureState,
        restoreState: restoreState,
        onAuthoritativeReplacement: onAuthoritativeReplacement,
    };
}
