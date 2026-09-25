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
        id, groupId: 'group', environmentId: 'host', machineId: 'machine',
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

function managedMarkup(clientState = 'preview') {
    const ready = clientState === 'ready';
    const active = clientState !== 'preview';
    const managedProject = {
        id: 'project:managed', environmentId: 'environment:managed-host',
        machineId: 'machine:managed', machineName: 'Build',
        machineEndpoint: 'dev@build.example.com:22022', environmentName: 'Host',
        name: 'Managed API', remotePath: '/work/api', tags: ['backend'], favorite: true,
        color: '#c586c0', searchText: 'managed api backend build host', openable: active,
        ...(active ? {} : { unavailableReason: 'Managed Remote preview.' }),
    };
    return renderManagedRemoteProjectsPanel({
        revisionId: `revision:${'a'.repeat(64)}`,
        lifecycle: clientState === 'preview' ? 'preview' : 'active', clientState,
        clientMessage: ready ? 'Managed connections are ready on this computer.' : 'Managed Remote preview.', projectCount: 1,
        tags: ['backend'], favorites: [managedProject],
        machines: [{
            id: 'machine:managed', name: 'Build', endpoint: 'dev@build.example.com:22022',
            connection: { kind: 'ssh', host: 'build.example.com', user: 'dev', port: 22022 },
            projectCount: 1, openable: active,
            ...(active ? {} : { unavailableReason: 'Managed Remote preview.' }),
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

async function openAddMachineForm(page) {
    await page.locator('.machine-projects-toolbar [data-action="toggle-machine-menu"]').click();
    await page.locator('[data-action="show-add-machine-form"]').click();
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
        const storage = new Map();
        Object.defineProperty(window, 'sessionStorage', {
            configurable: true,
            value: {
                getItem: key => storage.has(key) ? storage.get(key) : null,
                setItem: (key, value) => storage.set(key, String(value)),
                removeItem: key => storage.delete(key),
            },
        });
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
        controls.map(control => control.getAttribute('aria-expanded'))), ['false', 'false']);
    assert.equal(await page.locator('[data-machine-row]').isVisible(), true);
    assert.equal(await toggle.getAttribute('aria-label'), 'Expand All Groups');
    await toggle.click();
    assert.deepEqual(await page.locator('[data-machine-disclosure]').evaluateAll(controls =>
        controls.map(control => control.getAttribute('aria-expanded'))), ['true', 'true']);
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

test('MACHINE-PROJECTS-FILTER-001 persists removal of tags no longer in the catalog', async t => {
    const page = await openPage(t);
    await page.click('[data-action="toggle-machine-tags"]');
    await page.check('[data-machine-tag-checkbox][value="worker"]');
    await page.evaluate(nextMarkup => {
        const panel = document.getElementById('panel');
        panel.innerHTML = nextMarkup;
        const removed = panel.querySelector('[data-machine-tag-checkbox][value="worker"]');
        if (removed) removed.closest('label').remove();
        window.machineUi.mount(panel);
    }, markup());

    assert.equal(await page.evaluate(() =>
        window.sessionStorage.getItem('machineProjects.selectedTags.v1')), '[]');
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
    await page.click(`${row} [data-action="show-edit-local-project-form"]`);
    assert.equal(await page.locator(`${row} [data-local-project-form]`).isVisible(), true);
    assert.deepEqual(await page.evaluate(() => window.messages), []);
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

test('MACHINE-PROJECTS-ACTIONS-001 edits a local Favorite Project inline and preserves its draft', async t => {
    const page = await openPage(t, 360, markup());
    const favorite = page.locator('.machine-favorite-row[data-machine-project-id="api"]');
    const directory = page.locator('[data-machine-environment-row] [data-machine-project-id="api"]');
    const favoriteForm = favorite.locator('[data-local-project-form]');
    const directoryForm = directory.locator('[data-local-project-form]');

    await favorite.locator('[data-action="toggle-machine-project-menu"]').click();
    // DASHBOARD-OVERFLOW-MENUS-001: actual local project actions share menu chrome.
    const menuMetrics = await favorite.locator('[data-machine-project-menu]').evaluate(menu => ({
        radius: getComputedStyle(menu).borderRadius,
        icons: Array.from(menu.querySelectorAll('[role="menuitem"]')).map(item =>
            getComputedStyle(item, '::before').maskImage),
        separators: menu.querySelectorAll('[role="separator"]').length,
    }));
    assert.equal(menuMetrics.radius, '12px');
    assert.equal(menuMetrics.icons.every(icon => icon !== 'none'), true);
    assert.equal(menuMetrics.separators, 2, 'separate opening, editing and removal');

    await favorite.getByRole('menuitem', { name: 'Edit…' }).click();
    assert.equal(await favoriteForm.isVisible(), true);
    assert.equal(await directoryForm.isHidden(), true);
    assert.equal(await favoriteForm.locator('input[name="name"]').inputValue(), 'API');
    assert.equal(await favoriteForm.locator('input[name="tags"]').inputValue(), 'active, api');

    await favoriteForm.locator('input[name="name"]').fill('Discarded draft');
    await favoriteForm.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await favoriteForm.isHidden(), true);
    assert.equal(await favorite.locator('.machine-project-primary')
        .evaluate(node => document.activeElement === node), true);

    await favorite.locator('[data-action="toggle-machine-project-menu"]').click();
    await favorite.getByRole('menuitem', { name: 'Edit…' }).click();
    await favoriteForm.locator('input[name="name"]').fill('');
    await favoriteForm.evaluate(node => { node.noValidate = true; node.requestSubmit(); });
    assert.equal(await favoriteForm.locator('[data-local-project-form-error]').textContent(),
        'Enter a Project name.');

    await favoriteForm.locator('input[name="name"]').fill('API 2');
    await favoriteForm.locator('textarea[name="description"]').fill('Updated API');
    await favoriteForm.locator('input[name="tags"]').fill('backend, api');
    await page.evaluate(html => {
        const panel = document.getElementById('panel');
        const state = captureProjectsPanelState(panel);
        panel.innerHTML = html;
        window.machineUi.mount(panel);
        restoreProjectsFocus(panel, state.focus);
        window.machineUi.restoreManagedMachineFormState(state.managedMachineForm);
    }, markup());
    assert.equal(await favoriteForm.isVisible(), true);
    assert.equal(await favoriteForm.locator('input[name="name"]').inputValue(), 'API 2');
    await favoriteForm.evaluate(node => node.requestSubmit());
    const request = await page.evaluate(() => window.messages.at(-1));
    assert.deepEqual(request, {
        type: 'save-project-inline', version: 1, requestId: request.requestId,
        projectId: 'api', groupId: 'group', name: 'API 2',
        description: 'Updated API', tags: 'backend, api',
    });
    assert.match(request.requestId, /^machine-project-inline-/);
    assert.equal(await favoriteForm.locator('button[type="submit"]').isDisabled(), true);

    await page.evaluate(html => {
        const panel = document.getElementById('panel');
        const state = captureProjectsPanelState(panel);
        panel.innerHTML = html;
        window.machineUi.mount(panel);
        restoreProjectsFocus(panel, state.focus);
        window.machineUi.restoreManagedMachineFormState(state.managedMachineForm);
    }, markup());
    assert.equal(await favoriteForm.locator('button[type="submit"]').isDisabled(), true,
        'a pending local save must remain disabled through replacement');
    await page.evaluate(requestId => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'project-inline-edit-settlement', version: 1, requestId,
        projectId: 'api', status: 'saved',
    } })), request.requestId);
    assert.equal(await favoriteForm.isHidden(), true);
    assert.equal(await favorite.locator('.machine-project-primary')
        .evaluate(node => document.activeElement === node), true);
});

test('MACHINE-PROJECTS-RENAME-001 exposes Rename and Reset from the Machine actions menu', async t => {
    const page = await openPage(t, 320, markup(true, {
        defaultName: 'devbox',
        displayName: 'Build Box',
        renamed: true,
    }));
    const machine = '[data-machine-row]';

    await page.click(`${machine} > .machine-row-line [data-action="toggle-machine-menu"]`);
    assert.equal(await page.getByRole('menuitem', { name: 'Rename…' }).isVisible(), true);
    assert.equal(await page.getByRole('menuitem', { name: 'Reset name' }).isVisible(), true);
    await page.getByRole('menuitem', { name: 'Rename…' }).click();
    assert.deepEqual(await page.evaluate(() => window.messages.at(-1)), {
        type: 'rename-machine', machineId: 'machine',
    });

    await page.click(`${machine} > .machine-row-line [data-action="toggle-machine-menu"]`);
    await page.getByRole('menuitem', { name: 'Reset name' }).click();
    assert.deepEqual(await page.evaluate(() => window.messages.at(-1)), {
        type: 'reset-machine-name', machineId: 'machine',
    });

    await page.focus(`${machine} > .machine-row-line [data-machine-disclosure="machine"]`);
    await page.keyboard.press('Shift+F10');
    assert.equal(await page.getByRole('menuitem', { name: 'Rename…' })
        .evaluate(node => document.activeElement === node), true);
});

test('MACHINE-PROJECTS-TOOLBAR-001 keeps summary and icon actions in one compact row', async t => {
    const page = await openPage(t);
    const toolbar = page.locator('.machine-projects-toolbar');
    const summary = page.locator('[data-machine-projects-summary]');
    const tagButton = page.locator('[data-action="toggle-machine-tags"]');
    const saveButton = page.locator('[data-action="save-current-project"]');

    assert.equal(await summary.evaluate(node =>
        node.parentElement.classList.contains('machine-projects-toolbar')), true);
    assert.equal(await tagButton.getAttribute('aria-label'), 'Filter projects by tag');
    assert.equal(await saveButton.getAttribute('aria-label'), 'Save Current Project');
    const boxes = await Promise.all([toolbar, summary, tagButton, saveButton].map(locator => locator.boundingBox()));
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
        buttons.filter(button => button.tabIndex === 0 && !button.closest('[hidden]')).map(button => button.getAttribute('data-action')
            || button.getAttribute('data-machine-disclosure')));
    assert.deepEqual(tabStops, [
        'machine', 'open-machine-host', 'toggle-machine-menu',
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

test('MACHINE-PROJECTS-KEYBOARD-001 leaves focus in place when Escape has no open popover', async t => {
    const page = await openPage(t);
    const primary = page.locator('[data-machine-environment-row] [data-machine-project-id="api"] .machine-project-primary');
    await primary.focus();
    await page.keyboard.press('Escape');

    assert.equal(await primary.evaluate(node => document.activeElement === node), true);
});

test('MACHINE-PROJECTS-A11Y-001 names Favorite actions with their Project', async t => {
    const page = await openPage(t, 360, managedMarkup('ready'));
    assert.equal(await page.locator(
        '[data-managed-project-row]:not(.machine-favorite-row) [data-managed-operation="toggleFavorite"]'
    ).getAttribute('aria-label'), 'Remove Managed API from Favorites');
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

test('MACHINE-PROJECTS-FOCUS-001 restores focus to Add Machine when the focused Machine and Save action are unavailable', async t => {
    const page = await openPage(t, 360, managedMarkup('ready'));
    const emptyMarkup = renderManagedRemoteProjectsPanel({
        revisionId: `revision:${'b'.repeat(64)}`,
        lifecycle: 'active', clientState: 'ready', clientMessage: '',
        projectCount: 0, tags: [], favorites: [], machines: [],
    }, undefined, false);
    await page.focus('[data-managed-machine-row] [data-action="toggle-machine-menu"]');
    await page.evaluate(nextMarkup => {
        const panel = document.getElementById('panel');
        const state = captureProjectsPanelState(panel);
        panel.innerHTML = nextMarkup;
        window.machineUi.mount(panel);
        restoreProjectsFocus(panel, state.focus);
    }, emptyMarkup);

    assert.equal(await page.locator('.machine-projects-toolbar [data-action="toggle-machine-menu"]')
        .evaluate(node => document.activeElement === node), true);
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
    await openAddMachineForm(page);
    assert.equal(await page.locator('[data-managed-machine-form-operation="addMachine"]').isVisible(), true);
    assert.equal(await page.locator('[data-managed-machine-form-operation="addMachine"] input[name="name"]')
        .evaluate(node => document.activeElement === node), true);
    await page.locator('[data-managed-machine-form-operation="addMachine"] input[name="name"]').fill('Build');
    await page.locator('[data-managed-machine-form-operation="addMachine"] input[name="host"]').fill('build.example.com');
    await page.locator('[data-managed-machine-form-operation="addMachine"] input[name="user"]').fill('dev');
    await page.locator('[data-managed-machine-form-operation="addMachine"] input[name="port"]').fill('22022');
    await page.locator('[data-managed-machine-form-operation="addMachine"]').evaluate(form => form.requestSubmit());
    const request = await page.evaluate(() => window.messages.at(-1));
    assert.equal(request.type, 'managed-remote-action');
    assert.equal(request.version, 1);
    assert.equal(request.operation, 'addMachine');
    assert.equal(request.expectedRevisionId, `revision:${'a'.repeat(64)}`);
    assert.match(request.requestId, /^managed-/);
    assert.deepEqual(request.input, {
        name: 'Build', host: 'build.example.com', user: 'dev', port: 22022, proxyJump: null, sshConfigAlias: null,
    });
    assert.equal(await page.locator('[data-managed-operation="addMachine"]').isDisabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('[data-managed-machine-form-operation="addMachine"]').isVisible(), true,
        'Escape must not hide a form whose add request is still pending');

    await page.evaluate(({ html, requestId }) => {
        document.getElementById('panel').innerHTML = html;
        window.machineUi.mount(document.getElementById('panel'));
        window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'managed-remote-settlement', version: 1, requestId,
            operation: 'addMachine', status: 'applied',
        } }));
    }, { html: managedMarkup(), requestId: request.requestId });
    assert.equal(await page.locator('[data-managed-operation="addMachine"]').isEnabled(), true);
    assert.equal(await page.locator('[data-managed-machine-form-operation="addMachine"]').isHidden(), true,
        'a successful add must close the preserved inline form');
    assert.equal(await page.locator('.machine-projects-toolbar [data-action="toggle-machine-menu"]')
        .evaluate(node => document.activeElement === node), true,
    'the replacement panel must return focus to Add Machine after a successful add');
    assert.equal(await page.locator('[data-machine-projects-announcer]').textContent(),
        'Changes saved to your VS Code User settings.');
});

test('MANAGED-REMOTE-MANAGEMENT-003 validates inline Machine drafts before posting', async t => {
    const page = await openPage(t, 260, managedMarkup());
    await openAddMachineForm(page);
    const fieldPositions = await page.locator('[data-managed-machine-form-operation="addMachine"] input:visible').evaluateAll(inputs =>
        inputs.map(input => input.getBoundingClientRect().top),
    );
    assert.ok(fieldPositions.every((top, index) => index === 0 || top > fieldPositions[index - 1]),
        'each Machine input must occupy its own row');
    await page.locator('[data-managed-machine-form-operation="addMachine"] input[name="name"]').fill('Build');
    await page.locator('[data-managed-machine-form-operation="addMachine"] input[name="host"]').fill('not a host');
    await page.locator('[data-managed-machine-form-operation="addMachine"] input[name="user"]').fill('dev');
    await page.locator('[data-managed-machine-form-operation="addMachine"]').evaluate(form => form.requestSubmit());
    assert.equal(await page.evaluate(() => window.messages.length), 0);
    assert.equal(await page.locator('[data-managed-machine-form-operation="addMachine"] [data-managed-machine-form-error]').textContent(),
        'Enter a valid DNS name or IP address.');
    const invalidHost = page.locator('[data-managed-machine-form-operation="addMachine"] input[name="host"]');
    assert.equal(await invalidHost.getAttribute('aria-invalid'), 'true');
    assert.equal(await invalidHost.getAttribute('aria-describedby'), 'managed-add-machine-form-error');
    assert.equal(await invalidHost.evaluate(node => document.activeElement === node), true);
    const geometry = await page.locator('[data-managed-machine-form-operation="addMachine"]').evaluate(form => ({
        scrollWidth: form.scrollWidth,
        clientWidth: form.clientWidth,
    }));
    assert.equal(geometry.scrollWidth, geometry.clientWidth);
});

test('MANAGED-REMOTE-MANAGEMENT-003 keeps direct management without a migration button in the derived view', async t => {
    const page = await openPage(t, 360, markup(true, {}, null));
    assert.equal(await page.getByRole('button', { name: /Migrate/u }).count(), 0);
    await page.getByRole('button', { name: 'Add Managed Machine' }).click();

    const request = await page.evaluate(() => window.messages.at(-1));
    assert.equal(request.type, 'managed-remote-action');
    assert.equal(request.operation, 'addMachine');
    assert.equal(request.expectedRevisionId, null);
    assert.equal(await page.locator('[data-action="open-machine-project"]').first().isEnabled(), true);
});

test('MANAGED-REMOTE-MANAGEMENT-003 edits a Machine inline and restores focus after replacement', async t => {
    const page = await openPage(t, 360, managedMarkup());
    await openAddMachineForm(page);
    assert.equal(await page.locator('[data-managed-machine-form-operation="addMachine"]').isVisible(), true);
    await page.click('[data-machine-row] [data-action="toggle-machine-menu"]');
    await page.getByRole('menuitem', { name: 'Edit…' }).click();
    const form = page.locator('[data-managed-machine-form-operation="editMachine"]');
    assert.equal(await form.isVisible(), true);
    assert.equal(await page.locator('[data-managed-machine-form-operation="addMachine"]').isHidden(), true,
        'opening a Machine edit must close the Add Machine form');
    assert.equal(await form.locator('input[name="name"]').inputValue(), 'Build');
    assert.equal(await form.locator('input[name="host"]').inputValue(), 'build.example.com');
    assert.equal(await form.getByText('Changing this connection affects 1 Project.').count(), 1);
    assert.equal(await form.locator('input[name="name"]').evaluate(node => document.activeElement === node), true);
    await form.locator('input[name="name"]').fill('Cancelled draft');
    await form.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await form.isHidden(), true);
    assert.equal(await page.locator('[data-machine-row] .machine-row-primary')
        .evaluate(node => document.activeElement === node), true);

    await page.click('[data-machine-row] [data-action="toggle-machine-menu"]');
    await page.getByRole('menuitem', { name: 'Edit…' }).click();
    assert.equal(await form.locator('input[name="name"]').inputValue(), 'Build',
        'Cancel must discard an unsaved edit draft');
    await form.locator('input[name="name"]').fill('Escaped draft');
    await page.keyboard.press('Escape');
    await page.click('[data-machine-row] [data-action="toggle-machine-menu"]');
    await page.getByRole('menuitem', { name: 'Edit…' }).click();
    assert.equal(await form.locator('input[name="name"]').inputValue(), 'Build',
        'Escape must discard an unsaved edit draft');
    await form.locator('input[name="name"]').fill('Replacement draft');
    await page.evaluate(html => {
        const panel = document.getElementById('panel');
        const state = captureProjectsPanelState(panel);
        panel.innerHTML = html;
        window.machineUi.mount(panel);
        restoreProjectsFocus(panel, state.focus);
        window.machineUi.restoreManagedMachineFormState(state.managedMachineForm);
    }, managedMarkup());
    assert.equal(await form.isVisible(), true,
        'an authoritative replacement must retain an open Machine edit');
    assert.equal(await form.locator('input[name="name"]').inputValue(), 'Replacement draft');
    assert.equal(await form.locator('input[name="name"]').evaluate(node => document.activeElement === node), true);
    await form.locator('input[name="name"]').fill('Build 2');
    await form.locator('input[name="host"]').fill('next.example.com');
    await form.locator('input[name="user"]').fill('ops');
    await form.locator('input[name="port"]').fill('22023');
    await form.evaluate(node => node.requestSubmit());
    const request = await page.evaluate(() => window.messages.at(-1));
    assert.equal(request.operation, 'editMachine');
    assert.equal(request.targetId, 'machine:managed');
    assert.deepEqual(request.input, {
        name: 'Build 2', host: 'next.example.com', user: 'ops', port: 22023, proxyJump: null, sshConfigAlias: null,
    });
    assert.equal(await form.locator('button[type="submit"]').isDisabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await form.isVisible(), true, 'Escape must not hide a pending Machine edit');

    await page.evaluate(html => {
        const panel = document.getElementById('panel');
        const state = captureProjectsPanelState(panel);
        panel.innerHTML = html;
        window.machineUi.mount(panel);
        restoreProjectsFocus(panel, state.focus);
        window.machineUi.restoreManagedMachineFormState(state.managedMachineForm);
    }, managedMarkup());
    assert.equal(await form.isVisible(), true,
        'a pending edit must stay visible through an authoritative replacement');
    assert.equal(await form.locator('button[type="submit"]').isDisabled(), true);
    await page.evaluate(requestId => {
        window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'managed-remote-settlement', version: 1, requestId,
            operation: 'editMachine', status: 'applied',
        } }));
    }, request.requestId);
    assert.equal(await form.isHidden(), true,
        'a successful edit must close the preserved inline form');
    assert.equal(await page.locator('[data-machine-row] .machine-row-primary')
        .evaluate(node => document.activeElement === node), true);
});

