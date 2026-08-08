'use strict';

// Covers WEBVIEW-AI-SKILL-PANEL-001 (Global/Project split panes).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-chromium');

const styles = fs.readFileSync(path.join(__dirname, '../../media/styles.css'), 'utf8');
const scrollStateScript = fs.readFileSync(
    path.join(__dirname, '../../media/webviewScrollStateScripts.js'),
    'utf8'
);
const skillPanelScript = fs.readFileSync(
    path.join(__dirname, '../../media/webviewSkillPanelScripts.js'),
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
        visibility: { kimi: 'active', claude: 'absent', codex: 'absent' },
        shadowedBy: {},
        diagnostics: [],
        ...overrides,
    };
}

// Enough cards in both scopes to overflow a 340x600 viewport pane.
function makeSplitRecords() {
    const records = [];
    for (let index = 0; index < 12; index += 1) {
        records.push(makeRecord({
            name: `global-${index}`,
            dirPath: `/home/dev/.kimi/skills/global-${index}`,
            skillFilePath: `/home/dev/.kimi/skills/global-${index}/SKILL.md`,
        }));
        records.push(makeRecord({
            name: `project-${index}`,
            scope: 'project',
            dirPath: `/work/app/.kimi/skills/project-${index}`,
            skillFilePath: `/work/app/.kimi/skills/project-${index}/SKILL.md`,
        }));
    }
    return records;
}

// Same initSkillPanel factory technique as skillPanelFilter.test.js; the
// harness also loads the scroll-state helper like the real bundle does.
async function openSkillsPage(browser, records, harnessOptions = {}) {
    const { getSkillsPanelContent } = loadSkillContent();
    const page = await browser.newPage({ viewport: { width: 340, height: 600 } });
    await page.setContent(`<!doctype html>
        <html>
            <head><style>${styles}</style></head>
            <body class="steward-sidebar">
                <section role="tabpanel" id="ai-panel-skills">${getSkillsPanelContent(records || makeSplitRecords(), { hasWorkspace: true })}</section>
            </body>
        </html>`);
    await page.evaluate(payload => {
        (function () {
            if (payload.withVscodeState) {
                window.vscode = {
                    _state: {},
                    getState() { return this._state; },
                    setState(next) { this._state = next; },
                };
            }
            var options = {
                postMessage(message) {
                    (window.__skillMessages = window.__skillMessages || []).push(message);
                    return Promise.resolve(true);
                },
            };
            eval(payload.scrollStateSource);
            eval(payload.panelSource);
            var skillPanel = initSkillPanel(options);
            window.__layoutSkillsSplit = skillPanel.layoutSkillsSplit;
            window.__replaceSkillsHtml = skillPanel.replaceSkillsHtml;
        })();
    }, {
        panelSource: skillPanelScript,
        scrollStateSource: scrollStateScript,
        withVscodeState: Boolean(harnessOptions.withVscodeState),
    });
    await page.evaluate('window.__layoutSkillsSplit()');
    return page;
}

function paneGeometry(page) {
    return page.evaluate(() => {
        const split = document.querySelector('[data-skills-split]');
        const userPane = document.querySelector('[data-skills-pane="user"]');
        const projectPane = document.querySelector('[data-skills-pane="project"]');
        const resizer = document.querySelector('[data-skills-pane-resizer]');
        const measure = el => {
            const rect = el.getBoundingClientRect();
            return {
                height: rect.height,
                top: rect.top,
                scrollHeight: el.scrollHeight,
                clientHeight: el.clientHeight,
            };
        };
        // Only the section list scrolls; the section header stays put.
        const userList = userPane.querySelector(':scope > .group.steward-section > .group-list');
        const projectList = projectPane.querySelector(':scope > .group.steward-section > .group-list');
        return {
            split: measure(split),
            user: measure(userPane),
            project: measure(projectPane),
            userList: measure(userList),
            projectList: measure(projectList),
            resizerHidden: resizer ? resizer.hidden : null,
            bodyScrollable: document.documentElement.scrollHeight > window.innerHeight + 2,
        };
    });
}

