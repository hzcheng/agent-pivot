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
            const projectId = options.getProjectId();
            if (!projectId) {
                return { focused: false, conversationOpened: false };
            }
            const focused = await options.focusActive(
                projectId,
                target.provider,
                target.sessionId,
            );
            if (!focused) {
                return { focused: false, conversationOpened: false };
            }
            options.onFocused?.(target);
            executionOptions.onFocused?.();
            const conversationOpened = await options.openConversation({
                projectId,
                provider: target.provider,
                sessionId: target.sessionId,
            });
            return { focused: true, conversationOpened };
        },
    };
}
