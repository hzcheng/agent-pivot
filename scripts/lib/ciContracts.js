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

function validateChromiumInstall(job, jobId) {
    assert.equal(findStep(job, step => isMapping(step) && typeof step.run === 'string'
        && (step.run.includes('playwright install-deps') || step.run.includes('--with-deps'))),
    undefined,
    `${jobId} must not run redundant apt-backed Playwright dependency installs`);

    const browserInstall = findStep(job,
        step => isMapping(step) && step.name === 'Install pinned Chromium headless shell');
    assert.ok(browserInstall,
        `${jobId} must define the pinned Chromium headless shell install step`);
    assert.equal(browserInstall.shell, 'bash',
        `${jobId} Chromium install step must use bash`);
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
    `${jobId} must install only the Chromium headless shell with three bounded retries`);
}

function validatePrMetadataPreflight(jobs) {
    const job = jobs['pr-metadata'];
    assert.ok(isMapping(job), 'GitHub verification workflow must define pr-metadata');
    assert.equal(job.name, 'pr-metadata', 'pr-metadata must expose a stable check name');
    assert.equal(job['runs-on'], 'ubuntu-latest', 'pr-metadata must use ubuntu-latest');
    assert.equal(job['timeout-minutes'], 2, 'pr-metadata must have a short timeout');
    assert.ok(findStep(job, step => isMapping(step) && step.uses === 'actions/checkout@v4'),
        'pr-metadata must checkout the PR head');
    assert.equal(findStep(job, step => isMapping(step)
        && step.name === 'Check PR body conventions')?.run,
    'node scripts/check-pr-body.js',
    'pr-metadata must run the PR body validator directly');
    assert.equal(findStep(job, step => isMapping(step) && step.run === 'npm ci'), undefined,
        'pr-metadata must run before dependency installation');
}

function validateStaticPreflight(jobs) {
    const job = jobs['static-preflight'];
    assert.ok(isMapping(job), 'GitHub verification workflow must define static-preflight');
    assert.equal(job.name, 'static-preflight', 'static-preflight must expose a stable check name');
    assert.equal(job['runs-on'], 'ubuntu-latest', 'static-preflight must use ubuntu-latest');
    assert.equal(job['timeout-minutes'], 3, 'static-preflight must have a short timeout');
    assert.ok(findStep(job, step => isMapping(step) && step.uses === 'actions/checkout@v4'),
        'static-preflight must checkout the PR head');
    const command = findStep(job, step => isMapping(step)
        && step.name === 'Run static repository preflight')?.run;
    assert.equal(command, [
        'node scripts/check-brand-identity.js',
        'node scripts/check-behavior-contracts.js',
        'node --test tests/unit/tooling/conversationReleaseJourneys.test.js',
        'node scripts/check-conversation-release-journeys.js',
        'node scripts/run-performance-architecture-baseline-checks.js',
        'node scripts/run-release-notes-checks.js',
        '',
    ].join('\n'), 'static-preflight must run only checkout-safe repository checks');
    assert.equal(findStep(job, step => isMapping(step) && step.run === 'npm ci'), undefined,
        'static-preflight must run before dependency installation');
    assert.equal(findStep(job, step => isMapping(step)
        && step.uses === 'actions/setup-node@v4'), undefined,
    'static-preflight must not wait for dependency setup');
}

const LINUX_SHARD_JOBS = ['linux-core', 'linux-browser', 'linux-safety', 'linux-release'];

