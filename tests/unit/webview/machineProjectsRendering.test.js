'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    renderMachineProjectsPanel,
} = require('../../../out/webview/webviewMachineProjectsContent');

function viewModel() {
    const project = {
        id: 'project-v2', legacyProjectId: 'project-v1', environmentId: 'host',
        machineId: 'machine', machineName: 'devbox', environmentName: 'Host',
        name: 'API <unsafe>', description: null, path: '/work/api',
        tags: ['active', 'api'], favorite: true, color: '#123456',
        searchText: 'api unsafe active devbox host', needsSetup: false,
        navigationState: 'open',
    };
    return {
        kind: 'ready', profileAvailability: 'ready', projectCount: 1,
        tags: ['active', 'api'], favorites: [project],
        report: { machineCount: 1, environmentCount: 1, projectCount: 1 },
        migrationPreview: {
            legacyGroupCount: 1, legacyProjectCount: 1, machineCount: 1,
            environmentCount: 1, devContainerCount: 0, groupTagCount: 1,
            readyProjectCount: 1, reviewProjectCount: 0,
            cannotOpenProjectCount: 0, blockingCount: 0,
            overLimitTagCount: 0, overLimitProjectCount: 0,
        },
        machines: [{
            id: 'machine', displayName: 'devbox', connectionState: 'configured',
            connectionLabel: 'SSH · devbox', hostAction: 'open',
            environments: [{
                id: 'host', machineId: 'machine', kind: 'host', displayName: 'Host',
                needsSetup: false, projects: [project],
            }],
        }],
    };
}

test('MACHINE-PROJECTS-ARIA-001 MACHINE-PROJECTS-PROJECTION-001 MACHINE-PROJECTS-KEYBOARD-001 renders native nested lists with one primary tab stop per visible row', () => {
    const html = renderMachineProjectsPanel(viewModel());

    assert.match(html, /data-machine-projects/);
    assert.match(html, /<ul class="machine-projects-machines"/);
    assert.match(html, /aria-label="Collapse devbox"/);
    assert.match(html, /aria-label="Collapse Host"/);
    assert.match(html, /aria-label="Open API &lt;unsafe&gt; on devbox, Host"/);
    assert.match(html, /data-action="open-machine-host"[^>]*tabindex="-1"/);
    assert.match(html, /data-action="machine-row-menu"[^>]*tabindex="-1"/);
    assert.doesNotMatch(html, /role="tree(?:grid)?"/);
});

test('MACHINE-PROJECTS-TAGS-001 renders an AND checkbox popover and one unique Favorite mirror', () => {
    const html = renderMachineProjectsPanel(viewModel());

    assert.match(html, /data-machine-tag-popover/);
    assert.match(html, /Matches all/);
    assert.equal((html.match(/data-machine-project-id="project-v2"/g) || []).length, 2,
        'one catalog row and one Favorite mirror render the same Project identity');
    assert.match(html, /data-machine-project-count="1"/);
    assert.doesNotMatch(html, /API <unsafe>/);
    assert.match(html, /API &lt;unsafe&gt;/);
});

test('MACHINE-PROJECTS-MIGRATION-PREVIEW-001 exposes the read-only migration summary while V1 stays active', () => {
    const html = renderMachineProjectsPanel(viewModel());

    assert.match(html, /<details class="machine-migration-preview"/);
    assert.match(html, /Migration Preview/);
    assert.match(html, /V1 remains active/);
    assert.match(html, /Ready<\/span><strong>1<\/strong>/);
    assert.match(html, /Blocking<\/span><strong>0<\/strong>/);
    assert.doesNotMatch(html, /data-action="activate-v2"/);
});

test('MACHINE-PROJECTS-MIGRATION-PREVIEW-001 exposes repair, retry, and cancel for blocking input', () => {
    const html = renderMachineProjectsPanel({
        kind: 'error', message: 'Cannot project safely',
        migrationPreview: {
            legacyGroupCount: 1, legacyProjectCount: 2, machineCount: 0,
            environmentCount: 0, devContainerCount: 0, groupTagCount: 0,
            readyProjectCount: 0, reviewProjectCount: 0,
            cannotOpenProjectCount: 0, blockingCount: 1,
            overLimitTagCount: 0, overLimitProjectCount: 0,
        },
    });
    assert.match(html, /Blocking<\/span><strong>1<\/strong>/);
    assert.match(html, /data-action="repair-machine-preview"/);
    assert.match(html, /data-action="retry-machine-preview"/);
    assert.match(html, /data-action="cancel-machine-preview"/);
});

test('MACHINE-PROJECTS-HOST-NAVIGATION-001 exposes an update action for an incompatible UI Bridge', () => {
    const model = viewModel();
    model.profileAvailability = 'unavailable';
    model.machines[0].connectionState = 'setupUnavailable';
    model.machines[0].environments[0].projects[0].navigationState = 'unavailable';
    const html = renderMachineProjectsPanel(model);

    assert.match(html, /Connection setup is unavailable/);
    assert.match(html, /data-action="open-machine-bridge">Update UI Bridge/);
    assert.match(html, /Update the Agent Pivot UI Bridge before opening the Project/);
});

test('MACHINE-PROJECTS-ARIA-001 keeps each unavailable Project identifiable and visibly disabled', () => {
    const model = viewModel();
    const api = model.machines[0].environments[0].projects[0];
    api.navigationState = 'needsConnection';
    const worker = { ...api, id: 'worker-v2', legacyProjectId: 'worker', name: 'Worker' };
    model.machines[0].environments[0].projects.push(worker);
    model.projectCount = 2;
    const html = renderMachineProjectsPanel(model);

    assert.match(html, /aria-label="Favorite shortcut to API &lt;unsafe&gt;, on devbox, Host\. Unavailable: Set up this Machine before opening the Project"/);
    assert.match(html, /aria-label="Open API &lt;unsafe&gt; on devbox, Host\. Unavailable: Set up this Machine before opening the Project"/);
    assert.match(html, /aria-label="Open Worker on devbox, Host\. Unavailable: Set up this Machine before opening the Project"/);
    assert.equal((html.match(/aria-disabled="true"/g) || []).length, 3,
        'Favorite mirror plus two directory rows expose disabled semantics');
    assert.match(html, /class="machine-project-state" data-action="setup-machine"[^>]*>Setup<\/button>/);
});

test('MACHINE-PROJECTS-ARIA-001 keeps Project identity in every unavailable state', () => {
    const expectations = [
        ['needsConnection', 'Set up this Machine before opening the Project'],
        ['unavailable', 'Update the Agent Pivot UI Bridge before opening the Project'],
        ['needsRepair', 'Repair this Environment before opening the Project'],
        ['needsAssignment', 'Assign this Project to a Machine before opening it'],
        ['previewOnly', 'Dev Container Projects are preview-only in this milestone'],
    ];
    for (const [navigationState, reason] of expectations) {
        const model = viewModel();
        model.machines[0].environments[0].projects[0].navigationState = navigationState;
        const html = renderMachineProjectsPanel(model);
        assert.match(html, new RegExp(`aria-label="Open API &lt;unsafe&gt; on devbox, Host\\. Unavailable: ${reason}`));
        assert.match(html, new RegExp(`aria-label="Favorite shortcut to API &lt;unsafe&gt;, on devbox, Host\\. Unavailable: ${reason}`));
    }
});
