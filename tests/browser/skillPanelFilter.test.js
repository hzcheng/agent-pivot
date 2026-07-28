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
        visibility: { kimi: 'active', claude: 'absent', codex: 'absent' },
        shadowedBy: {},
        diagnostics: [],
        ...overrides,
    };
}

function makeRecords() {
    const records = [
        makeRecord({ name: 'kimi-global' }),
        makeRecord({
            name: 'claude-global',
            source: 'claude',
            dirPath: '/home/dev/.claude/skills/claude-global',
            skillFilePath: '/home/dev/.claude/skills/claude-global/SKILL.md',
            visibility: { kimi: 'shadowed', claude: 'active', codex: 'absent' },
            shadowedBy: { kimi: '/home/dev/.kimi/skills' },
        }),
    ];
    for (let index = 0; index < 6; index += 1) {
        records.push(makeRecord({
            name: `codex-project-${index}`,
            scope: 'project',
            source: 'codex',
            dirPath: `/work/app/.codex/skills/codex-project-${index}`,
            skillFilePath: `/work/app/.codex/skills/codex-project-${index}/SKILL.md`,
            visibility: { kimi: 'absent', claude: 'absent', codex: 'active' },
        }));
    }
    return records;
}

// The filter/collapse/click implementation lives inside the dashboard script's
// IIFE alongside unrelated panel wiring; exercise it by extracting its exact span.
function extractFilterCode() {
    const start = dashboardScript.indexOf('var skillAgentFilter');
    const end = dashboardScript.indexOf('function revealPendingTodoSearchTarget');
    assert.notEqual(start, -1, 'skillAgentFilter marker missing — update this test');
    assert.notEqual(end, -1, 'revealPendingTodoSearchTarget marker missing — update this test');
    return dashboardScript.slice(start, end);
}

async function openSkillsPage(browser, records, groups = {}) {
    const { getSkillsPanelContent } = loadSkillContent();
    const page = await browser.newPage({ viewport: { width: 340, height: 600 } });
    await page.setContent(`<!doctype html>
        <html>
            <head><style>${styles}</style></head>
            <body class="steward-sidebar">
                <section role="tabpanel" id="ai-panel-skills">${getSkillsPanelContent(records || makeRecords(), { groups })}</section>
            </body>
        </html>`);
    await page.evaluate(filterSource => {
        (function () {
            var options = {
                postMessage(message) {
                    (window.__skillMessages = window.__skillMessages || []).push(message);
                    return Promise.resolve(true);
                },
            };
            eval(filterSource);
            document.addEventListener('click', onSkillCardClick);
            document.addEventListener('dragstart', onSkillDragStart);
            document.addEventListener('dragover', onSkillDragOver);
            document.addEventListener('dragleave', onSkillDragLeave);
            document.addEventListener('drop', onSkillDrop);
            document.addEventListener('dragend', onSkillDragEnd);
            window.__setSkillFilter = function (value) {
                skillAgentFilter = value;
                applySkillAgentFilter();
            };
            window.__captureSkillCollapsedGroups = captureSkillCollapsedGroups;
            window.__restoreSkillCollapsedGroups = restoreSkillCollapsedGroups;
            window.__captureSkillExpandedCards = captureSkillExpandedCards;
            window.__restoreSkillExpandedCards = restoreSkillExpandedCards;
        })();
    }, extractFilterCode());
    return page;
}

function snapshot(page) {
    return page.evaluate(() => {
        const visible = el => {
            const style = getComputedStyle(el);
            return style.display !== 'none'
                && style.visibility !== 'hidden'
                && el.getBoundingClientRect().height > 0;
        };
        return {
            cards: [...document.querySelectorAll('.project-container')].map(el => ({
                name: el.querySelector('.project-header').textContent,
                visible: visible(el),
            })),
            sections: [...document.querySelectorAll('.group.steward-section')].map(el => ({
                id: el.getAttribute('data-group-id'),
                visible: visible(el),
                badge: el.querySelector('.group-title-badge').textContent,
            })),
            sources: [...document.querySelectorAll('.skill-source-group')].map(el => ({
                source: el.getAttribute('data-skill-source'),
                visible: visible(el),
                count: el.querySelector('.skill-source-count').textContent,
            })),
        };
    });
}

