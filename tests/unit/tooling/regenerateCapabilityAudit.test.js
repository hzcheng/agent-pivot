'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makeTempDirectory } = require('../../helpers/tempDirectory');
const {
    AuditRegenerationError,
    parseArguments,
    regenerateCapabilityAudit,
} = require('../../../scripts/regenerate-capability-audit');

const GIT_ENV = {
    GIT_AUTHOR_NAME: 'Audit Test',
    GIT_AUTHOR_EMAIL: 'audit-test@example.com',
    GIT_COMMITTER_NAME: 'Audit Test',
    GIT_COMMITTER_EMAIL: 'audit-test@example.com',
};

function git(repositoryRoot, args) {
    return childProcess.execFileSync('git', args, {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: { ...process.env, ...GIT_ENV },
    }).trim();
}

const COVERAGE_PATH = path.join('docs', 'testing', 'main-capability-coverage.json');

function coverageJson(base, head, commits, extraIgnored = []) {
    const ignored = extraIgnored.length
        ? `\n            "${extraIgnored.join('",\n            "')}"\n        `
        : '';
    return `{
    "version": 1,
    "audit": {
        "base": "${base}",
        "head": "${head}",
        "ignoredDocumentationCommits": [${ignored}]
    },
    "capabilities": [
        {
            "id": "MAIN-DEMO-CAPABILITY",
            "title": "Demo capability",
            "requirement": "Demo requirement.",
            "commits": [
                "${commits.join('",\n                "')}"
            ],
            "behaviors": [
                "MAIN-DEMO-BEHAVIOR-001"
            ],
            "prGates": [
                "test:ci:linux"
            ],
            "scheduledJobs": [],
            "realEnvironmentRequired": false
        }
    ]
}
`;
}

const CONTRACTS_JSON = `[
  {
    "id": "MAIN-DEMO-BEHAVIOR-001",
    "domain": "architecture",
    "title": "Demo behavior",
    "priority": "P1",
    "status": "automated",
    "owners": ["tests/unit/owner.test.js"],
    "evidence": ["src/feature.ts"]
  },
  {
    "id": "MAIN-MANUAL-BEHAVIOR-001",
    "domain": "architecture",
    "title": "Manual behavior",
    "priority": "P2",
    "status": "manual",
    "manualReason": "Fixture-only manual behavior for restore-path testing.",
    "owners": ["tests/unit/owner.test.js"],
    "evidence": ["src/feature.ts"]
  }
]
`;

function createRepository(t) {
    const repositoryRoot = makeTempDirectory(t, 'audit-regenerator-');
    const write = (relativePath, content) => {
        const absolute = path.join(repositoryRoot, relativePath);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, content);
    };
    const commitAll = subject => {
        git(repositoryRoot, ['add', '-A']);
        git(repositoryRoot, ['commit', '-m', subject]);
        return git(repositoryRoot, ['rev-parse', 'HEAD']);
    };

    git(repositoryRoot, ['init', '-b', 'main']);
    // CI runners have no git identity; the fixture must be self-sufficient.
    git(repositoryRoot, ['config', 'user.name', 'Audit Regenerator Tests']);
    git(repositoryRoot, ['config', 'user.email', 'audit-regenerator-tests@example.invalid']);
    write('package.json', JSON.stringify({
        scripts: { 'test:ci:linux': "node --test 'tests/unit/**/*.test.js'" },
    }));
    write('.github/workflows/verify.yml', 'jobs:\n  verify:\n    runs-on: ubuntu-latest\n');
    write('tests/unit/owner.test.js', "test('MAIN-DEMO-BEHAVIOR-001 works', () => {});\n");
    write('src/feature.ts', 'export const feature = 1;\n');
    write('docs/testing/behavior-contracts.json', CONTRACTS_JSON);
    write('docs/notes.md', '# notes\n');
    write(COVERAGE_PATH, coverageJson('0'.repeat(40), '0'.repeat(40), ['0'.repeat(40)]));
    const base = commitAll('chore: seed the fixture');
    const firstImplementation = (() => {
        write('src/feature.ts', 'export const feature = 2;\n');
        return commitAll('feat: first implementation');
    })();
    write(COVERAGE_PATH, coverageJson(base, firstImplementation, [firstImplementation]));
    const seedAuditCommit = (() => {
        git(repositoryRoot, ['add', '-A']);
        return commitAll('docs: audit the first implementation');
    })();

    const implement = (subject, value) => {
        write('src/feature.ts', `export const feature = ${value};\n`);
        return commitAll(subject);
    };
    const document = subject => {
        write('docs/notes.md', `# notes\n\n${subject}\n`);
        return commitAll(subject);
    };
    const readCoverage = () => fs.readFileSync(path.join(repositoryRoot, COVERAGE_PATH), 'utf8');
    return { repositoryRoot, base, firstImplementation, seedAuditCommit, implement, document, readCoverage, write, commitAll };
}

