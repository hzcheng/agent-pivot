'use strict';

import {
    OPEN_WORKSPACE_ATTENTION_FOCUS_PROTOCOL_VERSION,
    OpenWorkspaceAttentionFocusOutcome,
    OpenWorkspaceAttentionFocusRequest,
    validateOpenWorkspaceAttentionFocusRequest,
} from '../../../src/openWorkspaces/attentionFocusProtocol';
import {
    OpenWorkspaceFocusMailboxCoordinator,
    OpenWorkspaceFocusMailboxCoordinatorDependencies,
} from './openWorkspaceFocusMailboxCoordinator';
import { OpenWorkspaceAttentionFocusStore } from './openWorkspaceAttentionFocusStore';

export interface OpenWorkspaceAttentionFocusCoordinatorDependencies
    extends OpenWorkspaceFocusMailboxCoordinatorDependencies<OpenWorkspaceAttentionFocusRequest> {
    createStore?(rootDirectory: string): OpenWorkspaceAttentionFocusStore;
}

export class OpenWorkspaceAttentionFocusCoordinator {
    private readonly coordinator: OpenWorkspaceFocusMailboxCoordinator<
        OpenWorkspaceAttentionFocusRequest,
        OpenWorkspaceAttentionFocusOutcome
    >;

    constructor(
        rootDirectory: string,
        dependencies: OpenWorkspaceAttentionFocusCoordinatorDependencies,
    ) {
        this.coordinator = new OpenWorkspaceFocusMailboxCoordinator({
            store: dependencies.createStore
                ? dependencies.createStore(rootDirectory)
                : new OpenWorkspaceAttentionFocusStore(rootDirectory),
            dependencies,
            validateRequest: validateOpenWorkspaceAttentionFocusRequest,
            createOutcome: request => ({
                protocolVersion: OPEN_WORKSPACE_ATTENTION_FOCUS_PROTOCOL_VERSION,
                requestId: request.requestId,
                targetNavigationIdentity: request.targetNavigationIdentity,
                delivered: true,
            }),
            deliveryTimeoutMessage:
                'open workspace attention focus request was not delivered in time',
            disposedMessage: 'open workspace attention focus coordinator is disposed',
        });
    }

    submit(raw: unknown): Promise<OpenWorkspaceAttentionFocusOutcome> {
        return this.coordinator.submit(raw);
    }

    requestDelivery(): void {
        this.coordinator.requestDelivery();
    }

    dispose(): void {
        this.coordinator.dispose();
    }
}
