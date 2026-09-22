'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-chromium');
const { createFakeVscode } = require('../helpers/fakeVscode');

function loadWebviewContent() {
    const vscode = createFakeVscode({});
    vscode.Uri = {
        file: value => ({ fsPath: value, path: value, toString: () => `file://${value}` }),
    };
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return vscode;
            return previousLoad.call(this, request, parent, isMain);
        };
        return require('../../out/webview/webviewContent');
    } finally {
        Module._load = previousLoad;
    }
}

const { getStewardContent } = loadWebviewContent();
const dashboardStyles = fs.readFileSync(
    path.join(__dirname, '../../media/styles.css'),
    'utf8'
);

const BROWSER_CONDITION_TIMEOUT_MS = 5_000;

let browser;

test.before(async () => {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
});

test.after(async () => {
    await browser.close();
});

function sidebarDocument() {
    return getStewardContent(
        { extensionPath: '/extension' },
        {
            cspSource: 'https://assets.test',
            asWebviewUri: resource => ({
                toString: () => `https://assets.test/${path.basename(resource.fsPath)}`,
            }),
        },
        [],
        {
            config: { get: (_key, fallback) => fallback },
            relevantExtensionsInstalls: { remoteSSH: true, remoteContainers: false },
            otherStorageHasData: false,
        },
        true,
    )
        .replace(/<meta[^>]*Content-Security-Policy[^>]*>/, '')
        .replace(/<link[^>]*rel="stylesheet"[^>]*>/, '')
        .replace(/<script src="[^"]*webviewDashboardBundle\.js[^"]*"><\/script>/, '')
        .replace('</head>', `<style>${dashboardStyles}</style></head>`)
        .replace('class="dashboard-styles-pending"', '');
}

async function openSidebarPage(t, width) {
    const page = await browser.newPage({ viewport: { width, height: 480 } });
    t.after(() => page.close());
    page.setDefaultTimeout(BROWSER_CONDITION_TIMEOUT_MS);
    await page.setContent(sidebarDocument(), { waitUntil: 'load' });
    await page.waitForFunction(() => {
        const header = document.querySelector('.steward-sticky-header');
        const tabs = document.querySelector('.dashboard-tab-list');
        return header && tabs && header.getBoundingClientRect().height > 0;
    });
    return page;
}

function headerMetrics(page) {
    return page.evaluate(() => {
        const rect = selector => {
            const element = document.querySelector(selector);
            if (!element) return null;
            const box = element.getBoundingClientRect();
            return { left: box.left, right: box.right, top: box.top, bottom: box.bottom };
        };
        const activeTab = document.querySelector('.dashboard-tab-button[aria-selected="true"]');
        const activeTabBox = activeTab.getBoundingClientRect();
        const underlineStyle = getComputedStyle(activeTab, '::after');
        return {
            header: rect('.steward-sticky-header'),
            searchBox: rect('.search-box'),
            sponsor: rect('.sponsor-button'),
            toggle: rect('.toggle-all-groups-button'),
            settings: rect('.settings-button'),
            tabList: rect('.dashboard-tab-list'),
            firstTab: rect('.dashboard-tab-button[data-dashboard-tab="open"]'),
            underlineBottom: activeTabBox.bottom - parseFloat(underlineStyle.bottom),
        };
    });
}

async function populateLongDashboardTab(page, tab) {
    await page.evaluate(activeTab => {
        const open = document.getElementById('dashboard-tab-open');
        const projects = document.getElementById('dashboard-tab-projects');
        const ai = document.getElementById('dashboard-panel-ai');
        open.hidden = true;
        projects.hidden = activeTab !== 'projects';
        ai.hidden = activeTab !== 'ai';
        if (!projects.dataset.longContent) {
            projects.dataset.longContent = 'true';
            projects.innerHTML = `<div class="groups-wrapper">${Array.from({ length: 10 }, (_, group) =>
                `<section class="group"><div class="group-header">Group ${group}</div><div class="group-list">${Array.from({ length: 5 }, (_, project) =>
                    `<div class="project"><div class="project-row-main">Project ${group}-${project}</div></div>`
                ).join('')}</div></section>`
            ).join('')}</div>`;
        }
        if (!ai.dataset.longContent) {
            ai.dataset.longContent = 'true';
            ai.innerHTML = `<div class="ai-panel"><div class="ai-tablist"><button>PROMPTS</button></div>
                <ol class="prompt-list">${Array.from({ length: 40 }, (_, index) =>
                    `<li class="prompt-item">Prompt ${index}</li>`
                ).join('')}</ol></div>`;
        }
    }, tab);
}

