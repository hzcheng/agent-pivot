'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-chromium');
const { getAiPanelContent } = require('../../out/prompts/webviewContent');

const styles = fs.readFileSync(path.join(__dirname, '../../media/styles.css'), 'utf8');
const protocol = fs.readFileSync(path.join(__dirname, '../../src/webview/webviewPromptProtocolScripts.js'), 'utf8');
const promptScript = fs.readFileSync(path.join(__dirname, '../../src/webview/webviewPromptScripts.js'), 'utf8');

function snapshot() {
    return { version: 2, revision: 1, selectedPromptId: null,
        groups: [{ id: 'general', name: 'General', kind: 'general' }, { id: 'feature', name: 'Feature flow', kind: 'custom' }],
        prompts: [
            { id: 'review', name: `Review ${'a very long Prompt name '.repeat(4)}`, description: 'Review focused implementation work', text: 'Review.', groupId: 'general' },
            { id: 'plan', name: 'Plan the feature', text: 'Plan.', groupId: 'feature' },
        ] };
}

async function open(browser, width) {
    const page = await browser.newPage({ viewport: { width, height: 480 } });
    const data = snapshot();
    await page.setContent(`<style>${styles}</style><body class="steward-sidebar"><main id="host">${getAiPanelContent(data)}</main></body>`);
    await page.evaluate(() => { window.vscode = { postMessage() {} }; });
    await page.addScriptTag({ content: protocol });
    await page.addScriptTag({ content: promptScript });
    assert.equal(await page.evaluate(value => window.__agentPivotPrompts.mount(document.getElementById('host'), { authoritySequence: 1, snapshot: value }), data), true);
    return page;
}

test('Prompt tree remains a compact single-column sidebar at 240px', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await open(browser, 240);
        const dimensions = await page.locator('.prompt-tree').evaluate(node => ({ scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }));
        assert.ok(dimensions.scrollWidth <= dimensions.clientWidth);
        assert.equal(await page.locator('input[type="search"]').count(), 0);
        assert.equal(await page.locator('[data-prompt-group-id="general"] li[data-prompt-id="review"]').count(), 1);
        assert.equal(await page.locator('[data-prompt-group-id="feature"] li[data-prompt-id="plan"]').count(), 1);
    } finally { await browser.close(); }
});

test('Prompt tree supports collapse without changing stored group ownership', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await open(browser, 320);
        await page.locator('[data-prompt-group-id="feature"] [data-action="prompt-toggle-group"]').click();
        assert.equal(await page.locator('[data-prompt-group-id="feature"] [data-prompt-list]').isHidden(), true);
        assert.equal(await page.locator('[data-prompt-group-id="general"] [data-prompt-list]').isHidden(), false);
    } finally { await browser.close(); }
});
