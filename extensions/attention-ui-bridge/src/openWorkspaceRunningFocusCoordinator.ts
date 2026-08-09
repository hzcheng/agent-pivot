'use strict';

import {
    OPEN_WORKSPACE_RUNNING_FOCUS_PROTOCOL_VERSION,
    OpenWorkspaceRunningFocusOutcome,
    OpenWorkspaceRunningFocusRequest,
    validateOpenWorkspaceRunningFocusRequest,
} from '../../../src/openWorkspaces/runningFocusProtocol';
import {
    OpenWorkspaceFocusMailboxCoordinator,
    OpenWorkspaceFocusMailboxCoordinatorDependencies,
} from './openWorkspaceFocusMailboxCoordinator';
import { OpenWorkspaceRunningFocusStore } from './openWorkspaceRunningFocusStore';

export interface OpenWorkspaceRunningFocusCoordinatorDependencies
    extends OpenWorkspaceFocusMailboxCoordinatorDependencies<OpenWorkspaceRunningFocusRequest> {
    createStore?(rootDirectory: string): OpenWorkspaceRunningFocusStore;
}

/** Cross-window coordinator for running-session focus requests. */
export class OpenWorkspaceRunningFocusCoordinator {
    private readonly coordinator: OpenWorkspaceFocusMailboxCoordinator<
        OpenWorkspaceRunningFocusRequest,
        OpenWorkspaceRunningFocusOutcome
    >;

    constructor(
        rootDirectory: string,
        dependencies: OpenWorkspaceRunningFocusCoordinatorDependencies,
    ) {
        this.coordinator = new OpenWorkspaceFocusMailboxCoordinator({
            store: dependencies.createStore
                ? dependencies.createStore(rootDirectory)
                : new OpenWorkspaceRunningFocusStore(rootDirectory),
            dependencies,
            validateRequest: validateOpenWorkspaceRunningFocusRequest,
            createOutcome: request => ({
                protocolVersion: OPEN_WORKSPACE_RUNNING_FOCUS_PROTOCOL_VERSION,
                requestId: request.requestId,
                targetNavigationIdentity: request.targetNavigationIdentity,
                delivered: true,
            }),
            deliveryTimeoutMessage:
                'open workspace running focus request was not delivered in time',
            disposedMessage: 'open workspace running focus coordinator is disposed',
        });
    }

    submit(raw: unknown): Promise<OpenWorkspaceRunningFocusOutcome> {
        return this.coordinator.submit(raw);
    }

    requestDelivery(): void {
        this.coordinator.requestDelivery();
    }

    dispose(): void {
        this.coordinator.dispose();
    }
}
