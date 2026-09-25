'use strict';

import {
    ManagedSshCommandRunner,
    NodeManagedSshCommandRunner,
} from './managedSshValidator';
import { isManagedMachine } from '../../../src/projects/managedRemote/validation';

export interface ManagedLegacySshInspection {
    status: 'needsInput' | 'unsupported';
    reason: string;
    endpoint?: { host: string; user: string; port: number };
    /** Reference local configuration; never export its commands or credentials. */
    sshConfigAlias?: string;
}

export interface ManagedLegacySshInspectorOptions {
    runner?: ManagedSshCommandRunner;
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
    private readonly timeoutMs: number;

    constructor(options: ManagedLegacySshInspectorOptions) {
        this.runner = options.runner || new NodeManagedSshCommandRunner();
        this.timeoutMs = options.timeoutMs || 10_000;
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
        // The alias remains local authority for authentication and routing. Export
        // only its name and endpoint, never ProxyCommand or IdentityFile contents.
        if (!disabled(config.get('remotecommand'))) {
            return { status: 'unsupported', reason: 'This alias runs a RemoteCommand. Use a folder-capable SSH alias.' };
        }
        return {
            status: 'needsInput',
            reason: 'Uses this computer’s SSH configuration, including jump hosts and authentication. Configure the same alias on other computers.',
            sshConfigAlias: target,
            endpoint: { host, user, port },
        };
    }
}
