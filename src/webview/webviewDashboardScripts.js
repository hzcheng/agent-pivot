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

function renderLocalFileTransferEntries(
    fileList,
    entries,
    selectedIds,
    onChange,
    onOpenDirectory,
    onDragStart,
    onDragEnd,
) {
    fileList.textContent = '';
    entries.forEach(function (entry) {
        var row = document.createElement('li');
        row.className = 'file-transfer-file-row';
        if (entry.kind === 'symlink' || entry.kind === 'unsupported') {
            row.className += ' is-unsupported';
        }
        row.setAttribute('data-file-transfer-entry-id', entry.id);
        if (entry.kind === 'directory') {
            row.title = 'Open this folder';
            row.addEventListener('click', function (event) {
                var target = event.target;
                if (target && typeof target.closest === 'function' && target.closest('input')) return;
                onOpenDirectory(entry.id);
            });
        }
        if (entry.kind === 'directory' || entry.kind === 'file') {
            row.draggable = true;
            row.addEventListener('dragstart', function (event) { onDragStart(entry.id, event); });
            row.addEventListener('dragend', onDragEnd);
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
        && Object.keys(root).sort().join('\n') === (root.hasMore === undefined
            ? ['directoryId', 'displayPath', 'entries', 'label', 'rootId']
            : ['directoryId', 'displayPath', 'entries', 'hasMore', 'label', 'rootId']).join('\n')
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
        && (root.hasMore === undefined || typeof root.hasMore === 'boolean')
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
    if (message.status === 'failed' && message.value && typeof message.value === 'object'
        && !Array.isArray(message.value)) {
        var result = message.value;
        return Object.keys(message).sort().join('\n') === [
            'requestId', 'status', 'type', 'value', 'version',
        ].join('\n')
            && Object.keys(result).sort().join('\n') === [
                'completedItems', 'message', 'skippedItems', 'status', 'totalItems',
            ].join('\n')
            && result.status === 'failed'
            && Number.isSafeInteger(result.completedItems) && result.completedItems >= 0
            && Number.isSafeInteger(result.skippedItems) && result.skippedItems >= 0
            && Number.isSafeInteger(result.totalItems) && result.totalItems > 0
            && result.completedItems + result.skippedItems <= result.totalItems
            && typeof result.message === 'string' && result.message.length > 0
            && result.message.length <= 320 && !/[\0\r\n]/.test(result.message);
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

function validateFileTransferCopyProgress(message) {
    if (!message || message.type !== 'file-transfer-copy-progress'
        || message.version !== 1
        || typeof message.requestId !== 'string'
        || !/^[A-Za-z0-9._:-]{16,256}$/.test(message.requestId)
        || Object.keys(message).sort().join('\n') !== [
            'progress', 'requestId', 'type', 'version',
        ].join('\n')) {
        return false;
    }
    var progress = message.progress;
    return !!progress && typeof progress === 'object'
        && Object.keys(progress).every(function (key) {
            return ['status', 'phase', 'completedItems', 'skippedItems', 'totalItems', 'currentItemName'].includes(key);
        })
        && progress.status === 'running'
        && (progress.phase === 'preparing' || progress.phase === 'copying')
        && Number.isSafeInteger(progress.completedItems) && progress.completedItems >= 0
        && Number.isSafeInteger(progress.skippedItems) && progress.skippedItems >= 0
        && Number.isSafeInteger(progress.totalItems) && progress.totalItems > 0
        && progress.completedItems + progress.skippedItems <= progress.totalItems
        && (progress.currentItemName === undefined || (typeof progress.currentItemName === 'string'
            && progress.currentItemName.length > 0 && progress.currentItemName.length <= 255
            && !/[\0\r\n]/.test(progress.currentItemName)));
}

function validateFileTransferSavedPairs(message) {
    if (!message || message.type !== 'file-transfer-saved-pairs' || message.version !== 1
        || !Array.isArray(message.entries) || message.entries.length > 12
        || !message.entries.every(validateFileTransferSavedPair)) {
        return false;
    }
    var expected = message.requestId === undefined
        ? ['entries', 'type', 'version'] : ['entries', 'requestId', 'type', 'version'];
    return Object.keys(message).sort().join('\n') === expected.join('\n')
        && (message.requestId === undefined || (typeof message.requestId === 'string'
            && /^[A-Za-z0-9._:-]{16,256}$/.test(message.requestId)));
}

function validateFileTransferSavedPairsFailure(message) {
    return !!message && message.type === 'file-transfer-saved-pairs-failed'
        && message.version === 1
        && typeof message.requestId === 'string'
        && /^[A-Za-z0-9._:-]{16,256}$/.test(message.requestId)
        && typeof message.message === 'string' && message.message.length > 0 && message.message.length <= 320
        && Object.keys(message).sort().join('\n') === [
            'message', 'requestId', 'type', 'version',
        ].join('\n');
}

function validateFileTransferSavedPair(pair) {
    if (!pair || typeof pair !== 'object'
        || Object.keys(pair).sort().join('\n') !== ['endpoints', 'lastUsedAt', 'pinned'].join('\n')
        || !Array.isArray(pair.endpoints) || pair.endpoints.length !== 2
        || !pair.endpoints.every(validateFileTransferSavedPairEndpoint)
        || typeof pair.pinned !== 'boolean'
        || !Number.isSafeInteger(pair.lastUsedAt) || pair.lastUsedAt <= 0) {
        return false;
    }
    var keys = pair.endpoints.map(function (endpoint) {
        return endpoint.kind === 'local' ? 'local' : 'managed:' + endpoint.machineId;
    });
    return new Set(keys).size === 2 && !(pair.endpoints[0].kind === 'local' && pair.endpoints[1].kind === 'local');
}

function validateFileTransferSavedPairEndpoint(endpoint) {
    if (!endpoint || typeof endpoint !== 'object') return false;
    if (endpoint.kind === 'local') return Object.keys(endpoint).length === 1;
    return endpoint.kind === 'managedMachine'
        && Object.keys(endpoint).sort().join('\n') === ['kind', 'machineId'].join('\n')
        && typeof endpoint.machineId === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(endpoint.machineId);
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

function validateFileTransferCopyPreflight(message) {
    if (!message || message.version !== 1
        || typeof message.requestId !== 'string'
        || !/^[A-Za-z0-9._:-]{16,256}$/.test(message.requestId)) {
        return false;
    }
    if (message.type === 'file-transfer-copy-preflight-failed') {
        return Object.keys(message).sort().join('\n') === [
            'message', 'requestId', 'type', 'version',
        ].join('\n') && typeof message.message === 'string' && message.message.length <= 320;
    }
    var result = message.result;
    return message.type === 'file-transfer-copy-preflighted'
        && Object.keys(message).sort().join('\n') === [
            'requestId', 'result', 'type', 'version',
        ].join('\n')
        && !!result && typeof result === 'object'
        && Object.keys(result).sort().join('\n') === [
            'existingDirectoryNames', 'existingFileNames', 'knownBytes', 'totalItems', 'unknownSizeItems',
        ].join('\n')
        && Number.isSafeInteger(result.totalItems) && result.totalItems > 0 && result.totalItems <= 100
        && Number.isSafeInteger(result.knownBytes) && result.knownBytes >= 0
        && Number.isSafeInteger(result.unknownSizeItems)
        && result.unknownSizeItems >= 0 && result.unknownSizeItems <= result.totalItems
        && validFileTransferPreflightNames(result.existingFileNames)
        && validFileTransferPreflightNames(result.existingDirectoryNames);
}

function validFileTransferPreflightNames(names) {
    return Array.isArray(names) && names.length <= 100
        && names.every(function (name) {
            return typeof name === 'string' && name.length > 0 && name.length <= 255
                && !/[\0\r\n]/.test(name);
        }) && new Set(names).size === names.length;
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
                    return ['at', 'status', 'itemCount', 'conflictPolicy', 'completedItems', 'skippedItems', 'source', 'destination'].includes(key);
                })
                && Number.isSafeInteger(entry.at) && entry.at > 0
                && (entry.status === 'copied' || entry.status === 'cancelled' || entry.status === 'failed')
                && Number.isSafeInteger(entry.itemCount) && entry.itemCount > 0
                && ['fail', 'skip', 'replace'].includes(entry.conflictPolicy)
                && ((entry.source === undefined && entry.destination === undefined)
                    || (validateFileTransferSavedPairEndpoint(entry.source)
                        && validateFileTransferSavedPairEndpoint(entry.destination)));
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
    var enabledTabs = Array.isArray(options.enabledTabs) && options.enabledTabs.length
        ? options.enabledTabs : ['open', 'projects', 'ai', 'file-transfer'];
    if (enabledTabs.indexOf(activeTab) < 0) {
        activeTab = enabledTabs.indexOf('open') >= 0 ? 'open' : enabledTabs[0];
    }
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
            options.postMessage({ type: 'file-transfer-request-saved-pairs', version: 1 });
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
        var savedPairsPanel = panel.querySelector('[data-file-transfer-saved-pairs]');
        var savedPairList = panel.querySelector('[data-file-transfer-saved-pair-list]');
        var review = panel.querySelector('[data-file-transfer-review]');
        var tasks = panel.querySelector('[data-file-transfer-tasks]');
        var taskStatus = panel.querySelector('[data-file-transfer-task-status]');
        var revealTarget = panel.querySelector('[data-file-transfer-reveal-target]');
        var retry = panel.querySelector('[data-file-transfer-retry]');
        var taskList = panel.querySelector('[data-file-transfer-task-list]');
        var historyList = panel.querySelector('[data-file-transfer-history-list]');
        var clearHistory = panel.querySelector('[data-file-transfer-clear-history]');
        var reviewSheet = panel.querySelector('[data-file-transfer-review-sheet]');
        var reviewSummary = panel.querySelector('[data-file-transfer-review-summary]');
        var reviewSize = panel.querySelector('[data-file-transfer-review-size]');
        var reviewPreflight = panel.querySelector('[data-file-transfer-review-preflight]');
        var reviewNote = panel.querySelector('[data-file-transfer-review-note]');
        var reviewItems = panel.querySelector('[data-file-transfer-review-items]');
        var targetNameField = panel.querySelector('[data-file-transfer-target-name]');
        var targetNameInput = panel.querySelector('[data-file-transfer-target-name-input]');
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
        var fileTransferFilter = { left: '', right: '' };
        var pendingCopyRequestId = null;
        var activeCopyTaskId = null;
        var pendingCopyItemCount = 0;
        var pendingCopyPlan = null;
        var pendingPreflightRequestId = null;
        var reviewedCopyPlan = null;
        var reviewPreflightResult = null;
        var lastFailedCopyPlan = null;
        var lastCompletedCopyPlan = null;
        var savedPairs = [];
        var lastRememberedPairKey = null;
        var transferTasks = {};
        var pendingHistoryClearRequestId = null;
        var draggedFileTransferEntry = null;
        var reviewReturnFocus = null;

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

        function savedPairEndpointKey(endpoint) {
            return endpoint.kind === 'local' ? 'local' : 'managed:' + endpoint.machineId;
        }

        function savedPairKey(endpoints) {
            return endpoints.map(savedPairEndpointKey).sort().join('|');
        }

        function savedPairLabel(endpoint) {
            if (endpoint.kind === 'local') return 'This Computer';
            var selector = selectors.find(function (candidate) {
                return candidate.value === 'managed:' + endpoint.machineId;
            });
            var option = selector && Array.from(selector.options || []).find(function (candidate) {
                return candidate.value === 'managed:' + endpoint.machineId;
            });
            return option && option.textContent ? option.textContent : null;
        }

        function renderSavedPairs() {
            if (!savedPairsPanel || !savedPairList) return;
            savedPairList.textContent = '';
            var visiblePairs = savedPairs.filter(function (pair) {
                return pair.endpoints.every(function (endpoint) { return !!savedPairLabel(endpoint); });
            });
            savedPairsPanel.hidden = visiblePairs.length === 0;
            visiblePairs.forEach(function (pair) {
                var item = document.createElement('li');
                var select = document.createElement('button');
                select.type = 'button';
                select.textContent = pair.endpoints.map(savedPairLabel).join(' ↔ ');
                select.title = 'Select this endpoint pair';
                select.addEventListener('click', function () { selectSavedPair(pair); });
                item.appendChild(select);
                var pin = document.createElement('button');
                pin.type = 'button';
                pin.setAttribute('data-file-transfer-saved-pair-pin', '');
                pin.textContent = pair.pinned ? '★' : '☆';
                pin.title = pair.pinned ? 'Unpin endpoint pair' : 'Pin endpoint pair';
                pin.setAttribute('aria-label', pin.title + ': ' + select.textContent);
                pin.addEventListener('click', function () { setSavedPairPinned(pair, !pair.pinned); });
                item.appendChild(pin);
                savedPairList.appendChild(item);
            });
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
                var route = task.plan && task.plan.sourceLabel && task.plan.destinationLabel
                    ? ' · ' + task.plan.sourceLabel + ' → ' + task.plan.destinationLabel : '';
                var itemProgress = task.progress && Number.isSafeInteger(task.progress.completedItems)
                    ? task.progress.completedItems + task.progress.skippedItems + '/' + task.progress.totalItems
                    : String(task.itemCount);
                label.textContent = task.status === 'running'
                    ? 'Copying ' + itemProgress + ' item(s)'
                        + (task.progress && task.progress.currentItemName
                            ? ' · ' + task.progress.currentItemName : '') + route
                    : task.status === 'cancelling'
                        ? 'Cancelling ' + task.itemCount + ' item(s)' + route
                        : 'Queued · ' + task.itemCount + ' item(s)' + route;
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
                    : 'Failed after ' + (entry.completedItems || 0) + ' copied'
                        + (entry.skippedItems ? ', skipped ' + entry.skippedItems : '');
                if (entry.source && entry.destination) {
                    detail += ' · ' + savedPairLabel(entry.source) + ' → ' + savedPairLabel(entry.destination);
                }
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

        function renderPaneBreadcrumbs(side, pathElement, directoryView, fallback) {
            if (!pathElement) return;
            pathElement.textContent = '';
            if (!directoryView) {
                pathElement.textContent = fallback;
                return;
            }
            var trail = directoryHistory[side].concat([directoryView]).filter(function (directory, index, all) {
                return index === 0 || directory.directoryId !== all[index - 1].directoryId;
            });
            trail.forEach(function (directory, index) {
                if (index > 0) {
                    var separator = document.createElement('span');
                    separator.className = 'file-transfer-breadcrumb-separator';
                    separator.textContent = '/';
                    separator.setAttribute('aria-hidden', 'true');
                    pathElement.appendChild(separator);
                }
                var displayPath = directory.displayPath || '.';
                var segments = displayPath.split('/').filter(function (segment) {
                    return segment && segment !== '.';
                });
                var label = segments.length ? segments[segments.length - 1] : 'Root';
                if (index === trail.length - 1) {
                    var current = document.createElement('span');
                    current.className = 'file-transfer-breadcrumb-current';
                    current.textContent = label;
                    current.setAttribute('aria-current', 'page');
                    current.title = displayPath;
                    pathElement.appendChild(current);
                    return;
                }
                var button = document.createElement('button');
                button.type = 'button';
                button.className = 'file-transfer-breadcrumb';
                button.textContent = label;
                button.title = displayPath;
                button.setAttribute('aria-label', 'Open ' + displayPath + ' in this endpoint');
                button.addEventListener('click', function () {
                    directoryHistory[side] = trail.slice(0, index);
                    openDirectory(side, directory.directoryId, false);
                });
                pathElement.appendChild(button);
            });
        }

        function updatePane(side, selector) {
            var pane = panes[side];
            if (!pane || !selector) {
                return;
            }
            var name = pane.querySelector('[data-file-transfer-pane-name]');
            var path = pane.querySelector('[data-file-transfer-pane-path]');
            var pathInput = pane.querySelector('[data-file-transfer-path-input]');
            var status = pane.querySelector('[data-file-transfer-pane-status]');
            var refresh = pane.querySelector('[data-file-transfer-refresh]');
            var up = pane.querySelector('[data-file-transfer-up]');
            var filter = pane.querySelector('[data-file-transfer-filter]');
            var showHidden = pane.querySelector('[data-file-transfer-show-hidden]');
            var sort = pane.querySelector('[data-file-transfer-sort]');
            var fileList = pane.querySelector('[data-file-transfer-file-list]');
            var option = selector.options && selector.selectedIndex >= 0
                ? selector.options[selector.selectedIndex] : null;
            var value = selector.value || '';
            if (!value) {
                if (name) name.textContent = 'Choose an endpoint';
                renderPaneBreadcrumbs(side, path, null, '—');
                if (status) status.textContent = 'Choose an endpoint to browse its files.';
                if (refresh) refresh.disabled = true;
                if (up) up.disabled = true;
                if (filter) filter.disabled = true;
                if (showHidden) showHidden.disabled = true;
                if (sort) sort.disabled = true;
                if (pathInput) {
                    pathInput.disabled = true;
                    pathInput.value = '';
                }
                if (fileList) {
                    fileList.textContent = '';
                    fileList.hidden = true;
                }
                return;
            }
            if (name) name.textContent = option ? option.textContent : 'Selected endpoint';
            var directoryView = localRoots[side];
            var visibleEntries = directoryView ? directoryView.entries.filter(function (entry) {
                return (showHiddenEntries[side] || entry.name.charAt(0) !== '.')
                    && entry.name.toLocaleLowerCase().includes(fileTransferFilter[side]);
            }) : [];
            if (filter) {
                filter.disabled = !directoryView;
                filter.value = fileTransferFilter[side];
            }
            if (showHidden) {
                showHidden.disabled = !directoryView;
                showHidden.checked = showHiddenEntries[side];
            }
            if (sort) {
                sort.disabled = !directoryView;
                sort.value = fileTransferSort[side];
            }
            if (pathInput) {
                pathInput.disabled = !directoryView;
                pathInput.value = directoryView ? directoryView.displayPath : '';
            }
            renderPaneBreadcrumbs(
                side,
                path,
                directoryView,
                value === 'local' ? 'Choose a local folder' : 'Managed Machine',
            );
            if (status) {
                status.textContent = paneFailures[side]
                    ? paneFailures[side] + ' Select Refresh to try again.'
                    : directoryView
                    ? (showHiddenEntries[side] || visibleEntries.length === directoryView.entries.length
                        ? visibleEntries.length + ' items'
                        : visibleEntries.length + ' of ' + directoryView.entries.length + ' items')
                        + (directoryView.hasMore ? ' (showing the first 1,000; enter a narrower path to browse more).' : '') + (value === 'local'
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
                    function (entryId, event) { beginFileTransferDrag(side, entryId, event); },
                    function () { draggedFileTransferEntry = null; },
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
            ['left', 'right'].forEach(function (side) {
                var pane = panes[side];
                var copyState = pane && pane.querySelector
                    ? pane.querySelector('[data-file-transfer-pane-copy-state]') : null;
                if (pane && pane.classList) {
                    pane.classList.toggle('is-file-transfer-copy-source', sourceSide === side);
                }
                if (copyState) copyState.hidden = sourceSide !== side;
            });
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

        function beginFileTransferDrag(side, entryId, event) {
            if (!selectedEntries[side].has(entryId)) {
                selectedEntries.left.clear();
                selectedEntries.right.clear();
                selectedEntries[side].add(entryId);
            }
            draggedFileTransferEntry = { side: side, entryId: entryId };
            if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = 'copy';
                event.dataTransfer.setData('text/plain', 'agent-pivot-file-transfer');
            }
        }

        function dropFileTransferEntry(destinationSide, event) {
            if (!draggedFileTransferEntry || draggedFileTransferEntry.side === destinationSide
                || !localRoots[destinationSide]) return;
            event.preventDefault();
            selectedEntries[destinationSide].clear();
            selectedEntries[draggedFileTransferEntry.side].add(draggedFileTransferEntry.entryId);
            draggedFileTransferEntry = null;
            updatePair();
            openReview();
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

        function openPath(side, navigationPath) {
            var selector = selectorFor(side);
            var root = localRoots[side];
            if (!selector || !root || !navigationPath) return;
            var requestId = 'file-transfer-path-' + side + '-' + Date.now() + '-'
                + Math.random().toString(16).slice(2, 18);
            pendingLocalRootRequests[side] = requestId;
            selectedEntries[side].clear();
            directoryHistory[side] = [];
            var endpoint = selector.value === 'local'
                ? { kind: 'local', rootId: root.rootId, directoryId: root.directoryId }
                : selector.value.indexOf('managed:') === 0
                    ? {
                        kind: 'managedMachine',
                        machineId: selector.value.slice('managed:'.length),
                        directoryId: root.directoryId,
                    } : null;
            if (!endpoint) return;
            options.postMessage({
                type: 'file-transfer-open-directory', version: 1, requestId: requestId,
                side: side, endpoint: endpoint, path: navigationPath,
            });
            updatePair();
        }

        function activateEndpointSelection(side, selector) {
            if (side !== 'left' && side !== 'right' || !selector) return;
            localRoots[side] = null;
            paneFailures[side] = null;
            pendingLocalRootRequests[side] = null;
            selectedEntries[side].clear();
            directoryHistory[side] = [];
            lastRememberedPairKey = null;
            if (reviewSheet) reviewSheet.hidden = true;
            if (selector.value === 'local') {
                requestLocalRoot(side);
            } else if (selector.value.indexOf('managed:') === 0) {
                requestRemoteDirectory(side, selector.value.slice('managed:'.length));
            }
            updatePair();
        }

        function onEndpointChange(event) {
            var selector = event.currentTarget;
            var side = selector && selector.getAttribute
                ? selector.getAttribute('data-file-transfer-endpoint') : null;
            activateEndpointSelection(side, selector);
        }

        function selectSavedPair(pair) {
            if (!pair || !Array.isArray(pair.endpoints) || pair.endpoints.length !== 2) return;
            ['left', 'right'].forEach(function (side, index) {
                var selector = selectorFor(side);
                var endpoint = pair.endpoints[index];
                var value = savedPairEndpointKey(endpoint);
                if (!selector || selector.value === value) return;
                selector.value = value;
                activateEndpointSelection(side, selector);
            });
            rememberCurrentPair(true);
        }

        function pairEndpointsFromSelectors() {
            var values = ['left', 'right'].map(function (side) {
                var selector = selectorFor(side);
                if (!selector || !selector.value) return null;
                return selector.value === 'local' ? { kind: 'local' }
                    : selector.value.indexOf('managed:') === 0
                        ? { kind: 'managedMachine', machineId: selector.value.slice('managed:'.length) } : null;
            });
            return values.every(Boolean) && savedPairEndpointKey(values[0]) !== savedPairEndpointKey(values[1])
                ? values : null;
        }

        function rememberCurrentPair(force) {
            var endpoints = pairEndpointsFromSelectors();
            if (!endpoints) return;
            var key = savedPairKey(endpoints);
            if (!force && key === lastRememberedPairKey) return;
            lastRememberedPairKey = key;
            options.postMessage({
                type: 'file-transfer-save-pair', version: 1,
                requestId: 'file-transfer-saved-pair-' + Date.now() + '-'
                    + Math.random().toString(16).slice(2, 18),
                endpoints: endpoints,
            });
        }

        function setSavedPairPinned(pair, pinned) {
            options.postMessage({
                type: 'file-transfer-set-saved-pair-pinned', version: 1,
                requestId: 'file-transfer-saved-pair-pin-' + Date.now() + '-'
                    + Math.random().toString(16).slice(2, 18),
                endpoints: pair.endpoints,
                pinned: pinned,
            });
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
            var leftFilter = fileTransferFilter.left;
            fileTransferFilter.left = fileTransferFilter.right;
            fileTransferFilter.right = leftFilter;
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
            if (localRoots.left && localRoots.right) rememberCurrentPair(false);
            updatePair();
            return true;
        }

        function applySavedPairs(message) {
            savedPairs = message.entries.slice();
            renderSavedPairs();
            return true;
        }

        function applySavedPairsFailure(message) {
            lastRememberedPairKey = null;
            renderTaskStatus(message.message || 'Could not update endpoint pairs locally.');
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

        function updateReviewStartAvailability() {
            if (!startCopy || !reviewSheet || reviewSheet.hidden) return;
            var result = reviewPreflightResult;
            var policy = conflictPolicy ? conflictPolicy.value : 'fail';
            var existingFileCount = result ? result.existingFileNames.length : 0;
            var existingDirectoryCount = result ? result.existingDirectoryNames.length : 0;
            var canStart = !!reviewedCopyPlan && !pendingPreflightRequestId && !!result;
            if (canStart && (existingFileCount || existingDirectoryCount) && policy === 'fail') {
                canStart = false;
                if (reviewNote) reviewNote.textContent = (existingFileCount + existingDirectoryCount)
                    + ' existing target item(s) need a Skip or Replace choice before copy can start.';
            } else if (canStart && existingDirectoryCount && policy === 'replace') {
                canStart = false;
                if (reviewNote) reviewNote.textContent = 'Existing folders and non-files cannot be safely replaced. Select Skip existing or another folder.';
            } else if (canStart) {
                if (reviewNote) reviewNote.textContent = 'Copy will begin only after you select Start copy.';
            } else if (pendingPreflightRequestId && reviewNote) {
                reviewNote.textContent = 'Checking source access and existing target items…';
            }
            startCopy.disabled = !canStart;
        }

        function requestCopyPreflight(plan) {
            var requestId = 'file-transfer-preflight-' + Date.now() + '-'
                + Math.random().toString(16).slice(2, 18);
            pendingPreflightRequestId = requestId;
            reviewPreflightResult = null;
            if (reviewPreflight) reviewPreflight.textContent = 'Checking source access and target collisions…';
            updateReviewStartAvailability();
            options.postMessage({
                type: 'file-transfer-preflight-copy',
                version: 1,
                requestId: requestId,
                source: plan.source,
                destination: plan.destination,
                entryIds: plan.entryIds.slice(),
                ...(plan.targetName ? { targetName: plan.targetName } : {}),
            });
        }

        function applyCopyPreflight(message) {
            if (message.requestId !== pendingPreflightRequestId) return false;
            pendingPreflightRequestId = null;
            if (message.type === 'file-transfer-copy-preflighted') {
                reviewPreflightResult = message.result;
                var existingCount = message.result.existingFileNames.length
                    + message.result.existingDirectoryNames.length;
                if (reviewSize) {
                    reviewSize.textContent = message.result.unknownSizeItems
                        ? 'Known size: ' + formatFileTransferBytes(message.result.knownBytes) + '. '
                            + message.result.unknownSizeItems + ' folder or item size will be determined during copy.'
                        : 'Total size: ' + formatFileTransferBytes(message.result.knownBytes) + '.';
                }
                if (reviewPreflight) {
                    reviewPreflight.textContent = existingCount
                        ? existingCount + ' target item(s) already exist ('
                            + message.result.existingFileNames.length + ' file(s), '
                            + message.result.existingDirectoryNames.length + ' folder or non-file item(s)).'
                        : 'Source access is ready. No target collisions were found.';
                }
            } else {
                reviewPreflightResult = null;
                if (reviewPreflight) reviewPreflight.textContent = 'Could not complete review: ' + message.message;
                if (reviewNote) reviewNote.textContent = 'Fix the reported issue, then open Review copy again.';
            }
            updateReviewStartAvailability();
            return true;
        }

        function openReview() {
            var sourceSide = selectedSourceSide();
            if (!sourceSide || !reviewSheet) return;
            var destinationSide = sourceSide === 'left' ? 'right' : 'left';
            var source = selectorFor(sourceSide);
            var destination = selectorFor(destinationSide);
            if (!source || !destination || !source.value || !destination.value) return;
            var entries = selectedEntryDetails(sourceSide);
            var canRename = entries.length === 1 && entries[0].kind === 'file';
            if (targetNameField) targetNameField.hidden = !canRename;
            if (targetNameInput) targetNameInput.value = canRename ? entries[0].name : '';
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
            reviewReturnFocus = document.activeElement;
            renderReviewItems(entries);
            reviewSheet.hidden = false;
            reviewedCopyPlan = {
                source: endpointReference(sourceSide),
                destination: endpointReference(destinationSide),
                entryIds: Array.from(selectedEntries[sourceSide]),
                ...(canRename && targetNameInput ? { targetName: targetNameInput.value } : {}),
            };
            if (!reviewedCopyPlan.source || !reviewedCopyPlan.destination) {
                closeReview();
                return;
            }
            requestCopyPreflight(reviewedCopyPlan);
            setTimeout(function () {
                if (!reviewSheet || reviewSheet.hidden) return;
                var initialFocus = canRename ? targetNameInput : reviewCancel;
                if (initialFocus && typeof initialFocus.focus === 'function') initialFocus.focus();
            }, 0);
        }

        function closeReview() {
            if (reviewSheet) reviewSheet.hidden = true;
            pendingPreflightRequestId = null;
            reviewedCopyPlan = null;
            reviewPreflightResult = null;
            if (reviewReturnFocus && typeof reviewReturnFocus.focus === 'function') {
                reviewReturnFocus.focus();
            }
            reviewReturnFocus = null;
        }

        function startReviewedCopy() {
            if (!reviewedCopyPlan || pendingCopyRequestId || pendingPreflightRequestId || !reviewPreflightResult
                || (startCopy && startCopy.disabled)) return;
            submitCopyPlan({
                source: reviewedCopyPlan.source,
                destination: reviewedCopyPlan.destination,
                entryIds: reviewedCopyPlan.entryIds.slice(),
                conflictPolicy: conflictPolicy ? conflictPolicy.value : 'fail',
                ...(reviewedCopyPlan.targetName ? { targetName: reviewedCopyPlan.targetName } : {}),
            });
        }

        function fileTransferEndpointLabel(endpoint) {
            if (!endpoint || endpoint.kind === 'local') return 'This Computer';
            var selector = selectors.find(function (candidate) {
                return candidate.value === 'managed:' + endpoint.machineId;
            });
            var option = selector && selector.options && selector.selectedIndex >= 0
                ? selector.options[selector.selectedIndex] : null;
            return option && option.textContent ? option.textContent : 'Managed Machine';
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
                sourceLabel: fileTransferEndpointLabel(plan.source),
                destinationLabel: fileTransferEndpointLabel(plan.destination),
                ...(plan.targetName ? { targetName: plan.targetName } : {}),
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
                ...(pendingCopyPlan.targetName ? { targetName: pendingCopyPlan.targetName } : {}),
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
                lastCompletedCopyPlan = task && task.plan ? task.plan : null;
                if (revealTarget) revealTarget.hidden = !lastCompletedCopyPlan;
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
                var failedAfter = message.value && Number.isSafeInteger(message.value.completedItems)
                    ? message.value.completedItems : 0;
                var failedSkipped = message.value && Number.isSafeInteger(message.value.skippedItems)
                    ? message.value.skippedItems : 0;
                var failureMessage = message.value && typeof message.value.message === 'string'
                    ? message.value.message : (message.message || 'File copy failed.');
                renderTaskStatus('Copy failed after ' + failedAfter + ' copied'
                    + (failedSkipped ? ', ' + failedSkipped + ' skipped' : '') + ': ' + failureMessage);
                lastFailedCopyPlan = task && task.plan ? task.plan : null;
                if (retry) retry.hidden = !lastFailedCopyPlan;
                if (wasPending && reviewSummary) {
                    reviewSummary.textContent = failureMessage;
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
            renderTaskStatus('Copying ' + task.itemCount + ' item(s) from '
                + (task.plan.sourceLabel || 'the selected endpoint') + ' to '
                + (task.plan.destinationLabel || 'the other endpoint') + '. Select Transfers to cancel.');
            updatePair();
            return true;
        }

        function applyCopyProgress(message) {
            var task = transferTasks[message.requestId];
            if (!task || task.status !== 'running') return false;
            task.progress = message.progress;
            renderTaskCount();
            var current = message.progress.currentItemName
                ? ' ' + message.progress.phase + ' ' + message.progress.currentItemName + '.'
                : ' Preparing the next item.';
            renderTaskStatus('Copying ' + (message.progress.completedItems + message.progress.skippedItems)
                + ' of ' + message.progress.totalItems + ' item(s).' + current);
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

        function sameFileTransferEndpoint(left, right) {
            if (!left || !right || left.kind !== right.kind) return false;
            return left.kind === 'local'
                ? left.rootId === right.rootId
                : left.machineId === right.machineId;
        }

        function revealCompletedTarget() {
            if (!lastCompletedCopyPlan || !lastCompletedCopyPlan.destination) return;
            var destination = lastCompletedCopyPlan.destination;
            var side = ['left', 'right'].find(function (candidate) {
                return sameFileTransferEndpoint(endpointReference(candidate), destination);
            });
            if (!side) {
                renderTaskStatus('Select the original destination endpoint to reveal this copy target.');
                return;
            }
            renderTaskStatus('Opening the completed copy target…');
            openDirectory(side, destination.directoryId);
        }

        selectors.forEach(function (selector) {
            selector.addEventListener('change', onEndpointChange);
        });
        if (swap) swap.addEventListener('click', swapEndpointLayout);
        if (review) review.addEventListener('click', openReview);
        if (reviewCancel) reviewCancel.addEventListener('click', closeReview);
        if (startCopy) startCopy.addEventListener('click', startReviewedCopy);
        if (conflictPolicy) conflictPolicy.addEventListener('change', updateReviewStartAvailability);
        if (targetNameInput) targetNameInput.addEventListener('change', function () {
            if (!reviewedCopyPlan) return;
            if (targetNameInput.value) reviewedCopyPlan.targetName = targetNameInput.value;
            else delete reviewedCopyPlan.targetName;
            requestCopyPreflight(reviewedCopyPlan);
        });
        if (retry) retry.addEventListener('click', retryFailedCopy);
        if (revealTarget) revealTarget.addEventListener('click', revealCompletedTarget);
        if (clearHistory) clearHistory.addEventListener('click', requestHistoryClear);
        panel.addEventListener('keydown', function (event) {
            if (event.key !== 'Escape' || !reviewSheet || reviewSheet.hidden) return;
            event.preventDefault();
            closeReview();
        });
        ['left', 'right'].forEach(function (side) {
            var pane = panes[side];
            if (!pane) return;
            pane.addEventListener('dragover', function (event) {
                if (draggedFileTransferEntry && draggedFileTransferEntry.side !== side && localRoots[side]) {
                    event.preventDefault();
                    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
                }
            });
            pane.addEventListener('drop', function (event) { dropFileTransferEntry(side, event); });
        });
        Array.from(panel.querySelectorAll('[data-file-transfer-filter]')).forEach(function (input) {
            input.addEventListener('input', function () {
                var side = input.getAttribute('data-file-transfer-filter');
                if (side !== 'left' && side !== 'right') return;
                fileTransferFilter[side] = input.value.slice(0, 255).toLocaleLowerCase();
                updatePair();
            });
        });
        Array.from(panel.querySelectorAll('[data-file-transfer-path-input]')).forEach(function (input) {
            input.addEventListener('change', function () {
                var side = input.getAttribute('data-file-transfer-path-input');
                if (side === 'left' || side === 'right') openPath(side, input.value);
            });
            input.addEventListener('keydown', function (event) {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                var side = input.getAttribute('data-file-transfer-path-input');
                if (side === 'left' || side === 'right') openPath(side, input.value);
            });
        });
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
            applyCopyProgress: applyCopyProgress,
            applyCopyQueued: applyCopyQueued,
            applyCopyPreflight: applyCopyPreflight,
            applyHistory: applyHistory,
            applySavedPairs: applySavedPairs,
            applySavedPairsFailure: applySavedPairsFailure,
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
        if (event && event.data && validateFileTransferCopyProgress(event.data)
            && fileTransferPanel) {
            fileTransferPanel.applyCopyProgress(event.data);
        }
        if (event && event.data && validateFileTransferCopyQueued(event.data)
            && fileTransferPanel) {
            fileTransferPanel.applyCopyQueued(event.data);
        }
        if (event && event.data && validateFileTransferCopyPreflight(event.data)
            && fileTransferPanel) {
            fileTransferPanel.applyCopyPreflight(event.data);
        }
        if (event && event.data && validateFileTransferSavedPairs(event.data)
            && fileTransferPanel) {
            fileTransferPanel.applySavedPairs(event.data);
        }
        if (event && event.data && validateFileTransferSavedPairsFailure(event.data)
            && fileTransferPanel) {
            fileTransferPanel.applySavedPairsFailure(event.data);
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
        options.postMessage({ type: 'file-transfer-request-saved-pairs', version: 1 });
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
        applyFileTransferCopyProgress: fileTransferPanel
            ? fileTransferPanel.applyCopyProgress : function () { return false; },
        applyFileTransferCopyQueued: fileTransferPanel
            ? fileTransferPanel.applyCopyQueued : function () { return false; },
        applyFileTransferHistory: fileTransferPanel
            ? fileTransferPanel.applyHistory : function () { return false; },
        applyFileTransferSavedPairs: fileTransferPanel
            ? fileTransferPanel.applySavedPairs : function () { return false; },
        applyFileTransferSavedPairsFailure: fileTransferPanel
            ? fileTransferPanel.applySavedPairsFailure : function () { return false; },
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
