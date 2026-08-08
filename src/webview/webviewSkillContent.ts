'use strict';

import * as path from 'path';

import type { SkillAgentId, SkillRecord, SkillScope, SkillSourceDir, SkillVisibility } from '../skills/types';
import { FIXABLE_DIAGNOSTIC_CODES } from '../skills/fixService';
import { getSkillStableKey } from '../skills/skillGroupStore';
import {
    computeSkillDuplicates,
    SkillCopyTarget,
    SkillDuplicateGroup,
} from '../skills/syncService';

export interface SkillPanelView {
    /** falsy when no workspace is open. */
    hasWorkspace?: boolean;
    copyTargets?: Map<string, SkillCopyTarget[]>;
    duplicates?: Map<string, SkillDuplicateGroup>;
    /** dirPaths of central records with a name+agent link collision (controller computes). */
    conflicts?: Set<string>;
    /** Known-collection "create folder" suggestions (controller computes). */
    suggestions?: SkillCollectionSuggestion[];
    /** Central store roots per scope (controller computes); used by the section "+" actions. */
    storeRoots?: { user: string; project?: string };
    /** Folder paths present in each store, including empty ones (controller computes). */
    storeFolders?: Partial<Record<SkillScope, string[]>>;
}
import { sanitizeProjectName } from '../models';
import { escapeAttribute } from './webviewHtmlEscape';
import { collapse as collapseIcon, edit as editIcon, folder as folderIcon, puzzle } from './webviewIcons';
import type { SkillCollectionSuggestion } from '../skills/knownCollections';

const AGENTS: SkillAgentId[] = ['kimi', 'claude', 'codex'];

// Quiet per-agent status dots on cards and folder/section headers: teal =
// active/linked, amber = shadowed, hollow = off, teal ring = partially linked.
function agentDot(state: 'active' | 'shadowed' | 'off' | 'on' | 'indeterminate', title: string): string {
    return `<span class="skill-agent-dot ${state}" title="${escapeAttribute(title)}"></span>`;
}

function cardAgentDots(record: SkillRecord): string {
    const dots = AGENTS.map(agent => {
        const visibility = record.visibility[agent];
        const title = visibility === 'active'
            ? `${agent}: active`
            : visibility === 'shadowed'
                ? `${agent}: shadowed by ${record.shadowedBy[agent] || 'another copy'}`
                : `${agent}: off`;
        return agentDot(visibility === 'active' ? 'active' : visibility === 'shadowed' ? 'shadowed' : 'off', title);
    }).join('');
    return `<span class="skill-agent-dots">${dots}</span>`;
}

interface SkillWarnInfo {
    glyphTitle: string;
}

// One quiet warning glyph on the row; the detail panel lists the specifics.
function getSkillWarnInfo(record: SkillRecord, view: SkillPanelView, duplicate?: SkillDuplicateGroup): SkillWarnInfo | null {
    const conflict = Boolean(view.conflicts && view.conflicts.has(record.dirPath));
    if (conflict) {
        return { glyphTitle: 'Name conflict: another central skill links the same agent slot' };
    }
    if (duplicate && duplicate.drift) {
        return { glyphTitle: 'Copies of this skill have drifted' };
    }
    if (AGENTS.some(agent => record.visibility[agent] === 'shadowed')) {
        return { glyphTitle: 'Shadowed by another copy for at least one agent' };
    }
    if (record.diagnostics.length) {
        return { glyphTitle: `${record.diagnostics.length} issue${record.diagnostics.length === 1 ? '' : 's'}` };
    }
    return null;
}

