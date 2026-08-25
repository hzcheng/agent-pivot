'use strict';

import type { AttentionAggregate } from '../aiSessions/attentionAggregate';
import { withAttentionProject } from '../aiSessions/attentionProject';
import type { GroupCollapseController } from '../dashboard/groupCollapseController';
import type { DashboardMessageHandler } from '../dashboard/messageRouter';
import type { ProjectsPanelController } from '../dashboard/projectsPanelController';
import type { ProjectsPanelUpdateMode } from '../dashboard/webviewUpdateMessages';
import type { GroupOrder, Project, ProjectOpenType } from '../models';
import type { OpenWorkspaceDashboardController } from '../openWorkspaces/dashboardController';
import type { WorkspaceNavigationController } from '../openWorkspaces/navigationController';
import type { OpenWindowNavigationRequestController } from '../openWorkspaces/openWindowNavigationRequestController';
import type { OpenWorkspacePinController } from '../openWorkspaces/pinController';
import type ProjectService from '../services/projectService';
import type { FavoriteProjectController } from './favoriteProjectController';
import type { GroupCommandController } from './groupCommandController';
import type { ProjectMutationController } from './projectMutationController';
import type { ProjectOpenController } from './projectOpenController';
import type { ProjectOrderController } from './projectOrderController';
import type { ProjectRemovalController } from './projectRemovalController';

export interface ProjectSurfaceRefreshOptions {
    getProjectsPanelController: () => ProjectsPanelController | undefined;
    getOpenWorkspaceDashboardController: () => OpenWorkspaceDashboardController;
    publishOpenWorkspace: () => void;
    syncProjectColorToCurrentWindow: (project: Project | null) => void;
}

export interface ProjectSurfaceRefresh {
    postProjectSurfacesUpdated: (mode: ProjectsPanelUpdateMode) => void;
    refreshAfterMutation: (mode?: ProjectsPanelUpdateMode) => void;
    applyProjectColorToCurrentWindow: (project?: Project | null) => void;
}

/**
 * Owns the partial Projects/OPEN surface refresh shared by every saved-project
 * mutation: the panel posts, the window colour sync, and the workspace
 * republish -- never a full Dashboard rebuild.
 *
 * Extracted from `initializeDashboard` in src/dashboard.ts. The accessors are
 * late-bound on purpose: the panels and controllers they read are constructed
 * after the project controllers that consume `refreshAfterMutation`, so the
 * refresh must resolve them at call time, exactly like the hoisted function
 * declarations it replaces.
 */
export function createProjectSurfaceRefresh(
    options: ProjectSurfaceRefreshOptions
): ProjectSurfaceRefresh {
    function postProjectSurfacesUpdated(mode: ProjectsPanelUpdateMode): void {
        options.getProjectsPanelController()?.postUpdated(mode);
        options.getOpenWorkspaceDashboardController().postUpdated();
    }

    function applyProjectColorToCurrentWindow(project: Project = null): void {
        options.syncProjectColorToCurrentWindow(project);
    }

    function refreshAfterMutation(mode: ProjectsPanelUpdateMode = 'replace'): void {
        postProjectSurfacesUpdated(mode);
        applyProjectColorToCurrentWindow();
        options.publishOpenWorkspace();
    }

    return {
        postProjectSurfacesUpdated,
        refreshAfterMutation,
        applyProjectColorToCurrentWindow,
    };
}

export interface ProjectMessageHandlersOptions {
    projectService: ProjectService;
    projectOpenController: ProjectOpenController;
    projectMutationController: ProjectMutationController;
    projectOrderController: ProjectOrderController;
    favoriteProjectController: FavoriteProjectController;
    projectRemovalController: ProjectRemovalController;
    groupCommandController: GroupCommandController;
    groupCollapseController: GroupCollapseController;
    /** Late-bound: the navigation controller is constructed after the router. */
    getWorkspaceNavigationController: () => WorkspaceNavigationController;
    /** Late-bound: the navigation request controller is constructed after the router. */
    getOpenWindowNavigationRequestController: () => OpenWindowNavigationRequestController;
    /** Late-bound: the pin controller is constructed after the router. */
    getOpenWorkspacePinController: () => OpenWorkspacePinController;
    getAttentionAggregate: () => AttentionAggregate;
    /** Owned by the AI session attention slice; injected, not extracted here. */
    acknowledgeAiSessionAttentionEventIds: (eventIds: string[]) => Promise<void>;
    refreshAfterMutation: (mode?: ProjectsPanelUpdateMode) => void;
    showWarningMessage: (message: string) => unknown;
}

