'use strict';

import type { AiSessionProviderId } from '../../models';
import { CONVERSATION_COMMENT_LIMITS } from './comments';
import { isSubagentId } from './subagentSessions';

export interface ConversationViewerNavigationMessage {
    type: 'conversation-viewer-previous'
        | 'conversation-viewer-next'
        | 'conversation-viewer-latest';
    version: 1;
}

export interface ConversationViewerSelectInteractionMessage {
    type: 'conversation-viewer-select-interaction';
    version: 1;
    interactionId: string;
}

export interface ConversationViewerOpenLinkMessage {
    type: 'conversation-viewer-open-link';
    version: 1;
    href: string;
}

export interface ConversationViewerCommentMutationMessage {
    type: 'conversation-viewer-comment-mutation';
    version: 1;
    requestId: string;
    subscriptionGeneration: number;
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
    operation: 'add' | 'update' | 'delete' | 'clearDone' | 'clearAll';
    expectedRevision: number;
    payload: unknown;
}

export interface ConversationViewerLocateCommentMessage {
    type: 'conversation-viewer-locate-comment';
    version: 1;
    requestId: string;
    subscriptionGeneration: number;
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
    commentId: string;
}

export interface ConversationViewerSendCommentsMessage {
    type: 'conversation-viewer-send-comments';
    version: 1;
    requestId: string;
    subscriptionGeneration: number;
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
    operation: 'sendComments' | 'sendComment';
    expectedRevision: number;
    payload: Record<string, never> | { commentId: string };
}

export interface ConversationViewerBookmarkMutationMessage {
    type: 'conversation-viewer-bookmark-mutation';
    version: 1;
    requestId: string;
    subscriptionGeneration: number;
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
    operation: 'set';
    expectedRevision: number;
    payload: {
        interactionId: string;
        bookmarked: boolean;
    };
}

export interface ConversationViewerOpenWorktreeMessage {
    type: 'conversation-viewer-open-worktree';
    version: 1;
    worktreeRoot: string;
}

export interface ConversationViewerSendSelectionMessage {
    type: 'conversation-viewer-send-selection';
    version: 1;
    text: string;
}

export interface ConversationViewerOpenSubagentMessage {
    type: 'conversation-viewer-open-subagent';
    version: 1;
    subagentId: string;
}

export interface ConversationViewerCloseSubagentMessage {
    type: 'conversation-viewer-close-subagent';
    version: 1;
}

export type ConversationViewerMessage =
    ConversationViewerNavigationMessage
    | ConversationViewerSelectInteractionMessage
    | ConversationViewerOpenLinkMessage
    | ConversationViewerOpenWorktreeMessage
    | ConversationViewerSendSelectionMessage
    | ConversationViewerOpenSubagentMessage
    | ConversationViewerCloseSubagentMessage
    | ConversationViewerCommentMutationMessage
    | ConversationViewerSendCommentsMessage
    | ConversationViewerLocateCommentMessage
    | ConversationViewerBookmarkMutationMessage;

const NAVIGATION_MESSAGE_TYPES = new Set([
    'conversation-viewer-previous',
    'conversation-viewer-next',
    'conversation-viewer-latest',
]);

