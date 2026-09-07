'use strict';

// Covers WEBVIEW-AI-PROMPT-INTERACTION-001.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-chromium');
const { getAiPanelContent, getPromptSurfaceContent } = require('../../out/prompts/webviewContent');

const styles = fs.readFileSync(path.join(__dirname, '../../media/styles.css'), 'utf8');
const protocol = fs.readFileSync(path.join(__dirname, '../../src/webview/webviewPromptProtocolScripts.js'), 'utf8');
const promptScript = fs.readFileSync(path.join(__dirname, '../../src/webview/webviewPromptScripts.js'), 'utf8');
const projectCollapseScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewProjectCollapseScripts.js'),
    'utf8'
);

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
    await page.evaluate(() => {
        window.__promptMessages = [];
        window.vscode = { postMessage(message) { window.__promptMessages.push(message); } };
    });
    await page.addScriptTag({ content: protocol });
    await page.addScriptTag({ content: promptScript });
    assert.equal(await page.evaluate(value => window.__agentPivotPrompts.mount(document.getElementById('host'), { authoritySequence: 1, snapshot: value }), data), true);
    return page;
}

async function openWithGlobalGroupToggle(browser) {
    const page = await browser.newPage({ viewport: { width: 320, height: 480 } });
    const data = snapshot();
    await page.setContent(`<style>${styles}</style><body class="steward-sidebar">
        <button type="button" data-action="toggle-all-groups">Collapse all groups</button>
        <div id="outside">Outside</div>
        <main id="host">${getAiPanelContent(data)}</main>
    </body>`);
    await page.evaluate(() => {
        window.vscode = { postMessage() {} };
        window.__agentPivotDashboard = { getActiveTab() { return 'ai'; } };
        document.getElementById('outside').addEventListener('click', event => event.stopPropagation());
    });
    await page.addScriptTag({ content: protocol });
    await page.addScriptTag({ content: projectCollapseScript });
    await page.addScriptTag({ content: promptScript });
    await page.evaluate(value => {
        window.groupCollapse = initProjectGroupCollapse();
        document.querySelector('[data-action="toggle-all-groups"]').addEventListener(
            'click',
            () => window.groupCollapse.toggleAllGroups()
        );
        return window.__agentPivotPrompts.mount(document.getElementById('host'), {
            authoritySequence: 1,
            snapshot: value,
        });
    }, data);
    return page;
}

test('Prompt tree remains a compact single-column sidebar at supported narrow widths', async t => {
    const browser = await chromium.launch({ headless: true });
    try {
        for (const width of [240, 280, 320, 420]) {
            await t.test(`${width}px`, async () => {
                const page = await open(browser, width);
                try {
                    const dimensions = await page.locator('.prompt-tree').evaluate(node => ({ scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }));
                    assert.ok(dimensions.scrollWidth <= dimensions.clientWidth);
                    assert.equal(await page.locator('input[type="search"]').count(), 0);
                    assert.equal(await page.locator('[data-prompt-group-id="general"] li[data-prompt-id="review"]').count(), 1);
                    assert.equal(await page.locator('[data-prompt-group-id="feature"] li[data-prompt-id="plan"]').count(), 1);
                    assert.equal(await page.locator('.prompt-item .prompt-preview').count(), 0);
                    const promptRow = await page.locator('[data-prompt-id="review"] .prompt-item-view').evaluate(node => node.getBoundingClientRect().height);
                    assert.ok(promptRow <= 36, `one-line Prompt row should remain compact, received ${promptRow}px`);
                    for (const selector of ['.prompt-use-button', '.prompt-row-menu > summary']) {
                        const bounds = await page.locator(`[data-prompt-id="review"] ${selector}`).evaluate(node => node.getBoundingClientRect());
                        assert.ok(bounds.width > 0 && bounds.right <= width, `${selector} must remain reachable at ${width}px`);
                    }
                } finally { await page.close(); }
            });
        }
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

test('Prompt groups participate in the sidebar-wide collapse and expand control', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await openWithGlobalGroupToggle(browser);
        const toggle = page.locator('[data-action="toggle-all-groups"]');
        assert.equal(await toggle.isDisabled(), false, 'AI Prompt groups make the global toggle available');

        await toggle.click();
        assert.equal(await page.locator('[data-prompt-list]').first().isHidden(), true);
        assert.equal(await page.locator('[data-prompt-list]').nth(1).isHidden(), true);
        assert.match(await toggle.getAttribute('title'), /Expand/i);

        await toggle.click();
        assert.equal(await page.locator('[data-prompt-list]').first().isHidden(), false);
        assert.equal(await page.locator('[data-prompt-list]').nth(1).isHidden(), false);
        assert.match(await toggle.getAttribute('title'), /Collapse/i);

        await page.locator('#ai-tab-skills').click();
        assert.equal(await toggle.isDisabled(), true, 'Skills does not expose hidden Prompt groups to the global toggle');
    } finally { await browser.close(); }
});

test('Prompt group disclosure state and accessible name survive an authoritative refresh', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await open(browser, 320);
        const featureToggle = page.locator('[data-prompt-group-id="feature"] [data-action="prompt-toggle-group"]');
        await featureToggle.click();
        assert.match(await featureToggle.getAttribute('aria-label'), /Expand Feature flow/);

        const nextSnapshot = { ...snapshot(), revision: 2 };
        const html = getPromptSurfaceContent(nextSnapshot);
        const applied = await page.evaluate(payload => window.__agentPivotPrompts.applyRefresh(payload), {
            type: 'prompt-panel-updated',
            version: 1,
            authoritySequence: 2,
            target: 'global-prompt-library',
            snapshot: nextSnapshot,
            html,
        });
        assert.equal(applied, true);
        assert.equal(await page.locator('[data-prompt-group-id="feature"] [data-prompt-list]').isHidden(), true);
        assert.match(
            await page.locator('[data-prompt-group-id="feature"] [data-action="prompt-toggle-group"]').getAttribute('aria-label'),
            /Expand Feature flow/
        );
    } finally { await browser.close(); }
});