test('SKILLS-FILTER-001 agent filter hides non-matching cards and truly hides empty sections', async () => {
    const browser = await chromium.launch();
    try {
        const page = await openSkillsPage(browser);

        const initial = await snapshot(page);
        assert.equal(initial.cards.filter(card => card.visible).length, 8);
        assert.deepEqual(
            initial.sections.map(section => ({ id: section.id, badge: section.badge })),
            [{ id: 'user-skills', badge: '2' }, { id: 'project-skills', badge: '6' }]
        );

        await page.evaluate('window.__setSkillFilter("claude")');
        const filtered = await snapshot(page);
        assert.deepEqual(
            filtered.cards.filter(card => card.visible).map(card => card.name),
            ['claude-global'],
            'only the claude-active card stays visible'
        );
        const project = filtered.sections.find(section => section.id === 'project-skills');
        assert.equal(project.visible, false, 'empty PROJECT SKILLS section is truly hidden (not just [hidden])');
        const user = filtered.sections.find(section => section.id === 'user-skills');
        assert.equal(user.visible, true);
        assert.equal(user.badge, '1', 'section badge reflects the filtered count');
        const kimiSource = filtered.sources.find(source => source.source === 'kimi');
        assert.equal(kimiSource.visible, false, 'source group with no matching cards is hidden');
        const claudeSource = filtered.sources.find(source => source.source === 'claude');
        assert.equal(claudeSource.visible, true);
        assert.equal(claudeSource.count, '1', 'source count reflects the filtered count');

        await page.evaluate('window.__setSkillFilter("all")');
        const restored = await snapshot(page);
        assert.equal(restored.cards.filter(card => card.visible).length, 8);
        assert.deepEqual(
            restored.sections.map(section => section.badge),
            ['2', '6'],
            'totals are restored when returning to All'
        );
    } finally {
        await browser.close();
    }
});


test('SKILLS-COLLAPSE-001 skill groups collapse via shared affordance and state survives content replacement', async () => {
    const browser = await chromium.launch();
    try {
        const page = await openSkillsPage(browser);

        const affordance = await page.evaluate(() => ({
            titles: [...document.querySelectorAll('.skills-groups-wrapper .group-title-text[data-action="collapse"]')].length,
            icons: [...document.querySelectorAll('.skills-groups-wrapper .collapse-icon')].length,
        }));
        assert.equal(affordance.titles, 2, 'both scope groups carry the collapse affordance');
        assert.equal(affordance.icons, 2);

        // The shared onInsideGroupClick machinery toggles `.collapsed` on the group;
        // simulate its exact effect and verify the CSS actually collapses the list.
        await page.evaluate(() => {
            document.querySelector('.group.steward-section[data-group-id="user-skills"]')
                .classList.add('collapsed');
        });
        const collapsedHeight = await page.evaluate(() =>
            document.querySelector('.group.steward-section[data-group-id="user-skills"] .group-list')
                .getBoundingClientRect().height
        );
        assert.ok(collapsedHeight <= 7,
            `collapsed group list is visually hidden (repo collapse leaves only the padding strip, got ${collapsedHeight})`);

        // Simulate a skills-updated authoritative replacement (toggle/watch refresh):
        // collapsed state must be captured before and restored after the swap.
        const after = await page.evaluate(() => {
            const wrapper = document.querySelector('#ai-panel-skills .sticky-groups-wrapper');
            const ids = window.__captureSkillCollapsedGroups(wrapper);
            wrapper.outerHTML = wrapper.outerHTML;
            const fresh = document.querySelector('#ai-panel-skills .sticky-groups-wrapper');
            window.__restoreSkillCollapsedGroups(fresh, ids);
            return {
                ids,
                userCollapsed: document.querySelector('.group.steward-section[data-group-id="user-skills"]')
                    .classList.contains('collapsed'),
                projectCollapsed: document.querySelector('.group.steward-section[data-group-id="project-skills"]')
                    .classList.contains('collapsed'),
            };
        });
        assert.deepEqual(after.ids, ['user-skills']);
        assert.equal(after.userCollapsed, true, 'collapsed state survives the skills-updated replacement');
        assert.equal(after.projectCollapsed, false, 'other groups are not collapsed accidentally');
    } finally {
        await browser.close();
    }
});


