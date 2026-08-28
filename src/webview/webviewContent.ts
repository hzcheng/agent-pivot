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
} from '../constants';
import { getFavoriteProjectsInOrder } from '../projects/favoriteProjectOrder';
import { normalizeProjectTags } from '../projects/projectTags';
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
import { buildOpenWindowRowViewModels } from '../openWorkspaces/windowRowViewModel';
import { getOpenWindowMenu, getOpenWindowSwitcherGroupContent } from './webviewWindowSwitcherContent';
import {
    getWorkspaceIcon,
    getWorkspaceIconTitle,
} from './workspaceIconPresentation';

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
    showOpenTabLayoutNotice: boolean = false,
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

    var customCss = sanitizeCustomCss(infos.config.get('customCss') || '');
    var searchCatalog = serializeDashboardSearchCatalog(
        buildWorkspaceDashboardSearchCatalog(groups, workspaceCards, infos.skills || [])
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
    var currentWorkspaceCard = workspaceCards.find(card => card.kind === 'current');

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
                <button type="button" id="dashboard-tab-ai-button" class="dashboard-tab-button" role="tab" aria-selected="false" aria-controls="dashboard-panel-ai" tabindex="-1" data-dashboard-tab="ai" aria-label="AI" title="AI">
                    <span class="dashboard-tab-icon" aria-hidden="true">${Icons.sparkles}</span>
                    <span class="dashboard-tab-label">AI</span>
                </button>
            </div>
        </div>
        <main class="dashboard-content">
            <section id="dashboard-tab-open" class="dashboard-tab-panel" role="tabpanel" aria-labelledby="dashboard-tab-open-button">
                ${showOpenTabLayoutNotice ? getOpenTabLayoutMigrationNotice() : ''}
                <div class="sticky-groups-wrapper">
                    ${openWorkspacesContent}
                </div>
            </section>
            <section id="dashboard-tab-projects" class="dashboard-tab-panel" role="tabpanel" aria-labelledby="dashboard-tab-projects-button" hidden>
                <div class="dashboard-projects-loading" role="status" hidden>Loading projects…</div>
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
        ${getAiSessionCreateDropdown(currentWorkspaceCard
            ? getWorkspaceAiSessionSurface(currentWorkspaceCard)
            : undefined)}
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

            window.onload = () => {
                initProjects();
                const storedFilter = sessionStorage.getItem('filterValue') || '';
                let filtering;
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
                    onActiveTabChanged: () => window.__agentPivotSyncCollapseButton(),
                });
                window.__agentPivotDashboard = dashboard;
                fitProjectHeaders(document.getElementById('dashboard-tab-open'));
                filtering = initFiltering(${infos.config.searchIsActiveByDefault}, dashboard);
                initTagFiltering();
                initProjectInlineEdit(dashboard);
                filtering.apply();
            };
        })();
    </script>


