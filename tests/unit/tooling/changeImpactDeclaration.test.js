'use strict';

// ARCH-PR-CHANGE-IMPACT-GATE-001: the Change Impact Declaration parser and
// evaluator (review R4). The merge-approval gate must reject missing, stale,
// under-reported, over-reported, or malformed declarations.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    evaluateChangeImpactDeclaration,
    parseChangeImpactDeclaration,
} = require('../../../scripts/lib/changeImpactDeclaration');
const {
    collectArchitectureDiff,
} = require('../../../scripts/architecture/reportArchitectureDiff');
const {
    capabilityAssignments,
    collectChangeImpactContext,
} = require('../../../scripts/lib/changeImpactContext');
const { buildDeclaration } = require('../../../scripts/generate-change-impact-declaration');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const HEAD_SHA = 'a'.repeat(40);

function bodyWith(declaration) {
    return `## Summary\n\nfixture\n\n## Change impact declaration\n\n`
        + '```change-impact-declaration\n'
        + `${JSON.stringify(declaration, null, 2)}\n`
        + '```\n\n## Skill harvest\n\nnone\n';
}

function validDeclaration(overrides = {}) {
    return {
        headSha: HEAD_SHA,
        capabilities: ['MAIN-ARCHITECTURE-HARNESS'],
        modules: ['MOD-A'],
        invariants: ['ARCH-X-001'],
        policyDelta: 'tightening',
        baselineWaiverDelta: 'zero',
        newFiles: [{ path: 'src/a/new.ts', module: 'MOD-A', reason: 'owns the new codec' }],
        behaviors: ['ARCH-CHANGE-GATE-001'],
        semanticImpact: {
            stateAuthority: false,
            writerSet: false,
            protocol: false,
            persistence: false,
            identity: false,
            recovery: false,
        },
        coordinators: [],
        verification: 'focused unit tests + policy lane',
        ...overrides,
    };
}

function truth(overrides = {}) {
    return {
        body: bodyWith(validDeclaration()),
        headSha: HEAD_SHA,
        classification: 'tightening',
        report: {
            touchedModules: { 'MOD-A': ['src/a/a.ts'] },
            changedInvariantIds: ['ARCH-X-001'],
            newClassifiedFiles: [{ path: 'src/a/new.ts', module: 'MOD-A' }],
            protectedTouched: [],
            policyDelta: { invariantChanges: {}, invariantsRemoved: [] },
        },
        assignedCapabilities: ['MAIN-ARCHITECTURE-HARNESS'],
        expectedBehaviors: ['ARCH-CHANGE-GATE-001'],
        ...overrides,
    };
}

// ── parser ────────────────────────────────────────────────────────────

test('ARCH-PR-CHANGE-IMPACT-GATE-001 parser accepts a valid declaration and normalizes it', () => {
    const { declaration, errors } = parseChangeImpactDeclaration(bodyWith(validDeclaration({
        modules: ['MOD-B', 'MOD-A'],
        newFiles: [
            { path: 'src/b.ts', module: 'MOD-B', reason: '  second  ' },
            { path: 'src/a.ts', module: 'MOD-A', reason: 'first' },
        ],
    })));
    assert.deepEqual(errors, []);
    assert.deepEqual(declaration.modules, ['MOD-A', 'MOD-B']);
    assert.deepEqual(declaration.newFiles.map(entry => entry.path), ['src/a.ts', 'src/b.ts']);
    assert.equal(declaration.newFiles[1].reason, 'second');
});

test('ARCH-PR-CHANGE-IMPACT-GATE-001 controlled mutation: missing or duplicated block is rejected', () => {
    assert.ok(parseChangeImpactDeclaration('no block here').errors[0].includes('no ```change-impact-declaration'));
    const two = `${bodyWith(validDeclaration())}\n${bodyWith(validDeclaration())}`;
    assert.ok(parseChangeImpactDeclaration(two).errors[0].includes('multiple'));
});

