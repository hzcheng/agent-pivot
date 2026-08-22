'use strict';

import { randomBytes } from 'crypto';
import { statSync } from 'fs';
import type * as vscode from 'vscode';
import { isAiSessionProviderId } from '../models';
import type { AiSessionProviderId } from '../models';
import type { OpenWorkspace } from '../workspaces/types';
import type { WorktreeSnapshot } from '../worktrees';
import type { WorkspacePrimaryRootStore } from '../workspaces/primaryRootStore';
import type { ActiveAiSessionTerminalIdentity } from './activeTerminalHighlight';
import type AiSessionAliasController from './aliasController';
import { AiSessionArchiveController } from './archiveController';
import type { AiSessionArchiveControllerOptions } from './archiveController';
import { AiSessionCommandController } from './commandController';
import type { AiSessionCommandControllerOptions } from './commandController';
import { AiSessionCreationController } from './creationController';
import type { AiSessionCreationControllerOptions } from './creationController';
import { buildCodexProfilePicks } from './codexProfiles';
import { readAiSessionLaunchOptions } from './launchOptions';
import { getAiSessionIdsForCwd } from './pendingTerminals';
import type AiSessionPinController from './pinController';
import type AiSessionProfileController from './sessionProfileController';
import { resolveDefaultCodexProfileDecision } from './sessionProfileController';
import {
    resolveAiSessionWorktreeCreationTarget,
} from './worktreeCreationTarget';
import type { AiSessionCreationScopeTarget } from './worktreeCreationTarget';
import type { WorktreeKey } from '../worktrees';
import type { RetiredWorktreeIdentity } from '../worktrees';
import { findLatestRetirementForKey } from '../worktrees';
import type { ProviderDirectoryCapabilityProbe } from './providerDirectoryCapability';
import { buildAiSessionProviderPicks, getAiSessionProviderLabel } from './providers';
import type { AiSessionReadCoordinator } from './readCoordinator';
import { AiSessionResumeController } from './resumeController';
import type { AiSessionResumeControllerOptions } from './resumeController';
import type { AiSessionRuntimeCoordinator } from './runtimeCoordinator';
import type { AiSessionRuntimeSnapshot } from './runtimeTypes';
import { getAiSessionTerminalName as getProviderAiSessionTerminalName } from './sessionPaths';
import { AiSessionTerminalCommandController } from './terminalCommandController';
import type { AiSessionTerminalCommandControllerOptions } from './terminalCommandController';
import type AiSessionTerminalService from './terminalService';
import type {
    AiSessionBatchArchiveCompletedMessage,
    AiSessionProvider,
    SessionProfileDecision,
    WorkspaceAiSessionActionTarget,
} from './types';
import type AiSessionWorkspaceStateStore from './workspaceStateStore';

