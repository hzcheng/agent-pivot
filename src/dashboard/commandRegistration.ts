'use strict';

export interface DisposableLike {
    dispose(): unknown;
}

export interface DashboardCommandHandlers {
    open: () => unknown;
    addProject: () => unknown;
    saveProject: () => unknown;
    removeProject: () => unknown;
    editProjects: () => unknown;
    addGroup: () => unknown;
    removeGroup: () => unknown;
    addProjectsFromFolder: () => unknown;
    addFileToActiveTerminal: () => unknown;
    insertPromptToActiveTerminal: () => unknown;
}

export interface DashboardCommandRegistrationOptions<TDisposable extends DisposableLike = DisposableLike> {
    registerCommand: (command: string, callback: () => unknown) => TDisposable;
    pushSubscription: (disposable: TDisposable) => void;
    handlers: DashboardCommandHandlers;
}

export class DashboardCommandRegistration<TDisposable extends DisposableLike = DisposableLike> {
    constructor(private readonly options: DashboardCommandRegistrationOptions<TDisposable>) {
    }

    register(): void {
        this.registerCommand('agentPivot.open', this.options.handlers.open);
        this.registerCommand('agentPivot.addProject', this.options.handlers.addProject);
        this.registerCommand('agentPivot.saveProject', this.options.handlers.saveProject);
        this.registerCommand('agentPivot.removeProject', this.options.handlers.removeProject);
        this.registerCommand('agentPivot.editProjects', this.options.handlers.editProjects);
        this.registerCommand('agentPivot.addGroup', this.options.handlers.addGroup);
        this.registerCommand('agentPivot.removeGroup', this.options.handlers.removeGroup);
        this.registerCommand('agentPivot.addProjectsFromFolder', this.options.handlers.addProjectsFromFolder);
        this.registerCommand('agentPivot.addFileToActiveTerminal', this.options.handlers.addFileToActiveTerminal);
        this.registerCommand('agentPivot.insertPromptToActiveTerminal', this.options.handlers.insertPromptToActiveTerminal);
    }

    private registerCommand(command: string, callback: () => unknown): void {
        this.options.pushSubscription(this.options.registerCommand(command, callback));
    }
}
