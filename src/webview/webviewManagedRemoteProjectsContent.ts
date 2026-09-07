'use strict';

import type {
    ManagedRemoteEnvironmentViewModel,
    ManagedRemoteMachineViewModel,
    ManagedRemoteProjectRowViewModel,
    ManagedRemoteProjectsViewModel,
} from '../projects/managedRemote/viewModel';
import type { MachineProjectsViewModel } from '../projects/machineProjectsViewModel';
import {
    renderMachineProjectsMachine,
    renderMachineProjectsProject,
} from './webviewMachineProjectsContent';
import * as Icons from '../webviewIcons';
import { escapeAttribute } from '../webviewHtmlEscape';
import { sanitizeCssColor } from './webviewCssSanitize';

function operationAttributes(operation: string, targetId?: string): string {
    return `data-managed-operation="${escapeAttribute(operation)}"${targetId
        ? ` data-managed-target-id="${escapeAttribute(targetId)}"` : ''}`;
}

function renderTagControls(tags: string[]): string {
    if (!tags.length) { return ''; }
    return `<div class="machine-tag-filter">
        <button type="button" class="machine-toolbar-button machine-tag-filter-trigger" data-action="toggle-machine-tags" aria-expanded="false" aria-controls="managed-machine-tag-popover" aria-label="Filter Projects by tag" title="Filter Projects by tag">${Icons.tag}<span class="machine-filter-count" data-machine-filter-count hidden></span></button>
        <fieldset id="managed-machine-tag-popover" class="machine-tag-popover" data-machine-tag-popover hidden>
            <legend class="machine-tag-popover-heading">Match all selected tags</legend>
            ${tags.map(tag => `<label class="machine-tag-option"><input type="checkbox" value="${escapeAttribute(tag.toLocaleLowerCase())}" data-machine-tag-checkbox><span title="${escapeAttribute(tag)}">${escapeAttribute(tag)}</span></label>`).join('\n')}
            <div class="machine-tag-popover-actions"><button type="button" class="machine-clear-filters" data-action="clear-machine-tags" hidden>Clear</button><button type="button" class="machine-tag-done" data-action="close-machine-tags">Done</button></div>
        </fieldset>
    </div>`;
}

function renderAddMachineForm(): string {
    return `<form id="managed-machine-form" class="managed-machine-form" data-managed-machine-form data-managed-machine-form-operation="addMachine" hidden>
        <div class="managed-machine-form-heading"><strong>Add Machine</strong><span>Connection details are saved to your VS Code User settings.</span></div>
        <div class="managed-machine-form-fields">
            <label>Machine name<input name="name" autocomplete="off" required maxlength="128" placeholder="Build server"></label>
            <label>Host<input name="host" autocomplete="off" required maxlength="253" placeholder="build.example.com"></label>
            <label>SSH user<input name="user" autocomplete="username" required maxlength="256" placeholder="developer"></label>
            <label>Port<input name="port" type="number" inputmode="numeric" required min="1" max="65535" value="22"></label>
        </div>
        <p id="managed-add-machine-form-error" class="managed-machine-form-error" data-managed-machine-form-error role="alert" hidden></p>
        <div class="managed-machine-form-actions"><button type="button" class="machine-clear-filters" data-action="cancel-managed-machine-form">Cancel</button><button type="submit" class="managed-machine-form-submit" data-managed-operation="addMachine">Add Machine</button></div>
    </form>`;
}

function renderEditMachineForm(machine: ManagedRemoteMachineViewModel): string {
    const projectLabel = `${machine.projectCount} Project${machine.projectCount === 1 ? '' : 's'}`;
    return `<form id="managed-machine-edit-form-${escapeAttribute(machine.id)}" class="managed-machine-form managed-machine-edit-form" data-managed-machine-form data-managed-machine-form-operation="editMachine" data-managed-target-id="${escapeAttribute(machine.id)}" hidden>
        <div class="managed-machine-form-heading"><strong>Edit ${escapeAttribute(machine.name)}</strong><span>Changing this connection affects ${projectLabel}.</span></div>
        <div class="managed-machine-form-fields">
            <label>Machine name<input name="name" autocomplete="off" required maxlength="128" value="${escapeAttribute(machine.name)}"></label>
            <label>Host<input name="host" autocomplete="off" required maxlength="253" value="${escapeAttribute(machine.connection.host)}"></label>
            <label>SSH user<input name="user" autocomplete="username" required maxlength="256" value="${escapeAttribute(machine.connection.user)}"></label>
            <label>Port<input name="port" type="number" inputmode="numeric" required min="1" max="65535" value="${machine.connection.port}"></label>
        </div>
        <p id="managed-edit-machine-form-error-${escapeAttribute(machine.id)}" class="managed-machine-form-error" data-managed-machine-form-error role="alert" hidden></p>
        <div class="managed-machine-form-actions"><button type="button" class="machine-clear-filters" data-action="cancel-managed-machine-form">Cancel</button><button type="submit" class="managed-machine-form-submit" data-managed-operation="editMachine" data-managed-target-id="${escapeAttribute(machine.id)}">Save changes</button></div>
    </form>`;
}

