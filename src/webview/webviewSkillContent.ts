'use strict';

import type { SkillAgentId, SkillRecord, SkillVisibility } from '../skills/types';
import { sanitizeProjectName } from '../models';
import { escapeAttribute } from './webviewContent';
import { terminalLine } from './webviewIcons';

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

function getSkillDetail(record: SkillRecord): string {
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
    return `<div class="skill-detail" hidden>
        <p class="skill-detail-title">Effectiveness per agent</p>
        ${rows}${notes}
        <div class="skill-detail-actions">
            <button class="primary" data-skill-open="${escapeAttribute(record.skillFilePath)}">Open SKILL.md</button>
        </div>
    </div>`;
}

function getSkillDiv(record: SkillRecord): string {
    const name = escapeAttribute(sanitizeProjectName(record.name));
    const description = escapeAttribute(sanitizeProjectName(record.description));
    const scopeLabel = record.scope === 'user' ? 'User' : 'Project';
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
<div class="project-container">
    <div class="project steward-item-card skill-card${record.enabled ? '' : ' skill-card-disabled'}" data-skill-dir="${escapeAttribute(record.dirPath)}">
        <div class="project-aura"></div>
        <div class="project-border steward-item-accent"></div>
        <button class="skill-toggle${record.enabled ? '' : ' off'}" title="${record.enabled ? 'Disable' : 'Enable'} skill" data-skill-toggle="${escapeAttribute(record.dirPath)}"></button>
        <div class="fitty-container project-title-row">
            <span class="project-kind-icon">${terminalLine}</span>
            <h2 class="project-header">${name}</h2>
        </div>
        <p class="project-description" title="${description}">${description}</p>
        ${parkedNote}
        <div class="skill-chip-row">${chips}</div>
        ${getSkillDetail(record)}
    </div>
</div>`;
}

export function getSkillsPanelContent(records: SkillRecord[]): string {
    const user = (records || []).filter(record => record.scope === 'user');
    const project = (records || []).filter(record => record.scope === 'project');
    const sections = [
        ['USER SKILLS', user],
        ['PROJECT SKILLS', project],
    ] as const;
    return `<div class="sticky-groups-wrapper skills-groups-wrapper">${sections
        .filter(([, items]) => items.length)
        .map(([title, items]) => `
<div class="group steward-section" data-group-id="${title.toLowerCase().replace(/\s+/g, '-')}">
    <div class="group-title steward-section-header steward-group-header">
        <span class="group-title-text">${title}</span>
        <span class="group-title-badge">${items.length}</span>
    </div>
    <div class="group-list">
        <div class="drop-signal"></div>
        ${items.map(getSkillDiv).join('\n')}
    </div>
</div>`).join('\n') || '<div class="skills-empty">No skills found in agent skill directories.</div>'}
</div>`;
}
