'use strict';

import type { TmuxClient } from './tmuxClient';
import type {
    AiSessionRuntimeIdentity,
    AiSessionTmuxLayout,
    AiSessionTmuxLocator,
} from './runtimeTypes';
import { getAiSessionRuntimeIdentityVersion } from './runtimeTypes';

const SESSION_WINDOW = 'ai-session';

export function projectSessionMetadata(
    identity: AiSessionRuntimeIdentity
): Record<string, string> {
    return {
        managed: '1',
        version: '2',
        layout: 'project',
        workspaceScopeIdentity: identity.workspaceScopeIdentity,
    };
}

export function sessionWindowMetadata(): Record<string, string> {
    return { managed: '1', version: '2', layout: 'session' };
}

export function fullMetadata(
    identity: AiSessionRuntimeIdentity,
    layout: AiSessionTmuxLayout,
    createdAt: string,
    markerPath: string,
    version: 2 | 3 = getAiSessionRuntimeIdentityVersion(identity)
): Record<string, string> {
    return {
        managed: '1',
        version: String(version),
        layout,
        workspaceScopeIdentity: identity.workspaceScopeIdentity,
        workspaceNavigationIdentity: identity.workspaceNavigationIdentity,
        workspaceRootHostPaths: JSON.stringify(identity.workspaceRootHostPaths),
        ...(version === 3 ? {
            writableRootHostPaths: JSON.stringify(
                identity.writableRootHostPaths ?? identity.workspaceRootHostPaths
            ),
            ...(identity.worktreeKey ? { worktreeKey: JSON.stringify(identity.worktreeKey) } : {}),
        } : {}),
        cwd: identity.cwd,
        provider: identity.provider,
        ...(identity.sessionId ? { sessionId: identity.sessionId } : { pendingId: identity.pendingId as string }),
        createdAt,
        ...(markerPath ? { marker: markerPath } : {}),
    };
}

export async function writeFinalMetadata(
    client: TmuxClient,
    identity: AiSessionRuntimeIdentity,
    locator: AiSessionTmuxLocator,
    lifecycle: { createdAt: string; markerPath: string }
): Promise<void> {
    const full = fullMetadata(identity, locator.layout, lifecycle.createdAt, lifecycle.markerPath);
    if (locator.layout === 'project') {
        if (!locator.windowName) {
            throw new Error('A project tmux runtime requires a window name.');
        }
        await client.setSessionOptions(locator.sessionName,
            projectSessionMetadata(identity));
        await client.setWindowOptions(locator.sessionName, locator.windowName, full);
        return;
    }
    await client.setSessionOptions(locator.sessionName, full);
    await client.setWindowOptions(locator.sessionName,
        locator.windowName || SESSION_WINDOW,
        sessionWindowMetadata());
}

export async function writePendingMetadata(
    client: TmuxClient,
    identity: AiSessionRuntimeIdentity,
    locator: AiSessionTmuxLocator,
    createdAt: string,
    markerPath: string
): Promise<void> {
    return writeFinalMetadata(client, identity, locator, { createdAt, markerPath });
}

export async function verifyPendingMetadata(
    client: TmuxClient,
    identity: AiSessionRuntimeIdentity,
    locator: AiSessionTmuxLocator,
    createdAt: string,
    markerPath: string,
    version: 2 | 3 = getAiSessionRuntimeIdentityVersion(identity)
): Promise<void> {
    const sessionOptions = await client.getSessionOptions(locator.sessionName);
    const windowName = locator.layout === 'project'
        ? locator.windowName
        : locator.windowName || SESSION_WINDOW;
    if (!windowName) {
        throw new Error('The pending tmux metadata could not be verified.');
    }
    const windowOptions = await client.getWindowOptions(locator.sessionName, windowName);
    const expectedSession = locator.layout === 'project'
        ? projectSessionMetadata(identity)
        : fullMetadata(identity, locator.layout, createdAt, markerPath, version);
    const expectedWindow = locator.layout === 'project'
        ? fullMetadata(identity, locator.layout, createdAt, markerPath, version)
        : sessionWindowMetadata();
    if (!recordsEqual(sessionOptions, expectedSession) || !recordsEqual(windowOptions, expectedWindow)) {
        throw new Error('The pending tmux metadata could not be verified.');
    }
}

function recordsEqual(left: Record<string, string>, right: Record<string, string>): boolean {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length
        && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}
