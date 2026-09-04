'use strict';

import * as vscode from 'vscode';

import type {
    AddManagedMachineInput,
    AddManagedProjectInput,
    EditManagedMachineInput,
    EditManagedProjectInput,
} from './catalogService';
import type { ManagedRemoteManagementPrompts } from './managementController';
import type {
    ManagedEnvironment,
    ManagedRemoteProject,
    ManagedSshMachine,
} from './types';
import { isManagedMachine } from './validation';

export type ManagedRemoteWizardResult<T> =
    | { action: 'accept'; value: T }
    | { action: 'back' }
    | { action: 'cancel' };

export interface ManagedRemoteWizardInput {
    title: string;
    step: number;
    totalSteps: number;
    prompt: string;
    value?: string;
    password?: boolean;
    validate(value: string): string | undefined;
}

export interface ManagedRemoteWizardPick<T> {
    title: string;
    step: number;
    totalSteps: number;
    items: Array<{ label: string; description?: string; detail?: string; value: T }>;
    selected?: T;
    canGoBack: boolean;
}

export interface ManagedRemoteWizardUi {
    input(options: ManagedRemoteWizardInput): Promise<ManagedRemoteWizardResult<string>>;
    pick<T>(options: ManagedRemoteWizardPick<T>): Promise<ManagedRemoteWizardResult<T>>;
    confirm(message: string, action: string): Promise<boolean>;
}

function clean(value: string): string {
    return value.trim();
}

function validText(value: string, label: string): string | undefined {
    const normalized = clean(value);
    if (!normalized) { return `${label} is required.`; }
    if (normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
        return `${label} contains unsupported characters or is too long.`;
    }
    return undefined;
}

function validPort(value: string): string | undefined {
    const port = Number(clean(value));
    return Number.isSafeInteger(port) && port >= 1 && port <= 65535
        ? undefined : 'Port must be an integer from 1 to 65535.';
}

function validRemotePath(value: string): string | undefined {
    const normalized = clean(value);
    if (!normalized || /[\u0000\r\n]/u.test(normalized) || normalized.length > 4096) {
        return 'Remote path is required and must not contain control characters.';
    }
    if (!normalized.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(normalized)) {
        return 'Enter an absolute remote path.';
    }
    return undefined;
}

function tags(value: string): string[] {
    return value.split(',').map(clean).filter(Boolean);
}

function machineSummary(machine: ManagedSshMachine): string {
    const host = machine.connection.host.includes(':')
        ? `[${machine.connection.host}]` : machine.connection.host;
    return `${machine.connection.user}@${host}:${machine.connection.port}`;
}

interface MachineDraft {
    name: string;
    host: string;
    user: string;
    port: string;
}

export class ManagedRemotePromptController implements ManagedRemoteManagementPrompts {
    constructor(private readonly ui: ManagedRemoteWizardUi) {
    }

    addMachine(): Promise<AddManagedMachineInput | undefined> {
        return this.machineWizard({ name: '', host: '', user: '', port: '22' });
    }

    async editMachine(
        machine: ManagedSshMachine,
        affectedProjectCount: number,
    ): Promise<EditManagedMachineInput | undefined> {
        const result = await this.machineWizard({
            name: machine.name,
            host: machine.connection.host,
            user: machine.connection.user,
            port: String(machine.connection.port),
        }, {
            previous: machine,
            affectedProjectCount,
        });
        return result ? {
            name: result.name,
            host: result.host,
            user: result.user,
            port: result.port,
        } : undefined;
    }

    confirmRemoveMachine(machine: ManagedSshMachine): Promise<boolean> {
        return this.ui.confirm(
            `Remove ${machine.name} (${machineSummary(machine)})? This does not delete remote files.`,
            'Remove Machine',
        );
    }

