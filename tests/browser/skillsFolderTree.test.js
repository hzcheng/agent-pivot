'use strict';

// Covers WEBVIEW-AI-SKILL-PANEL-001 and PERSIST-AI-SKILL-SCOPE-ACTION-001.

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
            window.__captureSkillFolderMenuState = captureSkillFolderMenuState;
            window.__restoreSkillFolderMenuState = restoreSkillFolderMenuState;
            window.__replaceSkillsHtml = replaceSkillsHtml;
        })();
    }, extractSkillCode());
    return page;
}

test('PERSIST-AI-SKILL-SCOPE-ACTION-001 card scope actions use correlated pending state and authoritative replacement', async () => {
    const browser = await chromium.launch();
    try {
        const project = centralRecord({
            name: 'project-only',
            scope: 'project',
            dirPath: '/work/app/.skills/project-only',
            skillFilePath: '/work/app/.skills/project-only/SKILL.md',
            folder: '',
            central: { dirPath: '/work/app/.skills/project-only', links: { project: { claude: '/work/app/.claude/skills/project-only' } } },
            visibility: { kimi: 'absent', claude: 'active', codex: 'absent' },
        });
        const records = [centralRecord(), project];
        const page = await openSkillsPage(browser, records);
        const globalButton = '[data-skill-scope-action="/home/dev/.skills/superpowers/alpha"]';
        const projectButton = '[data-skill-scope-action="/work/app/.skills/project-only"]';
        assert.equal(await page.textContent(globalButton), 'Use in project');
        assert.equal(await page.textContent(projectButton), 'Move to Global');

        await page.click(globalButton);
        const afterClick = await page.evaluate(selector => {
            const button = document.querySelector(selector);
            return {
                messages: window.__skillMessages,
                text: button.textContent,
                disabled: button.disabled,
                ariaDisabled: button.getAttribute('aria-disabled'),
                pending: button.classList.contains('pending'),
            };
        }, globalButton);
        assert.equal(afterClick.messages.length, 1);
        assert.equal(afterClick.messages[0].type, 'skill-scope-action');
        assert.equal(afterClick.messages[0].version, 1);
        assert.equal(afterClick.messages[0].dirPath, '/home/dev/.skills/superpowers/alpha');
        assert.equal(afterClick.messages[0].operation, 'apply-to-project');
        assert.ok(afterClick.messages[0].requestId);
        assert.deepEqual(
            {
                text: afterClick.text,
                disabled: afterClick.disabled,
                ariaDisabled: afterClick.ariaDisabled,
                pending: afterClick.pending,
            },
            { text: 'Applying…', disabled: false, ariaDisabled: 'true', pending: true });

        const { getSkillsPanelContent } = loadSkillContent();
        const linked = centralRecord({
            central: {
                dirPath: '/home/dev/.skills/superpowers/alpha',
                links: {
                    user: { kimi: '/home/dev/.kimi/skills/alpha' },
                    project: {
                        kimi: '/work/app/.kimi/skills/alpha',
                        codex: '/work/app/.codex/skills/alpha',
                    },
                },
            },
        });
        const replacement = getSkillsPanelContent([linked, project], { hasWorkspace: true });
        await page.evaluate(({ html }) => {
            window.__replaceSkillsHtml(html, {
                version: 1,
                requestId: 'stale-request',
                dirPath: '/home/dev/.skills/superpowers/alpha',
                operation: 'apply-to-project',
                ok: true,
            });
        }, { html: replacement });
        assert.equal(await page.textContent(globalButton), 'Applying…',
            'stale settlement cannot clear the matching request');
        await page.evaluate(({ html }) => {
            const request = window.__skillMessages[0];
            window.__replaceSkillsHtml(html, {
                version: 1,
                requestId: request.requestId,
                dirPath: '/wrong/skill',
                operation: request.operation,
                ok: 'true',
            });
        }, { html: replacement });
        const malformed = await page.evaluate(selector => ({
            text: document.querySelector(selector).textContent,
            status: document.querySelector('[data-skill-scope-status]').textContent,
            focused: document.activeElement?.getAttribute('data-skill-scope-action'),
        }), globalButton);
        assert.deepEqual(malformed, {
            text: 'Applying…',
            status: '',
            focused: '/home/dev/.skills/superpowers/alpha',
        }, 'same-id malformed settlement is ignored and pending focus survives replacement');

        await page.evaluate(({ html }) => {
            const request = window.__skillMessages[0];
            window.__replaceSkillsHtml(html, {
                version: 1,
                requestId: request.requestId,
                dirPath: request.dirPath,
                operation: request.operation,
                ok: true,
            });
        }, { html: replacement });
        const settled = await page.evaluate(selector => {
            const button = document.querySelector(selector);
            return {
                text: button.textContent,
                disabled: button.disabled,
                pending: button.classList.contains('pending'),
                status: document.querySelector('[data-skill-scope-status]').textContent,
            };
        }, globalButton);
        assert.deepEqual(settled, {
            text: 'In project · 2',
            disabled: false,
            pending: false,
            status: 'Project skill access updated.',
        },
            'matching settlement clears pending only after authoritative HTML replacement');

        await page.click(projectButton);
        const movedRecord = centralRecord({
            name: 'project-only',
            scope: 'user',
            dirPath: '/home/dev/.skills/project-only',
            skillFilePath: '/home/dev/.skills/project-only/SKILL.md',
            folder: '',
            central: {
                dirPath: '/home/dev/.skills/project-only',
                links: { user: {}, project: { claude: '/work/app/.claude/skills/project-only' } },
            },
            visibility: { kimi: 'absent', claude: 'absent', codex: 'absent' },
        });
        const movedHtml = getSkillsPanelContent([linked, movedRecord], { hasWorkspace: true });
        await page.evaluate(({ html }) => {
            const request = window.__skillMessages[1];
            window.__replaceSkillsHtml(html, {
                version: 1,
                requestId: request.requestId,
                dirPath: request.dirPath,
                operation: request.operation,
                ok: true,
                resultDirPath: '/home/dev/.skills/project-only',
            });
        }, { html: movedHtml });
        const moveFocus = await page.evaluate(() => ({
            dirPath: document.activeElement?.getAttribute('data-skill-scope-action'),
            operation: document.activeElement?.getAttribute('data-skill-scope-operation'),
            status: document.querySelector('[data-skill-scope-status]').textContent,
        }));
        assert.deepEqual(moveFocus, {
            dirPath: '/home/dev/.skills/project-only',
            operation: 'apply-to-project',
            status: 'Skill moved to Global management.',
        }, 'move success focuses the new Global card action');
    } finally {
        await browser.close();
    }
});

