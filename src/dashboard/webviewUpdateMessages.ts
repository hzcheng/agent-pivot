'use strict';

import { Group, WorkspaceCardViewModel } from '../models';
import type {
    AiSessionPresentationStateMessage,
    AiSessionsUpdatedMessage,
} from '../aiSessions/types';
import type { OpenWorkspaceBridgeStatus } from '../openWorkspaces/bridgeClient';
import {
    buildWorkspaceDashboardSearchCatalog,
    DashboardWorkspaceSearchCatalog,
} from '../webview/dashboardViewModel';
import {
    getCurrentWorkspaceGroupContent,
    getOpenWorkspacesGroupContent,
} from '../webview/webviewContent';

export type ProjectsPanelUpdateMode = 'replace' | 'preserve-order';

export interface ProjectGroupOrder {
    groupId: string;
    projectIds: string[];
}

export interface ProjectsPanelUpdatedMessage {
    type: 'projects-panel-updated';
    version: 1;
    sequence: number;
    mode: ProjectsPanelUpdateMode;
    html: string;
    searchCatalog: DashboardWorkspaceSearchCatalog;
    groupOrders: ProjectGroupOrder[];
    favoriteProjectIds: string[];
}

export interface BuildProjectsPanelUpdatedMessageInput {
    sequence: number;
    mode: ProjectsPanelUpdateMode;
    html: string;
    searchCatalog: DashboardWorkspaceSearchCatalog;
    groupOrders: ProjectGroupOrder[];
    favoriteProjectIds: string[];
}

export function buildProjectsPanelUpdatedMessage(
    input: BuildProjectsPanelUpdatedMessageInput
): ProjectsPanelUpdatedMessage {
    return {
        type: 'projects-panel-updated',
        version: 1,
        sequence: input.sequence,
        mode: input.mode,
        html: input.html,
        searchCatalog: input.searchCatalog,
        groupOrders: input.groupOrders.map(group => ({
            groupId: group.groupId,
            projectIds: [...group.projectIds],
        })),
        favoriteProjectIds: [...input.favoriteProjectIds],
    };
}

export interface OpenWorkspacesUpdatedMessage {
    type: 'open-workspaces-updated';
    version: 4;
    semanticRevision: string;
    projectionRevision: number;
    // v4: the current window appears both as a WINDOWS switcher row and as the
    // transitional current-detail card inside the headless shell, so the old
    // ambiguous currentWorkspaceCount splits into explicit counts.
    windowRowCount: number;
    currentWindowRowCount: 0 | 1;
    navigationWindowRowCount: number;
    currentDetailCount: 0 | 1;
    otherWindowsStatus: OpenWorkspaceBridgeStatus;
    searchCatalog: DashboardWorkspaceSearchCatalog;
    html: string;
    presentation: AiSessionPresentationStateMessage;
}

export interface BuildOpenWorkspacesUpdatedMessageInput {
    groups: Group[];
    cards: WorkspaceCardViewModel[];
    semanticRevision: string;
    projectionRevision: number;
    otherWindowsStatus: OpenWorkspaceBridgeStatus;
    skills?: import('../skills/types').SkillRecord[];
    runningCardAnimation?: string;
    runningIconAnimation?: string;
    /** Host-supplied path segments for window-name disambiguation (projection drops URIs). */
    pathSegmentsByCardId?: ReadonlyMap<string, readonly string[]>;
    presentation: AiSessionPresentationStateMessage;
}

export interface BuildAiSessionsUpdatedMessageInput {
    groups: Group[];
    cards: WorkspaceCardViewModel[];
    sequence: number;
    generatedAt: string;
    skills?: import('../skills/types').SkillRecord[];
    runningCardAnimation?: string;
    runningIconAnimation?: string;
    presentation: AiSessionPresentationStateMessage;
}

export function buildOpenWorkspacesUpdatedMessage(
    input: BuildOpenWorkspacesUpdatedMessageInput
): OpenWorkspacesUpdatedMessage {
    const current = input.cards.find(card => card.kind === 'current') || null;
    const navigationWindowRowCount = input.cards.filter(card => card.kind === 'navigation').length;
    const currentWindowRowCount = current ? 1 : 0;
    const currentDetailCount = current && current.roots.length > 0 ? 1 : 0;
    return {
        type: 'open-workspaces-updated',
        version: 4,
        semanticRevision: input.semanticRevision,
        projectionRevision: input.projectionRevision,
        windowRowCount: currentWindowRowCount + navigationWindowRowCount,
        currentWindowRowCount: currentWindowRowCount as 0 | 1,
        navigationWindowRowCount,
        currentDetailCount: currentDetailCount as 0 | 1,
        otherWindowsStatus: input.otherWindowsStatus,
        searchCatalog: buildWorkspaceDashboardSearchCatalog(
            input.groups,
            input.cards,
            input.skills,
        ),
        html: getOpenWorkspacesGroupContent(
            input.cards,
            input.otherWindowsStatus,
            input.runningCardAnimation,
            input.runningIconAnimation,
            input.pathSegmentsByCardId,
        ),
        presentation: input.presentation,
    };
}

export function buildAiSessionsUpdatedMessage(input: BuildAiSessionsUpdatedMessageInput): AiSessionsUpdatedMessage {
    const current = input.cards.find(card => card.kind === 'current') || null;
    // Count only the renderable current card: the webview filters zero-root
    // (empty-window) cards out of the DOM, so declaring them here would split
    // declared=1/rendered=0 and trip the consistency guard into a full refresh.
    const currentWorkspaceCount = current && current.roots.length > 0 ? 1 : 0;
    return {
        type: 'ai-sessions-updated',
        version: 3,
        sequence: input.sequence,
        projectionRevision: input.sequence,
        generatedAt: input.generatedAt,
        currentWorkspaceCount: currentWorkspaceCount as 0 | 1,
        html: getCurrentWorkspaceGroupContent(
            current,
            input.cards.some(card => card.kind === 'navigation'),
            input.runningCardAnimation,
            input.runningIconAnimation,
        ),
        searchCatalog: buildWorkspaceDashboardSearchCatalog(
            input.groups,
            input.cards,
            input.skills,
        ),
        presentation: input.presentation,
    };
}
