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
        favorite: true, color: '#ef4444', searchText: 'api backend', openable: true,
    };
    return {
        revisionId: `revision:${'a'.repeat(64)}`,
        lifecycle: 'active',
        projectCount: 1,
        tags: ['Backend'],
        favorites: [project],
        machines: [{
            id: 'machine:build', name: 'Build', endpoint: 'dev@build.example.com:22022',
            connection: { kind: 'ssh', host: 'build.example.com', user: 'dev', port: 22022 },
            projectCount: 1, openable: true,
            conflict: false,
            environments: [{
                id: 'environment:host', machineId: 'machine:build', kind: 'host', name: 'Host',
                projects: [project], openable: true, conflict: false,
            }],
        }],
    };
}

test('MANAGED-REMOTE-MANAGEMENT-003 renders Save Current Project and no hand-authored Project creation action', () => {
    const html = renderManagedRemoteProjectsPanel(model());
    assert.match(html, /data-managed-operation="addMachine"/);
    assert.doesNotMatch(html, /beginMigration|>Migrate</u);
    assert.match(html, /data-action="save-current-project"/);
    assert.doesNotMatch(html, /data-managed-operation="addProject"/);
    assert.match(html, /data-managed-operation="editMachine"/);
    assert.match(html, /data-action="show-edit-machine-form" data-managed-target-id="machine:build"/u);
    assert.match(html, /Changing this connection affects 1 Project\./u);
    assert.match(html, /data-managed-operation="removeMachine"/);
    assert.match(html, /data-managed-operation="editProject"/);
    assert.match(html, /data-managed-operation="removeProject"/);
    assert.doesNotMatch(html, /Move Project/);
    assert.match(html, /dev@build\.example\.com:22022/);
    assert.doesNotMatch(html, /class="managed-machine-endpoint"/u);
    assert.match(html, /title="Build — dev@build\.example\.com:22022"/u);
});

test('MANAGED-REMOTE-MANAGEMENT-003 disables Save Current Project without an open workspace', () => {
    const html = renderManagedRemoteProjectsPanel(model(), undefined, false);
    assert.match(html, /data-action="save-current-project"[^>]*title="Open a project before saving it"[^>]* disabled/u);
});

test('MANAGED-REMOTE-MANAGEMENT-003 keeps unavailable Favorite identity and reason in its name', () => {
    const unavailable = model();
    unavailable.lifecycle = 'disabled';
    unavailable.favorites[0].openable = false;
    unavailable.favorites[0].unavailableReason = 'The Managed Machine catalog is unavailable.';
    const html = renderManagedRemoteProjectsPanel(unavailable);
    assert.match(html, /Favorite shortcut to API, on Build \(dev@build\.example\.com:22022\), Host\. Unavailable: The Managed Machine catalog is unavailable\./);
    assert.match(html, /<fieldset[^>]+data-machine-tag-popover/);
    assert.match(html, /Match all selected tags/);
    assert.match(html, /machine-project-color/);
});

test('MANAGED-REMOTE-CLIENT-ENABLE-001 keeps an unavailable catalog free of a local enable button', () => {
    const html = renderManagedRemoteProjectsPanel(model());
    assert.doesNotMatch(html, /data-managed-client-action="enable"/u);
    assert.doesNotMatch(html, /beginMigration|>Migrate</u);
});

test('MANAGED-REMOTE-CLIENT-ENABLE-001 keeps local SSH projection state out of the Project product surface', () => {
    for (const clientState of [
        'enableRequired', 'applying', 'attention', 'remoteSshMissing',
    ]) {
        const current = model();
        current.lifecycle = 'active';
        current.clientState = clientState;
        current.clientMessage = 'The SSH configuration needs attention.';
        const html = renderManagedRemoteProjectsPanel(current);

        assert.doesNotMatch(html, /data-managed-client-banner/u);
        assert.doesNotMatch(
            html,
            /Enable on This Computer|Retry|Install Remote - SSH|Regenerate SSH Config/u,
        );
    }
});

test('ready managed catalog does not render a redundant status banner or disable action', () => {
    const ready = model();
    ready.lifecycle = 'active';
    ready.clientState = 'ready';
    const readyHtml = renderManagedRemoteProjectsPanel(ready);
    assert.doesNotMatch(readyHtml, /data-managed-client-banner/u);
    assert.doesNotMatch(readyHtml, /data-managed-client-action="disable"|Disable on This Computer/u);
});

test('managed catalog has no migration or rollback controls', () => {
    const ready = model();
    ready.lifecycle = 'active';
    ready.clientState = 'ready';
    const html = renderManagedRemoteProjectsPanel(ready);
    assert.doesNotMatch(html, /rollbackMigration|Roll Back Migration|beginMigration|>Migrate</u);
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
