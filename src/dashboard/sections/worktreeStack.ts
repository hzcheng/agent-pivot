'use strict';

import * as vscode from 'vscode';

import {
    GitWorktreeDiscovery,
    WorktreeBaseRefStore,
    WorktreeMemberLifecycle,
    WorktreeProvisioningStore,
    WorktreeSetupRunner,
    createWorktreeGroupManifestStore,
    normalizeWorktreeDirectory,
    worktreeGroupManifestReaderOf,
    worktreeGroupManifestWriterOf,
    worktreeKeysEqual,
} from '../../worktrees';
import type { WorktreeKey } from '../../worktrees';
import { getAgentPivotConfiguration } from '../../configuration';
import type { AiSessionRuntimeCoordinator } from '../../aiSessions/runtimeCoordinator';
import type { AiSessionRuntimeSnapshot } from '../../aiSessions/runtimeTypes';

/**
 * Composition section (MOD-DASHBOARD-SHELL): the worktree lifecycle stores,
 * discovery, and the runtime-priority helpers. Extracted from the
 * composition root; construction order is unchanged.
 */
export interface WorktreeStackDeps {
    context: vscode.ExtensionContext;
    getAiSessionRuntimeCoordinator: () => AiSessionRuntimeCoordinator<vscode.Terminal>;
}

export function createWorktreeStack(deps: WorktreeStackDeps) {
    const { context } = deps;

    const worktreeBaseRefStore = new WorktreeBaseRefStore(context.globalState);
    const worktreeProvisioningStore = new WorktreeProvisioningStore(
        context.globalState,
        () => normalizeWorktreeDirectory(
            getAgentPivotConfiguration().get<unknown>('worktreeDirectory', '.worktrees'))
    );
    const worktreeSetupRunner = new WorktreeSetupRunner();
    const worktreeGroupManifestStore = createWorktreeGroupManifestStore(context.globalState);
    const worktreeGroupManifestReader = worktreeGroupManifestReaderOf(worktreeGroupManifestStore);
    const worktreeGroupManifestWriter = worktreeGroupManifestWriterOf(worktreeGroupManifestStore);
    const worktreeMemberLifecycle = new WorktreeMemberLifecycle(worktreeGroupManifestStore);
    const gitWorktreeDiscovery = new GitWorktreeDiscovery({
        getBaseRef: repositoryKey => worktreeBaseRefStore.get(repositoryKey),
    });
    const getPriorityWorktreeKeys = (): WorktreeKey[] => [
        ...deps.getAiSessionRuntimeCoordinator().getActive(),
        ...deps.getAiSessionRuntimeCoordinator().getPending(),
    ].reduce((keys: WorktreeKey[], runtime: AiSessionRuntimeSnapshot<vscode.Terminal>) => {
        const key = runtime.identity.worktreeKey;
        if (key && !keys.some(candidate => worktreeKeysEqual(candidate, key))) {
            keys.push({ ...key });
        }
        return keys;
    }, []);
    const getWorktreePrioritySignature = (): string => JSON.stringify(
        getPriorityWorktreeKeys()
            .map(key => [key.repositoryKey, key.canonicalWorktreePath])
            .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
    );

    return {
        worktreeBaseRefStore,
        worktreeProvisioningStore,
        worktreeSetupRunner,
        worktreeGroupManifestStore,
        worktreeGroupManifestReader,
        worktreeGroupManifestWriter,
        worktreeMemberLifecycle,
        gitWorktreeDiscovery,
        getPriorityWorktreeKeys,
        getWorktreePrioritySignature,
    };
}