test('MANAGED-REMOTE-MANAGEMENT-003 edits a favorite Project inline and preserves its draft', async t => {
    const page = await openPage(t, 360, managedMarkup('ready'));
    const favoriteRow = page.locator('.machine-favorite-row[data-machine-project-id="project:managed"]');
    const directoryRow = page.locator('[data-managed-project-row]:not(.machine-favorite-row)');
    const favoriteForm = favoriteRow.locator('[data-managed-project-form]');
    const directoryForm = directoryRow.locator('[data-managed-project-form]');

    await favoriteRow.locator('[data-action="toggle-machine-project-menu"]').click();
    await favoriteRow.getByRole('menuitem', { name: 'Edit…' }).click();
    assert.equal(await favoriteForm.isVisible(), true);
    assert.equal(await directoryForm.isHidden(), true,
        'editing a Favorite must open the inline form next to that Favorite');
    assert.equal(await favoriteForm.locator('input[name="name"]').inputValue(), 'Managed API');
    assert.equal(await favoriteForm.locator('input[name="remotePath"]').inputValue(), '/work/api');
    assert.equal(await favoriteForm.locator('textarea[name="description"]').inputValue(), '');
    assert.equal(await favoriteForm.locator('input[name="tags"]').inputValue(), 'backend');

    await favoriteForm.locator('input[name="name"]').fill('Discarded draft');
    await favoriteForm.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await favoriteForm.isHidden(), true);
    assert.equal(await favoriteRow.locator('.machine-project-primary')
        .evaluate(node => document.activeElement === node), true);

    await favoriteRow.locator('[data-action="toggle-machine-project-menu"]').click();
    await favoriteRow.getByRole('menuitem', { name: 'Edit…' }).click();
    assert.equal(await favoriteForm.locator('input[name="name"]').inputValue(), 'Managed API',
        'Cancel must discard an unsaved Project draft');
    await favoriteForm.locator('input[name="remotePath"]').fill('relative/path');
    await favoriteForm.evaluate(node => { node.noValidate = true; node.requestSubmit(); });
    assert.equal(await favoriteForm.locator('[data-managed-project-form-error]').textContent(),
        'Enter an absolute Project path.');
    assert.equal(await favoriteForm.locator('input[name="remotePath"]').getAttribute('aria-invalid'), 'true');

    await favoriteForm.locator('input[name="name"]').fill('Managed API 2');
    await favoriteForm.locator('input[name="remotePath"]').fill('/work/api-2');
    await favoriteForm.locator('textarea[name="description"]').fill('Deployment API');
    await favoriteForm.locator('input[name="tags"]').fill('backend, #api');
    await favoriteForm.locator('input[name="color"]').fill('#ef4444');
    await page.evaluate(html => {
        const panel = document.getElementById('panel');
        const state = captureProjectsPanelState(panel);
        panel.innerHTML = html;
        window.machineUi.mount(panel);
        restoreProjectsFocus(panel, state.focus);
        window.machineUi.restoreManagedMachineFormState(state.managedMachineForm);
    }, managedMarkup('ready'));
    assert.equal(await favoriteForm.isVisible(), true,
        'an authoritative replacement must retain the Favorite Project form');
    assert.equal(await favoriteForm.locator('input[name="name"]').inputValue(), 'Managed API 2');
    assert.equal(await favoriteForm.locator('textarea[name="description"]').inputValue(), 'Deployment API');

    await favoriteForm.evaluate(node => node.requestSubmit());
    const request = await page.evaluate(() => window.messages.at(-1));
    assert.equal(request.operation, 'editProject');
    assert.equal(request.targetId, 'project:managed');
    assert.deepEqual(request.input, {
        name: 'Managed API 2', remotePath: '/work/api-2', description: 'Deployment API',
        tags: 'backend, #api', color: '#ef4444',
    });
    assert.equal(await favoriteForm.locator('button[type="submit"]').isDisabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await favoriteForm.isVisible(), true, 'Escape must not hide a pending Project edit');

    await page.evaluate(html => {
        const panel = document.getElementById('panel');
        const state = captureProjectsPanelState(panel);
        panel.innerHTML = html;
        window.machineUi.mount(panel);
        restoreProjectsFocus(panel, state.focus);
        window.machineUi.restoreManagedMachineFormState(state.managedMachineForm);
    }, managedMarkup('ready'));
    assert.equal(await favoriteForm.isVisible(), true,
        'a pending Project edit must stay visible through an authoritative replacement');
    await page.evaluate(requestId => {
        window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'managed-remote-settlement', version: 1, requestId,
            operation: 'editProject', status: 'applied',
        } }));
    }, request.requestId);
    assert.equal(await favoriteForm.isHidden(), true);
    assert.equal(await favoriteRow.locator('.machine-project-primary')
        .evaluate(node => document.activeElement === node), true);
});

