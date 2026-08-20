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
import type { ConversationSessionStatusKind } from './sessionStatusController';
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

const CHANGES_GROUPS = ['merge', 'staged', 'changes', 'untracked'] as const;
export type ConversationChangesGroup = typeof CHANGES_GROUPS[number];

export interface ConversationViewerChangesSelectMessage {
    type: 'conversation-viewer-changes-select';
    version: 1;
    memberId: string;
}

export interface ConversationViewerChangesRefreshMessage {
    type: 'conversation-viewer-changes-refresh';
    version: 1;
}

export interface ConversationViewerChangesOpenFileMessage {
    type: 'conversation-viewer-changes-open-file';
    version: 1;
    memberId: string;
    group: ConversationChangesGroup;
    /** Two-letter porcelain code (e.g. 'MM'); decides the diff sides. */
    xy: string;
    path: string;
    originalPath?: string;
}

export interface ConversationViewerChangesReviewMessage {
    type: 'conversation-viewer-changes-review';
    version: 1;
    memberId: string;
}

export interface ConversationViewerChangesOpenScmMessage {
    type: 'conversation-viewer-changes-open-scm';
    version: 1;
    memberId: string;
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

/** Click a header status button: cycle to the next session of that lifecycle
 * group within this window. */
export interface ConversationViewerCycleStatusSessionMessage {
    type: 'conversation-viewer-cycle-status-session';
    version: 1;
    kind: ConversationSessionStatusKind;
}

export interface ConversationViewerRequestSyncMessage {
    type: 'conversation-viewer-request-sync';
    version: 1;
    subscriptionGeneration: number;
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
    /** Sanitized first line of the apply failure that triggered this. */
    applyError?: string;
}

export interface ConversationViewerAppliedFrame {
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
    token: string;
}

export interface ConversationViewerAppliedMessage {
    type: 'conversation-viewer-applied';
    version: 1;
    subscriptionGeneration: number;
    requestId: number;
    htmlSignature: string;
    frames?: ConversationViewerAppliedFrame[];
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

/** Click the session name in the header: ask the Host to rename the
 * current session (the Host owns the rename UX and persistence). */
export interface ConversationViewerRenameSessionMessage {
    type: 'conversation-viewer-rename-session';
    version: 1;
}

export type ConversationViewerMessage =
    ConversationViewerNavigationMessage
    | ConversationViewerSelectInteractionMessage
    | ConversationViewerOpenLinkMessage
    | ConversationViewerSendSelectionMessage
    | ConversationViewerSwitchSessionMessage
    | ConversationViewerCycleStatusSessionMessage
    | ConversationViewerRequestSyncMessage
    | ConversationViewerAppliedMessage
    | ConversationViewerFocusMessage
    | ConversationViewerOpenSubagentMessage
    | ConversationViewerCloseSubagentMessage
    | ConversationViewerRenameSessionMessage
    | ConversationViewerCommentMutationMessage
    | ConversationViewerSendCommentsMessage
    | ConversationViewerLocateCommentMessage
    | ConversationViewerProjectCommentMutationMessage
    | ConversationViewerSendProjectCommentMessage
    | ConversationViewerBookmarkMutationMessage
    | ConversationViewerCopyMessage
    | ConversationViewerChangesSelectMessage
    | ConversationViewerChangesRefreshMessage
    | ConversationViewerChangesOpenFileMessage
    | ConversationViewerChangesReviewMessage
    | ConversationViewerChangesOpenScmMessage;

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
    if (value.type === 'conversation-viewer-changes-select'
        || value.type === 'conversation-viewer-changes-review'
        || value.type === 'conversation-viewer-changes-open-scm') {
        if (!hasExactKeys(value, ['type', 'version', 'memberId'])
            || !isChangesMemberId(value.memberId)) {
            return undefined;
        }
        return value as unknown as
            | ConversationViewerChangesSelectMessage
            | ConversationViewerChangesReviewMessage
            | ConversationViewerChangesOpenScmMessage;
    }
    if (value.type === 'conversation-viewer-changes-refresh') {
        if (keys.length !== 2) {
            return undefined;
        }
        return value as unknown as ConversationViewerChangesRefreshMessage;
    }
    if (value.type === 'conversation-viewer-changes-open-file') {
        if (!hasExactKeys(value, [
            'type', 'version', 'memberId', 'group', 'xy', 'path',
        ]) && !hasExactKeys(value, [
            'type', 'version', 'memberId', 'group', 'xy', 'path', 'originalPath',
        ])) {
            return undefined;
        }
        if (!isChangesMemberId(value.memberId)
            || !CHANGES_GROUPS.includes(value.group as ConversationChangesGroup)
            || typeof value.xy !== 'string'
            || !/^[!A-Z? .]{2}$/u.test(value.xy)
            || !isChangesFilePath(value.path)
            || (value.originalPath !== undefined
                && !isChangesFilePath(value.originalPath))) {
            return undefined;
        }
        return value as unknown as ConversationViewerChangesOpenFileMessage;
    }
    if (value.type === 'conversation-viewer-switch-session') {
        if (!hasExactKeys(value, ['type', 'version', 'direction'])
            || (value.direction !== 'previous'
                && value.direction !== 'next')) {
            return undefined;
        }
        return value as unknown as ConversationViewerSwitchSessionMessage;
    }
    if (value.type === 'conversation-viewer-cycle-status-session') {
        if (!hasExactKeys(value, ['type', 'version', 'kind'])
            || (value.kind !== 'running'
                && value.kind !== 'attention'
                && value.kind !== 'idle')) {
            return undefined;
        }
        return value as unknown as ConversationViewerCycleStatusSessionMessage;
    }
    if (value.type === 'conversation-viewer-request-sync') {
        const syncKeys = [
            'type', 'version', 'subscriptionGeneration',
            'projectId', 'provider', 'sessionId',
        ];
        if (!(hasExactKeys(value, syncKeys)
                || hasExactKeys(value, [...syncKeys, 'applyError']))
            || (value.applyError !== undefined
                && (typeof value.applyError !== 'string'
                    || value.applyError.length > 200
                    || /[\0-\u001f\u007f]/.test(value.applyError)))
            || !isPositiveSafeInteger(value.subscriptionGeneration)
            || !isConversationViewerTargetId(value.projectId)
            || !isAiSessionProvider(value.provider)
            || !isConversationViewerTargetId(value.sessionId)) {
            return undefined;
        }
        return value as unknown as ConversationViewerRequestSyncMessage;
    }
    if (value.type === 'conversation-viewer-applied') {
        if (!hasExactKeys(value, [
            'type', 'version', 'subscriptionGeneration', 'requestId',
            'htmlSignature',
        ])
            && !hasExactKeys(value, [
                'type', 'version', 'subscriptionGeneration', 'requestId',
                'htmlSignature', 'frames',
            ])) {
            return undefined;
        }
        if (!isPositiveSafeInteger(value.subscriptionGeneration)
            || !isPositiveSafeInteger(value.requestId)
            || typeof value.htmlSignature !== 'string'
            || !value.htmlSignature
            || value.htmlSignature.length > 256) {
            return undefined;
        }
        if (value.frames !== undefined
            && !isAppliedFrameInventory(value.frames)) {
            return undefined;
        }
        return value as unknown as ConversationViewerAppliedMessage;
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
    if (value.type === 'conversation-viewer-close-subagent'
        || value.type === 'conversation-viewer-rename-session') {
        if (keys.length !== 2
            || !hasOwn(value, 'type')
            || !hasOwn(value, 'version')) {
            return undefined;
        }
        return value as unknown as ConversationViewerCloseSubagentMessage
            | ConversationViewerRenameSessionMessage;
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

function isAppliedFrameInventory(
    value: unknown
): value is ConversationViewerAppliedFrame[] {
    return Array.isArray(value)
        && value.length <= 16
        && value.every(frame => isRecord(frame)
            && hasExactKeys(frame, [
                'projectId', 'provider', 'sessionId', 'token',
            ])
            && isConversationViewerTargetId(frame.projectId)
            && isAiSessionProvider(frame.provider)
            && isConversationViewerTargetId(frame.sessionId)
            && typeof frame.token === 'string'
            && frame.token.length > 0
            && frame.token.length <= 256);
}

function hasOwn(value: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function isChangesMemberId(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= 128
        && /^[A-Za-z0-9._:-]+$/.test(value);
}

function isChangesFilePath(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= 4096
        && !/[\0]/.test(value);
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
