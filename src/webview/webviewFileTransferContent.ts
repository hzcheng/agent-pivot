'use strict';

import type { ManagedRemoteManagementSnapshot } from '../projects/managedRemote/managementController';
import { escapeAttribute } from '../webviewHtmlEscape';
import * as Icons from '../webviewIcons';

function machineOptions(snapshot: ManagedRemoteManagementSnapshot | undefined): string {
    const machines = snapshot?.lifecycle === 'active'
        ? snapshot.catalog.machines.slice().sort((left, right) => left.name.localeCompare(right.name))
        : [];
    return machines.map(machine => `<option value="managed:${escapeAttribute(machine.id)}">${escapeAttribute(machine.name)}</option>`).join('');
}

function endpointPicker(side: 'left' | 'right', machineOptionHtml: string): string {
    const label = side === 'left' ? 'Left endpoint' : 'Right endpoint';
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
    const label = side === 'left' ? 'Left endpoint files' : 'Right endpoint files';
    return `<section class="file-transfer-pane" data-file-transfer-pane="${side}" aria-label="${label}">
        <header class="file-transfer-pane-header">
            <div>
                <strong data-file-transfer-pane-name>Choose an endpoint</strong>
                <span data-file-transfer-pane-path>—</span>
            </div>
            <button type="button" data-file-transfer-refresh="${side}" aria-label="Refresh ${label}" title="Refresh" disabled>↻</button>
        </header>
        <div class="file-transfer-pane-status" data-file-transfer-pane-status role="status">Choose an endpoint to browse its files.</div>
        <ul class="file-transfer-file-list" data-file-transfer-file-list hidden></ul>
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
        <header class="file-transfer-header">
            <div>
                <h2>File Transfer</h2>
                <p>Browse two endpoints and copy in either direction.</p>
            </div>
            <button type="button" class="file-transfer-tasks" data-file-transfer-tasks disabled title="Transfer tasks will appear here">Transfers <span>0</span></button>
        </header>
        <div class="file-transfer-pair" role="group" aria-label="Choose transfer endpoints">
            ${endpointPicker('left', options)}
            <span class="file-transfer-pair-arrow" aria-hidden="true">↔</span>
            ${endpointPicker('right', options)}
        </div>
        <p class="file-transfer-pair-hint" data-file-transfer-pair-hint>Select two endpoints. They are equal until you select files to copy.</p>
        <div class="file-transfer-panes">
            ${pane('left')}
            ${pane('right')}
        </div>
        <footer class="file-transfer-action-bar" data-file-transfer-action-bar>
            <span data-file-transfer-summary>Select files in either pane to choose a copy direction.</span>
            <button type="button" data-file-transfer-review disabled>Review copy ${Icons.handoff}</button>
        </footer>
        <section class="file-transfer-review" data-file-transfer-review-sheet role="dialog" aria-modal="true" aria-label="Review file copy" hidden>
            <h3>Review copy</h3>
            <p data-file-transfer-review-summary></p>
            <label class="file-transfer-conflict-policy">If a target already exists
                <select data-file-transfer-conflict-policy>
                    <option value="fail">Stop and show the conflict</option>
                    <option value="skip">Skip the existing item</option>
                    <option value="replace">Replace the existing item</option>
                </select>
            </label>
            <p class="file-transfer-review-note">Copy will begin only after you select Start copy.</p>
            <div class="file-transfer-review-actions">
                <button type="button" data-file-transfer-review-cancel>Back</button>
                <button type="button" data-file-transfer-start-copy>Start copy</button>
            </div>
        </section>
        <section class="file-transfer-history" aria-label="Recent transfers">
            <h3>Recent transfers</h3>
            <ul data-file-transfer-history-list><li>Loading transfer history…</li></ul>
        </section>
    </section>`;
}
