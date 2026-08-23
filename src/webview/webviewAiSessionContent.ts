import {
    CodexSession,
    WorkspaceCardViewModel,
    AiSessionProviderId,
    sanitizeProjectName,
} from '../models';
import * as Icons from '../webviewIcons';
import type {
    ActiveAiSessionViewModel,
    AiSessionProviderSummary,
    AiSessionTabId,
    AiSessionViewModel,
    ReadyWorktreeRow,
    WorktreeAnchorViewModel,
    WorktreeGroupMemberStatus,
    WorktreeGroupRowViewModel,
    WorktreeRowViewModel,
} from '../aiSessions/types';
import { worktreeKeysMatch } from '../worktrees';
import type { ProvisioningWorktreeRow, WorktreeKey } from '../worktrees';
import { projectAiSessionHistory } from '../aiSessions/historyProjection';
import { escapeAttribute } from '../webviewHtmlEscape';
import {
    normalizeRunningCardAnimation,
    normalizeRunningIconAnimation,
} from './runningAnimationImages';

export {
    normalizeRunningCardAnimation,
    normalizeRunningIconAnimation,
} from './runningAnimationImages';

export interface AiSessionRenderOptions {
    showRootChips?: boolean;
    runningIconAnimation?: string;
}

export interface RootLabeledAiSession extends CodexSession {
    primaryRootId?: string;
    primaryRootLabel?: string;
    profile?: string;
    profileUnavailable?: boolean;
    worktreeKey?: WorktreeKey;
    /** The session's worktree is gone or unhealthy; resume is blocked. */
    worktreeUnavailable?: boolean;
}

function getAiSessionProfileBadge(
    profile: string | undefined,
    profileUnavailable: boolean | undefined
): string {
    if (!profile) {
        return '';
    }
    var escapedProfile = escapeAttribute(profile);
    var tooltip = getAiSessionProfileTooltip(profile, profileUnavailable);
    return `<span class="ai-session-profile-badge${profileUnavailable ? ' ai-session-profile-unavailable' : ''}" data-tooltip="${tooltip}" aria-label="${tooltip}">${escapedProfile}${profileUnavailable ? ' · unavailable' : ''}</span>`;
}

function getAiSessionProfileTooltip(
    profile: string | undefined,
    profileUnavailable: boolean | undefined
): string {
    return `Profile: ${profile ? escapeAttribute(profile) : 'default'}${profileUnavailable ? ' (unavailable)' : ''}`;
}

export interface AiSessionSurfaceViewModel {
    id: string;
    activeAiSessionProvider?: AiSessionProviderId;
    selectedAiSessionProviders?: AiSessionProviderId[];
    providers?: AiSessionProviderSummary[];
    activeAiSessionTab?: AiSessionTabId;
    /** M2 window view state (CHATS/ALL tab + CHATS view mode + collapsed groups). */
    windowViewState?: import('../aiSessions/workspaceStateStore').AiSessionWindowViewState;
    codexSessions?: RootLabeledAiSession[];
    kimiSessions?: RootLabeledAiSession[];
    claudeSessions?: RootLabeledAiSession[];
    codexSessionsUnavailable?: boolean;
    kimiSessionsUnavailable?: boolean;
    claudeSessionsUnavailable?: boolean;
    activeAiSessions?: ActiveAiSessionViewModel[];
    /** The Codex profile a picker-free quick-create would launch with, when any. */
    quickCreateProfile?: string;
    /** The provider quick-create remembers for this workspace, when any. */
    quickCreateProvider?: AiSessionProviderId;
    worktrees?: WorktreeRowViewModel[];
    /** Collapsed main-checkout anchor row (PRD §4). */
    worktreeAnchor?: WorktreeAnchorViewModel;
    /** Manifest-backed worktree group rows (authoritative grouping). */
    worktreeGroups?: WorktreeGroupRowViewModel[];
    /** Adopt suggestions: unmanaged worktrees clustered by task slug (PRD §6.5). */
    worktreeAdoptSuggestions?: {
        slug: string;
        members: {
            worktreeKey: WorktreeKey;
            branchName: string;
            repositoryLabel: string;
        }[];
    }[];
    worktreeSnapshotRevision?: number;
    worktreeRepositoryCount?: number;
    bareWorktreeCount?: number;
    truncatedWorktreeCount?: number;
}

