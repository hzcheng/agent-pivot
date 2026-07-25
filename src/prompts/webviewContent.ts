import { PromptPanelSnapshot, PromptV1 } from './types';

const PROMPT_PREVIEW_MAX_LENGTH = 160;

function escapeHtml(value: string): string {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getPromptPreview(text: string): string {
    const firstLine = text.split(/\r\n|\r|\n/, 1)[0].replace(/\s+/g, ' ').trim();
    return firstLine.length > PROMPT_PREVIEW_MAX_LENGTH
        ? `${firstLine.slice(0, PROMPT_PREVIEW_MAX_LENGTH)}…`
        : firstLine;
}

function renderCreateForm(): string {
    return `<form class="prompt-form prompt-create-form steward-card" data-prompt-form="create" hidden>
        <div class="prompt-field">
            <label for="prompt-create-name">Prompt name</label>
            <input id="prompt-create-name" name="name" type="text" autocomplete="off" required aria-describedby="prompt-create-name-error">
            <span id="prompt-create-name-error" class="prompt-field-error" data-prompt-field-error="name"></span>
        </div>
        <div class="prompt-field">
            <label for="prompt-create-text">Prompt text</label>
            <textarea id="prompt-create-text" name="text" rows="6" required aria-describedby="prompt-create-text-error"></textarea>
            <span id="prompt-create-text-error" class="prompt-field-error" data-prompt-field-error="text"></span>
        </div>
        <div class="prompt-form-actions">
            <button type="submit" class="steward-button steward-button-primary">Save Prompt</button>
            <button type="button" class="steward-button" data-action="prompt-cancel-create">Cancel</button>
        </div>
    </form>`;
}

function renderEditForm(prompt: PromptV1, index: number): string {
    const promptId = escapeHtml(prompt.id);
    const nameId = `prompt-edit-name-${index}`;
    const textId = `prompt-edit-text-${index}`;
    return `<form class="prompt-form prompt-edit-form steward-card" data-prompt-form="edit" data-prompt-id="${promptId}" hidden>
        <div class="prompt-field">
            <label for="${nameId}">Prompt name</label>
            <input id="${nameId}" name="name" type="text" autocomplete="off" required value="${escapeHtml(prompt.name)}" aria-describedby="${nameId}-error">
            <span id="${nameId}-error" class="prompt-field-error" data-prompt-field-error="name"></span>
        </div>
        <div class="prompt-field">
            <label for="${textId}">Prompt text</label>
            <textarea id="${textId}" name="text" rows="6" required aria-describedby="${textId}-error">${escapeHtml(prompt.text)}</textarea>
            <span id="${textId}-error" class="prompt-field-error" data-prompt-field-error="text"></span>
        </div>
        <div class="prompt-form-actions">
            <button type="submit" class="steward-button steward-button-primary">Save changes</button>
            <button type="button" class="steward-button" data-action="prompt-cancel-edit" data-prompt-id="${promptId}">Cancel</button>
        </div>
    </form>`;
}

function renderPromptItem(
    prompt: PromptV1,
    index: number,
    selectedPromptId: string | null,
): string {
    const promptId = escapeHtml(prompt.id);
    const promptName = escapeHtml(prompt.name);
    const selected = selectedPromptId === prompt.id;
    const defaultLabel = selected
        ? `Clear ${prompt.name} as the default Prompt`
        : `Make ${prompt.name} the default Prompt`;
    return `<li class="prompt-item steward-item-card" data-prompt-id="${promptId}">
        <div class="prompt-item-view">
            <button type="button" class="prompt-drag-handle steward-icon-button" draggable="true" data-drag-prompt-id="${promptId}" aria-label="${escapeHtml(`Drag ${prompt.name} to reorder`)}" title="Drag to reorder">⋮⋮</button>
            <div class="prompt-item-content">
                <strong class="prompt-name" title="${promptName}">${promptName}</strong>
                <p class="prompt-preview">${escapeHtml(getPromptPreview(prompt.text))}</p>
            </div>
            <div class="prompt-item-actions">
                <button type="button" class="steward-button prompt-default-button" data-action="prompt-select-default" data-prompt-id="${promptId}" aria-pressed="${selected ? 'true' : 'false'}" aria-label="${escapeHtml(defaultLabel)}">${selected ? 'Default' : 'Make default'}</button>
                <button type="button" class="steward-icon-button" data-action="prompt-edit" data-prompt-id="${promptId}" aria-label="${escapeHtml(`Edit ${prompt.name}`)}">Edit</button>
                <button type="button" class="steward-icon-button danger" data-action="prompt-delete" data-prompt-id="${promptId}" aria-label="${escapeHtml(`Delete ${prompt.name}`)}">Delete</button>
            </div>
        </div>
        ${renderEditForm(prompt, index)}
    </li>`;
}

function renderReadOnlyContent(reason: 'invalid-data' | 'unsupported-version'): string {
    const message = reason === 'unsupported-version'
        ? 'AI Prompts require a newer version of Project Steward. This library is read-only.'
        : 'The saved Prompt data is invalid. Correct the setting before editing this library.';
    return `<div class="prompt-read-only steward-empty-state" role="alert">
        <p>${message}</p>
    </div>`;
}

function renderAiPanel(promptSurface: string): string {
    return `<div class="ai-panel" data-ai-panel>
        <div class="ai-tablist" role="tablist" aria-label="AI configuration">
            <button type="button" role="tab" id="ai-tab-prompts" aria-controls="ai-panel-prompts" aria-selected="true" tabindex="0">PROMPTS</button>
            <button type="button" role="tab" id="ai-tab-skills" aria-controls="ai-panel-skills" aria-selected="false" tabindex="-1">SKILLS</button>
            <button type="button" role="tab" id="ai-tab-mcp" aria-controls="ai-panel-mcp" aria-selected="false" tabindex="-1">MCP</button>
            <button type="button" role="tab" id="ai-tab-hooks" aria-controls="ai-panel-hooks" aria-selected="false" tabindex="-1">HOOKS</button>
        </div>
        <section role="tabpanel" id="ai-panel-prompts" aria-labelledby="ai-tab-prompts">${promptSurface}</section>
        <section role="tabpanel" id="ai-panel-skills" aria-labelledby="ai-tab-skills" hidden><div class="ai-coming-soon steward-empty-state">Coming Soon</div></section>
        <section role="tabpanel" id="ai-panel-mcp" aria-labelledby="ai-tab-mcp" hidden><div class="ai-coming-soon steward-empty-state">Coming Soon</div></section>
        <section role="tabpanel" id="ai-panel-hooks" aria-labelledby="ai-tab-hooks" hidden><div class="ai-coming-soon steward-empty-state">Coming Soon</div></section>
    </div>`;
}

export function getPromptSurfaceContent(snapshot: PromptPanelSnapshot): string {
    const readOnly = snapshot.readOnlyReason !== undefined;
    const items = snapshot.prompts.map((prompt, index) =>
        renderPromptItem(prompt, index, snapshot.selectedPromptId)
    ).join('');
    const listContent = snapshot.prompts.length > 0
        ? items
        : '<li class="prompt-empty steward-empty-state" data-prompt-empty>No AI Prompts are configured.</li>';
    const content = readOnly
        ? renderReadOnlyContent(snapshot.readOnlyReason as 'invalid-data' | 'unsupported-version')
        : `${renderCreateForm()}
        <ol class="prompt-list" data-prompt-list>${listContent}</ol>`;

    return `<div class="prompt-surface" data-prompt-surface data-prompt-revision="${snapshot.revision}"${readOnly ? ' data-prompt-read-only="true"' : ''}>
        <header class="prompt-header">
            <div>
                <strong>AI Prompts</strong>
                <span class="steward-meta">${snapshot.prompts.length} configured</span>
            </div>
            <button type="button" class="steward-button steward-button-primary" data-action="prompt-new"${readOnly ? ' disabled' : ''}>New Prompt</button>
        </header>
        ${content}
        <div class="prompt-status" data-prompt-status role="status" aria-live="polite" aria-atomic="true"></div>
    </div>`;
}

export function getPromptRecoveryContent(snapshot: PromptPanelSnapshot): string {
    const revision = Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0
        ? snapshot.revision
        : 0;
    return `<div class="prompt-surface prompt-recovery steward-empty-state" data-prompt-surface data-prompt-revision="${revision}" data-prompt-recovery role="alert">
        <p>AI Prompts could not be displayed.</p>
        <p>Reload the Project Steward Dashboard to try again.</p>
        <div class="prompt-status" data-prompt-status role="status" aria-live="polite" aria-atomic="true"></div>
    </div>`;
}

export function getAiPanelContent(snapshot: PromptPanelSnapshot): string {
    return renderAiPanel(getPromptSurfaceContent(snapshot));
}

export function getAiPanelRecoveryContent(snapshot: PromptPanelSnapshot): string {
    return renderAiPanel(getPromptRecoveryContent(snapshot));
}