test('New Group focus survives an external authoritative refresh', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await open(browser, 320);
        const newGroup = page.locator('[data-action="prompt-group-new"]');
        await newGroup.focus();
        const next = { ...snapshot(), revision: 2 };
        assert.equal(await page.evaluate(payload => window.__agentPivotPrompts.applyRefresh(payload), {
            type: 'prompt-panel-updated', version: 1, authoritySequence: 2,
            target: 'global-prompt-library', snapshot: next, html: getPromptSurfaceContent(next),
        }), true);
        assert.equal(await page.locator('[data-action="prompt-group-new"]').evaluate(
            node => node === document.activeElement
        ), true);
    } finally { await browser.close(); }
});

test('Failed Group creation keeps the typed inline draft available for correction', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await open(browser, 320);
        const form = page.locator('[data-prompt-group-form]');
        await page.locator('[data-action="prompt-group-new"]').click();
        await form.locator('[name="name"]').fill('Release checklist');
        await form.locator('[type="submit"]').focus();
        await form.evaluate(node => node.dispatchEvent(new Event('submit', {
            bubbles: true,
            cancelable: true,
        })));
        const request = await page.evaluate(() => window.__promptMessages[0]);
        assert.ok(request);
        assert.equal(request.operation, 'create-group');

        const next = { ...snapshot(), revision: 2 };
        assert.equal(await page.evaluate(payload => window.__agentPivotPrompts.applyCommandResult(payload), {
            type: 'prompt-command-result', version: request.version, authoritySequence: 2,
            requestId: request.requestId, target: request.target, operation: request.operation,
            success: false, errorCode: 'storage', snapshot: next, html: getPromptSurfaceContent(next),
        }), true);
        assert.equal(await form.isHidden(), false);
        assert.equal(await form.locator('[name="name"]').inputValue(), 'Release checklist');
        assert.equal(await form.locator('[type="submit"]').evaluate(node => node === document.activeElement), true);
    } finally { await browser.close(); }
});

test('Successful Group creation returns focus to the stable New Group action', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await open(browser, 320);
        const form = page.locator('[data-prompt-group-form]');
        await page.locator('[data-action="prompt-group-new"]').click();
        await form.locator('[name="name"]').fill('Release checklist');
        await form.locator('[type="submit"]').focus();
        await form.evaluate(node => node.dispatchEvent(new Event('submit', {
            bubbles: true,
            cancelable: true,
        })));
        const request = await page.evaluate(() => window.__promptMessages[0]);
        const next = {
            ...snapshot(), revision: 2,
            groups: snapshot().groups.concat({ id: 'release', name: 'Release checklist', kind: 'custom' }),
        };
        assert.equal(await page.evaluate(payload => window.__agentPivotPrompts.applyCommandResult(payload), {
            type: 'prompt-command-result', version: request.version, authoritySequence: 2,
            requestId: request.requestId, target: request.target, operation: request.operation,
            success: true, snapshot: next, html: getPromptSurfaceContent(next),
        }), true);
        assert.equal(await page.locator('[data-action="prompt-group-new"]').evaluate(node => node === document.activeElement), true);
    } finally { await browser.close(); }
});

