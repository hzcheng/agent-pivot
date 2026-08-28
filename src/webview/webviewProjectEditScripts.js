function initProjectInlineEdit() {
    var editingProjectId = null;
    var saveRequestSequence = 0;
    var pendingRequestId = null;

    function findProject(projectId) {
        return Array.from(document.querySelectorAll('.project[data-id]')).find(function(projectDiv) {
            return projectDiv.getAttribute('data-id') === projectId;
        }) || null;
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

    function showEditForm(projectId) {
        if (editingProjectId) {
            cancelEdit();
        }

        var projectDiv = findProject(projectId);
        if (!projectDiv || projectDiv.hasAttribute('data-readonly-project')) return;

        editingProjectId = projectId;
        var form = projectDiv.querySelector('.project-edit-form');
        if (form && typeof form.reset === 'function') {
            form.reset();
        }
        setFeedback(projectDiv, '');
        projectDiv.setAttribute('data-editing', '');

        var nameInput = projectDiv.querySelector('[data-edit-field="name"]');
        if (nameInput) {
            nameInput.focus();
            nameInput.select();
        }
    }

    function cancelEdit() {
        if (!editingProjectId) return;

        var projectDiv = findProject(editingProjectId);
        if (projectDiv) {
            var form = projectDiv.querySelector('.project-edit-form');
            if (form && typeof form.reset === 'function') {
                form.reset();
            }
            setFeedback(projectDiv, '');
            projectDiv.removeAttribute('data-editing');
            setSaving(projectDiv, false);
        }
        editingProjectId = null;
        pendingRequestId = null;
    }

    function saveEdit() {
        if (!editingProjectId) return;

        var projectDiv = findProject(editingProjectId);
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
        setSaving(projectDiv, true);
        setFeedback(projectDiv, 'Saving…');
        window.vscode.postMessage({
            type: 'save-project-inline',
            version: 1,
            requestId: pendingRequestId,
            projectId: editingProjectId,
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
            showEditForm(projectId);
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
        if (e.key === 'Escape' && editingProjectId) {
            e.preventDefault();
            cancelEdit();
        }
        if (e.key === 'Enter' && editingProjectId && e.target && e.target.closest('.project-edit-form')) {
            e.preventDefault();
            saveEdit();
        }
    });

    window.addEventListener('message', function(event) {
        var message = event && event.data;
        if (!message || message.type !== 'project-inline-edit-settlement'
            || message.version !== 1 || message.status !== 'failed'
            || message.projectId !== editingProjectId || message.requestId !== pendingRequestId) {
            return;
        }
        var projectDiv = findProject(editingProjectId);
        if (!projectDiv) return;
        setSaving(projectDiv, false);
        pendingRequestId = null;
        setFeedback(projectDiv, 'Could not save the project. Try again.');
    });

    return {
        onProjectAction: onProjectAction,
        showEditForm: showEditForm,
        cancelEdit: cancelEdit,
    };
}
