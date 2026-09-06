'use strict';

export interface ManagedRemotePlatformUpdate {
    value: Record<string, string>;
    aliases: string[];
    changed: boolean;
}

function sameRecord(
    left: Record<string, string>,
    right: Record<string, string>,
): boolean {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key, index) =>
            key === rightKeys[index] && left[key] === right[key]);
}

export function managedRemoteLinuxPlatformUpdate(
    current: Record<string, string>,
    previousAliases: string[],
    requestedAliases: string[],
): ManagedRemotePlatformUpdate {
    const aliases = Array.from(new Set(requestedAliases)).sort();
    const value = { ...current };
    for (const alias of previousAliases) {
        if (!aliases.includes(alias) && value[alias] === 'linux') {
            delete value[alias];
        }
    }
    for (const alias of aliases) { value[alias] = 'linux'; }
    return {
        value,
        aliases,
        changed: !sameRecord(current, value),
    };
}
