'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-chromium');

const filterScript = fs.readFileSync(path.join(
    __dirname,
    '..', '..',
    'src', 'webview', 'webviewFilterScripts.js'
), 'utf8');

let browser;

test.before(async () => {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
});

test.after(async () => {
    await browser.close();
});

async function settleAnimationFrames(frame) {
    await frame.evaluate(() => new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
}

test('WEBVIEW-WEBVIEW-REFRESH-FOCUS-001 rendered dashboard preserves editor focus during background initialization', async t => {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
    t.after(() => page.close());
    await page.route('http://agent-pivot.test/', route => route.fulfill({
        contentType: 'text/html',
        body: [
            '<label>Editor <input id="editor-input"></label>',
            '<iframe name="agent-pivot-dashboard"></iframe>',
        ].join(''),
    }));
    await page.goto('http://agent-pivot.test/');
    const frame = page.frames().find(candidate =>
        candidate.name() === 'agent-pivot-dashboard'
    );
    assert.ok(frame);
    await frame.setContent([
        '<button id="webview-entry" type="button">Dashboard</button>',
        '<div id="filter-wrapper"><input id="filter" type="search"></div>',
        '<button id="clear" type="button">Clear</button>',
    ].join(''));
    await frame.addScriptTag({ content: filterScript });

    await page.locator('#editor-input').focus();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'editor-input');
    await frame.evaluate(() => {
        window.initFiltering(true, {
            isSearchActive: () => false,
            setSearchQuery: () => undefined,
        });
    });
    await settleAnimationFrames(frame);

    assert.equal(await page.evaluate(() => document.activeElement?.id), 'editor-input');
    assert.notEqual(await frame.evaluate(() => document.activeElement?.id), 'filter');

    await frame.locator('#webview-entry').focus();
    assert.equal(await frame.evaluate(() => document.hasFocus()), true);
    await frame.evaluate(() => {
        window.initFiltering(true, {
            isSearchActive: () => false,
            setSearchQuery: () => undefined,
        });
    });
    await settleAnimationFrames(frame);

    assert.equal(await frame.evaluate(() => document.activeElement?.id), 'filter');
});
