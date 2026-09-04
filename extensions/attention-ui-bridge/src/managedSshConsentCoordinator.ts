'use strict';

import {
    buildManagedSshProjection,
    ManagedSshProjection,
    renderManagedSshConfig,
    renderManagedSshIncludeBlock,
} from '../../../src/projects/managedRemote/sshConfigProjection';
import { ManagedRevisionSlot } from '../../../src/projects/managedRemote/types';
import {
    analyzeManagedInclude,
    insertManagedInclude,
    ManagedSshDependencyFingerprint,
    NodeManagedSshConfigFileSystem,
    removeManagedInclude,
    scanManagedSshConfigGraph,
} from './managedSshConfigPolicy';
import {
    ManagedSshConsentFileStore,
    ManagedSshConsentRecordV1,
} from './managedSshConsentStore';
import {
    ManagedSshInstalledProjection,
    ManagedSshOwnedFileStore,
} from './managedSshOwnedFiles';
import {
    ManagedSshActiveConfigEditor,
    ManagedSshActiveConfigEditingService,
} from './managedSshActiveConfigEditor';
import {
    ManagedSshProjectionValidationService,
    ManagedSshProjectionValidator,
} from './managedSshValidator';

export interface ManagedSshEnablePreflight {
    activeConfigPath: string;
    executable: string;
    generatedConfigPath: string;
    generatedDirectory: string;
    backupPath: string;
    includeBlock: string;
    currentConfigContent: string;
    candidateConfigContent: string;
    includeState: 'absent' | 'exact';
    dependencyFingerprint: ManagedSshDependencyFingerprint;
    projection: ManagedSshProjection;
    editMode: 'automatic' | 'manualFallback';
    automaticFailureReason?: string;
}

export interface ManagedSshDisablePreflight {
    activeConfigPath: string;
    generatedDirectory: string;
    backupPath: string;
    includeBlock: string;
    currentConfigContent: string;
    candidateConfigContent: string;
    editMode: 'automatic' | 'manualFallback';
    automaticFailureReason?: string;
}

export type ManagedSshEnableResult =
    | { status: 'awaitingManualInclude'; preflight: ManagedSshEnablePreflight }
    | { status: 'enabled'; record: ManagedSshConsentRecordV1 };

export type ManagedSshRecoveryResult =
    | ManagedSshEnableResult
    | { status: 'awaitingManualIncludeRemoval'; preflight: ManagedSshDisablePreflight }
    | { status: 'disabled'; record: ManagedSshConsentRecordV1 }
    | { status: 'recoveryRequired'; record: ManagedSshConsentRecordV1 };

export type ManagedSshDisableResult =
    | { status: 'awaitingManualIncludeRemoval'; preflight: ManagedSshDisablePreflight }
    | { status: 'disabled'; record: ManagedSshConsentRecordV1 };

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function assertManagedSshMaterializerPlatform(platform: NodeJS.Platform): void {
    if (platform === 'win32') {
        throw new Error(
            'Managed SSH connections on Windows require the pending DACL and reparse-point safety gate.',
        );
    }
}

export class ManagedSshConsentCoordinator {
    private readonly configFiles = new NodeManagedSshConfigFileSystem();
    private readonly owned: ManagedSshOwnedFileStore;
    private readonly activeConfigEditor: ManagedSshActiveConfigEditingService;
    private pending: Promise<unknown> = Promise.resolve();

    constructor(
        private readonly activeConfigPath: string,
        private readonly executable: string,
        private readonly consent: ManagedSshConsentFileStore,
        private readonly validator: ManagedSshProjectionValidationService = new ManagedSshProjectionValidator(),
        activeConfigEditor?: ManagedSshActiveConfigEditingService,
    ) {
        this.owned = new ManagedSshOwnedFileStore(activeConfigPath);
        this.activeConfigEditor = activeConfigEditor
            || new ManagedSshActiveConfigEditor(activeConfigPath, this.owned);
    }

    getState(): ManagedSshConsentRecordV1 {
        const record = this.readStoredState();
        if (this.activeConfigEditor.hasInterruptedExchange()) {
            return {
                ...record,
                status: 'recoveryRequired',
                recoveryReason: 'An automatic SSH config update was interrupted.',
            };
        }
        if (record.status !== 'disabled' && record.executable !== this.executable) {
            return {
                ...record,
                status: 'recoveryRequired',
                recoveryReason: 'The configured SSH executable changed and must be revalidated.',
            };
        }
        return record;
    }

