'use strict';

import * as Icons from '../webviewIcons';
import { escapeAttribute } from '../webviewHtmlEscape';
import { sanitizeCssColor } from './webviewCssSanitize';
import type {
    MachineEnvironmentViewModel,
    MachineProjectRowViewModel,
    MachineProjectsViewModel,
    MachineRowViewModel,
} from '../projects/machineProjectsViewModel';

export function renderMachineProjectsPanel(
    model: MachineProjectsViewModel,
    managedRemoteRevisionId?: string | null,
    canSaveCurrentProject = true,
): string {
    const managedAttributes = managedRemoteRevisionId === undefined
        ? ''
        : ` data-managed-remote-projects data-managed-revision-id="${escapeAttribute(managedRemoteRevisionId || '')}"`;
    const addManagedMachine = managedRemoteRevisionId === undefined
        ? ''
        : `<button type="button" class="machine-toolbar-button" data-managed-operation="addMachine" aria-label="Add Managed Machine" title="Add Managed Machine">${Icons.add}<span class="managed-toolbar-label">Machine</span></button>`;
    const openFileTransfer = `<button type="button" class="machine-toolbar-button" data-action="open-file-transfer" aria-label="Open File Transfer" title="Open File Transfer">${Icons.handoff}</button>`;
    const saveCurrentProject = `<button type="button" class="machine-toolbar-button" data-action="save-current-project" aria-label="Save Current Project" title="${canSaveCurrentProject ? 'Save Current Project' : 'Open a project before saving it'}"${canSaveCurrentProject ? '' : ' disabled'}>${Icons.save}</button>`;
    if (!model.machines.length) {
        return `<section class="machine-projects machine-projects-empty" data-machine-projects${managedAttributes} data-machine-project-count="0">
            <div class="machine-projects-toolbar">
                <span class="machine-projects-summary">0 projects</span>
                <div class="machine-projects-toolbar-actions">${openFileTransfer}${saveCurrentProject}${addManagedMachine}</div>
            </div>
            <p>No projects have been added yet.</p>
        </section>`;
    }
    return `<section class="machine-projects" data-machine-projects${managedAttributes} data-machine-project-count="${model.projectCount}">
        <div class="machine-projects-toolbar">
            <div class="machine-projects-summary" data-machine-projects-summary role="status" aria-live="polite">
                ${formatResultCount(model.projectCount, model.machines.length)}
            </div>
            <div class="machine-projects-toolbar-actions">
                ${renderTagControls(model.tags)}
                ${openFileTransfer}
                ${addManagedMachine}
                ${saveCurrentProject}
            </div>
        </div>
        ${renderFavorites(model.favorites)}
        <section class="machine-projects-directory" aria-labelledby="machine-projects-directory-title">
            <h2 id="machine-projects-directory-title" class="machine-projects-visually-hidden">Machines</h2>
            <ul class="machine-projects-machines">
                ${model.machines.map(renderMachineProjectsMachine).join('\n')}
            </ul>
        </section>
        <div class="machine-projects-announcer machine-projects-visually-hidden" data-machine-projects-announcer aria-live="polite"></div>
    </section>`;
}

function renderTagControls(tags: string[]): string {
    if (!tags.length) { return ''; }
    return `<div class="machine-tag-filter">
        <button type="button" class="machine-toolbar-button machine-tag-filter-trigger" data-action="toggle-machine-tags" aria-expanded="false" aria-controls="machine-tag-popover" aria-label="Filter projects by tag" title="Filter projects by tag">
            ${Icons.tag}
            <span class="machine-filter-count" data-machine-filter-count hidden></span>
        </button>
        <div id="machine-tag-popover" class="machine-tag-popover" data-machine-tag-popover hidden>
            <div class="machine-tag-popover-heading">Matches all</div>
            ${tags.map(tag => `<label class="machine-tag-option">
                <input type="checkbox" value="${escapeAttribute(tag.toLocaleLowerCase())}" data-machine-tag-checkbox>
                <span title="${escapeAttribute(tag)}">${escapeAttribute(tag)}</span>
            </label>`).join('\n')}
            <div class="machine-tag-popover-actions">
                <button type="button" class="machine-clear-filters" data-action="clear-machine-tags" hidden>Clear</button>
                <button type="button" class="machine-tag-done" data-action="close-machine-tags">Done</button>
            </div>
        </div>
    </div>`;
}

