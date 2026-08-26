'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');
const {
    validateQualityGateScripts,
    validateReleaseWorkflow,
    validateSafetyScripts,
    validateScheduledWorkflow,
    validateVerifyWorkflow,
} = require('../../../scripts/lib/ciContracts');

const verifyWorkflow = fs.readFileSync(
    path.resolve(__dirname, '../../../.github/workflows/verify.yml'),
    'utf8'
);
const scheduledWorkflow = fs.readFileSync(
    path.resolve(__dirname, '../../../.github/workflows/scheduled-verification.yml'),
    'utf8'
);
const releaseWorkflow = fs.readFileSync(
    path.resolve(__dirname, '../../../.github/workflows/release-vsix.yml'),
    'utf8'
);
const packageScripts = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../../package.json'),
    'utf8'
)).scripts;

test('RELEASE-VSIX-PACKAGING-001 reusable verification callers grant every read permission required by nested jobs', () => {
    const requiredPermissions = {
        contents: 'read',
        issues: 'read',
        'pull-requests': 'read',
    };
    for (const [label, source] of [
        ['release', releaseWorkflow],
        ['scheduled', scheduledWorkflow],
    ]) {
        const workflow = yaml.safeLoad(source, { schema: yaml.JSON_SCHEMA });
        assert.deepEqual(
            workflow.permissions,
            requiredPermissions,
            `${label} workflow must pass the reusable verification workflow its nested read permissions`
        );
    }
});

test('RELEASE-VSIX-PACKAGING-001 rejects either reusable verification caller losing a nested read permission', () => {
    const releaseWithoutIssues = releaseWorkflow.replace('  issues: read\n', '');
    assert.throws(
        () => validateReleaseWorkflow(releaseWithoutIssues),
        /release workflow permissions must include every nested read permission/
    );

    const scheduledWithoutPullRequests = scheduledWorkflow.replace('  pull-requests: read\n', '');
    assert.throws(
        () => validateScheduledWorkflow(scheduledWithoutPullRequests),
        /scheduled verification workflow permissions must include every nested read permission/
    );
});

test('RELEASE-VSIX-PACKAGING-001 accepts the unquoted GitHub Actions on key', () => {
    assert.doesNotThrow(() => validateVerifyWorkflow(verifyWorkflow));
});

test('RELEASE-VSIX-PACKAGING-001 requires PR metadata validation before dependency installation', () => {
    const noPreflightWorkflow = verifyWorkflow.replace(/\n  pr-metadata:[\s\S]*?\n  quality-linux:/,
        '\n  quality-linux:');
    assert.throws(
        () => validateVerifyWorkflow(noPreflightWorkflow),
        /must define pr-metadata/
    );
});

test('RUNTIME-REAL-TMUX-CI-GATE-001 requires a stable real-tmux smoke job', () => {
    const missingTmuxJobWorkflow = verifyWorkflow.replace(/\n  tmux-smoke-linux:[\s\S]*$/, '');
    assert.throws(
        () => validateVerifyWorkflow(missingTmuxJobWorkflow),
        /must define tmux-smoke-linux/
    );
});

test('RUNTIME-REAL-TMUX-CI-GATE-001 requires tmux installation in the smoke job', () => {
    const missingTmuxInstallWorkflow = verifyWorkflow.replace(
        '        run: sudo apt-get install -y tmux',
        '        run: tmux -V'
    );
    assert.throws(
        () => validateVerifyWorkflow(missingTmuxInstallWorkflow),
        /tmux-smoke-linux must run sudo apt-get install -y tmux/
    );
});

test('ARCH-CI-QUALITY-GATE-001 requires the extension host smoke to run headless on PRs', () => {
    const directRunWorkflow = verifyWorkflow.replace(
        '        run: xvfb-run -a npm run test:extension-host',
        '        run: npm run test:extension-host'
    );
    assert.throws(
        () => validateVerifyWorkflow(directRunWorkflow),
        /extension-host-linux must run xvfb-run -a npm run test:extension-host/
    );
});

test('ARCH-CI-QUALITY-GATE-001 keeps the Windows gate on meaningful platform coverage', () => {
    const windows = packageScripts['test:ci:windows'];
    for (const required of [
        'tests/platform/windows/commandBuilders.test.js',
        'tests/platform/windows/projectPaths.test.js',
        'tests/platform/windows/conversationSources.test.js',
        'tests/unit/projects/projectPathUtils.test.js',
        'tests/unit/projects/orderAndFavorites.test.js',
        'tests/unit/projects/workspaceAndOpenMatching.test.js',
        'tests/unit/aiSessions/commandBuilders.test.js',
        'tests/unit/prompts/service.test.js',
    ]) {
        assert.ok(windows.includes(required), `test:ci:windows must run ${required}`);
    }
});

test('RELEASE-VSIX-PACKAGING-001 rejects workflow requirements that appear only in comments', () => {
    const commentOnlyWorkflow = verifyWorkflow
        .split('\n')
        .map(line => `# ${line}`)
        .join('\n');

    assert.throws(
        () => validateVerifyWorkflow(commentOnlyWorkflow),
        /verification workflow must be a YAML mapping/
    );
});

