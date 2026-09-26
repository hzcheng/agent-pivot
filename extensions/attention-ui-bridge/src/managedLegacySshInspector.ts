'use strict';

import {
    ManagedSshCommandRunner,
    NodeManagedSshCommandRunner,
} from './managedSshValidator';
import type { PortableSshHop } from '../../../src/projects/managedRemote/catalogService';
import { isManagedMachine } from '../../../src/projects/managedRemote/validation';

export interface ManagedLegacySshInspection {
    status: 'needsInput' | 'unsupported';
    reason: string;
    endpoint?: { host: string; user: string; port: number };
    /** Reference local configuration; never export its commands or credentials. */
    sshConfigAlias?: string;
    configurationMatched?: boolean;
    portable?: { jumpHosts: PortableSshHop[] };
    portableReason?: string;
    route?: { kind: 'direct' | 'jump' | 'command'; jumpHosts?: string };
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

    async inspect(executable: string, activeConfigPath: string, target: string): Promise<ManagedLegacySshInspection> {
        const inspected = await this.inspectOne(executable, activeConfigPath, target);
        if (!inspected.endpoint || inspected.status === 'unsupported') { return inspected; }
        const jumpHosts: PortableSshHop[] = [];
        const visiting = new Set<string>([target]);
        const endpoints = new Set<string>([`${inspected.endpoint.user}@${inspected.endpoint.host}:${inspected.endpoint.port}`]);
        const walk = async (result: ManagedLegacySshInspection): Promise<void> => {
            if (result.route?.kind === 'command') { throw new Error('This route uses a custom ProxyCommand that cannot be synced.'); }
            const hops = result.route?.kind === 'jump' ? (result.route.jumpHosts || '').split(',') : [];
            for (let index = 0; index < hops.length; index += 1) {
                const hop = hops[index];
                const match = /^(?:([A-Za-z0-9][A-Za-z0-9._-]*)@)?(\[[a-fA-F0-9:]+\]|[A-Za-z0-9][A-Za-z0-9._-]*)(?::([0-9]+))?$/u.exec(hop);
                if (!match) { throw new Error('This jump destination cannot be represented as a synced connection.'); }
                const alias = match[2].replace(/^\[|\]$/gu, '');
                if (visiting.has(alias) || visiting.size > 8 || jumpHosts.length >= 8) { throw new Error('The SSH route contains a cycle or exceeds eight hops.'); }
                visiting.add(alias);
                const resolved = await this.inspectOne(executable, activeConfigPath, alias, match[1], match[3]);
                if (!resolved.endpoint || resolved.status === 'unsupported') { throw new Error(`Cannot resolve jump host ${alias}. ${resolved.reason}`); }
                // An explicit multi-hop list overrides later hops' own ProxyJump.
                if (index === 0) { await walk(resolved); }
                else if (resolved.route?.kind === 'command') { throw new Error(`Jump host ${alias} uses a custom ProxyCommand.`); }
                const endpoint = resolved.endpoint;
                const identity = `${endpoint.user}@${endpoint.host}:${endpoint.port}`;
                if (endpoints.has(identity)) { throw new Error('The SSH route contains a repeated destination.'); }
                endpoints.add(identity);
                jumpHosts.push({ name: alias, ...endpoint });
                visiting.delete(alias);
            }
        };
        try { await walk(inspected); return { ...inspected, portable: { jumpHosts } }; }
        catch (error) { return { ...inspected, portableReason: error instanceof Error ? error.message : 'This connection requires local SSH configuration.' }; }
    }

    private async inspectOne(
        executable: string,
        activeConfigPath: string,
        target: string,
        userOverride?: string,
        portOverride?: string,
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
                ['-F', activeConfigPath, '-vv', '-G', ...(userOverride ? ['-l', userOverride] : []), ...(portOverride ? ['-p', portOverride] : []), target],
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
        // -G also succeeds for unknown aliases using defaults. Require evidence
        // that OpenSSH actually applied a non-global Host rule, including rules
        // from active Includes. Merely finding a Host line in a file is not enough.
        let checkingSpecificMatch = false;
        let configurationMatched = false;
        for (const line of result.stderr.split(/\r?\n/u)) {
            const host = /^debug1: .* line \d+: Applying options for (.+)$/u.exec(line);
            if (host?.[1].trim().split(/\s+/u).some(pattern => pattern !== '*' && !pattern.startsWith('!'))) {
                configurationMatched = true;
            }
            const match = /^debug2: checking match for '(.*)' host /u.exec(line);
            if (match) {
                const targetRules = /(?:^|\s)(?:host|originalhost)\s+(\S+)/giu;
                checkingSpecificMatch = false;
                let targetRule: RegExpExecArray | null;
                while ((targetRule = targetRules.exec(match[1])) !== null) {
                    if (targetRule[1].split(',').some(pattern => pattern !== '*' && !pattern.startsWith('!'))) {
                        checkingSpecificMatch = true;
                    }
                }
            } else if (/^debug2: match (?:found|not found)$/u.test(line)) {
                if (checkingSpecificMatch && line === 'debug2: match found') { configurationMatched = true; }
                checkingSpecificMatch = false;
            }
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
            reason: configurationMatched
                ? 'Uses this computer’s SSH configuration, including jump hosts and authentication. Configure the same alias on other computers.'
                : `SSH alias "${target}" has no active Host or target-specific Match configuration. Check the scope of Include directives in ${activeConfigPath}; use Add Machine for a direct hostname.`,
            configurationMatched,
            sshConfigAlias: target,
            route: !disabled(config.get('proxyjump'))
                ? { kind: 'jump', jumpHosts: config.get('proxyjump') }
                : !disabled(config.get('proxycommand')) ? { kind: 'command' } : { kind: 'direct' },
            endpoint: { host, user, port },
        };
    }
}
