'use strict';

import * as path from 'path';

import type { SkillAgentId, SkillRecord, SkillSourceDir, SkillVisibility } from '../skills/types';
import { DISABLED_DIR_NAME } from '../skills/roots';
import { FIXABLE_DIAGNOSTIC_CODES } from '../skills/fixService';
import type { SkillCollectionSuggestion } from '../skills/knownCollections';
import { getSkillGroupName, getSkillStableKey, SkillGroupMap } from '../skills/skillGroupStore';
import {
    computeSkillDuplicates,
    SkillCopyTarget,
    SkillDuplicateGroup,
} from '../skills/syncService';

export interface SkillPanelView {
    groups?: SkillGroupMap;
    suggestions?: SkillCollectionSuggestion[];
    copyTargets?: Map<string, SkillCopyTarget[]>;
    duplicates?: Map<string, SkillDuplicateGroup>;
}
import { sanitizeProjectName } from '../models';
import { escapeAttribute } from './webviewContent';
import { collapse as collapseIcon, folder as folderIcon, terminalLine } from './webviewIcons';

const AGENTS: SkillAgentId[] = ['kimi', 'claude', 'codex'];

function agentChip(agent: SkillAgentId, visibility: SkillVisibility): string {
    if (visibility === 'active') {
        return `<span class="skill-chip agent-${agent}">${agent}</span>`;
    }
    if (visibility === 'shadowed') {
        return `<span class="skill-chip warn">⚠ ${agent}</span>`;
    }
    return `<span class="skill-chip agent-absent">${agent}</span>`;
}

function getSkillDetail(record: SkillRecord, view: SkillPanelView, duplicate?: SkillDuplicateGroup): string {
    const groups = view.groups || {};
    const centralRows = record.central
        ? `<p class="skill-detail-title">Linked agents</p>` + AGENTS.map(agent => {
            const linkPath = record.central?.links[agent];
            const state = linkPath ? 'on' : 'off';
            return `<div class="skill-detail-row skill-central-row">${agentChip(agent, linkPath ? 'active' : 'absent')}`
                + `<button type="button" class="skill-toggle skill-central-toggle${state === 'off' ? ' off' : ''}" title="${linkPath ? 'Disable' : 'Enable'} for ${agent}" data-central-toggle="${escapeAttribute(record.dirPath)}" data-central-source="${agent}"></button>`
                + `<span class="skill-detail-path">${linkPath ? escapeAttribute(linkPath) : 'not linked'}</span></div>`;
        }).join('')
        : '';
    const rows = AGENTS.map(agent => {
        const visibility = record.visibility[agent];
        const status = visibility === 'active'
            ? '<span class="skill-detail-status ok">✓ active</span>'
            : visibility === 'shadowed'
                ? '<span class="skill-detail-status warn">⚠ shadowed</span>'
                : '<span class="skill-detail-status">—</span>';
        const detail = visibility === 'shadowed'
            ? `${escapeAttribute(record.shadowedBy[agent] || '')} wins`
            : visibility === 'active'
                ? escapeAttribute(record.dirPath)
                : 'not visible';
        return `<div class="skill-detail-row">${agentChip(agent, visibility === 'shadowed' ? 'shadowed' : visibility)}${status}<span class="skill-detail-path">${detail}</span></div>`;
    }).join('');
    const driftRows = duplicate && duplicate.drift
        ? `<p class="skill-detail-title">Copies of this skill</p>` + duplicate.copies.map(copy => {
            const isThis = copy.dirPath === record.dirPath;
            const hash = copy.contentHash ? `#${copy.contentHash.slice(0, 7)}` : '#???????';
            return `<div class="skill-detail-row skill-drift-row">`
                + `<span class="skill-detail-path">${escapeAttribute(copy.dirPath)} ${hash}${isThis ? ' (this copy)' : ''}</span>`
                + (isThis
                    ? ''
                    : `<button type="button" class="skill-sync" data-skill-sync="${escapeAttribute(copy.dirPath)}" data-skill-sync-target="${escapeAttribute(record.dirPath)}">Use this copy</button>`)
                + `</div>`;
        }).join('')
        : '';
    const notes = record.diagnostics.map(item => {
        const fixable = FIXABLE_DIAGNOSTIC_CODES.includes(item.code);
        const fixButton = fixable
            ? ` <button type="button" class="skill-fix" data-skill-fix="${escapeAttribute(record.dirPath)}" data-skill-fix-code="${item.code}">Fix</button>`
            : '';
        return `<p class="skill-detail-note">⚠ ${escapeAttribute(item.message)}${fixButton}</p>`;
    }).join('');
    const groupName = getSkillGroupName(record, groups);
    const dirPath = escapeAttribute(record.dirPath);
    const groupEditor = `<div class="skill-group-editor">
        ${groupName
            ? `<span class="skill-chip group" title="Group">${escapeAttribute(groupName)}<button type="button" class="skill-ungroup" title="Remove from group" data-skill-ungroup="${dirPath}">×</button></span>`
            : ''}
        <input class="skill-group-input" type="text" placeholder="Set group…" list="skill-group-names" data-skill-group-input="${dirPath}">
        <button type="button" class="skill-setgroup" data-skill-setgroup="${dirPath}">Set</button>
    </div>`;
    return `<div class="skill-detail" hidden>
        <p class="skill-detail-title">Effectiveness per agent</p>
        ${centralRows}${rows}${driftRows}${notes}
        <div class="skill-detail-actions">
            <button class="primary" data-skill-open="${escapeAttribute(record.skillFilePath)}">Open SKILL.md</button>
        </div>
        ${groupEditor}
    </div>`;
}

