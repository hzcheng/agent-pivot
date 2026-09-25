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

export interface ManagedRemotePromptConnections {
    listAliases?(): Promise<string[]>;
    inspect(alias: string): Promise<unknown>;
    browse(machineId: string, directoryId?: string, path?: string): Promise<import('./bridgeProtocol').FileTransferLocalRootResponse>;
}

export class ManagedRemotePromptController implements ManagedRemoteManagementPrompts {
    constructor(
        private readonly ui: ManagedRemoteWizardUi,
        private readonly connections?: ManagedRemotePromptConnections,
    ) {
    }

    addMachine(): Promise<AddManagedMachineInput | undefined> {
        return this.machineWizard({ name: '', host: '', user: '', port: '22' });
    }

    async adoptCurrentSshProject(
        project: Omit<AddManagedProjectInput, 'environmentId'> & { sshAlias: string },
    ): Promise<AddManagedMachineInput | undefined> {
        if (this.connections) {
            return this.importAlias(project.sshAlias, project);
        }
        return this.machineWizard({
            name: project.sshAlias,
            host: '',
            user: '',
            port: '22',
        }, {
            adoptedProject: project,
        });
    }

    async importMachine(): Promise<AddManagedMachineInput | undefined> {
        // Enumeration is a convenience: unreadable Includes must not prevent manual import.
        let aliases: string[] = [];
        try { aliases = await this.connections?.listAliases?.() || []; } catch { /* manual fallback */ }
        aliases = Array.from(new Set(aliases.filter(value => /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value)))).sort();
        if (aliases.length) {
            const selected = await this.ui.pick({
                title: 'Import SSH connection', step: 1, totalSteps: 2, canGoBack: false,
                items: [
                    ...aliases.map(alias => ({ label: alias, description: 'This computer’s SSH configuration', value: alias })),
                    { label: 'Enter SSH alias manually…', value: '' },
                ],
            });
            if (selected.action !== 'accept') { return undefined; }
            if (selected.value) { return this.importAlias(selected.value); }
        }
        const alias = await this.ui.input({
            title: 'Import SSH connection', step: 1, totalSteps: 2,
            prompt: 'SSH alias you already use, for example infra-home-linux',
            validate: value => /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value.trim())
                ? undefined : 'Enter an SSH host alias, not a command.',
        });
        return alias.action === 'accept' ? this.importAlias(alias.value.trim()) : undefined;
    }

    private async importAlias(
        alias: string,
        project?: Omit<AddManagedProjectInput, 'environmentId'>,
    ): Promise<AddManagedMachineInput | undefined> {
        const inspected = await this.connections?.inspect(alias) as {
            status?: string; reason?: string; configurationMatched?: boolean;
            route?: { kind: string; jumpHosts?: string };
            endpoint?: { host: string; user: string; port: number };
        } | undefined;
        const endpoint = inspected?.endpoint;
        if (inspected?.status === 'unsupported' || (!project && inspected?.configurationMatched === false) || !endpoint || !isManagedMachine({
            id: 'import', name: alias, connection: { kind: 'ssh', ...endpoint, sshConfigAlias: alias },
        })) {
            throw new Error(inspected?.reason || 'Could not read this SSH alias. Check the SSH configuration on this computer.');
        }
        const route = inspected?.route?.kind === 'jump' ? `Via ${inspected.route.jumpHosts}`
            : inspected?.route?.kind === 'command' ? 'Via your local ProxyCommand'
                : inspected?.route?.kind === 'direct' ? 'Direct connection' : 'Uses local SSH routing';
        const review = await this.ui.pick({
            title: project ? 'Save current Machine and Project' : 'Save SSH connection',
            step: 2, totalSteps: 2, canGoBack: false,
            items: [{
                label: project ? 'Save Machine and Project' : `Save ${alias}`,
                description: `${alias} · ${endpoint.user}@${endpoint.host}:${endpoint.port}`,
                detail: `${project ? project.remotePath + ' · ' : ''}${route}. Machine name: ${alias}. References this computer’s SSH config; connection not tested. Other computers need the same alias. Keys and commands are not synced.`,
                value: 'save',
            }],
        });
        return review.action === 'accept' ? { name: alias, ...endpoint, sshConfigAlias: alias, sourceSshAliases: [alias] } : undefined;
    }

    private async browseProject(
        machine: ManagedSshMachine,
        environments: ManagedEnvironment[],
    ): Promise<AddManagedProjectInput | undefined> {
        let environment = environments.find(value => value.kind === 'host') || environments[0];
        if (environments.length > 1) {
            const selected = await this.ui.pick({
                title: `Add Project to ${machine.name}`, step: 1, totalSteps: 2, canGoBack: false,
                items: environments.map(value => ({ label: value.name, value })),
            });
            if (selected.action !== 'accept') { return undefined; }
            environment = selected.value;
        }
        let remotePath: string | undefined;
        let directoryId: string | undefined;
        let navigationPath: string | undefined;
        while (!remotePath && environment.kind === 'host') {
            let listing: import('./bridgeProtocol').FileTransferLocalRootResponse;
            try {
                listing = await this.connections!.browse(machine.id, directoryId, navigationPath);
            } catch (error) {
                const choice = await this.ui.pick({
                    title: `Could not browse ${machine.name}`, step: 1, totalSteps: 2, canGoBack: false,
                    items: [
                        { label: 'Retry connection', detail: `${error instanceof Error ? error.message : 'Connection failed.'} Browsing needs noninteractive SSH authentication. For password/MFA, connect in VS Code, open a folder, then Save current.`, value: 'retry' },
                        { label: 'Enter folder path manually', value: 'manual' },
                    ],
                });
                if (choice.action !== 'accept') { return undefined; }
                if (choice.value === 'retry') { continue; }
                break;
            }
            const choice = await this.ui.pick({
                title: `${machine.name} · ${listing.displayPath}`, step: 1, totalSteps: 2, canGoBack: false,
                items: [
                    { label: 'Save this folder as a Project', description: listing.displayPath, value: 'save' },
                    { label: 'Enter folder path…', value: 'path' },
                    ...(listing.displayPath !== '/' ? [{ label: '..', description: 'Parent folder', value: 'parent' }] : []),
                    ...listing.entries.filter(entry => entry.kind === 'directory')
                        .map(entry => ({ label: entry.name, description: 'Folder', value: entry.id })),
                    ...(listing.hasMore ? [{ label: 'More folders — enter a path…', value: 'path' }] : []),
                ],
            });
            if (choice.action !== 'accept') { return undefined; }
            if (choice.value === 'save') { remotePath = listing.displayPath; break; }
            if (choice.value === 'path') {
                const pathInput = await this.ui.input({
                    title: `Browse ${machine.name}`, step: 1, totalSteps: 2,
                    prompt: 'Absolute remote folder path', value: listing.displayPath, validate: validRemotePath,
                });
                if (pathInput.action !== 'accept') { return undefined; }
                navigationPath = pathInput.value.trim(); directoryId = undefined;
            } else if (choice.value === 'parent') {
                navigationPath = listing.displayPath.replace(/\/[^/]+\/?$/u, '') || '/'; directoryId = undefined;
            } else { directoryId = choice.value; navigationPath = undefined; }
        }
        if (!remotePath) {
            const pathInput = await this.ui.input({
                title: `Add Project to ${machine.name}`, step: 1, totalSteps: 2,
                prompt: 'Absolute folder path in this Environment', validate: validRemotePath,
            });
            if (pathInput.action !== 'accept') { return undefined; }
            remotePath = pathInput.value.trim();
        }
        const name = await this.ui.input({
            title: 'Save Project — files stay on the remote Machine', step: 2, totalSteps: 2,
            prompt: 'Project name. The Machine and folder shortcut are saved to your sync settings.',
            value: remotePath.split('/').filter(Boolean).pop() || machine.name,
            validate: value => validText(value, 'Project name'),
        });
        return name.action === 'accept' ? { environmentId: environment.id, name: name.value.trim(), remotePath } : undefined;
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

    confirmRemoveMachine(machine: ManagedSshMachine, counts = { projectCount: 0, environmentCount: 0 }): Promise<boolean> {
        return this.ui.confirm(
            `Remove ${machine.name} (${machineSummary(machine)}) and ${counts.projectCount} saved Project${counts.projectCount === 1 ? '' : 's'} across ${counts.environmentCount} Environment${counts.environmentCount === 1 ? '' : 's'}? This removes catalog records on all synced computers. Remote files, containers, and SSH configuration are not deleted.`,
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
        if (this.connections) { return this.browseProject(machine, environments); }
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

    async resolveProjectConflict(
        _projectId: string,
        candidates: Array<ManagedRemoteProject | null>,
        environmentNames?: Record<string, string>,
        allowOrphanRemoval = false,
    ): Promise<ManagedRemoteProject | null | undefined> {
        const parentExists = (id: string) => environmentNames === undefined || typeof environmentNames[id] === 'string';
        const parentRemoved = candidates.some(candidate => candidate && !parentExists(candidate.environmentId));
        const choices = candidates.filter(candidate => candidate === null || parentExists(candidate.environmentId));
        if (allowOrphanRemoval && !choices.includes(null)) { choices.push(null); }
        if (!choices.length) { throw new Error('The parent Environment was removed. Restore it before keeping this Project.'); }
        const result = await this.ui.pick({
            title: 'Resolve Project sync conflict', step: 1, totalSteps: 1, canGoBack: false,
            items: choices.map(candidate => candidate ? {
                label: `Keep ${candidate.name}`,
                description: `${candidate.remotePath} · ${environmentNames?.[candidate.environmentId] || 'Environment'}`,
                detail: [candidate.description, candidate.tags?.length ? `Tags: ${candidate.tags.join(', ')}` : '',
                    `Favorite: ${candidate.favorite ? 'yes' : 'no'}`, candidate.color ? `Color: ${candidate.color}` : '',
                    'Applies to all synced computers.'].filter(Boolean).join(' · '),
                value: candidate,
            } : {
                label: allowOrphanRemoval && !candidates.includes(null) ? 'Remove orphan Project record' : 'Keep deletion', description: 'Remove the saved Project record',
                detail: `${parentRemoved ? 'The parent Environment was removed. Keep the deletion or cancel. ' : ''}Applies to all synced computers. Remote files are not deleted.`, value: null,
            }),
        });
        return result.action === 'accept' ? result.value : undefined;
    }

    async resolveEnvironmentConflict(
        _environmentId: string,
        candidates: Array<ManagedEnvironment | null>,
        projectCount: number,
        machineNames?: Record<string, string>,
        allowOrphanRemoval = false,
    ): Promise<ManagedEnvironment | null | undefined> {
        const parentExists = (id: string) => machineNames === undefined || typeof machineNames[id] === 'string';
        const hasHost = candidates.some(value => value?.kind === 'host' && parentExists(value.machineId));
        const parentRemoved = candidates.some(value => value && !parentExists(value.machineId));
        const choices = candidates.filter(value => value === null ? !hasHost : parentExists(value.machineId));
        if (allowOrphanRemoval && !choices.includes(null)) { choices.push(null); }
        if (!choices.length) { throw new Error('The parent Machine was removed. Restore it before keeping this Environment.'); }
        const result = await this.ui.pick({
            title: 'Resolve Environment sync conflict', step: 1, totalSteps: 1, canGoBack: false,
            items: choices.map(candidate => candidate ? {
                label: `Keep ${candidate.name}`, description: `${candidate.kind === 'host' ? 'Host' : 'Dev Container'} · ${machineNames?.[candidate.machineId] || 'Machine'}`,
                detail: `${candidate.devContainerAnchor?.sourceLocator || 'Host Environment'} · Applies to all synced computers.${hasHost ? ' To remove the Host, remove its Machine.' : ''}`,
                value: candidate,
            } : {
                label: allowOrphanRemoval && !candidates.includes(null) ? 'Remove orphan Environment record' : 'Keep deletion', description: `Remove this Environment and ${projectCount} saved Project records`,
                detail: `${parentRemoved ? 'The parent Machine was removed. Keep the deletion or cancel. ' : ''}Applies to all synced computers. Remote files and containers are not deleted.`, value: null,
            }),
        });
        return result.action === 'accept' ? result.value : undefined;
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

    private async machineWizard(
        draft: MachineDraft,
        mode?: {
            previous?: ManagedSshMachine;
            affectedProjectCount?: number;
            adoptedProject?: Omit<AddManagedProjectInput, 'environmentId'> & { sshAlias: string };
        },
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
                    title: mode?.previous ? 'Edit Machine' : mode?.adoptedProject
                        ? 'Save Current Project — Add Machine' : 'Add Machine',
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
                id: mode?.previous?.id || 'new-machine',
                name: clean(draft.name),
                connection: {
                    kind: 'ssh',
                    host: clean(draft.host),
                    user: clean(draft.user),
                    port: Number(clean(draft.port)),
                ...(mode?.previous?.connection.proxyJump ? { proxyJump: mode.previous.connection.proxyJump } : {}),
                ...(mode?.previous?.connection.sshConfigAlias ? { sshConfigAlias: mode.previous.connection.sshConfigAlias } : {}),
                },
            };
            if (!isManagedMachine(candidate)) {
                step = 0;
                continue;
            }
            const oldEndpoint = mode?.previous ? machineSummary(mode.previous) : '';
            const adoptedProject = mode?.adoptedProject;
            const review = await this.ui.pick({
                title: mode?.previous
                    ? 'Review — Changes all synced computers'
                    : adoptedProject
                        ? 'Review — Save Current Project'
                    : 'Review — Saved to your VS Code User settings',
                step: 5,
                totalSteps: 5,
                canGoBack: true,
                items: [{
                    label: mode?.previous ? 'Save Changes to All Computers'
                        : adoptedProject ? 'Save Machine and Project' : 'Save Machine',
                    description: machineSummary(candidate),
                    detail: mode?.previous
                        ? `${oldEndpoint} → ${machineSummary(candidate)} · ${mode.affectedProjectCount} affected Project${mode.affectedProjectCount === 1 ? '' : 's'}`
                        : adoptedProject
                            ? `Current SSH target: ${adoptedProject.sshAlias} · Project: ${adoptedProject.remotePath}`
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
