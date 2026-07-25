export interface PromptV1 {
    readonly id: string;
    readonly name: string;
    readonly text: string;
}

export interface PromptDataV1 {
    readonly version: 1;
    readonly revision: number;
    readonly selectedPromptId: string | null;
    readonly prompts: readonly PromptV1[];
}

export type PromptMutationOperation =
    | 'create' | 'update' | 'delete' | 'reorder' | 'select-default';

export type PromptMutationErrorCode =
    | 'invalid' | 'not-found' | 'conflict' | 'storage' | 'settings-write-conflict'
    | 'unsupported-version' | 'cancelled';

export interface PromptPanelSnapshot extends PromptDataV1 {
    readonly readOnlyReason?: 'invalid-data' | 'unsupported-version';
}

export type PromptReadResult =
    | { readonly status: 'ready'; readonly snapshot: PromptPanelSnapshot }
    | { readonly status: 'read-only'; readonly snapshot: PromptPanelSnapshot };