function getSkillDiv(record: SkillRecord, view: SkillPanelView): string {
    const groups = view.groups || {};
    const duplicate = view.duplicates ? view.duplicates.get(`${record.scope}:${record.name}`) : undefined;
    const name = escapeAttribute(sanitizeProjectName(record.name));
    const description = escapeAttribute(sanitizeProjectName(record.description));
    const scopeLabel = record.scope === 'user' ? 'User' : 'Project';
    const activeAgents = AGENTS.filter(agent => record.visibility[agent] === 'active').join(' ');
    const shadowed = AGENTS.some(agent => record.visibility[agent] === 'shadowed');
    const drift = duplicate && duplicate.drift;
    const warnChip = drift
        ? `<span class="skill-chip warn" data-skill-warn>⚠ drift</span>`
        : shadowed
            ? `<span class="skill-chip warn" data-skill-warn>⚠ shadowed</span>`
            : record.diagnostics.length
                ? `<span class="skill-chip warn" data-skill-warn>⚠ ${record.diagnostics.length} issue${record.diagnostics.length === 1 ? '' : 's'}</span>`
                : '';
    const copyTargets = view.copyTargets ? view.copyTargets.get(getSkillStableKey(record)) : undefined;
    const copyRow = copyTargets && copyTargets.length
        ? `<div class="skill-copy-row">Copy to: ${copyTargets.map(target => `<button type="button" class="skill-copy" data-skill-copy="${escapeAttribute(record.dirPath)}" data-skill-copy-root="${escapeAttribute(target.rootDir)}">${target.source}</button>`).join('')}</div>`
        : '';
    const chips = `<span class="skill-chip scope-${record.scope}">${scopeLabel}</span>`
        + (record.central ? '<span class="skill-chip central" title="Centralized in the shared store">central</span>' : '')
        + AGENTS.map(agent => agentChip(agent, record.visibility[agent])).join('')
        + warnChip;
    const parkedNote = record.enabled ? '' : `<span class="skill-parked-note">parked at ${escapeAttribute(record.dirPath)}</span>`;
    const centralizeButton = record.central || !record.enabled
        ? ''
        : `<button type="button" class="skill-centralize" title="Move into the shared store and link from agents" data-skill-centralize="${escapeAttribute(record.dirPath)}">Centralize</button>`;
    const masterToggle = record.central
        ? ''
        : `<button class="skill-toggle${record.enabled ? '' : ' off'}" title="${record.enabled ? 'Disable' : 'Enable'} skill" data-skill-toggle="${escapeAttribute(record.dirPath)}"></button>`;
    return `
<div class="project-container" draggable="true" data-skill-scope="${record.scope}">
    <div class="project steward-item-card skill-card${record.enabled ? '' : ' skill-card-disabled'}" data-skill-dir="${escapeAttribute(record.dirPath)}" data-skill-agents="${activeAgents}">
        <div class="project-aura"></div>
        <div class="project-border steward-item-accent"></div>
        ${masterToggle}
        <div class="fitty-container project-title-row">
            <span class="project-kind-icon">${terminalLine}</span>
            <h2 class="project-header">${name}</h2>
        </div>
        <p class="project-description" title="${description}">${description}</p>
        ${parkedNote}
        <div class="skill-chip-row">${chips}${centralizeButton}<span class="skill-expand-hint" title="Show details">${collapseIcon}</span></div>
        ${copyRow}
        ${getSkillDetail(record, view, duplicate)}
    </div>
</div>`;
}

