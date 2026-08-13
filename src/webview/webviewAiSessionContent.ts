import {
    CodexSession,
    WorkspaceCardViewModel,
    AiSessionProviderId,
    sanitizeProjectName,
} from '../models';
import * as Icons from './webviewIcons';
import type {
    ActiveAiSessionViewModel,
    AiSessionProviderSummary,
    AiSessionTabId,
    AiSessionViewModel,
    ReadyWorktreeRow,
    WorktreeRowViewModel,
} from '../aiSessions/types';
import type { ProvisioningWorktreeRow, WorktreeKey } from '../worktrees/types';
import { isManagedWorktreePath } from '../worktrees/provisioningPlan';
import { projectAiSessionHistory } from '../aiSessions/historyProjection';
import { escapeAttribute } from './webviewHtmlEscape';
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
}

function getAiSessionProfileBadge(
    profile: string | undefined,
    profileUnavailable: boolean | undefined
): string {
    if (!profile) {
        return '';
    }
    var escapedProfile = escapeAttribute(profile);
    var tooltip = `Codex config profile: ${escapedProfile}${profileUnavailable ? ' (unavailable)' : ''}`;
    return `<span class="ai-session-profile-badge${profileUnavailable ? ' ai-session-profile-unavailable' : ''}" title="${tooltip}" aria-label="${tooltip}">${escapedProfile}${profileUnavailable ? ' · unavailable' : ''}</span>`;
}

export interface AiSessionSurfaceViewModel {
    id: string;
    activeAiSessionProvider?: AiSessionProviderId;
    selectedAiSessionProviders?: AiSessionProviderId[];
    providers?: AiSessionProviderSummary[];
    activeAiSessionTab?: AiSessionTabId;
    /** The surface the user last selected; absent renders the Chats default. */
    selectedSurface?: 'worktree' | 'chats';
    /** Configured managed-worktree directory (relative to each repository root). */
    worktreeDirectory?: string;
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
        ...(aiSessions.selectedSurface
            ? { selectedSurface: aiSessions.selectedSurface }
            : {}),
        ...(aiSessions.worktreeDirectory
            ? { worktreeDirectory: aiSessions.worktreeDirectory }
            : {}),
        codexSessions: aiSessions.sessionsByProvider.codex || [],
        kimiSessions: aiSessions.sessionsByProvider.kimi || [],
        claudeSessions: aiSessions.sessionsByProvider.claude || [],
        codexSessionsUnavailable: unavailable.has('codex'),
        kimiSessionsUnavailable: unavailable.has('kimi'),
        claudeSessionsUnavailable: unavailable.has('claude'),
        activeAiSessions: aiSessions.activeSessions.slice(),
        worktrees: (aiSessions.worktrees || []).slice(),
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
    var selectedTab: AiSessionTabId = project.activeAiSessionTab || (activeSessions.length ? 'active' : 'sessions');
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
    var selectedSurface = project.selectedSurface === 'worktree' ? 'worktree' : 'chats';

