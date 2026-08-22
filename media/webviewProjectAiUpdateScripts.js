function initAiSessionPresentationStateStore(options) {
    'use strict';

    options = options || {};
    var isAiSessionProvider = options.isAiSessionProvider;
    var currentPresentation = null;

    function isValid(message) {
        return message && message.type === 'ai-session-presentation-state'
            && message.version === 1
            && Number.isSafeInteger(message.projectionRevision)
            && message.projectionRevision > 0
            && (typeof message.workspaceScopeIdentity === 'string'
                || message.workspaceScopeIdentity === null)
            && (typeof message.workspaceNavigationIdentity === 'string'
                || message.workspaceNavigationIdentity === null)
            && (typeof message.worktreeGroupsAggregateRevision === 'undefined'
                || message.worktreeGroupsAggregateRevision === null
                || (Number.isSafeInteger(message.worktreeGroupsAggregateRevision)
                    && message.worktreeGroupsAggregateRevision >= 0))
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
                    && isAiSessionProvider(message.focusedTarget.provider)
                    && ((typeof message.focusedTarget.sessionId === 'string'
                        && !!message.focusedTarget.sessionId
                        && typeof message.focusedTarget.pendingId === 'undefined')
                        || (typeof message.focusedTarget.pendingId === 'string'
                            && !!message.focusedTarget.pendingId
                            && typeof message.focusedTarget.sessionId === 'undefined'))))
            && Array.isArray(message.sessions) && message.sessions.length <= 1000
            && message.sessions.every(session => session
                && isAiSessionProvider(session.provider)
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

    function adopt(message) {
        if (!isValid(message)) return false;
        currentPresentation = message;
        return true;
    }

    function getCurrent() {
        return currentPresentation;
    }

    function getFocusedTarget() {
        return currentPresentation ? currentPresentation.focusedTarget : null;
    }

    function getAttentionEventIds(provider, sessionId) {
        if (!currentPresentation) return [];
        var sessionKey = provider + ':' + sessionId;
        var owner = currentPresentation.attentionSessions.find(session =>
            session && session.sessionKey === sessionKey
        );
        return owner ? owner.eventIds.slice() : [];
    }

    return {
        adopt: adopt,
        getAttentionEventIds: getAttentionEventIds,
        getCurrent: getCurrent,
        getFocusedTarget: getFocusedTarget,
        isValid: isValid,
    };
}

