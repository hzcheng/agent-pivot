'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { parseMarkdownSuggestionEnvelope } = require('../../../out/aiSessions/conversation/markdownSuggestions');
test('MARKDOWN-SUGGESTION-ENVELOPE-001 only accepts an exact bounded suggestion envelope', () => {
    assert.deepEqual(parseMarkdownSuggestionEnvelope('```markdown-suggestion\n{"selectedText":"old","replacement":"new"}\n```'), { selectedText: 'old', replacement: 'new' });
    assert.equal(parseMarkdownSuggestionEnvelope('```json\n{}\n```'), undefined);
    assert.equal(parseMarkdownSuggestionEnvelope('```markdown-suggestion\n{"selectedText":"old","replacement":""}\n```'), undefined);
});
