import * as vscode from 'vscode';
import * as path from 'path';
import { randomBytes } from 'crypto';

import {
    Project,
    Group,
    getRemoteType,
    ProjectRemoteType,
    StewardInfos,
    sanitizeProjectName,
    WorkspaceCardViewModel,
} from '../models';
import {
    FAVORITES_GROUP_ID,
    FITTY_OPTIONS,
    INBUILT_COLOR_DEFAULTS,
    OPEN_CURRENT_WORKSPACE_GROUP_ID,
} from '../constants';
import { getFavoriteProjectsInOrder } from '../projects/favoriteProjectOrder';
import {
    buildWorkspaceDashboardSearchCatalog,
    serializeDashboardSearchCatalog,
} from './dashboardViewModel';
import { escapeAttribute } from '../webviewHtmlEscape';
import {
    getAiSessionContextMenu,
    getAiSessionCreateDropdown,
    getAiSessionWorktreeMenu,
    getAiSessionsDiv,
    getWorkspaceAiSessionSurface,
    normalizeRunningCardAnimation,
} from './webviewAiSessionContent';
import {
    getEffectiveRunningCardAnimation,
    getEffectiveRunningIconAnimation,
    readRunningAnimationImages,
    RunningAnimationImages,
} from './runningAnimationImages';
import * as Icons from '../webviewIcons';
import type { OpenWorkspaceBridgeStatus } from '../openWorkspaces/bridgeClient';
import type { AiSessionPresentationStateMessage } from '../aiSessions/types';
import { removeWorkspaceWindowDecorations } from '../workspaces/contextResolver';
import { buildOpenWindowRowViewModels } from '../openWorkspaces/windowRowViewModel';
import { getOpenWindowMenu, getOpenWindowSwitcherGroupContent } from './webviewWindowSwitcherContent';

const FAVORITES_GROUP_NAME = 'FAVORITES';
const DEFAULT_MAX_VISIBLE_PROJECTS_PER_GROUP = 5;

interface GroupSectionOptions {
    virtual: boolean;
    readOnlyProjects: boolean;
    draggableVirtualProjects: boolean;
    collapsible: boolean;
    className: string;
    systemBadge: string;
}


const WEBVIEW_ASSET_ACTIVATION = randomBytes(8).toString('hex');
let webviewAssetRevision = 0;

export { getAiSessionsDiv };

