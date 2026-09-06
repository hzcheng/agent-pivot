function readDashboardSessionValue(key) {
    try {
        return window.sessionStorage ? window.sessionStorage.getItem(key) : null;
    } catch (_error) {
        return null;
    }
}

function writeDashboardSessionValue(key, value) {
    try {
        if (window.sessionStorage) {
            window.sessionStorage.setItem(key, value);
        }
    } catch (_error) {
        // Some sandboxed Webviews deny sessionStorage. Dashboard state remains local.
    }
}

function formatFileTransferBytes(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return 'Unknown size';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function renderLocalFileTransferEntries(fileList, entries, selectedIds, onChange, onOpenDirectory) {
    fileList.textContent = '';
    entries.forEach(function (entry) {
        var row = document.createElement('li');
        row.className = 'file-transfer-file-row';
        if (entry.kind === 'symlink' || entry.kind === 'unsupported') {
            row.className += ' is-unsupported';
        }
        row.setAttribute('data-file-transfer-entry-id', entry.id);
        if (entry.kind === 'directory') {
            row.title = 'Double-click to open this folder';
            row.addEventListener('dblclick', function () { onOpenDirectory(entry.id); });
        }
        var label = document.createElement('label');
        var checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = selectedIds.has(entry.id);
        checkbox.disabled = entry.kind !== 'directory' && entry.kind !== 'file';
        checkbox.addEventListener('change', function () {
            onChange(entry.id, checkbox.checked);
        });
        var kind = entry.kind === 'directory' ? 'Folder' : entry.kind === 'file' ? 'File' : entry.kind;
        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(kind + '  ' + entry.name));
        var meta = [];
        if (Number.isSafeInteger(entry.size)) meta.push(formatFileTransferBytes(entry.size));
        if (Number.isSafeInteger(entry.modifiedAt)) {
            meta.push(new Date(entry.modifiedAt).toLocaleString());
        }
        if (entry.kind === 'symlink' || entry.kind === 'unsupported') {
            meta.push('Not supported for copy');
        }
        if (meta.length) {
            var metadata = document.createElement('span');
            metadata.className = 'file-transfer-file-meta';
            metadata.textContent = meta.join(' · ');
            label.appendChild(metadata);
        }
        row.appendChild(label);
        fileList.appendChild(row);
    });
}

function sortFileTransferEntries(entries, sort) {
    return entries.slice().sort(function (left, right) {
        if (sort === 'size') {
            var leftSize = Number.isSafeInteger(left.size) ? left.size : -1;
            var rightSize = Number.isSafeInteger(right.size) ? right.size : -1;
            if (leftSize !== rightSize) return rightSize - leftSize;
        } else if (sort === 'modified') {
            var leftModified = Number.isSafeInteger(left.modifiedAt) ? left.modifiedAt : -1;
            var rightModified = Number.isSafeInteger(right.modifiedAt) ? right.modifiedAt : -1;
            if (leftModified !== rightModified) return rightModified - leftModified;
        } else if (sort === 'type' && left.kind !== right.kind) {
            return left.kind.localeCompare(right.kind);
        } else if (sort === 'name') {
            if (left.kind === 'directory' && right.kind !== 'directory') return -1;
            if (left.kind !== 'directory' && right.kind === 'directory') return 1;
        }
        return left.name.localeCompare(right.name);
    });
}

function validateFileTransferLocalRootMessage(message) {
    if (!message || typeof message !== 'object'
        || message.version !== 1
        || typeof message.requestId !== 'string'
        || !/^[A-Za-z0-9._:-]{16,256}$/.test(message.requestId)
        || (message.side !== 'left' && message.side !== 'right')) {
        return false;
    }
    if ((message.type === 'file-transfer-local-root-selected'
        || message.type === 'file-transfer-remote-directory-listed') && message.root) {
        return Object.keys(message).sort().join('\n') === [
            'requestId', 'root', 'side', 'type', 'version',
        ].join('\n') && validateFileTransferLocalRoot(message.root);
    }
    if (message.type === 'file-transfer-local-root-failed'
        || message.type === 'file-transfer-remote-directory-failed') {
        return Object.keys(message).sort().join('\n') === [
            'message', 'requestId', 'side', 'type', 'version',
        ].join('\n')
            && typeof message.message === 'string'
            && message.message.length > 0
            && message.message.length <= 320;
    }
    return Object.keys(message).sort().join('\n') === [
        'cancelled', 'requestId', 'side', 'type', 'version',
    ].join('\n') && message.type === 'file-transfer-local-root-selected'
        && message.cancelled === true;
}

function validateFileTransferLocalRoot(root) {
    return !!root && typeof root === 'object'
        && Object.keys(root).sort().join('\n') === [
            'directoryId', 'displayPath', 'entries', 'label', 'rootId',
        ].join('\n')
        && /^[a-f0-9]{32}$/.test(root.rootId)
        && /^[a-f0-9]{32}$/.test(root.directoryId)
        && typeof root.label === 'string'
        && root.label.length > 0
        && root.label.length <= 255
        && typeof root.displayPath === 'string'
        && root.displayPath.length > 0
        && root.displayPath.length <= 1024
        && !/[\0\r\n]/.test(root.displayPath)
        && Array.isArray(root.entries)
        && root.entries.length <= 1000
        && root.entries.every(validateFileTransferDirectoryEntry);
}

function validateFileTransferDirectoryEntry(entry) {
    return !!entry && typeof entry === 'object'
        && Object.keys(entry).every(function (key) {
            return ['id', 'name', 'kind', 'size', 'modifiedAt'].includes(key);
        })
        && ['id', 'name', 'kind'].every(function (key) {
            return Object.prototype.hasOwnProperty.call(entry, key);
        })
        && /^[a-f0-9]{32}$/.test(entry.id)
        && typeof entry.name === 'string'
        && entry.name.length > 0
        && entry.name.length <= 255
        && ['directory', 'file', 'symlink', 'unsupported'].includes(entry.kind)
        && (entry.size === undefined || (Number.isSafeInteger(entry.size) && entry.size >= 0))
        && (entry.modifiedAt === undefined
            || (Number.isSafeInteger(entry.modifiedAt) && entry.modifiedAt >= 0));
}

function validateFileTransferCopySettlement(message) {
    if (!message || message.type !== 'file-transfer-copy-settled'
        || message.version !== 1
        || typeof message.requestId !== 'string'
        || !/^[A-Za-z0-9._:-]{16,256}$/.test(message.requestId)
        || (message.status !== 'copied' && message.status !== 'cancelled' && message.status !== 'failed')) {
        return false;
    }
    if (message.status === 'copied' || message.status === 'cancelled') {
        return Object.keys(message).sort().join('\n') === [
            'requestId', 'status', 'type', 'value', 'version',
        ].join('\n');
    }
    return Object.keys(message).sort().join('\n') === [
        'message', 'requestId', 'status', 'type', 'version',
    ].join('\n') && typeof message.message === 'string' && message.message.length <= 320;
}

