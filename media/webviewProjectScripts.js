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

        if (aiSessionControls.onTriggerAiSessionAction(e.target, dataId))
            return;

        if (contextMenus.onTriggerProjectAction(e.target, dataId))
            return;

        if (projectDiv.hasAttribute("data-current-workspace")) {
            if (e.target.closest('[data-ai-session-region]'))
                return;

            aiSessionControls.toggleCodexSessions(projectDiv, dataId);
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


    var groupCollapse = initProjectGroupCollapse();
    var openTabSplit = typeof initOpenTabSplit === 'function' ? initOpenTabSplit() : null;
    var todoControls = initProjectTodoControls({
        syncCollapseButton: () => groupCollapse.syncCollapseButton(),
    });
    var aiSessionPresentationStateStore = null;
    var aiSessionControls = initProjectAiSessionControls({
        getAiSessionsUpdate: () => aiSessionsUpdate,
        getAiSessionPresentationStateStore: () => aiSessionPresentationStateStore,
        updateStickyGroupHeaderOffset: updateStickyGroupHeaderOffset,
    });
    window.__agentPivotContextMenus = null;
    var contextMenus = initProjectContextMenus({
        openProject: openProject,
        ProjectOpenType: ProjectOpenType,
        getResumeAiSessionMessageType: aiSessionControls.getResumeAiSessionMessageType,
        getArchiveAiSessionMessageType: aiSessionControls.getArchiveAiSessionMessageType,
        isAiSessionProvider: aiSessionControls.isAiSessionProvider,
    });
    window.__agentPivotContextMenus = contextMenus;
    aiSessionPresentationStateStore = initAiSessionPresentationStateStore({
        isAiSessionProvider: aiSessionControls.isAiSessionProvider,
    });
    var aiSessionPresentationDom = initAiSessionPresentationDom({
        presentationStateStore: aiSessionPresentationStateStore,
    });
    var presentationTransactions = initAiSessionPresentationTransactions({
        isValidAiSessionPresentationState: aiSessionPresentationStateStore.isValid,
        canApplyAiSessionPresentationState: aiSessionPresentationDom.canApply,
        applyValidatedAiSessionPresentationState: applyValidatedAiSessionPresentationState,
    });
    var aiSessionsUpdate = initProjectAiSessionsUpdate({
        batchAiSessionState: aiSessionControls.batchAiSessionState,
        batchAiSessionManager: aiSessionControls.batchAiSessionManager,
        getPendingAiSessionProviderSelectionProjectId: () => aiSessionControls.getPendingAiSessionProviderSelectionProjectId(),
        getSelectedAiSessionProviders: aiSessionControls.getSelectedAiSessionProviders,
        syncAiSessionBatchManagementDom: aiSessionControls.syncAiSessionBatchManagementDom,
        reconcilePendingAiSessionProviderSelectionDom: aiSessionControls.reconcilePendingAiSessionProviderSelectionDom,
        submitAiSessionProviderSelection: aiSessionControls.submitAiSessionProviderSelection,
        toggleCodexSessions: aiSessionControls.toggleCodexSessions,
        exitAiSessionBatchManagement: aiSessionControls.exitAiSessionBatchManagement,
        isAiSessionProvider: aiSessionControls.isAiSessionProvider,
        updateStickyGroupHeaderOffset: updateStickyGroupHeaderOffset,
        presentationTransactions: presentationTransactions,
    });

    function applyValidatedAiSessionPresentationState(message) {
        if (!aiSessionPresentationStateStore.adopt(message)) return;
        aiSessionPresentationDom.apply(message);
        aiSessionControls.reconcileAiSessionAttentionAcknowledgements();
    }

    function readInitialAiSessionPresentationState() {
        var element = document.getElementById('dashboard-ai-session-presentation');
        if (!element) return null;
        try {
            return JSON.parse(element.textContent || '');
        } catch (_error) {
            return {};
        }
    }

    var initialAiSessionPresentationState = readInitialAiSessionPresentationState();
    if (initialAiSessionPresentationState) {
        presentationTransactions.applyInitialPresentation(
            initialAiSessionPresentationState
        );
    }

    function activateAiSessionCreateDropdownItem(menuItem) {
        var action = menuItem.getAttribute("data-action");
        var dropdownMenu = document.getElementById('aiSessionCreateDropdown');
        var projectId = dropdownMenu
            ? dropdownMenu.getAttribute('data-dropdown-project-id') || ''
            : '';
        if (action === "create-ai-session-quick") {
            var provider = menuItem.getAttribute("data-provider");
            if (provider) {
                window.vscode.postMessage({
                    type: "create-ai-session-quick",
                    projectId: projectId,
                    provider: provider,
                });
            }
        } else if (action === "create-ai-session") {
            window.vscode.postMessage({
                type: "create-ai-session",
                projectId: projectId,
            });
        }
        contextMenus.closeContextMenus();
    }

    function onMouseEvent(e) {
        if (!e.target || e.target.closest(".disabled"))
            return;
        if (todoControls.isDedicatedTodoTarget(e.target))
            return;

        var contextMenuElement = e.target.closest("#projectContextMenu [data-action]");
        if (contextMenuElement) {
            contextMenus.onProjectContextMenuActionClicked(contextMenuElement);
            return;
        }

        contextMenuElement = e.target.closest("#aiSessionContextMenu [data-action]");
        if (contextMenuElement) {
            contextMenus.onAiSessionContextMenuActionClicked(contextMenuElement);
            return;
        }

        contextMenuElement = e.target.closest("#aiSessionCreateDropdown [data-action]");
        if (contextMenuElement) {
            activateAiSessionCreateDropdownItem(contextMenuElement);
            return;
        }

        contextMenuElement = e.target.closest("#aiSessionWorktreeMenu [data-action]");
        if (contextMenuElement) {
            aiSessionControls.activateAiSessionWorktreeMenuItem(contextMenuElement);
            return;
        }

        contextMenuElement = e.target.closest("#groupContextMenu [data-action]");
        if (contextMenuElement) {
            contextMenus.onGroupContextMenuActionClicked(contextMenuElement);
            return;
        }

        // The create-dropdown arrow owns its toggle: the generic close would
        // hide the menu before the arrow handler can see it was open.
        if (!e.target.closest('[data-action="create-ai-session-dropdown"]')
            && !e.target.closest('[data-action="ai-session-worktree-menu"]')) {
            contextMenus.closeContextMenus();
        }
        if (!e.target.closest('.ai-session-provider-menu-wrapper')) {
            aiSessionControls.closeAiSessionProviderMenus();
        }

        if (e.target.closest('[data-action="toggle-all-groups"]')) {
            groupCollapse.toggleAllGroups();
            return;
        }

        if (e.target.closest('[data-action="sponsor"]')) {
            window.vscode.postMessage({
                type: 'sponsor'
            });
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

        if (todoControls.onTodoAction(e)) {
            return;
        }

        var todoItem = e.target.closest('.todo-item[data-todo-id]');
        if (todoItem && !todoItem.classList.contains('editing') && !todoControls.isTodoInteractiveTarget(e.target)) {
            todoControls.toggleTodoItemExpanded(todoItem);
            return;
        }

        var projectDiv = e.target.closest('.project');
        if (projectDiv) {
            onInsideProjectClick(e, projectDiv);
            return;
        }

        var groupDiv = e.target.closest('.group');
        if (groupDiv) {
            todoControls.onInsideGroupClick(e, groupDiv);
            return;
        }
    }

    function onChangeEvent(e) {
        if (!e.target)
            return;
        if (todoControls.isDedicatedTodoTarget(e.target))
            return;

        var todoPriorityInput = e.target.closest('.todo-priority-choice input[name="priority"]');
        if (todoPriorityInput) {
            todoControls.syncTodoPrioritySegment(todoPriorityInput.closest('.todo-priority-segment'));
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
        if (message
            && message.type === 'reveal-ai-session-requested') {
            revealAiSessionInWorkspace(message);
            return;
        }
        if (message && message.type === 'todo-mutation-result') {
            applyTodoMutationResult(message, document);
            return;
        }
        if (message && message.type === 'ai-session-provider-selection-result') {
            aiSessionControls.applyAiSessionProviderSelectionResult(message);
            return;
        }
        if (message && message.type === 'ai-session-attention-acknowledgement-result') {
            aiSessionControls.applyAiSessionAttentionAcknowledgementResult(message);
            return;
        }
        if (message && (message.type === 'todo-panel-content' || message.type === 'todo-panel-updated')) {
            window.setTimeout(() => {
                var todoRoot = document.querySelector('#dashboard-tab-todo');
                if (todoRoot && typeof initDnD === 'function' && typeof disposeDnD === 'function') {
                    disposeDnD(todoRoot);
                    initDnD(todoRoot);
                    groupCollapse.syncCollapseButton();
                }
            }, 0);
        }
        if (message && message.type === 'open-workspaces-updated') {
            if (message.version !== 3) {
                aiSessionsUpdate.requestFullRefresh(
                    'unsupported-open-workspaces-message'
                );
                return;
            }
            if (!presentationTransactions.applyAtomicEnvelope({
                message: message,
                invalidPresentationReason: 'invalid-open-workspaces-presentation-envelope',
                invalidReplacementReason: 'invalid-open-workspaces-update',
                replaceContent: validateReplacement => applyOpenWorkspacesUpdate(
                    message,
                    { validateReplacement: validateReplacement }
                ),
            })) {
                return;
            }
            updateStickyGroupHeaderOffset();
            if (openTabSplit && typeof openTabSplit.syncResizer === 'function') {
                openTabSplit.syncResizer();
            }
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
            var requestedProject = aiSessionsUpdate.findCurrentWorkspaceDiv(message.projectId);
            if (requestedProject && (message.tab === 'active' || message.tab === 'sessions')) {
                selectAiSessionTabDom(requestedProject, message.tab);
                writeAiSessionTabState(window.vscode, message.projectId, message.tab);
            }
            return;
        }

        if (message && message.type === 'ai-session-status-announcement') {
            var announcementProject = aiSessionsUpdate.findCurrentWorkspaceDiv(message.projectId);
            var announcement = typeof message.message === 'string' ? message.message.trim().slice(0, 256) : '';
            var announcementRegion = announcementProject && announcementProject.querySelector('[data-ai-session-live-region]');
            if (announcementRegion && announcement) announcementRegion.textContent = announcement;
            return;
        }

        if (message && message.type === 'ai-session-presentation-state') {
            presentationTransactions.applyDirectPresentation(message);
            return;
        }

        if (message && message.type === 'ai-session-batch-archive-completed') {
            if (aiSessionControls.batchAiSessionManager.complete(message)) {
                var completedProject = aiSessionsUpdate.findCurrentWorkspaceDiv(message.projectId);
                aiSessionControls.syncAiSessionBatchManagementDom(completedProject);
                var archiveLiveRegion = completedProject
                    && completedProject.querySelector('[data-ai-session-live-region]');
                if (archiveLiveRegion) {
                    archiveLiveRegion.textContent =
                        getAiSessionBatchArchiveAnnouncement(message);
                }
            }
            return;
        }

        if (message && message.type === 'isolated-session-settlement') {
            aiSessionControls.applyIsolatedSessionSettlement(message);
            return;
        }

        if (message && message.type === 'managed-worktree-removal-settlement') {
            aiSessionControls.applyManagedWorktreeRemovalSettlement(message);
            return;
        }

        if (message && message.type === 'worktree-group-primary-settlement') {
            aiSessionControls.applySetGroupPrimarySettlement(message);
            return;
        }

        if (!message || message.type !== 'ai-sessions-updated') {
            return;
        }

        aiSessionsUpdate.applyAiSessionsUpdate(message);
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
    document.addEventListener('submit', e => todoControls.onTodoFormSubmit(e));

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

        contextMenus.onContextMenu(e);
    });

    document.addEventListener("keydown", e => {
        var worktreeHeader = e.target && e.target.closest
            ? e.target.closest('.ai-session-worktree-header')
            : null;
        if (worktreeHeader
            && (e.key === 'ArrowDown' || e.key === 'ArrowUp'
                || e.key === 'Home' || e.key === 'End')) {
            var worktreePanel = worktreeHeader.closest('[data-ai-session-panel]');
            var worktreeHeaders = worktreePanel
                ? Array.from(worktreePanel.querySelectorAll('.ai-session-worktree-header'))
                : [];
            var worktreeHeaderIndex = worktreeHeaders.indexOf(worktreeHeader);
            if (worktreeHeaderIndex >= 0 && worktreeHeaders.length) {
                e.preventDefault();
                var nextWorktreeHeaderIndex = e.key === 'Home' ? 0
                    : e.key === 'End' ? worktreeHeaders.length - 1
                        : (worktreeHeaderIndex + (e.key === 'ArrowDown' ? 1 : -1)
                            + worktreeHeaders.length) % worktreeHeaders.length;
                worktreeHeaders[nextWorktreeHeaderIndex]?.focus();
            }
            return;
        }
        var aiSessionProviderTrigger = e.target && e.target.closest
            ? e.target.closest('[data-ai-provider-menu-trigger]')
            : null;
        if (aiSessionProviderTrigger
            && (e.key === 'ArrowDown' || e.key === 'ArrowUp'
                || e.key === 'Home' || e.key === 'End')) {
            e.preventDefault();
            var triggerProject = aiSessionProviderTrigger.closest('.project[data-id]');
            aiSessionControls.closeAiSessionProviderMenus(triggerProject);
            aiSessionControls.setAiSessionProviderMenuOpen(triggerProject, true);
            var triggerOptions = aiSessionControls.getAiSessionProviderOptions(triggerProject);
            var triggerOptionIndex = e.key === 'ArrowUp' || e.key === 'End'
                ? triggerOptions.length - 1
                : 0;
            triggerOptions[triggerOptionIndex]?.focus();
            return;
        }
        if (aiSessionProviderTrigger && e.key === 'Escape') {
            e.preventDefault();
            aiSessionControls.closeAiSessionProviderMenu(
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
            var providerOptions = aiSessionControls.getAiSessionProviderOptions(providerProject);
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
                aiSessionControls.activateAiSessionProviderOption(providerProject, aiSessionProviderOption);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                aiSessionControls.closeAiSessionProviderMenu(providerProject, true);
                return;
            }
            if (e.key === 'Tab') {
                aiSessionControls.closeAiSessionProviderMenu(providerProject, false);
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
                contextMenus.onAiSessionContextMenuActionClicked(aiSessionMenuItem);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                var menuOrigin = contextMenus.getAiSessionContextMenuOrigin();
                contextMenus.closeContextMenus();
                menuOrigin?.focus();
                return;
            }
            if (e.key === 'Tab') {
                contextMenus.closeContextMenus();
            }
        }

        var aiSessionCreateItem = e.target && e.target.closest
            ? e.target.closest('#aiSessionCreateDropdown [role="menuitem"]')
            : null;
        if (aiSessionCreateItem) {
            var createMenu = aiSessionCreateItem.closest('#aiSessionCreateDropdown');
            var createItems = Array.from(createMenu.querySelectorAll('[role="menuitem"]'));
            var createIndex = createItems.indexOf(aiSessionCreateItem);
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
                e.preventDefault();
                var nextCreateIndex = e.key === 'Home' ? 0
                    : e.key === 'End' ? createItems.length - 1
                        : (createIndex + (e.key === 'ArrowDown' ? 1 : -1) + createItems.length)
                            % createItems.length;
                createItems[nextCreateIndex]?.focus();
                return;
            }
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                activateAiSessionCreateDropdownItem(aiSessionCreateItem);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                var createOrigin = createMenu.__originButton || null;
                createMenu.__originButton = null;
                contextMenus.closeContextMenus();
                createOrigin?.focus();
                return;
            }
            if (e.key === 'Tab') {
                contextMenus.closeContextMenus();
            }
        }

        var worktreeMenuItem = e.target && e.target.closest
            ? e.target.closest('#aiSessionWorktreeMenu [role="menuitem"]')
            : null;
        if (worktreeMenuItem) {
            var worktreeMenu = worktreeMenuItem.closest('#aiSessionWorktreeMenu');
            var worktreeItems = Array.from(
                worktreeMenu.querySelectorAll('[role="menuitem"]:not([hidden])')
            );
            var worktreeIndex = worktreeItems.indexOf(worktreeMenuItem);
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
                e.preventDefault();
                var nextWorktreeIndex = e.key === 'Home' ? 0
                    : e.key === 'End' ? worktreeItems.length - 1
                        : (worktreeIndex + (e.key === 'ArrowDown' ? 1 : -1) + worktreeItems.length)
                            % worktreeItems.length;
                worktreeItems[nextWorktreeIndex]?.focus();
                return;
            }
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                aiSessionControls.activateAiSessionWorktreeMenuItem(worktreeMenuItem);
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                var worktreeOrigin = worktreeMenu.__originButton || null;
                aiSessionControls.closeAiSessionWorktreeMenu();
                worktreeOrigin?.focus();
                return;
            }
            if (e.key === 'Tab') {
                aiSessionControls.closeAiSessionWorktreeMenu();
            }
        }

        var surfaceTab = e.target && e.target.closest
            ? e.target.closest('[data-ai-session-surface-tab]')
            : null;
        if (surfaceTab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
            e.preventDefault();
            var nextSurfaceId = getAdjacentAiSessionSurface(
                surfaceTab.getAttribute('data-ai-session-surface-tab'),
                e.key
            );
            var surfaceProject = surfaceTab.closest('.project[data-id]');
            var nextSurface = surfaceProject
                && Array.from(surfaceProject.querySelectorAll('[data-ai-session-surface-tab]'))
                    .find(candidate =>
                        candidate.getAttribute('data-ai-session-surface-tab') === nextSurfaceId
                    );
            nextSurface?.focus();
            return;
        }
        if (surfaceTab && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            var surfaceTabProject = surfaceTab.closest('.project[data-id]');
            var surfaceTabProjectId = surfaceTabProject
                && surfaceTabProject.getAttribute('data-id');
            if (surfaceTabProjectId) {
                aiSessionControls.onTriggerAiSessionAction(surfaceTab, surfaceTabProjectId);
            }
            return;
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
            if (tabProjectId) aiSessionControls.onTriggerAiSessionAction(tab, tabProjectId);
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
            contextMenus.onContextMenu({
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
                todoControls.setTodoEditing(editForm.getAttribute('data-todo-id'), false);
                return;
            }
            contextMenus.closeContextMenus();
            if (aiSessionControls.batchAiSessionState.projectId && !aiSessionControls.batchAiSessionState.pending) {
                aiSessionControls.exitAiSessionBatchManagement();
            }
        }
    });

    window.addEventListener('message', onWindowMessage);
    window.vscode.postMessage({
        type: 'open-workspaces-renderer-ready',
        version: 1,
        documentGeneration: window.__agentPivotReadyDocumentGeneration,
    });
    restoreAiSessionTabsFromState(document, window.vscode);
    window.vscode.postMessage({ type: 'request-active-ai-session-terminal' });

    observeStickyGroupHeaderOffset();
}