test('SKILLS-SPLIT-001 global and project lists scroll independently with pinned section headers', async () => {
    const browser = await chromium.launch();
    try {
        const page = await openSkillsPage(browser);
        const geometry = await paneGeometry(page);

        assert.ok(geometry.split.height > 0 && geometry.split.height <= 600,
            `split fits the viewport (got ${geometry.split.height})`);
        assert.ok(geometry.user.height > 0 && geometry.project.height > 0,
            'both panes get a share of the split');
        assert.ok(Math.abs(geometry.user.height + geometry.project.height + 9 - geometry.split.height) <= 2,
            'panes plus resizer fill the split');
        assert.equal(geometry.bodyScrollable, false, 'whole page no longer scrolls');
        assert.ok(geometry.project.height <= geometry.split.height * 0.45 + 2,
            `untouched project pane stays within the auto cap (got ${geometry.project.height})`);
        assert.ok(geometry.userList.scrollHeight > geometry.userList.clientHeight, 'global list overflows');
        assert.ok(geometry.projectList.scrollHeight > geometry.projectList.clientHeight, 'project list overflows');

        const scrolled = await page.evaluate(() => {
            const userList = document.querySelector('[data-skills-pane="user"] > .group.steward-section > .group-list');
            const projectList = document.querySelector('[data-skills-pane="project"] > .group.steward-section > .group-list');
            const userHeader = document.querySelector('[data-skills-pane="user"] .group.steward-section > .group-title');
            const projectHeader = document.querySelector('[data-skills-pane="project"] .group.steward-section > .group-title');
            const headerTopBefore = userHeader.getBoundingClientRect().top;
            const projectHeaderTopBefore = projectHeader.getBoundingClientRect().top;
            projectList.scrollTop = 120;
            return {
                user: userList.scrollTop,
                project: projectList.scrollTop,
                headerTopBefore: headerTopBefore,
                projectHeaderTopBefore: projectHeaderTopBefore,
            };
        });
        assert.equal(scrolled.project, 120, 'project list scrolls');
        assert.equal(scrolled.user, 0, 'global list scroll position is independent');
        const headerTopsAfter = await page.evaluate(() => ({
            user: document.querySelector('[data-skills-pane="user"] .group.steward-section > .group-title')
                .getBoundingClientRect().top,
            project: document.querySelector('[data-skills-pane="project"] .group.steward-section > .group-title')
                .getBoundingClientRect().top,
        }));
        assert.equal(headerTopsAfter.user, scrolled.headerTopBefore, 'section header stays put while the list scrolls');
        assert.equal(headerTopsAfter.project, scrolled.projectHeaderTopBefore,
            'project section header stays pinned while its own list scrolls');
    } finally {
        await browser.close();
    }
});

test('SKILLS-SPLIT-002 dragging the resizer sizes the project pane and the share survives HTML replacement', async () => {
    const browser = await chromium.launch();
    try {
        const page = await openSkillsPage(browser);
        const before = await paneGeometry(page);

        const resizerBox = await page.locator('[data-skills-pane-resizer]').boundingBox();
        assert.ok(resizerBox, 'resizer is visible');
        const startY = resizerBox.y + resizerBox.height / 2;
        const centerX = resizerBox.x + resizerBox.width / 2;
        await page.mouse.move(centerX, startY);
        await page.mouse.down();
        await page.mouse.move(centerX, startY - 90, { steps: 5 });
        await page.mouse.up();

        const after = await paneGeometry(page);
        assert.ok(Math.abs(after.project.height - (before.project.height + 90)) <= 6,
            `project pane grew by the drag delta (${before.project.height} -> ${after.project.height})`);
        assert.ok(Math.abs(after.user.height - (before.user.height - 90)) <= 6,
            'global pane yields the space the project pane gains');
        assert.ok(Math.abs(after.split.height - before.split.height) <= 2, 'split height stays put');
        const draggedState = await page.evaluate(() => ({
            inlineHeight: document.querySelector('[data-skills-pane="project"]').style.height,
            ariaNow: document.querySelector('[data-skills-pane-resizer]').getAttribute('aria-valuenow'),
        }));
        assert.ok(/^[0-9.]+px$/.test(draggedState.inlineHeight), 'dragged project pane gets an explicit height');
        assert.ok(Number(draggedState.ariaNow) > 0 && Number(draggedState.ariaNow) < 100,
            'separator announces the project share');

        // An authoritative skills-updated replacement must re-apply the share.
        const { getSkillsPanelContent } = loadSkillContent();
        const replacement = getSkillsPanelContent(makeSplitRecords(), { hasWorkspace: true });
        await page.evaluate(({ html }) => window.__replaceSkillsHtml(html), { html: replacement });
        const replaced = await paneGeometry(page);
        assert.ok(Math.abs(replaced.project.height - after.project.height) <= 3,
            `project share survives replacement (${after.project.height} -> ${replaced.project.height})`);
        assert.equal(replaced.resizerHidden, false);
    } finally {
        await browser.close();
    }
});