function switchStates(page) {
    return page.evaluate(() => [...document.querySelectorAll('[data-central-toggle]')].map(el => ({
        agent: el.getAttribute('data-central-source'),
        off: el.classList.contains('off'),
    })));
}

test('SKILLS-FOLDER-AGENTS-001 the ⋯ menu opens per-agent switches, closes on outside click and on action', async () => {
    const browser = await chromium.launch();
    try {
        const page = await openSkillsPage(browser);
        const menuVisible = () => page.evaluate(() =>
            Boolean(document.querySelector('.skill-folder-menu.visible')));
        assert.equal(await menuVisible(), false, 'no menu initially');
        await page.click('[data-folder-menu="superpowers"]');
        assert.equal(await menuVisible(), true, '⋯ opens the menu');
        // menu rows carry per-agent switches with the right state
        const states = await page.evaluate(() =>
            [...document.querySelectorAll('.skill-folder-menu [data-folder-agent]')].map(el => ({
                agent: el.getAttribute('data-folder-agent'),
                cls: el.className,
            })));
        assert.deepEqual(states, [
            { agent: 'kimi', cls: 'skill-ios-toggle indeterminate' },
            { agent: 'claude', cls: 'skill-ios-toggle off' },
            { agent: 'codex', cls: 'skill-ios-toggle off' },
        ]);
        // delete lives inside the menu
        const removeLabel = await page.evaluate(() =>
            document.querySelector('.skill-folder-menu [data-skill-remove-folder="superpowers"]')?.textContent);
        assert.equal(removeLabel, 'Delete empty folder');
        // clicking a switch keeps the menu open, marks the switch pending, posts the batch toggle
        await page.click('.skill-folder-menu [data-folder-agent="kimi"]');
        assert.equal(await menuVisible(), true, 'menu stays open for multi-agent changes');
        const pending = await page.evaluate(() => {
            const sw = document.querySelector('.skill-folder-menu [data-folder-agent="kimi"]');
            return { pending: sw.classList.contains('skill-toggle-pending'), disabled: sw.disabled };
        });
        assert.deepEqual(pending, { pending: true, disabled: true },
            'clicked switch shows a pending look, never an optimistic committed state');
        const messages = await page.evaluate(() => window.__skillMessages);
        assert.deepEqual(messages, [{
            type: 'folder-toggle-skill-links',
            storeRoot: '/home/dev/.skills',
            folder: 'superpowers',
            scope: 'user',
            agent: 'kimi',
            enabled: false,
        }]);
        // a second agent toggles from the same open menu
        await page.click('.skill-folder-menu [data-folder-agent="claude"]');
        const messages2 = await page.evaluate(() => window.__skillMessages);
        assert.equal(messages2.length, 2, 'second toggle from the same menu');
        assert.equal(messages2[1].agent, 'claude');
        // authoritative skills-updated re-syncs the menu: pending clears, states re-read
        await page.evaluate(() => {
            const wrapper = document.querySelector('#ai-panel-skills .sticky-groups-wrapper');
            const menuState = window.__captureSkillFolderMenuState();
            wrapper.outerHTML = wrapper.outerHTML;
            window.__restoreSkillFolderMenuState(menuState);
        });
        assert.equal(await menuVisible(), true, 'menu survives the authoritative refresh');
        const resynced = await page.evaluate(() => {
            const sw = document.querySelector('.skill-folder-menu [data-folder-agent="kimi"]');
            return { pending: sw.classList.contains('skill-toggle-pending'), disabled: sw.disabled, cls: sw.className };
        });
        assert.deepEqual(resynced, { pending: false, disabled: false, cls: 'skill-ios-toggle indeterminate' },
            'refresh re-syncs the switch from authoritative state');
        // outside click closes without posting
        await page.evaluate(() => { window.__skillMessages = []; });
        await page.click('body', { position: { x: 2, y: 2 } });
        assert.equal(await menuVisible(), false, 'outside click closes the menu');
        const afterOutside = await page.evaluate(() => window.__skillMessages || []);
        assert.deepEqual(afterOutside, [], 'outside click posts nothing');
    } finally {
        await browser.close();
    }
});