    getExecutable(): string {
        return this.executable;
    }

    getActiveConfigPath(): string {
        return this.activeConfigPath;
    }

    preflightEnable(slot: ManagedRevisionSlot): Promise<ManagedSshEnablePreflight> {
        return this.enqueue(() => this.preflightEnableNow(slot));
    }

    beginEnable(slot: ManagedRevisionSlot): Promise<ManagedSshEnableResult> {
        return this.enqueue(async () => {
            const preflight = await this.preflightEnableNow(slot);
            const current = this.readStoredState();
            if (current.status !== 'disabled') {
                throw new Error(`Managed SSH consent is ${current.status}, not disabled.`);
            }
            let transition = this.consent.compareAndSet(current.generation, {
                ...current,
                executable: this.executable,
                status: 'enabling',
                journal: {
                    operation: 'enable',
                    phase: 'preparing',
                    revisionId: slot.revisionId,
                    connectionDigest: preflight.projection.connectionDigest,
                    dependencyDigest: preflight.dependencyFingerprint.digest,
                },
            });
            try {
                const installed = await this.prepareAndActivate(
                    slot,
                    preflight.projection,
                    preflight.dependencyFingerprint,
                    undefined,
                );
                transition = this.consent.compareAndSet(transition.generation, {
                    ...transition,
                    status: 'enabling',
                    journal: {
                        operation: 'enable',
                        phase: 'awaitingInclude',
                        revisionId: slot.revisionId,
                        connectionDigest: preflight.projection.connectionDigest,
                        currentChecksum: installed.currentChecksum,
                        dependencyDigest: preflight.dependencyFingerprint.digest,
                    },
                });
                return await this.tryAutomaticEnable(slot, transition, preflight);
            } catch (error) {
                this.markRecovery(transition, error);
                throw error;
            }
        });
    }

    confirmEnable(slot: ManagedRevisionSlot): Promise<ManagedSshConsentRecordV1> {
        return this.enqueue(async () => {
            const current = this.readStoredState();
            try {
                return await this.completeEnableNow(slot, current);
            } catch (error) {
                this.markRecovery(current, error);
                throw error;
            }
        });
    }

    reconcile(slot: ManagedRevisionSlot): Promise<ManagedSshConsentRecordV1> {
        return this.enqueue(async () => {
            let current = this.readStoredState();
            if (current.status !== 'enabled') {
                throw new Error('Managed SSH connections are not enabled on this computer.');
            }
            const preflight = await this.preflightEnableNow(slot);
            if (preflight.includeState !== 'exact') {
                const error = new Error('The Agent Pivot Include is missing from the active SSH config.');
                this.markRecovery(current, error);
                throw error;
            }
            current = this.consent.compareAndSet(current.generation, {
                ...current,
                executable: this.executable,
                status: 'enabling',
                journal: {
                    operation: 'reconcile',
                    phase: 'preparing',
                    revisionId: slot.revisionId,
                    connectionDigest: preflight.projection.connectionDigest,
                    currentChecksum: current.currentChecksum,
                    dependencyDigest: preflight.dependencyFingerprint.digest,
                },
            });
            try {
                const installed = await this.prepareAndActivate(
                    slot,
                    preflight.projection,
                    preflight.dependencyFingerprint,
                    current.currentChecksum,
                );
                current = this.consent.compareAndSet(current.generation, {
                    ...current,
                    journal: {
                        operation: 'reconcile',
                        phase: 'activating',
                        revisionId: slot.revisionId,
                        connectionDigest: preflight.projection.connectionDigest,
                        currentChecksum: installed.currentChecksum,
                        dependencyDigest: preflight.dependencyFingerprint.digest,
                    },
                });
                return await this.completeEnableNow(slot, current);
            } catch (error) {
                this.markRecovery(current, error);
                throw error;
            }
        });
    }

    preflightDisable(): ManagedSshDisablePreflight {
        const record = this.readStoredState();
        if (record.status !== 'enabled') {
            throw new Error('Managed SSH connections are not enabled on this computer.');
        }
        return this.preflightDisableNow();
    }

