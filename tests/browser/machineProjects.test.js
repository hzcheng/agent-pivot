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
        id: `${id}-v2`, legacyProjectId: id, environmentId: 'host', machineId: 'machine',
        machineName: 'devbox', environmentName: 'Host', name, description: null,
        path: `/work/${id}`, tags, favorite, color: null,
        searchText: `${name} ${tags.join(' ')} devbox host`.toLowerCase(), needsSetup: false,
        navigationState: 'open',
    };
}

function markup(includeFavorite = true) {
    const api = project('api', 'API', ['active', 'api'], true);
    const worker = project('worker', 'Worker', ['active', 'worker']);
    return renderMachineProjectsPanel({
        kind: 'ready', profileAvailability: 'ready', projectCount: 2,
        tags: ['active', 'api', 'worker'], favorites: includeFavorite ? [api] : [],
        report: { machineCount: 1, environmentCount: 1, projectCount: 2 },
        migrationPreview: {
            legacyGroupCount: 1, legacyProjectCount: 2, machineCount: 1,
            environmentCount: 1, devContainerCount: 0, groupTagCount: 0,
            readyProjectCount: 2, reviewProjectCount: 0,
            cannotOpenProjectCount: 0, blockingCount: 0,
            overLimitTagCount: 0, overLimitProjectCount: 0,
        },
        machines: [{
            id: 'machine', displayName: 'devbox', connectionState: 'configured',
            connectionLabel: 'SSH · devbox', hostAction: 'open',
            environments: [{
                id: 'host', machineId: 'machine', kind: 'host', displayName: 'Host',
                needsSetup: false, projects: [api, worker],
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

async function openPage(t, width = 320) {
    const page = await browser.newPage({ viewport: { width, height: 480 } });
    t.after(() => page.close());
    await page.setContent(`<!doctype html><style>${styles}</style>
        <button type="button" data-action="toggle-all-groups">Collapse All Groups</button>
        <main id="panel">${markup()}</main>`);
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

    assert.equal(await toggle.isEnabled(), true);
    assert.equal(await toggle.getAttribute('aria-label'), 'Collapse All Groups');
    await toggle.click();

    assert.deepEqual(await page.locator('[data-machine-disclosure]').evaluateAll(controls =>
        controls.map(control => control.getAttribute('aria-expanded'))), ['false', 'false', 'false']);
    assert.equal(await page.locator('[data-machine-row]').isVisible(), true,
        'Collapse All keeps the Machine row visible');
    assert.equal(await page.locator('#machine-favorites-list').getAttribute('hidden'), '');
    assert.equal(await page.locator('#machine-children-machine').getAttribute('hidden'), '');
    assert.equal(await page.locator('#environment-children-host').getAttribute('hidden'), '');
    assert.equal(await toggle.getAttribute('aria-label'), 'Expand All Groups');
    await toggle.click();
    assert.deepEqual(await page.locator('[data-machine-disclosure]').evaluateAll(controls =>
        controls.map(control => control.getAttribute('aria-expanded'))), ['true', 'true', 'true']);
    assert.equal(await page.locator('#machine-favorites-list').getAttribute('hidden'), null);
    assert.equal(await page.locator('#machine-children-machine').getAttribute('hidden'), null);
    assert.equal(await page.locator('#environment-children-host').getAttribute('hidden'), null);
    assert.equal(await toggle.getAttribute('aria-label'), 'Collapse All Groups');
    await page.click('[data-machine-disclosure="environment"]');
    await page.click('[data-machine-disclosure="favorites"]');
    assert.equal(await toggle.getAttribute('aria-label'), 'Collapse All Groups');
    await page.click('[data-machine-disclosure="machine"]');
    assert.equal(await toggle.getAttribute('aria-label'), 'Expand All Groups',
        'individual disclosure changes keep the toolbar action synchronized');
    await page.click('[data-machine-disclosure="machine"]');
    assert.equal(await toggle.getAttribute('aria-label'), 'Collapse All Groups');
});

test('MACHINE-PROJECTS-FILTER-001 applies AND tags without double-counting Favorites', async t => {
    const page = await openPage(t);
    await page.click('[data-action="toggle-machine-tags"]');
    await page.check('[data-machine-tag-checkbox][value="active"]');
    await page.check('[data-machine-tag-checkbox][value="api"]');

    assert.equal(await page.textContent('[data-machine-projects-summary]'), '1 project on 1 machine');
    assert.equal(await page.locator('[data-machine-project-id="api-v2"]:not([hidden])').count(), 2,
        'the Favorite mirror is visible but counted once');
    assert.equal(await page.locator('[data-machine-project-id="worker-v2"]:not([hidden])').count(), 0);

    await page.check('[data-machine-tag-checkbox][value="worker"]');
    assert.equal(await page.textContent('[data-machine-projects-summary]'), '0 projects on 0 machines');
    assert.equal(await page.locator('[data-machine-row][data-zero-matches]').count(), 1);
    assert.equal(await page.locator('#machine-children-machine').isHidden(), true,
        'a zero-match Machine temporarily collapses to one row');
    await page.click('[data-action="close-machine-tags"]');
    await page.click('.machine-row-primary');
    assert.equal(await page.locator('#machine-children-machine').isHidden(), false,
        'the user can manually expand a zero-match Machine for context');

    await page.click('[data-action="clear-machine-tags"]');
    assert.equal(await page.textContent('[data-machine-projects-summary]'), '2 projects on 1 machine');
    assert.equal(await page.getAttribute('.machine-row-primary', 'aria-expanded'), 'true',
        'clearing the filter restores the pre-filter expanded state');
});

test('MACHINE-PROJECTS-KEYBOARD-001 keeps one row primary in Tab order and exposes actions with Shift+F10', async t => {
    const page = await openPage(t);
    const rowTabStops = await page.locator('[data-machine-row] > .machine-row-line').evaluate(row =>
        Array.from(row.querySelectorAll('button')).filter(button => button.tabIndex === 0)
            .map(button => button.className));
    assert.deepEqual(rowTabStops, ['machine-row-primary machine-disclosure']);

    await page.focus('.machine-row-primary');
    await page.keyboard.press('Shift+F10');
    assert.equal(await page.locator('[data-machine-row-menu]:not([hidden])').count(), 1);
    assert.deepEqual(await page.locator('[data-machine-row-menu] [role="menuitem"]').allTextContents(), [
        'Open Host on devbox in a new window',
        'Rebind connection for devbox in this VS Code',
    ]);

    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('machine-row-primary')), true);

    await page.keyboard.press('Shift+F10');
    await page.keyboard.press('Enter');
    const action = await page.evaluate(() => window.messages.at(-1));
    assert.equal(action.action, 'openHost');
    assert.equal(await page.textContent('[data-machine-connection-status]'), 'Opening a new VS Code window…');
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('machine-row-primary')), true,
        'running a row-menu action keeps the unique Tab stop focused');
    assert.equal(await page.locator('.machine-row-primary').isEnabled(), true);
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'machine-project-action-settlement', version: 1,
        requestId: message.requestId, machineId: message.machineId,
        status: 'handedOff', message: 'Finish connecting in the new window.',
    } })), action);
    assert.equal(await page.textContent('[data-machine-connection-status]'), 'Finish connecting in the new window.');
    assert.match(await page.getAttribute('[data-action="open-machine-host"]', 'aria-label'), /Open another window/);

    await page.keyboard.press('Enter');
    assert.equal(await page.getAttribute('.machine-row-primary', 'aria-expanded'), 'false');
    assert.equal(await page.locator('#machine-children-machine').isHidden(), true);
});

