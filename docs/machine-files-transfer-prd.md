# Machine Files / Cross-Machine Transfer PRD

> Status: draft for product and technical review
> Date: 2026-09-06
> Depends on: [Managed Remote Machines PRD](./managed-remote-machines-prd.md)

## 1. Summary

Agent Pivot adds **Machine Files**, a first-level workspace next to AI
Conversation and Projects. It lets a user browse two Managed Machines side by
side and copy files or folders in either direction.

The two selected Machines are peers: they are not permanently labelled source
and destination. The side on which a user selects files becomes the source for
that one operation; the other side's current directory becomes the destination.
This enables a user to send build output from A to B, then immediately copy a
log or configuration file from B back to A without reconfiguring the pair.

Transfers are performed by the local UI Bridge as a streaming relay over the
user's existing SSH configuration. Therefore Machine A and Machine B do **not**
need network access to each other; this computer only needs a valid connection
to each Machine. The browser UI never receives SSH endpoints, credentials, or
file bytes.

## 2. Background and problem

Managed Machines already make remote development locations visible in Projects,
but users still need to move artifacts, configuration, logs, and small data sets
between environments. Today they must open terminals, discover two paths,
construct an SSH/scp/rsync command, decide how to handle collisions, and later
verify whether the operation succeeded. This is slow, error-prone, and excludes
users who know the intended file operation but not the transport syntax.

The common topology has a further constraint: build, staging, production, and
restricted development Machines may be unable to reach one another. The UI host
can nevertheless authenticate to both through its own SSH configuration.

## 3. Product goals

1. Let a user select two reachable Managed Machines and browse their files in
   one workspace.
2. Let a user copy a file or folder in either direction without first assigning
   permanent source/destination roles.
3. Make every copy's source, destination, size, collision policy, and outcome
   unmistakable before irreversible effects occur.
4. Keep a transfer running visibly in the background, with cancel, failure
   detail, and retry where safe.
5. Work when the two remote Machines cannot connect to each other.
6. Reuse Managed Machine identity, SSH projection, host-key verification, and
   local user authentication; never synchronize or expose credentials.

## 4. Non-goals

- Automatic bidirectional synchronization or deletion propagation.
- Moving files in the first release. Every initial operation is a copy.
- Treating a pair of Machines as a shared filesystem or mounting either one.
- Arbitrary SSH endpoint entry, password/secret storage, or direct Webview SSH.
- Access to unmanaged SSH aliases, local WSL, local containers, or local
  filesystem targets in the first release.
- Silent overwrite, silent merge, or automatic execution initiated by an AI
  agent.
- Resumable block-level transfer, schedules, and policy-managed deployment in
  the first release.

## 5. Terms and data ownership

| Term | Meaning | Authority / persistence |
| --- | --- | --- |
| Managed Machine | An existing catalog Machine with a stable ID and non-secret SSH endpoint. | Managed remote catalog; synced. |
| Transfer pair | Two selected Machine IDs plus the locally remembered directories and display order. It is symmetric, not a source/destination binding. | Local UI-host state; not synced by default. |
| Source selection | One or more files/folders selected in one pane for the next copy. | Ephemeral UI state. |
| Destination directory | The current directory in the opposite pane. | Ephemeral UI state. |
| Transfer task | One reviewed copy request and its lifecycle/result. | Local UI Bridge task store and UI state; history is local. |

Only the existing managed catalog owns Machine identity and endpoint data. Paths,
recent locations, transfer history, conflict choices, and task diagnostics may
contain sensitive local operational context and must not be added to the synced
catalog. Authentication remains wholly with OpenSSH / Remote - SSH.

## 6. Information architecture

Machine Files is a peer of the existing major Dashboard surfaces, not a detail
screen hidden in a Project menu:

```text
Dashboard
├── AI Conversation
├── Machine Files       ← new
│   ├── Pair picker
│   ├── Two-pane browser
│   └── Transfers (running and recent)
└── Projects
    └── Managed Machines / Environments / Projects
```