export function getStewardContent(
    context: vscode.ExtensionContext,
    webview: vscode.Webview,
    groups: Group[],
    infos: StewardInfos,
    isSidebar: boolean = false,
    workspaceCards: WorkspaceCardViewModel[] = [],
    otherWindowsStatus: OpenWorkspaceBridgeStatus = 'ready',
    readyDocumentGeneration: number = 1,
    initialAiSessionPresentation?: AiSessionPresentationStateMessage,
    windowPathSegmentsByCardId?: ReadonlyMap<string, readonly string[]>,
): string {
    var safeReadyDocumentGeneration = Number.isSafeInteger(readyDocumentGeneration)
        && readyDocumentGeneration > 0
        ? readyDocumentGeneration
        : 1;
    var assetRevision = `${WEBVIEW_ASSET_ACTIVATION}-${++webviewAssetRevision}`;
    var contentNonce = randomBytes(16).toString('base64');
    var stylesPath = getMediaResource(context, webview, 'styles.css', assetRevision);
    var dashboardBundlePath = getMediaResource(
        context,
        webview,
        'webviewDashboardBundle.js',
        assetRevision,
    );

    var customCss = infos.config.get('customCss') || '';
    var searchCatalog = serializeDashboardSearchCatalog(
        buildWorkspaceDashboardSearchCatalog(groups, workspaceCards, infos.todoSearchItems || [], infos.skills || [])
    );
    var serializedAiSessionPresentation = initialAiSessionPresentation
        ? JSON.stringify(initialAiSessionPresentation)
            .replace(/</g, '\\u003c')
            .replace(/>/g, '\\u003e')
            .replace(/&/g, '\\u0026')
        : '';
    var runningAnimationImages = readRunningAnimationImages(infos.config);
    var openWorkspacesContent = getOpenWorkspacesGroupContent(
        workspaceCards,
        otherWindowsStatus,
        getEffectiveRunningCardAnimation(infos.config),
        getEffectiveRunningIconAnimation(infos.config),
        windowPathSegmentsByCardId,
    );

    return `
<!DOCTYPE html>
    <html lang="en" class="dashboard-styles-pending">
    <head>
        <meta charset="UTF-8">
        <meta
            http-equiv="Content-Security-Policy"
            content="default-src 'none'; img-src ${webview.cspSource} data: https:; script-src ${webview.cspSource
        } 'nonce-${contentNonce}'; style-src ${webview.cspSource} 'unsafe-inline';"
        />
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>${criticalStartupStyle()}</style>
        <link rel="stylesheet" type="text/css" id="agent-pivot-styles" href="${stylesPath}">
        <style>${colorDefaults()}</style>
        <style>
            /* Custom CSS from configuration */
            ${customCss}
        </style>
        <title>Agent Pivot</title>
        ${getCustomStyle(infos.config, runningAnimationImages)}
    </head>
    <body class="preload ${isSidebar ? 'steward-sidebar' : ''} ${!groups.length ? 'steward-empty' : ''}">
        <main class="dashboard-style-loading" data-dashboard-style-loading aria-busy="true" aria-label="Loading Agent Pivot">
            <div class="dashboard-style-loading-tabs" aria-hidden="true">
                <span class="dashboard-style-loading-tab active"></span>
                <span class="dashboard-style-loading-tab"></span>
                <span class="dashboard-style-loading-tab"></span>
                <span class="dashboard-style-loading-tab"></span>
            </div>
            <div class="dashboard-style-loading-cards" aria-hidden="true">
                <span class="dashboard-style-loading-card"></span>
                <span class="dashboard-style-loading-card"></span>
                <span class="dashboard-style-loading-card"></span>
            </div>
        </main>
        <div data-dashboard-ready-content>
        <div class="steward-sticky-header">
            <div class="filter-wrapper">
                <div class="search-box">
                    <span class="search-icon">${Icons.search}</span>
                    <input type="search" id="filter" aria-label="Filter Projects">
                    <span id="clear" class="clear-search-icon">${Icons.remove}</span>
                </div>
                <button type="button" class="sponsor-button" data-action="sponsor" title="Support Agent Pivot" aria-label="Support Agent Pivot">
                    ${Icons.heart}
                </button>
                <button type="button" class="toggle-all-groups-button" data-action="toggle-all-groups" title="Collapse All Groups" aria-label="Collapse All Groups">
                    <span class="toggle-all-groups-collapse-icon">${Icons.collapseAll}</span>
                    <span class="toggle-all-groups-expand-icon">${Icons.expandAll}</span>
                </button>
                <button type="button" class="settings-button" data-action="open-settings" title="Agent Pivot Settings" aria-label="Agent Pivot Settings">
                    ${Icons.settings}
                </button>
            </div>
            <div class="dashboard-tab-list" role="tablist" aria-label="Agent Pivot views">
                <button type="button" id="dashboard-tab-open-button" class="dashboard-tab-button active" role="tab" aria-selected="true" aria-controls="dashboard-tab-open" tabindex="0" data-dashboard-tab="open" aria-label="Open" title="Open">
                    <span class="dashboard-tab-icon" aria-hidden="true">${Icons.openNewWindow}</span>
                    <span class="dashboard-tab-label">OPEN</span>
                </button>
                <button type="button" id="dashboard-tab-projects-button" class="dashboard-tab-button" role="tab" aria-selected="false" aria-controls="dashboard-tab-projects" tabindex="-1" data-dashboard-tab="projects" aria-label="Projects" title="Projects">
                    <span class="dashboard-tab-icon" aria-hidden="true">${Icons.folder}</span>
                    <span class="dashboard-tab-label">PROJECTS</span>
                </button>
                <button type="button" id="dashboard-tab-todo-button" class="dashboard-tab-button" role="tab" aria-selected="false" aria-controls="dashboard-tab-todo" tabindex="-1" data-dashboard-tab="todo" aria-label="Todo" title="Todo">
                    <span class="dashboard-tab-icon" aria-hidden="true">${Icons.manage}</span>
                    <span class="dashboard-tab-label">TODO</span>
                </button>
                <button type="button" id="dashboard-tab-ai-button" class="dashboard-tab-button" role="tab" aria-selected="false" aria-controls="dashboard-panel-ai" tabindex="-1" data-dashboard-tab="ai" aria-label="AI" title="AI">
                    <span class="dashboard-tab-icon" aria-hidden="true">${Icons.sparkles}</span>
                    <span class="dashboard-tab-label">AI</span>
                </button>
            </div>
        </div>
        <main class="dashboard-content">
            <section id="dashboard-tab-open" class="dashboard-tab-panel" role="tabpanel" aria-labelledby="dashboard-tab-open-button">
                <div class="sticky-groups-wrapper">
                    ${openWorkspacesContent}
                </div>
            </section>
            <section id="dashboard-tab-projects" class="dashboard-tab-panel" role="tabpanel" aria-labelledby="dashboard-tab-projects-button" hidden>
                <div class="dashboard-projects-loading" role="status" hidden>Loading projects…</div>
            </section>
            <section id="dashboard-tab-todo" class="dashboard-tab-panel" role="tabpanel" aria-labelledby="dashboard-tab-todo-button" hidden>
                <div class="dashboard-todo-loading" role="status" hidden>Loading todos…</div>
            </section>
            <section id="dashboard-panel-ai" class="dashboard-tab-panel" role="tabpanel" aria-labelledby="dashboard-tab-ai-button" hidden>
                <div class="dashboard-ai-loading" role="status" hidden>Loading AI configuration…</div>
            </section>
            <section id="dashboard-search-results" class="dashboard-search-results" aria-label="Search results" hidden></section>
        </main>
        <script id="dashboard-search-catalog" type="application/json">${searchCatalog}</script>
        ${serializedAiSessionPresentation
            ? `<script id="dashboard-ai-session-presentation" type="application/json">${serializedAiSessionPresentation}</script>`
            : ''}

        ${getProjectContextMenu()}
        ${getGroupContextMenu()}
        ${getAiSessionContextMenu()}
        ${getAiSessionCreateDropdown()}
        ${getAiSessionWorktreeMenu()}
        ${getOpenWindowMenu()}
        </div>
    </body>

    <script nonce="${contentNonce}">
        window.__agentPivotReadyDocumentGeneration = ${safeReadyDocumentGeneration};
        (function() {
            function revealWhenStylesReady() {
                document.documentElement.classList.remove('dashboard-styles-pending');
            }
            var stylesLink = document.getElementById('agent-pivot-styles');
            if (!stylesLink) {
                revealWhenStylesReady();
                return;
            }
            var stylesReady = false;
            try {
                stylesReady = !!stylesLink.sheet;
            } catch (_error) {
                stylesReady = false;
            }
            if (stylesReady) {
                revealWhenStylesReady();
                return;
            }
            stylesLink.addEventListener('load', revealWhenStylesReady);
            stylesLink.addEventListener('error', revealWhenStylesReady);
        })();
    </script>
    <script src="${dashboardBundlePath}"></script>

    <script nonce="${contentNonce}">
        (function() {
            window.vscode = acquireVsCodeApi();

            function fitProjectHeaders(root) {
                if (!root || document.body.classList.contains('steward-sidebar')) {
                    return;
                }
                Array.from(root.querySelectorAll('.project-header')).forEach(element =>
                    fitty(element, ${JSON.stringify(FITTY_OPTIONS)})
                );
            }

            window.onload = () => {
                initProjects();
                const storedFilter = sessionStorage.getItem('filterValue') || '';
                let filtering;
                const todos = initTodos({
                    postMessage: message => window.vscode.postMessage(message),
                    replaceSearchCatalog: catalog => {
                        if (window.__agentPivotDashboard) {
                            window.__agentPivotDashboard.replaceSearchCatalog(catalog);
                        }
                    },
                    onRendered: panel => {
                        disposeDnD(panel);
                        initDnD(panel);
                    },
                });
                const dashboard = initDashboard({
                    initialSearchQuery: storedFilter,
                    clearSearch: () => filtering && filtering.clear(),
                    postMessage: message => window.vscode.postMessage(message),
                    onProjectsMounted: panel => {
                        fitProjectHeaders(panel);
                        disposeDnD(panel);
                        initDnD(panel);
                        window.__agentPivotSyncCollapseButton();
                    },
                    onTodoMounted: (panel, message) => {
                        todos.mount(panel, message.snapshot);
                        window.__agentPivotSyncCollapseButton();
                    },
                    onTodoRefresh: (_panel, message) => todos.applyRefresh(message.snapshot),
                    onActiveTabChanged: () => window.__agentPivotSyncCollapseButton(),
                });
                window.__agentPivotDashboard = dashboard;
                fitProjectHeaders(document.getElementById('dashboard-tab-open'));
                filtering = initFiltering(${infos.config.searchIsActiveByDefault}, dashboard);
                filtering.apply();
            };
        })();
    </script>


</html>`;
}

