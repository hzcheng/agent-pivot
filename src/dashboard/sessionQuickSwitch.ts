'use strict';

import type { AiSessionProviderId } from '../models';
import type {
    ActiveAiSessionExecutionState,
    ActiveAiSessionViewModel,
} from '../aiSessions/types';
import { getAiSessionKey } from '../aiSessions/sessionHelpers';
import type { AiSessionMruTracker } from '../aiSessions/sessionMru';
import {
    createSessionNavigationCoordinator,
    SessionNavigationCoordinator,
} from './sessionNavigationCoordinator';
import type {
    SessionNavigationFocusExecutionOptions,
    SessionNavigationFocusResult,
} from './sessionNavigationFocusExecutor';

export interface AiSessionSwitchRemoteWindow {
    cardId: string;
    navigationIdentity: string;
    displayName: string;
    runningSessionCount: number;
}

export type AiSessionSwitchTarget =
    | {
        kind: 'local';
        key: string;
        provider: AiSessionProviderId;
        sessionId: string;
    }
    | {
        kind: 'remote';
        key: string;
        cardId: string;
        navigationIdentity: string;
        displayName: string;
        runningSessionCount: number;
    };

export interface AiSessionSwitchPickItem {
    label: string;
    description: string;
    target: AiSessionSwitchTarget;
}

function providerLabel(provider: AiSessionProviderId): string {
    if (provider === 'kimi') {
        return 'Kimi';
    }
    if (provider === 'claude') {
        return 'Claude';
    }
    return 'Codex';
}

function executionStateLabel(executionState: ActiveAiSessionExecutionState): string {
    return executionState === 'running'
        ? 'Running'
        : executionState === 'starting' ? 'Starting' : 'Stopped';
}

/**
 * Builds the QuickPick items for the global session switcher: every live
 * local session (most-recently focused first, stable key order after that),
 * then one entry per other window that reported running sessions. Remote
 * entries stay window-granular because the Open Windows channel publishes
 * running counts, not per-session identities.
 */
export function buildAiSessionSwitchItems(input: {
    localSessions: readonly ActiveAiSessionViewModel[];
    remoteWindows: readonly AiSessionSwitchRemoteWindow[];
    mruOrder: readonly string[];
}): AiSessionSwitchPickItem[] {
    const mruIndex = new Map(input.mruOrder.map((key, index) => [key, index] as const));
    const locals: AiSessionSwitchPickItem[] = [];
    const seen = new Set<string>();
    for (const session of input.localSessions || []) {
        if (!session || typeof session.sessionId !== 'string' || !session.sessionId) {
            continue;
        }
        const key = getAiSessionKey(session.provider, session.sessionId);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        const badges = [providerLabel(session.provider), executionStateLabel(session.executionState)];
        if (session.focused) {
            badges.push('Focused');
        }
        if (session.needsAttention) {
            badges.push('Needs attention');
        }
        locals.push({
            label: `$(terminal) ${session.name || session.sessionId}`,
            description: badges.join(' · '),
            target: {
                kind: 'local',
                key,
                provider: session.provider,
                sessionId: session.sessionId,
            },
        });
    }
    locals.sort((left, right) =>
        (mruIndex.get(left.target.key) ?? Number.MAX_SAFE_INTEGER)
            - (mruIndex.get(right.target.key) ?? Number.MAX_SAFE_INTEGER)
        || left.target.key.localeCompare(right.target.key));
    const remotes: AiSessionSwitchPickItem[] = [];
    const seenWindows = new Set<string>();
    for (const window of input.remoteWindows || []) {
        if (!window
            || typeof window.navigationIdentity !== 'string'
            || !window.navigationIdentity
            || typeof window.cardId !== 'string'
            || !window.cardId
            || !Number.isSafeInteger(window.runningSessionCount)
            || window.runningSessionCount < 1) {
            continue;
        }
        if (seenWindows.has(window.navigationIdentity)) {
            continue;
        }
        seenWindows.add(window.navigationIdentity);
        remotes.push({
            label: `$(arrow-right) ${window.displayName || 'another window'}`,
            description: `${window.runningSessionCount} running session${
                window.runningSessionCount === 1 ? '' : 's'
            } in another window`,
            target: {
                kind: 'remote',
                key: `window:${window.navigationIdentity}`,
                cardId: window.cardId,
                navigationIdentity: window.navigationIdentity,
                displayName: window.displayName,
                runningSessionCount: window.runningSessionCount,
            },
        });
    }
    remotes.sort((left, right) => left.target.key.localeCompare(right.target.key));
    return [...locals, ...remotes];
}

