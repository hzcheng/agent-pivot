'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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

function readBuffer(relativePath) {
    return fs.readFileSync(path.join(repositoryRoot, relativePath));
}

function markdownSection(markdown, heading) {
    const start = markdown.indexOf(`## ${heading}`);
    assert.notEqual(start, -1, `Missing Markdown section: ${heading}`);
    const next = markdown.indexOf('\n## ', start + heading.length + 3);
    return markdown.slice(start, next === -1 ? markdown.length : next);
}

function assertLocalMarkdownLinksResolve(relativePath) {
    const markdown = read(relativePath);
    for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        const target = match[1];
        if (/^https?:\/\//.test(target)) continue;
        const resolved = path.resolve(
            repositoryRoot, path.dirname(relativePath), target
        );
        assert.equal(fs.existsSync(resolved), true,
            `${relativePath} local link must resolve: ${target}`);
    }
}

function manifests() {
    return {
        main: {
            name: 'agent-pivot',
            displayName: 'Agent Pivot',
            publisher: 'hzcheng',
            version: '1.1.0',
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
                'agent', 'ai',
                'codex', 'codex cli',
                'claude', 'claude code',
                'kimi', 'kimi cli',
                'ai sessions', 'session manager',
                'project manager', 'projects',
                'todo', 'todo list',
                'prompts', 'prompt library',
                'workspace', 'tmux', 'dashboard',
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
            version: '1.0.2',
            icon: 'media/extension_icon.png',
            license: 'MIT',
            categories: ['Other'],
            repository: {
                type: 'git',
                url: 'https://github.com/hzcheng/agent-pivot.git',
            },
            homepage: 'https://github.com/hzcheng/agent-pivot#readme',
            bugs: {
                url: 'https://github.com/hzcheng/agent-pivot/issues',
            },
        },
    };
}

