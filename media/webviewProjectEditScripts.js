function initProjectInlineEdit(dashboard) {
    var editingProjectId = null;
    var originalPostMessage = window.vscode.postMessage.bind(window.vscode);

    window.vscode.postMessage = function(message) {
        if (message && message.type === 'edit-project') {
            showEditForm(message.projectId);
            return;
        }
        return originalPostMessage(message);
    };

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

        originalPostMessage({
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
