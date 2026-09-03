'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-chromium');

const { renderMachineProjectsPanel } = require('../../out/webview/webviewMachineProjectsContent');
const script = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewMachineProjectsScripts.js'),
    'utf8',
);
const projectsPanelScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewProjectsPanelScripts.js'),
    'utf8',
);
const collapseScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewProjectCollapseScripts.js'),
    'utf8',
);
const styles = fs.readFileSync(path.join(__dirname, '../../media/styles.css'), 'utf8');

function project(id, name, tags, favorite = false) {
    return {
        id, environmentId: 'host', machineId: 'machine',
        machineName: 'devbox', environmentName: 'Host', name, description: null,
        path: `vscode-remote://ssh-remote%2Bdevbox/work/${id}`,
        tags, favorite, color: null,
        searchText: `${name} ${tags.join(' ')} devbox host`.toLowerCase(),
    };
}

function markup(includeFavorite = true) {
    const api = project('api', 'API', ['active', 'api'], true);
    const worker = project('worker', 'Worker', ['active', 'worker']);
    return renderMachineProjectsPanel({
        projectCount: 2,
        tags: ['active', 'api', 'worker'],
        favorites: includeFavorite ? [api] : [],
        machines: [{
            id: 'machine', displayName: 'devbox', hostOpenable: true,
            hostProjectId: 'api',
            environments: [{
                id: 'host', machineId: 'machine', kind: 'host', displayName: 'Host',
                projects: [api, worker],
            }],
        }],
    });
}

let browser;

test.before(async () => {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
});

test.after(async () => {
    await browser.close();
});

async function openPage(t, width = 320, panelMarkup = markup()) {
    const page = await browser.newPage({ viewport: { width, height: 480 } });
    t.after(() => page.close());
    await page.setContent(`<!doctype html><style>${styles}</style>
        <button type="button" data-action="toggle-all-groups">Collapse All Groups</button>
        <main id="panel">${panelMarkup}</main>`);
    await page.evaluate(() => {
        window.messages = [];
        window.vscode = { postMessage: message => window.messages.push(message) };
    });
    await page.addScriptTag({ content: script });
    await page.addScriptTag({ content: collapseScript });
    await page.addScriptTag({ content: projectsPanelScript });
    await page.evaluate(() => {
        window.machineUi = createMachineProjectsUi();
        window.__agentPivotMachineProjects = window.machineUi;
        window.__agentPivotDashboard = { getActiveTab: () => 'projects' };
        window.machineUi.mount(document.getElementById('panel'));
        window.groupCollapse = initProjectGroupCollapse();
        window.groupCollapse.syncCollapseButton();
        document.querySelector('[data-action="toggle-all-groups"]').addEventListener(
            'click', () => window.groupCollapse.toggleAllGroups(),
        );
    });
    return page;
}

test('WEBVIEW-COLLAPSE-BUTTON-STATE-001 collapses and expands the Machine hierarchy from the Projects toolbar', async t => {
    const page = await openPage(t);
    const toggle = page.locator('[data-action="toggle-all-groups"]');

    assert.equal(await toggle.getAttribute('aria-label'), 'Collapse All Groups');
    await toggle.click();
    assert.deepEqual(await page.locator('[data-machine-disclosure]').evaluateAll(controls =>
        controls.map(control => control.getAttribute('aria-expanded'))), ['false', 'false', 'false']);
    assert.equal(await page.locator('[data-machine-row]').isVisible(), true);
    assert.equal(await toggle.getAttribute('aria-label'), 'Expand All Groups');
    await toggle.click();
    assert.deepEqual(await page.locator('[data-machine-disclosure]').evaluateAll(controls =>
        controls.map(control => control.getAttribute('aria-expanded'))), ['true', 'true', 'true']);
});