async function dashboardScrollportMetrics(page, tab) {
    return page.evaluate(activeTab => {
        const header = document.querySelector('.steward-sticky-header');
        const panel = document.getElementById(activeTab === 'projects'
            ? 'dashboard-tab-projects'
            : 'dashboard-panel-ai');
        const headerBox = header.getBoundingClientRect();
        const panelBox = panel.getBoundingClientRect();
        return {
            documentScrollHeight: document.documentElement.scrollHeight,
            viewportHeight: window.innerHeight,
            header: { left: headerBox.left, right: headerBox.right, bottom: headerBox.bottom },
            panel: {
                top: panelBox.top,
                clientHeight: panel.clientHeight,
                scrollHeight: panel.scrollHeight,
                overflowY: getComputedStyle(panel).overflowY,
                scrollbarGutter: getComputedStyle(panel).scrollbarGutter,
            },
        };
    }, tab);
}

test('WEBVIEW-SIDEBAR-HEADER-LAYOUT-001 floats sidebar header rows symmetrically on one separator line', async t => {
    for (const width of [315, 240]) {
        const page = await openSidebarPage(t, width);
        const metrics = await headerMetrics(page);

        const sponsorGap = metrics.toggle.left - metrics.sponsor.right;
        const settingsGap = metrics.settings.left - metrics.toggle.right;
        assert.equal(
            settingsGap,
            sponsorGap,
            `width ${width}: settings button gap ${settingsGap}px must match the ${sponsorGap}px sibling gap`
        );

        const leftInset = metrics.searchBox.left - metrics.header.left;
        const rightInset = metrics.header.right - metrics.settings.right;
        assert.ok(
            leftInset >= 4,
            `width ${width}: header content hugs the panel edge with only a ${leftInset}px inset`
        );
        assert.ok(
            Math.abs(leftInset - rightInset) <= 1,
            `width ${width}: header content floats asymmetrically, left ${leftInset}px vs right ${rightInset}px`
        );

        assert.ok(
            Math.abs(metrics.firstTab.left - metrics.searchBox.left) <= 1,
            `width ${width}: tab strip starts at ${metrics.firstTab.left}px, `
                + `outside the search row edge ${metrics.searchBox.left}px`
        );
        assert.ok(
            Math.abs(metrics.tabList.right - metrics.settings.right) <= 1,
            `width ${width}: tab strip ends at ${metrics.tabList.right}px, `
                + `outside the settings button edge ${metrics.settings.right}px`
        );

        assert.ok(
            Math.abs(metrics.header.bottom - metrics.tabList.bottom) <= 1,
            `width ${width}: header bottom ${metrics.header.bottom}px and tab strip bottom `
                + `${metrics.tabList.bottom}px leave a double-separator band`
        );
        assert.ok(
            Math.abs(metrics.underlineBottom - metrics.header.bottom) <= 1.5,
            `width ${width}: active tab underline at ${metrics.underlineBottom}px `
                + `is detached from the separator line at ${metrics.header.bottom}px`
        );
    }
});

