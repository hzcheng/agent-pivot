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
export const CONVERSATION_RUN_COMMAND_MAX_TEXT_LENGTH = 4_000;

/** A user-triggered shell command rendered by the Conversation Webview. */
export interface ConversationViewerRunCommandMessage {
    type: 'conversation-viewer-run-command';
    version: 1;
    subscriptionGeneration: number;
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
    command: string;
}

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

/**
 * Changes-panel action intents are bound to the authoritative target and
 * subscription generation: an intent stranded by a session switch must not
 * act on the newly active session when member IDs overlap.
 */
interface ConversationViewerChangesActionBase {
    version: 1;
    subscriptionGeneration: number;
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
}

export interface ConversationViewerChangesSelectMessage
    extends ConversationViewerChangesActionBase {
    type: 'conversation-viewer-changes-select';
    memberId: string;
}

export interface ConversationViewerChangesRefreshMessage
    extends ConversationViewerChangesActionBase {
    type: 'conversation-viewer-changes-refresh';
}

export interface ConversationViewerChangesOpenFileMessage
    extends ConversationViewerChangesActionBase {
    type: 'conversation-viewer-changes-open-file';
    memberId: string;
    group: ConversationChangesGroup;
    /** Two-letter porcelain code (e.g. 'MM'); decides the diff sides. */
    xy: string;
    path: string;
    originalPath?: string;
}

export interface ConversationViewerChangesReviewMessage
    extends ConversationViewerChangesActionBase {
    type: 'conversation-viewer-changes-review';
    memberId: string;
}

export interface ConversationViewerChangesOpenScmMessage
    extends ConversationViewerChangesActionBase {
    type: 'conversation-viewer-changes-open-scm';
    memberId: string;
}

/**
 * Commits-tab lazy loading (changes-panel PRD §14.3): request/response
 * messages off the steady-state changes push. Requests carry a
 * webview-generated requestId (per member+scope, only the latest wins)
 * plus the same generation/session binding as changes actions, so an
 * intent stranded by a session switch fails closed.
 */
export interface ConversationViewerCommitsListMessage
    extends ConversationViewerChangesActionBase {
    type: 'conversation-viewer-commits-list';
    requestId: string;
    memberId: string;
    scope: 'since-start' | 'full';
    offset: number;
    /** Frozen HEAD sha from the scope's first page; later pages echo it. */
    historyHead?: string;
}

export interface ConversationViewerCommitDetailMessage
    extends ConversationViewerChangesActionBase {
    type: 'conversation-viewer-commit-detail';
    requestId: string;
    memberId: string;
    sha: string;
}

export interface ConversationViewerCommitOpenFileMessage
    extends ConversationViewerChangesActionBase {
    type: 'conversation-viewer-commit-open-file';
    requestId: string;
    memberId: string;
    sha: string;
    path: string;
    oldPath?: string;
}

