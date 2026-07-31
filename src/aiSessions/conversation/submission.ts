'use strict';

import type { AiSessionProviderId } from '../../models';
import type { AiSessionRuntimeActionResult, AiSessionRuntimeSnapshot } from '../runtimeTypes';
import type { WorkspaceAiSessionActionTarget } from '../types';
import { ConversationCommentError, ConversationCommentTarget } from './comments';

export interface ConversationPromptTerminal {
    sendText(text: string, addNewLine?: boolean): void;
}

export interface ConversationPromptSubmissionOptions<
    TTerminal extends ConversationPromptTerminal
> {
    getWorkspaceTarget(projectId: string): WorkspaceAiSessionActionTarget | null;
    getRuntime(
        provider: AiSessionProviderId,
        sessionId: string
    ): AiSessionRuntimeSnapshot<TTerminal> | null;
    resume(
        projectId: string,
        provider: AiSessionProviderId,
        sessionId: string,
        rootId: string | undefined,
        prompt?: string
    ): Promise<AiSessionRuntimeActionResult<TTerminal> | undefined>;
}

export async function submitConversationPrompt<
    TTerminal extends ConversationPromptTerminal
>(
    options: ConversationPromptSubmissionOptions<TTerminal>,
    target: ConversationCommentTarget,
    prompt: string
): Promise<void> {
    const workspace = options.getWorkspaceTarget(target.projectId);
    const session = workspace?.sessions.activeSessions.find(candidate =>
        candidate.provider === target.provider
        && candidate.sessionId === target.sessionId
    );
    if (!workspace || !session || typeof prompt !== 'string' || !prompt.trim()) {
        throw new ConversationCommentError('unavailable');
    }
    if (session.conflict || session.status === 'conflict') {
        throw new ConversationCommentError('conflict');
    }
    if (session.executionState === 'running'
        || session.executionState === 'starting') {
        throw new ConversationCommentError('busy');
    }
    const existing = options.getRuntime(target.provider, target.sessionId);
    if (existing?.state === 'conflict') {
        throw new ConversationCommentError('conflict');
    }
    if (existing?.state === 'active' && existing.terminal) {
        existing.terminal.sendText(prompt, false);
        return;
    }
    const result = await options.resume(
        target.projectId,
        target.provider,
        target.sessionId,
        session.primaryRootId,
        undefined
    );
    if (result?.status === 'started' || result?.status === 'focused') {
        const runtime = result.runtime
            || options.getRuntime(target.provider, target.sessionId);
        if (runtime?.terminal) {
            runtime.terminal.sendText(prompt, false);
            return;
        }
        throw new ConversationCommentError('unavailable');
    }
    if (result?.status === 'conflict') {
        throw new ConversationCommentError('conflict');
    }
    if (result?.status === 'blocked') {
        throw new ConversationCommentError('busy');
    }
    throw new ConversationCommentError('unavailable');
}