test('SKILLS-SPLIT-003 keyboard resize and collapse hand the space to the other pane', async () => {
    const browser = await chromium.launch();
    try {
        const page = await openSkillsPage(browser);
        const initial = await paneGeometry(page);

        await page.locator('[data-skills-pane-resizer]').focus();
        await page.keyboard.press('ArrowUp');
        const grown = await paneGeometry(page);
        assert.ok(Math.abs(grown.project.height - (initial.project.height + 24)) <= 3,
            `ArrowUp grows the project pane by a step (${initial.project.height} -> ${grown.project.height})`);
        await page.keyboard.press('ArrowDown');
        const shrunk = await paneGeometry(page);
        assert.ok(Math.abs(shrunk.project.height - initial.project.height) <= 3,
            'ArrowDown returns the project pane to the previous size');

        // Collapsing the project section drops it to header height and the
        // global pane takes the rest (MutationObserver-driven re-layout).
        await page.evaluate(() => {
            document.querySelector('.group.steward-section[data-group-id="project-skills"]')
                .classList.add('collapsed');
        });
        await page.waitForFunction(() => {
            const pane = document.querySelector('[data-skills-pane="project"]');
            return pane && pane.getBoundingClientRect().height < 60;
        }, { timeout: 3000 });
        const collapsed = await paneGeometry(page);
        assert.ok(collapsed.user.height > shrunk.user.height + 100,
            'global pane absorbs the collapsed project pane space');
        assert.equal(collapsed.resizerHidden, true, 'resizer hides while a pane is collapsed');
    } finally {
        await browser.close();
    }
});

function centralRecord(overrides = {}) {
    const dirPath = overrides.dirPath || '/home/dev/.skills/pack/demo';
    const name = overrides.name || 'demo';
    return makeRecord({
        name,
        source: 'central',
        dirPath,
        skillFilePath: `${dirPath}/SKILL.md`,
        folder: 'pack',
        central: { dirPath, links: { user: {}, project: {} } },
        visibility: { kimi: 'absent', claude: 'absent', codex: 'absent' },
        ...overrides,
    });
}

test('SKILLS-SPLIT-004 pane list scroll positions survive authoritative HTML replacement', async () => {
    const browser = await chromium.launch();
    try {
        const page = await openSkillsPage(browser);
        const before = await page.evaluate(() => {
            const userList = document.querySelector('[data-skills-pane="user"] > .group.steward-section > .group-list');
            const projectList = document.querySelector('[data-skills-pane="project"] > .group.steward-section > .group-list');
            userList.scrollTop = 150;
            projectList.scrollTop = 150;
            return { user: userList.scrollTop, project: projectList.scrollTop };
        });
        assert.equal(before.user, 150);
        assert.equal(before.project, 150);

        const { getSkillsPanelContent } = loadSkillContent();
        const replacement = getSkillsPanelContent(makeSplitRecords(), { hasWorkspace: true });
        const after = await page.evaluate(({ html }) => {
            window.__replaceSkillsHtml(html);
            return {
                user: document.querySelector('[data-skills-pane="user"] > .group.steward-section > .group-list').scrollTop,
                project: document.querySelector('[data-skills-pane="project"] > .group.steward-section > .group-list').scrollTop,
            };
        }, { html: replacement });
        assert.ok(Math.abs(after.user - 150) <= 2,
            `global list keeps its scroll anchor (got ${after.user})`);
        assert.ok(Math.abs(after.project - 150) <= 2,
            `project list keeps its scroll anchor (got ${after.project})`);
    } finally {
        await browser.close();
    }
});

