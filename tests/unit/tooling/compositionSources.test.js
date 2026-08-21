'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { readCompositionSource } = require('../../../scripts/lib/compositionSources');

function writeFixture(root, files) {
    for (const [relative, content] of Object.entries(files)) {
        const target = path.join(root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    }
}

test('composition source reads the root plus sorted section files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'composition-sources-'));
    writeFixture(root, {
        'src/dashboard.ts': '// root',
        'src/dashboard/sections/bSection.ts': '// b',
        'src/dashboard/sections/aSection.ts': '// a',
        'src/dashboard/sections/readme.md': '// not typescript',
    });
    const combined = readCompositionSource(root);
    assert.equal(combined, '// root\n// a\n// b');
});

test('composition source tolerates a missing sections directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'composition-sources-'));
    writeFixture(root, { 'src/dashboard.ts': '// root only' });
    assert.equal(readCompositionSource(root), '// root only');
});