test('ARCH-PR-CHANGE-IMPACT-GATE-001 controlled mutation: malformed JSON and non-object roots are rejected', () => {
    assert.ok(parseChangeImpactDeclaration('```change-impact-declaration\n{oops\n```').errors[0]
        .includes('not valid JSON'));
    assert.ok(parseChangeImpactDeclaration('```change-impact-declaration\n[]\n```').errors[0]
        .includes('must be a JSON object'));
});

test('ARCH-PR-CHANGE-IMPACT-GATE-001 controlled mutation: schema violations are rejected', () => {
    const cases = {
        'unknown key': validDeclaration({ surprise: true }),
        'bad headSha': validDeclaration({ headSha: 'HEAD' }),
        'capabilities not an array': validDeclaration({ capabilities: 'MAIN-X' }),
        'modules not an array': validDeclaration({ modules: 'MOD-A' }),
        'invariants not an array': validDeclaration({ invariants: 'ARCH-X-001' }),
        'bad policyDelta': validDeclaration({ policyDelta: 'none' }),
        'bad baselineWaiverDelta': validDeclaration({ baselineWaiverDelta: 'none' }),
        'newFiles not an array': validDeclaration({ newFiles: {} }),
        'newFiles entry not an object': validDeclaration({ newFiles: ['src/a.ts'] }),
        'newFiles entry missing module': validDeclaration({ newFiles: [{ path: 'src/a.ts', reason: 'r' }] }),
        'newFiles entry empty reason': validDeclaration({ newFiles: [{ path: 'src/a.ts', module: 'MOD-A', reason: '  ' }] }),
        'behaviors not an array': validDeclaration({ behaviors: 'X-001' }),
        'semanticImpact missing key': validDeclaration({
            semanticImpact: { stateAuthority: false },
        }),
        'semanticImpact unknown key': validDeclaration({
            semanticImpact: {
                stateAuthority: false, writerSet: false, protocol: false,
                persistence: false, identity: false, recovery: false, surprise: true,
            },
        }),
        'semanticImpact non-boolean': validDeclaration({
            semanticImpact: {
                stateAuthority: 'yes', writerSet: false, protocol: false,
                persistence: false, identity: false, recovery: false,
            },
        }),
        'coordinators not an array': validDeclaration({ coordinators: 'none' }),
        'empty verification': validDeclaration({ verification: ' ' }),
    };
    for (const [name, declaration] of Object.entries(cases)) {
        const { declaration: parsed, errors } = parseChangeImpactDeclaration(bodyWith(declaration));
        assert.equal(parsed, null, name);
        assert.ok(errors.length > 0, name);
    }
});

// ── evaluator ─────────────────────────────────────────────────────────

test('ARCH-PR-CHANGE-IMPACT-GATE-001 a declaration matching the regenerated truth passes', () => {
    const { errors } = evaluateChangeImpactDeclaration(truth());
    assert.deepEqual(errors, []);
});

test('ARCH-PR-CHANGE-IMPACT-GATE-001 controlled mutation: a stale headSha is rejected', () => {
    const { errors } = evaluateChangeImpactDeclaration(truth({ headSha: 'b'.repeat(40) }));
    assert.ok(errors.some(error => error.includes('stale') && error.includes('b'.repeat(40))),
        JSON.stringify(errors));
});

test('ARCH-PR-CHANGE-IMPACT-GATE-001 controlled mutation: under- and over-reported fields are rejected', () => {
    const under = evaluateChangeImpactDeclaration(truth({
        body: bodyWith(validDeclaration({ modules: [], invariants: [], capabilities: [] })),
    }));
    assert.ok(under.errors.some(error => error.includes('under-reports touched modules: MOD-A')));
    assert.ok(under.errors.some(error => error.includes('under-reports changed invariants: ARCH-X-001')));
    assert.ok(under.errors.some(error => error.includes('under-reports capabilities: MAIN-ARCHITECTURE-HARNESS')));

    const over = evaluateChangeImpactDeclaration(truth({
        body: bodyWith(validDeclaration({ modules: ['MOD-A', 'MOD-B'], capabilities: ['MAIN-ARCHITECTURE-HARNESS', 'MAIN-TODO'] })),
    }));
    assert.ok(over.errors.some(error => error.includes('over-reports touched modules: MOD-B')));
    assert.ok(over.errors.some(error => error.includes('over-reports capabilities: MAIN-TODO')));
});

