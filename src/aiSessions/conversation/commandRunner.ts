'use strict';

/** The small Terminal surface needed by the conversation command runner. */
export interface ConversationCommandTerminal {
    sendText(text: string, addNewLine?: boolean): unknown;
    show(preserveFocus?: boolean): void;
}

export interface ConversationCommandRunnerInput {
    key: string;
    cwd: string;
    command: string;
}

export interface ConversationCommandLocation {
    key: string;
    cwd: string;
}

export interface ConversationCommandLocationInput {
    workspaceScopeIdentity: string | undefined;
    activeWorktreePath: string | undefined;
    historyWorktreePath: string | undefined;
    historyCwd: string | undefined;
    historyWorkDir: string | undefined;
    runtime?: {
        state: string;
        workspaceScopeIdentity: string;
        worktreePath: string | undefined;
        cwd: string;
    };
}

/**
 * Finds the directory from the current target's persisted identity first.
 * A conflicting runtime is intentionally never trusted as a fallback.
 */
export function resolveConversationCommandLocation(
    input: ConversationCommandLocationInput
): ConversationCommandLocation | undefined {
    const live = input.runtime?.state !== 'conflict'
        && input.runtime?.workspaceScopeIdentity === input.workspaceScopeIdentity
        ? input.runtime
        : undefined;
    const worktreePath = input.activeWorktreePath || input.historyWorktreePath
        || live?.worktreePath;
    const cwd = worktreePath || input.historyCwd || input.historyWorkDir
        || live?.cwd;
    return cwd ? { key: worktreePath || cwd, cwd } : undefined;
}

/**
 * Reuses one terminal per trusted working-directory key. A failed send is not
 * retained: the next explicit command can create a fresh runner instead.
 */
export class ConversationCommandRunner<TTerminal extends ConversationCommandTerminal> {
    private readonly terminals = new Map<string, TTerminal>();

    constructor(
        private readonly createTerminal: (cwd: string) => TTerminal
    ) {}

    run(input: ConversationCommandRunnerInput): TTerminal {
        let terminal = this.terminals.get(input.key);
        if (!terminal) {
            terminal = this.createTerminal(input.cwd);
            this.terminals.set(input.key, terminal);
        }
        try {
            terminal.sendText(input.command, true);
            terminal.show();
            return terminal;
        } catch (error) {
            if (this.terminals.get(input.key) === terminal) {
                this.terminals.delete(input.key);
            }
            throw error;
        }
    }

    forget(terminal: TTerminal): void {
        for (const [key, candidate] of this.terminals) {
            if (candidate === terminal) {
                this.terminals.delete(key);
            }
        }
    }
}
