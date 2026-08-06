'use strict';

const assert = require('node:assert/strict');
const yaml = require('js-yaml');

function isMapping(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function containsKey(value, key) {
    if (Array.isArray(value)) {
        return value.some(item => containsKey(item, key));
    }
    if (!isMapping(value)) {
        return false;
    }
    return hasOwn(value, key)
        || Object.values(value).some(item => containsKey(item, key));
}

function parseVerifyWorkflow(source) {
    let workflow;
    try {
        // YAML 1.1 treats the unquoted key `on` as boolean true. JSON_SCHEMA keeps
        // GitHub Actions' `on` key as a string so trigger validation is unambiguous.
        workflow = yaml.safeLoad(source, { schema: yaml.JSON_SCHEMA });
    } catch (error) {
        throw new assert.AssertionError({
            message: `GitHub verification workflow must be valid YAML: ${error.message}`,
        });
    }
    assert.ok(isMapping(workflow), 'GitHub verification workflow must be a YAML mapping');
    return workflow;
}

function validateTriggers(workflow) {
    assert.ok(hasOwn(workflow, 'on'), 'GitHub verification workflow must define the on trigger mapping');
    const triggers = workflow.on;
    assert.ok(isMapping(triggers), 'GitHub verification workflow on must be a mapping');
    for (const trigger of ['pull_request', 'workflow_dispatch', 'workflow_call']) {
        assert.ok(hasOwn(triggers, trigger), `GitHub verification workflow must define ${trigger}`);
        assert.ok(triggers[trigger] === null || isMapping(triggers[trigger]),
            `GitHub verification workflow ${trigger} must be empty or a mapping`);
    }
    assert.ok(isMapping(triggers.push), 'GitHub verification workflow push trigger must be a mapping');
    assert.ok(Array.isArray(triggers.push.branches), 'GitHub verification workflow push branches must be an array');
    assert.ok(triggers.push.branches.includes('main'), 'GitHub verification workflow push branches must include main');
}

function findStep(job, predicate) {
    assert.ok(Array.isArray(job.steps), 'verification job steps must be an array');
    return job.steps.find(predicate);
}

function validateJob(
    jobs,
    jobId,
    expectedRunner,
    expectedGate,
    prerequisiteCommands = [],
    requiresFullHistory = false,
    expectedTimeoutMinutes = 10
) {
    const job = jobs[jobId];
    assert.ok(isMapping(job), `GitHub verification workflow must define ${jobId}`);
    assert.equal(job.name, jobId, `${jobId} must expose the stable check name ${jobId}`);
    assert.equal(job['runs-on'], expectedRunner, `${jobId} must use ${expectedRunner}`);
    assert.equal(
        job['timeout-minutes'],
        expectedTimeoutMinutes,
        `${jobId} timeout-minutes must be ${expectedTimeoutMinutes}`
    );

    const checkout = findStep(job,
        step => isMapping(step) && step.uses === 'actions/checkout@v4');
    assert.ok(checkout, `${jobId} must use actions/checkout@v4`);
    if (requiresFullHistory) {
        assert.ok(isMapping(checkout.with) && checkout.with['fetch-depth'] === 0,
            `${jobId} checkout step must fetch full history`);
    }
    const setupNode = findStep(job,
        step => isMapping(step) && step.uses === 'actions/setup-node@v4');
    assert.ok(setupNode, `${jobId} must use actions/setup-node@v4`);
    assert.ok(isMapping(setupNode.with), `${jobId} setup-node step must define with`);
    assert.equal(setupNode.with['node-version'], '22.12.0',
        `${jobId} setup-node step must use Node 22.12.0`);
    assert.equal(setupNode.with.cache, 'npm', `${jobId} setup-node step must cache npm`);
    assert.ok(findStep(job, step => isMapping(step) && step.run === 'npm ci'),
        `${jobId} must run npm ci`);
    for (const command of prerequisiteCommands) {
        assert.ok(findStep(job, step => isMapping(step) && step.run === command),
            `${jobId} must run ${command}`);
    }
    assert.ok(findStep(job, step => isMapping(step) && step.run === expectedGate),
        `${jobId} must run ${expectedGate}`);
}

function validateChromiumInstall(job) {
    assert.equal(findStep(job, step => isMapping(step) && typeof step.run === 'string'
        && (step.run.includes('playwright install-deps') || step.run.includes('--with-deps'))),
    undefined,
    'quality-linux must not run redundant apt-backed Playwright dependency installs');

    const browserInstall = findStep(job,
        step => isMapping(step) && step.name === 'Install pinned Chromium headless shell');
    assert.ok(browserInstall,
        'quality-linux must define the pinned Chromium headless shell install step');
    assert.equal(browserInstall.shell, 'bash',
        'quality-linux Chromium install step must use bash');
    assert.equal(browserInstall.run, [
        'set -euo pipefail',
        'for attempt in 1 2 3; do',
        '  if timeout --kill-after=10s 120s npx playwright install --only-shell chromium; then',
        '    exit 0',
        '  fi',
        '  echo "::warning::Chromium install attempt ${attempt} failed"',
        'done',
        'exit 1',
        '',
    ].join('\n'),
    'quality-linux must install only the Chromium headless shell with three bounded retries');
}

function validateVerifyWorkflow(verifyWorkflow) {
    const workflow = parseVerifyWorkflow(verifyWorkflow);
    validateTriggers(workflow);
    assert.deepEqual(workflow.permissions, { contents: 'read' },
        'GitHub verification workflow permissions must be exactly contents: read');
    assert.ok(isMapping(workflow.concurrency),
        'GitHub verification workflow concurrency must be a mapping');
    assert.equal(workflow.concurrency.group, 'verify-${{ github.workflow }}-${{ github.ref }}',
        'GitHub verification workflow concurrency group must be stable per ref');
    assert.equal(workflow.concurrency['cancel-in-progress'], true,
        'GitHub verification workflow must cancel in-progress runs');
    assert.ok(isMapping(workflow.jobs), 'GitHub verification workflow jobs must be a mapping');
    validateJob(
        workflow.jobs,
        'quality-linux',
        'ubuntu-latest',
        'npm run test:ci:linux',
        [],
        true,
        15
    );
    validateChromiumInstall(workflow.jobs['quality-linux']);
    validateJob(workflow.jobs, 'platform-windows', 'windows-latest', 'npm run test:ci:windows');
    validateJob(workflow.jobs, 'tmux-smoke-linux', 'ubuntu-latest',
        'npm run test:tmux:smoke', ['sudo apt-get install -y tmux']);
    validateJob(
        workflow.jobs,
        'extension-host-linux',
        'ubuntu-latest',
        'xvfb-run -a npm run test:extension-host',
        ['sudo apt-get install -y xvfb'],
        true,
        15
    );
    assert.equal(
        workflow.jobs['extension-host-linux'].if,
        "github.event_name == 'pull_request'",
        'extension-host-linux must stay a pull_request-only advisory gate'
    );
    assert.equal(containsKey(workflow, 'continue-on-error'), false,
        'GitHub verification workflow must not define continue-on-error');
}

function validateScheduledWorkflow(scheduledWorkflow) {
    const workflow = parseVerifyWorkflow(scheduledWorkflow);
    assert.ok(hasOwn(workflow, 'on'),
        'GitHub scheduled verification workflow must define the on trigger mapping');
    assert.ok(isMapping(workflow.on),
        'GitHub scheduled verification workflow on must be a mapping');
    assert.ok(Array.isArray(workflow.on.schedule) && workflow.on.schedule.length > 0,
        'GitHub scheduled verification workflow must define a schedule');
    assert.ok(hasOwn(workflow.on, 'workflow_dispatch'),
        'GitHub scheduled verification workflow must define workflow_dispatch');
    assert.deepEqual(workflow.on.workflow_dispatch, {
        inputs: {
            extension_host_only: {
                description: 'Run only the macOS Extension Host diagnostic',
                required: false,
                type: 'boolean',
                default: false,
            },
        },
    }, 'scheduled workflow_dispatch must expose only the bounded Host diagnostic input');
    assert.deepEqual(workflow.permissions, {
        contents: 'read',
        issues: 'read',
        'pull-requests': 'read',
    }, 'GitHub scheduled verification workflow permissions must include every nested read permission');
    assert.ok(isMapping(workflow.jobs),
        'GitHub scheduled verification workflow jobs must be a mapping');

    const verify = workflow.jobs.verify;
    assert.ok(isMapping(verify), 'GitHub scheduled verification workflow must define verify');
    assert.equal(verify.uses, './.github/workflows/verify.yml',
        'scheduled verify must reuse ./.github/workflows/verify.yml');
    assert.equal(
        verify.if,
        "${{ github.event_name != 'workflow_dispatch' || inputs.extension_host_only != true }}",
        'scheduled verify may skip only for the explicit manual Host diagnostic'
    );
    assert.deepEqual(Object.keys(verify), ['if', 'uses'],
        'scheduled verify must contain only its bounded condition and reusable workflow reference');

    const macos = workflow.jobs['scheduled-macos'];
    assert.ok(isMapping(macos),
        'GitHub scheduled verification workflow must define scheduled-macos');
    assert.equal(
        macos.if,
        "${{ always() && (inputs.extension_host_only == true || needs.verify.result == 'success') }}",
        'scheduled-macos must require Verify success except for the explicit manual diagnostic'
    );
    assert.equal(macos.name, 'scheduled-macos',
        'scheduled-macos must expose the stable check name scheduled-macos');
    assert.equal(macos.needs, 'verify', 'scheduled-macos must need verify');
    assert.equal(macos['runs-on'], 'macos-15',
        'scheduled-macos must use macos-15');
    assert.equal(macos['timeout-minutes'], 15, 'scheduled-macos timeout-minutes must be 15');
    assert.ok(findStep(macos, step => isMapping(step) && step.uses === 'actions/checkout@v4'),
        'scheduled-macos must use actions/checkout@v4');
    const setupNode = findStep(macos,
        step => isMapping(step) && step.uses === 'actions/setup-node@v4');
    assert.ok(setupNode, 'scheduled-macos must use actions/setup-node@v4');
    assert.ok(isMapping(setupNode.with), 'scheduled-macos setup-node step must define with');
    assert.equal(setupNode.with['node-version'], '22.12.0',
        'scheduled-macos setup-node step must use Node 22.12.0');
    assert.equal(setupNode.with.cache, 'npm',
        'scheduled-macos setup-node step must cache npm');
    assert.ok(findStep(macos, step => isMapping(step) && step.run === 'npm ci'),
        'scheduled-macos must run npm ci');
    assert.ok(findStep(
        macos,
        step => isMapping(step) && step.run === 'npm run test:extension-host'
    ), 'scheduled-macos must run npm run test:extension-host');
    assert.equal(containsKey(workflow, 'continue-on-error'), false,
        'GitHub scheduled verification workflow must not define continue-on-error');
}

function validateReleaseWorkflow(releaseWorkflow) {
    const workflow = parseVerifyWorkflow(releaseWorkflow);
    assert.ok(isMapping(workflow.jobs),
        'GitHub release workflow jobs must be a mapping');
    assert.deepEqual(workflow.permissions, {
        contents: 'read',
        issues: 'read',
        'pull-requests': 'read',
    }, 'GitHub release workflow permissions must include every nested read permission');
    assert.deepEqual(Object.keys(workflow.jobs).sort(), [
        'release',
        'release-extension-host',
        'verify',
    ], 'GitHub release workflow must define verify, release-extension-host, and release');

    const verify = workflow.jobs.verify;
    assert.ok(isMapping(verify), 'GitHub release workflow must define verify');
    assert.equal(verify.uses, './.github/workflows/verify.yml',
        'release verify must reuse ./.github/workflows/verify.yml');

    validateJob(
        workflow.jobs,
        'release-extension-host',
        'macos-15',
        'npm run test:extension-host',
        [],
        false,
        15
    );
    assert.equal(workflow.jobs['release-extension-host'].needs, 'verify',
        'release-extension-host must need verify');
    const release = workflow.jobs.release;
    assert.ok(isMapping(release), 'GitHub release workflow must define release');
    assert.deepEqual(release.needs, ['verify', 'release-extension-host'],
        'release job must need verify and release-extension-host');
    assert.deepEqual(release.permissions, { contents: 'write' },
        'release job permissions must be exactly contents: write');
    assert.equal(containsKey(workflow, 'continue-on-error'), false,
        'GitHub release workflow must not define continue-on-error');
}

function includesShellCommand(script, command) {
    return typeof script === 'string'
        && script.split(/&&|;/).map(part => part.trim()).includes(command);
}

function validateSafetyScripts(scripts) {
    const safetyScript = scripts['test:safety'];
    const safetyRunScript = scripts['test:safety:run'];
    assert.equal(typeof safetyScript, 'string', 'package scripts must define test:safety');
    assert.equal(typeof safetyRunScript, 'string', 'package scripts must define test:safety:run');
    assert.ok(includesShellCommand(safetyScript, 'npm run test:safety:run'),
        'test:safety must invoke npm run test:safety:run');
    assert.ok(includesShellCommand(safetyRunScript, 'node scripts/run-ai-session-tmux-checks.js'),
        'ordinary safety CI must run the pure fake-tmux checks');
    assert.strictEqual(
        `${safetyScript} && ${safetyRunScript}`.includes('run-ai-session-tmux-smoke-checks.js'),
        false,
        'ordinary safety CI must never start a real tmux server');
}

function validateQualityGateScripts(scripts) {
    assert.equal(scripts['test:architecture-guards'], 'node scripts/run-architecture-guards.js',
        'test:architecture-guards must run the architecture guard entry point exactly');
    assert.ok(includesShellCommand(scripts['test:ci:linux'], 'npm run test:architecture-guards'),
        'test:ci:linux must invoke npm run test:architecture-guards');
    assert.ok(includesShellCommand(scripts['test:ci:linux'], 'npm run test:coverage:run'),
        'test:ci:linux must invoke the combined deterministic coverage run');
    assert.equal(includesShellCommand(
        scripts['test:ci:linux'], 'npm run test:deterministic:run'
    ), false, 'test:ci:linux must not repeat deterministic tests outside coverage');
    assert.equal(includesShellCommand(
        scripts['test:ci:linux'], 'npm run vscode:prepublish'
    ), false, 'test:ci:linux must not repeat the prepublish build after release packaging');
    assert.match(scripts['test:coverage:run'], /\bnpm run test:deterministic:run\b/u,
        'coverage must wrap the deterministic suite instead of defining a second test run');
    assert.match(scripts['test:coverage:run'], /--reporter=text-summary\b/u,
        'coverage must emit a bounded summary instead of a per-file table');
    assert.equal([
        ...scripts['test:deterministic:run'].matchAll(/--test-concurrency=2\b/gu),
    ].length, 2, 'deterministic contract and integration suites must use bounded concurrency');
    assert.doesNotMatch(scripts['test:deterministic:run'], /--test-concurrency=1\b/u,
        'deterministic suites must not fall back to single-file execution');
    assert.match(scripts['test:browser:run'], /--test-concurrency=2\b/u,
        'browser test files must use bounded concurrency');
}

module.exports = {
    validateQualityGateScripts,
    validateReleaseWorkflow,
    validateSafetyScripts,
    validateScheduledWorkflow,
    validateVerifyWorkflow,
};