export interface SessionControllerCompositionOptions {
    getCurrentWorkspaceActionTarget: (cardId: string) => WorkspaceAiSessionActionTarget | null;
    getCurrentOpenWorkspace: () => OpenWorkspace | null;
    getWorktreeSnapshot: () => WorktreeSnapshot | null;
    /** Authoritative manifest lookup for group session scoping (PRD §5.5). */
    getWorktreeGroupPeerKeys?: (
        workspaceNavigationIdentity: string,
        key: WorktreeKey
    ) => readonly WorktreeKey[] | null;
    /** Fail-closed guard while any group member is still provisioning. */
    isWorktreeGroupProvisioning?: (
        workspaceNavigationIdentity: string,
        key: WorktreeKey
    ) => boolean;
    /** Retired identities for generation-claim creation (PRD §6.4). */
    getRetiredWorktreeIdentities?: (
        workspaceNavigationIdentity: string
    ) => readonly RetiredWorktreeIdentity[];
    /** Quarantine signal for the retired store (PRD §6.4). */
    isWorktreeRetiredStoreCorrupt?: (
        workspaceNavigationIdentity: string
    ) => boolean;
    /** Persists a pending generation claim (PRD §6.4). */
    createWorktreeGenerationClaim?: (
        workspaceNavigationIdentity: string,
        input: {
            pendingId: string;
            worktreeKey: WorktreeKey;
            createdAfterRetirementId: string;
            createdAtMs: number;
            creatingProvider?: string;
            launchMarkerPath?: string;
        }
    ) => Promise<{ claimId: string }>;
    /** Compensating delete for a pending generation claim (PRD §6.4). */
    removeWorktreeGenerationClaim?: (
        workspaceNavigationIdentity: string,
        claimId: string
    ) => Promise<boolean>;
    /**
     * Shared deletion admission (PRD §6.4 decision J): runs the given
     * admission-phase operation under the per-group mutex and throws
     * group-leased when the group is being deleted. Applies to EVERY
     * worktree session creation.
     */
    withWorktreeDeletionAdmission?: <T>(
        scope: {
            workspaceNavigationIdentity: string;
            worktreeKey: WorktreeKey;
        },
        operation: () => Promise<T>
    ) => Promise<T>;
    getActiveEditorUri: () => vscode.Uri | undefined;
    isWorkspaceTrusted: () => boolean;
    getRegisteredAiSessionProvider: (providerId: AiSessionProviderId) => AiSessionProvider;
    getRegisteredAiSessionProviders: () => AiSessionProvider[];
    providerDirectoryCapability: ProviderDirectoryCapabilityProbe;
    workspacePrimaryRootStore: WorkspacePrimaryRootStore;
    aiSessionWorkspaceStateStore: AiSessionWorkspaceStateStore;
    aiSessionPinController: AiSessionPinController;
    aiSessionAliasController: AiSessionAliasController;
    aiSessionReadCoordinator: AiSessionReadCoordinator;
    aiSessionRuntimeCoordinator: AiSessionRuntimeCoordinator<vscode.Terminal>;
    aiSessionTerminalService: AiSessionTerminalService;
    aiSessionProviders: AiSessionProvider[];
    getAiSessionRuntimeById: (
        providerId: AiSessionProviderId,
        sessionId: string
    ) => AiSessionRuntimeSnapshot<vscode.Terminal> | null;
    getAiSessionRuntimeCollision: (
        providerId: AiSessionProviderId,
        sessionId: string,
        workspaceScopeIdentity: string
    ) => AiSessionRuntimeSnapshot<vscode.Terminal> | null;
    getAiSessionPinKey: (providerId: AiSessionProviderId, sessionId: string) => string;
    /** Late-bound: the settlement capability is constructed after the controllers. */
    runSafeLifecycleTask: (
        operation: string,
        task: () => unknown | Promise<unknown>
    ) => Promise<void>;
    /** Late-bound: the attention acknowledgement is constructed after the controllers. */
    acknowledgeAttention: (identity: ActiveAiSessionTerminalIdentity) => Promise<void>;
    /** Late-bound: the highlighter is constructed after the controllers. */
    syncActiveRuntime: () => void;
    getLaunchOptions: () => ReturnType<typeof readAiSessionLaunchOptions>;
    /** Codex profile support hooks; optional so tests can omit them. */
    aiSessionProfileController?: AiSessionProfileController;
    /** Reads agentPivot.codexDefaultProfile (new sessions only). */
    getCodexDefaultProfile?: () => string | undefined;
    /** Probes whether the installed Codex CLI supports `-p/--profile`. */
    getCodexProfileSupport?: () => Promise<boolean>;
    /** Lists discovered `<name>.config.toml` profile names. */
    listCodexProfiles?: () => string[];
    /** Reports whether `<name>.config.toml` still exists. */
    isCodexProfileFileAvailable?: (name: string) => boolean;
    openSettings?: (query: string) => Thenable<unknown>;
    postMessage: (message: unknown) => Thenable<unknown>;
    appendOutput: (message: string) => void;
    postBatchArchiveCompletion: (message: AiSessionBatchArchiveCompletedMessage) => void;
    logError: (message: string, error: unknown) => void;
    logAiSessionRuntimeFailure: (operation: string, error: unknown, backend?: 'vscode' | 'tmux') => void;
    refreshAiSessionViewsIncrementally: () => void;
    scheduleNewAiSessionRefresh: (providerId: AiSessionProviderId) => void;
    nowMs: () => number;
    showInputBox: (options: vscode.InputBoxOptions) => Thenable<string | undefined>;
    showQuickPick: <T extends vscode.QuickPickItem>(
        items: T[],
        options: vscode.QuickPickOptions
    ) => Thenable<T | undefined>;
    showWarningMessage: (message: string) => Thenable<string | undefined>;
    showWarningWithItems: (message: string, ...items: string[]) => Thenable<string | undefined>;
    showModalWarning: (message: string, action: string) => Thenable<string | undefined>;
    showInformationMessage: (message: string) => Thenable<string | undefined>;
    showErrorMessage: (message: string) => Thenable<string | undefined>;
    writeClipboard: (value: string) => Thenable<void>;
    focusTerminalView: () => Thenable<unknown>;
}

