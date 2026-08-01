function getAiSessionCardActivation(target, projectId) {
    if (!target || typeof target.closest !== 'function') {
        return { handled: false, sessionRow: null, message: null };
    }
    var primarySessionAction = target.closest('[data-action="activate-ai-session"]');
    var interactiveSessionChild = target.closest(
        'button, input, select, textarea, a[href], [data-action]'
    );
    var activationSessionRow = primarySessionAction
        ? primarySessionAction.closest('.codex-session-row')
        : (!interactiveSessionChild ? target.closest('.codex-session-row') : null);
    if (!activationSessionRow) {
        return {
            handled: !!target.closest('.codex-session-row'),
            sessionRow: null,
            message: null,
        };
    }

    var provider = activationSessionRow.getAttribute('data-session-provider') || 'codex';
    var supportedProvider = provider === 'codex' || provider === 'kimi' || provider === 'claude';
    if (activationSessionRow.hasAttribute('data-session-pending')) {
        var createdAt = activationSessionRow.getAttribute('data-pending-created-at');
        return {
            handled: true,
            sessionRow: activationSessionRow,
            message: supportedProvider && createdAt ? {
                type: 'focus-pending-ai-session',
                projectId: projectId,
                provider: provider,
                createdAt: createdAt,
            } : null,
        };
    }

    var sessionId = activationSessionRow.getAttribute('data-session-id');
    if (!sessionId || !supportedProvider) {
        return { handled: true, sessionRow: activationSessionRow, message: null };
    }
    if (activationSessionRow.hasAttribute('data-session-active')) {
        if (activationSessionRow.hasAttribute('data-session-focused')) {
            return {
                handled: true,
                sessionRow: activationSessionRow,
                message: {
                    type: 'open-active-ai-session-conversation',
                    version: 1,
                    projectId: projectId,
                    provider: provider,
                    sessionId: sessionId,
                },
            };
        }
        return {
            handled: true,
            sessionRow: activationSessionRow,
            message: {
                type: 'focus-ai-session-terminal',
                projectId: projectId,
                provider: provider,
                sessionId: sessionId,
            },
        };
    }
    return {
        handled: true,
        sessionRow: activationSessionRow,
        message: {
            type: provider === 'kimi'
                ? 'resume-kimi-session'
                : provider === 'claude'
                    ? 'resume-claude-session'
                    : 'resume-codex-session',
            projectId: projectId,
            sessionId: sessionId,
        },
    };
}

var MAX_AI_SESSION_BATCH_ARCHIVE_RESULT_COUNT = 100;

function getBoundedAiSessionBatchArchiveResultCounts(result) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        return null;
    }
    var arrayFields = ['archived', 'running', 'missing', 'rejected', 'failed'];
    if (arrayFields.some(field =>
        !Array.isArray(result[field])
        || result[field].length > MAX_AI_SESSION_BATCH_ARCHIVE_RESULT_COUNT
    )) {
        return null;
    }
    if (!Number.isSafeInteger(result.rejectedCount)
        || result.rejectedCount < result.rejected.length
        || !Number.isSafeInteger(result.malformedCount)
        || result.rejectedCount < 0
        || result.malformedCount < 0) {
        return null;
    }
    var counts = {
        archived: result.archived.length,
        running: result.running.length,
        missing: result.missing.length,
        rejected: result.rejectedCount + result.malformedCount,
        failed: result.failed.length,
    };
    var total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    if (!Number.isSafeInteger(total)
        || total > MAX_AI_SESSION_BATCH_ARCHIVE_RESULT_COUNT) {
        return null;
    }
    return counts;
}

function formatAiSessionBatchArchiveCount(count, singular, plural) {
    return count + ' ' + (count === 1 ? singular : plural);
}

function getAiSessionBatchArchiveAnnouncement(message) {
    if (message.status === 'cancelled') {
        return 'Archive cancelled. No sessions were archived.';
    }
    if (message.status === 'rejected') {
        return 'Archive request was rejected. No sessions were archived.';
    }
    var counts = getBoundedAiSessionBatchArchiveResultCounts(message.result);
    if (!counts) {
        return 'Archive completed, but its result summary was unavailable.';
    }
    var parts = [
        'Archived ' + formatAiSessionBatchArchiveCount(
            counts.archived,
            'AI session',
            'AI sessions'
        ),
    ];
    if (counts.running) {
        parts.push('skipped ' + formatAiSessionBatchArchiveCount(
            counts.running,
            'running session',
            'running sessions'
        ));
    }
    if (counts.missing) {
        parts.push(formatAiSessionBatchArchiveCount(
            counts.missing,
            'session was',
            'sessions were'
        ) + ' no longer available');
    }
    if (counts.rejected) {
        parts.push(formatAiSessionBatchArchiveCount(
            counts.rejected,
            'invalid or out-of-scope selection was rejected',
            'invalid or out-of-scope selections were rejected'
        ));
    }
    if (counts.failed) {
        parts.push(formatAiSessionBatchArchiveCount(
            counts.failed,
            'session failed',
            'sessions failed'
        ));
    }
    return parts.join('; ') + '.';
}

