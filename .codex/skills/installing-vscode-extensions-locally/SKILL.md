---
name: installing-vscode-extensions-locally
description: Use when building, packaging, installing, or verifying this Project Steward VS Code extension or VSIX in a local, SSH, Dev Container, workspace, or UI extension-host environment.
---

# Installing VS Code Extensions Locally

## Overview

Build and install the Project Steward extension that matches the current VS Code environment, then report exactly what was installed and what could not be installed.

## Workflow

1. Identify package scripts before guessing:
   - inspect `package.json`
   - prefer repo scripts such as `npm run install-local`, `npm run package`, or `npm run vscode:package`

2. Identify the active VS Code host before installing:
   - inspect environment hints such as `REMOTE_CONTAINERS`, `CODESPACES`, `SSH_CONNECTION`, and `VSCODE_IPC_HOOK_CLI`
   - validate `VSCODE_IPC_HOOK_CLI` before trusting it: an unset value or a path that is not a reachable Unix socket is stale `VSCODE_IPC_HOOK_CLI`, not evidence of an active host
   - run `which -a code` and `code --version` only to inventory candidates; do not select the first `code` on `PATH`
   - prefer the repo install script if it already selects the correct local, SSH, or Dev Container CLI
   - if multiple `code` CLIs exist and the target host is unclear, ask before installing

3. Use a deterministic remote fallback when the IPC socket is stale or the
   target is a Dev Container/SSH workspace:
   - discover the active `code-server` process, its executable or arguments,
     and its active Server commit; do not guess a commit or reuse an arbitrary
     `code` binary
   - derive the remote CLI belonging to that active code-server installation
     (for example by resolving the discovered Server installation and its
     `remote-cli` sibling), then confirm its reported version/commit matches
     the active Server commit
   - discover any Server data and extensions directories from that active
     process, CLI configuration, or environment. Do not hard-code a home
     directory, Server root, extension directory, version, or commit.
   - if the active process, matching CLI, or installed-extension location
     cannot be discovered, stop short of claiming a verified remote install
     and report the missing evidence

4. Run relevant checks first when the build is not already fresh:
   - compile or test scripts used by the repo
   - packaging checks if the extension has release packaging tests

5. Package and route each extension through the host that owns it.
   - Example: `npm run install-local`
   - If manual installation is needed, use the discovered active Server CLI to
     install the workspace extension into the active remote Server host, for
     example: `<active-server-cli> --install-extension <workspace.vsix>`.
     Never substitute a local or arbitrary PATH CLI for this step.
   - A UI-only bridge belongs to the local UI host. When that host is
     unreachable from the remote environment, report it as **packaged but not
     installed** and provide the artifact and required local-host handoff; do
     not treat the workspace extension's remote installation as bridge
     installation.

6. Distinguish extension host compatibility.
   - Workspace extensions can install into Dev Containers/SSH workspaces.
   - UI-only extensions may need the local UI host and can fail from inside a remote extension host.
   - Report this as an environment limitation, not as a successful install.

7. Verify installed bytes, not just command exit status:
   - read the extension ID and version from the packaged VSIX manifest, then
     use the **same active Server CLI** to list the installed extension ID and
     version. A matching list entry alone is insufficient.
   - locate the installed directory for that ID/version in the discovered
     active Server extension location. Select representative files that exist
     in both the VSIX and installed directory (the manifest plus the main
     runtime bundle or another packaged executable asset).
   - calculate SHA-256 hashes for those representative packaged and installed
     files. Require every selected pair to match before reporting the main
     workspace extension as installed from this build; retain the paths and
     hashes in the report.
   - a packaging success, a zero exit status, or an extension-list entry can
     establish only packaging or attempted installation, never verified bytes.
   - if a script exits 0 with warnings, report warnings separately from failure

## Reporting

Always tell the user:
- which VSIX artifact was built
- which extension id/version was installed
- which host received it, if known
- whether `VSCODE_IPC_HOOK_CLI` was usable or stale, and how the active
  code-server CLI and extension directory were discovered
- representative VSIX-to-installed file hash evidence for the workspace
  extension, or why that evidence could not be collected
- which checks were run
- any extension that was packaged but not installable in the current host

## Pitfalls

- Do not assume a UI bridge extension can install in a Dev Container just because the main workspace extension can.
- Do not use the first `code` binary on PATH when multiple hosts are present and the target host is unclear.
- Do not use a stale IPC socket or an arbitrary VS Code Server commit as proof
  of the active remote host.
- Do not claim that the current VSIX was installed without ID/version and
  representative hash comparison against the active Server installation.
- Do not claim install success from packaging success alone.
- Do not skip the repo's packaging script in favor of a generic VSIX command unless the repo lacks one.