function renderFavorites(projects: MachineProjectRowViewModel[]): string {
    if (!projects.length) { return ''; }
    return `<section class="machine-favorites" data-machine-favorites>
        <h2 class="machine-section-heading">
            <button type="button" class="machine-disclosure" data-machine-disclosure="favorites" aria-expanded="true" aria-controls="machine-favorites-list" aria-label="Collapse Favorites">
                <span class="machine-chevron" aria-hidden="true">${Icons.collapse}</span>
                <span>FAVORITES</span>
                <span class="machine-count">${projects.length}</span>
            </button>
        </h2>
        <ul id="machine-favorites-list" class="machine-favorite-list">
            ${projects.map(project => renderMachineProjectsProject(project, true)).join('\n')}
        </ul>
    </section>`;
}

export function renderMachineProjectsMachine(machine: MachineRowViewModel): string {
    const childrenId = `machine-children-${machine.id}`;
    const machineTitle = machine.renamed
        ? `${machine.displayName} — connection: ${machine.defaultName}`
        : machine.displayName;
    return `<li class="machine-row" data-machine-row data-machine-id="${escapeAttribute(machine.id)}" data-machine-name="${escapeAttribute(machine.displayName)}">
        <div class="machine-row-line">
            <button type="button" class="machine-row-primary machine-disclosure" data-machine-disclosure="machine" aria-expanded="true" aria-controls="${childrenId}" aria-label="Collapse ${escapeAttribute(machine.displayName)}">
                <span class="machine-chevron" aria-hidden="true">${Icons.collapse}</span>
                <span class="machine-row-icon machine-computer-icon" aria-hidden="true">${Icons.computer}</span>
                <span class="machine-row-name" title="${escapeAttribute(machineTitle)}">${escapeAttribute(machine.displayName)}</span>
            </button>
            <div class="machine-row-actions">
                ${machine.hostOpenable && machine.hostProjectId
                    ? `<button type="button" class="machine-pointer-action machine-primary-action" data-action="open-machine-host" data-host-project-id="${escapeAttribute(machine.hostProjectId)}" aria-label="Open ${escapeAttribute(machine.displayName)} in a new window" title="Open ${escapeAttribute(machine.displayName)} in a new window">${Icons.openNewWindow}</button>`
                    : ''}
                <div class="machine-project-menu-shell">
                    <button type="button" class="machine-pointer-action machine-more-action" data-action="toggle-machine-menu" aria-label="More actions for ${escapeAttribute(machine.displayName)}" title="More actions" aria-haspopup="menu" aria-expanded="false">${Icons.moreActions}</button>
                    <div class="machine-project-menu" data-machine-project-menu role="menu" hidden>
                        <button type="button" role="menuitem" tabindex="-1" data-action="rename-machine">Rename Machine…</button>
                        ${machine.renamed ? `<button type="button" role="menuitem" tabindex="-1" data-action="reset-machine-name">Reset to ${escapeAttribute(machine.defaultName)}</button>` : ''}
                    </div>
                </div>
            </div>
        </div>
        <ul id="${childrenId}" class="machine-environment-list">
            ${machine.environments.map(environment => renderEnvironment(machine, environment)).join('\n')}
        </ul>
    </li>`;
}

function renderEnvironment(
    machine: MachineRowViewModel,
    environment: MachineEnvironmentViewModel,
): string {
    const childrenId = `environment-children-${environment.id}`;
    const isHost = environment.kind === 'host';
    return `<li class="machine-environment-row" data-machine-environment-row data-environment-id="${escapeAttribute(environment.id)}" data-environment-kind="${environment.kind}">
        <div class="machine-row-line">
            <button type="button" class="machine-environment-primary machine-disclosure" data-machine-disclosure="environment" aria-expanded="true" aria-controls="${childrenId}" aria-label="Collapse ${escapeAttribute(environment.displayName)}">
                <span class="machine-chevron" aria-hidden="true">${Icons.collapse}</span>
                <span class="machine-row-icon" aria-hidden="true">${isHost ? Icons.terminalLine : Icons.container}</span>
                <span class="machine-row-name" title="${escapeAttribute(environment.displayName)}">${escapeAttribute(environment.displayName)}</span>
            </button>
        </div>
        <ul id="${childrenId}" class="machine-project-list">
            ${environment.projects.map(project => renderMachineProjectsProject(project, false)).join('\n')}
        </ul>
    </li>`;
}

