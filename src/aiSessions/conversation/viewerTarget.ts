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
    /** Display name of the worktree task group the session belongs to, when
     * any; rendered between the workspace name and the session name. */
    taskName?: string;
    /** When set, the viewer renders this subagent's transcript instead of
     * the main session; sessionId stays the real (parent) session id. */
    subagent?: { id: string; label: string };
}