test('SKILLS-SPLIT-005 folder headers stick to the pane list top while scrolling', async () => {
    const browser = await chromium.launch();
    try {
        const records = [];
        for (let index = 0; index < 10; index += 1) {
            records.push(centralRecord({
                name: `filed-${index}`,
                dirPath: `/home/dev/.skills/pack/filed-${index}`,
                skillFilePath: `/home/dev/.skills/pack/filed-${index}/SKILL.md`,
            }));
        }
        for (let index = 0; index < 8; index += 1) {
            records.push(makeRecord({
                name: `project-${index}`,
                scope: 'project',
                dirPath: `/work/app/.kimi/skills/project-${index}`,
                skillFilePath: `/work/app/.kimi/skills/project-${index}/SKILL.md`,
            }));
        }
        const page = await openSkillsPage(browser, records);
        const geometry = await page.evaluate(() => {
            const list = document.querySelector('[data-skills-pane="user"] > .group.steward-section > .group-list');
            const folder = document.querySelector('.skill-folder[data-skill-folder="pack"]');
            const header = folder.querySelector(':scope > .group-title.skill-folder-header');
            const before = {
                position: getComputedStyle(header).position,
                headerTop: header.getBoundingClientRect().top,
                listTop: list.getBoundingClientRect().top,
            };
            list.scrollTop = 300;
            return {
                before,
                after: {
                    headerTop: header.getBoundingClientRect().top,
                    listTop: list.getBoundingClientRect().top,
                },
                folderBottom: folder.getBoundingClientRect().bottom,
            };
        });
        assert.equal(geometry.before.position, 'sticky', 'folder header participates in sticky positioning');
        assert.ok(geometry.before.headerTop >= geometry.before.listTop, 'header starts below the list top');
        assert.ok(Math.abs(geometry.after.headerTop - geometry.after.listTop) <= 2,
            `folder header stays pinned at the list top (header ${geometry.after.headerTop}, list ${geometry.after.listTop})`);
        assert.ok(geometry.folderBottom > geometry.after.listTop + 40,
            'folder content still visible below its pinned header');
    } finally {
        await browser.close();
    }
});

test('SKILLS-SPLIT-006 the dragged project pane share persists in webview view state', async () => {
    const browser = await chromium.launch();
    try {
        const page = await openSkillsPage(browser, undefined, { withVscodeState: true });
        await page.locator('[data-skills-pane-resizer]').focus();
        await page.keyboard.press('ArrowUp');
        const saved = await page.evaluate(() => (window.vscode.getState() || {}).skillsPanel);
        assert.ok(saved && typeof saved.projectPaneRatio === 'number'
            && saved.projectPaneRatio > 0 && saved.projectPaneRatio < 1,
            `keyboard resize persists the ratio (got ${JSON.stringify(saved)})`);

        // A fresh panel instance (new closure, same view state) must honor it.
        const after = await page.evaluate(panelSource => {
            eval(panelSource);
            var skillPanel = initSkillPanel({ postMessage: () => Promise.resolve(true) });
            skillPanel.layoutSkillsSplit();
            var split = document.querySelector('[data-skills-split]').getBoundingClientRect().height;
            var resizer = document.querySelector('[data-skills-pane-resizer]').getBoundingClientRect().height;
            var project = document.querySelector('[data-skills-pane="project"]').getBoundingClientRect().height;
            return { project, inner: split - resizer };
        }, skillPanelScript);
        assert.ok(Math.abs(after.project - after.inner * saved.projectPaneRatio) <= 3,
            `fresh mount restores the persisted share (expected ~${Math.round(after.inner * saved.projectPaneRatio)}, got ${after.project})`);
    } finally {
        await browser.close();
    }
});