function validateFileTransferCopyStarted(message) {
    return !!message && message.type === 'file-transfer-copy-started'
        && message.version === 1
        && typeof message.requestId === 'string'
        && /^[A-Za-z0-9._:-]{16,256}$/.test(message.requestId)
        && Object.keys(message).sort().join('\n') === [
            'requestId', 'type', 'version',
        ].join('\n');
}

function validateFileTransferCopyQueued(message) {
    return !!message && message.type === 'file-transfer-copy-queued'
        && message.version === 1
        && typeof message.requestId === 'string'
        && /^[A-Za-z0-9._:-]{16,256}$/.test(message.requestId)
        && Number.isSafeInteger(message.position) && message.position >= 1 && message.position <= 10
        && Object.keys(message).sort().join('\n') === [
            'position', 'requestId', 'type', 'version',
        ].join('\n');
}

function validateFileTransferHistory(message) {
    return !!message && message.type === 'file-transfer-history'
        && message.version === 1
        && Object.keys(message).sort().join('\n') === ['entries', 'type', 'version'].join('\n')
        && Array.isArray(message.entries)
        && message.entries.length <= 50
        && message.entries.every(function (entry) {
            return !!entry && typeof entry === 'object'
                && Object.keys(entry).every(function (key) {
                    return ['at', 'status', 'itemCount', 'conflictPolicy', 'completedItems', 'skippedItems'].includes(key);
                })
                && Number.isSafeInteger(entry.at) && entry.at > 0
                && (entry.status === 'copied' || entry.status === 'cancelled' || entry.status === 'failed')
                && Number.isSafeInteger(entry.itemCount) && entry.itemCount > 0
                && ['fail', 'skip', 'replace'].includes(entry.conflictPolicy);
        });
}

function validateFileTransferHistoryClearSettlement(message) {
    if (!message || message.version !== 1
        || typeof message.requestId !== 'string'
        || !/^[A-Za-z0-9._:-]{16,256}$/.test(message.requestId)) {
        return false;
    }
    if (message.type === 'file-transfer-history-cleared') {
        return Object.keys(message).sort().join('\n') === ['entries', 'requestId', 'type', 'version'].join('\n')
            && Array.isArray(message.entries) && message.entries.length === 0;
    }
    return message.type === 'file-transfer-history-clear-failed'
        && Object.keys(message).sort().join('\n') === ['message', 'requestId', 'type', 'version'].join('\n')
        && typeof message.message === 'string' && message.message.length <= 320;
}

