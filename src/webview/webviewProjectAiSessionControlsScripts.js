function initProjectAiSessionControls(options) {
    'use strict';

    options = options || {};
    var getAiSessionsUpdate = options.getAiSessionsUpdate;
    var updateStickyGroupHeaderOffset = options.updateStickyGroupHeaderOffset;

    var batchAiSessionState = {
        projectId: null,
        selectedItems: new Map(),
        pending: false,
        requestId: null,
    };
    var activeAiSessionTerminalState = { provider: null, sessionId: null, pendingId: null };
    var nextAiSessionBatchArchiveRequestId = 0;
    var nextAiSessionProviderSelectionRequestId = 0;
    var pendingAiSessionProviderSelectionProjectId = null;
    var pendingAiSessionProviderSelectionRequestId = null;
    var pendingAiSessionProviderSelectionProviders = [];

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

        var terminalAction = target.closest('[data-action="close-ai-session-terminal"], [data-action="detach-ai-session-terminal"], [data-action="stop-ai-session-runtime"]');
        if (terminalAction) {
            var terminalRow = terminalAction.closest('.codex-session-row[data-session-provider][data-session-backend]');
            var terminalProvider = terminalRow && terminalRow.getAttribute('data-session-provider');
            var terminalBackend = terminalRow && terminalRow.getAttribute('data-session-backend');
            var requestedTerminalAction = terminalAction.getAttribute('data-action');
            var requestedDetach = requestedTerminalAction === 'detach-ai-session-terminal';
            var requestedStop = requestedTerminalAction === 'stop-ai-session-runtime';
            if (terminalRow && isAiSessionProvider(terminalProvider)
                && ((requestedDetach && terminalBackend === 'tmux')
                    || (requestedStop && terminalBackend === 'tmux')
                    || (!requestedDetach && !requestedStop && terminalBackend === 'vscode'))) {
                var terminalMessage = {
                    type: requestedDetach ? 'detach-ai-session-terminal'
                        : requestedStop ? 'stop-ai-session-runtime'
                            : 'close-ai-session-terminal',
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
        var projectDiv = getAiSessionsUpdate().findCurrentWorkspaceDiv(
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

        var projectDiv = getAiSessionsUpdate().findCurrentWorkspaceDiv(message.projectId);
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
        syncAiSessionBatchManagementDom(getAiSessionsUpdate().findCurrentWorkspaceDiv(projectId));
    }

    function getPendingAiSessionProviderSelectionProjectId() {
        return pendingAiSessionProviderSelectionProjectId;
    }

    return {
        batchAiSessionManager: batchAiSessionManager,
        batchAiSessionState: batchAiSessionState,
        activeAiSessionTerminalState: activeAiSessionTerminalState,
        getPendingAiSessionProviderSelectionProjectId: getPendingAiSessionProviderSelectionProjectId,
        activateAiSessionProviderOption: activateAiSessionProviderOption,
        applyAiSessionProviderSelectionResult: applyAiSessionProviderSelectionResult,
        closeAiSessionProviderMenu: closeAiSessionProviderMenu,
        closeAiSessionProviderMenus: closeAiSessionProviderMenus,
        exitAiSessionBatchManagement: exitAiSessionBatchManagement,
        getAiSessionProviderOptions: getAiSessionProviderOptions,
        getArchiveAiSessionMessageType: getArchiveAiSessionMessageType,
        getResumeAiSessionMessageType: getResumeAiSessionMessageType,
        getSelectedAiSessionProviders: getSelectedAiSessionProviders,
        isAiSessionProvider: isAiSessionProvider,
        onTriggerAiSessionAction: onTriggerAiSessionAction,
        reconcilePendingAiSessionProviderSelectionDom: reconcilePendingAiSessionProviderSelectionDom,
        setAiSessionProviderMenuOpen: setAiSessionProviderMenuOpen,
        submitAiSessionProviderSelection: submitAiSessionProviderSelection,
        syncActiveAiSessionTerminalDom: syncActiveAiSessionTerminalDom,
        syncAiSessionBatchManagementDom: syncAiSessionBatchManagementDom,
        toggleAiSessionProviderMenu: toggleAiSessionProviderMenu,
        toggleCodexSessions: toggleCodexSessions,
    };
}