    return `
<div class="codex-sessions" data-ai-session-region data-active-ai-session-provider="${escapeAttribute(activeProvider)}" data-selected-ai-session-surface="${selectedSurface}" data-selected-ai-session-tab="${selectedTab}" data-selected-ai-session-providers="${escapeAttribute(selectedProviders.join(','))}">
    <div class="ai-session-surface-bar">
        <div class="ai-session-surface-tabs" role="tablist" aria-label="AI workspace views">
            ${getAiSessionSurfaceTabButton(project.id, 'worktree', 'WORKTREE', selectedSurface)}
            ${getAiSessionSurfaceTabButton(project.id, 'chats', 'CHATS', selectedSurface)}
        </div>
        <button type="button" class="ai-session-create-isolated-button" data-action="create-isolated-session" aria-label="New worktree" title="New worktree"${provisioningWorktrees.some(row => row.stage !== 'failed') ? ' disabled' : ''}>${Icons.gitBranchAdd}</button>
    </div>
    ${getWorktreeSurfacePanel(project, selectedProviders, options, quickCreateProvider, quickCreateProfile, selectedSurface, provisioningWorktrees)}
    <div id="ai-session-chats-${escapeAttribute(project.id || 'project')}" class="ai-session-surface-panel ai-session-chats-surface" role="tabpanel" data-ai-session-surface-panel="chats" aria-labelledby="ai-session-surface-chats-tab-${escapeAttribute(project.id || 'project')}"${selectedSurface === 'chats' ? '' : ' hidden'}>
        <div class="ai-session-chats-toolbar">
            <div class="ai-session-tabs" role="tablist" aria-label="Chat views">
                ${getAiSessionTabButton(project, 'active', activeSessions.length)}
                ${getAiSessionTabButton(project, 'sessions', totalSessionCount)}
            </div>
            <div class="ai-session-surface-actions ai-session-chats-actions">
                <span class="ai-session-create-split-button">
                    <button type="button" class="ai-session-create-quick-button" data-action="create-ai-session-quick" data-provider="${escapeAttribute(quickCreateProvider)}" aria-label="${escapeAttribute(quickCreateActionLabel)}" title="${escapeAttribute(quickCreateActionLabel)}"><span class="codex-session-icon ai-session-create-icon">${getAiProviderIcon(quickCreateProvider)}</span></button>
                    <button type="button" class="ai-session-create-dropdown-button" data-action="create-ai-session-dropdown" aria-label="More create options" title="More create options" aria-haspopup="menu" aria-expanded="false" aria-controls="aiSessionCreateDropdown"><span class="ai-session-dropdown-arrow">&#9662;</span></button>
                </span>
            </div>
        </div>
        ${getActiveAiSessionPanel(project, activeSessions, options)}
        ${getAiSessionHistoryPanel(project, activeProvider, selectedProviders, options)}
    </div>
    <div class="ai-session-live-region" data-ai-session-live-region aria-live="polite" aria-atomic="true"></div>
</div>`;
}

function getAiSessionSurfaceTabButton(
    projectId: string,
    surface: 'worktree' | 'chats',
    label: string,
    selectedSurface: string,
): string {
    const escapedProjectId = escapeAttribute(projectId || 'project');
    const selected = selectedSurface === surface;
    return `<button type="button" id="ai-session-surface-${surface}-tab-${escapedProjectId}" role="tab" data-action="select-ai-session-surface" data-surface="${surface}" data-ai-session-surface-tab="${surface}" aria-selected="${selected}" aria-controls="ai-session-${surface}-${escapedProjectId}" tabindex="${selected ? '0' : '-1'}">${label}</button>`;
}