    recover(slot?: ManagedRevisionSlot): Promise<ManagedSshRecoveryResult> {
        return this.enqueue(async () => {
            this.activeConfigEditor.recoverInterruptedExchange();
            let current = this.readStoredState();
            if (current.status === 'enabled' && current.executable !== this.executable) {
                const target = this.requireRecoverySlot(slot);
                current = this.consent.compareAndSet(current.generation, {
                    ...current,
                    executable: this.executable,
                    status: 'recoveryRequired',
                    journal: {
                        operation: 'reconcile',
                        phase: 'preparing',
                        revisionId: target.revisionId,
                        currentChecksum: current.currentChecksum,
                    },
                    recoveryReason: 'The configured SSH executable changed and must be revalidated.',
                });
            }
            if (current.status === 'recoveryRequired') {
                if (current.journal?.operation === 'disable') {
                    current = this.consent.compareAndSet(current.generation, {
                        ...current,
                        status: 'disabling',
                        recoveryReason: undefined,
                    });
                } else {
                    try {
                        const target = this.requireRecoverySlot(slot);
                        const preflight = await this.preflightEnableNow(target);
                        const prepared = this.owned.readCurrent();
                        current = this.consent.compareAndSet(current.generation, {
                            ...current,
                            executable: this.executable,
                            status: 'enabling',
                            recoveryReason: undefined,
                            journal: {
                                operation: current.journal?.operation === 'reconcile'
                                    ? 'reconcile' : 'enable',
                                phase: 'preparing',
                                revisionId: target.revisionId,
                                connectionDigest: preflight.projection.connectionDigest,
                                currentChecksum: prepared?.checksum,
                                dependencyDigest: preflight.dependencyFingerprint.digest,
                            },
                        });
                        const installed = await this.prepareAndActivate(
                            target,
                            preflight.projection,
                            preflight.dependencyFingerprint,
                            prepared?.checksum,
                        );
                        current = this.consent.compareAndSet(current.generation, {
                            ...current,
                            journal: {
                                operation: current.journal?.operation === 'reconcile'
                                    ? 'reconcile' : 'enable',
                                phase: 'awaitingInclude',
                                revisionId: target.revisionId,
                                connectionDigest: preflight.projection.connectionDigest,
                                currentChecksum: installed.currentChecksum,
                                dependencyDigest: preflight.dependencyFingerprint.digest,
                            },
                        });
                        return await this.tryAutomaticEnable(target, current, preflight);
                    } catch (error) {
                        this.markRecovery(current, error);
                        throw error;
                    }
                }
            }
            if (current.status === 'disabled' || current.status === 'enabled') {
                const visible = this.getState();
                return visible.status === 'recoveryRequired'
                    ? { status: 'recoveryRequired', record: visible }
                    : { status: current.status, record: current };
            }
            if (current.status === 'disabling') {
                const active = this.configFiles.readSecureFile(this.activeConfigPath);
                const marker = analyzeManagedInclude(active.content, this.owned.getPaths().current);
                if (marker === 'absent') {
                    return { status: 'disabled', record: this.confirmDisableNow() };
                }
                if (marker === 'exact') {
                    return await this.tryAutomaticDisable();
                }
                const error = new Error('The Agent Pivot Include changed during disable recovery.');
                this.markRecovery(current, error);
                throw error;
            }
            const target = this.requireRecoverySlot(slot);
            if (current.journal?.revisionId !== target.revisionId) {
                const error = new Error('Pending enable targets a different catalog revision.');
                this.markRecovery(current, error);
                throw error;
            }
            const active = this.configFiles.readSecureFile(this.activeConfigPath);
            const marker = analyzeManagedInclude(active.content, this.owned.getPaths().current);
            if (marker === 'exact' && current.journal.currentChecksum) {
                return {
                    status: 'enabled',
                    record: await this.completeEnableNow(target, current),
                };
            }
            if (marker !== 'absent') {
                const error = new Error('The Agent Pivot Include changed during enable recovery.');
                this.markRecovery(current, error);
                throw error;
            }
            const preflight = await this.preflightEnableNow(target);
            const prepared = this.owned.readCurrent();
            if (!prepared || prepared.checksum !== current.journal.currentChecksum) {
                try {
                    const installed = await this.prepareAndActivate(
                        target,
                        preflight.projection,
                        preflight.dependencyFingerprint,
                        prepared?.checksum,
                    );
                    current = this.consent.compareAndSet(current.generation, {
                        ...current,
                        journal: {
                            operation: 'enable',
                            phase: 'awaitingInclude',
                            revisionId: target.revisionId,
                            connectionDigest: preflight.projection.connectionDigest,
                            currentChecksum: installed.currentChecksum,
                            dependencyDigest: preflight.dependencyFingerprint.digest,
                        },
                    });
                } catch (error) {
                    this.markRecovery(current, error);
                    throw error;
                }
            }
            return await this.tryAutomaticEnable(target, current, preflight);
        });
    }

