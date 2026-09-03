'use strict';

import * as Icons from '../webviewIcons';
import { escapeAttribute } from '../webviewHtmlEscape';
import type {
    MachineEnvironmentViewModel,
    MachineProjectRowViewModel,
    MachineProjectsViewModel,
    MachineRowViewModel,
} from '../projects/machineProjectsViewModel';

export function renderMachineProjectsPanel(model: MachineProjectsViewModel): string {
    if (!model.machines.length) {
        return `<section class="machine-projects machine-projects-empty" data-machine-projects data-machine-project-count="0">
            <div class="machine-projects-toolbar">
                <button type="button" class="machine-projects-add" data-action="add-project">Add Project</button>
            </div>
            <p>No projects have been added yet.</p>
        </section>`;
    }
    return `<section class="machine-projects" data-machine-projects data-machine-project-count="${model.projectCount}">
        <div class="machine-projects-toolbar">
            ${renderTagControls(model.tags)}
            <button type="button" class="machine-projects-add" data-action="add-project">Add</button>
        </div>
        <div class="machine-projects-summary" data-machine-projects-summary role="status" aria-live="polite">
            ${formatResultCount(model.projectCount, model.machines.length)}
        </div>
        ${renderFavorites(model.favorites)}
        <section class="machine-projects-directory" aria-labelledby="machine-projects-directory-title">
            <h2 id="machine-projects-directory-title" class="machine-projects-visually-hidden">Machines</h2>
            <ul class="machine-projects-machines">
                ${model.machines.map(renderMachine).join('\n')}
            </ul>
        </section>
        <div class="machine-projects-announcer machine-projects-visually-hidden" data-machine-projects-announcer aria-live="polite"></div>
    </section>`;
}

function renderTagControls(tags: string[]): string {
    if (!tags.length) { return ''; }
    return `<div class="machine-tag-filter">
        <button type="button" class="machine-tag-filter-trigger" data-action="toggle-machine-tags" aria-expanded="false" aria-controls="machine-tag-popover">
            Tags
        </button>
        <div id="machine-tag-popover" class="machine-tag-popover" data-machine-tag-popover hidden>
            <div class="machine-tag-popover-heading">Matches all</div>
            ${tags.map(tag => `<label class="machine-tag-option">
                <input type="checkbox" value="${escapeAttribute(tag.toLocaleLowerCase())}" data-machine-tag-checkbox>
                <span title="${escapeAttribute(tag)}">${escapeAttribute(tag)}</span>
            </label>`).join('\n')}
            <button type="button" class="machine-tag-done" data-action="close-machine-tags">Done</button>
        </div>
        <div class="machine-tag-selection" data-machine-tag-selection aria-hidden="true"></div>
        <button type="button" class="machine-clear-filters" data-action="clear-machine-tags" hidden>Clear filters</button>
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
            ${projects.map(project => renderProject(project, true)).join('\n')}
        </ul>
    </section>`;
}

function renderMachine(machine: MachineRowViewModel): string {
    const childrenId = `machine-children-${machine.id}`;
    return `<li class="machine-row" data-machine-row data-machine-id="${escapeAttribute(machine.id)}" data-machine-name="${escapeAttribute(machine.displayName)}">
        <div class="machine-row-line">
            <button type="button" class="machine-row-primary machine-disclosure" data-machine-disclosure="machine" aria-expanded="true" aria-controls="${childrenId}" aria-label="Collapse ${escapeAttribute(machine.displayName)}">
                <span class="machine-chevron" aria-hidden="true">${Icons.collapse}</span>
                <span class="machine-row-icon" aria-hidden="true">${Icons.remote}</span>
                <span class="machine-row-name" title="${escapeAttribute(machine.displayName)}">${escapeAttribute(machine.displayName)}</span>
            </button>
            ${machine.hostOpenable && machine.hostProjectId
                ? `<button type="button" class="machine-pointer-action machine-primary-action" data-action="open-machine-host" data-host-project-id="${escapeAttribute(machine.hostProjectId)}" aria-label="Open Host on ${escapeAttribute(machine.displayName)} in a new window" title="Open Host in New Window">${Icons.openNewWindow}</button>`
                : ''}
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
            ${environment.projects.map(project => renderProject(project, false)).join('\n')}
        </ul>
    </li>`;
}

function renderProject(project: MachineProjectRowViewModel, favorite: boolean): string {
    const identityName = favorite
        ? `Favorite shortcut to ${project.name}, on ${project.machineName}, ${project.environmentName}`
        : `Open ${project.name} on ${project.machineName}, ${project.environmentName}`;
    const tags = project.tags.map(tag => tag.toLocaleLowerCase());
    return `<li class="machine-project-row${favorite ? ' machine-favorite-row' : ''}" data-machine-project-row data-machine-project-id="${escapeAttribute(project.id)}" data-machine-id="${escapeAttribute(project.machineId)}" data-environment-id="${escapeAttribute(project.environmentId)}" data-machine-project-tags="${escapeAttribute(JSON.stringify(tags))}" data-machine-search="${escapeAttribute(project.searchText)}">
        <div class="machine-row-line">
            <button type="button" class="machine-project-primary" data-action="open-machine-project" aria-label="${escapeAttribute(identityName)}" title="${escapeAttribute(project.path)}">
                ${favorite ? `<span class="machine-favorite-star" aria-hidden="true">${Icons.starFilled}</span>` : ''}
                <span class="machine-row-name">${escapeAttribute(project.name)}</span>
            </button>
            ${favorite
                ? `<span class="machine-project-context" title="${escapeAttribute(`${project.machineName} › ${project.environmentName}`)}">${escapeAttribute(`${project.machineName} › ${project.environmentName}`)}</span>`
                : renderProjectTags(project.tags)}
            <button type="button" class="machine-pointer-action" data-action="toggle-machine-favorite" aria-label="${project.favorite ? 'Remove from Favorites' : 'Add to Favorites'}">${project.favorite ? Icons.starFilled : Icons.star}</button>
        </div>
    </li>`;
}

function renderProjectTags(tags: string[]): string {
    if (!tags.length) { return ''; }
    const shown = tags.slice(0, 2);
    return `<span class="machine-project-tags" aria-label="Tags: ${escapeAttribute(tags.join(', '))}">${shown.map(tag => `<span class="machine-project-tag" title="${escapeAttribute(tag)}">#${escapeAttribute(tag)}</span>`).join('')}${tags.length > shown.length ? `<span class="machine-project-tag-more">+${tags.length - shown.length}</span>` : ''}</span>`;
}

function formatResultCount(projectCount: number, machineCount: number): string {
    return `${projectCount} project${projectCount === 1 ? '' : 's'} on ${machineCount} machine${machineCount === 1 ? '' : 's'}`;
}
