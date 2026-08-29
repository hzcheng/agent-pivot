'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const BRAND_IDENTITY = Object.freeze({
    displayName: 'Agent Pivot',
    publisher: 'hzcheng',
    mainPackageName: 'agent-pivot',
    mainExtensionId: 'hzcheng.agent-pivot',
    mainVersion: '1.3.0',
    bridgePackageName: 'agent-pivot-attention-ui-bridge',
    bridgeExtensionId: 'hzcheng.agent-pivot-attention-ui-bridge',
    bridgeVersion: '1.0.3',
    commandPrefix: 'agentPivot.',
    configurationSection: 'agentPivot',
    viewContainerId: 'agentPivot',
    viewId: 'agentPivot.dashboard',
    repositoryUrl: 'https://github.com/hzcheng/agent-pivot.git',
});

const IDENTITY_SCAN_TARGETS = Object.freeze([
    'package.json',
    'package-lock.json',
    'extensions/attention-ui-bridge/package.json',
    'extensions/attention-ui-bridge/README.md',
    'extensions/attention-ui-bridge/LICENSE',
    'src',
    'extensions/attention-ui-bridge/src',
    'scripts',
    'spikes',
    '.github/workflows',
    '.skills',
    'README.md',
    'CHANGELOG.md',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
    'docs',
    'media',
]);

const HISTORICAL_IDENTITY_ALLOWLIST = Object.freeze([
    /^LICENSE$/,
    /^extensions\/attention-ui-bridge\/LICENSE$/,
    /^docs\/development-history\.md$/,
    /^docs\/superpowers\/(?:specs|plans|reports)\//,
]);

const SKIPPED_DIRECTORIES = new Set([
    '.git', '.worktree', 'node_modules', 'out', 'dist', 'coverage',
    '.superpowers', 'releases', 'tests',
]);
const SCANNED_EXTENSIONS = new Set([
    '.json', '.js', '.ts', '.md', '.yml', '.yaml', '.svg', '.scss', '.css', '.sh', '.txt',
]);
const STALE_IDENTITY_TOKENS = Object.freeze([
    'Project Steward',
    'project-steward',
    'projectSteward',
    'PROJECT_STEWARD',
    'hzcheng.project-steward',
    'the Dashboard',
    'Dashboard views',
    '[Dashboard]',
    'Sharingan',
    'sharingan',
    'Mangekyo',
    'Mangekyō',
]);
const INHERITED_ICON_SHA256 = Object.freeze([
    '7c937a29143bc743a99bdbcbfdc5d1add2fb73436fd3adbfb713595e692a454b',
    '9b4e9fb6acc807261862c2d57fbaa6f232b6a5b6739fbccec5308c890641cf8a',
]);
const APPROVED_FORK_ATTRIBUTION =
    'Agent Pivot began as a fork of Kruemelkatze/vscode-dashboard and retains the upstream MIT attribution.';

function formatValue(value) {
    return value === undefined ? 'undefined' : JSON.stringify(value);
}

function assertObject(value, description) {
    assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value),
        `${description} must be an object; received ${formatValue(value)}`);
}

function assertArray(value, description) {
    assert.ok(Array.isArray(value),
        `${description} must be an array; received ${formatValue(value)}`);
}