test('SKILLS-GROUP-001 collections render as folder nodes with working toggle and editor actions', async () => {
    const records = [
        makeRecord({
            name: 'kimi-global',
            dirPath: '/home/dev/.kimi/skills/kimi-global',
            skillFilePath: '/home/dev/.kimi/skills/kimi-global/SKILL.md',
        }),
        makeRecord({
            name: 'other-global',
            dirPath: '/home/dev/.kimi/skills/other-global',
            skillFilePath: '/home/dev/.kimi/skills/other-global/SKILL.md',
        }),
        makeRecord({
            name: 'codex-project',
            scope: 'project',
            source: 'codex',
            dirPath: '/work/app/.codex/skills/codex-project',
            skillFilePath: '/work/app/.codex/skills/codex-project/SKILL.md',
            visibility: { kimi: 'absent', claude: 'absent', codex: 'active' },
        }),
    ];
    const groups = { '/home/dev/.kimi/skills/kimi-global': 'superpowers' };
    const browser = await chromium.launch();
    try {
        const page = await openSkillsPage(browser, records, groups);

        const structure = await page.evaluate(() => ({
            collections: [...document.querySelectorAll('.skill-collection')].map(el => ({
                name: el.getAttribute('data-skill-collection'),
                scope: el.getAttribute('data-skill-collection-scope'),
                cards: el.querySelectorAll('.skill-card').length,
                badge: el.querySelector('.group-title-badge').textContent,
            })),
            ungroupedInSource: document.querySelectorAll('.skill-source-group .skill-card').length,
        }));
        assert.deepEqual(structure.collections, [
            { name: 'superpowers', scope: 'user', cards: 1, badge: '1' },
        ], 'assigned skill renders inside its folder node');
        assert.equal(structure.ungroupedInSource, 2, 'unassigned skills stay in source groups');

        // Group toggle posts the batch message with the shared enabled polarity.
        await page.click('[data-skill-group-toggle="superpowers"]');
        // Clicking a card expands its detail (the real user interaction).
        await page.click('.skill-card[data-skill-dir="/home/dev/.kimi/skills/other-global"] .project-header');
        await page.click('.skill-card[data-skill-dir="/home/dev/.kimi/skills/kimi-global"] .project-header');
        const expanded = await page.evaluate(() => [...document.querySelectorAll('.skill-card')]
            .map(card => ({ dir: card.getAttribute('data-skill-dir'), open: card.classList.contains('skill-detail-open'), hidden: card.querySelector('.skill-detail').hidden })));
        assert.deepEqual(expanded.map(item => item.open), [true, true, false],
            'card click expands the detail panel');
        assert.deepEqual(expanded.map(item => item.hidden), [false, false, true]);
        // Clicking inside the detail (e.g. into the group input) must not collapse it.
        await page.click('[data-skill-group-input="/home/dev/.kimi/skills/other-global"]');
        const stillOpen = await page.evaluate(() => {
            const card = document.querySelector('.skill-card[data-skill-dir="/home/dev/.kimi/skills/other-global"]');
            return { open: card.classList.contains('skill-detail-open'), hidden: card.querySelector('.skill-detail').hidden };
        });
        assert.deepEqual(stillOpen, { open: true, hidden: false },
            'clicking inside the detail panel keeps it open');
        // Assigning a group through the card editor, and removing one via ungroup.
        await page.evaluate(() => {
            const input = document.querySelector('[data-skill-group-input="/home/dev/.kimi/skills/other-global"]');
            input.value = 'my-suite';
        });
        await page.click('[data-skill-setgroup="/home/dev/.kimi/skills/other-global"]');
        await page.click('[data-skill-ungroup="/home/dev/.kimi/skills/kimi-global"]');
        const messages = await page.evaluate(() => window.__skillMessages);
        assert.deepEqual(messages, [
            { type: 'toggle-skill-group', name: 'superpowers', scope: 'user', enabled: true },
            { type: 'set-skill-group', dirPath: '/home/dev/.kimi/skills/other-global', group: 'my-suite' },
            { type: 'set-skill-group', dirPath: '/home/dev/.kimi/skills/kimi-global', group: '' },
        ]);

        // A skills-updated authoritative replacement (what a Set/ungroup triggers
        // host-side) must keep expanded detail panels open.
        const expandedAfter = await page.evaluate(() => {
            const wrapper = document.querySelector('#ai-panel-skills .sticky-groups-wrapper');
            const dirs = window.__captureSkillExpandedCards(wrapper);
            wrapper.outerHTML = wrapper.outerHTML;
            const fresh = document.querySelector('#ai-panel-skills .sticky-groups-wrapper');
            window.__restoreSkillExpandedCards(fresh, dirs);
            return {
                dirs,
                openCards: [...fresh.querySelectorAll('.skill-card.skill-detail-open')]
                    .map(card => card.getAttribute('data-skill-dir')),
            };
        });
        assert.deepEqual(expandedAfter.dirs.sort(), expandedAfter.openCards.sort(),
            'expanded detail panels survive the skills-updated replacement');

        // Agent filter hides a collection with no visible members.
        await page.evaluate('window.__setSkillFilter("claude")');
        const filtered = await page.evaluate(() => {
            const collection = document.querySelector('.skill-collection');
            const style = getComputedStyle(collection);
            return { display: style.display, hidden: collection.classList.contains('skill-filter-hidden') };
        });
        assert.equal(filtered.hidden, true, 'collection with no matching members hides');
        assert.equal(filtered.display, 'none');
    } finally {
        await browser.close();
    }
});


