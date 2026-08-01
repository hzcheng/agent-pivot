'use strict';

import type * as vscode from 'vscode';
import type { DashboardMessageHandler } from '../dashboard/messageRouter';
import type { DashboardWorkspaceSearchCatalog } from '../webview/dashboardViewModel';
import { TodoCommandController } from './commandController';
import {
    deleteTodoWithConfirmation,
    renameTodoGroupWithPrompt,
    runTodoMutation,
    runTodoPromptMutation,
    runTodoRequestMutation,
} from './hostMutation';
import type { TodoService } from './service';
import { UnsupportedTodoDataVersionError } from './types';
import { buildTodoPanelSnapshot, buildTodoViewModel } from './viewModel';
import { getTodoPanelContent, getUnsupportedTodoVersionPanelContent } from './webviewContent';

export interface TodoPanelCapabilityOptions {
    provider: {
        postMessage: (message: unknown) => Thenable<unknown>;
    };
    todoService: TodoService;
    /** Builds the full workspace search catalog (projects, workspaces, todos, skills). */
    getSearchCatalog: () => DashboardWorkspaceSearchCatalog;
    getConfiguration: () => vscode.WorkspaceConfiguration;
    showInputBox: (options: vscode.InputBoxOptions) => Thenable<string | undefined>;
    showWarningMessage: (
        message: string,
        options: vscode.MessageOptions,
        ...items: string[]
    ) => Thenable<string | undefined>;
    showErrorMessage: (message: string) => Thenable<string | undefined>;
    logError: (message: string, error: unknown) => void;
}

export interface TodoPanelCapability {
    /** Dashboard message handlers, spread into the dashboard message router. */
    handlers: Record<string, DashboardMessageHandler>;
    /** Gates the first TODO render on the in-flight storage migration. */
    setStorageMigrationReady: (ready: Promise<unknown>) => void;
    dispose: () => void;
}

/**
 * Owns the TODO panel slice of the dashboard: the view state, the temporary
 * reveal target, the versioned command controller, the storage-migration
 * render gate, and every `todo-*`/`request-todo-panel` message handler.
 *
 * Extracted from `initializeDashboard` in src/dashboard.ts (see PR #65 for the
 * capability pattern). Behavior is unchanged: the handler bodies, validation
 * order, and posted messages are the same; only their ownership moved.
 */
