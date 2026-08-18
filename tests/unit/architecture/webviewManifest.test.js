'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
    runWebviewManifestCheck,
} = require('../../../scripts/architecture/checkWebviewManifest');

const repoRoot = path.resolve(__dirname, '..', '..', '..');

/**
 * Synthetic webview fixture: two dashboard scripts and one conversation
 * script, with the builders mirroring the manifest order.
 */
function makeFixture({ manifestBundles, scripts = {}, builderOrder, viewerOrder }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-webview-'));
    const write = (relative, content) => {
        fs.mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
        fs.writeFileSync(path.join(root, relative), content);
    };
    write('docs/testing/architecture-webview-manifest.json', JSON.stringify({
        version: 1,
        bundles: manifestBundles,
        permittedGlobals: ['window.__agentPivotAlpha', 'window.vscode'],
    }));
    const builder = (builderOrder || ['src/webview/aScripts.js', 'src/webview/bScripts.js'])
        .map(file => `    '${file}',`).join('\n');
    write('scripts/build-dashboard-webview-bundle.js', `const inputPaths = [\n${builder}\n];\n`);
    const viewer = (viewerOrder || ['src/webview/conversationCScripts.js'])
        .map(file => `options.mediaUri('${path.basename(file)}')`).join('\n');
    write('src/aiSessions/conversation/viewerDocument.ts', viewer + '\n');
    for (const [file, content] of Object.entries(scripts)) {
        write(file, content);
    }
    return root;
}

const baseBundles = [
    { id: 'dashboard', scripts: ['src/webview/aScripts.js', 'src/webview/bScripts.js'] },
    { id: 'conversation-viewer', scripts: ['src/webview/conversationCScripts.js'] },
];
const baseScripts = {
    'src/webview/aScripts.js': 'window.__agentPivotAlpha = {};\n',
    'src/webview/bScripts.js': 'window.vscode.postMessage({});\n',
    'src/webview/conversationCScripts.js': '// viewer\n',
};

test('ARCH-WEBVIEW-MANIFEST-001 the real repository satisfies the declared manifest', () => {
    const { errors } = runWebviewManifestCheck(repoRoot);
    assert.deepEqual(errors, []);
});

test('ARCH-WEBVIEW-MANIFEST-001 a consistent synthetic manifest passes', () => {
    const root = makeFixture({ manifestBundles: baseBundles, scripts: baseScripts });
    assert.deepEqual(runWebviewManifestCheck(root).errors, []);
});

test('ARCH-WEBVIEW-MANIFEST-001 controlled mutation: an undeclared script fails', () => {
    const root = makeFixture({
        manifestBundles: baseBundles,
        scripts: { ...baseScripts, 'src/webview/sneakyScripts.js': '// new\n' },
    });
    assert.ok(runWebviewManifestCheck(root).errors
        .some(error => error.includes('sneakyScripts.js') && error.includes('not declared')));
});

test('ARCH-WEBVIEW-MANIFEST-001 controlled mutation: double membership fails', () => {
    const bundles = [
        { id: 'dashboard', scripts: ['src/webview/aScripts.js', 'src/webview/bScripts.js'] },
        { id: 'conversation-viewer', scripts: ['src/webview/conversationCScripts.js', 'src/webview/aScripts.js'] },
    ];
    const root = makeFixture({ manifestBundles: bundles, scripts: baseScripts });
    assert.ok(runWebviewManifestCheck(root).errors
        .some(error => error.includes('aScripts.js') && error.includes('exact-once')));
});

test('ARCH-WEBVIEW-MANIFEST-001 controlled mutation: load-order drift from the builder fails', () => {
    const root = makeFixture({
        manifestBundles: baseBundles,
        scripts: baseScripts,
        builderOrder: ['src/webview/bScripts.js', 'src/webview/aScripts.js'],
    });
    assert.ok(runWebviewManifestCheck(root).errors
        .some(error => error.includes('dashboard bundle order differs')));
});

test('ARCH-WEBVIEW-MANIFEST-001 controlled mutation: an undeclared global reference fails', () => {
    const root = makeFixture({
        manifestBundles: baseBundles,
        scripts: {
            ...baseScripts,
            'src/webview/aScripts.js': 'window.__agentPivotUndeclared = {};\n',
        },
    });
    assert.ok(runWebviewManifestCheck(root).errors
        .some(error => error.includes('window.__agentPivotUndeclared')
            && error.includes('undeclared global')));
});

test('ARCH-WEBVIEW-MANIFEST-001 controlled mutation: dynamic window access fails closed', () => {
    const root = makeFixture({
        manifestBundles: baseBundles,
        scripts: {
            ...baseScripts,
            'src/webview/aScripts.js': 'const x = window[\'__agentPivot\' + name];\n',
        },
    });
    assert.ok(runWebviewManifestCheck(root).errors
        .some(error => error.includes('dynamic window[...] access')));
});

test('ARCH-WEBVIEW-MANIFEST-001 controlled mutation: a manifest entry for a missing file fails', () => {
    const bundles = [
        { id: 'dashboard', scripts: ['src/webview/aScripts.js', 'src/webview/bScripts.js', 'src/webview/goneScripts.js'] },
        { id: 'conversation-viewer', scripts: ['src/webview/conversationCScripts.js'] },
    ];
    const root = makeFixture({ manifestBundles: bundles, scripts: baseScripts });
    assert.ok(runWebviewManifestCheck(root).errors
        .some(error => error.includes('goneScripts.js') && error.includes('does not exist')));
});
