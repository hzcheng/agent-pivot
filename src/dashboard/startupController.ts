'use strict';

import { RelevantExtensions } from '../constants';
import { ReopenStewardReason, StewardInfos } from '../models';
import { shouldOpenAgentPivotOnStartup } from './startup';

type RelevantExtensionInstalls = StewardInfos['relevantExtensionsInstalls'];

export interface DashboardStartupControllerOptions {
    stewardInfos: StewardInfos;
    relevantExtensions?: Record<keyof RelevantExtensionInstalls, string>;
    isExtensionInstalled: (extensionId: string) => boolean;
    assertActive?: () => void;
    applyProjectColorToCurrentWindow: () => void;
    getReopenReason: () => unknown;
    updateReopenReason: (reason: ReopenStewardReason) => unknown;
    reopenNoneValue?: ReopenStewardReason;
    getWorkspaceName: () => string | undefined;
    getVisibleEditorLanguageIds: () => readonly string[];
    showAgentPivot: () => unknown;
    completePendingWorkspaceSave?: () => Promise<void>;
}

export class DashboardStartupController {
    constructor(private readonly options: DashboardStartupControllerOptions) {
    }

    async startUp(): Promise<void> {
        this.updateRelevantExtensionInstalls();
        if (this.options.completePendingWorkspaceSave) {
            await this.options.completePendingWorkspaceSave();
            this.assertActive();
        }
        this.options.applyProjectColorToCurrentWindow();

        const reopenNoneValue = this.options.reopenNoneValue ?? ReopenStewardReason.None;
        const reopenStewardReason = this.options.getReopenReason();
        this.options.updateReopenReason(reopenNoneValue);
        if (shouldOpenAgentPivotOnStartup({
            reopenReason: reopenStewardReason,
            reopenNoneValue,
            openOnStartup: this.options.stewardInfos.config.openOnStartup,
            workspaceName: this.options.getWorkspaceName(),
            visibleEditorLanguageIds: this.options.getVisibleEditorLanguageIds(),
        })) {
            this.options.showAgentPivot();
        }
    }

    private assertActive(): void {
        this.options.assertActive?.();
    }

    private updateRelevantExtensionInstalls(): void {
        const relevantExtensions = this.options.relevantExtensions || RelevantExtensions;
        for (const extensionName in this.options.stewardInfos.relevantExtensionsInstalls) {
            const key = extensionName as keyof RelevantExtensionInstalls;
            this.options.stewardInfos.relevantExtensionsInstalls[key] = this.options.isExtensionInstalled(relevantExtensions[key]);
        }
    }
}