function initDashboard(options) {
    options = options || {};
    var storageKey = 'agentPivot.activeDashboardTab';
    var scrollPositions = { open: 0, projects: 0, ai: 0, 'file-transfer': 0 };
    var activeTab = normalizeDashboardTab(readDashboardSessionValue(storageKey));
    var pendingScrollRestoreTab = null;
    var panelRequestTimeoutMs = Number(options.panelRequestTimeoutMs) > 0
        ? Number(options.panelRequestTimeoutMs)
        : 5000;
    var scheduleTimeout = options.setTimeout
        || (typeof setTimeout === 'function' ? setTimeout : null);
    var cancelTimeout = options.clearTimeout
        || (typeof clearTimeout === 'function' ? clearTimeout : function () {});
    var catalog = readInitialDashboardSearchCatalog();
    var searchQuery = String(options.initialSearchQuery || '').trim();
    var tabButtons = Array.from(document.querySelectorAll('[data-dashboard-tab]'));
    var panels = {
        open: document.getElementById('dashboard-tab-open'),
        projects: document.getElementById('dashboard-tab-projects'),
        ai: document.getElementById('dashboard-panel-ai'),
        'file-transfer': document.getElementById('dashboard-tab-file-transfer'),
    };
    var tablist = document.querySelector ? document.querySelector('[role="tablist"]') : null;
    var collapseButton = document.querySelector ? document.querySelector('[data-action="toggle-all-groups"]') : null;
    var searchResults = document.getElementById('dashboard-search-results');

    function getTabScrollPort(tab) {
        return panels[normalizeDashboardTab(tab)] || null;
    }

    function readTabScrollPosition(tab) {
        var scrollPort = getTabScrollPort(tab);
        return scrollPort && typeof scrollPort.scrollTop === 'number'
            ? scrollPort.scrollTop
            : 0;
    }

    function restoreScroll(tab) {
        requestAnimationFrame(() => {
            var scrollPort = getTabScrollPort(tab);
            if (scrollPort) {
                scrollPort.scrollTop = scrollPositions[normalizeDashboardTab(tab)] || 0;
            }
        });
    }

    function renderActiveTab() {
        Object.keys(panels).forEach(tab => {
            if (panels[tab]) {
                panels[tab].hidden = tab !== activeTab;
            }
        });
        tabButtons.forEach(button => {
            var selected = normalizeDashboardTab(button.getAttribute('data-dashboard-tab')) === activeTab;
            button.setAttribute('aria-selected', selected ? 'true' : 'false');
            button.setAttribute('tabindex', selected ? '0' : '-1');
            button.classList.toggle('active', selected);
        });
    }

    function renderSearchMode() {
        var active = searchQuery.length > 0;
        if (tablist) {
            tablist.hidden = active;
        }
        if (collapseButton) {
            collapseButton.hidden = active;
        }
        Object.keys(panels).forEach(tab => {
            if (panels[tab]) {
                panels[tab].hidden = active || tab !== activeTab;
            }
        });
        if (searchResults) {
            searchResults.hidden = !active;
        }
        document.body.classList.toggle('dashboard-search-active', active);
        if (active) {
            renderDashboardSearchResults(searchResults, filterDashboardCatalog(catalog, searchQuery));
        }
    }

    function notifyActiveTabChanged() {
        if (typeof options.onActiveTabChanged === 'function') {
            options.onActiveTabChanged(activeTab);
        }
        if (collapseButton && (activeTab === 'ai' || activeTab === 'file-transfer')) {
            collapseButton.disabled = true;
            collapseButton.setAttribute('aria-disabled', 'true');
            const unavailableMessage = activeTab === 'ai'
                ? 'No groups to collapse in AI'
                : 'No groups to collapse in File Transfer';
            collapseButton.setAttribute('title', unavailableMessage);
            collapseButton.setAttribute('aria-label', unavailableMessage);
        }
    }

    function getPanelLoadingElement(tab) {
        var panel = panels[tab];
        if (!panel || !panel.querySelector) {
            return null;
        }
        return panel.querySelector(tab === 'projects'
            ? '.dashboard-projects-loading'
            : '.dashboard-ai-loading');
    }

    function showPanelLoading(tab) {
        var loadingElement = getPanelLoadingElement(tab);
        if (!loadingElement) {
            return;
        }
        loadingElement.textContent = tab === 'projects'
            ? 'Loading projects…'
            : 'Loading AI configuration…';
        loadingElement.hidden = false;
    }

    function showPanelUnavailable(tab) {
        var loadingElement = getPanelLoadingElement(tab);
        if (!loadingElement) {
            return;
        }
        loadingElement.textContent = (tab === 'projects'
            ? 'Projects'
            : 'AI configuration')
            + ' are temporarily unavailable. Select this tab to retry.';
        loadingElement.hidden = false;
    }








    function activateTab(tab, saveScroll) {
        tab = normalizeDashboardTab(tab);
        saveScroll = saveScroll !== false;
        var tabChanged = tab !== activeTab;
        if (tabChanged) {
            if (saveScroll) {
                scrollPositions[activeTab] = readTabScrollPosition(activeTab);
            }
            activeTab = tab;
            writeDashboardSessionValue(storageKey, activeTab);
        }
        renderActiveTab();
        if (searchQuery) {
            renderSearchMode();
            notifyActiveTabChanged();
            return;
        }
        if (activeTab === 'projects') {
            if (projectsPanel.getProjectsState() === 'mounted') {
                if (tabChanged) {
                    restoreScroll('projects');
                }
            } else {
                pendingScrollRestoreTab = 'projects';
                projectsPanel.ensureProjectsPanel();
            }
        } else if (activeTab === 'ai') {
            if (aiPanel.getAiState() === 'mounted') {
                if (tabChanged) {
                    restoreScroll('ai');
                }
            } else {
                pendingScrollRestoreTab = 'ai';
                aiPanel.ensureAiPanel();
            }
        } else if (activeTab === 'file-transfer' && tabChanged) {
            options.postMessage({ type: 'file-transfer-request-history', version: 1 });
        } else if (tabChanged) {
            restoreScroll(activeTab);
        }
        notifyActiveTabChanged();
    }

    function setSearchQuery(query) {
        var nextQuery = String(query || '').trim();
        var wasActive = searchQuery.length > 0;
        if (!wasActive && nextQuery) {
            scrollPositions[activeTab] = readTabScrollPosition(activeTab);
        }
        var queryChanged = nextQuery !== searchQuery;
        searchQuery = nextQuery;
        renderSearchMode();
        if (queryChanged && searchQuery && searchResults) {
            searchResults.scrollTop = 0;
        }
        if (!searchQuery && wasActive) {
            renderActiveTab();
            if (activeTab === 'projects' && projectsPanel.getProjectsState() !== 'mounted') {
                pendingScrollRestoreTab = 'projects';
                projectsPanel.ensureProjectsPanel();
            } else if (activeTab === 'ai' && aiPanel.getAiState() !== 'mounted') {
                pendingScrollRestoreTab = 'ai';
                aiPanel.ensureAiPanel();
            } else {
                restoreScroll(activeTab);
            }
        }
    }

    function replaceSearchCatalog(nextCatalog) {
        var state = replaceDashboardSearchCatalogState({
            activeTab,
            searchQuery,
            scrollPositions,
            catalog,
        }, nextCatalog);
        catalog = state.catalog;
        if (searchQuery) {
            renderDashboardSearchResults(searchResults, filterDashboardCatalog(catalog, searchQuery));
        }
    }

    var pendingSkillReveal = null;

    function onSearchResultClick(event) {
        var button = event.target && event.target.closest
            ? event.target.closest('.dashboard-search-result[data-search-action]')
            : null;
        if (!button) {
            return;
        }
        var action = button.dataset.searchAction;
        if (action === 'resume-session') {
            var provider = button.dataset.provider;
            if (provider !== 'codex' && provider !== 'kimi' && provider !== 'claude') {
                return;
            }
            if (typeof window.__agentPivotAcknowledgeSession === 'function') {
                window.__agentPivotAcknowledgeSession(provider, button.dataset.sessionId);
            }
            options.postMessage({
                type: 'resume-' + provider + '-session',
                provider,
                projectId: button.dataset.projectId,
                sessionId: button.dataset.sessionId,
            });
            return;
        }
        if (action === 'reveal-skill') {
            if (typeof options.clearSearch === 'function') {
                options.clearSearch();
            } else {
                setSearchQuery('');
            }
            pendingSkillReveal = String(button.dataset.skillDir || '');
            activateTab('ai', false);
            if (aiPanel.getAiState() === 'mounted') {
                var revealDir = pendingSkillReveal;
                pendingSkillReveal = null;
                skillPanel.revealSkillCard(revealDir);
            }
            return;
        }
        if (action === 'reveal-workspace-session') {
            if (typeof options.clearSearch === 'function') {
                options.clearSearch();
            } else {
                setSearchQuery('');
            }
            activateTab('open', false);
            if (typeof window.__agentPivotRevealWorkspaceSession === 'function') {
                window.__agentPivotRevealWorkspaceSession(
                    button.dataset.workspaceNavigationIdentity,
                    button.dataset.provider,
                    button.dataset.sessionId
                );
            }
            return;
        }
        if (action === 'reveal-workspace-worktree') {
            if (typeof options.clearSearch === 'function') {
                options.clearSearch();
            } else {
                setSearchQuery('');
            }
            activateTab('open', false);
            if (typeof window.__agentPivotRevealWorkspaceWorktree === 'function') {
                window.__agentPivotRevealWorkspaceWorktree(
                    button.dataset.workspaceNavigationIdentity,
                    button.dataset.repositoryKey,
                    button.dataset.worktreePath
                );
            } else if (typeof window.__agentPivotRevealWorkspace === 'function') {
                window.__agentPivotRevealWorkspace(button.dataset.workspaceNavigationIdentity);
            }
            return;
        }
        if (action === 'show-current-workspace') {
            if (typeof options.clearSearch === 'function') {
                options.clearSearch();
            } else {
                setSearchQuery('');
            }
            activateTab('open', false);
            if (typeof window.__agentPivotRevealWorkspace === 'function') {
                window.__agentPivotRevealWorkspace(button.dataset.workspaceNavigationIdentity);
            }
            return;
        }
        if (action === 'switch-open-workspace') {
            options.postMessage({
                type: 'selected-workspace',
                workspaceId: button.dataset.workspaceId,
                navigationIdentity: button.dataset.workspaceNavigationIdentity,
            });
            return;
        }
        if (action === 'open-saved-project') {
            options.postMessage({
                type: 'selected-project',
                projectId: button.dataset.projectId,
                projectOpenType: 0,
            });
            return;
        }
        if (action === 'open-managed-project') {
            options.postMessage({
                type: 'managed-remote-client-action',
                version: 1,
                requestId: 'managed-search-' + Date.now(),
                action: 'openProject',
                expectedRevisionId: button.dataset.expectedRevisionId || null,
                targetId: button.dataset.projectId,
            });
            return;
        }
    }

    var skillPanel = initSkillPanel({
        postMessage: options.postMessage,
        aiPanel: panels.ai,
    });
    var projectsPanel = createDashboardProjectsPanel({
        options: options,
        panels: panels,
        scheduleTimeout: scheduleTimeout,
        cancelTimeout: cancelTimeout,
        panelRequestTimeoutMs: panelRequestTimeoutMs,
        showPanelLoading: showPanelLoading,
        showPanelUnavailable: showPanelUnavailable,
        restoreScroll: restoreScroll,
        replaceSearchCatalog: replaceSearchCatalog,
        getActiveTab: () => activeTab,
        getSearchQuery: () => searchQuery,
        getPendingScrollRestoreTab: () => pendingScrollRestoreTab,
        setPendingScrollRestoreTab: value => { pendingScrollRestoreTab = value; },
    });
    var aiPanel = createDashboardAiPanel({
        options: options,
        panels: panels,
        scheduleTimeout: scheduleTimeout,
        cancelTimeout: cancelTimeout,
        panelRequestTimeoutMs: panelRequestTimeoutMs,
        showPanelLoading: showPanelLoading,
        showPanelUnavailable: showPanelUnavailable,
        restoreScroll: restoreScroll,
        replaceSearchCatalog: replaceSearchCatalog,
        getActiveTab: () => activeTab,
        getSearchQuery: () => searchQuery,
        getPendingScrollRestoreTab: () => pendingScrollRestoreTab,
        setPendingScrollRestoreTab: value => { pendingScrollRestoreTab = value; },
        skillPanel: skillPanel,
        getPendingSkillReveal: () => pendingSkillReveal,
        setPendingSkillReveal: value => { pendingSkillReveal = value; },
    });

    function initializeFileTransferPanel() {
        var panel = panels['file-transfer'];
        if (!panel || !panel.querySelectorAll) {
            return;
        }
        var selectors = Array.from(panel.querySelectorAll('[data-file-transfer-endpoint]'));
        var swap = panel.querySelector('[data-file-transfer-swap]');
        var panes = {
            left: panel.querySelector('[data-file-transfer-pane="left"]'),
            right: panel.querySelector('[data-file-transfer-pane="right"]'),
        };
        var hint = panel.querySelector('[data-file-transfer-pair-hint]');
        var summary = panel.querySelector('[data-file-transfer-summary]');
        var review = panel.querySelector('[data-file-transfer-review]');
        var tasks = panel.querySelector('[data-file-transfer-tasks]');
        var taskStatus = panel.querySelector('[data-file-transfer-task-status]');
        var retry = panel.querySelector('[data-file-transfer-retry]');
        var taskList = panel.querySelector('[data-file-transfer-task-list]');
        var historyList = panel.querySelector('[data-file-transfer-history-list]');
        var clearHistory = panel.querySelector('[data-file-transfer-clear-history]');
        var reviewSheet = panel.querySelector('[data-file-transfer-review-sheet]');
        var reviewSummary = panel.querySelector('[data-file-transfer-review-summary]');
        var reviewSize = panel.querySelector('[data-file-transfer-review-size]');
        var reviewItems = panel.querySelector('[data-file-transfer-review-items]');
        var conflictPolicy = panel.querySelector('[data-file-transfer-conflict-policy]');
        var reviewCancel = panel.querySelector('[data-file-transfer-review-cancel]');
        var startCopy = panel.querySelector('[data-file-transfer-start-copy]');
        var localRoots = { left: null, right: null };
        var paneFailures = { left: null, right: null };
        var pendingLocalRootRequests = { left: null, right: null };
        var selectedEntries = { left: new Set(), right: new Set() };
        var directoryHistory = { left: [], right: [] };
        var fileTransferSort = { left: 'name', right: 'name' };
        var showHiddenEntries = { left: false, right: false };
        var pendingCopyRequestId = null;
        var activeCopyTaskId = null;
        var pendingCopyItemCount = 0;
        var pendingCopyPlan = null;
        var lastFailedCopyPlan = null;
        var transferTasks = {};
        var pendingHistoryClearRequestId = null;

        function renderTaskCount() {
            if (!tasks) return;
            tasks.disabled = !activeCopyTaskId;
            tasks.title = !activeCopyTaskId
                ? 'Transfer tasks will appear here'
                : 'Cancel the active file copy';
            var count = tasks.querySelector ? tasks.querySelector('span') : null;
            if (count) count.textContent = String(Object.keys(transferTasks).length);
            renderTaskList();
        }

        function renderTaskList() {
            if (!taskList) return;
            var taskIds = Object.keys(transferTasks);
            taskList.textContent = '';
            taskList.hidden = taskIds.length === 0;
            taskIds.forEach(function (taskId) {
                var task = transferTasks[taskId];
                var row = document.createElement('li');
                var label = document.createElement('span');
                label.textContent = task.status === 'running'
                    ? 'Copying ' + task.itemCount + ' item(s)'
                    : task.status === 'cancelling'
                        ? 'Cancelling ' + task.itemCount + ' item(s)'
                        : 'Queued · ' + task.itemCount + ' item(s)';
                row.appendChild(label);
                var cancel = document.createElement('button');
                cancel.type = 'button';
                cancel.textContent = 'Cancel';
                cancel.addEventListener('click', function () { requestTaskCancellation(taskId); });
                row.appendChild(cancel);
                taskList.appendChild(row);
            });
        }

        function renderTaskStatus(message) {
            if (!taskStatus) return;
            taskStatus.hidden = !message;
            taskStatus.textContent = message || '';
        }

        function renderHistory(entries) {
            if (!historyList) return false;
            historyList.textContent = '';
            if (!entries.length) {
                var empty = document.createElement('li');
                empty.textContent = 'No completed transfers yet.';
                historyList.appendChild(empty);
                if (clearHistory) clearHistory.disabled = true;
                return true;
            }
            entries.forEach(function (entry) {
                var row = document.createElement('li');
                var detail = entry.status === 'copied'
                    ? 'Copied ' + (entry.completedItems === undefined ? entry.itemCount : entry.completedItems)
                        + (entry.skippedItems ? ', skipped ' + entry.skippedItems : '')
                    : entry.status === 'cancelled'
                        ? 'Cancelled after ' + (entry.completedItems || 0) + ' copied'
                    : 'Failed';
                row.textContent = detail + ' · ' + entry.itemCount + ' item(s) · ' + entry.conflictPolicy;
                historyList.appendChild(row);
            });
            if (clearHistory) clearHistory.disabled = !!pendingHistoryClearRequestId;
            return true;
        }

        function applyHistory(message) {
            return renderHistory(message.entries);
        }

        function requestHistoryClear() {
            if (pendingHistoryClearRequestId || !clearHistory || clearHistory.disabled) return;
            var requestId = 'file-transfer-history-clear-' + Date.now() + '-'
                + Math.random().toString(16).slice(2, 18);
            pendingHistoryClearRequestId = requestId;
            clearHistory.disabled = true;
            options.postMessage({ type: 'file-transfer-clear-history', version: 1, requestId: requestId });
        }

        function applyHistoryClearSettlement(message) {
            if (message.requestId !== pendingHistoryClearRequestId) return false;
            pendingHistoryClearRequestId = null;
            if (message.type === 'file-transfer-history-cleared') {
                renderHistory(message.entries);
            } else {
                if (clearHistory) clearHistory.disabled = false;
                renderTaskStatus('Could not clear transfer history: ' + message.message);
            }
            return true;
        }

        function selectorFor(side) {
            return selectors.find(function (selector) {
                return selector.getAttribute('data-file-transfer-endpoint') === side;
            }) || null;
        }

        function updatePane(side, selector) {
            var pane = panes[side];
            if (!pane || !selector) {
                return;
            }
            var name = pane.querySelector('[data-file-transfer-pane-name]');
            var path = pane.querySelector('[data-file-transfer-pane-path]');
            var status = pane.querySelector('[data-file-transfer-pane-status]');
            var refresh = pane.querySelector('[data-file-transfer-refresh]');
            var up = pane.querySelector('[data-file-transfer-up]');
            var showHidden = pane.querySelector('[data-file-transfer-show-hidden]');
            var sort = pane.querySelector('[data-file-transfer-sort]');
            var fileList = pane.querySelector('[data-file-transfer-file-list]');
            var option = selector.options && selector.selectedIndex >= 0
                ? selector.options[selector.selectedIndex] : null;
            var value = selector.value || '';
            if (!value) {
                if (name) name.textContent = 'Choose an endpoint';
                if (path) path.textContent = '—';
                if (status) status.textContent = 'Choose an endpoint to browse its files.';
                if (refresh) refresh.disabled = true;
                if (up) up.disabled = true;
                if (showHidden) showHidden.disabled = true;
                if (sort) sort.disabled = true;
                if (fileList) {
                    fileList.textContent = '';
                    fileList.hidden = true;
                }
                return;
            }
            if (name) name.textContent = option ? option.textContent : 'Selected endpoint';
            var directoryView = localRoots[side];
            var visibleEntries = directoryView ? directoryView.entries.filter(function (entry) {
                return showHiddenEntries[side] || entry.name.charAt(0) !== '.';
            }) : [];
            if (showHidden) {
                showHidden.disabled = !directoryView;
                showHidden.checked = showHiddenEntries[side];
            }
            if (sort) {
                sort.disabled = !directoryView;
                sort.value = fileTransferSort[side];
            }
            if (path) path.textContent = directoryView ? directoryView.label + ' / ' + directoryView.displayPath
                : value === 'local' ? 'Choose a local folder' : 'Managed Machine';
            if (status) {
                status.textContent = paneFailures[side]
                    ? paneFailures[side] + ' Select Refresh to try again.'
                    : directoryView
                    ? (showHiddenEntries[side] || visibleEntries.length === directoryView.entries.length
                        ? visibleEntries.length + ' items'
                        : visibleEntries.length + ' of ' + directoryView.entries.length + ' items') + (value === 'local'
                        ? ' in this approved local folder.'
                        : ' in this Managed Machine directory.')
                    : value === 'local' && pendingLocalRootRequests[side]
                        ? 'Opening the local folder chooser…'
                    : value.indexOf('managed:') === 0 && pendingLocalRootRequests[side]
                        ? 'Opening the Managed Machine directory…'
                    : value === 'local'
                        ? 'Choose a local folder to begin browsing.'
                    : 'Managed Machine selected. File browsing will be enabled by the local UI Bridge.';
            }
            if (fileList) {
                renderLocalFileTransferEntries(
                    fileList,
                    sortFileTransferEntries(visibleEntries, fileTransferSort[side]),
                    selectedEntries[side],
                    function (entryId, selected) { updateSelection(side, entryId, selected); },
                    function (directoryId) { openDirectory(side, directoryId); },
                );
                fileList.hidden = !directoryView;
            }
            if (refresh) refresh.disabled = !directoryView && !paneFailures[side];
            if (up) up.disabled = !directoryView || directoryHistory[side].length === 0;
        }

        function updatePair() {
            var left = selectorFor('left');
            var right = selectorFor('right');
            if (left && right && left.value && left.value === right.value) {
                right.value = '';
                if (hint) hint.textContent = 'Choose two different endpoints.';
            } else if (left && right && left.value && right.value) {
                if (hint) hint.textContent = 'Endpoints are paired. Select files in either pane to choose a copy direction.';
            } else if (hint) {
                hint.textContent = 'Select two endpoints. They are equal until you select files to copy.';
            }
            updatePane('left', left);
            updatePane('right', right);
            var sourceSide = selectedEntries.left.size ? 'left'
                : selectedEntries.right.size ? 'right' : null;
            var count = sourceSide ? selectedEntries[sourceSide].size : 0;
            if (summary) summary.textContent = sourceSide
                ? 'Copy ' + count + ' selected item' + (count === 1 ? '' : 's')
                    + ' to the ' + (sourceSide === 'left' ? 'right' : 'left') + ' endpoint.'
                : 'Select files in either pane to choose a copy direction.';
            if (review) review.disabled = !!pendingCopyRequestId
                || !sourceSide || !left || !right || !left.value || !right.value;
        }

        function updateSelection(side, entryId, selected) {
            var otherSide = side === 'left' ? 'right' : 'left';
            selectedEntries[otherSide].clear();
            if (selected) selectedEntries[side].add(entryId);
            else selectedEntries[side].delete(entryId);
            updatePair();
        }

        function requestLocalRoot(side) {
            var requestId = 'file-transfer-' + side + '-' + Date.now() + '-'
                + Math.random().toString(16).slice(2, 18);
            pendingLocalRootRequests[side] = requestId;
            options.postMessage({
                type: 'file-transfer-select-local-root',
                version: 1,
                requestId: requestId,
                side: side,
            });
        }

        function requestRemoteDirectory(side, machineId) {
            var requestId = 'file-transfer-' + side + '-' + Date.now() + '-'
                + Math.random().toString(16).slice(2, 18);
            pendingLocalRootRequests[side] = requestId;
            options.postMessage({
                type: 'file-transfer-list-remote-directory',
                version: 1,
                requestId: requestId,
                side: side,
                machineId: machineId,
            });
        }

        function openDirectory(side, directoryId, remember) {
            var selector = selectorFor(side);
            var root = localRoots[side];
            if (!selector || !root || !directoryId) return;
            if (remember !== false && root.directoryId !== directoryId) {
                directoryHistory[side].push(root);
            }
            var requestId = 'file-transfer-open-' + side + '-' + Date.now() + '-'
                + Math.random().toString(16).slice(2, 18);
            pendingLocalRootRequests[side] = requestId;
            selectedEntries[side].clear();
            if (selector.value === 'local') {
                options.postMessage({
                    type: 'file-transfer-open-directory',
                    version: 1,
                    requestId: requestId,
                    side: side,
                    endpoint: { kind: 'local', rootId: root.rootId, directoryId: directoryId },
                });
            } else if (selector.value.indexOf('managed:') === 0) {
                options.postMessage({
                    type: 'file-transfer-open-directory',
                    version: 1,
                    requestId: requestId,
                    side: side,
                    endpoint: {
                        kind: 'managedMachine',
                        machineId: selector.value.slice('managed:'.length),
                        directoryId: directoryId,
                    },
                });
            }
            updatePair();
        }

        function onEndpointChange(event) {
            var selector = event.currentTarget;
            var side = selector && selector.getAttribute
                ? selector.getAttribute('data-file-transfer-endpoint') : null;
            if (side !== 'left' && side !== 'right') {
                return;
            }
            localRoots[side] = null;
            paneFailures[side] = null;
            pendingLocalRootRequests[side] = null;
            selectedEntries[side].clear();
            directoryHistory[side] = [];
            if (reviewSheet) reviewSheet.hidden = true;
            if (selector.value === 'local') {
                requestLocalRoot(side);
            } else if (selector.value.indexOf('managed:') === 0) {
                requestRemoteDirectory(side, selector.value.slice('managed:'.length));
            }
            updatePair();
        }

        function swapEndpointLayout() {
            var left = selectorFor('left');
            var right = selectorFor('right');
            if (!left || !right || pendingLocalRootRequests.left || pendingLocalRootRequests.right) return;
            var leftValue = left.value;
            left.value = right.value;
            right.value = leftValue;
            var leftRoot = localRoots.left;
            localRoots.left = localRoots.right;
            localRoots.right = leftRoot;
            var leftSelection = selectedEntries.left;
            selectedEntries.left = selectedEntries.right;
            selectedEntries.right = leftSelection;
            var leftHistory = directoryHistory.left;
            directoryHistory.left = directoryHistory.right;
            directoryHistory.right = leftHistory;
            var leftSort = fileTransferSort.left;
            fileTransferSort.left = fileTransferSort.right;
            fileTransferSort.right = leftSort;
            var leftShowHidden = showHiddenEntries.left;
            showHiddenEntries.left = showHiddenEntries.right;
            showHiddenEntries.right = leftShowHidden;
            var leftFailure = paneFailures.left;
            paneFailures.left = paneFailures.right;
            paneFailures.right = leftFailure;
            updatePair();
        }

        function applyLocalRootMessage(message) {
            if (!message || (message.side !== 'left' && message.side !== 'right')
                || pendingLocalRootRequests[message.side] !== message.requestId) {
                return false;
            }
            pendingLocalRootRequests[message.side] = null;
            if (message.type === 'file-transfer-local-root-selected' && message.root) {
                localRoots[message.side] = message.root;
                paneFailures[message.side] = null;
            } else if (message.type === 'file-transfer-local-root-failed'
                || message.type === 'file-transfer-remote-directory-failed') {
                localRoots[message.side] = null;
                paneFailures[message.side] = message.message || 'Could not open this endpoint.';
            } else {
                var selector = selectorFor(message.side);
                if (selector) selector.value = '';
                localRoots[message.side] = null;
                paneFailures[message.side] = null;
            }
            updatePair();
            return true;
        }

        function endpointReference(side) {
            var selector = selectorFor(side);
            var root = localRoots[side];
            if (!selector || !root) return null;
            if (selector.value === 'local') {
                return { kind: 'local', rootId: root.rootId, directoryId: root.directoryId };
            }
            if (selector.value.indexOf('managed:') === 0) {
                return {
                    kind: 'managedMachine',
                    machineId: selector.value.slice('managed:'.length),
                    directoryId: root.directoryId,
                };
            }
            return null;
        }

        function selectedSourceSide() {
            return selectedEntries.left.size ? 'left' : selectedEntries.right.size ? 'right' : null;
        }

        function selectedEntryDetails(side) {
            var root = localRoots[side];
            var entries = root && Array.isArray(root.entries) ? root.entries : [];
            return Array.from(selectedEntries[side]).map(function (entryId) {
                return entries.find(function (entry) { return entry.id === entryId; }) || null;
            }).filter(Boolean);
        }

        function renderReviewItems(entries) {
            if (!reviewItems) return;
            reviewItems.textContent = '';
            entries.slice(0, 5).forEach(function (entry) {
                var item = document.createElement('li');
                item.textContent = entry.name + (entry.kind === 'directory' ? ' (folder)' : '');
                reviewItems.appendChild(item);
            });
            if (entries.length > 5) {
                var more = document.createElement('li');
                more.textContent = 'and ' + (entries.length - 5) + ' more item(s)';
                reviewItems.appendChild(more);
            }
        }

        function openReview() {
            var sourceSide = selectedSourceSide();
            if (!sourceSide || !reviewSheet) return;
            var destinationSide = sourceSide === 'left' ? 'right' : 'left';
            var source = selectorFor(sourceSide);
            var destination = selectorFor(destinationSide);
            if (!source || !destination || !source.value || !destination.value) return;
            var entries = selectedEntryDetails(sourceSide);
            var knownBytes = entries.reduce(function (total, entry) {
                return total + (Number.isSafeInteger(entry.size) ? entry.size : 0);
            }, 0);
            var unknownSizeCount = entries.filter(function (entry) {
                return !Number.isSafeInteger(entry.size);
            }).length;
            if (reviewSummary) {
                reviewSummary.textContent = 'Copy ' + selectedEntries[sourceSide].size + ' item(s) from '
                    + source.options[source.selectedIndex].textContent + ' / '
                    + (localRoots[sourceSide] ? localRoots[sourceSide].displayPath : '.') + ' to '
                    + destination.options[destination.selectedIndex].textContent + ' / '
                    + (localRoots[destinationSide] ? localRoots[destinationSide].displayPath : '.') + '.';
            }
            if (reviewSize) {
                reviewSize.textContent = unknownSizeCount
                    ? 'Known size: ' + formatFileTransferBytes(knownBytes) + '. '
                        + unknownSizeCount + ' folder or item size will be determined during copy.'
                    : 'Total size: ' + formatFileTransferBytes(knownBytes) + '.';
            }
            renderReviewItems(entries);
            reviewSheet.hidden = false;
        }

        function closeReview() {
            if (reviewSheet) reviewSheet.hidden = true;
        }

        function startReviewedCopy() {
            var sourceSide = selectedSourceSide();
            if (!sourceSide || pendingCopyRequestId) return;
            var destinationSide = sourceSide === 'left' ? 'right' : 'left';
            var source = endpointReference(sourceSide);
            var destination = endpointReference(destinationSide);
            if (!source || !destination) return;
            submitCopyPlan({
                source: source,
                destination: destination,
                entryIds: Array.from(selectedEntries[sourceSide]),
                conflictPolicy: conflictPolicy ? conflictPolicy.value : 'fail',
            });
        }

        function submitCopyPlan(plan) {
            if (!plan || pendingCopyRequestId) return;
            var requestId = 'file-transfer-copy-' + Date.now() + '-'
                + Math.random().toString(16).slice(2, 18);
            pendingCopyRequestId = requestId;
            pendingCopyItemCount = plan.entryIds.length;
            pendingCopyPlan = {
                source: plan.source, destination: plan.destination,
                entryIds: plan.entryIds.slice(), conflictPolicy: plan.conflictPolicy,
            };
            if (startCopy) startCopy.disabled = true;
            if (retry) retry.hidden = true;
            options.postMessage({
                type: 'file-transfer-copy',
                version: 1,
                requestId: requestId,
                source: pendingCopyPlan.source,
                destination: pendingCopyPlan.destination,
                entryIds: pendingCopyPlan.entryIds,
                conflictPolicy: pendingCopyPlan.conflictPolicy,
            });
        }

        function applyCopySettlement(message) {
            if (message.requestId !== pendingCopyRequestId && !transferTasks[message.requestId]) return false;
            var wasPending = message.requestId === pendingCopyRequestId;
            var task = transferTasks[message.requestId]
                || (wasPending ? { plan: pendingCopyPlan, itemCount: pendingCopyItemCount } : null);
            if (wasPending) {
                pendingCopyRequestId = null;
                pendingCopyItemCount = 0;
                pendingCopyPlan = null;
            }
            if (activeCopyTaskId === message.requestId) activeCopyTaskId = null;
            delete transferTasks[message.requestId];
            renderTaskCount();
            if (startCopy && !pendingCopyRequestId) startCopy.disabled = false;
            if (message.status === 'copied') {
                var completed = message.value && Number.isSafeInteger(message.value.completedItems)
                    ? message.value.completedItems : 0;
                var skipped = message.value && Number.isSafeInteger(message.value.skippedItems)
                    ? message.value.skippedItems : 0;
                renderTaskStatus('Copy complete: ' + completed + ' copied'
                    + (skipped ? ', ' + skipped + ' skipped.' : '.'));
                if (wasPending) closeReview();
                if (task && task.plan === lastFailedCopyPlan) {
                    lastFailedCopyPlan = null;
                    if (retry) retry.hidden = true;
                }
                updatePair();
            } else if (message.status === 'cancelled') {
                var cancelledAfter = message.value && Number.isSafeInteger(message.value.completedItems)
                    ? message.value.completedItems : 0;
                renderTaskStatus('Copy cancelled after ' + cancelledAfter + ' item(s).');
                if (wasPending && reviewSummary) {
                    reviewSummary.textContent = 'Copy cancelled. Your selection is still available to retry.';
                }
            } else {
                renderTaskStatus('Copy failed: ' + (message.message || 'File copy failed.'));
                lastFailedCopyPlan = task && task.plan ? task.plan : null;
                if (retry) retry.hidden = !lastFailedCopyPlan;
                if (wasPending && reviewSummary) {
                    reviewSummary.textContent = message.message || 'File copy failed.';
                }
            }
            options.postMessage({ type: 'file-transfer-request-history', version: 1 });
            return true;
        }

        function applyCopyStarted(message) {
            var task = transferTasks[message.requestId];
            if (!task) return false;
            activeCopyTaskId = message.requestId;
            task.status = 'running';
            renderTaskCount();
            renderTaskStatus('Copying ' + task.itemCount + ' item(s). Select Transfers to cancel.');
            updatePair();
            return true;
        }

        function applyCopyQueued(message) {
            if (message.requestId !== pendingCopyRequestId) return false;
            transferTasks[message.requestId] = {
                status: 'queued', itemCount: pendingCopyItemCount, plan: pendingCopyPlan,
            };
            pendingCopyRequestId = null;
            pendingCopyItemCount = 0;
            pendingCopyPlan = null;
            if (startCopy) startCopy.disabled = false;
            selectedEntries.left.clear();
            selectedEntries.right.clear();
            closeReview();
            renderTaskStatus('Copy queued in position ' + message.position + '.');
            renderTaskCount();
            updatePair();
            return true;
        }

        function requestTaskCancellation(taskId) {
            var task = transferTasks[taskId];
            if (!task) return;
            task.status = 'cancelling';
            if (taskId === activeCopyTaskId) {
                renderTaskStatus('Cancelling copy…');
            }
            renderTaskCount();
            options.postMessage({ type: 'file-transfer-cancel-copy', version: 1, taskId: taskId });
        }

        function retryFailedCopy() {
            if (!lastFailedCopyPlan || pendingCopyRequestId) return;
            renderTaskStatus('Revalidating failed items before retry…');
            var plan = lastFailedCopyPlan;
            lastFailedCopyPlan = null;
            submitCopyPlan(plan);
        }

        selectors.forEach(function (selector) {
            selector.addEventListener('change', onEndpointChange);
        });
        if (swap) swap.addEventListener('click', swapEndpointLayout);
        if (review) review.addEventListener('click', openReview);
        if (reviewCancel) reviewCancel.addEventListener('click', closeReview);
        if (startCopy) startCopy.addEventListener('click', startReviewedCopy);
        if (retry) retry.addEventListener('click', retryFailedCopy);
        if (clearHistory) clearHistory.addEventListener('click', requestHistoryClear);
        Array.from(panel.querySelectorAll('[data-file-transfer-show-hidden]')).forEach(function (checkbox) {
            checkbox.addEventListener('change', function () {
                var side = checkbox.getAttribute('data-file-transfer-show-hidden');
                if (side !== 'left' && side !== 'right') return;
                showHiddenEntries[side] = checkbox.checked;
                if (!showHiddenEntries[side] && localRoots[side]) {
                    localRoots[side].entries.forEach(function (entry) {
                        if (entry.name.charAt(0) === '.') selectedEntries[side].delete(entry.id);
                    });
                }
                updatePair();
            });
        });
        Array.from(panel.querySelectorAll('[data-file-transfer-sort]')).forEach(function (select) {
            select.addEventListener('change', function () {
                var side = select.getAttribute('data-file-transfer-sort');
                if (side !== 'left' && side !== 'right') return;
                if (!['name', 'type', 'modified', 'size'].includes(select.value)) return;
                fileTransferSort[side] = select.value;
                updatePair();
            });
        });
        Array.from(panel.querySelectorAll('[data-file-transfer-refresh]')).forEach(function (button) {
            button.addEventListener('click', function () {
                var side = button.getAttribute('data-file-transfer-refresh');
                var root = side === 'left' || side === 'right' ? localRoots[side] : null;
                if (root) {
                    openDirectory(side, root.directoryId, false);
                    return;
                }
                var selector = side === 'left' || side === 'right' ? selectorFor(side) : null;
                if (!selector || !paneFailures[side]) return;
                if (selector.value === 'local') requestLocalRoot(side);
                else if (selector.value.indexOf('managed:') === 0) {
                    requestRemoteDirectory(side, selector.value.slice('managed:'.length));
                }
            });
        });
        Array.from(panel.querySelectorAll('[data-file-transfer-up]')).forEach(function (button) {
            button.addEventListener('click', function () {
                var side = button.getAttribute('data-file-transfer-up');
                if (side !== 'left' && side !== 'right') return;
                var previous = directoryHistory[side].pop();
                if (previous) openDirectory(side, previous.directoryId, false);
            });
        });
        if (tasks) tasks.addEventListener('click', function () {
            if (!activeCopyTaskId) return;
            tasks.disabled = true;
            requestTaskCancellation(activeCopyTaskId);
        });
        renderTaskCount();
        updatePair();

        return {
            applyLocalRootMessage: applyLocalRootMessage,
            applyCopySettlement: applyCopySettlement,
            applyCopyStarted: applyCopyStarted,
            applyCopyQueued: applyCopyQueued,
            applyHistory: applyHistory,
            applyHistoryClearSettlement: applyHistoryClearSettlement,
        };
    }
    var fileTransferPanel = initializeFileTransferPanel();













    tabButtons.forEach(button => {
        button.addEventListener('click', () => {
            activateTab(button.getAttribute('data-dashboard-tab'));
        });
        button.addEventListener('keydown', event => {
            var tab = normalizeDashboardTab(button.getAttribute('data-dashboard-tab'));
            if (event.key === 'ArrowLeft'
                || event.key === 'ArrowRight'
                || event.key === 'Home'
                || event.key === 'End') {
                event.preventDefault();
                var adjacentTab = getAdjacentDashboardTab(tab, event.key);
                var adjacentButton = tabButtons.find(candidate =>
                    normalizeDashboardTab(candidate.getAttribute('data-dashboard-tab')) === adjacentTab
                );
                if (adjacentButton) {
                    adjacentButton.focus();
                }
                return;
            }
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                activateTab(tab);
            }
        });
    });

    window.addEventListener('message', event => {
        if (event && event.data && event.data.type === 'projects-panel-content') {
            projectsPanel.applyProjectsPanelMessage(event.data);
        }
        if (event && event.data && event.data.type === 'projects-panel-updated') {
            if (validateProjectsPanelUpdatedMessage(event.data)
                && event.data.sequence <= projectsPanel.getAcceptedProjectsUpdateSequence()) {
                return;
            }
            if (!projectsPanel.applyProjectsPanelUpdatedMessage(event.data)) {
                options.postMessage({
                    type: 'request-full-refresh',
                    reason: 'invalid-projects-panel-update',
                });
            }
        }
        if (event && event.data && event.data.type === 'ai-panel-content') {
            aiPanel.applyAiPanelMessage(event.data);
        }
        if (event && event.data && event.data.type === 'prompt-panel-updated') {
            aiPanel.applyPromptPanelUpdatedMessage(event.data);
        }
        if (event && event.data && event.data.type === 'skills-updated') {
            skillPanel.replaceSkillsHtml(event.data.html, event.data.settlement);
        }
        if (event && event.data && event.data.type === 'skill-scope-action-result') {
            skillPanel.settleSkillScopeActionWithoutHtml(event.data);
        }
        if (event && event.data && validateFileTransferLocalRootMessage(event.data)
            && fileTransferPanel) {
            fileTransferPanel.applyLocalRootMessage(event.data);
        }
        if (event && event.data && validateFileTransferCopySettlement(event.data)
            && fileTransferPanel) {
            fileTransferPanel.applyCopySettlement(event.data);
        }
        if (event && event.data && validateFileTransferCopyStarted(event.data)
            && fileTransferPanel) {
            fileTransferPanel.applyCopyStarted(event.data);
        }
        if (event && event.data && validateFileTransferCopyQueued(event.data)
            && fileTransferPanel) {
            fileTransferPanel.applyCopyQueued(event.data);
        }
        if (event && event.data && validateFileTransferHistory(event.data)
            && fileTransferPanel) {
            fileTransferPanel.applyHistory(event.data);
        }
        if (event && event.data && validateFileTransferHistoryClearSettlement(event.data)
            && fileTransferPanel) {
            fileTransferPanel.applyHistoryClearSettlement(event.data);
        }
        if (event && event.data
            && event.data.type === 'select-dashboard-tab'
            && event.data.version === 1
            && event.data.tab === 'ai'
            && event.data.aiSubtab === 'prompts') {
            if (searchQuery && typeof options.clearSearch === 'function') {
                options.clearSearch();
            }
            if (searchQuery) {
                setSearchQuery('');
            }
            aiPanel.setPendingAiSubtab('prompts');
            activateTab('ai');
            aiPanel.applyPendingAiSubtab();
        }
        if (event && event.data
            && event.data.type === 'reveal-workspace-worktree-requested'
            && event.data.version === 1
            && Object.keys(event.data).length === 5
            && typeof event.data.navigationIdentity === 'string'
            && event.data.navigationIdentity
            && typeof event.data.repositoryKey === 'string'
            && event.data.repositoryKey
            && typeof event.data.canonicalWorktreePath === 'string'
            && event.data.canonicalWorktreePath) {
            if (searchQuery && typeof options.clearSearch === 'function') {
                options.clearSearch();
            }
            if (searchQuery) {
                setSearchQuery('');
            }
            activateTab('open', false);
            if (typeof window.__agentPivotRevealWorkspaceWorktree === 'function') {
                window.__agentPivotRevealWorkspaceWorktree(
                    event.data.navigationIdentity,
                    event.data.repositoryKey,
                    event.data.canonicalWorktreePath
                );
            }
        }
    });
    if (searchResults) {
        searchResults.addEventListener('click', onSearchResultClick);
    }
    renderActiveTab();
    if (searchQuery) {
        renderSearchMode();
    } else if (activeTab === 'projects') {
        pendingScrollRestoreTab = 'projects';
        projectsPanel.ensureProjectsPanel();
    } else if (activeTab === 'ai') {
        pendingScrollRestoreTab = 'ai';
        aiPanel.ensureAiPanel();
    } else if (activeTab === 'file-transfer') {
        options.postMessage({ type: 'file-transfer-request-history', version: 1 });
    }
    document.body.classList.remove('preload');
    notifyActiveTabChanged();

    return {
        activateTab,
        applyProjectsPanelMessage: projectsPanel.applyProjectsPanelMessage,
        applyProjectsPanelUpdatedMessage: projectsPanel.applyProjectsPanelUpdatedMessage,
        applyAiPanelMessage: aiPanel.applyAiPanelMessage,
        applyPromptPanelUpdatedMessage: aiPanel.applyPromptPanelUpdatedMessage,
        applyFileTransferLocalRootMessage: fileTransferPanel
            ? fileTransferPanel.applyLocalRootMessage : function () { return false; },
        applyFileTransferCopySettlement: fileTransferPanel
            ? fileTransferPanel.applyCopySettlement : function () { return false; },
        applyFileTransferCopyStarted: fileTransferPanel
            ? fileTransferPanel.applyCopyStarted : function () { return false; },
        applyFileTransferCopyQueued: fileTransferPanel
            ? fileTransferPanel.applyCopyQueued : function () { return false; },
        applyFileTransferHistory: fileTransferPanel
            ? fileTransferPanel.applyHistory : function () { return false; },
        applyFileTransferHistoryClearSettlement: fileTransferPanel
            ? fileTransferPanel.applyHistoryClearSettlement : function () { return false; },
        ensureProjectsPanel: projectsPanel.ensureProjectsPanel,
        ensureAiPanel: aiPanel.ensureAiPanel,
        getActiveTab: () => activeTab,
        getProjectsState: projectsPanel.getProjectsState,
        getAiState: aiPanel.getAiState,
        getScrollPosition: tab => scrollPositions[normalizeDashboardTab(tab)],
        isSearchActive: () => searchQuery.length > 0,
        replaceSearchCatalog,
        setSearchQuery,
    };
}
