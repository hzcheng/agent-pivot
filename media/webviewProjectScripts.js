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
    var aiSessionControls = initProjectAiSessionControls({
        getAiSessionsUpdate: () => aiSessionsUpdate,
        updateStickyGroupHeaderOffset: updateStickyGroupHeaderOffset,
    });
    var contextMenus = initProjectContextMenus({
        openProject: openProject,
        ProjectOpenType: ProjectOpenType,
        getResumeAiSessionMessageType: aiSessionControls.getResumeAiSessionMessageType,
        getArchiveAiSessionMessageType: aiSessionControls.getArchiveAiSessionMessageType,
        isAiSessionProvider: aiSessionControls.isAiSessionProvider,
    });
    function syncActiveAiSessionProjectionDom(adoptRenderedFocus, revealFocused) {
        if (adoptRenderedFocus !== false) {
            var focusedRow = document.querySelector(
                '.codex-session-row[data-session-focused][data-session-provider]'
            );
            var provider = focusedRow && focusedRow.getAttribute('data-session-provider');
            aiSessionControls.activeAiSessionTerminalState.provider =
                aiSessionControls.isAiSessionProvider(provider) ? provider : null;
            aiSessionControls.activeAiSessionTerminalState.sessionId = focusedRow
                ? focusedRow.getAttribute('data-session-id') : null;
            aiSessionControls.activeAiSessionTerminalState.pendingId = focusedRow
                ? focusedRow.getAttribute('data-pending-id') : null;
        } else {
            var projectedFocusedRow = null;
            document.querySelectorAll(
                '.codex-session-row[data-session-provider][data-session-id],'
                    + '.codex-session-row[data-session-provider][data-pending-id]'
            ).forEach(row => {
                var providerMatches = row.getAttribute('data-session-provider')
                    === aiSessionControls.activeAiSessionTerminalState.provider;
                var focused = providerMatches && (
                    (aiSessionControls.activeAiSessionTerminalState.sessionId !== null
                        && row.getAttribute('data-session-id')
                            === aiSessionControls.activeAiSessionTerminalState.sessionId)
                    || (aiSessionControls.activeAiSessionTerminalState.pendingId !== null
                        && row.getAttribute('data-pending-id')
                            === aiSessionControls.activeAiSessionTerminalState.pendingId)
                );
                if (focused) projectedFocusedRow = row;
                row.toggleAttribute(
                    'data-session-focused',
                    focused
                );
                var primaryAction = row.querySelector('.ai-session-primary-action');
                if (primaryAction) {
                    var focusedConversation = focused && row.hasAttribute('data-session-id');
                    var actionState = focusedConversation ? 'conversation' : 'focus';
                    var actionAriaLabel = primaryAction.getAttribute(
                        'data-' + actionState + '-aria-label'
                    );
                    var actionTitle = primaryAction.getAttribute(
                        'data-' + actionState + '-title'
                    );
                    if (actionAriaLabel) primaryAction.setAttribute('aria-label', actionAriaLabel);
                    if (actionTitle) primaryAction.setAttribute('title', actionTitle);
                }
                var conversationHint = row.querySelector('.ai-session-open-conversation-hint');
                if (focusedConversation
                    && primaryAction && !conversationHint) {
                    conversationHint = document.createElement('span');
                    conversationHint.className = 'ai-session-open-conversation-hint';
                    conversationHint.setAttribute('aria-hidden', 'true');
                    conversationHint.textContent = '›';
                    primaryAction.appendChild(conversationHint);
                } else if (!focused && conversationHint) {
                    conversationHint.remove();
                }
            });
            if (projectedFocusedRow && revealFocused) {
                projectedFocusedRow.scrollIntoView({ block: 'nearest' });
            }
        }
        aiSessionControls.syncActiveAiSessionTerminalDom();
    }
    function setAiSessionAttentionDom(row, eventIds, needsAttention) {
        row.toggleAttribute('data-session-needs-attention', needsAttention);
        row.toggleAttribute('data-ai-session-attention', needsAttention);
        if (needsAttention && eventIds.length) {
            row.setAttribute('data-session-event-id', eventIds[0]);
        } else {
            row.removeAttribute('data-session-event-id');
        }
        var primaryAction = row.querySelector('.ai-session-primary-action');
        var indicator = row.querySelector('.ai-session-attention-indicator');
        if (needsAttention && primaryAction && !indicator) {
            indicator = document.createElement('span');
            indicator.className = 'ai-session-attention-indicator';
            indicator.title = 'AI session needs attention';
            indicator.setAttribute('aria-label', 'AI session needs attention');
            primaryAction.insertBefore(indicator, primaryAction.firstChild);
        } else if (!needsAttention && indicator) {
            indicator.remove();
        }
    }
    function setAiSessionExecutionDom(row, presentation, iconAnimation) {
        row.setAttribute('data-execution-state', presentation.executionState);
        if (presentation.executionState === 'running' && iconAnimation !== 'none') {
            row.setAttribute('data-session-icon-fx', iconAnimation);
        } else {
            row.removeAttribute('data-session-icon-fx');
        }
        row.toggleAttribute('data-session-conflict', presentation.conflict);
        var status = row.querySelector('.ai-session-execution-status');
        if (status) {
            var running = presentation.executionState === 'running';
            status.setAttribute(
                'aria-label',
                running ? 'AI is currently executing' : 'AI is not currently executing'
            );
            var label = status.lastChild;
            if (label && label.nodeType === Node.TEXT_NODE) {
                label.nodeValue = running ? 'Running' : 'Stopped';
            }
        }
    }
    function setActiveSessionTabAttentionDom(projectDiv, attentionCount) {
        var tab = projectDiv.querySelector('[data-ai-session-tab="active"]');
        if (!tab) return;
        var dot = tab.querySelector('.ai-session-tab-attention');
        if (attentionCount > 0 && !dot) {
            dot = document.createElement('span');
            dot.className = 'ai-session-tab-attention';
            tab.appendChild(dot);
        } else if (attentionCount === 0 && dot) {
            dot.remove();
            return;
        }
        if (dot) {
            dot.setAttribute(
                'aria-label',
                attentionCount + ' active AI session'
                    + (attentionCount === 1 ? ' needs' : 's need') + ' attention'
            );
        }
    }
    function setCurrentWorkspaceSummaryAttentionDom(projectDiv, attentionCount) {
        var summary = projectDiv.querySelector('.project-codex-badge');
        if (!summary && attentionCount > 0) {
            summary = document.createElement('span');
            summary.className = 'project-codex-badge';
            summary.setAttribute('data-ai-session-total-count', '0');
            summary.setAttribute('data-ai-session-active-count', '0');
            projectDiv.appendChild(summary);
        }
        if (!summary) return;
        summary.setAttribute('data-ai-session-attention-count', String(attentionCount));
        var count = summary.querySelector('.ai-session-attention-count');
        if (attentionCount > 0 && !count) {
            count = document.createElement('b');
            count.className = 'ai-session-attention-count';
            summary.appendChild(count);
        } else if (attentionCount === 0 && count) {
            count.remove();
            count = null;
        }
        if (count) {
            count.textContent = String(attentionCount);
            count.setAttribute(
                'aria-label',
                attentionCount + ' AI session'
                    + (attentionCount === 1 ? ' needs' : 's need') + ' attention'
            );
        }
        var total = Number(summary.getAttribute('data-ai-session-total-count')) || 0;
        var active = Number(summary.getAttribute('data-ai-session-active-count')) || 0;
        var parts = [];
        if (total) parts.push(total + ' AI session' + (total === 1 ? '' : 's'));
        if (active) parts.push(active + ' active AI session' + (active === 1 ? '' : 's'));
        if (attentionCount) parts.push(attentionCount + ' AI session'
            + (attentionCount === 1 ? ' needs' : 's need') + ' attention');
        if (!parts.length) {
            summary.remove();
            projectDiv.removeAttribute('data-has-ai-session-badge');
            return;
        }
        projectDiv.setAttribute('data-has-ai-session-badge', '');
        summary.title = parts.join(', ');
        summary.setAttribute('aria-label', parts.join(', '));
    }
    function setCurrentWorkspaceRunningDom(projectDiv, message) {
        var running = message.runningSessionCount > 0;
        projectDiv.classList.toggle('session-running', running);
        if (running) {
            projectDiv.setAttribute('data-session-fx', message.runningCardAnimation);
            projectDiv.title = 'Workspace — ' + message.runningSessionCount + ' active session'
                + (message.runningSessionCount === 1 ? '' : 's') + ' running';
        } else {
            projectDiv.removeAttribute('data-session-fx');
            projectDiv.removeAttribute('title');
        }
        var effect = projectDiv.querySelector('.project-session-fx');
        var showEffect = running && message.runningCardAnimation !== 'none';
        if (showEffect && !effect) {
            effect = document.createElement('div');
            effect.className = 'project-session-fx';
            projectDiv.appendChild(effect);
        } else if (!showEffect && effect) {
            effect.remove();
        }
    }
    function setCurrentOpenWorkspaceSummaryDom(projectDiv, message) {
        var runningBadge = projectDiv.querySelector('.project-codex-badge');
        if (message.runningSessionCount > 0 && !runningBadge) {
            runningBadge = document.createElement('span');
            runningBadge.className = 'project-codex-badge';
            var runningCount = document.createElement('span');
            runningCount.className = 'ai-session-active-count';
            runningBadge.appendChild(runningCount);
            projectDiv.appendChild(runningBadge);
        } else if (message.runningSessionCount === 0 && runningBadge) {
            runningBadge.remove();
            runningBadge = null;
        }
        if (runningBadge) {
            var runningLabel = message.runningSessionCount + ' active AI session'
                + (message.runningSessionCount === 1 ? '' : 's');
            runningBadge.setAttribute(
                'data-ai-session-active-count', String(message.runningSessionCount)
            );
            runningBadge.title = runningLabel;
            runningBadge.setAttribute('aria-label', runningLabel);
            var runningCount = runningBadge.querySelector('.ai-session-active-count');
            runningCount.textContent = '●' + message.runningSessionCount;
            runningCount.setAttribute('aria-label', runningLabel);
        }
        var attentionBadge = projectDiv.querySelector('.project-ai-attention-badge');
        if (message.attentionCount > 0 && !attentionBadge) {
            attentionBadge = document.createElement('span');
            attentionBadge.className = 'project-ai-attention-badge';
            projectDiv.appendChild(attentionBadge);
        } else if (message.attentionCount === 0 && attentionBadge) {
            attentionBadge.remove();
            attentionBadge = null;
        }
        if (attentionBadge) {
            var attentionLabel = message.attentionCount + ' item'
                + (message.attentionCount === 1 ? '' : 's') + ' need'
                + (message.attentionCount === 1 ? 's' : '') + ' attention';
            attentionBadge.textContent = String(message.attentionCount);
            attentionBadge.title = attentionLabel;
            attentionBadge.setAttribute('aria-label', attentionLabel);
        }
        projectDiv.toggleAttribute(
            'data-has-ai-session-badge',
            message.runningSessionCount > 0 || message.attentionCount > 0
        );
        setCurrentWorkspaceRunningDom(projectDiv, message);
    }
    function applyAiSessionPresentationDom(message) {
        var currentCards = Array.from(document.querySelectorAll(
            '.workspace-card[data-workspace-navigation-identity="'
                + CSS.escape(message.workspaceNavigationIdentity || '') + '"]'
                + '[data-current-workspace],'
                + '.workspace-card[data-workspace-navigation-identity="'
                + CSS.escape(message.workspaceNavigationIdentity || '') + '"]'
                + '[data-open-workspace-current]'
        ));
        if (!currentCards.length) return;
        var projectDiv = currentCards.find(card => card.hasAttribute('data-current-workspace'));
        var presentations = {};
        message.sessions.forEach(presentation => {
            presentations[presentation.provider + ':' + presentation.sessionId] = presentation;
        });
        var attentionEvents = {};
        message.attentionSessions.forEach(session => {
            attentionEvents[session.sessionKey] = session.eventIds.slice();
        });
        window.__agentPivotAttentionSessionEvents = attentionEvents;
        var focused = message.focusedTarget;
        aiSessionControls.activeAiSessionTerminalState.provider = focused ? focused.provider : null;
        aiSessionControls.activeAiSessionTerminalState.sessionId = focused?.sessionId || null;
        aiSessionControls.activeAiSessionTerminalState.pendingId = focused?.pendingId || null;
        syncActiveAiSessionProjectionDom(false, message.revealFocused);
        projectDiv?.querySelectorAll(
            '.codex-session-row[data-session-provider][data-session-id]'
        ).forEach(row => {
            var sessionKey = row.getAttribute('data-session-provider')
                + ':' + row.getAttribute('data-session-id');
            var presentation = presentations[sessionKey];
            var eventIds = attentionEvents[sessionKey] || [];
            if (presentation) {
                setAiSessionExecutionDom(row, presentation, message.runningIconAnimation);
                setAiSessionAttentionDom(
                    row,
                    presentation.eventIds,
                    presentation.needsAttention
                );
            } else if (row.classList.contains('active-ai-session-row')) {
                setAiSessionAttentionDom(row, [], false);
            } else {
                setAiSessionAttentionDom(row, eventIds, eventIds.length > 0);
            }
        });
        if (projectDiv) {
            setActiveSessionTabAttentionDom(projectDiv, message.activeAttentionCount);
            setCurrentWorkspaceSummaryAttentionDom(projectDiv, message.attentionCount);
            setCurrentWorkspaceRunningDom(projectDiv, message);
        }
        currentCards.filter(card => card.hasAttribute('data-open-workspace-current'))
            .forEach(card => setCurrentOpenWorkspaceSummaryDom(card, message));
    }
    var presentationTransactions = initAiSessionPresentationTransactions({
        isValidAiSessionPresentationState: isValidAiSessionPresentationState,
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

    function isValidAiSessionPresentationState(message) {
        return message && message.type === 'ai-session-presentation-state'
            && message.version === 1
            && Number.isSafeInteger(message.projectionRevision)
            && message.projectionRevision > 0
            && (typeof message.workspaceScopeIdentity === 'string'
                || message.workspaceScopeIdentity === null)
            && (typeof message.workspaceNavigationIdentity === 'string'
                || message.workspaceNavigationIdentity === null)
            && Number.isSafeInteger(message.attentionCount) && message.attentionCount >= 0
            && Number.isSafeInteger(message.activeAttentionCount)
            && message.activeAttentionCount >= 0
            && Number.isSafeInteger(message.runningSessionCount)
            && message.runningSessionCount >= 0
            && ['current', 'sweep', 'orbit', 'halo', 'ripple', 'breath', 'custom', 'none']
                .includes(message.runningCardAnimation)
            && ['current', 'halo', 'custom', 'none'].includes(message.runningIconAnimation)
            && typeof message.revealFocused === 'boolean'
            && (message.focusedTarget === null
                || (message.focusedTarget
                    && aiSessionControls.isAiSessionProvider(
                        message.focusedTarget.provider
                    )
                    && ((typeof message.focusedTarget.sessionId === 'string'
                        && !!message.focusedTarget.sessionId
                        && typeof message.focusedTarget.pendingId === 'undefined')
                        || (typeof message.focusedTarget.pendingId === 'string'
                            && !!message.focusedTarget.pendingId
                            && typeof message.focusedTarget.sessionId === 'undefined'))))
            && Array.isArray(message.sessions) && message.sessions.length <= 1000
            && message.sessions.every(session => session
                && aiSessionControls.isAiSessionProvider(session.provider)
                && typeof session.sessionId === 'string' && !!session.sessionId
                && (session.executionState === 'running'
                    || session.executionState === 'stopped')
                && typeof session.focused === 'boolean'
                && typeof session.needsAttention === 'boolean'
                && typeof session.conflict === 'boolean'
                && Array.isArray(session.eventIds)
                && session.eventIds.length <= 1000
                && session.eventIds.every(eventId => typeof eventId === 'string' && !!eventId))
            && Array.isArray(message.attentionSessions)
            && message.attentionSessions.length <= 1000
            && message.attentionSessions.every(session => session
                && typeof session.sessionKey === 'string' && !!session.sessionKey
                && Array.isArray(session.eventIds)
                && session.eventIds.length <= 1000
                && session.eventIds.every(eventId => typeof eventId === 'string' && !!eventId));
    }

    function applyValidatedAiSessionPresentationState(message) {
        window.__agentPivotAiSessionPresentationState = message;
        applyAiSessionPresentationDom(message);
        aiSessionControls.reconcileAiSessionAttentionAcknowledgements(message);
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

        contextMenuElement = e.target.closest("#groupContextMenu [data-action]");
        if (contextMenuElement) {
            contextMenus.onGroupContextMenuActionClicked(contextMenuElement);
            return;
        }

        contextMenus.closeContextMenus();
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
                replaceContent: () => applyOpenWorkspacesUpdate(message),
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