function renderEditProjectForm(project: ManagedRemoteProjectRowViewModel, favorite: boolean): string {
    const source = favorite ? 'favorite' : 'directory';
    return `<form class="managed-machine-form managed-project-form" data-managed-project-form data-managed-project-form-source="${source}" data-managed-target-id="${escapeAttribute(project.id)}" hidden>
        <div class="managed-machine-form-heading"><strong>Edit ${escapeAttribute(project.name)}</strong><span>Update this Project in ${escapeAttribute(project.environmentName)}.</span></div>
        <div class="managed-machine-form-fields">
            <label>Project name<input name="name" autocomplete="off" required maxlength="256" value="${escapeAttribute(project.name)}"></label>
            <label>Absolute path<input name="remotePath" autocomplete="off" required maxlength="8192" value="${escapeAttribute(project.remotePath)}"></label>
            <label>Description<textarea name="description" maxlength="8192">${escapeAttribute(project.description || '')}</textarea></label>
            <label>Tags<input name="tags" autocomplete="off" maxlength="8192" value="${escapeAttribute((project.tags || []).join(', '))}" placeholder="backend, api"></label>
            <label>Color<input name="color" autocomplete="off" maxlength="256" value="${escapeAttribute(project.color || '')}" placeholder="#ef4444"></label>
        </div>
        <p id="managed-edit-project-form-error-${escapeAttribute(project.id)}-${source}" class="managed-machine-form-error" data-managed-project-form-error role="alert" hidden></p>
        <div class="managed-machine-form-actions"><button type="button" class="machine-clear-filters" data-action="cancel-managed-project-form">Cancel</button><button type="submit" class="managed-machine-form-submit" data-managed-operation="editProject" data-managed-target-id="${escapeAttribute(project.id)}">Save changes</button></div>
    </form>`;
}

function renderProject(
    project: ManagedRemoteProjectRowViewModel,
    favorite: boolean,
): string {
    const baseName = favorite
        ? `Favorite shortcut to ${project.name}, on ${project.machineName} (${project.machineEndpoint}), ${project.environmentName}`
        : `Open ${project.name} on ${project.machineName} (${project.machineEndpoint}), ${project.environmentName}`;
    const accessibleName = project.openable
        ? baseName : `${baseName}. Unavailable: ${project.unavailableReason}`;
    const color = sanitizeCssColor(project.color);
    return `<li class="machine-project-row${favorite ? ' machine-favorite-row' : ''}" data-machine-project-row data-managed-project-row data-machine-project-id="${escapeAttribute(project.id)}" data-machine-id="${escapeAttribute(project.machineId)}" data-environment-id="${escapeAttribute(project.environmentId)}" data-machine-project-tags="${escapeAttribute(JSON.stringify((project.tags || []).map(tag => tag.toLocaleLowerCase())))}" data-machine-search="${escapeAttribute(project.searchText)}">
        <div class="machine-row-line">
            <button type="button" class="machine-project-primary" data-managed-client-action="openProject" data-managed-target-id="${escapeAttribute(project.id)}" aria-label="${escapeAttribute(accessibleName)}" title="${escapeAttribute(project.remotePath)}"${project.openable ? '' : ' disabled'}><span class="machine-project-color"${color ? ` style="background: ${escapeAttribute(color)}"` : ''} aria-hidden="true"></span><span class="machine-row-name">${escapeAttribute(project.name)}</span></button>
            ${favorite ? `<span class="machine-project-context" title="${escapeAttribute(`${project.machineName} › ${project.environmentName}`)}">${escapeAttribute(`${project.machineName} › ${project.environmentName}`)}</span>` : ''}
            <div class="machine-project-actions">
                <button type="button" class="machine-pointer-action machine-favorite-action${project.favorite ? ' is-active' : ''}" ${operationAttributes('toggleFavorite', project.id)} aria-label="${project.favorite ? 'Remove' : 'Add'} ${escapeAttribute(project.name)} ${project.favorite ? 'from' : 'to'} Favorites" title="${project.favorite ? 'Remove from Favorites' : 'Add to Favorites'}">${project.favorite ? Icons.starFilled : Icons.star}</button>
                <div class="machine-project-menu-shell"><button type="button" class="machine-pointer-action machine-more-action" data-action="toggle-machine-project-menu" aria-label="More actions for ${escapeAttribute(project.name)}" title="More actions" aria-haspopup="menu" aria-expanded="false">${Icons.moreActions}</button><div class="machine-project-menu" data-machine-project-menu role="menu" hidden>
                    <button type="button" role="menuitem" tabindex="-1" data-action="show-edit-project-form" data-managed-target-id="${escapeAttribute(project.id)}">Edit Project…</button>
                    <button type="button" role="menuitem" tabindex="-1" class="danger" ${operationAttributes('removeProject', project.id)}>Remove Project…</button>
                </div></div>
            </div>
        </div>
        ${renderEditProjectForm(project, favorite)}
    </li>`;
}

