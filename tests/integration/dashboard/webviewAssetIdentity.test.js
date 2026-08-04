'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..', '..', '..');
const SRC_WEBVIEW_DIR = path.join(root, 'src', 'webview');
const MEDIA_DIR = path.join(root, 'media');

// The webview behavior scripts are maintained in src/webview and mirrored
// byte-for-byte into media/ (the runtime asset root). Historically each pair
// had its own hand-written assertion, so newly added scripts could drift
// silently. This loop keeps the guarantee automatic for every present and
// future script.
test('WEBVIEW-ASSET-IDENTITY-001 mirrors every src/webview script into media byte-for-byte', () => {
    const scriptNames = fs.readdirSync(SRC_WEBVIEW_DIR)
        .filter(name => name.endsWith('.js'))
        .sort();
    assert.ok(scriptNames.length > 0, 'expected webview scripts under src/webview');

    const missing = [];
    const drifted = [];
    for (const name of scriptNames) {
        const mediaPath = path.join(MEDIA_DIR, name);
        if (!fs.existsSync(mediaPath)) {
            missing.push(name);
            continue;
        }
        const sourceBytes = fs.readFileSync(path.join(SRC_WEBVIEW_DIR, name));
        if (!sourceBytes.equals(fs.readFileSync(mediaPath))) {
            drifted.push(name);
        }
    }
    assert.deepStrictEqual(missing, [], 'webview scripts missing from media/');
    assert.deepStrictEqual(drifted, [], 'webview scripts drifted from their media/ copies');
});
