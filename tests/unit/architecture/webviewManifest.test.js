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
function makeFixture({
    manifestBundles,
    scripts = {},
    globals,
    builderOrder,
    viewerOrder,
    viewerEmitter = 'options.mediaUri',
    version = 2,
}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-webview-'));
    const write = (relative, content) => {
        fs.mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
        fs.writeFileSync(path.join(root, relative), content);
    };
    const manifest = {
        version,
        bundles: manifestBundles,
        globals: globals || [
            {
                symbol: 'window.__agentPivotAlpha',
                producer: 'src/webview/aScripts.js',
                consumers: ['src/webview/bScripts.js'],
            },
            { symbol: 'window.vscode', producer: 'host' },
        ],
    };
    if (version === 1) {
        delete manifest.globals;
        manifest.permittedGlobals = ['window.__agentPivotAlpha'];
    }
    write('docs/testing/architecture-webview-manifest.json', JSON.stringify(manifest));
    const builder = (builderOrder || ['src/webview/aScripts.js', 'src/webview/bScripts.js'])
        .map(file => `    '${file}',`).join('\n');
    write('scripts/build-dashboard-webview-bundle.js', `const inputPaths = [\n${builder}\n];\n`);
    const viewer = (viewerOrder || ['src/webview/conversationCScripts.js'])
        .map(file => `${viewerEmitter}('${path.basename(file)}')`).join('\n');
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
    'src/webview/bScripts.js':
        'function read() { return window.__agentPivotAlpha.x + window.vscode; }\nread();\n',
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

test('ARCH-WEBVIEW-MANIFEST-001 the viewer emission scrape follows the cache-busting asset helper', () => {
    const root = makeFixture({
        manifestBundles: baseBundles,
        scripts: baseScripts,
        viewerEmitter: 'assetUri',
    });
    assert.deepEqual(runWebviewManifestCheck(root).errors, []);
});

test('ARCH-WEBVIEW-MANIFEST-001 controlled mutation: a viewer with no recognizable emissions fails as unreadable', () => {
    const root = makeFixture({
        manifestBundles: baseBundles,
        scripts: baseScripts,
        viewerEmitter: 'someRenamedHelper',
    });
    const { errors } = runWebviewManifestCheck(root);
    assert.ok(
        errors.some(error => error.includes('no conversation-viewer script emissions')),
        'a scrape that sees nothing must name that, not report an order mismatch: '
            + JSON.stringify(errors)
    );
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

// ── review R7: symbol-level closed world ─────────────────────────────

test('ARCH-WEBVIEW-MANIFEST-001 controlled mutation: an undeclared custom global fails (write and read)', () => {
    const written = makeFixture({
        manifestBundles: baseBundles,
        scripts: {
            ...baseScripts,
            'src/webview/aScripts.js': 'window.__agentPivotAlpha = {};\nwindow.sharedArchitectureState = {};\n',
        },
    });
    assert.ok(runWebviewManifestCheck(written).errors
        .some(error => error.includes('window.sharedArchitectureState')
            && error.includes('assigns undeclared global')));
    const read = makeFixture({
        manifestBundles: baseBundles,
        scripts: {
            ...baseScripts,
            'src/webview/bScripts.js': 'function r() { return window.sneakyGlobal; }\nr();\n',
        },
    });
    assert.ok(runWebviewManifestCheck(read).errors
        .some(error => error.includes('window.sneakyGlobal') && error.includes('undeclared global')));
});

test('ARCH-WEBVIEW-MANIFEST-001 controlled mutation: dynamic window/globalThis access fails closed', () => {
    const dynamicWindow = makeFixture({
        manifestBundles: baseBundles,
        scripts: {
            ...baseScripts,
            'src/webview/aScripts.js': 'const x = window[\'__agentPivot\' + name];\n',
        },
    });
    assert.ok(runWebviewManifestCheck(dynamicWindow).errors
        .some(error => error.includes('dynamic window[...] access')));
    const dynamicGlobalThis = makeFixture({
        manifestBundles: baseBundles,
        scripts: {
            ...baseScripts,
            'src/webview/aScripts.js': 'const x = globalThis[\'__agentPivot\' + name];\n',
        },
    });
    assert.ok(runWebviewManifestCheck(dynamicGlobalThis).errors
        .some(error => error.includes('dynamic globalThis[...] access')));
});

test('ARCH-WEBVIEW-MANIFEST-001 controlled mutation: an undeclared consumer fails', () => {
    const root = makeFixture({
        manifestBundles: baseBundles,
        scripts: baseScripts,
        globals: [
            { symbol: 'window.__agentPivotAlpha', producer: 'src/webview/aScripts.js', consumers: [] },
            { symbol: 'window.vscode', producer: 'host' },
        ],
    });
    assert.ok(runWebviewManifestCheck(root).errors
        .some(error => error.includes('window.__agentPivotAlpha')
            && error.includes('undeclared consumer')));
});

test('ARCH-WEBVIEW-MANIFEST-001 controlled mutation: a declared consumer that never reads fails', () => {
    const root = makeFixture({
        manifestBundles: baseBundles,
        scripts: {
            ...baseScripts,
            'src/webview/bScripts.js': 'function r() { return window.vscode; }\nr();\n',
        },
    });
    assert.ok(runWebviewManifestCheck(root).errors
        .some(error => error.includes('window.__agentPivotAlpha')
            && error.includes('never read it')));
});

test('ARCH-WEBVIEW-MANIFEST-001 controlled mutation: a producer that never assigns fails', () => {
    const root = makeFixture({
        manifestBundles: baseBundles,
        scripts: {
            ...baseScripts,
            'src/webview/aScripts.js': '// nothing assigned\n',
        },
    });
    assert.ok(runWebviewManifestCheck(root).errors
        .some(error => error.includes('never assigns window.__agentPivotAlpha')));
});

test('ARCH-WEBVIEW-MANIFEST-001 controlled mutation: a write by a non-producer fails', () => {
    const root = makeFixture({
        manifestBundles: baseBundles,
        scripts: {
            ...baseScripts,
            'src/webview/bScripts.js':
                'window.__agentPivotAlpha = {};\nfunction r() { return window.vscode; }\nr();\n',
        },
    });
    assert.ok(runWebviewManifestCheck(root).errors
        .some(error => error.includes('bScripts.js') && error.includes('only declared producer')));
});

test('ARCH-WEBVIEW-MANIFEST-001 controlled mutation: spoofing a host symbol fails', () => {
    const root = makeFixture({
        manifestBundles: baseBundles,
        scripts: {
            ...baseScripts,
            'src/webview/aScripts.js': 'window.__agentPivotAlpha = {};\nwindow.vscode = {};\n',
        },
    });
    assert.ok(runWebviewManifestCheck(root).errors
        .some(error => error.includes('window.vscode') && error.includes('must not spoof')));
});

test('ARCH-WEBVIEW-MANIFEST-001 controlled mutation: a bare global reference fails', () => {
    const root = makeFixture({
        manifestBundles: baseBundles,
        scripts: {
            ...baseScripts,
            'src/webview/bScripts.js': 'function r() { return __agentPivotAlpha.x; }\nr();\n',
        },
    });
    assert.ok(runWebviewManifestCheck(root).errors
        .some(error => error.includes('window.__agentPivotAlpha')
            && error.includes('without the window./globalThis. prefix')));
});

test('ARCH-WEBVIEW-MANIFEST-001 controlled mutation: a load-time read before the producer fails', () => {
    const bundles = [
        { id: 'dashboard', scripts: ['src/webview/bScripts.js', 'src/webview/aScripts.js'] },
        { id: 'conversation-viewer', scripts: ['src/webview/conversationCScripts.js'] },
    ];
    const root = makeFixture({
        manifestBundles: bundles,
        builderOrder: ['src/webview/bScripts.js', 'src/webview/aScripts.js'],
        scripts: {
            ...baseScripts,
            // Top-level (load-time) read in the consumer that loads first.
            'src/webview/bScripts.js': 'const boot = window.__agentPivotAlpha.x;\n',
        },
    });
    assert.ok(runWebviewManifestCheck(root).errors
        .some(error => error.includes('window.__agentPivotAlpha')
            && error.includes('loads before its producer')));
});

test('ARCH-WEBVIEW-MANIFEST-001 controlled mutation: a cross-bundle consumer fails', () => {
    const root = makeFixture({
        manifestBundles: baseBundles,
        scripts: baseScripts,
        globals: [
            {
                symbol: 'window.__agentPivotAlpha',
                producer: 'src/webview/aScripts.js',
                consumers: ['src/webview/bScripts.js', 'src/webview/conversationCScripts.js'],
            },
            { symbol: 'window.vscode', producer: 'host' },
        ],
    });
    assert.ok(runWebviewManifestCheck(root).errors
        .some(error => error.includes('conversationCScripts.js')
            && error.includes('cross-bundle globals are forbidden')));
});

test('ARCH-WEBVIEW-MANIFEST-001 controlled mutation: a stale declaration fails', () => {
    const root = makeFixture({
        manifestBundles: baseBundles,
        scripts: baseScripts,
        globals: [
            {
                symbol: 'window.__agentPivotAlpha',
                producer: 'src/webview/aScripts.js',
                consumers: ['src/webview/bScripts.js'],
            },
            { symbol: 'window.vscode', producer: 'host' },
            { symbol: 'window.__agentPivotGhost', producer: 'src/webview/aScripts.js', consumers: [] },
        ],
    });
    assert.ok(runWebviewManifestCheck(root).errors
        .some(error => error.includes('window.__agentPivotGhost') && error.includes('stale')));
});

test('ARCH-WEBVIEW-MANIFEST-001 controlled mutation: schema violations fail', () => {
    const duplicated = makeFixture({
        manifestBundles: baseBundles,
        scripts: baseScripts,
        globals: [
            {
                symbol: 'window.__agentPivotAlpha',
                producer: 'src/webview/aScripts.js',
                consumers: ['src/webview/bScripts.js'],
            },
            {
                symbol: 'window.__agentPivotAlpha',
                producer: 'src/webview/aScripts.js',
                consumers: ['src/webview/bScripts.js'],
            },
            { symbol: 'window.vscode', producer: 'host' },
        ],
    });
    assert.ok(runWebviewManifestCheck(duplicated).errors
        .some(error => error.includes('duplicate symbol declaration')));
    const hostWithConsumers = makeFixture({
        manifestBundles: baseBundles,
        scripts: baseScripts,
        globals: [
            {
                symbol: 'window.__agentPivotAlpha',
                producer: 'src/webview/aScripts.js',
                consumers: ['src/webview/bScripts.js'],
            },
            { symbol: 'window.vscode', producer: 'host', consumers: ['src/webview/bScripts.js'] },
        ],
    });
    assert.ok(runWebviewManifestCheck(hostWithConsumers).errors
        .some(error => error.includes('window.vscode') && error.includes('must not declare consumers')));
});

test('ARCH-WEBVIEW-MANIFEST-001 controlled mutation: a v1 flat manifest is rejected', () => {
    const root = makeFixture({
        manifestBundles: baseBundles,
        scripts: baseScripts,
        version: 1,
    });
    assert.ok(runWebviewManifestCheck(root).errors
        .some(error => error.includes('version must be 2')));
});