    private preflightDisableNow(): ManagedSshDisablePreflight {
        const active = this.configFiles.readSecureFile(this.activeConfigPath);
        const generated = this.owned.getPaths().current;
        if (analyzeManagedInclude(active.content, generated) !== 'exact') {
            throw new Error('The Agent Pivot Include is missing or modified.');
        }
        return {
            activeConfigPath: this.activeConfigPath,
            generatedDirectory: this.owned.getPaths().root,
            backupPath: this.owned.getPaths().activeConfigPrevious,
            includeBlock: renderManagedSshIncludeBlock(generated),
            currentConfigContent: active.content,
            candidateConfigContent: removeManagedInclude(active.content, generated),
            editMode: 'automatic',
        };
    }

    beginDisable(): Promise<ManagedSshDisableResult> {
        return this.enqueue(async () => {
            const current = this.readStoredState();
            if (current.status !== 'enabled') {
                throw new Error('Managed SSH connections are not enabled on this computer.');
            }
            const preflight = this.preflightDisableNow();
            const transition = this.consent.compareAndSet(current.generation, {
                ...current,
                status: 'disabling',
                journal: {
                    operation: 'disable',
                    phase: 'awaitingIncludeRemoval',
                    revisionId: current.activeRevisionId,
                    connectionDigest: current.connectionDigest,
                    currentChecksum: current.currentChecksum,
                    dependencyDigest: current.dependencyDigest,
                },
            });
            try {
                return await this.tryAutomaticDisable(preflight);
            } catch (error) {
                this.markRecovery(transition, error);
                throw error;
            }
        });
    }

    confirmDisable(): Promise<ManagedSshConsentRecordV1> {
        return this.enqueue(async () => this.confirmDisableNow());
    }

    private confirmDisableNow(): ManagedSshConsentRecordV1 {
        const current = this.readStoredState();
        if (current.status !== 'disabling' || !current.currentChecksum) {
            throw new Error('Managed SSH disable is not awaiting Include removal.');
        }
        const active = this.configFiles.readSecureFile(this.activeConfigPath);
        const marker = analyzeManagedInclude(active.content, this.owned.getPaths().current);
        if (marker !== 'absent') {
            throw new Error('Remove the exact Agent Pivot Include block before continuing.');
        }
        this.owned.removeOwnedFiles(current.currentChecksum);
        return this.consent.compareAndSet(current.generation, {
            schemaVersion: 1,
            generation: current.generation,
            configPath: this.activeConfigPath,
            executable: this.executable,
            status: 'disabled',
        });
    }

    cancelPendingTransition(): Promise<ManagedSshConsentRecordV1> {
        return this.enqueue(async () => {
            const current = this.readStoredState();
            if (current.status === 'disabling') {
                const active = this.configFiles.readSecureFile(this.activeConfigPath);
                if (analyzeManagedInclude(active.content, this.owned.getPaths().current) !== 'exact') {
                    throw new Error('Cannot cancel disable after the Include was removed.');
                }
                return this.consent.compareAndSet(current.generation, {
                    ...current,
                    status: 'enabled',
                    journal: undefined,
                });
            }
            if (current.status !== 'enabling') {
                throw new Error('Managed SSH has no pending transition to cancel.');
            }
            const active = this.configFiles.readSecureFile(this.activeConfigPath);
            if (analyzeManagedInclude(active.content, this.owned.getPaths().current) !== 'absent') {
                throw new Error('Cannot cancel enable after the Include was added.');
            }
            this.owned.removeOwnedFiles(current.journal?.currentChecksum || '');
            return this.consent.compareAndSet(current.generation, {
                schemaVersion: 1,
                generation: current.generation,
                configPath: this.activeConfigPath,
                executable: this.executable,
                status: 'disabled',
            });
        });
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.pending.then(operation, operation);
        this.pending = result.then(() => undefined, () => undefined);
        return result;
    }

