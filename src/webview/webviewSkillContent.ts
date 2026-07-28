'use strict';

import * as path from 'path';

import type { SkillAgentId, SkillRecord, SkillSourceDir, SkillVisibility } from '../skills/types';
import { DISABLED_DIR_NAME } from '../skills/roots';
import { getSkillGroupName, SkillGroupMap } from '../skills/skillGroupStore';
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

function getSkillDetail(record: SkillRecord, groups: SkillGroupMap): string {
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
    const notes = record.diagnostics.map(item => `<p class="skill-detail-note">⚠ ${escapeAttribute(item.message)}</p>`).join('');
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
        ${rows}${notes}
        <div class="skill-detail-actions">
            <button class="primary" data-skill-open="${escapeAttribute(record.skillFilePath)}">Open SKILL.md</button>
        </div>
        ${groupEditor}
    </div>`;
}

function getSkillDiv(record: SkillRecord, groups: SkillGroupMap): string {
    const name = escapeAttribute(sanitizeProjectName(record.name));
    const description = escapeAttribute(sanitizeProjectName(record.description));
    const scopeLabel = record.scope === 'user' ? 'User' : 'Project';
    const activeAgents = AGENTS.filter(agent => record.visibility[agent] === 'active').join(' ');
    const shadowed = AGENTS.some(agent => record.visibility[agent] === 'shadowed');
    const warnChip = shadowed
        ? `<span class="skill-chip warn" data-skill-warn>⚠ shadowed</span>`
        : record.diagnostics.length
            ? `<span class="skill-chip warn" data-skill-warn>⚠ ${record.diagnostics.length} issue${record.diagnostics.length === 1 ? '' : 's'}</span>`
            : '';
    const chips = `<span class="skill-chip scope-${record.scope}">${scopeLabel}</span>`
        + AGENTS.map(agent => agentChip(agent, record.visibility[agent])).join('')
        + warnChip;
    const parkedNote = record.enabled ? '' : `<span class="skill-parked-note">parked at ${escapeAttribute(record.dirPath)}</span>`;
    return `
<div class="project-container" draggable="true" data-skill-scope="${record.scope}">
    <div class="project steward-item-card skill-card${record.enabled ? '' : ' skill-card-disabled'}" data-skill-dir="${escapeAttribute(record.dirPath)}" data-skill-agents="${activeAgents}">
        <div class="project-aura"></div>
        <div class="project-border steward-item-accent"></div>
        <button class="skill-toggle${record.enabled ? '' : ' off'}" title="${record.enabled ? 'Disable' : 'Enable'} skill" data-skill-toggle="${escapeAttribute(record.dirPath)}"></button>
        <div class="fitty-container project-title-row">
            <span class="project-kind-icon">${terminalLine}</span>
            <h2 class="project-header">${name}</h2>
        </div>
        <p class="project-description" title="${description}">${description}</p>
        ${parkedNote}
        <div class="skill-chip-row">${chips}<span class="skill-expand-hint" title="Show details">${collapseIcon}</span></div>
        ${getSkillDetail(record, groups)}
    </div>
</div>`;
}

const SOURCE_ORDER: SkillSourceDir[] = ['kimi', 'claude', 'codex', 'agents'];
const SOURCE_LABELS: Record<SkillSourceDir, string> = {
    kimi: 'Kimi',
    claude: 'Claude',
    codex: 'Codex',
    agents: 'Agents',
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

function renderSourceGroup(group: SkillSourceGroup, groups: SkillGroupMap): string {
    const rootDir = escapeAttribute(group.rootDir);
    return `<div class="skill-source-group" data-skill-source="${group.source}">
    <div class="skill-source-header">
        <span class="skill-source-label">${SOURCE_LABELS[group.source]}</span>
        <span class="skill-source-path" title="${rootDir}">${rootDir}</span>
        <span class="skill-source-count">${group.items.length}</span>
    </div>
    ${group.items.map(item => getSkillDiv(item, groups)).join('\n')}
</div>`;
}

function renderCollection(name: string, scope: string, items: SkillRecord[], groups: SkillGroupMap): string {
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
        ${items.map(item => getSkillDiv(item, groups)).join('\n')}
    </div>
</div>`;
}

function renderScopeSection(title: string, scope: string, items: SkillRecord[], groups: SkillGroupMap): string {
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
        .map(name => renderCollection(name, scope, grouped.get(name) as SkillRecord[], groups));
    const sourceGroups = groupBySource(ungrouped).map(group => renderSourceGroup(group, groups));
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
    return `<div class="skills-filter-row" data-skill-filter-row role="group" aria-label="Filter skills by agent">${buttons}</div>`;
}

export function getSkillsPanelContent(records: SkillRecord[], groups: SkillGroupMap = {}): string {
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
    return `<div class="sticky-groups-wrapper skills-groups-wrapper">${renderFilterRow()}${datalist}${sections
        .filter(([, , items]) => items.length)
        .map(([title, scope, items]) => renderScopeSection(title, scope, items, groups)).join('\n')}
</div>`;
}