test('MACHINE-PROJECTS-HOST-001 renders opening, retry, and Remote - SSH install recovery states', async t => {
    const page = await openPage(t);
    const open = async () => {
        await page.click('[data-action="open-machine-host"]');
        return page.evaluate(() => window.messages.at(-1));
    };
    const settle = (message, text, status = 'failed') => page.evaluate(({ message, text, status }) => {
        window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'machine-project-action-settlement', version: 1,
            requestId: message.requestId, machineId: message.machineId,
            status, message: text,
        } }));
    }, { message, text, status });

    const first = await open();
    assert.equal(await page.textContent('[data-machine-connection-status]'), 'Opening a new VS Code window…');
    await settle(first, 'The connection action failed.');
    assert.equal(await page.textContent('[data-machine-connection-status]'), 'VS Code couldn’t start the window');
    assert.match(await page.getAttribute('[data-action="open-machine-host"]', 'aria-label'), /Retry opening/);

    const retry = await open();
    await page.evaluate(nextMarkup => {
        const panel = document.getElementById('panel');
        panel.innerHTML = nextMarkup;
        window.machineUi.mount(panel);
    }, markup());
    await settle(retry, 'Remote - SSH is required. Install it, then retry.');
    assert.equal(await page.textContent('[data-machine-connection-status]'), 'Remote - SSH is required');
    assert.equal(await page.locator('[data-action="open-machine-host"]').isVisible(), true);
    assert.match(await page.getAttribute('[data-action="open-machine-host"]', 'aria-label'), /Retry opening/);
    assert.equal(await page.locator('[data-action="open-remote-ssh-extension"]').isVisible(), true);
    await page.focus('.machine-row-primary');
    await page.keyboard.press('Shift+F10');
    assert.match((await page.locator('[data-machine-row-menu] [role="menuitem"]').allTextContents()).join('\n'), /Retry opening/);
    await page.keyboard.press('Escape');
    await page.click('[data-action="open-remote-ssh-extension"]');
    assert.equal((await page.evaluate(() => window.messages.at(-1))).type, 'open-remote-ssh-extension');

    const afterInstallRetry = await open();
    await settle(afterInstallRetry, 'Finish connecting in the new window.', 'handedOff');
    assert.equal(await page.locator('[data-action="open-remote-ssh-extension"]').isHidden(), true);
    assert.equal(await page.textContent('[data-machine-connection-status]'), 'Finish connecting in the new window.');

    const next = await open();
    await settle(next, 'Remote - SSH is required. Install it, then retry.');
    await page.evaluate(nextMarkup => {
        const panel = document.getElementById('panel');
        panel.innerHTML = nextMarkup;
        window.machineUi.mount(panel);
    }, markup());
    assert.equal(await page.locator('[data-action="open-remote-ssh-extension"]').isVisible(), true,
        'dependency recovery survives an authoritative panel refresh');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'machine-project-action-settlement', version: 1,
        requestId: 'stale-request', machineId: 'machine', status: 'handedOff',
        message: 'Finish connecting in the new window.',
    } })));
    assert.equal(await page.textContent('[data-machine-connection-status]'), 'Remote - SSH is required',
        'an uncorrelated settlement cannot overwrite the current recovery state');
});