    private requireRecoverySlot(slot: ManagedRevisionSlot | undefined): ManagedRevisionSlot {
        if (!slot) {
            throw new Error('The active Managed Remote catalog revision is required for recovery.');
        }
        return slot;
    }

    private async manualEnablePreflight(
        slot: ManagedRevisionSlot,
        reason: string | undefined,
    ): Promise<ManagedSshEnablePreflight> {
        const refreshed = await this.preflightEnableNow(slot);
        return {
            ...refreshed,
            editMode: 'manualFallback',
            automaticFailureReason: reason || 'Automatic SSH config update was unavailable.',
        };
    }

    private async tryAutomaticEnable(
        slot: ManagedRevisionSlot,
        record: ManagedSshConsentRecordV1,
        preflight: ManagedSshEnablePreflight,
    ): Promise<ManagedSshEnableResult> {
        if (preflight.includeState === 'exact') {
            return {
                status: 'enabled',
                record: await this.completeEnableNow(slot, record),
            };
        }
        const edit = this.activeConfigEditor.replace(
            preflight.currentConfigContent,
            preflight.candidateConfigContent,
        );
        if (edit.status === 'updated') {
            return {
                status: 'enabled',
                record: await this.completeEnableNow(slot, record),
            };
        }
        return {
            status: 'awaitingManualInclude',
            preflight: await this.manualEnablePreflight(slot, edit.reason),
        };
    }

    private async tryAutomaticDisable(
        prepared?: ManagedSshDisablePreflight,
    ): Promise<ManagedSshDisableResult> {
        const preflight = prepared || this.preflightDisableNow();
        const edit = this.activeConfigEditor.replace(
            preflight.currentConfigContent,
            preflight.candidateConfigContent,
        );
        if (edit.status === 'updated') {
            return { status: 'disabled', record: this.confirmDisableNow() };
        }
        const active = this.configFiles.readSecureFile(this.activeConfigPath);
        const marker = analyzeManagedInclude(active.content, this.owned.getPaths().current);
        if (marker === 'absent') {
            return { status: 'disabled', record: this.confirmDisableNow() };
        }
        if (marker !== 'exact') {
            throw new Error('The Agent Pivot Include changed during automatic disable.');
        }
        const refreshed = this.preflightDisableNow();
        return {
            status: 'awaitingManualIncludeRemoval',
            preflight: {
                ...refreshed,
                editMode: 'manualFallback',
                automaticFailureReason: edit.reason
                    || 'Automatic SSH config update was unavailable.',
            },
        };
    }

    private async preflightEnableNow(slot: ManagedRevisionSlot): Promise<ManagedSshEnablePreflight> {
        assertManagedSshMaterializerPlatform(process.platform);
        const active = this.configFiles.readSecureFile(this.activeConfigPath);
        const paths = this.owned.getPaths();
        const includeState = analyzeManagedInclude(active.content, paths.current);
        if (includeState === 'malformed') {
            throw new Error('The active SSH config contains a modified or duplicate Agent Pivot marker.');
        }
        const scan = scanManagedSshConfigGraph(this.activeConfigPath, this.configFiles, {
            platform: process.platform,
        });
        if (scan.issues.length || !scan.fingerprint) {
            throw new Error(`The active SSH config is unsafe: ${scan.issues.join(', ')}`);
        }
        await this.validator.probe(this.executable);
        const projection = buildManagedSshProjection(slot);
        const includeBlock = renderManagedSshIncludeBlock(paths.current);
        return {
            activeConfigPath: this.activeConfigPath,
            executable: this.executable,
            generatedConfigPath: paths.current,
            generatedDirectory: paths.root,
            backupPath: paths.activeConfigPrevious,
            includeBlock,
            currentConfigContent: active.content,
            candidateConfigContent: insertManagedInclude(
                active.content, includeBlock, paths.current,
            ),
            includeState,
            dependencyFingerprint: scan.fingerprint,
            projection,
            editMode: 'automatic',
        };
    }