Projects may offer `Open in Machine Files` from a Machine's overflow menu as a
convenience entry point. That deep link preselects one Machine but does not make
it the source and does not start a transfer.

The page title is **Machine Files**. The primary page action is `Select
machines`; during a running task the persistent badge/action is `Transfers (n)`.
The page remains distinct from AI Conversation: an AI may open a reviewed,
pre-filled transfer draft, but must never execute a task without a user action.

## 7. Primary user journey

### 7.1 Select a pair

1. The user opens Machine Files and chooses `Select machines`.
2. A compact pair picker presents two equal controls, `Machine A` and `Machine
   B`, plus a swap-layout control. Neither control says source or destination.
3. Each option shows display name, endpoint-safe identity, connection readiness,
   and any catalog-conflict reason. The same Machine cannot be selected twice.
4. On `Open files`, the UI performs a non-mutating preflight against both
   Machines. It opens the last locally remembered directory for that pair, or
   the remote home directory if there is no remembered directory.
5. A failed preflight keeps the picker open and offers a human-readable remedy;
   it does not show raw credentials, SSH config, or unbounded stderr.

Recent and user-pinned pairs appear above the full Machine list. A saved pair is
still symmetric: swapping sides changes only visual layout.

### 7.2 Browse and select

The two-pane browser has equal headers: Machine name, reachable status, current
path breadcrumbs, an editable bounded path field, Refresh, and Up. Both panes
may be navigated independently.

- A source pane supports checkboxes for multiple files and folders.
- The other pane is a directory navigator. Its current directory is the copy
  destination; opening a directory deliberately changes that destination.
- Selecting source items on one side clears source selection on the other side.
  This prevents an ambiguous bidirectional copy request.
- A user can reverse direction simply by selecting files on the other side. The
  selected side gains a subtle temporary `Copying from here` state; the pair
  itself never gains a source label.
- A file or folder can also be dragged to the opposite pane. The drop location
  determines the destination directory and opens the same review, never an
  immediate copy.

For a single selected file, the review may expose `Destination name` to create a
copy under a new name. For multiple selected items or a folder, the target is a
directory and child names are preserved. The UI must explain the resulting path,
for example: `dist/` → `/opt/app/releases/dist/`.

### 7.3 Review and start

`Copy 2 items → Staging` appears only after a source selection exists. It opens a
review sheet that remains visibly tied to both pane headers and contains:

- source Machine and canonical source paths;
- destination Machine and the exact resolved destination paths;
- item count and calculated total size (or `Calculating…` until known);
- discovered collisions grouped as new, same, changed, and inaccessible;
- conflict policy, initially **Ask before replacing**;
- any warning about insufficient target space, unsupported file types,
  inaccessible child paths, or an unavailable integrity check.

Permitted release-one collision policies are `Ask`, `Skip existing`, and
`Replace existing`. `Replace existing` is a deliberate per-task choice and must
display the number of affected existing paths. `Keep both / rename` is available
for a single file in the review sheet. No policy may delete source files.

The enabled final action is `Start copy`. Its confirmation text includes both
Machine names, both base paths, the copy direction, and size. If the preflight
or catalog revision becomes stale, the review must refresh before it can start.

### 7.4 Run, complete, and recover

After starting, the task moves to Transfers and can run while the user browses
other files, switches Dashboard surfaces, or closes the review sheet. A task row
shows direction, current path, completed/total bytes, item progress, speed,
estimated remaining time when defensible, and Cancel.

Completion shows `Copied`, `Copied with skipped/conflicted items`, `Cancelled`,
or `Failed`; no vague “done” status. A completed task offers `Reveal target`.
Failed tasks offer a bounded error explanation and `Retry failed items` only
when the saved copy plan can safely be revalidated. Application / extension-host
shutdown terminates active transport cleanly and records it as interrupted;
resume is a later feature, not an implied guarantee.

## 8. Functional requirements

### 8.1 Machine eligibility and preflight