test('MANAGED-REMOTE-MANAGEMENT-003 reports an edit-specific fallback error', async t => {
    const page = await openPage(t, 360, managedMarkup());
    await page.click('[data-machine-row] [data-action="toggle-machine-menu"]');
    await page.getByRole('menuitem', { name: 'Edit…' }).click();
    const form = page.locator('[data-managed-machine-form-operation="editMachine"]');
    await form.evaluate(node => node.requestSubmit());
    const request = await page.evaluate(() => window.messages.at(-1));
    await page.evaluate(requestId => {
        window.dispatchEvent(new MessageEvent('message', { data: {
            type: 'managed-remote-settlement', version: 1, requestId,
            operation: 'editMachine', status: 'failed',
        } }));
    }, request.requestId);
    assert.equal(await form.locator('[data-managed-machine-form-error]').textContent(),
        'Unable to save Machine changes.');
});

test('MANAGED-REMOTE-SSH-COMMAND-001 sends a strict row-menu SSH identity intent', async t => {
    const page = await openPage(t, 360, managedMarkup('ready'));
    await page.click('[data-machine-row] [data-action="toggle-machine-menu"]');
    await page.getByRole('menuitem', { name: 'Copy SSH command' }).click();

    const message = await page.evaluate(() => window.messages.at(-1));
    assert.deepEqual(Object.keys(message).sort(), [
        'action', 'expectedRevisionId', 'requestId', 'targetId', 'type', 'version',
    ]);
    assert.equal(message.type, 'managed-remote-client-action');
    assert.equal(message.action, 'copySsh');
    assert.equal(message.targetId, 'machine:managed');
    assert.equal(message.expectedRevisionId, `revision:${'a'.repeat(64)}`);
});

