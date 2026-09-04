'use strict';

import {
    ManagedSshCommandRunner,
    NodeManagedSshCommandRunner,
} from './managedSshValidator';
import {
    NodeManagedSshConfigFileSystem,
    scanManagedSshConfigGraph,
} from './managedSshConfigPolicy';
import { isManagedMachine } from '../../../src/projects/managedRemote/validation';

export interface ManagedLegacySshInspection {
    status: 'needsInput' | 'unsupported';
    reason: string;
    endpoint?: { host: string; user: string; port: number };
}

export interface ManagedLegacySshInspectorOptions {
    platform: NodeJS.Platform;
    runner?: ManagedSshCommandRunner;
    scan?: (activeConfigPath: string) => { issues: string[] };
    timeoutMs?: number;
}

function effectiveConfig(stdout: string): Map<string, string> {
    const result = new Map<string, string>();
    for (const line of stdout.split(/\r?\n/u)) {
        const separator = line.search(/\s/u);
        if (separator <= 0) { continue; }
        const key = line.slice(0, separator).toLocaleLowerCase();
        if (!result.has(key)) { result.set(key, line.slice(separator).trim()); }
    }
    return result;
}

function disabled(value: string | undefined): boolean {
    return value === undefined || value === 'none';
}

export class ManagedLegacySshInspector {
    private readonly runner: ManagedSshCommandRunner;
    private readonly scan: (activeConfigPath: string) => { issues: string[] };
    private readonly timeoutMs: number;

    constructor(private readonly options: ManagedLegacySshInspectorOptions) {
        this.runner = options.runner || new NodeManagedSshCommandRunner();
        this.timeoutMs = options.timeoutMs || 10_000;
        this.scan = options.scan || (activeConfigPath => scanManagedSshConfigGraph(
            activeConfigPath,
            new NodeManagedSshConfigFileSystem(),
            { platform: options.platform },
        ));
    }

    async inspect(
        executable: string,
        activeConfigPath: string,
        target: string,
    ): Promise<ManagedLegacySshInspection> {
        if (target.length > 256
            || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(target)) {
            return {
                status: 'unsupported',
                reason: 'The legacy SSH target cannot be inspected safely.',
            };
        }
        let scan: { issues: string[] };
        try {
            scan = this.scan(activeConfigPath);
        } catch (_error) {
            return {
                status: 'unsupported',
                reason: 'The active SSH config could not be inspected safely.',
            };
        }
        if (scan.issues.length) {
            return {
                status: 'unsupported',
                reason: 'The active SSH config contains a dynamic, cyclic, unreadable, or unsupported Include/Match rule.',
            };
        }
        let result;
        try {
            result = await this.runner.run(
                executable,
                ['-F', activeConfigPath, '-G', target],
                this.timeoutMs,
            );
        } catch (_error) {
            return {
                status: 'needsInput',
                reason: 'OpenSSH could not inspect this alias; enter plain connection details.',
            };
        }
        if (result.exitCode !== 0) {
            return {
                status: 'needsInput',
                reason: 'OpenSSH could not resolve this alias; enter plain connection details.',
            };
        }
        const config = effectiveConfig(result.stdout);
        const host = config.get('hostname') || '';
        const user = config.get('user') || '';
        const port = Number(config.get('port'));
        const candidate = {
            id: 'legacy-inspection',
            name: 'Legacy inspection',
            connection: { kind: 'ssh' as const, host, user, port },
        };
        if (!isManagedMachine(candidate)) {
            return {
                status: 'needsInput',
                reason: 'OpenSSH did not produce a valid plain host, user, and port.',
            };
        }
        if (!disabled(config.get('proxyjump'))
            || !disabled(config.get('proxycommand'))
            || !disabled(config.get('remotecommand'))
            || config.get('permitlocalcommand') === 'yes'
            || config.has('localforward')
            || config.has('remoteforward')
            || config.has('dynamicforward')) {
            return {
                status: 'unsupported',
                reason: 'This alias depends on proxy, command, or forwarding behavior outside Managed Remote.',
            };
        }
        return {
            status: 'needsInput',
            reason: 'Plain connection details were detected. Review them before migration; authentication settings are not copied.',
            endpoint: { host, user, port },
        };
    }
}
