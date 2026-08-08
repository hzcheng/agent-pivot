'use strict';

import type {
    AttentionAggregate,
} from './attentionAggregate';
import type { AiSessionAttentionReason } from './lifecycle';
import type { AiSessionProviderId } from '../models';
import {
    getAttentionProjectKey,
    getAttentionProjectPath,
    getAttentionSessionLookupKey,
    getLogicalAttentionSessionKey,
} from './attentionProject';
import { getAiSessionKey } from './sessionHelpers';

export interface AttentionQueueWorkspaceRoot {
    id: string;
    uri: string;
}

export interface AttentionQueueWorkspaceSession {
    provider: AiSessionProviderId;
    id: string;
    name?: string;
    primaryRootId?: string;
}

export interface AttentionQueueWorkspace {
    roots: readonly AttentionQueueWorkspaceRoot[];
    sessions: readonly AttentionQueueWorkspaceSession[];
}

export interface AttentionQueueItem {
    provider: AiSessionProviderId;
    sessionId: string;
    projectId: string;
    eventIds: string[];
    reasons: AiSessionAttentionReason[];
    observedAtMs: number;
    local: boolean;
    sessionName?: string;
}

export interface AttentionQueue {
    items: AttentionQueueItem[];
    localCount: number;
    remoteCount: number;
    total: number;
}

const ATTENTION_LOGICAL_KEY_PATTERN = /^(codex|kimi|claude):(.+)$/;

/**
 * Derives the actionable attention queue from the effective (cross-window)
 * aggregate. A session is "local" when it matches a session listed in this
 * window's workspace — the same (projectKey, provider:sessionId) pairing the
 * sidebar uses to paint attention dots, so the queue mirrors exactly what the
 * user sees. Local entries lead and each group sorts oldest-first so repeated
 * jumps drain the longest-waiting session next.
 */
export function buildAttentionQueue(input: {
    aggregate: AttentionAggregate | null;
    workspace: AttentionQueueWorkspace | null;
}): AttentionQueue {
    const localLookupKeys = new Set<string>();
    const localNames = new Map<string, string>();
    const workspace = input.workspace;
    if (workspace && workspace.roots.length) {
        const fallbackProjectKey = getAttentionProjectKey(
            getAttentionProjectPath(workspace.roots[0].uri)
        );
        const projectKeyByRootId = new Map(workspace.roots.map(root => [
            root.id,
            getAttentionProjectKey(getAttentionProjectPath(root.uri)),
        ] as const));
        for (const session of workspace.sessions) {
            const projectKey = (session.primaryRootId
                && projectKeyByRootId.get(session.primaryRootId))
                || fallbackProjectKey;
            if (!projectKey) {
                continue;
            }
            const lookupKey = getAttentionSessionLookupKey(
                projectKey,
                getAiSessionKey(session.provider, session.id)
            );
            localLookupKeys.add(lookupKey);
            if (session.name) {
                localNames.set(lookupKey, session.name);
            }
        }
    }
    const items: AttentionQueueItem[] = [];
    for (const session of input.aggregate?.sessions || []) {
        const logicalKey = getLogicalAttentionSessionKey(session.sessionKey);
        const match = ATTENTION_LOGICAL_KEY_PATTERN.exec(logicalKey);
        if (!match) {
            continue;
        }
        const lookupKey = getAttentionSessionLookupKey(
            session.projectId,
            logicalKey
        );
        const local = localLookupKeys.has(lookupKey);
        items.push({
            provider: match[1] as AiSessionProviderId,
            sessionId: match[2],
            projectId: session.projectId,
            eventIds: session.eventIds.slice(),
            reasons: session.reasons.slice(),
            observedAtMs: session.observedAtMs,
            local,
            ...(local && localNames.has(lookupKey)
                ? { sessionName: localNames.get(lookupKey) }
                : {}),
        });
    }
    items.sort((left, right) =>
        (left.local === right.local ? 0 : left.local ? -1 : 1)
        || left.observedAtMs - right.observedAtMs
        || left.sessionId.localeCompare(right.sessionId));
    const localCount = items.filter(item => item.local).length;
    return {
        items,
        localCount,
        remoteCount: items.length - localCount,
        total: items.length,
    };
}

function attentionProviderLabel(provider: AiSessionProviderId): string {
    if (provider === 'kimi') {
        return 'Kimi';
    }
    if (provider === 'claude') {
        return 'Claude';
    }
    return 'Codex';
}

function attentionReasonLabel(reason: AiSessionAttentionReason): string {
    return reason === 'input-required' ? 'needs input' : reason;
}

function formatAttentionAge(ageMs: number): string {
    const seconds = Math.max(0, Math.floor(ageMs / 1000));
    if (seconds < 60) {
        return `${seconds}s ago`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m ago`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
        return `${hours}h ago`;
    }
    return `${Math.floor(hours / 24)}d ago`;
}

export interface AttentionStatusBarPresentation {
    text: string;
    tooltip: string;
}

export function formatAttentionStatusBar(
    queue: AttentionQueue,
    nowMs: () => number
): AttentionStatusBarPresentation {
    if (!queue.total) {
        return { text: '', tooltip: '' };
    }
    const lines = [
        `${queue.total} AI session${queue.total === 1 ? ' needs' : 's need'} attention`,
    ];
    const now = nowMs();
    for (const item of queue.items) {
        if (!item.local) {
            continue;
        }
        const reasons = item.reasons.map(attentionReasonLabel).join(', ');
        lines.push(`${attentionProviderLabel(item.provider)} · ${
            item.sessionName || item.sessionId
        } — ${reasons} · ${formatAttentionAge(now - item.observedAtMs)}`);
    }
    if (queue.remoteCount) {
        lines.push(`… and ${queue.remoteCount} more in other windows`);
    }
    lines.push('', 'Click to jump to the next session.');
    return { text: `$(bell) ${queue.total}`, tooltip: lines.join('\n') };
}