    async chooseMachineForProject(
        machines: ManagedSshMachine[],
    ): Promise<ManagedSshMachine | undefined> {
        const result = await this.ui.pick({
            title: 'Add Project — Choose a Machine',
            step: 1,
            totalSteps: 1,
            canGoBack: false,
            items: machines.map(machine => ({
                label: machine.name,
                description: machineSummary(machine),
                value: machine,
            })),
        });
        return result.action === 'accept' ? result.value : undefined;
    }

    async addProject(
        machine: ManagedSshMachine,
        environments: ManagedEnvironment[],
    ): Promise<AddManagedProjectInput | undefined> {
        if (!environments.length) { throw new Error('Managed Machine has no Environment.'); }
        let step = 0;
        let environment = environments.find(value => value.kind === 'host') || environments[0];
        const draft = { name: '', path: '', description: '', tags: '', color: '', favorite: false };
        while (step < 7) {
            let result: ManagedRemoteWizardResult<unknown>;
            if (step === 0) {
                result = await this.ui.pick({
                    title: `Add Project to ${machine.name}`,
                    step: 1,
                    totalSteps: 7,
                    canGoBack: true,
                    selected: environment.id,
                    items: environments.map(value => ({
                        label: value.name,
                        description: value.kind === 'host' ? 'Host' : 'Dev Container',
                        value: value.id,
                    })),
                });
                if (result.action === 'accept') {
                    const environmentId = result.value;
                    environment = environments.find(value => value.id === environmentId) || environment;
                }
            } else if (step <= 5) {
                const fields = [
                    { key: 'name', prompt: 'Project name', validate: (value: string) => validText(value, 'Project name') },
                    { key: 'path', prompt: 'Absolute path in this Environment', validate: validRemotePath },
                    { key: 'description', prompt: 'Description (optional)', validate: () => undefined },
                    { key: 'tags', prompt: 'Tags separated by commas (optional)', validate: () => undefined },
                    { key: 'color', prompt: 'Color, for example #ef4444 (optional)', validate: () => undefined },
                ];
                const field = fields[step - 1];
                result = await this.ui.input({
                    title: `Add Project to ${machine.name}`,
                    step: step + 1,
                    totalSteps: 7,
                    prompt: field.prompt,
                    value: String(draft[field.key as keyof typeof draft] || ''),
                    validate: field.validate,
                });
                if (result.action === 'accept') {
                    (draft as Record<string, string | boolean>)[field.key] = result.value as string;
                }
            } else {
                result = await this.ui.pick({
                    title: 'Review Project — Saved to your VS Code User settings',
                    step: 7,
                    totalSteps: 7,
                    canGoBack: true,
                    items: [
                        { label: 'Save Project', description: `${machine.name} › ${environment.name} › ${draft.name}`, detail: draft.path, value: 'save' },
                        { label: draft.favorite ? 'Remove Favorite' : 'Add to Favorites', value: 'toggleFavorite' },
                    ],
                });
                if (result.action === 'accept' && result.value === 'toggleFavorite') {
                    draft.favorite = !draft.favorite;
                    continue;
                }
                if (result.action === 'accept' && result.value === 'save') {
                    return {
                        environmentId: environment.id,
                        name: clean(draft.name),
                        remotePath: clean(draft.path),
                        ...(clean(draft.description) ? { description: clean(draft.description) } : {}),
                        ...(clean(draft.tags) ? { tags: tags(draft.tags) } : {}),
                        ...(clean(draft.color) ? { color: clean(draft.color) } : {}),
                        favorite: draft.favorite,
                    };
                }
            }
            if (result.action === 'cancel') { return undefined; }
            step = result.action === 'back' ? Math.max(0, step - 1) : step + 1;
        }
        return undefined;
    }