export function getCurrentWorkspaceGroupContent(
    card: WorkspaceCardViewModel | null,
    hasOtherWindows: boolean = false,
    runningCardAnimation?: string,
    runningIconAnimation?: string,
): string {
    const currentCard = card && card.kind === 'current' && card.roots.length > 0 ? card : null;
    // The expanded class lets the OPEN tab fit the card to the CURRENT WINDOW
    // pane without :has(), which webviews older than Chrome 105 cannot match;
    // authoritative re-renders replay it from the view model and the webview
    // toggle handler keeps it in sync between replacements.
    const cardExpanded = currentCard?.aiSessions?.expanded === true;
    // PR-B transition: the group shell stays headless (no group header) — the
    // `ai-sessions-updated` channel targets `.open-current-workspace-group` as
    // its replacement unit, and the window switcher above owns the chrome.
    return `
<div class="group steward-section open-current-workspace-group open-current-workspace-group-headless ${currentCard ? '' : 'no-projects'}${cardExpanded ? ' current-card-expanded' : ''}" data-group-id="${OPEN_CURRENT_WORKSPACE_GROUP_ID}" data-virtual-group data-system-group="${OPEN_CURRENT_WORKSPACE_GROUP_ID}">
    <div class="group-list">
        <div class="drop-signal"></div>
        ${currentCard ? getWorkspaceCardDiv(currentCard, runningCardAnimation, runningIconAnimation) : getOpenCurrentWorkspaceEmptyState(hasOtherWindows)}
    </div>
</div>`;
}

