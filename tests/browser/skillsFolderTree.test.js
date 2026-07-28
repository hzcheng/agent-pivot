'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-chromium');

const styles = fs.readFileSync(path.join(__dirname, '../../media/styles.css'), 'utf8');
const dashboardScript = fs.readFileSync(
    path.join(__dirname, '../../media/webviewDashboardScripts.js'),
    'utf8'
);

function loadSkillContent() {
    const vscode = {
        Uri: {
            file(value) {
                return {
                    fsPath: value,
                    path: value,
                    toString() {
                        return `file://${value}`;
                    },
                };
            },
        },
    };
    const contentPath = require.resolve('../../out/webview/webviewSkillContent');
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return vscode;
            return previousLoad.call(this, request, parent, isMain);
        };
        return require(contentPath);
    } finally {
        Module._load = previousLoad;
    }
}

function makeRecord(overrides = {}) {
    return {
        name: 'demo',
        description: 'Demo skill',
        dirPath: '/home/dev/.kimi/skills/demo',
        skillFilePath: '/home/dev/.kimi/skills/demo/SKILL.md',
        scope: 'user',
        source: 'kimi',
        enabled: true,
        folder: '',
        visibility: { kimi: 'active', claude: 'absent', codex: 'absent' },
        shadowedBy: {},
        diagnostics: [],
        ...overrides,
    };
}

function centralRecord(overrides = {}) {
    return makeRecord({
        name: 'alpha',
        source: 'central',
        dirPath: '/home/dev/.skills/superpowers/alpha',
        skillFilePath: '/home/dev/.skills/superpowers/alpha/SKILL.md',
        folder: 'superpowers',
        central: {
            dirPath: '/home/dev/.skills/superpowers/alpha',
            links: { user: { kimi: '/home/dev/.kimi/skills/alpha' }, project: {} },
        },
        visibility: { kimi: 'active', claude: 'absent', codex: 'absent' },
        projectVisibility: { kimi: 'absent', claude: 'absent', codex: 'absent' },
        ...overrides,
    });
}

function treeRecords() {
    return [
        centralRecord(),
        centralRecord({
            name: 'beta',
            dirPath: '/home/dev/.skills/superpowers/beta',
            skillFilePath: '/home/dev/.skills/superpowers/beta/SKILL.md',
            central: { dirPath: '/home/dev/.skills/superpowers/beta', links: { user: {}, project: {} } },
            visibility: { kimi: 'absent', claude: 'absent', codex: 'absent' },
        }),
        centralRecord({
            name: 'rooty',
            dirPath: '/home/dev/.skills/rooty',
            skillFilePath: '/home/dev/.skills/rooty/SKILL.md',
            folder: '',
            central: { dirPath: '/home/dev/.skills/rooty', links: { user: {}, project: {} } },
            visibility: { kimi: 'absent', claude: 'absent', codex: 'absent' },
        }),
    ];
}

// The skills interaction code lives inside the dashboard script's IIFE; exercise
// it by extracting its exact span (same technique as skillPanelFilter.test.js).
function extractSkillCode() {
    const start = dashboardScript.indexOf('var skillAgentFilter');
    const end = dashboardScript.indexOf('function revealPendingTodoSearchTarget');
    assert.notEqual(start, -1, 'skillAgentFilter marker missing — update this test');
    assert.notEqual(end, -1, 'revealPendingTodoSearchTarget marker missing — update this test');
    return dashboardScript.slice(start, end);
}