function validateLinuxShardJobs(jobs) {
    for (const jobId of LINUX_SHARD_JOBS) {
        validateJob(
            jobs,
            jobId,
            'ubuntu-latest',
            `npm run test:ci:linux:${jobId.replace('linux-', '')}`,
            [],
            jobId === 'linux-core',
            10
        );
        assert.deepEqual(jobs[jobId].needs, ['pr-metadata', 'static-preflight'],
            `${jobId} must wait for both fast preflight jobs`);
        if (jobId === 'linux-core') {
            const gate = findStep(jobs[jobId],
                step => isMapping(step) && step.run === 'npm run test:ci:linux:core');
            assert.ok(isMapping(gate.env)
                && gate.env.COVERAGE_DIFF_BASE === '${{ github.event.pull_request.base.sha }}',
            'linux-core must diff changed-line coverage against the PR base');
        }
    }
    // Only the browser shard may pay for the Chromium download; the other
    // shards never touch Playwright.
    for (const jobId of LINUX_SHARD_JOBS) {
        const playwrightStep = findStep(jobs[jobId], step => isMapping(step)
            && typeof step.run === 'string' && step.run.includes('playwright install'));
        if (jobId === 'linux-browser') {
            continue;
        }
        assert.equal(playwrightStep, undefined,
            `${jobId} must not install Playwright browsers`);
    }
    validateChromiumInstall(jobs['linux-browser'], 'linux-browser');
}

function validateLinuxAggregateJob(jobs) {
    const job = jobs['quality-linux'];
    assert.ok(isMapping(job), 'GitHub verification workflow must define quality-linux');
    assert.equal(job.name, 'quality-linux',
        'quality-linux must keep its stable required check name');
    assert.equal(job['runs-on'], 'ubuntu-latest', 'quality-linux must use ubuntu-latest');
    assert.equal(job['timeout-minutes'], 2, 'quality-linux aggregation must stay cheap');
    assert.deepEqual(job.needs, LINUX_SHARD_JOBS,
        'quality-linux must aggregate exactly the four Linux shards');
    // A job skipped because a failed `needs` entry reports success to branch
    // protection, so the aggregate must always run and fail explicitly.
    assert.equal(job.if, 'always()',
        'quality-linux must run even when a Linux shard failed');
    assert.ok(findStep(job, step => isMapping(step) && step.uses === 'actions/checkout@v4'),
        'quality-linux must checkout the shard aggregation script');
    const aggregate = findStep(job, step => isMapping(step)
        && step.run === 'node scripts/check-ci-shard-results.js');
    assert.ok(aggregate, 'quality-linux must aggregate shard results explicitly');
    assert.ok(isMapping(aggregate.env)
        && aggregate.env.NEEDS_JSON === '${{ toJSON(needs) }}',
    'quality-linux must read every shard result from the needs context');
    assert.equal(findStep(job, step => isMapping(step) && step.run === 'npm ci'), undefined,
        'quality-linux aggregation must not install dependencies');
    assert.equal(findStep(job, step => isMapping(step)
        && step.uses === 'actions/setup-node@v4'), undefined,
    'quality-linux aggregation must not wait for dependency setup');
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
    validatePrMetadataPreflight(workflow.jobs);
    validateStaticPreflight(workflow.jobs);
    validateLinuxShardJobs(workflow.jobs);
    validateLinuxAggregateJob(workflow.jobs);
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
        'publish-marketplace',
        'release',
        'release-extension-host',
        'verify',
    ], 'GitHub release workflow must define verify, release-extension-host, release, and publish-marketplace');

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
    const extensionHostSource = findStep(workflow.jobs['release-extension-host'],
        step => isMapping(step) && step.name === 'Resolve release source');
    assert.ok(extensionHostSource && extensionHostSource.id === 'source'
        && typeof extensionHostSource.run === 'string'
        && extensionHostSource.run.includes('git ls-remote --exit-code --tags origin "refs/tags/$tag"')
        && extensionHostSource.run.includes('ls_remote_status="$?"'),
    'release-extension-host must resolve the same release source before activation');
    const extensionHostCheckout = findStep(workflow.jobs['release-extension-host'],
        step => isMapping(step) && step.name === 'Checkout release source');
    assert.ok(extensionHostCheckout && extensionHostCheckout.uses === 'actions/checkout@v4'
        && extensionHostCheckout.with
        && extensionHostCheckout.with.ref === '${{ steps.source.outputs.ref }}',
    'release-extension-host must check out the resolved immutable source before activation');
    const release = workflow.jobs.release;
    assert.ok(isMapping(release), 'GitHub release workflow must define release');
    assert.deepEqual(release.needs, ['verify', 'release-extension-host'],
        'release job must need verify and release-extension-host');
    assert.deepEqual(release.permissions, { contents: 'write' },
        'release job permissions must be exactly contents: write');
    assert.equal(containsKey(workflow, 'continue-on-error'), false,
        'GitHub release workflow must not define continue-on-error');

    const source = findStep(release,
        step => isMapping(step) && step.name === 'Resolve release source');
    assert.ok(source && source.id === 'source' && typeof source.run === 'string'
        && source.run.includes('git ls-remote --exit-code --tags origin "refs/tags/$tag"')
        && source.run.includes('source_ref="$tag"')
        && source.run.includes('Requested version $requested_version does not match package.json version $workflow_version.')
        && source.run.includes('ls_remote_status="$?"')
        && source.run.includes('Unable to resolve release tag $tag from origin.'),
    'release retries must resolve an existing version from its immutable tag');
    const sourceCheckout = findStep(release,
        step => isMapping(step) && step.name === 'Checkout release source');
    assert.ok(sourceCheckout && sourceCheckout.uses === 'actions/checkout@v4'
        && sourceCheckout.with && sourceCheckout.with.ref === '${{ steps.source.outputs.ref }}',
    'release packaging must check out the resolved immutable source');
    const metadata = findStep(release,
        step => isMapping(step) && step.name === 'Read package metadata');
    assert.ok(metadata && typeof metadata.run === 'string'
        && metadata.run.includes('tag="${{ steps.source.outputs.tag }}"')
        && metadata.run.includes('source_sha="$(git rev-parse HEAD)"')
        && metadata.run.includes('Release source package.json version $package_version does not match $tag.'),
    'release packaging must reject a source whose package version does not match the resolved tag');

    validateMarketplacePublishJob(workflow);
}

