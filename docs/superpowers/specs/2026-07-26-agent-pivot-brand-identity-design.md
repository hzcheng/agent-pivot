# Agent Pivot Brand Identity Design

## Context

The extension is preparing for its first Visual Studio Marketplace release.
Its current public name is Project Steward, but its Marketplace icon and
Activity Bar icon are inherited unchanged from the upstream
`Kruemelkatze/vscode-dashboard` project. Although the product has already been
substantially redesigned, those inherited assets still make the extension look
like a copy of the upstream listing.

There is no published-user compatibility requirement. The product may replace
its extension identifier, command identifiers, configuration namespace,
storage identifiers, managed-runtime prefixes, companion extension identifier,
and version sequence without migrating existing Project Steward state.

The rebrand must establish a distinct product identity before Marketplace
publication while preserving the upstream attribution and license obligations
that continue to apply to the fork.

## Product Position

Agent Pivot is a professional, restrained command surface for switching,
monitoring, and resuming AI coding-agent sessions across VS Code workspaces.

The primary value proposition is:

> Switch, monitor, and resume Codex, Claude, and Kimi sessions across VS Code
> workspaces.

Project and workspace management remain important supporting capabilities, but
they do not lead the brand. The brand should first communicate coordination and
context switching among AI coding sessions.

## Goals

- replace every current user-facing Project Steward identity with Agent Pivot;
- introduce an original, recognizable icon system that works in Marketplace
  artwork and the VS Code Activity Bar;
- start with a coherent new extension identity rather than retain compatibility
  aliases for an unpublished product;
- make stale upstream branding and stale Project Steward identifiers detectable
  release failures;
- improve Marketplace metadata, screenshots, licensing presentation, privacy
  information, and third-party notices;
- keep all existing product behavior unchanged apart from names, identifiers,
  artwork, and release presentation;
- preserve accurate attribution to the upstream fork and third-party authors.

## Non-Goals

This design does not:

- add, remove, or redesign Agent Session functionality;
- change Codex, Kimi, or Claude discovery, launch, resume, focus, or transcript
  behavior;
- provide migration from Project Steward configuration, extension state,
  persisted Bridge state, or managed tmux identifiers;
- rename the GitHub repository automatically as part of local implementation;
- publish either extension or mutate Marketplace state;
- obtain additional rights for the optional Sharingan artwork;
- make Sharingan artwork part of the product logo or primary promotional
  identity.

## Naming Decision

### Selected name: Agent Pivot

`Agent` makes the product category immediately understandable. `Pivot`
describes the main action: moving among workspaces, providers, and sessions
without losing context. The name is short enough for the Activity Bar, command
palette, Marketplace cards, release titles, and companion extension.

### Names rejected during discovery

- `Agent Deck` is already used by multiple closely related AI coding-agent
  products, including tools that manage Claude and Codex sessions.
- `Agent Relay`, `Agent Router`, `Agent Switchboard`, and `Agent Dispatch` are
  also used by active, highly related AI products.
- `Agent Junction` and `Agent Circuit` were viable working directions but were
  less direct than Agent Pivot: Junction emphasizes a place, while Circuit can
  imply workflow construction rather than session switching.

Public-name discovery reduces obvious collision risk but is not a trademark
opinion or legal clearance. A final Marketplace, repository, package registry,
domain, and trademark review remains a release prerequisite.

## Identity Contract

The new release uses the following public identity:

| Surface | Required value |
| --- | --- |
| Product display name | `Agent Pivot` |
| Main package name | `agent-pivot` |
| Main extension identifier | `hzcheng.agent-pivot` |
| Command namespace | `agentPivot.*` |
| Configuration namespace | `agentPivot.*` |
| Main View and container prefix | `agentPivot` |
| Companion package name | `agent-pivot-attention-ui-bridge` |
| Companion display name | `Agent Pivot Attention UI Bridge` |
| Companion extension identifier | `hzcheng.agent-pivot-attention-ui-bridge` |
| Publisher | `hzcheng` |
| First Agent Pivot version | `1.0.0` |
| Intended repository | `https://github.com/hzcheng/agent-pivot.git` |