function validateManifestPair(mainManifest, bridgeManifest) {
    assertObject(mainManifest, 'Main manifest');
    assertObject(bridgeManifest, 'Bridge manifest');
    assert.equal(mainManifest.name, BRAND_IDENTITY.mainPackageName,
        `Main manifest name is stale: ${formatValue(mainManifest.name)}`);
    assert.equal(mainManifest.displayName, BRAND_IDENTITY.displayName,
        `Main manifest display name is stale: ${formatValue(mainManifest.displayName)}`);
    assert.equal(mainManifest.publisher, BRAND_IDENTITY.publisher,
        `Main manifest publisher is stale: ${formatValue(mainManifest.publisher)}`);
    assert.equal(mainManifest.version, BRAND_IDENTITY.mainVersion,
        `Main manifest version is stale: ${formatValue(mainManifest.version)}`);
    assert.equal(mainManifest.icon, 'media/extension_icon.png',
        `Main manifest icon is invalid: ${formatValue(mainManifest.icon)}`);
    assert.equal(mainManifest.repository?.url, BRAND_IDENTITY.repositoryUrl,
        `Main manifest repository URL is invalid: ${formatValue(mainManifest.repository?.url)}`);
    assert.equal(mainManifest.homepage, 'https://github.com/hzcheng/agent-pivot#readme',
        `Main manifest homepage is invalid: ${formatValue(mainManifest.homepage)}`);
    assert.equal(mainManifest.bugs?.url, 'https://github.com/hzcheng/agent-pivot/issues',
        `Main manifest bugs URL is invalid: ${formatValue(mainManifest.bugs?.url)}`);
    assert.equal(mainManifest.license, 'MIT',
        `Main manifest license is invalid: ${formatValue(mainManifest.license)}`);
    assert.deepEqual(mainManifest.categories, ['Other'],
        `Main manifest categories are invalid: ${formatValue(mainManifest.categories)}`);
    assert.deepEqual(mainManifest.keywords, [
        'agent', 'ai',
        'codex', 'codex cli',
        'claude', 'claude code',
        'kimi', 'kimi cli',
        'ai sessions', 'session manager',
        'project manager', 'projects',
        'prompts', 'prompt library',
        'workspace', 'tmux', 'dashboard',
    ], `Main manifest keywords are invalid: ${formatValue(mainManifest.keywords)}`);
    assert.deepEqual(mainManifest.extensionDependencies, [BRAND_IDENTITY.bridgeExtensionId],
        `Main manifest extension dependencies are invalid: ${formatValue(mainManifest.extensionDependencies)}`);

    assert.equal(bridgeManifest.name, BRAND_IDENTITY.bridgePackageName,
        `Bridge manifest name is stale: ${formatValue(bridgeManifest.name)}`);
    assert.equal(bridgeManifest.displayName, 'Agent Pivot Attention UI Bridge',
        `Bridge manifest display name is stale: ${formatValue(bridgeManifest.displayName)}`);
    assert.equal(bridgeManifest.publisher, BRAND_IDENTITY.publisher,
        `Bridge manifest publisher is stale: ${formatValue(bridgeManifest.publisher)}`);
    assert.equal(bridgeManifest.version, BRAND_IDENTITY.bridgeVersion,
        `Bridge manifest version is stale: ${formatValue(bridgeManifest.version)}`);
    assert.equal(bridgeManifest.icon, 'media/extension_icon.png',
        `Bridge manifest icon is invalid: ${formatValue(bridgeManifest.icon)}`);
    assert.equal(bridgeManifest.license, 'MIT',
        `Bridge manifest license is invalid: ${formatValue(bridgeManifest.license)}`);
    assert.deepEqual(bridgeManifest.categories, ['Other'],
        `Bridge manifest categories are invalid: ${formatValue(bridgeManifest.categories)}`);
    assert.equal(bridgeManifest.repository?.url, BRAND_IDENTITY.repositoryUrl,
        `Bridge manifest repository URL is invalid: ${formatValue(bridgeManifest.repository?.url)}`);
    assert.equal(bridgeManifest.homepage, 'https://github.com/hzcheng/agent-pivot#readme',
        `Bridge manifest homepage is invalid: ${formatValue(bridgeManifest.homepage)}`);
    assert.equal(bridgeManifest.bugs?.url, 'https://github.com/hzcheng/agent-pivot/issues',
        `Bridge manifest bugs URL is invalid: ${formatValue(bridgeManifest.bugs?.url)}`);
    assert.deepEqual(bridgeManifest.contributes?.commands ?? [], [],
        `Bridge manifest commands are invalid: ${formatValue(bridgeManifest.contributes?.commands)}`);

    const contributes = mainManifest.contributes;
    assertObject(contributes, 'Main manifest contributes');
    assertArray(contributes.commands, 'Main manifest commands');
    for (const command of contributes.commands) {
        const value = command?.command;
        assert.equal(typeof value, 'string',
            `Main manifest command must be a string; received ${formatValue(value)}`);
        assert.ok(value.startsWith(BRAND_IDENTITY.commandPrefix),
            `Main manifest command must start with ${BRAND_IDENTITY.commandPrefix}: ${value}`);
    }

    const properties = contributes.configuration?.properties;
    assertObject(properties, 'Main manifest configuration properties');
    for (const key of Object.keys(properties)) {
        assert.ok(key.startsWith(BRAND_IDENTITY.commandPrefix),
            `Main manifest configuration key must start with ${BRAND_IDENTITY.commandPrefix}: ${key}`);
    }

    const activitybar = contributes.viewsContainers?.activitybar;
    assertArray(activitybar, 'Main manifest activity bar view containers');
    assert.equal(activitybar.length, 1,
        `Main manifest must define one activity bar view container: ${formatValue(activitybar)}`);
    assert.equal(activitybar[0]?.id, BRAND_IDENTITY.viewContainerId,
        `Main manifest activity bar view container is invalid: ${formatValue(activitybar[0]?.id)}`);

    const views = contributes.views;
    assertObject(views, 'Main manifest views');
    assert.deepEqual(Object.keys(views), [BRAND_IDENTITY.viewContainerId],
        `Main manifest view container keys are invalid: ${formatValue(Object.keys(views))}`);
    const dashboardViews = views[BRAND_IDENTITY.viewContainerId];
    assertArray(dashboardViews, 'Main manifest dashboard views');
    assert.equal(dashboardViews.length, 1,
        `Main manifest must define one dashboard view: ${formatValue(dashboardViews)}`);
    assert.equal(dashboardViews[0]?.id, BRAND_IDENTITY.viewId,
        `Main manifest dashboard view is invalid: ${formatValue(dashboardViews[0]?.id)}`);
}

