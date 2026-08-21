'use strict';

import * as path from 'path';
import * as vscode from 'vscode';

import AiSessionTerminalBindingStore from '../../aiSessions/terminalBindingStore';
import AiSessionTerminalService from '../../aiSessions/terminalService';
import { TmuxRuntimeBindingStore } from '../../aiSessions/tmuxRuntimeBindingStore';
import { TmuxAttachBindingStore } from '../../aiSessions/tmuxAttachBindingStore';
import { TmuxClient } from '../../aiSessions/tmuxClient';
import {
    TmuxRuntimeDiscovery,
    isCurrentRuntimeMarker,
} from '../../aiSessions/tmuxRuntimeDiscovery';
import { withTmuxCreationLock } from '../../aiSessions/tmuxCreationLock';
import { ProcCodexRootThreadObserver } from '../../aiSessions/codexRootThreadObserver';
import { readAiSessionRuntimeConfiguration } from '../../aiSessions/runtimeConfiguration';
import { getAgentPivotConfiguration } from '../../configuration';
import type { AiSessionProviderId } from '../../models';
import type { AiSessionProvider } from '../../aiSessions/types';
import type AiSessionAliasController from '../../aiSessions/aliasController';
import type AiSessionProfileController from '../../aiSessions/sessionProfileController';
import type { CurrentWorkspaceSessionAuthority } from '../../workspaces/currentWorkspaceSessionAuthority';
import type { ConversationSessionRebindCoordinator } from '../../aiSessions/conversation/sessionRebindCoordinator';

type ConversationSessionTarget = {
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
};

/**
 * Composition section (MOD-DASHBOARD-SHELL): the runtime stores, terminal
 * service, tmux client, and runtime discovery with its rebind wiring.
 * Extracted from the composition root; construction order is unchanged and
 * the section is invoked where the terminal binding store was constructed.
 */
export interface RuntimeStackDeps {
    context: vscode.ExtensionContext;
    logError: (message: string, error: unknown) => void;
    logAiSessionRuntimeFailure: (operation: string, error: unknown) => void;
    aiSessionProviders: readonly AiSessionProvider[];
    aiSessionAliasController: AiSessionAliasController;
    aiSessionProfileController: AiSessionProfileController;
    currentWorkspaceSessionAuthority: CurrentWorkspaceSessionAuthority;
    getConversationSessionRebindCoordinator: () => ConversationSessionRebindCoordinator;
    getFollowConversationSessionRebind: () => (
        previous: ConversationSessionTarget,
        next: ConversationSessionTarget
    ) => Promise<boolean>;
    getFreezeConversationSessionMetadata: () => (
        target: ConversationSessionTarget
    ) => Promise<boolean>;
}

export function createRuntimeStack(deps: RuntimeStackDeps) {
    const { context, logError, logAiSessionRuntimeFailure } = deps;

    const aiSessionTerminalBindingStore = new AiSessionTerminalBindingStore(context.workspaceState, error =>
        logError('Failed to persist AI session terminal ownership.', error)
    );
    const aiSessionTerminalService = new AiSessionTerminalService(
        context.globalStoragePath,
        deps.aiSessionProviders,
        undefined,
        undefined,
        aiSessionTerminalBindingStore
    );
    const aiSessionRuntimeConfiguration = readAiSessionRuntimeConfiguration(
        getAgentPivotConfiguration()
    );
    const tmuxRuntimeStore = new TmuxRuntimeBindingStore(
        path.join(context.globalStoragePath, 'ai-session-tmux-runtimes'),
        () => Date.now(),
        operation => withTmuxCreationLock(
            context.globalStoragePath,
            'runtime-binding-final-records',
            operation
        )
    );
    const tmuxAttachBindingStore = new TmuxAttachBindingStore(context.workspaceState, error => {
        logAiSessionRuntimeFailure('persist-attach-binding', error);
    });
    const tmuxClient = new TmuxClient(aiSessionRuntimeConfiguration.tmuxPath);
    const tmuxRuntimeDiscovery = new TmuxRuntimeDiscovery({
        client: tmuxClient,
        bindingStore: tmuxRuntimeStore,
        codexRootThreadObserver: new ProcCodexRootThreadObserver(),
        onSessionRebinding: async (previous, next) => {
            const projectId = deps.currentWorkspaceSessionAuthority.getProjectId(
                previous
            );
            if (!projectId || !previous.sessionId || !next.sessionId
                || previous.provider !== next.provider
                || previous.workspaceNavigationIdentity
                    !== next.workspaceNavigationIdentity) {
                throw new Error('Invalid conversation Session rebind identity.');
            }
            await deps.getConversationSessionRebindCoordinator().prepare({
                projectId,
                provider: previous.provider,
                sessionId: previous.sessionId,
            }, {
                projectId,
                provider: next.provider,
                sessionId: next.sessionId,
            });
        },
        onSessionRebound: async (previous, next) => {
            deps.aiSessionAliasController.copyForRebind(
                previous.provider,
                previous.sessionId || '',
                next.sessionId || ''
            );
            deps.aiSessionProfileController.copyForRebind(
                previous.provider,
                previous.sessionId || '',
                next.sessionId || ''
            );
            const projectId = deps.currentWorkspaceSessionAuthority.getProjectId(
                previous
            );
            if (!projectId || !previous.sessionId || !next.sessionId
                || previous.provider !== next.provider
                || previous.workspaceNavigationIdentity
                    !== next.workspaceNavigationIdentity) {
                return;
            }
            const previousTarget = {
                projectId,
                provider: previous.provider,
                sessionId: previous.sessionId,
            };
            const nextTarget = {
                projectId,
                provider: next.provider,
                sessionId: next.sessionId,
            };
            await deps.getFreezeConversationSessionMetadata()(previousTarget);
            try {
                await deps.getConversationSessionRebindCoordinator().commit(
                    previousTarget,
                    nextTarget
                );
            } catch (error) {
                logAiSessionRuntimeFailure(
                    'migrate-conversation-session-rebind',
                    error
                );
            }
            if (deps.getConversationSessionRebindCoordinator().resolve(previousTarget)
                .sessionId !== nextTarget.sessionId) {
                return;
            }
            try {
                await deps.getFollowConversationSessionRebind()(
                    previousTarget,
                    nextTarget
                );
            } catch (error) {
                logAiSessionRuntimeFailure(
                    'follow-conversation-session-rebind',
                    error
                );
            }
        },
        markerIsCurrent: isCurrentRuntimeMarker,
    });

    return {
        aiSessionTerminalBindingStore,
        aiSessionTerminalService,
        aiSessionRuntimeConfiguration,
        tmuxRuntimeStore,
        tmuxAttachBindingStore,
        tmuxClient,
        tmuxRuntimeDiscovery,
    };
}