The implementation must also rename current Project Steward-specific internal
state keys, profile-local Bridge paths, managed tmux prefixes, diagnostic
channel names, test fixtures, packaging names, artifact names, and release
titles. Provider-owned session identifiers and provider-owned storage paths do
not change.

The main extension's `extensionDependencies` entry must reference the new
companion extension identifier. Both VSIX files must be built and validated as
one release set.

## Visual Identity

### Selected symbol: Pure Axis

Pure Axis uses three equally spaced input rails that converge on one circular
pivot and continue as one focused output rail.

The visual meaning is intentionally narrow:

- three inputs represent the supported Codex, Kimi, and Claude session
  surfaces without assigning a permanent color or position to a provider;
- the center ring represents the user's current pivot point;
- the single output represents the currently focused Session;
- equal spacing and one repeated stroke system communicate control and order.

The symbol must not include robot heads, sparkle motifs, chat bubbles, literal
provider logos, text, Naruto imagery, or ornamental motion arcs.

### Marketplace artwork

The Marketplace master artwork uses:

- a 256 by 256 pixel canvas;
- a 54 pixel corner radius on a flat `#111924` background;
- a flat `#69DFD0` rail color;
- a `#D8FFF9` pivot-ring highlight;
- a 15 pixel primary stroke and a 10 pixel pivot-ring stroke;
- rounded line caps and joins;
- no gradients, shadows within the mark, textures, or small decorative detail.

Final production geometry must be aligned and optically corrected at 16, 24,
32, 128, and 256 pixels. The design values above define the approved direction,
not a requirement to preserve every draft coordinate unchanged.

The repository keeps a normalized SVG source for the Marketplace mark and
generates the required PNG deterministically. The generated PNG is the
`package.json` extension icon.

### Activity Bar artwork

The Activity Bar SVG uses the same Pure Axis skeleton, expressed only through
`currentColor`. It has:

- no background square;
- no embedded fixed theme color;
- no gradients, filters, masks, external references, or scripts;
- a simplified pivot ring that remains open and legible at 24 pixels;
- correct rendering in dark, light, high-contrast, and forced-color contexts.

The main View and Activity Bar container use the same Activity Bar source.

### Companion artwork

The Attention UI Bridge uses a clearly related Pure Axis mark with one small
connection node at the output. It must remain distinguishable from the main
Marketplace icon at listing-card size without changing the brand's line
weight, palette, or geometry vocabulary.

The companion artwork must not be an exact duplicate of the main Marketplace
icon.

## Marketplace Presentation

The main extension manifest adds or corrects:

- the Agent Pivot display name and description;
- repository, homepage, and issue-tracker links using the final repository;
- search terms for `agent`, `codex`, `claude`, `kimi`, `session manager`,
  `workspace`, and `tmux`;
- an accurate category selection supported by Marketplace;
- explicit license metadata;
- the Pure Axis Marketplace icon.

The README begins with Agent Pivot's purpose and a current product image. It
must not lead with the fork history. A concise upstream attribution remains in
the acknowledgements or origin section.

README media must use a publication-safe asset strategy. Current relative
media that is excluded by `.vscodeignore` cannot be relied on for the
Marketplace page. New screenshots must either be included deliberately in the
VSIX or use stable absolute URLs that remain correct after the repository
rename. The release package must not contain a broken README image reference.

The Marketplace-facing documentation includes:

- supported environments and providers;
- a concise explanation of local transcript access;
- a clear statement that the extension does not provide or resell AI service;
- privacy and local-storage behavior;
- an explicit warning for the opt-in approval/sandbox bypass setting;
- the main and companion relationship;
- links to the license, third-party notices, source, issues, and release notes.

The companion README explains that it is a local UI-host dependency, has no
user-facing commands, and does not record conversation content, prompts,
responses, hostnames, remote authorities, or absolute project paths.

