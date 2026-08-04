'use strict';

// Covers the legacy ProjectWindowColorService surface so the changed-coverage
// gate can instrument src/services/projectWindowColorService.ts (previously
// absent from the report).

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const { createFakeVscode } = require('../../helpers/fakeVscode');

function createHarness(options = {}) {
    const applyToWindow = options.applyToWindow ?? true;
    const workbenchColors = { ...(options.workbenchColors || {}) };
    const workspaceStateStore = new Map(Object.entries(options.workspaceState || {}));
    const updates = [];

    const configurationBySection = section => ({
        get: (key, defaultValue) => {
            if (section === 'workbench' && key === 'colorCustomizations') {
                return { ...workbenchColors };
            }
            if (key === 'applyProjectColorToWindow') {
                return applyToWindow;
            }
            return defaultValue;
        },
        update: (key, value, target) => {
            updates.push({ section, key, value, target });
            return Promise.resolve();
        },
    });
    const fakeVscode = createFakeVscode({
        ConfigurationTarget: { Global: 1, Workspace: 2 },
        workspace: {
            workspaceFolders: undefined,
            getConfiguration: section => configurationBySection(section),
        },
    });
    const context = {
        workspaceState: {
            get: key => workspaceStateStore.get(key),
            update: (key, value) => {
                if (value === undefined) {
                    workspaceStateStore.delete(key);
                } else {
                    workspaceStateStore.set(key, value);
                }
                return Promise.resolve();
            },
        },
    };

    const previousLoad = Module._load;
    let ProjectWindowColorService;
    try {
        // Each harness brings its own vscode fake, so the modules that capture
        // the `vscode` binding at load time must be re-required per harness.
        for (const modulePath of [
            '../../../out/services/projectWindowColorService',
            '../../../out/services/baseService',
        ]) {
            delete require.cache[require.resolve(modulePath)];
        }
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') { return fakeVscode; }
            return previousLoad.call(this, request, parent, isMain);
        };
        ProjectWindowColorService = require('../../../out/services/projectWindowColorService').default;
    } finally {
        Module._load = previousLoad;
    }
    return {
        service: new ProjectWindowColorService(context),
        updates,
        workspaceStateStore,
    };
}

test('ProjectWindowColorService normalizes hex, rgb, and variable colors', () => {
    const { service } = createHarness();

    assert.strictEqual(service.resolveWindowColor('#ABCDEF'), '#abcdef');
    assert.strictEqual(service.resolveWindowColor('#abc'), '#aabbcc');
    assert.strictEqual(service.resolveWindowColor('rgb(255, 0, 128)'), '#ff0080');
    assert.strictEqual(service.resolveWindowColor('rgb(300, 5, 16)'), '#ff0510',
        'rgb channels clamp into 0-255');
    assert.strictEqual(service.resolveWindowColor('rgba(255, 0, 128, 0.5)'), '#ff0080',
        'rgba ignores the alpha channel');
    assert.strictEqual(
        service.resolveWindowColor('var(--vscode-gitDecoration-untrackedResourceForeground)'),
        '#73c991',
        'inbuilt variables resolve to their defaults',
    );
    assert.strictEqual(service.resolveWindowColor('var(--unknown-variable)'), null);
    assert.strictEqual(service.resolveWindowColor('red'), null);
    assert.strictEqual(service.resolveWindowColor(''), null);
});

test('ProjectWindowColorService builds the aura palette customization set', () => {
    const { service } = createHarness();

    const customizations = service.getWindowColorCustomizations('#ff0080');
    const expectedKeys = [
        'activityBar.activeBackground', 'activityBar.activeBorder', 'activityBar.foreground',
        'activityBarBadge.background', 'activityBarBadge.foreground', 'commandCenter.activeBorder',
        'statusBar.background', 'statusBar.foreground', 'statusBar.noFolderBackground',
        'statusBar.debuggingBackground', 'statusBarItem.remoteBackground', 'statusBarItem.remoteForeground',
        'titleBar.activeBackground', 'titleBar.activeForeground', 'titleBar.inactiveBackground',
        'titleBar.inactiveForeground',
    ];
    assert.deepStrictEqual(Object.keys(customizations).sort(), expectedKeys.sort());
    assert.strictEqual(customizations['activityBar.activeBorder'], '#ff0080', 'the accent passes through');
    for (const [key, value] of Object.entries(customizations)) {
        assert.match(value, /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/, `${key} is a hex color`);
    }
});

test('ProjectWindowColorService syncs the window colors and keeps a backup', async () => {
    const { service, updates, workspaceStateStore } = createHarness({
        workbenchColors: { 'statusBar.background': '#123456', 'my.custom': 'keep' },
    });

    await service.syncProjectColorToCurrentWindow({ color: '#ff0080' });

    assert.strictEqual(updates.length, 1, 'one workspace configuration write');
    const write = updates[0];
    assert.strictEqual(write.section, 'workbench');
    assert.strictEqual(write.key, 'colorCustomizations');
    assert.strictEqual(write.target, 2, 'workspace target');
    assert.strictEqual(write.value['my.custom'], 'keep', 'unrelated customizations survive');
    assert.strictEqual(write.value['statusBar.background'].startsWith('#'), true);
    assert.notStrictEqual(write.value['statusBar.background'], '#123456', 'generated color replaced');

    const backup = workspaceStateStore.get('projectWindowColorBackup');
    assert.strictEqual(backup.values['statusBar.background'], '#123456', 'original value backed up');
    assert.strictEqual(backup.values['titleBar.activeBackground'], null, 'unset values backed up as null');
});

test('ProjectWindowColorService restores backed-up colors when disabled', async () => {
    const { service, updates, workspaceStateStore } = createHarness({
        applyToWindow: false,
        workbenchColors: { 'statusBar.background': '#999999', 'my.custom': 'keep' },
        workspaceState: {
            projectWindowColorBackup: { values: { 'statusBar.background': '#123456' } },
        },
    });

    await service.syncProjectColorToCurrentWindow({ color: '#ff0080' });

    assert.strictEqual(updates.length, 1, 'restore writes once');
    assert.deepStrictEqual(updates[0].value, {
        'statusBar.background': '#123456',
        'my.custom': 'keep',
    }, 'backed-up values restored');
    assert.strictEqual(workspaceStateStore.has('projectWindowColorBackup'), false, 'backup consumed');
});

test('ProjectWindowColorService skips the write when nothing would change', async () => {
    const { service, updates } = createHarness({
        applyToWindow: false,
        workbenchColors: { 'my.custom': 'keep' },
    });

    await service.restoreProjectWindowColors({ color: undefined });

    assert.strictEqual(updates.length, 0, 'no generated colors and no backup means no write');
});