export function getOpenWorkspacesGroupContent(
    cards: WorkspaceCardViewModel[],
    otherWindowsStatus: OpenWorkspaceBridgeStatus = 'ready',
    runningCardAnimation?: string,
    runningIconAnimation?: string,
    pathSegmentsByCardId?: ReadonlyMap<string, readonly string[]>,
): string {
    // PR-B: the CURRENT WINDOW / OPEN WINDOWS groups and the split resizer are
    // replaced by the persistent WINDOWS switcher (single-line rows, stable
    // order, zero-displacement switching) plus the transitional headless
    // current-detail card below it. The switcher is not collapsible by design.
    const orderedCards = cards || [];
    const current = orderedCards.find(card => card.kind === 'current') || null;
    const navigationCards = orderedCards.filter(card => card.kind === 'navigation');
    let rows = buildOpenWindowRowViewModels(orderedCards, pathSegmentsByCardId);
    if (otherWindowsStatus !== 'ready') {
        // PRD: bridge 未就绪时当前行固定置顶，就绪后按稳定顺序归位。
        rows = [...rows].sort((left, right) => (left.kind === right.kind)
            ? 0
            : left.kind === 'current' ? -1 : 1);
    }
    // 状态条占固定槽位（24px，见 styles.scss .open-window-switcher-status）：
    // 文案单行省略，title 承载全量。
    const statusContent = otherWindowsStatus === 'update-required'
        ? `<div class="open-other-windows-state" role="status">
            <p title="Update the Agent Pivot UI Bridge extension to restore all open windows.">Update the Agent Pivot UI Bridge extension to restore all open windows.</p>
            <button type="button" class="project-action" data-action="open-bridge-extension">Show UI Bridge Extension</button>
        </div>`
        : otherWindowsStatus === 'unavailable'
            ? `<div class="open-other-windows-state" role="status">
                <p title="Open-window discovery is temporarily unavailable. Agent Pivot will retry automatically.">Open-window discovery is temporarily unavailable. Agent Pivot will retry automatically.</p>
            </div>`
            : otherWindowsStatus === 'connecting'
                ? `<div class="open-other-windows-state" role="status" data-other-windows-connecting>
                    <p title="Looking for your other open windows…">Looking for your other open windows…</p>
                </div>`
                : '';
    const switcherSection = getOpenWindowSwitcherGroupContent(
        rows,
        otherWindowsStatus,
        statusContent,
    );
    const currentSection = getCurrentWorkspaceGroupContent(
        current,
        navigationCards.length > 0,
        runningCardAnimation,
        runningIconAnimation,
    );
    return `${switcherSection}
${currentSection}`;
}

