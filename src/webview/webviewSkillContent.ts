'use strict';

import * as path from 'path';

import type { SkillAgentId, SkillRecord, SkillScope, SkillSourceDir, SkillVisibility } from '../skills/types';
import { DISABLED_DIR_NAME } from '../skills/roots';
import { FIXABLE_DIAGNOSTIC_CODES } from '../skills/fixService';
import { getSkillStableKey } from '../skills/skillGroupStore';
import {
    computeSkillDuplicates,
    SkillCopyTarget,
    SkillDuplicateGroup,
} from '../skills/syncService';

export interface SkillPanelView {
    /** Selected link scope for central switches + chips; default 'user'. */
    scope?: SkillScope;
    /** falsy when no workspace is open: the scope selector hides entirely. */
    hasWorkspace?: boolean;
    copyTargets?: Map<string, SkillCopyTarget[]>;
    duplicates?: Map<string, SkillDuplicateGroup>;
    /** dirPaths of central records with a name+agent link collision (controller computes). */
    conflicts?: Set<string>;
    /** Known-collection "create folder" suggestions (controller computes). */
    suggestions?: SkillCollectionSuggestion[];
    /** Central store roots per scope (controller computes); used by the section "+" actions. */
    storeRoots?: { user: string; project?: string };
}
import { sanitizeProjectName } from '../models';
import { escapeAttribute } from './webviewContent';
import { collapse as collapseIcon, folder as folderIcon, terminalLine } from './webviewIcons';
import type { SkillCollectionSuggestion } from '../skills/knownCollections';

const AGENTS: SkillAgentId[] = ['kimi', 'claude', 'codex'];

function getViewScope(view: SkillPanelView): SkillScope {
    return view.scope === 'project' ? 'project' : 'user';
}

function agentChip(agent: SkillAgentId, visibility: SkillVisibility, record?: SkillRecord): string {
    const scoped = record
        ? ` data-agent="${agent}" data-vis-user="${record.visibility[agent]}" data-vis-project="${(record.projectVisibility || record.visibility)[agent]}"`
        : '';
    if (visibility === 'active') {
        return `<span class="skill-chip agent-${agent}"${scoped}>${agent}</span>`;
    }
    if (visibility === 'shadowed') {
        return `<span class="skill-chip warn"${scoped}>⚠ ${agent}</span>`;
    }
    return `<span class="skill-chip agent-absent"${scoped}>${agent}</span>`;
}