</html>`;
}

function getOpenTabLayoutMigrationNotice(): string {
    return `<aside class="open-tab-layout-notice" data-open-tab-layout-notice role="status" aria-label="OPEN tab layout update">
        <span class="open-tab-layout-notice-copy"><strong>OPEN has a new layout.</strong> WINDOWS is always visible; CHATS contains active sessions and ALL contains every session. Your previous Worktree view is now CHATS in Tree view.</span>
        <span class="open-tab-layout-notice-actions">
            <button type="button" class="steward-button" data-action="open-open-tab-layout-migration-guide">Learn more</button>
            <button type="button" class="steward-icon-button" data-action="dismiss-open-tab-layout-notice" aria-label="Dismiss OPEN tab layout update" title="Dismiss">×</button>
        </span>
    </aside>`;
}

export function getOpenSessionSurfaceContent(
    card: WorkspaceCardViewModel | null,
    hasOtherWindows: boolean = false,
    runningCardAnimation?: string,
    runningIconAnimation?: string,
): string {
    const currentCard = card && card.kind === 'current' && card.roots.length > 0 ? card : null;
    if (!currentCard) {
        return `<div class="open-session-surface open-session-surface-empty" data-open-session-surface role="region" aria-label="Current window sessions">
            ${getOpenCurrentWorkspaceEmptyState(hasOtherWindows)}
        </div>`;
    }
    const roots = currentCard.roots.slice().sort((left, right) => left.ordinal - right.ordinal);
    const aiSessions = currentCard.aiSessions;
    const aiSessionCount = aiSessions?.aiSessionCount || 0;
    const activeSessionCount = aiSessions?.activeSessionCount || 0;
    const attentionCount = currentCard.attentionCount || 0;
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
    return `<div class="open-session-surface" data-open-session-surface data-id="${escapeAttribute(currentCard.id)}" data-current-workspace data-workspace-card-kind="current" data-workspace-navigation-identity="${escapeAttribute(currentCard.navigationIdentity)}" data-workspace-scope-identity="${escapeAttribute(currentCard.scopeIdentity)}" role="region" aria-label="Current window sessions">
        ${getRunningSessionSurfaceFx(currentCard, runningCardAnimation)}
        ${badge}
        ${getAiSessionsDiv(getWorkspaceAiSessionSurface(currentCard), {
            showRootChips: roots.length > 1,
            runningIconAnimation,
        })}
    </div>`;
}

export function getOpenWorkspacesGroupContent(
    cards: WorkspaceCardViewModel[],
    otherWindowsStatus: OpenWorkspaceBridgeStatus = 'ready',
    runningCardAnimation?: string,
    runningIconAnimation?: string,
    pathSegmentsByCardId?: ReadonlyMap<string, readonly string[]>,
): string {
    // The persistent WINDOWS switcher owns window navigation; the current
    // window's CHATS/ALL surface is its direct, permanently available sibling.
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
    // 状态条只在 bridge 需要向用户说明状态时出现；ready 时不留空白行，
    // 让 WINDOWS 标签紧贴窗口条目。文案单行省略，title 承载全量。
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
    const currentSection = getOpenSessionSurfaceContent(
        current,
        navigationCards.length > 0,
        runningCardAnimation,
        runningIconAnimation,
    );
    return `${switcherSection}