    private async prepareAndActivate(
        slot: ManagedRevisionSlot,
        projection: ManagedSshProjection,
        fingerprint: ManagedSshDependencyFingerprint,
        expectedCurrentChecksum: string | undefined,
    ): Promise<ManagedSshInstalledProjection> {
        const staged = this.owned.stageProjection({
            revisionId: slot.revisionId,
            connectionDigest: projection.connectionDigest,
            content: renderManagedSshConfig(projection),
        });
        const active = this.configFiles.readSecureFile(this.activeConfigPath);
        const currentPath = this.owned.getPaths().current;
        const marker = analyzeManagedInclude(active.content, currentPath);
        if (marker === 'malformed') {
            throw new Error('The Agent Pivot Include changed during validation.');
        }
        const withoutCurrent = marker === 'exact'
            ? removeManagedInclude(active.content, currentPath) : active.content;
        const revisionBlock = renderManagedSshIncludeBlock(staged.revisionPath);
        const aggregate = insertManagedInclude(
            withoutCurrent, revisionBlock, staged.revisionPath,
        );
        await this.validator.validate({
            executable: this.executable,
            generatedConfigPath: staged.revisionPath,
            aggregateConfigContent: aggregate,
            entries: projection.entries,
        });
        const afterScan = scanManagedSshConfigGraph(this.activeConfigPath, this.configFiles, {
            platform: process.platform,
        });
        if (!afterScan.fingerprint || afterScan.fingerprint.digest !== fingerprint.digest) {
            throw new Error('The active SSH config changed while Agent Pivot was validating it.');
        }
        return this.owned.activateProjection(staged, expectedCurrentChecksum);
    }

    private async completeEnableNow(
        slot: ManagedRevisionSlot,
        record: ManagedSshConsentRecordV1,
    ): Promise<ManagedSshConsentRecordV1> {
        if (record.status !== 'enabling'
            || record.journal?.revisionId !== slot.revisionId
            || !record.journal.currentChecksum) {
            throw new Error('Managed SSH enable is not awaiting this catalog revision.');
        }
        const active = this.configFiles.readSecureFile(this.activeConfigPath);
        const paths = this.owned.getPaths();
        if (analyzeManagedInclude(active.content, paths.current) !== 'exact') {
            throw new Error('Add the exact Agent Pivot Include block before continuing.');
        }
        const scan = scanManagedSshConfigGraph(this.activeConfigPath, this.configFiles, {
            platform: process.platform,
        });
        if (scan.issues.length || !scan.fingerprint) {
            throw new Error(`The enabled SSH config is unsafe: ${scan.issues.join(', ')}`);
        }
        const current = this.owned.readCurrent();
        if (!current || current.checksum !== record.journal.currentChecksum) {
            throw new Error('Managed SSH current.conf no longer matches the prepared revision.');
        }
        const projection = buildManagedSshProjection(slot);
        const manifest = this.owned.readManifest();
        if (!manifest
            || manifest.revisionId !== slot.revisionId
            || manifest.connectionDigest !== projection.connectionDigest
            || manifest.currentChecksum !== current.checksum) {
            throw new Error('Managed SSH state does not match the prepared revision.');
        }
        await this.validator.validate({
            executable: this.executable,
            generatedConfigPath: paths.current,
            aggregateConfigContent: active.content,
            entries: projection.entries,
        });
        const verifiedScan = scanManagedSshConfigGraph(this.activeConfigPath, this.configFiles, {
            platform: process.platform,
        });
        if (!verifiedScan.fingerprint
            || verifiedScan.fingerprint.digest !== scan.fingerprint.digest
            || analyzeManagedInclude(
                this.configFiles.readSecureFile(this.activeConfigPath).content,
                paths.current,
            ) !== 'exact') {
            throw new Error('The active SSH config changed during final validation.');
        }
        return this.consent.compareAndSet(record.generation, {
            ...record,
            executable: this.executable,
            status: 'enabled',
            activeRevisionId: slot.revisionId,
            connectionDigest: projection.connectionDigest,
            currentChecksum: current.checksum,
            dependencyDigest: verifiedScan.fingerprint.digest,
            journal: undefined,
            recoveryReason: undefined,
        });
    }

    private markRecovery(record: ManagedSshConsentRecordV1, error: unknown): void {
        try {
            this.consent.compareAndSet(record.generation, {
                ...record,
                executable: this.executable,
                status: 'recoveryRequired',
                recoveryReason: errorMessage(error),
            });
        } catch (_concurrentError) {
            // The later generation is authoritative; never overwrite it with stale recovery state.
        }
    }

    private readStoredState(): ManagedSshConsentRecordV1 {
        return this.consent.read(this.activeConfigPath, this.executable);
    }
}