test('SKILLS-DND-001 dragging a card onto a collection assigns the group, scope-mismatched drops refused', async () => {
    const records = [
        makeRecord({
            name: 'kimi-global',
            dirPath: '/home/dev/.kimi/skills/kimi-global',
            skillFilePath: '/home/dev/.kimi/skills/kimi-global/SKILL.md',
        }),
        makeRecord({
            name: 'other-global',
            dirPath: '/home/dev/.kimi/skills/other-global',
            skillFilePath: '/home/dev/.kimi/skills/other-global/SKILL.md',
        }),
        makeRecord({
            name: 'codex-project',
            scope: 'project',
            source: 'codex',
            dirPath: '/work/app/.codex/skills/codex-project',
            skillFilePath: '/work/app/.codex/skills/codex-project/SKILL.md',
            visibility: { kimi: 'absent', claude: 'absent', codex: 'active' },
        }),
    ];
    const groups = {
        '/home/dev/.kimi/skills/kimi-global': 'superpowers',
        '/work/app/.codex/skills/codex-project': 'superpowers',
    };
    const browser = await chromium.launch();
    try {
        const page = await openSkillsPage(browser, records, groups);

        const result = await page.evaluate(() => {
            const dt = new DataTransfer();
            const fire = (target, type) => {
                const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt });
                target.dispatchEvent(event);
                return event.defaultPrevented;
            };
            const out = {};
            const card = document.querySelector('.project-container[data-skill-scope="user"]:has(.skill-card[data-skill-dir="/home/dev/.kimi/skills/other-global"])');
            const userCollection = document.querySelector('.skill-collection[data-skill-collection-scope="user"]');
            const projectCollection = document.querySelector('.skill-collection[data-skill-collection-scope="project"]');

            fire(card, 'dragstart');
            out.draggingClass = card.classList.contains('skill-card-dragging');
            out.dragData = dt.getData('text/plain');

            // Scope mismatch: hovering the project collection must not highlight or allow drop.
            const projectPrevented = fire(projectCollection, 'dragover');
            out.projectHighlight = projectCollection.classList.contains('skill-drop-target');
            out.projectPrevented = projectPrevented;

            // Matching scope: highlight + drop assigns the group.
            const userPrevented = fire(userCollection, 'dragover');
            out.userHighlight = userCollection.classList.contains('skill-drop-target');
            out.userPrevented = userPrevented;
            fire(userCollection, 'drop');
            out.highlightAfterDrop = userCollection.classList.contains('skill-drop-target');

            fire(card, 'dragend');
            out.draggingAfterEnd = card.classList.contains('skill-card-dragging');
            return out;
        });

        assert.equal(result.draggingClass, true, 'dragstart marks the dragged card');
        assert.equal(result.dragData, '/home/dev/.kimi/skills/other-global');
        assert.equal(result.projectHighlight, false, 'scope-mismatched collection does not highlight');
        assert.equal(result.projectPrevented, false, 'scope-mismatched dragover is not accepted');
        assert.equal(result.userHighlight, true, 'matching collection highlights on dragover');
        assert.equal(result.userPrevented, true, 'matching dragover is accepted');
        assert.equal(result.highlightAfterDrop, false, 'highlight clears after drop');
        assert.equal(result.draggingAfterEnd, false, 'dragend cleans up');

        const messages = await page.evaluate(() => window.__skillMessages);
        assert.deepEqual(messages, [
            { type: 'set-skill-group', dirPath: '/home/dev/.kimi/skills/other-global', group: 'superpowers' },
        ]);
    } finally {
        await browser.close();
    }
});
