'use strict';

// View model for the OPEN tab window-switcher rows (PRD: WINDOWS N 单行切换器).
// PR-A: pure projection, not yet consumed by production rendering; PR-B wires
// it into the open-workspaces update pipeline.

import type { WorkspaceCardViewModel } from '../models';
import { resolveWindowDisplayNames } from './windowDisplayNames';

export interface OpenWindowRowViewModel {
    cardId: string;
    kind: 'current' | 'navigation';
    navigationIdentity: string;
    /** Final, disambiguated display name. */
    displayName: string;
    /** Undisambiguated workspace name for tooltips. */
    fullName: string;
    environmentLabel: string;
    runningCount: number;
    attentionCount: number;
    pinned: boolean;
}

/**
 * Projects workspace cards into window-switcher rows. Disambiguation runs on
 * the final names (callers must pass cards whose names are already overridden
 * by saved-project names), using caller-supplied path segments keyed by card
 * id (the projection layer drops URIs, so the host supplies the minimal path
 * segments needed for the shortest-unique-suffix algorithm).
 */
export function buildOpenWindowRowViewModels(
    cards: readonly WorkspaceCardViewModel[],
    pathSegmentsByCardId?: ReadonlyMap<string, readonly string[]>,
): OpenWindowRowViewModel[] {
    const displayNames = resolveWindowDisplayNames(cards.map(card => ({
        id: card.id,
        name: card.name,
        pathSegments: pathSegmentsByCardId?.get(card.id) || [],
    })));
    return cards.map(card => ({
        cardId: card.id,
        kind: card.kind,
        navigationIdentity: card.navigationIdentity,
        displayName: displayNames.get(card.id) || card.name,
        fullName: card.name,
        environmentLabel: card.environmentLabel || '',
        runningCount: Math.max(0, Math.floor(card.runningSessionCount || 0)),
        attentionCount: Math.max(0, Math.floor(card.attentionCount || 0)),
        pinned: card.pinned === true,
    }));
}
