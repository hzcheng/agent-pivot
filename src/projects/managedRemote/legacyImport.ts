'use strict';

import { ManagedRemoteCatalogService } from './catalogService';
import { parseManagedDevContainerProjectUri } from './devContainerCodec';
import type { ManagedRemoteCatalogV1 } from './types';

export interface LegacyProjectRecord {
    name?: string;
    path?: string;
    description?: string;
    color?: string;
    favorite?: boolean;
}

export interface LegacyGroupRecord {
    groupName?: string;
    projects?: LegacyProjectRecord[];
}

export interface LegacySshEndpoint {
    host: string;
    user: string;
    port: number;
}

/**
 * Resolve an SSH host alias to a plain endpoint. Only the local extension host
 * can read the user's own SSH config, so this is supplied by the caller.
 */
export type LegacySshEndpointResolver =
    (alias: string) => Promise<LegacySshEndpoint | null>;

export interface LegacyImportSummary {
    machines: number;
    environments: number;
    projects: number;
    skipped: Array<{ name: string; reason: string }>;
}

export interface LegacyImportOutcome {
    document: ManagedRemoteCatalogV1;
    summary: LegacyImportSummary;
}

type Target =
    | { kind: 'local' }
    | { kind: 'unsupported' }
    | { kind: 'host'; alias: string; remotePath: string }
    | {
        kind: 'devContainer';
        alias: string;
        remotePath: string;
        anchor: NonNullable<ReturnType<typeof parseManagedDevContainerProjectUri>>['anchor'];
    };

/** Split a legacy project URI into the Machine, Environment and path it names. */
export function classifyLegacyProjectPath(rawPath: unknown): Target {
    if (typeof rawPath !== 'string' || !rawPath.startsWith('vscode-remote://')) {
        return { kind: 'local' };
    }
    const container = parseManagedDevContainerProjectUri(rawPath);
    if (container) {
        return {
            kind: 'devContainer',
            alias: container.outerSshAuthority,
            anchor: container.anchor,
            remotePath: container.remotePath,
        };
    }
    const remainder = rawPath.slice('vscode-remote://'.length);
    const slash = remainder.indexOf('/');
    let authority: string;
    try {
        authority = decodeURIComponent(slash < 0 ? remainder : remainder.slice(0, slash));
    } catch (_error) {
        return { kind: 'unsupported' };
    }
    if (!authority.startsWith('ssh-remote+')) { return { kind: 'unsupported' }; }
    let remotePath = '/';
    if (slash >= 0) {
        try {
            remotePath = decodeURIComponent(remainder.slice(slash));
        } catch (_error) {
            return { kind: 'unsupported' };
        }
    }
    return {
        kind: 'host',
        alias: authority.slice('ssh-remote+'.length),
        remotePath,
    };
}

/**
 * Convert the legacy Group[] store into a Managed Remote catalog document.
 *
 * Groups become tags, because the new model groups Projects by the Machine they
 * belong to and a flat group has no other place to go. Local Projects are left
 * behind: they are machine-local by design and the catalog synchronizes.
 */
export async function buildCatalogFromLegacyGroups(
    groups: readonly LegacyGroupRecord[],
    resolveEndpoint: LegacySshEndpointResolver,
    options: { actorId: string; createId: (prefix: string) => string },
): Promise<LegacyImportOutcome> {
    const service = ManagedRemoteCatalogService.create(options.actorId, options.createId);
    const skipped: Array<{ name: string; reason: string }> = [];
    const machineByAlias = new Map<string, { id: string }>();
    const containerByKey = new Map<string, { id: string }>();
    let projects = 0;
    let environments = 0;

    const aliases: string[] = [];
    for (const group of groups || []) {
        for (const project of group.projects || []) {
            const target = classifyLegacyProjectPath(project.path);
            if ((target.kind === 'host' || target.kind === 'devContainer')
                && !aliases.includes(target.alias)) {
                aliases.push(target.alias);
            }
        }
    }

    for (const alias of aliases) {
        const endpoint = await resolveEndpoint(alias);
        if (!endpoint || !endpoint.host || !endpoint.user) { continue; }
        const machine = service.addMachine({
            name: alias,
            host: endpoint.host,
            user: endpoint.user,
            port: endpoint.port || 22,
        });
        machineByAlias.set(alias, machine);
        environments += 1;
    }

    for (const group of groups || []) {
        const tag = String(group.groupName || '').trim();
        for (const project of group.projects || []) {
            const name = String(project.name || '').trim() || 'Project';
            const target = classifyLegacyProjectPath(project.path);
            if (target.kind === 'local' || target.kind === 'unsupported') {
                skipped.push({ name, reason: target.kind });
                continue;
            }
            const machine = machineByAlias.get(target.alias);
            if (!machine) {
                skipped.push({ name, reason: `unresolved-host:${target.alias}` });
                continue;
            }
            let environmentId: string;
            if (target.kind === 'host') {
                environmentId = `host:${machine.id}`;
            } else {
                const key = `${target.alias}\n${target.anchor.sourceLocator}`;
                let container = containerByKey.get(key);
                if (!container) {
                    container = service.addDevContainer(
                        machine.id, 'Dev Container', target.anchor,
                    );
                    containerByKey.set(key, container);
                    environments += 1;
                }
                environmentId = container.id;
            }
            service.addProject({
                environmentId,
                name,
                remotePath: target.remotePath,
                ...(project.description ? { description: project.description } : {}),
                ...(tag ? { tags: [tag] } : {}),
                ...(project.color ? { color: project.color } : {}),
                ...(project.favorite ? { favorite: true } : {}),
            });
            projects += 1;
        }
    }

    return {
        document: service.getDocument(),
        summary: {
            machines: machineByAlias.size,
            environments,
            projects,
            skipped,
        },
    };
}
