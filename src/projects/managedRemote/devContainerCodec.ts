'use strict';

import { DevContainerLaunchAnchorV1 } from './types';

export interface ParsedManagedDevContainerProject {
    anchor: DevContainerLaunchAnchorV1;
    outerSshAuthority: string;
    remotePath: string;
}

function decodeAuthority(value: string): string | null {
    try {
        return decodeURIComponent(value);
    } catch (_error) {
        return null;
    }
}

function decodeHexObject(value: string): Record<string, unknown> | null {
    if (!value || value.length % 2 !== 0 || !/^[a-f0-9]+$/i.test(value)) {
        return null;
    }
    try {
        const decoded = JSON.parse(Buffer.from(value, 'hex').toString('utf8')) as unknown;
        return decoded && typeof decoded === 'object' && !Array.isArray(decoded)
            ? decoded as Record<string, unknown>
            : null;
    } catch (_error) {
        return null;
    }
}

function sourceFromPayload(payload: Record<string, unknown>): {
    sourceKind: DevContainerLaunchAnchorV1['sourceKind'];
    sourceLocator: string;
} | null {
    const configFile = payload.configFile;
    if (configFile && typeof configFile === 'object' && !Array.isArray(configFile)) {
        const configPath = (configFile as Record<string, unknown>).path;
        if (typeof configPath === 'string' && configPath) {
            return { sourceKind: 'config', sourceLocator: configPath };
        }
    }
    if (typeof payload.hostPath === 'string' && payload.hostPath) {
        return { sourceKind: 'workspace', sourceLocator: payload.hostPath };
    }
    return null;
}

/**
 * Decode only the current, observed Remote-SSH -> Dev Container authority.
 * Attached containers and unknown/private encodings fail closed.
 */
export function parseManagedDevContainerProjectUri(
    projectUri: string,
): ParsedManagedDevContainerProject | null {
    const prefix = 'vscode-remote://';
    if (typeof projectUri !== 'string' || !projectUri.startsWith(prefix)) {
        return null;
    }
    const remainder = projectUri.slice(prefix.length);
    const slash = remainder.indexOf('/');
    const encodedAuthority = slash < 0 ? remainder : remainder.slice(0, slash);
    const remotePath = slash < 0 ? '/' : remainder.slice(slash);
    const authority = decodeAuthority(encodedAuthority);
    if (!authority || !authority.startsWith('dev-container+')) {
        return null;
    }
    const nested = authority.slice('dev-container+'.length);
    const separator = nested.lastIndexOf('@ssh-remote+');
    if (separator <= 0) {
        return null;
    }
    const encodedPayload = nested.slice(0, separator);
    const outerSshAuthority = nested.slice(separator + '@ssh-remote+'.length);
    if (!outerSshAuthority || !/^[A-Za-z0-9._:-]+$/.test(outerSshAuthority)) {
        return null;
    }
    const payload = decodeHexObject(encodedPayload);
    const source = payload && sourceFromPayload(payload);
    if (!payload || !source) {
        return null;
    }
    return {
        anchor: {
            version: 1,
            originalAuthority: authority,
            sourceKind: source.sourceKind,
            sourceLocator: source.sourceLocator,
        },
        outerSshAuthority,
        remotePath: remotePath || '/',
    };
}

export function rebuildManagedDevContainerProjectUri(
    anchor: DevContainerLaunchAnchorV1,
    managedAlias: string,
    remotePath: string,
): string | null {
    if (!anchor
        || anchor.version !== 1
        || typeof anchor.originalAuthority !== 'string'
        || !anchor.originalAuthority.startsWith('dev-container+')
        || !/^[A-Za-z0-9._:-]+$/.test(managedAlias)
        || typeof remotePath !== 'string'
        || !remotePath.startsWith('/')) {
        return null;
    }
    const nested = anchor.originalAuthority.slice('dev-container+'.length);
    const separator = nested.lastIndexOf('@ssh-remote+');
    if (separator <= 0) {
        return null;
    }
    const encodedPayload = nested.slice(0, separator);
    if (!decodeHexObject(encodedPayload)) {
        return null;
    }
    const authority = `dev-container+${encodedPayload}@ssh-remote+${managedAlias}`;
    return `vscode-remote://${encodeURIComponent(authority)}${remotePath}`;
}