test('MANAGED-REMOTE-CLIENT-ENABLE-001 keeps local SSH projection controls out of the Project tab', async t => {
    const page = await openPage(t, 360, managedMarkup('enableRequired'));

    assert.equal(await page.locator('[data-managed-client-banner]').count(), 0);
    assert.equal(await page.getByText(/Enable on This Computer|Retry|Install Remote - SSH/u).count(), 0);
    assert.equal(await page.locator(
        '[data-managed-project-row]:not(.machine-favorite-row) .machine-project-primary'
    ).isEnabled(), true);
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

test('MANAGED-REMOTE-NAVIGATION-001 opens the whole managed Project row through the identity protocol', async t => {
    const page = await openPage(t, 360, managedMarkup('ready'));
    await page.locator(
        '[data-managed-project-row]:not(.machine-favorite-row)'
    ).evaluate(row => row.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    const message = await page.evaluate(() => window.messages.at(-1));
    assert.equal(message.type, 'managed-remote-client-action');
    assert.equal(message.action, 'openProject');
    assert.equal(message.targetId, 'project:managed');
});

test('MANAGED-REMOTE-NAVIGATION-001 does not open a disabled managed Project row', async t => {
    const page = await openPage(t, 360, managedMarkup('preview'));
    await page.locator(
        '[data-managed-project-row]:not(.machine-favorite-row)'
    ).evaluate(row => row.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    assert.deepEqual(await page.evaluate(() => window.messages), []);
});

test('MANAGED-REMOTE-NAVIGATION-001 routes middle-click through the managed identity protocol', async t => {
    const page = await openPage(t, 360, managedMarkup('ready'));
    await page.locator(
        '[data-managed-project-row]:not(.machine-favorite-row)'
    ).evaluate(row => row.dispatchEvent(new MouseEvent('auxclick', {
        bubbles: true,
        button: 1,
    })));

    const message = await page.evaluate(() => window.messages.at(-1));
    assert.equal(message.type, 'managed-remote-client-action');
    assert.equal(message.action, 'openProject');
    assert.equal(message.targetId, 'project:managed');
});

test('MACHINE-PROJECTS-KEYBOARD-001 focuses the first enabled menu item from the More button', async t => {
    const page = await openPage(t, 360, managedMarkup('preview'));
    const trigger = page.locator('[data-managed-machine-row] [data-action="toggle-machine-menu"]');
    await trigger.focus();
    await page.keyboard.press('Enter');

    assert.equal(await page.locator('[data-action="show-edit-machine-form"]')
        .evaluate(node => document.activeElement === node), true);
    await page.keyboard.press('End');
    assert.equal(await page.locator('[data-managed-operation="removeMachine"]')
        .evaluate(node => document.activeElement === node), true);
});

test('MANAGED-REMOTE-NAVIGATION-001 lets an attention-state Project retry navigation', async t => {
    const page = await openPage(t, 360, managedMarkup('attention'));
    const project = page.locator(
        '[data-managed-project-row]:not(.machine-favorite-row) .machine-project-primary'
    );

    assert.equal(await project.isEnabled(), true);
    await project.click();

    const message = await page.evaluate(() => window.messages.at(-1));
    assert.equal(message.action, 'openProject');
    assert.equal(message.targetId, 'project:managed');
});

test('MANAGED-REMOTE-NAVIGATION-001 keeps Project identity actions available while local SSH projection self-repairs', async t => {
    for (const state of ['enableRequired', 'applying', 'remoteSshMissing']) {
        const page = await openPage(t, 360, managedMarkup(state));
        const project = page.locator(
            '[data-managed-project-row]:not(.machine-favorite-row) .machine-project-primary'
        );

        assert.equal(await project.isEnabled(), true, `${state} Project must remain actionable`);
        await project.click();

        const message = await page.evaluate(() => window.messages.at(-1));
        assert.equal(message.action, 'openProject');
        assert.equal(message.targetId, 'project:managed');
    }
});

test('MANAGED-REMOTE-MANAGEMENT-003 stays within 260px with endpoint-qualified rows', async t => {
    const page = await openPage(t, 260, managedMarkup());
    const geometry = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
    }));
    assert.equal(geometry.scrollWidth, geometry.clientWidth);
    assert.equal(await page.locator('.machine-projects-toolbar [data-action="toggle-machine-menu"]').getAttribute('aria-label'), 'Add a project or machine');
    assert.equal(await page.locator('.machine-projects-toolbar-actions [data-managed-operation="addProject"]').count(), 0);
    assert.equal(await page.locator('.managed-machine-endpoint').count(), 0);
    assert.equal(await page.locator('[data-managed-machine-row] .machine-row-primary').getAttribute('title'), 'Build — dev@build.example.com:22022');
});

test('DASHBOARD-OVERFLOW-MENUS-001 keeps local and remote menus inside narrow and short viewports', async t => {
    for (const width of [170, 360]) {
        for (const html of [markup(), managedMarkup('ready')]) {
            const page = await openPage(t, width, html);
            await page.setViewportSize({ width, height: 300 });
            const triggers = page.locator('[data-action="toggle-machine-menu"], [data-action="toggle-machine-project-menu"]');
            for (let index = 0; index < await triggers.count(); index++) {
                const trigger = triggers.nth(index);
                await trigger.click();
                const menu = trigger.locator('..').locator('[data-machine-project-menu]');
                const bounds = await menu.evaluate(el => {
                    const r = el.getBoundingClientRect();
                    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom,
                        icons: Array.from(el.querySelectorAll('[role="menuitem"]')).map(item =>
                            getComputedStyle(item, '::before').maskImage) };
                });
                assert.ok(bounds.left >= 4 && bounds.right <= width - 4, JSON.stringify(bounds));
                assert.ok(bounds.top >= 4 && bounds.bottom <= 296, JSON.stringify(bounds));
                assert.ok(bounds.icons.every(icon => icon !== 'none'));
                await page.keyboard.press('Escape');
                assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
            }
        }
    }
});

