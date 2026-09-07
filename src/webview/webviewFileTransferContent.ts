'use strict';

import type { ManagedRemoteManagementSnapshot } from '../projects/managedRemote/managementController';
import { escapeAttribute } from '../webviewHtmlEscape';
import * as Icons from '../webviewIcons';

function machineOptions(snapshot: ManagedRemoteManagementSnapshot | undefined): string {
    const blockedMachineIds = new Set<string>();
    for (const conflict of snapshot?.catalog.conflicts || []) {
        blockedMachineIds.add(conflict.entityId);
        for (const relatedId of conflict.relatedEntityIds || []) {
            blockedMachineIds.add(relatedId);
        }
    }
    const machines = snapshot?.lifecycle === 'active'
        ? snapshot.catalog.machines.filter(machine => !blockedMachineIds.has(machine.id))
            .sort((left, right) => left.name.localeCompare(right.name))
        : [];
    return machines.map(machine => `<option value="managed:${escapeAttribute(machine.id)}">${escapeAttribute(machine.name)}</option>`).join('');
}

function endpointPicker(side: 'left' | 'right', machineOptionHtml: string): string {
    const label = side === 'left' ? 'Source' : 'Target';
    return `<label class="file-transfer-endpoint-picker">
        <span>${label}</span>
        <select data-file-transfer-endpoint="${side}" aria-label="${label}">
            <option value="">Choose endpoint…</option>
            <option value="local">This Computer…</option>
            ${machineOptionHtml}
        </select>
    </label>`;
}

function pane(side: 'left' | 'right'): string {
    const label = side === 'left' ? 'Source files' : 'Target folder';
    const role = side === 'left' ? 'Source' : 'Target folder';
    return `<section class="file-transfer-pane" data-file-transfer-pane="${side}" aria-label="${label}">
        <header class="file-transfer-pane-header">
            <div>
                <span class="file-transfer-pane-role" data-file-transfer-pane-role>${role}</span>
                <strong data-file-transfer-pane-name>Choose an endpoint</strong>
                <nav class="file-transfer-pane-path" data-file-transfer-pane-path aria-label="Current directory">—</nav>
                <label class="file-transfer-path-input">
                    <span>Path</span>
                    <input type="text" data-file-transfer-path-input="${side}" aria-label="Open path in ${label}" disabled>
                </label>
            </div>
            <div class="file-transfer-pane-actions">
                <button type="button" data-file-transfer-up="${side}" aria-label="Go up in ${label}" title="Up" disabled>↑</button>
                <button type="button" data-file-transfer-refresh="${side}" aria-label="Refresh ${label}" title="Refresh" disabled>↻</button>
            </div>
        </header>
        <div class="file-transfer-pane-toolbar" data-file-transfer-pane-toolbar="${side}">
            <label class="file-transfer-filter">
                <span>Filter</span>
                <input type="search" data-file-transfer-filter="${side}" aria-label="Filter loaded files in ${label}" placeholder="Loaded files" disabled>
            </label>
            <label class="file-transfer-show-hidden">
                <input type="checkbox" data-file-transfer-show-hidden="${side}" disabled>
                <span>Show hidden</span>
            </label>
            <label class="file-transfer-sort">
                <span>Sort</span>
                <select data-file-transfer-sort="${side}" aria-label="Sort ${label}" disabled>
                    <option value="name">Name</option>
                    <option value="type">Type</option>
                    <option value="modified">Modified</option>
                    <option value="size">Size</option>
                </select>
            </label>
        </div>
        <div class="file-transfer-pane-status" data-file-transfer-pane-status role="status">Choose an endpoint to browse its files.</div>
        <ul class="file-transfer-file-list" data-file-transfer-file-list role="tree" aria-label="${label} directory tree" hidden></ul>
    </section>`;
}

/**
 * The File Transfer page is deliberately rendered with only machine IDs. The
 * local UI Bridge remains the authority for endpoint access and filesystem data.
 */
export function getFileTransferContent(
    snapshot: ManagedRemoteManagementSnapshot | undefined,
): string {
    const options = machineOptions(snapshot);
    return `<section class="file-transfer" data-file-transfer>
        <div class="file-transfer-workspace-header">
            <header class="file-transfer-header">
                <div>
                    <h2>File Transfer</h2>
                    <p>Choose a source and target folder. Files are relayed securely through this computer.</p>
                </div>
                <button type="button" class="file-transfer-tasks" data-file-transfer-tasks disabled title="Transfer tasks will appear here">Transfers <span>0</span></button>
            </header>
            <section class="file-transfer-saved-pairs" data-file-transfer-saved-pairs aria-label="Recent endpoint pairs" hidden>
                <h3>Recent endpoint pairs</h3>
                <ul data-file-transfer-saved-pair-list></ul>
            </section>
            <div class="file-transfer-pair" role="group" aria-label="Choose transfer endpoints">
                ${endpointPicker('left', options)}
                <button type="button" class="file-transfer-swap" data-file-transfer-swap title="Switch source and target" aria-label="Switch source and target">⇄</button>
                ${endpointPicker('right', options)}
            </div>
            <p class="file-transfer-pair-hint" data-file-transfer-pair-hint>Select a source and a target. Source files always travel left to right.</p>
            <section class="file-transfer-readiness" data-file-transfer-readiness aria-live="polite">
                <span data-file-transfer-bridge-status>UI Bridge waiting</span>
                <span data-file-transfer-source-status>Source not selected</span>
                <span data-file-transfer-target-status>Target not selected</span>
            </section>
        </div>
        <p class="file-transfer-task-status" data-file-transfer-task-status aria-live="polite" hidden></p>
        <button type="button" class="file-transfer-reveal-target" data-file-transfer-reveal-target hidden>Reveal target</button>
        <button type="button" class="file-transfer-retry" data-file-transfer-retry hidden>Retry failed items</button>
        <ul class="file-transfer-task-list" data-file-transfer-task-list aria-label="Transfer tasks" hidden></ul>
        <div class="file-transfer-panes">
            ${pane('left')}
            ${pane('right')}
        </div>
        <footer class="file-transfer-action-bar" data-file-transfer-action-bar>
            <span data-file-transfer-summary>Select source files after both endpoints are ready.</span>
            <button type="button" data-file-transfer-start-copy disabled>Transfer</button>
        </footer>
        <section class="file-transfer-history" aria-label="Recent transfers">
            <div class="file-transfer-history-heading">
                <h3>Recent transfers</h3>
                <button type="button" data-file-transfer-clear-history disabled>Clear history</button>
            </div>
            <ul data-file-transfer-history-list><li>Loading transfer history…</li></ul>
        </section>
    </section>`;
}
