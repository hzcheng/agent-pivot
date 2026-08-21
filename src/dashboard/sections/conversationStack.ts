'use strict';

import * as vscode from 'vscode';

import { ConversationCommentFileStore } from '../../aiSessions/conversation/commentStore';
import { ProjectCommentFileStore } from '../../aiSessions/conversation/projectCommentStore';
import { ConversationBookmarkFileStore } from '../../aiSessions/conversation/bookmarkStore';
import {
    ConversationSessionRebindCoordinator,
    hasCommittedConversationSessionRuntimeRebind,
} from '../../aiSessions/conversation/sessionRebindCoordinator';
import type { AiSessionProviderId } from '../../models';
import type { TmuxRuntimeBindingStore } from '../../aiSessions/tmuxRuntimeBindingStore';
import type { CurrentWorkspaceSessionAuthority } from '../../workspaces/currentWorkspaceSessionAuthority';

/**
 * Composition section (MOD-DASHBOARD-SHELL): conversation persistence stores
 * and the session-rebind coordinator with its viewer-facing store adapters.
 * Extracted from the composition root; the rebind restore task starts at the
 * same point in bootstrap (this section is invoked where the comment store
 * was constructed).
 */
export interface ConversationStackDeps {
    context: vscode.ExtensionContext;
    logAiSessionDiagnostic: (event: Record<string, unknown>) => void;
    logAiSessionRuntimeFailure: (operation: string, error: unknown) => void;
    tmuxRuntimeStore: TmuxRuntimeBindingStore;
    currentWorkspaceSessionAuthority: CurrentWorkspaceSessionAuthority;
}

export function createConversationStack(deps: ConversationStackDeps) {
    const { context, logAiSessionDiagnostic, logAiSessionRuntimeFailure } = deps;

    const conversationCommentStore = new ConversationCommentFileStore(
        context.globalStoragePath
    );
    const projectCommentStore = new ProjectCommentFileStore(
        context.globalStoragePath
    );
    const conversationBookmarkStore = new ConversationBookmarkFileStore(
        context.globalStoragePath
    );
    const conversationSessionRebindCoordinator =
        new ConversationSessionRebindCoordinator({
            globalStoragePath: context.globalStoragePath,
            commentStore: conversationCommentStore,
            bookmarkStore: conversationBookmarkStore,
            isRuntimeRebindCommitted: async (previous, next) =>
                hasCommittedConversationSessionRuntimeRebind(
                    (await deps.tmuxRuntimeStore.listKnown()).map(binding => ({
                        provider: binding.provider,
                        sessionId: binding.sessionId,
                        projectId: deps.currentWorkspaceSessionAuthority.getProjectId({
                            workspaceScopeIdentity:
                                binding.workspaceScopeIdentity,
                            workspaceNavigationIdentity:
                                binding.workspaceNavigationIdentity,
                        }),
                    })),
                    previous,
                    next
                ),
            onResult: (kind, result) => logAiSessionDiagnostic({
                event: 'conversation-session-rebind-metadata',
                kind,
                result,
            }),
            onFailure: (kind, error) => logAiSessionRuntimeFailure(
                `copy-conversation-${kind}-for-rebind`,
                error
            ),
        });
    const conversationViewerCommentStore = {
        load: (target: { projectId: string; provider: AiSessionProviderId; sessionId: string }) =>
            conversationCommentStore.load(
                conversationSessionRebindCoordinator.resolve(target)
            ),
        save: (
            target: { projectId: string; provider: AiSessionProviderId; sessionId: string },
            snapshot: Parameters<typeof conversationCommentStore.save>[1]
        ) => conversationCommentStore.save(
            conversationSessionRebindCoordinator.resolve(target),
            snapshot
        ),
    };
    const conversationViewerBookmarkStore = {
        load: (target: { projectId: string; provider: AiSessionProviderId; sessionId: string }) =>
            conversationBookmarkStore.load(
                conversationSessionRebindCoordinator.resolve(target)
            ),
        save: (
            target: { projectId: string; provider: AiSessionProviderId; sessionId: string },
            snapshot: Parameters<typeof conversationBookmarkStore.save>[1]
        ) => conversationBookmarkStore.save(
            conversationSessionRebindCoordinator.resolve(target),
            snapshot
        ),
    };
    const conversationSessionRebindRestoreTask =
        conversationSessionRebindCoordinator.restore().catch(error => {
            logAiSessionRuntimeFailure(
                'restore-conversation-session-rebinds',
                error
            );
        });

    return {
        conversationCommentStore,
        projectCommentStore,
        conversationBookmarkStore,
        conversationSessionRebindCoordinator,
        conversationViewerCommentStore,
        conversationViewerBookmarkStore,
        conversationSessionRebindRestoreTask,
    };
}
