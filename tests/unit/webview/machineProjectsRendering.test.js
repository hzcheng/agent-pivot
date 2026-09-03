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
            id: 'machine', displayName: 'devbox', hostOpenable: true,
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

test('MACHINE-PROJECTS-HOST-NAVIGATION-001 omits the Host action when no remote Host can be derived', () => {
    const model = viewModel();
    model.machines[0].hostOpenable = false;
    model.machines[0].hostProjectId = null;

    const html = renderMachineProjectsPanel(model);
    assert.doesNotMatch(html, /data-action="open-machine-host"/);
});