test('MANAGED-REMOTE-MANAGEMENT-003 saves jump fields and retains the selected connection method on refresh', async t => {
    const page = await openPage(t, 320, managedMarkup('ready'));
    await openAddMachineForm(page);
    const form = page.locator('[data-managed-machine-form-operation="addMachine"]');
    await form.locator('input[name="name"]').fill('Home');
    await form.locator('input[name="host"]').fill('home.internal');
    await form.locator('input[name="user"]').fill('dev');
    await form.locator('[data-managed-connection-mode]').selectOption('jump');
    await form.locator('input[name="proxyJump"]').fill('ops@bastion:2222');
    const saved = await page.evaluate(() => window.machineUi.captureManagedMachineFormState());
    assert.equal(saved.values.connectionMode, 'jump');
    await page.evaluate(state => window.machineUi.restoreManagedMachineFormState(state), saved);
    assert.equal(await form.locator('[data-managed-connection-mode]').inputValue(), 'jump');
    assert.equal(await form.locator('[data-managed-connection-fields="jump"]').isVisible(), true);
    await form.evaluate(node => node.requestSubmit());
    const request = await page.evaluate(() => window.messages.at(-1));
    assert.equal(request.input.proxyJump, 'ops@bastion:2222');
    assert.equal(request.input.sshConfigAlias, null);
    assert.equal(await page.locator('input[type="search"]').count(), 0);
});