test('SKILLS-FOLDER-TOGGLE-001 folder agent switch posts a per-agent scope-aware payload; indeterminate completes the set', async () => {
    const browser = await chromium.launch();
    try {
        const page = await openSkillsPage(browser);
        await page.click('[data-folder-menu="superpowers"]');
        await page.click('.skill-folder-menu [data-folder-agent="kimi"]');
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

test('SKILLS-FILTER-EMPTY-FOLDER-001 empty folders stay visible under the agent filter', async () => {
    const browser = await chromium.launch();
    try {
        const records = treeRecords().concat([centralRecord({
            name: 'proj-empty-parent',
            dirPath: '/home/dev/.skills/solo-x',
            skillFilePath: '/home/dev/.skills/solo-x/SKILL.md',
            folder: '',
            central: { dirPath: '/home/dev/.skills/solo-x', links: { user: {} } },
        })]);
        const { getSkillsPanelContent } = loadSkillContent();
        const page = await browser.newPage({ viewport: { width: 340, height: 600 } });
        await page.setContent(`<!doctype html>
            <html>
                <head><style>${styles}</style></head>
                <body class="steward-sidebar">
                    <section role="tabpanel" id="ai-panel-skills">
                        <div class="sticky-groups-wrapper skills-groups-wrapper">${getSkillsPanelContent(records, {
                            hasWorkspace: true,
                            storeRoots: { user: '/home/dev/.skills' },
                            storeFolders: { user: ['superpowers', 'xiaohongshu', 'xiaohongshu/reddoc'] },
                        })}</div>
                    </section>
                </body>
            </html>`);
        await page.evaluate(skillSource => {
            (function () {
                var options = { postMessage() { return Promise.resolve(true); } };
                eval(skillSource);
                document.addEventListener('click', onSkillCardClick);
                window.__setSkillFilter = function (value) {
                    skillAgentFilter = value;
                    applySkillAgentFilter();
                };
            })();
        }, extractSkillCode());
        const folderVisible = (path) => page.evaluate(p => {
            const el = document.querySelector(`.skill-folder[data-skill-folder="${p}"]`);
            return el && !el.classList.contains('skill-filter-hidden')
                && getComputedStyle(el).display !== 'none';
        }, path);
        // empty folders (xiaohongshu + its empty child) are visible at All
        assert.equal(await folderVisible('xiaohongshu'), true, 'empty folder visible at All');
        assert.equal(await folderVisible('xiaohongshu/reddoc'), true, 'empty nested folder visible at All');
        // and under a real filter
        await page.evaluate('window.__setSkillFilter("kimi")');
        assert.equal(await folderVisible('xiaohongshu'), true, 'empty folder stays visible under a filter');
        assert.equal(await folderVisible('xiaohongshu/reddoc'), true, 'empty nested folder stays visible under a filter');
        assert.equal(await folderVisible('superpowers'), true, 'folder with matching cards stays visible');
        await page.evaluate('window.__setSkillFilter("claude")');
        assert.equal(await folderVisible('superpowers'), false,
            'folder whose cards are all filtered out hides');
        assert.equal(await folderVisible('xiaohongshu'), true, 'empty folder still visible');
    } finally {
        await browser.close();
    }
});

test('SKILLS-FOLDER-MENU-CREATE-001 ⋯ menus offer folder creation at folder and section level', async () => {
    const browser = await chromium.launch();
    try {
        const page = await openSkillsPage(browser);
        // folder ⋯ menu contains New subfolder posting scope + parentFolder
        await page.click('[data-folder-menu="superpowers"]');
        await page.click('.skill-folder-menu [data-skill-menu-new-folder="superpowers"]');
        let messages = await page.evaluate(() => window.__skillMessages);
        assert.deepEqual(messages, [{
            type: 'create-skill-folder',
            scope: 'user',
            parentFolder: 'superpowers',
        }], 'New subfolder posts the parent folder');
        // menu closed on action
        const menuVisible = await page.evaluate(() => Boolean(document.querySelector('.skill-folder-menu.visible')));
        assert.equal(menuVisible, false, 'menu closes on action');
        // section ⋯ menu contains New folder posting an empty parent
        await page.evaluate(() => { window.__skillMessages = []; });
        await page.click('[data-section-menu="user"]');
        const sectionNew = await page.evaluate(() =>
            Boolean(document.querySelector('.skill-folder-menu [data-skill-menu-new-folder=""]')));
        assert.equal(sectionNew, true, 'section menu offers New folder');
        await page.click('.skill-folder-menu [data-skill-menu-new-folder=""]');
        messages = await page.evaluate(() => window.__skillMessages);
        assert.deepEqual(messages, [{
            type: 'create-skill-folder',
            scope: 'user',
            parentFolder: '',
        }], 'section New folder posts an empty parent (store root)');
    } finally {
        await browser.close();
    }
});

test('SKILLS-SECTION-MENU-AGENTS-001 section ⋯ menu offers per-agent batch switches for the whole store', async () => {
    const browser = await chromium.launch();
    try {
        const page = await openSkillsPage(browser);
        await page.click('[data-section-menu="user"]');
        const states = await page.evaluate(() =>
            [...document.querySelectorAll('.skill-folder-menu [data-folder-agent]')].map(el => ({
                agent: el.getAttribute('data-folder-agent'),
                cls: el.className,
                folder: el.getAttribute('data-folder-toggle'),
            })));
        assert.deepEqual(states, [
            { agent: 'kimi', cls: 'skill-ios-toggle indeterminate', folder: '' },
            { agent: 'claude', cls: 'skill-ios-toggle off', folder: '' },
            { agent: 'codex', cls: 'skill-ios-toggle off', folder: '' },
        ], 'section menu shows store-wide per-agent switches (empty folder = store root)');
        await page.click('.skill-folder-menu [data-folder-agent="claude"]');
        const messages = await page.evaluate(() => window.__skillMessages);
        assert.deepEqual(messages, [{
            type: 'folder-toggle-skill-links',
            storeRoot: '/home/dev/.skills',
            folder: '',
            scope: 'user',
            agent: 'claude',
            enabled: false,
        }], 'section switch posts a whole-store batch for that agent');
    } finally {
        await browser.close();
    }
});

test('SKILLS-SECTION-MENU-MIGRATE-001 section ⋯ menu carries a scoped Migrate to central action', async () => {
    const browser = await chromium.launch();
    try {
        const page = await openSkillsPage(browser);
        await page.click('[data-section-menu="user"]');
        const migrateItem = await page.evaluate(() =>
            document.querySelector('.skill-folder-menu [data-skill-menu-migrate="user"]')?.textContent);
        assert.equal(migrateItem, 'Migrate to central…', 'global section menu offers scoped migration');
        await page.click('.skill-folder-menu [data-skill-menu-migrate="user"]');
        const messages = await page.evaluate(() => window.__skillMessages);
        assert.deepEqual(messages, [{ type: 'migrate-skills-to-central', scope: 'user' }]);
        const menuVisible = await page.evaluate(() => Boolean(document.querySelector('.skill-folder-menu.visible')));
        assert.equal(menuVisible, false, 'menu closes on action');
    } finally {
        await browser.close();
    }
});

test('SKILLS-MENU-XSS-001 folder names with quotes cannot inject markup into the ⋯ menu', async () => {
    const browser = await chromium.launch();
    try {
        const evilFolder = 'evil" autofocus onfocus="window.__pwned=1" x="';
        const page = await openSkillsPage(browser, [
            centralRecord({
                name: 'gamma',
                dirPath: `/home/dev/.skills/${evilFolder}/gamma`,
                skillFilePath: `/home/dev/.skills/${evilFolder}/gamma/SKILL.md`,
                folder: evilFolder,
                central: { dirPath: `/home/dev/.skills/${evilFolder}/gamma`, links: { user: {}, project: {} } },
            }),
        ]);
        await page.evaluate(() => {
            const button = [...document.querySelectorAll('[data-folder-menu]')]
                .find(el => el.getAttribute('data-folder-menu').startsWith('evil'));
            button.click();
        });
        const result = await page.evaluate(() => ({
            pwned: Boolean(window.__pwned),
            menuVisible: Boolean(document.querySelector('.skill-folder-menu.visible')),
            toggleFolder: document.querySelector('.skill-folder-menu [data-folder-agent="kimi"]')?.getAttribute('data-folder-toggle'),
            toggleTitle: document.querySelector('.skill-folder-menu [data-folder-agent="kimi"]')?.getAttribute('title'),
            newFolder: document.querySelector('.skill-folder-menu [data-skill-menu-new-folder]')?.getAttribute('data-skill-menu-new-folder'),
            removeFolder: document.querySelector('.skill-folder-menu [data-skill-remove-folder]')?.getAttribute('data-skill-remove-folder'),
        }));
        assert.equal(result.pwned, false, 'no inline handler is injected');
        assert.equal(result.menuVisible, true, 'menu still opens');
        assert.equal(result.toggleFolder, evilFolder, 'folder attribute preserved verbatim');
        assert.equal(result.newFolder, evilFolder);
        assert.equal(result.removeFolder, evilFolder);
        assert.ok(result.toggleTitle.includes(evilFolder), 'title carries the raw folder name safely');
    } finally {
        await browser.close();
    }
});
