'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
    parseMarkdownSuggestionEnvelope,
    stripMarkdownSuggestionEnvelope,
} = require('../../../out/aiSessions/conversation/markdownSuggestions');
test('MARKDOWN-SUGGESTION-ENVELOPE-001 only accepts an exact bounded suggestion envelope', () => {
    assert.deepEqual(parseMarkdownSuggestionEnvelope('```markdown-suggestion\n{"selectedText":"old","replacement":"new"}\n```'), { selectedText: 'old', replacement: 'new' });
    assert.equal(parseMarkdownSuggestionEnvelope('```json\n{}\n```'), undefined);
    assert.equal(parseMarkdownSuggestionEnvelope('```markdown-suggestion\n{"selectedText":"old","replacement":""}\n```'), undefined);
});

test('MARKDOWN-SUGGESTION-ENVELOPE-001 removes only a valid actionable envelope from the reader reply', () => {
    const explanation = 'The restore command needs a staging verification step.';
    assert.equal(stripMarkdownSuggestionEnvelope(explanation + '\n\n```markdown-suggestion\n'
        + '{"selectedText":"old","replacement":"new"}\n```'), explanation);
    assert.equal(stripMarkdownSuggestionEnvelope('```markdown-suggestion\n'
        + '{"selectedText":"old","replacement":""}\n```'), '```markdown-suggestion\n'
        + '{"selectedText":"old","replacement":""}\n```');
});