function validateMarketplacePublishJob(workflow) {
    const job = workflow.jobs['publish-marketplace'];
    assert.ok(isMapping(job), 'GitHub release workflow must define publish-marketplace');
    assert.equal(job.name, 'publish-marketplace',
        'publish-marketplace must expose the stable check name publish-marketplace');
    assert.equal(job.needs, 'release',
        'publish-marketplace must need release so it publishes only released VSIX artifacts');
    assert.equal(job['runs-on'], 'ubuntu-latest',
        'publish-marketplace must use ubuntu-latest');
    assert.equal(job['timeout-minutes'], 15,
        'publish-marketplace timeout-minutes must be 15');
    assert.deepEqual(job.permissions, { contents: 'read' },
        'publish-marketplace job permissions must be exactly contents: read');

    const dispatch = workflow.on && workflow.on.workflow_dispatch;
    assert.ok(isMapping(dispatch) && isMapping(dispatch.inputs)
        && isMapping(dispatch.inputs.publish_marketplace),
    'release workflow workflow_dispatch must define the publish_marketplace override input');

    const checkout = findStep(job,
        step => isMapping(step) && step.uses === 'actions/checkout@v4');
    assert.ok(checkout && isMapping(checkout.with) && checkout.with['fetch-depth'] === 0,
        'publish-marketplace checkout must fetch full history to compare release tags');

    const decision = findStep(job,
        step => isMapping(step) && step.name === 'Decide marketplace publish');
    assert.ok(decision, 'publish-marketplace must define the Decide marketplace publish step');
    assert.ok(typeof decision.run === 'string'
        && decision.run.includes("git tag --list 'v*.*.*' --sort=-version:refname"),
    'publish-marketplace decision must compare against the previous release tag');
    assert.ok(decision.run.includes('${version%.*}'),
        'publish-marketplace decision must compare the major.minor prefix to skip patch-only bumps');

    const download = findStep(job,
        step => isMapping(step) && step.uses === 'actions/download-artifact@v4');
    assert.ok(download, 'publish-marketplace must download the released VSIX artifact');
    assert.equal(download.with && download.with.name,
        'agent-pivot-${{ needs.release.outputs.version }}-vsix',
    'publish-marketplace must download the artifact produced by the release job');

    const publish = findStep(job,
        step => isMapping(step) && step.name === 'Publish extensions to the VS Code Marketplace');
    assert.ok(publish && typeof publish.run === 'string',
        'publish-marketplace must define the Marketplace publish command step');
    const bridgePublish = publish.run.indexOf(
        'npx --yes @vscode/vsce publish --packagePath "$BRIDGE_VSIX_FILE"');
    const mainPublish = publish.run.indexOf(
        'npx --yes @vscode/vsce publish --packagePath "$VSIX_FILE"');
    assert.ok(bridgePublish !== -1 && mainPublish !== -1,
        'publish-marketplace must publish both VSIX files with vsce');
    assert.ok(bridgePublish < mainPublish,
        'publish-marketplace must publish UI Bridge before the main extension');
    assert.ok(publish.run.includes(
        'npx --yes @vscode/vsce publish --packagePath "$BRIDGE_VSIX_FILE" --pat "$VSCE_PAT" --allow-star-activation --skip-duplicate'
    ) && publish.run.includes(
        'npx --yes @vscode/vsce publish --packagePath "$VSIX_FILE" --pat "$VSCE_PAT" --allow-star-activation --skip-duplicate'
    ), 'publish-marketplace must tolerate already-published VSIX versions when retrying a release');
    assert.ok(String(publish.env && publish.env.VSCE_PAT).includes('${{ secrets.VSCE_PAT }}'),
        'publish-marketplace must authenticate with the VSCE_PAT repository secret');
    assert.ok(publish.run.includes('--allow-star-activation'),
        'publish-marketplace must pass --allow-star-activation to vsce');
    const createRelease = findStep(workflow.jobs.release,
        step => isMapping(step) && step.name === 'Create GitHub release');
    assert.ok(createRelease && typeof createRelease.run === 'string'
        && createRelease.run.includes('Release $TAG already exists; retaining it.'),
        'release retries must retain an existing GitHub Release');
    assert.ok(createRelease.run.includes(
        'gh release upload "$TAG" "$BRIDGE_VSIX_FILE" "$MAIN_VSIX_FILE" --clobber'
    ), 'release retries must reconcile both VSIX assets after creating or retaining the GitHub Release');
    assert.ok(createRelease.run.includes('gh release create "$TAG" --target "$SOURCE_SHA"')
        && String(createRelease.env && createRelease.env.SOURCE_SHA).includes('${{ steps.meta.outputs.source_sha }}'),
    'new releases must create their tag at the commit used to build the VSIX assets');
}

