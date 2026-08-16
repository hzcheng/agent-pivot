'use strict';

import type { AiSessionPresentationStateMessage } from './types';
import type { WorkspaceCardViewModel } from '../models';
import type { AiSessionPresentationTransaction } from '../workspaces/sessionHydrationController';

export function getRenderedCurrentWorkspaceNavigationIdentity(
    cards: readonly Pick<WorkspaceCardViewModel, 'kind' | 'navigationIdentity'>[]
): string | null {
    return cards.find(card => card.kind === 'current')?.navigationIdentity || null;
}

export function buildAiSessionPresentationState<TTerminal>(
    revealFocused: boolean,
    transaction: AiSessionPresentationTransaction<TTerminal>,
    renderedWorkspaceNavigationIdentity: string | null,
    runningCardAnimation: string = 'current',
    runningIconAnimation: string = 'current',
    worktreeGroupsAggregateRevision: number | null = null,
): AiSessionPresentationStateMessage {
    return {
        type: 'ai-session-presentation-state',
        version: 1,
        projectionRevision: transaction.revision,
        ...transaction.presentation,
        runningCardAnimation,
        runningIconAnimation,
        revealFocused,
        workspaceNavigationIdentity: renderedWorkspaceNavigationIdentity,
        worktreeGroupsAggregateRevision,
    };
}
