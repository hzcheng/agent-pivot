'use strict';

import * as vscode from 'vscode';

import ColorService from '../../services/colorService';
import ProjectService from '../../services/projectService';
import ProjectWindowColorService from '../../services/projectWindowColorService';
import FileService from '../../services/fileService';
import GitRepositoryDetector from '../../projects/gitRepositoryDetector';

/**
 * Composition section (MOD-DASHBOARD-SHELL): the leaf project/catalog
 * services with no inter-module wiring. Extracted from the composition root
 * so dashboard.ts keeps ordering and cross-domain wiring only.
 */
export interface ProjectServicesDeps {
    context: vscode.ExtensionContext;
    logDashboardDiagnostic: (event: Record<string, unknown>) => void;
}

export interface ProjectServices {
    colorService: ColorService;
    projectService: ProjectService;
    projectWindowColorService: ProjectWindowColorService;
    fileService: FileService;
    gitRepositoryDetector: GitRepositoryDetector;
}

export function createProjectServices(deps: ProjectServicesDeps): ProjectServices {
    const { context, logDashboardDiagnostic } = deps;
    const colorService = new ColorService(context);
    const projectService = new ProjectService(context, colorService, {
        onDiagnostic: event => logDashboardDiagnostic(event),
        onConflict: projectIds => {
            logDashboardDiagnostic({
                event: 'project-catalog-sync-conflict-recovered',
                projectIds,
            });
            void vscode.window.showInformationMessage(
                'Agent Pivot recovered projects from a sync conflict.'
            );
        },
    });
    const projectWindowColorService = new ProjectWindowColorService(context);
    const fileService = new FileService(context);
    const gitRepositoryDetector = new GitRepositoryDetector();
    return {
        colorService,
        projectService,
        projectWindowColorService,
        fileService,
        gitRepositoryDetector,
    };
}
