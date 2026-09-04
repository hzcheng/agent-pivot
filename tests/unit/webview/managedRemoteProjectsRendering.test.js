'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    renderManagedRemoteProjectsPanel,
} = require('../../../out/webview/webviewManagedRemoteProjectsContent');

function model() {
    const project = {
        id: 'project:api', environmentId: 'environment:host', machineId: 'machine:build',
        machineName: 'Build', machineEndpoint: 'dev@build.example.com:22022',
        environmentName: 'Host', name: 'API', remotePath: '/work/api', tags: ['Backend'],
        favorite: true, color: '#ef4444', searchText: 'api backend', openable: false,
        unavailableReason: 'Managed Remote preview.',
    };
    return {
        revisionId: `revision:${'a'.repeat(64)}`,
        lifecycle: 'preview',
        clientState: 'preview',
        clientMessage: 'Managed Remote preview.',
        migrationPrepared: false,
        projectCount: 1,
        tags: ['Backend'],
        favorites: [project],
        machines: [{
            id: 'machine:build', name: 'Build', endpoint: 'dev@build.example.com:22022',
            connection: { kind: 'ssh', host: 'build.example.com', user: 'dev', port: 22022 },
            projectCount: 1, openable: false, unavailableReason: 'Managed Remote preview.',
            conflict: false,
            environments: [{
                id: 'environment:host', machineId: 'machine:build', kind: 'host', name: 'Host',
                projects: [project], openable: false,
                unavailableReason: 'Managed Remote preview.', conflict: false,
            }],
        }],
    };
}

test('MANAGED-REMOTE-MANAGEMENT-003 renders complete management actions and no Move Project action', () => {
    const html = renderManagedRemoteProjectsPanel(model());
    assert.match(html, /data-managed-operation="addMachine"/);
    assert.match(html, /data-managed-operation="beginMigration"/);
    assert.match(html, /data-managed-operation="addProject"/);
    assert.match(html, /data-managed-operation="editMachine"/);
    assert.match(html, /data-managed-operation="removeMachine"/);
    assert.match(html, /data-managed-operation="editProject"/);
    assert.match(html, /data-managed-operation="removeProject"/);
    assert.doesNotMatch(html, /Move Project/);
    assert.match(html, /dev@build\.example\.com:22022/);
});

test('MANAGED-REMOTE-MANAGEMENT-003 keeps unavailable Favorite identity and reason in its name', () => {
    const html = renderManagedRemoteProjectsPanel(model());
    assert.match(html, /Favorite shortcut to API, on Build \(dev@build\.example\.com:22022\), Host\. Unavailable: Managed Remote preview\./);
    assert.match(html, /<fieldset[^>]+data-machine-tag-popover/);
    assert.match(html, /Match all selected tags/);
    assert.match(html, /machine-project-color/);
});

test('MANAGED-REMOTE-CLIENT-ENABLE-001 replaces Review with local enable after migration preparation', () => {
    const value = model();
    value.migrationPrepared = true;
    const html = renderManagedRemoteProjectsPanel(value);
    assert.match(html, /data-managed-client-action="enable"/u);
    assert.doesNotMatch(html, /data-managed-operation="beginMigration"/u);
});

test('MANAGED-REMOTE-CLIENT-DISABLE-001 exposes a computer-local disable action only when ready', () => {
    const ready = model();
    ready.lifecycle = 'active';
    ready.clientState = 'ready';
    const readyHtml = renderManagedRemoteProjectsPanel(ready);
    assert.match(readyHtml, /data-managed-client-action="disable"/u);
    assert.match(readyHtml, /Disable on This Computer…/u);
    assert.doesNotMatch(renderManagedRemoteProjectsPanel(model()), /data-managed-client-action="disable"/u);
});

test('MANAGED-REMOTE-LOCAL-PROJECTION-001 keeps client-local Projects beside the active managed catalog', () => {
    const localProject = {
        id: 'local-project', environmentId: 'local-host', machineId: 'local-machine',
        machineName: 'Local', environmentName: 'Host', name: 'Notes',
        description: null, path: '/work/notes', tags: ['personal'], favorite: false,
        color: '#00ff00', searchText: 'notes personal local host',
    };
    const html = renderManagedRemoteProjectsPanel(model(), {
        projectCount: 1,
        tags: ['personal'],
        favorites: [],
        machines: [{
            id: 'local-machine', defaultName: 'Local', displayName: 'Local',
            renamed: false, hostOpenable: true, hostProjectId: 'local-project',
            environments: [{
                id: 'local-host', machineId: 'local-machine', kind: 'host',
                displayName: 'Host', projects: [localProject],
            }],
        }],
    });

    assert.match(html, /2 projects on 2 machines/u);
    assert.match(html, /data-action="open-machine-project"/u);
    assert.match(html, /data-managed-client-action="openProject"/u);
    assert.match(html, /value="personal"/u);
});
