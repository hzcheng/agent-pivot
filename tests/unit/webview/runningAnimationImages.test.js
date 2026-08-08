'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    MAX_RUNNING_IMAGE_BYTES,
    clearRunningAnimationImageCache,
    getEffectiveRunningCardAnimation,
    getEffectiveRunningIconAnimation,
    normalizeRunningCardAnimation,
    normalizeRunningIconAnimation,
    readRunningAnimationImages,
    resolveRunningAnimationImage,
} = require('../../../out/webview/runningAnimationImages');

const TINY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><circle cx="2" cy="2" r="1"/></svg>';

function makeConfig(values) {
    return {
        get: (key, fallback) => Object.prototype.hasOwnProperty.call(values, key)
            ? values[key]
            : fallback,
    };
}

function writeTempFile(name, content) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'running-image-')), name);
    fs.writeFileSync(file, content);
    return file;
}

test('CUSTOM-RUNNING-IMAGE-RESOLVER-001 resolves a readable local image into a data URI', () => {
    clearRunningAnimationImageCache();
    const svg = writeTempFile('spin.svg', TINY_SVG);
    const dataUri = resolveRunningAnimationImage(svg);
    assert.equal(dataUri, `data:image/svg+xml;base64,${Buffer.from(TINY_SVG).toString('base64')}`);
    for (const [name, mime] of [['a.png', 'image/png'], ['b.gif', 'image/gif'], ['c.webp', 'image/webp'], ['d.jpg', 'image/jpeg']]) {
        const file = writeTempFile(name, Buffer.from([1, 2, 3]));
        assert.ok(resolveRunningAnimationImage(file).startsWith(`data:${mime};base64,`), `${name} must map to ${mime}`);
    }
});

test('CUSTOM-RUNNING-IMAGE-RESOLVER-001 rejects empty, missing, oversized, and non-image paths', () => {
    clearRunningAnimationImageCache();
    assert.equal(resolveRunningAnimationImage(''), undefined);
    assert.equal(resolveRunningAnimationImage('   '), undefined);
    assert.equal(resolveRunningAnimationImage(undefined), undefined);
    assert.equal(resolveRunningAnimationImage('/definitely/not/a/real/file.svg'), undefined);
    assert.equal(resolveRunningAnimationImage(os.tmpdir()), undefined, 'directories must not resolve');
    assert.equal(resolveRunningAnimationImage(writeTempFile('notes.txt', 'hello')), undefined,
        'unsupported extensions must not resolve');
    const oversized = writeTempFile('big.png', Buffer.alloc(MAX_RUNNING_IMAGE_BYTES + 1, 1));
    assert.equal(resolveRunningAnimationImage(oversized), undefined, 'files above the size cap must not resolve');
});

test('CUSTOM-RUNNING-IMAGE-RESOLVER-001 expands a leading tilde to the home directory', () => {
    clearRunningAnimationImageCache();
    const homeRelative = path.join('agent-pivot-running-image-test', 'spin.svg');
    const absolute = path.join(os.homedir(), homeRelative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, TINY_SVG);
    try {
        assert.equal(resolveRunningAnimationImage(`~/${homeRelative}`),
            `data:image/svg+xml;base64,${Buffer.from(TINY_SVG).toString('base64')}`);
    } finally {
        fs.rmSync(path.dirname(absolute), { recursive: true, force: true });
    }
});

test('CUSTOM-RUNNING-IMAGE-RESOLVER-001 custom animation falls back to current without a readable image', () => {
    clearRunningAnimationImageCache();
    const svg = writeTempFile('spin.svg', TINY_SVG);
    const withImage = makeConfig({
        aiSessionRunningCardAnimation: 'custom',
        aiSessionRunningCardCustomImage: svg,
        aiSessionRunningIconAnimation: 'custom',
        aiSessionRunningIconCustomImage: svg,
    });
    assert.equal(getEffectiveRunningCardAnimation(withImage), 'custom');
    assert.equal(getEffectiveRunningIconAnimation(withImage), 'custom');
    const images = readRunningAnimationImages(withImage);
    assert.ok(images.card.startsWith('data:image/svg+xml;base64,'));
    assert.ok(images.icon.startsWith('data:image/svg+xml;base64,'));

    const missingImage = makeConfig({
        aiSessionRunningCardAnimation: 'custom',
        aiSessionRunningCardCustomImage: '/definitely/missing.svg',
        aiSessionRunningIconAnimation: 'custom',
        aiSessionRunningIconCustomImage: '',
    });
    assert.equal(getEffectiveRunningCardAnimation(missingImage), 'current',
        'custom without a readable card image must fall back to current');
    assert.equal(getEffectiveRunningIconAnimation(missingImage), 'current',
        'custom without a readable icon image must fall back to current');

    const legacyValue = makeConfig({
        aiSessionRunningCardAnimation: 'removed-legacy-artwork-option',
        aiSessionRunningIconAnimation: 'removed-legacy-artwork-option',
    });
    assert.equal(getEffectiveRunningCardAnimation(legacyValue), 'current',
        'removed animation options must fall back to current');
    assert.equal(getEffectiveRunningIconAnimation(legacyValue), 'current');
    assert.equal(normalizeRunningCardAnimation('orbit'), 'orbit');
    assert.equal(normalizeRunningIconAnimation('none'), 'none');
});

test('CUSTOM-RUNNING-IMAGE-RESOLVER-001 caches resolved images until the file changes', () => {
    clearRunningAnimationImageCache();
    const svg = writeTempFile('spin.svg', TINY_SVG);
    const first = resolveRunningAnimationImage(svg);
    fs.writeFileSync(svg, TINY_SVG); // identical bytes, mtime bump may be a no-op
    assert.equal(resolveRunningAnimationImage(svg), first);
    const updated = TINY_SVG.replace('r="1"', 'r="1.5"');
    fs.writeFileSync(svg, updated);
    fs.utimesSync(svg, new Date(), new Date(Date.now() + 5000));
    assert.equal(resolveRunningAnimationImage(svg),
        `data:image/svg+xml;base64,${Buffer.from(updated).toString('base64')}`,
        'content changes with a new mtime must re-resolve');
});
