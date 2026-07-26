---
name: installing-vscode-extensions-locally
description: Use when building, packaging, installing, or verifying this Agent Pivot VS Code extension or VSIX in a local, SSH, Dev Container, workspace, or UI extension-host environment.
---

# Installing VS Code Extensions Locally

## Overview

Build and install the Agent Pivot extension that matches the current VS Code environment, then report exactly what was installed and what could not be installed.

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
   - discover the active code-server process, its executable or arguments,
     and its active Server commit; do not guess a commit or reuse an arbitrary
     `code` binary
   - discover any Server data and extensions directories from that active
     process, CLI configuration, or environment. Do not hard-code a home
     directory, Server root, extension directory, version, or commit.
   - from the active process or installation, discover a **socket-independent
     extension-management entry point**. The installation's `bin/code-server`
     command or an equivalent wrapper is common, but do not assume either a
     fixed name or layout. Prove that the chosen entry point accepts extension
     management without inheriting `VSCODE_IPC_HOOK_CLI`.
   - independently verify that the chosen extension-management entry point
     reports a version/commit matching the active Server commit derived from
     the running active code-server process. If it is a wrapper, resolve the
     wrapper and verify that it invokes that active Server installation. This
     installation-identity check is required in addition to IPC-host proof.
   - use `remote-cli` only after replacing or validating its inherited hook
     with a reachable socket and proving that request reaches the active host.
     Matching `--version` output alone does not prove its socket target or make
     `remote-cli` a stale-IPC fallback.
   - if the active process, socket-independent entry point, Server data or
     extensions directory cannot be discovered, stop short of claiming a
     verified remote install and report the missing evidence

4. Run relevant checks first when the build is not already fresh:
   - compile or test scripts used by the repo
   - packaging checks if the extension has release packaging tests

5. Package and route each extension through the host that owns it.
   - Example: `npm run install-local`
   - If manual installation is needed, use the discovered socket-independent
     extension-management entry point to install the workspace extension into
     the active remote Server host. Supply its discovered Server-data location
     by that entry point's supported option or environment and explicitly
     target the discovered extensions directory, for example:
     `<verified-entry-point> --extensions-dir <active-extensions-dir>
     --install-extension <workspace.vsix>`. Never substitute a local,
     arbitrary PATH, or inherited-IPC CLI for this step.
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
     use the **same verified extension-management entry point** and the same
     explicit discovered extensions directory to list the installed extension
     ID and version. A matching list entry alone is insufficient.
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
  code-server process, socket-independent entry point, Server-data directory,
  and extension directory were discovered
- representative VSIX-to-installed file hash evidence for the workspace
  extension, or why that evidence could not be collected
- which checks were run
- any extension that was packaged but not installable in the current host

## Pitfalls

- Do not assume a UI bridge extension can install in a Dev Container just because the main workspace extension can.
- Do not use the first `code` binary on PATH when multiple hosts are present and the target host is unclear.
- Do not use a stale IPC socket or an arbitrary VS Code Server commit as proof
  of the active remote host.
- Do not use `remote-cli` as the stale-IPC fallback merely because its version
  matches; it is eligible only after its reachable socket is proven to reach
  the active host.
- Do not install through one entry point or extensions directory and list from
  another; both commands must use the same verified entry point and explicit
  discovered extensions directory.
- Do not claim that the current VSIX was installed without ID/version and
  representative hash comparison against the active Server installation.
- Do not claim install success from packaging success alone.
- Do not skip the repo's packaging script in favor of a generic VSIX command unless the repo lacks one.