function cli(overrides = {}) {
    return {
        assignments: [],
        behaviors: [],
        commitMessage: null,
        dryRun: false,
        harvest: 'none',
        ...overrides,
    };
}

test('ARCH-MAIN-CAPABILITY-CURRENCY-001 regenerates assignments, ignores documentation, and preserves formatting', t => {
    const fixture = createRepository(t);
    const docsCommit = fixture.document('docs: plan the second implementation');
    const implementation = fixture.implement('feat: second implementation', 3);
    const originalText = fixture.readCoverage();

    const output = [];
    const result = regenerateCapabilityAudit(fixture.repositoryRoot, cli({
        assignments: [{ left: implementation.slice(0, 12), right: 'MAIN-DEMO-CAPABILITY' }],
    }), line => output.push(line));

    assert.equal(result.committed, false);
    const edited = fixture.readCoverage();
    const expected = originalText
        .replace(`"head": "${fixture.firstImplementation}"`, `"head": "${implementation}"`)
        .replace(
            `                "${fixture.firstImplementation}"\n            ],`,
            `                "${fixture.firstImplementation}",\n                "${implementation}"\n            ],`
        )
        .replace(
            '"ignoredDocumentationCommits": []',
            `"ignoredDocumentationCommits": [\n            "${fixture.seedAuditCommit}",\n            "${docsCommit}"\n        ]`
        );
    assert.equal(edited, expected, 'the edit must be text-surgical with no formatting drift');
    assert.equal(result.plan.newHead, implementation);
    assert.ok(output.some(line => line.includes('validation passed')));
});

test('ARCH-MAIN-CAPABILITY-CURRENCY-001 refuses an unassigned implementation commit without writing', t => {
    const fixture = createRepository(t);
    const unassigned = fixture.implement('feat: unassigned implementation', 4);
    const originalText = fixture.readCoverage();

    assert.throws(
        () => regenerateCapabilityAudit(fixture.repositoryRoot, cli()),
        error => {
            assert.ok(error instanceof AuditRegenerationError);
            assert.ok(error.message.includes(`unassigned implementation commit ${unassigned}`));
            assert.ok(error.message.includes('feat: unassigned implementation'));
            return true;
        }
    );
    assert.equal(fixture.readCoverage(), originalText, 'a refusal must not touch the manifest');
});

test('ARCH-MAIN-CAPABILITY-CURRENCY-001 refuses stale, duplicate, and unknown references', t => {
    const fixture = createRepository(t);
    const implementation = fixture.implement('feat: third implementation', 5);

    const expectRefusal = (assignments, fragment) => assert.throws(
        () => regenerateCapabilityAudit(fixture.repositoryRoot, cli({ assignments })),
        error => error instanceof AuditRegenerationError && error.message.includes(fragment)
    );
    expectRefusal(
        [{ left: fixture.firstImplementation, right: 'MAIN-DEMO-CAPABILITY' }],
        'outside the newly audited range'
    );
    expectRefusal(
        [{ left: 'deadbeef', right: 'MAIN-DEMO-CAPABILITY' }],
        'cannot resolve commit'
    );
    expectRefusal(
        [{ left: implementation, right: 'MAIN-NOPE-CAPABILITY' }],
        'unknown capability MAIN-NOPE-CAPABILITY'
    );
    expectRefusal(
        [
            { left: implementation, right: 'MAIN-DEMO-CAPABILITY' },
            { left: implementation, right: 'MAIN-DEMO-CAPABILITY' },
        ],
        'assigned more than once'
    );
    assert.throws(
        () => regenerateCapabilityAudit(fixture.repositoryRoot, cli({
            assignments: [{ left: implementation, right: 'MAIN-DEMO-CAPABILITY' }],
            behaviors: [{ left: 'MAIN-DEMO-CAPABILITY', right: 'MAIN-DEMO-BEHAVIOR-001' }],
        })),
        /already lists behavior MAIN-DEMO-BEHAVIOR-001/
    );
});