function getWorkspaceCardDiv(
    card: WorkspaceCardViewModel,
    runningCardAnimation?: string,
    runningIconAnimation?: string,
): string {
    const roots = card.roots.slice().sort((left, right) => left.ordinal - right.ordinal);
    const rootCount = roots.length;
    const compactWorkspaceName = removeWorkspaceWindowDecorations(card.name)
        || (rootCount === 1 ? roots[0].name : '');
    const workspaceName = escapeAttribute(sanitizeProjectName(compactWorkspaceName) || 'Workspace');
    const environmentLabel = escapeAttribute(sanitizeProjectName(card.environmentLabel) || 'Local');
    const remoteType = getWorkspaceRemoteType(card.environment);
    const projectIcon = getProjectIcon(remoteType);
    const projectIconTitle = getProjectIconTitle(remoteType);
    const folderLabel = `${rootCount} folder${rootCount === 1 ? '' : 's'}`;
    // PR-B：open-list 投影已随双分组移除，只余 current-detail 形态。
    const showSaveAction = card.showSaveAction;
    const saveBadge = showSaveAction
        ? `<span data-action="save-current-workspace" class="project-save-badge" title="Save Workspace" aria-label="Save Workspace">${Icons.save}</span>`
        : '';
    const aiSessions = card.aiSessions;
    const runningSessionCount = (aiSessions?.activeSessions || []).filter(session => session.executionState === 'running').length;
    const sessionFx = runningSessionCount > 0
        ? normalizeRunningCardAnimation(runningCardAnimation)
        : '';
    const runningTitle = runningSessionCount > 0
        ? `Workspace — ${runningSessionCount} active session${runningSessionCount === 1 ? '' : 's'} running`
        : '';
    const aiSessionCount = aiSessions?.aiSessionCount || 0;
    const activeSessionCount = aiSessions?.activeSessionCount || 0;
    const attentionCount = card.attentionCount || 0;
    const summaryParts = [
        aiSessionCount ? `${aiSessionCount} AI session${aiSessionCount === 1 ? '' : 's'}` : '',
        activeSessionCount ? `${activeSessionCount} active AI session${activeSessionCount === 1 ? '' : 's'}` : '',
        attentionCount ? `${attentionCount} AI session${attentionCount === 1 ? ' needs' : 's need'} attention` : '',
    ].filter(Boolean);
    const summaryLabel = escapeAttribute(summaryParts.join(', '));
    const badge = summaryParts.length
        ? `<span class="project-codex-badge" data-ai-session-total-count="${aiSessionCount}" data-ai-session-active-count="${activeSessionCount}" data-ai-session-attention-count="${attentionCount}" title="${summaryLabel}" aria-label="${summaryLabel}">${
            aiSessionCount ? `<span class="ai-session-total-count">AI ${aiSessionCount}</span>` : ''
        }${activeSessionCount ? `<span class="ai-session-active-count" aria-label="${activeSessionCount} active AI session${activeSessionCount === 1 ? '' : 's'}">●${activeSessionCount}</span>` : ''
        }${attentionCount ? `<b class="ai-session-attention-count" aria-label="${attentionCount} AI session${attentionCount === 1 ? ' needs' : 's need'} attention">${attentionCount}</b>` : ''
        }</span>`
        : '';
    const sessionSection = getAiSessionsDiv(getWorkspaceAiSessionSurface(card), {
        showRootChips: rootCount > 1,
        runningIconAnimation,
    });
    const colorStyles = getCardColorStyles(card.color);

    return `<div class="project-container" data-nodrag>
    <div class="workspace-card project steward-item-card${runningSessionCount > 0 ? ' session-running' : ''}" style="${colorStyles.cardStyle}" data-id="${escapeAttribute(card.id)}" data-name="${escapeAttribute(`${card.name || ''} ${card.environmentLabel || ''} ${roots.map(root => root.name).join(' ')}`.toLowerCase())}" data-workspace-card-kind="${card.kind}" data-workspace-navigation-identity="${escapeAttribute(card.navigationIdentity)}" data-workspace-scope-identity="${escapeAttribute(card.scopeIdentity)}" ${sessionFx ? `data-session-fx="${sessionFx}"` : ''}${runningTitle ? ` title="${runningTitle}"` : ''} data-current-workspace${badge ? ' data-has-ai-session-badge' : ''}${showSaveAction ? ' data-has-save-action' : ''} data-readonly-project${aiSessions?.expanded ? ' data-codex-expanded' : ''}>
        <div class="project-aura"></div>
        <div class="project-border steward-item-accent" style="${colorStyles.accentStyle}"></div>
        ${sessionFx && sessionFx !== 'none' ? '<div class="project-session-fx"></div>' : ''}
        ${saveBadge}
        <div class="fitty-container project-title-row">
            <span class="project-kind-icon" title="${projectIconTitle}">${projectIcon}</span>
            <h2 class="project-header">${workspaceName}</h2>
        </div>
        <p class="project-description workspace-metadata">${folderLabel}</p>
        ${badge}
        ${sessionSection}
    </div>
</div>`;
}

function getWorkspaceRemoteType(environment: WorkspaceCardViewModel['environment']): ProjectRemoteType {
    switch (environment) {
        case 'ssh': return ProjectRemoteType.SSH;
        case 'wsl': return ProjectRemoteType.WSL;
        case 'devContainer': return ProjectRemoteType.DevContainer;
        case 'remote': return ProjectRemoteType.Remote;
        case 'local':
        default: return ProjectRemoteType.None;
    }
}


export function getProjectsPanelContent(groups: Group[], infos: StewardInfos): string {
    var configuredMaxVisibleProjects = infos.config.get(
        'maxVisibleProjectsPerGroup',
        DEFAULT_MAX_VISIBLE_PROJECTS_PER_GROUP
    );
    var normalizedMaxVisibleProjects = Math.floor(Number(configuredMaxVisibleProjects));
    var maxVisibleProjectsPerGroup = Number.isFinite(normalizedMaxVisibleProjects)
        && normalizedMaxVisibleProjects > 0
        ? normalizedMaxVisibleProjects
        : DEFAULT_MAX_VISIBLE_PROJECTS_PER_GROUP;
    var favoriteProjects = getFavoriteProjectsInOrder(
        (groups || []).reduce((projects, group) => projects.concat(group.projects || []), [] as Project[])
    );
    var favoritesGroupCollapsed = infos.favoritesGroupCollapsed !== undefined
        ? infos.favoritesGroupCollapsed
        : (groups || []).every(group => group.collapsed);
    var mainGroups = [
        ...(groups.length ? [getFavoritesGroup(favoriteProjects, favoritesGroupCollapsed)] : []),
        ...groups,
    ];
    var favoriteOptions: GroupSectionOptions = {
        virtual: true,
        readOnlyProjects: false,
        draggableVirtualProjects: true,
        collapsible: true,
        className: 'favorites-group',
        systemBadge: 'Pinned',
    };
    var projectOptions: GroupSectionOptions = {
        virtual: false,
        readOnlyProjects: false,
        draggableVirtualProjects: false,
        collapsible: true,
        className: 'saved-project-group',
        systemBadge: '',
    };

    return `<div class="groups-wrapper ${!infos.config.displayProjectPath ? 'hide-project-path' : ''}" style="--steward-max-visible-projects-per-group: ${maxVisibleProjectsPerGroup};">
        ${mainGroups.length
            ? mainGroups.map(group => getGroupSection(
                group,
                group.id === FAVORITES_GROUP_ID ? favoriteOptions : projectOptions
            )).join('\n')
            : (infos.otherStorageHasData ? getImportDiv() : getNoProjectsDiv())}
    </div>
    ${infos.config.showAddGroupButtonTile ? getTempGroupSection() : ''}`;
}

