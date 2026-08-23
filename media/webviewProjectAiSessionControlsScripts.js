function initProjectAiSessionControls(options) {
    'use strict';

    options = options || {};
    var getAiSessionsUpdate = options.getAiSessionsUpdate;
    var getAiSessionPresentationStateStore = options.getAiSessionPresentationStateStore;
    var updateStickyGroupHeaderOffset = options.updateStickyGroupHeaderOffset;

    // Native title tooltips take over a second to appear; icon-only buttons
    // get a shared fast tooltip instead (150ms), driven by data-tooltip.
    var fastTooltip = null;
    var fastTooltipTimer = null;
    var fastTooltipTarget = null;

    function hideFastTooltip() {
        if (fastTooltipTimer) {
            clearTimeout(fastTooltipTimer);
            fastTooltipTimer = null;
        }
        fastTooltipTarget = null;
        if (fastTooltip) {
            fastTooltip.remove();
            fastTooltip = null;
        }
    }

    function showFastTooltip(target) {
        var label = target.getAttribute('data-tooltip');
        if (!label || !target.isConnected) return;
        hideFastTooltip();
        fastTooltipTarget = target;
        fastTooltipTimer = setTimeout(() => {
            if (fastTooltipTarget !== target || !target.isConnected) return;
            fastTooltip = document.createElement('div');
            fastTooltip.className = 'ai-session-fast-tooltip';
            fastTooltip.setAttribute('role', 'tooltip');
            fastTooltip.textContent = label;
            document.body.appendChild(fastTooltip);
            var rect = target.getBoundingClientRect();
            var tipRect = fastTooltip.getBoundingClientRect();
            var left = Math.max(4, Math.min(
                rect.right - tipRect.width,
                window.innerWidth - tipRect.width - 4
            ));
            var top = rect.top - tipRect.height - 5;
            if (top < 4) {
                top = rect.bottom + 5;
            }
            fastTooltip.style.left = left + 'px';
            fastTooltip.style.top = top + 'px';
        }, 150);
    }

    document.addEventListener('mouseover', event => {
        var target = event.target && event.target.closest
            ? event.target.closest('[data-tooltip]') : null;
        if (target === fastTooltipTarget) return;
        hideFastTooltip();
        if (target) showFastTooltip(target);
    });
    document.addEventListener('pointerdown', hideFastTooltip, true);
    document.addEventListener('focusin', event => {
        var target = event.target && event.target.closest
            ? event.target.closest('[data-tooltip]') : null;
        hideFastTooltip();
        if (target) showFastTooltip(target);
    });
    document.addEventListener('focusout', hideFastTooltip);

    var batchAiSessionState = {
        projectId: null,
        selectedItems: new Map(),
        pending: false,
        requestId: null,
    };
    var nextAiSessionBatchArchiveRequestId = 0;
    var nextAiSessionProviderSelectionRequestId = 0;
    var nextAiSessionAttentionAcknowledgementRequestId = 0;
    var nextIsolatedSessionRequestId = 0;
    var pendingIsolatedSessionRequests = new Map();
    var nextManagedWorktreeRemovalRequestId = 0;
    var pendingManagedWorktreeRemovalRequests = new Map();
    var nextMergeWorktreeGroupsRequestId = 0;
    var pendingMergeWorktreeGroupsRequests = new Map();
    // A per-document nonce keeps merge request ids unique across webview
    // reloads (review R6): the host replay cache outlives the document, so
    // without it a reloaded document's `worktree-merge-1` would correlate
    // with the previous document's cached settlement and never execute.
    // Same pattern as rename/adopt/deletion.
    var worktreeMergeDocumentNonce = Math.random().toString(36).slice(2, 10);
    var nextSetGroupPrimaryRequestId = 0;
    var pendingSetGroupPrimaryRequests = new Map();
    var worktreeGroupForm = null;

    function setWorktreeGroupForm(form) {
        worktreeGroupForm = form;
    }
    var pendingAiSessionAttentionAcknowledgements = new Map();
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
        var projectDiv = target.closest('.project[data-id]')
            || target.closest('[data-open-session-surface][data-id]');
        var managedWorktreeRemoveAction = target.closest(
            '[data-action="remove-managed-worktree"]'
        );
        if (managedWorktreeRemoveAction) {
            submitManagedWorktreeRemoval(
                projectId,
                managedWorktreeRemoveAction.closest(
                    '.ai-session-worktree-group[data-worktree-repository-key][data-worktree-path]'
                ),
                managedWorktreeRemoveAction
            );
            return true;
        }
        var isolatedRetryAction = target.closest(
            '[data-action="retry-isolated-session"][data-operation-id]'
        );
        if (isolatedRetryAction) {
            submitIsolatedSessionRequest(
                'retry-isolated-session', projectId,
                isolatedRetryAction.getAttribute('data-operation-id'), isolatedRetryAction
            );
            return true;
        }
        var isolatedDismissAction = target.closest(
            '[data-action="dismiss-isolated-session"][data-operation-id]'
        );
        if (isolatedDismissAction) {
            submitIsolatedSessionRequest(
                'dismiss-isolated-session', projectId,
                isolatedDismissAction.getAttribute('data-operation-id'), isolatedDismissAction
            );
            return true;
        }
        var isolatedCancelAction = target.closest(
            '[data-action="cancel-isolated-session"][data-operation-id]'
        );
        if (isolatedCancelAction) {
            submitIsolatedSessionRequest(
                'cancel-isolated-session', projectId,
                isolatedCancelAction.getAttribute('data-operation-id'), isolatedCancelAction
            );
            return true;
        }
        var worktreeCollapseAllAction = target.closest(
            '[data-action="toggle-all-ai-session-worktrees"]'
        );
        if (worktreeCollapseAllAction) {
            toggleAllAiSessionWorktrees(projectDiv);
            return true;
        }
        var worktreeMenuAction = target.closest('[data-action="ai-session-worktree-menu"]');
        if (worktreeMenuAction) {
            toggleAiSessionWorktreeMenu(worktreeMenuAction, projectId);
            return true;
        }
        var setPrimaryAction = target.closest(
            '[data-action="set-group-primary"][data-group-id][data-member-id]'
        );
        if (setPrimaryAction) {
            submitSetGroupPrimaryRequest(projectId, setPrimaryAction);
            return true;
        }
        var viewConversationAction = target.closest(
            '[data-action="view-ai-session-conversation"]'
        );
        if (viewConversationAction) {
            var viewRow = viewConversationAction.closest('.codex-session-row[data-session-id]');
            if (viewRow) {
                window.vscode.postMessage({
                    type: 'open-active-ai-session-conversation',
                    version: 1,
                    projectId: projectId,
                    provider: viewRow.getAttribute('data-session-provider'),
                    sessionId: viewRow.getAttribute('data-session-id'),
                });
            }
            return true;
        }
        var worktreeToggle = target.closest('[data-action="toggle-ai-session-worktree"]');
        if (worktreeToggle) {
            setAiSessionWorktreeGroupExpanded(
                projectDiv,
                worktreeToggle.closest('.ai-session-worktree-group'),
                worktreeToggle.getAttribute('aria-expanded') !== 'true'
            );
            writeAiSessionWorktreeCollapseState(window.vscode, projectDiv);
            return true;
        }
        var memberDetailsToggle = target.closest('[data-action="toggle-group-member-details"]');
        if (memberDetailsToggle) {
            var memberDetailsSection = memberDetailsToggle.closest('.ai-session-worktree-group');
            if (memberDetailsSection
                && typeof setWorktreeGroupMemberDetailsExpanded === 'function') {
                setWorktreeGroupMemberDetailsExpanded(
                    memberDetailsSection,
                    memberDetailsToggle.getAttribute('aria-expanded') !== 'true'
                );
                writeAiSessionWorktreeCollapseState(window.vscode, projectDiv);
            }
            return true;
        }
        var memberRemoveAction = target.closest(
            '[data-action="preview-group-member-deletion"][data-group-id][data-member-id]'
        );
        if (memberRemoveAction) {
            startWorktreeGroupMemberDeletion(
                projectId,
                memberRemoveAction.getAttribute('data-group-id'),
                memberRemoveAction.getAttribute('data-member-id')
            );
            return true;
        }
        var deletionCancel = target.closest('[data-action="cancel-group-member-deletion"]');
        if (deletionCancel) {
            cancelWorktreeGroupDeletionCard(projectDiv);
            return true;
        }
        var deletionConfirm = target.closest('[data-action="confirm-group-member-deletion"]');
        if (deletionConfirm) {
            if (!deletionConfirm.disabled) {
                confirmWorktreeGroupMemberDeletion(
                    deletionConfirm.closest('.ai-session-worktree-deletion-card'));
            }
            return true;
        }
        var visibleOnlySwitch = target.closest('[data-action="preview-group-visible-deletion"]');
        if (visibleOnlySwitch) {
            var switchSection = visibleOnlySwitch.closest('.ai-session-worktree-group');
            var switchGroupId = switchSection && switchSection.getAttribute('data-group-id');
            if (switchGroupId) {
                startWorktreeGroupMemberDeletion(projectId, switchGroupId, '', {
                    mode: 'visible-only',
                });
            }
            return true;
        }
        var deletionRetry = target.closest(
            '[data-action="retry-group-deletion"][data-operation-id]'
        );
        if (deletionRetry) {
            submitWorktreeGroupDeletionOperation(deletionRetry, 'retry');
            return true;
        }
        var deletionAbandon = target.closest(
            '[data-action="abandon-group-deletion"][data-operation-id]'
        );
        if (deletionAbandon) {
            submitWorktreeGroupDeletionOperation(deletionAbandon, 'abandon');
            return true;
        }
        var claimDiscard = target.closest(
            '[data-action="discard-generation-claim"][data-claim-id]'
        );
        if (claimDiscard) {
            submitWorktreeGroupClaimDiscard(claimDiscard);
            return true;
        }
        var adoptCluster = target.closest('[data-action="adopt-worktree-cluster"]');
        if (adoptCluster) {
            startWorktreeAdopt(adoptCluster);
            return true;
        }
        var adoptCancel = target.closest('[data-action="cancel-worktree-adopt"]');
        if (adoptCancel) {
            cancelWorktreeAdoptCard(projectDiv);
            return true;
        }
        var adoptConfirm = target.closest('[data-action="confirm-worktree-adopt"]');
        if (adoptConfirm) {
            if (!adoptConfirm.disabled) {
                confirmWorktreeAdopt(adoptConfirm.closest('.ai-session-worktree-adopt-card'));
            }
            return true;
        }
        var tabAction = target.closest('[data-action="select-ai-session-tab"][data-tab]');
        if (tabAction) {
            var selectedTab = normalizeAiSessionTab(tabAction.getAttribute('data-tab'));
            selectAiSessionTabDom(projectDiv, selectedTab);
            writeAiSessionTabState(window.vscode, projectId, selectedTab);
            // The host renders future authoritative HTML with this selection,
            // so replacements never flip the visible tab.
            postSelectedAiSessionViewTab(projectId, selectedTab);
            return true;
        }

        // PRD：非活动 tab 上的 ▾ 点击 = 先激活 CHATS 再开菜单。
        var viewMenuTrigger = target.closest('[data-action="toggle-chats-view-menu"]');
        if (viewMenuTrigger) {
            var menuProjectDiv = viewMenuTrigger.closest('[data-open-session-surface][data-id]');
            if (menuProjectDiv) {
                var chatsTabSelected = menuProjectDiv.querySelector(
                    '[data-ai-session-tab="chats"]'
                );
                if (chatsTabSelected
                    && chatsTabSelected.getAttribute('aria-selected') !== 'true') {
                    selectAiSessionTabDom(menuProjectDiv, 'chats');
                    writeAiSessionTabState(window.vscode, projectId, 'chats');
                    postSelectedAiSessionViewTab(projectId, 'chats');
                }
            }
            toggleChatsViewMenu(projectDiv, viewMenuTrigger);
            if (viewMenuTrigger.getAttribute('aria-expanded') === 'true') {
                window.vscode.postMessage({
                    type: 'open-tab-telemetry',
                    version: 1,
                    event: 'chats-view-menu-opened',
                });
            }
            return true;
        }
        var viewModeItem = target.closest('[data-action="select-chats-view-mode"][data-view-mode]');
        if (viewModeItem) {
            var viewMode = viewModeItem.getAttribute('data-view-mode');
            if (viewMode !== 'tree' && viewMode !== 'list') {
                return true;
            }
            setChatsViewModeDom(projectDiv, viewMode);
            closeChatsViewMenu(projectDiv, true);
            window.vscode.postMessage({
                type: 'select-ai-session-chats-view-mode',
                version: 1,
                projectId: projectId,
                viewMode: viewMode,
            });
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

        var quickCreateAction = target.closest('[data-action="create-ai-session-quick"]');
        if (quickCreateAction) {
            var provider = quickCreateAction.getAttribute('data-provider');
            if (provider) {
                var message = {
                    type: 'create-ai-session-quick',
                    projectId,
                    provider: provider,
                };
                var worktreeGroup = quickCreateAction.closest(
                    '[data-worktree-repository-key][data-worktree-path]'
                );
                if (worktreeGroup && !worktreeGroup.hasAttribute('data-worktree-anchor')) {
                    message.worktreeKey = {
                        repositoryKey: worktreeGroup.getAttribute('data-worktree-repository-key'),
                        canonicalWorktreePath: worktreeGroup.getAttribute('data-worktree-path'),
                    };
                }
                window.vscode.postMessage(message);
            }

            return true;
        }

        var dropdownAction = target.closest('[data-action="open-ai-session-preset-menu"]');
        if (dropdownAction) {
            var dropdownMenu = document.getElementById('aiSessionCreateDropdown');
            if (dropdownMenu) {
                // Snapshot before closing: a second click on the arrow that
                // opened the menu toggles it closed.
                var wasOpenForProject = dropdownMenu.classList.contains('visible')
                    && (dropdownMenu.getAttribute('data-dropdown-project-id') || '') === projectId;
                // Close other menus first (this also resets every arrow's
                // aria-expanded via closeContextMenus).
                var contextMenus = window.__agentPivotContextMenus;
                if (contextMenus && typeof contextMenus.closeContextMenus === 'function') {
                    contextMenus.closeContextMenus();
                }
                if (wasOpenForProject) {
                    return true;
                }
                // Store the projectId on the menu element for menu item handlers
                dropdownMenu.setAttribute('data-dropdown-project-id', projectId);
                var dropdownGroup = dropdownAction.closest('.ai-session-worktree-group');
                dropdownMenu.__context = {
                    projectId: projectId,
                    worktreeKey: dropdownGroup
                        && !dropdownGroup.hasAttribute('data-worktree-anchor')
                        && dropdownGroup.getAttribute('data-worktree-repository-key')
                        && dropdownGroup.getAttribute('data-worktree-path')
                        ? {
                            repositoryKey: dropdownGroup.getAttribute('data-worktree-repository-key'),
                            canonicalWorktreePath: dropdownGroup.getAttribute('data-worktree-path'),
                        }
                        : null,
                };
                dropdownMenu.__originButton = dropdownAction;
                dropdownAction.setAttribute('aria-expanded', 'true');
                // Position and show the dropdown below the button
                var buttonRect = dropdownAction.getBoundingClientRect();
                dropdownMenu.style.visibility = 'hidden';
                dropdownMenu.style.left = '0px';
                dropdownMenu.style.top = '0px';
                dropdownMenu.classList.add('visible');
                var menuRect = dropdownMenu.getBoundingClientRect();
                var viewportPadding = 4;
                var left = Math.max(viewportPadding, Math.min(
                    buttonRect.left,
                    window.innerWidth - menuRect.width - viewportPadding
                ));
                var top = buttonRect.bottom + 2;
                if (top + menuRect.height > window.innerHeight - viewportPadding) {
                    top = buttonRect.top - menuRect.height - 2;
                }
                dropdownMenu.style.left = left + 'px';
                dropdownMenu.style.top = top + 'px';
                dropdownMenu.style.visibility = 'visible';
                var firstMenuItem = dropdownMenu.querySelector('[role="menuitem"]');
                if (firstMenuItem) {
                    firstMenuItem.focus();
                }
            }
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

    function submitIsolatedSessionRequest(type, projectId, operationId, button, sourceWorktree) {
        if (!projectId || !button || button.disabled)
            return;
        nextIsolatedSessionRequestId = nextIsolatedSessionRequestId >= Number.MAX_SAFE_INTEGER
            ? 1 : nextIsolatedSessionRequestId + 1;
        var requestId = 'isolated-' + nextIsolatedSessionRequestId.toString(36);
        var message = {
            type: type,
            version: 1,
            requestId: requestId,
            projectId: projectId,
        };
        if (operationId) message.operationId = operationId;
        if (sourceWorktree) message.sourceWorktree = sourceWorktree;
        button.disabled = true;
        button.setAttribute('aria-disabled', 'true');
        pendingIsolatedSessionRequests.set(requestId, {
            button: button,
            projectId: projectId,
            requestType: type,
            operationId: operationId || requestId,
        });
        window.vscode.postMessage(message);
    }

    function applyIsolatedSessionSettlement(message) {
        var expectedKeys = message && typeof message.errorCode === 'string'
            ? ['errorCode', 'operationId', 'requestId', 'status', 'type', 'version']
            : ['operationId', 'requestId', 'status', 'type', 'version'];
        if (!message || message.type !== 'isolated-session-settlement'
            || message.version !== 1
            || Object.keys(message).sort().some((key, index) => key !== expectedKeys[index])
            || Object.keys(message).length !== expectedKeys.length
            || typeof message.requestId !== 'string' || !message.requestId
            || typeof message.operationId !== 'string' || !message.operationId
            || (Object.prototype.hasOwnProperty.call(message, 'errorCode')
                && !/^[a-z0-9-]{1,64}$/.test(message.errorCode))
            || !['accepted', 'cancelled', 'rejected', 'succeeded', 'partial', 'failed']
                .includes(message.status)) {
            return false;
        }
        var pending = pendingIsolatedSessionRequests.get(message.requestId);
        if (!pending) return true;
        if (pending.operationId !== message.operationId) return true;
        if (message.status === 'accepted') return true;
        pendingIsolatedSessionRequests.delete(message.requestId);
        if (pending.button && pending.button.isConnected) {
            pending.button.disabled = false;
            pending.button.removeAttribute('aria-disabled');
        }
        var projectDiv = getAiSessionsUpdate().findCurrentWorkspaceDiv(pending.projectId);
        var liveRegion = projectDiv?.querySelector('[data-ai-session-live-region]');
        if (liveRegion) {
            liveRegion.textContent = message.status === 'succeeded'
                ? pending.requestType === 'cancel-isolated-session'
                    ? 'Worktree creation cancelled.'
                    : pending.requestType === 'dismiss-isolated-session'
                        ? 'Worktree creation dismissed.'
                        : 'Worktree created.'
                : message.status === 'cancelled'
                    ? 'Worktree creation cancelled.'
                    : `Worktree creation ${message.status}: ${describeProvisioningError(message.errorCode)}`;
        }
        return true;
    }

    // The per-worktree ⋯ menu is one shared body-level element; the context is
    // rebound from the clicked row every time it opens so a single menu can
    // serve quick create, per-provider create, branch-from-here, and removal.
    function toggleAiSessionWorktreeMenu(button, projectId) {
        var menu = document.getElementById('aiSessionWorktreeMenu');
        if (!menu || !button) return false;
        var wasOpen = menu.classList.contains('visible') && menu.__originButton === button;
        if (window.__agentPivotContextMenus
            && typeof window.__agentPivotContextMenus.closeContextMenus === 'function') {
            window.__agentPivotContextMenus.closeContextMenus();
        }
        if (wasOpen) return true;
        // Group rows always carry the menu (M3: group-level actions such as
        // rename must stay reachable even without a ready primary); the
        // worktree-targeted items below hide themselves when the row has no
        // usable primary worktree.
        var group = button.closest('.ai-session-worktree-group');
        if (!group) return false;
        menu.__context = {
            projectId: projectId,
            repositoryKey: group.getAttribute('data-worktree-repository-key') || '',
            worktreePath: group.getAttribute('data-worktree-path') || '',
            groupId: button.getAttribute('data-group-id')
                || group.getAttribute('data-group-id') || '',
            anchor: button.getAttribute('data-worktree-anchor') === 'true',
            canResume: button.getAttribute('data-can-resume') === 'true',
            canRemove: button.getAttribute('data-can-remove') === 'true',
            canBranchCreate: button.getAttribute('data-can-branch-create') === 'true'
                && button.getAttribute('data-worktree-head-kind') === 'branch',
            canMerge: button.getAttribute('data-can-merge') === 'true',
        };
        menu.__originButton = button;
        var hasWorktreeTarget = !!(menu.__context.repositoryKey && menu.__context.worktreePath);
        var branchItem = menu.querySelector('[data-action="worktree-branch-create"]');
        branchItem.textContent = 'New worktree from '
            + (button.getAttribute('data-worktree-name') || 'this branch');
        branchItem.hidden = !menu.__context.canBranchCreate || !hasWorktreeTarget;
        // "New worktree…" opens the plain creation form: it replaces the
        // removed surface-level button, and covers multi-root anchors where
        // a single seeded branch makes no sense.
        var newWorktreeItem = menu.querySelector('[data-action="worktree-new"]');
        newWorktreeItem.hidden = !menu.__context.anchor || !branchItem.hidden;
        var renameItem = menu.querySelector('[data-action="worktree-group-rename"]');
        renameItem.hidden = !menu.__context.groupId;
        var deriveItem = menu.querySelector('[data-action="worktree-group-derive"]');
        deriveItem.hidden = !menu.__context.groupId;
        var addRepoItem = menu.querySelector('[data-action="worktree-group-add-repo"]');
        addRepoItem.hidden = !menu.__context.groupId;
        var mergeItem = menu.querySelector('[data-action="merge-worktree-groups"]');
        mergeItem.hidden = !menu.__context.groupId || !menu.__context.canMerge;
        var groupDeleteItem = menu.querySelector('[data-action="worktree-group-delete"]');
        groupDeleteItem.hidden = !menu.__context.groupId;
        var removeItem = menu.querySelector('[data-action="worktree-remove"]');
        removeItem.hidden = !menu.__context.canRemove || !hasWorktreeTarget;
        var removeSeparator = menu.querySelector('[data-worktree-remove-separator]');
        if (removeSeparator) {
            removeSeparator.hidden = removeItem.hidden && renameItem.hidden;
        }

        button.setAttribute('aria-expanded', 'true');
        menu.style.visibility = 'hidden';
        menu.style.left = '0px';
        menu.style.top = '0px';
        menu.classList.add('visible');
        var buttonRect = button.getBoundingClientRect();
        var menuRect = menu.getBoundingClientRect();
        var viewportPadding = 4;
        var left = Math.max(viewportPadding, Math.min(
            buttonRect.right - menuRect.width,
            window.innerWidth - menuRect.width - viewportPadding
        ));
        var top = buttonRect.bottom + 2;
        if (top + menuRect.height > window.innerHeight - viewportPadding) {
            top = Math.max(viewportPadding, buttonRect.top - menuRect.height - 2);
        }
        menu.style.left = left + 'px';
        menu.style.top = top + 'px';
        menu.style.visibility = 'visible';
        var firstItem = menu.querySelector('[role="menuitem"]:not([hidden])');
        firstItem?.focus();
        return true;
    }

    function closeAiSessionWorktreeMenu() {
        var menu = document.getElementById('aiSessionWorktreeMenu');
        if (!menu) return;
        if (menu.__originButton) {
            menu.__originButton.setAttribute('aria-expanded', 'false');
        }
        menu.__originButton = null;
        menu.classList.remove('visible');
    }

    function activateAiSessionWorktreeMenuItem(item) {
        var menu = document.getElementById('aiSessionWorktreeMenu');
        var context = menu && menu.__context;
        var originButton = menu ? menu.__originButton : null;
        if (!menu || !context || !context.projectId) return;
        var action = item.getAttribute('data-action');
        // The Current anchor launches plain main-checkout sessions even
        // when it carries the main checkout's key for branch seeding.
        var worktreeKey = !context.anchor && context.repositoryKey && context.worktreePath
            ? {
                repositoryKey: context.repositoryKey,
                canonicalWorktreePath: context.worktreePath,
            }
            : null;
        if (action === 'worktree-branch-create' && context.canBranchCreate) {
            // M2: absorbed by the inline creation form with a branch seed
            // (PRD §6.1 entry absorption).
            if (worktreeGroupForm) {
                worktreeGroupForm.openForm(context.projectId, {
                    repositoryKey: context.repositoryKey,
                    worktreePath: context.worktreePath,
                });
            }
        } else if (action === 'worktree-new' && context.anchor) {
            // The anchor's New-worktree entry lives in the CHATS tree now:
            // make sure the tree is visible, then open the form in place.
            var projectDiv = getAiSessionsUpdate().findCurrentWorkspaceDiv(context.projectId);
            selectAiSessionTabDom(projectDiv, 'chats');
            writeAiSessionTabState(window.vscode, context.projectId, 'chats');
            postSelectedAiSessionViewTab(context.projectId, 'chats');
            if (worktreeGroupForm) {
                worktreeGroupForm.openForm(context.projectId, null);
            }
        } else if (action === 'worktree-group-rename' && context.groupId) {
            startWorktreeGroupRename(context.projectId, context.groupId);
        } else if (action === 'worktree-group-derive' && context.groupId) {
            if (worktreeGroupForm) {
                worktreeGroupForm.openForm(context.projectId, {
                    sourceGroupId: context.groupId,
                });
            }
        } else if (action === 'worktree-group-add-repo' && context.groupId) {
            if (worktreeGroupForm) {
                worktreeGroupForm.openForm(context.projectId, {
                    targetGroupId: context.groupId,
                });
            }
        } else if (action === 'merge-worktree-groups' && context.groupId && context.canMerge) {
            submitMergeWorktreeGroups(context.projectId, context.groupId, item);
        } else if (action === 'worktree-group-delete' && context.groupId) {
            startWorktreeGroupMemberDeletion(context.projectId, context.groupId, '', {
                mode: 'group',
            });
        } else if (action === 'worktree-remove' && context.canRemove) {
            var projectDiv = document.querySelector(
                '[data-open-session-surface][data-id="' + CSS.escape(context.projectId) + '"]'
            ) || document.querySelector(
                '.project[data-id="' + CSS.escape(context.projectId) + '"]'
            );
            var group = projectDiv && projectDiv.querySelector(
                '.ai-session-worktree-group[data-worktree-path="' + CSS.escape(context.worktreePath) + '"]'
            );
            if (!group || !originButton || !originButton.isConnected) return;
            submitManagedWorktreeRemoval(context.projectId, group, originButton);
        } else {
            return;
        }
        closeAiSessionWorktreeMenu();
    }

    function submitMergeWorktreeGroups(projectId, sourceGroupId, actionElement) {
        if (!projectId || !sourceGroupId || !actionElement) return;
        if (pendingMergeWorktreeGroupsRequests.size > 0) return;
        nextMergeWorktreeGroupsRequestId = nextMergeWorktreeGroupsRequestId
            >= Number.MAX_SAFE_INTEGER ? 1 : nextMergeWorktreeGroupsRequestId + 1;
        var requestId = 'worktree-merge-' + worktreeMergeDocumentNonce
            + '-' + nextMergeWorktreeGroupsRequestId.toString(36);
        actionElement.setAttribute('aria-disabled', 'true');
        pendingMergeWorktreeGroupsRequests.set(requestId, {
            actionElement: actionElement,
            projectId: projectId,
        });
        window.vscode.postMessage({
            type: 'merge-worktree-groups', version: 1,
            requestId: requestId, projectId: projectId,
            sourceGroupId: sourceGroupId,
        });
    }

    function applyWorktreeGroupMergeSettlement(message) {
        var expectedKeys = message && typeof message.errorCode === 'string'
            ? ['errorCode', 'requestId', 'status', 'type', 'version']
            : message && typeof message.groupId === 'string'
                ? ['groupId', 'requestId', 'status', 'type', 'version']
                : ['requestId', 'status', 'type', 'version'];
        if (!message || message.type !== 'worktree-group-merge-settlement'
            || message.version !== 1
            || Object.keys(message).length !== expectedKeys.length
            || Object.keys(message).sort().some((key, index) => key !== expectedKeys[index])
            || typeof message.requestId !== 'string' || !message.requestId
            || !['accepted', 'merged', 'cancelled', 'failed'].includes(message.status)
            || (Object.prototype.hasOwnProperty.call(message, 'errorCode')
                && !/^[a-z0-9-]{1,64}$/.test(message.errorCode))) return false;
        var pending = pendingMergeWorktreeGroupsRequests.get(message.requestId);
        if (!pending) return true;
        if (message.status === 'accepted') return true;
        pendingMergeWorktreeGroupsRequests.delete(message.requestId);
        if (pending.actionElement && pending.actionElement.isConnected) {
            pending.actionElement.removeAttribute('aria-disabled');
        }
        var projectDiv = getAiSessionsUpdate().findCurrentWorkspaceDiv(pending.projectId);
        var liveRegion = projectDiv?.querySelector('[data-ai-session-live-region]');
        if (liveRegion && message.status !== 'cancelled') {
            liveRegion.textContent = message.status === 'merged'
                ? 'Worktree groups merged.'
                : `Worktree group merge failed: ${message.errorCode || 'unknown'}`;
        }
        return true;
    }

    function submitManagedWorktreeRemoval(projectId, group, button) {
        if (!projectId || !group || !button || button.disabled) return;
        var repositoryKey = group.getAttribute('data-worktree-repository-key');
        var worktreePath = group.getAttribute('data-worktree-path');
        if (!repositoryKey || !worktreePath) return;
        nextManagedWorktreeRemovalRequestId = nextManagedWorktreeRemovalRequestId
            >= Number.MAX_SAFE_INTEGER ? 1 : nextManagedWorktreeRemovalRequestId + 1;
        var requestId = 'worktree-remove-' + nextManagedWorktreeRemovalRequestId.toString(36);
        button.disabled = true;
        button.setAttribute('aria-disabled', 'true');
        pendingManagedWorktreeRemovalRequests.set(requestId, {
            button: button,
            projectId: projectId,
        });
        window.vscode.postMessage({
            type: 'remove-managed-worktree', version: 1,
            requestId: requestId, projectId: projectId,
            repositoryKey: repositoryKey, worktreePath: worktreePath,
        });
    }

    function applyManagedWorktreeRemovalSettlement(message) {
        var expectedKeys = message && typeof message.errorCode === 'string'
            ? ['errorCode', 'requestId', 'status', 'type', 'version']
            : ['requestId', 'status', 'type', 'version'];
        if (!message || message.type !== 'managed-worktree-removal-settlement'
            || message.version !== 1
            || Object.keys(message).length !== expectedKeys.length
            || Object.keys(message).sort().some((key, index) => key !== expectedKeys[index])
            || typeof message.requestId !== 'string' || !message.requestId
            || !['accepted', 'cancelled', 'rejected', 'succeeded', 'partial', 'failed']
                .includes(message.status)
            || (Object.prototype.hasOwnProperty.call(message, 'errorCode')
                && !/^[a-z0-9-]{1,64}$/.test(message.errorCode))) return false;
        var pending = pendingManagedWorktreeRemovalRequests.get(message.requestId);
        if (!pending) return true;
        if (message.status === 'accepted') return true;
        pendingManagedWorktreeRemovalRequests.delete(message.requestId);
        if (pending.button && pending.button.isConnected) {
            pending.button.disabled = false;
            pending.button.removeAttribute('aria-disabled');
        }
        var projectDiv = getAiSessionsUpdate().findCurrentWorkspaceDiv(pending.projectId);
        var liveRegion = projectDiv?.querySelector('[data-ai-session-live-region]');
        if (liveRegion) {
            liveRegion.textContent = message.status === 'succeeded'
                ? 'Managed worktree removed; local branch kept.'
                : message.status === 'cancelled'
                    ? 'Worktree removal cancelled.'
                    : `Worktree removal ${message.status}: ${describeWorktreeRemovalError(message.errorCode)}`;
        }
        return true;
    }

    function submitSetGroupPrimaryRequest(projectId, button) {
        var groupId = button && button.getAttribute('data-group-id');
        var memberId = button && button.getAttribute('data-member-id');
        if (!projectId || !groupId || !memberId || button.disabled) return;
        nextSetGroupPrimaryRequestId = nextSetGroupPrimaryRequestId
            >= Number.MAX_SAFE_INTEGER ? 1 : nextSetGroupPrimaryRequestId + 1;
        var requestId = 'set-primary-' + nextSetGroupPrimaryRequestId.toString(36);
        // Transient pending state until the Host's terminal settlement (or
        // an authoritative refresh re-render) resolves it.
        button.disabled = true;
        button.setAttribute('aria-disabled', 'true');
        pendingSetGroupPrimaryRequests.set(requestId, {
            button: button,
            projectId: projectId,
            groupId: groupId,
            memberId: memberId,
        });
        window.vscode.postMessage({
            type: 'set-worktree-group-primary',
            version: 1,
            requestId: requestId,
            projectId: projectId,
            groupId: groupId,
            memberId: memberId,
        });
    }

    function applySetGroupPrimarySettlement(message) {
        var expectedKeys = message && typeof message.errorCode === 'string'
            ? ['errorCode', 'groupId', 'memberId', 'requestId', 'status', 'type', 'version']
            : ['groupId', 'memberId', 'requestId', 'status', 'type', 'version'];
        if (!message || message.type !== 'worktree-group-primary-settlement'
            || message.version !== 1
            || Object.keys(message).length !== expectedKeys.length
            || Object.keys(message).sort().some((key, index) => key !== expectedKeys[index])
            || typeof message.requestId !== 'string' || !message.requestId
            || typeof message.groupId !== 'string' || !message.groupId
            || typeof message.memberId !== 'string' || !message.memberId
            || !['accepted', 'settled', 'failed'].includes(message.status)
            || (Object.prototype.hasOwnProperty.call(message, 'errorCode')
                && !/^[a-z0-9-]{1,64}$/.test(message.errorCode))) return false;
        var pending = pendingSetGroupPrimaryRequests.get(message.requestId);
        if (!pending) return true;
        if (pending.groupId !== message.groupId
            || pending.memberId !== message.memberId) return true;
        if (message.status === 'accepted') return true;
        pendingSetGroupPrimaryRequests.delete(message.requestId);
        if (pending.button && pending.button.isConnected) {
            pending.button.disabled = false;
            pending.button.removeAttribute('aria-disabled');
        }
        if (message.status === 'failed') {
            var projectDiv = getAiSessionsUpdate().findCurrentWorkspaceDiv(pending.projectId);
            var liveRegion = projectDiv && projectDiv.querySelector('[data-ai-session-live-region]');
            if (liveRegion) {
                liveRegion.textContent = 'Could not set the primary worktree; try again.';
            }
        }
        return true;
    }

    // ---------- Worktree group rename (M3; PRD §5.2) ----------
    // The editor is local transient state: an unrelated authoritative
    // replacement captures and restores it (view-state script); a submitted
    // editor stays pending until the rename lands in the authoritative HTML
    // (the restored editor is skipped once the group's name changed), and a
    // failed settlement re-enables it in place — the host never refreshes on
    // failure because nothing authoritative changed.
    var pendingWorktreeGroupRenameRequests = new Map();
    var worktreeGroupRenameSerial = 0;
    // A per-document nonce keeps request ids unique across webview reloads:
    // a late settlement from a previous document can never correlate with a
    // request issued by this one.
    var worktreeGroupRenameDocumentNonce = Math.random().toString(36).slice(2, 10);

    function nextWorktreeGroupRenameRequestId() {
        worktreeGroupRenameSerial = worktreeGroupRenameSerial >= Number.MAX_SAFE_INTEGER
            ? 1 : worktreeGroupRenameSerial + 1;
        return 'group-rename-' + worktreeGroupRenameDocumentNonce
            + '-' + worktreeGroupRenameSerial.toString(36);
    }

    function findWorktreeGroupSection(projectDiv, groupId) {
        if (!projectDiv || typeof projectDiv.querySelectorAll !== 'function') return null;
        var sections = projectDiv.querySelectorAll('.ai-session-worktree-group[data-group-id]');
        for (var index = 0; index < sections.length; index++) {
            if (sections[index].getAttribute('data-group-id') === groupId) {
                return sections[index];
            }
        }
        return null;
    }

    function announceWorktreeGroupRename(projectId, text) {
        var projectDiv = getAiSessionsUpdate().findCurrentWorkspaceDiv(projectId);
        var liveRegion = projectDiv
            && projectDiv.querySelector('[data-ai-session-live-region]');
        if (liveRegion) {
            liveRegion.textContent = text;
        }
    }

    function cancelWorktreeGroupRename(projectDiv, options) {
        var editor = projectDiv
            && projectDiv.querySelector('.ai-session-worktree-rename-editor');
        if (!editor || editor.getAttribute('data-rename-pending') === 'true') return false;
        var section = editor.closest('.ai-session-worktree-group');
        var toolbar = section && section.querySelector('.ai-session-worktree-toolbar');
        editor.remove();
        if (toolbar) toolbar.hidden = false;
        if (section && !(options && options.keepFocus)) {
            var header = section.querySelector('.ai-session-worktree-header');
            if (header && typeof header.focus === 'function') {
                header.focus({ preventScroll: true });
            }
        }
        return true;
    }

    function buildWorktreeGroupRenameEditor(section, initialValue, options) {
        var toolbar = section.querySelector('.ai-session-worktree-toolbar');
        var title = section.querySelector('.ai-session-worktree-title');
        if (!toolbar || !title) return null;
        var groupId = section.getAttribute('data-group-id') || '';
        var editor = document.createElement('div');
        editor.className = 'ai-session-worktree-rename-editor';
        editor.setAttribute('data-rename-original-name', title.textContent || '');
        // Freeze the base revision when the editor opens: a replacement
        // that advances the group meanwhile must not let this edit post a
        // newer revision than the user ever saw — the host rejects stale
        // bases with group-changed.
        var baseRevision = options && options.baseRevision !== undefined
            ? options.baseRevision
            : parseInt(section.getAttribute('data-group-revision') || '', 10);
        editor.setAttribute('data-rename-base-revision', String(baseRevision));
        if (options && options.pending) {
            editor.setAttribute('data-rename-pending', 'true');
        }
        var input = document.createElement('input');
        input.className = 'ai-session-worktree-rename-input';
        input.type = 'text';
        input.maxLength = 200;
        input.value = initialValue;
        input.setAttribute('aria-label', 'Rename worktree group');
        input.setAttribute('aria-describedby', 'ai-session-worktree-rename-hint');
        if (options && options.pending) {
            input.readOnly = true;
            input.setAttribute('aria-disabled', 'true');
            editor.setAttribute('aria-busy', 'true');
        }
        var hint = document.createElement('span');
        hint.className = 'ai-session-worktree-rename-hint';
        hint.id = 'ai-session-worktree-rename-hint';
        hint.textContent = 'Enter to rename · Esc to cancel';
        editor.appendChild(input);
        editor.appendChild(hint);
        toolbar.hidden = true;
        section.insertBefore(editor, toolbar.nextSibling);
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                submitWorktreeGroupRenameEditor(section, editor, input);
            } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                cancelWorktreeGroupRename(section.closest('.project')
                    || section.closest('[data-open-session-surface][data-id]'));
            }
        });
        if (!options || !options.skipFocus) {
            input.focus({ preventScroll: true });
            if (typeof input.select === 'function' && !(options && options.pending)) {
                input.select();
            }
        }
        return editor;
    }

    function startWorktreeGroupRename(projectId, groupId) {
        var projectDiv = getAiSessionsUpdate().findCurrentWorkspaceDiv(projectId);
        var section = findWorktreeGroupSection(projectDiv, groupId);
        if (!section) return;
        // One editor per workspace card: a fresh rename supersedes an
        // unsubmitted editor; a submitted one keeps ownership until settled.
        var existing = projectDiv.querySelector('.ai-session-worktree-rename-editor');
        if (existing) {
            if (existing.getAttribute('data-rename-pending') === 'true') return;
            cancelWorktreeGroupRename(projectDiv, { keepFocus: true });
        }
        var title = section.querySelector('.ai-session-worktree-title');
        buildWorktreeGroupRenameEditor(section, title ? title.textContent || '' : '');
    }

    function submitWorktreeGroupRenameEditor(section, editor, input) {
        if (editor.getAttribute('data-rename-pending') === 'true') return;
        var projectDiv = section.closest('.project')
            || section.closest('[data-open-session-surface][data-id]');
        var projectId = projectDiv && projectDiv.getAttribute('data-id');
        var groupId = section.getAttribute('data-group-id') || '';
        var baseRevision = parseInt(
            editor.getAttribute('data-rename-base-revision') || '', 10);
        var value = (input.value || '').trim();
        if (!projectId || !groupId || !Number.isSafeInteger(baseRevision) || baseRevision < 1) {
            return;
        }
        if (!value) {
            announceWorktreeGroupRename(projectId, 'The group name cannot be empty.');
            input.focus({ preventScroll: true });
            return;
        }
        if (value === editor.getAttribute('data-rename-original-name')) {
            cancelWorktreeGroupRename(projectDiv);
            return;
        }
        var requestId = nextWorktreeGroupRenameRequestId();
        pendingWorktreeGroupRenameRequests.set(requestId, {
            projectId: projectId,
            groupId: groupId,
            awaitingReplacement: false,
        });
        editor.setAttribute('data-rename-pending', 'true');
        editor.setAttribute('data-rename-request-id', requestId);
        // readonly (not disabled) keeps focus stable: disabling the focused
        // input drops focus to <body> until the replacement arrives.
        input.readOnly = true;
        input.setAttribute('aria-disabled', 'true');
        editor.setAttribute('aria-busy', 'true');
        window.vscode.postMessage({
            type: 'rename-worktree-group',
            version: 1,
            requestId: requestId,
            projectId: projectId,
            groupId: groupId,
            displayName: value,
            baseRevision: baseRevision,
        });
    }

    function applyWorktreeGroupRenameSettlement(message) {
        var expectedKeys = message && typeof message.errorCode === 'string'
            ? ['errorCode', 'groupId', 'projectId', 'requestId', 'status', 'type', 'version']
            : ['groupId', 'projectId', 'requestId', 'status', 'type', 'version'];
        if (!message || message.type !== 'worktree-group-rename-settlement'
            || message.version !== 1
            || Object.keys(message).length !== expectedKeys.length
            || Object.keys(message).sort().some((key, index) => key !== expectedKeys[index])
            || typeof message.requestId !== 'string' || !message.requestId
            || typeof message.projectId !== 'string' || !message.projectId
            || typeof message.groupId !== 'string' || !message.groupId
            || !['accepted', 'settled', 'failed'].includes(message.status)
            || (Object.prototype.hasOwnProperty.call(message, 'errorCode')
                && !/^[a-z0-9-]{1,64}$/.test(message.errorCode))) return false;
        var pending = pendingWorktreeGroupRenameRequests.get(message.requestId);
        if (!pending || pending.groupId !== message.groupId
            || pending.projectId !== message.projectId) return true;
        if (message.status === 'accepted') return true;
        if (pending.awaitingReplacement) {
            // The terminal settled settlement already arrived; any later
            // settlement for this request is out of order — ignore it.
            return true;
        }
        if (message.status === 'settled') {
            // Keep the correlation until the authoritative replacement
            // actually applies: the restore hook below retires it when the
            // renamed row lands, and a lost publication is covered by the
            // host's full-refresh fallback.
            pending.awaitingReplacement = true;
            return true;
        }
        pendingWorktreeGroupRenameRequests.delete(message.requestId);
        var projectDiv = getAiSessionsUpdate().findCurrentWorkspaceDiv(pending.projectId);
        var section = findWorktreeGroupSection(projectDiv, pending.groupId);
        var editor = section
            && section.querySelector('.ai-session-worktree-rename-editor');
        var input = editor
            && editor.querySelector('.ai-session-worktree-rename-input');
        if (editor && input && editor.isConnected) {
            editor.removeAttribute('data-rename-pending');
            editor.removeAttribute('aria-busy');
            input.readOnly = false;
            input.removeAttribute('aria-disabled');
            input.focus({ preventScroll: true });
        }
        announceWorktreeGroupRename(
            pending.projectId,
            'Could not rename the worktree group; try again.'
        );
        return true;
    }

    // View-state hooks: an unsubmitted editor survives authoritative
    // replacements; a submitted one is restored only while the authoritative
    // name still equals the original (i.e. the rename has not landed yet).
    function captureWorktreeGroupRenameEditor(projectDiv) {
        if (!projectDiv || typeof projectDiv.querySelector !== 'function') return null;
        var editor = projectDiv.querySelector('.ai-session-worktree-rename-editor');
        if (!editor) return null;
        var section = editor.closest('.ai-session-worktree-group');
        var groupId = section && section.getAttribute('data-group-id');
        var input = editor.querySelector('.ai-session-worktree-rename-input');
        if (!groupId || !input) return null;
        return {
            groupId: groupId,
            value: input.value || '',
            originalName: editor.getAttribute('data-rename-original-name') || '',
            pending: editor.getAttribute('data-rename-pending') === 'true',
            requestId: editor.getAttribute('data-rename-request-id') || '',
            baseRevision: editor.getAttribute('data-rename-base-revision') || '',
        };
    }

    function restoreWorktreeGroupRenameEditor(projectDiv, state) {
        if (!projectDiv || !state || !state.groupId) return;
        var section = findWorktreeGroupSection(projectDiv, state.groupId);
        if (!section) return;
        // The replacement pipeline restores view state in two passes;
        // building the editor must be idempotent.
        if (section.querySelector('.ai-session-worktree-rename-editor')) return;
        var title = section.querySelector('.ai-session-worktree-title');
        var currentName = title ? title.textContent || '' : '';
        if (state.pending && currentName !== state.originalName) {
            // The rename landed: the authoritative row already shows it.
            // Retire the correlation — exactly by request id when known, so
            // even a replacement that races ahead of the settled settlement
            // cannot leak the pending entry — and park focus on the renamed
            // group's header.
            if (state.requestId) {
                pendingWorktreeGroupRenameRequests.delete(state.requestId);
            }
            pendingWorktreeGroupRenameRequests.forEach((pending, requestId) => {
                if (pending.awaitingReplacement && pending.groupId === state.groupId) {
                    pendingWorktreeGroupRenameRequests.delete(requestId);
                }
            });
            var header = section.querySelector('.ai-session-worktree-header');
            if (header && typeof header.focus === 'function') {
                header.focus({ preventScroll: true });
            }
            return;
        }
        var editor = buildWorktreeGroupRenameEditor(
            section,
            state.value,
            {
                pending: state.pending,
                skipFocus: true,
                baseRevision: state.baseRevision,
            }
        );
        if (editor && state.pending && state.requestId) {
            editor.setAttribute('data-rename-request-id', state.requestId);
        }
        if (editor && !state.pending) {
            var input = editor.querySelector('.ai-session-worktree-rename-input');
            if (input) {
                input.focus({ preventScroll: true });
                if (typeof input.setSelectionRange === 'function') {
                    input.setSelectionRange(input.value.length, input.value.length);
                }
            }
        }
    }

    window.__agentPivotWorktreeGroupRename = {
        capture: captureWorktreeGroupRenameEditor,
        restore: restoreWorktreeGroupRenameEditor,
    };

    // ---------- Worktree group member deletion (M3 batch 4; PRD §6.4) ----------
    // The confirmation card is local transient state, like the rename
    // editor: an unsubmitted card is captured/restored across authoritative
    // replacements (re-previewing so its data can never go stale), and a
    // submitted card stays pending until the correlated settlement plus
    // the authoritative replacement retires it — a settled deletion
    // removes the member row, a partial one replaces it with the
    // Retry/abandon banner, both observed in the replacement DOM.
    var pendingWorktreeGroupDeletionRequests = new Map();
    var pendingWorktreeGroupDeletionPreviews = new Map();
    var worktreeGroupDeletionSerial = 0;
    var worktreeGroupDeletionDocumentNonce = Math.random().toString(36).slice(2, 10);

    function nextWorktreeGroupDeletionRequestId(prefix) {
        worktreeGroupDeletionSerial = worktreeGroupDeletionSerial >= Number.MAX_SAFE_INTEGER
            ? 1 : worktreeGroupDeletionSerial + 1;
        return prefix + '-' + worktreeGroupDeletionDocumentNonce
            + '-' + worktreeGroupDeletionSerial.toString(36);
    }

    function findWorktreeGroupDeletionCard(projectDiv) {
        if (!projectDiv || typeof projectDiv.querySelector !== 'function') return null;
        return projectDiv.querySelector('.ai-session-worktree-deletion-card');
    }

    function announceWorktreeGroupDeletion(projectId, text) {
        var projectDiv = getAiSessionsUpdate().findCurrentWorkspaceDiv(projectId);
        var liveRegion = projectDiv
            && projectDiv.querySelector('[data-ai-session-live-region]');
        if (liveRegion) {
            liveRegion.textContent = text;
        }
    }

    function cancelWorktreeGroupDeletionCard(projectDiv, options) {
        var card = findWorktreeGroupDeletionCard(projectDiv);
        if (!card || card.getAttribute('data-deletion-pending') === 'true') return false;
        var section = card.closest('.ai-session-worktree-group');
        var memberId = card.getAttribute('data-member-id') || '';
        card.remove();
        if (!(options && options.keepFocus) && section) {
            var origin = memberId
                && section.querySelector('[data-action="preview-group-member-deletion"]'
                    + '[data-member-id="' + CSS.escape(memberId) + '"]');
            var focusTarget = origin
                || section.querySelector('.ai-session-worktree-header');
            if (focusTarget && typeof focusTarget.focus === 'function') {
                focusTarget.focus({ preventScroll: true });
            }
        }
        return true;
    }

    function buildWorktreeGroupDeletionCardShell(section, memberId) {
        var card = document.createElement('div');
        card.className = 'ai-session-worktree-deletion-card';
        card.setAttribute('data-member-id', memberId);
        card.setAttribute('role', 'group');
        card.setAttribute('aria-label', 'Confirm worktree removal');
        card.tabIndex = -1;
        var list = section.querySelector('.ai-session-worktree-session-list');
        (list || section).appendChild(card);
        card.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                cancelWorktreeGroupDeletionCard(section.closest('.project')
                    || section.closest('[data-open-session-surface][data-id]'));
            }
        });
        return card;
    }

    function renderWorktreeGroupDeletionCardLoading(section, memberId) {
        var card = buildWorktreeGroupDeletionCardShell(section, memberId);
        card.setAttribute('data-deletion-phase', 'loading');
        var text = document.createElement('div');
        text.className = 'ai-session-worktree-deletion-card-text';
        text.textContent = 'Checking the worktree…';
        card.appendChild(text);
        return card;
    }

    function describeDeletionBlocker(errorCode) {
        switch (errorCode) {
            case 'worktree-active': return 'an AI session is running in this worktree';
            case 'worktree-open': return 'the worktree is open in a workspace window';
            case 'worktree-provisioning': return 'the worktree is still being created';
            case 'worktree-not-removable': return 'the worktree is not in a removable state';
            case 'worktree-status-failed': return 'the worktree state could not be verified';
            case 'worktree-identity-changed': return 'the worktree branch changed unexpectedly';
            case 'uncommitted-changes': return 'the worktree has uncommitted changes';
            case 'deletion-blocked': return 'a session is being created in this worktree';
            case 'group-leased': return 'another deletion is in progress for this group';
            case 'group-changed': return 'the group changed; review the deletion again';
            case 'member-not-ready': return 'the member is not in a removable state';
            case 'store-full': return 'the local store is full';
            case 'store-corrupt': return 'the local store needs attention';
            default: return errorCode;
        }
    }

    function updateWorktreeGroupDeletionConfirmState(card) {
        var confirm = card.querySelector('[data-action="confirm-group-member-deletion"]');
        if (!confirm) return;
        var blocked = card.getAttribute('data-deletion-blocked') === 'true';
        var needsReplacement = card.getAttribute('data-replacement-required') === 'true';
        var chosen = needsReplacement
            ? !!card.querySelector('.ai-session-worktree-deletion-replacement:checked')
            : true;
        confirm.disabled = blocked || !chosen;
    }

    function renderWorktreeGroupDeletionCard(section, preview) {
        var memberId = preview.member && preview.member.memberId || '';
        var card = buildWorktreeGroupDeletionCardShell(section, memberId);
        card.setAttribute('data-deletion-phase', 'ready');
        card.setAttribute('data-base-revision', String(preview.groupRevision || 0));
        var mode = preview.mode || 'member';
        card.setAttribute('data-deletion-mode', mode);
        if (mode !== 'member') {
            return renderWorktreeGroupDeletionCardGroupMode(card, preview);
        }
        var member = preview.member;
        var lines = document.createElement('div');
        lines.className = 'ai-session-worktree-deletion-card-text';
        var title = document.createElement('div');
        title.className = 'ai-session-worktree-deletion-card-title';
        title.textContent = 'Remove ' + (member.repositoryLabel || 'worktree')
            + ' (' + member.branchName + ') from this group?';
        lines.appendChild(title);
        var pathLine = document.createElement('div');
        pathLine.className = 'ai-session-worktree-deletion-card-path';
        pathLine.textContent = member.path;
        lines.appendChild(pathLine);
        var detail = document.createElement('div');
        detail.className = 'ai-session-worktree-deletion-card-detail';
        detail.textContent = 'Only the worktree directory is deleted; the local branch is kept.'
            + (member.historyCount > 0
                ? ' ' + member.historyCount + ' past session'
                    + (member.historyCount === 1 ? '' : 's')
                    + ' will stay in Chats but cannot be resumed.'
                : '');
        lines.appendChild(detail);
        card.appendChild(lines);
        if (member.blocker) {
            card.setAttribute('data-deletion-blocked', 'true');
            var blockerLine = document.createElement('div');
            blockerLine.className = 'ai-session-worktree-deletion-card-error';
            blockerLine.setAttribute('role', 'alert');
            blockerLine.textContent = 'Cannot remove: '
                + describeDeletionBlocker(member.blocker) + '.';
            card.appendChild(blockerLine);
        }
        if (preview.replacementRequired
            && Array.isArray(preview.replacementCandidates)
            && preview.replacementCandidates.length) {
            card.setAttribute('data-replacement-required', 'true');
            var picker = document.createElement('div');
            picker.className = 'ai-session-worktree-deletion-replacements';
            picker.setAttribute('role', 'radiogroup');
            picker.setAttribute('aria-label', 'Choose the new primary worktree');
            var pickerHint = document.createElement('div');
            pickerHint.className = 'ai-session-worktree-deletion-card-detail';
            pickerHint.textContent = 'This is the primary worktree — choose its replacement:';
            picker.appendChild(pickerHint);
            preview.replacementCandidates.forEach(candidate => {
                var option = document.createElement('label');
                option.className = 'ai-session-worktree-deletion-replacement-option';
                var radio = document.createElement('input');
                radio.type = 'radio';
                radio.className = 'ai-session-worktree-deletion-replacement';
                radio.name = 'deletion-primary-replacement';
                radio.value = candidate.memberId;
                radio.addEventListener('change', () =>
                    updateWorktreeGroupDeletionConfirmState(card));
                option.appendChild(radio);
                option.appendChild(document.createTextNode(candidate.repositoryLabel));
                picker.appendChild(option);
            });
            card.appendChild(picker);
        }
        if (Array.isArray(preview.blockingClaims) && preview.blockingClaims.length) {
            card.setAttribute('data-deletion-blocked', 'true');
            var claimsBox = document.createElement('div');
            claimsBox.className = 'ai-session-worktree-deletion-claims';
            var claimsText = document.createElement('div');
            claimsText.className = 'ai-session-worktree-deletion-card-error';
            claimsText.setAttribute('role', 'alert');
            claimsText.textContent = 'A session start on this worktree never completed.'
                + ' Discard the unfinished start to allow the deletion.';
            claimsBox.appendChild(claimsText);
            preview.blockingClaims.forEach(claim => {
                var discard = document.createElement('button');
                discard.type = 'button';
                discard.className = 'ai-session-worktree-deletion-discard-claim';
                discard.setAttribute('data-action', 'discard-generation-claim');
                discard.setAttribute('data-claim-id', claim.claimId);
                discard.textContent = 'Discard unfinished '
                    + (claim.provider || 'session') + ' start';
                claimsBox.appendChild(discard);
            });
            card.appendChild(claimsBox);
        }
        var actions = document.createElement('div');
        actions.className = 'ai-session-worktree-deletion-card-actions';
        var cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'ai-session-worktree-deletion-cancel';
        cancel.setAttribute('data-action', 'cancel-group-member-deletion');
        cancel.textContent = 'Cancel';
        var confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.className = 'ai-session-worktree-deletion-confirm';
        confirm.setAttribute('data-action', 'confirm-group-member-deletion');
        confirm.textContent = 'Remove worktree';
        actions.appendChild(cancel);
        actions.appendChild(confirm);
        card.appendChild(actions);
        updateWorktreeGroupDeletionConfirmState(card);
        return card;
    }

    function renderWorktreeGroupDeletionCardGroupMode(card, preview) {
        var members = Array.isArray(preview.members) ? preview.members : [];
        var totalHistory = members.reduce((sum, member) => sum + (member.historyCount || 0), 0);
        var visibleOnly = preview.mode === 'visible-only';
        var lines = document.createElement('div');
        lines.className = 'ai-session-worktree-deletion-card-text';
        var title = document.createElement('div');
        title.className = 'ai-session-worktree-deletion-card-title';
        title.textContent = visibleOnly
            ? 'Remove the ' + members.length + ' visible worktree'
                + (members.length === 1 ? '' : 's') + ' of this group?'
            : 'Remove all ' + members.length + ' worktrees of this group?';
        lines.appendChild(title);
        var detail = document.createElement('div');
        detail.className = 'ai-session-worktree-deletion-card-detail';
        detail.textContent = 'Only the worktree directories are deleted; the local branches are kept.'
            + (totalHistory > 0
                ? ' ' + totalHistory + ' past session' + (totalHistory === 1 ? '' : 's')
                    + ' will stay in Chats but cannot be resumed.'
                : '');
        lines.appendChild(detail);
        card.appendChild(lines);
        var anyBlocked = false;
        members.forEach(member => {
            var row = document.createElement('div');
            row.className = 'ai-session-worktree-deletion-member';
            var label = document.createElement('span');
            label.className = 'ai-session-worktree-deletion-member-label';
            label.textContent = member.repositoryLabel + ' (' + member.branchName + ')';
            row.appendChild(label);
            var state = document.createElement('span');
            state.className = 'ai-session-worktree-deletion-member-state';
            if (member.blocker) {
                anyBlocked = true;
                state.textContent = describeDeletionBlocker(member.blocker);
                row.setAttribute('data-deletion-member-blocked', 'true');
            } else {
                state.textContent = 'ready';
            }
            row.appendChild(state);
            card.appendChild(row);
        });
        if (anyBlocked) {
            card.setAttribute('data-deletion-blocked', 'true');
            var blockedNote = document.createElement('div');
            blockedNote.className = 'ai-session-worktree-deletion-card-error';
            blockedNote.setAttribute('role', 'alert');
            blockedNote.textContent = 'Resolve the blocked worktrees, then review the deletion again.';
            card.appendChild(blockedNote);
        }
        if (preview.wholeGroupBlocked) {
            card.setAttribute('data-deletion-blocked', 'true');
            var detachedNote = document.createElement('div');
            detachedNote.className = 'ai-session-worktree-deletion-card-error';
            detachedNote.setAttribute('role', 'alert');
            detachedNote.textContent = (preview.detachedCount || 0) + ' worktree'
                + (preview.detachedCount === 1 ? '' : 's')
                + ' in this group belong to repositories outside the workspace and'
                + ' cannot be deleted. Restore the repositories to delete the whole'
                + ' group, or remove only the visible worktrees.';
            card.appendChild(detachedNote);
            var visibleSwitch = document.createElement('button');
            visibleSwitch.type = 'button';
            visibleSwitch.className = 'ai-session-worktree-deletion-visible-only';
            visibleSwitch.setAttribute('data-action', 'preview-group-visible-deletion');
            visibleSwitch.textContent = 'Remove visible worktrees instead';
            card.appendChild(visibleSwitch);
        }
        if (Array.isArray(preview.blockingClaims) && preview.blockingClaims.length) {
            card.setAttribute('data-deletion-blocked', 'true');
            var claimsBox = document.createElement('div');
            claimsBox.className = 'ai-session-worktree-deletion-claims';
            var claimsText = document.createElement('div');
            claimsText.className = 'ai-session-worktree-deletion-card-error';
            claimsText.setAttribute('role', 'alert');
            claimsText.textContent = 'A session start on one of these worktrees never'
                + ' completed. Discard the unfinished start to allow the deletion.';
            claimsBox.appendChild(claimsText);
            preview.blockingClaims.forEach(claim => {
                var discard = document.createElement('button');
                discard.type = 'button';
                discard.className = 'ai-session-worktree-deletion-discard-claim';
                discard.setAttribute('data-action', 'discard-generation-claim');
                discard.setAttribute('data-claim-id', claim.claimId);
                discard.textContent = 'Discard unfinished '
                    + (claim.provider || 'session') + ' start';
                claimsBox.appendChild(discard);
            });
            card.appendChild(claimsBox);
        }
        var actions = document.createElement('div');
        actions.className = 'ai-session-worktree-deletion-card-actions';
        var cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'ai-session-worktree-deletion-cancel';
        cancel.setAttribute('data-action', 'cancel-group-member-deletion');
        cancel.textContent = 'Cancel';
        var confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.className = 'ai-session-worktree-deletion-confirm';
        confirm.setAttribute('data-action', 'confirm-group-member-deletion');
        confirm.textContent = visibleOnly
            ? 'Remove visible worktrees'
            : 'Remove ' + members.length + ' worktree' + (members.length === 1 ? '' : 's');
        actions.appendChild(cancel);
        actions.appendChild(confirm);
        card.appendChild(actions);
        updateWorktreeGroupDeletionConfirmState(card);
        return card;
    }

    function startWorktreeGroupMemberDeletion(projectId, groupId, memberId, options) {
        var mode = options && options.mode || 'member';
        var projectDiv = getAiSessionsUpdate().findCurrentWorkspaceDiv(projectId);
        var section = findWorktreeGroupSection(projectDiv, groupId);
        if (!section || (mode === 'member' && !memberId)) return;
        var existing = findWorktreeGroupDeletionCard(projectDiv);
        if (existing) {
            if (existing.getAttribute('data-deletion-pending') === 'true') return;
            cancelWorktreeGroupDeletionCard(projectDiv, { keepFocus: true });
        }
        var requestId = nextWorktreeGroupDeletionRequestId('group-delete-preview');
        pendingWorktreeGroupDeletionPreviews.set(requestId, {
            projectId: projectId, groupId: groupId, memberId: memberId, mode: mode,
        });
        var loading = renderWorktreeGroupDeletionCardLoading(section, memberId);
        loading.setAttribute('data-deletion-mode', mode);
        window.vscode.postMessage({
            type: 'preview-worktree-group-deletion',
            version: 1,
            requestId: requestId,
            projectId: projectId,
            groupId: groupId,
            mode: mode,
            ...(mode === 'member' ? { memberId: memberId } : {}),
        });
    }

    function applyWorktreeGroupDeletionPreview(message) {
        if (!message || message.type !== 'worktree-group-deletion-preview'
            || message.version !== 1
            || typeof message.requestId !== 'string' || !message.requestId
            || typeof message.projectId !== 'string' || !message.projectId
            || typeof message.groupId !== 'string' || !message.groupId
            || (message.status !== 'ready' && message.status !== 'failed')) return false;
        var pending = pendingWorktreeGroupDeletionPreviews.get(message.requestId);
        if (!pending || pending.groupId !== message.groupId
            || pending.projectId !== message.projectId) return true;
        pendingWorktreeGroupDeletionPreviews.delete(message.requestId);
        var projectDiv = getAiSessionsUpdate().findCurrentWorkspaceDiv(pending.projectId);
        var section = findWorktreeGroupSection(projectDiv, pending.groupId);
        var card = findWorktreeGroupDeletionCard(projectDiv);
        if (!section || !card
            || card.getAttribute('data-member-id') !== pending.memberId
            || card.getAttribute('data-deletion-phase') !== 'loading'
            || card.getAttribute('data-deletion-pending') === 'true') return true;
        card.remove();
        if (message.status !== 'ready'
            || ((message.mode || 'member') === 'member' && !message.member)
            || ((message.mode || 'member') !== 'member' && !Array.isArray(message.members))) {
            announceWorktreeGroupDeletion(pending.projectId,
                'Could not prepare the deletion: '
                + describeDeletionBlocker(message.errorCode || 'deletion-failed') + '.');
            return true;
        }
        renderWorktreeGroupDeletionCard(section, message);
        var cardNow = findWorktreeGroupDeletionCard(projectDiv);
        if (cardNow) {
            cardNow.focus({ preventScroll: true });
        }
        return true;
    }

    function confirmWorktreeGroupMemberDeletion(card) {
        if (!card || card.getAttribute('data-deletion-pending') === 'true') return;
        var section = card.closest('.ai-session-worktree-group');
        var projectDiv = card.closest('.project')
            || card.closest('[data-open-session-surface][data-id]');
        var projectId = projectDiv && projectDiv.getAttribute('data-id');
        var groupId = section && section.getAttribute('data-group-id');
        var memberId = card.getAttribute('data-member-id') || '';
        var mode = card.getAttribute('data-deletion-mode') || 'member';
        var baseRevision = parseInt(card.getAttribute('data-base-revision') || '', 10);
        if (!projectId || !groupId || (mode === 'member' && !memberId)
            || !Number.isSafeInteger(baseRevision) || baseRevision < 1) return;
        var replacement = card.querySelector(
            '.ai-session-worktree-deletion-replacement:checked');
        var requestId = nextWorktreeGroupDeletionRequestId('group-delete');
        pendingWorktreeGroupDeletionRequests.set(requestId, {
            projectId: projectId,
            groupId: groupId,
            memberId: memberId,
            awaitingReplacement: false,
        });
        card.setAttribute('data-deletion-pending', 'true');
        card.setAttribute('data-deletion-request-id', requestId);
        card.setAttribute('aria-busy', 'true');
        card.querySelectorAll('button, input').forEach(control => {
            control.disabled = true;
        });
        card.focus({ preventScroll: true });
        window.vscode.postMessage({
            type: 'delete-worktree-group-member',
            version: 1,
            requestId: requestId,
            projectId: projectId,
            groupId: groupId,
            mode: mode,
            ...(mode === 'member' ? { memberId: memberId } : {}),
            baseRevision: baseRevision,
            ...(replacement ? { replacementPrimaryMemberId: replacement.value } : {}),
        });
    }

    function setWorktreeGroupDeletionBannerPending(banner, pending) {
        if (!banner) return;
        if (pending) {
            banner.setAttribute('aria-busy', 'true');
            banner.querySelectorAll('button').forEach(button => {
                button.disabled = true;
            });
        } else {
            banner.removeAttribute('aria-busy');
            banner.querySelectorAll('button').forEach(button => {
                button.disabled = false;
            });
        }
    }

    function submitWorktreeGroupDeletionOperation(button, kind) {
        var banner = button && button.closest('.ai-session-worktree-deletion');
        var section = button && button.closest('.ai-session-worktree-group');
        var projectDiv = button && (button.closest('.project')
            || button.closest('[data-open-session-surface][data-id]'));
        var projectId = projectDiv && projectDiv.getAttribute('data-id');
        var groupId = button.getAttribute('data-group-id') || '';
        var operationId = button.getAttribute('data-operation-id') || '';
        if (!projectId || !groupId || !operationId || button.disabled) return;
        var requestId = nextWorktreeGroupDeletionRequestId('group-delete-' + kind);
        pendingWorktreeGroupDeletionRequests.set(requestId, {
            projectId: projectId,
            groupId: groupId,
            memberId: '',
            banner: true,
            awaitingReplacement: false,
        });
        if (banner) {
            banner.setAttribute('data-deletion-request-id', requestId);
        }
        setWorktreeGroupDeletionBannerPending(banner, true);
        window.vscode.postMessage({
            type: kind === 'retry'
                ? 'retry-worktree-group-deletion'
                : 'abandon-worktree-group-deletion',
            version: 1,
            requestId: requestId,
            projectId: projectId,
            groupId: groupId,
            operationId: operationId,
        });
    }

    function submitWorktreeGroupClaimDiscard(button) {
        var card = button && button.closest('.ai-session-worktree-deletion-card');
        var section = button && button.closest('.ai-session-worktree-group');
        var projectDiv = button && (button.closest('.project')
            || button.closest('[data-open-session-surface][data-id]'));
        var projectId = projectDiv && projectDiv.getAttribute('data-id');
        var groupId = section && section.getAttribute('data-group-id') || '';
        var claimId = button.getAttribute('data-claim-id') || '';
        var memberId = card && card.getAttribute('data-member-id') || '';
        if (!projectId || !groupId || !claimId || button.disabled) return;
        var requestId = nextWorktreeGroupDeletionRequestId('group-claim-discard');
        pendingWorktreeGroupDeletionRequests.set(requestId, {
            projectId: projectId,
            groupId: groupId,
            memberId: memberId,
            claimDiscard: true,
            awaitingReplacement: false,
        });
        button.disabled = true;
        window.vscode.postMessage({
            type: 'discard-worktree-generation-claim',
            version: 1,
            requestId: requestId,
            projectId: projectId,
            groupId: groupId,
            claimId: claimId,
        });
    }

    function applyWorktreeGroupDeletionSettlement(message) {
        var baseKeys = ['groupId', 'projectId', 'requestId', 'status', 'type', 'version'];
        var withError = baseKeys.concat(['errorCode']);
        var withRevision = baseKeys.concat(['minimumAggregateRevision']);
        var withBoth = baseKeys.concat(['errorCode', 'minimumAggregateRevision']);
        var keys = message && typeof message === 'object'
            ? Object.keys(message).sort() : [];
        var matchesShape = [baseKeys, withError, withRevision, withBoth]
            .some(expected => {
                var sorted = expected.slice().sort();
                return keys.length === sorted.length
                    && keys.every((key, index) => key === sorted[index]);
            });
        if (!message || message.type !== 'worktree-group-deletion-settlement'
            || message.version !== 1 || !matchesShape
            || typeof message.requestId !== 'string' || !message.requestId
            || typeof message.projectId !== 'string' || !message.projectId
            || typeof message.groupId !== 'string' || !message.groupId
            || !['accepted', 'settled', 'partial', 'failed'].includes(message.status)
            || (Object.prototype.hasOwnProperty.call(message, 'errorCode')
                && !/^[a-z0-9-]{1,64}$/.test(message.errorCode))
            || (Object.prototype.hasOwnProperty.call(message, 'minimumAggregateRevision')
                && (!Number.isSafeInteger(message.minimumAggregateRevision)
                    || message.minimumAggregateRevision < 0))) return false;
        var pending = pendingWorktreeGroupDeletionRequests.get(message.requestId);
        if (!pending || pending.groupId !== message.groupId
            || pending.projectId !== message.projectId) return true;
        if (message.status === 'accepted') return true;
        if (pending.awaitingReplacement) {
            return true;
        }
        var projectDiv = getAiSessionsUpdate().findCurrentWorkspaceDiv(pending.projectId);
        if (message.status === 'failed') {
            pendingWorktreeGroupDeletionRequests.delete(message.requestId);
            if (pending.banner) {
                var section = findWorktreeGroupSection(projectDiv, pending.groupId);
                setWorktreeGroupDeletionBannerPending(section
                    && section.querySelector('.ai-session-worktree-deletion'), false);
            } else if (pending.claimDiscard) {
                var card = findWorktreeGroupDeletionCard(projectDiv);
                var discardButton = card && card.querySelector(
                    '[data-action="discard-generation-claim"]');
                if (discardButton) {
                    discardButton.disabled = false;
                }
            } else {
                var card = findWorktreeGroupDeletionCard(projectDiv);
                if (card && card.isConnected) {
                    card.removeAttribute('data-deletion-pending');
                    card.removeAttribute('aria-busy');
                    card.querySelectorAll('button, input').forEach(control => {
                        control.disabled = false;
                    });
                    updateWorktreeGroupDeletionConfirmState(card);
                }
            }
            announceWorktreeGroupDeletion(pending.projectId,
                'Deletion failed: '
                + describeDeletionBlocker(message.errorCode || 'deletion-failed') + '.');
            return true;
        }
        if (pending.claimDiscard) {
            // The claim is gone: re-run the preview so the card reflects
            // the now-unblocked deletion instead of trusting local edits.
            pendingWorktreeGroupDeletionRequests.delete(message.requestId);
            if (pending.memberId) {
                startWorktreeGroupMemberDeletion(
                    pending.projectId, pending.groupId, pending.memberId);
            }
            return true;
        }
        // settled / partial: keep the correlation until the authoritative
        // replacement lands (member row gone, or the Retry/abandon banner
        // visible) — the restore hook retires it.
        pending.awaitingReplacement = true;
        if (typeof message.minimumAggregateRevision === 'number') {
            // Decision J: the pending UI may only clear once a rendered
            // presentation at or beyond this aggregate revision applied.
            pending.minimumAggregateRevision = message.minimumAggregateRevision;
        }
        return true;
    }

    function worktreeGroupAggregateRevisionReached(minimum) {
        if (typeof minimum !== 'number') {
            return true;
        }
        var applied = window.__agentPivotWorktreeGroupAggregateRevision;
        return !!applied && applied.revision >= minimum;
    }

    function captureWorktreeGroupDeletionCard(projectDiv) {
        var card = findWorktreeGroupDeletionCard(projectDiv);
        if (!card) return null;
        var section = card.closest('.ai-session-worktree-group');
        var groupId = section && section.getAttribute('data-group-id');
        if (!groupId) return null;
        return {
            groupId: groupId,
            memberId: card.getAttribute('data-member-id') || '',
            mode: card.getAttribute('data-deletion-mode') || 'member',
            phase: card.getAttribute('data-deletion-phase') || 'loading',
            pending: card.getAttribute('data-deletion-pending') === 'true',
            requestId: card.getAttribute('data-deletion-request-id') || '',
        };
    }

    function restoreWorktreeGroupDeletionCard(projectDiv, state) {
        if (!projectDiv || !state || !state.groupId) return;
        var section = findWorktreeGroupSection(projectDiv, state.groupId);
        if (state.pending) {
            // Retire the pending correlation from the authoritative DOM:
            // the member row is gone (settled) or the deletion banner
            // took over (partial) — or the whole group disappeared.
            var memberGone = !section || !section.querySelector(
                '.ai-session-worktree-member-detail[data-member-id="'
                + CSS.escape(state.memberId) + '"]');
            var banner = section && section.querySelector('.ai-session-worktree-deletion');
            var pendingEntry = state.requestId
                ? pendingWorktreeGroupDeletionRequests.get(state.requestId)
                : null;
            var revisionPending = pendingEntry
                && !worktreeGroupAggregateRevisionReached(
                    pendingEntry.minimumAggregateRevision);
            if ((memberGone || banner) && !revisionPending) {
                if (state.requestId) {
                    pendingWorktreeGroupDeletionRequests.delete(state.requestId);
                }
                pendingWorktreeGroupDeletionRequests.forEach((entry, requestId) => {
                    if (entry.awaitingReplacement && entry.groupId === state.groupId
                        && worktreeGroupAggregateRevisionReached(
                            entry.minimumAggregateRevision)) {
                        pendingWorktreeGroupDeletionRequests.delete(requestId);
                    }
                });
                if (!section) {
                    // The whole group left with its last member: park
                    // focus on the next group header, else the Current
                    // anchor (PRD §6.4 focus rule).
                    var nextHeader = projectDiv.querySelector(
                        '.ai-session-worktree-group .ai-session-worktree-header');
                    var anchor = projectDiv.querySelector(
                        '.ai-session-worktree-anchor .ai-session-worktree-header');
                    var focusTarget = nextHeader || anchor;
                    if (focusTarget && typeof focusTarget.focus === 'function') {
                        focusTarget.focus({ preventScroll: true });
                    }
                } else {
                    var header = section.querySelector('.ai-session-worktree-header');
                    if (header && typeof header.focus === 'function' && !banner) {
                        header.focus({ preventScroll: true });
                    } else if (banner && typeof banner.focus === 'function') {
                        banner.tabIndex = -1;
                        banner.focus({ preventScroll: true });
                    }
                }
                return;
            }
            // Still executing: keep the pending card visible.
            if (section
                && !section.querySelector('.ai-session-worktree-deletion-card')) {
                var card = renderWorktreeGroupDeletionCardLoading(section, state.memberId);
                card.setAttribute('data-deletion-mode', state.mode || 'member');
                card.setAttribute('data-deletion-pending', 'true');
                card.setAttribute('aria-busy', 'true');
                if (state.requestId) {
                    card.setAttribute('data-deletion-request-id', state.requestId);
                }
                var text = card.querySelector('.ai-session-worktree-deletion-card-text');
                if (text) {
                    text.textContent = 'Removing the worktree…';
                }
            }
            return;
        }
        // Unsubmitted card: re-preview so the card never acts on stale
        // preview data after an authoritative replacement.
        startWorktreeGroupMemberDeletion(
            projectDiv.getAttribute('data-id'), state.groupId, state.memberId, {
                mode: state.mode || 'member',
            });
    }

    window.__agentPivotWorktreeGroupDeletion = {
        capture: captureWorktreeGroupDeletionCard,
        restore: restoreWorktreeGroupDeletionCard,
    };

    // ---------- Worktree adopt (M3 batch 8; PRD §6.5) ----------
    // The adopt card is local transient state like the deletion card: the
    // host re-validates every selected key against the live snapshot and
    // manifest, so stale card data can never adopt a claimed or vanished
    // worktree. A submitted card stays pending until the settlement and
    // the authoritative replacement (suggestion bar gone) retire it.
    var pendingWorktreeAdoptRequests = new Map();
    var worktreeAdoptSerial = 0;
    var worktreeAdoptDocumentNonce = Math.random().toString(36).slice(2, 10);

    function nextWorktreeAdoptRequestId() {
        worktreeAdoptSerial = worktreeAdoptSerial >= Number.MAX_SAFE_INTEGER
            ? 1 : worktreeAdoptSerial + 1;
        return 'adopt-' + worktreeAdoptDocumentNonce
            + '-' + worktreeAdoptSerial.toString(36);
    }

    function findWorktreeAdoptCard(projectDiv) {
        if (!projectDiv || typeof projectDiv.querySelector !== 'function') return null;
        return projectDiv.querySelector('.ai-session-worktree-adopt-card');
    }

    function cancelWorktreeAdoptCard(projectDiv) {
        var card = findWorktreeAdoptCard(projectDiv);
        if (!card || card.getAttribute('data-adopt-pending') === 'true') return false;
        var slug = card.getAttribute('data-adopt-slug') || '';
        card.remove();
        var origin = projectDiv && projectDiv.querySelector(
            '[data-action="adopt-worktree-cluster"][data-adopt-slug="' + CSS.escape(slug) + '"]');
        if (origin && typeof origin.focus === 'function') {
            origin.focus({ preventScroll: true });
        }
        return true;
    }

    function startWorktreeAdopt(button) {
        var suggestion = button.closest('.ai-session-worktree-adopt-suggestion');
        var projectDiv = button.closest('.project')
            || button.closest('[data-open-session-surface][data-id]');
        if (!suggestion || !projectDiv) return;
        var existing = findWorktreeAdoptCard(projectDiv);
        if (existing) {
            if (existing.getAttribute('data-adopt-pending') === 'true') return;
            cancelWorktreeAdoptCard(projectDiv);
        }
        var members = [];
        try {
            members = JSON.parse(suggestion.getAttribute('data-adopt-members') || '[]');
        } catch (_error) {
            return;
        }
        if (!Array.isArray(members) || !members.length) return;
        var slug = suggestion.getAttribute('data-adopt-slug') || '';
        var card = document.createElement('div');
        card.className = 'ai-session-worktree-adopt-card ai-session-worktree-deletion-card';
        card.setAttribute('data-adopt-slug', slug);
        card.setAttribute('role', 'group');
        card.setAttribute('aria-label', 'Adopt worktrees as a group');
        card.tabIndex = -1;
        var title = document.createElement('div');
        title.className = 'ai-session-worktree-deletion-card-title';
        title.textContent = 'Adopt ' + members.length + ' worktree'
            + (members.length === 1 ? '' : 's') + ' as a group';
        card.appendChild(title);
        members.forEach(member => {
            var option = document.createElement('label');
            option.className = 'ai-session-worktree-adopt-member';
            var check = document.createElement('input');
            check.type = 'checkbox';
            check.className = 'ai-session-worktree-adopt-member-check';
            check.checked = true;
            check.setAttribute('data-repository-key', member.repositoryKey);
            check.setAttribute('data-worktree-path', member.canonicalWorktreePath);
            option.appendChild(check);
            option.appendChild(document.createTextNode(
                member.repositoryLabel + ' (' + member.branchName + ')'));
            card.appendChild(option);
        });
        var nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'ai-session-worktree-adopt-name';
        nameInput.maxLength = 200;
        nameInput.value = slug;
        nameInput.setAttribute('aria-label', 'Group name');
        card.appendChild(nameInput);
        var select = document.createElement('select');
        select.className = 'ai-session-worktree-adopt-target';
        select.setAttribute('aria-label', 'Adopt into');
        var newOption = document.createElement('option');
        newOption.value = '';
        newOption.textContent = 'New group';
        select.appendChild(newOption);
        projectDiv.querySelectorAll('.ai-session-worktree-task-group').forEach(section => {
            var groupId = section.getAttribute('data-group-id');
            var name = section.querySelector('.ai-session-worktree-title');
            if (!groupId) return;
            var option = document.createElement('option');
            option.value = groupId;
            option.textContent = 'Add to: ' + (name ? name.textContent : groupId);
            select.appendChild(option);
        });
        card.appendChild(select);
        var actions = document.createElement('div');
        actions.className = 'ai-session-worktree-deletion-card-actions';
        var cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.setAttribute('data-action', 'cancel-worktree-adopt');
        cancel.className = 'ai-session-worktree-deletion-cancel';
        cancel.textContent = 'Cancel';
        var confirm = document.createElement('button');
        confirm.type = 'button';
        confirm.setAttribute('data-action', 'confirm-worktree-adopt');
        confirm.className = 'ai-session-worktree-deletion-confirm';
        confirm.textContent = 'Adopt';
        actions.appendChild(cancel);
        actions.appendChild(confirm);
        card.appendChild(actions);
        card.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                cancelWorktreeAdoptCard(projectDiv);
            }
        });
        suggestion.insertAdjacentElement('afterend', card);
        nameInput.focus({ preventScroll: true });
        if (typeof nameInput.select === 'function') {
            nameInput.select();
        }
    }

    function confirmWorktreeAdopt(card) {
        if (!card || card.getAttribute('data-adopt-pending') === 'true') return;
        var projectDiv = card.closest('.project')
            || card.closest('[data-open-session-surface][data-id]');
        var projectId = projectDiv && projectDiv.getAttribute('data-id');
        if (!projectId) return;
        var members = [];
        card.querySelectorAll('.ai-session-worktree-adopt-member-check:checked')
            .forEach(check => {
                members.push({
                    repositoryKey: check.getAttribute('data-repository-key'),
                    canonicalWorktreePath: check.getAttribute('data-worktree-path'),
                });
            });
        if (!members.length) return;
        var target = card.querySelector('.ai-session-worktree-adopt-target');
        var nameInput = card.querySelector('.ai-session-worktree-adopt-name');
        var targetGroupId = target && target.value || '';
        var displayName = nameInput && nameInput.value.trim() || '';
        if (!targetGroupId && !displayName) return;
        var requestId = nextWorktreeAdoptRequestId();
        pendingWorktreeAdoptRequests.set(requestId, {
            projectId: projectId,
            slug: card.getAttribute('data-adopt-slug') || '',
            awaitingReplacement: false,
        });
        card.setAttribute('data-adopt-pending', 'true');
        card.setAttribute('data-adopt-request-id', requestId);
        card.setAttribute('aria-busy', 'true');
        card.querySelectorAll('button, input, select').forEach(control => {
            control.disabled = true;
        });
        window.vscode.postMessage({
            type: 'adopt-worktrees',
            version: 1,
            requestId: requestId,
            projectId: projectId,
            members: members,
            ...(targetGroupId
                ? { targetGroupId: targetGroupId }
                : { displayName: displayName }),
        });
    }

    function applyWorktreeAdoptSettlement(message) {
        var baseKeys = ['projectId', 'requestId', 'status', 'type', 'version'];
        var withError = baseKeys.concat(['errorCode']);
        var withGroup = baseKeys.concat(['groupId']);
        var keys = message && typeof message === 'object'
            ? Object.keys(message).sort() : [];
        var matchesShape = [baseKeys, withError, withGroup]
            .map(expected => expected.slice().sort())
            .some(expected => keys.length === expected.length
                && keys.every((key, index) => key === expected[index]));
        if (!message || message.type !== 'worktree-adopt-settlement'
            || message.version !== 1 || !matchesShape
            || typeof message.requestId !== 'string' || !message.requestId
            || typeof message.projectId !== 'string' || !message.projectId
            || !['accepted', 'settled', 'failed'].includes(message.status)
            || (Object.prototype.hasOwnProperty.call(message, 'errorCode')
                && !/^[a-z0-9-]{1,64}$/.test(message.errorCode))) return false;
        var pending = pendingWorktreeAdoptRequests.get(message.requestId);
        if (!pending || pending.projectId !== message.projectId) return true;
        if (message.status === 'accepted') return true;
        if (pending.awaitingReplacement) return true;
        var projectDiv = getAiSessionsUpdate().findCurrentWorkspaceDiv(pending.projectId);
        if (message.status === 'failed') {
            pendingWorktreeAdoptRequests.delete(message.requestId);
            var card = findWorktreeAdoptCard(projectDiv);
            if (card && card.isConnected) {
                card.removeAttribute('data-adopt-pending');
                card.removeAttribute('aria-busy');
                card.querySelectorAll('button, input, select').forEach(control => {
                    control.disabled = false;
                });
            }
            announceWorktreeGroupDeletion(pending.projectId,
                'Could not adopt the worktrees: '
                + describeDeletionBlocker(message.errorCode || 'adopt-failed') + '.');
            return true;
        }
        pending.awaitingReplacement = true;
        return true;
    }

    function captureWorktreeAdoptCard(projectDiv) {
        var card = findWorktreeAdoptCard(projectDiv);
        if (!card) return null;
        return {
            slug: card.getAttribute('data-adopt-slug') || '',
            pending: card.getAttribute('data-adopt-pending') === 'true',
            requestId: card.getAttribute('data-adopt-request-id') || '',
        };
    }

    function restoreWorktreeAdoptCard(projectDiv, state) {
        if (!projectDiv || !state || !state.slug) return;
        var bar = projectDiv.querySelector(
            '.ai-session-worktree-adopt-suggestion[data-adopt-slug="'
            + CSS.escape(state.slug) + '"]');
        if (state.pending) {
            if (!bar) {
                // The suggestion is gone: the adoption landed. Retire the
                // correlation and park focus on the group list.
                if (state.requestId) {
                    pendingWorktreeAdoptRequests.delete(state.requestId);
                }
                pendingWorktreeAdoptRequests.forEach((entry, requestId) => {
                    if (entry.awaitingReplacement) {
                        pendingWorktreeAdoptRequests.delete(requestId);
                    }
                });
                var header = projectDiv.querySelector(
                    '.ai-session-worktree-task-group .ai-session-worktree-header');
                if (header && typeof header.focus === 'function') {
                    header.focus({ preventScroll: true });
                }
                return;
            }
            if (!findWorktreeAdoptCard(projectDiv)) {
                var button = bar.querySelector('[data-action="adopt-worktree-cluster"]');
                if (button) {
                    startWorktreeAdopt(button);
                    var card = findWorktreeAdoptCard(projectDiv);
                    if (card) {
                        card.setAttribute('data-adopt-pending', 'true');
                        card.setAttribute('aria-busy', 'true');
                        if (state.requestId) {
                            card.setAttribute('data-adopt-request-id', state.requestId);
                        }
                        card.querySelectorAll('button, input, select').forEach(control => {
                            control.disabled = true;
                        });
                    }
                }
            }
            return;
        }
        if (bar && !findWorktreeAdoptCard(projectDiv)) {
            var origin = bar.querySelector('[data-action="adopt-worktree-cluster"]');
            if (origin) {
                startWorktreeAdopt(origin);
            }
        }
    }

    window.__agentPivotWorktreeAdopt = {
        capture: captureWorktreeAdoptCard,
        restore: restoreWorktreeAdoptCard,
    };

    function describeProvisioningError(errorCode) {
        switch (errorCode) {
            case 'repository-has-no-commits':
                return 'the repository has no commits yet; make an initial commit first';
            case 'invalid-plan':
                return 'the saved creation plan is no longer valid; dismiss and recreate';
            case 'interrupted':
                return 'interrupted by a reload; retry or dismiss';
            case 'snapshot-unavailable':
                return 'worktree discovery is not ready yet; try again';
            case 'workspace-untrusted':
                return 'the workspace is not trusted';
            case 'repository-unavailable':
                return 'no usable repository found in this workspace';
            case 'base-ref-unavailable':
                return 'that worktree has no branch to base on';
            case 'duplicate-operation':
            case 'operation-running':
                return 'another creation is already in progress';
            case 'invalid-task':
                return 'enter a task name';
            case 'setup-failed':
                return 'the setup command failed';
            case 'worktree-create-failed':
                return 'Git could not create the worktree';
            case 'git-timeout':
                return 'Git timed out';
            default:
                return (errorCode || 'try again') + '';
        }
    }

    function describeWorktreeRemovalError(errorCode) {
        switch (errorCode) {
            case 'worktree-dirty':
                return 'the worktree has uncommitted changes';
            case 'worktree-not-removable':
                return 'it is not a removable Agent Pivot worktree';
            case 'worktree-active':
                return 'a session is still running in it';
            case 'worktree-open':
                return 'it is open as a workspace';
            case 'worktree-provisioning':
                return 'it is still being created';
            case 'operation-running':
                return 'another removal is already in progress';
            default:
                return (errorCode || 'try again') + '';
        }
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
        var stateStore = typeof getAiSessionPresentationStateStore === 'function'
            ? getAiSessionPresentationStateStore() : null;
        var eventIds = stateStore
            ? stateStore.getAttentionEventIds(provider, sessionId) : [];
        if (!eventIds.length && fallbackEventId) {
            eventIds = [fallbackEventId];
        }
        eventIds = Array.from(new Set(eventIds.filter(eventId => typeof eventId === 'string' && !!eventId)));
        if (eventIds.length) {
            var presentation = stateStore ? stateStore.getCurrent() : null;
            if (!presentation
                || presentation.type !== 'ai-session-presentation-state'
                || presentation.version !== 1
                || !Number.isSafeInteger(presentation.projectionRevision)
                || presentation.projectionRevision < 1
                || typeof presentation.workspaceScopeIdentity !== 'string'
                || !presentation.workspaceScopeIdentity) {
                window.vscode.postMessage({ type: 'acknowledge-ai-session-attention', eventIds: eventIds });
                return;
            }
            var pendingKey = presentation.workspaceScopeIdentity + '|' + sessionKey;
            if (pendingAiSessionAttentionAcknowledgements.has(pendingKey)) return;
            nextAiSessionAttentionAcknowledgementRequestId =
                nextAiSessionAttentionAcknowledgementRequestId >= Number.MAX_SAFE_INTEGER
                    ? 1 : nextAiSessionAttentionAcknowledgementRequestId + 1;
            var pending = {
                requestId: nextAiSessionAttentionAcknowledgementRequestId,
                provider: provider,
                sessionId: sessionId,
                workspaceScopeIdentity: presentation.workspaceScopeIdentity,
                projectionRevision: presentation.projectionRevision,
                eventIds: eventIds.slice(),
                committed: false,
                timeoutHandle: null,
            };
            if (typeof window.setTimeout === 'function') {
                pending.timeoutHandle = window.setTimeout(() => {
                    if (pendingAiSessionAttentionAcknowledgements.get(pendingKey) !== pending) return;
                    var currentPresentation = stateStore ? stateStore.getCurrent() : null;
                    if (!currentPresentation
                        || currentPresentation.workspaceScopeIdentity
                            !== pending.workspaceScopeIdentity) {
                        clearAiSessionAttentionAcknowledgement(pendingKey, pending);
                        return;
                    }
                    clearAiSessionAttentionAcknowledgement(pendingKey, pending);
                    announceAiSessionAttentionAcknowledgement(
                        pending,
                        'Attention update timed out. Refreshing…'
                    );
                    getAiSessionsUpdate().requestFullRefresh('ai-session-attention-acknowledgement-timeout');
                }, Number.isSafeInteger(window.__agentPivotAttentionAcknowledgementTimeoutMs)
                    && window.__agentPivotAttentionAcknowledgementTimeoutMs > 0
                    ? window.__agentPivotAttentionAcknowledgementTimeoutMs : 15_000);
            }
            pendingAiSessionAttentionAcknowledgements.set(pendingKey, pending);
            syncAiSessionAttentionAcknowledgementDom();
            window.vscode.postMessage({
                type: 'acknowledge-ai-session-attention',
                version: 1,
                requestId: pending.requestId,
                provider: provider,
                sessionId: sessionId,
                workspaceScopeIdentity: pending.workspaceScopeIdentity,
                projectionRevision: pending.projectionRevision,
                eventIds: pending.eventIds,
            });
        }
    }

    function clearAiSessionAttentionAcknowledgement(sessionKey, pending) {
        if (pendingAiSessionAttentionAcknowledgements.get(sessionKey) !== pending) return;
        if (pending.timeoutHandle !== null && typeof window.clearTimeout === 'function') {
            window.clearTimeout(pending.timeoutHandle);
        }
        pendingAiSessionAttentionAcknowledgements.delete(sessionKey);
        syncAiSessionAttentionAcknowledgementDom();
    }

    function announceAiSessionAttentionAcknowledgement(pending, message) {
        var stateStore = typeof getAiSessionPresentationStateStore === 'function'
            ? getAiSessionPresentationStateStore() : null;
        var presentation = stateStore ? stateStore.getCurrent() : null;
        if (!presentation
            || presentation.workspaceScopeIdentity !== pending.workspaceScopeIdentity) return;
        var row = document.querySelector(
            '.codex-session-row[data-session-provider="' + pending.provider
                + '"][data-session-id="' + CSS.escape(pending.sessionId) + '"]'
        );
        var project = row && row.closest('[data-open-session-surface][data-current-workspace]');
        var liveRegion = project && project.querySelector('[data-ai-session-live-region]');
        if (liveRegion) liveRegion.textContent = message;
    }

    function syncAiSessionAttentionAcknowledgementDom() {
        document.querySelectorAll('.codex-session-row[data-attention-acknowledgement-pending]')
            .forEach(row => row.removeAttribute('data-attention-acknowledgement-pending'));
        var stateStore = typeof getAiSessionPresentationStateStore === 'function'
            ? getAiSessionPresentationStateStore() : null;
        var presentation = stateStore ? stateStore.getCurrent() : null;
        pendingAiSessionAttentionAcknowledgements.forEach(pending => {
            if (!presentation
                || presentation.workspaceScopeIdentity !== pending.workspaceScopeIdentity) return;
            document.querySelectorAll('.codex-session-row[data-session-provider][data-session-id]')
                .forEach(row => {
                    if (row.getAttribute('data-session-provider') === pending.provider
                        && row.getAttribute('data-session-id') === pending.sessionId) {
                        row.setAttribute('data-attention-acknowledgement-pending', '');
                    }
                });
        });
    }

    function reconcileAiSessionAttentionAcknowledgements() {
        var stateStore = typeof getAiSessionPresentationStateStore === 'function'
            ? getAiSessionPresentationStateStore() : null;
        var presentation = stateStore ? stateStore.getCurrent() : null;
        if (!presentation || presentation.type !== 'ai-session-presentation-state') return;
        pendingAiSessionAttentionAcknowledgements.forEach((pending, pendingKey) => {
            if (presentation.workspaceScopeIdentity !== pending.workspaceScopeIdentity) {
                clearAiSessionAttentionAcknowledgement(pendingKey, pending);
                return;
            }
            if (!pending.committed
                || presentation.projectionRevision < pending.projectionRevision) return;
            var currentEventIds = stateStore.getAttentionEventIds(
                pending.provider,
                pending.sessionId
            );
            if (pending.eventIds.some(eventId => currentEventIds.includes(eventId))) return;
            clearAiSessionAttentionAcknowledgement(pendingKey, pending);
        });
        syncAiSessionAttentionAcknowledgementDom();
    }

    function applyAiSessionAttentionAcknowledgementResult(message) {
        if (!message
            || Object.keys(message).sort().join('\n') !== [
                'outcome', 'projectionRevision', 'provider', 'requestId', 'sessionId',
                'type', 'version', 'workspaceScopeIdentity',
            ].sort().join('\n')
            || message.type !== 'ai-session-attention-acknowledgement-result'
            || message.version !== 1
            || !Number.isSafeInteger(message.requestId) || message.requestId < 1
            || !isAiSessionProvider(message.provider)
            || typeof message.sessionId !== 'string' || !message.sessionId
            || typeof message.workspaceScopeIdentity !== 'string' || !message.workspaceScopeIdentity
            || !Number.isSafeInteger(message.projectionRevision) || message.projectionRevision < 1
            || !['committed', 'degraded-local', 'rejected'].includes(message.outcome)) {
            return false;
        }
        var pendingKey = message.workspaceScopeIdentity + '|'
            + message.provider + ':' + message.sessionId;
        var pending = pendingAiSessionAttentionAcknowledgements.get(pendingKey);
        if (!pending
            || pending.requestId !== message.requestId
            || pending.workspaceScopeIdentity !== message.workspaceScopeIdentity
            || pending.projectionRevision !== message.projectionRevision) return true;
        if (message.outcome === 'committed') {
            pending.committed = true;
            reconcileAiSessionAttentionAcknowledgements();
            return true;
        }
        clearAiSessionAttentionAcknowledgement(pendingKey, pending);
        announceAiSessionAttentionAcknowledgement(
            pending,
            message.outcome === 'degraded-local'
                ? 'Attention cleared in this window, but cross-window sync could not be confirmed.'
                : 'Could not clear session attention. Try again.'
        );
        return true;
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
        document.querySelectorAll('.project[data-id], [data-open-session-surface][data-id]').forEach(projectDiv => {
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

    // CHATS ▾ 视图菜单（M2 壳）：单选项 tree；View as List 随 M3 到达。
    // 语义与 provider 菜单一致：触发键 aria-expanded、菜单 hidden、
    // Esc/失焦/外部点击关闭，键盘关闭才把焦点还给触发按钮。
    function setChatsViewMenuOpen(projectDiv, open) {
        var trigger = projectDiv
            && projectDiv.querySelector('[data-action="toggle-chats-view-menu"]');
        var menu = projectDiv && projectDiv.querySelector('[data-chats-view-menu]');
        if (!trigger || !menu) {
            return;
        }
        trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
        menu.hidden = !open;
        if (open) {
            var current = menu.querySelector('[role="menuitemradio"][aria-checked="true"]')
                || menu.querySelector('[role="menuitemradio"]');
            if (current && typeof current.focus === 'function') {
                current.focus();
            }
        }
    }

    function setChatsViewModeDom(projectDiv, viewMode) {
        if (!projectDiv || (viewMode !== 'tree' && viewMode !== 'list')) {
            return;
        }
        var region = projectDiv.querySelector('[data-ai-session-region]');
        if (region) {
            region.setAttribute('data-chats-view-mode', viewMode);
        }
        projectDiv.querySelectorAll('[data-action="select-chats-view-mode"][data-view-mode]')
            .forEach(item => {
                var selected = item.getAttribute('data-view-mode') === viewMode;
                item.setAttribute('aria-checked', selected ? 'true' : 'false');
                var check = item.querySelector('.ai-session-view-menu-check');
                if (check) check.textContent = selected ? '✓' : '';
            });
    }

    function closeChatsViewMenu(projectDiv, restoreFocus) {
        setChatsViewMenuOpen(projectDiv, false);
        if (restoreFocus) {
            projectDiv?.querySelector('[data-action="toggle-chats-view-menu"]')?.focus();
        }
    }

    function toggleChatsViewMenu(projectDiv, trigger) {
        if (!projectDiv || !trigger) {
            return;
        }
        var open = trigger.getAttribute('aria-expanded') !== 'true';
        closeChatsViewMenus(projectDiv);
        setChatsViewMenuOpen(projectDiv, open);
    }

    function closeChatsViewMenus(exceptProjectDiv) {
        document.querySelectorAll('[data-open-session-surface][data-id]').forEach(projectDiv => {
            if (projectDiv !== exceptProjectDiv) {
                setChatsViewMenuOpen(projectDiv, false);
            }
        });
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

    function syncAiSessionBatchManagementDom(projectDiv) {
        var snapshot = batchAiSessionManager.snapshot();
        document.querySelectorAll(
            '.project[data-ai-session-managing], .project[data-ai-session-pending], '
            + '[data-open-session-surface][data-ai-session-managing], '
            + '[data-open-session-surface][data-ai-session-pending]'
        ).forEach(project => {
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
        applyAiSessionAttentionAcknowledgementResult: applyAiSessionAttentionAcknowledgementResult,
        applyIsolatedSessionSettlement: applyIsolatedSessionSettlement,
        applyManagedWorktreeRemovalSettlement: applyManagedWorktreeRemovalSettlement,
        applySetGroupPrimarySettlement: applySetGroupPrimarySettlement,
        applyWorktreeGroupMergeSettlement: applyWorktreeGroupMergeSettlement,
        applyWorktreeGroupRenameSettlement: applyWorktreeGroupRenameSettlement,
        applyWorktreeGroupDeletionPreview: applyWorktreeGroupDeletionPreview,
        applyWorktreeGroupDeletionSettlement: applyWorktreeGroupDeletionSettlement,
        applyWorktreeAdoptSettlement: applyWorktreeAdoptSettlement,
        setWorktreeGroupForm: setWorktreeGroupForm,
        getPendingAiSessionProviderSelectionProjectId: getPendingAiSessionProviderSelectionProjectId,
        activateAiSessionProviderOption: activateAiSessionProviderOption,
        activateAiSessionWorktreeMenuItem: activateAiSessionWorktreeMenuItem,
        applyAiSessionProviderSelectionResult: applyAiSessionProviderSelectionResult,
        closeAiSessionProviderMenu: closeAiSessionProviderMenu,
        closeAiSessionProviderMenus: closeAiSessionProviderMenus,
        setChatsViewMenuOpen: setChatsViewMenuOpen,
        setChatsViewModeDom: setChatsViewModeDom,
        closeChatsViewMenu: closeChatsViewMenu,
        closeChatsViewMenus: closeChatsViewMenus,
        closeAiSessionWorktreeMenu: closeAiSessionWorktreeMenu,
        toggleAiSessionWorktreeMenu: toggleAiSessionWorktreeMenu,
        exitAiSessionBatchManagement: exitAiSessionBatchManagement,
        getAiSessionProviderOptions: getAiSessionProviderOptions,
        getArchiveAiSessionMessageType: getArchiveAiSessionMessageType,
        getResumeAiSessionMessageType: getResumeAiSessionMessageType,
        getSelectedAiSessionProviders: getSelectedAiSessionProviders,
        isAiSessionProvider: isAiSessionProvider,
        onTriggerAiSessionAction: onTriggerAiSessionAction,
        reconcilePendingAiSessionProviderSelectionDom: reconcilePendingAiSessionProviderSelectionDom,
        reconcileAiSessionAttentionAcknowledgements: reconcileAiSessionAttentionAcknowledgements,
        setAiSessionProviderMenuOpen: setAiSessionProviderMenuOpen,
        submitAiSessionProviderSelection: submitAiSessionProviderSelection,
        syncAiSessionBatchManagementDom: syncAiSessionBatchManagementDom,
        toggleAiSessionProviderMenu: toggleAiSessionProviderMenu,
        toggleCodexSessions: toggleCodexSessions,
    };
}
