'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const checkerPath = path.resolve(__dirname, '../../../scripts/check-coverage-baseline.js');
const {
    compareCoverageBaseline,
    readCoverageTotals,
    validateCoverageBaseline,
    writeCoverageBaseline,
    collectCoverageFailures,
    findUninstrumentedFiles,
    REQUIRED_INSTRUMENTED_FILES,
} = require(checkerPath);

function coverageSummary(metrics) {
    return {
        total: Object.fromEntries(Object.entries(metrics).map(([metric, pct]) => [metric, { pct }])),
    };
}

const baseline = {
    lines: 80,
    branches: 70,
    functions: 60,
    statements: 90,
};

test('COVERAGE-BASELINE-001 reads and rounds total coverage metrics to two decimals', () => {
    assert.deepEqual(readCoverageTotals(coverageSummary({
        lines: 80.123,
        branches: 70.456,
        functions: 60.789,
        statements: 90.001,
    })), {
        lines: 80.12,
        branches: 70.46,
        functions: 60.79,
        statements: 90,
    });
});

test('COVERAGE-BASELINE-002 permits coverage that equals the baseline', () => {
    assert.deepEqual(compareCoverageBaseline(baseline, { ...baseline }), []);
});

test('COVERAGE-BASELINE-003 permits coverage that increases from the baseline', () => {
    assert.deepEqual(compareCoverageBaseline(baseline, {
        lines: 80.01,
        branches: 70.01,
        functions: 60.01,
        statements: 90.01,
    }), []);
});

for (const metric of Object.keys(baseline)) {
    test(`COVERAGE-BASELINE-004 rejects a 0.01 decrease in ${metric}`, () => {
        const current = { ...baseline, [metric]: baseline[metric] - 0.01 };

        assert.deepEqual(compareCoverageBaseline(baseline, current), [
            `${metric} coverage decreased from ${baseline[metric].toFixed(2)}% to ${current[metric].toFixed(2)}%`,
        ]);
    });
}

test('COVERAGE-BASELINE-005 rejects malformed coverage summaries', () => {
    assert.throws(() => readCoverageTotals(null), /coverage summary must be an object/);
    assert.throws(() => readCoverageTotals(coverageSummary({
        lines: 80,
        branches: '70',
        functions: 60,
        statements: 90,
    })), /branches coverage percentage must be a finite number/);
});

test('COVERAGE-BASELINE-006 rejects coverage summaries without total', () => {
    assert.throws(() => readCoverageTotals({}), /coverage summary must include a total entry/);
});

for (const metric of Object.keys(baseline)) {
    test(`COVERAGE-BASELINE-007 rejects a stored baseline without a numeric ${metric} metric`, () => {
        const missing = { ...baseline };
        delete missing[metric];

        for (const invalidBaseline of [
            missing,
            { ...baseline, [metric]: null },
            { ...baseline, [metric]: '80' },
            { ...baseline, [metric]: Infinity },
            { ...baseline, [metric]: NaN },
        ]) {
            assert.throws(
                () => validateCoverageBaseline(invalidBaseline),
                new RegExp(`${metric} baseline coverage percentage must be a finite number`)
            );
        }
    });
}

test('COVERAGE-BASELINE-008 writes baselines atomically through the shared JSON helper', () => {
    const operations = [];
    const fileSystem = {
        closeSync: () => operations.push('close'),
        fsyncSync: () => operations.push('fsync'),
        mkdirSync: () => operations.push('mkdir'),
        openSync: () => 7,
        renameSync: () => operations.push('rename'),
        unlinkSync: () => operations.push('unlink'),
        writeFileSync: () => operations.push('write'),
    };

    writeCoverageBaseline('/repository/.ci/coverage-baseline.json', baseline, fileSystem);

    assert.deepEqual(operations, ['mkdir', 'write', 'fsync', 'close', 'rename']);
});

test('COVERAGE-BASELINE-009 prevents CI from writing a coverage baseline', () => {
    const result = childProcess.spawnSync(process.execPath, [checkerPath, '--write-baseline'], {
        cwd: path.resolve(__dirname, '../../..'),
        encoding: 'utf8',
        env: { ...process.env, CI: 'true' },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot write the coverage baseline in CI/);
});

test('COVERAGE-BASELINE-INSTRUMENTATION-001 rejects a summary missing a file that must stay instrumented', () => {
    const summary = {
        total: {},
        '/repo/src/aiSessions/dashboardController.ts': {},
    };

    assert.deepEqual(
        findUninstrumentedFiles(summary, ['src/dashboard.ts', 'src/aiSessions/dashboardController.ts']),
        ['src/dashboard.ts']
    );
});

test('COVERAGE-BASELINE-INSTRUMENTATION-001 accepts a summary that instruments every required file', () => {
    const summary = {
        total: {},
        '/repo/src/dashboard.ts': {},
        '/repo/other/src/dashboard.ts.map': {},
    };

    assert.deepEqual(findUninstrumentedFiles(summary, ['src/dashboard.ts']), []);
});

test('COVERAGE-BASELINE-INSTRUMENTATION-001 keeps src/dashboard.ts on the required instrumentation list', () => {
    // Only the production activation harness executes this file, and it runs in
    // a subprocess. When that subprocess stopped inheriting NODE_V8_COVERAGE the
    // largest file in the extension silently left the report for weeks.
    assert.ok(REQUIRED_INSTRUMENTED_FILES.includes('src/dashboard.ts'));
});

test('COVERAGE-BASELINE-INSTRUMENTATION-001 reports the missing file and skips the percentage comparison', () => {
    const summary = { total: { lines: { pct: 1 }, branches: { pct: 1 }, functions: { pct: 1 }, statements: { pct: 1 } } };
    const baseline = { lines: 90, branches: 90, functions: 90, statements: 90 };

    // A file dropping out usually *raises* the totals, so the instrumentation
    // failure has to be reported on its own rather than as a percentage drop.
    assert.deepEqual(collectCoverageFailures(summary, baseline), [
        'src/dashboard.ts is missing from the coverage report; '
        + 'its executing process must inherit NODE_V8_COVERAGE',
    ]);
});

test('COVERAGE-BASELINE-INSTRUMENTATION-001 falls through to baseline comparison once every file is instrumented', () => {
    const summary = {
        total: { lines: { pct: 50 }, branches: { pct: 95 }, functions: { pct: 95 }, statements: { pct: 95 } },
        '/repo/src/dashboard.ts': {},
    };
    const baseline = { lines: 90, branches: 90, functions: 90, statements: 90 };

    assert.deepEqual(collectCoverageFailures(summary, baseline), [
        'lines coverage decreased from 90.00% to 50.00%',
    ]);
});

test('COVERAGE-BASELINE-INSTRUMENTATION-001 returns no failures for an instrumented run at baseline', () => {
    const summary = {
        total: { lines: { pct: 90 }, branches: { pct: 90 }, functions: { pct: 90 }, statements: { pct: 90 } },
        '/repo/src/dashboard.ts': {},
    };
    const baseline = { lines: 90, branches: 90, functions: 90, statements: 90 };

    assert.deepEqual(collectCoverageFailures(summary, baseline), []);
});