test('RELEASE-VSIX-PACKAGING-001 rejects a Linux gate assigned to the Windows runner', () => {
    const wrongRunnerWorkflow = verifyWorkflow.replace(
        '  quality-linux:\n    name: quality-linux\n    needs: pr-metadata\n    runs-on: ubuntu-latest',
        '  quality-linux:\n    name: quality-linux\n    needs: pr-metadata\n    runs-on: windows-latest'
    );

    assert.throws(
        () => validateVerifyWorkflow(wrongRunnerWorkflow),
        /quality-linux must use ubuntu-latest/
    );
});

test('ARCH-MAIN-CAPABILITY-COVERAGE-001 requires full Git history in the Linux quality job', () => {
    const shallowCheckoutWorkflow = verifyWorkflow.replace(
        '        with:\n          fetch-depth: 0\n',
        ''
    );

    assert.throws(
        () => validateVerifyWorkflow(shallowCheckoutWorkflow),
        /quality-linux checkout step must fetch full history/
    );
});

test('ARCH-CI-QUALITY-GATE-001 requires pinned Chromium in the Linux quality job', () => {
    const missingChromiumWorkflow = verifyWorkflow.replace(
        '            if timeout --kill-after=10s 120s npx playwright install --only-shell chromium; then',
        '            if npx playwright --version; then'
    );

    assert.throws(
        () => validateVerifyWorkflow(missingChromiumWorkflow),
        /quality-linux must install only the Chromium headless shell with three bounded retries/
    );
});

test('ARCH-CI-QUALITY-GATE-001 accepts bounded retries for the Chromium headless shell', () => {
    assert.doesNotThrow(() => validateVerifyWorkflow(verifyWorkflow));
});

test('ARCH-CI-QUALITY-GATE-001 rejects Chromium installs without three attempts', () => {
    const oneAttemptWorkflow = verifyWorkflow.replace(
        '          for attempt in 1 2 3; do',
        '          for attempt in 1; do'
    );

    assert.throws(
        () => validateVerifyWorkflow(oneAttemptWorkflow),
        /quality-linux must install only the Chromium headless shell with three bounded retries/
    );
});

test('ARCH-CI-QUALITY-GATE-001 rejects Chromium installs without a hard timeout', () => {
    const unboundedWorkflow = verifyWorkflow.replace(
        'timeout --kill-after=10s 120s npx playwright install --only-shell chromium',
        'npx playwright install --only-shell chromium'
    );

    assert.throws(
        () => validateVerifyWorkflow(unboundedWorkflow),
        /quality-linux must install only the Chromium headless shell with three bounded retries/
    );
});

test('ARCH-CI-QUALITY-GATE-001 rejects redundant apt font downloads on the hosted runner', () => {
    const aptBackedWorkflow = verifyWorkflow.replace(
        '      - name: Install pinned Chromium headless shell',
        '      - name: Install Chromium system dependencies\n'
            + '        run: npx playwright install-deps chromium\n'
            + '      - name: Install pinned Chromium headless shell'
    );

    assert.throws(
        () => validateVerifyWorkflow(aptBackedWorkflow),
        /quality-linux must not run redundant apt-backed Playwright dependency installs/
    );
});

test('RELEASE-VSIX-PACKAGING-001 requires npm caching in the Windows job itself', () => {
    const cacheMatches = [...verifyWorkflow.matchAll(/          cache: npm/g)];
    assert.ok(cacheMatches.length >= 2);
    const windowsCache = cacheMatches[1];
    const missingWindowsCacheWorkflow =
        verifyWorkflow.slice(0, windowsCache.index)
        + verifyWorkflow.slice(windowsCache.index + windowsCache[0].length);

    assert.throws(
        () => validateVerifyWorkflow(missingWindowsCacheWorkflow),
        /platform-windows setup-node step must cache npm/
    );
});

test('RUNTIME-TMUX-SMOKE-HARNESS-SAFETY-001 RELEASE-VSIX-PACKAGING-001 requires developer and release gates to keep their public runners', () => {
    assert.throws(() => validateSafetyScripts({
        'test:safety': 'npm run test-compile',
        'test:safety:run': 'node scripts/run-ai-session-tmux-checks.js',
    }), /test:safety must invoke npm run test:safety:run/);
});

test('ARCH-CI-QUALITY-GATE-001 requires architecture guards in the compile-once Linux chain', () => {
    assert.throws(() => validateQualityGateScripts({
        'test:ci:linux': 'npm run test-compile && npm run test:safety:run',
        'test:architecture-guards': 'node scripts/run-architecture-guards.js',
        'test:coverage:run': 'npm run test:deterministic:run',
        'test:deterministic:run': "node --test --test-concurrency=2 'tests/contract/**/*.test.js'",
        'test:browser:run': "node --test --test-concurrency=2 'tests/browser/**/*.test.js'",
    }), /test:ci:linux must invoke npm run test:architecture-guards/);
});