function getOpenCurrentWorkspaceEmptyState(hasOtherWindows: boolean): string {
    return `<div class="open-current-workspace-empty">${hasOtherWindows
        ? 'No folder is open in this window.'
        : 'Open a folder to see running projects.'}</div>`;
}

function criticalStartupStyle(): string {
    return `
        * {
            box-sizing: border-box;
        }
        html,
        body {
            min-height: 100%;
        }
        body {
            background: var(--vscode-sideBar-background);
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family);
            margin: 0;
        }
        html.dashboard-styles-pending [data-dashboard-ready-content] {
            display: none !important;
        }
        html:not(.dashboard-styles-pending) [data-dashboard-style-loading] {
            display: none !important;
        }
        .dashboard-style-loading {
            min-height: 264px;
            padding: 12px;
        }
        .dashboard-style-loading-tabs {
            display: flex;
            gap: 8px;
            height: 32px;
            border-bottom: 1px solid var(--vscode-panel-border, transparent);
        }
        .dashboard-style-loading-tab {
            display: block;
            width: 52px;
            height: 20px;
            margin-top: 4px;
            border-radius: 4px 4px 0 0;
            background: var(--vscode-editor-inactiveSelectionBackground, rgba(127, 127, 127, .22));
        }
        .dashboard-style-loading-tab.active {
            background: var(--vscode-editor-selectionBackground, rgba(127, 127, 127, .42));
        }
        .dashboard-style-loading-cards {
            height: 196px;
            overflow: hidden;
            padding-top: 12px;
        }
        .dashboard-style-loading-card {
            display: block;
            height: 52px;
            margin-bottom: 10px;
            border-radius: 6px;
            background: var(--vscode-editor-inactiveSelectionBackground, rgba(127, 127, 127, .18));
        }
        .filter-wrapper {
            display: flex;
            align-items: center;
            width: 100%;
            box-sizing: border-box;
        }
        .search-box {
            display: flex;
            align-items: center;
            min-width: 0;
        }
        .search-icon,
        .clear-search-icon,
        .settings-button,
        .sponsor-button,
        .toggle-all-groups-button,
        .toggle-all-groups-collapse-icon,
        .toggle-all-groups-expand-icon {
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }
        .search-icon,
        .clear-search-icon {
            flex: 0 0 auto;
            width: 16px;
            height: 16px;
            overflow: hidden;
        }
        .search-icon svg,
        .clear-search-icon svg {
            width: 14px;
            height: 14px;
        }
        .clear-search-icon {
            visibility: hidden;
        }
        .settings-button,
        .sponsor-button,
        .toggle-all-groups-button {
            width: 30px;
            height: 30px;
            padding: 0;
            overflow: hidden;
        }
        .settings-button svg,
        .sponsor-button svg,
        .toggle-all-groups-button svg {
            width: 18px;
            height: 18px;
            fill: currentColor;
        }
        .toggle-all-groups-expand-icon {
            display: none;
        }
        body.steward-all-collapsed .toggle-all-groups-collapse-icon {
            display: none;
        }
        body.steward-all-collapsed .toggle-all-groups-expand-icon {
            display: inline-flex;
        }
    `;
}