export function getWorkspaceAiSessionSurface(card: WorkspaceCardViewModel): AiSessionSurfaceViewModel {
    const aiSessions = card.aiSessions;
    if (!aiSessions) {
        return {
            id: card.id,
            activeAiSessionProvider: 'codex',
            selectedAiSessionProviders: ['codex'],
            providers: getLegacyAiSessionProviderSummaries({}),
            activeAiSessionTab: 'chats',
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
        ...(aiSessions.windowViewState
            ? { windowViewState: aiSessions.windowViewState }
            : {}),
        codexSessions: aiSessions.sessionsByProvider.codex || [],
        kimiSessions: aiSessions.sessionsByProvider.kimi || [],
        claudeSessions: aiSessions.sessionsByProvider.claude || [],
        codexSessionsUnavailable: unavailable.has('codex'),
        kimiSessionsUnavailable: unavailable.has('kimi'),
        claudeSessionsUnavailable: unavailable.has('claude'),
        activeAiSessions: aiSessions.activeSessions.slice(),
        worktrees: (aiSessions.worktrees || []).slice(),
        ...(aiSessions.worktreeAnchor ? { worktreeAnchor: aiSessions.worktreeAnchor } : {}),
        ...(aiSessions.worktreeGroups
            ? { worktreeGroups: aiSessions.worktreeGroups.slice() }
            : {}),
        ...(aiSessions.worktreeAdoptSuggestions
            ? {
                worktreeAdoptSuggestions: aiSessions.worktreeAdoptSuggestions
                    .map(suggestion => ({
                        slug: suggestion.slug,
                        members: suggestion.members.map(member => ({
                            worktreeKey: { ...member.worktreeKey },
                            branchName: member.branchName,
                            repositoryLabel: member.repositoryLabel,
                        })),
                    })),
            }
            : {}),
        worktreeSnapshotRevision: aiSessions.worktreeSnapshotRevision,
        worktreeRepositoryCount: aiSessions.worktreeRepositoryCount,
        bareWorktreeCount: aiSessions.bareWorktreeCount,
        truncatedWorktreeCount: aiSessions.truncatedWorktreeCount,
        ...(aiSessions.quickCreateProfile
            ? { quickCreateProfile: aiSessions.quickCreateProfile }
            : {}),
        ...(aiSessions.quickCreateProvider
            ? { quickCreateProvider: aiSessions.quickCreateProvider }
            : {}),
    };
}

export function getAiSessionsDiv(project: AiSessionSurfaceViewModel, options: AiSessionRenderOptions = {}): string {
    var codexSessions = project.codexSessions || [];
    var kimiSessions = project.kimiSessions || [];
    var claudeSessions = project.claudeSessions || [];
    var activeProvider = getActiveAiSessionProvider(project);
    var selectedProviders = getSelectedAiSessionProviders(project, activeProvider);
    var activeSessions = project.activeAiSessions || [];
    // M2: the host-persisted window view state owns the CHATS/ALL selection
    // (PR-C); legacy/pre-persistence values map onto the new domain so stale
    // fixtures and in-flight states never render an unknown tab.
    var rawTab = project.windowViewState?.tab || project.activeAiSessionTab;
    var selectedTab: AiSessionTabId = rawTab === 'all' || (rawTab as string) === 'sessions'
        ? 'all'
        : 'chats';
    var chatsViewMode = project.windowViewState?.chatsViewMode === 'list' ? 'list' : 'tree';
    project = { ...project, activeAiSessionTab: selectedTab };
    var totalSessionCount = codexSessions.length + kimiSessions.length + claudeSessions.length;
    var quickCreateProvider = isAiProvider(project.quickCreateProvider)
        ? project.quickCreateProvider
        : activeProvider;
    var quickCreateProviderLabel = getAiProviderLabel(quickCreateProvider);
    var quickCreateProfile = quickCreateProvider === 'codex' && project.quickCreateProfile
        ? project.quickCreateProfile
        : '';
    var quickCreateActionLabel = quickCreateProfile
        ? `New ${quickCreateProviderLabel} session with profile ${quickCreateProfile}`
        : `New ${quickCreateProviderLabel} session`;
    var provisioningWorktrees = getProvisioningWorktrees(project.worktrees);

    return `
<div class="codex-sessions" data-ai-session-region data-active-ai-session-provider="${escapeAttribute(activeProvider)}" data-selected-ai-session-tab="${selectedTab}" data-chats-view-mode="${chatsViewMode}" data-selected-ai-session-providers="${escapeAttribute(selectedProviders.join(','))}">
    <div class="ai-session-chats-toolbar">
        <div class="ai-session-tabs" role="tablist" aria-label="Chat views">
            ${getChatsViewTabButton(project, activeSessions)}
            ${getAllSessionsTabButton(project, totalSessionCount)}
        </div>
        <div class="ai-session-surface-actions ai-session-chats-actions">
            <span class="ai-session-create-split-button">
                <button type="button" class="ai-session-create-quick-button" data-action="create-ai-session-quick" data-provider="${escapeAttribute(quickCreateProvider)}" aria-label="${escapeAttribute(quickCreateActionLabel)}" data-tooltip="${escapeAttribute(quickCreateActionLabel)}"><span class="codex-session-icon ai-session-create-icon">${getAiProviderIcon(quickCreateProvider)}</span></button>
                <button type="button" class="ai-session-create-dropdown-button" data-action="create-ai-session-dropdown" aria-label="More create options" data-tooltip="More create options" aria-haspopup="menu" aria-expanded="false" aria-controls="aiSessionCreateDropdown"><span class="ai-session-dropdown-arrow">&#9662;</span></button>
            </span>
        </div>
    </div>
    ${chatsViewMode === 'list'
        ? getChatsListPanel(project, options)
        : getChatsTreePanel(project, selectedProviders, options, quickCreateProvider, quickCreateProfile, provisioningWorktrees)}
    ${getAllSessionsPanel(project, activeProvider, selectedProviders, options)}
    <div class="ai-session-live-region" data-ai-session-live-region aria-live="polite" aria-atomic="true"></div>
</div>`;
}

// CHATS tab + ▾ view-menu trigger: two adjacent independent controls (PRD DOM
// 结构约束：菜单按钮不得嵌在 tab 内)。菜单本体见 getChatsViewMenu。
function getChatsViewTabButton(
    project: AiSessionSurfaceViewModel,
    activeSessions: readonly ActiveAiSessionViewModel[],
): string {
    var projectId = escapeAttribute(project.id || 'project');
    var selected = project.activeAiSessionTab === 'chats';
    var attentionCount = activeSessions.filter(session => session.needsAttention).length;
    var attentionDot = attentionCount
        ? `<span class="ai-session-tab-attention" aria-label="${attentionCount} active AI session${attentionCount === 1 ? ' needs' : 's need'} attention"></span>`
        : '';
    return `<span class="ai-session-tab-pair">`
        + `<button type="button" id="ai-session-chats-tab-${projectId}" role="tab" data-action="select-ai-session-tab" data-tab="chats" data-ai-session-tab="chats" aria-selected="${selected}" aria-controls="ai-session-chats-${projectId}" tabindex="${selected ? '0' : '-1'}"><span>CHATS</span><span class="ai-session-tab-count">${activeSessions.length}</span>${attentionDot}</button>`
        + `<button type="button" class="ai-session-view-menu-trigger" data-action="toggle-chats-view-menu" aria-haspopup="menu" aria-expanded="false" aria-controls="ai-session-chats-view-menu-${projectId}" aria-label="Change CHATS view" data-tooltip="Change CHATS view">&#9662;</button>`
        + getChatsViewMenu(project)
        + `</span>`;
}

function getAllSessionsTabButton(project: AiSessionSurfaceViewModel, totalSessionCount: number): string {
    var projectId = escapeAttribute(project.id || 'project');
    var selected = project.activeAiSessionTab === 'all';
    // ALL ⊇ CHATS：计数含 active 子集；tooltip 承载这一语义（PRD 命名决策）。
    return `<button type="button" id="ai-session-all-tab-${projectId}" role="tab" data-action="select-ai-session-tab" data-tab="all" data-ai-session-tab="all" aria-selected="${selected}" aria-controls="ai-session-all-${projectId}" tabindex="${selected ? '0' : '-1'}" title="All sessions, including active ones"><span>ALL</span><span class="ai-session-tab-count">${totalSessionCount}</span></button>`;
}

// CHATS ▾ 视图菜单（M2 壳）：tree 是当前唯一视图；View as List 随 M3 到达。
function getChatsViewMenu(project: AiSessionSurfaceViewModel): string {
    var projectId = escapeAttribute(project.id || 'project');
    var viewMode = project.windowViewState?.chatsViewMode === 'list' ? 'list' : 'tree';
    var item = (mode: 'tree' | 'list', label: string) => `<div class="ai-session-view-menu-item" role="menuitemradio" aria-checked="${viewMode === mode}" tabindex="-1" data-action="select-chats-view-mode" data-view-mode="${mode}"><span class="ai-session-view-menu-check" aria-hidden="true">${viewMode === mode ? '✓' : ''}</span>${label}</div>`;
    return `<div id="ai-session-chats-view-menu-${projectId}" class="ai-session-view-menu" data-chats-view-menu role="menu" aria-label="CHATS view" hidden>
    ${item('tree', 'View as Tree')}
    ${item('list', 'View as List')}
</div>`;
}

// CHATS 的 tree 视图（PRD M2）：旧 WORKTREE surface 内容整体平移——恒定显示全部
// ready worktree（含无 active session 的空 worktree），管理功能全量保留。
// provisioning 行置顶（PRD：provisioning 行渲染在顶部；Current anchor 固定首组）。
function getChatsTreePanel(
    project: AiSessionSurfaceViewModel,
    selectedProviders: readonly AiSessionProviderId[],
    options: AiSessionRenderOptions,
    quickCreateProvider: AiSessionProviderId,
    quickCreateProfile: string,
    provisioningWorktrees: ProvisioningWorktreeRow[],
): string {
    const projectId = escapeAttribute(project.id || 'project');
    const selected = project.activeAiSessionTab !== 'all';
    const collapsedKeys = new Set(project.windowViewState?.collapsedWorktreeGroups || []);
    const worktrees = getReadyWorktrees(project.worktrees);
    const provisioningRows = provisioningWorktrees
        .map(getProvisioningWorktreeHtml).join('\n');
    const createIsolatedDisabled = provisioningWorktrees.some(row => row.stage !== 'failed');
    // The tree lists live sessions only; history stays in ALL. Sessions without
    // a worktree key belong to the window's main checkout domain and collect
    // under the Current anchor (PRD §4) — never dropped from the active set.
    const activeSessions = project.activeAiSessions || [];
    const entries: WorktreeSessionRenderEntry[] = activeSessions
        .map(session => ({
            worktreeKey: session.worktreeKey,
            html: getActiveAiSessionRow(
                session,
                options.showRootChips,
                options.runningIconAnimation,
                project.id || 'project',
            ),
        }));
    // The anchor and group rows own their sessions; the legacy renderer must
    // only see sessions that belong to no claimed row, or every anchor/group
    // session would render a second time under Unmanaged.
    const claimedLookupKeys = new Set<string>();
    (project.worktreeAnchor?.worktreeKeys || []).forEach(key =>
        claimedLookupKeys.add(worktreeLookupKey(key)));
    (project.worktreeGroups || []).forEach(group =>
        group.members.forEach(member => {
            if (member.worktreeKey) {
                claimedLookupKeys.add(worktreeLookupKey(member.worktreeKey));
            }
        }));
    const anchorMatch = (entry: WorktreeSessionRenderEntry): boolean =>
        !entry.worktreeKey
        || (project.worktreeAnchor?.worktreeKeys || [])
            .some(key => worktreeKeysMatch(entry.worktreeKey, key));
    const anchorEntries = entries.filter(anchorMatch);
    const unclaimedEntries = entries.filter(entry => !anchorMatch(entry)
        && (!entry.worktreeKey
            || !claimedLookupKeys.has(worktreeLookupKey(entry.worktreeKey))));
    const groups = worktrees.length
        ? getWorktreeGroupsHtml(
            worktrees, unclaimedEntries, quickCreateProvider, quickCreateProfile,
            createIsolatedDisabled, collapsedKeys
        )
        : '';
    // 无 ready worktree 时 getWorktreeGroupsHtml 不运行：既不属于 anchor 也不属于
    // 任何组的 stale-key session 仍要渲染在 Unmanaged 桶里（M2 红线：不丢 active）。
    const strayUnmanaged = !worktrees.length && unclaimedEntries.length
        ? getUnmanagedWorktreeGroupHtml(
            unclaimedEntries, 0, collapsedKeys.has(JSON.stringify(['', '', true])))
        : '';
    // The anchor renders whenever it owns main-checkout keys OR absorbs
    // keyless active sessions (non-git workspaces keep their active set);
    // with no anchor VM at all, a minimal one hosts exactly those sessions.
    const anchorVm = project.worktreeAnchor
        || (anchorEntries.length
            ? {
                entries: [], worktreeKeys: [], sessions: [],
                activity: (activeSessions.some(session => session.needsAttention)
                    ? 'attention'
                    : activeSessions.some(session => session.executionState === 'running'
                        || session.executionState === 'starting')
                        ? 'active'
                        : 'idle') as 'attention' | 'active' | 'idle',
            }
            : undefined);
    const anchorHtml = anchorVm && (anchorVm.entries.length || anchorEntries.length)
        ? getWorktreeAnchorHtml(
            anchorVm, entries, quickCreateProvider, quickCreateProfile,
            collapsedKeys.has('["__anchor__"]'))
        : '';
    const groupRowsHtml = (project.worktreeGroups || []).length
        ? getWorktreeGroupRowsHtml(
            project.worktreeGroups || [], entries, quickCreateProvider, quickCreateProfile,
            collapsedKeys
        )
        : '';
    // Adopt suggestions (PRD §6.5): unmanaged worktrees clustered by task
    // slug are OFFERED as groups — adopting is always an explicit action.
    const adoptSuggestions = (project.worktreeAdoptSuggestions || [])
        .map(suggestion => {
            const members = suggestion.members.map(member => ({
                repositoryKey: member.worktreeKey.repositoryKey,
                canonicalWorktreePath: member.worktreeKey.canonicalWorktreePath,
                branchName: member.branchName,
                repositoryLabel: member.repositoryLabel,
            }));
            const label = suggestion.members.length === 1
                ? `Adopt “${suggestion.slug}” as a group…`
                : `Adopt ${suggestion.members.length} worktrees as “${suggestion.slug}”…`;
            return `<div class="ai-session-worktree-adopt-suggestion" data-adopt-slug="${escapeAttribute(suggestion.slug)}" data-adopt-members="${escapeAttribute(JSON.stringify(members))}">`
                + `<button type="button" class="ai-session-worktree-adopt" data-action="adopt-worktree-cluster" data-adopt-slug="${escapeAttribute(suggestion.slug)}" aria-label="${escapeAttribute(label)}">${Icons.gitBranchAdd}<span>${escapeAttribute(label)}</span></button>`
                + `</div>`;
        })
        .join('\n');
    const hasTreeContent = Boolean(worktrees.length || anchorHtml || groupRowsHtml
        || provisioningRows || adoptSuggestions || activeSessions.length);
    const empty = typeof project.worktreeSnapshotRevision === 'number' && !worktrees.length
        && !(project.worktreeGroups || []).length
        && !anchorEntries.length
        ? `<div class="ai-session-worktree-empty-state" role="status">${
            (project.worktreeRepositoryCount || 0) === 0
                ? 'No git repository found in this workspace.'
                : (project.bareWorktreeCount || 0) > 0
                    ? 'No linked worktrees'
                    : 'No worktrees found in this workspace.'
        }</div>`
        : '';
    const truncated = (project.truncatedWorktreeCount || 0) > 0
        ? `<div class="ai-session-worktree-truncated" role="status">${project.truncatedWorktreeCount} more worktrees not shown</div>`
        : '';
    // CHATS 空态（PRD 错误和空状态）：树里什么都没有且无 active session 时，
    // 给新建入口与 ALL 出口，而不是一个光秃秃的空列表。
    const chatsEmpty = !hasTreeContent
        ? `<div class="codex-sessions-empty ai-session-chats-empty">
            <strong>No active sessions</strong>
            <span>Start a new AI session or open one from All.</span>
            <span class="ai-session-empty-actions">
                <button type="button" data-action="create-ai-session">New Session</button>
                <button type="button" data-action="select-ai-session-tab" data-tab="all">View All</button>
            </span>
        </div>`
        : '';
    const treeBody = hasTreeContent
        ? `<div class="ai-session-worktree-list">${provisioningRows}${anchorHtml}${groupRowsHtml}${adoptSuggestions}${groups}${strayUnmanaged}${empty}${truncated}</div>`
        : `<div class="ai-session-worktree-list">${empty}${chatsEmpty}</div>`;
    return `<div id="ai-session-chats-${projectId}" class="ai-session-tab-panel ai-session-chats-panel" role="tabpanel" data-ai-session-panel="chats" aria-labelledby="ai-session-chats-tab-${projectId}"${selected ? '' : ' hidden'}>
        <div class="ai-session-group-form-slot" data-worktree-group-form-slot hidden></div>
        ${getReadyWorktrees(project.worktrees).length
            ? `<div class="ai-session-worktree-panel-bar"><button type="button" class="ai-session-worktree-collapse-all" data-action="toggle-all-ai-session-worktrees" data-collapse-all-state="expanded" aria-label="Collapse all worktrees" data-tooltip="Collapse all worktrees"><span class="ai-session-worktree-collapse-all-icon" data-icon="collapse">${Icons.collapseWorktrees}</span><span class="ai-session-worktree-collapse-all-icon" data-icon="expand">${Icons.expandWorktrees}</span></button></div>`
            : ''}
        ${treeBody}
    </div>`;
}

// CHATS list view keeps exactly the same active-session domain as the tree,
// but removes the worktree hierarchy for a recency-first scanning path.
function getChatsListPanel(
    project: AiSessionSurfaceViewModel,
    options: AiSessionRenderOptions,
): string {
    const projectId = escapeAttribute(project.id || 'project');
    const selected = project.activeAiSessionTab !== 'all';
    const activeSessions = (project.activeAiSessions || []).slice().sort((left, right) =>
        getActiveSessionActivityTimestamp(right) - getActiveSessionActivityTimestamp(left)
        || left.provider.localeCompare(right.provider)
        || left.name.localeCompare(right.name)
        || left.key.localeCompare(right.key));
    const worktreeLabels = getWorktreeLabels(getReadyWorktrees(project.worktrees));
    const rows = activeSessions.map(session => getActiveAiSessionRow(
        session,
        options.showRootChips,
        options.runningIconAnimation,
        project.id || 'project',
        worktreeLabelForKey(worktreeLabels, session.worktreeKey) || 'Current',
    )).join('\n');
    const body = rows || `<div class="codex-sessions-empty ai-session-chats-empty">
        <strong>No active sessions</strong>
        <span>Start a new AI session or open one from All.</span>
        <span class="ai-session-empty-actions">
            <button type="button" data-action="create-ai-session">New Session</button>
            <button type="button" data-action="select-ai-session-tab" data-tab="all">View All</button>
        </span>
    </div>`;
    return `<div id="ai-session-chats-${projectId}" class="ai-session-tab-panel ai-session-chats-panel ai-session-chats-list-panel" role="tabpanel" data-ai-session-panel="chats" aria-labelledby="ai-session-chats-tab-${projectId}"${selected ? '' : ' hidden'}>
        <div class="codex-sessions-list ai-session-chats-list" data-ai-session-chats-list>${body}</div>
    </div>`;
}

function getActiveSessionActivityTimestamp(session: ActiveAiSessionViewModel): number {
    const timestamp = Date.parse(session.updatedAt || session.createdAt || '');
    return Number.isFinite(timestamp) ? timestamp : 0;
}

function getAllSessionsTabId(project: AiSessionSurfaceViewModel): string {
    return `ai-session-all-tab-${escapeAttribute(project.id || 'project')}`;
}

// ALL = 现有 SESSIONS 面板平移（PRD 处置清单）：provider 过滤、Manage、
// 选择态 checkbox 与批操作条、PINNED 置顶分组、availability 降级提示原样保留。
function getAllSessionsPanel(
    project: AiSessionSurfaceViewModel,
    activeProvider: AiSessionProviderId,
    selectedProviders: readonly AiSessionProviderId[],
    options: AiSessionRenderOptions,
): string {
    var projectId = escapeAttribute(project.id || 'project');
    var selected = project.activeAiSessionTab === 'all';
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
    var flatSessions = [...projection.pinned, ...projection.unpinned];
    var historyRows = flatSessions.map(session => getCodexSessionRow(
            session,
            session.provider,
            (project.activeAiSessions || []).find(runtime =>
                runtime.provider === session.provider && runtime.sessionId === session.id),
            options.showRootChips,
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
    var pinnedHeading = projection.pinned.length
        ? '<div class="ai-session-pinned-heading">PINNED</div>'
        : '';
    var sessionRows = historyRows
        ? `${pinnedHeading}${historyRows}`
        : '<div class="codex-sessions-empty"><span>No selected AI sessions yet</span></div>';

    return `<div id="ai-session-all-${projectId}" class="ai-session-tab-panel ai-session-history-panel" role="tabpanel" data-ai-session-panel="all" aria-labelledby="${getAllSessionsTabId(project)}"${selected ? '' : ' hidden'}>
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

function getProvisioningWorktrees(
    worktrees: readonly WorktreeRowViewModel[] | undefined
): ProvisioningWorktreeRow[] {
    return (worktrees || []).filter(
        (row): row is ProvisioningWorktreeRow => row.kind === 'provisioning'
    );
}

function describeProvisioningErrorCode(errorCode: string): string {
    switch (errorCode) {
        case 'repository-has-no-commits':
            return 'the repository has no commits yet; make an initial commit first';
        case 'snapshot-unavailable':
            return 'worktree discovery is not ready yet';
        case 'workspace-untrusted':
            return 'the workspace is not trusted';
        case 'repository-unavailable':
            return 'no usable repository found in this workspace';
        case 'base-ref-unavailable':
            return 'no branch to base the worktree on';
        case 'invalid-task':
            return 'enter a task name';
        case 'setup-failed':
            return 'the setup command failed';
        case 'worktree-create-failed':
            return 'Git could not create the worktree';
        case 'invalid-plan':
            return 'the saved creation plan is no longer valid';
        case 'git-timeout':
            return 'Git timed out';
        case 'interrupted':
            return 'interrupted by a reload; retry or dismiss';
        case 'manifest-unavailable':
            return 'the worktree was created but could not be recorded; retry to finish';
        case 'cancelled':
            return 'cancelled';
        default:
            return errorCode;
    }
}

function getProvisioningWorktreeHtml(row: ProvisioningWorktreeRow): string {
    const stageLabel: Record<ProvisioningWorktreeRow['stage'], string> = {
        queued: 'Queued',
        creating: 'Creating worktree',
        'setting-up': 'Setting up environment',
        failed: 'Needs attention',
    };
    const error = row.errorCode
        ? `<span class="ai-session-provisioning-error">${escapeAttribute(describeProvisioningErrorCode(row.errorCode))}</span>`
        : '';
    const retry = row.retryable
        ? `<button type="button" data-action="retry-isolated-session" data-operation-id="${escapeAttribute(row.operationId)}">Retry</button>`
        : '';
    const cancel = row.cancellable
        ? `<button type="button" data-action="cancel-isolated-session" data-operation-id="${escapeAttribute(row.operationId)}">Cancel</button>`
        : '';
    const dismiss = row.stage === 'failed'
        ? `<button type="button" data-action="dismiss-isolated-session" data-operation-id="${escapeAttribute(row.operationId)}">Dismiss</button>`
        : '';
    const progress = row.stage === 'failed'
        ? ''
        : '<span class="ai-session-provisioning-spinner" aria-hidden="true"></span>';
    return `<section class="ai-session-provisioning-row" data-provisioning-operation-id="${escapeAttribute(row.operationId)}" data-provisioning-stage="${escapeAttribute(row.stage)}" role="status">
        ${progress}
        <span class="ai-session-provisioning-copy">
            <strong>${escapeAttribute(row.taskName)}</strong>
            <span>${escapeAttribute(stageLabel[row.stage])}</span>
            ${error}
        </span>
        <span class="ai-session-provisioning-actions">${retry}${cancel}${dismiss}</span>
    </section>`;
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

function getAiProviderIcon(providerId: AiSessionProviderId): string {
    switch (providerId) {
        case 'kimi':
            return Icons.kimiLogo;
        case 'claude':
            return Icons.claudeLogo;
        default:
            return Icons.openAiLogo;
    }
}

interface WorktreeSessionRenderEntry {
    worktreeKey?: WorktreeKey;
    html: string;
}

function getReadyWorktrees(
    rows: readonly WorktreeRowViewModel[] | undefined,
): ReadyWorktreeRow[] {
    return (rows || [])
        .filter((row): row is ReadyWorktreeRow =>
            row.kind === 'ready' && row.git.isBare !== true);
}

function worktreeLookupKey(key: WorktreeKey): string {
    return JSON.stringify([key.repositoryKey, key.canonicalWorktreePath]);
}

function getWorktreeLabels(worktrees: readonly ReadyWorktreeRow[]): Map<string, string> {
    return new Map(worktrees.map(worktree => [
        worktreeLookupKey(worktree.git.key),
        getWorktreeLabel(worktree),
    ]));
}

function worktreeLabelForKey(
    labels: ReadonlyMap<string, string>,
    key: WorktreeKey | undefined,
): string {
    return key ? labels.get(worktreeLookupKey(key)) || '' : '';
}

function getWorktreeLabel(worktree: ReadyWorktreeRow): string {
    if (worktree.git.branchRef) {
        return worktree.git.branchRef.replace(/^refs\/heads\//, '');
    }
    const pathName = worktree.git.key.canonicalWorktreePath
        .replace(/[\\/]+$/g, '')
        .split(/[\\/]/)
        .pop();
    return pathName || worktree.git.head.substring(0, 8) || 'worktree';
}


// The host-persisted collapsed set (window view state) renders collapsed
// groups collapsed at first paint; the webview mirror keeps intra-session
// gestures consistent between replacements.
function worktreeCollapsedState(collapsed: boolean): { section: string; expanded: 'true' | 'false' } {
    return collapsed
        ? { section: ' data-worktree-collapsed', expanded: 'false' }
        : { section: '', expanded: 'true' };
}

function getWorktreeGroupsHtml(
    worktrees: readonly ReadyWorktreeRow[],
    entries: readonly WorktreeSessionRenderEntry[],
    quickCreateProvider: AiSessionProviderId,
    quickCreateProfile: string,
    createIsolatedDisabled: boolean,
    collapsedKeys: ReadonlySet<string>,
): string {
    const rendered: string[] = [];
    // PRD M2 红线：tree 视图恒定显示全部 ready worktree（含无 active session
    // 的空 worktree 占位），不按 session 有无裁剪。
    worktrees.forEach((worktree, index) => {
        const matched = entries.filter(entry => worktreeKeysMatch(entry.worktreeKey, worktree.git.key));
        const collapsed = collapsedKeys.has(JSON.stringify([
            worktree.git.key.repositoryKey, worktree.git.key.canonicalWorktreePath, false,
        ]));
        rendered.push(getWorktreeGroupHtml(
            worktree, matched, index, quickCreateProvider, quickCreateProfile,
            createIsolatedDisabled, collapsed
        ));
    });
    const unmanaged = entries.filter(entry => !entry.worktreeKey
        || !worktrees.some(worktree => worktreeKeysMatch(entry.worktreeKey, worktree.git.key)));
    if (unmanaged.length) {
        rendered.push(getUnmanagedWorktreeGroupHtml(
            unmanaged, worktrees.length, collapsedKeys.has(JSON.stringify(['', '', true]))));
    }
    return rendered.join('\n');
}

function getWorktreeGroupHtml(
    worktree: ReadyWorktreeRow,
    entries: readonly WorktreeSessionRenderEntry[],
    groupOrder: number,
    quickCreateProvider: AiSessionProviderId,
    quickCreateProfile: string,
    createIsolatedDisabled: boolean,
    collapsed: boolean = false,
): string {
    const collapsedState = worktreeCollapsedState(collapsed);
    const name = getWorktreeLabel(worktree);
    const count = entries.length;
    const activity = worktree.activity === 'attention' ? 'needs attention'
        : worktree.activity === 'active' ? 'active' : 'idle';
    const health = worktree.git.health !== 'normal'
        ? `<span class="ai-session-worktree-health">${escapeAttribute(worktree.git.health)}</span>`
        : '';
    const head = worktree.git.headKind === 'detached'
        ? `<span class="ai-session-worktree-head">detached · ${escapeAttribute(worktree.git.head.substring(0, 8))}</span>`
        : worktree.git.headKind === 'contained-in-base'
            ? '<span class="ai-session-worktree-head">contained in base</span>'
            : '';
    const sessionLabel = `${count} session${count === 1 ? '' : 's'}`;
    const ariaLabel = `${name}, ${sessionLabel}, ${activity}`;
    const providerLabel = getAiProviderLabel(quickCreateProvider);
    const quickLabel = quickCreateProfile
        ? `New ${providerLabel} session in ${name} with profile ${quickCreateProfile}`
        : `New ${providerLabel} session in ${name}`;
    // Offer removal for every usable non-main worktree; the host re-checks
    // dirty, active, open, and provisioning state and explains any refusal.
    const canRemove = !!worktree.authority.canRemove
        && !worktree.git.isMain
        && !worktree.git.isBare;
    const moreLabel = `Actions for ${name}`;
    const more = `<button type="button" class="ai-session-worktree-more" data-action="ai-session-worktree-menu" aria-label="${escapeAttribute(moreLabel)}" data-tooltip="${escapeAttribute(moreLabel)}" aria-haspopup="menu" aria-expanded="false"
        data-worktree-name="${escapeAttribute(name)}"
        data-worktree-head-kind="${worktree.git.headKind}"
        data-can-resume="${worktree.authority.canResume ? 'true' : 'false'}"
        data-can-remove="${canRemove ? 'true' : 'false'}"
        data-can-branch-create="${!createIsolatedDisabled ? 'true' : 'false'}"
        data-quick-provider="${escapeAttribute(quickCreateProvider)}"
        data-quick-label="${escapeAttribute(quickLabel)}"
        data-quick-profile="${escapeAttribute(quickCreateProfile)}">${Icons.moreActions}</button>`;
    return `<section class="ai-session-worktree-group" data-worktree-repository-key="${escapeAttribute(worktree.git.key.repositoryKey)}" data-worktree-path="${escapeAttribute(worktree.git.key.canonicalWorktreePath)}" data-worktree-activity="${worktree.activity}"${collapsedState.section} style="order: ${groupOrder}">
        <div class="ai-session-worktree-toolbar">
            <button type="button" class="ai-session-worktree-header" data-action="toggle-ai-session-worktree" aria-expanded="${collapsedState.expanded}" aria-label="${escapeAttribute(ariaLabel)}">
                <span class="ai-session-worktree-indicator" aria-hidden="true">${worktree.activity === 'idle' ? '○' : '●'}</span>
                <span class="ai-session-worktree-title">${escapeAttribute(name)}</span>
                ${health}${head}
                <span class="ai-session-worktree-count" aria-hidden="true">${count}</span>
                <span class="ai-session-worktree-chevron" aria-hidden="true">${Icons.chevronDown}</span>
            </button>
            ${more}
        </div>
        <div class="ai-session-worktree-session-list">${entries.length
            ? entries.map(entry => entry.html).join('\n')
            : '<div class="ai-session-worktree-empty">(no active sessions)</div>'}</div>
    </section>`;
}

/**
 * The Current anchor row (PRD §4): one permanently single-line top-level row
 * collecting sessions that run in the main checkouts. It is not a managed
 * worktree — no actions menu, no removal — and shows each repository's
 * actually checked-out branch with its repository label.
 */
function getWorktreeAnchorHtml(
    anchor: WorktreeAnchorViewModel,
    entries: readonly WorktreeSessionRenderEntry[],
    quickCreateProvider: AiSessionProviderId,
    quickCreateProfile: string,
    collapsed: boolean = false,
): string {
    const collapsedState = worktreeCollapsedState(collapsed);
    const keys = anchor.worktreeKeys || [];
    // Keyless sessions run in the window's main checkout domain (PRD §4): the
    // anchor absorbs them so CHATS never drops part of the active set.
    const matched = entries.filter(entry => !entry.worktreeKey || keys.some(key =>
        worktreeKeysMatch(entry.worktreeKey, key)));
    const inlineSummary = anchor.entries
        .map(entry => `${entry.repositoryLabel}: ${entry.branch}`)
        .join(' · ');
    // The hover tooltip lists one repository per line (feedback: the
    // single-line dot-separated summary was hard to scan).
    const tooltipSummary = anchor.entries
        .map(entry => `${entry.repositoryLabel}: ${entry.branch}`)
        .join('\n');
    const count = matched.length;
    const activity = anchor.activity === 'attention' ? 'needs attention'
        : anchor.activity === 'active' ? 'active' : 'idle';
    const sessionLabel = `${count} session${count === 1 ? '' : 's'}`;
    const ariaLabel = inlineSummary
        ? `Current, ${inlineSummary}, ${sessionLabel}, ${activity}`
        : `Current, ${sessionLabel}, ${activity}`;
    // The anchor is not a managed worktree — no removal, no branch actions —
    // but it shares the SAME ⋯ menu as every other row (single- and
    // multi-root alike): session creation stays discoverable, with provider
    // and full-option entries, and no standalone + button anywhere.
    const providerLabel = getAiProviderLabel(quickCreateProvider);
    const quickLabel = quickCreateProfile
        ? `New ${providerLabel} session with profile ${quickCreateProfile}`
        : `New ${providerLabel} session`;
    // With exactly one main checkout the anchor can also seed "New
    // worktree from Current" with its branch; multi-root anchors open the
    // plain creation form instead (the form's repository list disambiguates).
    const singleMainKey = anchor.worktreeKeys.length === 1
        ? anchor.worktreeKeys[0]
        : null;
    const moreLabel = 'Actions for Current';
    const more = `<button type="button" class="ai-session-worktree-more" data-action="ai-session-worktree-menu" aria-label="${escapeAttribute(moreLabel)}" data-tooltip="${escapeAttribute(moreLabel)}" aria-haspopup="menu" aria-expanded="false"
        data-worktree-anchor="true"
        ${singleMainKey ? `data-worktree-repository-key="${escapeAttribute(singleMainKey.repositoryKey)}" data-worktree-path="${escapeAttribute(singleMainKey.canonicalWorktreePath)}"` : ''}
        data-worktree-name="Current"
        data-worktree-head-kind="branch"
        data-can-resume="true"
        data-can-remove="false"
        data-can-branch-create="${singleMainKey ? 'true' : 'false'}"
        data-quick-provider="${escapeAttribute(quickCreateProvider)}"
        data-quick-label="${escapeAttribute(quickLabel)}"
        data-quick-profile="${escapeAttribute(quickCreateProfile)}">${Icons.moreActions}</button>`;
    // The per-repository branch detail lives on the fast hover tooltip; the
    // row itself stays a single compact line (annotation: the inline summary
    // squeezed the "Current" title away).
    return `<section class="ai-session-worktree-group ai-session-worktree-anchor" data-worktree-anchor data-worktree-activity="${anchor.activity}"${collapsedState.section}${singleMainKey ? ` data-worktree-repository-key="${escapeAttribute(singleMainKey.repositoryKey)}" data-worktree-path="${escapeAttribute(singleMainKey.canonicalWorktreePath)}"` : ''}>
        <div class="ai-session-worktree-toolbar">
            <button type="button" class="ai-session-worktree-header" data-action="toggle-ai-session-worktree" aria-expanded="${collapsedState.expanded}" aria-label="${escapeAttribute(ariaLabel)}" data-tooltip="${escapeAttribute(tooltipSummary)}">
                <span class="ai-session-worktree-indicator" aria-hidden="true">${anchor.activity === 'idle' ? '○' : '●'}</span>
                <span class="ai-session-worktree-title">Current</span>
                <span class="ai-session-worktree-count" aria-hidden="true">${count}</span>
                <span class="ai-session-worktree-chevron" aria-hidden="true">${Icons.chevronDown}</span>
            </button>
            ${more}
        </div>
        <div class="ai-session-worktree-session-list">${matched.length
            ? matched.map(entry => entry.html).join('\n')
            : '<div class="ai-session-worktree-empty">(no active sessions)</div>'}</div>
    </section>`;
}

function getWorktreeGroupRowsHtml(
    groups: readonly WorktreeGroupRowViewModel[],
    entries: readonly WorktreeSessionRenderEntry[],
    quickCreateProvider: AiSessionProviderId,
    quickCreateProfile: string,
    collapsedKeys: ReadonlySet<string>,
): string {
    return groups
        .map((group, index) => getWorktreeGroupRowHtml(
            group, entries, index, quickCreateProvider, quickCreateProfile,
            collapsedKeys.has(JSON.stringify(['group', group.groupId]))))
        .join('\n');
}

/**
 * One manifest-backed worktree group row (PRD §10): display name plus a
 * repository-list tooltip, sessions aggregated across members as the primary
 * content, and a secondary member summary line.
 */
function getWorktreeGroupRowHtml(
    group: WorktreeGroupRowViewModel,
    entries: readonly WorktreeSessionRenderEntry[],
    groupOrder: number,
    quickCreateProvider: AiSessionProviderId,
    quickCreateProfile: string,
    collapsed: boolean = false,
): string {
    const collapsedState = worktreeCollapsedState(collapsed);
    const memberKeys = group.members
        .filter(member => !!member.worktreeKey)
        .map(member => member.worktreeKey) as WorktreeKey[];
    const matched = entries.filter(entry => memberKeys.some(key =>
        worktreeKeysMatch(entry.worktreeKey, key)));
    const name = group.displayName;
    const count = matched.length;
    const activity = group.activity === 'attention' ? 'needs attention'
        : group.activity === 'active' ? 'active' : 'idle';
    const discriminator = group.discriminator
        ? `<span class="ai-session-worktree-discriminator">${escapeAttribute(group.discriminator)}</span>`
        : '';
    // Repository chips compete directly with the task name for the one-line
    // group header. Keep every repository available from the title tooltip
    // instead, and mirror it in the accessible name for non-pointer users.
    const repositoryNames = group.chips.map(chip => chip.title);
    const repositoryTooltip = repositoryNames.length
        ? ` data-tooltip="${escapeAttribute(`Repositories:\n${repositoryNames.join('\n')}`)}"`
        : '';
    // Never fall back to a non-primary member silently: when the primary is
    // unavailable the user must explicitly choose a replacement.
    const primary = group.members.find(member => member.isPrimary && member.status === 'ready');
    const providerLabel = getAiProviderLabel(quickCreateProvider);
    const quickLabel = quickCreateProfile
        ? `New ${providerLabel} session in ${name} with profile ${quickCreateProfile}`
        : `New ${providerLabel} session in ${name}`;
    // All actions live in the ⋯ menu (session creation included) — no
    // standalone + button on any row, so single-root, multi-root, and
    // group rows behave identically.
    const moreLabel = `Actions for ${name}`;
    const more = `<button type="button" class="ai-session-worktree-more" data-action="ai-session-worktree-menu" aria-label="${escapeAttribute(moreLabel)}" data-tooltip="${escapeAttribute(moreLabel)}" aria-haspopup="menu" aria-expanded="false"
        data-group-id="${escapeAttribute(group.groupId)}"
        data-worktree-name="${escapeAttribute(name)}"
        data-worktree-head-kind="branch"
        data-can-resume="${group.canCreateSession && primary?.worktreeKey ? 'true' : 'false'}"
        data-can-remove="${group.canCreateSession && primary?.worktreeKey ? 'true' : 'false'}"
        data-can-branch-create="${group.canCreateSession && primary?.worktreeKey ? 'true' : 'false'}"
        data-can-merge="${group.mergeCandidateGroupIds.length ? 'true' : 'false'}"
        data-quick-provider="${escapeAttribute(quickCreateProvider)}"
        data-quick-label="${escapeAttribute(quickLabel)}"
        data-quick-profile="${escapeAttribute(quickCreateProfile)}">${Icons.moreActions}</button>`;
    const sessionLabel = `${count} session${count === 1 ? '' : 's'}`;
    const ariaLabel = `${name}, ${sessionLabel}, ${activity}`;
    const headerAriaLabel = repositoryNames.length
        ? `${ariaLabel}, repositories: ${repositoryNames.join(', ')}`
        : ariaLabel;
    const memberNames = group.members.map(member => member.status === 'ready'
        ? member.repositoryLabel
        : `${member.repositoryLabel} (${member.status})`).join(', ');
    const primaryPicker = group.needsPrimarySelection
        ? `<div class="ai-session-worktree-primary-picker" role="group" aria-label="Select a new primary worktree for ${escapeAttribute(name)}">`
            + `<span class="ai-session-worktree-primary-hint">Primary worktree unavailable — set a new primary:</span>`
            + group.members
                .filter(member => member.status === 'ready')
                .map(member => `<button type="button" class="ai-session-worktree-primary-choice" data-action="set-group-primary" data-group-id="${escapeAttribute(group.groupId)}" data-member-id="${escapeAttribute(member.memberId)}" aria-label="Set ${escapeAttribute(member.repositoryLabel)} as the primary worktree">${escapeAttribute(member.repositoryLabel)}</button>`)
                .join('')
            + `</div>`
        : '';
    // PRD §10 (M3): the member summary expands into per-member details —
    // repository, branch, path, status, primary badge — which later batches
    // extend with member-level operations. The toggle state is preserved
    // across authoritative replacements by the view-state script.
    const summaryText = `${group.members.length} worktree${group.members.length === 1 ? '' : 's'} · ${memberNames}`;
    const memberDetailsId = `member-details-${group.groupId}`;
    const memberSummaryLabel = `Member worktrees of ${name}: ${summaryText}`;
    const memberSummary = `<button type="button" class="ai-session-worktree-member-summary" data-action="toggle-group-member-details" aria-expanded="false" aria-controls="${escapeAttribute(memberDetailsId)}" aria-label="${escapeAttribute(`${memberSummaryLabel}. Expand for details.`)}" data-label-expand="${escapeAttribute(`${memberSummaryLabel}. Expand for details.`)}" data-label-collapse="${escapeAttribute(`${memberSummaryLabel}. Collapse details.`)}">`
        + `<span class="ai-session-worktree-member-summary-text">${escapeAttribute(summaryText)}</span>`
        + `<span class="ai-session-worktree-member-summary-chevron" aria-hidden="true">${Icons.chevronDown}</span>`
        + `</button>`
        + `<div class="ai-session-worktree-member-details" id="${escapeAttribute(memberDetailsId)}" hidden>${group.members.map(member => {
            const statusLabel = getMemberDetailStatusLabel(member.status);
            const primaryBadge = member.isPrimary
                ? '<span class="ai-session-worktree-member-detail-primary">primary</span>'
                : '';
            // M3 batch 4 (PRD §6.4): the member-level inverse of Add repo —
            // remove one worktree from the group through the journaled
            // deletion confirmation card. Only ready members are removable.
            const removeAction = member.status === 'ready'
                ? `<button type="button" class="ai-session-worktree-member-remove" data-action="preview-group-member-deletion" data-group-id="${escapeAttribute(group.groupId)}" data-member-id="${escapeAttribute(member.memberId)}" aria-label="Remove the ${escapeAttribute(member.repositoryLabel)} worktree from ${escapeAttribute(name)} (keeps the local branch)" data-tooltip="Remove this worktree from the group…">${Icons.trash}</button>`
                : '';
            return `<div class="ai-session-worktree-member-detail" data-member-id="${escapeAttribute(member.memberId)}" data-member-detail-status="${escapeAttribute(member.status)}">`
                + `<span class="ai-session-worktree-member-detail-repo" data-tooltip="${escapeAttribute(member.repositoryLabel)}">${escapeAttribute(member.repositoryLabel)}</span>${primaryBadge}`
                + `<span class="ai-session-worktree-member-detail-branch" data-tooltip="${escapeAttribute(member.branchName)}">${escapeAttribute(member.branchName)}</span>`
                + `<span class="ai-session-worktree-member-detail-path" data-tooltip="${escapeAttribute(member.path)}">${escapeAttribute(member.path)}</span>`
                + (statusLabel
                    ? `<span class="ai-session-worktree-member-detail-state">${escapeAttribute(statusLabel)}</span>`
                    : '')
                + removeAction
                + `</div>`;
        }).join('\n')}</div>`;
    // M2: in-flight and failed members render as actionable rows so the
    // member state machine (provisioning / failed → Retry / Dismiss) is
    // visible inside the group row (PRD §4.2, §8).
    const memberStatusRows = group.members
        .filter(member => member.status === 'pending' || member.status === 'failed')
        .map(member => {
            const statusLabel = member.status === 'pending'
                ? 'creating…'
                : `creation failed${member.errorCode ? `: ${describeMemberError(member.errorCode)}` : ''}`;
            const actions = member.status === 'failed'
                ? `<button type="button" class="ai-session-worktree-member-retry" data-action="retry-group-member" data-group-id="${escapeAttribute(group.groupId)}" data-member-id="${escapeAttribute(member.memberId)}" aria-label="Retry creating ${escapeAttribute(member.repositoryLabel)} worktree">Retry</button>`
                    + `<button type="button" class="ai-session-worktree-member-dismiss" data-action="dismiss-group-member" data-group-id="${escapeAttribute(group.groupId)}" data-member-id="${escapeAttribute(member.memberId)}" aria-label="Dismiss the failed ${escapeAttribute(member.repositoryLabel)} worktree (keeps any files on disk)">Dismiss</button>`
                : '';
            return `<div class="ai-session-worktree-member-row" data-member-status="${member.status}">`
                + `<span class="ai-session-worktree-member-label">${escapeAttribute(member.repositoryLabel)}</span>`
                + `<span class="ai-session-worktree-member-state">${escapeAttribute(statusLabel)}</span>`
                + actions
                + `</div>`;
        })
        .join('\n');
    const primaryAttributes = primary?.worktreeKey
        ? ` data-worktree-repository-key="${escapeAttribute(primary.worktreeKey.repositoryKey)}" data-worktree-path="${escapeAttribute(primary.worktreeKey.canonicalWorktreePath)}"`
        : '';
    // M3 batch 4 (PRD §6.4): an active deletion journal surfaces inside
    // the group row — in-progress state, or the partial-failure banner
    // with the only two actions the lease allows: Retry and abandon.
    const deletionNotice = group.deletion
        ? (group.deletion.failedCount > 0
            ? `<div class="ai-session-worktree-deletion" data-operation-id="${escapeAttribute(group.deletion.operationId)}" role="alert">`
                + `<span class="ai-session-worktree-deletion-text">Deletion incomplete — ${group.deletion.failedCount} worktree${group.deletion.failedCount === 1 ? '' : 's'} could not be removed; the rest was deleted.</span>`
                + `<button type="button" class="ai-session-worktree-deletion-retry" data-action="retry-group-deletion" data-group-id="${escapeAttribute(group.groupId)}" data-operation-id="${escapeAttribute(group.deletion.operationId)}" aria-label="Retry the failed worktree deletion for ${escapeAttribute(name)}">Retry</button>`
                + `<button type="button" class="ai-session-worktree-deletion-abandon" data-action="abandon-group-deletion" data-group-id="${escapeAttribute(group.groupId)}" data-operation-id="${escapeAttribute(group.deletion.operationId)}" aria-label="Keep the remaining worktrees of ${escapeAttribute(name)} and stop deleting">Keep remaining</button>`
                + `</div>`
            : `<div class="ai-session-worktree-deletion" data-operation-id="${escapeAttribute(group.deletion.operationId)}" role="status">`
                + `<span class="ai-session-worktree-deletion-text">Deletion in progress…</span>`
                + `</div>`)
        : '';
    // PRD §6.3: sessions started before the group grew keep their old
    // writable scope until restarted — say so inline, never silently.
    const scopeOutdatedNote = group.scopeOutdatedSessions
        ? `<div class="ai-session-worktree-scope-outdated" role="note">${escapeAttribute(
            `${group.scopeOutdatedSessions} session${group.scopeOutdatedSessions === 1 ? '' : 's'} cannot write the new worktree yet — restart to pick it up.`
        )}</div>`
        : '';
    return `<section class="ai-session-worktree-group ai-session-worktree-task-group" data-group-id="${escapeAttribute(group.groupId)}" data-group-revision="${group.revision}" data-worktree-activity="${group.activity}"${collapsedState.section}${primaryAttributes} style="order: ${groupOrder}">
        <div class="ai-session-worktree-toolbar">
            <button type="button" class="ai-session-worktree-header" data-action="toggle-ai-session-worktree" aria-expanded="${collapsedState.expanded}" aria-label="${escapeAttribute(headerAriaLabel)}"${repositoryTooltip}>
                <span class="ai-session-worktree-indicator" aria-hidden="true">${group.activity === 'idle' ? '○' : '●'}</span>
                <span class="ai-session-worktree-title">${escapeAttribute(name)}</span>
                ${discriminator}
                <span class="ai-session-worktree-count" aria-hidden="true">${count}</span>
                <span class="ai-session-worktree-chevron" aria-hidden="true">${Icons.chevronDown}</span>
            </button>
            ${more}
        </div>
        <div class="ai-session-worktree-session-list">${matched.length
            ? matched.map(entry => entry.html).join('\n')
            : '<div class="ai-session-worktree-empty">(no active sessions)</div>'}${memberSummary}${memberStatusRows}${deletionNotice}${scopeOutdatedNote}${primaryPicker}</div>
    </section>`;
}

/** Human-readable member detail status (empty for ready members). */
function getMemberDetailStatusLabel(status: WorktreeGroupMemberStatus): string {
    switch (status) {
        case 'pending': return 'creating';
        case 'failed': return 'creation failed';
        case 'deleting': return 'deleting';
        case 'missing': return 'missing on disk';
        case 'detached': return 'repository not in workspace';
        default: return '';
    }
}

/** Human-readable member creation errors (PRD §8: 人话错误，不显示裸错误码). */
function describeMemberError(errorCode: string): string {
    switch (errorCode) {
        case 'branch-conflict': return 'branch name already exists';
        case 'path-conflict': return 'path already exists';
        case 'repository-has-no-commits': return 'repository has no commits yet';
        case 'base-ref-unavailable': return 'base ref unavailable';
        case 'interrupted': return 'interrupted by a reload; retry or dismiss';
        case 'cancelled': return 'cancelled';
        case 'git-timeout': return 'git timed out';
        case 'manifest-unavailable': return 'the workspace changed during creation';
        case 'recovery-persist-failed': return 'could not persist recovery state';
        case 'workspace-untrusted': return 'the workspace is not trusted';
        case 'workspace-unavailable': return 'workspace unavailable';
        default: return errorCode;
    }
}

function getUnmanagedWorktreeGroupHtml(
    entries: readonly WorktreeSessionRenderEntry[],
    groupOrder: number,
    collapsed: boolean = false,
): string {
    const count = entries.length;
    const collapsedState = worktreeCollapsedState(collapsed);
    return `<section class="ai-session-worktree-group ai-session-worktree-unmanaged" data-worktree-unmanaged${collapsedState.section} style="order: ${groupOrder}">
        <button type="button" class="ai-session-worktree-header" data-action="toggle-ai-session-worktree" aria-expanded="${collapsedState.expanded}" aria-label="Unmanaged, ${count} session${count === 1 ? '' : 's'}, idle">
            <span class="ai-session-worktree-indicator" aria-hidden="true">○</span>
            <span class="ai-session-worktree-title">Unmanaged</span>
            <span class="ai-session-worktree-count" aria-hidden="true">${count}</span>
            <span class="ai-session-worktree-chevron" aria-hidden="true">${Icons.chevronDown}</span>
        </button>
        <div class="ai-session-worktree-session-list">${entries.map(entry => entry.html).join('\n')}</div>
    </section>`;
}

function getFlatOrderAttributes(flatOrder: number | undefined): string {
    return Number.isSafeInteger(flatOrder) && (flatOrder as number) >= 0
        ? ` data-ai-session-flat-order="${flatOrder}" style="order: ${flatOrder}"`
        : '';
}

function getCodexSessionRow(
    session: RootLabeledAiSession,
    provider: AiSessionProviderId,
    runtime?: ActiveAiSessionViewModel,
    showRootChip: boolean = false,
    worktreeLabel: string = '',
    flatOrder?: number,
) {
    var sessionName = escapeAttribute(sanitizeProjectName(session.name || session.id));
    var sessionId = escapeAttribute(session.id || '');
    var shortSessionId = escapeAttribute((session.id || '').substring(0, 8));
    var updatedAt = escapeAttribute(formatSessionTimestamp(session.updatedAt));
    var shortId = shortSessionId ? `#${shortSessionId}` : '';
    var staleStatus = runtime?.stale ? 'Runtime status is stale' : '';
    var providerLabel = getAiProviderLabel(provider);
    var pinned = !!session.pinned;
    var needsAttention = runtime ? runtime.needsAttention : !!session.attention?.unread;
    var attentionEventId = runtime?.attentionEventId || session.attention?.eventId || '';
    var attentionIndicator = needsAttention
        ? '<span class="ai-session-attention-indicator" data-tooltip="AI session needs attention" aria-label="AI session needs attention"></span>'
        : '';
    var pinTitle = pinned ? 'Unpin Session' : 'Pin Session';
    var active = session.active === true;
    var backend = runtime?.backend || 'vscode';
    var attached = runtime?.attached ?? (active && backend === 'vscode');
    var conflict = runtime?.conflict === true;
    var runtimeAttributes = ` data-session-backend="${backend}" data-session-attached="${attached ? 'true' : 'false'}"${runtime?.tmuxLayout ? ` data-tmux-layout="${runtime.tmuxLayout}"` : ''}${runtime?.conflict ? ' data-session-conflict' : ''}${runtime?.stale ? ' data-session-stale' : ''}`;
    var batchCheckbox = `<input type="checkbox" class="ai-session-batch-checkbox" aria-label="Select ${sessionName}"${active ? ' disabled' : ''}>`;
    var pinAction = `<button type="button" class="codex-session-pin ${pinned ? 'active' : ''}" data-action="toggle-ai-session-pin" data-tooltip="${pinTitle}" aria-label="${pinTitle}">${Icons.pin}</button>`;
    const contextMenuAction = `<button type="button" class="codex-session-more" data-action="open-ai-session-context-menu" aria-haspopup="menu" aria-expanded="false" aria-controls="aiSessionContextMenu" aria-label="More actions" data-tooltip="More actions">&#8943;</button>`;
    var worktreeGone = !active && session.worktreeUnavailable === true;
    var primaryAction = conflict ? 'Choose runtime'
        : active && backend === 'tmux' && !attached ? 'Attach or focus'
            : active ? 'Focus' : worktreeGone ? 'Unavailable' : 'Resume';
    var runtimeDescription = conflict ? 'runtime conflict'
        : backend === 'tmux'
            ? `tmux ${runtime?.tmuxLayout || 'unknown'} layout, ${attached ? 'attached' : 'detached'}`
            : `Direct VS Code terminal${active ? `, ${attached ? 'attached' : 'detached'}` : ''}`;
    var primaryAriaLabel = conflict
        ? `Choose runtime for ${providerLabel} session ${sessionName}, runtime conflict`
        : `${primaryAction} ${providerLabel} session ${sessionName} using ${runtimeDescription}`;
    if (worktreeGone) {
        primaryAriaLabel = `${providerLabel} session ${sessionName}: its worktree was deleted, so it cannot be resumed; view the conversation instead`;
    }
    if (runtime?.stale) {
        primaryAriaLabel += ', runtime status is stale';
    }
    const statusState = needsAttention
        ? 'waiting'
        : active
            ? (runtime?.executionState === 'starting'
                ? 'starting'
                : runtime?.executionState === 'stopped'
                    ? 'stopped'
                    : 'running')
            : 'stopped';
    const statusLabel = getSessionStatusLabel(statusState);
    const statusMarker = getSessionStatusMarker(statusState);
    const profileTooltip = getAiSessionProfileTooltip(session.profile, session.profileUnavailable);
    const rowDetails = [
        `Provider: ${providerLabel}`,
        profileTooltip,
        `Title ${sessionName}`,
        `Status ${statusLabel}`,
        updatedAt ? `Last activity ${updatedAt}` : '',
        shortId ? `Session ${shortId}` : '',
        staleStatus,
    ].filter(Boolean).join('\n');
    primaryAriaLabel += `, ${statusLabel}`
        + `${updatedAt ? `, last activity ${updatedAt}` : ''}`
        + `${shortId ? `, session ${shortId}` : ''}`;
    const primaryTooltip = `${worktreeGone ? 'Worktree deleted — view the conversation instead' : `${primaryAction} ${providerLabel} Session`}\n${rowDetails}`;
    var primaryRootId = session.primaryRootId || runtime?.primaryRootId || '';
    var primaryRootLabel = session.primaryRootLabel || runtime?.primaryRootLabel || '';
    var rootAttributes = showRootChip && primaryRootId
        ? ` data-primary-root-id="${escapeAttribute(primaryRootId)}"`
        : '';
    var rootChip = showRootChip && primaryRootLabel
        ? `<span class="ai-session-root-chip">${escapeAttribute(sanitizeProjectName(primaryRootLabel))}</span>`
        : '';
    var worktreeChip = worktreeLabel
        ? `<span class="ai-session-worktree-chip" data-tooltip="Worktree ${escapeAttribute(worktreeLabel)}">${escapeAttribute(worktreeLabel)}</span>`
        : '';
    var providerBadge = `<span class="ai-session-provider-badge">${providerLabel}</span>`;
    var profileBadge = getAiSessionProfileBadge(session.profile, session.profileUnavailable);
    var profileAriaLabel = `, ${profileTooltip}`;

    return `
<div class="codex-session-row" role="group" aria-label="${providerLabel} session ${sessionName}${profileAriaLabel}"${runtimeAttributes}${rootAttributes}${pinned ? ' data-session-pinned' : ''}${active ? ' data-session-active' : ''}${needsAttention ? ' data-ai-session-attention data-session-event-id="' + escapeAttribute(attentionEventId) + '"' : ''} data-session-id="${sessionId}" data-session-provider="${provider}"${getFlatOrderAttributes(flatOrder)}>
    ${batchCheckbox}
    <button type="button" class="ai-session-primary-action" data-action="activate-ai-session" aria-label="${primaryAriaLabel}" data-tooltip="${primaryTooltip}"${worktreeGone ? ' disabled data-session-worktree-unavailable' : ''}>
        ${attentionIndicator}
        <span class="codex-session-icon">${getAiProviderIcon(provider)}</span>
        <span class="codex-session-text">
            <span class="codex-session-title-line"><span class="codex-session-name">${sessionName}</span>${statusMarker}${worktreeChip}${providerBadge}${profileBadge}${rootChip}</span>
        </span>
    </button>
    <span class="codex-session-actions">
        ${!active ? `<button type="button" class="codex-session-view" data-action="view-ai-session-conversation" data-tooltip="View Conversation" aria-label="View conversation for ${providerLabel} session ${sessionName}">${Icons.viewConversation}</button>` : ''}
        ${pinAction}
        ${contextMenuAction}
    </span>
</div>`;
}

function getActiveAiSessionRow(
    model: ActiveAiSessionViewModel,
    showRootChip: boolean = false,
    runningIconAnimation?: string,
    projectId: string = 'project',
    worktreeLabel: string = '',
    flatOrder?: number,
): string {
    var providerLabel = getAiProviderLabel(model.provider);
    var sessionName = escapeAttribute(sanitizeProjectName(model.name || model.sessionId || `New ${providerLabel} session`));
    var sessionId = escapeAttribute(model.sessionId || '');
    var shortSessionId = sessionId ? `#${escapeAttribute(sessionId.substring(0, 8))}` : '';
    var createdAt = escapeAttribute(formatSessionTimestamp(model.updatedAt || model.createdAt));
    var iconFx = model.executionState === 'running'
        ? normalizeRunningIconAnimation(runningIconAnimation)
        : '';
    var runtimeStatusLabel = model.conflict ? 'Runtime conflict' : '';
    var runtimeBadgeDescription = model.backend === 'tmux'
        ? 'Managed tmux runtime'
        : 'Direct VS Code terminal';
    var staleStatus = model.stale ? 'Runtime status is stale' : '';
    var legacyScopeDescription = model.legacyScope
        ? 'Legacy workspace scope; restart the session to confine it to its worktree'
        : '';
    var legacyScopeBadge = model.legacyScope
        ? '<span class="ai-session-legacy-scope" data-tooltip="Runs with the pre-isolation workspace scope; restart the session to confine it to its worktree." aria-label="Legacy workspace scope">legacy scope</span>'
        : '';
    var attentionIndicator = model.needsAttention
        ? '<span class="ai-session-attention-indicator" data-tooltip="AI session needs attention" aria-label="AI session needs attention"></span>'
        : '';
    var pinTitle = model.pinned ? 'Unpin Session' : 'Pin Session';
    var pinAction = model.pending
        ? ''
        : `<button type="button" class="codex-session-pin ${model.pinned ? 'active' : ''}" data-action="toggle-ai-session-pin" data-tooltip="${pinTitle}" aria-label="${pinTitle}">${Icons.pin}</button>`;
    var conflict = model.conflict === true;
    const contextMenuAction = model.pending
        ? ''
        : `<button type="button" class="codex-session-more" data-action="open-ai-session-context-menu" aria-haspopup="menu" aria-expanded="false" aria-controls="aiSessionContextMenu" aria-label="More actions" data-tooltip="More actions">&#8943;</button>`;
    var pendingAttributes = model.pending
        ? ` data-session-pending data-pending-id="${escapeAttribute(model.pendingId || '')}" data-pending-created-at="${escapeAttribute(model.createdAt || '')}"`
        : ` data-session-active data-session-id="${sessionId}"`;
    var attentionAttributes = model.needsAttention && model.attentionEventId
        ? ` data-ai-session-attention data-session-event-id="${escapeAttribute(model.attentionEventId)}"`
        : '';
    var runtimeAttributes = ` data-session-backend="${model.backend}" data-session-attached="${model.attached ? 'true' : 'false'}"${model.tmuxLayout ? ` data-tmux-layout="${model.tmuxLayout}"` : ''}${model.conflict ? ' data-session-conflict' : ''}${model.stale ? ' data-session-stale' : ''}`;
    var hasOpenConversationHint = model.focused && !model.pending;
    var rowAction = model.backend === 'tmux'
        ? (model.attached ? 'Focus' : 'Attach or focus')
        : 'Focus';
    var focusAction = conflict ? 'Choose runtime' : model.pending ? 'Focus pending' : rowAction;
    var runtimeDescription = conflict ? 'runtime conflict'
        : model.backend === 'tmux'
            ? `tmux ${model.tmuxLayout || 'unknown'} layout, ${model.attached ? 'attached' : 'detached'}`
            : `Direct VS Code terminal, ${model.attached ? 'attached' : 'detached'}`;
    var focusAriaLabel = conflict
        ? `Choose runtime for ${providerLabel} session ${sessionName}, runtime conflict`
        : `${focusAction} ${providerLabel} session ${sessionName} using ${runtimeDescription}`;
    var conversationAriaLabel = `Open AI conversation for ${providerLabel} session ${sessionName}`;
    if (model.stale) {
        focusAriaLabel += ', runtime status is stale';
    }
    var focusTitle = `${focusAction} ${providerLabel} Session`;
    var conversationTitle = `Open AI conversation for ${providerLabel} Session`;
    var primaryAriaLabel = hasOpenConversationHint
        ? conversationAriaLabel
        : focusAriaLabel;
    var rootAttributes = showRootChip && model.primaryRootId
        ? ` data-primary-root-id="${escapeAttribute(model.primaryRootId)}"`
        : '';
    var rootChip = showRootChip && model.primaryRootLabel
        ? `<span class="ai-session-root-chip">${escapeAttribute(sanitizeProjectName(model.primaryRootLabel))}</span>`
        : '';
    var worktreeChip = worktreeLabel
        ? `<span class="ai-session-worktree-chip" data-tooltip="Worktree ${escapeAttribute(worktreeLabel)}">${escapeAttribute(worktreeLabel)}</span>`
        : '';
    var profileBadge = getAiSessionProfileBadge(model.profile, model.profileUnavailable);
    const profileTooltip = getAiSessionProfileTooltip(model.profile, model.profileUnavailable);
    var profileAriaLabel = `, ${profileTooltip}`;
    var openConversationHint = hasOpenConversationHint
        ? '<span class="ai-session-open-conversation-hint" aria-hidden="true">›</span>'
        : '';
    const statusState = model.needsAttention
        ? 'waiting'
        : model.pending || model.executionState === 'starting'
            ? 'starting'
            : model.executionState;
    const statusLabel = getSessionStatusLabel(statusState);
    const statusMarker = getSessionStatusMarker(statusState);
    const rowDetails = [
        `Provider: ${providerLabel}`,
        profileTooltip,
        `Title ${sessionName}`,
        `Status ${statusLabel}`,
        createdAt ? `Last activity ${createdAt}` : '',
        shortSessionId ? `Session ${shortSessionId}` : '',
        runtimeStatusLabel,
        runtimeBadgeDescription,
        staleStatus,
        legacyScopeDescription,
    ].filter(Boolean).join('\n');
    primaryAriaLabel += `, ${statusLabel}`
        + `${createdAt ? `, last activity ${createdAt}` : ''}`
        + `${shortSessionId ? `, session ${shortSessionId}` : ''}`
        + `${runtimeStatusLabel ? `, runtime conflict` : ''}`
        + `${staleStatus ? ', runtime status is stale' : ''}`
        + `${legacyScopeBadge ? ', legacy workspace scope' : ''}`;
    const focusTooltip = `${focusTitle}\n${rowDetails}`;
    const conversationTooltip = `${conversationTitle}\n${rowDetails}`;
    const primaryTooltip = hasOpenConversationHint ? conversationTooltip : focusTooltip;
    return `<div class="codex-session-row active-ai-session-row" role="group" aria-label="${providerLabel} session ${sessionName}${profileAriaLabel}" data-session-provider="${model.provider}" data-execution-state="${model.executionState}"${iconFx ? ` data-session-icon-fx="${iconFx}"` : ''}${runtimeAttributes}${rootAttributes}${pendingAttributes}${model.pinned ? ' data-session-pinned' : ''}${model.focused ? ' data-session-focused' : ''}${model.needsAttention ? ' data-session-needs-attention' : ''}${attentionAttributes}${getFlatOrderAttributes(flatOrder)}>
        <button type="button" class="ai-session-primary-action" data-action="activate-ai-session" aria-label="${primaryAriaLabel}" data-tooltip="${primaryTooltip}" data-focus-aria-label="${focusAriaLabel}" data-focus-tooltip="${focusTooltip}" data-conversation-aria-label="${conversationAriaLabel}" data-conversation-tooltip="${conversationTooltip}">
            ${attentionIndicator}
            <span class="codex-session-icon">${getAiProviderIcon(model.provider)}</span>
            <span class="codex-session-text">
                <span class="codex-session-title-line"><span class="codex-session-name">${sessionName}</span>${statusMarker}${worktreeChip}${legacyScopeBadge}${profileBadge}${rootChip}</span>
            </span>
            ${openConversationHint}
        </button>
        <span class="codex-session-actions">${pinAction}${contextMenuAction}</span>
    </div>`;
}

type SessionStatusState = 'running' | 'starting' | 'waiting' | 'stopped';

function getSessionStatusLabel(status: SessionStatusState): string {
    switch (status) {
        case 'running': return 'Running';
        case 'starting': return 'Starting';
        case 'waiting': return 'Waiting';
        default: return 'Stopped';
    }
}

function getSessionStatusMarker(status: SessionStatusState): string {
    return `<span class="ai-session-status-marker ${status}" aria-hidden="true"></span>`;
}

function formatSessionTimestamp(updatedAt: string): string {
    if (!updatedAt) {
        return '';
    }

    let date = new Date(updatedAt);
    if (isNaN(date.getTime())) {
        return '';
    }

    const now = new Date();
    const sameDay = date.getFullYear() === now.getFullYear()
        && date.getMonth() === now.getMonth()
        && date.getDate() === now.getDate();
    const twoDigits = (value: number) => String(value).padStart(2, '0');
    if (sameDay) {
        return `${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`;
    }
    if (date.getFullYear() === now.getFullYear()) {
        return `${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
    }
    return `${date.getFullYear()}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())}`;
}

export function getAiSessionWorktreeMenu() {
    return `
<div id="aiSessionWorktreeMenu" class="custom-context-menu ai-session-worktree-menu" role="menu" aria-label="Worktree actions">
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="worktree-quick-create"></div>
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="worktree-provider-create" data-provider="codex">New Codex session</div>
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="worktree-provider-create" data-provider="kimi">New Kimi session</div>
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="worktree-provider-create" data-provider="claude">New Claude session</div>
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="worktree-create-with-options">New session with options…</div>
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="worktree-new">New worktree…</div>
    <div class="custom-context-menu-separator" role="separator" data-worktree-session-separator></div>
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="worktree-branch-create"></div>
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="worktree-group-rename" hidden>Rename group</div>
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="worktree-group-derive" hidden>Derive from this group…</div>
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="worktree-group-add-repo" hidden>Add repository to group…</div>
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="merge-worktree-groups" hidden>Merge with another group…</div>
    <div class="custom-context-menu-item danger" role="menuitem" tabindex="-1" data-action="worktree-group-delete" hidden>Remove group worktrees…</div>
    <div class="custom-context-menu-separator" role="separator" data-worktree-remove-separator></div>
    <div class="custom-context-menu-item danger" role="menuitem" tabindex="-1" data-action="worktree-remove">Remove worktree</div>
</div>`;
}

export function getAiSessionCreateDropdown() {
    return `
<div id="aiSessionCreateDropdown" class="custom-context-menu ai-session-create-dropdown-menu" role="menu" aria-label="Create AI session">
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="create-ai-session-quick" data-provider="codex">
        New Codex session
    </div>
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="create-ai-session-quick" data-provider="kimi">
        New Kimi session
    </div>
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="create-ai-session-quick" data-provider="claude">
        New Claude session
    </div>

    <div class="custom-context-menu-separator" role="separator"></div>

    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="create-ai-session">
        New session with options…
    </div>
</div>`;
}

export function getAiSessionContextMenu() {
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
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="stop-session" hidden>
        Stop Session…
    </div>
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="archive">
        Archive Chat
    </div>
</div>
`;
}
