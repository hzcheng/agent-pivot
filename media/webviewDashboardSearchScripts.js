function readInitialDashboardSearchCatalog() {
    var element = document.getElementById('dashboard-search-catalog');
    try {
        return normalizeDashboardSearchCatalog(JSON.parse(element ? element.textContent || '' : ''));
    } catch (_error) {
        return normalizeDashboardSearchCatalog(null);
    }
}

function globToDashboardRegex(value) {
    var escaped = String(value || '')
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(escaped, 'i');
}

function filterDashboardCatalog(catalog, query) {
    catalog = normalizeDashboardSearchCatalog(catalog);
    var regex = globToDashboardRegex(query);
    var sections = [
        { id: 'ai-sessions', title: 'AI SESSIONS', type: 'session', items: catalog.sessions },
        { id: 'worktrees', title: 'WORKTREES', type: 'worktree', items: catalog.worktrees },
        { id: 'open-workspaces', title: 'OPEN WORKSPACES', type: 'open-workspace', items: catalog.openWorkspaces },
        { id: 'saved-projects', title: 'SAVED PROJECTS', type: 'saved-project', items: catalog.savedProjects },
        { id: 'skills', title: 'SKILLS', type: 'skill', items: catalog.skills || [] },
    ];
    return sections
        .map(section => ({
            id: section.id,
            title: section.title,
            type: section.type,
            items: section.items.filter(item => regex.test(String(item.searchText || ''))),
        }))
        .filter(section => section.items.length > 0);
}

function renderDashboardSearchResults(container, sections) {
    if (!container) {
        return;
    }
    while (container.firstChild) {
        container.removeChild(container.firstChild);
    }
    if (!sections.length) {
        var empty = document.createElement('div');
        empty.className = 'dashboard-search-empty';
        empty.setAttribute('role', 'status');
        empty.textContent = 'No matching projects or AI sessions.';
        container.appendChild(empty);
        return;
    }

    sections.forEach(section => {
        var sectionElement = document.createElement('section');
        sectionElement.className = 'dashboard-search-section';
        sectionElement.dataset.sectionType = section.type;
        var heading = document.createElement('h2');
        heading.className = 'dashboard-search-section-title';
        heading.textContent = section.title;
        sectionElement.appendChild(heading);

        section.items.forEach(item => {
            var button = document.createElement('button');
            button.type = 'button';
            button.className = 'dashboard-search-result';
            button.dataset.projectId = String(item.projectId || '');

            var title = document.createElement('span');
            title.className = 'dashboard-search-result-title';
            title.textContent = String(item.name || item.title || '');
            button.appendChild(title);

            var metadata = document.createElement('span');
            metadata.className = 'dashboard-search-result-meta';
            if (section.type === 'session') {
                button.dataset.provider = String(item.provider || '');
                button.dataset.sessionId = String(item.sessionId || '');
                button.dataset.searchAction = 'reveal-workspace-session';
                button.dataset.workspaceId = String(item.workspaceId || '');
                button.dataset.workspaceNavigationIdentity = String(item.workspaceNavigationIdentity || '');
                metadata.textContent = [item.workspaceName, item.provider].filter(Boolean).join(' · ');
                if (item.active === true) {
                    var activeBadge = document.createElement('span');
                    activeBadge.className = 'dashboard-search-result-status active';
                    activeBadge.textContent = 'Active';
                    metadata.appendChild(activeBadge);
                }
            } else if (section.type === 'worktree') {
                button.dataset.searchAction = 'reveal-workspace-worktree';
                button.dataset.workspaceId = String(item.workspaceId || '');
                button.dataset.workspaceNavigationIdentity = String(item.workspaceNavigationIdentity || '');
                button.dataset.repositoryKey = String(item.repositoryKey || '');
                button.dataset.worktreePath = String(item.canonicalWorktreePath || '');
                metadata.textContent = [item.workspaceName, item.activity, `${item.sessionCount || 0} sessions`]
                    .filter(Boolean).join(' · ');
            } else if (section.type === 'open-workspace') {
                button.dataset.workspaceId = String(item.workspaceId || '');
                button.dataset.workspaceNavigationIdentity = String(item.navigationIdentity || '');
                button.dataset.searchAction = item.current === true
                    ? 'show-current-workspace'
                    : 'switch-open-workspace';
                metadata.textContent = [item.description, item.environmentLabel].filter(Boolean).join(' · ');
            } else if (section.type === 'skill') {
                button.dataset.searchAction = 'reveal-skill';
                button.dataset.skillDir = String(item.dirPath || '');
                metadata.textContent = [item.scope === 'project' ? 'Project' : 'Global', item.description].filter(Boolean).join(' · ');
            } else {
                button.dataset.searchAction = 'open-saved-project';
                metadata.textContent = [item.description].concat(item.groupLabels || []).filter(Boolean).join(' · ');
            }
            button.appendChild(metadata);
            sectionElement.appendChild(button);
        });
        container.appendChild(sectionElement);
    });
}