export interface AiSessionQuickSwitchOptions {
    navigationCoordinator?: SessionNavigationCoordinator;
    getLocalSessions: () => readonly ActiveAiSessionViewModel[];
    getRemoteWindows: () => readonly AiSessionSwitchRemoteWindow[];
    getFocusedSessionKey: () => string | null;
    mru: AiSessionMruTracker;
    showPick: (
        items: readonly AiSessionSwitchPickItem[],
        placeHolder: string
    ) => Promise<AiSessionSwitchPickItem | undefined>;
    navigateSession: (
        target: {
            provider: AiSessionProviderId;
            sessionId: string;
        },
        executionOptions: SessionNavigationFocusExecutionOptions,
    ) => Promise<SessionNavigationFocusResult>;
    requestRemoteFocus: (target: AiSessionSwitchRemoteWindow) => Promise<boolean>;
    openNavigationCard: (cardId: string) => Promise<void>;
    showInformationMessage: (message: string) => void;
    showWarningMessage: (message: string) => void;
    onNavigationIntent?: () => void;
}

export interface AiSessionQuickSwitchHandlers {
    switchToAiSession(): Promise<void>;
    toggleLastAiSession(): Promise<void>;
}

/**
 * Direct session navigation: the switcher jumps to a picked session (or a
 * window with running sessions, through the focus mailbox), and the toggle
 * alternates between the two most recently focused local sessions like an
 * AI-session alt-tab. Both share the jump wiring with the running-session
 * cycle.
 */
export function createAiSessionQuickSwitchHandlers(
    options: AiSessionQuickSwitchOptions
): AiSessionQuickSwitchHandlers {
    const navigationCoordinator = options.navigationCoordinator
        || createSessionNavigationCoordinator();

    async function jumpToLocal(target: {
        provider: AiSessionProviderId;
        sessionId: string;
    }): Promise<void> {
        const result = await options.navigateSession(target, {
            onFocused: () => options.mru.record(target.provider, target.sessionId),
        });
        if (!result.focused) {
            options.showWarningMessage(
                'Agent Pivot: the selected AI session is no longer active.'
            );
        }
    }

    async function jumpToRemote(target: AiSessionSwitchRemoteWindow): Promise<void> {
        let handedOff = false;
        try {
            handedOff = await options.requestRemoteFocus(target);
        } catch (_error) {
            // A missing or failing handoff channel degrades to a plain window
            // switch; navigation below still moves the user closer.
            handedOff = false;
        }
        await options.openNavigationCard(target.cardId);
        if (!handedOff) {
            options.showInformationMessage(
                `Agent Pivot: switched to ${target.displayName || 'the other window'};`
                    + ' run Next Running Session there to focus a session.'
            );
        }
    }

    async function switchToAiSession(): Promise<void> {
        const items = buildAiSessionSwitchItems({
            localSessions: options.getLocalSessions(),
            remoteWindows: options.getRemoteWindows(),
            mruOrder: options.mru.entries().map(entry => entry.key),
        });
        if (!items.length) {
            options.showInformationMessage('Agent Pivot: no active AI sessions.');
            return;
        }
        const picked = await options.showPick(
            items,
            'Select an AI session to focus'
        );
        if (!picked) {
            return;
        }
        options.onNavigationIntent?.();
        if (picked.target.kind === 'local') {
            const target = picked.target;
            await navigationCoordinator.enqueueLatest(() => jumpToLocal(target));
            return;
        }
        const target = picked.target;
        await navigationCoordinator.enqueueLatest(() => jumpToRemote(target));
    }

    async function toggleLastAiSessionTransaction(): Promise<void> {
        const liveByKey = new Map<string, ActiveAiSessionViewModel & { sessionId: string }>();
        for (const session of options.getLocalSessions()) {
            if (session && typeof session.sessionId === 'string' && session.sessionId) {
                liveByKey.set(
                    getAiSessionKey(session.provider, session.sessionId),
                    session as ActiveAiSessionViewModel & { sessionId: string }
                );
            }
        }
        options.mru.prune(new Set(liveByKey.keys()));
        const targetKey = options.mru.mostRecentKey(options.getFocusedSessionKey());
        const target = targetKey ? liveByKey.get(targetKey) : undefined;
        if (!target) {
            options.showInformationMessage(
                'Agent Pivot: no previous AI session in this window.'
            );
            return;
        }
        await jumpToLocal({
            provider: target.provider,
            sessionId: target.sessionId,
        });
    }

    async function toggleLastAiSession(): Promise<void> {
        // Toggle is relative to current MRU/focus state, so every press must
        // run in order rather than be dropped as a stale absolute target.
        await navigationCoordinator.enqueue(toggleLastAiSessionTransaction);
    }

    return {
        switchToAiSession,
        toggleLastAiSession,
    };
}