function initProjects() {

    const ProjectOpenType = {
        Default: 0,
        NewWindow: 1,
        AddToWorkspace: 2,
        CurrentWindow: 3,
    };

    var batchAiSessionState = {
        projectId: null,
        selectedItems: new Map(),
        pending: false,
        requestId: null,
    };
    var activeAiSessionTerminalState = { provider: null, sessionId: null };
    var pendingWorkspaceSessionReveal = null;
    var nextAiSessionBatchArchiveRequestId = 0;
    var nextAiSessionProviderSelectionRequestId = 0;
    var pendingAiSessionProviderSelectionProjectId = null;
    var pendingAiSessionProviderSelectionRequestId = null;
    var pendingAiSessionProviderSelectionProviders = [];

    function isDedicatedTodoTarget(target) {
        return Boolean(window.__agentPivotTodo
            && target
            && target.closest
            && target.closest('#dashboard-tab-todo'));
    }

    function getAiSessionBatchItemKey(provider, sessionId) {
        return JSON.stringify([provider, sessionId]);
    }

    function enter(projectId) {
        if (batchAiSessionState.pending)
            return;
        batchAiSessionState.projectId = projectId;
        batchAiSessionState.selectedItems = new Map();
        batchAiSessionState.pending = false;
        batchAiSessionState.requestId = null;
    }

    function toggle(provider, sessionId, active) {
        if (!isAiSessionProvider(provider) || !sessionId || active || batchAiSessionState.pending)
            return;
        var key = getAiSessionBatchItemKey(provider, sessionId);
        if (batchAiSessionState.selectedItems.has(key))
            batchAiSessionState.selectedItems.delete(key);
        else
            batchAiSessionState.selectedItems.set(key, { provider, sessionId });
    }

    function selectUnpinned(sessions) {
        if (batchAiSessionState.pending)
            return;
        sessions
            .filter(session => isAiSessionProvider(session.provider)
                && session.id && !session.pinned && !session.active)
            .forEach(session => {
                var item = { provider: session.provider, sessionId: session.id };
                batchAiSessionState.selectedItems.set(
                    getAiSessionBatchItemKey(item.provider, item.sessionId),
                    item
                );
            });
    }

    function clear() {
        if (!batchAiSessionState.pending)
            batchAiSessionState.selectedItems.clear();
    }

    function reconcile(projectId, remainingItems) {
        if (projectId !== batchAiSessionState.projectId) {
            exit();
            return;
        }
        let selectedItems = batchAiSessionState.selectedItems;
        batchAiSessionState.selectedItems = new Map(
            remainingItems
                .filter(item => item && isAiSessionProvider(item.provider) && item.sessionId)
                .map(item => {
                    var key = getAiSessionBatchItemKey(item.provider, item.sessionId);
                    return [key, selectedItems.get(key)];
                })
                .filter(entry => entry[1])
        );
    }

    function reconcileVisible(projectDiv) {
        if (!projectDiv)
            return;
        var projectId = projectDiv.getAttribute('data-id');
        var remainingItems = Array.from(
            projectDiv.querySelectorAll('.ai-session-history-panel .codex-session-row[data-session-id]')
        )
            .filter(row => isAiSessionProvider(row.getAttribute('data-session-provider') || 'codex')
                && row.getAttribute('data-session-id')
                && !row.hasAttribute('data-session-active'))
            .map(row => ({
                provider: row.getAttribute('data-session-provider') || 'codex',
                sessionId: row.getAttribute('data-session-id'),
            }));
        reconcile(projectId, remainingItems);
    }

    function submit() {
        if (batchAiSessionState.pending || !batchAiSessionState.selectedItems.size)
            return;
        nextAiSessionBatchArchiveRequestId = nextAiSessionBatchArchiveRequestId >= Number.MAX_SAFE_INTEGER
            ? 1
            : nextAiSessionBatchArchiveRequestId + 1;
        var requestId = nextAiSessionBatchArchiveRequestId;
        batchAiSessionState.pending = true;
        batchAiSessionState.requestId = requestId;
        window.vscode.postMessage({
            type: 'archive-ai-sessions',
            version: 1,
            requestId: requestId,
            projectId: batchAiSessionState.projectId,
            items: Array.from(batchAiSessionState.selectedItems.values()),
        });
    }

    function complete(message) {
        if (!message
            || message.type !== 'ai-session-batch-archive-completed'
            || message.version !== 1
            || !Number.isSafeInteger(message.requestId)
            || message.requestId < 1
            || typeof message.projectId !== 'string'
            || !['cancelled', 'rejected', 'finished'].includes(message.status)
            || !batchAiSessionState.pending
            || message.projectId !== batchAiSessionState.projectId
            || message.requestId !== batchAiSessionState.requestId) {
            return false;
        }
        if (message.status === 'finished') {
            exit();
            return true;
        }
        batchAiSessionState.pending = false;
        batchAiSessionState.requestId = null;
        return true;
    }

    function exit() {
        batchAiSessionState.projectId = null;
        batchAiSessionState.selectedItems = new Map();
        batchAiSessionState.pending = false;
        batchAiSessionState.requestId = null;
    }

    function snapshot() {
        return {
            projectId: batchAiSessionState.projectId,
            selectedItems: Array.from(batchAiSessionState.selectedItems.values()),
            pending: batchAiSessionState.pending,
        };
    }

    var batchAiSessionManager = {
        enter, toggle, selectUnpinned, clear, reconcile, reconcileVisible,
        submit, complete, exit, snapshot,
    };
    window.__agentPivotBatchAiSessions = batchAiSessionManager;

    function openProject(projectId, projectOpenType) {
        window.vscode.postMessage({
            type: 'selected-project',
            projectId,
            projectOpenType,
        });
    }

    function onAddProjectClicked(e) {
        if (!e.target)
            return;

        var projectDiv = e.target.closest('.project');
        if (!projectDiv)
            return;

        var groupId = projectDiv.getAttribute("data-group-id");

        window.vscode.postMessage({
            type: 'add-project',
            groupId,
        });
    }

    function onImportFromOtherStorageClicked(e) {
        if (!e.target)
            return;

        window.vscode.postMessage({
            type: 'import-from-other-storage',
        });
    }

    function onInsideProjectClick(e, projectDiv) {
        projectDiv = projectDiv || e.target.closest(".project");
        var dataId = projectDiv && projectDiv.getAttribute("data-id");
        if (dataId == null)
            return;

        if (onTriggerAiSessionAction(e.target, dataId))
            return;

        if (onTriggerProjectAction(e.target, dataId))
            return;

        if (projectDiv.hasAttribute("data-current-workspace")) {
            if (e.target.closest('[data-ai-session-region]'))
                return;

            toggleCodexSessions(projectDiv, dataId);
            return;
        }

        if (projectDiv.hasAttribute("data-open-workspace-current")) {
            return;
        }

        if (projectDiv.hasAttribute("data-workspace-navigation")) {
            openProject(dataId, ProjectOpenType.Default);
            return;
        }

        var currentWindow = e.ctrlKey || e.metaKey;
        var newWindow = e.button === 1;
        openProject(dataId, currentWindow ? ProjectOpenType.CurrentWindow : newWindow ? ProjectOpenType.NewWindow : ProjectOpenType.Default);

    }

    function onTriggerAiSessionAction(target, projectId) {
        var projectDiv = target.closest('.project[data-id]');
        var tabAction = target.closest('[data-action="select-ai-session-tab"][data-tab]');
        if (tabAction) {
            var selectedTab = normalizeAiSessionTab(tabAction.getAttribute('data-tab'));
            selectAiSessionTabDom(projectDiv, selectedTab);
            writeAiSessionTabState(window.vscode, projectId, selectedTab);
            return true;
        }

        var providerMenuTrigger = target.closest('[data-ai-provider-menu-trigger]');
        if (providerMenuTrigger) {
            toggleAiSessionProviderMenu(projectDiv);
            return true;
        }

        var providerOption = target.closest('[data-ai-provider-option][data-provider]');
        if (providerOption) {
            activateAiSessionProviderOption(projectDiv, providerOption);
            return true;
        }

        var createAction = target.closest('[data-action="create-ai-session"]');
        if (createAction) {
            window.vscode.postMessage({
                type: 'create-ai-session',
                projectId,
            });

            return true;
        }

        var manageAction = target.closest('[data-action="manage-ai-sessions"][data-provider]');
        if (manageAction) {
            if (batchAiSessionState.pending
                || pendingAiSessionProviderSelectionProjectId)
                return true;

            var manageProvider = manageAction.getAttribute("data-provider");
            if (projectDiv && isAiSessionProvider(manageProvider)) {
                if (isActiveAiSessionBatchScope(projectId, manageProvider)) {
                    exitAiSessionBatchManagement();
                } else {
                    batchAiSessionManager.enter(projectId);
                    syncAiSessionBatchManagementDom(projectDiv);
                }
            }

            return true;
        }

        var selectUnpinnedAction = target.closest('[data-action="select-unpinned-ai-sessions"]');
        if (selectUnpinnedAction) {
            if (isActiveAiSessionBatchScope(projectId, getProjectActiveAiSessionProvider(projectDiv))) {
                var sessions = Array.from(projectDiv.querySelectorAll('.ai-session-history-panel .codex-session-row[data-session-id]'))
                    .map(row => ({
                        provider: row.getAttribute("data-session-provider") || "codex",
                        id: row.getAttribute("data-session-id"),
                        pinned: row.hasAttribute("data-session-pinned"),
                        active: row.hasAttribute("data-session-active"),
                    }));
                batchAiSessionManager.selectUnpinned(sessions);
                syncAiSessionBatchManagementDom(projectDiv);
            }

            return true;
        }

        var clearSelectionAction = target.closest('[data-action="clear-ai-session-selection"]');
        if (clearSelectionAction) {
            if (isActiveAiSessionBatchScope(projectId, getProjectActiveAiSessionProvider(projectDiv))) {
                batchAiSessionManager.clear();
                syncAiSessionBatchManagementDom(projectDiv);
            }

            return true;
        }

        var archiveSelectedAction = target.closest('[data-action="archive-selected-ai-sessions"]');
        if (archiveSelectedAction) {
            if (isActiveAiSessionBatchScope(projectId, getProjectActiveAiSessionProvider(projectDiv))) {
                batchAiSessionManager.submit();
                syncAiSessionBatchManagementDom(projectDiv);
            }

            return true;
        }

        var terminalAction = target.closest('[data-action="close-ai-session-terminal"], [data-action="detach-ai-session-terminal"]');
        if (terminalAction) {
            var terminalRow = terminalAction.closest('.codex-session-row[data-session-provider][data-session-backend]');
            var terminalProvider = terminalRow && terminalRow.getAttribute('data-session-provider');
            var terminalBackend = terminalRow && terminalRow.getAttribute('data-session-backend');
            var requestedDetach = terminalAction.getAttribute('data-action') === 'detach-ai-session-terminal';
            if (terminalRow && isAiSessionProvider(terminalProvider)
                && ((requestedDetach && terminalBackend === 'tmux')
                    || (!requestedDetach && terminalBackend === 'vscode'))) {
                var terminalMessage = {
                    type: requestedDetach ? 'detach-ai-session-terminal' : 'close-ai-session-terminal',
                    projectId,
                    provider: terminalProvider,
                };
                if (terminalRow.hasAttribute('data-session-pending')) {
                    terminalMessage.pendingCreatedAt = terminalRow.getAttribute('data-pending-created-at');
                } else {
                    terminalMessage.sessionId = terminalRow.getAttribute('data-session-id');
                }
                window.vscode.postMessage(terminalMessage);
            }
            return true;
        }

        var managedSessionRow = target.closest('.codex-session-row[data-session-id]');
        if (managedSessionRow) {
            var managedSessionProvider = managedSessionRow.getAttribute("data-session-provider") || "codex";
            if (isActiveAiSessionBatchScope(projectId, managedSessionProvider)
                && !managedSessionRow.hasAttribute('data-session-active')) {
                batchAiSessionManager.toggle(
                    managedSessionProvider,
                    managedSessionRow.getAttribute("data-session-id"),
                    managedSessionRow.hasAttribute('data-session-active')
                );
                syncAiSessionBatchManagementDom(projectDiv);
                return true;
            }
        }

        var pinAction = target.closest('[data-action="toggle-ai-session-pin"]');
        if (pinAction) {
            var pinRow = pinAction.closest('.codex-session-row[data-session-id]');
            var pinSessionId = pinRow && pinRow.getAttribute("data-session-id");
            var pinProvider = pinRow && pinRow.getAttribute("data-session-provider") || "codex";
            if (pinSessionId) {
                window.vscode.postMessage({
                    type: 'toggle-ai-session-pin',
                    projectId,
                    provider: pinProvider,
                    sessionId: pinSessionId,
                });
            }

            return true;
        }

        var archiveAction = target.closest('[data-action="archive-codex-session"], [data-action="archive-kimi-session"], [data-action="archive-claude-session"]');
        if (archiveAction) {
            var archiveRow = archiveAction.closest('.codex-session-row[data-session-id]');
            var archiveSessionId = archiveRow && archiveRow.getAttribute("data-session-id");
            var archiveProvider = archiveRow && archiveRow.getAttribute("data-session-provider") || "codex";
            if (archiveSessionId && isAiSessionProvider(archiveProvider)) {
                acknowledgeAiSessionRow(archiveRow);
                window.vscode.postMessage({
                    type: getArchiveAiSessionMessageType(archiveProvider),
                    projectId,
                    sessionId: archiveSessionId,
                });
            }

            return true;
        }

        var activation = getAiSessionCardActivation(target, projectId);
        if (!activation.handled)
            return false;
        if (activation.sessionRow
            && !activation.sessionRow.hasAttribute('data-session-pending')
            && activation.sessionRow.getAttribute('data-session-id')) {
            acknowledgeAiSessionRow(activation.sessionRow);
        }
        if (activation.message) {
            window.vscode.postMessage(activation.message);
        }
        return true;
    }

    function acknowledgeAiSessionRow(sessionRow) {
        if (!sessionRow || !sessionRow.hasAttribute('data-ai-session-attention')) return;
        var provider = sessionRow.getAttribute('data-session-provider') || 'codex';
        var sessionId = sessionRow.getAttribute('data-session-id') || '';
        var fallback = sessionRow.getAttribute('data-session-event-id') || sessionRow.getAttribute('data-ai-session-event-id');
        acknowledgeAiSession(provider, sessionId, fallback);
    }

    function acknowledgeAiSession(provider, sessionId, fallbackEventId) {
        var sessionKey = provider + ':' + sessionId;
        window.__agentPivotAttentionSessionEvents = window.__agentPivotAttentionSessionEvents || {};
        var eventIds = window.__agentPivotAttentionSessionEvents[sessionKey] || [];
        if (!eventIds.length && fallbackEventId) {
            eventIds = [fallbackEventId];
        }
        eventIds = Array.from(new Set(eventIds.filter(eventId => typeof eventId === 'string' && !!eventId)));
        if (eventIds.length) {
            window.vscode.postMessage({ type: 'acknowledge-ai-session-attention', eventIds: eventIds });
        }
    }

    window.__agentPivotAcknowledgeSession = (provider, sessionId) => {
        if (isAiSessionProvider(provider) && sessionId) {
            acknowledgeAiSession(provider, sessionId);
        }
    };

    function getSelectedAiSessionProviders(projectDiv) {
        var region = projectDiv && projectDiv.querySelector('[data-ai-session-region]');
        return (region && region.getAttribute('data-selected-ai-session-providers') || '')
            .split(',')
            .filter(isAiSessionProvider);
    }

    function submitAiSessionProviderSelection(projectDiv, providers) {
        var projectId = projectDiv && projectDiv.getAttribute('data-id');
        if (!projectId || !providers.length || batchAiSessionState.pending
            || pendingAiSessionProviderSelectionProjectId)
            return;

        exitAiSessionBatchManagement();
        nextAiSessionProviderSelectionRequestId += 1;
        var requestId = nextAiSessionProviderSelectionRequestId;
        pendingAiSessionProviderSelectionProjectId = projectId;
        pendingAiSessionProviderSelectionRequestId = requestId;
        pendingAiSessionProviderSelectionProviders = providers.slice();
        syncAiSessionProviderMenuDisabledDom(projectDiv, true);
        window.vscode.postMessage({
            type: 'select-ai-session-providers',
            version: 1,
            requestId: requestId,
            projectId,
            selectedProviders: providers,
        });
    }

    function setAiSessionProviderMenuOpen(projectDiv, open) {
        var trigger = projectDiv && projectDiv.querySelector('[data-ai-provider-menu-trigger]');
        var menu = projectDiv && projectDiv.querySelector('[data-ai-provider-menu]');
        if (!trigger || !menu)
            return;
        if (open && (batchAiSessionState.pending
            || pendingAiSessionProviderSelectionProjectId))
            return;

        trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
        menu.hidden = !open;
    }

    function closeAiSessionProviderMenus(exceptProjectDiv) {
        document.querySelectorAll('.project[data-id]').forEach(projectDiv => {
            if (projectDiv !== exceptProjectDiv) {
                setAiSessionProviderMenuOpen(projectDiv, false);
            }
        });
    }

    function closeAiSessionProviderMenu(projectDiv, restoreFocus) {
        setAiSessionProviderMenuOpen(projectDiv, false);
        if (restoreFocus) {
            projectDiv?.querySelector('[data-ai-provider-menu-trigger]')?.focus();
        }
    }

    function toggleAiSessionProviderMenu(projectDiv) {
        if (!projectDiv || batchAiSessionState.pending
            || pendingAiSessionProviderSelectionProjectId)
            return;
        var trigger = projectDiv.querySelector('[data-ai-provider-menu-trigger]');
        var open = trigger?.getAttribute('aria-expanded') !== 'true';
        closeAiSessionProviderMenus(projectDiv);
        setAiSessionProviderMenuOpen(projectDiv, open);
    }

    function activateAiSessionProviderOption(projectDiv, option) {
        if (!projectDiv || !option || batchAiSessionState.pending
            || pendingAiSessionProviderSelectionProjectId)
            return;
        var provider = option.getAttribute('data-provider');
        if (!isAiSessionProvider(provider))
            return;
        var selectedProviders = getSelectedAiSessionProviders(projectDiv);
        var selected = selectedProviders.includes(provider);
        if (selected && selectedProviders.length === 1)
            return;
        submitAiSessionProviderSelection(
            projectDiv,
            selected
                ? selectedProviders.filter(candidate => candidate !== provider)
                : selectedProviders.concat(provider)
        );
    }

    function getAiSessionProviderOptions(projectDiv) {
        return projectDiv
            ? Array.from(projectDiv.querySelectorAll('[data-ai-provider-option][data-provider]'))
            : [];
    }

    function isAiSessionProvider(provider) {
        return provider === "codex" || provider === "kimi" || provider === "claude";
    }

    function getResumeAiSessionMessageType(provider) {
        if (provider === "kimi")
            return 'resume-kimi-session';
        if (provider === "claude")
            return 'resume-claude-session';

        return 'resume-codex-session';
    }

    function getArchiveAiSessionMessageType(provider) {
        if (provider === "kimi")
            return 'archive-kimi-session';
        if (provider === "claude")
            return 'archive-claude-session';

        return 'archive-codex-session';
    }

    function toggleCodexSessions(projectDiv, projectId) {
        var expanded = !projectDiv.hasAttribute("data-codex-expanded");
        if (!expanded && batchAiSessionState.projectId === projectId) {
            exitAiSessionBatchManagement();
        }
        projectDiv.toggleAttribute("data-codex-expanded", expanded);
        updateStickyGroupHeaderOffset();

        window.vscode.postMessage({
            type: 'toggle-codex-sessions',
            projectId,
            expanded,
        });
    }

    function isActiveAiSessionBatchScope(projectId) {
        return projectId === batchAiSessionState.projectId;
    }

    function getProjectActiveAiSessionProvider(projectDiv) {
        if (!projectDiv)
            return null;

        var region = projectDiv.querySelector('[data-ai-session-region]');
        var activeProvider = region && region.getAttribute('data-active-ai-session-provider');
        if (isAiSessionProvider(activeProvider))
            return activeProvider;

        var selectedProviders = region && region.getAttribute('data-selected-ai-session-providers') || '';
        return selectedProviders.split(',').find(isAiSessionProvider) || null;
    }

    function syncActiveAiSessionTerminalDom() {
        document.querySelectorAll('.codex-session-row[data-session-id]').forEach(row => {
            var provider = row.getAttribute('data-session-provider') || 'codex';
            var sessionId = row.getAttribute('data-session-id');
            row.toggleAttribute(
                'data-ai-session-active-terminal',
                provider === activeAiSessionTerminalState.provider
                    && sessionId === activeAiSessionTerminalState.sessionId
            );
        });
    }

    function syncAiSessionBatchManagementDom(projectDiv) {
        var snapshot = batchAiSessionManager.snapshot();
        document.querySelectorAll('.project[data-ai-session-managing], .project[data-ai-session-pending]').forEach(project => {
            if (project !== projectDiv || project.getAttribute("data-id") !== snapshot.projectId) {
                project.removeAttribute("data-ai-session-managing");
                project.removeAttribute("data-ai-session-pending");
                syncAiSessionProviderMenuDisabledDom(project, false);
                var inactiveManageButton = project.querySelector('[data-action="manage-ai-sessions"]');
                if (inactiveManageButton) {
                    inactiveManageButton.setAttribute('aria-pressed', 'false');
                    inactiveManageButton.disabled = false;
                }
            }
        });

        if (!projectDiv)
            return;

        var projectId = projectDiv.getAttribute("data-id");
        var isScoped = projectId === snapshot.projectId;
        projectDiv.toggleAttribute("data-ai-session-managing", isScoped);
        projectDiv.toggleAttribute("data-ai-session-pending", isScoped && snapshot.pending);
        syncAiSessionProviderMenuDisabledDom(projectDiv, isScoped && snapshot.pending);
        var manageButton = projectDiv.querySelector('[data-action="manage-ai-sessions"]');
        if (manageButton) {
            manageButton.setAttribute('aria-pressed', isScoped ? 'true' : 'false');
            manageButton.disabled = isScoped && snapshot.pending;
        }

        var selectedItems = new Set(snapshot.selectedItems.map(item =>
            getAiSessionBatchItemKey(item.provider, item.sessionId)
        ));
        projectDiv.querySelectorAll('.ai-session-history-panel .codex-session-row[data-session-id]').forEach(row => {
            var rowProvider = row.getAttribute("data-session-provider") || "codex";
            var isActive = row.hasAttribute('data-session-active');
            var isSelected = isScoped
                && !isActive
                && selectedItems.has(getAiSessionBatchItemKey(
                    rowProvider,
                    row.getAttribute("data-session-id")
                ));
            row.toggleAttribute("data-ai-session-selected", isSelected);
            var checkbox = row.querySelector('.ai-session-batch-checkbox');
            if (checkbox) {
                checkbox.checked = isSelected;
                checkbox.disabled = isActive || (isScoped && snapshot.pending);
            }
        });

        var count = isScoped ? snapshot.selectedItems.length : 0;
        var countElement = projectDiv.querySelector('.ai-session-batch-count');
        if (countElement) {
            countElement.textContent = count + ' selected';
        }
        projectDiv.querySelectorAll('.ai-session-batch-actions button').forEach(button => {
            button.disabled = isScoped && snapshot.pending;
        });
        var archiveButton = projectDiv.querySelector('[data-action="archive-selected-ai-sessions"]');
        if (archiveButton) {
            archiveButton.disabled = !isScoped || snapshot.pending || count === 0;
        }
    }

    function syncAiSessionProviderMenuDisabledDom(projectDiv, batchPending) {
        var projectId = projectDiv?.getAttribute('data-id');
        var providerSelectionPending = projectId
            === pendingAiSessionProviderSelectionProjectId;
        var pending = Boolean(
            batchPending || batchAiSessionState.pending || providerSelectionPending
        );
        var trigger = projectDiv && projectDiv.querySelector('[data-ai-provider-menu-trigger]');
        if (trigger) {
            trigger.disabled = pending;
            trigger.setAttribute('aria-disabled', pending ? 'true' : 'false');
        }
        var selectedProviders = getSelectedAiSessionProviders(projectDiv);
        getAiSessionProviderOptions(projectDiv).forEach(option => {
            var provider = option.getAttribute('data-provider');
            var lastSelectedProvider = selectedProviders.length === 1
                && selectedProviders[0] === provider;
            option.disabled = pending;
            option.setAttribute(
                'aria-disabled',
                pending || lastSelectedProvider ? 'true' : 'false'
            );
        });
        if (pending) {
            closeAiSessionProviderMenu(projectDiv, false);
        }
    }

    function clearPendingAiSessionProviderSelection() {
        pendingAiSessionProviderSelectionProjectId = null;
        pendingAiSessionProviderSelectionRequestId = null;
        pendingAiSessionProviderSelectionProviders = [];
    }

    function selectedAiSessionProvidersMatch(projectDiv, expectedProviders) {
        var selectedProviders = getSelectedAiSessionProviders(projectDiv);
        return selectedProviders.length === expectedProviders.length
            && selectedProviders.every(provider =>
                expectedProviders.includes(provider)
            );
    }

    function reconcilePendingAiSessionProviderSelectionDom() {
        if (!pendingAiSessionProviderSelectionProjectId)
            return;
        var projectDiv = findCurrentWorkspaceDiv(
            pendingAiSessionProviderSelectionProjectId
        );
        if (!projectDiv)
            return;
        if (selectedAiSessionProvidersMatch(
            projectDiv,
            pendingAiSessionProviderSelectionProviders
        )) {
            clearPendingAiSessionProviderSelection();
        }
        syncAiSessionProviderMenuDisabledDom(projectDiv, false);
    }

    function applyAiSessionProviderSelectionResult(message) {
        if (!message
            || message.type !== 'ai-session-provider-selection-result'
            || message.version !== 1
            || !Number.isSafeInteger(message.requestId)
            || message.requestId < 1
            || typeof message.projectId !== 'string'
            || typeof message.success !== 'boolean'
            || message.projectId !== pendingAiSessionProviderSelectionProjectId
            || message.requestId !== pendingAiSessionProviderSelectionRequestId) {
            return false;
        }
        if (message.success) {
            return true;
        }

        var projectDiv = findCurrentWorkspaceDiv(message.projectId);
        clearPendingAiSessionProviderSelection();
        syncAiSessionProviderMenuDisabledDom(projectDiv, false);
        var liveRegion = projectDiv?.querySelector('[data-ai-session-live-region]');
        if (liveRegion) {
            liveRegion.textContent = 'Could not update AI session providers. Try again.';
        }
        return true;
    }

    function exitAiSessionBatchManagement() {
        var projectId = batchAiSessionState.projectId;
        batchAiSessionManager.exit();
        syncAiSessionBatchManagementDom(findCurrentWorkspaceDiv(projectId));
    }

    function onInsideGroupClick(e, groupDiv) {
        var groupId = groupDiv.getAttribute("data-group-id");
        if (groupId == null)
            return;

        var actionDiv = e.target.closest('[data-action]')
        var action = actionDiv != null ? actionDiv.getAttribute("data-action") : null;
        if (!action)
            return;

        if (action === "add") {
            window.vscode.postMessage({
                type: 'add-project',
                groupId: groupId,
            });

            return;
        }

        var collapsed = groupDiv.classList.contains("collapsed");
        if (action === "collapse") {
            groupDiv.classList.toggle("collapsed");
            collapsed = groupDiv.classList.contains("collapsed");
        }

        window.vscode.postMessage({
            type: action + '-group',
            groupId: groupId,
            collapsed,
        });
        syncCollapseButton();
    }

    function onTodoAction(e) {
        var addTodoAction = e.target.closest('[data-action="todo-add"]');
        if (addTodoAction && !addTodoAction.closest('.todo-add-form')) {
            setTodoAddFormVisible(true, addTodoAction.getAttribute('data-group-id'));
            return true;
        }

        var addGroupAction = e.target.closest('[data-action="todo-add-group"]');
        if (addGroupAction) {
            window.vscode.postMessage({
                type: 'todo-add-group',
            });
            return true;
        }

        var toggleAction = e.target.closest('[data-action="todo-toggle"]');
        if (toggleAction) {
            window.vscode.postMessage({
                type: 'todo-toggle',
                todoId: toggleAction.getAttribute('data-todo-id'),
                completed: toggleAction.checked === true,
            });
            return true;
        }

        var deleteAction = e.target.closest('[data-action="todo-delete"]');
        if (deleteAction) {
            window.vscode.postMessage({
                type: 'todo-delete',
                todoId: deleteAction.getAttribute('data-todo-id'),
            });
            return true;
        }

        var deleteGroupAction = e.target.closest('[data-action="todo-delete-group"]');
        if (deleteGroupAction) {
            window.vscode.postMessage({
                type: 'todo-delete-group',
                groupId: deleteGroupAction.getAttribute('data-group-id'),
            });
            return true;
        }

        var renameGroupAction = e.target.closest('[data-action="todo-rename-group"]');
        if (renameGroupAction) {
            window.vscode.postMessage({
                type: 'todo-rename-group',
                groupId: renameGroupAction.getAttribute('data-group-id'),
            });
            return true;
        }

        var collapseGroupAction = e.target.closest('[data-action="todo-collapse-group"]');
        if (collapseGroupAction) {
            var todoGroup = collapseGroupAction.closest('.todo-group');
            if (!todoGroup)
                return true;
            todoGroup.classList.toggle('collapsed');
            syncTodoGroupCollapseControl(todoGroup);
            window.vscode.postMessage({
                type: 'todo-collapse-group',
                groupId: todoGroup.getAttribute('data-todo-group-id'),
                collapsed: todoGroup.classList.contains('collapsed'),
            });
            syncCollapseButton();
            return true;
        }

        var sortAction = e.target.closest('[data-action="todo-sort-priority"]');
        if (sortAction) {
            window.vscode.postMessage({
                type: 'todo-sort-priority',
                groupId: sortAction.getAttribute('data-group-id'),
            });
            return true;
        }

        var showCompletedAction = e.target.closest('[data-action="todo-toggle-show-completed"]');
        if (showCompletedAction) {
            window.vscode.postMessage({
                type: 'todo-toggle-show-completed',
                showCompleted: showCompletedAction.checked === true,
            });
            return true;
        }

        var focusAddAction = e.target.closest('[data-action="todo-focus-add"]');
        if (focusAddAction) {
            setTodoAddFormVisible(true, focusAddAction.getAttribute('data-group-id'));
            return true;
        }

        var cancelAddAction = e.target.closest('[data-action="todo-cancel-add"]');
        if (cancelAddAction) {
            setTodoAddFormVisible(false);
            return true;
        }

        var editAction = e.target.closest('[data-action="todo-edit"]');
        if (editAction) {
            setTodoEditing(editAction.getAttribute('data-todo-id'), true);
            return true;
        }

        var expandAction = e.target.closest('[data-action="todo-toggle-expanded"]');
        if (expandAction) {
            toggleTodoItemExpanded(expandAction.closest('.todo-item'));
            return true;
        }

        var cancelEditAction = e.target.closest('[data-action="todo-cancel-edit"]');
        if (cancelEditAction) {
            setTodoEditing(cancelEditAction.getAttribute('data-todo-id'), false);
            return true;
        }

        return false;
    }

    function syncTodoPrioritySegment(segment) {
        if (!segment)
            return;

        Array.from(segment.querySelectorAll('.todo-priority-choice')).forEach(choice => {
            var input = choice.querySelector('input[name="priority"]');
            choice.classList.toggle('active', !!input && input.checked === true);
        });
    }

    function resetTodoEditForm(form) {
        form.reset();
        syncTodoPrioritySegment(form.querySelector('.todo-priority-segment'));
    }

    function syncTodoListExpandedHeight(list) {
        if (!list)
            return;

        var panel = list.closest('.todo-panel');
        var collapsedHeightValue = panel
            ? getComputedStyle(panel).getPropertyValue('--todo-collapsed-item-height')
            : '';
        var collapsedHeight = parseFloat(collapsedHeightValue) || 58;
        var expandedExtraHeight = Array.from(list.querySelectorAll('.todo-item.expanded'))
            .reduce((total, expandedItem) => total + Math.max(0, expandedItem.offsetHeight - collapsedHeight), 0);
        list.style.setProperty('--todo-list-expanded-extra-height', expandedExtraHeight + 'px');
    }

    function toggleTodoItemExpanded(item, expanded) {
        if (!item)
            return;

        var nextExpanded = typeof expanded === 'boolean'
            ? expanded
            : !item.classList.contains('expanded');
        item.classList.toggle('expanded', nextExpanded);
        syncTodoExpandControl(item, nextExpanded);
        syncTodoListExpandedHeight(item.closest('.todo-list'));
    }

    function isTodoInteractiveTarget(target) {
        return !!(target && target.closest && target.closest('button, input, textarea, select, label, a, [data-action], .todo-edit-form'));
    }

    function setTodoAddFormVisible(visible, groupId) {
        var form = document.querySelector('.todo-add-form');
        if (!form)
            return;

        var groupSelect = form.querySelector('[name="groupId"]');
        if (visible && groupSelect) {
            groupSelect.value = groupId || '';
        }
        form.hidden = !visible;
        if (!visible)
            return;

        var titleInput = form.querySelector('[name="title"]');
        if (titleInput) {
            titleInput.focus();
        }
        form.scrollIntoView({ block: 'nearest' });
    }

    function setTodoEditing(todoId, editing) {
        if (!todoId)
            return;

        var item = Array.from(document.querySelectorAll('.todo-item[data-todo-id]'))
            .find(candidate => candidate.getAttribute('data-todo-id') === todoId);
        if (!item)
            return;

        var wasEditing = item.classList.contains('editing');
        var expandedBeforeEdit = item.getAttribute('data-expanded-before-edit');
        if (editing && !wasEditing) {
            item.setAttribute(
                'data-expanded-before-edit',
                item.classList.contains('expanded') ? 'true' : 'false'
            );
            expandedBeforeEdit = item.getAttribute('data-expanded-before-edit');
        }
        var view = item.querySelector('.todo-item-view');
        var form = item.querySelector('.todo-edit-form');
        var list = item.closest('.todo-list');
        if (form && !editing) {
            resetTodoEditForm(form);
        }
        item.classList.toggle('editing', editing);
        if (view) {
            view.hidden = false;
        }
        if (form) {
            form.hidden = !editing;
        }
        toggleTodoItemExpanded(item, editing ? true : expandedBeforeEdit === 'true');
        if (!editing) {
            item.removeAttribute('data-expanded-before-edit');
        }
        if (list) {
            list.classList.toggle('has-editing-item', !!list.querySelector('.todo-item.editing'));
        }
        if (form && editing) {
            var titleInput = form.querySelector('[name="title"]');
            if (titleInput) {
                titleInput.focus();
            }
            item.scrollIntoView({ block: 'nearest' });
        }
    }

    function onTodoFormSubmit(e) {
        if (window.__agentPivotTodo
            && e.target
            && e.target.closest
            && e.target.closest('#dashboard-tab-todo')) {
            return;
        }
        var addForm = e.target && e.target.closest ? e.target.closest('.todo-add-form') : null;
        if (addForm) {
            e.preventDefault();
            submitTodoComposeForm(addForm, message => window.vscode.postMessage(message));
            return;
        }

        var editForm = e.target && e.target.closest ? e.target.closest('.todo-edit-form') : null;
        if (editForm) {
            e.preventDefault();
            var todoId = editForm.getAttribute('data-todo-id');
            var editTitle = getTodoFormValue(editForm, 'title');
            if (!todoId || !editTitle)
                return;
            window.vscode.postMessage({
                type: 'todo-update',
                todoId,
                title: editTitle,
                notes: getTodoFormValue(editForm, 'notes'),
                priority: getTodoFormValue(editForm, 'priority'),
            });
        }
    }

    function onTriggerProjectAction(target, projectId) {
        var actionDiv = target.closest('[data-action]')
        if (actionDiv == null)
            return false;

        var action = actionDiv.getAttribute("data-action");
        if (!action)
            return false;

        if (action === 'save-current-workspace') {
            window.vscode.postMessage({
                type: 'save-current-workspace',
                projectId,
            });
            return true;
        }

        if (action === 'toggle-open-workspace-pin') {
            requestOpenWorkspacePin(actionDiv, projectId);
            return true;
        }

        window.vscode.postMessage({
            type: action + '-project',
            projectId,
        });

        return true;
    }

    var contextMenuProjectId = null;
    var contextMenuGroupId = null;
    var contextMenuAiSessionId = null;
    var contextMenuAiSessionProvider = null;
    var contextMenuAiSessionProjectId = null;
    var contextMenuAiSessionActive = false;
    var contextMenuAiSessionBackend = null;
    var contextMenuAiSessionConflict = false;
    var contextMenuAiSessionOrigin = null;
    var latestAiSessionUpdateSequence = 0;

    function showContextMenu(contextMenuElement, e) {
        contextMenuElement.style.visibility = "hidden";
        contextMenuElement.style.left = "0px";
        contextMenuElement.style.top = "0px";
        contextMenuElement.classList.add("visible");

        var rect = contextMenuElement.getBoundingClientRect();
        var viewportPadding = 4;
        var left = e.clientX;
        var top = e.clientY;

        if (left + rect.width + viewportPadding > window.innerWidth) {
            left = Math.max(viewportPadding, window.innerWidth - rect.width - viewportPadding);
        }

        if (top + rect.height + viewportPadding > window.innerHeight) {
            top = Math.max(viewportPadding, window.innerHeight - rect.height - viewportPadding);
        }

        contextMenuElement.style.left = left + "px";
        contextMenuElement.style.top = top + "px";
        contextMenuElement.style.visibility = "";
    }

    function onContextMenu(e) {
        closeContextMenus(); // Close previews

        var sessionRow = e.target.closest('.codex-session-row[data-session-id][data-session-provider]');
        if (sessionRow) {
            contextMenuAiSessionOrigin = sessionRow.querySelector('.ai-session-primary-action') || sessionRow;
            contextMenuAiSessionId = sessionRow.getAttribute("data-session-id");
            contextMenuAiSessionProvider = sessionRow.getAttribute("data-session-provider");
            var sessionProjectDiv = sessionRow.closest('.project[data-id]');
            contextMenuAiSessionProjectId = sessionProjectDiv ? sessionProjectDiv.getAttribute("data-id") : null;
            contextMenuAiSessionActive = sessionRow.hasAttribute('data-session-active');
            contextMenuAiSessionBackend = sessionRow.getAttribute('data-session-backend') || 'vscode';
            contextMenuAiSessionConflict = sessionRow.hasAttribute('data-session-conflict');
            if (!contextMenuAiSessionId || !isAiSessionProvider(contextMenuAiSessionProvider))
                return;

            e.preventDefault();
            var sessionContextMenuElement = document.getElementById("aiSessionContextMenu");
            if (!sessionContextMenuElement)
                return;
            sessionContextMenuElement.querySelectorAll(':scope > *').forEach(element => element.classList.remove('disabled'));
            var archiveMenuItem = sessionContextMenuElement.querySelector('[data-action="archive"]');
            var closeMenuItem = sessionContextMenuElement.querySelector('[data-action="close-terminal"]');
            if (archiveMenuItem) archiveMenuItem.classList.toggle('disabled', contextMenuAiSessionActive);
            if (closeMenuItem) {
                var terminalActionLabel = contextMenuAiSessionBackend === 'tmux'
                    ? 'Detach Terminal…' : 'Close Terminal…';
                closeMenuItem.textContent = terminalActionLabel;
                closeMenuItem.setAttribute('aria-label', terminalActionLabel);
                closeMenuItem.toggleAttribute('hidden', contextMenuAiSessionConflict);
                closeMenuItem.classList.toggle(
                    'disabled', !contextMenuAiSessionActive || contextMenuAiSessionConflict
                );
            }

            showContextMenu(sessionContextMenuElement, e);
            if (e.keyboardTrigger) {
                var firstMenuItem = sessionContextMenuElement.querySelector('.custom-context-menu-item[data-action]:not(.disabled)');
                firstMenuItem?.focus();
            }
            return;
        }

        var projectDiv = e.target.closest('.project[data-id]');
        var groupDiv = e.target.closest('.group-title')
        if (!projectDiv && !groupDiv)
            return;

        if (projectDiv && projectDiv.hasAttribute("data-readonly-project"))
            return;

        e.preventDefault();

        let contextMenuForProject = projectDiv != null;
        var contextMenuElement;
        if (contextMenuForProject) {
            contextMenuProjectId = projectDiv.getAttribute("data-id");
            if (contextMenuProjectId == null)
                return;

            contextMenuElement = document.getElementById("projectContextMenu");
        } else {
            let groupIdDiv = groupDiv.closest(".group[data-group-id]");
            if (groupIdDiv && groupIdDiv.hasAttribute("data-virtual-group"))
                return;

            contextMenuGroupId = groupIdDiv ? groupIdDiv.getAttribute("data-group-id") : null;
            if (contextMenuGroupId == null)
                return;

            contextMenuElement = document.getElementById("groupContextMenu");
        }

        // disable elements if needed
        contextMenuElement.querySelectorAll(":scope > *").forEach(e => e.classList.remove("disabled"));

        if (projectDiv && projectDiv.hasAttribute("data-is-remote")) {
            contextMenuElement.querySelectorAll(".not-remote").forEach(e => e.classList.add("disabled"));
        }

        // place and show contextmenu

        showContextMenu(contextMenuElement, e);
    }

    function onProjectContextMenuActionClicked(el) {
        var action = el.getAttribute("data-action");

        if (action == null || contextMenuProjectId == null)
            return;

        switch (action) {
            case 'open':
                openProject(contextMenuProjectId, ProjectOpenType.CurrentWindow);
                break;
            case 'open-add-to-workspace':
                openProject(contextMenuProjectId, ProjectOpenType.AddToWorkspace);
                break;
            default:
                window.vscode.postMessage({
                    type: action + '-project',
                    projectId: contextMenuProjectId,
                });
                break;
        }

        closeContextMenus();
    }

    function onGroupContextMenuActionClicked(el) {
        var action = el.getAttribute("data-action");

        if (action == null || contextMenuGroupId == null)
            return;

        switch (action) {
            case 'add':
                window.vscode.postMessage({
                    type: 'add-project',
                    groupId: contextMenuGroupId,
                });
                break;
            default:
                window.vscode.postMessage({
                    type: action + '-group',
                    groupId: contextMenuGroupId,
                });
                break;
        }

        closeContextMenus();
    }

    function onAiSessionContextMenuActionClicked(el) {
        var action = el.getAttribute("data-action");
        var origin = contextMenuAiSessionOrigin;

        if (action == null || contextMenuAiSessionId == null || contextMenuAiSessionProvider == null)
            return;

        switch (action) {
            case 'resume':
                window.vscode.postMessage(contextMenuAiSessionActive ? {
                    type: 'focus-ai-session-terminal',
                    provider: contextMenuAiSessionProvider,
                    projectId: contextMenuAiSessionProjectId,
                    sessionId: contextMenuAiSessionId,
                } : {
                    type: getResumeAiSessionMessageType(contextMenuAiSessionProvider),
                    provider: contextMenuAiSessionProvider,
                    projectId: contextMenuAiSessionProjectId,
                    sessionId: contextMenuAiSessionId,
                });
                break;
            case 'rename':
                window.vscode.postMessage({
                    type: 'rename-ai-session',
                    provider: contextMenuAiSessionProvider,
                    sessionId: contextMenuAiSessionId,
                });
                break;
            case 'copy-id':
                window.vscode.postMessage({
                    type: 'copy-ai-session-id',
                    provider: contextMenuAiSessionProvider,
                    sessionId: contextMenuAiSessionId,
                });
                break;
            case 'pin':
                window.vscode.postMessage({
                    type: 'toggle-ai-session-pin',
                    provider: contextMenuAiSessionProvider,
                    sessionId: contextMenuAiSessionId,
                });
                break;
            case 'archive':
                if (contextMenuAiSessionActive) break;
                window.vscode.postMessage({
                    type: getArchiveAiSessionMessageType(contextMenuAiSessionProvider),
                    projectId: contextMenuAiSessionProjectId,
                    provider: contextMenuAiSessionProvider,
                    sessionId: contextMenuAiSessionId,
                });
                break;
            case 'close-terminal':
                if (!contextMenuAiSessionActive || contextMenuAiSessionConflict) break;
                window.vscode.postMessage({
                    type: contextMenuAiSessionBackend === 'tmux'
                        ? 'detach-ai-session-terminal' : 'close-ai-session-terminal',
                    projectId: contextMenuAiSessionProjectId,
                    provider: contextMenuAiSessionProvider,
                    sessionId: contextMenuAiSessionId,
                });
                break;
        }

        closeContextMenus();
        origin?.focus();
    }

    function closeContextMenus() {
        contextMenuProjectId = null;
        contextMenuGroupId = null;
        contextMenuAiSessionId = null;
        contextMenuAiSessionProvider = null;
        contextMenuAiSessionProjectId = null;
        contextMenuAiSessionActive = false;
        contextMenuAiSessionBackend = null;
        contextMenuAiSessionConflict = false;
        contextMenuAiSessionOrigin = null;
        // Only close menus this script owns; the dashboard script owns the
        // skill folder menu and keeps it open across per-agent toggles.
        document.querySelectorAll(".custom-context-menu:not(.skill-folder-menu)").forEach(element =>
            element.classList.remove("visible")
        );
    }

    function updateToggleAllGroupsButton(state) {
        document.body.classList.toggle("steward-all-collapsed", state.collapsed);
        var button = document.querySelector('[data-action="toggle-all-groups"]');
        if (!button)
            return;

        button.disabled = state.disabled;
        button.setAttribute('aria-disabled', state.disabled ? 'true' : 'false');
        button.setAttribute("title", state.title);
        button.setAttribute("aria-label", state.title);
    }

    function getActiveDashboardTab() {
        var dashboard = window.__agentPivotDashboard;
        var selectedTab = !dashboard && document.querySelector
            ? document.querySelector('[data-dashboard-tab][aria-selected="true"]')
            : null;
        var activeTab = dashboard && typeof dashboard.getActiveTab === 'function'
            ? dashboard.getActiveTab()
            : selectedTab && selectedTab.getAttribute('data-dashboard-tab');
        return activeTab === 'projects' || activeTab === 'todo' || activeTab === 'ai'
            ? activeTab
            : 'open';
    }

    function getActiveCollapsibleGroups() {
        var activeTab = getActiveDashboardTab();
        var selector = activeTab === 'projects'
            ? '#dashboard-tab-projects .group[data-group-id]'
            : activeTab === 'todo'
                ? '#dashboard-tab-todo .todo-group[data-todo-group-id]'
                : activeTab === 'open'
                    ? '#dashboard-tab-open .open-other-windows-group[data-group-id]'
                    : null;
        if (!selector) {
            return [];
        }
        return [...document.querySelectorAll(selector)];
    }

    function setGroupCollapsed(group, collapsed, persist) {
        group.classList.toggle('collapsed', collapsed);
        if (persist) {
            var isTodoGroup = group.classList.contains('todo-group');
            window.vscode.postMessage({
                type: isTodoGroup ? 'todo-collapse-group' : 'collapse-group',
                groupId: isTodoGroup
                    ? group.getAttribute('data-todo-group-id')
                    : group.getAttribute('data-group-id'),
                collapsed,
            });
        }
    }

    function syncCollapseButton() {
        var activeTab = getActiveDashboardTab();
        var groups = getActiveCollapsibleGroups();
        updateToggleAllGroupsButton(getCollapseButtonState(
            activeTab,
            groups.map(group => group.classList.contains('collapsed'))
        ));
    }

    function toggleAllGroups() {
        var activeTab = getActiveDashboardTab();
        var groups = getActiveCollapsibleGroups();
        var shouldCollapse = groups.some(group => !group.classList.contains("collapsed"));

        if (activeTab === 'todo') {
            if (window.__agentPivotTodo
                && typeof window.__agentPivotTodo.dispatch === 'function') {
                window.__agentPivotTodo.dispatch('collapse-groups', { collapsed: shouldCollapse });
            } else {
                collapseTodoGroups(groups, shouldCollapse, message => window.vscode.postMessage(message));
            }
            syncCollapseButton();
            return;
        }

        groups.forEach(group => setGroupCollapsed(group, shouldCollapse, true));
        syncCollapseButton();
    }

    window.__agentPivotSyncCollapseButton = syncCollapseButton;

    function onMouseEvent(e) {
        if (!e.target || e.target.closest(".disabled"))
            return;
        if (isDedicatedTodoTarget(e.target))
            return;

        var contextMenuElement = e.target.closest("#projectContextMenu [data-action]");
        if (contextMenuElement) {
            onProjectContextMenuActionClicked(contextMenuElement);
            return;
        }

        contextMenuElement = e.target.closest("#aiSessionContextMenu [data-action]");
        if (contextMenuElement) {
            onAiSessionContextMenuActionClicked(contextMenuElement);
            return;
        }

        contextMenuElement = e.target.closest("#groupContextMenu [data-action]");
        if (contextMenuElement) {
            onGroupContextMenuActionClicked(contextMenuElement);
            return;
        }

        closeContextMenus();
        if (!e.target.closest('.ai-session-provider-menu-wrapper')) {
            closeAiSessionProviderMenus();
        }

        if (e.target.closest('[data-action="toggle-all-groups"]')) {
            toggleAllGroups();
            return;
        }

        if (e.target.closest('[data-action="open-settings"]')) {
            window.vscode.postMessage({
                type: 'open-settings'
            });
            return;
        }

        if (e.target.closest('[data-action="open-bridge-extension"]')) {
            window.vscode.postMessage({
                type: 'open-bridge-extension'
            });
            return;
        }

        if (e.target.closest('[data-action="add-group"]')) {
            window.vscode.postMessage({
                type: 'add-group'
            });
            return;
        }

        if (e.target.closest('[data-action="add-project"]')) {
            onAddProjectClicked(e);
            return;
        }

        if (e.target.closest('[data-action="import-from-other-storage"]')) {
            onImportFromOtherStorageClicked(e);
            return;
        }

        if (onTodoAction(e)) {
            return;
        }

        var todoItem = e.target.closest('.todo-item[data-todo-id]');
        if (todoItem && !todoItem.classList.contains('editing') && !isTodoInteractiveTarget(e.target)) {
            toggleTodoItemExpanded(todoItem);
            return;
        }

        var projectDiv = e.target.closest('.project');
        if (projectDiv) {
            onInsideProjectClick(e, projectDiv);
            return;
        }

        var groupDiv = e.target.closest('.group');
        if (groupDiv) {
            onInsideGroupClick(e, groupDiv);
            return;
        }
    }

    function onChangeEvent(e) {
        if (!e.target)
            return;
        if (isDedicatedTodoTarget(e.target))
            return;

        var todoPriorityInput = e.target.closest('.todo-priority-choice input[name="priority"]');
        if (todoPriorityInput) {
            syncTodoPrioritySegment(todoPriorityInput.closest('.todo-priority-segment'));
            return;
        }

    }

    function updateStickyGroupHeaderOffset() {
        window.requestAnimationFrame(() => {
            var stickyHeader = document.querySelector('.steward-sticky-header');
            var offset = stickyHeader ? Math.ceil(stickyHeader.getBoundingClientRect().height) : 0;
            document.body.style.setProperty('--steward-sticky-header-height', offset + 'px');
        });
    }

    function onWindowMessage(e) {
        var message = e && e.data;
        if (message
            && message.type === 'focus-ai-session-conversation-origin') {
            focusAiSessionConversationOrigin(message);
            return;
        }
        if (message && message.type === 'todo-mutation-result') {
            applyTodoMutationResult(message, document);
            return;
        }
        if (message && message.type === 'ai-session-provider-selection-result') {
            applyAiSessionProviderSelectionResult(message);
            return;
        }
        if (message && (message.type === 'todo-panel-content' || message.type === 'todo-panel-updated')) {
            window.setTimeout(() => {
                var todoRoot = document.querySelector('#dashboard-tab-todo');
                if (todoRoot && typeof initDnD === 'function' && typeof disposeDnD === 'function') {
                    disposeDnD(todoRoot);
                    initDnD(todoRoot);
                    syncCollapseButton();
                }
            }, 0);
        }
        if (message && message.type === 'workspace-updated') {
            if (!applyWorkspaceUpdate(message, {
                canRestoreAiSessionProviderMenu: () =>
                    !pendingAiSessionProviderSelectionProjectId
                    && !batchAiSessionState.pending,
            })) {
                requestFullRefresh('invalid-workspace-update');
                return;
            }
            if (batchAiSessionState.projectId) {
                var managedProjectDiv = findCurrentWorkspaceDiv(batchAiSessionState.projectId);
                if (managedProjectDiv) {
                    batchAiSessionManager.reconcileVisible(managedProjectDiv);
                    syncAiSessionBatchManagementDom(managedProjectDiv);
                } else {
                    exitAiSessionBatchManagement();
                }
            }
            reconcilePendingAiSessionProviderSelectionDom();
            syncActiveAiSessionTerminalDom();
            updateStickyGroupHeaderOffset();
            var renderedWorkspaceState = getWorkspaceUpdateDomState(document);
            window.vscode.postMessage({
                type: 'workspace-rendered',
                version: 2,
                currentWorkspaceCount: renderedWorkspaceState.currentWorkspaceCount,
            });
            return;
        }
        if (message && message.type === 'open-workspaces-updated') {
            if (!applyOpenWorkspacesUpdate(message)) {
                requestFullRefresh('invalid-open-workspaces-update');
                return;
            }
            syncActiveAiSessionTerminalDom();
            updateStickyGroupHeaderOffset();
            var renderedOpenWorkspaceState = getOpenWorkspacesUpdateDomState();
            window.vscode.postMessage({
                type: 'open-workspaces-rendered',
                version: 2,
                semanticRevision: message.semanticRevision,
                currentWorkspaceCount: renderedOpenWorkspaceState.currentWorkspaceCount,
                navigationWorkspaceCount: renderedOpenWorkspaceState.navigationWorkspaceCount,
                hasOtherWindowsGroup: renderedOpenWorkspaceState.hasOtherWindowsGroup,
                otherWindowsStatus: renderedOpenWorkspaceState.otherWindowsStatus,
            });
            return;
        }
        if (message && message.type === 'open-workspace-pin-result') {
            completeOpenWorkspacePin(message);
            return;
        }
        if (message && message.type === 'ai-session-tab-selection-requested') {
            var requestedProject = findCurrentWorkspaceDiv(message.projectId);
            if (requestedProject && (message.tab === 'active' || message.tab === 'sessions')) {
                selectAiSessionTabDom(requestedProject, message.tab);
                writeAiSessionTabState(window.vscode, message.projectId, message.tab);
            }
            return;
        }

        if (message && message.type === 'ai-session-status-announcement') {
            var announcementProject = findCurrentWorkspaceDiv(message.projectId);
            var announcement = typeof message.message === 'string' ? message.message.trim().slice(0, 256) : '';
            var announcementRegion = announcementProject && announcementProject.querySelector('[data-ai-session-live-region]');
            if (announcementRegion && announcement) announcementRegion.textContent = announcement;
            return;
        }

        if (message && message.type === 'active-ai-session-terminal-changed') {
            activeAiSessionTerminalState.provider = isAiSessionProvider(message.provider) ? message.provider : null;
            activeAiSessionTerminalState.sessionId = typeof message.sessionId === 'string' ? message.sessionId : null;
            syncActiveAiSessionTerminalDom();
            return;
        }

        if (message && message.type === 'ai-session-attention-state') {
            window.__agentPivotAttentionEvents = window.__agentPivotAttentionEvents || {};
            window.__agentPivotAttentionSessionEvents = {};
            (Array.isArray(message.sessionEvents) ? message.sessionEvents.slice(0, 1000) : []).forEach(session => {
                if (!session || typeof session.sessionKey !== 'string' || !Array.isArray(session.eventIds)) return;
                var separator = session.sessionKey.indexOf(':');
                if (separator <= 0 || !isAiSessionProvider(session.sessionKey.slice(0, separator))) return;
                var eventIds = Array.from(new Set(session.eventIds
                    .slice(0, 1000)
                    .filter(eventId => typeof eventId === 'string' && !!eventId)));
                if (eventIds.length) window.__agentPivotAttentionSessionEvents[session.sessionKey] = eventIds;
            });
            (message.eventIds || []).forEach(eventId => {
                if (typeof eventId === 'string') window.__agentPivotAttentionEvents[eventId] = true;
            });
            return;
        }

        if (message && message.type === 'ai-session-batch-archive-completed') {
            if (batchAiSessionManager.complete(message)) {
                var completedProject = findCurrentWorkspaceDiv(message.projectId);
                syncAiSessionBatchManagementDom(completedProject);
                var archiveLiveRegion = completedProject
                    && completedProject.querySelector('[data-ai-session-live-region]');
                if (archiveLiveRegion) {
                    archiveLiveRegion.textContent =
                        getAiSessionBatchArchiveAnnouncement(message);
                }
            }
            return;
        }

        if (!message || message.type !== 'ai-sessions-updated') {
            return;
        }

        applyAiSessionsUpdate(message);
    }

    function applyAiSessionsUpdate(message) {
        if (message.version !== 2
            || typeof message.sequence !== 'number'
            || (message.currentWorkspaceCount !== 0 && message.currentWorkspaceCount !== 1)
            || typeof message.html !== 'string'
            || typeof normalizeDashboardSearchCatalog !== 'function'
            || normalizeDashboardSearchCatalog(message.searchCatalog) !== message.searchCatalog
            || message.searchCatalog.version !== 2) {
            requestFullRefresh('unsupported-ai-session-message');
            return;
        }

        if (message.sequence <= latestAiSessionUpdateSequence) {
            return;
        }

        if (!applyWorkspaceUpdate({
            type: 'workspace-updated',
            version: 2,
            currentWorkspaceCount: message.currentWorkspaceCount,
            html: message.html,
        }, {
            canRestoreAiSessionProviderMenu: () =>
                !pendingAiSessionProviderSelectionProjectId
                && !batchAiSessionState.pending,
        })) {
            requestFullRefresh('invalid-ai-session-workspace-update');
            return;
        }

        latestAiSessionUpdateSequence = message.sequence;
        if (batchAiSessionState.projectId) {
            var projectDiv = findCurrentWorkspaceDiv(batchAiSessionState.projectId);
            if (projectDiv) {
                batchAiSessionManager.reconcileVisible(projectDiv);
                syncAiSessionBatchManagementDom(projectDiv);
            } else {
                exitAiSessionBatchManagement();
            }
        }
        reconcilePendingAiSessionProviderSelectionDom();
        syncActiveAiSessionTerminalDom();
        updateStickyGroupHeaderOffset();
        if (window.__agentPivotDashboard) {
            window.__agentPivotDashboard.replaceSearchCatalog(message.searchCatalog);
        }
    }

    function findCurrentWorkspaceDiv(projectId) {
        if (!projectId) {
            return null;
        }

        var projects = document.querySelectorAll('.workspace-card[data-current-workspace][data-id]');
        for (var projectDiv of projects) {
            if (projectDiv.getAttribute("data-id") === projectId) {
                return projectDiv;
            }
        }

        return null;
    }

    function findWorkspaceDiv(navigationIdentity) {
        if (!navigationIdentity) {
            return null;
        }
        var workspaces = document.querySelectorAll('.workspace-card[data-workspace-navigation-identity]');
        for (var workspaceDiv of workspaces) {
            if (workspaceDiv.getAttribute('data-workspace-navigation-identity') === navigationIdentity) {
                return workspaceDiv;
            }
        }
        return null;
    }

    function focusSearchRevealTarget(target) {
        target.setAttribute('tabindex', '-1');
        target.focus();
        target.scrollIntoView({ block: 'nearest' });
        target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true });
    }

    window.__agentPivotRevealWorkspace = navigationIdentity => {
        var workspaceDiv = findWorkspaceDiv(navigationIdentity);
        if (!workspaceDiv) {
            return false;
        }
        focusSearchRevealTarget(workspaceDiv);
        return true;
    };

    function revealWorkspaceSession(navigationIdentity, provider, sessionId) {
        if (!isAiSessionProvider(provider) || !sessionId) {
            return false;
        }
        var workspaceDiv = findWorkspaceDiv(navigationIdentity);
        if (!workspaceDiv) {
            return false;
        }
        var workspaceId = workspaceDiv.getAttribute('data-id');
        if (!workspaceDiv.hasAttribute('data-codex-expanded')) {
            toggleCodexSessions(workspaceDiv, workspaceId);
        }
        selectAiSessionTabDom(workspaceDiv, 'sessions');
        writeAiSessionTabState(window.vscode, workspaceId, 'sessions');
        var sessionRow = Array.from(workspaceDiv.querySelectorAll('.codex-session-row[data-session-id][data-session-provider]'))
            .find(row => row.getAttribute('data-session-provider') === provider
                && row.getAttribute('data-session-id') === sessionId);
        if (sessionRow) {
            pendingWorkspaceSessionReveal = null;
            focusSearchRevealTarget(sessionRow);
            return true;
        }
        var selectedProviders = getSelectedAiSessionProviders(workspaceDiv);
        if (!selectedProviders.includes(provider)) {
            pendingWorkspaceSessionReveal = { navigationIdentity, provider, sessionId };
            submitAiSessionProviderSelection(
                workspaceDiv,
                selectedProviders.concat(provider)
            );
            return true;
        }
        pendingWorkspaceSessionReveal = null;
        focusSearchRevealTarget(workspaceDiv);
        return false;
    }

    window.__agentPivotRevealWorkspaceSession = revealWorkspaceSession;
    window.__agentPivotRevealPendingWorkspaceSession = () => {
        if (!pendingWorkspaceSessionReveal) {
            return false;
        }
        var pending = pendingWorkspaceSessionReveal;
        return revealWorkspaceSession(
            pending.navigationIdentity,
            pending.provider,
            pending.sessionId
        );
    };

    function requestFullRefresh(reason) {
        window.vscode.postMessage({
            type: 'request-full-refresh',
            reason,
        });
    }

    function observeStickyGroupHeaderOffset() {
        updateStickyGroupHeaderOffset();
        window.addEventListener('resize', updateStickyGroupHeaderOffset);

        var stickyHeader = document.querySelector('.steward-sticky-header');
        if (stickyHeader && typeof ResizeObserver !== 'undefined') {
            var observer = new ResizeObserver(updateStickyGroupHeaderOffset);
            observer.observe(stickyHeader);
            window.__stewardStickyHeaderObserver = observer;
        }
    }

    // Middle mouse button requires mousedown, as it does not fire click event when scroll option is available.
    document.addEventListener('click', (e) => {
        if (e.button !== 1) {
            onMouseEvent(e);
        }
    });

    document.addEventListener('change', onChangeEvent);
    document.addEventListener('submit', onTodoFormSubmit);

    document.addEventListener('mousedown', (e) => {
        if (e.target.closest('.codex-session-row')) {
            return;
        }

        if (e.button === 1) {
            onMouseEvent(e);
        }
    });

    document.addEventListener('contextmenu', (e) => {
        if (!e.target)
            return;

        onContextMenu(e);
    });

    document.addEventListener("keydown", e => {
        var aiSessionProviderTrigger = e.target && e.target.closest
            ? e.target.closest('[data-ai-provider-menu-trigger]')
            : null;
        if (aiSessionProviderTrigger
            && (e.key === 'ArrowDown' || e.key === 'ArrowUp'
                || e.key === 'Home' || e.key === 'End')) {
            e.preventDefault();
            var triggerProject = aiSessionProviderTrigger.closest('.project[data-id]');
            closeAiSessionProviderMenus(triggerProject);
            setAiSessionProviderMenuOpen(triggerProject, true);
            var triggerOptions = getAiSessionProviderOptions(triggerProject);
            var triggerOptionIndex = e.key === 'ArrowUp' || e.key === 'End'
                ? triggerOptions.length - 1
                : 0;
            triggerOptions[triggerOptionIndex]?.focus();
            return;
        }
        if (aiSessionProviderTrigger && e.key === 'Escape') {
            e.preventDefault();
            closeAiSessionProviderMenu(
                aiSessionProviderTrigger.closest('.project[data-id]'),
                true
            );
            return;
        }

        var aiSessionProviderOption = e.target && e.target.closest
            ? e.target.closest('[data-ai-provider-option][data-provider]')
            : null;
        if (aiSessionProviderOption) {
            var providerProject = aiSessionProviderOption.closest('.project[data-id]');
            var providerOptions = getAiSessionProviderOptions(providerProject);
            var providerOptionIndex = providerOptions.indexOf(aiSessionProviderOption);
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp'
                || e.key === 'Home' || e.key === 'End') {
                e.preventDefault();
                var nextProviderOptionIndex = e.key === 'Home' ? 0
                    : e.key === 'End' ? providerOptions.length - 1
                        : (providerOptionIndex + (e.key === 'ArrowDown' ? 1 : -1)
                            + providerOptions.length) % providerOptions.length;
                providerOptions[nextProviderOptionIndex]?.focus();
                return;
            }
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                activateAiSessionProviderOption(providerProject, aiSessionProviderOption);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                closeAiSessionProviderMenu(providerProject, true);
                return;
            }
            if (e.key === 'Tab') {
                closeAiSessionProviderMenu(providerProject, false);
            }
        }

        var aiSessionMenuItem = e.target && e.target.closest
            ? e.target.closest('#aiSessionContextMenu [role="menuitem"]')
            : null;
        if (aiSessionMenuItem) {
            var aiSessionMenu = aiSessionMenuItem.closest('#aiSessionContextMenu');
            var enabledMenuItems = Array.from(aiSessionMenu.querySelectorAll('[role="menuitem"]'))
                .filter(item => !item.classList.contains('disabled'));
            var currentMenuIndex = enabledMenuItems.indexOf(aiSessionMenuItem);
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
                e.preventDefault();
                var nextMenuIndex = e.key === 'Home' ? 0
                    : e.key === 'End' ? enabledMenuItems.length - 1
                        : (currentMenuIndex + (e.key === 'ArrowDown' ? 1 : -1) + enabledMenuItems.length)
                            % enabledMenuItems.length;
                enabledMenuItems[nextMenuIndex]?.focus();
                return;
            }
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onAiSessionContextMenuActionClicked(aiSessionMenuItem);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                var menuOrigin = contextMenuAiSessionOrigin;
                closeContextMenus();
                menuOrigin?.focus();
                return;
            }
            if (e.key === 'Tab') {
                closeContextMenus();
            }
        }

        var tab = e.target && e.target.closest ? e.target.closest('[data-ai-session-tab]') : null;
        if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
            e.preventDefault();
            var nextTabId = getAdjacentAiSessionTab(tab.getAttribute('data-ai-session-tab'), e.key);
            var projectDiv = tab.closest('.project[data-id]');
            var nextTab = projectDiv && Array.from(projectDiv.querySelectorAll('[data-ai-session-tab]'))
                .find(candidate => candidate.getAttribute('data-ai-session-tab') === nextTabId);
            nextTab?.focus();
            return;
        }
        if (tab && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            var tabProject = tab.closest('.project[data-id]');
            var tabProjectId = tabProject && tabProject.getAttribute('data-id');
            if (tabProjectId) onTriggerAiSessionAction(tab, tabProjectId);
            return;
        }

        var sessionRow = e.target && e.target.closest ? e.target.closest('.codex-session-row') : null;
        var interactiveChild = e.target && e.target.closest
            ? e.target.closest('button, input, select, textarea, a[href]')
            : null;
        var primarySessionAction = e.target && e.target.closest
            ? e.target.closest('.ai-session-primary-action') : null;
        if (sessionRow && (!interactiveChild || primarySessionAction)
            && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) {
            e.preventDefault();
            var sessionRowRect = sessionRow.getBoundingClientRect();
            onContextMenu({
                target: primarySessionAction || sessionRow,
                preventDefault: () => {},
                clientX: sessionRowRect.left + 8,
                clientY: sessionRowRect.top + 8,
                keyboardTrigger: true,
            });
            return;
        }
        if (e.key === "Escape") {
            var editForm = e.target && e.target.closest ? e.target.closest('.todo-edit-form') : null;
            if (editForm) {
                e.preventDefault();
                setTodoEditing(editForm.getAttribute('data-todo-id'), false);
                return;
            }
            closeContextMenus();
            if (batchAiSessionState.projectId && !batchAiSessionState.pending) {
                exitAiSessionBatchManagement();
            }
        }
    });

    window.addEventListener('message', onWindowMessage);
    restoreAiSessionTabsFromState(document, window.vscode);
    window.vscode.postMessage({ type: 'request-active-ai-session-terminal' });
    window.vscode.postMessage({ type: 'request-ai-session-attention-state' });

    observeStickyGroupHeaderOffset();
}
