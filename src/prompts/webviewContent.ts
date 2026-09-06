import { PromptGroupV1, PromptPanelSnapshot, PromptV2 } from './types';
import * as Icons from '../webviewIcons';

const PROMPT_PREVIEW_MAX_LENGTH = 140;

function escapeHtml(value: string): string {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function preview(prompt: PromptV2): string {
    const value = (prompt.description || prompt.text.split(/\r\n|\r|\n/, 1)[0])
        .replace(/\s+/g, ' ').trim();
    return value.length > PROMPT_PREVIEW_MAX_LENGTH ? `${value.slice(0, PROMPT_PREVIEW_MAX_LENGTH)}…` : value;
}

function promptForm(prompt?: PromptV2, groupId?: string): string {
    const edit = Boolean(prompt);
    const id = prompt ? escapeHtml(prompt.id) : '';
    const suffix = prompt ? escapeHtml(prompt.id) : 'create';
    return `<form class="prompt-form ${edit ? 'prompt-edit-form' : 'prompt-create-form'}" data-prompt-form="${edit ? 'edit' : 'create'}"${edit ? ` data-prompt-id="${id}"` : ''} hidden>
        <input name="groupId" type="hidden" value="${escapeHtml(prompt ? prompt.groupId : groupId || 'general')}">
        <div class="prompt-field"><label for="prompt-name-${suffix}">Prompt name</label><input id="prompt-name-${suffix}" name="name" type="text" autocomplete="off" required value="${escapeHtml(prompt ? prompt.name : '')}"><span class="prompt-field-error" data-prompt-field-error="name"></span></div>
        <div class="prompt-field"><label for="prompt-description-${suffix}">Description <span class="steward-meta">optional</span></label><input id="prompt-description-${suffix}" name="description" type="text" autocomplete="off" value="${escapeHtml(prompt && prompt.description || '')}"><span class="prompt-field-error" data-prompt-field-error="description"></span></div>
        <div class="prompt-field"><label for="prompt-text-${suffix}">Prompt text</label><textarea id="prompt-text-${suffix}" name="text" rows="6" required>${escapeHtml(prompt ? prompt.text : '')}</textarea><span class="prompt-field-error" data-prompt-field-error="text"></span></div>
        <div class="prompt-form-actions"><button type="submit" class="steward-button steward-button-primary" data-prompt-form-action="submit">${edit ? 'Save changes' : 'Save Prompt'}</button><button type="button" class="steward-button" data-action="prompt-cancel-${edit ? 'edit' : 'create'}" data-prompt-form-action="cancel"${edit ? ` data-prompt-id="${id}"` : ''}>Cancel</button></div>
    </form>`;
}

function groupForm(): string {
    return `<form class="prompt-form prompt-group-form" data-prompt-group-form hidden>
        <div class="prompt-field"><label for="prompt-group-name">Group name</label><input id="prompt-group-name" name="name" type="text" autocomplete="off" required><span class="prompt-field-error" data-prompt-group-error></span></div>
        <div class="prompt-form-actions"><button type="submit" class="steward-button steward-button-primary">Create group</button><button type="button" class="steward-button" data-action="prompt-group-cancel">Cancel</button></div>
    </form>`;
}

function groupMenu(group: PromptGroupV1): string {
    if (group.kind === 'general') {
        return '<span class="prompt-general-info" title="Default group for prompts not assigned to a custom group.">General</span>';
    }
    const id = escapeHtml(group.id);
    return `<details class="prompt-row-menu"><summary aria-label="${escapeHtml(`${group.name} actions`)}">…</summary><div><button type="button" data-action="prompt-delete-group" data-prompt-group-id="${id}">Delete group</button></div></details>`;
}

function promptMenu(prompt: PromptV2, groups: readonly PromptGroupV1[], selected: boolean): string {
    const id = escapeHtml(prompt.id);
    const moves = groups.filter(group => group.id !== prompt.groupId).map(group =>
        `<button type="button" data-action="prompt-move" data-prompt-id="${id}" data-prompt-group-id="${escapeHtml(group.id)}">Move to ${escapeHtml(group.name)}</button>`
    ).join('');
    return `<details class="prompt-row-menu"><summary aria-label="${escapeHtml(`${prompt.name} actions`)}">…</summary><div>
        <button type="button" data-action="prompt-copy" data-prompt-id="${id}">Duplicate</button>
        <button type="button" data-action="prompt-select-default" data-prompt-id="${id}" aria-pressed="${selected ? 'true' : 'false'}">${selected ? 'Clear default' : 'Set default'}</button>
        <button type="button" data-action="prompt-edit" data-prompt-id="${id}">Edit</button>${moves}
        <button type="button" data-action="prompt-delete" data-prompt-id="${id}">Delete</button>
    </div></details>`;
}

function promptItem(prompt: PromptV2, groups: readonly PromptGroupV1[], selectedPromptId: string): string {
    const id = escapeHtml(prompt.id);
    const selected = prompt.id === selectedPromptId;
    return `<li class="prompt-item" data-prompt-id="${id}" title="${escapeHtml(preview(prompt))}">
        <div class="prompt-item-view"><button type="button" class="prompt-drag-handle steward-icon-button" draggable="true" data-drag-prompt-id="${id}" aria-label="${escapeHtml(`Drag ${prompt.name} to reorder`)}">${Icons.drag}</button>
        <button type="button" class="prompt-item-main" data-action="prompt-edit" data-prompt-id="${id}"><strong class="prompt-name">${escapeHtml(prompt.name)}</strong>${selected ? `<span class="prompt-default-marker" aria-label="Default Prompt">${Icons.starFilled}</span>` : ''}<span class="prompt-preview">${escapeHtml(preview(prompt))}</span></button>
        <button type="button" class="prompt-use-button" data-action="prompt-insert-terminal" data-prompt-id="${id}">Use</button>${promptMenu(prompt, groups, selected)}</div>
        ${promptForm(prompt)}</li>`;
}

function groupContent(group: PromptGroupV1, snapshot: PromptPanelSnapshot): string {
    const prompts = snapshot.prompts.filter(prompt => prompt.groupId === group.id);
    return `<section class="prompt-group" data-prompt-group-id="${escapeHtml(group.id)}"><header class="prompt-group-header"><button type="button" class="prompt-group-toggle" data-action="prompt-toggle-group" aria-expanded="true" aria-label="Collapse ${escapeHtml(group.name)}">▾</button><strong>${escapeHtml(group.name)}</strong><span class="steward-meta">${prompts.length}</span><button type="button" class="prompt-group-add" data-action="prompt-new" data-prompt-group-id="${escapeHtml(group.id)}" aria-label="Create Prompt in ${escapeHtml(group.name)}">＋</button>${groupMenu(group)}</header><ol class="prompt-list" data-prompt-list data-prompt-group-id="${escapeHtml(group.id)}">${prompts.length ? prompts.map(prompt => promptItem(prompt, snapshot.groups, snapshot.selectedPromptId)).join('') : '<li class="prompt-empty steward-meta">No Prompts yet.</li>'}</ol></section>`;
}

function renderAiPanel(promptSurface: string, skillsSurface?: string): string {
    return `<div class="ai-panel" data-ai-panel><div class="ai-tablist" role="tablist" aria-label="AI configuration"><button type="button" role="tab" id="ai-tab-prompts" aria-controls="ai-panel-prompts" aria-selected="true" tabindex="0">PROMPTS</button><button type="button" role="tab" id="ai-tab-skills" aria-controls="ai-panel-skills" aria-selected="false" tabindex="-1">SKILLS</button></div><section role="tabpanel" id="ai-panel-prompts" aria-labelledby="ai-tab-prompts">${promptSurface}</section><section role="tabpanel" id="ai-panel-skills" aria-labelledby="ai-tab-skills" hidden>${skillsSurface || '<div class="ai-coming-soon steward-empty-state">Coming Soon</div>'}</section></div>`;
}

export function getPromptSurfaceContent(snapshot: PromptPanelSnapshot): string {
    // Direct consumers from older extension hosts may still pass an un-migrated
    // V1 snapshot during activation. Render it as General; all mutations write V2.
    const compatible = snapshot as PromptPanelSnapshot & { groups?: readonly PromptGroupV1[]; prompts: readonly (PromptV2 & { groupId?: string })[] };
    const groups = compatible.groups || [{ id: 'general', name: 'General', kind: 'general' as const }];
    const prompts = compatible.prompts.map(prompt => ({ ...prompt, groupId: prompt.groupId || 'general' }));
    const treeSnapshot = { ...snapshot, groups, prompts } as PromptPanelSnapshot;
    const readOnly = snapshot.readOnlyReason !== undefined;
    const content = readOnly ? `<div class="prompt-read-only steward-empty-state" role="alert"><p>${snapshot.readOnlyReason === 'unsupported-version' ? 'AI Prompts require a newer version of Agent Pivot.' : 'The saved Prompt data is invalid. Correct it before editing.'}</p></div>` : `${promptForm()}${groupForm()}<div class="prompt-tree">${groups.map(group => groupContent(group, treeSnapshot)).join('')}</div>`;
    return `<div class="prompt-surface" data-prompt-surface data-prompt-revision="${snapshot.revision}"${readOnly ? ' data-prompt-read-only="true"' : ''}><header class="prompt-header"><div><strong>Prompt library</strong><span class="steward-meta">${snapshot.prompts.length} Prompts</span></div><div><button type="button" class="steward-button" data-action="prompt-group-new"${readOnly ? ' disabled' : ''}>New group</button><button type="button" class="steward-button steward-button-primary" data-action="prompt-new" data-prompt-group-id="general"${readOnly ? ' disabled' : ''}>New Prompt</button></div></header>${content}<div class="prompt-status" data-prompt-status role="status" aria-live="polite" aria-atomic="true"></div></div>`;
}

export function getPromptRecoveryContent(snapshot: PromptPanelSnapshot): string {
    const revision = Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0 ? snapshot.revision : 0;
    return `<div class="prompt-surface prompt-recovery steward-empty-state" data-prompt-surface data-prompt-revision="${revision}" data-prompt-recovery role="alert"><p>AI Prompts could not be displayed.</p><p>Reload the Agent Pivot Dashboard to try again.</p><div class="prompt-status" data-prompt-status role="status" aria-live="polite" aria-atomic="true"></div></div>`;
}

export function getAiPanelContent(snapshot: PromptPanelSnapshot, skillsSurface?: string): string {
    return renderAiPanel(getPromptSurfaceContent(snapshot), skillsSurface);
}

export function getAiPanelRecoveryContent(snapshot: PromptPanelSnapshot, skillsSurface?: string): string {
    return renderAiPanel(getPromptRecoveryContent(snapshot), skillsSurface);
}