test('MACHINE-PROJECTS-FILTER-001 applies AND tags without double-counting Favorites', async t => {
    const page = await openPage(t);
    await page.click('[data-action="toggle-machine-tags"]');
    await page.check('[data-machine-tag-checkbox][value="active"]');
    await page.check('[data-machine-tag-checkbox][value="api"]');

    assert.equal(await page.textContent('[data-machine-projects-summary]'), '1 project on 1 machine');
    assert.equal(await page.locator('[data-machine-project-id="api"]:not([hidden])').count(), 2);
    assert.equal(await page.locator('[data-machine-project-id="worker"]:not([hidden])').count(), 0);

    await page.check('[data-machine-tag-checkbox][value="worker"]');
    assert.equal(await page.textContent('[data-machine-projects-summary]'), '0 projects on 0 machines');
    assert.equal(await page.locator('#machine-children-machine').isHidden(), true);
    await page.click('[data-action="clear-machine-tags"]');
    assert.equal(await page.textContent('[data-machine-projects-summary]'), '2 projects on 1 machine');
});

test('MACHINE-PROJECTS-ROW-OPEN-001 opens Project rows through the existing selected-project message', async t => {
    const page = await openPage(t);
    const row = '[data-machine-environment-row] [data-machine-project-id="api"]';

    await page.click(`${row} .machine-project-tag`);
    assert.deepEqual(await page.evaluate(() => window.messages.at(-1)), {
        type: 'selected-project', projectId: 'api', projectOpenType: 0,
    });

    await page.evaluate(() => { window.messages = []; });
    await page.click(`${row} [data-action="toggle-machine-favorite"]`);
    assert.deepEqual(await page.evaluate(() => window.messages), [{
        type: 'favorite-project', projectId: 'api',
    }]);
});

test('MACHINE-PROJECTS-HOST-NAVIGATION-001 opens a derived Host without setup or UI Bridge state', async t => {
    const page = await openPage(t);
    await page.click('[data-action="open-machine-host"]');

    assert.deepEqual(await page.evaluate(() => window.messages.at(-1)), {
        type: 'open-machine-host', machineId: 'machine', projectId: 'api',
    });
    assert.equal(await page.locator('[data-action="open-machine-host"]').isEnabled(), true);
    assert.equal(await page.getByText(/Setup|Assign|Preview|UI Bridge/).count(), 0);
});

test('MACHINE-PROJECTS-KEYBOARD-001 exposes disclosure, Host, Project, and Favorite actions to Tab', async t => {
    const page = await openPage(t);
    const tabStops = await page.locator('[data-machine-row] button').evaluateAll(buttons =>
        buttons.filter(button => button.tabIndex === 0).map(button => button.getAttribute('data-action')
            || button.getAttribute('data-machine-disclosure')));
    assert.deepEqual(tabStops, [
        'machine', 'open-machine-host', 'environment',
        'open-machine-project', 'toggle-machine-favorite',
        'open-machine-project', 'toggle-machine-favorite',
    ]);
});

test('MACHINE-PROJECTS-FOCUS-001 restores a Favorite Project to its directory row after refresh', async t => {
    const page = await openPage(t);
    await page.focus('[data-machine-favorites] [data-machine-project-id="api"] .machine-project-primary');
    await page.evaluate(nextMarkup => {
        const panel = document.getElementById('panel');
        const state = captureProjectsPanelState(panel);
        panel.innerHTML = nextMarkup;
        window.machineUi.mount(panel);
        restoreProjectsFocus(panel, state.focus);
    }, markup(false));

    assert.equal(await page.evaluate(() => {
        const active = document.activeElement;
        return active.classList.contains('machine-project-primary')
            && active.closest('[data-machine-project-row]').getAttribute('data-machine-project-id') === 'api'
            && !active.closest('[data-machine-favorites]');
    }), true);
});

test('MACHINE-PROJECTS-NARROW-001 avoids horizontal scrolling at 260px', async t => {
    const page = await openPage(t, 260);
    const geometry = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
    }));
    assert.equal(geometry.scrollWidth, geometry.clientWidth);
    assert.equal(await page.locator('[data-action="open-machine-host"]').isVisible(), true);
});
