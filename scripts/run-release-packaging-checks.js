'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const yaml = require('js-yaml');
const {
    validateReleaseWorkflow: validateReleaseWorkflowSource,
    validateScheduledWorkflow: validateScheduledWorkflowSource,
    validateVerifyWorkflow,
} = require('./lib/ciContracts');

const repositoryRoot = path.resolve(__dirname, '..');

function readText(relativePath) {
    return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

function readJson(relativePath) {
    return JSON.parse(readText(relativePath));
}

function assertIncludes(source, needle, label) {
    assert.ok(source.includes(needle), `${label} must include ${needle}`);
}

function assertNotIncludes(source, needle, label) {
    assert.ok(!source.includes(needle), `${label} must not include ${needle}`);
}

const FORBIDDEN_LEGACY_IDENTITIES = Object.freeze([
    ['Project', 'Steward'].join(' '),
    ['project', 'steward'].join('-'),
    ['project', 'Steward'].join(''),
    ['hzcheng', ['project', 'steward'].join('-')].join('.'),
]);
const FORBIDDEN_PROTOCOL_PREFIX = ['_project', 'Steward'].join('');
const HISTORICAL_CHANGELOG_BOUNDARY =
    ['## Unpublished Project', 'Steward development history'].join(' ');
const EXPECTED_MAIN_ENTRIES = Object.freeze([
    '[Content_Types].xml',
    'extension.vsixmanifest',
    'extension/LICENSE.txt',
    'extension/THIRD_PARTY_NOTICES.md',
    'extension/changelog.md',
    'extension/dist/dashboard.js',
    'extension/licenses/DOMPurify-Apache-2.0.txt',
    'extension/licenses/Mermaid-MIT.txt',
    'extension/media/conversationMermaidScripts.js',
    'extension/media/conversationReadingAnchorScripts.js',
    'extension/media/conversationTelemetry.css',
    'extension/media/conversationViewer.css',
    'extension/media/conversationViewerScripts.js',
    'extension/media/dom-autoscroller.min.js',
    'extension/media/dragula.min.js',
    'extension/media/extension_icon.png',
    'extension/media/fitty.min.js',
    'extension/media/icon.svg',
    'extension/media/mermaid.min.js',
    'extension/media/purify.min.js',
    'extension/media/sharingan/mangekyou-sharingan-itachi.svg',
    'extension/media/sharingan/mangekyou-sharingan-madara-eternal.svg',
    'extension/media/sharingan/mangekyou-sharingan-madara.svg',
    'extension/media/sharingan/mangekyou-sharingan-obito-kakashi.svg',
    'extension/media/sharingan/mangekyou-sharingan-sasuke.svg',
    'extension/media/sharingan/mangekyou-sharingan-shisui.svg',
    'extension/media/styles.css',
    'extension/media/webviewDashboardScripts.js',
    'extension/media/webviewDnDScripts.js',
    'extension/media/webviewFilterScripts.js',
    'extension/media/webviewProjectScripts.js',
    'extension/media/webviewPromptScripts.js',
    'extension/media/webviewScrollStateScripts.js',
    'extension/media/webviewTodoScripts.js',
    'extension/out/openWorkspaces/bridgeClient.js',
    'extension/out/openWorkspaces/dashboardController.js',
    'extension/out/openWorkspaces/navigationController.js',
    'extension/out/openWorkspaces/pinController.js',
    'extension/out/openWorkspaces/pinProtocol.js',
    'extension/out/openWorkspaces/projection.js',
    'extension/out/openWorkspaces/protocol.js',
    'extension/out/openWorkspaces/workspaceController.js',
    'extension/out/workspaces/attentionProjection.js',
    'extension/out/workspaces/contextResolver.js',
    'extension/out/workspaces/identity.js',
    'extension/out/workspaces/pendingSessionPromotionController.js',
    'extension/out/workspaces/pendingWorkspaceSaveStore.js',
    'extension/out/workspaces/primaryRootStore.js',
    'extension/out/workspaces/savedWorkspaceProjectAdapter.js',
    'extension/out/workspaces/sessionAssignment.js',
    'extension/out/workspaces/sessionAttention.js',
    'extension/out/workspaces/sessionHydration.js',
    'extension/out/workspaces/sessionHydrationController.js',
    'extension/out/workspaces/sessionScope.js',
    'extension/out/workspaces/types.js',
    'extension/out/workspaces/viewModels.js',
    'extension/package.json',
    'extension/readme.md',
]);

function isMapping(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function containsKey(value, key) {
    if (Array.isArray(value)) return value.some(item => containsKey(item, key));
    if (!isMapping(value)) return false;
    return Object.prototype.hasOwnProperty.call(value, key)
        || Object.values(value).some(item => containsKey(item, key));
}

function containsSecretContext(value) {
    if (typeof value === 'string') return /\$\{\{[\s\S]*?\bsecrets\s*\./i.test(value);
    if (Array.isArray(value)) return value.some(containsSecretContext);
    return isMapping(value) && (
        Object.keys(value).some(containsSecretContext)
        || Object.values(value).some(containsSecretContext)
    );
}

function assertExactKeys(value, expectedKeys, label) {
    assert.deepStrictEqual(Object.keys(value).sort(), [...expectedKeys].sort(),
        `${label} must define exactly ${expectedKeys.join(', ')}`);
}

function parseWorkflow(source, label) {
    let workflow;
    try {
        workflow = yaml.safeLoad(source, { schema: yaml.JSON_SCHEMA });
    } catch (error) {
        assert.fail(`${label} must be valid YAML: ${error.message}`);
    }
    assert.ok(isMapping(workflow), `${label} must be a YAML mapping`);
    return workflow;
}

function validateScheduledWorkflow(workflow) {
    validateScheduledWorkflowSource(yaml.safeDump(workflow));
    assert.strictEqual(containsSecretContext(workflow), false,
        'scheduled verification must not reference the GitHub secrets context');
    assertExactKeys(workflow, ['name', 'on', 'permissions', 'jobs'],
        'scheduled verification workflow');
    assert.ok(isMapping(workflow.on), 'scheduled verification on must be a mapping');
    assertExactKeys(workflow.on, ['schedule', 'workflow_dispatch'],
        'scheduled verification triggers');
    assert.ok(Array.isArray(workflow.on.schedule), 'scheduled verification must define schedule');
    assert.strictEqual(workflow.on.schedule.length, 1,
        'scheduled verification must define exactly one reviewed schedule');
    for (const entry of workflow.on.schedule) {
        assert.ok(isMapping(entry), 'scheduled verification schedule entries must be mappings');
        assertExactKeys(entry, ['cron'], 'scheduled verification schedule entry');
        assert.strictEqual(entry.cron, '17 3 * * 1',
            'scheduled verification cron must remain the reviewed weekly schedule');
    }
    assert.ok(Object.prototype.hasOwnProperty.call(workflow.on, 'workflow_dispatch'),
        'scheduled verification must define workflow_dispatch');
    assert.ok(workflow.on.workflow_dispatch === null || isMapping(workflow.on.workflow_dispatch),
        'scheduled verification workflow_dispatch must be empty or a mapping');
    if (isMapping(workflow.on.workflow_dispatch)) {
        assertExactKeys(workflow.on.workflow_dispatch, [],
            'scheduled verification workflow_dispatch');
    }
    assert.deepStrictEqual(workflow.permissions, { contents: 'read' },
        'scheduled verification permissions must be exactly contents: read');
    assert.ok(isMapping(workflow.jobs), 'scheduled verification jobs must be a mapping');
    assert.deepStrictEqual(Object.keys(workflow.jobs), ['verify', 'scheduled-macos'],
        'scheduled verification must contain only verify and scheduled-macos jobs');
    assertExactKeys(workflow.jobs.verify, ['uses'], 'scheduled verify job');
    const job = workflow.jobs['scheduled-macos'];
    assert.ok(isMapping(job), 'scheduled verification must define scheduled-macos');
    assertExactKeys(job, ['name', 'needs', 'runs-on', 'timeout-minutes', 'steps'],
        'scheduled-macos job');
    assert.strictEqual(job.name, 'scheduled-macos',
        'scheduled-macos must keep its stable job name');
    assert.strictEqual(job['runs-on'], 'macos-latest', 'scheduled-macos must use macos-latest');
    assert.strictEqual(job['timeout-minutes'], 15, 'scheduled-macos timeout must be 15 minutes');
    assert.strictEqual(containsKey(workflow, 'continue-on-error'), false,
        'scheduled verification must not define continue-on-error');
    assert.ok(Array.isArray(job.steps), 'scheduled-macos steps must be an array');
    assert.strictEqual(job.steps.length, 5, 'scheduled-macos must define exactly five allowed steps');
    const checkout = job.steps[0];
    assertExactKeys(checkout, ['name', 'uses'], 'scheduled-macos checkout step');
    assert.strictEqual(checkout.uses, 'actions/checkout@v4',
        'scheduled-macos must use actions/checkout@v4');
    const setupNode = job.steps[1];
    assertExactKeys(setupNode, ['name', 'uses', 'with'], 'scheduled-macos setup-node step');
    assert.strictEqual(setupNode.uses, 'actions/setup-node@v4',
        'scheduled-macos must use actions/setup-node@v4');
    assertExactKeys(setupNode.with, ['node-version', 'cache'], 'scheduled-macos setup-node inputs');
    assert.strictEqual(setupNode.with['node-version'], '22.12.0',
        'scheduled-macos must use Node 22.12.0');
    assert.strictEqual(setupNode.with.cache, 'npm', 'scheduled-macos must cache npm');
    const commands = [
        'npm ci',
        'npm run test-compile && node --test tests/platform/macos/conversationSources.test.js',
        'npm run test:extension-host',
    ];
    for (const [index, command] of commands.entries()) {
        const step = job.steps[index + 2];
        assertExactKeys(step, ['name', 'run'], `scheduled-macos ${command} step`);
        assert.strictEqual(step.run, command, `scheduled-macos must run ${command}`);
    }
    assert.strictEqual(containsKey(workflow, 'secrets'), false,
        'scheduled verification must not use secrets');
}

function validateReleaseWorkflow(workflow) {
    validateReleaseWorkflowSource(yaml.safeDump(workflow));
    assert.ok(isMapping(workflow.on), 'release workflow on must be a mapping');
    assert.ok(isMapping(workflow.jobs), 'release workflow jobs must be a mapping');
    assert.deepStrictEqual(workflow.permissions, { contents: 'read' },
        'release workflow top-level permissions must be exactly contents: read');
    assert.strictEqual(containsKey(workflow, 'continue-on-error'), false,
        'release workflow must not define continue-on-error');
    assert.deepStrictEqual(
        Object.keys(workflow.jobs).sort(),
        ['release', 'release-extension-host', 'verify'],
        'release workflow must contain only verify, release-extension-host, and release jobs'
    );
    const verify = workflow.jobs.verify;
    assert.strictEqual(verify.uses, './.github/workflows/verify.yml',
        'release verify job must call the reusable verification workflow');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(verify, 'permissions'), false,
        'release verify job must not receive elevated permissions');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(verify, 'secrets'), false,
        'release verify job must not receive secrets');
    const extensionHost = workflow.jobs['release-extension-host'];
    assertExactKeys(
        extensionHost,
        ['name', 'needs', 'runs-on', 'timeout-minutes', 'steps'],
        'release-extension-host job'
    );
    assert.strictEqual(extensionHost.needs, 'verify',
        'release-extension-host must need verify');
    const release = workflow.jobs.release;
    assert.deepStrictEqual(
        release.needs,
        ['verify', 'release-extension-host'],
        'release job must need verify and release-extension-host'
    );
    assert.deepStrictEqual(release.permissions, { contents: 'write' },
        'release job permissions must be exactly contents: write');
}

function assertWorkflowMutationRejected(validate, workflow, mutate, message) {
    const mutation = JSON.parse(JSON.stringify(workflow));
    mutate(mutation);
    assert.throws(() => validate(mutation), assert.AssertionError, message);
}

function assertWorkflowMutationsRejected(validate, workflow, mutations) {
    const accepted = [];
    for (const [message, mutate] of mutations) {
        const mutation = JSON.parse(JSON.stringify(workflow));
        mutate(mutation);
        try {
            validate(mutation);
            accepted.push(message);
        } catch (error) {
            assert.ok(error instanceof assert.AssertionError, `${message} must fail with an assertion`);
        }
    }
    assert.deepStrictEqual(accepted, [], `workflow contract accepted unsafe mutations: ${accepted.join(', ')}`);
}

function readZipArchive(archivePath) {
    const bytes = fs.readFileSync(archivePath);
    const minimumEndOffset = Math.max(0, bytes.length - 65_557);
    let endOffset = -1;
    for (let offset = bytes.length - 22; offset >= minimumEndOffset; offset -= 1) {
        if (bytes.readUInt32LE(offset) === 0x06054b50) {
            endOffset = offset;
            break;
        }
    }
    assert.notStrictEqual(endOffset, -1, `${archivePath} must contain a ZIP end record`);
    const entryCount = bytes.readUInt16LE(endOffset + 10);
    let centralOffset = bytes.readUInt32LE(endOffset + 16);
    const entries = new Map();

    for (let index = 0; index < entryCount; index += 1) {
        assert.strictEqual(bytes.readUInt32LE(centralOffset), 0x02014b50,
            `${archivePath} central directory entry ${index} must be valid`);
        const compressionMethod = bytes.readUInt16LE(centralOffset + 10);
        const compressedSize = bytes.readUInt32LE(centralOffset + 20);
        const uncompressedSize = bytes.readUInt32LE(centralOffset + 24);
        const fileNameLength = bytes.readUInt16LE(centralOffset + 28);
        const extraLength = bytes.readUInt16LE(centralOffset + 30);
        const commentLength = bytes.readUInt16LE(centralOffset + 32);
        const localOffset = bytes.readUInt32LE(centralOffset + 42);
        const fileName = bytes.subarray(
            centralOffset + 46,
            centralOffset + 46 + fileNameLength,
        ).toString('utf8');
        assert.strictEqual(bytes.readUInt32LE(localOffset), 0x04034b50,
            `${archivePath} local entry for ${fileName} must be valid`);
        const localNameLength = bytes.readUInt16LE(localOffset + 26);
        const localExtraLength = bytes.readUInt16LE(localOffset + 28);
        const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
        const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
        const content = compressionMethod === 0
            ? Buffer.from(compressed)
            : compressionMethod === 8
                ? zlib.inflateRawSync(compressed)
                : assert.fail(`${archivePath} uses unsupported compression method ${compressionMethod}`);
        assert.strictEqual(content.length, uncompressedSize,
            `${archivePath} entry ${fileName} must have the declared length`);
        assert.strictEqual(entries.has(fileName), false,
            `${archivePath} must not contain duplicate entry ${fileName}`);
        entries.set(fileName, content);
        centralOffset += 46 + fileNameLength + extraLength + commentLength;
    }
    return entries;
}

function assertExactEntries(entries, expectedEntries, label) {
    assert.deepStrictEqual(
        Array.from(entries.keys()).sort(),
        expectedEntries.slice().sort(),
        `${label} must contain exactly the reviewed release files`,
    );
}

function assertNoForbiddenLegacyIdentity(source, label) {
    for (const token of FORBIDDEN_LEGACY_IDENTITIES) {
        assertNotIncludes(source, token, label);
    }
}

function currentChangelogSection(source) {
    const historicalBoundary = source.indexOf(HISTORICAL_CHANGELOG_BOUNDARY);
    assert.notStrictEqual(historicalBoundary, -1,
        'packaged CHANGELOG must retain the reviewed historical identity boundary');
    return source.slice(0, historicalBoundary);
}

function readVsixIdentity(entries, label) {
    const manifest = entries.get('extension.vsixmanifest').toString('utf8');
    const identity = manifest.match(/<Identity\s+[^>]*Id="([^"]+)"[^>]*Version="([^"]+)"[^>]*Publisher="([^"]+)"[^>]*\/>/);
    assert.ok(identity, `${label} VSIX manifest must contain an Identity with id, version, and publisher`);
    return {
        name: identity[1],
        version: identity[2],
        publisher: identity[3],
    };
}

function runRealVsixArchiveChecks(mainPackage, bridgePackage) {
    const mainArtifact = path.join(
        repositoryRoot,
        'artifacts',
        `${mainPackage.name}-${mainPackage.version}.vsix`,
    );
    const bridgeArtifact = path.join(
        repositoryRoot,
        'artifacts',
        `${bridgePackage.name}-${bridgePackage.version}.vsix`,
    );
    assert.strictEqual(
        path.basename(mainArtifact),
        'agent-pivot-1.0.1.vsix',
        'main release artifact name must remain exact',
    );
    assert.strictEqual(
        path.basename(bridgeArtifact),
        'agent-pivot-attention-ui-bridge-1.0.0.vsix',
        'UI Bridge release artifact name must remain exact',
    );
    const mainEntries = readZipArchive(mainArtifact);
    const bridgeEntries = readZipArchive(bridgeArtifact);
    const mainVsixManifest = mainEntries.get('extension.vsixmanifest').toString('utf8');
    const bridgeVsixManifest = bridgeEntries.get('extension.vsixmanifest').toString('utf8');
    for (const assetPath of [
        'extension/readme.md',
        'extension/changelog.md',
        'extension/LICENSE.txt',
    ]) {
        assertIncludes(mainVsixManifest, assetPath, 'main VSIX manifest');
    }
    for (const assetPath of [
        'extension/readme.md',
        'extension/LICENSE.txt',
    ]) {
        assertIncludes(bridgeVsixManifest, assetPath, 'UI Bridge VSIX manifest');
    }
    const expectedBridgeEntries = [
        '[Content_Types].xml',
        'extension.vsixmanifest',
        'extension/LICENSE.txt',
        'extension/package.json',
        'extension/readme.md',
        'extension/media/extension_icon.png',
        'extension/dist/extension.js',
    ];
    for (const [entries, label] of [
        [mainEntries, 'main VSIX'],
        [bridgeEntries, 'UI Bridge VSIX'],
    ]) {
        for (const forbiddenPrefix of [
            'extension/coverage/',
            'extension/.codex/',
            'extension/tests/',
            'extension/.ci/',
            'extension/.superpowers/',
            'extension/docs/',
            'extension/spikes/',
            'extension/src/',
            'extension/media/brand/',
        ]) {
            assert.ok(
                [...entries.keys()].every(fileName => !fileName.startsWith(forbiddenPrefix)),
                `${label} must exclude ${forbiddenPrefix}`
            );
        }
    }
    assertExactEntries(mainEntries, EXPECTED_MAIN_ENTRIES, 'main VSIX');
    assertExactEntries(bridgeEntries, expectedBridgeEntries, 'UI Bridge VSIX');

    for (const relativePath of [
        'THIRD_PARTY_NOTICES.md',
        'licenses/DOMPurify-Apache-2.0.txt',
        'licenses/Mermaid-MIT.txt',
        'media/extension_icon.png',
        'media/icon.svg',
        'media/sharingan/mangekyou-sharingan-itachi.svg',
        'media/sharingan/mangekyou-sharingan-madara-eternal.svg',
        'media/sharingan/mangekyou-sharingan-madara.svg',
        'media/sharingan/mangekyou-sharingan-obito-kakashi.svg',
        'media/sharingan/mangekyou-sharingan-sasuke.svg',
        'media/sharingan/mangekyou-sharingan-shisui.svg',
    ]) {
        assert.deepStrictEqual(
            mainEntries.get(`extension/${relativePath}`),
            fs.readFileSync(path.join(repositoryRoot, relativePath)),
            `main VSIX must preserve ${relativePath} byte-for-byte`,
        );
    }

    const embeddedMainPackage = JSON.parse(mainEntries.get('extension/package.json').toString('utf8'));
    const embeddedBridgePackage = JSON.parse(bridgeEntries.get('extension/package.json').toString('utf8'));
    const mainVsixIdentity = readVsixIdentity(mainEntries, 'main');
    const bridgeVsixIdentity = readVsixIdentity(bridgeEntries, 'UI Bridge');
    for (const [embedded, identity, source, label] of [
        [embeddedMainPackage, mainVsixIdentity, mainPackage, 'main VSIX'],
        [embeddedBridgePackage, bridgeVsixIdentity, bridgePackage, 'UI Bridge VSIX'],
    ]) {
        assert.strictEqual(embedded.publisher, source.publisher, `${label} publisher must match source manifest`);
        assert.strictEqual(embedded.name, source.name, `${label} name must match source manifest`);
        assert.strictEqual(embedded.version, source.version, `${label} version must match source manifest`);
        assert.deepStrictEqual(identity, {
            name: source.name,
            version: source.version,
            publisher: source.publisher,
        }, `${label} VSIX identity must match its source manifest`);
    }
    assert.deepStrictEqual(embeddedMainPackage.extensionDependencies,
        [`${bridgePackage.publisher}.${bridgePackage.name}`]);
    assert.deepStrictEqual(
        mainEntries.get('extension/LICENSE.txt'),
        fs.readFileSync(path.join(repositoryRoot, 'LICENSE')),
        'main VSIX must preserve the renamed LICENSE byte-for-byte',
    );
    assert.deepStrictEqual(
        mainEntries.get('extension/changelog.md'),
        fs.readFileSync(path.join(repositoryRoot, 'CHANGELOG.md')),
        'main VSIX must preserve CHANGELOG.md byte-for-byte',
    );
    assert.deepStrictEqual(
        bridgeEntries.get('extension/LICENSE.txt'),
        fs.readFileSync(path.join(repositoryRoot, 'extensions/attention-ui-bridge/LICENSE')),
        'UI Bridge VSIX must preserve the renamed LICENSE byte-for-byte',
    );
    assert.deepStrictEqual(
        bridgeEntries.get('extension/media/extension_icon.png'),
        fs.readFileSync(path.join(
            repositoryRoot,
            'extensions/attention-ui-bridge/media/extension_icon.png',
        )),
        'UI Bridge VSIX must preserve its generated icon byte-for-byte',
    );

    const mainBundle = mainEntries.get('extension/dist/dashboard.js').toString('utf8');
    const bridgeBundle = bridgeEntries.get('extension/dist/extension.js').toString('utf8');
    const mainReadme = mainEntries.get('extension/readme.md').toString('utf8');
    const bridgeReadme = bridgeEntries.get('extension/readme.md').toString('utf8');
    for (const [needle, label] of [
        ['# Agent Pivot', 'current product heading'],
        ['## Privacy and local data', 'privacy heading'],
        [
            'does not upload conversation content to an Agent Pivot service',
            'product telemetry disclosure',
        ],
        [
            'https://github.com/hzcheng/agent-pivot/blob/HEAD/LICENSE',
            'rewritten license link',
        ],
        [
            'https://github.com/hzcheng/agent-pivot/blob/HEAD/CHANGELOG.md',
            'rewritten changelog link',
        ],
        [
            'https://github.com/hzcheng/agent-pivot/blob/HEAD/THIRD_PARTY_NOTICES.md',
            'rewritten notices link',
        ],
    ]) {
        assertIncludes(mainReadme, needle, `packaged main README ${label}`);
    }
    for (const [needle, label] of [
        ['# Agent Pivot Attention UI Bridge', 'current product heading'],
        ['records workspace and root URIs locally', 'workspace URI storage disclosure'],
        [
            'Those URIs can include absolute local paths or remote-authority identifiers.',
            'stored URI sensitivity disclosure',
        ],
        [
            'does not record conversation content, prompts, or responses.',
            'conversation content disclosure',
        ],
        [
            'https://github.com/hzcheng/agent-pivot/blob/HEAD/../../LICENSE',
            'VSCE-rewritten license link',
        ],
        [
            'https://github.com/hzcheng/agent-pivot/blob/HEAD/../../THIRD_PARTY_NOTICES.md',
            'VSCE-rewritten notices link',
        ],
    ]) {
        assertIncludes(bridgeReadme, needle, `packaged UI Bridge README ${label}`);
    }
    assertIncludes(mainBundle, '_agentPivotOpenWorkspaces.', 'packaged main bundle');
    assertIncludes(mainBundle, '_agentPivotAttention.', 'packaged main bundle');
    assertNotIncludes(mainBundle, '_agentPivotOpenProjects', 'packaged main bundle');
    assertNotIncludes(mainBundle, FORBIDDEN_PROTOCOL_PREFIX, 'packaged main bundle');
    assertIncludes(bridgeBundle, '_agentPivotOpenWorkspaces.', 'packaged UI Bridge bundle');
    assertIncludes(bridgeBundle, '_agentPivotAttention.', 'packaged UI Bridge bundle');
    assert.match(bridgeBundle, /["']open-workspaces["'],["']v4["'],["']instances["']/,
        'packaged UI Bridge bundle must retain the v4 registry path');
    assertNotIncludes(bridgeBundle, '_agentPivotOpenProjects', 'packaged UI Bridge bundle');
    assertNotIncludes(bridgeBundle, FORBIDDEN_PROTOCOL_PREFIX, 'packaged UI Bridge bundle');
    for (const [content, label] of [
        [mainEntries.get('extension/package.json').toString('utf8'), 'packaged main manifest'],
        [mainReadme, 'packaged main README'],
        [
            currentChangelogSection(
                mainEntries.get('extension/changelog.md').toString('utf8'),
            ),
            'packaged current CHANGELOG section',
        ],
        [mainBundle, 'packaged main bundle'],
        [bridgeEntries.get('extension/package.json').toString('utf8'), 'packaged UI Bridge manifest'],
        [bridgeReadme, 'packaged UI Bridge README'],
        [bridgeBundle, 'packaged UI Bridge bundle'],
    ]) {
        assertNoForbiddenLegacyIdentity(content, label);
    }
    for (const entries of [mainEntries, bridgeEntries]) {
        for (const [fileName, content] of entries) {
            assert.doesNotMatch(fileName,
                /(?:\.map$|(?:^|\/)(?:docs|src|scripts|test|tests|spikes|\.codex|\.github|\.superpowers|\.vscode)(?:\/|$)|media\/brand\/|workspace-navigation-probe)/i,
                `release archive must exclude non-production entry ${fileName}`);
            assert.strictEqual(content.includes('STALE_RELEASE_PACKAGING_PROBE'), false,
                `release archive must not retain seeded stale output in ${fileName}`);
        }
    }
    for (const [archiveEntry, localPath] of [
        ['extension/media/styles.css', 'media/styles.css'],
        ['extension/media/webviewProjectScripts.js', 'media/webviewProjectScripts.js'],
        ['extension/media/webviewPromptScripts.js', 'media/webviewPromptScripts.js'],
        ['extension/media/webviewScrollStateScripts.js', 'media/webviewScrollStateScripts.js'],
        ['extension/media/webviewTodoScripts.js', 'media/webviewTodoScripts.js'],
    ]) {
        assert.deepStrictEqual(mainEntries.get(archiveEntry), fs.readFileSync(path.join(repositoryRoot, localPath)),
            `${archiveEntry} must match the production-generated local asset`);
    }
}

function extractMarkedRows(source, marker) {
    const block = source.match(new RegExp(
        `<!-- ${marker}:start -->\\n([\\s\\S]*?)\\n<!-- ${marker}:end -->`
    ));
    assert.ok(block, `acceptance report must include ${marker} markers`);
    const lines = block[1].split('\n').filter(line => line.startsWith('| '));
    assert.ok(lines.length >= 2, `${marker} must include a Markdown table header`);
    assert.strictEqual(
        lines[0],
        '| Environment | Workspace kind | Provider | Runtime layout | Action | Expected result | Observed result | Evidence | Status |',
        `${marker} must use the required acceptance columns`
    );
    return lines.slice(2);
}

function parseAcceptanceRow(row) {
    const values = [];
    let cell = '';
    for (let index = 1; index < row.length - 1; index += 1) {
        if (row[index] === '\\' && row[index + 1] === '|') {
            cell += '|';
            index += 1;
        } else if (row[index] === '|') {
            values.push(cell.trim());
            cell = '';
        } else {
            cell += row[index];
        }
    }
    values.push(cell.trim());
    assert.strictEqual(values.length, 9, `acceptance row must have exactly nine columns: ${row}`);
    return {
        environment: values[0],
        workspaceKind: values[1],
        provider: values[2],
        runtimeLayout: values[3],
        status: values[8],
    };
}

function expectedCartesianKeys(dimensions) {
    return dimensions.reduce(
        (keys, values) => keys.flatMap(key => values.map(value => key ? `${key}|${value}` : value)),
        [''],
    );
}

function assertExactKeySet(actualKeys, expectedKeys, label) {
    assert.deepStrictEqual(
        Array.from(new Set(actualKeys)).sort(),
        expectedKeys.slice().sort(),
        `${label} must contain the exact supported-domain Cartesian product`,
    );
    assert.strictEqual(actualKeys.length, expectedKeys.length,
        `${label} must not contain duplicate or extra rows`);
}

function validateAcceptanceMatrixDomains(report, navigationRowLines, launchRowLines, supplementalRowLines) {
    const environments = ['Local', 'SSH', 'WSL', 'Dev Container'];
    const workspaceKinds = ['single-folder', 'saved multi-root', 'untitled multi-root'];
    const providers = ['Codex', 'Kimi', 'Claude'];
    const runtimeLayouts = ['Direct Terminal', 'project-layout tmux', 'session-layout tmux'];
    const allowedStatuses = new Set(['PASS', 'FAIL', 'BLOCKED']);
    const navigationRows = navigationRowLines.map(parseAcceptanceRow);
    const launchRows = launchRowLines.map(parseAcceptanceRow);
    const supplementalRows = supplementalRowLines.map(parseAcceptanceRow);

    assertExactKeySet(
        navigationRows.map(row => [
            row.environment,
            row.workspaceKind,
            row.provider,
            row.runtimeLayout,
        ].join('|')),
        expectedCartesianKeys([environments, workspaceKinds, ['N/A'], ['OTHER WINDOWS']]),
        'navigation matrix',
    );
    assertExactKeySet(
        launchRows.map(row => [
            row.environment,
            row.workspaceKind,
            row.provider,
            row.runtimeLayout,
        ].join('|')),
        expectedCartesianKeys([environments, workspaceKinds, providers, runtimeLayouts]),
        'launch matrix',
    );
    assertExactKeySet(
        supplementalRows.map(row => [
            row.environment,
            row.workspaceKind,
            row.provider,
            row.runtimeLayout,
        ].join('|')),
        expectedCartesianKeys([
            environments,
            workspaceKinds,
            ['Codex / Kimi / Claude'],
            ['Direct / project tmux / session tmux'],
        ]),
        'supplemental matrix',
    );

    const statuses = [...navigationRows, ...launchRows, ...supplementalRows]
        .map(row => row.status);
    for (const status of statuses) {
        assert.ok(allowedStatuses.has(status), `manual acceptance status must be PASS, FAIL, or BLOCKED: ${status}`);
    }
    const expectedOverall = statuses.some(status => status === 'FAIL' || status === 'BLOCKED')
        ? 'BLOCKED'
        : 'PASS';
    const overall = report.match(/\*\*Overall status: (PASS|BLOCKED)\*\*/);
    assert.ok(overall, 'acceptance report must declare PASS or BLOCKED overall status');
    assert.strictEqual(overall[1], expectedOverall,
        'overall acceptance must be BLOCKED for any FAIL/BLOCKED cell and PASS only when every cell passes');
}

function runAcceptanceReportChecks() {
    assert.strictEqual(parseAcceptanceRow(
        '| Local | single-folder | N/A | OTHER WINDOWS | Action | Expected | Observed | Evidence \\| detail | PASS |'
    ).status, 'PASS', 'matrix parser must preserve escaped pipe characters inside evidence cells');
    const report = readText('docs/superpowers/reports/2026-07-20-workspace-first-acceptance.md');
    const navigationRows = extractMarkedRows(report, 'workspace-navigation-matrix');
    const launchRows = extractMarkedRows(report, 'workspace-launch-matrix');
    const supplementalRows = extractMarkedRows(report, 'workspace-supplemental-matrix');
    validateAcceptanceMatrixDomains(report, navigationRows, launchRows, supplementalRows);
    assertIncludes(report, '0 violations observed across 0 runnable manual navigation trials',
        'workspace-first acceptance report');
    assertIncludes(report, 'workspace-first-saved-projects.json',
        'workspace-first acceptance report');
}

function run() {
    const mainPackage = readJson('package.json');
    const bridgePackage = readJson('extensions/attention-ui-bridge/package.json');
    const bridgeId = `${bridgePackage.publisher}.${bridgePackage.name}`;

    assert.deepStrictEqual(
        mainPackage.extensionDependencies,
        [bridgeId],
        'main extension dependency must exactly match the UI Bridge extension id'
    );
    assert.deepStrictEqual(bridgePackage.extensionKind, ['ui'], 'UI Bridge must run in the UI extension host');
    assert.strictEqual(bridgePackage.api, 'none', 'UI Bridge must not expose a public API');

    assert.ok(mainPackage.scripts['package:release'], 'package.json must define package:release');
    assert.ok(mainPackage.scripts['test:release-packaging'], 'package.json must define test:release-packaging');
    assert.strictEqual(mainPackage.scripts['test:extension-host'],
        'npm run package:release && node scripts/run-extension-host-tests.js',
        'package.json must define the reviewed Extension Host runner');
    assert.strictEqual(
        mainPackage.scripts['vscode:prepublish'],
        'npm run brand:verify && npm run brand:check && webpack --mode production && npx gulp --production',
        'VS Code prepublish must reject generated-asset or product-identity drift before building',
    );
    assert.strictEqual(
        mainPackage.scripts['test:ci:linux'],
        'npm run test-compile && npm run brand:verify && npm run brand:check && npm run test:behavior-contracts && npm run lint:ci && npm run test:deterministic:run && npm run test:conversation-sources:remote && npm run test:conversation-performance && npm run test:browser:run && npm run test:safety:run && npm run test:dashboard:run && npm run test:architecture-baseline && npm run test:architecture-guards && npm run test:release-notes && npm run test:release-packaging && npm run vscode:prepublish && npm run test:coverage:run && node scripts/check-coverage-baseline.js && node scripts/check-changed-coverage.js',
        'Linux CI must run non-mutating brand verification and identity checks before quality gates',
    );
    assert.strictEqual(mainPackage.devDependencies['@vscode/test-electron'], '3.0.0',
        '@vscode/test-electron must remain an exact direct development dependency');
    assert.strictEqual(
        mainPackage.scripts['test:release-packaging'],
        'node scripts/seed-release-packaging-stale-output.js && npm run package:release && node scripts/run-release-packaging-checks.js',
        'release packaging verification must seed stale output, rebuild clean, then inspect the real archives'
    );
    assertIncludes(mainPackage.scripts['package:release'], 'clean-release-build.js',
        'release package script');
    assertIncludes(mainPackage.scripts['package:release'], 'test-compile',
        'release package script');
    assertIncludes(mainPackage.scripts['package:release'], 'attention:bridge:compile',
        'release package script');
    assertIncludes(mainPackage.scripts['package:release'], 'vscode:prepublish',
        'release package script');
    assertNotIncludes(mainPackage.scripts['package:release'], 'test:release-packaging',
        'release package script');

    const releasePackager = readText('scripts/package-release-extensions.js');
    assertIncludes(releasePackager, 'extensions\', \'attention-ui-bridge', 'release packager');
    assertIncludes(releasePackager, 'artifacts', 'release packager');
    assertIncludes(releasePackager, 'bridgePackage.name', 'release packager');
    assertIncludes(releasePackager, 'mainPackage.name', 'release packager');
    assertNotIncludes(releasePackager, 'attention-workspace-probe', 'release packager');
    assertNotIncludes(releasePackager, 'spikes/attention-local-bridge/workspace', 'release packager');

    const installScript = readText('scripts/build-test-package-install.sh');
    assertIncludes(installScript, 'npm run package:release', 'local install script');
    assertIncludes(installScript, 'BRIDGE_VERSION', 'local install script');
    assertIncludes(installScript, '--install-extension "$BRIDGE_VSIX" --force', 'local install script');
    assertIncludes(installScript, '--install-extension "$MAIN_VSIX" --force', 'local install script');
    assertNotIncludes(installScript, 'agent-pivot-attention-ui-bridge-0.1.3.vsix', 'local install script');

    const publishScript = readText('scripts/publish-marketplace.sh');
    assertIncludes(publishScript, 'BRIDGE_NAME', 'Marketplace publish script');
    assertIncludes(publishScript, 'BRIDGE_VERSION', 'Marketplace publish script');
    assertIncludes(publishScript, 'BRIDGE_VSIX_FILE', 'Marketplace publish script');
    assertIncludes(publishScript, 'BRIDGE_PUBLISH_ARGS=(publish --packagePath "$BRIDGE_VSIX_FILE"', 'Marketplace publish script');
    assertIncludes(publishScript, 'PUBLISH_ARGS=(publish --packagePath "$VSIX_FILE"', 'Marketplace publish script');
    assertIncludes(publishScript, 'run_vsce "${BRIDGE_PUBLISH_ARGS[@]}"', 'Marketplace publish script');
    assertIncludes(publishScript, 'run_vsce "${PUBLISH_ARGS[@]}"', 'Marketplace publish script');
    assert.ok(
        publishScript.indexOf('run_vsce "${BRIDGE_PUBLISH_ARGS[@]}"') <
            publishScript.indexOf('run_vsce "${PUBLISH_ARGS[@]}"'),
        'Marketplace publish script must publish UI Bridge before the main extension'
    );

    const workflow = readText('.github/workflows/release-vsix.yml');
    assertIncludes(workflow, 'name: Release Agent Pivot VSIX', 'GitHub release workflow');
    assertIncludes(workflow, 'bridge_name=', 'GitHub release workflow');
    assertIncludes(workflow, 'bridge_version=', 'GitHub release workflow');
    assertIncludes(workflow, 'bridge_vsix_file=', 'GitHub release workflow');
    assertIncludes(workflow, 'npm run test:release-packaging', 'GitHub release workflow');
    assertNotIncludes(workflow, 'npm run package:release', 'GitHub release workflow');
    assertIncludes(workflow, '${{ steps.meta.outputs.bridge_vsix_file }}', 'GitHub release workflow');
    assertIncludes(workflow, 'sha256sum', 'GitHub release workflow');
    assertNotIncludes(workflow, 'npx --yes @vscode/vsce package --allow-star-activation --out "${{ steps.meta.outputs.vsix_file }}"', 'GitHub release workflow');
    assert.ok(
        workflow.indexOf('npm run lint') < workflow.indexOf('npm run test:release-packaging'),
        'GitHub release workflow must build/package/verify only after compile and lint'
    );

    const verifyWorkflow = readText('.github/workflows/verify.yml');
    validateVerifyWorkflow(verifyWorkflow);
    const verifyMutation = parseWorkflow(verifyWorkflow, 'verification workflow mutation fixture');
    verifyMutation.jobs['quality-linux'].steps[0]['continue-on-error'] = true;
    assert.throws(() => validateVerifyWorkflow(yaml.safeDump(verifyMutation)), assert.AssertionError,
        'reusable verification must recursively reject continue-on-error');

    const scheduled = parseWorkflow(readText('.github/workflows/scheduled-verification.yml'),
        'scheduled verification workflow');
    validateScheduledWorkflow(scheduled);
    assertWorkflowMutationRejected(validateScheduledWorkflow, scheduled,
        value => { delete value.on.schedule; }, 'schedule removal must be rejected');
    assertWorkflowMutationRejected(validateScheduledWorkflow, scheduled,
        value => { value.jobs['scheduled-macos'].steps[1].with['node-version'] = '22'; },
        'Node version drift must be rejected');
    assertWorkflowMutationRejected(validateScheduledWorkflow, scheduled,
        value => { value.jobs['scheduled-macos'].steps.push({ uses: 'actions/upload-artifact@v4' }); },
        'artifact upload must be rejected');
    assertWorkflowMutationRejected(validateScheduledWorkflow, scheduled,
        value => { value.jobs['scheduled-macos'].steps.pop(); },
        'Extension Host step removal must be rejected');
    assertWorkflowMutationRejected(validateScheduledWorkflow, scheduled,
        value => {
            const steps = value.jobs['scheduled-macos'].steps;
            [steps[3], steps[4]] = [steps[4], steps[3]];
        }, 'conversation source and Extension Host step reordering must be rejected');
    assertWorkflowMutationsRejected(validateScheduledWorkflow, scheduled, [
        ['invalid cron expression', value => { value.on.schedule[0].cron = 'not a cron'; }],
        ['secrets context reference', value => {
            value.jobs['scheduled-macos'].steps[0].env = { TOKEN: '${{ secrets.RELEASE_TOKEN }}' };
        }],
        ['case-insensitive spaced secrets context reference', value => {
            value.name = 'Scheduled ${{  SeCrEtS . RELEASE_TOKEN }}';
        }],
        ['continue-on-error', value => { value.jobs['scheduled-macos']['continue-on-error'] = true; }],
        ['additional artifact action', value => {
            value.jobs['scheduled-macos'].steps.push({ uses: 'actions/upload-pages-artifact@v3' });
        }],
        ['job if condition', value => { value.jobs['scheduled-macos'].if = false; }],
        ['secrets context mapping key', value => {
            value.metadata = { '${{ secrets.TOKEN }}': 'redacted' };
        }],
        ['out-of-range cron fields', value => { value.on.schedule[0].cron = '99 99 99 99 99'; }],
        ['unreviewed every-minute schedule', value => { value.on.schedule[0].cron = '* * * * *'; }],
    ]);

    const release = parseWorkflow(workflow, 'release workflow');
    validateReleaseWorkflow(release);
    assertWorkflowMutationRejected(validateReleaseWorkflow, release,
        value => { delete value.jobs.release.needs; }, 'release dependency removal must be rejected');
    assertWorkflowMutationRejected(validateReleaseWorkflow, release,
        value => { value.jobs['release-extension-host'].needs = 'release'; },
        'release Extension Host dependency mutation must be rejected');
    assertWorkflowMutationRejected(validateReleaseWorkflow, release,
        value => { value.permissions = { contents: 'write' }; },
        'top-level write permission must be rejected');
    assertWorkflowMutationRejected(validateReleaseWorkflow, release,
        value => { value.jobs.verify.secrets = 'inherit'; },
        'verification secrets inheritance must be rejected');
    assertWorkflowMutationRejected(validateReleaseWorkflow, release,
        value => { value.jobs.release.steps[0]['continue-on-error'] = true; },
        'release continue-on-error must be rejected recursively');

    const mainIgnore = readText('.vscodeignore');
    const bridgeIgnore = readText('extensions/attention-ui-bridge/.vscodeignore');
    assertIncludes(mainIgnore, 'spikes/**', 'main VSIX ignore rules');
    assertIncludes(mainIgnore, '.superpowers/**', 'main VSIX ignore rules');
    assertIncludes(mainIgnore, '.github/**', 'main VSIX ignore rules');
    assertIncludes(mainIgnore, 'docs/**', 'main VSIX ignore rules');
    assertIncludes(mainIgnore, 'docs/superpowers/**', 'main VSIX ignore rules');
    assertIncludes(mainIgnore, '.codex/**', 'main VSIX ignore rules');
    assertIncludes(mainIgnore, 'media/brand/**', 'main VSIX ignore rules');
    assertIncludes(mainIgnore, '!licenses/DOMPurify-Apache-2.0.txt', 'main VSIX ignore rules');
    assertIncludes(mainIgnore, '!licenses/Mermaid-MIT.txt', 'main VSIX ignore rules');
    assertIncludes(mainIgnore, '!out/workspaces/*.js', 'main VSIX ignore rules');
    assertIncludes(mainIgnore, '!out/openWorkspaces/*.js', 'main VSIX ignore rules');
    assertNotIncludes(mainIgnore, '!out/workspaces/**', 'main VSIX ignore rules');
    assertNotIncludes(mainIgnore, '!out/openWorkspaces/**', 'main VSIX ignore rules');
    assertIncludes(mainIgnore, 'out/**/*.map', 'main VSIX ignore rules');
    assertIncludes(mainIgnore, '!media/webviewProjectScripts.js', 'main VSIX ignore rules');
    assertIncludes(mainIgnore, '!media/webviewPromptScripts.js', 'main VSIX ignore rules');
    assertIncludes(mainIgnore, '!media/webviewScrollStateScripts.js', 'main VSIX ignore rules');
    assertIncludes(mainIgnore, '!media/webviewTodoScripts.js', 'main VSIX ignore rules');
    assertIncludes(mainIgnore, '!media/mermaid.min.js', 'main VSIX ignore rules');
    assertIncludes(mainIgnore, '!media/styles.css', 'main VSIX ignore rules');
    assertIncludes(bridgeIgnore, 'src/**', 'UI Bridge VSIX ignore rules');
    assertIncludes(bridgeIgnore, 'out/**', 'UI Bridge VSIX ignore rules');
    assertIncludes(bridgeIgnore, '*.map', 'UI Bridge VSIX ignore rules');

    for (const requiredArtifact of [
        'out/workspaces/types.js',
        'out/workspaces/contextResolver.js',
        'out/workspaces/savedWorkspaceProjectAdapter.js',
        'out/openWorkspaces/protocol.js',
        'out/openWorkspaces/bridgeClient.js',
        'out/openWorkspaces/navigationController.js',
        'out/openWorkspaces/pinController.js',
        'out/openWorkspaces/pinProtocol.js',
        'dist/dashboard.js',
        'media/webviewProjectScripts.js',
        'media/webviewPromptScripts.js',
        'media/webviewScrollStateScripts.js',
        'media/webviewTodoScripts.js',
        'media/mermaid.min.js',
        'media/styles.css',
        'extensions/attention-ui-bridge/dist/extension.js',
    ]) {
        assert.ok(fs.statSync(path.join(repositoryRoot, requiredArtifact)).isFile(),
            `production build must generate ${requiredArtifact}`);
    }

    const bridgeBundle = readText('extensions/attention-ui-bridge/dist/extension.js');
    assertIncludes(bridgeBundle, '_agentPivotOpenWorkspaces', 'UI Bridge bundle');
    assertIncludes(bridgeBundle, '_agentPivotOpenWorkspaces.bridge.setPin', 'UI Bridge bundle');
    assert.match(bridgeBundle, /["']open-workspaces["'],["']v4["'],["']instances["']/,
        'UI Bridge bundle must retain the open-workspaces/v4/instances registry path');
    assertNotIncludes(bridgeBundle, '_agentPivotOpenProjects', 'UI Bridge bundle');

    runRealVsixArchiveChecks(mainPackage, bridgePackage);

    runAcceptanceReportChecks();
}

if (require.main === module) {
    run();
    console.log('Release packaging checks passed.');
}

module.exports = {
    EXPECTED_MAIN_ENTRIES,
    assertExactEntries,
};
