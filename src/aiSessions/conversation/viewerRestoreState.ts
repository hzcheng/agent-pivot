'use strict';

import { isAiSessionProviderId } from '../../models';
import type { AiSessionProviderId } from '../../models';
import { isSubagentId } from './subagentSessions';
import {
    hasExactKeys,
    isConversationViewerTargetId,
} from './viewerProtocol';

export interface ConversationViewerRestoreTarget {
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
    interactionId: string;
    subagentId?: string;
}

export function parseConversationViewerRestoreTarget(
    state: unknown
): ConversationViewerRestoreTarget | undefined {
    if (!isRecord(state)) {
        return undefined;
    }
    const envelope = state.conversationViewer;
    if (!isRecord(envelope)
        || !hasExactKeys(envelope, ['version', 'target'])
        || envelope.version !== 1
        || !isRecord(envelope.target)) {
        return undefined;
    }
    const target = envelope.target;
    const keys = Object.keys(target);
    const hasSubagent = Object.prototype.hasOwnProperty.call(
        target,
        'subagentId'
    );
    if (!hasExactKeys(target, hasSubagent
        ? ['projectId', 'provider', 'sessionId', 'interactionId', 'subagentId']
        : ['projectId', 'provider', 'sessionId', 'interactionId'])
        || !isConversationViewerTargetId(target.projectId)
        || typeof target.provider !== 'string'
        || !isAiSessionProviderId(target.provider)
        || !isConversationViewerTargetId(target.sessionId)
        || !isConversationViewerTargetId(target.interactionId)
        || (hasSubagent && (typeof target.subagentId !== 'string'
            || !isSubagentId(target.subagentId)))) {
        return undefined;
    }
    return {
        projectId: target.projectId,
        provider: target.provider,
        sessionId: target.sessionId,
        interactionId: target.interactionId,
        ...(hasSubagent ? { subagentId: target.subagentId as string } : {}),
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value)
        && typeof value === 'object'
        && !Array.isArray(value);
}