test('Group settlement does not steal an explicit focus change while pending', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await open(browser, 320);
        const form = page.locator('[data-prompt-group-form]');
        await page.locator('[data-action="prompt-group-new"]').click();
        await form.locator('[name="name"]').fill('Release checklist');
        await form.locator('[type="submit"]').focus();
        await form.evaluate(node => node.dispatchEvent(new Event('submit', {
            bubbles: true,
            cancelable: true,
        })));
        const request = await page.evaluate(() => window.__promptMessages[0]);
        await page.evaluate(() => {
            const external = document.createElement('input');
            external.id = 'external-focus';
            document.body.prepend(external);
            external.focus();
        });
        const next = { ...snapshot(), revision: 2 };
        assert.equal(await page.evaluate(payload => window.__agentPivotPrompts.applyCommandResult(payload), {
            type: 'prompt-command-result', version: request.version, authoritySequence: 2,
            requestId: request.requestId, target: request.target, operation: request.operation,
            success: false, errorCode: 'storage', snapshot: next, html: getPromptSurfaceContent(next),
        }), true);
        assert.equal(await page.locator('#external-focus').evaluate(node => node === document.activeElement), true);
        assert.equal(await form.locator('[name="name"]').inputValue(), 'Release checklist');
    } finally { await browser.close(); }
});

test('Group move and delete actions settle against the V2 Prompt tree', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await open(browser, 320);
        const review = page.locator('[data-prompt-id="review"]');
        await review.locator('.prompt-row-menu > summary').click();
        await review.locator('[data-action="prompt-move"][data-prompt-group-id="feature"]').click();
        const move = await page.evaluate(() => window.__promptMessages[0]);
        assert.deepEqual({ operation: move.operation, payload: move.payload }, {
            operation: 'move', payload: { promptId: 'review', groupId: 'feature' },
        });

        const moved = {
            ...snapshot(), revision: 2,
            prompts: snapshot().prompts.map(prompt => prompt.id === 'review'
                ? { ...prompt, groupId: 'feature' }
                : prompt),
        };
        assert.equal(await page.evaluate(payload => window.__agentPivotPrompts.applyCommandResult(payload), {
            type: 'prompt-command-result', version: move.version, authoritySequence: 2,
            requestId: move.requestId, target: move.target, operation: move.operation,
            success: true, snapshot: moved, html: getPromptSurfaceContent(moved),
        }), true);
        assert.equal(await page.locator('.prompt-group[data-prompt-group-id="feature"] li.prompt-item[data-prompt-id="review"]').count(), 1);
        assert.equal(await page.locator('[data-prompt-id="review"] .prompt-row-menu > summary').evaluate(
            node => node === document.activeElement
        ), true);

        const feature = page.locator('.prompt-group[data-prompt-group-id="feature"]');
        await feature.locator('.prompt-group-header .prompt-row-menu > summary').click();
        await feature.locator('[data-action="prompt-delete-group"]').click();
        const deletion = await page.evaluate(() => window.__promptMessages[1]);
        assert.deepEqual({ operation: deletion.operation, payload: deletion.payload }, {
            operation: 'delete-group', payload: { groupId: 'feature' },
        });

        const deleted = {
            version: 2, revision: 3, selectedPromptId: null,
            groups: [{ id: 'general', name: 'General', kind: 'general' }],
            prompts: moved.prompts.map(prompt => ({ ...prompt, groupId: 'general' })),
        };
        assert.equal(await page.evaluate(payload => window.__agentPivotPrompts.applyCommandResult(payload), {
            type: 'prompt-command-result', version: deletion.version, authoritySequence: 3,
            requestId: deletion.requestId, target: deletion.target, operation: deletion.operation,
            success: true, snapshot: deleted, html: getPromptSurfaceContent(deleted),
        }), true);
        assert.equal(await page.locator('[data-prompt-group-id="feature"]').count(), 0);
        assert.equal(await page.locator('.prompt-group[data-prompt-group-id="general"] li.prompt-item[data-prompt-id="review"]').count(), 1);
        assert.equal(await page.locator('[data-action="prompt-group-new"]').evaluate(
            node => node === document.activeElement
        ), true);
    } finally { await browser.close(); }
});

