'use strict';

import type { AiSessionProviderId } from '../../models';

export interface ConversationAuthoritativeTarget {
    projectId?: string;
    provider: AiSessionProviderId;
    sessionId?: string;
    name?: string;
    conversationDisplayName?: string;
    duplicateConversationDisplayName?: boolean;
    /** Worktree task group display name resolved from the session's
     * worktree key; empty/undefined when the session belongs to no group. */
    conversationTaskName?: string;
    focused: boolean;
    executionState?: string;
}

export function withConversationDisplayMetadata<
    TTarget extends ConversationAuthoritativeTarget
>(
    target: TTarget,
    activeTargets: readonly ConversationAuthoritativeTarget[]
): TTarget & {
    conversationDisplayName: string;
    duplicateConversationDisplayName: boolean;
} {
    const conversationDisplayName = String(target.name || '').trim();
    const normalizedName = normalizeConversationDisplayName(
        conversationDisplayName
    );
    const duplicateConversationDisplayName = Boolean(normalizedName)
        && activeTargets.filter(candidate =>
            candidate.provider === target.provider
            && normalizeConversationDisplayName(candidate.name) === normalizedName
        ).length > 1;
    return {
        ...target,
        conversationDisplayName,
        duplicateConversationDisplayName,
    };
}

function normalizeConversationDisplayName(value: unknown): string {
    return typeof value === 'string'
        ? value.trim().replace(/\s+/g, ' ').toLowerCase()
        : '';
}
