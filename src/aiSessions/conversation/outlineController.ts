'use strict';

import {
    CONVERSATION_LIMITS,
    ConversationOutline,
    ConversationResponseState,
} from './types';

export interface ConversationViewerOutlineEntry {
    interactionId: string;
    userPreview: string;
    responseState: ConversationResponseState;
}

export interface ConversationOutlinePublication {
    outline: ConversationViewerOutlineEntry[];
    selectedInteractionId: string;
    selectedInput: number;
    totalInputs: number;
    partial: boolean;
    atLatest: boolean;
}

export class ConversationOutlineController {
    private outline?: ConversationOutline;
    private selectedInteractionId?: string;

    get snapshot(): ConversationOutline | undefined {
        return this.outline;
    }

    get selection(): string | undefined {
        return this.selectedInteractionId;
    }

    reset(selectedInteractionId?: string): void {
        this.outline = undefined;
        this.selectedInteractionId = selectedInteractionId;
    }

    replace(
        outline: ConversationOutline,
        selectedInteractionId: string
    ): boolean {
        if (!outline.interactions.some(
            interaction => interaction.id === selectedInteractionId
        )) {
            return false;
        }
        this.outline = outline;
        this.selectedInteractionId = selectedInteractionId;
        return true;
    }

    select(interactionId: string): boolean {
        if (!this.contains(interactionId)) {
            return false;
        }
        this.selectedInteractionId = interactionId;
        return true;
    }

    contains(interactionId: string): boolean {
        return Boolean(this.outline?.interactions.some(
            interaction => interaction.id === interactionId
        ));
    }

    latestInteractionId(): string | undefined {
        return this.outline?.interactions[
            this.outline.interactions.length - 1
        ]?.id;
    }

    adjacentInteractionId(
        direction: 'before' | 'after'
    ): string | undefined {
        const selectedInteractionId = this.selectedInteractionId;
        const interactionIds = this.outline?.interactions.map(
            interaction => interaction.id
        ) || [];
        if (!selectedInteractionId) {
            return undefined;
        }
        const selectedIndex = interactionIds.indexOf(selectedInteractionId);
        const targetIndex = direction === 'before'
            ? selectedIndex - 1
            : selectedIndex + 1;
        return selectedIndex >= 0
            && targetIndex >= 0
            && targetIndex < interactionIds.length
            ? interactionIds[targetIndex]
            : undefined;
    }

    createPublication(): ConversationOutlinePublication {
        const outline = this.outline;
        const selectedInteractionId = this.selectedInteractionId;
        if (!outline || !selectedInteractionId) {
            throw new Error('Conversation outline unavailable.');
        }
        const interactionIds = outline.interactions.map(
            interaction => interaction.id
        );
        const selectedIndex = interactionIds.indexOf(selectedInteractionId);
        const omittedInteractions = outline.partial
            ? Math.max(0, outline.totalInteractions - interactionIds.length)
            : 0;
        return {
            outline: outline.interactions.map(interaction => ({
                interactionId: interaction.id,
                userPreview: interaction.userPreview,
                responseState: interaction.responseState,
            })),
            selectedInteractionId,
            selectedInput: selectedIndex < 0
                ? 0
                : omittedInteractions + selectedIndex + 1,
            totalInputs: outline.partial
                ? Math.min(
                    outline.totalInteractions,
                    CONVERSATION_LIMITS.maxOutlineInteractions
                )
                : outline.totalInteractions,
            partial: outline.partial,
            atLatest: selectedIndex === interactionIds.length - 1,
        };
    }
}