export function renderMachineProjectsProject(project: MachineProjectRowViewModel, favorite: boolean): string {
    const identityName = favorite
        ? `Favorite shortcut to ${project.name}, on ${project.machineName}, ${project.environmentName}`
        : `Open ${project.name} on ${project.machineName}, ${project.environmentName}`;
    const tags = project.tags.map(tag => tag.toLocaleLowerCase());
    const color = sanitizeCssColor(project.color);
    const source = favorite ? 'favorite' : 'directory';
    return `<li class="machine-project-row${favorite ? ' machine-favorite-row' : ''}" data-machine-project-row data-machine-project-id="${escapeAttribute(project.id)}" data-machine-id="${escapeAttribute(project.machineId)}" data-environment-id="${escapeAttribute(project.environmentId)}" data-machine-project-tags="${escapeAttribute(JSON.stringify(tags))}" data-machine-search="${escapeAttribute(project.searchText)}">
        <div class="machine-row-line">
            <button type="button" class="machine-project-primary" data-action="open-machine-project" aria-label="${escapeAttribute(identityName)}" title="${escapeAttribute(project.path)}">
                <span class="machine-project-color"${color ? ` style="background: ${escapeAttribute(color)}"` : ''} aria-hidden="true"></span>
                <span class="machine-row-name">${escapeAttribute(project.name)}</span>
            </button>
            ${favorite
                ? `<span class="machine-project-context" title="${escapeAttribute(`${project.machineName} › ${project.environmentName}`)}">${escapeAttribute(`${project.machineName} › ${project.environmentName}`)}</span>`
                : ''}
            <div class="machine-project-actions">
                <button type="button" class="machine-pointer-action machine-favorite-action${project.favorite ? ' is-active' : ''}" data-action="toggle-machine-favorite" aria-label="${project.favorite ? 'Remove' : 'Add'} ${escapeAttribute(project.name)} ${project.favorite ? 'from' : 'to'} Favorites" title="${project.favorite ? 'Remove from Favorites' : 'Add to Favorites'}">${project.favorite ? Icons.starFilled : Icons.star}</button>
                <div class="machine-project-menu-shell">
                    <button type="button" class="machine-pointer-action machine-more-action" data-action="toggle-machine-project-menu" aria-label="More actions for ${escapeAttribute(project.name)}" title="More actions" aria-haspopup="menu" aria-expanded="false">${Icons.moreActions}</button>
                    <div class="machine-project-menu" data-machine-project-menu role="menu" hidden>
                        <button type="button" role="menuitem" tabindex="-1" data-action="open-machine-project-current">Open in Current Window</button>
                        <div class="machine-project-menu-separator" role="separator"></div>
                        <button type="button" role="menuitem" tabindex="-1" data-action="show-edit-local-project-form">Edit Project…</button>
                        <button type="button" role="menuitem" tabindex="-1" data-action="color-machine-project">Edit Color…</button>
                        <button type="button" role="menuitem" tabindex="-1" class="danger" data-action="remove-machine-project">Remove Project…</button>
                    </div>
                </div>
            </div>
        </div>
        <form class="managed-machine-form managed-project-form" data-local-project-form data-local-project-form-source="${source}" data-local-project-id="${escapeAttribute(project.id)}" data-local-group-id="${escapeAttribute(project.groupId)}" hidden>
            <div class="managed-machine-form-heading"><strong>Edit ${escapeAttribute(project.name)}</strong><span>Update this local Project.</span></div>
            <div class="managed-machine-form-fields">
                <label>Project name<input name="name" autocomplete="off" required maxlength="256" value="${escapeAttribute(project.name)}"></label>
                <label>Description<textarea name="description" maxlength="8192">${escapeAttribute(project.description || '')}</textarea></label>
                <label>Tags<input name="tags" autocomplete="off" maxlength="8192" value="${escapeAttribute(project.tags.join(', '))}" placeholder="frontend, urgent"></label>
            </div>
            <p id="local-edit-project-form-error-${escapeAttribute(project.id)}-${source}" class="managed-machine-form-error" data-local-project-form-error role="alert" hidden></p>
            <div class="managed-machine-form-actions"><button type="button" class="machine-clear-filters" data-action="cancel-local-project-form">Cancel</button><button type="submit" class="managed-machine-form-submit">Save changes</button></div>
        </form>
    </li>`;
}

function formatResultCount(projectCount: number, machineCount: number): string {
    return `${projectCount} project${projectCount === 1 ? '' : 's'} on ${machineCount} machine${machineCount === 1 ? '' : 's'}`;
}
