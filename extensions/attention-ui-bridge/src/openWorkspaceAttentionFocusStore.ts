'use strict';

import {
    MAX_OPEN_WORKSPACE_ATTENTION_FOCUS_REQUESTS,
    OpenWorkspaceAttentionFocusRequest,
    validateOpenWorkspaceAttentionFocusRequest,
} from '../../../src/openWorkspaces/attentionFocusProtocol';
import { OpenWorkspaceFocusMailboxStore } from './openWorkspaceFocusMailboxStore';

export class OpenWorkspaceAttentionFocusStore
    extends OpenWorkspaceFocusMailboxStore<OpenWorkspaceAttentionFocusRequest> {
    constructor(rootDirectory: string) {
        super(rootDirectory, {
            directorySegments: ['open-workspaces', 'attention-focus', 'v1'],
            maxPendingRequests: MAX_OPEN_WORKSPACE_ATTENTION_FOCUS_REQUESTS,
            pendingRequestDescription: 'attention focus requests',
            validateRequest: validateOpenWorkspaceAttentionFocusRequest,
        });
    }
}
