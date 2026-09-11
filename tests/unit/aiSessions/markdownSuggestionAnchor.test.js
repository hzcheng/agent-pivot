'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    findUniqueMarkdownSuggestionAnchor,
} = require('../../../out/aiSessions/conversation/markdown');

test('MARKDOWN-SUGGESTION-ANCHOR-001 only returns a uniquely contextual source range', () => {
    const source = 'Start\n\nFirst target.\n\nSecond target.\n';
    assert.deepEqual(findUniqueMarkdownSuggestionAnchor(source, {
        selectedText: 'target.', prefix: 'First ', suffix: '\n\nSecond',
    }), { start: 13, end: 20 });
    assert.equal(findUniqueMarkdownSuggestionAnchor(source, {
        selectedText: 'target.', prefix: '', suffix: '',
    }), undefined, 'ambiguous text must never select a range');
    assert.equal(findUniqueMarkdownSuggestionAnchor(source, {
        selectedText: 'missing', prefix: '', suffix: '',
    }), undefined);
    assert.deepEqual(findUniqueMarkdownSuggestionAnchor(
        '## Release plan\n\nUse **one** tested rollback command.\n', {
            selectedText: 'one',
            // This is the rendered, not raw-Markdown, surrounding context.
            prefix: 'Use ', suffix: ' tested rollback command.',
        }
    ), { start: 23, end: 26 },
    'a uniquely occurring source quote stays applicable despite Markdown delimiters');
});
