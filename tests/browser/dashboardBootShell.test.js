'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { chromium } = require('playwright-chromium');
const { getDashboardBootContent } = require('../../out/dashboard/bootContent');

let browser;

test.before(async () => {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
});

test.after(async () => {
    await browser.close();
});

function fakeWebview() {
    return { cspSource: 'https://agent-pivot.test' };
}

async function openBootDocument(t, state, options = {}) {
    const page = await browser.newPage({ viewport: { width: 360, height: 480 } });
    t.after(() => page.close());
    page.setDefaultTimeout(5_000);
    if (options.reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => {
        window.__agentPivotBootMessages = [];
        window.acquireVsCodeApi = () => ({
            postMessage(message) {
                window.__agentPivotBootMessages.push(message);
            },
        });
    });
    await page.goto('about:blank');
    await page.setContent(getDashboardBootContent(fakeWebview(), state));
    return page;
}

async function postedMessages(page) {
    return page.evaluate(() => window.__agentPivotBootMessages);
}

test('WEBVIEW-TWO-STAGE-STARTUP-001 boot shell has bounded geometry and no booting actions', async t => {
    const page = await openBootDocument(t, { kind: 'booting', generation: 7 });
    const root = page.locator('.agent-pivot-boot-shell');
    const placeholder = page.locator('.agent-pivot-boot-placeholder').first();
    const tabRow = page.locator('[data-agent-pivot-boot-tab-row]');
    const cardArea = page.locator('[data-agent-pivot-boot-card-area]');

    const [rootBox, placeholderBox, tabRowBox, cardAreaBox] = await Promise.all([
        root.boundingBox(), placeholder.boundingBox(), tabRow.boundingBox(), cardArea.boundingBox(),
    ]);
    assert.ok(rootBox && rootBox.width > 0 && rootBox.height > 0);
    assert.ok(placeholderBox && placeholderBox.width > 0 && placeholderBox.height > 0);
    assert.ok(tabRowBox && tabRowBox.height > 0 && tabRowBox.y >= rootBox.y);
    assert.ok(cardAreaBox && cardAreaBox.height > 0 && cardAreaBox.height <= 196);
    assert.equal(await page.locator('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])').count(), 0);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 boot shell posts one current-generation first paint and suppresses shimmer for reduced motion', async t => {
    const page = await openBootDocument(t, { kind: 'booting', generation: 7 }, { reducedMotion: true });
    await page.waitForFunction(() => window.__agentPivotBootMessages?.some(
        message => message.type === 'agent-pivot-browser-first-paint'
    ));
    const firstPaintMessages = (await postedMessages(page)).filter(
        message => message.type === 'agent-pivot-browser-first-paint'
    );

    assert.deepEqual(firstPaintMessages, [{
        type: 'agent-pivot-browser-first-paint',
        version: 1,
        generation: 7,
    }]);
    assert.equal(await page.locator('.agent-pivot-boot-placeholder').first().evaluate(
        element => getComputedStyle(element).animationName
    ), 'none');
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 failed shell provides one focusable Retry that posts each click', async t => {
    const page = await openBootDocument(t, { kind: 'failed', generation: 8 });
    const retry = page.locator('button[data-action="retry"]');

    assert.equal(await retry.count(), 1);
    await retry.focus();
    assert.equal(await retry.evaluate(element => document.activeElement === element), true);
    await retry.click();
    await retry.click();
    const retries = (await postedMessages(page)).filter(
        message => message.type === 'retry-agent-pivot-bootstrap'
    );
    assert.deepEqual(retries, [
        { type: 'retry-agent-pivot-bootstrap', version: 1 },
        { type: 'retry-agent-pivot-bootstrap', version: 1 },
    ]);
});