function initAiSessionPresentationTransactions(options) {
    'use strict';

    options = options || {};
    var isValidAiSessionPresentationState = options.isValidAiSessionPresentationState;
    var canApplyAiSessionPresentationState = options.canApplyAiSessionPresentationState;
    var applyValidatedAiSessionPresentationState = options.applyValidatedAiSessionPresentationState;
    var latestAiSessionProjectionRevision = 0;
    var latestAiSessionPresentationProjectionRevision = 0;
    var latestAiSessionClosedPresentationRevision = 0;

    function requestFullRefresh(reason) {
        window.vscode.postMessage({
            type: 'request-full-refresh',
            reason,
        });
    }

    function hasMatchingPresentationWorkspace(message) {
        if (canApplyAiSessionPresentationState(message)) return true;
        requestFullRefresh('mismatched-ai-session-presentation-workspace');
        return false;
    }

    function canApplyRevision(revision, latestRevision) {
        if (typeof revision === 'undefined') {
            return latestRevision === 0;
        }
        return Number.isSafeInteger(revision)
            && revision > 0
            && revision > latestRevision;
    }

    function canApplyProjectionRevision(revision) {
        return canApplyRevision(revision, latestAiSessionProjectionRevision);
    }

    function canApplyAtomicPresentationProjectionRevision(revision) {
        return Number.isSafeInteger(revision)
            && revision > 0
            && revision >= latestAiSessionPresentationProjectionRevision
            && revision > latestAiSessionClosedPresentationRevision;
    }

    function commitAtomicProjectionRevision(revision) {
        latestAiSessionProjectionRevision = revision;
        latestAiSessionPresentationProjectionRevision = Math.max(
            latestAiSessionPresentationProjectionRevision,
            revision
        );
        latestAiSessionClosedPresentationRevision = Math.max(
            latestAiSessionClosedPresentationRevision,
            revision
        );
    }

    function acceptPresentationProjectionRevision(revision) {
        if (!Number.isSafeInteger(revision)
            || revision <= 0
            || revision < latestAiSessionProjectionRevision
            || revision <= latestAiSessionPresentationProjectionRevision
            || revision <= latestAiSessionClosedPresentationRevision) {
            return false;
        }
        latestAiSessionPresentationProjectionRevision = revision;
        return true;
    }

    function acceptInitialPresentationProjectionRevision(revision) {
        if (!Number.isSafeInteger(revision)
            || revision <= 0
            || latestAiSessionProjectionRevision !== 0
            || latestAiSessionPresentationProjectionRevision !== 0
            || latestAiSessionClosedPresentationRevision !== 0) {
            return false;
        }
        latestAiSessionProjectionRevision = revision;
        latestAiSessionPresentationProjectionRevision = revision;
        latestAiSessionClosedPresentationRevision = revision;
        return true;
    }

    function applyInitialPresentation(message) {
        if (!isValidAiSessionPresentationState(message)) {
            requestFullRefresh('invalid-initial-ai-session-presentation-state');
            return false;
        }
        if (!hasMatchingPresentationWorkspace(message)) return false;
        if (!acceptInitialPresentationProjectionRevision(message.projectionRevision)) {
            return false;
        }
        applyValidatedAiSessionPresentationState(message);
        return true;
    }

    function applyDirectPresentation(message) {
        if (!isValidAiSessionPresentationState(message)
            || message.revealFocused !== true) {
            requestFullRefresh('invalid-direct-ai-session-presentation-state');
            return false;
        }
        if (!hasMatchingPresentationWorkspace(message)) return false;
        if (!acceptPresentationProjectionRevision(message.projectionRevision)) {
            return false;
        }
        applyValidatedAiSessionPresentationState(message);
        return true;
    }

    function applyAtomicEnvelope(input) {
        var message = input.message;
        if (!Number.isSafeInteger(message.projectionRevision)
            || message.projectionRevision <= 0
            || !isValidAiSessionPresentationState(message.presentation)
            || message.presentation.projectionRevision !== message.projectionRevision
            || message.presentation.revealFocused !== false) {
            requestFullRefresh(input.invalidPresentationReason);
            return false;
        }
        if (!canApplyProjectionRevision(message.projectionRevision)
            || !canApplyAtomicPresentationProjectionRevision(message.projectionRevision)) {
            return false;
        }
        var replacementWorkspaceMatches = null;
        if (!input.replaceContent(replacementRoot => {
            replacementWorkspaceMatches = canApplyAiSessionPresentationState(
                message.presentation,
                replacementRoot
            );
            return replacementWorkspaceMatches;
        })) {
            requestFullRefresh(replacementWorkspaceMatches === false
                ? 'mismatched-ai-session-presentation-workspace'
                : input.invalidReplacementReason);
            return false;
        }
        if (!hasMatchingPresentationWorkspace(message.presentation)) return false;
        commitAtomicProjectionRevision(message.projectionRevision);
        if (typeof input.afterReplacement === 'function') {
            input.afterReplacement();
        }
        applyValidatedAiSessionPresentationState(message.presentation);
        return true;
    }

    return {
        applyAtomicEnvelope: applyAtomicEnvelope,
        applyDirectPresentation: applyDirectPresentation,
        applyInitialPresentation: applyInitialPresentation,
        requestFullRefresh: requestFullRefresh,
    };
}