test('MACHINE-PROJECTS-HOST-001 clears dependency failure after a Project retry succeeds', async t => {
    const page = await openPage(t);
    const projectSelector = '[data-machine-environment-row] [data-machine-project-id="api-v2"] .machine-project-primary';
    await page.click(projectSelector);
    const first = await page.evaluate(() => window.messages.at(-1));
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'machine-project-action-settlement', version: 1,
        requestId: message.requestId, machineId: message.machineId,
        status: 'failed', message: 'Remote - SSH is required. Install it, then retry.',
    } })), first);
    assert.equal(await page.locator('[data-action="open-remote-ssh-extension"]').isVisible(), true);

    await page.click(projectSelector);
    const retry = await page.evaluate(() => window.messages.at(-1));
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'machine-project-action-settlement', version: 1,
        requestId: message.requestId, machineId: message.machineId,
        status: 'handedOff', message: 'Opening the Project in a new window.',
    } })), retry);
    assert.equal(await page.textContent('[data-machine-connection-status]'), 'SSH · devbox');
    assert.equal(await page.locator('[data-action="open-remote-ssh-extension"]').isHidden(), true);
    assert.match(await page.getAttribute('[data-action="open-machine-host"]', 'aria-label'), /^Open Host/);
});

test('MACHINE-PROJECTS-HOST-001 exposes stale Project failures and requests authoritative refresh', async t => {
    const page = await openPage(t);
    const projectSelector = '[data-machine-environment-row] [data-machine-project-id="api-v2"] .machine-project-primary';
    await page.click(projectSelector);
    const action = await page.evaluate(() => window.messages.at(-1));
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'machine-project-action-settlement', version: 1,
        requestId: message.requestId, machineId: message.machineId,
        status: 'failed', message: 'Set up this Machine before opening its Projects.',
    } })), action);

    assert.equal(await page.textContent('[data-machine-environment-row] [data-project-open-error]'), 'Unavailable');
    assert.match(await page.getAttribute(projectSelector, 'aria-label'), /Open API on devbox, Host\. Unavailable: Set up/);
    assert.deepEqual(await page.evaluate(() => window.messages.at(-1)), {
        type: 'request-full-refresh', reason: 'machine-project-open-state-changed',
    });
});

