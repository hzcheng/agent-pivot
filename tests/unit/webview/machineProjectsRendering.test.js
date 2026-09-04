'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { renderMachineProjectsPanel } = require('../../../out/webview/webviewMachineProjectsContent');

function viewModel() {
    const project = {
        id: 'project-v1', environmentId: 'host', machineId: 'machine',
        machineName: 'devbox', environmentName: 'Host',
        name: 'API <unsafe>', description: null,
        path: 'vscode-remote://ssh-remote%2Bdevbox/work/api',
        tags: ['active', 'api'], favorite: true, color: '#123456',
        searchText: 'api unsafe active devbox host',
    };
    return {
        projectCount: 1,
        tags: ['active', 'api'],
        favorites: [project],
        machines: [{
            id: 'machine', defaultName: 'devbox', displayName: 'devbox',
            renamed: false, hostOpenable: true,
            hostProjectId: 'project-v1',
            environments: [{
                id: 'host', machineId: 'machine', kind: 'host', displayName: 'Host',
                projects: [project],
            }],
        }],
    };
}

test('MACHINE-PROJECTS-ARIA-001 renders a plain derived hierarchy with directly openable Projects', () => {
    const html = renderMachineProjectsPanel(viewModel());

    assert.match(html, /data-machine-projects/);
    assert.match(html, /<ul class="machine-projects-machines"/);
    assert.match(html, /aria-label="Collapse devbox"/);
    assert.match(html, /aria-label="Collapse Host"/);
    assert.match(html, /data-action="open-machine-project"/);
    assert.match(html, /aria-label="Open API &lt;unsafe&gt; on devbox, Host"/);
    assert.match(html, /data-action="open-machine-host"/);
    assert.match(html, /data-action="toggle-machine-menu"/);
    assert.match(html, /data-action="rename-machine"/);
    assert.doesNotMatch(html, /data-action="reset-machine-name"/);
    assert.match(html, /data-action="toggle-machine-project-menu"/);
    assert.match(html, /data-action="edit-machine-project"/);
    assert.match(html, /data-action="color-machine-project"/);
    assert.match(html, /data-action="remove-machine-project"/);
    assert.match(html, /class="machine-project-color" style="background: #123456"/);
    assert.match(html, /aria-label="Filter projects by tag"/);
    assert.match(html, /aria-label="Add Project"/);
    assert.doesNotMatch(html, /class="machine-project-tag"/);
    assert.doesNotMatch(html, /Setup|Assign|Preview|Migration|UI Bridge|Not configured/);
});

test('MACHINE-PROJECTS-TAGS-001 renders AND tag filters and one Favorite mirror without duplicating identity counts', () => {
    const html = renderMachineProjectsPanel(viewModel());

    assert.match(html, /data-machine-tag-popover/);
    assert.match(html, /Matches all/);
    assert.equal((html.match(/data-machine-project-id="project-v1"/g) || []).length, 2);
    assert.match(html, /data-machine-project-count="1"/);
    assert.doesNotMatch(html, /API <unsafe>/);
    assert.match(html, /API &lt;unsafe&gt;/);
});

test('MACHINE-PROJECTS-HOST-NAVIGATION-001 renders the same Machine action for Local', () => {
    const model = viewModel();
    model.machines[0].displayName = 'Local';
    model.machines[0].hostOpenable = true;

    const html = renderMachineProjectsPanel(model);
    assert.match(html, /aria-label="Open Local in a new window"/);
});

test('MACHINE-PROJECTS-RENAME-001 renders the alias while preserving the connection name in its tooltip and reset action', () => {
    const model = viewModel();
    model.machines[0].displayName = 'Build Box';
    model.machines[0].renamed = true;

    const html = renderMachineProjectsPanel(model);
    assert.match(html, /title="Build Box — connection: devbox"/);
    assert.match(html, /data-action="reset-machine-name">Reset to devbox/);
});

test('MANAGED-REMOTE-MANAGEMENT-003 exposes the managed Machine entry without replacing the derived catalog', () => {
    const html = renderMachineProjectsPanel(viewModel(), null);

    assert.match(html, /data-managed-remote-projects/);
    assert.match(html, /data-managed-revision-id=""/);
    assert.match(html, /data-managed-operation="addMachine"/);
    assert.match(html, /data-managed-operation="beginMigration"/);
    assert.match(html, /data-action="open-machine-project"/);
});