- Only active, unconflicted Managed Machines appear in the picker.
- A Machine must prove a current catalog revision, safe generated SSH
  projection, local OpenSSH availability, host-key validation, and successful
  read access to its starting directory before it is marked ready.
- Starting a task also proves target-directory write access and obtains target
  free-space information where the platform supplies it.
- A stale revision, endpoint conflict, missing SSH dependency, host-key prompt,
  access denial, or unavailable Machine disables the affected action with a
  specific recovery path.

### 8.2 File browser

- List directories lazily and page large directories; never recursively scan an
  entire filesystem merely to render a pane.
- Render name, kind, optional size, modified time, and readable/accessible
  state. Sort by name, type, modified time, or size.
- Support hidden items with a visible toggle; do not make them silently vanish.
- Support exact/bounded path entry and breadcrumbs. Paths must be absolute POSIX
  paths, normalized without following an untrusted lexical escape above root.
- Search initially filters the loaded directory; recursive remote search is a
  later opt-in operation with explicit scope and cancellation.
- File preview and text diff are P1 capabilities, limited by a strict size cap
  and binary detection.

### 8.3 Copy semantics

- Support regular files and directories recursively. Preserve relative names
  beneath the selected root.
- First release does not follow symlinks silently. The review lists symlinks and
  lets the user skip them; preserving a link as a link is P1 after a security
  review.
- Special files (devices, sockets, FIFOs) are unsupported and reported before
  start.
- Preserve timestamps and executable mode only when both remote platforms and
  user permissions permit it; this is shown as best effort, not a hidden
  guarantee.
- Validate every requested target path is beneath the reviewed destination root.
  Never accept a target path supplied directly by Webview markup.
- Calculate total size before `Start copy` when possible. If a remote listing
  cannot calculate it, the confirmation explains this and still requires an
  explicit start.
- Verify each completed regular file by size and, where supported, a streaming
  digest. A mismatch is a failed item; the task must not claim full success.

### 8.4 Background tasks, history, and notifications

- Allow one active transfer by default. Additional reviewed tasks queue in
  order; P1 may permit safe configurable concurrency.
- Persist task summaries locally: opaque task ID, Machine IDs, redacted paths,
  timestamps, policy, status, bytes/items, and bounded failure category. Do not
  persist secrets, raw SSH output, or file content.
- History is local, retains a documented bounded number of entries, and has
  `Clear history`; clearing history never deletes remote data.
- Completion/failure notifications are accessible, deduplicated, and link to
  the relevant task, not directly to an unreviewed destructive action.

### 8.5 Accessibility and responsive behavior

- Every pair-picker option, pane header, path control, listing row, selection,
  transfer action, and task action is keyboard operable with an accessible name
  containing Machine and path context.
- Keyboard users can move focus between panes, navigate directories, select
  items, choose a destination, open review, and cancel a task without drag and
  drop.
- At narrow Dashboard widths, panes stack but retain a persistent direction
  summary and keyboard destination selection. They must not silently turn into
  a one-pane workflow.
- Color never solely denotes direction, connectivity, or errors.

## 9. UX requirements and product decisions

| Decision | Requirement and rationale |
| --- | --- |
| Pair, not fixed endpoints | Two Machines are selected symmetrically. Copy direction is set by the current selected pane or drag direction, avoiding needless reconfiguration for back-and-forth work. |
| Dedicated surface | Machine Files is a peer Dashboard page because two independent remote trees, review, and task progress need more room and a durable mental model than a Project overflow dialog. |
| Visible intent | A fixed summary bar is present whenever items are selected. Copy is unavailable until its exact result can be described. |
| Copy-first safety | The initial action is always copy. Move and sync have different destructive semantics and are excluded. |
| Review before effects | Drag/drop, button, AI hand-off, retry, and saved plan all route through the same review policy. |
| Convenient recurrence | Recent/pinned symmetric pairs and locally remembered folders speed repeated workflows without synchronizing operational paths. |
| Explicit uncertainty | Unknown size, unavailable free-space, partial directory access, or unsupported entries appear as warnings, never as deceptive success. |
| Agent assistance is bounded | Conversation can prefill a draft only from user-visible Managed Machine/project context. It cannot select an unshown path, set Replace Existing, or start transfer. |

