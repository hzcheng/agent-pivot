'use strict';

// Renderer for the OPEN tab window-switcher group (PRD: 常驻 WINDOWS N 单行切换器).
// PR-A: pure renderer, not yet wired into getStewardContent; PR-B replaces the
// CURRENT WINDOW / OPEN WINDOWS groups with this output.

import type { OpenWindowRowViewModel } from '../openWorkspaces/windowRowViewModel';
import type { OpenWorkspaceBridgeStatus } from '../openWorkspaces/bridgeClient';
import { escapeAttribute } from '../webviewHtmlEscape';
import * as Icons from '../webviewIcons';

export const OPEN_WINDOW_SWITCHER_GROUP_ID = 'open-window-switcher';

function getWindowRowTooltip(row: OpenWindowRowViewModel): string {
    const lines = row.kind === 'current'
        ? [`Current window: ${row.fullName}`]
        : [`Focus window: ${row.fullName}`];
    if (row.environmentLabel && row.environmentLabel !== 'Local') {
        lines.push(row.environmentLabel);
    }
    if (row.folderNames.length > 0) {
        lines.push(
            `${row.folderNames.length} folder${row.folderNames.length === 1 ? '' : 's'}: ${row.folderNames.join(', ')}`,
        );
    }
    return lines.join('\n');
}

function getCountSlot(
    value: number,
    className: string,
    marker: string,
    label: (count: number) => string,
    emptyLabel: string,
): string {
    const text = value > 0 ? `${marker}${value}` : '';
    const aria = value > 0 ? label(value) : emptyLabel;
    return `<span class="${className}" aria-label="${escapeAttribute(aria)}" title="${escapeAttribute(aria)}">${text}</span>`;
}

export function getOpenWindowRowHtml(
    row: OpenWindowRowViewModel,
    options: { disabled?: boolean } = {},
): string {
    const isCurrent = row.kind === 'current';
    const disabled = options.disabled === true && !isCurrent;
    const tooltip = getWindowRowTooltip(row);
    const escapedName = escapeAttribute(row.displayName);
    const escapedCardId = escapeAttribute(row.cardId);
    const escapedIdentity = escapeAttribute(row.navigationIdentity);
    const envChip = row.environmentLabel && row.environmentLabel !== 'Local'
        ? `<span class="open-window-env-chip">${escapeAttribute(row.environmentLabel)}</span>`
        : '';
    const focusLabel = isCurrent
        ? `Current window: ${row.fullName}`
        : `Focus window: ${row.fullName}`;
    const pinTitle = row.pinned ? 'Unpin Window' : 'Pin Window';
    const focusAria = [
        isCurrent ? 'aria-disabled="true" aria-current="true"' : '',
        disabled ? 'aria-disabled="true"' : '',
    ].filter(Boolean).join(' ');
    return `<div class="open-window-row${isCurrent ? ' open-window-row-current' : ''}${row.pinned ? ' open-window-row-pinned' : ''}${disabled ? ' open-window-row-disabled' : ''}" role="listitem" data-open-window-row data-id="${escapedCardId}" data-workspace-navigation-identity="${escapedIdentity}" data-window-kind="${row.kind}"${disabled ? ' data-navigation-disabled="true"' : ''}>
    <span class="open-window-indicator" aria-hidden="true"></span>
    <button type="button" class="open-window-focus" data-action="focus-open-window" title="${escapeAttribute(tooltip)}" aria-label="${escapeAttribute(focusLabel)}"${focusAria ? ' ' + focusAria : ''}>
        <span class="open-window-icon" aria-hidden="true">${Icons.remote}</span>
        <span class="open-window-name">${escapedName}</span>
        ${envChip}
        <span class="open-window-jump-hint" aria-hidden="true">&#8599;</span>
    </button>
    ${getCountSlot(row.runningCount, 'open-window-running', '\u25CF', count => `${count} session${count === 1 ? '' : 's'} running in this window`, 'No running sessions')}
    ${getCountSlot(row.attentionCount, 'open-window-attention', '\u26A0', count => `${count} session${count === 1 ? '' : 's'} need${count === 1 ? 's' : ''} attention in this window`, 'Nothing needs attention')}
    <button type="button" class="open-window-pin${row.pinned ? ' active' : ''}" data-action="toggle-open-workspace-pin" title="${pinTitle}" aria-label="${pinTitle}" aria-pressed="${row.pinned ? 'true' : 'false'}">${Icons.pin}</button>
    <button type="button" class="open-window-more" data-action="open-window-menu" title="More actions" aria-label="More actions" aria-haspopup="menu" aria-expanded="false">${Icons.moreActions}</button>
    <button type="button" class="open-window-retry" data-action="retry-open-window-navigation" hidden>Retry</button>
</div>`;
}

export function getOpenWindowMenu(): string {
    // The single shared window-row menu (PRD: ⋯ 更多)。Item visibility is set
    // per row when the menu opens; actions dispatch through the window-row
    // behaviors (navigation request protocol / pin / save-current-workspace).
    return `
<div id="openWindowMenu" class="custom-context-menu open-window-menu" role="menu" aria-label="Window actions">
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="focus-open-window" data-open-window-menu-non-current>Focus Window</div>
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="toggle-open-workspace-pin" data-open-window-menu-pin>Pin Window</div>
    <div class="custom-context-menu-item" role="menuitem" tabindex="-1" data-action="save-current-workspace" data-open-window-menu-current>Save Workspace</div>
</div>`;
}

/**
 * Renders the WINDOWS group: fixed-height internal-scroll list (PRD 滚动阈值
 * 与三态状态条槽位), no group collapse. `statusContent` carries the bridge
 * connecting/unavailable/update-required slot markup.
 */
export function getOpenWindowSwitcherGroupContent(
    rows: readonly OpenWindowRowViewModel[],
    otherWindowsStatus: OpenWorkspaceBridgeStatus = 'ready',
    statusContent: string = '',
): string {
    // PRD: bridge connecting 期间禁用其他窗口行（置灰 + 不可点），不做点击排队。
    const rowsDisabled = otherWindowsStatus !== 'ready';
    const rowsHtml = rows
        .map(row => getOpenWindowRowHtml(row, { disabled: rowsDisabled }))
        .join('\n');
    return `<div class="group open-window-switcher-group" role="list" aria-label="Windows" data-group-id="${OPEN_WINDOW_SWITCHER_GROUP_ID}" data-virtual-group data-system-group="${OPEN_WINDOW_SWITCHER_GROUP_ID}" data-other-windows-status="${otherWindowsStatus}">
    <div class="group-title open-window-switcher-header">
        <span class="group-title-text">WINDOWS</span>
        <span class="group-title-badge open-window-count">${rows.length}</span>
    </div>
    <div class="open-window-switcher-status" data-open-window-switcher-status>${statusContent}</div>
    <div class="open-window-switcher-list" data-open-window-switcher-list>
        <div class="open-workspace-pin-live-region" data-open-workspace-pin-live-region role="status" aria-live="polite" aria-atomic="true"></div>
        <div class="open-window-nav-live-region" data-open-window-nav-live-region role="status" aria-live="polite" aria-atomic="true"></div>
        ${rowsHtml}
    </div>
</div>`;
}
