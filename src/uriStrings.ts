'use strict';

/**
 * URI-shape predicates (MOD-SHARED-KERNEL): the canonical "is this string a
 * URI rather than a filesystem path" check. Three local copies drifted across
 * projects and aiSessions; the single owner lives here at the module-graph
 * bottom so runtime, projects, and the shell share one encoding.
 */
export function isUriString(projectPath: string): boolean {
    return Boolean(projectPath) && projectPath.includes('://');
}