test('ARCH-CI-QUALITY-GATE-001 runs expensive suites and release builds only once with bounded concurrency', () => {
    assert.doesNotThrow(() => validateQualityGateScripts(packageScripts));

    assert.throws(() => validateQualityGateScripts({
        ...packageScripts,
        'test:ci:linux': `${packageScripts['test:ci:linux']} && npm run test:deterministic:run`,
    }), /must not repeat deterministic tests/);
    assert.throws(() => validateQualityGateScripts({
        ...packageScripts,
        'test:coverage:run': packageScripts['test:coverage:run']
            .replace('npm run test:deterministic:run', "node --test 'tests/unit/**/*.test.js'"),
    }), /coverage must wrap the deterministic suite/);
    assert.throws(() => validateQualityGateScripts({
        ...packageScripts,
        'test:browser:run': packageScripts['test:browser:run']
            .replace('--test-concurrency=2', '--test-concurrency=1'),
    }), /browser test files must use bounded concurrency/);
    assert.throws(() => validateQualityGateScripts({
        ...packageScripts,
        'test:deterministic:run': packageScripts['test:deterministic:run']
            .replace('--test-concurrency=2', '--test-concurrency=1'),
    }), /deterministic contract and integration suites must use bounded concurrency/);
});

test('ARCH-CI-QUALITY-GATE-001 keeps the repository Linux quality chain wired exactly', () => {
    assert.doesNotThrow(() => validateQualityGateScripts(packageScripts));
});

test('ARCH-CI-QUALITY-GATE-001 scheduled verification reuses the complete Verify workflow', () => {
    assert.doesNotThrow(() => validateScheduledWorkflow(scheduledWorkflow));

    assert.throws(
        () => validateScheduledWorkflow(
            scheduledWorkflow.replace(/\n  verify:\n[\s\S]*?(?=\n  scheduled-macos:)/, '')
        ),
        /must define verify/
    );
    assert.throws(
        () => validateScheduledWorkflow(
            scheduledWorkflow.replace(
                'uses: ./.github/workflows/verify.yml',
                'uses: ./.github/workflows/release-vsix.yml'
            )
        ),
        /verify must reuse \.\/\.github\/workflows\/verify\.yml/
    );
});

test('RELEASE-SCHEDULED-EXTENSION-HOST-001 permits a manual Host-only diagnostic without weakening schedules', () => {
    assert.match(scheduledWorkflow, /\n  workflow_dispatch:\n    inputs:\n      extension_host_only:\n/);
    assert.match(scheduledWorkflow,
        /\n  verify:\n    if: \$\{\{ github\.event_name != 'workflow_dispatch' \|\| inputs\.extension_host_only != true \}\}\n/);
    assert.match(scheduledWorkflow,
        /\n  scheduled-macos:\n    if: \$\{\{ always\(\) && \(inputs\.extension_host_only == true \|\| needs\.verify\.result == 'success'\) \}\}\n/);
});

test('ARCH-CI-QUALITY-GATE-001 scheduled Extension Host gate is pinned and blocking', () => {
    for (const [source, message] of [
        [
            scheduledWorkflow.replace('        run: npm run test:extension-host', '        run: npm test'),
            /scheduled-macos must run npm run test:extension-host/,
        ],
        [
            scheduledWorkflow.replace('node-version: 22.12.0', 'node-version: 22'),
            /scheduled-macos setup-node step must use Node 22\.12\.0/,
        ],
        [
            scheduledWorkflow.replace('          cache: npm', '          cache: false'),
            /scheduled-macos setup-node step must cache npm/,
        ],
        [
            scheduledWorkflow.replace('        run: npm ci', '        run: npm install'),
            /scheduled-macos must run npm ci/,
        ],
        [
            `${scheduledWorkflow}\n    continue-on-error: true\n`,
            /must not define continue-on-error/,
        ],
    ]) {
        assert.throws(() => validateScheduledWorkflow(source), message);
    }
});

test('RELEASE-SCHEDULED-EXTENSION-HOST-001 pins real Host gates to reviewed macOS 15', () => {
    assert.match(scheduledWorkflow, /\n    runs-on: macos-15\n/);
    assert.match(
        releaseWorkflow,
        /\n  release-extension-host:\n[\s\S]*?\n    runs-on: macos-15\n/
    );
});

test('RELEASE-CONVERSATION-JOURNEYS-001 release publishing needs installed VSIX activation', () => {
    assert.doesNotThrow(() => validateReleaseWorkflow(releaseWorkflow));
    assert.throws(
        () => validateReleaseWorkflow(releaseWorkflow.replace(
            '      - release-extension-host\n',
            ''
        )),
        /must need verify and release-extension-host/
    );
    assert.throws(
        () => validateReleaseWorkflow(releaseWorkflow.replace(
            '        run: npm run test:extension-host',
            '        run: npm test'
        )),
        /release-extension-host must run npm run test:extension-host/
    );
    assert.throws(
        () => validateReleaseWorkflow(releaseWorkflow.replace(
            '    runs-on: macos-15',
            '    runs-on: ubuntu-latest'
        )),
        /release-extension-host must use macos-15/
    );
    assert.throws(
        () => validateReleaseWorkflow(releaseWorkflow.replace(
            '    needs: verify',
            '    needs: release'
        )),
        /release-extension-host must need verify/
    );
});
