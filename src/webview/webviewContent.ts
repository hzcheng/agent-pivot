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
    AiSessionProviderId,
    CodexSession,
    WorkspaceCardViewModel,
} from '../models';
import {
    FAVORITES_GROUP_ID,
    FITTY_OPTIONS,
    INBUILT_COLOR_DEFAULTS,
    OPEN_CURRENT_WORKSPACE_GROUP_ID,
    OPEN_WORKSPACES_GROUP_ID,
} from '../constants';
import { getFavoriteProjectsInOrder } from '../projects/favoriteProjectOrder';
import {
    buildWorkspaceDashboardSearchCatalog,
    serializeDashboardSearchCatalog,
} from './dashboardViewModel';
import * as Icons from './webviewIcons';
import type {
    ActiveAiSessionViewModel,
    AiSessionProviderSummary,
    AiSessionTabId,
    AiSessionViewModel,
} from '../aiSessions/types';
import { projectAiSessionHistory } from '../aiSessions/historyProjection';
import type { OpenWorkspaceBridgeStatus } from '../openWorkspaces/bridgeClient';
import { removeWorkspaceWindowDecorations } from '../workspaces/contextResolver';

const FAVORITES_GROUP_NAME = 'FAVORITES';
const OPEN_CURRENT_WORKSPACE_GROUP_NAME = 'CURRENT WORKSPACE';
const OPEN_OTHER_WINDOWS_GROUP_NAME = 'OTHER WINDOWS';
const DEFAULT_MAX_VISIBLE_PROJECTS_PER_GROUP = 5;
const AI_SESSION_RUNNING_CARD_ANIMATIONS = new Set([
    'current',
    'sweep',
    'orbit',
    'halo',
    'sharingan-itachi',
    'sharingan-obito-kakashi',
    'sharingan-sasuke',
    'sharingan-shisui',
    'sharingan-madara',
    'sharingan-madara-eternal',
    'ripple',
    'breath',
    'none',
]);

const AI_SESSION_RUNNING_ICON_ANIMATIONS = new Set([
    'current',
    'halo',
    'sharingan-itachi',
    'sharingan-obito-kakashi',
    'sharingan-sasuke',
    'sharingan-shisui',
    'sharingan-madara',
    'sharingan-madara-eternal',
    'none',
]);

function normalizeRunningCardAnimation(value: string | undefined): string {
    return value && AI_SESSION_RUNNING_CARD_ANIMATIONS.has(value) ? value : 'current';
}

function normalizeRunningIconAnimation(value: string | undefined): string {
    return value && AI_SESSION_RUNNING_ICON_ANIMATIONS.has(value) ? value : 'current';
}

interface GroupSectionOptions {
    virtual: boolean;
    readOnlyProjects: boolean;
    draggableVirtualProjects: boolean;
    collapsible: boolean;
    className: string;
    systemBadge: string;
}

interface AiSessionRenderOptions {
    showRootChips?: boolean;
    runningIconAnimation?: string;
}

interface RootLabeledAiSession extends CodexSession {
    primaryRootId?: string;
    primaryRootLabel?: string;
}

interface AiSessionSurfaceViewModel {
    id: string;
    activeAiSessionProvider?: AiSessionProviderId;
    selectedAiSessionProviders?: AiSessionProviderId[];
    providers?: AiSessionProviderSummary[];
    activeAiSessionTab?: AiSessionTabId;
    codexSessions?: RootLabeledAiSession[];
    kimiSessions?: RootLabeledAiSession[];
    claudeSessions?: RootLabeledAiSession[];
    codexSessionsUnavailable?: boolean;
    kimiSessionsUnavailable?: boolean;
    claudeSessionsUnavailable?: boolean;
    activeAiSessions?: ActiveAiSessionViewModel[];
}

const WEBVIEW_ASSET_ACTIVATION = randomBytes(8).toString('hex');
let webviewAssetRevision = 0;

