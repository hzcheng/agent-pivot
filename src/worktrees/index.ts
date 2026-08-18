'use strict';

/**
 * The only public entrypoint of MOD-WORKTREE-LIFECYCLE (Stage 1B pilot RFC;
 * ARCH-CHANGE-004). Cross-module consumers import from here, never from the
 * internal files. The surface is exactly what the composition root and the
 * sibling modules consume today — widening it is an architecture change.
 */

// Stores and persistence-bound authorities.
export { WorktreeGroupManifestStore, WorktreeGroupManifestError } from './groupManifestStore';
export type { WorktreeGroup, WorktreeGroupMember } from './groupManifestStore';
export { WorktreeProvisioningStore } from './provisioningStore';
export { WorktreeBaseRefStore } from './baseRefStore';

// Lifecycle, reconciliation, and settlement primitives.
export { WorktreeMemberLifecycle } from './memberLifecycle';
export { reconcileWorktreeGroupManifest } from './groupManifestReconciliation';
export { resolveGenerationClaimDisposition } from './generationClaimReconciliation';
export { createSettlementReplayCache } from './settlementReplayCache';
export {
    findLatestRetirementForKey,
    findLatestRetirementForPath,
    judgeSessionGeneration,
} from './retiredWorktrees';
export type { GenerationClaim, RetiredWorktreeIdentity } from './retiredWorktrees';
export type { DeletionJournalEntry } from './deletionJournal';

// Controllers and coordinators.
export { WorktreeGroupCreationController } from './groupCreationController';
export { IsolatedSessionController } from './isolatedSessionController';
export { WorktreeDeletionController } from './deletionController';
export { ManagedWorktreeRemovalController } from './managedWorktreeRemovalController';
export { WorktreeSnapshotCoordinator } from './snapshotCoordinator';
export { ChangesCollector, aggregateMemberChanges } from './changesCollector';
export type { MemberChangesSnapshot, WorkingChangeItem } from './changesCollector';

// Git and setup infrastructure.
export { GitWorktreeProvisioner } from './gitWorktreeProvisioner';
export { GitWorktreeDiscovery } from './gitWorktreeDiscovery';
export { GitRepositoryStateMonitor } from './gitRepositoryStateMonitor';
export type { GitApiLike } from './gitRepositoryStateMonitor';
export { WorktreeSetupRunner, normalizeWorktreeSetupCommand } from './worktreeSetupRunner';
export { normalizeWorktreeDirectory } from './provisioningPlan';

// Webview message handlers and their protocol settlements.
export { handleAdoptWorktrees } from './groupAdoptHandler';
export type { WorktreeAdoptSettlement } from './groupAdoptProtocol';
export {
    handleAbandonWorktreeGroupDeletion,
    handleDeleteWorktreeGroupMember,
    handleDiscardWorktreeGenerationClaim,
    handlePreviewWorktreeGroupDeletion,
    handleRetryWorktreeGroupDeletion,
} from './groupDeletionHandler';
export type { WorktreeGroupDeletionHandlerDeps } from './groupDeletionHandler';
export type { WorktreeGroupDeletionSettlement } from './groupDeletionProtocol';
export { handleMergeWorktreeGroups } from './groupMergeHandler';
export type { MergeWorktreeGroupsPick } from './groupMergeHandler';
export type { WorktreeGroupMergeSettlement } from './groupMergeProtocol';
export { handleRenameWorktreeGroup } from './groupRenameHandler';
export type { WorktreeGroupRenameSettlement } from './groupRenameProtocol';
export {
    acceptedWorktreeGroupCreationSettlement,
    acceptedWorktreeGroupMemberSettlement,
    parseConfirmWorktreeGroupRequest,
    parseOpenWorktreeGroupFormRequest,
    parsePreviewWorktreeGroupRequest,
    parseWorktreeGroupMemberRequest,
    settledWorktreeGroupCreationSettlement,
    settledWorktreeGroupMemberSettlement,
} from './groupCreationProtocol';
export {
    acceptedIsolatedSessionSettlement,
    cancelledMutationSettlement,
    parseIsolatedSessionRequest,
    settledIsolatedSessionSettlement,
} from './provisioningProtocol';
export {
    acceptedWorktreeGroupPrimarySettlement,
    parseSetWorktreeGroupPrimaryRequest,
    settledWorktreeGroupPrimarySettlement,
} from './groupPrimaryProtocol';
export {
    acceptedManagedWorktreeRemovalSettlement,
    parseManagedWorktreeRemovalRequest,
    settledManagedWorktreeRemovalSettlement,
} from './removalProtocol';

// Shared types and the canonical WorktreeKey codecs (kernel re-exports).
export type {
    MemberBaseline,
    ProvisioningWorktreeRow,
    WorktreeGitSnapshot,
    WorktreeKey,
    WorktreeRepositorySnapshot,
    WorktreeSnapshot,
} from './types';
export {
    cloneWorktreeKey,
    worktreeKeyToString,
    worktreeKeyTombstoneKey,
    worktreeKeysEqual,
    worktreeKeysMatch,
} from './types';