test('MACHINE-PROJECTS-HOST-001 exposes Rebind and Project open as explicit Machine actions', async t => {
    const page = await openPage(t);
    await page.focus('.machine-row-primary');
    await page.keyboard.press('Shift+F10');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    const rebind = await page.evaluate(() => window.messages.at(-1));
    assert.equal(rebind.action, 'rebind');
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'machine-project-action-settlement', version: 1,
        requestId: message.requestId, machineId: message.machineId,
        status: 'opening', message: 'Opening a new VS Code window…',
    } })), rebind);
    assert.equal(await page.textContent('[data-machine-connection-status]'), 'Opening a new VS Code window…');
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'machine-project-action-settlement', version: 1,
        requestId: message.requestId, machineId: message.machineId,
        status: 'failed', message: 'Connection setup was not saved. Try again.',
    } })), rebind);
    assert.equal(await page.textContent('[data-machine-connection-status]'), 'Connection update wasn’t saved');
    await page.focus('.machine-row-primary');
    await page.keyboard.press('Shift+F10');
    assert.match((await page.locator('[data-machine-row-menu] [role="menuitem"]').allTextContents()).join('\n'), /Retry updating connection/);
    await page.keyboard.press('Escape');

    await page.click('[data-machine-environment-row] [data-machine-project-id="api-v2"] .machine-project-primary');
    const projectAction = await page.evaluate(() => window.messages.at(-1));
    assert.deepEqual({
        type: projectAction.type,
        action: projectAction.action,
        machineId: projectAction.machineId,
        projectId: projectAction.projectId,
        environmentId: projectAction.environmentId,
    }, {
        type: 'machine-project-action', action: 'openProject', machineId: 'machine',
        projectId: 'api', environmentId: 'host',
    });
});

test('MACHINE-PROJECTS-FOCUS-001 restores a Favorite Project to its directory row after refresh', async t => {
    const page = await openPage(t);
    await page.focus('[data-machine-favorites] [data-machine-project-id="api-v2"] .machine-project-primary');
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
            && active.closest('[data-machine-project-row]').getAttribute('data-machine-project-id') === 'api-v2'
            && !active.closest('[data-machine-favorites]');
    }), true);
});

test('MACHINE-PROJECTS-NARROW-001 avoids horizontal scrolling at 260px', async t => {
    const page = await openPage(t, 260);
    const geometry = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        machineHeight: document.querySelector('[data-machine-row] > .machine-row-line').getBoundingClientRect().height,
        environmentHeight: document.querySelector('.machine-environment-row > .machine-row-line').getBoundingClientRect().height,
        projectHeight: document.querySelector('.machine-environment-row .machine-project-row > .machine-row-line').getBoundingClientRect().height,
    }));
    assert.equal(geometry.scrollWidth, geometry.clientWidth);
    assert.equal(geometry.machineHeight, 28);
    assert.equal(geometry.environmentHeight, 26);
    assert.equal(geometry.projectHeight, 24);
    assert.equal(await page.locator('[data-machine-row] > .machine-row-line > [data-action="machine-row-menu"]').isVisible(), true,
        'the pointer menu, including Rebind, stays reachable at 260px');
    assert.equal(await page.locator('[data-machine-connection-status]').isVisible(), true);
    await page.click('[data-machine-row] > .machine-row-line > [data-action="open-machine-host"]');
    const action = await page.evaluate(() => window.messages.at(-1));
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'machine-project-action-settlement', version: 1,
        requestId: message.requestId, machineId: message.machineId,
        status: 'handedOff', message: 'Finish connecting in the new window.',
    } })), action);
    assert.equal(await page.textContent('[data-machine-connection-status]'), 'Finish connecting in the new window.');
});