    async editProject(project: ManagedRemoteProject): Promise<EditManagedProjectInput | undefined> {
        const values = [
            project.name,
            project.remotePath,
            project.description || '',
            (project.tags || []).join(', '),
            project.color || '',
        ];
        const prompts = [
            ['Project name', (value: string) => validText(value, 'Project name')],
            ['Absolute path in the current Environment', validRemotePath],
            ['Description (optional)', () => undefined],
            ['Tags separated by commas (optional)', () => undefined],
            ['Color, for example #ef4444 (optional)', () => undefined],
        ] as Array<[string, (value: string) => string | undefined]>;
        let step = 0;
        while (step < 6) {
            if (step < 5) {
                const result = await this.ui.input({
                    title: `Edit Project — ${project.name}`,
                    step: step + 1,
                    totalSteps: 6,
                    prompt: prompts[step][0],
                    value: values[step],
                    validate: prompts[step][1],
                });
                if (result.action === 'cancel') { return undefined; }
                if (result.action === 'back') { step = Math.max(0, step - 1); continue; }
                values[step] = result.value;
                step += 1;
                continue;
            }
            const review = await this.ui.pick({
                title: 'Review Project changes',
                step: 6,
                totalSteps: 6,
                canGoBack: true,
                items: [{ label: 'Save Project', description: values[0], detail: values[1], value: true }],
            });
            if (review.action === 'cancel') { return undefined; }
            if (review.action === 'back') { step -= 1; continue; }
            return {
                name: clean(values[0]),
                remotePath: clean(values[1]),
                description: clean(values[2]) || null,
                tags: clean(values[3]) ? tags(values[3]) : null,
                color: clean(values[4]) || null,
            };
        }
        return undefined;
    }

    confirmRemoveProject(project: ManagedRemoteProject): Promise<boolean> {
        return this.ui.confirm(
            `Remove ${project.name} from Agent Pivot? This does not delete remote files.`,
            'Remove Project',
        );
    }

    async resolveMachineConflict(
        _machineId: string,
        candidates: ManagedSshMachine[],
    ): Promise<ManagedSshMachine | undefined> {
        const result = await this.ui.pick({
            title: 'Review Connection Conflict',
            step: 1,
            totalSteps: 1,
            canGoBack: false,
            items: candidates.map(candidate => ({
                label: `Use ${candidate.name}`,
                description: machineSummary(candidate),
                detail: 'Changes the next connection on every synced computer.',
                value: candidate,
            })),
        });
        return result.action === 'accept' ? result.value : undefined;
    }

    confirmBeginMigration(): Promise<boolean> {
        return this.ui.confirm(
            'Review existing Projects and build a Managed Remote migration preview?',
            'Review Migration',
        );
    }

    private async machineWizard(
        draft: MachineDraft,
        edit?: { previous: ManagedSshMachine; affectedProjectCount: number },
    ): Promise<AddManagedMachineInput | undefined> {
        const fields = [
            { key: 'name', prompt: 'Machine name', validate: (value: string) => validText(value, 'Machine name') },
            { key: 'host', prompt: 'DNS name or IP address', validate: (value: string) => validText(value, 'Host') },
            { key: 'user', prompt: 'SSH user', validate: (value: string) => validText(value, 'User') },
            { key: 'port', prompt: 'SSH port', validate: validPort },
        ];
        let step = 0;
        while (step < 5) {
            if (step < fields.length) {
                const field = fields[step];
                const result = await this.ui.input({
                    title: edit ? 'Edit Machine' : 'Add Machine',
                    step: step + 1,
                    totalSteps: 5,
                    prompt: field.prompt,
                    value: draft[field.key as keyof MachineDraft],
                    validate: field.validate,
                });
                if (result.action === 'cancel') { return undefined; }
                if (result.action === 'back') { step = Math.max(0, step - 1); continue; }
                draft[field.key as keyof MachineDraft] = result.value;
                step += 1;
                continue;
            }
            const candidate: ManagedSshMachine = {
                id: edit?.previous.id || 'new-machine',
                name: clean(draft.name),
                connection: {
                    kind: 'ssh',
                    host: clean(draft.host),
                    user: clean(draft.user),
                    port: Number(clean(draft.port)),
                },
            };
            if (!isManagedMachine(candidate)) {
                step = 0;
                continue;
            }
            const oldEndpoint = edit ? machineSummary(edit.previous) : '';
            const review = await this.ui.pick({
                title: edit
                    ? 'Review — Changes all synced computers'
                    : 'Review — Saved to your VS Code User settings',
                step: 5,
                totalSteps: 5,
                canGoBack: true,
                items: [{
                    label: edit ? 'Save Changes to All Computers' : 'Save Machine',
                    description: machineSummary(candidate),
                    detail: edit
                        ? `${oldEndpoint} → ${machineSummary(candidate)} · ${edit.affectedProjectCount} affected Project${edit.affectedProjectCount === 1 ? '' : 's'}`
                        : 'Passwords and keys are not saved.',
                    value: true,
                }],
            });
            if (review.action === 'cancel') { return undefined; }
            if (review.action === 'back') { step -= 1; continue; }
            return {
                name: candidate.name,
                host: candidate.connection.host,
                user: candidate.connection.user,
                port: candidate.connection.port,
            };
        }
        return undefined;
    }
}

