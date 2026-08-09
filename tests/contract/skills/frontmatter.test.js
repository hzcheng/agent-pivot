'use strict';

// Covers PERSIST-AI-SKILL-DISCOVERY-001. The parser branches must be exercised
// by deterministic hermetic fixtures: the changed-line coverage gate also runs
// on CI machines without a populated ~/.skills, so coverage must never depend
// on machine state (the production-startup harness scans the real home).

const assert = require('node:assert/strict');
const test = require('node:test');

const { getSkillDiagnostics, parseSkillFrontmatter } = require('../../../out/skills/frontmatter');

test('PERSIST-AI-SKILL-DISCOVERY-001 parses single-line, quoted, and BOM frontmatter', () => {
    assert.deepStrictEqual(
        parseSkillFrontmatter('---\nname: demo\ndescription: Does things\n---\n\n# Body\n'),
        { name: 'demo', description: 'Does things' }
    );
    assert.deepStrictEqual(
        parseSkillFrontmatter('---\ndescription: "quoted: value"\n---\nx\n'),
        { description: 'quoted: value' }
    );
    assert.deepStrictEqual(
        parseSkillFrontmatter('\uFEFF---\nname: bom\ndescription: x\n---\n'),
        { name: 'bom', description: 'x' },
        'UTF-8 BOM before the fence is tolerated'
    );
    assert.strictEqual(parseSkillFrontmatter('# No frontmatter\n'), null);
    assert.strictEqual(parseSkillFrontmatter('---\nname: demo\n'), null, 'unclosed block is not frontmatter');
});

test('PERSIST-AI-SKILL-DISCOVERY-001 parses YAML block scalars', () => {
    assert.deepStrictEqual(
        parseSkillFrontmatter('---\nname: gke-basics\nmetadata:\n  category: Containers\ndescription: >-\n  Manages core GKE cluster provisioning,\n  credentials, and workload deployment.\n  Don\'t use for upgrades.\n---\nbody\n'),
        { name: 'gke-basics', description: "Manages core GKE cluster provisioning, credentials, and workload deployment. Don't use for upgrades." },
        'folded scalar joins lines with spaces and skips nested map entries'
    );
    assert.deepStrictEqual(
        parseSkillFrontmatter('---\ndescription: |\n  line one\n  line two\nlicense: MIT\n---\n'),
        { description: 'line one\nline two' },
        'literal scalar keeps newlines and stops at the next top-level field'
    );
    assert.deepStrictEqual(
        parseSkillFrontmatter('---\ndescription: >\n  para one\n\n  para two\n---\n'),
        { description: 'para one\npara two' },
        'folded scalar keeps blank-line paragraph breaks'
    );
    assert.deepStrictEqual(
        parseSkillFrontmatter('---\nname: demo\ndescription: >-\n---\n'),
        { name: 'demo', description: '' },
        'empty block scalar yields an empty description (missing-description fires)'
    );
    assert.deepStrictEqual(
        parseSkillFrontmatter('---\ndescription: |+\n  kept at EOF\n---'),
        { description: 'kept at EOF' },
        'closing fence at end of input still parses'
    );
});

test('PERSIST-AI-SKILL-DISCOVERY-001 reports the diagnostic rule set', () => {
    const codes = list => list.map(item => item.code).sort();
    assert.deepStrictEqual(
        getSkillDiagnostics({ dirName: 'demo', fileName: 'SKILL.md', frontmatter: { name: 'demo', description: 'x' }, bodyLineCount: 10 }),
        []
    );
    assert.deepStrictEqual(
        codes(getSkillDiagnostics({ dirName: 'demo', fileName: 'skill.md', frontmatter: null, bodyLineCount: 0 })),
        ['lowercase-filename', 'missing-frontmatter'].sort()
    );
    assert.deepStrictEqual(
        codes(getSkillDiagnostics({ dirName: 'demo', fileName: 'SKILL.md', frontmatter: { name: 'other', description: 'x'.repeat(1100) }, bodyLineCount: 600 })),
        ['body-too-long', 'description-too-long', 'name-mismatch'].sort()
    );
    assert.deepStrictEqual(
        codes(getSkillDiagnostics({ dirName: 'demo', fileName: 'SKILL.md', frontmatter: { description: 'x' }, bodyLineCount: 1 })),
        ['missing-name']
    );
    assert.deepStrictEqual(
        codes(getSkillDiagnostics({ dirName: 'demo', fileName: 'SKILL.md', frontmatter: { name: 'demo' }, bodyLineCount: 1 })),
        ['missing-description']
    );
    assert.deepStrictEqual(
        codes(getSkillDiagnostics({ dirName: 'x'.repeat(65), fileName: 'SKILL.md', frontmatter: { name: 'x'.repeat(65), description: 'x' }, bodyLineCount: 1 })),
        ['name-too-long']
    );
});