function isScannableFile(relativePath) {
    const extension = path.extname(relativePath);
    return extension === '' || SCANNED_EXTENSIONS.has(extension);
}

function isAllowedHistoricalPath(relativePath) {
    return HISTORICAL_IDENTITY_ALLOWLIST.some(pattern => pattern.test(relativePath));
}

function collectTargetFiles(root, target, files) {
    const absolutePath = path.join(root, target);
    if (!fs.existsSync(absolutePath)) {
        return;
    }
    const stat = fs.statSync(absolutePath);
    if (stat.isFile()) {
        const relativePath = target.split(path.sep).join('/');
        if (isScannableFile(relativePath)) {
            files.push(relativePath);
        }
        return;
    }
    if (!stat.isDirectory()) {
        return;
    }
    for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))) {
        if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) {
            continue;
        }
        const child = path.join(target, entry.name);
        if (entry.isDirectory()) {
            collectTargetFiles(root, child, files);
        } else if (entry.isFile()) {
            const relativePath = child.split(path.sep).join('/');
            if (isScannableFile(relativePath)) {
                files.push(relativePath);
            }
        }
    }
}

function findStaleIdentity(root) {
    const files = [];
    for (const target of IDENTITY_SCAN_TARGETS) {
        collectTargetFiles(root, target, files);
    }
    const findings = [];
    for (const relativePath of [...new Set(files)].sort()) {
        if (relativePath === 'scripts/lib/brandIdentity.js'
            || isAllowedHistoricalPath(relativePath)) {
            continue;
        }
        const lines = fs.readFileSync(path.join(root, relativePath), 'utf8').split(/\r?\n/);
        for (const [index, line] of lines.entries()) {
            if ((relativePath === 'README.md'
                || relativePath === 'extensions/attention-ui-bridge/README.md')
                && line === APPROVED_FORK_ATTRIBUTION) {
                continue;
            }
            for (const token of STALE_IDENTITY_TOKENS) {
                if (line.includes(token)) {
                    findings.push({
                        file: relativePath,
                        line: index + 1,
                        token,
                        excerpt: line.trim(),
                    });
                }
            }
        }
    }
    return findings.sort((left, right) => left.file.localeCompare(right.file)
        || left.line - right.line || left.token.localeCompare(right.token));
}

function sha256File(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function validateInheritedIconHashes(root, hashFile = sha256File) {
    for (const relativePath of [
        'media/extension_icon.png',
        'media/icon.svg',
        'extensions/attention-ui-bridge/media/extension_icon.png',
    ]) {
        const file = path.join(root, relativePath);
        assert.ok(fs.existsSync(file), `Current icon output is missing: ${relativePath}`);
        const hash = hashFile(file);
        assert.ok(!INHERITED_ICON_SHA256.includes(hash),
            `Current icon output inherits a rejected hash for ${relativePath}: ${hash}`);
    }
}

module.exports = {
    BRAND_IDENTITY,
    findStaleIdentity,
    INHERITED_ICON_SHA256,
    validateInheritedIconHashes,
    validateManifestPair,
};
