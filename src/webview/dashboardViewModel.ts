'use strict';

import type { AiSessionProviderId, Group, Project } from '../models';
import type { WorktreeActivity, WorktreeRowViewModel } from '../aiSessions/types';
import type { WorktreeKey } from '../worktrees';

export interface DashboardWorkspaceSearchSessionItem {
    key: string;
    searchText: string;
    workspaceId: string;
    workspaceNavigationIdentity: string;
    workspaceName: string;
    action: 'reveal-workspace-session';
    provider: AiSessionProviderId;
    sessionId: string;
    name: string;
    updatedAt?: string;
    active?: boolean;
    worktreeKey?: WorktreeKey;
    worktreeName?: string;
}

export interface DashboardWorkspaceSearchWorktreeItem {
    key: string;
    searchText: string;
    workspaceId: string;
    workspaceNavigationIdentity: string;
    workspaceName: string;
    action: 'reveal-workspace-worktree';
    repositoryKey: string;
    canonicalWorktreePath: string;
    name: string;
    branchRef?: string;
    head: string;
    activity: WorktreeActivity;
    sessionCount: number;
}

export interface DashboardSearchProjectItem {
    key: string;
    identity: string;
    searchText: string;
    projectId: string;
    name: string;
    description: string;
    action: 'open-saved';
    environmentLabel?: string;
    groupLabels: string[];
}

export interface DashboardSearchWorkspaceItem {
    key: string;
    navigationIdentity: string;
    searchText: string;
    workspaceId: string;
    name: string;
    description: string;
    action: 'show-current-workspace' | 'switch-open-workspace';
    current: boolean;
    environmentLabel?: string;
}

export interface DashboardWorkspaceSearchCatalog {
    version: 3;
    sessions: DashboardWorkspaceSearchSessionItem[];
    worktrees: DashboardWorkspaceSearchWorktreeItem[];
    openWorkspaces: DashboardSearchWorkspaceItem[];
    savedProjects: DashboardSearchProjectItem[];
    /** Kept empty for catalog v3 compatibility; TODO results are no longer rendered. */
    todos: unknown[];
    skills?: DashboardSearchSkillItem[];
}

export interface DashboardSearchSkillItem {
    key: string;
    searchText: string;
    name: string;
    description: string;
    dirPath: string;
    scope: string;
    action: 'reveal-skill';
}

export interface DashboardSearchWorkspace {
    id: string;
    kind: 'current' | 'navigation';
    navigationIdentity: string;
    name: string;
    environmentLabel?: string;
    roots: Array<{ id: string; name: string; ordinal: number }>;
    aiSessions?: {
        sessionsByProvider: Partial<Record<AiSessionProviderId, Array<{
            id: string;
            name?: string;
            updatedAt?: string;
            active?: boolean;
            primaryRootLabel?: string;
            worktreeKey?: WorktreeKey;
        }>>>;
        worktrees?: WorktreeRowViewModel[];
    };
}

const PROVIDERS: Array<{
    id: AiSessionProviderId;
    key: 'codexSessions' | 'kimiSessions' | 'claudeSessions';
}> = [
    { id: 'codex', key: 'codexSessions' },
    { id: 'kimi', key: 'kimiSessions' },
    { id: 'claude', key: 'claudeSessions' },
];

function searchable(...values: Array<string | undefined>): string {
    return values.filter(Boolean).join(' ').toLowerCase();
}

function removeTrailingIdentitySeparators(value: string): string {
    if (value === '/' || /^[A-Za-z]:\/$/.test(value)) {
        return value;
    }
    return value.replace(/\/+$/g, '');
}

function normalizeDashboardProjectIdentity(uri: string): string {
    const value = uri || '';
    const uriMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)(.*)$/.exec(value);
    if (!uriMatch) {
        if (/^[A-Za-z]:[\\/]/.test(value)) {
            return removeTrailingIdentitySeparators(value.replace(/\\/g, '/'));
        }
        return removeTrailingIdentitySeparators(value);
    }
    const scheme = uriMatch[1].toLowerCase();
    const authority = uriMatch[2]
        .replace(/%[0-9a-fA-F]{2}/g, escape => escape.toUpperCase())
        .replace(/%2B/g, '+');
    const uriPath = removeTrailingIdentitySeparators(uriMatch[3]);
    return `${scheme}://${authority}${uriPath}`;
}

function buildSavedProjectSearchItems(groups: Group[]): DashboardSearchProjectItem[] {
    const savedByIdentity = new Map<string, DashboardSearchProjectItem>();

    (groups || []).forEach(group => (group.projects || []).forEach(project => {
        const identity = normalizeDashboardProjectIdentity(project.path) || project.id;
        let item = savedByIdentity.get(identity);
        if (!item) {
            item = {
                key: `saved:${identity}`,
                identity,
                searchText: searchable(project.name, project.description, group.groupName, ...(project.tags || [])),
                projectId: project.id,
                name: project.name || '',
                description: project.description || '',
                action: 'open-saved',
                groupLabels: [],
            };
            savedByIdentity.set(identity, item);
        }
        if (project.favorite && !item.groupLabels.includes('FAVORITES')) {
            item.groupLabels.push('FAVORITES');
        }
        if (group.groupName && !item.groupLabels.includes(group.groupName)) {
            item.groupLabels.push(group.groupName);
        }
        item.searchText = searchable(item.searchText, project.name, project.description, group.groupName, ...(project.tags || []));
    }));

    return Array.from(savedByIdentity.values());
}

