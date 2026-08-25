'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildAiSessionHandoffPrompt } = require('../../../out/aiSessions/handoffPrompt');

// SESSION-HANDOFF-PROMPT-001

test('handoff prompt names the source provider, session and transcript path', () => {
    const prompt = buildAiSessionHandoffPrompt({
        sourceProviderLabel: 'Codex',
        sourceSessionId: 'abc-123',
        sourceSessionName: 'Fix login bug',
        sourceCwd: '/work/repo',
        transcriptPath: '/home/user/.codex/sessions/abc-123.jsonl',
    });
    assert.match(prompt, /previous Codex chat/);
    assert.match(prompt, /\("Fix login bug"\)/);
    assert.match(prompt, /session abc-123/);
    assert.match(prompt, /\/home\/user\/\.codex\/sessions\/abc-123\.jsonl/);
    assert.match(prompt, /Read that transcript first/);
    assert.match(prompt, /worked in: \/work\/repo/);
    assert.match(prompt, /continue the task from where it stopped/);
});

test('handoff prompt falls back to provider storage guidance without a transcript path', () => {
    const prompt = buildAiSessionHandoffPrompt({
        sourceProviderLabel: 'Claude',
        sourceSessionId: 'def-456',
        transcriptPath: null,
    });
    assert.match(prompt, /previous Claude chat \(session def-456\)/);
    assert.match(prompt, /provider's session storage/);
    assert.match(prompt, /ask me for a summary/);
    assert.ok(!prompt.includes('worked in:'));
});

test('handoff prompt sanitizes control characters and bounds fragments', () => {
    const prompt = buildAiSessionHandoffPrompt({
        sourceProviderLabel: 'Codex',
        sourceSessionId: 'abc-123',
        sourceSessionName: `line one\nline two ${'x'.repeat(500)}`,
        sourceCwd: '/work/repo',
        transcriptPath: '/tmp/t.jsonl',
    });
    assert.ok(!prompt.includes('line one\nline two'));
    assert.match(prompt, /line one line two/);
    assert.ok(prompt.length < 1200);
});
