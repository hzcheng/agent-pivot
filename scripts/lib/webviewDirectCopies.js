'use strict';

/**
 * Webview direct-copy sync (Harness efficiency PRD, P0-A): the manifest
 * (docs/testing/architecture-webview-manifest.json) is the single source of
 * truth for which src/webview scripts ship as byte-identical media copies.
 * The copies are BUILD OUTPUTS, never committed: every consumer that needs
 * them (tests, packaging, install) runs after a build step that calls
 * syncWebviewDirectCopies.
 */

const fs = require('fs');
const path = require('path');

const MANIFEST_RELATIVE_PATH = path.join(
    'docs', 'testing', 'architecture-webview-manifest.json'
);

function readWebviewManifest(rootDirectory) {
    return JSON.parse(fs.readFileSync(
        path.join(rootDirectory, MANIFEST_RELATIVE_PATH),
        'utf8'
    ));
}

/** Flatten every bundle's directCopies map into [{source, output}] pairs. */
function listDirectCopies(rootDirectory) {
    const manifest = readWebviewManifest(rootDirectory);
    const copies = [];
    for (const bundle of manifest.bundles || []) {
        for (const [source, output] of Object.entries(bundle.directCopies || {})) {
            copies.push({ source, output });
        }
    }
    return copies;
}

/** Write every declared direct copy from its source bytes. Returns the list. */
function syncWebviewDirectCopies(rootDirectory) {
    const copies = listDirectCopies(rootDirectory);
    for (const { source, output } of copies) {
        const bytes = fs.readFileSync(path.join(rootDirectory, source));
        fs.writeFileSync(path.join(rootDirectory, output), bytes);
    }
    return copies;
}

module.exports = {
    MANIFEST_RELATIVE_PATH,
    listDirectCopies,
    readWebviewManifest,
    syncWebviewDirectCopies,
};
