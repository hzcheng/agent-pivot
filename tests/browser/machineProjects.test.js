'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-chromium');

const { renderMachineProjectsPanel } = require('../../out/webview/webviewMachineProjectsContent');
const {
    renderManagedRemoteProjectsPanel,
} = require('../../out/webview/webviewManagedRemoteProjectsContent');
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
        tags, favorite, color: id === 'api' ? '#c586c0' : null,
        searchText: `${name} ${tags.join(' ')} devbox host`.toLowerCase(),
    };
}

function markup(includeFavorite = true, machineOverrides = {}, managedRemoteRevisionId) {
    const api = project('api', 'API', ['active', 'api'], true);
    const worker = project('worker', 'Worker', ['active', 'worker']);
    const machineName = machineOverrides.displayName || 'devbox';
    api.machineName = machineName;
    worker.machineName = machineName;
    return renderMachineProjectsPanel({
        projectCount: 2,
        tags: ['active', 'api', 'worker'],
        favorites: includeFavorite ? [api] : [],
        machines: [{
            id: 'machine', defaultName: 'devbox', displayName: machineName,
            renamed: false, hostOpenable: true,
            hostProjectId: 'api',
            ...machineOverrides,
            environments: [{
                id: 'host', machineId: 'machine', kind: 'host', displayName: 'Host',
                projects: [api, worker],
            }],
        }],
    }, managedRemoteRevisionId);
}