test('MANAGED-REMOTE-MANAGEMENT-003 import and folder actions use the existing correlated protocol', async t => {
    const page = await openPage(t, 320, managedMarkup('ready'));
    await page.locator('[data-managed-operation="importMachine"]').click();
    assert.equal(await page.evaluate(() => window.messages.at(-1).operation), 'importMachine');
    await page.locator('[data-managed-operation="addProject"]').click();
    const request = await page.evaluate(() => window.messages.at(-1));
    assert.equal(request.operation, 'addProject');
    assert.equal(request.targetId, 'machine:managed');
});

test('MANAGED-REMOTE-MANAGEMENT-003 keeps icon actions aligned with the machine at minimum width', async t => {
    const page = await openPage(t, 260, managedMarkup('ready'));
    const layout = await page.locator('[data-managed-machine-row] > .machine-row-line').evaluate(row => {
        const primary = row.querySelector('.machine-row-primary').getBoundingClientRect();
        const buttons = [...row.querySelectorAll('.machine-pointer-action')];
        return buttons.map(button => {
            const rect = button.getBoundingClientRect();
            return {
                text: button.textContent.trim(),
                named: Boolean(button.getAttribute('aria-label') && button.title),
                aligned: Math.abs(rect.y + rect.height / 2 - primary.y - primary.height / 2) < 1,
                contained: rect.right <= row.getBoundingClientRect().right,
                width: rect.width,
            };
        });
    });
    assert.equal(layout.length, 3);
    for (const button of layout) {
        assert.equal(button.text, '');
        assert.equal(button.named, true);
        assert.equal(button.aligned, true);
        assert.equal(button.contained, true);
        assert.equal(button.width, layout[0].width);
    }
    const toolbar = page.locator('.machine-projects-toolbar-actions > button');
    assert.equal(await toolbar.evaluateAll(buttons => buttons.every(button => !button.textContent.trim() && button.title && button.getAttribute('aria-label'))), true);
    assert.equal(await page.locator('.machine-favorite-row .machine-project-context').isVisible(), true);
});

