'use strict';

import * as path from 'path';

import {
    DEFAULT_GLOBAL_SKILLS_LOCATION,
    hasGlobalSkillsStoreContent,
    relocateGlobalSkillsStore,
    RelocateGlobalSkillsStoreResult,
    resolveGlobalSkillsLocation,
} from './globalStoreService';

export interface GlobalSkillsLocationInputOptions {
    prompt: string;
    value: string;
    validateInput: (candidate: string) => string | undefined;
}

export interface GlobalStoreLocationControllerOptions {
    homeDir: string;
    getWorkspaceRoots: () => readonly string[];
    readSetting: () => string;
    writeSetting: (value: string) => PromiseLike<void>;
    showInputBox: (
        options: GlobalSkillsLocationInputOptions,
    ) => PromiseLike<string | undefined>;
    showWarningMessage: (
        message: string,
        options?: { modal: true },
        ...items: string[]
    ) => PromiseLike<string | undefined>;
    showErrorMessage: (message: string) => unknown;
    refresh: () => PromiseLike<unknown>;
    logError: (message: string, error: unknown) => void;
    relocate?: (
        sourceRoot: string,
        targetRoot: string,
    ) => RelocateGlobalSkillsStoreResult;
}

export class GlobalStoreLocationController {
    private activeValue: string;
    private activeRoot: string;
    private commandFlight: Promise<boolean> | null = null;
    private mutationQueue: Promise<void> = Promise.resolve();

    constructor(private readonly options: GlobalStoreLocationControllerOptions) {
        const configuredValue = options.readSetting();
        const configured = this.resolve(configuredValue);
        const fallback = this.resolve(DEFAULT_GLOBAL_SKILLS_LOCATION);
        this.activeValue = configured.ok
            ? configuredValue
            : DEFAULT_GLOBAL_SKILLS_LOCATION;
        this.activeRoot = configured.rootPath
            || fallback.rootPath
            || path.join(options.homeDir, '.skills');
        if (!configured.ok) {
            void options.showWarningMessage(
                `Agent Pivot ignored the invalid Global Skills Location and is using ~/.skills: `
                + configured.error,
            );
        }
    }

    getActiveRoot(): string {
        return this.activeRoot;
    }

    getActiveValue(): string {
        return this.activeValue;
    }

    changeInteractively(): Promise<boolean> {
        if (this.commandFlight) {
            return this.commandFlight;
        }
        this.commandFlight = this.runInteractiveChange();
        const clearFlight = (): void => {
            this.commandFlight = null;
        };
        void this.commandFlight.then(clearFlight, clearFlight);
        return this.commandFlight;
    }

    handleConfigurationChange(): Promise<boolean> {
        return this.enqueue(async () => {
            // Read inside the queue so coalesced Settings events apply only the
            // latest effective machine value.
            const requestedValue = this.options.readSetting();
            const previousValue = this.activeValue;
            // A configuration event is already persisted machine authority,
            // possibly confirmed in another window. Adopt it without opening
            // a second relocation prompt that could write the old value back.
            if (await this.apply(requestedValue, false)) {
                return true;
            }
            if (this.options.readSetting() !== requestedValue) {
                // A newer Settings event is already queued. Never overwrite it
                // while undoing a cancelled or invalid older request.
                return false;
            }
            try {
                await this.options.writeSetting(previousValue);
            } catch (error) {
                this.options.logError(
                    'Failed to restore the previous Global Skills Location.',
                    error,
                );
            }
            return false;
        });
    }

    private async runInteractiveChange(): Promise<boolean> {
        const value = await this.options.showInputBox({
            prompt: 'Change Global Skills Location. Use ~ or an absolute path; Project .skills folders are not changed.',
            value: this.activeValue,
            validateInput: candidate => {
                const result = this.resolve(candidate);
                return result.ok ? undefined : result.error;
            },
        });
        if (value === undefined) {
            return false;
        }
        const normalized = value.trim();
        if (!await this.enqueue(() => this.apply(normalized))) {
            return false;
        }
        try {
            await this.options.writeSetting(normalized);
            return true;
        } catch (error) {
            this.options.logError('Failed to save the Global Skills Location.', error);
            this.options.showErrorMessage(
                'The Global Skills Location changed for this session, but the setting could not be saved.',
            );
            return false;
        }
    }

    private async apply(requestedValue: string, offerRelocation = true): Promise<boolean> {
        const currentResolved = this.resolve(this.activeRoot);
        if (currentResolved.ok && currentResolved.rootPath) {
            // Another Extension Host may have relocated the machine-wide store
            // and left our lexical root as a compatibility alias.
            this.activeRoot = currentResolved.rootPath;
        }
        const resolved = this.resolve(requestedValue);
        if (!resolved.ok || !resolved.rootPath) {
            void this.options.showWarningMessage(
                `Could not use that Global Skills Location: ${resolved.error}`,
            );
            return false;
        }
        if (resolved.rootPath === this.activeRoot) {
            this.activeValue = requestedValue;
            return true;
        }
        if (this.locationsOverlap(this.activeRoot, resolved.rootPath)) {
            void this.options.showWarningMessage(
                'The old and new Global Skills locations cannot contain each other.',
            );
            return false;
        }

        if (offerRelocation && hasGlobalSkillsStoreContent(this.activeRoot)) {
            const choice = await this.options.showWarningMessage(
                `Change the Global Skills Location from ${this.activeRoot} `
                + `to ${resolved.rootPath}? Existing skills can be moved safely, `
                + 'or left in the old location.',
                { modal: true },
                'Move Existing Skills',
                'Use New Location',
            );
            if (choice === 'Move Existing Skills') {
                const relocation = (this.options.relocate || relocateGlobalSkillsStore)(
                    this.activeRoot,
                    resolved.rootPath,
                );
                if (!relocation.ok) {
                    this.options.showErrorMessage(
                        `Could not move the Global Skills store. The old location is still active. `
                        + `${relocation.error || 'Unknown error.'}`
                        + (relocation.recoveryPath
                            ? ` Recovery data is at ${relocation.recoveryPath}.`
                            : ''),
                    );
                    return false;
                }
                if (relocation.warning) {
                    void this.options.showWarningMessage(relocation.warning);
                }
            } else if (choice !== 'Use New Location') {
                return false;
            }
        }

        this.activeValue = requestedValue;
        this.activeRoot = resolved.rootPath;
        try {
            await this.options.refresh();
        } catch (error) {
            // Persistence and filesystem authority must not depend on a visible
            // Webview accepting an incremental refresh.
            this.options.logError(
                'Failed to refresh Skills after changing the Global Skills Location.',
                error,
            );
        }
        return true;
    }

    private resolve(value: string) {
        return resolveGlobalSkillsLocation(value, {
            homeDir: this.options.homeDir,
            workspaceRoots: this.options.getWorkspaceRoots(),
        });
    }

    private locationsOverlap(left: string, right: string): boolean {
        const isStrictDescendant = (parent: string, candidate: string): boolean => {
            const relative = path.relative(parent, candidate);
            return Boolean(relative)
                && relative !== '..'
                && !relative.startsWith(`..${path.sep}`)
                && !path.isAbsolute(relative);
        };
        return isStrictDescendant(left, right) || isStrictDescendant(right, left);
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.mutationQueue.then(operation, operation);
        this.mutationQueue = result.then(() => undefined, () => undefined);
        return result;
    }
}
