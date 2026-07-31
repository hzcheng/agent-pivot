'use strict';

import type { AiSessionProviderId } from '../../models';

export interface ConversationViewerTarget {
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
    interactionId: string;
    expectedRevision: string;
    displayName: string;
    duplicateDisplayName: boolean;
}