export function buildWorkspaceDashboardSearchCatalog(
    groups: Group[],
    workspaces: DashboardSearchWorkspace[],
    skills: import('../skills/types').SkillRecord[] = []
): DashboardWorkspaceSearchCatalog {
    const current = (workspaces || []).find(workspace => workspace.kind === 'current');
    const byNavigationIdentity = new Map<string, DashboardSearchWorkspace>();
    if (current?.navigationIdentity) {
        byNavigationIdentity.set(current.navigationIdentity, current);
    }
    (workspaces || [])
        .filter(workspace => workspace.kind !== 'current')
        .forEach(workspace => {
            if (workspace.navigationIdentity && !byNavigationIdentity.has(workspace.navigationIdentity)) {
                byNavigationIdentity.set(workspace.navigationIdentity, workspace);
            }
        });

    const openWorkspaces = Array.from(byNavigationIdentity.values())
        .sort((left, right) => {
            if (left === current) {
                return -1;
            }
            if (right === current) {
                return 1;
            }
            return left.navigationIdentity.localeCompare(right.navigationIdentity);
        })
        .map(workspace => {
            const rootNames = (workspace.roots || [])
                .slice()
                .sort((left, right) => left.ordinal - right.ordinal)
                .map(root => root.name);
            const rootCount = rootNames.length;
            const isCurrent = workspace === current;
            return {
                key: `workspace:${workspace.navigationIdentity}`,
                navigationIdentity: workspace.navigationIdentity,
                searchText: searchable(workspace.name, workspace.environmentLabel, ...rootNames),
                workspaceId: workspace.id,
                name: workspace.name || '',
                description: `${rootCount} folder${rootCount === 1 ? '' : 's'}`,
                action: isCurrent ? 'show-current-workspace' as const : 'switch-open-workspace' as const,
                current: isCurrent,
                ...(workspace.environmentLabel ? { environmentLabel: workspace.environmentLabel } : {}),
            };
        });

    const sessions: DashboardWorkspaceSearchSessionItem[] = [];
    const worktrees: DashboardWorkspaceSearchWorktreeItem[] = [];
    if (current?.aiSessions) {
        const worktreeNameByKey = new Map<string, string>();
        (current.aiSessions.worktrees || []).forEach(row => {
            if (row.kind !== 'ready') {
                return;
            }
            const name = getWorktreeDisplayName(row);
            const key = worktreeLookupKey(row.git.key);
            worktreeNameByKey.set(key, name);
            worktrees.push({
                key: `worktree:${key}`,
                searchText: searchable(
                    name,
                    row.git.branchRef,
                    row.git.key.canonicalWorktreePath,
                    row.git.key.repositoryKey,
                    row.git.head,
                    current.name,
                ),
                workspaceId: current.id,
                workspaceNavigationIdentity: current.navigationIdentity,
                workspaceName: current.name || '',
                action: 'reveal-workspace-worktree',
                repositoryKey: row.git.key.repositoryKey,
                canonicalWorktreePath: row.git.key.canonicalWorktreePath,
                name,
                ...(row.git.branchRef ? { branchRef: row.git.branchRef } : {}),
                head: row.git.head,
                activity: row.activity,
                sessionCount: row.sessions.length,
            });
        });
        PROVIDERS.forEach(provider => (current.aiSessions.sessionsByProvider[provider.id] || [])
            .forEach(session => {
                const worktreeName = session.worktreeKey
                    ? worktreeNameByKey.get(worktreeLookupKey(session.worktreeKey))
                    : undefined;
                sessions.push({
                    key: `${provider.id}:${session.id}`,
                    searchText: searchable(
                        session.name,
                        current.name,
                        session.primaryRootLabel,
                        worktreeName,
                        session.worktreeKey?.canonicalWorktreePath,
                        provider.id,
                        session.id
                    ),
                    workspaceId: current.id,
                    workspaceNavigationIdentity: current.navigationIdentity,
                    workspaceName: current.name || '',
                    action: 'reveal-workspace-session',
                    provider: provider.id,
                    sessionId: session.id,
                    name: session.name || session.id,
                    updatedAt: session.updatedAt,
                    active: session.active === true,
                    ...(session.worktreeKey ? {
                        worktreeKey: { ...session.worktreeKey },
                    } : {}),
                    ...(worktreeName ? { worktreeName } : {}),
                });
            }));
    }

    const savedProjects = buildSavedProjectSearchItems(groups);
    const skillItems: DashboardSearchSkillItem[] = (skills || []).map(record => ({
        key: `skill:${record.dirPath}`,
        searchText: searchable(record.name, record.description, record.scope, record.source),
        name: record.name,
        description: record.description,
        dirPath: record.dirPath,
        scope: record.scope,
        action: 'reveal-skill' as const,
    }));

    return {
        version: 3,
        sessions,
        worktrees,
        openWorkspaces,
        savedProjects,
        todos: [],
        ...(skillItems.length ? { skills: skillItems } : {}),
    };
}

function worktreeLookupKey(key: WorktreeKey): string {
    return JSON.stringify([key.repositoryKey, key.canonicalWorktreePath]);
}

function getWorktreeDisplayName(row: Extract<WorktreeRowViewModel, { kind: 'ready' }>): string {
    if (row.git.branchRef) {
        return row.git.branchRef.replace(/^refs\/heads\//, '');
    }
    const normalizedPath = row.git.key.canonicalWorktreePath.replace(/[\\/]+$/g, '');
    const pathName = normalizedPath.split(/[\\/]/).pop();
    return pathName || row.git.head.substring(0, 8) || 'worktree';
}

export function serializeDashboardSearchCatalog(
    catalog: DashboardWorkspaceSearchCatalog
): string {
    return JSON.stringify(catalog)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026');
}
