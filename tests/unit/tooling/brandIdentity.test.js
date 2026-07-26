'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    BRAND_IDENTITY,
    findStaleIdentity,
    INHERITED_ICON_SHA256,
    validateInheritedIconHashes,
    validateManifestPair,
} = require('../../../scripts/lib/brandIdentity');

const repositoryRoot = path.resolve(__dirname, '../../..');

function read(relativePath) {
    return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

function manifests() {
    return {
        main: {
            name: 'agent-pivot',
            displayName: 'Agent Pivot',
            publisher: 'hzcheng',
            version: '1.0.0',
            icon: 'media/extension_icon.png',
            repository: {
                type: 'git',
                url: 'https://github.com/hzcheng/agent-pivot.git',
            },
            homepage: 'https://github.com/hzcheng/agent-pivot#readme',
            bugs: {
                url: 'https://github.com/hzcheng/agent-pivot/issues',
            },
            license: 'MIT',
            categories: ['Other'],
            keywords: [
                'agent', 'codex', 'claude', 'kimi',
                'session manager', 'workspace', 'tmux',
            ],
            extensionDependencies: [
                'hzcheng.agent-pivot-attention-ui-bridge',
            ],
            contributes: {
                commands: [{ command: 'agentPivot.refresh' }],
                configuration: {
                    properties: {
                        'agentPivot.enableAiSessionManagement': { type: 'boolean' },
                    },
                },
                viewsContainers: {
                    activitybar: [{ id: 'agentPivot' }],
                },
                views: {
                    agentPivot: [{ id: 'agentPivot.dashboard' }],
                },
            },
        },
        bridge: {
            name: 'agent-pivot-attention-ui-bridge',
            displayName: 'Agent Pivot Attention UI Bridge',
            publisher: 'hzcheng',
            version: '1.0.0',
            icon: 'media/extension_icon.png',
            license: 'MIT',
            categories: ['Other'],
            repository: {
                type: 'git',
                url: 'https://github.com/hzcheng/agent-pivot.git',
            },
        },
    };
}

test('marketplace documentation and legal notices expose the approved identity', () => {
    assert.match(read('README.md'),
        /^# Agent Pivot$/m);
    assert.match(read('README.md'),
        /Switch, monitor, and resume Codex, Claude, and Kimi sessions/);
    assert.match(read('README.md'),
        /^## Privacy and local data$/m);
    assert.match(read('README.md'),
        /does not upload conversation content to an Agent Pivot service/);
    assert.match(read('README.md'),
        /began as a fork of Kruemelkatze\/vscode-dashboard/);
    const bridgeReadme = read('extensions/attention-ui-bridge/README.md');
    assert.match(bridgeReadme, /^# Agent Pivot Attention UI Bridge$/m);
    assert.match(bridgeReadme, /has no user-facing commands/);
    for (const value of [
        'conversation content',
        'prompts',
        'responses',
        'hostnames',
        'remote authorities',
        'absolute project paths',
    ]) {
        assert.match(bridgeReadme, new RegExp(`does not[\\s\\S]*${value}`));
    }
    assert.match(read('CHANGELOG.md'), /^## \[1\.0\.0\] - 2026-07-26$/m);
    assert.match(read('LICENSE'), /Copyright \(c\) 2026 hzcheng/);
    for (const dependency of [
        'dom-autoscroller 2.3.4',
        'dragula 3.7.3',
        'fitty 2.3.5',
        'DOMPurify 3.4.12',
        'Sharingan loading animation',
    ]) {
        assert.match(read('THIRD_PARTY_NOTICES.md'), new RegExp(dependency));
    }
    assert.equal(fs.existsSync(path.join(
        repositoryRoot, 'licenses/DOMPurify-Apache-2.0.txt'
    )), true);
});

test('brand identity exposes the exact approved public contract', () => {
    assert.deepEqual(BRAND_IDENTITY, {
        displayName: 'Agent Pivot',
        publisher: 'hzcheng',
        mainPackageName: 'agent-pivot',
        mainExtensionId: 'hzcheng.agent-pivot',
        mainVersion: '1.0.0',
        bridgePackageName: 'agent-pivot-attention-ui-bridge',
        bridgeExtensionId: 'hzcheng.agent-pivot-attention-ui-bridge',
        commandPrefix: 'agentPivot.',
        configurationSection: 'agentPivot',
        viewContainerId: 'agentPivot',
        viewId: 'agentPivot.dashboard',
        repositoryUrl: 'https://github.com/hzcheng/agent-pivot.git',
    });
});

test('manifest pair accepts only the atomic Agent Pivot identity', () => {
    const fixture = manifests();
    assert.doesNotThrow(() => validateManifestPair(fixture.main, fixture.bridge));
    for (const mutate of [
        value => { value.main.name = 'project-steward'; },
        value => { value.main.version = '2.1.8'; },
        value => { value.main.extensionDependencies[0] =
            'hzcheng.project-steward-attention-ui-bridge'; },
        value => { value.main.contributes.commands[0].command =
            'projectSteward.refresh'; },
        value => { value.main.contributes.configuration.properties =
            { 'dashboard.storeProjectsInSettings': { type: 'boolean' } }; },
        value => { value.main.contributes.viewsContainers.activitybar[0].id =
            'project-steward'; },
        value => { value.main.contributes.views.agentPivot[0].id =
            'projectSteward.steward'; },
        value => { value.bridge.name =
            'project-steward-attention-ui-bridge'; },
        value => { delete value.bridge.icon; },
    ]) {
        const changed = manifests();
        mutate(changed);
        assert.throws(
            () => validateManifestPair(changed.main, changed.bridge),
            assert.AssertionError
        );
    }
});

test('scanner rejects current stale identity and permits only reviewed history', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-brand-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs/superpowers/plans'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/current.ts'),
        "const command = 'projectSteward.refresh';\n");
    fs.writeFileSync(path.join(root, 'CHANGELOG.md'),
        '# Changelog\n\n## [1.0.0] - 2026-07-26\n\nAgent Pivot\n\n' +
        '## Unpublished Project Steward development history\n\n' +
        'Project Steward history\n');
    fs.writeFileSync(path.join(root, 'docs/superpowers/plans/history.md'),
        'project-steward design evidence\n');
    assert.deepEqual(findStaleIdentity(root), [{
        file: 'src/current.ts',
        line: 1,
        token: 'projectSteward',
        excerpt: "const command = 'projectSteward.refresh';",
    }]);
});

test('scanner does not hide stale identity in the current changelog section', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-log-'));
    fs.writeFileSync(path.join(root, 'CHANGELOG.md'),
        '# Changelog\n\n## [1.0.0] - 2026-07-26\n\nProject Steward\n\n' +
        '## Unpublished Project Steward development history\n');
    assert.deepEqual(findStaleIdentity(root).map(item => item.line), [5]);
});

test('scanner permits only the reviewed 1.0.0 identity reset note', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-release-'));
    fs.writeFileSync(path.join(root, 'CHANGELOG.md'),
        '# Changelog\n\n## [1.0.0] - 2026-07-26\n\n### Changed\n\n' +
        '- Reset the unpublished extension identity, commands, settings, state, managed\n' +
        '  runtime names, and companion bridge from Project Steward to Agent Pivot.\n\n' +
        '## Unpublished Project Steward development history\n');
    assert.deepEqual(findStaleIdentity(root), []);
});

test('scanner rejects inherited marketplace icon bytes by sha256', () => {
    assert.deepEqual(INHERITED_ICON_SHA256, [
        '7c937a29143bc743a99bdbcbfdc5d1add2fb73436fd3adbfb713595e692a454b',
        '9b4e9fb6acc807261862c2d57fbaa6f232b6a5b6739fbccec5308c890641cf8a',
    ]);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-icon-'));
    const files = [
        'media/extension_icon.png',
        'media/icon.svg',
        'extensions/attention-ui-bridge/media/extension_icon.png',
    ];
    for (const file of files) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), Buffer.from('replacement'));
    }
    assert.doesNotThrow(() => validateInheritedIconHashes(
        root, () => 'f'.repeat(64)
    ));
    for (const rejected of INHERITED_ICON_SHA256) {
        for (const target of files) {
            assert.throws(() => validateInheritedIconHashes(
                root,
                file => file.endsWith(target) ? rejected : 'f'.repeat(64)
            ), assert.AssertionError);
        }
    }
});
