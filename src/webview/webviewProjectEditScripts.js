function initProjectInlineEdit(dashboard) {
    var editingProjectId = null;

    // Intercept the context menu's onTriggerProjectAction to catch edit clicks.
    // window.__agentPivotContextMenus is set by initProjects() before this runs.
    var contextMenus = window.__agentPivotContextMenus;
    if (contextMenus) {
        var originalOnTrigger = contextMenus.onTriggerProjectAction;
        contextMenus.onTriggerProjectAction = function(target, projectId) {
            var actionDiv = target.closest('[data-action]');
            if (actionDiv && actionDiv.getAttribute('data-action') === 'edit') {
                showEditForm(projectId);
                return true;
            }
            return originalOnTrigger.call(contextMenus, target, projectId);
        };
    }

    function showEditForm(projectId) {
        if (editingProjectId) {
            cancelEdit();
        }

        var projectDiv = document.querySelector('.project[data-id="' + CSS.escape(projectId) + '"]');
        if (!projectDiv || projectDiv.hasAttribute('data-readonly-project')) return;

        editingProjectId = projectId;
        projectDiv.setAttribute('data-editing', '');

        var nameInput = projectDiv.querySelector('[data-edit-field="name"]');
        if (nameInput) {
            nameInput.focus();
            nameInput.select();
        }
    }

    function cancelEdit() {
        if (!editingProjectId) return;

        var projectDiv = document.querySelector('.project[data-id="' + CSS.escape(editingProjectId) + '"]');
        if (projectDiv) {
            projectDiv.removeAttribute('data-editing');
        }
        editingProjectId = null;
    }

    function saveEdit() {
        if (!editingProjectId) return;

        var projectDiv = document.querySelector('.project[data-id="' + CSS.escape(editingProjectId) + '"]');
        if (!projectDiv) return;

        var nameInput = projectDiv.querySelector('[data-edit-field="name"]');
        var descInput = projectDiv.querySelector('[data-edit-field="description"]');
        var tagsInput = projectDiv.querySelector('[data-edit-field="tags"]');

        var name = (nameInput && nameInput.value || '').trim();
        if (!name) {
            if (nameInput) nameInput.focus();
            return;
        }

        window.vscode.postMessage({
            type: 'save-project-inline',
            projectId: editingProjectId,
            name: name,
            description: (descInput && descInput.value || '').trim(),
            tags: (tagsInput && tagsInput.value || '').trim(),
        });

        projectDiv.removeAttribute('data-editing');
        editingProjectId = null;
    }

    document.addEventListener('click', function(e) {
        var actionEl = e.target.closest('[data-action]');
        if (!actionEl) return;

        var action = actionEl.getAttribute('data-action');
        if (action === 'cancel-edit') {
            e.preventDefault();
            e.stopPropagation();
            cancelEdit();
            return;
        }

        if (action === 'save-edit') {
            e.preventDefault();
            e.stopPropagation();
            saveEdit();
            return;
        }
    }, true);

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && editingProjectId) {
            cancelEdit();
        }
        if (e.key === 'Enter' && editingProjectId && e.target && e.target.closest('.project-edit-form')) {
            e.preventDefault();
            saveEdit();
        }
    });

    return { showEditForm: showEditForm, cancelEdit: cancelEdit };
}
