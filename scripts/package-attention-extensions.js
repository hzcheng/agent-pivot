'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const repositoryRoot = path.resolve(__dirname, '..');

function readPackageManifest(extensionDirectory) {
    return JSON.parse(fs.readFileSync(
        path.join(extensionDirectory, 'package.json'),
        'utf8'
    ));
}

function createAttentionExtensionPackagePlan(root = repositoryRoot) {
    const spikeRoot = path.join(root, 'spikes', 'attention-local-bridge');
    const extensionDirectories = [
        path.join(root, 'extensions', 'attention-ui-bridge'),
        path.join(spikeRoot, 'workspace'),
    ];
    return extensionDirectories.map(extensionDirectory => {
        const manifest = readPackageManifest(extensionDirectory);
        return {
            extensionDirectory,
            artifactPath: `artifacts/${manifest.name}-${manifest.version}.vsix`,
        };
    });
}

function packageAttentionExtensions(root = repositoryRoot) {
    const artifactsDirectory = path.join(root, 'artifacts');
    const packages = createAttentionExtensionPackagePlan(root);
    fs.rmSync(artifactsDirectory, { recursive: true, force: true });
    fs.mkdirSync(artifactsDirectory, { recursive: true });

    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    for (const extensionPackage of packages) {
        const outputPath = path.join(root, extensionPackage.artifactPath);
        const result = childProcess.spawnSync(
            npx,
            ['@vscode/vsce', 'package', '--out', outputPath],
            {
                cwd: extensionPackage.extensionDirectory,
                shell: false,
                stdio: 'inherit',
            }
        );

        if (result.error) {
            throw result.error;
        }
        if (result.status !== 0) {
            process.exit(result.status === null ? 1 : result.status);
        }
    }

    for (const extensionPackage of packages) {
        console.log(extensionPackage.artifactPath);
    }
}

if (require.main === module) {
    packageAttentionExtensions();
}

module.exports = {
    createAttentionExtensionPackagePlan,
    packageAttentionExtensions,
};
