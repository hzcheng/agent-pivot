'use strict';

import * as Icons from '../webviewIcons';
import { escapeAttribute } from '../webviewHtmlEscape';
import type {
    MachineEnvironmentViewModel,
    MachineProjectRowViewModel,
    MachineProjectsMigrationPreview,
    MachineProjectsViewModel,
    MachineRowViewModel,
} from '../projects/machineProjectsViewModel';

export function renderMachineProjectsPanel(model: MachineProjectsViewModel): string {
    if (model.kind === 'error') {
        return `<section class="machine-projects machine-projects-error" data-machine-projects>
            <h2>Remote Machines</h2>
            <p role="alert">${escapeAttribute(model.message)}</p>
            ${renderMigrationPreview(model.migrationPreview, true)}
            <div class="machine-migration-blocking-actions">
                <button type="button" class="machine-projects-add" data-action="repair-machine-preview">Repair V1 data</button>
                <button type="button" class="machine-tag-filter-trigger" data-action="retry-machine-preview">Retry</button>
                <button type="button" class="machine-tag-filter-trigger" data-action="cancel-machine-preview">Cancel preview</button>
            </div>
            <p>V1 projects remain active; no V2 data was activated.</p>
        </section>`;
    }
    if (!model.machines.length) {
        return `<section class="machine-projects machine-projects-empty" data-machine-projects data-machine-project-count="0">
            <div class="machine-projects-toolbar">
                <button type="button" class="machine-projects-add" data-action="add-project">Add Project</button>
            </div>
            <p>No projects have been added yet.</p>
        </section>`;
    }
    return `<section class="machine-projects" data-machine-projects data-machine-project-count="${model.projectCount}" data-profile-availability="${model.profileAvailability}">
        <div class="machine-projects-toolbar">
            ${renderTagControls(model.tags)}
            <button type="button" class="machine-projects-add" data-action="add-project">Add</button>
        </div>
        <div class="machine-projects-summary" data-machine-projects-summary role="status" aria-live="polite">
            ${formatResultCount(model.projectCount, model.machines.length)}
        </div>
        ${renderMigrationPreview(model.migrationPreview, false)}
        ${model.profileAvailability === 'unavailable'
            ? '<p class="machine-projects-bridge-warning" role="status">Connection setup is unavailable. <button type="button" data-action="open-machine-bridge">Update UI Bridge</button></p>'
            : ''}
        ${renderFavorites(model.favorites)}
        <section class="machine-projects-directory" aria-labelledby="machine-projects-directory-title">
            <h2 id="machine-projects-directory-title" class="machine-projects-visually-hidden">Machines</h2>
            <ul class="machine-projects-machines">
                ${model.machines.map(renderMachine).join('\n')}
            </ul>
        </section>
        <div class="machine-row-menu" data-machine-row-menu role="menu" hidden></div>
        <div class="machine-projects-announcer machine-projects-visually-hidden" data-machine-projects-announcer aria-live="polite"></div>
    </section>`;
}

function renderMigrationPreview(
    preview: MachineProjectsMigrationPreview,
    open: boolean,
): string {
    return `<details class="machine-migration-preview"${open ? ' open' : ''}>
        <summary>
            <span>Migration Preview</span>
            <span class="machine-migration-preview-state">V1 remains active</span>
        </summary>
        <div class="machine-migration-preview-body">
            <p>This view is a read-only projection. No V2 catalog has been activated.</p>
            <dl class="machine-migration-counts">
                ${renderPreviewCount('Existing groups', preview.legacyGroupCount)}
                ${renderPreviewCount('Existing projects', preview.legacyProjectCount)}
                ${renderPreviewCount('Machines', preview.machineCount)}
                ${renderPreviewCount('Environments', preview.environmentCount)}
                ${renderPreviewCount('Dev Containers', preview.devContainerCount)}
                ${renderPreviewCount('Group tags', preview.groupTagCount)}
            </dl>
            <div class="machine-migration-statuses" aria-label="Migration readiness">
                ${renderPreviewStatus('Ready', preview.readyProjectCount, 'ready')}
                ${renderPreviewStatus('Will be kept for review', preview.reviewProjectCount, 'review')}
                ${renderPreviewStatus('Cannot open until repaired', preview.cannotOpenProjectCount, 'repair')}
                ${renderPreviewStatus('Blocking', preview.blockingCount, 'blocking')}
            </div>
            ${preview.overLimitProjectCount
                ? `<p>${preview.overLimitProjectCount} project(s) retain tag limits for later review; ${preview.overLimitTagCount} tag(s) exceed 32 characters.</p>`
                : ''}
        </div>
    </details>`;
}

