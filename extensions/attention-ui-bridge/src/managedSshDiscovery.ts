'use strict';

import * as fs from 'fs';
import * as path from 'path';

export interface ManagedSshDiscoveryInput {
    platform: NodeJS.Platform;
    homeDirectory: string;
    environmentPath: string;
    windowsDirectory?: string;
    remoteSshPath?: unknown;
    remoteSshConfigFile?: unknown;
}

export interface ManagedSshLocalInputs {
    executable: string;
    activeConfigPath: string;
}

export interface ManagedSshConfiguredPaths {
    executableCandidate: string;
    configPath: string;
}

function assertPlainSetting(value: unknown, label: string): string | undefined {
    if (value === undefined || value === null || value === '') { return undefined; }
    if (typeof value !== 'string' || /[\r\n\0]/u.test(value)) {
        throw new Error(`${label} must be a plain path string.`);
    }
    return value;
}

function expandHome(value: string, homeDirectory: string, platform: NodeJS.Platform): string {
    if (value === '~') { return homeDirectory; }
    if (value.startsWith('~/') || value.startsWith('~\\')) {
        return (platform === 'win32' ? path.win32 : path.posix)
            .join(homeDirectory, value.slice(2));
    }
    return value;
}

function executableCandidates(
    executable: string,
    input: ManagedSshDiscoveryInput,
): string[] {
    const pathApi = input.platform === 'win32' ? path.win32 : path.posix;
    if (pathApi.isAbsolute(executable)) { return [executable]; }
    const separator = input.platform === 'win32' ? ';' : ':';
    const extensions = input.platform === 'win32' && !path.win32.extname(executable)
        ? ['.exe', ''] : [''];
    const result: string[] = [];
    for (const directory of input.environmentPath.split(separator).filter(Boolean)) {
        for (const extension of extensions) {
            result.push(pathApi.join(directory, `${executable}${extension}`));
        }
    }
    return result;
}

function resolveExecutable(executable: string, input: ManagedSshDiscoveryInput): string {
    const match = executableCandidates(executable, input).find(candidate => {
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return fs.lstatSync(candidate).isFile();
        } catch (_error) {
            return false;
        }
    });
    if (!match) {
        throw new Error(`SSH executable was not found: ${executable}`);
    }
    return fs.realpathSync.native(match);
}

export function canonicalizeManagedSshConfigPath(configPath: string): string {
    try {
        const stat = fs.lstatSync(configPath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new Error('The active SSH config must be a regular file, not a link.');
        }
        return fs.realpathSync.native(configPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
        const missingSegments = [path.basename(configPath)];
        let ancestor = path.dirname(configPath);
        while (true) {
            try {
                return path.join(
                    fs.realpathSync.native(ancestor),
                    ...missingSegments.reverse(),
                );
            } catch (ancestorError) {
                if ((ancestorError as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw ancestorError;
                }
                const parent = path.dirname(ancestor);
                if (parent === ancestor) { throw ancestorError; }
                missingSegments.push(path.basename(ancestor));
                ancestor = parent;
            }
        }
    }
}

export function discoverManagedSshLocalInputs(
    input: ManagedSshDiscoveryInput,
): ManagedSshLocalInputs {
    const configured = managedSshConfiguredPaths(input);
    return {
        executable: resolveExecutable(configured.executableCandidate, input),
        activeConfigPath: canonicalizeManagedSshConfigPath(configured.configPath),
    };
}

export function managedSshConfiguredPaths(
    input: ManagedSshDiscoveryInput,
): ManagedSshConfiguredPaths {
    const pathApi = input.platform === 'win32' ? path.win32 : path.posix;
    const configuredExecutable = assertPlainSetting(input.remoteSshPath, 'remote.SSH.path');
    const defaultExecutable = input.platform === 'win32'
        ? path.win32.join(input.windowsDirectory || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
        : 'ssh';
    const configuredConfig = assertPlainSetting(
        input.remoteSshConfigFile,
        'remote.SSH.configFile',
    );
    const configPath = configuredConfig
        ? expandHome(configuredConfig, input.homeDirectory, input.platform)
        : pathApi.join(input.homeDirectory, '.ssh', 'config');
    if (!pathApi.isAbsolute(configPath)) {
        throw new Error('remote.SSH.configFile must resolve to an absolute path.');
    }
    return {
        executableCandidate: configuredExecutable || defaultExecutable,
        configPath,
    };
}