/**
 * Owns the Projects/Groups slice of the dashboard message router: the
 * `selected-project` open flow (including its attention acknowledgement) and
 * the thin project/group mutation delegates.
 *
 * Extracted from `initializeDashboard` in src/dashboard.ts (see the panel
 * capability for the same slice pattern). Behaviour is unchanged: the handler
 * bodies delegate to the same controllers with the same arguments; only their
 * ownership moved.
 */
export function createProjectMessageHandlers(
    options: ProjectMessageHandlersOptions
): Record<string, DashboardMessageHandler> {
    const projectService = options.projectService;
    const projectOpenController = options.projectOpenController;
    const projectMutationController = options.projectMutationController;
    const projectOrderController = options.projectOrderController;
    const favoriteProjectController = options.favoriteProjectController;
    const projectRemovalController = options.projectRemovalController;
    const groupCommandController = options.groupCommandController;
    const groupCollapseController = options.groupCollapseController;
    const getWorkspaceNavigationController = options.getWorkspaceNavigationController;
    const getOpenWindowNavigationRequestController = options.getOpenWindowNavigationRequestController;
    const getOpenWorkspacePinController = options.getOpenWorkspacePinController;
    const getAttentionAggregate = options.getAttentionAggregate;
    const acknowledgeAiSessionAttentionEventIds = options.acknowledgeAiSessionAttentionEventIds;
    const refreshAfterMutation = options.refreshAfterMutation;
    const showWarningMessage = options.showWarningMessage;

    return {
        'selected-project': async e => {
            let projectId = e.projectId as string;
            let projectOpenType = e.projectOpenType as ProjectOpenType;

            if (projectId.startsWith('__openWorkspaceNavigation-')) {
                await getWorkspaceNavigationController().open(projectId);
                return;
            }

            const project = projectService.getProject(projectId);
            if (project == null) {
                showWarningMessage("Selected Project not found.");
                return;
            }

            const attentionProject = withAttentionProject(
                project,
                getAttentionAggregate()
            );
            await acknowledgeAiSessionAttentionEventIds(attentionProject.aiSessionAttentionEventIds);
            await projectOpenController.openProject(project, projectOpenType);
            await projectService.touchProjectLastOpened(projectId);
        },
        'set-open-workspace-pin': e => getOpenWorkspacePinController().handle(e),
        'open-window-navigation-request': e => getOpenWindowNavigationRequestController().handle(e),
        'add-project': async e => {
            await projectMutationController.addProject(e.groupId as string);
        },
        'import-from-other-storage': async () => {
            await projectService.copyProjectsFromFilledStorageOptionToEmptyStorageOption();
            refreshAfterMutation();
        },
        'reordered-projects': async e => {
            await projectOrderController.reorderGroups(e.groupOrders as GroupOrder[]);
        },
        'reordered-favorites': async e => {
            await favoriteProjectController.reorderFavoriteProjects(Array.isArray(e.projectIds) ? e.projectIds as string[] : []);
        },
        'remove-project': async e => {
            await projectRemovalController.removeProject(e.projectId as string);
        },
        'edit-project': async e => {
            await projectMutationController.editProject(e.projectId as string);
        },
        'color-project': async e => {
            await projectMutationController.editProjectColor(e.projectId as string);
        },
        'favorite-project': async e => {
            await favoriteProjectController.toggleProjectFavorite(e.projectId as string);
        },
        'edit-group': async e => {
            await groupCommandController.editGroup(e.groupId as string);
        },
        'remove-group': async e => {
            await groupCommandController.removeGroup(e.groupId as string);
        },
        'add-group': async () => {
            await groupCommandController.addGroup();
        },
        'collapse-group': async e => {
            await groupCollapseController.collapseGroup(e.groupId as string, e.collapsed as boolean);
        },
        // Collapse-all is a per-webview convenience action.
        'toggle-all-groups': () => undefined,
    };
}