export class VscodeManagedRemoteWizardUi implements ManagedRemoteWizardUi {
    constructor(private readonly window: typeof vscode.window) {
    }

    input(options: ManagedRemoteWizardInput): Promise<ManagedRemoteWizardResult<string>> {
        const input = this.window.createInputBox();
        input.title = options.title;
        input.step = options.step;
        input.totalSteps = options.totalSteps;
        input.prompt = options.prompt;
        input.value = options.value || '';
        input.password = options.password === true;
        input.ignoreFocusOut = true;
        input.buttons = options.step > 1 ? [vscode.QuickInputButtons.Back] : [];
        return new Promise(resolve => {
            let settled = false;
            const disposables: vscode.Disposable[] = [];
            const finish = (result: ManagedRemoteWizardResult<string>) => {
                if (settled) { return; }
                settled = true;
                resolve(result);
                input.hide();
                disposables.forEach(disposable => disposable.dispose());
                input.dispose();
            };
            disposables.push(input.onDidAccept(() => {
                const error = options.validate(input.value);
                input.validationMessage = error;
                if (!error) { finish({ action: 'accept', value: input.value }); }
            }));
            disposables.push(input.onDidTriggerButton(button => {
                if (button === vscode.QuickInputButtons.Back) { finish({ action: 'back' }); }
            }));
            disposables.push(input.onDidHide(() => finish({ action: 'cancel' })));
            input.show();
        });
    }

    pick<T>(options: ManagedRemoteWizardPick<T>): Promise<ManagedRemoteWizardResult<T>> {
        const picker = this.window.createQuickPick<vscode.QuickPickItem & { value: T }>();
        picker.title = options.title;
        picker.step = options.step;
        picker.totalSteps = options.totalSteps;
        picker.ignoreFocusOut = true;
        picker.items = options.items;
        picker.buttons = options.canGoBack ? [vscode.QuickInputButtons.Back] : [];
        const selected = options.items.find(item => item.value === options.selected);
        if (selected) { picker.activeItems = [selected]; }
        return new Promise(resolve => {
            let settled = false;
            const disposables: vscode.Disposable[] = [];
            const finish = (result: ManagedRemoteWizardResult<T>) => {
                if (settled) { return; }
                settled = true;
                resolve(result);
                picker.hide();
                disposables.forEach(disposable => disposable.dispose());
                picker.dispose();
            };
            disposables.push(picker.onDidAccept(() => {
                if (picker.selectedItems[0]) {
                    finish({ action: 'accept', value: picker.selectedItems[0].value });
                }
            }));
            disposables.push(picker.onDidTriggerButton(button => {
                if (button === vscode.QuickInputButtons.Back) { finish({ action: 'back' }); }
            }));
            disposables.push(picker.onDidHide(() => finish({ action: 'cancel' })));
            picker.show();
        });
    }

    async confirm(message: string, action: string): Promise<boolean> {
        return await this.window.showWarningMessage(
            message,
            { modal: true },
            action,
        ) === action;
    }
}
