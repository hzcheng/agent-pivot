'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createFakeVscode } = require('../../helpers/fakeVscode');
const { loadFreshWithFakeVscode } = require('../../helpers/runtimeContract');
const { DashboardStartupController } = require('../../../out/dashboard/startupController');

function makeStartupController(migrateDataIfNeeded, events) {
    return new DashboardStartupController({
        stewardInfos: {
            relevantExtensionsInstalls: { remoteSSH: false, remoteContainers: false },
            config: { openOnStartup: 'never' },
        },
        isExtensionInstalled: () => false,
        migrateDataIfNeeded,
        refreshDashboard: async () => events.push('refresh'),
        publishOpenWorkspace: () => events.push('publish'),
        showInformationMessage: message => events.push(['information', message]),
        showErrorMessage: message => events.push(['error', message]),
        logError: (message, error) => events.push(['log', message, error]),
        showAgentPivot: () => events.push('show'),
        applyProjectColorToCurrentWindow: () => undefined,
        getReopenReason: () => 0,
        updateReopenReason: () => undefined,
        reopenNoneValue: 0,
        getWorkspaceName: () => 'fixture',
        getVisibleEditorLanguageIds: () => [],
    });
}

test('PERSIST-DASHBOARD-MIGRATION-PUBLICATION-001 copies a sole legacy project store without overwriting a populated destination', async () => {
    const values = {
        useSettings: true,
        settings: null,
        global: [{ id: 'legacy', groupName: 'Legacy', projects: [] }],
    };
    const primary = {
        get(key, fallback) {
            if (key === 'storeProjectsInSettings') return values.useSettings;
            if (key === 'projectData') return values.settings;
            return fallback;
        },
        inspect(key) {
            return key === 'storeProjectsInSettings' || key === 'projectData'
                ? { globalValue: this.get(key) }
                : undefined;
        },
        async update(key, value) {
            if (key === 'projectData') values.settings = value;
        },
    };
    const legacy = { get: (_key, fallback) => fallback, inspect: () => undefined };
    const vscode = createFakeVscode({
        workspace: {
            getConfiguration: section => section === 'agentPivot' ? primary : legacy,
        },
    });
    vscode.ConfigurationTarget = { Global: 1 };
    const ProjectService = loadFreshWithFakeVscode(
        '../../../out/services/projectService', vscode, __dirname
    ).default;
    const context = {
        globalState: {
            get: key => key === 'projects' ? values.global : undefined,
            async update(key, value) {
                if (key === 'projects') values.global = value;
            },
        },
    };
    const service = new ProjectService(context, {});

    assert.equal(await service.migrateDataIfNeeded(), true);
    assert.deepEqual(values.settings, values.global);

    values.settings = [{ id: 'settings', groupName: 'Settings', projects: [] }];
    values.global = [{ id: 'global', groupName: 'Global', projects: [] }];
    assert.equal(await service.migrateDataIfNeeded(), false);
    assert.equal(values.settings[0].id, 'settings');
});

test('PERSIST-DASHBOARD-MIGRATION-PUBLICATION-001 publishes only after successful migrated state is refreshed', async () => {
    const events = [];
    const controller = makeStartupController(async () => ({
        projects: { migrated: true },
    }), events);

    await controller.checkDataMigration(true);
    assert.deepEqual(events.map(event => Array.isArray(event) ? event[0] : event), [
        'refresh', 'publish', 'information', 'show',
    ]);
    assert.equal(events.indexOf('refresh') < events.indexOf('publish'), true);
});
