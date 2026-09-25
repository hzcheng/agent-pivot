'use strict';

import { createHash } from 'crypto';

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

export function machineSshAlias(machine: import('./types').ManagedSshMachine): string {
    return machine.connection.sshConfigAlias
        || managedSshAlias(machine.id, machine.name, machine.connection.host);
}
