'use strict';

import type { AiSessionPresentationStateMessage } from './types';
import type { AiSessionPresentationTransaction } from '../workspaces/sessionHydrationController';

export function buildAiSessionPresentationState<TTerminal>(
    revealFocused: boolean,
    transaction: AiSessionPresentationTransaction<TTerminal>,
    runningCardAnimation: string = 'current',
    runningIconAnimation: string = 'current',
): AiSessionPresentationStateMessage {
    return {
        type: 'ai-session-presentation-state',
        version: 1,
        projectionRevision: transaction.revision,
        ...transaction.presentation,
        runningCardAnimation,
        runningIconAnimation,
        revealFocused,
    };
}