function initAiSessionPresentationDom(options) {
    'use strict';

    options = options || {};
    var presentationStateStore = options.presentationStateStore;

    function syncActiveAiSessionProjectionDom(revealFocused) {
        var focusedTarget = presentationStateStore.getFocusedTarget();
        var projectedFocusedRow = null;
        document.querySelectorAll(
            '.codex-session-row[data-session-provider][data-session-id],'
                + '.codex-session-row[data-session-provider][data-pending-id]'
        ).forEach(row => {
            var providerMatches = focusedTarget
                && row.getAttribute('data-session-provider') === focusedTarget.provider;
            var focused = providerMatches && (
                (typeof focusedTarget.sessionId === 'string'
                    && row.getAttribute('data-session-id') === focusedTarget.sessionId)
                || (typeof focusedTarget.pendingId === 'string'
                    && row.getAttribute('data-pending-id') === focusedTarget.pendingId)
            );
            if (focused) projectedFocusedRow = row;
            row.toggleAttribute('data-session-focused', focused);
            var focusedConversation = focused && row.hasAttribute('data-session-id');
            row.toggleAttribute('data-ai-session-active-terminal', focusedConversation);
            var primaryAction = row.querySelector('.ai-session-primary-action');
            if (primaryAction) {
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
            if (focusedConversation && primaryAction && !conversationHint) {
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
        var tab = projectDiv.querySelector('[data-ai-session-tab="chats"]');
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
    function getAiSessionPresentationCurrentCards(message, root) {
        if (typeof message.workspaceNavigationIdentity !== 'string'
            || !message.workspaceNavigationIdentity) return [];
        var selector = '[data-open-session-surface][data-workspace-navigation-identity="'
            + CSS.escape(message.workspaceNavigationIdentity || '') + '"]'
            + '[data-current-workspace]';
        var projectionRoot = root || document;
        // Incremental AI updates replace the surface itself. Element
        // querySelectorAll() excludes that root node, so include it before
        // scanning descendants or every valid replacement is rejected as a
        // cross-workspace presentation.
        var currentCards = projectionRoot !== document
            && typeof projectionRoot.matches === 'function'
            && projectionRoot.matches(selector)
            ? [projectionRoot]
            : [];
        return currentCards.concat(Array.from(projectionRoot.querySelectorAll(selector)));
    }
    function canApplyAiSessionPresentationDom(message, root) {
        var projectionRoot = root || document;
        if (message.workspaceNavigationIdentity === null) {
            var currentSelector = '[data-open-session-surface][data-current-workspace]';
            return !(projectionRoot !== document
                && typeof projectionRoot.matches === 'function'
                && projectionRoot.matches(currentSelector))
                && !projectionRoot.querySelector(currentSelector);
        }
        return getAiSessionPresentationCurrentCards(message, projectionRoot).length > 0;
    }
    function applyAiSessionPresentationDom(message) {
        var currentCards = getAiSessionPresentationCurrentCards(message);
        syncActiveAiSessionProjectionDom(message.revealFocused);
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

    return {
        apply: applyAiSessionPresentationDom,
        canApply: canApplyAiSessionPresentationDom,
    };
}

function initProjectAiSessionsUpdate(options) {
    'use strict';

    options = options || {};
    var batchAiSessionState = options.batchAiSessionState;
    var batchAiSessionManager = options.batchAiSessionManager;
    var getPendingAiSessionProviderSelectionProjectId = options.getPendingAiSessionProviderSelectionProjectId;
    var getSelectedAiSessionProviders = options.getSelectedAiSessionProviders;
    var syncAiSessionBatchManagementDom = options.syncAiSessionBatchManagementDom;
    var reconcilePendingAiSessionProviderSelectionDom = options.reconcilePendingAiSessionProviderSelectionDom;
    var reconcileWorktreeGroupFormDom = options.reconcileWorktreeGroupFormDom;
    var submitAiSessionProviderSelection = options.submitAiSessionProviderSelection;
    var toggleCodexSessions = options.toggleCodexSessions;
    var exitAiSessionBatchManagement = options.exitAiSessionBatchManagement;
    var isAiSessionProvider = options.isAiSessionProvider;
    var updateStickyGroupHeaderOffset = options.updateStickyGroupHeaderOffset;
    var presentationTransactions = options.presentationTransactions;

    var pendingWorkspaceSessionReveal = null;

    function applyAiSessionsUpdate(message) {
        if (message.version !== 3
            || typeof message.sequence !== 'number'
            || (message.currentWorkspaceCount !== 0 && message.currentWorkspaceCount !== 1)
            || typeof message.html !== 'string'
            || typeof normalizeDashboardSearchCatalog !== 'function'
            || normalizeDashboardSearchCatalog(message.searchCatalog) !== message.searchCatalog
            || message.searchCatalog.version !== 3) {
            presentationTransactions.requestFullRefresh('unsupported-ai-session-message');
            return;
        }

        if (!Number.isSafeInteger(message.projectionRevision)
                || message.projectionRevision <= 0
                || message.sequence !== message.projectionRevision
                || typeof message.generatedAt !== 'string'
                || !message.generatedAt) {
            presentationTransactions.requestFullRefresh(
                'invalid-ai-session-presentation-envelope'
            );
            return;
        }

        if (!presentationTransactions.applyAtomicEnvelope({
            message: message,
            invalidPresentationReason: 'invalid-ai-session-presentation-envelope',
            invalidReplacementReason: 'invalid-ai-session-workspace-update',
            replaceContent: validateReplacement => applyWorkspaceUpdate({
                type: 'workspace-updated',
                version: 2,
                currentWorkspaceCount: message.currentWorkspaceCount,
                html: message.html,
            }, {
                canRestoreAiSessionProviderMenu: () =>
                    !getPendingAiSessionProviderSelectionProjectId()
                    && !batchAiSessionState.pending,
                validateReplacement: validateReplacement,
            }),
            afterReplacement: () => {
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
                if (reconcileWorktreeGroupFormDom) {
                    reconcileWorktreeGroupFormDom();
                }
            },
        })) {
            return;
        }
        updateStickyGroupHeaderOffset();
        if (window.__agentPivotDashboard) {
            window.__agentPivotDashboard.replaceSearchCatalog(message.searchCatalog);
        }
    }

    function findCurrentWorkspaceDiv(projectId) {
        if (!projectId) {
            return null;
        }

        var projects = document.querySelectorAll(
            '[data-open-session-surface][data-current-workspace][data-id]'
        );
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
        var sessionSurfaces = document.querySelectorAll(
            '[data-open-session-surface][data-workspace-navigation-identity]'
        );
        for (var workspaceDiv of sessionSurfaces) {
            if (workspaceDiv.getAttribute('data-workspace-navigation-identity') === navigationIdentity) {
                return workspaceDiv;
            }
        }

        var windowRows = document.querySelectorAll(
            '[data-open-window-row][data-workspace-navigation-identity]'
        );
        for (var windowRow of windowRows) {
            if (windowRow.getAttribute('data-workspace-navigation-identity') === navigationIdentity) {
                return windowRow;
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
        selectAiSessionTabDom(workspaceDiv, 'all');
        writeAiSessionTabState(window.vscode, workspaceId, 'all');
        postSelectedAiSessionViewTab(workspaceId, 'all');
        // ALL ⊇ CHATS：同一 active session 在两个面板各有一行；查询必须限定在
        // 已选的 ALL 面板，否则会命中隐藏 CHATS 面板里的同名行并静默聚焦失败。
        var sessionRow = Array.from(workspaceDiv.querySelectorAll(
            '[data-ai-session-panel="all"] .codex-session-row[data-session-id][data-session-provider]'
        ))
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

    function revealWorkspaceWorktree(navigationIdentity, repositoryKey, canonicalWorktreePath) {
        if (!repositoryKey || !canonicalWorktreePath) {
            return false;
        }
        var workspaceDiv = findWorkspaceDiv(navigationIdentity);
        if (!workspaceDiv) {
            return false;
        }
        var workspaceId = workspaceDiv.getAttribute('data-id');
        selectAiSessionTabDom(workspaceDiv, 'chats');
        writeAiSessionTabState(window.vscode, workspaceId, 'chats');
        postSelectedAiSessionViewTab(workspaceId, 'chats');
        var group = Array.from(workspaceDiv.querySelectorAll(
            '.ai-session-worktree-group[data-worktree-repository-key][data-worktree-path]'
        )).find(candidate =>
            candidate.getAttribute('data-worktree-repository-key') === repositoryKey
            && candidate.getAttribute('data-worktree-path') === canonicalWorktreePath
        );
        if (!group) {
            focusSearchRevealTarget(workspaceDiv);
            return false;
        }
        var header = group.querySelector('.ai-session-worktree-header');
        setAiSessionWorktreeGroupExpanded(workspaceDiv, group, true);
        writeAiSessionWorktreeCollapseState(window.vscode, workspaceDiv);
        focusSearchRevealTarget(header || group);
        return true;
    }

    window.__agentPivotRevealWorkspaceSession = revealWorkspaceSession;
    window.__agentPivotRevealWorkspaceWorktree = revealWorkspaceWorktree;
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

    return {
        applyAiSessionsUpdate: applyAiSessionsUpdate,
        findCurrentWorkspaceDiv: findCurrentWorkspaceDiv,
        findWorkspaceDiv: findWorkspaceDiv,
        focusSearchRevealTarget: focusSearchRevealTarget,
        requestFullRefresh: presentationTransactions.requestFullRefresh,
    };
}
