'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
    addUntrackedChangedLines,
    changedCoveragePercentage,
    collectChangedLineCoverage,
    isUninstrumentedByDesign,
    listUntrackedFiles,
    main,
    parseChangedLines,
    readThreshold,
    resolveDiffBase,
} = require('../../../scripts/check-changed-coverage');

test('COVERAGE-CHANGED-CODE-001 includes every line of eligible untracked code', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pivot-untracked-coverage-'));
    try {
        fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
        fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(root, 'scripts/new-check.js'), 'first();\nsecond();\n');
        fs.writeFileSync(path.join(root, 'docs/note.js'), 'ignored();\n');
        const files = listUntrackedFiles(root, () => (
            'scripts/new-check.js\0docs/note.js\0'
        ));
        const changed = addUntrackedChangedLines(root, new Map(), files);
        assert.deepEqual([...changed.keys()], ['scripts/new-check.js']);
        assert.deepEqual([...changed.get('scripts/new-check.js')], [1, 2, 3]);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('COVERAGE-CHANGED-CODE-001 parses added and replaced lines without counting deletions', () => {
    const changed = parseChangedLines([
        'diff --git a/src/example.ts b/src/example.ts',
        '--- a/src/example.ts',
        '+++ b/src/example.ts',
        '@@ -2,2 +2,3 @@',
        '-old',
        '+new',
        '+added',
        ' context',
        '@@ -10 +11,0 @@',
        '-deleted',
    ].join('\n'));
    assert.deepEqual([...changed.get('src/example.ts')], [2, 3]);
});

test('COVERAGE-CHANGED-CODE-001 reports uncovered executable changed lines and missing instrumentation', () => {
    const root = path.resolve('/repo');
    const coverage = {
        [path.join(root, 'src/example.ts')]: {
            statementMap: {
                0: { start: { line: 2 }, end: { line: 2 } },
                1: { start: { line: 3 }, end: { line: 3 } },
                2: { start: { line: 8 }, end: { line: 8 } },
            },
            s: { 0: 1, 1: 0, 2: 0 },
        },
    };
    const result = collectChangedLineCoverage(root, coverage, new Map([
        ['src/example.ts', new Set([2, 3, 7])],
        ['src/missing.ts', new Set([1])],
        ['tests/example.test.js', new Set([1])],
    ]));
    assert.deepEqual(result, {
        total: 2,
        covered: 1,
        files: [{
            file: 'src/example.ts',
            total: 2,
            covered: 1,
            uncoveredLines: [3],
        }],
        missingFiles: ['src/missing.ts'],
    });
    assert.equal(changedCoveragePercentage(result), 50);
});

test('COVERAGE-CHANGED-CODE-001 exempts only the paths the suite structurally cannot instrument', () => {
    assert.equal(isUninstrumentedByDesign('src/dashboard.ts'), true);
    assert.equal(isUninstrumentedByDesign('scripts/run-ai-session-safety-checks.js'), true);
    assert.equal(isUninstrumentedByDesign('src/webview/conversationViewerScripts.js'), true);
    assert.equal(isUninstrumentedByDesign('src/services/ntc.ts'), true);
    assert.equal(isUninstrumentedByDesign('src/workspaces/types.ts'), true,
        'a statement-less workspace type module cannot appear in V8 coverage');
    assert.equal(isUninstrumentedByDesign('src/services/colorService.ts'), false);
    assert.equal(isUninstrumentedByDesign('src/webview/webviewContent.ts'), false);
    assert.equal(isUninstrumentedByDesign('src/aiSessions/dashboardController.ts'), false);
    assert.equal(isUninstrumentedByDesign('scripts/lib/behaviorCatalog.js'), false);
    assert.equal(isUninstrumentedByDesign('scripts/run-nested/helper.js'), false);

    const root = path.resolve('/repo');
    const diff = [
        'diff --git a/src/dashboard.ts b/src/dashboard.ts',
        '--- a/src/dashboard.ts',
        '+++ b/src/dashboard.ts',
        '@@ -1,0 +1,1 @@',
        '+wireController();',
        'diff --git a/src/missing.ts b/src/missing.ts',
        '--- a/src/missing.ts',
        '+++ b/src/missing.ts',
        '@@ -1,0 +1,1 @@',
        '+untested();',
    ].join('\n');
    const exempt = collectChangedLineCoverage(root, {}, parseChangedLines(diff));
    assert.deepEqual(exempt.missingFiles, ['src/missing.ts'],
        'an exempt path is skipped while a genuinely uninstrumented one still fails');

    const output = [];
    const logger = { error: message => output.push(message), log: () => undefined };
    assert.equal(main({
        root,
        coverage: {},
        threshold: 80,
        base: 'base',
        diff: diff.split('\n').slice(0, 5).join('\n'),
        logger,
    }), 0, 'a wiring-only dashboard change must not fail the gate');
});

test('COVERAGE-CHANGED-CODE-001 treats type-only diffs as fully covered and validates thresholds', () => {
    assert.equal(changedCoveragePercentage({ total: 0, covered: 0 }), 100);
    assert.equal(readThreshold({ lines: 80 }), 80);
    assert.throws(() => readThreshold({ lines: 101 }), /between 0 and 100/);
    assert.throws(() => readThreshold({}), /between 0 and 100/);
});

test('COVERAGE-CHANGED-CODE-001 resolves an explicit reachable base with staged worktree changes', () => {
    assert.equal(resolveDiffBase(process.cwd(), {
        COVERAGE_DIFF_BASE: 'origin/main',
    }), 'origin/main');
});

test('COVERAGE-CHANGED-CODE-001 evaluates pass, threshold failure, and missing instrumentation without process mutation', () => {
    const root = path.resolve('/repo');
    const diff = [
        'diff --git a/src/example.ts b/src/example.ts',
        '--- a/src/example.ts',
        '+++ b/src/example.ts',
        '@@ -1,0 +1,2 @@',
        '+covered();',
        '+uncovered();',
    ].join('\n');
    const coverage = {
        [path.join(root, 'src/example.ts')]: {
            statementMap: {
                0: { start: { line: 1 }, end: { line: 1 } },
                1: { start: { line: 2 }, end: { line: 2 } },
            },
            s: { 0: 1, 1: 0 },
        },
    };
    const output = [];
    const logger = {
        log: value => output.push(`log:${value}`),
        error: value => output.push(`error:${value}`),
    };
    assert.equal(main({
        root, coverage, threshold: 50, base: 'base', diff, logger,
    }), 0);
    assert.match(output.at(-1), /50\.00% \(1\/2\)/);

    assert.equal(main({
        root, coverage, threshold: 80, base: 'base', diff, logger,
    }), 1);
    assert.match(output.at(-1), /below 80\.00%/);

    assert.equal(main({
        root,
        coverage: {},
        threshold: 80,
        base: 'base',
        diff,
        logger,
    }), 1);
    assert.match(output.at(-1), /not instrumented/);
});

test('COVERAGE-CHANGED-CODE-001 reads unbounded git output through an explicit large buffer', () => {
    // Large feature branches diff minified media bundles whose single lines
    // already exceed the 1MB execFileSync default, so the gate must opt into
    // a generous buffer instead of dying with ENOBUFS mid-CI.
    const root = path.resolve(__dirname, '../../..');
    const source = fs.readFileSync(
        path.join(root, 'scripts/check-changed-coverage.js'),
        'utf8'
    );
    const constant = source.match(/GIT_OUTPUT_MAX_BUFFER\s*=\s*(\d+)\s*\*\s*(\d+)\s*\*\s*(\d+)/);
    assert.ok(constant, 'the gate must define an explicit GIT_OUTPUT_MAX_BUFFER');
    const bytes = Number(constant[1]) * Number(constant[2]) * Number(constant[3]);
    assert.ok(bytes >= 32 * 1024 * 1024, 'the git output buffer must be at least 32MB');
    const diffCall = source.match(
        /execFileSync\(\s*'git',\s*\[\s*'diff'[\s\S]*?\{[^}]*maxBuffer:\s*GIT_OUTPUT_MAX_BUFFER[^}]*\}/
    );
    assert.ok(diffCall, 'the branch diff read must pass GIT_OUTPUT_MAX_BUFFER');
    const lsFilesCall = source.match(
        /execFileSync\(\s*'git',\s*\[\s*'ls-files'[\s\S]*?\{[^}]*maxBuffer:\s*GIT_OUTPUT_MAX_BUFFER[^}]*\}/
    );
    assert.ok(lsFilesCall, 'the untracked-file listing must pass GIT_OUTPUT_MAX_BUFFER');
});

test('COVERAGE-CHANGED-CODE-001 remains wired after JSON coverage production in every Linux coverage gate', () => {
    const root = path.resolve(__dirname, '../../..');
    const packageJson = JSON.parse(fs.readFileSync(
        path.join(root, 'package.json'),
        'utf8'
    ));
    assert.match(packageJson.scripts['test:coverage:run'], /--reporter=json\b/);
    assert.match(
        packageJson.scripts['test:coverage:ci'],
        /check-coverage-baseline\.js && node scripts\/check-changed-coverage\.js$/
    );
    assert.match(
        packageJson.scripts['test:ci:linux'],
        /check-coverage-baseline\.js && node scripts\/check-changed-coverage\.js$/
    );
    const workflow = fs.readFileSync(
        path.join(root, '.github/workflows/verify.yml'),
        'utf8'
    );
    assert.match(workflow, /fetch-depth: 0/);
    assert.match(workflow, /npm run test:ci:linux/);
    assert.match(
        workflow,
        /COVERAGE_DIFF_BASE: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/
    );
    const releasePackagingGate = fs.readFileSync(
        path.join(root, 'scripts/run-release-packaging-checks.js'),
        'utf8'
    );
    assert.match(
        releasePackagingGate,
        /check-coverage-baseline\.js && node scripts\/check-changed-coverage\.js'/
    );
});