export interface ConversationViewerCommitReviewMessage
    extends ConversationViewerChangesActionBase {
    type: 'conversation-viewer-commit-review';
    requestId: string;
    memberId: string;
    sha: string;
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

/** Click a bottom window rail: focus the previous/next open window. */
export interface ConversationViewerSwitchWindowMessage {
    type: 'conversation-viewer-switch-window';
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

/** Click the provider icon while the current session needs attention:
 * ask the Host to acknowledge (clear) that session's attention state. The
 * message carries no identity — the Host resolves the current target and
 * recomputes the session's attention events authoritatively. */
export interface ConversationViewerAcknowledgeAttentionMessage {
    type: 'conversation-viewer-acknowledge-attention';
    version: 1;
}

export type ConversationViewerMessage =
    ConversationViewerNavigationMessage
    | ConversationViewerSelectInteractionMessage
    | ConversationViewerOpenLinkMessage
    | ConversationViewerSendSelectionMessage
    | ConversationViewerRunCommandMessage
    | ConversationViewerSwitchSessionMessage
    | ConversationViewerSwitchWindowMessage
    | ConversationViewerCycleStatusSessionMessage
    | ConversationViewerRequestSyncMessage
    | ConversationViewerAppliedMessage
    | ConversationViewerFocusMessage
    | ConversationViewerOpenSubagentMessage
    | ConversationViewerCloseSubagentMessage
    | ConversationViewerRenameSessionMessage
    | ConversationViewerAcknowledgeAttentionMessage
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
    | ConversationViewerChangesOpenScmMessage
    | ConversationViewerCommitsListMessage
    | ConversationViewerCommitDetailMessage
    | ConversationViewerCommitOpenFileMessage
    | ConversationViewerCommitReviewMessage;

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
    if (value.type === 'conversation-viewer-run-command') {
        if (!hasExactKeys(value, [
            'type', 'version', 'subscriptionGeneration', 'projectId',
            'provider', 'sessionId', 'command',
        ])
            || !isChangesActionBinding(value)
            || !isRunnableTerminalCommand(value.command)) {
            return undefined;
        }
        return value as unknown as ConversationViewerRunCommandMessage;
    }
    if (value.type === 'conversation-viewer-changes-select'
        || value.type === 'conversation-viewer-changes-review'
        || value.type === 'conversation-viewer-changes-open-scm') {
        if (!hasExactKeys(value, [
            'type', 'version', 'memberId', 'subscriptionGeneration',
            'projectId', 'provider', 'sessionId',
        ])
            || !isChangesMemberId(value.memberId)
            || !isChangesActionBinding(value)) {
            return undefined;
        }
        return value as unknown as
            | ConversationViewerChangesSelectMessage
            | ConversationViewerChangesReviewMessage
            | ConversationViewerChangesOpenScmMessage;
    }
    if (value.type === 'conversation-viewer-changes-refresh') {
        if (!hasExactKeys(value, [
            'type', 'version', 'subscriptionGeneration',
            'projectId', 'provider', 'sessionId',
        ]) || !isChangesActionBinding(value)) {
            return undefined;
        }
        return value as unknown as ConversationViewerChangesRefreshMessage;
    }
    if (value.type === 'conversation-viewer-changes-open-file') {
        if (!hasExactKeys(value, [
            'type', 'version', 'memberId', 'subscriptionGeneration',
            'projectId', 'provider', 'sessionId', 'group', 'xy', 'path',
        ]) && !hasExactKeys(value, [
            'type', 'version', 'memberId', 'subscriptionGeneration',
            'projectId', 'provider', 'sessionId', 'group', 'xy', 'path',
            'originalPath',
        ])) {
            return undefined;
        }
        if (!isChangesMemberId(value.memberId)
            || !CHANGES_GROUPS.includes(value.group as ConversationChangesGroup)
            || !isChangesActionBinding(value)
            || typeof value.xy !== 'string'
            || !/^[!A-Z? .]{2}$/u.test(value.xy)
            || !isChangesFilePath(value.path)
            || (value.originalPath !== undefined
                && !isChangesFilePath(value.originalPath))) {
            return undefined;
        }
        return value as unknown as ConversationViewerChangesOpenFileMessage;
    }
    if (value.type === 'conversation-viewer-commits-list') {
        if (!hasExactKeys(value, [
            'type', 'version', 'requestId', 'subscriptionGeneration',
            'projectId', 'provider', 'sessionId', 'memberId', 'scope',
            'offset',
        ]) && !hasExactKeys(value, [
            'type', 'version', 'requestId', 'subscriptionGeneration',
            'projectId', 'provider', 'sessionId', 'memberId', 'scope',
            'offset', 'historyHead',
        ])) {
            return undefined;
        }
        if (!isCommitsRequestId(value.requestId)
            || !isChangesActionBinding(value)
            || !isChangesMemberId(value.memberId)
            || (value.scope !== 'since-start' && value.scope !== 'full')
            || !Number.isSafeInteger(value.offset)
            || (value.offset as number) < 0
            || (value.offset as number) > 1_000_000
            || (value.historyHead !== undefined
                && !isFullCommitSha(value.historyHead))) {
            return undefined;
        }
        return value as unknown as ConversationViewerCommitsListMessage;
    }
    if (value.type === 'conversation-viewer-commit-detail'
        || value.type === 'conversation-viewer-commit-review') {
        if (!hasExactKeys(value, [
            'type', 'version', 'requestId', 'subscriptionGeneration',
            'projectId', 'provider', 'sessionId', 'memberId', 'sha',
        ])
            || !isCommitsRequestId(value.requestId)
            || !isChangesActionBinding(value)
            || !isChangesMemberId(value.memberId)
            || !isFullCommitSha(value.sha)) {
            return undefined;
        }
        return value as unknown as
            | ConversationViewerCommitDetailMessage
            | ConversationViewerCommitReviewMessage;
    }
    if (value.type === 'conversation-viewer-commit-open-file') {
        if (!hasExactKeys(value, [
            'type', 'version', 'requestId', 'subscriptionGeneration',
            'projectId', 'provider', 'sessionId', 'memberId', 'sha', 'path',
        ]) && !hasExactKeys(value, [
            'type', 'version', 'requestId', 'subscriptionGeneration',
            'projectId', 'provider', 'sessionId', 'memberId', 'sha', 'path',
            'oldPath',
        ])) {
            return undefined;
        }
        if (!isCommitsRequestId(value.requestId)
            || !isChangesActionBinding(value)
            || !isChangesMemberId(value.memberId)
            || !isFullCommitSha(value.sha)
            || !isChangesFilePath(value.path)
            || (value.oldPath !== undefined
                && !isChangesFilePath(value.oldPath))) {
            return undefined;
        }
        return value as unknown as ConversationViewerCommitOpenFileMessage;
    }
    if (value.type === 'conversation-viewer-switch-session') {
        if (!hasExactKeys(value, ['type', 'version', 'direction'])
            || (value.direction !== 'previous'
                && value.direction !== 'next')) {
            return undefined;
        }
        return value as unknown as ConversationViewerSwitchSessionMessage;
    }
    if (value.type === 'conversation-viewer-switch-window') {
        if (!hasExactKeys(value, ['type', 'version', 'direction'])
            || (value.direction !== 'previous'
                && value.direction !== 'next')) {
            return undefined;
        }
        return value as unknown as ConversationViewerSwitchWindowMessage;
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
        || value.type === 'conversation-viewer-rename-session'
        || value.type === 'conversation-viewer-acknowledge-attention') {
        if (keys.length !== 2
            || !hasOwn(value, 'type')
            || !hasOwn(value, 'version')) {
            return undefined;
        }
        return value as unknown as ConversationViewerCloseSubagentMessage
            | ConversationViewerRenameSessionMessage
            | ConversationViewerAcknowledgeAttentionMessage;
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

function isChangesActionBinding(value: {
    subscriptionGeneration?: unknown;
    projectId?: unknown;
    provider?: unknown;
    sessionId?: unknown;
}): boolean {
    return isPositiveSafeInteger(value.subscriptionGeneration)
        && isConversationViewerTargetId(value.projectId)
        && isAiSessionProvider(value.provider)
        && isConversationViewerTargetId(value.sessionId);
}

function isChangesFilePath(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= 4096
        && !/[\0]/.test(value);
}

function isRunnableTerminalCommand(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= CONVERSATION_RUN_COMMAND_MAX_TEXT_LENGTH
        && !!value.trim()
        // Keep newlines and tabs, but reject non-printing controls that
        // cannot be meaningfully typed into a terminal command.
        && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function isFullCommitSha(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

/**
 * Commits requestIds are intentionally narrower than the generic
 * requestId charset (PRD §14.3.5): webview-generated, dash-joined.
 */
function isCommitsRequestId(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/u.test(value);
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
