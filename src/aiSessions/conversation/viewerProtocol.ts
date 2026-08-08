'use strict';

import type { AiSessionProviderId } from '../../models';
import {
    CONVERSATION_COMMENT_MUTATION_OPERATIONS,
    ConversationCommentMutationOperation,
    ConversationCommentSendOperation,
} from './comments';
import {
    PROJECT_COMMENT_MUTATION_OPERATIONS,
    ProjectCommentMutationOperation,
    ProjectCommentSendOperation,
} from './projectComments';
import {
    isAiSessionProvider,
    isBoundedId,
    isRecord,
} from './commentPrimitives';
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
    operation: ConversationCommentMutationOperation;
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

export type ConversationViewerProjectCommentOperation =
    ProjectCommentMutationOperation;

export interface ConversationViewerProjectCommentMutationMessage {
    type: 'conversation-viewer-project-comment-mutation';
    version: 1;
    requestId: string;
    subscriptionGeneration: number;
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
    operation: ConversationViewerProjectCommentOperation;
    expectedRevision: number;
    payload: unknown;
}

export interface ConversationViewerSendProjectCommentMessage {
    type: 'conversation-viewer-send-project-comment';
    version: 1;
    requestId: string;
    subscriptionGeneration: number;
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
    operation: ProjectCommentSendOperation;
    expectedRevision: number;
    payload: unknown;
}