function renderEnvironment(
    environment: ManagedRemoteEnvironmentViewModel,
): string {
    const childrenId = `managed-environment-children-${environment.id}`;
    const openName = `Open ${environment.name} on its Machine in a new window`;
    return `<li class="machine-environment-row${environment.conflict ? ' has-conflict' : ''}" data-machine-environment-row data-environment-id="${escapeAttribute(environment.id)}" data-environment-kind="${escapeAttribute(environment.kind)}">
        <div class="machine-row-line">
            <button type="button" class="machine-environment-primary machine-disclosure" data-machine-disclosure="environment" aria-expanded="true" aria-controls="${childrenId}" aria-label="Collapse ${escapeAttribute(environment.name)}"><span class="machine-chevron" aria-hidden="true">${Icons.collapse}</span><span class="machine-row-icon" aria-hidden="true">${environment.kind === 'host' ? Icons.terminalLine : Icons.container}</span><span class="machine-row-name">${escapeAttribute(environment.name)}</span></button>
            ${environment.kind === 'devContainer' ? `<div class="machine-row-actions"><button type="button" class="machine-pointer-action machine-primary-action" data-managed-client-action="openEnvironment" data-managed-target-id="${escapeAttribute(environment.id)}" aria-label="${escapeAttribute(environment.openable ? openName : `${openName}. Unavailable: ${environment.unavailableReason}`)}" title="${escapeAttribute(openName)}"${environment.openable ? '' : ' disabled'}>${Icons.openNewWindow}</button></div>` : ''}
        </div>
        <ul id="${childrenId}" class="machine-project-list">${environment.projects.map(project => renderProject(project, false)).join('\n')}</ul>
    </li>`;
}

function renderMachine(
    machine: ManagedRemoteMachineViewModel,
): string {
    const childrenId = `managed-machine-children-${machine.id}`;
    const openName = `Open ${machine.name}, ${machine.endpoint}, in a new window`;
    const machineTitle = `${machine.name} — ${machine.endpoint}`;
    return `<li class="machine-row${machine.conflict ? ' has-conflict' : ''}" data-machine-row data-managed-machine-row data-machine-id="${escapeAttribute(machine.id)}" data-machine-name="${escapeAttribute(machine.name)}">
        <div class="machine-row-line">
            <button type="button" class="machine-row-primary machine-disclosure" data-machine-disclosure="machine" aria-expanded="true" aria-controls="${childrenId}" aria-label="Collapse ${escapeAttribute(`${machine.name}, ${machine.endpoint}`)}" title="${escapeAttribute(machineTitle)}"><span class="machine-chevron" aria-hidden="true">${Icons.collapse}</span><span class="machine-row-icon machine-computer-icon" aria-hidden="true">${Icons.computer}</span><span class="machine-row-name">${escapeAttribute(machine.name)}</span></button>
            <div class="machine-row-actions">
                <button type="button" class="machine-pointer-action machine-primary-action" data-managed-client-action="openMachine" data-managed-target-id="${escapeAttribute(machine.id)}" aria-label="${escapeAttribute(machine.openable ? openName : `${openName}. Unavailable: ${machine.unavailableReason}`)}" title="${escapeAttribute(openName)}"${machine.openable ? '' : ' disabled'}>${Icons.openNewWindow}</button>
                <div class="machine-project-menu-shell"><button type="button" class="machine-pointer-action machine-more-action" data-action="toggle-machine-menu" aria-label="More actions for ${escapeAttribute(`${machine.name}, ${machine.endpoint}`)}" title="More actions" aria-haspopup="menu" aria-expanded="false">${Icons.moreActions}</button><div class="machine-project-menu" data-machine-project-menu role="menu" hidden>
                    <button type="button" role="menuitem" tabindex="-1" data-action="show-edit-machine-form" data-managed-target-id="${escapeAttribute(machine.id)}">Edit Machine…</button>
                    ${machine.conflict ? `<button type="button" role="menuitem" tabindex="-1" ${operationAttributes('resolveMachineConflict', machine.id)}>Review Connection Conflict…</button>` : ''}
                    <button type="button" role="menuitem" tabindex="-1" data-managed-client-action="sshTerminal" data-managed-target-id="${escapeAttribute(machine.id)}"${machine.openable ? '' : ' disabled'}>Open SSH Terminal…</button>
                    <button type="button" role="menuitem" tabindex="-1" data-managed-client-action="copySsh" data-managed-target-id="${escapeAttribute(machine.id)}"${machine.openable ? '' : ' disabled'}>Copy SSH Command</button>
                    <button type="button" role="menuitem" tabindex="-1" class="danger" ${operationAttributes('removeMachine', machine.id)}>Remove Machine…</button>
                </div></div>
            </div>
        </div>
        ${renderEditMachineForm(machine)}
        ${machine.conflict ? '<div class="managed-remote-row-status">Connection conflict — Review</div>' : ''}
        <ul id="${childrenId}" class="machine-environment-list">${machine.environments.map(environment => renderEnvironment(environment)).join('\n')}</ul>
    </li>`;
}