function getGroupSection(
    group: Group,
    options: GroupSectionOptions,
    emptyContent: string = ''
) {
    // Apply changes to HTML here also to getTempGroupSection

    var groupActions = options.virtual
        ? ''
        : `<div class="group-actions right">
            <span data-action="add" title="Add Project">${Icons.add}</span>
            <span data-action="edit" title="Edit Group">${Icons.edit}</span>
            <span data-action="remove" title="Remove Group">${Icons.remove
        }</span>
        </div>`;
    var dragAttribute = options.virtual ? '' : 'data-drag-group';
    var groupName = escapeAttribute(group.groupName || 'Unnamed Group');
    var systemGroupAttribute = options.virtual ? ` data-system-group="${group.id}"` : '';
    var groupTitleText = options.collapsible
        ? `<span class="group-title-text" data-action="collapse" ${dragAttribute}>
            <span class="collapse-icon" title="Open/Collapse Group">${Icons.collapse}</span>
            ${groupName}
        </span>`
        : `<span class="group-title-text">${groupName}</span>`;

    return `
<div class="group steward-section ${options.className} ${group.collapsed ? 'collapsed' : ''} ${group.projects.length === 0 ? 'no-projects' : ''
        }" data-group-id="${group.id}"${options.virtual ? ' data-virtual-group' : ''}${systemGroupAttribute}>
    <div class="group-title steward-section-header steward-group-header">
        ${groupTitleText}
        ${options.systemBadge ? `<span class="group-title-badge">${options.systemBadge}</span>` : ''}
        ${groupActions}
    </div>
    <div class="group-list">
        <div class="drop-signal"></div>
        ${group.projects.length
            ? group.projects.map(project => getProjectDiv(project, options)).join('\n')
            : emptyContent}
    </div>       
</div>`;
}

function getFavoritesGroup(favoriteProjects: Project[], collapsed: boolean = false): Group {
    var group = new Group(FAVORITES_GROUP_NAME, favoriteProjects);
    group.id = FAVORITES_GROUP_ID;
    group.collapsed = collapsed;

    return group;
}

function getTempGroupSection() {
    return `
<div class="group" id="tempGroup">
    <div class="group-title steward-section-header steward-group-header" data-action="add-group">
        <span>${Icons.add} New Group</span>
    </div>
    <div class="group-list">
        <div class="drop-signal"></div>
    </div>       
</div>`;
}

function getProjectDiv(
    project: Project,
    options: GroupSectionOptions
) {
    var colorStyles = getCardColorStyles(project.color);
    var remoteType = getRemoteType(project);
    var description = sanitizeProjectName(project.description);
    var projectName = escapeAttribute(sanitizeProjectName(project.name));
    var searchText = escapeAttribute(getProjectSearchText(project));
    var escapedDescription = escapeAttribute(description);
    var projectIcon = getProjectIcon(remoteType);
    var projectIconTitle = getProjectIconTitle(remoteType);
    var favoriteTitle = project.favorite ? 'Remove From Favorites' : 'Add To Favorites';
    var projectActions = options.readOnlyProjects
        ? ''
        : `<span data-action="color" title="Edit Color">${Icons.palette
        }</span>
                <span data-action="edit" title="Edit Project">${Icons.edit
        }</span>
                <span data-action="remove" title="Remove Project">${Icons.remove
        }</span>`;
    var projectActionsWrapper = projectActions
        ? `<div class="project-actions-wrapper">
            <div class="project-actions">
                ${projectActions}
            </div>
        </div>`
        : '';
    var favoriteBadgeIcon = project.favorite ? Icons.starFilled : Icons.star;
    var favoriteBadge = options.readOnlyProjects
        ? ''
        : `<span data-action="favorite" class="project-favorite-badge ${project.favorite ? 'active' : ''}" title="${favoriteTitle}">${favoriteBadgeIcon}</span>`;
    var saveBadge = project.showSaveAction
        ? `<span data-action="save" class="project-save-badge" title="Save Current Project">${Icons.save}</span>`
        : '';
    var isRemote = remoteType !== ProjectRemoteType.None;

    return `
<div class="project-container"${options.virtual && !options.draggableVirtualProjects ? ' data-nodrag' : ''}>
    <div class="project steward-item-card" style="${colorStyles.cardStyle}" data-id="${project.id}" data-name="${searchText}"${isRemote ? ' data-is-remote' : ''
        }${options.virtual ? ' data-virtual-project' : ''
        }${options.readOnlyProjects ? ' data-readonly-project' : ''
        }${!options.readOnlyProjects ? ' data-has-favorite-toggle' : ''
        }${project.showSaveAction ? ' data-has-save-action' : ''
        }${project.favorite ? ' data-favorite-project' : ''
        }>
        <div class="project-aura"></div>
        <div class="project-border steward-item-accent" style="${colorStyles.accentStyle}"></div>
        ${favoriteBadge}
        ${saveBadge}
        ${projectActionsWrapper}
        <div class="fitty-container project-title-row">
            <span class="project-kind-icon" title="${projectIconTitle}">
                ${projectIcon}
            </span>
            <h2 class="project-header">
                ${projectName}
            </h2>
        </div>
        <p class="project-description" title="${escapedDescription}">
            ${escapedDescription}
        </p>
    </div>
</div>`;
}

function getCardColorStyles(colorValue: string | undefined): { cardStyle: string; accentStyle: string } {
    const rawColor = (colorValue || '').trim();
    const escapedColor = escapeStyleValue(rawColor);
    const color = escapedColor === rawColor ? escapedColor : '';

    return {
        cardStyle: color ? `--project-color: ${color};` : '',
        accentStyle: color ? `background: ${color};` : '',
    };
}