test('ARCH-PR-CHANGE-IMPACT-GATE-001 controlled mutation: new-file coverage is exact', () => {
    const missing = evaluateChangeImpactDeclaration(truth({
        body: bodyWith(validDeclaration({ newFiles: [] })),
    }));
    assert.ok(missing.errors.some(error => error.includes('under-reports new classified files')));
    const extra = evaluateChangeImpactDeclaration(truth({
        body: bodyWith(validDeclaration({
            newFiles: [
                { path: 'src/a/new.ts', module: 'MOD-A', reason: 'owns the new codec' },
                { path: 'src/a/other.ts', module: 'MOD-A', reason: 'phantom' },
            ],
        })),
    }));
    assert.ok(extra.errors.some(error => error.includes('over-reports new classified files')));
    const wrongModule = evaluateChangeImpactDeclaration(truth({
        body: bodyWith(validDeclaration({
            newFiles: [{ path: 'src/a/new.ts', module: 'MOD-B', reason: 'misplaced' }],
        })),
    }));
    assert.ok(wrongModule.errors.some(error => error.includes('classifies it as MOD-A')));
});

test('ARCH-PR-CHANGE-IMPACT-GATE-001 controlled mutation: policy delta and baseline/waiver misreports are rejected', () => {
    const wrongDelta = evaluateChangeImpactDeclaration(truth({
        body: bodyWith(validDeclaration({ policyDelta: 'product-only' })),
    }));
    assert.ok(wrongDelta.errors.some(error => error.includes('claims policyDelta product-only')
        && error.includes('computes tightening')));
    const wrongBaseline = evaluateChangeImpactDeclaration(truth({
        body: bodyWith(validDeclaration({ baselineWaiverDelta: 'changed' })),
    }));
    assert.ok(wrongBaseline.errors.some(error => error.includes('baselineWaiverDelta changed')
        && error.includes('zero')));
    const baselineTouched = evaluateChangeImpactDeclaration(truth({
        report: {
            touchedModules: { 'MOD-A': ['src/a/a.ts'] },
            changedInvariantIds: ['ARCH-X-001'],
            newClassifiedFiles: [{ path: 'src/a/new.ts', module: 'MOD-A' }],
            protectedTouched: ['.ci/architecture-debt-baseline.json'],
        },
    }));
    assert.ok(baselineTouched.errors.some(error => error.includes('baselineWaiverDelta zero')
        && error.includes('changed')));
});

// ── capability assignment glue ────────────────────────────────────────

test('ARCH-PR-CHANGE-IMPACT-GATE-001 capabilityAssignments maps commits and flags unaudited ones', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-audit-'));
    fs.mkdirSync(path.join(root, 'docs/testing'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/testing/main-capability-coverage.json'), JSON.stringify({
        version: 1,
        audit: { base: 'x', head: 'y', ignoredDocumentationCommits: ['d'.repeat(40)] },
        capabilities: [{ id: 'MAIN-TEST-001', commits: ['a'.repeat(40)] }],
    }));
    const filesByCommit = {
        ['a'.repeat(40)]: ['src/alpha/a.ts'],
        ['d'.repeat(40)]: ['docs/anything.md'],
        ['e'.repeat(40)]: ['src/alpha/b.ts'],
        // The audit commit of the current PR: not yet registered in the audit
        // file, but its own diff is documentation-only.
        ['f'.repeat(40)]: ['docs/testing/main-capability-coverage.json'],
    };
    const { assignedCapabilities, errors } = capabilityAssignments(
        root,
        ['a'.repeat(40), 'd'.repeat(40), 'e'.repeat(40), 'f'.repeat(40)],
        { listCommitFiles: sha => filesByCommit[sha] || [] },
    );
    assert.deepEqual(assignedCapabilities, ['MAIN-TEST-001']);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('e'.repeat(40)));

    const missing = capabilityAssignments(root, ['f'.repeat(40)],
        { listCommitFiles: () => ['src/alpha/c.ts'] });
    assert.equal(missing.assignedCapabilities.length, 0);

    const noAudit = capabilityAssignments(fs.mkdtempSync(path.join(os.tmpdir(), 'impact-empty-')), ['a'.repeat(40)]);
    assert.ok(noAudit.errors[0].includes('missing'));
});

