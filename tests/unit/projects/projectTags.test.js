'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    MAX_TAGS_PER_PROJECT,
    normalizeProjectTags,
    parseProjectTagsInput,
} = require('../../../out/projects/projectTags');

test('PROJECT-TAGS-001 trims, strips leading hashes, and drops empty entries', () => {
    assert.deepEqual(normalizeProjectTags(['  frontend ', '#urgent', '', '   ', '##']), [
        'frontend',
        'urgent',
    ]);
});

test('PROJECT-TAGS-001 dedupes case-insensitively keeping the first spelling', () => {
    assert.deepEqual(normalizeProjectTags(['Frontend', 'frontend', 'FRONTEND', 'backend']), [
        'Frontend',
        'backend',
    ]);
});

test('PROJECT-TAGS-001 rejects non-array input and non-string entries', () => {
    assert.deepEqual(normalizeProjectTags(undefined), []);
    assert.deepEqual(normalizeProjectTags(null), []);
    assert.deepEqual(normalizeProjectTags('frontend'), []);
    assert.deepEqual(normalizeProjectTags(['a', 42, null, 'b']), ['a', 'b']);
});

test('PROJECT-TAGS-001 caps tag count and tag length', () => {
    const many = Array.from({ length: MAX_TAGS_PER_PROJECT + 4 }, (_, index) => `tag-${index}`);
    assert.equal(normalizeProjectTags(many).length, MAX_TAGS_PER_PROJECT);
    assert.deepEqual(normalizeProjectTags(['x'.repeat(64)]), []);
});

test('PROJECT-TAGS-001 parses comma-separated input into normalized tags', () => {
    assert.deepEqual(parseProjectTagsInput('frontend, urgent,, #Backend '), [
        'frontend',
        'urgent',
        'Backend',
    ]);
    assert.deepEqual(parseProjectTagsInput(''), []);
    assert.deepEqual(parseProjectTagsInput(undefined), []);
});