function renderPreviewCount(label: string, count: number): string {
    return `<div><dt>${label}</dt><dd>${count}</dd></div>`;
}

function renderPreviewStatus(label: string, count: number, kind: string): string {
    return `<div class="machine-migration-status machine-migration-status-${kind}"><span>${label}</span><strong>${count}</strong></div>`;
}

function renderTagControls(tags: string[]): string {
    if (!tags.length) { return ''; }
    return `<div class="machine-tag-filter">
        <button type="button" class="machine-tag-filter-trigger" data-action="toggle-machine-tags" aria-expanded="false" aria-controls="machine-tag-popover">
            Tags
        </button>
        <div id="machine-tag-popover" class="machine-tag-popover" data-machine-tag-popover hidden>
            <div class="machine-tag-popover-heading">Matches all</div>
            ${tags.map((tag, index) => `<label class="machine-tag-option">
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
    const configured = machine.connectionState === 'configured';
    const setupUnavailable = machine.connectionState === 'setupUnavailable';
    const action = configured ? 'open-machine-host' : 'setup-machine';
    const actionLabel = configured
        ? `Open Host on ${machine.displayName} in a new window`
        : `Set up connection for ${machine.displayName} in this VS Code`;
    const status = configured ? machine.connectionLabel
        : setupUnavailable ? 'Setup unavailable'
            : 'Not configured in this VS Code';
    return `<li class="machine-row" data-machine-row data-machine-id="${escapeAttribute(machine.id)}" data-machine-name="${escapeAttribute(machine.displayName)}">
        <div class="machine-row-line">
            <button type="button" class="machine-row-primary machine-disclosure" data-machine-disclosure="machine" aria-expanded="true" aria-controls="${childrenId}" aria-label="Collapse ${escapeAttribute(machine.displayName)}">
                <span class="machine-chevron" aria-hidden="true">${Icons.collapse}</span>
                <span class="machine-row-icon" aria-hidden="true">${Icons.remote}</span>
                <span class="machine-row-name" title="${escapeAttribute(machine.displayName)}">${escapeAttribute(machine.displayName)}</span>
            </button>
            <span class="machine-row-status" data-machine-connection-status data-default-text="${escapeAttribute(status)}" title="${escapeAttribute(status)}">${escapeAttribute(status)}</span>
            <button type="button" class="machine-pointer-action machine-primary-action" data-action="${action}" tabindex="-1" data-default-aria-label="${escapeAttribute(actionLabel)}" aria-label="${escapeAttribute(actionLabel)}"${setupUnavailable ? ' disabled' : ''}>
                ${configured ? Icons.openNewWindow : Icons.settings}
            </button>
            ${configured ? `<button type="button" data-machine-menu-source data-action="rebind-machine" tabindex="-1" data-default-aria-label="Rebind connection for ${escapeAttribute(machine.displayName)} in this VS Code" aria-label="Rebind connection for ${escapeAttribute(machine.displayName)} in this VS Code" hidden></button>` : ''}
            <button type="button" class="machine-pointer-action" data-action="open-remote-ssh-extension" tabindex="-1" aria-label="Install Remote - SSH" hidden>${Icons.puzzle}</button>
            <button type="button" class="machine-pointer-action" data-action="machine-row-menu" tabindex="-1" aria-label="More actions for Machine ${escapeAttribute(machine.displayName)}">${Icons.moreActions}</button>
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
            ${!isHost ? `<span class="machine-row-status">${environment.needsSetup ? 'Needs Setup' : 'Preview only'}</span>` : ''}
            <button type="button" class="machine-pointer-action" data-action="machine-row-menu" tabindex="-1" aria-label="More actions for ${escapeAttribute(environment.displayName)} on ${escapeAttribute(machine.displayName)}">${Icons.moreActions}</button>
        </div>
        <ul id="${childrenId}" class="machine-project-list">
            ${environment.projects.map(project => renderProject(project, false)).join('\n')}
        </ul>
    </li>`;
}

