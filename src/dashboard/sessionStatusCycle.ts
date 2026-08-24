'use strict';

import type { AiSessionProviderId } from '../models';
import type { ConversationSessionStatusKind } from '../aiSessions/conversation/sessionStatusController';
import {
    createSessionNavigationCoordinator,
    SessionNavigationCoordinator,
} from './sessionNavigationCoordinator';
import type {
    SessionNavigationFocusExecutionOptions,
    SessionNavigationFocusResult,
} from './sessionNavigationFocusExecutor';

export interface SessionStatusCycleItem {
    provider: AiSessionProviderId;
    sessionId: string;
}

/** The session the user is currently watching, when it is a known AI session. */
export interface SessionStatusCycleAnchor {
    provider: AiSessionProviderId;
    sessionId: string;
}

export type SessionStatusCycleAnchorSource = SessionStatusCycleAnchor
    | (() => SessionStatusCycleAnchor | undefined);

export interface SessionStatusCycleHandlerOptions {
    navigationCoordinator?: SessionNavigationCoordinator;
    buildItems: (
        kind: ConversationSessionStatusKind
    ) => SessionStatusCycleItem[];
    navigateSession: (
        item: SessionStatusCycleItem,
        executionOptions: SessionNavigationFocusExecutionOptions,
    ) => Promise<SessionNavigationFocusResult>;
    showInformationMessage: (message: string) => void;
    showWarningMessage: (message: string) => void;
}

export interface SessionStatusCycleHandler {
    cycleToNext(
        kind: ConversationSessionStatusKind,
        anchor?: SessionStatusCycleAnchorSource
    ): Promise<void>;
}

const EMPTY_MESSAGES: Record<ConversationSessionStatusKind, string> = {
    running: 'Agent Pivot: no running AI sessions in this window.',
    attention: 'Agent Pivot: no AI sessions need attention in this window.',
    idle: 'Agent Pivot: no idle AI sessions in this window.',
};

function itemKey(item: SessionStatusCycleItem | SessionStatusCycleAnchor): string {
    return `${item.provider}:${item.sessionId}`;
}

/**
 * Advances a per-kind cursor through this window's sessions of one lifecycle
 * group, one step per invocation, focusing the session terminal and opening
 * its conversation. The watched session anchors the cycle: a click that finds
 * the user looking at a different session of the same kind than the cursor
 * remembers continues after the watched one instead of the stale cursor. The
 * cursor advances even when a jump fails, so a session that ended mid-cycle
 * is skipped by the next click instead of trapping the user on a dead target.
 */
export function createSessionStatusCycleHandler(
    options: SessionStatusCycleHandlerOptions
): SessionStatusCycleHandler {
    const lastKeyByKind: Record<ConversationSessionStatusKind, string | null> = {
        running: null,
        attention: null,
        idle: null,
    };
    const navigationCoordinator = options.navigationCoordinator
        || createSessionNavigationCoordinator();

    async function cycleToNext(
        kind: ConversationSessionStatusKind,
        anchor?: SessionStatusCycleAnchorSource
    ): Promise<void> {
        const seen = new Set<string>();
        const items = options.buildItems(kind)
            .filter(item => Boolean(item)
                && typeof item.sessionId === 'string'
                && item.sessionId.length > 0)
            .filter(item => {
                const key = itemKey(item);
                if (seen.has(key)) {
                    return false;
                }
                seen.add(key);
                return true;
            });
        if (!items.length) {
            options.showInformationMessage(EMPTY_MESSAGES[kind]);
            return;
        }
        const resolvedAnchor = typeof anchor === 'function' ? anchor() : anchor;
        const anchorKey = resolvedAnchor ? itemKey(resolvedAnchor) : null;
        const anchorIndex = anchorKey
            ? items.findIndex(item => itemKey(item) === anchorKey)
            : -1;
        const lastKey = lastKeyByKind[kind];
        const lastIndex = lastKey
            ? items.findIndex(item => itemKey(item) === lastKey)
            : -1;
        let next: SessionStatusCycleItem;
        if (anchorIndex >= 0 && anchorKey !== lastKey) {
            // A focus change that was not produced by this handler is a manual
            // detour. Re-anchor to what the user is actually watching.
            next = items[(anchorIndex + 1) % items.length];
        } else if (lastIndex >= 0) {
            next = items[(lastIndex + 1) % items.length];
        } else if (anchorIndex >= 0) {
            next = items[(anchorIndex + 1) % items.length];
        } else {
            next = items[0];
        }
        const nextKey = itemKey(next);
        const result = await options.navigateSession(next, {
            onFocused: () => {
                lastKeyByKind[kind] = nextKey;
            },
        });
        if (!result.focused) {
            lastKeyByKind[kind] = nextKey;
            options.showWarningMessage(
                'Agent Pivot: the selected AI session is no longer active.'
            );
        }
    }

    return {
        // Status cycling is relative to the cursor; preserve every press.
        cycleToNext: (kind, anchor) => navigationCoordinator.enqueue(
            () => cycleToNext(kind, anchor)
        ),
    };
}
