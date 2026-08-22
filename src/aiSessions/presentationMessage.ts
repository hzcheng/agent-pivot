'use strict';

import type { AiSessionPresentationStateMessage } from './types';
import type { WorkspaceCardViewModel } from '../models';
import type { AiSessionPresentationTransaction } from '../workspaces/sessionHydrationController';

export function getRenderedCurrentWorkspaceNavigationIdentity(
    cards: readonly Pick<WorkspaceCardViewModel, 'kind' | 'navigationIdentity' | 'roots'>[]
): string | null {
    // Only a renderable current card owns the rendered identity: the webview
    // filters zero-root (empty-window) placeholder cards out of the DOM, so
    // the presentation identity must describe what is actually on screen —
    // an unrendered placeholder would fail the webview's workspace match and
    // force a full refresh on every incremental update.
    return cards.find(card => card.kind === 'current' && card.roots.length > 0)?.navigationIdentity || null;
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