function includesShellCommand(script, command) {
    return typeof script === 'string'
        && script.split(/&&|;/).map(part => part.trim()).includes(command);
}

function shellCommands(script) {
    return typeof script === 'string'
        ? script.split(/&&|;/).map(part => part.trim()).filter(Boolean)
        : [];
}

// The serial test:ci:linux chain is the source of truth for local runs; the
// four CI shards must partition it exactly so a newly added gate cannot ride
// only on the serial chain and silently drop out of CI.
function validateLinuxShardScripts(scripts) {
    assert.equal(typeof scripts['test:ci:linux'], 'string',
        'package scripts must define test:ci:linux');
    const expected = shellCommands(scripts['test:ci:linux'])
        .filter(command => command !== 'npm run test-compile');
    const combined = [];
    for (const shardId of ['core', 'browser', 'safety', 'release']) {
        const name = `test:ci:linux:${shardId}`;
        const commands = shellCommands(scripts[name]);
        assert.ok(commands.length > 0, `package scripts must define ${name}`);
        assert.equal(commands[0], 'npm run test-compile',
            `${name} must compile before running its checks`);
        combined.push(...commands);
    }
    const actual = combined.filter(command => command !== 'npm run test-compile');
    assert.deepEqual([...actual].sort(), [...expected].sort(),
        'the four Linux shards must partition test:ci:linux exactly');
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
    validateLinuxShardScripts(scripts);
}

module.exports = {
    validateLinuxShardScripts,
    validateQualityGateScripts,
    validateReleaseWorkflow,
    validateSafetyScripts,
    validateScheduledWorkflow,
    validateVerifyWorkflow,
};