## 10. Technical implementation path

### 10.1 Architecture and trust boundary

```text
Machine Files Webview (presentation only)
  │ request ID, Machine IDs, UI intent, opaque entry/directory references
  ▼
Main extension transfer controller (control plane)
  │ current managed-catalog revision + opaque transfer plan
  ▼
Managed Remote UI Bridge (local UI host, capability-gated)
  ├── re-reads active catalog and checks expected revision
  ├── uses current generated OpenSSH projection / local auth
  ├── source SSH/SFTP connection ── local streaming relay ── target SSH/SFTP connection
  └── returns bounded, redacted progress and terminal settlement
```

The existing bridge is deliberately identity-only. This feature adds a separate,
versioned `machineFileTransferV1` capability and transfer operations; it must not
relax existing navigation parsing or turn arbitrary bridge commands into a file
proxy. The data plane lives entirely in the local UI Bridge. File payloads do
not traverse the Webview message channel or VS Code command arguments.

### 10.2 Protocol principles

1. The Webview sends only bounded request IDs, expected catalog revision,
   Machine IDs, opaque entry/directory references issued by host-validated
   browsing, policy choice, and opaque task IDs. A bounded path-entry value may
   be submitted only to request navigation; it is never a trusted copy-plan
   path.
2. The main extension re-reads authoritative catalog state, validates the
   selection, converts it to a canonical transfer plan, and requests bridge
   work. The Webview never sends endpoint values, SSH aliases, shell snippets,
   a trusted destination path, or task status to be trusted.
3. The bridge re-reads the active catalog, validates the same revision and both
   Machine IDs, and resolves aliases through the existing exact SSH projection.
   It rejects stale, conflicted, or unmanaged identities.
4. Every bridge request has a bounded correlation ID, session token, timeouts,
   a single terminal result, and a redacted error vocabulary. Progress is
   throttled/coalesced and scoped to the owning Dashboard session.
5. All process execution uses argument arrays, never shell interpolation. Path
   data is passed through protocol-safe encoders; validation prevents `..`,
   control characters, target-root escapes, and option injection.

### 10.3 Transport choices and phased recommendation

The implementation must use the local user's existing OpenSSH configuration so
host keys, `ProxyJump`, agents, and supported authentication continue to work.
The selected transport must keep all payload bytes on the local UI host.

| Path | Use | Benefits | Limits / decision |
| --- | --- | --- | --- |
| A. OpenSSH CLI transport (recommended P0) | Bridge invokes the discovered local OpenSSH tooling with the Agent Pivot-generated config. Bounded SFTP batch operations list/stat paths; `scp -3` copies source to target through this computer. | Reuses the exact local auth and config already trusted by Managed Machines; no secret handling or remote-to-remote reachability. | Needs an implementation spike for structured SFTP parsing, current-platform `scp -3` behavior, progress extraction, names with special characters, and collision preflight. P0 ships only after this matrix passes. |
| B. Native SFTP client in the bridge | A later implementation uses one locally authenticated SFTP session per Machine and streams source reads to target writes with backpressure. | Precise progress, deterministic file enumeration and collision behavior, no temporary full-file staging. | Must faithfully honor existing SSH config, host-key, proxy, and agent behavior. Do not introduce it until this parity is proven; never copy credentials out of OpenSSH. |
| C. Local temporary staging | Download then upload using SFTP/scp. | Simple fallback for a single small file. | Not a normal product path: consumes disk, leaks data at rest, and doubles I/O. It may be used only as a documented, explicitly consented recovery fallback, not silently. |
| D. Remote-to-remote transport | Source directly reaches target. | Potentially efficient on networks that allow it. | Explicitly out of scope. It violates the topology promise and makes policy/credential behavior inconsistent. |

