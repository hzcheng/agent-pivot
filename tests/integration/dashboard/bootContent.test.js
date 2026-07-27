'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { getDashboardBootContent } = require('../../../out/dashboard/bootContent');

function fakeWebview() {
    return { cspSource: 'https://agent-pivot.test' };
}

test('WEBVIEW-TWO-STAGE-STARTUP-001 boot HTML is nonblank, busy, stable, and private', () => {
    const html = getDashboardBootContent(fakeWebview(), {
        kind: 'booting',
        generation: 7,
    });

    assert.match(html, /<main[^>]+aria-busy="true"/);
    assert.match(html, /agent-pivot-boot-shell/);
    assert.equal(html.includes('private-project'), false);
    assert.equal(html.includes('/home/private'), false);
    assert.equal(html.includes('<button'), false);
    assert.equal(html.includes('retry-agent-pivot-bootstrap'), false);
});

test('WEBVIEW-TWO-STAGE-STARTUP-001 failed HTML exposes one safe Retry action', () => {
    const html = getDashboardBootContent(fakeWebview(), {
        kind: 'failed',
        generation: 8,
    });

    assert.match(html, /Agent Pivot could not finish starting/);
    assert.match(html, /<button[^>]+data-action="retry"/);
    assert.equal((html.match(/data-action="retry"/g) || []).length, 1);
    assert.equal(html.includes('/home/private'), false);
    assert.equal(html.includes('private bootstrap error'), false);
});