export function renderManagedRemoteProjectsPanel(
    model: ManagedRemoteProjectsViewModel,
    localModel: MachineProjectsViewModel = {
        projectCount: 0, tags: [], favorites: [], machines: [],
    },
    canSaveCurrentProject = true,
): string {
    const revision = model.revisionId || '';
    const projectCount = model.projectCount + localModel.projectCount;
    const machineCount = model.machines.length + localModel.machines.length;
    const tags = Array.from(new Map([...model.tags, ...localModel.tags]
        .map(tag => [tag.toLocaleLowerCase(), tag])).values())
        .sort((left, right) => left.localeCompare(right));
    const favoriteCount = model.favorites.length + localModel.favorites.length;
    const openFileTransfer = `<button type="button" class="machine-toolbar-button machine-transfer-action" data-action="open-file-transfer" aria-label="Open File Transfer" title="Open File Transfer">${Icons.handoff}<span class="managed-toolbar-label">Transfer</span></button>`;
    return `<section class="machine-projects managed-remote-projects" data-machine-projects data-managed-remote-projects data-managed-revision-id="${escapeAttribute(revision)}" data-managed-lifecycle="${escapeAttribute(model.lifecycle)}" data-machine-project-count="${projectCount}">
        <div class="machine-projects-toolbar">
            <div class="machine-projects-summary" data-machine-projects-summary role="status" aria-live="polite">${projectCount} project${projectCount === 1 ? '' : 's'} on ${machineCount} machine${machineCount === 1 ? '' : 's'}</div>
            <div class="machine-projects-toolbar-actions">${renderTagControls(tags)}${openFileTransfer}<button type="button" class="machine-toolbar-button" data-action="save-current-project" aria-label="Save Current Project" title="${canSaveCurrentProject ? 'Save Current Project' : 'Open a project before saving it'}"${canSaveCurrentProject ? '' : ' disabled'}>${Icons.save}</button><button type="button" class="machine-toolbar-button" data-action="show-add-machine-form" aria-expanded="false" aria-controls="managed-machine-form" aria-label="Add Machine" title="Add Machine">${Icons.add}</button></div>
        </div>${renderAddMachineForm()}
        ${favoriteCount ? `<section class="machine-favorites" data-machine-favorites><h2 class="machine-section-heading"><button type="button" class="machine-disclosure" data-machine-disclosure="favorites" aria-expanded="true" aria-controls="managed-machine-favorites-list" aria-label="Collapse Favorites"><span class="machine-chevron" aria-hidden="true">${Icons.collapse}</span><span>FAVORITES</span><span class="machine-count">${favoriteCount}</span></button></h2><ul id="managed-machine-favorites-list" class="machine-favorite-list">${localModel.favorites.map(project => renderMachineProjectsProject(project, true)).join('\n')}${model.favorites.map(project => renderProject(project, true)).join('\n')}</ul></section>` : ''}
        <section class="machine-projects-directory" aria-labelledby="managed-machine-projects-directory-title"><h2 id="managed-machine-projects-directory-title" class="machine-projects-visually-hidden">Machines</h2>${machineCount ? `<ul class="machine-projects-machines">${localModel.machines.map(renderMachineProjectsMachine).join('\n')}${model.machines.map(machine => renderMachine(machine)).join('\n')}</ul>` : '<p class="managed-remote-empty">No Projects or managed Machines yet.</p>'}</section>
        <div class="machine-projects-announcer machine-projects-visually-hidden" data-machine-projects-announcer aria-live="polite"></div>
    </section>`;
}