export function parseConversationViewerMessage(
    message: unknown
): ConversationViewerMessage | undefined {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return undefined;
    }
    const value = message as { [key: string]: unknown };
    if (value.version !== 1 || typeof value.type !== 'string') {
        return undefined;
    }
    const keys = Object.keys(value);
    if (NAVIGATION_MESSAGE_TYPES.has(value.type)) {
        if (keys.length !== 2
            || !hasOwn(value, 'type')
            || !hasOwn(value, 'version')) {
            return undefined;
        }
        return value as unknown as ConversationViewerNavigationMessage;
    }
    if (value.type === 'conversation-viewer-select-interaction') {
        if (!hasExactKeys(value, ['type', 'version', 'interactionId'])
            || !isConversationViewerTargetId(value.interactionId)) {
            return undefined;
        }
        return value as unknown as
            ConversationViewerSelectInteractionMessage;
    }
    if (value.type === 'conversation-viewer-open-link') {
        if (keys.length !== 3
            || !hasOwn(value, 'type')
            || !hasOwn(value, 'version')
            || !hasOwn(value, 'href')
            || typeof value.href !== 'string') {
            return undefined;
        }
        return value as unknown as ConversationViewerOpenLinkMessage;
    }
    if (value.type === 'conversation-viewer-open-worktree') {
        if (keys.length !== 3
            || !hasOwn(value, 'type')
            || !hasOwn(value, 'version')
            || !hasOwn(value, 'worktreeRoot')
            || typeof value.worktreeRoot !== 'string'
            || !value.worktreeRoot
            || value.worktreeRoot.length > 1024
            || /[\u0000-\u001f\u007f]/.test(value.worktreeRoot)) {
            return undefined;
        }
        return value as unknown as ConversationViewerOpenWorktreeMessage;
    }
    if (value.type === 'conversation-viewer-send-selection') {
        if (keys.length !== 3
            || !hasOwn(value, 'type')
            || !hasOwn(value, 'version')
            || !hasOwn(value, 'text')
            || typeof value.text !== 'string'
            || !value.text.trim()
            || value.text.length > 4000) {
            return undefined;
        }
        return value as unknown as ConversationViewerSendSelectionMessage;
    }
    if (value.type === 'conversation-viewer-open-subagent') {
        if (!hasExactKeys(value, ['type', 'version', 'subagentId'])
            || !isSubagentId(value.subagentId)) {
            return undefined;
        }
        return value as unknown as ConversationViewerOpenSubagentMessage;
    }
    if (value.type === 'conversation-viewer-close-subagent') {
        if (keys.length !== 2
            || !hasOwn(value, 'type')
            || !hasOwn(value, 'version')) {
            return undefined;
        }
        return value as unknown as ConversationViewerCloseSubagentMessage;
    }
    if (value.type === 'conversation-viewer-locate-comment') {
        if (!hasExactKeys(value, [
            'type', 'version', 'requestId', 'subscriptionGeneration',
            'projectId', 'provider', 'sessionId', 'commentId',
        ])
            || !isRequestId(value.requestId)
            || !isPositiveSafeInteger(value.subscriptionGeneration)
            || !isConversationViewerTargetId(value.projectId)
            || !isProvider(value.provider)
            || !isConversationViewerTargetId(value.sessionId)
            || !isConversationViewerTargetId(value.commentId)) {
            return undefined;
        }
        return value as unknown as ConversationViewerLocateCommentMessage;
    }
    if (value.type === 'conversation-viewer-bookmark-mutation') {
        if (!hasExactKeys(value, [
            'type', 'version', 'requestId', 'subscriptionGeneration',
            'projectId', 'provider', 'sessionId', 'operation',
            'expectedRevision', 'payload',
        ])
            || !isRequestId(value.requestId)
            || !isPositiveSafeInteger(value.subscriptionGeneration)
            || !isConversationViewerTargetId(value.projectId)
            || !isProvider(value.provider)
            || !isConversationViewerTargetId(value.sessionId)
            || value.operation !== 'set'
            || !isNonnegativeSafeInteger(value.expectedRevision)
            || !isRecord(value.payload)
            || !hasExactKeys(value.payload, [
                'interactionId', 'bookmarked',
            ])
            || !isConversationViewerTargetId(value.payload.interactionId)
            || typeof value.payload.bookmarked !== 'boolean') {
            return undefined;
        }
        return value as unknown as ConversationViewerBookmarkMutationMessage;
    }
    if ((value.type !== 'conversation-viewer-comment-mutation'
            && value.type !== 'conversation-viewer-send-comments')
        || keys.length !== 10
        || !hasExactKeys(value, [
            'type', 'version', 'requestId', 'subscriptionGeneration',
            'projectId', 'provider', 'sessionId', 'operation',
            'expectedRevision', 'payload',
        ])
        || !isRequestId(value.requestId)
        || !isPositiveSafeInteger(value.subscriptionGeneration)
        || !isConversationViewerTargetId(value.projectId)
        || !isProvider(value.provider)
        || !isConversationViewerTargetId(value.sessionId)
        || !isNonnegativeSafeInteger(value.expectedRevision)
        || !value.payload
        || typeof value.payload !== 'object'
        || Array.isArray(value.payload)) {
        return undefined;
    }
    if (value.type === 'conversation-viewer-comment-mutation') {
        if (value.operation !== 'add'
            && value.operation !== 'update'
            && value.operation !== 'delete'
            && value.operation !== 'clearDone'
            && value.operation !== 'clearAll') {
            return undefined;
        }
        return value as unknown as ConversationViewerCommentMutationMessage;
    }
    if (value.operation === 'sendComments') {
        if (Object.keys(value.payload as object).length !== 0) {
            return undefined;
        }
        return value as unknown as ConversationViewerSendCommentsMessage;
    }
    if (value.operation !== 'sendComment'
        || !hasExactKeys(value.payload as object, ['commentId'])
        || !isConversationViewerTargetId(
            (value.payload as { commentId: unknown }).commentId
        )) {
        return undefined;
    }
    return value as unknown as ConversationViewerSendCommentsMessage;
}

export function hasExactKeys(
    value: object,
    expected: readonly string[]
): boolean {
    const keys = Object.keys(value);
    return keys.length === expected.length
        && expected.every(key => hasOwn(value, key));
}

export function isConversationViewerTargetId(
    value: unknown
): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= CONVERSATION_COMMENT_LIMITS.maxIdLength
        && !/[\u0000-\u001f\u007f]/.test(value);
}

function hasOwn(value: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value)
        && typeof value === 'object'
        && !Array.isArray(value);
}

function isRequestId(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= 128
        && /^[A-Za-z0-9._:-]+$/.test(value);
}

function isProvider(value: unknown): value is AiSessionProviderId {
    return value === 'codex' || value === 'kimi' || value === 'claude';
}

function isPositiveSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}