## Attribution and Third-Party Content

The fork attribution to `Kruemelkatze/vscode-dashboard` remains visible in the
README. The upstream MIT copyright notice remains in the license. Agent Pivot
adds `Copyright (c) 2026 hzcheng` for subsequent modifications without removing
or rewriting upstream ownership.

The existing Sharingan files remain optional in-product running effects. They
must not appear in:

- either extension icon;
- the Activity Bar icon;
- the README hero;
- Marketplace screenshots focused on the product identity;
- repository social-preview artwork;
- release badges or publisher artwork.

Each retained third-party file continues to carry per-file author, source, and
license information. The distribution includes the applicable Creative
Commons license information and clearly separates those assets from MIT
licensed source code. Renaming character-specific setting labels or filenames
does not by itself resolve any underlying intellectual-property question and
is outside this rebrand's risk claim.

Bundled third-party JavaScript and existing icon sources must also have
complete notices where their licenses require them. The release review treats
the third-party notice file as a production artifact.

## Implementation Architecture

### Public manifest as the identity authority

The main `package.json` is the authority for public extension identity:
package name, display name, publisher, description, commands, configuration,
Views, icon, and companion dependency.

Runtime modules use centralized constants for the identifiers that must match
the manifest. They do not derive security-sensitive or persistence identifiers
from user-visible labels at runtime.

The companion retains its independent manifest because it is a separately
published extension. Release validation cross-checks both manifests rather
than treating either as an informal copy.

### Brand asset pipeline

One checked-in vector master owns the colored Pure Axis geometry. A
deterministic repository script generates the Marketplace PNG at its required
dimensions. The Activity Bar and companion variants are separate reviewed SVG
sources because their small-size and one-color constraints differ from the
Marketplace rendering.

Generation fails without replacing the last known-good output if:

- the source SVG is malformed;
- the rasterizer is unavailable;
- the output is not the expected size and color mode;
- the output contains unexpected external resources;
- the write cannot complete atomically.

Generated artwork is compared during CI so a stale PNG cannot be committed
independently from its source.

### Identity validation

A dedicated brand-identity check inspects:

1. the main and companion manifests;
2. centralized runtime identifiers;
3. extension dependency wiring;
4. release workflow and packaging filenames;
5. current README and Marketplace-facing documents;
6. the final main and companion VSIX file lists and selected text artifacts.

It rejects current production uses of:

- `Project Steward`;
- `project-steward`;
- `projectSteward`;
- `hzcheng.project-steward`;
- inherited upstream icon hashes or paths where a new asset is required.

The scanner uses an explicit, path-scoped allowlist for historical Changelog
entries, fork attribution, upstream copyright, and archived design evidence.
It must not use a broad global exclusion that could hide a stale identifier in
shipping code or current documentation.

### Atomic identity transition

The identity change is implemented and reviewed as one feature branch. An
intermediate commit may temporarily fail tests, but no release artifact may be
produced from a state where the manifest, runtime identifiers, dependency,
packaging scripts, or Bridge disagree.

No compatibility aliases or dual command registrations are introduced.

## State and Runtime Behavior

Agent Pivot is a new VS Code extension identity. VS Code may retain a locally
installed Project Steward development extension beside it. Local packaging or
installation verification reports that condition but does not uninstall,
disable, or delete the old extension automatically.

Agent Pivot starts with new extension state and new configuration keys. It does
not import Project Steward settings or stored project data.

Old Project Steward-managed tmux sessions and old Bridge files are not adopted.
Provider-owned Codex, Kimi, and Claude session histories remain discoverable
according to their existing provider contracts because they are not Project
Steward-owned data.

This behavior must be stated in local test instructions so a developer does
not mistake an old installed extension or old managed runtime for a failed
rename.

## Failure Handling

- A stale old identity in a current production path fails the brand check.
- A main/Bridge identifier mismatch fails compilation or release validation.
- A missing, malformed, stale, or incorrectly sized icon fails packaging.
- A README image that cannot be resolved through the approved media strategy
  fails release-documentation validation.
