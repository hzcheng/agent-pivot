'use strict';

import { Group, WorkspaceCardViewModel } from '../models';
import type {
    AiSessionPresentationStateMessage,
    AiSessionsUpdatedMessage,
} from '../aiSessions/types';
import type { OpenWorkspaceBridgeStatus } from '../openWorkspaces/bridgeClient';
import type { TodoSearchCatalogItem } from '../todos/types';
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
    version: 3;
    semanticRevision: string;
    projectionRevision: number;
    currentWorkspaceCount: 0 | 1;
    navigationWorkspaceCount: number;
    otherWindowsStatus: OpenWorkspaceBridgeStatus;
    searchCatalog: DashboardWorkspaceSearchCatalog;
    html: string;
    presentation: AiSessionPresentationStateMessage;
}

export interface BuildOpenWorkspacesUpdatedMessageInput {
    groups: Group[];
    cards: WorkspaceCardViewModel[];
    collapsed: boolean;
    semanticRevision: string;
    projectionRevision: number;
    otherWindowsStatus: OpenWorkspaceBridgeStatus;
    todoSearchItems: TodoSearchCatalogItem[];
    skills?: import('../skills/types').SkillRecord[];
    runningCardAnimation?: string;
    runningIconAnimation?: string;
    presentation: AiSessionPresentationStateMessage;
}

export interface BuildAiSessionsUpdatedMessageInput {
    groups: Group[];
    cards: WorkspaceCardViewModel[];
    sequence: number;
    generatedAt: string;
    todoSearchItems: TodoSearchCatalogItem[];
    skills?: import('../skills/types').SkillRecord[];
    runningCardAnimation?: string;
    runningIconAnimation?: string;
    presentation: AiSessionPresentationStateMessage;
}

// --- v4 (PR-A: defined, not yet posted) -------------------------------------
// The window switcher splits the old ambiguous currentWorkspaceCount into
// explicit counts: the current window appears both as a WINDOWS row and as the
// transitional current-detail card inside the headless shell.
export interface OpenWorkspacesUpdatedMessageV4 {
    type: 'open-workspaces-updated';
    version: 4;
    semanticRevision: string;
    projectionRevision: number;
    windowRowCount: number;
    currentWindowRowCount: 0 | 1;
    navigationWindowRowCount: number;
    currentDetailCount: 0 | 1;
    otherWindowsStatus: OpenWorkspaceBridgeStatus;
    searchCatalog: DashboardWorkspaceSearchCatalog;
    html: string;
    presentation: AiSessionPresentationStateMessage;
}

export interface BuildOpenWorkspacesUpdatedMessageV4Input {
    groups: Group[];
    cards: WorkspaceCardViewModel[];
    semanticRevision: string;
    projectionRevision: number;
    otherWindowsStatus: OpenWorkspaceBridgeStatus;
    todoSearchItems: TodoSearchCatalogItem[];
    skills?: import('../skills/types').SkillRecord[];
    /** Pre-rendered window-switcher group HTML (getOpenWindowSwitcherGroupContent). */
    windowSwitcherHtml: string;
    presentation: AiSessionPresentationStateMessage;
}

export function buildOpenWorkspacesUpdatedMessageV4(
    input: BuildOpenWorkspacesUpdatedMessageV4Input
): OpenWorkspacesUpdatedMessageV4 {
    const currentWindowRowCount = input.cards.some(card => card.kind === 'current') ? 1 : 0;
    const navigationWindowRowCount = input.cards.filter(card => card.kind === 'navigation').length;
    return {
        type: 'open-workspaces-updated',
        version: 4,
        semanticRevision: input.semanticRevision,
        projectionRevision: input.projectionRevision,
        windowRowCount: currentWindowRowCount + navigationWindowRowCount,
        currentWindowRowCount: currentWindowRowCount as 0 | 1,
        navigationWindowRowCount,
        currentDetailCount: currentWindowRowCount as 0 | 1,
        otherWindowsStatus: input.otherWindowsStatus,
        searchCatalog: buildWorkspaceDashboardSearchCatalog(
            input.groups,
            input.cards,
            input.todoSearchItems,
            input.skills,
        ),
        html: input.windowSwitcherHtml,
        presentation: input.presentation,
    };
}

export function buildOpenWorkspacesUpdatedMessage(
    input: BuildOpenWorkspacesUpdatedMessageInput
): OpenWorkspacesUpdatedMessage {
    const currentWorkspaceCount = input.cards.some(card => card.kind === 'current') ? 1 : 0;
    const navigationWorkspaceCount = input.cards.filter(card => card.kind === 'navigation').length;
    return {
        type: 'open-workspaces-updated',
        version: 3,
        semanticRevision: input.semanticRevision,
        projectionRevision: input.projectionRevision,
        currentWorkspaceCount,
        navigationWorkspaceCount,
        otherWindowsStatus: input.otherWindowsStatus,
        searchCatalog: buildWorkspaceDashboardSearchCatalog(
            input.groups,
            input.cards,
            input.todoSearchItems,
            input.skills,
        ),
        html: getOpenWorkspacesGroupContent(
            input.cards,
            input.collapsed,
            input.otherWindowsStatus,
            input.runningCardAnimation,
            input.runningIconAnimation,
        ),
        presentation: input.presentation,
    };
}

export function buildAiSessionsUpdatedMessage(input: BuildAiSessionsUpdatedMessageInput): AiSessionsUpdatedMessage {
    const current = input.cards.find(card => card.kind === 'current') || null;
    return {
        type: 'ai-sessions-updated',
        version: 3,
        sequence: input.sequence,
        projectionRevision: input.sequence,
        generatedAt: input.generatedAt,
        currentWorkspaceCount: current ? 1 : 0,
        html: getCurrentWorkspaceGroupContent(
            current,
            input.cards.some(card => card.kind === 'navigation'),
            input.runningCardAnimation,
            input.runningIconAnimation,
        ),
        searchCatalog: buildWorkspaceDashboardSearchCatalog(
            input.groups,
            input.cards,
            input.todoSearchItems,
            input.skills,
        ),
        presentation: input.presentation,
    };
}