test('Failed Group deletion restores focus to a stable action', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await open(browser, 320);
        const feature = page.locator('.prompt-group[data-prompt-group-id="feature"]');
        await feature.locator('.prompt-group-header .prompt-row-menu > summary').click();
        await feature.locator('[data-action="prompt-delete-group"]').focus();
        await feature.locator('[data-action="prompt-delete-group"]').click();
        const request = await page.evaluate(() => window.__promptMessages[0]);
        const next = { ...snapshot(), revision: 2 };
        assert.equal(await page.evaluate(payload => window.__agentPivotPrompts.applyCommandResult(payload), {
            type: 'prompt-command-result', version: request.version, authoritySequence: 2,
            requestId: request.requestId, target: request.target, operation: request.operation,
            success: false, errorCode: 'storage', snapshot: next, html: getPromptSurfaceContent(next),
        }), true);
        assert.equal(await page.locator('[data-action="prompt-group-new"]').evaluate(
            node => node === document.activeElement
        ), true);
    } finally { await browser.close(); }
});

test('Prompt row-menu mutations restore focus to visible stable actions', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await open(browser, 320);
        const review = page.locator('[data-prompt-id="review"]');
        await review.locator('.prompt-row-menu > summary').click();
        await review.locator('[data-action="prompt-select-default"]').focus();
        await review.locator('[data-action="prompt-select-default"]').click();
        const selection = await page.evaluate(() => window.__promptMessages[0]);
        const selected = { ...snapshot(), revision: 2, selectedPromptId: 'review' };
        assert.equal(await page.evaluate(payload => window.__agentPivotPrompts.applyCommandResult(payload), {
            type: 'prompt-command-result', version: selection.version, authoritySequence: 2,
            requestId: selection.requestId, target: selection.target, operation: selection.operation,
            success: true, snapshot: selected, html: getPromptSurfaceContent(selected),
        }), true);
        assert.equal(await review.locator('.prompt-row-menu > summary').evaluate(
            node => node === document.activeElement
        ), true);

        await review.locator('.prompt-row-menu > summary').click();
        await review.locator('[data-action="prompt-delete"]').focus();
        await review.locator('[data-action="prompt-delete"]').click();
        const deletion = await page.evaluate(() => window.__promptMessages[1]);
        const deleted = {
            ...selected,
            revision: 3,
            selectedPromptId: null,
            prompts: selected.prompts.filter(prompt => prompt.id !== 'review'),
        };
        assert.equal(await page.evaluate(payload => window.__agentPivotPrompts.applyCommandResult(payload), {
            type: 'prompt-command-result', version: deletion.version, authoritySequence: 3,
            requestId: deletion.requestId, target: deletion.target, operation: deletion.operation,
            success: true, snapshot: deleted, html: getPromptSurfaceContent(deleted),
        }), true);
        assert.equal(await page.locator('.prompt-header [data-action="prompt-new"]').evaluate(
            node => node === document.activeElement
        ), true);
    } finally { await browser.close(); }
});

test('Prompt tree uses explicit menus for editing and supports Escape and outside-click dismissal', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await open(browser, 320);
        const createForm = page.locator('[data-prompt-form="create"]');
        const groupForm = page.locator('[data-prompt-group-form]');

        await page.locator('[data-action="prompt-new"]').first().click();
        assert.equal(await createForm.isHidden(), false);
        await page.keyboard.press('Escape');
        assert.equal(await createForm.isHidden(), true, 'Escape cancels Prompt creation');
        assert.equal(await page.locator('[data-action="prompt-new"]').first().evaluate(node => node === document.activeElement), true,
            'cancelling Prompt creation returns focus to its opener');

        await page.locator('[data-action="prompt-group-new"]').click();
        assert.equal(await groupForm.isHidden(), false);
        await page.keyboard.press('Escape');
        assert.equal(await groupForm.isHidden(), true, 'Escape cancels Group creation');

        const item = page.locator('li.prompt-item[data-prompt-id="review"]');
        assert.match(await item.getAttribute('title'), /Prompt:/);
        assert.match(await item.getAttribute('title'), /Group: General/);
        assert.match(await item.getAttribute('title'), /Description:/);
        const promptInfoId = await item.locator('.prompt-use-button').getAttribute('aria-describedby');
        assert.ok(promptInfoId);
        assert.match(await page.locator(`#${promptInfoId}`).textContent(), /Review focused implementation work/);
        await item.locator('.prompt-item-main').click();
        assert.equal(await item.locator('[data-prompt-form="edit"]').isHidden(), true,
            'clicking a Prompt row does not enter editing');

        await item.locator('.prompt-row-menu > summary').click();
        assert.equal(await item.locator('.prompt-row-menu').getAttribute('open'), '');
        await item.locator('[data-action="prompt-edit"]').click();
        assert.equal(await item.locator('[data-prompt-form="edit"]').isHidden(), false,
            'Edit in the action menu opens the inline editor');
        await page.keyboard.press('Escape');
        assert.equal(await item.locator('[data-prompt-form="edit"]').isHidden(), true,
            'Escape cancels Prompt editing');
        assert.equal(await item.locator('.prompt-row-menu > summary').evaluate(node => node === document.activeElement), true,
            'cancelling Prompt editing returns focus to the action menu');

        await item.locator('.prompt-row-menu > summary').click();
        await page.locator('.prompt-header').click();
        assert.equal(await item.locator('.prompt-row-menu').getAttribute('open'), null,
            'clicking away closes the Prompt action menu');
    } finally { await browser.close(); }
});

