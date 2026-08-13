'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-chromium');
const { createFakeVscode } = require('../helpers/fakeVscode');

function loadWebviewModules() {
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
        return {
            ...require('../../out/webview/webviewContent'),
            ...require('../../out/webview/webviewAiSessionContent'),
        };
    } finally {
        Module._load = previousLoad;
    }
}

const { getAiSessionsDiv, getAiSessionCreateDropdown } = loadWebviewModules();

const viewStateScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewAiSessionViewStateScripts.js'),
    'utf8'
);
const workspaceUpdateScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewWorkspaceUpdateScripts.js'),
    'utf8'
);
const todoGroupScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewTodoGroupScripts.js'),
    'utf8'
);
const projectCollapseScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewProjectCollapseScripts.js'),
    'utf8'
);
const todoControlScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewTodoControlScripts.js'),
    'utf8'
);
const projectContextMenuScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewProjectContextMenuScripts.js'),
    'utf8'
);
const projectAiUpdateScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewProjectAiUpdateScripts.js'),
    'utf8'
);
const aiSessionControlsScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewProjectAiSessionControlsScripts.js'),
    'utf8'
);
const projectScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewProjectScripts.js'),
    'utf8'
);
const scrollStateScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewScrollStateScripts.js'),
    'utf8'
);
const dashboardStyles = fs.readFileSync(
    path.join(__dirname, '../../media/styles.css'),
    'utf8'
);
// The full stylesheet gates card visibility behind the dashboard tab chrome;
// the caption behavior is self-contained in its own compiled rules.
const captionStyleRules = (dashboardStyles.match(/[^{}]*ai-session-create-caption[^{}]*\{[^}]*\}/g) || [])
    .join('\n');

let browser;

test.before(async () => {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
});

test.after(async () => {
    await browser.close();
});

function getSessionSurface(id, activeProvider, quickCreateProfile) {
    return {
        id,
        activeAiSessionProvider: activeProvider,
        selectedAiSessionProviders: [activeProvider],
        activeAiSessionTab: 'sessions',
        codexSessions: [{ id: `${id}-codex`, name: 'Codex history', provider: 'codex' }],
        kimiSessions: [{ id: `${id}-kimi`, name: 'Kimi history', provider: 'kimi' }],
        claudeSessions: [{ id: `${id}-claude`, name: 'Claude history', provider: 'claude' }],
        activeAiSessions: [],
        ...(quickCreateProfile ? { quickCreateProfile } : {}),
    };
}

async function openQuickCreatePage(t, options = {}) {
    const page = await browser.newPage({ viewport: { width: 360, height: 900 } });
    t.after(() => page.close());
    const firstPanel = getAiSessionsDiv(getSessionSurface('project-a', 'codex', options.profile));
    const secondPanel = getAiSessionsDiv(getSessionSurface('project-b', 'kimi'));

    await page.setContent(`<!doctype html>
        <html>
            <head>${options.withStyles ? `<style>${captionStyleRules}</style>` : ''}</head>
            <body class="steward-sidebar">
                <div class="steward-sticky-header"></div>
                <div class="sticky-groups-wrapper">
                    <div class="open-current-workspace-group">
                        <div class="project workspace-card" data-id="project-a" data-current-workspace
                            data-workspace-scope-identity="scope-project-a"
                            data-workspace-navigation-identity="navigation-project-a">${firstPanel}</div>
                    </div>
                    <div class="project workspace-card" data-id="project-b"
                        data-workspace-navigation-identity="navigation-project-b">${secondPanel}</div>
                </div>
                <button type="button" id="outside">Outside</button>
                ${getAiSessionCreateDropdown()}
            </body>
        </html>`);
    await page.evaluate(() => {
        window.__postedMessages = [];
        window.normalizeDashboardSearchCatalog = catalog => catalog;
        window.vscode = {
            getState: () => undefined,
            setState: () => undefined,
            postMessage: message => window.__postedMessages.push(message),
        };
    });
    await page.addScriptTag({ content: scrollStateScript });
    await page.addScriptTag({ content: viewStateScript });
    await page.addScriptTag({ content: workspaceUpdateScript });
    await page.addScriptTag({ content: todoGroupScript });
    await page.addScriptTag({ content: projectCollapseScript });
    await page.addScriptTag({ content: todoControlScript });
    await page.addScriptTag({ content: projectContextMenuScript });
    await page.addScriptTag({ content: projectAiUpdateScript });
    await page.addScriptTag({ content: aiSessionControlsScript });
    await page.addScriptTag({ content: projectScript });
    await page.evaluate(() => {
        initProjects();
        window.__postedMessages.length = 0;
    });
    return page;
}

