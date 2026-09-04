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

function renderClientBanner(model: ManagedRemoteProjectsViewModel): string {
    const action = model.clientState === 'enableRequired'
            ? '<button type="button" class="managed-remote-banner-action" data-managed-client-action="enable">Enable on This Computer</button>'
            : model.clientState === 'attention'
                ? '<button type="button" class="managed-remote-banner-action" data-managed-client-action="recover">Retry</button>'
                : model.clientState === 'remoteSshMissing'
                    ? '<button type="button" class="managed-remote-banner-action" data-managed-client-action="installRemoteSsh">Install Remote - SSH</button>'
                    : model.clientState === 'ready'
                        ? '<button type="button" class="managed-remote-banner-action" data-managed-client-action="disable">Disable on This Computer…</button>'
                        : '';
    return `<div class="managed-remote-banner managed-remote-banner-${escapeAttribute(model.clientState)}" data-managed-client-banner role="status">
        <span class="managed-remote-banner-icon" aria-hidden="true">${Icons.remote}</span>
        <span class="managed-remote-banner-message">${escapeAttribute(model.clientMessage)}</span>
        ${action}
    </div>`;
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

function renderProject(project: ManagedRemoteProjectRowViewModel, favorite: boolean): string {
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
                <button type="button" class="machine-pointer-action machine-favorite-action${project.favorite ? ' is-active' : ''}" ${operationAttributes('toggleFavorite', project.id)} aria-label="${project.favorite ? 'Remove from Favorites' : 'Add to Favorites'}" title="${project.favorite ? 'Remove from Favorites' : 'Add to Favorites'}">${project.favorite ? Icons.starFilled : Icons.star}</button>
                <div class="machine-project-menu-shell"><button type="button" class="machine-pointer-action machine-more-action" data-action="toggle-machine-project-menu" aria-label="More actions for ${escapeAttribute(project.name)}" title="More actions" aria-haspopup="menu" aria-expanded="false">${Icons.moreActions}</button><div class="machine-project-menu" data-machine-project-menu role="menu" hidden>
                    <button type="button" role="menuitem" tabindex="-1" ${operationAttributes('editProject', project.id)}>Edit Project…</button>
                    <button type="button" role="menuitem" tabindex="-1" class="danger" ${operationAttributes('removeProject', project.id)}>Remove Project…</button>
                </div></div>
            </div>
        </div>
    </li>`;
}

function renderEnvironment(environment: ManagedRemoteEnvironmentViewModel): string {
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

function renderMachine(machine: ManagedRemoteMachineViewModel): string {
    const childrenId = `managed-machine-children-${machine.id}`;
    const openName = `Open ${machine.name}, ${machine.endpoint}, in a new window`;
    return `<li class="machine-row${machine.conflict ? ' has-conflict' : ''}" data-machine-row data-managed-machine-row data-machine-id="${escapeAttribute(machine.id)}" data-machine-name="${escapeAttribute(machine.name)}">
        <div class="machine-row-line">
            <button type="button" class="machine-row-primary machine-disclosure" data-machine-disclosure="machine" aria-expanded="true" aria-controls="${childrenId}" aria-label="Collapse ${escapeAttribute(`${machine.name}, ${machine.endpoint}`)}"><span class="machine-chevron" aria-hidden="true">${Icons.collapse}</span><span class="machine-row-icon machine-computer-icon" aria-hidden="true">${Icons.computer}</span><span class="machine-row-copy"><span class="machine-row-name">${escapeAttribute(machine.name)}</span><span class="managed-machine-endpoint">${escapeAttribute(machine.endpoint)}</span></span></button>
            <div class="machine-row-actions">
                <button type="button" class="machine-pointer-action machine-primary-action" data-managed-client-action="openMachine" data-managed-target-id="${escapeAttribute(machine.id)}" aria-label="${escapeAttribute(machine.openable ? openName : `${openName}. Unavailable: ${machine.unavailableReason}`)}" title="${escapeAttribute(openName)}"${machine.openable ? '' : ' disabled'}>${Icons.openNewWindow}</button>
                <div class="machine-project-menu-shell"><button type="button" class="machine-pointer-action machine-more-action" data-action="toggle-machine-menu" aria-label="More actions for ${escapeAttribute(`${machine.name}, ${machine.endpoint}`)}" title="More actions" aria-haspopup="menu" aria-expanded="false">${Icons.moreActions}</button><div class="machine-project-menu" data-machine-project-menu role="menu" hidden>
                    <button type="button" role="menuitem" tabindex="-1" ${operationAttributes('addProject', machine.id)}>Add Project…</button>
                    <button type="button" role="menuitem" tabindex="-1" ${operationAttributes('editMachine', machine.id)}>Edit Machine…</button>
                    ${machine.conflict ? `<button type="button" role="menuitem" tabindex="-1" ${operationAttributes('resolveMachineConflict', machine.id)}>Review Connection Conflict…</button>` : ''}
                    <button type="button" role="menuitem" tabindex="-1" data-managed-client-action="regenerate"${machine.openable ? '' : ' disabled'}>Regenerate SSH Config</button>
                    <button type="button" role="menuitem" tabindex="-1" data-managed-client-action="sshTerminal" data-managed-target-id="${escapeAttribute(machine.id)}"${machine.openable ? '' : ' disabled'}>Open SSH Terminal…</button>
                    <button type="button" role="menuitem" tabindex="-1" data-managed-client-action="copySsh" data-managed-target-id="${escapeAttribute(machine.id)}"${machine.openable ? '' : ' disabled'}>Copy SSH Command</button>
                    <button type="button" role="menuitem" tabindex="-1" class="danger" ${operationAttributes('removeMachine', machine.id)}>Remove Machine…</button>
                </div></div>
            </div>
        </div>
        ${machine.conflict ? '<div class="managed-remote-row-status">Connection conflict — Review</div>' : ''}
        <ul id="${childrenId}" class="machine-environment-list">${machine.environments.map(renderEnvironment).join('\n')}</ul>
    </li>`;
}

export function renderManagedRemoteProjectsPanel(
    model: ManagedRemoteProjectsViewModel,
    localModel: MachineProjectsViewModel = {
        projectCount: 0, tags: [], favorites: [], machines: [],
    },
): string {
    const revision = model.revisionId || '';
    const projectCount = model.projectCount + localModel.projectCount;
    const machineCount = model.machines.length + localModel.machines.length;
    const tags = Array.from(new Map([...model.tags, ...localModel.tags]
        .map(tag => [tag.toLocaleLowerCase(), tag])).values())
        .sort((left, right) => left.localeCompare(right));
    const favoriteCount = model.favorites.length + localModel.favorites.length;
    return `<section class="machine-projects managed-remote-projects" data-machine-projects data-managed-remote-projects data-managed-revision-id="${escapeAttribute(revision)}" data-managed-lifecycle="${escapeAttribute(model.lifecycle)}" data-machine-project-count="${projectCount}">
        ${renderClientBanner(model)}
        <div class="machine-projects-toolbar">
            <div class="machine-projects-summary" data-machine-projects-summary role="status" aria-live="polite">${projectCount} project${projectCount === 1 ? '' : 's'} on ${machineCount} machine${machineCount === 1 ? '' : 's'}</div>
            <div class="machine-projects-toolbar-actions">${renderTagControls(tags)}<button type="button" class="machine-toolbar-button" ${operationAttributes('addMachine')} aria-label="Add Machine" title="Add Machine">${Icons.add}<span class="managed-toolbar-label">Machine</span></button><button type="button" class="machine-toolbar-button" ${operationAttributes('addProject')} aria-label="Add Project" title="Add Project">${Icons.add}<span class="managed-toolbar-label">Project</span></button></div>
        </div>
        ${favoriteCount ? `<section class="machine-favorites" data-machine-favorites><h2 class="machine-section-heading"><button type="button" class="machine-disclosure" data-machine-disclosure="favorites" aria-expanded="true" aria-controls="managed-machine-favorites-list" aria-label="Collapse Favorites"><span class="machine-chevron" aria-hidden="true">${Icons.collapse}</span><span>FAVORITES</span><span class="machine-count">${favoriteCount}</span></button></h2><ul id="managed-machine-favorites-list" class="machine-favorite-list">${localModel.favorites.map(project => renderMachineProjectsProject(project, true)).join('\n')}${model.favorites.map(project => renderProject(project, true)).join('\n')}</ul></section>` : ''}
        <section class="machine-projects-directory" aria-labelledby="managed-machine-projects-directory-title"><h2 id="managed-machine-projects-directory-title" class="machine-projects-visually-hidden">Machines</h2>${machineCount ? `<ul class="machine-projects-machines">${localModel.machines.map(renderMachineProjectsMachine).join('\n')}${model.machines.map(renderMachine).join('\n')}</ul>` : '<p class="managed-remote-empty">No Projects or managed Machines yet.</p>'}</section>
        <div class="machine-projects-announcer machine-projects-visually-hidden" data-machine-projects-announcer aria-live="polite"></div>
    </section>`;
}