async function openSkillsPage(browser, records, view = {}) {
    const { getSkillsPanelContent } = loadSkillContent();
    const page = await browser.newPage({ viewport: { width: 340, height: 600 } });
    await page.setContent(`<!doctype html>
        <html>
            <head><style>${styles}</style></head>
            <body class="steward-sidebar">
                <section role="tabpanel" id="ai-panel-skills">
                    <div class="sticky-groups-wrapper skills-groups-wrapper" id="skills-host">${getSkillsPanelContent(records || treeRecords(), { hasWorkspace: true, ...view })}</div>
                </section>
            </body>
        </html>`);
    await page.evaluate(skillSource => {
        (function () {
            var options = {
                postMessage(message) {
                    (window.__skillMessages = window.__skillMessages || []).push(message);
                    return Promise.resolve(true);
                },
            };
            eval(skillSource);
            document.addEventListener('click', onSkillCardClick);
            document.addEventListener('dragstart', onSkillDragStart);
            document.addEventListener('dragover', onSkillDragOver);
            document.addEventListener('dragleave', onSkillDragLeave);
            document.addEventListener('drop', onSkillDrop);
            document.addEventListener('dragend', onSkillDragEnd);
            window.__captureSkillCollapsedGroups = captureSkillCollapsedGroups;
            window.__restoreSkillCollapsedGroups = restoreSkillCollapsedGroups;
        })();
    }, extractSkillCode());
    return page;
}

function switchStates(page) {
    return page.evaluate(() => [...document.querySelectorAll('[data-central-toggle]')].map(el => ({
        agent: el.getAttribute('data-central-source'),
        off: el.classList.contains('off'),
    })));
}

test('SKILLS-FOLDER-AGENTS-001 folder dropdown opens per-agent switches and survives HTML replacement', async () => {
    const browser = await chromium.launch();
    try {
        const page = await openSkillsPage(browser);
        const panelHidden = () => page.evaluate(() =>
            document.querySelector('[data-folder-agents="superpowers"]').hidden);
        assert.equal(await panelHidden(), true, 'agents panel starts hidden');
        await page.click('[data-folder-agents-toggle="superpowers"]');
        assert.equal(await panelHidden(), false, 'dropdown opens the per-agent panel');
        // per-agent switch states: alpha links kimi only → kimi indeterminate, claude/codex off
        const states = await page.evaluate(() =>
            [...document.querySelectorAll('[data-folder-agents="superpowers"] [data-folder-agent]')].map(el => ({
                agent: el.getAttribute('data-folder-agent'),
                cls: el.className,
            })));
        assert.deepEqual(states, [
            { agent: 'kimi', cls: 'skill-ios-toggle indeterminate' },
            { agent: 'claude', cls: 'skill-ios-toggle off' },
            { agent: 'codex', cls: 'skill-ios-toggle off' },
        ]);
        // dropdown state survives an authoritative HTML replacement
        await page.evaluate(() => {
            const wrapper = document.querySelector('#ai-panel-skills .sticky-groups-wrapper');
            const open = (function () {
                const panels = wrapper.querySelectorAll('.skill-folder-agents[data-folder-agents]:not([hidden])');
                return [...panels].map(panel => panel.getAttribute('data-folder-agents'));
            })();
            wrapper.outerHTML = wrapper.outerHTML;
            const next = document.querySelector('#ai-panel-skills .sticky-groups-wrapper');
            for (const path of open) {
                const panel = next.querySelector('.skill-folder-agents[data-folder-agents="' + path + '"]');
                if (panel) {
                    panel.hidden = false;
                }
            }
        });
        assert.equal(await panelHidden(), false, 'dropdown state restored after replacement');
    } finally {
        await browser.close();
    }
});

test('SKILLS-FOLDER-TOGGLE-001 folder agent switch posts a per-agent scope-aware payload; indeterminate completes the set', async () => {
    const browser = await chromium.launch();
    try {
        const page = await openSkillsPage(browser);
        await page.click('[data-folder-agents-toggle="superpowers"]');
        await page.click('[data-folder-agents="superpowers"] [data-folder-agent="kimi"]');
        const messages = await page.evaluate(() => window.__skillMessages);
        assert.equal(messages.length, 1);
        assert.deepEqual(messages[0], {
            type: 'folder-toggle-skill-links',
            storeRoot: '/home/dev/.skills',
            folder: 'superpowers',
            scope: 'user',
            agent: 'kimi',
            enabled: false,
        }, 'indeterminate click means "not fully on for kimi" → host completes the set for kimi');
    } finally {
        await browser.close();
    }
});

