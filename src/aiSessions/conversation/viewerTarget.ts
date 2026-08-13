'use strict';

import type { AiSessionProviderId } from '../../models';

export interface ConversationViewerTarget {
    projectId: string;
    provider: AiSessionProviderId;
    workspaceName: string;
    sessionId: string;
    interactionId: string;
    expectedRevision: string;
    displayName: string;
    duplicateDisplayName: boolean;
    /** When set, the viewer renders this subagent's transcript instead of
     * the main session; sessionId stays the real (parent) session id. */
    subagent?: { id: string; label: string };
}