test('Projects connection methods preserve drafts and exclude inactive route fields', async t => {
    const page = await openPage(t, 260, managedMarkup('ready'));
    await openAddMachineForm(page);
    const form = page.locator('[data-managed-machine-form-operation="addMachine"]');
    await form.locator('[name="name"]').fill('Home');
    await form.locator('[name="host"]').fill('home.internal');
    await form.locator('[name="user"]').fill('dev');
    await form.locator('[name="connectionMode"]').selectOption('jump');
    await form.locator('[name="proxyJump"]').fill('ops@bastion');
    await form.locator('[name="connectionMode"]').selectOption('sshConfig');
    assert.equal(await form.locator('[name="proxyJump"]').isDisabled(), true);
    assert.equal(await form.locator('[data-managed-connection-fields="jump"]').isHidden(), true);
    await form.locator('[name="sshConfigAlias"]').fill('home');
    await form.evaluate(node => node.requestSubmit());
    const request = await page.evaluate(() => window.messages.at(-1));
    assert.equal(request.input.proxyJump, null);
    assert.equal(request.input.sshConfigAlias, 'home');
    await page.evaluate(requestId => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'managed-remote-settlement', version: 1, requestId, operation: 'addMachine', status: 'failed', message: 'Try again',
    } })), request.requestId);
    assert.equal(await form.locator('[name="proxyJump"]').isDisabled(), true);
    assert.equal(await form.locator('[name="sshConfigAlias"]').isEnabled(), true);
    await form.locator('[name="connectionMode"]').selectOption('jump');
    assert.equal(await form.locator('[name="proxyJump"]').inputValue(), 'ops@bastion');
});

