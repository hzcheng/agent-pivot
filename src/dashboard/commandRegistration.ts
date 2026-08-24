'use strict';

export interface DisposableLike {
    dispose(): unknown;
}

type DashboardCommandHandler = (...args: unknown[]) => unknown;

export interface DashboardCommandHandlers {
    open: DashboardCommandHandler;
    addProject: DashboardCommandHandler;
    saveProject: DashboardCommandHandler;
    removeProject: DashboardCommandHandler;
    editProjects: DashboardCommandHandler;
    addGroup: DashboardCommandHandler;
    removeGroup: DashboardCommandHandler;
    addProjectsFromFolder: DashboardCommandHandler;
    addFileToActiveTerminal: DashboardCommandHandler;
    insertPromptToActiveTerminal: DashboardCommandHandler;
    migrateSkillsToCentral: DashboardCommandHandler;
    changeGlobalSkillsLocation: DashboardCommandHandler;
    openCurrentAiSessionConversation: DashboardCommandHandler;
    seekLatestConversationInteraction: DashboardCommandHandler;
    previousActiveSession: DashboardCommandHandler;
    nextActiveSession: DashboardCommandHandler;
    nextAttentionSession: DashboardCommandHandler;
    nextRunningSession: DashboardCommandHandler;
    nextActiveChatInWindow: DashboardCommandHandler;
    nextAttentionChatInWindow: DashboardCommandHandler;
    switchToAiSession: DashboardCommandHandler;
    switchWorktreeOrSession: DashboardCommandHandler;
    toggleLastAiSession: DashboardCommandHandler;
    switchToOpenWindow: DashboardCommandHandler;
}

export interface DashboardCommandRegistrationOptions<TDisposable extends DisposableLike = DisposableLike> {
    registerCommand: (
        command: string,
        callback: (...args: unknown[]) => unknown,
    ) => TDisposable;
    pushSubscription: (disposable: TDisposable) => void;
    openWhileUnavailable: DashboardCommandHandler;
}

type DashboardCommandName = keyof DashboardCommandHandlers;

const DASHBOARD_COMMANDS: ReadonlyArray<readonly [string, DashboardCommandName]> = [
    ['agentPivot.open', 'open'],
    ['agentPivot.addProject', 'addProject'],
    ['agentPivot.saveProject', 'saveProject'],
    ['agentPivot.removeProject', 'removeProject'],
    ['agentPivot.editProjects', 'editProjects'],
    ['agentPivot.addGroup', 'addGroup'],
    ['agentPivot.removeGroup', 'removeGroup'],
    ['agentPivot.addProjectsFromFolder', 'addProjectsFromFolder'],
    ['agentPivot.addFileToActiveTerminal', 'addFileToActiveTerminal'],
    ['agentPivot.insertPromptToActiveTerminal', 'insertPromptToActiveTerminal'],
    ['agentPivot.migrateSkillsToCentral', 'migrateSkillsToCentral'],
    ['agentPivot.changeGlobalSkillsLocation', 'changeGlobalSkillsLocation'],
    ['agentPivot.openCurrentAiSessionConversation', 'openCurrentAiSessionConversation'],
    ['agentPivot.seekLatestConversationInteraction', 'seekLatestConversationInteraction'],
    ['agentPivot.previousActiveSession', 'previousActiveSession'],
    ['agentPivot.nextActiveSession', 'nextActiveSession'],
    ['agentPivot.nextAttentionSession', 'nextAttentionSession'],
    ['agentPivot.nextRunningSession', 'nextRunningSession'],
    ['agentPivot.nextActiveChatInWindow', 'nextActiveChatInWindow'],
    ['agentPivot.nextAttentionChatInWindow', 'nextAttentionChatInWindow'],
    ['agentPivot.switchToAiSession', 'switchToAiSession'],
    ['agentPivot.switchWorktreeOrSession', 'switchWorktreeOrSession'],
    ['agentPivot.toggleLastAiSession', 'toggleLastAiSession'],
    ['agentPivot.switchToOpenWindow', 'switchToOpenWindow'],
];

interface DashboardCommandGeneration {
    generation: number;
    handlers: DashboardCommandHandlers;
}

export class DashboardCommandRegistration<TDisposable extends DisposableLike = DisposableLike>
implements DisposableLike {
    private active?: DashboardCommandGeneration;
    private staged?: DashboardCommandGeneration;
    private openWhileUnavailable?: DashboardCommandHandler;
    private registered = false;
    private disposed = false;

    constructor(
        private readonly options: DashboardCommandRegistrationOptions<TDisposable>,
    ) {
        this.openWhileUnavailable = options.openWhileUnavailable;
    }

    register(): void {
        if (this.registered || this.disposed) {
            return;
        }
        this.registered = true;
        for (const [command, name] of DASHBOARD_COMMANDS) {
            this.registerCommand(command, name);
        }
    }

    stage(generation: number, handlers: DashboardCommandHandlers): boolean {
        if (this.disposed
            || !Number.isSafeInteger(generation)
            || generation <= 0
            || generation <= (this.active?.generation || 0)
            || generation < (this.staged?.generation || 0)) {
            return false;
        }

        this.staged = { generation, handlers };
        return true;
    }

    activate(generation: number): boolean {
        if (this.disposed || this.staged?.generation !== generation) {
            return false;
        }

        this.active = this.staged;
        this.staged = undefined;
        return true;
    }

    discard(generation: number): void {
        if (this.staged?.generation === generation) {
            this.staged = undefined;
        }
        if (this.active?.generation === generation) {
            this.active = undefined;
        }
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.active = undefined;
        this.staged = undefined;
        this.openWhileUnavailable = undefined;
    }

    private registerCommand(command: string, name: DashboardCommandName): void {
        const callback = (...args: unknown[]) => this.invoke(command, name, args);
        this.options.pushSubscription(this.options.registerCommand(command, callback));
    }

    private invoke(
        command: string,
        name: DashboardCommandName,
        args: unknown[],
    ): unknown {
        const handler = this.active?.handlers[name]
            || (!this.disposed && name === 'open' ? this.openWhileUnavailable : undefined);
        if (handler) {
            return handler(...args);
        }
        return Promise.reject(new Error(
            this.disposed
                ? 'Agent Pivot is not available.'
                : `Agent Pivot is still starting. Open the dashboard and try ${command} again.`,
        ));
    }
}
