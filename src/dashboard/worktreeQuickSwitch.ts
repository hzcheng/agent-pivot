'use strict';

import type { AiSessionProviderId } from '../models';
import type {
    AiSessionViewModel,
    ReadyWorktreeRow,
    WorkspaceAiSessionActionTarget,
} from '../aiSessions/types';
import type { WorktreeKey } from '../worktrees';
import { worktreeKeysEqual } from '../worktrees';

export type WorktreeOrSessionSwitchTarget =
    | {
        kind: 'session';
        provider: AiSessionProviderId;
        sessionId: string;
        active: boolean;
    }
    | {
        kind: 'worktree';
        key: WorktreeKey;
    };

export interface WorktreeOrSessionSwitchItem {
    label: string;
    description: string;
    target: WorktreeOrSessionSwitchTarget;
}

interface SortableSwitchItem extends WorktreeOrSessionSwitchItem {
    priority: number;
    recentAt: number;
    stableKey: string;
}

function providerLabel(provider: AiSessionProviderId): string {
    return provider === 'kimi' ? 'Kimi' : provider === 'claude' ? 'Claude' : 'Codex';
}

export function getWorktreeSwitchLabel(worktree: ReadyWorktreeRow): string {
    if (worktree.git.branchRef) {
        return worktree.git.branchRef.replace(/^refs\/heads\//, '');
    }
    const pathName = worktree.git.key.canonicalWorktreePath
        .replace(/[\\/]+$/g, '')
        .split(/[\\/]/)
        .pop();
    return pathName || worktree.git.head.substring(0, 8) || 'worktree';
}

export function buildWorktreeOrSessionSwitchItems(
    target: WorkspaceAiSessionActionTarget | null,
): WorktreeOrSessionSwitchItem[] {
    if (!target) {
        return [];
    }
    const rows = (target.sessions.worktrees || [])
        .filter((row): row is ReadyWorktreeRow => row.kind === 'ready' && !row.git.isBare);
    const activeBySession = new Map<string, boolean>();
    for (const session of target.sessions.activeSessions || []) {
        if (session.sessionId) {
            activeBySession.set(`${session.provider}:${session.sessionId}`, true);
        }
    }
    const items: SortableSwitchItem[] = rows.map(row => {
        const label = getWorktreeSwitchLabel(row);
        const attention = row.activity === 'attention';
        return {
            label: `${attention ? '$(bell)' : '$(git-branch)'} ${label}`,
            description: `Worktree · ${attention ? 'Needs attention' : row.activity === 'active' ? 'Active' : 'Idle'}`,
            target: { kind: 'worktree', key: { ...row.git.key } },
            priority: attention ? 0 : row.activity === 'active' ? 4 : 5,
            recentAt: 0,
            stableKey: `worktree:${JSON.stringify([row.git.key.repositoryKey, row.git.key.canonicalWorktreePath])}`,
        };
    });
    const seenSessions = new Set<string>();
    const providers: AiSessionProviderId[] = ['codex', 'kimi', 'claude'];
    for (const provider of providers) {
        for (const session of target.sessions.sessionsByProvider[provider] || []) {
            const sessionKey = `${provider}:${session.id}`;
            if (!session.id || seenSessions.has(sessionKey)) {
                continue;
            }
            seenSessions.add(sessionKey);
            const active = activeBySession.has(sessionKey);
            const worktree = session.worktreeKey
                ? rows.find(row => worktreeKeysEqual(row.git.key, session.worktreeKey as WorktreeKey))
                : undefined;
            const attention = session.attention?.unread === true
                || (target.sessions.activeSessions || []).some(candidate =>
                    candidate.provider === provider
                    && candidate.sessionId === session.id
                    && candidate.needsAttention);
            const status = active ? 'Active' : 'Recent';
            const worktreeLabel = worktree ? getWorktreeSwitchLabel(worktree) : 'Unmanaged';
            items.push({
                label: `${active ? '$(terminal)' : '$(comment-discussion)'} ${session.name || session.id}`,
                description: `${providerLabel(provider)} · ${status}${attention ? ' · Needs attention' : ''} · ${worktreeLabel}`,
                target: { kind: 'session', provider, sessionId: session.id, active },
                priority: active ? (attention ? 1 : 2) : 3,
                recentAt: parseTimestamp(session),
                stableKey: `session:${sessionKey}`,
            });
        }
    }
    for (const session of target.sessions.activeSessions || []) {
        if (!session.sessionId) {
            continue;
        }
        const sessionKey = `${session.provider}:${session.sessionId}`;
        if (seenSessions.has(sessionKey)) {
            continue;
        }
        seenSessions.add(sessionKey);
        const worktree = session.worktreeKey
            ? rows.find(row => worktreeKeysEqual(row.git.key, session.worktreeKey as WorktreeKey))
            : undefined;
        const worktreeLabel = worktree ? getWorktreeSwitchLabel(worktree) : 'Unmanaged';
        items.push({
            label: `$(terminal) ${session.name || session.sessionId}`,
            description: `${providerLabel(session.provider)} · Active${session.needsAttention ? ' · Needs attention' : ''} · ${worktreeLabel}`,
            target: {
                kind: 'session',
                provider: session.provider,
                sessionId: session.sessionId,
                active: true,
            },
            priority: session.needsAttention ? 1 : 2,
            recentAt: parseActiveTimestamp(session.updatedAt),
            stableKey: `session:${sessionKey}`,
        });
    }
    return items
        .sort((left, right) => left.priority - right.priority
            || right.recentAt - left.recentAt
            || left.stableKey.localeCompare(right.stableKey))
        .map(({ priority: _priority, recentAt: _recentAt, stableKey: _stableKey, ...item }) => item);
}

function parseTimestamp(session: AiSessionViewModel): number {
    return parseActiveTimestamp(session.updatedAt);
}

function parseActiveTimestamp(value: string | undefined): number {
    const timestamp = Date.parse(value || '');
    return Number.isFinite(timestamp) ? timestamp : 0;
}

export interface WorktreeOrSessionSwitchHandlerOptions {
    getWorkspaceTarget: () => WorkspaceAiSessionActionTarget | null;
    showPick: (
        items: readonly WorktreeOrSessionSwitchItem[],
        placeHolder: string,
    ) => Promise<WorktreeOrSessionSwitchItem | undefined>;
    focusSession: (
        projectId: string,
        provider: AiSessionProviderId,
        sessionId: string,
    ) => Promise<boolean>;
    resumeSession: (
        projectId: string,
        provider: AiSessionProviderId,
        sessionId: string,
    ) => Promise<unknown>;
    revealWorktree: (navigationIdentity: string, key: WorktreeKey) => Promise<unknown>;
    showInformationMessage: (message: string) => unknown;
    showWarningMessage: (message: string) => unknown;
}

export function createWorktreeOrSessionSwitchHandler(
    options: WorktreeOrSessionSwitchHandlerOptions,
): () => Promise<void> {
    return async () => {
        const target = options.getWorkspaceTarget();
        const items = buildWorktreeOrSessionSwitchItems(target);
        if (!target || !items.length) {
            options.showInformationMessage('Agent Pivot: no worktrees or AI sessions are available.');
            return;
        }
        const picked = await options.showPick(items, 'Select a worktree or AI session');
        if (!picked) {
            return;
        }
        if (picked.target.kind === 'worktree') {
            await options.revealWorktree(target.workspace.navigationIdentity, picked.target.key);
            return;
        }
        if (picked.target.active) {
            const focused = await options.focusSession(
                target.cardId,
                picked.target.provider,
                picked.target.sessionId,
            );
            if (!focused) {
                options.showWarningMessage(
                    'Agent Pivot: the selected AI session is no longer active.'
                );
            }
            return;
        }
        await options.resumeSession(
            target.cardId,
            picked.target.provider,
            picked.target.sessionId,
        );
    };
}