const SOURCE_ORDER: SkillSourceDir[] = ['kimi', 'claude', 'codex', 'agents', 'central'];
const SOURCE_LABELS: Record<SkillSourceDir, string> = {
    kimi: 'Kimi',
    claude: 'Claude',
    codex: 'Codex',
    agents: 'Agents',
    central: 'Central',
};

interface SkillSourceGroup {
    source: SkillSourceDir;
    rootDir: string;
    items: SkillRecord[];
}

function getSkillRootDir(record: SkillRecord): string {
    const parent = path.dirname(record.dirPath);
    return path.basename(parent) === DISABLED_DIR_NAME ? path.dirname(parent) : parent;
}

function groupBySource(records: SkillRecord[]): SkillSourceGroup[] {
    const byRoot = new Map<string, SkillSourceGroup>();
    for (const record of records) {
        const rootDir = getSkillRootDir(record);
        let group = byRoot.get(rootDir);
        if (!group) {
            group = { source: record.source, rootDir, items: [] };
            byRoot.set(rootDir, group);
        }
        group.items.push(record);
    }
    return [...byRoot.values()]
        .sort((a, b) => {
            const order = SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source);
            return order !== 0 ? order : a.rootDir.localeCompare(b.rootDir);
        })
        .map(group => ({
            ...group,
            items: group.items.slice().sort((a, b) => a.name.localeCompare(b.name)),
        }));
}

function renderSourceGroup(group: SkillSourceGroup, view: SkillPanelView): string {
    const rootDir = escapeAttribute(group.rootDir);
    return `<div class="skill-source-group" data-skill-source="${group.source}">
    <div class="skill-source-header">
        <span class="skill-source-label">${SOURCE_LABELS[group.source]}</span>
        <span class="skill-source-path" title="${rootDir}">${rootDir}</span>
        <span class="skill-source-count">${group.items.length}</span>
    </div>
    ${group.items.map(item => getSkillDiv(item, view)).join('\n')}
</div>`;
}

function renderCollection(name: string, scope: string, items: SkillRecord[], view: SkillPanelView): string {
    const groups = view.groups || {};
    const id = `skill-collection-${scope}-${encodeURIComponent(name)}`;
    const allDisabled = items.every(item => !item.enabled);
    return `<div class="group steward-section skill-collection" data-group-id="${id}" data-skill-collection="${escapeAttribute(name)}" data-skill-collection-scope="${scope}">
    <div class="group-title steward-section-header steward-group-header">
        <span class="group-title-text" data-action="collapse">
            <span class="collapse-icon" title="Open/Collapse Group">${collapseIcon}</span>
            <span class="skill-collection-icon" aria-hidden="true">${folderIcon}</span>${escapeAttribute(name)}
        </span>
        <span class="group-title-badge">${items.length}</span>
        <button type="button" class="skill-toggle skill-group-toggle${allDisabled ? ' off' : ''}" title="${allDisabled ? 'Enable' : 'Disable'} group" data-skill-group-toggle="${escapeAttribute(name)}" data-skill-group-scope="${scope}"></button>
    </div>
    <div class="group-list">
        <div class="drop-signal"></div>
        ${items.map(item => getSkillDiv(item, view)).join('\n')}
    </div>
</div>`;
}