export function getProjectSearchText(project: Project): string {
    var description = sanitizeProjectName(project.description);
    var codexSessions = project.codexSessions || [];
    var kimiSessions = project.kimiSessions || [];
    var claudeSessions = project.claudeSessions || [];
    var aiSessionSearchText = codexSessions
        .concat(kimiSessions)
        .concat(claudeSessions)
        .map(session => session.name || '')
        .join(' ');

    return `${project.name || ''} ${description} ${aiSessionSearchText}`.toLowerCase();
}


function getProjectIcon(remoteType: ProjectRemoteType): string {
    switch (remoteType) {
        case ProjectRemoteType.SSH:
        case ProjectRemoteType.WSL:
        case ProjectRemoteType.Remote:
            return Icons.terminal;
        case ProjectRemoteType.DevContainer:
            return Icons.container;
        default:
            return Icons.folder;
    }
}

function getProjectIconTitle(remoteType: ProjectRemoteType): string {
    switch (remoteType) {
        case ProjectRemoteType.SSH:
            return 'SSH Project';
        case ProjectRemoteType.DevContainer:
            return 'Dev Container Project';
        case ProjectRemoteType.WSL:
        case ProjectRemoteType.Remote:
            return 'Remote Project';
        default:
            return 'Local Project';
    }
}

function escapeStyleValue(value: string): string {
    return (value || '').replace(/[;"<>]/g, '').trim();
}

function getNoProjectsDiv() {
    return `
<div class="project-container">
    <div class="project no-projects" data-action="add-project" data-nodrag>
        No projects have been added yet.
        <br/>
        Click here to add one.
    </div>
</div>`;
}

function getImportDiv() {
    return `
<div class="project-container">
    <div class="project no-projects import-data" data-action="import-from-other-storage" data-nodrag>
        Agent Pivot is empty, but there are projects in your other storage.
        <br/>
        This can happen if the storage option has been changed on a different device that is synced via Settings Sync.
        <p>Click here to import.</p>
    </div>
</div>`;
}

function getProjectContextMenu() {
    return `
<div id="projectContextMenu" class="custom-context-menu">
    <div class="custom-context-menu-item" data-action="open">
        Open Project In Current Window
    </div>
    <div class="custom-context-menu-item not-remote" data-action="open-add-to-workspace">
        Add To Workspace
    </div>

    <div class="custom-context-menu-separator"></div>
    
    <div class="custom-context-menu-item" data-action="color">
        Edit Color
    </div>
    <div class="custom-context-menu-item" data-action="edit">
        Edit Project
    </div>
    <div class="custom-context-menu-item" data-action="remove">
        Remove Project
    </div>
</div>
`;
}

function getGroupContextMenu() {
    return `
<div id="groupContextMenu" class="custom-context-menu">   
    <div class="custom-context-menu-item" data-action="add">
        Add Project
    </div>
    <div class="custom-context-menu-item" data-action="edit">
        Edit Group
    </div>
    <div class="custom-context-menu-item" data-action="remove">
        Remove Group
    </div>
</div>
`;
}


function colorDefaults() {
    var colors = INBUILT_COLOR_DEFAULTS
        .map(color => `${color.name}: ${color.defaultValue};`)
        .join('\n');

    return `html { \n${colors}\n}`;
}

function getCustomStyle(config: vscode.WorkspaceConfiguration, runningImages: RunningAnimationImages = {}) {
    var {
        customProjectCardBackground,
        customProjectNameColor,
        customProjectPathColor,
        projectTileWidth,
    } = config;

    // Nested Template Strings, hooray! \o/
    return `
<style>
    :root {
        ${customProjectCardBackground && customProjectCardBackground.trim()
            ? `--steward-project-card-bg: ${customProjectCardBackground};`
            : ''
        }
        ${customProjectNameColor && customProjectNameColor.trim()
            ? `--steward-foreground: ${customProjectNameColor};`
            : ''
        }
        ${customProjectPathColor && customProjectPathColor.trim()
            ? `--steward-path: ${customProjectPathColor};`
            : ''
        }
        ${projectTileWidth && !isNaN(+projectTileWidth)
            ? `--column-width: ${projectTileWidth}px;`
            : ''
        }
        ${runningImages.card
            ? `--agent-pivot-running-card-image: url("${runningImages.card}");`
            : ''
        }
        ${runningImages.icon
            ? `--agent-pivot-running-icon-image: url("${runningImages.icon}");`
            : ''
        }
    }
</style>`;
}

function getMediaResource(
    context: vscode.ExtensionContext,
    webview: vscode.Webview,
    name: string,
    assetRevision: string,
) {
    let resource = vscode.Uri.file(
        path.join(context.extensionPath, 'media', name)
    );
    resource = webview.asWebviewUri(resource);

    return `${resource.toString()}?stewardAssetRevision=${assetRevision}`;
}
