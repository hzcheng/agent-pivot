'use strict';

import { checksumManagedValue, createChecksummedLegacySnapshot } from './envelope';
import { ChecksummedLegacySnapshot } from './types';

export interface ManagedLegacyDivergence {
    divergenceId: string;
    changedSources: Array<'projectData' | 'projectSyncData'>;
    frozen: ChecksummedLegacySnapshot;
    current: ChecksummedLegacySnapshot;
}

/**
 * Detect edits made by an older extension after managed activation. The guard
 * reports complete branches for explicit import/keep decisions and never folds
 * them into the managed catalog automatically.
 */
export function detectManagedLegacyDivergence(
    frozen: ChecksummedLegacySnapshot,
    projectData: unknown,
    projectSyncData: unknown,
): ManagedLegacyDivergence | null {
    const current = createChecksummedLegacySnapshot(projectData, projectSyncData);
    if (current.checksum === frozen.checksum) {
        return null;
    }
    const changedSources: ManagedLegacyDivergence['changedSources'] = [];
    if (checksumManagedValue(projectData) !== checksumManagedValue(frozen.projectData)) {
        changedSources.push('projectData');
    }
    if (checksumManagedValue(projectSyncData) !== checksumManagedValue(frozen.projectSyncData)) {
        changedSources.push('projectSyncData');
    }
    return {
        divergenceId: `legacy-divergence:${current.checksum}`,
        changedSources,
        frozen,
        current,
    };
}
