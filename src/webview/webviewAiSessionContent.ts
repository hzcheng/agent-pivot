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
} from '../aiSessions/types';
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
}

export interface AiSessionSurfaceViewModel {
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
        codexSessions: aiSessions.sessionsByProvider.codex || [],
        kimiSessions: aiSessions.sessionsByProvider.kimi || [],
        claudeSessions: aiSessions.sessionsByProvider.claude || [],
        codexSessionsUnavailable: unavailable.has('codex'),
        kimiSessionsUnavailable: unavailable.has('kimi'),
        claudeSessionsUnavailable: unavailable.has('claude'),
        activeAiSessions: aiSessions.activeSessions.slice(),
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
        <span class="codex-session-icon">${getAiProviderIcon(provider)}</span>
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
    projectId: string = 'project',
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
        ? `<button type="button" class="ai-session-close-terminal ai-session-stop-session" data-action="stop-ai-session-runtime" title="Stop Session… Terminates the AI task running in tmux." aria-label="Stop Session">${Icons.remove}</button>`
        : `<button type="button" class="ai-session-close-terminal" data-action="close-ai-session-terminal" title="Close Terminal…" aria-label="Close Terminal">${Icons.remove}</button>`;
    var pendingAttributes = model.pending
        ? ` data-session-pending data-pending-created-at="${escapeAttribute(model.createdAt || '')}"`
        : ` data-session-active data-session-id="${sessionId}"`;
    var attentionAttributes = model.needsAttention && model.attentionEventId
        ? ` data-ai-session-attention data-session-event-id="${escapeAttribute(model.attentionEventId)}"`
        : '';
    var runtimeAttributes = ` data-session-backend="${model.backend}" data-session-attached="${model.attached ? 'true' : 'false'}"${model.tmuxLayout ? ` data-tmux-layout="${model.tmuxLayout}"` : ''}${model.conflict ? ' data-session-conflict' : ''}${model.stale ? ' data-session-stale' : ''}`;
    var hasOpenConversationHint = model.focused && !model.pending;
    var rowAction = model.backend === 'tmux'
        ? (model.attached ? 'Focus' : 'Attach or focus')
        : 'Focus';
    var primaryAction = conflict ? 'Choose runtime' : model.pending ? 'Focus pending' : hasOpenConversationHint ? 'Open conversation' : rowAction;
    var runtimeDescription = conflict ? 'runtime conflict'
        : model.backend === 'tmux'
            ? `tmux ${model.tmuxLayout || 'unknown'} layout, ${model.attached ? 'attached' : 'detached'}`
            : `Direct VS Code terminal, ${model.attached ? 'attached' : 'detached'}`;
    var primaryAriaLabel = conflict
        ? `Choose runtime for ${providerLabel} session ${sessionName}, runtime conflict`
        : hasOpenConversationHint
            ? `Open AI conversation for ${providerLabel} session ${sessionName}`
            : `${primaryAction} ${providerLabel} session ${sessionName} using ${runtimeDescription}`;
    var primaryTitle = hasOpenConversationHint
        ? `Open AI conversation for ${providerLabel} Session`
        : `${primaryAction} ${providerLabel} Session`;
    if (model.stale) {
        primaryAriaLabel += ', runtime status is stale';
    }
    var rootAttributes = showRootChip && model.primaryRootId
        ? ` data-primary-root-id="${escapeAttribute(model.primaryRootId)}"`
        : '';
    var rootChip = showRootChip && model.primaryRootLabel
        ? `<span class="ai-session-root-chip">${escapeAttribute(sanitizeProjectName(model.primaryRootLabel))}</span>`
        : '';
    var openConversationHint = hasOpenConversationHint
        ? '<span class="ai-session-open-conversation-hint" aria-hidden="true">›</span>'
        : '';
    return `<div class="codex-session-row active-ai-session-row" role="group" aria-label="${providerLabel} session ${sessionName}" data-session-provider="${model.provider}" data-execution-state="${model.executionState}"${iconFx ? ` data-session-icon-fx="${iconFx}"` : ''}${runtimeAttributes}${rootAttributes}${pendingAttributes}${model.pinned ? ' data-session-pinned' : ''}${model.focused ? ' data-session-focused' : ''}${model.needsAttention ? ' data-session-needs-attention' : ''}${attentionAttributes}>
        <button type="button" class="ai-session-primary-action" data-action="activate-ai-session" aria-label="${primaryAriaLabel}" title="${primaryTitle}">
            ${attentionIndicator}
            <span class="codex-session-icon">${getAiProviderIcon(model.provider)}</span>
            <span class="codex-session-text">
                <span class="codex-session-title-line">${runtimeBadge}<span class="codex-session-name">${sessionName}</span>${rootChip}</span>
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