export function getStewardContent(
    context: vscode.ExtensionContext,
    webview: vscode.Webview,
    groups: Group[],
    infos: StewardInfos,
    isSidebar: boolean = false,
    workspaceCards: WorkspaceCardViewModel[] = [],
    otherWindowsStatus: OpenWorkspaceBridgeStatus = 'ready',
): string {
    var assetRevision = `${WEBVIEW_ASSET_ACTIVATION}-${++webviewAssetRevision}`;
    var stylesPath = getMediaResource(context, webview, 'styles.css', assetRevision);
    var fittyPath = getMediaResource(context, webview, 'fitty.min.js', assetRevision);
    var dragulaPath = getMediaResource(context, webview, 'dragula.min.js', assetRevision);
    var autoScrollerPath = getMediaResource(context, webview, 'dom-autoscroller.min.js', assetRevision);

    var projectScriptsPath = getMediaResource(
        context,
        webview,
        'webviewProjectScripts.js',
        assetRevision,
    );
    var dndScriptsPath = getMediaResource(
        context,
        webview,
        'webviewDnDScripts.js',
        assetRevision,
    );
    var dashboardScriptsPath = getMediaResource(
        context,
        webview,
        'webviewDashboardScripts.js',
        assetRevision,
    );
    var promptScriptsPath = getMediaResource(
        context,
        webview,
        'webviewPromptScripts.js',
        assetRevision,
    );
    var todoScriptsPath = getMediaResource(
        context,
        webview,
        'webviewTodoScripts.js',
        assetRevision,
    );
    var filterScriptsPath = getMediaResource(
        context,
        webview,
        'webviewFilterScripts.js',
        assetRevision,
    );

    var customCss = infos.config.get('customCss') || '';
    var allGroupsCollapsed = !!infos.openWorkspacesGroupCollapsed;
    var searchCatalog = serializeDashboardSearchCatalog(
        buildWorkspaceDashboardSearchCatalog(groups, workspaceCards, infos.todoSearchItems || [])
    );
    var openWorkspacesContent = getOpenWorkspacesGroupContent(
        workspaceCards,
        infos.openWorkspacesGroupCollapsed,
        otherWindowsStatus,
        infos.config.get<string>('aiSessionRunningCardAnimation', 'current'),
        infos.config.get<string>('aiSessionRunningIconAnimation', 'current'),
    );

    return `
<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta
            http-equiv="Content-Security-Policy"
            content="default-src 'none'; img-src * data:; script-src ${webview.cspSource
        } 'unsafe-inline'; style-src ${webview.cspSource} 'unsafe-inline';"
        />
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>${criticalStartupStyle()}</style>
        <link rel="stylesheet" type="text/css" href="${stylesPath}">
        <style>${colorDefaults()}</style>
        <style>
            /* Custom CSS from configuration */
            ${customCss}
        </style>
        <title>Project Steward</title>
        ${getCustomStyle(infos.config)}
    </head>
    <body class="preload ${isSidebar ? 'steward-sidebar' : ''} ${!groups.length ? 'steward-empty' : ''} ${allGroupsCollapsed ? 'steward-all-collapsed' : ''}">
        <div class="steward-sticky-header">
            <div class="filter-wrapper">
                <div class="search-box">
                    <span class="search-icon">${Icons.search}</span>
                    <input type="search" id="filter" aria-label="Filter Projects">
                    <span id="clear" class="clear-search-icon">${Icons.remove}</span>
                </div>
                <button type="button" class="toggle-all-groups-button" data-action="toggle-all-groups" title="${allGroupsCollapsed ? 'Expand All Groups' : 'Collapse All Groups'}" aria-label="${allGroupsCollapsed ? 'Expand All Groups' : 'Collapse All Groups'}">
                    <span class="toggle-all-groups-collapse-icon">${Icons.collapseAll}</span>
                    <span class="toggle-all-groups-expand-icon">${Icons.expandAll}</span>
                </button>
                <button type="button" class="settings-button" data-action="open-settings" title="Project Steward Settings" aria-label="Project Steward Settings">
                    ${Icons.settings}
                </button>
            </div>
            <div class="dashboard-tab-list" role="tablist" aria-label="Project views">
                <button type="button" id="dashboard-tab-open-button" class="dashboard-tab-button active" role="tab" aria-selected="true" aria-controls="dashboard-tab-open" tabindex="0" data-dashboard-tab="open">OPEN</button>
                <button type="button" id="dashboard-tab-projects-button" class="dashboard-tab-button" role="tab" aria-selected="false" aria-controls="dashboard-tab-projects" tabindex="-1" data-dashboard-tab="projects">PROJECTS</button>
                <button type="button" id="dashboard-tab-todo-button" class="dashboard-tab-button" role="tab" aria-selected="false" aria-controls="dashboard-tab-todo" tabindex="-1" data-dashboard-tab="todo">TODO</button>
                <button type="button" id="dashboard-tab-ai-button" class="dashboard-tab-button" role="tab" aria-selected="false" aria-controls="dashboard-panel-ai" tabindex="-1" data-dashboard-tab="ai">AI</button>
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

        ${getProjectContextMenu()}
        ${getGroupContextMenu()}
        ${getAiSessionContextMenu()}
    </body>

    <script src="${fittyPath}"></script>
    <script src="${dragulaPath}"></script>
    <script src="${autoScrollerPath}"></script>
    <script src="${projectScriptsPath}"></script>
    <script src="${dashboardScriptsPath}"></script>
    <script src="${promptScriptsPath}"></script>
    <script src="${todoScriptsPath}"></script>
    <script src="${dndScriptsPath}"></script>
    <script src="${filterScriptsPath}"></script>

    <script>
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
                        if (window.__projectStewardDashboard) {
                            window.__projectStewardDashboard.replaceSearchCatalog(catalog);
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
                        window.__projectStewardSyncCollapseButton();
                    },
                    onTodoMounted: (panel, message) => {
                        todos.mount(panel, message.snapshot);
                        window.__projectStewardSyncCollapseButton('todo');
                    },
                    onActiveTabChanged: activeTab => window.__projectStewardSyncCollapseButton(activeTab),
                });
                window.__projectStewardDashboard = dashboard;
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
    return `
<div class="group steward-section open-current-workspace-group ${currentCard ? '' : 'no-projects'}" data-group-id="${OPEN_CURRENT_WORKSPACE_GROUP_ID}" data-virtual-group data-system-group="${OPEN_CURRENT_WORKSPACE_GROUP_ID}">
    <div class="group-title steward-section-header steward-group-header">
        <span class="group-title-text">${OPEN_CURRENT_WORKSPACE_GROUP_NAME}</span>
        <span class="group-title-badge">Live</span>
    </div>
    <div class="group-list">
        <div class="drop-signal"></div>
        ${currentCard ? getWorkspaceCardDiv(currentCard, runningCardAnimation, runningIconAnimation) : getOpenCurrentWorkspaceEmptyState(hasOtherWindows)}
    </div>
</div>`;
}

export function getOpenWorkspacesGroupContent(
    cards: WorkspaceCardViewModel[],
    collapsed: boolean,
    otherWindowsStatus: OpenWorkspaceBridgeStatus = 'ready',
    runningCardAnimation?: string,
    runningIconAnimation?: string,
): string {
    const current = (cards || []).find(card => card.kind === 'current') || null;
    const navigationCards = (cards || []).filter(card => card.kind === 'navigation');
    const currentSection = getCurrentWorkspaceGroupContent(
        current,
        navigationCards.length > 0,
        runningCardAnimation,
        runningIconAnimation,
    );
    if (!navigationCards.length && otherWindowsStatus === 'ready') {
        return currentSection;
    }
    const statusContent = otherWindowsStatus === 'update-required'
        ? `<div class="open-other-windows-state" role="status">
            <p>Update the Project Steward UI Bridge extension to restore OTHER WINDOWS.</p>
            <button type="button" class="project-action" data-action="open-bridge-extension">Show UI Bridge Extension</button>
        </div>`
        : otherWindowsStatus === 'unavailable'
            ? `<div class="open-other-windows-state" role="status">
                <p>OTHER WINDOWS is temporarily unavailable. Project Steward will retry automatically.</p>
            </div>`
            : navigationCards.map(card => getWorkspaceCardDiv(card, runningCardAnimation, runningIconAnimation)).join('\n');
    const otherWindowsCollapsed = otherWindowsStatus === 'ready' && collapsed;
    return `${currentSection}
<div class="group steward-section open-other-windows-group ${otherWindowsCollapsed ? 'collapsed' : ''}" data-group-id="${OPEN_WORKSPACES_GROUP_ID}" data-virtual-group data-system-group="${OPEN_WORKSPACES_GROUP_ID}" data-other-windows-status="${otherWindowsStatus}">
    <div class="group-title steward-section-header steward-group-header">
        <span class="group-title-text" data-action="collapse">
            <span class="collapse-icon" title="Open/Collapse Group">${Icons.collapse}</span>
            ${OPEN_OTHER_WINDOWS_GROUP_NAME}
        </span>
        <span class="group-title-badge">${otherWindowsStatus === 'update-required' ? 'Update required' : otherWindowsStatus === 'unavailable' ? 'Unavailable' : 'Live'}</span>
    </div>
    <div class="group-list">
        <div class="drop-signal"></div>
        ${statusContent}
    </div>
</div>`;
}

function getWorkspaceCardDiv(
    card: WorkspaceCardViewModel,
    runningCardAnimation?: string,
    runningIconAnimation?: string,
): string {
    const roots = card.roots.slice().sort((left, right) => left.ordinal - right.ordinal);
    const rootCount = roots.length;
    const compactWorkspaceName = rootCount === 1
        ? roots[0].name
        : removeWorkspaceWindowDecorations(card.name);
    const workspaceName = escapeAttribute(sanitizeProjectName(compactWorkspaceName) || 'Workspace');
    const environmentLabel = escapeAttribute(sanitizeProjectName(card.environmentLabel) || 'Local');
    const remoteType = getWorkspaceRemoteType(card.environment);
    const projectIcon = getProjectIcon(remoteType);
    const projectIconTitle = getProjectIconTitle(remoteType);
    const folderLabel = `${rootCount} folder${rootCount === 1 ? '' : 's'}`;
    const isCurrent = card.kind === 'current';
    const showSaveAction = isCurrent && card.showSaveAction;
    const saveBadge = showSaveAction
        ? `<span data-action="save-current-workspace" class="project-save-badge" title="Save Workspace" aria-label="Save Workspace">${Icons.save}</span>`
        : '';
    const aiSessions = isCurrent ? card.aiSessions : undefined;
    const runningSessionCount = isCurrent
        ? (aiSessions?.activeSessions || []).filter(session => session.executionState === 'running').length
        : card.runningSessionCount;
    const sessionFx = runningSessionCount > 0
        ? normalizeRunningCardAnimation(runningCardAnimation)
        : '';
    const runningTitle = runningSessionCount > 0
        ? `Workspace — ${runningSessionCount} active session${runningSessionCount === 1 ? '' : 's'} running`
        : '';
    const aiSessionCount = aiSessions?.aiSessionCount || 0;
    const activeSessionCount = aiSessions?.activeSessionCount || 0;
    const attentionCount = card.attentionCount || 0;
    const summaryParts = isCurrent ? [
        aiSessionCount ? `${aiSessionCount} AI session${aiSessionCount === 1 ? '' : 's'}` : '',
        activeSessionCount ? `${activeSessionCount} active AI session${activeSessionCount === 1 ? '' : 's'}` : '',
        attentionCount ? `${attentionCount} AI session${attentionCount === 1 ? ' needs' : 's need'} attention` : '',
    ].filter(Boolean) : [];
    const summaryLabel = escapeAttribute(summaryParts.join(', '));
    const currentSummaryBadge = summaryParts.length
        ? `<span class="project-codex-badge" data-ai-session-total-count="${aiSessionCount}" data-ai-session-active-count="${activeSessionCount}" data-ai-session-attention-count="${attentionCount}" title="${summaryLabel}" aria-label="${summaryLabel}">${
            aiSessionCount ? `<span class="ai-session-total-count">AI ${aiSessionCount}</span>` : ''
        }${activeSessionCount ? `<span class="ai-session-active-count" aria-label="${activeSessionCount} active AI session${activeSessionCount === 1 ? '' : 's'}">●${activeSessionCount}</span>` : ''
        }${attentionCount ? `<b class="ai-session-attention-count" aria-label="${attentionCount} AI session${attentionCount === 1 ? ' needs' : 's need'} attention">${attentionCount}</b>` : ''
        }</span>`
        : '';
    const navigationAttentionLabel = `${attentionCount} item${attentionCount === 1 ? '' : 's'} need${attentionCount === 1 ? 's' : ''} attention`;
    const navigationAttentionBadge = !isCurrent && attentionCount
        ? `<span class="project-ai-attention-badge" title="${navigationAttentionLabel}" aria-label="${navigationAttentionLabel}">${attentionCount}</span>`
        : '';
    const navigationRunningLabel = `${runningSessionCount} active AI session${runningSessionCount === 1 ? '' : 's'}`;
    const navigationRunningBadge = !isCurrent && runningSessionCount
        ? `<span class="project-codex-badge" data-ai-session-active-count="${runningSessionCount}" title="${navigationRunningLabel}" aria-label="${navigationRunningLabel}"><span class="ai-session-active-count" aria-label="${navigationRunningLabel}">●${runningSessionCount}</span></span>`
        : '';
    const badge = isCurrent
        ? currentSummaryBadge
        : `${navigationRunningBadge}${navigationAttentionBadge}`;
    const sessionSection = isCurrent
        ? getAiSessionsDiv(getWorkspaceAiSessionSurface(card), {
            showRootChips: rootCount > 1,
            runningIconAnimation,
        })
        : '';
    const colorStyles = getCardColorStyles(card.color);

    return `<div class="project-container" data-nodrag>
    <div class="workspace-card project steward-item-card${runningSessionCount > 0 ? ' session-running' : ''}" style="${colorStyles.cardStyle}" data-id="${escapeAttribute(card.id)}" data-name="${escapeAttribute(`${card.name || ''} ${card.environmentLabel || ''} ${roots.map(root => root.name).join(' ')}`.toLowerCase())}" data-workspace-card-kind="${card.kind}" data-workspace-navigation-identity="${escapeAttribute(card.navigationIdentity)}" data-workspace-scope-identity="${escapeAttribute(card.scopeIdentity)}" ${sessionFx ? `data-session-fx="${sessionFx}"` : ''}${runningTitle ? ` title="${runningTitle}"` : ''} ${isCurrent ? 'data-current-workspace' : 'data-workspace-navigation data-other-workspace'}${currentSummaryBadge || navigationRunningBadge ? ' data-has-ai-session-badge' : ''}${showSaveAction ? ' data-has-save-action' : ''} data-readonly-project${aiSessions?.expanded ? ' data-codex-expanded' : ''}>
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

function getWorkspaceAiSessionSurface(card: WorkspaceCardViewModel): AiSessionSurfaceViewModel {
    const aiSessions = card.aiSessions;
    if (!aiSessions) {
        return {
            id: card.id,
            activeAiSessionProvider: 'codex',
            selectedAiSessionProviders: ['codex'],
            providers: getLegacyAiSessionProviderSummaries({}),
            activeAiSessionTab: 'sessions',
            codexSessions: [],
            kimiSessions: [],
            claudeSessions: [],
            activeAiSessions: [],
        };
    }
    const unavailable = new Set(aiSessions.unavailableProviders || []);
    return {
        id: card.id,
        activeAiSessionProvider: aiSessions.activeProvider,
        selectedAiSessionProviders: aiSessions.selectedProviders,
        providers: aiSessions.providers,
        activeAiSessionTab: aiSessions.defaultTab,
        codexSessions: aiSessions.sessionsByProvider.codex || [],
        kimiSessions: aiSessions.sessionsByProvider.kimi || [],
        claudeSessions: aiSessions.sessionsByProvider.claude || [],
        codexSessionsUnavailable: unavailable.has('codex'),
        kimiSessionsUnavailable: unavailable.has('kimi'),
        claudeSessionsUnavailable: unavailable.has('claude'),
        activeAiSessions: aiSessions.activeSessions.slice(),
    };
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
        body {
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family);
            margin: 0;
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
        .toggle-all-groups-button {
            width: 30px;
            height: 30px;
            padding: 0;
            overflow: hidden;
        }
        .settings-button svg,
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

export function getAiSessionsDiv(project: AiSessionSurfaceViewModel, options: AiSessionRenderOptions = {}): string {
    var codexSessions = project.codexSessions || [];
    var kimiSessions = project.kimiSessions || [];
    var claudeSessions = project.claudeSessions || [];
    var activeProvider = getActiveAiSessionProvider(project);
    var selectedProviders = getSelectedAiSessionProviders(project, activeProvider);
    var activeSessions = project.activeAiSessions || [];
    var selectedTab: AiSessionTabId = project.activeAiSessionTab || (activeSessions.length ? 'active' : 'sessions');
    project = { ...project, activeAiSessionTab: selectedTab };
    var totalSessionCount = codexSessions.length + kimiSessions.length + claudeSessions.length;

    return `
<div class="codex-sessions" data-ai-session-region data-active-ai-session-provider="${escapeAttribute(activeProvider)}" data-selected-ai-session-tab="${selectedTab}" data-selected-ai-session-providers="${escapeAttribute(selectedProviders.join(','))}">
    <div class="ai-session-module-header">
        <span class="ai-session-module-title">AI SESSIONS</span>
        <span class="ai-session-create-actions">
            <button type="button" class="ai-session-create-button" data-action="create-ai-session" aria-label="New AI Session" title="New AI Session"><span aria-hidden="true">+</span><span>NEW</span></button>
        </span>
    </div>
    <div class="ai-session-tabs" role="tablist" aria-label="AI Session views">
        ${getAiSessionTabButton(project, 'active', activeSessions.length)}
        ${getAiSessionTabButton(project, 'sessions', totalSessionCount)}
    </div>
    ${getActiveAiSessionPanel(project, activeSessions, options)}
    ${getAiSessionHistoryPanel(project, activeProvider, selectedProviders, options)}
    <div class="ai-session-live-region" data-ai-session-live-region aria-live="polite" aria-atomic="true"></div>
</div>`;
}

function getAiSessionTabButton(project: AiSessionSurfaceViewModel, tab: AiSessionTabId, count: number): string {
    var projectId = escapeAttribute(project.id || 'project');
    var selected = project.activeAiSessionTab === tab;
    var isActiveTab = tab === 'active';
    var tabId = `ai-session-${tab}-tab-${projectId}`;
    var panelId = isActiveTab ? `ai-session-active-${projectId}` : `ai-session-history-${projectId}`;
    var attentionCount = isActiveTab
        ? (project.activeAiSessions || []).filter(session => session.needsAttention).length
        : 0;
    var attentionDot = attentionCount
        ? `<span class="ai-session-tab-attention" aria-label="${attentionCount} active AI session${attentionCount === 1 ? ' needs' : 's need'} attention"></span>`
        : '';
    return `<button type="button" id="${tabId}" role="tab" data-action="select-ai-session-tab" data-tab="${tab}" data-ai-session-tab="${tab}" aria-selected="${selected}" aria-controls="${panelId}" tabindex="${selected ? '0' : '-1'}"><span>${isActiveTab ? 'ACTIVE' : 'SESSIONS'}</span><span class="ai-session-tab-count">${count}</span>${attentionDot}</button>`;
}

function getActiveAiSessionPanel(
    project: AiSessionSurfaceViewModel,
    sessions: ActiveAiSessionViewModel[],
    options: AiSessionRenderOptions
): string {
    var projectId = escapeAttribute(project.id || 'project');
    var selected = project.activeAiSessionTab === 'active';
    var rows = sessions.length
        ? sessions.map(session => getActiveAiSessionRow(
            session,
            options.showRootChips,
            options.runningIconAnimation,
        )).join('\n')
        : `<div class="codex-sessions-empty ai-session-active-empty">
            <strong>No active sessions</strong>
            <span>Start a new AI session or open one from Sessions.</span>
            <span class="ai-session-empty-actions">
                <button type="button" data-action="create-ai-session">New Session</button>
                <button type="button" data-action="select-ai-session-tab" data-tab="sessions">View Sessions</button>
            </span>
        </div>`;
    return `<div id="ai-session-active-${projectId}" class="ai-session-tab-panel ai-session-active-panel" role="tabpanel" data-ai-session-panel="active" aria-labelledby="ai-session-active-tab-${projectId}"${selected ? '' : ' hidden'}>
        <div class="codex-sessions-list">${rows}</div>
    </div>`;
}

function getAiSessionHistoryPanel(
    project: AiSessionSurfaceViewModel,
    activeProvider: AiSessionProviderId,
    selectedProviders: readonly AiSessionProviderId[],
    options: AiSessionRenderOptions
): string {
    var projectId = escapeAttribute(project.id || 'project');
    var selected = project.activeAiSessionTab === 'sessions';
    var codexSessions = project.codexSessions || [];
    var kimiSessions = project.kimiSessions || [];
    var claudeSessions = project.claudeSessions || [];
    var providers = project.providers || getLegacyAiSessionProviderSummaries(project);
    var providersById = new Map(providers.map(provider => [provider.id, provider]));
    var projection = projectAiSessionHistory(selectedProviders, {
        codex: codexSessions.map(session => ({ ...session, provider: 'codex' })),
        kimi: kimiSessions.map(session => ({ ...session, provider: 'kimi' })),
        claude: claudeSessions.map(session => ({ ...session, provider: 'claude' })),
    });
    var historyRows = (sessions: AiSessionViewModel[]) => sessions.map(session => getCodexSessionRow(
            session,
            session.provider,
            (project.activeAiSessions || []).find(runtime =>
                runtime.provider === session.provider && runtime.sessionId === session.id),
            options.showRootChips
        )).join('\n');
    var selectedProviderSummaries = selectedProviders.map(provider => providersById.get(provider)).filter(
        (provider): provider is AiSessionProviderSummary => !!provider
    );
    var providerMenuId = `ai-session-provider-menu-${projectId}`;
    var unavailableProviderLabels = selectedProviderSummaries
        .filter(provider => provider.unavailable === true)
        .map(provider => escapeAttribute(provider.label));
    var availabilitySummary = unavailableProviderLabels.length
        ? `<div class="ai-session-availability-summary" role="status">History unavailable: ${unavailableProviderLabels.join(', ')}.</div>`
        : '';
    var sessionRows = projection.pinned.length || projection.unpinned.length
        ? `${projection.pinned.length ? `<div class="ai-session-pinned-heading">PINNED</div>${historyRows(projection.pinned)}` : ''}${historyRows(projection.unpinned)}`
        : '<div class="codex-sessions-empty"><span>No selected AI sessions yet</span></div>';

    return `<div id="ai-session-history-${projectId}" class="ai-session-tab-panel ai-session-history-panel" role="tabpanel" data-ai-session-panel="sessions" aria-labelledby="ai-session-sessions-tab-${projectId}"${selected ? '' : ' hidden'}>
    <div class="ai-session-provider-controls">
        <div class="ai-session-provider-menu-wrapper">
            <button type="button" class="ai-session-provider-menu-trigger" data-ai-provider-menu-trigger aria-haspopup="menu" aria-expanded="false" aria-controls="${providerMenuId}" aria-label="Select AI providers">${getAiProviderSelectionSummary(selectedProviders, providersById)}</button>
            <div id="${providerMenuId}" class="ai-session-provider-menu" data-ai-provider-menu role="menu" aria-label="AI providers" hidden>
                ${providers.map(provider => getAiProviderOption(provider, selectedProviders)).join('\n')}
            </div>
        </div>
        ${getManageAiSessionsButton(activeProvider)}
    </div>
    ${availabilitySummary}
    <div class="codex-sessions-list">
        ${sessionRows}
    </div>
    <div class="ai-session-batch-actions" aria-live="polite">
        <div class="ai-session-batch-selection-actions">
            <button type="button" data-action="select-unpinned-ai-sessions" title="Select all unpinned sessions" aria-label="Select all unpinned sessions">All</button>
            <button type="button" data-action="clear-ai-session-selection">Clear</button>
        </div>
        <span class="ai-session-batch-count">0 selected</span>
        <div class="ai-session-batch-submit-actions">
            <button type="button" class="ai-session-batch-archive" data-action="archive-selected-ai-sessions" disabled>Archive</button>
        </div>
    </div>
</div>`;
}

function getAiProviderSelectionSummary(
    selectedProviders: readonly AiSessionProviderId[],
    providersById: ReadonlyMap<AiSessionProviderId, AiSessionProviderSummary>,
): string {
    if (selectedProviders.length >= 3) {
        return `${selectedProviders.length} providers`;
    }

    return selectedProviders.map(provider => providersById.get(provider)?.label || getAiProviderLabel(provider)).join(' + ');
}

function getAiProviderOption(
    provider: AiSessionProviderSummary,
    selectedProviders: readonly AiSessionProviderId[],
): string {
    const selected = selectedProviders.includes(provider.id);
    const unavailable = provider.unavailable === true;
    return `<button type="button" role="menuitemcheckbox"
        class="ai-session-provider-option"
        data-ai-provider-option data-provider="${provider.id}"
        aria-checked="${selected}"
        aria-disabled="${selected && selectedProviders.length === 1}"
        ${unavailable ? 'data-provider-unavailable' : ''}>
        <span class="ai-session-provider-check" aria-hidden="true">${selected ? '✓' : ''}</span>
        <span>${escapeAttribute(provider.label)}</span>
        <span class="ai-session-provider-count">${provider.count}</span>
        ${unavailable ? '<span class="ai-session-provider-unavailable">Unavailable</span>' : ''}
    </button>`;
}

function getManageAiSessionsButton(activeProvider: AiSessionProviderId): string {
    var label = `Manage ${getAiProviderLabel(activeProvider)} Sessions`;
    return `<button type="button" class="ai-session-manage-button" data-action="manage-ai-sessions" data-provider="${activeProvider}" title="${label}" aria-label="${label}" aria-pressed="false">${Icons.manage}</button>`;
}

function getActiveAiSessionProvider(project: AiSessionSurfaceViewModel): AiSessionProviderId {
    if (isAiProvider(project.activeAiSessionProvider)) {
        return project.activeAiSessionProvider;
    }

    if (!(project.codexSessions || []).length && (project.kimiSessions || []).length) {
        return 'kimi';
    }

    if (!(project.codexSessions || []).length && !(project.kimiSessions || []).length && (project.claudeSessions || []).length) {
        return 'claude';
    }

    return 'codex';
}

function getSelectedAiSessionProviders(
    project: AiSessionSurfaceViewModel,
    activeProvider: AiSessionProviderId,
): AiSessionProviderId[] {
    const selected: AiSessionProviderId[] = [];
    for (const provider of project.selectedAiSessionProviders || [activeProvider]) {
        if (isAiProvider(provider) && !selected.includes(provider)) {
            selected.push(provider);
        }
    }
    return selected.length ? selected : [activeProvider];
}

function getLegacyAiSessionProviderSummaries(project: Pick<AiSessionSurfaceViewModel,
    'codexSessions' | 'kimiSessions' | 'claudeSessions' |
    'codexSessionsUnavailable' | 'kimiSessionsUnavailable' | 'claudeSessionsUnavailable'>
): AiSessionProviderSummary[] {
    return [
        { id: 'codex', label: 'Codex', count: (project.codexSessions || []).length, unavailable: project.codexSessionsUnavailable },
        { id: 'kimi', label: 'Kimi', count: (project.kimiSessions || []).length, unavailable: project.kimiSessionsUnavailable },
        { id: 'claude', label: 'Claude', count: (project.claudeSessions || []).length, unavailable: project.claudeSessionsUnavailable },
    ];
}

function isAiProvider(providerId: string): providerId is AiSessionProviderId {
    return providerId === 'codex' || providerId === 'kimi' || providerId === 'claude';
}

function getAiProviderLabel(providerId: AiSessionProviderId): string {
    switch (providerId) {
        case 'kimi':
            return 'Kimi';
        case 'claude':
            return 'Claude';
        default:
            return 'Codex';
    }
}

function getCodexSessionRow(
    session: RootLabeledAiSession,
    provider: AiSessionProviderId,
    runtime?: ActiveAiSessionViewModel,
    showRootChip: boolean = false
) {
    var sessionName = escapeAttribute(sanitizeProjectName(session.name || session.id));
    var sessionId = escapeAttribute(session.id || '');
    var shortSessionId = escapeAttribute((session.id || '').substring(0, 8));
    var updatedAt = escapeAttribute(formatCodexSessionUpdatedAt(session.updatedAt));
    var shortId = shortSessionId ? `#${shortSessionId}` : '';
    var staleStatus = runtime?.stale
        ? '<span class="ai-session-stale-status" title="Runtime status is stale">stale</span>'
        : '';
    var metadata = [staleStatus, updatedAt, shortId].filter(value => !!value).join(' · ');
    var providerLabel = getAiProviderLabel(provider);
    var pinned = !!session.pinned;
    var needsAttention = !!session.attention?.unread;
    var attentionIndicator = needsAttention
        ? '<span class="ai-session-attention-indicator" title="AI session needs attention" aria-label="AI session needs attention"></span>'
        : '';
    var pinTitle = pinned ? 'Unpin Session' : 'Pin Session';
    var active = session.active === true;
    var backend = runtime?.backend || 'vscode';
    var attached = runtime?.attached ?? (active && backend === 'vscode');
    var conflict = runtime?.conflict === true;
    var runtimeAttributes = ` data-session-backend="${backend}" data-session-attached="${attached ? 'true' : 'false'}"${runtime?.tmuxLayout ? ` data-tmux-layout="${runtime.tmuxLayout}"` : ''}${runtime?.conflict ? ' data-session-conflict' : ''}${runtime?.stale ? ' data-session-stale' : ''}`;
    var batchCheckbox = `<input type="checkbox" class="ai-session-batch-checkbox" aria-label="Select ${sessionName}"${active ? ' disabled' : ''}>`;
    var pinAction = `<button type="button" class="codex-session-pin ${pinned ? 'active' : ''}" data-action="toggle-ai-session-pin" title="${pinTitle}" aria-label="${pinTitle}">${Icons.pin}</button>`;
    var archiveAction = active
        ? `<button type="button" class="codex-session-archive" disabled title="Stop the active runtime before archiving." aria-label="Stop the active runtime before archiving.">${Icons.archive}</button>`
        : `<button type="button" class="codex-session-archive" data-action="archive-${provider}-session" title="Archive Session" aria-label="Archive Session">${Icons.archive}</button>`;
    var activeStatus = active ? '<span class="ai-session-history-active-status">Active</span>' : '';
    var primaryAction = conflict ? 'Choose runtime'
        : active && backend === 'tmux' && !attached ? 'Attach or focus'
            : active ? 'Focus' : 'Resume';
    var runtimeDescription = conflict ? 'runtime conflict'
        : backend === 'tmux'
            ? `tmux ${runtime?.tmuxLayout || 'unknown'} layout, ${attached ? 'attached' : 'detached'}`
            : `Direct VS Code terminal${active ? `, ${attached ? 'attached' : 'detached'}` : ''}`;
    var primaryAriaLabel = conflict
        ? `Choose runtime for ${providerLabel} session ${sessionName}, runtime conflict`
        : `${primaryAction} ${providerLabel} session ${sessionName} using ${runtimeDescription}`;
    if (runtime?.stale) {
        primaryAriaLabel += ', runtime status is stale';
    }
    var primaryRootId = session.primaryRootId || runtime?.primaryRootId || '';
    var primaryRootLabel = session.primaryRootLabel || runtime?.primaryRootLabel || '';
    var rootAttributes = showRootChip && primaryRootId
        ? ` data-primary-root-id="${escapeAttribute(primaryRootId)}"`
        : '';
    var rootChip = showRootChip && primaryRootLabel
        ? `<span class="ai-session-root-chip">${escapeAttribute(sanitizeProjectName(primaryRootLabel))}</span>`
        : '';
    var providerBadge = `<span class="ai-session-provider-badge">${providerLabel}</span>`;

    return `
<div class="codex-session-row" role="group" aria-label="${providerLabel} session ${sessionName}"${runtimeAttributes}${rootAttributes}${pinned ? ' data-session-pinned' : ''}${active ? ' data-session-active' : ''}${needsAttention ? ' data-ai-session-attention data-session-event-id="' + escapeAttribute(session.attention.eventId) + '"' : ''} data-session-id="${sessionId}" data-session-provider="${provider}">
    ${batchCheckbox}
    <button type="button" class="ai-session-primary-action" data-action="activate-ai-session" aria-label="${primaryAriaLabel}" title="${primaryAction} ${providerLabel} Session">
        ${attentionIndicator}
        <span class="codex-session-icon">${Icons.terminalLine}</span>
        <span class="codex-session-text">
            <span class="codex-session-title-line"><span class="codex-session-name">${sessionName}</span>${providerBadge}${rootChip}</span>
            <span class="codex-session-meta">${activeStatus}${active && metadata ? ' · ' : ''}${metadata}</span>
        </span>
    </button>
    <span class="codex-session-actions">
        ${pinAction}
        ${archiveAction}
    </span>
</div>`;
}

function getActiveAiSessionRow(
    model: ActiveAiSessionViewModel,
    showRootChip: boolean = false,
    runningIconAnimation?: string,
): string {
    var providerLabel = getAiProviderLabel(model.provider);
    var sessionName = escapeAttribute(sanitizeProjectName(model.name || model.sessionId || `New ${providerLabel} session`));
    var sessionId = escapeAttribute(model.sessionId || '');
    var shortSessionId = sessionId ? `#${escapeAttribute(sessionId.substring(0, 8))}` : '';
    var createdAt = escapeAttribute(formatCodexSessionUpdatedAt(model.updatedAt || model.createdAt));
    var executionLabel = model.executionState === 'running' ? 'Running'
        : model.executionState === 'starting' ? 'Starting'
            : 'Stopped';
    var executionAriaLabel = model.executionState === 'running' ? 'AI is currently executing'
        : model.executionState === 'starting' ? 'Waiting for AI activity'
            : 'AI is not currently executing';
    var iconFx = model.executionState === 'running'
        ? normalizeRunningIconAnimation(runningIconAnimation)
        : '';
    var executionStatus = `<span class="ai-session-execution-status" aria-label="${executionAriaLabel}"><span class="ai-session-execution-dot" aria-hidden="true"></span>${executionLabel}</span>`;
    var runtimeStatusLabel = model.status === 'conflict' || model.conflict ? 'Runtime conflict' : '';
    var runtimeBadgeDescription = model.backend === 'tmux'
        ? 'Managed tmux runtime'
        : 'Direct VS Code terminal';
    var runtimeBadge = `<span class="ai-session-runtime-badge" title="${runtimeBadgeDescription}" aria-label="${runtimeBadgeDescription}">${model.backend}</span>`;
    var staleStatus = model.stale
        ? '<span class="ai-session-stale-status" title="Runtime status is stale">stale</span>'
        : '';
    var metadata = [executionStatus, staleStatus, runtimeStatusLabel, createdAt, shortSessionId].filter(Boolean).join(' · ');
    var attentionIndicator = model.needsAttention
        ? '<span class="ai-session-attention-indicator" title="AI session needs attention" aria-label="AI session needs attention"></span>'
        : '';
    var pinTitle = model.pinned ? 'Unpin Session' : 'Pin Session';
    var pinAction = model.pending
        ? ''
        : `<button type="button" class="codex-session-pin ${model.pinned ? 'active' : ''}" data-action="toggle-ai-session-pin" title="${pinTitle}" aria-label="${pinTitle}">${Icons.pin}</button>`;
    var conflict = model.status === 'conflict' || model.conflict === true;
    var terminalAction = conflict ? '' : model.backend === 'tmux'
        ? `<button type="button" class="ai-session-close-terminal ai-session-detach-terminal" data-action="detach-ai-session-terminal" title="Detach Terminal… The AI task keeps running in tmux." aria-label="Detach Terminal">${Icons.remove}</button>`
        : `<button type="button" class="ai-session-close-terminal" data-action="close-ai-session-terminal" title="Close Terminal…" aria-label="Close Terminal">${Icons.remove}</button>`;
    var pendingAttributes = model.pending
        ? ` data-session-pending data-pending-created-at="${escapeAttribute(model.createdAt || '')}"`
        : ` data-session-active data-session-id="${sessionId}"`;
    var attentionAttributes = model.needsAttention && model.attentionEventId
        ? ` data-ai-session-attention data-session-event-id="${escapeAttribute(model.attentionEventId)}"`
        : '';
    var runtimeAttributes = ` data-session-backend="${model.backend}" data-session-attached="${model.attached ? 'true' : 'false'}"${model.tmuxLayout ? ` data-tmux-layout="${model.tmuxLayout}"` : ''}${model.conflict ? ' data-session-conflict' : ''}${model.stale ? ' data-session-stale' : ''}`;
    var rowAction = model.backend === 'tmux'
        ? (model.attached ? 'Focus' : 'Attach or focus')
        : 'Focus';
    var primaryAction = conflict ? 'Choose runtime' : model.pending ? 'Focus pending' : rowAction;
    var runtimeDescription = conflict ? 'runtime conflict'
        : model.backend === 'tmux'
            ? `tmux ${model.tmuxLayout || 'unknown'} layout, ${model.attached ? 'attached' : 'detached'}`
            : `Direct VS Code terminal, ${model.attached ? 'attached' : 'detached'}`;
    var primaryAriaLabel = conflict
        ? `Choose runtime for ${providerLabel} session ${sessionName}, runtime conflict`
        : `${primaryAction} ${providerLabel} session ${sessionName} using ${runtimeDescription}`;
    if (model.stale) {
        primaryAriaLabel += ', runtime status is stale';
    }
    var rootAttributes = showRootChip && model.primaryRootId
        ? ` data-primary-root-id="${escapeAttribute(model.primaryRootId)}"`
        : '';
    var rootChip = showRootChip && model.primaryRootLabel
        ? `<span class="ai-session-root-chip">${escapeAttribute(sanitizeProjectName(model.primaryRootLabel))}</span>`
        : '';
    return `<div class="codex-session-row active-ai-session-row" role="group" aria-label="${providerLabel} session ${sessionName}" data-session-provider="${model.provider}" data-execution-state="${model.executionState}"${iconFx ? ` data-session-icon-fx="${iconFx}"` : ''}${runtimeAttributes}${rootAttributes}${pendingAttributes}${model.pinned ? ' data-session-pinned' : ''}${model.focused ? ' data-session-focused' : ''}${model.needsAttention ? ' data-session-needs-attention' : ''}${attentionAttributes}>
        <button type="button" class="ai-session-primary-action" data-action="activate-ai-session" aria-label="${primaryAriaLabel}" title="${primaryAction} ${providerLabel} Session">
            ${attentionIndicator}
            <span class="codex-session-icon">${Icons.terminalLine}</span>
            <span class="codex-session-text">
                <span class="codex-session-title-line">${runtimeBadge}<span class="codex-session-name">${sessionName}</span>${rootChip}</span>
                <span class="codex-session-meta">${metadata}</span>
            </span>
        </button>
        <span class="codex-session-actions">${pinAction}${terminalAction}</span>
    </div>`;
}

function formatCodexSessionUpdatedAt(updatedAt: string): string {
    if (!updatedAt) {
        return '';
    }

    let date = new Date(updatedAt);
    if (isNaN(date.getTime())) {
        return '';
    }

    return date.toISOString().substring(0, 10);
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

function escapeAttribute(value: string): string {
    return (value || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
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
        Project Steward is empty, but there are projects in your other storage.
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

function getAiSessionContextMenu() {
    return `
<div id="aiSessionContextMenu" class="custom-context-menu" role="menu" aria-label="AI Session actions">
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="resume">
        Focus / Resume Chat
    </div>
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="rename">
        Rename Chat
    </div>
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="copy-id">
        Copy Chat ID
    </div>

    <div class="custom-context-menu-separator" role="separator"></div>

    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="pin">
        Pin / Unpin Chat
    </div>
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="close-terminal">
        Close Terminal…
    </div>
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="archive">
        Archive Chat
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

function getCustomStyle(config: vscode.WorkspaceConfiguration) {
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
        --steward-ai-session-list-max-height: ${getAiSessionListMaxHeight(config)}px;
    }
</style>`;
}

function getAiSessionListMaxHeight(config: vscode.WorkspaceConfiguration): number {
    var visibleRows = getMaxVisibleAiSessions(config);
    return visibleRows * 42 + Math.max(visibleRows - 1, 0) * 2;
}

function getMaxVisibleAiSessions(config: vscode.WorkspaceConfiguration): number {
    var configuredRows = config.get('maxVisibleAiSessions', 3);
    var visibleRows = Math.floor(Number(configuredRows));
    return Number.isFinite(visibleRows) && visibleRows > 0 ? visibleRows : 3;
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
