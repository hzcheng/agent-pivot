'use strict';

import type { AiSessionRuntimeSnapshot } from '../aiSessions/runtimeTypes';
import {
    getWorkspaceHostPathComparisonKey,
} from '../sessionAssignment';
import type { OpenWorkspace } from './types';

export function hasWorkspaceRuntimeContinuity(
    workspace: Pick<OpenWorkspace, 'scopeIdentity' | 'navigationIdentity' | 'roots'>,
    runtime: Pick<AiSessionRuntimeSnapshot, 'identity'>
): boolean {
    const identity = runtime?.identity;
    if (!workspace || !identity) {
        return false;
    }
    if (identity.workspaceScopeIdentity === workspace.scopeIdentity
        || identity.workspaceNavigationIdentity === workspace.navigationIdentity) {
        return true;
    }
    const currentRoots = new Set((workspace.roots || [])
        .map(root => getWorkspaceHostPathComparisonKey(root.hostPath))
        .filter(Boolean));
    return (identity.workspaceRootHostPaths || [])
        .some(root => currentRoots.has(getWorkspaceHostPathComparisonKey(root)));
}
