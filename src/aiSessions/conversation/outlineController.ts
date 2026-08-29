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
    selectedOutsideOutline?: true;
}

export class ConversationOutlineController {
    private outline?: ConversationOutline;
    private selectedInteractionId?: string;
    private selectedOutsideOutline = false;
    private selectedOutsideOutlineInput?: number;

    get snapshot(): ConversationOutline | undefined {
        return this.outline;
    }

    get selection(): string | undefined {
        return this.selectedInteractionId;
    }

    reset(selectedInteractionId?: string): void {
        this.outline = undefined;
        this.selectedInteractionId = selectedInteractionId;
        this.selectedOutsideOutline = false;
        this.selectedOutsideOutlineInput = undefined;
    }

    replace(
        outline: ConversationOutline,
        selectedInteractionId: string
    ): boolean {
        this.outline = outline;
        return this.select(selectedInteractionId);
    }

    select(interactionId: string): boolean {
        if (!this.outline) {
            return false;
        }
        const inOutline = this.contains(interactionId);
        const isTrueFirst = this.outline.firstInteractionId === interactionId;
        if (!inOutline && !isTrueFirst) return false;
        this.selectedInteractionId = interactionId;
        this.selectedOutsideOutline = !inOutline;
        this.selectedOutsideOutlineInput = this.selectedOutsideOutline ? 1 : undefined;
        return true;
    }

    selectOutsideOutline(interactionId: string, selectedInput: number): boolean {
        if (!this.outline || this.contains(interactionId)
            || !Number.isSafeInteger(selectedInput) || selectedInput < 1) {
            return false;
        }
        this.selectedInteractionId = interactionId;
        this.selectedOutsideOutline = true;
        this.selectedOutsideOutlineInput = selectedInput;
        return true;
    }

    isSelectedOutsideOutline(): boolean {
        return this.selectedOutsideOutline;
    }

    selectedInput(): number | undefined {
        return this.selectedOutsideOutline
            ? this.selectedOutsideOutlineInput
            : undefined;
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
            selectedInput: this.selectedOutsideOutline
                ? this.selectedOutsideOutlineInput || 0
                : selectedIndex < 0
                ? 0
                : omittedInteractions + selectedIndex + 1,
            totalInputs: outline.partial
                ? Math.min(
                    outline.totalInteractions,
                    CONVERSATION_LIMITS.maxOutlineInteractions
                )
                : outline.totalInteractions,
            partial: outline.partial,
            atLatest: !this.selectedOutsideOutline
                && selectedIndex === interactionIds.length - 1,
            ...(this.selectedOutsideOutline
                ? { selectedOutsideOutline: true as const }
                : {}),
        };
    }
}