function managedMarkup(clientState = 'preview', migrationPrepared = false) {
    const ready = clientState === 'ready';
    const managedProject = {
        id: 'project:managed', environmentId: 'environment:managed-host',
        machineId: 'machine:managed', machineName: 'Build',
        machineEndpoint: 'dev@build.example.com:22022', environmentName: 'Host',
        name: 'Managed API', remotePath: '/work/api', tags: ['backend'], favorite: true,
        color: '#c586c0', searchText: 'managed api backend build host', openable: ready,
        ...(ready ? {} : { unavailableReason: 'Managed Remote preview.' }),
    };
    return renderManagedRemoteProjectsPanel({
        revisionId: `revision:${'a'.repeat(64)}`,
        lifecycle: ready ? 'active' : 'preview', clientState,
        clientMessage: ready ? 'Managed connections are ready on this computer.' : 'Managed Remote preview.', projectCount: 1,
        migrationPrepared,
        tags: ['backend'], favorites: [managedProject],
        machines: [{
            id: 'machine:managed', name: 'Build', endpoint: 'dev@build.example.com:22022',
            connection: { kind: 'ssh', host: 'build.example.com', user: 'dev', port: 22022 },
            projectCount: 1, openable: ready,
            ...(ready ? {} : { unavailableReason: 'Managed Remote preview.' }),
            conflict: false,
            environments: [{
                id: 'environment:managed-host', machineId: 'machine:managed', kind: 'host',
                name: 'Host', projects: [managedProject], openable: false,
                ...(ready ? {} : { unavailableReason: 'Managed Remote preview.' }),
                conflict: false,
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
        <div id="outside-click-target">Outside</div>
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
        document.getElementById('outside-click-target').addEventListener(
            'click', event => event.stopPropagation(),
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

    assert.equal(await page.locator('[data-machine-filter-count]').textContent(), '2');
    assert.equal(await page.locator('[data-action="toggle-machine-tags"]').getAttribute('aria-label'),
        'Filter projects by tag, 2 selected');
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

    await page.click(`${row} .machine-project-color`);
    assert.deepEqual(await page.evaluate(() => window.messages.at(-1)), {
        type: 'selected-project', projectId: 'api', projectOpenType: 0,
    });

    await page.evaluate(() => { window.messages = []; });
    await page.click(`${row} [data-action="toggle-machine-favorite"]`);
    assert.deepEqual(await page.evaluate(() => window.messages), [{
        type: 'favorite-project', projectId: 'api',
    }]);
});

test('MACHINE-PROJECTS-ACTIONS-001 exposes a dismissible Project actions menu', async t => {
    const page = await openPage(t);
    const row = '[data-machine-environment-row] [data-machine-project-id="api"]';

    await page.click(`${row} [data-action="toggle-machine-project-menu"]`);
    assert.equal(await page.locator(`${row} [data-machine-project-menu]`).isVisible(), true);
    await page.click(`${row} [data-action="edit-machine-project"]`);
    assert.deepEqual(await page.evaluate(() => window.messages.at(-1)), {
        type: 'edit-project', projectId: 'api',
    });
    assert.equal(await page.locator(`${row} [data-machine-project-menu]`).isHidden(), true);

    for (const [action, expected] of [
        ['open-machine-project-current', {
            type: 'selected-project', projectId: 'api', projectOpenType: 3,
        }],
        ['color-machine-project', { type: 'color-project', projectId: 'api' }],
        ['remove-machine-project', { type: 'remove-project', projectId: 'api' }],
    ]) {
        await page.click(`${row} [data-action="toggle-machine-project-menu"]`);
        await page.click(`${row} [data-action="${action}"]`);
        assert.deepEqual(await page.evaluate(() => window.messages.at(-1)), expected);
    }

    await page.click(`${row} [data-action="toggle-machine-project-menu"]`);
    await page.click('#outside-click-target');
    assert.equal(await page.locator(`${row} [data-machine-project-menu]`).isHidden(), true);

    await page.click(`${row} [data-action="toggle-machine-project-menu"]`);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    assert.equal(await page.locator(`${row} [data-machine-project-menu]`).isHidden(), true);
});

test('MACHINE-PROJECTS-RENAME-001 exposes Rename and Reset from the Machine actions menu', async t => {
    const page = await openPage(t, 320, markup(true, {
        defaultName: 'devbox',
        displayName: 'Build Box',
        renamed: true,
    }));
    const machine = '[data-machine-row]';

    await page.click(`${machine} > .machine-row-line [data-action="toggle-machine-menu"]`);
    assert.equal(await page.getByRole('menuitem', { name: 'Rename Machine…' }).isVisible(), true);
    assert.equal(await page.getByRole('menuitem', { name: 'Reset to devbox' }).isVisible(), true);
    await page.getByRole('menuitem', { name: 'Rename Machine…' }).click();
    assert.deepEqual(await page.evaluate(() => window.messages.at(-1)), {
        type: 'rename-machine', machineId: 'machine',
    });

    await page.click(`${machine} > .machine-row-line [data-action="toggle-machine-menu"]`);
    await page.getByRole('menuitem', { name: 'Reset to devbox' }).click();
    assert.deepEqual(await page.evaluate(() => window.messages.at(-1)), {
        type: 'reset-machine-name', machineId: 'machine',
    });

    await page.focus(`${machine} > .machine-row-line [data-machine-disclosure="machine"]`);
    await page.keyboard.press('Shift+F10');
    assert.equal(await page.getByRole('menuitem', { name: 'Rename Machine…' })
        .evaluate(node => document.activeElement === node), true);
});

test('MACHINE-PROJECTS-TOOLBAR-001 keeps summary and icon actions in one compact row', async t => {
    const page = await openPage(t);
    const toolbar = page.locator('.machine-projects-toolbar');
    const summary = page.locator('[data-machine-projects-summary]');
    const tagButton = page.locator('[data-action="toggle-machine-tags"]');
    const addButton = page.locator('[data-action="add-project"]');

    assert.equal(await summary.evaluate(node =>
        node.parentElement.classList.contains('machine-projects-toolbar')), true);
    assert.equal(await tagButton.getAttribute('aria-label'), 'Filter projects by tag');
    assert.equal(await addButton.getAttribute('aria-label'), 'Add Project');
    const boxes = await Promise.all([toolbar, summary, tagButton, addButton].map(locator => locator.boundingBox()));
    assert.equal(boxes[1].y, boxes[2].y);
    assert.ok(boxes[3].x > boxes[2].x);
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

test('MACHINE-PROJECTS-KEYBOARD-001 exposes disclosure, Machine, Project, Favorite, and menu actions to the keyboard', async t => {
    const page = await openPage(t);
    const tabStops = await page.locator('[data-machine-row] button').evaluateAll(buttons =>
        buttons.filter(button => button.tabIndex === 0).map(button => button.getAttribute('data-action')
            || button.getAttribute('data-machine-disclosure')));
    assert.deepEqual(tabStops, [
        'machine', 'open-machine-host', 'toggle-machine-menu', 'environment',
        'open-machine-project', 'toggle-machine-favorite', 'toggle-machine-project-menu',
        'open-machine-project', 'toggle-machine-favorite', 'toggle-machine-project-menu',
    ]);

    const row = '[data-machine-environment-row] [data-machine-project-id="api"]';
    await page.focus(`${row} [data-action="open-machine-project"]`);
    await page.keyboard.press('Shift+F10');
    assert.equal(await page.locator(`${row} [data-action="open-machine-project-current"]`)
        .evaluate(node => document.activeElement === node), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator(`${row} [data-action="toggle-machine-project-menu"]`)
        .evaluate(node => document.activeElement === node), true);
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

test('MANAGED-REMOTE-MANAGEMENT-003 posts revisioned actions and settles after replacement', async t => {
    const page = await openPage(t, 360, managedMarkup());
    await page.click('[data-managed-operation="addMachine"]');
    const request = await page.evaluate(() => window.messages.at(-1));
    assert.equal(request.type, 'managed-remote-action');
    assert.equal(request.version, 1);
    assert.equal(request.operation, 'addMachine');
    assert.equal(request.expectedRevisionId, `revision:${'a'.repeat(64)}`);
    assert.match(request.requestId, /^managed-/);
    assert.equal(await page.locator('[data-managed-operation="addMachine"]').isDisabled(), true);

    await page.evaluate(({ html, requestId }) => {
        document.getElementById('panel').innerHTML = html;
        window.machineUi.mount(document.getElementById('panel'));
        window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'managed-remote-settlement', version: 1, requestId,
            operation: 'addMachine', status: 'applied',
        } }));
    }, { html: managedMarkup(), requestId: request.requestId });
    assert.equal(await page.locator('[data-managed-operation="addMachine"]').isEnabled(), true);
    assert.equal(await page.locator('[data-machine-projects-announcer]').textContent(),
        'Changes saved to your VS Code User settings.');
});

test('MANAGED-REMOTE-MANAGEMENT-003 starts a managed preview from the existing derived view', async t => {
    const page = await openPage(t, 360, markup(true, {}, null));
    await page.getByRole('button', { name: 'Add Managed Machine' }).click();

    const request = await page.evaluate(() => window.messages.at(-1));
    assert.equal(request.type, 'managed-remote-action');
    assert.equal(request.operation, 'addMachine');
    assert.equal(request.expectedRevisionId, null);
    assert.equal(await page.locator('[data-action="open-machine-project"]').first().isEnabled(), true);
});

test('MANAGED-REMOTE-MANAGEMENT-003 keeps row-menu focus stable while a mutation is pending', async t => {
    const page = await openPage(t, 360, managedMarkup());
    await page.click('[data-machine-row] [data-action="toggle-machine-menu"]');
    await page.getByRole('menuitem', { name: 'Edit Machine…' }).click();
    const request = await page.evaluate(() => window.messages.at(-1));
    assert.equal(request.operation, 'editMachine');
    assert.equal(await page.locator('[data-machine-row] .machine-row-primary')
        .evaluate(node => document.activeElement === node), true);

    await page.evaluate(requestId => {
        window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'managed-remote-settlement', version: 1, requestId,
            operation: 'editMachine', status: 'cancelled',
        } }));
    }, request.requestId);
    assert.equal(await page.locator('[data-machine-projects-announcer]').textContent(),
        'No changes were saved.');
});

test('MANAGED-REMOTE-SSH-COMMAND-001 sends a strict row-menu SSH identity intent', async t => {
    const page = await openPage(t, 360, managedMarkup('ready'));
    await page.click('[data-machine-row] [data-action="toggle-machine-menu"]');
    await page.getByRole('menuitem', { name: 'Copy SSH Command' }).click();

    const message = await page.evaluate(() => window.messages.at(-1));
    assert.deepEqual(Object.keys(message).sort(), [
        'action', 'expectedRevisionId', 'requestId', 'targetId', 'type', 'version',
    ]);
    assert.equal(message.type, 'managed-remote-client-action');
    assert.equal(message.action, 'copySsh');
    assert.equal(message.targetId, 'machine:managed');
    assert.equal(message.expectedRevisionId, `revision:${'a'.repeat(64)}`);
});

test('MANAGED-REMOTE-CLIENT-ENABLE-001 sends a revisioned enable intent without connection fields', async t => {
    const page = await openPage(t, 360, managedMarkup('preview', true));
    await page.getByRole('button', { name: 'Enable on This Computer' }).click();

    const message = await page.evaluate(() => window.messages.at(-1));
    assert.deepEqual(Object.keys(message).sort(), [
        'action', 'expectedRevisionId', 'requestId', 'type', 'version',
    ]);
    assert.equal(message.type, 'managed-remote-client-action');
    assert.equal(message.action, 'enable');
    assert.equal(message.expectedRevisionId, `revision:${'a'.repeat(64)}`);
});

test('MANAGED-REMOTE-NAVIGATION-001 sends Project identity instead of a remote URI', async t => {
    const page = await openPage(t, 360, managedMarkup('ready'));
    await page.locator('[data-managed-project-row]:not(.machine-favorite-row) .machine-project-primary').click();

    const message = await page.evaluate(() => window.messages.at(-1));
    assert.deepEqual(Object.keys(message).sort(), [
        'action', 'expectedRevisionId', 'requestId', 'targetId', 'type', 'version',
    ]);
    assert.equal(message.action, 'openProject');
    assert.equal(message.targetId, 'project:managed');
    assert.equal('uri' in message, false);
});

test('MANAGED-REMOTE-MANAGEMENT-003 stays within 260px with endpoint-qualified rows', async t => {
    const page = await openPage(t, 260, managedMarkup());
    const geometry = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
    }));
    assert.equal(geometry.scrollWidth, geometry.clientWidth);
    assert.equal(await page.locator('.managed-toolbar-label').first().isHidden(), true);
    assert.equal(await page.locator('.managed-machine-endpoint').isVisible(), true);
});