test('WEBVIEW-DASHBOARD-SCROLLPORT-001 keeps the header outside long Projects and AI tab scrollports', async t => {
    const page = await openSidebarPage(t, 320);
    await populateLongDashboardTab(page, 'projects');
    const projects = await dashboardScrollportMetrics(page, 'projects');

    await populateLongDashboardTab(page, 'ai');
    const ai = await dashboardScrollportMetrics(page, 'ai');

    for (const [name, metrics] of [['Projects', projects], ['AI', ai]]) {
        assert.ok(metrics.documentScrollHeight <= metrics.viewportHeight + 1,
            `${name} must not make the root document scroll: ${JSON.stringify(metrics)}`);
        assert.ok(metrics.panel.scrollHeight > metrics.panel.clientHeight,
            `${name} must scroll inside its active Tab panel: ${JSON.stringify(metrics)}`);
        assert.equal(metrics.panel.overflowY, 'auto',
            `${name} must expose its own vertical scrollport`);
        assert.equal(metrics.panel.scrollbarGutter, 'stable',
            `${name} must reserve scrollbar space before it overflows`);
        assert.ok(metrics.panel.top >= metrics.header.bottom - 1,
            `${name} must begin below the fixed dashboard header`);
    }
    assert.deepEqual(ai.header, projects.header,
        'switching between long tabs must not move or narrow the dashboard header');
});

test('DASHBOARD-OVERFLOW-MENUS-001 gives every action an aligned icon and keeps menus readable across themes and widths', async t => {
    const page = await openSidebarPage(t, 360);
    for (const theme of ['light', 'dark']) {
        await page.addStyleTag({ content: `:root {
            --vscode-menu-background: ${theme === 'light' ? '#fafafa' : '#252526'};
            --vscode-menu-foreground: ${theme === 'light' ? '#242424' : '#eeeeee'};
            --vscode-menu-border: ${theme === 'light' ? '#d5d5d5' : '#505050'};
            --vscode-menu-separatorBackground: ${theme === 'light' ? '#dedede' : '#454545'};
            --vscode-widget-shadow: ${theme === 'light' ? '#00000024' : '#00000066'};
            --vscode-menu-selectionBackground: ${theme === 'light' ? '#e9e9eb' : '#39393c'};
            --vscode-menu-selectionForeground: ${theme === 'light' ? '#161616' : '#ffffff'};
        }` });
        for (const width of [360, 170]) {
            await page.setViewportSize({ width, height: 600 });
            for (const id of ['projectContextMenu', 'groupContextMenu', 'aiSessionContextMenu', 'aiSessionWorktreeMenu', 'openWindowMenu', 'aiSessionCreateDropdown']) {
                const menu = page.locator('#' + id);
                await menu.evaluate(el => {
                    el.classList.add('visible');
                    el.style.left = '4px';
                    el.style.top = '40px';
                });
                if (id === 'aiSessionContextMenu') {
                    await page.screenshot({ path: `/tmp/overflow-${theme}-${width}.png` });
                }
                const metrics = await menu.evaluate(el => {
                    const rect = el.getBoundingClientRect();
                    return {
                        right: rect.right,
                        radius: parseFloat(getComputedStyle(el).borderRadius),
                        items: Array.from(el.querySelectorAll('[data-action]')).filter(item => !item.hidden).map(item => {
                            const icon = getComputedStyle(item, '::before');
                            return { text: item.textContent.trim(), icon: icon.maskImage, iconWidth: icon.width,
                                height: item.getBoundingClientRect().height,
                                overflow: item.scrollWidth > item.clientWidth + 1 };
                        }),
                    };
                });
                assert.ok(metrics.radius >= 10, `${id} uses the shared rounded surface`);
                assert.ok(metrics.right <= width, `${id} fits a ${width}px panel`);
                for (const item of metrics.items) {
                    assert.notEqual(item.icon, 'none', `${id}: ${item.text} has a semantic icon`);
                    assert.equal(item.iconWidth, '16px');
                    assert.ok(item.height >= 32, `${id}: ${item.text} has a readable row height`);
                    assert.equal(item.overflow, false, `${id}: ${item.text} is not clipped`);
                }
                await menu.evaluate(el => el.classList.remove('visible'));
            }
        }
    }
    await page.emulateMedia({ forcedColors: 'active' });
    const menu = page.locator('#aiSessionContextMenu');
    await menu.evaluate(el => el.classList.add('visible'));
    const icon = await menu.locator('[data-action="rename"]').evaluate(el => ({
        mask: getComputedStyle(el, '::before').maskImage,
        color: getComputedStyle(el, '::before').backgroundColor,
    }));
    assert.notEqual(icon.mask, 'none');
    assert.ok(!/rgba\([^)]*, 0\)$/.test(icon.color), 'icons remain visible in forced colors');
});