test('ARCH-MAIN-CAPABILITY-CURRENCY-001 skips merge commits and keeps the head on the last implementation', t => {
    const fixture = createRepository(t);
    git(fixture.repositoryRoot, ['checkout', '-b', 'feature', fixture.firstImplementation]);
    const docsCommit = fixture.document('docs: branch documentation');
    const implementation = fixture.implement('feat: branch implementation', 6);
    git(fixture.repositoryRoot, ['checkout', 'main']);
    git(fixture.repositoryRoot, ['merge', '--no-ff', '--no-edit', 'feature']);

    const result = regenerateCapabilityAudit(fixture.repositoryRoot, cli({
        assignments: [{ left: implementation, right: 'MAIN-DEMO-CAPABILITY' }],
    }));

    assert.equal(result.plan.newHead, implementation,
        'the merge commit must not become the audit head');
    assert.deepEqual(
        result.plan.docsToIgnore.map(commit => commit.hash),
        [docsCommit],
        'the branch documentation commit is the only new exemption'
    );
    assert.deepEqual(
        result.plan.deferredDocs.map(commit => commit.hash),
        [fixture.seedAuditCommit],
        'mainline documentation beyond the new head is deferred, not registered'
    );
});

test('ARCH-MAIN-CAPABILITY-CURRENCY-001 restores the manifest when validation fails', t => {
    const fixture = createRepository(t);
    const implementation = fixture.implement('feat: fourth implementation', 7);
    const originalText = fixture.readCoverage();

    assert.throws(
        () => regenerateCapabilityAudit(fixture.repositoryRoot, cli({
            assignments: [{ left: implementation, right: 'MAIN-DEMO-CAPABILITY' }],
            behaviors: [{ left: 'MAIN-DEMO-CAPABILITY', right: 'MAIN-MANUAL-BEHAVIOR-001' }],
        })),
        error => {
            assert.ok(error.message.includes('failed validation'));
            assert.ok(error.message.includes('must be automated'));
            return true;
        }
    );
    assert.equal(fixture.readCoverage(), originalText,
        'a validation failure must restore the original manifest');
});

test('ARCH-MAIN-CAPABILITY-CURRENCY-001 dry-run prints the diff and writes nothing', t => {
    const fixture = createRepository(t);
    const implementation = fixture.implement('feat: fifth implementation', 8);
    const originalText = fixture.readCoverage();
    const originalHead = git(fixture.repositoryRoot, ['rev-parse', 'HEAD']);

    const output = [];
    const result = regenerateCapabilityAudit(fixture.repositoryRoot, cli({
        assignments: [{ left: implementation, right: 'MAIN-DEMO-CAPABILITY' }],
        dryRun: true,
    }), line => output.push(line));

    assert.equal(result.dryRun, true);
    assert.equal(fixture.readCoverage(), originalText);
    assert.equal(git(fixture.repositoryRoot, ['rev-parse', 'HEAD']), originalHead);
    const printed = output.join('\n');
    assert.ok(printed.includes(`+        "head": "${implementation}"`) || printed.includes(`"${implementation}"`));
    assert.ok(printed.includes('diff --git'));
});

test('ARCH-MAIN-CAPABILITY-CURRENCY-001 --commit creates the documentation-only audit commit', t => {
    const fixture = createRepository(t);
    const implementation = fixture.implement('feat: sixth implementation', 9);

    const result = regenerateCapabilityAudit(fixture.repositoryRoot, cli({
        assignments: [{ left: implementation, right: 'MAIN-DEMO-CAPABILITY' }],
        commitMessage: 'docs: audit the sixth implementation',
    }));

    assert.equal(result.committed, true);
    assert.equal(git(fixture.repositoryRoot, ['show', '-s', '--format=%s', 'HEAD']),
        'docs: audit the sixth implementation');
    assert.ok(git(fixture.repositoryRoot, ['show', '-s', '--format=%B', 'HEAD'])
        .includes('Skill-Harvest: none'));
    assert.deepEqual(
        git(fixture.repositoryRoot, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).split('\n'),
        ['docs/testing/main-capability-coverage.json'],
        'the audit commit must touch the manifest and nothing else'
    );
    assert.equal(git(fixture.repositoryRoot, ['status', '--porcelain']), '');
});