The P0 transport spike is a delivery gate, not an optional polish item. It must
prove Linux, macOS, and Windows UI-host behavior; IPv6; spaces, Unicode, `#`,
`?`, `%`, leading dashes, and single quotes in legal paths; `ProxyJump`;
password-less agent/key authentication; target collision behavior; cancellation;
and Machines that cannot reach one another.

### 10.4 UI implementation path

- Add a first-level Machine Files tab/surface in the Dashboard shell and its
  generated/runtime Webview copies. It owns a small view state machine:
  `empty → pairing → browsing → reviewing → queued/running → settled`.
- Use host-owned mutation messages following the existing Webview mutation
  protocol: UI actions have request IDs, pending states, stale acknowledgements
  are rejected, and authoritative updated state replaces optimistic assumptions.
- Build pane trees from bridge directory pages; virtualize long lists and retain
  stable selection/focus by canonical entry ID/path.
- Add a Transfer controller/service in the main extension for validation,
  plan construction, UI snapshot projection, queue orchestration, and local
  task-history policy. Keep catalog and transfer-plan models separate.
- Extend shared Managed Remote bridge protocol/client/controller with the new
  capability and operations such as `preflightPair`, `listDirectory`,
  `inspectCopyPlan`, `startCopy`, `cancelTransfer`, and `getTransferStatus`.
  Exact wire names and payload schemas require a separate technical-design
  change with strict parsers before implementation.
- Extend the UI Bridge with a local transfer engine, process lifecycle owner,
  bounded diagnostic mapper, and cleanup on deactivation. Its only filesystem
  authority is the two currently validated Managed Machine sessions.

### 10.5 Storage, privacy, and observability

- Transfer-pair recents, pane directories, queue summaries, and history are
  local UI-host state. They are capped and cleared on demand.
- Catalog storage remains unchanged except for consuming existing Machine IDs.
- No passwords, private keys, passphrases, tokens, SSH configuration contents,
  full file content, or unbounded process output enters settings, telemetry,
  diagnostics, Webview HTML, or task history.
- Telemetry, if approved separately, records only feature-level events and
  bounded categories (pair opened, review opened, start, complete, cancelled,
  failure category). It must not include endpoint, path, filename, or byte
  content.

## 11. Delivery slices

### Slice 0 — design and transport spike

- Finalize protocol schema, local-state retention policy, error taxonomy, and
  platform support matrix.
- Prove the P0 OpenSSH CLI path against the transport matrix in section 10.3.
- Produce a clickable/visual UX review for pair selection, both copy
  directions, review/collision, running, and failure states.

### Slice 1 — safe two-pane P0

- First-level Machine Files surface and symmetric pair picker.
- Read-only paged browsing, pair recents, current path controls, accessibility,
  and connection preflight.
- Multi-item copy of regular files/folders in either direction; review, Ask /
  Skip / Replace policies, one task queue, cancellation, validation, background
  progress, local history, and result reveal.

### Slice 2 — efficient repeated transfers

- Drag/drop routed through review, copied-from labels, pinned pairs/paths,
  target single-file rename, diff/collision preview, text preview, retry failed
  items, and verified size/digest reporting.

### Slice 3 — guarded automation

- Named one-way transfer plans, explicitly reviewed re-run, opt-in recursive
  search, configurable safe concurrency/rate limits, and agent-generated draft
  hand-off. No automatic two-way synchronization without a separate PRD.

## 12. Acceptance criteria

### Product and interaction

- [ ] Machine Files is reachable as a first-level Dashboard surface next to AI
      Conversation and Projects; it is not only a Project overflow dialog.
- [ ] The user can select exactly two different eligible Managed Machines and
      open them as equal left/right panes without choosing a fixed source or
      target.
- [ ] A catalog-conflicted, unavailable, duplicate, or unmanaged Machine cannot
      begin a pair; the UI gives an accessible reason and recovery path.
- [ ] The user can navigate each pane independently and the UI keeps a clear
      visible current directory for both sides.
- [ ] Selecting items on either side enables a direction-specific copy action to
      the other side's current directory; reversing selection reverses the
      operation without reselecting the pair.
