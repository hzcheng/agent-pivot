'use strict';

// Covers the legacy ColorService surface so the changed-coverage gate can
// instrument src/services/colorService.ts (previously absent from the report).

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const { createFakeVscode } = require('../../helpers/fakeVscode');

function createHarness(options = {}) {
    const storeProjectsInSettings = options.storeProjectsInSettings ?? false;
    const storedColors = options.storedColors || [];
    const recentColorsToRemember = options.recentColorsToRemember ?? 10;
    const updates = [];
    const globalStateStore = new Map(Object.entries(options.globalState || {}));

    const configuration = {
        get: (key, defaultValue) => {
            if (key === 'storeProjectsInSettings') { return storeProjectsInSettings; }
            if (key === 'recentColorsToRemember') { return recentColorsToRemember; }
            if (key === 'recentColors') { return storedColors; }
            return defaultValue;
        },
        update: (key, value, target) => {
            updates.push({ key, value, target });
            return Promise.resolve();
        },
    };
    const fakeVscode = createFakeVscode({
        ConfigurationTarget: { Global: 1, Workspace: 2 },
        workspace: {
            workspaceFolders: undefined,
            getConfiguration: () => configuration,
        },
    });
    const context = {
        globalState: {
            get: key => globalStateStore.get(key),
            update: (key, value) => {
                if (value === undefined) {
                    globalStateStore.delete(key);
                } else {
                    globalStateStore.set(key, value);
                }
                return Promise.resolve();
            },
        },
    };

    const previousLoad = Module._load;
    let ColorService;
    try {
        // Each harness brings its own vscode fake, so the modules that capture
        // the `vscode` binding at load time must be re-required per harness.
        for (const modulePath of ['../../../out/services/colorService', '../../../out/services/baseService']) {
            delete require.cache[require.resolve(modulePath)];
        }
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') { return fakeVscode; }
            return previousLoad.call(this, request, parent, isMain);
        };
        ColorService = require('../../../out/services/colorService').default;
    } finally {
        Module._load = previousLoad;
    }
    return {
        service: new ColorService(context),
        updates,
        globalStateStore,
    };
}

test('ColorService names predefined, hex, rgb, and unknown colors', () => {
    const { service } = createHarness();

    assert.strictEqual(
        service.getColorName('var(--vscode-gitDecoration-deletedResourceForeground)'),
        'Red',
        'predefined colors keep their label',
    );
    assert.strictEqual(service.getColorName('#000000'), 'Black', 'hex colors resolve through ntc');
    assert.strictEqual(service.getColorName('ffffff'), null,
        'bare hex is rejected before ntc: colorStringToHex requires a # prefix');
    assert.strictEqual(service.getColorName('rgb(255, 255, 255)'), null,
        'ntc only parses hex inputs, so rgb strings stay unnamed');
    assert.strictEqual(service.getColorName('not-a-color'), null);
    assert.strictEqual(service.getColorName(''), null);
});

test('ColorService generates random colors from the palette or ntc', () => {
    const { service } = createHarness();

    const predefined = service.getRandomColor(true);
    assert.ok(predefined.startsWith('var(--vscode-') || /^#[0-9a-f]{6}$/i.test(predefined),
        'predefined-only random picks a predefined value');

    for (let i = 0; i < 8; i += 1) {
        assert.match(service.getRandomColor(), /^#[0-9a-f]{6}$/i, 'ntc random picks a hex color');
    }
});

test('ColorService stores recent colors in global state by default', async () => {
    const harness = createHarness();
    const { service, globalStateStore, updates } = harness;

    await service.addRecentColor('#000000');
    await service.addRecentColor('#ffffff');
    await service.addRecentColor('#000000');

    const stored = globalStateStore.get('recentColors');
    assert.deepStrictEqual(stored.map(entry => entry[0]), ['#000000', '#ffffff'],
        'latest first, duplicate names deduped');
    assert.deepStrictEqual(stored.map(entry => entry[1]), ['Black', 'White']);
    assert.strictEqual(updates.length, 0, 'settings storage stays untouched');

    await service.addRecentColor('');
    assert.strictEqual(globalStateStore.get('recentColors').length, 2, 'empty colors are ignored');
});

test('ColorService caps recent colors at the configured count', async () => {
    const { service, globalStateStore } = createHarness({ recentColorsToRemember: 2 });

    await service.addRecentColor('#000000');
    await service.addRecentColor('#ffffff');
    await service.addRecentColor('#ff0000');

    const stored = globalStateStore.get('recentColors');
    assert.strictEqual(stored.length, 2);
    assert.deepStrictEqual(stored.map(entry => entry[0]), ['#ff0000', '#ffffff']);
});

test('ColorService uses the settings storage when configured', async () => {
    const { service, updates, globalStateStore } = createHarness({
        storeProjectsInSettings: true,
        storedColors: [['#000000', 'Black']],
    });

    assert.deepStrictEqual(service.getRecentColors(), [['#000000', 'Black']],
        'recent colors read from settings');

    await service.saveColors([['#ffffff', 'White']]);
    assert.deepStrictEqual(updates, [{ key: 'recentColors', value: [['#ffffff', 'White']], target: 1 }],
        'settings storage writes target the Global scope');
    assert.strictEqual(globalStateStore.size, 0, 'global state stays untouched');
});
