'use strict';

import type { ProjectConnectionProfile } from './projectClientProtocol';

export type HostLaunchPlan = {
    kind: 'setup';
    reason: 'missing-profile';
} | {
    kind: 'open';
    connectionKind: ProjectConnectionProfile['kind'];
    resolverAuthority: string | null;
};

export function planHostLaunch(
    profile: ProjectConnectionProfile | null,
): HostLaunchPlan {
    if (!profile) {
        return { kind: 'setup', reason: 'missing-profile' };
    }
    return {
        kind: 'open',
        connectionKind: profile.kind,
        resolverAuthority: profile.resolverAuthority,
    };
}
