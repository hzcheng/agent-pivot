function initProjectContextMenus(options) {
    'use strict';

    options = options || {};
    var openProject = options.openProject;
    var ProjectOpenType = options.ProjectOpenType;
    var getResumeAiSessionMessageType = options.getResumeAiSessionMessageType;
    var getArchiveAiSessionMessageType = options.getArchiveAiSessionMessageType;
    var isAiSessionProvider = options.isAiSessionProvider;

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
    var contextMenuAiSessionAttached = false;
    var contextMenuAiSessionConflict = false;
    var contextMenuAiSessionOrigin = null;

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
            contextMenuAiSessionOrigin = e.target.closest('[data-action="open-ai-session-context-menu"]')
                || sessionRow.querySelector('.ai-session-primary-action')
                || sessionRow;
            contextMenuAiSessionId = sessionRow.getAttribute("data-session-id");
            contextMenuAiSessionProvider = sessionRow.getAttribute("data-session-provider");
            var sessionProjectDiv = sessionRow.closest('.project[data-id]')
                || sessionRow.closest('[data-open-session-surface][data-id]');
            contextMenuAiSessionProjectId = sessionProjectDiv ? sessionProjectDiv.getAttribute("data-id") : null;
            contextMenuAiSessionActive = sessionRow.hasAttribute('data-session-active');
            contextMenuAiSessionBackend = sessionRow.getAttribute('data-session-backend') || 'vscode';
            contextMenuAiSessionAttached = sessionRow.getAttribute('data-session-attached') === 'true';
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
                        || (contextMenuAiSessionBackend === 'tmux' && !contextMenuAiSessionAttached)
                );
            }
            var stopMenuItem = sessionContextMenuElement.querySelector('[data-action="stop-session"]');
            if (stopMenuItem) {
                stopMenuItem.toggleAttribute(
                    'hidden', contextMenuAiSessionBackend !== 'tmux' || contextMenuAiSessionConflict
                );
                stopMenuItem.classList.toggle(
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

        var projectDiv = e.target.closest('.project[data-id]')
            || e.target.closest('[data-open-session-surface][data-id]');
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

    function openAiSessionContextMenu(trigger) {
        var row = trigger.closest('.codex-session-row[data-session-id][data-session-provider]');
        if (!row)
            return;
        var rowRect = row.getBoundingClientRect();
        var event = {
            target: trigger,
            preventDefault: () => {},
            clientX: rowRect.right - 8,
            clientY: rowRect.top + Math.min(rowRect.height, 24),
            keyboardTrigger: true,
        };
        onContextMenu(event);
        trigger.setAttribute('aria-expanded', 'true');
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
            case 'handoff': {
                // The preset dropdown lives in the AI session controls
                // script; reuse the row's handoff trigger so the menu opens
                // with the same anchoring and context.
                var handoffRow = origin && typeof origin.closest === 'function'
                    ? origin.closest('.codex-session-row[data-session-id]')
                    : null;
                var handoffTrigger = handoffRow
                    && handoffRow.querySelector('[data-action="handoff-ai-session"]');
                closeContextMenus();
                if (handoffTrigger) {
                    handoffTrigger.click();
                    return;
                }
                break;
            }
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
                if (!contextMenuAiSessionActive || contextMenuAiSessionConflict
                    || (contextMenuAiSessionBackend === 'tmux' && !contextMenuAiSessionAttached)) break;
                window.vscode.postMessage({
                    type: contextMenuAiSessionBackend === 'tmux'
                        ? 'detach-ai-session-terminal' : 'close-ai-session-terminal',
                    projectId: contextMenuAiSessionProjectId,
                    provider: contextMenuAiSessionProvider,
                    sessionId: contextMenuAiSessionId,
                });
                break;
            case 'stop-session':
                if (!contextMenuAiSessionActive || contextMenuAiSessionConflict) break;
                window.vscode.postMessage({
                    type: 'stop-ai-session-runtime',
                    projectId: contextMenuAiSessionProjectId,
                    provider: contextMenuAiSessionProvider,
                    sessionId: contextMenuAiSessionId,
                    backend: contextMenuAiSessionBackend,
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
        contextMenuAiSessionAttached = false;
        contextMenuAiSessionConflict = false;
        contextMenuAiSessionOrigin = null;
        // Only close menus this script owns; the dashboard script owns the
        // skill folder menu and keeps it open across per-agent toggles.
        document.querySelectorAll(".custom-context-menu:not(.skill-folder-menu)").forEach(element =>
            element.classList.remove("visible")
        );
        // The create-dropdown arrows mirror the shared menu's visibility.
        document.querySelectorAll('[data-action="open-ai-session-preset-menu"][aria-expanded="true"]')
            .forEach(button => button.setAttribute("aria-expanded", "false"));
        document.querySelectorAll('[data-action="ai-session-worktree-menu"][aria-expanded="true"]')
            .forEach(button => button.setAttribute("aria-expanded", "false"));
        document.querySelectorAll('[data-action="open-ai-session-context-menu"][aria-expanded="true"]')
            .forEach(button => button.setAttribute("aria-expanded", "false"));
    }

    function getAiSessionContextMenuOrigin() {
        return contextMenuAiSessionOrigin;
    }

    return {
        closeContextMenus: closeContextMenus,
        getAiSessionContextMenuOrigin: getAiSessionContextMenuOrigin,
        onAiSessionContextMenuActionClicked: onAiSessionContextMenuActionClicked,
        onContextMenu: onContextMenu,
        onGroupContextMenuActionClicked: onGroupContextMenuActionClicked,
        onProjectContextMenuActionClicked: onProjectContextMenuActionClicked,
        onTriggerProjectAction: onTriggerProjectAction,
        openAiSessionContextMenu: openAiSessionContextMenu,
        showContextMenu: showContextMenu,
    };
}
