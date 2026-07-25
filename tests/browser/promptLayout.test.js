'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-chromium');
const {
    getAiPanelContent,
    getPromptSurfaceContent,
} = require('../../out/prompts/webviewContent');

const styles = fs.readFileSync(path.join(__dirname, '../../media/styles.css'), 'utf8');
const promptScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewPromptScripts.js'),
    'utf8'
);
const longName = `Prompt-${'name'.repeat(42)}`;
const longBody = `Preview-${'body'.repeat(52)}`;

function snapshotAt(revision) {
    return {
        version: 1,
        revision,
        selectedPromptId: null,
        prompts: [{
            id: 'prompt-a',
            name: longName,
            text: longBody,
        }],
    };
}

async function assertNoHorizontalOverflow(page, width, label) {
    const layout = await page.evaluate(() => {
        const viewportWidth = document.documentElement.clientWidth;
        const surface = document.querySelector('[data-prompt-surface]');
        const overflowingElements = Array.from(document.querySelectorAll(
            '[data-ai-panel], [data-prompt-surface], [data-prompt-surface] *'
        )).filter(element => {
            if (element.hidden || getComputedStyle(element).display === 'none') return false;
            const bounds = element.getBoundingClientRect();
            return bounds.left < -0.5 || bounds.right > viewportWidth + 0.5;
        }).map(element => ({
            tag: element.tagName,
            className: element.className,
            left: element.getBoundingClientRect().left,
            right: element.getBoundingClientRect().right,
        }));
        return {
            documentClientWidth: viewportWidth,
            documentScrollWidth: document.documentElement.scrollWidth,
            surfaceClientWidth: surface.clientWidth,
            surfaceScrollWidth: surface.scrollWidth,
            overflowingElements,
        };
    });
    assert.ok(
        layout.documentScrollWidth <= layout.documentClientWidth,
        `${label} document overflows at ${width}px: ${JSON.stringify(layout)}`
    );
    assert.ok(
        layout.surfaceScrollWidth <= layout.surfaceClientWidth,
        `${label} Prompt surface overflows at ${width}px: ${JSON.stringify(layout)}`
    );
    assert.deepEqual(
        layout.overflowingElements,
        [],
        `${label} elements overflow at ${width}px`
    );
}

async function assertReachable(page, selector, width) {
    const controls = await page.locator(selector).evaluateAll(elements => elements.map(element => {
        const bounds = element.getBoundingClientRect();
        const centerX = bounds.left + bounds.width / 2;
        const centerY = bounds.top + bounds.height / 2;
        const hit = document.elementFromPoint(centerX, centerY);
        return {
            label: element.getAttribute('aria-label') || element.textContent.trim(),
            visible: bounds.width > 0
                && bounds.height > 0
                && bounds.left >= 0
                && bounds.right <= document.documentElement.clientWidth
                && bounds.top >= 0
                && bounds.bottom <= document.documentElement.clientHeight
                && Boolean(hit && (hit === element || element.contains(hit))),
        };
    }));
    assert.ok(controls.length > 0, `missing ${selector} at ${width}px`);
    assert.ok(
        controls.every(control => control.visible),
        `${selector} must remain visible and reachable at ${width}px: ${JSON.stringify(controls)}`
    );
}