test('Projects navigation failures stay visible and retry once with fresh correlation', async t => {
    const page = await openPage(t, 260, managedMarkup('ready'));
    const connect = page.locator('[data-managed-client-action="openMachine"]');
    await connect.click();
    assert.equal(await connect.getAttribute('aria-busy'), 'true');
    const request = await page.evaluate(() => window.messages.at(-1));
    await page.evaluate(request => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'managed-remote-client-settlement', version: 1, requestId: request.requestId,
        action: request.action, targetId: request.targetId, status: 'failed', message: 'SSH alias is missing on this computer.',
    } })), request);
    const status = page.locator('[data-machine-operation-status]');
    assert.equal(await status.isVisible(), true);
    assert.match(await status.textContent(), /SSH alias is missing/);
    assert.equal(await connect.isEnabled(), true);
    await status.getByRole('button', { name: 'Retry action' }).click();
    const retry = await page.evaluate(() => window.messages.at(-1));
    assert.notEqual(retry.requestId, request.requestId);
    assert.equal(retry.targetId, request.targetId);
    assert.equal(await connect.getAttribute('aria-busy'), 'true');
});

test('A machine without projects stays counted and offers its first folder', async t => {
    const html = renderManagedRemoteProjectsPanel({ revisionId: 'r', lifecycle: 'active', projectCount: 0, tags: [], favorites: [], machines: [{
        id: 'empty', name: 'Empty server', endpoint: 'dev@empty:22', connection: { host: 'empty', user: 'dev', port: 22 },
        projectCount: 0, openable: true, conflict: false, environments: [{ id: 'host-empty', kind: 'host', name: 'Host', projects: [], conflict: false }],
    }] });
    const page = await openPage(t, 260, html);
    assert.equal(await page.locator('[data-machine-projects-summary]').textContent(), '0 projects on 1 machine');
    assert.equal(await page.getByText('No saved projects', { exact: true }).isVisible(), true);
    await page.locator('.machine-empty-hint [data-managed-operation="addProject"]').click();
    assert.equal(await page.evaluate(() => window.messages.at(-1).targetId), 'empty');
});

test('Local and managed single Host projects share one visual tree level', async t => {
    const local = await openPage(t, 400, markup());
    const remote = await openPage(t, 400, managedMarkup('ready'));
    for (const page of [local, remote]) {
        assert.equal(await page.locator('[data-machine-disclosure="environment"]').count(), 0);
        const tree = await page.locator('.machine-host-environment > .machine-project-list').evaluate(list => ({
            margin: getComputedStyle(list).marginLeft, padding: getComputedStyle(list).paddingLeft, border: getComputedStyle(list).borderLeftWidth,
        }));
        assert.deepEqual(tree, { margin: '0px', padding: '0px', border: '0px' });
    }
});

test('Duplicate names show distinguishing paths without horizontal overflow', async t => {
    const { annotateProjectPathHints } = require('../../out/projects/machineProjectsViewModel');
    const projects = [project('one', 'API', []), project('two', 'API', [])];
    projects[0].path = '/work/one/api';
    projects[1].path = '/work/two/api';
    annotateProjectPathHints(projects, row => row.path);
    const html = renderMachineProjectsPanel({ projectCount: 2, tags: [], favorites: [], machines: [{
        id: 'machine', defaultName: 'devbox', displayName: 'devbox', renamed: false, hostOpenable: true, hostProjectId: 'one',
        environments: [{ id: 'host', machineId: 'machine', kind: 'host', displayName: 'Host', projects }],
    }] });
    const page = await openPage(t, 260, html);
    assert.deepEqual(await page.locator('.machine-project-path').allTextContents(), ['one/api', 'two/api']);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('Saving current project keeps correlated busy feedback and a visible failure retry', async t => {
    const page = await openPage(t, 260, managedMarkup('ready'));
    const save = page.locator('[data-action="save-current-project"]');
    await save.click();
    const request = await page.evaluate(() => window.messages.at(-1));
    assert.equal(request.type, 'save-current-workspace');
    assert.equal(await save.isDisabled(), true);
    assert.equal(await save.getAttribute('aria-busy'), 'true');
    await page.evaluate(request => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'save-current-workspace-result', version: 1, requestId: request.requestId + '-stale',
        projectId: request.projectId, operation: 'save-current-workspace', status: 'failed', message: 'Ignored stale result',
    } })), request);
    assert.equal(await save.isDisabled(), true);
    await page.evaluate(request => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'save-current-workspace-result', version: 1, requestId: request.requestId,
        projectId: request.projectId, operation: 'save-current-workspace', status: 'failed', message: 'Unable to save settings.',
    } })), request);
    const status = page.locator('[data-machine-operation-status]');
    assert.equal(await status.isVisible(), true);
    assert.match(await status.textContent(), /Unable to save settings/);
    assert.equal(await save.isEnabled(), true);
    await status.getByRole('button', { name: 'Retry action' }).click();
    assert.equal(await save.getAttribute('aria-busy'), 'true');
    assert.notEqual(await page.evaluate(() => window.messages.at(-1).requestId), request.requestId);
});

test('A replaced conflicted machine stays disabled when its pending folder action fails', async t => {
    const page = await openPage(t, 260, managedMarkup('ready'));
    await page.locator('[data-managed-operation="addProject"]').click();
    const request = await page.evaluate(() => window.messages.at(-1));
    await page.evaluate(html => {
        document.getElementById('panel').innerHTML = html;
        window.machineUi.mount(document.getElementById('panel'));
    }, managedMarkup('preview'));
    const folders = page.locator('[data-managed-operation="addProject"]');
    assert.equal(await folders.isDisabled(), true);
    await page.evaluate(requestId => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'managed-remote-settlement', version: 1, requestId, operation: 'addProject', status: 'failed', message: 'Connection unavailable.',
    } })), request.requestId);
    assert.equal(await folders.isDisabled(), true);
    assert.equal(await folders.getAttribute('aria-busy'), 'false');
    assert.match(await page.locator('[data-machine-operation-status]').textContent(), /Connection unavailable/);
});
