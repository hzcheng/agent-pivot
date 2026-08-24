'use strict';

import type { AiSessionProviderId } from '../models';

export interface SessionNavigationFocusTarget {
    provider: AiSessionProviderId;
    sessionId: string;
}

export interface SessionNavigationFocusResult {
    focused: boolean;
    conversationOpened: boolean;
}

export interface SessionNavigationFocusExecutionOptions {
    onFocused?(): void;
}

export interface SessionNavigationTiming {
    outcome: 'unavailable' | 'focus-failed' | 'focus-error' | 'conversation-opened'
        | 'conversation-unavailable' | 'conversation-error';
    focusMs: number;
    conversationMs: number;
    totalMs: number;
}

export interface SessionNavigationFocusExecutor {
    execute(
        target: SessionNavigationFocusTarget,
        executionOptions?: SessionNavigationFocusExecutionOptions,
    ): Promise<SessionNavigationFocusResult>;
}

export interface SessionNavigationFocusExecutorOptions {
    getProjectId(): string | null;
    focusActive(
        projectId: string,
        provider: AiSessionProviderId,
        sessionId: string,
    ): Promise<boolean>;
    openConversation(request: {
        projectId: string;
        provider: AiSessionProviderId;
        sessionId: string;
    }): Promise<boolean>;
    onFocused?(target: SessionNavigationFocusTarget): void;
    /** Receives timing only; no workspace, provider, or session identity. */
    onTiming?(timing: SessionNavigationTiming): void;
    now?(): number;
}

/**
 * Executes the local, user-visible portion of an AI session navigation as one
 * transaction. The project is resolved once so a refresh or window handoff
 * cannot make terminal focus and conversation open target different cards.
 */
export function createSessionNavigationFocusExecutor(
    options: SessionNavigationFocusExecutorOptions,
): SessionNavigationFocusExecutor {
    return {
        async execute(
            target: SessionNavigationFocusTarget,
            executionOptions: SessionNavigationFocusExecutionOptions = {},
        ): Promise<SessionNavigationFocusResult> {
            const now = options.now || (() => Date.now());
            const startedAt = now();
            const report = (
                outcome: SessionNavigationTiming['outcome'],
                focusMs: number,
                conversationMs: number,
            ): void => {
                try {
                    options.onTiming?.({
                        outcome,
                        focusMs: Math.max(0, focusMs),
                        conversationMs: Math.max(0, conversationMs),
                        totalMs: Math.max(0, now() - startedAt),
                    });
                } catch (_error) {
                    // Diagnostics must not affect user navigation.
                }
            };
            const projectId = options.getProjectId();
            if (!projectId) {
                report('unavailable', 0, 0);
                return { focused: false, conversationOpened: false };
            }
            const focusStartedAt = now();
            let focused: boolean;
            try {
                focused = await options.focusActive(
                    projectId,
                    target.provider,
                    target.sessionId,
                );
            } catch (error) {
                report('focus-error', now() - focusStartedAt, 0);
                throw error;
            }
            const focusMs = now() - focusStartedAt;
            if (!focused) {
                report('focus-failed', focusMs, 0);
                return { focused: false, conversationOpened: false };
            }
            options.onFocused?.(target);
            executionOptions.onFocused?.();
            const conversationStartedAt = now();
            let conversationOpened: boolean;
            try {
                conversationOpened = await options.openConversation({
                    projectId,
                    provider: target.provider,
                    sessionId: target.sessionId,
                });
            } catch (error) {
                report('conversation-error', focusMs, now() - conversationStartedAt);
                throw error;
            }
            report(
                conversationOpened ? 'conversation-opened' : 'conversation-unavailable',
                focusMs,
                now() - conversationStartedAt,
            );
            return { focused: true, conversationOpened };
        },
    };
}
