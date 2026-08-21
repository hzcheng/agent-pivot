'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const packageJson = require(path.resolve(__dirname, '../../../package.json'));
const {
    createAttentionExtensionPackagePlan,
} = require('../../../scripts/package-attention-extensions');
const {
    buildDashboardWebviewBundle,
    inputPaths: dashboardBundleInputPaths,
    outputPath: dashboardBundleOutputPath,
} = require('../../../scripts/build-dashboard-webview-bundle');
const { staleRelativePaths } = require('../../../scripts/seed-release-packaging-stale-output');

const expectedStaleRelativePaths = [
    'out/stale-release-output.js',
    'dist/stale-release-output.js',
    'extensions/attention-ui-bridge/out/stale-release-output.js',
    'extensions/attention-ui-bridge/dist/stale-release-output.js',
    'coverage/tmp/stale-coverage.json',
];

function assertReleaseResidueContract(paths, vscodeIgnore) {
    assert.deepEqual(paths, expectedStaleRelativePaths);
    for (const exclusion of ['.ci/**', 'tests/**', 'coverage/**']) {
        assert.ok(vscodeIgnore.split(/\r?\n/).includes(exclusion),
            `.vscodeignore must exclude ${exclusion}`);
    }
}

test('TEST-PACKAGE-SCRIPTS-001 test-compile removes stale outputs before building root and attention bridge TypeScript', () => {
    assert.equal(
        packageJson.scripts['test-compile'],
        'node scripts/clean-test-build.js && node scripts/build-dashboard-webview-bundle.js'
            + ' && tsc -p ./ && npm run attention:bridge:compile'
    );
    assert.equal(require('node:fs').existsSync(
        path.resolve(__dirname, '../../../scripts/clean-test-build.js')
    ), true);
    assert.equal(
        packageJson.scripts['attention:bridge:compile'],
        'tsc -p extensions/attention-ui-bridge/tsconfig.json'
    );
});

test('TEST-PACKAGE-SCRIPTS-001 WEBVIEW-SINGLE-BOOT-ASSET-001 rebuilds the committed dashboard bundle deterministically', () => {
    const committed = fs.readFileSync(dashboardBundleOutputPath, 'utf8');

    assert.equal(buildDashboardWebviewBundle(), dashboardBundleOutputPath);
    assert.equal(fs.readFileSync(dashboardBundleOutputPath, 'utf8'), committed);
    assert.equal(dashboardBundleInputPaths.length, 30);
    for (const inputPath of dashboardBundleInputPaths) {
        assert.ok(committed.includes(`/* ${inputPath} */\n`),
            `the generated bundle must identify ${inputPath}`);
    }
});

test('TEST-PACKAGE-SCRIPTS-001 WEBVIEW-SINGLE-BOOT-ASSET-001 development watcher rebuilds the dashboard bundle', () => {
    const gulpfile = fs.readFileSync(
        path.resolve(__dirname, '../../../gulpfile.js'),
        'utf8'
    );

    assert.match(gulpfile,
        /gulp\.watch\(\s*'src\/webview\/\*\.js',\s*gulp\.series\(copyWebviewAssets, buildDashboardBundle\)\s*\)/);
});

test('RELEASE-ATTENTION-SPIKE-ARTIFACT-VERSION-001 derives every current UI Bridge spike artifact reference from its manifest', () => {
    const bridgePackage = require(path.resolve(
        __dirname,
        '../../../extensions/attention-ui-bridge/package.json'
    ));
    const bridgeArtifactPath = `artifacts/${bridgePackage.name}-${bridgePackage.version}.vsix`;
    const workspacePackage = require(path.resolve(
        __dirname,
        '../../../spikes/attention-local-bridge/workspace/package.json'
    ));
    const workspaceArtifactPath =
        `artifacts/${workspacePackage.name}-${workspacePackage.version}.vsix`;
    const spikeChecks = fs.readFileSync(
        path.resolve(__dirname, '../../../scripts/run-attention-local-bridge-spike-checks.js'),
        'utf8'
    );
    const manualMatrix = fs.readFileSync(
        path.resolve(__dirname, '../../../spikes/attention-local-bridge/MANUAL-MATRIX.md'),
        'utf8'
    );

    assert.deepEqual(
        createAttentionExtensionPackagePlan().map(extensionPackage => extensionPackage.artifactPath),
        [bridgeArtifactPath, workspaceArtifactPath]
    );
    assert.ok(spikeChecks.includes('createAttentionExtensionPackagePlan'));
    assert.ok(manualMatrix.includes(`Install the UI Bridge \`${bridgePackage.version}\``));
    assert.ok(manualMatrix.includes(`\`${bridgeArtifactPath}\``));
    assert.ok(manualMatrix.includes(`\`${workspaceArtifactPath}\``));
    assert.ok(manualMatrix.includes(
        `UI Bridge is \`${bridgePackage.version}\`; Workspace Probe is \`${workspacePackage.version}\`.`
    ));
});

test('RELEASE-VSIX-PACKAGING-001 seeds every repeated-build residue class and excludes non-production roots', () => {
    const vscodeIgnore = fs.readFileSync(
        path.resolve(__dirname, '../../../.vscodeignore'),
        'utf8'
    );
    assertReleaseResidueContract(staleRelativePaths, vscodeIgnore);
    assert.throws(
        () => assertReleaseResidueContract(
            staleRelativePaths.filter(fileName => fileName !== 'coverage/tmp/stale-coverage.json'),
            vscodeIgnore
        ),
        assert.AssertionError
    );
});