test('Prompt row actions remain reachable on touch and preserve copied drafts through refresh', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 240, height: 480 }, hasTouch: true });
        const data = snapshot();
        await page.setContent(`<style>${styles}</style><body class="steward-sidebar"><main id="host">${getAiPanelContent(data)}</main></body>`);
        await page.evaluate(() => {
            window.__promptMessages = [];
            window.vscode = { postMessage(message) { window.__promptMessages.push(message); } };
        });
        await page.addScriptTag({ content: protocol });
        await page.addScriptTag({ content: promptScript });
        assert.equal(await page.evaluate(value => window.__agentPivotPrompts.mount(document.getElementById('host'), {
            authoritySequence: 1,
            snapshot: value,
        }), data), true);

        const item = page.locator('[data-prompt-id="review"]');
        assert.equal(await item.locator('.prompt-use-button').isVisible(), true);
        assert.equal(await item.locator('.prompt-row-menu > summary').isVisible(), true);
        await item.locator('.prompt-row-menu > summary').click();
        for (const action of ['prompt-copy', 'prompt-select-default', 'prompt-edit', 'prompt-delete']) {
            assert.equal(await item.locator(`[data-action="${action}"]`).isVisible(), true, `${action} must be reachable on touch`);
        }
        await item.locator('[data-action="prompt-copy"]').click();
        const copiedName = `${data.prompts[0].name} copy`;
        assert.equal(await page.locator('[data-prompt-form="create"] [name="name"]').inputValue(), copiedName);

        const next = { ...snapshot(), revision: 2 };
        assert.equal(await page.evaluate(payload => window.__agentPivotPrompts.applyRefresh(payload), {
            type: 'prompt-panel-updated', version: 1, authoritySequence: 2,
            target: 'global-prompt-library', snapshot: next, html: getPromptSurfaceContent(next),
        }), true);
        assert.equal(await page.locator('[data-prompt-form="create"] [name="name"]').inputValue(), copiedName);
        assert.equal(await page.locator('[data-prompt-form="create"] [name="name"]').evaluate(node => node === document.activeElement), true);
    } finally { await browser.close(); }
});

test('Prompt Use keeps keyboard focus through authoritative replacement and acknowledgement', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await open(browser, 320);
        const use = page.locator('[data-prompt-id="review"] [data-action="prompt-insert-terminal"]');
        await use.focus();
        await page.keyboard.press('Enter');
        const request = await page.evaluate(() => window.__promptMessages[0]);
        assert.ok(request);

        const next = { ...snapshot(), revision: 2 };
        assert.equal(await page.evaluate(payload => window.__agentPivotPrompts.applyRefresh(payload), {
            type: 'prompt-panel-updated', version: 1, authoritySequence: 2,
            target: 'global-prompt-library', snapshot: next, html: getPromptSurfaceContent(next),
        }), true);
        assert.deepEqual(await page.evaluate(() => ({
            action: document.activeElement.getAttribute('data-action'),
            promptId: document.activeElement.getAttribute('data-prompt-id'),
            pending: document.activeElement.getAttribute('aria-disabled'),
        })), { action: 'prompt-insert-terminal', promptId: 'review', pending: 'true' });

        assert.equal(await page.evaluate(value => window.__agentPivotPrompts.applyInsertResult({
            type: 'prompt-insert-terminal-result', version: value.version, requestId: value.requestId,
            target: value.target, success: true, errorCode: null,
        }), request), true);
        assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-disabled')), null);
    } finally { await browser.close(); }
});

test('Prompt action menu closes when an outside sidebar handler stops click propagation', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await openWithGlobalGroupToggle(browser);
        const item = page.locator('li.prompt-item[data-prompt-id="review"]');
        await item.locator('.prompt-row-menu > summary').click();
        assert.equal(await item.locator('.prompt-row-menu').getAttribute('open'), '');

        await page.locator('#outside').click();
        assert.equal(await item.locator('.prompt-row-menu').getAttribute('open'), null,
            'outside pointer interaction closes the Prompt action menu before click handlers can stop it');
    } finally { await browser.close(); }
});
