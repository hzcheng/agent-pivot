function normalizeDashboardTab(tab) {
    return tab === 'projects' || tab === 'todo' || tab === 'ai' ? tab : 'open';
}

function getAdjacentDashboardTab(tab, key) {
    tab = normalizeDashboardTab(tab);
    var tabs = ['open', 'projects', 'todo', 'ai'];
    var currentIndex = tabs.indexOf(tab);
    if (key === 'Home') {
        return tabs[0];
    }
    if (key === 'End') {
        return tabs[tabs.length - 1];
    }
    if (key === 'ArrowRight') {
        return tabs[(currentIndex + 1) % tabs.length];
    }
    if (key === 'ArrowLeft') {
        return tabs[(currentIndex + tabs.length - 1) % tabs.length];
    }
    return tab;
}

function validateProjectsPanelMessage(message) {
    return !!message
        && message.type === 'projects-panel-content'
        && message.version === 1
        && Number.isSafeInteger(message.requestId)
        && message.requestId > 0
        && typeof message.html === 'string';
}

function validateProjectsPanelUpdatedMessage(message) {
    if (!message
        || message.type !== 'projects-panel-updated'
        || message.version !== 1
        || !Number.isSafeInteger(message.sequence)
        || message.sequence < 1
        || (message.mode !== 'replace' && message.mode !== 'preserve-order')
        || typeof message.html !== 'string'
        || normalizeDashboardSearchCatalog(message.searchCatalog) !== message.searchCatalog
        || !Array.isArray(message.groupOrders)
        || !Array.isArray(message.favoriteProjectIds)) {
        return false;
    }
    var groupIds = new Set();
    var savedProjectIds = new Set();
    for (var group of message.groupOrders) {
        if (!group
            || typeof group.groupId !== 'string'
            || !group.groupId
            || groupIds.has(group.groupId)
            || !Array.isArray(group.projectIds)) {
            return false;
        }
        groupIds.add(group.groupId);
        for (var projectId of group.projectIds) {
            if (typeof projectId !== 'string'
                || !projectId
                || savedProjectIds.has(projectId)) {
                return false;
            }
            savedProjectIds.add(projectId);
        }
    }
    var favoriteIds = new Set();
    for (var favoriteId of message.favoriteProjectIds) {
        if (typeof favoriteId !== 'string'
            || !favoriteId
            || favoriteIds.has(favoriteId)) {
            return false;
        }
        favoriteIds.add(favoriteId);
    }
    return true;
}

function validateTodoPanelMessage(message) {
    return !!message
        && message.type === 'todo-panel-content'
        && message.version === 1
        && Number.isSafeInteger(message.requestId)
        && message.requestId > 0
        && typeof message.html === 'string';
}

function validateTodoPanelUpdatedMessage(message) {
    return !!message
        && message.type === 'todo-panel-updated'
        && message.version === 1
        && typeof message.html === 'string'
        && normalizeDashboardSearchCatalog(message.searchCatalog) === message.searchCatalog;
}

function hasExactObjectKeys(value, requiredKeys, optionalKeys) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    var allowedKeys = requiredKeys.concat(optionalKeys || []);
    var keys = Object.keys(value);
    return requiredKeys.every(key => Object.prototype.hasOwnProperty.call(value, key))
        && keys.every(key => allowedKeys.indexOf(key) >= 0);
}

function validatePromptPanelSnapshot(snapshot) {
    if (!hasExactObjectKeys(
        snapshot,
        ['version', 'revision', 'selectedPromptId', 'prompts'],
        ['readOnlyReason']
    )
        || snapshot.version !== 1
        || !Number.isSafeInteger(snapshot.revision)
        || snapshot.revision < 0
        || (snapshot.selectedPromptId !== null
            && (typeof snapshot.selectedPromptId !== 'string' || !snapshot.selectedPromptId))
        || !Array.isArray(snapshot.prompts)
        || (snapshot.readOnlyReason !== undefined
            && snapshot.readOnlyReason !== 'invalid-data'
            && snapshot.readOnlyReason !== 'unsupported-version')) {
        return false;
    }

    var promptIds = new Set();
    var promptNames = new Set();
    for (var prompt of snapshot.prompts) {
        if (!hasExactObjectKeys(prompt, ['id', 'name', 'text'])
            || typeof prompt.id !== 'string'
            || !prompt.id
            || typeof prompt.name !== 'string'
            || !prompt.name.trim()
            || typeof prompt.text !== 'string'
            || !prompt.text.trim()
            || promptIds.has(prompt.id)
            || promptNames.has(prompt.name.toLowerCase())) {
            return false;
        }
        promptIds.add(prompt.id);
        promptNames.add(prompt.name.toLowerCase());
    }
    return snapshot.selectedPromptId === null || promptIds.has(snapshot.selectedPromptId);
}

function validateAiPanelMessage(message) {
    return hasExactObjectKeys(message, [
        'type',
        'version',
        'authoritySequence',
        'requestId',
        'target',
        'snapshot',
        'html',
    ])
        && message.type === 'ai-panel-content'
        && message.version === 1
        && Number.isSafeInteger(message.authoritySequence)
        && message.authoritySequence > 0
        && typeof message.requestId === 'string'
        && message.requestId.length > 0
        && message.requestId.length <= 128
        && message.target === 'global-prompt-library'
        && validatePromptPanelSnapshot(message.snapshot)
        && typeof message.html === 'string';
}

function validatePromptPanelUpdatedMessage(message) {
    return hasExactObjectKeys(message, [
        'type',
        'version',
        'authoritySequence',
        'target',
        'snapshot',
        'html',
    ])
        && message.type === 'prompt-panel-updated'
        && message.version === 1
        && Number.isSafeInteger(message.authoritySequence)
        && message.authoritySequence > 0
        && message.target === 'global-prompt-library'
        && validatePromptPanelSnapshot(message.snapshot)
        && typeof message.html === 'string';
}

function normalizeDashboardSearchCatalog(value) {
    if (value
        && value.version === 2
        && Array.isArray(value.sessions)
        && Array.isArray(value.openWorkspaces)
        && Array.isArray(value.savedProjects)
        && Array.isArray(value.todos)
        && (value.skills === undefined || Array.isArray(value.skills))) {
        return value;
    }
    return { version: 2, sessions: [], openWorkspaces: [], savedProjects: [], todos: [] };
}

function replaceDashboardSearchCatalogState(state, catalog) {
    return Object.assign({}, state, {
        catalog: normalizeDashboardSearchCatalog(catalog),
    });
}
