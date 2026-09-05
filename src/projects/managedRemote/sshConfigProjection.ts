'use strict';

import { createHash } from 'crypto';

import { stableManagedValue } from './causal';
import { materializeManagedRemoteCatalog } from './merge';
import { ManagedRevisionSlot } from './types';

export interface ManagedSshProjectionEntry {
    machineId: string;
    alias: string;
    name: string;
    host: string;
    user: string;
    port: number;
}

export interface ManagedSshProjection {
    revisionId: string;
    connectionDigest: string;
    entries: ManagedSshProjectionEntry[];
    unavailableMachineIds: string[];
}

/**
 * An alias is used as an OpenSSH host name, including as the argument to
 * `ssh -G`. OpenSSH validates that with valid_domain(), which rejects any
 * byte outside [A-Za-z0-9._-], so the alias must stay ASCII no matter how
 * readable the Machine name is.
 */
const SAFE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u;

export function isManagedSshAlias(value: unknown): value is string {
    return typeof value === 'string' && SAFE_ALIAS.test(value);
}

function hash(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function readableAliasSegment(value: string): string {
    const normalized = (value || '')
        .normalize('NFKD')
        // Drop combining marks so accented Latin transliterates rather than
        // being replaced wholesale: "Café" -> "cafe", not "caf-".
        .replace(/\p{M}+/gu, '')
        .toLocaleLowerCase('en-US')
        .replace(/[^A-Za-z0-9.]+/gu, '-')
        .replace(/^[.-]+|[.-]+$/gu, '');
    return Array.from(normalized).slice(0, 54).join('').replace(/[.-]+$/gu, '');
}

export function managedSshAliasName(machineName: string, connectionHost: string = ''): string {
    // A fully non-ASCII name (for example a CJK name) leaves nothing readable
    // behind, so fall back to the connection host before the generic label.
    return readableAliasSegment(machineName)
        || readableAliasSegment(connectionHost)
        || 'machine';
}

/**
 * Stable suffix bound to the Machine identity. The readable segment alone
 * cannot address a Machine: renaming would silently invalidate the SSH
 * config entry, the remote authority, and every saved Project URI beneath
 * it, and two Machines sharing a display name would collapse onto one
 * alias.
 */
export function managedSshAliasSuffix(machineId: string): string {
    return hash(machineId).slice(0, 4);
}

export function managedSshAlias(
    machineId: string,
    machineName: string = 'machine',
    connectionHost: string = '',
): string {
    const readable = managedSshAliasName(machineName, connectionHost);
    const alias = `${readable}-${managedSshAliasSuffix(machineId)}`;
    if (!isManagedSshAlias(alias)) {
        throw new Error('Managed SSH alias generation failed.');
    }
    return alias;
}

/**
 * Whether `alias` was projected for this Machine.
 *
 * Recognition is anchored on the identity suffix rather than the readable
 * segment, so a renamed Machine still claims the alias already written to the
 * user's SSH config. The 4-hex suffix carries only 16 bits, so this is not a
 * unique key: callers must resolve a tie by requiring exactly one claimant.
 */
export function isManagedSshAliasForMachine(
    alias: string,
    machineId: string,
): boolean {
    if (!isManagedSshAlias(alias)) { return false; }
    const digest = hash(machineId);
    return alias.endsWith(`-${digest.slice(0, 4)}`)
        || alias.endsWith(`-${digest.slice(0, 8)}`)
        || alias === `agent-pivot-${digest.slice(0, 32)}`;
}

/**
 * Whether an alias plausibly addressed this Machine before Agent Pivot managed
 * it. Such an alias carries no Machine identity, so it can only be attributed
 * when exactly one Machine claims it.
 *
 * A Machine adopted from a hand-written `~/.ssh/config` keeps whatever Host
 * alias the user chose (`reddev`), which is neither the projected form nor
 * derivable from the Machine name. The endpoint is the only recorded evidence,
 * so the connection host and its first DNS label are accepted too.
 */
export function isLegacyNameOnlyAliasForMachine(
    alias: string,
    machineName: string = '',
    connectionHost: string = '',
): boolean {
    if (!isManagedSshAlias(alias)) { return false; }
    const candidates = new Set<string>([
        managedSshAliasName(machineName, connectionHost),
    ]);
    const host = readableAliasSegment(connectionHost);
    if (host) {
        candidates.add(host);
        // `reddev` for `reddev.xiaohongshu.com`: a short Host alias for a fully
        // qualified endpoint is the common hand-written shape.
        const label = host.split('.')[0];
        if (label) { candidates.add(label); }
    }
    const name = readableAliasSegment(machineName);
    if (name) { candidates.add(name); }
    return candidates.has(alias.toLocaleLowerCase('en-US'));
}

export function buildManagedSshProjection(slot: ManagedRevisionSlot): ManagedSshProjection {
    const view = materializeManagedRemoteCatalog(slot.document);
    const unavailable = new Set(view.conflicts
        .filter(conflict => conflict.entityType === 'machine')
        .map(conflict => conflict.entityId));
    const entries = view.machines
        .filter(machine => !unavailable.has(machine.id))
        .map(machine => ({
            machineId: machine.id,
            alias: managedSshAlias(machine.id, machine.name, machine.connection.host),
            name: machine.name,
            host: machine.connection.host,
            user: machine.connection.user,
            port: machine.connection.port,
        }))
        .sort((left, right) => left.machineId.localeCompare(right.machineId));
    if (new Set(entries.map(entry => entry.alias.toLocaleLowerCase('en-US'))).size
        !== entries.length) {
        throw new Error('Managed Machine names must produce unique SSH aliases.');
    }
    const connectionDigest = hash(stableManagedValue(entries.map(entry => ({
        machineId: entry.machineId,
        alias: entry.alias,
        host: entry.host,
        user: entry.user,
        port: entry.port,
    }))));
    return {
        revisionId: slot.revisionId,
        connectionDigest,
        entries,
        unavailableMachineIds: Array.from(unavailable).sort(),
    };
}

export function renderManagedSshConfig(projection: ManagedSshProjection): string {
    const lines = [
        '# Generated by Agent Pivot. Do not edit.',
        `# Connection digest: ${projection.connectionDigest}`,
    ];
    for (const entry of projection.entries) {
        lines.push(
            '',
            `Host ${entry.alias}`,
            `    HostName ${entry.host}`,
            `    User ${entry.user}`,
            `    Port ${entry.port}`,
            '    ProxyJump none',
            '    ProxyCommand none',
            '    PermitLocalCommand no',
            '    ForwardAgent no',
            '    ForwardX11 no',
            '    RemoteCommand none',
            '    ControlMaster no',
        );
    }
    return `${lines.join('\n')}\n`;
}

export function renderManagedSshIncludeBlock(generatedConfigPath: string): string {
    if (!generatedConfigPath
        || /[\r\n\0"]/u.test(generatedConfigPath)) {
        throw new Error('Managed SSH config path cannot be represented safely.');
    }
    const sshConfigPath = generatedConfigPath.replace(/\\/gu, '/');
    return [
        '# >>> Agent Pivot managed SSH hosts (do not edit)',
        `Include "${sshConfigPath}"`,
        '# <<< Agent Pivot managed SSH hosts',
    ].join('\n');
}