- An unexpected old extension found during local installation is reported; it
  is never removed without explicit user authorization.
- An unverified external repository rename or Marketplace state is reported as
  an incomplete external prerequisite, not inferred from local files.
- A missing final name or trademark review blocks Marketplace publication but
  does not block local implementation and testing.

## Verification

Implementation verification must include:

### Automated checks

- deterministic unit, contract, and integration tests;
- browser tests for current user-facing product strings and stable View
  behavior;
- safety and architecture guards;
- brand-identity validation with controlled stale-name mutations;
- deterministic icon generation and generated-file comparison;
- release-note and release-packaging checks;
- main and companion compilation and production bundling;
- Extension Host activation with the renamed dependency installed;
- unpacked main and companion VSIX inspection.

The controlled brand-check tests must prove that:

- each forbidden legacy form is rejected in a shipping path;
- each narrow historical or attribution allowlist remains accepted;
- an old icon substituted back into either manifest is rejected;
- a main/Bridge dependency mismatch is rejected;
- a stale generated PNG is rejected.

### Behavioral smoke checks

The renamed build must still:

- open the Agent Pivot Activity Bar surface;
- save and reopen supported workspaces;
- create, resume, and focus one Codex Session;
- create, resume, and focus one Kimi Session;
- create, resume, and focus one Claude Session;
- load the current Session outline and viewer;
- exchange bounded attention state through the renamed companion;
- package Direct Terminal and tmux behavior without changing provider command
  arguments.

### Visual checks

Manual evidence covers:

- Marketplace mark at 16, 24, 32, 128, and 256 pixels;
- Activity Bar mark in VS Code dark, light, and high-contrast themes;
- main and companion differentiation at listing-card size;
- README and Marketplace screenshots with no stale identity;
- no clipping, blur, vanishing stroke, or false visual emphasis at small size.

## Release Sequence

After implementation and verification:

1. review the complete rename diff and the two unpacked VSIX files;
2. merge through a pull request into `main`;
3. rename the GitHub repository to `agent-pivot` as an explicit external
   action;
4. update and re-verify every repository, homepage, issue, media, workflow, and
   release link against the renamed repository;
5. perform the final name, Marketplace, registry, domain, and trademark review;
6. publish the companion first if Marketplace dependency resolution requires
   it;
7. publish Agent Pivot `1.0.0`;
8. verify the live Marketplace pages, installation, dependency resolution,
   icons, README media, and activation from a clean VS Code profile.

This design does not authorize publishing or repository renaming. Those
external mutations require the user's explicit release request at execution
time.

## Acceptance Criteria

1. The current product UI, manifests, release metadata, artifacts, and
   Marketplace-facing documents identify the product as Agent Pivot.
2. The main extension ID is `hzcheng.agent-pivot`, and the companion ID is
   `hzcheng.agent-pivot-attention-ui-bridge`.
3. Commands, configuration, Views, owned state, Bridge paths, and managed
   runtime identifiers use the approved Agent Pivot namespace with no
   compatibility aliases.
4. The Pure Axis mark replaces both inherited upstream icon roles and remains
   legible in all approved sizes and VS Code themes.
5. Main and companion icons are recognizably related but are not exact
   duplicates.
6. No current shipping surface or current Marketplace documentation contains
   a forbidden stale Project Steward identity.
7. Fork attribution, upstream copyright, and required third-party notices
   remain intact.
8. Sharingan files, if retained, are absent from primary brand and Marketplace
   promotional artwork.
9. The main and companion VSIX files compile, package, activate together, and
   contain only the intended production files.
10. Existing Codex, Kimi, Claude, workspace, conversation, attention, Direct
    Terminal, and tmux behavior passes the required regression and smoke
    checks.
11. Agent Pivot begins at version `1.0.0` without Project Steward migration.
12. Repository renaming and Marketplace publication remain explicit,
    separately authorized release actions.