- [ ] Selecting source items in the opposite pane removes the prior source
      selection and never produces an ambiguous two-way action.
- [ ] Dragging left-to-right or right-to-left opens review with the correct
      source selection and destination directory, never an immediate transfer.
- [ ] Review accurately shows both Machine names, canonical input and output
      paths, item count, known/unknown size, collision result, and policy.
- [ ] Default collision handling is Ask. Replace Existing cannot be selected or
      executed accidentally; copy never deletes source data.
- [ ] A file can be copied under a reviewed different name; folders and multiple
      selections preserve child names beneath a selected destination directory.
- [ ] Files, directories, symlinks, unsupported special files, hidden items,
      unreadable paths, and partially accessible directories each have the
      documented behavior in this PRD.
- [ ] All browse, selection, direction, review, start, task, retry, and cancel
      actions are fully keyboard accessible and convey Machine/path context.

### Transfer topology, safety, and correctness

- [ ] A successful copy completes when source and target Machines cannot open a
      network connection to one another but the local UI host can authenticate
      to both.
- [ ] Payload bytes relay through the local UI host and never pass through
      Webview messages, VS Code command payloads, or synchronized settings.
- [ ] The transport honors the verified local Managed Machine SSH projection and
      local OpenSSH host-key/auth behavior; no credentials are stored by Agent
      Pivot.
- [ ] The bridge rejects a stale revision, session token, Machine ID, target
      root, malformed path, unrecognized operation, and any raw endpoint value.
- [ ] Process arguments resist shell/path/option injection for spaces, Unicode,
      `#`, `?`, `%`, quotes, leading dashes, and directory traversal attempts.
- [ ] Preflight prevents start when source is unreadable or destination is
      unwritable; insufficient-space and unknown-space conditions are shown
      before the final confirmation.
- [ ] The final target remains beneath the reviewed target root for every copied
      path, including nested directories and adversarial names.
- [ ] Completion only reports full success after required size/integrity checks;
      partial results identify skipped, conflicted, failed, or unverifiable
      items.
- [ ] Cancel terminates relay processes, leaves a truthful cancelled/partial
      task state, and never reports unverified files as completed.

### Background behavior, privacy, and regression safety

- [ ] A started transfer remains observable after leaving Machine Files and
      shows direction, item/byte progress, cancel, and a terminal result.
- [ ] Restart/deactivation terminates active child processes safely and records
      the task as interrupted rather than pretending it can resume.
- [ ] History, recent pairs, and pane locations remain local, bounded, and
      clearable. No path/history data changes the managed catalog sync payload.
- [ ] Logs, diagnostics, telemetry, Webview state, and errors contain no secret,
      private-key, SSH-config content, file bytes, or unbounded raw command
      output.
- [ ] Existing Managed Machine catalog mutations, SSH projection, Project
      navigation, AI Conversation, and UI Bridge attention/navigation behavior
      retain their current contract tests.
- [ ] Automated coverage includes unit, protocol/contract, integration, and
      platform-matrix tests for the acceptance items above, plus `test-compile`,
      focused tests, Dashboard Webview checks, behavior contracts, lint, and
      `git diff --check` before each implementation commit.

## 13. Open decisions before Slice 0 completion

1. Confirm first-release UI-host support: Linux, macOS, and Windows are the
   intended baseline; document any temporary platform exclusion explicitly.
2. Choose and prove the exact OpenSSH CLI/SFTP interface or a parity-preserving
   local SFTP adapter. Do not begin product implementation on an unverified
   parser/transport assumption.
3. Set concrete limits for directory page size, selected item count, total task
   size warning, preview size, history retention, retry attempts, and diagnostic
   truncation.
4. Decide whether a user can override an unknown free-space result after an
   explicit warning, and which protected target roots require extra confirmation.
5. Confirm whether preserving symlinks, POSIX modes, timestamps, extended
   attributes, and ACLs is supported, skipped, or best-effort per platform.
6. Confirm telemetry approval and retention; the product must function with no
   telemetry.