test('marketplace README exposes the approved identity and durable links', () => {
    const mainReadme = read('README.md');
    assert.match(mainReadme,
        /^# Agent Pivot$/m);
    assert.match(mainReadme,
        /Switch, monitor, and resume Codex, Claude, and Kimi sessions/);
    assert.match(mainReadme,
        /^## Privacy and local data$/m);
    assert.match(mainReadme,
        /does not upload conversation content to an Agent Pivot service/);
    assert.match(mainReadme,
        /began as a fork of Kruemelkatze\/vscode-dashboard/);
    assert.match(mainReadme,
        /\[Source repository\]\(https:\/\/github\.com\/hzcheng\/agent-pivot\)/);
    assert.match(mainReadme,
        /\[Issue tracker\]\(https:\/\/github\.com\/hzcheng\/agent-pivot\/issues\)/);
    assertLocalMarkdownLinksResolve('README.md');
});

test('privacy copy discloses stored workspace URIs without broader negatives', () => {
    const mainReadme = read('README.md');
    const bridgeReadme = read('extensions/attention-ui-bridge/README.md');
    assert.match(bridgeReadme, /^# Agent Pivot Attention UI Bridge$/m);
    assert.match(bridgeReadme, /has no user-facing commands/);
    for (const markdown of [mainReadme, bridgeReadme]) {
        assert.match(markdown,
            /records workspace and root URIs locally/);
        assert.match(markdown,
            /Those URIs can include absolute local paths or remote-authority identifiers\./);
        assert.match(markdown,
            /does not record conversation content, prompts, or responses\./);
        assert.doesNotMatch(markdown,
            /does not record[^.]*hostnames/i);
        assert.doesNotMatch(markdown,
            /does not record[^.]*remote authorities/i);
        assert.doesNotMatch(markdown,
            /does not record[^.]*absolute project paths/i);
    }
    assertLocalMarkdownLinksResolve(
        'extensions/attention-ui-bridge/README.md'
    );
});

test('first-party licenses retain upstream MIT terms and current copyright', () => {
    const exactTerms = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
    const licenses = [
        read('LICENSE'),
        read('extensions/attention-ui-bridge/LICENSE'),
    ];
    assert.equal(licenses[0], licenses[1]);
    for (const license of licenses) {
        assert.match(license, /^MIT License$/m);
        assert.match(license, /^Copyright \(c\) 2018$/m);
        assert.match(license, /^Copyright \(c\) 2026 hzcheng$/m);
        assert.equal(license.includes(exactTerms), true);
    }
});

test('third-party notices preserve authoritative installed license artifacts', () => {
    const notices = read('THIRD_PARTY_NOTICES.md');
    for (const [heading, licensePath] of [
        [
            'dom-autoscroller 2.3.4 — MIT — Copyright Quentin Engles',
            'node_modules/dom-autoscroller/LICENSE',
        ],
        [
            'dragula 3.7.3 — MIT — Copyright Nicolas Bevacqua',
            'node_modules/dragula/license',
        ],
        [
            'fitty 2.3.5 — MIT — Copyright Rik Schennink',
            'node_modules/fitty/LICENSE',
        ],
    ]) {
        const section = markdownSection(notices, heading);
        assert.equal(section.includes(read(licensePath)), true,
            `${heading} must contain its installed license verbatim`);
    }
    assert.deepEqual(
        readBuffer('licenses/DOMPurify-Apache-2.0.txt'),
        readBuffer('node_modules/dompurify/LICENSE')
    );
});

test('current changelog is clean while archived development bytes are locked', () => {
    const changelog = read('CHANGELOG.md');
    assert.match(changelog, /^## \[1\.0\.0\] - 2026-07-26$/m);
    const boundary = '## Unpublished Project Steward development history';
    assert.equal(changelog.includes(boundary), false,
        'published changelog must not contain the unpublished pre-release history');
    assert.doesNotMatch(changelog,
        /Project Steward|project-steward|projectSteward|hzcheng\.project-steward/);
    const archivedHistory = read('docs/development-history.md');
    assert.match(archivedHistory, /^# Pre-release development history$/m);
    assert.ok(archivedHistory.includes(boundary),
        'archived development history must retain the reviewed historical section');
    assert.equal(
        crypto.createHash('sha256')
            .update(archivedHistory)
            .digest('hex'),
        '2e762dac9504b55c7361a4db6ca6657f77418b5ed48e5fb117269d5064809af7'
    );
});

test('durable design records truthful bridge storage and a clean release note', () => {
    const design = read(
        'docs/superpowers/specs/2026-07-26-agent-pivot-brand-identity-design.md'
    );
    const plan = read(
        'docs/superpowers/plans/2026-07-26-agent-pivot-brand-identity.md'
    );
    for (const document of [design, plan]) {
        assert.match(document, /records workspace and root URIs locally/);
        assert.match(document,
            /absolute local paths or remote-authority identifiers/);
        assert.match(document,
            /does not record conversation content, prompts, or responses/);
    }
    assert.doesNotMatch(plan,
        /companion bridge from Project Steward to Agent Pivot/);
});

test('durable release verification uses the real artifacts directory', () => {
    const plan = read(
        'docs/superpowers/plans/2026-07-26-agent-pivot-brand-identity.md'
    );
    assert.match(plan, /artifacts\/agent-pivot-1\.0\.0\.vsix/);
    assert.match(
        plan,
        /artifacts\/agent-pivot-attention-ui-bridge-1\.0\.0\.vsix/
    );
    assert.doesNotMatch(
        plan,
        /releases\/agent-pivot(?:-attention-ui-bridge)?-1\.0\.0\.vsix/
    );
});

test('marketplace notices name every required dependency', () => {
    assert.match(read('CHANGELOG.md'), /^## \[1\.0\.0\] - 2026-07-26$/m);
    for (const dependency of [
        'dom-autoscroller 2.3.4',
        'dragula 3.7.3',
        'fitty 2.3.5',
        'DOMPurify 3.4.13',
    ]) {
        assert.match(read('THIRD_PARTY_NOTICES.md'), new RegExp(dependency));
    }
});

test('brand identity exposes the exact approved public contract', () => {
    assert.deepEqual(BRAND_IDENTITY, {
        displayName: 'Agent Pivot',
        publisher: 'hzcheng',
        mainPackageName: 'agent-pivot',
        mainExtensionId: 'hzcheng.agent-pivot',
        mainVersion: '1.1.0',
        bridgePackageName: 'agent-pivot-attention-ui-bridge',
        bridgeExtensionId: 'hzcheng.agent-pivot-attention-ui-bridge',
        bridgeVersion: '1.0.2',
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
        value => { delete value.bridge.homepage; },
        value => { value.bridge.bugs.url =
            'https://github.com/Kruemelkatze/vscode-dashboard/issues'; },
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
    fs.writeFileSync(path.join(root, 'docs/development-history.md'),
        '## Unpublished Project Steward development history\n\n' +
        'Project Steward history\n');
    fs.writeFileSync(path.join(root, 'docs/superpowers/plans/history.md'),
        'project-steward design evidence\n');
    assert.deepEqual(findStaleIdentity(root), [{
        file: 'CHANGELOG.md',
        line: 7,
        token: 'Project Steward',
        excerpt: '## Unpublished Project Steward development history',
    }, {
        file: 'CHANGELOG.md',
        line: 9,
        token: 'Project Steward',
        excerpt: 'Project Steward history',
    }, {
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
    assert.deepEqual(findStaleIdentity(root).map(item => item.line), [5, 7]);
});

test('scanner rejects stale identity in former release reset wording', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-release-'));
    fs.writeFileSync(path.join(root, 'CHANGELOG.md'),
        '# Changelog\n\n## [1.0.0] - 2026-07-26\n\n### Changed\n\n' +
        '- Reset the unpublished extension identity, commands, settings, state, managed\n' +
        '  runtime names, and companion bridge from Project Steward to Agent Pivot.\n\n' +
        '## Unpublished Project Steward development history\n');
    assert.deepEqual(findStaleIdentity(root).map(item => item.line), [8, 10]);
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