function getWorktreeSurfacePanel(
    project: AiSessionSurfaceViewModel,
    selectedProviders: readonly AiSessionProviderId[],
    options: AiSessionRenderOptions,
    quickCreateProvider: AiSessionProviderId,
    quickCreateProfile: string,
    selectedSurface: string,
    provisioningWorktrees: ProvisioningWorktreeRow[],
): string {
    const projectId = escapeAttribute(project.id || 'project');
    const worktrees = getReadyWorktrees(project.worktrees);
    const provisioningRows = provisioningWorktrees
        .map(getProvisioningWorktreeHtml).join('\n');
    const createIsolatedDisabled = provisioningWorktrees.some(row => row.stage !== 'failed');
    const projection = projectAiSessionHistory(selectedProviders, {
        codex: (project.codexSessions || []).map(session => ({ ...session, provider: 'codex' })),
        kimi: (project.kimiSessions || []).map(session => ({ ...session, provider: 'kimi' })),
        claude: (project.claudeSessions || []).map(session => ({ ...session, provider: 'claude' })),
    });
    const activeSessions = project.activeAiSessions || [];
    const activeKeys = new Set(activeSessions
        .filter(session => !!session.sessionId)
        .map(session => `${session.provider}:${session.sessionId}`));
    const entries: WorktreeSessionRenderEntry[] = activeSessions
        .filter(session => !!session.worktreeKey)
        .map(session => ({
            worktreeKey: session.worktreeKey,
            html: getActiveAiSessionRow(
                session,
                options.showRootChips,
                options.runningIconAnimation,
                project.id || 'project',
            ),
        }));
    [...projection.pinned, ...projection.unpinned]
        .filter(session => !!session.worktreeKey
            && !activeKeys.has(`${session.provider}:${session.id}`))
        .forEach(session => entries.push({
            worktreeKey: session.worktreeKey,
            html: getCodexSessionRow(session, session.provider, undefined, options.showRootChips),
        }));
    const groups = worktrees.length
        ? getWorktreeGroupsHtml(
            worktrees, entries, 'sessions', quickCreateProvider, quickCreateProfile,
            createIsolatedDisabled, project.worktreeDirectory
        )
        : '';
    const empty = typeof project.worktreeSnapshotRevision === 'number' && !worktrees.length
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
    return `<div id="ai-session-worktree-${projectId}" class="ai-session-surface-panel ai-session-worktree-surface" role="tabpanel" data-ai-session-surface-panel="worktree" aria-labelledby="ai-session-surface-worktree-tab-${projectId}"${selectedSurface === 'worktree' ? '' : ' hidden'}>
        <div class="ai-session-worktree-list">${provisioningRows}${groups}${empty}${truncated}</div>
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
    return `<button type="button" id="${tabId}" role="tab" data-action="select-ai-session-tab" data-tab="${tab}" data-ai-session-tab="${tab}" aria-selected="${selected}" aria-controls="${panelId}" tabindex="${selected ? '0' : '-1'}"><span>${isActiveTab ? 'ACTIVE' : 'ALL'}</span><span class="ai-session-tab-count">${count}</span>${attentionDot}</button>`;
}

function getActiveAiSessionPanel(
    project: AiSessionSurfaceViewModel,
    sessions: ActiveAiSessionViewModel[],
    options: AiSessionRenderOptions,
): string {
    var projectId = escapeAttribute(project.id || 'project');
    var selected = project.activeAiSessionTab === 'active';
    var rows = sessions.length
        ? sessions.map(session => getActiveAiSessionRow(
            session,
            options.showRootChips,
            options.runningIconAnimation,
            project.id || 'project',
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
    options: AiSessionRenderOptions,
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

function getProvisioningWorktrees(
    worktrees: readonly WorktreeRowViewModel[] | undefined
): ProvisioningWorktreeRow[] {
    return (worktrees || []).filter(
        (row): row is ProvisioningWorktreeRow => row.kind === 'provisioning'
    );
}

function getProvisioningWorktreeHtml(row: ProvisioningWorktreeRow): string {
    const stageLabel: Record<ProvisioningWorktreeRow['stage'], string> = {
        queued: 'Queued',
        creating: 'Creating worktree',
        'setting-up': 'Setting up environment',
        'starting-agent': 'Starting agent',
        failed: 'Needs attention',
    };
    const error = row.errorCode
        ? `<span class="ai-session-provisioning-error">${escapeAttribute(row.errorCode)}</span>`
        : '';
    const retry = row.retryable
        ? `<button type="button" data-action="retry-isolated-session" data-operation-id="${escapeAttribute(row.operationId)}">Retry</button>`
        : '';
    const cancel = row.cancellable
        ? `<button type="button" data-action="cancel-isolated-session" data-operation-id="${escapeAttribute(row.operationId)}">Cancel</button>`
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
        <span class="ai-session-provisioning-actions">${retry}${cancel}</span>
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
        .map((row, index) => ({ row, index }))
        .filter((candidate): candidate is { row: ReadyWorktreeRow; index: number } =>
            candidate.row.kind === 'ready' && candidate.row.git.isBare !== true)
        .sort((left, right) => activityPriority(left.row.activity)
            - activityPriority(right.row.activity)
            || left.index - right.index)
        .map(candidate => candidate.row);
}

function activityPriority(activity: ReadyWorktreeRow['activity']): number {
    return activity === 'attention' ? 0 : activity === 'active' ? 1 : 2;
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

function worktreeKeysEqual(left: WorktreeKey | undefined, right: WorktreeKey): boolean {
    return !!left
        && left.repositoryKey === right.repositoryKey
        && left.canonicalWorktreePath === right.canonicalWorktreePath;
}

function getWorktreeGroupsHtml(
    worktrees: readonly ReadyWorktreeRow[],
    entries: readonly WorktreeSessionRenderEntry[],
    tab: AiSessionTabId,
    quickCreateProvider: AiSessionProviderId,
    quickCreateProfile: string,
    createIsolatedDisabled: boolean,
    worktreeDirectory?: string,
): string {
    const rendered: string[] = [];
    worktrees.forEach((worktree, index) => {
        const matched = entries.filter(entry => worktreeKeysEqual(entry.worktreeKey, worktree.git.key));
        if (tab === 'active' && !matched.length) {
            return;
        }
        rendered.push(getWorktreeGroupHtml(
            worktree, matched, index, quickCreateProvider, quickCreateProfile,
            createIsolatedDisabled, worktreeDirectory
        ));
    });
    const unmanaged = entries.filter(entry => !entry.worktreeKey
        || !worktrees.some(worktree => worktreeKeysEqual(entry.worktreeKey, worktree.git.key)));
    if (unmanaged.length) {
        rendered.push(getUnmanagedWorktreeGroupHtml(unmanaged, worktrees.length));
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
    worktreeDirectory?: string,
): string {
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
    const canRemove = worktree.authority.canRemove
        && !worktree.git.isMain
        && worktree.git.health === 'normal'
        && worktree.activity === 'idle'
        && isManagedWorktreePath(
            worktree.git.key.repositoryKey,
            worktree.git.key.canonicalWorktreePath,
            worktreeDirectory
        );
    const moreLabel = `Actions for ${name}`;
    const more = `<button type="button" class="ai-session-worktree-more" data-action="ai-session-worktree-menu" aria-label="${escapeAttribute(moreLabel)}" title="${escapeAttribute(moreLabel)}" aria-haspopup="menu" aria-expanded="false"
        data-worktree-name="${escapeAttribute(name)}"
        data-worktree-head-kind="${worktree.git.headKind}"
        data-can-resume="${worktree.authority.canResume ? 'true' : 'false'}"
        data-can-remove="${canRemove ? 'true' : 'false'}"
        data-can-branch-create="${!createIsolatedDisabled ? 'true' : 'false'}"
        data-quick-provider="${escapeAttribute(quickCreateProvider)}"
        data-quick-label="${escapeAttribute(quickLabel)}"
        data-quick-profile="${escapeAttribute(quickCreateProfile)}">${Icons.moreActions}</button>`;
    return `<section class="ai-session-worktree-group" data-worktree-repository-key="${escapeAttribute(worktree.git.key.repositoryKey)}" data-worktree-path="${escapeAttribute(worktree.git.key.canonicalWorktreePath)}" data-worktree-activity="${worktree.activity}" style="order: ${groupOrder}">
        <div class="ai-session-worktree-toolbar">
            <button type="button" class="ai-session-worktree-header" data-action="toggle-ai-session-worktree" aria-expanded="true" aria-label="${escapeAttribute(ariaLabel)}">
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
            : '<div class="ai-session-worktree-empty">(no sessions)</div>'}</div>
    </section>`;
}

function getUnmanagedWorktreeGroupHtml(
    entries: readonly WorktreeSessionRenderEntry[],
    groupOrder: number,
): string {
    const count = entries.length;
    return `<section class="ai-session-worktree-group ai-session-worktree-unmanaged" data-worktree-unmanaged style="order: ${groupOrder}">
        <button type="button" class="ai-session-worktree-header" data-action="toggle-ai-session-worktree" aria-expanded="true" aria-label="Unmanaged, ${count} session${count === 1 ? '' : 's'}, idle">
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
    var updatedAt = escapeAttribute(formatCodexSessionUpdatedAt(session.updatedAt));
    var shortId = shortSessionId ? `#${shortSessionId}` : '';
    var staleStatus = runtime?.stale
        ? '<span class="ai-session-stale-status" title="Runtime status is stale">stale</span>'
        : '';
    var metadata = [staleStatus, updatedAt, shortId].filter(value => !!value).join(' · ');
    var providerLabel = getAiProviderLabel(provider);
    var pinned = !!session.pinned;
    var needsAttention = runtime ? runtime.needsAttention : !!session.attention?.unread;
    var attentionEventId = runtime?.attentionEventId || session.attention?.eventId || '';
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
    var worktreeChip = worktreeLabel
        ? `<span class="ai-session-worktree-chip" title="Worktree ${escapeAttribute(worktreeLabel)}">${escapeAttribute(worktreeLabel)}</span>`
        : '';
    var providerBadge = `<span class="ai-session-provider-badge">${providerLabel}</span>`;
    var profileBadge = getAiSessionProfileBadge(session.profile, session.profileUnavailable);
    var profileAriaLabel = session.profile
        ? `, Codex config profile ${escapeAttribute(session.profile)}${session.profileUnavailable ? ' (unavailable)' : ''}`
        : '';

    return `
<div class="codex-session-row" role="group" aria-label="${providerLabel} session ${sessionName}${profileAriaLabel}"${runtimeAttributes}${rootAttributes}${pinned ? ' data-session-pinned' : ''}${active ? ' data-session-active' : ''}${needsAttention ? ' data-ai-session-attention data-session-event-id="' + escapeAttribute(attentionEventId) + '"' : ''} data-session-id="${sessionId}" data-session-provider="${provider}"${getFlatOrderAttributes(flatOrder)}>
    ${batchCheckbox}
    <button type="button" class="ai-session-primary-action" data-action="activate-ai-session" aria-label="${primaryAriaLabel}" title="${primaryAction} ${providerLabel} Session">
        ${attentionIndicator}
        <span class="codex-session-icon">${getAiProviderIcon(provider)}</span>
        <span class="codex-session-text">
            <span class="codex-session-title-line"><span class="codex-session-name">${sessionName}</span>${providerBadge}${profileBadge}${rootChip}${worktreeChip}</span>
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
    projectId: string = 'project',
    worktreeLabel: string = '',
    flatOrder?: number,
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
    var runtimeStatusLabel = model.conflict ? 'Runtime conflict' : '';
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
    var conflict = model.conflict === true;
    var terminalAction = conflict ? '' : model.backend === 'tmux'
        ? `<button type="button" class="ai-session-close-terminal ai-session-stop-session" data-action="stop-ai-session-runtime" title="Stop Session… Terminates the AI task running in tmux." aria-label="Stop Session">${Icons.remove}</button>`
        : `<button type="button" class="ai-session-close-terminal" data-action="close-ai-session-terminal" title="Close Terminal…" aria-label="Close Terminal">${Icons.remove}</button>`;
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
    var primaryTitle = hasOpenConversationHint ? conversationTitle : focusTitle;
    var rootAttributes = showRootChip && model.primaryRootId
        ? ` data-primary-root-id="${escapeAttribute(model.primaryRootId)}"`
        : '';
    var rootChip = showRootChip && model.primaryRootLabel
        ? `<span class="ai-session-root-chip">${escapeAttribute(sanitizeProjectName(model.primaryRootLabel))}</span>`
        : '';
    var worktreeChip = worktreeLabel
        ? `<span class="ai-session-worktree-chip" title="Worktree ${escapeAttribute(worktreeLabel)}">${escapeAttribute(worktreeLabel)}</span>`
        : '';
    var profileBadge = getAiSessionProfileBadge(model.profile, model.profileUnavailable);
    var profileAriaLabel = model.profile
        ? `, Codex config profile ${escapeAttribute(model.profile)}${model.profileUnavailable ? ' (unavailable)' : ''}`
        : '';
    var openConversationHint = hasOpenConversationHint
        ? '<span class="ai-session-open-conversation-hint" aria-hidden="true">›</span>'
        : '';
    return `<div class="codex-session-row active-ai-session-row" role="group" aria-label="${providerLabel} session ${sessionName}${profileAriaLabel}" data-session-provider="${model.provider}" data-execution-state="${model.executionState}"${iconFx ? ` data-session-icon-fx="${iconFx}"` : ''}${runtimeAttributes}${rootAttributes}${pendingAttributes}${model.pinned ? ' data-session-pinned' : ''}${model.focused ? ' data-session-focused' : ''}${model.needsAttention ? ' data-session-needs-attention' : ''}${attentionAttributes}${getFlatOrderAttributes(flatOrder)}>
        <button type="button" class="ai-session-primary-action" data-action="activate-ai-session" aria-label="${primaryAriaLabel}" title="${primaryTitle}" data-focus-aria-label="${focusAriaLabel}" data-focus-title="${focusTitle}" data-conversation-aria-label="${conversationAriaLabel}" data-conversation-title="${conversationTitle}">
            ${attentionIndicator}
            <span class="codex-session-icon">${getAiProviderIcon(model.provider)}</span>
            <span class="codex-session-text">
                <span class="codex-session-title-line">${runtimeBadge}<span class="codex-session-name">${sessionName}</span>${profileBadge}${rootChip}${worktreeChip}</span>
                <span class="codex-session-meta">${metadata}</span>
            </span>
            ${openConversationHint}
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

export function getAiSessionWorktreeMenu() {
    return `
<div id="aiSessionWorktreeMenu" class="custom-context-menu ai-session-worktree-menu" role="menu" aria-label="Worktree actions">
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="worktree-quick-create"></div>
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="worktree-provider-create" data-provider="codex">New Codex session</div>
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="worktree-provider-create" data-provider="kimi">New Kimi session</div>
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="worktree-provider-create" data-provider="claude">New Claude session</div>
    <div class="custom-context-menu-separator" role="separator"></div>
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="worktree-branch-create"></div>
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