function renderProject(project: MachineProjectRowViewModel, favorite: boolean): string {
    const openable = project.navigationState === 'open';
    const unavailableReason = project.navigationState === 'needsConnection'
        ? 'Set up this Machine before opening the Project'
        : project.navigationState === 'unavailable'
            ? 'Update the Agent Pivot UI Bridge before opening the Project'
            : project.navigationState === 'needsRepair'
                ? 'Repair this Environment before opening the Project'
                : project.navigationState === 'needsAssignment'
                    ? 'Assign this Project to a Machine before opening it'
                    : 'Dev Container Projects are preview-only in this milestone';
    const unavailableState = project.navigationState === 'needsConnection' ? 'Setup'
        : project.navigationState === 'unavailable' ? 'Update'
            : project.navigationState === 'needsRepair' ? 'Repair'
                : project.navigationState === 'needsAssignment' ? 'Assign'
                    : 'Preview';
    const identityName = favorite
        ? `Favorite shortcut to ${project.name}, on ${project.machineName}, ${project.environmentName}`
        : `Open ${project.name} on ${project.machineName}, ${project.environmentName}`;
    const accessibleName = openable
        ? identityName
        : `${identityName}. Unavailable: ${unavailableReason}`;
    const tags = project.tags.map(tag => tag.toLocaleLowerCase());
    return `<li class="machine-project-row${favorite ? ' machine-favorite-row' : ''}" data-machine-project-row data-machine-project-id="${escapeAttribute(project.id)}" data-legacy-project-id="${escapeAttribute(project.legacyProjectId)}" data-machine-id="${escapeAttribute(project.machineId)}" data-machine-name="${escapeAttribute(project.machineName)}" data-environment-id="${escapeAttribute(project.environmentId)}" data-machine-project-tags="${escapeAttribute(JSON.stringify(tags))}" data-machine-search="${escapeAttribute(project.searchText)}">
        <div class="machine-row-line">
            <button type="button" class="machine-project-primary" data-action="${openable ? 'open-machine-project' : 'unavailable-machine-project'}" data-default-aria-label="${escapeAttribute(accessibleName)}" data-default-title="${escapeAttribute(openable ? project.path : unavailableReason)}" aria-label="${escapeAttribute(accessibleName)}" aria-disabled="${openable ? 'false' : 'true'}" title="${escapeAttribute(openable ? project.path : unavailableReason)}">
                ${favorite ? `<span class="machine-favorite-star" aria-hidden="true">${Icons.starFilled}</span>` : ''}
                <span class="machine-row-name">${escapeAttribute(project.name)}</span>
            </button>
            ${!openable
                ? `<span class="machine-project-state" title="${escapeAttribute(unavailableReason)}">${unavailableState}</span>`
                : favorite ? `<span class="machine-project-context" title="${escapeAttribute(`${project.machineName} › ${project.environmentName}`)}">${escapeAttribute(`${project.machineName} › ${project.environmentName}`)}</span>` : renderProjectTags(project.tags)}
            <button type="button" class="machine-pointer-action" data-action="toggle-machine-favorite" tabindex="-1" aria-label="${project.favorite ? 'Remove from Favorites' : 'Add to Favorites'}">${project.favorite ? Icons.starFilled : Icons.star}</button>
            <button type="button" class="machine-pointer-action" data-action="machine-row-menu" tabindex="-1" aria-label="More actions for ${escapeAttribute(project.name)}">${Icons.moreActions}</button>
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
