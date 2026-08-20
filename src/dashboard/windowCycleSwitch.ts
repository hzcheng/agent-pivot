'use strict';

export type WindowCycleDirection = 'previous' | 'next';

export interface WindowCycleTarget {
    cardId: string;
    navigationIdentity: string;
}

export interface WindowCycleSwitchHandlerOptions {
    /** Other open windows (navigation cards), in dashboard card order. */
    listOtherWindows: () => WindowCycleTarget[];
    /** This window's navigation identity, when known. */
    getSelfNavigationIdentity: () => string | undefined;
    openWindow: (cardId: string) => Promise<void>;
    showInformationMessage: (message: string) => void;
}

export interface WindowCycleSwitchHandler {
    switchWindow(direction: WindowCycleDirection): Promise<void>;
}

/**
 * Moves focus one window per invocation around a ring built from every
 * registered open window. The ring is sorted by navigation identity, so all
 * windows compute the same cycle without a shared cursor: each window anchors
 * on its own identity and steps to its neighbour. Opening a workspace that
 * already has a window focuses that window, so a single press lands there.
 */
export function createWindowCycleSwitchHandler(
    options: WindowCycleSwitchHandlerOptions
): WindowCycleSwitchHandler {
    return {
        async switchWindow(direction: WindowCycleDirection): Promise<void> {
            const others = options.listOtherWindows()
                .filter(window => Boolean(window)
                    && typeof window.cardId === 'string'
                    && window.cardId.length > 0
                    && typeof window.navigationIdentity === 'string'
                    && window.navigationIdentity.length > 0);
            if (!others.length) {
                options.showInformationMessage(
                    'No other open windows to switch to.'
                );
                return;
            }
            const self = options.getSelfNavigationIdentity();
            const identities = Array.from(new Set([
                ...others.map(window => window.navigationIdentity),
                ...(self ? [self] : []),
            ])).sort();
            const selfIndex = self ? identities.indexOf(self) : -1;
            const targetIdentity = selfIndex === -1
                ? identities[direction === 'next' ? 0 : identities.length - 1]
                : identities[
                    (selfIndex + (direction === 'next' ? 1 : -1)
                        + identities.length) % identities.length
                ];
            const target = others.find(
                window => window.navigationIdentity === targetIdentity
            );
            // With at least one other window in the ring the stepped target is
            // never this window, so a missing card means a stale projection.
            if (!target) {
                options.showInformationMessage(
                    'Agent Pivot: the next window is no longer open.'
                );
                return;
            }
            await options.openWindow(target.cardId);
        },
    };
}