function getSkillDetail(record: SkillRecord, view: SkillPanelView, duplicate?: SkillDuplicateGroup): string {
    const viewScope = getViewScope(view);
    const rows = AGENTS.map(agent => {
        if (record.central) {
            // Centralized skills: each agent row is an iOS-style link switch. The off
            // class + tooltip reflect the selected scope; both scopes' link paths ride
            // along so the webview can swap states client-side on selector changes.
            const linkUser = (record.central.links.user || {})[agent] || '';
            const linkProject = (record.central.links.project || {})[agent] || '';
            const current = viewScope === 'project' ? linkProject : linkUser;
            const off = current ? '' : ' off';
            const title = current ? `Disable for ${agent} (${current})` : `Enable for ${agent}`;
            return `<div class="skill-agent-row"><span class="skill-agent-row-name">${agent}</span>`
                + `<button type="button" class="skill-ios-toggle${off}" title="${escapeAttribute(title)}"`
                + ` data-central-toggle="${escapeAttribute(record.dirPath)}" data-central-source="${agent}"`
                + ` data-link-user="${escapeAttribute(linkUser)}" data-link-project="${escapeAttribute(linkProject)}"></button></div>`;
        }
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
        return `<div class="skill-detail-row">${agentChip(agent, visibility === 'shadowed' ? 'shadowed' : visibility, record)}${status}<span class="skill-detail-path">${detail}</span></div>`;
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
    const dirPath = escapeAttribute(record.dirPath);
    // The move editor replaces the retired virtual group editor for central records.
    const moveEditor = record.central
        ? `<div class="skill-move-editor">
        <input class="skill-move-input" type="text" data-skill-move-folder="${dirPath}" placeholder="Move to folder…">
        <button type="button" class="skill-move-set" data-skill-move-set="${dirPath}">Move</button>
    </div>`
        : '';
    return `<div class="skill-detail" hidden>
        <p class="skill-detail-title">Effectiveness per agent</p>
        ${rows}${driftRows}${notes}
        <div class="skill-detail-actions">
            <button class="primary" data-skill-open="${escapeAttribute(record.skillFilePath)}">Open SKILL.md</button>
        </div>
        ${moveEditor}
    </div>`;
}

function getSkillDiv(record: SkillRecord, view: SkillPanelView): string {
    const duplicate = view.duplicates ? view.duplicates.get(`${record.scope}:${record.name}`) : undefined;
    const name = escapeAttribute(sanitizeProjectName(record.name));
    const description = escapeAttribute(sanitizeProjectName(record.description));
    const scopeLabel = record.scope === 'user' ? 'User' : 'Project';
    // Chips read the selected scope's effectiveness: project falls back to the record's
    // own evaluation when no project-scope effectiveness was computed for it.
    const chipVisibility = getViewScope(view) === 'project'
        ? (record.projectVisibility || record.visibility)
        : record.visibility;
    const activeAgents = AGENTS.filter(agent => chipVisibility[agent] === 'active').join(' ');
    const shadowed = AGENTS.some(agent => chipVisibility[agent] === 'shadowed');
    const drift = duplicate && duplicate.drift;
    const conflict = Boolean(view.conflicts && view.conflicts.has(record.dirPath));
    const warnChip = conflict
        ? `<span class="skill-chip warn" data-skill-warn>⚠ name conflict</span>`
        : drift
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
    const projectLinks = record.central && record.central.links.project
        ? Object.keys(record.central.links.project).length
        : 0;
    const projectBadge = projectLinks
        ? '<span class="skill-chip project-linked" title="Enabled in this project">P</span>'
        : '';
    const chips = `<span class="skill-chip scope-${record.scope}">${scopeLabel}</span>`
        + (record.central ? '<span class="skill-chip central" title="Centralized in the shared store">central</span>' : '')
        + projectBadge
        + AGENTS.map(agent => agentChip(agent, chipVisibility[agent], record)).join('')
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

interface SkillFolderNode {
    path: string;           // '' for the store root pseudo-node
    name: string;
    children: Map<string, SkillFolderNode>;
    items: SkillRecord[];   // records whose folder === node.path
}

function buildFolderTree(records: SkillRecord[]): SkillFolderNode {
    const root: SkillFolderNode = { path: '', name: '', children: new Map(), items: [] };
    for (const record of records.filter(candidate => candidate.central)) {
        const segments = record.folder ? record.folder.split('/') : [];
        let node = root;
        let current = '';
        for (const segment of segments) {
            current = current ? `${current}/${segment}` : segment;
            let child = node.children.get(segment);
            if (!child) {
                child = { path: current, name: segment, children: new Map(), items: [] };
                node.children.set(segment, child);
            }
            node = child;
        }
        node.items.push(record);
    }
    return root;
}

function collectFolderMembers(node: SkillFolderNode, into: SkillRecord[] = []): SkillRecord[] {
    into.push(...node.items);
    node.children.forEach(child => collectFolderMembers(child, into));
    return into;
}

type SkillFolderLinkState = 'on' | 'off' | 'indeterminate';

function folderLinkState(node: SkillFolderNode, scope: SkillScope): SkillFolderLinkState {
    const members = collectFolderMembers(node);
    if (!members.length) {
        return 'off';
    }
    let anyLink = false;
    let allLinked = true;
    for (const record of members) {
        const links = (record.central && record.central.links[scope]) || {};
        const linked = AGENTS.filter(agent => Boolean(links[agent])).length;
        if (linked > 0) {
            anyLink = true;
        }
        if (linked < AGENTS.length) {
            allLinked = false;
        }
    }
    if (allLinked) {
        return 'on';
    }
    // Some member links present (or members only partially linked) → indeterminate;
    // no links anywhere in the subtree → off.
    return anyLink ? 'indeterminate' : 'off';
}

function folderToggleClass(state: SkillFolderLinkState): string {
    return state === 'on' ? '' : ` ${state}`;
}

// Central dirPaths are <storeRoot>/<folder…>/<name> by construction (discovery scans
// the store recursively): strip the skill name and the folder segments to recover the
// store root. All central records in one scope section share the same store root.
function getCentralStoreRoot(record: SkillRecord): string {
    let root = record.dirPath.slice(0, record.dirPath.length - record.name.length - 1);
    if (record.folder) {
        root = root.slice(0, root.length - record.folder.length - 1);
    }
    return root;
}

function renderFolderNode(
    node: SkillFolderNode,
    storeRoot: string,
    sectionScope: SkillScope,
    folderScope: SkillScope,
    view: SkillPanelView,
): string {
    // Batch state is read at the same scope the switch posts (folderScope): the global
    // section follows the selector, the project section is fixed at project scope.
    const state = folderLinkState(node, folderScope);
    const count = collectFolderMembers(node).length;
    const children = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
    const items = node.items.slice().sort((a, b) => a.name.localeCompare(b.name));
    const pathAttr = escapeAttribute(node.path);
    const title = state === 'on'
        ? `Disable every skill under ${node.path} for all agents`
        : `Enable every skill under ${node.path} for all agents`;
    return `<div class="skill-folder group steward-section" data-group-id="skill-folder-${sectionScope}-${encodeURIComponent(node.path)}" data-skill-folder="${pathAttr}" data-skill-store="${escapeAttribute(storeRoot)}" data-skill-folder-scope="${sectionScope}">
    <div class="group-title steward-section-header steward-group-header skill-folder-header">
        <span class="group-title-text" data-action="collapse">
            <span class="collapse-icon" title="Open/Collapse Group">${collapseIcon}</span>
            <span class="skill-collection-icon" aria-hidden="true">${folderIcon}</span>${escapeAttribute(node.name)}
        </span>
        <span class="group-title-badge">${count}</span>
        <button type="button" class="skill-ios-toggle${folderToggleClass(state)}" title="${escapeAttribute(title)}" data-folder-toggle="${pathAttr}" data-folder-scope="${folderScope}"></button>
        <button type="button" class="skill-folder-remove" title="Delete empty folder" data-skill-remove-folder="${pathAttr}">×</button>
    </div>
    <div class="group-list skill-folder-list">
        ${children.map(child => renderFolderNode(child, storeRoot, sectionScope, folderScope, view)).join('\n')}
        ${items.map(item => getSkillDiv(item, view)).join('\n')}
    </div>
</div>`;
}

function renderScopeSection(scope: SkillScope, items: SkillRecord[], view: SkillPanelView): string {
    const central = items.filter(record => record.central);
    const unmanaged = items.filter(record => !record.central);
    const tree = buildFolderTree(central);
    const viewStoreRoot = scope === 'user' ? view.storeRoots?.user : view.storeRoots?.project;
    const storeRoot = viewStoreRoot || (central.length ? getCentralStoreRoot(central[0]) : '');
    const viewScope = getViewScope(view);
    // Folder toggles in the global section act at the selected scope; project-section
    // folders are inherently project scope and ignore the selector.
    const folderScope: SkillScope = scope === 'project' ? 'project' : viewScope;
    const folders = [...tree.children.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(node => renderFolderNode(node, storeRoot, scope, folderScope, view));
    const rootItems = tree.items.slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(record => getSkillDiv(record, view));
    const unmanagedSection = unmanaged.length
        ? `<div class="skill-unmanaged">
        <div class="skill-unmanaged-header">Unmanaged</div>
        ${groupBySource(unmanaged).map(group => renderSourceGroup(group, view)).join('\n')}
    </div>`
        : '';
    return `
<div class="group steward-section" data-group-id="${scope}-skills"${storeRoot ? ` data-skill-store="${escapeAttribute(storeRoot)}"` : ''}>
    <div class="group-title steward-section-header steward-group-header">
        <span class="group-title-text" data-action="collapse">
            <span class="collapse-icon" title="Open/Collapse Group">${collapseIcon}</span>
            <span class="skill-collection-icon" aria-hidden="true">${folderIcon}</span>${scope === 'user' ? 'global' : 'project'}
        </span>
        <span class="group-title-badge">${items.length}</span>
        ${storeRoot ? `<button type="button" class="skill-folder-add" title="New folder" data-skill-new-folder="${scope}">+</button>` : ''}
    </div>
    <div class="group-list">
        <div class="drop-signal"></div>
        ${folders.join('\n')}
        ${rootItems.join('\n')}
        ${unmanagedSection}
    </div>
</div>`;
}

function renderFilterRow(view: SkillPanelView): string {
    const buttons = ['all', ...AGENTS].map(agent => {
        const label = agent === 'all' ? 'All' : SOURCE_LABELS[agent as SkillSourceDir];
        return `<button type="button" class="skills-filter${agent === 'all' ? ' is-active' : ''}" data-skill-filter="${agent}">${label}</button>`;
    }).join('');
    const scope = getViewScope(view);
    // No workspace → no project scope to select: the selector hides entirely.
    const scopeButtons = !view.hasWorkspace
        ? ''
        : `<button type="button" class="skill-scope-select${scope === 'user' ? ' is-active' : ''}" data-skill-scope-select="user">Global</button>`
            + `<button type="button" class="skill-scope-select${scope === 'project' ? ' is-active' : ''}" data-skill-scope-select="project">This project</button>`;
    const migrate = '<button type="button" class="skills-filter skills-migrate-central" data-skill-migrate-central '
        + 'title="Move every user skill from ~/.kimi, ~/.claude and ~/.codex into ~/.skills (duplicates parked, no agent links)">Migrate to central</button>';
    return `<div class="skills-filter-row" data-skill-filter-row role="group" aria-label="Filter skills by agent">${buttons}${scopeButtons}${migrate}</div>`;
}

function renderSuggestion(suggestion: SkillCollectionSuggestion): string {
    const name = escapeAttribute(suggestion.name);
    const count = suggestion.unfiledCount;
    return `<div class="skill-suggestion">
    <span class="skill-suggestion-text">Create the <strong>${name}</strong> folder and move ${count} skill${count === 1 ? '' : 's'} into it</span>
    <button type="button" class="skill-suggestion-apply" data-skill-apply-suggestion="${name}">Create</button>
    <button type="button" class="skill-suggestion-dismiss" title="Dismiss" data-skill-dismiss-suggestion="${name}">×</button>
</div>`;
}

export function getSkillsPanelContent(
    records: SkillRecord[],
    view: SkillPanelView = {},
): string {
    view.duplicates = view.duplicates || computeSkillDuplicates(records || []);
    const user = (records || []).filter(record => record.scope === 'user');
    const project = (records || []).filter(record => record.scope === 'project');
    const sections = [
        ['user', user],
        ['project', project],
    ] as const;
    if (!records || records.length === 0) {
        return '<div class="sticky-groups-wrapper skills-groups-wrapper"><div class="skills-empty">No skills found in agent skill directories.</div></div>';
    }
    const suggestions = (view.suggestions || []).map(renderSuggestion).join('');
    return `<div class="sticky-groups-wrapper skills-groups-wrapper">${renderFilterRow(view)}${suggestions}${sections
        .filter(([, items]) => items.length)
        .map(([scope, items]) => renderScopeSection(scope, items, view)).join('\n')}
</div>`;
}
