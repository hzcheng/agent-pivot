'use strict';

import {
    ProjectConnectionKind,
    ProjectConnectionProfile,
    validateProjectMachineId,
} from './projectClientProtocol';
import { planHostLaunch } from './environmentLaunchPlanner';

export type MachineProjectsActionStatus = 'opening' | 'saved' | 'handedOff' | 'cancelled' | 'failed';

export interface MachineProjectsActionSettlement {
    type: 'machine-project-action-settlement';
    version: 1;
    requestId: string;
    machineId: string;
    status: MachineProjectsActionStatus;
    message: string;
}

interface MachineProjectsActionRequest {
    type?: 'machine-project-action';
    version: 1;
    requestId: string;
    action: 'setup' | 'rebind' | 'openHost' | 'openProject';
    machineId: string;
    machineName: string;
    projectId?: string;
    environmentId?: string;
}

export interface MachineProjectsControllerOptions {
    getProfile(machineId: string): Promise<ProjectConnectionProfile | null>;
    updateProfile(machineId: string, profile: {
        kind: ProjectConnectionKind;
        target: string | null;
        resolverAuthority: string | null;
    }): PromiseLike<{ profiles: ProjectConnectionProfile[] }>;
    showConnectionKindPicker(
        current: ProjectConnectionProfile | null,
    ): Promise<'local' | 'ssh' | 'wsl' | null>;
    showConnectionTargetInput(options: {
        machineName: string;
        kind: 'ssh' | 'wsl';
        currentValue: string;
    }): Promise<string | null>;
    showSaveChoice(options: {
        rebinding: boolean;
        previousTarget: string;
        nextTarget: string;
    }): Promise<'save' | 'saveAndOpen' | null>;
    showWarningMessage(message: string): unknown;
    showErrorMessage(message: string): unknown;
    executeHostOpen(machineId: string): PromiseLike<'handedOff' | 'remoteSshMissing'>;
    executeProjectOpen(
        machineId: string,
        projectPath: string,
    ): PromiseLike<'handedOff' | 'remoteSshMissing'>;
    resolveProjectTarget(target: {
        legacyProjectId: string;
        machineId: string;
        environmentId: string;
    }): { projectPath: string } | null;
    refreshProjects(): void;
}

export class MachineProjectsController {
    public constructor(private readonly options: MachineProjectsControllerOptions) {
    }

    public async handle(
        raw: unknown,
        reportProgress: (
            settlement: MachineProjectsActionSettlement,
        ) => PromiseLike<unknown> | unknown = () => undefined,
    ): Promise<MachineProjectsActionSettlement> {
        const request = validateActionRequest(raw);
        try {
            if (request.action === 'openHost') {
                const profile = await this.options.getProfile(request.machineId);
                return await this.open(request, profile);
            }
            if (request.action === 'openProject') {
                return await this.openProject(request);
            }
            return await this.setup(request, reportProgress);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.options.showErrorMessage(`Could not update ${request.machineName}: ${message}`);
            return settlement(
                request,
                'failed',
                request.action === 'setup' || request.action === 'rebind'
                    ? 'Connection setup was not saved. Try again.'
                    : 'Connection state is unavailable. Try again.',
            );
        }
    }

    private async setup(
        request: MachineProjectsActionRequest,
        reportProgress: (
            settlement: MachineProjectsActionSettlement,
        ) => PromiseLike<unknown> | unknown,
    ): Promise<MachineProjectsActionSettlement> {
        const current = await this.options.getProfile(request.machineId);
        const kind = await this.options.showConnectionKindPicker(current);
        if (!kind) { return settlement(request, 'cancelled', 'Connection setup cancelled.'); }
        let target: string | null = null;
        let resolverAuthority: string | null = null;
        if (kind !== 'local') {
            const entered = await this.options.showConnectionTargetInput({
                machineName: request.machineName,
                kind,
                currentValue: current?.kind === kind ? current.target || '' : '',
            });
            if (entered === null) {
                return settlement(request, 'cancelled', 'Connection setup cancelled.');
            }
            target = entered.trim();
            if (!target) {
                return settlement(request, 'failed', 'Connection target is required.');
            }
            resolverAuthority = `${kind === 'ssh' ? 'ssh-remote' : 'wsl'}+${target}`;
        }
        const choice = await this.options.showSaveChoice({
            rebinding: Boolean(current),
            previousTarget: formatProfileTarget(current),
            nextTarget: target || 'Local',
        });
        if (!choice) { return settlement(request, 'cancelled', 'Connection setup cancelled.'); }
        await this.options.updateProfile(request.machineId, {
            kind,
            target,
            resolverAuthority,
        });
        this.options.refreshProjects();
        const profile: ProjectConnectionProfile = {
            machineId: request.machineId,
            kind,
            target,
            resolverAuthority,
            updatedAtMs: 0,
        };
        if (choice === 'save') {
            return settlement(request, 'saved', 'Connection saved in this VS Code.');
        }
        try {
            await reportProgress(settlement(
                request,
                'opening',
                'Opening a new VS Code window…',
            ));
        } catch {
            // Webview progress is best-effort and must never control the saved navigation action.
        }
        return this.open(request, profile);
    }

