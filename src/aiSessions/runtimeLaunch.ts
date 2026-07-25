'use strict';

import type { AiSessionLaunchSpec } from './launchSpec';
import type {
    AiSessionLazyRuntimeLaunch,
    AiSessionRuntimeLaunchInput,
} from './runtimeTypes';

export function createSingleUseLaunchSpecFactory(
    createLaunchSpec: () => AiSessionLaunchSpec
): () => AiSessionLaunchSpec {
    let used = false;
    return () => {
        if (used) {
            throw new Error('The AI session launch specification was already created.');
        }
        used = true;
        return cloneAiSessionLaunchSpec(createLaunchSpec());
    };
}

export function snapshotAiSessionRuntimeLaunch(
    request: AiSessionRuntimeLaunchInput
): AiSessionLazyRuntimeLaunch {
    const candidate = request as unknown as Record<string, unknown>;
    if (typeof candidate.createLaunchSpec === 'function') {
        if (typeof candidate.launchMarkerPath !== 'string') {
            throw new Error('The AI session runtime launch marker is invalid.');
        }
        return {
            launchMarkerPath: candidate.launchMarkerPath,
            createLaunchSpec: candidate.createLaunchSpec as () => AiSessionLaunchSpec,
        };
    }

    const launch = cloneAiSessionLaunchSpec(candidate.launch);
    const launchMarkerPath = candidate.launchMarkerPath === undefined
        ? launch.markerPath || ''
        : candidate.launchMarkerPath;
    if (typeof launchMarkerPath !== 'string') {
        throw new Error('The AI session runtime launch marker is invalid.');
    }
    return {
        launchMarkerPath,
        createLaunchSpec: () => cloneAiSessionLaunchSpec(launch),
    };
}

export function materializeAiSessionLaunchSpec(
    launch: AiSessionLazyRuntimeLaunch
): AiSessionLaunchSpec {
    const specification = cloneAiSessionLaunchSpec(launch.createLaunchSpec());
    if ((specification.markerPath || '') !== launch.launchMarkerPath) {
        throw new Error('The AI session runtime launch marker changed before dispatch.');
    }
    return specification;
}

export function cloneAiSessionLaunchSpec(value: unknown): AiSessionLaunchSpec {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('The AI session launch specification is invalid.');
    }
    const launch = value as Record<string, unknown>;
    const launchArgs = launch.args;
    if (typeof launch.executable !== 'string'
        || !Array.isArray(launchArgs)
        || (launch.cwd !== undefined && typeof launch.cwd !== 'string')
        || (launch.markerPath !== undefined && typeof launch.markerPath !== 'string')
        || (launch.windowsDirectShell !== undefined
            && launch.windowsDirectShell !== 'current'
            && launch.windowsDirectShell !== 'powershell')) {
        throw new Error('The AI session launch specification is invalid.');
    }
    const args: string[] = [];
    for (let index = 0; index < launchArgs.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(launchArgs, index)
            || typeof launchArgs[index] !== 'string') {
            throw new Error('The AI session launch specification is invalid.');
        }
        args.push(launchArgs[index] as string);
    }
    return {
        executable: launch.executable,
        args,
        ...(launch.cwd === undefined ? {} : { cwd: launch.cwd as string }),
        ...(launch.markerPath === undefined
            ? {}
            : { markerPath: launch.markerPath as string }),
        ...(launch.windowsDirectShell === undefined
            ? {}
            : { windowsDirectShell: launch.windowsDirectShell as 'current' | 'powershell' }),
    };
}
