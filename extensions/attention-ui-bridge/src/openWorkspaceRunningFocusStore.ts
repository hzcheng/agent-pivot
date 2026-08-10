'use strict';

import {
    MAX_OPEN_WORKSPACE_RUNNING_FOCUS_REQUESTS,
    OpenWorkspaceRunningFocusRequest,
    validateOpenWorkspaceRunningFocusRequest,
} from '../../../src/openWorkspaces/runningFocusProtocol';
import { OpenWorkspaceFocusMailboxStore } from './openWorkspaceFocusMailboxStore';

/** Durable cross-window mailbox for running-session focus requests. */
export class OpenWorkspaceRunningFocusStore
    extends OpenWorkspaceFocusMailboxStore<OpenWorkspaceRunningFocusRequest> {
    constructor(rootDirectory: string) {
        super(rootDirectory, {
            directorySegments: ['open-workspaces', 'running-focus', 'v3'],
            maxPendingRequests: MAX_OPEN_WORKSPACE_RUNNING_FOCUS_REQUESTS,
            pendingRequestDescription: 'running focus requests',
            validateRequest: validateOpenWorkspaceRunningFocusRequest,
            temporaryFileStem: requestId => requestId,
            // Preserve the running-focus mailbox's best-effort temp-file cleanup.
            ignoreTemporaryCleanupErrors: true,
        });
    }
}