test('WEBVIEW-AI-PROMPT-INTERACTION-001 keeps Prompt controls and text usable in narrow sidebars', async t => {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    t.after(() => browser.close());

    for (const width of [240, 320, 600]) {
        await t.test(`${width}px`, async () => {
            const page = await browser.newPage({ viewport: { width, height: 1000 } });
            t.after(() => page.close());
            const initialSnapshot = snapshotAt(1);

            await page.setContent(`<!doctype html>
                <html>
                    <head><style>${styles}</style></head>
                    <body class="steward-sidebar">
                        <main id="ai-host">${getAiPanelContent(initialSnapshot)}</main>
                    </body>
                </html>`);
            await page.evaluate(() => {
                window.vscode = { postMessage() {} };
            });
            await page.addScriptTag({ content: promptScript });
            assert.equal(await page.evaluate(() =>
                window.__projectStewardPrompts.mount(document.getElementById('ai-host'))
            ), true);

            await assertNoHorizontalOverflow(page, width, 'initial');
            await assertReachable(page, '[data-action="prompt-new"]', width);
            await assertReachable(page, '[data-action="prompt-select-default"]', width);
            await assertReachable(page, '[data-action="prompt-edit"]', width);
            await assertReachable(page, '[data-action="prompt-delete"]', width);

            const wrappedText = await page.evaluate(() => {
                const measure = selector => {
                    const element = document.querySelector(selector);
                    const styles = getComputedStyle(element);
                    return {
                        clientWidth: element.clientWidth,
                        scrollWidth: element.scrollWidth,
                        height: element.getBoundingClientRect().height,
                        lineHeight: parseFloat(styles.lineHeight) || parseFloat(styles.fontSize) * 1.2,
                        overflowWrap: styles.overflowWrap,
                    };
                };
                return {
                    name: measure('.prompt-name'),
                    preview: measure('.prompt-preview'),
                };
            });
            for (const [kind, measurement] of Object.entries(wrappedText)) {
                assert.ok(
                    measurement.scrollWidth <= measurement.clientWidth,
                    `${kind} must not clip at ${width}px`
                );
                assert.ok(
                    measurement.height > measurement.lineHeight * 1.5,
                    `${kind} must wrap to multiple lines at ${width}px`
                );
                assert.equal(measurement.overflowWrap, 'anywhere');
            }

            await page.locator('[data-action="prompt-new"]').click();
            const textarea = page.locator('[data-prompt-form="create"] textarea');
            await textarea.fill('A usable narrow Prompt body');
            const textareaLayout = await textarea.evaluate(element => {
                const bounds = element.getBoundingClientRect();
                return {
                    left: bounds.left,
                    right: bounds.right,
                    width: bounds.width,
                    resize: getComputedStyle(element).resize,
                    value: element.value,
                };
            });
            assert.ok(textareaLayout.width >= 120, `textarea is too narrow at ${width}px`);
            assert.ok(textareaLayout.left >= 0 && textareaLayout.right <= width);
            assert.equal(textareaLayout.resize, 'vertical');
            assert.equal(textareaLayout.value, 'A usable narrow Prompt body');
            await assertReachable(page, '.prompt-create-form .prompt-form-actions button', width);
            await assertNoHorizontalOverflow(page, width, 'open create form');
            await page.locator('[data-action="prompt-cancel-create"]').click();

            if (width <= 320) {
                const narrowFlow = await page.evaluate(() => {
                    const content = document.querySelector('.prompt-item-content').getBoundingClientRect();
                    const actions = document.querySelector('.prompt-item-actions').getBoundingClientRect();
                    return { contentBottom: content.bottom, actionsTop: actions.top };
                });
                assert.ok(
                    narrowFlow.actionsTop >= narrowFlow.contentBottom - 0.5,
                    `item actions must wrap below Prompt text at ${width}px`
                );
            }

            await page.locator('[data-action="prompt-edit"]').focus();
            const nextSnapshot = snapshotAt(2);
            assert.equal(await page.evaluate(({ snapshot, html }) =>
                window.__projectStewardPrompts.applyRefresh({
                    type: 'prompt-panel-updated',
                    version: 1,
                    target: 'global-prompt-library',
                    snapshot,
                    html,
                }), {
                snapshot: nextSnapshot,
                html: getPromptSurfaceContent(nextSnapshot),
            }), true);
            const restoredFocus = await page.evaluate(() => ({
                action: document.activeElement.getAttribute('data-action'),
                promptId: document.activeElement.getAttribute('data-prompt-id'),
            }));
            assert.deepEqual(restoredFocus, {
                action: 'prompt-edit',
                promptId: 'prompt-a',
            });
            await assertReachable(page, '[data-action="prompt-edit"]', width);
            await assertNoHorizontalOverflow(page, width, 'authoritative replacement');
        });
    }
});