function postedMessages(page) {
    return page.evaluate(() => window.__postedMessages);
}

test('AI-SESSION-QUICK-CREATE-001 the quick button posts a quick-create for the card provider', async t => {
    const page = await openQuickCreatePage(t);
    const project = page.locator('.project[data-id="project-a"]');
    const quickButton = project.locator('[data-action="create-ai-session-quick"]');

    assert.equal(await quickButton.getAttribute('data-provider'), 'codex');
    assert.equal(await quickButton.getAttribute('aria-label'), 'New Codex session');

    await quickButton.click();
    assert.deepEqual(await postedMessages(page), [{
        type: 'create-ai-session-quick',
        projectId: 'project-a',
        provider: 'codex',
    }]);

    const kimiQuickButton = page.locator('.project[data-id="project-b"] [data-action="create-ai-session-quick"]');
    assert.equal(await kimiQuickButton.getAttribute('aria-label'), 'New Kimi session');
    await kimiQuickButton.click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'create-ai-session-quick',
        projectId: 'project-b',
        provider: 'kimi',
    });
});

test('AI-SESSION-QUICK-CREATE-001 the split button arrow opens the create dropdown without posting', async t => {
    const page = await openQuickCreatePage(t);
    const dropdown = page.locator('#aiSessionCreateDropdown');

    assert.equal(await dropdown.evaluate(element => element.classList.contains('visible')), false);

    await page.locator('.project[data-id="project-a"] [data-action="create-ai-session-dropdown"]').click();

    assert.equal(await dropdown.evaluate(element => element.classList.contains('visible')), true);
    assert.equal(await dropdown.getAttribute('data-dropdown-project-id'), 'project-a');
    assert.deepEqual(await postedMessages(page), [], 'opening the menu must not create a session');
    const box = await dropdown.boundingBox();
    assert.ok(box && box.width > 0 && box.height > 0, 'the open dropdown is laid out');
});

test('AI-SESSION-QUICK-CREATE-001 dropdown provider items quick-create for the originating project', async t => {
    const page = await openQuickCreatePage(t);
    const dropdown = page.locator('#aiSessionCreateDropdown');

    await page.locator('.project[data-id="project-b"] [data-action="create-ai-session-dropdown"]').click();
    await dropdown.locator('[data-action="create-ai-session-quick"][data-provider="claude"]').click();

    assert.deepEqual(await postedMessages(page), [{
        type: 'create-ai-session-quick',
        projectId: 'project-b',
        provider: 'claude',
    }], 'the menu item targets the project whose arrow opened the menu, not its own provider');
    assert.equal(await dropdown.evaluate(element => element.classList.contains('visible')), false,
        'choosing an item closes the dropdown');
});

test('AI-SESSION-QUICK-CREATE-001 the dropdown keeps the full interactive creation entry', async t => {
    const page = await openQuickCreatePage(t);
    const dropdown = page.locator('#aiSessionCreateDropdown');

    await page.locator('.project[data-id="project-a"] [data-action="create-ai-session-dropdown"]').click();
    await dropdown.locator('[data-action="create-ai-session"]').click();

    assert.deepEqual(await postedMessages(page), [{
        type: 'create-ai-session',
        projectId: 'project-a',
    }]);
    assert.equal(await dropdown.evaluate(element => element.classList.contains('visible')), false);
});

test('AI-SESSION-QUICK-CREATE-001 outside clicks close the dropdown without posting', async t => {
    const page = await openQuickCreatePage(t);
    const dropdown = page.locator('#aiSessionCreateDropdown');

    await page.locator('.project[data-id="project-a"] [data-action="create-ai-session-dropdown"]').click();
    assert.equal(await dropdown.evaluate(element => element.classList.contains('visible')), true);

    await page.locator('#outside').click();
    assert.equal(await dropdown.evaluate(element => element.classList.contains('visible')), false);
    assert.deepEqual(await postedMessages(page), []);
});