    private async open(
        request: MachineProjectsActionRequest,
        profile: ProjectConnectionProfile | null,
    ): Promise<MachineProjectsActionSettlement> {
        const plan = planHostLaunch(profile);
        if (plan.kind === 'setup') {
            this.options.showWarningMessage(
                `${request.machineName} is not configured in this VS Code.`,
            );
            return settlement(request, 'failed', 'Set up this Machine before opening it.');
        }
        let outcome: 'handedOff' | 'remoteSshMissing';
        try {
            outcome = await this.options.executeHostOpen(request.machineId);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.options.showErrorMessage(`Could not open ${request.machineName}: ${message}`);
            return settlement(request, 'failed', 'VS Code couldn’t start the window. Try again.');
        }
        if (outcome === 'remoteSshMissing') {
            return settlement(
                request,
                'failed',
                'Remote - SSH is required. Install it, then retry.',
            );
        }
        return settlement(
            request,
            'handedOff',
            'Finish connecting in the new window.',
        );
    }

    private async openProject(
        request: MachineProjectsActionRequest,
    ): Promise<MachineProjectsActionSettlement> {
        const profile = await this.options.getProfile(request.machineId);
        const plan = planHostLaunch(profile);
        if (plan.kind === 'setup') {
            return settlement(request, 'failed', 'Set up this Machine before opening its Projects.');
        }
        const target = this.options.resolveProjectTarget({
            legacyProjectId: request.projectId!,
            machineId: request.machineId,
            environmentId: request.environmentId!,
        });
        if (!target) {
            return settlement(request, 'failed', 'This Project is not openable in the Host preview.');
        }
        const outcome = await this.options.executeProjectOpen(request.machineId, target.projectPath);
        if (outcome === 'remoteSshMissing') {
            return settlement(
                request,
                'failed',
                'Remote - SSH is required. Install it, then retry.',
            );
        }
        return settlement(request, 'handedOff', 'Opening the Project in a new window.');
    }
}

function validateActionRequest(raw: unknown): MachineProjectsActionRequest {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('machine project action must be an object');
    }
    const value = raw as Record<string, unknown>;
    const allowed = [
        'type', 'version', 'requestId', 'action', 'machineId', 'machineName',
        'projectId', 'environmentId',
    ];
    if (Object.keys(value).some(key => !allowed.includes(key))
        || value.version !== 1
        || (value.type !== undefined && value.type !== 'machine-project-action')
        || typeof value.requestId !== 'string' || value.requestId.length < 1 || value.requestId.length > 128
        || (value.action !== 'setup' && value.action !== 'rebind'
            && value.action !== 'openHost' && value.action !== 'openProject')
        || typeof value.machineId !== 'string'
        || typeof value.machineName !== 'string'
        || value.machineName.length < 1 || value.machineName.length > 256) {
        throw new Error('machine project action is invalid');
    }
    validateProjectMachineId(value.machineId);
    const projectAction = value.action === 'openProject';
    if (projectAction !== (typeof value.projectId === 'string')
        || projectAction !== (typeof value.environmentId === 'string')
        || (projectAction && (!(value.projectId as string)
            || (value.projectId as string).length > 256
            || !(value.environmentId as string)
            || (value.environmentId as string).length > 256))) {
        throw new Error('machine project action target is invalid');
    }
    return value as unknown as MachineProjectsActionRequest;
}

function formatProfileTarget(profile: ProjectConnectionProfile | null): string {
    if (!profile) { return 'Not configured'; }
    return profile.target || (profile.kind === 'local' ? 'Local' : 'Configured');
}

function settlement(
    request: MachineProjectsActionRequest,
    status: MachineProjectsActionStatus,
    message: string,
): MachineProjectsActionSettlement {
    return {
        type: 'machine-project-action-settlement',
        version: 1,
        requestId: request.requestId,
        machineId: request.machineId,
        status,
        message,
    };
}