function getSkillDetail(record: SkillRecord, view: SkillPanelView, duplicate?: SkillDuplicateGroup): string {
    const rows = AGENTS.map(agent => {
        if (record.central) {
            // Centralized skills: each agent row is an iOS-style link switch at the
            // record's own scope (global store → user roots, project store → project roots).
            const current = (record.central.links[record.scope] || {})[agent] || '';
            const off = current ? '' : ' off';
            const title = current ? `Disable for ${agent} (${current})` : `Enable for ${agent}`;
            const note = current
                ? escapeAttribute(current)
                : 'not linked';
            return `<div class="skill-agent-row"><span class="skill-agent-row-name">${agent}</span>`
                + `<button type="button" class="skill-ios-toggle${off}" title="${escapeAttribute(title)}"`
                + ` data-central-toggle="${escapeAttribute(record.dirPath)}" data-central-source="${agent}"></button>`
                + `<span class="skill-agent-note" title="${note}">${note}</span></div>`;
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
        return `<div class="skill-agent-row readonly"><span class="skill-agent-row-name">${agent}</span>${status}<span class="skill-agent-note" title="${escapeAttribute(detail)}">${escapeAttribute(detail)}</span></div>`;
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
    const moveEditor = record.central
        ? `<div class="skill-move-editor" hidden>
        <input class="skill-move-input" type="text" data-skill-move-folder="${dirPath}" placeholder="Move to folder…">
        <button type="button" class="skill-move-set" data-skill-move-set="${dirPath}">Move</button>
    </div>`
        : '';
    const fullDescription = record.description
        ? `<p class="skill-detail-desc">${escapeAttribute(sanitizeProjectName(record.description))}</p>`
        : '';
    const copyTargets = view.copyTargets ? view.copyTargets.get(getSkillStableKey(record)) : undefined;
    const copyRow = copyTargets && copyTargets.length
        ? `<div class="skill-copy-row">Copy to: ${copyTargets.map(target => `<button type="button" class="skill-copy" data-skill-copy="${dirPath}" data-skill-copy-root="${escapeAttribute(target.rootDir)}">${target.source}</button>`).join('')}</div>`
        : '';
    const projectLinkCount = record.central
        ? AGENTS.filter(agent => Boolean(record.central?.links.project?.[agent])).length
        : 0;
    const scopeActionButton = !record.central
        ? ''
        : record.scope === 'user'
            ? `<button type="button" class="skill-text-btn skill-scope-action" data-skill-scope-action="${dirPath}"`
                + ` data-skill-scope-operation="apply-to-project"`
                + (view.hasWorkspace
                    ? ` title="Choose which project agents can use this global skill">${projectLinkCount ? `In project · ${projectLinkCount}` : 'Use in project'}`
                    : ` title="Open a project to apply this global skill" disabled>Open a project`)
                + `</button>`
            : `<button type="button" class="skill-text-btn skill-scope-action" data-skill-scope-action="${dirPath}"`
                + ` data-skill-scope-operation="move-to-global" title="Move this project's source into Global management">Move to Global</button>`;
    const moveEditButton = record.central
        ? `<button type="button" class="skill-text-btn" data-skill-move-edit="${dirPath}">Move to folder…</button>`
        : '';
    return `<div class="skill-detail" hidden>
        ${fullDescription}
        ${notes}
        <p class="skill-detail-title">Agents</p>
        ${rows}${driftRows}${copyRow}
        <div class="skill-detail-actions">
            <button type="button" class="skill-text-btn primary" data-skill-open="${escapeAttribute(record.skillFilePath)}">Open SKILL.md</button>
            ${moveEditButton}
            ${scopeActionButton}
        </div>
        ${moveEditor}
    </div>`;
}

function getSkillDiv(record: SkillRecord, view: SkillPanelView): string {
    const duplicate = view.duplicates ? view.duplicates.get(`${record.scope}:${record.name}`) : undefined;
    const name = escapeAttribute(sanitizeProjectName(record.name));
    const description = escapeAttribute(sanitizeProjectName(record.description));
    // Dots read the record's own-scope effectiveness (its section determines scope).
    const activeAgents = AGENTS.filter(agent => record.visibility[agent] === 'active').join(' ');
    const warn = getSkillWarnInfo(record, view, duplicate);
    const warnGlyph = warn
        ? `<span class="skill-warn" data-skill-warn title="${escapeAttribute(warn.glyphTitle)}">⚠</span>`
        : '';
    const dirPath = escapeAttribute(record.dirPath);
    const centralizeAction = record.central
        ? ''
        : `<button type="button" class="skill-hover-centralize" title="Move into the shared store and link from agents" data-skill-centralize="${dirPath}">Centralize</button>`;
    return `
<div class="skill-row-holder" draggable="true" data-skill-scope="${record.scope}">
    <div class="skill-row${record.central ? '' : ' unmanaged'}" data-skill-dir="${dirPath}" data-skill-agents="${activeAgents}">
        <span class="skill-ibox" aria-hidden="true">${puzzle}</span>
        <span class="skill-meta">
            <span class="skill-name">${name}${warnGlyph}</span>
            <span class="skill-desc" title="${description}">${description}</span>
        </span>
        <span class="skill-rest">${cardAgentDots(record)}</span>
        <span class="skill-acts">
            ${centralizeAction}
            <button type="button" class="skill-icon-btn" title="Open SKILL.md" data-skill-open="${escapeAttribute(record.skillFilePath)}">${editIcon}</button>
            <button type="button" class="skill-icon-btn" title="More actions" data-skill-menu="${dirPath}">⋯</button>
        </span>
    </div>
    ${getSkillDetail(record, view, duplicate)}
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
    return path.dirname(record.dirPath);
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
        <span class="skill-source-sep">·</span>
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

function buildFolderTree(records: SkillRecord[], folderPaths: string[] = []): SkillFolderNode {
    const root: SkillFolderNode = { path: '', name: '', children: new Map(), items: [] };
    const ensureNode = (folderPath: string): void => {
        const segments = folderPath.split('/');
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
    };
    // Folders exist on disk even when empty — they must render (e.g. after the
    // panel "+" creates one), so seed the tree before placing records.
    for (const folderPath of folderPaths) {
        if (folderPath) {
            ensureNode(folderPath);
        }
    }
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

/** Per-agent link state of a folder subtree at the section scope. */
function folderAgentState(node: SkillFolderNode, scope: SkillScope, agent: SkillAgentId): SkillFolderLinkState {
    const members = collectFolderMembers(node);
    if (!members.length) {
        return 'off';
    }
    let anyLink = false;
    let allLinked = true;
    for (const record of members) {
        const links = (record.central && record.central.links[scope]) || {};
        if (links[agent]) {
            anyLink = true;
        } else {
            allLinked = false;
        }
    }
    if (allLinked) {
        return 'on';
    }
    return anyLink ? 'indeterminate' : 'off';
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

const SKILL_FOLDER_HEADER_PX = 24;

function renderFolderNode(
    node: SkillFolderNode,
    storeRoot: string,
    sectionScope: SkillScope,
    view: SkillPanelView,
    depth = 0,
): string {
    // Scope is positional: global-section folders act on user-level agent roots,
    // project-section folders on the current project's agent roots.
    const count = collectFolderMembers(node).length;
    const children = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
    const items = node.items.slice().sort((a, b) => a.name.localeCompare(b.name));
    const pathAttr = escapeAttribute(node.path);
    const agentStates = AGENTS.map(agent => ({ agent, state: folderAgentState(node, sectionScope, agent) }));
    const stateAttrs = agentStates.map(({ agent, state }) => ` data-state-${agent}="${state}"`).join('');
    const dots = `<span class="skill-agent-dots">${agentStates.map(({ agent, state }) =>
        agentDot(state, `${agent}: ${state === 'on' ? 'all linked' : state === 'indeterminate' ? 'some linked' : 'off'}`)).join('')}</span>`;
    // Fixed 24px header rhythm lets nested sticky headers stack with an exact
    // per-depth offset (top: depth × 24px) inside the scrolling section list.
    return `<div class="group steward-section skill-folder" data-group-id="skill-folder-${sectionScope}-${encodeURIComponent(node.path)}" data-skill-folder="${pathAttr}" data-skill-store="${escapeAttribute(storeRoot)}" data-skill-folder-scope="${sectionScope}">
    <div class="group-title skill-folder-header" style="top: ${depth * SKILL_FOLDER_HEADER_PX}px">
        <span class="group-title-text skill-folder-title" data-action="collapse">
            <span class="collapse-icon" title="Open/Collapse Group">${collapseIcon}</span><span class="skill-folder-icon" aria-hidden="true">${folderIcon}</span><span class="skill-folder-name">${escapeAttribute(node.name)}</span>
        </span>
        ${dots}
        <span class="group-title-badge">${count}</span>
        <button type="button" class="skill-folder-more" title="Folder actions" data-folder-menu="${pathAttr}" data-folder-scope="${sectionScope}"${stateAttrs}>⋯</button>
    </div>
    <div class="group-list skill-folder-list">
        ${children.map(child => renderFolderNode(child, storeRoot, sectionScope, view, depth + 1)).join('\n')}
        ${items.map(item => getSkillDiv(item, view)).join('\n')}
    </div>
</div>`;
}

function renderScopeSection(scope: SkillScope, items: SkillRecord[], view: SkillPanelView): string {
    const central = items.filter(record => record.central);
    // Section-level batch state per agent: every central record in the section.
    const sectionAgentState = (agent: SkillAgentId): SkillFolderLinkState => {
        if (!central.length) {
            return 'off';
        }
        let anyLink = false;
        let allLinked = true;
        for (const record of central) {
            const links = (record.central && record.central.links[scope]) || {};
            if (links[agent]) {
                anyLink = true;
            } else {
                allLinked = false;
            }
        }
        if (allLinked) {
            return 'on';
        }
        return anyLink ? 'indeterminate' : 'off';
    };
    const sectionAgentStates = AGENTS.map(agent => ({ agent, state: sectionAgentState(agent) }));
    const sectionStateAttrs = sectionAgentStates.map(({ agent, state }) => ` data-state-${agent}="${state}"`).join('');
    const sectionDots = `<span class="skill-agent-dots">${sectionAgentStates.map(({ agent, state }) =>
        agentDot(state, `${agent}: ${state === 'on' ? 'all linked' : state === 'indeterminate' ? 'some linked' : 'off'}`)).join('')}</span>`;
    const unmanaged = items.filter(record => !record.central);
    const tree = buildFolderTree(central, (view.storeFolders && view.storeFolders[scope]) || []);
    const viewStoreRoot = scope === 'user' ? view.storeRoots?.user : view.storeRoots?.project;
    const storeRoot = viewStoreRoot || (central.length ? getCentralStoreRoot(central[0]) : '');
    const folders = [...tree.children.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(node => renderFolderNode(node, storeRoot, scope, view));
    const rootItems = tree.items.slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(record => getSkillDiv(record, view));
    const unmanagedSection = unmanaged.length
        ? `<div class="skill-unmanaged">
        <div class="skill-unmanaged-header">Not in the shared store</div>
        ${groupBySource(unmanaged).map(group => renderSourceGroup(group, view)).join('\n')}
    </div>`
        : '';
    return `
<div class="group steward-section skill-scope-section" data-group-id="${scope}-skills"${storeRoot ? ` data-skill-store="${escapeAttribute(storeRoot)}"` : ''}>
    <div class="group-title skill-scope-header">
        <span class="group-title-text skill-scope-title" data-action="collapse">${scope === 'user' ? 'global' : 'project'}</span>
        ${sectionDots}
        <span class="group-title-badge">${items.length}</span>
        ${storeRoot ? `<button type="button" class="skill-folder-more skill-scope-more" title="Section actions" data-section-menu="${scope}" data-folder-scope="${scope}"${sectionStateAttrs}>⋯</button>` : ''}
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
    return `<div class="skills-filter-row" data-skill-filter-row role="group" aria-label="Filter skills by agent">${buttons}</div>`;
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
        const hasFolders = Boolean(view.storeFolders
            && ((view.storeFolders.user || []).length || (view.storeFolders.project || []).length));
        if (!hasFolders) {
            return '<div class="sticky-groups-wrapper skills-groups-wrapper"><div class="skills-empty">No skills found in agent skill directories.</div></div>';
        }
        // Empty store with folders on disk (e.g. just created via "+"): fall through
        // and render the tree of empty folder nodes.
    }
    const suggestions = (view.suggestions || []).map(renderSuggestion).join('');
    const visibleSections = sections
        .filter(([scope, items]) => items.length || ((view.storeFolders && view.storeFolders[scope as SkillScope]) || []).length);
    // Each scope section lives in its own pane so Global and Project scroll
    // independently; a resizer between panes adjusts the project pane's share.
    // The split script (webviewSkillPanelScripts.js) sizes the panes to the
    // viewport; without it the panes flow like plain content (no fixed height).
    const panes = visibleSections.map(([scope, items], index) => {
        const resizer = index === 0
            ? ''
            : '<div class="skills-pane-resizer" data-skills-pane-resizer role="separator" tabindex="0"'
                + ' aria-orientation="horizontal" aria-valuemin="0" aria-valuemax="100"'
                + ' aria-label="Resize the project pane"'
                + ' title="Drag to resize the project pane"></div>';
        return `${resizer}<div class="skills-pane" data-skills-pane="${scope}">
${renderScopeSection(scope, items, view)}
</div>`;
    }).join('\n');
    return `<div class="sticky-groups-wrapper skills-groups-wrapper"><div class="skill-scope-status" data-skill-scope-status role="status" aria-live="polite"></div>${renderFilterRow(view)}${suggestions}<div class="skills-split" data-skills-split>${panes}
</div></div>`;
}