${currentSection}`;
}

function getRunningSessionSurfaceFx(
    card: WorkspaceCardViewModel,
    runningCardAnimation?: string,
): string {
    const runningSessionCount = (card.aiSessions?.activeSessions || [])
        .filter(session => session.executionState === 'running').length;
    const sessionFx = runningSessionCount > 0
        ? normalizeRunningCardAnimation(runningCardAnimation)
        : '';
    return sessionFx && sessionFx !== 'none'
        ? `<div class="project-session-fx open-session-surface-fx" data-session-fx="${sessionFx}"></div>`
        : '';
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

function getUniqueProjectTags(groups: Group[]): string[] {
    var seen = new Set<string>();
    var tags: string[] = [];
    for (let group of (groups || [])) {
        for (let project of (group.projects || [])) {
            var normalized = normalizeProjectTags(project.tags);
            for (let tag of normalized) {
                var key = tag.toLowerCase();
                if (!seen.has(key)) {
                    seen.add(key);
                    tags.push(tag);
                }
            }
        }
    }
    tags.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    return tags;
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

    var allTags = getUniqueProjectTags(groups);
    var tagFilterBar = allTags.length
        ? `<div class="tag-filter-bar">
            <button class="tag-filter-chip active" data-tag-filter="all">All</button>
            ${allTags.map(tag => `<button class="tag-filter-chip" data-tag-filter="${escapeAttribute(tag)}">${escapeAttribute(tag)}</button>`).join('\n')}
        </div>`
        : '';

    return `${tagFilterBar}<div class="groups-wrapper ${!infos.config.displayProjectPath ? 'hide-project-path' : ''}" style="--steward-max-visible-projects-per-group: ${maxVisibleProjectsPerGroup};">
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
    var groupActions = options.virtual
        ? ''
        : `<div class="group-actions">
            <span data-action="add" title="Add Project">${Icons.add}</span>
            <span data-action="edit" title="Edit Group">${Icons.edit}</span>
            <span data-action="remove" title="Remove Group">${Icons.remove
        }</span>
        </div>`;
    var dragAttribute = options.virtual ? '' : 'data-drag-group';
    var groupName = escapeAttribute(group.groupName || 'Unnamed Group');
    var systemGroupAttribute = options.virtual ? ` data-system-group="${group.id}"` : '';
    var projectCount = group.projects.length;
    var collapseArrow = options.collapsible
        ? `<span class="group-collapse-arrow">${Icons.collapse}</span>`
        : '';
    var collapseAttrs = options.collapsible
        ? ` data-action="collapse" ${dragAttribute}`
        : '';

    return `
<div class="group ${options.className} ${group.collapsed ? 'collapsed' : ''} ${projectCount === 0 ? 'no-projects' : ''
        }" data-group-id="${group.id}"${options.virtual ? ' data-virtual-group' : ''}${systemGroupAttribute}>
    <div class="group-header"${collapseAttrs} title="${group.collapsed ? 'Expand' : 'Collapse'} Group">
        ${collapseArrow}
        <span class="group-name">${groupName}</span>
        ${options.systemBadge ? `<span class="group-badge">${options.systemBadge}</span>` : ''}
        <span class="group-count">${projectCount}</span>
        ${groupActions}
    </div>
    <div class="group-list">
        <div class="drop-signal"></div>
        ${projectCount
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
    <div class="group-header" data-action="add-group" title="Add New Group">
        <span class="group-collapse-arrow">${Icons.add}</span>
        <span class="group-name">New Group</span>
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
    var projectPath = escapeAttribute(project.path || '');
    var projectPathBase = projectPath ? projectPath.split(/[\\\/]/).pop() || projectPath : '';
    var favoriteTitle = project.favorite ? 'Remove From Favorites' : 'Add To Favorites';
    var projectActions = options.readOnlyProjects
        ? ''
        : `<span data-action="color" title="Edit Color">${Icons.palette
        }</span>
                <span data-action="edit" title="Edit Project">${Icons.edit
        }</span>
                <span data-action="remove" title="Remove Project">${Icons.remove
        }</span>`;
    var favoriteBadgeIcon = project.favorite ? Icons.starFilled : Icons.star;
    var favoriteBadge = options.readOnlyProjects
        ? ''
        : `<span data-action="favorite" class="project-favorite-badge ${project.favorite ? 'active' : ''}" title="${favoriteTitle}">${favoriteBadgeIcon}</span>`;
    var saveBadge = project.showSaveAction
        ? `<span data-action="save" class="project-save-badge" title="Save Current Project">${Icons.save}</span>`
        : '';
    var isRemote = remoteType !== ProjectRemoteType.None;
    var tags = normalizeProjectTags(project.tags);
    var tagsHtml = tags.length
        ? `<div class="project-row-tags">${tags.map(tag => `<span class="project-tag" title="${escapeAttribute(`#${tag}`)}">${escapeAttribute(tag)}</span>`).join('')
        }</div>`
        : '';

    return `
<div class="project-container"${options.virtual && !options.draggableVirtualProjects ? ' data-nodrag' : ''}>
    <div class="project" style="${colorStyles.cardStyle}" data-id="${project.id}" data-name="${searchText}" ${escapedDescription ? ` title="${escapedDescription}"` : ""}${isRemote ? ' data-is-remote' : ''
        }${options.virtual ? ' data-virtual-project' : ''
        }${options.readOnlyProjects ? ' data-readonly-project' : ''
        }${!options.readOnlyProjects ? ' data-has-favorite-toggle' : ''
        }${project.showSaveAction ? ' data-has-save-action' : ''
        }${project.favorite ? ' data-favorite-project' : ''
        }${tags.length ? ' data-has-tags' : ''
        }${tags.length ? ` data-tags="${escapeAttribute(tags.join(','))}"` : ''
        }>
        <div class="project-border" style="${colorStyles.accentStyle}"></div>
        <div class="project-row-main">
            <span class="project-header" title="${projectName}">${projectName}</span>
            <span class="project-path-sep">/</span><span class="project-path" title="${projectPath}">${projectPathBase}</span>
            <div class="project-row-actions">
                ${saveBadge}
                ${favoriteBadge}
                ${projectActions ? `<div class="project-actions">${projectActions}</div>` : ''}
            </div>
        </div>
        ${tagsHtml}
        ${options.readOnlyProjects ? '' : `<div class="project-edit-form" hidden>
            <div class="project-edit-field">
                <label class="project-edit-label">Name</label>
                <input class="project-edit-input" data-edit-field="name" type="text" value="${escapeAttribute(project.name || '')}" placeholder="Project name" required>
            </div>
            <div class="project-edit-field">
                <label class="project-edit-label">Description</label>
                <input class="project-edit-input" data-edit-field="description" type="text" value="${escapeAttribute(project.description || '')}" placeholder="Optional description">
            </div>
            <div class="project-edit-field">
                <label class="project-edit-label">Tags</label>
                <input class="project-edit-input" data-edit-field="tags" type="text" value="${escapeAttribute((project.tags || []).join(', '))}" placeholder="Comma-separated, e.g. frontend, urgent">
            </div>
            <div class="project-edit-actions">
                <button type="button" class="project-edit-cancel steward-button" data-action="cancel-edit">Cancel</button>
                <button type="button" class="project-edit-save steward-button steward-button-primary" data-action="save-edit">Save</button>
            </div>
        </div>`}
    </div>
</div>`;
}

function getCardColorStyles(colorValue: string | undefined): { cardStyle: string; accentStyle: string } {
    const color = sanitizeCssColor(colorValue);

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
    var tagsSearchText = normalizeProjectTags(project.tags).join(' ');

    return `${project.name || ''} ${description} ${tagsSearchText} ${aiSessionSearchText}`.toLowerCase();
}


// Settings-sourced style values end up inside <style> blocks in the webview.
// Sanitize them so a hostile (or compromised) workspace cannot break out of
// the style context or force the webview to load remote resources: the CSP
// allows https: images for user conversation content, so raw CSS must never
// smuggle in remote url() references or markup.
const CUSTOM_CSS_FORBIDDEN_PATTERNS: ReadonlyArray<RegExp> = [
    /</g, // never needed in CSS; blocks </style> breakouts and tag injection
    /@import/gi,
    /expression\s*\(/gi,
    /javascript\s*:/gi,
    /url\(\s*['"]?\s*https?:/gi,
    /-moz-binding/gi,
];

export function sanitizeCustomCss(value: string): string {
    let css = typeof value === 'string' ? value : '';
    for (const pattern of CUSTOM_CSS_FORBIDDEN_PATTERNS) {
        css = css.replace(pattern, ' ');
    }
    return css;
}

// Plain CSS colors only: hex, named colors, numeric rgb()/hsl() functions, or
// a var() reference to another custom property. Anything else (url(), quotes,
// semicolons, markup) is dropped so the value stays a single safe token.
const CSS_COLOR_PATTERN = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{1,32}|rgba?\([\d.,%\s/]+\)|hsla?\([\d.,%\s/]+\)|var\(\s*--[a-zA-Z0-9_-]+(\s*,\s*[a-zA-Z0-9#()%.,\s-]+)?\s*\))$/;

export function sanitizeCssColor(value: string | undefined | null): string {
    const color = (value || '').trim();
    if (!color || color.length > 96) {
        return '';
    }
    return CSS_COLOR_PATTERN.test(color) ? color : '';
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
    var cardBackground = sanitizeCssColor(customProjectCardBackground);
    var nameColor = sanitizeCssColor(customProjectNameColor);
    var pathColor = sanitizeCssColor(customProjectPathColor);
    return `
<style>
    :root {
        ${cardBackground
            ? `--steward-project-card-bg: ${cardBackground};`
            : ''
        }
        ${nameColor
            ? `--steward-foreground: ${nameColor};`
            : ''
        }
        ${pathColor
            ? `--steward-path: ${pathColor};`
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
