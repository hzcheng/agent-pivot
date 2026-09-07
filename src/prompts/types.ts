export interface PromptV1 {
    readonly id: string;
    readonly name: string;
    readonly text: string;
}

export const GENERAL_PROMPT_GROUP_ID = 'general';

export interface PromptGroupV1 {
    readonly id: string;
    readonly name: string;
    readonly kind: 'general' | 'custom';
}

export interface PromptV2 {
    readonly id: string;
    readonly name: string;
    readonly description?: string;
    readonly text: string;
    /** A Prompt is owned by exactly one existing group. */
    readonly groupId: string;
}

export interface PromptDataV1 {
    readonly version: 1;
    readonly revision: number;
    readonly selectedPromptId: string | null;
    readonly prompts: readonly PromptV1[];
}

export interface PromptDataV2 {
    readonly version: 2;
    readonly revision: number;
    readonly selectedPromptId: string | null;
    readonly groups: readonly PromptGroupV1[];
    /** Ordered by group order, then by the Prompt's order inside that group. */
    readonly prompts: readonly PromptV2[];
}

export type PromptMutationOperation =
    | 'create' | 'update' | 'delete' | 'reorder' | 'select-default'
    | 'create-group' | 'rename-group' | 'delete-group' | 'move';

export type PromptMutationErrorCode =
    | 'invalid' | 'not-found' | 'conflict' | 'storage' | 'settings-write-conflict'
    | 'unsupported-version' | 'cancelled';

export interface PromptPanelSnapshot extends PromptDataV2 {
    readonly readOnlyReason?: 'invalid-data' | 'unsupported-version';
}

export type PromptReadResult =
    | { readonly status: 'ready'; readonly snapshot: PromptPanelSnapshot }
    | { readonly status: 'read-only'; readonly snapshot: PromptPanelSnapshot };
