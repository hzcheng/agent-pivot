'use strict';

/**
 * Webview declared-manifest enforcement (Harness v0, program Stage 2 PR 5;
 * charter v3 Section 8.6).
 *
 * The 37 src/webview/*.js scripts carry no static imports, so the module
 * graph cannot police them. This check enforces the declared manifest
 * (docs/testing/architecture-webview-manifest.json):
 * - membership: every production webview script belongs to exactly one bundle;
 * - load order: the manifest mirrors the builders (bundle inputPaths and the
 *   conversation viewer document) and drift in either direction fails;
 * - globals: every cross-script window.* reference must be declared in
 *   permittedGlobals, and dynamic window[...] access fails closed.
 */

const fs = require('fs');
const path = require('path');

const MANIFEST_PATH = path.join('docs', 'testing', 'architecture-webview-manifest.json');
const BUNDLE_BUILDER = path.join('scripts', 'build-dashboard-webview-bundle.js');
const VIEWER_DOCUMENT = path.join('src', 'aiSessions', 'conversation', 'viewerDocument.ts');
const GLOBAL_REFERENCE = /window\.(__agentPivot[A-Za-z0-9]*|vscode|mermaid|DOMPurify|fitty|dragula|domAutoscroller)\b/g;
const DYNAMIC_GLOBAL_ACCESS = /window\s*\[/g;

function readJson(rootDirectory, relativePath, errors) {
    try {
        return JSON.parse(fs.readFileSync(path.join(rootDirectory, relativePath), 'utf8'));
    } catch (error) {
        errors.push(`webview-manifest: cannot read ${relativePath}: ${error.message}`);
        return null;
    }
}

function checkBundleOrder(rootDirectory, errors) {
    const builderText = fs.readFileSync(path.join(rootDirectory, BUNDLE_BUILDER), 'utf8');
    const builderOrder = [...builderText.matchAll(/'(src\/webview\/[^']+\.js)'/g)]
        .map(match => match[1]);
    const viewerText = fs.readFileSync(path.join(rootDirectory, VIEWER_DOCUMENT), 'utf8');
    const viewerOrder = [...viewerText.matchAll(/mediaUri\('(conversation[A-Za-z]+Scripts\.js)'\)/g)]
        .map(match => `src/webview/${match[1]}`);
    return { builderOrder, viewerOrder };
}

function runWebviewManifestCheck(rootDirectory) {
    const errors = [];
    const manifest = readJson(rootDirectory, MANIFEST_PATH, errors);
    if (!manifest) { return { errors }; }
    if (manifest.version !== 1) {
        errors.push('webview-manifest: version must be 1');
    }
    const bundles = Array.isArray(manifest.bundles) ? manifest.bundles : [];
    const permittedGlobals = new Set(
        Array.isArray(manifest.permittedGlobals) ? manifest.permittedGlobals : []);

    // Membership: exact-once over src/webview/*.js, and every entry exists.
    const membership = new Map();
    const webviewDirectory = path.join(rootDirectory, 'src', 'webview');
    const scriptsOnDisk = fs.readdirSync(webviewDirectory)
        .filter(name => name.endsWith('.js'))
        .map(name => `src/webview/${name}`)
        .sort();
    for (const bundle of bundles) {
        for (const script of bundle.scripts || []) {
            if (!fs.existsSync(path.join(rootDirectory, script))) {
                errors.push(`webview-manifest: bundle '${bundle.id}' lists ${script}, `
                    + 'which does not exist');
            }
            if (membership.has(script)) {
                errors.push(`webview-manifest: ${script} is in bundles '${membership.get(script)}' `
                    + `and '${bundle.id}' (membership is exact-once)`);
            }
            membership.set(script, bundle.id);
        }
    }
    for (const script of scriptsOnDisk) {
        if (!membership.has(script)) {
            errors.push(`webview-manifest: ${script} is not declared in any bundle`);
        }
    }

    // Load-order fidelity with the builders.
    const { builderOrder, viewerOrder } = checkBundleOrder(rootDirectory, errors);
    for (const bundle of bundles) {
        if (bundle.id === 'dashboard') {
            if (JSON.stringify(bundle.scripts) !== JSON.stringify(builderOrder)) {
                errors.push('webview-manifest: dashboard bundle order differs from '
                    + `${BUNDLE_BUILDER} inputPaths`);
            }
        }
        if (bundle.id === 'conversation-viewer') {
            if (JSON.stringify(bundle.scripts) !== JSON.stringify(viewerOrder)) {
                errors.push('webview-manifest: conversation-viewer bundle order differs from '
                    + `${VIEWER_DOCUMENT} script emission order`);
            }
        }
    }

    // Cross-script globals must be declared; dynamic access fails closed.
    for (const script of scriptsOnDisk) {
        const text = fs.readFileSync(path.join(rootDirectory, script), 'utf8');
        DYNAMIC_GLOBAL_ACCESS.lastIndex = 0;
        if (DYNAMIC_GLOBAL_ACCESS.test(text)) {
            errors.push(`webview-manifest: ${script} uses dynamic window[...] access, `
                + 'which evades the declared-global policy');
        }
        GLOBAL_REFERENCE.lastIndex = 0;
        let match;
        while ((match = GLOBAL_REFERENCE.exec(text))) {
            const global_ = `window.${match[1]}`;
            if (!permittedGlobals.has(global_)) {
                errors.push(`webview-manifest: ${script} references undeclared global `
                    + `${global_} — declare it in ${MANIFEST_PATH}`);
            }
        }
    }
    return { errors };
}

function main() {
    const { errors } = runWebviewManifestCheck(path.resolve(__dirname, '..', '..'));
    if (errors.length > 0) {
        console.error('Webview manifest checks FAILED:');
        for (const error of errors) { console.error(`  ✗ ${error}`); }
        process.exitCode = 1;
        return;
    }
    console.log('Webview manifest checks passed: exact-once membership, load-order '
        + 'fidelity with both builders, and all cross-script globals declared.');
}

if (require.main === module) { main(); }

module.exports = { MANIFEST_PATH, runWebviewManifestCheck };