function renderScopeSection(title: string, scope: string, items: SkillRecord[], view: SkillPanelView): string {
    const groups = view.groups || {};
    const grouped = new Map<string, SkillRecord[]>();
    const ungrouped: SkillRecord[] = [];
    for (const item of items) {
        const groupName = getSkillGroupName(item, groups);
        if (!groupName) {
            ungrouped.push(item);
            continue;
        }
        const list = grouped.get(groupName) || [];
        list.push(item);
        grouped.set(groupName, list);
    }
    const collections = [...grouped.keys()]
        .sort((a, b) => a.localeCompare(b))
        .map(name => renderCollection(name, scope, grouped.get(name) as SkillRecord[], view));
    const sourceGroups = groupBySource(ungrouped).map(group => renderSourceGroup(group, view));
    return `
<div class="group steward-section" data-group-id="${title === 'USER SKILLS' ? 'user-skills' : 'project-skills'}">
    <div class="group-title steward-section-header steward-group-header">
        <span class="group-title-text" data-action="collapse">
            <span class="collapse-icon" title="Open/Collapse Group">${collapseIcon}</span>
            <span class="skill-collection-icon" aria-hidden="true">${folderIcon}</span>${scope === 'user' ? 'global' : 'project'}
        </span>
        <span class="group-title-badge">${items.length}</span>
    </div>
    <div class="group-list">
        <div class="drop-signal"></div>
        ${collections.join('\n')}
        ${sourceGroups.join('\n')}
    </div>
</div>`;
}

function renderFilterRow(): string {
    const buttons = ['all', ...AGENTS].map(agent => {
        const label = agent === 'all' ? 'All' : SOURCE_LABELS[agent as SkillSourceDir];
        return `<button type="button" class="skills-filter${agent === 'all' ? ' is-active' : ''}" data-skill-filter="${agent}">${label}</button>`;
    }).join('');
    const migrate = '<button type="button" class="skills-filter skills-migrate-central" data-skill-migrate-central '
        + 'title="Move every user skill from ~/.kimi, ~/.claude and ~/.codex into ~/.skills (duplicates parked, no agent links)">Migrate to central</button>';
    return `<div class="skills-filter-row" data-skill-filter-row role="group" aria-label="Filter skills by agent">${buttons}${migrate}</div>`;
}

function renderSuggestion(suggestion: SkillCollectionSuggestion): string {
    const name = escapeAttribute(suggestion.name);
    return `<div class="skill-suggestion" data-skill-suggestion="${name}">
    <span class="skill-collection-icon" aria-hidden="true">${folderIcon}</span>
    <span class="skill-suggestion-text">Detected <strong>${name}</strong> collection — ${suggestion.presentCount} skills here, ${suggestion.ungroupedCount} not in a folder yet.</span>
    <button type="button" class="skill-suggestion-apply" data-skill-apply-suggestion="${name}">Create folder</button>
    <button type="button" class="skill-suggestion-dismiss" title="Dismiss" data-skill-dismiss-suggestion="${name}">×</button>
</div>`;
}

export function getSkillsPanelContent(
    records: SkillRecord[],
    view: SkillPanelView = {},
): string {
    const groups = view.groups || {};
    const suggestions = view.suggestions || [];
    view.duplicates = view.duplicates || computeSkillDuplicates(records || []);
    const user = (records || []).filter(record => record.scope === 'user');
    const project = (records || []).filter(record => record.scope === 'project');
    const sections = [
        ['USER SKILLS', 'user', user],
        ['PROJECT SKILLS', 'project', project],
    ] as const;
    if (!records || records.length === 0) {
        return '<div class="sticky-groups-wrapper skills-groups-wrapper"><div class="skills-empty">No skills found in agent skill directories.</div></div>';
    }
    const groupNames = [...new Set(
        records
            .map(record => getSkillGroupName(record, groups))
            .filter((name): name is string => Boolean(name))
    )].sort();
    const datalist = groupNames.length
        ? `<datalist id="skill-group-names">${groupNames.map(name => `<option value="${escapeAttribute(name)}"></option>`).join('')}</datalist>`
        : '';
    return `<div class="sticky-groups-wrapper skills-groups-wrapper">${renderFilterRow()}${suggestions.map(renderSuggestion).join('')}${datalist}${sections
        .filter(([, , items]) => items.length)
        .map(([title, scope, items]) => renderScopeSection(title, scope, items, view)).join('\n')}
</div>`;
}