test('ARCH-MAIN-CAPABILITY-CURRENCY-001 requires and validates the skill harvest decision', t => {
    const fixture = createRepository(t);
    const implementation = fixture.implement('feat: seventh implementation', 10);
    const assignments = [{ left: implementation, right: 'MAIN-DEMO-CAPABILITY' }];

    assert.throws(
        () => regenerateCapabilityAudit(fixture.repositoryRoot, cli({ assignments, harvest: null })),
        /--harvest is required/
    );
    assert.throws(
        () => regenerateCapabilityAudit(fixture.repositoryRoot, cli({ assignments, harvest: 'maybe' })),
        /--harvest expects none or updated:<paths>/
    );
    assert.throws(
        () => regenerateCapabilityAudit(fixture.repositoryRoot, cli({ assignments, harvest: 'updated:' })),
        /expects at least one \.skills\/ path/
    );
    assert.throws(
        () => regenerateCapabilityAudit(fixture.repositoryRoot, cli({ assignments, harvest: 'updated:scripts/foo.js' })),
        /must live under \.skills\//
    );
    assert.throws(
        () => regenerateCapabilityAudit(fixture.repositoryRoot, cli({ assignments, harvest: 'updated:.skills/missing' })),
        /\.skills\/missing does not exist/
    );

    fixture.write('.skills/demo-skill/SKILL.md', '# demo\n');
    const result = regenerateCapabilityAudit(fixture.repositoryRoot, cli({
        assignments,
        harvest: 'updated:.skills/demo-skill',
        commitMessage: 'docs: audit the seventh implementation',
    }));
    assert.equal(result.committed, true);
    assert.ok(git(fixture.repositoryRoot, ['show', '-s', '--format=%B', 'HEAD'])
        .includes('Skill-Harvest: updated .skills/demo-skill'));
});

test('ARCH-MAIN-CAPABILITY-CURRENCY-001 parseArguments reads the CLI surface', () => {
    assert.deepEqual(parseArguments([
        '--assign', 'abc123=MAIN-DEMO-CAPABILITY',
        '--assign', 'def456=MAIN-OTHER-CAPABILITY',
        '--behavior', 'MAIN-DEMO-CAPABILITY=MAIN-DEMO-BEHAVIOR-001',
        '--harvest', 'updated:.skills/demo-skill',
        '--commit', 'docs: audit message',
        '--dry-run',
    ]), {
        assignments: [
            { left: 'abc123', right: 'MAIN-DEMO-CAPABILITY' },
            { left: 'def456', right: 'MAIN-OTHER-CAPABILITY' },
        ],
        behaviors: [{ left: 'MAIN-DEMO-CAPABILITY', right: 'MAIN-DEMO-BEHAVIOR-001' }],
        commitMessage: 'docs: audit message',
        dryRun: true,
        harvest: 'updated:.skills/demo-skill',
    });
    assert.throws(() => parseArguments(['--assign', 'no-equals']), AuditRegenerationError);
    assert.throws(() => parseArguments(['--bogus']), AuditRegenerationError);
    assert.throws(() => parseArguments(['--harvest']), AuditRegenerationError);
});


test('ARCH-MAIN-CAPABILITY-CURRENCY-001 prunes rebase-rewritten assignments and exemptions', t => {
    const fixture = createRepository(t);
    const implementation = fixture.implement('feat: second implementation', 3);
    // Simulate the post-rebase state: the manifest still lists SHAs that a
    // rebase rewrote away (they no longer exist in the audited range).
    const staleAssignment = '9'.repeat(40);
    const staleExemption = '8'.repeat(40);
    fixture.write(COVERAGE_PATH, fixture.readCoverage()
        .replace(
            `                "${fixture.firstImplementation}"\n            ],`,
            `                "${fixture.firstImplementation}",\n                "${staleAssignment}"\n            ],`)
        .replace(
            '"ignoredDocumentationCommits": []',
            `"ignoredDocumentationCommits": [\n            "${staleExemption}"\n        ]`));

    const output = [];
    regenerateCapabilityAudit(fixture.repositoryRoot, cli({
        assignments: [{ left: implementation, right: 'MAIN-DEMO-CAPABILITY' }],
    }), line => output.push(line));

    assert.ok(output.some(line => line.includes(`prune stale assignment ${staleAssignment}`)),
        JSON.stringify(output));
    assert.ok(output.some(line => line.includes(`prune stale documentation exemption ${staleExemption}`)),
        JSON.stringify(output));
    assert.ok(output.some(line => line.includes('validation passed')), JSON.stringify(output));
    const edited = JSON.parse(fixture.readCoverage());
    const capability = edited.capabilities.find(entry => entry.id === 'MAIN-DEMO-CAPABILITY');
    assert.deepEqual(capability.commits, [fixture.firstImplementation, implementation]);
    assert.deepEqual(edited.audit.ignoredDocumentationCommits, [fixture.seedAuditCommit]);
});