export function createTodoPanelCapability(options: TodoPanelCapabilityOptions): TodoPanelCapability {
    const provider = options.provider;
    const todoService = options.todoService;
    const getSearchCatalog = options.getSearchCatalog;
    const getConfiguration = options.getConfiguration;
    const showInputBox = options.showInputBox;
    const showWarningMessage = options.showWarningMessage;
    const showErrorMessage = options.showErrorMessage;
    const logError = options.logError;

    const todoViewState = todoService.getViewState();
    let revealedTodoId: string | undefined;
    const todoCommandController = new TodoCommandController({
        service: todoService,
        getViewState: () => todoViewState,
        setShowCompleted: async showCompleted => {
            const persistedViewState = await todoService.setShowCompleted(showCompleted);
            todoViewState.showCompleted = persistedViewState.showCompleted;
            return persistedViewState;
        },
        getRevealedTodoId: () => revealedTodoId,
        clearRevealedTodoId: () => { revealedTodoId = undefined; },
    });
    const todoStorageMigration = { ready: Promise.resolve<unknown>(undefined) };

    async function postTodoPanelContent(requestId?: number) {
        let html: string;
        let snapshot: ReturnType<typeof buildTodoPanelSnapshot> | undefined;
        try {
            await todoStorageMigration.ready;
            const unsupportedVersionError = todoService.getUnsupportedVersionError();
            if (unsupportedVersionError) {
                throw unsupportedVersionError;
            }
            const todoData = todoService.getData();
            const config = getConfiguration();
            const todoRenderOptions = {
                maxVisibleTodosPerGroup: getMaxVisibleTodosPerGroup(config),
            };
            snapshot = buildTodoPanelSnapshot(todoData, todoViewState, revealedTodoId);
            html = getTodoPanelContent(
                buildTodoViewModel(todoData, todoViewState, revealedTodoId),
                todoRenderOptions,
            );
        } catch (error) {
            if (!(error instanceof UnsupportedTodoDataVersionError)) {
                throw error;
            }
            html = getUnsupportedTodoVersionPanelContent(error.version);
        }
        await provider.postMessage(requestId
            ? {
                type: 'todo-panel-content',
                version: 1,
                requestId,
                html,
                ...(snapshot ? { snapshot } : {}),
                searchCatalog: getSearchCatalog(),
            }
            : {
                type: 'todo-panel-updated',
                version: 1,
                html,
                ...(snapshot ? { snapshot } : {}),
                searchCatalog: getSearchCatalog(),
            });
    }

    function getMaxVisibleTodosPerGroup(config: vscode.WorkspaceConfiguration): number {
        const configuredItems = config.get('maxVisibleTodosPerGroup', 5);
        const visibleItems = Math.floor(Number(configuredItems));
        return Number.isFinite(visibleItems) && visibleItems > 0 ? visibleItems : 5;
    }

    async function runTodoPanelMutation(mutate: () => Promise<unknown>): Promise<boolean> {
        return runTodoMutation({
            mutate,
            onSuccess: () => postTodoPanelContent(),
            showErrorMessage: message => showErrorMessage(message),
            logError,
        });
    }

    const handlers: Record<string, DashboardMessageHandler> = {
        'request-todo-panel': async e => {
            if (e.version !== 1 || !Number.isSafeInteger(e.requestId) || e.requestId < 1) {
                return;
            }
            await postTodoPanelContent(e.requestId as number);
        },
        'todo-command': async e => {
            await todoStorageMigration.ready;
            const result = await todoCommandController.handle(e);
            if (result) {
                await provider.postMessage({
                    ...result,
                    searchCatalog: getSearchCatalog(),
                });
            }
        },
        'todo-add': async e => {
            const valid = typeof e.title === 'string' && Boolean(e.title.trim());
            await runTodoRequestMutation({
                requestId: e.requestId,
                valid,
                mutate: () => todoService.addTodo({
                    title: e.title as string,
                    notes: typeof e.notes === 'string' ? e.notes : '',
                    priority: e.priority === 'high' || e.priority === 'medium' || e.priority === 'low' ? e.priority : 'medium',
                    groupId: typeof e.groupId === 'string' ? e.groupId : undefined,
                }),
                onSuccess: () => postTodoPanelContent(),
                postResult: message => provider.postMessage(message),
                showErrorMessage: message => showErrorMessage(message),
                logError,
            });
        },
        'todo-add-group': async () => {
            await runTodoPromptMutation({
                prompt: value => showInputBox({
                    prompt: 'Todo group title',
                    placeHolder: 'Group name',
                    value,
                    ignoreFocusOut: true,
                }),
                mutate: title => todoService.addGroup(title),
                refreshPanel: () => postTodoPanelContent(),
                showErrorMessage: message => showErrorMessage(message),
                logError,
            });
        },
        'todo-toggle': async e => {
            if (typeof e.todoId !== 'string') {
                return;
            }
            await runTodoPanelMutation(() => todoService.completeTodo(e.todoId as string, e.completed === true));
        },
        'todo-delete': async e => {
            if (typeof e.todoId !== 'string') {
                return;
            }
            await deleteTodoWithConfirmation({
                todoId: e.todoId,
                getData: () => todoService.getData(),
                confirm: title => showWarningMessage(
                    `Delete TODO "${title}"?`,
                    { modal: true },
                    'Delete'
                ),
                deleteTodo: todoId => todoService.deleteTodo(todoId),
                refreshPanel: () => postTodoPanelContent(),
                showErrorMessage: message => showErrorMessage(message),
                logError,
            });
        },
        'todo-delete-group': async e => {
            if (typeof e.groupId !== 'string') {
                return;
            }
            const todoGroup = todoService.getData().groups.find(group => group.id === e.groupId);
            if (!todoGroup) {
                return;
            }
            const confirmed = await showWarningMessage(
                `Delete TODO group "${todoGroup.title}" and all of its todos?`,
                { modal: true },
                'Delete'
            );
            if (confirmed !== 'Delete') {
                return;
            }
            await runTodoPanelMutation(() => todoService.deleteGroup(e.groupId as string));
        },
        'todo-rename-group': async e => {
            if (typeof e.groupId !== 'string') {
                return;
            }
            await renameTodoGroupWithPrompt({
                groupId: e.groupId,
                getData: () => todoService.getData(),
                prompt: value => showInputBox({
                    prompt: 'Todo group title',
                    value,
                    ignoreFocusOut: true,
                }),
                renameGroup: (groupId, title) => todoService.renameGroup(groupId, title),
                refreshPanel: () => postTodoPanelContent(),
                showErrorMessage: message => showErrorMessage(message),
                logError,
            });
        },
        'todo-reorder-groups': async e => {
            if (!Array.isArray(e.groupIds)) {
                return;
            }
            await runTodoPanelMutation(() => todoService.reorderGroups(e.groupIds as string[]));
        },
        'todo-reorder-items': async e => {
            if (typeof e.groupId !== 'string' || !Array.isArray(e.todoIds)) {
                return;
            }
            await runTodoPanelMutation(() => todoService.reorderTodos(e.groupId as string, e.todoIds as string[]));
        },
        'todo-collapse-group': async e => {
            if (typeof e.groupId !== 'string') {
                return;
            }
            await runTodoPanelMutation(() => todoService.setGroupCollapsed(e.groupId as string, e.collapsed === true));
        },
        'todo-collapse-groups': async e => {
            await runTodoPanelMutation(() => todoService.setGroupsCollapsed(e.collapsed === true));
        },
        'todo-sort-priority': async e => {
            if (typeof e.groupId !== 'string') {
                return;
            }
            await runTodoPanelMutation(() => todoService.sortGroupByPriority(e.groupId as string));
        },
        'todo-toggle-show-completed': async e => {
            await runTodoPanelMutation(async () => {
                const persistedViewState = await todoService.setShowCompleted(e.showCompleted === true);
                todoViewState.showCompleted = persistedViewState.showCompleted;
                revealedTodoId = undefined;
            });
        },
        'todo-reveal': async e => {
            if (typeof e.todoId !== 'string' || typeof e.groupId !== 'string') {
                return;
            }
            await runTodoPanelMutation(async () => {
                const result = await todoService.revealTodo(e.todoId as string, e.groupId as string);
                if (result.revealed) {
                    revealedTodoId = e.todoId as string;
                }
            });
        },
        'todo-update': async e => {
            if (typeof e.todoId !== 'string' || typeof e.title !== 'string') {
                return;
            }
            await runTodoPanelMutation(() => todoService.updateTodo(e.todoId as string, {
                title: e.title as string,
                notes: typeof e.notes === 'string' ? e.notes : '',
                priority: e.priority === 'high' || e.priority === 'medium' || e.priority === 'low' ? e.priority : 'medium',
            }));
        },
    };

    return {
        handlers,
        setStorageMigrationReady: ready => { todoStorageMigration.ready = ready; },
        // The slice owns no timers or event subscriptions; the hook keeps the
        // capability shape uniform with the other dashboard capabilities.
        dispose: () => undefined,
    };
}