test('ARCH-PR-CHANGE-IMPACT-GATE-001 a HEAD self-diff yields an empty, valid context and declaration', () => {
    const context = collectChangeImpactContext({ rootDirectory: repoRoot, baseRef: 'HEAD' });
    assert.equal(context.classification, 'product-only');
    assert.deepEqual(context.assignedCapabilities, []);
    assert.deepEqual(context.errors, []);
    const { block, declaration } = buildDeclaration({ rootDirectory: repoRoot, baseRef: 'HEAD' });
    assert.deepEqual(declaration.modules, []);
    assert.deepEqual(declaration.newFiles, []);
    assert.equal(declaration.policyDelta, 'product-only');
    assert.equal(declaration.baselineWaiverDelta, 'zero');
    const { declaration: parsed, errors } = parseChangeImpactDeclaration(block);
    // The generated block carries an empty verification placeholder, which
    // is schema-rejected until the author fills it (the friction is the
    // point: verification is never silent).
    assert.equal(parsed, null);
    assert.ok(errors.some(error => error.includes('verification')));
    const completed = JSON.parse(block.replace('```change-impact-declaration\n', '').replace(/\n```$/, ''));
    completed.verification = 'HEAD self-diff: nothing to verify';
    const completedBlock = '```change-impact-declaration\n'
        + `${JSON.stringify(completed, null, 2)}\n` + '```';
    assert.deepEqual(evaluateChangeImpactDeclaration({
        body: completedBlock,
        headSha: context.headSha,
        classification: context.classification,
        report: context.report,
        assignedCapabilities: context.assignedCapabilities,
        expectedBehaviors: context.expectedBehaviors,
    }).errors, []);
    assert.ok(!parsed);
});


// ── round-2 review Important 2: declaration completeness ─────────────

test('ARCH-PR-CHANGE-IMPACT-GATE-001 behaviors must equal the regenerated set', () => {
    const missing = evaluateChangeImpactDeclaration(truth({
        body: bodyWith(validDeclaration({ behaviors: [] })),
    }));
    assert.ok(missing.errors.some(error => error.includes('under-reports behaviors')));
    const extra = evaluateChangeImpactDeclaration(truth({
        body: bodyWith(validDeclaration({ behaviors: ['ARCH-CHANGE-GATE-001', 'X-OTHER-001'] })),
    }));
    assert.ok(extra.errors.some(error => error.includes('over-reports behaviors')));
});

test('ARCH-PR-CHANGE-IMPACT-GATE-001 semantic impact flags are checked where mechanically derivable', () => {
    const withAuthorityChange = truth({
        report: {
            touchedModules: { 'MOD-A': ['src/a/a.ts'] },
            changedInvariantIds: ['ARCH-X-001'],
            newClassifiedFiles: [{ path: 'src/a/new.ts', module: 'MOD-A' }],
            protectedTouched: [],
            policyDelta: {
                invariantChanges: { 'ARCH-X-001': { authorityChanged: true, writersAdded: [], writersRemoved: [] } },
                invariantsRemoved: [],
            },
        },
    });
    // Declaration claims stateAuthority: false but the diff changed an authority.
    const denied = evaluateChangeImpactDeclaration(withAuthorityChange);
    assert.ok(denied.errors.some(error => error.includes('semanticImpact.stateAuthority')
        && error.includes('true')), JSON.stringify(denied.errors));
    const honest = evaluateChangeImpactDeclaration({
        ...withAuthorityChange,
        body: bodyWith(validDeclaration({
            semanticImpact: {
                stateAuthority: true, writerSet: false, protocol: false,
                persistence: false, identity: false, recovery: false,
            },
        })),
    });
    assert.deepEqual(honest.errors, []);
});

test('ARCH-PR-CHANGE-IMPACT-GATE-001 a multi-module change must name its coordinators', () => {
    const multiModule = truth({
        body: bodyWith(validDeclaration({ modules: ['MOD-A', 'MOD-B'] })),
        report: {
            touchedModules: { 'MOD-A': ['src/a/a.ts'], 'MOD-B': ['src/b/b.ts'] },
            changedInvariantIds: ['ARCH-X-001'],
            newClassifiedFiles: [{ path: 'src/a/new.ts', module: 'MOD-A' }],
            protectedTouched: [],
            policyDelta: { invariantChanges: {}, invariantsRemoved: [] },
        },
    });
    const denied = evaluateChangeImpactDeclaration(multiModule);
    assert.ok(denied.errors.some(error => error.includes('coordinators')));
    const named = evaluateChangeImpactDeclaration({
        ...multiModule,
        body: bodyWith(validDeclaration({
            modules: ['MOD-A', 'MOD-B'],
            coordinators: ['src/worktrees/index.ts'],
        })),
    });
    assert.deepEqual(named.errors, []);
});


// ── round-2 review Important 2: behavior diff + base∪head modules ────

test('ARCH-PR-CHANGE-IMPACT-GATE-001 collectArchitectureDiff diffs behavior contracts and attributes deletes/renames to the base module', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'impact-diff-'));
    const write = (relative, value) => {
        fs.mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
        fs.writeFileSync(path.join(root, relative),
            typeof value === 'string' ? value : JSON.stringify(value, null, 4) + '\n');
    };
    write('src/alpha/a.ts', '// a\n');
    write('docs/testing/architecture-modules.json', {
        version: 1, scope: { roots: ['src'] },
        modules: [{
            id: 'MOD-ALPHA', title: 'A', purpose: 'fixture',
            source: { include: ['src/**'], exclude: [] }, publicEntrypoints: ['src/**'],
            mayDependOn: [], roles: [{ role: 'application', include: ['src/**'] }],
            productCapabilities: ['MAIN-TEST-001'],
        }],
    });
    write('docs/testing/main-capability-coverage.json',
        { version: 1, capabilities: [{ id: 'MAIN-TEST-001' }] });
    const contract = { id: 'B-001', domain: 'd', title: 't', priority: 'P1', status: 'automated' };
    write('docs/testing/behavior-contracts.json', [{ ...contract, title: 'changed title' }]);
    const git = {
        changedFiles: () => [
            { status: 'M', path: 'docs/testing/behavior-contracts.json' },
            { status: 'D', path: 'src/alpha/gone.ts' },
            { status: 'R', path: 'src/alpha/new.ts', oldPath: 'src/alpha/old.ts' },
        ],
        listFiles: () => [],
        fileAt: (ref, relativePath) => {
            if (ref !== 'base') {
                const absolute = path.join(root, relativePath);
                return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : null;
            }
            if (relativePath.endsWith('behavior-contracts.json')) {
                return JSON.stringify([contract]);
            }
            if (relativePath.endsWith('architecture-modules.json')) {
                return JSON.stringify({
                    version: 1, scope: { roots: ['src'] },
                    modules: [{
                        id: 'MOD-ALPHA', title: 'A', purpose: 'fixture',
                        source: { include: ['src/**'], exclude: [] }, publicEntrypoints: ['src/**'],
                        mayDependOn: [], roles: [{ role: 'application', include: ['src/**'] }],
                        productCapabilities: ['MAIN-TEST-001'],
                    }],
                });
            }
            return null;
        },
    };
    const report = collectArchitectureDiff({ rootDirectory: root, baseRef: 'base', git });
    assert.deepEqual(report.changedBehaviorIds, ['B-001'],
        'modified behavior contracts surface by id');
    assert.deepEqual(report.removedClassifiedFiles, [{ path: 'src/alpha/gone.ts', module: 'MOD-ALPHA' }],
        'a deleted production file still reports its base module');
    assert.deepEqual(Object.keys(report.touchedModules), ['MOD-ALPHA']);
    assert.ok(report.touchedModules['MOD-ALPHA'].includes('src/alpha/old.ts'),
        'a rename registers the source path in the module');
});