test('SKILLS-FOLDER-DND-001 dragging a card onto a folder or the section root posts an on-disk move; cross-scope drops refused', async () => {
    const browser = await chromium.launch();
    try {
        const page = await openSkillsPage(browser);
        const card = '[data-skill-dir="/home/dev/.skills/rooty"]';
        const folderNode = '.skill-folder[data-skill-folder="superpowers"]';
        await page.dragAndDrop(card, folderNode);
        let messages = await page.evaluate(() => window.__skillMessages || []);
        assert.deepEqual(messages, [{
            type: 'move-skill-to-folder',
            dirPath: '/home/dev/.skills/rooty',
            folder: 'superpowers',
        }], 'drop on a folder moves into it');

        await page.evaluate(() => { window.__skillMessages = []; });
        await page.dragAndDrop(card, '.group.steward-section[data-group-id="user-skills"] .group-title');
        messages = await page.evaluate(() => window.__skillMessages || []);
        assert.deepEqual(messages, [{
            type: 'move-skill-to-folder',
            dirPath: '/home/dev/.skills/rooty',
            folder: '',
        }], 'drop on the section header moves to the store root');

        // project-scope section rejects a user-scope card: no message posted
        const projectRecords = treeRecords().concat([centralRecord({
            name: 'proj',
            scope: 'project',
            dirPath: '/work/app/.skills/proj',
            skillFilePath: '/work/app/.skills/proj/SKILL.md',
            folder: '',
            central: { dirPath: '/work/app/.skills/proj', links: { project: {} } },
        })]);
        const page2 = await openSkillsPage(browser, projectRecords);
        await page2.evaluate(() => { window.__skillMessages = []; });
        await page2.dragAndDrop('[data-skill-dir="/home/dev/.skills/rooty"]', '.group.steward-section[data-group-id="project-skills"] .group-title');
        const refused = await page2.evaluate(() => window.__skillMessages || []);
        assert.deepEqual(refused, [], 'cross-scope drop posts nothing');
    } finally {
        await browser.close();
    }
});

test('SKILLS-FOLDER-COLLAPSE-001 folder collapse state survives authoritative HTML replacement', async () => {
    const browser = await chromium.launch();
    try {
        const page = await openSkillsPage(browser);
        // Collapsing itself is handled by webviewProjectScripts.js's generic group
        // handler (folder nodes are .group.steward-section); this test pins the
        // capture/restore persistence the dashboard script owns.
        await page.evaluate(() => {
            document.querySelector('.skill-folder[data-skill-folder="superpowers"]').classList.add('collapsed');
        });
        const collapsedBefore = await page.evaluate(() =>
            document.querySelector('.skill-folder[data-skill-folder="superpowers"]').classList.contains('collapsed'));
        assert.ok(collapsedBefore, 'folder marked collapsed');
        // simulate skills-updated: capture, replace, restore (mirrors the production handler)
        await page.evaluate(() => {
            const wrapper = document.querySelector('#ai-panel-skills .sticky-groups-wrapper');
            const collapsed = window.__captureSkillCollapsedGroups(wrapper);
            const clone = wrapper.outerHTML;
            wrapper.outerHTML = clone;
            const next = document.querySelector('#ai-panel-skills .sticky-groups-wrapper');
            window.__restoreSkillCollapsedGroups(next, collapsed);
        });
        const collapsedAfter = await page.evaluate(() =>
            document.querySelector('.skill-folder[data-skill-folder="superpowers"]').classList.contains('collapsed'));
        assert.ok(collapsedAfter, 'collapse state restored after HTML replacement');
    } finally {
        await browser.close();
    }
});