export interface SessionControllerComposition {
    aiSessionCommandController: AiSessionCommandController;
    aiSessionCreationController: AiSessionCreationController;
    aiSessionArchiveController: AiSessionArchiveController<AiSessionRuntimeSnapshot<vscode.Terminal>>;
    aiSessionTerminalCommandController: AiSessionTerminalCommandController<vscode.Terminal>;
    aiSessionResumeController: AiSessionResumeController<vscode.Terminal>;
}

/**
 * Owns the construction wiring of the five session action controllers:
 * command, creation, archive, terminal command, and resume, including the
 * workspace-root and provider quick picks shared by their options.
 *
 * Extracted from `initializeDashboard` in src/dashboard.ts. Behaviour is
 * unchanged: the option literals are the same; only their ownership moved.
 */
interface SessionControllerCompositionFactories {
    createCommandController(options: AiSessionCommandControllerOptions): AiSessionCommandController;
    createCreationController(options: AiSessionCreationControllerOptions): AiSessionCreationController;
    createArchiveController(
        options: AiSessionArchiveControllerOptions<AiSessionRuntimeSnapshot<vscode.Terminal>>
    ): AiSessionArchiveController<AiSessionRuntimeSnapshot<vscode.Terminal>>;
    createTerminalCommandController(
        options: AiSessionTerminalCommandControllerOptions<vscode.Terminal>
    ): AiSessionTerminalCommandController<vscode.Terminal>;
    createResumeController(
        options: AiSessionResumeControllerOptions<vscode.Terminal>
    ): AiSessionResumeController<vscode.Terminal>;
}

const DEFAULT_FACTORIES: SessionControllerCompositionFactories = {
    createCommandController: options => new AiSessionCommandController(options),
    createCreationController: options => new AiSessionCreationController(options),
    createArchiveController: options => new AiSessionArchiveController(options),
    createTerminalCommandController: options => new AiSessionTerminalCommandController(options),
    createResumeController: options => new AiSessionResumeController(options),
};