test('AI-SESSION-QUICK-CREATE-001 the hover caption identifies the quick-create provider and profile', async t => {
    const page = await openQuickCreatePage(t, { profile: 'deepseek', withStyles: true });
    const project = page.locator('.project[data-id="project-a"]');
    const quickButton = project.locator('[data-action="create-ai-session-quick"]');
    const caption = project.locator('.ai-session-create-caption');
    const captionOpacity = () => caption.evaluate(
        element => parseFloat(getComputedStyle(element).opacity)
    );

    assert.equal(await caption.textContent(), 'Codex · deepseek');
    assert.equal(await caption.getAttribute('aria-hidden'), 'true');
    assert.equal(await quickButton.getAttribute('aria-label'),
        'New Codex session with profile deepseek');
    assert.equal(await captionOpacity(), 0, 'the caption stays hidden until hover or focus');

    await quickButton.hover();
    await page.waitForFunction(
        element => parseFloat(getComputedStyle(element).opacity) === 1,
        await caption.elementHandle()
    );

    await page.mouse.move(10, 400);
    await page.waitForFunction(
        element => parseFloat(getComputedStyle(element).opacity) === 0,
        await caption.elementHandle()
    );

    await quickButton.focus();
    await page.waitForFunction(
        element => parseFloat(getComputedStyle(element).opacity) === 1,
        await caption.elementHandle()
    );

    const kimiCaption = page.locator('.project[data-id="project-b"] .ai-session-create-caption');
    assert.equal(await kimiCaption.textContent(), 'Kimi',
        'providers without a profile caption the provider name alone');
});

test('AI-SESSION-QUICK-CREATE-001 the arrow toggles the dropdown and mirrors aria-expanded', async t => {
    const page = await openQuickCreatePage(t);
    const arrow = page.locator('.project[data-id="project-a"] [data-action="create-ai-session-dropdown"]');
    const dropdown = page.locator('#aiSessionCreateDropdown');

    assert.equal(await arrow.getAttribute('aria-haspopup'), 'menu');
    assert.equal(await arrow.getAttribute('aria-expanded'), 'false');

    await arrow.click();
    assert.equal(await dropdown.evaluate(element => element.classList.contains('visible')), true);
    assert.equal(await arrow.getAttribute('aria-expanded'), 'true');

    await arrow.click();
    assert.equal(await dropdown.evaluate(element => element.classList.contains('visible')), false,
        'a second click on the opening arrow closes its menu');
    assert.equal(await arrow.getAttribute('aria-expanded'), 'false');
    assert.deepEqual(await postedMessages(page), []);
});

test('AI-SESSION-QUICK-CREATE-001 the dropdown is fully keyboard operable', async t => {
    const page = await openQuickCreatePage(t);
    const project = page.locator('.project[data-id="project-b"]');
    const arrow = project.locator('[data-action="create-ai-session-dropdown"]');
    const dropdown = page.locator('#aiSessionCreateDropdown');
    const items = dropdown.locator('[role="menuitem"]');

    await arrow.focus();
    await arrow.press('Enter');
    assert.equal(await dropdown.evaluate(element => element.classList.contains('visible')), true,
        'Enter on the arrow opens the menu');
    assert.equal(await items.nth(0).evaluate(element => document.activeElement === element), true,
        'focus lands on the first menu item when the menu opens');

    await items.nth(0).press('ArrowDown');
    assert.equal(await items.nth(1).evaluate(element => document.activeElement === element), true);
    await items.nth(1).press('End');
    assert.equal(await items.nth(3).evaluate(element => document.activeElement === element), true,
        'End jumps to the interactive entry');
    await items.nth(3).press('ArrowDown');
    assert.equal(await items.nth(0).evaluate(element => document.activeElement === element), true,
        'roving focus wraps around');

    await items.nth(0).press('ArrowDown');
    await items.nth(1).press('Enter');
    assert.deepEqual(await postedMessages(page), [{
        type: 'create-ai-session-quick',
        projectId: 'project-b',
        provider: 'kimi',
    }], 'Enter activates the focused provider item for the originating project');
    assert.equal(await dropdown.evaluate(element => element.classList.contains('visible')), false);

    await arrow.press('Enter');
    await items.nth(0).press('Escape');
    assert.equal(await dropdown.evaluate(element => element.classList.contains('visible')), false,
        'Escape closes the menu');
    assert.equal(await arrow.evaluate(element => document.activeElement === element), true,
        'Escape restores focus to the arrow that opened the menu');
    assert.equal(await arrow.getAttribute('aria-expanded'), 'false');
    assert.deepEqual(await postedMessages(page), [{
        type: 'create-ai-session-quick',
        projectId: 'project-b',
        provider: 'kimi',
    }], 'Escape posts nothing');
});