export interface ConversationViewerSendCommentsMessage {
    type: 'conversation-viewer-send-comments';
    version: 1;
    requestId: string;
    subscriptionGeneration: number;
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
    operation: ConversationCommentSendOperation;
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

export const CONVERSATION_COPY_MAX_TEXT_LENGTH = 1_000_000;

export interface ConversationViewerCopyMessage {
    type: 'conversation-viewer-copy';
    version: 1;
    requestId: string;
    subscriptionGeneration: number;
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
    operation: 'copy';
    payload: {
        kind: 'code';
        text: string;
    } | {
        kind: 'message';
        messageId: string;
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

export type ConversationSessionSwitchDirection = 'previous' | 'next';

export interface ConversationViewerSwitchSessionMessage {
    type: 'conversation-viewer-switch-session';
    version: 1;
    direction: ConversationSessionSwitchDirection;
}

export interface ConversationViewerFocusMessage {
    type: 'conversation-viewer-focus';
    version: 1;
    focused: boolean;
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
    | ConversationViewerSwitchSessionMessage
    | ConversationViewerFocusMessage
    | ConversationViewerOpenSubagentMessage
    | ConversationViewerCloseSubagentMessage
    | ConversationViewerCommentMutationMessage
    | ConversationViewerSendCommentsMessage
    | ConversationViewerLocateCommentMessage
    | ConversationViewerProjectCommentMutationMessage
    | ConversationViewerSendProjectCommentMessage
    | ConversationViewerBookmarkMutationMessage
    | ConversationViewerCopyMessage;

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
    if (value.type === 'conversation-viewer-switch-session') {
        if (!hasExactKeys(value, ['type', 'version', 'direction'])
            || (value.direction !== 'previous'
                && value.direction !== 'next')) {
            return undefined;
        }
        return value as unknown as ConversationViewerSwitchSessionMessage;
    }
    if (value.type === 'conversation-viewer-focus') {
        if (!hasExactKeys(value, ['type', 'version', 'focused'])
            || typeof value.focused !== 'boolean') {
            return undefined;
        }
        return value as unknown as ConversationViewerFocusMessage;
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
            || !isAiSessionProvider(value.provider)
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
            || !isAiSessionProvider(value.provider)
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
    if (value.type === 'conversation-viewer-copy') {
        if (!hasExactKeys(value, [
            'type', 'version', 'requestId', 'subscriptionGeneration',
            'projectId', 'provider', 'sessionId', 'operation', 'payload',
        ])
            || !isRequestId(value.requestId)
            || !isPositiveSafeInteger(value.subscriptionGeneration)
            || !isConversationViewerTargetId(value.projectId)
            || !isAiSessionProvider(value.provider)
            || !isConversationViewerTargetId(value.sessionId)
            || value.operation !== 'copy'
            || !isRecord(value.payload)) {
            return undefined;
        }
        if (value.payload.kind === 'code') {
            if (!hasExactKeys(value.payload, ['kind', 'text'])
                || typeof value.payload.text !== 'string'
                || value.payload.text.length
                    > CONVERSATION_COPY_MAX_TEXT_LENGTH) {
                return undefined;
            }
            return value as unknown as ConversationViewerCopyMessage;
        }
        if (value.payload.kind === 'message'
            && hasExactKeys(value.payload, ['kind', 'messageId'])
            && isConversationViewerTargetId(value.payload.messageId)) {
            return value as unknown as ConversationViewerCopyMessage;
        }
        return undefined;
    }
    if (value.type === 'conversation-viewer-project-comment-mutation'
        || value.type === 'conversation-viewer-send-project-comment') {
        if (keys.length !== 10
            || !hasExactKeys(value, [
                'type', 'version', 'requestId', 'subscriptionGeneration',
                'projectId', 'provider', 'sessionId', 'operation',
                'expectedRevision', 'payload',
            ])
            || !isRequestId(value.requestId)
            || !isPositiveSafeInteger(value.subscriptionGeneration)
            || !isConversationViewerTargetId(value.projectId)
            || !isAiSessionProvider(value.provider)
            || !isConversationViewerTargetId(value.sessionId)
            || !isNonnegativeSafeInteger(value.expectedRevision)
            || !value.payload
            || typeof value.payload !== 'object'
            || Array.isArray(value.payload)) {
            return undefined;
        }
        if (value.type === 'conversation-viewer-project-comment-mutation') {
            if (!isListedOperation(
                value.operation,
                PROJECT_COMMENT_MUTATION_OPERATIONS
            )) {
                return undefined;
            }
            return value as unknown as
                ConversationViewerProjectCommentMutationMessage;
        }
        if (value.operation === 'sendProjectComments') {
            if (Object.keys(value.payload as object).length !== 0) {
                return undefined;
            }
            return value as unknown as
                ConversationViewerSendProjectCommentMessage;
        }
        if (value.operation !== 'sendProjectComment'
            || !hasExactKeys(value.payload as object, ['commentId'])
            || !isConversationViewerTargetId(
                (value.payload as { commentId: unknown }).commentId
            )) {
            return undefined;
        }
        return value as unknown as
            ConversationViewerSendProjectCommentMessage;
    }
    if (value.type === 'conversation-viewer-comment-mutation'
        || value.type === 'conversation-viewer-send-comments') {
        if (keys.length !== 10
            || !hasExactKeys(value, [
                'type', 'version', 'requestId', 'subscriptionGeneration',
                'projectId', 'provider', 'sessionId', 'operation',
                'expectedRevision', 'payload',
            ])
            || !isRequestId(value.requestId)
            || !isPositiveSafeInteger(value.subscriptionGeneration)
            || !isConversationViewerTargetId(value.projectId)
            || !isAiSessionProvider(value.provider)
            || !isConversationViewerTargetId(value.sessionId)
            || !isNonnegativeSafeInteger(value.expectedRevision)
            || !value.payload
            || typeof value.payload !== 'object'
            || Array.isArray(value.payload)) {
            return undefined;
        }
        if (value.type === 'conversation-viewer-comment-mutation') {
            if (!isListedOperation(
                value.operation,
                CONVERSATION_COMMENT_MUTATION_OPERATIONS
            )) {
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
    return undefined;
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
    return isBoundedId(value);
}

function isListedOperation(
    value: unknown,
    operations: readonly string[]
): boolean {
    return typeof value === 'string' && operations.includes(value);
}

function hasOwn(value: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function isRequestId(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= 128
        && /^[A-Za-z0-9._:-]+$/.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0;
}