export function createSessionControllerComposition(
    options: SessionControllerCompositionOptions,
    internalFactories: Partial<SessionControllerCompositionFactories> = {}
): SessionControllerComposition {
    const factories = { ...DEFAULT_FACTORIES, ...internalFactories };
    const getCurrentWorkspaceActionTarget = options.getCurrentWorkspaceActionTarget;
    const getCurrentOpenWorkspace = options.getCurrentOpenWorkspace;
    const getRegisteredAiSessionProvider = options.getRegisteredAiSessionProvider;
    const getRegisteredAiSessionProviders = options.getRegisteredAiSessionProviders;
    const providerDirectoryCapability = options.providerDirectoryCapability;
    const workspacePrimaryRootStore = options.workspacePrimaryRootStore;
    const aiSessionWorkspaceStateStore = options.aiSessionWorkspaceStateStore;
    const aiSessionPinController = options.aiSessionPinController;
    const aiSessionAliasController = options.aiSessionAliasController;
    const aiSessionReadCoordinator = options.aiSessionReadCoordinator;
    const aiSessionRuntimeCoordinator = options.aiSessionRuntimeCoordinator;
    const aiSessionTerminalService = options.aiSessionTerminalService;
    const aiSessionProviders = options.aiSessionProviders;
    const getAiSessionRuntimeById = options.getAiSessionRuntimeById;
    const getAiSessionRuntimeCollision = options.getAiSessionRuntimeCollision;
    const getAiSessionPinKey = options.getAiSessionPinKey;
    const runSafeAiSessionRuntimeLifecycleTask = options.runSafeLifecycleTask;
    const acknowledgeAiSessionAttention = options.acknowledgeAttention;
    const getLaunchOptions = options.getLaunchOptions;
    const postMessage = options.postMessage;
    const appendOutput = options.appendOutput;
    const postBatchArchiveCompletion = options.postBatchArchiveCompletion;
    const logError = options.logError;
    const logAiSessionRuntimeFailure = options.logAiSessionRuntimeFailure;
    const refreshAiSessionViewsIncrementally = options.refreshAiSessionViewsIncrementally;
    const scheduleNewAiSessionRefresh = options.scheduleNewAiSessionRefresh;
    const nowMs = options.nowMs;
    const showInputBox = options.showInputBox;
    const showQuickPick = options.showQuickPick;
    const showWarningMessage = options.showWarningMessage;
    const showWarningWithItems = options.showWarningWithItems;
    const showModalWarning = options.showModalWarning;
    const showInformationMessage = options.showInformationMessage;
    const showErrorMessage = options.showErrorMessage;
    const writeClipboard = options.writeClipboard;
    const focusTerminalView = options.focusTerminalView;

    const pickAiSessionWorkspaceRoot = async (
        workspace: OpenWorkspace,
        action: 'create' | 'resume'
    ): Promise<string | undefined> => {
        const selected = await showQuickPick(
            workspace.roots.map(root => ({
                label: root.name,
                description: root.hostPath,
                rootId: root.id,
            })),
            {
                placeHolder: 'Select a workspace root',
                ignoreFocusOut: true,
                title: action === 'resume'
                    ? 'Resume AI Session in Workspace Root'
                    : 'New AI Session Working Directory',
            } as vscode.QuickPickOptions & { title: string }
        );
        return selected?.rootId;
    };
    const selectAiSessionCreationScopeTarget = async (
        workspace: OpenWorkspace,
        explicitWorktreeKey?: WorktreeKey
    ): Promise<AiSessionCreationScopeTarget | null> => {
        const resolution = resolveAiSessionWorktreeCreationTarget({
            workspace,
            snapshot: options.getWorktreeSnapshot(),
            activeEditorPath: options.getActiveEditorUri()?.fsPath,
            explicitKey: explicitWorktreeKey,
        });
        if (resolution.status === 'workspace') {
            return { kind: 'workspace' };
        }
        if (resolution.status === 'selected') {
            return { kind: 'worktree', key: resolution.key };
        }
        if (resolution.status === 'blocked') {
            await showWarningMessage(
                resolution.reason === 'snapshot-unavailable'
                    ? 'Worktree discovery is not ready yet. Refresh the dashboard and try again.'
                    : resolution.reason === 'no-linked-worktrees'
                        ? 'No linked worktree is available for a new AI session.'
                        : 'The selected worktree is no longer available. Refresh the dashboard and try again.'
            );
            return null;
        }
        const selected = await showQuickPick(
            resolution.candidates.map(candidate => ({
                label: candidate.label,
                description: candidate.description,
                worktreeKey: candidate.key,
            })),
            {
                placeHolder: 'Select the worktree where the AI session will run',
                ignoreFocusOut: true,
                title: 'New AI Session Worktree',
            } as vscode.QuickPickOptions & { title: string }
        );
        return selected
            ? { kind: 'worktree', key: { ...selected.worktreeKey } }
            : null;
    };
    const pickAiSessionProvider = async (): Promise<AiSessionProviderId | undefined> => {
        const quickPickOptions: vscode.QuickPickOptions = {
            placeHolder: 'Select an AI provider',
            ignoreFocusOut: true,
        };
        (quickPickOptions as vscode.QuickPickOptions & { title?: string }).title = 'Select an AI provider';
        const selected = await showQuickPick(
            buildAiSessionProviderPicks(getRegisteredAiSessionProviders()),
            quickPickOptions
        );
        return selected?.providerId;
    };
    let warnedUnsupportedCodexProfileCli = false;
    let warnedMissingDefaultProfileFile = false;
    const pickCodexProfile = async (): Promise<'base' | string | undefined> => {
        const defaultFromSetting = options.getCodexDefaultProfile?.() || undefined;
        const supported = await (options.getCodexProfileSupport?.() ?? Promise.resolve(false));
        const profiles = supported ? (options.listCodexProfiles?.() || []) : [];
        if (!supported) {
            if ((defaultFromSetting || (options.listCodexProfiles?.() || []).length > 0)
                && !warnedUnsupportedCodexProfileCli) {
                warnedUnsupportedCodexProfileCli = true;
                void showInformationMessage(
                    'The installed Codex CLI does not support configuration profiles '
                    + '(-p/--profile). Upgrade the Codex CLI to select a profile; new '
                    + 'sessions will use the base configuration.'
                );
            }
            return 'base';
        }
        if (defaultFromSetting
            && !profiles.includes(defaultFromSetting)
            && !warnedMissingDefaultProfileFile) {
            warnedMissingDefaultProfileFile = true;
            void showWarningMessage(
                `agentPivot.codexDefaultProfile points to '${defaultFromSetting}', but `
                + `${defaultFromSetting}.config.toml was not found in the Codex home. New `
                + 'sessions will use the base configuration until the file exists.'
            );
        }
        if (!profiles.length) {
            return 'base';
        }
        const quickPickOptions: vscode.QuickPickOptions = {
            placeHolder: 'Select a Codex profile',
            ignoreFocusOut: true,
        };
        (quickPickOptions as vscode.QuickPickOptions & { title?: string }).title = 'Select a Codex profile';
        const selected = await showQuickPick(
            buildCodexProfilePicks({
                profiles,
                lastUsed: options.aiSessionProfileController?.getLastUsed() || null,
                defaultFromSetting,
            }),
            quickPickOptions
        );
        if (!selected) {
            return undefined;
        }
        return selected.decision.kind === 'profile' ? selected.decision.name : 'base';
    };
    const resolveResumeProfileDecision = async (
        providerId: AiSessionProviderId,
        sessionId: string
    ): Promise<SessionProfileDecision | 'cancel' | undefined> => {
        const decision = options.aiSessionProfileController?.getDecision(providerId, sessionId);
        if (!decision || decision.kind !== 'profile') {
            return decision;
        }
        if (options.isCodexProfileFileAvailable?.(decision.name)) {
            return decision;
        }
        const useBaseAction = 'Use Base Configuration';
        const openSettingsAction = 'Open Settings';
        const choice = await showWarningWithItems(
            `Codex profile '${decision.name}' is unavailable: ${decision.name}.config.toml `
            + 'no longer exists in the Codex home. Agent Pivot stores the profile name, '
            + 'not a configuration snapshot.',
            useBaseAction,
            openSettingsAction
        );
        if (choice === useBaseAction) {
            return { kind: 'base' };
        }
        if (choice === openSettingsAction) {
            await options.openSettings?.('agentPivot.codexDefaultProfile');
        }
        return 'cancel';
    };
    const aiSessionCommandController = factories.createCommandController({
        getWorkspaceTarget: getCurrentWorkspaceActionTarget,
        getOpenWorkspace: getCurrentOpenWorkspace,
        getWorktreeSnapshot: options.getWorktreeSnapshot,
        getWorktreeGroupPeerKeys: options.getWorktreeGroupPeerKeys,
        isWorktreeGroupProvisioning: options.isWorktreeGroupProvisioning,
        getActiveEditorUri: options.getActiveEditorUri,
        isWorkspaceTrusted: options.isWorkspaceTrusted,
        getProvider: getRegisteredAiSessionProvider,
        getProviderDirectoryCapability: providerDefinition =>
            providerDirectoryCapability.probe(providerDefinition),
        getPrimaryRootId: workspace => workspacePrimaryRootStore.getPrimaryRootId(
            workspace.scopeIdentity,
            workspace.roots
        ),
        setPrimaryRootId: (scopeIdentity, rootId) =>
            workspacePrimaryRootStore.setPrimaryRootId(scopeIdentity, rootId),
        pickWorkspaceRoot: pickAiSessionWorkspaceRoot,
        isDirectory: hostPath => {
            try {
                return statSync(hostPath).isDirectory();
            } catch (error) {
                return false;
            }
        },
        showWarningMessage: message => showWarningMessage(message),
        isProviderId: isAiSessionProviderId,
        setExpanded: (workspaceScopeIdentity, expanded) => aiSessionWorkspaceStateStore.setExpanded(workspaceScopeIdentity, expanded),
        setWindowViewTab: (workspaceScopeIdentity, tab) =>
            aiSessionWorkspaceStateStore.setWindowViewTab(workspaceScopeIdentity, tab),
        setChatsViewMode: (workspaceScopeIdentity, viewMode) =>
            aiSessionWorkspaceStateStore.setChatsViewMode(workspaceScopeIdentity, viewMode),
        setCollapsedWorktreeGroups: (workspaceScopeIdentity, collapsedKeys) =>
            aiSessionWorkspaceStateStore.setCollapsedWorktreeGroups(workspaceScopeIdentity, collapsedKeys),
        importLegacyWindowViewTab: (workspaceScopeIdentity, tab) =>
            aiSessionWorkspaceStateStore.importLegacyWindowViewTab(workspaceScopeIdentity, tab),
        setProviderSelection: (workspaceScopeIdentity, selection) =>
            aiSessionWorkspaceStateStore.setProviderSelection(workspaceScopeIdentity, selection),
        postProviderSelectionResult: result => postMessage(result),
        showErrorMessage: message => showErrorMessage(message),
        logError,
        togglePin: (providerId, sessionId) => aiSessionPinController.toggle(providerId, sessionId),
        getAliases: () => aiSessionAliasController.getAll(),
        saveAliases: aliases => aiSessionAliasController.saveAll(aliases),
        getOriginalName: (providerId, sessionId) => aiSessionAliasController.getOriginalName(providerId, sessionId),
        getSessionKey: getAiSessionPinKey,
        showInputBox: options => showInputBox(options),
        writeClipboard: value => writeClipboard(value),
        showInformationMessage: message => showInformationMessage(message),
        refresh: refreshAiSessionViewsIncrementally,
    });
    const aiSessionCreationController = factories.createCreationController({
        isProviderId: isAiSessionProviderId,
        getWorkspaceTarget: getCurrentWorkspaceActionTarget,
        pickWorkspaceRoot: workspace => pickAiSessionWorkspaceRoot(workspace, 'create'),
        selectCreationScopeTarget: selectAiSessionCreationScopeTarget,
        pickProvider: pickAiSessionProvider,
        pickCodexProfile,
        rememberSessionProfile: (pendingId, decision) => {
            options.aiSessionProfileController?.recordPending(pendingId, decision);
            options.aiSessionProfileController?.rememberLastUsed(decision);
        },
        rememberSessionProvider: async (workspaceScopeIdentity, providerId) => {
            try {
                await aiSessionWorkspaceStateStore.setQuickCreateProvider(workspaceScopeIdentity, providerId);
            } catch (error) {
                logError("Failed to remember the AI session provider.", error);
            }
        },
        getDefaultCodexProfileDecision: () => resolveDefaultCodexProfileDecision({
            getLastUsed: () => options.aiSessionProfileController?.getLastUsed() ?? null,
            getCodexDefaultProfile: options.getCodexDefaultProfile,
            isCodexProfileFileAvailable: options.isCodexProfileFileAvailable,
        }),
        getProviderLabel: getAiSessionProviderLabel,
        getLaunchOptions,
        getProvider: getRegisteredAiSessionProvider,
        resolveWorkspaceDirectoryScope: (target, providerId, explicitRootId, worktreeKey) =>
            aiSessionCommandController.resolveWorkspaceDirectoryScope(
                target.workspace, providerId, undefined, explicitRootId, worktreeKey
            ),
        rememberDirectoryScope: async directoryScope => {
            try {
                await aiSessionCommandController.rememberDirectoryScope(directoryScope);
            } catch (error) {
                logError('Could not save the AI session workspace root.', error);
            }
        },
        runtimeCoordinator: aiSessionRuntimeCoordinator,
        createPendingId: () => randomBytes(16).toString('hex'),
        showInputBox: options => showInputBox(options),
        showActiveTab: projectId => postMessage({
            type: 'ai-session-tab-selection-requested',
            projectId,
            tab: 'chats',
        }),
        showWarningMessage: (message, ...items) => showWarningWithItems(message, ...items),
        showErrorMessage: message => showErrorMessage(message),
        logRuntimeFailure: logAiSessionRuntimeFailure,
        refresh: refreshAiSessionViewsIncrementally,
        getExistingSessionIdsForCwd: (providerId, cwd) => getAiSessionIdsForCwd(providerId, aiSessionReadCoordinator.getProviderResult(providerId, {
            forceRefresh: true,
            candidatePaths: [cwd],
            reason: 'new-session',
        }), cwd, aiSessionProviders),
        getPendingMarkerPath: providerId => aiSessionTerminalService.getPendingMarkerPath(providerId),
        scheduleNewSessionRefresh: scheduleNewAiSessionRefresh,
        announceStatus: (projectId, message) => postMessage({
            type: 'ai-session-status-announcement',
            projectId,
            message,
        }),
        prepareGenerationClaim: async ({
            navigationIdentity, worktreeKey, pendingId, provider, launchMarkerPath,
        }) => {
            if (!options.getRetiredWorktreeIdentities
                || !options.createWorktreeGenerationClaim) {
                return null;
            }
            if (options.isWorktreeRetiredStoreCorrupt?.(navigationIdentity)) {
                // A quarantined retired store cannot prove whether this path
                // was retired: refuse the creation rather than starting a
                // session without its generation claim (PRD §6.4).
                throw new Error('The retired-worktree store is quarantined.');
            }
            const retirement = findLatestRetirementForKey(
                options.getRetiredWorktreeIdentities(navigationIdentity),
                worktreeKey);
            if (!retirement) {
                return null;
            }
            const claim = await options.createWorktreeGenerationClaim(navigationIdentity, {
                pendingId,
                worktreeKey: { ...worktreeKey },
                createdAfterRetirementId: retirement.retirementId,
                createdAtMs: nowMs(),
                creatingProvider: provider,
                launchMarkerPath,
            });
            return claim.claimId;
        },
        // Every worktree session creation — not only retired-path ones —
        // enters the shared deletion admission mutex, so a session can
        // never slip between a deletion's blocker scan and its journal
        // write (PRD §6.4 decision J).
        ...(options.withWorktreeDeletionAdmission
            ? { withWorktreeDeletionAdmission: options.withWorktreeDeletionAdmission }
            : {}),
        discardGenerationClaim: async ({ navigationIdentity, claimId }) => {
            await options.removeWorktreeGenerationClaim?.(navigationIdentity, claimId);
        },
        nowMs,
    });
    const aiSessionArchiveController = factories.createArchiveController({
        isProviderId: isAiSessionProviderId,
        getProvider: getRegisteredAiSessionProvider,
        getProviderLabel: getAiSessionProviderLabel,
        getWorkspaceTarget: getCurrentWorkspaceActionTarget,
        getRuntimeById: getAiSessionRuntimeById,
        refreshRuntimeGuard: () => aiSessionRuntimeCoordinator.refreshForHost(true),
        isRuntimeComplete: runtime => runtime.state === 'completed',
        focusRuntime: runtime => aiSessionRuntimeCoordinator.focus({ ...runtime.identity }),
        deleteRuntimeMarker: runtime => aiSessionTerminalService.deleteMarker(runtime.markerPath),
        untrackRuntime: (providerId, sessionId, workspaceScopeIdentity) =>
            aiSessionTerminalService.untrack(providerId, sessionId, workspaceScopeIdentity),
        deletePin: (providerId, sessionId) => aiSessionPinController.remove(providerId, sessionId),
        deleteAlias: (providerId, sessionId) => aiSessionAliasController.remove(providerId, sessionId),
        confirmSingleArchive: providerLabel => showModalWarning(`Archive this ${providerLabel} session?`, "Archive"),
        confirmBatchArchive: message => showModalWarning(message, 'Archive'),
        showWarningMessage: message => showWarningMessage(message),
        showErrorMessage: message => showErrorMessage(message),
        showInformationMessage: message => showInformationMessage(message),
        appendLine: message => appendOutput(message),
        postCompletion: completion => postBatchArchiveCompletion(completion as AiSessionBatchArchiveCompletedMessage),
        refresh: refreshAiSessionViewsIncrementally,
        syncActiveRuntime: options.syncActiveRuntime,
        logUnexpectedError: (operation, error, failedSessionId) => {
            if (operation === 'focus-runtime') {
                logAiSessionRuntimeFailure(operation, error, 'tmux');
                return;
            }
            logError(`Batch AI session archive failed during ${operation}${failedSessionId ? ` (${failedSessionId})` : ''}.`, error);
        },
    });
    const aiSessionTerminalCommandController = factories.createTerminalCommandController({
        isProviderId: isAiSessionProviderId,
        getWorkspaceTarget: getCurrentWorkspaceActionTarget,
        runtimeCoordinator: aiSessionRuntimeCoordinator,
        confirmRuntimeClose: (message, action) => showModalWarning(message, action),
        chooseRuntimeConflict: async runtimes => {
            const picks = runtimes.map(runtime => {
                const backendLabel = runtime.backend === 'tmux'
                    ? `tmux · ${runtime.tmux?.layout || 'unknown'} layout`
                    : 'Direct · VS Code Terminal';
                const attachment = runtime.attached ? 'attached' : 'detached';
                const target = runtime.backend === 'tmux'
                    ? `${runtime.tmux?.sessionName || 'unknown session'}${runtime.tmux?.windowName
                        ? `:${runtime.tmux.windowName}` : ''}`
                    : runtime.terminal?.name || 'unnamed VS Code terminal';
                return {
                    label: `$(terminal) ${backendLabel}`,
                    description: attachment,
                    detail: `Target: ${target}`,
                    runtime,
                };
            });
            const selected = await showQuickPick(picks, {
                placeHolder: 'Select the exact AI session runtime to focus',
                ignoreFocusOut: true,
            });
            return selected?.runtime;
        },
        announceStatus: (projectId, message) => postMessage({
            type: 'ai-session-status-announcement',
            projectId,
            message,
        }),
        showErrorMessage: message => showErrorMessage(message),
        logRuntimeFailure: logAiSessionRuntimeFailure,
        getProviderLabel: getAiSessionProviderLabel,
        refresh: refreshAiSessionViewsIncrementally,
        onRuntimeCloseEnd: (runtime, succeeded) => {
            const sessionId = runtime.identity.sessionId;
            if (!sessionId || !succeeded) {
                return;
            }
            void runSafeAiSessionRuntimeLifecycleTask(
                'acknowledge-explicit-session-close',
                () => acknowledgeAiSessionAttention({
                    provider: runtime.identity.provider,
                    sessionId,
                    workspaceScopeIdentity: runtime.identity.workspaceScopeIdentity,
                })
            );
        },
        focusTerminalView: () => focusTerminalView(),
    });
    const aiSessionResumeController = factories.createResumeController({
        getWorkspaceTarget: getCurrentWorkspaceActionTarget,
        getLaunchOptions,
        resolveResumeProfileDecision,
        getProvider: getRegisteredAiSessionProvider,
        resolveWorkspaceDirectoryScope: (target, session, providerId, explicitRootId) =>
            aiSessionCommandController.resolveWorkspaceDirectoryScope(
                target.workspace, providerId, session, explicitRootId
            ),
        rememberDirectoryScope: async directoryScope => {
            try {
                await aiSessionCommandController.rememberDirectoryScope(directoryScope);
            } catch (error) {
                logError('Could not save the AI session workspace root.', error);
            }
        },
        getTerminalName: (providerId, session) => getProviderAiSessionTerminalName(providerId, session, aiSessionProviders),
        runtimeCoordinator: aiSessionRuntimeCoordinator,
        getRuntimeConflict: getAiSessionRuntimeCollision,
        getMarkerPath: (providerId, sessionId) => aiSessionTerminalService.getMarkerPath(providerId, sessionId),
        showWarningMessage: message => showWarningMessage(message),
        showErrorMessage: message => showErrorMessage(message),
        logRuntimeFailure: logAiSessionRuntimeFailure,
        refresh: refreshAiSessionViewsIncrementally,
        showActiveTab: projectId => postMessage({
            type: 'ai-session-tab-selection-requested',
            projectId,
            tab: 'chats',
        }),
        announceStatus: (projectId, message) => postMessage({
            type: 'ai-session-status-announcement',
            projectId,
            message,
        }),
    });
    return {
        aiSessionCommandController,
        aiSessionCreationController,
        aiSessionArchiveController,
        aiSessionTerminalCommandController,
        aiSessionResumeController,
    };
}
